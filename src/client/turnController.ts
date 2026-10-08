import {
  Action,
  Beat,
  BeatAudio,
  CharState,
  Emotion,
  FailMode,
  Fx,
  HistoryItem,
  INITIAL_STORY,
  Incident,
  PlotStage,
  SceneState,
  StoryState,
  StreamEvent,
  TurnInput,
  TurnRequest,
} from "@/lib/protocol";

// サーバから逐次届く PCM s16le。再生側は read() で到着を待ちながら取り出す
export class PcmStream {
  chunks: Uint8Array[] = [];
  done = false;
  error?: string;
  private waiters: (() => void)[] = [];

  constructor(readonly rate: number) {}

  push(b64: string) {
    this.chunks.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    this.wake();
  }

  end(error?: string) {
    this.error = error;
    this.done = true;
    this.wake();
  }

  private wake() {
    this.waiters.splice(0).forEach((w) => w());
  }

  async *read(signal: AbortSignal): AsyncIterable<Uint8Array> {
    let i = 0;
    while (!signal.aborted) {
      if (i < this.chunks.length) {
        yield this.chunks[i++];
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiters.push(r);
        signal.addEventListener("abort", () => r(), { once: true });
      });
    }
  }
}

export interface AudioOut {
  play(audio: BeatAudio | PcmStream | null, beat: Beat, signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface Deps {
  transport(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  audio: AudioOut;
  image(subject: string, signal: AbortSignal): Promise<string>;
  now?: () => number;
  firstEventTimeoutMs?: number;
}

export interface Photo {
  id: number;
  status: "developing" | "ready" | "failed";
  subject: string;
  caption?: string;
  url?: string;
}

export interface LogItem {
  t: number;
  turnId: number;
  kind: string;
  detail?: string;
}

export interface Snapshot {
  started: boolean;
  charState: CharState;
  emotion: Emotion;
  action: Action;
  actionNonce: number;
  fx: Fx;
  fxNonce: number;
  scene: SceneState;
  plot: PlotStage;
  story: StoryState;
  // 効果音など一度きりの演出用。nonce が進んだら発火する
  incident: { kind: Incident; nonce: number } | null;
  // 「こう返せる」候補。回合が終わって待機に戻ったときだけ出す
  choices: string[];
  subtitle: { who: "mira" | "user"; text: string; turnId: number } | null;
  photo: Photo | null;
  error: { code: string; message: string } | null;
  notice: string | null;
  provider: string;
  turnId: number;
  history: HistoryItem[];
  metrics: Record<string, number>;
  log: LogItem[];
}

const ERROR_TEXT: Record<string, string> = {
  llm_timeout: "Mira 好像走神了（模型响应超时）",
  stream_dropped: "连接中断了，回复没有完整送达",
  network: "网络连接失败",
  provider_error: "模型调用出错",
};

interface Queued {
  beat: Beat;
  audio: BeatAudio | PcmStream | null;
  audioError?: string;
}

export class TurnController {
  private s: Snapshot = {
    started: false,
    charState: "idle",
    emotion: "neutral",
    action: "none",
    actionNonce: 0,
    fx: "none",
    fxNonce: 0,
    scene: { weather: "storm", camera: "wide", lights: "on" },
    plot: "meet",
    story: INITIAL_STORY,
    incident: null,
    choices: [],
    subtitle: null,
    photo: null,
    error: null,
    notice: null,
    provider: "",
    turnId: 0,
    history: [],
    metrics: {},
    log: [],
  };
  private listeners = new Set<() => void>();
  // epoch は「現在有効な応答」の世代番号。取消のたびに進め、古い非同期処理を全て無効化する
  private epoch = 0;
  private turnSeq = 0;
  private ac: AbortController | null = null;
  private playAc: AbortController | null = null;
  private photoEpoch = -1;
  private photoAc: AbortController | null = null;
  private queue: Queued[] = [];
  private streams = new Map<number, PcmStream>();
  private playing = false;
  private streamDone = false;
  private turnActive = false;
  private spoken: string[] = [];
  private pendingChoices: string[] = [];
  private lastInput: TurnInput | null = null;
  private photoSeq = 0;
  private t0 = 0;

  readonly sessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
  forceMock = false;
  fail: FailMode | undefined;

  constructor(private deps: Deps) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.s;

  private set(patch: Partial<Snapshot>) {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((l) => l());
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private log(kind: string, detail?: string, turnId = this.s.turnId) {
    const log = [...this.s.log, { t: this.now(), turnId, kind, detail }];
    this.set({ log: log.length > 200 ? log.slice(-200) : log });
  }

  start() {
    this.set({ started: true });
    return this.submit({ kind: "start" });
  }

  sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    return this.submit({ kind: "text", text: t });
  }

  sendAudio(b64: string, mime: string) {
    return this.submit({ kind: "audio", b64, mime });
  }

  retry() {
    if (this.lastInput) return this.submit(this.lastInput, true);
  }

  // 押下した瞬間に呼ぶ。発話中なら即座に止めて「倾听」へ
  beginListening() {
    this.cancel("interrupt");
    this.set({ charState: "listening", error: null, notice: null, choices: [] });
  }

  cancelListening() {
    if (this.s.charState === "listening") this.set({ charState: "idle" });
  }

  clearError() {
    this.set({ error: null });
  }

  dismissPhoto() {
    this.photoAc?.abort();
    this.set({ photo: null });
  }

  retryPhoto() {
    const p = this.s.photo;
    if (p?.status === "failed") this.startPhoto(p.subject, p.caption);
  }

  private cancel(reason: string) {
    if (!this.turnActive) return;
    this.epoch++;
    this.ac?.abort();
    this.playAc?.abort();
    this.ac = null;
    this.playAc = null;
    this.deps.audio.stop();
    const dropped = this.queue.length;
    this.queue = [];
    this.streams.clear();
    this.playing = false;
    this.turnActive = false;
    if (this.s.photo?.status === "developing" && this.photoEpoch === this.epoch - 1) this.dismissPhoto();
    if (this.spoken.length) this.pushHistory({ who: "mira", text: this.spoken.join(""), interrupted: true });
    this.spoken = [];
    this.log(reason, `丢弃未播放节拍 ${dropped} 个`);
  }

  private pushHistory(h: HistoryItem) {
    this.set({ history: [...this.s.history, h].slice(-40) });
  }

  private async submit(input: TurnInput, isRetry = false) {
    this.cancel("superseded");
    const epoch = ++this.epoch;
    const turnId = ++this.turnSeq;
    const ac = new AbortController();
    const playAc = new AbortController();
    this.ac = ac;
    this.playAc = playAc;
    this.turnActive = true;
    this.streamDone = false;
    this.streams.clear();
    this.spoken = [];
    this.pendingChoices = [];
    this.lastInput = input;
    this.t0 = this.now();

    const history = this.s.history;
    if (input.kind === "text" && !isRetry) this.pushHistory({ who: "user", text: input.text });
    this.set({
      turnId,
      charState: "thinking",
      choices: [],
      error: null,
      notice: null,
      metrics: {},
      subtitle: input.kind === "text" ? { who: "user", text: input.text, turnId } : this.s.subtitle,
    });
    this.log("turn_start", input.kind, turnId);

    let gotBeat = false;
    const watchdog = setTimeout(() => {
      if (epoch === this.epoch && !gotBeat) this.failTurn(epoch, "llm_timeout");
    }, this.deps.firstEventTimeoutMs ?? 20_000);

    const req: TurnRequest = {
      sessionId: this.sessionId,
      turnId,
      input,
      history: isRetry && input.kind === "text" ? history.slice(0, -1) : history,
      scene: this.s.scene,
      plot: this.s.plot,
      story: this.s.story,
      forceMock: this.forceMock,
      fail: this.fail,
    };

    try {
      for await (const ev of this.deps.transport(req, ac.signal)) {
        if (epoch !== this.epoch) return;
        if (ev.turnId !== turnId) {
          this.log("stale_dropped", ev.type, ev.turnId);
          continue;
        }
        switch (ev.type) {
          case "meta":
            this.set({ provider: ev.provider });
            break;
          case "heard":
            // 聞き取れなかった回は空になる。履歴にも字幕にも残さない
            if (ev.text.trim()) {
              this.pushHistory({ who: "user", text: ev.text });
              this.set({ subtitle: { who: "user", text: ev.text, turnId } });
            }
            this.log("heard", ev.text || "（没听清）", turnId);
            break;
          case "metric":
            this.set({ metrics: { ...this.s.metrics, [ev.name]: ev.ms } });
            break;
          case "beat": {
            if (!gotBeat) this.set({ metrics: { ...this.s.metrics, client_first_beat: this.now() - this.t0 } });
            gotBeat = true;
            let audio: BeatAudio | PcmStream | null = ev.audio;
            if (ev.stream) {
              audio = new PcmStream(ev.stream.rate);
              this.streams.set(ev.beat.seq, audio);
            }
            this.queue.push({ beat: ev.beat, audio, audioError: ev.audioError });
            if (!this.playing) void this.playLoop(epoch, playAc.signal);
            break;
          }
          case "choices":
            this.pendingChoices = ev.items;
            break;
          case "audio":
            this.streams.get(ev.seq)?.push(ev.b64);
            break;
          case "audio_end":
            this.streams.get(ev.seq)?.end(ev.error);
            if (ev.error) this.set({ notice: "语音合成中断，后半句改为字幕显示" });
            break;
          case "done":
            this.streamDone = true;
            this.maybeFinish(epoch);
            break;
          case "error":
            this.failTurn(epoch, ev.code, ev.message);
            return;
        }
      }
      if (epoch === this.epoch && !this.streamDone) this.failTurn(epoch, "stream_dropped");
    } catch {
      if (epoch === this.epoch && !this.streamDone) this.failTurn(epoch, "network");
    } finally {
      clearTimeout(watchdog);
    }
  }

  private failTurn(epoch: number, code: string, message?: string) {
    if (epoch !== this.epoch) return;
    this.streamDone = true;
    this.ac?.abort();
    // 未完の音声ストリームを閉じ、再生側を待たせない
    this.streams.forEach((st) => st.done || st.end(code));
    this.set({ error: { code, message: ERROR_TEXT[code] ?? message ?? code } });
    this.log("error", code);
    // 受信済みの節拍は有効なので再生を続け、終わったら待機へ
    this.maybeFinish(epoch);
  }

  private async playLoop(epoch: number, signal: AbortSignal) {
    this.playing = true;
    while (this.queue.length) {
      if (epoch !== this.epoch) return;
      const q = this.queue.shift()!;
      this.applyBeat(q, epoch);
      try {
        await this.deps.audio.play(q.audio, q.beat, signal);
      } catch {
        // 再生失敗は字幕のみで継続
      }
      if (epoch !== this.epoch) return;
    }
    this.playing = false;
    this.maybeFinish(epoch);
  }

  private applyBeat({ beat, audioError }: Queued, epoch: number) {
    const patch: Partial<Snapshot> = {
      charState: "speaking",
      emotion: beat.emotion,
      subtitle: { who: "mira", text: beat.say, turnId: this.s.turnId },
    };
    if (beat.action !== "none") {
      patch.action = beat.action;
      patch.actionNonce = this.s.actionNonce + 1;
    }
    if (beat.fx && beat.fx !== "none") {
      patch.fx = beat.fx;
      patch.fxNonce = this.s.fxNonce + 1;
    }
    if (beat.scene) patch.scene = { ...this.s.scene, ...beat.scene };
    if (beat.plot) patch.plot = beat.plot;
    if (beat.story) patch.story = beat.story;
    if (beat.incident) patch.incident = { kind: beat.incident, nonce: (this.s.incident?.nonce ?? 0) + 1 };
    if (audioError) patch.notice = "语音合成失败，已降级为浏览器朗读/仅字幕";
    this.set(patch);
    this.spoken.push(beat.say);
    this.log("beat", `${beat.emotion}/${beat.action} ${beat.say}`);
    if (beat.plot) this.log("plot", beat.plot);
    if (beat.scene) this.log("scene", JSON.stringify(beat.scene));
    if (beat.incident) this.log("incident", beat.incident);
    if (beat.story) this.log("story", `trust=${beat.story.trust} ${beat.story.flags.join(",")}${beat.story.ending ? ` ending=${beat.story.ending}` : ""}${beat.story.fin ? " fin" : ""}`);
    if (beat.event?.type === "photo" && epoch === this.epoch) this.startPhoto(beat.event.subject, beat.event.caption);
  }

  private startPhoto(subject: string, caption: string | undefined) {
    this.photoAc?.abort();
    const ac = new AbortController();
    this.photoAc = ac;
    this.photoEpoch = this.epoch;
    const id = ++this.photoSeq;
    this.set({ photo: { id, status: "developing", subject, caption } });
    this.log("photo_start", subject);
    const t = this.now();
    this.deps
      .image(subject, ac.signal)
      .then((url) => {
        if (ac.signal.aborted || this.s.photo?.id !== id) return;
        this.set({ photo: { id, status: "ready", subject, caption, url }, metrics: { ...this.s.metrics, image: this.now() - t } });
        this.log("photo_ready");
      })
      .catch((e) => {
        if (ac.signal.aborted || this.s.photo?.id !== id) return;
        this.set({ photo: { id, status: "failed", subject, caption } });
        this.log("photo_failed", String(e?.message ?? e));
      });
  }

  private maybeFinish(epoch: number) {
    if (epoch !== this.epoch || !this.streamDone || this.playing || this.queue.length) return;
    if (!this.turnActive) return;
    this.turnActive = false;
    if (this.spoken.length) this.pushHistory({ who: "mira", text: this.spoken.join("") });
    this.spoken = [];
    this.set({ charState: "idle", choices: this.pendingChoices, metrics: { ...this.s.metrics, client_total: this.now() - this.t0 } });
    this.pendingChoices = [];
    this.log("turn_end");
  }
}
