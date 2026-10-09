# 打烊前的咖啡馆 · Mira

> 演示录屏：https://github.com/qq1592880691-cmyk/mydemo/releases/download/v1.0/demo.mov

暴雨夜，快打烊的咖啡馆，用户打字或说话，和旅行摄影师 Mira 聊天。她用带情绪的语音回话，有口型、表情和动作；剧情里会停电点蜡烛、雨小看月亮、翻出三年前的照片，聊到照片时还会现场"冲洗"一张生成的照片。一局 14 轮左右（3–5 分钟），按用户的态度走向重逢、释然或告别三种结局。

## 启动

```bash
bash start.sh          # 首次自动 npm install，构建后以生产模式启动
```

打开 http://localhost:3000 ，从装依赖到跑起来约 3 分钟。

- 不配密钥自动进 Mock 模式，剧情、打断、生图、故障演示都能体验；真实模式在 `.env.local` 填 `GEMINI_API_KEY`（照 `.env.example`）。
- URL 参数：`?mock=1` 强制 Mock；`?debug=1` 观测面板；`?fail=tts|llm_timeout|drop|image` 注入故障。
- 立绘、配乐、音效已随仓库提供。测试：`npm test`（单元 69 个）；`python3 e2e/mock_e2e.py`（Playwright，32 项，无需密钥）。

## 系统结构

```
浏览器                                              Next.js 服务端 (Route Handlers)
┌───────────────────────────────────────┐          ┌─────────────────────────────────────┐
│ Experience (React)                    │          │ POST /api/turn  → SSE 事件流         │
│  ├ CafeScene  窗外天气/雨/灯/烛光      │  fetch   │   provider.reply()  流式 NDJSON 节拍  │
│  ├ Character  立绘 表情/动作/口型      │ ───────▶ │   normalizeBeat()   校验/降级枚举      │
│  ├ 字幕 / 照片卡 / 结局卡              │  SSE     │   StoryTurn         信任值/事件/结局   │
│ TurnController  回合状态机(可单测)     │ ◀─────── │   TTS 并发合成 → 按 seq 顺序下发       │
│ BrowserAudio / Soundscape / 麦克风     │          │ POST /api/image → 生成照片(带缓存)     │
└───────────────────────────────────────┘          │ Provider: Gemini | Mock；SQLite 记录   │
                                                   └─────────────────────────────────────┘
```

主要模块：协议与校验 `src/lib/protocol.ts`；prompt 与剧情提示 `src/lib/story.ts`；剧情状态机 `src/lib/storyState.ts`；Provider 抽象 `src/lib/providers/*`；回合 API `src/app/api/turn/route.ts`；客户端状态机 `src/client/turnController.ts`；音频与口型 `src/client/browserDeps.ts`。

## 语音交互与打断

链路：按住说话 → 16kHz WAV → 一次多模态调用完成"听懂 + 回复"（第一行输出转写，后面是表演节拍）→ 每句并发 TTS → 按顺序下发 → 客户端逐句播放，同步切表情、动作、场景、字幕。

交互选了按住说话（桌面可长按空格），她说话时按下即打断。没用自动 VAD：手机浏览器回声消除不可靠，Mira 的声音会触发"自我打断"；按下的瞬间就是明确的打断时刻，可以零延迟停音，行为也好测试。

打断时：停止播放、丢弃未播放的字幕/动作/照片、取消进行中的网络请求和生成、说到一半的句子写入历史并标记"被打断"（下一轮模型知道自己话没说完）、切到倾听。旧响应有三道关挡着不会复活：epoch 自增 + 事件带 turnId 校验 + 网络和播放分开的 AbortController（超时断线只掐网络，已收到的句子照常播完）。

## 角色与场景指令

模型输出 NDJSON，一行一个"节拍"——一句台词加它的表演：

```json
{"say":"嗯……<short pause>算是吧。","emotion":"shy","action":"touch_hairpin","plot":"reveal","trust":1}
{"say":"这张是里斯本的雨夜。","emotion":"happy","action":"raise_camera","event":{"type":"photo","subject":"..."}}
```

| 字段 | 取值 | 表现 |
|---|---|---|
| say | 台词，可含 `<sigh>` `<laugh>` 等声音标签 | 字幕去标签显示；标签交给 TTS 演成叹气、轻笑、停顿 |
| emotion | neutral / happy / shy / sad / surprised | 表情差分 + TTS 语气 |
| action | 12 种（sip / give_photo / hold_candle / wave …） | 动作立绘 |
| scene | weather: storm/rain/clear；camera: wide/close；lights: on/off/dim | 雨量雨声、镜头推近、停电烛光 |
| fx | lightning / sparkle | 闪电 + 雷声 / 星光 |
| event | photo | 生成照片，"显影中"→显影，失败可重洗 |
| plot / trust / incident / fin | 剧情阶段、信任增减、剧情事件、结局收尾 | 驱动剧情推进（见下） |
| choices（末尾一行） | 3 个短句 | 回复选项，点击即发送 |

剧情状态（信任值、已发生事件、结局）放在客户端、每轮随请求发送，服务端逐句更新后挂在节拍上发回，播到那句才生效，打断时未播的变化一起作废。节奏是模型自由加时间表保底：prompt 按时机提示"可以触发"，到期还没发生就由服务端补一句固定台词带出来；事件标记必须和台词对得上（否定句"没停电"不算数），不符就作废改走保底。结局在进入最后阶段时按信任值和用户的劝说锁定三选一。上下文按正常多轮对话发送（user / model 交替，Mira 的句子用输出协议同款 NDJSON）。

## 多模态表现

- 立绘：原创动漫风，图像模型生成基准图后编辑出表情/动作/口型差分；差分只取脸部或嘴部椭圆区域贴回基准图，避免整图重绘带来的闪动。共 33 张，无素材时降级为代码绘制的 SVG。
- 口型：WebAudio 音量包络决定开口度、频谱重心分 a/o 口形，每口形至少 70ms。
- 生成照片：对话触发后调 Gemini 生图（约 8s），期间显示"显影中"，失败可重试，结果有缓存，被打断即取消。
- 声音：6 首配乐随剧情切换（交叉淡化、说话时压低）；雨声、雷声、门铃用 Web Audio 实时合成。

失败处理：模型超时/断线 → 提示 + 重试（已收到的句子播完）；TTS 失败 → 降级浏览器朗读或纯字幕；生图失败 → 失败态 + 重洗；麦克风无权限 → 提示用文字；几乎无声的误触不发送。观测页 `/stats` 看调用、耗时、费用，`/transcripts` 看完整对话记录。

## 模型与第三方

| 用途 | 模型 | 说明 |
|---|---|---|
| 对话（含语音转写） | Gemini `gemini-3.7-flash` | 音频内联一次调用完成"听懂 + 回复"；在 `ai_model` 表可切换 |
| TTS | Gemini `gemini-3.8-flash-tts` | Interactions API 流式，语气放 `speech_metadata.style`，声音标签演叹气/停顿 |
| 生图 | Gemini `gemini-2.5-flash-image` | 4:3 胶片风格，约 8s/张 |
| 立绘 / 配乐（离线） | OpenAI gpt-image / Google Lyria 3.5 | `npm run sprites` / `npm run bgm`，产物已入库 |
| 框架 | Next.js 15 / React 19 / TypeScript / better-sqlite3 | 单元测试 Vitest，端到端 Python Playwright |

素材来源：立绘、配乐、店长语音、测试语音样本均为 AI 生成（上表）；场景、特效、雨声雷声门铃为代码绘制/合成，无第三方素材。模型单价与每次调用记在 SQLite（`/stats` 可见），密钥只放 `.env.local`，不入库。

## 关键技术选择与取舍

- STT + LLM + TTS 组合而非端到端语音模型：指令、字幕、语音要按句对齐，取消要可控，还要能 Mock；代价是首句延迟高一些。
- 对话模型换过两轮：3.7-flash 嫌慢降到 2.5-flash（首句 1 秒出头），真人试玩发现它只会附和复读，又切回 3.7-flash（首句 2.3–3.5s），质量换延迟值得。
- TTS 挑自然度不挑速度：OpenAI 首包快但中文机械；Gemini 走 Interactions API 分离语气和台词后情绪自然，代价是首包约 3 秒。同一批台词 A/B 试听定的。
- SSE 不用 WebSocket：回合制单向流够用，可部署 Serverless，取消就是 fetch abort。
- 会话状态放客户端，服务端无状态，可水平扩展。
- 立绘走"生成 + 局部差分"不用 Live2D：72 小时内能拿到成品级画面，口型动作由配置表驱动。

## 已知问题

- 对话质量和模型档位直接相关，现在是 flash 级小模型，换 pro 级效果会更好（`ai_model` 表切 `is_default` 即可）。
- TTS 没用国产模型，中文发音带一点点湾腔；换 MiniMax / 豆包即可解决，接口已留好。
- 语音首包 5–7 秒（LLM 首行 + Gemini TTS 首包），切 OpenAI TTS 可到 2–2.5 秒；开场有预加载不受影响。
- 动作立绘没有口型差分，做动作那两秒嘴不动；服务端补的保底台词偶尔略显突兀，文案每局相同。
- SQLite 不适合 Serverless 部署，线上要换 Turso/Postgres（`db.ts` 是唯一接入点）。

## 投入时间

3–4 个小时。开发用 Claude Code，测试用 Codex。

## 如果再开发两周

1. 延迟：接入首包几百毫秒的国产流式 TTS（provider 接口已留），松手后先播预录反应遮住等待，目标首包 1.5 秒内。
2. 实时语音：VAD 自动检测开口、区分附和与打断，做回声消除后去掉按住说话。
3. 角色表演：动作立绘补口型差分、动作过渡帧，或迁移 Live2D/Rive 按音素驱动口型。
4. 剧情：事件时机和结局条件抽成配置，按多局数据校准节奏。
5. 生成媒体：按角色参考图生成带 Mira 的剧情插画，结局节点生成短视频。
6. 工程：会话录制回放、端到端测试进 CI、观测上报。
