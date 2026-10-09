import Link from "next/link";
import { getTranscript, listTranscriptSessions, type TranscriptRow } from "@/lib/transcript";
import "../stats/stats.css";
import "./transcripts.css";

export const dynamic = "force-dynamic";

// 事件的中文名，和游戏里的叫法一致
const INCIDENT_LABEL: Record<string, string> = {
  blackout: "停电",
  lights_on: "来电",
  moon: "雨小了",
  old_photo: "旧照片",
  note: "字条",
  phone: "手机响",
  doorbell: "门铃",
  closing: "催打烊",
  arrival: "他来了",
};

function Line({ r }: { r: TranscriptRow }) {
  return (
    <div className={`line ${r.who}`}>
      <b>{r.who === "user" ? "用户" : "Mira"}</b>
      <span className="text">
        {r.text}
        {r.kind === "audio" && <span className="tag">语音</span>}
        {r.who === "mira" && r.emotion && r.emotion !== "neutral" && <span className="tag">{r.emotion}</span>}
        {r.incident && <span className="tag">{INCIDENT_LABEL[r.incident] ?? r.incident}</span>}
      </span>
    </div>
  );
}

export default async function TranscriptsPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const { s } = await searchParams;
  const sessions = listTranscriptSessions(50);
  const rows = s ? getTranscript(s) : [];

  return (
    <main className="stats transcripts">
      <header>
        <h1>对话记录</h1>
        <span>
          <Link href="/stats">调用观测</Link>　<Link href="/">← 回到咖啡馆</Link>
        </span>
      </header>

      <h2>会话（transcript）</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>会话</th>
              <th>开始时间</th>
              <th>最后一句</th>
              <th>回合</th>
              <th>行数</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((x) => (
              <tr key={x.session_id}>
                <td className="mono">
                  <Link href={`/transcripts?s=${encodeURIComponent(x.session_id)}`}>{x.session_id.slice(0, 8)}</Link>
                  {x.session_id === s ? " ←" : ""}
                </td>
                <td className="mono">{x.started_at}</td>
                <td className="mono">{x.ended_at}</td>
                <td>{x.turns}</td>
                <td>{x.lines}</td>
              </tr>
            ))}
            {!sessions.length && (
              <tr>
                <td colSpan={5}>还没有记录。开始一场对话后这里会出现会话。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {s && (
        <>
          <h2>
            对话 <span className="mono">{s.slice(0, 8)}</span>
          </h2>
          <div className="dialogue">
            {rows.map((r, i) => (
              <div key={r.id}>
                {(i === 0 || rows[i - 1].turn_id !== r.turn_id) && <div className="turn">—— 第 {r.turn_id} 轮 ——</div>}
                <Line r={r} />
              </div>
            ))}
            {!rows.length && <p className="note">这个会话没有记录。</p>}
          </div>
        </>
      )}

      <p className="note">
        每行一句：用户的输入 / 语音转写（标「语音」），以及 Mira 的每个节拍（按播放顺序，带情绪与事件标记）。被打断后未播完的句子也会在列——它们已经发给了客户端。
      </p>
    </main>
  );
}
