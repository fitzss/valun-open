// Fix inbox #107, the double pay: once a backer pays a called guarantee (the backer's own IOU to the creditor), that much
// of the issuer's IOU to the creditor is held for the backers (Pilot.heldForBackers): the creditor may not spend it (a
// payment by transfer), set it off or redeem it, and its claims leave it out, while the issuer still owes it. Basis's
// probe 16 on the live testnet: after the honor the creditor still listed the covered note as spendable and paid a third
// party with it, made whole twice for one debt. Real offers, acceptances, calls, honors and deals, signed by the real
// valun_signer, over a stub tracker.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, PROTOCOL, statements, guaranteeStatements, termsHash, sha256} from '../lib/pilot/core.mjs';
import {appendEntries} from '../lib/pilot/journal.mjs';
import {GUARANTEE_PROTOCOL, COVERS} from '../lib/pilot/guarantees.mjs';
import {checkPayer} from '../lib/pilot/card.mjs';
import {eligibleGraph} from '../lib/pilot/clearing.mjs';
import {runner, signerPath} from './tracker-harness.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const HOUR = 3600e3, PIN = 'ef'.repeat(32), NFT = 'ab'.repeat(32), TAG = Buffer.from('basis/prior-ack/1', 'ascii');
const V32_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'],
    prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};

const runSigner = makeSignerRunner({mode: runner, signerPath});
const real = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: NFT, runSigner, denomination: PILOT_DENOMINATION});
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const debtKeys = new Map();
async function paModel({issuer, recipient, priorTotal, priorTimestamp, timestamp}) {
  const k = `${issuer}>${recipient}`;
  if (!debtKeys.has(k)) debtKeys.set(k, (await runSigner(['note-message', issuer, recipient, '0', '0', NFT, PILOT_DENOMINATION])).debt_key_hex);
  return Buffer.concat([TAG, Buffer.from(debtKeys.get(k), 'hex'), u64(priorTotal), u64(priorTimestamp), u64(timestamp), Buffer.from(NFT, 'hex')]).toString('hex');
}
let signerPA;
async function hasPriorAck() {
  if (signerPA === undefined) signerPA = await runSigner(['prior-ack-message', '02' + '11'.repeat(32), '03' + '22'.repeat(32), '0', '0', '1', NFT]).then(() => true, () => false);
  return signerPA;
}

class StubTracker {
  constructor(now) { this.edges = new Map(); this.posts = []; this.now = now; }
  note(i, r) {
    const e = this.edges.get(`${i}>${r}`);
    return e ? {issuer_pubkey: i, recipient_pubkey: r, amount_collected: e.total, amount_redeemed: e.redeemed ?? 0, timestamp: e.timestamp, signature: e.signature, tracker_nft_id: NFT,
      denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}} : null;
  }
  all() { return [...this.edges.keys()].map(k => { const [i, r] = k.split('>'); return this.note(i, r); }); }
  async M(i, r, total, ts) { return (await real.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex; }
  async ok(pub, msg, sig) { return typeof sig === 'string' && /^0[23][0-9a-f]{128}$/.test(sig) && real.verify(pub, msg, sig).catch(() => false); }
  async postNote(b) {
    this.posts.push(b);
    const k = `${b.issuer_pubkey}>${b.recipient_pubkey}`, s = this.edges.get(k), bound = b.timestamp % 1000 === 997;
    if (!bound && b.timestamp % 1000 >= 995) return [400, {success: false, code: 'reserved_timestamp'}];
    if (b.timestamp <= (s?.timestamp ?? 0) || b.timestamp > this.now() || b.amount <= (s?.total ?? 0)) return [400, {success: false, code: 'not_an_increase'}];
    if (!(await this.ok(b.issuer_pubkey, await this.M(b.issuer_pubkey, b.recipient_pubkey, b.amount, b.timestamp), b.signature))) return [400, {success: false, code: 'invalid_signature'}];
    if (bound) {
      if ((b.prior_total != null && b.prior_total !== (s?.total ?? 0)) || (b.prior_timestamp != null && b.prior_timestamp !== (s?.timestamp ?? 0))) return [409, {success: false, code: 'stale_prior'}];
      const pa = await paModel({issuer: b.issuer_pubkey, recipient: b.recipient_pubkey, priorTotal: s?.total ?? 0, priorTimestamp: s?.timestamp ?? 0, timestamp: b.timestamp});
      if (!(await this.ok(b.issuer_pubkey, pa, b.prior_signature))) return [400, {success: false, code: 'invalid_prior_signature'}];
    } else if (b.prior_signature != null) return [400, {success: false, code: 'not_bound'}];
    this.edges.set(k, {total: b.amount, redeemed: s?.redeemed ?? 0, timestamp: b.timestamp, signature: b.signature});
    return [200, {success: true, data: null}];
  }
}

async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-held-')); dirs.push(dir);
  const clock = {t: Date.now() - 10 * 60e3}, tracker = new StubTracker(() => clock.t), pa = await hasPriorAck();
  const basis = {nft: NFT, denomination: PILOT_DENOMINATION, capabilities: async () => V32_CAPS, note: async (i, r) => tracker.note(i, r), allNotes: async () => tracker.all(),
    proof: async () => null, noteMessage: a => real.noteMessage(a), priorAckMessage: a => (pa ? real.priorAckMessage(a) : paModel(a).then(message_hex => ({message_hex}))),
    verify: (k, m, s) => real.verify(k, m, s), signHex: (k, m, s) => real.signHex(k, m, s),
    api: async (method, p, body) => { const [status, json] = await tracker.postNote(body); return {status, json: typeof json === 'object' ? json : null, text: JSON.stringify(json)}; }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: 'on', trackerCaps: V32_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, 'on');
  const person = async (handle, mandate = {}) => {
    const k = await real.keygen(), token = `vpa_${handle}_${hex(8)}`;
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: k.pubkey_hex, secret: k.secret_hex, status: 'active',
      created_at: iso(clock.t), owner_token_hash: sha256(`vpo_${token}`), agent_token_hash: sha256(token), token, enrollment: null,
      mandate: {...DEFAULT_MANDATE, max_issue_per_deal: 25, max_issue_outstanding: 50, max_accept_per_deal: 25, max_accept_per_issuer: 50, approve_above: 1000,
        auto_clear: false, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked', ...mandate},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: iso(clock.t), last_seen_owner: null};
    pilot.s.participants[p.id] = p;
    return p;
  };
  const A = await person('alice'), B = await person('bob'), C = await person('charlie'), E = await person('eve'), F = await person('fred');
  const w = {pilot, tracker, clock, dir, A, B, C, E, F, book: pilot.guarantees, person};
  await issue(w, E, B, 30, {ts: clock.t - 120e3});       // eve owes bob 30 (bob holds claims; charlie trusts him anyway)
  return w;
}
const sign = (X, m) => real.signHex(X.pubkey, m, X.secret);
const signText = (X, s) => sign(X, Buffer.from(s, 'utf8').toString('hex'));
async function issue(w, I, R, total, {ts = w.clock.t - 60e3} = {}) {
  const sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts)), prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, redeemed: 0, timestamp: ts, signature: sig});
}
function terms(w, {cap = 5, dueIn = 0, window = 6 * HOUR, honorHours = 24, offerFor = HOUR, note = 'backs what alice owes charlie', backer = w.B, issuer = w.A, creditor = w.C} = {}) {
  return {protocol: GUARANTEE_PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, guarantee_id: 'vg_' + hex(8), nonce: hex(16),
    backer: {id: backer.id, pubkey: backer.pubkey}, issuer: {id: issuer.id, pubkey: issuer.pubkey}, creditor: {id: creditor.id, pubkey: creditor.pubkey},
    cap: {amount: cap, unit: 'PC'}, covers: COVERS, due_at: iso(w.clock.t + dueIn), expires_at: iso(w.clock.t + dueIn + window), honor_within_hours: honorHours,
    offer_expires_at: iso(w.clock.t + offerFor), note};
}
const dealTermsOf = (w, opts) => ({...terms(w, opts), covers: 'issuer_payment_for_deals', deals: opts.deals});
async function offer(w, opts = {}) {
  const t = opts.terms ?? terms(w, opts), h = termsHash(t), backer = opts.backer ?? w.B;
  return w.book.offer(backer, {terms: t, terms_hash: h, signature: await signText(backer, guaranteeStatements.offer(h))});
}
const accept = async (w, g, C = w.C) => w.book.accept(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.accept(g.terms_hash))});
async function call(w, g, amount, {C = w.C, id = 'vgc_' + hex(8)} = {}) {
  return w.book.call(C, g.guarantee_id, {call_id: id, amount, terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.call(g.terms_hash, id, amount))});
}
async function honor(w, g, callId, {B = w.B} = {}) {
  const tpl = await w.book.noteTemplate(B, g.guarantee_id, callId, {bound: true, wait: false});
  const note = {total: tpl.total, timestamp: tpl.timestamp, signature: await sign(B, tpl.message_hex)};
  const pa = await paModel({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, priorTotal: tpl.prior_total, priorTimestamp: tpl.prior_timestamp, timestamp: tpl.timestamp});
  Object.assign(note, {prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp, prior_signature: await sign(B, pa)});
  return w.book.honor(B, g.guarantee_id, callId, {terms_hash: g.terms_hash, amount: tpl.amount, signature: await signText(B, guaranteeStatements.honor(g.terms_hash, callId, tpl.amount)), credit_note: note});
}
function dealTerms(w, payer, payee, price, extra = {}) {
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + hex(8), version: 1, prior_terms_hash: null, nonce: hex(16),
    proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'a report', description: 'a short report', deliverable: 'one markdown file'}, price: {amount: price, unit: 'PC'},
    consideration: 'credit_note_on_delivery_accepted', deliver_by: iso(w.clock.t + 2 * HOUR), offer_expires_at: iso(w.clock.t + HOUR), ...extra};
}
// A real deal end to end: alice proposes, charlie accepts (his mandate checked), delivers, alice signs and the note is
// recorded by the stub tracker. Returns the deal id.
async function propose(w, price) {
  const t = dealTerms(w, w.A, w.C, price), h = termsHash(t);
  await w.pilot.propose(w.A, {terms: t, terms_hash: h, signature: await signText(w.A, statements.propose(h))});
  return {id: t.deal_id, h};
}
const acceptDeal = async (w, {id, h}) => w.pilot.accept(w.C, id, {terms_hash: h, signature: await signText(w.C, statements.accept(h))});
async function deliverAndPay(w, id) {
  const {pilot, A, C, clock} = w, d = pilot.s.deals[id], th = d.agreement.terms_hash, content = 'the report, as agreed', sh = sha256(content);
  await pilot.deliver(C, id, {terms_hash: th, content, sha256: sh, signature: await signText(C, statements.deliver(th, sh))});
  clock.t += 3000;
  const tpl = await pilot.noteTemplate(A, id, {bound: true, wait: false});
  const pa = await paModel({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, priorTotal: tpl.prior_total, priorTimestamp: tpl.prior_timestamp, timestamp: tpl.timestamp});
  const note = {total: tpl.total, timestamp: tpl.timestamp, signature: await sign(A, tpl.message_hex), prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp, prior_signature: await sign(A, pa)};
  return pilot.complete(A, id, {terms_hash: th, deliverable_sha256: sh, signature: await signText(A, statements.complete(th, sh)), credit_note: note});
}
const edgeTotal = (w, I, R) => w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
const rule = chk => chk.checks.find(c => c.rule === 'min_payer_coverage_pct');

// Deal E (10, its note recorded through the real deal flow, with charlie's bar at 0), backed in the deal mode by fred
// alone; charlie calls it for 10 and fred honors. Fred holds nothing, has no reserve and charlie's owner does not trust
// him: his IOU is worth 0 to charlie. Charlie's owner takes any backer's guarantee (min_backer_coverage_pct 0) and trusts
// bob.
async function base() {
  const w = await world(), {pilot, A, B, C, F, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  const E = await propose(w, 10);
  await acceptDeal(w, E);
  // fred backs E (the deal mode), before its note: a guarantee names a deal not ended.
  const gE = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [E.id], backer: F}), backer: F}));
  clock.t += 1000;
  assert.equal((await deliverAndPay(w, E.id)).status, 'note_issued');
  assert.equal(edgeTotal(w, A, C), 10);
  clock.t += 1000;
  const vE = await book.viewFor(C, gE.guarantee_id);
  assert.equal(vE.callable_now, 10, 'gE callable for E');
  const cE = 'vgc_' + hex(8);
  await call(w, gE, 10, {id: cE});
  clock.t += 5000;
  await honor(w, gE, cE, {B: F});
  assert.equal(edgeTotal(w, F, C), 10, 'fred paid charlie 10 (his own IOU)');
  clock.t += 5000;
  return {w, E, gE};
}

const noteOf = (w, I, R) => w.tracker.note(I.pubkey, R.pubkey);
// The issuer's client has declared that it signs consents as issuer (as valun 0.6+ does on its reads): a note is spendable
// only then (Pilot.consentCapable).
const consenting = (w, A) => { A.client_features = {consents: true, roles: ['issuer', 'payee', 'member'], at: iso(w.clock.t)}; };
const spendable = (w, A, C) => { consenting(w, A); return w.pilot.spendableNote(C, A, noteOf(w, A, C)); };

test(`fix inbox #107: after a backer honors a call, the covered part of the issuer's IOU is not spendable, not the creditor's claim, and not clearable; the issuer still owes it`, async () => {
  const w = await world(), {pilot, A, C, F, book, clock} = w;
  C.mandate.accept_notes_from = [w.B.id];
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  const E = await propose(w, 10);
  await acceptDeal(w, E);
  const gE = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [E.id], backer: F}), backer: F}));
  clock.t += 1000;
  assert.equal((await deliverAndPay(w, E.id)).status, 'note_issued');
  clock.t += 1000;
  assert.equal(spendable(w, A, C), 10, `before any call: charlie may spend alice's note`);
  const cE = 'vgc_' + hex(8);
  await call(w, gE, 10, {id: cE});
  clock.t += 5000;
  assert.equal(spendable(w, A, C), 10, 'an open call holds nothing: collecting from alice first would make it lapse');
  await honor(w, gE, cE, {B: F});
  clock.t += 5000;
  assert.equal(edgeTotal(w, F, C), 10, 'fred paid charlie 10 with his own IOU');
  assert.equal(pilot.heldForBackers(A.id, C.id), 10);
  // Not spendable: no payment by transfer with it, and the payment options and the view say so.
  assert.equal(spendable(w, A, C), 0);
  const ledger = await pilot.ledger();
  consenting(w, A);
  const notes = pilot.spendableNotes(C, ledger), alice = notes.find(n => n.issuer_id === A.id);
  assert.equal(alice.spendable, 0, `notes_you_can_spend: nothing of alice's note`);
  // Not the creditor's claim: its position and its grounded claims leave it out; alice still owes it.
  const pos = await pilot.position(C, ledger, {own: true});
  assert.equal(pos.held_for_backers, 10);
  assert.equal(pos.claims_held, 10, `only fred's honor note: 20 on the tracker, 10 held for fred`);
  assert.deepEqual(pos.claims.filter(c => c.from === 'alice').map(c => [c.amount, c.held_for_backers]), [[0, 10]]);
  assert.equal((await pilot.position(A, ledger)).owes, 10, 'alice still owes it');
  const gv = await pilot.groundedFor(C, ledger);
  assert.equal(gv.claimsFace(C.id), 10);
  assert.equal(gv.owes(A.id), 10);
  // Not clearable: the edge alice>charlie has nothing available to cycles.
  const snap = await pilot.clearingSnapshot({ledger}), k = `${A.pubkey}>${C.pubkey}`;
  const edge = snap.edges.find(e => e.edge === k);
  assert.equal(edge.reserved, 10);
  assert.equal(eligibleGraph(snap).edges.has(k), false, 'excluded: nothing of it is available');
  // The guarantee itself: nothing left to call.
  assert.equal((await book.viewFor(C, gE.guarantee_id)).callable_now, 0);
});

test('fix inbox #107: only the covered part is held; what the issuer owes beyond it stays spendable', async () => {
  const w = await world(), {pilot, A, C, F, clock} = w;
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  const E = await propose(w, 10);
  await acceptDeal(w, E);
  const gE = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 6, deals: [E.id], backer: F}), backer: F}));
  clock.t += 1000;
  assert.equal((await deliverAndPay(w, E.id)).status, 'note_issued');
  clock.t += 1000;
  const cE = 'vgc_' + hex(8);
  await call(w, gE, 6, {id: cE});
  clock.t += 5000;
  await honor(w, gE, cE, {B: F});
  clock.t += 5000;
  assert.equal(spendable(w, A, C), 4, `10 owed, 6 paid by fred: 4 is still charlie's`);
  const ledger = await pilot.ledger(), pos = await pilot.position(C, ledger, {own: true});
  assert.deepEqual([pos.claims_held, pos.held_for_backers], [10, 6], 'alice 4 + fred 6');
  const snap = await pilot.clearingSnapshot({ledger}), edge = snap.edges.find(e => e.edge === `${A.pubkey}>${C.pubkey}`);
  assert.equal(edge.outstanding - edge.reserved, 4);
});

test('fix inbox #107: an honor waits while a redemption of the covered note may still be spent, until the tracker box it reads moves', async () => {
  const w = await world(), {pilot, A, C, F, book, clock} = w;
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  const E = await propose(w, 10);
  await acceptDeal(w, E);
  const gE = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [E.id], backer: F}), backer: F}));
  clock.t += 1000;
  assert.equal((await deliverAndPay(w, E.id)).status, 'note_issued');
  clock.t += 1000;
  let box = 'aa'.repeat(32);
  pilot.basis.trackerState = async () => ({confirmed_box_id: box});
  // charlie builds a redemption of alice's note (POST /redemption/build registers it), then calls fred's guarantee.
  pilot.noteRedemptionBuild({tx_id: 'p1', issuer_id: A.id, creditor_id: C.id, tracker_box_id: box});
  const cE = 'vgc_' + hex(8);
  await call(w, gE, 10, {id: cE});
  clock.t += 5000;
  await assert.rejects(honor(w, gE, cE, {B: F}), e => e.code === 'pair_busy' && e.extra?.retry_after_ms > 0);
  assert.equal(edgeTotal(w, F, C), 0, 'fred paid nothing');
  // The tracker posts a new box: the build reads a spent box and can no longer be spent; the honor goes ahead.
  box = 'bb'.repeat(32);
  await honor(w, gE, cE, {B: F});
  assert.equal(edgeTotal(w, F, C), 10);
  assert.equal(pilot.heldForBackers(A.id, C.id), 10);
  // A build that was submitted holds an honor for 3 minutes, until the tracker's note shows it.
  pilot.noteRedemptionBuild({tx_id: 'p2', issuer_id: A.id, creditor_id: C.id, tracker_box_id: box});
  pilot.redemptionSubmitted('p2');
  box = 'cc'.repeat(32);
  assert.ok(await pilot.redemptionInFlight(A.id, C.id), 'submitted 0 s ago');
  clock.t += 181_000;
  assert.equal(await pilot.redemptionInFlight(A.id, C.id), null);
});

