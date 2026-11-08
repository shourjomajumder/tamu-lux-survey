"""Pick the 2 best spots for 3D Gaussian-splat scans and stage their (blurred) photos for COLMAP.

Best spot = 70 consecutive photos that are bright (photo brightness), well-localised, and walked
slowly enough to overlap (20-70 m covered). Spots must be >150 m apart.
Output: /data/splat/<spot>/images/*.jpg, /data/splat/spots.json
"""
import csv, json, math, shutil
from pathlib import Path
import numpy as np

SESS, BLUR, OUT = Path("/data/sessions"), Path("/data/blurred"), Path("/data/splat")
WIN = 70
cands = []
for s in sorted(p for p in SESS.iterdir() if (p / "photos.csv").exists()):
    R = [r for r in csv.DictReader(open(s / "photos.csv")) if r.get("lat")]
    if len(R) < WIN: continue
    lat = np.array([float(r["lat"]) for r in R]); lon = np.array([float(r["lon"]) for r in R])
    br = np.array([float(r.get("linear_y") or 0) for r in R]); acc = np.array([float(r.get("h_acc") or 99) for r in R])
    for i in range(0, len(R) - WIN, 10):
        sl = slice(i, i + WIN)
        dist = sum(math.hypot((lat[k + 1] - lat[k]) * 111320, (lon[k + 1] - lon[k]) * 95900) for k in range(i, i + WIN - 1))
        if not 20 <= dist <= 70 or np.median(acc[sl]) > 15: continue
        cands.append((float(np.median(br[sl])), s.name, i, float(lat[i + WIN // 2]), float(lon[i + WIN // 2]), [R[k]["file"] for k in range(i, i + WIN)]))
cands.sort(reverse=True)
picked = []
for c in cands:
    if all(math.hypot((c[3] - p[3]) * 111320, (c[4] - p[4]) * 95900) > 150 for p in picked):
        picked.append(c)
    if len(picked) == 2: break
spots = []
for n, (b, s, i, la, lo, files) in enumerate(picked):
    d = OUT / f"spot{n + 1}" / "images"; d.mkdir(parents=True, exist_ok=True)
    for k, f in enumerate(files):
        src = BLUR / s / f
        if src.exists(): shutil.copy(src, d / f"{k:03d}.jpg")
    spots.append(dict(spot=f"spot{n + 1}", session=s, start_index=i, lat=la, lon=lo, brightness=round(b, 4), photos=len(files)))
json.dump(spots, open(OUT / "spots.json", "w"), indent=1)
print(json.dumps(spots, indent=1))
