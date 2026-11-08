"""Find light emitters in the dark exposure snapshots (lights/BRK_*.jpg) and turn each into a camera ray.

The snapshots are taken at a very short exposure, so only actual light sources show up.
Each blob -> bearing, elevation, size, brightness and colour temperature.

Output: results/blobs/<session>.csv
"""
import csv, os, sys
from pathlib import Path
import cv2, numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
from geo import pixel_ray, cct_from_rgb

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
OUT = Path("results/blobs"); OUT.mkdir(parents=True, exist_ok=True)


def blobs(img):
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    thr = max(35, float(np.percentile(g, 99.95)) * 0.5)
    m = (g >= thr).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 6:
            continue
        sel = lab == i
        px = img[sel].astype(float)
        lum = px.mean(1)
        core = px[(lum > 40) & (px.max(1) < 250)]
        rgb = (core if len(core) >= 3 else px).mean(0)
        x, y, w, h = stats[i, :4]
        out.append(dict(u=float(cent[i][0]), v=float(cent[i][1]), area=int(area), w=int(w), h=int(h),
                        peak=float(g[sel].max()), mean=float(lum.mean()), sat_frac=float((px.max(1) >= 250).mean()),
                        r=float(rgb[0]), g=float(rgb[1]), b=float(rgb[2])))
    out.sort(key=lambda b: -b["area"] * b["mean"])
    return out[:25]


def run(sdir: Path):
    p = sdir / "brackets.csv"
    if not p.exists():
        return 0
    rows = list(csv.DictReader(open(p)))
    f = open(OUT / f"{sdir.name}.csv", "w", newline=""); w = csv.writer(f)
    w.writerow(["session", "file", "index", "epoch", "lat", "lon", "h_acc", "exposure_s", "iso", "bearing_deg", "elev_deg",
                "u", "v", "area_px", "peak", "mean", "sat_frac", "r", "g", "b", "cct_k"])
    n = 0
    for r in rows:
        fp = sdir / r["file"]
        if not fp.exists() or not r.get("lat"):
            continue
        img = np.asarray(ImageOps.exif_transpose(Image.open(fp)).convert("RGB"))
        Wp = img.shape[1]
        for b in blobs(img):
            bearing, elev = pixel_ray(r, b["u"], b["v"], Wp)
            w.writerow([sdir.name, r["file"], r["index"], r["epoch"], r["lat"], r["lon"], r.get("h_acc"), r.get("exposure_s"),
                        r.get("iso"), round(bearing, 2), round(elev, 2), round(b["u"]), round(b["v"]), b["area"],
                        round(b["peak"]), round(b["mean"], 1), round(b["sat_frac"], 3), round(b["r"]), round(b["g"]), round(b["b"]),
                        cct_from_rgb(b["r"], b["g"], b["b"])])
            n += 1
    f.close()
    print(f"{sdir.name}: {len(rows)} snapshots -> {n} light blobs", flush=True)
    return n


if __name__ == "__main__":
    targets = sys.argv[1:] or [p.name for p in sorted(SESS_ROOT.iterdir()) if (p / "brackets.csv").exists()]
    for t in targets:
        run(SESS_ROOT / t)
