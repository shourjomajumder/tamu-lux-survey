#!/usr/bin/env bash
# GPU pass 3: scene segmentation (sky/trees/sidewalk/road) + metric depth to every detected object.
set -e
pip install -q -U "transformers>=4.51" accelerate scikit-learn scipy requests 2>&1 | tail -2 || true
python pipeline/scene_depth_seg.py
ls -lh results/scene | tail -5
