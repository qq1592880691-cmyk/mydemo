import { getDb } from "./db";

// 1 行 = 1 句（ユーザーの入力・音声転写、あるいは Mira の 1 節拍）。
// ai_call_log は呼び出し完了順の計測ログで会話が読めないため、こちらは再生順で残す

export interface Utterance {
  sessionId?: string;
  turnId: number;
  seq: number; // ユーザー入力は -1、Mira の句は節拍の seq（0 起）
  who: "user" | "mira";
  kind: string; // user: start|text|audio / mira: beat
  text: string;
  emotion?: string;
  incident?: string;
}

export interface TranscriptRow {
  id: number;
  created_at: string;
  session_id: string;
  turn_id: number;
  seq: number;
  who: "user" | "mira";
  kind: string;
  text: string;
  emotion: string | null;
  incident: string | null;
}

export interface TranscriptSession {
  session_id: string;
  started_at: string;
  ended_at: string;
  turns: number;
  lines: number;
}

// 記録の失敗で会話を止めない（ai_call_log と同じ方針）
export function logUtterance(u: Utterance) {
  if (!u.sessionId || !u.text) return;
  try {
    getDb()
      .prepare("INSERT INTO transcript (session_id, turn_id, seq, who, kind, text, emotion, incident) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(u.sessionId, u.turnId, u.seq, u.who, u.kind, u.text, u.emotion ?? null, u.incident ?? null);
  } catch (e) {
    console.error("transcript log failed", e);
  }
}

export function getTranscript(sessionId: string): TranscriptRow[] {
  return getDb().prepare("SELECT * FROM transcript WHERE session_id = ? ORDER BY turn_id, seq, id").all(sessionId) as TranscriptRow[];
}

export function listTranscriptSessions(limit = 30): TranscriptSession[] {
  return getDb()
    .prepare(
      `SELECT session_id, MIN(created_at) started_at, MAX(created_at) ended_at, MAX(turn_id) turns, COUNT(*) lines
       FROM transcript GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ?`,
    )
    .all(limit) as TranscriptSession[];
}
