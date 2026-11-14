// The per-address limit on self-serve sandbox joins (fix inbox #21). A tester made 15 joins from one IPv4 address in four
// minutes: the count lived in the server's memory, and a deploy in the middle started it again from zero. The count now
// lives in the state, as keyed hashes of the address, so it survives a restart; no address is stored. No tracker.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pilot, PilotStore, PILOT_DENOMINATION, SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} from '../lib/pilot/core.mjs';
import {SANDBOX_JOINS_PER_HOUR_PER_ADDRESS as FROM_HTTP} from '../lib/pilot/http.mjs';

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
  assert.equal(e.message, 'at most 12 sandbox joins per hour from one address (an IPv6 /48)');
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
