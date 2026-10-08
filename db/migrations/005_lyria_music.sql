-- 配乐生成（scripts/gen-bgm.ts）。Lyria は usage を返さないため単価は 0 で記録だけ残す
INSERT OR IGNORE INTO ai_model (provider, purpose, model_id, display_name, is_default) VALUES
('gemini', 'music', 'lyria-3.5', 'Lyria 3.5', 1);
