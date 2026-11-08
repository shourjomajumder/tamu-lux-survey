#!/usr/bin/env bash
# Find every light emitter in the dark exposure snapshots (rays + colour temperature).
set -e
python pipeline/light_blobs.py
wc -l results/blobs/*.csv | tail -1
