"use client";

import { useEffect, useRef, useState } from "react";
import type { Action, CharState, Emotion } from "@/lib/protocol";
import Mira from "./Mira";

interface Props {
  emotion: Emotion;
  action: Action;
  actionNonce: number;
  charState: CharState;
  getLevel: () => number;
  getTone?: () => number;
}

interface Manifest {
  width: number;
  height: number;
  sprites: string[];
}

const ACTION_SPRITE: Partial<Record<Action, string>> = {
  sip: "act_sip",
  raise_camera: "act_camera",
  touch_hairpin: "act_hairpin",
  look_window: "act_window",
  chin_rest: "act_chin",
  laugh: "act_laugh",
  give_photo: "act_photo",
  look_door: "act_door",
  hold_candle: "act_candle",
  wipe_tears: "act_tears",
  wave: "act_wave",
  check_phone: "act_phone",
};
// 動作の立ち絵には口形差分が無いので、話しながら口が止まって見える時間を短めにする
const ACTION_MS = 2200;

// 口形: 閉 → 半開き → 開（a）/ すぼめ（o）。差分は口の周りだけなので、フェードせず即座に差し替える
type Mouth = "" | "half" | "talk" | "o";
const MOUTHS = ["half", "talk", "o"] as const;
const HOLD_MS = 70;

// 立绘があれば立绘、無ければ SVG 版へ降格する
export default function Character(props: Props) {
  const [manifest, setManifest] = useState<Manifest | false | null>(null);
  useEffect(() => {
    fetch("/sprites/manifest.json")
      .then((r) => (r.ok ? r.json() : false))
      .then(setManifest)
      .catch(() => setManifest(false));
  }, []);
  if (manifest === false) return <Mira {...props} />;
  if (!manifest) return null;
  return <SpriteMira m={manifest} {...props} />;
}

function SpriteMira({ m, emotion, action, actionNonce, charState, getLevel, getTone }: Props & { m: Manifest }) {
  const wrap = useRef<HTMLDivElement>(null);
  const sway = useRef<HTMLDivElement>(null);
  const [acting, setActing] = useState<string | null>(null);
  const has = (n: string) => m.sprites.includes(n);

  useEffect(() => {
    const s = ACTION_SPRITE[action];
    if (!actionNonce || !s || !m.sprites.includes(s)) return;
    setActing(s);
    const t = setTimeout(() => setActing(null), ACTION_MS);
    return () => clearTimeout(t);
  }, [action, actionNonce, m.sprites]);

  const base = acting ?? (has(emotion) ? emotion : "neutral");
  const talking = !acting && has(`talk_${emotion}`);
  const canBlink = !acting && emotion === "neutral" && has("blink");

  // 口パクと瞬きは DOM への直接書き込みだけで行い、React の再描画を避ける。
  // 音量の包絡線で開き具合を、スペクトル重心で a/o を選び、最低保持時間と半開き経由で切り替えてパクパク感を抑える
  useEffect(() => {
    let raf = 0;
    let env = 0;
    let toneAvg = 0;
    let mouth: Mouth = "";
    let since = 0;
    let last = performance.now();
    let nextBlink = last + 2500;
    let blinkUntil = 0;
    // 話している間の頭の揺れ: ゆっくりした左右の揺れ + 声の強まりでの小さな頷き
    let talkAmt = 0;
    let slowEnv = 0;
    let nodAt = -1e9;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pick = (): Mouth => {
      const up = (th: number) => th - (mouth === "" ? 0 : 0.03);
      if (env < up(0.1)) return "";
      if (env < up(0.3)) return "half";
      const tone = getTone?.() ?? 0;
      if (tone > 0) toneAvg = toneAvg ? toneAvg + (tone - toneAvg) * 0.05 : tone;
      return tone > 0 && toneAvg > 0 && tone < toneAvg * 0.88 ? "o" : "talk";
    };
    const loop = (t: number) => {
      const el = wrap.current;
      const dt = Math.min(64, t - last);
      last = t;
      if (el) {
        const lv = charState === "speaking" ? getLevel() : 0;
        env += (lv - env) * (1 - Math.exp(-dt / (lv > env ? 20 : 70)));
        if (t - since >= HOLD_MS) {
          let next = pick();
          // 閉 ⇔ 開 の直接移動は一度半開きを挟む
          if ((mouth === "" && (next === "talk" || next === "o")) || (next === "" && (mouth === "talk" || mouth === "o"))) next = "half";
          if (next !== mouth) {
            mouth = next;
            since = t;
            el.dataset.mouth = mouth;
          }
        }
        const speaking = charState === "speaking";
        talkAmt += ((speaking ? 1 : 0) - talkAmt) * (1 - Math.exp(-dt / 400));
        slowEnv += (env - slowEnv) * (1 - Math.exp(-dt / (env > slowEnv ? 90 : 260)));
        // 強勢（短い包絡が長い包絡を大きく上回る瞬間）で頷く。連続しないよう間隔を空ける
        if (speaking && env > slowEnv * 1.35 + 0.12 && t - nodAt > 650) nodAt = t;
        const sw = sway.current;
        if (sw && !still) {
          const np = (t - nodAt) / 420;
          const nod = np >= 0 && np < 1 ? Math.sin(Math.PI * np) : 0;
          const r = talkAmt * (0.45 * Math.sin((t / 3700) * 2 * Math.PI) + 0.2 * Math.sin((t / 5300) * 2 * Math.PI)) + nod * 0.35;
          const x = talkAmt * 1.4 * Math.sin((t / 4900) * 2 * Math.PI);
          const y = talkAmt * slowEnv * 1.6 + nod * 3.2;
          sw.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${r.toFixed(3)}deg)`;
        }
        if (t > nextBlink) {
          blinkUntil = t + 130;
          nextBlink = t + 2800 + Math.random() * 3200;
        }
        el.classList.toggle("blinking", t < blinkUntil && mouth === "");
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [charState, getLevel, getTone]);

  return (
    <div
      ref={wrap}
      className={`sprite state-${charState} ${acting ? "acting" : ""}`}
      style={{ aspectRatio: `${m.width} / ${m.height}` }}
      role="img"
      aria-label={`Mira：${emotion}，${charState}`}
    >
      <div ref={sway} className="sprite-sway">
        <div key={`n-${action === "nod" ? actionNonce : 0}`} className={`sprite-body ${action === "nod" && actionNonce ? "nod" : ""}`}>
          {m.sprites
            .filter((n) => !MOUTHS.some((k) => n.startsWith(`${k}_`)) && n !== "blink")
            .map((n) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={n} src={`/sprites/${n}.webp`} alt="" draggable={false} className={n === base ? "on" : ""} />
            ))}
          {MOUTHS.flatMap((k) =>
            m.sprites
              .filter((n) => n.startsWith(`${k}_`))
              .map((n) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={n}
                  src={`/sprites/${n}.webp`}
                  alt=""
                  draggable={false}
                  className={`mouth m-${k} ${talking && n === `${k}_${emotion}` ? "cur" : ""}`}
                />
              )),
          )}
          {canBlink && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/sprites/blink.webp" alt="" draggable={false} className="blink" />
          )}
          {acting === "act_camera" && <div className="cam-flash" />}
        </div>
      </div>
      {charState === "thinking" && (
        <div className="think-dom" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}
