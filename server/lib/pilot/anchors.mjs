// The tracker's anchoring on Ergo testnet as this server can tell it (fix inbox #14 and the loop pages' explorer links):
// the tracker's state (GET /tracker/state: its local digest, the digest its confirmed tracker box commits, an update in
// flight) and the wallet adapter's spend ledger (ergo/wallet-shim.mjs writes a line for every transaction it signs, each
// tracker-box update with the time it signed it and the boxes it spends).
//
// The tracker box updater checks every BASIS_TRACKER_UPDATE_INTERVAL_SECONDS and posts a new box only when the state
// changed; a redemption does not change it (Basis records redemptions in the reserve box). So `anchored: false` with no
// update in flight is normal for up to one interval after a change. Longer than that (plus a grace for the node) is a
// fault, shown as state `overdue`.
//
// The confirmed box's age (fix inbox #62, boxWindows): what the tracker and the reserve contract allow depends on how
// many blocks old the confirmed tracker box is, counted from its creation height (the tracker's confirmed_height).
import fs from 'node:fs';
import {ANCHORED_NETTING} from './caps.mjs';

export const CHECK_INTERVAL_S = Number(process.env.BASIS_TRACKER_UPDATE_INTERVAL_SECONDS) || 1800;
export const OVERDUE_GRACE_S = 180;
// The owner's daily cap on tracker-box signatures (per UTC day), as the wallet adapter enforces it (ergo/chain.mjs
// DEFAULT_DAILY_TRACKER_SIGNATURES; test/anchoring.test.mjs checks they agree). Once it is used up the tracker posts no
// box until 00:00 UTC: GET /chain says so (state daily_cap_reached), not that the tracker failed.
export const DAILY_TRACKER_SIGNATURES = 50;
// A loop's set-off applied this soon before an update was signed may or may not be in it (the updater reads the digest a
// moment before it signs): such an update counts for the loop only while the tracker's state is anchored now.
export const LOOP_GUARD_MS = 15_000;
const HEX64 = /^[0-9a-f]{64}$/;

// The two windows of a tracker box's age, in blocks after its creation height H:
//   - from H + 1440 (ANCHORED_NETTING.fresh_blocks) the tracker refuses a set-off or debt transfer that lowers an edge
//     with an on-chain total (tracker v4.4 check_onchain_scope: age >= 1440, the age being the node's height minus H,
//     plus a block per 2 minutes since the updater last read it), until a newer box is posted; the updater refreshes an
//     unchanged box once it is 720 blocks old (keepalive_blocks), so this needs that many blocks without one;
//   - from H + 2161 the reserve contract lets a holder redeem without the tracker's signature: its emergency branch
//     takes a tracker box with HEIGHT - H > 2160 (TRACKER_LESS_AFTER_BLOCKS; Basis basis.es), HEIGHT being the height
//     of the block that includes the redemption.
export const TRACKER_LESS_AFTER_BLOCKS = 2160;
const block = h => (Number.isSafeInteger(h) && h > 0 ? h : null);
// {node_height, box_age_blocks, novations_refused_from_height, tracker_less_redemption_from_height} for a confirmed
// box made at `confirmedHeight`, the node's tip at `nodeHeight`: every field null when its input is unknown (not a
// positive whole number); box_age_blocks also when the node is behind the box (it cannot tell the age).
export function boxWindows(confirmedHeight, nodeHeight) {
  const h = block(confirmedHeight), n = block(nodeHeight);
  return {node_height: n, box_age_blocks: h !== null && n !== null && n >= h ? n - h : null,
    novations_refused_from_height: h === null ? null : h + ANCHORED_NETTING.fresh_blocks,
    tracker_less_redemption_from_height: h === null ? null : h + TRACKER_LESS_AFTER_BLOCKS + 1};
}

// The node's height, as ergo/chain.mjs height() and the tracker's updater read it: GET /info, fullHeight (the server
// does not load ergo/chain.mjs, which loads ergo-lib). null when the node does not answer within timeoutMs, or answers
// no positive whole number. A height read is kept NODE_HEIGHT_KEEP_MS per node (a block comes about every 2 minutes),
// so box_age_blocks may be one block behind; a failed read is kept NODE_HEIGHT_FAILED_KEEP_MS. Both count from when the
// read ended (`clock` read again then: a node that hangs takes timeoutMs of it), and calls made while a read of the
// node is under way share it, so a node that is down or hangs costs GET /chain one wait of timeoutMs at most once per
// NODE_HEIGHT_FAILED_KEEP_MS after the last one ended, whatever the number of readers.
export const NODE_HEIGHT_KEEP_MS = 20_000, NODE_HEIGHT_FAILED_KEEP_MS = 5_000;
const heights = new Map(), reading = new Map();
export async function nodeHeight(node, {fetchFn = fetch, timeoutMs = 4000, clock = Date.now} = {}) {
  if (typeof node !== 'string' || !/^https?:\/\//.test(node)) return null;
  const kept = heights.get(node), now = clock();
  if (kept && now >= kept.at && now - kept.at < (kept.height === null ? NODE_HEIGHT_FAILED_KEEP_MS : NODE_HEIGHT_KEEP_MS)) return kept.height;
  if (reading.has(node)) return reading.get(node);
  const read = (async () => {
    let height = null;
    try {
      const r = await fetchFn(`${node.replace(/\/+$/, '')}/info`, {signal: AbortSignal.timeout(timeoutMs)});
      if (r.ok) height = block((await r.json())?.fullHeight);
    } catch { /* the node did not answer: null */ }
    heights.set(node, {at: clock(), height});
    return height;
  })();
  reading.set(node, read);
  try { return await read; } finally { if (reading.get(node) === read) reading.delete(node); }
}

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
  cache = {file, size: st.size, mtimeMs: st.mtimeMs, rows, all};
  return rows;
}

// The owner's daily cap as it stands at `now`: the tracker-box signatures of this UTC day (every one the adapter
// recorded, as it counts them), the limit, and when the day ends (when a used-up cap resets).
export function dailyCap(file, now = Date.now(), limit = DAILY_TRACKER_SIGNATURES) {
  trackerBoxUpdates(file);
  const day = new Date(now).toISOString().slice(0, 10);
  const signed = (cache && cache.file === file ? cache.all : []).filter(u => new Date(u.t).toISOString().slice(0, 10) === day).length;
  const resets = new Date(`${day}T00:00:00.000Z`).getTime() + 864e5;
  return {limit, signed_today: signed, used_up: signed >= limit, resets_at: new Date(resets).toISOString()};
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

// How long the tracker trusts its last observation of its box on chain for a novation that lowers an edge with an
// on-chain total: tracker v4.4 check_onchain_scope refuses one with ANCHOR_UNOBSERVED when the observation is older
// (basis_store ANCHOR_OBSERVATION_MAX_AGE_MS; its GET /capabilities anchored_netting.observation_max_age_ms, which
// caps.mjs does not require). The updater observes the box on each update check in which it reads the box and the
// node's height and no update of its own is waiting to confirm.
export const TRACKER_OBSERVATION_MAX_AGE_MS = 2 * 3600 * 1000;
// The anchored state's what_this_means (fix inbox #62): what the box commits holds whatever its age; what the tracker
// still accepts on top depends on it (boxWindows) and on more than it, so the text names the fields that say the age,
// and says a novation may still be refused sooner (check_onchain_scope's observation, check_authorization_floor).
export const ANCHORED_MEANS = `The tracker box on Ergo testnet commits the tracker's current state: every note recorded so far can be redeemed against its issuer's tERG reserve (if the issuer posted one), and every netting so far is committed (it stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model). The tracker builds a redemption only while its records of what the box commits agree with the box. A set-off or debt transfer that lowers an edge with an on-chain total needs the box fresh, younger than ${ANCHORED_NETTING.fresh_blocks} blocks (box_age_blocks): the tracker refreshes an unchanged box every ${ANCHORED_NETTING.keepalive_blocks} blocks to keep it so, and refuses such a novation from novations_refused_from_height until the next box. It may refuse one sooner: when it has not observed its box on chain for ${TRACKER_OBSERVATION_MAX_AGE_MS / 3_600_000} hours (it observes it on each update check in which it can read the box and the node and no update is waiting to confirm), and when the novation would lower the edge below a total it signed a redemption for. From tracker_less_redemption_from_height (${TRACKER_LESS_AFTER_BLOCKS + 1} blocks after the box was made) the reserve contract lets a holder redeem without the tracker's signature.`;
// The update that committed a set-off applied at `appliedAt` on chain: the first confirmed update signed more than
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

// What a committed netting guarantees (skill.md, Trust model; fix inbox #85, #100): a netting revokes nothing on chain,
// so a lowered total stays committed only as long as the tracker key never commits an earlier total again. Every anchoring
// state that speaks of nettings says so; none calls them final.
export const NETTING_FINALITY = 'it stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model';
// How long a tracker box waits for an Ergo testnet block, as every text of this server says it (the site's redesign,
// round 2: one wording everywhere, and no date in a server's text). The muse report's replay of the Nov 16-17 blocks, from
// an IOU to its confirmed box: a median of 5 to 7 minutes, the longest at least 21, while testnet blocks were slow.
export const BLOCK_WAIT = 'usually within minutes, up to about 30 when Ergo testnet blocks are slow';

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
  // The anchoring state GET /chain shows, with what it means for a creditor who wants to redeem. `cap`: the owner's
  // daily cap as dailyCap() gives it (none: not known, as before).
  state(st, cap = null) {
    const since = this.observe(st);
    if (!st) return {state: 'unknown', what_this_means: 'The tracker\'s state could not be read just now; try again in a minute.'};
    const n = CHECK_INTERVAL_S;
    if (isAnchored(st)) return {state: 'anchored', what_this_means: ANCHORED_MEANS};
    if (st.pending_tx_id) {
      return {state: 'update_in_flight', what_this_means: `The tracker posted a new tracker box (pending_tx_id): once a block includes it (${BLOCK_WAIT}), the notes recorded before it can be redeemed and the nettings before it are committed (${NETTING_FINALITY}).`};
    }
    if (cap?.used_up) {
      return {state: 'daily_cap_reached', ...(since !== null ? {unanchored_since: new Date(since).toISOString()} : {}), resumes_at: cap.resets_at,
        what_this_means: `The tracker's state changed since its last tracker box, and the operator's daily cap of ${cap.limit} tracker boxes (per UTC day) is used up: the next box is posted after ${cap.resets_at} (within ${Math.round(n / 60) + 3} minutes of it). This is a limit the operator set, not a fault. Nothing is lost: once a block includes that box (${BLOCK_WAIT}), the notes recorded since the last box can be redeemed, and the nettings since then are committed (${NETTING_FINALITY}).`};
    }
    const overdue = since !== null && this.now() - since > (n + OVERDUE_GRACE_S) * 1000;
    if (overdue) {
      return {state: 'overdue', unanchored_since: new Date(since).toISOString(),
        what_this_means: `The tracker's state changed and no new tracker box has been posted for more than ${Math.round((n + OVERDUE_GRACE_S) / 60)} minutes: that is a fault of the tracker, not of your note. Until it is fixed, the notes recorded since its last box cannot be redeemed, and the nettings since then are not committed on chain.`};
    }
    return {state: 'waiting_for_next_update', ...(since !== null ? {unanchored_since: new Date(since).toISOString()} : {}),
      what_this_means: `The tracker's state changed since its last tracker box. The tracker checks every ${n} seconds and posts a new box when its state changed; once a block includes that box (${BLOCK_WAIT}), the notes recorded since its last box can be redeemed, and the nettings since then are committed (${NETTING_FINALITY}).`};
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
