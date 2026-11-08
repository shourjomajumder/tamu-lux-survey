#!/usr/bin/env bash
# One-time setup for the Vultr GPU server.  Run as root:
#   curl -fsSL https://raw.githubusercontent.com/shourjomajumder/tamu-lux-survey/main/server/setup.sh | bash
# It asks for the GitHub token and MongoDB connection string (typed by you, stored only on this server).
set -euo pipefail
REPO=shourjomajumder/tamu-lux-survey
echo "== Installing system packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3-venv python3-pip unzip zip tmux libgl1 libglib2.0-0 >/dev/null
echo "== GPU check =="
nvidia-smi || echo "WARNING: no NVIDIA GPU visible (will run on CPU, slower)"

# Campus Wi-Fi often blocks SSH on port 22: also listen on 443 so uploads work from campus.
if ! grep -q "^Port 443" /etc/ssh/sshd_config; then
  printf '\nPort 22\nPort 443\n' >> /etc/ssh/sshd_config
  command -v ufw >/dev/null && ufw allow 443/tcp >/dev/null || true
  systemctl restart ssh || systemctl restart sshd || true
fi
mkdir -p /data/zips /data/sessions /data/blurred /root/lux
if [ ! -f /root/lux/.env ]; then
  # Values can come from /root/secrets.txt (line 1 = GitHub token, line 2 = MongoDB URI),
  # the environment (Vultr Cloud-Init user data), or be typed in.
  if [ -f /root/secrets.txt ]; then
    GH_TOKEN=$(sed -n 1p /root/secrets.txt | tr -d '\r[:space:]')
    MONGODB_URI=$(sed -n 2p /root/secrets.txt | tr -d '\r[:space:]')
  fi
  # Or from the Vultr "User-Data" tab (read via the metadata service).
  if [ -z "${GH_TOKEN:-}" ] || [ -z "${MONGODB_URI:-}" ]; then
    UD=$(curl -fs -m 5 http://169.254.169.254/latest/user-data || true)
    [ -z "${GH_TOKEN:-}" ] && GH_TOKEN=$(printf '%s\n' "$UD" | grep -oE '(github_pat_|ghp_)[A-Za-z0-9_]+' | head -1 || true)
    [ -z "${MONGODB_URI:-}" ] && MONGODB_URI=$(printf '%s\n' "$UD" | grep -oE 'mongodb(\+srv)?://[^[:space:]]+' | head -1 || true)
    [ -n "${GH_TOKEN:-}" ] && echo "Got GitHub token from Vultr User-Data"
    [ -n "${MONGODB_URI:-}" ] && echo "Got MongoDB string from Vultr User-Data"
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    echo; echo "Paste your GitHub fine-grained token (input hidden), then press Return:"
    read -rs GH_TOKEN < /dev/tty; echo
  fi
  if [ -z "${MONGODB_URI:-}" ]; then
    echo "Paste your MongoDB connection string (mongodb+srv://...) with the real password, then press Return:"
    read -rs MONGODB_URI < /dev/tty; echo
  fi
  umask 077
  printf 'GH_TOKEN=%q\nMONGODB_URI=%q\nREPO=%q\n' "$GH_TOKEN" "$MONGODB_URI" "$REPO" > /root/lux/.env
  rm -f /root/secrets.txt
fi
source /root/lux/.env

if [ ! -d /root/lux/repo/.git ]; then
  git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" /root/lux/repo
fi
cd /root/lux/repo
git config user.name "lux-gpu-server"; git config user.email "lux-gpu-server@users.noreply.github.com"

echo "== Python environment (a few minutes) =="
python3 -m venv /root/lux/venv
/root/lux/venv/bin/pip install -q --upgrade pip
/root/lux/venv/bin/pip install -q -r pipeline/requirements.txt

echo "== Starting the job runner =="
cat > /etc/systemd/system/lux-agent.service <<UNIT
[Unit]
Description=Lux survey job runner
After=network-online.target
[Service]
ExecStart=/bin/bash /root/lux/repo/server/agent.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now lux-agent
echo
echo "DONE. The server now checks GitHub every 30 s for jobs from Claude."
echo "Next: copy your walk zips here (from your Mac, works on campus Wi-Fi):  scp -P 443 ~/Downloads/W*_*.zip root@$(curl -s ifconfig.me):/data/zips/"
