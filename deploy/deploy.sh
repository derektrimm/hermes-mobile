#!/bin/bash
# Builds the app here and installs it on the server: files, the user service, the tailnet-only
# https listener, then probes it. Run from the repository root. Settings come from .env.local
# (see .env.example), which is copied to the server with the app.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env.local ]] || { echo "deploy: no .env.local (copy .env.example and fill it in)" >&2; exit 1; }
set -a
. ./.env.local
set +a
host=${HM_DEPLOY_HOST:?set HM_DEPLOY_HOST in .env.local}
dir=${HM_REMOTE_DIR:-src/hermes-mobile}
port=${HM_PUBLIC_PORT:-8620}

npm run build
# The previous build's hashed assets stay a while: a phone holding the old page must not lose them.
rsync -a --delete --exclude node_modules --exclude .git --filter='P dist/assets/' ./ "$host:$dir/"

ssh "$host" bash -s -- "$port" "$dir" <<'REMOTE'
set -euo pipefail
port=$1
dir=$2
cd ~/"$dir"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
find dist/assets -type f -mtime +14 -delete
mkdir -p ~/.config/systemd/user
sed "s#@APP_DIR@#$HOME/$dir#g" deploy/hermes-mobile.service >~/.config/systemd/user/hermes-mobile.service
# PC terminal windows as TUI clients of a shared backend that keeps the PC's desktop hands.
install -Dm755 pc-windows/hermes-hands ~/.local/bin/hermes-hands
install -Dm755 pc-windows/hermes-hands-new ~/.local/bin/hermes-hands-new
install -Dm644 pc-windows/hermes-hands@.service ~/.config/systemd/user/hermes-hands@.service
systemctl --user daemon-reload
systemctl --user enable --quiet hermes-mobile.service
systemctl --user restart hermes-mobile.service
sock=/run/user/$(id -u)/hermes-mobile/app.sock
sudo -n tailscale serve --bg --https="$port" "unix:$sock" >/dev/null
for i in $(seq 1 20); do
  curl -fsS --unix-socket "$sock" http://local/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
systemctl --user is-active hermes-mobile.service
curl -fsS --unix-socket "$sock" http://local/healthz; echo
REMOTE
echo "https://$host:$port/"
