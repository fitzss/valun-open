// A payment issuer named in the signed terms (fix inbox #192/#196, approved by Fitz on Nov 20), at the unit level: a
// Pilot in circulation mode on over a stub tracker (its capabilities validate and its binary is pinned; every signature
// verifies) and a throwaway store, so these run with any tracker binaries, in the default `npm test` and in CI.
//   - terms may name payment_issuer {id, pubkey}: a third active participant under its registered key; terms without it
//     validate and hash exactly as before;
//   - the payee's owner policy bounds the issuer its agent may agree to (accept_transfers, refuse_notes_from,
//     accept_notes_from): 403 payment_issuer_not_accepted, nothing agreed; the payer's (pay_with_held_notes) too;
//   - once agreed: a payment with the named issuer's note is not refused by the payee's standing lists (caps still
//     apply); another issuer's note is 409 payment_issuer_mismatch and the payer's own note 409
//     terms_name_payment_issuer, both before anything is created or recorded;
//   - the deal view, the inbox and payment-options name the issuer; next_actions never offer 'complete' for such a deal.
// Run: node --test test/payment-issuer.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, PROTOCOL, termsHash} from '../lib/pilot/core.mjs';
import * as J from '../lib/pilot/journal.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const H = 3600e3, DAY = 24 * H, PIN = 'cd'.repeat(32), NFT = '0'.repeat(64);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const note = (total, timestamp, signature = '02' + hex(64)) => ({amount_collected: String(total), amount_redeemed: '0', timestamp, signature});
const sig = () => '02' + hex(64);

// P pays, Q is paid, A and X issue notes P holds. Every agent's client signs every consent role; owners approve nothing
// (approve_above high), so a proposal is open and an acceptance agreed at once.
function world({clock = {t: Date.parse('2026-11-20T12:00:05.600Z')}, mode = 'on'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-payment-issuer-')); dirs.push(dir);
  const edges = new Map(), sent = [];
  const tracked = (k, n) => { const [i, r] = k.split('>'); return {issuer_pubkey: i, recipient_pubkey: r, denomination: PILOT_DENOMINATION, ...n}; };
  const basis = {nft: NFT, denomination: PILOT_DENOMINATION,
    note: async (i, r) => { const n = edges.get(`${i}>${r}`); return n ? tracked(`${i}>${r}`, n) : null; },
    allNotes: async () => [...edges].map(([k, n]) => tracked(k, n)),
    capabilities: async () => V3_CAPS, refresh: async () => V3_CAPS,
    noteMessage: async () => ({message_hex: '00'.repeat(80)}), priorAckMessage: async () => ({message_hex: '00'.repeat(105)}),
    verify: async () => true, proof: async () => null,
    api: async (method, p, body) => { sent.push({path: p, body}); return {status: 503, json: {success: false}, text: ''}; },
    transfer: async body => { sent.push({path: '/notes/transfer', body}); return {status: 503, success: false, code: null, error: 'stub', data: null}; },
    setoff: async body => { sent.push({path: '/notes/setoff', body}); return {status: 503, success: false, code: null, error: 'stub', data: null}; }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE, approve_above: 1e9, auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'},
    mandate_version: 1, past_pubkeys: [], last_seen_agent: iso(clock.t), last_seen_owner: null,
    client_features: {consents: true, roles: ['issuer', 'creditor', 'setoff'], at: iso(clock.t)}});
  const [P, Q, A, X] = ['pi-payer', 'pi-payee', 'pi-issuer', 'pi-other'].map(person);
  for (const x of [P, Q, A, X]) pilot.s.participants[x.id] = x;
  return {pilot, edges, sent, clock, P, Q, A, X};
}
const party = x => ({id: x.id, pubkey: x.pubkey});
// valun-deal/1 terms of a new offer from `by` (P or Q), P paying Q 3; `extra` adds (or, as undefined, drops) fields.
function terms(w, {by = w.P, price = 3, extra = {}} = {}) {
  const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + hex(8), version: 1, prior_terms_hash: null,
    nonce: hex(16), proposer: by.id, payer: party(w.P), payee: party(w.Q), service: {title: 'pi job', description: 'synthetic', deliverable: 'text'},
    price: {amount: price, unit: w.pilot.unit}, consideration: 'credit_note_on_delivery_accepted', deliver_by: iso(w.clock.t + 2 * DAY), offer_expires_at: iso(w.clock.t + DAY), ...extra};
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
}
const propose = (w, t, by = w.P) => w.pilot.propose(by, {terms: t, terms_hash: termsHash(t), signature: sig()});
const accept = (w, id, by = w.Q) => w.pilot.accept(by, id, {terms_hash: w.pilot.current(w.pilot.deal(id)).terms_hash, signature: sig()});
const code = c => e => e instanceof PilotError && e.code === c;
// An agreed, delivered deal P pays Q, naming `issuer` (or none) as payment issuer; P holds 5 of A's and of X's notes.
async function delivered(w, issuer = w.A) {
  const t = terms(w, {extra: issuer ? {payment_issuer: party(issuer)} : {}});
  await propose(w, t); await accept(w, t.deal_id);
  const d = w.pilot.deal(t.deal_id);
  d.status = 'delivered'; d.delivery = {by: w.Q.id, sha256: hex(32), content: 'x', at: iso(w.clock.t)};
  for (const I of [w.A, w.X]) {
    if (w.edges.has(`${I.pubkey}>${w.P.pubkey}`)) continue;
    const s = sig(), ts = w.clock.t - 60e3;
    J.appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: w.P.pubkey, delta: 5, total_after: 5, timestamp: ts, signature: s}]);
    w.edges.set(`${I.pubkey}>${w.P.pubkey}`, note(5, ts, s));
  }
  w.pilot.save();
  return d;
}
// The payer's POST pay-by-transfer body for template `tpl` (every signature verifies on the stub).
const payBody = (d, tpl) => ({issuer_id: tpl.issuer.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, timestamp: tpl.timestamp,
  from_prior_total: tpl.from_edge.before.total, from_prior_timestamp: tpl.from_edge.prior_timestamp, to_prior_total: tpl.to_edge.before?.total ?? 0, to_prior_timestamp: tpl.to_edge.prior_timestamp,
  quote_digest: tpl.quote_digest, completion_signature: sig(), pay_signature: sig(),
  signatures: {[`${tpl.from_edge.edge}:prior`]: sig(), [`${tpl.from_edge.edge}:new`]: sig(), [`${tpl.to_edge.edge}:new`]: sig()}});

test('terms may name payment_issuer {id, pubkey}, a third active participant under its registered key: the offer validates, the terms hash covers it, and the deal view and the inbox name it in words', async () => {
  const w = world(), {pilot, P, Q, A} = w;
  const t = terms(w, {extra: {payment_issuer: party(A)}});
  const v = await propose(w, t);
  assert.equal(v.status, 'open');
  assert.deepEqual(pilot.deal(t.deal_id).versions[0].terms.payment_issuer, party(A));
  const without = {...t}; delete without.payment_issuer;
  assert.notEqual(termsHash(t), termsHash(without), 'the signed hash covers the issuer');
  assert.equal(v.current.terms_hash, termsHash(t));
  const seen = await pilot.dealView(pilot.deal(t.deal_id), Q);
  assert.deepEqual([seen.payment_issuer.id, seen.payment_issuer.handle, seen.payment_issuer.pubkey], [A.id, A.handle, A.pubkey]);
  assert.match(seen.payment_issuer.words, new RegExp(`${P.handle} will pay by passing ${Q.handle} a note issued by ${A.handle} \\(${A.id}\\), not a note of its own`));
  assert.deepEqual(pilot.inbox(Q).respond.find(x => x.deal_id === t.deal_id).payment_issuer, {id: A.id, handle: A.handle});
  // Refused: the payer, the payee, an unknown participant, another key, a revoked participant, other fields, null.
  const bad = async (pi, re) => assert.rejects(propose(w, terms(w, {extra: {payment_issuer: pi}})), e => code('invalid_terms')(e) && re.test(e.message), JSON.stringify(pi));
  await bad(party(P), /must not be the payer/);
  await bad(party(Q), /must not be the payee/);
  await bad({id: 'vp_' + hex(6), pubkey: A.pubkey}, /active participant with its registered key/);
  await bad({id: A.id, pubkey: '02' + hex(32)}, /active participant with its registered key/);
  await bad({id: A.id, pubkey: A.pubkey, handle: A.handle}, /must be \{id, pubkey\}/);
  await bad(null, /must be \{id, pubkey\}/);
  await bad(A.id, /must be \{id, pubkey\}/);
  A.status = 'revoked';
  await bad(party(A), /active participant with its registered key/);
});

test('terms without payment_issuer validate and hash exactly as before (a fixed vector), and their views carry no payment_issuer', async () => {
  const w = world(), {pilot, Q} = w;
  // A fixed terms object: its hash is the one the server before payment_issuer (531023c) computes for it.
  const fixed = {protocol: 'valun-deal/1', network: 'valun-testnet-1', tracker_nft_id: NFT, denomination: 'PC', deal_id: 'vd_0123456789abcdef', version: 1, prior_terms_hash: null,
    nonce: '00112233445566778899aabbccddeeff', proposer: 'vp_aaaaaaaaaaaa', payer: {id: 'vp_aaaaaaaaaaaa', pubkey: '02' + 'a'.repeat(64)}, payee: {id: 'vp_bbbbbbbbbbbb', pubkey: '03' + 'b'.repeat(64)},
    service: {title: 'A job', description: 'synthetic', deliverable: 'text'}, price: {amount: 3, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: '2026-11-22T12:00:00Z', offer_expires_at: '2026-11-21T12:00:00Z'};
  assert.equal(termsHash(fixed), 'df6b73ebfe92f328ceee7579c3de2bcae85fff654b73c767d0e6ea26976a3939');
  const t = terms(w);
  const v = await propose(w, t);
  assert.equal(v.current.terms_hash, termsHash(t));
  assert.equal(Object.hasOwn(pilot.deal(t.deal_id).versions[0].terms, 'payment_issuer'), false);
  const seen = await pilot.dealView(pilot.deal(t.deal_id), Q);
  assert.equal(Object.hasOwn(seen, 'payment_issuer'), false);
  assert.equal(Object.hasOwn(pilot.inbox(Q).respond.find(x => x.deal_id === t.deal_id), 'payment_issuer'), false);
  await accept(w, t.deal_id);
  assert.equal(pilot.deal(t.deal_id).status, 'agreed');
  // With circulating credit off, the field is refused (no payment by transfer there).
  const off = world({mode: 'off'});
  await assert.rejects(propose(off, terms(off, {extra: {payment_issuer: party(off.A)}})), e => code('invalid_terms')(e) && /needs circulating credit/.test(e.message));
});

test("the payee's owner policy bounds the payment issuer it may agree to: refuse_notes_from, accept_notes_from and accept_transfers refuse the acceptance (403 payment_issuer_not_accepted, nothing agreed); a counter naming one is refused the same way; a payer whose pay_with_held_notes is never cannot offer such terms", async () => {
  const w = world(), {pilot, P, Q, A, X} = w;
  const t = terms(w, {extra: {payment_issuer: party(A)}});
  await propose(w, t);
  const refused = async rule => {
    await assert.rejects(accept(w, t.deal_id), e => code('payment_issuer_not_accepted')(e) && e.status === 403 && e.extra.rule === rule && e.extra.issuer === A.id
      && e.message.includes(`name ${A.handle} (${A.id}) as the payment issuer`) && e.message.includes('nothing was agreed'), rule);
    const d = pilot.deal(t.deal_id);
    assert.deepEqual([d.status, d.acceptance ?? null, d.agreement ?? null], ['open', null, null], `${rule}: nothing agreed`);
  };
  Q.mandate.refuse_notes_from = [A.id]; await refused('refuse_notes_from');
  Q.mandate.refuse_notes_from = []; Q.mandate.accept_notes_from = [X.id]; await refused('accept_notes_from');
  Q.mandate.accept_notes_from = 'any'; Q.mandate.accept_transfers = false; await refused('accept_transfers');
  Q.mandate.accept_transfers = true;
  const v = await accept(w, t.deal_id);
  assert.equal(v.status, 'agreed');
  assert.deepEqual(pilot.deal(t.deal_id).agreement.terms.payment_issuer, party(A));
  assert.ok(pilot.deal(t.deal_id).acceptance.mandate_check.checks.some(c => c.rule === 'payment_issuer' && c.issuer === A.id && c.accepted === true));
  // The payee countering with an issuer its own owner refuses: refused, nothing countered.
  const t2 = terms(w); await propose(w, t2);
  Q.mandate.refuse_notes_from = [X.id];
  const cur = pilot.current(pilot.deal(t2.deal_id));
  const c = {...terms(w, {by: Q, extra: {payment_issuer: party(X)}}), deal_id: t2.deal_id, version: 2, prior_terms_hash: cur.terms_hash};
  await assert.rejects(pilot.counter(Q, t2.deal_id, {terms: c, terms_hash: termsHash(c), signature: sig()}), e => code('payment_issuer_not_accepted')(e) && e.extra.rule === 'refuse_notes_from');
  assert.equal(pilot.deal(t2.deal_id).versions.length, 1);
  // A payer whose owner never lets it pay with notes it holds cannot offer such terms.
  P.mandate.pay_with_held_notes = 'never';
  await assert.rejects(propose(w, terms(w, {extra: {payment_issuer: party(A)}})), e => code('payment_issuer_not_accepted')(e) && e.extra.rule === 'pay_with_held_notes');
});

test("once agreed, a payment with the named issuer's note is not refused by the payee's standing lists (accept_notes_from, refuse_notes_from), at the template, the payment and the payee's consent; its caps still apply; terms without the issuer keep refusing it", async () => {
  const w = world(), {pilot, P, Q, A, X} = w;
  const d = await delivered(w, A);
  // After the agreement, Q's owner lists only X and refuses A.
  Q.mandate.accept_notes_from = [X.id]; Q.mandate.refuse_notes_from = [A.id];
  const opts = await pilot.paymentOptions(P, d.id);
  assert.deepEqual(opts.payment_issuer, {id: A.id, handle: A.handle});
  const rowA = opts.held_notes.find(h => h.issuer.id === A.id), rowX = opts.held_notes.find(h => h.issuer.id === X.id);
  assert.deepEqual([rowA.payee_accepts, rowA.why_not], [true, null]);
  assert.equal(rowX.why_not, 'payment_issuer_mismatch');
  assert.deepEqual(opts.own_note, {available: false, why_not: 'terms_name_payment_issuer'});
  const tpl = await pilot.transferTemplate(P, d.id, A.id);
  const r = await pilot.payByTransfer(P, d.id, payBody(d, tpl));
  assert.equal(r.status, 'paying_by_transfer');
  const t = pilot.s.transfers[r.transfer.id];
  assert.deepEqual([t.state, t.issuer.id, t.payee.id], ['collecting', A.id, Q.id]);
  // Q's client signs its two slots: the server's checks of Q pass (the standing lists do not refuse the named issuer).
  const sigs = {[`${tpl.to_edge.edge}:prior`]: sig(), [`${tpl.to_edge.edge}:new`]: sig()};
  const signed = await pilot.submitConsent(Q, t.id, {signatures: sigs});
  assert.ok(['to_recipient_prior', 'to_recipient'].every(s => t.slots[s]?.signature), JSON.stringify(signed.rejected));
  // Caps still apply: with max_accept_per_issuer below the price, the named issuer's note is refused (payment_not_accepted).
  const w2 = world(), d2 = await delivered(w2, w2.A);
  w2.Q.mandate.accept_notes_from = [w2.X.id]; w2.Q.mandate.max_accept_per_issuer = 2;
  await assert.rejects(w2.pilot.transferTemplate(w2.P, d2.id, w2.A.id), e => code('payment_not_accepted')(e) && e.extra.rule === 'max_accept_per_issuer');
  // Terms without a payment issuer: the standing lists refuse A's note as before.
  const w3 = world(), d3 = await delivered(w3, null);
  w3.Q.mandate.accept_notes_from = [w3.X.id];
  await assert.rejects(w3.pilot.transferTemplate(w3.P, d3.id, w3.A.id), e => code('payment_not_accepted')(e) && e.extra.rule === 'accept_notes_from');
  assert.equal((await w3.pilot.transferTemplate(w3.P, d3.id, w3.X.id)).issuer.id, w3.X.id);
});

test("another issuer's note is refused (409 payment_issuer_mismatch) at the template and the payment, before anything is created or recorded", async () => {
  const w = world(), {pilot, P, A, X} = w;
  const d = await delivered(w, A);
  const mismatch = e => code('payment_issuer_mismatch')(e) && e.status === 409 && e.extra.payment_issuer.id === A.id && e.extra.issuer === X.id
    && e.message.includes(`name ${A.handle} (${A.id}) as the payment issuer`) && e.message.includes(`pay_with=${A.handle}`);
  await assert.rejects(pilot.transferTemplate(P, d.id, X.id), mismatch);
  // A payment posted with X's note (a template for A's, the issuer swapped): refused, nothing recorded.
  const tpl = await pilot.transferTemplate(P, d.id, A.id);
  await assert.rejects(pilot.payByTransfer(P, d.id, {...payBody(d, tpl), issuer_id: X.id}), mismatch);
  assert.deepEqual([d.status, d.transfer_ids ?? [], d.refused_attempts ?? [], d.completion ?? null, Object.keys(pilot.s.transfers || {}).length], ['delivered', [], [], null, 0]);
  assert.equal(w.sent.length, 0, 'nothing was sent to the tracker');
});

test("the payer's own note is refused (409 terms_name_payment_issuer) at the template and at complete, naming the issuer and pay_with; nothing is recorded, and next_actions never offer 'complete'", async () => {
  const w = world(), {pilot, P, A} = w;
  const d = await delivered(w, A);
  const own = e => code('terms_name_payment_issuer')(e) && e.status === 409 && e.extra.payment_issuer.id === A.id
    && e.message.includes(`name ${A.handle} (${A.id}) as the payment issuer`) && e.message.includes(`pay_with=${A.handle}`) && e.message.includes('not with a note of your own');
  await assert.rejects(pilot.noteTemplate(P, d.id), own);
  await assert.rejects(pilot.noteTemplate(P, d.id, {bound: true}), own);
  const ts = w.clock.t - 3000 - ((w.clock.t - 3000) % 1000) + 997;
  await assert.rejects(pilot.complete(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: sig(),
    credit_note: {total: 3, timestamp: ts, signature: sig(), prior_total: 0, prior_timestamp: 0, prior_signature: sig()}}), own);
  assert.deepEqual([d.status, d.credit_note ?? null, d.completion ?? null, d.refused_attempts ?? []], ['delivered', null, null, []]);
  assert.equal(w.sent.length, 0, 'nothing was sent to the tracker');
  const actions = (await pilot.dealView(d, P)).next_actions;
  assert.ok(!actions.includes('complete') && actions.includes('pay_by_transfer') && actions.includes('dispute'), JSON.stringify(actions));
  // A deal without a payment issuer still offers it.
  const d2 = await delivered(w, null);
  assert.ok((await pilot.dealView(d2, P)).next_actions.includes('complete'));
});
