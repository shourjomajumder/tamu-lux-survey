#!/usr/bin/env bash
# Render preview images of the point cloud for Claude to check (top view + oblique close-up).
set -e
python - <<'PY'
import numpy as np
from PIL import Image
b = np.fromfile("/data/web/pointcloud/campus.bin", dtype=[("p", "<i2", 3), ("c", "u1", 3)])
P = b["p"].astype(np.float32) / 10; C = b["c"]
def render(mask, W, H, proj, name, scale_bright=2.2):
    x, y, d = proj(P[mask]); c = C[mask].astype(np.float32)
    img = np.zeros((H, W, 3), np.float32); zb = np.full((H, W), np.inf)
    xi = ((x - x.min()) / (x.max() - x.min() + 1e-6) * (W - 1)).astype(int); yi = ((y.max() - y) / (y.max() - y.min() + 1e-6) * (H - 1)).astype(int)
    o = np.argsort(-d)
    img[yi[o], xi[o]] = c[o]
    Image.fromarray(np.clip(img * scale_bright, 0, 255).astype(np.uint8)).save(f"results/review/{name}.jpg", quality=85)
m = np.ones(len(P), bool)
render(m, 1600, 1150, lambda Q: (Q[:, 0], Q[:, 1], -Q[:, 2]), "pointcloud_top")
cx, cy = np.median(P[:, 0]), np.median(P[:, 1])
m2 = (np.abs(P[:, 0] - cx) < 90) & (np.abs(P[:, 1] - cy) < 90)
a = np.radians(35)
render(m2, 1600, 900, lambda Q: (Q[:, 0] - cx, (Q[:, 1] - cy) * np.sin(a) + Q[:, 2] * np.cos(a), -(Q[:, 1] - cy)), "pointcloud_oblique")
print("points", len(P), "z pct", np.percentile(P[:, 2], [1, 50, 99]))
PY
ls -lh results/review/pointcloud_*
