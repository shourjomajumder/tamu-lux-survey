#!/usr/bin/env bash
# Re-run detection + blurring: the first run never saved the blurred photos (missing photos/ folder).
set -e
python pipeline/detect_blur.py
find /data/blurred -name '*.jpg' | wc -l
