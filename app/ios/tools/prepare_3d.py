#!/usr/bin/env python3
"""
Prepare a recorded walk for 3D reconstruction (structure-from-motion, e.g. COLMAP / OpenDroneMap).

    python3 prepare_3d.py path/to/Sessions/W2_... [--fps 3] [--use stills|video]

Needs: Python 3 + ffmpeg on PATH (only for --use video).

Writes <session>/derived/sfm/:
    images/               frames to reconstruct from (portrait, upright)
    image_list.txt        one image name per line
    gps_priors.txt        "name lat lon alt" — use with COLMAP model_aligner / ODM geo.txt to place the model on the map
    poses_enu.csv         name, east/north/up metres from the first fix, + phone orientation quaternion (CoreMotion, true-north frame)
    cameras.txt           COLMAP camera model from the phone's own intrinsics (PINHOLE fx fy cx cy), rotated to upright
    README_sfm.txt        the COLMAP commands to run

Why video frames: the back camera video is recorded continuously at 15 fps, so you can pull frames
as densely as the reconstruction needs (2–5 per second at walking pace gives good overlap).
The 1-per-second JPEG stills work too (--use stills) but give a sparser model.
Short-exposure "light snapshot" frames (bracket=1 in frames.csv) are skipped: they're for light sources, not geometry.
"""
import argparse, csv, math, os, subprocess, sys, shutil
sys.path.insert(0, os.path.dirname(__file__))
from build_viewer import read_csv, num, Track


def enu(lat, lon, alt, lat0, lon0, alt0):
    e = (lon - lon0) * 111320 * math.cos(math.radians(lat0))
    n = (lat - lat0) * 111320
    u = (alt or 0) - (alt0 or 0)
    return e, n, u


def rotated_intrinsics(fx, fy, cx, cy, w, h):
    """Sensor frame (landscape) → upright portrait (rotate 90° clockwise, EXIF orientation 6)."""
    return fy, fx, h - cy, cx, h, w


def image_size(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                              "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
        w, h = out.split(",")[:2]
        return int(w), int(h)
    except Exception:
        return (0, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--fps", type=float, default=3.0, help="frames per second to extract from video")
    ap.add_argument("--use", choices=["video", "stills"], default="video")
    a = ap.parse_args()

    S = a.session
    out = os.path.join(S, "derived", "sfm")
    img = os.path.join(out, "images")
    os.makedirs(img, exist_ok=True)
    track = Track(read_csv(os.path.join(S, "gps.csv")))
    rows = []   # (name, epoch, qw,qx,qy,qz, fx,fy,cx,cy,w,h)

    if a.use == "video":
        frames = read_csv(os.path.join(S, "frames.csv"))
        if not frames:
            sys.exit("No frames.csv / video in this session — rerun with --use stills")
        if not shutil.which("ffmpeg"):
            sys.exit("ffmpeg not found (brew install ffmpeg / apt install ffmpeg)")
        by_seg = {}
        for r in frames:
            by_seg.setdefault(r["segment"], []).append(r)
        for seg, fr in sorted(by_seg.items()):
            fr.sort(key=lambda r: int(r["frame"]))
            src_fps = 15.0
            step = max(1, round(src_fps / a.fps))
            keep = [r for r in fr if int(r["frame"]) % step == 0]   # decoded in this order
            video = os.path.join(S, "video", f"back_{int(seg):03d}.mov")
            if not os.path.exists(video):
                print("missing", video); continue
            tmpdir = os.path.join(out, f"_seg{seg}")
            os.makedirs(tmpdir, exist_ok=True)
            # Decode every step-th frame by index; ffmpeg applies the rotation metadata → upright images.
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", video, "-vf", f"select='not(mod(n\\,{step}))'",
                            "-vsync", "0", "-q:v", "2", os.path.join(tmpdir, "f_%06d.jpg")], check=True)
            outs = sorted(os.listdir(tmpdir))
            for k, (r, fn) in enumerate(zip(keep, outs)):
                if r.get("bracket") == "1":   # short-exposure light snapshot: not for geometry
                    os.remove(os.path.join(tmpdir, fn)); continue
                name = f"s{int(seg):03d}_f{int(r['frame']):06d}.jpg"
                os.replace(os.path.join(tmpdir, fn), os.path.join(img, name))
                rows.append((name, num(r["epoch"]), r.get("qw"), r.get("qx"), r.get("qy"), r.get("qz"),
                             num(r.get("fx_px")), num(r.get("fy_px")), num(r.get("cx_px")), num(r.get("cy_px")),
                             num(r.get("width")), num(r.get("height"))))
            shutil.rmtree(tmpdir, ignore_errors=True)
    else:
        for r in read_csv(os.path.join(S, "photos.csv")):
            src = os.path.join(S, r["file"])
            if not os.path.exists(src):
                continue
            name = os.path.basename(src)
            shutil.copy2(src, os.path.join(img, name))   # EXIF orientation=6; COLMAP reads pixels as stored
            rows.append((name, num(r["epoch"]), r.get("qw"), r.get("qx"), r.get("qy"), r.get("qz"),
                         num(r.get("fx_px")), num(r.get("fy_px")), num(r.get("cx_px")), num(r.get("cy_px")),
                         num(r.get("width")), num(r.get("height"))))

    if not rows:
        sys.exit("No images prepared.")
    origin = None
    with open(os.path.join(out, "image_list.txt"), "w") as fl, open(os.path.join(out, "gps_priors.txt"), "w") as fg, \
         open(os.path.join(out, "poses_enu.csv"), "w", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["name", "epoch", "lat", "lon", "alt", "east_m", "north_m", "up_m", "gps_acc_m", "qw", "qx", "qy", "qz"])
        for r in rows:
            fl.write(r[0] + "\n")
            p = track.at(r[1]) if r[1] else None
            if not p:
                continue
            if origin is None:
                origin = p
            e, n, u = enu(p[1], p[2], p[3], origin[1], origin[2], origin[3])
            fg.write(f"{r[0]} {p[1]:.8f} {p[2]:.8f} {p[3] or 0:.2f}\n")
            w.writerow([r[0], f"{r[1]:.3f}", f"{p[1]:.8f}", f"{p[2]:.8f}", f"{p[3] or 0:.2f}", f"{e:.2f}", f"{n:.2f}", f"{u:.2f}",
                        p[4], r[2], r[3], r[4], r[5]])

    # Camera model from the median intrinsics the phone reported.
    intr = [r for r in rows if r[6] and r[10]]
    with open(os.path.join(out, "cameras.txt"), "w") as fc:
        fc.write("# CAMERA_ID MODEL WIDTH HEIGHT PARAMS[]\n")
        if intr:
            med = lambda i: sorted(x[i] for x in intr)[len(intr) // 2]
            fx, fy, cx, cy, W, H = med(6), med(7), med(8), med(9), med(10), med(11)
            if a.use == "video":
                # ffmpeg normally auto-rotates iPhone video to portrait; only rotate intrinsics if it did.
                iw, ih = image_size(os.path.join(img, rows[0][0]))
                if (iw, ih) == (int(H), int(W)) and W != H:
                    fx, fy, cx, cy, W, H = rotated_intrinsics(fx, fy, cx, cy, W, H)
            fc.write(f"1 PINHOLE {int(W)} {int(H)} {fx:.2f} {fy:.2f} {cx:.2f} {cy:.2f}\n")
        else:
            fc.write("# no intrinsics recorded; let COLMAP estimate (SIMPLE_RADIAL)\n")

    open(os.path.join(out, "README_sfm.txt"), "w").write(f"""Images: {len(rows)}  (from {a.use})

COLMAP (https://colmap.github.io), run inside {out}:
  colmap feature_extractor --database_path db.db --image_path images --ImageReader.single_camera 1
  colmap sequential_matcher --database_path db.db --SequentialMatching.overlap 15 --SequentialMatching.loop_detection 0
  mkdir sparse && colmap mapper --database_path db.db --image_path images --output_path sparse
  colmap model_aligner --input_path sparse/0 --output_path sparse_geo --ref_images_path gps_priors.txt --ref_is_gps 1 --alignment_type enu --alignment_max_error 15
  (then dense: colmap image_undistorter → patch_match_stereo → stereo_fusion, or import into OpenDroneMap/Meshroom)

Light sources: bright blobs that stay saturated across frames triangulate to lamp positions using the solved camera poses.
Illuminance on the path: lux_1hz.csv (front camera) placed at the solved camera positions.
""")
    print(f"Prepared {len(rows)} images in {out}")


if __name__ == "__main__":
    main()
