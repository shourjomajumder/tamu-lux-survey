#!/usr/bin/env bash
# GPU pass 2: find streetlights, wall lights, emergency phones and trees (open-vocabulary YOLO-World).
set -e
pip install -q "git+https://github.com/ultralytics/CLIP.git" 2>&1 | tail -2 || true
python pipeline/detect_world.py
wc -l results/world/*.csv | tail -1
