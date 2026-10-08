import { describe, expect, it } from "vitest";
import { PcmStream, TurnController, type AudioOut } from "@/client/turnController";
import type { Beat, StreamEvent, TurnRequest } from "@/lib/protocol";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const beat = (seq: number, say: string, extra: Partial<Beat> = {}): Beat => ({
  seq,
  say,
  emotion: "neutral",
  action: "none",
  ...extra,
});

// テスト側から任意のタイミングでイベントを流せる偽トランスポート
function controllableTransport() {
  const turns: { req: TurnRequest; push: (ev: StreamEvent) => void; end: () => void; signal: AbortSignal }[] = [];
  const transport = (req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamEvent> => {
    const buf: StreamEvent[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    turns.push({
      req,
      signal,
      push: (ev) => {
        buf.push(ev);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    });
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (buf.length) {
            // 実ネットワークと違い、取消後も遅延レスポンスを流し続ける（古い応答の混入を再現）
            yield buf.shift()!;
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
  };
  return { transport, turns };
}

function fakeAudio(durationMs = 30) {
  const played: string[] = [];
  let stops = 0;
  const audio: AudioOut = {
    play: (_a, b, signal) =>
      new Promise<void>((resolve) => {
        played.push(b.say);
        const t = setTimeout(resolve, durationMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    stop: () => {
      stops++;
    },
  };
  return { audio, played, stops: () => stops };
}

function setup(opts: { durationMs?: number; timeout?: number; image?: (s: string, sig: AbortSignal) => Promise<string> } = {}) {
  const t = controllableTransport();
  const a = fakeAudio(opts.durationMs);
  const c = new TurnController({
    transport: t.transport,
    audio: a.audio,
    image: opts.image ?? (async () => "data:x"),
    firstEventTimeoutMs: opts.timeout ?? 1000,
  });
  return { c, ...t, ...a };
}

const beatEv = (turnId: number, b: Beat): StreamEvent => ({ type: "beat", turnId, beat: b, audio: null });

describe("TurnController", () => {
  it("正常系：節拍を順に再生し、終了後に待機へ戻り履歴へ記録する", async () => {
    const { c, turns, played } = setup();
    c.sendText("你好");
    await tick();
    expect(c.getSnapshot().charState).toBe("thinking");
    const t = turns[0];
    t.push(beatEv(1, beat(0, "第一句", { emotion: "happy" })));
    t.push(beatEv(1, beat(1, "第二句", { scene: { weather: "clear" } })));
    t.push({ type: "done", turnId: 1 });
    t.end();
    await tick(10);
    expect(c.getSnapshot().charState).toBe("speaking");
    expect(c.getSnapshot().emotion).toBe("happy");
    await tick(100);
    expect(played).toEqual(["第一句", "第二句"]);
    const s = c.getSnapshot();
    expect(s.charState).toBe("idle");
    expect(s.scene.weather).toBe("clear");
    expect(s.history).toEqual([
      { who: "user", text: "你好" },
      { who: "mira", text: "第一句第二句" },
    ]);
  });

  it("打断：音声停止・未再生節拍は破棄・遅れて届いた応答も再生しない", async () => {
    const { c, turns, played, stops } = setup({ durationMs: 50 });
    c.sendText("讲个故事");
    await tick();
    const t = turns[0];
    t.push(beatEv(1, beat(0, "很久以前")));
    t.push(beatEv(1, beat(1, "有一个人")));
    await tick(10);
    expect(c.getSnapshot().charState).toBe("speaking");

    c.beginListening();
    expect(c.getSnapshot().charState).toBe("listening");
    expect(stops()).toBe(1);
    expect(turns[0].signal.aborted).toBe(true);

    // 取消後に古いターンのイベントが遅れて届く
    t.push(beatEv(1, beat(2, "迟到的句子", { emotion: "sad", event: { type: "photo", subject: "x" } })));
    t.push({ type: "done", turnId: 1 });
    t.end();
    await tick(100);

    expect(played).toEqual(["很久以前"]);
    const s = c.getSnapshot();
    expect(s.charState).toBe("listening");
    expect(s.emotion).toBe("neutral");
    expect(s.photo).toBeNull();
    expect(s.history.at(-1)).toEqual({ who: "mira", text: "很久以前", interrupted: true });
  });

  it("連続入力：最後のターンの応答だけが再生される", async () => {
    const { c, turns, played } = setup();
    c.sendText("一");
    c.sendText("二");
    c.sendText("三");
    await tick();
    expect(turns).toHaveLength(3);
    expect(turns[0].signal.aborted && turns[1].signal.aborted).toBe(true);
    // 古いターンの応答が後から届いても無視される
    turns[0].push(beatEv(1, beat(0, "回答一")));
    turns[1].push(beatEv(2, beat(0, "回答二")));
    turns[2].push(beatEv(3, beat(0, "回答三")));
    turns[2].push({ type: "done", turnId: 3 });
    turns.forEach((t) => t.end());
    await tick(100);
    expect(played).toEqual(["回答三"]);
    expect(c.getSnapshot().history.filter((h) => h.who === "user").map((h) => h.text)).toEqual(["一", "二", "三"]);
  });

  it("turnId が一致しないイベントは破棄する", async () => {
    const { c, turns, played } = setup();
    c.sendText("hi");
    await tick();
    turns[0].push(beatEv(99, beat(0, "别人的回复")));
    turns[0].push(beatEv(1, beat(0, "我的回复")));
    turns[0].push({ type: "done", turnId: 1 });
    turns[0].end();
    await tick(100);
    expect(played).toEqual(["我的回复"]);
    expect(c.getSnapshot().log.some((l) => l.kind === "stale_dropped")).toBe(true);
  });

  it("初回イベントが来なければタイムアウトエラーで待機へ戻る", async () => {
    const { c, turns } = setup({ timeout: 50 });
    c.sendText("在吗");
    await tick(80);
    const s = c.getSnapshot();
    expect(s.error?.code).toBe("llm_timeout");
    expect(s.charState).toBe("idle");
    expect(turns[0].signal.aborted).toBe(true);
  });

  it("途中切断：受信済みの節拍は再生し、エラーを表示する", async () => {
    const { c, turns, played } = setup();
    c.sendText("你好");
    await tick();
    turns[0].push(beatEv(1, beat(0, "收到的一句")));
    turns[0].end();
    await tick(100);
    expect(played).toEqual(["收到的一句"]);
    const s = c.getSnapshot();
    expect(s.error?.code).toBe("stream_dropped");
    expect(s.charState).toBe("idle");
  });

  it("写真イベント：生成中→完了、生成中に打断されたら破棄", async () => {
    let resolveImg: (u: string) => void = () => {};
    const { c, turns } = setup({ image: () => new Promise((r) => (resolveImg = r)) });
    c.sendText("给我看看照片");
    await tick();
    turns[0].push(beatEv(1, beat(0, "这张", { event: { type: "photo", subject: "street" } })));
    turns[0].push(beatEv(1, beat(1, "还有")));
    await tick(5);
    expect(c.getSnapshot().photo?.status).toBe("developing");
    c.beginListening();
    resolveImg("data:late");
    await tick();
    expect(c.getSnapshot().photo).toBeNull();
  });

  it("写真失敗時は failed 状態になり再試行できる", async () => {
    let n = 0;
    const { c, turns } = setup({ image: async () => (n++ === 0 ? Promise.reject(new Error("boom")) : "data:ok") });
    c.sendText("照片");
    await tick();
    turns[0].push(beatEv(1, beat(0, "看", { event: { type: "photo", subject: "s" } })));
    turns[0].push({ type: "done", turnId: 1 });
    turns[0].end();
    await tick(10);
    expect(c.getSnapshot().photo?.status).toBe("failed");
    c.retryPhoto();
    await tick();
    expect(c.getSnapshot().photo).toMatchObject({ status: "ready", url: "data:ok" });
  });

  it("流式音声：断片が該当ビートの PcmStream に入り、再生側へ渡る", async () => {
    const t = controllableTransport();
    const got: PcmStream[] = [];
    const c = new TurnController({
      transport: t.transport,
      audio: {
        play: async (a) => {
          if (a instanceof PcmStream) {
            got.push(a);
            for await (const _ of a.read(new AbortController().signal)) void _;
          }
        },
        stop: () => {},
      },
      image: async () => "",
    });
    c.sendText("你好");
    await tick();
    const tr = t.turns[0];
    tr.push({ type: "beat", turnId: 1, beat: beat(0, "一"), audio: null, stream: { rate: 24000 } });
    tr.push({ type: "audio", turnId: 1, seq: 0, b64: btoa("\x01\x00\x02\x00") });
    tr.push({ type: "audio", turnId: 1, seq: 0, b64: btoa("\x03\x00") });
    tr.push({ type: "audio_end", turnId: 1, seq: 0 });
    tr.push({ type: "done", turnId: 1 });
    tr.end();
    await tick(20);
    expect(got).toHaveLength(1);
    expect(got[0].rate).toBe(24000);
    expect(got[0].chunks.map((x) => x.length)).toEqual([4, 2]);
    expect(got[0].done).toBe(true);
    expect(c.getSnapshot().charState).toBe("idle");
  });

  it("流式音声：打断後に届いた古い断片は捨てられ、再生待ちも解放される", async () => {
    const t = controllableTransport();
    let stream: PcmStream | null = null;
    let finished = false;
    const c = new TurnController({
      transport: t.transport,
      audio: {
        play: async (a, _b, signal) => {
          if (a instanceof PcmStream) {
            stream = a;
            for await (const _ of a.read(signal)) void _;
            finished = true;
          }
        },
        stop: () => {},
      },
      image: async () => "",
    });
    c.sendText("你好");
    await tick();
    const tr = t.turns[0];
    tr.push({ type: "beat", turnId: 1, beat: beat(0, "一"), audio: null, stream: { rate: 24000 } });
    tr.push({ type: "audio", turnId: 1, seq: 0, b64: btoa("\x01\x00") });
    await tick(5);
    c.beginListening();
    tr.push({ type: "audio", turnId: 1, seq: 0, b64: btoa("\x09\x00") });
    tr.end();
    await tick(10);
    expect(finished).toBe(true);
    expect(stream!.chunks).toHaveLength(1);
    expect(c.getSnapshot().charState).toBe("listening");
  });
});

describe("开场预加载", () => {
  it("先读后点开始：不再发新请求，读到的节拍照常播放；点之前不播放", async () => {
    const { c, turns, played } = setup();
    c.prefetchStart();
    expect(turns.length).toBe(1);
    turns[0].push({ type: "meta", turnId: 1, provider: "mock" });
    turns[0].push({ type: "beat", turnId: 1, beat: beat(0, "开场第一句"), audio: null });
    turns[0].push({ type: "done", turnId: 1 });
    turns[0].end();
    await tick(20);
    expect(played).toEqual([]);
    await c.start();
    await tick(80);
    expect(turns.length).toBe(1);
    expect(played).toEqual(["开场第一句"]);
    expect(c.getSnapshot().charState).toBe("idle");
  });

  it("还没读完就点开始：接上进行中的请求", async () => {
    const { c, turns, played } = setup();
    c.prefetchStart();
    void c.start();
    await tick(10);
    turns[0].push({ type: "beat", turnId: 1, beat: beat(0, "晚到的一句"), audio: null });
    turns[0].push({ type: "done", turnId: 1 });
    turns[0].end();
    await tick(80);
    expect(turns.length).toBe(1);
    expect(played).toEqual(["晚到的一句"]);
  });

  it("切换 Mock 后重新预加载，旧请求被取消", async () => {
    const { c, turns } = setup();
    c.prefetchStart();
    c.forceMock = true;
    c.prefetchStart();
    expect(turns.length).toBe(2);
    expect(turns[0].signal.aborted).toBe(true);
    expect(turns[1].req.forceMock).toBe(true);
  });
});
