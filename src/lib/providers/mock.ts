import { Beat, INITIAL_STORY, PlotStage, StoryState, TurnRequest } from "../protocol";
import { pickEnding } from "../storyState";
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
  blackout: [
    { say: "诶——", emotion: "surprised", action: "look_window", incident: "blackout" },
    { say: "停电了……别怕，我包里有蜡烛。", emotion: "neutral", action: "hold_candle" },
    { say: "这样也挺好的，像在露营。", emotion: "happy", action: "chin_rest" },
  ],
  reveal: [
    { say: "……被你发现了。", emotion: "shy", action: "touch_hairpin", plot: "reveal", incident: "lights_on" },
    { say: "三年前也是这样的雨夜，我在这里给一个陌生人拍了张照片。", emotion: "neutral", action: "look_window" },
    { say: "就是这张。", emotion: "shy", action: "give_photo", incident: "old_photo" },
    { say: "我们约好今天，我把洗好的照片交给他。", emotion: "sad", action: "none" },
  ],
  moon: [
    { say: "诶，你看窗外——雨小了。", emotion: "surprised", action: "look_window" },
    { say: "云散开了，有月亮！别动，我拍一张。", emotion: "happy", action: "raise_camera", incident: "moon" },
  ],
  note: [
    { say: "其实……那天他走之前，在墙角的留言墙上贴了一张便利贴。", emotion: "shy", action: "look_window" },
    { say: "就是这张，我一直没舍得撕。", emotion: "shy", action: "touch_hairpin", incident: "note", note: "谢谢你的照片。三年后的今天，我会回来取。——一个躲雨的人" },
  ],
  phone: [
    { say: "嗯……我也不知道他还记不记得。", emotion: "sad", action: "none" },
    { say: "……手机响了。陌生号码。", emotion: "surprised", action: "check_phone", incident: "phone" },
    { say: "你说，我要接吗？", emotion: "shy", action: "check_phone" },
  ],
  closing: [
    { say: "嗯，我听到了……店长在催了。", emotion: "neutral", action: "look_window", incident: "closing" },
    { say: "十分钟……我得做个决定了。", emotion: "sad", action: "touch_hairpin" },
  ],
  doorbell: [
    { say: "……！", emotion: "surprised", action: "look_door", incident: "doorbell" },
    { say: "……是风啊。", emotion: "sad", action: "none" },
    { say: "你说，我还要再等下去吗？", emotion: "shy", action: "chin_rest" },
  ],
  reunion: [
    { say: "嗯……那我再等一会儿。谢谢你。", emotion: "happy", action: "nod", plot: "ending" },
    { say: "……门铃？", emotion: "surprised", action: "look_door", incident: "arrival" },
    { say: "是他……真的是他。", emotion: "happy", action: "wipe_tears", fx: "sparkle" },
    { say: "谢谢你今晚陪我等。再见啦。", emotion: "happy", action: "wave", fin: true },
  ],
  letgo: [
    { say: "真的……雨停了。", emotion: "surprised", action: "look_window", plot: "ending", ending: "letgo" },
    { say: "也许我等的不是他，是一个能好好告别的晚上。", emotion: "happy", action: "touch_hairpin", fx: "sparkle" },
    {
      say: "来，看镜头——今晚的纪念。",
      emotion: "happy",
      action: "raise_camera",
      event: { type: "photo", subject: "a cozy cafe window table right after rain, two coffee cups, wet street lights glowing outside", caption: "雨停的时候" },
      fin: true,
    },
  ],
  farewell: [
    { say: "……嗯。时间不早了，店要打烊了。", emotion: "sad", action: "look_window", plot: "ending" },
    { say: "没什么，只是雨太大了。", emotion: "sad", action: "wipe_tears" },
    { say: "路上小心。晚安。", emotion: "neutral", action: "wave", fin: true },
  ],
  after: [
    { say: "该说谢谢的是我。", emotion: "happy", action: "nod" },
    { say: "下次下雨的时候，也许还会在这里遇见你。", emotion: "shy", action: "touch_hairpin", fx: "sparkle" },
  ],
  idle: [
    { say: "嗯……我在听。", emotion: "neutral", action: "chin_rest" },
    { say: "这家店的拿铁很好喝，可惜快打烊了。", emotion: "neutral", action: "sip" },
  ],
} satisfies Record<string, Raw[]>;

// 台本ごとの返答候補。最後の 1 つが次の段へ進む言い回し（実モデルの prompt と同じ並び）
const CHOICES = new Map<Raw[], string[]>([
  [SCRIPT.start, ["你好，雨好大", "这里还营业吗？", "你是在等人吗？"]],
  [SCRIPT.greet, ["你是摄影师吗？", "这里的咖啡好喝吗？", "你在等谁呀？"]],
  [SCRIPT.photo, ["拍得真好看", "下次带我去拍照吧", "你在等谁呀？"]],
  [SCRIPT.blackout, ["别怕，我在呢", "烛光也挺好的", "雨好像小了？"]],
  [SCRIPT.idle, ["你拍的照片真好看", "谢谢你陪我聊天", "你在等谁呀？"]],
  [SCRIPT.moon, ["月亮真好看", "能给我也拍一张吗？", "你在等谁呀？"]],
  [SCRIPT.reveal, ["那张照片拍得真好", "他是个什么样的人？", "他有没有留下过什么？"]],
  [SCRIPT.note, ["字写得真好看", "他一定很珍惜那张照片", "你还要继续等吗？"]],
  [SCRIPT.phone, ["说不定是推销电话", "别接了", "接吧，说不定是他"]],
  [SCRIPT.closing, ["算了，关我什么事", "也许该放下了", "我陪你再等一会儿"]],
  [SCRIPT.doorbell, ["吓我一跳", "原来是风啊", "你还要继续等吗？"]],
  [SCRIPT.reunion, ["祝你们好好的", "谢谢你今晚的故事"]],
  [SCRIPT.letgo, ["这张照片我会留着", "下次下雨再见"]],
  [SCRIPT.farewell, ["晚安，路上小心", "对不起，打扰了"]],
  [SCRIPT.after, ["晚安", "再见啦"]],
]);

const KIND = /谢谢|喜欢|好看|陪你|加油|理解|抱歉|没关系|真好|厉害|温柔|一起/;
const RUDE = /无聊|关我什么事|烦|滚|随便|快点|没意思|算了吧/;

function pickScript(text: string, plot: PlotStage, story: StoryState, userTurns: number): Raw[] {
  const has = (f: string) => story.flags.some((x) => x === f);
  if (story.fin) return SCRIPT.after;
  if (plot === "ending") return SCRIPT[story.ending ?? "letgo"];
  if (plot === "reveal") {
    if (!has("old_photo")) return SCRIPT.reveal;
    if (!has("note")) return SCRIPT.note;
    if (!has("phone")) return SCRIPT.phone;
    if (!has("doorbell")) return SCRIPT.doorbell;
    if (!has("closing")) return SCRIPT.closing;
    const ending = pickEnding(story);
    return SCRIPT[ending === "reunion" && /放下|别等|不等/.test(text) ? "letgo" : ending];
  }
  // 雨が弱まるのは外から来る出来事なので、停電の後なら話題に関係なく先に起こす
  if (plot === "chat" && !has("moon") && (has("blackout") || /雨.*小|月亮|窗外/.test(text))) return SCRIPT.moon;
  if (/等|谁|为什么|一个人|约/.test(text)) return SCRIPT.reveal;
  if (/照片|拍|相机|摄影/.test(text)) return SCRIPT.photo;
  if (plot === "chat" && !has("blackout") && userTurns >= 3) return SCRIPT.blackout;
  if (plot === "chat" && userTurns >= 5) return SCRIPT.reveal;
  if (/你好|嗨|hi|hello|雨/i.test(text) || plot === "meet") return SCRIPT.greet;
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
    const story = req.story ?? INITIAL_STORY;
    const userTurns = req.history.filter((h) => h.who === "user").length + (req.input.kind === "start" ? 0 : 1);
    const script: Raw[] = req.input.kind === "start" ? SCRIPT.start : pickScript(text, req.plot, story, userTurns);
    const lines = structuredClone(script);
    // 友好的／冷淡な言葉で信頼度を動かし、結末の分岐を Mock でも試せるようにする
    const trust = KIND.test(text) ? 1 : RUDE.test(text) ? -2 : 0;
    if (trust && lines[0]) lines[0] = { ...lines[0], trust };
    await sleep(700, signal);
    for (let i = 0; i < lines.length; i++) {
      if (req.fail === "drop" && i === 1) throw new Error("stream_dropped");
      yield structuredClone(lines[i]);
      await sleep(250, signal);
    }
    const choices = CHOICES.get(script);
    if (choices) yield { choices };
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
