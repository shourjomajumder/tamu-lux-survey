# Data dictionary

This covers every file in [`data/`](../data). Ranges, medians and null counts were computed with pandas on the published files (8 Nov 2026).

Conventions used in every file:
- Coordinates are WGS84 decimal degrees. In GeoJSON the order is `[lon, lat]`.
- Times are Unix epoch seconds, UTC. The survey ran from 1794098606 to 1794106734, which is 7 Nov 2026, 18:43:26 to 20:58:54 CST.
- `session` is `W<walker>_<YYYY-MM-DD>_<HHMMSS>`, the phone's recording start in local time. One walker can have several sessions when the app was restarted.
- `walker` is 1, 2 or 3 (team members). These are the only identifiers in the dataset.
- Local metres (`x`, `y`) use an equirectangular projection centred at 30.6150 N, -96.3400 E: x = east, y = north, with 1° lat = 111,320 m (`pipeline/geo.py`).
- Lux is the phone-camera estimate after per-phone calibration (see METHODOLOGY). It is relative and approximate, not survey-grade.
- Light levels (`level`) are set from median lux: Dark < 1, Very dim 1-3, Dim 3-5, Adequate 5-10, Well lit 10-30, Bright >= 30. The 5 lux threshold is a common walkway guideline.

---

## measurements/readings_1hz.csv: newly collected

There are 17,715 rows, one per walker-second, from 13 sessions (W1: 7,628, W2: 4,356, W3: 5,731). The phone logged about 15 front-camera lux frames per second, 284,086 raw frames in total. Before resampling, frames were dropped if lux <= 0, there was no GPS, GPS accuracy was worse than 25 m, a vehicle was in view, or a short spike passed (see METHODOLOGY). The remaining frames were reduced to the per-second median. Produced by `pipeline/fuse_map.py`, step 1.

| Column | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `sec` | int | epoch s (UTC) | Second of the reading | 1794098606 to 1794106734 (0) |
| `lux` | float | lux | Median calibrated illuminance at hand height (~1.2 m) for that second | 0.03 to 184.77, median 2.98 (0) |
| `lat` | float | deg | Median GPS latitude for the second | 30.61035 to 30.61744 (0) |
| `lon` | float | deg | Median GPS longitude | -96.34623 to -96.33434 (0) |
| `h_acc` | float | m | Median iOS horizontal accuracy (1-sigma radius) | 2.0 to 20.6, median 2.8 (0) |
| `yaw` | float | deg | Median CoreMotion yaw of the phone (device frame, -180 to 180; not true heading) | -179.8 to 178.4 (0) |
| `session` | str | - | Session id | 13 values (0) |
| `walker` | int | - | Walker number | 1 to 3 (0) |
| `x` | float | m | Local east coordinate | -597.3 to 542.7 (0) |
| `y` | float | m | Local north coordinate | -517.3 to 271.2 (0) |

## measurements/photos_index.csv: newly collected (positions only)

There are 17,289 rows, one per back-camera photo, taken about every 1 s, across 13 sessions. Copied from each session's `photos.csv` by `fuse_map.py`. **The photos themselves are not published.** `file` is only an identifier.

| Column | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `session` | str | - | Session id | 13 values (0) |
| `walker` | int | - | Walker number | 1 to 3 (0) |
| `index` | int | - | Photo number within the session | 1 to 7430 (0) |
| `file` | str | - | Original file name inside the session (not distributed) | `photos/IMG_000001.jpg`... (0) |
| `epoch` | float | epoch s | Capture time | 1794098606.094 to 1794106733.714 (0) |
| `lat` | float | deg | GPS latitude at capture | 30.61035 to 30.61744 (0) |
| `lon` | float | deg | GPS longitude at capture | -96.34623 to -96.33432 (0) |
| `heading_deg` | float | deg | Compass true heading of the camera (0 = north, clockwise) | 0.1 to 360.0 (0) |
| `linear_y` | float | 0-1 | Mean linear luminance of the auto-exposed photo (a brightness proxy, not lux) | 0.0 to 0.621, median 0.05 (0) |

---

## derived/path_lighting.geojson

There are 3,622 features: 3,587 LineStrings (OSM path pieces about 5 m long) and 35 Points (5 m grid cells for readings with no OSM path nearby, `path_type = "off-network"`). Each 1 Hz reading was snapped to the nearest 5 m piece of an OpenStreetMap way. A reading was kept on a piece only if its perpendicular distance was <= max(10 m, `h_acc`). Statistics are then computed per piece (`fuse_map.py`, step 4).

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `readings` | int | count | 1 Hz readings on this stretch | 1 to 104, median 4 (0) |
| `walkers` | list[int] | - | Walkers who covered it | 3,430 by one walker, 191 by two, 1 by three |
| `lux_median` | float | lux | Median lux | 0.05 to 116.53, median 3.15 (0) |
| `lux_min` | float | lux | 5th percentile lux (robust minimum) | 0.04 to 105.55 (0) |
| `lux_avg` | float | lux | Mean lux | 0.05 to 116.53 (0) |
| `evenness` | float | ratio | `lux_avg / max(lux_min, 0.1)`. 1 = uniform; higher = patchy | 0.5 to 35.6, median 1.3 (0) |
| `level` | str | - | Word level from `lux_median` | Dark 619, Very dim 1,110, Dim 625, Adequate 593, Well lit 556, Bright 119 (0) |
| `canopy` | float | 0-1 | Mean share of tree canopy in the upper part of the photos (SegFormer) | 0.0 to 1.0, median 0.33 (20) |
| `osm_way` | int | - | OpenStreetMap way id | (35 null = off-network) |
| `path_type` | str | - | OSM `highway` tag | footway, service, unclassified, steps, cycleway, primary, off-network (0) |
| `name` | str | - | OSM street/path name | 17 names (3,283 null) |
| `nearest_emergency_phone_m` | int | m | Not present: no emergency phones were found (see supplementary) | - |

## derived/warnings.geojson

There are 507 Point features (centroid of the stretch). Dark stretches are path pieces with `lux_median` < 3, or `lux_avg` < 5 with at least 3 readings. Dark pieces on the same OSM way were chained by single-linkage clustering, with a gap of 0.00012° (about 12 m).

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `severity` | str | - | `high` if (median < 1 lux and length >= 15 m) or length >= 40 m; `medium` if median < 3 or length >= 15 m; else `low` | high 121, medium 301, low 85 (0) |
| `length_m` | float | m | Number of pieces x 5 m | 5 to 235, median 10 (0) |
| `lux_median` | float | lux | Median of the pieces' medians | 0.06 to 5.3 (0) |
| `level` | str | - | Word level | Dark, Very dim, Dim, Adequate (0) |
| `path` | str | - | OSM name or path type | 19 values (0) |
| `text` | str | - | Plain-language description | (0) |

## derived/lamps.geojson

There are 721 Point features. These are light emitters triangulated from short-exposure "light snapshots" (`fuse_map.py` step 2), with intensity added by the light model (`light_sim.py`).

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `id` | str | - | Lamp id, ordered by confidence | L0001 to L0721 (0) |
| `height_m` | float | m | Estimated height above ground (camera assumed at 1.4 m) | 2.5 to 12.6, median 3.1 (0) |
| `rays` | int | count | Distinct snapshot rays in the cluster | 2 to 146, median 5 (0) |
| `pairs` | int | count | Ray-pair intersections in the cluster | 3 to 11,458 (0) |
| `spread_m` | float | m | Median horizontal scatter of intersections | 0.0 to 53.5, median 1.5 (0) |
| `cct_k` | float | K | Median colour temperature of the emitter blobs | 4,602 to 10,000 (538) |
| `brightness` | float | 0-255 | Median blob pixel brightness in the snapshot | 44.0 to 182.7 (538) |
| `sessions` | list[str] | - | Sessions whose snapshots contributed. Filled only for the 183 lamps whose ray rows could be matched; empty otherwise | - |
| `lux_near` | float | lux | Median 1 Hz lux within 8 m | 0.1 to 85.4 (156) |
| `lux_ring` | float | lux | Median lux 15-30 m away | 0.1 to 61.9 (1) |
| `peak_ratio` | float | ratio | `lux_near / max(0.5, lux_ring)`. > 1 means brighter near the lamp | 0.04 to 40.8, median 1.18 (156) |
| `confidence` | float | 0-1 | 0.5·min(1, rays/8) + 0.3 (spread < 2 m) or 0.15 (< 3 m) + 0.2 (peak_ratio >= 1.3) or 0.1 (>= 1.0). Only >= 0.45 kept | 0.45 to 1.0, median 0.61 (0) |
| `light_type` | str | - | From `cct_k` (4,000 K assumed if missing): < 2,600 sodium/amber, < 3,600 warm, < 5,000 neutral, else cool white LED | neutral white LED, cool white LED (0) |
| `intensity_cd` | int | cd | Fitted luminous intensity (light model) | 0 to 8,047, median 167; **154 lamps = 0** (0) |
| `fitted` | bool | - | Lamp had measurements within reach in the training data | true 687, false 34 (0) |
| `lit_area_m2` | int | m² | Ground area where this lamp alone gives >= 1 lux | 0 to 2,490, median 49 (0) |
| `reach_m` | float | m | 90th percentile distance of that >= 1 lux area | 0.0 to 30.6 (0) |
| `shadowed_pct` | float | % | Share of cells within 20 m where buildings/trees cut the light by more than half | 0 to 100, median 63.8 (0) |

## derived/lamps_possibly_out.geojson

There are 255 Point features. They are lamp fixtures (streetlight, wall or bollard) detected by YOLO-World with confidence >= 0.30, clustered with DBSCAN (eps 4 m, min 4), seen in >= 4 sightings, with **no** triangulated emitter within 7 m, and with at least 2 dark snapshots taken within 25 m facing the fixture (within ±20°). Depth from Depth Anything V2 places each sighting on the map.

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `kind` | str | - | Most common detected class | streetlight, bollard_light (0) |
| `sightings` | int | count | Detections in the cluster | 4 to 308, median 8 (0) |
| `dark_snapshots_facing` | int | count | Light snapshots that faced it and saw no emitter | 2 to 12 (0) |
| `status` | str | - | Always `possibly out` | (0) |
| `conf` | float | 0-1 | Median detector confidence | 0.32 to 0.79 (0) |

## derived/trees.geojson

There are 1,648 Point features (tree crowns used as light blockers in the model). `canopy_trees.py` placed 1,646 of them: for each path stretch with `canopy` >= 0.30, it puts crowns on both sides of the path, 4 + 3·canopy m from it, at least 9 m apart. Two come from OpenStreetMap `natural=tree` nodes within 25 m of the survey. No trees were confirmed directly from detections.

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `source` | str | - | `canopy from photos` (1,646) or `OpenStreetMap` (2) | (0) |
| `crown_radius_m` | float | m | Modelled crown radius | 3.7 to 6.5 (0) |
| `height_m` | float | m | Modelled height | 8.4 to 14.0 (0) |
| `canopy` | float | 0-1 | Canopy share of the stretch it was placed from | 0.30 to 1.0 (2 = OSM trees) |

## derived/activity.geojson

There are 1,769 Point features. They are people, bicycles and vehicles detected by YOLOv8x (COCO) with confidence >= 0.5, at most one per class per session per 3 s. The position is the photo GPS plus a range estimated from apparent size (assumed object heights, e.g. person 1.7 m, car 1.5 m) along the bearing of the box centre. **Anonymous: no images or identity.**

| Property | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `kind` | str | - | `person` 1,013, `vehicle` 678 (car/truck/bus/motorcycle), `bicycle` 78 | (0) |
| `t` | int | epoch s | Time seen | 1794098606 to 1794106731 (0) |
| `session` | str | - | Session id | 11 values (0) |

## derived/light_map.png + light_map.json: model output

The PNG is RGBA, 1202 x 849 px, 1 m per pixel. Row 0 is the north edge and column 0 is the west edge. R = G = B = `clip(ln(lux/0.3)/ln(200), 0, 1) x 255`, a log scale from 0.3 to 60 lux. A = 255 inside the simulated area (within 35 m of a reading and not inside a building); 0 elsewhere. Produced by `pipeline/light_sim.py`. **This layer is a simulation, not a measurement.**

`light_map.json` fields:

| Field | Meaning | Value |
|---|---|---|
| `bounds_local_m` | Grid edges in local metres (x0, x1, y0, y1) | x -633.5 to 568.5, y -545.5 to 303.5 |
| `bounds_latlon` | north, south, west, east (deg) | 30.617726, 30.610095, -96.346613, -96.334056 |
| `width`, `height` | Pixels | 1202, 849 |
| `resolution_m` | Metres per pixel | 1.0 |
| `encoding` | Pixel formula | see above |
| `model` | Equation | E = ambient + Σ I_k·H/(d²+H²)^1.5·visibility |
| `ambient_lux` | Fitted ambient term | 0.87 |
| `validation_physics_only` | Held-out accuracy of the pure physics model | 849 stretches; median abs error 1.99 lux; median factor error 2.02; R² (log) -0.36; 49.4 % within 2x |
| `validation_map` | Held-out accuracy of the published map (physics + residual correction) | 849 stretches; median abs error 1.38 lux; factor error 1.58; 66.2 % within 2x; 81.6 % same or adjacent level; 77.9 % agree on above/below 5 lux |
| `lit_share_ge_5lux` / `lit_share_ge_1lux` | Share of simulated area at >= 5 lux / >= 1 lux | 0.144 / 0.68 |

## derived/route_library.json

This is a JSON array of 12 routes in the iPhone app's `SurveyRoute` format (`route_library.py`, `new_routes.py`). Ids 1-4 are the original survey loops, about 8.7 km each (8,682 to 8,745 m), which were walked. Ids 201-208 are **planned** routes over paths not yet collected, 2,708 to 4,205 m each. They were generated by algorithm and **have not been walked**.

| Field | Type | Meaning |
|---|---|---|
| `id` | int | Route id |
| `name` | str | Route name (from nearby OSM landmarks) |
| `covers` | str | Places the route passes |
| `color` | str | Display colour (hex) |
| `total` | float | Length, m |
| `new` | float | Length counted as new path by the route builder, m |
| `pts` | list[[lat, lon]] | Polyline (**note: lat first**) |
| `cum` | list[float] | Cumulative distance at each point, m |
| `steps` | list[obj] | Turn-by-turn: `i` step no., `txt` instruction, `hint`, `icon`, `at` start distance (m), `L` length (m), `rep` repeated segment |
| `kind` | str | `original` or `new` |
| `why` | str | Reason the route exists |
| `start`, `end`, `new_pct`, `targets` | str/str/float/int | New routes only: start and end landmark, % new path, number of target path pieces |

## derived/summary.json

These are pipeline counts. `sessions` 13. `readings_filter`: raw 284,086, vehicle 18,175, spike 8,146, kept 257,765. `readings_1hz` 17,715. `lamps` 721. `lamps_possibly_out` 255. `trees` 1,648 (`trees_from_canopy` 1,646). `emergency_phones` 0. `path_segments` 3,622. `warnings` 507 (`warnings_high` 121). `activity_points` 1,769. `osm_street_lamps` 17. `lamp_accuracy_vs_osm` null: no OSM-mapped lamps lay within 20 m of the survey readings, so the comparison could not be computed. `level_share` is the share of path features per level. `light_sim` repeats the light_map.json validation.

## derived/detections/objects_coco.csv

There are 9,334 rows, one per object detected by YOLOv8x (COCO, confidence >= 0.30) in a walk photo, from 12 sessions with test runs excluded (`detect_blur.py`). **Labels and positions only. No image crops are published.**

| Column | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `session`, `photo_index`, `file` | str/int/str | - | Photo the object was seen in (joins to photos_index) | (0) |
| `epoch` | float | epoch s | Photo time | (0) |
| `class` | str | - | COCO class: person 4,541; car 2,140; bench 1,192; fire hydrant 344; stop sign 298; bicycle 263; traffic light 198; truck 102; motorcycle 92; potted plant 64; umbrella 35; parking meter 23; bus 18; dog 17; backpack 7 | (0) |
| `conf` | float | 0-1 | Detector confidence | 0.301 to 0.972 (0) |
| `x0`,`y0`,`x1`,`y1` | int | px | Bounding box in the 1080 x 1920 portrait photo | 0 to 1080 / 0 to 1920 (0) |
| `photo_lat`, `photo_lon` | float | deg | Camera position | (0) |
| `heading_deg` | float | deg | Camera heading | 0.1 to 358.9 (0) |
| `bearing_deg` | float | deg | Bearing to box centre (heading + horizontal pixel angle) | 0.1 to 359.9 (0) |
| `est_dist_m` | float | m | Range from apparent height (focal_px x assumed height / box height) | 0.6 to 230.8, median 18.2 (129, classes with no assumed height) |
| `est_lat`, `est_lon` | float | deg | Estimated object position | (129) |

## derived/detections/lighting_infrastructure.csv

There are 25,725 rows of open-vocabulary YOLO-World detections (`detect_world.py`), from 11 sessions with test runs excluded. Used to find lamp fixtures and trees. Labels and camera rays only.

| Column | Type | Unit | Meaning | Range (nulls) |
|---|---|---|---|---|
| `session`, `file`, `photo_index`, `epoch` | - | - | Photo reference and time | (0) |
| `class` | str | - | Canonical class: streetlight, wall_light, bollard_light, emergency_phone, tree | (0) |
| `prompt` | str | - | Text prompt that matched (e.g. "street lamp", "lamp post") | 10 values (0) |
| `conf` | float | 0-1 | Confidence | 0.12 to 0.873, median 0.324 (0) |
| `x0`,`y0`,`x1`,`y1` | int | px | Bounding box | (0) |
| `img_w`, `img_h` | int | px | Image size (always 1080 x 1920) | (0) |
| `photo_lat`, `photo_lon` | float | deg | Camera position | (0) |
| `h_acc` | float | m | GPS accuracy | 2.0 to 18.8 (0) |
| `heading_deg` | float | deg | Camera heading | (0) |
| `pitch_deg` | float | deg | Phone pitch (90 = upright) | -2.9 to 89.9, median 83.3 (0) |
| `bearing_deg` | float | deg | Ray bearing to box centre | (0) |
| `elev_off_deg` | float | deg | Ray elevation above the camera axis | -34.4 to 37.3 (0) |
| `photo_lux_y` | float | 0-1 | Photo mean linear luminance | 0.0 to 0.554 (0) |

---

## supplementary/: OpenStreetMap, not collected by us

© OpenStreetMap contributors, ODbL 1.0. See [SUPPLEMENTARY_DATA.md](SUPPLEMENTARY_DATA.md).

**buildings.geojson** has 180 Polygons from the Overpass query `way["building"]` in the survey bbox (`fuse_map.py`). `name` is the OSM name (34 null). `height_m` is the OSM `height`, or `building:levels` x 3.5 m, or 10 m by default (3.5 to 52.5, median 10). It is used as a light blocker.

**landmarks.geojson** has 217 Points (`jobs/020_landmarks.sh`). These are named OSM leisure, building, amenity, landuse, place, historic, tourism and pedestrian-plaza features, at their centre point. `name` is unique per kind. `kind` is landmark, plaza, field or building. `osm` is the OSM element id (e.g. `node/368159934`). Used for map labels and route names.

**emergency_phones.geojson** is an empty FeatureCollection. No `emergency=phone` nodes exist in OSM for the area, and detection of blue-light phones in photos found no confirmed clusters (DBSCAN eps 6 m, min 2, confidence >= 0.25). The schema would be `source` ("OpenStreetMap" or "detected in photos") and `sightings`.
