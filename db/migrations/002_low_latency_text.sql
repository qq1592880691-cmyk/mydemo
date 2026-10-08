INSERT OR IGNORE INTO ai_model (provider, purpose, model_id, display_name, price_input_text, price_input_audio, price_input_image, price_output, is_default) VALUES
('gemini', 'text', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 1.50, 1.50, 1.50, 9.00, 0);

UPDATE ai_model SET is_default = CASE model_id WHEN 'gemini-2.5-flash' THEN 1 ELSE 0 END WHERE provider = 'gemini' AND purpose = 'text';
