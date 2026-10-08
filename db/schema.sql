CREATE TABLE IF NOT EXISTS ai_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_key TEXT,
  price_input_text REAL NOT NULL DEFAULT 0,
  price_input_audio REAL NOT NULL DEFAULT 0,
  price_output REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (provider, purpose, model_id)
);

CREATE TABLE IF NOT EXISTS ai_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  ai_model_id INTEGER REFERENCES ai_model (id),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model_id TEXT NOT NULL,
  session_id TEXT,
  turn_id INTEGER,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_text_tokens INTEGER NOT NULL DEFAULT 0,
  input_audio_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thought_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  error TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_call_log_created ON ai_call_log (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_session ON ai_call_log (session_id);
