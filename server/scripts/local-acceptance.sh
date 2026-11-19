#!/bin/bash
# The local image's acceptance test (fix inbox #143), run against a started container of Dockerfile.local: the server
# says it is local with no chain and runs circulating credit; then, with a fresh client home, the released client
# (valun 0.7.1 by default) points at it (`valun config server URL`), joins without an invite (`valun join --sandbox`)
# and takes the five-step sandbox tour (`valun sandbox tour --yes`); last, the server's public API must show an applied
# set-off with this participant in it (GET /pilot/v1/loops). It prints no secret: the owner token goes to a file in the
# temporary client home, which is removed at the end (KEEP=1 keeps it, and says where).
# Needs bash, curl, uvx (uv) and python3 (or python); network access for uvx to fetch the client once.
# Usage: scripts/local-acceptance.sh [URL]   (URL: default $VALUN_URL, else http://127.0.0.1:8080)
#   VALUN_CLIENT   the client to run, as uvx --from takes it (default valun==0.7.1)
#   WAIT_S         how long to wait for the server to answer (default 180 s); TOUR_S, for the tour (default 1500 s)
# Exit codes: 0 the tour completed with a set-off; 1 it did not (what failed is printed); 2 a setup problem (a tool
# missing, or no server answering at URL).
set -euo pipefail
URL=${1:-${VALUN_URL:-http://127.0.0.1:8080}}; URL=${URL%/}
CLIENT=${VALUN_CLIENT:-valun==0.7.1}
WAIT_S=${WAIT_S:-180}; TOUR_S=${TOUR_S:-1500}
say() { echo "local-acceptance: $*"; }
fail() { say "FAIL: $*"; exit 1; }
for tool in curl uvx timeout; do command -v "$tool" >/dev/null 2>&1 || { say "needs $tool"; exit 2; }; done
PY=""
for p in python3 python; do if command -v "$p" >/dev/null 2>&1 && "$p" -I -c 'import json' >/dev/null 2>&1; then PY=$p; break; fi; done
[ -n "$PY" ] || { say "needs python3 (or python)"; exit 2; }
# A field of a JSON document on stdin, by a Python expression over `j` (the document); prints it as JSON when not a str.
jq_() { "$PY" -I -c 'import json, sys; j = json.load(sys.stdin); v = eval(sys.argv[1], {"j": j}); print(v if isinstance(v, str) else json.dumps(v))' "$1"; }

# 1. The server answers, says it is local with no chain, and runs circulating credit on its pinned tracker.
say "server $URL, client $CLIENT"
deadline=$((SECONDS + WAIT_S))
until health=$(curl -fsS -m 5 "$URL/pilot/v1/health" 2>/dev/null) && [ "$(printf '%s' "$health" | jq_ 'j.get("ok") is True')" = true ]; do
  [ $SECONDS -lt $deadline ] || { say "no healthy server at $URL/pilot/v1/health within ${WAIT_S} s"; exit 2; }
  sleep 2
done
say "health: $health"
info=$(curl -fsS -m 10 "$URL/pilot/v1/info") || fail "GET /pilot/v1/info failed"
summary=$(printf '%s' "$info" | jq_ '{k: j.get(k) for k in ("network", "environment", "unit", "tracker_on_chain", "features")}')
say "info: $summary"
[ "$(printf '%s' "$info" | jq_ 'j.get("environment") == "local" and j.get("network") == "valun-pilot-1" and j.get("tracker_on_chain") is False and "chain" not in j')" = true ] \
  || fail "the server does not say it is local with no chain (environment local, network valun-pilot-1, tracker_on_chain false, no chain)"
printf '%s' "$info" | jq_ 'j.get("environment_note", "")' | grep -q '^local: no chain' || fail "GET /pilot/v1/info has no environment_note saying local: no chain"
[ "$(printf '%s' "$info" | jq_ '"circulation/1" in (j.get("features") or [])')" = true ] \
  || fail "circulating credit is not on (no circulation/1 in GET /pilot/v1/info features): see the container's log for why (an unpinned tracker binary runs with circulation off)"

# 2. A fresh client home: point the released client at this server, join without an invite, take the tour.
export VALUN_HOME; VALUN_HOME=$(mktemp -d)
unset VALUN_PROFILE VALUN_SERVER
cleanup() { if [ "${KEEP:-0}" = 1 ]; then say "kept the client home $VALUN_HOME"; else rm -rf "$VALUN_HOME"; fi; }
trap cleanup EXIT
HANDLE="acc-$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
say "\$ valun config server $URL"
uvx --from "$CLIENT" valun config server "$URL" || fail "valun config server exited $?"
say "\$ valun join --sandbox --handle $HANDLE --operator 'local acceptance' --owner-token-file \$VALUN_HOME/owner-token.txt"
uvx --from "$CLIENT" valun join --sandbox --handle "$HANDLE" --operator "local acceptance" --owner-token-file "$VALUN_HOME/owner-token.txt" \
  || fail "valun join --sandbox exited $?"
say "\$ valun sandbox tour --yes"
set +e
timeout "$TOUR_S" uvx --from "$CLIENT" valun sandbox tour --yes 2>&1 | tee "$VALUN_HOME/tour.log"
code=${PIPESTATUS[0]}
set -e
[ "$code" = 0 ] || fail "valun sandbox tour --yes exited $code$([ "$code" = 124 ] && echo " (timed out after ${TOUR_S} s)")"
grep -q '^The tour is complete' "$VALUN_HOME/tour.log" || fail "the tour did not say it is complete"

# 3. The set-off, as the server's public API shows it: an applied loop with this participant among its members.
loops=$(curl -fsS -m 10 "$URL/pilot/v1/loops") || fail "GET /pilot/v1/loops failed"
mine=$(printf '%s' "$loops" | "$PY" -I -c '
import json, sys
handle, doc = sys.argv[1], json.load(sys.stdin)
for l in doc.get("loops", []):
    members = [m.get("handle", "?") for m in l.get("members", [])]
    if handle in members:
        print("%s applied %s: %s %s cancelled; members %s" % (l.get("id"), l.get("applied_at"), l.get("amount"), doc.get("unit", ""), ", ".join(members)))
' "$HANDLE")
[ -n "$mine" ] || fail "GET /pilot/v1/loops shows no set-off with $HANDLE in it"
say "set-offs with $HANDLE in them (GET /pilot/v1/loops):"
printf '%s\n' "$mine" | sed 's/^/  /'
say "PASS: $HANDLE joined with $CLIENT, completed the tour, and was in $(printf '%s\n' "$mine" | wc -l | tr -d ' ') applied set-off(s)"
