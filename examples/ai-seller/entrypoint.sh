#!/bin/bash
# The volume mounts root-owned: take ownership once, then run the agents as the unprivileged 'seller' user.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/valun-testnet /data/bind-testnet
  chown -R seller:seller /data
  chmod 0700 /data/valun-testnet /data/bind-testnet
  exec setpriv --reuid=seller --regid=seller --init-groups --inh-caps=-all "$0" "$@"
fi
# One network: the testnet (valun-testnet-1: nanoERG of Ergo testnet, test coins with no monetary value), at
# HOUSE_TESTNET_SERVER (default https://valun-testnet.fly.dev, which serves it before and after valun.tech does). The
# pilot network is retired: nothing here runs on it, and its files (/data/valun, /data/bind) stay on the volume as
# they are.
server="${HOUSE_TESTNET_SERVER:-https://valun-testnet.fly.dev}"
# The house agents, the machine's main process: their profiles and budget file in /data/valun-testnet (their
# identities since 2026-11-12) and their own dollar caps (HOUSE_TESTNET_MONTHLY_USD, HOUSE_TESTNET_DAILY_USD), under
# the spend limit of the API key's workspace.
VALUN_SERVER="$server" VALUN_HOME=/data/valun-testnet AI_SELLER_NETWORK=testnet \
  AI_SELLER_MONTHLY_USD="${HOUSE_TESTNET_MONTHLY_USD:-5}" AI_SELLER_DAILY_USD="${HOUSE_TESTNET_DAILY_USD:-0.5}" \
  python /app/ai_seller.py &
house=$!
# @bindvalun's bind bot (bind_bot.py), only when its X keys are set (fly secrets): promises bound on X, on the same
# network (BIND_SERVER overrides). Its identities are its own, in /data/bind-testnet: those in /data/bind were made for
# the pilot. Only the X side of the old state carries over, into the new home's first state (the posts it read and
# answered, this month's X spending); /data/bind is only read. It restarts on its own after 60 s (errexit off in the
# loop, so an exit is not the loop's end): its failure never stops the house agents.
if [ -n "${X_API_KEY:-}" ]; then
  (
    set +e
    while true; do
      BIND_HOME=/data/bind-testnet BIND_SERVER="${BIND_SERVER:-$server}" BIND_CARRY_STATE=/data/bind/bind-state.json \
        python /app/bind_bot.py
      echo "{\"action\": \"bind_bot_exited\", \"code\": $?, \"restart_in_s\": 60}"
      sleep 60
    done
  ) &
fi
# The house agents are the machine's: when they stop, exit, and Fly restarts the machine.
set +e
wait $house
exit $?
