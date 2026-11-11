#!/bin/bash
# Start the real Basis tracker (basis_server) in pure-credit mode: loopback only, no Ergo node, no reserves,
# synthetic tracker identity (random NFT id, NUMS public key with no known secret).
# Usage: run-tracker.sh RUN_DIR BASIS_SERVER_BINARY
# RUN_DIR keeps the tracker's data across restarts; tracker-nft-id is created once.
# BASIS_CONFIG_LAYOUT is the config layout the binary needs (each tracker refuses the other's):
#   node     an [ergo.node] section: Basis 3df7ed93, the tracker shipped so far.
#   scanner  an [ergo.scanner] section, plus pure_credit = true under [server] (BASIS_PURE_CREDIT=0 leaves it out):
#            tracker v3 (Basis master + the Valun circulating-credit commits).
#   auto     (default) scanner when the binary contains v3's message 'rename it to [ergo.scanner]', else node.
# Both layouts write start_height = 0 and node_url = http://127.0.0.1:9 (nothing listens there); neither relies on
# a default. The layout chosen is reported on stderr: a tracker refusing its config exits 1 without printing anything.
set -euo pipefail
RUN=${1:?run dir}; BIN=${2:?basis_server path}
if [ ! -f "$BIN" ] || [ ! -x "$BIN" ]; then echo "run-tracker.sh: no executable basis_server at $BIN" >&2; exit 127; fi
LAYOUT=${BASIS_CONFIG_LAYOUT:-auto}
case "$LAYOUT" in
  auto)
    found=0; grep -aqF 'rename it to [ergo.scanner]' "$BIN" || found=$?
    case $found in
      0) LAYOUT=scanner ;;
      1) LAYOUT=node ;;
      *) echo "run-tracker.sh: cannot read $BIN to pick its config layout" >&2; exit 1 ;;
    esac ;;
  node|scanner) ;;
  *) echo "run-tracker.sh: BASIS_CONFIG_LAYOUT must be auto, node or scanner, not '$LAYOUT'" >&2; exit 2 ;;
esac
PURE_CREDIT=""
if [ "$LAYOUT" = scanner ] && [ "${BASIS_PURE_CREDIT:-1}" != 0 ]; then PURE_CREDIT=$'\npure_credit = true'; fi
echo "run-tracker.sh: $BIN: config layout $LAYOUT${PURE_CREDIT:+, pure_credit = true} (BASIS_CONFIG_LAYOUT=${BASIS_CONFIG_LAYOUT:-auto})" >&2
mkdir -p "$RUN/config" "$RUN/data"
if [ ! -s "$RUN/tracker-nft-id" ]; then od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$RUN/tracker-nft-id"; fi
NFT=$(cat "$RUN/tracker-nft-id")
# The reserve P2S is the server's default ERG reserve contract; it only satisfies config validation here.
cat > "$RUN/config/basis.toml" <<EOF
[server]
host = "127.0.0.1"
port = ${BASIS_PORT:-3048}
data_dir = "data"${PURE_CREDIT}

[ergo]
basis_reserve_contract_p2s = "2XoR96YVZfWybxeo7qdMkA1BRhxFivm8gTuLLuKREiW6833XWK4mA43DrJMDCvLqB9AwyduGgHBnGmmg2jrkUZAunRDu7t8718EkwiJTvp9rtEWEXMMJeMStjQB5BeuxsUc9ujW3aCMvxdS8VeYyZ14B8sSGu7CwJFmeaZDHiftsT3tUBqBfgau4wZTvhEtYEsFsqvpwsjcPAe4aGhFzJNSPhKqdSBrFKee3Dg4qFmGhb8Wu6DsdmhTrW6jnucnf17PDi2rQ9pgJvKrfs2KPbeZf9gV89vEga4kZk4u3bbSFTVk3s9EhuoUmfyhvC3ZaNv9DSPtzCcjvnL7x6smyLigsgb4QSEDnzX4HjJg5CfA6mh4Jn9hoL1412EVnY2xb8cYz76VEgU8J12n4DHrVsV9NzYAHxe6ogVNptUbAgykiru81pz3aZ6LfYySJt6ESVVGxm6i49ScGjawqsKCxjykCndh3MNQnRajZMgQMH2qFZhbd9KXCnLQkS6NAjtNfMVcx1KykdiSrLVTu3nphUZhT9MjhfxtZcojSZoQmGAy95zhAJpDMgUXBfuCSoUFUzPAuSMv2pBuEXiUR3wDQC7pDFYUDy68QCtTUTDtn9cYyNgc8EZWQSB76wsKhCNod1Q9RV85piLF5PJDMBXh4M8gjEzsq244xDdW6t2f4W4A2ZVDNw2gdSU3FHYxfB45c5cxkyR5qrXyoJT56c2STfFm3vK1ZfXzvckq48uAE1QRGpM9xALiXtdTx1iQaQjy2LkaURha6ewN5NDufyqntwBPk72NLadL8BDtLyReRtUWqbFZo94h4prjHVT25ABHbAqiJuTCHvmfTqi2V5gDwRW7oLk4gvBwswxJVvKmuKSG6sH5HAzQGoF6Kwcwdvq8Lbv5RbuAnm3N7hLnS1rBUWKXfaJCJjptMkeKxzMPhjfjnZTkMXwW3jSBxhpLeuWxrBrfjTFaVR93erQFVTvF9C1FsULgqUPjzPmcHn5Drp4cp4Y2pjv793k6KdykbugL6M6wt75hmKG5jsmrfsSL6AN13j3"
tracker_nft_id = "$NFT"
# BIP-341 NUMS point: a valid public key nobody has the secret for. Nothing can be signed as this tracker.
tracker_public_key = "0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"

[ergo.${LAYOUT}]
start_height = 0
# Nothing listens here: pure-credit mode, no chain.
node_url = "http://127.0.0.1:9"
EOF
# Optional synthetic unit (e.g. pilot credit): a token id this tracker serves. It exists on no chain; it labels notes.
if [ -n "${BASIS_SERVED_TOKEN_ID:-}" ]; then
  printf '\n[ergo.reserve_tokens."%s"]\nsymbol = "%s"\ndecimals = 0\n' "$BASIS_SERVED_TOKEN_ID" "${BASIS_SERVED_TOKEN_SYMBOL:-PC}" >> "$RUN/config/basis.toml"
fi
echo "TRACKER_NFT_ID=$NFT"
cd "$RUN"
echo $$ > "$RUN/tracker.pid"
exec env -i HOME="$RUN" PATH=/usr/bin:/bin RUST_LOG="${RUST_LOG:-warn}" "$BIN"
