// /api/control — Survey Control panel (password-protected, header x-control-pass).
// With MONGODB_URI set, walkers/assignments/positions/coverage live in MongoDB (lux_survey);
// without it the old Netlify-Blobs-only behaviour is used. Heartbeats are always also written to Blobs
// so /api/status (live dashboard) keeps working, and assignments are mirrored to Blobs.
//   GET                -> { ok, walkers:[{id,name,color,assignment,last,created,app}], assignments:{id:{route_id,at}} }
//                         (walker data older than `created` belongs to an earlier walker with the same id)
//   GET  ?walker=N     -> { ok, assignment, route }   (route incl. coords + steps, for the web walker mode)
//   POST {action:"add_walker", name, color}      -> { ok, walker }
//   POST {action:"remove_walker", walker}
//   POST {action:"assign", walker, route_id}
//   POST {action:"clear", walker}
//   POST {action:"heartbeat", walker, lat, lon, h_acc, heading, speed, route_pct, ...}
//        -> saves position, updates walker.last, marks 10 m route bins within 10 m covered
//   POST {action:"hello", walker, device, app_version}  (phone app on startup; x-control-pass or x-live-key)
//        -> { ok, walker:{id,name,color}, assignment, route }   and records walker.app = {device, app_version, seen_at}
//   POST {action:"recompute_coverage"}           -> re-marks heartbeat coverage from all stored positions
import { getStore } from "@netlify/blobs";
import { CORS, PASS, LIVE_KEY, EARTH_M, hasMongo, getDb, json, preflight, dbError, markCovered } from "../lib/db.mjs";

const COLORS = ["#C05621", "#2B6CB0", "#2F855A", "#6B46C1", "#B83280", "#2C7A7B", "#975A16", "#4A5568"];
const now = () => Date.now() / 1000;

async function library(req) {
  try { return await (await fetch(new URL("/route_library.json", req.url))).json(); } catch { return []; }
}

async function blobHeartbeat(store, w, b) {
  const hb = { ...b, walker: w, source: "web", receivedAt: now(), t: b.t || now() };
  delete hb.action;
  await store.setJSON(`w${w}`, hb);
  if (typeof b.lat === "number" && typeof b.lon === "number") {
    const trail = (await store.get(`trail-w${w}`, { type: "json" })) || [];
    trail.push([Math.round(hb.t), +b.lat.toFixed(6), +b.lon.toFixed(6), null, 1]);
    await store.setJSON(`trail-w${w}`, trail.slice(-4000));
  }
  return hb;
}

// ------------------------------------------------------------------ old Blobs-only behaviour
async function blobsOnly(req, store, b) {
  let a = (await store.get("assignments", { type: "json" })) || {};
  if (req.method === "POST") {
    const w = Number(b.walker);
    if (!(w >= 1 && w <= 4)) return json({ ok: false, error: "bad walker" }, 400);
    if (b.action === "hello") {
      const apps = (await store.get("apps", { type: "json" })) || {};
      apps[w] = appInfo(b);
      await store.setJSON("apps", apps);
      const as = a[w] || null;
      const route = as ? (await library(req)).find((x) => x.id === as.route_id) || null : null;
      return json({ ok: true, walker: { id: w, name: `Walker ${w}`, color: COLORS[(w - 1) % COLORS.length] }, assignment: as, route });
    }
    if (b.action === "remove_walker") {
      delete a[w];
      const apps = (await store.get("apps", { type: "json" })) || {};
      if (apps[w]) { delete apps[w]; await store.setJSON("apps", apps); }
    }
    if (b.action === "heartbeat") {
      await blobHeartbeat(store, w, b);
      return json({ ok: true, assignment: a[w] || null });
    }
    if (b.action === "assign") a[w] = { route_id: Number(b.route_id), at: now() };
    else if (b.action === "clear") delete a[w];
    await store.setJSON("assignments", a);
  }
  const qw = Number(new URL(req.url).searchParams.get("walker"));
  if (req.method === "GET" && qw >= 1 && qw <= 4) {
    const as = a[qw] || null;
    const route = as ? (await library(req)).find((x) => x.id === as.route_id) || null : null;
    return json({ ok: true, assignment: as, route });
  }
  return json({ ok: true, assignments: a, apps: (await store.get("apps", { type: "json" })) || {} });
}

// ------------------------------------------------------------------ MongoDB
const shape = (w) => ({ id: w.id, name: w.name, color: w.color, assignment: w.assignment || null, last: w.last || null,
  created: w.created || null, app: w.app || null });
const appInfo = (b) => ({ device: String(b.device || "").slice(0, 60) || null, app_version: String(b.app_version || "").slice(0, 30) || null, seen_at: now() });

// The walker's route in the shape GET ?walker=N returns (incl. coords + steps), or null.
async function routeFor(db, req, as) {
  if (!as) return null;
  const r = await db.collection("routes").findOne({ route_id: as.route_id }, { projection: { _id: 0 } });
  const lib = (await library(req)).find((x) => x.id === as.route_id) || {};
  if (!r && !lib.id) return null;
  const coords = r ? r.geom.coordinates : (lib.pts || []).map((p) => [p[1], p[0]]);
  return { ...lib, id: as.route_id, route_id: as.route_id, name: (r && r.name) || lib.name, color: (r && r.color) || lib.color,
    length_m: r ? r.length_m : lib.total, coords, pts: lib.pts || coords.map((p) => [p[1], p[0]]), steps: lib.steps || [] };
}

async function listing(db) {
  const walkers = (await db.collection("walkers").find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray()).map(shape);
  const assignments = Object.fromEntries(walkers.filter((w) => w.assignment).map((w) => [w.id, w.assignment]));
  return { ok: true, source: "mongodb", walkers, assignments };
}

async function ensureWalker(db, w) {
  await db.collection("walkers").updateOne(
    { id: w },
    { $setOnInsert: { id: w, name: `Walker ${w}`, color: COLORS[(w - 1) % COLORS.length], assignment: null, last: null, created: now() } },
    { upsert: true },
  );
}

async function mirrorAssignments(db, store) {
  try {
    const { assignments } = await listing(db);
    await store.setJSON("assignments", assignments);
  } catch { /* the Blobs mirror is best effort */ }
}

async function withMongo(req, store, b, hb) {
  const db = await getDb();
  const W = db.collection("walkers");
  if (req.method === "POST") {
    if (b.action === "add_walker") {
      for (let tries = 0; tries < 5; tries++) {
        const top = await W.find().sort({ id: -1 }).limit(1).toArray();
        const id = (top[0] ? top[0].id : 0) + 1;
        const doc = { id, name: String(b.name || `Walker ${id}`).slice(0, 40), color: String(b.color || COLORS[(id - 1) % COLORS.length]).slice(0, 20), assignment: null, last: null, app: null, created: now() };
        try {
          await W.insertOne(doc); delete doc._id;
          // a brand-new walker starts clean: no position/assignment left over from an earlier walker with this id
          await W.updateOne({ id }, { $set: { last: null, assignment: null, app: null } });
          await mirrorAssignments(db, store);
          return json({ ok: true, walker: shape(doc) });
        } catch (e) { if (e.code !== 11000) throw e; }
      }
      return json({ ok: false, error: "could not allocate walker id" }, 409);
    }
    if (b.action === "recompute_coverage") {
      // reset heartbeat coverage and re-mark it from every stored position (survey coverage is kept)
      const bins = db.collection("bins");
      await bins.updateMany({ src: "heartbeat" }, { $set: { covered: false, by: null, at: null, src: null } });
      const ops = [];
      for await (const p of db.collection("positions").find({ $or: [{ h_acc: null }, { h_acc: { $lte: 25 } }] }).sort({ t: 1 })) {
        ops.push({ updateMany: { filter: { covered: false, loc: { $geoWithin: { $centerSphere: [p.loc.coordinates, 10 / EARTH_M] } } }, update: { $set: { covered: true, by: p.walker, at: p.t, src: "heartbeat" } } } });
      }
      let marked = 0;
      for (let i = 0; i < ops.length; i += 500) marked += (await bins.bulkWrite(ops.slice(i, i + 500), { ordered: true })).modifiedCount;
      return json({ ok: true, positions: ops.length, bins_marked: marked });
    }
    const w = Number(b.walker);
    if (!(Number.isInteger(w) && w >= 1 && w <= 99)) return json({ ok: false, error: "bad walker" }, 400);
    if (b.action === "hello") {
      await ensureWalker(db, w);
      await W.updateOne({ id: w }, { $set: { app: appInfo(b) } });
      const doc = await W.findOne({ id: w });
      const as = (doc && doc.assignment) || null;
      return json({ ok: true, source: "mongodb", walker: { id: w, name: doc.name, color: doc.color }, assignment: as, route: await routeFor(db, req, as) });
    }
    if (b.action === "remove_walker") {
      // clear first, so even if the delete races with a heartbeat upsert the re-created id starts clean
      await W.updateOne({ id: w }, { $set: { assignment: null, last: null, app: null } });
      const r = await W.deleteOne({ id: w });
      await mirrorAssignments(db, store);
      return json({ ...(await listing(db)), removed: r.deletedCount });
    }
    if (b.action === "heartbeat") {
      await ensureWalker(db, w);
      const lat = Number(b.lat), lon = Number(b.lon);
      let marked = 0;
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const t = Number(hb.t) || now();
        const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
        const pos = { walker: w, t, received: now(), loc: { type: "Point", coordinates: [lon, lat] }, h_acc: num(b.h_acc), heading: num(b.heading), speed: num(b.speed), route_pct: num(b.route_pct), lux: num(b.lux) };
        await db.collection("positions").insertOne(pos);
        await W.updateOne({ id: w }, { $set: { last: { lat, lon, t, heading: pos.heading, route_pct: pos.route_pct } } });
        if (!(pos.h_acc > 25)) marked = await markCovered(db, lon, lat, w, t, 10);
      }
      const doc = await W.findOne({ id: w });
      return json({ ok: true, assignment: (doc && doc.assignment) || null, bins_marked: marked });
    }
    if (b.action === "assign") {
      const rid = Number(b.route_id);
      if (!(await db.collection("routes").findOne({ route_id: rid }, { projection: { _id: 1 } }))) return json({ ok: false, error: "unknown route" }, 400);
      await ensureWalker(db, w);
      await W.updateOne({ id: w }, { $set: { assignment: { route_id: rid, at: now() } } });
    } else if (b.action === "clear") {
      await W.updateOne({ id: w }, { $set: { assignment: null } });
    } else {
      return json({ ok: false, error: "unknown action" }, 400);
    }
    await mirrorAssignments(db, store);
    return json(await listing(db));
  }
  const qw = Number(new URL(req.url).searchParams.get("walker"));
  if (qw >= 1) {
    const doc = await W.findOne({ id: qw });
    const as = (doc && doc.assignment) || null;
    return json({ ok: true, source: "mongodb", assignment: as, route: await routeFor(db, req, as) });
  }
  return json(await listing(db));
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let b = null, hb = null;
  if (req.method === "POST") {
    try { b = await req.json(); } catch { b = undefined; }
    if (!b || typeof b !== "object") b = undefined;
  }
  const passOk = req.headers.get("x-control-pass") === PASS;
  // the phone app's startup hello may use the live key (same as /api/assigned and /api/ingest)
  const liveOk = !!b && b.action === "hello" && req.headers.get("x-live-key") === LIVE_KEY;
  if (!passOk && !liveOk) return json({ ok: false, error: "wrong password" }, 401);
  if (req.method === "POST" && !b) return json({ ok: false, error: "bad json" }, 400);
  const store = getStore({ name: "live", consistency: "strong" });
  if (!hasMongo()) return blobsOnly(req, store, b);
  if (req.method === "POST") {
    const w = Number(b && b.walker);
    // heartbeat goes to Blobs first, so the live dashboard (/api/status) works even if MongoDB is down
    if (b && b.action === "heartbeat" && Number.isInteger(w) && w >= 1 && w <= 99) hb = await blobHeartbeat(store, w, b);
  }
  try {
    return await withMongo(req, store, b, hb);
  } catch (e) {
    if (hb) {
      const a = ((await store.get("assignments", { type: "json" })) || {})[hb.walker] || null;
      return json({ ok: true, assignment: a, db: false, error: `database unavailable: ${e.message || e}`.slice(0, 200) });
    }
    return dbError(e);
  }
};

export const config = { path: "/api/control" };
