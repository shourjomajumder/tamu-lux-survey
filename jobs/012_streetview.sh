#!/usr/bin/env bash
# Night Street View: ~5,000 web-sized blurred frames + depth maps for the parallax walk-through.
set -e
python pipeline/streetview.py
ls -lh /data/web/
