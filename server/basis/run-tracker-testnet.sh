#!/bin/bash
# Start the Valun TESTNET network's Basis tracker (tracker v4): loopback only; its key in RUN/tracker-key.json (made
# once by ergo/bootstrap.mjs key, mode 0600; read here, written into the 0600 config the tracker reads, never printed);
# Ergo through the wallet adapter on 127.0.0.1:${ERGO_SHIM_PORT:-9053} (ergo/wallet-shim.mjs: public testnet node,
# local signing for the tracker key only).
#   Before the bootstrap (no RUN/tracker-nft-id-onchain yet): pure_credit = true with a placeholder NFT id, so nothing
#   touches the chain and the Valun server refuses deals (it is told PILOT_TRACKER_ON_CHAIN=0).
#   After it: the tracker's real NFT and anchored netting (tracker v4 TR-15: debt transfers and set-offs may lower an
#   edge with an on-chain total while the tracker box is fresh, never below a redemption authorization); the scanner,
#   the tracker scanner and the tracker box updater run (every BASIS_TRACKER_UPDATE_INTERVAL_SECONDS, 1800 by default:
#   at most 48 anchors a day, plus a keep-alive refresh of an unchanged tracker box every 720 blocks; the adapter caps 50).
# Usage: run-tracker-testnet.sh RUN_DIR BASIS_SERVER_BINARY
set -euo pipefail
RUN=${1:?run dir}; BIN=${2:?basis_server path}
if [ ! -f "$BIN" ] || [ ! -x "$BIN" ]; then echo "run-tracker-testnet.sh: no executable basis_server at $BIN" >&2; exit 127; fi
KEY="$RUN/tracker-key.json"
[ -s "$KEY" ] || { echo "run-tracker-testnet.sh: $KEY is missing (run: node ergo/bootstrap.mjs key --dir $RUN)" >&2; exit 2; }
PK=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pubkey_hex)" "$KEY")
SK=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).secret_hex)" "$KEY")
[[ "$PK" =~ ^0[23][0-9a-f]{64}$ && "$SK" =~ ^[0-9a-f]{64}$ ]] || { echo "run-tracker-testnet.sh: $KEY is malformed" >&2; exit 2; }
# The Basis ERG reserve contract (basis.es, 764 bytes, sha256 760b84d2...), testnet-encoded; the tracker checks its
# ErgoTree against the one it was compiled with.
RESERVE_P2S=${BASIS_RESERVE_CONTRACT_TESTNET:?BASIS_RESERVE_CONTRACT_TESTNET (the testnet P2S of basis.es)}
SHIM="http://127.0.0.1:${ERGO_SHIM_PORT:-9053}"
mkdir -p "$RUN/config" "$RUN/data"
if [ -s "$RUN/tracker-nft-id-onchain" ]; then
  NFT=$(cat "$RUN/tracker-nft-id-onchain"); MODE=$'\nanchored_netting = true'; START=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).start_height||0))" "$RUN/bootstrap.json" 2>/dev/null || echo 0)
  echo "run-tracker-testnet.sh: on chain, tracker NFT ${NFT:0:16}..., scanner from height $START, anchored netting" >&2
else
  if [ ! -s "$RUN/tracker-nft-id" ]; then od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$RUN/tracker-nft-id"; fi
  NFT=$(cat "$RUN/tracker-nft-id"); MODE=$'\npure_credit = true'; START=0
  echo "run-tracker-testnet.sh: BEFORE the bootstrap: pure_credit, placeholder NFT; fund $(node /opt/valun/ergo/bootstrap.mjs key --dir "$RUN" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).address)}catch{process.stdout.write('?')}})")" >&2
fi
[[ "$NFT" =~ ^[0-9a-f]{64}$ ]] || { echo "run-tracker-testnet.sh: bad NFT id" >&2; exit 2; }
umask 077
cat > "$RUN/config/basis.toml" <<EOF
[server]
host = "127.0.0.1"
port = ${BASIS_PORT:-3058}
data_dir = "data"${MODE}

[ergo]
basis_reserve_contract_p2s = "$RESERVE_P2S"
tracker_nft_id = "$NFT"
tracker_public_key = "$PK"
tracker_secret_key = "$SK"

[ergo.scanner]
start_height = $START
node_url = "$SHIM"

[ergo.wallet]
node_url = "$SHIM"

[acceptance]
default = "accept"
EOF
echo "TRACKER_NFT_ID=$NFT"
cd "$RUN"
echo $$ > "$RUN/tracker.pid"
exec env -i HOME="$RUN" PATH=/usr/bin:/bin RUST_LOG="${RUST_LOG:-warn}" \
  BASIS_TRACKER_UPDATE_INTERVAL_SECONDS="${BASIS_TRACKER_UPDATE_INTERVAL_SECONDS:-1800}" "$BIN"
