import type { Beat, Ending, Incident, PhotoEvent, PlotStage, StoryState } from "./protocol";

export const TRUST_MAX = 10;
// 1 ターンで動かせる信頼度の上限。LLM が全行に付けても一気に振れないようにする
const TURN_TRUST_LIMIT = 2;

export const OLD_PHOTO: PhotoEvent = {
  type: "photo",
  subject:
    "A faded 35mm film photo from three years ago: a young man in a dark coat standing under the warm sign of a small cafe on a rainy night, half turned away, rain streaks in the streetlight",
  caption: "三年前的雨夜",
};

// 結末は「reveal → ending」に入る時点の状態で決める。prompt に書く結末と必ず一致させるため、ターン開始時の状態を使う
export function pickEnding(s: StoryState): Ending {
  if (s.trust >= 7 && s.flags.includes("doorbell")) return "reunion";
  if (s.trust <= 3) return "farewell";
  return "letgo";
}

// 何回目のユーザー発話か。開幕（start）は 0
export function userTurnOf(history: { who: string }[], inputKind: string): number {
  return history.filter((h) => h.who === "user").length + (inputKind === "start" ? 0 : 1);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 1 ターン分の物語状態を節拍ごとに進める。変化があった節拍には反映後の状態を載せ、
// クライアントはその節拍を再生する瞬間に状態を差し替える（scene/plot と同じタイミング）
export class StoryTurn {
  private trustDelta = 0;
  private hadPhoto = false;
  // 1 ターンに進める物語は 1 歩まで（阶段の前進か出来事のどちらか）。雑談に一気に筋を詰め込ませない
  private progressed = false;
  private stepped = false;
  private readonly endingAtStart: Ending;

  // userTurn: このターンが何回目のユーザー発話か（userTurnOf と同じ数え方）
  constructor(
    public state: StoryState,
    private userTurn = 0,
  ) {
    this.endingAtStart = state.ending ?? pickEnding(state);
  }

  // applyPlotHooks より前に呼ぶ。門铃が鳴る前の結末入りは無効にし、重逢の伏線を必ず通す
  gate(beat: Beat, plot: PlotStage): Beat {
    if (beat.plot === "ending" && !this.state.flags.includes("doorbell")) delete beat.plot;
    if (beat.plot && beat.plot !== plot && !this.state.ending) {
      if (this.progressed) delete beat.plot;
      else this.progressed = this.stepped = true;
    }
    return beat;
  }

  apply(beat: Beat, plot: PlotStage): Beat {
    const st: StoryState = { ...this.state, flags: [...this.state.flags] };
    let changed = false;

    if (beat.trust) {
      const allowed = clamp(this.trustDelta + beat.trust, -TURN_TRUST_LIMIT, TURN_TRUST_LIMIT) - this.trustDelta;
      const next = clamp(st.trust + allowed, 0, TRUST_MAX);
      this.trustDelta += allowed;
      if (next !== st.trust) {
        st.trust = next;
        changed = true;
      }
    }

    if (beat.plot === "ending" && !st.ending) {
      st.ending = this.endingAtStart;
      changed = true;
      // 停電のまま結末に入ったら灯りを戻す
      if (st.flags.includes("blackout") && !st.flags.includes("lights_on")) {
        st.flags.push("lights_on");
        beat.scene = { ...beat.scene, lights: "on" };
      }
    }
    if (st.ending === "farewell") {
      // 別れの結末は雨のまま、写真も撮らない
      if (beat.plot === "ending") beat.scene = { ...beat.scene, weather: "rain" };
      delete beat.event;
    }

    if (beat.incident) {
      // 来電と「彼の到着」は結末の演出の一部なので 1 歩の制限に数えない
      const free = beat.incident === "lights_on" || beat.incident === "arrival";
      if (this.allowed(beat.incident, st) && (free || !this.progressed)) {
        if (!free) this.progressed = this.stepped = true;
        st.flags.push(beat.incident);
        changed = true;
        present(beat, beat.incident);
      } else {
        delete beat.incident;
      }
    }

    // 写真（生図）は 1 ターン 1 枚まで
    if (beat.event) {
      if (this.hadPhoto) delete beat.event;
      else this.hadPhoto = true;
    }

    if (beat.fin) {
      const inEnding = plot === "ending" || st.ending !== undefined;
      if (inEnding && !st.fin) {
        st.fin = true;
        changed = true;
      } else {
        delete beat.fin;
      }
    }

    if (this.stepped && st.lastStep !== this.userTurn) {
      st.lastStep = this.userTurn;
      changed = true;
    }

    if (changed) {
      this.state = st;
      beat.story = st;
    }
    return beat;
  }

  private allowed(i: Incident, st: StoryState): boolean {
    if (st.flags.includes(i)) return false;
    if (i === "lights_on") return st.flags.includes("blackout");
    if (i === "arrival") return st.ending === "reunion";
    return true;
  }
}

// 出来事ごとの確定演出。LLM が書き忘れても場面が成立するよう、空いている欄だけ埋める
function present(beat: Beat, i: Incident) {
  const idle = beat.action === "none" || beat.action === "nod";
  switch (i) {
    case "blackout":
      beat.scene = { ...beat.scene, lights: "off" };
      if (!beat.fx || beat.fx === "none") beat.fx = "lightning";
      if (idle) beat.action = "hold_candle";
      break;
    case "lights_on":
      beat.scene = { ...beat.scene, lights: "on" };
      break;
    case "old_photo":
      if (idle) beat.action = "give_photo";
      beat.event ??= { ...OLD_PHOTO };
      break;
    case "doorbell":
      if (idle) beat.action = "look_door";
      break;
    case "arrival":
      if (idle) beat.action = "look_door";
      if (!beat.fx || beat.fx === "none") beat.fx = "sparkle";
      break;
  }
}
