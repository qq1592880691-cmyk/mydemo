# 剧情扩充、动作与声音 设计

日期：2026-10-08

## 目标

在现有「初遇 → 闲聊 → 吐露 → 收尾」四阶段骨架上，加入中间事件和三种结局，让对话有起伏、可重玩；补充角色动作；加入配乐与环境音。

## 1. 剧情系统

### 状态

沿用"客户端持有状态、每轮随请求发给服务端"的方式。`TurnRequest` 新增 `story: StoryState`：

```ts
interface StoryState {
  trust: number;            // 0..10，初始 4
  flags: Incident[];        // 已发生的事件，每个只发生一次
  ending?: Ending;          // 进入 ending 阶段时由服务端锁定
  fin?: boolean;            // 结局演完
}
type Incident = "blackout" | "lights_on" | "old_photo" | "doorbell" | "arrival";
type Ending = "reunion" | "letgo" | "farewell";
```

### 节拍新字段（LLM 输出，服务端校验）

- `trust`: -2..2 的整数，表示 Mira 对用户本轮态度的信任变化。一轮内累计也限制在 -2..2。
- `incident`: 上面 `Incident` 之一。
- `fin`: true，只在 ending 阶段有效，表示结局最后一句。

服务端在节拍上附带变化后的完整 `story`（仅在有变化时），客户端在播放该节拍时应用，与 scene/plot 同步。

### 事件（服务端在 prompt 中按时机提示，演出由 `applyStoryHooks` 确定性补全）

| 事件 | 提示时机 | 确定性演出 |
|---|---|---|
| blackout | chat 阶段、用户总轮数 ≥ 3、未发生 | `scene.lights = "off"`、`fx = lightning`、动作默认 `hold_candle` |
| lights_on | 已停电、进入 reveal 后 | `scene.lights = "on"` |
| old_photo | reveal 阶段、未发生 | 动作 `give_photo`；若无 photo event 则补默认的三年前照片 |
| doorbell | reveal、old_photo 已发生、未发生 | 动作 `look_door`，客户端播放门铃声 |
| arrival | 仅 reunion 结局 | 动作 `look_door`、门铃声、`fx = sparkle` |

重复的 incident 丢弃。

### 结局

- 判定函数 `pickEnding(story)`：`trust ≥ 7 且 flags 含 doorbell` → reunion；`trust ≤ 3` → farewell；否则 letgo。
- reveal 阶段的 prompt 里写明"若本轮进入 ending，结局为 X"并附该结局剧本；进入 ending 的节拍上服务端锁定 `story.ending`（使用本轮开始时的状态判定，与 prompt 一致）。
- ending 阶段 prompt 写入已锁定结局的剧本，并提示用 `fin` 收尾；进入 ending 后第 2 轮起强提示收尾。
- 结局演出：reunion/letgo → 雨停（`weather: clear`）；farewell → 保持小雨，丢弃 photo event。
- 客户端：`fin` 节拍所在回合结束后显示结局卡片（结局名 + 一句话 + 「再来一次」重载页面）。

### 场景

`SceneState` 新增 `lights: "on" | "off"`。停电时灯灭、整体变暗，只在 Mira 位置保留摇曳的烛光。

## 2. 动作

新增 7 个动作及立绘：`chin_rest`(act_chin 托腮)、`laugh`(act_laugh 掩嘴笑)、`give_photo`(act_photo 递照片)、`look_door`(act_door 望向门口)、`hold_candle`(act_candle 捧蜡烛)、`wipe_tears`(act_tears 拭泪)、`wave`(act_wave 挥手)。动作立绘无口型差分，动作停留时间从 3s 缩短到 2.2s。

## 3. 声音

- **配乐**：`scripts/gen-bgm.ts` 用 Lyria 3.5（Interactions API）生成 6 首纯音乐到 `public/bgm/`：meet / chat / reveal / reunion / letgo / farewell；调用写入 `ai_call_log`（purpose `music`）。
- **BgmPlayer**（客户端，Web Audio）：按 plot/ending 选曲，切换时 3s 交叉淡化；Mira 说话时压低约 8dB；停电时音乐停止，来电后恢复。
- **环境音**：Web Audio 实时合成雨声（滤波噪声，强度随 weather），闪电时合成雷声，门铃事件合成门铃声。
- HUD 增加静音按钮，状态存 localStorage（读写包 try/catch）。音频在「推门进去」时解锁。

## 4. 其他

- Mock 剧本覆盖事件与三种结局（按用户文本的友善/冷淡关键词给 trust）。
- 调试面板显示 trust / flags / ending。
- 测试：trust 累加与限幅、事件去重、结局判定与锁定、新字段校验、farewell 丢弃照片。
