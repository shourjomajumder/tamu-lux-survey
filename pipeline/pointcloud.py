"""3D photo point cloud of campus at night.

For every Street View frame (~5,000 privacy-blurred photos): metric depth (Depth Anything V2, outdoor metric)
at 216x384, back-project pixels 1.5-30 m away into local metres using GPS + the phone's attitude
quaternion (same camera model as geo.pixel_ray, verified ~1.4 deg vs logged heading), colour from the photo.
Fused and voxel-downsampled (0.35 m), capped at ~2.5M points.

Output: /data/web/pointcloud/campus.bin  (int16 x,y,z in decimetres local frame + uint8 r,g,b = 9 bytes/pt)
        /data/web/pointcloud/meta.json
        /data/web/pointcloud.zip
"""
import csv, json, math, os, shutil, sys, time
from pathlib import Path
import numpy as np, torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

sys.path.insert(0, str(Path(__file__).parent))
from geo import qmat, to_xy

SESS, SV, OUT = Path("/data/sessions"), Path("/data/web/streetview"), Path("/data/web/pointcloud")
OUT.mkdir(parents=True, exist_ok=True)
ID = "depth-anything/Depth-Anything-V2-Metric-Outdoor-Base-hf"
proc = AutoImageProcessor.from_pretrained(ID)
model = AutoModelForDepthEstimation.from_pretrained(ID).to("cuda").half().eval()
index = json.load(open(SV / "index.json"))
rows = {}
for s in {f["s"] for f in index}:
    for r in csv.DictReader(open(SESS / s / "photos.csv")):
        rows[(s, int(r["index"]))] = r

W, H = 216, 384            # depth / sampling resolution (portrait)
STEP = 2                   # sample every 2nd pixel
VOX = 0.35
us, vs = np.meshgrid(np.arange(0, W, STEP), np.arange(0, H, STEP))
us, vs = us.ravel().astype(np.float32), vs.ravel().astype(np.float32)
acc = {}                   # voxel key -> [sumx,sumy,sumz,sumr,sumg,sumb,n]
keys_all, cols_all, pts_all = [], [], []
t0 = time.time()
B = 16
for k in range(0, len(index), B):
    batch = index[k:k + B]
    ims = [Image.open(SV / f["s"] / f"{f['i']}.jpg").convert("RGB") for f in batch]
    with torch.inference_mode():
        inp = proc(images=ims, return_tensors="pt").to("cuda")
        dep = model(pixel_values=inp["pixel_values"].half()).predicted_depth.float()
        dep = torch.nn.functional.interpolate(dep[:, None], size=(H, W), mode="bilinear")[:, 0].cpu().numpy()
    for f, im, d in zip(batch, ims, dep):
        r = rows.get((f["s"], f["i"]))
        if r is None or not r.get("qw"):
            continue
        rgb = np.asarray(im.resize((W, H), Image.BILINEAR), dtype=np.float32)
        # intrinsics scaled from the 1080x1920 portrait photo to W x H
        sc = W / 1080.0
        fpx = float(r.get("fy_px") or 1400) * sc
        cxp = (1080 - 1 - float(r.get("cy_px") or 540)) * sc
        cyp = float(r.get("cx_px") or 960) * sc
        dd = d[vs.astype(int), us.astype(int)]
        m = (dd > 1.5) & (dd < 30)
        if m.sum() < 50: continue
        u, v, z = us[m], vs[m], dd[m]
        dev = np.stack([(u - cxp) / fpx, (cyp - v) / fpx, -np.ones_like(u)], 1)   # z-depth along -Z
        R = qmat(float(r["qw"]), float(r["qx"]), float(r["qy"]), float(r["qz"]))
        w = (dev * z[:, None]) @ R.T            # reference frame: x north, y west, z up
        cx, cy = to_xy(float(r["lat"]), float(r["lon"]))
        X = cx + (-w[:, 1]); Y = cy + w[:, 0]; Z = 1.4 + w[:, 2]
        keep = (Z > -1.0) & (Z < 25)
        c = rgb[v[keep].astype(int), u[keep].astype(int)]
        c = np.clip(c * 1.6 + 6, 0, 255)       # lift night exposure a little
        pts_all.append(np.stack([X[keep], Y[keep], Z[keep]], 1).astype(np.float32)); cols_all.append(c.astype(np.uint8))
    if (k // B) % 20 == 0:
        print(f"{min(k + B, len(index))}/{len(index)} frames  {(k + B) / max(1e-6, time.time() - t0):.1f} fps", flush=True)

P = np.concatenate(pts_all); C = np.concatenate(cols_all).astype(np.float32)
print("raw points", len(P), flush=True)
vk = np.floor(P / VOX).astype(np.int64)
key = (vk[:, 0] + 100000) * 10**10 + (vk[:, 1] + 100000) * 10**5 + (vk[:, 2] + 1000)
uk, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
Pm = np.zeros((len(uk), 3)); Cm = np.zeros((len(uk), 3))
np.add.at(Pm, inv, P); np.add.at(Cm, inv, C)
Pm /= cnt[:, None]; Cm /= cnt[:, None]
# drop isolated voxels (seen once) to cut noise, keep the best-supported if too many
good = cnt >= 2
Pm, Cm, cnt = Pm[good], Cm[good], cnt[good]
CAP = 2_500_000
if len(Pm) > CAP:
    sel = np.argsort(-cnt)[:CAP]; Pm, Cm = Pm[sel], Cm[sel]
q = np.clip(np.round(Pm * 10), -32760, 32760).astype(np.int16)
buf = np.zeros(len(q), dtype=[("p", "<i2", 3), ("c", "u1", 3)])
buf["p"], buf["c"] = q, np.clip(Cm, 0, 255).astype(np.uint8)
buf.tofile(OUT / "campus.bin")
meta = dict(points=int(len(q)), bytes_per_point=9, format="int16 x,y,z (decimetres, local frame: x east, y north, z up from ground) + uint8 r,g,b",
            origin=dict(lat=30.615, lon=-96.34), voxel_m=VOX, frames=len(index), depth_model=ID,
            note="Positions from phone GPS (+-5-15 m) and attitude; expect some ghosting where walks overlap.")
json.dump(meta, open(OUT / "meta.json", "w"), indent=1)
print(json.dumps(meta))
shutil.make_archive("/data/web/pointcloud", "zip", "/data/web", "pointcloud")
print("zip MB", round(os.path.getsize("/data/web/pointcloud.zip") / 1e6, 1))
