ALTER TABLE ai_model ADD COLUMN voice TEXT;

UPDATE ai_model SET voice = 'Aoede' WHERE provider = 'gemini' AND purpose = 'tts';

INSERT OR IGNORE INTO ai_model (provider, purpose, model_id, display_name, voice, price_input_text, price_output, is_default) VALUES
('openai', 'tts', 'gpt-4o-mini-tts', 'GPT-4o mini TTS', 'shimmer', 0.60, 12.00, 1);

UPDATE ai_model SET is_default = 0 WHERE provider = 'gemini' AND purpose = 'tts';
