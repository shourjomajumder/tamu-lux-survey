# Collection methodology

## Where and when

- **Place:** Texas A&M University main campus, College Station, TX. Survey extent: 30.6104 to 30.6174 N, -96.3462 to -96.3343 E, about 1.1 x 0.8 km.
- **When:** the night of Saturday 7 Nov 2026, from 6:43:26 pm to 8:58:54 pm CST (first to last kept reading). All recording was after dark.
- **Who:** 3 walkers (W1, W2, W3), team members, each carrying an iPhone.
- **Routes:** there were 4 pre-planned loops of about 8.7 km each (8,682 to 8,745 m: Corps Quad & Southside, Academic Core, Northside, Kyle Field & West Campus). They were designed over the OpenStreetMap walkway network to cover the main pedestrian paths. Walkers followed turn-by-turn directions in the app and recorded **on the route only**. Restarts produced extra short sessions, 13 sessions in total. W1 recorded about 2.25 h; W2 and W3 recorded until about 8:05 pm and 8:46 pm.
- **Live monitoring:** each phone sent a heartbeat about every 5 s to a team dashboard (position, lux, route coverage, battery). The dashboard showed coverage in 10 m route bins. A bin counted as covered after at least 3 lux readings (`Coverage.swift`). Heartbeats are a monitoring tool and are not part of the dataset.
- **Test runs removed:** three W1 recordings made at one spot between 5:20 and 5:48 pm, before the survey (`W1_2026-11-07_172047`, `_172920`, `_174431`), are excluded from every published file.

## Instrument: the LightSurvey iPhone app

Source: the `LightSurvey` Xcode project, see `SessionRecorder.swift`, `CaptureService.swift` and `SensorServices.swift`. It writes one folder per session:

| Stream | Rate | Content |
|---|---|---|
| `lux.csv` | every front-camera frame, about 15/s | lux, raw_lux, exposure time, ISO, f-number, brightness value, mean/linear luminance, clipped fraction, white balance (K, tint), GPS lat/lon/h_acc, pitch/roll/yaw |
| `photos.csv` + JPEGs | 1 back-camera photo per second | file, time, GPS (lat, lon, altitude, h/v accuracy, speed, course), compass heading, exposure, camera intrinsics, orientation quaternion, scene EV |
| `brackets.csv` + `lights/BRK_*.jpg` | every 5 s | short-exposure "light snapshot" (back camera, minimum ISO, very short shutter) in which only actual light sources are visible |
| `gps.csv` | each fix, about 1/s | position + route progress |
| `heading.csv` | compass updates | true/magnetic heading, accuracy |
| `motion.csv` | 10/s | CoreMotion attitude quaternion, acceleration |
| `altimeter.csv` | CMAltimeter updates | barometric relative altitude |
| `frames.csv` + video | continuous | back-camera HEVC video (10 min segments) with per-frame pose |
| `events.csv` | on tap | walker marks (light out, very dark), off-route, thermal |

**Lux measurement.** The front (selfie) camera faces up through a paper diffuser, acting as a cosine-ish light collector. The camera runs at 15 fps with continuous auto-exposure metered at the centre. Lux is computed from the exposure settings the camera chooses plus how bright the frame came out. The frame brightness term covers the case where auto-exposure maxes out in the dark:

`lux = calibration x K x N² / (t x ISO) x (linear_y / 0.18)`, with K = 250, N = f-number, t = exposure time.

`calibration` is a per-phone factor set on the app's calibration screen. It is either matched to a reference lux meter held next to the phone under a streetlight, or matched to Phone 1 under the same light so that all phones agree. The factor is stored in each session's `session.json`. Readings are taken at hand height, about 1.2 m.

## Processing pipeline

Processing ran on a Vultr Cloud GPU server (NVIDIA A16). The data was also loaded into MongoDB Atlas. Scripts are in `pipeline/`.

1. **Privacy blur (`detect_blur.py`).** Every photo is run through YOLOv8x (COCO, confidence >= 0.30) and a YOLOv8 face model. Faces are blurred (Gaussian). So is the head zone (top 24 %) of every detected person and the lower 45 % of every vehicle box (plate zone), so a missed face or plate detection is still covered. Only blurred copies are ever shown (website / review sheets). Detected objects get an estimated map position from the GPS, the bearing of the box centre and a range from apparent size.
2. **Lighting infrastructure (`detect_world.py`).** YOLO-World open-vocabulary detection with prompts such as "street lamp", "lamp post", "bollard light", "wall mounted light", "emergency call box", "tree" and "car headlight". Each detection is stored as a camera ray (bearing + elevation) from the phone pose.
3. **Scene and depth (`scene_depth_seg.py`).** SegFormer-B3 (Cityscapes) gives canopy overhead, sidewalk/road underfoot and sky share per photo. Depth Anything V2 (Metric Outdoor Base) gives metric distance to each detected object.
4. **Light emitters (`light_blobs.py`).** In each light snapshot, bright blobs are found (threshold = max(35, 0.5 x the 99.95th percentile of grey), area >= 6 px). Each blob becomes a ray with bearing, elevation, size, brightness and colour temperature.
5. **Reading cleaning (`fuse_map.py` step 1).** Raw lux frames are kept if lux > 0, GPS is present and `h_acc` <= 25 m (284,086 frames). Two filters are then applied:
   - **Vehicle filter:** drop frames within ±2 s of a photo where a car, truck, bus or motorcycle box covers more than 1 % of the image, or where YOLO-World saw a `vehicle_light` with confidence > 0.2. This removed 18,175 frames.
   - **Spike filter:** drop frames above max(2.5 x, +8 lux) the centred 20 s rolling median, but only when the spike lasts less than 6 s. This catches passing lights. It removed 8,146 more frames.
   - 257,765 frames remain. They are reduced to the per-second median (lux, lat, lon, h_acc, yaw), giving **17,715 rows in `readings_1hz.csv`**.
6. **Lamp triangulation (`fuse_map.py` step 2).** Snapshot rays with elevation between 0.3° and 75° and `h_acc` <= 20 m are paired with rays from the same session 1 to 90 s later, from positions at least 3 m apart. A pair is kept when the rays are not near-parallel, both ranges are 2 to 60 m, the two height estimates agree within 2.5 m, and the mean height is 2.5 to 15 m. Car lights (about 0.7 m and moving) do not triangulate. Intersections are clustered with DBSCAN (eps 3 m, min 4). Each lamp is checked against the readings (median lux within 8 m vs. the 15-30 m ring) and scored. Lamps with confidence >= 0.45 are kept: **721 lamps**. Fixtures detected in photos with no emitter within 7 m but at least 2 dark snapshots facing them become **255 "possibly out"** points.
7. **Path snapping (`fuse_map.py` step 4).** OpenStreetMap ways (footway, path, steps, service, residential, cycleway, …) are fetched via Overpass and cut into pieces about 5 m long. Each 1 Hz reading goes to the nearest piece within max(10 m, h_acc). Readings with no nearby piece go to 5 m grid cells. Per piece: median, 5th percentile, mean, evenness, level, canopy. This gives **3,622 stretches**. Dark pieces are chained per OSM way into **507 warnings, 121 of them high severity**.
8. **Trees (`canopy_trees.py`).** Crowns are placed along stretches with canopy >= 0.30 (1,646), plus 2 OSM trees.
9. **Light simulation (`light_sim.py`).** A 1 m ground grid within 35 m of readings, excluding buildings. The model is E = a + Σ I_k·H_k/(d²+H_k²)^1.5·V_k, where H_k = lamp height - 1.2 m. V_k = 0 if an OSM building blocks the line from lamp to ground and x0.55 per tree crown crossed. Intensities I_k and the ambient term a are fitted by bounded least squares to 5 m stretch medians, with a weak prior toward 400 cd. 20 % of stretches (849) were held out at random. The published map adds a smoothed residual correction near measurements.
   - Fitted ambient light is 0.87 lux. 154 of 721 lamps were fitted to 0 cd (they add no ground light).
   - Physics-only, on held-out stretches: median absolute error 1.99 lux, median factor error 2.02x, R² (log) -0.36, 49.4 % within 2x.
   - Published map, on held-out stretches: median absolute error 1.38 lux, factor error 1.58x, 66.2 % within 2x, 81.6 % same or adjacent level, 77.9 % agreement on above/below 5 lux.
   - 14.4 % of the simulated area is >= 5 lux and 68 % is >= 1 lux.
10. **Routes (`route_library.py`, `new_routes.py`).** The 4 original loops are kept. 8 new routes (2.7 to 4.2 km) are planned over the 55.8 km of OSM walkway not yet collected; 27.9 km was collected. A piece counts as collected if a reading lies within 15 m. These planned routes have not been walked.
11. **3-D views (`pointcloud.py`, splats).** About 5,000 blurred photos are back-projected with metric depth into a coloured point cloud (voxel 0.35 m), and Gaussian splats are made for 2 spots. These feed the website's "Light View". They are model reconstructions and are **not** part of this dataset.

## Survey results (from `summary.json`)

| Quantity | Value |
|---|---|
| Sessions (after removing tests) | 13 |
| Raw lux frames, vehicle-removed, spike-removed, kept | 284,086 / 18,175 / 8,146 / 257,765 |
| 1 Hz readings | 17,715 |
| Path stretches | 3,622 |
| Share of stretches Dark / Very dim / Dim / Adequate / Well lit / Bright | 17.1 / 30.6 / 17.3 / 16.4 / 15.4 / 3.3 % |
| Low-light warnings (high) | 507 (121) |
| Lamps / possibly out | 721 / 255 |
| Trees (from canopy) | 1,648 (1,646) |
| Activity points (people, bikes, vehicles) | 1,769 |
| Emergency phones found | 0 |

About 65 % of surveyed stretches had a median below the 5 lux walkway guideline.

## Storage and compute

- **MongoDB Atlas**, database `lux_survey` (`load_mongo.py`, `mongo_v2.py`). Collections: `walks`, `readings` (the filtered 1 Hz readings with `seg_id`), `readings_raw`, `photos`, `detections`, `segments` (3,622 stretches), `routes`, `bins` (10 m route bins with coverage), `walkers` and `positions` (live heartbeats). All positions are GeoJSON with 2dsphere indexes. Test runs were deleted.
- **Compute:** Vultr Cloud GPU, NVIDIA A16. Jobs are in `jobs/` and their logs in `results/logs/`. The files here are copies of the server outputs in `results/final/` and `results/{detections,world}/`.
