-- 游戏内拍照（purpose=image）改用更快的生图模型 Nano Banana（gemini-2.5-flash-image）。
-- 实测约 8s/张；旧默认 Nano Banana 2（gemini-3.1-flash-image-preview）15 次平均 11.5s。
-- 单价也更低（输出 $30 vs $60 / 1M token）。离线立绘（sprite）不变，仍用画质优先的模型。
UPDATE ai_model SET is_default = CASE model_id WHEN 'gemini-2.5-flash-image' THEN 1 ELSE 0 END
WHERE provider = 'gemini' AND purpose = 'image';
