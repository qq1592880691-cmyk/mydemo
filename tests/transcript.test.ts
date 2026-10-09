import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// getDb は初回呼び出しで DB_PATH を読むので、import より前に一時ファイルへ向ける
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mira-transcript-")), "test.db");
const { logUtterance, getTranscript, listTranscriptSessions } = await import("@/lib/transcript");

describe("transcript 对话记录", () => {
  it("记录双方台词，按回合和句序排列（用户在该回合的节拍之前）", () => {
    const sessionId = "s-order";
    // 故意乱序写入：先 Mira 的第 2 句，再用户，再第 1 句
    logUtterance({ sessionId, turnId: 1, seq: 1, who: "mira", kind: "beat", text: "外面雨很大吧？", emotion: "neutral" });
    logUtterance({ sessionId, turnId: 1, seq: -1, who: "user", kind: "text", text: "你好" });
    logUtterance({ sessionId, turnId: 1, seq: 0, who: "mira", kind: "beat", text: "欢迎光临。", emotion: "happy" });
    logUtterance({ sessionId, turnId: 2, seq: -1, who: "user", kind: "audio", text: "你在等人吗？" });
    logUtterance({ sessionId, turnId: 2, seq: 0, who: "mira", kind: "beat", text: "呀，停电了！", emotion: "surprised", incident: "blackout" });

    const rows = getTranscript(sessionId);
    expect(rows.map((r) => r.text)).toEqual(["你好", "欢迎光临。", "外面雨很大吧？", "你在等人吗？", "呀，停电了！"]);
    expect(rows[0]).toMatchObject({ who: "user", kind: "text", turn_id: 1, seq: -1 });
    expect(rows[4]).toMatchObject({ who: "mira", emotion: "surprised", incident: "blackout" });
    expect(rows[1].incident).toBeNull();
  });

  it("没有 sessionId 或空文本时不记录", () => {
    logUtterance({ turnId: 1, seq: -1, who: "user", kind: "text", text: "没会话" });
    logUtterance({ sessionId: "s-empty", turnId: 1, seq: -1, who: "user", kind: "audio", text: "" });
    expect(getTranscript("s-empty")).toEqual([]);
  });

  it("listTranscriptSessions 汇总各会话的行数，最近的在前", () => {
    logUtterance({ sessionId: "s-a", turnId: 1, seq: -1, who: "user", kind: "text", text: "a1" });
    logUtterance({ sessionId: "s-b", turnId: 1, seq: -1, who: "user", kind: "text", text: "b1" });
    logUtterance({ sessionId: "s-b", turnId: 2, seq: 0, who: "mira", kind: "beat", text: "b2" });
    const sessions = listTranscriptSessions(10);
    const ids = sessions.map((s) => s.session_id);
    expect(ids.indexOf("s-b")).toBeLessThan(ids.indexOf("s-a"));
    expect(sessions.find((s) => s.session_id === "s-b")).toMatchObject({ lines: 2, turns: 2 });
  });
});
