import { getProvider } from "@/lib/providers";
import { withTimeout } from "@/lib/providers/types";
import { Beat, BeatAudio, INITIAL_STORY, StreamEvent, StutterLimiter, TurnRequest, normalizeBeat, normalizeChoices } from "@/lib/protocol";
import { applyPlotHooks } from "@/lib/story";
import { StoryTurn, userTurnOf } from "@/lib/storyState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHUNK_TIMEOUT = 15_000;
const TTS_TIMEOUT = 12_000;
const TTS_CONCURRENCY = 4;

// 1 ビート分の音声。流式なら PCM 断片が溜まっていき、非流式なら whole に丸ごと入る
class Voice {
  chunks: Buffer[] = [];
  rate = 24000;
  done = false;
  whole: BeatAudio | null = null;
  error?: string;
  private waiters: (() => void)[] = [];

  notify() {
    this.waiters.splice(0).forEach((w) => w());
  }
  wait() {
    return new Promise<void>((r) => this.waiters.push(r));
  }
  finish(error?: string) {
    this.error = error;
    this.done = true;
    this.notify();
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as TurnRequest;
  const provider = getProvider(body.forceMock);
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const enc = new TextEncoder();
  const turnId = body.turnId;
  const ctx = { sessionId: body.sessionId, turnId };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: StreamEvent) => {
        if (!ac.signal.aborted) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };
      const t0 = Date.now();
      send({ type: "meta", turnId, provider: provider.name });

      let running = 0;
      const waiters: (() => void)[] = [];
      const acquire = () => (running < TTS_CONCURRENCY ? (running++, Promise.resolve()) : new Promise<void>((r) => waiters.push(r)));
      const release = () => {
        const next = waiters.shift();
        if (next) next();
        else running--;
      };

      // TTS は到着順に並行起動し、送出は seq 順に直列化する
      const synth = async (beat: Beat, voice: Voice) => {
        if (body.fail === "tts") return voice.finish("tts_failed");
        await acquire();
        try {
          if (provider.ttsStream) {
            const it = provider.ttsStream(beat, ac.signal, ctx)[Symbol.asyncIterator]();
            let carry: Buffer | null = null;
            while (true) {
              const r = await withTimeout(it.next(), TTS_TIMEOUT, ac.signal, "tts_timeout");
              if (r.done) break;
              voice.rate = r.value.rate;
              // 16bit 境界を跨いだ端数バイトは次の断片へ繰り越す
              let pcm: Buffer = carry ? Buffer.concat([carry, r.value.pcm]) : r.value.pcm;
              carry = pcm.length % 2 ? pcm.subarray(pcm.length - 1) : null;
              if (carry) pcm = pcm.subarray(0, pcm.length - 1);
              if (pcm.length) {
                voice.chunks.push(pcm);
                voice.notify();
              }
            }
          } else {
            voice.whole = await withTimeout(provider.tts(beat, ac.signal, ctx), TTS_TIMEOUT, ac.signal, "tts_timeout");
          }
          voice.finish();
        } catch (e) {
          voice.finish((e as Error).message || "tts_failed");
        } finally {
          release();
        }
      };

      const emit = async (beat: Beat, voice: Voice, isFirst: boolean) => {
        while (!voice.chunks.length && !voice.done) await voice.wait();
        if (!voice.chunks.length) {
          send({ type: "beat", turnId, beat, audio: voice.whole, audioError: voice.error });
          if (isFirst) send({ type: "metric", turnId, name: "first_beat", ms: Date.now() - t0 });
          return;
        }
        send({ type: "beat", turnId, beat, audio: null, stream: { rate: voice.rate } });
        if (isFirst) send({ type: "metric", turnId, name: "first_audio", ms: Date.now() - t0 });
        let i = 0;
        while (true) {
          while (i < voice.chunks.length) send({ type: "audio", turnId, seq: beat.seq, b64: voice.chunks[i++].toString("base64") });
          if (voice.done) break;
          await voice.wait();
        }
        send({ type: "audio_end", turnId, seq: beat.seq, error: voice.error });
      };

      let plot = body.plot;
      const story = new StoryTurn(body.story ?? INITIAL_STORY, userTurnOf(body.history, body.input.kind));
      let seq = 0;
      let chain = Promise.resolve();
      let emitted = 0;
      const play = (beat: Beat, voice: Voice) => {
        chain = chain.then(() => emit(beat, voice, emitted++ === 0));
      };
      const stutter = new StutterLimiter();
      try {
        const it = provider.reply(body, ac.signal)[Symbol.asyncIterator]();
        while (true) {
          const r = await withTimeout(it.next(), CHUNK_TIMEOUT, ac.signal, "llm_timeout");
          if (r.done) break;
          const obj = r.value;
          if ("heard" in obj && typeof obj.heard === "string") {
            send({ type: "heard", turnId, text: obj.heard });
            send({ type: "metric", turnId, name: "heard", ms: Date.now() - t0 });
            continue;
          }
          if ("choices" in obj) {
            const items = normalizeChoices(obj.choices);
            // 台詞を全部流した後に届くよう、再生チェーンの最後に積む
            if (items.length) chain = chain.then(() => send({ type: "choices", turnId, items }));
            continue;
          }
          // 字幕と合成用テキストが食い違わないよう、正規化前の台詞に掛ける
          const raw = obj as Record<string, unknown>;
          if (typeof raw.say === "string") raw.say = stutter.apply(raw.say);
          const norm = normalizeBeat(raw, seq);
          if (!norm) continue;
          const beat = story.apply(applyPlotHooks(story.gate(norm, plot), plot), plot);
          if (beat.plot) plot = beat.plot;
          if (seq === 0) send({ type: "metric", turnId, name: "first_line", ms: Date.now() - t0 });
          const voice = new Voice();
          void synth(beat, voice);
          seq++;
          play(beat, voice);
        }
        await chain;
        send({ type: "metric", turnId, name: "total", ms: Date.now() - t0 });
        send({ type: "done", turnId });
      } catch (e) {
        const msg = (e as Error).message;
        if (!ac.signal.aborted) {
          await chain.catch(() => {});
          const code = msg === "llm_timeout" || msg === "stream_dropped" ? msg : "provider_error";
          send({ type: "error", turnId, code, message: msg });
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
