#!/usr/bin/env bash
# Download walk zips from the shared Google Drive folder into /data/zips.
set -e
source /root/lux/venv/bin/activate
pip install -q gdown
cd /data/zips
gdown --folder "https://drive.google.com/drive/folders/1UWajIF8EMxwuzKEBSKXiRnm4gnV4uxzb" -O /data/zips --remaining-ok
# gdown puts files in a subfolder; flatten
find /data/zips -mindepth 2 -type f -name '*.zip' -exec mv -n {} /data/zips/ \;
ls -lh /data/zips
du -sh /data/zips
