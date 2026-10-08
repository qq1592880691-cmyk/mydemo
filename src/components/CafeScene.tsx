"use client";

import { useEffect, useRef } from "react";
import type { Weather } from "@/lib/protocol";

const DENSITY: Record<Weather, number> = { storm: 1, rain: 0.45, clear: 0 };

function RainCanvas({ weather }: { weather: Weather }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(DENSITY[weather]);
  target.current = DENSITY[weather];

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const drops = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random() * 0.8, l: 10 + Math.random() * 18 }));
    let density = target.current;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(50, t - last) / 16.7;
      last = t;
      density += (target.current - density) * 0.02;
      ctx.clearRect(0, 0, w, h);
      const n = Math.floor(drops.length * density);
      ctx.strokeStyle = "rgba(190,210,255,0.35)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = drops[i];
        d.y += (d.v * 0.022 * dt * (420 / Math.max(h, 1))) * 1.6;
        d.x -= 0.0016 * dt;
        if (d.y > 1.05) {
          d.y = -0.05;
          d.x = Math.random() * 1.1;
        }
        const x = d.x * w;
        const y = d.y * h;
        ctx.moveTo(x, y);
        ctx.lineTo(x - d.l * 0.22, y + d.l);
      }
      ctx.stroke();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="rain" aria-hidden />;
}

const BOKEH = Array.from({ length: 34 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 97.3 + n * 13.1) + 1) / 2);
  return { x: r(1) * 1000, y: 330 + r(2) * 260, rad: 8 + r(3) * 26, hue: [38, 28, 200, 330, 48][i % 5], a: 0.25 + r(4) * 0.45 };
});

const BUILDINGS = [
  [0, 300, 120], [110, 250, 90], [190, 330, 140], [320, 210, 80], [390, 280, 120],
  [500, 230, 100], [590, 320, 110], [690, 260, 90], [770, 200, 120], [880, 290, 130],
];

export function WindowView({ weather }: { weather: Weather }) {
  const clear = weather === "clear";
  return (
    <div className={`window weather-${weather}`}>
      <svg className="window-svg" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id="skyStorm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#070b16" />
            <stop offset="1" stopColor="#1a2236" />
          </linearGradient>
          <linearGradient id="skyClear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#14213f" />
            <stop offset="0.7" stopColor="#3a4f7c" />
            <stop offset="1" stopColor="#6a6f8f" />
          </linearGradient>
          <radialGradient id="moonGlow">
            <stop offset="0" stopColor="#fff6dc" stopOpacity="0.9" />
            <stop offset="1" stopColor="#fff6dc" stopOpacity="0" />
          </radialGradient>
          <filter id="blur8">
            <feGaussianBlur stdDeviation="8" />
          </filter>
          <filter id="blur3">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        <rect width="1000" height="700" fill="url(#skyStorm)" />
        <rect width="1000" height="700" fill="url(#skyClear)" className="sky-clear" style={{ opacity: clear ? 1 : 0 }} />
        <g className="moon" style={{ opacity: clear ? 1 : 0 }}>
          <circle cx="780" cy="120" r="90" fill="url(#moonGlow)" />
          <circle cx="780" cy="120" r="34" fill="#fff4d6" />
        </g>
        <g filter="url(#blur3)" opacity="0.9">
          {BUILDINGS.map(([x, top, wd], i) => (
            <g key={i}>
              <rect x={x} y={top} width={wd} height={700 - top} fill="#0b0f1c" />
              {Array.from({ length: 10 }, (_, k) => (
                <rect
                  key={k}
                  x={x + 12 + (k % 3) * (wd / 3.3)}
                  y={top + 20 + Math.floor(k / 3) * 38}
                  width="12"
                  height="16"
                  fill={(i + k) % 4 === 0 ? "#ffcf7a" : "#26304a"}
                  opacity={(i + k) % 4 === 0 ? 0.8 : 0.6}
                />
              ))}
            </g>
          ))}
        </g>
        <g filter="url(#blur8)" className="bokeh" style={{ opacity: clear ? 1 : 0.75 }}>
          {BOKEH.map((b, i) => (
            <circle key={i} cx={b.x} cy={b.y} r={b.rad} fill={`hsl(${b.hue} 90% 65%)`} opacity={b.a} />
          ))}
        </g>
        <rect y="590" width="1000" height="110" fill="#0c1220" opacity="0.85" />
        <g filter="url(#blur8)" opacity="0.5">
          {BOKEH.slice(0, 12).map((b, i) => (
            <rect key={i} x={b.x - 4} y={600} width="8" height={60 + b.rad * 2} fill={`hsl(${b.hue} 90% 65%)`} />
          ))}
        </g>
      </svg>
      <RainCanvas weather={weather} />
      <div className="glass-drops" />
      <div className="window-frame" />
    </div>
  );
}

export function Lamps() {
  return (
    <div className="lamps" aria-hidden>
      <div className="lamp l1" />
      <div className="lamp l2" />
    </div>
  );
}

export function Table() {
  return (
    <div className="table" aria-hidden>
      <div className="cup">
        <div className="steam s1" />
        <div className="steam s2" />
      </div>
    </div>
  );
}
