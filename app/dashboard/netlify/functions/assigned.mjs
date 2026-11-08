// GET /api/assigned — for the phone app (x-live-key), read-only: every current assignment from Survey Control,
//   -> { ok, assignments:[{walker, name, route_id, route_name, length_m, at}] }   (sorted by walker; [] when none)
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

async function listAll(req) {
  const headers = { "cache-control": "no-store" };
  let rows = null; // [{walker, name, route_id, at}]
  if (hasMongo()) {
    try {
      const docs = await (await getDb()).collection("walkers")
        .find({ "assignment.route_id": { $ne: null } }, { projection: { _id: 0, id: 1, name: 1, assignment: 1 } }).sort({ id: 1 }).toArray();
      rows = docs.filter((d) => d.assignment && d.assignment.route_id != null)
        .map((d) => ({ walker: d.id, name: d.name || `Walker ${d.id}`, route_id: Number(d.assignment.route_id), at: d.assignment.at || null }));
    } catch { rows = null; /* fall back to the Blobs mirror */ }
  }
  if (!rows) {
    const store = getStore({ name: "live", consistency: "strong" });
    const a = (await store.get("assignments", { type: "json" })) || {};
    rows = Object.entries(a).filter(([, v]) => v && v.route_id != null)
      .map(([k, v]) => ({ walker: Number(k), name: `Walker ${k}`, route_id: Number(v.route_id), at: v.at || null }))
      .sort((x, y) => x.walker - y.walker);
  }
  let lib = [];
  try { lib = await (await fetch(new URL("/route_library.json", req.url))).json(); } catch { lib = []; }
  const assignments = rows.map((r) => {
    const l = lib.find((x) => x.id === r.route_id) || {};
    return { ...r, route_name: l.name || `Route ${r.route_id}`, length_m: typeof l.total === "number" ? l.total : null };
  });
  return Response.json({ ok: true, assignments }, { headers });
}

export default async (req) => {
  const url = new URL(req.url);
  if ((req.headers.get("x-live-key") || url.searchParams.get("k")) !== KEY) return new Response("bad key", { status: 401 });
  if (!url.searchParams.has("walker")) return listAll(req);
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
