// GET /api/assigned?walker=N — for the phone app (x-live-key). Returns the assigned route in the app's
// SurveyRoute format (or {route:null} when nothing is assigned → the phone keeps its default route).
// The assignment is read from MongoDB (walkers collection) when MONGODB_URI is set, else from Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { hasMongo, getDb } from "../lib/db.mjs";

const KEY = process.env.LIVE_KEY || "tamu-lux-2026";

async function fromMongo(w) {
  const doc = await (await getDb()).collection("walkers").findOne({ id: w }, { projection: { assignment: 1 } });
  return (doc && doc.assignment) || null;
}

export default async (req) => {
  const url = new URL(req.url);
  if ((req.headers.get("x-live-key") || url.searchParams.get("k")) !== KEY) return new Response("bad key", { status: 401 });
  const w = Number(url.searchParams.get("walker"));
  let a = null, done = false;
  if (hasMongo()) {
    try { a = await fromMongo(w); done = true; } catch { /* fall back to the Blobs mirror */ }
  }
  if (!done) {
    const store = getStore({ name: "live", consistency: "strong" });
    a = ((await store.get("assignments", { type: "json" })) || {})[w] || null;
  }
  if (!a) return Response.json({ route: null }, { headers: { "cache-control": "no-store" } });
  const lib = await (await fetch(new URL("/route_library.json", req.url))).json();
  const r = lib.find((x) => x.id === a.route_id) || null;
  return Response.json({ route: r, assigned_at: a.at }, { headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/assigned" };
