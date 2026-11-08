#!/usr/bin/env bash
# Fusion v3: fixed OpenStreetMap download (footpaths, buildings, trees, lamps, emergency phones).
set -e
python pipeline/fuse_map.py
ls -lh results/final
