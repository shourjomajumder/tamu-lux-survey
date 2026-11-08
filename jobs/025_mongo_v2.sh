#!/usr/bin/env bash
# MongoDB v2 (website backend): drop the 3 test runs, rebuild readings (1 Hz, tagged with seg_id), segments,
# routes, 10 m route bins (coverage), walkers + positions. Waits up to ~90 min for a working connection string,
# re-reading it from Vultr User-Data each minute (the password was rotated). The string is never printed.
for i in $(seq 1 90); do
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
    python -c "import pymongo,os;print('server version', pymongo.MongoClient(os.environ['MONGODB_URI']).server_info()['version'])"
    python pipeline/mongo_v2.py 2>&1 | sed -E 's#mongodb(\+srv)?://[^[:space:]]+#mongodb://***#g'
    exit ${PIPESTATUS[0]}
  fi
  echo "attempt $i: MongoDB login rejected/unreachable, waiting 60s (paste the new string into Vultr User-Data)"; sleep 60
done
echo "gave up after 90 attempts"; exit 1
