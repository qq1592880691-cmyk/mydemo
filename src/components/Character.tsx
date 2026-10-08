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
};
const ACTION_MS = 3000;

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

function SpriteMira({ m, emotion, action, actionNonce, charState, getLevel }: Props & { m: Manifest }) {
  const wrap = useRef<HTMLDivElement>(null);
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
  const talk = !acting && has(`talk_${emotion}`) ? `talk_${emotion}` : null;
  const canBlink = !acting && emotion === "neutral" && has("blink");

  // 口パクと瞬きは DOM クラスの切替だけで行い、React の再描画を避ける
  useEffect(() => {
    let raf = 0;
    let open = false;
    let nextBlink = performance.now() + 2500;
    let blinkUntil = 0;
    const loop = (t: number) => {
      const el = wrap.current;
      if (el) {
        const lv = charState === "speaking" ? getLevel() : 0;
        if (!open && lv > 0.22) open = true;
        else if (open && lv < 0.12) open = false;
        el.classList.toggle("mouth", open);
        if (t > nextBlink) {
          blinkUntil = t + 130;
          nextBlink = t + 2800 + Math.random() * 3200;
        }
        el.classList.toggle("blinking", t < blinkUntil && !open);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [charState, getLevel]);

  return (
    <div
      ref={wrap}
      className={`sprite state-${charState} ${acting ? "acting" : ""}`}
      style={{ aspectRatio: `${m.width} / ${m.height}` }}
      role="img"
      aria-label={`Mira：${emotion}，${charState}`}
    >
      <div key={`n-${action === "nod" ? actionNonce : 0}`} className={`sprite-body ${action === "nod" && actionNonce ? "nod" : ""}`}>
        {m.sprites
          .filter((n) => !n.startsWith("talk_") && n !== "blink")
          .map((n) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={n} src={`/sprites/${n}.webp`} alt="" draggable={false} className={n === base ? "on" : ""} />
          ))}
        {m.sprites
          .filter((n) => n.startsWith("talk_"))
          .map((n) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={n} src={`/sprites/${n}.webp`} alt="" draggable={false} className={`talk ${n === talk ? "cur" : ""}`} />
          ))}
        {canBlink && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/sprites/blink.webp" alt="" draggable={false} className="blink" />
        )}
        {acting === "act_camera" && <div className="cam-flash" />}
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
