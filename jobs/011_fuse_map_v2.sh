#!/usr/bin/env bash
# Re-run the fusion with the latest code (OSM trees, building footprints, lamp accuracy vs OSM).
set -e
python pipeline/fuse_map.py
ls -lh results/final
