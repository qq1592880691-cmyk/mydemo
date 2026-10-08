import { describe, expect, it } from "vitest";
import { StutterLimiter, normalizeBeat, normalizeChoices } from "@/lib/protocol";

describe("normalizeBeat 声音标签", () => {
  it("字幕用 say 去掉标签，合成用 speech 保留已知标签", () => {
    const b = normalizeBeat({ say: "嗯……<short pause>算是吧。<sigh>", emotion: "shy" }, 0)!;
    expect(b.say).toBe("嗯……算是吧。");
    expect(b.speech).toBe("嗯…… <short pause> 算是吧。 <sigh>");
  });

  it("未知标签从两边都去掉，大小写统一", () => {
    const b = normalizeBeat({ say: "<Laugh>好呀<applause>" }, 0)!;
    expect(b.say).toBe("好呀");
    expect(b.speech).toBe("<laugh> 好呀");
  });

  it("没有标签时不设 speech", () => {
    expect(normalizeBeat({ say: "雨真大。" }, 0)!.speech).toBeUndefined();
  });

  it("只有标签的台词视为空", () => {
    expect(normalizeBeat({ say: "<sigh>" }, 0)).toBeNull();
  });
});

describe("normalizeChoices", () => {
  it("最多 3 个、去重、去掉引号和声音标签，非字符串忽略", () => {
    expect(normalizeChoices(["「你好」", "你好", 3, "<laugh>哈哈", "a", "b"])).toEqual(["你好", "哈哈", "a"]);
    expect(normalizeChoices("x")).toEqual([]);
  });
});

describe("StutterLimiter", () => {
  it("一轮只保留第一处结巴", () => {
    const l = new StutterLimiter();
    expect(l.apply("你、你怎么知道")).toBe("你、你怎么知道");
    expect(l.apply("这、这个嘛，我、我不说")).toBe("这个嘛，我不说");
    expect(l.apply("一、二、三")).toBe("一、二、三");
  });
});
