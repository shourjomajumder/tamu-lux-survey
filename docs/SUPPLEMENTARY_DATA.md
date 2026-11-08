# Supplementary and model-generated data (not newly collected)

As the datathon asks, this file labels everything in or behind the dataset that our team did **not** measure on the night of 7 Nov 2026.

## Newly collected (ours)

- `data/measurements/readings_1hz.csv`: cleaned 1 Hz light readings from our phones.
- `data/measurements/photos_index.csv`: time, position and heading of our photos (the images are not published).
- These layers are derived directly from the above: `path_lighting.geojson` (lux statistics), `warnings.geojson`, `lamps.geojson` (positions from our snapshots), `lamps_possibly_out.geojson`, `activity.geojson`, and `derived/detections/*.csv` (model detections run on our photos).

## Public data: OpenStreetMap

© OpenStreetMap contributors, available under the Open Database License (ODbL 1.0), https://www.openstreetmap.org/copyright. Fetched through the Overpass API on 7-8 Nov 2026.

| Where used | What came from OSM |
|---|---|
| `data/supplementary/buildings.geojson` | Building footprints, names, height/levels (10 m default when missing) |
| `data/supplementary/landmarks.geojson` | Named places (fields, plazas, buildings, landmarks) |
| `data/supplementary/emergency_phones.geojson` | `emergency=phone` nodes (none exist in the area; file is empty) |
| `data/derived/path_lighting.geojson`, `warnings.geojson` | Path **geometry**, `osm_way`, `path_type`, `name`. The lux values are ours |
| `data/derived/trees.geojson` | 2 of 1,648 trees (`source = "OpenStreetMap"`) |
| `data/derived/route_library.json` | Routes are drawn along OSM ways; names are from OSM landmarks |
| `summary.json` → `osm_street_lamps` | Count of OSM street-lamp nodes (17), used only for a cross-check |

## Model-generated layers (computed, not measured)

| Layer | How it is made |
|---|---|
| `data/derived/light_map.png` / `.json` | **Simulated** ground light from a fitted lamp model (`light_sim.py`); held-out median error 1.38 lux |
| `lamps.geojson`: `intensity_cd`, `fitted`, `lit_area_m2`, `reach_m`, `shadowed_pct` | Outputs of the same model fit |
| `data/derived/trees.geojson` (1,646 of 1,648, `source = "canopy from photos"`) | Crown positions placed by rule from the canopy share in photos; not individually observed trees |
| `data/derived/route_library.json`, ids 201-208 | Algorithmically planned routes, **not walked** |
| `activity.geojson`, `derived/detections/*.csv` positions | Model estimates (YOLOv8x, YOLO-World, Depth Anything V2) from our photos |
| 3-D point cloud and Gaussian splats ("Light View" on the website) | Reconstructed from blurred photos with monocular depth; **not included** in `data/` |

## Synthetic data

**None of the files in `data/` contain synthetic data.** The website and iPhone app have an optional recording/replay/simulation mode, used for demos. It can replay last night's real walk or generate simulated lux and positions. That mode is not part of the final dataset build, and none of its output is in `data/`.
