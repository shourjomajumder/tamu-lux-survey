// GET /api/near?lat=&lon=&r=200 — path stretches within r metres (max 1000), darkest first.
// $geoNear on segments.mid, then $lookup readings by seg_id -> median lux per stretch (all in MongoDB).
import { getDb, json, preflight, dbError, medianOf, groupMedian, medStage, r2 } from "../lib/db.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  const r = Math.min(1000, Math.max(10, Number(q.get("r")) || 200));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !q.get("lat") || !q.get("lon"))
    return json({ ok: false, error: "lat and lon required" }, 400);
  try {
    const db = await getDb();
    const [res] = await db.collection("segments").aggregate([
      { $geoNear: { near: { type: "Point", coordinates: [lon, lat] }, key: "mid", distanceField: "dist_m", maxDistance: r, spherical: true } },
      {
        $lookup: {
          from: "readings", localField: "seg_id", foreignField: "seg_id", as: "rd",
          pipeline: [groupMedian(null), medStage(), { $project: { v: 0 } }],
        },
      },
      { $unwind: "$rd" },
      {
        $facet: {
          summary: [{ $group: { _id: null, n: { $sum: 1 }, below5: { $sum: { $cond: [{ $lt: ["$rd.med", 5] }, 1, 0] } }, med: medianOf("$rd.med") } }],
          stretches: [
            { $sort: { "rd.med": 1, dist_m: 1 } },
            { $limit: 15 },
            { $project: { _id: 0, seg_id: 1, name: 1, lux_median: "$rd.med", readings: "$rd.n", dist_m: 1, coords: "$geom.coordinates" } },
          ],
        },
      },
    ]).toArray();
    const s = res.summary[0] || { n: 0, below5: 0, med: null };
    return json({
      ok: true, source: "mongodb", lat, lon, r, stretches_in_radius: s.n, median_lux: r2(s.med),
      share_below_5: s.n ? Math.round((s.below5 / s.n) * 1000) / 1000 : null,
      stretches: res.stretches.map((x) => ({ ...x, lux_median: r2(x.lux_median), dist_m: Math.round(x.dist_m) })),
    });
  } catch (e) {
    return dbError(e);
  }
};

export const config = { path: "/api/near" };
