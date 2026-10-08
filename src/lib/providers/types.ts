import { Beat, BeatAudio, TurnRequest } from "../protocol";
import type { CallCtx } from "../aiRegistry";

export type ReplyChunk = { heard: string } | Record<string, unknown>;

export interface Provider {
  name: string;
  reply(req: TurnRequest, signal: AbortSignal): AsyncIterable<ReplyChunk>;
  tts(beat: Beat, signal: AbortSignal, ctx?: CallCtx): Promise<BeatAudio | null>;
  // 対応プロバイダのみ。PCM s16le を逐次返し、初回発話までの待ちを縮める
  ttsStream?(beat: Beat, signal: AbortSignal, ctx?: CallCtx): AsyncIterable<{ pcm: Buffer; rate: number }>;
  image(subject: string, signal: AbortSignal, ctx?: CallCtx): Promise<{ mime: string; b64: string }>;
}

// ストリームの断片から改行区切りJSONを逐次取り出す
export class NdjsonSplitter {
  private buf = "";

  push(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const out: Record<string, unknown>[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const obj = parseLine(line);
      if (obj) out.push(obj);
    }
    return out;
  }

  flush(): Record<string, unknown>[] {
    const obj = parseLine(this.buf);
    this.buf = "";
    return obj ? [obj] : [];
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t || t.startsWith("```")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    // JSONでない行は台詞として救済する
    return /^[{\[]/.test(t) ? null : { say: t };
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
