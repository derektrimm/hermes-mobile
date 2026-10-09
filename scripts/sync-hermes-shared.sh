#!/bin/bash
# Copies the Hermes gateway client and wire contract from the Hermes checkout this app talks to,
# so the phone speaks exactly the protocol the running backend serves. Run after `hermes update`.
#
#   scripts/sync-hermes-shared.sh            # from the server in .env.local (default)
#   HERMES_HOST=local scripts/sync-hermes-shared.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env.local ]] && { set -a; . ./.env.local; set +a; }
host=${HERMES_HOST:-${HM_DEPLOY_HOST:?set HM_DEPLOY_HOST in .env.local, or HERMES_HOST=local}}
src=.hermes/hermes-agent/apps/shared/src
files=(json-rpc-gateway.ts json-rpc-channel.ts gateway-events.ts gateway-contract.generated.ts)
out=vendor/hermes-shared
mkdir -p "$out"
if [[ $host == local ]]; then
  for f in "${files[@]}"; do cp "$HOME/$src/$f" "$out/$f"; done
  rev=$(git -C "$HOME/.hermes/hermes-agent" rev-parse HEAD)
else
  for f in "${files[@]}"; do scp -q "$host:$src/$f" "$out/$f"; done
  rev=$(ssh "$host" git -C .hermes/hermes-agent rev-parse HEAD)
fi
printf '%s\n' "$rev" >"$out/HERMES_REVISION"
echo "vendored ${#files[@]} files from hermes-agent $rev"
