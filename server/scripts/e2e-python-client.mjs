// INT-1 and E2E-1: the real valun 0.4 Python client (valun-open/python), the JavaScript client
// @fitzdoud/valun 0.4.0 (valun-open/js) and the Hermes plugin hermes-plugin-valun 0.4.0 against the real v16 server, end
// to end, on this machine only. Each run (--modes; default sandbox, on, mcp, clients, faults) starts a fresh local stack in temp
// folders:
//   - two throwaway Basis trackers in WSL valun-ic1 (test/tracker-harness.mjs: own run folders, removed afterwards):
//     the demo tracker server.mjs needs and the pilot tracker (VALUN_BINS, default tracker v3.2, whose basis_server
//     sha256 is pinned in lib/pilot/pins.mjs);
//   - server.mjs (PILOT_CIRCULATION=<mode>, PILOT_OPEN_SANDBOX=1, PILOT_TRACKER_SHA256 computed here, sandbox agents
//     and the clearing engine running), data in a temp folder, on free loopback ports;
// then drives the clients and checks the wire contract:
//   run sandbox (mode sandbox) and run on (mode on):
//   1. valun join --sandbox, then valun sandbox tour --yes: after each of the five steps the exact tracker totals of
//      design §9.2 (the tour's own GET /edges read, the public ledger, reconciliation match and its own edges exact, GET /clearing);
//   2. a scripted series of tool calls through valun call: valun_status fields, an own-note payment, a payment with
//      pay_with=<issuer>, consents (valun clearing run), valun attempts list, and decision D-3 b (every consent role
//      turned off: the next request withdraws the roles and the server forgets them at once); then probes on a third
//      profile: console approvals, a payment by transfer held for the owner and rejected, an own note refused within
//      the attempt's window (decision D-1) while a same-issuer retry on the same prior state is not (the same-prior
//      exemption of tracker v3.2: the server gives its template, the client signs it, it is held and rejected again),
//      the rejected deal disputed, a second deal's payment by transfer held, approved and applied, how valun
//      attempts list judges it, a payment TO the client by transfer (its client signs as payee), and the owner resolve route of decision
//      D-2 d (POST /owner/deals/:vd/attempts/:vt/resolve: what it refuses on attempts whose outcome is known); in mode
//      on also three invited participants, where one pays with another's note and the issuer's and payee's clients
//      sign their consents, a credit note on an edge a transfer holds gets 409 novation_pending and goes through once
//      the consent is dealt with, and the issuer's client refuses a consent (POST /consents/:id/refuse);
//   run mcp (mode sandbox, a server of its own):
//   3. one MCP session over stdio with the official MCP SDK (scripts/e2e-python-mcp.py, run by VALUN_PYTHON) that
//      follows sandbox_next_steps through the whole tour, answers the approval elicitations, and checks all six totals
//      of design 9.2 after every step; the tour's set-offs are signed by valun mcp's background consent loop;
//   run clients (mode on):
//   4. the JavaScript client (scripts/e2e-js-smoke.mjs): join sandbox, valun_status, the welcome job, a pay_with, a
//      consent, set-off regeneration, and decision D-2 c (a note held for the owner supersedes the set-off on its pair
//      and keeps new ones off it until it is released);
//   5. the Hermes plugin through Hermes's real dispatch path (scripts/e2e-hermes-dispatch.py, run by HERMES_PYTHON in
//      the fresh short Hermes home E2E_HERMES_HOME): one approved and one declined commitment through Hermes's approval
//      gate, and a set-off signed during valun_status (decision D-3 a);
//   run faults (mode on; the server's clock can be moved: scripts/e2e-clock.mjs, and its pilot tracker is reached
//   through a fault proxy in this process):
//   6. decision D-1: an attempt's window (T + 1 h + 60 s) expires after a clock jump of 59 minutes (the attempt was made
//      on a server clock 59 minutes behind, which the tracker's one-hour maximum age still accepts); a credit note whose
//      timestamp would be ahead of the server clock gets 409 note_timestamp_ahead and goes through after retry_after_ms;
//      decision D-2 b: a payment by transfer refused when it is posted (409 transfer_stale after a clock jump of 11
//      minutes between its template and its post) is recorded by the server, which then holds the payer's own note to
//      the attempt's window but not a same-issuer retry on the same prior state (the same-prior exemption: held for the
//      owner, rejected, the deal disputed); and 409 pair_busy: a held note released while
//      the tracker's answer to its POST /notes is lost (the fault proxy drops it) leaves its deal issuing_note, a second
//      note on the pair waits retry_after_ms, and then goes through.
// It exits 0 only when every check passes, 1 on any mismatch, 2 when the stack cannot be started.
// Nothing here uses the network beyond loopback; the keys and tokens are throwaway ones in the temp folder. Every
// profile joins at the start of its run (sandbox joins: at most 3 per address per hour, so a run may have three).
// The server keeps its default rate limits and all participants share 127.0.0.1: a 429 rate_limited answer is waited
// out and repeated (RATE_PAUSE_MS), and the pauses are counted in the summary.
//
// Usage: node scripts/e2e-python-client.mjs [--modes sandbox,on,clients,faults] [--only PARTS] [--keep] [--serve]
//                                           [--base URL [--admin-token-file F] [--mcp-exact]]
//   --modes  the runs, in order: sandbox (mode sandbox: tour, calls, probes), on (mode on: tour, calls, probes,
//            invited), mcp (mode sandbox: mcp), clients (mode on: js, hermes), faults (mode on: faults); default all five
//   --keep   keep the temp folders (profiles, logs, server data) and print where they are
//   --only   run only some parts: tour, calls, probes, invited, mcp, js, hermes, faults (comma-separated; default all;
//            calls needs tour; invited runs in mode on only)
//   --serve  only start the stack of the first run, print its URL, and wait (Ctrl+C, or create the file STOP in the
//            temp folder, stops it)
//   --base   use a stack that is already running (for example scripts/start-local.mjs on http://127.0.0.1:4320) instead
//            of starting one: one run, of the first --modes entry's circulation mode, with the parts --only names; it is
//            never stopped here. --admin-token-file names its admin token (invited needs it); --mcp-exact also checks
//            the sandbox agents' own two edges after each MCP tour step (only right on a server where nothing else has
//            dealt with them: run --only mcp on a fresh stack).
// Environment: VALUN_BINS (a WSL path; from Git Bash set MSYS2_ENV_CONV_EXCL=VALUN_), VALUN_OPEN (the valun-open
// checkout), VALUN_PYTHON (a Python with the official mcp SDK; default VALUN_OPEN/.venv), HERMES_PYTHON (the Hermes
// venv's Python), E2E_HERMES_HOME (a short, empty folder for the Hermes home; default hv04 in the system temp folder; emptied
// again afterwards), VALUN_PLUGIN (the hermes-plugin-valun git checkout), E2E_PORT_BASE (default 4391: the app uses the
// first free port from there, the trackers the first free ones from E2E_PORT_BASE - 1200).
import {spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nodeHttp from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V32_BINS = '/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release';
// Git Bash rewrites /home/... in environment variables for Windows programs: undo that for the WSL path.
const unGit = v => (v && /^[A-Za-z]:[\\/].*?[\\/]Git[\\/](home[\\/].*)$/i.test(v) ? '/' + /[\\/]Git[\\/](home[\\/].*)$/i.exec(v)[1].replace(/\\/g, '/') : v);
process.env.VALUN_BINS = unGit(process.env.VALUN_BINS) || V32_BINS;
const {startTracker, trackerSha256, capabilities, signerPath, runner} = await import('../test/tracker-harness.mjs');
const {validateCaps} = await import('../lib/pilot/caps.mjs');
const {TRACKER_SHA256_PINS} = await import('../lib/pilot/pins.mjs');

const VALUN_OPEN = process.env.VALUN_OPEN || '..';   // valun-open's root: this server/ folder's parent
const PYTHON = process.env.VALUN_PYTHON || path.join(VALUN_OPEN, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PY_SRC = path.join(VALUN_OPEN, 'python', 'src');
const MCP_DRIVER = path.join(root, 'scripts', 'e2e-python-mcp.py');
const PILOT_TOKEN_ID = crypto.createHash('sha256').update('valun-pilot-credit/1').digest('hex');
const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
// The runs: each starts its own stack (a fresh server keeps its own sandbox join budget: 3 per address per hour).
const RUNS = {
  sandbox: {mode: 'sandbox', parts: ['tour', 'calls', 'probes']},
  on: {mode: 'on', parts: ['tour', 'calls', 'probes', 'invited']},
  // The MCP tour on a server of its own: design 9.2's totals hold only while the sandbox agents' own edges are as a fresh
  // server has them (with notes of sandbox-exact in hand, sandbox-mallory pays by transfer instead of with its own note).
  mcp: {mode: 'sandbox', parts: ['mcp'], exactMcp: true},
  clients: {mode: 'on', parts: ['js', 'hermes']},
  faults: {mode: 'on', parts: ['faults'], faults: true},
};
const MODES = opt('--modes', 'sandbox,on,mcp,clients,faults').split(',').map(s => s.trim()).filter(Boolean);
for (const m of MODES) if (!RUNS[m]) { console.error(`--modes: ${m} is not sandbox, on, mcp, clients or faults`); process.exit(2); }
const KEEP = flag('--keep'), SERVE = flag('--serve'), BASE = opt('--base', null), ADMIN_FILE = opt('--admin-token-file', null), MCP_EXACT = flag('--mcp-exact');
if (BASE && !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) { console.error('--base: a loopback URL http://127.0.0.1:PORT'); process.exit(2); }
// --only: run only these parts (default all; calls builds on the state the tour leaves; invited runs in mode on only).
const ALL_PARTS = ['tour', 'calls', 'probes', 'invited', 'mcp', 'js', 'hermes', 'faults'];
const PARTS = new Set(opt('--only', ALL_PARTS.join(',')).split(',').map(s => s.trim()).filter(Boolean));
for (const x of PARTS) if (!ALL_PARTS.includes(x)) { console.error(`--only: ${x} is not one of ${ALL_PARTS.join(', ')}`); process.exit(2); }
if (PARTS.has('calls') && !PARTS.has('tour')) { console.error('--only: calls builds on the state the tour leaves; add tour'); process.exit(2); }
if (BASE && PARTS.has('faults')) { console.error('--base: the faults part needs a stack this script starts (its clock and fault proxy)'); process.exit(2); }
const HERMES_PYTHON = process.env.HERMES_PYTHON || 'python';
const HERMES_HOME_DIR = process.env.E2E_HERMES_HOME || path.join(os.tmpdir(), 'hv04');
const PLUGIN_DIR = process.env.VALUN_PLUGIN || '../../hermes-plugin-valun';
const CLOCK_MODULE = path.join(root, 'scripts', 'e2e-clock.mjs');
const PORT_BASE = Number(process.env.E2E_PORT_BASE || 4391);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (...a) => console.log(`[${stamp()}]`, ...a);

// ---------- checks ----------
let failures = [];
function check(ok, what, detail) {
  if (ok) { say(`  ok    ${what}`); return true; }
  failures.push({what, detail});
  say(`  FAIL  ${what}${detail === undefined ? '' : `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return false;
}
class Abort extends Error {}
const must = (ok, what, detail) => { if (!check(ok, what, detail)) throw new Abort(what); };

// ---------- ports ----------
const freeOnWindows = port => new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
function wslListening() {
  if (runner !== 'wsl') return new Set();
  const r = spawnSync('C:/Windows/System32/wsl.exe', ['-d', 'valun-ic1', '-u', 'valun', '--exec', '/bin/sh', '-c', 'ss -Htln 2>/dev/null || netstat -tln 2>/dev/null'], {encoding: 'utf8'});
  return new Set([...String(r.stdout || '').matchAll(/:(\d+)\s/g)].map(m => Number(m[1])));
}
async function freePorts(from, n, taken) {
  const wsl = wslListening(), out = [];
  for (let p = from; out.length < n && p < from + 200; p++) if (!taken.has(p) && !wsl.has(p) && await freeOnWindows(p)) { out.push(p); taken.add(p); }
  if (out.length < n) throw Error(`no ${n} free ports from ${from}`);
  return out;
}

// ---------- HTTP ----------
// The server keeps its default budgets (lib/pilot/http.mjs: 90 writes and 360 reads a minute per address and per token),
// and every participant of a run shares 127.0.0.1, so a busy part of the run can get 429 rate_limited. That answer comes
// before the server does anything, so the request (or CLI command) is made again after a pause, as an agent would. Each
// pause is counted and shown in the summary; it is never a failure. Joins are made first, before the run gets busy.
const RATE_PAUSE_MS = 15000, RATE_TRIES = 8;
let ratePauses = 0;
async function http(base, method, p, {token, body} = {}) {
  for (let i = 1; ; i++) {
    const r = await fetch(base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)});
    const text = await r.text(); let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status === 429 && i < RATE_TRIES) { ratePauses++; say(`  (429 rate_limited on ${method} ${p}; again in ${RATE_PAUSE_MS / 1000} s)`); await sleep(RATE_PAUSE_MS); continue; }
    return {status: r.status, body: json, text};
  }
}

// ---------- the stack ----------
// Every stack this process started, so that a signal (Ctrl+C, a kill) still stops its trackers and server.
const live = new Set();
let signalled = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, async () => {
  if (signalled) return;
  signalled = true;
  say(`${sig}: stopping the stack`);
  for (const s of live) await s.stop().catch(() => {});
  process.exit(130);
});
// On any other way out (an uncaught error, process.exit while a stack runs) the live stacks are stopped synchronously:
// the server is killed, each WSL tracker this process started is killed by its pid file and its throwaway run folder
// removed (as the harness's stop() does), and the fault proxy closed.
function stopLiveNow() {
  for (const s of live) {
    live.delete(s);
    try { if (s.server && s.server.exitCode === null) s.server.kill(); } catch { /* gone */ }
    try { s.proxy?.close(); } catch { /* closed */ }
    for (const t of s.trackers || []) {
      if (runner === 'wsl' && /^\/home\/valun\/valun-app-test-\d{8}T\d{6}Z-\d+(-[0-9a-f]{8})?$/.test(t.run ?? '')) {
        spawnSync('C:/Windows/System32/wsl.exe', ['-d', 'valun-ic1', '-u', 'valun', '--exec', '/bin/sh', '-c',
          '[ -s "$1/tracker.pid" ] && kill "$(cat "$1/tracker.pid")"; sleep 0.3; rm -rf --one-file-system "$1"', 'sh', t.run]);
      }
    }
  }
}
process.on('exit', stopLiveNow);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => {
  console.error(`[${stamp()}] ${ev}: ${e?.stack || e}; stopping the live stacks`);
  stopLiveNow();
  process.exit(2);
});
// The fault proxy (run faults only): server.mjs reaches its pilot tracker through it. It forwards every request as it
// is; while drop.notePosts > 0 it forwards the next POST /notes to the tracker (which applies it) but never answers the
// server (the socket is closed after 15 s; the server gives up after its own 10 s), and from then on, until the e2e
// lifts it (state.blockReads = false), answers 503 to every read of a pair (GET /notes/issuer/..., /tracker/proof): a
// note on the tracker that the server cannot read back, as during a tracker outage in the middle of a submission.
function startFaultProxy(target, port) {
  const state = {drop: {notePosts: 0}, dropped: [], requests: 0, blockReads: false, blocked: 0};
  const server = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      state.requests++;
      const drop = req.method === 'POST' && req.url.split('?')[0] === '/notes' && state.drop.notePosts > 0;
      if (drop) { state.drop.notePosts--; state.blockReads = true; }
      if (req.method === 'GET' && state.blockReads && /^\/(notes\/issuer\/|tracker\/proof)/.test(req.url)) {
        state.blocked++;
        res.writeHead(503, {'content-type': 'application/json'});
        res.end('{"error":"unavailable (e2e fault proxy)"}');
        return;
      }
      try {
        const r = await fetch(target + req.url, {method: req.method, headers: {'content-type': req.headers['content-type'] || 'application/json'},
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(30000)});
        const buf = Buffer.from(await r.arrayBuffer());
        if (drop) { state.dropped.push({url: req.url, status: r.status, at: Date.now()}); setTimeout(() => res.destroy(), 15000); return; }
        res.writeHead(r.status, {'content-type': r.headers.get('content-type') || 'application/json'});
        res.end(buf);
      } catch { res.writeHead(502); res.end(); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({url: `http://127.0.0.1:${port}`, state, close: () => server.close()}));
  });
}
async function startStack(mode, tmp, {faults = false} = {}) {
  const taken = new Set();
  const [app, proxyPort] = await freePorts(PORT_BASE, 2, taken), [demoPort, pilotPort] = await freePorts(PORT_BASE - 1200, 2, taken);
  const logFile = path.join(tmp, `server-${mode}.log`), log = fs.openSync(logFile, 'a');
  const stack = {mode, base: `http://127.0.0.1:${app}`, logFile, trackers: [], server: null};
  live.add(stack);
  stack.stop = async () => {
    live.delete(stack);
    if (stack.server && stack.server.exitCode === null) {
      stack.server.kill();
      await Promise.race([new Promise(r => stack.server.once('exit', r)), sleep(5000)]);
    }
    for (const t of stack.trackers.reverse()) await t.stop().catch(e => say(`  (could not stop a tracker: ${e.message})`));
    try { stack.proxy?.close(); } catch { /* closed */ }
    try { fs.closeSync(log); } catch { /* closed */ }
  };
  try {
    say(`starting trackers (${process.env.VALUN_BINS}) on ${demoPort} and ${pilotPort}`);
    const demo = await startTracker(demoPort);
    stack.trackers.push(demo);
    const pilot = await startTracker(pilotPort, {servedTokenId: PILOT_TOKEN_ID});
    stack.trackers.push(pilot);
    const caps = await capabilities(pilot.url), v = validateCaps(caps), sha = caps ? await trackerSha256() : null;
    if (!v.ok || !TRACKER_SHA256_PINS.includes(sha)) throw Error(`the pilot tracker cannot run circulating credit: ${v.ok ? `basis_server ${sha} is not pinned` : v.reason}`);
    stack.sha = sha;
    if (faults) {
      stack.proxy = await startFaultProxy(pilot.url, proxyPort);
      stack.clockFile = path.join(tmp, 'server-clock-offset-ms');
      fs.writeFileSync(stack.clockFile, '0');
      say(`fault proxy ${stack.proxy.url} -> ${pilot.url}; server clock offset file ${stack.clockFile}`);
    }
    const dataDir = path.join(tmp, `data-${mode}`), pilotDir = path.join(tmp, `data-pilot-${mode}`);
    fs.mkdirSync(dataDir, {recursive: true}); fs.mkdirSync(pilotDir, {recursive: true});
    const env = {...process.env, HOST: '127.0.0.1', PORT: String(app), BASIS_RUNNER: runner, BASIS_SIGNER: signerPath,
      BASIS_TRACKER_URL: demo.url, BASIS_TRACKER_NFT_ID: demo.nft, VALUN_DATA_DIR: dataDir, VALUN_DEPLOYMENT: 'local', VALUN_SEED: '0',
      PILOT_TRACKER_URL: stack.proxy?.url ?? pilot.url, PILOT_TRACKER_NFT_ID: pilot.nft, PILOT_DATA_DIR: pilotDir,
      PILOT_CIRCULATION: mode, PILOT_OPEN_SANDBOX: '1', PILOT_TRACKER_SHA256: sha};
    for (const k of ['VALUN_WRITE_TOKEN', 'PILOT_SANDBOX', 'E2E_CLOCK_FILE']) delete env[k];
    if (faults) env.E2E_CLOCK_FILE = stack.clockFile;
    say(`starting server.mjs on ${stack.base} (PILOT_CIRCULATION=${mode}; log ${logFile})`);
    stack.server = spawn(process.execPath, [...(faults ? ['--import', pathToFileURL(CLOCK_MODULE).href] : []), path.join(root, 'server.mjs')],
      {cwd: root, env, stdio: ['ignore', log, log], windowsHide: true});
    stack.server.on('error', e => say(`  (server.mjs: ${e.message})`));
    const end = Date.now() + 60000;
    for (;;) {
      if (stack.server.exitCode !== null) throw Error(`server.mjs exited with ${stack.server.exitCode}; see ${logFile}`);
      const info = await http(stack.base, 'GET', '/info').catch(() => null);
      if (info?.status === 200) { stack.info = info.body; break; }
      if (Date.now() > end) throw Error(`server.mjs did not answer GET /pilot/v1/info within 60 s; see ${logFile}`);
      await sleep(500);
    }
    // The sandbox agents start after the server listens only on the first tick; wait until both are in the directory.
    for (let i = 0; i < 60; i++) {
      const ps = (await http(stack.base, 'GET', '/participants')).body || [];
      const ag = Object.fromEntries(ps.filter(x => ['sandbox-exact', 'sandbox-mallory'].includes(x.handle)).map(x => [x.handle, x]));
      if (ag['sandbox-exact'] && ag['sandbox-mallory']) { stack.agents = ag; break; }
      await sleep(500);
    }
    if (!stack.agents) throw Error('the sandbox agents did not appear in the directory');
    return stack;
  } catch (e) { await stack.stop(); throw e; }
}

// A stack that is already running (--base; for example scripts/start-local.mjs): never stopped here.
async function attachStack(mode, base) {
  const stack = {mode, base, trackers: [], server: null, attached: true, stop: async () => {}};
  const info = await http(base, 'GET', '/info').catch(e => ({status: 0, text: e.message}));
  if (info.status !== 200) throw Error(`${base} does not answer GET /pilot/v1/info (${info.status} ${info.text?.slice?.(0, 200) ?? ''})`);
  stack.info = info.body;
  const ps = (await http(base, 'GET', '/participants')).body || [];
  stack.agents = Object.fromEntries(ps.filter(x => ['sandbox-exact', 'sandbox-mallory'].includes(x.handle)).map(x => [x.handle, x]));
  if (!stack.agents['sandbox-exact'] || !stack.agents['sandbox-mallory']) throw Error('the sandbox agents are not in the directory');
  return stack;
}

// ---------- the Python CLI ----------
// VALUN_SERVER is the local stack: a profile that names no server never falls back to the client's default (the live
// network). VALUN_PROFILE is cleared: every command names its --profile.
// ctx.pyClock (run faults): a folder whose sitecustomize.py moves this client's clock by the offset in E2E_PY_CLOCK_FILE.
function pyEnv(ctx) {
  const env = {...process.env, VALUN_HOME: ctx.home, PYTHONPATH: PY_SRC, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    VALUN_SERVER: ctx.server ?? 'http://127.0.0.1:9', VALUN_PROFILE: ''};
  delete env.E2E_PY_CLOCK_FILE;
  if (ctx.pyClock) Object.assign(env, {PYTHONPATH: [PY_SRC, ctx.pyClock.dir].join(path.delimiter), E2E_PY_CLOCK_FILE: ctx.pyClock.file});
  return env;
}
// Runs one child process to its end: {code, out, err}. A child that cannot be started (spawn throws, as for a file
// that is no program, EFTYPE; or an 'error' event, as for a missing VALUN_PYTHON) ends as code -1 with the reason in
// err, never as an unhandled error.
function runChild(cmd, args, {env, cwd, input = '', timeoutMs = 300000, onOut = null, onErr = null} = {}) {
  return new Promise(resolve => {
    let out = '', err = '', done = false, t = null, child;
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    try { child = spawn(cmd, args, {env, cwd, windowsHide: true}); } catch (e) { finish({code: -1, out, err: `[could not run ${cmd}: ${e.message}]`}); return; }
    t = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', e => finish({code: -1, out, err: `${err}[could not run ${cmd}: ${e.message}]`}));
    child.stdout.setEncoding('utf8').on('data', d => { out += d; onOut?.(d); });
    child.stderr.setEncoding('utf8').on('data', d => { err += d; onErr?.(d); });
    child.on('close', code => finish({code, out, err}));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
// Runs `python -m valun <args>` to the end: {code, out, err}. The client's own log goes to <tmp>/cli.log.
// A command whose output names rate_limited is run again after a pause (see RATE_PAUSE_MS), except join, which is not
// safe to repeat (it creates the participant first) and is made at the start of a run.
async function valun(ctx, args, {input = '', timeoutMs = 300000} = {}) {
  for (let i = 1; ; i++) {
    const r = await valunOnce(ctx, args, {input, timeoutMs});
    if (/rate_limited/.test(r.out + r.err) && !args.includes('join') && i < RATE_TRIES) {
      ratePauses++;
      say(`  (rate_limited in \`valun ${args.slice(2, 4).join(' ')}\`; again in ${RATE_PAUSE_MS / 1000} s)`);
      await sleep(RATE_PAUSE_MS);
      continue;
    }
    return r;
  }
}
async function valunOnce(ctx, args, {input, timeoutMs}) {
  const {code, out, err} = await runChild(PYTHON, ['-m', 'valun', ...args], {env: pyEnv(ctx), cwd: ctx.tmp, input, timeoutMs});
  fs.appendFileSync(ctx.cliLog, `\n$ valun ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n[exit ${code}]\n${out}${err ? `[stderr]\n${err}` : ''}`);
  return {code, out, err};
}
const jsonOf = s => { try { return JSON.parse(s); } catch { return null; } };
// Runs a few lines of Python against the valun package (the profile folder of ctx): {code, out, err}.
async function pyLib(ctx, code) {
  for (let i = 1; ; i++) {
    const r = await runChild(PYTHON, ['-c', code], {env: pyEnv(ctx), cwd: ctx.tmp, timeoutMs: 180000});
    fs.appendFileSync(ctx.cliLog, `\n$ python -c <valun library code>\n[exit ${r.code}]\n${r.out}${r.err ? `[stderr]\n${r.err}` : ''}`);
    if (r.code !== 0 && /rate_limited/.test(r.err) && i < RATE_TRIES) { ratePauses++; say(`  (rate_limited in a library call; again in ${RATE_PAUSE_MS / 1000} s)`); await sleep(RATE_PAUSE_MS); continue; }
    return r;
  }
}

// ---------- tracker totals ----------
const HANDLES = {X: 'sandbox-exact', M: 'sandbox-mallory'};
// The six totals between S, X and M from the public ledger ('<issuer>><recipient>'; an edge that does not exist is 0).
// SV-PRIV-1: the public GET /ledger keeps v15's reconciliation rows (no journal columns), so "match and exact" reads two
// places: every public row is match (and v15's shape), and every edge of the participant's own, in GET /edges (its
// owner token), is exact.
const RECON_V15_KEYS = ['issuer', 'recipient', 'tracker_total', 'issued_via_valun', 'status'];
async function reconciledExactly(ctx, stack, rows, what) {
  check(rows.length > 0 && rows.every(r => r.status === 'match' && (r.pair !== undefined || JSON.stringify(Object.keys(r)) === JSON.stringify(RECON_V15_KEYS))),
    `${what}every public reconciliation row is match, in v15's shape (${rows.length} rows)`, rows.filter(r => r.status !== 'match' || 'exact' in r));
  const owner = fs.readFileSync(ctx.ownerFile, 'utf8').trim(), e = (await http(stack.base, 'GET', '/edges', {token: owner})).body || {};
  const mine = [...(e.incoming || []), ...(e.outgoing || [])];
  check(mine.length > 0 && mine.every(x => x.exact === true), `${what}every edge of the participant's is exact in GET /edges (${mine.length} edges)`, mine.filter(x => x.exact !== true));
}
async function ledgerTotals(stack, sHandle) {
  const r = await http(stack.base, 'GET', '/ledger');
  const name = {[sHandle]: 'S', [HANDLES.X]: 'X', [HANDLES.M]: 'M'}, out = {'S>X': 0, 'S>M': 0, 'X>S': 0, 'X>M': 0, 'M>S': 0, 'M>X': 0};
  for (const n of r.body?.notes || []) {
    const k = `${name[n.issuer_handle] ?? '?'}>${name[n.recipient_handle] ?? '?'}`;
    if (k in out) out[k] = n.total;
  }
  return {totals: out, ledger: r.body};
}
const ALL0 = {'S>X': 0, 'S>M': 0, 'X>S': 0, 'X>M': 0, 'M>S': 0, 'M>X': 0};
// Design §9.2: the tracker totals after each step of the tour.
const TOUR = {
  1: {'X>S': 3},
  2: {'X>S': 1, 'X>M': 2},
  3: {'X>S': 0, 'S>X': 1, 'X>M': 2},
  4: {'M>S': 2, 'S>X': 0, 'X>M': 1},
  5: {'M>S': 0, 'M>X': 1, 'X>M': 0},
};
// What S holds / owes after each step (design §9.2).
const TOUR_HOLD_OWE = {1: [3, 0], 2: [1, 0], 3: [0, 1], 4: [2, 0], 5: [0, 0]};
const sameTotals = (a, b) => Object.keys(ALL0).every(k => a[k] === b[k]);
// How long the step-5 check waits for the server-only set-off X<->M to apply after S's own step is done (runTour).
const SERVER_ONLY_WAIT_MS = 20000;

// The tour prints, when step N is done: "step N done. Your edges on the tracker: sandbox-exact -> you: 3 PC; ..."
function parseStepLine(line) {
  const m = /^step (\d) done\. Your edges on the tracker: (.*)$/.exec(line);
  if (!m) return null;
  const edges = {};
  if (m[2] !== 'none') for (const part of m[2].split('; ')) {
    const e = /^(.+?) -> (.+?): (\d+) PC$/.exec(part);
    if (e) edges[`${e[1]}>${e[2]}`] = Number(e[3]);
  }
  return {step: Number(m[1]), edges};
}
// S's own edges as the tour names them ('you', handles), from the six totals.
function ownEdges(t) {
  const n = {S: 'you', X: HANDLES.X, M: HANDLES.M}, out = {};
  for (const [k, v] of Object.entries(t)) { const [i, r] = k.split('>'); if ((i === 'S' || r === 'S')) out[`${n[i]}>${n[r]}`] = v; }
  return out;
}

async function runTour(ctx, stack) {
  // One run. sandbox-mallory delivers wrongly on purpose for about half of all deal ids; the tour disputes and buys again
  // (design 9.2) without counting that toward its stuck limit (valun 0.4 sandbox.TOUR_DISPUTES_PER_STEP, INT-1).
  say('valun sandbox tour --yes');
  const seen = [], pending = [], logPath = path.join(ctx.tmp, `tour-${stack.mode}.log`);
  const tourLog = fs.openSync(logPath, 'a');
  let buf = '', err = '';
  const onLine = line => {
    fs.writeSync(tourLog, `[${stamp()}] ${line}\n`);
    const st = parseStepLine(line);
    // Read at once, while the tour goes on (its next edge change needs a new deal: several seconds): the public ledger,
    // and valun_status through a second CLI process on the same profile (read-only; the FileStore lock serialises).
    if (st) pending.push((async () => {
      const [{totals, ledger}, status] = await Promise.all([ledgerTotals(stack, ctx.handle), tool(ctx, 'valun_status')]);
      seen.push({...st, totals, ledger, status: status.json, at: Date.now()});
    })());
    if (/^step \d of 5:|^step \d done|^The tour is complete|tour_|^\{/.test(line)) say(`  tour: ${line}`);
  };
  const onOut = d => {
    const lines = (buf + d).split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) onLine(l);
  };
  const run = await runChild(PYTHON, ['-m', 'valun', '--profile', ctx.profile, 'sandbox', 'tour', '--yes'],
    {env: pyEnv(ctx), cwd: ctx.tmp, timeoutMs: 1500000, onOut, onErr: d => { err += d; fs.writeSync(tourLog, d); }});
  const code = run.code;
  if (code === -1) err += run.err;
  if (buf) onLine(buf);
  await Promise.all(pending);
  fs.closeSync(tourLog);
  check(code === 0, `valun sandbox tour --yes exits 0 (mode ${stack.mode})`, code === 0 ? undefined : `exit ${code}; see ${path.join(ctx.tmp, `tour-${stack.mode}.log`)}${err ? `; stderr: ${err.slice(-800)}` : ''}`);
  const steps = new Map(seen.map(s => [s.step, s]));
  for (let n = 1; n <= 5; n++) {
    const s = steps.get(n), want = {...ALL0, ...TOUR[n]};
    if (!check(!!s, `tour step ${n} reported done`)) continue;
    check(JSON.stringify(sortKeys(s.edges)) === JSON.stringify(sortKeys(nonZeroOrListed(ownEdges(want), s.edges))),
      `step ${n}: the tour's GET /edges totals are design §9.2's`, {printed: s.edges, expected: ownEdges(want)});
    if (n === 5) {
      // Step 5 ends with the server-only 2-cycle X<->M, which the server proposes and applies on its own after S's payment
      // applied, so the snapshot read when the tour prints 'step 5 done' can precede that apply (E2E-2's container
      // rehearsal: the set-off applied 173 ms after that line, while the read was under way). S's own edges must be final
      // in that snapshot; the public ledger is then read again until it has all six totals, for at most SERVER_ONLY_WAIT_MS.
      const own = t => Object.fromEntries(Object.keys(ALL0).map(k => [k, k.includes('S') ? t[k] : 0]));
      check(sameTotals(own(s.totals), own(want)), 'step 5: S\'s own edges in the public ledger are final when the tour prints step 5 done', {ledger: s.totals, expected: want});
      const first = s.totals, t0 = Date.now();
      while (!sameTotals(s.totals, want) && Date.now() - t0 < SERVER_ONLY_WAIT_MS) { await sleep(250); s.totals = (await ledgerTotals(stack, ctx.handle)).totals; }
      if (s.totals !== first) say(`  step 5: the server-only cycle X<->M was read ${sameTotals(s.totals, want) ? 'cleared' : 'still open'} ${Date.now() - t0} ms after the first snapshot ${JSON.stringify(first)}`);
    }
    check(sameTotals(s.totals, want), `step ${n}: the public ledger totals are design §9.2's`, {ledger: s.totals, expected: want});
    const mv = s.status?.money_view;
    check(mv && mv.you_hold_PC === TOUR_HOLD_OWE[n][0] && mv.you_owe_PC === TOUR_HOLD_OWE[n][1] && mv.net_PC === mv.you_hold_PC - mv.you_owe_PC,
      `step ${n}: valun_status money_view holds ${TOUR_HOLD_OWE[n][0]} and owes ${TOUR_HOLD_OWE[n][1]} PC`, mv ?? s.status);
  }
  return {code, steps};
}

// After the tour: every reconciliation row match and exact, GET /clearing counts, and valun_status says done.
async function afterTour(ctx, stack, before = {}) {
  const {totals, ledger} = await ledgerTotals(stack, ctx.handle);
  check(sameTotals(totals, {...ALL0, ...TOUR[5]}), 'after the tour the ledger still has the step-5 totals', totals);
  await reconciledExactly(ctx, stack, ledger?.reconciliation || [], '');
  // GET /clearing answers from a cache of up to 10 s: while it still lacks the tour's last set-off (the server-only one of
  // step 5, which runTour waited for in the ledger), it is read again, for at most 12 s.
  let cl = await http(stack.base, 'GET', '/clearing');
  for (const t0 = Date.now(); cl.status === 200 && (cl.body?.totals?.setoffs_applied ?? 0) - (before.setoffs_applied ?? 0) < 3 && Date.now() - t0 < 12000;) {
    await sleep(500); cl = await http(stack.base, 'GET', '/clearing');
  }
  // The counts of this tour: GET /clearing now less what it showed right before the tour (0 on a fresh server).
  const t = cl.body?.totals || {}, d = k => (t[k] ?? 0) - (before[k] ?? 0);
  check(cl.status === 200 && d('setoffs_applied') === 3 && d('transfers_applied') === 2,
    'GET /clearing counts 3 set-offs and 2 transfers for the tour', {now: cl.body?.totals ?? cl.text, before});
  // cleared_PC is the gross debt the set-offs cancelled, summed over their edges: 2 (S>X>S) + 3 (M>S>X>M) + 2 (X<>M).
  check(d('cleared_PC') === 7 && d('transferred_PC') === 4, 'GET /clearing: 7 PC of gross debt cleared, 4 PC transferred by the tour', {now: t, before});
  // The client's capability header (X-Valun-Features) reached the server: the owner view lists its consent roles.
  const owner = fs.readFileSync(ctx.ownerFile, 'utf8').trim();
  const ov = await http(stack.base, 'GET', '/owner', {token: owner});
  check(ov.status === 200 && JSON.stringify(ov.body?.features?.consent_roles) === JSON.stringify(['setoff', 'issuer', 'creditor'])
    && (ov.body?.features?.server || []).includes('circulation/1'), 'GET /owner features: the client declared setoff, issuer and creditor (X-Valun-Features)', ov.body?.features ?? ov.text);
  check(ov.body?.mandate?.auto_clear === true && ov.body?.mandate?.accept_transfers === true && ov.body?.mandate?.novate_own_debt === true,
    'GET /owner mandate: auto_clear (set by join --clearing auto), accept_transfers and novate_own_debt on', pick(ov.body?.mandate, ['auto_clear', 'accept_transfers', 'novate_own_debt', 'accept_notes_from']));
  const st = (await tool(ctx, 'valun_status')).json || {};
  check(st.sandbox_next_steps?.tour_step === 'done', 'valun_status sandbox_next_steps says the tour is done', st.sandbox_next_steps);
  check(JSON.stringify(pick(st.money_view, ['you_hold_PC', 'you_owe_PC', 'net_PC', 'cleared_so_far_PC'])) === JSON.stringify({you_hold_PC: 0, you_owe_PC: 0, net_PC: 0, cleared_so_far_PC: 2}),
    'valun_status money_view after the tour: hold 0, owe 0, net 0, cleared 2', st.money_view);
}
const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o?.[k]]));

// ---------- valun call ----------
async function tool(ctx, name, args = {}) {
  const r = await valun(ctx, ['--profile', ctx.profile, 'call', name, JSON.stringify(args)]);
  return {code: r.code, json: jsonOf(r.out), out: r.out, err: r.err};
}
// valun_deal until its status is one of `statuses` (or the time is up: null).
async function dealUntil(ctx, id, statuses, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const d = (await tool(ctx, 'valun_deal', {deal_id: id})).json;
    if (d && statuses.includes(d.status)) return d;
    if (Date.now() > end) return d && {...d, timed_out: true};
    await sleep(2000);
  }
}
const job = (service, text) => ({title: `${service} job`, description: `${service} for this text:\n\`\`\`\n${text}\n\`\`\``,
  deliverable: `The exact ${service} result as JSON.`, deliver_within_hours: 24, offer_valid_hours: 1});
async function expectTotals(stack, ctx, want, what) {
  // Server-run parts (the sandbox agents' replies, a server-only set-off) may still be applying: up to 20 s.
  const end = Date.now() + 20000;
  let t;
  for (;;) {
    t = (await ledgerTotals(stack, ctx.handle)).totals;
    if (sameTotals(t, {...ALL0, ...want}) || Date.now() > end) break;
    await sleep(500);
  }
  return check(sameTotals(t, {...ALL0, ...want}), what, {ledger: t, expected: {...ALL0, ...want}});
}

// Buy `service` from `seller` and pay with `payWith` ('own_note' or an issuer handle); a wrong delivery is disputed and
// the purchase made again (sandbox-mallory is wrong on purpose about half the time). Returns the paid deal's view.
async function buy(ctx, seller, service, price, payWith, text) {
  // sandbox-mallory is wrong on purpose for about half of all deal ids: 12 tries leave a 1 in 4096 chance of no right one.
  for (let attempt = 1; attempt <= 12; attempt++) {
    const p = await tool(ctx, 'valun_propose', {counterparty: seller, role: 'payer', ...job(service, `${text} (try ${attempt})`), price});
    must(p.code === 0 && p.json?.deal_id, `valun_propose: offer ${service} to ${seller}`, p.json ?? p.out);
    const d = await dealUntil(ctx, p.json.deal_id, ['delivered', 'declined', 'expired', 'withdrawn']);
    must(d?.status === 'delivered', `${seller} accepts and delivers deal ${p.json.deal_id}`, d?.status);
    const exact = d.delivery?.checked_exactly_by_your_client;
    must(exact?.checked === true, 'valun_deal checks the delivery exactly (checked_exactly_by_your_client)', exact);
    if (!exact.exact_result_matches) {
      const r = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'dispute', reason: `wrong in: ${(exact.differs_in || []).join(', ')}`});
      must(r.code === 0 && r.json?.status === 'disputed', 'valun_review_delivery dispute of a wrong delivery', r.json ?? r.out);
      say(`  (deal ${d.id}: the delivery was wrong; disputed, buying again)`);
      continue;
    }
    if (payWith !== 'own_note') {
      const how = d.how_you_can_pay?.options || [];
      const opt = how.find(o => o.pay_with === payWith);
      check(opt?.available === true && opt?.issuer_consents === 'immediate', `valun_deal how_you_can_pay offers pay_with=${payWith} (available, issuer consents immediately)`, how);
      check(how.some(o => o.pay_with === 'own_note' && o.available === true), 'valun_deal how_you_can_pay offers own_note', how);
    }
    const r = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: payWith, expected_deliverable_sha256: d.delivery.sha256});
    const want = payWith === 'own_note' ? 'note_issued' : 'paid_by_transfer';
    must(r.code === 0 && r.json?.status === want, `valun_review_delivery accept pay_with=${payWith} gives ${want}`, r.json ?? r.out);
    if (payWith !== 'own_note') {
      check(r.json.payment?.issuer?.handle === payWith && r.json.payment?.state === 'applied' && /^vt_[0-9a-f]{16}$/.test(r.json.payment?.transfer_id ?? ''),
        'the pay_with answer carries the applied transfer (payment: issuer, state, transfer_id)', r.json.payment);
    } else {
      check(r.json.credit_note?.state === 'recorded' || r.json.credit_note?.tracker_status === 200 || r.json.credit_note?.amount_PC === price,
        'the own-note answer carries its credit note', r.json.credit_note);
    }
    return {deal: d, answer: r.json};
  }
  throw new Abort(`${seller} did not deliver a right result in 12 purchases`);
}

async function callSeries(ctx, stack) {
  say('scripted tool calls through valun call');
  const doc = await valun(ctx, ['--profile', ctx.profile, 'doctor']);
  check(doc.code === 0 && /Tracker and unit: the ones pinned in this profile/.test(doc.out) && /All set\./.test(doc.out), 'valun doctor: pinned tracker and unit, all set', doc.out + doc.err);
  const vs = await valun(ctx, ['--profile', ctx.profile, 'status']);
  check(vs.code === 0 && /consents:\s+setoff on, as_issuer on, as_new_creditor on, max_PC 50; consent loop: on/.test(vs.out), 'valun status: the sandbox consent policy and loop', vs.out);
  // A commitment without a person at the terminal, in approvals mode ask: refused, nothing signed.
  const refused = await tool(ctx, 'valun_propose', {counterparty: HANDLES.X, role: 'payee', ...job('text-stats', 'refused without a terminal'), price: 3});
  check(refused.code === 3 && refused.json?.error === 'approval_unavailable', 'approvals ask: valun call refuses a commitment without a terminal (approval_unavailable, exit 3)', refused.json ?? refused.out);
  const cfg = await valun(ctx, ['--profile', ctx.profile, 'config', 'approvals', 'none']);
  must(cfg.code === 0, 'valun config approvals none', cfg.out + cfg.err);

  // valun_status fields with circulating credit (design §6.4).
  const st = (await tool(ctx, 'valun_status')).json || {};
  const keys = ['summary', 'money_view', 'notes_you_can_spend', 'payments_in_progress', 'clearing', 'consent_policy_in_force', 'sandbox_next_steps'];
  check(keys.every(k => k in st), 'valun_status has the circulation fields', keys.filter(k => !(k in st)));
  check(Array.isArray(st.clearing?.your_client_signs) && st.clearing.your_client_signs.length === 3, 'valun_status clearing: the client signs all three consent roles', st.clearing);
  check(st.consent_policy_in_force?.setoff === true && st.consent_policy_in_force?.as_issuer === true && st.consent_policy_in_force?.as_new_creditor === true,
    'valun_status consent_policy_in_force: setoff, as_issuer and as_new_creditor', st.consent_policy_in_force);
  check(/not settled: a credit note is an outstanding obligation\. With circulating credit/.test(st.settlement ?? ''), 'valun_status settlement is the circulation label', st.settlement);
  const box = (await tool(ctx, 'valun_inbox')).json || {};
  check('consents_waiting_for_your_client' in box && 'payments_in_progress' in box, 'valun_inbox has consents_waiting_for_your_client and payments_in_progress', Object.keys(box));

  // Earn: offer text-stats to sandbox-exact, deliver the exact result, it pays with its own bound note.
  const o = await tool(ctx, 'valun_propose', {counterparty: HANDLES.X, role: 'payee', ...job('text-stats', 'INT-1: a job I sell after the tour.'), price: 3});
  must(o.code === 0 && o.json?.deal_id, 'valun_propose: offer text-stats to sandbox-exact', o.json ?? o.out);
  const agreed = await dealUntil(ctx, o.json.deal_id, ['agreed', 'declined', 'expired']);
  must(agreed?.status === 'agreed', 'sandbox-exact accepts the offer', agreed?.status);
  const dl = await tool(ctx, 'valun_deliver', {deal_id: o.json.deal_id, exact_result: true});
  must(dl.code === 0 && dl.json?.status === 'delivered' && dl.json?.exact_result?.service === 'text-stats', 'valun_deliver exact_result=true', dl.json ?? dl.out);
  const paid = await dealUntil(ctx, o.json.deal_id, ['note_issued', 'disputed']);
  check(paid?.status === 'note_issued', 'sandbox-exact pays the delivery with its credit note', paid?.status);
  await expectTotals(stack, ctx, {'X>S': 3, 'M>X': 1}, 'after earning: X>S 3 (M>X 1 from the tour)');
  const held = ((await tool(ctx, 'valun_status')).json || {}).notes_you_can_spend || [];
  check(held.length === 1 && held[0].issuer === HANDLES.X && held[0].amount_PC === 3 && held[0].checked_by_your_client === true && held[0].issuer_consents === 'immediate',
    'valun_status notes_you_can_spend: 3 PC of sandbox-exact, checked by the client against the issuer signature', held);

  // Pay with a note held: buy notary from sandbox-mallory with pay_with=sandbox-exact. Then the server-only 2-cycle
  // X>M 2 / M>X 1 clears 1.
  const t1 = await buy(ctx, HANDLES.M, 'notary', 2, HANDLES.X, 'INT-1: paid with a note I hold.');
  await expectTotals(stack, ctx, {'X>S': 1, 'X>M': 1, 'M>X': 0}, 'after pay_with=sandbox-exact: X>S 1, X>M 1 (the server-only X<>M cycle cleared 1)');
  const ds = (await tool(ctx, 'valun_deal', {deal_id: t1.deal.id})).json || {};
  check(ds.status === 'paid_by_transfer' && ds.payment?.issuer?.handle === HANDLES.X && /^nobody/.test(ds.whose_turn ?? ''),
    'valun_deal of the transfer-paid deal: paid_by_transfer, payment.issuer, whose_turn', pick(ds, ['status', 'payment', 'whose_turn']));

  // Pay with an own (bound) note: buy notary from sandbox-exact; the 2-cycle S>X 2 / X>S 1 then waits for this client's
  // set-off consent, which valun clearing run signs.
  await buy(ctx, HANDLES.X, 'notary', 2, 'own_note', 'INT-1: paid with my own note.');
  await expectTotals(stack, ctx, {'X>S': 1, 'S>X': 2, 'X>M': 1}, 'after pay_with=own_note: S>X 2 (the cycle waits for the client)');
  const run = await valun(ctx, ['--profile', ctx.profile, 'clearing', 'run']);
  check(run.code === 0 && /signed\s+setoff vs_[0-9a-f]{16} as member/.test(run.out), 'valun clearing run signs the set-off as member', run.out + run.err);
  await expectTotals(stack, ctx, {'X>S': 0, 'S>X': 1, 'X>M': 1}, 'after the set-off: X>S 0, S>X 1');
  const st2 = (await tool(ctx, 'valun_status')).json || {};
  check(JSON.stringify(pick(st2.money_view, ['you_hold_PC', 'you_owe_PC', 'net_PC', 'cleared_so_far_PC'])) === JSON.stringify({you_hold_PC: 0, you_owe_PC: 1, net_PC: -1, cleared_so_far_PC: 3}),
    'valun_status money_view after the calls: hold 0, owe 1, net -1, cleared 3', st2.money_view);
  check((st2.clearing?.recent || []).some(e => e.kind === 'setoff' && e.decision === 'signed'), 'valun_status clearing.recent shows the signed set-off', st2.clearing?.recent);
  const cs = await valun(ctx, ['--profile', ctx.profile, 'clearing', 'status']);
  check(cs.code === 0 && /Cleared by set-off so far: 3 PC; you hold 0 PC and owe 1 PC \(net -1 PC\)/.test(cs.out), 'valun clearing status', cs.out + cs.err);
  const ps = await valun(ctx, ['--profile', ctx.profile, 'policy', 'show']);
  check(ps.code === 0 && (ps.out.match(/signed by your client/g) || []).length === 3, 'valun policy show: all three roles signed by the client', ps.out + ps.err);

  // valun attempts list: every payment attempt the client records, judged as the evaluators judge them.
  const al = await valun(ctx, ['--profile', ctx.profile, 'attempts', 'list']);
  check(al.code === 0 && /Payment attempts your Valun client records/.test(al.out), 'valun attempts list exits 0 and lists attempts', al.out + al.err);
  check(!/MAY HAVE APPLIED|not known yet|cannot be proven dead/.test(al.out), 'valun attempts list: no attempt is unknown, unread or unproven', al.out);
  const lines = al.out.split(/\r?\n/), deals = lines.filter(l => /^deal vd_/.test(l));
  check(deals.length >= 5 && deals.every(l => /recorded as paid$/.test(l)), 'valun attempts list: every deal with an attempt is recorded as paid', deals);
  const atts = lines.filter(l => /^\s+#\d+ /.test(l));
  check(atts.length >= 5 && atts.every(l => /applied: the deal is paid by it$/.test(l)), 'valun attempts list: every attempt applied', atts);
  check(atts.some(l => /paying with the note of .*server id vt_[0-9a-f]{16}/.test(l)) && atts.some(l => /your credit note to/.test(l)),
    'valun attempts list shows transfers (with their server id) and own notes', atts);

  // Decision D-3 b: with every consent role off, the client's next request carries X-Valun-Features: consents/1;roles=
  // (no role) and the server forgets the roles it recorded for this client at once (no 7-day carry-over).
  const owner = fs.readFileSync(ctx.ownerFile, 'utf8').trim();
  const rolesNow = async () => (await http(stack.base, 'GET', '/owner', {token: owner})).body?.features?.consent_roles;
  for (const k of ['consents.setoff', 'consents.as_issuer', 'consents.as_new_creditor']) {
    const c = await valun(ctx, ['--profile', ctx.profile, 'config', k, 'off']);
    must(c.code === 0, `valun config ${k} off`, c.out + c.err);
  }
  check(JSON.stringify(await rolesNow()) === JSON.stringify(['setoff', 'issuer', 'creditor']), 'D-3 b: before the next request the server still has the three roles', await rolesNow());
  const rs = await tool(ctx, 'valun_status');
  check(rs.code === 0 && JSON.stringify(rs.json?.clearing?.your_client_signs ?? null) === '[]', 'D-3 b: valun_status says the client signs no consent role now', rs.json?.clearing);
  check(JSON.stringify(await rolesNow()) === '[]', 'D-3 b: after that one request GET /owner features.consent_roles is [] (the roles are forgotten at once)', await rolesNow());
  return {transferDeal: t1.deal.id};
}

// ---------- probes: approvals held for the owner, and decision D-1 across both sides ----------
// The payer's owner reviews deliveries (console approvals): a payment by transfer waits as a pay_by_transfer approval.
// The owner rejects it; then an own note must wait for the attempt's window (server and client both refuse:
// transfer_window_open), while a same-issuer retry on the same prior state need not (the same-prior exemption of tracker
// v3.2: the server gives its template, the client signs it); the retry is held and rejected too, and the deal is
// disputed. A second deal paid with the same note is held, approved and paid by it; the client's records judge it.
async function ownerDecide(stack, owner, dealId, kind, decision) {
  const end = Date.now() + 30000;
  for (;;) {
    const o = await http(stack.base, 'GET', '/owner', {token: owner});
    const a = (o.body?.approvals || []).find(x => x.deal_id === dealId && x.state === 'pending' && (!kind || x.kind === kind));
    if (a) return {approval: a, answer: await http(stack.base, 'POST', `/owner/approvals/${a.id}`, {token: owner, body: {decision}})};
    if (Date.now() > end) return {approval: null, answer: null, owner: o.body?.approvals?.map(x => pick(x, ['id', 'kind', 'state', 'deal_id']))};
    await sleep(500);
  }
}
async function probes(ctx, stack) {
  say('probes: a payment held for the owner, rejected, refused for its window; another held and approved (profile s3)');
  const owner = ctx.owner;
  // The welcome job from sandbox-exact: accept it, deliver the exact result, get paid (X>S3 3).
  let welcome = null;
  for (let i = 0; i < 60 && !welcome; i++) {
    welcome = ((await tool(ctx, 'valun_inbox')).json?.respond || []).find(x => x.counterparty === HANDLES.X && x.your_role === 'payee');
    if (!welcome) await sleep(1000);
  }
  must(welcome, 'the welcome job from sandbox-exact arrives in the inbox');
  const acc = await tool(ctx, 'valun_respond', {deal_id: welcome.deal_id, action: 'accept'});
  must(acc.code === 0 && acc.json?.status === 'agreed', 'valun_respond accept the welcome job', acc.json ?? acc.out);
  const dl = await tool(ctx, 'valun_deliver', {deal_id: welcome.deal_id, exact_result: true});
  must(dl.code === 0 && dl.json?.status === 'delivered', 'valun_deliver exact_result for the welcome job', dl.json ?? dl.out);
  must((await dealUntil(ctx, welcome.deal_id, ['note_issued', 'disputed']))?.status === 'note_issued', 'sandbox-exact pays the welcome job');
  const total = (notes, i, r) => notes.find(n => n.issuer_handle === i && n.recipient_handle === r)?.total ?? 0;
  const notes0 = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  check(total(notes0, HANDLES.X, ctx.handle) === 3, 'probe profile: X>S3 3 after the welcome job', notes0.map(n => `${n.issuer_handle}>${n.recipient_handle} ${n.total}`));
  const xm0 = total(notes0, HANDLES.X, HANDLES.M);
  // Console approvals: every commitment waits for the owner (approve_above 0), and so does every accepted delivery.
  const cfg = await valun(ctx, ['--profile', ctx.profile, 'config', 'approvals', 'console', '--owner-token-file', ctx.ownerFile]);
  must(cfg.code === 0, 'valun config approvals console (owner token from a file)', cfg.out + cfg.err);
  const m = (await http(stack.base, 'GET', '/owner', {token: owner})).body?.mandate || {};
  check(m.approve_above === 0 && m.review_deliveries === true, 'console approvals: the owner mandate has approve_above 0 and review_deliveries on', pick(m, ['approve_above', 'review_deliveries']));
  // Buy notary from sandbox-mallory (each offer approved by the owner); dispute a wrong delivery and buy again.
  let d = null;
  for (let attempt = 1; attempt <= 12 && !d; attempt++) {
    const p = await tool(ctx, 'valun_propose', {counterparty: HANDLES.M, role: 'payer', ...job('notary', `INT-1 probe: held for the owner (try ${attempt})`), price: 2});
    must(p.code === 0 && p.json?.status === 'proposed_awaiting_owner', 'console approvals: valun_propose waits for the owner (proposed_awaiting_owner)', p.json ?? p.out);
    const ok = await ownerDecide(stack, owner, p.json.deal_id, 'propose', 'approve');
    must(ok.answer?.status === 200, 'the owner approves the offer (POST /owner/approvals/:id)', ok.answer?.body ?? ok.owner);
    const v = await dealUntil(ctx, p.json.deal_id, ['delivered', 'declined', 'expired', 'withdrawn']);
    must(v?.status === 'delivered', 'sandbox-mallory accepts and delivers', v?.status);
    if (v.delivery?.checked_exactly_by_your_client?.exact_result_matches) { d = v; break; }
    const r = await tool(ctx, 'valun_review_delivery', {deal_id: v.id, decision: 'dispute', reason: 'the result differs from the exact one'});
    must(r.code === 0 && r.json?.status === 'disputed', 'a wrong delivery is disputed (no owner approval needed)', r.json ?? r.out);
  }
  must(d, 'sandbox-mallory delivered a right result');
  // Pay with sandbox-exact's note: the payment waits for the owner (completion_awaiting_owner, approval pay_by_transfer).
  const p1 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: HANDLES.X, expected_deliverable_sha256: d.delivery.sha256});
  must(p1.code === 0 && p1.json?.status === 'completion_awaiting_owner', 'pay_with with review_deliveries: completion_awaiting_owner', p1.json ?? p1.out);
  check(p1.json.payment?.state === 'awaiting_owner' && /^vt_[0-9a-f]{16}$/.test(p1.json.payment?.transfer_id ?? ''), 'the held payment shows its transfer awaiting the owner', p1.json.payment);
  const l1 = await valun(ctx, ['--profile', ctx.profile, 'attempts', 'list']);
  check(l1.code === 0 && new RegExp(`paying with the note of .*server id ${p1.json.payment?.transfer_id}: can still apply`).test(l1.out),
    'valun attempts list: the held transfer (with its server id) can still apply', l1.out);
  // The owner rejects it: the transfer is voided and the deal is delivered again.
  const rej = await ownerDecide(stack, owner, d.id, 'pay_by_transfer', 'reject');
  must(rej.answer?.status === 200, 'the owner rejects the pay_by_transfer approval', rej.answer?.body ?? rej.owner);
  const after = (await tool(ctx, 'valun_deal', {deal_id: d.id})).json || {};
  check(after.status === 'delivered', 'after the rejection the deal is delivered again', after.status);
  const own = (after.how_you_can_pay?.options || []).find(o => o.pay_with === 'own_note'), held = (after.how_you_can_pay?.options || []).find(o => o.pay_with === HANDLES.X);
  check(own && own.available === false && own.why_not === 'transfer_window_open', 'how_you_can_pay: own_note waits for the window (server: transfer_window_open)', own);
  check(held && held.available === true && held.why_not === null, 'how_you_can_pay: the same issuer on the same prior state does not wait (the same-prior exemption)', held);
  const fa = Date.parse(after.how_you_can_pay?.fallback_after ?? '');
  check(Number.isFinite(fa) && fa > Date.now() + 55 * 60e3 && fa < Date.now() + 62 * 60e3, 'how_you_can_pay fallback_after is about T + 1 h + 60 s', after.how_you_can_pay?.fallback_after);
  // An own note now: the client refuses it before signing (transfer_window_open), as the server would.
  const o1 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d.delivery.sha256});
  check(o1.code === 1 && o1.json?.error === 'transfer_window_open', 'an own note within the window is refused: transfer_window_open', o1.json ?? o1.out);
  // The same issuer again on the same prior state, at a new T: the server gives its template at once (tracker v3.2's
  // PA(A,B,X,p,T) lets at most one of the two apply), the client signs it, and it is held for the owner again.
  const tq = await pyLib(ctx, `
import json
from valun import client as vc
from valun.home import profile_path
c = vc.Client(vc.FileStore(profile_path('${ctx.profile}')))
try:
    t = c.transfer_template('${d.id}', c._resolve_issuer('${d.id}', '${HANDLES.X}'))
    print(json.dumps({'template': True, 'prior_timestamp': t['from_edge'].get('prior_timestamp'), 'before': t['from_edge']['before']}))
except vc.ValunError as e:
    print(json.dumps({'error': e.code, 'http': e.status, 'retry_after_ms': (e.extra or {}).get('retry_after_ms')}))`);
  const tqj = jsonOf(tq.out.trim().split(/\r?\n/).pop() ?? '');
  check(tqj?.template === true && tqj.prior_timestamp === tqj.before?.timestamp, 'the server gives the same-issuer template at once (it names the prior state\'s timestamp)', tqj ?? tq.out + tq.err);
  const sr = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: HANDLES.X, expected_deliverable_sha256: d.delivery.sha256});
  check(sr.code === 0 && sr.json?.status === 'completion_awaiting_owner' && sr.json.payment?.transfer_id && sr.json.payment.transfer_id !== p1.json.payment?.transfer_id,
    'a same-issuer retry on the same prior state within the window is signed and held for the owner (a new transfer)', sr.json ?? sr.out);
  const rej2 = await ownerDecide(stack, owner, d.id, 'pay_by_transfer', 'reject');
  must(rej2.answer?.status === 200, 'the owner rejects the retry too', rej2.answer?.body ?? rej2.owner);
  // The rejected deal is disputed (its acceptance never stood), and a second purchase is paid with the same note: held
  // for the owner, approved, applied.
  const dd = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'dispute', reason: 'E2E: not paid within the window of the rejected payment'});
  must(dd.code === 0 && dd.json?.status === 'disputed', 'the rejected deal is disputed instead', dd.json ?? dd.out);
  const d2 = await heldBuy(ctx, stack, HANDLES.M, 'notary', 2, 'INT-1 probe: held, approved and paid by transfer');
  const p2 = await tool(ctx, 'valun_review_delivery', {deal_id: d2.id, decision: 'accept', pay_with: HANDLES.X, expected_deliverable_sha256: d2.delivery.sha256});
  must(p2.code === 0 && p2.json?.status === 'completion_awaiting_owner', 'pay_with on the second deal is held for the owner', p2.json ?? p2.out);
  check(p2.json.payment?.transfer_id && p2.json.payment.transfer_id !== p1.json.payment?.transfer_id, 'it is a new transfer', [p1.json.payment, p2.json.payment]);
  const ap = await ownerDecide(stack, owner, d2.id, 'pay_by_transfer', 'approve');
  must(ap.answer?.status === 200, 'the owner approves the second payment', ap.answer?.body ?? ap.owner);
  const paid = await dealUntil(ctx, d2.id, ['paid_by_transfer', 'payment_due'], 30000);
  check(paid?.status === 'paid_by_transfer', 'the approved payment pays the second deal by transfer', paid?.status);
  const notes1 = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  check(total(notes1, HANDLES.X, ctx.handle) === 1 && total(notes1, HANDLES.X, HANDLES.M) === xm0 + 2, 'after the probe: X>S3 1 and X>M + 2',
    {x_s3: total(notes1, HANDLES.X, ctx.handle), x_m_before: xm0, x_m: total(notes1, HANDLES.X, HANDLES.M)});
  const l2 = await valun(ctx, ['--profile', ctx.profile, 'attempts', 'list']);
  const lines = l2.out.split(/\r?\n/), at = lines.findIndex(l => l.startsWith(`deal ${d2.id}`));
  const rows = at >= 0 ? lines.slice(at + 1).filter((l, i, all) => all.slice(0, i + 1).every(x => /^\s+#\d+ /.test(x))) : [];
  check(at >= 0 && /recorded as paid$/.test(lines[at]), 'valun attempts list: the second probe deal is recorded as paid', l2.out);
  check(rows.length === 1 && rows[0].includes(p2.json.payment?.transfer_id) && /applied: the deal is paid by it$/.test(rows[0]),
    'valun attempts list: the approved payment applied (the deal is paid by it)', rows);
  const block = at >= 0 ? lines.slice(at, at + 1 + rows.length).join('\n') : '';
  check(at >= 0 && !/MAY HAVE APPLIED|valun (--profile \S+ )?attempts resolve/.test(block), 'valun attempts list: nothing to resolve for the paid probe deal', block);
  // The rejected deal's attempt is never taken as its payment. The client cannot prove it dead from its own records:
  // the second deal moved the same claim 3 -> 1, the total the rejected attempt would have left (D-2 a: a raise of an
  // incoming edge needs no signature of the client); the list may then advise a resolution (printed once, for any
  // unpaid deal), which the owner makes against the client's records, the server having ended the attempt.
  const atR = lines.findIndex(l => l.startsWith(`deal ${d.id}`));
  const rowsR = atR >= 0 ? lines.slice(atR + 1).filter((l, i, all) => all.slice(0, i + 1).every(x => /^\s+#\d+ /.test(x))) : [];
  check(atR >= 0 && !/recorded as paid/.test(lines[atR]) && rowsR.length === 2 && rowsR[0].includes(p1.json.payment?.transfer_id) && rowsR[1].includes(sr.json.payment?.transfer_id)
      && !rowsR.some(r => /applied: the deal is paid by it$/.test(r)),
    'valun attempts list: the rejected deal is not recorded as paid, and neither of its two attempts is taken as its payment', rowsR.length ? rowsR : l2.out);
  // The owner's resolution plan (decision D-2 d) reads GET /transfers/{vt} with the agent token and matches the record:
  // both transfers ended at the server (void_rejected, applied), so neither is resolved there.
  const plan = await pyLib(ctx, `
import json
from valun import client as vc
from valun.home import profile_path
c = vc.Client(vc.FileStore(profile_path('${ctx.profile}')))
out = {}
for k, deal in (('rejected', '${d.id}'), ('paid', '${d2.id}')):
    p = c.resolution_plan(deal, '#1')
    out[k] = {'attempt_id': p['attempt_id'], 'local': p['local'], 'server': p['server'], 'transfer': p['transfer']}
print(json.dumps(out))`);
  const pj = jsonOf(plan.out.trim().split(/\r?\n/).pop() ?? '');
  const [r1, r2] = [pj?.rejected, pj?.paid];
  check(r1?.attempt_id === p1.json.payment.transfer_id && r1?.local === 'server_ended' && r1?.server === false && r1?.transfer?.state === 'void_rejected'
      && r1?.transfer?.total === 1 && r2?.attempt_id === p2.json.payment.transfer_id && r2?.local === 'server_ended' && r2?.transfer?.state === 'applied',
    'Client.resolution_plan: GET /transfers/{vt} matches both records (void_rejected and applied: ended at the server)', pj ?? plan.out + plan.err);

  // Paid BY transfer: S3 sells notary to sandbox-mallory, which holds sandbox-exact's notes and pays with them; S3's
  // client is the new creditor and signs its two slots (A>C:prior, A>C:new) as payee through /consents.
  const xs1 = total(notes1, HANDLES.X, ctx.handle), xm1 = total(notes1, HANDLES.X, HANDLES.M);
  const sale = await tool(ctx, 'valun_propose', {counterparty: HANDLES.M, role: 'payee', ...job('notary', 'INT-1 probe: paid to me by transfer.'), price: 2});
  must(sale.code === 0 && sale.json?.status === 'proposed_awaiting_owner', 'console approvals: the sell offer waits for the owner', sale.json ?? sale.out);
  must((await ownerDecide(stack, owner, sale.json.deal_id, 'propose', 'approve')).answer?.status === 200, 'the owner approves the sell offer');
  must((await dealUntil(ctx, sale.json.deal_id, ['agreed', 'declined', 'expired']))?.status === 'agreed', 'sandbox-mallory accepts the sell offer');
  const sd = await tool(ctx, 'valun_deliver', {deal_id: sale.json.deal_id, exact_result: true});
  must(sd.code === 0 && sd.json?.status === 'delivered', 'valun_deliver exact_result for the sale', sd.json ?? sd.out);
  const paying = await dealUntil(ctx, sale.json.deal_id, ['paying_by_transfer', 'paid_by_transfer', 'note_issued', 'disputed']);
  check(paying?.status === 'paying_by_transfer' && paying.payment?.issuer?.handle === HANDLES.X && paying.payment?.state === 'collecting',
    'sandbox-mallory pays with sandbox-exact\'s note: the transfer collects the payee\'s signatures', pick(paying, ['status', 'payment', 'whose_turn']));
  if (paying?.status === 'paying_by_transfer') {
    // `valun call valun_status` signs a payee consent itself when the profile's last value-safe run is a minute old
    // (decision D-3 a, consents on reads); otherwise it waits for `valun clearing run`. Either path is right.
    const sst = (await tool(ctx, 'valun_status')).json || {};
    const signedNow = (sst.consents_signed_now || []).filter(e => e.kind === 'transfer' && e.role === 'payee');
    if (signedNow.length) {
      check(true, 'valun_status (D-3 a) signed the payee consent itself: consents_signed_now lists the transfer as payee');
      const run = await valun(ctx, ['--profile', ctx.profile, 'clearing', 'run']);
      check(run.code === 0 && /Nothing waits for your client/.test(run.out), 'valun clearing run: nothing waits any more', run.out + run.err);
    } else {
      check(sst.clearing?.consents_pending >= 1 && (sst.payments_in_progress || []).some(x => x.deal_id === sale.json.deal_id),
        'valun_status: a consent waits for the client and the payment is in progress', pick(sst, ['payments_in_progress', 'clearing', 'consents_signed_now']));
      const run = await valun(ctx, ['--profile', ctx.profile, 'clearing', 'run']);
      check(run.code === 0 && /signed\s+transfer vt_[0-9a-f]{16} as payee/.test(run.out), 'valun clearing run signs the transfer as payee', run.out + run.err);
    }
    const done = await dealUntil(ctx, sale.json.deal_id, ['paid_by_transfer', 'payment_due'], 30000);
    check(done?.status === 'paid_by_transfer', 'the payee\'s consent completes the transfer: paid_by_transfer', done?.status);
    const notes2 = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
    check(total(notes2, HANDLES.X, ctx.handle) === xs1 + 2 && total(notes2, HANDLES.X, HANDLES.M) === xm1 - 2, 'X>S3 + 2 and X>M - 2',
      {x_s3: [xs1, total(notes2, HANDLES.X, ctx.handle)], x_m: [xm1, total(notes2, HANDLES.X, HANDLES.M)]});
  }
  // Decision D-2 d: POST /owner/deals/:vd/attempts/:vt/resolve resolves only an attempt whose outcome is unknown. On
  // attempts that ended (applied, void_rejected) it refuses; an unknown attempt id is 404; the payee's owner is refused.
  const resolve = (deal, vt, body) => http(stack.base, 'POST', `/owner/deals/${deal}/attempts/${vt}/resolve`, {token: owner, body});
  const w1 = await resolve(d2.id, p2.json.payment.transfer_id, {outcome: 'not_applied', note: 'E2E-1: applied, so not resolvable'});
  check(w1.status === 409 && w1.body?.error === 'wrong_state', 'D-2 d resolve route: an applied attempt is refused (409 wrong_state)', [w1.status, w1.body]);
  const w2 = await resolve(d.id, p1.json.payment.transfer_id, {outcome: 'applied'});
  check(w2.status === 409 && w2.body?.error === 'wrong_state', 'D-2 d resolve route: the owner-rejected attempt is refused (409 wrong_state)', [w2.status, w2.body]);
  const w3 = await resolve(d2.id, 'vt_0123456789abcdef', {outcome: 'not_applied'});
  check(w3.status === 404, 'D-2 d resolve route: an attempt the deal does not have is 404', [w3.status, w3.body]);
  const saleTransfer = paying?.payment?.transfer_id;
  if (saleTransfer) {
    const w4 = await resolve(sale.json.deal_id, saleTransfer, {outcome: 'not_applied'});
    check(w4.status === 403 && w4.body?.error === 'not_payer', "D-2 d resolve route: the payee's owner may not resolve (403 not_payer)", [w4.status, w4.body]);
  }
  const after2 = (await tool(ctx, 'valun_deal', {deal_id: d2.id})).json || {};
  check(after2.status === 'paid_by_transfer', 'the refused resolutions changed nothing: the probe deal is still paid_by_transfer', after2.status);
}

// ---------- mode on: three invited participants, each a real 0.4 client ----------
// A buys from B and pays with its own note (A>B 3). B buys from C and pays with A's note (pay_with=A): the transfer needs
// A's client as issuer (A>B:new, A>C:new) and C's client as payee (A>C:prior, A>C:new), both through /consents. C's
// owner first allows payments by transfer from A (accept_transfers, accept_notes_from), and C's client its creditor role.
async function invited(people, stack) {
  say('invited participants (mode on): a payment with a third party\'s note, signed by the issuer\'s and the payee\'s clients');
  const {a: A, b: B, c: C} = people;
  const pol = await valun(C, ['--profile', C.profile, 'policy', 'show']);
  check(pol.code === 0 && /payments to you by transfer: not signed \(local off, owner accept_transfers off\)/.test(pol.out),
    'an invited client signs no payments to it by transfer until its owner and its policy allow them', pol.out);
  const total = (notes, i, r) => notes.find(n => n.issuer_handle === i && n.recipient_handle === r)?.total ?? 0;
  // A deal between two clients, driven through valun call on both sides: `buyer` buys text-stats from `seller`.
  async function trade(buyer, seller, price, text, payWith) {
    const p = await tool(buyer, 'valun_propose', {counterparty: seller.handle, role: 'payer', ...job('text-stats', text), price});
    must(p.code === 0 && p.json?.status === 'open', `${buyer.profile} offers ${seller.profile} a text-stats job`, p.json ?? p.out);
    const r = await tool(seller, 'valun_respond', {deal_id: p.json.deal_id, action: 'accept'});
    must(r.code === 0 && r.json?.status === 'agreed', `${seller.profile} accepts`, r.json ?? r.out);
    const d = await tool(seller, 'valun_deliver', {deal_id: p.json.deal_id, exact_result: true});
    must(d.code === 0 && d.json?.status === 'delivered', `${seller.profile} delivers the exact result`, d.json ?? d.out);
    const v = (await tool(buyer, 'valun_deal', {deal_id: p.json.deal_id})).json || {};
    must(v.delivery?.checked_exactly_by_your_client?.exact_result_matches === true, `${buyer.profile}'s client checks the delivery exactly`, v.delivery?.checked_exactly_by_your_client);
    const a = await tool(buyer, 'valun_review_delivery', {deal_id: p.json.deal_id, decision: 'accept', pay_with: payWith, expected_deliverable_sha256: v.delivery.sha256});
    return {deal: p.json.deal_id, view: v, answer: a};
  }
  const t1 = await trade(A, B, 3, 'INT-1 invited: A pays B with its own note.', 'own_note');
  must(t1.answer.code === 0 && t1.answer.json?.status === 'note_issued', 'A pays B with its own (bound) note', t1.answer.json ?? t1.answer.out);
  // C's owner allows payments by transfer of A's notes; C's client turns on its creditor role.
  const mset = await http(stack.base, 'PUT', '/owner/mandate', {token: C.owner, body: {accept_transfers: true, accept_notes_from: [A.id]}});
  must(mset.status === 200, "C's owner: accept_transfers on, accept_notes_from [A]", mset.body ?? mset.text);
  const cfg = await valun(C, ['--profile', C.profile, 'config', 'consents.as_new_creditor', 'on']);
  must(cfg.code === 0, "C's client: consents.as_new_creditor on", cfg.out + cfg.err);
  must((await tool(C, 'valun_status')).code === 0, "C's client declares its roles on its next request (X-Valun-Features)");
  const t2 = await trade(B, C, 2, 'INT-1 invited: B pays C with a note of A.', A.handle);
  check(t2.answer.code === 0 && t2.answer.json?.status === 'paying_by_transfer', 'B pays C with A\'s note: the transfer waits for A and C', t2.answer.json ?? t2.answer.out);
  const how = (t2.view.how_you_can_pay?.options || []).find(o => o.pay_with === A.handle);
  check(how?.available === true && how?.issuer_consents === 'auto' && how?.payee_consents === 'auto', 'how_you_can_pay listed A\'s note: available, both consent automatically', how);
  // B cancels that transfer before A and C sign (POST /deals/:vd/cancel-transfer, Client.cancel_transfer): the deal is
  // payment_due. Its signatures exist until T + 1 h, so an own note must wait (D-1); the same note on the same prior
  // state at a new T need not (the same-prior exemption of tracker v3.2): B pays the deal again with A's note at once,
  // and A's and C's clients sign that transfer.
  const first = t2.answer.json?.payment?.transfer_id;
  const cancel = await pyLib(B, `
import json
from valun import client as vc
from valun.home import profile_path
r = vc.Client(vc.FileStore(profile_path('${B.profile}'))).cancel_transfer('${t2.deal}')
print(json.dumps({'status': r.get('status'), 'transfer': {k: (r.get('transfer') or {}).get(k) for k in ('id', 'state')}}))`);
  const cj = jsonOf(cancel.out.trim().split(/\r?\n/).pop() ?? '');
  check(cj?.status === 'payment_due' && cj?.transfer?.id === first && cj?.transfer?.state === 'cancelled', 'Client.cancel_transfer: the deal is payment_due, the transfer cancelled', cj ?? cancel.out + cancel.err);
  const due = (await tool(B, 'valun_deal', {deal_id: t2.deal})).json || {};
  const dueOwn = (due.how_you_can_pay?.options || []).find(o => o.pay_with === 'own_note'), dueHeld = (due.how_you_can_pay?.options || []).find(o => o.pay_with === A.handle);
  check(due.status === 'payment_due' && /^yours: you accepted the delivery but it is not paid yet/.test(due.whose_turn ?? '') && dueOwn?.why_not === 'transfer_window_open'
      && dueHeld?.available === true && dueHeld?.why_not === null,
    'payment_due: whose_turn; own_note waits for the window (transfer_window_open), the same note on the same prior state does not', {status: due.status, whose_turn: due.whose_turn, own: dueOwn, held: dueHeld});
  const ownDue = await tool(B, 'valun_review_delivery', {deal_id: t2.deal, decision: 'accept', pay_with: 'own_note'});
  check(ownDue.code === 1 && ownDue.json?.error === 'transfer_window_open', 'payment_due: an own note within the window is refused (transfer_window_open)', ownDue.json ?? ownDue.out);
  const again = await tool(B, 'valun_review_delivery', {deal_id: t2.deal, decision: 'accept', pay_with: A.handle});
  check(again.code === 0 && again.json?.status === 'paying_by_transfer' && again.json?.payment?.transfer_id && again.json.payment.transfer_id !== first,
    'payment_due: paying again with the same note on the same prior state within the window: a new transfer that waits for A and C', again.json ?? again.out);
  const t2b = {deal: t2.deal};
  const ra = await valun(A, ['--profile', A.profile, 'clearing', 'run']);
  check(ra.code === 0 && /signed\s+transfer vt_[0-9a-f]{16} as issuer, 2 PC \(your net change 0 PC\)/.test(ra.out), "A's client signs the transfer of its own debt as issuer", ra.out + ra.err);
  const rc = await valun(C, ['--profile', C.profile, 'clearing', 'run']);
  check(rc.code === 0 && /signed\s+transfer vt_[0-9a-f]{16} as payee/.test(rc.out), "C's client signs as payee", rc.out + rc.err);
  const done = await dealUntil(B, t2b.deal, ['paid_by_transfer', 'payment_due'], 30000);
  check(done?.status === 'paid_by_transfer', 'the transfer applies once A and C signed: paid_by_transfer', done?.status);
  const notes = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  check(total(notes, A.handle, B.handle) === 1 && total(notes, A.handle, C.handle) === 2 && total(notes, B.handle, C.handle) === 0,
    'A>B 3 -> 1, A>C 0 -> 2, and B issued no note to C', notes.filter(n => [A, B, C].some(x => x.handle === n.issuer_handle)).map(n => `${n.issuer_handle}>${n.recipient_handle} ${n.total}`));
  const sa = (await tool(A, 'valun_status')).json?.money_view || {};
  check(sa.you_owe_PC === 3 && sa.you_hold_PC === 0, "A's total debt did not change (owes 3)", sa);
  const lb = await valun(B, ['--profile', B.profile, 'attempts', 'list']);
  check(lb.code === 0 && new RegExp(`deal ${t2b.deal}: recorded as paid`).test(lb.out) && /paying with the note of .*: applied: the deal is paid by it/.test(lb.out),
    "B's attempts list: the transfer applied and the deal is recorded as paid", lb.out);
  check(!new RegExp(`server id ${first}: applied`).test(lb.out), "B's attempts list: the cancelled transfer is not counted as the payment", lb.out);

  // 409 novation_pending, then a refused consent. A buys from B again (A>B is 1); before A accepts the delivery, B pays
  // C again with A's note, a transfer that holds A>B until A's client signs as issuer. A's own note on A>B (a library
  // call: no consent run of the agent layer first) is refused with 409 novation_pending naming that consent. A's client
  // then refuses the consent (its owner turned the issuer role off): POST /consents/:id/refuse ends the transfer, B's
  // deal is payment_due, and A's note goes through.
  const p3 = await tool(A, 'valun_propose', {counterparty: B.handle, role: 'payer', ...job('text-stats', 'E2E-1 invited: A pays B again with its own note.'), price: 1});
  must(p3.code === 0 && p3.json?.status === 'open', 'A offers B another text-stats job', p3.json ?? p3.out);
  must((await tool(B, 'valun_respond', {deal_id: p3.json.deal_id, action: 'accept'})).json?.status === 'agreed', 'B accepts');
  must((await tool(B, 'valun_deliver', {deal_id: p3.json.deal_id, exact_result: true})).json?.status === 'delivered', 'B delivers the exact result');
  const v3 = (await tool(A, 'valun_deal', {deal_id: p3.json.deal_id})).json || {};
  must(v3.delivery?.checked_exactly_by_your_client?.exact_result_matches === true, "A's client checks the delivery exactly", v3.delivery?.checked_exactly_by_your_client);
  const t4 = await trade(B, C, 1, 'E2E-1 invited: B pays C with a note of A again.', A.handle);
  const vt4 = t4.answer.json?.payment?.transfer_id;
  must(t4.answer.code === 0 && t4.answer.json?.status === 'paying_by_transfer' && /^vt_/.test(vt4 ?? ''), "B pays C with A's note again: the transfer waits for A and C", t4.answer.json ?? t4.answer.out);
  const np = await pyLib(A, `
import json
from valun import client as vc
from valun.home import profile_path
c = vc.Client(vc.FileStore(profile_path('${A.profile}')))
try:
    r = c.complete('${p3.json.deal_id}', expected_deliverable_sha256='${v3.delivery.sha256}')
    print(json.dumps({'status': r.get('status')}))
except vc.ValunError as e:
    x = e.extra if isinstance(e.extra, dict) else {}
    print(json.dumps({'error': e.code, 'http': e.status, 'consent_ids': x.get('consent_ids')}))`);
  const nj = jsonOf(np.out.trim().split(/\r?\n/).pop() ?? '');
  check(nj?.error === 'novation_pending' && nj.http === 409 && (nj.consent_ids || []).includes(vt4),
    '409 novation_pending: a credit note of A on the edge a transfer holds waits for A\'s consent (consent_ids names it)', nj ?? np.out + np.err);
  must((await valun(A, ['--profile', A.profile, 'config', 'consents.as_issuer', 'off'])).code === 0, "A's client: consents.as_issuer off");
  const rr = await valun(A, ['--profile', A.profile, 'clearing', 'run']);
  check(rr.code === 0 && new RegExp(`refused\\s+transfer ${vt4} as issuer`).test(rr.out), "A's client refuses the consent (POST /consents/:id/refuse)", rr.out + rr.err);
  const due4 = (await tool(B, 'valun_deal', {deal_id: t4.deal})).json || {};
  check(due4.status === 'payment_due', "the refused transfer ended: B's deal is payment_due", pick(due4, ['status', 'payment', 'whose_turn']));
  const a3 = await tool(A, 'valun_review_delivery', {deal_id: p3.json.deal_id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: v3.delivery.sha256});
  check(a3.code === 0 && a3.json?.status === 'note_issued', 'with the consent dealt with, A pays B with its own note (novation_pending retried)', a3.json ?? a3.out);
  const notes4 = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  check(total(notes4, A.handle, B.handle) === 2 && total(notes4, A.handle, C.handle) === 2 && total(notes4, B.handle, C.handle) === 0,
    'A>B 1 -> 2 (the new note), A>C still 2 (the refused transfer moved nothing)', notes4.filter(n => [A, B, C].some(x => x.handle === n.issuer_handle)).map(n => `${n.issuer_handle}>${n.recipient_handle} ${n.total}`));
}

// ---------- MCP over stdio with the official SDK: the whole tour ----------
async function mcpSession(ctx, stack, exact = false) {
  const {profile, handle} = ctx;
  const out = path.join(ctx.tmp, `mcp-${stack.mode}.json`), log = path.join(ctx.tmp, `mcp-${stack.mode}.log`);
  const total = (notes, i, r) => notes.find(n => n.issuer_handle === i && n.recipient_handle === r)?.total ?? 0;
  say(`MCP session over stdio (official SDK): the whole tour, profile ${profile}`);
  const r = await runChild(PYTHON, ['-I', MCP_DRIVER, '--profile', profile, '--python', PYTHON, '--src', PY_SRC, '--out', out, '--timeout', '900',
    '--base', stack.base, '--handle', handle, ...(exact ? ['--exact-all'] : [])],
  {env: pyEnv(ctx), cwd: ctx.tmp, timeoutMs: 1000000, onOut: d => fs.appendFileSync(log, d), onErr: d => fs.appendFileSync(log, d)});
  if (r.code === -1) fs.appendFileSync(log, r.err);
  const res = jsonOf(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'null');
  ratePauses += res?.rate_limited_pauses || 0;
  for (const f of res?.failures || []) check(false, `MCP: ${f.what}`, f.detail);
  check(r.code === 0 && res?.ok === true, 'the MCP session passes its checks (the whole tour, totals after every step)', res ? `exit ${r.code}; see ${log}` : `no result; see ${log}`);
  check(JSON.stringify(Object.keys(res?.steps || {}).map(Number).sort()) === '[1,2,3,4,5]', 'the MCP session checked the totals after each of the five steps', Object.keys(res?.steps || {}));
  check((res?.elicitations || []).length >= 4, 'the MCP session answered the approval elicitations (accept, offers, pay_with, own note)', res?.elicitations?.length);
  check((res?.loop_signed || []).length >= 1, "a tour set-off was signed by valun mcp's background consent loop", res?.loop_signed);
  const ledger = (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  check([[HANDLES.X, handle], [HANDLES.M, handle], [handle, HANDLES.X], [handle, HANDLES.M]].every(([i, x]) => total(ledger, i, x) === 0),
    'after the MCP tour every edge of the profile is 0 on the tracker', ledger.filter(n => [n.issuer_handle, n.recipient_handle].includes(handle)).map(n => `${n.issuer_handle}>${n.recipient_handle} ${n.total}`));
}

// ---------- the JavaScript client ----------
async function jsPart(stack, tmp) {
  say('JavaScript client @fitzdoud/valun 0.4.0 (VALUN_OPEN/js/src): scripts/e2e-js-smoke.mjs');
  const dir = path.join(tmp, 'js'), out = path.join(dir, 'result.json'), log = path.join(tmp, 'js.log');
  fs.mkdirSync(dir, {recursive: true});
  const r = await runChild(process.execPath, [path.join(root, 'scripts', 'e2e-js-smoke.mjs'), '--base', stack.base, '--tmp', dir, '--out', out, '--open', VALUN_OPEN],
    {cwd: dir, timeoutMs: 900000, onOut: d => fs.appendFileSync(log, d), onErr: d => fs.appendFileSync(log, d)});
  if (r.code === -1) fs.appendFileSync(log, r.err);
  const res = jsonOf(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'null');
  for (const f of res?.failures || []) check(false, `JS: ${f.what}`, f.detail);
  check(r.code === 0 && res?.ok === true, 'the JS smoke run passes its checks', res ? `exit ${r.code}; see ${log}` : `no result; see ${log}`);
  check(res?.version === '0.4.0' && res?.paid_status === 'paid_by_transfer', 'the JS smoke run (0.4.0) ends with its pay_with deal paid_by_transfer', pick(res, ['version', 'paid_deal', 'paid_status']));
}

// ---------- the Hermes plugin through Hermes's real dispatch path ----------
async function hermesPart(stack, tmp) {
  const home = HERMES_HOME_DIR, existed = fs.existsSync(home);
  say(`Hermes plugin through model_tools.handle_function_call (HERMES_HOME ${home}, plugin ${PLUGIN_DIR})`);
  if (existed && fs.readdirSync(home).length) { check(false, `the Hermes home ${home} is empty before the run`, fs.readdirSync(home).slice(0, 5)); return; }
  const dir = path.join(tmp, 'hermes'), out = path.join(dir, 'result.json'), log = path.join(tmp, 'hermes.log');
  fs.mkdirSync(dir, {recursive: true});
  const dead = 'http://127.0.0.1:9';
  const env = {...process.env, UV_OFFLINE: '1', PIP_NO_INDEX: '1', HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead,
    all_proxy: dead, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', PYTHONIOENCODING: 'utf-8'};
  for (const k of ['PYTHONPATH', 'HERMES_HOME', 'VALUN_HOME', 'VALUN_SERVER', 'VALUN_PROFILE']) delete env[k];
  try {
    const r = await runChild(HERMES_PYTHON, ['-B', path.join(root, 'scripts', 'e2e-hermes-dispatch.py'), '--home', home, '--plugin', PLUGIN_DIR, '--base', stack.base,
      '--out', out, '--owner-file', path.join(dir, 'owner-token.txt')], {env, cwd: dir, timeoutMs: 1200000, onOut: d => fs.appendFileSync(log, d), onErr: d => fs.appendFileSync(log, d)});
    if (r.code === -1) fs.appendFileSync(log, r.err);
    const res = jsonOf(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'null');
    for (const f of res?.failures || []) check(false, `Hermes: ${f.what}`, f.detail);
    check(r.code === 0 && res?.ok === true, 'the Hermes dispatch run passes its checks', res ? `exit ${r.code}; see ${log}` : `no result; see ${log}`);
    const answers = (res?.approvals || []).map(a => a.answer);
    check(answers.includes('once') && answers.includes('deny'), "Hermes's approval gate asked the owner: approved and declined commitments", res?.approvals?.map(a => [a.answer, a.first_line]));
  } finally {
    // The home holds the run's throwaway agent key and token: emptied again (removed if this run created it).
    for (const e of fs.existsSync(home) ? fs.readdirSync(home) : []) fs.rmSync(path.join(home, e), {recursive: true, force: true, maxRetries: 10, retryDelay: 300});
    if (!existed) fs.rmSync(home, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    check(!fs.existsSync(home) || fs.readdirSync(home).length === 0, `the Hermes home ${home} is empty again`);
  }
}

// ---------- run faults: clock jumps (D-1, note_timestamp_ahead, D-2 b) and a lost tracker answer (pair_busy) ----------
const CLOCK_BACK_MS = -59 * 60e3;
// The client's clock follows E2E_PY_CLOCK_FILE (time.time and datetime.now), like the server's (scripts/e2e-clock.mjs).
const PY_CLOCK = `import datetime as _dt, os, time as _t
_f = os.environ.get('E2E_PY_CLOCK_FILE')
if _f:
    _real = _t.time
    def _now():
        try:
            with open(_f, encoding='ascii') as h:
                off = int(h.read().strip() or 0)
        except Exception:
            off = 0
        return _real() + off / 1000.0
    _t.time = _now
    class _DT(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return _dt.datetime.fromtimestamp(_now(), tz)
    _dt.datetime = _DT
`;
// Buys `service` from `seller` with console approvals (each offer approved by the owner); a wrong delivery is disputed
// and the purchase made again. Returns the delivered deal's view.
async function heldBuy(ctx, stack, seller, service, price, text) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const p = await tool(ctx, 'valun_propose', {counterparty: seller, role: 'payer', ...job(service, `${text} (try ${attempt})`), price});
    must(p.code === 0 && p.json?.status === 'proposed_awaiting_owner', `console approvals: the offer to ${seller} waits for the owner`, p.json ?? p.out);
    must((await ownerDecide(stack, ctx.owner, p.json.deal_id, 'propose', 'approve')).answer?.status === 200, 'the owner approves the offer');
    const v = await dealUntil(ctx, p.json.deal_id, ['delivered', 'declined', 'expired', 'withdrawn']);
    must(v?.status === 'delivered', `${seller} accepts and delivers`, v?.status);
    if (v.delivery?.checked_exactly_by_your_client?.exact_result_matches) return v;
    const r = await tool(ctx, 'valun_review_delivery', {deal_id: v.id, decision: 'dispute', reason: 'the result differs from the exact one'});
    must(r.code === 0 && r.json?.status === 'disputed', 'a wrong delivery is disputed', r.json ?? r.out);
  }
  throw new Abort(`${seller} delivered no right result in 12 purchases`);
}
const optionOf = (v, w) => (v?.how_you_can_pay?.options || []).find(o => o.pay_with === w);
async function ownNoteReleased(ctx, stack, dealId, what) {
  must((await ownerDecide(stack, ctx.owner, dealId, 'issue_note', 'approve')).answer?.status === 200, `the owner releases ${what}`);
  return (await dealUntil(ctx, dealId, ['note_issued', 'note_failed', 'delivered'], 60000))?.status;
}
async function faults(ctx, stack) {
  const setClock = (ms, {client = true} = {}) => { fs.writeFileSync(stack.clockFile, String(ms)); if (client) fs.writeFileSync(ctx.pyClock.file, String(ms)); };
  const total = (notes, i, r) => notes.find(n => n.issuer_handle === i && n.recipient_handle === r)?.total ?? 0;
  const ledger = async () => (await http(stack.base, 'GET', '/ledger')).body?.notes || [];
  say(`faults (profile ${ctx.profile}): the server and client clocks start ${CLOCK_BACK_MS / 60e3} min behind`);
  // The welcome job, on the clocks 59 minutes behind: sandbox-exact's bound note is 59 minutes old for the tracker
  // (its maximum age is one hour), so the payment below has a T 59 minutes before the tracker's clock.
  let welcome = null;
  for (let i = 0; i < 60 && !welcome; i++) {
    welcome = ((await tool(ctx, 'valun_inbox')).json?.respond || []).find(x => x.counterparty === HANDLES.X && x.your_role === 'payee');
    if (!welcome) await sleep(1000);
  }
  must(welcome, 'the welcome job from sandbox-exact arrives (server clock 59 min behind)');
  must((await tool(ctx, 'valun_respond', {deal_id: welcome.deal_id, action: 'accept'})).json?.status === 'agreed', 'valun_respond accept the welcome job');
  must((await tool(ctx, 'valun_deliver', {deal_id: welcome.deal_id, exact_result: true})).json?.status === 'delivered', 'valun_deliver exact_result');
  must((await dealUntil(ctx, welcome.deal_id, ['note_issued', 'note_failed', 'disputed']))?.status === 'note_issued', 'sandbox-exact pays with a bound note the tracker accepts (59 min old)');
  check(total(await ledger(), HANDLES.X, ctx.handle) === 3, 'X>F 3', (await ledger()).map(n => `${n.issuer_handle}>${n.recipient_handle} ${n.total}`));
  must((await valun(ctx, ['--profile', ctx.profile, 'config', 'approvals', 'console', '--owner-token-file', ctx.ownerFile])).code === 0, 'valun config approvals console');

  // Decision D-1: a payment by transfer held for the owner and rejected; its window ends at T + 1 h + 60 s.
  const d = await heldBuy(ctx, stack, HANDLES.M, 'notary', 2, 'E2E-1 faults: D-1 window');
  const p1 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: HANDLES.X, expected_deliverable_sha256: d.delivery.sha256});
  must(p1.code === 0 && p1.json?.status === 'completion_awaiting_owner', 'pay_with=sandbox-exact is held for the owner', p1.json ?? p1.out);
  must((await ownerDecide(stack, ctx.owner, d.id, 'pay_by_transfer', 'reject')).answer?.status === 200, 'the owner rejects the payment by transfer');
  const v1 = (await tool(ctx, 'valun_deal', {deal_id: d.id})).json || {};
  const fa = Date.parse(v1.how_you_can_pay?.fallback_after ?? '');
  check(optionOf(v1, 'own_note')?.why_not === 'transfer_window_open' && Number.isFinite(fa) && fa - (Date.now() + CLOCK_BACK_MS) > 58 * 60e3,
    'D-1: own_note waits for the window (transfer_window_open), fallback_after about an hour ahead on the server clock', {own: optionOf(v1, 'own_note'), fallback_after: v1.how_you_can_pay?.fallback_after});
  // The clock jump: both clocks move 59 minutes forward to the real time.
  setClock(0);
  await sleep(500);
  say(`  clocks jumped forward 59 min; the window ends ${Math.round((fa - Date.now()) / 1000)} s from now`);
  const v2 = (await tool(ctx, 'valun_deal', {deal_id: d.id})).json || {};
  const o1 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d.delivery.sha256});
  check(fa > Date.now() && optionOf(v2, 'own_note')?.why_not === 'transfer_window_open' && o1.json?.error === 'transfer_window_open',
    'D-1: right after the jump the window is still open (the own note is refused: transfer_window_open)', {own: optionOf(v2, 'own_note'), answer: o1.json ?? o1.out});
  while (Date.now() < fa + 2000) await sleep(1000);
  const v3 = (await tool(ctx, 'valun_deal', {deal_id: d.id})).json || {};
  check(optionOf(v3, 'own_note')?.available === true, 'D-1: after T + 1 h + 60 s (server clock) the own note is offered again', optionOf(v3, 'own_note'));
  let o2 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d.delivery.sha256});
  // The client keeps its own, wider margin: an earlier attempt counts until T + 1 h + 2 min and a read-back of its
  // edges (valun novation.attempt_outcome), so it may still say transfer_window_open for up to a minute more.
  if (o2.json?.error === 'transfer_window_open') {
    const ra = o2.json.retry_after_ms;
    check(Number.isFinite(ra) && ra > 0 && Date.now() + ra <= fa + 61000 + 5000, "D-1: the client's own margin (T + 1 h + 2 min) is at most a minute past the server's", {retry_after_ms: ra, server_fallback_after: v1.how_you_can_pay?.fallback_after});
    await sleep((Number.isFinite(ra) ? ra : 60000) + 1500);
    o2 = await tool(ctx, 'valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d.delivery.sha256});
  }
  const ownAt = Date.now();
  must(o2.code === 0 && o2.json?.status === 'completion_awaiting_owner', 'D-1 window expired: the own note is signed and held for the owner', o2.json ?? o2.out);
  check(await ownNoteReleased(ctx, stack, d.id, 'the own note') === 'note_issued', 'the own note is issued after the window: the deal is paid by it');
  check(total(await ledger(), ctx.handle, HANDLES.M) === 2, 'F>M 2 on the tracker');

  // 409 note_timestamp_ahead: the server clock (and the client's) moves back to 20 s before F>M's last note; a new
  // note on that edge needs a later timestamp than the server clock allows: retry_after_ms, then it goes through.
  const d2 = await heldBuy(ctx, stack, HANDLES.M, 'notary', 2, 'E2E-1 faults: timestamp ahead');
  setClock(-((Date.now() - ownAt) + 20000));
  await sleep(500);
  const a1 = await tool(ctx, 'valun_review_delivery', {deal_id: d2.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d2.delivery.sha256});
  const ra = a1.json?.retry_after_ms;
  check(a1.code !== 0 && a1.json?.error === 'note_timestamp_ahead' && ra > 3000 && ra < 40000, '409 note_timestamp_ahead with retry_after_ms (the edge\'s last note is ahead of the server clock)', a1.json ?? a1.out);
  await sleep((Number.isFinite(ra) ? ra : 20000) + 1500);
  const a2 = await tool(ctx, 'valun_review_delivery', {deal_id: d2.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d2.delivery.sha256});
  check(a2.code === 0 && a2.json?.status === 'completion_awaiting_owner', 'after retry_after_ms the same acceptance goes through (held for the owner)', a2.json ?? a2.out);
  if (a2.json?.status === 'completion_awaiting_owner') check(await ownNoteReleased(ctx, stack, d2.id, 'the retried note') === 'note_issued', 'the retried note is issued');
  setClock(0);
  await sleep(500);

  // Decision D-2 b: a payment by transfer refused when it is posted. Between its template and its post the server
  // clock jumps 11 minutes ahead (the client's does not), past the 10-minute initiation window: 409 transfer_stale. The
  // server records the refused attempt: the payer's own note then waits for its window, while a same-issuer retry on
  // the same prior state does not (the same-prior exemption); that retry is held for the owner and rejected, and the
  // deal is disputed instead.
  const d3 = await heldBuy(ctx, stack, HANDLES.M, 'notary', 2, 'E2E-1 faults: refused at post');
  const sf = JSON.stringify(stack.clockFile);
  const pj = await pyLib(ctx, `
import json, time
from valun import client as vc
from valun.home import profile_path
c = vc.Client(vc.FileStore(profile_path('${ctx.profile}')))
real, posts = c.request, []
def request(method, path, *a, **kw):
    if method == 'POST' and path.endswith('/pay-by-transfer'):
        jump = not posts
        if jump:
            open(${sf}, 'w').write('660000'); time.sleep(0.6)
        try:
            r = real(method, path, *a, **kw)
            posts.append({'status': 200})
            return r
        except vc.ValunError as e:
            posts.append({'error': e.code, 'http': e.status})
            raise
        finally:
            if jump:
                open(${sf}, 'w').write('0'); time.sleep(0.4)
    return real(method, path, *a, **kw)
c.request = request
try:
    r = c.pay_by_transfer('${d3.id}', '${HANDLES.X}', expected_deliverable_sha256='${d3.delivery.sha256}')
    print(json.dumps({'status': r.get('status'), 'posts': posts}))
except vc.ValunError as e:
    print(json.dumps({'error': e.code, 'http': e.status, 'posts': posts}))`);
  setClock(0);
  const pr = jsonOf(pj.out.trim().split(/\r?\n/).pop() ?? '');
  // A fresh template comes with the refusal (on the same prior state, so the recorded attempt does not hold it back),
  // made at the jumped server clock: its T is 11 minutes ahead of the client's own, so the client refuses it itself
  // (timestamp_stale) and signs nothing more.
  check(pr?.posts?.[0]?.error === 'transfer_stale' && pr.posts[0].http === 409 && pr.posts.length === 1 && ['transfer_stale', 'timestamp_stale', 'transfer_window_open'].includes(pr.error),
    'D-2 b: the post 11 minutes after its template is refused (409 transfer_stale); the client signs no second post', pr ?? pj.out + pj.err);
  const v4 = (await tool(ctx, 'valun_deal', {deal_id: d3.id})).json || {};
  check(v4.status === 'delivered' && optionOf(v4, 'own_note')?.why_not === 'transfer_window_open' && optionOf(v4, HANDLES.X)?.available === true
      && optionOf(v4, HANDLES.X)?.why_not === null,
    'D-2 b: the server recorded the refused attempt: own_note waits for its window (transfer_window_open); the same issuer on the same prior state does not',
    {status: v4.status, own: optionOf(v4, 'own_note'), held: optionOf(v4, HANDLES.X)});
  const ob = await tool(ctx, 'valun_review_delivery', {deal_id: d3.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d3.delivery.sha256});
  check(ob.json?.error === 'transfer_window_open', 'D-2 b: an own note for that deal is refused (transfer_window_open)', ob.json ?? ob.out);
  const rb = await tool(ctx, 'valun_review_delivery', {deal_id: d3.id, decision: 'accept', pay_with: HANDLES.X, expected_deliverable_sha256: d3.delivery.sha256});
  check(rb.code === 0 && rb.json?.status === 'completion_awaiting_owner', 'D-2 b: a same-issuer retry on the same prior state is signed and held for the owner (not held back by the window)', rb.json ?? rb.out);
  const rbx = await ownerDecide(stack, ctx.owner, d3.id, 'pay_by_transfer', 'reject');
  check(rbx.answer?.status === 200, 'D-2 b: the owner rejects the retry', rbx.answer?.body ?? rbx.owner);
  const dz = await tool(ctx, 'valun_review_delivery', {deal_id: d3.id, decision: 'dispute', reason: 'E2E: not paid within the window of the refused payment'});
  check(dz.code === 0 && dz.json?.status === 'disputed', 'D-2 b: the deal is disputed instead (its acceptance never stood)', dz.json ?? dz.out);

  // 409 pair_busy: the owner releases a held note while the fault proxy loses the tracker's answer to its POST /notes
  // (the tracker applies the note; the server times out): the deal stays issuing_note, and a second note on the pair
  // waits retry_after_ms until the server's recovery has read the first one back.
  const d4 = await heldBuy(ctx, stack, HANDLES.X, 'notary', 2, 'E2E-1 faults: pair busy, first note');
  const n1 = await tool(ctx, 'valun_review_delivery', {deal_id: d4.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d4.delivery.sha256});
  must(n1.code === 0 && n1.json?.status === 'completion_awaiting_owner', 'the first own note to sandbox-exact is held for the owner', n1.json ?? n1.out);
  const d5 = await heldBuy(ctx, stack, HANDLES.X, 'notary', 2, 'E2E-1 faults: pair busy, second note');
  stack.proxy.state.drop.notePosts = 1;
  const rel = await ownerDecide(stack, ctx.owner, d4.id, 'issue_note', 'approve');
  check(stack.proxy.state.dropped.length === 1, "the fault proxy forwarded the release's POST /notes and dropped the tracker's answer (pair reads answer 503 until lifted)", {dropped: stack.proxy.state.dropped, answer: rel.answer?.status});
  const s4 = (await tool(ctx, 'valun_deal', {deal_id: d4.id})).json || {};
  check(s4.status === 'issuing_note', 'the first deal stays issuing_note (its note may be on the tracker; the server has not read it back)', s4.status);
  const b1 = await tool(ctx, 'valun_review_delivery', {deal_id: d5.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d5.delivery.sha256});
  const rp = b1.json?.retry_after_ms;
  check(b1.code !== 0 && b1.json?.error === 'pair_busy' && rp > 0, '409 pair_busy for a second note on the pair, with retry_after_ms', b1.json ?? b1.out);
  stack.proxy.state.blockReads = false;          // the outage ends: the server's recovery (every 60 s) can read the pair
  say(`  (the fault proxy answered ${stack.proxy.state.blocked} pair read(s) with 503; reads restored)`);
  const settled = await dealUntil(ctx, d4.id, ['note_issued', 'note_failed', 'delivered'], 150000);
  check(settled?.status === 'note_issued', "the server's recovery reads the first note back: note_issued", settled?.status);
  const b2 = await tool(ctx, 'valun_review_delivery', {deal_id: d5.id, decision: 'accept', pay_with: 'own_note', expected_deliverable_sha256: d5.delivery.sha256});
  check(b2.code === 0 && b2.json?.status === 'completion_awaiting_owner', 'retried, the second note goes through (held for the owner)', b2.json ?? b2.out);
  if (b2.json?.status === 'completion_awaiting_owner') check(await ownNoteReleased(ctx, stack, d5.id, 'the second note') === 'note_issued', 'the second note is issued');
  await reconciledExactly(ctx, stack, (await http(stack.base, 'GET', '/ledger')).body?.reconciliation || [], 'after the faults ');
}

const sortKeys = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
// The tour lists the edges GET /edges returns (existing edges, 0 included); an edge that does not exist is not listed.
// So compare: every printed edge has the expected total, and every expected non-zero edge is printed.
function nonZeroOrListed(expected, printed) {
  const out = {};
  for (const [k, v] of Object.entries(expected)) if (v !== 0 || k in printed) out[k] = v;
  return out;
}

// ---------- the profiles of a run, joined first ----------
// s1: the tour and the calls (approvals ask); s3: the probes (approvals none, then console); s2: the MCP session
// (approvals ask); in mode on ia, ib, ic: invited participants (approvals none). Each with its owner token in a file of
// the temp folder (throwaway).
async function joinOne(ctx, stack, how, approvals, input = '') {
  const j = await valun(ctx, ['--profile', ctx.profile, 'join', ...how, '--server', stack.base, '--handle', ctx.handle,
    '--operator', 'INT-1 e2e', '--approvals', approvals, '--owner-token-file', ctx.ownerFile], {input, timeoutMs: 120000});
  must(j.code === 0, `valun join ${how[0]} (profile ${ctx.profile}, approvals ${approvals}) exits 0`, j.out + j.err);
  ctx.owner = fs.readFileSync(ctx.ownerFile, 'utf8').trim();
  return ctx;
}
async function joinAll(ctx, stack, mode, parts) {
  const out = {};
  const sub = profile => ({...ctx, profile, handle: `e2e-${profile}-${crypto.randomBytes(3).toString('hex')}`, ownerFile: path.join(ctx.tmp, `owner-token-${profile}.txt`)});
  if (parts.has('tour') || parts.has('calls')) await joinOne(ctx, stack, ['--sandbox'], 'ask');
  if (parts.has('probes')) out.s3 = await joinOne(sub('s3'), stack, ['--sandbox'], 'none');
  if (parts.has('mcp')) out.s2 = await joinOne(sub('s2'), stack, ['--sandbox'], 'ask');
  if (parts.has('faults')) {
    // The clocks move back first: the profile joins and earns its welcome job 59 minutes in the past (see faults()).
    const f = sub('f1'), dir = path.join(ctx.tmp, 'pyclock');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'sitecustomize.py'), PY_CLOCK);
    f.pyClock = {dir, file: path.join(ctx.tmp, 'py-clock-offset-ms')};
    fs.writeFileSync(f.pyClock.file, String(CLOCK_BACK_MS));
    fs.writeFileSync(stack.clockFile, String(CLOCK_BACK_MS));
    await sleep(500);
    out.f1 = await joinOne(f, stack, ['--sandbox'], 'none');
  }
  if (parts.has('invited') && mode === 'on') {
    const admin = fs.readFileSync(ADMIN_FILE || path.join(ctx.tmp, `data-pilot-${mode}`, 'admin-token'), 'utf8').trim();
    out.invited = {};
    for (const who of ['a', 'b', 'c']) {
      const inv = await fetch(`${stack.base}/pilot/v1/admin/invites`, {method: 'POST', headers: {'content-type': 'application/json', 'x-valun-admin': admin},
        body: JSON.stringify({note: `INT-1 e2e ${who}`, max_uses: 1, ttl_days: 1})});
      const code = (await inv.json().catch(() => ({}))).code;
      must(inv.status === 201 && /^vpi_/.test(code ?? ''), `an invite for ${who} (loopback admin)`, inv.status);
      const c = await joinOne(sub(`i${who}`), stack, ['--invite-from-stdin'], 'none', code + '\n');
      c.id = (await http(stack.base, 'GET', '/owner', {token: c.owner})).body?.participant?.id;
      out.invited[who] = c;
    }
  }
  return out;
}

// ---------- one mode ----------
async function runMode(name) {
  const run = RUNS[name], mode = run.mode;
  // The parts of this run (with --base: every part --only names, on the one stack given).
  const parts = new Set((BASE ? [...PARTS] : run.parts.filter(x => PARTS.has(x))).filter(x => x !== 'invited' || mode === 'on'));
  if (!parts.size && !SERVE) return {mode: name, ok: true, skipped: true, failures: [], pauses: 0};
  failures = [];
  const pauses0 = ratePauses;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `valun-e2e-py-${name}-`));
  const ctx = {tmp, home: path.join(tmp, 'home'), cliLog: path.join(tmp, 'cli.log'), profile: 's1',
    handle: `e2e-s1-${crypto.randomBytes(3).toString('hex')}`, ownerFile: path.join(tmp, 'owner-token-s1.txt')};
  fs.mkdirSync(ctx.home, {recursive: true});
  say(`=== run ${name} (mode ${mode}; parts ${[...parts].join(', ')}): temp folder ${tmp}`);
  let stack;
  try {
    stack = BASE ? await attachStack(mode, BASE) : await startStack(mode, tmp, {faults: !!run.faults});
    ctx.server = stack.base;
  } catch (e) {
    say(`could not start the stack: ${e.message}`);
    return {mode: name, ok: false, startFailed: true, failures: [{what: 'stack start', detail: e.message}], tmp};
  }
  try {
    const f = stack.info?.features || [];
    must(f.includes('bound_notes/1') && f.includes('circulation/1'), `GET /info lists bound_notes/1 and circulation/1 (mode ${mode})`, f);
    if (SERVE) {
      say(`serving: ${stack.base}  (VALUN_HOME=${ctx.home}); create ${path.join(tmp, 'STOP')} or press Ctrl+C to stop`);
      while (!fs.existsSync(path.join(tmp, 'STOP')) && stack.server?.exitCode === null) await sleep(500);
      return {mode: name, ok: true, tmp};
    }
    // 1. every profile the parts use joins first, while the server is quiet: join is not repeated on a 429 (it creates
    // the participant before it sets the mandate). Sandbox joins: at most 3 per address per hour (lib/pilot/http.mjs).
    const p = await joinAll(ctx, stack, mode, parts);
    // 2. the five-step tour, then the state it leaves
    if (parts.has('tour')) {
      const before = (await http(stack.base, 'GET', '/clearing')).body?.totals || {};
      const tour = await runTour(ctx, stack);
      must(tour.code === 0, 'the tour completed (the later checks build on it)');
      await afterTour(ctx, stack, before);
    }
    // 3. scripted tool calls through valun call
    if (parts.has('calls')) await callSeries(ctx, stack);
    // 3b. probes on a third profile: a payment held for the owner, rejected, refused for its window, retried, approved
    if (p.s3) await probes(p.s3, stack);
    // 3c. mode on: invited participants; a payment with a third party's note signed by the issuer's and payee's clients
    if (p.invited) await invited(p.invited, stack);
    // 4. one MCP session over stdio with the official SDK: the whole tour
    if (p.s2) await mcpSession(p.s2, stack, MCP_EXACT || (!!run.exactMcp && !BASE));
    // 5. the JavaScript client; 6. the Hermes plugin through Hermes's dispatch path
    if (parts.has('js')) await jsPart(stack, tmp);
    if (parts.has('hermes')) await hermesPart(stack, tmp);
    // 7. clock jumps and a lost tracker answer
    if (p.f1) await faults(p.f1, stack);
  } catch (e) {
    if (!(e instanceof Abort)) check(false, 'no unexpected error', e.stack || String(e));
  } finally {
    await stack.stop();
  }
  const ok = failures.length === 0;
  if (!KEEP && ok) fs.rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  return {mode: name, ok, failures, tmp, pauses: ratePauses - pauses0};
}

// Before any stack starts: what the parts asked for need (exit 2 when something is missing).
{
  const wanted = new Set((BASE ? [...PARTS] : MODES.flatMap(m => RUNS[m].parts.filter(x => PARTS.has(x)))));
  const problems = [];
  if (!fs.existsSync(PYTHON)) problems.push(`VALUN_PYTHON ${PYTHON} does not exist`);
  else if (wanted.has('mcp') && spawnSync(PYTHON, ['-c', 'import mcp'], {windowsHide: true}).status !== 0) problems.push(`${PYTHON} has no official mcp SDK (import mcp failed)`);
  if (wanted.has('hermes')) {
    if (!fs.existsSync(HERMES_PYTHON)) problems.push(`HERMES_PYTHON ${HERMES_PYTHON} does not exist`);
    if (fs.existsSync(HERMES_HOME_DIR) && fs.readdirSync(HERMES_HOME_DIR).length) problems.push(`E2E_HERMES_HOME ${HERMES_HOME_DIR} is not empty`);
    if (!fs.existsSync(path.join(PLUGIN_DIR, 'plugin.yaml'))) problems.push(`VALUN_PLUGIN ${PLUGIN_DIR} has no plugin.yaml`);
  }
  if (wanted.has('js') && !fs.existsSync(path.join(VALUN_OPEN, 'js', 'src', 'index.js'))) problems.push(`${VALUN_OPEN}/js/src/index.js does not exist`);
  if (problems.length) { for (const x of problems) console.error(`cannot run: ${x}`); process.exit(2); }
}
const results = [];
for (const mode of SERVE ? MODES.slice(0, 1) : MODES) results.push(await runMode(mode));
console.log('\n==== e2e-python-client summary');
for (const r of results) {
  if (r.skipped) { console.log(`run ${r.mode}: skipped (no part of it in --only)`); continue; }
  console.log(`run ${r.mode}: ${r.ok ? 'PASS' : `FAIL (${r.failures.length})`}${r.pauses ? `; ${r.pauses} pause(s) after 429 rate_limited` : ''}${!r.ok || KEEP ? `  (temp folder ${r.tmp})` : ''}`);
  for (const f of r.failures || []) console.log(`  - ${f.what}`);
}
process.exit(results.some(r => r.startFailed) ? 2 : results.every(r => r.ok) ? 0 : 1);
