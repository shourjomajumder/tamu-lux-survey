#!/usr/bin/env bash
# Drop the 3 pre-survey test runs (W1 5:20-5:48 pm) from every map layer, then re-run the light simulation.
set -e
python pipeline/fuse_map.py
python pipeline/light_sim.py
ls -lh results/final
