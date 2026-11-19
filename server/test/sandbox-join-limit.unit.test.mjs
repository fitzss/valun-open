// The per-address limit on self-serve sandbox joins (fix inbox #21). A tester made 15 joins from one IPv4 address in four
// minutes: the count lived in the server's memory, and a deploy in the middle started it again from zero. The count now
// lives in the state, as keyed hashes of the address, so it survives a restart; no address is stored. No tracker.
// The hourly total from all addresses (fix inbox #21, reopened): one host's egress rotated across about 10 IPv6 /48s,
// each with its own per-address allowance, so only a total over every address bounds one host.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pilot, PilotStore, PILOT_DENOMINATION, SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, SANDBOX_JOINS_PER_HOUR_TOTAL} from '../lib/pilot/core.mjs';
import {SANDBOX_JOINS_PER_HOUR_PER_ADDRESS as FROM_HTTP, SANDBOX_JOINS_PER_HOUR_TOTAL as TOTAL_FROM_HTTP} from '../lib/pilot/http.mjs';

const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => []};
const A = '203.0.113.7', B = '2001:db8:1::/48';
const SANDBOX = {id: 'vp_5a5a5a5a5a5a', handle: 'sandbox-exact', operator: 'the operator', status: 'active', created_at: '2026-11-01T00:00:00.000Z'};

// A server on `dir` (a new one starts as a restart does: a new store and a new Pilot reading the same files).
function server(dir, clock) {
  const p = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, openSandbox: true, log: () => {}});
  p.s.participants[SANDBOX.id] ??= {...SANDBOX};
  p.sandboxIds = new Set([SANDBOX.id]);
  return p;
}
let n = 0;
const join = (p, addressKey, handle = `burst-${++n}`) => p.joinSandbox({handle, operator: 'x'}, {addressKey});
const refusal = async (promise) => {
  try { await promise; } catch (e) { return e; }
  assert.fail('the join was not refused');
};

test('the limit is the one the HTTP layer names: 12', () => {
  assert.equal(SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, 12);
  assert.equal(FROM_HTTP, 12);
});

test('the 13th join within an hour from one address is refused, and a restart does not reset the count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const clock = {t: Date.parse('2026-11-14T10:00:00Z')};
  let p = server(dir, clock);
  for (let i = 0; i < 12; i++) { await join(p, A); clock.t += 1000; }
  let e = await refusal(join(p, A));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  assert.equal(e.message, 'at most 12 sandbox joins per hour from one address (an IPv4 address, or an IPv6 /48)');
  // The oldest of the 12 stops counting an hour after it was made: 12 s have passed since.
  assert.equal(e.extra.retry_after_ms, 3600e3 - 12_000);
  // Another address is not affected.
  await join(p, B);

  // A restart (the deploy in the tester's run): the new process reads the count from the state.
  clock.t += 60_000;
  p = server(dir, clock);
  e = await refusal(join(p, A));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.extra.retry_after_ms, 3600e3 - 72_000);
  await join(p, B);

  // An hour after the first join, its slot is free again (only that one: the next frees a second later).
  clock.t = Date.parse('2026-11-14T11:00:00Z');
  await join(p, A);
  e = await refusal(join(p, A));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.extra.retry_after_ms, 1000);
});

test('joins at the same moment count each other: 13 at once from one address, 12 joined', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const p = server(dir, {t: Date.parse('2026-11-14T10:00:00Z')});
  const before = Object.keys(p.s.participants).length;
  const done = await Promise.allSettled(Array.from({length: 13}, () => join(p, A)));
  assert.equal(done.filter(r => r.status === 'fulfilled').length, 12);
  const refused = done.filter(r => r.status === 'rejected');
  assert.deepEqual(refused.map(r => r.reason.code), ['rate_limited']);
  // Refused before it made anything: 12 participants, not 13.
  assert.equal(Object.keys(p.s.participants).length - before, 12);
});

test('a refused join does not count against the address, and leaves no invite behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const clock = {t: Date.parse('2026-11-14T10:00:00Z')};
  const p = server(dir, clock);
  await join(p, A, 'taken-name');
  const invites = Object.keys(p.s.invites).length;
  for (let i = 0; i < 20; i++) {
    const e = await refusal(join(p, A, i % 2 ? 'taken-name' : 'x'));   // a taken handle, a handle too short
    assert.ok(['handle_taken', 'invalid_field'].includes(e.code), e.code);
  }
  assert.equal(Object.keys(p.s.invites).length, invites, 'a refused join left its invite in the state');
  assert.equal(p.s.sandbox_joins.length, 1);
  for (let i = 0; i < 11; i++) await join(p, A);                    // the 11 joins left after the one that happened
  assert.equal((await refusal(join(p, A))).code, 'rate_limited');
});

test('the state holds no address: keyed hashes and times only, the key in its own file, records gone after the hour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const clock = {t: Date.parse('2026-11-14T10:00:00Z')};
  const p = server(dir, clock);
  await join(p, A); await join(p, B);
  const text = fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8');
  for (const s of [A, '203.0.113', B, '2001:db8']) assert.ok(!text.includes(s), `the state holds ${s}`);
  const key = fs.readFileSync(path.join(dir, 'sandbox-join-key'), 'utf8').trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!text.includes(key), 'the state holds the key');
  const records = JSON.parse(text).sandbox_joins;
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.deepEqual(Object.keys(r).sort(), ['at', 'k']);
    assert.match(r.k, /^[0-9a-f]{32}$/);
  }
  assert.notEqual(records[0].k, records[1].k);
  // Another server's key gives another hash for the same address: the hashes cannot be compared across servers.
  const other = server(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-')), clock);
  await join(other, A);
  assert.notEqual(other.s.sandbox_joins[0].k, records[0].k);
  // The first save after the hour drops the records.
  clock.t += 3600e3;
  p.save();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8')).sandbox_joins, undefined);
});

test('callers inside the server (no address) are not limited per address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const p = server(dir, {t: Date.parse('2026-11-14T10:00:00Z')});
  for (let i = 0; i < 13; i++) await p.joinSandbox({handle: `inside-${i}`, operator: 'x'});
  assert.equal(p.s.sandbox_joins, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'sandbox-join-key')), 'the key is made on the first limited join only');
});

// ---------- the hourly total from all addresses ----------
const net = i => `2001:db8:${i}::/48`;

test('the hourly total from all addresses is the one the HTTP layer names: 40', () => {
  assert.equal(SANDBOX_JOINS_PER_HOUR_TOTAL, 40);
  assert.equal(TOTAL_FROM_HTTP, 40);
});

test('one host rotating across ten /48s: the 41st join within an hour from all addresses is refused, a restart does not reset the count, and the oldest join frees the next slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const clock = {t: Date.parse('2026-11-14T10:00:00Z')};
  let p = server(dir, clock);
  for (let i = 0; i < 40; i++) { await join(p, net(i % 10)); clock.t += 1000; }   // 4 from each of ten /48s: each far under its 12
  let e = await refusal(join(p, net(10)));                                         // an eleventh /48, never seen before
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  // The oldest of the 40 stops counting an hour after it was made: 40 s have passed since.
  assert.equal(e.extra.retry_after_ms, 3600e3 - 40_000);
  assert.equal(e.message, 'the sandbox takes at most 40 new participants an hour from all addresses; try again in 60 min');
  assert.equal(p.s.sandbox_joins.length, 40, 'the refused join recorded nothing');

  // A restart: the new process reads the count from the state.
  clock.t += 60_000;
  p = server(dir, clock);
  e = await refusal(join(p, net(11)));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.extra.retry_after_ms, 3600e3 - 100_000);
  assert.match(e.message, /; try again in 59 min$/);

  // An hour after the first join its slot is free again (only that one: the next frees a second later).
  clock.t = Date.parse('2026-11-14T11:00:00Z');
  await join(p, net(12));
  e = await refusal(join(p, net(13)));
  assert.equal(e.extra.retry_after_ms, 1000);
  assert.match(e.message, /; try again in 1 min$/);
});

test('the hourly total is checked before the per-address limit, and the server\'s own joins (no address) are not counted in it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const p = server(dir, {t: Date.parse('2026-11-14T10:00:00Z')});
  for (let i = 0; i < 12; i++) await join(p, A);                                 // A has used its 12
  for (let i = 0; i < 28; i++) await join(p, net(i));                            // 40 from all addresses
  const e = await refusal(join(p, A));
  assert.equal(e.message, 'the sandbox takes at most 40 new participants an hour from all addresses; try again in 60 min');
  assert.equal(e.extra.retry_after_ms, 3600e3);
  await p.joinSandbox({handle: 'inside-after-total', operator: 'x'});
  assert.equal(p.s.sandbox_joins.length, 40);
});

test('joins at the same moment count each other in the total: 41 at once from 41 addresses, 40 joined', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-join-limit-'));
  const p = server(dir, {t: Date.parse('2026-11-14T10:00:00Z')});
  const before = Object.keys(p.s.participants).length;
  const done = await Promise.allSettled(Array.from({length: 41}, (_, i) => join(p, net(i))));
  assert.equal(done.filter(r => r.status === 'fulfilled').length, 40);
  assert.deepEqual(done.filter(r => r.status === 'rejected').map(r => r.reason.code), ['rate_limited']);
  assert.equal(Object.keys(p.s.participants).length - before, 40);
});

// The 24-hour cap (SANDBOX_JOINS_PER_DAY, 200 on every hosted server) counts the self-serve participants made in the last
// 24 hours. The refusal says when the next place frees: when enough of them have left the window that one more fits,
// 24 hours after the (n - 200 + 1)th oldest. With 200 in the window that is the oldest one's 24 hours, as before. A
// window that holds more (as this test fills it, or once a cap is lowered) frees later: an earlier answer named the
// oldest one's 24 hours whatever the window held, which is too early then, and a join at that time is refused again. So
// with more than 200 in the window the hosted answer (retry_after_ms, resets_at and the time and minutes in the
// message) changes, by design (the review of local/readiness-r1, HI-1).
test('the 24-hour cap names when the next place frees: the oldest one\'s 24 hours with 200 in the window; with more (filled past the cap), when enough have left that a join fits', async () => {
  for (const [count, leave] of [[200, 1], [201, 2], [205, 6]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-day-cap-'));
    const clock = {t: Date.parse('2026-11-18T12:00:00Z')};
    const p = server(dir, clock);
    // `count` self-serve participants in the window, the oldest made 23 h 59 min ago, then one a minute.
    const first = clock.t - 864e5 + 60e3;
    for (let i = 0; i < count; i++) {
      const id = `vp_${(0xd00000000000 + i).toString(16)}`;
      p.s.participants[id] = {id, handle: `day-${i}`, operator: 'x', status: 'active', sandbox_only: true, created_at: new Date(first + i * 60e3).toISOString()};
    }
    const at = `${count} in the window`, frees = first + (leave - 1) * 60e3 + 864e5;
    const e = await refusal(join(p, A));
    assert.deepEqual([e.code, e.status], ['sandbox_full', 429], at);
    assert.equal(e.extra.retry_after_ms, frees - clock.t, `${at}: the next place frees once ${leave} of them have left it`);
    assert.equal(e.extra.resets_at, new Date(frees).toISOString(), at);
    assert.equal(e.message, 'the sandbox takes at most 200 new participants in any 24 hours (a rolling window, not a calendar day); the next place frees at '
      + `${new Date(frees).toISOString()}, in ${Math.ceil((frees - clock.t) / 60e3)} min`, at);
    // Over-filled, the oldest one's 24 hours (the earlier answer) is too early: the window is still full then.
    if (leave > 1) {
      clock.t = first + 864e5;
      assert.equal((await refusal(join(p, A))).code, 'sandbox_full', `${at}: at the oldest one's 24 hours`);
    }
    // A moment before the time it names, still full; at that time, a join is taken.
    clock.t = frees - 1;
    assert.equal((await refusal(join(p, A))).code, 'sandbox_full', `${at}: 1 ms before`);
    clock.t = frees;
    const j = await join(p, A, `day-joins-${count}`);
    assert.equal(p.s.participants[j.participant_id].handle, `day-joins-${count}`, at);
  }
});
