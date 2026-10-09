-- 对话主力从 gemini-2.5-flash（002 为延迟而降档）切回 gemini-3.7-flash。
-- 同上下文 A/B：2.5-flash 附和复读甚至整轮不合协议触发兜底句；3.7-flash 能接住对话。
-- 代价：首句约 1.5s → 2.3s（流式播放下可接受）。
UPDATE ai_model SET is_default = CASE model_id WHEN 'gemini-3.7-flash' THEN 1 ELSE 0 END
WHERE provider = 'gemini' AND purpose = 'text';
