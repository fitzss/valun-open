// Guarantees (fix inbox #18, lib/pilot/guarantees.mjs) over a STUB tracker that checks notes as tracker v3.2 does (as
// test/prior-ack.test.mjs: ordinary notes and bound notes with their prior acknowledgment PA), with real keys and the
// real valun_signer (VALUN_BINS). The north-star case: a creditor whose owner requires coverage refuses an issuer's IOU,
// then accepts it because a backer's guarantee covers it; the issuer either repays (the creditor releases the guarantee,
// nothing is called) or does not (after due_at the creditor calls what is still owed, up to the cap, and the backer
// honors the call with its own credit note to the creditor). Also: a call never claims more than is owed (no claim after
// repayment), a call lapses when the issuer repays before it is honored, the backer's open caps count against its
// limits, an offer above approve_above waits for the backer's owner, a note left issuing is recovered, and the record
// shows guarantees given, backed and held. The HTTP routes, /info and the inbox at the end.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, guaranteeStatements, termsHash, sha256} from '../lib/pilot/core.mjs';
import {appendEntries, edgeKey} from '../lib/pilot/journal.mjs';
import {GUARANTEE_PROTOCOL, COVERS} from '../lib/pilot/guarantees.mjs';
import {featuresFor} from '../lib/pilot/caps.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {runner, signerPath} from './tracker-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
// PA(I,R,X,p,T) as design v3.2 section 2 defines it (test/prior-ack.test.mjs), from the debt key the signer reports.
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

// The stub tracker v3.2 (POST /notes only): edges '<issuer>><recipient>' -> {total, redeemed, timestamp, signature}.
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

// A Pilot in mode on over the stub tracker: alice (the issuer), bob (the backer) and charlie (the creditor), clients
// with real keys; charlie's owner requires that a payer's claims (or guarantees) cover all it would owe.
async function world({backerApproveAbove = 1000} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-guarantees-')); dirs.push(dir);
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
  // Charlie's coverage rule applies to bob too, as the issuer of the note charlie may come to hold: bob holds claims
  // (eve owes him 30), as a backer someone trusts would.
  const E = await person('eve');
  const w = {pilot, tracker, clock, dir, A, B, C, E, book: pilot.guarantees};
  await issue(w, E, B, 30, {ts: clock.t - 120e3});
  return w;
}
const sign = (X, m) => real.signHex(X.pubkey, m, X.secret);
const signText = (X, s) => sign(X, Buffer.from(s, 'utf8').toString('hex'));
// I's note to R raised to `total` (ordinary, signed by I), at the stub tracker and in Valun's journal (as a deal's).
async function issue(w, I, R, total, {ts = w.clock.t - 60e3} = {}) {
  const sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts)), prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, redeemed: 0, timestamp: ts, signature: sig});
}
// I repays R down to `total` (a set-off lowered the edge), journaled as one.
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
  const t = terms(w, opts), h = termsHash(t), backer = opts.backer ?? w.B;
  return w.book.offer(backer, {terms: t, terms_hash: h, signature: await signText(backer, guaranteeStatements.offer(h))});
}
const accept = async (w, g, C = w.C) => w.book.accept(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.accept(g.terms_hash))});
async function call(w, g, amount, {C = w.C, id = 'vgc_' + hex(8)} = {}) {
  return w.book.call(C, g.guarantee_id, {call_id: id, amount, terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.call(g.terms_hash, id, amount))});
}
// The backer honors a call the way its client does: a bound note from the template (prior acknowledgment PA of the
// pair's note), the honor statement.
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

test('backed or refused: a creditor whose owner requires coverage refuses a newcomer\'s IOU, then takes it because a guarantee covers it (min_payer_coverage_pct counts the open cap)', async () => {
  const w = await world(), {pilot, A, B, C} = w;
  await rejects(pilot.checkMandate(C, 'payee', A.id, 3), 'mandate_exceeded');
  await assert.rejects(pilot.checkMandate(C, 'payee', A.id, 3), e => e.extra.rule === 'min_payer_coverage_pct' && /a guarantee of its debts to this agent counts too/.test(e.message));
  const g = await offer(w, {cap: 5});
  assert.equal(g.state, 'offered');
  assert.deepEqual([g.your_role, g.cap, g.claimed, g.remaining_cap, g.issuer_owes_creditor, g.callable_now], ['backer', 5, 0, 5, 0, 0]);
  await rejects(pilot.checkMandate(C, 'payee', A.id, 3), 'mandate_exceeded');      // an offer is not a guarantee yet
  const a = await accept(w, g);
  assert.equal(a.state, 'active');
  assert.deepEqual(a.next_actions, ['release'], 'nothing to call: alice owes charlie nothing yet');
  const chk = await pilot.checkMandate(C, 'payee', A.id, 3);
  const cov = chk.checks.find(x => x.rule === 'min_payer_coverage_pct');
  assert.deepEqual([cov.backing_for_you, cov.guarantees, cov.coverage_pct], [5, [g.guarantee_id], 166]);
  // Beyond the cap it is refused again.
  await rejects(pilot.checkMandate(C, 'payee', A.id, 6), 'mandate_exceeded');
  // The guarantee covers alice's debts to charlie only: to anyone else it is no coverage.
  const D = await (async () => { const k = await real.keygen(); const p = {...C, id: 'vp_' + hex(6), handle: 'dora', pubkey: k.pubkey_hex, secret: k.secret_hex, agent_token_hash: hex(32), owner_token_hash: hex(32)}; pilot.s.participants[p.id] = p; return p; })();
  await rejects(pilot.checkMandate(D, 'payee', A.id, 3), 'mandate_exceeded');
});

test('repaid: nothing can be called, the creditor releases the guarantee, and the backer\'s limits are free again', async () => {
  const w = await world(), {pilot, A, B, C, book} = w;
  const g = await accept(w, await offer(w, {cap: 5}));
  assert.equal(pilot.exposure(B, await pilot.ledger(), {asRole: 'payer'}).guaranteed, 5, 'the open cap counts against the backer');
  assert.equal(pilot.claimsHeld(C, await pilot.ledger()).guaranteed, 5, '... and as a claim the creditor may come to hold');
  await issue(w, A, C, 3);
  let v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.issuer_owes_creditor, v.callable_now, v.next_actions], [3, 3, ['call', 'release']]);
  await repay(w, A, C, 0);
  v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.issuer_owes_creditor, v.callable_now], [0, 0]);
  await rejects(call(w, g, 1), 'exceeds_callable');                                 // no claim after repayment
  const r = await w.book.release(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.release(g.terms_hash))});
  assert.equal(r.state, 'released');
  assert.equal(pilot.exposure(B, await pilot.ledger(), {asRole: 'payer'}).guaranteed, undefined, 'released: nothing left for the backer');
  const ev = (await pilot.publicPosition(B)).evidence.backing;
  assert.deepEqual([ev.given.accepted, ev.given.called.count, ev.given.ended_uncalled], [1, 0, 1]);
  assert.match(ev.reads_as, /not that it repays/);
});

test('default: after due_at the creditor calls what is still owed (at most the cap), the backer honors it with its own bound note; the issuer\'s IOU stays, and what the creditor recovers later belongs to the backer', async () => {
  const w = await world(), {pilot, tracker, A, B, C, book, clock} = w;
  const g = await accept(w, await offer(w, {cap: 5, dueIn: HOUR}));
  await issue(w, A, C, 7);
  await rejects(call(w, g, 5), 'not_due');
  clock.t += HOUR;
  assert.equal((await book.viewFor(C, g.guarantee_id)).callable_now, 5, 'the cap, though alice owes 7');
  await rejects(call(w, g, 6), 'exceeds_callable');
  const id = 'vgc_' + hex(8), c = await call(w, g, 5, {id});
  assert.deepEqual([c.calls.length, c.calls[0].state, c.calls[0].amount, c.callable_now, c.claimed], [1, 'open', 5, 0, 5]);
  assert.equal((await book.viewFor(B, g.guarantee_id)).next_actions.includes('honor'), true);
  assert.deepEqual(pilot.inbox(B).guarantees.to_honor.map(x => [x.call_id, x.amount, x.overdue]), [[id, 5, false]]);
  // A second call while one is open is refused.
  await rejects(call(w, g, 1), 'call_open');
  clock.t += 5000;
  const h = await honor(w, g, id);
  assert.deepEqual([h.calls[0].state, h.honored, h.calls[0].late], ['honored', 5, false]);
  const BC = tracker.edges.get(`${B.pubkey}>${C.pubkey}`);
  assert.equal(BC.total, 5, 'bob\'s IOU to charlie: 5');
  assert.equal(BC.timestamp % 1000, 997, 'a bound note');
  assert.equal(tracker.edges.get(`${A.pubkey}>${C.pubkey}`).total, 7, 'alice still owes charlie 7: Basis changes no note without its issuer');
  const k = edgeKey(B.pubkey, C.pubkey);
  assert.deepEqual([pilot.s.edges[k].issued_PC, pilot.s.edges[k].expected_total], [5, 5], 'journaled as an issue');
  assert.equal(pilot.s.edge_log_tail.at(-1).ref, id, 'the journal entry names the call');
  assert.ok((await pilot.reconcile()).every(r => r.status === 'match'), 'the tracker and the journal agree');
  assert.equal(h.recovered_for_backer, 0, 'alice owes 7 > the 5 bob paid');
  await rejects(honor(w, g, id), 'already_honored');
  // The issuer repays 4 of 7: charlie keeps the 2 bob did not cover, and 2 of it belongs to bob.
  await repay(w, A, C, 3, {ts: clock.t - 2000});
  assert.equal((await book.viewFor(C, g.guarantee_id)).recovered_for_backer, 2);
  // The record: bob gave one, called once and honored on time; alice was backed; charlie holds one, called.
  const eb = (await pilot.publicPosition(B)).evidence.backing, ea = (await pilot.publicPosition(A)).evidence.backing, ec = (await pilot.publicPosition(C)).evidence.backing;
  assert.deepEqual([eb.given.called, eb.given.honored, eb.given.honored_late, eb.given.overdue.count], [{count: 1, PC: 5}, {count: 1, PC: 5}, 0, 0]);
  assert.deepEqual([ea.backed_as_issuer.accepted, ea.backed_as_issuer.backers, ea.backed_as_issuer.called_against], [1, 1, {count: 1, PC: 5}]);
  assert.deepEqual(ec.held_as_creditor, {accepted: 1, called: {count: 1, PC: 5}});
  assert.deepEqual((await pilot.publicEvidence()).backing, {accepted: 1, active: 1, called: {count: 1, PC: 5}, honored: {count: 1, PC: 5}, overdue: 0});
  // Bob's note counts as his own debt: the cap is spent, so the guarantee holds nothing more against his limits.
  const e = pilot.exposure(B, await pilot.ledger(), {asRole: 'payer'});
  assert.deepEqual([e.tracker, e.guaranteed], [5, undefined]);
});

test('a call lapses when the issuer repays before it is honored; the creditor calls again for what is left; overdue calls show in the record', async () => {
  const w = await world(), {pilot, A, B, C, book, clock} = w;
  const g = await accept(w, await offer(w, {cap: 10, honorHours: 1}));
  await issue(w, A, C, 7);
  const id1 = 'vgc_' + hex(8);
  await call(w, g, 7, {id: id1});
  await repay(w, A, C, 4);
  clock.t += 5000;
  await rejects(w.book.noteTemplate(B, g.guarantee_id, id1, {bound: true, wait: false}), 'call_lapsed');
  assert.equal(pilot.s.guarantees[g.guarantee_id].calls[0].state, 'open', 'a template read changes nothing');
  // The honor itself: the backer's signed honor is checked, then the call lapses (nothing is paid).
  await rejects(book.honor(B, g.guarantee_id, id1, {terms_hash: g.terms_hash, amount: 7, credit_note: {},
    signature: await signText(B, guaranteeStatements.honor(g.terms_hash, id1, 7))}), 'call_lapsed');
  let v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.calls[0].state, v.claimed, v.callable_now], ['lapsed', 0, 4]);
  const id2 = 'vgc_' + hex(8);
  await call(w, g, 4, {id: id2});
  clock.t += 2 * HOUR;                                         // past honor_by (1 hour) and past expires_at (2 hours)
  v = await book.viewFor(C, g.guarantee_id);
  assert.deepEqual([v.state, v.calls[1].overdue, v.calls[1].honorable_now], ['expired', true, true]);
  assert.deepEqual((await pilot.publicPosition(B)).evidence.backing.given.overdue, {count: 1, PC: 4});
  await rejects(call(w, g, 1), 'not_active');
  // Honored late (the call survives the expiry): the record says late.
  const h = await honor(w, g, id2);
  assert.deepEqual([h.calls[1].state, h.calls[1].late], ['honored', true]);
  assert.equal((await pilot.publicPosition(B)).evidence.backing.given.honored_late, 1);
});

test('the backer\'s limits: its open caps count against max_issue_outstanding, for deals and further guarantees; the creditor\'s policy on the backer applies at acceptance', async () => {
  const w = await world(), {pilot, A, B, C} = w;
  B.mandate.max_issue_outstanding = 10;
  await offer(w, {cap: 8});
  await assert.rejects(pilot.checkMandate(B, 'payer', A.id, 3), e => e.code === 'mandate_exceeded' && e.extra.rule === 'max_issue_outstanding');
  await assert.rejects(offer(w, {cap: 5}), e => e.code === 'mandate_exceeded' && e.extra.rule === 'max_issue_outstanding');
  const chk = await pilot.checkMandate(B, 'payer', A.id, 2);
  assert.equal(chk.checks.find(x => x.rule === 'max_issue_outstanding').guaranteed, 8);
  // The cap is a commitment like a deal's price: within max_issue_per_deal.
  B.mandate.max_issue_outstanding = 100;
  await assert.rejects(offer(w, {cap: 26}), e => e.code === 'mandate_exceeded' && e.extra.rule === 'max_issue_per_deal');
  // The backer's counterparty list must allow the issuer too.
  B.mandate.counterparties = [C.id];
  await assert.rejects(offer(w, {cap: 2}), e => e.code === 'mandate_exceeded' && e.extra.rule === 'counterparties');
  B.mandate.counterparties = 'any';
  // The creditor refuses a backer it refuses notes from.
  const g = await offer(w, {cap: 2});
  C.mandate.refuse_notes_from = [B.id];
  await assert.rejects(accept(w, g), e => e.code === 'mandate_exceeded' && e.extra.rule === 'refuse_notes_from');
  C.mandate.refuse_notes_from = [];
  assert.equal((await accept(w, g)).state, 'active');
});

test('an offer above approve_above waits for the backer\'s owner (approval kind guarantee_offer); the creditor sees it only once approved', async () => {
  const w = await world({backerApproveAbove: 2}), {pilot, B, C, book} = w;
  const g = await offer(w, {cap: 5});
  assert.equal(g.state, 'awaiting_owner');
  await rejects(book.viewFor(C, g.guarantee_id), 'not_found');
  const box = pilot.inbox(B).awaiting_your_owner;
  assert.deepEqual(box.map(x => [x.kind, x.guarantee_id, x.deal_id, x.price.amount]), [['guarantee_offer', g.guarantee_id, null, 5]]);
  assert.match(box[0].title, /guarantee of alice's debt to charlie/);
  const a = Object.values(pilot.s.approvals).find(x => x.guarantee_id === g.guarantee_id);
  const served = await pilot.servedApprovalView(a, B);
  assert.deepEqual([served.deal, served.guarantee.guarantee_id, served.subject.terms.cap.amount], [null, g.guarantee_id, 5]);
  assert.match(served.effect, /counts against your agent's max_issue_outstanding/);
  const r = await pilot.decideApproval(B, a.id, {decision: 'approve', note: 'fine'});
  assert.deepEqual([r.approval.state, r.guarantee.state], ['approved', 'offered']);
  assert.equal((await book.viewFor(C, g.guarantee_id)).state, 'offered');
  assert.equal((await accept(w, g)).state, 'active');
  // A rejection offers nothing.
  const g2 = await offer(w, {cap: 3});
  const a2 = Object.values(pilot.s.approvals).find(x => x.guarantee_id === g2.guarantee_id);
  assert.equal((await pilot.decideApproval(B, a2.id, {decision: 'reject'})).guarantee.state, 'rejected_by_owner');
  await rejects(book.viewFor(C, g2.guarantee_id), 'not_found');
});

test('signatures and states: a wrong key, stale terms, the wrong party, a withdrawn or declined offer, an expired offer', async () => {
  const w = await world(), {A, B, C, book, clock} = w;
  const g = await offer(w);
  await rejects(book.accept(C, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(A, guaranteeStatements.accept(g.terms_hash))}), 'bad_signature');
  await rejects(book.accept(C, g.guarantee_id, {terms_hash: 'ab'.repeat(32), signature: await signText(C, guaranteeStatements.accept(g.terms_hash))}), 'stale_terms');
  await rejects(book.accept(B, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(B, guaranteeStatements.accept(g.terms_hash))}), 'not_creditor');
  const wd = await book.withdraw(B, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(B, guaranteeStatements.withdraw(g.terms_hash))});
  assert.equal(wd.state, 'withdrawn');
  await rejects(accept(w, g), 'not_open');
  const g2 = await offer(w);
  const dec = await book.decline(C, g2.guarantee_id, {terms_hash: g2.terms_hash, reason: 'no thanks', signature: await signText(C, guaranteeStatements.decline(g2.terms_hash, 'no thanks'))});
  assert.deepEqual([dec.state, dec.decline.reason], ['declined', 'no thanks']);
  const g3 = await offer(w, {offerFor: 60e3});
  clock.t += 61e3;
  assert.equal((await book.viewFor(B, g3.guarantee_id)).state, 'offer_expired');
  // Terms the server refuses.
  const bad = async (patch, re) => {
    const t = {...terms(w), ...patch}, h = termsHash(t);
    // invalid_field for text a deal's terms would refuse too (the same signedText check), invalid_terms otherwise.
    await assert.rejects(book.offer(B, {terms: t, terms_hash: h, signature: await signText(B, guaranteeStatements.offer(h))}), e => ['invalid_terms', 'invalid_field'].includes(e.code) && re.test(e.message));
  };
  await bad({covers: 'anything'}, /covers must be/);
  await bad({issuer: {id: B.id, pubkey: B.pubkey}}, /three different participants/);
  await bad({honor_within_hours: 0}, /honor_within_hours/);
  await bad({expires_at: iso(clock.t + 60e3)}, /expires_at must be at least 1 hour/);
  await bad({note: `hidden${String.fromCharCode(0x200b)}text`}, /zero-width/);
  await bad({extra: 1}, /unknown terms field extra/);
});

test('a backer\'s note left issuing holds its pair (pair_busy for a deal note, no set-off) and is recovered by read-back; a tracker refusal leaves the call to be honored again', async () => {
  const w = await world(), {pilot, tracker, A, B, C, book, clock} = w;
  const g = await accept(w, await offer(w, {cap: 5}));
  await issue(w, A, C, 5);
  const id = 'vgc_' + hex(8);
  await call(w, g, 5, {id});
  clock.t += 5000;
  tracker.refuseNext = [503, {success: false, code: 'busy'}];
  const f = await honor(w, g, id);
  assert.deepEqual([f.calls[0].state, f.calls[0].error], ['failed', 'the tracker did not record the note (HTTP 503, busy)']);
  // The crash case: the note reached the tracker, the server stopped before the read-back (state issuing).
  const gg = pilot.s.guarantees[g.guarantee_id], c = gg.calls[0];
  const tpl = await book.noteTemplate(B, g.guarantee_id, id, {bound: false, wait: false});
  const sig = await sign(B, tpl.message_hex);
  Object.assign(c, {state: 'issuing', keys: {issuer: B.pubkey, recipient: C.pubkey}, prior_total: 0, note: {total: tpl.total, timestamp: tpl.timestamp, signature: sig, message_hex: tpl.message_hex}});
  const k = edgeKey(B.pubkey, C.pubkey);
  assert.equal(pilot.pairHoldsNote(k, {issuing: true}), true, 'no set-off on the pair meanwhile');
  assert.throws(() => pilot.assertPairFree({id: 'vd_' + '0'.repeat(16)}, B.pubkey, C.pubkey), e => e.code === 'pair_busy');
  const [status] = await tracker.postNote({issuer_pubkey: B.pubkey, recipient_pubkey: C.pubkey, amount: tpl.total, timestamp: tpl.timestamp, signature: sig});
  assert.equal(status, 200);
  assert.deepEqual(await pilot.recover(), [`${id}:honored`]);
  assert.equal(c.recovered, true);
  assert.equal(pilot.pairHoldsNote(k, {issuing: true}), false);
});

test('the deal counts split: notes_issued_as_payer and notes_received (the welcome job no longer reads as an issued note)', async () => {
  const w = await world(), {pilot, A, C} = w;
  const id = 'vd_' + hex(8), t = {deal_id: id, version: 1, payer: {id: A.id, pubkey: A.pubkey}, payee: {id: C.id, pubkey: C.pubkey}, service: {title: 'welcome', description: 'x', deliverable: 'x'},
    price: {amount: 1, unit: 'PC'}, offer_expires_at: iso(w.clock.t + HOUR), deliver_by: iso(w.clock.t + 2 * HOUR)};
  pilot.s.deals[id] = {id, payer: A.id, payee: C.id, status: 'note_issued', created_at: iso(w.clock.t), history: [], agreement: {version: 1, terms: t, terms_hash: hex(32)},
    versions: [{v: 1, by: A.id, terms: t, terms_hash: hex(32), offered_at: iso(w.clock.t), state: 'accepted'}]};
  const pc = (await pilot.publicPosition(C)).deals, pa = (await pilot.publicPosition(A)).deals;
  assert.deepEqual([pc.credit_notes_issued, pc.notes_issued_as_payer, pc.notes_received], [1, 0, 1]);
  assert.deepEqual([pa.credit_notes_issued, pa.notes_issued_as_payer, pa.notes_received], [1, 1, 0]);
});

test('HTTP: /info lists guarantees/1 and the statements; the routes take agent tokens; owners cannot sign; the inbox shows offers to answer', async () => {
  const w = await world(), {pilot, A, B, C} = w;
  assert.deepEqual(featuresFor('on'), ['bound_notes/1', 'circulation/1', 'guarantees/1']);
  assert.deepEqual(featuresFor('bound'), ['bound_notes/1']);
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000, publicCacheMs: 0}});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/pilot/v1`;
  const req = async (method, p, {token, body} = {}) => {
    const r = await fetch(base + p, {method, headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, body: await r.json()};
  };
  try {
    const info = (await req('GET', '/info')).body;
    assert.ok(info.features.includes('guarantees/1'));
    assert.deepEqual(Object.keys(info.guarantee_statements), ['offer', 'accept', 'decline', 'withdraw', 'release', 'call', 'honor']);
    assert.equal(info.guarantees.protocol, GUARANTEE_PROTOCOL);
    const t = terms(w), h = termsHash(t);
    const made = await req('POST', '/guarantees', {token: B.token, body: {terms: t, terms_hash: h, signature: await signText(B, guaranteeStatements.offer(h))}});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await req('GET', '/guarantees', {token: C.token})).body.length, 1);
    assert.deepEqual((await req('GET', '/inbox', {token: C.token})).body.guarantees.to_answer.map(x => x.guarantee_id), [t.guarantee_id]);
    assert.equal((await req('GET', `/guarantees/${t.guarantee_id}`, {token: A.token})).body.your_role, 'issuer', 'the issuer sees it');
    const owner = await req('POST', `/guarantees/${t.guarantee_id}/accept`, {token: `vpo_${C.token}`, body: {terms_hash: h}});
    assert.equal(owner.status, 404);
    const ok = await req('POST', `/guarantees/${t.guarantee_id}/accept`, {token: C.token, body: {terms_hash: h, signature: await signText(C, guaranteeStatements.accept(h))}});
    assert.deepEqual([ok.status, ok.body.state], [200, 'active']);
    const unknown = await req('GET', `/guarantees/vg_${'0'.repeat(16)}`, {token: C.token});
    assert.equal(unknown.status, 404);
  } finally { server.close(); }
});
