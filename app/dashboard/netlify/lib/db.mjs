// Shared MongoDB helper for the Netlify functions. Lives outside netlify/functions so Netlify does not deploy it as an endpoint.
// The MongoClient is cached in module scope so warm invocations reuse the connection.
import { MongoClient } from "mongodb";

export const PASS = process.env.CONTROL_PASS || "4586";
export const LIVE_KEY = process.env.LIVE_KEY || "tamu-lux-2026";
export const DB_NAME = process.env.MONGODB_DB || "lux_survey";
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-control-pass, x-live-key",
  "cache-control": "no-store",
};
export const EARTH_M = 6378100; // radius used by $centerSphere / spherical $geoNear

export const hasMongo = () => !!process.env.MONGODB_URI;
export const json = (obj, status = 200) => Response.json(obj, { status, headers: CORS });
export const preflight = () => new Response(null, { status: 204, headers: CORS });
export const passOk = (req) => req.headers.get("x-control-pass") === PASS;
export const dbError = (e) => json({ ok: false, error: `database unavailable: ${(e && e.message) || e}`.slice(0, 300) }, 503);

let clientP = null;
export async function getDb() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
  if (!clientP) {
    clientP = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5, appName: "tamu-lux" })
      .connect()
      .catch((e) => { clientP = null; throw e; });
  }
  return (await clientP).db(DB_NAME);
}

// Same thresholds as pipeline/fuse_map.py level_words()
export const LEVELS = ["Dark", "Very dim", "Dim", "Adequate", "Well lit", "Bright"];
export const LEVEL_CUTS = [1, 3, 5, 10, 30];
export const levelOf = (lux) => {
  if (lux == null) return "No data";
  const i = LEVEL_CUTS.findIndex((c) => lux < c);
  return LEVELS[i < 0 ? 5 : i];
};
// Aggregation expression giving the level name of a lux field (e.g. "$med")
export const levelExpr = (f) => ({
  $switch: {
    branches: LEVEL_CUTS.map((c, i) => ({ case: { $lt: [f, c] }, then: LEVELS[i] })),
    default: LEVELS[5],
  },
});
export const medianOf = (input) => ({ $median: { input, method: "approximate" } });

// ---------- small geometry helpers (pure)
export function havM(a, b) { // [lon,lat] -> metres
  const R = 6371008.8, r = Math.PI / 180;
  const p1 = a[1] * r, p2 = b[1] * r, dp = p2 - p1, dl = (b[0] - a[0]) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function lineLength(coords) {
  let L = 0;
  for (let i = 1; i < coords.length; i++) L += havM(coords[i - 1], coords[i]);
  return L;
}
// Points every `step` metres along a [lon,lat] line (piece centres), each with its piece length.
export function samplePoints(coords, step) {
  const out = [];
  const L = lineLength(coords);
  if (!(L > 0)) return coords.length ? [{ p: coords[0], len: 0 }] : [];
  const n = Math.max(1, Math.ceil(L / step));
  let i = 1, acc = 0, segL = havM(coords[0], coords[1]);
  for (let k = 0; k < n; k++) {
    const s0 = k * step, s1 = Math.min(L, (k + 1) * step), s = (s0 + s1) / 2;
    while (i < coords.length - 1 && acc + segL < s) { acc += segL; i++; segL = havM(coords[i - 1], coords[i]); }
    const f = segL > 0 ? Math.min(1, Math.max(0, (s - acc) / segL)) : 0;
    const a = coords[i - 1], b = coords[i];
    out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], len: s1 - s0 });
  }
  return out;
}
export function validCoords(c, max = 2000) {
  return Array.isArray(c) && c.length >= 2 && c.length <= max &&
    c.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
}
export function weightedMedian(items) { // [{v, w}]
  const s = items.filter((x) => x.v != null).sort((a, b) => a.v - b.v);
  const W = s.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= W / 2) return x.v; }
  return null;
}
export const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// ---------- coverage (bins collection)
export async function routeCoverage(db) {
  const rows = await db.collection("bins").aggregate([
    { $group: { _id: "$route_id", bins: { $sum: 1 }, len: { $sum: "$len_m" }, cov: { $sum: { $cond: ["$covered", "$len_m", 0] } } } },
    { $lookup: { from: "routes", localField: "_id", foreignField: "route_id", as: "r" } },
    { $unwind: "$r" },
    {
      $project: {
        _id: 0, id: "$_id", name: "$r.name", color: "$r.color", kind: "$r.kind", length_m: { $round: ["$r.length_m", 0] },
        covered_pct: { $round: [{ $multiply: [100, { $divide: ["$cov", { $max: ["$len", 1] }] }] }, 1] },
        uncovered_m: { $round: [{ $subtract: ["$len", "$cov"] }, 0] },
      },
    },
    { $sort: { id: 1 } },
  ]).toArray();
  return rows;
}

// Consecutive covered bins of a route -> pieces of at most `maxBins` bins (gaps-and-islands with $setWindowFields).
export async function coveredPieces(db, maxBins = 20) {
  const rows = await db.collection("bins").aggregate([
    { $match: { covered: true } },
    { $setWindowFields: { partitionBy: "$route_id", sortBy: { k: 1 }, output: { rn: { $documentNumber: {} } } } },
    { $addFields: { run: { $subtract: ["$k", "$rn"] } } },
    { $setWindowFields: { partitionBy: { r: "$route_id", g: "$run" }, sortBy: { k: 1 }, output: { j: { $documentNumber: {} } } } },
    { $group: { _id: { r: "$route_id", g: "$run", c: { $floor: { $divide: [{ $subtract: ["$j", 1] }, maxBins] } } }, bins: { $push: { k: "$k", a: "$a", b: "$b" } } } },
    { $project: { _id: 0, route_id: "$_id.r", bins: { $sortArray: { input: "$bins", sortBy: { k: 1 } } } } },
    { $sort: { route_id: 1, "bins.0.k": 1 } },
  ]).toArray();
  const rd = (p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
  return rows.map((x) => [...x.bins.map((b) => rd(b.a)), rd(x.bins[x.bins.length - 1].b)]);
}

// Mark bins within `m` metres of a point covered (heartbeats).
export async function markCovered(db, lon, lat, walker, t, m = 10) {
  const r = await db.collection("bins").updateMany(
    { covered: false, loc: { $geoWithin: { $centerSphere: [[lon, lat], m / EARTH_M] } } },
    { $set: { covered: true, by: walker, at: t, src: "heartbeat" } },
  );
  return r.modifiedCount;
}

// Exact median of an array expression (numpy-style: mean of the two middle values for even counts),
// used per stretch so the numbers match the published map (pipeline/fuse_map.py uses np.median).
export const exactMedian = (arr) => ({
  $let: {
    vars: { s: { $sortArray: { input: arr, sortBy: 1 } } },
    in: {
      $cond: [{ $eq: [{ $size: "$$s" }, 0] }, null, {
        $avg: [
          { $arrayElemAt: ["$$s", { $floor: { $divide: [{ $subtract: [{ $size: "$$s" }, 1] }, 2] } }] },
          { $arrayElemAt: ["$$s", { $floor: { $divide: [{ $size: "$$s" }, 2] } }] },
        ],
      }],
    },
  },
});
// $group stage computing per-key median lux + count; follow with medStage()
export const groupMedian = (key) => ({ $group: { _id: key, v: { $push: "$lux" }, n: { $sum: 1 }, min: { $min: "$lux" } } });
export const medStage = () => ({ $addFields: { med: exactMedian("$v") } });
