"""GPU pass 3: scene understanding for every photo.

* SegFormer (Cityscapes) -> share of sky / trees / sidewalk / road / building / poles / people / cars,
  plus "canopy overhead" (vegetation in the upper part of the frame) and "walking surface"
  (sidewalk vs road in the lower part).
* Depth Anything V2 (metric, outdoor) -> distance in metres to every detected object
  (COCO detections from pass 1 and lamps/trees from pass 2), used to place them on the map.

Input : /data/sessions/<s>/photos/*.jpg, photos.csv, results/detections/<s>.csv, results/world/<s>.csv
Output: results/scene/<s>.csv          one row per photo
        results/scene/<s>_objdepth.csv one row per detected object with metric depth
"""
import csv, os, sys, time
from collections import defaultdict
from pathlib import Path
import numpy as np, torch
from PIL import Image, ImageOps
from transformers import (AutoImageProcessor, AutoModelForDepthEstimation,
                          SegformerForSemanticSegmentation, SegformerImageProcessor)

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
OUT = Path("results/scene"); OUT.mkdir(parents=True, exist_ok=True)
dev = "cuda"
SEG_ID = os.environ.get("SEG_MODEL", "nvidia/segformer-b3-finetuned-cityscapes-1024-1024")
DEP_ID = os.environ.get("DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Metric-Outdoor-Base-hf")
seg_proc = SegformerImageProcessor.from_pretrained(SEG_ID)
seg = SegformerForSemanticSegmentation.from_pretrained(SEG_ID).to(dev).half().eval()
dep_proc = AutoImageProcessor.from_pretrained(DEP_ID)
dep = AutoModelForDepthEstimation.from_pretrained(DEP_ID).to(dev).half().eval()
LABELS = seg.config.id2label            # cityscapes: 0 road,1 sidewalk,2 building,3 wall,4 fence,5 pole,6 traffic light,
GROUPS = {                               # 7 traffic sign,8 vegetation,9 terrain,10 sky,11 person,12 rider,13 car,14 truck,
    "road": [0], "sidewalk": [1], "building": [2, 3, 4], "pole": [5, 6, 7], "vegetation": [8],
    "terrain": [9], "sky": [10], "person": [11, 12], "vehicle": [13, 14, 15, 16, 17, 18],
}
W_SEG = 768                              # inference width (portrait images are resized to this width)


def load_portrait(path, width=W_SEG):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    h = int(im.height * width / im.width)
    return im.resize((width, h), Image.BILINEAR), im.size


def boxes_for(session):
    """file -> list of (source, row_id, class, x0,y0,x1,y1) in full-res portrait pixels."""
    out = defaultdict(list)
    for src, path in (("coco", Path(f"results/detections/{session}.csv")), ("world", Path(f"results/world/{session}.csv"))):
        if not path.exists():
            continue
        for i, r in enumerate(csv.DictReader(open(path))):
            out[r["file"]].append((src, i, r["class"], float(r["x0"]), float(r["y0"]), float(r["x1"]), float(r["y1"])))
    return out


@torch.inference_mode()
def run(sdir: Path):
    name = sdir.name
    rows = list(csv.DictReader(open(sdir / "photos.csv")))
    rows = [r for r in rows if (sdir / r["file"]).exists()]
    boxes = boxes_for(name)
    f1 = open(OUT / f"{name}.csv", "w", newline=""); w1 = csv.writer(f1)
    w1.writerow(["session", "file", "photo_index", "epoch", "lat", "lon"] + [f"frac_{g}" for g in GROUPS] +
                ["canopy_overhead", "sidewalk_underfoot", "road_underfoot", "open_sky_overhead", "median_depth_m", "near_depth_m"])
    f2 = open(OUT / f"{name}_objdepth.csv", "w", newline=""); w2 = csv.writer(f2)
    w2.writerow(["session", "file", "source", "row", "class", "depth_m_median", "depth_m_p20", "seg_class_in_box"])
    t0 = time.time()
    B = 8
    for i in range(0, len(rows), B):
        chunk = rows[i:i + B]
        ims, sizes = zip(*[load_portrait(sdir / r["file"]) for r in chunk])
        # --- segmentation
        sp = seg_proc(images=list(ims), return_tensors="pt").to(dev)
        logits = seg(pixel_values=sp["pixel_values"].half()).logits
        # --- depth
        dp = dep_proc(images=list(ims), return_tensors="pt").to(dev)
        depth = dep(pixel_values=dp["pixel_values"].half()).predicted_depth
        for k, r in enumerate(chunk):
            Wd, Hd = ims[k].size
            lab = torch.nn.functional.interpolate(logits[k:k + 1].float(), size=(Hd, Wd), mode="bilinear").argmax(1)[0].cpu().numpy()
            d = torch.nn.functional.interpolate(depth[k:k + 1, None].float(), size=(Hd, Wd), mode="bilinear")[0, 0].cpu().numpy()
            fr = {g: float(np.isin(lab, ids).mean()) for g, ids in GROUPS.items()}
            top, bot = lab[: int(Hd * 0.35)], lab[int(Hd * 0.70):]
            canopy = float(np.isin(top, GROUPS["vegetation"]).mean())
            sky_top = float(np.isin(top, GROUPS["sky"]).mean())
            side = float(np.isin(bot, GROUPS["sidewalk"]).mean()); road = float(np.isin(bot, GROUPS["road"]).mean())
            w1.writerow([name, r["file"], r.get("index"), r.get("epoch"), r.get("lat"), r.get("lon")] +
                        [round(fr[g], 4) for g in GROUPS] +
                        [round(canopy, 4), round(side, 4), round(road, 4), round(sky_top, 4),
                         round(float(np.median(d)), 2), round(float(np.percentile(d, 10)), 2)])
            sx = Wd / sizes[k][0]
            for (src, rid, cls, x0, y0, x1, y1) in boxes.get(r["file"], []):
                a, b, c, e = int(x0 * sx), int(y0 * sx), max(int(x1 * sx), int(x0 * sx) + 1), max(int(y1 * sx), int(y0 * sx) + 1)
                patch = d[max(0, b):min(Hd, e), max(0, a):min(Wd, c)]
                lp = lab[max(0, b):min(Hd, e), max(0, a):min(Wd, c)]
                if patch.size == 0:
                    continue
                top_lab = LABELS.get(int(np.bincount(lp.ravel()).argmax()), "?") if lp.size else "?"
                w2.writerow([name, r["file"], src, rid, cls, round(float(np.median(patch)), 2),
                             round(float(np.percentile(patch, 20)), 2), top_lab])
        done = min(i + B, len(rows))
        if done % 200 < B or done == len(rows):
            print(f"{name}: {done}/{len(rows)} photos  {done / max(1e-6, time.time() - t0):.1f} img/s", flush=True)
    f1.close(); f2.close()


if __name__ == "__main__":
    targets = sys.argv[1:] or [p.name for p in sorted(SESS_ROOT.iterdir()) if (p / "photos.csv").exists()]
    for t in targets:
        try:
            run(SESS_ROOT / t)
        except Exception as e:
            print(f"!! {t} failed: {e}", flush=True)
    print("done")
