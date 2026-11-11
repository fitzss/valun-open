// Robustness tests for the pilot network (valun-pilot-1): the open questions strangers' agents will actually hit
// (valun-open spec/OPEN-QUESTIONS.md OQ-6, 7, 8, 12, 13, 20, 24, 25 and adversarial finding F4 / OQ-29).
// Real HTTP server, in process, against a throwaway REAL Basis tracker on its own port (3082) and its own temporary
// store. Participants sign with Basis's Rust signer standing in for their own clients. Summary of the changes:
// docs/ROBUSTNESS-2026-11-07.md.
// Run: node --test test/robustness.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, BasisError, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_MANDATE, termsHash, statements, residueTimestamp, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const TRACKER_PORT = 3082, ADMIN = 'robustness-admin-secret', ADM = {'x-valun-admin': ADMIN};
const H = 3600e3, DAY = 24 * H;
let tracker, server, base, basis, pilot, storeDir, clockOffset = 0;
// Bound notes (tracker v3.2 only, VALUN_BINS=<v3.2 bins>): a second Pilot in circulation mode bound, on the same
// tracker, with its own store, server and clock (frozenAt stops that clock for a template). `target` points the HTTP
// helpers at its server (onBound). It exists only when the tracker's capabilities validate and its binary is pinned
// (as transfer.test.mjs decides), so that any other tracker (an older v3 build, say) skips those tests with the reason.
let trackerCaps = null, boundPilot = null, boundServer = null, boundBase = null, boundDir = null, target = null, frozenAt = null;
let v3Skip = 'needs tracker v3.2 (VALUN_BINS=<v3.2 bins>): this tracker reports no capabilities';
const boundLog = [];
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const now = () => Date.now() + clockOffset;

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-robustness-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(storeDir), basis, now});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  trackerCaps = await capabilities(tracker.url);              // null on trackers before v3
  const v = validateCaps(trackerCaps), bin = trackerCaps ? await trackerSha256() : null;
  if (trackerCaps) v3Skip = !v.ok ? `needs tracker v3.2: capabilities do not validate (${v.reason})` : `needs tracker v3.2: basis_server ${bin} is not pinned`;
  if (v.ok && TRACKER_SHA256_PINS.includes(bin)) {
    boundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-robustness-bound-'));
    boundPilot = new Pilot({store: new PilotStore(boundDir), basis, now: () => frozenAt ?? now(), circulation: 'bound', trackerCaps,
      trackerSha256: bin, log: m => boundLog.push(m)});
    boundServer = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot: boundPilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)})}));
    await new Promise(r => boundServer.listen(0, '127.0.0.1', r));
    boundBase = `http://127.0.0.1:${boundServer.address().port}`;
  }
});
after(async () => {
  if (server) { server.closeAllConnections?.(); server.close(); }
  if (boundServer) { boundServer.closeAllConnections?.(); boundServer.close(); }
  await tracker?.stop();
  for (const d of [storeDir, boundDir]) if (d) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers (as in test/adversarial.test.mjs)
async function call(method, p, body, token, headers = {}) {
  const r = await fetch((target ?? base) + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers},
    body: body === undefined || body === null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, status, code, what = '') => {
  assert.equal(r.status, status, `${what}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
  assert.equal(r.body?.error, code, `${what}: expected ${code}, got ${JSON.stringify(r.body)?.slice(0, 300)}`);
  return r.body;
};
const rule = (r, x, what) => { refused(r, 403, 'mandate_exceeded', what); assert.equal(r.body.rule, x, what); };

const TEST_MANDATE = {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 5000, max_accept_per_deal: 100, max_accept_per_issuer: 5000};
const pop = (id, code, key) => basis.signHex(key.pubkey_hex, hex(statements.enroll(id, key.pubkey_hex, sha(code))), key.secret_hex);
async function newParticipant(handle, mandate = {}) {
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `robustness operator of ${handle}`}), 201);
  const key = await basis.keygen();
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: await pop(j.participant_id, j.enrollment_code, key)}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {...TEST_MANDATE, ...mandate}, P.owner));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
function terms(proposer, payer, payee, price, extra = {}) {
  const t = now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + rnd(8), version: 1, prior_terms_hash: null, nonce: rnd(16),
    proposer: proposer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Short research brief', description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(t + 48 * H).toISOString(), offer_expires_at: new Date(t + 24 * H).toISOString(), ...extra};
}
async function propose(P, t) { const h = termsHash(t); return call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent); }
const view = async (P, id) => ok(await call('GET', `/deals/${id}`, null, P.agent));
async function accept(P, id, h = null) { h ??= (await view(P, id)).current.terms_hash; return call('POST', `/deals/${id}/accept`, {terms_hash: h, signature: await sign(P, statements.accept(h))}, P.agent); }
const withdraw = async (P, id, h) => call('POST', `/deals/${id}/withdraw`, {terms_hash: h, signature: await sign(P, statements.withdraw(h))}, P.agent);
async function deliver(P, id, content) {
  const h = (await view(P, id)).agreement.terms_hash, dh = sha(content);
  return call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(P, statements.deliver(h, dh))}, P.agent);
}
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  const note = await basis.signHex(P.pubkey, message_hex, P.secret);
  return call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: note}}, P.agent);
}
const approvalsFor = async (P, dealId) => ok(await call('GET', '/owner', null, P.owner)).approvals.filter(a => a.deal_id === dealId && a.state === 'pending');
const decide = (P, a, decision) => call('POST', `/owner/approvals/${a.id}`, {decision}, P.owner);
const setMandate = async (P, m) => ok(await call('PUT', '/owner/mandate', m, P.owner));
// A deal taken to "delivered" between payer X and payee Y.
async function delivered(X, Y, price) {
  const d = ok(await propose(X, terms(X, X, Y, price)), 201);
  assert.equal(ok(await accept(Y, d.id)).status, 'agreed', 'precondition: agreed');
  ok(await deliver(Y, d.id, `work for ${price}`));
  return d.id;
}

// =================================================================================================================
// OQ-6: withdraw while the acceptor's acceptance waits for its owner
// =================================================================================================================
test('OQ-6: withdrawing an offer whose acceptance waits for the acceptor\'s owner voids the acceptance and its approval', async () => {
  const R = await newParticipant('rb-oq6-r'), S = await newParticipant('rb-oq6-s', {approve_above: 0});
  const d = ok(await propose(R, terms(R, R, S, 5)), 201), h = d.current.terms_hash;
  assert.equal(ok(await accept(S, d.id)).status, 'accepted_awaiting_owner');
  assert.deepEqual((await view(R, d.id)).next_actions, ['wait_for_owner_approval', 'withdraw'], 'the proposer is told it may still withdraw');
  assert.deepEqual((await view(S, d.id)).next_actions, ['wait_for_owner_approval']);
  const [ap] = await approvalsFor(S, d.id);
  const w = ok(await withdraw(R, d.id, h));
  assert.equal(w.status, 'withdrawn');
  assert.equal(w.acceptance.state, 'void_withdrawn', 'the acceptance is void, not left awaiting_owner');
  assert.equal(w.acceptance.signature, null, 'never final, so never handed to the proposer');
  assert.deepEqual(w.next_actions, []);
  const sv = await view(S, d.id);
  assert.equal(sv.status, 'withdrawn'); assert.equal(sv.acceptance.state, 'void_withdrawn'); assert.deepEqual(sv.next_actions, []);
  assert.ok(sv.history.some(e => e.event === 'withdrawn' && e.acceptance_voided === true), 'the withdrawal event says the acceptance is void');
  assert.equal(sv.approvals.find(a => a.id === ap.id).state, 'void_withdrawn');
  assert.ok(!ok(await call('GET', '/inbox', null, S.agent)).awaiting_your_owner.some(x => x.deal_id === d.id));
  refused(await decide(S, ap, 'approve'), 409, 'not_pending', 'the void acceptance cannot be approved');
  // a plain open offer withdrawn: no acceptance, nothing voided
  const d2 = ok(await propose(R, terms(R, R, S, 5)), 201);
  const w2 = ok(await withdraw(R, d2.id, d2.current.terms_hash));
  assert.ok(!w2.acceptance); assert.ok(!w2.history.some(e => e.acceptance_voided));
});

// =================================================================================================================
// OQ-7: expired offers nobody has read
// =================================================================================================================
test('OQ-7: offers and held acceptances past offer_expires_at that nobody has read no longer count against mandates or positions', async () => {
  const X = await newParticipant('rb-oq7-x', {max_issue_outstanding: 20}), Y = await newParticipant('rb-oq7-y', {max_accept_per_issuer: 20});
  const o1 = ok(await propose(X, terms(X, X, Y, 20)), 201);                  // reserves X's max_issue_outstanding
  rule(await propose(X, terms(X, X, Y, 1)), 'max_issue_outstanding', 'the open offer reserves the payer limit');
  const o2 = ok(await propose(Y, terms(Y, X, Y, 20)), 201);                  // reserves Y's max_accept_per_issuer (on X)
  rule(await propose(Y, terms(Y, X, Y, 1)), 'max_accept_per_issuer', 'the open offer reserves the payee limit');
  const P = await newParticipant('rb-oq7-p', {max_issue_outstanding: 20, approve_above: 0}), K = await newParticipant('rb-oq7-k');
  const o3 = ok(await propose(K, terms(K, P, K, 20)), 201);
  assert.equal(ok(await accept(P, o3.id)).status, 'accepted_awaiting_owner');
  rule(await propose(P, terms(P, P, K, 1)), 'max_issue_outstanding', 'an acceptance waiting for its owner is committed');
  const U = await newParticipant('rb-oq7-u'), V = await newParticipant('rb-oq7-v');
  const o4 = ok(await propose(U, terms(U, U, V, 5)), 201);
  clockOffset = 25 * H;
  try {
    for (const o of [o1, o2, o4]) assert.equal(pilot.s.deals[o.id].status, 'open', 'precondition: expired, but nobody has read it');
    assert.equal(pilot.s.deals[o3.id].status, 'accepted_awaiting_owner', 'precondition: expired, but nobody has read it');
    assert.equal(ok(await propose(X, terms(X, X, Y, 15)), 201).status, 'open', "X's expired offer no longer reserves its limit");
    assert.equal(pilot.s.deals[o1.id].status, 'expired', 'expired by the mandate check itself');
    assert.equal(ok(await propose(Y, terms(Y, X, Y, 15)), 201).status, 'open', "Y's expired offer no longer reserves its limit");
    assert.equal(pilot.s.deals[o2.id].status, 'expired');
    assert.equal(ok(await propose(P, terms(P, P, K, 15)), 201).status, 'proposed_awaiting_owner', "P's expired held acceptance no longer commits it");
    assert.equal(pilot.s.deals[o3.id].status, 'expired');
    const counts = ok(await call('GET', `/participants/${U.id}`)).public_position.deals;
    assert.equal(counts.open, 0, 'the public position does not count an expired offer as open');
    assert.equal(counts.expired_or_withdrawn, 1);
    assert.equal(pilot.s.deals[o4.id].status, 'expired');
  } finally { clockOffset = 0; }
});

// =================================================================================================================
// OQ-8: agreed deals that are never delivered
// =================================================================================================================
test('OQ-8: an agreed deal not delivered within 7 days after deliver_by ends as expired_undelivered and releases exposure; delivered deals are left alone', async () => {
  const X = await newParticipant('rb-oq8-x', {max_issue_outstanding: 20}), Y = await newParticipant('rb-oq8-y');
  const d = ok(await propose(X, terms(X, X, Y, 12)), 201);
  assert.equal(ok(await accept(Y, d.id)).status, 'agreed');
  const d2 = await delivered(X, Y, 8);
  rule(await propose(X, terms(X, X, Y, 1)), 'max_issue_outstanding', 'agreed and delivered deals are committed');
  const v0 = await view(X, d.id);
  assert.equal(v0.delivery_grace_ends_at, new Date(Date.parse(v0.current.terms.deliver_by) + 7 * DAY).toISOString(), 'the end of the grace period is shown');
  clockOffset = 48 * H + 6 * DAY;                     // late, but within the grace period: still agreed, overdue, still committed
  try {
    const v = await view(Y, d.id);
    assert.equal(v.status, 'agreed'); assert.equal(v.overdue, true); assert.deepEqual(v.next_actions, ['deliver']);
    rule(await propose(X, terms(X, X, Y, 1)), 'max_issue_outstanding', 'still committed during the grace period');
  } finally { clockOffset = 0; }
  clockOffset = 48 * H + 7 * DAY + H;
  try {
    assert.equal(pilot.s.deals[d.id].status, 'agreed', 'precondition: past the grace period, but nobody has read it');
    assert.equal(ok(await propose(X, terms(X, X, Y, 12)), 201).status, 'open', 'its exposure is released');
    assert.equal(pilot.s.deals[d.id].status, 'expired_undelivered');
    const v = await view(Y, d.id);
    assert.equal(v.status, 'expired_undelivered'); assert.deepEqual(v.next_actions, []); assert.equal(v.overdue, false);
    assert.ok(v.agreement, 'the agreement stays on record');
    const ev = v.history.find(e => e.event === 'expired_undelivered');
    assert.ok(ev && ev.by === 'valun' && ev.deliver_by === v.current.terms.deliver_by && ev.grace_days === 7, JSON.stringify(ev));
    assert.ok((await view(X, d.id)).history.some(e => e.event === 'expired_undelivered'), 'both parties see the event');
    refused(await deliver(Y, d.id, 'too late'), 409, 'wrong_state', 'delivery after the grace period');
    const ib = ok(await call('GET', '/inbox', null, Y.agent));
    assert.ok(!ib.deliver.some(x => x.deal_id === d.id));
    assert.ok(ib.recent_closed.some(x => x.deal_id === d.id && x.status === 'expired_undelivered'));
    const counts = ok(await call('GET', `/participants/${X.id}`)).public_position.deals;
    assert.equal(counts.agreed_note_not_issued, 1, 'only the delivered deal is still agreed');
    const v2 = await view(X, d2);
    assert.equal(v2.status, 'delivered', 'a delivery waiting for the payer does not expire');
    assert.deepEqual(v2.next_actions, ['complete', 'dispute']);
  } finally { clockOffset = 0; }
  assert.equal(ok(await complete(X, d2)).status, 'note_issued', 'the delivered deal can still be completed');
});

// =================================================================================================================
// F4 / OQ-29: lowering approve_above and offers already open
// =================================================================================================================
test('F4/OQ-29: an open offer accepted after its owner lowered approve_above waits for that owner; approve forms the deal, reject withdraws the offer', async () => {
  const W = await newParticipant('rb-f4-w'), Z = await newParticipant('rb-f4-z'), Z2 = await newParticipant('rb-f4-z2', {approve_above: 0});
  const openOffer = async (to, price) => {                       // an offer made under a high threshold, then the owner lowers it
    await setMandate(W, {approve_above: 1000});
    const d = ok(await propose(W, terms(W, W, to, price)), 201);
    assert.equal(d.status, 'open', 'precondition: offered without approval');
    await setMandate(W, {approve_above: 10});
    return d;
  };
  // 1. W's owner confirms: agreed
  const d1 = await openOffer(Z, 50);
  const r = ok(await accept(Z, d1.id));
  assert.equal(r.status, 'accepted_awaiting_owner', 'held, not agreed');
  assert.equal(r.acceptance.state, 'awaiting_owner'); assert.deepEqual(r.acceptance.held_for, ['proposer_owner']);
  assert.deepEqual(r.next_actions, ['wait_for_owner_approval']);
  assert.ok(r.history.some(e => e.event === 'held_for_proposer_owner'));
  assert.deepEqual(await approvalsFor(Z, d1.id), [], "nothing for Z's owner: Z's own threshold is not reached");
  const [a1] = await approvalsFor(W, d1.id);
  assert.equal(a1.kind, 'confirm_offer'); assert.equal(a1.subject.what, 'accepted_offer'); assert.equal(a1.subject.accepted_by, Z.id);
  assert.ok(await basis.verify(W.pubkey, hex(a1.subject.statement), a1.subject.signature), "the subject is W's own signed offer");
  assert.ok(!JSON.stringify(a1).includes(pilot.s.deals[d1.id].acceptance.signature), "Z's acceptance signature is not handed over before it is final");
  assert.match(a1.effect.if_approved, /agreed/); assert.match(a1.effect.if_rejected, /withdrawn/);
  const wv = await view(W, d1.id);
  assert.equal(wv.acceptance.signature, null); assert.deepEqual(wv.next_actions, ['wait_for_owner_approval', 'withdraw']);
  assert.ok(ok(await call('GET', '/inbox', null, Z.agent)).waiting_on_others.some(x => x.deal_id === d1.id), 'Z waits on the other side');
  assert.ok(ok(await call('GET', '/inbox', null, W.agent)).awaiting_your_owner.some(x => x.approval_id === a1.id));
  assert.equal(ok(await decide(W, a1, 'approve')).deal.status, 'agreed');
  const zv = await view(Z, d1.id);
  assert.equal(zv.status, 'agreed'); assert.equal(zv.agreement.version, 1); assert.match(zv.acceptance.signature, /^[0-9a-f]{130}$/);
  assert.equal(zv.acceptance.state, 'final');
  // 2. W's owner rejects: the offer ends as withdrawn and Z's acceptance is void
  const d2 = await openOffer(Z, 40);
  assert.equal(ok(await accept(Z, d2.id)).status, 'accepted_awaiting_owner');
  const [a2] = await approvalsFor(W, d2.id);
  assert.equal(ok(await decide(W, a2, 'reject')).deal.status, 'withdrawn');
  const zv2 = await view(Z, d2.id);
  assert.equal(zv2.status, 'withdrawn'); assert.equal(zv2.acceptance.state, 'void_withdrawn'); assert.deepEqual(zv2.next_actions, []);
  refused(await accept(Z, d2.id, zv2.current.terms_hash), 409, 'not_open', 'accepting again after the owner rejected');
  // 3. both owners must decide: agreed only after both approve (here the acceptor's owner first)
  const d3 = await openOffer(Z2, 30);
  assert.equal(ok(await accept(Z2, d3.id)).status, 'accepted_awaiting_owner');
  const [za3] = await approvalsFor(Z2, d3.id), [wa3] = await approvalsFor(W, d3.id);
  assert.equal(za3.kind, 'accept'); assert.equal(wa3.kind, 'confirm_offer');
  assert.deepEqual((await view(Z2, d3.id)).acceptance.held_for, ['acceptor_owner', 'proposer_owner']);
  assert.match(za3.effect.if_approved, /binding/);
  assert.equal(ok(await decide(Z2, za3, 'approve')).deal.status, 'accepted_awaiting_owner', "the acceptor's owner alone does not form it");
  assert.deepEqual((await view(Z2, d3.id)).acceptance.held_for, ['proposer_owner']);
  assert.equal(ok(await decide(W, wa3, 'approve')).deal.status, 'agreed');
  // 4. the acceptor's owner rejects: the offer is open again and W's pending confirmation is void
  const d4 = await openOffer(Z2, 30);
  ok(await accept(Z2, d4.id));
  const [za4] = await approvalsFor(Z2, d4.id), [wa4] = await approvalsFor(W, d4.id);
  assert.equal(ok(await decide(Z2, za4, 'reject')).deal.status, 'open');
  assert.equal((await view(W, d4.id)).approvals.find(a => a.id === wa4.id).state, 'void_acceptance_rejected');
  refused(await decide(W, wa4, 'approve'), 409, 'not_pending', 'a confirmation for a rejected acceptance');
  // 5. lowered while the acceptance already waits for the acceptor's owner: W's owner is asked when that owner approves
  await setMandate(W, {approve_above: 1000});
  const d5 = ok(await propose(W, terms(W, W, Z2, 30)), 201);
  ok(await accept(Z2, d5.id));
  assert.deepEqual((await view(Z2, d5.id)).acceptance.held_for, ['acceptor_owner']);
  await setMandate(W, {approve_above: 10});
  const [za5] = await approvalsFor(Z2, d5.id);
  assert.equal(ok(await decide(Z2, za5, 'approve')).deal.status, 'accepted_awaiting_owner', "not agreed: W's owner must confirm first");
  const [wa5] = await approvalsFor(W, d5.id);
  assert.equal(wa5.kind, 'confirm_offer');
  assert.equal(ok(await decide(W, wa5, 'approve')).deal.status, 'agreed');
  // 6. an offer W's owner approved when it was made is not held again
  const d6 = ok(await propose(W, terms(W, W, Z, 20)), 201);
  assert.equal(d6.status, 'proposed_awaiting_owner');
  const [a6] = await approvalsFor(W, d6.id);
  assert.equal(ok(await decide(W, a6, 'approve')).deal.status, 'open');
  assert.equal(ok(await accept(Z, d6.id)).status, 'agreed', 'approved by its owner already: agreed at once');
  // 7. an offer within the lowered threshold is not held
  const d7 = await openOffer(Z, 10);
  assert.equal(ok(await accept(Z, d7.id)).status, 'agreed');
});

// =================================================================================================================
// OQ-12: template timestamp and the pair's last note
// =================================================================================================================
test('OQ-12: the credit-note template timestamp never exceeds the server clock, even when the pair\'s last note is ahead of it', async () => {
  const X = await newParticipant('rb-oq12-x'), Y = await newParticipant('rb-oq12-y');
  const id1 = await delivered(X, Y, 2), id2 = await delivered(X, Y, 3);
  // A note for the same key pair submitted around Valun, timestamped just before the tracker's clock.
  const direct = async total => {
    const r = await basis.issueNote({issuer: X.pubkey, recipient: Y.pubkey, total, secretHex: X.secret, timestamp: Date.now() - 1500});
    assert.ok(r.response.success, JSON.stringify(r.response));
    return r.request.timestamp;
  };
  const last = await direct(1);
  clockOffset = -3000;                                  // this server's clock runs 3 s behind: the last note is ~1.5 s ahead of it
  try {
    assert.ok(last >= now(), 'precondition: the last note is ahead of the server clock');
    const tpl = ok(await call('GET', `/deals/${id1}/credit-note-template`, null, X.agent));
    assert.ok(tpl.timestamp > last, 'after the pair\'s last note'); assert.ok(tpl.timestamp <= now(), 'not in the server\'s future');
    assert.equal(tpl.total, 3);
    assert.equal(ok(await complete(X, id1)).status, 'note_issued', 'completion is not blocked');
  } finally { clockOffset = 0; }
  const last2 = await direct(4);
  clockOffset = -60000;                                 // far ahead: a clear refusal with a retry time, never a future timestamp
  try {
    const r = refused(await call('GET', `/deals/${id2}/credit-note-template`, null, X.agent), 409, 'note_timestamp_ahead', 'last note a minute ahead');
    assert.equal(r.last_note_timestamp, last2);
    assert.ok(r.retry_after_ms > 50000 && r.retry_after_ms <= 61000, String(r.retry_after_ms));
  } finally { clockOffset = 0; }
  const tpl2 = ok(await call('GET', `/deals/${id2}/credit-note-template`, null, X.agent));
  assert.ok(tpl2.timestamp > last2 && tpl2.timestamp <= now());
  assert.equal(ok(await complete(X, id2)).status, 'note_issued');
  assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 7);
});

// =================================================================================================================
// OQ-13: mandate_version
// =================================================================================================================
test('OQ-13: mandate_version changes only when the mandate really changes', async () => {
  const Q1 = await newParticipant('rb-oq13-q1'), Q2 = await newParticipant('rb-oq13-q2');
  const P = await newParticipant('rb-oq13', {counterparties: [Q1.id, Q2.id], objective: 'Buy briefs.'});
  const o0 = ok(await call('GET', '/owner', null, P.owner)), v0 = o0.mandate_version, m0 = o0.mandate;
  const same = async (body, what) => {
    const r = await setMandate(P, body);
    assert.equal(r.mandate_version, v0, what); assert.equal(r.changed, false, what); assert.deepEqual(r.mandate, m0, what);
  };
  await same({}, 'empty PUT');
  await same({approve_above: m0.approve_above, objective: m0.objective, may_issue_credit: m0.may_issue_credit}, 'same values');
  await same({counterparties: [Q2.id, Q1.id]}, 'the same counterparties in another order');
  await same({expires_at: m0.expires_at.replace('Z', '+00:00')}, 'the same expiry instant, written differently');
  const o1 = ok(await call('GET', '/owner', null, P.owner));
  assert.equal(o1.mandate_version, v0); assert.equal(o1.mandate_changed_at, o0.mandate_changed_at, 'not marked as changed');
  assert.equal(ok(await call('PUT', `/admin/participants/${P.id}/mandate`, {approve_above: m0.approve_above}, null, ADM)).changed, false);
  assert.equal(ok(await call('GET', '/owner', null, P.owner)).mandate_changed_by, 'owner', "an operator no-op does not mark it as the operator's");
  const r = await setMandate(P, {approve_above: m0.approve_above + 1});
  assert.equal(r.mandate_version, v0 + 1); assert.equal(r.changed, true);
  assert.equal(ok(await call('GET', '/me', null, P.agent)).mandate_version, v0 + 1);
});

// =================================================================================================================
// OQ-20: who recorded a limit
// =================================================================================================================
test('OQ-20: limits an owner records through PUT /limits are labelled as recorded by the owner, not from the owner\'s instructions', async () => {
  const L = await newParticipant('rb-oq20-l'), M = await newParticipant('rb-oq20-m');
  const r = ok(await call('PUT', '/limits', {max_issue_per_deal: 20}, L.owner));
  assert.equal(r.agent_limits_recorded_by.max_issue_per_deal, 'owner');
  const big = await propose(L, terms(L, L, M, 21));
  rule(big, 'max_issue_per_deal', 'the owner-recorded limit applies');
  assert.equal(big.body.source, 'agent_limits', 'source keeps naming the limit set (compatibility)');
  assert.equal(big.body.recorded_by, 'owner');
  assert.match(big.body.message, /recorded by the owner/); assert.doesNotMatch(big.body.message, /owner's instructions/);
  ok(await call('PUT', '/limits', {max_issue_per_deal: 15}, L.agent));
  const big2 = await propose(L, terms(L, L, M, 16));
  rule(big2, 'max_issue_per_deal', 'the agent-recorded limit applies');
  assert.equal(big2.body.recorded_by, 'agent'); assert.match(big2.body.message, /owner's instructions/);
  assert.equal(ok(await call('GET', '/me', null, L.agent)).agent_limits_recorded_by.max_issue_per_deal, 'agent');
  assert.equal(ok(await call('GET', '/owner', null, L.owner)).agent_limits_recorded_by.max_issue_per_deal, 'agent');
  ok(await call('PUT', '/limits', {max_issue_per_deal: null, notes: 'Goals typed by the owner.'}, L.owner));
  const me = ok(await call('GET', '/me', null, L.agent));
  assert.equal(me.agent_limits_recorded_by.max_issue_per_deal, undefined, 'a cleared limit has no recorder');
  assert.equal(me.agent_limits_recorded_by.notes, 'owner');
  assert.equal(me.agent_limits.max_issue_per_deal, undefined);
});

// =================================================================================================================
// OQ-24: owner token rotation
// =================================================================================================================
test('OQ-24: an owner can rotate its owner token: the new one is shown once, the old one stops working, and the rotation is audited', async () => {
  const P = await newParticipant('rb-oq24');
  refused(await call('POST', '/owner/rotate-token', null, P.agent), 404, 'not_found', 'an agent token cannot rotate the owner token');
  refused(await call('POST', '/owner/rotate-token', null, 'vpo_' + 'A'.repeat(43)), 401, 'unauthorized', 'a made-up owner token');
  const r = ok(await call('POST', '/owner/rotate-token', null, P.owner));
  assert.match(r.owner_token, /^vpo_[A-Za-z0-9_-]{43}$/); assert.notEqual(r.owner_token, P.owner); assert.equal(r.participant_id, P.id);
  refused(await call('GET', '/owner', null, P.owner), 401, 'unauthorized', 'the old owner token stops working');
  refused(await call('PUT', '/owner/mandate', {approve_above: 0}, P.owner), 401, 'unauthorized', 'the old owner token cannot write');
  const o = ok(await call('GET', '/owner', null, r.owner_token));
  assert.equal(o.participant.id, P.id); assert.equal(o.owner_token_rotated_at, r.rotated_at);
  assert.equal(ok(await call('GET', '/me', null, P.agent)).role, 'agent', 'the agent token is unaffected');
  const state = fs.readFileSync(path.join(storeDir, 'pilot-state.json'), 'utf8');
  assert.ok(!state.includes(r.owner_token) && state.includes(sha(r.owner_token)), 'only the hash is stored');
  const audit = fs.readFileSync(path.join(storeDir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(audit.some(e => e.type === 'owner_token.rotated' && e.id === P.id), 'audit event');
  assert.ok(!JSON.stringify(audit).includes(r.owner_token), 'the token is not in the audit log');
  const r2 = ok(await call('POST', '/owner/rotate-token', null, r.owner_token));
  refused(await call('GET', '/owner', null, r.owner_token), 401, 'unauthorized', 'rotated again');
  ok(await call('GET', '/owner', null, r2.owner_token));
});

// =================================================================================================================
// OQ-25: deal-id existence oracle
// =================================================================================================================
test('OQ-25: a proposal with a bad signature is refused as a bad signature whether or not its deal id exists', async () => {
  const P = await newParticipant('rb-oq25-p'), Q = await newParticipant('rb-oq25-q'), E = await newParticipant('rb-oq25-e');
  const t1 = terms(P, P, Q, 5);
  ok(await propose(P, t1), 201);
  const wrong = await sign(E, statements.propose('0'.repeat(64)));        // a valid signature over something else
  const probe = id => { const t = terms(E, E, Q, 5, {deal_id: id}); return call('POST', '/deals', {terms: t, terms_hash: termsHash(t), signature: wrong}, E.agent); };
  const existing = refused(await probe(t1.deal_id), 403, 'bad_signature', 'existing deal id, bad signature');
  const fresh = refused(await probe('vd_' + rnd(8)), 403, 'bad_signature', 'unknown deal id, bad signature');
  assert.equal(existing.message, fresh.message, 'the same answer either way');
  refused(await propose(E, terms(E, E, Q, 5, {deal_id: t1.deal_id})), 409, 'duplicate', 'a correctly signed proposal reusing a deal id is still a duplicate');
});

// =================================================================================================================
// Second batch (conformance pass on release v9, OPEN-QUESTIONS revision 3): OQ-31 residual, OQ-35, OQ-32, OQ-33 residuals
// =================================================================================================================
test('OQ-31/OQ-35: a signer outage during the credit-note template or completion is 503 signer_unavailable; tracker failures are 502 tracker_unavailable', async () => {
  assert.equal(new BasisError('x').name, 'BasisError', 'BasisError has its own name');
  const X = await newParticipant('rb-oq31-x'), Y = await newParticipant('rb-oq31-y');
  const id = await delivered(X, Y, 2);
  // the real signer runner, pointed at a helper that is not there: it fails to start or gives no answer (an outage)
  const working = basis.sign_, missing = makeSignerRunner({mode: runner, signerPath: `${signerPath}-not-installed`, timeoutMs: 8000});
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, X.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  const body = {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(X, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(X.pubkey, message_hex, X.secret)}};
  basis.sign_ = missing;
  try {
    const t = refused(await call('GET', `/deals/${id}/credit-note-template`, null, X.agent), 503, 'signer_unavailable', 'template during an outage');
    assert.match(t.message, /nothing was recorded/);
    refused(await call('POST', `/deals/${id}/complete`, body, X.agent), 503, 'signer_unavailable', 'completion during an outage');
  } finally { basis.sign_ = working; }
  assert.equal((await view(X, id)).status, 'delivered', 'nothing was recorded');
  // the helper goes down after the tracker took the note, during Valun's read-back re-check: issued, and said so
  const verify = basis.verify; let seen = 0;
  basis.verify = async (pk, msg, sig) => {
    if (sig === body.credit_note.signature && ++seen === 2) throw new BasisError('signer timed out', {code: 'signer_unavailable'});
    return verify.call(basis, pk, msg, sig);
  };
  let done;
  try { done = ok(await call('POST', `/deals/${id}/complete`, body, X.agent)); } finally { basis.verify = verify; }
  assert.equal(done.status, 'note_issued', 'not left issuing_note');
  assert.equal(done.credit_note.verified_by_valun, true); assert.match(done.credit_note.reverify_skipped, /signer unavailable/);
  // tracker unreachable: a named code and a fixed message, without the connection details
  const fetchImpl = basis.fetch;
  basis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}}); };
  try {
    for (const [p, tok] of [['/ledger', null], [`/participants/${X.id}`, null], ['/me', X.agent]]) {
      const r = refused(await call('GET', p, null, tok), 502, 'tracker_unavailable', `GET ${p} with the tracker down`);
      assert.doesNotMatch(r.message, /ECONNREFUSED|127\.0\.0\.1|fetch/, 'no connection details in the answer');
    }
  } finally { basis.fetch = fetchImpl; }
  ok(await call('GET', '/ledger'));
});

test('OQ-32: the reason length messages state the limits actually enforced', async () => {
  const X = await newParticipant('rb-oq32-x'), Y = await newParticipant('rb-oq32-y');
  const d = ok(await propose(X, terms(X, X, Y, 3)), 201), h = d.current.terms_hash;
  const decline = async reason => call('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: await sign(Y, statements.decline(h, reason))}, Y.agent);
  assert.match(refused(await decline('No.' + ' '.repeat(600)), 400, 'invalid_field', 'padded decline reason').message, /longer than 600 characters/);
  assert.match(refused(await decline('x'.repeat(501)), 400, 'invalid_field', 'long decline reason').message, /longer than 500 characters/);
  assert.equal(ok(await decline('x'.repeat(500) + ' '.repeat(100))).status, 'declined', 'exactly at both limits');
  const id = await delivered(X, Y, 3), v = await view(X, id), ah = v.agreement.terms_hash, dh = v.delivery.sha256;
  const dispute = async reason => call('POST', `/deals/${id}/dispute`, {terms_hash: ah, deliverable_sha256: dh, reason, signature: await sign(X, statements.dispute(ah, dh, reason))}, X.agent);
  assert.match(refused(await dispute('No.' + ' '.repeat(1100)), 400, 'invalid_field', 'padded dispute reason').message, /longer than 1100 characters/);
  assert.match(refused(await dispute('x'.repeat(1001)), 400, 'invalid_field', 'long dispute reason').message, /longer than 1000 characters/);
});

test('OQ-33: soft hyphen, Hangul fillers, ideographic and stray variation selectors are refused; RGI subdivision flags and emoji presentation are allowed', async () => {
  const X = await newParticipant('rb-oq33-x'), Y = await newParticipant('rb-oq33-y');
  const title = t => ({service: {title: t, description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'}});
  const england = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', scotland = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}';
  const wales = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}';
  for (const [t, what] of [[`Brief for ${england} ${scotland} ${wales}`, 'the three RGI subdivision flags'],
    ['Thanks \u{1f44d}\u{1f3fd} \u{2764}\u{fe0f} 1\u{fe0f}\u{20e3}', 'skin tone, emoji presentation and a keycap'],
    ['Brief \u{1f3f3}\u{fe0f}\u{200d}\u{1f308} \u{1f469}\u{200d}\u{1f4bb}', 'emoji ZWJ sequences with VS16'], ['nbsp\u{a0}here', 'no-break space']])
    assert.equal(ok(await propose(X, terms(X, X, Y, 2, title(t))), 201).status, 'open', what);
  for (const [t, what] of [['soft\u{ad}hyphen', 'soft hyphen'], ['a\u{3164}b', 'Hangul filler U+3164'], ['a\u{115f}b', 'Hangul choseong filler'],
    ['a\u{1160}b', 'Hangul jungseong filler'], ['a\u{ffa0}b', 'halfwidth Hangul filler'], ['ok\u{e0100}\u{e0101}\u{e0102}', 'ideographic variation selectors'],
    ['ok\u{fe0f}', 'a variation selector after ordinary text'], ['\u{1f600}\u{fe0f}\u{fe0f}\u{fe0f}', 'a run of variation selectors'],
    ['Flag \u{1f3f4}\u{e0069}\u{e0067}\u{e006e}\u{e006f}\u{e0072}\u{e0065}\u{e007f}', 'a tag sequence spelling hidden text'], [`${england}\u{e0041}`, 'tag characters after a flag']])
    refused(await propose(X, terms(X, X, Y, 2, title(t))), 400, 'invalid_field', what);
  const d = ok(await propose(X, terms(X, X, Y, 2)), 201), h = d.current.terms_hash;
  const decline = async reason => call('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: await sign(Y, statements.decline(h, reason))}, Y.agent);
  refused(await decline('not\u{ad}now'), 400, 'invalid_field', 'soft hyphen in a reason');
  assert.equal(ok(await decline(`Not in ${england} this week`)).status, 'declined', 'a flag in a reason');
  const inv = ok(await call('POST', '/admin/invites', {note: 'oq33'}, null, ADM), 201).code;
  refused(await call('POST', '/join', {invite: inv, handle: 'rb-oq33-z', operator: 'x', display_name: 'Blank\u{3164}name'}), 400, 'invalid_field', 'Hangul filler in a display name');
});

test('OQ-24 recovery: the operator (loopback + admin token only) can replace a lost or stolen owner token; the owner sees it', async () => {
  const P = await newParticipant('rb-oq24r');
  const stolen = ok(await call('POST', '/owner/rotate-token', null, P.owner)).owner_token;        // a thief rotates first
  refused(await call('GET', '/owner', null, P.owner), 401, 'unauthorized', 'the real owner is locked out');
  refused(await call('POST', `/admin/participants/${P.id}/owner-token`, null, null), 404, 'not_found', 'no admin token');
  const r = ok(await call('POST', `/admin/participants/${P.id}/owner-token`, null, null, ADM));
  refused(await call('GET', '/owner', null, stolen), 401, 'unauthorized', "the thief's token stops working");
  const o = ok(await call('GET', '/owner', null, r.owner_token));
  assert.equal(o.owner_token_rotated_by, 'operator');
  const audit = fs.readFileSync(path.join(storeDir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(audit.some(e => e.type === 'owner_token.reset_by_operator' && e.id === P.id));
});

test('OQ-33 rev 4: variation selectors only in real emoji or keycaps; remaining invisible format characters refused', async () => {
  const Q = await newParticipant('rb-oq33q'), R = await newParticipant('rb-oq33r');
  const svc = title => ({service: {title, description: 'A short job.', deliverable: 'text'}});
  for (const title of ['Keycap 1\ufe0f\u20e3 and #\ufe0f\u20e3', 'Heart \u2764\ufe0f, text heart \u2764\ufe0e, \u00a9\ufe0f', 'Flag \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'])
    ok(await propose(Q, terms(Q, Q, R, 5, svc(title))), 201);
  for (const title of ['Digit 1\ufe0f alone', 'Hash #\ufe0f alone', 'Heart with VS1 \u2764\ufe00', 'Mongolian \u180e sep', 'CGJ e\u034f', 'Deprecated \u206a', 'Music \u{1D173}'])
    refused(await propose(Q, terms(Q, Q, R, 5, svc(title))), 400, 'invalid_field', JSON.stringify(title));
});

test('OQ-33 rev 5: the rule is principled (Cc, Cf, Default_Ignorable) with single joiners/marks and emoji contexts allowed', async () => {
  const Q = await newParticipant('rb-oq33p'), R = await newParticipant('rb-oq33s');
  const C = (...c) => String.fromCodePoint(...c), svc = title => ({service: {title, description: 'A short job.', deliverable: 'text'}});
  for (const title of ['Rainbow ' + C(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), 'Persian ' + C(0x645, 0x6cc, 0x200c, 0x62e), 'Hebrew ' + C(0x5e9, 0x5dc, 0x5d5, 0x5dd, 0x200f) + ' x'])
    ok(await propose(Q, terms(Q, Q, R, 5, svc(title))), 201);
  for (const [name, title] of [['Mongolian FVS', 'a' + C(0x180b)], ['Khmer inherent vowel', 'a' + C(0x17b4)], ['shorthand format', 'a' + C(0x1bca0)],
    ['hieroglyph format', 'a' + C(0x13430)], ['unassigned ignorable', 'a' + C(0xe0080)], ['ZWJ run', 'a' + C(0x200d, 0x200d) + 'b'], ['mark run', 'a' + C(0x200e, 0x200f)]])
    refused(await propose(Q, terms(Q, Q, R, 5, svc(title))), 400, 'invalid_field', name);
});

// =================================================================================================================
// v16 always-on fixes (design §5.3): explicit approval dispatch, full-state staleness of held notes, pair_busy
// =================================================================================================================
// A completion body signed now (template, Basis note, completion statement), to be posted later.
async function completionBody(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  return {tpl, body: {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, message_hex, P.secret)}}};
}
const auditLines = () => fs.readFileSync(path.join(storeDir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('approval dispatch: an approval of a kind this server does not decide gets 409 unknown_approval_kind and changes nothing (it used to run the confirm_offer code: reject withdrew the deal)', async () => {
  // The F4 set-up: W's offer, made under a high threshold, is accepted after W's owner lowered it, so W's owner holds a
  // confirm_offer approval. Its kind is then replaced, as state written by a newer release would have it.
  const W = await newParticipant('rb-kind-w'), Z = await newParticipant('rb-kind-z');
  const d = ok(await propose(W, terms(W, W, Z, 50)), 201);
  await setMandate(W, {approve_above: 10});
  assert.equal(ok(await accept(Z, d.id)).status, 'accepted_awaiting_owner');
  const [a] = await approvalsFor(W, d.id);
  assert.equal(a.kind, 'confirm_offer');
  pilot.s.approvals[a.id].kind = 'kind_from_a_newer_release';
  const deal0 = structuredClone(pilot.s.deals[d.id]), approval0 = structuredClone(pilot.s.approvals[a.id]);
  for (const decision of ['reject', 'approve']) {
    const r = refused(await decide(W, a, decision), 409, 'unknown_approval_kind', decision);
    assert.match(r.message, /kind_from_a_newer_release/); assert.match(r.message, /nothing was changed/);
    assert.deepEqual(pilot.s.deals[d.id], deal0, `${decision}: the deal is unchanged`);
    assert.deepEqual(pilot.s.approvals[a.id], approval0, `${decision}: the approval is unchanged and still pending`);
  }
  assert.ok(auditLines().some(e => e.type === 'approval.unknown_kind' && e.id === a.id && e.kind === 'kind_from_a_newer_release'), 'audited');
  const o = ok(await call('GET', '/owner', null, W.owner));
  assert.equal(o.approvals.find(x => x.id === a.id).subject, null, 'the owner console still loads; the unknown subject is not described');
  assert.equal((await view(Z, d.id)).status, 'accepted_awaiting_owner');
  pilot.s.approvals[a.id].kind = 'confirm_offer';                   // the same approval, of a known kind, decides as before
  assert.equal(ok(await decide(W, a, 'approve')).deal.status, 'agreed');
});

test('held-note staleness compares total, timestamp and signature of the pair\'s last note; a note held by an older version compares the total only', async () => {
  const X = await newParticipant('rb-prior-x'), Y = await newParticipant('rb-prior-y');
  assert.equal(ok(await complete(X, await delivered(X, Y, 2))).status, 'note_issued', 'precondition: the pair has a note (total 2)');
  await setMandate(X, {review_deliveries: true});
  const id = await delivered(X, Y, 3);
  // A stub over the real tracker read: the pair's last note looks changed while its total stays the same (an A-B-A edge).
  // `calls`: how many reads see the change (the approval's own check is the first).
  const real = basis.note;
  const disguise = (change, calls = Infinity) => { let n = 0; basis.note = async (i, r) => { const x = await real.call(basis, i, r); return x && n++ < calls ? {...x, ...change(x)} : x; }; };
  for (const [what, change] of [['another timestamp', x => ({timestamp: x.timestamp + 1})], ['another signature', () => ({signature: '02' + 'ab'.repeat(64)})]]) {
    assert.equal(ok(await complete(X, id)).status, 'completion_awaiting_owner', what);
    const d = pilot.s.deals[id], [a] = await approvalsFor(X, id);
    assert.equal(a.kind, 'issue_note');
    assert.deepEqual(Object.keys(d.note_prior), ['total', 'timestamp', 'signature']);
    assert.equal(d.note_prior.total, 2); assert.match(d.note_prior.signature, /^0[23][0-9a-f]{128}$/);
    assert.ok(!JSON.stringify([await view(X, id), await view(Y, id)]).includes('note_prior'), 'kept on the deal, never in a view');
    disguise(change);
    let r;
    try { r = await decide(X, a, 'approve'); } finally { basis.note = real; }
    assert.match(refused(r, 409, 'stale_note', what).message, /the total is the same/);
    assert.equal(pilot.s.approvals[a.id].state, 'void_stale', what);
    assert.equal(pilot.s.deals[id].status, 'delivered', what); assert.equal(pilot.s.deals[id].credit_note.state, 'stale', what);
    assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 2, `${what}: nothing reached the tracker`);
  }
  // A note held before v16 has no note_prior: the total alone is compared, as before (here the total is the same).
  assert.equal(ok(await complete(X, id)).status, 'completion_awaiting_owner');
  delete pilot.s.deals[id].note_prior;
  const [a] = await approvalsFor(X, id);
  disguise(x => ({timestamp: x.timestamp + 1}), 1);
  let r;
  try { r = await decide(X, a, 'approve'); } finally { basis.note = real; }
  assert.equal(ok(r).deal.status, 'note_issued');
  assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 5);
  await setMandate(X, {review_deliveries: false});
});

test('pair_busy: while a deal is issuing_note after a tracker failure, no new note on its key pair is templated, completed or released; recover() frees the pair', async () => {
  const X = await newParticipant('rb-busy-x'), Y = await newParticipant('rb-busy-y'), Z = await newParticipant('rb-busy-z');
  const d1 = await delivered(X, Y, 2), d2 = await delivered(X, Y, 3), d3 = await delivered(X, Y, 4), dz = await delivered(X, Z, 5);
  await setMandate(X, {review_deliveries: true});                    // d3: a note signed over prior 0, held for X's owner
  assert.equal(ok(await complete(X, d3)).status, 'completion_awaiting_owner');
  await setMandate(X, {review_deliveries: false});
  const early = await completionBody(X, d2);                         // d2: signed over prior 0, posted later
  // The tracker takes d1's note but its answer is lost: the deal stays issuing_note (written ahead), the agent gets 502.
  const api = basis.api;
  basis.api = async (m, p, b) => { const r = await api.call(basis, m, p, b); if (m === 'POST' && p === '/notes') throw new BasisError('tracker unreachable: ECONNRESET'); return r; };
  let r1;
  try { r1 = await complete(X, d1); } finally { basis.api = api; }
  refused(r1, 502, 'tracker_unavailable', 'the answer was lost');
  assert.equal(pilot.s.deals[d1].status, 'issuing_note');
  assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 2, "precondition: the tracker holds d1's note");
  // Without pair_busy the payer could now sign d2 over prior 2 (which counts d1); d1's own note would then fail on
  // resubmission and be offered for completion again: d1 paid twice.
  const busy = refused(await call('GET', `/deals/${d2}/credit-note-template`, null, X.agent), 409, 'pair_busy', 'template on the busy pair');
  assert.equal(busy.retry_after_ms, 60000); assert.match(busy.message, /Try again in 60 s/);
  refused(await call('POST', `/deals/${d2}/complete`, early.body, X.agent), 409, 'pair_busy', 'completion on the busy pair');
  assert.equal(pilot.s.deals[d2].status, 'delivered'); assert.equal(pilot.s.deals[d2].credit_note ?? null, null, 'nothing recorded');
  const [held] = await approvalsFor(X, d3);
  refused(await decide(X, held, 'approve'), 409, 'pair_busy', 'releasing a held note on the busy pair');
  assert.equal(pilot.s.approvals[held.id].state, 'pending'); assert.equal(pilot.s.approvals[held.id].decided_at, undefined);
  assert.equal(pilot.s.deals[d3].status, 'completion_awaiting_owner');
  assert.equal(ok(await call('GET', `/deals/${dz}/credit-note-template`, null, X.agent)).prior_total, 0, "the payer's other pair is not busy");
  // Recovery (startup and every 60 s) adopts d1's note: the pair is free and the next note counts d1 exactly once.
  assert.deepEqual(await pilot.recover(), ['note_issued']);
  assert.equal(pilot.s.deals[d1].status, 'note_issued');
  refused(await call('POST', `/deals/${d2}/complete`, early.body, X.agent), 409, 'stale_note', 'the body signed over prior 0');
  assert.equal(ok(await call('GET', `/deals/${d2}/credit-note-template`, null, X.agent)).prior_total, 2);
  assert.equal(ok(await complete(X, d2)).status, 'note_issued');
  assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 5);
  refused(await decide(X, held, 'approve'), 409, 'stale_note', 'the held note was signed over prior 0: void, never released');
  assert.equal(pilot.s.approvals[held.id].state, 'void_stale');
  assert.equal(ok(await complete(X, dz)).status, 'note_issued');
  assert.deepEqual([...new Set(ok(await call('GET', '/ledger')).reconciliation.filter(x => x.issuer === X.handle).map(x => x.status))], ['match']);
});

// =================================================================================================================
// v16 bound notes and timestamp residues (design §3.1, §3.2, §4.3; spec 18.4, 18.5). The tests against the tracker need
// tracker v3 (VALUN_BINS=<v3 bins>) and skip otherwise; the bound ones use boundPilot (circulation mode bound).
// =================================================================================================================
const needsV3 = t => { if (boundPilot) return false; t.skip(v3Skip); return true; };
async function onBound(fn) { target = boundBase; try { return await fn(); } finally { target = null; } }
const boundTemplate = async (P, id) => ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, P.agent));
const edgeState = n => n && {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature};
// A bound completion body for a template asked for with bound=1: the note M(I,R,total,ts) and the issuer's prior
// acknowledgment PA(I,R,ackTotal,ackTimestamp,ts) of tracker v3.2 (the prior note's total and timestamp, 0 and 0 for a
// new pair), both signed by the payer, which builds both messages itself; prior_timestamp is asserted as a v3.2 client
// does (null: not sent).
const priorTsOf = tpl => (tpl.prior_note ? tpl.prior_note.timestamp : 0);
async function boundBody(P, tpl, {total = tpl.total, priorTotal = tpl.prior_total, ackTotal = tpl.prior_total, ackTimestamp = priorTsOf(tpl), priorTimestamp = priorTsOf(tpl), priorSignature} = {}) {
  const msg = t => basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: t, timestamp: tpl.timestamp}).then(r => r.message_hex);
  const ack = (await basis.priorAckMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, priorTotal: ackTotal, priorTimestamp: ackTimestamp, timestamp: tpl.timestamp})).message_hex;
  return {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, await msg(total), P.secret), prior_total: priorTotal,
      ...(priorTimestamp === null ? {} : {prior_timestamp: priorTimestamp}),
      prior_signature: priorSignature === undefined ? await basis.signHex(P.pubkey, ack, P.secret) : priorSignature}};
}
// An ordinary completion body for exactly this template (or this timestamp).
async function ordinaryBody(P, tpl, timestamp = tpl.timestamp) {
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp});
  return {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp, signature: await basis.signHex(P.pubkey, message_hex, P.secret)}};
}
const clampMs = t => (t % 1000 >= 995 ? t + 1000 - (t % 1000) : t);

test('bound notes (tracker v3, mode bound): the template ends in 997 ms and carries prior_note; complete gives note_issued; each note is bound to the total before it', async t => {
  if (needsV3(t)) return;
  assert.equal(boundPilot.mode, 'bound', JSON.stringify(boundLog)); assert.deepEqual(boundLog, []);
  await onBound(async () => {
    assert.deepEqual(ok(await call('GET', '/info')).features, ['bound_notes/1']);
    const X = await newParticipant('rb-bound-x'), Y = await newParticipant('rb-bound-y');
    let expected = 0;
    for (const price of [2, 3]) {
      const id = await delivered(X, Y, price), cur = await basis.note(X.pubkey, Y.pubkey);
      const tpl = await boundTemplate(X, id);
      assert.equal(tpl.timestamp % 1000, 997, 'residue 997');
      assert.ok(tpl.timestamp <= now() - 1500 && tpl.timestamp > Number(cur?.timestamp ?? 0), "at least 1.5 s old, and after the pair's last note");
      assert.deepEqual([tpl.prior_total, tpl.price, tpl.total], [expected, price, expected + price]);
      assert.deepEqual(tpl.prior_note, edgeState(cur), "prior_note: the pair's tracker note (null on a new pair)");
      if (cur) assert.ok(await basis.verify(X.pubkey, (await basis.noteMessage({issuer: X.pubkey, recipient: Y.pubkey, total: Number(cur.amount_collected), timestamp: cur.timestamp})).message_hex,
        tpl.prior_note.signature), "prior_note carries the issuer's own signature");
      assert.equal(tpl.prior_timestamp, cur ? cur.timestamp : 0, "prior_timestamp: the pair's note's timestamp (0 on a new pair)");
      assert.equal(tpl.prior_message_hex, (await basis.priorAckMessage({issuer: X.pubkey, recipient: Y.pubkey, priorTotal: expected, priorTimestamp: tpl.prior_timestamp, timestamp: tpl.timestamp})).message_hex,
        'prior_message_hex = PA(I,R,prior,prior_timestamp,ts)');
      assert.equal(tpl.prior_message_hex.length, 210, '105 bytes');
      const body = await boundBody(X, tpl);
      const done = ok(await call('POST', `/deals/${id}/complete`, body, X.agent));
      assert.equal(done.status, 'note_issued', JSON.stringify(done.credit_note));
      expected += price;
      assert.deepEqual(edgeState(await basis.note(X.pubkey, Y.pubkey)), {total: expected, timestamp: tpl.timestamp, signature: body.credit_note.signature}, 'the tracker holds the bound note');
      assert.equal(boundPilot.s.deals[id].credit_note.note.prior_signature, body.credit_note.prior_signature, 'the acknowledgment is kept with the note');
    }
    const e = ok(await call('GET', '/edges', null, X.agent));
    assert.deepEqual(e.journal.map(x => [x.kind, x.delta, x.total_after]), [['issue', 2, 2], ['issue', 3, 5]]);
    assert.deepEqual(e.outgoing.map(x => [x.total, x.exact, x.bound_only, x.frozen]), [[5, true, false, false]]);
    assert.deepEqual((await boundPilot.reconcile()).find(r => r.issuer === X.handle), {issuer: X.handle, recipient: Y.handle, tracker_total: 5, issued_via_valun: 5, status: 'match'});
  });
});

test('bound notes: a stale prior (total or timestamp) is refused with a fresh bound template; a missing or wrong prior acknowledgment (another total, another prior timestamp, the 80-byte note message of tracker v3.2, another key) is refused; nothing reaches the tracker', async t => {
  if (needsV3(t)) return;
  await onBound(async () => {
    const X = await newParticipant('rb-stale-x'), Y = await newParticipant('rb-stale-y');
    const d1 = await delivered(X, Y, 2), d2 = await delivered(X, Y, 3);
    const early = await boundBody(X, await boundTemplate(X, d1));               // d1, signed over prior 0
    assert.equal(ok(await call('POST', `/deals/${d2}/complete`, await boundBody(X, await boundTemplate(X, d2)), X.agent)).status, 'note_issued');   // the prior is 3 now
    const before = edgeState(await basis.note(X.pubkey, Y.pubkey));
    const r = refused(await call('POST', `/deals/${d1}/complete`, early, X.agent), 409, 'stale_note', 'signed over prior 0');
    assert.equal(r.template.timestamp % 1000, 997, 'with a fresh BOUND template');
    assert.deepEqual([r.template.prior_total, r.template.total, r.template.prior_note], [3, 5, before]);
    const tpl = r.template, post = b => call('POST', `/deals/${d1}/complete`, b, X.agent);
    assert.equal(refused(await post(await boundBody(X, tpl, {priorTotal: 2})), 409, 'stale_note', "prior_total is not the tracker's").template.prior_total, 3);
    const noTotal = await boundBody(X, tpl); delete noTotal.credit_note.prior_total;
    refused(await post(noTotal), 409, 'stale_note', 'no prior_total');
    // Tracker v3.2: an asserted prior_timestamp that is not the pair's note's is stale too, with a fresh bound template.
    const staleTs = refused(await post(await boundBody(X, tpl, {priorTimestamp: before.timestamp - 1, ackTimestamp: before.timestamp - 1})), 409, 'stale_note', "prior_timestamp is not the tracker's");
    assert.deepEqual([staleTs.template.timestamp % 1000, staleTs.template.prior_timestamp], [997, before.timestamp]);
    assert.match(staleTs.message, /prior_timestamp/);
    const noAck = await boundBody(X, tpl); delete noAck.credit_note.prior_signature;
    assert.match(refused(await post(noAck), 403, 'bad_signature', 'no prior acknowledgment').message, /prior acknowledgment/);
    refused(await post(await boundBody(X, tpl, {ackTotal: 2})), 403, 'bad_signature', 'an acknowledgment of another total');
    refused(await post(await boundBody(X, tpl, {ackTimestamp: before.timestamp - 1})), 403, 'bad_signature', 'an acknowledgment of another prior timestamp (the same total)');
    refused(await post(await boundBody(X, tpl, {ackTimestamp: before.timestamp - 1, priorTimestamp: null})), 403, 'bad_signature', 'the same, prior_timestamp not asserted');
    const v31Ack = (await basis.noteMessage({issuer: X.pubkey, recipient: Y.pubkey, total: 3, timestamp: tpl.timestamp})).message_hex;
    assert.match(refused(await post(await boundBody(X, tpl, {priorSignature: await basis.signHex(X.pubkey, v31Ack, X.secret)})), 403, 'bad_signature', "tracker v3.2's acknowledgment M(I,R,prior,ts)").message,
      /basis\/prior-ack\/1/);
    const ackMsg = (await basis.priorAckMessage({issuer: X.pubkey, recipient: Y.pubkey, priorTotal: 3, priorTimestamp: before.timestamp, timestamp: tpl.timestamp})).message_hex;
    refused(await post(await boundBody(X, tpl, {priorSignature: await basis.signHex(Y.pubkey, ackMsg, Y.secret)})), 403, 'bad_signature', "not the issuer's acknowledgment");
    refused(await post(await boundBody(X, tpl, {priorSignature: 'zz'})), 403, 'bad_signature', 'not a signature');
    assert.equal(boundPilot.s.deals[d1].status, 'delivered'); assert.equal(boundPilot.s.deals[d1].credit_note ?? null, null, 'nothing recorded');
    assert.deepEqual(edgeState(await basis.note(X.pubkey, Y.pubkey)), before, 'nothing reached the tracker');
    assert.equal(ok(await post(await boundBody(X, tpl, {priorTimestamp: null}))).status, 'note_issued', 'the fresh template completes (prior_timestamp not asserted: the pair\'s state as it is)');
    assert.equal(Number((await basis.note(X.pubkey, Y.pubkey)).amount_collected), 5);
  });
});

test('bound notes: a note held for the owner (review_deliveries) keeps its prior acknowledgment, withheld from the payee, and goes to the tracker with it when the owner approves', async t => {
  if (needsV3(t)) return;
  await onBound(async () => {
    const X = await newParticipant('rb-held-x', {review_deliveries: true}), Y = await newParticipant('rb-held-y');
    const id = await delivered(X, Y, 4);
    const body = await boundBody(X, await boundTemplate(X, id));
    assert.equal(ok(await call('POST', `/deals/${id}/complete`, body, X.agent)).status, 'completion_awaiting_owner');
    const held = boundPilot.s.deals[id].credit_note;
    assert.deepEqual([held.note.prior_signature, held.prior_total], [body.credit_note.prior_signature, 0]);
    const seen = JSON.stringify(await view(Y, id));
    assert.ok(!seen.includes(body.credit_note.signature) && !seen.includes(body.credit_note.prior_signature), 'both signatures are withheld from the payee');
    assert.equal(await basis.note(X.pubkey, Y.pubkey), null, 'nothing on the tracker yet');
    const [a] = await approvalsFor(X, id);
    assert.equal(ok(await decide(X, a, 'approve')).deal.status, 'note_issued');
    assert.deepEqual(edgeState(await basis.note(X.pubkey, Y.pubkey)), {total: 4, timestamp: body.credit_note.timestamp, signature: body.credit_note.signature});
  });
});

test('mode bound: deal views (next_actions, labels), /me, /owner, positions and the inbox stay v15\'s; a held bound note\'s approval shows its prior acknowledgment and until when the tracker takes it', async t => {
  if (needsV3(t)) return;
  await onBound(async () => {
    const X = await newParticipant('rb-dark-x', {review_deliveries: true}), Y = await newParticipant('rb-dark-y');
    const id = await delivered(X, Y, 3);
    const SETTLED_V15 = 'not settled: issuing a credit note creates an outstanding obligation; the pilot has no redemption, reserve or clearing, so nothing is ever settled here';
    for (const [P, next] of [[X, ['complete', 'dispute']], [Y, []]]) {
      const v = await view(P, id);
      assert.deepEqual([v.next_actions, 'payment' in v, v.labels.settlement], [next, false, SETTLED_V15], `${P.handle}: v15's view`);
    }
    const me = ok(await call('GET', '/me', null, X.agent)), o = ok(await call('GET', '/owner', null, X.owner)), ib = ok(await call('GET', '/inbox', null, X.agent));
    for (const k of ['credit_policy', 'features']) assert.ok(!(k in me) && !(k in o), `no ${k} in mode bound`);
    assert.deepEqual(Object.keys(me.position), ['participant_id', 'unit', 'claims_held', 'owes', 'net', 'claims', 'debts', 'deals', 'settled', 'backing', 'meaning']);
    assert.deepEqual(Object.keys(ib), ['respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed']);
    const body = await boundBody(X, await boundTemplate(X, id));
    assert.equal(ok(await call('POST', `/deals/${id}/complete`, body, X.agent)).status, 'completion_awaiting_owner');
    const [a] = await approvalsFor(X, id);
    assert.deepEqual(Object.keys(a.subject.credit_note), ['issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'amount', 'prior_total', 'total', 'timestamp', 'message_hex', 'signature',
      'signed_at', 'bound', 'prior_signature', 'expires_at'], 'a bound note: the v15 fields, then its acknowledgment');
    assert.deepEqual([a.subject.credit_note.bound, a.subject.credit_note.prior_signature, a.subject.credit_note.expires_at],
      [true, body.credit_note.prior_signature, new Date(body.credit_note.timestamp + 3600e3).toISOString()]);
    assert.match(a.effect.if_approved, /It is a bound note: the tracker records it only while the pair's note is still the one it acknowledges \(total 0 PC, the state it was signed on\), and only until /);
    const yv = await view(Y, id);
    assert.deepEqual(yv.next_actions, ['wait_for_owner_approval']);
    assert.ok(!JSON.stringify(yv).includes(body.credit_note.prior_signature), "the acknowledgment is withheld from the payee");
    assert.equal(ok(await decide(X, a, 'approve')).deal.status, 'note_issued');
  });
});

test('bound notes: a submission that never reached the tracker is resubmitted by recover() with its prior acknowledgment', async t => {
  if (needsV3(t)) return;
  await onBound(async () => {
    const X = await newParticipant('rb-rec-x'), Y = await newParticipant('rb-rec-y');
    const id = await delivered(X, Y, 2);
    const body = await boundBody(X, await boundTemplate(X, id));
    const api = basis.api;
    basis.api = async (m, p, b) => { if (m === 'POST' && p === '/notes') { basis.api = api; throw new BasisError('tracker unreachable: ETIMEDOUT'); } return api.call(basis, m, p, b); };
    let r;
    try { r = await call('POST', `/deals/${id}/complete`, body, X.agent); } finally { basis.api = api; }
    refused(r, 502, 'tracker_unavailable', 'the tracker could not be reached');
    assert.equal(boundPilot.s.deals[id].status, 'issuing_note', 'written ahead');
    assert.equal(await basis.note(X.pubkey, Y.pubkey), null, 'precondition: it never reached the tracker');
    assert.deepEqual(await boundPilot.recover(), ['note_issued']);
    assert.deepEqual(edgeState(await basis.note(X.pubkey, Y.pubkey)), {total: 2, timestamp: body.credit_note.timestamp, signature: body.credit_note.signature},
      'resubmitted as a bound note (the tracker refuses residue 997 without the acknowledgment)');
    assert.deepEqual(boundPilot.s.edge_log_tail.filter(e => e.ref === id).map(e => [e.kind, e.delta]), [['issue', 2]], 'journaled once');
  });
});

test('tracker v3: it refuses an ordinary note at a reserved residue; ordinary templates skip 995-999 (at a stopped clock, for each residue) and complete; completing at a reserved residue is 409 stale_note with a fresh template', async t => {
  if (needsV3(t)) return;
  // The control: without the clamp, such a note is refused by the tracker itself.
  const X0 = await newParticipant('rb-res-x0'), Y0 = await newParticipant('rb-res-y0');
  const ts996 = residueTimestamp(Date.now(), 996, 0).timestamp;
  const m996 = await basis.noteMessage({issuer: X0.pubkey, recipient: Y0.pubkey, total: 1, timestamp: ts996});
  const raw = await basis.api('POST', '/notes', {issuer_pubkey: X0.pubkey, recipient_pubkey: Y0.pubkey, amount: 1, timestamp: ts996,
    signature: await basis.signHex(X0.pubkey, m996.message_hex, X0.secret), tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION});
  assert.equal(raw.status, 400, raw.text); assert.equal(raw.json?.code, 'reserved_timestamp', raw.text);
  // Templates at a clock stopped where now - 1500 ends in each reserved residue (a new payee each time, so the pair's
  // last note does not decide the timestamp): never a reserved residue, at most 5 ms later, and the tracker takes them.
  await onBound(async () => {
    const X = await newParticipant('rb-res-x');
    for (const r of [995, 996, 997, 998, 999]) {
      const Y = await newParticipant(`rb-res-y${r}`), id = await delivered(X, Y, 1);
      const t0 = Date.now() - 300, stop = t0 - (((t0 - 1500 - r) % 1000) + 1000) % 1000;
      assert.equal((stop - 1500) % 1000, r, 'precondition');
      let tpl;
      frozenAt = stop;
      try { tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, X.agent)); } finally { frozenAt = null; }
      assert.equal(tpl.timestamp, clampMs(stop - 1500), `residue ${r}: the next whole second`);
      assert.ok(tpl.timestamp % 1000 < 995 && tpl.timestamp - (stop - 1500) <= 5);
      assert.equal(ok(await call('POST', `/deals/${id}/complete`, await ordinaryBody(X, tpl), X.agent)).status, 'note_issued', `residue ${r}: the tracker takes it`);
    }
  });
  // In mode off (the main server, which learns the reserved residues from the tracker): a client-made timestamp at a
  // reserved residue other than 997 is refused before the tracker sees it, with a fresh ordinary template.
  const X = await newParticipant('rb-res-x1'), Y = await newParticipant('rb-res-y1');
  const id = await delivered(X, Y, 2);
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, X.agent));
  assert.ok(tpl.timestamp % 1000 < 995);
  for (const r of [995, 996, 998, 999]) {
    const ts = residueTimestamp(now(), r, 0).timestamp;
    const e = refused(await call('POST', `/deals/${id}/complete`, await ordinaryBody(X, tpl, ts), X.agent), 409, 'stale_note', `residue ${r}`);
    assert.match(e.message, new RegExp(`ends in ${r} ms`)); assert.ok(e.template && e.template.timestamp % 1000 < 995, 'a fresh ordinary template');
  }
  refused(await call('GET', `/deals/${id}/credit-note-template?bound=1`, null, X.agent), 409, 'feature_unavailable', 'no bound template in mode off');
  // ... while a timestamp ending in 997 makes a bound note, in every mode against tracker v3 (spec 18.5)
  const ts997 = residueTimestamp(now(), 997, 0).timestamp;
  assert.equal(refused(await call('POST', `/deals/${id}/complete`, await ordinaryBody(X, tpl, ts997), X.agent), 409, 'stale_note', 'residue 997 without prior_total').template, null,
    'no bound template in mode off');
  assert.equal(pilot.s.deals[id].status, 'delivered');
  assert.equal(ok(await call('POST', `/deals/${id}/complete`, await boundBody(X, {...tpl, timestamp: ts997}), X.agent)).status, 'note_issued');
  assert.equal((await basis.note(X.pubkey, Y.pubkey)).timestamp, ts997);
});

test('timestamp residues (property loop over a fake clock): against a tracker that reserves 995-999, ordinary templates never end in them and move at most 5 ms; bound templates always end in 997, at least 1.5 s back and after the last note', async () => {
  // A Pilot over a stub tracker (the v3.2 capabilities, read from the tracker when they validate) and a clock the loop sets.
  const caps = validateCaps(trackerCaps).ok ? trackerCaps : {tracker: 'basis', build: 'valun-circulating-credit/4', commit: 'stub', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999],
    bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to',
      'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true,
      signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
  let clock = 0, edge = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-robustness-clock-'));
  try {
    const stub = {nft: tracker.nft, denomination: PILOT_DENOMINATION, note: async () => edge, noteMessage: async ({total, timestamp}) => ({message_hex: `${total}@${timestamp}`}),
      priorAckMessage: async ({priorTotal, priorTimestamp, timestamp}) => ({message_hex: `${priorTotal}/${priorTimestamp}@${timestamp}`})};
    const pin = 'ef'.repeat(32), pl = new Pilot({store: new PilotStore(dir), basis: stub, now: () => clock, circulation: 'bound', trackerCaps: caps, trackerSha256: pin, trackerPins: [pin], log: () => {}});
    assert.equal(pl.mode, 'bound');
    const person = h => ({id: 'vp_' + rnd(6), handle: h, display_name: h, operator: 'test', about: '', services: '', pubkey: '02' + rnd(32), status: 'active', created_at: new Date().toISOString(),
      owner_token_hash: rnd(32), agent_token_hash: rnd(32), enrollment: null, mandate: {...DEFAULT_MANDATE}, mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null});
    const P = person('clock-payer'), Q = person('clock-payee'), id = 'vd_' + rnd(8);
    pl.s.participants[P.id] = P; pl.s.participants[Q.id] = Q;
    const agreed = {payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, price: {amount: 2, unit: 'PC'}};
    pl.s.deals[id] = {id, payer: P.id, payee: Q.id, status: 'delivered', history: [], versions: [{v: 1, by: P.id, terms: agreed, terms_hash: rnd(32), offered_at: new Date().toISOString()}],
      agreement: {version: 1, terms: agreed, terms_hash: rnd(32)}, delivery: {sha256: rnd(32)}};
    // now - 1500 walks through these residues (all the reserved ones and their neighbours; 496-499 put the clock itself
    // just before a whole second), with the pair's last note absent, well behind, within the last 1.5 s, or around the
    // clock (up to 6 ms ahead of it).
    const residues = [990, 991, 992, 993, 994, 995, 996, 997, 998, 999, 0, 1, 2, 3, 4, 5, 500, 123, 496, 497, 498, 499], base0 = 1794000000000;
    const n = {ordinary: 0, clamped: 0, ahead: 0, bound: 0, wait: 0};
    for (let i = 0; i < 8800; i++) {
      clock = base0 + i * 1000 + 1500 + residues[i % residues.length];
      const kind = i % 4, last = kind === 0 ? null : kind === 1 ? clock - 1500 - (i % 4000) : kind === 2 ? clock - 1500 + (i % 1500) : clock - 6 + (i % 13);
      edge = last === null ? null : {amount_collected: 4, amount_redeemed: 0, timestamp: last, signature: '02' + 'ab'.repeat(64)};
      const lastTs = last ?? 0, chosen = Math.max(clock - 1500, lastTs + 1), want = clampMs(chosen);
      try {
        const tpl = await pl.noteTemplate(P, id, {wait: false});
        assert.ok(tpl.timestamp % 1000 < 995, `clock ${clock}, last ${last}: ${tpl.timestamp}`);
        assert.equal(tpl.timestamp, want); assert.ok(tpl.timestamp > lastTs && tpl.timestamp <= clock && tpl.timestamp - chosen <= 5);
        n.ordinary++; if (tpl.timestamp !== chosen) n.clamped++;
      } catch (e) {
        assert.equal(e.code, 'note_timestamp_ahead', String(e)); assert.ok(want > clock); assert.equal(e.extra.retry_after_ms, want - clock);
        n.ahead++;
      }
      try {
        const b = await pl.noteTemplate(P, id, {wait: false, bound: true});
        assert.equal(b.timestamp % 1000, 997);
        assert.ok(b.timestamp <= clock - 1500 && b.timestamp > lastTs && b.timestamp + 1000 > clock - 1500, `the largest such timestamp: ${b.timestamp}`);
        assert.deepEqual(b.prior_note, edge && {total: 4, timestamp: last, signature: edge.signature});
        assert.equal(b.prior_timestamp, last ?? 0, "prior_timestamp: the pair's note's timestamp (0: none)");
        assert.equal(b.prior_message_hex, `${edge ? 4 : 0}/${last ?? 0}@${b.timestamp}`, 'PA(I,R,prior_total,prior_timestamp,ts)');
        n.bound++;
      } catch (e) {
        assert.equal(e.code, 'note_timestamp_ahead', String(e));
        const first = lastTs + 1 + (((997 - (lastTs + 1)) % 1000) + 1000) % 1000;
        assert.ok(first > clock - 1500, 'there is no such timestamp yet'); assert.equal(e.extra.retry_after_ms, first + 1500 - clock);
        n.wait++;
      }
    }
    assert.ok(n.clamped > 300 && n.ahead > 100 && n.bound > 2000 && n.wait > 1000, JSON.stringify(n));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('handles shaped like participant ids (vp_ followed by 12 hex digits) are refused at join and at join-sandbox, with circulation off as in every mode', async () => {
  const inv = ok(await call('POST', '/admin/invites', {max_uses: 2}, null, ADM), 201);
  const r = refused(await call('POST', '/join', {invite: inv.code, handle: 'vp_0123456789ab', operator: 'robustness'}), 400, 'invalid_field', 'join');
  assert.match(r.message, /must not look like a participant id/);
  // Self-serve sandbox joining switched on, with a sandbox agent to deal with.
  const open = pilot.openSandbox, ids = pilot.sandboxIds, count = Object.keys(pilot.s.participants).length;
  pilot.openSandbox = true; pilot.sandboxIds = new Set(['vp_aaaaaaaaaaaa']);
  try {
    const s = refused(await call('POST', '/join-sandbox', {handle: 'vp_00000000beef'}), 400, 'invalid_field', 'join-sandbox');
    assert.match(s.message, /must not look like a participant id/);
  } finally { pilot.openSandbox = open; pilot.sandboxIds = ids; }
  assert.equal(Object.keys(pilot.s.participants).length, count, 'nobody joined');
  assert.equal(ok(await call('POST', '/join', {invite: inv.code, handle: 'vp_0123456789abc', operator: 'robustness'}), 201).handle, 'vp_0123456789abc', 'one more character is no id');
});

test('migrate() renames only a first-version note record (a d.payment without a method): a payment by debt transfer, kept as d.payment {method: transfer}, is kept at every start and every mode change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-robust-payment-'));
  try {
    const terms = {price: {amount: 5, unit: 'PC'}}, v = {v: 1, by: 'vp_aaaaaaaaaaaa', state: 'accepted', created_at: '2026-11-01T00:00:00.000Z', offered_at: '2026-11-01T00:00:00.000Z', terms};
    const v16 = {
      vd_held: {status: 'completion_awaiting_owner', payment: {method: 'transfer', transfer_id: 'vt_0000000000000001'}},
      vd_collecting: {status: 'paying_by_transfer', payment: {method: 'transfer', transfer_id: 'vt_0000000000000002'}},
      vd_paid: {status: 'paid_by_transfer', payment: {method: 'transfer', transfer_id: 'vt_0000000000000003', applied_at: '2026-11-08T00:00:00.000Z'}},
    };
    const deals = {vd_legacy: {id: 'vd_legacy', status: 'paid', versions: [v], agreement: {terms}, payment: {state: 'recorded', prior_total: 0}}};
    for (const [id, x] of Object.entries(v16)) deals[id] = {id, versions: [v], agreement: {terms}, history: [], ...structuredClone(x)};
    fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify({version: 1, participants: {}, deals, approvals: {}, invites: {}}));
    const check = (pl, when) => {
      const l = pl.s.deals.vd_legacy;
      assert.deepEqual([l.status, l.credit_note?.amount, l.credit_note?.state, 'payment' in l], ['note_issued', 5, 'recorded', false], `${when}: the first version's record is renamed`);
      for (const [id, x] of Object.entries(v16)) assert.deepEqual([pl.s.deals[id].status, pl.s.deals[id].payment, pl.s.deals[id].credit_note], [x.status, x.payment, undefined], `${when}: ${id} is kept`);
    };
    const pl = new Pilot({store: new PilotStore(dir), basis: {}, log: () => {}});
    check(pl, 'at the start');
    // Each change of the circulation settings runs migrate() again (as server.mjs does once it has read the tracker).
    for (const change of [{trackerCaps: null}, {circulation: 'on'}, {circulation: 'off'}]) { pl.configureCirculation(change); check(pl, JSON.stringify(change)); }
    check(new Pilot({store: new PilotStore(dir), basis: {}, log: () => {}}), 'at the next start');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
