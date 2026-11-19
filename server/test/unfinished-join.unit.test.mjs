// Unfinished joins (fix inbox #131) and the commands' placeholders. No tracker: a stub verify stands for the signer.
//
// A lost answer to POST /join-sandbox (a cut connection; the newcomer test of Nov 17, c1) left a participant nobody could
// use: its owner token and enrollment code were only in that answer, so it stayed awaiting_agent, and the handle was
// taken for good (every retry got handle_taken). Now such a join holds its handle for a while: a join that meets it gets
// 409 handle_taken with retry_after_ms and held_until, and once the hold ends the record is removed and the handle is
// free again. The hold lasts an hour after the latest enrollment code was issued, and never less than until that code
// expires, so an enrollment that can still be made is never cut off; a participant that ever had a key is never released.
//
// Pasting a join block unchanged made a permanent public agent your-handle operated by "YOUR NAME" (staging, Nov 17): a
// join that names one of the commands' placeholders is refused with 400 invalid_field, and records nothing.
//
// The review of fix/first-use (Nov 17): anyone could keep someone else's unfinished join from being released (and so
// make the 409's "join again then" false) by naming its public id in a list of theirs, or anywhere in free text (a
// profile's about, an agent's notes); a refused join that first released an ended hold wrote its transient invite and
// address slot; an owner's read moved the hold in memory only; and server.mjs's own calls were untested. Each is
// tested here, server.mjs as a process too.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pilot, PilotStore, PILOT_DENOMINATION, statements, sha256, UNCLAIMED_JOIN_TTL_MS, PLACEHOLDER_HANDLES, PLACEHOLDER_OPERATORS} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {joinHoldOptions, releaseJoins, upkeep, UPKEEP_MS} from '../lib/pilot/upkeep.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hexOf = s => Buffer.from(s, 'utf8').toString('hex');
// The stub signer (as test/enroll-retry.unit.test.mjs): a "signature" is 02 + sha256(pubkey + message) twice.
const sign = (pubkey, msgHex) => '02' + sha256(pubkey + msgHex).repeat(2);
// Tracker v3.2's capabilities, pinned, for circulation on (the testnet's PILOT_CIRCULATION=on): the credit-policy lists.
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient',
    'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
  setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const PIN = 'cd'.repeat(32);
const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], capabilities: async () => V3_CAPS,
  verify: async (pubkey, msgHex, sig) => sig === sign(pubkey, msgHex)};
const key = () => '02' + crypto.randomBytes(32).toString('hex');
const enrollment = (pid, code, pk = key()) => ({participant_id: pid, code, pubkey: pk, signature: sign(pk, hexOf(statements.enroll(pid, pk, sha256(code))))});
const SANDBOX = {id: 'vp_5a5a5a5a5a5a', handle: 'sandbox-exact', operator: 'the operator', status: 'active', created_at: '2026-11-01T00:00:00.000Z'};
const T0 = Date.parse('2026-11-17T19:44:42Z'), MIN = 60e3, DAY = 864e5;
const iso = t => new Date(t).toISOString();
const made = [];
after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-unfinished-')); made.push(d); return d; };

// A server's pilot on `dir` (a new one on the same dir is a restart), with the sandbox agent that join-sandbox needs.
// `circulating`: circulation on with the open network, as on the testnet (fly.testnet.toml).
function world({dir = tmp(), clock = {t: T0}, circulating = false, ...opts} = {}) {
  const p = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, openSandbox: true, log: () => {},
    ...(circulating ? {openNetwork: true, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN]} : {}), ...opts});
  p.s.participants[SANDBOX.id] ??= {...SANDBOX};
  p.sandboxIds = new Set([SANDBOX.id]);
  return {p, clock, dir};
}
const refusal = async promise => {
  try { await promise; } catch (e) { return e; }
  assert.fail('not refused');
};
const refused = fn => { try { fn(); } catch (e) { return e; } assert.fail('not refused'); };
const audit = dir => fs.readFileSync(path.join(dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const onDisk = dir => JSON.parse(fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8'));
const HELD = until => `that handle is held until ${iso(until)} by a join that didn't finish (no agent key was ever enrolled for it): join again then, or choose another handle`;
const TAKEN = "that handle is taken (as another participant's handle or display name)";

test('the hold lasts an hour: twice the 30 minutes an enrollment code is valid', () => {
  assert.equal(UNCLAIMED_JOIN_TTL_MS, 60 * MIN);
  const {p} = world();
  assert.equal(p.unclaimedJoinTtlMs, 60 * MIN);
  assert.equal(world({unclaimedJoinTtlMs: 2 * 3600e3}).p.unclaimedJoinTtlMs, 2 * 3600e3);
  for (const bad of [-1, 1.5, '600000', null, NaN]) assert.equal(world({unclaimedJoinTtlMs: bad}).p.unclaimedJoinTtlMs, UNCLAIMED_JOIN_TTL_MS, String(bad));
  // PILOT_UNCLAIMED_JOIN_TTL_MS sets it (server.mjs: lib/pilot/upkeep.mjs joinHoldOptions), in whole ms (1 to 10
  // digits); anything else keeps the default.
  for (const [v, want] of [['600000', 600000], ['0', 0], ['7200000', 7200000], ['9999999999', 9999999999]])
    assert.equal(world(joinHoldOptions({PILOT_UNCLAIMED_JOIN_TTL_MS: v})).p.unclaimedJoinTtlMs, want, v);
  for (const v of [undefined, '', ' 600000', '600000 ', '-1', '1.5', '1e6', '600000ms', '10 min', '12345678901', '0x10'])
    assert.deepEqual(joinHoldOptions({PILOT_UNCLAIMED_JOIN_TTL_MS: v}), {}, String(v));
  assert.deepEqual(joinHoldOptions({}), {});
  assert.deepEqual(joinHoldOptions(), {});
});

test('a join that meets a handle held by a join that did not finish gets 409 handle_taken, retry_after_ms and held_until', async () => {
  const {p, clock, dir} = world();
  const lost = await p.joinSandbox({handle: 'nc-c-1117', operator: 'Ada'});      // its answer is the one lost on the way
  assert.equal(p.s.participants[lost.participant_id].status, 'awaiting_agent');
  clock.t += 5 * MIN;
  const until = T0 + 60 * MIN;
  for (const handle of ['nc-c-1117', 'NC-C-1117', 'nc_c_1117']) {               // the same name to a reader
    const e = await refusal(p.joinSandbox({handle, operator: 'Ada'}));
    assert.equal(e.code, 'handle_taken', handle);
    assert.equal(e.status, 409);
    assert.equal(e.message, HELD(until));
    assert.deepEqual(e.extra, {retry_after_ms: 55 * MIN, held_until: iso(until)});
    assert.ok(Number.isInteger(e.extra.retry_after_ms));
  }
  // The refused joins recorded nothing: one participant, and no invite left behind but the first join's.
  assert.equal(Object.values(p.s.participants).filter(x => x.handle === 'nc-c-1117').length, 1);
  assert.equal(Object.keys(p.s.invites).length, 1);
  // At the end of the hold it still stands (retry in a second at least); just after, the handle is free.
  clock.t = until;
  assert.deepEqual((await refusal(p.joinSandbox({handle: 'nc-c-1117', operator: 'Ada'}))).extra, {retry_after_ms: 1000, held_until: iso(until)});
  clock.t = until + 1;
  const again = await p.joinSandbox({handle: 'nc-c-1117', operator: 'Ada'});
  assert.notEqual(again.participant_id, lost.participant_id);
  assert.equal(Object.hasOwn(p.s.participants, lost.participant_id), false, 'the unfinished join is removed');
  assert.equal(p.authenticate(lost.owner_token), null, 'its owner token, which nobody received, opens nothing');
  assert.equal(p.authenticate(again.owner_token)?.p.id, again.participant_id);
  const released = audit(dir).filter(a => a.type === 'participant.released');
  assert.deepEqual(released.map(({at, ...a}) => a), [{type: 'participant.released', id: lost.participant_id, handle: 'nc-c-1117',
    joined_at: iso(T0), held_until: iso(until), reason: 'unfinished_join'}]);
  // An enrollment for the released id (its code arrived after all, say) is told the server holds no such participant
  // and why, never that its owner can issue a new code: nobody can (the review of PR #8, promotion's missed item). Only a
  // self-serve join is ever released, and not while another participant's list names it (unfinishedJoin, releaseEnded:
  // the review of PR #9, item 12), so the message says so. A code that is only expired, for a participant still held,
  // keeps its message.
  const late = await refusal(p.enroll(enrollment(lost.participant_id, lost.enrollment_code)));
  assert.deepEqual([late.code, late.status, late.message], ['invalid_enrollment', 403,
    "this server holds no participant with this id: a self-serve join whose agent never enrolled a key is released when its hold ends (unless another participant's list names it), and its handle is then free again"]);
  for (const pid of ['vp_000000000000', 42, undefined]) assert.match((await refusal(p.enroll(enrollment(pid, 'vpe_x')))).message, /^this server holds no participant with this id: /, String(pid));
  const held = await refusal(p.enroll(enrollment(again.participant_id, 'vpe_wrong')));
  assert.deepEqual([held.code, held.message], ['invalid_enrollment', 'enrollment code is invalid or expired; the owner can issue a new one']);
});

test('an enrollment that can still be made is never cut off: the hold lasts until the code expires, however short the TTL', async () => {
  const {p, clock} = world({unclaimedJoinTtlMs: MIN});                           // set below the code's 30 minutes
  const j = await p.joinSandbox({handle: 'slow-enroller', operator: 'Ada'});
  clock.t = T0 + 29 * MIN;
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  const e = await refusal(p.joinSandbox({handle: 'slow-enroller', operator: 'Bea'}));
  assert.equal(e.extra.held_until, j.enrollment_expires_at, 'held while its code is valid');
  assert.equal(e.message, HELD(Date.parse(j.enrollment_expires_at)));
  const r = await p.enroll(enrollment(j.participant_id, j.enrollment_code));
  assert.equal(r.participant_id, j.participant_id);
  // With a key it is never released, and the handle is taken for good, with no hold to wait for.
  clock.t += 30 * DAY;
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  const taken = await refusal(p.joinSandbox({handle: 'slow-enroller', operator: 'Bea'}));
  assert.equal(taken.code, 'handle_taken');
  assert.equal(taken.message, TAKEN);
  assert.deepEqual(taken.extra, {});
});

test('a lost enrollment answer resent within the code\'s time (fix/enroll-retry) finds its participant there', async () => {
  const {p, clock} = world();
  const j = await p.joinSandbox({handle: 'resender', operator: 'Ada'}), body = enrollment(j.participant_id, j.enrollment_code);
  clock.t = T0 + 29 * MIN;
  await p.enroll(body);                                                           // registered; its answer lost
  clock.t = T0 + 30 * MIN;
  assert.deepEqual(await p.releaseUnfinishedJoins(), [], 'a participant with a key is not an unfinished join');
  assert.equal((await p.enroll(body)).enrolled_again, true);
});

test('a new enrollment code starts the hold again: the owner who comes back after the code expired keeps the handle', async () => {
  const {p, clock} = world();
  const j = await p.joinSandbox({handle: 'came-back', operator: 'Ada'}), me = p.s.participants[j.participant_id];
  clock.t = T0 + 50 * MIN;                                                        // the join's code expired 20 minutes ago
  const fresh = p.newEnrollmentCode(me);                                          // the owner console's "new enrollment code"
  clock.t = T0 + 61 * MIN;                                                        // past the join's own hour
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  assert.equal((await refusal(p.joinSandbox({handle: 'came-back', operator: 'Bea'}))).extra.held_until, iso(T0 + 110 * MIN));
  clock.t = T0 + 75 * MIN;
  await p.enroll(enrollment(j.participant_id, fresh.enrollment_code));
  clock.t = T0 + 365 * DAY;
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  assert.equal(p.s.participants[j.participant_id].status, 'active');
});

test('an owner who comes back keeps the hold: each of its requests starts the hour again, so none is cut off mid-request', async () => {
  const {p, clock} = world();
  const j = await p.joinSandbox({handle: 'owner-back', operator: 'Ada'});         // this answer arrived: the owner holds its token
  clock.t = T0 + 50 * MIN;
  assert.equal(p.authenticate(j.owner_token)?.role, 'owner');                     // it signs in to the owner console
  clock.t = T0 + 70 * MIN;                                                         // past the join's own hour
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  assert.equal((await refusal(p.joinSandbox({handle: 'owner-back', operator: 'Bea'}))).extra.held_until, iso(T0 + 110 * MIN));
  // A request that has just authenticated (the console's "new enrollment code", say) finds its participant still there.
  assert.equal(p.authenticate(j.owner_token)?.role, 'owner');
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  assert.ok(p.newEnrollmentCode(p.s.participants[j.participant_id]).enrollment_code);
  // Once the owner is gone for the hour (and the code it took has expired), the join is released.
  clock.t = T0 + 70 * MIN + 60 * MIN + 1;
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: j.participant_id, handle: 'owner-back'}]);
  assert.equal(p.authenticate(j.owner_token), null);
});

test('never released: a participant with a key, one whose key was revoked, an invited one, the house and server-run agents', async () => {
  const {p, clock} = world();
  const active = await p.joinSandbox({handle: 'has-a-key', operator: 'Ada'});
  await p.enroll(enrollment(active.participant_id, active.enrollment_code));
  const revoked = await p.joinSandbox({handle: 'was-revoked', operator: 'Ada'});
  await p.enroll(enrollment(revoked.participant_id, revoked.enrollment_code));
  await p.revokeAgent(p.s.participants[revoked.participant_id]);
  assert.equal(p.s.participants[revoked.participant_id].status, 'awaiting_agent', 'awaiting a new key, as an unfinished join is');
  const inv = p.createInvite();
  const invited = await p.join({invite: inv.code, handle: 'invited-one', operator: 'Ada'});   // never enrolled
  const house = await p.joinSandbox({handle: 'house-x', operator: 'the operator'});
  p.houseIds = new Set([house.participant_id]);
  const run = await p.joinSandbox({handle: 'server-run-x', operator: 'the operator'});
  p.serverSigner = {has: id => id === run.participant_id};
  const ids = [active, revoked, invited, house, run].map(j => j.participant_id);
  clock.t = T0 + 30 * DAY;
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  for (const id of ids) assert.ok(Object.hasOwn(p.s.participants, id), id);
  for (const handle of ['has-a-key', 'was-revoked', 'invited-one', 'house-x', 'server-run-x']) {
    const e = await refusal(p.joinSandbox({handle, operator: 'Bea'}));
    assert.equal(e.message, TAKEN, handle);
    assert.deepEqual(e.extra, {}, `${handle}: no hold to wait for`);
  }
});

test('nobody else\'s records change: a release removes only that record; one a list named before lists refused it is kept, with no hold promised', async () => {
  const {p, clock} = world({openNetwork: true});
  const a = await p.joinSandbox({handle: 'orphan-a', operator: 'Ada'});
  const b = await p.joinSandbox({handle: 'orphan-b', operator: 'Ada'});
  const c = await p.joinSandbox({handle: 'orphan-c', operator: 'Ada'});
  const friend = await p.joinSandbox({handle: 'a-friend', operator: 'Bea'});
  await p.enroll(enrollment(friend.participant_id, friend.enrollment_code));
  const f = p.s.participants[friend.participant_id];
  // b is on another participant's list, written before lists refused unfinished joins (as a state of Nov 17 may hold
  // it): removing b would leave that list naming no one. c is only mentioned in a deal's text, which names no one.
  f.mandate.counterparties = [b.participant_id, SANDBOX.id];
  p.s.deals.vd_00000000000000c1 = {id: 'vd_00000000000000c1', status: 'proposed', note: `names ${c.participant_id}`};
  p.save();
  clock.t = T0 + 2 * 60 * MIN;
  const before = JSON.parse(JSON.stringify(p.s));
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: a.participant_id, handle: 'orphan-a'}, {id: c.participant_id, handle: 'orphan-c'}]);
  delete before.participants[a.participant_id]; delete before.participants[c.participant_id];
  assert.deepEqual(JSON.parse(JSON.stringify(p.s)), before, 'everything else is as it was');
  // b holds its handle while the list names it: a join meets a plain handle_taken, with no time it would not keep.
  const e = await refusal(p.joinSandbox({handle: 'orphan-b', operator: 'Bea'}));
  assert.equal(e.message, TAKEN);
  assert.deepEqual(e.extra, {});
  assert.deepEqual(await p.releaseUnfinishedJoins(), [], 'and later sweeps leave it');
  // That list can be sent again unchanged (a console resends every list), but adds no other unfinished join.
  assert.equal(p.setMandate(f, {counterparties: [SANDBOX.id, b.participant_id]}, {by: 'owner'}).changed, false);
  const d = await p.joinSandbox({handle: 'orphan-d', operator: 'Ada'});
  assert.equal(refused(() => p.setMandate(f, {counterparties: [b.participant_id, SANDBOX.id, d.participant_id]}, {by: 'owner'})).code, 'invalid_field');
  // Once the list no longer names it, the next sweep releases it, in the same process (nothing is kept in memory).
  p.setMandate(f, {counterparties: 'any'}, {by: 'owner'});
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: b.participant_id, handle: 'orphan-b'}]);
  for (const handle of ['orphan-a', 'orphan-b', 'orphan-c']) await p.joinSandbox({handle, operator: 'Bea'});
});

test('no list can name a join that didn\'t finish: counterparties, accept_notes_from, refuse_notes_from, and an agent\'s limits, by anyone (the review of #131)', async () => {
  // The finding: another newcomer's owner, or its agent alone, put the victim's public id (GET /participants?q=HANDLE)
  // on a list of its own, and the victim's join was then never released: at held_until the 409 had promised, the
  // handle was still taken.
  const {p, clock, dir} = world({circulating: true});
  assert.equal(p.mode, 'on');
  const victim = await p.joinSandbox({handle: 'victim-handle', operator: 'Ada'}, {addressKey: '203.0.113.8'});
  const g = await p.joinSandbox({handle: 'list-maker', operator: 'Mallory'}, {addressKey: '198.51.100.9'});
  const agentToken = (await p.enroll(enrollment(g.participant_id, g.enrollment_code))).agent_token;
  const owner = p.authenticate(g.owner_token), agent = p.authenticate(agentToken);
  assert.deepEqual([owner.role, agent.role], ['owner', 'agent']);
  clock.t = T0 + 5 * MIN;
  const first = await refusal(p.joinSandbox({handle: 'victim-handle', operator: 'Ada'}, {addressKey: '203.0.113.8'}));
  assert.deepEqual(first.extra, {retry_after_ms: 55 * MIN, held_until: iso(T0 + 60 * MIN)});
  const v = victim.participant_id, me = p.s.participants[g.participant_id], saved = JSON.stringify(onDisk(dir).participants[g.participant_id]);
  const message = field => `${field}: ${v} (victim-handle) is a join that didn't finish: no agent key was ever enrolled for it, so no list can name it until its agent enrolls one`;
  for (const [field, value] of [['counterparties', [v, SANDBOX.id]], ['accept_notes_from', [SANDBOX.id, v]], ['refuse_notes_from', [v]]]) {
    for (const by of ['owner', 'operator']) {
      const e = refused(() => p.setMandate(me, {[field]: value}, {by}));
      assert.deepEqual([e.code, e.status, e.message, e.extra], ['invalid_field', 400, message(field), {field}], `${field} by the ${by}`);
    }
  }
  for (const field of ['accept_notes_from', 'refuse_notes_from']) {
    for (const by of ['agent', 'owner']) {
      const e = refused(() => p.setAgentLimits(me, {[field]: [v]}, {by}));
      assert.deepEqual([e.code, e.status, e.message, e.extra], ['invalid_field', 400, message(field), {field}], `limits ${field} by the ${by}`);
    }
  }
  assert.equal(JSON.stringify(onDisk(dir).participants[g.participant_id]), saved, 'nothing was recorded');
  assert.equal(me.mandate.counterparties, 'any');
  // At held_until + 1 ms, as the 409 said, the handle is free again.
  clock.t = T0 + 60 * MIN + 1;
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: v, handle: 'victim-handle'}]);
  await p.joinSandbox({handle: 'victim-handle', operator: 'Ada'}, {addressKey: '203.0.113.8'});
  // A join whose agent has enrolled can be named, on every list.
  const later = await p.joinSandbox({handle: 'enrolls-later', operator: 'Cy'});
  assert.equal(refused(() => p.setMandate(me, {counterparties: [later.participant_id]}, {by: 'owner'})).code, 'invalid_field');
  await p.enroll(enrollment(later.participant_id, later.enrollment_code));
  const L = later.participant_id;
  assert.deepEqual(p.setMandate(me, {counterparties: [L, SANDBOX.id], accept_notes_from: [L], refuse_notes_from: [SANDBOX.id]}, {by: 'owner'}).mandate.counterparties, [L, SANDBOX.id]);
  assert.deepEqual(p.setAgentLimits(me, {refuse_notes_from: [SANDBOX.id, L]}, {by: 'agent'}).agent_limits.refuse_notes_from, [SANDBOX.id, L]);
  // A participant whose key was revoked is awaiting a key too, but it is no unfinished join: it can be named.
  await p.revokeAgent(p.s.participants[L]);
  assert.equal(p.s.participants[L].status, 'awaiting_agent');
  assert.deepEqual(p.setMandate(me, {counterparties: [L]}, {by: 'owner'}).mandate.counterparties, [L]);
});

test('free text that mentions a join\'s id names no one: a profile, a display name, an agent\'s notes, a deal\'s text', async () => {
  // Before the review of #131 the state's text was searched for the id, so anyone could keep anyone's join (and its
  // handle) for good with PUT /profile {about: "... vp_..."}, which an owner token from a join of its own allows.
  const {p, clock} = world({circulating: true});
  const victims = [];
  for (const how of ['about', 'display_name', 'notes', 'deal']) {
    const victim = await p.joinSandbox({handle: `victim-${how.replace('_', '-')}`, operator: 'Ada'});
    victims.push({id: victim.participant_id, handle: `victim-${how.replace('_', '-')}`});
    const g = await p.joinSandbox({handle: `writer-${how.replace('_', '-')}`, operator: 'Mallory'});
    await p.enroll(enrollment(g.participant_id, g.enrollment_code));
    const me = p.authenticate(g.owner_token).p;
    if (how === 'about') p.setProfile(me, {about: `ask ${victim.participant_id} first`}, {by: 'owner'});
    if (how === 'display_name') p.setProfile(me, {display_name: victim.participant_id}, {by: 'owner'});
    if (how === 'notes') p.setAgentLimits(me, {notes: `never pay ${victim.participant_id}`}, {by: 'owner'});
    if (how === 'deal') { p.s.deals.vd_00000000000000d1 = {id: 'vd_00000000000000d1', status: 'proposed', service: {description: victim.participant_id}}; p.save(); }
  }
  clock.t = T0 + 60 * MIN + 1;
  assert.deepEqual(await p.releaseUnfinishedJoins(), victims);
  for (const {handle} of victims) await p.joinSandbox({handle, operator: 'Ada'});
});

test('joins a list names before lists refused them, naming each other: released together, or kept with the one that is kept', async () => {
  const {p, clock} = world({openNetwork: true});
  const [x, y, z] = [await p.joinSandbox({handle: 'pair-x', operator: 'Ada'}), await p.joinSandbox({handle: 'pair-y', operator: 'Ada'}),
    await p.joinSandbox({handle: 'pair-z', operator: 'Ada'})];
  const f = await p.joinSandbox({handle: 'pair-friend', operator: 'Bea'});
  await p.enroll(enrollment(f.participant_id, f.enrollment_code));
  // x's list names y (a list released with y names no one then); z is on f's list, and z's list names x.
  p.s.participants[x.participant_id].mandate.counterparties = [y.participant_id];
  p.s.participants[z.participant_id].mandate.counterparties = [x.participant_id];
  p.s.participants[f.participant_id].mandate.counterparties = [z.participant_id];
  p.save();
  clock.t = T0 + 2 * 60 * MIN;
  assert.deepEqual(p.namedElsewhere([x.participant_id, y.participant_id, z.participant_id]), new Set([z.participant_id, x.participant_id, y.participant_id]));
  assert.deepEqual(await p.releaseUnfinishedJoins(), []);
  p.s.participants[f.participant_id].mandate.counterparties = 'any';
  assert.deepEqual((await p.releaseUnfinishedJoins()).map(r => r.handle), ['pair-x', 'pair-y', 'pair-z']);
});

test('the periodic release frees every ended hold; a display name that copies a held name waits for the hold too', async () => {
  const {p, clock} = world();
  const one = await p.joinSandbox({handle: 'first-try', operator: 'Ada'});
  clock.t = T0 + 30 * MIN;
  const two = await p.joinSandbox({handle: 'second-try', operator: 'Ada'});
  // Another handle whose display name copies the held one: display_name_taken, saying until when.
  const e = await refusal(p.joinSandbox({handle: 'other-handle', display_name: 'First Try', operator: 'Bea'}));
  assert.equal(e.code, 'display_name_taken');
  assert.deepEqual(e.extra, {retry_after_ms: 30 * MIN, held_until: iso(T0 + 60 * MIN)});
  clock.t = T0 + 61 * MIN;
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: one.participant_id, handle: 'first-try'}]);
  assert.ok(Object.hasOwn(p.s.participants, two.participant_id), 'its hold lasts another half hour');
  await p.joinSandbox({handle: 'other-handle', display_name: 'First Try', operator: 'Bea'});
});

test('the hold is in the state: a restart keeps it, with the same end', async () => {
  const {p, clock, dir} = world();
  await p.joinSandbox({handle: 'restart-me', operator: 'Ada'});
  clock.t = T0 + 10 * MIN;
  const {p: after} = world({dir, clock});
  assert.deepEqual((await refusal(after.joinSandbox({handle: 'restart-me', operator: 'Ada'}))).extra, {retry_after_ms: 50 * MIN, held_until: iso(T0 + 60 * MIN)});
});

test('an owner\'s request that only reads moves the hold on disk too, saved at most once a minute, so a restart keeps it', async () => {
  // The review of #131: GET /owner at T0+50m moved the hold to T0+110m in memory only; after a restart it ended at
  // T0+60m again, and the startup release took the participant its owner had just signed in to.
  const {p, clock, dir} = world();
  const j = await p.joinSandbox({handle: 'owner-reads', operator: 'Ada'});
  clock.t = T0 + 50 * MIN;
  const g = p.generation;
  assert.equal(p.authenticate(j.owner_token)?.role, 'owner');                    // GET /owner, say: nothing else saves
  assert.equal(p.generation, g + 1, 'saved');
  assert.equal(onDisk(dir).participants[j.participant_id].last_seen_owner, iso(T0 + 50 * MIN));
  // Another read within the minute moves it in memory only (at most a minute of it a restart would not keep).
  clock.t = T0 + 50 * MIN + 59e3;
  p.authenticate(j.owner_token);
  assert.equal(p.generation, g + 1, 'not saved again within the minute');
  clock.t = T0 + 51 * MIN;
  p.authenticate(j.owner_token);
  assert.equal(p.generation, g + 2, 'saved again a minute later');
  // After a restart the hold ends an hour after the last saved request, and nothing is released before.
  clock.t = T0 + 61 * MIN;
  const {p: after} = world({dir, clock});
  assert.equal(iso(after.joinHeldUntil(after.s.participants[j.participant_id])), iso(T0 + 111 * MIN));
  assert.deepEqual(await after.releaseUnfinishedJoins(), []);
  // The owner of a participant with a key saves nothing on a read, as before.
  const k = await after.joinSandbox({handle: 'has-key', operator: 'Bea'});
  await after.enroll(enrollment(k.participant_id, k.enrollment_code));
  const g2 = after.generation;
  after.authenticate(k.owner_token);
  assert.equal(after.generation, g2);
});

test('a join refused after it released an ended hold writes nothing of its own: no invite, no address slot (the review of #131)', async () => {
  const {p, clock, dir} = world();
  const lost = await p.joinSandbox({handle: 'alpha-one', operator: 'Ada'}, {addressKey: '203.0.113.20'});
  const b = await p.joinSandbox({handle: 'bravo-two', display_name: 'Bravo Two', operator: 'Bea'}, {addressKey: '203.0.113.21'});
  await p.enroll(enrollment(b.participant_id, b.enrollment_code));
  clock.t = T0 + 2 * 3600e3;
  const before = onDisk(dir);
  // The join releases alpha-one (its hold ended), which saves, then is refused for its display name.
  const e = await refusal(p.joinSandbox({handle: 'alpha-one', display_name: 'bravo two', operator: 'Cy'}, {addressKey: '203.0.113.22'}));
  assert.equal(e.code, 'display_name_taken');
  const disk = onDisk(dir);
  assert.equal(Object.hasOwn(disk.participants, lost.participant_id), false, 'the release is saved');
  assert.deepEqual(Object.keys(disk.invites).sort(), Object.keys(before.invites).sort(), 'no invite of the refused join');
  assert.deepEqual(Object.keys(disk.invites).sort(), Object.keys(p.s.invites).sort());
  assert.equal(disk.sandbox_joins, undefined, 'no slot of the refused join (the two earlier ones left the hour)');
  assert.deepEqual(disk.sandbox_joins, p.s.sandbox_joins);
  // A restart counts what happened: alpha-one free, and no join from 203.0.113.22 this hour.
  const {p: after} = world({dir, clock});
  assert.equal(after.recentSandboxJoins().length, 0);
  await after.joinSandbox({handle: 'alpha-one', operator: 'Cy'}, {addressKey: '203.0.113.22'});
});

test('a join refused while another request saved the state (it waited for the lock) writes nothing of its own either', async () => {
  const {p, dir} = world();
  await p.joinSandbox({handle: 'taken-one', operator: 'Ada'}, {addressKey: '203.0.113.30'});
  let open;
  const gate = new Promise(r => { open = r; });
  const busy = p.serial(async () => { await gate; p.save(); });         // a request holding the lock, which saves
  const refusedJoin = refusal(p.joinSandbox({handle: 'taken-one', operator: 'Bea'}, {addressKey: '203.0.113.31'}));
  open();
  await busy;
  assert.equal((await refusedJoin).code, 'handle_taken');
  const disk = onDisk(dir);
  assert.deepEqual(Object.keys(disk.invites).sort(), Object.keys(p.s.invites).sort());
  assert.equal(disk.sandbox_joins.length, 1, 'the first join\'s slot only');
  assert.deepEqual(disk.sandbox_joins, p.s.sandbox_joins);
});

test('the daily cap counts the participants in the state: a released join no longer counts; the hourly limits count every join', async () => {
  const {p, clock} = world({unclaimedJoinTtlMs: MIN});
  // 199 sandbox participants with a key, joined in the last 24 hours, and one join whose answer was lost: 200.
  for (let i = 0; i < 199; i++) {
    const id = `vp_${(0xd00000000000 + i).toString(16)}`;
    p.s.participants[id] = {id, handle: `seed-${i}`, display_name: `seed-${i}`, operator: 'x', status: 'active', pubkey: key(), sandbox_only: true,
      created_at: iso(T0 - 2 * 3600e3), key_registered_at: iso(T0 - 2 * 3600e3), mandate: {}};
  }
  const lost = await p.joinSandbox({handle: 'lost-one', operator: 'Ada'}, {addressKey: '203.0.113.40'});
  clock.t = T0 + 5 * MIN;
  const full = await refusal(p.joinSandbox({handle: 'one-more', operator: 'Bea'}));
  assert.equal(full.code, 'sandbox_full');
  assert.match(full.message, /^the sandbox takes at most 200 new participants in any 24 hours/);
  // Once released (its code expired at T0+30m; the hold, a minute here, never ends before), it no longer counts.
  clock.t = T0 + 31 * MIN;
  assert.deepEqual(await p.releaseUnfinishedJoins(), [{id: lost.participant_id, handle: 'lost-one'}]);
  assert.equal(p.recentSandboxJoins().length, 1, 'its address slot still counts for the hour');
  assert.equal((await p.joinSandbox({handle: 'one-more', operator: 'Bea'})).handle, 'one-more');
});

// Over HTTP, as a client sees it: the 409's body, and GET /participants?q=HANDLE, which shows what the lost join made.
async function serve(p) {
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: createPilotRoutes({pilot: p, cfg: {}})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/pilot/v1`;
  const call = async (method, route, body) => {
    const r = await fetch(base + route, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, body: await r.json()};
  };
  return {srv, call};
}

test('over HTTP: the 409 carries retry_after_ms and held_until, and GET /participants?q=HANDLE shows the unfinished join', async () => {
  const {p, clock} = world();
  const {srv, call} = await serve(p);
  try {
    const first = await call('POST', '/join-sandbox', {handle: 'nc-http-1', operator: 'Ada'});
    assert.equal(first.status, 201);
    clock.t = T0 + 20 * MIN;
    const again = await call('POST', '/join-sandbox', {handle: 'nc-http-1', operator: 'Ada'});
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, {error: 'handle_taken', message: HELD(T0 + 60 * MIN), retry_after_ms: 40 * MIN, held_until: iso(T0 + 60 * MIN)});
    const q = await call('GET', '/participants?q=NC-HTTP-1');
    assert.equal(q.status, 200);
    assert.deepEqual(q.body.map(x => [x.id, x.handle, x.status, x.pubkey]), [[first.body.participant_id, 'nc-http-1', 'awaiting_agent', null]]);
    assert.deepEqual((await call('GET', '/participants?q=nobody-here')).body, []);
    assert.deepEqual((await call('GET', '/participants?q=')).body, []);
    assert.equal((await call('GET', `/participants?q=${'x'.repeat(65)}`)).status, 400);
    assert.ok((await call('GET', '/participants')).body.length >= 2, 'without q, the whole directory as before');
    clock.t = T0 + 61 * MIN;
    const later = await call('POST', '/join-sandbox', {handle: 'nc-http-1', operator: 'Ada'});
    assert.equal(later.status, 201);
    assert.deepEqual((await call('GET', '/participants?q=nc-http-1')).body.map(x => x.id), [later.body.participant_id]);
  } finally { srv.close(); }
});

// ---------- what server.mjs runs (lib/pilot/upkeep.mjs), and server.mjs itself ----------
test('the periodic upkeep releases every ended hold and logs which, after recovery, even when recovery fails', async () => {
  const {p, clock} = world();
  const one = await p.joinSandbox({handle: 'upkeep-one', operator: 'Ada'});
  const two = await p.joinSandbox({handle: 'upkeep-two', operator: 'Ada'});
  clock.t = T0 + 61 * MIN;
  const lines = [], errors = [];
  await upkeep(p, {log: m => lines.push(m), error: m => errors.push(m)});
  assert.deepEqual(lines, ['Pilot: released 2 unfinished joins (no agent key ever enrolled), their handles free again: upkeep-one, upkeep-two']);
  assert.deepEqual(errors, []);
  assert.equal(Object.hasOwn(p.s.participants, one.participant_id) || Object.hasOwn(p.s.participants, two.participant_id), false);
  // A recovery that fails is logged, and the release still runs, then the compaction.
  const three = await p.joinSandbox({handle: 'upkeep-three', operator: 'Ada'});
  clock.t += 61 * MIN;
  const steps = [];
  p.recover = async () => { steps.push('recover'); throw new Error('tracker down'); };
  const compact = p.maybeCompactJournal.bind(p);
  p.maybeCompactJournal = (...a) => { steps.push('compact'); return compact(...a); };
  lines.length = 0;
  await upkeep(p, {log: m => lines.push(m), error: m => errors.push(m)});
  assert.deepEqual(errors, ['Pilot: periodic recovery failed: tracker down']);
  assert.deepEqual(lines, ['Pilot: released 1 unfinished join (no agent key ever enrolled), their handles free again: upkeep-three']);
  assert.deepEqual(steps, ['recover', 'compact']);
  assert.equal(Object.hasOwn(p.s.participants, three.participant_id), false);
  // releaseJoins never rejects: a failure is logged.
  p.releaseUnfinishedJoins = async () => { throw new Error('disk full'); };
  assert.deepEqual(await releaseJoins(p, {log: m => lines.push(m), error: m => errors.push(m)}), []);
  assert.equal(errors.at(-1), 'Pilot: releasing unfinished joins failed: disk full');
});

// server.mjs as a process, as test/desk-optional.test.mjs runs it: over a stub pilot tracker (GET / names the Basis
// Tracker; /capabilities is 404, a tracker before v3: circulation off), with no sandbox agents, no desk and no seeding,
// so neither a tracker binary nor the signer is used.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k)));
async function startedServer(dataDir, env = {}) {
  const tracker = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end('Basis Tracker (stub)'); }
    if (req.url === '/notes') { res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify({success: true, data: []})); }
    res.writeHead(404, {'content-type': 'application/json'}); res.end(JSON.stringify({success: false, error: 'not found'}));
  });
  await new Promise(r => tracker.listen(0, '127.0.0.1', r));
  const port = await new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => r(n)); }); });
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {...cleanEnv(), HOST: '127.0.0.1', PORT: String(port), VALUN_DATA_DIR: path.join(dataDir, 'valun'), PILOT_DATA_DIR: path.join(dataDir, 'pilot'),
      PILOT_SANDBOX: '0', VALUN_SEED: '0', BASIS_TRACKER_URL: 'http://127.0.0.1:9', PILOT_TRACKER_URL: `http://127.0.0.1:${tracker.address().port}`,
      PILOT_TRACKER_NFT_ID: 'b'.repeat(64), ...env}});
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const closed = new Promise(r => child.on('close', r));
  const end = Date.now() + 30_000;
  while (!/^Valun \(/m.test(log) && child.exitCode === null && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  child.kill();
  await closed;
  await new Promise(r => tracker.close(r));
  assert.match(log, /^Valun \(/m, `server.mjs listened (log: ${log.slice(-600)})`);
  return {log, state: JSON.parse(fs.readFileSync(path.join(dataDir, 'pilot', 'pilot-state.json'), 'utf8'))};
}

test('server.mjs releases the ended holds at startup, with PILOT_UNCLAIMED_JOIN_TTL_MS as the hold, and runs the upkeep every 60 s', async t => {
  if (!fs.existsSync(path.join(root, 'server.mjs'))) return t.skip('needs server.mjs');
  // A state with two joins whose answers were lost, by the real clock (the server's): one 2 hours ago, whose hold
  // ended an hour ago, and one 45 minutes ago, whose hold ends in 15 minutes (its code expired 15 minutes ago); and one
  // whose agent enrolled.
  const seed = () => {
    const dir = tmp(), clock = {t: Date.now() - 2 * 3600e3};
    const {p} = world({dir: path.join(dir, 'pilot'), clock});
    return {dir, p, clock};
  };
  const make = async () => {
    const {dir, p, clock} = seed();
    await p.joinSandbox({handle: 'lost-long-ago', operator: 'Ada'});
    clock.t = Date.now() - 45 * MIN;
    await p.joinSandbox({handle: 'lost-recently', operator: 'Ada'});
    const k = await p.joinSandbox({handle: 'with-a-key', operator: 'Bea'});
    await p.enroll(enrollment(k.participant_id, k.enrollment_code));
    return dir;
  };
  const handles = state => Object.values(state.participants).map(x => x.handle).sort();
  // The default hold, an hour: the first is released at startup, before the server listens.
  const a = await startedServer(await make());
  assert.match(a.log, /^Pilot: released 1 unfinished join \(no agent key ever enrolled\), their handles free again: lost-long-ago$/m);
  assert.ok(a.log.indexOf('Pilot: released') < a.log.search(/^Valun \(/m), 'released before it listens');
  assert.deepEqual(handles(a.state), ['lost-recently', 'sandbox-exact', 'with-a-key']);
  // PILOT_UNCLAIMED_JOIN_TTL_MS=600000 (10 minutes): the second one's hold ended when its code expired, 15 minutes ago.
  const b = await startedServer(await make(), {PILOT_UNCLAIMED_JOIN_TTL_MS: '600000'});
  assert.match(b.log, /^Pilot: released 2 unfinished joins \(no agent key ever enrolled\), their handles free again: lost-long-ago, lost-recently$/m);
  assert.deepEqual(handles(b.state), ['sandbox-exact', 'with-a-key']);
  // A value that is not whole ms keeps the default hour.
  const c = await startedServer(await make(), {PILOT_UNCLAIMED_JOIN_TTL_MS: '10 min'});
  assert.match(c.log, /^Pilot: released 1 unfinished join .*: lost-long-ago$/m);
  assert.deepEqual(handles(c.state), ['lost-recently', 'sandbox-exact', 'with-a-key']);
  // The periodic upkeep is lib/pilot/upkeep.mjs's (tested above), every UPKEEP_MS: a minute.
  assert.equal(UPKEEP_MS, 60000);
  assert.match(fs.readFileSync(path.join(root, 'server.mjs'), 'utf8'), /\n {4}setInterval\(\(\) => upkeep\(pilot, \{startClearing\}\), UPKEEP_MS\)\.unref\(\);\n/);
});

// ---------- the commands' placeholders ----------
const nameKey = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

test('a join that names a placeholder is refused with 400 invalid_field, and records nothing', async () => {
  const {p} = world();
  const before = JSON.stringify(p.s);
  for (const handle of ['YOUR-HANDLE', 'your-handle', 'your_handle', 'Your-Handle', 'yourhandle', 'YOUR-BACKER', 'BACKER-HANDLE', 'PAYER-HANDLE',
    'FRIEND-HANDLE', 'their-handle', 'HANDLE', 'my-seller', 'NEW-HANDLE', 'new-handle', 'new_handle', 'yourname', 'your-name']) {
    const e = await refusal(p.joinSandbox({handle, operator: 'Ada Lovelace'}));
    assert.equal(e.code, 'invalid_field', handle);
    assert.equal(e.status, 400);
    assert.deepEqual(e.extra, {field: 'handle'});
    assert.equal(e.message, `handle: ${PLACEHOLDER_HANDLES.get(nameKey(handle))} is the placeholder in the example commands. Choose your own handle `
      + 'and operator name (both are public, and neither can change after you join), and join with them', handle);
  }
  for (const operator of ['YOUR NAME', 'your name', 'Your-Name', '"YOUR NAME"', 'YOUR HUMAN', 'Their name', 'NAME']) {
    const e = await refusal(p.joinSandbox({handle: 'ada-agent', operator}));
    assert.equal(e.code, 'invalid_field', operator);
    assert.deepEqual(e.extra, {field: 'operator'});
    assert.match(e.message, /^operator: ("YOUR NAME"|"YOUR HUMAN"|"Their name"|NAME) is the placeholder in the example commands\. Choose your own handle and operator name/);
  }
  assert.equal(JSON.stringify(p.s), before, 'no participant, no invite, nothing saved');
  // An invited join too, and its invite is not used up.
  const inv = p.createInvite();
  assert.equal((await refusal(p.join({invite: inv.code, handle: 'YOUR-HANDLE', operator: 'Ada'}))).code, 'invalid_field');
  assert.equal((await refusal(p.join({invite: inv.code, handle: 'ada-agent', operator: 'YOUR NAME'}))).code, 'invalid_field');
  assert.equal(p.s.invites[inv.id].uses, 0);
  // Before the names are compared: where someone took the placeholder already (staging has your-handle), the joiner is
  // still told to choose, not that it is taken.
  p.s.participants.vp_0000000000aa = {id: 'vp_0000000000aa', handle: 'your-handle', display_name: 'your-handle', operator: 'YOUR NAME', status: 'active', pubkey: key()};
  assert.equal((await refusal(p.joinSandbox({handle: 'YOUR-HANDLE', operator: 'YOUR NAME'}))).code, 'invalid_field');
  // Names that only contain a placeholder's words are anyone's to choose.
  for (const [handle, operator] of [['your-handle-bot', 'Your Name Here'], ['handles', 'Nameless'], ['my-seller-2', 'Name Surname'], ['new-handle-2', 'Newman']])
    assert.equal((await p.joinSandbox({handle, operator})).handle, handle);
});

test('every placeholder the join commands show is refused: the pages, skill.md and llms.txt, the client READMEs, the clients\' printed next commands', () => {
  const files = ['start.html', 'home.html', 'network.html', 'skill.md', 'skill-testnet.md', 'llms.txt', 'llms-testnet.txt'];
  const handles = new Set(), operators = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, 'public', f), 'utf8').replace(/<[^>]+>/g, '');
    for (const line of text.split('\n').filter(l => /\bjoin\b/.test(l))) {
      for (const [, h] of line.matchAll(/--handle (\S+)/g)) handles.add(h);
      for (const [, o] of line.matchAll(/--operator ("[^"]*"|\S+)/g)) operators.add(o.replace(/"/g, ''));
    }
  }
  assert.ok(handles.has('YOUR-HANDLE') && handles.has('YOUR-BACKER') && operators.has('YOUR NAME') && operators.has('YOUR HUMAN'), [...handles, ...operators].join(', '));
  // The client READMEs and docs (valun-open), not in this repository: python/README.md and examples/ai-seller/README.md
  // join --handle my-seller --operator "YOUR NAME", docs/GETTING-STARTED.md --handle BACKER-HANDLE, the Hermes plugin's
  // README --operator NAME, docs/SECOND-AGENT.md --handle their-handle --operator "Their name".
  for (const h of ['my-seller', 'BACKER-HANDLE', 'their-handle']) handles.add(h);
  for (const o of ['NAME', 'Their name']) operators.add(o);
  // The next commands the clients print (valun-open, rc/0.7.2), which a newcomer is most likely to paste unchanged right
  // after a lost or held join: python cli.py _join_command (--handle NEW-HANDLE, and --operator "YOUR NAME" when the
  // operator can't be written as one shell word), cli.py _sandbox_join (--handle YOUR-HANDLE --operator "YOUR NAME"),
  // cli.py _rejoin and agent.py's and agent.js's DEFAULT_REJOIN_HINT (--handle HANDLE --operator "YOUR NAME"). And an
  // earlier home page, whose copy is still in valun-open's server/public/home.html: --handle yourname.
  for (const h of ['NEW-HANDLE', 'YOUR-HANDLE', 'HANDLE', 'yourname']) handles.add(h);
  operators.add('YOUR NAME');
  for (const h of handles) assert.ok(PLACEHOLDER_HANDLES.has(nameKey(h)), `handle ${h}`);
  for (const o of operators) assert.ok(PLACEHOLDER_OPERATORS.has(nameKey(o)), `operator ${o}`);
  assert.equal(PLACEHOLDER_HANDLES.get('newhandle'), 'NEW-HANDLE');
});
