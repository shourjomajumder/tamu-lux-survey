// GET /api/suggest (x-control-pass) — next routes to send walkers on: most uncovered metres first,
// skipping routes that are currently assigned to a walker.
import { getDb, json, preflight, dbError, passOk, routeCoverage } from "../lib/db.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (!passOk(req)) return json({ ok: false, error: "wrong password" }, 401);
  try {
    const db = await getDb();
    const taken = new Set((await db.collection("walkers").distinct("assignment.route_id")).filter((x) => x != null));
    const suggestions = (await routeCoverage(db))
      .filter((r) => !taken.has(r.id) && Number(r.id) > 100)   // last night's loops (ids 1-4) are never suggested
      .sort((a, b) => (b.uncovered_m / (b.length_m || 1)) - (a.uncovered_m / (a.length_m || 1)))   // most new first
      .slice(0, 5)
      .map((r) => ({ route_id: r.id, name: r.name, length_m: r.length_m, uncovered_m: r.uncovered_m, covered_pct: r.covered_pct }));
    return json({ ok: true, source: "mongodb", assigned_routes: [...taken], suggestions });
  } catch (e) {
    return dbError(e);
  }
};

export const config = { path: "/api/suggest" };
