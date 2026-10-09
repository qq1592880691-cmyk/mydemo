import Link from "next/link";
import { getDb } from "@/lib/db";
import type { ModelRow } from "@/lib/aiRegistry";
import "./stats.css";

export const dynamic = "force-dynamic";

interface Summary {
  provider: string;
  purpose: string;
  model_id: string;
  calls: number;
  errors: number;
  aborted: number;
  avg_ms: number;
  p_in: number;
  p_audio: number;
  p_out: number;
  cost: number;
}

interface CallRow {
  id: number;
  created_at: string;
  provider: string;
  purpose: string;
  model_id: string;
  session_id: string | null;
  turn_id: number | null;
  status: string;
  latency_ms: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  cost: number;
  error: string | null;
  detail: string | null;
}

// 画面には鍵の末尾4桁だけ出す
function keySource(row: ModelRow) {
  if (row.provider === "mock") return "—";
  if (row.api_key) return `表内 …${row.api_key.slice(-4)}`;
  return process.env.GEMINI_API_KEY ? `.env …${process.env.GEMINI_API_KEY.slice(-4)}` : "未配置";
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 4)}`;

export default function StatsPage() {
  const db = getDb();
  const models = db.prepare("SELECT * FROM ai_model ORDER BY provider, purpose, is_default DESC, id").all() as ModelRow[];
  const summary = db
    .prepare(
      `SELECT provider, purpose, model_id, COUNT(*) calls,
        SUM(status IN ('error','timeout')) errors, SUM(status = 'aborted') aborted,
        ROUND(AVG(latency_ms)) avg_ms, SUM(input_text_tokens) p_in, SUM(input_audio_tokens) p_audio,
        SUM(output_tokens + thought_tokens) p_out, SUM(cost) cost
       FROM ai_call_log GROUP BY provider, purpose, model_id ORDER BY cost DESC, calls DESC`,
    )
    .all() as Summary[];
  const total = db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(cost),0) cost, COUNT(DISTINCT session_id) sessions FROM ai_call_log").get() as {
    calls: number;
    cost: number;
    sessions: number;
  };
  const recent = db.prepare("SELECT * FROM ai_call_log ORDER BY id DESC LIMIT 100").all() as CallRow[];

  return (
    <main className="stats">
      <header>
        <h1>AI 调用观测</h1>
        <span>
          <Link href="/transcripts">对话记录</Link>　<Link href="/">← 回到咖啡馆</Link>
        </span>
      </header>

      <section className="cards">
        <div>
          <b>{total.calls}</b>
          <span>调用次数</span>
        </div>
        <div>
          <b>{usd(total.cost)}</b>
          <span>累计费用</span>
        </div>
        <div>
          <b>{total.sessions}</b>
          <span>会话数</span>
        </div>
      </section>

      <h2>模型 Master（ai_model）</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Provider</th>
              <th>用途</th>
              <th>模型</th>
              <th>名称</th>
              <th>密钥</th>
              <th>输入文本 /1M</th>
              <th>输入音频 /1M</th>
              <th>输出 /1M</th>
              <th>默认</th>
              <th>启用</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className={m.enabled ? "" : "off"}>
                <td>{m.id}</td>
                <td>{m.provider}</td>
                <td>{m.purpose}</td>
                <td className="mono">{m.model_id}</td>
                <td>{m.display_name}</td>
                <td className="mono">{keySource(m)}</td>
                <td>{m.price_input_text}</td>
                <td>{m.price_input_audio}</td>
                <td>{m.price_output}</td>
                <td>{m.is_default ? "★" : ""}</td>
                <td>{m.enabled ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>按模型汇总</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>用途</th>
              <th>模型</th>
              <th>调用</th>
              <th>失败</th>
              <th>取消</th>
              <th>平均耗时</th>
              <th>输入 tok</th>
              <th>音频 tok</th>
              <th>输出 tok</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={`${s.provider}-${s.purpose}-${s.model_id}`}>
                <td>{s.provider}</td>
                <td>{s.purpose}</td>
                <td className="mono">{s.model_id}</td>
                <td>{s.calls}</td>
                <td className={s.errors ? "bad" : ""}>{s.errors}</td>
                <td>{s.aborted}</td>
                <td>{s.avg_ms} ms</td>
                <td>{s.p_in}</td>
                <td>{s.p_audio}</td>
                <td>{s.p_out}</td>
                <td>{usd(s.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>最近 100 次调用（ai_call_log）</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>用途</th>
              <th>模型</th>
              <th>会话/回合</th>
              <th>状态</th>
              <th>耗时</th>
              <th>tok 入/音/出/思</th>
              <th>费用</th>
              <th>内容 / 错误</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td className="mono">{r.created_at.slice(5)}</td>
                <td>{r.purpose}</td>
                <td className="mono">{r.model_id}</td>
                <td className="mono">
                  {r.session_id?.slice(0, 8) ?? "—"}/{r.turn_id ?? "—"}
                </td>
                <td className={`st st-${r.status}`}>{r.status}</td>
                <td>{r.latency_ms} ms</td>
                <td className="mono">
                  {r.input_text_tokens}/{r.input_audio_tokens}/{r.output_tokens}/{r.thought_tokens}
                </td>
                <td>{usd(r.cost)}</td>
                <td className="detail">{r.error ?? r.detail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">价格单位为每 100 万 token（USD），取自写入时的公开价，请以官方为准；修改 ai_model 表后立即生效，无需重启。</p>
    </main>
  );
}
