// The legacy synthetic desk (/api, /mcp; lib/http.mjs, lib/mcp.mjs) is read-only on a hosted deployment with no demo
// passphrase (fix inbox #64): POST /api answers 403 writes_closed and the MCP write tools refuse, while reads work. A
// local or test deployment, or one with a passphrase, keeps the old behaviour. No tracker: the gate is checked before any
// route or tool runs. Run: node --test test/legacy-desk-closed.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHandler} from '../lib/http.mjs';
import {createMcp} from '../lib/mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = [];
after(() => { for (const s of servers) s.close(); });
// A service whose writes record that they ran, so a refused write is proven not to have reached it.
function stubService(cfg) {
  const ran = [];
  return {ran, service: {
    status: async () => ({deployment: cfg.deployment, writeTokenRequired: !!cfg.writeToken, writesClosed: cfg.deployment === 'hosted' && !cfg.writeToken}),
    participants: async () => [], offers: () => [],
    createParticipant: async b => { ran.push(['createParticipant', b]); return {id: 'p-0001'}; },
    createOffer: async b => { ran.push(['createOffer', b]); return {id: 'o-0001'}; },
  }};
}
async function serve(cfg) {
  const {service, ran} = stubService(cfg);
  const server = http.createServer(createHandler({service, mcp: createMcp({service, store: {state: {participants: {}, offers: {}}}}), cfg, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  return {base, ran, post};
}

test('hosted with no passphrase: POST /api is 403 writes_closed, nothing runs; GET /api/status says so', async () => {
  const {base, ran, post} = await serve({deployment: 'hosted', writeToken: ''});
  const r = await post('/api/participants', {name: 'Atlas'});
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error, 'writes_closed');
  assert.match(body.message, /read-only on this hosted deployment \(fix inbox #64\)/);
  assert.equal((await post('/api/offers', {})).status, 403);
  assert.deepEqual(ran, [], 'no write reached the service');
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual([st.writeTokenRequired, st.writesClosed], [false, true]);
});

test('hosted with no passphrase: the MCP write tools refuse, the read tools still answer', async () => {
  const {base, ran} = await serve({deployment: 'hosted', writeToken: ''});
  const rpc = async (name, args) => (await (await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})})).json()).result;
  const w = await rpc('create_participant', {name: 'Atlas', kind: 'agent'});
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /^Changes are closed on this hosted deployment/);
  assert.deepEqual(ran, []);
  const tools = (await (await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'})})).json()).result.tools;
  assert.ok(tools.length > 0);
});

test('a local deployment, or a hosted one with a passphrase, keeps the old gate', async () => {
  const local = await serve({deployment: 'local', writeToken: ''});
  assert.equal((await local.post('/api/participants', {name: 'Atlas'})).status, 201, 'local: open as before');
  const hosted = await serve({deployment: 'hosted', writeToken: 'pass-123'});
  assert.equal((await hosted.post('/api/participants', {name: 'Atlas'})).status, 401, 'hosted with a passphrase: the token is required');
  assert.equal((await hosted.post('/api/participants', {name: 'Atlas'}, {'x-valun-token': 'pass-123'})).status, 201);
});
