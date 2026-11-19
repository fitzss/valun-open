// scripts/live-check.mjs: the verdicts of evaluate() on recorded snapshots (no network). The script is an operator tool
// that the container image does not ship, so in the image's copy of the app (VALUN_APP_COPY=image) these tests are
// skipped with the reason, and anywhere else a missing script fails them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'live-check.mjs');
const have = fs.existsSync(script);
const load = async t => {
  if (have) return import(pathToFileURL(script).href);
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail('missing scripts/live-check.mjs');
  t.skip('needs scripts/live-check.mjs, which the container image\'s copy of the app does not have (VALUN_APP_COPY=image)');
  return null;
};

const PIN = 'Basis tracker v3.2: Valun fork commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a (branch circulating-credit-v3.2 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself';
const NOVATION = {transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000,
  tracker_build: 'valun-circulating-credit/4', transfer_version: 4, bound_note_version: 3, prior_ack: 'basis/prior-ack/1'};
const row = (issuer, recipient, status = 'match') => ({issuer, recipient, issued_via_valun: 3, tracker_total: 3, status});
// Today's live answers in mode on (2026-11-11, after the deploy), and the machine's report through fly ssh.
const healthy = () => ({
  status: {basis: {pin: PIN}},
  info: {features: ['bound_notes/1', 'circulation/1', 'guarantees/1'], novation: {...NOVATION}},
  ledger: {notes: [{}, {}, {}], reconciliation: [row('a', 'b'), row('c', 'd'), row('e', 'f')]},
  clearingCode: 200,
  fly: {mem: {mem_available_kb: 104252, swap_free_kb: 262140, app_kb: 100160, trackers_kb: [13024, 13740],
    files: {'pilot-state.json': 679999, 'pilot-edge-log.jsonl': 21088, 'pilot-audit.jsonl': 43375}},
  logs: {lines: ['app[1] iad [info]Pilot: circulating credit: on', 'health[1] iad [info]Health check passing']}},
});
const levels = (report, name) => report.filter(r => r.name.includes(name)).map(r => r.level);
const worst = report => report.some(r => r.level === 'fail') ? 'fail' : report.some(r => r.level === 'warn') ? 'warn' : 'ok';

test('live-check: a healthy server in mode on is all clear, and importing the script runs nothing', async t => {
  const L = await load(t); if (!L) return;
  const r = L.evaluate(healthy(), {expectMode: 'on'});
  assert.equal(worst(r), 'ok', JSON.stringify(r, null, 1));
  assert.deepEqual(levels(r, 'features for mode on'), ['ok']);
  assert.deepEqual(levels(r, 'contract'), ['ok']);
  assert.deepEqual(levels(r, 'VmRSS'), ['ok']);
  assert.match(r.find(x => x.name.includes('VmRSS')).detail, /^123\.9 MiB/);       // 100160 + 13024 + 13740 kB
});

test('live-check: the testnet network runs tracker v4 with anchored netting (its pin), the pilot tracker v3.2', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy(); s.info.network = 'valun-testnet-1';
  s.status.basis.pin = 'Basis tracker v4.3 (anchored netting): Valun fork commit b84b2e780894beb980d789be22ec888ffe97d65a (branch circulating-credit-v4 on Basis upstream 43e2173)';
  assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'tracker pin'), ['ok']);
  s.status.basis.pin = PIN;
  assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'pin names tracker v4 (anchored netting)'), ['fail'], 'v3.2 on the testnet');
  // A patch version, and a name that adds what the build fixes, pass; so does every build lib/basis.mjs names with
  // anchored netting, as /api/status reports it (trackerPin, pinned). deploy.yml runs this check after each deploy.
  s.status.basis.pin = 'Basis tracker v4.4.1 (anchored netting, keyspaces kept open): Valun fork commit 7c3c0db093f9292cc887e27860075599e8706a8e (branch tr-22-keep-keyspace on Basis upstream 43e2173), as the tracker reports itself';
  assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'tracker pin'), ['ok'], s.status.basis.pin);
  const {TRACKER_BUILDS, trackerPin} = await import(pathToFileURL(path.join(root, 'lib', 'basis.mjs')).href);
  const anchored = Object.entries(TRACKER_BUILDS).filter(([, b]) => b.name.includes('(anchored netting'));
  assert.ok(anchored.length >= 4, 'tracker v4.1 and later are named with anchored netting');
  for (const [commit, b] of anchored) {
    s.status.basis.pin = trackerPin({build: b.build, commit}, 'fallback', {pinned: true});
    assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'tracker pin'), ['ok'], s.status.basis.pin);
  }
  // An unlisted build reports itself as tracker v3.2 (an unlisted build), and a v4 name without anchored netting fails.
  for (const pin of [trackerPin({build: 'valun-circulating-credit/4', commit: '1'.repeat(40)}, 'fallback', {pinned: true}),
    'Basis tracker v4: Valun fork commit 602565e3179b1656d4cf35a292006a6899ac5c61 (branch circulating-credit-v4 on Basis upstream 43e2173)',
    'Basis tracker v4.4.1.2 (anchored netting): Valun fork commit 1111111', 'Basis tracker v4.5 (anchored netting) extra: Valun fork commit 1111111']) {
    s.status.basis.pin = pin;
    assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'pin names tracker v4 (anchored netting)'), ['fail'], pin);
  }
  const p = healthy(); p.info.network = 'valun-pilot-1';
  p.status.basis.pin = 'Basis tracker v4.3 (anchored netting): Valun fork commit b84b2e7 (branch circulating-credit-v4)';
  assert.deepEqual(levels(L.evaluate(p, {expectMode: 'on'}), 'pin names tracker v3.2'), ['fail'], 'v4 on the pilot');
  // A local server runs tracker v4 in pure credit on the pilot network, and its GET /pilot/v1/health says so (fix inbox
  // #146: it named the build's anchored netting on a server with no chain). trackerPin names it so only when asked
  // (pureCreditNamed: the health route, off the testnet) and only for a tracker that reports pure credit.
  const caps = {build: 'valun-circulating-credit/4', commit: '7c3c0db093f9292cc887e27860075599e8706a8e', pure_credit: true};
  const pure = trackerPin(caps, 'fallback', {pinned: true, pureCreditNamed: true});
  assert.equal(pure, 'Basis tracker v4.4.1 (pure credit, keyspaces kept open): Valun fork commit 7c3c0db093f9292cc887e27860075599e8706a8e (branch tr-22-keep-keyspace on Basis upstream 43e2173), as the tracker reports itself');
  p.status.basis.pin = pure;
  assert.deepEqual(levels(L.evaluate(p, {expectMode: 'on'}), 'tracker pin'), ['ok'], 'tracker v4 in pure credit on the pilot network');
  for (const [commit, b] of anchored) {
    p.status.basis.pin = trackerPin({build: b.build, commit, pure_credit: true}, 'fallback', {pinned: true, pureCreditNamed: true});
    assert.match(p.status.basis.pin, /^Basis tracker v4(\.\d+){0,2} \(pure credit(, [^)]+)?\): /, p.status.basis.pin);
    assert.deepEqual(levels(L.evaluate(p, {expectMode: 'on'}), 'tracker pin'), ['ok'], p.status.basis.pin);
  }
  // Not asked, or a tracker that does not report pure credit: the build's own name, as /api/status and the testnet give it.
  assert.equal(trackerPin(caps, 'fallback', {pinned: true}), s.status.basis.pin = 'Basis tracker v4.4.1 (anchored netting, keyspaces kept open): Valun fork commit 7c3c0db093f9292cc887e27860075599e8706a8e (branch tr-22-keep-keyspace on Basis upstream 43e2173), as the tracker reports itself');
  assert.equal(trackerPin({...caps, pure_credit: false}, 'fallback', {pinned: true, pureCreditNamed: true}), s.status.basis.pin);
  // A pure-credit name is the pilot network's: on the testnet it fails.
  s.status.basis.pin = pure;
  assert.deepEqual(levels(L.evaluate(s, {expectMode: 'on'}), 'pin names tracker v4 (anchored netting)'), ['fail'], 'pure credit on the testnet');
});

test('live-check: a tracker that is not pinned, or not v3.2, fails once circulation is on (a warning in mode off)', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy(); s.status.basis.pin = `${PIN} (binary not pinned)`;
  assert.deepEqual(levels(L.evaluate(s), 'pinned'), ['fail']);
  s.status.basis.pin = 'Basis 3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3 + sigma-rust 8120eddd';
  assert.deepEqual(levels(L.evaluate(s), 'pin names tracker v3.2'), ['fail']);
  const off = healthy(); off.info = {features: []}; off.status.basis.pin = 'Basis 3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3 + sigma-rust 8120eddd';
  assert.equal(worst(L.evaluate(off, {expectMode: 'off'})), 'ok', 'v15 or v16 with circulation off on the old tracker is fine');
  off.status.basis.pin = `${PIN} (binary not pinned)`;
  assert.deepEqual(levels(L.evaluate(off), 'pinned'), ['warn']);
});

test('live-check: the contract fields must be exactly tracker v3.2\'s (types included); a mode other than expected fails', async t => {
  const L = await load(t); if (!L) return;
  for (const [k, v] of [['transfer_version', '4'], ['bound_note_version', 2], ['prior_ack', undefined], ['tracker_build', 'valun-circulating-credit/3']]) {
    const s = healthy(); if (v === undefined) delete s.info.novation[k]; else s.info.novation[k] = v;
    assert.deepEqual(levels(L.evaluate(s), 'contract'), ['fail'], `${k} = ${JSON.stringify(v)}`);
  }
  const s = healthy(); delete s.info.novation;
  assert.deepEqual(levels(L.evaluate(s), 'contract'), ['fail']);
  assert.deepEqual(levels(L.evaluate(healthy(), {expectMode: 'bound'}), 'features for mode bound'), ['fail']);
});

test('live-check: a reconciliation row that is not match fails and is named; the clearing route must answer in sandbox and on', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy(); s.ledger.reconciliation[1] = row('c', 'd', 'diverged');
  const r = L.evaluate(s);
  assert.deepEqual(levels(r, 'reconciliation'), ['fail']);
  assert.match(r.find(x => x.name.includes('reconciliation')).detail, /not match: c>d diverged/);
  const c = healthy(); c.clearingCode = 503;
  assert.deepEqual(levels(L.evaluate(c), 'clearing'), ['fail']);
  const b = healthy(); b.info.features = ['bound_notes/1']; b.clearingCode = 401;
  assert.deepEqual(levels(L.evaluate(b), 'clearing'), [], 'no clearing check in mode bound');
});

test('live-check: memory over the runbook limits fails, close to them warns; a missing tracker fails', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy(); s.fly.mem.app_kb = 150 * 1024;                              // 150 + 26.1 MiB > 170
  assert.deepEqual(levels(L.evaluate(s), 'VmRSS'), ['fail']);
  s.fly.mem.app_kb = 130 * 1024;                                                     // 156.1 MiB: between 150 and 170
  assert.deepEqual(levels(L.evaluate(s), 'VmRSS'), ['warn']);
  // The limits scale with the machine: MemTotal rounded up to Fly's 256 MB steps (none read: a 256 MB machine).
  const m = healthy(); m.fly.mem.app_kb = 160 * 1024;                                // 186.1 MiB
  m.fly.mem.mem_total_kb = 230 * 1024;                                               // a 256 MB machine: over 170
  assert.deepEqual(levels(L.evaluate(m), 'VmRSS'), ['fail']);
  m.fly.mem.mem_total_kb = 475 * 1024;                                               // a 512 MB machine: at most 340
  assert.deepEqual(levels(L.evaluate(m), 'VmRSS'), ['ok']);
  assert.match(L.evaluate(m).find(x => x.name.includes('VmRSS')).name, /at most 340 MiB \(a 512 MB machine\)/);
  m.fly.mem.app_kb = 290 * 1024;                                                     // 316.1 MiB: between 300 and 340
  assert.deepEqual(levels(L.evaluate(m), 'VmRSS'), ['warn']);
  const a = healthy(); a.fly.mem.mem_available_kb = 30 * 1024;
  assert.deepEqual(levels(L.evaluate(a), 'MemAvailable'), ['fail']);
  a.fly.mem.mem_available_kb = 50 * 1024;
  assert.deepEqual(levels(L.evaluate(a), 'MemAvailable'), ['warn']);
  const t1 = healthy(); t1.fly.mem.trackers_kb = [13024];
  assert.deepEqual(levels(L.evaluate(t1), 'both trackers'), ['fail']);
  const big = healthy(); big.fly.mem.files['pilot-edge-log.jsonl'] = 60 * 1024 * 1024;
  assert.deepEqual(levels(L.evaluate(big), 'edge-log'), ['warn']);
  const none = healthy(); none.fly.mem = {error: 'fly ssh gave no report (exit 1)'};
  assert.deepEqual(levels(L.evaluate(none), 'machine memory'), ['fail']);
});

test('live-check: ALARM, fail closed and OOM lines fail; other error lines warn; without --fly only the public checks run', async t => {
  const L = await load(t); if (!L) return;
  for (const line of ['app[1] [warn]Pilot: ALARM: the pilot tracker reports no capabilities', 'Pilot: circulating credit: on asked, fail closed: pin',
    'kernel: Out of memory: Killed process 668 (node)']) {
    const s = healthy(); s.fly.logs.lines.push(line);
    assert.deepEqual(levels(L.evaluate(s), 'ALARM'), ['fail'], line);
  }
  const w = healthy(); w.fly.logs.lines.push('app[1] [info]Error: client went away');
  const r = L.evaluate(w);
  assert.deepEqual([levels(r, 'ALARM'), levels(r, 'errors in the recent logs')], [['ok'], ['warn']]);
  // Fly's init noise (seen on valun-desk at every start) is no error of the app or the trackers.
  const n = healthy(); n.fly.logs.lines.push('app[8577912a4699d8] iad [info] WARN could not enable checksum offload 0x15 on eth0: an unhandled error occurred: EOPNOTSUPP: Operation not supported');
  assert.deepEqual(levels(L.evaluate(n), 'errors in the recent logs'), []);
  const pub = healthy(); delete pub.fly;
  const p = L.evaluate(pub);
  assert.equal(worst(p), 'ok');
  assert.equal(p.some(x => /VmRSS|logs/.test(x.name)), false);
});

test('live-check: anchor.inconsistent (the tracker\'s records of its box disagree with it) is a WARN of its own, never a FAIL (fix inbox #62)', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy();
  s.fly.logs.lines.push('2026-11-15T02:01:39Z app[x] ord [info]Pilot: anchor.inconsistent: tracker box f80c0c12 (height 1010): the rows give digest 6e62 under basis-avl/1, not e63e, the digest the tracker says its confirmed box commits: the tracker\'s records of what that box commits disagree with it; the tracker builds no redemption until its records agree with the box');
  s.fly.logs.lines.push('app[x] ord [info]Pilot: anchor.inconsistent: tracker box 0a0b (height 1011): the rows cannot be digested as the tracker digests its notes (rows[3] Error: x)');
  const r = L.evaluate(s);
  assert.deepEqual([levels(r, 'ALARM'), levels(r, 'anchor.inconsistent'), levels(r, 'errors in the recent logs'), worst(r)], [['ok'], ['warn'], [], 'warn']);
  assert.match(r.find(x => x.name.includes('anchor.inconsistent')).detail, /^2; e\.g\. 2026-11-15T02:01:39Z/);
  assert.deepEqual(levels(L.evaluate(healthy()), 'anchor.inconsistent'), [], 'no line, no check line');
  // an ALARM line still fails, whatever else the logs hold
  s.fly.logs.lines.push('app[1] [warn]Pilot: ALARM: the pilot tracker reports no capabilities');
  assert.deepEqual(levels(L.evaluate(s), 'ALARM'), ['fail']);
});

test('live-check: pilot writes refused (MIG-1, release v16.1: GET /pilot/v1/info writes_refused) fail, with the reason and the fix; none in a healthy answer', async t => {
  const L = await load(t); if (!L) return;
  assert.deepEqual(levels(L.evaluate(healthy(), {expectMode: 'on'}), 'refused'), []);
  const s = healthy(); s.info = {writes_refused: {code: 'tracker_downgraded', since: '2026-11-12T00:00:00.000Z', reason: 'the tracker reports no capabilities', fix: 'put the tracker v3.2 binary back (docs/DEPLOY-0.4-RUNBOOK.md step 4)'}};
  const r = L.evaluate(s);
  assert.deepEqual(levels(r, 'pilot writes are not refused'), ['fail']);
  assert.match(r.find(x => x.name.includes('refused')).detail, /tracker_downgraded since 2026-11-12.*no capabilities.*step 4/);
});

test('live-check: an unreachable server fails at once', async t => {
  const L = await load(t); if (!L) return;
  const r = L.evaluate({status: {error: 'fetch failed'}, info: {error: 'fetch failed'}});
  assert.deepEqual(r.map(x => x.level), ['fail', 'fail']);
  // The same with the health read gathered (it got no answer either: no route seen, so as before).
  assert.deepEqual(L.evaluate({health: {error: 'fetch failed'}, status: {error: 'fetch failed'}, info: {error: 'fetch failed'}}).map(x => x.level), ['fail', 'fail']);
});

// Fix inbox #64: the network's own health (GET /pilot/v1/health) and its tracker's pin; the legacy desk optional.
const V44 = 'Basis tracker v4.4 (anchored netting): Valun fork commit 321f09ba33a4358eb9af7058f9478cc46ca57e8f (branch circulating-credit-v4 on Basis upstream 43e2173), as the tracker reports itself';
const withHealth = (pin = PIN) => ({...healthy(), health: {ok: true, network: 'valun-pilot-1', tracker: {reachable: true, pin}}});

test('live-check: a server with GET /pilot/v1/health: it must answer; the pin is the network tracker\'s; a desk that does not answer is only a warning', async t => {
  const L = await load(t); if (!L) return;
  const s = withHealth();
  const r = L.evaluate(s, {expectMode: 'on'});
  assert.equal(worst(r), 'ok', JSON.stringify(r, null, 1));
  assert.deepEqual(levels(r, 'GET /pilot/v1/health'), ['ok']);
  // The desk down (503 desk_unavailable, or no answer): a warning, and every other check still runs.
  for (const status of [{error: 'HTTP 503', code: 503}, {error: 'fetch failed'}, undefined]) {
    const d = withHealth(); d.status = status;
    const rd = L.evaluate(d, {expectMode: 'on'});
    assert.deepEqual(levels(rd, 'GET /api/status'), ['warn'], JSON.stringify(status));
    assert.equal(worst(rd), 'warn');
    assert.deepEqual([levels(rd, 'tracker pin'), levels(rd, 'contract'), levels(rd, 'reconciliation'), levels(rd, 'VmRSS')], [['ok'], ['ok'], ['ok'], ['ok']]);
  }
  // The pin read is the network's (GET /pilot/v1/health), not the desk's.
  const p = withHealth(`${PIN} (binary not pinned)`);
  assert.deepEqual(levels(L.evaluate(p), 'pinned'), ['fail'], 'the network tracker is not pinned, whatever the desk says');
  const n = withHealth(V44); n.info.network = 'valun-testnet-1'; n.status.basis.pin = PIN;
  assert.deepEqual(levels(L.evaluate(n, {expectMode: 'on'}), 'tracker pin'), ['ok'], 'the testnet\'s tracker v4.4, read from the network');
  const none = withHealth(null);
  assert.deepEqual(levels(L.evaluate(none), 'pin names tracker v3.2'), ['fail'], 'no capabilities on the network tracker, circulation on');
});

test('live-check: GET /pilot/v1/health 503 (the network\'s tracker does not answer) fails at once; a server from before the route (401 there) is read as before', async t => {
  const L = await load(t); if (!L) return;
  const s = withHealth(); s.health = {error: 'HTTP 503', code: 503};
  const r = L.evaluate(s);
  assert.deepEqual(r.map(x => [x.level, x.name]), [['fail', 'GET /pilot/v1/health (the network\'s tracker answers)']]);
  // Today's testnet answers an unknown pilot route 401: the pin from /api/status, which must answer.
  const old = {...healthy(), health: {error: 'HTTP 401', code: 401}};
  const ro = L.evaluate(old, {expectMode: 'on'});
  assert.equal(worst(ro), 'ok');
  assert.deepEqual(levels(ro, 'GET /pilot/v1/health'), [], 'no health line for a server without the route');
  old.status = {error: 'HTTP 502', code: 502};
  assert.deepEqual(L.evaluate(old).map(x => [x.level, x.name]), [['fail', 'GET /api/status']]);
});

test('live-check --fly: with the trackers\' folders (fix inbox #64) the network\'s tracker must run and the demo tracker\'s absence is a warning; without them, both must run as before', async t => {
  const L = await load(t); if (!L) return;
  const s = healthy(); s.fly.mem.tracker_dirs = ['/data/tracker', '/data/pilot/tracker'];
  const r = L.evaluate(s);
  assert.deepEqual(levels(r, 'the network\'s tracker are running'), ['ok']);
  assert.deepEqual(levels(r, 'demo tracker'), []);
  assert.deepEqual(levels(r, 'both trackers'), []);
  const d = healthy(); d.fly.mem.trackers_kb = [13740]; d.fly.mem.tracker_dirs = ['/data/pilot/tracker'];
  const rd = L.evaluate(d);
  assert.deepEqual([levels(rd, 'the network\'s tracker are running'), levels(rd, 'demo tracker')], [['ok'], ['warn']]);
  assert.match(rd.find(x => x.name.includes('demo tracker')).detail, /503 desk_unavailable until a restart/);
  const p = healthy(); p.fly.mem.trackers_kb = [13024]; p.fly.mem.tracker_dirs = ['/data/tracker'];
  assert.deepEqual(levels(L.evaluate(p), 'the network\'s tracker are running'), ['fail']);
  const a = healthy(); a.fly.mem.app_kb = 0; a.fly.mem.tracker_dirs = ['/data/tracker', '/data/pilot/tracker'];
  assert.deepEqual(levels(L.evaluate(a), 'the network\'s tracker are running'), ['fail'], 'no app');
});
