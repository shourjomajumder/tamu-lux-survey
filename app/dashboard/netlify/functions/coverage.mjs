// GET /api/coverage (x-control-pass) — what the survey + live walkers have covered, from the 10 m route bins.
import { getDb, json, preflight, dbError, passOk, routeCoverage, coveredPieces } from "../lib/db.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (!passOk(req)) return json({ ok: false, error: "wrong password" }, 401);
  try {
    const db = await getDb();
    const [routes, covered] = await Promise.all([routeCoverage(db), coveredPieces(db)]);
    return json({ ok: true, source: "mongodb", bin_m: 10, covered, routes });
  } catch (e) {
    return dbError(e);
  }
};

export const config = { path: "/api/coverage" };
