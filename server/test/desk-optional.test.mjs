// Fix inbox #64 (c): the network does not depend on the legacy synthetic desk (/api, /mcp, on the demo tracker).
//   - lib/http.mjs: while deskAvailable (server.mjs, beside the network) says no, nothing reaches the desk's service or
//     MCP tools: every /api/* request answers 503 desk_unavailable, and POST /mcp answers 503 in JSON-RPC, each request
//     the desk_unavailable error with its own id and no answer for a notification (lib/mcp.mjs unavailableReply answers
//     exactly what handle() answers), so scripts/valun-mcp-stdio.mjs hands an MCP host an answer to every request; the
//     network's routes and the pages answer without asking; once it says yes, the desk answers as before (the
//     writes_closed gate included);
//   - lib/basis.mjs trackerProbe: at most one tracker read per cacheMs whatever the rate, shared while in flight; no
//     answer within timeoutMs, an error or anything but true is false; Basis.health gives up at the deadline it is
//     given, and api() keeps 10 s without one;
//   - GET /pilot/v1/health: 200 {ok: true} while the pilot tracker answers, 503 {ok: false} while it does not, with the
//     network tracker's pin; outside the public read cache; it never asks the desk;
//   - the Fly configs check GET /pilot/v1/info (no tracker read; every image has it), never the desk's /api/status;
//   - server.mjs as a process over stub trackers (no tracker binary, no signer: no sandbox agents, no seeding): beside
//     the network it starts without the demo tracker's id and without waiting for the demo tracker; the desk starts
//     with the network's start-up, and a desk request that comes while it still starts waits for it, at most 3 s, so
//     the first requests once the port opens find it ready; when the demo tracker stops answering the desk answers 503
//     desk_unavailable while the network serves, and it is back once the tracker answers again; a desk whose start-up
//     fails, or whose state cannot be read, leaves the network serving.
//     Alone, the desk still refuses to start without its tracker's id and reports an unreachable tracker as before.
// The container entrypoint's part is test/entrypoint.test.mjs. No tracker binary: it runs in the CI list.
// Run: node --test test/desk-optional.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHandler, DESK_UNAVAILABLE} from '../lib/http.mjs';
import {createMcp, unavailableReply} from '../lib/mcp.mjs';
import {createPilotRoutes, HEALTH_PROBE_MS} from '../lib/pilot/http.mjs';
import {Pilot, PilotStore, PILOT_DENOMINATION} from '../lib/pilot/core.mjs';
import {NETWORK} from '../lib/pilot/units.mjs';
import {Basis, trackerPin, trackerProbe} from '../lib/basis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const made = [], servers = [], children = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-desk-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Whether this copy of the app has the files a test runs (as in test/operations.test.mjs): in the image's copy
// (VALUN_APP_COPY=image) a missing file skips the test with the reason; anywhere else it fails the test.
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
// This process's environment without the server's own settings, so a child gets only those a test gives it.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k)));
async function listen(handler) {
  const s = http.createServer(handler); servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
const get = async (base, p, init) => { const r = await fetch(base + p, init); return {status: r.status, body: await r.json().catch(() => null)}; };
const rpc = (base, method, params = {}) => fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
// Polls fn until it returns something truthy (errors count as not yet), at most ms.
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms: ${what}`);
    await sleep(100);
  }
}
// The JSON-RPC error of POST /mcp while the desk is unavailable (lib/mcp.mjs unavailableReply).
const DESK_RPC_ERROR = Object.freeze({code: -32000, message: DESK_UNAVAILABLE.message, data: {error: 'desk_unavailable'}});
// A desk service and MCP tools that record what reached them.
function deskStub() {
  const ran = [];
  const service = {
    status: async () => { ran.push('status'); return {deployment: 'stub', writeTokenRequired: false}; },
    participants: async () => { ran.push('participants'); return []; },
    offers: () => { ran.push('offers'); return []; },
    createParticipant: async b => { ran.push('createParticipant'); return {id: 'p-0001', name: b.name}; },
  };
  return {ran, service, mcp: createMcp({service, store: {state: {participants: {}, offers: {}}}})};
}

// ---------------------------------------------------------------------------------------------------------------
// lib/http.mjs
test('lib/http.mjs: while deskAvailable says no, /api/* answers 503 desk_unavailable before anything else, POST /mcp answers 503 in JSON-RPC (each request its error, with its id), and nothing reaches the desk; the network and the pages answer without asking', async () => {
  const {ran, service, mcp} = deskStub();
  let available = false, asked = 0;
  const pilotRoutes = (req, res, url, send) => send(res, 200, {network: 'stub', path: url.pathname});
  const handler = cfg => createHandler({service, mcp, cfg, publicDir: path.join(root, 'public'), pilotRoutes,
    deskAvailable: async () => { asked += 1; return available; }});
  const base = await listen(handler({deployment: 'local', writeToken: ''}));
  const desk = [['GET', '/api/status'], ['GET', '/api/participants'], ['GET', '/api/offers'], ['GET', '/api/no-such-route'], ['POST', '/api/participants', {name: 'Atlas'}]];
  for (const [method, p, body] of desk) {
    const r = await get(base, p, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    assert.deepEqual(r, {status: 503, body: DESK_UNAVAILABLE}, `${method} ${p}`);
  }
  assert.equal(DESK_UNAVAILABLE.error, 'desk_unavailable');
  assert.match(DESK_UNAVAILABLE.message, /its demo tracker is starting, stopped or not answering \(fix inbox #64\); the Valun network is under \/pilot\/v1/);
  // POST /mcp: HTTP 503, and in JSON-RPC (review of fix inbox #64: a plain {error, message} body reached an MCP host
  // through scripts/valun-mcp-stdio.mjs as a line with no id, so the host never had an answer to its request).
  for (const [method, params] of [['initialize'], ['tools/list'], ['tools/call', {name: 'create_participant', arguments: {name: 'Atlas'}}]]) {
    const r = await rpc(base, method, params);
    assert.equal(r.status, 503, method);
    assert.deepEqual(await r.json(), {jsonrpc: '2.0', id: 1, error: DESK_RPC_ERROR}, method);
  }
  const post = body => fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  // A batch: one error per request, each with its own id, none for the notifications (a tools/call notification
  // included, which handle() would run).
  const batch = await post([{jsonrpc: '2.0', id: 2, method: 'ping'}, {jsonrpc: '2.0', method: 'notifications/initialized'},
    {jsonrpc: '2.0', method: 'tools/call', params: {name: 'create_participant', arguments: {name: 'Quiet'}}}, {jsonrpc: '2.0', id: 'x', method: 'tools/list'}]);
  assert.equal(batch.status, 503);
  assert.deepEqual(await batch.json(), [{jsonrpc: '2.0', id: 2, error: DESK_RPC_ERROR}, {jsonrpc: '2.0', id: 'x', error: DESK_RPC_ERROR}]);
  // Nothing but notifications: an empty 503 (JSON-RPC answers no notification; 202 would say it was accepted).
  for (const body of [{jsonrpc: '2.0', method: 'notifications/initialized'}, [{jsonrpc: '2.0', method: 'notifications/initialized'}]]) {
    const r = await post(body);
    assert.deepEqual([r.status, await r.text()], [503, ''], JSON.stringify(body));
  }
  const mcpAsks = 6;
  // The transport's own checks answer as they do with the desk available, without asking: they need no desk.
  assert.equal((await fetch(`${base}/mcp`)).status, 405, 'GET');
  assert.equal((await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example'}, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'})).status, 403, 'cross-origin');
  const version = await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', 'mcp-protocol-version': '1999-01-01'}, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'});
  assert.deepEqual([version.status, (await version.json()).error.code], [400, -32600], 'unsupported protocol version');
  const notJson = await fetch(`${base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{nope'});
  assert.deepEqual([notJson.status, await notJson.json()], [400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}}], 'not JSON');
  assert.deepEqual(ran, [], 'nothing reached the desk');
  assert.equal(asked, desk.length + mcpAsks);
  // The network's routes and the pages never ask.
  assert.deepEqual(await get(base, '/pilot/v1/health'), {status: 200, body: {network: 'stub', path: '/pilot/v1/health'}});
  for (const p of ['/skill.md', '/network', '/']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal(asked, desk.length + mcpAsks, 'only a desk request asks whether the desk is available');
  // Once it says yes, the desk answers as before.
  available = true;
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/participants`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"Atlas"}'})).status, 201);
  const call = await (await rpc(base, 'tools/call', {name: 'create_participant', arguments: {name: 'Bramble'}})).json();
  assert.equal(call.result.isError, false);
  assert.equal((await post({jsonrpc: '2.0', method: 'notifications/initialized'})).status, 202, 'a notification: 202 as before');
  assert.deepEqual(ran, ['status', 'createParticipant', 'createParticipant']);
  // On a hosted deployment without a passphrase: desk_unavailable comes before writes_closed (fix inbox #64 (b)); once
  // the desk is available, writes_closed as before.
  const hosted = await listen(handler({deployment: 'hosted', writeToken: ''}));
  available = false;
  assert.deepEqual(await get(hosted, '/api/participants', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"Cora"}'}), {status: 503, body: DESK_UNAVAILABLE});
  available = true;
  const closed = await get(hosted, '/api/participants', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"Cora"}'});
  assert.deepEqual([closed.status, closed.body.error], [403, 'writes_closed']);
  assert.deepEqual(ran, ['status', 'createParticipant', 'createParticipant'], 'no write ran');
});

test('lib/http.mjs: without deskAvailable (the desk alone, the other tests) no desk request is checked', async () => {
  const {ran, service, mcp} = deskStub();
  const base = await listen(createHandler({service, mcp, cfg: {deployment: 'local'}, publicDir: path.join(root, 'public')}));
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  assert.equal((await rpc(base, 'tools/list')).status, 200);
  assert.equal((await fetch(`${base}/pilot/v1/health`)).status, 404, 'no network: no /pilot/v1 route');
  assert.deepEqual(ran, ['status']);
});

test('lib/mcp.mjs unavailableReply: exactly the messages handle() answers get an answer, with the id handle() gives, and the desk_unavailable error; the others none', async () => {
  const {mcp} = deskStub();
  const msgs = [
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}, {jsonrpc: '2.0', id: 'two', method: 'ping'},
    {jsonrpc: '2.0', id: 3, method: 'tools/list'}, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'no_such_tool', arguments: {}}},
    {jsonrpc: '2.0', id: null, method: 'ping'}, {jsonrpc: '2.0', id: 0, method: 'no/such/method'},
    // notifications, a notifications/ method sent with an id, a tools/call sent as a notification
    {jsonrpc: '2.0', method: 'notifications/initialized'}, {jsonrpc: '2.0', id: 5, method: 'notifications/cancelled'},
    {jsonrpc: '2.0', method: 'tools/call', params: {name: 'valun_overview', arguments: {}}},
    // a client's responses
    {jsonrpc: '2.0', id: 6, result: {}}, {jsonrpc: '2.0', id: 7, error: {code: 1, message: 'x'}}, {result: null},
    // not JSON-RPC requests
    null, 0, false, '', 'text', 5, [], [1], {}, {id: 8}, {jsonrpc: '1.0', id: 9, method: 'ping'}, {jsonrpc: '2.0', id: 10}, {jsonrpc: '2.0', id: 11, method: 7},
  ];
  let answered = 0;
  for (const m of msgs) {
    const want = await mcp.handle(m, {writeAllowed: false, writesClosed: true});
    const got = unavailableReply(m, DESK_UNAVAILABLE);
    assert.equal(got === null, want === null, `answered alike: ${JSON.stringify(m)}`);
    if (want === null) continue;
    answered += 1;
    assert.deepEqual(got, {jsonrpc: '2.0', id: want.id, error: DESK_RPC_ERROR}, JSON.stringify(m));
  }
  assert.deepEqual([answered, msgs.length - answered], [19, 6], 'answered, and not');
});

test('scripts/valun-mcp-stdio.mjs while the desk is unavailable: one JSON-RPC answer per request, with its id, none for the notification (the review of fix inbox #64)', async t => {
  if (!needs(t, 'scripts/valun-mcp-stdio.mjs')) return;
  const {ran, service, mcp} = deskStub();
  const base = await listen(createHandler({service, mcp, cfg: {deployment: 'local', writeToken: ''}, publicDir: path.join(root, 'public'), deskAvailable: async () => false}));
  const p = spawn(process.execPath, [path.join(root, 'scripts', 'valun-mcp-stdio.mjs')], {env: {...cleanEnv(), VALUN_MCP_URL: `${base}/mcp`}, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true});
  children.push(p);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  const send = m => p.stdin.write(JSON.stringify({jsonrpc: '2.0', ...m}) + '\n');
  send({id: 7, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'desk-optional', version: '1'}}});
  send({method: 'notifications/initialized'});
  send({id: 8, method: 'tools/list'});
  send({id: 9, method: 'tools/call', params: {name: 'create_participant', arguments: {name: 'Bridge'}}});
  p.stdin.end();
  await new Promise(r => p.on('close', r));
  const replies = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(replies, [7, 8, 9].map(id => ({jsonrpc: '2.0', id, error: DESK_RPC_ERROR})));
  assert.deepEqual(ran, [], 'nothing reached the desk');
});

// ---------------------------------------------------------------------------------------------------------------
// lib/basis.mjs trackerProbe
test('lib/basis.mjs trackerProbe: one tracker read per cacheMs whatever the rate, shared while in flight; no answer in time, an error or anything but true is false', async () => {
  let t = 1_000_000, reads = 0, answer = true, delay = 0;
  const basis = {health: async ({timeoutMs}) => {
    reads += 1;
    assert.equal(timeoutMs, 300, 'the deadline is passed on to the read');
    if (delay) await sleep(delay);
    if (answer instanceof Error) throw answer;
    return answer;
  }};
  const probe = trackerProbe(basis, {cacheMs: 2000, timeoutMs: 300, now: () => t});
  assert.deepEqual(await Promise.all([probe(), probe(), probe()]), [true, true, true]);
  assert.equal(reads, 1, 'three calls at once: one read');
  t += 1999;
  assert.equal(await probe(), true); assert.equal(reads, 1, 'within cacheMs the answer is kept');
  answer = false; t += 1;
  assert.equal(await probe(), false); assert.equal(reads, 2, 'after cacheMs the tracker is read again');
  answer = new Error('tracker unreachable: ECONNREFUSED'); t += 2000;
  assert.equal(await probe(), false); assert.equal(reads, 3, 'an error is false');
  answer = 'yes'; t += 2000;
  assert.equal(await probe(), false, 'only true is true');
  // A read in flight is shared however long it takes; the cache window starts when its answer came.
  answer = true; delay = 150; t += 2000;
  const first = probe(); t += 10_000;
  assert.equal(probe(), first, 'one read in flight, shared');
  assert.equal(await first, true);
  assert.equal(reads, 5);
  t += 1999; assert.equal(await probe(), true); assert.equal(reads, 5);
  // No answer within timeoutMs is false, at the deadline (a health() that ignores its deadline included).
  delay = 1500; t += 2000;
  const t0 = Date.now();
  assert.equal(await probe(), false);
  assert.ok(Date.now() - t0 < 1200, `answered at the deadline (${Date.now() - t0} ms)`);
  // A basis without health() at all: false.
  assert.equal(await trackerProbe({}, {timeoutMs: 300})(), false);
});

test('lib/basis.mjs: Basis.health({timeoutMs}) gives up at its deadline with the tracker_unavailable error; without one, api() keeps its 10 s', async () => {
  const signals = [];
  // A tracker that never answers: the request ends only when its signal aborts it.
  const fetchImpl = (url, {signal}) => { signals.push(signal); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
  const basis = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: 'a'.repeat(64), runSigner: () => { throw new Error('no signing here'); }, fetchImpl});
  const t0 = Date.now();
  await assert.rejects(basis.health({timeoutMs: 200}), e => e.name === 'BasisError' && e.code === 'tracker_unavailable' && /tracker unreachable: TimeoutError/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, `gave up after ${Date.now() - t0} ms`);
  basis.health().catch(() => null);   // the default deadline: still waiting well after 200 ms
  await sleep(400);
  assert.equal(signals[1].aborted, false, 'api() without a deadline keeps 10 s');
});

// ---------------------------------------------------------------------------------------------------------------
// GET /pilot/v1/health
const V44_CAPS = Object.freeze({tracker: 'basis', build: 'valun-circulating-credit/4', commit: '321f09ba33a4358eb9af7058f9478cc46ca57e8f'});
const V44_PIN = 'Basis tracker v4.4 (anchored netting): Valun fork commit 321f09ba33a4358eb9af7058f9478cc46ca57e8f (branch circulating-credit-v4 on Basis upstream 43e2173), as the tracker reports itself';

test('GET /pilot/v1/health: 200 {ok: true} while the pilot tracker answers, 503 {ok: false} while it does not, with the network tracker\'s pin; one tracker read per HEALTH_PROBE_MS, outside the public read cache; never the desk', async () => {
  const dir = tmp(), tracker = {up: true, reads: 0}, PIN_SHA = 'ab'.repeat(32);
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, health: async () => {
    tracker.reads += 1;
    if (!tracker.up) throw new Error('tracker unreachable: ECONNREFUSED');
    return true;
  }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, circulation: 'off', trackerCaps: V44_CAPS, trackerSha256: PIN_SHA, trackerPins: [PIN_SHA], log: () => {}});
  const {ran, service, mcp} = deskStub();
  const base = await listen(createHandler({service, mcp, cfg: {}, publicDir: path.join(root, 'public'),
    pilotRoutes: createPilotRoutes({pilot, cfg: {publicCacheMs: 60_000}}), deskAvailable: async () => { throw new Error('the network never asks the desk'); }}));
  assert.equal(trackerPin(V44_CAPS, null, {pinned: true}), V44_PIN, 'precondition: the pin /api/status would show for this tracker');
  assert.deepEqual(await get(base, '/pilot/v1/health'), {status: 200, body: {ok: true, network: NETWORK, tracker: {reachable: true, pin: V44_PIN}}});
  // Many requests at once: one tracker read.
  const before = tracker.reads;
  const burst = await Promise.all(Array.from({length: 20}, () => get(base, '/pilot/v1/health')));
  assert.ok(burst.every(r => r.status === 200));
  assert.ok(tracker.reads - before <= 1, `${tracker.reads - before} reads for 20 requests`);
  // The tracker stops answering: 503 once the kept answer is older than HEALTH_PROBE_MS (well inside the public read
  // cache's 60 s here: the route is not in it).
  tracker.up = false;
  await sleep(HEALTH_PROBE_MS + 150);
  assert.deepEqual(await get(base, '/pilot/v1/health'), {status: 503, body: {ok: false, network: NETWORK, tracker: {reachable: false, pin: V44_PIN}}});
  tracker.up = true;
  await sleep(HEALTH_PROBE_MS + 150);
  assert.equal((await get(base, '/pilot/v1/health')).status, 200);
  // The pin says when the running binary is not pinned, and is null without capabilities (a tracker before v3).
  pilot.trackerSha256 = 'cd'.repeat(32);
  assert.equal((await get(base, '/pilot/v1/health')).body.tracker.pin, `${V44_PIN} (binary not pinned)`);
  // A tracker that reports pure credit, on the network with no chain (a local server's, fix inbox #146), is named as
  // running pure credit, not by its build's anchored netting; on the testnet by the build's name, as /api/status does.
  pilot.trackerSha256 = PIN_SHA;
  pilot.trackerCaps = {...V44_CAPS, pure_credit: true};
  assert.equal((await get(base, '/pilot/v1/health')).body.tracker.pin, NETWORK === 'valun-testnet-1' ? V44_PIN : V44_PIN.replace('(anchored netting)', '(pure credit)'));
  pilot.trackerCaps = null;
  assert.equal((await get(base, '/pilot/v1/health')).body.tracker.pin, null);
  assert.deepEqual(ran, [], 'the desk was never asked');
});

test('the Fly configs check the network\'s own GET /pilot/v1/info, never the legacy desk\'s /api/status; the retired router keeps its own', t => {
  const configs = {'fly.testnet.toml': '/pilot/v1/info', 'fly.staging.toml': '/pilot/v1/info', 'fly.toml': '/pilot/v1/info', 'fly.retired.toml': '/__retired'};
  if (!needs(t, ...Object.keys(configs))) return;
  for (const [f, want] of Object.entries(configs)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
    const checks = text.split('[[http_service.checks]]').slice(1).map(b => (/^\s*path = "([^"]+)"/m.exec(b.split('\n[')[0]) || [])[1]);
    assert.deepEqual(checks, [want], f);
    assert.doesNotMatch(text, /path = "\/api\//, `${f}: no check on the desk`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// server.mjs as a process
// A stub Basis tracker: GET / names the Basis Tracker, GET /capabilities is 404 (a tracker before v3: circulation off),
// and the desk's reads answer an empty tracker. `down` drops every connection, as a tracker that died would; delayMs
// holds every answer that long. `firstReadAt` is when it was first read.
async function stubTracker(name, {delayMs = 0} = {}) {
  const st = {down: false, firstReadAt: null};
  const s = http.createServer(async (req, res) => {
    if (st.down) return req.socket.destroy();
    st.firstReadAt ??= Date.now();
    if (delayMs) await sleep(delayMs);
    const json = (code, body) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end(`Basis Tracker (stub: ${name})`); }
    if (req.url === '/notes') return json(200, {success: true, data: []});
    if (req.url === '/tracker/state') return json(200, {success: true, data: {local_digest: 'd'.repeat(64), confirmed_digest: null}});
    return json(404, {success: false, error: 'not found'});
  });
  servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${s.address().port}`;
  return st;
}
async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const {port} = s.address();
  await new Promise(r => s.close(r));
  return port;
}
// server.mjs with only the settings given (VALUN_DATA_DIR and PILOT_DATA_DIR in a fresh folder unless given), with no
// sandbox agents and no seeding, so neither a tracker binary nor the signer is used. `out.text` is its log;
// `out.listenedAt` is when its log said it listens.
async function startServer(env) {
  const port = await freePort(), data = tmp();
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {...cleanEnv(), HOST: '127.0.0.1', PORT: String(port), VALUN_DATA_DIR: path.join(data, 'valun'), PILOT_DATA_DIR: path.join(data, 'pilot'),
      PILOT_SANDBOX: '0', VALUN_SEED: '0', ...env}});
  children.push(child);
  const out = {text: '', listenedAt: null};
  child.stdout.on('data', d => { out.text += d; if (out.listenedAt === null && /^Valun \(/m.test(out.text)) out.listenedAt = Date.now(); });
  child.stderr.on('data', d => { out.text += d; });
  const closed = new Promise(r => child.on('close', code => r(code)));
  return {child, out, closed, base: `http://127.0.0.1:${port}`};
}
// The first answer the server gives to this request: sent again until the port takes it (a refused connection is not
// an answer), so it is the first request once the server listens.
async function firstAnswer(base, p, init, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    let r;
    try { r = await fetch(base + p, init); } catch (e) {
      if (Date.now() > end) throw e;
      await sleep(5);
      continue;
    }
    return {status: r.status, body: await r.json().catch(() => null)};
  }
}
const NETWORK_ENV = pilot => ({PILOT_TRACKER_URL: pilot.url, PILOT_TRACKER_NFT_ID: 'b'.repeat(64)});
const healthy = s => until(`GET /pilot/v1/health answers 200 (log so far: ${s.out.text.slice(-400)})`, async () => (await get(s.base, '/pilot/v1/health')).status === 200);

test('server.mjs beside the network: no demo tracker id, or a demo tracker that never answers: the network starts at once and serves; the desk answers 503 desk_unavailable', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot');
  // No demo tracker id at all.
  const a = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: 'http://127.0.0.1:9'});
  await healthy(a);
  assert.deepEqual((await get(a.base, '/pilot/v1/health')).body, {ok: true, network: 'valun-pilot-1', tracker: {reachable: true, pin: null}});
  assert.equal((await get(a.base, '/pilot/v1/info')).body.network, 'valun-pilot-1');
  const tOff = Date.now();
  assert.deepEqual(await get(a.base, '/api/status'), {status: 503, body: DESK_UNAVAILABLE});
  assert.ok(Date.now() - tOff < 1500, `no desk at all: no wait (${Date.now() - tOff} ms)`);
  const list = await rpc(a.base, 'tools/list');
  assert.deepEqual([list.status, await list.json()], [503, {jsonrpc: '2.0', id: 1, error: DESK_RPC_ERROR}]);
  assert.match(a.out.text, /Desk: no demo tracker id \(BASIS_TRACKER_NFT_ID or data\/tracker-nft-id\): \/api and \/mcp answer 503 desk_unavailable; the network runs without the desk/);
  // A demo tracker id, but nothing answers at its address: the network does not wait for it (the desk waits up to 30 s
  // in the background; before fix inbox #64 (c) the whole server waited, then exited).
  const t0 = Date.now();
  const b = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: `http://127.0.0.1:${await freePort()}`, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});
  await healthy(b);
  assert.ok(Date.now() - t0 < 15_000, `the network served after ${Date.now() - t0} ms`);
  // Its desk requests come while the desk still starts (those 30 s): each waits for the start-up at most 3 s, then
  // answers 503 desk_unavailable, never after the whole start-up.
  const t1 = Date.now();
  const [st, init] = await Promise.all([get(b.base, '/api/status'), rpc(b.base, 'initialize')]);
  const waited = Date.now() - t1;
  assert.deepEqual(st, {status: 503, body: DESK_UNAVAILABLE});
  assert.deepEqual([init.status, await init.json()], [503, {jsonrpc: '2.0', id: 1, error: DESK_RPC_ERROR}]);
  assert.ok(waited >= 2500 && waited < 8000, `answered after ${waited} ms`);
  assert.equal(b.child.exitCode, null, 'still running');
});

test('server.mjs beside the network: the desk starts with the network\'s start-up, and a desk request that comes while it still starts waits for it, so the first requests once the port opens find the desk ready (review of fix inbox #64)', async t => {
  if (!needs(t, 'server.mjs')) return;
  // A demo tracker slower than the network's start-up (about 1.2 s of desk start-up): the desk still starts when the
  // server listens. Before, the first desk requests then answered 503 desk_unavailable.
  const pilotT = await stubTracker('pilot'), slowDemo = await stubTracker('demo', {delayMs: 400});
  const a = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: slowDemo.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});
  const [st, init] = await Promise.all([firstAnswer(a.base, '/api/status'), firstAnswer(a.base, '/mcp', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}})})]);
  assert.equal(st.status, 200, `the first GET /api/status: ${JSON.stringify(st)}`);
  assert.equal(st.body.basis.trackerReachable, true);
  assert.equal(init.status, 200, `the first POST /mcp: ${JSON.stringify(init)}`);
  assert.equal(init.body.result.serverInfo.name, 'valun');
  // A network start-up slower than the desk's (at least 3 s here): the desk starts with it, not after it, so it is
  // ready when the server listens.
  const slowPilot = await stubTracker('pilot', {delayMs: 1000}), demoT = await stubTracker('demo');
  const b = await startServer({...NETWORK_ENV(slowPilot), BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});
  const first = await firstAnswer(b.base, '/api/status');
  assert.equal(first.status, 200, `the first GET /api/status: ${JSON.stringify(first)}`);
  await until('the server logged that it listens', () => b.out.listenedAt);
  assert.ok(demoT.firstReadAt < b.out.listenedAt - 1500, `the desk first read its tracker ${b.out.listenedAt - demoT.firstReadAt} ms before the server listened`);
});

test('server.mjs beside the network: when the demo tracker stops answering, /api and /mcp answer 503 desk_unavailable and the network serves on; once it answers again the desk is back; GET /pilot/v1/health follows the pilot tracker', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  const s = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});
  await healthy(s);
  const st = await until('the desk is ready', async () => { const r = await get(s.base, '/api/status'); return r.status === 200 && r; });
  assert.equal(st.body.basis.trackerReachable, true);
  assert.equal((await rpc(s.base, 'tools/list')).status, 200);
  demoT.down = true;
  await until('the desk answers 503 desk_unavailable', async () => { const r = await get(s.base, '/api/status'); return r.status === 503 && r.body.error === 'desk_unavailable'; }, 10_000);
  assert.equal((await rpc(s.base, 'tools/list')).status, 503);
  assert.equal((await get(s.base, '/pilot/v1/health')).status, 200, 'the network is not affected');
  assert.equal((await get(s.base, '/pilot/v1/info')).status, 200);
  assert.equal((await get(s.base, '/pilot/v1/participants')).status, 200);
  demoT.down = false;
  await until('the desk is back', async () => (await get(s.base, '/api/status')).status === 200, 10_000);
  assert.match(s.out.text, /Desk: its demo tracker at http:\/\/127\.0\.0\.1:\d+ does not answer: \/api and \/mcp answer 503 desk_unavailable; the network is not affected/);
  assert.match(s.out.text, /Desk: its demo tracker at http:\/\/127\.0\.0\.1:\d+ answers again: \/api and \/mcp are back/);
  assert.equal(s.out.text.match(/does not answer: /g).length, 1, 'one line per change');
  // The pilot tracker: GET /pilot/v1/health is 503 while it does not answer (what the live check sees), 200 again
  // once it does; the process does not exit (in the container the entrypoint stops when that tracker's process does).
  pilotT.down = true;
  await until('GET /pilot/v1/health 503', async () => { const r = await get(s.base, '/pilot/v1/health'); return r.status === 503 && r.body.ok === false && r.body.tracker.reachable === false; }, 10_000);
  pilotT.down = false;
  await healthy(s);
  assert.equal(s.child.exitCode, null);
});

test('server.mjs beside the network: a desk whose start-up fails, or whose state cannot be read, leaves the network serving', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  // Recovery fails: a submission left for participants the state does not hold.
  const failing = tmp();
  fs.writeFileSync(path.join(failing, 'state.json'), JSON.stringify({version: 1, seq: 1, participants: {},
    offers: {'o-0001': {id: 'o-0001', status: 'submitting', issuerId: 'p-0001', recipientId: 'p-0002', terms: {}, history: []}}}));
  const a = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64), VALUN_DATA_DIR: failing});
  await healthy(a);
  await until('the desk start-up failed', () => /Desk: not started \(unknown participant p-0001\): \/api and \/mcp answer 503 desk_unavailable until a restart; the network runs without the desk/.test(a.out.text));
  assert.deepEqual(await get(a.base, '/api/status'), {status: 503, body: DESK_UNAVAILABLE}, 'its tracker answers, but the desk did not start');
  assert.equal((await get(a.base, '/pilot/v1/info')).status, 200);
  // A state file that is not JSON: the desk is not set up at all.
  const broken = tmp();
  fs.writeFileSync(path.join(broken, 'state.json'), 'not json');
  const b = await startServer({...NETWORK_ENV(pilotT), BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64), VALUN_DATA_DIR: broken});
  await healthy(b);
  assert.match(b.out.text, /Desk: not set up \(.+\): \/api and \/mcp answer 503 desk_unavailable; the network runs without the desk/);
  assert.deepEqual(await get(b.base, '/api/status'), {status: 503, body: DESK_UNAVAILABLE});
});

test('server.mjs alone (no network): as before, no tracker id stops it, and a tracker that stops answering is reported by /api/status, not refused', async t => {
  if (!needs(t, 'server.mjs')) return;
  const a = await startServer({BASIS_TRACKER_URL: 'http://127.0.0.1:9'});
  assert.equal(await a.closed, 1);
  assert.match(a.out.text, /BASIS_TRACKER_NFT_ID \(or data\/tracker-nft-id\) must be the tracker's 32-byte id/);
  const demoT = await stubTracker('demo');
  const b = await startServer({BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});
  const st = await until('the desk serves', async () => { const r = await get(b.base, '/api/status'); return r.status === 200 && r; });
  assert.equal(st.body.basis.trackerReachable, true);
  demoT.down = true;
  const down = await get(b.base, '/api/status');
  assert.deepEqual([down.status, down.body.basis.trackerReachable], [200, false], 'no desk_unavailable without the network');
  assert.equal((await fetch(`${b.base}/pilot/v1/health`)).status, 404, 'no network here');
});
