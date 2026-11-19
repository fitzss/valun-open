// A server run without the local image (fix inbox #155: the local-readiness audit of Nov 18, FB-4; test R-6). Local mode
// existed only through Dockerfile.local and scripts/local-entrypoint.sh, and nothing else set VALUN_ENVIRONMENT: `node
// server.mjs`, the hosted Dockerfile under Docker, and `npm run local` (scripts/start-local.mjs) ran a valun-pilot-1
// server whose /skill.md, /agents.md and /llms.txt are the retired pilot's: they name https://valun.tech, and every join
// they, its pages and its A2A answer give names no server, so the client takes its default, the public network. Its
// agents joined the public testnet, and nothing said so. Now:
//   - `npm run local` runs the network as a local server (VALUN_ENVIRONMENT=local: appEnv), whose /skill.md is the local
//     one, naming only it, and the legacy demo desk alone in a process of its own on the next port (deskEnv), since a
//     local server builds no desk; neither app takes the other's settings from the environment;
//   - server.mjs says that it gives agents the public network's instructions, once, on stderr, just before its start
//     line, when it runs valun-pilot-1 off Fly and not as a local server (lib/environment.mjs publicDocsWarning): beside
//     the network, and with the legacy demo desk alone. What it serves does not change (its skill.md and llms.txt here;
//     the testnet's and the pilot's pages, byte for byte, in test/local-pages.unit.test.mjs and
//     test/local-mode.unit.test.mjs). On Fly (FLY_APP_NAME or FLY_MACHINE_ID, which Fly sets in every Machine), on
//     valun-testnet-1 (the testnet's and staging's network) and on a local server it says nothing;
//   - scripts/docker-entrypoint.sh says the same off Fly when VALUN_ENVIRONMENT is unset: test/entrypoint.test.mjs.
// server.mjs runs as a process over stub trackers (no tracker binary, no signer, no sandbox agents, no seeding), under
// test/fixtures/net-guard.mjs, as in test/local-start.unit.test.mjs.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {localBanner, onFly, publicDocsWarning} from '../lib/environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = pathToFileURL(path.join(root, 'test', 'fixtures', 'net-guard.mjs')).href;
// The client release a local server's docs and start line pin (lib/a2a.mjs LOCAL_CLIENT), read from its source.
const LOCAL_CLIENT = /^export const LOCAL_CLIENT = '(valun==\d+\.\d+\.\d+)';$/m.exec(fs.readFileSync(path.join(root, 'lib', 'a2a.mjs'), 'utf8'))[1];
const made = [], servers = [], children = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-start-local-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// As in test/desk-optional.test.mjs: a missing file skips the test in the image's copy of the app, else fails it.
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
// This process's environment without any Valun, tracker or Ergo setting, PORT, or Fly's variables (a machine that has
// them would look like Fly).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_|FLY_)/.test(k) && k !== 'PORT'));
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
// server.mjs under the network guard with exactly `env` on top of a clean environment (`port`: its PORT, a free one
// unless given), until it listens and answers `ready` (a path); its stdout and stderr are kept apart. The guard's log is
// always this server's own, whatever `env` holds (a test run under a guard of its own has NET_GUARD_LOG set, and an
// environment start-local builds from this one keeps it).
// A port freePort found can be taken before the server listens on it (another test of a run that starts many at once:
// the full suite's): the server then exits with EADDRINUSE, and it starts again on another one, at most three times.
async function startServer(env, {port, ready = '/pilot/v1/health'} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(env, {port: port ?? await freePort(), ready});
    } catch (e) {
      if (port !== undefined || attempt >= 3 || !/EADDRINUSE/.test(e.message)) throw e;
    }
  }
}
async function startOnce(env, {port, ready}) {
  const data = tmp(), log = path.join(data, 'net-guard.jsonl');
  const child = spawn(process.execPath, ['--import', GUARD, path.join(root, 'server.mjs')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {...cleanEnv(), HOST: '127.0.0.1', PORT: String(port), VALUN_DATA_DIR: path.join(data, 'valun'), PILOT_DATA_DIR: path.join(data, 'pilot'),
      PILOT_SANDBOX: '0', VALUN_SEED: '0', ...env, NET_GUARD_LOG: log}});
  children.push(child);
  const out = {stdout: '', stderr: ''};
  child.stdout.on('data', d => { out.stdout += d; }); child.stderr.on('data', d => { out.stderr += d; });
  const s = {child, out, port, base: `http://127.0.0.1:${port}`,
    attempts: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.kind !== 'loaded')};
  const logOf = () => `exit ${child.exitCode}; its log: ${out.stdout.slice(-400)} ${out.stderr.slice(-400)}`;
  const end = Date.now() + 15000;
  for (;;) {
    // A server that exited will never listen: say so at once, with its log (EADDRINUSE among them).
    if (child.exitCode !== null) assert.fail(`the server exited before it listened (${logOf()})`);
    if (/^Valun \(/m.test(out.stdout) && await fetch(`${s.base}${ready}`).then(r => r.status === 200, () => false)) return s;
    if (Date.now() > end) assert.fail(`timed out after 15000 ms: the server listens (${logOf()})`);
    await sleep(100);
  }
}
const get = async (base, p) => { const r = await fetch(base + p); return {status: r.status, text: await r.text()}; };
const startLineOf = s => s.out.stdout.split('\n').find(l => /^Valun \(/.test(l));
const warningsOf = s => `${s.out.stdout}\n${s.out.stderr}`.split('\n').filter(l => /^Warning:/.test(l));

// The warning, word for word: beside the network, and with the legacy demo desk alone.
const NETWORK_WARNING = port => 'Warning: this server runs valun-pilot-1 off Fly and not as a local server (VALUN_ENVIRONMENT=local is unset), so it gives '
  + 'agents the public network\'s instructions: its /skill.md, /agents.md and /llms.txt name https://valun.tech, and the joins they, its pages '
  + 'and its A2A answer give name no server, so the client uses its default, the public network at https://valun.tech: an agent that follows '
  + 'them joins the public network, not this server. For a server of your own with no chain, set VALUN_ENVIRONMENT=local: its docs, pages and '
  + `A2A answer then name only this server (http://127.0.0.1:${port}; docs/LOCAL.md), as the local image (Dockerfile.local) runs it.`;
const DESK_WARNING = 'Warning: this server runs the legacy demo desk alone (no PILOT_TRACKER_URL) off Fly and not as a local server '
  + '(VALUN_ENVIRONMENT=local is unset), so it gives agents the public network\'s instructions: its /skill.md, /agents.md and /llms.txt name '
  + 'https://valun.tech, and the joins they and its pages give name no server, so the client uses its default, the public network at '
  + 'https://valun.tech: an agent that follows them joins the public network, not this server, which runs no network to join. For a network of '
  + 'your own with no chain: VALUN_ENVIRONMENT=local with that network\'s tracker (PILOT_TRACKER_URL, PILOT_TRACKER_NFT_ID), as the local image '
  + '(Dockerfile.local; docs/LOCAL.md) runs it.';
// What Fly sets in every Machine (the testnet's and staging's), as far as this check reads it.
const FLY = {FLY_APP_NAME: 'valun-testnet', FLY_MACHINE_ID: 'fake-machine-id'};
const NETWORK_ENV = (pilot, demo) => ({PILOT_TRACKER_URL: pilot.url, PILOT_TRACKER_NFT_ID: 'b'.repeat(64), BASIS_TRACKER_URL: demo.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)});

test('when it warns (lib/environment.mjs publicDocsWarning): valun-pilot-1 off Fly and not a local server; never on Fly, never on valun-testnet-1 (the testnet\'s and staging\'s network), never on a local server', () => {
  // On Fly: either variable is enough; empty ones are not set.
  assert.deepEqual([onFly(FLY), onFly({FLY_APP_NAME: 'valun-staging'}), onFly({FLY_MACHINE_ID: 'fake-machine-id'}), onFly({}), onFly({FLY_APP_NAME: '', FLY_MACHINE_ID: ''}),
    onFly({FLY_APP: 'valun-testnet', FLY_API_TOKEN: 'x'})], [true, true, true, false, false, false], 'flyctl\'s own settings (FLY_APP, FLY_API_TOKEN) are not Fly\'s Machine');
  const w = o => publicDocsWarning({network: 'valun-pilot-1', fly: false, local: false, withNetwork: true, localOrigin: 'http://127.0.0.1:4320', ...o});
  assert.equal(w({}), NETWORK_WARNING(4320));
  assert.equal(w({withNetwork: false}), DESK_WARNING);
  for (const [o, why] of [[{fly: true}, 'on Fly'], [{local: true}, 'a local server'], [{network: 'valun-testnet-1'}, 'the testnet\'s network off Fly'],
    [{network: 'valun-testnet-1', fly: true}, 'the testnet and staging, on Fly'], [{network: 'valun-testnet-1', withNetwork: false}, 'a desk on the testnet\'s network']])
    assert.equal(w(o), null, why);
});

test('a valun-pilot-1 server off Fly that is not a local server warns, once, on stderr, that its agent docs send agents to the public network; its start line and what it serves are as before', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  const s = await startServer(NETWORK_ENV(pilotT, demoT));
  assert.deepEqual(warningsOf(s), [NETWORK_WARNING(s.port)], 'one warning');
  assert.ok(s.out.stderr.split('\n').includes(NETWORK_WARNING(s.port)), 'on stderr');
  assert.match(startLineOf(s), new RegExp(`^Valun \\(local\\) on http://127\\.0\\.0\\.1:${s.port} - tracker ${demoT.url} - MCP at /mcp - valun-pilot-1 ${pilotT.url} \\(`), 'the start line as before');
  // What it serves is the pilot network's, byte for byte: the retired pilot's skill.md and llms.txt (no banner, no
  // environment in /info), as test/local-pages.unit.test.mjs pins every page.
  assert.deepEqual(await get(s.base, '/skill.md'), {status: 200, text: fs.readFileSync(path.join(root, 'public', 'skill.md'), 'utf8')});
  assert.deepEqual(await get(s.base, '/llms.txt'), {status: 200, text: fs.readFileSync(path.join(root, 'public', 'llms.txt'), 'utf8')});
  const info = JSON.parse((await get(s.base, '/pilot/v1/info')).text);
  assert.deepEqual([info.network, 'environment' in info], ['valun-pilot-1', false]);
  assert.deepEqual(s.attempts().filter(x => !x.allowed), [], 'nothing outside this machine');
  s.child.kill();
  // The legacy demo desk alone (no network): its own words.
  const demo2 = await stubTracker('demo');
  const d = await startServer({BASIS_TRACKER_URL: demo2.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64)}, {ready: '/api/status'});
  assert.deepEqual(warningsOf(d), [DESK_WARNING]);
  assert.ok(d.out.stderr.split('\n').includes(DESK_WARNING), 'on stderr');
  assert.match(startLineOf(d), new RegExp(`^Valun \\(local\\) on http://127\\.0\\.0\\.1:${d.port} - tracker ${demo2.url} - MCP at /mcp$`));
  assert.equal((await get(d.base, '/pilot/v1/health')).status, 404, 'no network there');
  d.child.kill();
});

test('on Fly (FLY_APP_NAME or FLY_MACHINE_ID set, as Fly sets both in every Machine) the same servers say nothing of it', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo');
  for (const fly of [FLY, {FLY_APP_NAME: FLY.FLY_APP_NAME}, {FLY_MACHINE_ID: FLY.FLY_MACHINE_ID}]) {
    const s = await startServer({...NETWORK_ENV(pilotT, demoT), ...fly}), at = JSON.stringify(fly);
    assert.deepEqual(warningsOf(s), [], at);
    assert.doesNotMatch(s.out.stderr, /VALUN_ENVIRONMENT=local is unset/, at);
    assert.match(startLineOf(s), new RegExp(`^Valun \\(local\\) on http://127\\.0\\.0\\.1:${s.port} - tracker ${demoT.url} - MCP at /mcp - valun-pilot-1 ${pilotT.url} \\(`), at);
    s.child.kill();
  }
  const d = await startServer({BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: 'a'.repeat(64), ...FLY}, {ready: '/api/status'});
  assert.deepEqual(warningsOf(d), [], 'the desk alone on Fly');
  d.child.kill();
});

test('a local server (VALUN_ENVIRONMENT=local) says nothing of it: its docs name only itself', async t => {
  if (!needs(t, 'server.mjs')) return;
  const pilotT = await stubTracker('pilot');
  const s = await startServer({PILOT_TRACKER_URL: pilotT.url, PILOT_TRACKER_NFT_ID: 'b'.repeat(64), VALUN_ENVIRONMENT: 'local'});
  assert.deepEqual(warningsOf(s), []);
  assert.match(startLineOf(s), /^Valun \(local\) on http:\/\/127\.0\.0\.1:\d+ - no chain: valun-pilot-1, in PC - /);
  s.child.kill();
});

// ---------------------------------------------------------------------------------------------------------------
// npm run local (scripts/start-local.mjs)
const H = c => c.repeat(64);
const startLocal = () => import(pathToFileURL(path.join(root, 'scripts', 'start-local.mjs')).href);
// What a developer's shell may hold, of both apps' settings: none of the desk's reaches the network, and none of the
// network's the desk.
const SHELL = Object.freeze({VALUN_ENVIRONMENT: 'staging', VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000', PILOT_OPEN_SANDBOX: '1', PILOT_NETWORK: 'valun-pilot-1',
  PILOT_TRACKER_URL: 'http://127.0.0.1:9', PILOT_TRACKER_SHA256: H('0'), BASIS_TRACKER_URL: 'http://127.0.0.1:9', BASIS_TRACKER_NFT_ID: H('9'), VALUN_WRITE_TOKEN: 'w', PATH: '/bin'});

test('npm run local: appEnv runs the network as a local server (VALUN_ENVIRONMENT=local) on PORT with the pilot tracker and none of the desk\'s settings; deskEnv runs the desk alone on the next port with none of the network\'s', async t => {
  if (!needs(t, 'scripts/start-local.mjs')) return;
  const {appEnv, deskEnv, localPorts} = await startLocal();
  // The ports: the network's on PORT (4320), the desk's on VALUN_DESK_PORT or the one after it; the trackers' as before.
  assert.deepEqual(localPorts({}), {app: '4320', desk: '4321', demo: '3048', pilot: '3058'});
  assert.deepEqual(localPorts({PORT: '4330', VALUN_DEMO_TRACKER_PORT: '3148', VALUN_PILOT_TRACKER_PORT: '3158'}), {app: '4330', desk: '4331', demo: '3148', pilot: '3158'});
  assert.deepEqual(localPorts({PORT: '4330', VALUN_DESK_PORT: '5000'}).desk, '5000');
  const opts = {ports: {app: '4320', desk: '4321', demo: '3048', pilot: '3058'}, bins: '/home/valun/bins', nfts: {demo: H('a'), pilot: H('b')}, dataDir: 'C:/v/data', pilotDir: 'C:/v/data-pilot', sha256: H('c')};
  assert.deepEqual(appEnv(SHELL, opts), {VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000', PILOT_OPEN_SANDBOX: '1', PILOT_NETWORK: 'valun-pilot-1', VALUN_WRITE_TOKEN: 'w', PATH: '/bin',
    PORT: '4320', BASIS_RUNNER: 'wsl', BASIS_SIGNER: '/home/valun/bins/examples/valun_signer', VALUN_DATA_DIR: 'C:/v/data', VALUN_DEPLOYMENT: 'local', VALUN_ENVIRONMENT: 'local',
    PILOT_TRACKER_URL: 'http://127.0.0.1:3058', PILOT_TRACKER_NFT_ID: H('b'), PILOT_DATA_DIR: 'C:/v/data-pilot', PILOT_TRACKER_SHA256: H('c')});
  assert.deepEqual(deskEnv(SHELL, opts), {VALUN_WRITE_TOKEN: 'w', PATH: '/bin',
    PORT: '4321', BASIS_RUNNER: 'wsl', BASIS_SIGNER: '/home/valun/bins/examples/valun_signer', BASIS_TRACKER_URL: 'http://127.0.0.1:3048', BASIS_TRACKER_NFT_ID: H('a'),
    VALUN_DATA_DIR: 'C:/v/data', VALUN_DEPLOYMENT: 'local', PILOT_TRACKER_SHA256: H('c')});
});

test('npm run local: the network, started as appEnv starts it, serves the local skill.md naming only itself, says local in /info and on its landing, has no /mcp or /api, builds no desk and says nothing of the public network\'s instructions', async t => {
  if (!needs(t, 'scripts/start-local.mjs', 'server.mjs')) return;
  const {appEnv} = await startLocal();
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo'), port = await freePort(), data = tmp(), origin = `http://127.0.0.1:${port}`;
  const s = await startServer(appEnv({...cleanEnv(), BASIS_TRACKER_URL: demoT.url, BASIS_TRACKER_NFT_ID: H('a')}, {ports: {app: String(port), desk: '9', demo: String(demoT.port), pilot: String(pilotT.port)},
    bins: '/home/valun/bins', nfts: {demo: H('a'), pilot: H('b')}, dataDir: path.join(data, 'valun'), pilotDir: path.join(data, 'pilot'), sha256: ''}), {port});
  assert.deepEqual(await get(s.base, '/skill.md'), {status: 200, text: fs.readFileSync(path.join(root, 'public', 'skill-local.md'), 'utf8').replaceAll('{origin}', origin)});
  const info = JSON.parse((await get(s.base, '/pilot/v1/info')).text);
  assert.deepEqual([info.network, info.environment], ['valun-pilot-1', 'local']);
  const home = await get(s.base, '/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes(localBanner(origin)), 'the landing, with the local banner naming this server');
  assert.equal((await get(s.base, '/mcp')).status, 404);
  assert.equal((await get(s.base, '/api/status')).status, 404);
  assert.deepEqual(warningsOf(s), [], 'no warning: its docs name only itself');
  assert.equal(startLineOf(s), `Valun (local) on ${origin} - no chain: valun-pilot-1, in PC - agents read ${origin}/skill.md, and each runs its MCP server on its own `
    + `machine: uvx --from ${LOCAL_CLIENT} valun --profile local mcp - this process listens on port ${port}`);
  await sleep(500);
  assert.deepEqual(demoT.reads, [], 'no desk: the demo tracker was never read, though the shell named it');
  assert.ok(pilotT.reads.length > 0, 'it runs on the pilot tracker');
  assert.deepEqual(s.attempts().filter(x => !x.allowed), [], 'nothing outside this machine');
  s.child.kill();
});

test('npm run local: the desk, started as deskEnv starts it, is the legacy desk alone on its own port (its console at /, /api, /mcp), runs no network though the shell names one, and says that its docs are the public network\'s', async t => {
  if (!needs(t, 'scripts/start-local.mjs', 'server.mjs')) return;
  const {deskEnv} = await startLocal();
  const pilotT = await stubTracker('pilot'), demoT = await stubTracker('demo'), port = await freePort(), data = tmp();
  // A shell that holds the network's settings, a local server's included: the desk takes none of them.
  const shell = {...cleanEnv(), PILOT_TRACKER_URL: pilotT.url, PILOT_TRACKER_NFT_ID: H('b'), VALUN_ENVIRONMENT: 'local', VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000'};
  const d = await startServer(deskEnv(shell, {ports: {app: '9', desk: String(port), demo: String(demoT.port), pilot: String(pilotT.port)}, bins: '/home/valun/bins',
    nfts: {demo: H('a'), pilot: H('b')}, dataDir: path.join(data, 'valun'), sha256: ''}), {port, ready: '/api/status'});
  assert.equal((await get(d.base, '/')).text, fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), 'the desk console at /');
  assert.equal(JSON.parse((await get(d.base, '/api/status')).text).basis.trackerReachable, true);
  const init = await fetch(`${d.base}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}}})});
  assert.equal(init.status, 200, 'its /mcp is the desk\'s');
  assert.equal((await get(d.base, '/pilot/v1/health')).status, 404, 'no network');
  assert.deepEqual(pilotT.reads, [], 'the pilot tracker was never read');
  assert.deepEqual(warningsOf(d), [DESK_WARNING]);
  assert.match(startLineOf(d), new RegExp(`^Valun \\(local\\) on http://127\\.0\\.0\\.1:${port} - tracker ${demoT.url} - MCP at /mcp$`));
  assert.deepEqual(d.attempts().filter(x => !x.allowed), [], 'nothing outside this machine');
  d.child.kill();
});
