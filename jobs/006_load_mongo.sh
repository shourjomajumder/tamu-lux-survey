# Load readings, photos and detections into MongoDB Atlas (lux_survey database).
set -e
python pipeline/load_mongo.py
