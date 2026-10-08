import type { Ending, PlotStage, Weather } from "@/lib/protocol";

export type Track = Exclude<PlotStage, "ending"> | Ending;

const MUSIC_VOL = 0.32;
const RAIN_VOL: Record<Weather, number> = { storm: 0.07, rain: 0.04, clear: 0 };
const FADE_S = 3;

// 配乐・雨音・効果音。口パク用の analyser を通さず destination へ直結し、BGM で口が動かないようにする
export class Soundscape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private rain!: GainNode;
  private rainTone!: BiquadFilterNode;
  private buffers = new Map<Track, Promise<AudioBuffer | null>>();
  private bytes = new Map<Track, Promise<ArrayBuffer | null>>();
  private current: { track: Track; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wanted: Track | null = null;
  private weather: Weather = "storm";
  private muted = false;

  attach(ctx: AudioContext | null) {
    if (!ctx || this.ctx) return;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.buildRain(ctx);
    this.setWeather(this.weather);
    if (this.wanted) void this.setTrack(this.wanted);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.ramp(this.master.gain, m ? 0 : 1, 0.4);
  }

  setWeather(w: Weather) {
    this.weather = w;
    if (!this.ctx) return;
    this.ramp(this.rain.gain, RAIN_VOL[w], FADE_S);
    this.ramp(this.rainTone.frequency, w === "storm" ? 1800 : 1200, FADE_S);
  }

  // Mira が話している間は音楽を約 -8dB 下げる
  setDuck(on: boolean) {
    if (this.ctx) this.ramp(this.music.gain, on ? 0.4 : 1, on ? 0.25 : 1.2);
  }

  // null で無音（停電中など）。同じ曲なら何もしない
  async setTrack(track: Track | null) {
    this.wanted = track;
    const ctx = this.ctx;
    if (!ctx || this.current?.track === track) return;
    const old = this.current;
    this.current = null;
    if (old) {
      this.ramp(old.gain.gain, 0, track ? FADE_S : 0.15);
      old.src.stop(ctx.currentTime + (track ? FADE_S : 0.15) + 0.05);
    }
    if (!track) return;
    const buf = await this.load(track);
    if (!buf || this.wanted !== track || this.current) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.music);
    src.start();
    this.ramp(gain.gain, MUSIC_VOL, FADE_S);
    this.current = { track, src, gain };
  }

  // 低域を絞ったノイズの塊。光ってから少し遅れて鳴る
  thunder() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.4 + Math.random() * 0.8;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(ctx, 4, true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 280;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.6);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 3.8);
  }

  // ドアベル（ディン・ドン）。倍音を少し足してガラスっぽくする
  doorbell() {
    const ctx = this.ctx;
    if (!ctx) return;
    [1318.5, 1046.5].forEach((f, i) => {
      const t = ctx.currentTime + 0.05 + i * 0.42;
      for (const [mul, vol] of [[1, 0.22], [2.76, 0.05], [5.4, 0.02]] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = f * mul;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 1.8);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 1.9);
      }
    });
  }

  // 手机のバイブ：低いうなりを 0.4 秒ずつ 3 回
  phoneBuzz() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let i = 0; i < 3; i++) {
      const t = ctx.currentTime + 0.1 + i * 0.75;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 165;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.03);
      g.gain.setValueAtTime(0.16, t + 0.38);
      g.gain.linearRampToValueAtTime(0, t + 0.42);
      o.connect(lp).connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  // 録音済みの効果音・台詞（店長の声など）を一度だけ鳴らす。鳴っている間は音楽を下げる
  async clip(url: string, delay = 0.6) {
    const ctx = this.ctx;
    if (!ctx) return;
    const buf = await fetch(url)
      .then((r) => r.arrayBuffer())
      .then((a) => ctx.decodeAudioData(a))
      .catch(() => null);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    src.connect(g).connect(this.master);
    const t = ctx.currentTime + delay;
    src.start(t);
    this.music.gain.setTargetAtTime(0.35, t, 0.2);
    this.music.gain.setTargetAtTime(1, t + buf.duration, 0.6);
  }

  private buildRain(ctx: AudioContext) {
    const src = ctx.createBufferSource();
    src.buffer = this.noise(ctx, 6, false);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 400;
    this.rainTone = ctx.createBiquadFilter();
    this.rainTone.type = "lowpass";
    this.rainTone.frequency.value = 2000;
    this.rain = ctx.createGain();
    this.rain.gain.value = 0;
    src.connect(hp).connect(this.rainTone).connect(this.rain).connect(this.master);
    src.start();
  }

  // brown=true で低域寄り（雷）、false でピンク寄り（雨）
  private noise(ctx: AudioContext, seconds: number, brown: boolean) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let a = 0;
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        a = (a + 0.02 * w) / 1.02;
        d[i] = a * 3.5;
      } else {
        a = 0.97 * a + 0.03 * w;
        b = 0.6 * b + 0.4 * w;
        d[i] = (a * 2 + b * 0.5) * 0.8;
      }
    }
    return buf;
  }

  // 音声の解錠前でもダウンロードだけは始めておける（開場で最初の曲がすぐ鳴るように）
  preload(track: Track) {
    let p = this.bytes.get(track);
    if (!p) {
      p = fetch(`/bgm/${track}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`bgm ${r.status}`))))
        .catch(() => null);
      this.bytes.set(track, p);
    }
    return p;
  }

  private load(track: Track) {
    let p = this.buffers.get(track);
    if (!p) {
      p = this.preload(track)
        .then((a) => (a ? this.ctx!.decodeAudioData(a.slice(0)) : null))
        .catch(() => null);
      this.buffers.set(track, p);
    }
    return p;
  }

  private ramp(p: AudioParam, v: number, s: number) {
    const now = this.ctx!.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(v, now + s);
  }
}
