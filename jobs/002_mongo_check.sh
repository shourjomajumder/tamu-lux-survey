#!/usr/bin/env bash
# Retries the MongoDB ping for up to 20 min (waiting for the Atlas IP allowlist).
source /root/lux/.env; source /root/lux/venv/bin/activate
for i in $(seq 1 40); do
  if python - <<'PY'
import os, pymongo
c = pymongo.MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=8000)
print(c.admin.command("ping")); print("collections:", c["lux_survey"].list_collection_names())
PY
  then echo "MONGO OK"; exit 0; fi
  echo "attempt $i failed, retrying in 30s"; sleep 30
done
exit 1
