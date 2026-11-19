// R-7 (the local-readiness audit of Nov 18; fix inbox #145, #155): the limits a local server runs with, and every
// refusal they give.
//
// Every rate_limited 429 carries retry_after_ms (MR-4, SRV-17). The per-minute budgets' refusals (writes and reads per
// client address, writes and reads per token, the loop and agent pages, the A2A front door) said only "too many
// requests; slow down", while the join caps' said how long to wait; an outside harness of many agents had nothing to
// wait on but guesses. Now each says how long until its budget takes a request again (lib/rate-window.mjs). That is a
// change of the hosted answers too, and the only one: their message is the same, and so is when they refuse.
//
// A local server's limits can be set (IMG-2, MR-4, MR-5, COV-8; #145). Through a port Docker publishes, every client on
// the machine comes from one address, so the whole machine got 12 self-serve joins an hour (40 an hour and 200 a day in
// all) and 90 writes a minute, and nothing changed them: a scale test of 25 agents and 1,000 jobs measured the limiter.
// A local server (VALUN_ENVIRONMENT=local) takes a setting for each (lib/pilot/limits.mjs), names the limits it runs with
// in GET /info (`limits`, with the circulation mode, which no field named), and its refusals say which limit refused and
// how to raise it, the join caps' with invites (SRV-17: "its message points to invites", the image's outsider check).
// A hosted server runs the defaults whatever is set, says once that it ignores the settings, and answers as before.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {slidingWindow} from '../lib/rate-window.mjs';
import {Pilot, PilotStore, PILOT_DENOMINATION, SANDBOX_JOIN_LIMITS} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {createA2A} from '../lib/a2a.mjs';
import {DEFAULT_LIMITS, LIMIT_SETTINGS, LIMIT_MAX, A2A_PER_MINUTE, BODY_MAX_BYTES, LOCAL_FLY_IP_IGNORED, limitSettings, changedLimitsLine,
  ignoredLimitsLine} from '../lib/pilot/limits.mjs';
import {fakePilot} from './fixtures/a2a-pilot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// scripts/build-local-docs.mjs and its sources (scripts/local-docs/) are not in the hosted image's copy of the app
// (VALUN_APP_COPY=image: its Dockerfile copies lib/, public/ and test/ and a few scripts): there the tests that use them are
// skipped, with the reason, as test/operations.test.mjs skips one; anywhere else a missing file fails them (needs). So the
// script is loaded only where it is, never as a static import, which would fail this whole file there.
const BUILD_FILES = ['scripts/build-local-docs.mjs', 'scripts/local-docs/skill.md', 'scripts/local-docs/llms.txt', 'scripts/local-docs/start.html'];
const BUILD = path.join(root, 'scripts', 'build-local-docs.mjs');
const B = fs.existsSync(BUILD) ? await import(pathToFileURL(BUILD).href) : null;
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
const GUARD = pathToFileURL(path.join(root, 'test', 'fixtures', 'net-guard.mjs')).href;
const made = [], servers = [], children = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-limits-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// This process's environment without any Valun setting, so a child gets only what a test gives it.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_|FLY_)/.test(k) && k !== 'PORT'));
// Every setting at once, each away from its default (lowered, so a test sees it bite in a few requests).
const SET = Object.freeze({PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS: '3', PILOT_SANDBOX_JOINS_PER_HOUR: '30', PILOT_SANDBOX_JOINS_PER_DAY: '150',
  PILOT_WRITES_PER_MINUTE_PER_ADDRESS: '5', PILOT_WRITES_PER_MINUTE_PER_TOKEN: '70', PILOT_READS_PER_MINUTE_PER_ADDRESS: '1500', PILOT_READS_PER_MINUTE_PER_TOKEN: '300'});

// ---------- the window ----------
test('lib/rate-window.mjs: within the budget 0; over it, how long until the key takes a request again, refused requests counted', t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-11-18T10:00:00Z')});
  const limited = slidingWindow();
  for (let i = 0; i < 3; i++) { assert.equal(limited('a', 3), 0, `request ${i + 1} of 3`); t.mock.timers.tick(1000); }
  // At 3 s the 4th is over, and counts: the window holds 4, so the next is taken once 2 have left it, the requests of
  // 0 s and 1 s: at 61 s, 58 s from now.
  assert.equal(limited('a', 3), 58_000);
  assert.equal(limited('b', 3), 0, 'another key has its own budget');
  // Sent again at once, refused again, and that one counts too: now the request of 2 s must leave as well (62 s).
  assert.equal(limited('a', 3), 59_000);
  // Waiting as long as the last refusal said: taken.
  t.mock.timers.tick(59_000);
  assert.equal(limited('a', 3), 0);
  // Never less than 1000 ms, however close the next free place is: two requests 1 ms apart, a third almost a minute
  // later, whose wait is the second's last 11 ms in the window.
  const two = slidingWindow();
  assert.equal(two('k', 2), 0);
  t.mock.timers.tick(1);
  assert.equal(two('k', 2), 0);
  t.mock.timers.tick(59_989);
  assert.equal(two('k', 2), 1000);
  // Any window: in one of a day, two requests an hour apart are taken, and a third an hour later waits until the second
  // is a day old (the third itself counts).
  const day = slidingWindow({windowMs: 864e5});
  assert.equal(day('k', 2), 0);
  t.mock.timers.tick(3600e3);
  assert.equal(day('k', 2), 0);
  t.mock.timers.tick(3600e3);
  assert.equal(day('k', 2), 864e5 - 3600e3);
});

// ---------- the pilot routes, over HTTP (this process: not a local server) ----------
const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], health: async () => true};
async function listen(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
// A pilot with one invited participant (its owner token works with no agent enrolled) and the routes with `cfg`.
async function network(cfg) {
  const pilot = new Pilot({store: new PilotStore(tmp()), basis, log: () => {}});
  const inv = pilot.createInvite({note: 'limits', maxUses: 1, ttlDays: 1});
  const joined = await pilot.join({invite: inv.code, handle: 'limit-owner', operator: 'the limits test'});
  const base = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: createPilotRoutes({pilot, cfg})}));
  return {pilot, base, owner: joined.owner_token, handle: joined.handle};
}
const send = async (base, method, p, {token, body} = {}) => {
  const r = await fetch(base + p, {method, headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...(body ? {'content-type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return {status: r.status, json, text};
};
// Sends until the first 429 (at most `n` requests) and returns it, with how many were sent.
async function firstRefusal(n, fn) {
  for (let i = 1; i <= n; i++) {
    const r = await fn(i);
    if (r.status === 429) return {...r, at: i};
  }
  assert.fail(`no 429 in ${n} requests`);
}
// A refusal of a per-minute budget, sent within a few seconds of its first counted request: rate_limited, the message
// the hosted servers have always given, and a wait of nearly a minute.
function minuteRefusal(r, what) {
  assert.equal(r.status, 429, what);
  assert.equal(r.json.error, 'rate_limited', what);
  assert.equal(r.json.message, 'too many requests; slow down', `${what}: the hosted message is unchanged`);
  assert.ok(Number.isInteger(r.json.retry_after_ms) && r.json.retry_after_ms > 50_000 && r.json.retry_after_ms <= 60_000,
    `${what}: retry_after_ms ${r.json.retry_after_ms}`);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message', 'retry_after_ms'], `${what}: nothing else changed`);
}

test('every per-minute budget of the pilot routes refuses with retry_after_ms: writes and reads per address and per token, the loop and agent pages', async () => {
  // The hosted defaults: the 91st write a minute from one address.
  const d = await network({});
  const w = await firstRefusal(95, () => send(d.base, 'POST', '/pilot/v1/no-such-write', {body: {}}));
  assert.equal(w.at, 91, 'the 91st write');
  minuteRefusal(w, 'writes per address (90 a minute)');
  // Each budget alone, small (cfg as tests set it), each on routes of its own so that no other budget is spent first.
  const reads = await network({pilotIpReadLimitPerMinute: 3});
  minuteRefusal(await firstRefusal(10, () => send(reads.base, 'GET', '/pilot/v1/participants')), 'reads per address');
  const loop = await network({pilotIpReadLimitPerMinute: 2});
  const lp = await firstRefusal(10, () => send(loop.base, 'GET', '/loop/vs_0000000000000000'));
  minuteRefusal(lp, 'the loop card (the reads per address)');
  const agent = await network({pilotIpReadLimitPerMinute: 2});
  minuteRefusal(await firstRefusal(10, () => send(agent.base, 'GET', `/agent/${agent.handle}`)), 'the agent page (the reads per address)');
  const tokenReads = await network({pilotRateLimitPerMinute: 100, pilotReadLimitPerMinute: 2, pilotIpReadLimitPerMinute: 100});
  minuteRefusal(await firstRefusal(10, () => send(tokenReads.base, 'GET', '/pilot/v1/owner', {token: tokenReads.owner})), 'reads per token');
  const tokenWrites = await network({pilotRateLimitPerMinute: 2, pilotIpWriteLimitPerMinute: 100});
  minuteRefusal(await firstRefusal(10, () => send(tokenWrites.base, 'PUT', '/pilot/v1/owner/mandate', {token: tokenWrites.owner, body: {}})), 'writes per token');
});

test('the A2A front door refuses its 121st request a minute from one address with retry_after_ms', async () => {
  const base = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), a2a: createA2A({pilot: fakePilot()})}));
  const r = await firstRefusal(130, () => send(base, 'GET', '/.well-known/agent-card.json'));
  assert.equal(r.at, 121);
  minuteRefusal(r, 'the A2A front door (120 a minute)');
});

// Every rate_limited refusal the server can give, found in its code: each one names retry_after_ms, so a refusal added
// without one fails here (the join caps' in core.mjs, the budgets' rateLimited and the redemption counts' in
// lib/pilot/http.mjs, the A2A front door's).
test('no rate_limited refusal in lib/ is without retry_after_ms', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mjs') && files.push(path.join(d, e.name)); };
  walk(path.join(root, 'lib'));
  const sites = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/['"]rate_limited['"]/g)) {
      // The statement it is in: up to its end (a semicolon at the end of a line), at most 600 characters.
      const rest = text.slice(m.index, m.index + 600), end = rest.search(/;\s*(\/\/[^\n]*)?\n/);
      sites.push({at: `${path.relative(root, f)}:${text.slice(0, m.index).split('\n').length}`, statement: end < 0 ? rest : rest.slice(0, end)});
    }
  }
  assert.ok(sites.length >= 6, `the refusals found: ${sites.map(s => s.at).join(', ')}`);
  for (const s of sites) assert.match(s.statement, /retry_after_ms/, `${s.at} gives rate_limited without retry_after_ms: ${s.statement.slice(0, 200)}`);
});

// ---------- the settings (lib/pilot/limits.mjs) ----------
test('lib/pilot/limits.mjs: the defaults are the code\'s; a local server takes each setting, and every budget explicitly; a hosted one ignores them and says which; a bad value is an error', () => {
  assert.deepEqual(DEFAULT_LIMITS, {sandbox_joins: {per_address_per_hour: 12, per_hour: 40, per_day: 200},
    writes_per_minute: {per_address: 90, per_token: 90}, reads_per_minute: {per_address: 1800, per_token: 360}});
  assert.deepEqual(DEFAULT_LIMITS.sandbox_joins, SANDBOX_JOIN_LIMITS, 'the Pilot\'s own defaults');
  assert.deepEqual(LIMIT_SETTINGS.map(s => s[0]), Object.keys(SET), 'one setting per limit');
  // Unset: the defaults, everywhere; a local server still gives the routes every budget.
  for (const local of [true, false]) {
    const r = limitSettings({}, {local});
    assert.deepEqual([r.limits, r.joinLimits, r.ignored, r.errors], [DEFAULT_LIMITS, DEFAULT_LIMITS.sandbox_joins, [], []], `local ${local}`);
    assert.deepEqual(r.routeCfg, local ? {pilotIpWriteLimitPerMinute: 90, pilotRateLimitPerMinute: 90, pilotIpReadLimitPerMinute: 1800, pilotReadLimitPerMinute: 360} : {});
    assert.equal(changedLimitsLine(r.limits), null);
  }
  // Every setting, on a local server.
  const l = limitSettings({...SET, PILOT_OTHER: '1'}, {local: true});
  assert.deepEqual(l.limits, {sandbox_joins: {per_address_per_hour: 3, per_hour: 30, per_day: 150},
    writes_per_minute: {per_address: 5, per_token: 70}, reads_per_minute: {per_address: 1500, per_token: 300}});
  assert.deepEqual(l.joinLimits, {per_address_per_hour: 3, per_hour: 30, per_day: 150});
  assert.deepEqual(l.routeCfg, {pilotIpWriteLimitPerMinute: 5, pilotRateLimitPerMinute: 70, pilotIpReadLimitPerMinute: 1500, pilotReadLimitPerMinute: 300});
  assert.deepEqual([l.ignored, l.errors], [[], []]);
  assert.equal(changedLimitsLine(l.limits), 'Pilot: limits: PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS=3 (the default is 12), PILOT_SANDBOX_JOINS_PER_HOUR=30 (the default is 40), '
    + 'PILOT_SANDBOX_JOINS_PER_DAY=150 (the default is 200), PILOT_WRITES_PER_MINUTE_PER_ADDRESS=5 (the default is 90), PILOT_WRITES_PER_MINUTE_PER_TOKEN=70 (the default is 90), '
    + 'PILOT_READS_PER_MINUTE_PER_ADDRESS=1500 (the default is 1800), PILOT_READS_PER_MINUTE_PER_TOKEN=300 (the default is 360); GET /pilot/v1/info gives every limit (limits)');
  // Raised far, for a scale test: up to 1000000.
  assert.equal(limitSettings({PILOT_WRITES_PER_MINUTE_PER_ADDRESS: '1000000'}, {local: true}).limits.writes_per_minute.per_address, 1_000_000);
  // A hosted server: the defaults, every setting named as ignored, bad ones too (it reads none of them).
  const h = limitSettings({...SET, PILOT_READS_PER_MINUTE_PER_TOKEN: 'lots'}, {local: false});
  assert.deepEqual([h.limits, h.joinLimits, h.routeCfg, h.errors], [DEFAULT_LIMITS, DEFAULT_LIMITS.sandbox_joins, {}, []]);
  assert.deepEqual(h.ignored, Object.keys(SET));
  assert.equal(ignoredLimitsLine(['PILOT_WRITES_PER_MINUTE_PER_ADDRESS']), 'Pilot: PILOT_WRITES_PER_MINUTE_PER_ADDRESS: ignored: only a local server (VALUN_ENVIRONMENT=local) takes this setting; this server runs the default limits');
  // Not a whole number from 1 to 1000000: an error each, and that limit keeps its default meanwhile.
  for (const bad of ['0', '-5', '1.5', '1e3', ' 12', 'lots', '1000001', '99999999']) {
    const r = limitSettings({PILOT_SANDBOX_JOINS_PER_DAY: bad}, {local: true});
    assert.deepEqual(r.errors, [`PILOT_SANDBOX_JOINS_PER_DAY=${bad}: a whole number from 1 to 1000000`], bad);
    assert.equal(r.limits.sandbox_joins.per_day, 200, bad);
  }
  assert.deepEqual(limitSettings({PILOT_SANDBOX_JOINS_PER_DAY: ''}, {local: true}).errors, [], 'an empty setting is no setting');
});

test('the Pilot\'s self-serve join caps are its joinLimits: raised, lowered, the defaults for anything that is not a whole number of at least 1; a refusal\'s words name the cap in force', async () => {
  const clock = {t: Date.parse('2026-11-18T10:00:00Z')};
  const make = joinLimits => {
    const p = new Pilot({store: new PilotStore(tmp()), basis, now: () => clock.t, openSandbox: true, log: () => {}, ...(joinLimits ? {joinLimits} : {})});
    p.s.participants.vp_5a5a5a5a5a5a = {id: 'vp_5a5a5a5a5a5a', handle: 'sandbox-exact', operator: 'the operator', status: 'active', created_at: '2026-11-01T00:00:00.000Z'};
    p.sandboxIds = new Set(['vp_5a5a5a5a5a5a']);
    return p;
  };
  let n = 0;
  const joins = async (p, count, addressKey) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(await p.joinSandbox({handle: `cap-${++n}`, operator: 'x'}, {addressKey}).then(() => 201, e => e));
      clock.t += 1000;
    }
    return out;
  };
  assert.deepEqual(make().joinLimits, SANDBOX_JOIN_LIMITS);
  for (const bad of [{per_address_per_hour: 0}, {per_address_per_hour: -1}, {per_address_per_hour: 1.5}, {per_address_per_hour: '20'}, {per_address_per_hour: null}])
    assert.deepEqual(make(bad).joinLimits, SANDBOX_JOIN_LIMITS, JSON.stringify(bad));
  // Raised: 15 from one address, and the 16th refused, its wait from the first of the 15.
  let got = await joins(make({per_address_per_hour: 15}), 16, '203.0.113.7');
  assert.deepEqual(got.slice(0, 15), Array(15).fill(201));
  assert.deepEqual([got[15].code, got[15].status, got[15].message], ['rate_limited', 429, 'at most 15 sandbox joins per hour from one address (an IPv4 address, or an IPv6 /48)']);
  assert.equal(got[15].extra.retry_after_ms, 3600e3 - 15_000);
  // Lowered, the hourly total from all addresses: 2 (callers inside the server count in no hourly cap).
  got = await joins(make({per_hour: 2}), 3, null);
  assert.deepEqual(got, [201, 201, 201], 'callers inside the server count in no hourly cap');
  got = await joins(make({per_hour: 2}), 3, '198.51.100.1');
  assert.deepEqual([got[0], got[1], got[2].code, got[2].message], [201, 201, 'rate_limited', 'the sandbox takes at most 2 new participants an hour from all addresses; try again in 60 min']);
  // Lowered, the 24 hours: 2, whatever the address.
  got = await joins(make({per_day: 2}), 3, null);
  assert.deepEqual([got[0], got[1], got[2].code, got[2].status], [201, 201, 'sandbox_full', 429]);
  assert.match(got[2].message, /^the sandbox takes at most 2 new participants in any 24 hours \(a rolling window, not a calendar day\); the next place frees at \S+, in \d+ min$/);
  assert.equal(got[2].extra.retry_after_ms, 864e5 - 2000, 'when the first of the two is a day old');
});

// One self-serve agent's limits raised by whoever runs the server (docs/LOCAL.md, "Higher limits for one agent": the
// admin route PUT /admin/participants/{vp}/mandate, by 'operator'). Its owner's own mandate changes (PUT /owner/mandate,
// which `config approvals` sends too) are then refused while any field is above the self-serve box, the whole mandate
// being checked (core.mjs setMandate), until one change brings every raised field back (F3 of the branch's review: the
// docs said its owner "can lower the limits again"). As payee, an agent takes at most its max_accept_per_deal.
test('a self-serve agent the operator raised: its owner\'s mandate changes, the approvals mode\'s included, are refused until one brings every raised field back into the box', async () => {
  const p = new Pilot({store: new PilotStore(tmp()), basis, openSandbox: true, openNetwork: true, log: () => {}});
  p.s.participants.vp_5a5a5a5a5a5a = {id: 'vp_5a5a5a5a5a5a', handle: 'sandbox-exact', operator: 'the operator', status: 'active', created_at: '2026-11-01T00:00:00.000Z'};
  p.sandboxIds = new Set(['vp_5a5a5a5a5a5a']);
  const vp = p.s.participants[(await p.joinSandbox({handle: 'raised-one', operator: 'x'})).participant_id];
  const raise = {max_issue_per_deal: 25, max_issue_outstanding: 200, max_accept_per_deal: 25, max_accept_per_issuer: 200};
  assert.equal(p.setMandate(vp, raise, {by: 'operator'}).changed_by, 'operator');
  const refused = body => assert.throws(() => p.setMandate(vp, body), e => e.code === 'sandbox_only' && e.status === 403, JSON.stringify(body));
  refused({approve_above: 0, review_deliveries: true});                    // config approvals console
  refused({approve_above: 25});                                            // config approvals none
  refused({max_issue_per_deal: 10});                                       // lower, but not into the box
  refused({max_issue_per_deal: 5, max_issue_outstanding: 40});             // the payer's side only: the payee's is still raised
  const back = p.setMandate(vp, {max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40});
  assert.deepEqual([back.changed, back.changed_by], [true, 'owner'], 'one change back into the box is taken');
  assert.equal(p.setMandate(vp, {approve_above: 0, review_deliveries: true}).changed, true, 'and then its owner changes it again');
});

// The fixture (test/fixtures/local-limits.mjs), in a process of its own, under the network guard; PORT 8080, as the image
// sets it (a local server's origin is then http://127.0.0.1:8080).
function child(env, steps) {
  const log = path.join(tmp(), 'net-guard.jsonl');
  const r = spawnSync(process.execPath, ['--import', GUARD, path.join(root, 'test', 'fixtures', 'local-limits.mjs'), JSON.stringify(steps)],
    {cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: {...cleanEnv(), NET_GUARD_LOG: log, PORT: '8080', ...env}});
  assert.equal(r.status, 0, `the fixture (${JSON.stringify(env)}): ${r.stderr}`);
  const refused = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind !== 'loaded' && !x.allowed) : [];
  assert.deepEqual(refused, [], 'nothing outside this machine was tried');
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const HOSTED_PER_ADDRESS = 'at most 12 sandbox joins per hour from one address (an IPv4 address, or an IPv6 /48)';

test('a local server: the 13th self-serve join from one address is refused with retry_after_ms and a message that points to invites and to its setting; the write budget\'s refusal names its own', () => {
  const r = child({VALUN_ENVIRONMENT: 'local'}, [{do: 'joins', n: 13}]);
  assert.equal(r.local, true);
  const [j] = r.steps;
  assert.deepEqual(j.statuses, [...Array(12).fill(201), 429]);
  assert.equal(j.refusal.body.error, 'rate_limited');
  assert.ok(Number.isInteger(j.refusal.body.retry_after_ms) && j.refusal.body.retry_after_ms > 3500e3, `retry_after_ms ${j.refusal.body.retry_after_ms}`);
  // Its words say how long to wait, in minutes (valun 0.7.1's join prints only the message: F2 of the branch's review),
  // the minutes being retry_after_ms's, rounded up.
  const min = Math.ceil(j.refusal.body.retry_after_ms / 60e3);
  assert.ok(min === 59 || min === 60, `${min} min`);
  assert.equal(j.refusal.body.message, `${HOSTED_PER_ADDRESS}; try again in ${min} min. Every client on this machine reaches a local server from the same address. For more agents now, whoever runs `
    + 'this server makes an invite inside the container (docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 25 --code-only), which the next agents join with, '
    + 'or starts the server with a higher PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS (docs/LOCAL.md, "Many agents")');
  assert.match(j.refusal.body.message, /invite/i, 'the image\'s outsider check: its message points to invites');
  // The writes: their own budget, named, with its setting (a process of its own: the joins above were writes too).
  const w = child({VALUN_ENVIRONMENT: 'local'}, [{do: 'writes', n: 95}]).steps[0];
  assert.equal(w.at, 91, 'the 91st write a minute from one address');
  assert.equal(w.refusal.body.message, 'too many writes from this address: at most 90 a minute from one address, which every agent and client behind it shares (through a '
    + 'port Docker publishes, every client on this machine comes from one address). Wait retry_after_ms before sending again (refused requests count too), or '
    + 'start this server with a higher PILOT_WRITES_PER_MINUTE_PER_ADDRESS (docs/LOCAL.md, "Many agents")');
  assert.ok(w.refusal.body.retry_after_ms > 50_000 && w.refusal.body.retry_after_ms <= 60_000);
});

test('a local server takes the settings: its join caps and budgets are theirs, and GET /info names every limit it runs with and the circulation mode', () => {
  const r = child({VALUN_ENVIRONMENT: 'local', ...SET}, [{do: 'joins', n: 4}, {do: 'info'}]);
  assert.deepEqual([r.ignored, r.errors], [[], []]);
  const [j, info] = r.steps;
  assert.deepEqual(j.statuses, [201, 201, 201, 429], 'PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS=3');
  assert.match(j.refusal.body.message, /^at most 3 sandbox joins per hour from one address \(an IPv4 address, or an IPv6 \/48\); try again in (59|60) min\. .*a higher PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS /);
  assert.equal(info.status, 200);
  const {note, ...limits} = info.body.limits;
  assert.deepEqual(limits, {sandbox_joins: {per_address_per_hour: 3, per_hour: 30, per_day: 150}, writes_per_minute: {per_address: 5, per_token: 70},
    reads_per_minute: {per_address: 1500, per_token: 300}, a2a_requests_per_minute: {per_address: 120}, request_body_max_bytes: 65536});
  for (const name of Object.keys(SET)) assert.ok(note.includes(name), `the note names ${name}`);
  assert.match(note, /Every client that reaches this server through a port Docker publishes on this machine comes from one address/);
  assert.deepEqual(info.body.circulation, {mode: 'off', requested: 'off'}, 'the fixture runs circulation off');
  // The defaults when nothing is set.
  const d = child({VALUN_ENVIRONMENT: 'local'}, [{do: 'info'}]).steps[0].body;
  assert.deepEqual({...d.limits, note: undefined}, {...DEFAULT_LIMITS, a2a_requests_per_minute: {per_address: 120}, request_body_max_bytes: 65536, note: undefined});
  // The write budget, lowered: the 6th write.
  const w = child({VALUN_ENVIRONMENT: 'local', PILOT_WRITES_PER_MINUTE_PER_ADDRESS: '5'}, [{do: 'writes', n: 10}]).steps[0];
  assert.equal(w.at, 6);
  assert.match(w.refusal.body.message, /^too many writes from this address: at most 5 a minute from one address/);
});

test('a hosted server (no VALUN_ENVIRONMENT, and staging) given every setting runs the defaults, names them ignored, and answers as before: no limits in /info, the 13th join\'s refusal and the 91st write\'s word for word', () => {
  for (const environment of [null, 'staging']) {
    const env = environment ? {VALUN_ENVIRONMENT: environment} : {};
    const r = child({...env, ...SET}, [{do: 'joins', n: 13}, {do: 'info'}]);
    assert.equal(r.local, false);
    assert.deepEqual(r.ignored, Object.keys(SET), environment);
    const [j, info] = r.steps;
    assert.deepEqual(j.statuses, [...Array(12).fill(201), 429], `${environment}: 12 an hour from one address, as always`);
    assert.deepEqual(Object.keys(j.refusal.body).sort(), ['error', 'message', 'retry_after_ms']);
    assert.equal(j.refusal.body.message, HOSTED_PER_ADDRESS, `${environment}: the words as before`);
    assert.ok(!('limits' in info.body) && !('circulation' in info.body), `${environment}: /info as before`);
    // The same /info as with no setting at all.
    assert.deepEqual(child(env, [{do: 'info'}]).steps[0].body, info.body, `${environment}: the settings change nothing in /info`);
    const w = child({...env, ...SET}, [{do: 'writes', n: 95}]).steps[0];
    assert.equal(w.at, 91, `${environment}: the 91st write`);
    assert.deepEqual(w.refusal.body, {error: 'rate_limited', message: 'too many requests; slow down', retry_after_ms: w.refusal.body.retry_after_ms});
  }
});

// ---------- server.mjs reads them ----------
// server.mjs as a process over a stub tracker (as test/local-start.unit.test.mjs runs it: no tracker binary, no signer,
// no sandbox agents), under the network guard.
async function stubTracker() {
  const s = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end('Basis Tracker (stub)'); }
    if (req.url === '/notes') return json(200, {success: true, data: []});
    if (req.url === '/tracker/state') return json(200, {success: true, data: {local_digest: 'd'.repeat(64), confirmed_digest: null}});
    return json(404, {success: false, error: 'not found'});
  });
  servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const {port} = s.address();
  await new Promise(r => s.close(r));
  return port;
}
// Starts server.mjs with `env`; resolves once it listens (or has exited: `exited` then holds its code).
async function startServer(env) {
  const port = await freePort(), data = tmp(), log = path.join(data, 'net-guard.jsonl');
  const child = spawn(process.execPath, ['--import', GUARD, path.join(root, 'server.mjs')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {...cleanEnv(), NET_GUARD_LOG: log, HOST: '127.0.0.1', PORT: String(port), VALUN_DATA_DIR: path.join(data, 'valun'), PILOT_DATA_DIR: path.join(data, 'pilot'),
      PILOT_SANDBOX: '0', VALUN_SEED: '0', PILOT_TRACKER_URL: await stubTracker(), PILOT_TRACKER_NFT_ID: 'b'.repeat(64), ...env}});
  children.push(child);
  const s = {child, port, base: `http://127.0.0.1:${port}`, out: '', err: '', exited: null,
    refused: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind !== 'loaded' && !x.allowed) : [])};
  child.stdout.on('data', d => { s.out += d; }); child.stderr.on('data', d => { s.err += d; });
  const done = new Promise(r => child.on('exit', code => { s.exited = code; r(); }));
  const end = Date.now() + 20_000;
  for (;;) {
    if (s.exited !== null) return s;
    if (/^Valun \(/m.test(s.out) && await fetch(`${s.base}/pilot/v1/health`).then(r => r.status === 200, () => false)) return s;
    if (Date.now() > end) assert.fail(`server.mjs did not listen: ${s.out.slice(-400)} ${s.err.slice(-400)}`);
    await Promise.race([done, sleep(100)]);
  }
}
const post = (base, p, headers = {}) => fetch(base + p, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: '{}'})
  .then(async r => ({status: r.status, body: await r.json()}));

test('server.mjs: a local server says which limits its settings changed, runs them and names them in /info; a bad setting stops it before it listens; a hosted one says once which it ignores, and runs the defaults', async () => {
  // VALUN_BUILD_SHA as the local entrypoint gives it, from the image's revision (IMG-12: GET /info named no build).
  const build = 'c0ffee'.repeat(6) + 'c0ff';
  const l = await startServer({VALUN_ENVIRONMENT: 'local', VALUN_BUILD_SHA: build, ...SET});
  assert.equal(l.exited, null, l.err);
  assert.ok(l.out.split('\n').includes(changedLimitsLine(limitSettings(SET, {local: true}).limits)), `the line that says what changed: ${l.out}`);
  const info = await fetch(`${l.base}/pilot/v1/info`).then(r => r.json());
  assert.equal(info.build, build, 'the build the image records');
  assert.deepEqual({...info.limits, note: undefined}, {...limitSettings(SET, {local: true}).limits, a2a_requests_per_minute: {per_address: 120}, request_body_max_bytes: 65536, note: undefined});
  assert.deepEqual(info.circulation, {mode: 'off', requested: 'off'});
  let w;
  for (let i = 1; i <= 6; i++) w = await post(l.base, '/pilot/v1/no-such-write');
  assert.equal(w.status, 429, 'PILOT_WRITES_PER_MINUTE_PER_ADDRESS=5: the 6th write');
  assert.match(w.body.message, /^too many writes from this address: at most 5 a minute .* a higher PILOT_WRITES_PER_MINUTE_PER_ADDRESS /);
  assert.deepEqual(l.refused(), []);
  l.child.kill();
  // A bad value: it stops before it listens, and says which and why.
  const bad = await startServer({VALUN_ENVIRONMENT: 'local', PILOT_SANDBOX_JOINS_PER_DAY: 'lots'});
  assert.equal(bad.exited, 1);
  assert.match(bad.err, /^Limits: PILOT_SANDBOX_JOINS_PER_DAY=lots: a whole number from 1 to 1000000$/m);
  assert.doesNotMatch(bad.out, /^Valun \(/m, 'it never listened');
  // A hosted server given every setting: one line on stderr, the defaults, /info without them.
  const h = await startServer({...SET});
  assert.equal(h.exited, null, h.err);
  assert.equal(h.err.split('\n').filter(x => x.includes('ignored: only a local server')).join('\n'), ignoredLimitsLine(Object.keys(SET)));
  assert.doesNotMatch(h.out, /^Pilot: limits:/m);
  const hinfo = await fetch(`${h.base}/pilot/v1/info`).then(r => r.json());
  assert.ok(!('limits' in hinfo) && !('circulation' in hinfo));
  for (let i = 1; i <= 91; i++) w = await post(h.base, '/pilot/v1/no-such-write');
  assert.deepEqual([w.status, w.body.message], [429, 'too many requests; slow down'], 'the 91st write, as always');
  assert.deepEqual(h.refused(), []);
  h.child.kill();
});

// VALUN_TRUST_FLY_CLIENT_IP=1, the hosted servers' setting on Fly, keys every per-address limit on the Fly-Client-IP header
// a client sends. On a local server that let any client that reached the port pick its own address, and so budgets of
// its own (the local-readiness audit: IMG-2). A local server ignores it, and says so; the local entrypoint never passes
// it on (test/local-mode.unit.test.mjs). A hosted server keys on the header as before.
test('server.mjs: a local server ignores VALUN_TRUST_FLY_CLIENT_IP, and says so: clients that name other addresses still share theirs; a hosted one keys on the header as before', async () => {
  const ip = i => ({'fly-client-ip': `198.51.100.${i}`});
  const l = await startServer({VALUN_ENVIRONMENT: 'local', VALUN_TRUST_FLY_CLIENT_IP: '1', PILOT_WRITES_PER_MINUTE_PER_ADDRESS: '3'});
  assert.ok(l.err.split('\n').includes(LOCAL_FLY_IP_IGNORED), l.err);
  const got = [];
  for (let i = 1; i <= 4; i++) got.push((await post(l.base, '/pilot/v1/no-such-write', ip(i))).status);
  assert.deepEqual(got, [401, 401, 401, 429], 'four addresses named, one budget of 3');
  l.child.kill();
  const h = await startServer({VALUN_TRUST_FLY_CLIENT_IP: '1'});
  assert.ok(!h.err.includes('VALUN_TRUST_FLY_CLIENT_IP'), 'nothing said');
  const named = [];
  for (let i = 1; i <= 95; i++) named.push((await post(h.base, '/pilot/v1/no-such-write', ip(i))).status);
  assert.ok(!named.includes(429), 'each address named has its own budget, as on Fly');
  let w;
  for (let i = 1; i <= 91; i++) w = await post(h.base, '/pilot/v1/no-such-write', ip(250));
  assert.equal(w.status, 429, 'the 91st from one address named');
  h.child.kill();
});

// ---------- admin from outside the container (IMG-6) ----------
// Admin (invites, the clearing engine) answers only on the server's own loopback, with the admin token from its data
// folder. A harness on the host reaches a local server through the published port, from the bridge's address, and got
// 404 not_found, as for an unknown route, with no hint that admin runs with docker exec. A local server now answers such
// a call, and one through a proxy or without the token, with a 403 that says so. Elsewhere it is 404 as before. Another
// address of 127.0.0.0/8 stands in for the bridge's: the server takes only 127.0.0.1 and ::1 as its loopback.
test('a local server answers an admin call from anywhere but its loopback, through a proxy, or without the token, with a 403 that says to run it with docker exec; elsewhere 404 as before', () => {
  const calls = [{do: 'admin', from: '127.0.0.1', token: true}, {do: 'admin', from: '127.0.0.2', token: true},
    {do: 'admin', from: '127.0.0.1', token: true, headers: {'x-forwarded-for': '203.0.113.9'}}, {do: 'admin', from: '127.0.0.1', token: true, headers: {'fly-client-ip': '203.0.113.9'}},
    {do: 'admin', from: '127.0.0.1', token: false}, {do: 'admin', from: '127.0.0.2', token: false}];
  const local = child({VALUN_ENVIRONMENT: 'local'}, calls).steps;
  assert.equal(local[0].status, 201, 'from its loopback with the token: the invite');
  assert.match(local[0].body.code, /^vpi_/);
  const exec = 'docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 25 --code-only (or invites, clearing status --json, clearing run; CONTAINER is the name '
    + 'docker ps shows, or the one docker run --name gave it)';
  const loopbackOnly = {error: 'admin_loopback_only', message: 'Admin routes answer only on this server\'s own loopback, inside its container, with the admin token in '
    + `its data folder (/data/pilot/admin-token in the local image), never through the published port. Run them with docker exec: ${exec}. Nothing was done.`};
  for (const i of [1, 2, 3, 5]) assert.deepEqual([local[i].status, local[i].body], [403, loopbackOnly], JSON.stringify(calls[i]));
  assert.deepEqual([local[4].status, local[4].body], [403, {error: 'admin_token_required', message: 'Admin routes need the admin token from this server\'s data folder '
    + `(/data/pilot/admin-token in the local image) in the X-Valun-Admin header. scripts/pilot-admin.mjs reads it and sends it: ${exec}. Nothing was done.`}]);
  for (const environment of [null, 'staging']) {
    const hosted = child(environment ? {VALUN_ENVIRONMENT: environment} : {}, calls).steps;
    assert.equal(hosted[0].status, 201, `${environment}: from its loopback with the token`);
    for (const i of [1, 2, 3, 4, 5]) assert.deepEqual([hosted[i].status, hosted[i].body], [404, {error: 'not_found', message: 'not found'}], `${environment}: ${JSON.stringify(calls[i])}`);
  }
});

// The invite command a local server gives (fix inbox #155: the review of local/readiness-r1, FH-4 and F8). valun 0.7.1's
// join --invite-from-stdin sends the whole first line it reads as the code, and pilot-admin's invite without --code-only
// prints a line around the code ("invite inv_...: vpi_...  (expires ...)"), which the server refuses as invalid_invite:
// the docs give --code-only (R-3), and so must the server, in the 13th join's refusal (where an outsider first meets
// invites), the admin refusals, its pages and the local image. Every such command in lib/ and public/ (what the server
// says and serves) and in Dockerfile.local prints only the code.
const INVITE_COMMAND = /pilot-admin\.mjs invite\b(?!s)[^`\n|<)'"]*/g;
test('every invite command a local server gives, in its refusals, its pages, its docs and its image, prints only the code (--code-only)', () => {
  const walk = d => fs.readdirSync(path.join(root, d), {withFileTypes: true}).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name))
    : /\.(mjs|js|html|md|txt)$/.test(e.name) ? [path.join(d, e.name)] : []));
  const files = [...walk('lib'), ...walk('public')];
  // The local image's own file (not in the hosted image's copy of the app, where only lib/ and public/ are checked).
  if (fs.existsSync(path.join(root, 'Dockerfile.local'))) files.push('Dockerfile.local');
  else if (process.env.VALUN_APP_COPY !== 'image') assert.fail('missing Dockerfile.local');
  const found = files.flatMap(f => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(INVITE_COMMAND)].map(m => [f, m[0]]));
  for (const [f, cmd] of found) assert.match(cmd, /--code-only/, `${f}: ${cmd}`);
  const where = new Set(found.map(([f]) => f.replace(/\\/g, '/')));
  for (const f of ['lib/pilot/core.mjs', 'lib/pilot/http.mjs', 'lib/local-pages.mjs', 'public/start-local.html', 'public/skill-local.md']) assert.ok(where.has(f), `${f} gives an invite command`);
  // The check sees one without --code-only.
  assert.doesNotMatch('(docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 25), which'.match(INVITE_COMMAND)[0], /--code-only/);
});

// ---------- writes from a page of another site (IMG-13) ----------
// A local server published on 127.0.0.1 is reachable from the web pages a browser on the machine opens. /pilot/v1 read
// any Content-Type and checked no Host: a page could send a simple text/plain POST to /pilot/v1/join-sandbox (no
// preflight) and make participants, using up the machine's joins (the audit's probe: 201, with Origin
// https://evil.example and Host evil.example:8080), and a page that a DNS name rebound to the server could act on its
// answers. A local server now refuses such a write before anything else, budgets included; its own clients' writes go
// through. Elsewhere writes are taken as before.
let pageJoins = 0;
const write = (headers, body = JSON.stringify({handle: `page-made-${++pageJoins}`, operator: 'a page'}), p = '/pilot/v1/join-sandbox') => ({do: 'write', path: p, headers, body});
test('a local server refuses a write sent for another host, from a page of another site, or with a body that is not JSON, before it spends any budget; its own clients\' writes go through; elsewhere as before', () => {
  const json = {'content-type': 'application/json'};
  const bad = [write({host: 'evil.example:8080', ...json}), write({host: 'rebound.example', ...json}), write({...json, host: '127.0.0.1:8080', origin: 'https://evil.example'}),
    write({host: '127.0.0.1:8080', origin: 'null', ...json}), write({host: '127.0.0.1:8080', 'content-type': 'text/plain'}),
    write({host: '127.0.0.1:8080', 'content-type': 'application/x-www-form-urlencoded'}), write({host: '127.0.0.1:8080'}),
    write({host: '127.0.0.1:8080', origin: 'https://evil.example', 'content-type': 'text/plain'})];
  const local = child({VALUN_ENVIRONMENT: 'local', PILOT_WRITES_PER_MINUTE_PER_ADDRESS: '3'}, [...bad, {do: 'count'},
    // Its own clients: valun (Host 127.0.0.1:PORT, JSON, no Origin), another loopback name, its own pages (an Origin of its
    // own), a write with no body and no type (a token's revoke, say: 401 here, as there is no token), within the budget
    // the refused writes did not spend (3 a minute).
    write({host: '127.0.0.1:8080', ...json}), write({host: 'localhost:9000', origin: 'http://localhost:9000', ...json}),
    write({host: '[::1]:8080', origin: 'http://127.0.0.1:8080', ...json}), {do: 'count'}, write({host: '127.0.0.1:8080'}, '', '/pilot/v1/owner/revoke-agent')]).steps;
  const codes = local.slice(0, bad.length).map(r => [r.status, r.body.error]);
  assert.deepEqual(codes, [[403, 'host_not_allowed'], [403, 'host_not_allowed'], [403, 'cross_origin'], [403, 'cross_origin'], [415, 'json_required'], [415, 'json_required'],
    [415, 'json_required'], [403, 'cross_origin']]);
  assert.equal(local[0].body.message, 'this local server takes writes only for its own origin, http://127.0.0.1:8080, or a loopback name (127.0.0.1, localhost or [::1], '
    + 'any port), and this one was sent for "evil.example:8080". From this machine, use one of those; from another container, run it in this server\'s network namespace '
    + '(docker run --network container:CONTAINER ...), where 127.0.0.1 is this server. Nothing was done.');
  assert.equal(local[2].body.message, 'a page of another site (Origin "https://evil.example") cannot write to this local server: only its own pages, at '
    + 'http://127.0.0.1:8080 or a loopback name, and clients that send no Origin (valun, scripts) can. Nothing was done.');
  assert.equal(local[4].body.message, 'a write to this local server sends its body as JSON, with Content-Type: application/json; this one was sent as "text/plain". Nothing was done.');
  const [before, ...ok] = local.slice(bad.length);
  assert.deepEqual([ok[0].status, ok[1].status, ok[2].status], [201, 201, 201], 'valun\'s writes, another loopback name\'s and the server\'s own page\'s, within the budget');
  assert.equal(ok[3].participants, before.participants + 3, 'only these made participants');
  assert.deepEqual([ok[4].status, ok[4].body.error], [429, 'rate_limited'], 'the 4th write the budget counts: the refused ones before were not counted');
  // Its own origin, named by VALUN_PUBLIC_ORIGIN (an https proxy in front of it, say): that Host and Origin are its own;
  // the same name on another port is not.
  const named = child({VALUN_ENVIRONMENT: 'local', VALUN_PUBLIC_ORIGIN: 'https://valun-local.example'}, [write({host: 'valun-local.example', origin: 'https://valun-local.example', ...json}),
    write({host: 'valun-local.example:8443', ...json}), write({host: '127.0.0.1:8080', origin: 'http://valun-local.example', ...json})]).steps;
  assert.deepEqual(named.map(r => [r.status, r.body.error ?? null]), [[201, null], [403, 'host_not_allowed'], [403, 'cross_origin']]);
  // A write with no body needs no type (and is refused only by the route: no token).
  const bodiless = child({VALUN_ENVIRONMENT: 'local'}, [write({host: '127.0.0.1:8080'}, '', '/pilot/v1/owner/revoke-agent')]).steps[0];
  assert.deepEqual([bodiless.status, bodiless.body.error], [401, 'unauthorized']);
  // A hosted server takes the same writes as before: each of these joins.
  for (const environment of [null, 'staging']) {
    const hosted = child(environment ? {VALUN_ENVIRONMENT: environment} : {}, bad.map((s, i) => ({...s, body: JSON.stringify({handle: `page-made-${i}`, operator: 'a page'})}))).steps;
    assert.deepEqual(hosted.map(r => r.status), Array(bad.length).fill(201), `${environment}: as before`);
  }
});

// ---------- the docs state the code's numbers ----------
// docs/LOCAL.md, the README, the local skill (public/skill-local.md, as the server serves it; its numbers are rendered from
// the code by scripts/build-local-docs.mjs) and docs/PILOT-API.md: each limit they state is the code's, each sentence that
// states one is there, and every number they write as a limit (N ... a minute, an hour, in any 24 hours) is one of the
// limits, so a number that drifts from the code, or a new one with none behind it, fails here (COV-8: the write budget
// every agent on a machine shares was stated nowhere, and LOCAL.md gave 12 joins an hour only).
const doc = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const flat = s => s.replace(/\s+/g, ' ');
const comma = n => n.toLocaleString('en-US');
const L = DEFAULT_LIMITS, J = L.sandbox_joins, W = L.writes_per_minute, R = L.reads_per_minute;
const LIMIT_VALUES = new Set([J.per_address_per_hour, J.per_hour, J.per_day, W.per_address, W.per_token, R.per_address, R.per_token, A2A_PER_MINUTE]);

test('every limit docs/LOCAL.md, the README, the local skill and PILOT-API.md state is the code\'s: the join caps, the budgets per address and per token, the A2A front door\'s, the settings and their range', t => {
  if (!needs(t, ...BUILD_FILES, 'docs/LOCAL.md', 'README.md', 'docs/PILOT-API.md')) return;
  const local = flat(doc('docs/LOCAL.md')), readme = flat(doc('README.md')), skill = flat(doc('public/skill-local.md')), api = flat(doc('docs/PILOT-API.md'));
  const has = (text, name, sentence) => assert.ok(text.includes(sentence), `${name} states: ${sentence}`);
  has(local, 'LOCAL.md', `The server allows ${J.per_address_per_hour} self-serve joins an hour from one address (${J.per_hour} an hour and ${J.per_day} in any 24 hours `
    + `from all addresses together), and ${W.per_address} writes a minute (every request but \`GET\` and \`HEAD\`) and ${comma(R.per_address)} reads a minute from one address`);
  has(local, 'LOCAL.md', `Each token also has ${W.per_token} writes and ${R.per_token} reads a minute, and the A2A front door takes ${A2A_PER_MINUTE} requests a minute from one address`);
  has(local, 'LOCAL.md', '`429 rate_limited` (`429 sandbox_full` for the 24 hours) with `retry_after_ms`');
  has(local, 'LOCAL.md', `each a whole number from 1 to ${LIMIT_MAX}`);
  has(local, 'LOCAL.md', `a self-serve join is limited to ${J.per_address_per_hour} an hour from one address`);
  has(readme, 'the README', `they share its limits: ${J.per_address_per_hour} self-serve joins an hour (${J.per_hour} an hour and ${J.per_day} in any 24 hours from all `
    + `addresses), and ${W.per_address} writes and ${comma(R.per_address)} reads a minute (each token also has ${W.per_token} writes and ${R.per_token} reads a minute)`);
  has(readme, 'the README', `self-serve joins an hour from one address (${J.per_address_per_hour} by default), an hour from all addresses (${J.per_hour}) and in any 24 hours `
    + `(${J.per_day}); writes a minute per client address (${W.per_address}) and per token (${W.per_token}); reads a minute per client address (${R.per_address}) and `
    + `per token (${R.per_token}). Each a whole number from 1 to ${LIMIT_MAX}`);
  has(skill, 'skill-local.md', `limited to ${J.per_address_per_hour} an hour from one address (${J.per_hour} an hour and ${J.per_day} in any 24 hours from all addresses)`);
  has(skill, 'skill-local.md', `from one address ${W.per_address} writes and ${R.per_address} reads a minute, which every agent on this machine shares, and per token `
    + `${W.per_token} writes and ${R.per_token} reads a minute`);
  has(api, 'PILOT-API.md', `${W.per_address} writes per minute per client address`);
  has(api, 'PILOT-API.md', `${R.per_token} reads per minute per token`);
  has(api, 'PILOT-API.md', `${comma(R.per_address)} a minute, which the agents and viewers behind one address share`);
  has(api, 'PILOT-API.md', `${A2A_PER_MINUTE} requests a minute per client address`);
  has(api, 'PILOT-API.md', `by default ${J.per_address_per_hour}, ${J.per_hour} and ${J.per_day}; ${W.per_address} and ${W.per_token}; ${R.per_address} and ${R.per_token}; `
    + `${A2A_PER_MINUTE}; ${BODY_MAX_BYTES}`);
  // The skill's numbers are rendered from these (scripts/build-local-docs.mjs facts).
  const f = B.facts();
  assert.deepEqual([f.joins_hour_address, f.joins_hour_total, f.joins_day, f.writes_minute_address, f.reads_minute_address, f.writes_minute_token, f.reads_minute_token],
    [J.per_address_per_hour, J.per_hour, J.per_day, W.per_address, R.per_address, W.per_token, R.per_token]);
  // Every setting is named where the settings are given.
  for (const [name] of LIMIT_SETTINGS) for (const [text, where] of [[local, 'LOCAL.md'], [readme, 'the README'], [api, 'PILOT-API.md']]) assert.ok(text.includes(name), `${where} names ${name}`);
  // Every number written as a limit is one.
  for (const [text, where] of [[local, 'LOCAL.md'], [readme, 'the README'], [skill, 'skill-local.md']]) {
    const found = [...text.matchAll(/(\d[\d,]*) (?:self-serve joins |writes |reads |requests |new participants )?(?:a minute|an hour|in any 24 hours)/g)].map(m => Number(m[1].replace(/,/g, '')));
    assert.ok(found.length >= 5, `${where}: the limits found: ${found}`);
    for (const n of found) assert.ok(LIMIT_VALUES.has(n), `${where} writes ${n} as a limit, which none of the code's is`);
  }
});
