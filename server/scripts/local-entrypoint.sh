#!/bin/bash
# The local Valun server's entrypoint (Dockerfile.local; fix inbox #143): a copy of Valun for testing on your own
# machine, with NO chain. ONE Basis tracker, pure credit (basis/run-tracker.sh: no Ergo node, no reserves, a synthetic
# tracker identity whose key nobody holds) on the container's loopback only, 127.0.0.1:${PILOT_BASIS_PORT:-3058}, never
# published; then the Valun app on ${HOST:-0.0.0.0}:${PORT:-8080} in local mode (VALUN_ENVIRONMENT=local,
# lib/environment.mjs: GET /pilot/v1/info and every page say "local: no chain"). The network is valun-pilot-1 (PC,
# synthetic credits with no monetary value): the one network with no chain, and the one the released clients describe as
# having none. If the tracker or the app exits, the container exits. No legacy desk runs (its /api and /mcp answer 503).
# Settings (Dockerfile.local's ENV), each can be changed with docker run -e: PILOT_OPEN_SANDBOX=1 (self-serve joins),
# PILOT_OPEN_NETWORK=1 (self-serve agents deal with anyone), PILOT_CIRCULATION=on (debt transfers and set-offs, on a
# pinned tracker only), PORT, and VALUN_PUBLIC_ORIGIN (the origin its links name; by default http://127.0.0.1:$PORT).
# Data (a volume at /data): the tracker's notes in /data/pilot/tracker, the network's state in /data/pilot.
# VALUN_ROOT / VALUN_DATA default to the container layout; they are overridable for a rehearsal outside Docker.
set -euo pipefail
ROOT=${VALUN_ROOT:-/opt/valun}; DATA=${VALUN_DATA:-/data}
say() { echo "local-entrypoint: $*" >&2; }
# The image runs as its unprivileged user (Dockerfile.local: USER 10001). Started as root anyway (docker run --user 0,
# say, for a host folder only root may write): take ownership of the data folder once, then continue as that user.
if [ "$(id -u)" = "0" ]; then
  chown -R valun:valun "$DATA"
  exec setpriv --reuid=valun --regid=valun --init-groups --inh-caps=-all "$0" "$@"
fi
# No chain here, so only the network that has none.
NETWORK=${PILOT_NETWORK:-valun-pilot-1}
if [ "$NETWORK" != valun-pilot-1 ]; then
  say "PILOT_NETWORK=$NETWORK: this image has no chain and runs only valun-pilot-1 (valun-testnet-1 needs its tracker on Ergo testnet)"
  exit 2
fi
# No legacy desk: its demo tracker does not run here, so the app runs the network without it.
unset BASIS_TRACKER_NFT_ID BASIS_TRACKER_URL
TRACKER_DIR="$DATA/pilot/tracker"
mkdir -p "$TRACKER_DIR" "$DATA/valun" 2>/dev/null || true
for d in "$DATA/pilot" "$TRACKER_DIR" "$DATA/valun"; do
  if [ ! -d "$d" ] || [ ! -w "$d" ]; then
    say "$d is not a folder uid $(id -u) can write: mount a named volume (-v valun-local:/data), or a folder that uid may write"
    exit 2
  fi
done
# Circulating credit takes effect only for a pinned tracker binary (lib/pilot/pins.mjs): the app is told the sha256 of
# the binary that runs here, computed here at every start and never taken from the environment. Unknown: empty, so
# circulation stays off (fail closed).
PILOT_TRACKER_SHA256="$(sha256sum "$ROOT/bin/basis_server" | cut -d' ' -f1)" || PILOT_TRACKER_SHA256=""
export PILOT_TRACKER_SHA256
say "basis_server sha256 ${PILOT_TRACKER_SHA256:-unknown}; network valun-pilot-1, local: no chain"
# The unit's token id (PC, the pilot credit): it exists on no chain; it labels notes.
PILOT_TOKEN_ID=$(node -e "process.stdout.write(require('crypto').createHash('sha256').update('valun-pilot-credit/1').digest('hex'))")
TRACKER_PORT=${PILOT_BASIS_PORT:-3058}
# Pure credit always (BASIS_PURE_CREDIT=1): a tracker without it would look for a chain.
BASIS_CONFIG_LAYOUT=auto BASIS_PURE_CREDIT=1 BASIS_PORT=$TRACKER_PORT BASIS_SERVED_TOKEN_ID=$PILOT_TOKEN_ID BASIS_SERVED_TOKEN_SYMBOL=PC \
  "$ROOT/run-tracker.sh" "$TRACKER_DIR" "$ROOT/bin/basis_server" > "$TRACKER_DIR/stdout.log" 2>&1 &
TRACKER=$!
tracker_log() { say "the tracker's last output ($TRACKER_DIR/stdout.log):"; tail -n 20 "$TRACKER_DIR/stdout.log" >&2 || true; }
# The tracker's id (made once, kept in the volume), at most 20 s.
for i in $(seq 1 80); do { [ -s "$TRACKER_DIR/tracker-nft-id" ] || ! kill -0 $TRACKER 2>/dev/null; } && break; sleep 0.25; done
if [ ! -s "$TRACKER_DIR/tracker-nft-id" ]; then
  say "the tracker did not start"; tracker_log
  kill $TRACKER 2>/dev/null || true
  exit 1
fi
PILOT_TRACKER_NFT_ID="$(cat "$TRACKER_DIR/tracker-nft-id")"
export PILOT_TRACKER_NFT_ID PILOT_NETWORK=valun-pilot-1 VALUN_ENVIRONMENT=local VALUN_DEPLOYMENT=local \
  PILOT_TRACKER_URL="http://127.0.0.1:$TRACKER_PORT" PILOT_DATA_DIR="$DATA/pilot" VALUN_DATA_DIR="$DATA/valun" \
  BASIS_SIGNER="$ROOT/bin/valun_signer" BASIS_RUNNER=direct HOST="${HOST:-0.0.0.0}" PORT="${PORT:-8080}" \
  PILOT_OPEN_SANDBOX="${PILOT_OPEN_SANDBOX:-1}" PILOT_OPEN_NETWORK="${PILOT_OPEN_NETWORK:-1}" PILOT_CIRCULATION="${PILOT_CIRCULATION:-on}"
node "$ROOT/app/server.mjs" &
APP=$!
# On stop: let the app finish in-flight requests first (it exits within 4 s), then stop the tracker.
stop() {
  kill -TERM $APP 2>/dev/null; wait $APP 2>/dev/null || true
  kill -TERM $TRACKER 2>/dev/null; wait $TRACKER 2>/dev/null || true
  exit 0
}
trap stop TERM INT
# `|| true`: under set -e a process that exited with a failure would otherwise end this script at once, before the
# other is stopped.
wait -n $TRACKER $APP || true
say "a process exited; stopping"
kill -0 $TRACKER 2>/dev/null || tracker_log
kill $TRACKER $APP 2>/dev/null || true
exit 1
