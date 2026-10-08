"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TurnController, type Snapshot } from "@/client/turnController";
import { BrowserAudio, MicRecorder, fetchImage, sseTransport } from "@/client/browserDeps";
import type { CharState, FailMode } from "@/lib/protocol";
import Character from "./Character";
import { Lamps, Table, WindowView } from "./CafeScene";

const STATE_LABEL: Record<CharState, string> = { idle: "待机", listening: "倾听中", thinking: "思考中", speaking: "说话中" };

interface Runtime {
  audio: BrowserAudio;
  rec: MicRecorder;
  ctrl: TurnController;
}

function createRuntime(): Runtime {
  const audio = new BrowserAudio();
  const rec = new MicRecorder(() => audio.ctx);
  const ctrl: TurnController = new TurnController({
    transport: sseTransport,
    audio,
    image: (subject, signal) => fetchImage(subject, signal, { forceMock: ctrl.forceMock, fail: ctrl.fail, sessionId: ctrl.sessionId }),
  });
  return { audio, rec, ctrl };
}

export default function Experience() {
  const rt = useRef<Runtime | null>(null);
  rt.current ??= createRuntime();
  const { audio, rec, ctrl } = rt.current;
  const s = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, ctrl.getSnapshot);

  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [fail, setFail] = useState<FailMode | "">("");
  const [mock, setMock] = useState(false);
  const pressing = useRef(false);
  const micBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setDebug(q.has("debug"));
    setMock(q.get("mock") === "1");
    setFail((q.get("fail") as FailMode) || "");
  }, []);
  useEffect(() => {
    ctrl.forceMock = mock;
    ctrl.fail = fail || undefined;
  }, [ctrl, mock, fail]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(t);
  }, [hint]);

  // マイク入力レベルをボタンの波紋へ
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      micBtn.current?.style.setProperty("--lv", rec.level.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [rec]);

  const getLevel = useCallback(() => audio.level(), [audio]);

  const pressStart = useCallback(async () => {
    if (pressing.current) return;
    pressing.current = true;
    audio.unlock();
    ctrl.beginListening();
    try {
      await rec.start();
    } catch {
      pressing.current = false;
      ctrl.cancelListening();
      setHint("无法使用麦克风，请检查权限，或改用文字输入");
      return;
    }
    // 権限ダイアログ中に指を離した場合
    if (!pressing.current) {
      rec.stop();
      ctrl.cancelListening();
    }
  }, [audio, ctrl, rec]);

  const pressEnd = useCallback(() => {
    if (!pressing.current) return;
    pressing.current = false;
    const r = rec.stop();
    if (!r || r.ms < 400) {
      ctrl.cancelListening();
      setHint("按住说话，松开发送");
      return;
    }
    void ctrl.sendAudio(r.b64, r.mime);
  }, [ctrl, rec]);

  // デスクトップはスペース長押しでも話せる
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || !ctrl.getSnapshot().started) return;
      if ((e.target as HTMLElement).closest("input,textarea,select,button")) return;
      e.preventDefault();
      void pressStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") pressEnd();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [ctrl, pressStart, pressEnd]);

  const submitText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    audio.unlock();
    void ctrl.sendText(text);
    setText("");
  };

  const enter = () => {
    audio.unlock();
    void ctrl.start();
  };

  return (
    <main className={`stage cam-${s.scene.camera} weather-${s.scene.weather} cs-${s.charState}`}>
      <div className="camera">
        <div className="wall" />
        <WindowView weather={s.scene.weather} />
        <Lamps />
        <div className="mira-wrap">
          <div className="listen-ring" />
          <Character emotion={s.emotion} action={s.action} actionNonce={s.actionNonce} charState={s.charState} getLevel={getLevel} />
          {s.fx === "sparkle" && (
            <div key={s.fxNonce} className="fx-sparkle" aria-hidden>
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} style={{ "--i": i } as React.CSSProperties}>✦</span>
              ))}
            </div>
          )}
        </div>
        <Table />
      </div>
      {s.fx === "lightning" && <div key={s.fxNonce} className="fx-lightning" aria-hidden />}
      <div className="vignette" />

      <header className="hud">
        <div className={`status status-${s.charState}`} aria-live="polite">
          <i />
          <span>Mira · {STATE_LABEL[s.charState]}</span>
        </div>
        <div className="hud-right">
          {s.provider && <span className={`badge badge-${s.provider}`}>{s.provider.toUpperCase()}</span>}
          <button className="icon-btn" onClick={() => setDebug((d) => !d)} aria-label="调试面板">
            ⚙
          </button>
        </div>
      </header>

      {s.error && (
        <div className="toast toast-error" role="alert">
          <span>{s.error.message}</span>
          <button onClick={() => void ctrl.retry()}>重试</button>
          <button className="x" onClick={() => ctrl.clearError()} aria-label="关闭">
            ×
          </button>
        </div>
      )}
      {!s.error && s.notice && <div className="toast toast-notice">{s.notice}</div>}
      {hint && <div className="toast toast-hint">{hint}</div>}

      <PhotoCard snap={s} ctrl={ctrl} />

      <section className="dock">
        <div className="subtitle" aria-live="polite">
          {s.subtitle && (
            <p key={`${s.subtitle.turnId}-${s.subtitle.text}`} className={`line who-${s.subtitle.who}`}>
              {s.subtitle.who === "user" ? <em>你：</em> : <b>Mira</b>}
              {s.subtitle.text}
            </p>
          )}
        </div>
        <form className="controls" onSubmit={submitText}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={s.charState === "speaking" ? "输入文字会打断 Mira…" : "和 Mira 说点什么…"}
            enterKeyHint="send"
            maxLength={200}
            disabled={!s.started}
          />
          <button type="submit" className="send" disabled={!s.started || !text.trim()} aria-label="发送">
            ↑
          </button>
          <button
            type="button"
            ref={micBtn}
            className={`mic ${s.charState === "listening" ? "on" : ""}`}
            disabled={!s.started}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              void pressStart();
            }}
            onPointerUp={pressEnd}
            onPointerCancel={pressEnd}
            onContextMenu={(e) => e.preventDefault()}
            aria-label="按住说话"
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" fill="currentColor" />
            </svg>
          </button>
        </form>
        <p className="mic-tip">{s.charState === "speaking" ? "按住麦克风即可打断她" : s.charState === "listening" ? "松开发送" : "按住麦克风说话（桌面可长按空格）"}</p>
      </section>

      {debug && <DebugPanel snap={s} audio={audio} fail={fail} setFail={setFail} mock={mock} setMock={setMock} onClose={() => setDebug(false)} />}

      {!s.started && (
        <div className="intro">
          <div className="intro-card">
            <p className="intro-kicker">暴雨后的夜晚 · 23:40</p>
            <h1>打烊前的咖啡馆</h1>
            <p>雨还没停。店里只剩一位穿琥珀色雨衣的女孩，银色星星发夹在灯下一闪一闪。她似乎在等谁。</p>
            <button className="enter" onClick={enter}>
              推门进去
            </button>
            <label className="intro-mock">
              <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} /> Mock 模式（无需 API 密钥）
            </label>
          </div>
        </div>
      )}
    </main>
  );
}

function PhotoCard({ snap, ctrl }: { snap: Snapshot; ctrl: TurnController }) {
  const p = snap.photo;
  if (!p) return null;
  return (
    <figure key={p.id} className={`photo photo-${p.status}`} onClick={() => p.status === "ready" && ctrl.dismissPhoto()}>
      <div className="photo-img">
        {p.status === "ready" && p.url && <img src={p.url} alt={p.caption || p.subject} />}
        {p.status === "developing" && <div className="developing">显影中…</div>}
        {p.status === "failed" && (
          <div className="failed">
            <span>照片受潮了，没洗出来</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                ctrl.retryPhoto();
              }}
            >
              再洗一次
            </button>
          </div>
        )}
      </div>
      <figcaption>
        {p.caption || "Mira 的照片"}
        <button
          className="x"
          onClick={(e) => {
            e.stopPropagation();
            ctrl.dismissPhoto();
          }}
          aria-label="收起照片"
        >
          ×
        </button>
      </figcaption>
    </figure>
  );
}

function DebugPanel({
  snap,
  audio,
  fail,
  setFail,
  mock,
  setMock,
  onClose,
}: {
  snap: Snapshot;
  audio: BrowserAudio;
  fail: FailMode | "";
  setFail: (f: FailMode | "") => void;
  mock: boolean;
  setMock: (m: boolean) => void;
  onClose: () => void;
}) {
  const t0 = snap.log[0]?.t ?? 0;
  return (
    <aside className="debug">
      <div className="debug-head">
        <b>观测面板</b>
        <a href="/stats" target="_blank" rel="noreferrer" className="stats-link">
          调用记录 / 费用 ↗
        </a>
        <button className="x" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="debug-row">
        <label>
          <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} /> Mock
        </label>
        <label>
          故障注入
          <select value={fail} onChange={(e) => setFail(e.target.value as FailMode | "")}>
            <option value="">无</option>
            <option value="tts">TTS 失败</option>
            <option value="llm_timeout">模型超时</option>
            <option value="drop">回复中途断线</option>
            <option value="image">生图失败</option>
          </select>
        </label>
      </div>
      <dl className="metrics">
        <dt>turn</dt>
        <dd>#{snap.turnId}</dd>
        <dt>剧情</dt>
        <dd>{snap.plot}</dd>
        <dt>语音输出</dt>
        <dd>{audio.mode}</dd>
        {Object.entries(snap.metrics).map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v} ms</dd>
          </span>
        ))}
      </dl>
      <ol className="log">
        {[...snap.log].reverse().map((l, i) => (
          <li key={i} className={`log-${l.kind}`}>
            <time>{((l.t - t0) / 1000).toFixed(2)}s</time> <span>#{l.turnId}</span> <b>{l.kind}</b> {l.detail}
          </li>
        ))}
      </ol>
    </aside>
  );
}
