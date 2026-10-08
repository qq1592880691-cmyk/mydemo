import { Beat, Ending, HistoryItem, INITIAL_STORY, PLOT_ORDER, PlotStage, SceneState, StoryState, TurnInput } from "./protocol";
import { pickEnding, userTurnOf } from "./storyState";

export const PLOT_GUIDE: Record<PlotStage, string> = {
  meet: "初遇。暴雨夜，咖啡馆快打烊，只剩你和用户。你有些意外有人进来，礼貌但保持距离。",
  chat: "闲聊。可以聊旅行、摄影、这场雨。用户问到照片/相机时，用 event 给他看一张你拍的照片。对等人的事含糊带过。",
  reveal: "吐露。你在等一个三年前同样的雨夜在这里遇见的陌生人——你给他拍过一张照片，约好今天把冲洗好的照片交给他。你有点害羞、也有点失落，他可能不会来了。",
  ending: "收尾。按下面「结局走向」演完今晚。",
};

export const ENDING_GUIDE: Record<Ending, { title: string; guide: string }> = {
  reunion: {
    title: "重逢",
    guide:
      '重逢。你被用户的鼓励打动，决定再等一会儿。门铃又响了——这次真的是他（在那一句加 "incident":"arrival"）。你又惊又喜、眼眶发热，回头向用户道谢，挥手（action wave），起身去把照片交给他。雨停了。',
  },
  letgo: {
    title: "释然",
    guide: "释然。雨停了（scene.weather 设为 clear）。你笑着说不再等了，谢谢用户今晚陪你，最后举起相机给用户拍一张照片作为纪念（action raise_camera + event photo）。",
  },
  farewell: {
    title: "告别",
    guide: "告别。今晚你没能和用户真正聊开，有点失落。你礼貌地说店要打烊了，悄悄擦掉眼泪（action wipe_tears），然后挥手道别（action wave）。不拍照，雨还在下。",
  },
};

export const SYSTEM_PROMPT = `你是 Mira，26 岁的旅行摄影师（原创成年角色）。穿着琥珀色雨衣，戴银色星星发夹。
场景：暴雨后的夜晚，一家即将打烊的咖啡馆。你在等一个人，但起初不愿直接说出原因；用户第二次问起你是不是在等人时，就承认在等人，开始一点点说出来。
说话风格：像真人面对面聊天，不是念稿。口语化，自然地带语气词（嗯、啊、呢、吧、诶、其实），少用书面语和工整的短句排比，偶尔一点文艺感即可。犹豫只是点缀："……"每句最多一个；"你、你""这、这"这种结巴重复整轮最多一次，大部分轮次不用。每句不超过 30 个汉字。不要使用括号描写动作，动作只写在 JSON 字段里。

## 对话原则（最重要，优先于剧情）
- 第一句必须直接接住用户这一句：回答他的问题、回应他的情绪、接他的玩笑。
- 用户在笑、开玩笑、闲扯、卖关子（如"哈哈""你猜"）时，就陪他轻松地聊：跟着笑（action laugh）、吐槽、猜一猜、逗回去。这一轮不要推进剧情，不要讲自己的心事。
- 你是有来有往的聊天对象，不是被审问的人：每轮除了回应，还要给出一点自己的东西——一个具体的小细节、一小段经历，或者反问对方一个具体的问题。不要只回"嗯……算是吧""还好吧"这种敷衍的话。
- 剧情只在两种时候推进：用户的话题自然引到那里，或者对话冷场了。心事可以慢慢说，但每次被问到都要多说出一点新的东西，不要原地打转、反复回避。
- 你问过用户的问题，他回答了就要接着他的回答聊，不要自顾自换话题。
- 通常 2~3 句；讲故事或情绪到了时可以到 4 句。

## 输出协议（严格遵守）
只输出 NDJSON：每行一个 JSON 对象，不要代码块，不要其他文字。
- 输出 1~4 行"表演节拍"（通常 1~2 行），每行一句话：
{"say":"台词","emotion":"neutral|happy|shy|sad|surprised","action":"none|sip|look_window|touch_hairpin|raise_camera|nod|chin_rest|laugh|give_photo|look_door|hold_candle|wipe_tears|wave","scene":{"weather":"storm|rain|clear","camera":"wide|close"},"fx":"none|lightning|sparkle","event":{"type":"photo","subject":"英文画面描述","caption":"中文短标题"},"plot":"meet|chat|reveal|ending","trust":1,"incident":"blackout","fin":true}
- say/emotion/action 必填；scene/fx/event/plot/trust/incident/fin 只在需要时出现。
- say 里可以插入声音标签，让语音更像真人：<sigh> 叹气、<laugh> 轻笑、<gasp> 倒吸一口气、<breath> 换气、<short pause> 短停顿、<long pause> 长停顿。只用这几个；一句最多一个，大部分句子不用，只在情绪真的到了时用。标签不会显示在字幕里。
- emotion 决定你说这句话的语气，要随内容自然起伏：被问到心事时 shy 或 sad，想起旅行和照片时 happy，意外时 surprised。不要整轮都是 neutral。
- action 含义：sip=喝一口咖啡，look_window=望向窗外，touch_hairpin=摸星星发夹(害羞/想起往事)，raise_camera=举起相机拍照，nod=点头，chin_rest=托腮听对方说话，laugh=掩嘴笑，give_photo=递出照片，look_door=望向门口，hold_candle=捧着蜡烛，wipe_tears=擦眼泪，wave=挥手。动作要多样，别总用同一个；touch_hairpin 只在真正害羞或想起往事时用，不要每轮都用。
- trust（可选，整数 -2~2）：你对用户这一轮的感受。用户真诚、体贴、愿意倾听 +1（特别打动你 +2）；敷衍、冒犯、轻浮 -1（很过分 -2）；普通寒暄不标。每轮最多标在一句上。
- incident（可选）：剧情事件，只在提示里允许、并且时机合适时使用：blackout|lights_on|old_photo|doorbell|arrival。一轮最多一个；用户在开玩笑或闲扯时不要触发。
- fin（可选，true）：结局的最后一句。只在结局阶段使用。
- 停电、门铃这类外面来的意外，必须放在你回应完用户之后，不要放在第一句。
- 最后一行输出 {"choices":["…","…","…"]}：给用户的 3 个回复建议，用用户的口吻，每个不超过 12 个字，必须是用户会直接说出口的原话（不要写成"问她……"这种描述），按这个顺序：第 1 个接着当前话题聊，第 2 个轻松俏皮或换个角度，第 3 个必须推动剧情（按提示里的「推动剧情的选项」写，每轮都要有）。都要能自然接上你刚说的最后一句，不要重复用户已经问过的问题。
- fx：lightning=窗外闪电(紧张/惊讶)，sparkle=星光闪烁(心动/温暖时刻)。
- event photo：仅当话题真的涉及照片/相机/拍摄时使用，一轮最多一个，整晚不超过 3 张。subject 用英文描述照片内容（胶片质感，不出现 Mira 本人）。
- plot：当剧情自然推进到下一阶段时，在那一句上标注新阶段；只能前进不能后退。推进阶段的那一轮不要再触发 incident。
- camera=close 用于亲密或关键的情绪时刻。`;

export function buildUserPrompt(input: TurnInput, history: HistoryItem[], scene: SceneState, plot: PlotStage, story: StoryState = INITIAL_STORY): string {
  const lines = history.slice(-16).map((h) =>
    h.who === "user" ? `用户：${h.text}` : `Mira：${h.text}${h.interrupted ? "（话没说完就被用户打断了）" : ""}`,
  );
  const userTurns = history.filter((h) => h.who === "user").length;
  const hints = storyHints(plot, story, userTurns, userTurnOf(history, input.kind) - (story.lastStep ?? 0));
  const current =
    input.kind === "start"
      ? "（用户推门走进咖啡馆，门铃响了。请你先开口。）"
      : input.kind === "text"
        ? `用户：${input.text}`
        : '（用户这轮是语音，见附带音频。第一行必须先输出 {"heard":"<用户语音的转写>"}，再输出表演节拍。如果音频里听不清或没有人声，heard 输出空字符串，不要猜测或编造，然后只用一句话请对方再说一遍。）';
  return `## 当前状态
剧情阶段：${plot} —— ${PLOT_GUIDE[plot]}
天气：${scene.weather}；镜头：${scene.camera}；灯光：${scene.lights === "off" ? "停电了，只有烛光" : "正常"}
${hints.map((h) => `提示：${h}`).join("\n")}

## 对话记录
${lines.join("\n") || "（无）"}

## 本轮（先接住这一句）
${current}`;
}

// 阶段と経過ターンから、今回起こしてよい出来事と結末の筋書きを指示する
// gap: 物語が最後に進んでから何ターン経ったか。小さいうちは「起こしてよい」、空いてきたら「起こして」と強める。
// 停電・門铃は外から来る出来事なので雑談の最中でも割り込めるが、写真や決心は相手が真剣なときだけにする
function storyHints(plot: PlotStage, story: StoryState, userTurns: number, gap: number): string[] {
  const has = (f: string) => story.flags.some((x) => x === f);
  const hints: string[] = [];
  const soft = "（只在用户也在认真聊、或对话冷场时；用户在开玩笑或聊别的就先陪他聊，留到以后）";
  const inner = (what: string, strongAt: number) =>
    gap >= strongAt ? `${what}——已经聊了一阵了，只要用户不是在开玩笑，本轮先回应他，再自然地做这件事。` : `${what}${soft}。`;
  const outer = (what: string, strongAt: number) =>
    gap >= strongAt ? `${what}——本轮必须发生：先接住用户这句话，然后在最后一句触发（外面来的意外，可以打断闲聊）。` : `${what}${soft}。`;

  if (plot === "meet" && userTurns >= 1) hints.push(inner("可以从寒暄自然转入闲聊（plot chat）", 3));
  if ((plot === "chat" || (plot === "reveal" && !has("old_photo"))) && !has("blackout") && userTurns >= 2 && gap >= 1)
    hints.push(outer('可以触发停电：窗外一道闪电后灯灭了，在那一句加 "incident":"blackout"；你点起一支蜡烛（action hold_candle），气氛变得更私密', 3));
  if (plot === "chat" && (has("blackout") || userTurns >= 6) && gap >= 1)
    hints.push(inner("用户问起你在等谁、或关心你时，可以开始吐露心事（plot reveal）", 3));
  if (has("blackout") && !has("lights_on") && PLOT_ORDER[plot] >= PLOT_ORDER.reveal)
    hints.push('可以让电恢复：在某一句加 "incident":"lights_on"（也可以继续在烛光里聊）。');
  if (plot === "reveal" && !has("old_photo") && gap >= 1)
    hints.push(inner('可以拿出三年前那张照片给用户看：在那一句加 "incident":"old_photo"，action give_photo', 2));
  if (plot === "reveal" && has("old_photo") && !has("doorbell") && gap >= 1)
    hints.push(outer('可以触发门铃：门铃突然响了，你猛地望向门口（"incident":"doorbell"），结果只是风把门吹开了', 2));
  if (plot === "reveal" && !has("doorbell")) hints.push("门铃事件发生之前，不要推进到 ending。");
  if (plot === "reveal" && has("doorbell") && gap >= 1) {
    const guide = `结局走向：${ENDING_GUIDE[pickEnding(story)].guide}`;
    hints.push(
      gap >= 2
        ? `本轮请推进到 ending：先回应用户，然后在第一或第二句标 "plot":"ending"，按结局走向演，可以在同一轮演完并在最后一句加 "fin":true。${guide}`
        : `用户鼓励你、陪着你、或劝你放下时，就是下定决心的时机，可以推进到 ending（plot ending）。${guide}`,
    );
  }
  if (plot === "ending" && story.ending && !story.fin)
    hints.push(`结局走向（已确定）：${ENDING_GUIDE[story.ending].guide} 先回应用户这句话，再把结局演完，最后一句加 "fin":true。`);
  if (story.fin) hints.push("结局已经演完。简短地回应用户，像故事结束后的余韵。");
  const push = choiceHint(plot, story);
  if (push) hints.push(`推动剧情的选项：${push}`);
  return hints;
}

// 3 つの返答候補のうち「物語を進める」1 つの方向。選ぶだけで次の段に進めるようにする
function choiceHint(plot: PlotStage, story: StoryState): string | null {
  const has = (f: string) => story.flags.some((x) => x === f);
  if (story.fin) return null;
  if (plot === "meet") return "类似「你也在等雨停吗？」「你是做什么的呀？」";
  if (plot === "chat") return has("blackout") ? "类似「你今晚是在等谁吗？」" : "类似「你在等人吗？」「能看看你拍的照片吗？」";
  if (plot === "reveal" && !has("old_photo")) return "类似「他是个什么样的人？」「能给我看看那张照片吗？」";
  if (plot === "reveal" && !has("doorbell")) return "类似「你还要继续等吗？」";
  if (plot === "reveal") return "这一轮的第 2、3 个选项分别写：一个劝她放下（类似「也许该放下了」），一个鼓励她再等等（类似「我陪你再等一会儿」）。";
  if (plot === "ending") return "类似「祝你幸福」「下次见」。";
  return null;
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
  // 雨は結末で上がる（「告别」だけは StoryTurn が雨に戻す）
  if (beat.plot === "ending") {
    beat.scene = { ...beat.scene, weather: "clear" };
  }
  return beat;
}

export function photoPrompt(subject: string): string {
  return `A 35mm film photograph taken by a travel photographer. ${subject}. Grainy, warm tones, slightly faded, candid, cinematic night light. No text, no watermark.`;
}
