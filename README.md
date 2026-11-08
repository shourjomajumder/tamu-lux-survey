# TAMU Night Light Survey

Walking survey of night-time lighting on Texas A&M's main campus (TAMU Datathon, Build-A-Dataset challenge).
Four walkers with a custom iPhone app recorded light levels (lux), GPS, direction, photos and light-source
snapshots along planned routes.

- `server/` – setup + job runner for the Vultr GPU server
- `pipeline/` – processing: object detection + face/plate blurring, MongoDB loading
- `jobs/` – jobs the server runs (one at a time, in order); results land in `results/`

Dataset, methodology and data dictionary: coming soon.
