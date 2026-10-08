# 打烊前的咖啡馆 · Mira

一个移动端优先的实时互动场景 MVP：暴雨夜、即将打烊的咖啡馆里，用户通过文字或语音和旅行摄影师 Mira 对话。Mira 会说话、换表情、做动作，对话推进剧情时会切换天气和镜头、触发闪电/星光特效，还会"冲洗"一张根据当前对话生成的照片。

## 快速开始

```bash
bash start.sh          # 或 npm run demo；首次会自动 npm install
```

打开 http://localhost:3000 。

- **无需任何 API 密钥**：未配置 `GEMINI_API_KEY` 时自动进入 Mock 模式，剧情、打断、生图、故障演示全部可体验。
- 真实模式：在 `.env.local` 填入 `GEMINI_API_KEY`（见 `.env.example`）。页面右上角徽章显示当前是 `MOCK` 还是 `GEMINI`。
- URL 参数：`?mock=1` 强制 Mock；`?debug=1` 打开观测面板；`?fail=tts|llm_timeout|drop|image` 注入故障。
- 手机访问麦克风需要 HTTPS（localhost 除外），局域网调试可用 `npx next dev --experimental-https`。
- 测试：`npm test`

## 系统结构

```
浏览器                                              Next.js 服务端 (Route Handlers)
┌───────────────────────────────────────┐          ┌─────────────────────────────────────┐
│ Experience (React)                    │          │ POST /api/turn  → SSE 事件流         │
│  ├ CafeScene  窗外天气/雨/灯/桌        │  fetch   │   provider.reply()  流式 NDJSON 节拍  │
│  ├ Mira (SVG) 表情/动作/眨眼/口型      │ ───────▶ │   normalizeBeat()   校验/降级枚举      │
│  ├ 字幕 / 照片卡 / HUD / 观测面板      │  SSE     │   applyPlotHooks()  剧情节点确定性演出 │
│  │                                    │ ◀─────── │   TTS 并发合成 → 按 seq 顺序下发       │
│ TurnController  (框架无关，可单测)     │          │ POST /api/image → 生成照片(带缓存)     │
│  epoch / turnId / AbortController     │          │                                     │
│ BrowserAudio  WebAudio+口型电平+降级   │          │ Provider 接口: Gemini | Mock          │
│ MicRecorder   按住说话 → 16k WAV       │          └─────────────────────────────────────┘
└───────────────────────────────────────┘
```

| 模块 | 文件 | 职责 |
|---|---|---|
| 协议 | `src/lib/protocol.ts` | 节拍(Beat)与流事件类型、LLM 输出校验 |
| 剧情 | `src/lib/story.ts` | 人设/输出协议 prompt、剧情阶段、节点钩子 |
| Provider | `src/lib/providers/*` | `reply / tts / image` 三个能力；Gemini 与 Mock 可替换 |
| 回合 API | `src/app/api/turn/route.ts` | SSE 流、超时、TTS 并发与顺序化、取消传递 |
| 状态机 | `src/client/turnController.ts` | 待机/倾听/思考/说话，打断与失效响应过滤 |
| 浏览器 I/O | `src/client/browserDeps.ts` | SSE 解析、音频播放/降级、录音编码 |
| 表现层 | `src/components/*` | 场景、角色、照片、HUD、观测面板 |

## 语音交互与打断

**链路**：按住说话 → 录音编码为 16kHz WAV → 一次多模态调用同时完成"听懂 + 回复"（模型第一行输出 `{"heard": 转写}`，之后是表演节拍）→ 每个节拍并发做 TTS → 服务端按顺序下发 → 客户端逐拍播放，节拍开始时同步切换表情/动作/场景/字幕。

把 STT 并进 LLM 调用，省掉一次往返；节拍级 TTS 让第一句话不必等整段回复生成完。

**交互方式选择：按住说话（桌面可长按空格）**，角色说话时按下即打断。理由：
1. 移动浏览器的回声消除不可靠，自动 VAD 容易被 Mira 自己的声音触发"自我打断"；
2. 按下的瞬间就是确定的打断时刻，可以 0 延迟停音，行为可预测、可测试；
3. 不依赖额外的 VAD 模型下载，弱网下也能用。
自动 VAD 列入后续计划（见下文）。

**打断时发生什么**（`TurnController.cancel`）：

```
epoch++                       ← 所有旧的异步回调在下一个 await 之后自检 epoch，不一致立即退出
abort(网络)  abort(播放)       ← fetch 断开 → 服务端 req.signal 级联取消 LLM / TTS
audio.stop()                  ← WebAudio source.stop() / speechSynthesis.cancel()
queue = []                    ← 未播放的字幕、动作、媒体事件全部丢弃
生成中的照片 → abort 并移除
已说出的半句 → 写入历史并标记"被打断"，下一轮 LLM 知道自己话没说完
state = listening
```

**防止旧响应复活的三层保护**：
1. `epoch`：每次取消或开始新回合都自增，异步回调（流读取、播放循环、生图回调）都在 await 之后比对；
2. `turnId`：请求携带 turnId，服务端每个事件回传，不匹配的事件丢弃并记日志 `stale_dropped`；
3. `AbortController`：网络与播放分开取消。超时/断线只取消网络，已收到的节拍继续播完再进入错误态；用户打断则两者都取消。

以上行为由 `tests/turnController.test.ts` 的 8 个用例覆盖（打断后迟到响应不播放、连续三次输入只播最后一轮、turnId 不匹配丢弃、首包超时、中途断线、照片生成中被打断等）。

## 角色与场景指令

模型输出 NDJSON，每行一个"节拍"——一句台词加上它对应的表演：

```json
{"say":"……被你发现了。","emotion":"shy","action":"touch_hairpin","plot":"reveal"}
{"say":"这张是里斯本的雨夜。","emotion":"happy","action":"raise_camera",
 "event":{"type":"photo","subject":"a rain-soaked night street in Lisbon...","caption":"里斯本的雨夜"}}
{"say":"真的……雨停了。","emotion":"surprised","action":"look_window","scene":{"weather":"clear"},"fx":"sparkle"}
```

| 字段 | 取值 | 表现 |
|---|---|---|
| emotion | neutral / happy / shy / sad / surprised | 眼、眉、嘴、腮红差分，表情切换淡入 |
| action | sip / look_window / touch_hairpin / raise_camera / nod | 道具与头部动画（喝咖啡、望窗外、摸发夹、举相机+闪光、点头） |
| scene.weather | storm / rain / clear | 雨量渐变、夜空/月亮/街灯过渡 |
| scene.camera | wide / close | 整体镜头推近（关键情绪时刻） |
| fx | lightning / sparkle | 闪电闪屏 / 发夹星光 |
| event | photo | 生成一张照片，"显影中"→显影动画 / 失败可重洗 |
| plot | meet → chat → reveal → ending | 剧情阶段，只能前进 |

设计取舍：
- **以"句"为单位**而不是整段回复带一个情绪：表情、动作、字幕、语音天然对齐，打断时也能精确知道说到哪一句。
- **服务端校验**：枚举外的值降级为默认值，非 JSON 行当台词兜底，模型偶尔不守协议也不会把前端搞坏。
- **剧情节点钩子**：`plot` 推进到 `reveal` 时强制镜头推近 + 星光，到 `ending` 时强制雨停。关键视觉事件由剧情决定，不依赖模型"记得写"；同时模型仍可自由使用其他字段。
- 角色状态（待机/倾听/思考/说话）由客户端状态机决定，不交给模型。

需求对照：情绪 5 种 ≥3；非说话动作 5 种 + 待机呼吸/眨眼/倾听歪头/思考气泡 ≥2；环境变化（雨停、镜头推近）≥1；对话触发事件（问到照片 → 举相机 + 生成照片）≥1。

## 多模态表现

- **角色动画**：原创动漫立绘（`Character.tsx`），由 `npm run sprites` 生成：先生成一张基准图，再在基准图上编辑出 4 种表情、5 张口型、1 张眨眼和 4 个动作。
  - 图像模型每次编辑都会重绘整张图，直接切换会让头发和衣服也跟着闪。所以生成后按肤色密度定位脸部，表情和口型差分只取脸部椭圆区域、羽化后贴回基准图，脸以外与基准图逐像素一致。
  - 口型由 WebAudio `AnalyserNode` 的实时电平驱动（带滞回），眨眼随机触发，都只切换 DOM class，不触发 React 重渲染。
  - 没有立绘素材时，自动降级为代码绘制的 SVG 角色（`Mira.tsx`）。
- **生成式图片**：对话触发 `event.photo` 后调用 Gemini 图像模型生成"胶片照片"。生成期间显示"显影中"，角色继续表演承接；失败显示"照片受潮了"，可点击重试；结果按题材缓存复用。被打断时取消生成。

## 失败与降级

| 场景 | 处理 |
|---|---|
| 模型首包超时 | 服务端 15s 分块超时 + 客户端 20s 看门狗 → 提示条 + "重试" |
| 回复中途断线 | 已收到的句子照常播完，然后提示可重试 |
| TTS 失败 / 超时 | 该句降级为浏览器 `speechSynthesis` 朗读，没有中文音色时降级为纯字幕定时播放，提示条说明 |
| 音频解码失败 | 同上 |
| 生图失败 | 照片卡显示失败态 + 重洗按钮 |
| 麦克风无权限 | 提示改用文字输入 |

观测面板（⚙ 或 `?debug=1`）可以切换 Mock 和故障注入，并实时显示 `heard / first_beat / total / client_first_beat / image` 耗时和完整事件日志（包括被丢弃的节拍数、stale 事件）。

## 模型 Master 与调用记录（SQLite）

首次启动时自动在 `data/mira.db` 建表并写入初始数据（`db/schema.sql`、`db/seed.sql`，均为幂等语句），之后按编号顺序执行 `db/migrations/*.sql`，每个文件只执行一次，记录在 `schema_migrations` 表。`data/` 已被 git 忽略。

- **`ai_model`（模型 Master）**：provider（gemini / openai / mock）、用途（text / tts / image / sprite）、model_id、api_key、单价（输入文本 / 输入音频 / 输入图像 / 输出，按每 100 万 token 计）、是否默认、是否启用。
  - 每个用途取「启用 + 默认」的那一行；sprite 用途按顺序依次尝试，前一个失败时用下一个。
  - `api_key` 为空时回退到 `.env.local` 中对应 provider 的密钥（`GEMINI_API_KEY` / `OPENAI_API_KEY`）。
  - 改表即时生效，无需重启。
- **`ai_call_log`（调用记录）**：每次模型调用写一行，包括会话 ID / 回合、状态（ok / error / timeout / aborted）、耗时、各类 token 数、按 Master 单价计算的费用、错误信息。
  - 被打断的流式调用也会记录为 `aborted`，并带上已产生的 usage。
  - Mock 调用同样记录，费用为 0，所以无密钥时也能看到调用链路。
- **观测页 `/stats`**：Master 一览（密钥只显示末 4 位）、按模型汇总的调用次数、失败数、平均耗时、token 数和费用，以及最近 100 次调用明细。

旧版 2.5 系列模型作为非默认行保留，需要时把 `is_default` 切过去即可。单价取自写入时的公开价，以官方为准：`gemini-3.7-flash` 为导入价，2027/1/1 起翻倍；它的音频输入单价未确认，暂按文本价填写。

## 模型与第三方

| 用途 | 默认 | 说明 |
|---|---|---|
| 理解 + 回复（含语音转写） | `gemini-3.7-flash`（thinking 最小） | 音频以内联方式与 prompt 一起发送；模型均可在 `ai_model` 表切换 |
| TTS | `gemini-3.8-flash-tts`，音色 `Leda` | 按情绪加风格指令；PCM 包成 WAV |
| 生图 | `gemini-3.1-flash-image-preview`（Nano Banana 2） | 4:3 胶片风格 |
| SDK | `@google/genai` | |
| 角色立绘生成 | OpenAI `gpt-image-2.5-sunburst`，不可用时依次回退 Gemini Nano Banana Pro / Nano Banana 2 | `npm run sprites`，抠绿幕后输出到 `public/sprites` |
| 框架 | Next.js 15 / React 19 / TypeScript / Vitest / better-sqlite3 | |

素材：角色、场景、特效全部由代码绘制（SVG/CSS/Canvas），无第三方美术素材。Mock 模式的照片是根据题材确定性生成的 SVG。

## 关键技术选择与取舍

- **STT + LLM + TTS 组合，而不是端到端实时语音模型**：结构化指令和字幕、语音能按句精确对齐，取消逻辑完全可控，并且容易做 Mock。代价是首句延迟较高（一次 LLM 首行 + 一句 TTS）。
- **按实测选模型、流式 TTS**：首句出声从 6.3 秒降到约 2 秒。实测数据如下：
  - 对话模型首行：gemini-3.7-flash 约 4.5 秒（不支持 MINIMAL 思考等级），3.5-flash（MINIMAL）约 1.3 秒，2.5-flash（关闭思考）约 0.9 秒，因此对话默认用 2.5-flash。
  - TTS：3.8-flash-tts 非流式要等整句合成完（约 3.5–4 秒），流式输出首包约 0.8–1.1 秒。服务端把 PCM 片段按句子顺序转发，客户端按时间排布播放。
  - 文字输入时不再让模型先输出转写行。
- **SSE 而不是 WebSocket**：回合制场景只需要单向流，用 HTTP 就能部署在 Serverless（如 Vercel）上；取消直接用 `fetch` 的 abort。
- **会话状态放在客户端**：每回合把历史、剧情阶段、场景状态发给服务端，服务端无状态，可以水平扩展、随时重启。
- **SVG 角色而不是 Live2D 或生成立绘**：72 小时内可控，表情和口型可以参数化驱动，不存在多张生成图之间人物不一致的问题；`FACE` 表和动作 CSS 本身就是配置化的动作系统雏形。

## 已知问题

- 真实模式下首句出声约 1.9–2.2 秒，其中 TTS 首包约 1 秒，是目前的主要瓶颈。Mock 模式约 0.8 秒。
- `ScriptProcessorNode` 已标记废弃，但兼容性最好（含 iOS Safari）；后续换成 AudioWorklet。
- iOS 的 `speechSynthesis` 降级音色因系统而异。
- SQLite 文件不适合 Serverless 部署（实例间不共享、不持久）；线上部署应换成 Turso/libSQL 或 Postgres，`db.ts` 是唯一的接入点。
- 剧情由 LLM 自由推进，可能会提前或延后进入下一阶段（已有轮数提示和节点钩子兜底）。

## 投入时间

（待填写）

## 如果再开发两周

1. **实时语音**：接入 Gemini Live / OpenAI Realtime，用 function calling 旁路输出节拍指令；或保留现有链路，加 Silero VAD 自动检测开口，区分"嗯/对"之类的附和与真正的打断（短时长 + 低能量 + 关键词判定）。
2. **延迟**：TTS 流式化（边合成边播），首句预测性预生成，目标首包 <1.2s。
3. **角色表演**：切换到 Live2D/Rive 资源，`FACE`/动作改为 JSON 配置；动作优先级队列，情绪之间插值过渡；按音素对口型。
4. **生成媒体**：使用角色参考图生成包含 Mira 的剧情插画并保持外观一致；在 ending 节点生成 5 秒短视频，生成期间由现有动画承接。
5. **工程**：会话事件录制与回放（用于问题诊断和 Demo），Playwright E2E 覆盖打断流程，观测数据上报。
