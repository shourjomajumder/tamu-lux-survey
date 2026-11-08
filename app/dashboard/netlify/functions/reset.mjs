// POST /api/reset {walker: 1-4 | "all"} — clears a walker's live card, trail and alerts (not uploaded files).
import { getStore } from "@netlify/blobs";
const KEY = process.env.LIVE_KEY || "tamu-lux-2026";
export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (req.headers.get("x-live-key") !== KEY) return new Response("bad key", { status: 401 });
  const b = await req.json().catch(() => ({}));
  const ws = b.walker === "all" ? [1, 2, 3, 4] : [Number(b.walker)];
  const store = getStore({ name: "live", consistency: "strong" });
  for (const w of ws) { await store.delete(`w${w}`); await store.delete(`trail-w${w}`); }
  const log = (await store.get("alerts", { type: "json" })) || [];
  await store.setJSON("alerts", log.filter((x) => !ws.includes(x.walker)));
  return Response.json({ ok: true, cleared: ws });
};
export const config = { path: "/api/reset" };
