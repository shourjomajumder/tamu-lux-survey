"""Streetlight light simulation fitted to the measured readings (CPU, numpy).

Model (per 1 m ground cell p, measured at hand height 1.2 m):
    E(p) = a + sum_k  I_k * H_k / (d_k^2 + H_k^2)^1.5 * V_k(p)
  I_k  luminous intensity of lamp k (cd), fitted;  H_k = lamp height - 1.2 m;  d_k horizontal distance
  V_k  visibility: 0 if a building blocks the lamp->cell line, x0.55 per tree crown it passes through
  a    ambient light (sky glow, distant sources), fitted
Fit: bounded least squares on 80% of the 1 Hz cleaned readings (car-light moments already removed),
with a weak pull of each lamp toward the median intensity. 20% held out for an honest accuracy figure.
Map: physics prediction + smoothed residual correction near measurements (so it never contradicts them).

Output (into the given folder, default results/final):
  light_map.png   RGBA, R = light as perceived brightness (log scale 0.3..60 lux -> 0..255), A = valid area
  light_map.json  bounds (local metres + lat/lon), resolution, encoding, validation metrics
  lamps.geojson   adds per-lamp: intensity_cd, reach_m (area >= 1 lux), lit_area_m2, shadowed_pct, fitted
"""
import json, math, sys, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, sparse
from scipy.optimize import lsq_linear

F = Path(sys.argv[1] if len(sys.argv) > 1 else "results/final")
LAT0, LON0 = 30.615, -96.34
MLAT, MLON = 111320.0, 111320.0 * math.cos(math.radians(LAT0))
xy = lambda lat, lon: ((np.asarray(lon) - LON0) * MLON, (np.asarray(lat) - LAT0) * MLAT)
RES, REACH, H_MEAS = 1.0, 40.0, 1.2
t0 = time.time()

lamps = json.load(open(F / "lamps.geojson"))
L = lamps["features"]
lx, ly = xy([f["geometry"]["coordinates"][1] for f in L], [f["geometry"]["coordinates"][0] for f in L])
lh = np.array([max(2.5, float(f["properties"].get("height_m") or 5)) for f in L])
import csv
NIGHT_FROM = 1794097800          # 2026-11-08 00:30 UTC = 6:30 pm CST; earlier readings are dusk twilight, not lamp light
R = [r for r in csv.DictReader(open(F / "readings_1hz.csv")) if float(r["sec"]) >= NIGHT_FROM]
rx = np.array([float(r["x"]) for r in R]); ry = np.array([float(r["y"]) for r in R]); rl = np.array([float(r["lux"]) for r in R])
print(f"night readings used: {len(R)}", flush=True)
# fitting targets: 5 m path-stretch medians recomputed from night readings (robust to GPS noise)
from collections import defaultdict
seg = defaultdict(list)
for a, b, v in zip(rx, ry, rl):
    seg[(int(a // 5), int(b // 5))].append(v)
sx = np.array([(k[0] + .5) * 5 for k in seg]); sy = np.array([(k[1] + .5) * 5 for k in seg])
sl = np.array([float(np.median(v)) for v in seg.values()]); sn = np.array([len(v) for v in seg.values()])

# ---------- raster grid
x0, x1 = np.percentile(rx, 0.2) - 45, np.percentile(rx, 99.8) + 45
y0, y1 = np.percentile(ry, 0.2) - 45, np.percentile(ry, 99.8) + 45
NX, NY = int((x1 - x0) / RES), int((y1 - y0) / RES)
print(f"grid {NX}x{NY} @ {RES} m", flush=True)
def cell(x, y):
    return np.clip(((y1 - y) / RES).astype(int), 0, NY - 1), np.clip(((x - x0) / RES).astype(int), 0, NX - 1)

# obstacles: building height raster, tree crown raster (top height)
bimg = Image.new("F", (NX, NY), 0.0); bd = ImageDraw.Draw(bimg)
for f in json.load(open(F / "buildings.geojson"))["features"]:
    for ring in f["geometry"]["coordinates"][:1]:
        px, py = xy([c[1] for c in ring], [c[0] for c in ring])
        pts = [((a - x0) / RES, (y1 - b) / RES) for a, b in zip(px, py)]
        if len(pts) >= 3: bd.polygon(pts, fill=float(f["properties"].get("height_m") or 10))
BH = np.asarray(bimg, dtype=np.float32)
timg = Image.new("F", (NX, NY), 0.0); td = ImageDraw.Draw(timg)
for f in json.load(open(F / "trees.geojson"))["features"]:
    (lo, la) = f["geometry"]["coordinates"][:2]; tx, ty = xy(la, lo)
    rr = float(f["properties"].get("crown_radius_m") or 4) / RES; cx, cy = (tx - x0) / RES, (y1 - ty) / RES
    td.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=float(f["properties"].get("height_m") or 9))
TH = np.asarray(timg, dtype=np.float32)

# area of interest: within 35 m of any reading
seen = np.zeros((NY, NX), bool); ci, cj = cell(rx, ry); seen[ci, cj] = True
AOI = ndimage.distance_transform_edt(~seen) * RES <= 35
AOI &= BH <= 0     # not inside buildings

# ---------- per-lamp geometry x visibility, sparse (cells within REACH)
rad = int(REACH / RES)
oy, ox = np.mgrid[-rad:rad + 1, -rad:rad + 1]
disk = (ox ** 2 + oy ** 2) <= rad * rad
oy, ox = oy[disk], ox[disk]
NS = 28
ts = (np.arange(1, NS + 1) / (NS + 1)).astype(np.float32)
rows_c, cols_l, vals = [], [], []
blocked_frac = np.zeros(len(L))
for k in range(len(L)):
    li, lj = cell(lx[k:k + 1], ly[k:k + 1]); li, lj = int(li[0]), int(lj[0])
    ii, jj = li + oy, lj + ox
    ok = (ii >= 0) & (ii < NY) & (jj >= 0) & (jj < NX)
    ii, jj, dy, dx = ii[ok], jj[ok], oy[ok], ox[ok]
    ok = AOI[ii, jj]
    if not ok.any(): continue
    ii, jj, dy, dx = ii[ok], jj[ok], dy[ok], dx[ok]
    d = np.hypot(dx, dy) * RES; Hk = max(0.6, lh[k] - H_MEAS)
    g = Hk / (d * d + Hk * Hk) ** 1.5
    # march the lamp -> cell line
    si = (li + np.outer(dy, ts)).round().astype(int).clip(0, NY - 1)
    sj = (lj + np.outer(dx, ts)).round().astype(int).clip(0, NX - 1)
    zline = lh[k] + (H_MEAS - lh[k]) * ts[None, :]
    bl = (BH[si, sj] > zline).any(1)
    tr = ((TH[si, sj] > zline) & (zline > 2.0)).sum(1)
    vis = np.where(bl, 0.0, 0.55 ** np.minimum(tr, 4))
    blocked_frac[k] = float(((vis < 0.5) & (d < 20)).sum() / max(1, (d < 20).sum()))
    flat = ii * NX + jj
    rows_c.append(flat); cols_l.append(np.full(len(flat), k)); vals.append((g * vis).astype(np.float32))
rows_c = np.concatenate(rows_c); cols_l = np.concatenate(cols_l); vals = np.concatenate(vals)
G = sparse.csr_matrix((vals, (rows_c, cols_l)), shape=(NY * NX, len(L)))
print(f"lamp influence built: {len(vals):,} cell-lamp pairs  ({time.time() - t0:.0f}s)", flush=True)

# ---------- fit
ri, rj = cell(rx, ry)
si_, sj_ = cell(sx, sy); rflat = si_ * NX + sj_
A = G[rflat]
# spatial hold-out: whole 50 m blocks, so validation stretches are far from training ones
test = np.random.default_rng(7).random(len(sl)) < 0.2     # 20% of 5 m stretches held out entirely
train = ~test
rl_all = rl; rl = sl
I0 = float(sys.argv[2]) if len(sys.argv) > 2 else 400.0   # cd prior
lam = 0.02 * np.median(A[train].sum(0).A1[A[train].sum(0).A1 > 0]) if A.nnz else 1
w = np.sqrt(sn[train]) / (rl[train] + 1.0)              # relative error, more weight to well-sampled stretches
Aw = sparse.diags(w) @ sparse.hstack([A[train], sparse.csr_matrix(np.ones((train.sum(), 1)))])
bw = w * rl[train]
reg = sparse.hstack([sparse.identity(len(L)) * lam, sparse.csr_matrix((len(L), 1))])
M = sparse.vstack([Aw, reg]).tocsr(); b = np.concatenate([bw, np.full(len(L), lam * I0)])
sol = lsq_linear(M, b, bounds=(0, np.inf), lsmr_tol="auto", max_iter=4000, verbose=0)
I, amb = sol.x[:-1], sol.x[-1]
support = (A[train] > 1e-4).sum(0).A1
print(f"fit: ambient {amb:.2f} lux, median I {np.median(I[support > 0]):.0f} cd, lamps with data {int((support > 0).sum())}/{len(L)}", flush=True)

def predict(flat_idx):
    return amb + G[flat_idx] @ I
pt = predict(rflat[test]); mt = rl[test]
err = np.abs(pt - mt); lerr = np.abs(np.log((pt + 0.5) / (mt + 0.5)))
ss_res = ((np.log(pt + .5) - np.log(mt + .5)) ** 2).sum(); ss_tot = ((np.log(mt + .5) - np.log(mt + .5).mean()) ** 2).sum()
val = dict(held_out_stretches=int(test.sum()), median_abs_error_lux=round(float(np.median(err)), 2),
           median_factor_error=round(float(np.exp(np.median(lerr))), 2), r2_log=round(float(1 - ss_res / ss_tot), 3),
           within_2x_pct=round(float((lerr < math.log(2)).mean() * 100), 1))
print("validation (physics only, held-out):", val, flush=True)

# ---------- map = physics + residual correction near measurements (all readings)
E = np.full(NY * NX, amb, np.float32); E += (G @ I).astype(np.float32); E = E.reshape(NY, NX)
res = np.zeros((NY, NX), np.float32); wgt = np.zeros((NY, NX), np.float32)
test_keys = set(zip((sx[test] // 5).astype(int), (sy[test] // 5).astype(int)))
rk = [(int(a // 5), int(b // 5)) not in test_keys for a, b in zip(rx, ry)]
rk = np.array(rk)
np.add.at(res, (ri[rk], rj[rk]), np.log(rl_all[rk] + 0.5) - np.log(E[ri[rk], rj[rk]] + 0.5)); np.add.at(wgt, (ri[rk], rj[rk]), 1)
sig = 5.0 / RES
rs = ndimage.gaussian_filter(res, sig); ws = ndimage.gaussian_filter(wgt, sig)
corr = np.where(ws > 1e-3, rs / np.maximum(ws, 1e-6), 0) * np.clip(ws / (ws + 0.02), 0, 1)
Ef = (np.exp(np.log(E + 0.5) + corr) - 0.5).clip(0, None)
Ef[~AOI] = 0
pf = Ef[si_[test], sj_[test]]; mt2 = sl[test]
lerr2 = np.abs(np.log((pf + 0.5) / (mt2 + 0.5)))
def lvl(v): return np.digitize(v, [1, 3, 5, 10, 30])
val_map = dict(held_out_stretches=int(test.sum()), median_abs_error_lux=round(float(np.median(np.abs(pf - mt2))), 2),
               median_factor_error=round(float(np.exp(np.median(lerr2))), 2), within_2x_pct=round(float((lerr2 < math.log(2)).mean() * 100), 1),
               same_or_adjacent_level_pct=round(float((np.abs(lvl(pf) - lvl(mt2)) <= 1).mean() * 100), 1),
               below5_agreement_pct=round(float(((pf < 5) == (mt2 < 5)).mean() * 100), 1))
print("validation (final map at unmeasured stretches):", val_map, flush=True)

# ---------- outputs
glow = np.clip(np.log(np.maximum(Ef, 1e-3) / 0.3) / math.log(200), 0, 1)
rgba = np.zeros((NY, NX, 4), np.uint8)
rgba[..., 0] = (glow * 255).astype(np.uint8); rgba[..., 1] = rgba[..., 0]; rgba[..., 2] = rgba[..., 0]
rgba[..., 3] = (AOI * 255).astype(np.uint8)
Image.fromarray(rgba, "RGBA").save(F / "light_map.png", optimize=True)
la_n, lo_w = LAT0 + y1 / MLAT, LON0 + x0 / MLON; la_s, lo_e = LAT0 + y0 / MLAT, LON0 + x1 / MLON
meta = dict(bounds_local_m=dict(x0=round(x0, 1), x1=round(x0 + NX * RES, 1), y0=round(y1 - NY * RES, 1), y1=round(y1, 1)),
            bounds_latlon=dict(north=la_n, south=la_s, west=lo_w, east=lo_e), width=NX, height=NY, resolution_m=RES,
            encoding="R=G=B = clip(ln(lux/0.3)/ln(200),0,1)*255 (same as LUX.glow); A=255 inside the simulated area",
            model="E = ambient + sum_k I_k*H/(d^2+H^2)^1.5 * visibility (buildings block, tree crowns x0.55 each); residual-corrected near readings",
            ambient_lux=round(float(amb), 2), validation_physics_only=val, validation_map=val_map,
            lit_share_ge_5lux=round(float((Ef[AOI] >= 5).mean()), 3), lit_share_ge_1lux=round(float((Ef[AOI] >= 1).mean()), 3))
json.dump(meta, open(F / "light_map.json", "w"), indent=1)
# per-lamp reach / lit area
for k, f in enumerate(L):
    p = f["properties"]; col = G[:, k].tocoo()
    contrib = col.data * I[k]
    p["intensity_cd"] = int(I[k]); p["fitted"] = bool(support[k] > 0)
    lit = contrib >= 1.0
    p["lit_area_m2"] = int(lit.sum() * RES * RES)
    if lit.any():
        rr_, cc_ = np.divmod(col.row[lit], NX)
        li, lj = cell(lx[k:k + 1], ly[k:k + 1])
        p["reach_m"] = round(float(np.percentile(np.hypot(rr_ - li[0], cc_ - lj[0]) * RES, 90)), 1)
    else:
        p["reach_m"] = 0.0
    p["shadowed_pct"] = round(blocked_frac[k] * 100, 1)
json.dump(lamps, open(F / "lamps.geojson", "w"), separators=(",", ":"))
s = json.load(open(F / "summary.json")); s["light_sim"] = dict(ambient_lux=meta["ambient_lux"], physics_only=val, map=val_map,
    lit_share_ge_5lux=meta["lit_share_ge_5lux"], lit_share_ge_1lux=meta["lit_share_ge_1lux"])
json.dump(s, open(F / "summary.json", "w"), indent=1)
print(json.dumps(meta, indent=1)); print(f"done in {time.time() - t0:.0f}s")
