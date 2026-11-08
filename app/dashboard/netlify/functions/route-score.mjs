// POST /api/route-score {coords:[[lon,lat],...]} (<= 2000 points) — how well lit a route is, from the readings.
// The route is cut into pieces (10 m, or longer for very long routes so there are <= 400 pieces). One MongoDB
// aggregation does the rest: $documents (the piece centres) -> $lookup into readings with $geoNear (12 m around
// each centre, index-backed, near = the piece's point via let) -> median / min lux per piece. Pieces with no
// reading are "unmeasured". (Fallback for servers without $geoNear-in-$lookup: $or of $centerSphere + $facet.)
import { getDb, json, preflight, dbError, groupMedian, medStage, validCoords, lineLength, samplePoints, weightedMedian, r2, EARTH_M } from "../lib/db.mjs";

const CORRIDOR_M = 12, MAX_PIECES = 400;

export async function scoreRoute(db, coords) {
  const length = lineLength(coords);
  const step = Math.max(10, length / MAX_PIECES);
  const S = samplePoints(coords, step);
  let per;
  try {
    const rows = await db.aggregate([
      { $documents: S.map((s, i) => ({ i, p: s.p })) },
      {
        $lookup: {
          from: "readings", let: { p: "$p" }, as: "r",
          pipeline: [
            { $geoNear: { near: { type: "Point", coordinates: "$$p" }, key: "loc", distanceField: "d", maxDistance: CORRIDOR_M, spherical: true } },
            groupMedian(null), medStage(), { $project: { _id: 0, med: 1, min: 1, n: 1 } },
          ],
        },
      },
      { $project: { i: 1, r: { $first: "$r" } } },
    ]).toArray();
    per = rows.sort((a, b) => a.i - b.i).map((x) => x.r || null);
  } catch (e) {
    const circle = (p) => ({ loc: { $geoWithin: { $centerSphere: [p, CORRIDOR_M / EARTH_M] } } });
    const facets = {};
    S.forEach((s, i) => { facets[`p${i}`] = [{ $match: circle(s.p) }, groupMedian(null), medStage(), { $project: { v: 0 } }]; });
    const [res] = await db.collection("readings").aggregate([
      { $match: { $or: S.map((s) => circle(s.p)) } }, { $project: { _id: 0, lux: 1, loc: 1 } }, { $facet: facets },
    ]).toArray();
    per = S.map((s, i) => res[`p${i}`][0] || null);
  }
  const pieces = S.map((s, i) => ({ ...s, ...(per[i] || { med: null, min: null, n: 0 }) }));
  const meas = pieces.filter((p) => p.n > 0);
  const measured = meas.reduce((t, p) => t + p.len, 0);
  const below5 = meas.filter((p) => p.med < 5).reduce((t, p) => t + p.len, 0);
  let darkest = null;
  if (meas.length) {
    const d = meas.reduce((a, b) => (b.med < a.med ? b : a));
    const [seg] = await db.collection("segments").aggregate([
      { $geoNear: { near: { type: "Point", coordinates: d.p }, key: "mid", distanceField: "d", maxDistance: 30, spherical: true } },
      { $match: { name: { $ne: null } } }, { $limit: 1 }, { $project: { name: 1 } },
    ]).toArray();
    darkest = { lat: +d.p[1].toFixed(6), lon: +d.p[0].toFixed(6), lux: r2(d.med), name: seg ? seg.name : null };
  }
  return {
    ok: true, source: "mongodb", length_m: Math.round(length), piece_m: Math.round(step * 10) / 10,
    measured_m: Math.round(measured), measured_share: length ? Math.round((measured / length) * 1000) / 1000 : 0,
    median_lux: r2(weightedMedian(meas.map((p) => ({ v: p.med, w: p.len })))),
    min_lux: meas.length ? r2(Math.min(...meas.map((p) => p.med))) : null,       // darkest piece median
    min_reading_lux: meas.length ? r2(Math.min(...meas.map((p) => p.min))) : null,
    share_below_5: measured ? Math.round((below5 / measured) * 1000) / 1000 : null,   // of the measured length
    darkest,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ ok: false, error: "POST {coords:[[lon,lat],...]}" }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const coords = b && b.coords;
  if (!validCoords(coords, 2000)) return json({ ok: false, error: "coords must be 2-2000 [lon,lat] pairs" }, 400);
  try {
    return json(await scoreRoute(await getDb(), coords.map((p) => [Number(p[0]), Number(p[1])])));
  } catch (e) {
    return dbError(e);
  }
};

export const config = { path: "/api/route-score" };
