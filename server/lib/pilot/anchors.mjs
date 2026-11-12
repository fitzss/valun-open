// The tracker's anchoring on Ergo testnet as this server can tell it (fix inbox #14 and the loop pages' explorer links):
// the tracker's state (GET /tracker/state: its local digest, the digest its confirmed tracker box commits, an update in
// flight) and the wallet adapter's spend ledger (ergo/wallet-shim.mjs writes a line for every transaction it signs, each
// tracker-box update with the time it signed it and the boxes it spends).
//
// The tracker box updater checks every BASIS_TRACKER_UPDATE_INTERVAL_SECONDS and posts a new box only when the state
// changed; a redemption does not change it (Basis records redemptions in the reserve box). So `anchored: false` with no
// update in flight is normal for up to one interval after a change. Longer than that (plus a grace for the node) is a
// fault, shown as state `overdue`.
import fs from 'node:fs';

export const CHECK_INTERVAL_S = Number(process.env.BASIS_TRACKER_UPDATE_INTERVAL_SECONDS) || 1800;
export const OVERDUE_GRACE_S = 180;
// A loop's set-off applied this soon before an update was signed may or may not be in it (the updater reads the digest a
// moment before it signs): such an update counts for the loop only while the tracker's state is anchored now.
export const LOOP_GUARD_MS = 15_000;
const HEX64 = /^[0-9a-f]{64}$/;

let cache = null;
// The tracker-box updates in the spend ledger, in the order they were signed: [{t (ms), tx_id, input}] where input is
// the tracker box the update spends. An update followed by another that spends the same tracker box was dropped and
// replaced (the updater resubmits): it is left out. Read again only when the file changed.
export function trackerBoxUpdates(file) {
  if (!file) return [];
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (cache && cache.file === file && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.rows;
  const all = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r?.t);
    if (r?.kind !== 'tracker_box' || !HEX64.test(String(r.tx_id)) || !Number.isFinite(t)) continue;
    all.push({t, tx_id: r.tx_id, input: Array.isArray(r.inputs) && HEX64.test(String(r.inputs[0])) ? r.inputs[0] : null});
  }
  const rows = all.filter((u, i) => !(all[i + 1] && u.input && all[i + 1].input === u.input));
  cache = {file, size: st.size, mtimeMs: st.mtimeMs, rows};
  return rows;
}

// The confirmed updates: every update but the one in flight (the updater posts the next only after the previous one
// confirmed); with `confirmedTx` (the transaction that made the tracker's confirmed box, read from the node) exactly the
// updates up to it.
export function confirmedUpdates(rows, st, confirmedTx = null) {
  if (confirmedTx) {
    const i = rows.findIndex(u => u.tx_id === confirmedTx);
    if (i >= 0) return rows.slice(0, i + 1);
  }
  const pending = st?.pending_tx_id ?? null;
  return rows.filter(u => u.tx_id !== pending);
}

export const isAnchored = st => !!st?.confirmed_digest && st.confirmed_digest === st.local_digest;

// The update that made a set-off applied at `appliedAt` final on chain: the first confirmed update signed more than
// LOOP_GUARD_MS after it; one signed within that time only if it is the last confirmed one and the state is anchored now
// (then that box commits the current state, the set-off included). null while none has.
export function loopAnchor(appliedAt, confirmed, st) {
  const at = Date.parse(appliedAt);
  if (!Number.isFinite(at)) return null;
  const near = confirmed.find(u => u.t > at);
  if (!near) return null;
  if (near.t - at > LOOP_GUARD_MS) return near;
  if (near === confirmed.at(-1) && isAnchored(st)) return near;
  return confirmed.find(u => u.t - at > LOOP_GUARD_MS) ?? null;
}

// Since when the tracker's state has differed from its confirmed box with no update in flight (in this process: a poll
// and every GET /chain observe it). null while it is anchored or an update is in flight.
export class AnchorWatch {
  constructor({now = () => Date.now()} = {}) { this.now = now; this.since = null; }
  observe(st) {
    if (!st) return this.since;
    if (isAnchored(st) || st.pending_tx_id) this.since = null;
    else this.since ??= this.now();
    return this.since;
  }
  // The anchoring state GET /chain shows, with what it means for a creditor who wants to redeem.
  state(st) {
    const since = this.observe(st);
    if (!st) return {state: 'unknown', what_this_means: 'The tracker\'s state could not be read just now; try again in a minute.'};
    const n = CHECK_INTERVAL_S;
    if (isAnchored(st)) {
      return {state: 'anchored', what_this_means: 'The tracker box on Ergo testnet commits the tracker\'s current state: every note recorded so far can be redeemed, and every netting so far is final.'};
    }
    if (st.pending_tx_id) {
      return {state: 'update_in_flight', what_this_means: 'The tracker posted a new tracker box (pending_tx_id): once a block includes it, in about two minutes, the notes recorded before it can be redeemed and the nettings before it are final.'};
    }
    const overdue = since !== null && this.now() - since > (n + OVERDUE_GRACE_S) * 1000;
    if (overdue) {
      return {state: 'overdue', unanchored_since: new Date(since).toISOString(),
        what_this_means: `The tracker's state changed and no new tracker box has been posted for more than ${Math.round((n + OVERDUE_GRACE_S) / 60)} minutes: that is a fault of the tracker, not of your note. Notes recorded since its last box cannot be redeemed until it is fixed.`};
    }
    return {state: 'waiting_for_next_update', ...(since !== null ? {unanchored_since: new Date(since).toISOString()} : {}),
      what_this_means: `The tracker's state changed since its last tracker box. The tracker checks every ${n} seconds and posts a new box when its state changed; the notes recorded since its last box can be redeemed, and the nettings since then are final, once that box is confirmed (normally within ${Math.round(n / 60) + 3} minutes).`};
  }
}

// The transaction that made a box, read once from the node (GET /utxo/byId/<box>: the confirmed tracker box is unspent
// while it is the confirmed one); null when the node does not answer. Cached per box id.
const boxTx = new Map();
export async function creatingTx(node, boxId, {fetchFn = fetch, timeoutMs = 4000} = {}) {
  if (!node || !HEX64.test(String(boxId))) return null;
  if (boxTx.has(boxId)) return boxTx.get(boxId);
  try {
    const r = await fetchFn(`${node}/utxo/byId/${boxId}`, {signal: AbortSignal.timeout(timeoutMs)});
    if (!r.ok) return null;
    const j = await r.json();
    const tx = HEX64.test(String(j?.transactionId)) ? j.transactionId : null;
    if (tx) boxTx.set(boxId, tx);
    return tx;
  } catch { return null; }
}
