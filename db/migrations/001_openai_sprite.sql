ALTER TABLE ai_model ADD COLUMN price_input_image REAL NOT NULL DEFAULT 0;
ALTER TABLE ai_call_log ADD COLUMN input_image_tokens INTEGER NOT NULL DEFAULT 0;

UPDATE ai_model SET price_input_image = price_input_text WHERE provider = 'gemini';

INSERT OR IGNORE INTO ai_model (provider, purpose, model_id, display_name, price_input_text, price_input_image, price_output, is_default) VALUES
('openai', 'sprite', 'gpt-image-2.5-sunburst', 'ChatGPT Images 2.5 Sunburst', 5.00, 8.00, 30.00, 1),
('openai', 'sprite', 'gpt-image-2.5-flare', 'ChatGPT Images 2.5 Flare', 5.00, 8.00, 30.00, 0);

UPDATE ai_model SET is_default = 0 WHERE provider = 'gemini' AND purpose = 'sprite';
