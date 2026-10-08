INSERT OR IGNORE INTO ai_model (provider, purpose, model_id, display_name, price_input_text, price_input_audio, price_output, is_default) VALUES
('gemini', 'text', 'gemini-3.7-flash', 'Gemini 3.7 Flash', 0.75, 0.75, 3.75, 1),
('gemini', 'tts', 'gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 0.50, 0, 9.00, 1),
('gemini', 'image', 'gemini-3.1-flash-image-preview', 'Nano Banana 2', 0.50, 0, 60.00, 1),
('gemini', 'sprite', 'gemini-3-pro-image-preview', 'Nano Banana Pro', 2.00, 0, 120.00, 1),
('gemini', 'sprite', 'gemini-3.1-flash-image-preview', 'Nano Banana 2', 0.50, 0, 60.00, 0),
('gemini', 'text', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 0.30, 1.00, 2.50, 0),
('gemini', 'tts', 'gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', 0.50, 0, 10.00, 0),
('gemini', 'image', 'gemini-2.5-flash-image', 'Nano Banana', 0.30, 0, 30.00, 0),
('mock', 'text', 'mock', 'Mock', 0, 0, 0, 1),
('mock', 'tts', 'mock', 'Mock', 0, 0, 0, 1),
('mock', 'image', 'mock', 'Mock', 0, 0, 0, 1);
