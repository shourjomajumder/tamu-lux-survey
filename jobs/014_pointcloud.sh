#!/usr/bin/env bash
# 3D photo point cloud of campus at night (metric depth on ~5,000 Street View frames, fused + voxelised).
set -e
python pipeline/pointcloud.py
ls -lh /data/web/pointcloud /data/web/pointcloud.zip
