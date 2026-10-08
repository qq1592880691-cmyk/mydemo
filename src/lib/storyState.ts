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

export const MOON_PHOTO: PhotoEvent = {
  type: "photo",
  subject: "Moonlight breaking through thinning rain clouds over wet city rooftops, seen through a rain-speckled cafe window, warm lamp reflections on the glass",
  caption: "雨小了的时候",
};

export const DEFAULT_NOTE = "谢谢你的照片。三年后的今天，我会回来取。——一个躲雨的人";

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

const OUTER = new Set<Incident>(["blackout", "moon", "phone", "doorbell", "closing"]);

// 出来事の印を付けた句が、その出来事に実際に触れているかの目安
const INCIDENT_WORDS: Partial<Record<Incident, RegExp>> = {
  blackout: /停电|灯|黑|蜡烛/,
  moon: /月|雨小|雨停|云/,
  old_photo: /照片|这张/,
  note: /字条|留言|便利贴|写/,
  phone: /手机|电话|号码|震/,
  doorbell: /门铃|门|铃/,
  closing: /打烊|店长|十分钟|关门/,
  arrival: /门铃|门|他|来了/,
};

// 保底時刻表（何回目のユーザー発話までに起こすか）。モデルが早めに起こすのは自由で、遅れた分だけここで補う。
// 15 ターン前後で結末まで届くように並べてある
export const PLOT_DUE = { chat: 2, reveal: 6, ending: 13 } as const;
// 手机は任意（時刻表に入れない）。門铃と打烊の間は 1 ターン空けて、門铃に反応する余地を残す
const INCIDENT_DUE: [Incident, number][] = [
  ["blackout", 4],
  ["moon", 5],
  ["old_photo", 7],
  ["note", 9],
  ["doorbell", 10],
  ["closing", 12],
];
export const INCIDENT_DUE_AT: Record<string, number> = Object.fromEntries(INCIDENT_DUE);

// 結末の 2 ターン目にモデルが fin を付け忘れたときの締めの一句
export const FIN_LINE: Record<Ending, { say: string; emotion: Beat["emotion"]; action: Beat["action"] }> = {
  reunion: { say: "谢谢你今晚陪我等。再见啦。", emotion: "happy", action: "wave" },
  letgo: { say: "今晚，谢谢你。下次下雨再见。", emotion: "happy", action: "wave" },
  farewell: { say: "晚安。路上小心。", emotion: "sad", action: "wave" },
};

// 期限切れで補う出来事の台詞。ターンの最後の一句として足す
export const FORCED_LINE: Record<string, { say: string; emotion: Beat["emotion"] }> = {
  blackout: { say: "啊，停电了……别怕，我包里有蜡烛。", emotion: "surprised" },
  moon: { say: "诶，你看窗外，雨小了……有月亮。", emotion: "happy" },
  old_photo: { say: "给你看看吧，就是这张。", emotion: "shy" },
  note: { say: "对了，墙上还有他当年留的字条。", emotion: "shy" },
  phone: { say: "……我的手机响了，陌生号码。", emotion: "surprised" },
  doorbell: { say: "……门铃？", emotion: "surprised" },
  closing: { say: "嗯，店长在催了……", emotion: "sad" },
  arrival: { say: "……门铃？是他……真的是他。", emotion: "surprised" },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 1 ターン分の物語状態を節拍ごとに進める。変化があった節拍には反映後の状態を載せ、
// クライアントはその節拍を再生する瞬間に状態を差し替える（scene/plot と同じタイミング）
export class StoryTurn {
  private trustDelta = 0;
  private hadPhoto = false;
  // 1 ターンに進める物語は「内面の一歩」（阶段の前進・写真・字条）と「外から来る出来事」（停電・門铃など）を各 1 つまで。
  // 雑談に筋を詰め込みすぎず、それでいて場面の数だけターンが延びないようにする
  private progressed = false;
  private outerDone = false;
  private stepped = false;
  private enteredEnding = false;
  private readonly endingAtStart: Ending;

  // userTurn: このターンが何回目のユーザー発話か（userTurnOf と同じ数え方）
  constructor(
    public state: StoryState,
    private userTurn = 0,
  ) {
    this.endingAtStart = state.ending ?? pickEnding(state);
  }

  // ターン最初の句に呼ぶ。モデルが阶段の印を付け忘れても物語が止まらないよう、保底時刻表どおりに阶段を進める
  nudge(beat: Beat, plot: PlotStage): Beat {
    if (beat.plot) return beat;
    const t = this.userTurn;
    if (plot === "meet" && t >= PLOT_DUE.chat) beat.plot = "chat";
    else if (plot === "chat" && t >= PLOT_DUE.reveal) beat.plot = "reveal";
    else if (plot === "reveal" && t >= PLOT_DUE.ending && this.state.flags.includes("closing")) beat.plot = "ending";
    return beat;
  }

  // ターンの最後に呼ぶ。時刻表で期限を過ぎてもまだ起きていない出来事を 1 つ返す（このターンで既に進んでいれば無し）
  due(plot: PlotStage): Incident | null {
    if (this.stepped || plot === "meet" || plot === "ending") return null;
    const st = this.state;
    for (const [i, turn] of INCIDENT_DUE) {
      if (this.userTurn < turn || st.flags.includes(i) || !this.allowed(i, st, plot)) continue;
      // 門铃の直後のターンは打烊を補わない（門铃への反応に使う）
      if (i === "closing" && st.recent === "doorbell" && st.lastStep === this.userTurn - 1) continue;
      return i;
    }
    return null;
  }

  // 重逢に入ったのに「彼が来る」場面が無ければ、そのターンの最後で補う
  dueArrival(plot: PlotStage): boolean {
    const st = this.state;
    return plot === "ending" && st.ending === "reunion" && !st.flags.includes("arrival");
  }

  // 結末の 2 ターン目以降で、まだ締めていなければ締めの一句を返す
  dueFin(plot: PlotStage): Ending | null {
    const st = this.state;
    if (plot !== "ending" || !st.ending || st.fin || this.enteredEnding) return null;
    return st.ending;
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
      // 重逢の条件を満たしていても、門铃の後にユーザーが「放下」を勧めたなら释然にする（選択が結末を決める）
      st.ending = this.endingAtStart === "reunion" && beat.ending === "letgo" ? "letgo" : this.endingAtStart;
      this.enteredEnding = true;
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
      // 来電と「彼の到着」は結末の演出の一部なので制限に数えない
      const free = beat.incident === "lights_on" || beat.incident === "arrival";
      const outer = OUTER.has(beat.incident);
      const room = free || (outer ? !this.outerDone : !this.progressed);
      // 台詞がその出来事に触れていない句に付いた印は無効（音や演出が無関係な台詞に重ならないように）
      const fits = !INCIDENT_WORDS[beat.incident] || INCIDENT_WORDS[beat.incident]!.test(beat.say);
      if (this.allowed(beat.incident, st, plot) && room && fits) {
        if (!free) {
          if (outer) this.outerDone = true;
          else this.progressed = true;
          this.stepped = true;
        }
        st.flags.push(beat.incident);
        st.recent = beat.incident;
        changed = true;
        present(beat, beat.incident);
      } else {
        delete beat.incident;
      }
    }

    delete beat.ending;

    // 字条の文面は「note」の出来事が成立した句にだけ残し、状態にも覚えておく
    if (beat.incident !== "note") delete beat.note;
    else if (beat.note && st.noteText !== beat.note) {
      st.noteText = beat.note;
      changed = true;
    }

    // 写真（生図）は 1 ターン 1 枚まで
    if (beat.event) {
      if (this.hadPhoto) delete beat.event;
      else this.hadPhoto = true;
    }

    if (beat.fin) {
      // 結末に入ったターンでは締めない（山場と別れを 2 ターンに分ける）
      const inEnding = (plot === "ending" || st.ending !== undefined) && !this.enteredEnding;
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

  private allowed(i: Incident, st: StoryState, plot: PlotStage): boolean {
    if (st.flags.includes(i)) return false;
    // 寒暄の間は出来事を起こさない（開幕の「门铃响了」を剧情の門铃と取り違えないように）
    if (plot === "meet") return false;
    if (i === "doorbell") return st.flags.includes("old_photo");
    if (i === "lights_on") return st.flags.includes("blackout");
    if (i === "arrival") return st.ending === "reunion";
    if (i === "note" || i === "phone") return st.flags.includes("old_photo");
    if (i === "closing") return st.flags.includes("doorbell") && !st.ending;
    if (i === "moon") return !st.flags.includes("doorbell") && !st.ending;
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
    case "moon":
      // 雨が弱まり、窓の外に月が覗く。二人で窓の外を撮る
      beat.scene = { ...beat.scene, weather: "rain" };
      if (idle) beat.action = "raise_camera";
      beat.event ??= { ...MOON_PHOTO };
      break;
    case "note":
      beat.note ??= DEFAULT_NOTE;
      if (idle) beat.action = "touch_hairpin";
      break;
    case "phone":
      if (idle) beat.action = "check_phone";
      break;
    case "closing":
      // 閉店前の合図として店内の灯りを半分落とす
      beat.scene = { ...beat.scene, lights: "dim" };
      break;
    case "arrival":
      if (idle) beat.action = "look_door";
      if (!beat.fx || beat.fx === "none") beat.fx = "sparkle";
      break;
  }
}
