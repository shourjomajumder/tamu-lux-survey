# lx — Night-light survey of Texas A&M

TAMU Datathon 2026 · Build-A-Dataset challenge

- **Live site:** https://tamu-lux-map.netlify.app
- **Survey Control:** https://tamu-lux-map.netlify.app/#control (demo code `4586`, or leave empty)
- **Demo video:** VIDEO_LINK

## The idea

- **Problem:** campus maps show where lamps *should* be, not how bright it *actually* is
- **What we did:** walked Texas A&M at night with an iPhone app we built
- **What we logged:** light level, position and a photo, every second
- **Result:** an open dataset of measured campus lighting, plus a map to find the best-lit walk home

## Results at a glance

- 13 survey walks · 3 walkers · Nov 7, 2026, 6:40–9:00 pm
- 284,086 raw light readings → 17,715 clean 1-per-second readings
- 3,622 footpath stretches with measured lux
- 65 % of measured stretches are under 5 lux (dim or dark)
- 721 street lamps located · 255 possibly out
- 1,648 trees · 507 low-light warnings (121 high)
- Light model check: median error 1.38 lux on held-out readings

Source: [`results/final/summary.json`](results/final/summary.json)

## How we collected it

- **Device:** iPhone running our app ([`app/ios/`](app/ios))
- **Front camera:** points up through a paper diffuser → converted to lux (~15 per second)
- **Back camera:** 1 photo per second, with GPS and exposure
- **Sensors:** GPS, compass, motion
- **Coordination:** Survey Control website assigns routes to each walker live
- **Uploads:** phones send data every 5 minutes

Full details: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)

## How we used Vultr (GPU processing)

- **Server:** Vultr Cloud GPU, NVIDIA A16, Chicago
- **Job:** turn raw phone walks into the dataset
- **How it runs:**
  - a job runner checks this repo every 30 s
  - runs each new script in [`jobs/`](jobs) once, in order
  - pushes outputs back into [`results/`](results)
- **What the GPU did:**
  - blurred faces and number plates (YOLOv8) — always first
  - found street lamps, trees, call boxes (YOLO-World)
  - estimated depth and scene layout (Depth Anything V2, SegFormer)
  - located bright light sources in photos
  - triangulated lamp positions and flagged possibly-out lamps
  - built the light simulation map
  - built the 3D point cloud for Light View
- **Monitor:** live page showing jobs, logs and GPU use (key not in repo)

Details: [`infra/README.md`](infra/README.md)

## How we used MongoDB (database + live API)

- **Service:** MongoDB Atlas, database `lux_survey`
- **Loaded by:** [`pipeline/mongo_v2.py`](pipeline/mongo_v2.py)
- **Geo search:** every position stored as GeoJSON with `2dsphere` indexes
- **Collections:**
  - `walks` — one per phone session
  - `readings` — 17,715 clean light readings
  - `photos` — photo positions and lux (no images)
  - `detections` — lamps, trees, people, vehicles found in photos
  - `segments` — 3,622 footpath stretches
  - `routes` + `bins` — survey routes cut into 10 m pieces, marked covered or not
  - `walkers` + `positions` — live walker status for Survey Control
- **What runs in MongoDB:**
  - map stats — median lux per stretch, darkest spots (aggregation)
  - route scoring — how well lit a route is (`$geoNear`)
  - coverage — which route pieces are still unwalked
  - suggestions — next routes to send walkers on
  - live walker tracking and route assignments to phones

## Dataset

Everything shareable is in [`data/`](data).

| Part | Folder | Contents |
|---|---|---|
| Measurements (new) | [`data/measurements/`](data/measurements) | clean lux readings · photo index (no images) |
| Derived layers | [`data/derived/`](data/derived) | path lighting · lamps · warnings · trees · routes |
| Supplementary | [`data/supplementary/`](data/supplementary) | public data we did **not** collect |

- **Data dictionary:** [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md)
- **Methodology:** [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
- **Limitations:** [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)

## Supplementary data (not ours)

- **OpenStreetMap** — footpath shapes, buildings ([ODbL](https://opendatacommons.org/licenses/odbl/)); lux values on them are ours
- **Simulated light map** — model output, **not a measurement**
- **Point cloud / Light View** — made from our blurred photos with a depth model
- **Route library** — generated routes, not walked tracks

More: [`docs/SUPPLEMENTARY_DATA.md`](docs/SUPPLEMENTARY_DATA.md)

## Repo map

| Folder | What's inside |
|---|---|
| [`app/ios/`](app/ios) | iPhone app (survey + best-lit routes) |
| [`app/web/`](app/web) | Website: light map, Light View, Survey Control |
| [`app/dashboard/`](app/dashboard) | API (Netlify Functions + MongoDB) |
| [`pipeline/`](pipeline) | Python processing scripts |
| [`server/`](server) | Vultr server setup + job runner |
| [`jobs/`](jobs) | Every job the server ran, in order |
| [`results/`](results) | Server outputs |
| [`data/`](data), [`docs/`](docs) | Published dataset + docs |
| [`infra/`](infra) | How Vultr, MongoDB and the API fit together |

## Setup and run

### Website

```bash
cd app/web
python3 -m http.server 8000      # open http://localhost:8000
```

- No build step
- Light View data only lives on the deployed site

### API / dashboard (Node 18+)

```bash
cd app/dashboard
npm install
export MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/"   # never commit this
npx netlify-cli dev              # http://localhost:8888
```

- Optional env: `CONTROL_PASS` (default `4586`), `LIVE_KEY`, `MONGODB_DB` (default `lux_survey`)
- Load the database: `python pipeline/mongo_v2.py`

### iPhone app (Xcode 16, iOS 17+)

1. Open `app/ios/LightSurvey.xcodeproj`
2. Signing & Capabilities → set your Team and a unique Bundle ID
3. Run on a real iPhone (needs camera + GPS)

### Pipeline (Python 3.10 + NVIDIA GPU)

```bash
pip install -r pipeline/requirements.txt torch "transformers>=4.51" accelerate scikit-learn requests
export SESS_ROOT=/path/to/sessions MONGODB_URI=...
python pipeline/detect_blur.py       # always first
python pipeline/detect_world.py
python pipeline/scene_depth_seg.py
python pipeline/light_blobs.py
python pipeline/fuse_map.py
python pipeline/light_sim.py
python pipeline/mongo_v2.py
```

## Privacy

- Faces, heads and number plates blurred before any use
- Raw photos are **not** published — only photo positions
- Walkers are numbered 1–3 (team members only)
- No passwords or keys in this repo

## Team

TEAM_MEMBERS
