#!/usr/bin/env bash
# Copy the two 3D scans into the repo so Claude can open them (16 MB + 8.6 MB).
set -e
mkdir -p results/splats && cp /data/web/splats/*.splat /data/web/splats/spots.json results/splats/
ls -lh results/splats
