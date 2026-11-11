// Release v16.1 (server), at the unit level: a Pilot over a stub tracker and a throwaway store, so these run with any
// tracker binaries, in the default `npm test` (the large journal runs as a child process):
//   - MIG-1, refuse instead of alarm: while the pilot tracker reports no valid tracker v3.2 capabilities and the state
//     holds circulating-credit history, every pilot write to the tracker is refused (503 tracker_downgraded) before
//     anything is sent or recorded, recovery sends nothing, GET /info says so; a v15 state is never refused; a re-read
//     that finds tracker v3.2 lifts the refusal;
//   - SV-ROB-1, the edge journal's checkpoint: compaction keeps every answer the journal gives correct (GET /edges, the
//     D-2 e proof, credit_note.pair_changes_since, completeness), keeps what attempts still need, survives a crash at any
//     step (the old journal or the new one), runs at most once a day over a size, and bounds startup and memory;
//   - next_actions and payment-options apply the payment routes' own rule (paymentBlock with the tracker's state), so
//     they never offer a payment the route then refuses.
// Run: node --test test/release-v16-1.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK} from '../lib/pilot/core.mjs';
import * as J from '../lib/pilot/journal.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-v161-')); dirs.push(d); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const H = 3600e3, DAY = 24 * H, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const V31_CAPS = {...V3_CAPS, build: 'valun-circulating-credit/3'};
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;
const note = (total, timestamp, signature = '02' + hex(64)) => ({amount_collected: String(total), amount_redeemed: '0', timestamp, signature});
const LOG_FILE = 'pilot-edge-log.jsonl';

// A Pilot in `mode` over a stub tracker that records every write sent to it (w.sent): `edges` (Map
// '<issuer>><recipient>' -> tracker note) is what basis.note() and allNotes() read; basis.caps is what capabilities()
// and refresh() answer. P pays every deal, Q is paid, A and B are other participants; all four agents' clients sign
// every consent role. `clock.t` is the Pilot's clock; w.logs its log lines.
function world({clock = {t: Date.parse('2026-11-11T12:00:05.600Z')}, mode = 'on', caps = V3_CAPS, dir = null} = {}) {
  dir ??= tmp();
  const edges = new Map(), sent = [], logs = [];
  const tracked = (k, n) => { const [i, r] = k.split('>'); return {issuer_pubkey: i, recipient_pubkey: r, denomination: PILOT_DENOMINATION, ...n}; };
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, caps,
    note: async (i, r) => { const n = edges.get(`${i}>${r}`); return n ? tracked(`${i}>${r}`, n) : null; },
    allNotes: async () => [...edges].map(([k, n]) => tracked(k, n)),
    capabilities: async () => basis.caps, refresh: async () => { basis.refreshes = (basis.refreshes ?? 0) + 1; return basis.caps; },
    noteMessage: async () => ({message_hex: '00'.repeat(80)}), priorAckMessage: async () => ({message_hex: '00'.repeat(105)}),
    verify: async () => true, proof: async () => null,
    api: async (method, p, body) => {
      sent.push({path: p, body});
      if (method === 'POST' && p === '/notes') edges.set(`${body.issuer_pubkey}>${body.recipient_pubkey}`, note(body.amount, body.timestamp, body.signature));
      return {status: 200, json: {success: true}, text: ''};
    },
    transfer: async body => { sent.push({path: '/notes/transfer', body}); return {status: 503, success: false, code: null, error: 'stub', data: null}; },
    setoff: async body => { sent.push({path: '/notes/setoff', body}); return {status: 503, success: false, code: null, error: 'stub', data: null}; }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: caps, trackerSha256: PIN, trackerPins: [PIN], log: m => logs.push(m)});
  const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE, auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'},
    mandate_version: 1, past_pubkeys: [], last_seen_agent: iso(clock.t), last_seen_owner: null,
    client_features: {consents: true, roles: ['issuer', 'creditor', 'setoff'], at: iso(clock.t)}});
  const [P, Q, A, B] = ['v161-payer', 'v161-payee', 'v161-issuer', 'v161-other'].map(person);
  for (const x of [P, Q, A, B]) pilot.s.participants[x.id] = x;
  return {pilot, basis, edges, sent, logs, clock, dir, P, Q, A, B};
}
function addDeal(w, status, {price = 3, payer = w.P, payee = w.Q} = {}) {
  const {pilot, clock} = w, id = 'vd_' + hex(8);
  const terms = {network: NETWORK, tracker_nft_id: '0'.repeat(64), denomination: PILOT_DENOMINATION, deal_id: id, version: 1, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'v16.1 job', description: 'synthetic', deliverable: 'text'}, price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
  const v = {v: 1, by: payer.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
  const d = {id, payer: payer.id, payee: payee.id, created_at: iso(clock.t), status, versions: [v], history: [], agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)},
    delivery: {by: payee.id, sha256: hex(32), content: 'x', at: iso(clock.t)}};
  pilot.s.deals[id] = d;
  return d;
}
// An issued note Valun journaled on edge I>R, also on the stub tracker (so the edge reconciles exactly).
function issued(w, I, R, total, ts, {at} = {}) {
  const sig = '02' + hex(64);
  const [e] = J.appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total, total_after: total, timestamp: ts, signature: sig, ...(at ? {at} : {})}]);
  w.edges.set(`${I.pubkey}>${R.pubkey}`, note(total, ts, sig));
  return e;
}
// Circulating-credit history: A's note to B, part of it moved to Q by an applied transfer (A>B and A>Q are bound-only).
function history(w) {
  const {pilot, A, B, Q, clock} = w, t0 = clock.t - 2 * H;
  issued(w, A, B, 5, t0);
  const sAB = '02' + hex(64), sAQ = '02' + hex(64), T = ending(t0 + 60e3, 999), vt = 'vt_' + hex(8);
  J.appendEntries(pilot, [{kind: 'transfer_out', ref: vt, issuer_pubkey: A.pubkey, recipient_pubkey: B.pubkey, delta: -1, total_after: 4, timestamp: T, signature: sAB},
    {kind: 'transfer_in', ref: vt, issuer_pubkey: A.pubkey, recipient_pubkey: Q.pubkey, delta: 1, total_after: 1, timestamp: T, signature: sAQ}]);
  w.edges.set(`${A.pubkey}>${B.pubkey}`, note(4, T, sAB)); w.edges.set(`${A.pubkey}>${Q.pubkey}`, note(1, T, sAQ));
  pilot.save();
}
// A transfer record of deal d in `state`, through I's note held by d's payer.
function transfer(w, d, state, {I = w.A, T = ending(w.clock.t - 60e3, 999), from, to = null, unsigned = []} = {}) {
  const {pilot} = w, B = pilot.s.participants[d.payer], C = pilot.s.participants[d.payee];
  const t = pilot.newTransfer(d, {A: I, B, C, a: d.agreement.terms.price.amount, T, from, to, quote: pilot.quoteFor(d, I, B, C, d.agreement.terms.price.amount)});
  t.state = state;
  for (const s of ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient']) if (!unsigned.includes(s)) t.slots[s] = {signature: '02' + hex(64), by: 'x', at: iso(w.clock.t)};
  pilot.s.transfers[t.id] = t;
  d.transfer_ids = [...(d.transfer_ids || []), t.id];
  d.payment = {method: 'transfer', transfer_id: t.id};
  return t;
}
// Calls the pilot router with a fake request; returns {status, body}.
async function call(routes, {method = 'GET', path: p, token = null, body = null}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {method, headers: token ? {authorization: `Bearer ${token}`} : {}, socket: {remoteAddress: '203.0.113.9'}, [Symbol.asyncIterator]: async function* () { yield* chunks; }};
  let out = null;
  const send = (res, status, b) => { out = {status, body: b}; };
  try { await routes(req, {}, new URL('http://x/pilot/v1' + p), send, () => '203.0.113.9'); }
  catch (e) { out = {status: e.status ?? 500, body: {error: e.code, message: e.message, ...(e.extra || {})}}; }
  return out;
}
const tokens = w => {
  for (const x of [w.P, w.Q, w.A, w.B]) { x.agent_token_hash = sha(`vpa_${x.handle}`); x.owner_token_hash = sha(`vpo_${x.handle}`); }
  return x => `vpa_${x.handle}`;
};
const refusedWith = e => e instanceof PilotError && e.code === 'tracker_downgraded' && e.status === 503 && /runbook step 4/.test(e.message) && /\(runbook R3\)/.test(e.message);
const auditOf = w => { try { return fs.readFileSync(path.join(w.dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---------------------------------------------------------------------------------------------------------------
// MIG-1: refuse instead of alarm
test('MIG-1 (v16.1): with a pilot tracker that reports no valid tracker v3.2 capabilities and a state with circulating-credit history, every pilot write to the tracker is refused with 503 tracker_downgraded before anything is sent or recorded (credit notes, a held note\'s approval, payments by transfer and their approval, consents to transfers and set-offs, the clearing engine, recovery); reads keep working and GET /info says why', async () => {
  const w = world(), {pilot, P, Q, A, B, clock, sent} = w, agent = tokens(w);
  history(w);
  const AB = `${A.pubkey}>${B.pubkey}`, PQ = `${P.pubkey}>${Q.pubkey}`, QP = `${Q.pubkey}>${P.pubkey}`;
  // What each write path would act on.
  const dNote = addDeal(w, 'delivered');
  const dHeld = addDeal(w, 'completion_awaiting_owner', {payer: P, payee: B}), apNote = pilot.approval(P, dHeld, 'issue_note', {v: 1, terms_hash: dHeld.agreement.terms_hash});
  dHeld.credit_note = {state: 'signed', issuer_pubkey: P.pubkey, recipient_pubkey: B.pubkey, keys_as_agreed: true, note: {total: 3, timestamp: clock.t - 3000, signature: '02' + hex(64), message_hex: '00'},
    prior_total: 0, amount: 3, approval_id: apNote.id, completion: {signature: '02' + hex(64), deliverable_sha256: dHeld.delivery.sha256}};
  const dHeldT = addDeal(w, 'completion_awaiting_owner', {payer: B, payee: Q});
  const tHeld = transfer(w, dHeldT, 'awaiting_owner', {I: A, from: {total: 4, timestamp: w.edges.get(AB).timestamp, signature: w.edges.get(AB).signature}, to: null});
  tHeld.approval_id = pilot.approval(B, dHeldT, 'pay_by_transfer', {v: 1, terms_hash: dHeldT.agreement.terms_hash}).id;
  const dPay = addDeal(w, 'delivered');
  const dCons = addDeal(w, 'paying_by_transfer', {payer: B, payee: P});
  const tCons = transfer(w, dCons, 'collecting', {I: A, from: {total: 4, timestamp: w.edges.get(AB).timestamp, signature: w.edges.get(AB).signature}, unsigned: ['to_recipient_prior', 'to_recipient']});
  const at = iso(clock.t), sts = ending(clock.t - 3000, 998);
  w.edges.set(PQ, note(5, sts - 5000)); w.edges.set(QP, note(5, sts - 5000));
  const vs = 'vs_' + hex(8);
  pilot.s.setoffs[vs] = {id: vs, kind: 'setoff', state: 'collecting', created_at: at, expires_at: iso(clock.t + 30 * 60e3), updated_at: at, network: NETWORK, tracker_nft_id: '0'.repeat(64),
    denomination: PILOT_DENOMINATION, amount: 4, members: [P.id, Q.id],
    edges: [[PQ, P, Q], [QP, Q, P]].map(([k, I, R]) => ({edge: k, issuer: {id: I.id, pubkey: I.pubkey}, recipient: {id: R.id, pubkey: R.pubkey}, decrease: 2, before: {total: 5, timestamp: sts - 5000, signature: w.edges.get(k).signature},
      new_total: 3, timestamp: sts, revision: 1, server_only: false, slots: {issuer: null, recipient: null}})),
    cycles: [], edge_set: hex(16), per_edge_timestamps: true, source: 'batch', run_id: null, messages: {[PQ]: '00', [QP]: '00'}, result: null, history: []};
  // Recovery's work: a note being issued that the tracker does not hold, a transfer and a set-off left applying on edges
  // still in their prior states (each would be submitted again).
  const dIssuing = addDeal(w, 'issuing_note', {payer: Q, payee: B});
  dIssuing.credit_note = {state: 'submitting', issuer_pubkey: Q.pubkey, recipient_pubkey: B.pubkey, note: {total: 3, timestamp: clock.t - 4000, signature: '02' + hex(64), message_hex: '00'}, prior_total: 0, amount: 3};
  const BP = `${B.pubkey}>${P.pubkey}`;
  w.edges.set(BP, note(6, clock.t - 9000));
  const dApply = addDeal(w, 'paying_by_transfer', {payer: P, payee: Q});
  const tApply = transfer(w, dApply, 'applying', {I: B, T: ending(clock.t - 5000, 999), from: {total: 6, timestamp: clock.t - 9000, signature: w.edges.get(BP).signature}});
  const vs2 = 'vs_' + hex(8);
  pilot.s.setoffs[vs2] = {...structuredClone(pilot.s.setoffs[vs]), id: vs2, state: 'applying', edges: pilot.s.setoffs[vs].edges.map(e => ({...structuredClone(e), slots: {issuer: {signature: '02' + hex(64)}, recipient: {signature: '02' + hex(64)}}}))};
  delete pilot.s.setoffs[vs]; pilot.s.setoffs[vs] = {...pilot.s.setoffs[vs2], id: vs, state: 'collecting', edges: pilot.s.setoffs[vs2].edges.map(e => ({...structuredClone(e), slots: {issuer: null, recipient: null}}))};
  pilot.save();
  assert.equal(pilot.writeRefusal?.() ?? null, null, 'precondition: tracker v3.2, nothing refused');

  // The capabilities as server.mjs sets them: none (the Basis 3df7ed93 build, or a failed read).
  pilot.trackerCaps = null;
  assert.equal(pilot.mode, 'off');
  const before = JSON.stringify(pilot.s), audits = auditOf(w).length;
  const sig = () => '02' + hex(64);
  // A credit note that is valid in every other respect (the pair's total is 5): without the refusal it would be sent.
  await assert.rejects(pilot.complete(P, dNote.id, {terms_hash: dNote.agreement.terms_hash, deliverable_sha256: dNote.delivery.sha256, signature: sig(), credit_note: {total: 8, timestamp: clock.t - 2000, signature: sig()}}), refusedWith, 'a credit note');
  assert.deepEqual(sent, [], 'nothing was sent');
  const r = pilot.writeRefusal();
  assert.equal(r?.code, 'tracker_downgraded');
  assert.match(r.reason, /no capabilities/);
  const alarms = w.logs.filter(l => l.includes('ALARM'));
  assert.equal(alarms.length, 1, alarms.join('\n'));
  assert.match(alarms[0], /pilot writes are refused \(503 tracker_downgraded\).*2 bound-only edges.*runbook R3/);
  assert.deepEqual(auditOf(w).filter(x => x.type === 'pilot.writes_refused').map(x => x.history.novated_edges), [2]);
  await assert.rejects(pilot.decideApproval(P, apNote.id, {decision: 'approve'}), refusedWith, 'the owner releases a held credit note');
  await assert.rejects(pilot.decideApproval(B, tHeld.approval_id, {decision: 'approve'}), refusedWith, 'the owner approves a held payment by transfer');
  await assert.rejects(pilot.payByTransfer(P, dPay.id, {issuer_id: A.id, terms_hash: dPay.agreement.terms_hash, deliverable_sha256: dPay.delivery.sha256, timestamp: ending(clock.t - 2000, 999),
    from_prior_total: 4, to_prior_total: 1, quote_digest: hex(32), completion_signature: sig(), pay_signature: sig(), signatures: {}}), refusedWith, 'a payment by transfer');
  await assert.rejects(pilot.submitConsent(P, tCons.id, {signatures: {[`${A.pubkey}>${P.pubkey}:prior`]: sig(), [`${A.pubkey}>${P.pubkey}:new`]: sig()}}), refusedWith, 'a consent that would apply a transfer');
  await assert.rejects(pilot.submitConsent(P, vs, {signatures: {[`${PQ}:new`]: sig(), [`${QP}:new`]: sig()}}), refusedWith, 'a set-off consent');
  assert.deepEqual(await pilot.serial(() => pilot.createSetoff({edges: [{edge: PQ, decrease: 1}, {edge: QP, decrease: 1}]})), {skipped: 'tracker_downgraded'}, 'the clearing engine proposes nothing');
  // Over HTTP: the same 503, and the reads keep working.
  const routes = createPilotRoutes({pilot, cfg: {}});
  const post = await call(routes, {method: 'POST', path: `/deals/${dNote.id}/complete`, token: agent(P), body: {terms_hash: dNote.agreement.terms_hash, deliverable_sha256: dNote.delivery.sha256, signature: sig(), credit_note: {total: 3, timestamp: clock.t - 2000, signature: sig()}}});
  assert.deepEqual([post.status, post.body.error, post.body.retry_after_ms], [503, 'tracker_downgraded', 60000]);
  for (const p of [`/deals/${dNote.id}`, '/deals', '/me', '/inbox']) assert.equal((await call(routes, {path: p, token: agent(P)})).status, 200, p);
  assert.equal((await call(routes, {path: '/ledger'})).status, 200);
  const info = await call(routes, {path: '/info'});
  assert.equal(info.body.features, undefined, 'circulation is off');
  assert.deepEqual(Object.keys(info.body.writes_refused), ['code', 'since', 'reason', 'fix']);
  assert.equal(info.body.writes_refused.code, 'tracker_downgraded');
  assert.match(info.body.writes_refused.fix, /RUNBOOK.md step 4.*runbook R3/);
  assert.equal(JSON.stringify(pilot.s), before, 'nothing was recorded');
  assert.equal(auditOf(w).length, audits, 'no audit line: nothing happened');
  assert.deepEqual(sent, [], 'nothing was sent to the tracker');

  // Recovery reads but sends nothing: what needs a submission stays as it is, unreported.
  assert.deepEqual(await pilot.recover(), []);
  assert.deepEqual([dIssuing.status, tApply.state, pilot.s.setoffs[vs2].state], ['issuing_note', 'applying', 'applying']);
  assert.deepEqual(sent, [], 'recovery sent nothing');
  // ... and decides what the read-back decides: a note the tracker holds is recorded.
  w.edges.set(`${Q.pubkey}>${B.pubkey}`, note(3, dIssuing.credit_note.note.timestamp, dIssuing.credit_note.note.signature));
  assert.deepEqual(await pilot.recover(), ['note_issued']);
  assert.deepEqual(sent, []);
  // A rejection sends nothing, so it is not refused.
  assert.equal((await pilot.decideApproval(P, apNote.id, {decision: 'reject'})).approval.state, 'rejected');
  assert.deepEqual(sent, []);
  // A tracker v3.1 (its capabilities do not validate) is refused the same way.
  const w2 = world(); history(w2);
  w2.pilot.trackerCaps = V31_CAPS;
  assert.equal(w2.pilot.writeRefusal()?.code, 'tracker_downgraded');
  assert.match(w2.pilot.writeRefusal().reason, /build is "valun-circulating-credit\/3"/);
});

test('MIG-1 (v16.1): a state without circulating-credit history (v15\'s) on a tracker without capabilities is never refused: credit notes are sent as in v15, no alarm, and GET /info is v15\'s', async () => {
  const w = world({mode: 'off', caps: null}), {pilot, P, Q, clock, sent} = w;
  issued(w, P, Q, 3, clock.t - 60e3);                                 // ordinary notes only: no bound-only edge, no novation
  pilot.save();
  assert.equal(pilot.writeRefusal(), null);
  const d = addDeal(w, 'delivered');
  const v = await pilot.complete(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: '02' + hex(64), credit_note: {total: 6, timestamp: clock.t - 1500, signature: '02' + hex(64)}});
  assert.equal(v.status, 'note_issued');
  assert.deepEqual(sent.map(x => x.path), ['/notes']);
  assert.deepEqual(w.logs.filter(l => l.includes('ALARM')), []);
  assert.deepEqual(auditOf(w).filter(x => x.type.startsWith('pilot.writes')), []);
  const info = await call(createPilotRoutes({pilot, cfg: {}}), {path: '/info'});
  assert.deepEqual(Object.keys(info.body), ['network', 'protocol', 'unit', 'denomination', 'tracker_nft_id', 'tracker_on_chain', 'experimental', 'description', 'statements', 'participants'], 'v15\'s keys, nothing more');
});

test('MIG-1 (v16.1): while refusing, the capabilities are read again (Basis.refresh, on server.mjs\'s 60 s timer); a read that is not tracker v3.2\'s keeps the refusal, one that is lifts it and the requested mode applies; one ALARM when it starts and one line when it ends, both audited', async () => {
  const w = world(), {pilot, basis, P, Q, clock, sent} = w;
  history(w);
  assert.equal(await pilot.recheckTracker(), false, 'not refusing: nothing to read');
  assert.equal(basis.refreshes ?? 0, 0);
  basis.caps = null;
  pilot.trackerCaps = null;                                           // the startup read failed
  assert.ok(pilot.writeRefusal());
  assert.equal(await pilot.recheckTracker(), false, 'still no capabilities');
  basis.caps = V31_CAPS;
  assert.equal(await pilot.recheckTracker(), false, 'a tracker v3.1 does not lift it');
  basis.refresh = async () => { throw new Error('unreachable'); };
  assert.equal(await pilot.recheckTracker(), false, 'a read that fails does not either');
  assert.ok(pilot.writeRefusal());
  basis.refresh = async () => V3_CAPS;
  assert.equal(await pilot.recheckTracker(), true);
  assert.equal(pilot.writeRefusal(), null);
  assert.equal(pilot.mode, 'on', 'the requested mode, as at startup');
  assert.equal(w.logs.filter(l => l.includes('ALARM')).length, 1);
  assert.deepEqual(w.logs.filter(l => l.startsWith('Pilot: pilot writes resumed')).length, 1);
  assert.match(w.logs.find(l => l.startsWith('Pilot: pilot writes resumed')), /tracker v3\.2 contract again.*circulating credit: on/);
  assert.deepEqual(auditOf(w).filter(x => x.type.startsWith('pilot.writes')).map(x => x.type), ['pilot.writes_refused', 'pilot.writes_resumed']);
  // Writes go to the tracker again.
  const d = addDeal(w, 'delivered'), prior = Number(w.edges.get(`${P.pubkey}>${Q.pubkey}`)?.amount_collected ?? 0);
  assert.equal((await pilot.complete(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: '02' + hex(64), credit_note: {total: prior + 3, timestamp: clock.t - 1500, signature: '02' + hex(64)}})).status, 'note_issued');
  assert.deepEqual(sent.map(x => x.path), ['/notes']);
});

// ---------------------------------------------------------------------------------------------------------------
// SV-ROB-1: the edge journal's checkpoint
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
// A journal with 40-day-old history and recent entries, more than the 500-entry tail holds, so that old pages need the
// file: on A>P a note (deal d1), a transfer from it and a set-off on it, a second note (deal d2), 600 notes on B>Q, all
// 40 days old; then (2 days ago) a transfer from A>P again, a note on P>Q (deal d3) and 30 more notes on B>Q.
function journalWorld({dir = null} = {}) {
  const w = world({clock: {t: NOW}, dir}), {pilot, A, B, P, Q} = w;
  const OLD = NOW - 40 * DAY, YOUNG = NOW - 2 * DAY;
  let n = 0;
  const put = (kind, I, R, delta, total, ts, ref, at) => J.appendEntries(pilot, [{kind, ref, issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: total, timestamp: ts, signature: '02' + hex(64), at: iso(at + 1000 * ++n)}])[0];
  const recorded = (d, e, I, R) => { d.status = 'note_issued'; d.credit_note = {state: 'recorded', issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, note: {total: e.total_after, timestamp: e.timestamp, signature: e.signature}, amount: e.delta}; d.journal_seq = e.seq; };
  const d1 = addDeal(w, 'delivered', {payer: A, payee: P, price: 5}), d2 = addDeal(w, 'delivered', {payer: A, payee: P, price: 3}), d3 = addDeal(w, 'delivered', {payer: P, payee: Q, price: 2});
  recorded(d1, put('issue', A, P, 5, 5, OLD + 10, d1.id, OLD), A, P);
  const vt1 = 'vt_' + hex(8);
  put('transfer_out', A, P, -2, 3, OLD + 1999, vt1, OLD); put('transfer_in', A, Q, 2, 2, OLD + 1999, vt1, OLD);
  put('setoff', A, P, -1, 2, OLD + 2998, 'vs_' + hex(8), OLD);
  recorded(d2, put('issue', A, P, 3, 5, OLD + 4000, d2.id, OLD), A, P);
  for (let i = 1; i <= 600; i++) put('issue', B, Q, 1, i, OLD + 10000 + i, 'vd_' + hex(8), OLD);
  const vt2 = 'vt_' + hex(8);
  put('transfer_out', A, P, -1, 4, YOUNG + 999, vt2, YOUNG); put('transfer_in', A, Q, 1, 3, YOUNG + 999, vt2, YOUNG);
  recorded(d3, put('issue', P, Q, 2, 2, YOUNG + 2000, d3.id, YOUNG), P, Q);
  for (let i = 1; i <= 30; i++) put('issue', B, Q, 1, 600 + i, YOUNG + 3000 + i, 'vd_' + hex(8), YOUNG);
  pilot.save();
  return {...w, d1, d2, d3, vt1, vt2, K: 605, AP: `${A.pubkey}>${P.pubkey}`, BQ: `${B.pubkey}>${Q.pubkey}`};
}
const fileEntries = dir => fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => Number.isSafeInteger(e.seq));
// What the journal answers that compaction must keep: the caller's GET /edges pages (from 0 and from after the
// checkpoint), pair_changes_since, and D-2 e proofs.
async function answers(w, pilot = w.pilot) {
  const P = pilot.s.participants[w.P.id], all = [];
  let since = 0, pages = 0, cp = null;
  for (;;) { const r = await pilot.edges(P, {since}); cp ??= r.checkpoint ?? null; all.push(...r.journal); pages++; if (r.journal.length < 200) break; since = r.next_seq; }
  const fromK = (await pilot.edges(P, {since: w.K})).journal;
  const view = d => pilot.view(pilot.s.deals[d.id], pilot.s.participants[d.payer]).credit_note.pair_changes_since;
  return {seqs: all.map(e => e.seq), entries: all, pages, cp, fromK, pc: [view(w.d1), view(w.d2), view(w.d3)],
    deadOld: pilot.attemptDeadByJournal(w.AP, 5, w.d1.credit_note.note.timestamp), deadYoung: pilot.attemptDeadByJournal(w.AP, 5, NOW - 2 * DAY), gap: pilot.edgeIndexGap ?? null};
}
const sums = list => { const o = {}; for (const c of list) o[c.kind] = (o[c.kind] ?? 0) + c.delta; return o; };

test('SV-ROB-1 (v16.1): compaction replaces the entries older than 31 days with a checkpoint and keeps every answer of the journal correct: GET /edges from after it unchanged, from before it each edge\'s state as of it (real entries) and every later entry, marked with `checkpoint`; pair_changes_since with the same sums; the D-2 e proof unchanged for recent attempts and fail-closed for old ones; no gap; and the same after a restart', async () => {
  const w = journalWorld(), {pilot, d1, d3, vt2, K, AP, BQ} = w;
  const was = await answers(w), original = new Map(fileEntries(w.dir).map(e => [e.seq, e]));
  assert.equal(was.pages, 1, 'precondition'); assert.ok(was.seqs.includes(1) && was.seqs.includes(2) && was.cp === null);
  assert.ok(pilot.s.edge_log_tail[0].seq > 4, 'precondition: the old entries on A>P are in the file only');
  assert.equal(was.deadOld, true, 'precondition: before, the journal proves d1\'s note\'s prior dead (the first entry after it left 5)');
  const r = J.compactJournal(pilot, {now: NOW, protect: pilot.journalProtection()});
  assert.deepEqual([r.compacted, r.through_seq, r.previous, r.stopped_by], [true, K, 0, 'horizon']);
  const lines = fs.readFileSync(path.join(w.dir, LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual([lines[0].checkpoint, lines[0].through_seq, lines[0].at, lines[0].horizon_days], [1, K, iso(NOW), 31]);
  assert.deepEqual(J.readCheckpoint(path.join(w.dir, LOG_FILE)).through_seq, K);
  // Every entry after K is in the file as it was; up to K only the edges' last ones (A>P: d2's note; A>Q; B>Q).
  const after = fileEntries(w.dir);
  assert.deepEqual(after.filter(e => e.seq > K), [...original.values()].filter(e => e.seq > K));
  assert.deepEqual(after.filter(e => e.seq <= K).map(e => e.seq), [3, 5, 605]);
  for (const e of after) assert.deepEqual(e, original.get(e.seq), 'kept as it was');
  assert.deepEqual(lines.filter(l => l.cp_edge).map(l => [l.cp_edge, l.dropped]), [[AP, 3], [BQ, 599]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.deepEqual(lines.filter(l => l.cp_deal).map(l => [l.cp_deal, l.changes]), [[d1.id, [{kind: 'transfer_out', count: 1, delta: -2}, {kind: 'setoff', count: 1, delta: -1}]]]);
  assert.ok(r.bytes_after < r.bytes_before / 5, `${r.bytes_before} -> ${r.bytes_after}`);

  for (const [label, p] of [['in place', pilot], ['after a restart', new Pilot({store: new PilotStore(w.dir), basis: w.basis, now: () => NOW, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}})]]) {
    const now = await answers(w, p);
    assert.equal(now.gap, null, `${label}: no gap (the checkpoint covers 1..K)`);
    assert.equal(p.journalIndex.base, K, label);
    // From before the checkpoint: the caller's kept entries (each edge's state as of K: d2's note on A>P) and every later one.
    assert.deepEqual(now.seqs, [5, ...was.seqs.filter(s => s > K)], label);
    for (const e of now.entries) assert.deepEqual(e, original.get(e.seq), `${label}: real entries, as journaled`);
    assert.deepEqual(now.cp, {through_seq: K, at: iso(NOW)}, `${label}: the page says the entries before were compacted`);
    assert.deepEqual(now.fromK, was.fromK, `${label}: a page from after the checkpoint is unchanged`);
    // pair_changes_since: d1 (recorded before K) has the checkpoint's sums, then each later change; d2 and d3 as before.
    assert.deepEqual(now.pc[0], [{kind: 'transfer_out', ref: null, delta: -2, count: 1, through_seq: K}, {kind: 'setoff', ref: null, delta: -1, count: 1, through_seq: K},
      {kind: 'transfer_out', ref: vt2, delta: -1}], label);
    assert.deepEqual(sums(now.pc[0]), sums(was.pc[0]), `${label}: the same sums`);
    assert.deepEqual([now.pc[1], now.pc[2]], [was.pc[1], was.pc[2]], label);
    // D-2 e: an attempt recent enough to need the journal is judged as before; an old one is no longer proven dead by it
    // (partial: fail closed).
    assert.equal(now.deadYoung, was.deadYoung, label);
    assert.equal(now.deadOld, false, `${label}: an entry the checkpoint dropped may be the first after it`);
    assert.equal(J.firstEdgeEntryAfter(p, AP, d1.credit_note.note.timestamp).partial, true);
    assert.equal(J.firstEdgeEntryAfter(p, AP, NOW - 3 * DAY).partial, false);
  }
  assert.deepEqual(auditOf(w).filter(x => x.type === 'journal.incomplete'), []);
  // A second compaction, 40 days later: the checkpoint moves on, and d1's sums take in what was dropped since.
  const p3 = new Pilot({store: new PilotStore(w.dir), basis: w.basis, now: () => NOW + 40 * DAY, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const r2 = J.compactJournal(p3, {now: NOW + 40 * DAY, protect: p3.journalProtection()});
  assert.deepEqual([r2.compacted, r2.previous, r2.through_seq], [true, K, pilot.s.counters.edge_seq]);
  const pc = p3.view(p3.s.deals[d1.id], p3.s.participants[w.A.id]).credit_note.pair_changes_since;
  assert.deepEqual(pc, [{kind: 'transfer_out', ref: null, delta: -3, count: 2, through_seq: r2.through_seq}, {kind: 'setoff', ref: null, delta: -1, count: 1, through_seq: r2.through_seq}]);
  assert.deepEqual(sums(pc), sums(was.pc[0]));
  assert.equal(p3.view(p3.s.deals[d3.id], p3.s.participants[w.P.id]).credit_note.pair_changes_since.length, 0);
  assert.equal(p3.edgeIndexGap ?? null, null);
});

test('SV-ROB-1 (v16.1): compaction never drops what an attempt of an unpaid deal still needs, nor an entry younger than 31 days, nor anything of an incomplete journal', async () => {
  // An unpaid deal's refused attempt on B>Q 40 days ago: the entries on B>Q after its timestamp stay, and so does
  // everything after the first of them.
  const w = journalWorld(), {pilot, B, Q, P, BQ, K} = w;
  const ts = NOW - 40 * DAY + 10000 + 300;                              // between B>Q's 299th and 300th notes
  const d = addDeal(w, 'payment_due', {payer: B, payee: Q});
  d.refused_attempts = [{kind: 'note', bound: false, timestamp: ts, edges: [{edge: BQ, prior_total: 299, new_total: 300}], signature_sha256: {note: hex(32)}, code: 'stale_note', at: iso(NOW)}];
  assert.equal(pilot.journalProtection().get(BQ), ts);
  const r = J.compactJournal(pilot, {now: NOW, protect: pilot.journalProtection()});
  const first = fileEntries(w.dir).find(e => e.edge === BQ && e.timestamp > ts);
  assert.deepEqual([r.compacted, r.stopped_by, r.through_seq], [true, 'attempt', first.seq - 1]);
  assert.ok(r.through_seq < K);
  const p2 = new Pilot({store: new PilotStore(w.dir), basis: w.basis, now: () => NOW, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(J.firstEdgeEntryAfter(p2, BQ, ts).partial, false, 'the attempt\'s D-2 e proof is exact');
  assert.equal(J.firstEdgeEntryAfter(p2, BQ, ts).entry.seq, first.seq);
  // Within the horizon nothing is compacted.
  const w2 = journalWorld();
  assert.deepEqual(J.compactJournal(w2.pilot, {now: NOW - 10 * DAY, protect: new Map()}), {skipped: 'nothing_to_compact', through_seq: 0, stopped_by: 'horizon'});
  // A journal with a seq missing (a line lost) is compacted up to the gap only, and one missing its first entries not at all.
  const w3 = journalWorld(), file = path.join(w3.dir, LOG_FILE);
  const text = fs.readFileSync(file, 'utf8').split('\n');
  fs.writeFileSync(file, text.filter(l => !l.startsWith('{"seq":300,')).join('\n'));
  assert.deepEqual([J.compactJournal(w3.pilot, {now: NOW, protect: new Map()}).through_seq], [299]);
  const w4 = journalWorld(), file4 = path.join(w4.dir, LOG_FILE);
  fs.writeFileSync(file4, fs.readFileSync(file4, 'utf8').split('\n').filter(l => !l.startsWith('{"seq":1,')).join('\n'));
  assert.equal(J.compactJournal(w4.pilot, {now: NOW, protect: new Map()}).skipped, 'nothing_to_compact');
  void P;
});

test('SV-ROB-1 (v16.1): a crash at any step of the compaction leaves either the old journal or the new one (written to a new file, then renamed): after a restart the file is byte for byte one of the two, no temporary file is left, and the journal answers as that one does', async () => {
  const base = journalWorld(), src = base.dir;
  const oldBytes = fs.readFileSync(path.join(src, LOG_FILE));
  const was = await answers(base);
  const copy = () => { const d = tmp(); fs.cpSync(src, d, {recursive: true}); return d; };
  const open = d => new Pilot({store: new PilotStore(d), basis: base.basis, now: () => NOW, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const clean = copy(), pc = open(clean);
  assert.equal(J.compactJournal(pc, {now: NOW, protect: pc.journalProtection()}).compacted, true);
  const newBytes = fs.readFileSync(path.join(clean, LOG_FILE)), now = await answers({...base, dir: clean}, open(clean));
  for (const step of ['scanned', 'tmp_partial', 'tmp_written', 'renamed']) {
    const d = copy(), p = open(d);
    assert.throws(() => J.compactJournal(p, {now: NOW, protect: p.journalProtection(), fault: s => { if (s === step) throw new Error(`crash at ${s}`); }}), new RegExp(`crash at ${step}`));
    const restarted = open(d), bytes = fs.readFileSync(path.join(d, LOG_FILE));
    const isNew = step === 'renamed';
    assert.ok(bytes.equals(isNew ? newBytes : oldBytes), `${step}: the ${isNew ? 'new' : 'old'} journal`);
    assert.equal(fs.existsSync(path.join(d, LOG_FILE + J.COMPACT_TMP_SUFFIX)), false, `${step}: no temporary file after the restart`);
    const got = await answers({...base, dir: d}, restarted), want = isNew ? now : was;
    assert.deepEqual([got.seqs, got.cp, got.pc, got.deadOld, got.gap], [want.seqs, want.cp, want.pc, want.deadOld, null], step);
    // A compaction after the crash completes, and gives the clean result.
    assert.equal(J.compactJournal(restarted, {now: NOW, protect: restarted.journalProtection()}).compacted ?? false, !isNew, step);
    assert.ok(fs.readFileSync(path.join(d, LOG_FILE)).equals(newBytes), `${step}: then the same journal as a clean compaction`);
  }
});

test('SV-ROB-1 (v16.1): Pilot.maybeCompactJournal runs only over the size threshold and at most once a day (also across a restart: the checkpoint says when), logs one line and audits journal.compacted', async () => {
  const w = journalWorld(), {pilot} = w;
  assert.equal((await pilot.maybeCompactJournal()).skipped, 'small', 'a small journal is left as it is');
  const r = await pilot.maybeCompactJournal({minBytes: 1000});
  assert.equal(r.compacted, true);
  assert.equal(w.logs.filter(l => l.startsWith('Pilot: the edge journal is compacted through seq')).length, 1);
  assert.deepEqual(auditOf(w).filter(x => x.type === 'journal.compacted').map(x => x.through_seq), [w.K]);
  assert.equal((await pilot.maybeCompactJournal({minBytes: 0})).skipped, 'too_soon');
  const later = {t: NOW + 3600e3};
  const p2 = new Pilot({store: new PilotStore(w.dir), basis: w.basis, now: () => later.t, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal((await p2.maybeCompactJournal({minBytes: 0})).skipped, 'too_soon', 'a restart does not compact again the same day');
  later.t = NOW + 25 * 3600e3;
  assert.equal((await p2.maybeCompactJournal({minBytes: 0})).skipped, 'nothing_to_compact', 'a day later it looks again');
  assert.equal(J.JOURNAL_HORIZON_DAYS, 31);
  assert.equal(J.JOURNAL_COMPACT_MIN_BYTES, 16 * 1048576);
});

test('SV-ROB-1 (v16.1): a 150 000-entry journal 40 days old under --max-old-space-size=128: after compaction the restart streams a small file, the index holds only the kept and recent entries (its arrays sized by them), startup takes a fraction of the time and memory, and the pages and proofs answer from the checkpoint', async () => {
  const dir = tmp();
  const r = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=128', path.join(root, 'test', 'fixtures', 'compact-journal.mjs'), dir, '150000', '600'], {cwd: root});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject); c.on('close', code => resolve({code, out, err}));
  });
  assert.equal(r.code, 0, `the child process failed (exit ${r.code}):\n${r.out}\n${r.err.split('\n').slice(0, 12).join('\n')}`);
  const res = JSON.parse(r.out.trim().split('\n').at(-1));
  console.log(`# compaction of a 150 000-entry journal: ${JSON.stringify(res)}`);
  assert.ok(res.log_mib_before > 80 && res.log_mib_after < 1, `${res.log_mib_before} MiB -> ${res.log_mib_after} MiB`);
  assert.deepEqual([res.compaction.through_seq, res.compaction.dropped, res.compaction.kept, res.compaction.stopped_by], [150000, 150000 - 3, 3, 'horizon']);
  assert.deepEqual([res.before.index.base, res.after.index.base], [0, 150000]);
  assert.ok(res.before.index.capacity > 150000, 'before: the arrays cover every seq');
  assert.ok(res.after.index.capacity <= 1024 && res.after.index.old <= 3 && res.after.index.edge_list_entries === 603, JSON.stringify(res.after.index));
  assert.ok(res.after.startup_ms * 4 < res.before.startup_ms, `startup ${res.before.startup_ms} ms -> ${res.after.startup_ms} ms`);
  assert.ok(res.after.array_buffers_mib < res.before.array_buffers_mib && res.after.heap_added_mib < res.before.heap_added_mib, `memory: ${JSON.stringify([res.before, res.after])}`);
  assert.deepEqual([res.first_page_before.length, res.first_page_before.checkpoint], [200, null]);
  assert.deepEqual([res.first_page_after.length, res.first_page_after.seqs, res.first_page_after.checkpoint.through_seq], [3, [149626, 150001, 150376], 150000]);
  assert.equal(res.second_page_after, 0);
  assert.deepEqual(res.from_checkpoint, [150001, 150376]);
  assert.deepEqual([res.young_on_xy, res.young_dead_proven, res.old_dead_proven, res.gap], [200, true, false, null]);
});

// ---------------------------------------------------------------------------------------------------------------
// next_actions and payment-options: the routes' own rule
test('next_actions (v16.1) judge decision D-1 as the payment routes do, with the tracker\'s state of the note: after A\'s note to the payer moves outside Valun, a served deal view no longer offers pay_by_transfer while transfer-template answers 409 transfer_window_open; back in the acknowledged state it is offered again and the route gives a template', async () => {
  const w = world(), {pilot, A, P, Q, clock} = w, agent = tokens(w), routes = createPilotRoutes({pilot, cfg: {}});
  const AP = `${A.pubkey}>${P.pubkey}`;
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'payment_due', {price: 3});
  const tpl = await pilot.transferTemplate(P, d.id, A.id), T1 = tpl.timestamp;
  const t = transfer(w, d, 'cancelled', {I: A, T: T1, from: tpl.from_edge.before, to: tpl.to_edge.before});
  t.fallback_after = T1 + 3600e3 + 60e3; pilot.purgeTransfer(t);
  clock.t += 5000;
  const served = async () => [(await call(routes, {path: `/deals/${d.id}`, token: agent(P)})).body.next_actions,
    (await call(routes, {path: '/deals', token: agent(P)})).body.find(x => x.id === d.id).next_actions,
    (await call(routes, {path: '/owner', token: `vpo_${P.handle}`})).body.deals.find(x => x.id === d.id).next_actions];
  const template = () => call(routes, {path: `/deals/${d.id}/transfer-template?issuer=${A.id}`, token: agent(P)});
  // The tracker and the journal agree: a transfer through the same note on the same prior state is offered, and accepted.
  for (const a of await served()) assert.deepEqual(a, ['wait_for_transfer_window', 'pay_by_transfer']);
  assert.equal((await template()).status, 200);
  // A's note to P moves outside Valun (the same total at another timestamp): Valun's journal still holds the state the
  // attempt acknowledged, the tracker does not.
  const kept = w.edges.get(AP);
  w.edges.set(AP, note(5, kept.timestamp + 10));
  const refused = await template();
  assert.deepEqual([refused.status, refused.body.error], [409, 'transfer_window_open'], 'the route refuses it');
  for (const a of await served()) assert.deepEqual(a, ['wait_for_transfer_window'], 'so no served view offers it');
  assert.equal((await pilot.paymentOptions(P, d.id)).held_notes.find(h => h.issuer.id === A.id).why_not, 'transfer_window_open');
  // Valun's own estimate (a view made without a tracker read, which no route answers with) cannot see the move.
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'pay_by_transfer']);
  // Back in the acknowledged state: offered again, and the route gives a template.
  w.edges.set(AP, kept);
  for (const a of await served()) assert.deepEqual(a, ['wait_for_transfer_window', 'pay_by_transfer']);
  assert.equal((await template()).status, 200);
});

test('payment-options (v16.1) say edge_busy wherever transfer-template refuses with it, also for a credit note being issued or held for an owner on the edge (it used to show such a note as usable)', async () => {
  const w = world(), {pilot, A, P, Q, clock} = w;
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'delivered', {price: 3});
  const opts = async () => (await pilot.paymentOptions(P, d.id)).held_notes.find(h => h.issuer.id === A.id);
  assert.equal((await opts()).why_not, null, 'precondition: usable');
  // A pays P for another deal; its credit note on A>P waits for A's owner.
  const dA = addDeal(w, 'completion_awaiting_owner', {payer: A, payee: P});
  dA.credit_note = {state: 'signed', issuer_pubkey: A.pubkey, recipient_pubkey: P.pubkey, note: {total: 8, timestamp: clock.t - 2000, signature: '02' + hex(64), message_hex: '00'}, prior_total: 5, amount: 3};
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id), e => e instanceof PilotError && e.code === 'edge_busy');
  assert.equal((await opts()).why_not, 'edge_busy');
  dA.status = 'issuing_note';
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id), e => e instanceof PilotError && e.code === 'edge_busy');
  assert.equal((await opts()).why_not, 'edge_busy');
  // On the to-edge (A>Q) too.
  dA.status = 'note_issued';
  const dQ = addDeal(w, 'completion_awaiting_owner', {payer: A, payee: Q});
  dQ.credit_note = {state: 'signed', issuer_pubkey: A.pubkey, recipient_pubkey: Q.pubkey, note: {total: 3, timestamp: clock.t - 2000, signature: '02' + hex(64), message_hex: '00'}, prior_total: 0, amount: 3};
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id), e => e instanceof PilotError && e.code === 'edge_busy');
  assert.equal((await opts()).why_not, 'edge_busy');
});
