# Detect cars/people/etc in every photo, blur faces + plates, estimate object positions.
set -e
python pipeline/detect_blur.py
ls -lh results/detections
