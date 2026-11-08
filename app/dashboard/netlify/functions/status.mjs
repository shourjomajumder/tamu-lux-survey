// GET /api/status — latest state of all walkers (+ trails with ?trail=1).
import { getStore } from "@netlify/blobs";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "no-store" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const store = getStore({ name: "live", consistency: "strong" });
  const url = new URL(req.url);
  const out = { now: Date.now() / 1000, walkers: {}, trails: {}, alerts: [] };
  for (const w of [1, 2, 3, 4]) {
    out.walkers[w] = await store.get(`w${w}`, { type: "json" });
    if (url.searchParams.get("trail")) out.trails[w] = (await store.get(`trail-w${w}`, { type: "json" })) || [];
  }
  out.alerts = ((await store.get("alerts", { type: "json" })) || []).slice(-60).reverse();
  return Response.json(out, { headers: CORS });
};

export const config = { path: "/api/status" };
