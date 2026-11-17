// scripts/docker-entrypoint.sh, run as in the image but over a fake one (VALUN_ROOT: fake trackers, a fake app and a
// placeholder basis_server) and a fresh data folder (VALUN_DATA), on the pilot network (no PILOT_NETWORK: no Ergo pieces):
//   - fix inbox #64 (c): when the demo tracker (the legacy desk's) exits, the container keeps running; when the pilot
//     tracker exits it stops, and stops the app;
//   - a demo tracker that exits without writing its id: the app starts at once, with BASIS_TRACKER_NFT_ID empty (the
//     server then runs the network without the desk: test/desk-optional.test.mjs), and the app is still watched;
//   - the platform's stop (SIGTERM) with the demo tracker already gone still stops the app and the pilot tracker and
//     exits 0 (Linux only: on Windows a child cannot be sent a signal bash can trap).
// Needs bash (Git for Windows on Windows, /bin/bash elsewhere) and node; no tracker binary. The image's copy of the app
// does not hold the entrypoint (it is outside the app folder), so there these tests are skipped with the reason.
// Run: node --test test/entrypoint.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const made = [], children = [], cleanups = [];
after(() => {
  for (const f of cleanups) { try { f(); } catch { /* best effort */ } }
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-entry-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms: ${what}`);
    await sleep(100);
  }
}
// As in test/operations.test.mjs: a missing file skips the test in the image's copy (VALUN_APP_COPY=image), else fails it.
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
function canRun(t) {
  if (!needs(t, 'scripts/docker-entrypoint.sh')) return false;
  if (!fs.existsSync(BASH)) { t.skip(`needs ${BASH}`); return false; }
  if (process.getuid?.() === 0) { t.skip('run as root, the entrypoint switches to the image\'s valun user, which this machine does not have'); return false; }
  return true;
}

// A fake tracker, called as basis/run-tracker.sh is (RUN_DIR BINARY): it writes its id (a's in the demo tracker's
// folder, b's in the pilot tracker's) unless RUN_DIR/no-id exists, when it exits at once (4); then it runs until
// RUN_DIR/die exists (3), at most 60 s.
const FAKE_TRACKER = `#!/bin/bash
RUN=$1
[ -e "$RUN/no-id" ] && exit 4
case "$RUN" in */pilot/tracker) ID=b ;; *) ID=a ;; esac
[ -s "$RUN/tracker-nft-id" ] || printf "$ID%.0s" $(seq 1 64) > "$RUN/tracker-nft-id"
for i in $(seq 1 600); do [ -e "$RUN/die" ] && exit 3; sleep 0.1; done
exit 9
`;
// A fake app: it records its pid and the settings the entrypoint gave it, then runs until FAKE_OUT/app-die exists (5),
// at most 60 s.
const FAKE_APP = `import fs from 'node:fs';
const out = process.env.FAKE_OUT;
const env = Object.fromEntries(['BASIS_TRACKER_NFT_ID', 'PILOT_TRACKER_NFT_ID', 'PILOT_TRACKER_URL', 'PILOT_DATA_DIR', 'VALUN_DATA_DIR'].map(k => [k, process.env[k] ?? null]));
fs.writeFileSync(out + '/app.json', JSON.stringify({pid: process.pid, env}));
setInterval(() => { if (fs.existsSync(out + '/app-die')) process.exit(5); }, 100);
setTimeout(() => process.exit(9), 60000);
`;
const posix = p => p.replace(/\\/g, '/');
// The fake image and data folder; start() runs the entrypoint over them (with none of this process's PILOT_, BASIS_,
// VALUN_ or ERGO_ settings). When the test file ends every fake is told to stop (each also stops on its own after 60 s).
function fakeContainer() {
  const opt = tmp(), data = tmp(), out = tmp();
  fs.mkdirSync(path.join(opt, 'bin')); fs.mkdirSync(path.join(opt, 'app'));
  fs.writeFileSync(path.join(opt, 'bin', 'basis_server'), 'a placeholder: the fake trackers never run it\n');
  fs.writeFileSync(path.join(opt, 'run-tracker.sh'), FAKE_TRACKER, {mode: 0o755});
  fs.writeFileSync(path.join(opt, 'app', 'server.mjs'), FAKE_APP);
  fs.mkdirSync(path.join(data, 'tracker'), {recursive: true}); fs.mkdirSync(path.join(data, 'pilot', 'tracker'), {recursive: true});
  cleanups.push(() => { for (const f of [path.join(data, 'tracker', 'die'), path.join(data, 'pilot', 'tracker', 'die'), path.join(out, 'app-die')]) fs.writeFileSync(f, ''); });
  const appInfo = () => fs.existsSync(path.join(out, 'app.json')) && JSON.parse(fs.readFileSync(path.join(out, 'app.json'), 'utf8'));
  const start = () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k)));
    const c = spawn(BASH, [posix(path.join(root, 'scripts', 'docker-entrypoint.sh'))], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: {...env, VALUN_ROOT: posix(opt), VALUN_DATA: posix(data), FAKE_OUT: out, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`}});
    children.push(c);
    const e = {child: c, log: '', code: null};
    c.stderr.on('data', d => { e.log += d; }); c.stdout.on('data', d => { e.log += d; });
    e.exited = new Promise(r => c.on('exit', code => { e.code = code; r(code); }));
    return e;
  };
  return {data, out, start, appInfo};
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the container keeps running when the demo tracker exits, and stops (exit 1, stopping the app) when the pilot tracker exits', async t => {
  if (!canRun(t)) return;
  const {data, start, appInfo} = fakeContainer();
  const e = start();
  const app = await until(`the app started (entrypoint: ${e.log.slice(-300)})`, appInfo);
  assert.deepEqual([app.env.BASIS_TRACKER_NFT_ID, app.env.PILOT_TRACKER_NFT_ID], ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(app.env.PILOT_TRACKER_URL, 'http://127.0.0.1:3058');
  fs.writeFileSync(path.join(data, 'tracker', 'die'), '');
  await sleep(1500);
  assert.equal(e.code, null, `the entrypoint still runs after the demo tracker exited: ${e.log}`);
  assert.ok(alive(app.pid), 'and so does the app');
  assert.doesNotMatch(e.log, /a process exited; stopping/);
  fs.writeFileSync(path.join(data, 'pilot', 'tracker', 'die'), '');
  assert.equal(await e.exited, 1, e.log);
  assert.match(e.log, /a process exited; stopping/, 'the pilot tracker failed (exit 3): the others are stopped all the same');
  await until('the app was stopped', () => !alive(app.pid), 10_000);
});

test('a demo tracker that exits without writing its id: the app starts at once with BASIS_TRACKER_NFT_ID empty, and the container still stops when the app exits', async t => {
  if (!canRun(t)) return;
  const {data, out, start, appInfo} = fakeContainer();
  fs.writeFileSync(path.join(data, 'tracker', 'no-id'), '');
  const t0 = Date.now(), e = start();
  const app = await until(`the app started (entrypoint: ${e.log.slice(-300)})`, appInfo);
  assert.ok(Date.now() - t0 < 10_000, `the app started after ${Date.now() - t0} ms: no 20 s wait for an id an exited demo tracker cannot write`);
  assert.deepEqual([app.env.BASIS_TRACKER_NFT_ID, app.env.PILOT_TRACKER_NFT_ID], ['', 'b'.repeat(64)]);
  await sleep(500);
  assert.equal(e.code, null, `still running: ${e.log}`);
  fs.writeFileSync(path.join(out, 'app-die'), '');
  assert.equal(await e.exited, 1, e.log);
  assert.match(e.log, /a process exited; stopping/);
});

test('the platform\'s stop (SIGTERM) with the demo tracker already gone stops the app and the pilot tracker and exits 0', async t => {
  if (!canRun(t)) return;
  if (process.platform === 'win32') { t.skip('on Windows a child cannot be sent a signal bash can trap'); return; }
  const {data, start, appInfo} = fakeContainer();
  const e = start();
  const app = await until(`the app started (entrypoint: ${e.log.slice(-300)})`, appInfo);
  fs.writeFileSync(path.join(data, 'tracker', 'die'), '');
  await sleep(800);
  e.child.kill('SIGTERM');
  assert.equal(await e.exited, 0, e.log);
  assert.doesNotMatch(e.log, /a process exited; stopping/, 'stopped by the trap, not by an exit');
  assert.ok(!alive(app.pid), 'the app was stopped before the entrypoint exited');
});
