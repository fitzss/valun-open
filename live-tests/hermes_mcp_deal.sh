#!/bin/bash
# Live test: a Hermes agent with NO Valun plugin, reaching Valun only through the MCP server (`valun mcp`,
# toolset mcp-valun), makes a deal with bea-briefs. Local model, synthetic PC. Every decision is the agent's own;
# this script only decides WHEN it runs a session (when its inbox has something). Stops when the deal ends.
# Usage: hermes_mcp_deal.sh <hermes_home> <owner_token_file> <run_dir> [max_sessions] [max_minutes]
set -u
HOME_W=$1; OWNER=$2; RUN=$3; MAX_SESSIONS=${4:-6}; MAX_MIN=${5:-30}
HERMES=${HERMES_BIN:-hermes}          # the Hermes executable (set HERMES_BIN if it is not on PATH)
mkdir -p "$RUN"; LOG=$RUN/orchestrator.log
FIRST=${FIRST:-"Check your Valun status and the directory. I'd like to buy a short research brief (300-500 words, at least 3 linked sources) on how small businesses use trade credit (net-30 terms), for at most 15 PC. Record that limit, then make the offer to a participant who sells briefs."}
NEXT="Check your Valun inbox and act on what is waiting. Counter-offers: accept if the price is within my limit of 15 PC (pass expected_terms_hash), otherwise counter. Deliveries: read them with valun_deal, look at the measurements against the agreed terms, then accept if they meet the terms or dispute with a one-sentence reason. Finish with a 3-line summary."
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
session() {
  local out=$RUN/s$1.txt t=$(date +%s)
  printf '### prompt: %s\n' "$2" > "$out"
  log "session $1 start"
  HERMES_HOME="$HOME_W" PYTHONDONTWRITEBYTECODE=1 timeout 1500 "$HERMES" chat -q "$2" -t "${TOOLSET:-mcp-valun}" --max-turns 20 -Q >> "$out" 2>&1
  local rc=$?; echo "### exit $rc after $(( $(date +%s) - t ))s" >> "$out"; log "session $1 done: exit $rc, $(( $(date +%s) - t )) s"
}
state() {
  TOKFILE=$OWNER node -e '
    const t = require("fs").readFileSync(process.env.TOKFILE, "utf8").trim();
    fetch("https://valun-desk.fly.dev/pilot/v1/owner", {headers: {authorization: "Bearer " + t}, signal: AbortSignal.timeout(30000)})
      .then(r => r.json()).then(o => { const i = o.inbox || {};
        const d = (o.deals || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        console.log(((i.respond || []).length + (i.review_delivery || []).length) + " " + (d ? d.status : "none") + " " + (d ? d.id : "-")); })
      .catch(() => console.log("0 unknown -"));' 2>/dev/null
}
read -r _ before_status before_id < <(state)
log "start (newest deal before: $before_id $before_status)"
start=$(date +%s); end=$(( start + MAX_MIN * 60 )); n=1
session 1 "$FIRST"
last=""
while [ "$(date +%s)" -lt "$end" ]; do
  read -r need st id < <(state)
  [ "$id" = "$before_id" ] && { log "no new deal after the first session: stop"; break; }
  [ "$st $id" != "$last" ] && log "deal $id: $st (items waiting: $need)" && last="$st $id"
  case "$st" in note_issued|paid|disputed|declined|withdrawn|expired|rejected_by_owner|cancelled|note_failed|payment_failed)
    log "deal ended: $st"; break ;; esac
  if [ "${need:-0}" -gt 0 ]; then
    [ "$n" -ge "$MAX_SESSIONS" ] && { log "session limit: stop"; break; }
    n=$((n + 1)); session "$n" "$NEXT"
  else
    sleep 20
  fi
done
log "stop after $n session(s), $(( ($(date +%s) - start) / 60 )) min"
