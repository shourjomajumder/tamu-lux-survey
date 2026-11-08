"""Build the route library for the Survey Control panel.

Routes are in the iPhone app's SurveyRoute format (id, name, covers, color, total, new, pts, cum, steps),
so a phone can load an assigned route directly. Plus extra fields for the control panel:
kind ("original" | "recheck"), why, dark_pct, targets.

1. The 4 original survey loops (app routes.json), ids 1-4.
2. "Dark-spot recheck" loops (ids 101+): the high-severity low-light stretches are clustered into
   4 areas; each loop visits that area's dark stretches in nearest-neighbour order along the surveyed
   path network and returns to its start. Turn-by-turn steps are generated from the geometry.

usage: python route_library.py <app routes.json> <final data folder> <out.json>
"""
import heapq, json, math, sys
from pathlib import Path
import numpy as np

APP, F, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
LAT0, LON0 = 30.615, -96.34
MLAT, MLON = 111320.0, 111320.0 * math.cos(math.radians(LAT0))
xy = lambda la, lo: ((lo - LON0) * MLON, (la - LAT0) * MLAT)
ll = lambda x, y: (LAT0 + y / MLAT, LON0 + x / MLON)

lib = []
for r in json.load(open(APP)):
    r = dict(r); r["kind"] = "original"; r["why"] = "Original survey loop"
    lib.append(r)

# ---------- graph from surveyed path stretches
segs = [f for f in json.load(open(F / "path_lighting.geojson"))["features"] if f["geometry"]["type"] == "LineString"]
nodes, key2id = [], {}
def nid(x, y):
    k = (round(x / 2.0), round(y / 2.0))            # merge endpoints within ~2 m
    if k not in key2id:
        key2id[k] = len(nodes); nodes.append((x, y))
    return key2id[k]
adj = {}
seg_lux = {}
for f in segs:
    (lo0, la0), (lo1, la1) = f["geometry"]["coordinates"][:2]
    a, b = nid(*xy(la0, lo0)), nid(*xy(la1, lo1))
    if a == b: continue
    L = math.dist(nodes[a], nodes[b])
    lux = f["properties"]["lux_median"]
    adj.setdefault(a, {})[b] = L; adj.setdefault(b, {})[a] = L
    seg_lux[(min(a, b), max(a, b))] = lux
N = np.array(nodes)
# bridge dead ends / separate pieces to the nearest other node within 30 m (unmeasured links)
from scipy.spatial import cKDTree
kd = cKDTree(N)
for a in list(adj):
    if len(adj[a]) <= 1:
        for d_, b in zip(*kd.query(N[a], k=8, distance_upper_bound=30)):
            if b < len(N) and b != a and b not in adj[a] and d_ > 2:
                adj[a][b] = d_ * 1.5; adj.setdefault(b, {})[a] = d_ * 1.5; break

def dijkstra(src, dst):
    dist, prev, pq = {src: 0}, {}, [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst: break
        if d > dist.get(u, 1e18): continue
        for v, w in adj.get(u, {}).items():
            nd = d + w
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if dst not in dist: return None
    path = [dst]
    while path[-1] != src: path.append(prev[path[-1]])
    return path[::-1]

# ---------- turn-by-turn steps (same shape as the app's steps)
def bearing(p, q): return math.degrees(math.atan2(q[0] - p[0], q[1] - p[1])) % 360
def make_steps(P, cum, names_at):
    steps, i0 = [], 0
    hd = [bearing(P[k], P[k + 1]) for k in range(len(P) - 1)]
    turns = [0]
    for k in range(1, len(hd)):
        # look ~10 m back/ahead for a stable heading change
        a = hd[max(0, k - 2)]; b = hd[min(len(hd) - 1, k + 2)]
        t = ((b - a + 540) % 360) - 180
        if abs(t) > 40 and cum[k] - cum[turns[-1]] > 15: turns.append(k)
    turns.append(len(P) - 1)
    for n, (k, k2) in enumerate(zip(turns, turns[1:])):
        if n == 0: icon, verb = "start", "Start"
        else:
            a = hd[max(0, k - 2)]; b = hd[min(len(hd) - 1, k + 2)]; t = ((b - a + 540) % 360) - 180
            icon, verb = ("uturn", "Turn around") if abs(t) > 150 else (("right", "Turn right") if t > 0 else ("left", "Turn left"))
            if 40 < abs(t) <= 70: icon, verb = ("slight-right", "Bear right") if t > 0 else ("slight-left", "Bear left")
        nm = names_at(P[k])
        txt = f"{verb}{' on ' + nm if nm else ''}"
        steps.append(dict(i=n + 1, txt=txt, hint="", icon=icon, at=round(cum[k], 1), L=round(cum[k2] - cum[k], 1), rep=False))
    steps.append(dict(i=len(steps) + 1, txt="Back at the start — route complete", hint="", icon="finish", at=round(cum[-1], 1), L=0.0, rep=False))
    return steps

# path names for step text
name_pts = []
for f in segs:
    nm = f["properties"].get("name")
    if nm:
        (lo0, la0) = f["geometry"]["coordinates"][0]; name_pts.append((xy(la0, lo0), nm))
nkd = cKDTree(np.array([p for p, _ in name_pts])) if name_pts else None
def names_at(p):
    if nkd is None: return ""
    d_, i = nkd.query(p)
    return name_pts[i][1] if d_ < 12 else ""

# ---------- dark-spot recheck loops
W = [f for f in json.load(open(F / "warnings.geojson"))["features"] if f["properties"]["severity"] in ("high", "medium")]
W.sort(key=lambda f: ({"high": 0, "medium": 1}[f["properties"]["severity"]], -f["properties"]["length_m"]))
W = W[:160]
T = np.array([xy(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in W])
from sklearn.cluster import KMeans
K = 4
lab = KMeans(K, n_init=10, random_state=1).fit_predict(T)
colors = ["#f2f2f2", "#ff8a6b", "#cbb58f", "#9aa3b2"]   # neutral, never a walker colour
area_names = []
lm = json.load(open(F / "landmarks.geojson"))["features"] if (F / "landmarks.geojson").exists() else []
lmp = [(xy(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]), f["properties"]["name"]) for f in lm
       if f["properties"]["kind"] in ("field", "plaza") and not f["properties"]["name"].lower().startswith("lot ")]
bld_pts = []
for f in json.load(open(F / "buildings.geojson"))["features"]:
    nm = f["properties"].get("name"); ring = f["geometry"]["coordinates"][0]
    if nm and "garage" not in nm.lower():
        bld_pts.append((xy(sum(c[1] for c in ring) / len(ring), sum(c[0] for c in ring) / len(ring)), nm))
for c in range(K):
    idx = np.where(lab == c)[0]
    if not len(idx): continue
    cen = T[idx].mean(0)
    near = sorted(lmp, key=lambda q: math.dist(q[0], cen))[:1]
    if near and math.dist(near[0][0], cen) < 220: area = near[0][1]
    else:
        nb = sorted(bld_pts, key=lambda q: math.dist(q[0], cen))[:1]
        area = nb[0][1] if nb else f"Area {c + 1}"
    tnodes = [int(kd.query(T[i])[1]) for i in idx]
    start = int(kd.query(cen)[1])
    order, cur, left = [start], start, set(tnodes) - {start}
    while left:                                     # nearest-neighbour tour (straight-line), refined by real paths
        nxt = min(left, key=lambda v: math.dist(N[cur], N[v])); order.append(nxt); left.discard(nxt); cur = nxt
    order.append(start)
    path = [start]
    for a, b in zip(order, order[1:]):
        seg = dijkstra(a, b)
        if seg: path += seg[1:]
    P = [tuple(N[v]) for v in path]
    # drop consecutive duplicates
    P = [p for k, p in enumerate(P) if k == 0 or math.dist(p, P[k - 1]) > 0.5]
    cum = [0.0]
    for p, q in zip(P, P[1:]): cum.append(cum[-1] + math.dist(p, q))
    if cum[-1] < 200: continue
    dark = sum(math.dist(p, q) for p, q, a, b in zip(P, P[1:], path, path[1:]) if seg_lux.get((min(a, b), max(a, b)), 0) < 5)
    pts = [[round(v, 6) for v in ll(*p)] for p in P]
    rid = 101 + c
    lib.append(dict(id=rid, name=f"Dark-spot recheck · {area}", covers=f"{len(idx)} low-light stretches near {area}",
                    color=colors[c % 4], total=round(cum[-1], 1), new=0.0, pts=pts, cum=[round(v, 1) for v in cum],
                    steps=make_steps(P, cum, names_at), kind="recheck",
                    why="Re-measure the darkest stretches found on Nov 7 (confirm, and check whether any lamp was out)",
                    dark_pct=round(100 * dark / max(1, cum[-1]), 1), targets=len(idx)))
json.dump(lib, open(OUT, "w"), separators=(",", ":"))
print(f"{len(lib)} routes:", [(r['id'], r['name'], round(r['total'])) for r in lib])
