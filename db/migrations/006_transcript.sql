-- 可读的对话记录：每行一句话（用户输入 / 语音转写 / Mira 的一个节拍），按回合与句序排列。
-- ai_call_log 是按调用完成顺序写入的计费日志，拼不出对话；这张表按播放顺序落库。
CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  session_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  -- 回合内顺序：用户输入为 -1，Mira 的句子用节拍 seq（0 起）
  seq INTEGER NOT NULL,
  who TEXT NOT NULL, -- 'user' | 'mira'
  kind TEXT NOT NULL, -- user: start|text|audio（audio 的 text 为转写）；mira: beat
  text TEXT NOT NULL,
  emotion TEXT,
  incident TEXT
);

CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript (session_id, turn_id, seq, id);
