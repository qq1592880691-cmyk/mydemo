import { describe, expect, it } from "vitest";
import type { HistoryItem, SceneState } from "@/lib/protocol";
import { SYSTEM_PROMPT, buildTurnPrompt } from "@/lib/story";

const scene: SceneState = { weather: "storm", camera: "wide" };

describe("buildTurnPrompt 多轮上下文", () => {
  const history: HistoryItem[] = [
    { who: "mira", text: "欢迎光临。" },
    { who: "mira", text: "外面雨很大吧？" },
    { who: "user", text: "是啊，躲个雨。" },
    { who: "mira", text: "坐吧，我去", interrupted: true },
    { who: "user", text: "不用麻烦。" },
  ];

  it("把历史映射成交替的 user/model 消息，Mira 的连续台词合并为 NDJSON", () => {
    const turns = buildTurnPrompt({ kind: "text", text: "谢谢" }, history, scene, "chat");
    // 开头补一条"推门进店"的 user 消息，保证对话以 user 开始
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toContain("推门");
    expect(turns[1]).toEqual({ role: "model", text: '{"say":"欢迎光临。"}\n{"say":"外面雨很大吧？"}' });
    expect(turns[2]).toEqual({ role: "user", text: "是啊，躲个雨。" });
    expect(turns[3]).toEqual({ role: "model", text: '{"say":"坐吧，我去","interrupted":true}' });
    // 相邻消息角色必须交替
    for (let i = 1; i < turns.length; i++) expect(turns[i].role).not.toBe(turns[i - 1].role);
  });

  it("最后一条是 user 消息：带状态与本轮输入，不再有「对话记录」段", () => {
    const turns = buildTurnPrompt({ kind: "text", text: "谢谢" }, history, scene, "chat");
    const last = turns.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.text).toContain("剧情阶段");
    expect(last.text).toContain("用户：谢谢");
    expect(last.text).not.toContain("## 对话记录");
    // 历史台词不混进最后一条消息
    expect(last.text).not.toContain("欢迎光临");
  });

  it("开场（start）只有一条 user 消息", () => {
    const turns = buildTurnPrompt({ kind: "start" }, [], scene, "meet");
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toContain("请你先开口");
  });
});

describe("提示词：选项不被 Mira 说出口", () => {
  it("推动剧情的选项标注为用户的话", () => {
    const turns = buildTurnPrompt({ kind: "text", text: "你还要等吗" }, [], scene, "chat");
    expect(turns.at(-1)!.text).toContain("推动剧情的选项（用户的话，不能由你说出口）");
  });

  it("系统提示明确：选项示例是用户台词，往事是 Mira 和他之间的事", () => {
    expect(SYSTEM_PROMPT).toContain("用户的候选台词");
    expect(SYSTEM_PROMPT).toContain("和眼前的用户无关");
  });
});

describe("提示词：人设与节奏", () => {
  it("系统提示明确 Mira 是客人不是店员，不说欢迎光临，不替用户编话", () => {
    expect(SYSTEM_PROMPT).toContain("不是店员");
    expect(SYSTEM_PROMPT).toContain("欢迎光临");
    expect(SYSTEM_PROMPT).toContain("不要替他虚构");
  });

  it("上一轮刚发生过事件时，这一轮的提示不再写「本轮必须发生」", () => {
    const story = { trust: 5, flags: ["blackout"], recent: "blackout", lastStep: 4 } as const;
    const history: HistoryItem[] = Array.from({ length: 4 }, (_, i) => ({ who: "user" as const, text: `第${i}句` }));
    const last = buildTurnPrompt({ kind: "text", text: "哇，吓我一跳" }, history, scene, "chat", { ...story, flags: [...story.flags] }).at(-1)!.text;
    expect(last).toContain("上一轮最后刚发生");
    expect(last).not.toContain("本轮必须发生");
  });
});
