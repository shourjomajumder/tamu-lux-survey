#!/usr/bin/env bash
# Install the live pipeline monitor (web page on port 8080).
cat > /etc/systemd/system/lux-monitor.service <<'UNIT'
[Unit]
Description=Lux pipeline live monitor
After=network-online.target
[Service]
ExecStart=/root/lux/venv/bin/python /root/lux/repo/server/monitor.py
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
command -v ufw >/dev/null && ufw allow 8080/tcp || true
systemctl daemon-reload
systemctl enable --now lux-monitor
sleep 3; systemctl is-active lux-monitor
curl -s -o /dev/null -w "local http %{http_code}\n" "http://127.0.0.1:8080/"
