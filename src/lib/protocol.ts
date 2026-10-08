export const EMOTIONS = ["neutral", "happy", "shy", "sad", "surprised"] as const;
export const ACTIONS = [
  "none",
  "sip",
  "look_window",
  "touch_hairpin",
  "raise_camera",
  "nod",
  "chin_rest",
  "laugh",
  "give_photo",
  "look_door",
  "hold_candle",
  "wipe_tears",
  "wave",
  "check_phone",
] as const;
export const WEATHERS = ["storm", "rain", "clear"] as const;
export const CAMERAS = ["wide", "close"] as const;
export const FXS = ["none", "lightning", "sparkle"] as const;
export const PLOTS = ["meet", "chat", "reveal", "ending"] as const;
export const LIGHTS = ["on", "off", "dim"] as const;
export const INCIDENTS = ["blackout", "lights_on", "moon", "old_photo", "note", "phone", "doorbell", "closing", "arrival"] as const;
export const ENDINGS = ["reunion", "letgo", "farewell"] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type Weather = (typeof WEATHERS)[number];
export type Camera = (typeof CAMERAS)[number];
export type Fx = (typeof FXS)[number];
export type PlotStage = (typeof PLOTS)[number];
export type Lights = (typeof LIGHTS)[number];
export type Incident = (typeof INCIDENTS)[number];
export type Ending = (typeof ENDINGS)[number];

export type CharState = "idle" | "listening" | "thinking" | "speaking";

export interface SceneState {
  weather: Weather;
  camera: Camera;
  lights?: Lights;
}

// 隠し信頼度・発生済みイベント・確定した結末。クライアントが保持し、毎ターン送る
export interface StoryState {
  trust: number;
  flags: Incident[];
  ending?: Ending;
  fin?: boolean;
  // 最後に物語が一歩進んだユーザーターン番号。間が空くほど次の出来事を強く促す
  lastStep?: number;
  // 直近に起きた出来事。次のターンでまずそれに反応させる
  recent?: Incident;
}

export const INITIAL_STORY: StoryState = { trust: 4, flags: [] };

export interface PhotoEvent {
  type: "photo";
  subject: string;
  caption?: string;
}

// 1文 = 1ビート。台詞・表情・動作・演出を同じ単位で運ぶ
export interface Beat {
  seq: number;
  say: string;
  // say に音声タグ（<sigh> 等）を残した合成用テキスト。タグが無ければ省略
  speech?: string;
  emotion: Emotion;
  action: Action;
  scene?: Partial<SceneState>;
  fx?: Fx;
  event?: PhotoEvent;
  plot?: PlotStage;
  // LLM が付ける信頼度の増減（-2..2）と出来事、結末の最終行
  trust?: number;
  incident?: Incident;
  // incident "note" のとき、留言墙の字条に書かれていた文面
  note?: string;
  // ending に入る句で、モデルがユーザーの助言に沿って選んだ結末（許される範囲だけ採用）
  ending?: Ending;
  fin?: boolean;
  // サーバが反映した後の物語状態。変化した節拍にだけ付く
  story?: StoryState;
}

export interface BeatAudio {
  mime: string;
  b64: string;
}

export type TurnInput =
  | { kind: "start" }
  | { kind: "text"; text: string }
  | { kind: "audio"; b64: string; mime: string };

export interface HistoryItem {
  who: "user" | "mira";
  text: string;
  interrupted?: boolean;
}

export interface TurnRequest {
  sessionId?: string;
  turnId: number;
  input: TurnInput;
  history: HistoryItem[];
  scene: SceneState;
  plot: PlotStage;
  story?: StoryState;
  forceMock?: boolean;
  fail?: FailMode;
}

export type FailMode = "tts" | "llm_timeout" | "drop" | "image";

export type StreamEvent =
  | { type: "meta"; turnId: number; provider: string }
  | { type: "heard"; turnId: number; text: string }
  | { type: "choices"; turnId: number; items: string[] }
  | { type: "beat"; turnId: number; beat: Beat; audio: BeatAudio | null; audioError?: string; stream?: { rate: number } }
  | { type: "audio"; turnId: number; seq: number; b64: string }
  | { type: "audio_end"; turnId: number; seq: number; error?: string }
  | { type: "metric"; turnId: number; name: string; ms: number }
  | { type: "done"; turnId: number }
  | { type: "error"; turnId: number; code: string; message: string };

export const PLOT_ORDER: Record<PlotStage, number> = { meet: 0, chat: 1, reveal: 2, ending: 3 };

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

// ターン末尾の「こう返せる」候補。ユーザーの口調の短文を最大 3 つ
export function normalizeChoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") continue;
    const t = stripVoiceTags(c).replace(/^["“「]|["”」]$/g, "").trim().slice(0, 20);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

// 「你、你」「这、这」のような吃音の重ね。モデルが多用しがちなので 1 ターン 1 回までに減らす
export class StutterLimiter {
  private used = 0;
  apply(text: string): string {
    return text.replace(/([\u4e00-\u9fa5])、\1/g, (m, c: string) => (this.used++ ? c : m));
  }
}

// TTS が音として演じるタグ。字幕・履歴・他プロバイダには出さない
export const VOICE_TAGS = ["laugh", "sigh", "gasp", "breath", "short pause", "long pause"] as const;
const TAG_RE = /\s*<\s*([a-z ]+?)\s*>\s*/gi;

export function stripVoiceTags(text: string): string {
  return text.replace(TAG_RE, "").trim();
}

// LLM出力は信用しない。列挙外の値は既定値へ丸める
export function normalizeBeat(raw: Record<string, unknown>, seq: number): Beat | null {
  const rawSay = typeof raw.say === "string" ? raw.say.trim().slice(0, 160) : "";
  const say = stripVoiceTags(rawSay).slice(0, 120);
  if (!say) return null;
  const beat: Beat = {
    seq,
    say,
    emotion: pick(EMOTIONS, raw.emotion, "neutral"),
    action: pick(ACTIONS, raw.action, "none"),
  };
  // 未知のタグは捨て、既知のタグだけ合成用テキストに残す
  const speech = rawSay
    .replace(TAG_RE, (m, name: string) => ((VOICE_TAGS as readonly string[]).includes(name.toLowerCase()) ? ` <${name.toLowerCase()}> ` : ""))
    .replace(/\s+/g, " ")
    .trim();
  if (speech !== say) beat.speech = speech;
  if (raw.scene && typeof raw.scene === "object") {
    const s = raw.scene as Record<string, unknown>;
    const scene: Partial<SceneState> = {};
    if (s.weather) scene.weather = pick(WEATHERS, s.weather, "rain");
    if (s.camera) scene.camera = pick(CAMERAS, s.camera, "wide");
    if (s.lights) scene.lights = pick(LIGHTS, s.lights, "on");
    if (Object.keys(scene).length) beat.scene = scene;
  }
  if (raw.fx) beat.fx = pick(FXS, raw.fx, "none");
  if (raw.event && typeof raw.event === "object") {
    const e = raw.event as Record<string, unknown>;
    if (e.type === "photo" && typeof e.subject === "string" && e.subject.trim()) {
      beat.event = {
        type: "photo",
        subject: e.subject.trim().slice(0, 200),
        caption: typeof e.caption === "string" ? e.caption.slice(0, 40) : undefined,
      };
    }
  }
  if (raw.plot) {
    const p = pick(PLOTS, raw.plot, "meet");
    if (raw.plot === p) beat.plot = p;
  }
  const trust = typeof raw.trust === "number" ? raw.trust : typeof raw.trust === "string" ? Number(raw.trust) : NaN;
  if (Number.isFinite(trust) && Math.round(trust) !== 0) beat.trust = Math.max(-2, Math.min(2, Math.round(trust)));
  if (typeof raw.incident === "string" && (INCIDENTS as readonly string[]).includes(raw.incident)) beat.incident = raw.incident as Incident;
  if (raw.fin === true) beat.fin = true;
  if (typeof raw.ending === "string" && (ENDINGS as readonly string[]).includes(raw.ending)) beat.ending = raw.ending as Ending;
  if (typeof raw.note === "string" && stripVoiceTags(raw.note).trim()) beat.note = stripVoiceTags(raw.note).trim().slice(0, 80);
  return beat;
}
