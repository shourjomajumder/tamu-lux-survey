"""GPU pass 4: a vision-language model describes the photos that matter most
(low-light warning spots, possibly-broken lamps, plus an even sample of the whole survey).

Model: Qwen2.5-VL-3B-Instruct.  Uses the privacy-blurred copies only.
Output: results/final/scene_notes.csv  (session, file, lat, lon, reason, JSON fields + one-line note)
"""
import csv, json, os, re, sys, time
from pathlib import Path
import numpy as np, pandas as pd, torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from geo import to_xy

BLUR = Path(os.environ.get("BLUR_ROOT", "/data/blurred"))
FIN = Path("results/final")
MAX_N = int(os.environ.get("VLM_MAX", "1800"))
MODEL = os.environ.get("VLM_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")

from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
model = Qwen2_5_VLForConditionalGeneration.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="cuda").eval()
proc = AutoProcessor.from_pretrained(MODEL, min_pixels=256 * 28 * 28, max_pixels=640 * 28 * 28)

PROMPT = ("You are auditing night-time pedestrian safety on a university campus. Look at this photo taken by a walker "
          "and answer ONLY with compact JSON with these keys: "
          '"path_type" (sidewalk|road|crosswalk|plaza|parking lot|stairs|grass|other), '
          '"visible_lights" (integer count of light fixtures visible), '
          '"lights_on" (true|false|null), '
          '"obstructions" (list of short strings, e.g. "tree canopy", "hedge", "construction", "parked cars"), '
          '"hiding_spots" (true|false), "people_visible" (integer), "sightline" (open|partial|blocked), '
          '"hazards" (list of short strings), '
          '"note" (one sentence, max 20 words, plain English, about how safe/visible this spot feels at night).')

photos = pd.read_csv(FIN / "photos_index.csv").dropna(subset=["lat"])
photos["x"], photos["y"] = to_xy(photos.lat, photos.lon)
pick = {}


def add_near(geojson, reason, radius, per):
    p = FIN / geojson
    if not p.exists(): return
    from scipy.spatial import cKDTree
    kd = cKDTree(photos[["x", "y"]].values)
    for f in json.load(open(p))["features"]:
        lon, lat = f["geometry"]["coordinates"][:2] if f["geometry"]["type"] == "Point" else np.mean(f["geometry"]["coordinates"], 0)
        x, y = to_xy(lat, lon)
        idx = kd.query_ball_point([x, y], radius)[:per]
        for i in idx:
            pick.setdefault(i, reason)


add_near("warnings.geojson", "low-light warning", 10, 3)
add_near("lamps_possibly_out.geojson", "lamp possibly out", 20, 2)
step = max(1, len(photos) // max(1, (MAX_N - len(pick))))
for i in range(0, len(photos), step):
    pick.setdefault(i, "survey sample")
order = sorted(pick)[:MAX_N]
print(f"describing {len(order)} photos", flush=True)

out = open(FIN / "scene_notes.csv", "w", newline=""); w = csv.writer(out)
cols = ["path_type", "visible_lights", "lights_on", "obstructions", "hiding_spots", "people_visible", "sightline", "hazards", "note"]
w.writerow(["session", "file", "epoch", "lat", "lon", "reason"] + cols)
t0 = time.time()
B = 6
for k in range(0, len(order), B):
    imgs, rows, reasons = [], [], []
    for i in order[k:k + B]:
        r = photos.iloc[i]
        fp = BLUR / r.session / r.file
        if not fp.exists(): continue
        imgs.append(Image.open(fp).convert("RGB")); rows.append(r); reasons.append(pick[i])
    if not imgs: continue
    msgs = [[{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT}]}] for _ in imgs]
    texts = [proc.apply_chat_template(m, tokenize=False, add_generation_prompt=True) for m in msgs]
    inputs = proc(text=texts, images=imgs, return_tensors="pt", padding=True).to("cuda")
    with torch.inference_mode():
        gen = model.generate(**inputs, max_new_tokens=160, do_sample=False)
    outs = proc.batch_decode(gen[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)
    for r, why, o in zip(rows, reasons, outs):
        m = re.search(r"\{.*\}", o, re.S)
        try:
            j = json.loads(m.group(0)) if m else {}
        except Exception:
            j = {"note": o.strip()[:200]}
        w.writerow([r.session, r.file, r.epoch, r.lat, r.lon, why] +
                   [json.dumps(j.get(c)) if isinstance(j.get(c), (list, dict, bool)) else j.get(c, "") for c in cols])
    done = min(k + B, len(order))
    if done % 60 < B:
        out.flush()
        print(f"{done}/{len(order)}  {done / max(1e-6, time.time() - t0):.2f} img/s", flush=True)
out.close()
print("done")
