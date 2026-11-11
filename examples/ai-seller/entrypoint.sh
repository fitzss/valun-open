#!/bin/sh
# The volume mounts root-owned: take ownership once, then run the seller as the unprivileged 'seller' user.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/valun
  chown -R seller:seller /data
  chmod 0700 /data/valun
  exec setpriv --reuid=seller --regid=seller --init-groups --inh-caps=-all "$0" "$@"
fi
exec python /app/ai_seller.py
