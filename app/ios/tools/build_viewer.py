#!/usr/bin/env python3
"""
Turn one recorded walk into geo-referenced data + a map you can open in a browser.

    python3 build_viewer.py path/to/Sessions/W2_2026-11-07_210512

Writes into <session>/derived/:
    photos_geo.csv      every time-lapse photo with GPS interpolated to the exact capture time,
                        heading, phone orientation, and the light reading at that moment
    frames_geo.csv      same for every video frame (if video was recorded)
    lux_1hz.csv         light readings averaged to 1 per second, with interpolated position
    track.geojson       walked path + lux points + marks (open in QGIS / geojson.io)
    lights_geo.csv      every short-exposure light snapshot with exact-time GPS
    viewer.html         map: path coloured by lux, click any dot to see the photo taken there

Only needs Python 3 (no extra packages). The viewer loads map tiles from the internet.
"""
import csv, json, math, os, sys, bisect
from statistics import median


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


class Track:
    """GPS fixes, interpolated linearly in time."""
    def __init__(self, gps_rows, max_acc=50.0):
        pts = []
        for r in gps_rows:
            e, lat, lon, acc = num(r["epoch"]), num(r["lat"]), num(r["lon"]), num(r["h_acc"])
            if None in (e, lat, lon) or (acc is not None and (acc < 0 or acc > max_acc)):
                continue
            pts.append((e, lat, lon, num(r.get("alt_m")), acc))
        pts.sort()
        self.t = [p[0] for p in pts]
        self.p = pts

    def at(self, epoch, max_gap=10.0):
        if not self.t:
            return None
        i = bisect.bisect_left(self.t, epoch)
        if i == 0:
            return self.p[0] if self.t[0] - epoch < max_gap else None
        if i >= len(self.t):
            return self.p[-1] if epoch - self.t[-1] < max_gap else None
        a, b = self.p[i - 1], self.p[i]
        if b[0] - a[0] > max_gap:
            return None
        f = (epoch - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0
        lerp = lambda x, y: None if x is None or y is None else x + (y - x) * f
        return (epoch, lerp(a[1], b[1]), lerp(a[2], b[2]), lerp(a[3], b[3]), max(a[4] or 0, b[4] or 0))


class Series:
    """A time series of one numeric column, for nearest/median lookups."""
    def __init__(self, rows, col):
        v = [(num(r["epoch"]), num(r.get(col))) for r in rows]
        v = sorted((e, x) for e, x in v if e is not None and x is not None)
        self.t = [e for e, _ in v]
        self.v = [x for _, x in v]

    def median_around(self, epoch, half=0.5):
        lo = bisect.bisect_left(self.t, epoch - half)
        hi = bisect.bisect_right(self.t, epoch + half)
        return median(self.v[lo:hi]) if hi > lo else None


def main(session):
    out = os.path.join(session, "derived")
    os.makedirs(out, exist_ok=True)
    meta = {}
    if os.path.exists(os.path.join(session, "session.json")):
        meta = json.load(open(os.path.join(session, "session.json")))

    gps = read_csv(os.path.join(session, "gps.csv"))
    lux = read_csv(os.path.join(session, "lux.csv"))
    photos = read_csv(os.path.join(session, "photos.csv"))
    frames = read_csv(os.path.join(session, "frames.csv"))
    events = read_csv(os.path.join(session, "events.csv"))
    brackets = read_csv(os.path.join(session, "brackets.csv"))
    track = Track(gps)
    luxs = Series(lux, "lux")
    print(f"{len(gps)} GPS fixes, {len(lux)} lux samples, {len(photos)} photos, {len(frames)} video frames, {len(events)} events")

    # Photos → exact-time GPS
    pgeo = []
    for r in photos:
        e = num(r["epoch"])
        if e is None:
            continue
        p = track.at(e)
        pgeo.append({
            "index": r["index"], "file": r["file"], "epoch": e,
            "lat": p[1] if p else num(r["lat"]), "lon": p[2] if p else num(r["lon"]),
            "alt_m": p[3] if p else num(r["alt_m"]), "gps_acc_m": p[4] if p else num(r["h_acc"]),
            "heading_deg": num(r["heading_deg"]), "pitch_deg": num(r["pitch_deg"]), "roll_deg": num(r["roll_deg"]),
            "lux": luxs.median_around(e), "scene_ev100": num(r.get("scene_ev100")),
            "exposure_s": num(r["exposure_s"]), "iso": num(r["iso"]),
        })
    write_rows(os.path.join(out, "photos_geo.csv"), pgeo)

    # Light snapshots (short exposure, every ~5 s) → exact-time GPS
    bgeo = []
    for r in brackets:
        e = num(r["epoch"])
        if e is None:
            continue
        p = track.at(e)
        bgeo.append({"index": r["index"], "file": r["file"], "epoch": e,
                     "lat": p[1] if p else num(r["lat"]), "lon": p[2] if p else num(r["lon"]),
                     "heading_deg": num(r["heading_deg"]), "pitch_deg": num(r["pitch_deg"]),
                     "exposure_s": num(r["exposure_s"]), "iso": num(r["iso"]), "lux": luxs.median_around(e)})
    write_rows(os.path.join(out, "lights_geo.csv"), bgeo)

    if frames:
        fgeo = []
        for r in frames:
            e = num(r["epoch"])
            if e is None:
                continue
            p = track.at(e)
            fgeo.append({**{k: r[k] for k in ("segment", "frame", "pts_s")}, "epoch": e,
                         "lat": p[1] if p else None, "lon": p[2] if p else None, "alt_m": p[3] if p else None,
                         "gps_acc_m": p[4] if p else None, "lux": luxs.median_around(e),
                         "qw": r.get("qw"), "qx": r.get("qx"), "qy": r.get("qy"), "qz": r.get("qz"),
                         "fx_px": r.get("fx_px"), "fy_px": r.get("fy_px"), "cx_px": r.get("cx_px"), "cy_px": r.get("cy_px")})
        write_rows(os.path.join(out, "frames_geo.csv"), fgeo)

    # Lux at 1 Hz with position
    l1 = []
    if luxs.t:
        t0, t1 = math.floor(luxs.t[0]), math.ceil(luxs.t[-1])
        for s in range(int(t0), int(t1)):
            v = luxs.median_around(s + 0.5, 0.5)
            p = track.at(s + 0.5)
            if v is not None and p:
                l1.append({"epoch": s + 0.5, "lat": p[1], "lon": p[2], "gps_acc_m": p[4], "lux": v})
    write_rows(os.path.join(out, "lux_1hz.csv"), l1)

    # GeoJSON
    feats = []
    if track.p:
        feats.append({"type": "Feature", "properties": {"kind": "track"},
                      "geometry": {"type": "LineString", "coordinates": [[p[2], p[1]] for p in track.p]}})
    for r in l1:
        feats.append({"type": "Feature", "properties": {"kind": "lux", "lux": round(r["lux"], 3), "epoch": r["epoch"]},
                      "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]}})
    for r in events:
        if r.get("type") == "mark" and num(r["lat"]) is not None:
            feats.append({"type": "Feature", "properties": {"kind": "mark", "tag": r["detail"], "lux": num(r["lux"])},
                          "geometry": {"type": "Point", "coordinates": [num(r["lon"]), num(r["lat"])]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join(out, "track.geojson"), "w"))

    # Viewer
    data = {
        "meta": meta,
        "track": [[round(p[1], 7), round(p[2], 7)] for p in track.p],
        "lux": [[round(r["lat"], 7), round(r["lon"], 7), round(r["lux"], 3)] for r in l1],
        "photos": [[round(p["lat"], 7), round(p["lon"], 7), "../" + p["file"], round(p["lux"], 2) if p["lux"] is not None else None,
                    round(p["epoch"] - (meta.get("start_epoch") or 0), 1), p["heading_deg"]]
                   for p in pgeo if p["lat"] is not None],
        "marks": [[num(r["lat"]), num(r["lon"]), r["detail"]] for r in events if r.get("type") == "mark" and num(r["lat"]) is not None],
        "lights": [[round(b["lat"], 7), round(b["lon"], 7), "../" + b["file"], round(b["epoch"] - (meta.get("start_epoch") or 0), 1)]
                   for b in bgeo if b["lat"] is not None],
    }
    html = VIEWER.replace("__DATA__", json.dumps(data))
    open(os.path.join(out, "viewer.html"), "w").write(html)
    print("Wrote", out)


def write_rows(path, rows):
    if not rows:
        return
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


VIEWER = r"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>Light survey session</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{height:100%;margin:0;font-family:system-ui,sans-serif}
#p{position:absolute;right:10px;top:10px;z-index:999;background:#fff;border-radius:10px;box-shadow:0 2px 10px #0003;width:320px;max-height:90vh;overflow:auto;padding:10px;font-size:13px}
#p img{width:100%;border-radius:6px}#lg{position:absolute;left:10px;bottom:20px;z-index:999;background:#fff;padding:8px 10px;border-radius:8px;font-size:12px}
.bar{height:10px;width:200px;background:linear-gradient(90deg,#0b0b3b,#3b1f8f,#b8327a,#f07d3a,#fde725)}</style></head><body>
<div id="m"></div><div id="p"><b>Click a dot</b> to see the photo taken there.</div>
<div id="lg">Light level (lux, log scale)<div class="bar"></div><span id="lo"></span><span style="float:right" id="hi"></span></div>
<script>
const D=__DATA__;
const m=L.map('m');L.tileLayer('https://{s}.basemap.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:20,attribution:'© OpenStreetMap, © CARTO'}).addTo(m);
const C=['#0b0b3b','#3b1f8f','#b8327a','#f07d3a','#fde725'];
const vals=D.lux.map(x=>x[2]).filter(v=>v>0).sort((a,b)=>a-b);
const lo=Math.log10(vals[Math.floor(vals.length*0.02)]||0.1),hi=Math.log10(vals[Math.floor(vals.length*0.98)]||100);
document.getElementById('lo').textContent=Math.pow(10,lo).toFixed(1);document.getElementById('hi').textContent=Math.pow(10,hi).toFixed(0);
const col=v=>{if(!(v>0))return'#777';let f=(Math.log10(v)-lo)/(hi-lo);f=Math.max(0,Math.min(1,f));const i=Math.min(3,Math.floor(f*4));return C[i+(f*4-i>0.5?1:0)]};
if(D.track.length) {const t=L.polyline(D.track,{color:'#888',weight:2}).addTo(m);m.fitBounds(t.getBounds());}
D.lux.forEach(([a,b,v])=>L.circleMarker([a,b],{radius:4,stroke:false,fillColor:col(v),fillOpacity:.9}).addTo(m));
const P=document.getElementById('p');
D.photos.forEach(([a,b,f,v,t,h])=>L.circleMarker([a,b],{radius:3,color:'#fff',weight:1,fillOpacity:0}).on('click',()=>{
 P.innerHTML=`<img src="${f}"><div><b>${f.split('/').pop()}</b> · t=${t}s<br>${a.toFixed(6)}, ${b.toFixed(6)}${h!=null?' · heading '+Math.round(h)+'°':''}<br>Light: <b>${v!=null?v+' lx':'—'}</b></div>`;}).addTo(m));
D.marks.forEach(([a,b,tag])=>L.marker([a,b]).bindPopup(tag).addTo(m));
D.lights.forEach(([a,b,f,t])=>L.circleMarker([a,b],{radius:3,color:'#ffd54a',weight:1,fillOpacity:.6}).on('click',()=>{
 P.innerHTML=`<img src="${f}"><div><b>Light snapshot</b> · t=${t}s<br>Short exposure: lamps, signs and other sources show their real shape and colour.</div>`;}).addTo(m));
</script></body></html>"""

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
