import { Beat, HistoryItem, PlotStage, TurnRequest } from "../protocol";
import { CallCtx, EMPTY_USAGE, Purpose, getModel, logCall, statusOf } from "../aiRegistry";
import { Provider, ReplyChunk, sleep } from "./types";

// Mock も実呼び出しと同じ形で記録し、キー無しでも観測画面が埋まるようにする
function track(purpose: Purpose, ctx: CallCtx | undefined, t0: number, e?: unknown, signal?: AbortSignal) {
  logCall({
    row: getModel("mock", purpose),
    provider: "mock",
    purpose,
    modelId: "mock",
    ctx,
    status: e === undefined ? (signal?.aborted ? "aborted" : "ok") : statusOf(e, signal),
    latencyMs: Date.now() - t0,
    usage: EMPTY_USAGE,
    error: e === undefined ? undefined : String((e as Error)?.message ?? e),
  });
}

type Raw = Record<string, unknown>;

const HEARD: Record<PlotStage, string> = {
  meet: "你好，你也在等雨停吗？",
  chat: "你是摄影师吗？能给我看看你拍的照片吗？",
  reveal: "雨好像停了。",
  ending: "谢谢你今晚陪我聊天。",
};

const SCRIPT = {
  start: [
    { say: "啊……门铃。我还以为今晚不会再有人来了。", emotion: "surprised", action: "none", fx: "lightning", scene: { weather: "storm" } },
    { say: "外面雨很大吧？坐吧，店长说还能再待一会儿。", emotion: "neutral", action: "sip" },
  ],
  greet: [
    { say: "嗯，算是在等雨停吧。", emotion: "neutral", action: "look_window", plot: "chat" },
    { say: "也……不完全是。", emotion: "shy", action: "touch_hairpin" },
  ],
  photo: [
    { say: "你看出来了？我是拍照的，走到哪拍到哪。", emotion: "happy", action: "nod", plot: "chat" },
    {
      say: "这张是里斯本的雨夜，和今晚有点像。",
      emotion: "happy",
      action: "raise_camera",
      event: { type: "photo", subject: "a rain-soaked night street in Lisbon with a yellow tram and neon reflections", caption: "里斯本的雨夜" },
    },
  ],
  reveal: [
    { say: "……被你发现了。", emotion: "shy", action: "touch_hairpin", plot: "reveal" },
    { say: "三年前也是这样的雨夜，我在这里给一个陌生人拍了张照片。", emotion: "neutral", action: "look_window" },
    { say: "我们约好今天，我把洗好的照片交给他。", emotion: "sad", action: "none" },
    { say: "不过，他大概不会来了吧。", emotion: "sad", action: "sip" },
  ],
  ending: [
    { say: "真的……雨停了。", emotion: "surprised", action: "look_window", plot: "ending" },
    { say: "也许我等的不是他，是一个能好好告别的晚上。", emotion: "happy", action: "touch_hairpin", fx: "sparkle" },
    {
      say: "来，看镜头——今晚的纪念。",
      emotion: "happy",
      action: "raise_camera",
      event: { type: "photo", subject: "a cozy cafe window table right after rain, two coffee cups, wet street lights glowing outside", caption: "雨停的时候" },
    },
  ],
  farewell: [
    { say: "该说谢谢的是我。", emotion: "happy", action: "nod" },
    { say: "下次下雨的时候，也许还会在这里遇见你。", emotion: "shy", action: "touch_hairpin", fx: "sparkle" },
  ],
  idle: [
    { say: "嗯……我在听。", emotion: "neutral", action: "nod" },
    { say: "这家店的拿铁很好喝，可惜快打烊了。", emotion: "neutral", action: "sip" },
  ],
} satisfies Record<string, Raw[]>;

function pickScript(text: string, plot: PlotStage, history: HistoryItem[]): Raw[] {
  if (plot === "ending") return SCRIPT.farewell;
  if (/雨停|停了|晴|月亮/.test(text) || (plot === "reveal" && history.length > 8)) return SCRIPT.ending;
  if (/等|谁|为什么|一个人|约/.test(text)) return SCRIPT.reveal;
  if (/照片|拍|相机|摄影/.test(text)) return SCRIPT.photo;
  if (/你好|嗨|hi|hello|雨/i.test(text)) return SCRIPT.greet;
  if (plot === "reveal") return SCRIPT.ending;
  return SCRIPT.idle;
}

export class MockProvider implements Provider {
  name = "mock";

  async *reply(req: TurnRequest, signal: AbortSignal): AsyncIterable<ReplyChunk> {
    const t0 = Date.now();
    let err: unknown;
    try {
      yield* this.script(req, signal);
    } catch (e) {
      err = e;
      throw e;
    } finally {
      track("text", { sessionId: req.sessionId, turnId: req.turnId }, t0, err, signal);
    }
  }

  private async *script(req: TurnRequest, signal: AbortSignal): AsyncIterable<ReplyChunk> {
    if (req.fail === "llm_timeout") {
      await sleep(60_000, signal);
      return;
    }
    let text = "";
    if (req.input.kind === "audio") {
      await sleep(400, signal);
      const askedPhoto = req.history.some((h) => h.who === "user" && /照片|拍/.test(h.text));
      text = req.plot === "chat" && askedPhoto ? "你好像在等人，是在等谁呢？" : HEARD[req.plot];
      yield { heard: text };
    } else if (req.input.kind === "text") {
      text = req.input.text;
    }
    const lines = req.input.kind === "start" ? SCRIPT.start : pickScript(text, req.plot, req.history);
    await sleep(700, signal);
    for (let i = 0; i < lines.length; i++) {
      if (req.fail === "drop" && i === 1) throw new Error("stream_dropped");
      yield structuredClone(lines[i]);
      await sleep(250, signal);
    }
  }

  async tts(_beat: Beat, signal: AbortSignal, ctx?: CallCtx) {
    const t0 = Date.now();
    try {
      await sleep(120, signal);
      track("tts", ctx, t0);
      return null;
    } catch (e) {
      track("tts", ctx, t0, e, signal);
      throw e;
    }
  }

  async image(subject: string, signal: AbortSignal, ctx?: CallCtx) {
    const t0 = Date.now();
    try {
      await sleep(2500, signal);
      track("image", ctx, t0);
      return { mime: "image/svg+xml", b64: Buffer.from(mockPhotoSvg(subject)).toString("base64") };
    } catch (e) {
      track("image", ctx, t0, e, signal);
      throw e;
    }
  }
}

// キー無しでも「写真」演出が成立するよう、題材から決定的にSVGを描く
function mockPhotoSvg(subject: string): string {
  let h = 0;
  for (const c of subject) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((h = (h * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const hue = Math.floor(rnd() * 60) + 15;
  const dots = Array.from({ length: 26 }, () => {
    const x = Math.floor(rnd() * 400);
    const y = Math.floor(rnd() * 170) + 40;
    const r = Math.floor(rnd() * 18) + 4;
    const c = `hsla(${hue + Math.floor(rnd() * 60)},90%,${55 + Math.floor(rnd() * 25)}%,${0.25 + rnd() * 0.5})`;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue + 200},40%,12%)"/><stop offset="1" stop-color="hsl(${hue},45%,22%)"/></linearGradient>
<filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs>
<rect width="400" height="300" fill="url(#g)"/><g filter="url(#b)">${dots}</g>
<rect y="210" width="400" height="90" fill="hsl(${hue + 200},30%,8%)" opacity="0.8"/>
<g opacity="0.5">${Array.from({ length: 8 }, (_, i) => `<rect x="${i * 50 + 10}" y="215" width="6" height="${40 + (i % 3) * 20}" fill="hsl(${hue},80%,60%)" filter="url(#b)"/>`).join("")}</g>
</svg>`;
}
