import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { Beat, BeatAudio, TurnRequest } from "../protocol";
import { SYSTEM_PROMPT, buildUserPrompt, photoPrompt } from "../story";
import { pcm16ToWav } from "../wav";
import { CallCtx, ModelRow, Purpose, getModel, listByPurpose, logCall, resolveKey, statusOf, usageFromGemini } from "../aiRegistry";
import { openaiTtsStream } from "./openai";
import { NdjsonSplitter, Provider, ReplyChunk } from "./types";

const VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";

// gemini-3.8-flash-tts は語気指示（英文前置き・systemInstruction・演出メモ）を本文ごと読み上げるか拒否するため、台詞のみ渡す

const clients = new Map<string, GoogleGenAI>();
// MINIMAL 非対応のモデル（例: gemini-3.7-flash）は一度失敗したら LOW で呼ぶ
const noMinimal = new Set<string>();

function thinkingFor(modelId: string) {
  if (modelId.startsWith("gemini-2.5")) return { thinkingBudget: 0 };
  return { thinkingLevel: noMinimal.has(modelId) ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL };
}

// マスタの行ごとにキーが違い得るので、キー単位でクライアントを使い回す
export function clientFor(row: ModelRow | null): { ai: GoogleGenAI; row: ModelRow } {
  const key = resolveKey(row);
  if (!row || !key) throw new Error("model_not_configured");
  let ai = clients.get(key);
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: key });
    clients.set(key, ai);
  }
  return { ai, row };
}

type GenParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

// 単発呼び出しを計測付きで実行し、成否に関わらず ai_call_log へ残す
export async function trackedGenerate(purpose: Purpose, row: ModelRow | null, params: Omit<GenParams, "model">, ctx?: CallCtx, detail?: string) {
  const { ai } = clientFor(row);
  const t0 = Date.now();
  const signal = params.config?.abortSignal;
  try {
    const res = await ai.models.generateContent({ ...params, model: row!.model_id });
    logCall({ row, provider: row!.provider, purpose, modelId: row!.model_id, ctx, status: "ok", latencyMs: Date.now() - t0, usage: usageFromGemini(res.usageMetadata), detail });
    return res;
  } catch (e) {
    logCall({ row, provider: row!.provider, purpose, modelId: row!.model_id, ctx, status: statusOf(e, signal), latencyMs: Date.now() - t0, usage: usageFromGemini(undefined), error: String((e as Error)?.message ?? e), detail });
    throw e;
  }
}

export class GeminiProvider implements Provider {
  name = "gemini";

  async *reply(req: TurnRequest, signal: AbortSignal): AsyncIterable<ReplyChunk> {
    const { ai, row } = clientFor(getModel("gemini", "text"));
    const ctx: CallCtx = { sessionId: req.sessionId, turnId: req.turnId };
    const parts: Part[] = [{ text: buildUserPrompt(req.input, req.history, req.scene, req.plot) }];
    if (req.input.kind === "audio") {
      parts.push({ inlineData: { mimeType: req.input.mime, data: req.input.b64 } });
    }
    const t0 = Date.now();
    let usageMeta: Parameters<typeof usageFromGemini>[0];
    let status: "ok" | "error" | "aborted" | "timeout" = "ok";
    let error: string | undefined;
    try {
      const open = () =>
        ai.models.generateContentStream({
          model: row.model_id,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.9,
            maxOutputTokens: 1024,
            abortSignal: signal,
            // 会話は初回発話の速さが最優先なので思考は最小に抑える
            thinkingConfig: thinkingFor(row.model_id),
          },
        });
      const stream = await open().catch((e) => {
        if (!/thinking level/i.test(String(e?.message)) || noMinimal.has(row.model_id)) throw e;
        noMinimal.add(row.model_id);
        return open();
      });
      const splitter = new NdjsonSplitter();
      for await (const chunk of stream) {
        if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
        if (signal.aborted) {
          status = "aborted";
          return;
        }
        for (const obj of splitter.push(chunk.text ?? "")) yield obj;
      }
      for (const obj of splitter.flush()) yield obj;
    } catch (e) {
      status = statusOf(e, signal);
      error = String((e as Error)?.message ?? e);
      throw e;
    } finally {
      // 途中打断(return)でも finally は走るので、ここで一度だけ記録する
      if (signal.aborted && status === "ok") status = "aborted";
      logCall({ row, provider: "gemini", purpose: "text", modelId: row.model_id, ctx, status, latencyMs: Date.now() - t0, usage: usageFromGemini(usageMeta), error, detail: req.input.kind });
    }
  }

  async tts(beat: Beat, signal: AbortSignal, ctx?: CallCtx): Promise<BeatAudio | null> {
    const res = await trackedGenerate(
      "tts",
      getModel("gemini", "tts"),
      {
        contents: [{ role: "user", parts: [{ text: beat.say }] }],
        config: {
          abortSignal: signal,
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      },
      ctx,
      beat.say,
    );
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!data?.data) return null;
    const rate = Number(/rate=(\d+)/.exec(data.mimeType ?? "")?.[1] ?? 24000);
    return { mime: "audio/wav", b64: pcm16ToWav(Buffer.from(data.data, "base64"), rate).toString("base64") };
  }

  // TTS は会話モデルと独立に、マスタの tts 既定行（provider 問わず）で合成する
  async *ttsStream(beat: Beat, signal: AbortSignal, ctx?: CallCtx): AsyncIterable<{ pcm: Buffer; rate: number }> {
    const ttsRow = listByPurpose("tts").find((r) => resolveKey(r)) ?? null;
    if (ttsRow?.provider === "openai") {
      yield* openaiTtsStream(ttsRow, beat, signal, ctx);
      return;
    }
    const { ai, row } = clientFor(ttsRow);
    const t0 = Date.now();
    let usageMeta: Parameters<typeof usageFromGemini>[0];
    let status: "ok" | "error" | "aborted" | "timeout" = "ok";
    let error: string | undefined;
    try {
      const stream = await ai.models.generateContentStream({
        model: row.model_id,
        contents: [{ role: "user", parts: [{ text: beat.say }] }],
        config: {
          abortSignal: signal,
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: row.voice || VOICE } } },
        },
      });
      for await (const chunk of stream) {
        if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
        const data = chunk.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
        if (!data?.data) continue;
        yield { pcm: Buffer.from(data.data, "base64"), rate: Number(/rate=(\d+)/.exec(data.mimeType ?? "")?.[1] ?? 24000) };
      }
    } catch (e) {
      status = statusOf(e, signal);
      error = String((e as Error)?.message ?? e);
      throw e;
    } finally {
      if (signal.aborted && status === "ok") status = "aborted";
      logCall({ row, provider: "gemini", purpose: "tts", modelId: row.model_id, ctx, status, latencyMs: Date.now() - t0, usage: usageFromGemini(usageMeta), error, detail: beat.say });
    }
  }

  async image(subject: string, signal: AbortSignal, ctx?: CallCtx) {
    const res = await trackedGenerate(
      "image",
      getModel("gemini", "image"),
      {
        contents: [{ role: "user", parts: [{ text: photoPrompt(subject) }] }],
        config: { abortSignal: signal, responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3" } },
      },
      ctx,
      subject,
    );
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!data?.data) throw new Error("image_empty");
    return { mime: data.mimeType || "image/png", b64: data.data };
  }
}
