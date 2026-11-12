#!/bin/bash
# The volume mounts root-owned: take ownership once, then run the sellers as the unprivileged 'seller' user.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/valun /data/valun-testnet
  chown -R seller:seller /data
  chmod 0700 /data/valun /data/valun-testnet
  exec setpriv --reuid=seller --regid=seller --init-groups --inh-caps=-all "$0" "$@"
fi
# The house agents on the pilot (VALUN_SERVER, VALUN_HOME=/data/valun and its budget file) and, with HOUSE_TESTNET=1, the
# same agents on the testnet network: their own profiles and budget file in /data/valun-testnet, their own dollar caps
# (HOUSE_TESTNET_MONTHLY_USD, HOUSE_TESTNET_DAILY_USD). Both use the one API key; its workspace limit caps them together.
python /app/ai_seller.py &
pids=$!
if [ "${HOUSE_TESTNET:-0}" = "1" ]; then
  VALUN_SERVER="${HOUSE_TESTNET_SERVER:-https://valun-testnet.fly.dev}" VALUN_HOME=/data/valun-testnet AI_SELLER_NETWORK=testnet \
    AI_SELLER_MONTHLY_USD="${HOUSE_TESTNET_MONTHLY_USD:-5}" AI_SELLER_DAILY_USD="${HOUSE_TESTNET_DAILY_USD:-0.5}" \
    python /app/ai_seller.py &
  pids="$pids $!"
fi
# When one stops, stop the other and exit: Fly restarts the machine and both start again.
set +e
wait -n
code=$?
kill $pids 2>/dev/null
exit $code
