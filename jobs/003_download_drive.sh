#!/usr/bin/env bash
# (Already run. Drive file IDs of the raw, unblurred walk zips are redacted for publication.)
# Download the 16 unique walk zips (duplicates " 2"/" 3" skipped) from Google Drive into /data/zips.
source /root/lux/venv/bin/activate
pip install -q gdown
cd /data/zips
while read -r name id; do
  [ -z "$name" ] && continue
  if [ -s "$name.zip" ] && unzip -tq "$name.zip" >/dev/null 2>&1; then echo "have $name"; continue; fi
  for try in 1 2 3; do
    gdown -q "$id" -O "$name.zip" && unzip -tq "$name.zip" >/dev/null 2>&1 && { echo "OK  $name"; break; }
    echo "retry $name ($try)"; rm -f "$name.zip"; sleep 20
  done
done <<'LIST'
W1_2026-11-07_172047 <DRIVE_FILE_ID>
W1_2026-11-07_172920 <DRIVE_FILE_ID>
W1_2026-11-07_174431 <DRIVE_FILE_ID>
W1_2026-11-07_184140 <DRIVE_FILE_ID>
W2_2026-11-07_184141 <DRIVE_FILE_ID>
W2_2026-11-07_200023 <DRIVE_FILE_ID>
W2_2026-11-07_200132 <DRIVE_FILE_ID>
W2_2026-11-07_200323 <DRIVE_FILE_ID>
W3_2026-11-07_184137 <DRIVE_FILE_ID>
W3_2026-11-07_200407 <DRIVE_FILE_ID>
W3_2026-11-07_201129 <DRIVE_FILE_ID>
W3_2026-11-07_201241 <DRIVE_FILE_ID>
W3_2026-11-07_201403 <DRIVE_FILE_ID>
W3_2026-11-07_202538 <DRIVE_FILE_ID>
W3_2026-11-07_202613 <DRIVE_FILE_ID>
W3_2026-11-07_203921 <DRIVE_FILE_ID>
LIST
ls -lh /data/zips; du -sh /data/zips
# list contents of one small zip so Claude can see the layout
unzip -l /data/zips/W3_2026-11-07_201241.zip | head -40
