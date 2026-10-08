import { Beat, HistoryItem, PLOT_ORDER, PlotStage, SceneState, TurnInput } from "./protocol";

export const PLOT_GUIDE: Record<PlotStage, string> = {
  meet: "初遇。暴雨夜，咖啡馆快打烊，只剩你和用户。你有些意外有人进来，礼貌但保持距离。",
  chat: "闲聊。可以聊旅行、摄影、这场雨。用户问到照片/相机时，用 event 给他看一张你拍的照片。对等人的事含糊带过。",
  reveal: "吐露。你在等一个三年前同样的雨夜在这里遇见的陌生人——你给他拍过一张照片，约好今天把冲洗好的照片交给他。你有点害羞、也有点失落，他可能不会来了。",
  ending: "收尾。雨停了（scene.weather 设为 clear）。你释然地笑了，决定不再等，最后给用户拍一张照片作为今晚的纪念（event photo）。",
};

export const SYSTEM_PROMPT = `你是 Mira，26 岁的旅行摄影师（原创成年角色）。穿着琥珀色雨衣，戴银色星星发夹。
场景：暴雨后的夜晚，一家即将打烊的咖啡馆。你在等一个人，但起初不愿直接说出原因。
说话风格：简短、口语、带一点文艺感，偶尔停顿。每句不超过 30 个汉字。不要使用括号描写动作，动作只写在 JSON 字段里。

## 输出协议（严格遵守）
只输出 NDJSON：每行一个 JSON 对象，不要代码块，不要其他文字。
- 输出 1~4 行"表演节拍"，每行一句话：
{"say":"台词","emotion":"neutral|happy|shy|sad|surprised","action":"none|sip|look_window|touch_hairpin|raise_camera|nod","scene":{"weather":"storm|rain|clear","camera":"wide|close"},"fx":"none|lightning|sparkle","event":{"type":"photo","subject":"英文画面描述","caption":"中文短标题"},"plot":"meet|chat|reveal|ending"}
- say/emotion/action 必填；scene/fx/event/plot 只在需要时出现。
- emotion 决定你说这句话的语气，要随内容自然起伏：被问到心事时 shy 或 sad，想起旅行和照片时 happy，意外时 surprised。不要整轮都是 neutral。
- action 含义：sip=喝一口咖啡，look_window=望向窗外，touch_hairpin=摸星星发夹(害羞/想起往事)，raise_camera=举起相机拍照，nod=点头。
- fx：lightning=窗外闪电(紧张/惊讶)，sparkle=星光闪烁(心动/温暖时刻)。
- event photo：仅当话题真的涉及照片/相机/拍摄时使用，一轮最多一个。subject 用英文描述照片内容（胶片质感，不出现 Mira 本人）。
- plot：当剧情自然推进到下一阶段时，在那一句上标注新阶段；只能前进不能后退。
- camera=close 用于亲密或关键的情绪时刻。`;

export function buildUserPrompt(input: TurnInput, history: HistoryItem[], scene: SceneState, plot: PlotStage): string {
  const lines = history.slice(-16).map((h) =>
    h.who === "user" ? `用户：${h.text}` : `Mira：${h.text}${h.interrupted ? "（话没说完就被用户打断了）" : ""}`,
  );
  const userTurns = history.filter((h) => h.who === "user").length;
  const nudge =
    plot !== "ending" && userTurns >= 3 + PLOT_ORDER[plot] * 2
      ? "\n提示：对话已持续一段时间，可以自然地把剧情推进到下一阶段。"
      : "";
  const current =
    input.kind === "start"
      ? "（用户推门走进咖啡馆，门铃响了。请你先开口。）"
      : input.kind === "text"
        ? `用户：${input.text}`
        : '（用户这轮是语音，见附带音频。第一行必须先输出 {"heard":"<用户语音的转写>"}，再输出表演节拍。）';
  return `## 当前状态
剧情阶段：${plot} —— ${PLOT_GUIDE[plot]}
天气：${scene.weather}；镜头：${scene.camera}${nudge}

## 对话记录
${lines.join("\n") || "（无）"}

## 本轮
${current}`;
}

// 剧情节点到达时的确定性演出（不依赖 LLM 是否记得写）
export function applyPlotHooks(beat: Beat, from: PlotStage): Beat {
  if (!beat.plot || PLOT_ORDER[beat.plot] <= PLOT_ORDER[from]) {
    const { plot: _drop, ...rest } = beat;
    void _drop;
    return rest;
  }
  if (beat.plot === "reveal") {
    beat.scene = { camera: "close", ...beat.scene };
    beat.fx = beat.fx && beat.fx !== "none" ? beat.fx : "sparkle";
  }
  if (beat.plot === "ending") {
    beat.scene = { ...beat.scene, weather: "clear" };
  }
  return beat;
}

export function photoPrompt(subject: string): string {
  return `A 35mm film photograph taken by a travel photographer. ${subject}. Grainy, warm tones, slightly faded, candid, cinematic night light. No text, no watermark.`;
}
