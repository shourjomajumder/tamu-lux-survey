"""Fuse everything into the map layers (CPU).

1. Clean light readings: drop moments where a vehicle / headlights were in view or a short
   bright spike passed (car lights), downsample to 1 Hz.
2. Lamps: triangulate light emitters seen in the dark snapshots from >=2 positions; keep only those
   2.5-15 m above ground (car lights are ~0.7 m and move, so they never triangulate).
   Verify each lamp against the light readings (brightness should peak near it).
   Lamp fixtures seen in photos with no emitter nearby -> "possibly out".
3. Trees and emergency phones from pass-2 detections + metric depth (+ OSM emergency phones).
4. Snap clean readings onto OSM footpaths, 5 m segments: median / min / average / evenness,
   plain-language level and low-light warnings, canopy, distance to nearest emergency phone.

Output: results/final/*.geojson, readings_1hz.csv, photos_index.csv, summary.json
"""
import csv, glob, json, math, os, sys, time
from collections import defaultdict
from pathlib import Path
import numpy as np, pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from geo import to_xy, to_ll

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
RES = Path("results"); OUT = RES / "final"; OUT.mkdir(parents=True, exist_ok=True)
VEH = {"car", "truck", "bus", "motorcycle"}
SEG_LEN = 5.0


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def feat(lat, lon, props, geom=None):
    return {"type": "Feature", "geometry": geom or {"type": "Point", "coordinates": [round(float(lon), 7), round(float(lat), 7)]},
            "properties": props}


def dump(name, obj):
    json.dump(obj, open(OUT / name, "w"), separators=(",", ":"))


def read_all(pattern):
    fs = [f for f in sorted(glob.glob(pattern)) if os.path.getsize(f) > 0]
    fs = [f for f in fs if not f.endswith("_objdepth.csv")]
    return pd.concat([pd.read_csv(f) for f in fs], ignore_index=True) if fs else pd.DataFrame()


def level_words(lux):
    if lux is None or lux != lux: return "No data"
    if lux < 1: return "Dark"
    if lux < 3: return "Very dim"
    if lux < 5: return "Dim"
    if lux < 10: return "Adequate"
    if lux < 30: return "Well lit"
    return "Bright"


# ------------------------------------------------------------------ sessions
sessions = sorted(p for p in SESS_ROOT.iterdir() if (p / "session.json").exists())
meta = {s.name: json.load(open(s / "session.json")) for s in sessions}
det = read_all(str(RES / "detections/*.csv"))
world = read_all(str(RES / "world/*.csv"))
scene = read_all(str(RES / "scene/*.csv"))
blobs = read_all(str(RES / "blobs/*.csv"))
if len(world):
    world["row"] = world.groupby("session").cumcount()   # row id within each session file (matches objdepth)
odfs = [pd.read_csv(f) for f in glob.glob(str(RES / "scene/*_objdepth.csv")) if os.path.getsize(f) > 0]
objdepth = pd.concat(odfs, ignore_index=True) if odfs else pd.DataFrame()
print(f"detections {len(det)}  world {len(world)}  scene {len(scene)}  blobs {len(blobs)}  objdepth {len(objdepth)}", flush=True)

# ------------------------------------------------------------------ 1. clean readings
veh_times = defaultdict(list)
if len(det):
    d = det[det["class"].isin(VEH)].copy()
    d["area"] = (d.x1 - d.x0) * (d.y1 - d.y0) / (1080 * 1920)
    for s, e in d[d.area > 0.01][["session", "epoch"]].itertuples(index=False):
        veh_times[s].append(float(e))
if len(world):
    for s, e in world[(world["class"] == "vehicle_light") & (world.conf > 0.2)][["session", "epoch"]].itertuples(index=False):
        veh_times[s].append(float(e))

rows1hz, stats = [], dict(raw=0, vehicle=0, spike=0, kept=0)
for s in sessions:
    p = s / "lux.csv"
    if not p.exists(): continue
    L = pd.read_csv(p)
    L = L[(L.lux > 0) & L.lat.notna() & (L.h_acc.fillna(99) <= 25)].copy()
    if L.empty: continue
    stats["raw"] += len(L)
    L["t"] = L.epoch.astype(float)
    vt = np.sort(np.array(veh_times.get(s.name, []), float))
    if len(vt):
        idx = np.searchsorted(vt, L.t.values)
        near = np.minimum(np.abs(L.t.values - vt[np.clip(idx - 1, 0, len(vt) - 1)]), np.abs(vt[np.clip(idx, 0, len(vt) - 1)] - L.t.values))
        L["veh"] = near <= 2.0
    else:
        L["veh"] = False
    base = L.set_index(pd.to_datetime(L.t, unit="s")).lux.rolling("20s", center=True).median().values
    L["spike"] = L.lux.values > np.maximum(2.5 * base, base + 8)
    # a spike is only a passing light if it is short (< 6 s)
    grp = (L.spike != L.spike.shift()).cumsum()
    dur = L.groupby(grp).t.transform(lambda x: x.max() - x.min())
    L["spike"] = L.spike & (dur < 6)
    stats["vehicle"] += int(L.veh.sum()); stats["spike"] += int((L.spike & ~L.veh).sum())
    K = L[~L.veh & ~L.spike].copy()
    stats["kept"] += len(K)
    K["sec"] = K.t.astype(int)
    g = K.groupby("sec").agg(lux=("lux", "median"), lat=("lat", "median"), lon=("lon", "median"), h_acc=("h_acc", "median"),
                             yaw=("yaw_deg", "median")).reset_index()
    g["session"] = s.name; g["walker"] = int(meta[s.name].get("walker") or s.name[1])
    rows1hz.append(g)
R = pd.concat(rows1hz, ignore_index=True) if rows1hz else pd.DataFrame(columns=["sec", "lux", "lat", "lon", "session", "walker"])
R["x"], R["y"] = to_xy(R.lat, R.lon)
R.round({"lux": 2, "lat": 7, "lon": 7}).to_csv(OUT / "readings_1hz.csv", index=False)
print("readings", stats, "-> 1 Hz rows", len(R), flush=True)

# ------------------------------------------------------------------ 2. lamps from emitter rays
lamps = []
if len(blobs):
    B = blobs[(blobs.elev_deg > 0.3) & (blobs.elev_deg < 75) & (blobs.h_acc.fillna(99) <= 20)].copy()
    B["x"], B["y"] = to_xy(B.lat, B.lon)
    B["t"] = B.epoch.astype(float)
    pts = []   # (x, y, h, ray_i, ray_j)
    for s, G in B.groupby("session"):
        G = G.sort_values("t").reset_index()
        X, Y, T = G.x.values, G.y.values, G.t.values
        br, el = np.radians(G.bearing_deg.values), np.radians(G.elev_deg.values)
        dx, dy = np.sin(br), np.cos(br)
        for i in range(len(G)):
            j0, j1 = np.searchsorted(T, T[i] + 1.0), np.searchsorted(T, T[i] + 90.0)
            if j1 <= j0: continue
            j = np.arange(j0, j1)
            base = np.hypot(X[j] - X[i], Y[j] - Y[i])
            j = j[base >= 3.0]
            if not len(j): continue
            # 2-D line intersection: P_i + a*d_i = P_j + b*d_j
            den = dx[i] * dy[j] - dy[i] * dx[j]
            ok = np.abs(den) > 0.12
            j, den = j[ok], den[ok]
            if not len(j): continue
            ex, ey = X[j] - X[i], Y[j] - Y[i]
            a = (ex * dy[j] - ey * dx[j]) / den
            b = (ex * dy[i] - ey * dx[i]) / den
            ok = (a > 2) & (a < 60) & (b > 2) & (b < 60)
            j, a, b = j[ok], a[ok], b[ok]
            if not len(j): continue
            hi = 1.4 + a * np.tan(el[i]); hj = 1.4 + b * np.tan(el[j])
            ok = (np.abs(hi - hj) < 2.5) & ((hi + hj) / 2 > 2.5) & ((hi + hj) / 2 < 15)
            for jj, aa, hh in zip(j[ok], a[ok], ((hi + hj) / 2)[ok]):
                pts.append((X[i] + aa * dx[i], Y[i] + aa * dy[i], hh, G["index"][i], G["index"][jj]))
    print("emitter ray intersections:", len(pts), flush=True)
    if pts:
        from sklearn.cluster import DBSCAN
        P = np.array([p[:3] for p in pts])
        lab = DBSCAN(eps=3.0, min_samples=4).fit_predict(P[:, :2])
        for c in set(lab) - {-1}:
            m = lab == c
            rays = set()
            for k in np.where(m)[0]:
                rays.add(pts[k][3]); rays.add(pts[k][4])
            sub = B.loc[B.index.isin(list(rays))]
            x, y, h = np.median(P[m, 0]), np.median(P[m, 1]), np.median(P[m, 2])
            spread = float(np.median(np.hypot(P[m, 0] - x, P[m, 1] - y)))
            ccts = sub.cct_k.dropna()
            lamps.append(dict(x=x, y=y, height_m=round(float(h), 1), rays=len(rays), pairs=int(m.sum()),
                              spread_m=round(spread, 1), cct_k=int(ccts.median()) if len(ccts) else None,
                              brightness=round(float(sub["mean"].median()), 1) if len(sub) else None,
                              sessions=sorted(set(sub.session))))

# verify each lamp against the cleaned readings
if lamps and len(R):
    from scipy.spatial import cKDTree
    tree = cKDTree(np.c_[R.x, R.y])
    for L_ in lamps:
        near = R.lux.values[tree.query_ball_point([L_["x"], L_["y"]], 8.0)]
        ring_idx = set(tree.query_ball_point([L_["x"], L_["y"]], 30.0)) - set(tree.query_ball_point([L_["x"], L_["y"]], 15.0))
        ring = R.lux.values[list(ring_idx)]
        L_["lux_near"] = round(float(np.median(near)), 1) if len(near) else None
        L_["lux_ring"] = round(float(np.median(ring)), 1) if len(ring) else None
        L_["peak_ratio"] = round(L_["lux_near"] / max(0.5, L_["lux_ring"]), 2) if (L_["lux_near"] is not None and L_["lux_ring"]) else None
for L_ in lamps:
    score = min(1.0, L_["rays"] / 8) * 0.5 + (0.3 if L_["spread_m"] < 2 else 0.15 if L_["spread_m"] < 3 else 0)
    if L_.get("peak_ratio"): score += 0.2 if L_["peak_ratio"] >= 1.3 else 0.1 if L_["peak_ratio"] >= 1.0 else 0
    L_["confidence"] = round(score, 2)
    c = L_["cct_k"] or 4000
    L_["light_type"] = "sodium / amber" if c < 2600 else "warm white LED" if c < 3600 else "neutral white LED" if c < 5000 else "cool white LED"
lamps = [l for l in lamps if l["confidence"] >= 0.45]
lamp_feats = []
for i, l in enumerate(sorted(lamps, key=lambda l: -l["confidence"])):
    lat, lon = to_ll(l["x"], l["y"])
    p = {k: v for k, v in l.items() if k not in ("x", "y")}; p["id"] = f"L{i + 1:04d}"
    lamp_feats.append(feat(lat, lon, p))
dump("lamps.geojson", fc(lamp_feats))
print("lamps kept:", len(lamp_feats), flush=True)

# ------------------------------------------------------------------ 3. fixtures / trees / phones from photos (+ depth)
def place(dfw, classes, min_conf):
    if not len(dfw): return pd.DataFrame()
    W = dfw[dfw["class"].isin(classes) & (dfw.conf >= min_conf) & dfw.photo_lat.notna()].copy()
    if not len(W): return W
    if len(objdepth):
        od = objdepth[objdepth.source == "world"][["session", "row", "depth_m_median"]]
        W = W.merge(od, on=["session", "row"], how="left")
    else:
        W["depth_m_median"] = np.nan
    W["dist"] = W.depth_m_median.clip(2, 40)
    # fall back: assume typical distance from apparent size when no depth
    W["dist"] = W["dist"].fillna(12.0)
    br = np.radians(W.bearing_deg.astype(float))
    x, y = to_xy(W.photo_lat, W.photo_lon)
    W["x"], W["y"] = x + W.dist * np.sin(br), y + W.dist * np.cos(br)
    W["width_m"] = (W.x1 - W.x0) * W.dist / 1400.0
    W["height_m"] = (W.y1 - W.y0) * W.dist / 1400.0
    return W


def cluster_points(W, eps, min_samples, extra):
    if not len(W): return []
    from sklearn.cluster import DBSCAN
    lab = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(W[["x", "y"]].values)
    out = []
    for c in set(lab) - {-1}:
        G = W[lab == c]
        o = dict(x=float(G.x.median()), y=float(G.y.median()), sightings=len(G), photos=int(G.file.nunique()),
                 conf=round(float(G.conf.median()), 2))
        o.update(extra(G)); out.append(o)
    return out


fixtures = cluster_points(place(world, {"streetlight", "wall_light", "bollard_light"}, 0.30), 4.0, 4,
                          lambda G: dict(kind=G["class"].mode()[0]))
# fixtures with no verified emitter within 7 m, but a dark snapshot was taken nearby facing it -> possibly out
out_feats = []
if fixtures and len(blobs):
    lamp_xy = np.array([[l["x"], l["y"]] for l in lamps]) if lamps else np.zeros((0, 2))
    snaps = blobs.drop_duplicates(["session", "file"])
    for s in sessions:   # snapshots with no blobs still count as "looked"
        p = s / "brackets.csv"
        if p.exists():
            bb = pd.read_csv(p); bb["session"] = s.name
            snaps = pd.concat([snaps, bb[["session", "file", "lat", "lon", "heading_deg"]].rename(columns={"heading_deg": "bearing_deg"})])
    snaps = snaps.dropna(subset=["lat"]).drop_duplicates(["session", "file"])
    sx, sy = to_xy(snaps.lat, snaps.lon)
    for f_ in fixtures:
        if len(lamp_xy) and np.min(np.hypot(lamp_xy[:, 0] - f_["x"], lamp_xy[:, 1] - f_["y"])) < 7: continue
        dist = np.hypot(sx - f_["x"], sy - f_["y"])
        brg = (np.degrees(np.arctan2(f_["x"] - sx, f_["y"] - sy)) + 360) % 360
        facing = np.abs(((brg - snaps.bearing_deg.astype(float).values) + 180) % 360 - 180) < 20
        looks = int(((dist < 25) & facing).sum())
        if looks >= 2 and f_["sightings"] >= 4:
            lat, lon = to_ll(f_["x"], f_["y"])
            out_feats.append(feat(lat, lon, dict(kind=f_["kind"], sightings=f_["sightings"], dark_snapshots_facing=looks,
                                                 status="possibly out", conf=f_["conf"])))
dump("lamps_possibly_out.geojson", fc(out_feats))

trees = cluster_points(place(world, {"tree"}, 0.2), 5.0, 2,
                       lambda G: dict(crown_radius_m=round(float(np.clip(G.width_m.median() / 2, 1.5, 8)), 1),
                                      height_m=round(float(np.clip(G.height_m.quantile(.8), 3, 22)), 1)))
dump("trees.geojson", fc([feat(*to_ll(t["x"], t["y"]), {k: v for k, v in t.items() if k not in ("x", "y")}) for t in trees]))
phones = cluster_points(place(world, {"emergency_phone"}, 0.25), 6.0, 2, lambda G: dict(source="detected"))
print(f"fixtures {len(fixtures)}  possibly out {len(out_feats)}  trees {len(trees)}  phones(detected) {len(phones)}", flush=True)

# ------------------------------------------------------------------ OSM footpaths + emergency phones
osm_ways, osm_phones, osm_lamps, osm_trees, osm_buildings = [], [], [], [], []
def overpass(q):
    import requests
    hdr = {"User-Agent": "tamu-lux-survey/1.0 (TAMU Datathon dataset build)", "Accept": "application/json"}
    for url in ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"):
        for attempt in range(2):
            try:
                r = requests.post(url, data={"data": q}, headers=hdr, timeout=180)
                if r.status_code == 200 and r.text.lstrip().startswith("{"):
                    return r.json()["elements"]
                print("overpass", url, r.status_code, r.text[:160].replace("\n", " "), flush=True)
            except Exception as ex:
                print("overpass failed:", url, ex, flush=True)
            time.sleep(5)
    return []


if len(R):
    la, lo = R.lat.astype(float), R.lon.astype(float)
    bbox = f"{la.quantile(.002) - .002},{lo.quantile(.002) - .002},{la.quantile(.998) + .002},{lo.quantile(.998) + .002}"
    print("bbox", bbox, flush=True)
    cache = Path("/data/osm_cache.json")
    if cache.exists():
        els = json.load(open(cache))
    else:
        els = []
        for q in (f'[out:json][timeout:120];way["highway"~"footway|path|pedestrian|steps|living_street|service|residential|cycleway|track|unclassified|tertiary|secondary|primary"]({bbox});out geom;',
                  f'[out:json][timeout:120];(node["emergency"="phone"]({bbox});node["highway"="street_lamp"]({bbox});node["natural"="tree"]({bbox}););out;',
                  f'[out:json][timeout:180];way["building"]({bbox});out geom;'):
            els += overpass(q)
        if els: json.dump(els, open(cache, "w"))
    for e in els:
        tg = e.get("tags", {})
        if e["type"] == "way" and "geometry" in e and "building" in tg:
            lv = tg.get("building:levels") or ""; h = tg.get("height") or ""
            try: hm = float(str(h).split()[0]) if h else (float(lv) * 3.5 if lv else 10.0)
            except ValueError: hm = 10.0
            osm_buildings.append(feat(0, 0, dict(name=tg.get("name"), height_m=round(hm, 1)),
                geom={"type": "Polygon", "coordinates": [[[round(g["lon"], 7), round(g["lat"], 7)] for g in e["geometry"]]]}))
        elif e["type"] == "way" and "geometry" in e:
            osm_ways.append((e["id"], tg.get("highway"), tg.get("name"), [(g["lat"], g["lon"]) for g in e["geometry"]]))
        elif e["type"] == "node":
            if tg.get("emergency") == "phone": osm_phones.append((e["lat"], e["lon"]))
            elif tg.get("highway") == "street_lamp": osm_lamps.append((e["lat"], e["lon"]))
            elif tg.get("natural") == "tree": osm_trees.append((e["lat"], e["lon"]))
dump("buildings.geojson", fc(osm_buildings))
print("osm buildings", len(osm_buildings), "ways", len(osm_ways), "phones", len(osm_phones), "street lamps", len(osm_lamps), "trees", len(osm_trees), flush=True)
# trees: OpenStreetMap's mapped campus trees near the surveyed paths + trees detected in photos
if osm_trees and len(R):
    from scipy.spatial import cKDTree
    kdR = cKDTree(np.c_[R.x, R.y])
    tx, ty = to_xy([t[0] for t in osm_trees], [t[1] for t in osm_trees])
    near = kdR.query(np.c_[tx, ty], distance_upper_bound=25)[0] < 25
    tf = json.load(open(OUT / "trees.geojson"))
    tf["features"] += [feat(la_, lo_, dict(source="OpenStreetMap", crown_radius_m=4.0, height_m=9.0))
                       for (la_, lo_), ok in zip(osm_trees, near) if ok]
    dump("trees.geojson", tf)
# accuracy check: our triangulated lamps vs lamps mapped in OpenStreetMap (where OSM has them)
lamp_check = None
if osm_lamps and lamp_feats and len(R):
    from scipy.spatial import cKDTree
    kdR = cKDTree(np.c_[R.x, R.y])
    ox, oy = to_xy([t[0] for t in osm_lamps], [t[1] for t in osm_lamps])
    surveyed = kdR.query(np.c_[ox, oy], distance_upper_bound=20)[0] < 20
    O = np.c_[ox, oy][surveyed]
    Lx = np.array([to_xy(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in lamp_feats])
    if len(O):
        dO = cKDTree(Lx).query(O)[0]; dL = cKDTree(O).query(Lx)[0]
        lamp_check = dict(osm_lamps_along_survey=int(len(O)), found_within_10m=round(float((dO < 10).mean()), 3),
                          median_error_m=round(float(np.median(dO[dO < 10])), 1) if (dO < 10).any() else None,
                          our_lamps_matching_osm_within_10m=round(float((dL < 10).mean()), 3))
        print("lamp accuracy vs OSM:", lamp_check, flush=True)
phone_feats = [feat(*to_ll(p["x"], p["y"]), dict(source="detected in photos", sightings=p["sightings"])) for p in phones]
phone_feats += [feat(la_, lo_, dict(source="OpenStreetMap")) for la_, lo_ in osm_phones]
dump("emergency_phones.geojson", fc(phone_feats))
phone_xy = np.array([to_xy(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in phone_feats]) if phone_feats else np.zeros((0, 2))

# ------------------------------------------------------------------ 4. path segments
segs = []      # (x0,y0,x1,y1, way_id, highway, name)
for wid, hw, nm, geom in osm_ways:
    xs, ys = to_xy([g[0] for g in geom], [g[1] for g in geom])
    for k in range(len(xs) - 1):
        L_ = math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]); n = max(1, int(round(L_ / SEG_LEN)))
        for t in range(n):
            a, b = t / n, (t + 1) / n
            segs.append((xs[k] + a * (xs[k + 1] - xs[k]), ys[k] + a * (ys[k + 1] - ys[k]),
                         xs[k] + b * (xs[k + 1] - xs[k]), ys[k] + b * (ys[k + 1] - ys[k]), wid, hw, nm))
assign = np.full(len(R), -1)
if segs and len(R):
    from scipy.spatial import cKDTree
    S = np.array([s[:4] for s in segs], float)
    mids = (S[:, :2] + S[:, 2:]) / 2
    kd = cKDTree(mids)
    P = np.c_[R.x, R.y]
    cand = kd.query(P, k=8, distance_upper_bound=40)[1]
    for i in range(len(P)):
        best, bd = -1, 1e9
        for c in cand[i]:
            if c >= len(segs): continue
            ax, ay, bx, by = S[c]; vx, vy = bx - ax, by - ay
            t = max(0, min(1, ((P[i, 0] - ax) * vx + (P[i, 1] - ay) * vy) / max(1e-9, vx * vx + vy * vy)))
            d = math.hypot(P[i, 0] - ax - t * vx, P[i, 1] - ay - t * vy)
            if d < bd: best, bd = c, d
        if bd <= max(10.0, float(R.h_acc.iloc[i] or 10)): assign[i] = best
R["seg"] = assign
# fallback for readings with no OSM path nearby: 5 m grid cells along the walk
canopy_by_sec = {}
if len(scene):
    sc = scene.copy(); sc["sec"] = sc.epoch.astype(float).astype(int)
    canopy_by_sec = {(a, b): (c, d) for a, b, c, d in sc[["session", "sec", "canopy_overhead", "sidewalk_underfoot"]].itertuples(index=False)}
R["canopy"] = [canopy_by_sec.get((s, t), (np.nan, np.nan))[0] for s, t in zip(R.session, R.sec)]
R["sidewalk"] = [canopy_by_sec.get((s, t), (np.nan, np.nan))[1] for s, t in zip(R.session, R.sec)]

seg_feats, warn_feats = [], []
def seg_props(G):
    lx = G.lux.values
    avg, mn, med = float(lx.mean()), float(np.percentile(lx, 5)), float(np.median(lx))
    return dict(readings=len(G), walkers=sorted(set(int(w) for w in G.walker)), lux_median=round(med, 2), lux_min=round(mn, 2),
                lux_avg=round(avg, 2), evenness=round(avg / max(mn, 0.1), 1), level=level_words(med),
                canopy=round(float(np.nanmean(G.canopy)), 2) if G.canopy.notna().any() else None)

for c, G in R[R.seg >= 0].groupby("seg"):
    ax, ay, bx, by, wid, hw, nm = segs[c]
    (la0, lo0), (la1, lo1) = to_ll(ax, ay), to_ll(bx, by)
    p = seg_props(G); p.update(osm_way=int(wid), path_type=hw, name=nm)
    if len(phone_xy):
        p["nearest_emergency_phone_m"] = int(np.min(np.hypot(phone_xy[:, 0] - (ax + bx) / 2, phone_xy[:, 1] - (ay + by) / 2)))
    seg_feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[round(float(lo0), 7), round(float(la0), 7)], [round(float(lo1), 7), round(float(la1), 7)]]},
                      "properties": p})
# off-network readings -> 5 m cells
off = R[R.seg < 0].copy()
if len(off):
    off["cell"] = list(zip((off.x // SEG_LEN).astype(int), (off.y // SEG_LEN).astype(int)))
    for cell, G in off.groupby("cell"):
        p = seg_props(G); p.update(path_type="off-network")
        la_, lo_ = to_ll((cell[0] + .5) * SEG_LEN, (cell[1] + .5) * SEG_LEN)
        seg_feats.append(feat(la_, lo_, p))
dump("path_lighting.geojson", fc(seg_feats))

# warnings: chain consecutive dark segments along the same OSM way
dark = [f for f in seg_feats if f["properties"]["lux_median"] < 3 or (f["properties"]["lux_avg"] < 5 and f["properties"]["readings"] >= 3)]
by_way = defaultdict(list)
for f in dark:
    by_way[f["properties"].get("osm_way", id(f))].append(f)
for wid, fs in by_way.items():
    pts = np.array([np.mean([c for c in (f["geometry"]["coordinates"] if f["geometry"]["type"] == "LineString" else [f["geometry"]["coordinates"]])], 0) for f in fs])
    from scipy.cluster.hierarchy import fcluster, linkage
    labs = fcluster(linkage(pts, "single"), 0.00012, "distance") if len(pts) > 1 else [1]
    for c in set(labs):
        grp = [fs[i] for i in range(len(fs)) if labs[i] == c]
        med = float(np.median([g["properties"]["lux_median"] for g in grp]))
        length = len(grp) * SEG_LEN
        lo_, la_ = np.mean([np.mean([c for c in (g["geometry"]["coordinates"] if g["geometry"]["type"] == "LineString" else [g["geometry"]["coordinates"]])], 0) for g in grp], 0)
        sev = "high" if (med < 1 and length >= 15) or length >= 40 else "medium" if med < 3 or length >= 15 else "low"
        name = grp[0]["properties"].get("name")
        warn_feats.append(feat(la_, lo_, dict(severity=sev, length_m=length, lux_median=round(med, 2), level=level_words(med),
                                              path=name or grp[0]["properties"].get("path_type"),
                                              text=f"{level_words(med)} stretch, about {int(length)} m, typical {med:.1f} lux (walkway guideline ~5 lux)")))
dump("warnings.geojson", fc(sorted(warn_feats, key=lambda f: {"high": 0, "medium": 1, "low": 2}[f["properties"]["severity"]])))

# ------------------------------------------------------------------ activity (people / vehicles) + photo index
act = []
if len(det):
    A = det[det["class"].isin({"person", "bicycle"} | VEH) & (det.conf >= 0.5) & det.est_lat.notna()].copy()
    A["sec3"] = (A.epoch.astype(float) // 3).astype(int)
    A = A.drop_duplicates(["session", "sec3", "class"])
    for la_, lo_, cl, ep, se in A[["est_lat", "est_lon", "class", "epoch", "session"]].itertuples(index=False):
        act.append(feat(la_, lo_, dict(kind="vehicle" if cl in VEH else cl, t=int(float(ep)), session=se)))
dump("activity.geojson", fc(act))
pi = []
for s in sessions:
    P_ = pd.read_csv(s / "photos.csv")
    P_["session"] = s.name; P_["walker"] = int(meta[s.name].get("walker") or s.name[1])
    pi.append(P_[["session", "walker", "index", "file", "epoch", "lat", "lon", "heading_deg", "linear_y"]])
pd.concat(pi).to_csv(OUT / "photos_index.csv", index=False)

summary = dict(generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), sessions=len(sessions), readings_filter=stats,
               readings_1hz=len(R), lamps=len(lamp_feats), lamps_possibly_out=len(out_feats), trees=len(trees),
               emergency_phones=len(phone_feats), path_segments=len(seg_feats), warnings=len(warn_feats),
               warnings_high=sum(1 for w in warn_feats if w["properties"]["severity"] == "high"), activity_points=len(act), lamp_accuracy_vs_osm=lamp_check, osm_street_lamps=len(osm_lamps),
               level_share={lv: round(sum(1 for f in seg_feats if f["properties"]["level"] == lv) / max(1, len(seg_feats)), 3)
                            for lv in ("Dark", "Very dim", "Dim", "Adequate", "Well lit", "Bright")})
json.dump(summary, open(OUT / "summary.json", "w"), indent=1)
print(json.dumps(summary, indent=1))
