#!/usr/bin/env bash
# Load readings, photos and detections into MongoDB Atlas (lux_survey database).
set -e
# Pick up a corrected MongoDB string from the Vultr User-Data box, if one was pasted there.
UD=$(curl -fs -m 5 http://169.254.169.254/latest/user-data || true)
NEW=$(printf '%s\n' "$UD" | grep -oE 'mongodb(\+srv)?://[^[:space:]]+' | head -1 || true)
if [ -n "$NEW" ]; then
  grep -v '^MONGODB_URI=' /root/lux/.env > /tmp/env.new
  printf 'MONGODB_URI=%q\n' "$NEW" >> /tmp/env.new
  install -m 600 /tmp/env.new /root/lux/.env; rm -f /tmp/env.new
  echo "updated MongoDB string from User-Data"
fi
source /root/lux/.env; export MONGODB_URI
python pipeline/load_mongo.py
