"use client";

import { useEffect, useRef } from "react";
import type { Action, CharState, Emotion } from "@/lib/protocol";

interface Props {
  emotion: Emotion;
  action: Action;
  actionNonce: number;
  charState: CharState;
  getLevel: () => number;
}

// 表情ごとの目・眉・口・頬の形。差分はすべてここで定義する
const FACE: Record<Emotion, { eye: "open" | "smile" | "half" | "wide"; brow: [number, number]; browY: number; mouth: string; blush: number }> = {
  neutral: { eye: "open", brow: [-4, 4], browY: 0, mouth: "M-11 0 Q0 4 11 0", blush: 0.25 },
  happy: { eye: "smile", brow: [-8, 8], browY: -4, mouth: "M-14 -2 Q0 12 14 -2 Q0 5 -14 -2Z", blush: 0.55 },
  shy: { eye: "half", brow: [6, -6], browY: 1, mouth: "M-8 1 Q0 5 8 1", blush: 0.9 },
  sad: { eye: "half", brow: [14, -14], browY: 2, mouth: "M-10 4 Q0 -3 10 4", blush: 0.2 },
  surprised: { eye: "wide", brow: [-2, 2], browY: -10, mouth: "M-6 0 a6 7 0 1 0 12 0 a6 7 0 1 0 -12 0", blush: 0.3 },
};

function Eye({ x, kind, flip }: { x: number; kind: (typeof FACE)[Emotion]["eye"]; flip: boolean }) {
  const s = flip ? -1 : 1;
  if (kind === "smile") {
    return (
      <g transform={`translate(${x} 214)`}>
        <path d="M-14 3 Q0 -11 14 3" fill="none" stroke="#3a2420" strokeWidth="4" strokeLinecap="round" />
        <path d={`M${12 * s} -2 l${6 * s} -4`} stroke="#3a2420" strokeWidth="2.5" strokeLinecap="round" />
      </g>
    );
  }
  const ry = kind === "wide" ? 15 : 12;
  return (
    <g transform={`translate(${x} 214)`}>
      <g className="eye-blink">
        <ellipse rx="14" ry={ry} fill="#fffaf5" />
        <g className="gaze">
          <circle r={kind === "wide" ? 8 : 9.5} fill="url(#iris)" />
          <circle r={kind === "wide" ? 3.5 : 4.5} fill="#1c1012" />
          <circle cx="-3" cy="-4" r="3" fill="#fff" />
          <circle cx="3.5" cy="3" r="1.4" fill="#fff" opacity="0.8" />
        </g>
        {kind === "half" && <path d={`M-16 -${ry + 2} H16 V-1 Q0 3 -16 -1Z`} fill="#f3cdb8" />}
        <path
          d={kind === "half" ? "M-16 -1 Q0 3 16 -1" : `M-16 -2 Q-6 -${ry + 6} 14 -${ry - 2}`}
          fill="none"
          stroke="#2b1a1c"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path d={`M${13 * s} -${ry - 3} l${6 * s} -4`} stroke="#2b1a1c" strokeWidth="2.5" strokeLinecap="round" />
      </g>
    </g>
  );
}

export default function Mira({ emotion, action, actionNonce, charState, getLevel }: Props) {
  const root = useRef<SVGSVGElement>(null);
  const f = FACE[emotion];
  const speaking = charState === "speaking";

  // 音量を CSS 変数へ流して口パクさせる（React の再描画を通さない）
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const loop = () => {
      const target = speaking ? getLevel() : 0;
      smooth += (target - smooth) * 0.35;
      root.current?.style.setProperty("--m", smooth.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [speaking, getLevel]);

  return (
    <svg
      ref={root}
      className={`mira state-${charState} emo-${emotion}`}
      viewBox="0 0 400 560"
      role="img"
      aria-label={`Mira：${emotion}，${charState}`}
    >
      <defs>
        <radialGradient id="iris" cx="0.5" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#c48a4e" />
          <stop offset="0.6" stopColor="#7a4a2c" />
          <stop offset="1" stopColor="#3b2216" />
        </radialGradient>
        <linearGradient id="coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2b04a" />
          <stop offset="1" stopColor="#b56d18" />
        </linearGradient>
        <linearGradient id="coatShade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.25" />
          <stop offset="0.35" stopColor="#000" stopOpacity="0" />
          <stop offset="0.7" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="hair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a3238" />
          <stop offset="1" stopColor="#2a1c22" />
        </linearGradient>
        <radialGradient id="skin" cx="0.5" cy="0.4" r="0.65">
          <stop offset="0" stopColor="#fbe1d1" />
          <stop offset="1" stopColor="#efc4ad" />
        </radialGradient>
        <linearGradient id="silver" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#c9d2e0" />
          <stop offset="1" stopColor="#8a96ab" />
        </linearGradient>
        <radialGradient id="rimLight" cx="0.15" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffd2a8" stopOpacity="0.25" />
          <stop offset="1" stopColor="#ffd2a8" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g className="breath">
        {/* 後ろ髪 */}
        <g key={`hb-${actionNonce}`} className={`hw hw-${action}`}>
          <path d="M112 196 C104 120 160 92 204 94 C262 96 304 130 294 214 C292 262 300 296 286 320 L118 320 C104 292 114 252 112 196Z" fill="url(#hair)" />
        </g>

        {/* 体・レインコート */}
        <path d="M188 268 h26 v52 h-26z" fill="#eab9a1" />
        <path d="M60 560 C64 430 104 350 168 326 L200 344 L232 326 C298 350 338 430 342 560Z" fill="url(#coat)" />
        <path d="M60 560 C64 430 104 350 168 326 L200 344 L232 326 C298 350 338 430 342 560Z" fill="url(#coatShade)" />
        <path d="M168 326 L200 380 L232 326 L216 318 L200 344 L184 318Z" fill="#f4ede6" />
        <path d="M150 330 C170 318 186 316 200 344 C186 352 170 360 150 372 Z" fill="#d48a26" />
        <path d="M250 330 C230 318 214 316 200 344 C214 352 230 360 250 372 Z" fill="#c97f1f" />
        <path d="M200 380 V560" stroke="#8a5212" strokeWidth="3" />
        <g fill="#7a4610">
          <circle cx="212" cy="420" r="4" />
          <circle cx="212" cy="470" r="4" />
          <circle cx="212" cy="520" r="4" />
        </g>
        <path d="M100 430 C120 470 130 520 128 560" stroke="#a35f12" strokeWidth="3" fill="none" opacity="0.6" />
        <path d="M300 430 C280 470 270 520 272 560" stroke="#a35f12" strokeWidth="3" fill="none" opacity="0.6" />
        {/* カメラのストラップ */}
        <path d="M150 340 C170 420 230 460 300 470" stroke="#2c2a33" strokeWidth="7" fill="none" />

        {/* 頭 */}
        <g key={`hf-${actionNonce}`} className={`hw hw-${action}`}>
        <g className="head">
          <ellipse cx="200" cy="208" rx="74" ry="84" fill="url(#skin)" />
          <ellipse cx="200" cy="208" rx="74" ry="84" fill="url(#rimLight)" />
          <ellipse cx="160" cy="246" rx="15" ry="8" fill="#ff8f8f" opacity={f.blush} className="blush" />
          <ellipse cx="240" cy="246" rx="15" ry="8" fill="#ff8f8f" opacity={f.blush} className="blush" />

          <g key={emotion} className="face-swap">
            <Eye x={170} kind={f.eye} flip />
            <Eye x={230} kind={f.eye} flip={false} />
            <g transform={`translate(0 ${f.browY})`}>
              <path d="M150 182 Q166 174 184 180" transform={`rotate(${f.brow[0]} 167 179)`} stroke="#3b2628" strokeWidth="4.5" fill="none" strokeLinecap="round" />
              <path d="M216 180 Q234 174 250 182" transform={`rotate(${f.brow[1]} 233 179)`} stroke="#3b2628" strokeWidth="4.5" fill="none" strokeLinecap="round" />
            </g>
            <path d="M199 232 q-3 8 2 9" stroke="#d99b84" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <g transform="translate(200 262)" className="mouth-closed">
              <path d={f.mouth} fill={emotion === "happy" || emotion === "surprised" ? "#9c3f45" : "none"} stroke="#9c4a4a" strokeWidth="3" strokeLinecap="round" />
            </g>
          </g>
          <g transform="translate(200 262)">
            <g className="mouth-open">
              <ellipse rx="9" ry="8" fill="#7a2a33" />
              <ellipse cy="4" rx="5.5" ry="3" fill="#d96a72" />
            </g>
          </g>

          {/* 前髪 */}
          <path d="M124 196 C120 128 166 104 206 106 C254 108 288 140 280 204 C266 170 246 150 222 140 C226 158 218 170 210 176 C206 156 194 142 178 136 C176 160 158 176 140 182 C146 166 146 150 150 140 C136 154 128 174 124 196Z" fill="url(#hair)" />
          <path d="M126 200 C118 236 120 270 132 300 C120 280 112 240 118 200Z" fill="#2f2026" />
          <path d="M276 200 C286 236 284 270 270 300 C284 280 290 240 284 200Z" fill="#2f2026" />
          <path d="M168 118 C190 108 220 110 240 120" stroke="#6b4a52" strokeWidth="4" fill="none" opacity="0.7" strokeLinecap="round" />

          {/* 銀の星のヘアピン */}
          <g transform="translate(258 150) rotate(14)" className="hairpin">
            <path d="M-18 6 L22 -2" stroke="#9aa4b6" strokeWidth="3" strokeLinecap="round" />
            <path d="M0 -13 L3.8 -4.2 L13 -4 L5.8 2 L8.2 11 L0 5.8 L-8.2 11 L-5.8 2 L-13 -4 L-3.8 -4.2Z" fill="url(#silver)" stroke="#7d889c" strokeWidth="1" />
            <circle cx="-3" cy="-4" r="1.6" fill="#fff" />
          </g>
        </g>
        </g>

        {/* 動作レイヤー：actionNonce で同じ動作も再生し直す */}
        <g key={`${action}-${actionNonce}`} className={`act act-${action}`}>
          {action === "sip" && (
            <g className="prop prop-cup">
              <ellipse cx="200" cy="300" rx="34" ry="12" fill="#f1e6da" />
              <path d="M166 300 L172 352 Q200 362 228 352 L234 300Z" fill="#efe2d3" />
              <path d="M232 312 q20 4 14 22 q-6 10 -18 6" fill="none" stroke="#e5d5c4" strokeWidth="6" />
              <ellipse cx="200" cy="300" rx="28" ry="8" fill="#6b4126" />
              <ellipse cx="176" cy="340" rx="16" ry="12" fill="#efc4ad" />
              <ellipse cx="224" cy="344" rx="16" ry="12" fill="#efc4ad" />
            </g>
          )}
          {action === "touch_hairpin" && (
            <g className="prop prop-hand">
              <path d="M300 560 C300 420 300 300 276 186" stroke="url(#coat)" strokeWidth="44" fill="none" strokeLinecap="round" />
              <ellipse cx="270" cy="168" rx="17" ry="21" fill="#f3cdb8" transform="rotate(-20 270 168)" />
            </g>
          )}
          {action === "raise_camera" && (
            <g className="prop prop-camera">
              <rect x="150" y="186" width="120" height="74" rx="10" fill="#2c2a33" />
              <rect x="158" y="178" width="34" height="14" rx="3" fill="#3a3842" />
              <circle cx="222" cy="223" r="28" fill="#17161c" stroke="#55535f" strokeWidth="5" />
              <circle cx="222" cy="223" r="15" fill="#2d3550" />
              <circle cx="215" cy="216" r="5" fill="#8fa3d8" opacity="0.7" />
              <rect x="166" y="198" width="18" height="10" rx="2" fill="#c9d2e0" />
              <ellipse cx="146" cy="240" rx="16" ry="20" fill="#efc4ad" />
              <ellipse cx="276" cy="242" rx="16" ry="20" fill="#efc4ad" />
              <circle className="flash" cx="175" cy="203" r="10" fill="#fff" />
            </g>
          )}
        </g>
      </g>

      {charState === "thinking" && (
        <g className="think-bubble" transform="translate(300 96)">
          <circle cx="-24" cy="44" r="5" fill="#fff" opacity="0.7" />
          <circle cx="-10" cy="26" r="8" fill="#fff" opacity="0.8" />
          <rect x="-4" y="-22" width="72" height="38" rx="19" fill="#fff" opacity="0.92" />
          <circle className="d1" cx="16" cy="-3" r="5" fill="#8a7a86" />
          <circle className="d2" cx="32" cy="-3" r="5" fill="#8a7a86" />
          <circle className="d3" cx="48" cy="-3" r="5" fill="#8a7a86" />
        </g>
      )}
    </svg>
  );
}
