"""MongoDB v2: make lux_survey the calculation backend for the website / Survey Control.

Re-runnable (derived collections are dropped and rebuilt). Never prints the connection string.

  walks/photos/detections  the 3 pre-survey test runs are deleted
  readings     rebuilt from results/final/readings_1hz.csv (the filtered 1 Hz night readings the map uses:
               vehicle lights and passing-light spikes removed, test runs dropped). The old per-second docs
               loaded by load_mongo.py are kept once as readings_raw (minus test runs).
               {session, walker, t (epoch s), lux, loc Point, h_acc, heading, seg_id|null}
               seg_id = nearest path stretch (same rule as fuse_map.py: perpendicular distance
               <= max(10 m, GPS accuracy)); readings off the path network go to 5 m "off-network" cells.
  segments     the 3,622 path stretches of path_lighting.geojson, geometry only (no lux stats; the API
               computes them from readings): {seg_id, name, path_type, osm_way, geom LineString, mid Point, length_m}
  routes       route library {route_id, name, color, covers, kind, why, geom LineString, length_m}
  bins         every route cut into 10 m bins {route_id, k, loc Point (bin centre), a, b ([lon,lat] ends),
               len_m, covered, by, at, src}; covered where a survey reading lies within 10 m
  walkers      (empty) Survey Control walkers; positions: heartbeats
"""
import csv, json, math, os, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from pymongo import MongoClient, GEOSPHERE, ASCENDING, DESCENDING, UpdateOne

sys.path.insert(0, str(Path(__file__).parent))
from geo import to_xy, to_ll  # noqa: E402

F = Path(os.environ.get("FINAL_DIR", "results/final"))
ROUTES = Path(os.environ.get("ROUTE_LIBRARY", F / "route_library.json"))
TEST_RUNS = ["W1_2026-11-07_172047", "W1_2026-11-07_172920", "W1_2026-11-07_174431"]
SEG_LEN, BIN_M, COVER_M = 5.0, 10.0, 10.0

db = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=15000)[os.environ.get("MONGODB_DB", "lux_survey")]


def pt(lon, lat):
    return {"type": "Point", "coordinates": [round(float(lon), 7), round(float(lat), 7)]}


def fnum(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def hav(a, b):  # [lon,lat] pairs -> metres
    R = 6371008.8
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


# ---------------------------------------------------------------- 1. test runs out
print("deleting test runs:", {c: db[c].delete_many({"session": {"$in": TEST_RUNS}}).deleted_count
                              for c in ("walks", "readings", "photos", "detections")})

# keep the original per-second readings once, as readings_raw
names = db.list_collection_names()
if "readings" in names and "readings_raw" not in names and not db.readings.find_one({"seg_id": {"$exists": True}}):
    db.readings.rename("readings_raw")
    print("old readings kept as readings_raw:", db.readings_raw.estimated_document_count())
if "readings_raw" in db.list_collection_names():
    db.readings_raw.delete_many({"session": {"$in": TEST_RUNS}})

# ---------------------------------------------------------------- 2. segments
feats = json.load(open(F / "path_lighting.geojson"))["features"]
seg_docs, lines, cells = [], [], {}
for i, f in enumerate(feats):
    p, g = f["properties"], f["geometry"]
    if g["type"] == "LineString":
        (lo0, la0), (lo1, la1) = g["coordinates"][0], g["coordinates"][-1]
        coords = g["coordinates"]
        x0, y0 = to_xy(la0, lo0); x1, y1 = to_xy(la1, lo1)
        lines.append((i, float(x0), float(y0), float(x1), float(y1)))
    else:  # off-network 5 m cell -> short east-west line through the cell centre
        lo, la = g["coordinates"]
        cx, cy = to_xy(la, lo)
        cells[(int(math.floor(float(cx) / SEG_LEN)), int(math.floor(float(cy) / SEG_LEN)))] = i
        (la0, lo0), (la1, lo1) = to_ll(cx - SEG_LEN / 2, cy), to_ll(cx + SEG_LEN / 2, cy)
        coords = [[float(lo0), float(la0)], [float(lo1), float(la1)]]
    coords = [[round(c[0], 7), round(c[1], 7)] for c in coords]
    mid = [(coords[0][0] + coords[-1][0]) / 2, (coords[0][1] + coords[-1][1]) / 2]
    seg_docs.append({"seg_id": i, "name": p.get("name"), "path_type": p.get("path_type"), "osm_way": p.get("osm_way"),
                     "geom": {"type": "LineString", "coordinates": coords}, "mid": pt(*mid),
                     "length_m": round(sum(hav(coords[k], coords[k + 1]) for k in range(len(coords) - 1)), 2)})
db.segments.drop()
db.segments.insert_many(seg_docs)
db.segments.create_index("seg_id", unique=True)
db.segments.create_index([("geom", GEOSPHERE)])
db.segments.create_index([("mid", GEOSPHERE)])

# ---------------------------------------------------------------- 3. readings (+ seg_id)
rows = [r for r in csv.DictReader(open(F / "readings_1hz.csv")) if r["session"] not in TEST_RUNS]
X = np.array([[float(r["x"]), float(r["y"])] for r in rows])
S = np.array([l[1:] for l in lines])
kd = cKDTree((S[:, :2] + S[:, 2:]) / 2)
cand = kd.query(X, k=8, distance_upper_bound=40)[1]
seg_of = []
for i, r in enumerate(rows):
    best, bd = None, 1e9
    for c in cand[i]:
        if c >= len(lines):
            continue
        ax, ay, bx, by = S[c]; vx, vy = bx - ax, by - ay
        t = max(0, min(1, ((X[i, 0] - ax) * vx + (X[i, 1] - ay) * vy) / max(1e-9, vx * vx + vy * vy)))
        d = math.hypot(X[i, 0] - ax - t * vx, X[i, 1] - ay - t * vy)
        if d < bd:
            best, bd = c, d
    if best is not None and bd <= max(10.0, fnum(r["h_acc"]) or 10):
        seg_of.append(lines[best][0])
    else:
        seg_of.append(cells.get((int(math.floor(X[i, 0] / SEG_LEN)), int(math.floor(X[i, 1] / SEG_LEN)))))

docs = [{"session": r["session"], "walker": int(float(r["walker"])), "t": int(float(r["sec"])), "lux": float(r["lux"]),
         "loc": pt(r["lon"], r["lat"]), "h_acc": fnum(r["h_acc"]), "heading": fnum(r["yaw"]), "seg_id": s}
        for r, s in zip(rows, seg_of)]
db.readings.drop()
db.readings.insert_many(docs)
db.readings.create_index([("loc", GEOSPHERE)])
db.readings.create_index([("session", ASCENDING)])
db.readings.create_index([("seg_id", ASCENDING), ("lux", ASCENDING)])
db.readings.create_index([("walker", ASCENDING), ("t", ASCENDING)])

# check against the map file
cnt = {}
for s in seg_of:
    if s is not None:
        cnt[s] = cnt.get(s, 0) + 1
bad = sum(1 for i, f in enumerate(feats) if cnt.get(i, 0) != f["properties"]["readings"])
print(f"readings: {len(docs)}, on a stretch: {sum(s is not None for s in seg_of)}, "
      f"stretches whose reading count differs from path_lighting.geojson: {bad}")

# ---------------------------------------------------------------- 4. routes + 10 m bins
lib = json.load(open(ROUTES))
route_docs, bin_docs = [], []
for r in lib:
    c = [[round(p[1], 7), round(p[0], 7)] for p in r["pts"]]          # library pts are [lat, lon]
    c = [p for k, p in enumerate(c) if k == 0 or p != c[k - 1]]
    cum = [0.0]
    for k in range(1, len(c)):
        cum.append(cum[-1] + hav(c[k - 1], c[k]))
    L = cum[-1]
    route_docs.append({"route_id": int(r["id"]), "name": r["name"], "color": r.get("color"), "covers": r.get("covers"),
                       "kind": r.get("kind"), "why": r.get("why"), "geom": {"type": "LineString", "coordinates": c},
                       "length_m": round(L, 1), "pts": len(c)})

    def at(s, j=[0]):
        while j[0] < len(c) - 2 and cum[j[0] + 1] < s:
            j[0] += 1
        while j[0] > 0 and cum[j[0]] > s:
            j[0] -= 1
        a, b = c[j[0]], c[j[0] + 1]
        seg = cum[j[0] + 1] - cum[j[0]]
        f = 0 if seg <= 0 else min(max((s - cum[j[0]]) / seg, 0), 1)
        return [round(a[0] + (b[0] - a[0]) * f, 7), round(a[1] + (b[1] - a[1]) * f, 7)]

    n = max(1, int(math.ceil(L / BIN_M)))
    for k in range(n):
        s0, s1 = k * BIN_M, min(L, (k + 1) * BIN_M)
        bin_docs.append({"route_id": int(r["id"]), "k": k, "loc": pt(*at((s0 + s1) / 2)), "a": at(s0), "b": at(s1),
                         "len_m": round(s1 - s0, 2), "covered": False, "by": None, "at": None, "src": None})

# survey coverage: any reading within 10 m of the bin centre
rkd = cKDTree(np.c_[to_xy([fnum(r["lat"]) for r in rows], [fnum(r["lon"]) for r in rows])])
bx = np.c_[to_xy([b["loc"]["coordinates"][1] for b in bin_docs], [b["loc"]["coordinates"][0] for b in bin_docs])]
d, j = rkd.query(bx, distance_upper_bound=COVER_M)
for b, dd, jj in zip(bin_docs, d, j):
    if dd <= COVER_M:
        b.update(covered=True, by=docs[jj]["walker"], at=docs[jj]["t"], src="survey")

db.routes.drop()
db.routes.insert_many(route_docs)
db.routes.create_index("route_id", unique=True)
try:
    db.routes.create_index([("geom", GEOSPHERE)])
except Exception as e:  # a self-crossing loop can be rejected by the index; queries don't need it
    print("routes geom index skipped:", str(e)[:120])
db.bins.drop()
db.bins.insert_many(bin_docs)
db.bins.create_index([("route_id", ASCENDING), ("k", ASCENDING)], unique=True)
db.bins.create_index([("loc", GEOSPHERE)])
db.bins.create_index([("covered", ASCENDING)])

# ---------------------------------------------------------------- 5. walkers + positions
if "walkers" not in db.list_collection_names():
    db.create_collection("walkers")
db.walkers.create_index("id", unique=True)
if "positions" not in db.list_collection_names():
    db.create_collection("positions")
db.positions.create_index([("walker", ASCENDING), ("t", DESCENDING)])
db.positions.create_index([("loc", GEOSPHERE)])

# ---------------------------------------------------------------- counts
print({c: db[c].estimated_document_count() for c in
       ("walks", "readings", "readings_raw", "photos", "detections", "segments", "routes", "bins", "walkers", "positions")})
print("bins covered by the survey:", db.bins.count_documents({"covered": True}), "of", len(bin_docs))
print("test-run docs left:", sum(db[c].count_documents({"session": {"$in": TEST_RUNS}})
                                 for c in ("walks", "readings", "readings_raw", "photos", "detections")))
