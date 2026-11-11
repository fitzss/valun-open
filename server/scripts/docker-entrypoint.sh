#!/bin/bash
# Container entrypoint. Two separate Basis trackers, both on the container's loopback only (never published):
#   demo  tracker 127.0.0.1:${BASIS_PORT:-3048}  data /data/tracker        (public demo, ERG-denominated, synthetic)
#   pilot tracker 127.0.0.1:${PILOT_BASIS_PORT:-3058}  data /data/pilot/tracker  (valun-pilot-1, PC token, synthetic)
# then the Valun app on $PORT. If any process exits, the container exits so the platform restarts it.
# VALUN_ROOT / VALUN_DATA default to the container layout; they are overridable for a rehearsal outside Docker.
set -euo pipefail
ROOT=${VALUN_ROOT:-/opt/valun}; DATA=${VALUN_DATA:-/data}
# Volumes mount root-owned: take ownership once, then continue as the unprivileged 'valun' user.
if [ "$(id -u)" = "0" ]; then
  chown -R valun:valun "$DATA"
  exec setpriv --reuid=valun --regid=valun --init-groups --inh-caps=-all "$0" "$@"
fi
# Maintenance (MIG-3): VALUN_MAINTENANCE=downgrade-check (or downgrade-check-dry-run) runs the v15 rollback check on the
# volume's pilot state with nothing started (no tracker, no app: nothing else writes the file), and exits with its exit
# code (0 prepared, 1 refused, 2 unreadable); the machine then stays stopped until the operator deploys release v15 or
# unsets VALUN_MAINTENANCE (docs/PILOT-API.md "Rollback to release v15").
if [ -n "${VALUN_MAINTENANCE:-}" ]; then
  case "$VALUN_MAINTENANCE" in
    downgrade-check) DRY="" ;;
    downgrade-check-dry-run) DRY="--dry-run" ;;
    *) echo "docker-entrypoint: VALUN_MAINTENANCE=$VALUN_MAINTENANCE is not a maintenance mode (downgrade-check, downgrade-check-dry-run)" >&2; exit 2 ;;
  esac
  set +e
  node "$ROOT/app/scripts/pilot-downgrade-check.mjs" "$DATA/pilot/pilot-state.json" $DRY
  CODE=$?
  set -e
  if [ "$CODE" = "0" ] && [ -z "$DRY" ]; then echo "docker-entrypoint: maintenance: the pilot state is prepared; deploy release v15 now (with VALUN_MAINTENANCE unset), nothing was started" >&2
  else echo "docker-entrypoint: maintenance: downgrade check exit code $CODE; nothing was started" >&2; fi
  exit "$CODE"
fi
# Owner-only demo reset (pilot data is NOT touched): `fly ssh console -C "touch /data/RESET-DEMO"` then restart.
if [ -e "$DATA/RESET-DEMO" ]; then
  echo "RESET-DEMO marker found: wiping the synthetic demo world" >&2
  rm -rf "$DATA/tracker" "$DATA/valun" "$DATA/RESET-DEMO"
fi
mkdir -p "$DATA/tracker" "$DATA/valun" "$DATA/pilot/tracker"
# The config layout each tracker binary needs (basis/run-tracker.sh): auto picks it from the binary (3df7ed93: node,
# tracker v3: scanner with pure_credit). Both trackers run the same binary.
export BASIS_CONFIG_LAYOUT="${BASIS_CONFIG_LAYOUT:-auto}"
# Circulating credit takes effect only for a pinned tracker binary (lib/pilot/pins.mjs): the app is told the sha256 of
# the binary that runs here, computed here and never taken from the environment. Unknown: empty, so circulation stays
# off (fail closed).
PILOT_TRACKER_SHA256="$(sha256sum "$ROOT/bin/basis_server" | cut -d' ' -f1)" || PILOT_TRACKER_SHA256=""
export PILOT_TRACKER_SHA256
echo "docker-entrypoint: basis_server sha256 ${PILOT_TRACKER_SHA256:-unknown}; config layout $BASIS_CONFIG_LAYOUT" >&2
"$ROOT/run-tracker.sh" "$DATA/tracker" "$ROOT/bin/basis_server" > "$DATA/tracker/stdout.log" 2>&1 &
TRACKER=$!
PILOT_TOKEN_ID=$(node -e "process.stdout.write(require('crypto').createHash('sha256').update('valun-pilot-credit/1').digest('hex'))")
BASIS_PORT=${PILOT_BASIS_PORT:-3058} BASIS_SERVED_TOKEN_ID=$PILOT_TOKEN_ID BASIS_SERVED_TOKEN_SYMBOL=PC \
  "$ROOT/run-tracker.sh" "$DATA/pilot/tracker" "$ROOT/bin/basis_server" > "$DATA/pilot/tracker/stdout.log" 2>&1 &
PILOT_TRACKER=$!
for i in $(seq 1 80); do [ -s "$DATA/tracker/tracker-nft-id" ] && [ -s "$DATA/pilot/tracker/tracker-nft-id" ] && break; sleep 0.25; done
export BASIS_TRACKER_NFT_ID="$(cat "$DATA/tracker/tracker-nft-id")"
export PILOT_TRACKER_NFT_ID="$(cat "$DATA/pilot/tracker/tracker-nft-id")"
export PILOT_TRACKER_URL="http://127.0.0.1:${PILOT_BASIS_PORT:-3058}" PILOT_DATA_DIR="$DATA/pilot"
export VALUN_DATA_DIR="$DATA/valun" BASIS_SIGNER="$ROOT/bin/valun_signer" BASIS_RUNNER=direct
node "$ROOT/app/server.mjs" &
APP=$!
# On stop: let the app finish in-flight requests first (it exits within 4 s), then stop the trackers.
stop() {
  kill -TERM $APP 2>/dev/null; wait $APP 2>/dev/null || true
  kill -TERM $TRACKER $PILOT_TRACKER 2>/dev/null; wait $TRACKER 2>/dev/null || true; wait $PILOT_TRACKER 2>/dev/null || true
  exit 0
}
trap stop TERM INT
wait -n $TRACKER $PILOT_TRACKER $APP
echo "a process exited; stopping" >&2
kill $TRACKER $PILOT_TRACKER $APP 2>/dev/null || true
exit 1
