// The evidence in a participant's record (lib/pilot/evidence.mjs) at the unit level, over a stub tracker (no tracker
// binary): delivery, repayment and acceptance are kept apart; counterparties are counted by kind; the circle says
// whether a group deals with anyone outside it; GET /pilot/v1/evidence publishes network totals with no ids, handles
// or keys; with circulation off nothing new appears. One test writes down the limit of the record itself: a staged
// circle of three identities one operator runs leaves exactly the evidence an honest circle of three does.
// Run: node --test test/evidence.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {evidenceWorld, evidence} from './evidence-world.mjs';
import {groupsOf, EVIDENCE_READS_AS} from '../lib/pilot/evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worlds = [];
after(() => { for (const w of worlds) w.cleanup(); });
const world = opts => { const w = evidenceWorld(opts); worlds.push(w); return w; };
// The evidence without its explanations, for comparisons.
const bare = e => JSON.parse(JSON.stringify(e, (k, v) => (k === 'reads_as' ? undefined : v)));

test('delivery, repayment and acceptance are separate answers about different roles', async () => {
  const w = world(), a = w.person('ana'), b = w.person('bo'), c = w.person('cy');
  w.job(a, b, 2);                                 // bo works for ana; ana pays with her IOU
  let ea = await evidence(w, a), eb = await evidence(w, b);
  assert.deepEqual(bare(eb.delivery), {accepted: {count: 1, PC: 2, buyers: 1, buyers_by_kind: {sandbox_participant: 1}}, paid: {count: 1, PC: 2}, disputed_by_buyer: 0, not_delivered: 0});
  assert.equal(ea.delivery.accepted.count, 0, 'buying says nothing about ana as a seller');
  assert.deepEqual(bare(ea.repayment), {owed_ever_PC: 2, settled: {by_setoff_PC: 0, creditors: 0, creditors_by_kind: {}}, outstanding_PC: 2, unpaid_accepted_work: {count: 0, PC: 0}});
  assert.equal(eb.repayment.owed_ever_PC, 0, 'being paid says nothing about bo as a debtor');
  assert.deepEqual(bare(ea.acceptance), {holders_ever: 1, holders_by_kind: {sandbox_participant: 1}, holders_now: 1, taken_by_transfer: {PC: 0, holders: 0, holders_by_kind: {}}});
  // bo pays cy with ana's IOU: cy accepted ana's risk without ever dealing with her. Acceptance grows; repayment does not.
  w.pass(b, a, c, 2);
  ea = await evidence(w, a);
  assert.deepEqual(bare(ea.acceptance), {holders_ever: 2, holders_by_kind: {sandbox_participant: 2}, holders_now: 1, taken_by_transfer: {PC: 2, holders: 1, holders_by_kind: {sandbox_participant: 1}}});
  assert.equal(ea.repayment.settled.by_setoff_PC, 0, 'a promise that moved is not a promise kept');
  assert.equal(ea.repayment.outstanding_PC, 2);
  // cy hires ana: their IOUs form a loop, which cancels. Now ana's IOU is settled, with one creditor.
  w.job(c, a, 2);
  w.loop([a, c], 2);
  ea = await evidence(w, a);
  assert.deepEqual(bare(ea.repayment), {owed_ever_PC: 2, settled: {by_setoff_PC: 2, creditors: 1, creditors_by_kind: {sandbox_participant: 1}}, outstanding_PC: 0, unpaid_accepted_work: {count: 0, PC: 0}});
  assert.equal(ea.delivery.accepted.count, 1, 'and ana delivered once, to cy');
  for (const k of ['delivery', 'repayment', 'acceptance', 'circle']) assert.equal(ea[k].reads_as, EVIDENCE_READS_AS[k], k);
  assert.match(ea.reads_as, /not a score/);
});

test('broken promises show where they belong: unpaid accepted work on the debtor, disputes and no-shows on the seller', async () => {
  const w = world(), a = w.person('ana'), b = w.person('bo');
  w.unpaid(a, b, 3);
  w.disputed(a, b, 1);
  w.undelivered(a, b, 2);
  const ea = await evidence(w, a), eb = await evidence(w, b);
  assert.deepEqual(ea.repayment.unpaid_accepted_work, {count: 1, PC: 3});
  assert.equal(eb.delivery.accepted.count, 1, 'the unpaid delivery was accepted: it counts for bo as a seller');
  assert.equal(eb.delivery.paid.count, 0);
  assert.equal(eb.delivery.disputed_by_buyer, 1);
  assert.equal(eb.delivery.not_delivered, 1);
  assert.equal(ea.delivery.disputed_by_buyer, 0);
});

test('counterparties are counted by kind: an invited agent, an operator-run one, self-serve participants', async () => {
  const w = world(), a = w.person('ana'), h = w.person('house-scribe', 'invited'), x = w.person('sandbox-exact', 'operator'), b = w.person('bo');
  w.job(h, a, 2); w.job(x, a, 1); w.job(b, a, 1);
  assert.deepEqual((await evidence(w, a)).delivery.accepted.buyers_by_kind, {invited: 1, sandbox_agent: 1, sandbox_participant: 1});
});

test('the record alone cannot tell a staged circle from an honest one: the same evidence, closed either way', async () => {
  const w = world();
  // One operator runs three self-serve identities and stages a circle: pretend jobs, accepted, then cancelled.
  const s = ['s1', 's2', 's3'].map(h => w.person(h, 'self_serve', {operatorName: 'one-operator'}));
  w.job(s[0], s[1], 2); w.job(s[1], s[2], 2); w.job(s[2], s[0], 2); w.loop([s[0], s[1], s[2]], 2);
  // Three genuinely independent operators do real jobs in the same pattern.
  const h = ['ana', 'bo', 'cy'].map(x => w.person(x));
  w.job(h[0], h[1], 2); w.job(h[1], h[2], 2); w.job(h[2], h[0], 2); w.loop([h[0], h[1], h[2]], 2);
  const staged = bare(await evidence(w, s[0])), honest = bare(await evidence(w, h[0]));
  assert.deepEqual(staged, honest, 'the same counts, kinds, settlement and circle');
  assert.equal(staged.circle.closed, true);
  assert.equal(staged.circle.size, 3);
  assert.equal(staged.repayment.settled.by_setoff_PC, 2);
  assert.deepEqual(groupsOf(w.pilot).map(g => [g.size, g.anchored]), [[3, false], [3, false]], 'two groups of self-serve participants only');
  // A house agent sells to anyone. Once s1 and ana each buy a tl;dr from it, both circles are open and one group.
  const house = w.person('house-scribe', 'invited');
  w.job(s[0], house, 2); w.job(h[0], house, 2);
  const opened = await evidence(w, s[0]);
  assert.equal(opened.circle.closed, false);
  assert.deepEqual(opened.circle.members_by_kind, {invited: 1, sandbox_participant: 3});
  assert.equal(opened.circle.links_outside, 1, "the house agent's link to ana");
  assert.deepEqual(bare(opened.circle), {...bare(await evidence(w, h[0])).circle}, 'and still the same evidence as the honest circle');
  assert.deepEqual(groupsOf(w.pilot).map(g => [g.size, g.anchored]), [[7, true]]);
});

test('GET /pilot/v1/evidence: network totals of the three kinds and the groups, with no participant id, handle or key', async () => {
  // Handles no word of the answer holds (the check below looks for each in the raw text).
  const w = world(), a = w.person('qx-ana'), b = w.person('qx-bo'), c = w.person('qx-cy'), h = w.person('qx-reviewer', 'invited');
  w.job(a, b, 2); w.pass(b, a, c, 2); w.job(c, a, 2); w.loop([a, c], 2); w.unpaid(b, h, 3); w.job(h, b, 1);
  const routes = createPilotRoutes({pilot: w.pilot, cfg: {pilotRateLimitPerMinute: 100000, publicCacheMs: 0}});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/pilot/v1/evidence`), text = await r.text(), body = JSON.parse(text);
    assert.equal(r.status, 200);
    assert.equal(body.unit, 'PC');
    assert.deepEqual(body.delivery, {accepted: {count: 5, PC: 10}, paid: {count: 4, PC: 7}, disputed: 0, not_delivered: 0});
    // Issued 5 (ana's 2 to bo, cy's 2 to ana, the reviewer's 1 to bo); ana's IOU moved to cy, and the loop retired both of
    // ana's and cy's: 4 of the 5 settled, the reviewer's 1 outstanding (bo's unpaid 3 is no IOU at all).
    assert.deepEqual(body.repayment, {owed_ever_PC: 5, settled: {by_setoff_PC: 4}, settled_pct: 80, outstanding_PC: 1, unpaid_accepted_work: {count: 1, PC: 3}});
    assert.deepEqual(body.acceptance, {taken_by_transfer: {count: 1, PC: 2}});
    assert.deepEqual(body.groups, {count: 1, anchored: 1, self_serve_only: 0, largest: 4, self_serve_only_sizes: []});
    assert.equal(body.participants_with_exchanges, 4);
    for (const p of [a, b, c, h]) for (const secret of [p.id, p.pubkey, p.handle]) assert.ok(!text.includes(secret), `no ${secret}`);
    assert.match(body.reads_as.groups, /staged circle/);
  } finally { server.close(); }
});

test('with circulation off there is no evidence and no route', async () => {
  const w = world({mode: 'off'}), a = w.person('ana');
  const pos = await w.pilot.publicPosition(a);
  assert.equal(pos.evidence, undefined);
  const routes = createPilotRoutes({pilot: w.pilot, cfg: {pilotRateLimitPerMinute: 100000, publicCacheMs: 0}});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // No public route: it falls through to the authenticated ones, as GET /clearing does in this mode.
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/pilot/v1/evidence`)).status, 401); } finally { server.close(); }
});
