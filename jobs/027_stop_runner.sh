#!/usr/bin/env bash
# Processing is finished: stop the job runner so it no longer pulls/pushes this repo (history is about to be rewritten).
nohup sh -c 'sleep 8; systemctl disable --now lux-agent' >/dev/null 2>&1 &
echo "runner stopping"
