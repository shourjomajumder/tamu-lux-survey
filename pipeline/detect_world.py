"""Second GPU pass: open-vocabulary detection (YOLO-World) of lighting infrastructure and trees.

Finds objects the COCO model can't: street lamps, lamp posts, wall lights, emergency call boxes, trees.
Writes one row per detection with the camera ray (bearing + elevation) so lamps/trees can be
triangulated from several photos later.

Input : /data/sessions/<session>/photos/*.jpg + photos.csv
Output: results/world/<session>.csv
        results/review/<session>_world_NN.jpg   (annotated sheets for checking)
"""
import csv, math, os, sys, time
from pathlib import Path
import cv2, numpy as np
from PIL import Image, ImageOps
from ultralytics import YOLOWorld

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
OUT = Path("results/world"); OUT.mkdir(parents=True, exist_ok=True)
REV = Path("results/review"); REV.mkdir(parents=True, exist_ok=True)

# prompt -> canonical class used downstream
PROMPTS = {
    "street lamp": "streetlight", "street light": "streetlight", "lamp post": "streetlight",
    "light pole": "streetlight", "lantern": "streetlight",
    "wall mounted light": "wall_light", "building light fixture": "wall_light", "ceiling light": "wall_light",
    "bollard light": "bollard_light",
    "emergency call box": "emergency_phone", "blue light emergency phone": "emergency_phone",
    "tree": "tree", "tree canopy": "tree", "bush": "shrub",
    "car headlight": "vehicle_light", "tail light": "vehicle_light",
}
model = YOLOWorld(os.environ.get("WORLD_MODEL", "yolov8x-worldv2.pt"))
model.set_classes(list(PROMPTS))
names = list(PROMPTS)


def load_portrait(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)


def process(sdir: Path):
    rows = {r["file"]: r for r in csv.DictReader(open(sdir / "photos.csv"))}
    files = [f for f in rows if (sdir / f).exists()]
    out = open(OUT / f"{sdir.name}.csv", "w", newline="")
    w = csv.writer(out)
    w.writerow(["session", "file", "photo_index", "epoch", "class", "prompt", "conf", "x0", "y0", "x1", "y1", "img_w", "img_h",
                "photo_lat", "photo_lon", "h_acc", "heading_deg", "pitch_deg", "bearing_deg", "elev_off_deg", "photo_lux_y"])
    sheet, t0, n = [], time.time(), 0
    for i in range(0, len(files), 16):
        chunk = files[i:i + 16]
        imgs = [load_portrait(sdir / f) for f in chunk]
        res = model.predict(imgs, conf=0.12, iou=0.5, imgsz=800, verbose=False, half=True)
        for f, img, d in zip(chunk, imgs, res):
            r = rows[f]; H, W = img.shape[:2]
            fpx = float(r.get("fy_px") or 1400)
            cxp = W - 1 - float(r.get("cy_px") or W / 2)      # portrait principal point (x)
            cyp = float(r.get("cx_px") or H / 2)              # portrait principal point (y)
            heading = float(r.get("heading_deg") or 0)
            for b in d.boxes:
                prompt = names[int(b.cls)]; cls = PROMPTS[prompt]
                x0, y0, x1, y1 = b.xyxy[0].tolist()
                bearing = (heading + math.degrees(math.atan(((x0 + x1) / 2 - cxp) / fpx))) % 360
                top = y0 if cls in ("streetlight", "wall_light") else (y0 + y1) / 2   # aim at the lamp head
                elev = math.degrees(math.atan((cyp - top) / fpx))
                w.writerow([sdir.name, f, r.get("index"), r.get("epoch"), cls, prompt, round(float(b.conf), 3),
                            round(x0), round(y0), round(x1), round(y1), W, H, r.get("lat"), r.get("lon"), r.get("h_acc"),
                            r.get("heading_deg"), r.get("pitch_deg"), round(bearing, 2), round(elev, 2), r.get("linear_y")])
                n += 1
            if len(d.boxes) and len(sheet) < 96 and int(r.get("index") or 0) % 7 == 0:
                sheet.append(d.plot(img=img.copy(), line_width=3))
        done = min(i + 16, len(files))
        print(f"{sdir.name}: {done}/{len(files)} photos, {n} objects, {done / max(1e-6, time.time() - t0):.1f} img/s", flush=True)
    out.close()
    for s in range(0, len(sheet), 24):
        tiles = [cv2.resize(t, (180, 320)) for t in sheet[s:s + 24]]
        while len(tiles) % 6: tiles.append(np.zeros_like(tiles[0]))
        grid = np.vstack([np.hstack(tiles[k:k + 6]) for k in range(0, len(tiles), 6)])
        cv2.imwrite(str(REV / f"{sdir.name}_world_{s // 24:02d}.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 70])


if __name__ == "__main__":
    targets = sys.argv[1:] or [p.name for p in sorted(SESS_ROOT.iterdir()) if (p / "photos.csv").exists()]
    for t in targets:
        process(SESS_ROOT / t)
    print("done")
