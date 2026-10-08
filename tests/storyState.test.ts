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
    expect(b.story?.recent).toBe("blackout");
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
  it("推进阶段后，同一轮的内心推进被丢弃，外部意外仍可发生", () => {
    const t = new StoryTurn({ trust: 5, flags: [] });
    expect(t.apply(t.gate(beat({ plot: "reveal" }), "chat"), "chat").plot).toBe("reveal");
    expect(t.apply(t.gate(beat({ incident: "old_photo" }), "reveal"), "reveal").incident).toBeUndefined();
    expect(t.apply(t.gate(beat({ incident: "blackout" }), "reveal"), "reveal").incident).toBe("blackout");
  });

  it("外部意外每轮最多一个，可以和一次内心推进同轮发生", () => {
    const t = new StoryTurn({ trust: 5, flags: ["old_photo"] });
    expect(t.apply(beat({ incident: "blackout" }), "reveal").incident).toBe("blackout");
    expect(t.apply(beat({ incident: "doorbell" }), "reveal").incident).toBeUndefined();
    expect(t.apply(beat({ incident: "note" }), "reveal").incident).toBe("note");
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

describe("新场景：月亮 / 字条 / 手机 / 打烊", () => {
  it("雨小了：天气转小雨、举相机、补上窗景照片", () => {
    const b = new StoryTurn(INITIAL_STORY).apply(beat({ incident: "moon" }), "chat");
    expect(b).toMatchObject({ action: "raise_camera", scene: { weather: "rain" } });
    expect(b.event?.caption).toBe("雨小了的时候");
  });

  it("字条和手机要在旧照片之后；字条缺省时补默认文面，非 note 句上的 note 被去掉", () => {
    expect(new StoryTurn(INITIAL_STORY).apply(beat({ incident: "note" }), "reveal").incident).toBeUndefined();
    const t = new StoryTurn({ trust: 5, flags: ["old_photo"] });
    expect(t.apply(beat({ incident: "note" }), "reveal").note).toContain("三年后");
    expect(new StoryTurn({ trust: 5, flags: ["old_photo"] }).apply(beat({ note: "x" }), "reveal").note).toBeUndefined();
    expect(new StoryTurn({ trust: 5, flags: ["old_photo"] }).apply(beat({ incident: "phone" }), "reveal").action).toBe("check_phone");
  });

  it("打烊提醒要在门铃之后，灯光减半", () => {
    expect(new StoryTurn({ trust: 5, flags: ["old_photo"] }).apply(beat({ incident: "closing" }), "reveal").incident).toBeUndefined();
    const b = new StoryTurn({ trust: 5, flags: ["old_photo", "doorbell"] }).apply(beat({ incident: "closing" }), "reveal");
    expect(b.scene?.lights).toBe("dim");
  });
});

describe("结局由门铃后的选择决定", () => {
  it("满足重逢条件时，模型按用户的话标 letgo 则走释然；不能把释然升级成重逢", () => {
    const t = new StoryTurn({ trust: 9, flags: ["doorbell"] });
    expect(t.apply(applyPlotHooks(t.gate(beat({ plot: "ending", ending: "letgo" }), "reveal"), "reveal"), "reveal").story?.ending).toBe("letgo");
    const t2 = new StoryTurn({ trust: 5, flags: ["doorbell"] });
    expect(t2.apply(applyPlotHooks(t2.gate(beat({ plot: "ending", ending: "reunion" }), "reveal"), "reveal"), "reveal").story?.ending).toBe("letgo");
  });
});

describe("阶段推进保底（时间表）", () => {
  it("第 2 轮进入闲聊、第 6 轮进入吐露、打烊后第 13 轮进入结局；模型已标记时不改", () => {
    expect(new StoryTurn(INITIAL_STORY, 1).nudge(beat({}), "meet").plot).toBeUndefined();
    expect(new StoryTurn(INITIAL_STORY, 2).nudge(beat({}), "meet").plot).toBe("chat");
    expect(new StoryTurn({ trust: 5, flags: [] }, 5).nudge(beat({}), "chat").plot).toBeUndefined();
    expect(new StoryTurn({ trust: 5, flags: [] }, 6).nudge(beat({}), "chat").plot).toBe("reveal");
    expect(new StoryTurn({ trust: 5, flags: ["old_photo", "doorbell"] }, 13).nudge(beat({}), "reveal").plot).toBeUndefined();
    expect(new StoryTurn({ trust: 5, flags: ["old_photo", "doorbell", "closing"] }, 13).nudge(beat({}), "reveal").plot).toBe("ending");
    expect(new StoryTurn(INITIAL_STORY, 2).nudge(beat({ plot: "reveal" }), "meet").plot).toBe("reveal");
  });

  it("过了期限还没发生的事件按顺序补一个；本轮已推进过就不补", () => {
    expect(new StoryTurn({ trust: 5, flags: [] }, 3).due("chat")).toBeNull();
    expect(new StoryTurn({ trust: 5, flags: [] }, 4).due("chat")).toBe("blackout");
    expect(new StoryTurn({ trust: 5, flags: ["blackout"] }, 8).due("reveal")).toBe("moon");
    expect(new StoryTurn({ trust: 5, flags: ["blackout", "moon"] }, 9).due("reveal")).toBe("old_photo");
    expect(new StoryTurn({ trust: 5, flags: ["blackout", "moon", "old_photo", "note", "phone"] }, 11).due("reveal")).toBe("doorbell");
    const t = new StoryTurn({ trust: 5, flags: [] }, 4);
    t.apply(beat({ incident: "blackout" }), "chat");
    expect(t.due("chat")).toBeNull();
  });
});

describe("事件的前置条件", () => {
  it("寒暄阶段不触发事件；门铃要在旧照片之后", () => {
    expect(new StoryTurn(INITIAL_STORY).apply(beat({ incident: "doorbell" }), "meet").incident).toBeUndefined();
    expect(new StoryTurn(INITIAL_STORY).apply(beat({ incident: "blackout" }), "meet").incident).toBeUndefined();
    expect(new StoryTurn(INITIAL_STORY).apply(beat({ incident: "doorbell" }), "reveal").incident).toBeUndefined();
    expect(new StoryTurn({ trust: 5, flags: ["old_photo"] }).apply(beat({ incident: "doorbell" }), "reveal").incident).toBe("doorbell");
  });
});
