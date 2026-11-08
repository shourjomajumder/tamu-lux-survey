#!/usr/bin/env bash
# Copy the cached OSM walkable network (gzipped, ~200 KB) to results/tmp so the route builder can be tuned offline.
mkdir -p results/tmp && gzip -c /data/osm_cache.json > results/tmp/osm_cache.json.gz && ls -l results/tmp
