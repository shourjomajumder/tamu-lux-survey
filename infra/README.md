# Processing and serving stack

How the raw phone walks became the published dataset and the live API. The code lives in the folders the
GPU server pulls from, so it stays where it is: [`../server/`](../server), [`../pipeline/`](../pipeline),
[`../jobs/`](../jobs). Results land in [`../results/`](../results). No credentials are in this repo: the
MongoDB connection string and GitHub token live only in `/root/lux/.env` on the server and in Netlify
environment variables.

```
iPhone app ──upload──▶ Netlify Blobs ──▶ Vultr GPU server (job runner + pipeline) ──▶ results/final/*
     ▲                  (/api/upload)                         │                          │
     │                                                        ▼                          ▼
     └── route assignments ◀── Netlify functions ◀──── MongoDB Atlas (lux_survey) ◀── mongo_v2.py
                               (/api/*)                                                  website (app/web)
```

## 1. Vultr Cloud GPU (NVIDIA A16, Chicago)

| File | What it does |
|---|---|
| [`server/setup.sh`](../server/setup.sh) | One-time setup: system packages, Python venv, `/data/{zips,sessions,blurred}`, asks for the GitHub token and MongoDB URI (or reads them from Vultr User-Data) and stores them in `/root/lux/.env`. |
| [`server/agent.sh`](../server/agent.sh) | Job runner. Every 30 s: `git pull --rebase`; run each new `jobs/NNN_*.sh` once, in order (6 h timeout); write `results/logs/<job>.log` and `results/done.txt`; commit and push `results/` back; push a `heartbeat` commit (GPU, disk) about every 5 min. |
| [`server/monitor.py`](../server/monitor.py) + `monitor_page.html` | Read-only live monitor on port 8080 (job queue, logs, GPU/CPU/disk, newest blurred photos, MongoDB counts). Access key is checked against a SHA-256 hash; the key itself (`<MONITOR_KEY>`) is not in the repo. |

`jobs/` is the full, ordered history of what was run (download, unzip, blur, detect, fuse, load, routes).
Jobs are append-only: a job runs once and is recorded in `results/done.txt`.

## 2. Pipeline ([`pipeline/`](../pipeline), Python 3.10, [`requirements.txt`](../pipeline/requirements.txt))

GPU steps also need `torch`, `transformers>=4.51`, `accelerate`, `scikit-learn`, `requests` and Ultralytics' CLIP
(installed by the jobs that use them, e.g. `jobs/005b_detect_world.sh`, `jobs/008_scene_depth_seg.sh`).

| Step | Script | Models / method | Output |
|---|---|---|---|
| Privacy blur | `detect_blur.py` | YOLOv8x (COCO: people, vehicles) + YOLOv8 face model; blurs faces, the head area of every person and the plate zone of every vehicle | blurred photo copies (server only), `results/detections/` |
| Lighting objects | `detect_world.py` | YOLO-World v2 open-vocabulary (street lamps, lamp posts, wall lights, emergency call boxes, trees) + camera ray per box | `results/world/` |
| Scene + depth | `scene_depth_seg.py` | SegFormer-B3 (Cityscapes) segmentation + Depth Anything V2 metric (outdoor) | `results/scene/` |
| Light sources | `light_blobs.py` | Bright blobs in short-exposure snapshots → bearing, elevation, size, colour temperature | `results/blobs/` |
| Fusion | `fuse_map.py` (+ `geo.py`, `canopy_trees.py`) | Filter vehicle-light moments and spikes, 1 Hz readings; triangulate lamps (2.5–15 m high) and flag "possibly out"; snap readings onto OpenStreetMap footpaths (Overpass API), per-stretch median/min lux, light level, warnings | `results/final/*.geojson`, `readings_1hz.csv`, `summary.json` |
| Light simulation | `light_sim.py` | Inverse-square lamp model with building/tree occlusion, fitted to 80 % of readings, validated on 20 % held out | `light_map.png/json` (model output, not measurement) |
| Street View / 3D | `streetview.py`, `pointcloud.py`, `splat_pick.py`, `ply_to_splat.py`, `ckpt_to_splat.py` | Blurred photos only; Depth Anything V2 depth → parallax frames and a fused point cloud; two Gaussian-splat scans (COLMAP + gsplat, jobs 013–023) | Street View frames and point cloud are hosted on the live site (not in git); splats in `results/splats/` |
| Routes | `route_library.py`, `new_routes.py`, `routekit.py` | Generated survey/recheck routes with turn-by-turn steps for the app | `route_library.json` |
| Database | `load_mongo.py` (v1), `mongo_v2.py` (current) | Loads the dataset into MongoDB Atlas; never prints the connection string | collections below |
| (not run) | `vlm_describe.py` | Qwen2.5-VL photo notes; no job runs it, not part of the published data | – |

## 3. MongoDB Atlas (database `lux_survey`)

Built by [`pipeline/mongo_v2.py`](../pipeline/mongo_v2.py); all positions are GeoJSON with `2dsphere` indexes.

| Collection | Contents |
|---|---|
| `walks` | one per phone session (walker, start, duration, counts) |
| `readings` | filtered 1 Hz readings `{session, walker, t, lux, loc, h_acc, heading, seg_id}` (raw per-second copy kept as `readings_raw`) |
| `photos` | one per photo (position, heading, lux, blurred file name) |
| `detections` | one per detected object (class, confidence, estimated position) |
| `segments` | 3,622 path stretches `{seg_id, name, path_type, osm_way, geom, mid, length_m}` |
| `routes` | route library `{route_id, name, color, kind, geom, length_m}` |
| `bins` | every route cut into 10 m bins, with `covered/by/at` |
| `walkers`, `positions` | Survey Control walkers/assignments and live heartbeats |

## 4. Netlify API ([`app/dashboard/`](../app/dashboard))

Netlify Functions (Node, `mongodb` driver + `@netlify/blobs`). Shared helpers in `netlify/lib/db.mjs`.
`MONGODB_URI` comes only from the environment.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/stats` | – | live map numbers: median lux per stretch, level shares, darkest stretches (aggregated in MongoDB) |
| `GET /api/near?lat=&lon=&r=` | – | path stretches within r m (`$geoNear` on `segments`), darkest first |
| `POST /api/route-score` | – | how well lit a drawn route is: 10 m pieces → `$geoNear` into `readings` → median/min lux |
| `/api/control` | control code | Survey Control: add/remove walkers, assign routes, heartbeats, coverage marking |
| `GET /api/coverage` | control code | covered vs uncovered metres per route from `bins` |
| `GET /api/suggest` | control code | next routes to send walkers on (most uncovered first) |
| `/api/files` | live key or control code | list / fetch files uploaded by the phones |
| `POST /api/upload` | live key | one file or CSV piece from a phone (Netlify Blobs) |
| `GET /api/status` | – | latest state (and trails) of all walkers for the live dashboard |
| `/api/assigned`, `/api/ingest`, `/api/reset` | live key | phone route lookup, phone heartbeat, clear a walker's live card |

Demo defaults: the Survey Control code is `4586` (`CONTROL_PASS`) and the phone upload key is
`tamu-lux-2026` (`LIVE_KEY`). They gate a demo, not data; set your own values in Netlify env vars for any
real deployment.
