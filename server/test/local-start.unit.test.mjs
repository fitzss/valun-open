// A local server's start line, /mcp and /api, and the desk it never builds (fix inbox #151, the second half; the
// local-readiness audit of Nov 18, SRV-12, FB-15: test R-5). The image's log said "Valun (local) on http://0.0.0.0:8080 -
// tracker http://127.0.0.1:3048 - MCP at /mcp - ...": 0.0.0.0 is no URL to open, 3048 is the legacy desk's tracker, which
// never runs there, and /mcp answered 503 "the synthetic demo desk is unavailable: its demo tracker is starting, stopped
// or not answering (fix inbox #64)", so an agent that read the log was sent to a dead endpoint instead of `valun
// --profile local mcp`. And with a demo tracker id in the data volume and PILOT_BASIS_PORT=3048, the desk was built on
// the network's own tracker: it could seed demo notes into it, and its GET /api/testnet?live=1 read the public Ergo
// explorer. Now, on a local server (VALUN_ENVIRONMENT=local):
//   - one start line names the server's origin (PUBLIC_ORIGIN, not the address it listens on), its /skill.md and the MCP
//     server an agent runs on its own machine, and never 0.0.0.0, :3048, a tracker URL or "MCP at /mcp"; no desk line;
//   - /mcp (any method) answers 404 with that MCP command and how to join, and no fix inbox number; /api/* 404;
//   - no desk is built: with a demo tracker id in its data folder and a demo tracker that answers (BASIS_TRACKER_URL
//     stands in for PILOT_BASIS_PORT=3048, where the desk's default 127.0.0.1:3048 would have found the network's
//     tracker), nothing reaches that tracker, and GET /api/testnet?live=1 makes no connection and no lookup outside
//     this machine (test/fixtures/net-guard.mjs logs every attempt the server process makes, and refuses any that is not
//     loopback);
//   - elsewhere (the same setup, VALUN_ENVIRONMENT unset), the start line and the desk are as before.
// server.mjs runs as a process over stub trackers (no tracker binary, no signer, no sandbox agents), as in
// test/desk-optional.test.mjs. The entrypoint's refusal of PILOT_BASIS_PORT=3048 is test/local-mode.unit.test.mjs's.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LOCAL_MCP} from '../lib/a2a.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = pathToFileURL(path.join(root, 'test', 'fixtures', 'net-guard.mjs')).href;
const made = [], servers = [], children = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-local-start-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Polls fn until it returns something truthy (errors count as not yet), at most ms; `what` may be a function, read when
// the time is up (a log as it is then).
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms: ${typeof what === 'function' ? what() : what}`);
    await sleep(100);
  }
}
// As in test/desk-optional.test.mjs: a missing file skips the test in the image's copy of the app, else fails it.
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k) && k !== 'PORT'));
// A stub Basis tracker (test/desk-optional.test.mjs's): GET / names it, GET /capabilities is 404 (circulation off), the
// desk's reads answer an empty tracker. `reads` lists every request it got.
async function stubTracker(name) {
  const st = {reads: []};
  const s = http.createServer((req, res) => {
    st.reads.push(`${req.method} ${req.url}`);
    const json = (code, body) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end(`Basis Tracker (stub: ${name})`); }
    if (req.url === '/notes') return json(200, {success: true, data: []});
    if (req.url === '/tracker/state') return json(200, {success: true, data: {local_digest: 'd'.repeat(64), confirmed_digest: null}});
    return json(404, {success: false, error: 'not found'});
  });
  servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  st.port = s.address().port;
  st.url = `http://127.0.0.1:${st.port}`;
  return st;
}
async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const {port} = s.address();
  await new Promise(r => s.close(r));
  return port;
}
// server.mjs under the network guard, with a demo tracker id in its data folder (VALUN_DATA_DIR/tracker-nft-id, as a
// volume that once ran the desk holds one) and the settings given; no sandbox agents, no seeding.
async function startServer(env) {
  const port = await freePort(), data = tmp(), log = path.join(data, 'net-guard.jsonl');
  fs.mkdirSync(path.join(data, 'valun'));
  fs.writeFileSync(path.join(data, 'valun', 'tracker-nft-id'), `${'a'.repeat(64)}\n`);
  const child = spawn(process.execPath, ['--import', GUARD, path.join(root, 'server.mjs')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {...cleanEnv(), NET_GUARD_LOG: log, HOST: '127.0.0.1', PORT: String(port), VALUN_DATA_DIR: path.join(data, 'valun'), PILOT_DATA_DIR: path.join(data, 'pilot'),
      PILOT_SANDBOX: '0', VALUN_SEED: '0', ...env}});
  children.push(child);
  const out = {text: ''};
  child.stdout.on('data', d => { out.text += d; }); child.stderr.on('data', d => { out.text += d; });
  const s = {child, out, port, base: `http://127.0.0.1:${port}`,
    attempts: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.kind !== 'loaded')};
  await until(() => `the server listens (exit ${child.exitCode}; its log: ${out.text.slice(-600)})`,
    () => /^Valun \(/m.test(out.text) && fetch(`${s.base}/pilot/v1/health`).then(r => r.status === 200));
  return s;
}
const startLineOf = s => s.out.text.split('\n').find(l => /^Valun \(/.test(l));
const call = async (base, method, p, body) => {
  const r = await fetch(base + p, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body && JSON.stringify(body)});
  return {status: r.status, text: await r.text()};
};
const NETWORK_ENV = (pilot, demo) => ({PILOT_TRACKER_URL: pilot.url, PILOT_TRACKER_NFT_ID: 'b'.repeat(64), BASIS_TRACKER_URL: demo.url});

test('local: one start line names the origin, /skill.md and `valun --profile local mcp`, never 0.0.0.0, :3048, a tracker URL or "MCP at /mcp"; no desk line', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  // Its origin by default (http://127.0.0.1:<PORT>), and with the port published as another (VALUN_PUBLIC_ORIGIN): the
  // line names the origin agents use, not the address the process listens on. On Linux also on 0.0.0.0, as the image
  // listens (not on Windows, where listening on every interface asks the firewall).
  const runs = [[{}, port => `http://127.0.0.1:${port}`], [{VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000'}, () => 'http://127.0.0.1:9000'],
    ...(process.platform === 'win32' ? [] : [[{HOST: '0.0.0.0', VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000'}, () => 'http://127.0.0.1:9000']])];
  for (const [extra, originOf] of runs) {
    const s = await startServer({...NETWORK_ENV(pilotT, demoT), VALUN_ENVIRONMENT: 'local', ...extra}), origin = originOf(s.port);
    const line = startLineOf(s), at = JSON.stringify(extra);
    assert.equal(line, `Valun (local) on ${origin} - no chain: valun-pilot-1, in PC - agents read ${origin}/skill.md, and each runs its MCP server on its own `
      + `machine: ${LOCAL_MCP} - this process listens on port ${s.port}`, at);
    assert.ok(line.includes('valun --profile local mcp'), at);
    for (const never of ['0.0.0.0', ':3048', 'MCP at /mcp', pilotT.url, demoT.url, 'tracker http']) assert.ok(!line.includes(never), `${at}: names ${never}`);
    assert.equal(s.out.text.split('\n').filter(l => /^Valun \(/.test(l)).length, 1, `${at}: one start line`);
    assert.doesNotMatch(s.out.text, /^Desk:/m, `${at}: no desk line`);
    s.child.kill();
  }
});

test('local: /mcp answers 404 with the MCP server an agent runs on its own machine and how to join, with no fix inbox number; /api/* answers 404', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  const s = await startServer({...NETWORK_ENV(pilotT, demoT), VALUN_ENVIRONMENT: 'local'}), origin = `http://127.0.0.1:${s.port}`;
  const NO_MCP = {error: 'no_mcp_endpoint', message: `this local server has no MCP endpoint: an agent runs Valun's MCP server on its own machine, in the client `
    + `profile it joined this server with: ${LOCAL_MCP} (how to join: ${origin}/skill.md)`};
  for (const [method, body] of [['POST', {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}}}],
    ['POST', {jsonrpc: '2.0', id: 2, method: 'tools/list'}], ['POST', [{jsonrpc: '2.0', id: 3, method: 'ping'}]], ['GET'], ['DELETE']]) {
    const r = await call(s.base, method, '/mcp', body);
    assert.deepEqual([r.status, JSON.parse(r.text)], [404, NO_MCP], `${method} /mcp ${JSON.stringify(body ?? '')}`);
    assert.doesNotMatch(r.text, /#\d|fix inbox|desk_unavailable|demo tracker/, method);
  }
  for (const p of ['/api/status', '/api/participants', '/api/testnet', '/api/testnet?live=1', '/api/nope']) {
    const r = await call(s.base, 'GET', p);
    assert.deepEqual([r.status, JSON.parse(r.text)], [404, {error: 'not_found', message: `this local server runs no demo desk (/api): the Valun network is under /pilot/v1, and agents start at ${origin}/skill.md`}], p);
  }
  const post = await call(s.base, 'POST', '/api/participants', {name: 'x'});
  assert.equal(post.status, 404);
  // The network answers as before.
  assert.equal((await call(s.base, 'GET', '/pilot/v1/info')).status, 200);
  assert.equal((await call(s.base, 'GET', '/skill.md')).status, 200);
  s.child.kill();
});

test('local: no desk is built, with a demo tracker id in the data folder and a demo tracker that answers; GET /api/testnet?live=1 reaches no other host; elsewhere the desk is built as before', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  const s = await startServer({...NETWORK_ENV(pilotT, demoT), VALUN_ENVIRONMENT: 'local'});
  for (let i = 0; i < 3; i++) assert.equal((await call(s.base, 'GET', '/api/testnet?live=1')).status, 404);
  assert.equal((await call(s.base, 'GET', '/api/status')).status, 404);
  await sleep(1500);   // a desk starts beside the network's start-up and reads its tracker within milliseconds
  assert.deepEqual(demoT.reads, [], 'nothing reached the demo tracker: no desk');
  assert.ok(pilotT.reads.length > 0, 'the network read its own tracker');
  // Every connection and lookup the server process attempted stayed on this machine: none was refused, and none went to
  // the demo tracker.
  const attempts = s.attempts();
  assert.ok(attempts.length > 0, 'the guard logged the network\'s own connections');
  assert.deepEqual(attempts.filter(x => !x.allowed), [], 'no connection or lookup outside this machine');
  assert.deepEqual(attempts.filter(x => x.kind === 'connect' && Number(x.port) === demoT.port), [], 'no connection to the demo tracker');
  assert.ok(attempts.some(x => x.kind === 'connect' && Number(x.port) === pilotT.port), 'its connections to the network\'s tracker are logged');
  s.child.kill();
  // The same setup with VALUN_ENVIRONMENT unset: the desk is built on that tracker id and reads its tracker, and the
  // start line is as before (the hosted servers' behaviour does not change).
  const pilot2 = await stubTracker('pilot'), demo2 = await stubTracker('demo');
  const h = await startServer(NETWORK_ENV(pilot2, demo2));
  await until('the desk read its tracker', () => demo2.reads.length > 0);
  await until('the desk is ready', async () => (await call(h.base, 'GET', '/api/status')).status === 200);
  assert.match(startLineOf(h), new RegExp(`^Valun \\(local\\) on http://127\\.0\\.0\\.1:${h.port} - tracker ${demo2.url} - MCP at /mcp - valun-pilot-1 ${pilot2.url} \\(`));
  assert.equal((await call(h.base, 'POST', '/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 200, 'its /mcp is the desk\'s');
  assert.deepEqual(h.attempts().filter(x => !x.allowed), []);
  h.child.kill();
});

// The guard itself: what it refuses fails at once and is logged, so an empty list of refused attempts above means that
// none was made. 192.0.2.1 is TEST-NET-1 (RFC 5737): no host answers there even if a connection went out.
test('test/fixtures/net-guard.mjs logs and refuses a connection and a lookup outside this machine, and lets loopback through', () => {
  const dir = tmp(), log = path.join(dir, 'net.jsonl');
  const script = 'const net = await import("node:net"), dns = await import("node:dns"), http = await import("node:http"), out = [];'
    + 'try { await fetch("http://192.0.2.1:80/", {signal: AbortSignal.timeout(5000)}); out.push("fetch answered"); } catch (e) { out.push(String(e.cause?.message ?? e.message)); }'
    + 'try { await fetch("https://explorer.invalid/x", {signal: AbortSignal.timeout(5000)}); out.push("fetch answered"); } catch (e) { out.push(String(e.cause?.message ?? e.message)); }'
    + 'await new Promise(r => dns.lookup("explorer.invalid", e => { out.push(String(e?.message)); r(); }));'
    + 'const s = http.createServer((q, a) => a.end("ok")); await new Promise(r => s.listen(0, "127.0.0.1", r));'
    + 'out.push(await (await fetch(`http://127.0.0.1:${s.address().port}/`)).text()); s.close();'
    + 'console.log(JSON.stringify(out));';
  const r = spawnSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20_000, env: {...cleanEnv(), NET_GUARD_LOG: log}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ['net-guard: refused a connection to 192.0.2.1:80', 'net-guard: refused a connection to explorer.invalid:443',
    'net-guard: refused a DNS lookup of explorer.invalid', 'ok']);
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(logged.filter(x => !x.allowed && x.kind !== 'loaded').map(x => [x.kind, x.host, x.port ?? null]),
    [['connect', '192.0.2.1', 80], ['connect', 'explorer.invalid', 443], ['dns', 'explorer.invalid', null]]);
  assert.ok(logged.some(x => x.kind === 'connect' && x.host === '127.0.0.1' && x.allowed));
});
