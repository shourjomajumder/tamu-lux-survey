# TAMU Night Lighting Survey: dataset

This is a new dataset of pedestrian-level night lighting on the Texas A&M University main campus (College Station, TX). It was collected on foot by 3 walkers on the night of **7 Nov 2026, about 6:43 to 8:58 pm CST**. Each walker carried an iPhone running our LightSurvey app, which logged light level (lux), GPS, compass, motion and a photo every second.

- How it was collected and processed: [`../docs/METHODOLOGY.md`](../docs/METHODOLOGY.md)
- Every column and property: [`../docs/DATA_DICTIONARY.md`](../docs/DATA_DICTIONARY.md)
- Limitations: [`../docs/LIMITATIONS.md`](../docs/LIMITATIONS.md)
- Data we did **not** collect (OpenStreetMap, model outputs): [`../docs/SUPPLEMENTARY_DATA.md`](../docs/SUPPLEMENTARY_DATA.md)

## What is and is not published

- **Published:** the cleaned 1 Hz light readings, the photo position index, and the derived map layers built from them. The layers are path-stretch lighting, lamps, possibly-out lamps, low-light warnings, trees, activity, the simulated light map and routes. Object-detection tables (positions and labels only) are also included.
- **Not published:** the raw per-walk phone recordings (about 15 Hz lux frames, video, raw sensor logs). These stay on the processing server. **Raw photos are not published.** `photos_index.csv` lists only photo time, position and heading. Its `file` column is an identifier, not a downloadable file. The photos shown on the project website are privacy-blurred copies (faces and number plates blurred).
- **Excluded everywhere:** the 3 pre-survey test runs (`W1_2026-11-07_172047`, `W1_2026-11-07_172920`, `W1_2026-11-07_174431`). These were repeated recordings at one spot, from 5:20 to 5:48 pm. None of them appear in any file here (checked).
- **Personal data:** the only identifiers are `walker` (1-3) and `session` (walker + start time). Walkers are team members. People and vehicles seen in photos appear only as anonymous class labels with an estimated map position. There are no images, crops, faces or plates.

## Files

| File | Rows / features | Size | Format | Origin | Licence |
|---|---|---|---|---|---|
| `measurements/readings_1hz.csv` | 17,715 rows | 1.9 MB | CSV | **Newly collected** (cleaned 1 Hz light readings) | CC BY 4.0 |
| `measurements/photos_index.csv` | 17,289 rows | 1.7 MB | CSV | **Newly collected** (photo time/position/heading; no images) | CC BY 4.0 |
| `derived/path_lighting.geojson` | 3,622 features | 1.1 MB | GeoJSON | Our readings aggregated onto OSM path stretches 5 m long | ODbL (contains OSM geometry) |
| `derived/warnings.geojson` | 507 features | 136 KB | GeoJSON | Derived from path_lighting | ODbL (OSM path names) |
| `derived/lamps.geojson` | 721 features | 280 KB | GeoJSON | Lamps triangulated from our photos + light-model fit | CC BY 4.0 |
| `derived/lamps_possibly_out.geojson` | 255 features | 52 KB | GeoJSON | Fixtures detected in our photos with no light seen | CC BY 4.0 |
| `derived/trees.geojson` | 1,648 features | 292 KB | GeoJSON | 1,646 placed from photo canopy + 2 from OSM | ODbL (mixed) |
| `derived/activity.geojson` | 1,769 features | 288 KB | GeoJSON | People/bikes/vehicles detected in our photos | CC BY 4.0 |
| `derived/light_map.png` | 1202 x 849 px | 360 KB | PNG (RGBA) | **Model output**: simulated ground light, 1 m grid | CC BY 4.0 |
| `derived/light_map.json` | - | 1 KB | JSON | Georeference, encoding and validation for the PNG | CC BY 4.0 |
| `derived/route_library.json` | 12 routes | 288 KB | JSON | 4 walked survey loops + 8 **planned** (not walked) routes on OSM paths | ODbL |
| `derived/summary.json` | - | 1 KB | JSON | Pipeline counts and validation metrics | CC BY 4.0 |
| `derived/detections/objects_coco.csv` | 9,334 rows | 1.5 MB | CSV | YOLOv8x COCO detections in our photos (labels + positions only) | CC BY 4.0 |
| `derived/detections/lighting_infrastructure.csv` | 25,725 rows | 4.5 MB | CSV | YOLO-World detections of lamps/trees/phones (labels + camera rays only) | CC BY 4.0 |
| `supplementary/buildings.geojson` | 180 features | 77 KB | GeoJSON | **OpenStreetMap** building footprints | © OpenStreetMap contributors, ODbL |
| `supplementary/landmarks.geojson` | 217 features | 37 KB | GeoJSON | **OpenStreetMap** named places | © OpenStreetMap contributors, ODbL |
| `supplementary/emergency_phones.geojson` | 0 features | 42 B | GeoJSON | OSM + photo detection (none found) | © OpenStreetMap contributors, ODbL |

Total is about 13 MB. All coordinates are WGS84 (EPSG:4326) longitude/latitude. Times are Unix epoch seconds (UTC); the local time zone is CST (UTC-6). Our own measurements are under CC BY 4.0. Any file that contains OpenStreetMap geometry or names is also covered by the ODbL ("© OpenStreetMap contributors").

## Quick start

```python
import pandas as pd, geopandas as gpd, json

# 1 Hz light readings (one row per walker-second)
r = pd.read_csv("data/measurements/readings_1hz.csv")
r["time_cst"] = pd.to_datetime(r.sec, unit="s", utc=True).dt.tz_convert("America/Chicago")
pts = gpd.GeoDataFrame(r, geometry=gpd.points_from_xy(r.lon, r.lat), crs="EPSG:4326")

# lighting per 5 m path stretch
paths = gpd.read_file("data/derived/path_lighting.geojson")
print(paths.groupby("level").size())

lamps = gpd.read_file("data/derived/lamps.geojson")
warnings = gpd.read_file("data/derived/warnings.geojson")
```

To decode the simulated light map (PNG grey level to lux):

```python
import numpy as np, json
from PIL import Image
meta = json.load(open("data/derived/light_map.json"))
img = np.asarray(Image.open("data/derived/light_map.png")).astype(float)
v, valid = img[..., 0] / 255, img[..., 3] > 0
lux = np.where(valid, 0.3 * np.exp(v * np.log(200)), np.nan)   # saturates at 60 lux
# row 0 = north edge (meta["bounds_latlon"]["north"]), column 0 = west edge, 1 m per pixel
```

Without geopandas, `json.load` works on every GeoJSON file. The fields are under `features[i]["properties"]`.
