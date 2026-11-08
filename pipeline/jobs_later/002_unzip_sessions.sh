# Unpack every phone zip copied to /data/zips into /data/sessions/<session>/ (skips ones already done).
set -e
cd /data/zips
for z in *.zip; do
  [ -e "$z" ] || { echo "no zips yet in /data/zips"; exit 0; }
  tmp=$(mktemp -d); unzip -oq "$z" -d "$tmp"
  for s in $(find "$tmp" -name session.json -exec dirname {} \;); do
    n=$(basename "$s")
    if [ -d "/data/sessions/$n" ]; then echo "skip $n (already there)"; continue; fi
    mv "$s" "/data/sessions/$n"; echo "unpacked $n: $(ls /data/sessions/$n/photos | wc -l) photos"
  done
  rm -rf "$tmp"
done
du -sh /data/sessions
