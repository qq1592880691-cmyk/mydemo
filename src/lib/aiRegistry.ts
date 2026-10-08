import { getDb } from "./db";

export type Purpose = "text" | "tts" | "image" | "sprite" | "music";

export interface ModelRow {
  id: number;
  provider: string;
  purpose: Purpose;
  model_id: string;
  display_name: string;
  voice: string | null;
  api_key: string | null;
  price_input_text: number;
  price_input_audio: number;
  price_input_image: number;
  price_output: number;
  currency: string;
  is_default: number;
  enabled: number;
}

export interface Usage {
  inputText: number;
  inputAudio: number;
  inputImage: number;
  output: number;
  thought: number;
}

export interface CallCtx {
  sessionId?: string;
  turnId?: number;
}

export const EMPTY_USAGE: Usage = { inputText: 0, inputAudio: 0, inputImage: 0, output: 0, thought: 0 };

// 既定モデルを先頭に、有効なモデルを返す（先頭が失敗した時の予備にも使う）
export function listModels(provider: string, purpose: Purpose): ModelRow[] {
  return getDb()
    .prepare("SELECT * FROM ai_model WHERE provider = ? AND purpose = ? AND enabled = 1 ORDER BY is_default DESC, id")
    .all(provider, purpose) as ModelRow[];
}

export function getModel(provider: string, purpose: Purpose): ModelRow | null {
  return listModels(provider, purpose)[0] ?? null;
}

// プロバイダを問わず、用途の有効モデルを既定優先で返す
export function listByPurpose(purpose: Purpose): ModelRow[] {
  return getDb()
    .prepare("SELECT * FROM ai_model WHERE purpose = ? AND enabled = 1 AND provider <> 'mock' ORDER BY is_default DESC, id")
    .all(purpose) as ModelRow[];
}

const ENV_KEY: Record<string, string> = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" };

export function resolveKey(row: ModelRow | null): string | null {
  if (!row) return null;
  return row.api_key || process.env[ENV_KEY[row.provider] ?? ""] || null;
}

// 価格は 100 万トークン単価。思考トークンは出力扱いで課金される
export function calcCost(row: ModelRow | null, u: Usage): number {
  if (!row) return 0;
  const cost =
    (u.inputText * row.price_input_text +
      u.inputAudio * row.price_input_audio +
      u.inputImage * (row.price_input_image ?? 0) +
      (u.output + u.thought) * row.price_output) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

interface GeminiUsageMeta {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
}

export function usageFromGemini(meta: GeminiUsageMeta | undefined): Usage {
  if (!meta) return { ...EMPTY_USAGE };
  const by = (m: string) => (meta.promptTokensDetails ?? []).filter((d) => d.modality === m).reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  const audio = by("AUDIO");
  const image = by("IMAGE");
  return {
    inputText: Math.max(0, (meta.promptTokenCount ?? 0) - audio - image),
    inputAudio: audio,
    inputImage: image,
    output: meta.candidatesTokenCount ?? 0,
    thought: meta.thoughtsTokenCount ?? 0,
  };
}

interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
}

// Interactions API（gemini-3.x TTS）の usage
export function usageFromInteraction(u: InteractionUsage | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE };
  return { inputText: u.total_input_tokens ?? 0, inputAudio: 0, inputImage: 0, output: u.total_output_tokens ?? 0, thought: u.total_thought_tokens ?? 0 };
}

interface OpenAIImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

export function usageFromOpenAI(u: OpenAIImageUsage | undefined): Usage {
  if (!u) return { ...EMPTY_USAGE };
  const image = u.input_tokens_details?.image_tokens ?? 0;
  return {
    inputText: u.input_tokens_details?.text_tokens ?? Math.max(0, (u.input_tokens ?? 0) - image),
    inputAudio: 0,
    inputImage: image,
    output: u.output_tokens ?? 0,
    thought: 0,
  };
}

export function logCall(p: {
  row: ModelRow | null;
  provider: string;
  purpose: Purpose;
  modelId: string;
  ctx?: CallCtx;
  status: "ok" | "error" | "aborted" | "timeout";
  latencyMs: number;
  usage: Usage;
  error?: string;
  detail?: string;
}) {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_call_log (ai_model_id, provider, purpose, model_id, session_id, turn_id, status, latency_ms,
          input_text_tokens, input_audio_tokens, input_image_tokens, output_tokens, thought_tokens, cost, currency, error, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.row?.id ?? null,
        p.provider,
        p.purpose,
        p.modelId,
        p.ctx?.sessionId ?? null,
        p.ctx?.turnId ?? null,
        p.status,
        Math.round(p.latencyMs),
        p.usage.inputText,
        p.usage.inputAudio,
        p.usage.inputImage,
        p.usage.output,
        p.usage.thought,
        calcCost(p.row, p.usage),
        p.row?.currency ?? "USD",
        p.error?.slice(0, 500) ?? null,
        p.detail?.slice(0, 500) ?? null,
      );
  } catch (e) {
    // ログ失敗で本処理を止めない
    console.error("[ai_call_log]", e);
  }
}

export function statusOf(e: unknown, signal?: AbortSignal): "error" | "aborted" | "timeout" {
  if (signal?.aborted) return "aborted";
  return /timeout/i.test(String((e as Error)?.message ?? e)) ? "timeout" : "error";
}
