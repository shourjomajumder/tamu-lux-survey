"""Night Street View: web-sized blurred photos + depth maps for a parallax walk-through.

Every 3rd photo with decent GPS (about 5,000 frames) -> 432x768 JPEG + 216x384 disparity PNG (Depth Anything V2).
Output: /data/web/streetview/<session>/<index>.jpg / <index>_d.png
        /data/web/streetview/index.json   (session, index, lat, lon, heading, pitch, epoch, lux)
        /data/web/streetview.zip          (for the website)
"""
import csv, json, os, shutil, sys, time
from pathlib import Path
import numpy as np, torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

SESS = Path("/data/sessions"); BLUR = Path("/data/blurred"); OUT = Path("/data/web/streetview")
OUT.mkdir(parents=True, exist_ok=True)
STEP = int(os.environ.get("SV_STEP", "3"))
ID = "depth-anything/Depth-Anything-V2-Base-hf"          # relative depth, sharpest edges for parallax
proc = AutoImageProcessor.from_pretrained(ID)
model = AutoModelForDepthEstimation.from_pretrained(ID).to("cuda").half().eval()

# nearest lux reading per photo
def lux_lookup(sdir):
    p = sdir / "lux.csv"
    if not p.exists(): return lambda t: None
    ts, lx = [], []
    for r in csv.DictReader(open(p)):
        try: ts.append(float(r["epoch"])); lx.append(float(r["lux"]))
        except Exception: pass
    ts, lx = np.array(ts), np.array(lx)
    def f(t):
        if not len(ts): return None
        i = np.clip(np.searchsorted(ts, t), 1, len(ts) - 1)
        w = slice(max(0, i - 7), i + 8)
        return round(float(np.median(lx[w])), 2)
    return f

index, t0, n = [], time.time(), 0
for sdir in sorted(p for p in SESS.iterdir() if (p / "photos.csv").exists()):
    rows = [r for r in csv.DictReader(open(sdir / "photos.csv")) if r.get("lat") and float(r.get("h_acc") or 99) <= 20]
    rows = rows[::STEP]
    lux = lux_lookup(sdir)
    od = OUT / sdir.name; od.mkdir(exist_ok=True)
    for k in range(0, len(rows), 12):
        chunk = [r for r in rows[k:k + 12] if (BLUR / sdir.name / r["file"]).exists()]
        if not chunk: continue
        ims = [Image.open(BLUR / sdir.name / r["file"]).convert("RGB").resize((432, 768), Image.LANCZOS) for r in chunk]
        with torch.inference_mode():
            inp = proc(images=ims, return_tensors="pt").to("cuda")
            dep = model(pixel_values=inp["pixel_values"].half()).predicted_depth.float()
            dep = torch.nn.functional.interpolate(dep[:, None], size=(384, 216), mode="bilinear")[:, 0].cpu().numpy()
        for r, im, d in zip(chunk, ims, dep):
            lo, hi = np.percentile(d, 1), np.percentile(d, 99.5)
            d8 = (np.clip((d - lo) / max(1e-6, hi - lo), 0, 1) * 255).astype(np.uint8)   # disparity: near = bright
            idx = int(r["index"])
            im.save(od / f"{idx}.jpg", quality=72, optimize=True)
            Image.fromarray(d8).save(od / f"{idx}_d.png", optimize=True)
            index.append(dict(s=sdir.name, i=idx, lat=round(float(r["lat"]), 7), lon=round(float(r["lon"]), 7),
                              h=round(float(r.get("heading_deg") or 0), 1), p=round(float(r.get("pitch_deg") or 0), 1),
                              t=round(float(r["epoch"]), 1), lux=lux(float(r["epoch"]))))
            n += 1
        if n % 240 < 12:
            print(f"{sdir.name}: {n} frames total, {n / max(1e-6, time.time() - t0):.1f} fps", flush=True)
json.dump(index, open(OUT / "index.json", "w"), separators=(",", ":"))
print("frames:", n)
shutil.make_archive("/data/web/streetview", "zip", "/data/web", "streetview")
print("zip MB:", round(os.path.getsize("/data/web/streetview.zip") / 1e6, 1))
