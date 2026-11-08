"""Load the walk data into MongoDB Atlas (database: lux_survey).

Collections (all positions are GeoJSON Points with a 2dsphere index):
  walks       one per phone session (walker, start, duration, counts)
  readings    one per light reading, ~1/s (lux, time, walker, position, phone direction)
  photos      one per photo (position, heading, lux, blurred file name)
  detections  one per detected object (class, confidence, estimated position)
"""
import csv, glob, json, os, sys
from bisect import bisect_left
from pathlib import Path
from pymongo import MongoClient, GEOSPHERE, ASCENDING

SESS_ROOT = Path(os.environ.get("SESS_ROOT", "/data/sessions"))
db = MongoClient(os.environ["MONGODB_URI"])["lux_survey"]


def pt(lon, lat):
    return {"type": "Point", "coordinates": [float(lon), float(lat)]}


def fnum(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


for col in ("readings", "photos", "detections"):
    db[col].create_index([("loc", GEOSPHERE)])
    db[col].create_index([("session", ASCENDING)])

for sdir in sorted(p for p in SESS_ROOT.iterdir() if (p / "session.json").exists()):
    name = sdir.name
    meta = json.load(open(sdir / "session.json"))
    walker = int(meta.get("route_id") or meta.get("walker") or name[1:2])
    for col in ("walks", "readings", "photos", "detections"):
        db[col].delete_many({"session": name})          # re-runnable

    gps = [r for r in csv.DictReader(open(sdir / "gps.csv")) if fnum(r["lat"]) and fnum(r["h_acc"]) and float(r["h_acc"]) <= 25]
    ge = [float(r["epoch"]) for r in gps]

    def where(e):
        if not ge:
            return None
        i = min(max(bisect_left(ge, e), 1), len(ge) - 1)
        a, b = gps[i - 1], gps[i]
        if abs(float(b["epoch"]) - e) > 3 and abs(float(a["epoch"]) - e) > 3:
            return None
        f = 0 if ge[i] == ge[i - 1] else min(max((e - ge[i - 1]) / (ge[i] - ge[i - 1]), 0), 1)
        return (float(a["lat"]) + (float(b["lat"]) - float(a["lat"])) * f,
                float(a["lon"]) + (float(b["lon"]) - float(a["lon"])) * f, a, b)

    # readings: median lux per whole second
    buckets = {}
    for r in csv.DictReader(open(sdir / "lux.csv")):
        lux = fnum(r["lux"])
        if lux is None:
            continue
        buckets.setdefault(int(float(r["epoch"])), []).append(lux)
    docs = []
    for sec, vals in sorted(buckets.items()):
        w_ = where(sec + 0.5)
        if not w_:
            continue
        vals.sort()
        lat, lon, a, b = w_
        docs.append({"session": name, "walker": walker, "t": sec, "lux": vals[len(vals) // 2], "n": len(vals),
                     "loc": pt(lon, lat), "heading": fnum(b.get("phone_heading_deg")),
                     "walking": b.get("walking"), "recording": b.get("recording") == "1",
                     "route_progress_m": fnum(b.get("route_progress_m"))})
    if docs:
        db.readings.insert_many(docs)

    pdocs = []
    for r in csv.DictReader(open(sdir / "photos.csv")):
        lat, lon = fnum(r["lat"]), fnum(r["lon"])
        if lat is None:
            continue
        pdocs.append({"session": name, "walker": walker, "file": r["file"], "index": int(r["index"]),
                      "t": fnum(r["epoch"]), "loc": pt(lon, lat), "heading": fnum(r.get("heading_deg")),
                      "h_acc": fnum(r.get("h_acc")), "scene_ev100": fnum(r.get("scene_ev100")),
                      "blurred_path": f"blurred/{name}/{r['file']}"})
    if pdocs:
        db.photos.insert_many(pdocs)

    det_csv = Path("results/detections") / f"{name}.csv"
    ddocs = []
    if det_csv.exists():
        for r in csv.DictReader(open(det_csv)):
            lat, lon = fnum(r["est_lat"]), fnum(r["est_lon"])
            plat, plon = fnum(r["photo_lat"]), fnum(r["photo_lon"])
            if plat is None:
                continue
            ddocs.append({"session": name, "walker": walker, "file": r["file"], "class": r["class"],
                          "conf": fnum(r["conf"]), "t": fnum(r["epoch"]), "bearing": fnum(r["bearing_deg"]),
                          "est_dist_m": fnum(r["est_dist_m"]), "photo_loc": pt(plon, plat),
                          "loc": pt(lon, lat) if lat is not None else pt(plon, plat)})
    if ddocs:
        db.detections.insert_many(ddocs)

    db.walks.insert_one({"session": name, "walker": walker, "start": meta.get("start_iso"),
                         "duration_s": meta.get("duration_s"), "status": meta.get("status"),
                         "device": meta.get("device_model"), "readings": len(docs), "photos": len(pdocs),
                         "detections": len(ddocs)})
    print(f"{name}: {len(docs)} readings, {len(pdocs)} photos, {len(ddocs)} detections")

print({c: db[c].estimated_document_count() for c in ("walks", "readings", "photos", "detections")})
