#!/usr/bin/env bash
# Job runner: every 30 s, pull the repo; run any new jobs/NNN_*.sh once; push results/ back.
source /root/lux/.env
cd /root/lux/repo
export PATH=/root/lux/venv/bin:$PATH MONGODB_URI
mkdir -p results/logs
touch results/done.txt
while true; do
  git pull -q --rebase origin main || true
  for job in $(ls jobs/*.sh 2>/dev/null | sort); do
    name=$(basename "$job")
    grep -qx "$name" results/done.txt && continue
    echo "$(date -u +%FT%TZ) START $name" >> results/agent.log
    echo "running" > "results/logs/${name}.status"
    git add results && git commit -qm "start $name" && git push -q origin HEAD:main || true
    ( cd /root/lux/repo && timeout 6h bash "$job" ) > "results/logs/${name}.log" 2>&1
    rc=$?
    echo "exit $rc" > "results/logs/${name}.status"
    echo "$name" >> results/done.txt
    echo "$(date -u +%FT%TZ) END $name rc=$rc" >> results/agent.log
    # Keep logs short in git
    tail -c 200000 "results/logs/${name}.log" > /tmp/l && mv /tmp/l "results/logs/${name}.log"
    git add results && git commit -qm "result $name (rc=$rc)" && (git push -q origin HEAD:main || (git pull -q --rebase origin main && git push -q origin HEAD:main)) || true
  done
  # Heartbeat every ~5 min so Claude can see the server is alive
  if [ $(( $(date +%s) / 30 % 10 )) -eq 0 ]; then
    { date -u +%FT%TZ; nvidia-smi --query-gpu=name,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null; df -h /data | tail -1; ls /data/zips | wc -l; } > results/heartbeat.txt
    git add results/heartbeat.txt && git commit -qm heartbeat && git push -q origin HEAD:main || true
  fi
  sleep 30
done
