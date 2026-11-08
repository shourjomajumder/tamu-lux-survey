#!/usr/bin/env bash
# Fetch named campus landmarks from OpenStreetMap (fields, parks, plazas, named buildings) for faint map labels.
set -e
python - <<'PY'
import json, requests
bbox = "30.6085,-96.3481,30.6193,-96.3325"
q = f"""[out:json][timeout:120];(
 way["name"]["leisure"]({bbox}); relation["name"]["leisure"]({bbox});
 way["name"]["building"]({bbox}); way["name"]["amenity"]({bbox}); way["name"]["landuse"]({bbox});
 way["name"]["place"]({bbox}); node["name"]["historic"]({bbox}); node["name"]["tourism"]({bbox}); way["name"]["highway"="pedestrian"]({bbox});
);out center tags;"""
hdr = {"User-Agent": "tamu-lux-survey/1.0 (TAMU Datathon dataset build)"}
els = []
for url in ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"):
    try:
        r = requests.post(url, data={"data": q}, headers=hdr, timeout=180)
        if r.ok and r.text.lstrip().startswith("{"): els = r.json()["elements"]; break
        print(url, r.status_code)
    except Exception as e: print(url, e)
feats = []
for e in els:
    t = e.get("tags", {}); c = e.get("center") or ({"lat": e.get("lat"), "lon": e.get("lon")})
    if not c or c.get("lat") is None: continue
    kind = ("field" if t.get("leisure") in ("pitch", "stadium", "park", "garden", "sports_centre") or t.get("landuse") in ("grass", "recreation_ground") else
            "building" if "building" in t else "plaza" if t.get("highway") == "pedestrian" else "landmark")
    feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(c["lon"], 7), round(c["lat"], 7)]},
                  "properties": {"name": t["name"], "kind": kind, "osm": f'{e["type"]}/{e["id"]}'}})
seen = set(); out = []
for f in feats:
    k = (f["properties"]["name"], f["properties"]["kind"])
    if k in seen: continue
    seen.add(k); out.append(f)
json.dump({"type": "FeatureCollection", "features": out}, open("results/final/landmarks.geojson", "w"), separators=(",", ":"))
from collections import Counter; print(len(out), Counter(f["properties"]["kind"] for f in out))
PY
