-- gemini-3.8-flash-tts を Interactions API（speech_metadata.style）で呼ぶようにしたので既定に戻す
UPDATE ai_model SET voice = 'Achernar' WHERE provider = 'gemini' AND purpose = 'tts';
UPDATE ai_model SET is_default = 0 WHERE purpose = 'tts' AND provider <> 'mock';
UPDATE ai_model SET is_default = 1 WHERE provider = 'gemini' AND purpose = 'tts' AND model_id = 'gemini-3.8-flash-tts';
