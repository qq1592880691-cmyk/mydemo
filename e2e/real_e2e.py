"""真实模式（需要 GEMINI_API_KEY）的端到端检查：Gemini 对话 + TTS + 生图。
用 fixtures/voice.wav（"你好呀，你是在等人吗？"）作为虚拟麦克风输入，验证语音识别与打断。

用法: python3 e2e/real_e2e.py [http://localhost:3000]
截图输出到 e2e/shots/。
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
WAV = os.path.join(HERE, "fixtures", "voice.wav")
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""), flush=True)


def status(p):
    return p.locator(".status span").inner_text()


def wait_status(p, word, timeout=60):
    t = time.time()
    while time.time() - t < timeout:
        if word in status(p):
            return True
        p.wait_for_timeout(100)
    return False


def dd(p, key):
    loc = p.locator(f'.metrics dt:text-is("{key}") + dd')
    return loc.inner_text() if loc.count() else None


def metrics(p):
    keys = p.locator(".metrics dt").all_inner_texts()
    vals = p.locator(".metrics dd").all_inner_texts()
    return dict(zip(keys, vals))


def logs(p):
    return p.locator(".log li").all_inner_texts()


def turn_text(p, text):
    p.fill(".controls input", text)
    p.click("button.send")
    p.wait_for_timeout(300)
    wait_status(p, "待机", 90)
    return [l.split(" beat ")[1] for l in logs(p) if " beat " in l and f"#{metrics(p)['turn'].strip('#')} " in l][::-1]


with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True,
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={WAV}", "--autoplay-policy=no-user-gesture-required"],
    )
    ctx = browser.new_context(viewport={"width": 1600, "height": 900})
    ctx.grant_permissions(["microphone"])
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(BASE + "/?debug=1")
    p.wait_for_load_state("networkidle")
    p.click("text=推门进去")
    wait_status(p, "说话中", 60)
    p.wait_for_timeout(1500)
    p.screenshot(path=f"{SHOTS}/r01_start.png")
    wait_status(p, "待机", 90)
    m = metrics(p)
    check("真实模式：GEMINI 徽章", p.locator(".badge").inner_text().strip() == "GEMINI")
    check("语音输出走 TTS（非浏览器朗读）", m.get("语音输出") == "tts", m.get("语音输出"))
    print("  开场指标:", {k: v for k, v in m.items() if "ms" in v})

    # 語音入力（偽マイク）
    mic = p.locator("button.mic").bounding_box()
    p.mouse.move(mic["x"] + mic["width"] / 2, mic["y"] + mic["height"] / 2)
    p.mouse.down()
    p.wait_for_timeout(300)
    check("按住麦克风 → 倾听中", "倾听" in status(p), status(p))
    p.wait_for_timeout(5200)
    p.mouse.up()
    t0 = time.time()
    p.wait_for_timeout(200)
    st = status(p)
    wait_status(p, "说话中", 60)
    first_voice = time.time() - t0
    heard = [l for l in logs(p) if " heard " in l]
    check("语音输入被识别", bool(heard), heard[0] if heard else "")
    print(f"  松开到开口: {first_voice:.1f}s  （松开后状态 {st}）")
    p.screenshot(path=f"{SHOTS}/r02_voice_reply.png")

    # 説話中に打断（実 TTS 流式再生中）
    p.wait_for_timeout(800)
    p.mouse.down()
    p.wait_for_timeout(150)
    check("真实 TTS 播放中打断 → 倾听", "倾听" in status(p), status(p))
    p.wait_for_timeout(200)
    p.mouse.up()
    wait_status(p, "待机", 30)
    p.wait_for_timeout(3000)
    lg = logs(p)
    intr = [l for l in lg if " interrupt " in l]
    after = lg[: lg.index(intr[0])] if intr else []
    old_turn = intr[0].split(" ")[1] if intr else "#?"
    late = [l for l in after if " beat " in l and f" {old_turn} " in l]
    check("打断后旧回合节拍不再出现", intr and not late, (intr[0] if intr else "无打断日志") + (f"；之后出现: {late}" if late else ""))
    if late:
        print("  打断前后日志:", lg[: lg.index(intr[0]) + 4])
    print("  语音回复:", [l.split(" beat ")[1] for l in lg if " beat " in l][:4])

    # 生図
    beats = turn_text(p, "你是摄影师吗？能给我看看你最近拍的照片吗？")
    print("  回复:", beats)
    if not p.locator(".photo").count():
        # 写真を出すかはモデルの判断なので、出なければもう一度はっきり頼む
        print("  回复:", turn_text(p, "真的很想看看你拍的照片，就给我看一张吧？"))
    try:
        p.wait_for_selector(".photo", timeout=20000)
        p.screenshot(path=f"{SHOTS}/r03_photo_developing.png")
        p.wait_for_selector(".photo-ready, .photo-failed", timeout=90000)
        ok = p.locator(".photo-ready").count() == 1
        check("真实生图完成", ok, f"耗时 {metrics(p).get('image', '?')}")
        p.screenshot(path=f"{SHOTS}/r04_photo_ready.png")
    except Exception as e:
        check("真实生图完成", False, f"本轮没有触发照片事件: {e.__class__.__name__}")
    m = metrics(p)
    print("  本轮指标:", {k: v for k, v in m.items() if "ms" in v})

    # 观测页
    s = ctx.new_page()
    s.goto(BASE + "/stats")
    s.wait_for_load_state("networkidle")
    s.screenshot(path=f"{SHOTS}/r05_stats.png", full_page=False)
    check("观测页 /stats 可打开", s.locator("table").count() > 0)

    check("页面无 JS 报错", not errors, " | ".join(errors[:3]))
    browser.close()

print(json.dumps({"pass": sum(r["ok"] for r in results), "total": len(results)}))
