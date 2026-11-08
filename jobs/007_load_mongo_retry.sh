#!/usr/bin/env bash
# Retry the MongoDB load for up to 90 min, re-reading the connection string from Vultr User-Data each time.
for i in $(seq 1 90); do
  UD=$(curl -fs -m 5 http://169.254.169.254/latest/user-data || true)
  NEW=$(printf '%s\n' "$UD" | grep -oE 'mongodb(\+srv)?://[^[:space:]]+' | head -1 | tr -d '<>' || true)
  if [ -n "$NEW" ]; then
    grep -v '^MONGODB_URI=' /root/lux/.env > /tmp/env.new; printf 'MONGODB_URI=%q\n' "$NEW" >> /tmp/env.new
    install -m 600 /tmp/env.new /root/lux/.env; rm -f /tmp/env.new
  fi
  source /root/lux/.env; export MONGODB_URI
  if python -c "import os,pymongo;pymongo.MongoClient(os.environ['MONGODB_URI'],serverSelectionTimeoutMS=8000).admin.command('ping')" 2>/dev/null; then
    echo "MongoDB login OK"; python pipeline/load_mongo.py; exit $?
  fi
  echo "attempt $i: MongoDB login rejected, waiting 60s (fix the string in Vultr User-Data)"; sleep 60
done
exit 1
