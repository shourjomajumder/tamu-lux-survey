# lx — Night-light survey of Texas A&M

Campus lighting maps usually show where lamps are supposed to be, not how bright it actually is where people
walk. We measured it. Three of us walked Texas A&M's main campus at night with an iPhone app we built, logging
light level, position and a photo every second, then turned 13 walks into an open dataset: a lux value for
every 5 m stretch of footpath, 721 triangulated street lamps (255 that look out), low-light warnings, and a
light map you can use to plan the best-lit walk home.

TAMU Datathon 2026, Build-A-Dataset challenge.

- Live site: https://tamu-lux-map.netlify.app
- Survey Control (live walker dispatch): https://tamu-lux-map.netlify.app/#control (demo code `4586`, or leave the box empty)
- Demo video: VIDEO_LINK

## What we collected

| | |
|---|---|
| When / where | Night of Nov 7, 2026 (about 6:40–9:00 pm CST), Texas A&M main campus, College Station |
| Who | 3 walkers, each with an iPhone running our LightSurvey app ([`app/ios/`](app/ios)) |
| Light | Front camera pointed up through a paper diffuser, converted to lux, ~15 Hz |
| Photos | Back camera, one photo per second (with GPS and exposure) |
| Sensors | GPS, compass heading, motion/attitude |
| Walks | 13 survey walks (3 earlier test runs excluded) |

Numbers from [`results/final/summary.json`](results/final/summary.json):

- 284,086 raw lux readings → 257,765 kept after removing vehicle-headlight moments (18,175) and passing-light spikes (8,146) → 17,715 one-per-second readings
- 3,622 footpath stretches with measured lighting; 65 % of measured stretches are below 5 lux (Dark 17 %, Very dim 31 %, Dim 17 %)
- 721 street lamps located, 255 flagged as possibly out; 1,648 trees; 507 low-light warnings (121 high)
- Light simulation checked on 20 % held-out readings: 66 % within a factor of 2, median error 1.4 lux

## Dataset

The shareable dataset is in [`data/`](data) (see [`data/README.md`](data/README.md)).

| Part | Where | What |
|---|---|---|
| Measurements (new) | [`data/measurements/`](data/measurements) | Cleaned 1 Hz lux readings with position and heading; photo index (time, position, heading, no images) |
| Derived layers | [`data/derived/`](data/derived) | Path-stretch lighting, lamps, possibly-out lamps, warnings, trees, activity, simulated light map, route library |
| Supplementary | [`data/supplementary/`](data/supplementary) | Public data we did not collect (see below) |
| Data dictionary | [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md) | Every column and property |
| Methodology | [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) | How it was collected and processed |
| Limitations | [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | What the data can and cannot tell you |

### Supplementary data (not collected by us)

- **OpenStreetMap** footpaths, buildings, landmarks and emergency phones: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Path geometry in `path_lighting.geojson` comes from OSM; the lux values on it are ours.
- **Simulated light layer** (`light_map.png/json`, lamp `intensity_cd`/`reach_m`): model output fitted to our readings, **not a measurement**.
- **Point cloud / Light View and Street View** on the website: derived from our privacy-blurred photos with a depth model (not raw images).
- **Route library** (`route_library.json`): generated survey and best-lit routes, not walked tracks.

## Repo map

| Folder | Purpose |
|---|---|
| [`app/ios/`](app/ios) | LightSurvey iPhone app (SwiftUI): survey mode (lux, photos, GPS, coverage, uploads) and Explore (best-lit route navigation) |
| [`app/web/`](app/web) | The website: map, light layers, route scoring, replay, Street View, 3D scan, Survey Control (static, no build step) |
| [`app/dashboard/`](app/dashboard) | Netlify Functions: MongoDB-backed API, Survey Control backend, phone uploads, live dashboard |
| [`infra/`](infra) | How processing and serving work: Vultr GPU server, pipeline, MongoDB Atlas, API endpoints |
| [`pipeline/`](pipeline) | Python processing: blurring, detection, depth/segmentation, lamp triangulation, OSM fusion, light simulation, MongoDB loader |
| [`server/`](server) | Setup + job runner + monitor for the Vultr GPU server |
| [`jobs/`](jobs) | Every processing job the server ran, in order (append-only) |
| [`results/`](results) | Server outputs: `final/` map layers and summary, per-walk detection/scene/blob tables, logs |
| [`data/`](data), [`docs/`](docs) | Published dataset and its documentation |

## Setup and run

**Website** ([`app/web/`](app/web)) — static files, no build:

```bash
cd app/web
python3 -m http.server 8000          # or any static server, then open http://localhost:8000
npx netlify-cli deploy --dir .       # deploy
```
Street View frames and the point cloud are large and live only on the deployed site; the rest works locally.
Live numbers, route scoring and Survey Control call the `/api/*` functions from the dashboard deploy.

**Dashboard / API** ([`app/dashboard/`](app/dashboard)) — Node 18+:

```bash
cd app/dashboard
npm install
export MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/"   # your own Atlas cluster; never commit it
npx netlify-cli dev                  # local, http://localhost:8888
npx netlify-cli deploy --prod        # deploy (set MONGODB_URI in Netlify env vars)
```
Optional env: `CONTROL_PASS` (Survey Control code, demo default `4586`), `LIVE_KEY` (phone upload key, demo
default `tamu-lux-2026`), `MONGODB_DB` (default `lux_survey`). Load the database with `pipeline/mongo_v2.py`.

**iPhone app** ([`app/ios/`](app/ios)) — Xcode 16, iOS 17+, a real iPhone (camera + GPS):

1. Open `app/ios/LightSurvey.xcodeproj`.
2. Target LightSurvey → Signing & Capabilities: set your Team and a unique Bundle Identifier.
3. Run on the phone. Walks are saved under Files → On My iPhone → LightSurvey → Sessions.

**Pipeline** ([`pipeline/`](pipeline)) — Python 3.10, NVIDIA GPU for the detection/depth steps:

```bash
python3 -m venv venv && . venv/bin/activate
pip install -r pipeline/requirements.txt torch "transformers>=4.51" accelerate scikit-learn requests
export SESS_ROOT=/path/to/unzipped/sessions MONGODB_URI=...
python pipeline/detect_blur.py           # blur faces/plates (always first)
python pipeline/detect_world.py
python pipeline/scene_depth_seg.py
python pipeline/light_blobs.py
python pipeline/fuse_map.py              # -> results/final/
python pipeline/light_sim.py
python pipeline/mongo_v2.py              # load MongoDB
```
On our Vultr A16 server these ran through the job runner: `server/setup.sh` once, then `server/agent.sh`
runs each new `jobs/NNN_*.sh` and pushes `results/` back. Details in [`infra/README.md`](infra/README.md).

## Privacy

- Faces, the head area of every detected person and vehicle number plates are blurred before any photo is used for anything published (`pipeline/detect_blur.py`).
- Raw photos and raw phone recordings are **not** published. The dataset has photo positions only; people and vehicles appear as anonymous class labels.
- The only personal identifiers are walker numbers (1–3), who are team members.
- No credentials are in this repo: connection strings and tokens live in environment variables only.

## Team

TEAM_MEMBERS
