"""Convert a 3D Gaussian Splatting .ply into the compact .splat format used by web viewers
(32 bytes per splat: position f32x3, scale f32x3, rgba u8x4, rotation u8x4). Sorted by importance."""
import sys
import numpy as np
from plyfile import PlyData

SH_C0 = 0.28209479177387814
v = PlyData.read(sys.argv[1])["vertex"]
pos = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)
scale = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)).astype(np.float32)
rot = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], 1)
rot = rot / np.linalg.norm(rot, axis=1, keepdims=True)
col = 0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)
alpha = 1 / (1 + np.exp(-np.asarray(v["opacity"])))
order = np.argsort(-(scale.prod(1) * alpha))
keep = order[: int(sys.argv[3]) if len(sys.argv) > 3 else 600000]
out = bytearray()
rgba = np.clip(np.c_[col, alpha] * 255, 0, 255).astype(np.uint8)
r8 = np.clip(rot * 128 + 128, 0, 255).astype(np.uint8)
buf = np.zeros(len(keep), dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
buf["p"], buf["s"], buf["c"], buf["r"] = pos[keep], scale[keep], rgba[keep], r8[keep]
open(sys.argv[2], "wb").write(buf.tobytes())
print(f"{len(keep)} splats -> {sys.argv[2]} ({len(buf.tobytes()) / 1e6:.1f} MB)")
