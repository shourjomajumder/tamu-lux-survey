#!/usr/bin/env bash
# New-path routes (ids 201+) from the cached OSM walkable network: ~8 routes of 3-5 km, each in a different
# area of campus with its own start, mostly over paths the survey has not collected yet. Library = 4 original
# loops + new routes (recheck loops dropped) -> results/final/route_library.json (+ _light.json, new_routes_report.json).
# Then rebuild only the MongoDB routes + 10 m bins from it (readings untouched). CPU only.
set -o pipefail
test -f /data/osm_cache.json || { echo "no /data/osm_cache.json"; exit 1; }
ls -l /data/osm_cache.json
python pipeline/new_routes.py --osm /data/osm_cache.json --final results/final || exit 1
ls -l results/final/route_library.json results/final/route_library_light.json results/final/new_routes_report.json

# MongoDB connection string: same as job 025 (Vultr User-Data -> /root/lux/.env); never printed
for i in $(seq 1 20); do
  UD=$(curl -fs -m 5 http://169.254.169.254/latest/user-data || true)
  NEW=$(printf '%s\n' "$UD" | grep -oE 'mongodb(\+srv)?://[^[:space:]]+' | head -1 | tr -d '<>"'"'" || true)
  if [ -n "$NEW" ]; then
    touch /root/lux/.env
    grep -v '^MONGODB_URI=' /root/lux/.env > /tmp/env.new || true; printf 'MONGODB_URI=%q\n' "$NEW" >> /tmp/env.new
    install -m 600 /tmp/env.new /root/lux/.env; rm -f /tmp/env.new
  fi
  unset NEW UD
  source /root/lux/.env; export MONGODB_URI
  if python -c "import os,pymongo;pymongo.MongoClient(os.environ['MONGODB_URI'],serverSelectionTimeoutMS=8000).admin.command('ping')" >/dev/null 2>&1; then
    echo "MongoDB login OK (attempt $i)"
    python pipeline/mongo_v2.py --routes-only 2>&1 | sed -E 's#mongodb(\+srv)?://[^[:space:]]+#mongodb://***#g'
    exit ${PIPESTATUS[0]}
  fi
  echo "attempt $i: MongoDB login rejected/unreachable, waiting 60s"; sleep 60
done
echo "gave up on MongoDB after 20 attempts (route library files were still written)"; exit 2
