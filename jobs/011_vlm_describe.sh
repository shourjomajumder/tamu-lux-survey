#!/usr/bin/env bash
# GPU pass 4: vision-language model writes safety notes for warning spots, unlit lamps and a survey sample.
set -e
python pipeline/vlm_describe.py
wc -l results/final/scene_notes.csv
