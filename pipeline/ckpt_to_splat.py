"""Convert a gsplat simple_trainer checkpoint (.pt) to the web .splat format (32 B/splat)."""
import sys, numpy as np, torch
SH_C0 = 0.28209479177387814
s = torch.load(sys.argv[1], map_location="cpu", weights_only=False)["splats"]
pos = s["means"].numpy().astype(np.float32)
scale = np.exp(s["scales"].numpy()).astype(np.float32)
q = s["quats"].numpy(); q = q / np.linalg.norm(q, axis=1, keepdims=True)
col = 0.5 + SH_C0 * s["sh0"].numpy().reshape(len(pos), -1)[:, :3]
alpha = 1 / (1 + np.exp(-s["opacities"].numpy().reshape(-1)))
order = np.argsort(-(scale.prod(1) * alpha))[: int(sys.argv[3]) if len(sys.argv) > 3 else 500000]
buf = np.zeros(len(order), dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
buf["p"], buf["s"] = pos[order], scale[order]
buf["c"] = np.clip(np.c_[col, alpha][order] * 255, 0, 255).astype(np.uint8)
buf["r"] = np.clip(q[order] * 128 + 128, 0, 255).astype(np.uint8)
open(sys.argv[2], "wb").write(buf.tobytes())
print(f"{len(order)} splats -> {sys.argv[2]} ({buf.nbytes / 1e6:.1f} MB)")
