import type { Beat, Emotion } from "../protocol";
import { CallCtx, ModelRow, Purpose, logCall, resolveKey, statusOf, usageFromOpenAI } from "../aiRegistry";

const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
// モデルによって未対応のことがある任意パラメータ。400 で名指しされたら外して再送する
const OPTIONAL = new Set(["quality", "input_fidelity", "output_format", "size"]);

interface ImageReq {
  prompt: string;
  image?: Buffer;
  size?: string;
}

export async function openaiImage(purpose: Purpose, row: ModelRow, req: ImageReq, ctx?: CallCtx, detail?: string, signal?: AbortSignal): Promise<Buffer> {
  const key = resolveKey(row);
  if (!key) throw new Error("model_not_configured");
  const params: Record<string, string> = {
    model: row.model_id,
    prompt: req.prompt,
    size: req.size ?? "1024x1536",
    quality: "high",
    output_format: "png",
    ...(req.image ? { input_fidelity: "high" } : {}),
  };

  const t0 = Date.now();
  for (let i = 0; i < OPTIONAL.size + 1; i++) {
    const res = await send(key, params, req.image, signal).catch((e) => {
      logCall({ row, provider: "openai", purpose, modelId: row.model_id, ctx, status: statusOf(e, signal), latencyMs: Date.now() - t0, usage: usageFromOpenAI(undefined), error: String(e?.message ?? e), detail });
      throw e;
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const b64 = json.data?.[0]?.b64_json;
      logCall({ row, provider: "openai", purpose, modelId: row.model_id, ctx, status: b64 ? "ok" : "error", latencyMs: Date.now() - t0, usage: usageFromOpenAI(json.usage), error: b64 ? undefined : "no image in response", detail });
      if (!b64) throw new Error("no image in response");
      return Buffer.from(b64, "base64");
    }
    const param: string | undefined = json.error?.param;
    if (res.status === 400 && param && OPTIONAL.has(param) && param in params) {
      delete params[param];
      continue;
    }
    const msg = `openai ${res.status}: ${json.error?.message ?? res.statusText}`;
    logCall({ row, provider: "openai", purpose, modelId: row.model_id, ctx, status: "error", latencyMs: Date.now() - t0, usage: usageFromOpenAI(undefined), error: msg, detail });
    throw new Error(msg);
  }
  throw new Error("openai: too many parameter retries");
}

function send(key: string, params: Record<string, string>, image: Buffer | undefined, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(300_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (!image) {
    return fetch(`${BASE}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: sig,
    });
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("image[]", new Blob([new Uint8Array(image)], { type: "image/png" }), "source.png");
  return fetch(`${BASE}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: sig });
}

// gpt-4o-mini-tts は英語の項目別指示（Voice/Tone/Pacing…）に最もよく従う。台詞は中文のまま
const EMOTION_DELIVERY: Record<Emotion, string> = {
  neutral: "Calm and gentle, a little tired from the late night. Relaxed and unhurried, like thinking out loud.",
  happy: "Warm, you can hear the smile in her voice. Brighter and a touch quicker, with a light lift at the ends of phrases.",
  shy: "Soft and a little embarrassed. Quieter and slower, a slight hesitation before the key words, trailing off at the end.",
  sad: "Quiet and wistful, with a soft sigh. Slower and lower in energy, letting the ends of phrases fade away.",
  surprised: "Genuinely caught off guard. A small quick breath, pitch rises naturally, then settles back down.",
};

export function openaiTtsInstructions(emotion: Emotion): string {
  return [
    "Voice: Mira, a 26-year-old woman and native Mandarin speaker from mainland China. Soft, warm and intimate, talking to one person across a small table in a quiet café late at night.",
    "Language: Standard Mandarin with natural native tones and rhythm. This is casual spoken conversation, not a newsreader, audiobook or voice assistant.",
    `Emotion: ${EMOTION_DELIVERY[emotion]}`,
    "Delivery: Vary pitch and pace inside the sentence and stress the words that matter. Modal particles (嗯、啊、呢、吧、诶) are light and natural, never over-pronounced.",
    "Pauses: Treat \"……\" as a real breath or hesitation and \"，\" as a brief natural pause, never a mechanical gap.",
  ].join("\n");
}

// 語気は instructions で渡すので本文に混ざらず、句ごとの感情をそのまま声に反映できる
export async function* openaiTtsStream(row: ModelRow, beat: Beat, signal: AbortSignal, ctx?: CallCtx): AsyncIterable<{ pcm: Buffer; rate: number }> {
  const key = resolveKey(row);
  if (!key) throw new Error("model_not_configured");
  const instructions = openaiTtsInstructions(beat.emotion);
  const t0 = Date.now();
  let bytes = 0;
  let status: "ok" | "error" | "aborted" | "timeout" = "ok";
  let error: string | undefined;
  try {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: row.model_id, voice: row.voice || "shimmer", input: beat.say, instructions, response_format: "pcm" }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      yield { pcm: Buffer.from(value), rate: 24000 };
    }
  } catch (e) {
    status = statusOf(e, signal);
    error = String((e as Error)?.message ?? e);
    throw e;
  } finally {
    if (signal.aborted && status === "ok") status = "aborted";
    // 音声 API は usage を返さないため、文字数と再生秒数から概算する（約 20.8 音声トークン/秒）
    const seconds = bytes / 48000;
    logCall({
      row,
      provider: "openai",
      purpose: "tts",
      modelId: row.model_id,
      ctx,
      status,
      latencyMs: Date.now() - t0,
      usage: { inputText: beat.say.length + instructions.length, inputAudio: 0, inputImage: 0, output: Math.round(seconds * 20.8), thought: 0 },
      error,
      detail: `${beat.emotion} ${beat.say}（usage 估算）`,
    });
  }
}
