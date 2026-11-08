"""Detect cars / people / bikes etc. in every walk photo, blur faces and number plates,
and estimate where each detected object was on the map.

Input : /data/sessions/<session>/photos/*.jpg + photos.csv   (unzipped phone sessions)
Output: /data/blurred/<session>/<file>.jpg                    (privacy-safe copies)
        results/detections/<session>.csv                      (one row per detected object)
        results/review/<session>_sheet_<n>.jpg                (small grids for Claude to check)

Privacy rule: faces AND the head area of every detected person AND the plate zone of every
vehicle are blurred, so a missed face/plate detection still gets covered.
"""
import csv, math, os, sys, glob, time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from ultralytics import YOLO

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
BLUR_ROOT = Path(os.environ.get("BLUR_ROOT", "/data/blurred"))
OUT = Path("results/detections"); OUT.mkdir(parents=True, exist_ok=True)
REV = Path("results/review"); REV.mkdir(parents=True, exist_ok=True)

KEEP = {"person", "bicycle", "car", "motorcycle", "bus", "truck", "traffic light", "stop sign",
        "bench", "fire hydrant", "parking meter", "dog", "backpack", "umbrella", "potted plant"}
VEHICLES = {"car", "bus", "truck", "motorcycle"}
HEIGHT_M = {"person": 1.7, "car": 1.5, "truck": 3.0, "bus": 3.2, "bicycle": 1.0, "motorcycle": 1.1,
            "traffic light": 0.9, "stop sign": 0.75, "bench": 0.8, "fire hydrant": 0.8, "dog": 0.6}

det_model = YOLO(os.environ.get("DET_MODEL", "yolov8x.pt"))   # COCO classes, auto-download
face_model = None
try:
    from huggingface_hub import hf_hub_download
    face_model = YOLO(hf_hub_download("arnabdhar/YOLOv8-Face-Detection", "model.pt"))
except Exception as e:
    print("face model unavailable, using person-head blur only:", e)


def blur_box(img, x0, y0, x1, y1):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(w, int(x1)), min(h, int(y1))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return
    roi = img[y0:y1, x0:x1]
    k = max(15, (max(x1 - x0, y1 - y0) // 3) | 1)
    img[y0:y1, x0:x1] = cv2.GaussianBlur(roi, (k, k), 0)


def load_portrait(path):
    """Photos are stored landscape with EXIF orientation 6 → rotate to how the walker saw it."""
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)


def offset_m(lat, lon, bearing_deg, dist_m):
    b = math.radians(bearing_deg)
    dlat = dist_m * math.cos(b) / 111320.0
    dlon = dist_m * math.sin(b) / (111320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def process_session(sdir: Path):
    name = sdir.name
    rows = {r["file"]: r for r in csv.DictReader(open(sdir / "photos.csv"))}
    files = sorted(rows)
    out_dir = BLUR_ROOT / name; out_dir.mkdir(parents=True, exist_ok=True)
    det_path = OUT / f"{name}.csv"
    w = csv.writer(open(det_path, "w", newline=""))
    w.writerow(["session", "file", "photo_index", "epoch", "class", "conf", "x0", "y0", "x1", "y1",
                "photo_lat", "photo_lon", "heading_deg", "bearing_deg", "est_dist_m", "est_lat", "est_lon", "photo_lux"])
    review, t0 = [], time.time()
    batch = 16
    for i in range(0, len(files), batch):
        chunk = files[i:i + batch]
        imgs = [load_portrait(sdir / f) for f in chunk]
        dets = det_model.predict(imgs, conf=0.30, verbose=False, half=True)
        faces = face_model.predict(imgs, conf=0.30, verbose=False, half=True) if face_model else [None] * len(imgs)
        for f, img, d, fc in zip(chunk, imgs, dets, faces):
            r = rows[f]
            H, W = img.shape[:2]
            # portrait intrinsics from the landscape sensor values
            fpx = float(r.get("fy_px") or r.get("fx_px") or 1400)
            cxp = W - 1 - float(r.get("cy_px") or (W / 2))
            lat, lon = float(r["lat"] or 0), float(r["lon"] or 0)
            heading = float(r.get("heading_deg") or 0)
            for b in d.boxes:
                cls = d.names[int(b.cls)]
                if cls not in KEEP:
                    continue
                x0, y0, x1, y1 = b.xyxy[0].tolist()
                bearing = (heading + math.degrees(math.atan(((x0 + x1) / 2 - cxp) / fpx))) % 360
                hm = HEIGHT_M.get(cls)
                dist = (fpx * hm / max(y1 - y0, 1)) if hm else None
                elat, elon = offset_m(lat, lon, bearing, dist) if (dist and lat) else ("", "")
                w.writerow([name, f, r.get("index"), r.get("epoch"), cls, round(float(b.conf), 3),
                            round(x0), round(y0), round(x1), round(y1), lat, lon, round(heading, 1), round(bearing, 1),
                            round(dist, 1) if dist else "", elat, elon, r.get("lux") or r.get("photo_lux") or ""])
                # privacy blur
                if cls == "person":
                    blur_box(img, x0, y0, x1, y0 + (y1 - y0) * 0.24)          # head zone
                elif cls in VEHICLES:
                    blur_box(img, x0, y0 + (y1 - y0) * 0.55, x1, y1)          # lower body = plate zone
            if fc is not None:
                for b in fc.boxes:
                    x0, y0, x1, y1 = b.xyxy[0].tolist()
                    pad = 0.25 * (x1 - x0)
                    blur_box(img, x0 - pad, y0 - pad, x1 + pad, y1 + pad)
            cv2.imwrite(str(out_dir / f), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if len(d.boxes) and len(review) < 400 and int(r.get("index") or 0) % 5 == 0:
                review.append(d.plot(img=img.copy(), line_width=2))
        if i % (batch * 25) == 0:
            print(f"{name}: {i + len(chunk)}/{len(files)} photos, {time.time() - t0:.0f}s", flush=True)
    # review sheets (small, blurred) for Claude
    for s in range(0, len(review), 24):
        tiles = [cv2.resize(t, (180, 320)) for t in review[s:s + 24]]
        while len(tiles) % 6:
            tiles.append(np.zeros((320, 180, 3), np.uint8))
        rowsimg = [np.hstack(tiles[k:k + 6]) for k in range(0, len(tiles), 6)]
        cv2.imwrite(str(REV / f"{name}_sheet_{s // 24:02d}.jpg"), np.vstack(rowsimg), [cv2.IMWRITE_JPEG_QUALITY, 70])
    print(f"{name}: done, {len(files)} photos in {time.time() - t0:.0f}s -> {det_path}")


if __name__ == "__main__":
    targets = sys.argv[1:] or [p.name for p in sorted(SESS_ROOT.iterdir()) if (p / "photos.csv").exists()]
    for t in targets:
        process_session(SESS_ROOT / t)
