// 立绘生成：基准图 → 编辑出表情/口型/眨眼/动作差分 → 抠绿幕 → public/sprites
// 用法: npm run sprites                  生成缺失的全部差分
//       npm run sprites happy act_sip    只重新生成指定差分
//       npm run sprites all              全部重新生成（旧素材备份到 assets-src/_prev-*）
// 模型与密钥取自 ai_model 表 purpose='sprite'（不限 provider，默认优先），每次调用记入 ai_call_log
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { ModelRow, listByPurpose, resolveKey } from "../src/lib/aiRegistry";
import { trackedGenerate } from "../src/lib/providers/gemini";
import { openaiImage } from "../src/lib/providers/openai";

const root = process.cwd();
const envFile = path.join(root, ".env.local");
const env: Record<string, string> = fs.existsSync(envFile)
  ? Object.fromEntries(
      fs
        .readFileSync(envFile, "utf8")
        .split("\n")
        .filter((l) => /^\s*[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    )
  : {};
process.env.GEMINI_API_KEY ||= env.GEMINI_API_KEY;
process.env.OPENAI_API_KEY ||= env.OPENAI_API_KEY;
const MODELS = listByPurpose("sprite").filter((r) => resolveKey(r));
if (!MODELS.length) {
  console.error("sprite 用途没有可用模型：请在 .env.local 配置 OPENAI_API_KEY / GEMINI_API_KEY，或在 ai_model 表配置 api_key");
  process.exit(1);
}
console.log(`使用模型：${MODELS.map((m) => `${m.provider}/${m.model_id}`).join(" → ")}`);
const SESSION = `sprites-${new Date().toISOString()}`;
const RAW = path.join(root, "assets-src");
const OUT = path.join(root, "public", "sprites");
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const BASE_PROMPT = `High-quality anime illustration in a modern anime key visual style: clean confident lineart, soft cel shading, detailed glossy hair highlights, beautiful expressive eyes.
Original adult woman character named Mira, 26 years old, a travel photographer. Clearly an adult with mature, gentle facial proportions.
Shoulder-length dark brown softly wavy hair with side-swept bangs, warm amber-brown eyes. A small silver star-shaped hairpin clipped on the right side of her bangs.
She wears an amber-orange raincoat with the hood down, slightly damp with a few raindrops, over a cream knit sweater. A dark leather camera strap crosses her chest.
Composition: upper body from the waist up, facing the viewer at a slight three-quarter angle, sitting upright, both arms relaxed and hands resting low out of frame.
Lighting: warm cafe lamp light from the upper left, a subtle cool blue rim light on her hair and shoulders.
Expression: calm, slightly tired, gentle neutral expression, mouth closed, looking at the viewer.
The character is centered, her head in the upper third, and she fills about 85% of the image height. The bottom edge cuts at her waist.
Background: perfectly flat solid pure green (#00FF00) chroma key color, completely uniform, no shadows, no gradient, no floor, no props, no text, no watermark.`;

const KEEP =
  "Edit this image. Keep EXACTLY the same character, face, hairstyle, outfit, art style, camera framing, character size and position, body pose, lighting, and the flat pure green #00FF00 background. Change ONLY the following:";

// name: [元画像, 変更指示]
const VARIANTS: Record<string, [string, string]> = {
  happy: ["neutral", "her facial expression becomes a warm, gentle smile with eyes softly curved, mouth closed."],
  shy: ["neutral", "her facial expression becomes shy and slightly embarrassed: a faint blush on her cheeks, eyes glancing down to the side, a small closed-mouth smile."],
  sad: ["neutral", "her facial expression becomes quietly sad and wistful: inner eyebrows slightly raised, eyes lowered, mouth closed."],
  surprised: ["neutral", "her facial expression becomes surprised: eyes wide open, eyebrows raised, lips parted in a small round 'o'."],
  blink: ["neutral", "close BOTH of her eyes completely: the left eye AND the right eye are both shut, eyelashes resting down, a calm peaceful look as if mid-blink. Absolutely NOT a wink — no eye may remain open. Everything else identical."],
  talk_neutral: ["neutral", "her mouth is open mid-speech, as if saying 'ah'. The rest of the expression stays identical."],
  talk_happy: ["happy", "her mouth is open mid-speech in a smile, as if saying 'ah'. The rest of the expression stays identical."],
  talk_shy: ["shy", "her mouth is slightly open mid-speech, as if softly saying 'ah'. The rest of the expression stays identical."],
  talk_sad: ["sad", "her mouth is slightly open mid-speech, as if quietly saying 'ah'. The rest of the expression stays identical."],
  talk_surprised: ["surprised", "her mouth is open wider mid-speech, as if exclaiming 'ah!'. The rest of the expression stays identical."],
  // 口パク用の中間口形。半開き（子音・音節のつなぎ）と、すぼめた「o/u」
  half_neutral: ["neutral", "her lips are slightly parted mid-speech, a small natural gap between the lips with the upper teeth barely visible, as if between syllables. The rest of the expression stays identical."],
  half_happy: ["happy", "her lips are slightly parted mid-speech in her smile, a small natural gap with the upper teeth barely visible, as if between syllables. The rest of the expression stays identical."],
  half_shy: ["shy", "her lips are barely parted mid-speech, a very small gap, as if softly murmuring. The rest of the expression stays identical."],
  half_sad: ["sad", "her lips are barely parted mid-speech, a very small gap, as if quietly murmuring. The rest of the expression stays identical."],
  half_surprised: ["surprised", "her lips are slightly parted mid-speech, a small gap, as if between syllables. The rest of the expression stays identical."],
  o_neutral: ["neutral", "her lips are rounded and pushed slightly forward into a small 'o' shape mid-speech, as if saying 'oh' or 'woo'. The rest of the expression stays identical."],
  o_happy: ["happy", "her lips are rounded into a small 'o' shape mid-speech, as if saying 'oh', still with a happy look. The rest of the expression stays identical."],
  o_shy: ["shy", "her lips are softly rounded into a small 'o' shape mid-speech, as if quietly saying 'oh'. The rest of the expression stays identical."],
  o_sad: ["sad", "her lips are softly rounded into a small 'o' shape mid-speech, as if quietly saying 'oh'. The rest of the expression stays identical."],
  o_surprised: ["surprised", "her lips are rounded into an 'o' shape mid-speech, as if saying 'oh!'. The rest of the expression stays identical."],
  act_sip: ["neutral", "she raises a white ceramic coffee cup with both hands to just below her lips, about to take a sip, eyes half closed and relaxed. The hands and cup are now visible."],
  act_camera: ["neutral", "she holds a vintage silver-and-black film camera up in front of her face with both hands, looking through the viewfinder, the lens pointing at the viewer. The hands and camera are now visible. Do NOT zoom in or recrop: her head and shoulders must stay at exactly the same position and size as in the original image, and she stays seated in the same spot."],
  act_hairpin: ["neutral", "she raises her right hand to gently touch the silver star hairpin, with a shy faint smile and eyes looking aside. The hand is now visible."],
  act_chin: ["neutral", "she rests her chin on her right hand with her elbow on an unseen table, head tilted slightly, a relaxed attentive look as if listening to a friend. The hand and forearm are now visible."],
  act_laugh: ["happy", "she laughs softly, covering her mouth with the fingertips of her right hand, eyes curved shut with joy. The hand is now visible."],
  act_photo: ["neutral", "she holds out a small printed photograph toward the viewer with both hands at chest height, the back of the photo facing her, a gentle hesitant look. The hands and photo are now visible."],
  act_door: ["surprised", "she turns her head sharply to her right toward an unseen door, eyes wide with sudden hope, lips slightly parted. Body pose unchanged."],
  act_candle: ["neutral", "the room is dark: she holds a small lit white candle in both hands at chest height, warm candlelight from below illuminating her face and hands, the rest of her in soft shadow. The hands and candle are now visible."],
  act_tears: ["sad", "she gently wipes a tear from the corner of her eye with the knuckle of her right index finger, eyes lowered, a sad faint smile. The hand is now visible."],
  act_wave: ["happy", "she raises her right hand beside her face and waves goodbye with a warm smile. The hand is now visible."],
  act_window: ["neutral", "she turns her head toward her left to look out of an unseen window, a wistful three-quarter profile, eyes looking into the distance. Body pose unchanged."],
};

async function callModel(row: ModelRow, prompt: string, image: Buffer | undefined, label: string): Promise<Buffer> {
  if (row.provider === "openai") return openaiImage("sprite", row, { prompt, image }, { sessionId: SESSION }, label);
  const parts = image ? [{ inlineData: { mimeType: "image/png", data: image.toString("base64") } }, { text: prompt }] : [{ text: prompt }];
  const res = await trackedGenerate(
    "sprite",
    row,
    { contents: [{ role: "user", parts }], config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:4" } } },
    { sessionId: SESSION },
    label,
  );
  const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) throw new Error("no image in response");
  return Buffer.from(data, "base64");
}

// 差分は基準図と同じモデルで作る（モデルを混ぜると画風が揃わない）
let pinned: ModelRow | null = null;

async function generate(prompt: string, image: Buffer | undefined, label: string): Promise<Buffer> {
  let lastErr: unknown;
  for (const row of pinned ? [pinned] : MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const buf = await callModel(row, prompt, image, label);
        console.log(`  ✓ ${label} (${row.provider}/${row.model_id})`);
        pinned ??= row;
        return buf;
      } catch (e) {
        lastErr = e;
        if (/404|not found|does not exist|401|403/i.test(String((e as Error)?.message))) break;
      }
      console.log(`  … ${label} retry ${attempt + 1}: ${String((lastErr as Error)?.message).slice(0, 160)}`);
    }
  }
  throw lastErr;
}

// 緑幕を透明化し、縁の緑かぶりを抑える
async function chromaKey(buf: Buffer, outFile: string) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const spill = g - Math.max(r, b);
    if (spill > 90) {
      data[i + 3] = 0;
    } else if (spill > 25) {
      data[i + 3] = Math.round(255 * (1 - (spill - 25) / 65));
      data[i + 1] = Math.max(r, b);
    } else if (spill > 0) {
      data[i + 1] = Math.max(r, b) + Math.round(spill * 0.3);
    }
  }
  await sharp(data, { raw: info }).resize({ height: 1400, withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 95 }).toFile(outFile);
}

// 表情・口パク差分は顔の変化部分だけを元画像へ合成する。
// 画像モデルは編集のたびに全体を描き直すため、そのまま切り替えると服や髪の質感まで揺らいで見える
const FACE_OF: Record<string, string> = {
  happy: "neutral",
  shy: "neutral",
  sad: "neutral",
  surprised: "neutral",
  blink: "neutral",
};

// 口形差分は口の周りだけを親の表情へ合成する。顔全体を貼ると、口を開くたびに目や眉まで微妙に揺れて人形っぽくなる
const MOUTH_PREFIX = ["talk_", "half_", "o_"];
const mouthParent = (n: string) => {
  const p = MOUTH_PREFIX.find((x) => n.startsWith(x));
  return p ? n.slice(p.length) : undefined;
};

type Raw = { data: Buffer; width: number; height: number };

async function loadRaw(buf: Buffer, width?: number, height?: number): Promise<Raw> {
  let img = sharp(buf).removeAlpha();
  if (width && height) img = img.resize(width, height, { fit: "fill" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function blurMask(mask: Buffer, width: number, height: number, sigma: number) {
  // sharp は 1ch 入力でも 3ch で返すため、1ch に戻す
  return sharp(mask, { raw: { width, height, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
}

// 基準図の肌色が最も密集した塊を顔とみなし、その楕円を全差分共通のマスクにする。
// 切替で変わるのは顔の中だけになり、髪や服の描き直しによる揺らぎを防げる
function findFace(base: Raw) {
  const { data, width, height } = base;
  const C = 16;
  const gw = Math.ceil(width / C);
  const gh = Math.ceil((height * 0.55) / C);
  const dens = new Float32Array(gw * gh);
  for (let y = 0; y < Math.min(gh * C, height); y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 190 && g > 130 && b > 100 && r > g && g > b && r - b > 35 && r - b < 120 && r - g < 70) dens[Math.floor(y / C) * gw + Math.floor(x / C)] += 1 / (C * C);
    }
  const seen = new Uint8Array(gw * gh);
  let best: number[] = [];
  for (let s0 = 0; s0 < dens.length; s0++) {
    if (dens[s0] <= 0.7 || seen[s0]) continue;
    const comp: number[] = [];
    const stack = [s0];
    seen[s0] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const cx = c % gw;
      const cy = Math.floor(c / gw);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && dens[n] > 0.7 && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  if (best.length < 20) throw new Error("face_not_found");
  const xs = best.map((c) => (c % gw) * C);
  const ys = best.map((c) => Math.floor(c / gw) * C);
  return { x0: Math.min(...xs), x1: Math.max(...xs) + C, y0: Math.min(...ys), y1: Math.max(...ys) + C };
}

async function faceMask(base: Raw): Promise<Buffer> {
  const { width, height } = base;
  const f = findFace(base);
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  // 肌色塊は眉や髪に隠れた目を取りこぼすので、上と左右へ広げる
  const cx = (f.x0 + f.x1) / 2;
  const cy = (f.y0 + f.y1) / 2 - h * 0.08;
  const rx = (w / 2) * 1.45;
  const ry = (h / 2) * 1.3;
  console.log(`  脸部区域: 中心(${Math.round(cx)},${Math.round(cy)}) 半径(${Math.round(rx)},${Math.round(ry)}) / 图 ${width}x${height}`);
  const hard = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) hard[y * width + x] = 255;
  return blurMask(hard, width, height, Math.max(6, rx * 0.1));
}

// 基準図と talk_neutral の差分のうち顔の下半分にある強い変化の中心を口とみなし、楕円マスクを作る
async function mouthMask(base: Raw, talk: Raw): Promise<Buffer> {
  const { width, height } = base;
  const f = findFace(base);
  const fw = f.x1 - f.x0;
  const fh = f.y1 - f.y0;
  const top = f.y0 + fh * 0.45;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = Math.floor(top); y < Math.min(height, f.y1 + fh * 0.3); y++)
    for (let x = f.x0; x < f.x1; x++) {
      const i = (y * width + x) * 3;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(base.data[i + c] - talk.data[i + c]));
      if (d > 60) {
        xs.push(x);
        ys.push(y);
      }
    }
  if (xs.length < 50) throw new Error("mouth_not_found");
  const med = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const cx = med(xs);
  const cy = med(ys);
  const rx = fw * 0.26;
  const ry = fh * 0.17;
  console.log(`  嘴部区域: 中心(${cx},${cy}) 半径(${Math.round(rx)},${Math.round(ry)})`);
  const hard = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) hard[y * width + x] = 255;
  return blurMask(hard, width, height, Math.max(4, rx * 0.12));
}

function composite(variant: Raw, base: Raw, mask: Buffer): Raw {
  const out = Buffer.from(base.data);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const a = mask[p] / 255;
    if (!a) continue;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(base.data[i + c] * (1 - a) + variant.data[i + c] * a);
  }
  return { data: out, width: base.width, height: base.height };
}

const rawPath = (n: string) => path.join(RAW, `${n}.png`);
const exists = (n: string) => fs.existsSync(rawPath(n));

async function ensureBase(force: boolean) {
  if (exists("neutral") && !force) return;
  console.log("生成基准立绘…");
  fs.writeFileSync(rawPath("neutral"), await generate(BASE_PROMPT, undefined, "neutral"));
}

async function makeVariant(name: string): Promise<void> {
  const [from, change] = VARIANTS[name];
  if (!exists(from)) await makeVariant(from);
  const buf = await generate(`${KEEP} ${change}`, fs.readFileSync(rawPath(from)), name);
  fs.writeFileSync(rawPath(name), buf);
}

async function pool(items: string[], n: number, fn: (s: string) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

function backup() {
  const dest = path.join(RAW, `_prev-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(path.join(dest, "sprites"), { recursive: true });
  for (const f of fs.readdirSync(RAW).filter((f) => f.endsWith(".png"))) fs.renameSync(path.join(RAW, f), path.join(dest, f));
  for (const f of fs.readdirSync(OUT)) fs.renameSync(path.join(OUT, f), path.join(dest, "sprites", f));
  console.log(`旧素材已备份到 ${path.relative(root, dest)}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("all")) backup();
  await ensureBase(args.includes("base"));
  const targets = args.filter((a) => a !== "base" && a !== "all");
  if (targets.length) {
    await pool(targets.filter((t) => VARIANTS[t]), 3, makeVariant);
  } else {
    await pool(["happy", "shy", "sad", "surprised"].filter((n) => !exists(n)), 3, makeVariant);
    await pool(Object.keys(VARIANTS).filter((n) => !exists(n)), 3, makeVariant);
  }

  console.log("合成对齐、抠图并导出…");
  const names = ["neutral", ...Object.keys(VARIANTS)].filter(exists);
  const base = await loadRaw(fs.readFileSync(rawPath("neutral")));
  const raws = new Map<string, Raw>();
  for (const n of names) raws.set(n, n === "neutral" ? base : await loadRaw(fs.readFileSync(rawPath(n)), base.width, base.height));
  const mask = await faceMask(base);
  const mMask = raws.has("talk_neutral") ? await mouthMask(base, raws.get("talk_neutral")!) : mask;
  const done = new Map<string, Raw>([["neutral", base]]);
  // 依存順（表情 → その表情の口形）に処理する
  for (const n of names) {
    if (done.has(n)) continue;
    const mp = mouthParent(n);
    const parent = mp ?? FACE_OF[n];
    done.set(n, parent && done.has(parent) ? composite(raws.get(n)!, done.get(parent)!, mp ? mMask : mask) : raws.get(n)!);
  }
  for (const n of names) {
    const r = done.get(n)!;
    const png = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).png().toBuffer();
    await chromaKey(png, path.join(OUT, `${n}.webp`));
  }
  const meta = await sharp(path.join(OUT, "neutral.webp")).metadata();
  fs.writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify({ width: meta.width, height: meta.height, model: pinned ? `${pinned.provider}/${pinned.model_id}` : undefined, sprites: names }, null, 2),
  );
  console.log(`完成：${names.length} 张 → public/sprites`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
