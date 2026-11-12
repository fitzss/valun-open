// The open network (Pilot openNetwork, PILOT_OPEN_NETWORK=1): self-serve participants deal with any participant whose own
// mandate allows it (other self-serve participants and invited participants, not only the sandbox agents), within the
// sandbox limits and days; at most OPEN_NETWORK_MAX_OPEN_OFFERS offers of their own open at once; the public profile
// (PUT /profile); GET /info's self_serve block. Turning the network off boxes self-serve participants in again at once,
// whatever their mandates say. Real HTTP, throwaway REAL Basis tracker on port 3141.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, NETWORK, PROTOCOL, OPEN_NETWORK_MAX_OPEN_OFFERS} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {Sandbox} from '../lib/pilot/sandbox.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

let tracker, basis, pilot, sandbox, on;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

before(async () => {
  tracker = await startTracker(3141, {servedTokenId: PILOT_TOKEN_ID});
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-open-network-'));
  pilot = new Pilot({store: new PilotStore(dir), basis, openSandbox: true, openNetwork: true});
  sandbox = await new Sandbox(pilot, {dataDir: dir, intervalMs: 150}).start();
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha('admin-secret')});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  on = {server, base: `http://127.0.0.1:${server.address().port}`};
});
after(async () => { sandbox?.stop(); on?.server.close(); await tracker?.stop(); });

const call = async (method, p, body, token, headers = {}) => {
  const r = await fetch(on.base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: body && JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, status, code, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`); assert.equal(r.body?.error, code, what); };
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
async function enroll(j) {
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  return {id: j.participant_id, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token, handle: j.handle};
}
const stranger = async (handle, extra = {}) => enroll(ok(await call('POST', '/join-sandbox', {handle, operator: 'a stranger', ...extra}), 201));
function terms(P, Q, price) {
  const now = Date.now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + crypto.randomBytes(8).toString('hex'), version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'),
    proposer: P.id, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey},
    service: {title: 'Haiku about credit', description: 'Write one haiku about agents trusting each other.', deliverable: 'three lines of text'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * 3600e3).toISOString(), offer_expires_at: new Date(now + 24 * 3600e3).toISOString()};
}
async function propose(P, t) { const h = termsHash(t); return call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent); }
async function accept(P, id) { const d = ok(await call('GET', `/deals/${id}`, null, P.agent)); const h = d.current.terms_hash; return call('POST', `/deals/${id}/accept`, {terms_hash: h, signature: await sign(P, statements.accept(h))}, P.agent); }
async function deliver(P, id, content) {
  const d = ok(await call('GET', `/deals/${id}`, null, P.agent)), h = d.agreement.terms_hash, dh = sha(content);
  return call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(P, statements.deliver(h, dh))}, P.agent);
}
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  const note = await basis.signHex(P.pubkey, message_hex, P.secret);
  return call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: note}}, P.agent);
}
const participant = id => pilot.s.participants[id];

let S1, S2;
test('two strangers who joined without an invite deal with each other: offer, acceptance, delivery, credit note', async () => {
  S1 = await stranger('open-buyer', {about: 'buys haiku'});
  S2 = await stranger('open-poet', {about: 'writes haiku', services: 'haiku-on-demand: one haiku, 3 PC'});
  assert.equal(participant(S2.id).services, 'haiku-on-demand: one haiku, 3 PC', 'services kept at a self-serve join');
  assert.equal(participant(S1.id).mandate.counterparties, 'any');
  const d0 = ok(await propose(S1, terms(S1, participant(S2.id), 3)), 201);
  assert.equal(d0.status, 'open');
  assert.ok(ok(await call('GET', '/inbox', null, S2.agent)).respond.some(i => i.deal_id === d0.id), 'the offer is in the other stranger\'s inbox');
  assert.equal(ok(await accept(S2, d0.id)).status, 'agreed');
  assert.equal(ok(await deliver(S2, d0.id, 'promises in a loop\nwork done, the debt cancels\nmachines keep their word')).status, 'delivered');
  const done = ok(await complete(S1, d0.id));
  assert.equal(done.status, 'note_issued', JSON.stringify(done));
  const l = ok(await call('GET', '/ledger'));
  assert.ok(l.notes.some(n => n.issuer === S1.id && n.recipient === S2.id && n.outstanding === 3), 'the credit note is on the tracker');
});

test('a stranger can offer work to an invited participant, who answers it as any offer', async () => {
  const inv = ok(await call('POST', '/admin/invites', {note: 'invited'}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const N = await enroll(ok(await call('POST', '/join', {invite: inv.code, handle: 'invited-1', operator: 'someone'}), 201));
  ok(await call('PUT', '/owner/mandate', {approve_above: 1000}, N.owner));
  const d0 = ok(await propose(S1, terms(S1, participant(N.id), 2)), 201);
  assert.equal(ok(await accept(N, d0.id)).status, 'agreed');
  // The invited owner can still keep strangers out: its own counterparty list.
  ok(await call('PUT', '/owner/mandate', {counterparties: [S2.id]}, N.owner));
  const d1 = ok(await propose(S1, terms(S1, participant(N.id), 2)), 201);
  const r = await accept(N, d1.id);
  refused(r, 403, 'mandate_exceeded', 'not on the invited owner\'s list');
  assert.equal(r.body.rule, 'counterparties');
});

test('the sandbox limits stay: 5 PC per deal, an expiry its owner cannot extend, limits it can only lower', async () => {
  const r = await propose(S1, terms(S1, participant(S2.id), 6));
  refused(r, 403, 'mandate_exceeded', 'above 5 PC');
  assert.equal(r.body.rule, 'max_issue_per_deal');
  refused(await call('PUT', '/owner/mandate', {max_issue_per_deal: 50}, S1.owner), 403, 'sandbox_only', 'higher limit');
  refused(await call('PUT', '/owner/mandate', {expires_at: new Date(Date.now() + 30 * 864e5).toISOString()}, S1.owner), 403, 'sandbox_only', 'longer expiry');
  // Its owner may name counterparties freely now (a list, or any), and lower a limit.
  ok(await call('PUT', '/owner/mandate', {counterparties: [S2.id]}, S1.owner));
  ok(await call('PUT', '/owner/mandate', {counterparties: 'any', max_issue_per_deal: 4}, S1.owner));
  refused(await propose(S1, terms(S1, participant(S2.id), 5)), 403, 'mandate_exceeded', 'above its own lower limit');
  ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 5}, S1.owner));
});

test(`at most ${OPEN_NETWORK_MAX_OPEN_OFFERS} offers of its own open at once; withdrawing one makes room`, async () => {
  const S3 = await stranger('open-flooder'), target = participant(S2.id), open = [];
  for (let i = 0; i < OPEN_NETWORK_MAX_OPEN_OFFERS; i++) open.push(ok(await propose(S3, terms(S3, target, 1)), 201).id);
  refused(await propose(S3, terms(S3, target, 1)), 429, 'too_many_open_offers', 'one offer too many');
  const d = ok(await call('GET', `/deals/${open[0]}`, null, S3.agent)), h = d.current.terms_hash;
  ok(await call('POST', `/deals/${open[0]}/withdraw`, {terms_hash: h, signature: await sign(S3, statements.withdraw(h))}, S3.agent));
  ok(await propose(S3, terms(S3, target, 1)), 201);
});

test('the public profile: an agent says what it offers; join\'s checks hold', async () => {
  const r = ok(await call('PUT', '/profile', {services: 'haiku-on-demand (3 PC), limerick (2 PC)', about: 'A poet agent.'}, S2.agent));
  assert.deepEqual(r.changed.sort(), ['about', 'services']);
  const pub = ok(await call('GET', `/participants/${S2.id}`));
  assert.equal(pub.services, 'haiku-on-demand (3 PC), limerick (2 PC)');
  assert.equal(pub.about, 'A poet agent.');
  assert.deepEqual(ok(await call('PUT', '/profile', {about: 'A poet agent.'}, S2.owner)).changed, [], 'the same text changes nothing');
  refused(await call('PUT', '/profile', {about: 'hidden‮text'}, S2.agent), 400, 'invalid_field', 'bidi override');
  refused(await call('PUT', '/profile', {services: 'x'.repeat(301)}, S2.agent), 400, 'invalid_field', 'too long');
  refused(await call('PUT', '/profile', {display_name: 'open-buyer'}, S2.agent), 409, 'display_name_taken', 'another participant\'s handle');
  refused(await call('PUT', '/profile', {}, S2.agent), 400, 'invalid_field', 'nothing to change');
  refused(await call('PUT', '/profile', {about: 'x'}), 401, 'unauthorized', 'no token');
});

test('wants: what an agent pays others for, public like services; join\'s checks hold', async () => {
  const want = 'translations of short READMEs into Spanish (3 PC)';
  const r = ok(await call('PUT', '/profile', {wants: want}, S2.agent));
  assert.deepEqual(r.changed, ['wants']);
  assert.equal(ok(await call('GET', `/participants/${S2.id}`)).wants, want);
  assert.equal(ok(await call('GET', '/participants')).find(x => x.id === S2.id).wants, want, 'in the directory');
  assert.equal(ok(await call('GET', '/me', null, S2.agent)).participant.wants, want, 'in /me');
  assert.deepEqual(ok(await call('PUT', '/profile', {wants: want}, S2.owner)).changed, [], 'the same text changes nothing');
  assert.equal('wants' in ok(await call('GET', `/participants/${S1.id}`)), false, 'an agent that named none: no wants key (v15 shape)');
  assert.deepEqual(ok(await call('PUT', '/profile', {wants: ''}, S1.agent)).changed, [], 'clearing what was never set changes nothing');
  refused(await call('PUT', '/profile', {wants: 'x'.repeat(301)}, S2.agent), 400, 'invalid_field', 'too long');
  refused(await call('PUT', '/profile', {wants: 'pay\u202efor'}, S2.agent), 400, 'invalid_field', 'bidi override');
  assert.deepEqual(ok(await call('PUT', '/profile', {wants: ''}, S2.agent)).changed, ['wants'], 'cleared');
  assert.equal('wants' in ok(await call('GET', `/participants/${S2.id}`)), false, 'cleared: the key is gone again');
  // A self-serve join keeps them, with the open network on.
  const S5 = await stranger('open-payer', {wants: 'haiku reviews (1 PC)'});
  assert.equal(participant(S5.id).wants, 'haiku reviews (1 PC)');
  refused(await call('POST', '/join-sandbox', {handle: 'bad-wants', operator: 'a stranger', wants: 'x'.repeat(301)}), 400, 'invalid_field', 'join: too long');
});

test('GET /info says how to join without an invite and what the limits are', async () => {
  const i = ok(await call('GET', '/info'));
  assert.deepEqual(i.self_serve, {join: '/pilot/v1/join-sandbox', open_network: true, days: 7,
    limits: {max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40, max_claims_total: 40},
    max_open_offers: OPEN_NETWORK_MAX_OPEN_OFFERS, renews_while_active: true});
});

test('turning the open network off boxes self-serve participants in at once, whatever their mandates say', async () => {
  pilot.openNetwork = false;
  try {
    assert.equal(participant(S1.id).mandate.counterparties, 'any');
    const r = await propose(S1, terms(S1, participant(S2.id), 1));
    refused(r, 403, 'mandate_exceeded', 'stranger to stranger, network off');
    assert.equal(r.body.rule, 'counterparties');
    // The sandbox agents are still there for them.
    ok(await propose(S1, terms(S1, participant(sandbox.keys['sandbox-exact'].id), 1)), 201);
    // A new joiner gets the old box, and its owner cannot widen it.
    const S4 = await stranger('boxed-again', {services: 'ignored while boxed', wants: 'ignored while boxed'});
    assert.deepEqual([...participant(S4.id).mandate.counterparties].sort(), [...pilot.sandboxIds].sort());
    assert.equal(participant(S4.id).services, '');
    assert.equal(participant(S4.id).wants, '');
    refused(await call('PUT', '/owner/mandate', {counterparties: 'any'}, S4.owner), 403, 'sandbox_only', 'counterparties any while boxed');
    assert.equal(ok(await call('GET', '/info')).self_serve.open_network, false);
  } finally { pilot.openNetwork = true; }
});

test('an active self-serve agent stays: renewed when seen with under 6 days left, woken when it had ended; an owner\'s earlier expiry is kept', async () => {
  const S5 = await stranger('renew-me'), p = participant(S5.id), day = 864e5;
  const first = p.sandbox_expires_at;
  ok(await call('GET', '/me', null, S5.agent));
  assert.equal(p.sandbox_expires_at, first, 'a fresh join (7 days left) is not renewed');
  // 2 days left: the next agent request renews the sandbox time and the mandate expiry to 7 days from now.
  const soon = new Date(Date.now() + 2 * day).toISOString();
  p.sandbox_expires_at = soon; p.mandate.expires_at = soon;
  ok(await call('GET', '/me', null, S5.agent));
  assert.ok(Date.parse(p.sandbox_expires_at) > Date.now() + 6.9 * day, 'renewed to about 7 days');
  assert.equal(p.mandate.expires_at, p.sandbox_expires_at);
  assert.equal(p.mandate_changed_by, 'operator');
  // Ended (dormant): the agent coming back wakes it up, and it can deal again.
  const past = new Date(Date.now() - day).toISOString();
  p.sandbox_expires_at = past; p.mandate.expires_at = past;
  assert.equal(pilot.dormant(p), true);
  ok(await call('GET', '/me', null, S5.agent));
  assert.equal(pilot.dormant(p), false);
  ok(await propose(S5, terms(S5, participant(S2.id), 1)), 201);
  // The owner set an earlier mandate expiry: the sandbox time is renewed, the owner's expiry is kept.
  const ownerEnd = new Date(Date.now() + 1 * day).toISOString();
  p.sandbox_expires_at = new Date(Date.now() + 3 * day).toISOString();
  ok(await call('PUT', '/owner/mandate', {expires_at: ownerEnd}, S5.owner));
  ok(await call('GET', '/me', null, S5.agent));
  assert.ok(Date.parse(p.sandbox_expires_at) > Date.now() + 6.9 * day);
  assert.equal(Date.parse(p.mandate.expires_at), Date.parse(ownerEnd));
  // The owner token does not renew it: only the agent being active does.
  p.sandbox_expires_at = soon;
  ok(await call('GET', '/me', null, S5.owner));
  assert.equal(p.sandbox_expires_at, soon);
  // Without the open network there is no renewal.
  pilot.openNetwork = false;
  try { ok(await call('GET', '/me', null, S5.agent)); assert.equal(p.sandbox_expires_at, soon); } finally { pilot.openNetwork = true; }
});

test('the directory leaves out what the operator unlisted (?all=1 lists it, marked); always-on agents show as seen now', async () => {
  const T = await stranger('test-agent-x'), admin = {'x-valun-admin': 'admin-secret'};
  const has = async (q, id) => ok(await call('GET', '/participants' + q)).some(x => x.id === id);
  assert.equal(await has('', T.id), true);
  const r = ok(await call('PUT', `/admin/participants/${T.id}/listing`, {listed: false}, null, admin));
  assert.deepEqual([r.listed, r.changed, r.participant.unlisted], [false, true, true]);
  assert.equal(await has('', T.id), false, 'not in the directory');
  const all = ok(await call('GET', '/participants?all=1')).find(x => x.id === T.id);
  assert.equal(all.unlisted, true, 'listed with ?all=1, marked');
  assert.equal(ok(await call('GET', `/participants/${T.id}`)).unlisted, true, 'its own record still reads');
  ok(await call('GET', '/me', null, T.agent));                                   // it is still a participant that can act
  assert.equal(ok(await call('PUT', `/admin/participants/${T.id}/listing`, {listed: false}, null, admin)).changed, false);
  refused(await call('PUT', `/admin/participants/${T.id}/listing`, {listed: 'no'}, null, admin), 400, 'invalid_field', 'not a boolean');
  refused(await call('PUT', `/admin/participants/${T.id}/listing`, {listed: true}), 404, 'not_found', 'no admin token');
  ok(await call('PUT', `/admin/participants/${T.id}/listing`, {listed: true}, null, admin));
  assert.equal(await has('', T.id), true, 'listed again');
  // The sandbox agents the server runs are always on: seen now, not "never".
  const exact = ok(await call('GET', '/participants')).find(x => x.handle === 'sandbox-exact');
  assert.ok(Date.now() - Date.parse(exact.agent_last_seen) < 60_000, exact.agent_last_seen);
});
