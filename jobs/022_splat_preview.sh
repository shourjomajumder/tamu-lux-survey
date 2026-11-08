#!/usr/bin/env bash
# Render preview images of the two 3D splat scans (points coloured by splat colour, from the training cameras' side).
set -e
python - <<'PY'
import numpy as np, json
from PIL import Image
for n in ("spot1", "spot2"):
    b = np.fromfile(f"/data/web/splats/{n}.splat", dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
    P = b["p"]; C = b["c"][:, :3].astype(np.float32); A = b["c"][:, 3] / 255.0
    lo, hi = np.percentile(P, 3, 0), np.percentile(P, 97, 0)
    m = np.all((P > lo) & (P < hi), 1) & (A > 0.2)
    P, C = P[m], C[m]
    ctr = np.median(P, 0)
    for k, (yaw, pit) in enumerate([(0, 0.25), (0.6, 0.35), (-0.6, 0.15)]):
        Q = P - ctr
        cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pit), np.sin(pit)
        X = Q[:, 0] * cy - Q[:, 2] * sy; Z0 = Q[:, 0] * sy + Q[:, 2] * cy
        Y = -Q[:, 1] * cp - Z0 * sp; D = -Q[:, 1] * sp + Z0 * cp
        d = D - D.min() + np.ptp(D) * 0.8 + 1e-3
        f = 900 / np.percentile(np.abs(X / d), 98)
        W, H = 1200, 900
        u = (W / 2 + X / d * f * 0.45).astype(int); v = (H / 2 + Y / d * f * 0.45).astype(int)
        ok = (u >= 0) & (u < W) & (v >= 0) & (v < H)
        img = np.zeros((H, W, 3), np.float32); o = np.argsort(-d[ok])
        img[v[ok][o], u[ok][o]] = C[ok][o]
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(f"results/review/splat_{n}_view{k}.jpg", quality=88)
    print(n, len(P), "points kept")
PY
ls -lh results/review/splat_*
