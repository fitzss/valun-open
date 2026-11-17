// lib/anchor-monitor.mjs, the own-edge monitor rules (fix inbox #62, step 6d): anchored snapshots against a participant's
// own records (verified signed states, the novations it signed with their packages), no network:
//   - no alarm for a note anchored, a set-off that leaves the participant's net unchanged in one anchor, or a debt
//     transfer it signed; a state not anchored yet is a warning (not_yet_anchored), overdue only past the updater's
//     interval and grace, or the daily cap's reset; a signed decrease not anchored yet is lag, not above_your_signed_state;
//   - every alarm: decrease_without_your_consent (lowered, dropped, back to an older state, a decrease buried under a
//     later note, below every state since the last anchored one, a consented state reached from above its before_total),
//     partial_setoff, partial_transfer (as old creditor and as issuer), reverted_to_superseded_state, above_your_signed_state,
//     and unknown for missing data (a pruned signature, an unverified, conflicting or missing snapshot, unreadable
//     records, totals nobody signed, a superseded state below the latest, a transfer the old creditor cannot confirm),
//     never a pass;
//   - the review of fix inbox #62: a total an edge held before is no partial novation and no lag; a superseded state
//     alarms the party it costs, not the one it favours; the operator's anchoring cannot throw or delay overdue;
//   - the decisive case: an operator that anchors a tree with a creditor's edge lowered and publishes the same rows passes
//     the full audit (scripts/ops/anchor-audit.mjs: MATCH), and the creditor's monitor alarms, citing its retained signed
//     state, the box and the height. That case needs the audit and the live vectors, which the public copy and the
//     container image do not have: there it is skipped; anywhere else a missing file fails it.
// Run: node --test test/anchor-monitor.unit.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {digest} from '../lib/avl.mjs';
import {ALARMS, ANCHOR_GRACE_MS, MAX_TIMESTAMP_MS, WARNINGS, monitor} from '../lib/anchor-monitor.mjs';

// Synthetic keys and boxes: K(n) a compressed key, box(h) a box id per height.
const K = n => `02${n.toString(16).padStart(2, '0').repeat(32)}`;
const ME = K(1), A = K(2), B = K(3), C = K(4), D = K(5), OTHER = K(9);
const box = h => h.toString(16).padStart(64, '0');
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const ts = (min, residue = 0) => T0 + min * 60_000 + residue;   // a state's timestamp, minutes after T0
// A snapshot: the rows a box at `height` commits (plus an unrelated note, as a real tree has), its digest as R5 holds it.
function snap(height, rows) {
  const r = [[OTHER, D, 777], ...rows].map(([i, rcp, total]) => ({issuer_pubkey: i, recipient_pubkey: rcp, denomination: 'erg', total: String(total)}));
  return {box_id: box(height), height, digest: digest(r), rows: r};
}
const st = (issuer, recipient, total, t, more = {}) => ({issuer_pubkey: issuer, recipient_pubkey: recipient, denomination: 'erg', total: String(total), timestamp: t, signature: `sig${t}`, ...more});
const pkg = (kind, id, edges) => ({kind, id, edges: edges.map(([i, r, before, total, t]) => ({issuer_pubkey: i, recipient_pubkey: r, denomination: 'erg', before_total: String(before), total: String(total), timestamp: t}))});
const run = o => monitor({keys: [ME], states: [], consents: [], now_ms: ts(10_000), ...o});
const kinds = r => r.alarms.map(a => a.alarm);
const edge = (i, r) => ({issuer_pubkey: i, recipient_pubkey: r, denomination: 'erg'});

test('the alarm and warning names are the documented ones', () => {
  assert.deepEqual(ALARMS, ['decrease_without_your_consent', 'partial_setoff', 'partial_transfer', 'reverted_to_superseded_state', 'above_your_signed_state', 'unknown']);
  assert.deepEqual(WARNINGS, ['not_yet_anchored']);
});

test('no alarm: a note anchored, a set-off with your net unchanged in one anchor, a debt transfer you signed', () => {
  // A note A > ME, anchored as signed.
  const note = run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: [snap(100, [[A, ME, 3_000_000]])]});
  assert.deepEqual([note.ok, note.alarms, note.warnings], [true, [], []]);
  assert.deepEqual(note.edges, [{edge: edge(A, ME), roles: ['creditor'], anchored_total: '3000000', latest_state: {total: '3000000', timestamp: ts(1), signature: `sig${ts(1)}`}, status: 'anchored'}]);
  // A set-off around C > ME > B > C, 4 off each edge: both of my edges lowered in the box of height 200.
  const s = ts(5, 998);
  const setoff = run({
    states: [st(C, ME, 10, ts(1)), st(ME, B, 8, ts(1)), st(C, ME, 6, s), st(ME, B, 4, s)],
    consents: [pkg('setoff', 'vs_1', [[C, ME, 10, 6, s], [ME, B, 8, 4, s], [B, C, 5, 1, s]])],
    snapshots: [snap(100, [[C, ME, 10], [ME, B, 8], [B, C, 5]]), snap(200, [[C, ME, 6], [ME, B, 4], [B, C, 1]])]});
  assert.deepEqual([setoff.ok, setoff.alarms, setoff.warnings], [true, [], []]);
  assert.deepEqual(setoff.edges.map(e => [e.edge.issuer_pubkey, e.roles, e.status]), [[C, ['creditor'], 'anchored'], [ME, ['issuer'], 'anchored']]);
  // A debt transfer I signed as the old creditor: A > ME lowered by 3, A > C raised by 3, in one box.
  const x = ts(7, 999);
  const transfer = run({
    states: [st(A, ME, 10, ts(1)), st(A, ME, 7, x)],
    consents: [pkg('transfer', 'vt_1', [[A, ME, 10, 7, x], [A, C, 0, 3, x]])],
    snapshots: [snap(100, [[A, ME, 10]]), snap(200, [[A, ME, 7], [A, C, 3]])]});
  assert.deepEqual([transfer.ok, transfer.alarms, transfer.warnings], [true, [], []]);
  // The same, read by its issuer A (both new states are A's signatures) and by the new creditor C.
  assert.equal(monitor({keys: [A], states: [st(A, ME, 10, ts(1)), st(A, ME, 7, x), st(A, C, 3, x)], consents: [pkg('transfer', 'vt_1', [[A, ME, 10, 7, x], [A, C, 0, 3, x]])],
    snapshots: [snap(100, [[A, ME, 10]]), snap(200, [[A, ME, 7], [A, C, 3]])], now_ms: ts(100)}).ok, true);
  assert.equal(monitor({keys: [C], states: [st(A, C, 3, x)], snapshots: [snap(100, [[A, ME, 10]]), snap(200, [[A, ME, 7], [A, C, 3]])], now_ms: ts(100)}).ok, true);
  // An equal total at a later timestamp (10, set off to 6, a new note back to 10): a lag at worst, never an alarm.
  const s2 = ts(3, 998);
  const again = run({keys: [ME], states: [st(ME, B, 10, ts(1)), st(ME, B, 6, s2), st(ME, B, 10, ts(4)), st(C, ME, 9, ts(1)), st(C, ME, 5, s2)],
    consents: [pkg('setoff', 'vs_2', [[ME, B, 10, 6, s2], [C, ME, 9, 5, s2]])],
    snapshots: [snap(100, [[ME, B, 10], [C, ME, 9]]), snap(200, [[ME, B, 6], [C, ME, 5]]), snap(300, [[ME, B, 10], [C, ME, 5]])]});
  assert.deepEqual([again.ok, again.alarms, again.warnings], [true, [], []]);
});

test('not anchored yet is a warning: overdue only past the interval and grace, or after the daily cap resets; a signed decrease is lag', () => {
  const states = [st(A, ME, 3_000_000, ts(1), {anchored: {box_id: box(100), height: 100}}), st(A, ME, 5_000_000, ts(20))];
  const snapshots = [snap(150, [[A, ME, 3_000_000]])];
  const anchoring = {check_interval_seconds: 300, daily_cap: {limit: 50, signed_today: 29, resets_at: '2026-11-15T00:00:00.000Z'}};
  const soon = run({states, snapshots, anchoring, now_ms: ts(21)});
  assert.deepEqual([soon.ok, soon.alarms], [true, []], 'a warning is not an alarm');
  assert.equal(soon.warnings.length, 1);
  const w = soon.warnings[0];
  assert.deepEqual([w.warning, w.edge, w.roles, w.box_id, w.height, w.anchored_total, w.latest_state.total, w.overdue],
    ['not_yet_anchored', edge(A, ME), ['creditor'], box(150), 150, '3000000', '5000000', false]);
  assert.equal(w.expected_by, new Date(ts(20) + 300_000 + ANCHOR_GRACE_MS).toISOString());
  assert.equal(run({states, snapshots, anchoring, now_ms: ts(20) + 300_000 + ANCHOR_GRACE_MS + 1}).warnings[0].overdue, true, 'past the interval and grace');
  assert.equal(soon.edges[0].status, 'not_yet_anchored');
  // The daily cap used up: nothing is overdue before the reset plus the interval.
  const capped = {check_interval_seconds: 300, daily_cap: {limit: 50, signed_today: 50, resets_at: '2026-11-15T00:00:00.000Z'}};
  const night = run({states, snapshots, anchoring: capped, now_ms: Date.parse('2026-11-14T23:59:00.000Z')});
  assert.deepEqual([night.warnings[0].overdue, night.warnings[0].expected_by], [false, new Date(Date.parse('2026-11-15T00:00:00.000Z') + 300_000 + ANCHOR_GRACE_MS).toISOString()]);
  assert.match(night.warnings[0].message, /after the daily cap of tracker boxes resets/);
  assert.equal(run({states, snapshots, anchoring: capped, now_ms: Date.parse('2026-11-15T00:09:00.000Z')}).warnings[0].overdue, true);
  // A new edge with no row yet: the same warning, holding no note.
  const fresh = run({states: [st(B, ME, 1_000_000, ts(30))], snapshots: [snap(150, [])], now_ms: ts(31)});
  assert.deepEqual([fresh.ok, fresh.warnings[0].anchored_total, fresh.warnings[0].overdue], [true, null, false]);
  assert.match(fresh.warnings[0].message, /which holds no note/);
  // As issuer: a set-off I signed (10 to 6) that the newest box does not hold yet: the box still commits 10, my earlier
  // state. A warning (the chain commits the higher total until then), not above_your_signed_state.
  const s = ts(40, 998);
  const mineToo = [st(ME, B, 10, ts(1)), st(ME, B, 6, s), st(C, ME, 4, ts(1)), st(C, ME, 0, s)];
  const lag = monitor({keys: [ME], states: mineToo, consents: [pkg('setoff', 'vs_3', [[ME, B, 10, 6, s], [C, ME, 4, 0, s]])],
    snapshots: [snap(150, [[ME, B, 10], [C, ME, 4]])], now_ms: ts(41)});
  assert.deepEqual([lag.ok, kinds(lag)], [true, []]);
  assert.deepEqual(lag.warnings.map(x => [x.edge.issuer_pubkey, x.anchored_total, x.latest_state.total]).sort(), [[ME, '10', '6'], [C, '4', '0']]);
  assert.match(lag.warnings.find(x => x.edge.issuer_pubkey === ME).message, /until then the chain commits the higher total/);
  // Overdue is still a warning, never an alarm.
  const late = monitor({keys: [ME], states: mineToo, consents: [pkg('setoff', 'vs_3', [[ME, B, 10, 6, s], [C, ME, 4, 0, s]])],
    snapshots: [snap(150, [[ME, B, 10], [C, ME, 4]])], now_ms: ts(4000)});
  assert.deepEqual([late.ok, late.warnings.map(x => x.overdue)], [true, [true, true]]);
});

test('decrease_without_your_consent: lowered, dropped, back to an older state, buried under a later note, an unsigned total in between', () => {
  // My retained anchored state (step 6c: kept past the 30-day pruning), 40 days old, signature kept.
  const old = T0 - 40 * 864e5;
  const kept = st(A, ME, 3_000_000, old, {anchored: {box_id: box(100), height: 100}});
  const lowered = run({states: [kept], snapshots: [snap(500, [[A, ME, 2_000_000]])]});
  assert.equal(lowered.ok, false);
  assert.deepEqual(lowered.alarms.map(a => [a.alarm, a.role, a.edge, a.box_id, a.height, a.anchored_total, a.your_state]),
    [['decrease_without_your_consent', 'creditor', edge(A, ME), box(500), 500, '2000000', {total: '3000000', timestamp: old, signature: `sig${old}`}]]);
  assert.match(lowered.alarms[0].message, /commits 2000000 on .* below your state 3000000 of timestamp \d+, and no set-off or transfer of yours lowers it there/);
  assert.equal(lowered.edges[0].status, 'alarm');
  // The same from two snapshots, and once only while the boxes keep committing it.
  const twice = run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: [snap(100, [[A, ME, 3_000_000]]), snap(200, [[A, ME, 2_000_000]]), snap(300, [[A, ME, 2_000_000]]), snap(400, [[A, ME, 2_000_000]])]});
  assert.deepEqual(twice.alarms.map(a => [a.alarm, a.height]), [['decrease_without_your_consent', 200]]);
  // Dropped: the row is gone.
  const dropped = run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: [snap(100, [[A, ME, 3_000_000]]), snap(200, [])]});
  assert.deepEqual(dropped.alarms.map(a => [a.alarm, a.anchored_total, a.height]), [['decrease_without_your_consent', null, 200]]);
  assert.match(dropped.alarms[0].message, /commits no note on/);
  // Back to an older, lower state after a new note was anchored.
  const back = run({states: [st(A, ME, 6, ts(1)), st(A, ME, 10, ts(2))], snapshots: [snap(100, [[A, ME, 6]]), snap(200, [[A, ME, 10]]), snap(300, [[A, ME, 6]])]});
  assert.deepEqual(back.alarms.map(a => [a.alarm, a.anchored_total, a.your_state.total, a.height]), [['decrease_without_your_consent', '6', '10', 300]]);
  // A decrease the issuer signed with no consent of mine, buried under a later note: the box commits the later state.
  const buried = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 6, ts(2)), st(A, ME, 9, ts(3))], snapshots: [snap(100, [[A, ME, 10]]), snap(200, [[A, ME, 9]])]});
  assert.deepEqual(buried.alarms.map(a => [a.alarm, a.anchored_total, a.your_state.total, a.decreased_to.total, a.height]), [['decrease_without_your_consent', '9', '10', '6', 200]]);
  // A set-off I signed takes the edge from 10 to 6. The box commits 8, no state I hold: above 6, so a note I have not
  // synced since the set-off explains it as well as a total nobody signed (unknown, never a pass). 5 is below every state
  // the edge may hold since the box that committed 10: the decrease, citing that lowest state.
  const s = ts(2, 998), mine = [st(A, ME, 10, ts(1)), st(A, ME, 6, s), st(ME, B, 4, ts(1)), st(ME, B, 0, s)];
  const between = run({states: mine, consents: [pkg('setoff', 'vs_4', [[A, ME, 10, 6, s], [ME, B, 4, 0, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 4]]), snap(200, [[A, ME, 8], [ME, B, 0]])]});
  assert.deepEqual(between.alarms.map(a => [a.alarm, a.cause, a.anchored_total]), [['unknown', 'state_not_held', '8']]);
  const below = run({states: mine, consents: [pkg('setoff', 'vs_4', [[A, ME, 10, 6, s], [ME, B, 4, 0, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 4]]), snap(200, [[A, ME, 5], [ME, B, 0]])]});
  assert.deepEqual(below.alarms.map(a => [a.alarm, a.anchored_total, a.your_state]), [['decrease_without_your_consent', '5', {total: '6', timestamp: s, signature: `sig${s}`}]]);
  assert.match(below.alarms[0].message, /below your state 6 of timestamp \d+, the lowest you hold since your state 10 of timestamp \d+, which a box committed before/);
  // A favourable change is not the creditor's alarm: an older, higher total again (the issuer's monitor raises it).
  const favour = run({states: mine, consents: [pkg('setoff', 'vs_5', [[A, ME, 10, 6, s], [ME, B, 4, 0, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 4]]), snap(200, [[A, ME, 6], [ME, B, 0]]), snap(300, [[A, ME, 10], [ME, B, 0]])]});
  assert.deepEqual(kinds(favour), []);
  assert.deepEqual(favour.edges.map(x => [x.edge.issuer_pubkey, x.status]), [[A, 'differs_in_your_favour'], [ME, 'anchored']]);
});

test('the retained anchored state makes the first check decisive: without it, an edge dropped before the first snapshot reads as lag, overdue', () => {
  const dropped = [snap(500, [])], late = ts(10_000);
  const bare = run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: dropped, now_ms: late});
  assert.deepEqual([bare.ok, kinds(bare), bare.warnings.map(w => [w.warning, w.overdue])], [true, [], [['not_yet_anchored', true]]], 'the documented limit');
  const kept = run({states: [st(A, ME, 3_000_000, ts(1), {anchored: {box_id: box(100), height: 100}})], snapshots: dropped, now_ms: late});
  assert.deepEqual([kept.ok, kinds(kept), kept.alarms[0].anchored_total, kept.alarms[0].height], [false, ['decrease_without_your_consent'], null, 500]);
  // A retained mark on a later box than the snapshot does not apply to it: it seeds only snapshots at or after it.
  const later = run({states: [st(A, ME, 3_000_000, ts(1), {anchored: {box_id: box(900), height: 900}})], snapshots: dropped, now_ms: late});
  assert.deepEqual(kinds(later), []);
});

test('partial_setoff: my incoming edge lowered under a set-off I signed while my outgoing edge in it was not, in the same anchor', () => {
  const s = ts(5, 998);
  const states = [st(C, ME, 10, ts(1)), st(ME, B, 8, ts(1)), st(C, ME, 6, s), st(ME, B, 4, s)];
  const consents = [pkg('setoff', 'vs_7', [[C, ME, 10, 6, s], [ME, B, 8, 4, s], [B, C, 5, 1, s]])];
  const r = run({states, consents, snapshots: [snap(100, [[C, ME, 10], [ME, B, 8], [B, C, 5]]), snap(200, [[C, ME, 6], [ME, B, 8], [B, C, 1]]), snap(300, [[C, ME, 6], [ME, B, 4], [B, C, 1]])]});
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['partial_setoff'], 'once, at the first box that lowers my incoming edge');
  const a = r.alarms[0];
  assert.deepEqual([a.consent_id, a.box_id, a.height, a.role], ['vs_7', box(200), 200, 'member']);
  assert.deepEqual(a.lowered, [{...edge(C, ME), before_total: '10', total: '6', anchored_total: '6'}]);
  assert.deepEqual(a.not_lowered, [{...edge(ME, B), before_total: '8', total: '4', anchored_total: '8'}]);
  assert.deepEqual(r.edges.map(e => e.status), ['alarm', 'alarm']);
  // My outgoing edge lowered first (in my favour, the next member's alarm): not mine.
  const other = run({states, consents, snapshots: [snap(100, [[C, ME, 10], [ME, B, 8], [B, C, 5]]), snap(200, [[C, ME, 10], [ME, B, 4], [B, C, 1]])]});
  assert.deepEqual(kinds(other), []);
  // A package that is not net-neutral for me is no set-off I would have signed: unreadable, and the decrease it would
  // explain is then unconsented.
  const skewed = run({states, consents: [pkg('setoff', 'vs_8', [[C, ME, 10, 6, s], [ME, B, 8, 5, s]])], snapshots: [snap(100, [[C, ME, 10], [ME, B, 8]]), snap(200, [[C, ME, 6], [ME, B, 4]])]});
  assert.ok(skewed.alarms.some(x => x.alarm === 'unknown' && x.cause === 'consent_unreadable' && /incoming edges fall by 4 and your outgoing ones by 3/.test(x.message)));
  assert.ok(kinds(skewed).includes('decrease_without_your_consent'));
});

test('partial_transfer: anchored in part, as the old creditor (my claim lowered, the payee\'s not raised) and as the issuer (owed twice)', () => {
  const x = ts(7, 999);
  // Old creditor: A > ME lowered by 3, A > C not raised (no row yet) in that box.
  const asB = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 7, x)], consents: [pkg('transfer', 'vt_2', [[A, ME, 10, 7, x], [A, C, 0, 3, x]])],
    snapshots: [snap(100, [[A, ME, 10]]), snap(200, [[A, ME, 7]])]});
  assert.deepEqual(kinds(asB), ['partial_transfer']);
  assert.deepEqual([asB.alarms[0].role, asB.alarms[0].height, asB.alarms[0].raised_edge.anchored_total, asB.alarms[0].lowered_edge.anchored_total], ['old_creditor', 200, null, '7']);
  assert.match(asB.alarms[0].message, /your payment is not on chain/);
  // A > C held 5 before and holds 5 in that box: the transfer anchored in part, or a set-off of C's that took A > C back
  // to 5 after it, which I cannot see. Unknown (transfer_unconfirmed), never a pass.
  const asB5 = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 7, x)], consents: [pkg('transfer', 'vt_3', [[A, ME, 10, 7, x], [A, C, 5, 8, x]])],
    snapshots: [snap(100, [[A, ME, 10], [A, C, 5]]), snap(200, [[A, ME, 7], [A, C, 5]])]});
  assert.deepEqual(asB5.alarms.map(a => [a.alarm, a.cause, a.role, a.height, a.raised_edge.anchored_total]), [['unknown', 'transfer_unconfirmed', 'old_creditor', 200, '5']]);
  assert.match(asB5.alarms[0].message, /either the transfer is anchored in part \(your payment is not on chain\) or a set-off of its payee's lowered that edge again/);
  assert.equal(asB5.ok, false);
  // Issuer: ME > C raised, ME > B not lowered: I owe the 3 twice on chain.
  const asA = monitor({keys: [ME], states: [st(ME, B, 10, ts(1)), st(ME, B, 7, x), st(ME, C, 3, x)], consents: [pkg('transfer', 'vt_4', [[ME, B, 10, 7, x], [ME, C, 0, 3, x]])],
    snapshots: [snap(100, [[ME, B, 10]]), snap(200, [[ME, B, 10], [ME, C, 3]])], now_ms: ts(100)});
  assert.deepEqual(kinds(asA), ['partial_transfer']);
  assert.deepEqual([asA.alarms[0].role, asA.alarms[0].consent_id], ['issuer', 'vt_4']);
  assert.match(asA.alarms[0].message, /so you owe 3 twice on chain/);
  // Both in one box: no alarm.
  assert.deepEqual(kinds(monitor({keys: [ME], states: [st(ME, B, 10, ts(1)), st(ME, B, 7, x), st(ME, C, 3, x)], consents: [pkg('transfer', 'vt_4', [[ME, B, 10, 7, x], [ME, C, 0, 3, x]])],
    snapshots: [snap(100, [[ME, B, 10]]), snap(200, [[ME, B, 7], [ME, C, 3]])], now_ms: ts(100)})), []);
  // A record that is no transfer (two raises; unequal amounts) is unreadable.
  for (const bad of [[[A, ME, 10, 12, x], [A, C, 0, 3, x]], [[A, ME, 10, 7, x], [A, C, 0, 4, x]], [[A, ME, 10, 7, x], [B, C, 0, 3, x]]]) {
    const r = run({states: [st(A, ME, 10, ts(1))], consents: [pkg('transfer', 'vt_x', bad)], snapshots: [snap(100, [[A, ME, 10]])]});
    assert.ok(r.alarms.some(a => a.alarm === 'unknown' && a.cause === 'consent_unreadable'), JSON.stringify(bad));
  }
});

test('reverted_to_superseded_state: an issuer edge anchored at 6 after a set-off comes back at 10 with no new note', () => {
  const s = ts(3, 998);
  const states = [st(ME, B, 10, ts(1)), st(ME, B, 6, s), st(C, ME, 4, ts(1)), st(C, ME, 0, s)];
  const consents = [pkg('setoff', 'vs_9', [[ME, B, 10, 6, s], [C, ME, 4, 0, s]])];
  const r = run({states, consents, snapshots: [snap(100, [[ME, B, 10], [C, ME, 4]]), snap(200, [[ME, B, 6], [C, ME, 0]]), snap(300, [[ME, B, 10], [C, ME, 0]])]});
  assert.deepEqual(kinds(r), ['reverted_to_superseded_state']);
  const a = r.alarms[0];
  assert.deepEqual([a.role, a.edge, a.box_id, a.height, a.anchored_total, a.your_state.total, a.superseded_state.total], ['issuer', edge(ME, B), box(300), 300, '10', '6', '10']);
  assert.match(a.message, /your earlier signature can redeem it again/);
  // With a new note of 10 (+4 at a later timestamp): legitimate.
  assert.deepEqual(kinds(run({states: [...states, st(ME, B, 10, ts(4))], consents, snapshots: [snap(100, [[ME, B, 10], [C, ME, 4]]), snap(200, [[ME, B, 6], [C, ME, 0]]), snap(300, [[ME, B, 10], [C, ME, 0]])]})), []);
  // The retained anchored state seeds it: the 6 was seen anchored at height 200 by an earlier run.
  const seeded = run({states: [st(ME, B, 10, ts(1)), st(ME, B, 6, s, {anchored: {box_id: box(200), height: 200}}), st(C, ME, 4, ts(1)), st(C, ME, 0, s)], consents,
    snapshots: [snap(300, [[ME, B, 10], [C, ME, 0]])]});
  assert.deepEqual(kinds(seeded), ['reverted_to_superseded_state']);
});

test('above_your_signed_state: an issuer edge anchored above its latest signed state, or a debt in my name I never signed', () => {
  const r = run({states: [st(ME, B, 10, ts(1))], snapshots: [snap(100, [[ME, B, 10]]), snap(200, [[ME, B, 12]])]});
  assert.deepEqual(r.alarms.map(a => [a.alarm, a.role, a.anchored_total, a.your_state.total, a.height]), [['above_your_signed_state', 'issuer', '12', '10', 200]]);
  const forged = run({snapshots: [snap(100, [[ME, D, 5_000_000]])]});
  assert.deepEqual(forged.alarms.map(a => [a.alarm, a.edge, a.anchored_total, a.your_state]), [['above_your_signed_state', edge(ME, D), '5000000', null]]);
  assert.match(forged.alarms[0].message, /\(you signed nothing on it\)/);
  // Every key of mine counts: an earlier key's edge.
  const earlier = K(7);
  assert.deepEqual(kinds(monitor({keys: [ME, earlier], snapshots: [snap(100, [[earlier, D, 1]])], now_ms: ts(1)})), ['above_your_signed_state']);
  assert.deepEqual(kinds(monitor({keys: [ME], snapshots: [snap(100, [[earlier, D, 1]])], now_ms: ts(1)})), [], 'not my key, not my edge');
});

test('unknown, never a pass: a pruned signature, an unverified, conflicting or missing snapshot, unreadable records, totals nobody signed', () => {
  // A pruned signature: the box commits my state, and I can no longer prove it.
  const pruned = run({states: [st(A, ME, 3_000_000, ts(1), {signature: null})], snapshots: [snap(100, [[A, ME, 3_000_000]])]});
  assert.deepEqual(pruned.alarms.map(a => [a.alarm, a.cause, a.anchored_total]), [['unknown', 'signature_missing', '3000000']]);
  assert.equal(pruned.ok, false);
  // A snapshot whose rows are not its digest's tree is not used; with no other, nothing was checked.
  const bad = snap(100, [[A, ME, 3_000_000]]);
  bad.rows[1].total = '2000000';
  const unverified = run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: [bad]});
  assert.deepEqual(unverified.alarms.map(a => a.cause), ['snapshot_unverified', 'no_snapshot']);
  assert.deepEqual([unverified.ok, unverified.snapshots], [false, {given: 1, verified: 0, latest: null}]);
  assert.deepEqual(unverified.edges.map(e => e.status), ['unchecked']);
  const undigestible = snap(100, [[A, ME, 1]]);
  undigestible.rows.push({...undigestible.rows[1]});
  assert.match(run({snapshots: [undigestible]}).alarms[0].message, /its rows cannot be digested/);
  // No snapshot at all; a snapshot that is not one.
  assert.deepEqual(run({states: [st(A, ME, 1, ts(1))], snapshots: []}).alarms.map(a => a.cause), ['no_snapshot']);
  assert.deepEqual(run({snapshots: [{box_id: 'x'}]}).alarms.map(a => a.cause), ['snapshot_unreadable', 'no_snapshot']);
  // Two boxes at one height (or one box at two heights): neither is used.
  const two = snap(100, [[A, ME, 3]]), three = {...snap(100, [[A, ME, 2]]), box_id: box(101)};
  const conflict = run({states: [st(A, ME, 3, ts(1))], snapshots: [two, three, snap(200, [[A, ME, 3]])]});
  assert.deepEqual(conflict.alarms.map(a => [a.cause, a.height]), [['snapshot_conflict', 100], ['snapshot_conflict', 100]]);
  assert.deepEqual(conflict.snapshots, {given: 3, verified: 1, latest: {box_id: box(200), height: 200}});
  assert.deepEqual(run({states: [st(A, ME, 3, ts(1))], snapshots: [snap(100, [[A, ME, 3]]), snap(100, [[A, ME, 3]])]}).alarms, [], 'the same snapshot twice is one');
  // Unreadable records.
  assert.deepEqual(run({states: [{...st(A, ME, 3, ts(1)), total: '03'}], snapshots: [snap(100, [[A, ME, 3]])]}).alarms.map(a => a.cause), ['record_unreadable', 'state_not_held']);
  assert.deepEqual(run({states: [{...st(A, ME, 3, ts(1)), issuer_pubkey: 'zz'}], snapshots: [snap(100, [])]}).alarms.map(a => a.cause), ['record_unreadable']);
  assert.deepEqual(run({consents: [{kind: 'gift', id: 'x', edges: []}], snapshots: [snap(100, [])]}).alarms.map(a => a.cause), ['consent_unreadable']);
  assert.deepEqual(run({keys: [ME, 'nope'], snapshots: [snap(100, [])]}).alarms.map(a => a.cause), ['record_unreadable']);
  assert.deepEqual(monitor({keys: [], snapshots: [snap(100, [])]}).alarms.map(a => a.cause), ['keys_missing']);
  assert.equal(monitor({}).ok, false);
  // Two states of one edge at one timestamp: an edge's timestamps strictly increase, so neither is used.
  const twin = run({states: [st(A, ME, 3, ts(1)), st(A, ME, 4, ts(1))], snapshots: [snap(100, [[A, ME, 3]])]});
  assert.deepEqual(twin.alarms.map(a => a.cause), ['record_conflict', 'state_not_held']);
  // Totals nobody signed, as far as my records go: as creditor above all I hold; as issuer below my latest.
  assert.deepEqual(run({states: [st(A, ME, 3, ts(1))], snapshots: [snap(100, [[A, ME, 5]])]}).alarms.map(a => a.cause), ['state_not_held']);
  assert.deepEqual(run({states: [st(ME, B, 3, ts(1)), st(ME, B, 9, ts(2))], snapshots: [snap(100, [[ME, B, 3]]), snap(200, [[ME, B, 5]])]}).alarms.map(a => a.cause), ['state_not_signed']);
  // The first box I see, below the only state I hold, with nothing anchored before: an earlier note of the edge, or a
  // lowered one; unknown, not a pass.
  assert.deepEqual(run({states: [st(A, ME, 3_000_000, ts(1))], snapshots: [snap(100, [[A, ME, 2_000_000]])]}).alarms.map(a => [a.alarm, a.cause]), [['unknown', 'state_not_held']]);
});

test('a total the edge held before is no partial novation and no lag: a set-off, a transfer read by its issuer and its old creditor', () => {
  // ME > B 5, a note to 8, a set-off back to 5 (C > ME 10 to 7 in the same package), all between two anchors: the box
  // commits ME > B 5 and C > ME 7, my signed states. Whether that 5 is the first state or the set-off's cannot be told:
  // no alarm, and no warning (the box holds my latest totals).
  const s = ts(6, 998);
  const setoff = run({states: [st(ME, B, 5, ts(1)), st(ME, B, 8, ts(3)), st(ME, B, 5, s), st(C, ME, 10, ts(1)), st(C, ME, 7, s)],
    consents: [pkg('setoff', 'vs_eq', [[ME, B, 8, 5, s], [C, ME, 10, 7, s], [B, C, 9, 6, s]])],
    snapshots: [snap(100, [[ME, B, 5], [C, ME, 10], [B, C, 9]]), snap(200, [[ME, B, 5], [C, ME, 7], [B, C, 6]])], now_ms: ts(8)});
  assert.deepEqual([setoff.ok, setoff.alarms, setoff.warnings, setoff.edges.map(e => e.status)], [true, [], [], ['anchored', 'anchored']]);
  // A debt transfer read by its issuer ME: ME > B 7, a note to 10, then B pays C with it (ME > B 10 to 7, ME > C 0 to 3).
  // The box commits ME > B 7 and ME > C 3.
  const x = ts(6, 999), vt = [pkg('transfer', 'vt_eq', [[ME, B, 10, 7, x], [ME, C, 0, 3, x]])];
  const mine = [st(ME, B, 7, ts(1)), st(ME, B, 10, ts(3)), st(ME, B, 7, x), st(ME, C, 3, x)];
  const issuer = run({states: mine, consents: vt, snapshots: [snap(100, [[ME, B, 7]]), snap(200, [[ME, B, 7], [ME, C, 3]])], now_ms: ts(8)});
  assert.deepEqual([issuer.ok, issuer.alarms, issuer.warnings], [true, [], []]);
  // The same, read by the old creditor B.
  const old = monitor({keys: [B], states: [st(ME, B, 7, ts(1)), st(ME, B, 10, ts(3)), st(ME, B, 7, x)], consents: vt,
    snapshots: [snap(100, [[ME, B, 7]]), snap(200, [[ME, B, 7], [ME, C, 3]])], now_ms: ts(10_000)});
  assert.deepEqual([old.ok, old.alarms, old.warnings], [true, [], []]);
  // Partial for sure still: the box holds ME > B at the total the transfer lowers it from, which no later state has.
  const partial = run({states: mine, consents: vt, snapshots: [snap(100, [[ME, B, 7]]), snap(200, [[ME, B, 10], [ME, C, 3]])], now_ms: ts(8)});
  assert.deepEqual(kinds(partial), ['partial_transfer']);
  assert.match(partial.alarms[0].message, /so you owe 3 twice on chain/);
  // The old creditor when the payee's set-off took A > C from 3 back to 0 before the box: A > C holds 0, the total the
  // transfer raised it from. Undecided: unknown, not partial_transfer (with no row at all it is partial: the asB case).
  const cleared = monitor({keys: [B], states: [st(A, B, 10, ts(1)), st(A, B, 7, x)], consents: [pkg('transfer', 'vt_c', [[A, B, 10, 7, x], [A, C, 0, 3, x]])],
    snapshots: [snap(100, [[A, B, 10], [C, D, 3], [D, A, 5]]), snap(200, [[A, B, 7], [A, C, 0], [C, D, 0], [D, A, 2]])], now_ms: ts(10)});
  assert.deepEqual(cleared.alarms.map(a => [a.alarm, a.cause, a.role]), [['unknown', 'transfer_unconfirmed', 'old_creditor']]);
});

test('a superseded state is a tamper for the party it costs: the creditor below its latest, the issuer above what it may owe, the package it breaks', () => {
  // Creditor: A > ME 10, a set-off to 6, a note to 12; the boxes commit 10, 6, then 10 again. 10 is a state the box of
  // height 200 superseded, below my latest 12: unknown (a note I have not synced, or a revert), not a pass.
  const s = ts(2, 998);
  const creditor = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 6, s), st(A, ME, 12, ts(3)), st(ME, B, 4, ts(1)), st(ME, B, 0, s)],
    consents: [pkg('setoff', 'vs_s1', [[A, ME, 10, 6, s], [ME, B, 4, 0, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 4]]), snap(200, [[A, ME, 6], [ME, B, 0]]), snap(300, [[A, ME, 10], [ME, B, 0]])]});
  assert.deepEqual(creditor.alarms.map(a => [a.alarm, a.cause, a.role, a.height, a.anchored_total, a.your_state.total, a.superseded_state.total]),
    [['unknown', 'superseded_state', 'creditor', 300, '10', '12', '10']]);
  assert.equal(creditor.edges.find(e => e.edge.issuer_pubkey === A).status, 'alarm');
  // ME > B 6, then 10 (both anchored); a set-off at t3 takes C > ME 6 to 0 and ME > B 10 to 4. The box of height 300
  // commits C > ME 0 and ME > B 6, my superseded state: I gave up 6 and my debt fell by 4 only. As issuer, reverted (6 is
  // above 4, the lowest I may still owe); as member, the set-off anchored in part.
  const t3 = ts(3, 998), vs3 = [pkg('setoff', 'vs_3', [[C, ME, 6, 0, t3], [ME, B, 10, 4, t3], [B, C, 7, 1, t3]])];
  const boxes = [snap(100, [[ME, B, 6], [C, ME, 6], [B, C, 7]]), snap(200, [[ME, B, 10], [C, ME, 6], [B, C, 7]]), snap(300, [[ME, B, 6], [C, ME, 0], [B, C, 1]])];
  const meStates = [st(ME, B, 6, ts(1)), st(ME, B, 10, ts(2)), st(ME, B, 4, t3), st(C, ME, 6, ts(1)), st(C, ME, 0, t3)];
  const me = run({states: meStates, consents: vs3, snapshots: boxes});
  assert.deepEqual(me.alarms.map(a => [a.alarm, a.height]), [['reverted_to_superseded_state', 300], ['partial_setoff', 300]]);
  const r = me.alarms[0];
  assert.deepEqual([r.anchored_total, r.your_state.total, r.superseded_state.total, r.latest_state.total], ['6', '10', '6', '4']);
  assert.match(r.message, /above your state 4 \(timestamp \d+\), the lowest you may still owe on it/);
  assert.deepEqual(me.alarms[1].not_lowered, [{...edge(ME, B), before_total: '10', total: '4', anchored_total: '6'}]);
  // B, whose net moved 2 its way: no alarm (it is the one that gained), and its latest state is warned as not anchored.
  const b = monitor({keys: [B], states: [st(ME, B, 6, ts(1)), st(ME, B, 10, ts(2)), st(ME, B, 4, t3), st(B, C, 7, ts(1)), st(B, C, 1, t3)], consents: vs3, snapshots: boxes, now_ms: ts(10_000)});
  assert.deepEqual([b.ok, b.alarms, b.edges.map(e => e.status)], [true, [], ['differs_in_your_favour', 'anchored']]);
  assert.deepEqual(b.warnings.map(w => [w.warning, w.anchored_total, w.latest_state.total, w.overdue]), [['not_yet_anchored', '6', '4', true]]);
  // The same set-off anchored nowhere, and ME > B back at 6: above my latest 4, below 10, the state anchored before.
  const nowhere = run({states: meStates, consents: vs3, snapshots: [...boxes.slice(0, 2), snap(300, [[ME, B, 6], [C, ME, 6], [B, C, 7]])]});
  assert.deepEqual(kinds(nowhere), ['reverted_to_superseded_state']);
  // As issuer of a transfer: ME > B 8, then 10 (anchored); ME > B 10 to 7 and ME > C 0 to 3. The box commits ME > C 3 and
  // ME > B 8, a superseded state: I owe 11 on chain where I signed for 10.
  const x = ts(2, 999);
  const tr = run({states: [st(ME, B, 8, ts(0)), st(ME, B, 10, ts(1)), st(ME, B, 7, x), st(ME, C, 3, x)], consents: [pkg('transfer', 'vt_s', [[ME, B, 10, 7, x], [ME, C, 0, 3, x]])],
    snapshots: [snap(100, [[ME, B, 8]]), snap(200, [[ME, B, 10]]), snap(300, [[ME, B, 8], [ME, C, 3]])]});
  assert.deepEqual(kinds(tr), ['reverted_to_superseded_state', 'partial_transfer']);
  assert.match(tr.alarms[1].message, /so you owe 1 more than you signed for on chain/);
  // An earlier state at or below every state I may still owe is in my favour (the creditor's alarm): ME > B 10, 12
  // (anchored), 15; the box commits 10.
  const favour = run({states: [st(ME, B, 10, ts(1)), st(ME, B, 12, ts(2)), st(ME, B, 15, ts(3))], snapshots: [snap(100, [[ME, B, 10]]), snap(200, [[ME, B, 12]]), snap(300, [[ME, B, 10]])]});
  assert.deepEqual([kinds(favour), favour.edges[0].status], [[], 'differs_in_your_favour']);
});

test('a consent covers a decrease only from its before_total or below: a note slipped in under a set-off is not erased in silence', () => {
  // A > ME 10 (anchored), then A's note of 100 (a payment of 90 I verified), then 6, the state of a set-off I signed from
  // 10 (ME > B 8 to 4 in it). The box commits A > ME 6: I lost 94 where I agreed to lose 4.
  const s = ts(2, 998);
  const r = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 100, ts(1, 500)), st(A, ME, 6, s), st(ME, B, 8, ts(1)), st(ME, B, 4, s)],
    consents: [pkg('setoff', 'vs_b', [[A, ME, 10, 6, s], [ME, B, 8, 4, s], [B, A, 9, 5, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 8], [B, A, 9]]), snap(200, [[A, ME, 6], [ME, B, 4], [B, A, 5]])]});
  assert.deepEqual(r.alarms.map(a => [a.alarm, a.height, a.anchored_total, a.your_state.total, a.decreased_to.total, a.consents]),
    [['decrease_without_your_consent', 200, '6', '100', '6', [{consent_id: 'vs_b', before_total: '10'}]]]);
  assert.match(r.alarms[0].message, /the set-off or transfer you signed for that state lowers it from 10, not from 100, so 90 more was taken than you agreed to/);
  // Honest: a note to 12 that I had not synced when I signed the set-off from 12 to 8; my records go 10, then 8.
  const honest = run({states: [st(A, ME, 10, ts(1)), st(A, ME, 8, s), st(ME, B, 8, ts(1)), st(ME, B, 4, s)],
    consents: [pkg('setoff', 'vs_h', [[A, ME, 12, 8, s], [ME, B, 8, 4, s], [B, A, 9, 5, s]])],
    snapshots: [snap(100, [[A, ME, 10], [ME, B, 8], [B, A, 9]]), snap(200, [[A, ME, 8], [ME, B, 4], [B, A, 5]])]});
  assert.deepEqual([honest.ok, honest.alarms], [true, []]);
});

test('the operator\'s anchoring cannot make the monitor throw or turn overdue off; a timestamp past JavaScript\'s Date range is unreadable', () => {
  // One run with an alarm (my retained 3 dropped) and a warning (a new note of 5 not anchored yet).
  const states = [st(A, ME, 3, ts(1), {anchored: {box_id: box(100), height: 100}}), st(B, ME, 5, ts(20))];
  const snapshots = [snap(200, [])], due = ts(20) + 300_000 + ANCHOR_GRACE_MS;
  const check = (anchoring, now_ms = due + 1) => {
    const r = run({states, snapshots, anchoring, now_ms});
    assert.deepEqual([kinds(r), r.warnings.length], [['decrease_without_your_consent'], 1], JSON.stringify(anchoring));
    return r.warnings[0];
  };
  // The server's interval counts up to the testnet's 300 s: a longer one, a huge one or junk cannot delay overdue.
  for (const anchoring of [null, {check_interval_seconds: 300}, {check_interval_seconds: 3e8}, {check_interval_seconds: 1e13}, {check_interval_seconds: -5}, {check_interval_seconds: 'x'}]) {
    assert.deepEqual(Object.entries(check(anchoring)).filter(([k]) => ['overdue', 'expected_by'].includes(k)), [['expected_by', new Date(due).toISOString()], ['overdue', true]], JSON.stringify(anchoring));
  }
  assert.equal(check({check_interval_seconds: 60}, ts(20) + 60_000 + ANCHOR_GRACE_MS + 1).overdue, true, 'a shorter one counts');
  // A used-up daily cap delays it to the reset, at most a day after the state: a reset at the end of the Date range, or
  // one that is no time, does not delay it further.
  const capped = resets_at => ({check_interval_seconds: 300, daily_cap: {limit: 50, signed_today: 50, resets_at}});
  const day = due + 864e5, far = check(capped('+275760-09-13T00:00:00.000Z'), day + 1);
  assert.deepEqual([far.overdue, far.expected_by], [true, new Date(day).toISOString()]);
  assert.equal(check(capped('soon')).overdue, true);
  // A state at the end of the Date range: no expected time and no throw.
  const end = run({states: [st(B, ME, 5, MAX_TIMESTAMP_MS)], snapshots, now_ms: ts(1)});
  assert.deepEqual([end.warnings[0].expected_by, end.warnings[0].overdue], [null, false]);
  assert.match(end.warnings[0].message, /expected by a time past JavaScript's Date range/);
  // Past it: unreadable, as a state and as a consent.
  assert.deepEqual(run({states: [st(A, ME, 3, 9e15)], snapshots: [snap(100, [[A, ME, 3]])]}).alarms.map(a => a.cause), ['record_unreadable', 'state_not_held']);
  const consent = run({states: [st(A, ME, 3, ts(1))], consents: [pkg('setoff', 'vs_t', [[A, ME, 3, 1, 9e15], [ME, B, 2, 0, 9e15]])], snapshots: [snap(100, [[A, ME, 3]])]});
  assert.deepEqual(consent.alarms.map(a => a.cause), ['consent_unreadable']);
});

// The decisive case, on the live vectors: the operator commits and publishes a tree with one creditor's edge lowered.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'ops', 'anchor-audit.mjs');
const vectors = path.join(root, 'test', 'fixtures', 'anchor-vectors');
test('a consistent tamper passes the full audit (MATCH) and the creditor\'s monitor alarms, citing its signed state, the box and the height', async t => {
  const need = [script, path.join(vectors, '645189.responses.json'), path.join(vectors, '645189.json')], missing = need.filter(f => !fs.existsSync(f));
  if (missing.length) {
    if (!fs.existsSync(path.join(root, '.synced-from')) && process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.map(f => path.relative(root, f)).join(', ')}`);
    return t.skip('needs scripts/ops/anchor-audit.mjs and the live vectors, which the public copy and the container image do not have');
  }
  const A = await import(pathToFileURL(script).href);
  const v = JSON.parse(fs.readFileSync(path.join(vectors, '645189.responses.json'), 'utf8')), vec = JSON.parse(fs.readFileSync(path.join(vectors, '645189.json'), 'utf8'));
  const rows = v.ledger.notes.map(n => ({issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, denomination: 'erg', total: String(n.total)}));
  // The creditor: the holder of the testnet house issuer's 3,000,000 IOU, its first such note.
  const house = '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf';
  const i = v.ledger.notes.findIndex(n => n.issuer_pubkey === house && n.total === 3_000_000 && n.redeemed === 0), note = v.ledger.notes[i];
  const creditor = note.recipient_pubkey;
  const real = {box_id: vec.box_id, height: vec.height, digest: vec.r5_digest, rows};
  assert.equal(digest(rows), vec.r5_digest, 'the real anchor');
  // The operator's next box: the same tree with that edge lowered to 2,000,000, and the same rows published.
  const tampered = rows.map((r, j) => (j === i ? {...r, total: '2000000'} : r)), d = digest(tampered), H = vec.height + 61, boxId = 'ab'.repeat(32);
  const chain = {...v.chain[1], anchoring: {...v.chain[1].anchoring, local_digest: d, confirmed_digest: d, confirmed_box_id: boxId, confirmed_height: H}};
  const item = {...v.explorer_unspent_by_token.items[0], boxId, creationHeight: H, settlementHeight: H + 1, transactionId: 'cd'.repeat(32),
    additionalRegisters: {...v.explorer_unspent_by_token.items[0].additionalRegisters, R5: {serializedValue: `64${d}032000`, sigmaType: null, renderedValue: null}}};
  const fetchImpl = async url => {
    const u = new URL(url), j = b => new Response(JSON.stringify(b), {status: 200});
    if (u.pathname === '/pilot/v1/chain') return j(chain);
    if (u.pathname === '/pilot/v1/ledger/committed') return new Response('{"error":"unauthorized"}', {status: 401});
    if (u.pathname === '/pilot/v1/ledger') return j({unit: 'nanoERG', notes: v.ledger.notes.map((n, j2) => (j2 === i ? {...n, total: 2_000_000, outstanding: 2_000_000} : n))});
    if (u.pathname.endsWith(`/boxes/unspent/byTokenId/${chain.tracker_nft_id}`)) return j({items: [item], total: 1});
    if (u.pathname.endsWith('/networkState')) return j({height: H + 3});
    return new Response('{}', {status: 404});
  };
  const audit = await A.audit({server: 'https://valun.test', explorer: 'https://explorer.test', fetchImpl, settleMs: 0, sleep: async () => {}, cover: false, trackerNft: chain.tracker_nft_id});
  assert.deepEqual([audit.verdict, audit.exit, audit.box.box_id, audit.box.height, audit.data.rows], ['MATCH', 0, boxId, H, 251], 'publish and anchor agree: the audit passes');
  // The creditor's monitor: its retained signed states of every edge it is party to (anchored at the real box: what
  // its client verified there), the real snapshot and the operator's.
  const statesOf = key => v.ledger.notes.filter(n => n.issuer_pubkey === key || n.recipient_pubkey === key).map(n => ({issuer_pubkey: n.issuer_pubkey,
    recipient_pubkey: n.recipient_pubkey, denomination: 'erg', total: String(n.total), timestamp: n.timestamp, signature: `${n.timestamp}`.padStart(130, 'a'),
    anchored: {box_id: vec.box_id, height: vec.height}}));
  const mine = statesOf(creditor), signed = mine.find(s => s.issuer_pubkey === house && s.total === '3000000');
  assert.ok(mine.length > 1 && signed, 'the creditor has other edges too');
  const next = {box_id: audit.box.box_id, height: audit.box.height, digest: audit.box.digest, rows: tampered};
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const r = monitor({keys: [creditor], states: mine, snapshots: [real, next], now_ms: now});
  assert.equal(r.ok, false);
  assert.deepEqual(r.alarms.map(a => [a.alarm, a.role, a.edge.issuer_pubkey, a.box_id, a.height, a.anchored_total, a.your_state]),
    [['decrease_without_your_consent', 'creditor', house, boxId, H, '2000000', {total: '3000000', timestamp: note.timestamp, signature: signed.signature}]]);
  assert.match(r.alarms[0].message, new RegExp(`the box of height ${H} commits 2000000 on ${house}>${creditor}>erg, below your state 3000000`));
  assert.deepEqual(r.warnings, []);
  // The real anchor alone raises nothing; the retained state alone (no earlier snapshot kept) is enough.
  assert.deepEqual(monitor({keys: [creditor], states: mine, snapshots: [real], now_ms: now}).alarms, []);
  // The snapshot as GET /ledger/committed serves its rows (debt_key, committed_total), with R5's digest: the same alarm.
  const served = {...next, rows: tampered.map(({total, ...x}) => ({debt_key: 'not read here', ...x, committed_total: total}))};
  assert.deepEqual(monitor({keys: [creditor], states: mine, snapshots: [served], now_ms: now}).alarms.map(a => [a.alarm, a.anchored_total]), [['decrease_without_your_consent', '2000000']]);
  const both = {...next, rows: tampered.map(x => ({...x, committed_total: x.total}))};
  assert.deepEqual(monitor({keys: [creditor], states: mine, snapshots: [both], now_ms: now}).alarms.map(a => a.cause), ['snapshot_unreadable', 'no_snapshot']);
  assert.deepEqual(monitor({keys: [creditor], states: mine, snapshots: [next], now_ms: now}).alarms.map(a => [a.alarm, a.height]), [['decrease_without_your_consent', H]]);
  // The issuer's monitor sees a total it never signed, below its own: unknown (never a pass), and no alarm of loss.
  const houseView = monitor({keys: [house], states: statesOf(house), snapshots: [real, next], now_ms: now});
  assert.deepEqual(houseView.alarms.map(a => [a.alarm, a.cause, a.edge.recipient_pubkey]), [['unknown', 'state_not_signed', creditor]]);
});
