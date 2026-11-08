"""Add canopy-derived trees to trees.geojson.

OpenStreetMap maps very few trees here, and night photos make tree detection weak, but the scene
segmentation measures how much tree canopy is overhead in every photo. Path stretches with
canopy >= 0.30 get tree crowns placed along both sides (spacing ~9 m), marked source="canopy from photos".
Runs on results/final only.
"""
import json, math, sys
from pathlib import Path
F = Path(sys.argv[1] if len(sys.argv) > 1 else "results/final")
paths = json.load(open(F / "path_lighting.geojson"))["features"]
trees = json.load(open(F / "trees.geojson"))
keep = [t for t in trees["features"] if t["properties"].get("source") != "canopy from photos"]
LAT0 = 30.615; mlat = 111320.0; mlon = 111320.0 * math.cos(math.radians(LAT0))
placed, out = [], []
for f in paths:
    p = f["properties"]
    c = p.get("canopy")
    if c is None or c < 0.30 or f["geometry"]["type"] != "LineString": continue
    (lo0, la0), (lo1, la1) = f["geometry"]["coordinates"][:2]
    x0, y0, x1, y1 = lo0 * mlon, la0 * mlat, lo1 * mlon, la1 * mlat
    L = math.hypot(x1 - x0, y1 - y0) or 1
    nx, ny = -(y1 - y0) / L, (x1 - x0) / L
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    for side in (1, -1):
        off = 4.0 + 3.0 * c
        tx, ty = mx + side * off * nx, my + side * off * ny
        if any(math.hypot(tx - a, ty - b) < 9 for a, b in placed): continue
        placed.append((tx, ty))
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(tx / mlon, 7), round(ty / mlat, 7)]},
                    "properties": {"source": "canopy from photos", "canopy": round(c, 2),
                                   "crown_radius_m": round(2.5 + 4 * c, 1), "height_m": round(6 + 8 * c, 1)}})
trees["features"] = keep + out
json.dump(trees, open(F / "trees.geojson", "w"), separators=(",", ":"))
s = json.load(open(F / "summary.json")); s["trees"] = len(trees["features"]); s["trees_from_canopy"] = len(out)
json.dump(s, open(F / "summary.json", "w"), indent=1)
print("trees:", len(keep), "kept +", len(out), "from canopy")
