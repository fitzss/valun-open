// The independent review of guarantees (2026-11-13; its reproductions were valun-app-adv test/guarantees-adversarial),
// as regression tests: each finding as it behaves after the fix. Same stub tracker, real keys and real valun_signer as
// test/guarantees.test.mjs. Coverage is grounded (fix inbox #20), so a creditor's owner names the backers it trusts.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, PROTOCOL, statements, guaranteeStatements, termsHash, sha256} from '../lib/pilot/core.mjs';
import {appendEntries, edgeKey} from '../lib/pilot/journal.mjs';
import {GUARANTEE_PROTOCOL, COVERS} from '../lib/pilot/guarantees.mjs';
import {evidenceLines} from '../lib/pilot/agents.mjs';
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

// The stub tracker v3.2 (POST /notes only), as in test/guarantees.test.mjs.
class StubTracker {
  constructor(now) { this.edges = new Map(); this.posts = []; this.now = now; this.refuseNext = null; }
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
    if (this.refuseNext) { const r = this.refuseNext; this.refuseNext = null; return r; }
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

// alice (issuer), bob (backer), charlie (creditor; his owner requires 100% coverage), eve (owes bob 30, so bob holds
// claims and charlie's coverage rule takes him as a backer). `person` makes more participants.
async function world({backerApproveAbove = 1000} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-guarantees-adv-')); dirs.push(dir);
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
  const A = await person('alice'), B = await person('bob', {approve_above: backerApproveAbove}), C = await person('charlie', {min_payer_coverage_pct: 100});
  const E = await person('eve');
  const w = {pilot, tracker, clock, dir, A, B, C, E, book: pilot.guarantees, person};
  await issue(w, E, B, 30, {ts: clock.t - 120e3});
  return w;
}
const sign = (X, m) => real.signHex(X.pubkey, m, X.secret);
const signText = (X, s) => sign(X, Buffer.from(s, 'utf8').toString('hex'));
async function issue(w, I, R, total, {ts = w.clock.t - 60e3} = {}) {
  const sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts)), prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, redeemed: 0, timestamp: ts, signature: sig});
}
async function repay(w, I, R, total, {ts = w.clock.t - 30e3} = {}) {
  const k = `${I.pubkey}>${R.pubkey}`, prev = w.tracker.edges.get(k).total, sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts));
  appendEntries(w.pilot, [{kind: 'setoff', ref: 'vs_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(k, {total, redeemed: 0, timestamp: ts, signature: sig});
}
function terms(w, {cap = 5, dueIn = 0, window = 2 * HOUR, honorHours = 24, offerFor = HOUR, note = 'bob backs what alice owes charlie', backer = w.B, issuer = w.A, creditor = w.C} = {}) {
  return {protocol: GUARANTEE_PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, guarantee_id: 'vg_' + hex(8), nonce: hex(16),
    backer: {id: backer.id, pubkey: backer.pubkey}, issuer: {id: issuer.id, pubkey: issuer.pubkey}, creditor: {id: creditor.id, pubkey: creditor.pubkey},
    cap: {amount: cap, unit: 'PC'}, covers: COVERS, due_at: iso(w.clock.t + dueIn), expires_at: iso(w.clock.t + dueIn + window), honor_within_hours: honorHours,
    offer_expires_at: iso(w.clock.t + offerFor), note};
}
async function offer(w, opts = {}) {
  const t = opts.terms ?? terms(w, opts), h = termsHash(t), backer = opts.backer ?? w.B;
  return w.book.offer(backer, {terms: t, terms_hash: h, signature: await signText(backer, guaranteeStatements.offer(h))});
}
const accept = async (w, g, C = w.C) => w.book.accept(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.accept(g.terms_hash))});
async function call(w, g, amount, {C = w.C, id = 'vgc_' + hex(8)} = {}) {
  return w.book.call(C, g.guarantee_id, {call_id: id, amount, terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.call(g.terms_hash, id, amount))});
}
async function honor(w, g, callId, {B = w.B, bound = true} = {}) {
  const tpl = await w.book.noteTemplate(B, g.guarantee_id, callId, {bound, wait: false});
  const note = {total: tpl.total, timestamp: tpl.timestamp, signature: await sign(B, tpl.message_hex)};
  if (bound) {
    const pa = await paModel({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, priorTotal: tpl.prior_total, priorTimestamp: tpl.prior_timestamp, timestamp: tpl.timestamp});
    assert.equal(tpl.prior_message_hex, pa, 'the template\'s prior acknowledgment is PA of the pair\'s note');
    Object.assign(note, {prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp, prior_signature: await sign(B, pa)});
  }
  return w.book.honor(B, g.guarantee_id, callId, {terms_hash: g.terms_hash, amount: tpl.amount, signature: await signText(B, guaranteeStatements.honor(g.terms_hash, callId, tpl.amount)), credit_note: note});
}
const rejects = (p, code) => assert.rejects(p, e => (e instanceof PilotError && e.code === code) || assert.fail(`expected ${code}, got ${e?.code}: ${e?.message}`));
const edgeTotal = (w, I, R) => w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;

// ---------- each review finding, as it behaves after the fix ----------

test('F1 fixed: two backers of one debt pay it once between them; the record shows what was called, not twice the debt', async () => {
  const w = await world(), {pilot, A, B, C, E, book, clock} = w;
  const F = await w.person('fred');
  await issue(w, E, F, 30, {ts: clock.t - 110e3});
  C.mandate.accept_notes_from = [B.id, F.id];                  // charlie's owner trusts both backers (fix inbox #20)
  await issue(w, A, C, 5);
  const g1 = await accept(w, await offer(w, {cap: 5, backer: B}));
  const g2 = await accept(w, await offer(w, {cap: 5, backer: F}));
  const c1 = 'vgc_' + hex(8);
  await call(w, g1, 5, {id: c1});
  clock.t += 5000;
  assert.equal((await honor(w, g1, c1)).calls[0].state, 'honored');
  const v2 = await book.viewFor(C, g2.guarantee_id);
  assert.deepEqual([v2.issuer_owes_creditor, v2.claimed, v2.callable_now, v2.debt.claimed_by_all_guarantees], [5, 0, 0, 5]);
  await rejects(call(w, g2, 5), 'exceeds_callable');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, B, C), edgeTotal(w, F, C)], [5, 5, 0]);
  assert.deepEqual((await pilot.publicPosition(A)).evidence.backing.backed_as_issuer.called_against, {count: 1, PC: 5});
});

test('F1b fixed: one backer\'s two guarantees of one debt pay it once', async () => {
  const w = await world(), {A, B, C, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  await issue(w, A, C, 5);
  const g1 = await accept(w, await offer(w, {cap: 5})), g2 = await accept(w, await offer(w, {cap: 5}));
  const id = 'vgc_' + hex(8); await call(w, g1, 5, {id}); clock.t += 5000; await honor(w, g1, id);
  await rejects(call(w, g2, 5), 'exceeds_callable');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, B, C)], [5, 5]);
});

test('F2 fixed: calls cannot exceed the debt, and once the issuer repays, calls it no longer owes stop standing against it (and lapse when read)', async () => {
  const w = await world(), {pilot, A, B, C, book} = w;
  C.mandate.accept_notes_from = [B.id];
  await issue(w, A, C, 2);
  const gs = [];
  for (let i = 0; i < 3; i++) gs.push(await accept(w, await offer(w, {cap: 2, dueIn: -59 * 60e3})));
  await call(w, gs[0], 2);
  for (const g of gs.slice(1)) await rejects(call(w, g, 2), 'exceeds_callable');
  assert.deepEqual((await pilot.publicPosition(A)).evidence.backing.backed_as_issuer.called_against, {count: 1, PC: 2});
  await repay(w, A, C, 0);
  // Read straight from the record (nothing lapsed it yet): the open call no longer stands.
  assert.deepEqual((await pilot.publicPosition(A)).evidence.backing.backed_as_issuer.called_against, {count: 0, PC: 0});
  assert.deepEqual((await pilot.publicEvidence()).backing.called, {count: 0, PC: 0});
  // Any view of it lapses it.
  const v = await book.viewFor(A, gs[0].guarantee_id);
  assert.equal(v.calls[0].state, 'lapsed');
});

test('F3 fixed: an acceptance whose offer expired while it awaited the tracker is refused', async () => {
  const w = await world(), {pilot, B, book, clock} = w;
  w.C.mandate.accept_notes_from = [B.id];
  const g = await offer(w, {offerFor: 60e3});
  const realLedger = pilot.ledger.bind(pilot);
  let seen = null;
  pilot.ledger = async () => {
    const l = await realLedger();
    if (seen === null) { seen = 'reading'; clock.t = Date.parse(g.offer_expires_at) + 1000; seen = (await book.viewFor(B, g.guarantee_id)).state; }
    return l;
  };
  await rejects(accept(w, g), 'not_open');
  pilot.ledger = realLedger;
  assert.equal(seen, 'offer_expired');
  assert.equal(pilot.s.guarantees[g.guarantee_id].state, 'offer_expired');
});

test('F4 fixed: a backer\'s note being issued holds its edge against a payment by transfer', async () => {
  const w = await world(), {pilot, tracker, A, B, C, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const g = await accept(w, await offer(w, {cap: 5}));
  await issue(w, A, C, 5);
  const id = 'vgc_' + hex(8);
  await call(w, g, 5, {id});
  clock.t += 5000;
  const c = pilot.s.guarantees[g.guarantee_id].calls[0];
  const tpl = await book.noteTemplate(B, g.guarantee_id, id, {bound: false, wait: false});
  const sig = await sign(B, tpl.message_hex);
  Object.assign(c, {state: 'issuing', keys: {issuer: B.pubkey, recipient: C.pubkey}, prior_total: 0, note_prior: {total: 0, timestamp: null, signature: null},
    note: {total: tpl.total, timestamp: tpl.timestamp, signature: sig, message_hex: tpl.message_hex}});
  pilot.save();
  assert.equal((await tracker.postNote({issuer_pubkey: B.pubkey, recipient_pubkey: C.pubkey, amount: tpl.total, timestamp: tpl.timestamp, signature: sig}))[0], 200);
  assert.throws(() => pilot.assertTransferEdgeFree(edgeKey(B.pubkey, C.pubkey)), e => e.code === 'edge_busy' && /guarantee/.test(e.message));
  // Recovery then finds its own note and records the honor once.
  assert.deepEqual(await pilot.recover(), [`${id}:honored`]);
  assert.doesNotThrow(() => pilot.assertTransferEdgeFree(edgeKey(B.pubkey, C.pubkey)));
});

test('F5 fixed: a creditor\'s coverage rule on a backer counts the backer\'s other open caps as what it may have to pay', async () => {
  const w = await world(), {pilot, B, C, E} = w;
  const D = await w.person('dora');
  await accept(w, await offer(w, {cap: 25, creditor: D}), D);   // bob backs alice's debts to dora, up to 25
  C.mandate.accept_notes_from = [E.id];                        // charlie trusts eve's IOUs (bob holds 30), not bob himself
  await assert.rejects(accept(w, await offer(w, {cap: 25})), e => e.code === 'mandate_exceeded' && e.extra.rule === 'min_payer_coverage_pct' && /cover 60%/.test(e.message));
  C.mandate.min_payer_coverage_pct = 50;                       // to read the entry: 54% passes 50%
  const chk = await pilot.checkMandate(C, 'payee', B.id, 5, {guarantee: true});
  const cov = chk.checks.find(x => x.rule === 'min_payer_coverage_pct');
  assert.deepEqual([cov.payer_claims_grounded, cov.payer_guaranteed, cov.coverage_pct], [30, 50, 54], '30 of claims against 25 + 25 open caps + 5');
});

function dealTerms(w, payer, payee, price, extra = {}) {
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + hex(8), version: 1, prior_terms_hash: null, nonce: hex(16),
    proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'a report', description: 'a short report', deliverable: 'one markdown file'}, price: {amount: price, unit: 'PC'},
    consideration: 'credit_note_on_delivery_accepted', deliver_by: iso(w.clock.t + 2 * HOUR), offer_expires_at: iso(w.clock.t + HOUR), ...extra};
}
test('F6 fixed: a guarantee a committed deal\'s acceptance relied on cannot be released by the agent until that deal is paid or ended', async () => {
  const w = await world(), {pilot, A, B, C, book} = w;
  C.mandate.accept_notes_from = [B.id];
  await rejects(pilot.checkMandate(C, 'payee', A.id, 5), 'mandate_exceeded');
  const g = await accept(w, await offer(w, {cap: 5, window: 6 * HOUR}));
  const t = dealTerms(w, A, C, 5), h = termsHash(t);
  await pilot.propose(A, {terms: t, terms_hash: h, signature: await signText(A, statements.propose(h))});
  await pilot.accept(C, t.deal_id, {terms_hash: h, signature: await signText(C, statements.accept(h))});
  assert.equal(pilot.s.deals[t.deal_id].status, 'agreed');
  await assert.rejects(book.release(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.release(g.terms_hash))}),
    e => e.code === 'guarantee_in_use' && e.extra.deals.includes(t.deal_id));
});

test('F6b fixed: a guarantee that expires before the deal\'s debt can arise does not count as cover for it', async () => {
  const w = await world(), {pilot, A, B, C} = w;
  C.mandate.accept_notes_from = [B.id];
  await accept(w, await offer(w, {cap: 5, window: HOUR, offerFor: 30 * 60e3}));
  const t = dealTerms(w, A, C, 5, {deliver_by: iso(w.clock.t + 3 * 24 * HOUR)}), h = termsHash(t);
  await pilot.propose(A, {terms: t, terms_hash: h, signature: await signText(A, statements.propose(h))});
  await assert.rejects(pilot.accept(C, t.deal_id, {terms_hash: h, signature: await signText(C, statements.accept(h))}),
    e => e.code === 'mandate_exceeded' && e.extra.rule === 'min_payer_coverage_pct');
  // One that lasts past delivery does.
  await accept(w, await offer(w, {cap: 5, window: 4 * 24 * HOUR, offerFor: 30 * 60e3}));
  await pilot.accept(C, t.deal_id, {terms_hash: h, signature: await signText(C, statements.accept(h))});
  assert.equal(pilot.s.deals[t.deal_id].status, 'agreed');
});

test('F7 fixed: a call the issuer repaid does not stay overdue on the backer\'s record nor hold its limits', async () => {
  const w = await world(), {pilot, A, B, C, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const g = await accept(w, await offer(w, {cap: 5, honorHours: 1}));
  await issue(w, A, C, 5);
  const id = 'vgc_' + hex(8);
  await call(w, g, 5, {id});
  await repay(w, A, C, 0);
  clock.t += 2 * HOUR;
  assert.deepEqual((await pilot.publicPosition(B)).evidence.backing.given.overdue, {count: 0, PC: 0});
  const v = await book.viewFor(B, g.guarantee_id);
  assert.deepEqual([v.state, v.calls[0].state], ['expired', 'lapsed']);
  assert.equal(pilot.exposure(B, await pilot.ledger(), {asRole: 'payer'}).guaranteed, undefined, 'nothing held against bob\'s limits');
});

test('F8 fixed: the issuer sees that a call was honored, not the backer\'s note or honor signatures', async () => {
  const w = await world(), {A, B, C, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const g = await accept(w, await offer(w, {cap: 3}));
  await issue(w, A, C, 3);
  const id = 'vgc_' + hex(8);
  await call(w, g, 3, {id});
  clock.t += 5000;
  await honor(w, g, id);
  const va = await book.viewFor(A, g.guarantee_id), vc = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([va.calls[0].state, 'signature' in va.calls[0].note, 'honor_signature' in va.calls[0]], ['honored', false, false]);
  assert.match(vc.calls[0].note.signature, /^0[23][0-9a-f]{128}$/, 'the creditor still sees them');
});

test('F10 fixed: a guarantee\'s times must be ISO 8601 in UTC', async () => {
  const w = await world(), {clock} = w;
  const t = terms(w), exp = Math.floor((clock.t + 90 * 60e3) / 1000) * 1000;
  t.expires_at = `${new Date(exp).toUTCString()} (callable until 2027-12-31)`;
  await assert.rejects(offer(w, {terms: t}), e => e.code === 'invalid_terms' && /ISO 8601 time in UTC/.test(e.message));
  const t2 = terms(w);
  t2.offer_expires_at = new Date(clock.t + 30 * 60e3).toISOString().replace(/\.\d{3}Z$/, '');
  await assert.rejects(offer(w, {terms: t2}), e => e.code === 'invalid_terms');
  const t3 = terms(w);
  t3.offer_expires_at = new Date(clock.t + 30 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');   // no milliseconds: fine
  assert.equal((await offer(w, {terms: t3})).state, 'offered');
});

test('F11 fixed: revoking the backer\'s agent ends its guarantee offers (void_key_revoked) and frees its capacity', async () => {
  const w = await world(), {pilot, B, C, book} = w;
  const g = await offer(w, {cap: 20, dueIn: 6 * 24 * HOUR, offerFor: 6 * 24 * HOUR});
  const r = await pilot.revokeAgent(B);
  assert.deepEqual(r.voided_guarantee_offers, [g.guarantee_id]);
  assert.equal((await book.viewFor(C, g.guarantee_id)).state, 'void_key_revoked');
  assert.ok(!(pilot.inbox(C).guarantees?.to_answer ?? []).some(x => x.guarantee_id === g.guarantee_id));
  assert.equal(pilot.exposure(B, await pilot.ledger(), {asRole: 'payer'}).guaranteed, undefined);
});

// ---------- fix inbox #19, Basis's acceptance tests T19-1, T19-7 and T19-9 (handoff 3.1) ----------

test('T19-1: the second guarantee\'s call is refused, and the refusal names the other guarantee\'s claim', async () => {
  const w = await world(), {A, B, C, clock} = w;
  const D = await w.person('dan');
  await issue(w, w.E, D, 30, {ts: clock.t - 110e3});
  C.mandate.accept_notes_from = [B.id, D.id];
  await issue(w, A, C, 5);
  const g1 = await accept(w, await offer(w, {cap: 5})), g2 = await accept(w, await offer(w, {cap: 5, backer: D}));
  const c1 = 'vgc_' + hex(8);
  await call(w, g1, 5, {id: c1});
  clock.t += 5000;
  await honor(w, g1, c1);
  await assert.rejects(call(w, g2, 5), e => e.code === 'exceeds_callable' && new RegExp(`earlier calls on this debt claimed 5 PC \\(5 PC via ${g1.guarantee_id}\\)`).test(e.message)
    && e.extra.claimed_by_other_guarantees?.[0]?.guarantee_id === g1.guarantee_id);
});

test('T19-7: a chain of guarantees, each backing the last backer\'s honor note, recovers at most the root debt', async () => {
  const w = await world(), {A, B, C, clock} = w;
  const B2 = await w.person('bob2'), B3 = await w.person('bob3');
  for (const x of [B2, B3]) await issue(w, w.E, x, 30, {ts: clock.t - 100e3});
  C.mandate.accept_notes_from = [B.id, B2.id, B3.id];
  await issue(w, A, C, 5);                                             // the root debt: alice owes charlie 5
  const g1 = await accept(w, await offer(w, {cap: 5}));                // bob backs alice -> charlie
  const g2 = await accept(w, await offer(w, {cap: 5, backer: B2, issuer: B}));   // bob2 backs bob -> charlie
  const g3 = await accept(w, await offer(w, {cap: 5, backer: B3, issuer: B2}));  // bob3 backs bob2 -> charlie
  const c1 = 'vgc_' + hex(8);
  await call(w, g1, 5, {id: c1});
  clock.t += 5000;
  await honor(w, g1, c1);                                              // bob pays charlie 5 with his own note
  const v2 = await w.book.viewFor(C, g2.guarantee_id);
  assert.deepEqual([v2.issuer_owes_on_tracker, v2.issuer_honor_debt, v2.issuer_owes_creditor, v2.callable_now], [5, 5, 0, 0], 'bob owes 5, all of it his payment as a backer');
  await assert.rejects(call(w, g2, 5), e => e.code === 'exceeds_callable' && /own payments to you as a backer/.test(e.message));
  await rejects(call(w, g3, 1), 'exceeds_callable');
  const paid = [B, B2, B3].reduce((a, x) => a + edgeTotal(w, x, C), 0);
  assert.equal(paid, 5, 'backers paid charlie 5 in all for alice\'s default of 5');
  // bob's own, ordinary debt to charlie is still what g2 covers.
  await issue(w, B, C, 8, {ts: clock.t - 1000});
  assert.equal((await w.book.viewFor(C, g2.guarantee_id)).callable_now, 3);
});

// A small deterministic PRNG (mulberry32), so a failing sequence can be replayed by its seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const EXPECTED_REFUSALS = new Set(['exceeds_callable', 'call_open', 'call_lapsed', 'mandate_exceeded', 'not_due', 'not_active', 'pair_busy', 'note_timestamp_ahead',
  'too_many_open_offers', 'already_honored', 'wrong_state', 'not_open', 'stale_note', 'edge_busy', 'guarantee_in_use']);

test('T19-9: over random sequences of borrow, repay, offer, accept, call and honor on two debts with up to four guarantees, backers never pay more than the debt ever was', async () => {
  let honoredCalls = 0, callsMade = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = prng(seed), pick = xs => xs[Math.floor(rnd() * xs.length)], int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const w = await world(), {A, B, C, clock, book} = w;
    const D = await w.person('dan'), A2 = await w.person('alice2');
    await issue(w, w.E, D, 30, {ts: clock.t - 110e3});
    C.mandate.accept_notes_from = [B.id, D.id];
    C.mandate.min_payer_coverage_pct = 0;
    B.mandate.max_issue_outstanding = 1000; D.mandate.max_issue_outstanding = 1000;
    const issuers = [A, A2], backers = [B, D], maxD = new Map(issuers.map(x => [x.id, 0])), log = [];
    const total = (I, R) => w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
    const step = async () => {
      const op = pick(['borrow', 'borrow', 'borrow', 'repay', 'offer', 'offer', 'call', 'call', 'call', 'honor', 'honor']), I = pick(issuers);
      clock.t += 4000;
      if (op === 'borrow') await issue(w, I, C, total(I, C) + int(1, 5), {ts: clock.t - 500});
      else if (op === 'repay' && total(I, C) > 0) await repay(w, I, C, Math.max(0, total(I, C) - int(1, 4)), {ts: clock.t - 500});
      else if (op === 'offer') { if (Object.values(w.pilot.s.guarantees || {}).filter(g => g.issuer === I.id).length < 4) await accept(w, await offer(w, {cap: int(1, 8), backer: pick(backers), issuer: I})); }
      else if (op === 'call') {
        const gs = Object.values(w.pilot.s.guarantees || {}).filter(g => g.state === 'active');
        if (gs.length) { const g = pick(gs), v = await book.viewFor(C, g.id); await call(w, {guarantee_id: g.id, terms_hash: g.terms_hash}, Math.max(1, rnd() < 0.7 ? v.callable_now : v.callable_now + int(-1, 2))); }
      } else if (op === 'honor') {
        const open = Object.values(w.pilot.s.guarantees || {}).flatMap(g => g.calls.filter(c => c.state === 'open').map(c => [g, c]));
        if (open.length) { const [g, c] = pick(open); await honor(w, {guarantee_id: g.id, terms_hash: g.terms_hash}, c.id, {B: w.pilot.s.participants[g.backer]}); }
      }
      log.push(op);
    };
    for (let i = 0; i < 30; i++) {
      try { await step(); } catch (e) { if (!(e instanceof PilotError && EXPECTED_REFUSALS.has(e.code))) throw new Error(`seed ${seed} step ${i} (${log.slice(-3).join(', ')}): ${e.code ?? ''} ${e.message}`); }
      for (const I of issuers) maxD.set(I.id, Math.max(maxD.get(I.id), total(I, C)));
      for (const I of issuers) {
        const gs = Object.values(w.pilot.s.guarantees || {}).filter(g => g.issuer === I.id && g.creditor === C.id);
        const claimed = gs.reduce((a, g) => a + book.claimed(g), 0), honored = gs.reduce((a, g) => a + book.honoredAmount(g), 0);
        assert.ok(claimed <= maxD.get(I.id), `seed ${seed} step ${i}: ${I.handle}: claimed ${claimed} > the most it ever owed, ${maxD.get(I.id)} (${log.join(', ')})`);
        assert.ok(honored <= maxD.get(I.id), `seed ${seed} step ${i}: honored ${honored} > ${maxD.get(I.id)}`);
        for (const g of gs) assert.ok(book.claimed(g) <= g.terms.cap.amount, `seed ${seed}: a guarantee claimed beyond its cap`);
      }
    }
    const all = Object.values(w.pilot.s.guarantees || {}).flatMap(g => g.calls);
    callsMade += all.length; honoredCalls += all.filter(c => c.state === 'honored').length;
  }
  // The sequences exercise the paths they check: calls are made and honored, not only refused.
  assert.ok(callsMade >= 25 && honoredCalls >= 10, `only ${callsMade} calls and ${honoredCalls} honors across the seeds`);
});

// ---------- fix inbox #24 and #25 ----------
test('#24: a separate coverage bar for backers: 60% for payers and 20% for backers accepts a backer covered 20%', async () => {
  const w = await world(), {pilot, C, E, book} = w;
  const F = await w.person('fred');
  await issue(w, E, F, 5, {ts: w.clock.t - 110e3});              // fred holds 5 of eve's IOUs
  C.mandate.accept_notes_from = [E.id];                         // charlie trusts eve's IOUs
  C.mandate.min_payer_coverage_pct = 60;
  const g = await offer(w, {cap: 25, backer: F});
  // Without a backer bar the payer bar applies: 5 of 25 is 20%, below 60%.
  await assert.rejects(accept(w, g), e => e.code === 'mandate_exceeded' && e.extra.rule === 'min_payer_coverage_pct' && /with this guarantee/.test(e.message)
    && /min_backer_coverage_pct sets a separate bar for backers/.test(e.message));
  pilot.setMandate(C, {min_backer_coverage_pct: 20});
  const a = await accept(w, g);
  assert.equal(a.state, 'active');
  const cov = a.acceptance.mandate_check.checks.find(x => x.rule === 'min_backer_coverage_pct');
  assert.deepEqual([cov.coverage_pct, cov.limit], [20, 20]);
  // The payer bar still applies to payers.
  const chk = await pilot.checkMandate(C, 'payee', F.id, 3).catch(e => e);
  assert.ok(chk instanceof Error ? chk.extra.rule === 'min_payer_coverage_pct' : chk.checks.some(x => x.rule === 'min_payer_coverage_pct'));
  assert.throws(() => pilot.setMandate(C, {min_backer_coverage_pct: 101}), e => e.code === 'invalid_field');
  void book;
});

test('#25: a note issued to honor a guarantee call counts in the backer\'s credit_history.notes_issued (via_guarantee)', async () => {
  const w = await world(), {pilot, A, B, C, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const g = await accept(w, await offer(w, {cap: 4}));
  await issue(w, A, C, 4);
  const id = 'vgc_' + hex(8);
  await call(w, g, 4, {id});
  clock.t += 5000;
  await honor(w, g, id);
  const h = (await pilot.publicPosition(B)).credit_history.notes_issued;
  assert.deepEqual(h, {count: 1, PC: 4, via_guarantee: {count: 1, PC: 4}});
  assert.deepEqual((await pilot.publicPosition(A)).credit_history.notes_issued, {count: 0, PC: 0}, 'an agent that honored nothing: as before');
});

// ---------- fix inbox #29: a guarantee that names the deals it backs ----------
// A deal in which I pays R `price`, its credit note recorded at `ts` (as Pilot.completeLocked leaves it), on the stub
// tracker and in the journal with the deal's id.
async function dealNote(w, I, R, price, {ts = w.clock.t - 20e3} = {}) {
  const id = 'vd_' + hex(8), prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0, total = prev + price;
  const sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts));
  appendEntries(w.pilot, [{kind: 'issue', ref: id, issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: price, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, redeemed: 0, timestamp: ts, signature: sig});
  const t = {deal_id: id, version: 1, payer: {id: I.id, pubkey: I.pubkey}, payee: {id: R.id, pubkey: R.pubkey}, service: {title: 'job', description: 'x', deliverable: 'x'},
    price: {amount: price, unit: 'PC'}, offer_expires_at: iso(w.clock.t + HOUR), deliver_by: iso(w.clock.t + 2 * HOUR)};
  w.pilot.s.deals[id] = {id, payer: I.id, payee: R.id, status: 'note_issued', created_at: iso(w.clock.t), history: [], agreement: {version: 1, terms: t, terms_hash: hex(32)},
    versions: [{v: 1, by: I.id, terms: t, terms_hash: hex(32), offered_at: iso(w.clock.t), state: 'accepted'}],
    credit_note: {state: 'recorded', issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount: price, note: {total, timestamp: ts, signature: sig}}};
  return id;
}
const dealTermsOf = (w, opts) => ({...terms(w, opts), covers: 'issuer_payment_for_deals', deals: opts.deals});

test('#29: a guarantee naming a deal covers only what is unpaid of it: a made-up deal after it never raises the call (Basis\'s repro)', async () => {
  const w = await world(), {A, B, C, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const real = await dealNote(w, A, C, 2);                              // alice owes charlie 2 for a real job
  const g = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 10, deals: [real]})}));
  assert.deepEqual([g.deals, g.deals_unpaid, g.callable_now], [[real], 2, 2]);
  await dealNote(w, A, C, 9, {ts: clock.t - 10e3});                     // a 9 "consulting" deal between the colluders
  const v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.issuer_owes_creditor, v.deals_unpaid, v.callable_now], [11, 2, 2], 'alice owes 11, but only the named deal is backed');
  await assert.rejects(call(w, g, 10), e => e.code === 'exceeds_callable' && e.extra.deals_unpaid === 2 && /unpaid of the deals it backs is 2 PC/.test(e.message));
  const id = 'vgc_' + hex(8);
  await call(w, g, 2, {id});
  clock.t += 5000;
  await honor(w, g, id);
  assert.equal(edgeTotal(w, B, C), 2, 'bob paid the 2 he backed, not the 9');
});

test('#29: once the named deal is repaid (oldest debt first), new debt does not revive it', async () => {
  const w = await world(), {A, B, C, book, clock} = w;
  C.mandate.accept_notes_from = [B.id];
  const real = await dealNote(w, A, C, 4);
  const g = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 4, deals: [real]})}));
  await repay(w, A, C, 0, {ts: clock.t - 15e3});                       // alice repays it in full
  await dealNote(w, A, C, 4, {ts: clock.t - 10e3});                     // then a new deal of 4, not named
  const v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.issuer_owes_creditor, v.deals_unpaid, v.callable_now], [4, 0, 0]);
  await rejects(call(w, g, 1), 'exceeds_callable');
});

test('#29: the named deals are checked at the offer, and coverage counts a deal-bound guarantee only for its own deals', async () => {
  const w = await world(), {pilot, A, B, C, E} = w;
  C.mandate.accept_notes_from = [B.id];
  const real = await dealNote(w, A, C, 3), other = await dealNote(w, E, C, 3);
  await assert.rejects(offer(w, {terms: dealTermsOf(w, {cap: 3, deals: [other]})}), e => e.code === 'invalid_terms' && /in which the issuer pays the creditor/.test(e.message));
  await assert.rejects(offer(w, {terms: dealTermsOf(w, {cap: 3, deals: []})}), e => e.code === 'invalid_terms' && /1 to 10 different deal ids/.test(e.message));
  await assert.rejects(offer(w, {terms: {...terms(w, {cap: 3}), deals: [real]}}), e => e.code === 'invalid_terms' && /deals is only for covers/.test(e.message));
  const g = await accept(w, await offer(w, {terms: dealTermsOf(w, {cap: 5, deals: [real]})}));
  const forReal = (await pilot.checkMandate(C, 'payee', A.id, 2, {dealId: real}).catch(e => e)), forOther = await pilot.checkMandate(C, 'payee', A.id, 2, {dealId: 'vd_' + '0'.repeat(16)}).catch(e => e);
  const backing = x => x.checks?.find(c => c.rule === 'min_payer_coverage_pct')?.guarantees ?? [];
  assert.deepEqual(backing(forReal), [g.guarantee_id], 'counted for the deal it names');
  assert.ok(forOther instanceof Error || backing(forOther).length === 0, 'not for another deal');
});

test('#29: the floating guarantee shows the debt at acceptance and flags a call above it', async () => {
  const w = await world(), {A, B, C, book} = w;
  C.mandate.accept_notes_from = [B.id];
  await issue(w, A, C, 1);
  const g = await accept(w, await offer(w, {cap: 10}));
  assert.equal(g.owed_at_acceptance, 1);
  await issue(w, A, C, 10, {ts: w.clock.t - 5000});                     // the debt grows after acceptance
  const id = 'vgc_' + hex(8);
  await call(w, g, 10, {id});
  const v = await book.viewFor(B, g.guarantee_id);
  assert.equal(v.calls[0].above_debt_at_acceptance, true);
  assert.match(v.covers, /the cap, not today's debt, is the backer's exposure/);
});
