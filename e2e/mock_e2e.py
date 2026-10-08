"""核心体验在 Mock 模式（无需密钥）下的端到端检查。

用法: python3 e2e/mock_e2e.py [http://localhost:3000]
截图输出到 e2e/shots/。
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
SHOTS = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""), flush=True)


def status(p):
    return p.locator(".status span").inner_text()


def wait_status(p, word, timeout=30):
    t = time.time()
    while time.time() - t < timeout:
        if word in status(p):
            return True
        p.wait_for_timeout(100)
    return False


def watch_states(p, seconds):
    seen, t = [], time.time()
    while time.time() - t < seconds:
        s = status(p).replace("Mira · ", "")
        if not seen or seen[-1] != s:
            seen.append(s)
        p.wait_for_timeout(50)
    return seen


# ページ内で状態テキストと写真カードの変化を全部記録する（短い状態の取りこぼし防止）
TRACE = """
window.__trace = [];
new MutationObserver(() => {
  const s = document.querySelector('.status span')?.textContent || '';
  const ph = document.querySelector('.photo')?.className || '';
  const last = window.__trace[window.__trace.length - 1];
  const cur = s + '|' + ph;
  if (!last || last.v !== cur) window.__trace.push({ t: performance.now(), s, ph, v: cur });
}).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
"""


def trace(p):
    return p.evaluate("window.__trace || []")


def send(p, text):
    p.fill(".controls input", text)
    p.click("button.send")


def log_lines(p):
    return [l.inner_text() for l in p.locator(".log li").all()]


def dd(p, key):
    loc = p.locator(f'.metrics dt:text-is("{key}") + dd')
    return loc.inner_text() if loc.count() else None


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    errors = []

    # ---------- 1. 页面（移动端） ----------
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.grant_permissions(["microphone"])
    p = ctx.new_page()
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.add_init_script(TRACE)
    p.goto(BASE + "/?mock=1")
    p.wait_for_load_state("networkidle")
    p.screenshot(path=f"{SHOTS}/01_intro_mobile.png")
    check("首屏有开场卡片", p.locator(".intro").is_visible())
    sw = p.evaluate("document.documentElement.scrollWidth")
    check("移动端无横向滚动", sw <= 390, f"scrollWidth={sw}")

    p.click("text=推门进去")
    p.wait_for_timeout(8000)
    states = []
    for e in trace(p):
        st = e["s"].replace("Mira · ", "")
        if st and (not states or states[-1] != st):
            states.append(st)
    p.screenshot(path=f"{SHOTS}/02_speaking_mobile.png")
    check("Mock 模式（徽章 MOCK）", p.locator(".badge").inner_text().strip() == "MOCK", p.locator(".badge").inner_text())
    check("呈现 思考→说话 状态", "思考中" in states and "说话中" in states, " → ".join(states))
    wait_status(p, "待机", 30)
    check("回到待机", "待机" in status(p))
    check("有字幕区域并显示台词", p.locator(".subtitle .line").count() > 0, p.locator(".subtitle").inner_text()[:40])
    check("有文字输入和麦克风按钮", p.locator(".controls input").is_visible() and p.locator("button.mic").is_visible())
    chips = p.locator(".choice").all_inner_texts()
    p.screenshot(path=f"{SHOTS}/02b_choices_mobile.png")
    check("说完后出现 3 个回复选项", len(chips) == 3, " ｜ ".join(chips))
    p.locator(".choice").first.click()
    p.wait_for_timeout(300)
    check("点选项即发送：选项消失、进入思考/说话", p.locator(".choice").count() == 0 and ("思考" in status(p) or "说话" in status(p)), status(p))
    wait_status(p, "待机", 30)
    ctx.close()

    # 以降は観測パネル（?debug=1）でログを読むため、パネルが入力欄を塞がない桌面サイズで行う
    ctx = browser.new_context(viewport={"width": 1600, "height": 900})
    ctx.grant_permissions(["microphone"])
    p = ctx.new_page()
    p.add_init_script(TRACE)
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(BASE + "/?mock=1&debug=1")
    p.wait_for_load_state("networkidle")
    p.click("text=推门进去")
    wait_status(p, "待机", 30)

    # ---------- 2. 多轮文字互动 + 表情/动作/场景/生图 ----------
    send(p, "你好，雨好大")
    wait_status(p, "待机", 40)
    send(p, "你拍的照片真好看")
    p.wait_for_selector(".photo", timeout=15000)
    p.screenshot(path=f"{SHOTS}/03_photo_developing.png")
    p.wait_for_selector(".photo-ready", timeout=20000)
    phs = [e["ph"] for e in trace(p) if e["ph"]]
    check("生图事件先出现「显影中」再完成", any("developing" in x for x in phs) and "ready" in phs[-1], " → ".join(dict.fromkeys(x.split()[-1] for x in phs)))
    p.screenshot(path=f"{SHOTS}/04_photo_ready.png")
    check("照片冲洗完成", p.locator(".photo-ready img").count() == 1)
    wait_status(p, "待机", 40)
    beats = [l for l in log_lines(p) if " beat " in l]
    emotions = {l.split(" beat ")[1].split("/")[0] for l in beats}
    actions = {l.split(" beat ")[1].split("/")[1].split(" ")[0] for l in beats}
    check("≥3 种情绪", len(emotions) >= 3, ",".join(sorted(emotions)))
    check("≥2 种非说话动作", len(actions - {"none"}) >= 2, ",".join(sorted(actions)))
    p.locator(".photo .x").first.dispatch_event("click")

    # ---------- 3. 打断 ----------
    send(p, "谢谢你陪我聊天")
    ok = wait_status(p, "说话中", 20)
    p.wait_for_timeout(300)
    sub_before = p.locator(".subtitle").inner_text()
    mic = p.locator("button.mic").bounding_box()
    t0 = time.time()
    p.mouse.move(mic["x"] + mic["width"] / 2, mic["y"] + mic["height"] / 2)
    p.mouse.down()
    p.wait_for_timeout(120)
    st = status(p)
    check("说话中按下麦克风 → 立即切到倾听", ok and "倾听" in st, f"{st}，{int((time.time() - t0) * 1000)}ms 内")
    p.screenshot(path=f"{SHOTS}/05_interrupt_listening.png")
    p.wait_for_timeout(200)
    p.mouse.up()  # 400ms 未満 → 送信せず取消
    p.wait_for_timeout(4000)
    # 桌面端の打断：说话中に空格キーを長押し
    send(p, "嗯嗯")
    ok2 = wait_status(p, "说话中", 20)
    p.evaluate("document.activeElement && document.activeElement.blur()")
    p.keyboard.down("Space")
    p.wait_for_timeout(120)
    st2 = status(p)
    p.keyboard.up("Space")
    check("说话中长按空格 → 立即切到倾听", ok2 and "倾听" in st2, st2)
    p.wait_for_timeout(1500)
    lg = log_lines(p)
    interrupt = [l for l in lg if " interrupt " in l]
    check("日志记录打断并丢弃未播放节拍", bool(interrupt), interrupt[0] if interrupt else "")
    cur_turn = p.evaluate("document.querySelector('.metrics dt + dd')?.textContent")
    later_beats = []
    for it in interrupt:
        old = it.split(" ")[1]
        later_beats += [l for l in lg[: lg.index(it)] if " beat " in l and f" {old} " in l]
    check("打断后旧回合不再播放节拍/字幕", interrupt and not later_beats, f"打断 {len(interrupt)} 次，旧回合打断后新增 beat {len(later_beats)} 条 {later_beats}")

    # ---------- 4. 连续快速输入只播最后一轮 ----------
    for t in ["第一句", "第二句", "嗯嗯"]:
        send(p, t)
        p.wait_for_timeout(150)
    wait_status(p, "待机", 40)
    lg = log_lines(p)
    turns_with_beats = {l.split(" ")[1] for l in lg if " beat " in l}
    superseded = [l for l in lg if " superseded " in l]
    check("快速连发：前两轮被取代", len(superseded) >= 2, f"superseded {len(superseded)} 次")

    # ---------- 5. 只点「推动剧情」的选项（最后一个），一路走到结局 ----------
    seen = {"lights-off": False, "lights-dim": False, "note": False, "narration": False, "phone": False}
    for _ in range(20):
        if p.locator(".ending-card").count():
            break
        if p.locator(".choice").count():
            p.locator(".choice").last.click()
        else:
            send(p, "你在等谁呀？")
        for _ in range(400):
            cls = p.get_attribute(".stage", "class") or ""
            if "lights-off" in cls and not seen["lights-off"]:
                seen["lights-off"] = True
                p.screenshot(path=f"{SHOTS}/06_blackout_candle.png")
            if "lights-dim" in cls:
                seen["lights-dim"] = True
            if p.locator(".note-card").count() and not seen["note"]:
                seen["note"] = True
                p.screenshot(path=f"{SHOTS}/06b_note.png")
            if p.locator(".narration").count() and not seen["narration"]:
                seen["narration"] = True
                p.screenshot(path=f"{SHOTS}/06c_closing.png")
            if p.locator('.sprite-body img.on[src*="act_phone"]').count():
                seen["phone"] = True
            if "待机" in status(p):
                break
            p.wait_for_timeout(100)
        if p.locator(".photo .x").count():
            p.locator(".photo .x").first.dispatch_event("click")
        if p.locator(".note-card .x").count():
            p.locator(".note-card .x").first.dispatch_event("click")
    flags = dd(p, "事件") or ""
    check("环境变化：停电烛光", seen["lights-off"] or "blackout" in flags, flags)
    check("新场景：雨小了、月亮", "moon" in flags, flags)
    check("新场景：留言墙字条卡片", seen["note"])
    check("新场景：手机响（看手机立绘）", seen["phone"] and "phone" in flags)
    check("新场景：店长催打烊（旁白 + 灯光减半）", seen["narration"] and seen["lights-dim"])
    p.wait_for_selector(".ending-card", timeout=20000)
    p.screenshot(path=f"{SHOTS}/07_ending.png")
    check("走到结局卡片", p.locator(".ending-card h2").inner_text() != "", f"{p.locator('.ending-card h2').inner_text()}，信任 {dd(p, '信任')}，事件 {dd(p, '事件')}")
    cls = p.get_attribute(".stage", "class")
    check("天气随剧情变化（结局雨停）", "weather-clear" in cls, cls)
    ctx.close()

    # ---------- 6. 失败注入 ----------
    def fresh(q):
        c = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE + "/?mock=1&debug=1&" + q)
        pg.wait_for_load_state("networkidle")
        pg.click("text=推门进去")
        return c, pg

    c, pg = fresh("fail=tts")
    wait_status(pg, "说话中", 20)
    pg.wait_for_timeout(800)
    toast = pg.locator(".toast").all_inner_texts()
    pg.screenshot(path=f"{SHOTS}/08_fail_tts.png")
    check("TTS 失败 → 提示降级，字幕仍显示", any("降级" in t or "语音" in t for t in toast) and pg.locator(".subtitle .line").count() > 0, " | ".join(toast))
    c.close()

    c, pg = fresh("fail=llm_timeout")
    pg.wait_for_selector(".toast-error", timeout=30000)
    msg = pg.locator(".toast-error").inner_text()
    pg.screenshot(path=f"{SHOTS}/09_fail_timeout.png")
    check("模型超时 → 错误提示 + 重试按钮", "超时" in msg and pg.locator(".toast-error button", has_text="重试").count() == 1, msg.replace("\n", " "))
    check("超时后回到待机", wait_status(pg, "待机", 10), status(pg))
    c.close()

    c, pg = fresh("fail=drop")
    pg.wait_for_selector(".toast-error", timeout=30000)
    wait_status(pg, "待机", 20)
    check("回复中途断线 → 已收到的句子播完 + 提示", "中断" in pg.locator(".toast-error").inner_text() and pg.locator(".subtitle .line").count() > 0, pg.locator(".toast-error").inner_text().replace("\n", " "))
    c.close()

    c, pg = fresh("fail=image")
    wait_status(pg, "待机", 30)
    send(pg, "你拍的照片真好看")
    pg.wait_for_selector(".photo-failed", timeout=30000)
    pg.screenshot(path=f"{SHOTS}/10_fail_image.png")
    check("生图失败 → 失败状态 + 再洗一次", pg.locator("text=再洗一次").count() == 1)
    c.close()

    # ---------- 7. 桌面端 ----------
    c = browser.new_context(viewport={"width": 1440, "height": 900})
    pg = c.new_page()
    pg.goto(BASE + "/?mock=1")
    pg.wait_for_load_state("networkidle")
    pg.click("text=推门进去")
    wait_status(pg, "说话中", 20)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{SHOTS}/11_desktop.png")
    check("桌面端可正常体验", pg.locator(".sprite").is_visible())
    c.close()

    check("页面无 JS 报错", not errors, " | ".join(errors[:3]))
    browser.close()

print(json.dumps({"pass": sum(r["ok"] for r in results), "total": len(results)}))
