// GET /api/stats — live map numbers, computed by MongoDB from the readings collection.
// readings -> group by seg_id -> median lux per stretch (exact, numpy-style, so it matches the map file)
// -> $median (approximate) for the overall numbers -> shares by level, share below 5 lux, darkest 10 stretches.
import { getDb, json, preflight, dbError, levelExpr, medianOf, groupMedian, medStage, LEVELS, r2 } from "../lib/db.mjs";

let cache = null; // { at, body }

export async function computeStats(db) {
  const R = db.collection("readings");
  const [allRes, stRes] = await Promise.all([
    R.aggregate([{ $group: { _id: null, readings: { $sum: 1 }, median_lux: medianOf("$lux") } }]).toArray(),
    R.aggregate([
      { $match: { seg_id: { $ne: null } } },
      groupMedian("$seg_id"), medStage(), { $project: { v: 0 } },
      {
        $facet: {
          summary: [{
            $group: {
              _id: null, stretches: { $sum: 1 }, below5: { $sum: { $cond: [{ $lt: ["$med", 5] }, 1, 0] } },
              stretch_median_lux: medianOf("$med"),
            },
          }],
          levels: [{ $group: { _id: levelExpr("$med"), n: { $sum: 1 } } }],
          darkest: [
            { $match: { n: { $gte: 3 } } },
            { $sort: { med: 1, n: -1, _id: 1 } },
            { $limit: 10 },
            { $lookup: { from: "segments", localField: "_id", foreignField: "seg_id", as: "s" } },
            { $unwind: "$s" },
            {
              $project: {
                _id: 0, seg_id: "$_id", lux_median: "$med", readings: "$n", name: "$s.name", length_m: "$s.length_m",
                lon: { $arrayElemAt: ["$s.mid.coordinates", 0] }, lat: { $arrayElemAt: ["$s.mid.coordinates", 1] },
                coords: "$s.geom.coordinates",
              },
            },
          ],
        },
      },
    ]).toArray(),
  ]);
  const res = { all: allRes, stretches: stRes };
  const all = res.all[0] || { readings: 0, median_lux: null };
  const st = res.stretches[0] || { summary: [], levels: [], darkest: [] };
  const sum = st.summary[0] || { stretches: 0, below5: 0, stretch_median_lux: null };
  const levels = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const l of st.levels) levels[l._id] = sum.stretches ? Math.round((l.n / sum.stretches) * 1000) / 1000 : 0;
  return {
    ok: true, source: "mongodb", readings: all.readings, stretches: sum.stretches,
    median_lux: r2(all.median_lux), stretch_median_lux: r2(sum.stretch_median_lux),
    share_below_5: sum.stretches ? Math.round((sum.below5 / sum.stretches) * 1000) / 1000 : null,
    levels,
    darkest: st.darkest.map((d) => ({ ...d, lux_median: r2(d.lux_median), length_m: r2(d.length_m) })),
    computed_at: new Date().toISOString(),
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const fresh = new URL(req.url).searchParams.get("fresh");
  if (cache && !fresh && Date.now() - cache.at < 60_000) return json({ ...cache.body, cached: true });
  try {
    const body = await computeStats(await getDb());
    cache = { at: Date.now(), body };
    return json(body);
  } catch (e) {
    return dbError(e);
  }
};

export const config = { path: "/api/stats" };
