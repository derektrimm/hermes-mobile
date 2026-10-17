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
# Notifications: the plugin that reports chat events to this app, in every Hermes profile. Enabling
# it writes the profile's config, so every Hermes process started later loads it. The running
# backend (the dashboard) is then asked to load it now, and again whenever its code changed; that
# answer lists the hooks it loaded, which is the check that it took. Other backends already running
# (the desktop app's, a PC window's) load a changed plugin when they next start.
root=${HM_HERMES_ROOT:-$HOME/.hermes}
backend=${HM_BACKEND:-http://127.0.0.1:9119}
token=$(curl -fsS "$backend/" | grep -oP '__HERMES_SESSION_TOKEN__\s*=\s*"\K[^"]+' || true)
for home in "$root" "$root"/profiles/*; do
  [[ -f "$home/config.yaml" ]] || continue
  changed=$(rsync -a --delete --exclude __pycache__ --itemize-changes plugin/hermes_mobile_push/ "$home/plugins/hermes_mobile_push/" | grep -E '^(>|\*deleting)' || true)
  enabled=$(HERMES_HOME="$home" hermes plugins enable hermes_mobile_push </dev/null 2>&1) || { echo "$enabled" >&2; exit 1; }
  state="unchanged"
  if [[ -n "$changed" || "$enabled" != *"already enabled"* ]]; then
    [[ -n "$token" ]] || { echo "deploy: no token from $backend to load the notifications plugin" >&2; exit 1; }
    answer=$(curl -fsS -X POST "$backend/api/dashboard/agent-plugins/activate" -H "X-Hermes-Session-Token: $token" \
      -H 'content-type: application/json' -d "{\"name\":\"hermes_mobile_push\",\"home\":\"$home\"}")
    [[ "$answer" == *'"on_session_end"'* ]] || { echo "deploy: the backend did not load the notifications plugin for $home: $answer" >&2; exit 1; }
    state="loaded in the running backend"
  fi
  echo "notifications plugin in ${home#"$HOME"/}: $state"
done
REMOTE
echo "https://$host:$port/"
