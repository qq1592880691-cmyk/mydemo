import { describe, expect, it } from "vitest";
import { INITIAL_STORY, normalizeBeat, type Beat, type StoryState } from "@/lib/protocol";
import { applyPlotHooks } from "@/lib/story";
import { OLD_PHOTO, StoryTurn, pickEnding } from "@/lib/storyState";

const beat = (raw: Record<string, unknown>): Beat => normalizeBeat({ say: "嗯。", ...raw }, 0)!;

describe("normalizeBeat 剧情字段", () => {
  it("trust 取整并限幅，0 不保留；未知 incident 丢弃", () => {
    expect(beat({ trust: 5 }).trust).toBe(2);
    expect(beat({ trust: "-1" }).trust).toBe(-1);
    expect(beat({ trust: 0.2 }).trust).toBeUndefined();
    expect(beat({ incident: "fire" }).incident).toBeUndefined();
    expect(beat({ incident: "blackout", fin: "yes" })).toMatchObject({ incident: "blackout" });
    expect(beat({ fin: "yes" }).fin).toBeUndefined();
  });

  it("新动作和灯光被接受", () => {
    expect(beat({ action: "wave", scene: { lights: "off" } })).toMatchObject({ action: "wave", scene: { lights: "off" } });
  });
});

describe("pickEnding", () => {
  it("按信任值和门铃决定结局", () => {
    expect(pickEnding({ trust: 8, flags: ["doorbell"] })).toBe("reunion");
    expect(pickEnding({ trust: 8, flags: [] })).toBe("letgo");
    expect(pickEnding({ trust: 5, flags: ["doorbell"] })).toBe("letgo");
    expect(pickEnding({ trust: 3, flags: ["doorbell"] })).toBe("farewell");
  });
});

describe("StoryTurn", () => {
  it("一轮内信任变化合计不超过 ±2，总值在 0..10", () => {
    const t = new StoryTurn({ trust: 9, flags: [] });
    expect(t.apply(beat({ trust: 2 }), "chat").story?.trust).toBe(10);
    expect(t.apply(beat({ trust: 2 }), "chat").story).toBeUndefined();
    const t2 = new StoryTurn({ trust: 4, flags: [] });
    t2.apply(beat({ trust: -2 }), "chat");
    t2.apply(beat({ trust: -2 }), "chat");
    expect(t2.state.trust).toBe(2);
  });

  it("事件只发生一次，并补全确定性演出", () => {
    const t = new StoryTurn(INITIAL_STORY);
    const b = t.apply(beat({ incident: "blackout" }), "chat");
    expect(b).toMatchObject({ action: "hold_candle", fx: "lightning", scene: { lights: "off" } });
    expect(b.story?.flags).toEqual(["blackout"]);
    expect(t.apply(beat({ incident: "blackout" }), "chat").incident).toBeUndefined();
  });

  it("没停电不能来电；非重逢结局不能 arrival", () => {
    const t = new StoryTurn(INITIAL_STORY);
    expect(t.apply(beat({ incident: "lights_on" }), "reveal").incident).toBeUndefined();
    expect(t.apply(beat({ incident: "arrival" }), "reveal").incident).toBeUndefined();
  });

  it("旧照片缺省时补上三年前的照片；已有 event 不覆盖", () => {
    const t = new StoryTurn(INITIAL_STORY);
    const b = t.apply(beat({ incident: "old_photo" }), "reveal");
    expect(b.action).toBe("give_photo");
    expect(b.event?.caption).toBe(OLD_PHOTO.caption);
  });

  it("进入 ending 时按本轮开始时的状态锁定结局，本轮中途信任变化不影响", () => {
    const start: StoryState = { trust: 7, flags: ["doorbell"] };
    const t = new StoryTurn(start);
    t.apply(beat({ trust: -2 }), "reveal");
    const b = t.apply(applyPlotHooks(beat({ plot: "ending" }), "reveal"), "reveal");
    expect(b.story?.ending).toBe("reunion");
    expect(b.scene?.weather).toBe("clear");
    expect(t.apply(beat({ incident: "arrival" }), "ending").incident).toBe("arrival");
  });

  it("告别结局：保持下雨、丢弃照片", () => {
    const t = new StoryTurn({ trust: 2, flags: [] });
    const b = t.apply(applyPlotHooks(beat({ plot: "ending", event: { type: "photo", subject: "x" } }), "reveal"), "reveal");
    expect(b.story?.ending).toBe("farewell");
    expect(b.scene?.weather).toBe("rain");
    expect(b.event).toBeUndefined();
  });

  it("停电中进入结局会自动来电", () => {
    const t = new StoryTurn({ trust: 5, flags: ["blackout"] });
    const b = t.apply(applyPlotHooks(beat({ plot: "ending" }), "reveal"), "reveal");
    expect(b.scene?.lights).toBe("on");
    expect(b.story?.flags).toContain("lights_on");
  });

  it("fin 只在结局阶段有效", () => {
    expect(new StoryTurn(INITIAL_STORY).apply(beat({ fin: true }), "chat").fin).toBeUndefined();
    const t = new StoryTurn({ trust: 5, flags: [], ending: "letgo" });
    expect(t.apply(beat({ fin: true }), "ending").story?.fin).toBe(true);
  });
});

describe("StoryTurn 约束", () => {
  it("门铃之前不能进入结局", () => {
    const t = new StoryTurn({ trust: 8, flags: ["old_photo"] });
    expect(t.gate(beat({ plot: "ending" }), "reveal").plot).toBeUndefined();
    const t2 = new StoryTurn({ trust: 8, flags: ["old_photo", "doorbell"] });
    expect(t2.gate(beat({ plot: "ending" }), "reveal").plot).toBe("ending");
  });

  it("一轮最多一张照片", () => {
    const t = new StoryTurn(INITIAL_STORY);
    expect(t.apply(beat({ incident: "old_photo" }), "reveal").event).toBeDefined();
    expect(t.apply(beat({ event: { type: "photo", subject: "x" } }), "reveal").event).toBeUndefined();
  });
});

describe("StoryTurn 每轮最多推进一步", () => {
  it("推进阶段后，同一轮的事件被丢弃", () => {
    const t = new StoryTurn({ trust: 5, flags: [] });
    expect(t.apply(t.gate(beat({ plot: "reveal" }), "chat"), "chat").plot).toBe("reveal");
    expect(t.apply(t.gate(beat({ incident: "old_photo" }), "reveal"), "reveal").incident).toBeUndefined();
  });

  it("一轮只能触发一个事件", () => {
    const t = new StoryTurn({ trust: 5, flags: ["old_photo"] });
    expect(t.apply(beat({ incident: "blackout" }), "reveal").incident).toBe("blackout");
    expect(t.apply(beat({ incident: "doorbell" }), "reveal").incident).toBeUndefined();
  });

  it("结局里的来电和到达不受限制", () => {
    const t = new StoryTurn({ trust: 8, flags: ["blackout", "doorbell"] });
    const b = t.apply(applyPlotHooks(t.gate(beat({ plot: "ending" }), "reveal"), "reveal"), "reveal");
    expect(b.story?.ending).toBe("reunion");
    expect(t.apply(beat({ incident: "arrival" }), "ending").incident).toBe("arrival");
  });
});

describe("StoryTurn 节奏", () => {
  it("剧情前进时记录是第几轮", () => {
    const t = new StoryTurn({ trust: 5, flags: [] }, 6);
    expect(t.apply(beat({ incident: "blackout" }), "chat").story?.lastStep).toBe(6);
    const t2 = new StoryTurn({ trust: 5, flags: [] }, 7);
    expect(t2.apply(beat({ trust: 1 }), "chat").story?.lastStep).toBeUndefined();
  });
});
