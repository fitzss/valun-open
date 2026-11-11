// Circulating credit, fix round after phase 1 (decisions D-1 and D-2), at the unit level: a Pilot in circulation mode on
// over a stub tracker (its capabilities validate and its binary is pinned) and a throwaway store, so these run with any
// tracker binaries, in the default `npm test`. The same rules are also exercised against the real tracker v3.2 in
// transfer.test.mjs, setoff.test.mjs and sandbox.test.mjs.
//   - D-1 across kinds: a payment by transfer waits for every one of the payer's own bound notes the tracker did not
//     record (failed, stale, rejected, voided, replaced, refused when posted), not only a failed one; an ordinary one
//     that can still be recorded refuses it (pending_unbound_note), and next_actions never offer what the route refuses;
//   - D-2 b: attempts refused when posted count for the windows and the set-off holds; during a signature-checker
//     outage they are recorded unverified;
//   - D-2 c: no set-off on a pair with a held note or a payment attempt (held_note / payment_attempt);
//   - D-2 e: an attempt Valun's own edge journal proves dead never blocks;
//   - a server-only set-off edge made again never reuses its own earlier timestamp (one operation per (edge, ts));
//   - GET /clearing is single-flight; credit_note.pair_changes_since reads the journal file at most once;
//   - novation records are pruned (design §11); the signer's records file replaces a stale .tmp; with circulation off
//     sandbox-keys.json is written as v15 writes it.
// Fix round 2 (with SV-8):
//   - the journal fails closed: a pilot-edge-log.jsonl that cannot be read (not one that does not exist) proves no
//     attempt dead, is not kept as the index, and refuses a GET /edges page that needs it;
//   - D-2 c: recording a refused attempt supersedes a collecting set-off on its edge at once; D-2 f also in mode bound;
//   - D-2 b: a refused ordinary note at a reserved residue is no attempt;
//   - decideApproval (every mode): an offer or held acceptance a concurrent read expires during the mandate check is
//     not revived.
// Run: node --test test/circulation-fixes.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../lib/pilot/core.mjs';
import {appendEntries, EDGE_LOG_FILE} from '../lib/pilot/journal.mjs';
import {fallbackAfter, MAX_AGE_MS} from '../lib/pilot/novation.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {Sandbox} from '../lib/pilot/sandbox.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const sigSha = s => crypto.createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex');
const H = 3600e3, DAY = 24 * H, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
// A timestamp ending in `ms` a little before `t`.
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;

// A Pilot in mode on (or `mode`) over a stub tracker: `edges` (Map '<issuer>><recipient>' -> tracker note or undefined)
// is what basis.note() reads. P pays every deal, Q is paid, A and B are other participants. `clock.t` is the Pilot's clock.
function world({clock = {t: Date.now()}, mode = 'on'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-fixes-')); dirs.push(dir);
  const edges = new Map();
  // priorAckMessage (tracker v3.2's PA) goes through whatever noteMessage a test sets, so a helper outage covers both.
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async (i, r) => edges.get(`${i}>${r}`) ?? null, capabilities: async () => V3_CAPS,
    async priorAckMessage(a) { return this.noteMessage({issuer: a.issuer, recipient: a.recipient, total: a.priorTotal, timestamp: a.timestamp}); }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, mode);
  const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE, auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'},
    mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null});
  const [P, Q, A, B] = ['fx-payer', 'fx-payee', 'fx-issuer', 'fx-other'].map(person);
  for (const x of [P, Q, A, B]) pilot.s.participants[x.id] = x;
  return {pilot, edges, clock, dir, P, Q, A, B};
}
function addDeal(w, status, {price = 3} = {}) {
  const {pilot, P, Q, clock} = w, id = 'vd_' + hex(8);
  const terms = {deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, service: {title: 'fx job', description: 'synthetic', deliverable: 'text'},
    price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
  const v = {v: 1, by: P.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
  const d = {id, payer: P.id, payee: Q.id, created_at: iso(clock.t), status, versions: [v], history: [], agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)},
    delivery: {by: Q.id, sha256: hex(32), content: 'x', at: iso(clock.t)}};
  pilot.s.deals[id] = d;
  return d;
}
const note = (total, timestamp, signature = '02' + hex(64)) => ({amount_collected: String(total), amount_redeemed: '0', timestamp, signature});
// A journal entry Valun recorded on edge I>R (an issued note): the edge went from total_after - delta to total_after at ts.
const journal = (w, I, R, delta, totalAfter, ts) => appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: totalAfter, timestamp: ts, signature: '02' + hex(64)}]);

test('D-1 across kinds: a payment by transfer waits for each of the payer\'s own bound notes the tracker did not record (rejected by its owner, voided by a revocation, stale, replaced, refused when posted), not only a failed one; the journal proves one dead (D-2 e)', async () => {
  const w = world(), {pilot, P, Q, clock} = w, k = `${P.pubkey}>${Q.pubkey}`, ts = ending(clock.t - 5000, 997);
  const bound = {total: 3, timestamp: ts, signature: '02' + hex(64), prior_signature: '02' + hex(64)};
  const route = {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5};
  const cases = [
    ['rejected by the owner', d => { d.rejected_notes = [{state: 'rejected_by_owner', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {...bound}, prior_total: 0, amount: 3}]; }],
    ['voided by a revocation', d => { d.void_notes = [{state: 'void_key_revoked', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {...bound}, prior_total: 0, amount: 3}]; }],
    ['stale for its owner', d => { d.credit_note = {state: 'stale', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {...bound}, prior_total: 0, amount: 3}; }],
    ['replaced by a newer note', d => { d.replaced_notes = [{state: 'failed', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, prior_total: 0, note: {total: 3, timestamp: ts, bound: true, signature_sha256: sigSha(bound.signature)}}]; }],
    ['refused when posted', d => { d.refused_attempts = [{kind: 'note', bound: true, timestamp: ts, edges: [{edge: k, prior_total: 0, new_total: 3}], signature_sha256: {note: sigSha(bound.signature)}, code: 'stale_terms', at: iso(clock.t)}]; }],
  ];
  for (const [what, set] of cases) {
    const d = addDeal(w, 'payment_due');
    set(d);
    const b = await pilot.paymentBlock(d, route);
    assert.equal(b?.code, 'transfer_window_open', `${what}: ${JSON.stringify(b)}`);
    assert.ok(Math.abs(b.retry_after_ms - (fallbackAfter(ts) - clock.t)) <= 2, `${what}: until the note's timestamp + 1 h + 60 s`);
    assert.deepEqual(pilot.view(d, P).next_actions, ['complete', 'wait_for_transfer_window'], `${what}: next_actions say so`);
    assert.equal(await pilot.paymentBlock(d, {route: 'note'}), null, `${what}: another own note is not restricted by the server`);
  }
  // The note shown on the tracker as is: it applied (already_paid).
  const d1 = addDeal(w, 'payment_due');
  d1.rejected_notes = [{state: 'rejected_by_owner', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {...bound}, prior_total: 0, amount: 3}];
  w.edges.set(k, note(3, ts, bound.signature));
  assert.deepEqual(await pilot.paymentBlock(d1, route), {code: 'already_paid'});
  w.edges.delete(k);
  // After its timestamp + 1 h + 60 s it can no longer apply.
  clock.t = fallbackAfter(ts) + 1;
  assert.equal(await pilot.paymentBlock(d1, route), null, 'dead by age');
  clock.t = ts + 5000;
  // D-2 e: the first journal entry on the pair after the note's timestamp left the pair's total at the note's own prior
  // (another deal's note, recorded at a later timestamp): the note never applied and never can.
  assert.equal((await pilot.paymentBlock(d1, route))?.code, 'transfer_window_open');
  journal(w, P, Q, 2, 2, ts + 1000);
  assert.equal(await pilot.paymentBlock(d1, route), null, 'proven dead by the journal');
  assert.deepEqual(pilot.view(d1, P).next_actions, ['complete', 'pay_by_transfer']);
  // Not when that first entry changed the pair from another total (the note may have applied first): it still waits.
  const w2 = world(), d2 = addDeal(w2, 'payment_due'), ts2 = ending(w2.clock.t - 5000, 997);
  d2.rejected_notes = [{state: 'rejected_by_owner', issuer_pubkey: w2.P.pubkey, recipient_pubkey: w2.Q.pubkey, note: {...bound, timestamp: ts2}, prior_total: 0, amount: 3}];
  journal(w2, w2.P, w2.Q, 2, 5, ts2 + 1000);                               // 3 -> 5: as if the note had applied
  assert.equal((await w2.pilot.paymentBlock(d2, route))?.code, 'transfer_window_open', 'the journal does not prove it dead');
});

test('D-1: an ordinary note the payer signed that the tracker did not record never expires: a transfer is refused (pending_unbound_note) and not offered while it could still be recorded', async () => {
  const w = world(), {pilot, P, Q, clock} = w, k = `${P.pubkey}>${Q.pubkey}`, ts = ending(clock.t - 5000, 500);
  const d = addDeal(w, 'note_failed');
  d.credit_note = {state: 'failed', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {total: 3, timestamp: ts, signature: '02' + hex(64)}, prior_total: 0, amount: 3, error: 'x'};
  const route = {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5};
  assert.deepEqual(await pilot.paymentBlock(d, route), {code: 'pending_unbound_note'});
  const e = pilot.paymentBlockError({code: 'pending_unbound_note'});
  assert.deepEqual([e.code, e.status], ['pending_unbound_note', 409]);
  assert.deepEqual(pilot.view(d, P).next_actions, ['complete']);
  clock.t += 10 * H;
  assert.deepEqual(await pilot.paymentBlock(d, route), {code: 'pending_unbound_note'}, 'an ordinary note has no maximum age');
  w.edges.set(k, note(4, ts + 10));                                        // the tracker shows the pair past it
  assert.equal(await pilot.paymentBlock(d, route), null);
});

test('D-2 b: an attempt refused when posted counts for the D-1 windows (another kind waits, and so does the same note on another prior state; the identical operation and, when the record names its prior state, a transfer on the same prior state do not) and for the set-off holds of the payer\'s own edge; the journal proves one dead', async () => {
  const w = world(), {pilot, P, Q, A, clock} = w, T = ending(clock.t - 5000, 999), p = T - 20e3;
  const AP = `${A.pubkey}>${P.pubkey}`, AQ = `${A.pubkey}>${Q.pubkey}`, d = addDeal(w, 'delivered');
  // A record without the from-edge's prior timestamp (as written before tracker v3.2) never exempts anything.
  d.refused_attempts = [{kind: 'transfer', timestamp: T, issuer: {id: A.id, pubkey: A.pubkey}, amount: 3, code: 'transfer_stale', at: iso(clock.t),
    edges: [{which: 'from', edge: AP, prior_total: 5, new_total: 2}, {which: 'to', edge: AQ, prior_total: 0, new_total: 3}], signature_sha256: {[`${AP}:prior`]: hex(32)}}];
  const own = await pilot.paymentBlock(d, {route: 'note'});
  assert.equal(own?.code, 'transfer_window_open');
  assert.ok(Math.abs(own.retry_after_ms - (fallbackAfter(T) - clock.t)) <= 2);
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'dispute']);
  const same = await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p});
  assert.equal(same?.code, 'transfer_window_open', 'no prior state recorded: the same note at a new T (a template) waits');
  assert.ok(Math.abs(same.retry_after_ms - (fallbackAfter(T) - clock.t)) <= 2, JSON.stringify(same));
  assert.equal((await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, timestamp: T + 1000}))?.code, 'transfer_window_open', 'the same note on the same prior at a later T waits');
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, timestamp: T}), null, 'the identical operation (the same note, prior and T) is not held back');
  assert.equal((await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 4, timestamp: T}))?.code, 'transfer_window_open', 'another prior waits');
  // The record names its prior state (tracker v3.2): a transfer on that state does not wait, one on another does.
  d.refused_attempts[0].edges[0].prior_timestamp = p;
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}), null, 'the same prior state (total and timestamp)');
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p, timestamp: T + 1000}), null, 'the same prior state, posted at a later T');
  assert.equal((await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p + 1}))?.code, 'transfer_window_open', 'the same total at another timestamp waits');
  assert.equal((await pilot.paymentBlock(d, {route: 'note'}))?.code, 'transfer_window_open', 'an own note still waits');
  delete d.refused_attempts[0].edges[0].prior_timestamp;
  // The set-off holds: the payer's own claim (the from-edge), not the issuer's edge to the payee.
  const holds = pilot.paymentAttemptHolds();
  assert.deepEqual([holds.get(AP), holds.has(AQ)], [T, false]);
  // D-2 e: the first journal entry on the from-edge after T changed it from exactly the attempt's prior (5).
  journal(w, A, P, 1, 6, T + 1000);
  assert.equal(await pilot.paymentBlock(d, {route: 'note'}), null, 'proven dead by the journal');
});

test('D-2 b during a signature-checker outage: a payment the payer posted and that was refused is recorded unverified (the payer\'s client keeps it, so it counts for the windows and the set-off holds like any other; its audit line says so); once the checker answers, a signature that does not verify is no attempt', async () => {
  const w = world(), {pilot, P, Q, A, clock} = w, T = ending(clock.t - 5000, 999);
  const AP = `${A.pubkey}>${P.pubkey}`, AQ = `${A.pubkey}>${Q.pubkey}`, PQ = `${P.pubkey}>${Q.pubkey}`;
  // The signer helper as Basis reports it: 'down' (a timeout: the note message cannot be built either), 'check-down'
  // (the message is built, the check times out), 'up' (every signature verifies) or 'bad' (none does).
  let helper = 'down';
  pilot.basis.noteMessage = async () => { if (helper === 'down') throw Object.assign(new Error('signer timed out'), {code: 'signer_unavailable'}); return {message_hex: '00'.repeat(80)}; };
  pilot.basis.verify = async () => { if (helper === 'down' || helper === 'check-down') throw new Error('signer timed out'); return helper === 'up'; };
  const outage = new PilotError('signer_unavailable', 'signature checking is temporarily unavailable; nothing was recorded; try again', 503);
  const p = T - 20e3;
  const body = () => ({issuer_id: A.id, timestamp: T, from_prior_total: 5, to_prior_total: 0, from_prior_timestamp: p, to_prior_timestamp: 0,
    signatures: {[`${AP}:prior`]: '02' + hex(64), [`${AP}:new`]: '02' + hex(64), [`${AQ}:new`]: '02' + hex(64)}});
  const audit = () => fs.readFileSync(path.join(w.dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'payment.refused_attempt');
  // A payment by transfer.
  const d = addDeal(w, 'delivered'), b = body();
  await pilot.recordRefusedTransfer(P, d.id, b, outage);
  assert.equal(d.refused_attempts?.length, 1, 'recorded although its signatures could not be checked');
  const [r] = d.refused_attempts;
  assert.deepEqual([r.kind, r.timestamp, r.unverified, r.code, r.edges.map(e => [e.which, e.edge, e.prior_total, e.prior_timestamp, e.new_total])],
    ['transfer', T, true, 'signer_unavailable', [['from', AP, 5, p, 2], ['to', AQ, 0, 0, 3]]]);
  assert.deepEqual(r.signature_sha256, Object.fromEntries(Object.entries(b.signatures).map(([k, s]) => [k, sigSha(s)])));
  assert.ok(!Object.values(b.signatures).some(s => JSON.stringify(r).includes(s)), 'no signature in the record');
  assert.equal((await pilot.paymentBlock(d, {route: 'note'}))?.code, 'transfer_window_open', 'another kind of payment waits for its window');
  assert.equal((await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}))?.code, 'transfer_window_open',
    'recorded unverified: even the same prior state waits (its prior state is only what the post claimed)');
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, timestamp: T}), null, 'the identical operation is not held back');
  assert.equal(pilot.paymentAttemptHolds().get(AP), T, 'the payer\'s claim is held for set-offs');
  assert.deepEqual(audit().map(l => [l.deal, l.kind, l.code, l.unverified]), [[d.id, 'transfer', 'signer_unavailable', true]]);
  const v = JSON.stringify(pilot.view(d, P));
  assert.ok(!v.includes('unverified') && !v.includes('refused_attempts') && !v.includes(r.signature_sha256[`${AP}:prior`]), 'never shown');
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'dispute']);
  // Once the checker answers: a payment whose signatures do not verify is no attempt; one whose signatures verify is
  // recorded as before (verified).
  const d2 = addDeal(w, 'delivered');
  helper = 'bad';
  await pilot.recordRefusedTransfer(P, d2.id, body(), new PilotError('stale_terms', 'hashes do not match', 409));
  assert.equal(d2.refused_attempts, undefined, 'a signature that does not verify: nothing recorded');
  helper = 'up';
  await pilot.recordRefusedTransfer(P, d2.id, body(), new PilotError('stale_terms', 'hashes do not match', 409));
  assert.deepEqual(d2.refused_attempts.map(x => [x.code, Object.hasOwn(x, 'unverified')]), [['stale_terms', false]]);
  assert.equal(await pilot.paymentBlock(d2, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}), null, 'verified: the same prior state is exempt');
  // A post that asserts no prior timestamps (not a v3.2 client): its prior slot is checked over the from-edge's state as
  // it is now, and that state is what the record keeps; with no note on the edge, (5, 0).
  const d2b = addDeal(w, 'delivered'), {from_prior_timestamp: _f, to_prior_timestamp: _t, ...bare} = body();
  w.edges.set(AP, note(5, p - 5));
  await pilot.recordRefusedTransfer(P, d2b.id, bare, new PilotError('stale_terms', 'hashes do not match', 409));
  assert.deepEqual(d2b.refused_attempts.map(x => x.edges.map(e => e.prior_timestamp)), [[p - 5, null]]);
  w.edges.delete(AP);
  // A prior timestamp at or after T, or not a whole number: no attempt the tracker could take, nothing recorded.
  for (const bad of [{from_prior_timestamp: T}, {from_prior_timestamp: -1}, {to_prior_timestamp: T + 1}, {from_prior_timestamp: '5'}]) {
    const dx = addDeal(w, 'delivered');
    await pilot.recordRefusedTransfer(P, dx.id, {...body(), ...bad}, new PilotError('stale_terms', 'hashes do not match', 409));
    assert.equal(dx.refused_attempts, undefined, JSON.stringify(bad));
  }
  // A credit note of the payer's (an ordinary one; prior = its total less the price), with the check alone down.
  helper = 'check-down';
  const d3 = addDeal(w, 'delivered'), n = {total: 3, timestamp: ending(clock.t - 4000, 500), signature: '02' + hex(64)};
  await pilot.recordRefusedNote(P, d3.id, n, outage);
  assert.deepEqual((d3.refused_attempts ?? []).map(x => [x.kind, x.bound, x.unverified, x.timestamp, x.edges[0].edge, x.edges[0].prior_total, x.edges[0].new_total, x.signature_sha256.note]),
    [['note', false, true, n.timestamp, PQ, 0, 3, sigSha(n.signature)]]);
  assert.ok(pilot.ownNoteAttempts(d3).some(a => a.edge === PQ && a.timestamp === n.timestamp), 'it is one of the payer\'s own note attempts');
  helper = 'bad';
  const d4 = addDeal(w, 'delivered');
  await pilot.recordRefusedNote(P, d4.id, {...n, signature: '02' + hex(64)}, new PilotError('stale_terms', 'x', 409));
  assert.equal(d4.refused_attempts, undefined, 'a note whose signature does not verify: nothing recorded');
});

test('D-2 c: a set-off never applies on a pair with a note held for its owner (held_note) or on an edge a payment attempt would change (payment_attempt); a collecting one is superseded, and the engine\'s housekeeping supersedes one too', async () => {
  const w = world(), {pilot, P, Q, A, clock} = w, PQ = `${P.pubkey}>${Q.pubkey}`, QP = `${Q.pubkey}>${P.pubkey}`;
  const setoff = (edges, id = 'vs_' + hex(8)) => {
    const at = iso(clock.t), ts = ending(clock.t - 3000, 998);
    pilot.s.setoffs[id] = {id, kind: 'setoff', state: 'collecting', created_at: at, expires_at: iso(clock.t + 30 * 60e3), updated_at: at, network: 'valun-pilot-1', tracker_nft_id: '0'.repeat(64),
      denomination: PILOT_DENOMINATION, amount: 2 * edges.length, members: [P.id, Q.id],
      edges: edges.map(([k, I, R]) => ({edge: k, issuer: {id: I.id, pubkey: I.pubkey}, recipient: {id: R.id, pubkey: R.pubkey}, decrease: 2, before: {total: 5, timestamp: ts - 5000, signature: '02' + hex(64)},
        new_total: 3, timestamp: ts, revision: 1, server_only: false, slots: {issuer: {signature: '02' + hex(64), by: I.id, at}, recipient: {signature: '02' + hex(64), by: R.id, at}}})),
      cycles: [], edge_set: hex(16), per_edge_timestamps: true, source: 'batch', run_id: null, messages: {}, result: null, history: []};
    return pilot.s.setoffs[id];
  };
  // A held note on P>Q.
  const held = addDeal(w, 'completion_awaiting_owner');
  held.credit_note = {state: 'signed', approval_id: 'va_' + hex(6), issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {total: 5, timestamp: ending(clock.t - 2000, 997), signature: '02' + hex(64), prior_signature: '02' + hex(64)}, prior_total: 2, amount: 3};
  const o1 = setoff([[PQ, P, Q], [QP, Q, P]]);
  assert.equal(pilot.setoffPaymentBlock(o1), 'held_note');
  const r1 = await pilot.applySetoff(o1);
  assert.deepEqual([r1.state, r1.result.code], ['superseded', 'held_note'], 'whatever its timestamps: the held note is later or earlier');
  assert.ok(o1.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  held.status = 'note_issued'; held.credit_note.state = 'recorded';
  // An earlier attempt of a deal not yet paid on A>P (a cancelled transfer), with the set-off's timestamp BEFORE it:
  // under D-1 alone it would have applied; under D-2 c it never does.
  const due = addDeal(w, 'payment_due'), T = ending(clock.t - 1000, 999), AP = `${A.pubkey}>${P.pubkey}`, PA = `${P.pubkey}>${A.pubkey}`;
  pilot.s.transfers.vt_0000000000000001 = {id: 'vt_0000000000000001', kind: 'transfer', deal_id: due.id, state: 'cancelled', timestamp: T, amount: 2, fallback_after: fallbackAfter(T),
    issuer: {id: A.id, pubkey: A.pubkey}, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, created_at: iso(clock.t), updated_at: iso(clock.t), expires_at: iso(clock.t),
    from_edge: {edge: AP, before: {total: 5, timestamp: 1, signature: '02' + hex(64)}, new_total: 3, revision: 1}, to_edge: {edge: `${A.pubkey}>${Q.pubkey}`, before: null, new_total: 2, revision: 1},
    slots: {}, messages: {}, history: [], result: {code: 'cancelled_by_payer'}};
  due.transfer_ids = ['vt_0000000000000001'];
  const o2 = setoff([[AP, A, P], [PA, P, A]]);
  o2.members = [A.id, P.id];
  assert.ok(o2.edges[0].timestamp < T, 'precondition: the set-off\'s timestamp precedes the attempt\'s');
  assert.deepEqual([(await pilot.applySetoff(o2)).state, o2.result.code], ['superseded', 'payment_attempt']);
  // A collecting (not complete) one is superseded by the engine's housekeeping, and when an attempt appears on its edge.
  const o3 = setoff([[AP, A, P], [PA, P, A]]);
  o3.members = [A.id, P.id]; o3.edges[0].slots.issuer = null;
  pilot.setoffHousekeeping();
  assert.deepEqual([o3.state, o3.result?.code], ['superseded', 'payment_attempt']);
  const o4 = setoff([[PQ, P, Q], [QP, Q, P]]);
  o4.edges[0].slots.issuer = null;
  assert.deepEqual(pilot.supersedeSetoffsOn([PQ], 'held_note'), [o4.id]);
  assert.deepEqual([o4.state, o4.result.code], ['superseded', 'held_note']);
  // Once the deal is paid, the hold ends.
  due.status = 'paid_by_transfer';
  assert.equal(pilot.paymentAttemptHolds().has(AP), false);
});

test('a server-only set-off edge made again takes a timestamp after every set-off timestamp on the edge, its own earlier one included (one operation per (edge, timestamp))', async () => {
  const clock = {t: 0}, w = world({clock}), {pilot, A, B} = w, k = `${A.pubkey}>${B.pubkey}`;
  const prev = ending(Date.now() - 10000, 998), st = {total: 5, timestamp: prev - 3000, signature: '02' + hex(64)};
  const o = {id: 'vs_' + hex(8), kind: 'setoff', state: 'collecting', created_at: iso(prev), expires_at: iso(prev + 30 * 60e3), updated_at: iso(prev), members: [A.id, B.id],
    edges: [{edge: k, issuer: {id: A.id, pubkey: A.pubkey}, recipient: {id: B.id, pubkey: B.pubkey}, decrease: 2, before: st, new_total: 3, timestamp: prev, revision: 1, server_only: true,
      slots: {issuer: null, recipient: null}}], per_edge_timestamps: true, messages: {}, history: [], result: null};
  pilot.s.setoffs[o.id] = o;
  // This server's clock is where the largest timestamp ending in 998 ms at least 1.5 s back is this set-off's own
  // earlier one: the edge must not be signed again there.
  clock.t = prev + 1500 + 400;
  const step = await pilot.refreshSetoff(o, [note(st.total, st.timestamp, st.signature)], new Map());
  assert.ok(step.status === 'waiting' || step.fresh.get(k).timestamp > prev, JSON.stringify(step.status === 'ready' ? step.fresh.get(k) : step));
  assert.equal(step.status, 'waiting', 'no timestamp after its own earlier one yet');
  clock.t = prev + 1500 + 1100;
  const later = await pilot.refreshSetoff(o, [note(st.total, st.timestamp, st.signature)], new Map());
  assert.deepEqual([later.status, later.fresh.get(k).timestamp], ['ready', prev + 1000]);
});

test('GET /clearing is single-flight: requests that arrive while it is computed share that computation; one that failed is not kept', async () => {
  let calls = 0, fail = false;
  const pilot = {circulating: true, publicClearing: async () => { calls++; await new Promise(r => setTimeout(r, 60)); if (fail) throw new Error('tracker down'); return {calls}; }};
  const handle = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}});
  const get = async () => {
    let out;
    const send = (res, status, body) => { out = {status, body}; };
    await handle({method: 'GET', headers: {}, socket: {remoteAddress: '127.0.0.1'}}, {}, new URL('http://x/pilot/v1/clearing'), send, () => '127.0.0.1');
    return out;
  };
  const answers = await Promise.all(Array.from({length: 8}, get));
  assert.equal(calls, 1, 'computed once for eight concurrent requests');
  assert.ok(answers.every(a => a.status === 200 && a.body.calls === 1));
  // A computation that fails is dropped: the next request (with a fresh handler, the cache being per handler) computes again.
  const h2 = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}});
  const get2 = async () => {
    const send = () => {};
    return h2({method: 'GET', headers: {}, socket: {remoteAddress: '127.0.0.1'}}, {}, new URL('http://x/pilot/v1/clearing'), send, () => '127.0.0.1');
  };
  calls = 0; fail = true;
  await assert.rejects(Promise.all([get2(), get2()]), /tracker down/);
  assert.equal(calls, 1);
  fail = false;
  await get2();
  assert.equal(calls, 2, 'computed again after the failure');
});

test('credit_note.pair_changes_since comes from the journal\'s per-edge index: views of many deals read pilot-edge-log.jsonl at most once, with the same answer', async () => {
  const w = world(), {pilot, P, Q, A} = w, k = `${P.pubkey}>${Q.pubkey}`;
  // 600 entries on other edges push the pair's notes out of the in-memory tail (500 entries).
  const deals = [];
  for (let i = 0; i < 3; i++) {
    const d = addDeal(w, 'note_issued', {price: 1});
    const [e] = journal(w, P, Q, 1, i + 1, 1000 + i);
    d.journal_seq = e.seq; d.credit_note = {state: 'recorded', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {total: i + 1, timestamp: 1000 + i, signature: '02' + hex(64)}, amount: 1};
    deals.push(d);
  }
  appendEntries(pilot, [{kind: 'transfer_out', ref: 'vt_00000000000000aa', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, delta: -1, total_after: 2, timestamp: 2000, signature: '02' + hex(64)}]);
  for (let i = 0; i < 600; i++) appendEntries(pilot, [{kind: 'issue', ref: 'vd_x', issuer_pubkey: A.pubkey, recipient_pubkey: Q.pubkey, delta: 1, total_after: i + 1, timestamp: 3000 + i, signature: '02' + hex(64)}]);
  pilot.save();
  assert.ok(pilot.s.edge_log_tail[0].seq > deals[0].journal_seq, 'precondition: the pair\'s entries are only in the log file now');
  // A fresh Pilot over the same store (as after a restart): its index is built on first use.
  const p2 = new Pilot({store: new PilotStore(w.dir), basis: pilot.basis, now: () => w.clock.t, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  // The journal streams the log file (SV-ROB-1: fs.openSync, never one readFileSync of it): count both.
  const read = fs.readFileSync, open = fs.openSync;
  let reads = 0;
  fs.readFileSync = function (f, ...rest) { if (String(f).endsWith(EDGE_LOG_FILE)) reads++; return read.call(this, f, ...rest); };
  fs.openSync = function (f, ...rest) { if (String(f).endsWith(EDGE_LOG_FILE)) reads++; return open.call(this, f, ...rest); };
  try {
    for (let n = 0; n < 3; n++) for (const d of deals) {
      assert.deepEqual(p2.view(p2.s.deals[d.id], p2.s.participants[P.id]).credit_note.pair_changes_since, [{kind: 'transfer_out', ref: 'vt_00000000000000aa', delta: -1}]);
    }
  } finally { fs.readFileSync = read; fs.openSync = open; }
  assert.ok(reads <= 1, `the log file was read ${reads} times for 9 views`);
  // New entries reach the index without another read.
  appendEntries(p2, [{kind: 'setoff', ref: 'vs_00000000000000bb', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, delta: -1, total_after: 1, timestamp: 4000, signature: '02' + hex(64)}]);
  assert.deepEqual(p2.view(p2.s.deals[deals[2].id], p2.s.participants[P.id]).credit_note.pair_changes_since.map(e => e.kind), ['transfer_out', 'setoff']);
  assert.ok(k);
});

test('novation records are pruned (design §11): ended transfers and set-offs go 7 days after they ended (a transfer of a deal not yet paid stays, without its signatures), applied ones drop their signatures after 30 days and keep their totals; unresolved ones stay', async () => {
  const w = world(), {pilot, P, Q, A, clock} = w, t0 = clock.t, sig = () => '02' + hex(64);
  const paid = addDeal(w, 'note_issued'), unpaid = addDeal(w, 'payment_due'), unknown = addDeal(w, 'payment_due');
  const transfer = (id, d, state, extra = {}) => {
    pilot.s.transfers[id] = {id, kind: 'transfer', deal_id: d.id, state, timestamp: ending(t0 - 5000, 999), amount: 1, created_at: iso(t0), updated_at: iso(t0), expires_at: iso(t0),
      fallback_after: fallbackAfter(t0), issuer: {id: A.id, pubkey: A.pubkey}, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey},
      from_edge: {edge: `${A.pubkey}>${P.pubkey}`, before: {total: 5, timestamp: 1, signature: sig()}, new_total: 4, revision: 1}, to_edge: {edge: `${A.pubkey}>${Q.pubkey}`, before: null, new_total: 1, revision: 1},
      slots: {issuer_from: {signature: sig(), by: A.id, at: iso(t0)}, from_recipient: {signature: sig(), by: P.id, at: iso(t0)}}, messages: {}, history: [], result: {code: state}, ...extra};
    (d.transfer_ids ??= []).push(id);
    return pilot.s.transfers[id];
  };
  const ended = transfer('vt_00000000000000e1', paid, 'failed');
  const keep = transfer('vt_00000000000000e2', unpaid, 'expired');
  const applied = transfer('vt_00000000000000e3', addDeal(w, 'paid_by_transfer'), 'applied', {applied_at: iso(t0)});
  applied.tracker_after = {from: {total: 4, timestamp: applied.timestamp, signature: applied.slots.issuer_from.signature}, to: {total: 1, timestamp: applied.timestamp, signature: sig()}};
  const unres = transfer('vt_00000000000000e4', unknown, 'outcome_unknown');
  const so = (id, state, extra = {}) => {
    pilot.s.setoffs[id] = {id, kind: 'setoff', state, created_at: iso(t0), expires_at: iso(t0), updated_at: iso(t0), members: [P.id, Q.id], amount: 2,
      edges: [{edge: 'p>q', issuer: {id: P.id, pubkey: P.pubkey}, recipient: {id: Q.id, pubkey: Q.pubkey}, decrease: 2, before: {total: 2, timestamp: 1, signature: sig()}, new_total: 0, timestamp: 5, revision: 1,
        server_only: false, slots: {issuer: {signature: sig(), by: P.id, at: iso(t0)}, recipient: {signature: sig(), by: Q.id, at: iso(t0)}}}], cycles: [], history: [], result: {code: state}, ...extra};
    return pilot.s.setoffs[id];
  };
  so('vs_00000000000000f1', 'failed');
  const sApplied = so('vs_00000000000000f2', 'applied', {applied_at: iso(t0)});
  sApplied.tracker_after = {'p>q': {total: 0, timestamp: 5, signature: sApplied.edges[0].slots.issuer.signature}};
  paid.refused_attempts = [{kind: 'note', bound: true, timestamp: 1, edges: [{edge: 'p>q', prior_total: 0, new_total: 1}], signature_sha256: {note: hex(32)}, code: 'stale_note', at: iso(t0)}];
  unpaid.refused_attempts = [{...paid.refused_attempts[0]}];
  // Six days later nothing is pruned.
  clock.t = t0 + 6 * DAY;
  await pilot.recover();
  assert.ok(pilot.s.transfers[ended.id] && pilot.s.setoffs.vs_00000000000000f1 && paid.refused_attempts?.length === 1 && keep.slots.issuer_from.signature);
  // Eight days later: the ended ones go; the unpaid deal's transfer stays (its timestamp and edges, decision D-1), its
  // signatures dropped (sha256 kept); the refused attempt of the paid deal goes, the unpaid deal's stays.
  clock.t = t0 + 8 * DAY;
  await pilot.recover();
  assert.equal(pilot.s.transfers[ended.id], undefined);
  assert.equal(pilot.s.setoffs.vs_00000000000000f1, undefined);
  assert.ok(pilot.s.transfers[keep.id], 'a transfer of a deal not yet paid is kept');
  assert.ok(Object.values(keep.slots).every(s => !s.signature) && keep.signature_sha256.issuer_from, 'without its signatures');
  assert.deepEqual([paid.refused_attempts, unpaid.refused_attempts.length], [undefined, 1]);
  assert.ok(applied.slots.issuer_from.signature, 'an applied one keeps its signatures for 30 days');
  // 31 days later: the applied transfer and set-off drop their signatures (sha256 kept) and keep their totals.
  const fromSig = applied.tracker_after.from.signature;
  clock.t = t0 + 31 * DAY;
  await pilot.recover();
  assert.ok(Object.values(applied.slots).every(s => !s.signature) && applied.signature_sha256.issuer_from === sigSha(fromSig));
  assert.deepEqual(applied.tracker_after.from, {total: 4, timestamp: applied.timestamp, signature_sha256: sigSha(fromSig)});
  assert.ok(!JSON.stringify(applied.tracker_after).includes('"signature"'), 'no signature left in tracker_after');
  assert.deepEqual([applied.from_edge.new_total, applied.to_edge.new_total, applied.amount], [4, 1, 1], 'its totals are kept');
  assert.ok(sApplied.edges.every(e => !e.slots.issuer.signature && !e.slots.recipient.signature) && !JSON.stringify(sApplied.tracker_after).includes('"signature"'));
  assert.equal(pilot.s.transfers[unres.id].slots.issuer_from.signature.length, 130, 'an unresolved attempt is kept as it is until its owner resolves it');
  // Mode off with nothing to prune writes nothing.
  const off = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-fixes-off-')); dirs.push(off);
  const p0 = new Pilot({store: new PilotStore(off), basis: {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION}, log: () => {}});
  const before = fs.statSync(path.join(off, 'pilot-state.json')).mtimeMs;
  await p0.recover();
  assert.equal(fs.statSync(path.join(off, 'pilot-state.json')).mtimeMs, before, 'recover() in mode off saved nothing');
});

test('the server signer\'s records file is written readable by the server\'s user only, also when a .tmp left by a crash is in the way (read-only or with wider permissions)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-fixes-records-')); dirs.push(dir);
  const sb = new Sandbox({mode: 'on', circulating: true, now: () => Date.now(), s: {deals: {}}}, {dataDir: dir});
  const file = path.join(dir, 'sandbox-records.json'), tmp = file + '.tmp';
  fs.writeFileSync(tmp, 'stale', {mode: 0o644});
  fs.chmodSync(tmp, 0o444);                                              // read-only: writing over it fails, removing it does not
  sb.records.signed['vp_000000000000|aa|1'] = {op: 'test', totals: [1], timestamp: Date.now(), at: Date.now()};
  sb.saveRecords();
  assert.equal(fs.existsSync(tmp), false, 'no .tmp left');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).signed['vp_000000000000|aa|1'].op, 'test');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by the server\'s user only');
  // In the circulation modes the keys file is written the same way.
  fs.writeFileSync(path.join(dir, 'sandbox-keys.json.tmp'), 'stale'); fs.chmodSync(path.join(dir, 'sandbox-keys.json.tmp'), 0o444);
  sb.keys = {x: 1}; sb.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-keys.json'), 'utf8')), {x: 1});
});

test('with circulation off, sandbox-keys.json is written exactly as v15 writes it (a .tmp in the way is written over and renamed, never removed first); in modes bound, sandbox and on as the signer\'s records are', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-fixes-keys-')); dirs.push(dir);
  const file = path.join(dir, 'sandbox-keys.json'), tmp = file + '.tmp', unlink = t.mock.method(fs, 'unlinkSync');
  for (const mode of ['off', 'bound', 'sandbox', 'on']) {
    const sb = new Sandbox({mode, circulating: mode === 'sandbox' || mode === 'on', now: () => Date.now(), s: {deals: {}}}, {dataDir: dir});
    fs.writeFileSync(tmp, 'stale');
    unlink.mock.resetCalls();
    sb.keys = {mode}; sb.save();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {mode}, mode);
    assert.equal(fs.existsSync(tmp), false, `${mode}: no .tmp left`);
    assert.deepEqual(unlink.mock.calls.map(c => c.arguments[0]), mode === 'off' ? [] : [tmp],
      mode === 'off' ? 'mode off: v15\'s write, nothing removed' : `mode ${mode}: the stale .tmp removed first (writePrivate)`);
  }
});

// =================================================================================================================
// Fix round 2 (with SV-8)
// =================================================================================================================
// A set-off collecting signatures on `edges` ([[key, issuer, recipient]]), every slot signed, as the engine makes them.
function collectingSetoff(w, edges, members) {
  const {pilot, clock} = w, id = 'vs_' + hex(8), at = iso(clock.t), ts = ending(clock.t - 3000, 998);
  pilot.s.setoffs[id] = {id, kind: 'setoff', state: 'collecting', created_at: at, expires_at: iso(clock.t + 30 * 60e3), updated_at: at, network: 'valun-pilot-1', tracker_nft_id: '0'.repeat(64),
    denomination: PILOT_DENOMINATION, amount: 2 * edges.length, members: members.map(m => m.id),
    edges: edges.map(([k, I, R]) => ({edge: k, issuer: {id: I.id, pubkey: I.pubkey}, recipient: {id: R.id, pubkey: R.pubkey}, decrease: 2, before: {total: 5, timestamp: ts - 5000, signature: '02' + hex(64)},
      new_total: 3, timestamp: ts, revision: 1, server_only: false, slots: {issuer: {signature: '02' + hex(64), by: I.id, at}, recipient: {signature: '02' + hex(64), by: R.id, at}}})),
    cycles: [], edge_set: hex(16), per_edge_timestamps: true, source: 'batch', run_id: null, messages: {}, result: null, history: []};
  return pilot.s.setoffs[id];
}
// A Pilot over the same store as w's (as after a restart): its journal index is built on first use.
const reopen = w => new Pilot({store: new PilotStore(w.dir), basis: w.pilot.basis, now: () => w.clock.t, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});

test('the journal fails closed: while pilot-edge-log.jsonl cannot be read (EBUSY; not ENOENT, an empty journal) nothing is proven from the in-memory tail (D-2 e), no index is kept, and a GET /edges page that needs the file is 503; once it reads again the proof is the full journal\'s', async () => {
  const w = world(), {pilot, A, P, Q} = w, ts = 1_000_000_997;
  const e = (I, R, delta, after, at) => ({kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: after, timestamp: at, signature: '02' + hex(64)});
  const K = `${A.pubkey}>${P.pubkey}`, K2 = `${P.pubkey}>${Q.pubkey}`;
  // K: the first entry after ts changed it from 13, so an attempt at ts from 10 may have applied (not dead); a later
  // entry, the only one in the in-memory tail, changed it from exactly 10. K2: the first entry after ts changed it from
  // exactly 0 (an attempt from 0 at ts is dead). Both first entries are pushed out of the 500-entry tail by 600 others.
  appendEntries(pilot, [e(A, P, 2, 15, ts + 1000)]);
  appendEntries(pilot, [e(P, Q, 3, 3, ts + 1500)]);
  for (let i = 0; i < 600; i++) appendEntries(pilot, [e(Q, A, 1, i + 1, ts + 2000 + i)]);
  appendEntries(pilot, [e(A, P, 1, 11, ts + 9000)]);
  pilot.save();
  assert.ok(pilot.s.edge_log_tail[0].seq > 2, 'precondition: the first entries on K and K2 are in the log file only');
  assert.deepEqual([reopen(w).attemptDeadByJournal(K, 10, ts), reopen(w).attemptDeadByJournal(K2, 0, ts)], [false, true], 'the full journal');
  // The file cannot be read (a simulated EBUSY when it is opened: the journal streams it, SV-ROB-1): nothing is proven,
  // either way, and no index is kept.
  const p2 = reopen(w), read = fs.openSync;
  w.pilot.basis.allNotes = async () => [];
  let failing = true;
  fs.openSync = function (f, ...rest) {
    if (failing && String(f).endsWith(EDGE_LOG_FILE)) throw Object.assign(new Error('EBUSY: resource busy or locked (simulated)'), {code: 'EBUSY'});
    return read.call(this, f, ...rest);
  };
  try {
    assert.equal(p2.attemptDeadByJournal(K, 10, ts), false, 'the tail alone would "prove" K dead: it does not');
    assert.equal(p2.attemptDeadByJournal(K2, 0, ts), false, 'not proven while the file cannot be read');
    assert.equal(p2.edgeIndex ?? null, null, 'no index kept from a partial read');
    await assert.rejects(p2.edges(p2.s.participants[P.id], {since: 0}), e => e instanceof PilotError && e.code === 'journal_unavailable' && e.status === 503);
    const recent = p2.s.edge_log_tail[0].seq;
    assert.ok((await p2.edges(p2.s.participants[P.id], {since: recent})).journal.length > 0, 'a page within the in-memory tail needs no file');
  } finally { fs.openSync = read; failing = false; }
  // Readable again: the same Pilot now proves what the full journal proves, and keeps its index.
  assert.deepEqual([p2.attemptDeadByJournal(K, 10, ts), p2.attemptDeadByJournal(K2, 0, ts)], [false, true]);
  assert.ok(p2.edgeIndex instanceof Map);
  assert.equal((await p2.edges(p2.s.participants[P.id], {since: 0})).journal[0].seq, 1);
  // A log file that does not exist yet is an empty journal (ENOENT): the entries in memory are the whole journal.
  const w3 = world();
  appendEntries(w3.pilot, [e(w3.P, w3.Q, 3, 3, ts + 1500)]);
  assert.equal(fs.existsSync(path.join(w3.dir, EDGE_LOG_FILE)), false, 'precondition: no log file');
  assert.equal(w3.pilot.attemptDeadByJournal(`${w3.P.pubkey}>${w3.Q.pubkey}`, 0, ts), true);
  assert.ok(w3.pilot.edgeIndex instanceof Map, 'kept');
});

test('D-2 c: recording a refused payment attempt supersedes at once a collecting set-off on the payer\'s edge it would change (payment_attempt): a refused transfer on its from-edge, a refused credit note on its pair; set-offs elsewhere stay', async () => {
  const w = world(), {pilot, P, Q, A, B, clock} = w;
  pilot.basis.noteMessage = async () => ({message_hex: '00'.repeat(80)});
  pilot.basis.verify = async () => true;                                   // every signature verifies
  const AP = `${A.pubkey}>${P.pubkey}`, PA = `${P.pubkey}>${A.pubkey}`, PQ = `${P.pubkey}>${Q.pubkey}`, QP = `${Q.pubkey}>${P.pubkey}`;
  const AB = `${A.pubkey}>${B.pubkey}`, BA = `${B.pubkey}>${A.pubkey}`, AQ = `${A.pubkey}>${Q.pubkey}`;
  const onFrom = collectingSetoff(w, [[AP, A, P], [PA, P, A]], [A, P]), onPair = collectingSetoff(w, [[PQ, P, Q], [QP, Q, P]], [P, Q]);
  const elsewhere = collectingSetoff(w, [[AB, A, B], [BA, B, A]], [A, B]);
  const T = ending(clock.t - 5000, 999), d = addDeal(w, 'delivered');
  await pilot.recordRefusedTransfer(P, d.id, {issuer_id: A.id, timestamp: T, from_prior_total: 5, to_prior_total: 0,
    signatures: {[`${AP}:prior`]: '02' + hex(64), [`${AP}:new`]: '02' + hex(64), [`${AQ}:new`]: '02' + hex(64)}}, new PilotError('stale_terms', 'hashes do not match', 409));
  assert.equal(d.refused_attempts?.length, 1, 'recorded');
  assert.deepEqual([onFrom.state, onFrom.result?.code], ['superseded', 'payment_attempt'], 'the set-off on the payer\'s from-edge, at once');
  assert.ok(onFrom.edges.every(e => !e.slots.issuer.signature && !e.slots.recipient.signature), 'purged');
  assert.deepEqual([onPair.state, elsewhere.state], ['collecting', 'collecting']);
  const d2 = addDeal(w, 'delivered');
  await pilot.recordRefusedNote(P, d2.id, {total: 3, timestamp: ending(clock.t - 4000, 500), signature: '02' + hex(64)}, new PilotError('stale_note', 'x', 409));
  assert.equal(d2.refused_attempts?.length, 1, 'recorded');
  assert.deepEqual([onPair.state, onPair.result?.code], ['superseded', 'payment_attempt'], 'the set-off on the note\'s pair, at once');
  assert.equal(elsewhere.state, 'collecting');
});

test('tracker v3.2: a bound note goes to the tracker with prior_total and prior_timestamp, the timestamp of the pair\'s note it acknowledges (d.note_prior; 0 for a pair with no note); without d.note_prior it is not sent', async () => {
  const w = world({mode: 'bound'}), {pilot, P, Q, clock} = w, posted = [];
  pilot.basis.api = async (method, p, body) => { posted.push(body); return {status: 409, json: {success: false, error: 'x', code: 'stale_prior'}, text: ''}; };
  for (const [prior, want] of [[{total: 4, timestamp: clock.t - 90e3, signature: '02' + hex(64)}, clock.t - 90e3], [{total: 0, timestamp: null, signature: null}, 0], [undefined, undefined]]) {
    const d = addDeal(w, 'issuing_note'), ts = ending(clock.t - 3000, 997);
    d.credit_note = {state: 'submitting', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, prior_total: prior?.total ?? 0, amount: 3, signed_at: iso(clock.t),
      note: {total: (prior?.total ?? 0) + 3, timestamp: ts, signature: '02' + hex(64), message_hex: '00'.repeat(80), prior_signature: '02' + hex(64)}};
    if (prior) d.note_prior = prior;
    await pilot.submitNote(d);
    assert.deepEqual([posted.at(-1).prior_total, posted.at(-1).prior_timestamp], [prior?.total ?? 0, want], JSON.stringify(prior));
    assert.equal(Object.hasOwn(posted.at(-1), 'prior_timestamp'), want !== undefined);
  }
  // An ordinary note carries none of the bound fields.
  const d = addDeal(w, 'issuing_note');
  d.credit_note = {state: 'submitting', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, prior_total: 0, amount: 3, signed_at: iso(clock.t),
    note: {total: 3, timestamp: ending(clock.t - 3000, 500), signature: '02' + hex(64), message_hex: '00'.repeat(80)}};
  d.note_prior = {total: 0, timestamp: null, signature: null};
  await pilot.submitNote(d);
  assert.deepEqual(Object.keys(posted.at(-1)).sort(), ['amount', 'denomination', 'issuer_pubkey', 'recipient_pubkey', 'signature', 'timestamp', 'tracker_nft_id']);
});

test('D-2 f in mode bound: a bound note the tracker refuses keeps only the tracker\'s status and code (credit_note.error and the credit_note_failed event are the server\'s own sentence; the tracker\'s text is stored and shown nowhere); mode off keeps v15\'s text', async () => {
  const RAW = 'Note rejected: NovationExpired (the raw tracker text, never stored in mode bound)';
  for (const mode of ['bound', 'off']) {
    const w = world({mode}), {pilot, P, Q, clock} = w;
    let posted = null;
    pilot.basis.api = async (method, p, body) => { posted = {method, p, body}; return {status: 400, json: {success: false, error: RAW, code: 'novation_expired'}, text: JSON.stringify({success: false, error: RAW})}; };
    const d = addDeal(w, 'issuing_note'), ts = ending(clock.t - 3000, 997);
    d.credit_note = {state: 'submitting', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, prior_total: 0, amount: 3, signed_at: iso(clock.t),
      note: {total: 3, timestamp: ts, signature: '02' + hex(64), message_hex: '00'.repeat(80), prior_signature: '02' + hex(64)}};
    await pilot.submitNote(d);
    assert.deepEqual([posted.method, posted.p, posted.body.prior_signature, d.status], ['POST', '/notes', d.credit_note.note.prior_signature, 'note_failed'], `${mode}: posted as a bound note, failed`);
    const failed = d.history.filter(h => h.event === 'credit_note_failed');
    if (mode === 'bound') {
      assert.deepEqual([d.credit_note.error, d.credit_note.tracker_status, d.credit_note.error_code], ['the tracker did not record the note (HTTP 400, novation_expired)', 400, 'novation_expired']);
      assert.deepEqual(failed.map(h => h.error), [d.credit_note.error], 'the event says the same');
      for (const [what, text] of [['the deal record', JSON.stringify(d)], ['the payer\'s view', JSON.stringify(pilot.view(d, P))], ['the payee\'s view', JSON.stringify(pilot.view(d, Q))]])
        assert.ok(!text.includes('raw tracker text'), `${what}: no tracker text`);
    } else {
      assert.equal(d.credit_note.error, RAW, 'mode off: v15\'s text');
      assert.deepEqual(failed.map(h => h.error), [RAW]);
      assert.equal('tracker_status' in d.credit_note, false);
    }
  }
});

test('D-2 b (tracker v3.2): a refused bound note is recorded with the prior state its acknowledgment was checked over (the posted prior_timestamp, else the pair\'s note as it is); one whose acknowledged prior timestamp is not before its own timestamp can never apply and is no attempt', async () => {
  const w = world(), {pilot, P, Q, clock} = w, PQ = `${P.pubkey}>${Q.pubkey}`, err = new PilotError('stale_terms', 'hashes do not match', 409);
  const seen = [];
  pilot.basis.noteMessage = async () => ({message_hex: '00'.repeat(80)});
  pilot.basis.priorAckMessage = async a => { seen.push([a.priorTotal, a.priorTimestamp, a.timestamp]); return {message_hex: '00'.repeat(105)}; };
  pilot.basis.verify = async () => true;
  const ts = ending(clock.t - 4000, 997), bound = extra => ({total: 3, timestamp: ts, signature: '02' + hex(64), prior_total: 0, prior_signature: '02' + hex(64), ...extra});
  for (const [why, extra, recorded] of [['asserted, before the note', {prior_timestamp: ts - 5000}, ts - 5000], ['asserted at the note\'s own timestamp', {prior_timestamp: ts}, null],
    ['asserted after it', {prior_timestamp: ts + 1}, null], ['not asserted: the pair has no note', {}, 0]]) {
    const d = addDeal(w, 'delivered');
    await pilot.recordRefusedNote(P, d.id, bound(extra), err);
    if (recorded === null) { assert.equal(d.refused_attempts, undefined, `${why}: no attempt`); continue; }
    assert.deepEqual(d.refused_attempts.map(a => [a.kind, a.bound, a.edges[0].edge, a.edges[0].prior_total, a.edges[0].prior_timestamp]), [['note', true, PQ, 0, recorded]], why);
    assert.deepEqual(seen.at(-1), [0, recorded, ts], `${why}: the acknowledgment checked over PA(P,Q,0,${recorded},ts)`);
  }
  // Not asserted, with a note on the pair: its timestamp.
  w.edges.set(PQ, note(0, ts - 9000));
  const d = addDeal(w, 'delivered');
  await pilot.recordRefusedNote(P, d.id, bound({}), err);
  assert.equal(d.refused_attempts[0].edges[0].prior_timestamp, ts - 9000);
});

test('D-2 b: a refused ordinary credit note whose timestamp ends in a residue the tracker keeps for other operations (995, 996, 998, 999) can never apply, so it is no attempt and is not recorded; at an ordinary residue it is', async () => {
  const w = world(), {pilot, P, clock} = w;
  pilot.basis.noteMessage = async () => ({message_hex: '00'.repeat(80)});
  pilot.basis.verify = async () => true;
  const err = new PilotError('stale_note', 'the timestamp ends in a reserved residue', 409), route = {route: 'transfer', fromEdge: 'x>y', fromPrior: 1};
  for (const r of [995, 996, 998, 999]) {
    const d = addDeal(w, 'delivered');
    await pilot.recordRefusedNote(P, d.id, {total: 3, timestamp: ending(clock.t - 4000, r), signature: '02' + hex(64)}, err);
    assert.equal(d.refused_attempts, undefined, `residue ${r}: not recorded`);
    assert.equal(await pilot.paymentBlock(d, route), null, `residue ${r}: no pending_unbound_note`);
    assert.deepEqual(pilot.view(d, P).next_actions, ['complete', 'pay_by_transfer', 'dispute'], `residue ${r}: a payment by transfer is offered`);
  }
  for (const r of [0, 500, 994]) {
    const d = addDeal(w, 'delivered');
    await pilot.recordRefusedNote(P, d.id, {total: 3, timestamp: ending(clock.t - 4000, r), signature: '02' + hex(64)}, err);
    assert.deepEqual(d.refused_attempts?.map(a => [a.kind, a.bound]), [['note', false]], `residue ${r}: an ordinary note the tracker could take`);
    assert.deepEqual(await pilot.paymentBlock(d, route), {code: 'pending_unbound_note'}, `residue ${r}`);
  }
});

test('decideApproval in every mode: an offer, or an acceptance held for its owner (the acceptor\'s: accept; the proposer\'s: confirm_offer), that a concurrent read expires while the approval awaits its mandate checks is not revived (409 not_pending, nothing decided), nor one whose time passes meanwhile with no read; without such a race the decision is as before', async () => {
  for (const mode of ['off', 'on']) for (const kind of ['propose', 'accept', 'confirm_offer']) for (const race of ['read', 'clock', null]) {
    const what = `${mode}, ${kind}, ${race === 'read' ? 'a read expires it meanwhile' : race === 'clock' ? 'its time passes meanwhile, nobody reads' : 'no race'}`;
    const w = world({mode}), {pilot, P, Q, clock} = w, id = 'vd_' + hex(8), expires = clock.t + DAY;
    const terms = {deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, service: {title: 'fx job', description: 'synthetic', deliverable: 'text'},
      price: {amount: 3, unit: 'PC'}, offer_expires_at: iso(expires), deliver_by: iso(clock.t + 2 * DAY)};
    // propose and confirm_offer are decided by the proposer P's owner, accept by the acceptor Q's.
    const a = {id: 'va_' + hex(6), participant: kind === 'accept' ? Q.id : P.id, deal_id: id, kind, version: 1, terms_hash: hex(32), created_at: iso(clock.t), state: 'pending'};
    const v = {v: 1, by: P.id, terms, terms_hash: a.terms_hash, signature: '02' + hex(64), created_at: iso(clock.t), state: kind === 'propose' ? 'awaiting_owner' : 'open',
      offered_at: kind === 'propose' ? null : iso(clock.t), ...(kind === 'propose' ? {approval_id: a.id} : {})};
    // accept: the acceptance waits for Q's owner (approval_id); confirm_offer: Q accepted at once, and the offer, which P's
    // owner never approved, waits for P's owner (proposer_approval_id, F4).
    const held = {version: 1, by: Q.id, terms_hash: a.terms_hash, signature: '02' + hex(64), at: iso(clock.t), state: 'awaiting_owner'};
    const d = {id, payer: P.id, payee: Q.id, created_at: iso(clock.t), status: kind === 'propose' ? 'proposed_awaiting_owner' : 'accepted_awaiting_owner', versions: [v], history: [],
      ...(kind === 'accept' ? {acceptance: {...held, approval_id: a.id}} : kind === 'confirm_offer' ? {acceptance: {...held, proposer_approval_id: a.id, proposer_mandate_check: {needsOwner: true}}} : {})};
    pilot.s.deals[id] = d; pilot.s.approvals[a.id] = a;
    P.mandate.approve_above = 1000;                    // the proposer's own owner need not confirm the accepted offer (F4)
    // The mandate checks read the tracker (ledger); meanwhile, once, the offer's time passes, and (race 'read') a lock-free
    // read (a deal view) sweeps the deal. For confirm_offer that happens during the second read: the acceptor's check
    // (acceptorStillAuthorized), after the proposer's own.
    const raceAt = kind === 'confirm_offer' ? 2 : 1;
    let reads = 0, racedAt = null;
    pilot.basis.allNotes = async () => {
      if (race && ++reads === raceAt) { racedAt = reads; clock.t = expires + 1000; if (race === 'read') pilot.view(d, P); }
      return [];
    };
    const decide = pilot.decideApproval(pilot.s.participants[a.participant], a.id, {decision: 'approve'});
    if (race) {
      await assert.rejects(decide, e => e instanceof PilotError && e.code === 'not_pending' && e.status === 409, what);
      assert.equal(racedAt, raceAt, `${what}: the race came during read ${raceAt}`);
      assert.deepEqual([a.state, d.status, v.state], ['void_expired', 'expired', 'expired'], `${what}: the expiry stands`);
      if (d.acceptance) assert.equal(d.acceptance.state, 'expired', `${what}: the held acceptance expired`);
      assert.ok(!d.history.some(h => h.event === 'owner_approved'), `${what}: nothing decided`);
      assert.equal(d.agreement, undefined, what);
      assert.equal(v.owner_approval, undefined, `${what}: the offer was not confirmed`);
    } else {
      const r = await decide;
      assert.equal(r.approval.state, 'approved', what);
      assert.equal(d.status, kind === 'propose' ? 'open' : 'agreed', what);
    }
  }
});

// Fix round 3 (FX3-SV, decisions D-3 b and D-3 d).
test('D-3 d: the journal proves nothing unless the entries read cover every seq from 1 to counters.edge_seq: after pilot-edge-log.jsonl is lost once the tail has rolled over, the restart keeps the tail\'s entries but no attempt is proven dead, a GET /edges page that needs the lost entries is 503 with the first missing seqs, and the gap is logged and audited once', async () => {
  const w = world(), {pilot, A, P, Q} = w, ts = 1_000_000_997;
  const e = (I, R, delta, after, at) => ({kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: after, timestamp: at, signature: '02' + hex(64)});
  const K2 = `${P.pubkey}>${Q.pubkey}`, LOG = path.join(w.dir, EDGE_LOG_FILE), AUDIT = path.join(w.dir, 'pilot-audit.jsonl');
  // K2's first entry after ts changed it from exactly 0 (an attempt from 0 at ts is dead); 600 entries on another edge
  // push that entry out of the 500-entry tail, so only the log file holds it.
  appendEntries(pilot, [e(P, Q, 3, 3, ts + 1500)]);
  for (let i = 0; i < 600; i++) appendEntries(pilot, [e(Q, A, 1, i + 1, ts + 2000 + i)]);
  pilot.save();
  const first = pilot.s.edge_log_tail[0].seq, last = pilot.s.counters.edge_seq;
  assert.ok(first > 12 && last === 601, 'precondition: the tail starts well after K2\'s entry');
  assert.equal(reopen(w).attemptDeadByJournal(K2, 0, ts), true, 'the whole journal proves it dead');
  const whole = fs.readFileSync(LOG, 'utf8');
  pilot.basis.allNotes = async () => [];
  // The log file is lost (deleted, or the state restored without it); the server restarts.
  fs.rmSync(LOG);
  const logs = [], restart = () => new Pilot({store: new PilotStore(w.dir), basis: pilot.basis, now: () => w.clock.t, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: m => logs.push(m)});
  const p2 = restart();
  const kept = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual([kept[0].seq, kept.at(-1).seq, kept.length], [first, last, last - first + 1], 'the tail\'s entries are kept in a new file');
  const incomplete = () => fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.type === 'journal.incomplete');
  assert.deepEqual(incomplete().map(({at, ...x}) => x), [{type: 'journal.incomplete', where: 'startup', missing_from: 1, missing_to: first - 1}], 'audited at startup');
  assert.equal(p2.attemptDeadByJournal(K2, 0, ts), false, 'a lost entry may be the first one after ts: nothing is proven');
  assert.deepEqual(p2.edgeIndexGap, {from: 1, to: first - 1}, 'the index is kept, marked incomplete');
  assert.equal(p2.attemptDeadByJournal(K2, 0, ts), false, 'and stays so');
  await assert.rejects(p2.edges(p2.s.participants[P.id], {since: 0}), x => x instanceof PilotError && x.code === 'journal_unavailable' && x.status === 503
    && x.extra.missing_from === 1 && x.extra.missing_to === first - 1 && x.message.includes(`missing entries 1..${first - 1}`), 'never a 200 with entries 1..first-1 missing');
  await assert.rejects(p2.edges(p2.s.participants[Q.id], {since: first - 2}), x => x.code === 'journal_unavailable' && x.extra.missing_from === first - 1);
  const page = await p2.edges(p2.s.participants[Q.id], {since: first - 1});
  assert.equal(page.journal[0].seq, first, 'a page after the lost entries is answered');
  assert.equal(logs.filter(l => l.includes(`the edge journal is missing entries 1..${first - 1}`)).length, 1, 'logged once');
  assert.equal(incomplete().length, 1, 'audited once');
  // The whole file back, and a restart: the proof holds again; nothing more is audited.
  fs.writeFileSync(LOG, whole);
  const p3 = restart();
  assert.equal(p3.attemptDeadByJournal(K2, 0, ts), true);
  assert.equal(p3.edgeIndexGap, null);
  assert.equal((await p3.edges(p3.s.participants[P.id], {since: 0})).journal[0].seq, 1);
  assert.equal(incomplete().length, 1);
  // A file cut in the middle (entries 11..first-1 lost, the rest and the tail there): incomplete too.
  fs.writeFileSync(LOG, whole.split('\n').filter(l => { const s = l && JSON.parse(l).seq; return !s || s <= 10 || s >= first; }).join('\n'));
  const p4 = restart();
  assert.equal(p4.attemptDeadByJournal(K2, 0, ts), false);
  assert.deepEqual(p4.edgeIndexGap, {from: 11, to: first - 1});
  await assert.rejects(p4.edges(p4.s.participants[P.id], {since: 0}), x => x.code === 'journal_unavailable' && x.extra.missing_from === 11 && x.extra.missing_to === first - 1);
  assert.deepEqual(incomplete().map(x => [x.where, x.missing_from, x.missing_to]), [['startup', 1, first - 1], ['startup', 11, first - 1]]);
});

test('D-3 d: entries a failed append keeps queued are part of what the journal reads, also once the tail has rolled past them: the journal is whole (GET /edges since=0 answers them, the proof holds, nothing is audited), and after the append succeeds the file holds them', async () => {
  const w = world(), {pilot, A, P, Q} = w, ts = 1_000_000_997;
  const e = (I, R, delta, after, at) => ({kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: after, timestamp: at, signature: '02' + hex(64)});
  const K2 = `${P.pubkey}>${Q.pubkey}`, LOG = path.join(w.dir, EDGE_LOG_FILE), AUDIT = path.join(w.dir, 'pilot-audit.jsonl');
  const logs = [];
  pilot.log = m => logs.push(m);
  pilot.basis.allNotes = async () => [];
  // Every append to pilot-edge-log.jsonl fails (a full disk, simulated): each save keeps the entries queued.
  pilot.store.appendEdgeLog = () => { throw Object.assign(new Error('ENOSPC: no space left on device (simulated)'), {code: 'ENOSPC'}); };
  appendEntries(pilot, [e(P, Q, 3, 3, ts + 1500)]);
  pilot.save();
  for (let i = 0; i < 600; i++) appendEntries(pilot, [e(Q, A, 1, i + 1, ts + 2000 + i)]);
  pilot.save();
  const first = pilot.s.edge_log_tail[0].seq;
  assert.ok(first > 12 && pilot.s.counters.edge_seq === 601 && pilot.edgeLogQueue.length === 601, 'precondition: K2\'s entry is neither in the tail nor in a file, only queued');
  assert.equal(fs.existsSync(LOG), false, 'precondition: no log file');
  assert.ok(logs.some(l => l.includes('kept for the next save')), 'precondition: the appends failed');
  const page = await pilot.edges(pilot.s.participants[P.id], {since: 0});
  assert.deepEqual([page.journal[0].seq, page.journal[0].edge], [1, K2], 'the queued entries are answered, not taken for lost (no 503 journal_unavailable)');
  assert.equal((await pilot.edges(pilot.s.participants[Q.id], {since: first - 2})).journal[0].seq, first - 1, 'a page that starts in the queue, before the tail');
  assert.equal(pilot.attemptDeadByJournal(K2, 0, ts), true, 'the whole journal (file, tail and queue) proves it dead');
  assert.equal(pilot.edgeIndexGap ?? null, null, 'the index is whole');
  assert.equal(fs.existsSync(AUDIT) && fs.readFileSync(AUDIT, 'utf8').includes('journal.incomplete'), false, 'nothing audited as missing');
  assert.equal(logs.some(l => l.includes('the edge journal is missing entries')), false);
  // The disk has room again: the next save appends every queued entry; the journal now reads them from the file.
  delete pilot.store.appendEdgeLog;
  pilot.save();
  assert.equal(pilot.edgeLogQueue.length, 0);
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l).seq);
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [601, 1, 601]);
  assert.equal((await pilot.edges(pilot.s.participants[P.id], {since: 0})).journal[0].seq, 1);
  assert.equal(reopen(w).attemptDeadByJournal(K2, 0, ts), true, 'and after a restart');
});

test('D-3 b: X-Valun-Features consents/1;roles= (an empty list) makes the server forget at once the consent roles it recorded for that client: from that request on no role counts (no 7-day carry-over) and no novation is proposed to it; a request without the header changes nothing; a later declaration counts only what it lists; with circulation off the header is ignored', async () => {
  for (const mode of ['on', 'off']) {
    const w = world({mode}), {pilot, P, clock} = w, token = 'vpa_' + hex(16), ROLES = ['setoff', 'issuer', 'creditor'];
    P.agent_token_hash = crypto.createHash('sha256').update(token).digest('hex');
    pilot.basis.allNotes = async () => [];
    const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}});
    const me = async features => {
      let out;
      const headers = {authorization: `Bearer ${token}`, ...(features === undefined ? {} : {'x-valun-features': features})};
      await routes({method: 'GET', headers, socket: {remoteAddress: '127.0.0.1'}}, {}, new URL('http://x/pilot/v1/me'), (res, status, body) => { out = {status, body}; }, () => '127.0.0.1');
      assert.equal(out.status, 200, `${mode}: GET /me`);
      return out.body;
    };
    const counted = () => ROLES.filter(r => pilot.consentCapable(P, r));
    const all = await me('consents/1;roles=setoff,issuer,creditor');
    if (mode === 'off') {
      assert.equal('features' in all, false, 'mode off: /me as v15');
      assert.equal(P.client_features, undefined, 'mode off: nothing recorded');
      assert.deepEqual(counted(), []);
      continue;
    }
    assert.deepEqual([all.features.consent_roles, counted(), pilot.consentSpeed(P, 'issuer')], [ROLES, ROLES, 'auto'], 'declared: every role counts');
    assert.equal(pilot.clearingParticipantCheck(P), null, 'a clearing member');
    clock.t += 60e3;
    const none = await me('consents/1;roles=');
    assert.deepEqual(none.features.consent_roles, [], 'forgotten at once');
    assert.equal(none.features.consents_declared_at, iso(clock.t));
    assert.equal(none.features.consents_count_until, null, 'nothing counts until a later time');
    assert.deepEqual(counted(), [], 'no role counts');
    for (const r of ROLES) assert.equal(pilot.consentSpeed(P, r), 'unavailable', r);
    assert.equal(pilot.clearingParticipantCheck(P), 'setoff_consent', 'no set-off is proposed to it');
    // A request without the header (or with one that cannot be read) changes nothing.
    assert.deepEqual((await me(undefined)).features.consent_roles, []);
    assert.deepEqual((await me('consents/2;roles=setoff')).features.consent_roles, []);
    // A later declaration counts again, only what it lists, for 7 days.
    clock.t += 60e3;
    const one = await me('consents/1;roles=setoff');
    assert.deepEqual([one.features.consent_roles, counted()], [['setoff'], ['setoff']]);
    assert.equal(one.features.consents_count_until, iso(clock.t + 7 * DAY));
  }
});
