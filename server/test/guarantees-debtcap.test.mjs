// Fix inbox #79, review of e25f6aa: the coverage rule's debt cap counts what calls on EVERY guarantee of the debt claimed,
// the deal-mode guarantees of other deals included (GuaranteeBook.backingFor's `debt`), as callable() does: what a call
// on any of them claimed is paid toward the same debt and cannot be called again. Before, only the guarantees that back
// the deal under review counted, so a paid call on another deal's guarantee, by a backer worth 0 to the creditor, left
// the rule counting backing the backers could not pay: R4 showed 100% where 33% could be paid, and R3 90% for 9%.
// Real offers, acceptances, calls, honors and deals, signed by the real valun_signer, over a stub tracker.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-debtcap-')); dirs.push(dir);
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

const probe = async (w, D, price) => {
  const {pilot, A, C} = w, keep = C.mandate.min_payer_coverage_pct;
  pilot.setMandate(C, {min_payer_coverage_pct: 1});
  const r = rule(await pilot.checkMandate(C, 'payee', A.id, price, {dealId: D.id, debtFrom: Date.parse(pilot.current(pilot.s.deals[D.id]).terms.deliver_by), excludeDealId: D.id}));
  pilot.setMandate(C, {min_payer_coverage_pct: keep});
  return r;
};

test("fix inbox #79 R4: a deal-mode stack for D on top of a paid call on E's deal-mode guarantee counts what the backers can still pay (33%), and D is refused at 70%", async () => {
  const {w} = await base(), {pilot, A, B, C, F, book, clock} = w;
  const D = await propose(w, 5);
  const gF = await accept(w, await offer(w, {cap: 10}));                                                     // bob, floating, 10
  clock.t += 1000;
  const g1 = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 5, deals: [D.id], backer: B})}));     // bob, D, 5 (older)
  clock.t += 1000;
  await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [D.id], backer: F}), backer: F}));   // fred, D, 10
  clock.t += 1000;
  const gv = await pilot.groundedFor(C, await pilot.ledger());
  assert.deepEqual([gv.ratio(B.id), gv.ratio(F.id)], [1, 0], 'charlie trusts bob; fred is worth nothing to him');
  // Alice owes 10 and would owe 15; fred's call claimed 10 of it (worth 0), so 5 can still be called, at bob's worth 1.
  const r = await probe(w, D, 5);
  assert.deepEqual([r.backing_for_you, r.already_paid_by_backers, r.coverage_pct], [5, 0, 33]);
  pilot.setMandate(C, {min_payer_coverage_pct: 70});
  A.mandate.public_card = true;
  const chk = await checkPayer(pilot, A, {amount: 5, payee: C, showCover: true, deal: pilot.s.deals[D.id]});
  assert.equal(chk.payee_side?.verdict, 'decline', "charlie's own check says what accepting would do");
  await assert.rejects(acceptDeal(w, D), e => e.code === 'mandate_exceeded' && /min_payer_coverage_pct/.test(e.extra?.rule ?? e.message));
  assert.equal(pilot.s.deals[D.id].status, 'open', 'the deal stays open');
  // What the backers can in fact pay once D's note is recorded: one room of 5, shared by every guarantee of the debt.
  pilot.setMandate(C, {min_payer_coverage_pct: 0});
  await acceptDeal(w, D);
  assert.equal((await deliverAndPay(w, D.id)).status, 'note_issued');
  assert.equal(edgeTotal(w, A, C), 15);
  clock.t += 2000;
  const c1 = 'vgc_' + hex(8);
  await call(w, g1, 5, {id: c1});
  clock.t += 5000;
  await honor(w, g1, c1);
  clock.t += 2000;
  assert.equal((await book.viewFor(C, gF.guarantee_id)).callable_now, 0, 'nothing more is callable once bob paid 5');
  await assert.rejects(call(w, gF, 1), e => e.code === 'exceeds_callable');
});

test("fix inbox #79 R3: a floating guarantee next to a paid call on another deal's guarantee counts 1 of 11 (9%), and D is refused at 50%", async () => {
  const {w} = await base(), {pilot, C, book, clock} = w;
  const D = await propose(w, 1);
  const gF = await accept(w, await offer(w, {cap: 10}));
  clock.t += 1000;
  const r = await probe(w, D, 1);
  assert.deepEqual([r.backing_for_you, r.already_paid_by_backers, r.coverage_pct], [1, 0, 9]);
  pilot.setMandate(C, {min_payer_coverage_pct: 50});
  await assert.rejects(acceptDeal(w, D), e => e.code === 'mandate_exceeded');
  // Accepted at 0, D's note recorded: gF is callable for 1, as the rule counted.
  pilot.setMandate(C, {min_payer_coverage_pct: 0});
  await acceptDeal(w, D);
  assert.equal((await deliverAndPay(w, D.id)).status, 'note_issued');
  clock.t += 2000;
  assert.equal((await book.viewFor(C, gF.guarantee_id)).callable_now, 1);
});

test('fix inbox #79 R4 control: with fred trusted, what he paid counts at face (already_paid 10), and D is covered whole', async () => {
  const {w} = await base(), {pilot, A, B, C, F, clock} = w;
  C.mandate.accept_notes_from = [B.id, F.id];
  const D = await propose(w, 5);
  await accept(w, await offer(w, {cap: 10}));
  clock.t += 1000;
  await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 5, deals: [D.id], backer: B})}));
  clock.t += 1000;
  await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [D.id], backer: F}), backer: F}));
  const r = await probe(w, D, 5);
  assert.deepEqual([r.backing_for_you, r.already_paid_by_backers, r.coverage_pct], [5, 10, 100]);
  pilot.setMandate(C, {min_payer_coverage_pct: 70});
  await acceptDeal(w, D);
  assert.equal(pilot.s.deals[D.id].status === 'agreed' || pilot.s.deals[D.id].status === 'accepted', true, pilot.s.deals[D.id].status);
});

// Review of ebed481: an unhonored call counts as paid only on a guarantee the deal's acceptance holds against release
// (review F6), and the room left to call leaves out what the payer owes the creditor as a backer (honorDebt).
const releaseG = async (w, g, C = w.C) => w.book.release(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.release(g.terms_hash))});
// Alice owes charlie 10 through deal E. mode 'deal': fred backs E in the deal mode (cap 10); 'floating': fred backs any
// of alice's debt to charlie (cap 10). Charlie trusts bob and fred, calls fred's guarantee for 10; fred honors only when
// honored is true.
async function calledOnE({mode, honored}) {
  const w = await world(), {pilot, A, B, C, F, clock} = w;
  C.mandate.accept_notes_from = [B.id, F.id];
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  const E = await propose(w, 10);
  await acceptDeal(w, E);
  let g = mode === 'deal' ? await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [E.id], backer: F}), backer: F})) : null;
  clock.t += 1000;
  assert.equal((await deliverAndPay(w, E.id)).status, 'note_issued');
  clock.t += 1000;
  if (mode === 'floating') g = await accept(w, await offer(w, {cap: 10, backer: F}));
  clock.t += 1000;
  const cid = 'vgc_' + hex(8);
  await call(w, g, 10, {id: cid});
  clock.t += 5000;
  if (honored) { await honor(w, g, cid, {B: F}); clock.t += 5000; }
  return {w, g, cid};
}
for (const [name, mode, honored, pct] of [['DC1', 'deal', false, 0], ['DC2', 'floating', false, 0], ['DC3', 'deal', true, 66], ['DC4', 'floating', true, 66]]) {
  test(`review of ebed481 ${name}: a ${mode} guarantee of alice's debt, its call for 10 ${honored ? 'honored' : 'still open'}: D at 5 counts ${pct}%`, async () => {
    const {w, g, cid} = await calledOnE({mode, honored}), {pilot, C} = w;
    const D = await propose(w, 5);
    if (honored) {
      const r = await probe(w, D, 5);
      assert.deepEqual([r.backing_for_you ?? 0, r.already_paid_by_backers, r.coverage_pct], [0, 10, pct]);
    } else {
      // At 0% even the probe's bar of 1% refuses, and the refusal says the cover.
      await assert.rejects(probe(w, D, 5), e => e.code === 'mandate_exceeded' && / cover 0% of what it would owe with this deal \(15 PC\)/.test(e.message));
    }
    pilot.setMandate(C, {min_payer_coverage_pct: 60});
    if (!honored) {
      // An open call on a guarantee the deal's acceptance does not hold is no cover: the creditor's agent could release
      // the guarantee and void the call. Refused, as before #79.
      await assert.rejects(acceptDeal(w, D), e => e.code === 'mandate_exceeded');
      return;
    }
    await acceptDeal(w, D);
    assert.equal(pilot.s.deals[D.id].status, 'agreed');
    // An honored call cannot be undone by a release: the cover stays.
    assert.equal((await releaseG(w, g)).state, 'released');
    assert.equal(pilot.s.guarantees[g.guarantee_id].calls.find(c => c.id === cid).state, 'honored');
    assert.equal((await probe(w, D, 5)).coverage_pct, 66);
  });
}

test('review of ebed481 HD1: the room left to call leaves out what alice owes charlie as a backer (her honor notes): 5 of 15, refused at 50%', async () => {
  const w = await world(), {pilot, A, B, C, clock} = w;
  const X = await w.person('xavier');
  C.mandate.accept_notes_from = [B.id];
  pilot.setMandate(C, {min_backer_coverage_pct: 0, min_payer_coverage_pct: 0});
  // Xavier owes charlie 10; alice backs it and pays: alice -> charlie 10 is her honor debt, not her own payment debt.
  await issue(w, X, C, 10);
  const gA = await accept(w, await offer(w, {cap: 10, backer: A, issuer: X, note: 'alice backs xavier'}));
  clock.t += 1000;
  const cA = 'vgc_' + hex(8);
  await call(w, gA, 10, {id: cA});
  clock.t += 5000;
  await honor(w, gA, cA, {B: A});
  clock.t += 5000;
  assert.equal(edgeTotal(w, A, C), 10);
  // Alice proposes D at 5 and bob (trusted) backs alice's debt to charlie, floating, up to 10.
  const D = await propose(w, 5);
  const gB = await accept(w, await offer(w, {cap: 10}));
  clock.t += 1000;
  const r = await probe(w, D, 5);
  assert.deepEqual([r.backing_for_you, r.coverage_pct], [5, 33], 'what gB can be called for once D is paid: 15 owed less the 10 of honor debt');
  pilot.setMandate(C, {min_payer_coverage_pct: 50});
  await assert.rejects(acceptDeal(w, D), e => e.code === 'mandate_exceeded');
  // With D's note recorded, gB is callable for exactly that.
  pilot.setMandate(C, {min_payer_coverage_pct: 0});
  await acceptDeal(w, D);
  assert.equal((await deliverAndPay(w, D.id)).status, 'note_issued');
  clock.t += 2000;
  assert.equal((await w.book.viewFor(C, gB.guarantee_id)).callable_now, 5);
});
