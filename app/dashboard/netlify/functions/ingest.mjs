// POST /api/ingest — one heartbeat from a walker's phone (~every 5 s).
import { getStore } from "@netlify/blobs";

const KEY = process.env.LIVE_KEY || "tamu-lux-2026";
const MAX_TRAIL = 4000;

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (req.headers.get("x-live-key") !== KEY) return new Response("bad key", { status: 401 });
  let b;
  try { b = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  const w = Number(b.walker);
  if (!(w >= 1 && w <= 4)) return new Response("bad walker", { status: 400 });

  const store = getStore({ name: "live", consistency: "strong" });
  b.receivedAt = Date.now() / 1000;
  await store.setJSON(`w${w}`, b);

  if (typeof b.lat === "number" && typeof b.lon === "number") {
    const trail = (await store.get(`trail-w${w}`, { type: "json" })) || [];
    trail.push([Math.round(b.t), +b.lat.toFixed(6), +b.lon.toFixed(6),
                typeof b.lux === "number" ? +b.lux.toFixed(2) : null, b.collecting ? 1 : 0]);
    await store.setJSON(`trail-w${w}`, trail.slice(-MAX_TRAIL));
  }
  if (Array.isArray(b.alerts) && b.alerts.length) {
    const log = (await store.get("alerts", { type: "json" })) || [];
    const last = log.filter((x) => x.walker === w).slice(-1)[0];
    const text = b.alerts[0];
    if (!last || last.text !== text) {
      log.push({ t: b.t, walker: w, text });
      await store.setJSON("alerts", log.slice(-300));
    }
  }
  return Response.json({ ok: true });
};

export const config = { path: "/api/ingest" };
