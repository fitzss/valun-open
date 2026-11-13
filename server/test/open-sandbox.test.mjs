// Self-serve sandbox joining (Pilot openSandbox): no invite, deals only with the sandbox agents, small limits that the
// participant's own owner token cannot raise, a fixed expiry, a per-address join limit; off by default.
// Real HTTP, throwaway REAL Basis tracker on port 3102.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {createPilotRoutes, SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {Sandbox, textStats} from '../lib/pilot/sandbox.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

let tracker, basis, pilot, sandbox, on, off;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function serve(p) {
  const routes = createPilotRoutes({pilot: p, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha('admin-secret')});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}
before(async () => {
  tracker = await startTracker(3102, {servedTokenId: PILOT_TOKEN_ID});
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-open-sandbox-'));
  pilot = new Pilot({store: new PilotStore(dir), basis, openSandbox: true});
  sandbox = await new Sandbox(pilot, {dataDir: dir, intervalMs: 150}).start();
  on = await serve(pilot);
  off = await serve(new Pilot({store: new PilotStore(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-closed-'))), basis}));
});
after(async () => { sandbox?.stop(); on?.server.close(); off?.server.close(); await tracker?.stop(); });

const call = async (at, method, p, body, token, headers = {}) => {
  const r = await fetch(at.base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: body && JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, status, code, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`); assert.equal(r.body?.error, code, what); };
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
async function enroll(j) {
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call(on, 'POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  return {id: j.participant_id, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
}
function terms(P, Q, price, service) {
  const now = Date.now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + crypto.randomBytes(8).toString('hex'), version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'),
    proposer: P.id, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, service,
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * 3600e3).toISOString(), offer_expires_at: new Date(now + 24 * 3600e3).toISOString()};
}
async function propose(P, t) { const h = termsHash(t); return call(on, 'POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent); }
const job = text => ({title: 'text-stats job', description: 'text-stats for:\n```\n' + text + '\n```', deliverable: 'JSON'});

test('off by default: the route does not exist', async () => {
  refused(await call(off, 'POST', '/join-sandbox', {handle: 'closed-1', operator: 'x'}), 404, 'not_found', 'disabled server');
});

test('a stranger joins without an invite, deals with sandbox-exact, and cannot leave the sandbox', async () => {
  const j = ok(await call(on, 'POST', '/join-sandbox', {handle: 'stranger-1', operator: 'a stranger'}), 201);
  assert.equal(j.sandbox_only, true);
  const S = await enroll(j);
  const exact = pilot.s.participants[sandbox.keys['sandbox-exact'].id];
  const d0 = ok(await propose(S, terms(S, exact, 3, job('hello sandbox world'))), 201);
  let d;
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    d = ok(await call(on, 'GET', `/deals/${d0.id}`, null, S.agent));
    if (d.status === 'delivered') break;
  }
  assert.equal(d.status, 'delivered');
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(d.delivery.content)[1]), textStats('hello sandbox world'));
  // A normal participant (invited) is outside the box.
  const inv = ok(await call(on, 'POST', '/admin/invites', {note: 'normal'}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const N = await enroll(ok(await call(on, 'POST', '/join', {invite: inv.code, handle: 'normal-1', operator: 'someone'}), 201));
  ok(await call(on, 'PUT', '/owner/mandate', {approve_above: 1000}, N.owner));
  const r = await propose(S, terms(S, pilot.s.participants[N.id], 3, job('x')));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  // Its own owner cannot widen the box.
  refused(await call(on, 'PUT', '/owner/mandate', {counterparties: 'any'}, S.owner), 403, 'sandbox_only', 'counterparties any');
  refused(await call(on, 'PUT', '/owner/mandate', {counterparties: [N.id]}, S.owner), 403, 'sandbox_only', 'another counterparty');
  refused(await call(on, 'PUT', '/owner/mandate', {max_issue_per_deal: 50}, S.owner), 403, 'sandbox_only', 'higher limit');
  refused(await call(on, 'PUT', '/owner/mandate', {expires_at: new Date(Date.now() + 30 * 864e5).toISOString()}, S.owner), 403, 'sandbox_only', 'longer expiry');
  ok(await call(on, 'PUT', '/owner/mandate', {max_issue_per_deal: 4}, S.owner));                    // lowering is fine
  const dir = ok(await call(on, 'GET', '/participants'));
  const me = (Array.isArray(dir) ? dir : dir.participants).find(p => p.id === S.id);
  assert.equal(me.sandbox_only, true);
});

test('at most 12 sandbox joins per address per hour (guests at one venue share an address)', async () => {
  assert.equal(SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, 12);
  const st = [];
  for (let i = 0; i < 13; i++) st.push((await call(on, 'POST', '/join-sandbox', {handle: `burst-${i}`, operator: 'x'})).status);
  // stranger-1 above came from the same address: the burst gets 11 x 201, then 429s
  assert.deepEqual(st, [...Array(11).fill(201), 429, 429], st.join(','));
  const r = await call(on, 'POST', '/join-sandbox', {handle: 'burst-x', operator: 'x'});
  assert.equal(r.body?.message, 'at most 12 sandbox joins per hour from one address (an IPv6 /48)');
});

test('a server-wide cap: at most 200 new sandbox participants a day, whatever the addresses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-cap-'));
  const p = new Pilot({store: new PilotStore(dir), basis, openSandbox: true});
  p.sandboxIds = new Set([...pilot.sandboxIds]);
  for (const id of p.sandboxIds) p.s.participants[id] = pilot.s.participants[id];       // the sandbox agents exist here too
  const now = new Date().toISOString();
  for (let i = 0; i < 200; i++) p.s.participants['vp_' + String(i).padStart(12, '0')] = {id: 'vp_' + String(i).padStart(12, '0'), handle: 'cap' + i, sandbox_only: true, created_at: now};
  await assert.rejects(() => p.joinSandbox({handle: 'one-too-many', operator: 'x'}), e => e.code === 'sandbox_full' && e.status === 503);
});
