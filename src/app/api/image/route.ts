import { getProvider } from "@/lib/providers";
import { withTimeout } from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const cache = new Map<string, string>();

export async function POST(req: Request) {
  const { subject, forceMock, fail, sessionId } = (await req.json()) as { subject: string; forceMock?: boolean; fail?: string; sessionId?: string };
  const provider = getProvider(forceMock);
  const key = `${provider.name}:${subject}`;
  if (fail !== "image" && cache.has(key)) return Response.json({ url: cache.get(key), cached: true });

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    if (fail === "image") {
      await new Promise((r) => setTimeout(r, 1500));
      throw new Error("image_failed");
    }
    const img = await withTimeout(provider.image(subject, ac.signal, { sessionId }), 45_000, ac.signal, "image_timeout");
    const url = `data:${img.mime};base64,${img.b64}`;
    cache.set(key, url);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
