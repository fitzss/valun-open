// MCP endpoint tests over real HTTP, against a throwaway REAL Basis tracker (port 3051).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Store} from '../lib/store.mjs';
import {Valun} from '../lib/valun.mjs';
import {createService} from '../lib/service.mjs';
import {createMcp} from '../lib/mcp.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-passphrase-123';
let tracker, server, base, id = 0;

before(async () => {
  tracker = await startTracker(3051);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-mcp-')));
  const basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, runSigner: makeSignerRunner({mode: runner, signerPath})});
  const valun = new Valun({store, basis});
  const cfg = {deployment: 'test', writeToken: TOKEN, basisPin: 'test'};
  const service = createService({valun, basis, store, cfg, testnetLive: async () => ({allMatch: true, boxes: [], network: {height: 1}})});
  server = http.createServer(createHandler({service, mcp: createMcp({service, store}), cfg, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await tracker?.stop(); });

const rpc = async (method, params, {token, headers = {}} = {}) => {
  const r = await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  return {status: r.status, body: r.status === 202 ? null : await r.json()};
};
const tool = async (name, args = {}, token = TOKEN) => {
  const {body} = await rpc('tools/call', {name, arguments: args}, {token});
  assert.ok(body.result, `${name}: ${JSON.stringify(body.error)}`);
  return body.result;
};

test('initialize negotiates the protocol and describes the server', async () => {
  const {status, body} = await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}});
  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.equal(body.result.serverInfo.name, 'valun');
  assert.ok(body.result.capabilities.tools);
  assert.match(body.result.instructions, /SYNTHETIC demo/);
  const r = await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})});
  assert.equal(r.status, 202);
  assert.equal((await rpc('initialize', {protocolVersion: '1999-01-01'})).body.result.protocolVersion, '2025-11-25');
});

test('tools/list: twelve tools with schemas and read-only hints', async () => {
  const {tools} = (await rpc('tools/list')).body.result;
  assert.equal(tools.length, 12);
  for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.equal(typeof t.annotations.readOnlyHint, 'boolean'); }
  assert.equal(tools.find(t => t.name === 'inspect_offer').annotations.readOnlyHint, true);
  assert.match(tools.find(t => t.name === 'decide_offer').description, /passphrase/);
});

test('without the passphrase: reads work, changes are refused as tool errors', async () => {
  const r = await tool('valun_overview', {}, null);
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.writeTokenRequired, true);
  const w = await tool('create_participant', {name: 'Nobody'}, null);
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /passphrase/);
  const wrong = await tool('create_participant', {name: 'Nobody'}, 'wrong-passphrase-xx');
  assert.equal(wrong.isError, true);
});

test('an agent completes the credit flow through MCP tools against the real tracker', async () => {
  const a = (await tool('create_participant', {name: 'Ada', kind: 'agent'})).structuredContent;
  const b = (await tool('create_participant', {name: 'Bo', kind: 'operator'})).structuredContent;
  assert.match(a.pubkey, /^0[23][0-9a-f]{64}$/);
  const pol = await tool('set_acceptance_policy', {participantId: b.id, mode: 'whitelist', trustedIds: [a.id], maxDebtErg: '2'});
  assert.equal(pol.structuredContent.maxDebtErg, '2');
  const offer = (await tool('offer_credit', {issuerId: a.id, recipientId: b.id, amountErg: '1.25', purpose: 'MCP test'})).structuredContent;
  assert.equal(offer.status, 'offered');
  assert.equal(offer.cumulativeAfterErg, '1.25');
  const inbox = (await tool('list_offers', {participantId: b.id, role: 'recipient', status: 'offered'})).structuredContent.items;
  assert.deepEqual(inbox.map(o => o.id), [offer.id]);
  const insp = (await tool('inspect_offer', {offerId: offer.id})).structuredContent;
  assert.deepEqual([insp.checks.issuerSignatureValid, insp.checks.stale, insp.checks.policyCheck.acceptable], [true, false, true]);
  const done = (await tool('decide_offer', {offerId: offer.id, actorId: b.id, decision: 'accept', reason: 'trusted'})).structuredContent;
  assert.equal(done.status, 'issued');
  assert.deepEqual([done.issuance.readBackMatches, done.issuance.signatureVerifiedByValun, done.issuance.confirmation], [true, true, 'local_only']);
  assert.equal((await tool('get_position', {participantId: b.id})).structuredContent.claimsHeldErg, '1.25');
  const led = (await tool('get_ledger')).structuredContent;
  assert.deepEqual(led.notes.map(n => [n.issuer, n.recipient, n.cumulativeErg]), [['Ada', 'Bo', '1.25']]);
  assert.ok(led.reconciliation.every(r => r.status === 'match'));
  const again = await tool('decide_offer', {offerId: offer.id, actorId: b.id, decision: 'accept'});
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /not open/);
});

test('errors: unknown tool, bad arguments, transport rules', async () => {
  assert.equal((await rpc('tools/call', {name: 'nope', arguments: {}})).body.error.code, -32602);
  assert.equal((await rpc('no/such/method')).body.error.code, -32601);
  assert.equal((await tool('get_position', {participantId: 'p-0001', extra: 1})).isError, true);
  assert.match((await tool('inspect_offer', {offerId: 'o-9999'})).content[0].text, /unknown offer/);
  assert.match((await tool('offer_credit', {issuerId: 'p-0001'})).content[0].text, /missing required argument "recipientId"/);
  const bad = await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{nope'});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await rpc('ping', {}, {headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await rpc('ping', {}, {headers: {'mcp-protocol-version': '1999-01-01'}})).status, 400);
});

test('the stdio bridge carries a real session to the HTTP endpoint', async () => {
  const p = spawn(process.execPath, [path.join(root, 'scripts', 'valun-mcp-stdio.mjs')], {env: {...process.env, VALUN_MCP_URL: `${base}/mcp`, VALUN_TOKEN: TOKEN}, stdio: ['pipe', 'pipe', 'inherit']});
  const lines = [];
  p.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
  const send = m => p.stdin.write(JSON.stringify({jsonrpc: '2.0', ...m}) + '\n');
  send({id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'bridge-test', version: '1'}}});
  send({method: 'notifications/initialized'});
  send({id: 2, method: 'tools/list'});
  send({id: 3, method: 'tools/call', params: {name: 'create_participant', arguments: {name: 'Bridge'}}});
  p.stdin.end();
  await new Promise(r => p.on('exit', r));
  const replies = lines.map(l => JSON.parse(l));
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3], 'one reply per request, none for the notification');
  assert.equal(replies[1].result.tools.length, 12);
  assert.equal(replies[2].result.isError, false, 'the passphrase from VALUN_TOKEN was forwarded');
});
