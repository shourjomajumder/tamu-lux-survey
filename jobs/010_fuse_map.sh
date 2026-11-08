#!/usr/bin/env bash
# Fuse: clean light readings (no car lights), triangulate lamps, trees, phones, path lighting + warnings.
set -e
python pipeline/fuse_map.py
ls -lh results/final
