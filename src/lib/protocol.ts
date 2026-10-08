export const EMOTIONS = ["neutral", "happy", "shy", "sad", "surprised"] as const;
export const ACTIONS = ["none", "sip", "look_window", "touch_hairpin", "raise_camera", "nod"] as const;
export const WEATHERS = ["storm", "rain", "clear"] as const;
export const CAMERAS = ["wide", "close"] as const;
export const FXS = ["none", "lightning", "sparkle"] as const;
export const PLOTS = ["meet", "chat", "reveal", "ending"] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type Weather = (typeof WEATHERS)[number];
export type Camera = (typeof CAMERAS)[number];
export type Fx = (typeof FXS)[number];
export type PlotStage = (typeof PLOTS)[number];

export type CharState = "idle" | "listening" | "thinking" | "speaking";

export interface SceneState {
  weather: Weather;
  camera: Camera;
}

export interface PhotoEvent {
  type: "photo";
  subject: string;
  caption?: string;
}

// 1文 = 1ビート。台詞・表情・動作・演出を同じ単位で運ぶ
export interface Beat {
  seq: number;
  say: string;
  emotion: Emotion;
  action: Action;
  scene?: Partial<SceneState>;
  fx?: Fx;
  event?: PhotoEvent;
  plot?: PlotStage;
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
  forceMock?: boolean;
  fail?: FailMode;
}

export type FailMode = "tts" | "llm_timeout" | "drop" | "image";

export type StreamEvent =
  | { type: "meta"; turnId: number; provider: string }
  | { type: "heard"; turnId: number; text: string }
  | { type: "beat"; turnId: number; beat: Beat; audio: BeatAudio | null; audioError?: string; stream?: { rate: number } }
  | { type: "audio"; turnId: number; seq: number; b64: string }
  | { type: "audio_end"; turnId: number; seq: number; error?: string }
  | { type: "metric"; turnId: number; name: string; ms: number }
  | { type: "done"; turnId: number }
  | { type: "error"; turnId: number; code: string; message: string };

export const PLOT_ORDER: Record<PlotStage, number> = { meet: 0, chat: 1, reveal: 2, ending: 3 };

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

// LLM出力は信用しない。列挙外の値は既定値へ丸める
export function normalizeBeat(raw: Record<string, unknown>, seq: number): Beat | null {
  const say = typeof raw.say === "string" ? raw.say.trim().slice(0, 120) : "";
  if (!say) return null;
  const beat: Beat = {
    seq,
    say,
    emotion: pick(EMOTIONS, raw.emotion, "neutral"),
    action: pick(ACTIONS, raw.action, "none"),
  };
  if (raw.scene && typeof raw.scene === "object") {
    const s = raw.scene as Record<string, unknown>;
    const scene: Partial<SceneState> = {};
    if (s.weather) scene.weather = pick(WEATHERS, s.weather, "rain");
    if (s.camera) scene.camera = pick(CAMERAS, s.camera, "wide");
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
  return beat;
}
