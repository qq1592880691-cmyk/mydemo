import type { Beat, BeatAudio, StreamEvent, TurnRequest } from "@/lib/protocol";
import { PcmStream, type AudioOut } from "./turnController";

export async function* sseTransport(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`http_${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) yield JSON.parse(data) as StreamEvent;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function fetchImage(subject: string, signal: AbortSignal, opts: { forceMock: boolean; fail?: string; sessionId?: string }) {
  const res = await fetch("/api/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, ...opts }),
    signal,
  });
  const json = await res.json();
  if (!res.ok || !json.url) throw new Error(json.error || `http_${res.status}`);
  return json.url as string;
}

// 再生と口パク用の音量を一手に引き受ける。TTS音声が無ければ浏览器朗读→字幕のみ と段階的に降格する
export class BrowserAudio implements AudioOut {
  ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private live = 0;
  private data = new Uint8Array(256);
  private freq = new Uint8Array(256);
  private fakeLevel = 0;
  private fakeTimer: ReturnType<typeof setInterval> | null = null;
  private stopCurrent: (() => void) | null = null;
  mode: "tts" | "browser" | "subtitle" = "tts";

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      // 周波数側の既定平滑化（0.8）だと音節ごとの a/o の変化が均されて口形に出ない
      this.analyser.smoothingTimeConstant = 0.4;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    // iOS の speechSynthesis もジェスチャ内で一度起動しておく
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }

  level(): number {
    if ((this.source || this.live) && this.analyser) {
      this.analyser.getByteTimeDomainData(this.data);
      let sum = 0;
      for (const v of this.data) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / this.data.length) * 4);
    }
    return this.fakeLevel;
  }

  // 口形の o/a 判定用。再生中の音声のスペクトル重心（Hz）、無音・非再生時は 0
  tone(): number {
    if (!(this.source || this.live) || !this.analyser || !this.ctx) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    let num = 0;
    let den = 0;
    for (let i = Math.ceil(100 / hz); i < Math.min(this.freq.length, 4000 / hz); i++) {
      num += this.freq[i] * i * hz;
      den += this.freq[i];
    }
    return den > 0 ? num / den : 0;
  }

  stop() {
    this.stopCurrent?.();
    this.stopCurrent = null;
  }

  async play(audio: BeatAudio | PcmStream | null, beat: Beat, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (audio instanceof PcmStream) {
      if (this.ctx && (await this.playStream(audio, signal))) return;
      if (signal.aborted) return;
      audio = null;
    }
    if (audio && this.ctx) {
      try {
        const bytes = Uint8Array.from(atob(audio.b64), (c) => c.charCodeAt(0));
        const buf = await this.ctx.decodeAudioData(bytes.buffer);
        if (signal.aborted) return;
        this.mode = "tts";
        return await this.playBuffer(buf, signal);
      } catch {
        // デコード失敗は下の降格経路へ
      }
    }
    if ("speechSynthesis" in window && hasZhVoice()) {
      this.mode = "browser";
      return this.speak(beat.say, signal);
    }
    this.mode = "subtitle";
    return this.waitText(beat.say, signal);
  }

  // 届いた PCM 断片を順に時刻指定で並べて再生する。1 片も来なければ false を返して降格させる
  private async playStream(stream: PcmStream, signal: AbortSignal): Promise<boolean> {
    const ctx = this.ctx!;
    const sources: AudioBufferSourceNode[] = [];
    let at = 0;
    let got = false;
    let stopped = false;
    const stopAll = () => {
      stopped = true;
      sources.forEach((s) => {
        try {
          s.stop();
        } catch {}
      });
    };
    this.stopCurrent = stopAll;
    signal.addEventListener("abort", stopAll, { once: true });
    this.live++;
    try {
      for await (const chunk of stream.read(signal)) {
        if (stopped) break;
        const n = chunk.length >> 1;
        if (!n) continue;
        const view = new DataView(chunk.buffer, chunk.byteOffset, n * 2);
        const buf = ctx.createBuffer(1, n, stream.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.analyser!);
        // 初回は少し先に置き、後続の断片が間に合う余裕を持たせる
        at = Math.max(at, ctx.currentTime + (got ? 0.005 : 0.08));
        src.start(at);
        at += buf.duration;
        sources.push(src);
        got = true;
      }
      if (!got || stopped) return got;
      const remain = at - ctx.currentTime;
      if (remain > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, remain * 1000);
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
      return true;
    } finally {
      this.live--;
      if (this.stopCurrent === stopAll) this.stopCurrent = null;
    }
  }

  private playBuffer(buf: AudioBuffer, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser!);
      this.source = src;
      const finish = () => {
        if (this.source === src) this.source = null;
        this.stopCurrent = null;
        resolve();
      };
      this.stopCurrent = () => {
        try {
          src.stop();
        } catch {}
        finish();
      };
      signal.addEventListener("abort", () => this.stopCurrent?.(), { once: true });
      src.onended = finish;
      src.start();
    });
  }

  private speak(text: string, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const synth = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1.05;
      u.pitch = 1.15;
      const v = zhVoice();
      if (v) u.voice = v;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        this.stopFake();
        this.stopCurrent = null;
        resolve();
      };
      // onend が来ないブラウザ対策
      const safety = setTimeout(finish, text.length * 350 + 3000);
      u.onend = finish;
      u.onerror = finish;
      this.stopCurrent = () => {
        synth.cancel();
        finish();
      };
      signal.addEventListener("abort", () => this.stopCurrent?.(), { once: true });
      this.startFake();
      synth.cancel();
      synth.speak(u);
    });
  }

  private waitText(text: string, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => finish(), Math.max(1400, text.length * 200));
      const finish = () => {
        clearTimeout(t);
        this.stopFake();
        this.stopCurrent = null;
        resolve();
      };
      this.stopCurrent = finish;
      signal.addEventListener("abort", finish, { once: true });
      this.startFake();
    });
  }

  private startFake() {
    this.stopFake();
    this.fakeTimer = setInterval(() => {
      this.fakeLevel = Math.random() < 0.25 ? 0.05 : 0.3 + Math.random() * 0.5;
    }, 90);
  }

  private stopFake() {
    if (this.fakeTimer) clearInterval(this.fakeTimer);
    this.fakeTimer = null;
    this.fakeLevel = 0;
  }
}

function zhVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => /^zh/i.test(v.lang));
  return voices.find((v) => /CN/i.test(v.lang) && /female|Tingting|Xiaoxiao|Meijia/i.test(v.name)) ?? voices.find((v) => /CN/i.test(v.lang)) ?? voices[0];
}

function hasZhVoice() {
  return window.speechSynthesis.getVoices().length === 0 || !!zhVoice();
}

// 押して話す録音。どのブラウザでも同じ WAV(16kHz mono) を作り、STT 側の形式差を消す
export class MicRecorder {
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private lvl = 0;
  private peak = 0;

  constructor(private getCtx: () => AudioContext | null) {}

  get level() {
    return this.lvl;
  }

  async start() {
    const ctx = this.getCtx();
    if (!ctx) throw new Error("audio_locked");
    if (!this.stream || this.stream.getTracks().some((t) => t.readyState === "ended")) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    }
    this.chunks = [];
    this.peak = 0;
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(d));
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] * d[i];
      this.lvl = Math.min(1, Math.sqrt(s / (d.length / 4)) * 6);
      this.peak = Math.max(this.peak, this.lvl);
    };
    this.src.connect(this.node);
    // ScriptProcessor は出力先に繋がないと動かないブラウザがあるので無音で接続
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(ctx.destination);
    this.startedAt = performance.now();
  }

  // peak: 録音中の最大音量（0..1）。ほぼ無音なら送らない判断に使う
  stop(): { b64: string; mime: string; ms: number; peak: number } | null {
    const ctx = this.getCtx();
    this.node?.disconnect();
    this.src?.disconnect();
    this.node = null;
    this.src = null;
    this.lvl = 0;
    const ms = performance.now() - this.startedAt;
    if (!ctx || !this.chunks.length) return null;
    const wav = encodeWav(this.chunks, ctx.sampleRate, 16000);
    this.chunks = [];
    return { b64: bytesToB64(wav), mime: "audio/wav", ms, peak: this.peak };
  }
}

function encodeWav(chunks: Float32Array[], inRate: number, outRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  const ratio = inRate / outRate;
  const len = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (p: number, s: string) => [...s].forEach((ch, i) => v.setUint8(p + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, merged[Math.floor(i * ratio)]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function bytesToB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
