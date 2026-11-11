// Adversarial tests for the pilot network (valun-pilot-1): each test tries to break one of the server's guarantees.
// Real HTTP server, in process, against a throwaway REAL Basis tracker on its own port (3062; test/pilot.test.mjs uses
// 3052) and its own temporary store. Participants sign with Basis's Rust signer standing in for their own clients.
//
// Convention:
//   - an ordinary test is a DEFENCE THAT HELD: it asserts the specific refusal (status + error code).
//   - a test named "FINDING Fn <severity>: ..." and marked {todo} asserts the SECURE behaviour. It fails today and
//     documents a weakness without failing the run; when the weakness is fixed it starts passing (node reports the
//     todo as passing) and the todo flag can be dropped. Details, impact and fixes: docs/ADVERSARIAL-FINDINGS.md.
// Run: node --test test/adversarial.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

const TRACKER_PORT = 3062, ADMIN = 'adversarial-admin-secret', ADM = {'x-valun-admin': ADMIN};
const H = 3600e3, DAY = 24 * H;
let tracker, server, base, basis, pilot, storeDir, clockOffset = 0;
const extraServers = [];
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const now = () => Date.now() + clockOffset;

async function listen(routes) {
  const s = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${s.address().port}`;
  return s;
}
const closeServer = s => { s.closeAllConnections?.(); s.close(); };

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-adversarial-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(storeDir), basis, now});
  server = await listen(createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)}));
  base = server.base;
});
after(async () => {
  for (const s of [server, ...extraServers]) if (s) closeServer(s);
  await tracker?.stop();
  if (storeDir) fs.rmSync(storeDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers
async function call(method, p, body, token, headers = {}, at = base) {
  const r = await fetch(at + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers},
    body: body === undefined || body === null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json, headers: r.headers};
}
async function raw(method, p, text, token, headers = {}, at = base) {
  const r = await fetch(at + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: text});
  const t = await r.text(); let json = null;
  try { json = JSON.parse(t); } catch { /* not JSON */ }
  return {status: r.status, body: json, headers: r.headers};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, status, code, what = '') => {
  assert.equal(r.status, status, `${what}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
  assert.equal(r.body?.error, code, `${what}: expected ${code}, got ${JSON.stringify(r.body)?.slice(0, 300)}`);
  return r.body;
};
const outcome = r => `${r.status} ${r.body?.error ?? r.body?.status ?? ''}`.trim();

// Participants: join with an admin-made invite, enroll a locally generated key (proof of possession), set a mandate.
const TEST_MANDATE = {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 5000, max_accept_per_deal: 100, max_accept_per_issuer: 5000};
async function join(handle, extra = {}) {
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  return ok(await call('POST', '/join', {invite: inv.code, handle, operator: `adversarial operator of ${handle}`, ...extra}), 201);
}
const pop = (id, code, key) => basis.signHex(key.pubkey_hex, hex(statements.enroll(id, key.pubkey_hex, sha(code))), key.secret_hex);
async function newParticipant(handle, mandate = {}) {
  const j = await join(handle);
  const key = await basis.keygen();
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: await pop(j.participant_id, j.enrollment_code, key)}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {...TEST_MANDATE, ...mandate}, P.owner));
  return P;
}
async function reenroll(P, code) {
  const key = await basis.keygen();
  const e = ok(await call('POST', '/enroll', {participant_id: P.id, code, pubkey: key.pubkey_hex, signature: await pop(P.id, code, key)}), 201);
  const old = {pubkey: P.pubkey, secret: P.secret, agent: P.agent};
  Object.assign(P, {pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token});
  return old;
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
async function propose(P, t, signer = P) { const h = termsHash(t); return call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(signer, statements.propose(h))}, P.agent); }
const view = async (P, id) => ok(await call('GET', `/deals/${id}`, null, P.agent));
async function accept(P, id, h = null) { h ??= (await view(P, id)).current.terms_hash; return call('POST', `/deals/${id}/accept`, {terms_hash: h, signature: await sign(P, statements.accept(h))}, P.agent); }
async function deliverWith(P, id, h, content) { const dh = sha(content); return call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(P, statements.deliver(h, dh))}, P.agent); }
async function deliver(P, id, content) { return deliverWith(P, id, (await view(P, id)).agreement.terms_hash, content); }
async function prepareComplete(P, id, {mutateTotal = 0, recipient = null, noteSigner = P, timestamp = null} = {}) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const total = tpl.total + mutateTotal, ts = timestamp ?? tpl.timestamp;
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: recipient ?? tpl.recipient_pubkey, total, timestamp: ts});
  const note = await basis.signHex(noteSigner.pubkey, message_hex, noteSigner.secret);
  return {tpl, body: {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: {total, timestamp: ts, signature: note}}};
}
async function complete(P, id, opts) { const {body} = await prepareComplete(P, id, opts); return call('POST', `/deals/${id}/complete`, body, P.agent); }
async function counterOf(P, id, price, extra = {}) {
  const cur = (await view(P, id)).current;
  const t = {...cur.terms, version: cur.version + 1, prior_terms_hash: cur.terms_hash, nonce: rnd(16), proposer: P.id, price: {amount: price, unit: 'PC'}, ...extra};
  const h = termsHash(t);
  return {t, h, r: await call('POST', `/deals/${id}/counter`, {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent)};
}
const approvalsFor = async (P, dealId) => ok(await call('GET', '/owner', null, P.owner)).approvals.filter(a => a.deal_id === dealId && a.state === 'pending');
const trackerTotal = async (X, Y) => Number((await basis.note(X.pubkey, Y.pubkey))?.amount_collected ?? 0);
// A deal taken to "delivered" between payer X and payee Y.
async function delivered(X, Y, price, content = `work for ${price}`) {
  const d = ok(await propose(X, terms(X, X, Y, price)), 201);
  assert.equal(ok(await accept(Y, d.id)).status, 'agreed', 'precondition: agreed');
  ok(await deliver(Y, d.id, content));
  return d.id;
}

let A, B, C;

// =================================================================================================================
// Authentication, roles, visibility
// =================================================================================================================
test('auth: missing, garbage, truncated, wrong-scheme and hash-as-token credentials get 401', async () => {
  A = await newParticipant('adv-ana'); B = await newParticipant('adv-ben'); C = await newParticipant('adv-cyd');
  refused(await call('GET', '/me'), 401, 'unauthorized', 'no token');
  refused(await call('GET', '/me', null, 'vpa_' + 'A'.repeat(43)), 401, 'unauthorized', 'garbage agent token');
  refused(await call('GET', '/me', null, 'vpo_' + 'A'.repeat(43)), 401, 'unauthorized', 'garbage owner token');
  refused(await call('GET', '/me', null, A.agent.slice(0, -1)), 401, 'unauthorized', 'truncated token');
  refused(await call('GET', '/me', null, A.agent + 'x'), 401, 'unauthorized', 'extended token');
  refused(await call('GET', '/me', null, null, {authorization: `Basic ${A.agent}`}), 401, 'unauthorized', 'wrong scheme');
  refused(await call('GET', '/me', null, null, {authorization: `Bearer ${A.agent} ${A.owner}`}), 401, 'unauthorized', 'two tokens');
  refused(await call('GET', '/me', null, sha(A.agent)), 401, 'unauthorized', 'the stored hash is not a credential');
  refused(await call('GET', '/me', null, null, {'x-valun-token': A.agent}), 401, 'unauthorized', 'the demo write-token header is not pilot auth');
  refused(await call('POST', '/deals', {}, 'vpa_'), 401, 'unauthorized', 'empty token body');
  assert.equal(ok(await call('GET', '/me', null, null, {authorization: `bearer   ${A.agent}`})).role, 'agent', 'scheme is case-insensitive (sanity)');
});

test('roles: an agent token cannot use owner routes; an owner token cannot sign deal acts or fetch note templates', async () => {
  const d = ok(await propose(A, terms(A, A, B, 3)), 201);
  for (const [m, p, b] of [['GET', '/owner'], ['PUT', '/owner/mandate', {approve_above: 99999}], ['POST', '/owner/revoke-agent'],
    ['POST', '/owner/enrollment-code'], ['POST', '/owner/approvals/va_000000000000', {decision: 'approve'}]])
    refused(await call(m, p, b, A.agent), 404, 'not_found', `agent token on ${m} ${p}`);
  assert.equal(ok(await call('GET', '/me', null, A.agent)).mandate.approve_above, 1000, 'mandate unchanged by the agent');
  const h = d.current.terms_hash;
  refused(await call('POST', '/deals', {terms: terms(B, A, B, 3), signature: '00'}, B.owner), 404, 'not_found', 'owner token proposing');
  for (const act of ['accept', 'decline', 'counter', 'withdraw', 'deliver', 'complete', 'dispute'])
    refused(await call('POST', `/deals/${d.id}/${act}`, {terms_hash: h, signature: await sign(B, statements.accept(h))}, B.owner), 404, 'not_found', `owner token on ${act}`);
  refused(await call('GET', `/deals/${d.id}/credit-note-template`, null, A.owner), 403, 'agent_only', 'owner token on template');
  assert.equal(ok(await call('GET', `/deals/${d.id}`, null, B.owner)).status, 'open', 'owners may read their own deals (sanity)');
});

test('visibility: a third party gets the same 404 on every route of a deal it is not party to as for a deal that does not exist', async () => {
  const d = ok(await propose(A, terms(A, A, B, 4)), 201), h = d.current.terms_hash, ghost = 'vd_' + rnd(8);
  const sig = await sign(C, statements.accept(h));
  for (const id of [d.id, ghost]) {
    refused(await call('GET', `/deals/${id}`, null, C.agent), 404, 'not_found', `C agent reads ${id}`);
    refused(await call('GET', `/deals/${id}`, null, C.owner), 404, 'not_found', `C owner reads ${id}`);
    refused(await call('GET', `/deals/${id}/credit-note-template`, null, C.agent), 404, 'not_found', 'C template');
    for (const act of ['accept', 'decline', 'counter', 'withdraw', 'deliver', 'complete', 'dispute'])
      refused(await call('POST', `/deals/${id}/${act}`, {terms_hash: h, signature: sig, terms: d.current.terms, content: 'x', reason: 'x'}, C.agent), 404, 'not_found', `C ${act} on ${id}`);
  }
  assert.ok(!ok(await call('GET', '/deals', null, C.agent)).some(x => x.id === d.id));
  assert.ok(!JSON.stringify(ok(await call('GET', '/inbox', null, C.agent))).includes(d.id));
  assert.ok(!JSON.stringify(ok(await call('GET', '/owner', null, C.owner))).includes(d.id));
  assert.equal((await view(B, d.id)).status, 'open', 'nothing changed for the parties');
});

test('visibility: owner objectives, agent-recorded goals, owner notes, never-offered proposals and credential hashes do not leak', async () => {
  const O = await newParticipant('adv-otto', {objective: 'SECRET-OBJECTIVE-7f3', approve_above: 0});
  ok(await call('PUT', '/limits', {notes: 'SECRET-AGENT-NOTES-9c1', max_issue_per_deal: 90}, O.agent));
  const never = ok(await propose(O, terms(O, O, B, 6, {service: {title: 'SECRET-TITLE-NEVER-OFFERED', description: 'x', deliverable: 'y'}})), 201);
  const [ap] = await approvalsFor(O, never.id);
  ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'reject', note: 'SECRET-OWNER-NOTE-2b8'}, O.owner));
  const offered = ok(await propose(O, terms(O, O, B, 7)), 201);
  const [ap2] = await approvalsFor(O, offered.id);
  ok(await call('POST', `/owner/approvals/${ap2.id}`, {decision: 'approve', note: 'SECRET-OWNER-NOTE-5d4'}, O.owner));
  const publicSeen = JSON.stringify([ok(await call('GET', '/participants')), ok(await call('GET', `/participants/${O.id}`)), ok(await call('GET', '/ledger')), ok(await call('GET', '/info'))]);
  const counterpartySeen = JSON.stringify([ok(await call('GET', '/deals', null, B.agent)), ok(await call('GET', '/inbox', null, B.agent)), ok(await call('GET', '/owner', null, B.owner)),
    await view(B, offered.id), ok(await call('GET', '/me', null, B.agent))]);
  for (const s of ['SECRET-OBJECTIVE', 'SECRET-AGENT-NOTES', 'SECRET-OWNER-NOTE', 'SECRET-TITLE-NEVER-OFFERED', never.id, 'owner_token_hash', 'agent_token_hash', 'code_hash'])
    for (const [where, seen] of [['public routes', publicSeen], ["the counterparty's routes", counterpartySeen]]) assert.ok(!seen.includes(s), `${s} visible on ${where}`);
  for (const s of ['"mandate"', 'agent_limits', 'approve_above', 'enrollment', 'past_pubkeys', 'invite_id', 'objective'])
    assert.ok(!publicSeen.includes(s), `${s} on a public route`);
  const dirEntry = ok(await call('GET', '/participants')).find(p => p.id === O.id);
  assert.deepEqual(Object.keys(dirEntry).sort(), ['about', 'agent_last_seen', 'display_name', 'handle', 'id', 'joined_at', 'operator', 'pubkey', 'services', 'status']);
  // the participant's own side does see them (sanity: the secrets exist)
  assert.match(JSON.stringify(ok(await call('GET', '/owner', null, O.owner))), /SECRET-OWNER-NOTE-2b8/);
});

// =================================================================================================================
// Invites, enrollment, admin
// =================================================================================================================
test('enrollment: wrong or foreign code, prototype ids, malformed keys, key reuse, code reuse and expiry are refused', async () => {
  const j = await join('adv-enrol'), other = await join('adv-enrol2');
  const k = await basis.keygen(), k2 = await basis.keygen();
  const body = async (id, code, key = k, signFor = id) => ({participant_id: id, code, pubkey: key.pubkey_hex, signature: await pop(signFor, code, key)});
  refused(await call('POST', '/enroll', await body(j.participant_id, 'vpe_wrong')), 403, 'invalid_enrollment', 'wrong code');
  refused(await call('POST', '/enroll', await body(j.participant_id, other.enrollment_code)), 403, 'invalid_enrollment', "another participant's code");
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null])
    refused(await call('POST', '/enroll', {participant_id: id, code: 'x', pubkey: k.pubkey_hex, signature: 'x'}), 403, 'invalid_enrollment', `participant_id ${id}`);
  for (const pk of [k.pubkey_hex.toUpperCase(), '04' + 'ab'.repeat(64), k.pubkey_hex.slice(0, -2), k.pubkey_hex + '00', '', 12345, {k: k.pubkey_hex}])
    refused(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk, signature: 'x'}), 400, 'invalid_field', `pubkey ${String(pk).slice(0, 12)}`);
  refused(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: A.pubkey, signature: 'x'}), 409, 'key_in_use', "another participant's key");
  refused(await call('POST', '/enroll', await body(j.participant_id, j.enrollment_code, k, other.participant_id)), 403, 'bad_signature', 'proof bound to another participant id');
  refused(await call('POST', '/enroll', {...(await body(j.participant_id, j.enrollment_code, k2)), pubkey: k.pubkey_hex}), 403, 'bad_signature', 'proof made with a different key');
  const e = ok(await call('POST', '/enroll', await body(j.participant_id, j.enrollment_code)), 201);
  assert.match(e.agent_token, /^vpa_/);
  refused(await call('POST', '/enroll', await body(j.participant_id, j.enrollment_code, k2)), 403, 'invalid_enrollment', 'code reuse');
  refused(await call('POST', '/enroll', await body(other.participant_id, other.enrollment_code, k)), 409, 'key_in_use', 'same key for a second participant');
  clockOffset = 31 * 60e3;
  try { refused(await call('POST', '/enroll', await body(other.participant_id, other.enrollment_code, k2)), 403, 'invalid_enrollment', 'expired code'); }
  finally { clockOffset = 0; }
  refused(await call('POST', '/join', {invite: 'vpi_x', handle: 'ADV-ENROL', operator: 'x'}), 403, 'invalid_invite', 'sanity: invite checked first');
  const inv = ok(await call('POST', '/admin/invites', {}, null, ADM), 201);
  refused(await call('POST', '/join', {invite: inv.code, handle: 'ADV-ENROL', operator: 'x'}), 409, 'handle_taken', 'handles are case-insensitive');
});

test('invites: max_uses is honoured, concurrent joins cannot overspend an invite, expired invites are refused', async () => {
  const two = ok(await call('POST', '/admin/invites', {max_uses: 2}, null, ADM), 201);
  ok(await call('POST', '/join', {invite: two.code, handle: 'adv-inv1', operator: 'x'}), 201);
  ok(await call('POST', '/join', {invite: two.code, handle: 'adv-inv2', operator: 'x'}), 201);
  refused(await call('POST', '/join', {invite: two.code, handle: 'adv-inv3', operator: 'x'}), 403, 'invalid_invite', 'third use of a 2-use invite');
  const one = ok(await call('POST', '/admin/invites', {}, null, ADM), 201);
  const rs = await Promise.all([0, 1, 2, 3, 4, 5].map(i => call('POST', '/join', {invite: one.code, handle: `adv-race${i}`, operator: 'x'})));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 403, 403, 403, 403, 403], 'exactly one concurrent join wins');
  const short = ok(await call('POST', '/admin/invites', {ttl_days: 1}, null, ADM), 201);
  clockOffset = 2 * DAY;
  try { refused(await call('POST', '/join', {invite: short.code, handle: 'adv-late', operator: 'x'}), 403, 'invalid_invite', 'expired invite'); }
  finally { clockOffset = 0; }
  const fresh = ok(await call('POST', '/admin/invites', {}, null, ADM), 201);
  for (const code of [fresh.code.toUpperCase(), fresh.code + ' ', fresh.code.slice(0, -1), {code: fresh.code}, null, 0])
    refused(await call('POST', '/join', {invite: code, handle: 'adv-variant', operator: 'x'}), 403, 'invalid_invite', `variant ${JSON.stringify(code)}`);
});

test('admin: no token, wrong token, proxy headers, participant tokens, or no configured admin token -> 404', async () => {
  refused(await call('POST', '/admin/invites', {}), 404, 'not_found', 'no admin token');
  refused(await call('POST', '/admin/invites', {}, null, {'x-valun-admin': 'wrong'}), 404, 'not_found', 'wrong admin token');
  refused(await call('POST', '/admin/invites', {}, null, {'x-valun-admin': sha(ADMIN)}), 404, 'not_found', 'the token hash is not the token');
  for (const h of ['x-forwarded-for', 'fly-client-ip', 'fly-forwarded-port'])
    refused(await call('POST', '/admin/invites', {}, null, {...ADM, [h]: '1.2.3.4'}), 404, 'not_found', `proxied via ${h}`);
  refused(await call('POST', '/admin/invites', {}, A.owner), 404, 'not_found', 'owner token');
  refused(await call('GET', '/admin/invites', null, A.agent), 404, 'not_found', 'agent token');
  refused(await call('PUT', `/admin/participants/${A.id}/mandate`, {approve_above: 99999}, A.agent), 404, 'not_found', 'agent token on admin mandate');
  const off = await listen(createPilotRoutes({pilot, cfg: {}, adminTokenHash: null})); extraServers.push(off);
  refused(await call('POST', '/admin/invites', {}, null, ADM, off.base), 404, 'not_found', 'admin disabled when no token is configured');
  refused(await call('POST', '/admin/invites', {}, null, {}, off.base), 404, 'not_found', 'admin disabled, no header');
  assert.ok(ok(await call('GET', '/admin/invites', null, null, ADM)).every(i => !('code_hash' in i) && !('code' in i)), 'listing never shows codes');
  refused(await call('PUT', '/admin/participants/vp_000000000000/mandate', {}, null, ADM), 404, 'not_found', 'unknown participant');
  refused(await call('POST', `/admin/participants/${A.id}/enrollment-code`, null, null, ADM), 409, 'already_enrolled', 'operator cannot replace a live key');
});

test('F8 fixed (was low): admin invite creation does not validate max_uses / ttl_days (a non-number makes an unlimited invite)', async () => {
  const got = [];
  const inv = await call('POST', '/admin/invites', {max_uses: 'many'}, null, ADM);
  got.push(`max_uses "many": ${outcome(inv)}`);
  if (inv.status === 201) for (let i = 0; i < 3; i++) got.push(`join ${i + 1}: ${outcome(await call('POST', '/join', {invite: inv.body.code, handle: `adv-many${i}`, operator: 'x'}))}`);
  got.push(`ttl_days "x": ${outcome(await call('POST', '/admin/invites', {ttl_days: 'x'}, null, ADM))}`);
  assert.deepEqual(got, ['max_uses "many": 400 invalid_field', 'ttl_days "x": 400 invalid_field'], 'admin input should be validated');
});

// =================================================================================================================
// Signatures
// =================================================================================================================
test('signatures: replay across deals, versions and statement kinds is refused', async () => {
  const t1 = terms(A, A, B, 5), d1 = ok(await propose(A, t1), 201), d2 = ok(await propose(A, terms(A, A, B, 5)), 201);
  const h1 = d1.current.terms_hash, h2 = d2.current.terms_hash, prop1 = d1.current.signature;
  const acc1 = await sign(B, statements.accept(h1));
  refused(await call('POST', `/deals/${d2.id}/accept`, {terms_hash: h2, signature: acc1}, B.agent), 403, 'bad_signature', 'acceptance of d1 replayed on d2');
  refused(await call('POST', `/deals/${d2.id}/accept`, {terms_hash: h1, signature: acc1}, B.agent), 409, 'stale_terms', 'acceptance of d1 with d1 hash on d2');
  refused(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: prop1}, B.agent), 403, 'bad_signature', "the proposer's own proposal signature as acceptance");
  refused(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: await sign(B, statements.propose(h1))}, B.agent), 403, 'bad_signature', 'propose/1 statement presented as accept/1');
  refused(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: await sign(B, `valun-pilot/accept/1\n${h1}\n`)}, B.agent), 403, 'bad_signature', 'trailing newline variant');
  refused(await call('POST', `/deals/${d1.id}/withdraw`, {terms_hash: h1, signature: prop1}, A.agent), 403, 'bad_signature', 'proposal signature reused as withdrawal');
  const dsig = await sign(B, statements.decline(h1, 'too expensive'));
  refused(await call('POST', `/deals/${d1.id}/decline`, {terms_hash: h1, reason: 'too cheap', signature: dsig}, B.agent), 403, 'bad_signature', 'decline signature with another reason');
  refused(await call('POST', `/deals/${d1.id}/decline`, {terms_hash: h1, reason: '', signature: acc1}, B.agent), 403, 'bad_signature', 'acceptance signature as decline');
  refused(await call('POST', '/deals', {terms: t1, terms_hash: h1, signature: prop1}, A.agent), 409, 'duplicate', 'proposal replayed verbatim');
  const moved = {...t1, deal_id: 'vd_' + rnd(8)};
  refused(await call('POST', '/deals', {terms: moved, signature: prop1}, A.agent), 403, 'bad_signature', 'proposal signature moved to a new deal id');
  refused(await call('POST', '/deals', {terms: {...t1, deal_id: 'vd_' + rnd(8)}, signature: prop1}, B.agent), 400, 'invalid_terms', "A's proposal submitted with B's token");
  const {t: c2} = await counterOf(B, d2.id, 7);
  const c2sig = (await view(A, d2.id)).current.signature;
  assert.equal(c2.version, 2);
  const forgedCounter = {...c2, price: {amount: 1, unit: 'PC'}, nonce: rnd(16)};
  refused(await call('POST', `/deals/${d1.id}/counter`, {terms: {...forgedCounter, deal_id: d1.id, prior_terms_hash: h1}, signature: c2sig}, B.agent), 403, 'bad_signature', 'counter signature from d2 replayed on d1');
  ok(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: acc1}, B.agent));
  refused(await call('POST', `/deals/${d1.id}/accept`, {terms_hash: h1, signature: acc1}, B.agent), 409, 'not_open', 'duplicate acceptance');
});

test('signatures: another participant\'s key, a revoked key and a rotated-out key cannot act; revoked tokens get 401', async () => {
  const K1 = await newParticipant('adv-rot-a'), K2 = await newParticipant('adv-rot-b');
  refused(await propose(K1, terms(K1, K1, K2, 3), K2), 403, 'bad_signature', "proposal signed with the counterparty's key");
  refused(await propose(K1, terms(K1, K1, K2, 3), A), 403, 'bad_signature', "proposal signed with a third party's key");
  const out = ok(await propose(K1, terms(K1, K1, K2, 3)), 201), inn = ok(await propose(K2, terms(K2, K1, K2, 3)), 201);
  const rv = ok(await call('POST', '/owner/revoke-agent', null, K1.owner));
  assert.deepEqual(rv.cancelled_deals.sort(), [out.id, inn.id].sort());
  const oldToken = K1.agent;
  refused(await call('GET', '/me', null, oldToken), 401, 'unauthorized', 'revoked agent token');
  refused(await accept(K2, out.id), 409, 'not_open', 'accepting an offer signed by the revoked key');
  refused(await propose(K2, terms(K2, K1, K2, 3)), 400, 'invalid_terms', 'terms naming a participant with no active key');
  const old = await reenroll(K1, rv.enrollment_code);
  refused(await call('GET', '/me', null, oldToken), 401, 'unauthorized', 'old token stays dead after re-enrollment');
  const t = terms(K1, K1, K2, 3), h = termsHash(t);
  refused(await call('POST', '/deals', {terms: t, signature: await basis.signHex(old.pubkey, hex(statements.propose(h)), old.secret)}, K1.agent), 403, 'bad_signature', 'new token, old key signature');
  refused(await propose(K1, {...t, payer: {id: K1.id, pubkey: old.pubkey}}), 400, 'invalid_terms', 'terms naming the rotated-out key');
  refused(await call('POST', '/enroll', {participant_id: K1.id, code: rv.enrollment_code, pubkey: (await basis.keygen()).pubkey_hex, signature: 'x'}), 403, 'invalid_enrollment', 'revocation code reused');
  refused(await call('POST', '/owner/enrollment-code', null, K1.owner), 409, 'already_enrolled', 'no second code while a key is live');
  const j = await join('adv-rot-c');
  refused(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: old.pubkey, signature: await basis.signHex(old.pubkey, hex(statements.enroll(j.participant_id, old.pubkey, sha(j.enrollment_code))), old.secret)}), 409, 'key_in_use', 'a revoked key enrolled by someone else');
});

test('signatures: empty, truncated, oversized, uppercase, non-string and wrong-length signatures are refused with 403', async () => {
  const d = ok(await propose(A, terms(A, A, B, 2)), 201), h = d.current.terms_hash, good = await sign(B, statements.accept(h));
  for (const [name, s] of [['empty', ''], ['missing', undefined], ['null', null], ['truncated', good.slice(0, 128)], ['one nibble short', good.slice(0, 129)],
    ['extended', good + '00'], ['uppercase', good.toUpperCase()], ['0x-prefixed', '0x' + good.slice(2)], ['number', 12345], ['two-element array', [good, good]], ['object', {sig: good}],
    ['with whitespace', ' ' + good], ['newline', good.slice(0, 129) + '\n']])
    refused(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: s}, B.agent), 403, 'bad_signature', name);
  assert.equal((await view(B, d.id)).status, 'open', 'nothing recorded');
});

test('F5 fixed (was low): zero, all-ff and non-hex signatures reach the signer unvalidated and crash the request (502 internal error, not 403)', async () => {
  const d = ok(await propose(A, terms(A, A, B, 2)), 201), h = d.current.terms_hash;
  const got = {};
  got.accept_zero = outcome(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: '00'.repeat(65)}, B.agent));
  got.accept_ff = outcome(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: 'ff'.repeat(65)}, B.agent));
  const j = await join('adv-badpop'), k = await basis.keygen();
  got.enroll_nonhex = outcome(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: k.pubkey_hex, signature: 'zz'}));
  const id = await delivered(A, B, 2);
  const {body} = await prepareComplete(A, id);
  got.note_nonhex = outcome(await call('POST', `/deals/${id}/complete`, {...body, credit_note: {...body.credit_note, signature: 'not-a-signature'}}, A.agent));
  got.note_zero = outcome(await call('POST', `/deals/${id}/complete`, {...body, credit_note: {...body.credit_note, signature: '00'.repeat(65)}}, A.agent));
  assert.equal((await view(A, id)).status, 'delivered', 'precondition: nothing was recorded');
  assert.deepEqual(got, {accept_zero: '403 bad_signature', accept_ff: '403 bad_signature', enroll_nonhex: '403 bad_signature', note_nonhex: '403 bad_signature', note_zero: '403 bad_signature'});
});

test('F12 fixed (was low): a one-element array passes the hex checks (pubkey, signatures) and is stored as an array; the same key can be registered twice', async () => {
  const X = await newParticipant('adv-dupkey');                 // key K registered as a string
  const j = await join('adv-dupkey2');                           // a second participant run by the same person, who holds K's secret
  const sig = await basis.signHex(X.pubkey, hex(statements.enroll(j.participant_id, X.pubkey, sha(j.enrollment_code))), X.secret);
  const r = await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: [X.pubkey], signature: sig});
  const stored = pilot.s.participants[j.participant_id].pubkey;
  const sameKey = ok(await call('GET', '/participants')).filter(p => String(p.pubkey) === X.pubkey).map(p => `${p.handle}:${Array.isArray(p.pubkey) ? 'array' : 'string'}`);
  // the same coercion on a deal-act signature
  const d = ok(await propose(A, terms(A, A, X, 2)), 201), h = d.current.terms_hash;
  const ra = await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: [await sign(X, statements.accept(h))]}, X.agent);
  const accSig = pilot.s.deals[d.id].acceptance?.signature;
  const facts = `enroll with [K]: ${outcome(r)}, stored pubkey ${Array.isArray(stored) ? 'array' : typeof stored}, directory entries with key K: ${sameKey.join(', ')}; ` +
    `accept with [signature]: ${outcome(ra)}, stored acceptance signature ${Array.isArray(accSig) ? 'array' : typeof accSig}`;
  assert.ok([400, 409].includes(r.status) && ra.status === 403, facts);
});

// =================================================================================================================
// Terms tampering and counter-offers
// =================================================================================================================
test('terms: fields changed after signing, claimed-hash mismatch, unknown or prototype keys, wrong parties/network/tracker are refused', async () => {
  const t = terms(A, A, B, 10), h = termsHash(t), sig = await sign(A, statements.propose(h));
  const send = (tt, extra = {}) => call('POST', '/deals', {terms: tt, signature: sig, ...extra}, A.agent);
  refused(await send({...t, offer_expires_at: new Date(now() + 23 * H).toISOString()}), 403, 'bad_signature', 'expiry changed after signing');
  refused(await send({...t, service: {...t.service, deliverable: 'nothing'}}), 403, 'bad_signature', 'deliverable changed after signing');
  refused(await send({...t, price: {amount: 11, unit: 'PC'}}, {terms_hash: h}), 400, 'hash_mismatch', 'claimed hash of the signed terms with altered terms');
  refused(await send({...t, extra: 1}), 400, 'invalid_terms', 'unknown field');
  const protoBody = JSON.stringify({terms: t, signature: sig}).replace('"terms":{', '"terms":{"__proto__":{"price":{"amount":1,"unit":"PC"}},');
  refused(await raw('POST', '/deals', protoBody, A.agent), 400, 'invalid_terms', '__proto__ key inside terms');
  refused(await send({...t, constructor: {prototype: {x: 1}}}), 400, 'invalid_terms', 'constructor key inside terms');
  const {nonce, ...noNonce} = t;
  refused(await send(noNonce), 400, 'invalid_terms', 'missing nonce');
  for (const [name, tt] of [
    ['payee named with C\'s key', {...t, payee: {id: B.id, pubkey: C.pubkey}}], ['unknown payer id', {...t, payer: {id: 'vp_000000000000', pubkey: A.pubkey}}],
    ['prototype payer id', {...t, payer: {id: '__proto__', pubkey: A.pubkey}}], ['payer with an extra key', {...t, payer: {id: A.id, pubkey: A.pubkey, role: 'x'}}],
    ['other tracker', {...t, tracker_nft_id: 'ab'.repeat(32)}], ['other denomination', {...t, denomination: 'erg'}], ['other network', {...t, network: 'valun-pilot-2'}],
    ['other protocol', {...t, protocol: 'valun-deal/2'}], ['other consideration', {...t, consideration: 'cash_on_delivery'}], ['proposer not the caller', {...t, proposer: B.id}],
    ['payer = payee', {...t, payee: {id: A.id, pubkey: A.pubkey}}], ['new deal at version 2', {...t, version: 2}], ['new deal with a prior hash', {...t, prior_terms_hash: 'ab'.repeat(32)}],
    ['bad deal id', {...t, deal_id: 'vd_XYZ'}], ['short nonce', {...t, nonce: 'ab'}], ['unit ERG', {...t, price: {amount: 10, unit: 'ERG'}}],
    ['price with extra key', {...t, price: {amount: 10, unit: 'PC', bonus: 5}}], ['service missing deliverable', {...t, service: {title: 'a', description: 'b'}}],
    ['terms as array', [t]], ['terms as string', JSON.stringify(t)]])
    refused(await send(tt), 400, 'invalid_terms', name);
  refused(await send({...t, service: {...t.service, title: ''}}), 400, 'invalid_field', 'empty title');
  refused(await send({...t, service: {...t.service, title: 42}}), 400, 'invalid_field', 'numeric title');
  const thirdParty = terms(C, A, B, 10);
  refused(await call('POST', '/deals', {terms: thirdParty, signature: await sign(C, statements.propose(termsHash(thirdParty)))}, C.agent), 400, 'invalid_terms', 'a non-party proposing between two others');
  // accept-side tampering
  const d = ok(await propose(A, t), 201);
  refused(await call('POST', `/deals/${d.id}/accept`, {signature: await sign(B, statements.accept(h))}, B.agent), 409, 'stale_terms', 'accept without terms_hash');
  refused(await call('POST', `/deals/${d.id}/accept`, {terms_hash: 'f'.repeat(64), signature: await sign(B, statements.accept('f'.repeat(64)))}, B.agent), 409, 'stale_terms', 'accept with a made-up hash');
  refused(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: await sign(B, statements.accept(termsHash({...t, price: {amount: 1, unit: 'PC'}})))}, B.agent), 403, 'bad_signature', 'acceptance signed over different terms');
  assert.equal((await view(A, d.id)).status, 'open');
});

test('counter-offers: own offer, wrong version/prior/deal id, swapped roles, foreign proposer, forged signature, second pending counter, closed deals', async () => {
  const d = ok(await propose(A, terms(A, A, B, 10)), 201), cur = d.current;
  const mk = extra => ({...cur.terms, version: 2, prior_terms_hash: cur.terms_hash, nonce: rnd(16), proposer: B.id, price: {amount: 12, unit: 'PC'}, ...extra});
  const send = async (P, t, signer = P) => call('POST', `/deals/${d.id}/counter`, {terms: t, signature: await sign(signer, statements.propose(termsHash(t)))}, P.agent);
  refused(await send(A, mk({proposer: A.id})), 409, 'own_offer', 'countering own offer');
  refused(await send(B, mk({version: 3})), 400, 'invalid_terms', 'skipped version');
  refused(await send(B, mk({version: 1})), 400, 'invalid_terms', 'same version');
  refused(await send(B, mk({prior_terms_hash: 'ab'.repeat(32)})), 400, 'invalid_terms', 'wrong prior hash');
  refused(await send(B, mk({prior_terms_hash: null})), 400, 'invalid_terms', 'null prior hash');
  refused(await send(B, mk({deal_id: 'vd_' + rnd(8)})), 400, 'invalid_terms', 'other deal id');
  refused(await send(B, mk({payer: {id: B.id, pubkey: B.pubkey}, payee: {id: A.id, pubkey: A.pubkey}})), 400, 'invalid_terms', 'swapped payer and payee');
  refused(await send(B, mk({payee: {id: C.id, pubkey: C.pubkey}})), 400, 'invalid_terms', 'replaced payee');
  refused(await send(B, mk({proposer: A.id})), 400, 'invalid_terms', 'counter claiming the other side as proposer');
  const t = mk();
  refused(await call('POST', `/deals/${d.id}/counter`, {terms: t, signature: await sign(B, statements.propose(termsHash({...t, price: {amount: 1, unit: 'PC'}})))}, B.agent), 403, 'bad_signature', 'counter signed over other terms');
  refused(await send(B, t, A), 403, 'bad_signature', "counter signed with the other party's key");
  ok(await send(B, t));
  refused(await call('POST', `/deals/${d.id}/accept`, {terms_hash: cur.terms_hash, signature: await sign(A, statements.accept(cur.terms_hash))}, A.agent), 409, 'stale_terms', 'accepting the countered (superseded) version');
  refused(await accept(B, d.id), 409, 'own_offer', 'accepting your own counter');
  // a second counter while one waits for the owner
  const G = await newParticipant('adv-gil', {approve_above: 0});
  const g = ok(await propose(A, terms(A, A, G, 10)), 201);
  assert.equal(ok((await counterOf(G, g.id, 11)).r).pending_counter.state, 'awaiting_owner', 'precondition: counter held for the owner');
  refused((await counterOf(G, g.id, 12)).r, 409, 'counter_pending', 'second counter while one is pending');
  // closed deals
  const w = ok(await propose(A, terms(A, A, B, 10)), 201), wh = w.current.terms_hash;
  ok(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: wh, signature: await sign(A, statements.withdraw(wh))}, A.agent));
  const wt = {...w.current.terms, version: 2, prior_terms_hash: wh, nonce: rnd(16), proposer: B.id};
  refused(await call('POST', `/deals/${w.id}/counter`, {terms: wt, signature: await sign(B, statements.propose(termsHash(wt)))}, B.agent), 409, 'not_open', 'counter on a withdrawn deal');
});

// =================================================================================================================
// Input abuse
// =================================================================================================================
test('numbers: zero, negative, fractional, string, boolean, huge and infinite prices/versions/limits are refused', async () => {
  const t = terms(A, A, B, 5), sig = 'ab'.repeat(65);
  for (const amount of [0, -1, 1.5, '5', true, null, 1001, 1e21, 2 ** 53, -0])
    refused(await call('POST', '/deals', {terms: {...t, price: {amount, unit: 'PC'}}, signature: sig}, A.agent), 400, 'invalid_terms', `price ${JSON.stringify(amount)}`);
  refused(await raw('POST', '/deals', JSON.stringify({terms: t, signature: sig}).replace('"amount":5', '"amount":1e400'), A.agent), 400, 'invalid_terms', 'price Infinity (1e400)');
  for (const version of [0, 51, 1.5, '1', -1]) refused(await call('POST', '/deals', {terms: {...t, version}, signature: sig}, A.agent), 400, 'invalid_terms', `version ${JSON.stringify(version)}`);
  for (const v of [-1, 1.5, 100001, '10', true, null, 1e400 /* JSON null */]) {
    refused(await call('PUT', '/owner/mandate', {max_issue_per_deal: v}, A.owner), 400, 'invalid_field', `mandate max_issue_per_deal ${JSON.stringify(v)}`);
    refused(await call('PUT', '/owner/mandate', {approve_above: v}, A.owner), 400, 'invalid_field', `mandate approve_above ${JSON.stringify(v)}`);
  }
  for (const [k, v] of [['may_issue_credit', 'yes'], ['may_issue_credit', 1], ['review_deliveries', 'false'], ['counterparties', 'all'], ['counterparties', ['vp_000000000000']],
    ['counterparties', [A.id, 5]], ['expires_at', 'never'], ['objective', 'x'.repeat(1001)], ['objective', {}]])
    refused(await call('PUT', '/owner/mandate', {[k]: v}, A.owner), 400, 'invalid_field', `mandate ${k} ${JSON.stringify(v).slice(0, 30)}`);
  for (const v of [-1, 1.5, '5', true, 100001]) refused(await call('PUT', '/limits', {max_issue_per_deal: v}, A.agent), 400, 'invalid_field', `limit ${JSON.stringify(v)}`);
  // validation is all-or-nothing: a bad field does not let an earlier good one through
  const before = ok(await call('GET', '/me', null, A.agent));
  refused(await call('PUT', '/owner/mandate', {max_issue_per_deal: 1, approve_above: -1}, A.owner), 400, 'invalid_field', 'mixed good+bad mandate');
  refused(await call('PUT', '/limits', {max_issue_per_deal: 5, max_accept_per_deal: 'x'}, A.agent), 400, 'invalid_field', 'mixed good+bad limits');
  const after = ok(await call('GET', '/me', null, A.agent));
  assert.deepEqual(after.mandate, before.mandate); assert.equal(after.mandate_version, before.mandate_version); assert.deepEqual(after.effective_limits, before.effective_limits);
});

test('bodies: oversized, malformed, deeply nested and form-encoded bodies are refused without a 5xx; no CORS for other origins', async () => {
  refused(await raw('POST', '/deals', JSON.stringify({x: 'y'.repeat(70000)}), A.agent), 413, 'too_large', 'authenticated 70 KB body');
  refused(await raw('POST', '/join', JSON.stringify({x: 'y'.repeat(70000)})), 413, 'too_large', 'unauthenticated 70 KB body');
  refused(await raw('POST', '/join', '{"invite": '), 400, 'bad_json', 'truncated JSON');
  refused(await raw('POST', '/join', 'invite=vpi_x&handle=eve', null, {'content-type': 'application/x-www-form-urlencoded'}), 400, 'bad_json', 'form-encoded body');
  const deep = '['.repeat(30000) + ']'.repeat(30000);
  for (const [m, p, tok] of [['POST', '/join', null], ['PUT', '/owner/mandate', A.owner], ['PUT', '/limits', A.agent], ['POST', '/deals', A.agent]]) {
    const r = await raw(m, p, deep, tok);
    assert.ok(r.status < 500, `deeply nested array on ${p}: ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  }
  assert.equal(ok(await call('GET', '/me', null, A.agent)).mandate.approve_above, 1000, 'a nested array body changed nothing');
  const deepObj = JSON.stringify({terms: terms(A, A, B, 5), signature: 'ab'.repeat(65)}).replace('"title":"Short research brief"', `"title":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}`);
  refused(await raw('POST', '/deals', deepObj, A.agent), 400, 'invalid_field', 'deeply nested service title');
  const long = (n, c = 'x') => c.repeat(n);
  for (const [k, v, max] of [['title', long(121), 120], ['description', long(2001), 2000], ['deliverable', long(501), 500]]) {
    const t = terms(A, A, B, 5); t.service[k] = v;
    refused(await call('POST', '/deals', {terms: t, signature: 'ab'.repeat(65)}, A.agent), 400, 'invalid_field', `service.${k} over ${max}`);
  }
  const inv = ok(await call('POST', '/admin/invites', {max_uses: 10}, null, ADM), 201);
  for (const [name, b] of [['short handle', {handle: 'ab'}], ['unicode handle', {handle: '\u00e1na'}], ['handle with space', {handle: 'a b c'}], ['handle starting with digit', {handle: '1abc'}],
    ['missing operator', {handle: 'adv-noop', operator: ''}], ['about 301', {handle: 'adv-about', about: long(301)}], ['display_name 41', {handle: 'adv-dn', display_name: long(41)}],
    ['handle as object', {handle: {x: 1}}], ['services as array', {handle: 'adv-svc', services: ['a']}]])
    refused(await call('POST', '/join', {invite: inv.code, operator: 'op', ...b}), 400, 'invalid_field', name);
  const pre = await raw('OPTIONS', '/info', null, null, {origin: 'https://evil.example', 'access-control-request-method': 'POST'});
  assert.equal(pre.headers.get('access-control-allow-origin'), null, 'no CORS preflight approval');
  const r = await call('GET', '/me', null, A.agent, {origin: 'https://evil.example'});
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no CORS on authenticated reads');
  // the content type is not checked (text/plain works), which is safe only because auth is a bearer header that a
  // cross-site form cannot set and no CORS is granted
  assert.equal((await raw('PUT', '/limits', '{"notes":"via text/plain"}', A.agent, {'content-type': 'text/plain'})).status, 200);
  assert.equal((await raw('POST', '/deals', '{}', null, {'content-type': 'text/plain'})).status, 401);
});

test('F6 fixed (was low): a JSON body of null crashes the handler (502 internal error instead of 400)', async () => {
  const d = ok(await propose(A, terms(A, A, B, 2)), 201);
  const got = {};
  for (const [name, m, p, tok] of [['join', 'POST', '/join', null], ['enroll', 'POST', '/enroll', null], ['mandate', 'PUT', '/owner/mandate', A.owner],
    ['limits', 'PUT', '/limits', A.agent], ['propose', 'POST', '/deals', A.agent], ['accept', 'POST', `/deals/${d.id}/accept`, B.agent]])
    got[name] = (await raw(m, p, 'null', tok)).status;
  assert.ok(Object.values(got).every(s => s >= 400 && s < 500), `statuses for body "null": ${JSON.stringify(got)}`);
});

test('prototype pollution: __proto__ and constructor keys in bodies change neither mandates, limits nor Object.prototype', async () => {
  const M = await newParticipant('adv-proto', {approve_above: 10, max_issue_per_deal: 20});
  ok(await raw('PUT', '/owner/mandate', '{"__proto__":{"approve_above":99999,"max_issue_per_deal":99999,"may_issue_credit":false},"constructor":{"prototype":{"polluted":1}}}', M.owner));
  ok(await raw('PUT', '/limits', '{"__proto__":{"max_issue_per_deal":99999},"constructor":{"prototype":{"polluted":2}}}', M.agent));
  refused(await raw('POST', '/join', '{"__proto__":{"invite":"vpi_x"},"handle":"adv-pp","operator":"x"}'), 403, 'invalid_invite', 'join with __proto__');
  refused(await call('POST', '/join', {invite: 'x', handle: '__proto__', operator: 'x'}), 403, 'invalid_invite', 'sanity');
  const me = ok(await call('GET', '/me', null, M.agent));
  assert.equal(me.mandate.approve_above, 10); assert.equal(me.mandate.max_issue_per_deal, 20); assert.equal(me.mandate.may_issue_credit, true);
  assert.equal(me.effective_limits.max_issue_per_deal, 20);
  assert.equal(({}).approve_above, undefined); assert.equal(({}).polluted, undefined); assert.equal(({}).max_issue_per_deal, undefined);
  refused(await propose(M, terms(M, M, B, 21)), 403, 'mandate_exceeded', 'limits still enforced after the pollution attempts');
});

test('F7 fixed (was low): the counterparty allowlist accepts prototype property names as participant ids', async () => {
  const M = await newParticipant('adv-allow');
  const r = await call('PUT', '/owner/mandate', {counterparties: ['__proto__', 'constructor', 'toString']}, M.owner);
  assert.equal(outcome(r), '400 invalid_field', `counterparties ["__proto__","constructor","toString"] was stored: ${JSON.stringify(r.body?.mandate?.counterparties)}`);
});

test('F9 fixed (was low): service text is validated after trimming and control-character replacement, but the raw text is what is stored and shown', async () => {
  const title = 'Brief\u0000\u0007\u001b[31m\u202eevil' + ' '.repeat(20000);
  const t = terms(A, A, B, 3, {service: {title, description: 'x\u0000y', deliverable: 'z'}});
  const r = await propose(A, t);
  const stored = r.status === 201 ? pilot.s.deals[r.body.id].versions[0].terms.service.title : null;
  assert.equal(r.status, 400, `accepted (${r.status}); stored title has ${stored?.length} characters including NUL/ESC/RLO: ${JSON.stringify(stored?.slice(0, 20))}`);
});

test('F10 fixed (was low): display names can copy another participant\'s handle, and system-like handles are free', async () => {
  const got = [];
  const inv = ok(await call('POST', '/admin/invites', {max_uses: 5}, null, ADM), 201);
  got.push(`display_name "adv-ana": ${outcome(await call('POST', '/join', {invite: inv.code, handle: 'adv-mallory', display_name: 'adv-ana', operator: 'adversarial operator of adv-ana'}))}`);
  got.push(`display_name with zero-width joiner: ${outcome(await call('POST', '/join', {invite: inv.code, handle: 'adv-mallory2', display_name: 'adv\u200d-ana', operator: 'x'}))}`);
  got.push(`handle "valun": ${outcome(await call('POST', '/join', {invite: inv.code, handle: 'valun', operator: 'Valun network operator'}))}`);
  const dir = ok(await call('GET', '/participants'));
  assert.equal(dir.filter(p => p.display_name === 'adv-ana' || p.handle === 'adv-ana').length, 1, `two directory entries now present as adv-ana; ${got.join('; ')}`);
});

// =================================================================================================================
// Dates
// =================================================================================================================
test('dates: past, too far ahead and unparseable offer/delivery dates are refused', async () => {
  const sig = 'ab'.repeat(65), iso = ms => new Date(now() + ms).toISOString();
  for (const [name, extra] of [['offer expired', {offer_expires_at: iso(-60e3)}], ['offer 8 days', {offer_expires_at: iso(8 * DAY)}], ['offer garbage', {offer_expires_at: 'soon'}],
    ['offer number', {offer_expires_at: now() + H}], ['delivery past', {deliver_by: iso(-60e3)}], ['delivery 31 days', {deliver_by: iso(31 * DAY)}], ['delivery garbage', {deliver_by: 'whenever'}]])
    refused(await call('POST', '/deals', {terms: terms(A, A, B, 5, extra), signature: sig}, A.agent), 400, 'invalid_terms', name);
});

test('F11 fixed (was low): deliver_by may be earlier than offer_expires_at, so a deal can be agreed already overdue', async () => {
  const t = terms(A, A, B, 3, {deliver_by: new Date(now() + H).toISOString(), offer_expires_at: new Date(now() + 48 * H).toISOString()});
  const r = await propose(A, t);
  let agreedOverdue = null;
  if (r.status === 201) {
    clockOffset = 2 * H;
    try { const a = await accept(B, r.body.id); agreedOverdue = a.status === 200 && a.body.status === 'agreed' && a.body.overdue; }
    finally { clockOffset = 0; }
  }
  assert.equal(outcome(r), '400 invalid_terms', `proposal accepted; two hours later the payee accepted it and it was agreed with overdue=${agreedOverdue}`);
});

// =================================================================================================================
// Mandate enforcement
// =================================================================================================================
test('mandate: per-deal caps, price floor, permissions, counterparty list and expiry are hard limits on both proposals and acceptances', async () => {
  const M1 = await newParticipant('adv-m-payer', {max_issue_per_deal: 10}), M2 = await newParticipant('adv-m-payee', {max_accept_per_deal: 10, min_price_as_payee: 5});
  const rule = (r, x, what) => { refused(r, 403, 'mandate_exceeded', what); assert.equal(r.body.rule, x, what); };
  rule(await propose(M1, terms(M1, M1, M2, 11)), 'max_issue_per_deal', 'payer proposes above its cap');
  rule(await propose(M2, terms(M2, M1, M2, 11)), 'max_accept_per_deal', 'payee proposes above its cap');
  rule(await propose(M2, terms(M2, M1, M2, 4)), 'min_price_as_payee', 'payee proposes below its floor');
  rule(await accept(M2, ok(await propose(M1, terms(M1, M1, M2, 4)), 201).id), 'min_price_as_payee', 'payee accepts below its floor');
  rule(await accept(M2, ok(await propose(A, terms(A, A, M2, 11)), 201).id), 'max_accept_per_deal', 'payee accepts above its cap');
  rule(await accept(M1, ok(await propose(B, terms(B, M1, B, 11)), 201).id), 'max_issue_per_deal', 'payer accepts above its cap');
  ok(await call('PUT', '/owner/mandate', {may_issue_credit: false}, M1.owner));
  rule(await propose(M1, terms(M1, M1, M2, 6)), 'may_issue_credit', 'issuing disabled');
  ok(await call('PUT', '/owner/mandate', {may_issue_credit: true}, M1.owner));
  ok(await call('PUT', '/owner/mandate', {may_accept_credit: false}, M2.owner));
  rule(await accept(M2, ok(await propose(M1, terms(M1, M1, M2, 6)), 201).id), 'may_accept_credit', 'accepting disabled');
  ok(await call('PUT', '/owner/mandate', {may_accept_credit: true, counterparties: [C.id]}, M2.owner));
  rule(await accept(M2, ok(await propose(M1, terms(M1, M1, M2, 6)), 201).id), 'counterparties', 'acceptor allowlist');
  rule(await propose(M2, terms(M2, M1, M2, 6)), 'counterparties', 'proposer allowlist');
  ok(await call('PUT', '/owner/mandate', {counterparties: 'any'}, M2.owner));
  ok(await call('PUT', '/owner/mandate', {expires_at: new Date(Date.now() - 60e3).toISOString()}, M1.owner));
  rule(await propose(M1, terms(M1, M1, M2, 6)), 'expires_at', 'expired mandate (explicit)');
  ok(await call('PUT', '/owner/mandate', {expires_at: new Date(Date.now() + H).toISOString()}, M1.owner));
  const pending = ok(await propose(M1, terms(M1, M1, M2, 6)), 201);       // a 24h offer, made while the mandate is valid
  clockOffset = 2 * H;
  try {
    rule(await propose(M1, terms(M1, M1, M2, 6)), 'expires_at', 'mandate expired by the clock');
    const r = await accept(M2, pending.id);
    refused(r, 409, 'offer_not_authorized', "acceptance of an offer whose proposer's mandate has since expired");
    assert.ok(!('rule' in r.body) && !/expire/.test(r.body.message), "the proposer's rule stays private");
  } finally { clockOffset = 0; }
  ok(await call('PUT', '/owner/mandate', {expires_at: null, approve_above: 5}, M1.owner));
  const held = ok(await propose(M1, terms(M1, M1, M2, 6)), 201);
  assert.equal(held.status, 'proposed_awaiting_owner', 'above approve_above: held');
  refused(await call('GET', `/deals/${held.id}`, null, M2.agent), 404, 'not_found', 'held proposal invisible to the counterparty');
  refused(await accept(M2, held.id, held.current.terms_hash), 404, 'not_found', 'held proposal cannot be accepted');
});

test('mandate: max_issue_outstanding counts tracker debt, agreed deals and open offers, and survives key rotation', async () => {
  const X = await newParticipant('adv-out-x', {max_issue_outstanding: 20}), Y = await newParticipant('adv-out-y');
  const rule = (r, what) => { refused(r, 403, 'mandate_exceeded', what); assert.equal(r.body.rule, 'max_issue_outstanding', what); };
  const o1 = ok(await propose(X, terms(X, X, Y, 10)), 201), o2 = ok(await propose(X, terms(X, X, Y, 10)), 201);
  rule(await propose(X, terms(X, X, Y, 1)), 'two open offers use the whole limit');
  ok(await accept(Y, o1.id));
  rule(await propose(X, terms(X, X, Y, 1)), 'agreed + open');
  ok(await call('POST', `/deals/${o2.id}/withdraw`, {terms_hash: o2.current.terms_hash, signature: await sign(X, statements.withdraw(o2.current.terms_hash))}, X.agent));
  ok(await deliver(Y, o1.id, 'work'));
  assert.equal(ok(await complete(X, o1.id)).status, 'note_issued');
  const o3 = ok(await propose(X, terms(X, X, Y, 10)), 201);
  rule(await propose(X, terms(X, X, Y, 1)), 'tracker debt + open offer');
  const rv = ok(await call('POST', '/owner/revoke-agent', null, X.owner));
  assert.deepEqual(rv.cancelled_deals, [o3.id]);
  await reenroll(X, rv.enrollment_code);
  rule(await propose(X, terms(X, X, Y, 11)), 'debt under the revoked key still counts after re-enrollment');
  assert.equal(ok(await propose(X, terms(X, X, Y, 10)), 201).status, 'open', 'exactly up to the limit is allowed');
});

test('race: concurrent acceptances cannot push a participant past max_issue_outstanding or max_accept_per_issuer', async () => {
  const P1 = await newParticipant('adv-race-payer', {max_issue_outstanding: 30}), Q1 = await newParticipant('adv-race-payee');
  const offers = [];
  for (let i = 0; i < 3; i++) offers.push(ok(await propose(Q1, terms(Q1, P1, Q1, 15)), 201));       // payee-made offers: P1 has reserved nothing
  const bodies = await Promise.all(offers.map(async o => ({id: o.id, b: {terms_hash: o.current.terms_hash, signature: await sign(P1, statements.accept(o.current.terms_hash))}})));
  const rs = await Promise.all(bodies.map(x => call('POST', `/deals/${x.id}/accept`, x.b, P1.agent)));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 200, 403], JSON.stringify(rs.map(r => r.body?.error ?? r.body?.status)));
  assert.equal(rs.find(r => r.status === 403).body.rule, 'max_issue_outstanding');
  const P2 = await newParticipant('adv-race-payer2'), Q2 = await newParticipant('adv-race-payee2', {max_accept_per_issuer: 30});
  const offers2 = [];
  for (let i = 0; i < 3; i++) offers2.push(ok(await propose(P2, terms(P2, P2, Q2, 15)), 201));
  const bodies2 = await Promise.all(offers2.map(async o => ({id: o.id, b: {terms_hash: o.current.terms_hash, signature: await sign(Q2, statements.accept(o.current.terms_hash))}})));
  const rs2 = await Promise.all(bodies2.map(x => call('POST', `/deals/${x.id}/accept`, x.b, Q2.agent)));
  assert.deepEqual(rs2.map(r => r.status).sort(), [200, 200, 403], JSON.stringify(rs2.map(r => r.body?.error ?? r.body?.status)));
  assert.equal(rs2.find(r => r.status === 403).body.rule, 'max_accept_per_issuer');
  assert.equal(Object.values(pilot.s.deals).filter(d => d.payee === Q2.id && d.status === 'agreed').length, 2);
});

test('race: concurrent credit notes for one key pair cannot double-issue or skip the running total; a note cannot be replayed onto another deal', async () => {
  const X = await newParticipant('adv-nr-x'), Y = await newParticipant('adv-nr-y');
  const d1 = await delivered(X, Y, 4), d2 = await delivered(X, Y, 6);
  const [c1, c2] = await Promise.all([prepareComplete(X, d1), prepareComplete(X, d2)]);
  assert.equal(c1.tpl.prior_total, 0); assert.equal(c2.tpl.prior_total, 0);
  const rs = await Promise.all([call('POST', `/deals/${d1}/complete`, c1.body, X.agent), call('POST', `/deals/${d2}/complete`, c2.body, X.agent)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409], JSON.stringify(rs.map(r => r.body?.error ?? r.body?.status)));
  const win = rs.findIndex(r => r.status === 200), lose = 1 - win, winId = [d1, d2][win], loseId = [d1, d2][lose];
  assert.equal(rs[win].body.status, 'note_issued'); assert.equal(rs[lose].body.error, 'stale_note');
  assert.equal(await trackerTotal(X, Y), [4, 6][win]);
  const fresh = await prepareComplete(X, loseId);
  refused(await call('POST', `/deals/${loseId}/complete`, {...fresh.body, credit_note: [c1, c2][win].body.credit_note}, X.agent), 409, 'stale_note', "the issued deal's note replayed on the other deal");
  refused(await call('POST', `/deals/${loseId}/complete`, [c1, c2][win].body, X.agent), 409, 'stale_terms', 'the whole winning body replayed on the other deal');
  refused(await call('POST', `/deals/${winId}/complete`, [c1, c2][win].body, X.agent), 409, 'wrong_state', 'the winning body replayed on its own deal');
  assert.equal(ok(await call('POST', `/deals/${loseId}/complete`, fresh.body, X.agent)).status, 'note_issued');
  assert.equal(await trackerTotal(X, Y), 10);
  assert.ok(ok(await call('GET', '/ledger')).reconciliation.filter(r => r.issuer === X.handle).every(r => r.status === 'match'));
});

test('agent limits: cannot loosen any owner limit, cannot touch owner-only fields, and the stricter value always applies', async () => {
  const L = await newParticipant('adv-lim', {max_issue_per_deal: 50, min_price_as_payee: 5, min_payer_coverage_pct: 10});
  const lim = (b, tok = L.agent) => call('PUT', '/limits', b, tok);
  refused(await lim({max_issue_per_deal: 51}), 403, 'above_owner_mandate', 'cap above owner');
  refused(await lim({max_issue_outstanding: 5001}), 403, 'above_owner_mandate', 'outstanding above owner');
  refused(await lim({max_accept_per_issuer: 5001}), 403, 'above_owner_mandate', 'per-issuer above owner');
  refused(await lim({min_price_as_payee: 4}), 403, 'below_owner_mandate', 'floor below owner');
  refused(await lim({min_payer_coverage_pct: 9}), 403, 'below_owner_mandate', 'coverage below owner');
  refused(await lim({max_issue_per_deal: 10, max_accept_per_deal: 101}), 403, 'above_owner_mandate', 'valid + invalid together');
  assert.equal(ok(await call('GET', '/me', null, L.agent)).agent_limits.max_issue_per_deal, undefined, 'nothing recorded from the refused request');
  refused(await lim({max_issue_per_deal: 51}, L.owner), 403, 'above_owner_mandate', 'the owner token on /limits is bounded too');
  const before = ok(await call('GET', '/me', null, L.agent));
  ok(await lim({approve_above: 99999, may_issue_credit: true, may_accept_credit: true, review_deliveries: false, counterparties: 'any', expires_at: null, objective: 'mine now', mandate: {approve_above: 99999}}));
  const after = ok(await call('GET', '/me', null, L.agent));
  assert.deepEqual(after.mandate, before.mandate, 'owner-only fields ignored'); assert.equal(after.effective_limits.approve_above, before.effective_limits.approve_above);
  ok(await lim({min_payer_coverage_pct: null, min_price_as_payee: null}));
  assert.equal(ok(await call('GET', '/me', null, L.agent)).effective_limits.min_price_as_payee, 5, 'clearing an agent floor never clears the owner floor');
  ok(await lim({max_issue_per_deal: 20}));
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 10}, L.owner));
  const r1 = await propose(L, terms(L, L, B, 11));
  refused(r1, 403, 'mandate_exceeded', 'owner lowered below the agent limit'); assert.equal(r1.body.source, 'owner_mandate');
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 100}, L.owner));
  const r2 = await propose(L, terms(L, L, B, 21));
  refused(r2, 403, 'mandate_exceeded', 'owner raised again: the agent limit still binds'); assert.equal(r2.body.source, 'agent_limits');
  ok(await lim({max_issue_per_deal: 0}));
  refused(await propose(L, terms(L, L, B, 1)), 403, 'mandate_exceeded', 'agent limit 0 blocks issuing');
});

test('coverage: a payer with no claims is refused, and an agent cannot clear its owner\'s coverage floor', async () => {
  const P = await newParticipant('adv-cov-payer'), Cv = await newParticipant('adv-cov-lender', {min_payer_coverage_pct: 50});
  const d = ok(await propose(P, terms(P, P, Cv, 5)), 201);
  const r = await accept(Cv, d.id);
  refused(r, 403, 'mandate_exceeded', 'no claims, 50% required'); assert.equal(r.body.rule, 'min_payer_coverage_pct');
  ok(await call('PUT', '/limits', {min_payer_coverage_pct: null}, Cv.agent));
  assert.equal((await accept(Cv, d.id)).body.rule, 'min_payer_coverage_pct', 'still enforced after the agent clears its own value');
  refused(await call('PUT', '/limits', {min_payer_coverage_pct: 0}, Cv.agent), 403, 'below_owner_mandate', 'agent cannot lower the floor');
});

test('FINDING F3 medium: coverage counts claims issued by anyone, so an unbacked colluder can manufacture a payer\'s coverage', {todo: 'F3 - see docs/ADVERSARIAL-FINDINGS.md'}, async () => {
  const X = await newParticipant('adv-colluder'), Bw = await newParticipant('adv-borrower'), Lw = await newParticipant('adv-lender', {min_payer_coverage_pct: 100});
  // X (no claims of its own, 0% coverage) "pays" Bw 100 for nothing: a credit note X -> Bw on the tracker
  const fake = await delivered(X, Bw, 100, 'nothing of value');
  assert.equal(ok(await complete(X, fake)).status, 'note_issued', 'precondition: colluder note issued');
  // Bw now shows 100 PC of claims and borrows 100 from Lw, whose owner requires 100% coverage
  const d = ok(await propose(Bw, terms(Bw, Bw, Lw, 100)), 201);
  const r = await accept(Lw, d.id);
  assert.equal(r.body?.rule ?? r.body?.status, 'min_payer_coverage_pct', `Lw accepted (${outcome(r)}): Bw's "coverage" is a 100 PC claim on X, which itself has 0 PC of claims`);
});

// =================================================================================================================
// Owner approvals
// =================================================================================================================
test('approvals: only the owning owner decides, once, with a valid decision; ids are not guessable shortcuts', async () => {
  const O = await newParticipant('adv-oak', {approve_above: 0});
  const d = ok(await propose(O, terms(O, O, B, 5)), 201);
  const [a] = await approvalsFor(O, d.id);
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, O.agent), 404, 'not_found', "O's agent decides");
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, B.owner), 404, 'not_found', "the counterparty's owner decides");
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, B.agent), 404, 'not_found', "the counterparty's agent decides");
  assert.ok(!JSON.stringify(ok(await call('GET', '/owner', null, B.owner))).includes(a.id));
  for (const decision of ['APPROVE', 'approve ', 'yes', true, null, ['approve']])
    refused(await call('POST', `/owner/approvals/${a.id}`, {decision}, O.owner), 400, 'invalid_field', `decision ${JSON.stringify(decision)}`);
  refused(await call('POST', '/owner/approvals/va_000000000000', {decision: 'approve'}, O.owner), 404, 'not_found', 'unknown approval');
  refused(await call('POST', `/owner/approvals/${a.id.slice(0, -1)}`, {decision: 'approve'}, O.owner), 404, 'not_found', 'malformed approval id');
  assert.equal(ok(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, O.owner)).deal.status, 'open');
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, O.owner), 409, 'not_pending', 'approve twice');
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'reject'}, O.owner), 409, 'not_pending', 'reject after approve');
});

test('approvals: approving re-checks the mandate, the keys and expiry; a withdrawn or cancelled offer cannot be revived', async () => {
  const O = await newParticipant('adv-olga', {approve_above: 0}), Q = await newParticipant('adv-quill');
  const d = ok(await propose(O, terms(O, O, Q, 30)), 201);
  const [a] = await approvalsFor(O, d.id);
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 20}, O.owner));
  const r = await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, O.owner);
  refused(r, 403, 'mandate_exceeded', 'tightened mandate'); assert.equal(r.body.rule, 'max_issue_per_deal');
  assert.equal((await approvalsFor(O, d.id))[0]?.id, a.id, 'approval still pending'); refused(await call('GET', `/deals/${d.id}`, null, Q.agent), 404, 'not_found', 'still invisible');
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 100}, O.owner));
  const rv = ok(await call('POST', '/owner/revoke-agent', null, Q.owner));
  assert.ok(rv.cancelled_deals.includes(d.id), 'counterparty revocation cancels the held proposal');
  refused(await call('POST', `/owner/approvals/${a.id}`, {decision: 'approve'}, O.owner), 409, 'not_pending', 'approval of a cancelled deal');
  await reenroll(Q, rv.enrollment_code);
  const d2 = ok(await propose(O, terms(O, O, Q, 5)), 201), [a2] = await approvalsFor(O, d2.id);
  clockOffset = 25 * H;
  try { refused(await call('POST', `/owner/approvals/${a2.id}`, {decision: 'approve'}, O.owner), 409, 'not_pending', 'approval after the offer expired'); }
  finally { clockOffset = 0; }
  const d3 = ok(await propose(O, terms(O, O, Q, 5)), 201), [a3] = await approvalsFor(O, d3.id);
  ok(await call('POST', `/deals/${d3.id}/withdraw`, {terms_hash: d3.current.terms_hash, signature: await sign(O, statements.withdraw(d3.current.terms_hash))}, O.agent));
  refused(await call('POST', `/owner/approvals/${a3.id}`, {decision: 'approve'}, O.owner), 409, 'not_pending', 'approval of a withdrawn proposal');
  // an acceptance waiting for its owner cannot be approved after the proposer withdrew
  const S = await newParticipant('adv-sid', {approve_above: 0}), R = await newParticipant('adv-ray');
  const d4 = ok(await propose(R, terms(R, R, S, 5)), 201);
  assert.equal(ok(await accept(S, d4.id)).status, 'accepted_awaiting_owner');
  const [a4] = await approvalsFor(S, d4.id);
  ok(await call('POST', `/deals/${d4.id}/withdraw`, {terms_hash: d4.current.terms_hash, signature: await sign(R, statements.withdraw(d4.current.terms_hash))}, R.agent));
  refused(await call('POST', `/owner/approvals/${a4.id}`, {decision: 'approve'}, S.owner), 409, 'not_pending', 'acceptance approval after withdrawal');
  assert.equal((await view(R, d4.id)).status, 'withdrawn');
});

test('F1 fixed (was high): an agent cannot accept while its own counter-offer waits; the counterparty mandate still applies; form() refuses mismatched acceptances', async () => {
  const Q = await newParticipant('adv-victim2', {max_issue_per_deal: 10}), P = await newParticipant('adv-attacker2', {approve_above: 0});
  const v1 = ok(await propose(Q, terms(Q, Q, P, 10)), 201), h1 = v1.current.terms_hash;
  const {r: cr} = await counterOf(P, v1.id, 50);
  assert.equal(ok(cr).pending_counter.state, 'awaiting_owner');
  refused(await accept(P, v1.id, h1), 409, 'counter_pending', 'accepting while its own counter waits');
  const counterAp = (await approvalsFor(P, v1.id)).find(a => a.kind === 'propose');
  ok(await call('POST', `/owner/approvals/${counterAp.id}`, {decision: 'approve'}, P.owner));
  const d = pilot.s.deals[v1.id];
  assert.equal(d.status, 'open');
  assert.equal(d.agreement, undefined);
  const r = await accept(Q, v1.id, d.versions.at(-1).terms_hash);          // Q may accept the 50 PC counter only within its mandate
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'mandate_exceeded');
  // Defence in depth: an acceptance that does not match the current terms never forms an agreement.
  const fake = {...structuredClone(d), acceptance: {version: 1, by: Q.id, terms_hash: h1, signature: 'x'}};
  assert.throws(() => pilot.form(fake), e => e.code === 'not_pending');
});

test('FINDING F1 high (original repro, kept): approving a held counter-offer, then the earlier held acceptance, agrees the deal on terms the counterparty never accepted (and outside its mandate)', {todo: 'F1 - see docs/ADVERSARIAL-FINDINGS.md (fixed: the second step is now refused, so this repro stops at its precondition)'}, async () => {
  // Q (payer) allows at most 10 PC per deal. P (payee) has every commitment held for its owner (approve_above 0).
  const Q = await newParticipant('adv-victim', {max_issue_per_deal: 10}), P = await newParticipant('adv-attacker', {approve_above: 0});
  const v1 = ok(await propose(Q, terms(Q, Q, P, 10)), 201), h1 = v1.current.terms_hash;
  const {r: cr} = await counterOf(P, v1.id, 50);                         // P counters at 50 (held for P's owner)
  assert.equal(ok(cr).pending_counter.state, 'awaiting_owner', 'precondition: counter held');
  assert.equal(ok(await accept(P, v1.id, h1)).status, 'accepted_awaiting_owner', 'precondition: P also accepts v1 (held)');
  const aps = await approvalsFor(P, v1.id), counterAp = aps.find(a => a.kind === 'propose'), accAp = aps.find(a => a.kind === 'accept');
  assert.ok(counterAp && accAp, 'precondition: two pending approvals');
  ok(await call('POST', `/owner/approvals/${counterAp.id}`, {decision: 'approve'}, P.owner));
  const second = await call('POST', `/owner/approvals/${accAp.id}`, {decision: 'approve'}, P.owner);
  const d = pilot.s.deals[v1.id];
  const violated = d.status === 'agreed' && d.agreement.terms_hash !== h1;   // decided now: the follow-on below moves the status on
  const facts = {second_decision: outcome(second), status: d.status, agreed_version: d.agreement?.version, agreed_price: d.agreement?.terms.price.amount,
    proposer: d.agreement?.proposer === P.id ? 'P' : d.agreement?.proposer, acceptor: d.agreement?.acceptor === P.id ? 'P' : d.agreement?.acceptor};
  // what follows if it stands: P delivers and Q's agent, seeing an agreed deal, issues a 50 PC note (its owner's cap is 10)
  if (violated) {
    ok(await deliver(P, v1.id, 'delivered under terms Q never signed'));
    facts.q_note = outcome(await complete(Q, v1.id));
    facts.q_tracker_total = await trackerTotal(Q, P);
  }
  assert.ok(!violated && !(d.agreement && d.agreement.terms_hash !== h1), `deal agreed on terms Q never accepted: ${JSON.stringify(facts)}`);
});

test('F4 fixed (was low): lowering approve_above does not hold offers that are already open', async () => {
  const W = await newParticipant('adv-wes'), Z = await newParticipant('adv-zed');
  const d = ok(await propose(W, terms(W, W, Z, 50)), 201);
  assert.equal(d.status, 'open', 'precondition: offered without approval (approve_above 1000)');
  ok(await call('PUT', '/owner/mandate', {approve_above: 0}, W.owner));       // the owner: "from now on, every commitment waits for me"
  const r = await accept(Z, d.id);
  assert.notEqual(r.body?.status, 'agreed', `accepted and agreed without W's owner: ${outcome(r)}`);
  assert.equal(r.body?.status, 'accepted_awaiting_owner', `held for W's owner: ${outcome(r)}`);
  assert.equal((await approvalsFor(W, d.id))[0]?.kind, 'confirm_offer', "W's owner is asked");
});

// =================================================================================================================
// State machine
// =================================================================================================================
test('state machine: every out-of-order, wrong-party or tampered lifecycle step is refused', async () => {
  const d = ok(await propose(A, terms(A, A, B, 20)), 201), id = d.id, h = d.current.terms_hash;
  const before = await trackerTotal(A, B);
  refused(await deliverWith(B, id, h, 'early'), 409, 'wrong_state', 'deliver before agreement');
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, A.agent), 409, 'wrong_state', 'template before delivery');
  refused(await call('POST', `/deals/${id}/complete`, {terms_hash: h}, A.agent), 409, 'wrong_state', 'complete before delivery');
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, reason: 'x'}, A.agent), 409, 'wrong_state', 'dispute before delivery');
  ok(await accept(B, id));
  refused(await deliverWith(A, id, h, 'payer delivers'), 403, 'not_payee', 'payer delivers');
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 403, 'not_payer', 'payee fetches template');
  refused(await call('POST', `/deals/${id}/complete`, {terms_hash: h}, B.agent), 403, 'not_payer', 'payee completes');
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, reason: 'x'}, B.agent), 403, 'not_payer', 'payee disputes');
  refused(await call('POST', `/deals/${id}/complete`, {terms_hash: h}, A.agent), 409, 'wrong_state', 'complete before delivery (agreed)');
  refused(await accept(B, id, h), 409, 'not_open', 'accept an agreed deal');
  refused(await call('POST', `/deals/${id}/decline`, {terms_hash: h, signature: await sign(B, statements.decline(h, ''))}, B.agent), 409, 'not_open', 'decline an agreed deal');
  refused(await call('POST', `/deals/${id}/withdraw`, {terms_hash: h, signature: await sign(A, statements.withdraw(h))}, A.agent), 409, 'not_open', 'withdraw an agreed offer');
  refused((await counterOf(B, id, 30)).r, 409, 'not_open', 'counter an agreed deal');
  const content = '# delivered work', dh = sha(content);
  const del = (b) => call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, ...b}, B.agent);
  refused(await del({terms_hash: 'f'.repeat(64), signature: await sign(B, statements.deliver(h, dh))}), 409, 'stale_terms', 'delivery with a wrong terms hash');
  refused(await del({sha256: sha('other'), signature: await sign(B, statements.deliver(h, dh))}), 400, 'hash_mismatch', 'claimed sha256 of other content');
  refused(await del({signature: await sign(B, statements.deliver(h, sha('other')))}), 403, 'bad_signature', 'delivery signed over other content');
  refused(await del({signature: await sign(B, statements.complete(h, dh))}), 403, 'bad_signature', 'complete/1 statement as delivery');
  refused(await del({signature: await sign(A, statements.deliver(h, dh))}), 403, 'bad_signature', "payer's key on the delivery");
  for (const [name, c] of [['empty', ''], ['whitespace', '   \n'], ['32769 bytes', 'x'.repeat(32769)], ['object', {a: 1}], ['multibyte over limit', '\u00e9'.repeat(16385)]])
    refused(await call('POST', `/deals/${id}/deliver`, {terms_hash: h, content: c, signature: 'ab'.repeat(65)}, B.agent), 400, 'invalid_field', `content ${name}`);
  ok(await del({signature: await sign(B, statements.deliver(h, dh))}));
  refused(await deliverWith(B, id, h, 'second delivery'), 409, 'wrong_state', 'deliver twice');
  const {tpl, body} = await prepareComplete(A, id);
  const post = b => call('POST', `/deals/${id}/complete`, b, A.agent);
  refused(await post({...body, deliverable_sha256: sha('other')}), 409, 'stale_terms', 'completion naming another deliverable');
  refused(await post({...body, signature: (await view(A, id)).delivery.signature}), 403, 'bad_signature', "the payee's delivery signature as completion");
  refused(await post({...body, signature: await sign(A, statements.deliver(tpl.terms_hash, tpl.deliverable_sha256))}), 403, 'bad_signature', 'deliver/1 statement as completion');
  refused(await post({...body, credit_note: undefined}), 409, 'stale_note', 'no credit note');
  for (const [name, o] of [['total +1', {mutateTotal: 1}], ['total -1', {mutateTotal: -1}]]) refused(await complete(A, id, o), 409, 'stale_note', name);
  refused(await post({...body, credit_note: {...body.credit_note, total: String(body.credit_note.total)}}), 409, 'stale_note', 'total as string');
  for (const [name, ts] of [['future timestamp', now() + 10 * 60e3], ['zero timestamp', 0], ['fractional timestamp', tpl.timestamp + 0.5], ['string timestamp', String(tpl.timestamp)]])
    refused(await post({...body, credit_note: {...body.credit_note, timestamp: ts}}), 409, 'stale_note', name);
  refused(await complete(A, id, {recipient: C.pubkey}), 403, 'bad_signature', 'note signed to another recipient key');
  refused(await complete(A, id, {noteSigner: B}), 403, 'bad_signature', 'note signed by the payee key');
  const other = await prepareComplete(A, id, {timestamp: tpl.timestamp - 1});
  refused(await post({...body, credit_note: {...body.credit_note, signature: other.body.credit_note.signature}}), 403, 'bad_signature', 'signature of a note with another timestamp');
  assert.equal(await trackerTotal(A, B), before, 'nothing reached the tracker');
  const final = (await prepareComplete(A, id)).body;                       // a fresh template: the probes above took a while
  assert.equal(ok(await post(final)).status, 'note_issued');
  assert.equal(await trackerTotal(A, B), before + 20);
  refused(await post(final), 409, 'wrong_state', 'complete twice');
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, deliverable_sha256: dh, reason: 'x', signature: await sign(A, statements.dispute(h, dh, 'x'))}, A.agent), 409, 'wrong_state', 'dispute after the note');
  refused(await deliverWith(B, id, h, 'again'), 409, 'wrong_state', 'deliver after the note');
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, A.agent), 409, 'wrong_state', 'template after the note');
  assert.equal(await trackerTotal(A, B), before + 20, 'exactly one note');
});

test('state machine: disputed, withdrawn and declined deals accept no further acts; a held note never reaches the payee', async () => {
  const id = await delivered(A, B, 7), v = await view(A, id), h = v.agreement.terms_hash, dh = v.delivery.sha256;
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, deliverable_sha256: dh, reason: '', signature: await sign(A, statements.dispute(h, dh, ''))}, A.agent), 400, 'invalid_field', 'dispute without a reason');
  ok(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, deliverable_sha256: dh, reason: 'not done', signature: await sign(A, statements.dispute(h, dh, 'not done'))}, A.agent));
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, A.agent), 409, 'wrong_state', 'template for a disputed deal');
  refused(await call('POST', `/deals/${id}/complete`, {terms_hash: h, deliverable_sha256: dh}, A.agent), 409, 'wrong_state', 'note for a disputed deal');
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: h, deliverable_sha256: dh, reason: 'again', signature: await sign(A, statements.dispute(h, dh, 'again'))}, A.agent), 409, 'wrong_state', 'dispute twice');
  refused(await deliverWith(B, id, h, 'redo'), 409, 'wrong_state', 'redeliver after dispute');
  const w = ok(await propose(A, terms(A, A, B, 3)), 201), wh = w.current.terms_hash;
  refused(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: wh, signature: await sign(B, statements.withdraw(wh))}, B.agent), 409, 'not_open', "withdrawing someone else's offer");
  refused(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: 'f'.repeat(64), signature: await sign(A, statements.withdraw('f'.repeat(64)))}, A.agent), 409, 'stale_terms', 'withdraw with a wrong hash');
  ok(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: wh, signature: await sign(A, statements.withdraw(wh))}, A.agent));
  refused(await accept(B, w.id, wh), 409, 'not_open', 'accept after withdrawal');
  refused(await call('POST', `/deals/${w.id}/withdraw`, {terms_hash: wh, signature: await sign(A, statements.withdraw(wh))}, A.agent), 409, 'not_open', 'withdraw twice');
  const dc = ok(await propose(A, terms(A, A, B, 3)), 201), dch = dc.current.terms_hash;
  refused(await call('POST', `/deals/${dc.id}/decline`, {terms_hash: dch, signature: await sign(A, statements.decline(dch, ''))}, A.agent), 409, 'own_offer', 'declining your own offer');
  ok(await call('POST', `/deals/${dc.id}/decline`, {terms_hash: dch, signature: await sign(B, statements.decline(dch, ''))}, B.agent));
  refused(await accept(B, dc.id, dch), 409, 'not_open', 'accept after decline');
  refused(await call('POST', `/deals/${dc.id}/decline`, {terms_hash: dch, signature: await sign(B, statements.decline(dch, ''))}, B.agent), 409, 'not_open', 'decline twice');
  const ex = ok(await propose(A, terms(A, A, B, 3)), 201);
  clockOffset = 25 * H;
  try {
    refused(await accept(B, ex.id, ex.current.terms_hash), 409, 'not_open', 'accept after expiry');
    refused(await call('POST', `/deals/${ex.id}/withdraw`, {terms_hash: ex.current.terms_hash, signature: await sign(A, statements.withdraw(ex.current.terms_hash))}, A.agent), 409, 'not_open', 'withdraw after expiry');
  } finally { clockOffset = 0; }
  // review_deliveries: the payer-signed note is held for the payer's owner; the payee must not get the signature by any route
  const R = await newParticipant('adv-rev', {review_deliveries: true}), S = await newParticipant('adv-rev-s');
  const hid = await delivered(R, S, 4);
  assert.equal(ok(await complete(R, hid)).status, 'completion_awaiting_owner');
  const noteSig = (await view(R, hid)).credit_note.note.signature;
  assert.match(noteSig, /^[0-9a-f]{130}$/);
  const payeeSees = JSON.stringify([await view(S, hid), ok(await call('GET', '/deals', null, S.agent)), ok(await call('GET', '/inbox', null, S.agent)),
    ok(await call('GET', '/owner', null, S.owner)), ok(await call('GET', `/deals/${hid}`, null, S.owner)), ok(await call('GET', '/ledger')), ok(await call('GET', `/participants/${R.id}`))]);
  assert.ok(!payeeSees.includes(noteSig), 'held note signature visible to the payee');
  refused(await call('GET', `/deals/${hid}/credit-note-template`, null, R.agent), 409, 'wrong_state', 'template while the note is held');
  refused(await call('POST', `/deals/${hid}/complete`, {terms_hash: 'x', deliverable_sha256: 'y'}, R.agent), 409, 'wrong_state', 'agent re-completes a held note');
  refused(await call('POST', `/deals/${hid}/dispute`, {terms_hash: 'x', deliverable_sha256: 'y'}, R.agent), 409, 'wrong_state', 'agent disputes while held');
  ok(await call('PUT', '/limits', {review_deliveries: false}, R.agent));
  assert.equal(ok(await call('GET', '/me', null, R.agent)).mandate.review_deliveries, true, 'the agent cannot switch off delivery review');
});

// =================================================================================================================
// Rate limiting
// =================================================================================================================
test('rate limit: authenticated requests per token and unauthenticated writes per IP get 429 past the limit', async () => {
  const s = await listen(createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 5, pilotReadLimitPerMinute: 5, pilotIpReadLimitPerMinute: 100}, adminTokenHash: sha(ADMIN)})); extraServers.push(s);
  const tok = [];
  for (let i = 0; i < 6; i++) tok.push((await call('GET', '/me', null, C.agent, {}, s.base)).status);
  assert.deepEqual(tok, [200, 200, 200, 200, 200, 429], 'per-token read limit (reads have their own budget)');
  assert.equal((await call('GET', '/me', null, C.owner, {}, s.base)).status, 200, 'owner token has its own bucket');
  const ip = [];
  for (let i = 0; i < 6; i++) ip.push((await call('POST', '/join', {invite: 'vpi_guess' + i, handle: 'adv-rl', operator: 'x'}, null, {}, s.base)).status);
  assert.deepEqual(ip, [403, 403, 403, 403, 403, 429], 'per-IP limit on unauthenticated writes (invite guessing)');
  refused(await call('POST', '/enroll', {participant_id: 'vp_000000000000', code: 'vpe_guess'}, null, {}, s.base), 429, 'rate_limited', 'enrollment-code guessing from the same IP');
  refused(await call('POST', '/admin/invites', {}, null, ADM, s.base), 429, 'rate_limited', 'even admin writes from a limited IP');
});

test('F2 fixed (was medium): unauthenticated reads (ledger, participant positions) are never rate-limited and each one reads the whole tracker', async () => {
  const s = await listen(createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 5, pilotReadLimitPerMinute: 5}, adminTokenHash: sha(ADMIN)})); extraServers.push(s);
  const st = [];
  for (let i = 0; i < 10; i++) st.push((await call('GET', i % 2 ? '/ledger' : `/participants/${A.id}`, null, null, {}, s.base)).status);
  assert.ok(st.includes(429), `10 public reads with a limit of 5 per minute: ${st.join(',')}`);
});

// =================================================================================================================
// Second pass (2026-11-07): gaps the protocol cross-check found in the first fixes (spec/OPEN-QUESTIONS.md OQ-30..34)
// =================================================================================================================
test('OQ-30: a made-up bearer token does not skip the per-IP read budget', async () => {
  const s = await listen(createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 5, pilotReadLimitPerMinute: 3, pilotIpReadLimitPerMinute: 3}, adminTokenHash: sha(ADMIN)})); extraServers.push(s);
  const st = [];
  for (let i = 0; i < 6; i++) st.push((await call('GET', '/ledger', null, 'vpa_made_up_token', {}, s.base)).status);
  assert.ok(st.includes(429), `6 reads with a fake token and a read budget of 3: ${st.join(',')}`);
});

test('OQ-31: a signer outage is a 503, never reported as the client\'s bad signature; signer refusals stay "does not verify"', async () => {
  const p = Object.create(Pilot.prototype);
  const key = '02' + 'ab'.repeat(32), sig = '02' + 'cd'.repeat(64);
  p.basis = {verify: async () => { throw new Error('signer timed out'); }};
  await assert.rejects(() => p.safeVerify(key, '00', sig), e => e.code === 'signer_unavailable' && e.status === 503);
  p.basis = {verify: async () => { throw new Error('signer: invalid signature encoding'); }};
  assert.equal(await p.safeVerify(key, '00', sig), false);
  assert.equal(await p.safeVerify(key, '00', '00'.repeat(65)), false, 'all-zero is refused before the signer runs');
});

test('OQ-33: emoji sequences and ZWNJ scripts are allowed in signed text; tag characters and C1 controls are refused', async () => {
  const Q = await newParticipant('adv-text-q'), R = await newParticipant('adv-text-r');
  const svc = title => ({service: {title, description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'}});
  ok(await propose(Q, terms(Q, Q, R, 5, svc('Brief for a developer \u{1F469}\u200d\u{1F4BB}'))), 201);
  ok(await propose(Q, terms(Q, Q, R, 5, svc('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 brief'))), 201);
  refused(await propose(Q, terms(Q, Q, R, 5, svc('Brief\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}'))), 400, 'invalid_field', 'tag characters (hidden text)');
  refused(await propose(Q, terms(Q, Q, R, 5, svc('Brief \u0085 x'))), 400, 'invalid_field', 'C1 control');
});

test('OQ-32: decline reasons must be text without hidden characters', async () => {
  const Q = await newParticipant('adv-reason-q'), R = await newParticipant('adv-reason-r');
  const d = ok(await propose(Q, terms(Q, Q, R, 5)), 201), h = d.current.terms_hash;
  const dec = (reason, sigReason = reason) => call('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: null}, R.agent)
    .then(async () => call('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: await sign(R, statements.decline(h, String(sigReason ?? '')))}, R.agent));
  refused(await dec(42, '42'), 400, 'invalid_field', 'a number as the reason');
  refused(await dec('no thanks\u202eevil'), 400, 'invalid_field', 'bidi override in a reason');
  assert.equal(ok(await dec('No thanks.\n')).status, 'declined');
});

test('OQ-34: a display name cannot be reserved or copy an existing handle, and a handle cannot copy a display name', async () => {
  const inv = async () => ok(await call('POST', '/admin/invites', {note: 'oq34'}, null, ADM), 201).code;
  refused(await call('POST', '/join', {invite: await inv(), handle: 'adv-oq34a', operator: 'x', display_name: 'Valun'}), 409, 'display_name_taken', 'reserved word as display name');
  ok(await call('POST', '/join', {invite: await inv(), handle: 'adv-oq34b', operator: 'x', display_name: 'Unique Display 34'}), 201);
  refused(await call('POST', '/join', {invite: await inv(), handle: 'unique-display-34', operator: 'x'}), 409, 'handle_taken', 'handle copying a display name');
  refused(await call('POST', '/join', {invite: await inv(), handle: 'adv-oq34c', operator: 'x', display_name: 'adv-oq34b'}), 409, 'display_name_taken', 'display name copying a handle');
});
