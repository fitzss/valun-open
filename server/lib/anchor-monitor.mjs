// The own-edge monitor (fix inbox #62, the rules of step 6d as a pure module): what a participant's own records say about
// the tracker boxes anchored on chain, edge by edge. The anchor audit (scripts/ops/anchor-audit.mjs) shows that a box
// commits exactly the notes the operator publishes; it cannot show that those notes are right. An operator that lowers
// a creditor's edge in its own records, anchors that tree and publishes the same rows passes the audit. Only a party to
// the edge can tell, with the signed states it holds: this module is that check. Pure: no I/O, no clock (the caller
// gives now_ms); it imports lib/avl.mjs only, to check that each snapshot is the tree its box commits. It never throws
// for what it is given: what it cannot read is an unknown alarm.
//
// monitor({keys, snapshots, states, consents, now_ms, anchoring}) -> {ok, alarms, warnings, edges, snapshots}
//   keys       every public key the participant has or had (current, earlier, derived): its edges are every edge one of
//              them issues or receives.
//   snapshots  anchored snapshots, each {box_id, height, digest, rows}: rows are every note the box at that creation
//              height commits ({issuer_pubkey, recipient_pubkey, denomination ('erg' when absent), total}, or the rows
//              of GET /pilot/v1/ledger/committed as it serves them, with committed_total), and digest is R5's
//              digest as the caller read it from a chain source of its own. A snapshot whose rows do not give its digest
//              (lib/avl.mjs), and every snapshot of a height or box another one contradicts, is not used: an unknown
//              alarm. Any order; they are read in ascending height.
//   states     edge states whose issuer signature the caller verified, each {issuer_pubkey, recipient_pubkey,
//              denomination, total, timestamp, signature, anchored}: as creditor, the states of its incoming edges (the
//              issuer's signatures, from GET /edges); as issuer, the states it signed on its outgoing edges. signature
//              null or absent is a state whose signature was pruned; anchored {box_id, height}, when the participant saw
//              the state anchored before (its retained anchored state, step 6c): the check of the edge starts there.
//              A timestamp is whole milliseconds from 0 to MAX_TIMESTAMP_MS (JavaScript's Date range).
//   consents   the novations the participant signed, each with its whole package: {kind: 'setoff' | 'transfer', id,
//              edges: [{issuer_pubkey, recipient_pubkey, denomination, before_total, total, timestamp}]}, before_total
//              the edge's total the novation started from (the prior state its members acknowledged) and total the one
//              it leaves. Those that applied or may still apply: one the server reports expired or refused never
//              applied, and its new state would read as not anchored yet for good (a decrease it would explain is then
//              unconsented, which is right).
//   now_ms     the time, for the lag of states not yet anchored; anchoring: GET /pilot/v1/chain's anchoring
//              ({check_interval_seconds, daily_cap {limit, signed_today, resets_at}}), when known. Both are the
//              operator's word, so neither can delay overdue past what the network allows: the interval counts up to
//              DEFAULT_CHECK_INTERVAL_S at most, and a cap reset up to a day after the state at most (the cap is per
//              UTC day, so a state signed while it was used up is due by the reset after it).
// Totals are decimal strings, BigInts or safe integers in [0, 2^64), as lib/avl.mjs takes them; in what it returns they
// are decimal strings. It returns ok (no alarm, and at least one snapshot checked), the alarms and warnings below
// (each naming its edge, box id and height), every edge of the participant's with its status in the newest snapshot
// (anchored: the box holds its latest state's total; not_yet_anchored: an earlier state since the one read before;
// alarm; differs_in_your_favour: an earlier state or no row where that is no loss to the participant, which the other
// party's monitor raises; unchecked: no snapshot), and which snapshots were used.
//
// Reading a box. Each edge's states, with the new state of every consent on it, form its timeline in timestamp order (a
// tracker edge's timestamps strictly increase), starting from the edge absent. A box commits an edge's total, not which
// state it is. Snapshot by snapshot, its total is read against the states at or after the one read last: a box commits
// states in the order the edge took them and may lag behind the latest, so it is at one of them unless the operator
// reverted or changed the edge. Where several of those states share the total, the box may be at any of them: nothing
// is concluded that depends on which, and the next read starts from the earliest. The edge's first read starts at its
// retained anchored state, if any. Rules, per role:
//   As creditor (the edge's recipient is a key of the participant):
//     A step of the timeline to a lower total is consented when a set-off or transfer the participant signed has that
//     new state and started from a total at least the state before it (a novation applies to the prior state its
//     members acknowledged: a higher before_total is notes the participant had not synced, and nothing in between can be
//     lower, since every decrease of its incoming edges needs its signature).
//     - decrease_without_your_consent: the box's total is a state since the one read last, reached through a step down
//       that is not consented; or it is below every state the edge may hold now (each state since the one read last, up
//       to the first such step), or no row while all of those are above 0. It cites the participant's state before the
//       decrease, or that lowest state (total, timestamp, signature), the box id and the height.
//     - unknown: the box's total is no state since the one read last and not below them all, which either a state the
//       participant has not synced or a change of the operator's explains: no state of its own (state_not_held: a note
//       it has not synced, or a total its issuer never signed), or an earlier, superseded state below its latest
//       (superseded_state: such a note, or a revert); or a state whose signature it no longer holds (signature_missing).
//     - an earlier, superseded state at or above its latest is in its favour: no alarm (its issuer's monitor raises it).
//   As issuer (the edge's issuer is a key of the participant; every state of the edge is one it signed):
//     - reverted_to_superseded_state: the box's total is an earlier state of the edge, superseded by the one read last,
//       above the lowest state it may still lag at (one since the one read last, the latest included), with no new note
//       of that total: the earlier, higher signature can redeem more than it owes.
//     - above_your_signed_state: the box's total is no state it signed and is above its latest signed state.
//     - unknown: the box's total is no state it signed, at or below its latest (its records may be incomplete, or the
//       operator committed a total nobody signed).
//     - an earlier state at or below every state it may lag at, or no row, is in the issuer's favour: no alarm (the
//       creditor's monitor raises it).
//   Packages (across the participant's edges). A novation is applied on an edge in a box when the box's total is the
//   novation's new total or a later state's, and no earlier state since the one read last; not applied when it is
//   neither (an earlier state since then: not anchored yet; or no state since the novation); undecided when both fit.
//   A package is read from the first box that shows it on chain until a box shows it whole; what a later box does to one
//   of its edges is that edge's alarm (a revert, a decrease).
//     - partial_setoff: in a box where an incoming edge of the participant's is applied, an outgoing one of the same
//       set-off is not and the box holds it above the total the set-off leaves (its net across the package did not move
//       by zero in that anchor). A set-off whose package is not net-neutral for the participant is an unreadable record.
//     - partial_transfer: a debt transfer the participant signed is anchored in part: as the issuer A, A>C applied while
//       A>B is not and is held above the total the transfer leaves (A owes the amount twice on chain); as the old
//       creditor B, A>B applied while A>C has no row (the transfer writes that row, and a set-off never removes one:
//       B's payment is not on chain). As B, A>C at exactly the total the transfer raised it from is unknown
//       (transfer_unconfirmed): B cannot tell a transfer anchored in part from a set-off of C's that lowered A>C again.
//   Missing data is an alarm, never a pass (unknown): no snapshot to check, a snapshot that is not its box's tree, a
//   record that cannot be read, two states of one edge at one timestamp with different totals.
//   Lag is a warning, not an alarm: not_yet_anchored, for an edge with no alarm whose latest state's total the newest
//   box does not hold, with overdue true once now_ms is past the latest state's timestamp (or, while the operator's
//   daily cap of tracker boxes is used up, past its reset) plus the updater's interval and ANCHOR_GRACE_MS. While a
//   decrease is not anchored, the earlier, higher total is what the chain commits: the warning says so.
// What it cannot see: anchors between two snapshots it is given, a box whose snapshot was never published, an edge
// changed and changed back between two anchors, a re-commit of an earlier state whose total a later state shares, and
// anything about edges none of the keys is party to. Without a retained anchored state (or an earlier snapshot), an edge
// lowered or dropped before the first snapshot it is given reads as not anchored yet (or unknown), told from lag only
// by overdue: keeping the state last seen anchored is what makes the first check decisive.
import {AvlError, digest} from './avl.mjs';

export const ALARMS = Object.freeze(['decrease_without_your_consent', 'partial_setoff', 'partial_transfer', 'reverted_to_superseded_state',
  'above_your_signed_state', 'unknown']);
export const WARNINGS = Object.freeze(['not_yet_anchored']);
export const ANCHOR_GRACE_MS = 180_000;              // lib/pilot/anchors.mjs OVERDUE_GRACE_S: the node's grace
export const DEFAULT_CHECK_INTERVAL_S = 300;         // the testnet updater's interval (GET /chain check_interval_seconds)
export const MAX_TIMESTAMP_MS = 8.64e15;             // the last time JavaScript's Date can hold
const DAY_MS = 86_400_000;

const PUBKEY = /^0[23][0-9a-f]{64}$/, DENOMINATION = /^(erg|token:[0-9a-f]{64})$/, HEX64 = /^[0-9a-f]{64}$/, HEX66 = /^[0-9a-f]{66}$/, DIGITS = /^(0|[1-9][0-9]{0,19})$/;
const U64_END = 1n << 64n;
const ABSENT = null;                                  // an edge with no row: no note in the tree

// A total as lib/avl.mjs takes one, as a BigInt; null when it is not one.
function amount(v) {
  let t = null;
  if (typeof v === 'bigint') t = v;
  else if (typeof v === 'string' && DIGITS.test(v)) t = BigInt(v);
  else if (Number.isSafeInteger(v)) t = BigInt(v);
  return t !== null && t >= 0n && t < U64_END ? t : null;
}
const isTimestamp = t => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIMESTAMP_MS;
const iso = ms => (Number.isFinite(ms) && Math.abs(ms) <= MAX_TIMESTAMP_MS ? new Date(ms).toISOString() : null);
const edgeId = (i, r, d) => `${i}>${r}>${d}`;
const edgeOf = id => { const [issuer_pubkey, recipient_pubkey, denomination] = id.split('>'); return {issuer_pubkey, recipient_pubkey, denomination}; };
const str = t => (t === ABSENT ? null : String(t));
const value = t => (t === ABSENT ? 0n : t);           // no row: nothing owed
const stateOut = s => (s && s.total !== ABSENT ? {total: String(s.total), timestamp: s.timestamp, signature: s.signature} : null);
const edgeKeys = (x, where) => {
  const d = x?.denomination ?? 'erg';
  if (!PUBKEY.test(String(x?.issuer_pubkey)) || !PUBKEY.test(String(x?.recipient_pubkey)) || typeof d !== 'string' || !DENOMINATION.test(d)) {
    throw new Error(`${where}: issuer_pubkey and recipient_pubkey must be compressed public keys and denomination erg or token:<id>`);
  }
  return edgeId(x.issuer_pubkey, x.recipient_pubkey, d);
};

/** The monitor's verdict on the participant's edges (the module comment says what each part is). */
export function monitor({keys, snapshots, states = [], consents = [], now_ms = null, anchoring = null} = {}) {
  const alarms = [], warnings = [], alarmed = new Set();      // alarmed: the ids of the edges an alarm names
  const unknown = (cause, message, extra = {}) => {
    if (extra.edge) alarmed.add(edgeId(extra.edge.issuer_pubkey, extra.edge.recipient_pubkey, extra.edge.denomination));
    alarms.push({alarm: 'unknown', cause, message, ...extra});
  };
  const mine = new Set((Array.isArray(keys) ? keys : []).filter(k => PUBKEY.test(String(k))));
  const result = (verified, latest, edges) => ({ok: alarms.length === 0 && verified > 0, alarms, warnings, edges,
    snapshots: {given: Array.isArray(snapshots) ? snapshots.length : 0, verified, latest}});
  if (!mine.size) {
    unknown('keys_missing', 'no public key of yours was given: there are no edges to check');
    return result(0, null, []);
  }
  if (keys.some(k => !PUBKEY.test(String(k)))) unknown('record_unreadable', 'some of the keys given are not compressed public keys: edges of theirs are not checked');

  // Snapshots: only those whose rows give their digest, and that no other snapshot contradicts.
  const snaps = [];
  (Array.isArray(snapshots) ? snapshots : []).forEach((s, i) => {
    const where = `snapshot ${i}${s && HEX64.test(String(s.box_id)) ? ` (box ${s.box_id})` : ''}`;
    if (s === null || typeof s !== 'object' || !HEX64.test(String(s.box_id)) || !Number.isSafeInteger(s.height) || s.height < 0 || !HEX66.test(String(s.digest)) || !Array.isArray(s.rows)) {
      return unknown('snapshot_unreadable', `${where} is not {box_id, height, digest, rows}: it is not used`);
    }
    // Rows with total, or with committed_total as GET /ledger/committed serves them (a row with both is unreadable).
    if (s.rows.some(r => r && typeof r === 'object' && r.total !== undefined && r.committed_total !== undefined)) {
      return unknown('snapshot_unreadable', `${where}: a row has both total and committed_total: it is not used`, {box_id: s.box_id, height: s.height});
    }
    const rows = s.rows.map(r => (r && typeof r === 'object' && r.total === undefined ? {...r, total: r.committed_total} : r));
    let d;
    try { d = digest(rows); } catch (e) {
      if (!(e instanceof AvlError)) throw e;
      return unknown('snapshot_unverified', `${where}: its rows cannot be digested (${e.message}), so they cannot be its box's tree: it is not used`, {box_id: s.box_id, height: s.height});
    }
    if (d !== s.digest) return unknown('snapshot_unverified', `${where}: its rows give digest ${d}, not ${s.digest}, the R5 digest given for it: it is not used`, {box_id: s.box_id, height: s.height});
    const totals = new Map();
    for (const r of rows) totals.set(edgeId(r.issuer_pubkey, r.recipient_pubkey, r.denomination ?? 'erg'), amount(r.total));
    snaps.push({box_id: s.box_id, height: s.height, digest: s.digest, totals});
  });
  const byHeight = new Map(), byBox = new Map();
  for (const s of snaps) {
    (byHeight.get(s.height) || byHeight.set(s.height, []).get(s.height)).push(s);
    (byBox.get(s.box_id) || byBox.set(s.box_id, []).get(s.box_id)).push(s);
  }
  const conflicted = new Set();
  for (const group of [...byHeight.values(), ...byBox.values()]) {
    const first = group[0];
    if (group.some(s => s.box_id !== first.box_id || s.height !== first.height || s.digest !== first.digest)) for (const s of group) conflicted.add(s);
  }
  for (const s of conflicted) unknown('snapshot_conflict', `the snapshot of box ${s.box_id} at height ${s.height} contradicts another one given (one box per height, one height per box): neither is used`, {box_id: s.box_id, height: s.height});
  const seen = new Set();
  const chain = snaps.filter(s => !conflicted.has(s) && !seen.has(s.box_id) && seen.add(s.box_id)).sort((a, b) => a.height - b.height);
  const latest = chain.length ? {box_id: chain.at(-1).box_id, height: chain.at(-1).height} : null;
  if (!chain.length) unknown('no_snapshot', 'no anchored snapshot could be checked against your records: nothing is shown to be anchored');

  // The timelines: every state and consented new state of the participant's edges, by edge. A consent on an entry
  // keeps its id and the total its novation started from (before).
  const timelines = new Map();
  const entryOf = (id, total, timestamp) => {
    let t = timelines.get(id);
    if (!t) timelines.set(id, t = []);
    let e = t.find(x => x.timestamp === timestamp && x.total === total);
    if (!e) t.push(e = {total, timestamp, signature: null, anchored: null, consents: [], conflict: false});
    return e;
  };
  const party = id => { const e = edgeOf(id); return mine.has(e.issuer_pubkey) || mine.has(e.recipient_pubkey); };
  (Array.isArray(states) ? states : []).forEach((s, i) => {
    let id;
    try { id = edgeKeys(s, `state ${i}`); } catch (e) { return unknown('record_unreadable', `${e.message}: the state is not used`); }
    if (!party(id)) return;
    const total = amount(s.total);
    if (total === null || !isTimestamp(s.timestamp)) return unknown('record_unreadable', `state ${i} of ${id}: its total or timestamp is not a whole number (a timestamp within JavaScript's Date range): the state is not used`, {edge: edgeOf(id)});
    const e = entryOf(id, total, s.timestamp);
    if (typeof s.signature === 'string' && s.signature) e.signature = s.signature;
    const a = s.anchored;
    if (a && HEX64.test(String(a.box_id)) && Number.isSafeInteger(a.height) && (!e.anchored || a.height > e.anchored.height)) e.anchored = {box_id: a.box_id, height: a.height};
  });
  const packages = [];
  (Array.isArray(consents) ? consents : []).forEach((c, i) => {
    const where = `consent ${typeof c?.id === 'string' ? c.id : i}`;
    if (c === null || typeof c !== 'object' || (c.kind !== 'setoff' && c.kind !== 'transfer') || !Array.isArray(c.edges) || !c.edges.length) {
      return unknown('consent_unreadable', `${where} is not {kind: setoff or transfer, id, edges}: it is not used`);
    }
    const edges = [];
    for (const [j, x] of c.edges.entries()) {
      let id;
      try { id = edgeKeys(x, `${where} edge ${j}`); } catch (e) { return unknown('consent_unreadable', `${e.message}: the consent is not used`); }
      const before = amount(x.before_total), total = amount(x.total);
      if (before === null || total === null || !isTimestamp(x.timestamp)) return unknown('consent_unreadable', `${where} edge ${j}: before_total, total and timestamp must be whole numbers (a timestamp within JavaScript's Date range): the consent is not used`);
      edges.push({id, before, total, timestamp: x.timestamp});
    }
    const ins = edges.filter(x => mine.has(edgeOf(x.id).recipient_pubkey)), outs = edges.filter(x => mine.has(edgeOf(x.id).issuer_pubkey));
    if (!ins.length && !outs.length) return unknown('consent_unreadable', `${where} changes none of your edges: it is not used`);
    if (c.kind === 'setoff') {
      if (edges.some(x => x.total > x.before)) return unknown('consent_unreadable', `${where}: a set-off only lowers edges, and this one raises one: it is not used`);
      const fall = list => list.reduce((s, x) => s + (x.before - x.total), 0n);
      if (fall(ins) !== fall(outs)) return unknown('consent_unreadable', `${where}: your incoming edges fall by ${fall(ins)} and your outgoing ones by ${fall(outs)}, so it is not the net-neutral set-off you would have signed: it is not used`);
      if (ins.length && !outs.length) return unknown('consent_unreadable', `${where} lowers an incoming edge of yours and none of your outgoing ones (are all your keys given?): it is not used`);
    } else {
      const low = edges.find(x => x.total < x.before), high = edges.find(x => x.total > x.before);
      const ok = edges.length === 2 && low && high && low.id !== high.id && edgeOf(low.id).issuer_pubkey === edgeOf(high.id).issuer_pubkey
        && edgeOf(low.id).denomination === edgeOf(high.id).denomination && low.before - low.total === high.total - high.before;
      if (!ok) return unknown('consent_unreadable', `${where}: a debt transfer lowers one edge of an issuer and raises another of the same issuer by the same amount, and this one does not: it is not used`);
    }
    for (const x of edges) if (party(x.id)) entryOf(x.id, x.total, x.timestamp).consents.push({id: c.id ?? where, before: x.before});
    packages.push({kind: c.kind, id: c.id ?? where, edges});
  });
  for (const [id, t] of timelines) {
    t.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < t.length; i++) {
      if (t[i].timestamp === t[i - 1].timestamp) {
        t[i].conflict = t[i - 1].conflict = true;
        unknown('record_conflict', `${id}: two states at timestamp ${t[i].timestamp} with totals ${t[i - 1].total} and ${t[i].total} (an edge's timestamps strictly increase): neither is used`, {edge: edgeOf(id)});
      }
    }
    timelines.set(id, t.filter(x => !x.conflict));
  }
  // Every edge of the participant's: in its records or in a snapshot.
  for (const s of chain) for (const id of s.totals.keys()) if (party(id) && !timelines.has(id)) timelines.set(id, []);

  // Each edge's reads, box by box (the module comment, "Reading a box"). m[k] is the read of chain[k]: the box's total
  // a, the state the read started from (pos), and the first and last state since then with that total (null: none).
  const matched = new Map();
  for (const [id, t] of timelines) {
    const e = edgeOf(id), roles = [...(mine.has(e.recipient_pubkey) ? ['creditor'] : []), ...(mine.has(e.issuer_pubkey) ? ['issuer'] : [])];
    const v = [{total: ABSENT, timestamp: -1, signature: null, anchored: null, consents: []}, ...t], n = v.length - 1;
    const seeds = v.map((x, i) => [x.anchored?.height, i]).filter(([h]) => h !== undefined).sort((a, b) => a[0] - b[0]);
    // Step j lowers the edge with no consent of the participant's behind it.
    const unconsented = j => value(v[j].total) < value(v[j - 1].total) && !v[j].consents.some(c => c.before >= value(v[j - 1].total));
    const describe = i => (v[i].total === ABSENT ? 'no note (as before its first note)' : `your state ${v[i].total} of timestamp ${v[i].timestamp}`);
    const raised = new Set(), m = [];
    let pos = 0, si = 0;
    // One alarm per kind, role and anchored total on an edge: a wrong total that later boxes keep committing is raised
    // at the first box that commits it.
    const raise = (alarm, k, extra) => {
      const key = [alarm, extra.role, extra.cause ?? '', extra.anchored_total ?? 'none', extra.decreased_to?.timestamp ?? ''].join(':');
      if (raised.has(key)) return;
      raised.add(key);
      alarmed.add(id);
      alarms.push({alarm, edge: e, box_id: k.box_id, height: k.height, ...extra});
    };
    for (const k of chain) {
      while (si < seeds.length && seeds[si][0] <= k.height) pos = Math.max(pos, seeds[si++][1]);
      const a = k.totals.has(id) ? k.totals.get(id) : ABSENT;
      // The states since the one read last with this total (the box may be at any of them), else the latest earlier one
      // with it (a superseded state).
      const hits = [];
      for (let i = pos; i <= n; i++) if (v[i].total === a) hits.push(i);
      let back = -1;
      if (!hits.length) for (let i = pos - 1; i >= 0 && back < 0; i--) if (v[i].total === a) back = i;
      // The lowest state the edge may hold now: one since the one read last (as creditor, up to the first unconsented
      // step down); the latest of them when several share that total.
      const lowest = creditor => {
        let lo = pos;
        for (let i = pos + 1; i <= n && !(creditor && unconsented(i)); i++) if (value(v[i].total) <= value(v[lo].total)) lo = i;
        return lo;
      };
      const shown = a === ABSENT ? 'no note' : String(a);
      if (roles.includes('creditor')) {
        if (hits.length) {
          for (let j = pos + 1; j <= hits[0]; j++) {
            if (!unconsented(j)) continue;
            const cs = v[j].consents, from = cs.reduce((x, c) => (c.before > x ? c.before : x), 0n);
            raise('decrease_without_your_consent', k, {role: 'creditor', anchored_total: str(a), your_state: stateOut(v[j - 1]), decreased_to: stateOut(v[j]),
              ...(cs.length ? {consents: cs.map(c => ({consent_id: c.id, before_total: String(c.before)}))} : {}),
              message: cs.length
                ? `the box of height ${k.height} commits ${shown} on ${id}, reached through a decrease from ${v[j - 1].total} to ${v[j].total} (timestamp ${v[j].timestamp}): the set-off or transfer you signed for that state lowers it from ${from}, not from ${v[j - 1].total}, so ${value(v[j - 1].total) - from} more was taken than you agreed to`
                : `the box of height ${k.height} commits ${shown} on ${id}, reached through a decrease from ${v[j - 1].total} to ${v[j].total} (timestamp ${v[j].timestamp}) that no set-off or transfer of yours lowered it by`});
          }
          if (a !== ABSENT && !hits.some(i => v[i].signature)) {
            raise('unknown', k, {cause: 'signature_missing', role: 'creditor', anchored_total: str(a),
              message: `the box of height ${k.height} commits ${shown} on ${id}, your state of timestamp ${v[hits[0]].timestamp}, but you hold no issuer signature for it (pruned, or not synced yet): nothing proves it`});
          }
        } else {
          const lo = lowest(true);
          if (a === ABSENT ? value(v[lo].total) > 0n : a < value(v[lo].total)) {
            raise('decrease_without_your_consent', k, {role: 'creditor', anchored_total: str(a), your_state: stateOut(v[lo]),
              message: `the box of height ${k.height} commits ${shown} on ${id}, below your state ${v[lo].total} of timestamp ${v[lo].timestamp}${lo === pos ? '' : `, the lowest you hold since ${describe(pos)}, which a box committed before`}, and no set-off or transfer of yours lowers it there`});
          } else if (back >= 0 && value(a) < value(v[n].total)) {
            raise('unknown', k, {cause: 'superseded_state', role: 'creditor', anchored_total: str(a), your_state: stateOut(v[n]), superseded_state: stateOut(v[back]),
              message: `the box of height ${k.height} commits ${shown} on ${id}, ${describe(back)}, which ${describe(pos)} superseded, and a box committed that before; it is below your latest state ${v[n].total} (timestamp ${v[n].timestamp}): a note you have not synced, or a revert to a superseded state: sync your edges and check again`});
          } else if (back < 0 && a !== ABSENT) {
            raise('unknown', k, {cause: 'state_not_held', role: 'creditor', anchored_total: str(a),
              message: `the box of height ${k.height} commits ${shown} on ${id}, which is no state you hold (a note you have not synced, or a total its issuer never signed): sync your edges and check again`});
          }
        }
      }
      if (roles.includes('issuer') && !hits.length) {
        const lo = lowest(false);
        if (back >= 0 && value(a) > value(v[lo].total)) {
          raise('reverted_to_superseded_state', k, {role: 'issuer', anchored_total: str(a), your_state: stateOut(v[pos]), superseded_state: stateOut(v[back]), latest_state: stateOut(v[n]),
            message: `the box of height ${k.height} commits ${shown} on ${id} again, your state of timestamp ${v[back].timestamp}, after your later state ${v[pos].total} (timestamp ${v[pos].timestamp}) was anchored, with no new note: your earlier signature can redeem it again${lo === pos ? '' : `, above your state ${v[lo].total} (timestamp ${v[lo].timestamp}), the lowest you may still owe on it`}`});
        } else if (back < 0 && a !== ABSENT && a > value(v[n].total)) {
          raise('above_your_signed_state', k, {role: 'issuer', anchored_total: str(a), your_state: stateOut(v[n]),
            message: `the box of height ${k.height} commits ${shown} on ${id}, a total you never signed, above your latest signed state${n > 0 ? ` ${v[n].total} (timestamp ${v[n].timestamp})` : ' (you signed nothing on it)'}`});
        } else if (back < 0 && a !== ABSENT) {
          raise('unknown', k, {cause: 'state_not_signed', role: 'issuer', anchored_total: str(a),
            message: `the box of height ${k.height} commits ${shown} on ${id}, which is no state you signed (your records may be incomplete, or nobody signed that total)`});
        }
      }
      m.push({a, pos, hits: hits.length ? [hits[0], hits.at(-1)] : null});
      if (hits.length) pos = hits[0];
    }
    matched.set(id, {e, roles, v, m});
  }

  // Packages (the module comment): applied(x, k) is true, false or null (undecided) for the novation edge x in chain[k];
  // null as well for an edge whose novation state is not in the participant's timeline. Each package is read box by box
  // from the first that shows it on chain until one shows it whole: what a later box changes on one of its edges is that
  // edge's own alarm (a revert, a decrease), not the package's.
  const at = (k, id) => (chain[k].totals.has(id) ? chain[k].totals.get(id) : ABSENT);
  const applied = (x, k) => {
    const r = matched.get(x.id), idx = r ? r.v.findIndex(y => y.total === x.total && y.timestamp === x.timestamp) : -1;
    if (idx < 1) return null;
    const {a, pos} = r.m[k];
    if (pos >= idx) return true;      // an earlier box (or the retained anchored state) already held the novation's state
    const after = r.v.some((y, i) => i >= idx && y.total === a), before = r.v.some((y, i) => i >= pos && i < idx && y.total === a);
    return after && before ? null : after;
  };
  const side = (x, k) => ({...edgeOf(x.id), before_total: String(x.before), total: String(x.total), anchored_total: str(at(k, x.id))});
  const shownAt = (k, id) => (at(k, id) === ABSENT ? 'no note' : String(at(k, id)));
  for (const p of packages) {
    if (p.kind === 'setoff') {
      const ins = p.edges.filter(x => mine.has(edgeOf(x.id).recipient_pubkey)), outs = p.edges.filter(x => mine.has(edgeOf(x.id).issuer_pubkey));
      for (let k = 0; k < chain.length; k++) {
        const lowered = ins.filter(x => applied(x, k) === true);
        if (!lowered.length) continue;
        const notLowered = outs.filter(x => applied(x, k) === false && value(at(k, x.id)) > x.total);
        if (!notLowered.length) {
          if (outs.every(x => applied(x, k) === true)) break;
          continue;
        }
        for (const x of [...lowered, ...notLowered]) alarmed.add(x.id);
        alarms.push({alarm: 'partial_setoff', role: 'member', consent_id: p.id, box_id: chain[k].box_id, height: chain[k].height,
          lowered: lowered.map(x => side(x, k)), not_lowered: notLowered.map(x => side(x, k)),
          message: `set-off ${p.id} is anchored in part at height ${chain[k].height}: your incoming ${lowered.map(x => x.id).join(', ')} lowered, your outgoing ${notLowered.map(x => `${x.id} not (it holds ${shownAt(k, x.id)}, where the set-off leaves ${x.total})`).join(', ')}`});
        break;
      }
      continue;
    }
    const low = p.edges.find(x => x.total < x.before), high = p.edges.find(x => x.total > x.before);
    if (mine.has(edgeOf(low.id).issuer_pubkey)) {
      // As the issuer A: A>C raised while A>B is held above the total the transfer leaves.
      for (let k = 0; k < chain.length; k++) {
        if (applied(high, k) !== true) continue;
        if (applied(low, k) === true) break;
        if (applied(low, k) !== false || value(at(k, low.id)) <= low.total) continue;
        alarmed.add(low.id); alarmed.add(high.id);
        const owed = at(k, low.id) === low.before ? `${high.total - high.before} twice` : `${value(at(k, low.id)) - low.total} more than you signed for`;
        alarms.push({alarm: 'partial_transfer', role: 'issuer', consent_id: p.id, box_id: chain[k].box_id, height: chain[k].height, lowered_edge: side(low, k), raised_edge: side(high, k),
          message: `transfer ${p.id} is anchored in part at height ${chain[k].height}: ${high.id} raised but ${low.id} not lowered (it holds ${shownAt(k, low.id)}, where the transfer leaves ${low.total}), so you owe ${owed} on chain`});
        break;
      }
    } else if (mine.has(edgeOf(low.id).recipient_pubkey)) {
      // As the old creditor B: A>B lowered while A>C has no row (or, when B is party to A>C too, A>C not raised). A>C at
      // exactly the total the transfer raised it from is undecided: kept, unless a later box shows the partial for sure.
      let found = null;
      for (let k = 0; k < chain.length; k++) {
        if (applied(low, k) !== true) continue;
        const x = at(k, high.id);
        const kind = matched.has(high.id) ? (applied(high, k) === false && value(x) < high.total ? 'partial' : applied(high, k) === null ? 'undecided' : null)
          : x === ABSENT ? 'partial' : x === high.before ? 'unconfirmed' : null;
        if (kind === 'partial') { found = {kind, k}; break; }
        if (kind === 'unconfirmed') found ??= {kind, k};
        else if (kind === null) break;
      }
      if (!found) continue;
      const {kind, k} = found;
      alarmed.add(low.id);
      const base = {role: 'old_creditor', consent_id: p.id, box_id: chain[k].box_id, height: chain[k].height, lowered_edge: side(low, k), raised_edge: side(high, k)};
      if (kind === 'partial') {
        alarms.push({alarm: 'partial_transfer', ...base,
          message: `transfer ${p.id} is anchored in part at height ${chain[k].height}: your ${low.id} lowered, but ${high.id} ${at(k, high.id) === ABSENT ? 'has no note there' : `still at ${at(k, high.id)}`}: your payment is not on chain`});
      } else {
        alarms.push({alarm: 'unknown', cause: 'transfer_unconfirmed', ...base,
          message: `transfer ${p.id}: the box of height ${chain[k].height} lowers your ${low.id} and holds ${high.id} at ${high.before}, the total the transfer raised it from: either the transfer is anchored in part (your payment is not on chain) or a set-off of its payee's lowered that edge again, which you cannot see`});
      }
    }
  }

  // Per edge: its status, and the lag of a latest state whose total the newest box does not hold.
  const edges = [];
  const given = anchoring?.check_interval_seconds;
  const interval = (Number.isFinite(given) && given >= 0 ? Math.min(given, DEFAULT_CHECK_INTERVAL_S) : DEFAULT_CHECK_INTERVAL_S) * 1000;
  const cap = anchoring?.daily_cap, capReset = cap && Number.isFinite(cap.signed_today) && Number.isFinite(cap.limit) && cap.signed_today >= cap.limit ? Date.parse(cap.resets_at) : NaN;
  for (const [id, {e, roles, v, m}] of matched) {
    const n = v.length - 1, newest = chain.length ? m.at(-1) : null, current = !!newest && v[n].total === newest.a;
    edges.push({edge: e, roles, anchored_total: newest ? str(newest.a) : null, latest_state: stateOut(v[n]),
      status: alarmed.has(id) ? 'alarm' : !newest ? 'unchecked' : current ? 'anchored' : newest.hits ? 'not_yet_anchored' : 'differs_in_your_favour'});
    if (!newest || current || n === 0 || alarmed.has(id)) continue;
    const reset = Number.isFinite(capReset) ? Math.min(capReset, v[n].timestamp + DAY_MS) : NaN;
    const expected = Math.max(v[n].timestamp, Number.isFinite(reset) ? reset : 0) + interval + ANCHOR_GRACE_MS, by = iso(expected);
    const held = newest.a, lower = value(v[n].total) < value(held);
    warnings.push({warning: 'not_yet_anchored', edge: e, roles, box_id: latest.box_id, height: latest.height, anchored_total: str(held),
      latest_state: stateOut(v[n]), expected_by: by, overdue: Number.isFinite(now_ms) ? now_ms > expected : null,
      message: `your latest state of ${id} (${v[n].total}, timestamp ${v[n].timestamp}) is not in the newest box (height ${latest.height}), which holds ${held === ABSENT ? 'no note' : held}: expected by ${by ?? 'a time past JavaScript\'s Date range'}${reset > v[n].timestamp ? ', after the daily cap of tracker boxes resets' : ''}${lower ? '; until then the chain commits the higher total' : ''}`});
  }
  return result(chain.length, latest, edges);
}
