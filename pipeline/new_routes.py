"""New-path routes for Survey Control: walk what has NOT been collected yet.

1. Walkable graph from the cached OpenStreetMap ways (/data/osm_cache.json, written by fuse_map.py's overpass();
   same highway classes fuse_map queries), clipped to the survey area (bbox of the readings + 300 m), largest
   connected piece. Every way is cut into <= 10 m pieces (graph edges).
2. A piece is "collected" if a survey reading (readings_1hz.csv, test runs already dropped) lies within 15 m.
3. Uncollected walkway length is clustered into areas (length-weighted k-means; k = K-2 .. K+1 and 3 seeds are tried,
   the split giving the most routes >= 3 km and >= 70 % new wins). For each area, a route starts at a walkable node
   on the area's edge facing the campus core, next to a named landmark/building, then greedily chains: walk on along
   uncollected pieces; when none is adjacent, shortest path (Dijkstra; collected paths cost more) to the nearby
   uncollected piece with the most new path behind it; repeat until ~4.2 km, then end at the longest prefix that
   stays >= 70 % new. Routes do not return to their start. Parallel duplicates (a road centre line next to its
   sidewalk, every other parking aisle) are not targeted twice, and don't count as new.
4. Library = the 4 original loops (ids 1-4) + the new routes (ids 201+); the recheck loops are dropped.
   Writes route_library.json (full) and route_library_light.json (no cum/steps; steps_count instead).

usage: python pipeline/new_routes.py [--osm /data/osm_cache.json] [--final results/final] [--k 8]
"""
import argparse, csv, heapq, json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from geo import to_xy, to_ll  # noqa: E402
from routekit import make_steps  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--osm", default="/data/osm_cache.json")
ap.add_argument("--final", default="results/final")
ap.add_argument("--library", default=None, help="library to take the original loops from (default <final>/route_library.json)")
ap.add_argument("--out", default=None, help="output folder (default = --final)")
ap.add_argument("--k", type=int, default=8, help="number of routes wanted (areas tried: k-2 .. k+1)")
ap.add_argument("--budget", type=float, default=4200.0, help="target route length, m")
ap.add_argument("--max-len", type=float, default=5000.0)
ap.add_argument("--min-len", type=float, default=2000.0)
ap.add_argument("--seed", type=int, default=7)
A = ap.parse_args()
F = Path(A.final); OUT = Path(A.out or A.final); OUT.mkdir(parents=True, exist_ok=True)
LIB_IN = Path(A.library or F / "route_library.json")

BAD_NAME = lambda nm: any(w in nm.lower() for w in ("garage", "parking", "substation", "utility", "chiller"))
PIECE_M, COLLECT_M, MARGIN_M = 10.0, 15.0, 300.0
WALK = {"footway", "path", "pedestrian", "steps", "living_street", "service", "residential", "cycleway", "track",
        "unclassified", "tertiary", "secondary", "primary",
        "tertiary_link", "secondary_link", "primary_link"}             # = fuse_map.py's Overpass regex (matches *_link too)
NOT_TARGET_HW = {"primary", "secondary", "primary_link", "secondary_link", "tertiary_link"}   # big roads: sidewalks mapped separately
NOT_TARGET_SERVICE = {"driveway", "drive-through", "emergency_access"}
ROAD_HW = {"service", "residential", "unclassified", "tertiary", "secondary", "primary", "living_street", "track",
           "tertiary_link", "secondary_link", "primary_link"}
# distinct, no red (#e3241b = warnings/collected), none of the walker colours, same mid/dark tone as loops 1-4
COLORS = ["#0987A0", "#B7791F", "#4C51BF", "#6B8E23", "#3B9EDB", "#9F7AEA", "#48BB78", "#A68A64"]

# ------------------------------------------------------------------ readings + area
rows = list(csv.DictReader(open(F / "readings_1hz.csv")))
la = np.array([float(r["lat"]) for r in rows]); lo = np.array([float(r["lon"]) for r in rows])
RX, RY = to_xy(la, lo)
R = np.c_[RX, RY]
rkd = cKDTree(R)
x0, x1 = np.quantile(RX, [.002, .998]); y0, y1 = np.quantile(RY, [.002, .998])
x0, x1, y0, y1 = x0 - MARGIN_M, x1 + MARGIN_M, y0 - MARGIN_M, y1 + MARGIN_M
CORE = np.median(R, axis=0)
print(f"readings {len(R)}, area {x1 - x0:.0f} x {y1 - y0:.0f} m", flush=True)

# ------------------------------------------------------------------ OSM ways -> graph of <= 10 m pieces
els = json.load(open(A.osm))
ways, named_places = [], []
for e in els:
    tg = e.get("tags", {}) or {}
    if e.get("type") != "way" or "geometry" not in e:
        continue
    if "building" in tg:
        nm = tg.get("name")
        if nm and not BAD_NAME(nm):
            g = e["geometry"]; bx, by = to_xy(np.mean([p["lat"] for p in g]), np.mean([p["lon"] for p in g]))
            named_places.append((float(bx), float(by), nm, "building"))
        continue
    hw = tg.get("highway")
    if hw not in WALK:
        continue
    if tg.get("foot") in ("no", "private") or (tg.get("access") in ("no", "private") and tg.get("foot") not in ("yes", "designated", "permissive")):
        continue
    if tg.get("area") == "yes" and hw not in ("pedestrian", "footway"):
        continue
    ways.append((e.get("id"), hw, tg, e["geometry"], e.get("nodes")))
print("osm ways (walkable classes):", len(ways), flush=True)

nodes, nkey = [], {}
def node(key, x, y):
    if key not in nkey:
        nkey[key] = len(nodes); nodes.append((x, y))
    return nkey[key]

# piece: a, b, length, way index
PA, PB, PL, PW = [], [], [], []
for wi, (wid, hw, tg, geom, nids) in enumerate(ways):
    gx, gy = to_xy([p["lat"] for p in geom], [p["lon"] for p in geom])
    use_ids = nids is not None and len(nids) == len(geom)
    keys = [("n", nids[k]) if use_ids else ("c", round(float(gx[k]) * 2), round(float(gy[k]) * 2)) for k in range(len(geom))]
    for k in range(len(geom) - 1):
        ax_, ay_, bx_, by_ = float(gx[k]), float(gy[k]), float(gx[k + 1]), float(gy[k + 1])
        mx, my = (ax_ + bx_) / 2, (ay_ + by_) / 2
        if not (x0 <= mx <= x1 and y0 <= my <= y1):
            continue
        L = math.hypot(bx_ - ax_, by_ - ay_)
        if L < 0.05:
            continue
        n = max(1, int(math.ceil(L / PIECE_M)))
        prev = node(keys[k], ax_, ay_)
        for t in range(1, n + 1):
            if t == n:
                cur = node(keys[k + 1], bx_, by_)
            else:
                f = t / n
                cur = node(("s", wi, k, t), ax_ + f * (bx_ - ax_), ay_ + f * (by_ - ay_))
            if cur != prev:
                PA.append(prev); PB.append(cur); PL.append(L / n); PW.append(wi)
            prev = cur
PA, PB, PL, PW = map(np.array, (PA, PB, PL, PW))
N = np.array(nodes)
print(f"graph: {len(N)} nodes, {len(PA)} pieces, {PL.sum() / 1000:.1f} km", flush=True)

# largest connected component
parent = list(range(len(N)))
def find(u):
    while parent[u] != u:
        parent[u] = parent[parent[u]]; u = parent[u]
    return u
for a, b in zip(PA, PB):
    ra, rb = find(a), find(b)
    if ra != rb: parent[ra] = rb
roots = np.array([find(u) for u in range(len(N))])
big = np.bincount(roots).argmax()
keep = roots[PA] == big
print(f"largest connected piece: {keep.mean() * 100:.1f}% of pieces", flush=True)
PA, PB, PL, PW = PA[keep], PB[keep], PL[keep], PW[keep]
NP = len(PA)
MID = (N[PA] + N[PB]) / 2
DIR = N[PB] - N[PA]; DIR = DIR / np.maximum(1e-9, np.linalg.norm(DIR, axis=1))[:, None]
HW = np.array([ways[w][1] for w in PW])
NAME = [ways[w][2].get("name") or "" for w in PW]
adj = {}
for p, (a, b) in enumerate(zip(PA, PB)):
    adj.setdefault(int(a), []).append((int(b), p)); adj.setdefault(int(b), []).append((int(a), p))

# ------------------------------------------------------------------ collected / targets
dmin = rkd.query(MID, distance_upper_bound=COLLECT_M)[0]
collected = dmin <= COLLECT_M
svc = np.array([ways[w][2].get("service", "") for w in PW])
is_target = (~collected) & (~np.isin(HW, list(NOT_TARGET_HW))) & (~np.isin(svc, list(NOT_TARGET_SERVICE)))
is_road = np.isin(HW, list(ROAD_HW))
aisle = svc == "parking_aisle"
print(f"collected {PL[collected].sum() / 1000:.1f} km, uncollected {PL[~collected].sum() / 1000:.1f} km, "
      f"targetable {PL[is_target].sum() / 1000:.1f} km (walkways {PL[is_target & ~is_road].sum() / 1000:.1f} km)", flush=True)
mkd = cKDTree(MID)

def parallels(p):
    """Target pieces running alongside piece p 3-14 m away (sidewalk <-> road centre line): one walk covers both.
    Parking aisles: the next aisle over (up to 22 m) too, so a lot is walked every other aisle."""
    out = []
    lim = 22.0 if aisle[p] else 14.0
    for q in mkd.query_ball_point(MID[p], lim):
        if q == p or PA[q] in (PA[p], PB[p]) or PB[q] in (PA[p], PB[p]): continue
        if abs(float(DIR[p] @ DIR[q])) < 0.87: continue                       # within ~30 deg
        d = MID[q] - MID[p]
        along = float(d @ DIR[p]); perp = abs(float(d[0] * DIR[p][1] - d[1] * DIR[p][0]))
        if 3.0 <= perp <= (lim if aisle[q] else 14.0) and abs(along) <= PL[p] / 2 + 2: out.append(q)
    return out

# ------------------------------------------------------------------ areas: length-weighted k-means
def wkmeans(X, w, k, seed, iters=60, tries=6):
    rng = np.random.default_rng(seed); best = None
    for _ in range(tries):
        C = [X[rng.choice(len(X), p=w / w.sum())]]
        for _ in range(1, k):                                                   # k-means++
            d2 = np.min(((X[:, None, :] - np.array(C)[None]) ** 2).sum(-1), 1) * w
            C.append(X[rng.choice(len(X), p=d2 / d2.sum())])
        C = np.array(C)
        for _ in range(iters):
            lab = np.argmin(((X[:, None, :] - C[None]) ** 2).sum(-1), 1)
            C2 = np.array([np.average(X[lab == j], axis=0, weights=w[lab == j]) if (lab == j).any() else C[j] for j in range(k)])
            if np.allclose(C2, C): break
            C = C2
        sse = float((((X - C[lab]) ** 2).sum(-1) * w).sum())
        if best is None or sse < best[0]: best = (sse, lab, C)
    return best[1], best[2]

T = np.where(is_target)[0]
WT = PL[T] * np.where(is_road[T], 0.5, 1.0)                                     # walkways count more than streets


# ------------------------------------------------------------------ named places (for starts, names, step text)
def load_feats(name):
    p = F / name
    return json.load(open(p))["features"] if p.exists() else []
lm_places = []
for f in load_feats("landmarks.geojson"):
    pr = f["properties"]; nm = pr.get("name") or ""
    if not nm or nm.lower().startswith("lot ") or BAD_NAME(nm) or f["geometry"]["type"] != "Point": continue
    gx_, gy_ = to_xy(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
    lm_places.append((float(gx_), float(gy_), nm, pr.get("kind", "landmark")))
if not named_places:                                                            # no buildings in the cache: use the map file
    for f in load_feats("buildings.geojson"):
        nm = f["properties"].get("name"); ring = f["geometry"]["coordinates"][0]
        if nm and not BAD_NAME(nm):
            gx_, gy_ = to_xy(np.mean([c[1] for c in ring]), np.mean([c[0] for c in ring]))
            named_places.append((float(gx_), float(gy_), nm, "building"))
places = lm_places + [p for p in named_places if not any(p[2] == q[2] for q in lm_places)]
PLX = np.array([[p[0], p[1]] for p in places]) if places else np.zeros((0, 2))
pkd = cKDTree(PLX) if len(PLX) else None
PRI = {"field": 3.0, "plaza": 2.5, "landmark": 1.5, "building": 1.0}
def place_near(xy_, r):
    if pkd is None: return None
    d, i = pkd.query(xy_, distance_upper_bound=r)
    return places[i] if d <= r else None

name_kd = cKDTree(MID)
def names_at(p):
    for q in name_kd.query(p, k=6, distance_upper_bound=12)[1]:
        if q < NP and NAME[q]: return NAME[q]
    return ""

# ------------------------------------------------------------------ route builder
def best_hop(src, ok, max_cost, walked=(), M=12):
    """Dijkstra from src (collected or already-walked paths cost 1.4x). Among the first M nodes that touch an available
    target piece, go to the one with the best (new path reachable from it, capped 400 m) / (cost + 30 m)."""
    dist, prev, pq, cands = {src: 0.0}, {}, [(0.0, src)], []
    while pq and len(cands) < M:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18): continue
        if d > max_cost: break
        if u != src and any(ok(p) for _, p in adj.get(u, ())):
            cands.append((d, u))
        for v, p in adj.get(u, ()):
            nd = d + PL[p] * (1.4 if (collected[p] or p in walked) else 1.0) * (1.15 if is_road[p] else 1.0)
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = (u, p); heapq.heappush(pq, (nd, v))
    if not cands: return None

    def gain(u0, cap=400.0):
        seen_p, stack, g = set(), [u0], 0.0
        while stack and g < cap:
            u = stack.pop()
            for v, p in adj.get(u, ()):
                if p in seen_p or not ok(p): continue
                seen_p.add(p); g += PL[p]; stack.append(v)
        return min(g, cap)
    d, u = max(cands, key=lambda c: gain(c[1]) / (c[0] + 30.0))
    path = [u]
    while path[-1] != src: path.append(prev[path[-1]][0])
    path = path[::-1]
    return [(path[i + 1], prev[path[i + 1]][1]) for i in range(len(path) - 1)]


def pick_start(j, area_of, taken):
    tp = np.where(~taken & (area_of == j))[0]
    if not len(tp): return None, None
    tn = np.unique(np.r_[PA[tp], PB[tp]])
    dc = np.linalg.norm(N[tn] - CORE, axis=1)
    edge = tn[dc <= np.quantile(dc, 0.25)]                                      # the side of the area facing the core
    best = None
    for u in edge:
        pl = place_near(N[u], 90)
        if pl is None: continue
        s = math.dist(N[u], pl[:2]) / PRI.get(pl[3], 1.0) + 0.15 * float(np.linalg.norm(N[u] - CORE))
        if best is None or s < best[0]: best = (s, int(u), pl[2])
    if best is None:
        u = int(edge[np.argmin(np.linalg.norm(N[edge] - CORE, axis=1))])
        pl = place_near(N[u], 400)
        return u, (pl[2] if pl else "Area edge")
    return best[1], best[2]


def build(j, area_of, taken_global):
    """One route for area j. New metres = uncollected (15 m rule), first time on this route, and not running
    alongside a stretch this route already walked. Returns None or a dict; marks the kept pieces in taken_global."""
    start, start_name = pick_start(j, area_of, taken_global)
    if start is None: return None
    taken = taken_global.copy()
    own = set()                                                                 # walked or covered alongside, this route
    cur, seq, pieces, isnew, total, heading = start, [start], [], [], 0.0, None
    marks = []                                                                  # (piece index, [pieces taken])
    in_area = lambda p: not taken[p] and area_of[p] == j
    anywhere = lambda p: not taken[p]
    walked = set()

    def walk(u, p):
        nonlocal total, cur, heading
        nw = (not collected[p]) and p not in own
        isnew.append(nw); pieces.append(p)
        m = [p] + (parallels(p) if not collected[p] else [])
        for q in m: taken[q] = True; own.add(q)
        marks.append(m); walked.add(p); total += PL[p]
        heading = (N[u] - N[cur]) / max(1e-9, math.dist(N[u], N[cur])); cur = u; seq.append(u)

    while total < A.budget:
        nxt = [(v, p) for v, p in adj.get(cur, ()) if in_area(p)]
        if nxt:                                                                 # keep going along new path, straightest first
            def turn(vp):
                d = N[vp[0]] - N[cur]; d = d / max(1e-9, np.linalg.norm(d))
                return -(float(d @ heading) if heading is not None else 0.0) + (0.3 if is_road[vp[1]] else 0.0)
            v, p = min(nxt, key=turn)
            if total + PL[p] > A.max_len: break
            walk(v, p); continue
        hop = best_hop(cur, in_area, 700, walked) or best_hop(cur, anywhere, 450, walked)
        if not hop: break
        if total + sum(PL[p] for _, p in hop) > A.max_len - 50: break
        for v, p in hop: walk(v, p)
    if not pieces: return None
    # where to end: the longest prefix ending on a new piece that is >= 72% new and >= 3 km; else >= 70% and
    # >= min length; else the most-new prefix >= min length
    acc = np.cumsum([PL[p] for p in pieces]); nwc = np.cumsum([PL[p] if f else 0.0 for p, f in zip(pieces, isnew)])
    ends = [i for i in range(len(pieces)) if isnew[i]]
    cut = None
    for lo_len, ratio in ((3000.0, 0.72), (A.min_len, 0.70)):
        ok = [i for i in ends if acc[i] >= lo_len and nwc[i] >= ratio * acc[i]]
        if ok: cut = max(ok, key=lambda i: acc[i]); break
    if cut is None:
        ok = [i for i in ends if acc[i] >= A.min_len]
        if not ok: return None
        cut = max(ok, key=lambda i: nwc[i] / acc[i])
    for m in marks[:cut + 1]:
        for q in m: taken_global[q] = True
    return dict(area=j, start=start, start_name=start_name, seq=seq[:cut + 2], pieces=pieces[:cut + 1],
                L=float(acc[cut]), new_m=float(nwc[cut]))


def plan(k, seed):
    lab, _ = wkmeans(MID[T], WT, k, seed)
    area_of = np.full(NP, -1); area_of[T] = lab
    area_len = np.array([PL[T][lab == j].sum() for j in range(k)])
    taken = ~is_target                                                          # survey-collected or not a target
    out = []
    for j in np.argsort(-area_len):
        r = build(int(j), area_of, taken)
        if r is None: continue
        r["area_uncollected_m"] = int(area_len[j])
        if r["new_m"] < 0.60 * r["L"]:
            print(f"  k={k} seed={seed} area {j}: only {100 * r['new_m'] / r['L']:.0f}% new ({r['L']:.0f} m), skipped"); continue
        out.append(r)
    good = sum(1 for r in out if r["L"] >= 3000 and r["new_m"] >= 0.70 * r["L"])
    score = (good, sum(r["new_m"] for r in out))
    print(f"k={k} seed={seed}: {len(out)} routes, {good} >= 3 km & >= 70% new, {score[1] / 1000:.1f} km new; "
          + ", ".join(f"{r['L'] / 1000:.1f}km/{100 * r['new_m'] / r['L']:.0f}%" for r in out), flush=True)
    return score, out


# try a few area splits; keep the one with the most routes that are >= 3 km and >= 70 % new, then most new metres
best = None
for k in sorted({A.k - 2, A.k - 1, A.k, A.k + 1}):
    if k < 2: continue
    for seed in range(A.seed, A.seed + 3):
        sc, out = plan(k, seed)
        if best is None or sc > best[0]: best = (sc, out, k, seed)
_, plans, K_USED, SEED_USED = best
plans.sort(key=lambda r: -r["new_m"])
if len(plans) > A.k:
    print("dropping the weakest:", [f"{r['L'] / 1000:.1f}km/{100 * r['new_m'] / r['L']:.0f}%" for r in plans[A.k:]])
    plans = plans[:A.k]
print(f"chosen: k={K_USED} seed={SEED_USED}, {len(plans)} routes", flush=True)

lib = [r for r in json.load(open(LIB_IN)) if int(r["id"]) <= 4]          # the 4 original loops (last night's coverage)
assert len(lib) == 4, f"expected the 4 original loops in {LIB_IN}, found {[r['id'] for r in lib]}"
used_names = {r["name"] for r in lib}
new_routes, report = [], []
for pl_ in plans:
    start_name, seq, pieces, L, new_m = pl_["start_name"], pl_["seq"], pl_["pieces"], pl_["L"], pl_["new_m"]
    P = [tuple(map(float, N[u])) for u in seq]
    P = [p for k, p in enumerate(P) if k == 0 or math.dist(p, P[k - 1]) > 0.5]
    cum = [0.0]
    for p, q in zip(P, P[1:]): cum.append(cum[-1] + math.dist(p, q))
    L = cum[-1]
    # same 10 m rule Survey Control uses for its bins (reading within 10 m of the bin centre)
    sc_new = sum(PL[p] for p in set(pieces) if rkd.query(MID[p])[0] > 10.0)
    # names: places passed (within 60 m), fields/plazas first, spread along the route
    passed = {}
    for k in range(0, len(P), 3):
        for i in (pkd.query_ball_point(P[k], 60) if pkd is not None else []):
            nm, kind = places[i][2], places[i][3]
            if nm not in passed: passed[nm] = (cum[k], PRI.get(kind, 1.0), kind)
    ranked = sorted(passed.items(), key=lambda kv: (-kv[1][1], kv[1][0]))
    first = ranked[0][0] if ranked else start_name
    second = next((nm for nm, v in ranked if nm != first and abs(v[0] - passed[first][0]) > 600), None) if ranked else None
    second = second or next((nm for nm, v in ranked if nm != first), None)
    name = (f"{first} – {second}" if "&" in first + second else f"{first} & {second}") if second else first
    if name in used_names: name = f"{name} ({start_name})"
    used_names.add(name)
    covers = ", ".join([nm for nm, _ in sorted(passed.items(), key=lambda kv: kv[1][0])][:6]) or start_name
    end_pl = place_near(P[-1], 250)
    finish = f"Route complete — you're near {end_pl[2]}" if end_pl else "Route complete"
    rid = 201 + len(new_routes)
    steps = make_steps(P, cum, names_at, finish=finish)
    nm0 = names_at(P[0])
    steps[0]["txt"] = f"Start at {start_name}{' on ' + nm0 if nm0 else ''}"
    pts = [[round(float(v), 6) for v in to_ll(x, y)] for x, y in P]
    r = dict(id=rid, name=name, covers=covers, color=COLORS[len(new_routes) % len(COLORS)], total=round(L, 1), new=round(new_m, 1),
             pts=pts, cum=[round(v, 1) for v in cum], steps=steps,
             kind="new", why="Uncollected paths", start=start_name, end=end_pl[2] if end_pl else None,
             new_pct=round(100 * new_m / max(1, L), 1), targets=int(sum(1 for p in set(pieces) if not collected[p])))
    new_routes.append(r)
    report.append(dict(id=rid, name=name, start=start_name, end=r["end"], km=round(L / 1000, 2), new_pct=r["new_pct"],
                       new_pct_10m_rule=round(100 * sc_new / max(1, L), 1), minutes=round(L / 75), area_uncollected_m=pl_["area_uncollected_m"]))
    print(f"{rid}  {name}  start: {start_name}  {L / 1000:.2f} km  {r['new_pct']}% new", flush=True)

lib += new_routes
json.dump(lib, open(OUT / "route_library.json", "w"), separators=(",", ":"))
light = []
for r in lib:
    d = {k: v for k, v in r.items() if k not in ("cum", "steps")}
    d["steps_count"] = len(r.get("steps") or [])
    light.append(d)
json.dump(light, open(OUT / "route_library_light.json", "w"), separators=(",", ":"))
json.dump(dict(k=K_USED, seed=SEED_USED, collected_km=round(float(PL[collected].sum()) / 1000, 2), uncollected_km=round(float(PL[~collected].sum()) / 1000, 2),
               targetable_km=round(float(PL[is_target].sum()) / 1000, 2), routes=report),
          open(OUT / "new_routes_report.json", "w"), indent=1)
print(f"library: {len(lib)} routes -> {OUT / 'route_library.json'} (+ light)", flush=True)
print(json.dumps(report, indent=1), flush=True)
