// 配乐生成：Lyria（Interactions API）で剧情阶段・結末ごとのループ用 BGM を public/bgm に出力する
// 用法: npm run bgm              生成缺失的曲目
//       npm run bgm chat reveal  只重新生成指定曲目
// 模型与密钥取自 ai_model 表 purpose='music'，每次调用记入 ai_call_log
import fs from "node:fs";
import path from "node:path";
import { getModel, logCall, resolveKey, EMPTY_USAGE } from "../src/lib/aiRegistry";

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

const OUT = path.join(root, "public", "bgm");
const SESSION = `bgm-${new Date().toISOString()}`;
// 全曲共通: 歌なし・効果音なし・音量が一定で頭と終わりが静か（ループ再生でつなぎ目が目立たない）
const COMMON = "Instrumental only, no vocals, no sound effects, no rain sounds. About 2 minutes long with steady, gentle dynamics; begin and end softly at the same tempo so it loops seamlessly.";

const TRACKS: Record<string, string> = {
  meet: "Late-night rainy cafe music. Sparse solo felt piano, slow 68 BPM, D major with soft suspended chords, lots of space and soft room reverb, a hint of distant warm Rhodes. Quiet, slightly lonely, curious.",
  chat: "Warm lo-fi jazz for a cozy late-night cafe conversation. Soft brushed drums, upright bass, mellow Rhodes and felt piano melody, 78 BPM, F major seventh chords, gentle vinyl warmth, relaxed and intimate.",
  reveal: "Tender melancholic piano over a soft string pad, 64 BPM, A minor moving to F major, remembering a rainy night three years ago. Bittersweet and quietly hopeful, gentle swells that never get loud.",
  reunion: "Warm hopeful reunion theme: piano and soft strings with a gentle celesta sparkle, 72 BPM, C major rising progression. Emotional but restrained, like the rain stopping and someone finally arriving.",
  letgo: "Gentle bittersweet theme of letting go after the rain stops: fingerpicked nylon guitar and soft piano, 76 BPM, G major, light and peaceful, a quiet smile.",
  farewell: "Lonely solo piano at closing time on a rainy night, 60 BPM, E minor, sparse and soft, a little sad, slowly fading.",
};

function findAudio(j: unknown): string | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.type === "audio" && typeof o.data === "string") return o.data;
  for (const v of Object.values(o)) {
    const r = findAudio(v);
    if (r) return r;
  }
  return null;
}

async function generate(name: string) {
  const row = getModel("gemini", "music");
  const key = resolveKey(row);
  if (!row || !key) throw new Error("music 用途没有可用模型：请配置 GEMINI_API_KEY");
  const t0 = Date.now();
  const prompt = `${TRACKS[name]} ${COMMON}`;
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: row.model_id, input: prompt, response_format: { type: "audio" } }),
      signal: AbortSignal.timeout(600_000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`gemini ${res.status}: ${json.error?.message ?? res.statusText}`);
    const b64 = findAudio(json);
    if (!b64) throw new Error("no audio in response");
    fs.writeFileSync(path.join(OUT, `${name}.mp3`), Buffer.from(b64, "base64"));
    logCall({ row, provider: "gemini", purpose: "music", modelId: row.model_id, ctx: { sessionId: SESSION }, status: "ok", latencyMs: Date.now() - t0, usage: EMPTY_USAGE, detail: name });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    logCall({ row, provider: "gemini", purpose: "music", modelId: row.model_id, ctx: { sessionId: SESSION }, status: "error", latencyMs: Date.now() - t0, usage: EMPTY_USAGE, error: String((e as Error).message), detail: name });
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const args = process.argv.slice(2).filter((a) => TRACKS[a]);
  const targets = args.length ? args : Object.keys(TRACKS).filter((n) => !fs.existsSync(path.join(OUT, `${n}.mp3`)));
  console.log(`生成配乐：${targets.join(", ") || "（无缺失）"}`);
  const queue = [...targets];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) await generate(queue.shift()!);
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
