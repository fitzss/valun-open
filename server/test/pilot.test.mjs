// Pilot network tests over real HTTP, against a throwaway REAL Basis tracker serving the PC token (port 3052).
// Participants sign with keys the server never sees (here: Basis's Rust signer stands in for each participant's client).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner, ordinaryTimestamp} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

let tracker, server, base, basis, pilot, store, clockOffset = 0;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

before(async () => {
  tracker = await startTracker(3052, {servedTokenId: PILOT_TOKEN_ID});
  store = new PilotStore(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-pilot-')));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store, basis, now: () => Date.now() + clockOffset});
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha('admin-secret')});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await tracker?.stop(); });

const call = async (method, p, body, token, headers = {}) => {
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: body && JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

// A participant: joins with an invite (owner), enrolls an agent key generated "locally" (never sent to the server).
async function newParticipant(handle, mandate = {}) {
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `test operator of ${handle}`, about: `${handle} (test)`}), 201);
  const key = await basis.keygen();
  const sig = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: sig}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 200, max_accept_per_deal: 100, max_accept_per_issuer: 150, ...mandate}, P.owner));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
function terms(proposer, payer, payee, price, extra = {}) {
  const now = Date.now() + clockOffset;
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + crypto.randomBytes(8).toString('hex'), version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'),
    proposer: proposer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Short research brief', description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * 3600e3).toISOString(), offer_expires_at: new Date(now + 24 * 3600e3).toISOString(), ...extra};
}
async function propose(P, t) { const h = termsHash(t); return call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent); }
async function accept(P, id) { const d = ok(await call('GET', `/deals/${id}`, null, P.agent)); const h = d.current.terms_hash; return call('POST', `/deals/${id}/accept`, {terms_hash: h, signature: await sign(P, statements.accept(h))}, P.agent); }
async function deliver(P, id, content) {
  const d = ok(await call('GET', `/deals/${id}`, null, P.agent)), h = d.agreement.terms_hash, dh = sha(content);
  return call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(P, statements.deliver(h, dh))}, P.agent);
}
async function complete(P, id, {mutateTotal = 0} = {}) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const total = tpl.total + mutateTotal;
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total, timestamp: tpl.timestamp});
  const note = await basis.signHex(P.pubkey, message_hex, P.secret);
  return call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: {total, timestamp: tpl.timestamp, signature: note}}, P.agent);
}

let A, B, C;
test('distinct identities: invite-gated join, locally generated keys, proof of possession', async () => {
  A = await newParticipant('ana'); B = await newParticipant('ben'); C = await newParticipant('cyd');
  assert.notEqual(A.pubkey, B.pubkey);
  const dir = ok(await call('GET', '/participants'));
  assert.deepEqual(dir.map(p => p.handle).sort(), ['ana', 'ben', 'cyd']);
  assert.ok(dir.every(p => !('owner_token_hash' in p) && !('agent_token_hash' in p) && !('secret' in p)), 'no credential material in public data');
  // invites are single-use; enrollment needs a valid proof of possession
  assert.equal((await call('POST', '/join', {invite: 'vpi_nope', handle: 'eve', operator: 'x'})).status, 403);
  const inv = ok(await call('POST', '/admin/invites', {}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle: 'dee', operator: 'op'}), 201);
  assert.equal((await call('POST', '/join', {invite: inv.code, handle: 'dee2', operator: 'op'})).status, 403);
  const k = await basis.keygen();
  const wrong = await basis.signHex(k.pubkey_hex, hex('something else'), k.secret_hex);
  assert.equal((await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: k.pubkey_hex, signature: wrong})).body.error, 'bad_signature');
  assert.equal((await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: A.pubkey, signature: wrong})).body.error, 'key_in_use');
});

test('admin route is loopback + token only', async () => {
  assert.equal((await call('POST', '/admin/invites', {}, null, {'x-valun-admin': 'wrong'})).status, 404);
  assert.equal((await call('POST', '/admin/invites', {}, null, {'x-valun-admin': 'admin-secret', 'fly-client-ip': '1.2.3.4'})).status, 404);
});

let deal1;
test('happy path: propose, accept, deliver, accept delivery -> payer-signed note recorded by the real tracker', async () => {
  const t = terms(A, A, B, 20);
  const d = ok(await propose(A, t), 201);
  assert.equal(d.status, 'open');
  deal1 = d.id;
  const acc = ok(await accept(B, deal1));
  assert.equal(acc.status, 'agreed');
  assert.equal((await call('GET', `/deals/${deal1}/credit-note-template`, null, A.agent)).status, 409, 'no credit note before delivery');
  ok(await deliver(B, deal1, '# Brief\nThree sources...'));
  const paid = ok(await complete(A, deal1));
  assert.equal(paid.status, 'note_issued');
  assert.equal(paid.credit_note.state, 'recorded');
  assert.equal(paid.credit_note.settled, false, 'issuing a credit note is not settling an obligation');
  assert.equal(paid.credit_note.outstanding, true);
  assert.equal(paid.credit_note.tracker_note.amount_collected, 20);
  assert.equal(paid.credit_note.tracker_note.confirmation, 'local_only');
  assert.equal(paid.credit_note.verified_by_valun, true);
  assert.match(paid.labels.settlement, /not settled/);
  assert.match(paid.labels.basis, /held by the pilot tracker/);
  const note = await basis.note(A.pubkey, B.pubkey);
  assert.equal(Number(note.amount_collected), 20);
  assert.equal(note.denomination, PILOT_DENOMINATION);
  const led = ok(await call('GET', '/ledger'));
  assert.deepEqual(led.reconciliation.map(r => r.status), ['match']);
  assert.equal(ok(await call('GET', `/participants/${B.id}`)).public_position.claims_held, 20);
});

test('cross-user access: a third party cannot read or act on a deal; roles are separated', async () => {
  assert.equal((await call('GET', `/deals/${deal1}`, null, C.agent)).status, 404);
  assert.equal((await call('GET', `/deals/${deal1}`, null, C.owner)).status, 404);
  assert.equal((await accept(C, deal1).catch(() => ({status: 404}))).status, 404);
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('PUT', '/owner/mandate', {approve_above: 999}, A.agent)).status, 404, 'an agent token cannot change its own mandate');
  assert.equal((await call('POST', `/deals/${deal1}/accept`, {terms_hash: 'x', signature: 'y'}, A.owner)).status, 404, 'an owner token cannot sign deal acts');
  const me = ok(await call('GET', '/me', null, A.agent));
  assert.equal(me.role, 'agent');
  assert.equal(me.participant.id, A.id);
});

test('altered terms and claimed hash mismatches are refused', async () => {
  const t = terms(A, A, B, 10), h = termsHash(t), sig = await sign(A, statements.propose(h));
  const altered = {...t, price: {amount: 99, unit: 'PC'}};
  assert.equal((await call('POST', '/deals', {terms: altered, signature: sig}, A.agent)).body.error, 'bad_signature');
  assert.equal((await call('POST', '/deals', {terms: t, terms_hash: 'f'.repeat(64), signature: sig}, A.agent)).body.error, 'hash_mismatch');
  assert.equal((await call('POST', '/deals', {terms: {...t, network: 'other'}, signature: sig}, A.agent)).body.error, 'invalid_terms');
  assert.equal((await call('POST', '/deals', {terms: {...t, payee: {id: B.id, pubkey: C.pubkey}}, signature: sig}, A.agent)).body.error, 'invalid_terms', 'a party must be named with its registered key');
  const forged = await sign(B, statements.propose(h));
  assert.equal((await call('POST', '/deals', {terms: t, signature: forged}, A.agent)).body.error, 'bad_signature', 'signature must be the caller\'s own key');
});

test('replay and duplicate acceptance are refused', async () => {
  const t1 = terms(A, A, B, 5), d1 = ok(await propose(A, t1), 201);
  const t2 = terms(A, A, B, 5), d2 = ok(await propose(A, t2), 201);
  const h1 = d1.current.terms_hash, sig1 = await sign(B, statements.accept(h1));
  ok(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: sig1}, B.agent));
  assert.equal((await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: sig1}, B.agent)).status, 409, 'duplicate acceptance');
  const replay = await call('POST', `/deals/${d2.id}/accept`, {terms_hash: h1, signature: sig1}, B.agent);
  assert.equal(replay.body.error, 'stale_terms', 'an acceptance of one deal cannot be replayed onto another');
  const h2 = d2.current.terms_hash;
  assert.equal((await call('POST', `/deals/${d2.id}/accept`, {terms_hash: h2, signature: sig1}, B.agent)).body.error, 'bad_signature');
  assert.equal((await accept(A, d2.id)).body.error, 'own_offer');
});

test('mandate limits are enforced by the server (hard limit) and approvals gate commitments', async () => {
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 30}, A.owner));
  const big = await propose(A, terms(A, A, B, 31));
  assert.equal(big.status, 403);
  assert.equal(big.body.error, 'mandate_exceeded');
  assert.equal(big.body.rule, 'max_issue_per_deal');
  ok(await call('PUT', '/owner/mandate', {max_accept_per_issuer: 30}, B.owner));       // B already holds 20 (+5 agreed) from A
  const t = terms(A, A, B, 10), d = ok(await propose(A, t), 201);
  const r = await accept(B, d.id);
  assert.equal(r.body.error, 'mandate_exceeded');
  assert.equal(r.body.rule, 'max_accept_per_issuer');
  ok(await call('PUT', '/owner/mandate', {counterparties: [A.id], max_accept_per_issuer: 1000}, C.owner));
  assert.equal((await propose(C, terms(C, B, C, 5))).body.rule, 'counterparties');
});

test('an owner-set price floor is enforced, not just suggested', async () => {
  ok(await call('PUT', '/owner/mandate', {min_price_as_payee: 30}, C.owner));
  ok(await call('PUT', '/owner/mandate', {counterparties: 'any', max_issue_per_deal: 50}, A.owner));
  const d = ok(await propose(A, terms(A, A, C, 25)), 201);
  const r = await accept(C, d.id);
  assert.equal(r.body.error, 'mandate_exceeded');
  assert.equal(r.body.rule, 'min_price_as_payee');
  assert.equal(ok(await call('GET', `/deals/${d.id}`, null, C.agent)).status, 'open', 'nothing recorded; the agent can still counter or decline');
  const own = await propose(C, terms(C, A, C, 20));
  assert.equal(own.body.rule, 'min_price_as_payee', 'a payee cannot offer below its own floor either');
  ok(await call('PUT', '/owner/mandate', {min_price_as_payee: 0}, C.owner));
});

test('owner approval: proposal waits, counterparty cannot see it; owner reject and approve paths', async () => {
  ok(await call('PUT', '/owner/mandate', {approve_above: 0, max_issue_per_deal: 50, max_issue_outstanding: 500}, A.owner));
  const d = ok(await propose(A, terms(A, A, C, 7)), 201);
  assert.equal(d.status, 'proposed_awaiting_owner');
  assert.equal((await call('GET', `/deals/${d.id}`, null, C.agent)).status, 404, 'the counterparty does not see an offer the owner has not approved');
  assert.equal((await accept(C, d.id).catch(() => ({status: 404}))).status, 404);
  const appr = ok(await call('GET', '/owner', null, A.owner)).approvals.find(a => a.deal_id === d.id);
  const rej = ok(await call('POST', `/owner/approvals/${appr.id}`, {decision: 'reject', note: 'too cheap'}, A.owner));
  assert.equal(rej.deal.status, 'rejected_by_owner');
  const d2 = ok(await propose(A, terms(A, A, C, 8)), 201);
  const appr2 = ok(await call('GET', '/owner', null, A.owner)).approvals.find(a => a.deal_id === d2.id);
  assert.equal((await call('POST', `/owner/approvals/${appr2.id}`, {decision: 'approve'}, B.owner)).status, 404, 'another owner cannot decide');
  const ap = ok(await call('POST', `/owner/approvals/${appr2.id}`, {decision: 'approve'}, A.owner));
  assert.equal(ap.deal.status, 'open');
  assert.equal(ok(await accept(C, d2.id)).status, 'agreed');
});

test('counter-offer then decline; withdraw; expiry', async () => {
  ok(await call('PUT', '/owner/mandate', {approve_above: 1000}, A.owner));
  const d = ok(await propose(A, terms(A, A, C, 6)), 201);
  const cur = ok(await call('GET', `/deals/${d.id}`, null, C.agent)).current;
  const t2 = {...cur.terms, version: 2, prior_terms_hash: cur.terms_hash, nonce: crypto.randomBytes(16).toString('hex'), proposer: C.id, price: {amount: 9, unit: 'PC'}};
  const h2 = termsHash(t2);
  const c = ok(await call('POST', `/deals/${d.id}/counter`, {terms: t2, terms_hash: h2, signature: await sign(C, statements.propose(h2))}, C.agent));
  assert.equal(c.current.version, 2);
  assert.deepEqual(c.versions.map(v => v.state), ['countered', 'open']);
  const reason = '9 PC is above my budget';
  const dec = ok(await call('POST', `/deals/${d.id}/decline`, {terms_hash: h2, reason, signature: await sign(A, statements.decline(h2, reason))}, A.agent));
  assert.equal(dec.status, 'declined');
  assert.equal(dec.decline.reason, reason);
  const w = ok(await propose(A, terms(A, A, C, 4)), 201);
  const wh = w.current.terms_hash;
  assert.equal(ok(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: wh, signature: await sign(A, statements.withdraw(wh))}, A.agent)).status, 'withdrawn');
  const e = ok(await propose(A, terms(A, A, C, 3)), 201);
  clockOffset = 25 * 3600e3;
  assert.equal((await accept(C, e.id).catch(() => ({status: 409}))).status, 409);
  assert.equal(ok(await call('GET', `/deals/${e.id}`, null, A.agent)).status, 'expired');
  clockOffset = 0;
});

test('credit note: wrong total refused; dispute instead of issuing; nothing reaches the tracker', async () => {
  const d = ok(await propose(B, terms(B, C, B, 5)), 201);          // B (payee) proposes to C (payer)
  ok(await call('PUT', '/owner/mandate', {counterparties: 'any'}, C.owner));
  ok(await accept(C, d.id));
  ok(await deliver(B, d.id, 'deliverable v1'));
  const bad = await complete(C, d.id, {mutateTotal: 1});
  assert.equal(bad.body.error, 'stale_note');
  const deal = ok(await call('GET', `/deals/${d.id}`, null, C.agent));
  const reason = 'sources were not cited';
  const dis = ok(await call('POST', `/deals/${d.id}/dispute`, {terms_hash: deal.agreement.terms_hash, deliverable_sha256: deal.delivery.sha256, reason,
    signature: await sign(C, statements.dispute(deal.agreement.terms_hash, deal.delivery.sha256, reason))}, C.agent));
  assert.equal(dis.status, 'disputed');
  assert.match(dis.labels.basis, /no credit note for this deal is in the Basis tracker/);
  assert.equal(await basis.note(C.pubkey, B.pubkey), null);
});

test('interrupted credit-note issuance: recover() adopts a note the tracker already holds', async () => {
  const d = ok(await propose(A, terms(A, A, C, 2)), 201);
  ok(await accept(C, d.id));
  ok(await deliver(C, d.id, 'done'));
  const orig = basis.api;
  basis.api = async (m, p, b) => { const r = await orig.call(basis, m, p, b); if (m === 'POST' && p === '/notes') { basis.api = orig; throw new Error('simulated crash'); } return r; };
  const r = await complete(A, d.id);
  assert.equal(r.status, 502);
  assert.equal(pilot.s.deals[d.id].status, 'issuing_note', 'the decision was saved before the tracker call');
  assert.deepEqual(await pilot.recover(), ['note_issued']);
  const after = ok(await call('GET', `/deals/${d.id}`, null, A.agent));
  assert.equal(after.credit_note.tracker_status, 'already held (recovered)');
  assert.deepEqual([...new Set(ok(await call('GET', '/ledger')).reconciliation.map(x => x.status))], ['match']);
});

test('a note submitted around Valun is flagged by reconciliation', async () => {
  const cur = await basis.note(B.pubkey, A.pubkey);
  const ts = ordinaryTimestamp(Date.now() - 1000), total = Number(cur?.amount_collected ?? 0) + 3;
  const {message_hex} = await basis.noteMessage({issuer: B.pubkey, recipient: A.pubkey, total, timestamp: ts});
  const sig = await basis.signHex(B.pubkey, message_hex, B.secret);
  const r = await basis.api('POST', '/notes', {issuer_pubkey: B.pubkey, recipient_pubkey: A.pubkey, amount: total, timestamp: ts, signature: sig, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION});
  assert.equal(r.status, 201, 'the tracker records a note nobody accepted in Valun');
  const row = ok(await call('GET', '/ledger')).reconciliation.find(x => x.issuer === 'ben' && x.recipient === 'ana');
  assert.equal(row.status, 'tracker-has-debt-not-agreed-in-valun');
});

test('review_deliveries: the owner approves or rejects issuing each credit note; nothing reaches the tracker before approval', async () => {
  ok(await call('PUT', '/owner/mandate', {review_deliveries: true, approve_above: 1000}, A.owner));
  const before = Number((await basis.note(A.pubkey, C.pubkey))?.amount_collected ?? 0);
  const run = async price => { const d = ok(await propose(A, terms(A, A, C, price)), 201); ok(await accept(C, d.id)); ok(await deliver(C, d.id, `work ${price}`)); return d.id; };
  const id1 = await run(3);
  const held = ok(await complete(A, id1));
  assert.equal(held.status, 'completion_awaiting_owner');
  assert.equal(held.credit_note.state, 'signed');
  assert.equal(Number((await basis.note(A.pubkey, C.pubkey))?.amount_collected ?? 0), before, 'the signed note is held, not submitted');
  const appr = ok(await call('GET', '/owner', null, A.owner)).approvals.find(a => a.deal_id === id1 && a.state === 'pending');
  assert.equal(appr.kind, 'issue_note');
  const done = ok(await call('POST', `/owner/approvals/${appr.id}`, {decision: 'approve', note: 'brief looks fine'}, A.owner));
  assert.equal(done.deal.status, 'note_issued');
  assert.equal(Number((await basis.note(A.pubkey, C.pubkey)).amount_collected), before + 3);
  const id2 = await run(4);
  ok(await complete(A, id2));
  const appr2 = ok(await call('GET', '/owner', null, A.owner)).approvals.find(a => a.deal_id === id2 && a.state === 'pending');
  const rej = ok(await call('POST', `/owner/approvals/${appr2.id}`, {decision: 'reject', note: 'not good enough'}, A.owner));
  assert.equal(rej.deal.status, 'delivered', 'after a rejected review the payer can dispute or try again');
  assert.equal(rej.deal.credit_note, null);
  assert.equal(Number((await basis.note(A.pubkey, C.pubkey)).amount_collected), before + 3, 'rejected: no credit note issued');
  ok(await call('PUT', '/owner/mandate', {review_deliveries: false}, A.owner));
});

test('revoking the agent invalidates its token and key', async () => {
  const r = ok(await call('POST', '/owner/revoke-agent', null, C.owner));
  assert.match(r.enrollment_code, /^vpe_/);
  assert.equal((await call('GET', '/me', null, C.agent)).status, 401);
  assert.equal(ok(await call('GET', `/participants/${C.id}`)).status, 'awaiting_agent');
});

// ---------------------------------------------------------------------------------------------------------------
// Owner approvals show exactly what is approved; the other side never sees what was not offered to it.
async function counterOf(P, id, price) {
  const cur = ok(await call('GET', `/deals/${id}`, null, P.agent)).current;
  const t = {...cur.terms, version: cur.version + 1, prior_terms_hash: cur.terms_hash, nonce: crypto.randomBytes(16).toString('hex'), proposer: P.id, price: {amount: price, unit: 'PC'}};
  const h = termsHash(t);
  return {t, r: await call('POST', `/deals/${id}/counter`, {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent)};
}
const pendingFor = async (P, dealId) => ok(await call('GET', '/owner', null, P.owner)).approvals.find(a => a.deal_id === dealId && a.state === 'pending');

test('an owner approval carries the exact terms, the agent signature, the mandate check and the effect', async () => {
  const O = await newParticipant('oli', {approve_above: 0}), Q = await newParticipant('quin');
  const t = terms(O, O, Q, 6), d = ok(await propose(O, t), 201);
  const ap = await pendingFor(O, d.id);
  assert.deepEqual(ap.subject.terms, t);
  assert.equal(ap.subject.terms_hash, termsHash(t));
  assert.equal(ap.subject.statement, statements.propose(termsHash(t)));
  assert.equal(ap.subject.signer_pubkey, O.pubkey);
  assert.ok(await basis.verify(O.pubkey, hex(ap.subject.statement), ap.subject.signature), 'the owner can check the agent signature itself');
  assert.equal(ap.mandate_check.checks[0].rule, 'max_issue_outstanding');
  assert.match(ap.effect.if_rejected, /never sees it/);
  // a counter-offer waiting for the owner: its full terms are in the approval and in the author's own view
  const q = ok(await propose(Q, terms(Q, O, Q, 9)), 201);                  // Q (payee) offers; O would pay
  const {t: t2, r} = await counterOf(O, q.id, 7);
  assert.deepEqual(ok(r).pending_counter.terms, t2);
  const ap2 = await pendingFor(O, q.id);
  assert.equal(ap2.subject.what, 'counter_offer');
  assert.deepEqual(ap2.subject.terms, t2);
  assert.equal(ap2.subject.countered.terms_hash, q.current.terms_hash);
  assert.ok(await basis.verify(O.pubkey, hex(ap2.subject.statement), ap2.subject.signature));
  // the counterparty sees neither the unapproved proposal nor the held counter-offer, nor any event about them
  assert.equal((await call('GET', `/deals/${d.id}`, null, Q.agent)).status, 404);
  assert.ok(!ok(await call('GET', '/deals', null, Q.agent)).some(x => x.id === d.id));
  const qv = ok(await call('GET', `/deals/${q.id}`, null, Q.agent));
  assert.equal(qv.pending_counter, null);
  assert.deepEqual(qv.versions.map(v => v.version), [1]);
  assert.ok(!qv.history.some(h => h.event === 'countered'));
  // rejected with notes: still invisible to Q, and the notes stay on O's side
  ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'reject', note: 'secret-note-1'}, O.owner));
  ok(await call('POST', `/owner/approvals/${ap2.id}`, {decision: 'reject', note: 'secret-note-2'}, O.owner));
  assert.equal((await call('GET', `/deals/${d.id}`, null, Q.agent)).status, 404);
  const qv2 = ok(await call('GET', `/deals/${q.id}`, null, Q.agent));
  assert.equal(qv2.status, 'open');
  assert.ok(!qv2.history.some(h => ['countered', 'owner_rejected'].includes(h.event)));
  const qAll = JSON.stringify([qv2, ok(await call('GET', '/inbox', null, Q.agent)), ok(await call('GET', '/owner', null, Q.owner))]);
  assert.ok(!qAll.includes('secret-note') && !qAll.includes(d.id), 'no trace of the rejected proposal or the notes on Q\'s side');
  assert.equal(ok(await call('GET', `/participants/${Q.id}`)).public_position.deals.expired_or_withdrawn, 0, 'a deal Q never saw is not in its counts');
  const rej2 = ok(await call('GET', '/owner', null, O.owner)).approvals.find(a => a.id === ap2.id);
  assert.equal(rej2.state, 'rejected'); assert.equal(rej2.note, 'secret-note-2'); assert.deepEqual(rej2.subject.terms, t2, 'the decided approval keeps what was rejected');
  // approved: Q sees the counter-offer as offered, with the owner approval but without the note
  ok((await counterOf(O, q.id, 8)).r);
  const ap3 = await pendingFor(O, q.id);
  ok(await call('POST', `/owner/approvals/${ap3.id}`, {decision: 'approve', note: 'secret-note-3'}, O.owner));
  const qv3 = ok(await call('GET', `/deals/${q.id}`, null, Q.agent));
  assert.equal(qv3.current.version, 2); assert.equal(qv3.current.terms.price.amount, 8); assert.ok(qv3.current.offered_at);
  assert.ok(qv3.history.some(h => h.event === 'owner_approved' && h.offered));
  assert.ok(!JSON.stringify(qv3).includes('secret-note'));
  const ev = ok(await accept(Q, q.id)).history.map(h => h.event);
  assert.ok(ev.indexOf('accepted') >= 0 && ev.indexOf('accepted') < ev.indexOf('agreed'), 'history: accepted, then agreed');
});

test('an acceptance waiting for its owner: no signature for the other side yet; history accepted, owner_approved, agreed', async () => {
  const R = await newParticipant('rae'), S = await newParticipant('sol', {approve_above: 0});
  const d = ok(await propose(R, terms(R, R, S, 5)), 201);
  assert.equal(ok(await accept(S, d.id)).status, 'accepted_awaiting_owner');
  const rv = ok(await call('GET', `/deals/${d.id}`, null, R.agent));
  assert.equal(rv.acceptance.state, 'awaiting_owner');
  assert.equal(rv.acceptance.signature, null, 'not final, so not handed to the proposer');
  const ap = await pendingFor(S, d.id);
  assert.equal(ap.subject.what, 'acceptance');
  assert.equal(ap.subject.offered_by, R.id);
  assert.ok(await basis.verify(S.pubkey, hex(ap.subject.statement), ap.subject.signature));
  assert.ok(await basis.verify(R.pubkey, hex(statements.propose(ap.subject.terms_hash)), ap.subject.offer_signature));
  assert.match(ap.effect.if_approved, /binding/);
  ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, S.owner));
  const rv2 = ok(await call('GET', `/deals/${d.id}`, null, R.agent));
  assert.equal(rv2.status, 'agreed');
  assert.match(rv2.acceptance.signature, /^[0-9a-f]{130}$/);
  const ev = rv2.history.map(h => h.event);
  assert.ok(ev.indexOf('accepted') < ev.indexOf('owner_approved') && ev.indexOf('owner_approved') < ev.indexOf('agreed'), ev.join());
});

test("acceptance re-checks the proposer's mandate (owner tightened it after the offer)", async () => {
  const R = await newParticipant('rex'), S = await newParticipant('sam');
  const d = ok(await propose(R, terms(R, R, S, 8)), 201);
  ok(await call('PUT', '/owner/mandate', {may_issue_credit: false}, R.owner));
  const r = await accept(S, d.id);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'offer_not_authorized');
  assert.ok(!('rule' in r.body) && !/may_issue_credit/.test(r.body.message), "the proposer's mandate details stay private");
  assert.equal(ok(await call('GET', `/deals/${d.id}`, null, S.agent)).status, 'open', 'nothing recorded');
  ok(await call('PUT', '/owner/mandate', {may_issue_credit: true, max_issue_per_deal: 7}, R.owner));
  assert.equal((await accept(S, d.id)).body.error, 'offer_not_authorized', 'a lowered per-deal limit also stops it');
  // the same check when the acceptor's owner approves later
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 100}, R.owner));
  ok(await call('PUT', '/owner/mandate', {approve_above: 0}, S.owner));
  assert.equal(ok(await accept(S, d.id)).status, 'accepted_awaiting_owner');
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 7}, R.owner));
  const ap = await pendingFor(S, d.id);
  const no = await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, S.owner);
  assert.equal(no.body.error, 'offer_not_authorized');
  assert.equal((await pendingFor(S, d.id))?.id, ap.id, 'the approval stays pending, the deal unchanged');
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 100}, R.owner));
  assert.equal(ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, S.owner)).deal.status, 'agreed');
});

test('a credit note held for the payer owner is withheld from the payee until the tracker records it', async () => {
  const R = await newParticipant('ria', {review_deliveries: true}), S = await newParticipant('sky');
  const d = ok(await propose(R, terms(R, R, S, 4)), 201);
  ok(await accept(S, d.id)); ok(await deliver(S, d.id, 'the work'));
  assert.equal(ok(await complete(R, d.id)).status, 'completion_awaiting_owner');
  const sv = ok(await call('GET', `/deals/${d.id}`, null, S.agent));
  assert.equal(sv.credit_note.note.signature, null);
  assert.ok(sv.credit_note.signature_withheld && !('approval_id' in sv.credit_note) && !('completion' in sv.credit_note));
  assert.match(ok(await call('GET', `/deals/${d.id}`, null, R.agent)).credit_note.note.signature, /^[0-9a-f]{130}$/);
  const ap = await pendingFor(R, d.id);
  assert.equal(ap.subject.what, 'credit_note');
  assert.equal(ap.subject.credit_note.total, 4);
  assert.equal(ap.subject.delivery.content, 'the work');
  const {message_hex} = await basis.noteMessage({issuer: R.pubkey, recipient: S.pubkey, total: 4, timestamp: ap.subject.credit_note.timestamp});
  assert.equal(ap.subject.credit_note.message_hex, message_hex);
  assert.ok(await basis.verify(R.pubkey, message_hex, ap.subject.credit_note.signature), 'the owner can check the Basis note signature itself');
  ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, R.owner));
  assert.match(ok(await call('GET', `/deals/${d.id}`, null, S.agent)).credit_note.note.signature, /^[0-9a-f]{130}$/, 'recorded: now shown');
});

async function reenroll(P, code) {
  const key = await basis.keygen();
  const sig = await basis.signHex(key.pubkey_hex, hex(statements.enroll(P.id, key.pubkey_hex, sha(code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: P.id, code, pubkey: key.pubkey_hex, signature: sig}), 201);
  Object.assign(P, {pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token});
}

test('revoking an agent: unagreed deals are cancelled, a held note is voided, old keys stay linked, agreed deals continue with the new key', async () => {
  const U = await newParticipant('uma'), V = await newParticipant('vic');
  const flow = async price => { const d = ok(await propose(U, terms(U, U, V, price)), 201); ok(await accept(V, d.id)); return d.id; };
  const issued = await flow(3); ok(await deliver(V, issued, 'first work')); assert.equal(ok(await complete(U, issued)).status, 'note_issued');
  const agreed = await flow(6); ok(await deliver(V, agreed, 'second work'));
  const agreed2 = await flow(2);                                           // V delivers after V's own key changes
  ok(await call('PUT', '/owner/mandate', {review_deliveries: true}, U.owner));
  const held = await flow(5); ok(await deliver(V, held, 'third work'));
  assert.equal(ok(await complete(U, held)).status, 'completion_awaiting_owner');
  const byU = ok(await propose(U, terms(U, U, V, 4)), 201).id;
  const byV = ok(await propose(V, terms(V, U, V, 4)), 201).id;
  ok(await call('GET', '/me', null, U.agent));
  assert.ok(ok(await call('GET', '/owner', null, U.owner)).agent.last_seen);

  const rv = ok(await call('POST', '/owner/revoke-agent', null, U.owner));
  assert.deepEqual(rv.cancelled_deals.sort(), [byU, byV].sort());
  assert.deepEqual(rv.voided_credit_notes, [held]);
  assert.equal(rv.revoked_pubkey, U.pubkey);
  assert.equal((await call('POST', '/owner/revoke-agent', null, U.owner)).body.error, 'no_agent', 'nothing to revoke');
  for (const id of [byU, byV]) {
    const vv = ok(await call('GET', `/deals/${id}`, null, V.agent));
    assert.equal(vv.status, 'cancelled'); assert.equal(vv.cancellation.reason, 'agent_key_revoked'); assert.deepEqual(vv.next_actions, []);
  }
  const hv = ok(await call('GET', `/deals/${held}`, null, V.agent));
  assert.equal(hv.status, 'delivered'); assert.equal(hv.credit_note, null);
  const ow = ok(await call('GET', '/owner', null, U.owner));
  assert.equal(ow.agent.last_seen, null, 'last seen is reset with the key');
  assert.equal(ow.past_keys.at(-1).pubkey, U.pubkey);
  assert.equal(ow.approvals.find(a => a.deal_id === held).state, 'void_key_revoked');
  // the old key's tracker note still belongs to U
  const row = ok(await call('GET', '/ledger')).notes.find(n => n.issuer_pubkey === U.pubkey && n.recipient_pubkey === V.pubkey);
  assert.equal(row.issuer_handle, 'uma');
  // a revoked key can never be enrolled again
  const reuse = await call('POST', '/enroll', {participant_id: U.id, code: rv.enrollment_code, pubkey: U.pubkey,
    signature: await basis.signHex(U.pubkey, hex(statements.enroll(U.id, U.pubkey, sha(rv.enrollment_code))), U.secret)});
  assert.equal(reuse.body.error, 'key_in_use');
  await reenroll(U, rv.enrollment_code);
  assert.equal(ok(await call('GET', '/owner', null, U.owner)).agent.last_seen, null, 'the new agent has not been seen yet');

  // the agreed deal continues: the new key signs a credit note under a new key pair
  ok(await call('PUT', '/owner/mandate', {review_deliveries: false}, U.owner));
  const tpl = ok(await call('GET', `/deals/${agreed}/credit-note-template`, null, U.agent));
  assert.equal(tpl.issuer_pubkey, U.pubkey); assert.equal(tpl.keys_as_agreed, false); assert.equal(tpl.prior_total, 0);
  const done = ok(await complete(U, agreed));
  assert.equal(done.status, 'note_issued');
  assert.equal(done.credit_note.issuer_pubkey, U.pubkey);
  assert.equal(Number((await basis.note(U.pubkey, V.pubkey)).amount_collected), 6);
  assert.equal(ok(await complete(U, held)).status, 'note_issued', 'the voided one is accepted again with the new key');
  // the payee's key changes too: delivery and credit note use V's current key
  const vr = ok(await call('POST', '/owner/revoke-agent', null, V.owner));
  await reenroll(V, vr.enrollment_code);
  ok(await deliver(V, agreed2, 'fourth work, signed by the new key'));
  const tpl2 = ok(await call('GET', `/deals/${agreed2}/credit-note-template`, null, U.agent));
  assert.equal(tpl2.recipient_pubkey, V.pubkey);
  assert.equal(ok(await complete(U, agreed2)).status, 'note_issued');
  // three key pairs, all U's and V's, each matching Valun's records
  const led = ok(await call('GET', '/ledger'));
  const pairs = led.notes.filter(n => n.issuer_handle === 'uma' && n.recipient_handle === 'vic');
  assert.equal(pairs.length, 3);
  assert.equal(pairs.reduce((a, n) => a + n.total, 0), 3 + 6 + 5 + 2);
  assert.ok(led.reconciliation.filter(x => x.issuer === 'uma').every(x => x.status === 'match'), JSON.stringify(led.reconciliation));
  assert.equal(ok(await call('GET', `/participants/${U.id}`)).public_position.owes, 16);
});

test('state from earlier pilot versions is migrated: payment -> credit note, one revoked key -> key list, offered_at', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-pilot-legacy-'));
  const v1 = {v: 1, by: 'vp_aaaaaaaaaaaa', state: 'accepted', created_at: '2026-11-01T00:00:00.000Z',
    terms: {price: {amount: 5, unit: 'PC'}, payer: {id: 'vp_aaaaaaaaaaaa', pubkey: '03' + 'cd'.repeat(32)}}};      // a key the old code lost
  const v2 = {v: 1, by: 'vp_aaaaaaaaaaaa', state: 'rejected_by_owner', approval_id: 'va_000000000000', created_at: '2026-11-01T00:00:00.000Z', terms: {price: {amount: 5, unit: 'PC'}}};
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify({version: 1, participants: {
    vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', pubkey: null, pubkey_revoked: '02' + 'ab'.repeat(32)}},
    deals: {vd_1: {id: 'vd_1', status: 'paid', versions: [v1], agreement: {terms: {price: {amount: 5, unit: 'PC'}}}, payment: {state: 'recorded', prior_total: 0}},
      vd_2: {id: 'vd_2', status: 'rejected_by_owner', versions: [v2]}}, approvals: {}, invites: {}}));
  const pl = new Pilot({store: new PilotStore(dir), basis: {}});
  const s = pl.s;
  assert.deepEqual(s.participants.vp_aaaaaaaaaaaa.past_pubkeys.map(k => k.pubkey), ['02' + 'ab'.repeat(32), '03' + 'cd'.repeat(32)]);
  assert.ok(!('pubkey_revoked' in s.participants.vp_aaaaaaaaaaaa));
  assert.equal(s.deals.vd_1.status, 'note_issued');
  assert.equal(s.deals.vd_1.credit_note.settled, false);
  assert.equal(s.deals.vd_1.credit_note.amount, 5);
  assert.ok(!('payment' in s.deals.vd_1));
  assert.equal(s.deals.vd_1.versions[0].offered_at, '2026-11-01T00:00:00.000Z');
  assert.equal(s.deals.vd_2.versions[0].offered_at, null, 'a proposal that waited for its owner and was rejected was never offered');
  assert.equal(pl.byPubkey('02' + 'ab'.repeat(32)).id, 'vp_aaaaaaaaaaaa');
  assert.equal(pl.byPubkey('03' + 'cd'.repeat(32)).id, 'vp_aaaaaaaaaaaa', 'a key named in signed terms is linked back to its participant');
  assert.match(s.participants.vp_aaaaaaaaaaaa.past_pubkeys[1].recovered_from, /vd_1/);
});

test("third party: C accepts B's own credit only when B's tracker claims cover it; A's note is not transferred", async () => {
  const A3 = await newParticipant('amy'), B3 = await newParticipant('bea'), C3 = await newParticipant('cal', {min_payer_coverage_pct: 100});
  // A pays B 22 for research: A's credit note to B
  const d1 = ok(await propose(A3, terms(A3, A3, B3, 22)), 201); ok(await accept(B3, d1.id)); ok(await deliver(B3, d1.id, 'research brief'));
  assert.equal(ok(await complete(A3, d1.id)).status, 'note_issued');
  // B offers C 30 for editing, in B's own credit: B's claims (22) cover 73% of 30, below C's owner's 100%
  const big = ok(await propose(B3, terms(B3, B3, C3, 30)), 201);
  const r = await accept(C3, big.id);
  assert.equal(r.body.error, 'mandate_exceeded'); assert.equal(r.body.rule, 'min_payer_coverage_pct');
  assert.match(r.body.message, /cover 73%/);
  assert.equal(ok(await call('GET', `/deals/${big.id}`, null, C3.agent)).status, 'open', 'nothing recorded');
  // B offers 15: covered 146%; C's owner approves the acceptance and sees the coverage check
  ok(await call('PUT', '/owner/mandate', {approve_above: 0}, C3.owner));
  const d2 = ok(await propose(B3, terms(B3, B3, C3, 15)), 201);
  assert.equal(ok(await accept(C3, d2.id)).status, 'accepted_awaiting_owner');
  const ap = await pendingFor(C3, d2.id);
  const cov = ap.mandate_check.checks.find(c => c.rule === 'min_payer_coverage_pct');
  assert.deepEqual([cov.payer_claims_on_tracker, cov.payer_owes_on_tracker, cov.this_deal, cov.coverage_pct, cov.limit], [22, 0, 15, 146, 100]);
  assert.equal(ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, C3.owner)).deal.status, 'agreed');
  ok(await deliver(C3, d2.id, 'edited brief'));
  assert.equal(ok(await complete(B3, d2.id)).status, 'note_issued');
  // the tracker: A owes B 22 and B owes C 15. There is no note from A to C: A's note was not transferred.
  assert.equal(Number((await basis.note(A3.pubkey, B3.pubkey)).amount_collected), 22);
  assert.equal(Number((await basis.note(B3.pubkey, C3.pubkey)).amount_collected), 15);
  assert.equal(await basis.note(A3.pubkey, C3.pubkey), null);
  const pos = ok(await call('GET', `/participants/${B3.id}`)).public_position;
  assert.deepEqual([pos.claims_held, pos.owes, pos.net], [22, 15, 7]);
  // with B now owing 15 against 22 of claims, a further 10 would be 88% covered: refused again
  const more = ok(await propose(B3, terms(B3, B3, C3, 10)), 201);
  assert.equal((await accept(C3, more.id)).body.rule, 'min_payer_coverage_pct');
});

test('limits an agent records from its owner (conversation) are enforced, and only within the owner mandate', async () => {
  const L = await newParticipant('lia'), M2 = await newParticipant('max');
  const me0 = ok(await call('GET', '/me', null, L.agent));
  assert.deepEqual(me0.agent_limits, {});
  assert.equal(me0.effective_limits.max_issue_per_deal, 100);
  // the agent records "never more than 20 PC per deal" and its owner's goals
  const r = ok(await call('PUT', '/limits', {max_issue_per_deal: 20, notes: 'Buy one research brief, 3 sources, at most 20 PC.'}, L.agent));
  assert.equal(r.effective_limits.max_issue_per_deal, 20);
  // it cannot raise anything above the owner's ceiling, or lower a floor below the owner's minimum
  const up = await call('PUT', '/limits', {max_issue_per_deal: 101}, L.agent);
  assert.equal(up.status, 403); assert.equal(up.body.error, 'above_owner_mandate');
  ok(await call('PUT', '/owner/mandate', {min_price_as_payee: 5}, L.owner));
  assert.equal((await call('PUT', '/limits', {min_price_as_payee: 4}, L.agent)).body.error, 'below_owner_mandate');
  // enforced at the action boundary, with the source of the limit named
  const big = await propose(L, terms(L, L, M2, 21));
  assert.equal(big.body.error, 'mandate_exceeded'); assert.equal(big.body.rule, 'max_issue_per_deal'); assert.equal(big.body.source, 'agent_limits');
  assert.match(big.body.message, /owner's instructions/);
  assert.equal(ok(await propose(L, terms(L, L, M2, 20)), 201).status, 'open');
  // the owner sees them; null clears one (back to the owner's value); the owner's ceiling still applies
  const o = ok(await call('GET', '/owner', null, L.owner));
  assert.equal(o.agent_limits.max_issue_per_deal, 20); assert.match(o.agent_limits.notes, /research brief/);
  ok(await call('PUT', '/limits', {max_issue_per_deal: null}, L.agent));
  assert.equal(ok(await call('GET', '/me', null, L.agent)).effective_limits.max_issue_per_deal, 100);
  assert.equal((await propose(L, terms(L, L, M2, 101))).body.source, 'owner_mandate');
});

test('operator actions at the owner\'s request: enrollment code and mandate, loopback + admin token only, shown to the owner', async () => {
  const inv = ok(await call('POST', '/admin/invites', {}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle: 'opa', operator: 'op test'}), 201);
  const adm = {'x-valun-admin': 'admin-secret'};
  assert.equal((await call('POST', `/admin/participants/${j.participant_id}/enrollment-code`, null, null, {'x-valun-admin': 'wrong'})).status, 404);
  assert.equal((await call('POST', `/admin/participants/${j.participant_id}/enrollment-code`, null, null, {...adm, 'fly-client-ip': '1.2.3.4'})).status, 404, 'never through the proxy');
  const c = ok(await call('POST', `/admin/participants/${j.participant_id}/enrollment-code`, null, null, adm));
  assert.match(c.enrollment_code, /^vpe_/);
  const key = await basis.keygen();
  const sig = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(c.enrollment_code))), key.secret_hex);
  ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: c.enrollment_code, pubkey: key.pubkey_hex, signature: sig}), 201);
  assert.equal((await call('POST', `/admin/participants/${j.participant_id}/enrollment-code`, null, null, adm)).body.error, 'already_enrolled');
  const md = ok(await call('PUT', `/admin/participants/${j.participant_id}/mandate`, {approve_above: 25, review_deliveries: false}, null, adm));
  assert.equal(md.changed_by, 'operator');
  const o = ok(await call('GET', '/owner', null, j.owner_token));
  assert.equal(o.mandate_changed_by, 'operator'); assert.equal(o.mandate.approve_above, 25);
  ok(await call('PUT', '/owner/mandate', {approve_above: 0}, j.owner_token));
  assert.equal(ok(await call('GET', '/owner', null, j.owner_token)).mandate_changed_by, 'owner', 'the owner can always change it back');
});
