// Fix inbox #13, #14 and the loop pages' explorer links, on the testnet network (its own process): the tracker's
// anchoring state (anchored, waiting for the next update, an update in flight, overdue), which tracker-box update
// committed a loop's netting (from the wallet adapter's spend ledger), a deal's note as the tracker holds it now
// (confirmed, redeemed), the position's redemptions, the wait hints of deal views, and a redemption refused for a note
// not anchored yet (it says how long that lasts, and it uses up no build).
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const anchors = await import('../lib/pilot/anchors.mjs');
const core = await import('../lib/pilot/core.mjs');
const routes = await import('../lib/pilot/http.mjs');
const loops = await import('../lib/pilot/loops.mjs');
const {BasisError} = await import('../lib/basis.mjs');

const H = c => c.repeat(64);
const ledgerFile = rows => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-anchors-')), 'spend-ledger.jsonl');
  fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
// The ledger of the live testnet's first hours, shortened: the mint, two updates, a redemption (not an update), an update
// that was dropped and resubmitted (both spend the same tracker box), and one more.
const LEDGER = [
  {t: '2026-11-12T14:04:30.990Z', kind: 'bootstrap', tx_id: H('0'), inputs: [H('9')]},
  {t: '2026-11-12T14:42:20.573Z', kind: 'tracker_box', tx_id: H('1'), inputs: [H('a'), H('f')]},
  {t: '2026-11-12T15:03:46.369Z', kind: 'tracker_box', tx_id: H('2'), inputs: [H('b'), H('f')]},
  {t: '2026-11-12T15:10:00.000Z', kind: 'tracker_tx', tx_id: H('e'), inputs: [H('d')]},
  {t: '2026-11-12T17:05:57.895Z', kind: 'tracker_box', tx_id: H('3'), inputs: [H('c')]},
  {t: '2026-11-12T17:35:57.000Z', kind: 'tracker_box', tx_id: H('4'), inputs: [H('c')]},
  {t: '2026-11-12T22:27:46.503Z', kind: 'tracker_box', tx_id: H('5'), inputs: [H('7')]},
];

test('the spend ledger gives the tracker-box updates; a dropped one (its box spent again by the next) is left out', () => {
  const rows = anchors.trackerBoxUpdates(ledgerFile(LEDGER));
  assert.deepEqual(rows.map(r => r.tx_id), [H('1'), H('2'), H('4'), H('5')]);
  assert.equal(rows[0].t, Date.parse('2026-11-12T14:42:20.573Z'));
  assert.deepEqual(anchors.trackerBoxUpdates(null), []);
  assert.deepEqual(anchors.trackerBoxUpdates('/nonexistent/spend-ledger.jsonl'), []);
  const st = {local_digest: 'x', confirmed_digest: 'y', pending_tx_id: H('5')};
  assert.deepEqual(anchors.confirmedUpdates(rows, st).map(r => r.tx_id), [H('1'), H('2'), H('4')], 'the update in flight is not confirmed');
  assert.deepEqual(anchors.confirmedUpdates(rows, {}, H('2')).map(r => r.tx_id), [H('1'), H('2')], 'up to the confirmed box the node names');
});

test('a loop is committed in the first confirmed update signed after it; one signed just after it counts only while anchored', () => {
  const rows = anchors.trackerBoxUpdates(ledgerFile(LEDGER));
  const anchored = {local_digest: 'd', confirmed_digest: 'd', pending_tx_id: null};
  const changed = {local_digest: 'e', confirmed_digest: 'd', pending_tx_id: null};
  // the three set-offs of the live netting run (applied about 15:00, committed in the update of 15:03:46)
  assert.equal(anchors.loopAnchor('2026-11-12T15:00:10.000Z', rows, changed).tx_id, H('2'));
  assert.equal(anchors.loopAnchor('2026-11-12T22:30:00.000Z', rows, changed), null, 'no update since: not committed yet');
  assert.equal(anchors.loopAnchor('garbage', rows, anchored), null);
  // within the guard: the next update counts only if it is the last confirmed one and the state is anchored now
  const near = new Date(Date.parse('2026-11-12T22:27:46.503Z') - 5_000).toISOString();
  assert.equal(anchors.loopAnchor(near, rows, anchored).tx_id, H('5'));
  assert.equal(anchors.loopAnchor(near, rows, changed), null);
  const nearEarlier = new Date(Date.parse('2026-11-12T15:03:46.369Z') - 5_000).toISOString();
  assert.equal(anchors.loopAnchor(nearEarlier, rows, changed).tx_id, H('4'), 'else the next one surely commits it');
});

test('the anchoring state: anchored, an update in flight, waiting for the next update, then overdue (a fault)', () => {
  let now = 1_000_000;
  const w = new anchors.AnchorWatch({now: () => now});
  assert.equal(w.state({local_digest: 'a', confirmed_digest: 'a'}).state, 'anchored');
  assert.equal(w.state({local_digest: 'b', confirmed_digest: 'a', pending_tx_id: H('1')}).state, 'update_in_flight');
  const waiting = w.state({local_digest: 'b', confirmed_digest: 'a', pending_tx_id: null});
  assert.equal(waiting.state, 'waiting_for_next_update');
  assert.equal(waiting.unanchored_since, new Date(1_000_000).toISOString());
  assert.match(waiting.what_this_means, new RegExp(`checks every ${anchors.CHECK_INTERVAL_S} seconds`));
  now += (anchors.CHECK_INTERVAL_S + anchors.OVERDUE_GRACE_S) * 1000 + 1;
  const late = w.state({local_digest: 'c', confirmed_digest: 'a', pending_tx_id: null});
  assert.equal(late.state, 'overdue');
  assert.equal(late.unanchored_since, new Date(1_000_000).toISOString(), 'since the state first went unanchored');
  assert.match(late.what_this_means, /a fault of the tracker/);
  assert.equal(w.state({local_digest: 'c', confirmed_digest: 'c'}).state, 'anchored');
  assert.equal(w.since, null);
  assert.equal(w.state(null).state, 'unknown');
});

test('the owner\'s daily cap: once used up, the state says so and when it resets, never that the tracker failed', () => {
  const now = Date.parse('2026-11-13T22:10:00Z');
  const f = ledgerFile([
    {t: '2026-11-12T23:59:59.000Z', kind: 'tracker_box', tx_id: H('1'), inputs: [H('a')]},        // yesterday
    {t: '2026-11-13T21:41:03.087Z', kind: 'tracker_box', tx_id: H('2'), inputs: [H('b')]},
    {t: '2026-11-13T21:38:27.898Z', kind: 'tracker_tx', tx_id: H('3'), inputs: [H('c')]},         // not a tracker box
    {t: '2026-11-13T21:41:34.577Z', kind: 'tracker_box', tx_id: H('4'), inputs: [H('d')]},
  ]);
  assert.deepEqual(anchors.dailyCap(f, now), {limit: 50, signed_today: 2, used_up: false, resets_at: '2026-11-14T00:00:00.000Z'});
  const cap = anchors.dailyCap(f, now, 2);
  assert.equal(cap.used_up, true);
  assert.deepEqual(anchors.dailyCap(null, now), {limit: 50, signed_today: 0, used_up: false, resets_at: '2026-11-14T00:00:00.000Z'});
  // The wallet adapter enforces the same cap (ergo/chain.mjs; read as text: the server does not load ergo-lib).
  const adapter = fs.readFileSync(new URL('../ergo/chain.mjs', import.meta.url), 'utf8');
  assert.equal(Number(/DEFAULT_DAILY_TRACKER_SIGNATURES = (\d+);/.exec(adapter)[1]), anchors.DAILY_TRACKER_SIGNATURES);

  let t = Date.parse('2026-11-13T21:43:02.087Z');
  const w = new anchors.AnchorWatch({now: () => t});
  const changed = {local_digest: 'b', confirmed_digest: 'a', pending_tx_id: null};
  assert.equal(w.state(changed, cap).state, 'daily_cap_reached');
  t += (anchors.CHECK_INTERVAL_S + anchors.OVERDUE_GRACE_S) * 1000 + 1;              // long past "overdue"
  const s = w.state(changed, cap);
  assert.equal(s.state, 'daily_cap_reached');
  assert.equal(s.resumes_at, '2026-11-14T00:00:00.000Z');
  assert.equal(s.unanchored_since, '2026-11-13T21:43:02.087Z');
  assert.match(s.what_this_means, /daily cap of 2 tracker boxes \(per UTC day\) is used up: the next box is posted after 2026-11-14T00:00:00\.000Z/);
  assert.match(s.what_this_means, /not a fault/);
  assert.doesNotMatch(s.what_this_means, /a fault of the tracker/);
  assert.equal(w.state(changed, {...cap, used_up: false}).state, 'overdue', 'with room under the cap, a long wait is still a fault');
  assert.equal(w.state({...changed, pending_tx_id: H('5')}, cap).state, 'update_in_flight');
  assert.equal(w.state({local_digest: 'a', confirmed_digest: 'a'}, cap).state, 'anchored');
});

test('GET /chain names the daily cap, and its state when the cap is used up', async () => {
  const day = new Date().toISOString().slice(0, 10), start = Date.parse(`${day}T00:00:00.000Z`);
  const today = Array.from({length: 50}, (_, i) => ({t: new Date(start + i).toISOString(), kind: 'tracker_box', tx_id: H((i % 16).toString(16)), inputs: [H('e')]}));
  const unanchored = async () => ({local_digest: 'e', confirmed_digest: 'd', confirmed_box_id: H('c'), confirmed_height: 642814, pending_tx_id: null});
  const {srv, call} = await server({trackerState: unanchored, spendLedger: ledgerFile(today.slice(0, 49))});
  try {
    const chain = (await call('GET', '/pilot/v1/chain')).body.anchoring;
    assert.equal(chain.state, 'waiting_for_next_update');
    assert.deepEqual(chain.daily_cap, {limit: 50, signed_today: 49, resets_at: new Date(start + 864e5).toISOString()});
  } finally { srv.close(); }
  const s2 = await server({trackerState: unanchored, spendLedger: ledgerFile(today)});
  try {
    const chain = (await s2.call('GET', '/pilot/v1/chain')).body.anchoring;
    assert.equal(chain.state, 'daily_cap_reached');
    assert.equal(chain.daily_cap.signed_today, 50);
    assert.equal(chain.resumes_at, new Date(start + 864e5).toISOString());
  } finally { s2.srv.close(); }
});

test('the transaction of the confirmed box, from the node, once per box', async () => {
  let asked = 0;
  const fetchFn = async url => { asked++; assert.equal(url, `http://node/utxo/byId/${H('b')}`); return {ok: true, json: async () => ({transactionId: H('2')})}; };
  assert.equal(await anchors.creatingTx('http://node', H('b'), {fetchFn}), H('2'));
  assert.equal(await anchors.creatingTx('http://node', H('b'), {fetchFn}), H('2'));
  assert.equal(asked, 1);
  assert.equal(await anchors.creatingTx('http://node', 'not-a-box', {fetchFn}), null);
  assert.equal(await anchors.creatingTx(null, H('c'), {fetchFn}), null);
  assert.equal(await anchors.creatingTx('http://node', H('c'), {fetchFn: async () => { throw new Error('down'); }}), null);
});

test('a deal\'s note as the tracker holds it now: confirmed once anchored, settled once redeemed (fix inbox #13)', async () => {
  const deal = (amount, after) => ({id: 'vd_x', credit_note: {state: 'recorded', amount, issuer_pubkey: 'pa', recipient_pubkey: 'pb', outstanding: true, settled: false,
    tracker_note: {amount_collected: after, amount_redeemed: 0, confirmation: 'local_only'}}});
  const self = (note, extra = {}) => ({basis: {note: async () => note}, unit: 'nanoERG', circulating: false, pairChangesSince: () => [], ...extra});
  const live = (s, d) => core.Pilot.prototype.liveNote.call(s, d, d.credit_note);
  // the welcome note of basis-testnet-grok: 3000000, then redeemed in full on chain
  let v = await live(self({amount_collected: 3_000_000, amount_redeemed: 3_000_000, confirmation: {status: 'confirmed'}}), deal(3_000_000, 3_000_000));
  assert.equal(v.confirmation, 'confirmed');
  assert.deepEqual(v.tracker_note, {amount_collected: 3_000_000, amount_redeemed: 0, confirmation: 'confirmed', confirmation_when_recorded: 'local_only'});
  assert.deepEqual(v.pair_now, {total: 3_000_000, redeemed: 3_000_000, outstanding: 0, unit: 'nanoERG'});
  assert.equal(v.redeemed, 3_000_000);
  assert.equal(v.outstanding, false);
  assert.equal(v.settled, true);
  assert.match(v.settled_how, /redeemed on Ergo testnet/);
  // a later note on the same pair: redemptions settle the pair's total from the first unit on
  v = await live(self({amount_collected: 5_000_000, amount_redeemed: 3_000_000, confirmation: {status: 'confirmed'}}), deal(2_000_000, 5_000_000));
  assert.equal(v.redeemed, 0);
  assert.equal(v.outstanding, true);
  v = await live(self({amount_collected: 5_000_000, amount_redeemed: 4_000_000, confirmation: {status: 'confirmed'}}), deal(2_000_000, 5_000_000));
  assert.equal(v.redeemed, 1_000_000);
  assert.equal(v.outstanding, true);
  assert.match(v.settled_how, /^partly redeemed on Ergo testnet: 1000000 nanoERG \(0\.001 tERG\) of 2000000 nanoERG/);
  // not anchored yet: local_only, nothing redeemed
  v = await live(self({amount_collected: 2_000_000, amount_redeemed: 0, confirmation: {status: 'local_only'}}), deal(2_000_000, 2_000_000));
  assert.equal(v.confirmation, 'local_only');
  assert.equal(v.outstanding, true);
  // a pair a transfer or set-off changed since: its live totals only
  v = await live(self({amount_collected: 1_000_000, amount_redeemed: 1_000_000, confirmation: {status: 'confirmed'}}, {circulating: true, pairChangesSince: () => [{kind: 'setoff'}]}), deal(2_000_000, 2_000_000));
  assert.equal(v.redeemed, undefined);
  assert.equal(v.outstanding, true);
  assert.equal(v.pair_now.redeemed, 1_000_000);
  // the tracker unreadable, or no note: the view as recorded
  const d = deal(2_000_000, 2_000_000);
  assert.equal(await live({...self(null), basis: {note: async () => { throw new BasisError('down'); }}}, d), d.credit_note);
  assert.equal(await live(self(null), d), d.credit_note);
});

test('the testnet position counts redemptions as settled, in the testnet\'s words (fix inbox #13, #15)', async () => {
  const rows = [{recipient: 'vp_me', issuer: 'vp_x', issuer_handle: 'sandbox-exact', outstanding: 0, redeemed: 3_000_000},
    {recipient: 'vp_y', issuer: 'vp_me', recipient_handle: 'house-scribe', outstanding: 2_000_000, redeemed: 0}];
  const self = {ledger: async () => rows, dealsFor: () => [], sweep: d => d, circulating: true, unit: 'nanoERG', s: {edges: {}},
    keysOf: () => new Set(['pk']), isPastKey: () => false, operatorRun: () => false, serverRun: () => false, heldForBackers: () => 0};
  const pos = await core.Pilot.prototype.position.call(self, {id: 'vp_me'});
  assert.equal(pos.redeemed_claims, 3_000_000);
  assert.equal(pos.redeemed_debts, 0);
  assert.equal(pos.settled, 3_000_000);
  // settled keeps its name and its sum; its words keep a set-off (cleared, committed, not final) apart from a redemption.
  assert.equal(pos.settled_how, 'cleared in loops, committed but not final, and redeemed on Ergo testnet');
  assert.doesNotMatch(pos.meaning, /pilot|Nothing is redeemed|there is no reserve|also settled|settled counts both/);
  assert.match(pos.meaning, /A claim is settled only when its holder redeems it on Ergo testnet/);
  assert.ok(pos.meaning.includes('The field settled adds the two kinds, so read them apart: cleared_by_setoff (cleared in loops), redeemed_claims'));
});

// Every deal on the testnet carries labels.settlement, which agents read and relay: a netting is committed, never final
// (fix inbox #85, #100: 0360f51 fixed /info, /chain and /loops; this label still said "stays final"). No server text,
// and no README line, says a netting stays final.
test('the deal\'s settlement label says a netting is committed, and committed only as long as the tracker key never commits an earlier total again', () => {
  assert.ok(core.CIRCULATION_SETTLEMENT_TESTNET.includes('a netting is committed once a tracker box on Ergo testnet commits it, and stays committed only as long as the tracker key never commits an earlier total again.'));
  assert.doesNotMatch(core.CIRCULATION_SETTLEMENT_TESTNET, /\bfinal\b/);
  const root = path.resolve(import.meta.dirname, '..');
  for (const f of [...fs.readdirSync(path.join(root, 'lib', 'pilot')).filter(x => x.endsWith('.mjs')).map(x => path.join('lib', 'pilot', x)), path.join('lib', 'a2a.mjs'), 'README.md'])
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /stays final|\bis final once\b|nettings? (?:are|is) final/, f);
});

test('deal views say how long to wait for the other side (fix inbox #8)', () => {
  const sandbox = {id: 'vp_s'}, agent = {id: 'vp_a'}, me = {id: 'vp_me'};
  const self = run => ({s: {participants: {vp_s: sandbox, vp_a: agent, vp_me: me}}, serverRun: p => p === sandbox,
    current: d => ({by: d.by}), ...run});
  const hint = (d, actions = []) => core.Pilot.prototype.waitHint.call(self(), d, me, actions);
  assert.equal(hint({status: 'open', by: 'vp_me', payer: 'vp_me', payee: 'vp_a'}), 20, 'my offer to an agent');
  assert.equal(hint({status: 'open', by: 'vp_me', payer: 'vp_me', payee: 'vp_s'}), 5, 'my offer to a sandbox agent');
  assert.equal(hint({status: 'open', by: 'vp_a', payer: 'vp_me', payee: 'vp_a'}), null, 'their offer: my turn');
  assert.equal(hint({status: 'agreed', payer: 'vp_me', payee: 'vp_a'}), 30, 'they deliver');
  assert.equal(hint({status: 'agreed', payer: 'vp_a', payee: 'vp_me'}), null, 'I deliver');
  assert.equal(hint({status: 'delivered', payer: 'vp_a', payee: 'vp_me'}), 60, 'they review my delivery');
  assert.equal(hint({status: 'delivered', payer: 'vp_me', payee: 'vp_a'}), null, 'I review');
  assert.equal(hint({status: 'note_issued', payer: 'vp_me', payee: 'vp_a'}), null);
  assert.equal(hint({status: 'open', by: 'vp_me', payer: 'vp_me', payee: 'vp_a'}, ['wait_for_owner_approval']), 60);
  assert.equal(hint({status: 'paying_by_transfer', payer: 'vp_me', payee: 'vp_a'}, ['wait_for_consents']), 10);
});

// fix inbox #62: the confirmed box's age and its two windows, and the anchored text that says what holds while the box
// is fresh.
test('the box\'s windows: novations refused from its height + 1440, tracker-less redemption from + 2161; its age from the node', () => {
  const caps = fs.readFileSync(new URL('../lib/pilot/caps.mjs', import.meta.url), 'utf8');
  assert.match(caps, /ANCHORED_NETTING = Object\.freeze\(\{version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720\}\)/, 'the tracker\'s fresh_blocks');
  assert.equal(anchors.TRACKER_LESS_AFTER_BLOCKS, 2160, 'the reserve contract: HEIGHT - creation height > 3 * 720');
  assert.deepEqual(anchors.boxWindows(645189, 645300), {node_height: 645300, box_age_blocks: 111, novations_refused_from_height: 646629, tracker_less_redemption_from_height: 647350});
  assert.deepEqual(anchors.boxWindows(645189, 645189), {node_height: 645189, box_age_blocks: 0, novations_refused_from_height: 646629, tracker_less_redemption_from_height: 647350});
  assert.deepEqual(anchors.boxWindows(645189, 645100), {node_height: 645100, box_age_blocks: null, novations_refused_from_height: 646629, tracker_less_redemption_from_height: 647350},
    'a node behind the box cannot tell its age');
  assert.deepEqual(anchors.boxWindows(645189, null), {node_height: null, box_age_blocks: null, novations_refused_from_height: 646629, tracker_less_redemption_from_height: 647350});
  for (const h of [null, undefined, 0, -5, 1.5, '645189', 2 ** 53]) {
    assert.deepEqual(anchors.boxWindows(h, 645300), {node_height: 645300, box_age_blocks: null, novations_refused_from_height: null, tracker_less_redemption_from_height: null}, String(h));
  }
});

test('the node\'s height: GET /info fullHeight, kept 20 s per node, a failed read 5 s; null for anything but a positive whole number', async () => {
  const asked = [];
  let answer = () => ({ok: true, json: async () => ({fullHeight: 645300, headersHeight: 645301})});
  const fetchFn = async url => { asked.push(url); return answer(); };
  const node = 'http://node-a.invalid', t0 = 1_000_000, at = t => ({fetchFn, clock: () => t});
  assert.equal(await anchors.nodeHeight(`${node}/`, at(t0)), 645300);
  assert.deepEqual(asked, [`${node}/info`]);
  assert.equal(await anchors.nodeHeight(`${node}/`, at(t0 + anchors.NODE_HEIGHT_KEEP_MS - 1)), 645300);
  assert.equal(asked.length, 1, 'kept');
  answer = () => ({ok: true, json: async () => ({fullHeight: 645301})});
  assert.equal(await anchors.nodeHeight(`${node}/`, at(t0 + anchors.NODE_HEIGHT_KEEP_MS)), 645301, 'read again once 20 s old');
  for (const [i, bad] of [() => ({ok: false, json: async () => ({})}), () => ({ok: true, json: async () => ({fullHeight: 0})}),
    () => ({ok: true, json: async () => ({fullHeight: '645300'})}), () => ({ok: true, json: async () => { throw new SyntaxError('not JSON'); }}),
    () => { throw new TypeError('fetch failed'); }].entries()) {
    answer = bad;
    const other = `http://node-b${i}.invalid`, n = asked.length;
    assert.equal(await anchors.nodeHeight(other, at(t0)), null, `answer ${i}`);
    answer = () => ({ok: true, json: async () => ({fullHeight: 7})});
    assert.equal(await anchors.nodeHeight(other, at(t0 + anchors.NODE_HEIGHT_FAILED_KEEP_MS - 1)), null, `answer ${i}: the failure is kept 5 s`);
    assert.equal(asked.length, n + 1, `answer ${i}: one read`);
    assert.equal(await anchors.nodeHeight(other, at(t0 + anchors.NODE_HEIGHT_FAILED_KEEP_MS)), 7, `answer ${i}: read again after 5 s`);
  }
  const before = asked.length;
  for (const bad of [null, undefined, '', 'node', 'ftp://node', 5]) assert.equal(await anchors.nodeHeight(bad, {fetchFn}), null, String(bad));
  assert.equal(asked.length, before, 'no node, no read');
});

test('the node\'s height: a read that hangs is kept from when it ends, and the readers meanwhile share it (a hung node costs one wait per 5 s)', async () => {
  // A clock the read itself moves on: the node takes the whole timeout to fail, as a node that accepts and never
  // answers does. Kept from when the read began, the failure would be read again 1 s after it ended.
  let t = 2_000_000, asked = 0;
  const hang = async () => { asked++; t += 4000; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const node = 'http://node-hung.invalid', opts = {fetchFn: hang, clock: () => t};
  assert.equal(await anchors.nodeHeight(node, opts), null);
  t += anchors.NODE_HEIGHT_FAILED_KEEP_MS - 1000;
  assert.equal(await anchors.nodeHeight(node, opts), null);
  assert.equal(asked, 1, '4 s after the read ended (8 s after it began): kept');
  t += 1000;
  assert.equal(await anchors.nodeHeight(node, opts), null);
  assert.equal(asked, 2, 'read again 5 s after it ended');
  // Real time, a node that accepts the connection and never answers: 25 readers at once make one request and share its
  // wait; a read right after it ended is kept.
  let requests = 0;
  const hung = http.createServer(() => { requests++; });
  await new Promise(r => hung.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hung.address().port}`;
  try {
    const t0 = Date.now();
    const all = await Promise.all(Array.from({length: 25}, () => anchors.nodeHeight(url, {timeoutMs: 300})));
    assert.deepEqual([[...new Set(all)], requests], [[null], 1], 'one request for 25 readers');
    assert.ok(Date.now() - t0 >= 250, 'they waited for that one read');
    const t1 = Date.now();
    assert.equal(await anchors.nodeHeight(url, {timeoutMs: 300}), null);
    assert.ok(Date.now() - t1 < 200, 'kept: no second wait');
    assert.equal(requests, 1);
  } finally { hung.closeAllConnections?.(); hung.close(); }
});

test('the anchored text says what holds while the box is fresh, names the fields that say how old it is, and the tracker\'s other refusals of a novation', () => {
  const s = new anchors.AnchorWatch().state({local_digest: 'a', confirmed_digest: 'a'});
  assert.equal(s.state, 'anchored');
  assert.equal(s.what_this_means, "The tracker box on Ergo testnet commits the tracker's current state: every note recorded so far can be redeemed against a tERG reserve locked under the key that signed it (if one was posted), and every netting so far is committed (it stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model). The tracker builds a redemption only while its records of what the box commits agree with the box. A set-off or transfer that lowers an edge with an on-chain total needs the box fresh, younger than 1440 blocks (box_age_blocks): the tracker refreshes an unchanged box every 720 blocks to keep it so, and refuses such a novation from novations_refused_from_height until the next box. It may refuse one sooner: when it has not observed its box on chain for 2 hours (it observes it on each update check in which it can read the box and the node and no update is waiting to confirm), and when the novation would lower the edge below a total it signed a redemption for. From tracker_less_redemption_from_height (2161 blocks after the box was made) the reserve contract lets a holder redeem without the tracker's signature.");
  assert.equal(anchors.ANCHORED_MEANS, s.what_this_means);
  assert.doesNotMatch(s.what_this_means, /are accepted/, 'never a promise that the tracker accepts a novation');
  // the tracker v4.4 value the text states (basis_store ANCHOR_OBSERVATION_MAX_AGE_MS; GET /capabilities
  // anchored_netting.observation_max_age_ms)
  assert.equal(anchors.TRACKER_OBSERVATION_MAX_AGE_MS, 7_200_000);
});

test('GET /chain: the box\'s age from the node (its fullHeight less the confirmed height) and the two windows; without the node, the windows alone', async () => {
  const node = http.createServer((req, res) => {
    if (req.url !== '/info') { res.writeHead(404).end(); return; }
    res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({network: 'testnet', fullHeight: 645300, headersHeight: 645300}));
  });
  await new Promise(r => node.listen(0, '127.0.0.1', r));
  const nodeUrl = `http://127.0.0.1:${node.address().port}`;
  const st = {local_digest: 'd', confirmed_digest: 'd', confirmed_box_id: H('c'), confirmed_height: 645189, pending_tx_id: null};
  const {srv, call} = await server({trackerState: async () => st, node: nodeUrl});
  try {
    const a = (await call('GET', '/pilot/v1/chain')).body.anchoring;
    assert.deepEqual([a.confirmed_height, a.node_height, a.box_age_blocks, a.novations_refused_from_height, a.tracker_less_redemption_from_height], [645189, 645300, 111, 646629, 647350]);
    assert.equal(a.box_age_blocks, a.node_height - a.confirmed_height);
    assert.equal(a.state, 'anchored');
    assert.equal(a.what_this_means, anchors.ANCHORED_MEANS);
  } finally { srv.close(); node.close(); }
  // the node unreachable (nothing listens on port 9): no height and no age, the windows from the box's height all the same
  const s3 = await server({trackerState: async () => st, node: 'http://127.0.0.1:9'});
  try {
    const a = (await s3.call('GET', '/pilot/v1/chain')).body.anchoring;
    assert.deepEqual([a.node_height, a.box_age_blocks, a.novations_refused_from_height, a.tracker_less_redemption_from_height], [null, null, 646629, 647350]);
    assert.equal(a.state, 'anchored', 'the anchoring itself is read as before');
  } finally { s3.srv.close(); }
  // no confirmed height yet: every field null, and the node is not asked
  let asked = 0;
  const probe = http.createServer((req, res) => { asked++; res.writeHead(200).end('{"fullHeight": 1}'); });
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const s4 = await server({trackerState: async () => ({...st, confirmed_height: null}), node: `http://127.0.0.1:${probe.address().port}`});
  try {
    const a = (await s4.call('GET', '/pilot/v1/chain')).body.anchoring;
    assert.deepEqual([a.node_height, a.box_age_blocks, a.novations_refused_from_height, a.tracker_less_redemption_from_height], [null, null, null, null]);
    assert.equal(asked, 0);
  } finally { s4.srv.close(); probe.close(); }
});

// The routes, with a fake tracker client and a spend ledger on disk. `extra`: more of the pilot (positions, records).
async function server({trackerState, redemptionBuild, setoffs = {}, spendLedger = null, node = undefined, extra = {}}) {
  const PKA = '02' + 'a1'.repeat(32), PKB = '03' + 'b2'.repeat(32);
  const participants = {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA, status: 'active'},
    vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb', handle: 'holder-b', pubkey: PKB, status: 'active'}};
  const basis = {denomination: 'erg', nft: 'ab'.repeat(32), trackerState,
    note: async () => ({amount_collected: 3_000_000, amount_redeemed: 0, timestamp: 1_700_000_000_123, signature: 'aa'.repeat(65)}),
    redemptionBuild};
  const pilot = {chain: {name: 'ergo-testnet', on_chain: true, tracker_nft_id: 'ab'.repeat(32), explorer: 'https://testnet.ergoplatform.com', spend_ledger: spendLedger, ...(node === undefined ? {} : {node})},
    s: {participants, setoffs, approvals: {}}, openSandbox: true, unit: 'nanoERG', mode: 'off', basis, store: {audit: () => {}}, selfServe: () => null,
    setoff: id => setoffs[id] ?? null, publicParticipant: x => ({handle: x.handle}),
    byPubkey: pk => Object.values(participants).find(x => x.pubkey === pk) || null,
    authenticate: t => (t === 'vpa_b' ? {role: 'agent', p: participants.vp_bbbbbbbbbbbb} : null), ...extra};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body, type) => { r.writeHead(status, {'content-type': type || 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      const m = /^\/loop\/(.+)$/.exec(url.pathname);
      if (m) return await handler.loopPage(req, res, m[1], send, () => '127.0.0.1');
      const a = /^\/agent\/(.+)$/.exec(url.pathname);
      if (a) return await handler.agentPage(req, res, a[1], send, () => '127.0.0.1');
      await handler(req, res, url, send, () => '127.0.0.1');
    } catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message}); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return {status: r.status, body: json, text};
  };
  return {srv, call};
}

test('loops on the testnet link the tracker-box update that committed them; GET /chain names the last update', async () => {
  const id = 'vs_0123456789abcdef';
  const setoffs = {[id]: {id, state: 'applied', applied_at: '2026-11-12T15:00:10.000Z', amount: 2_000_000, members: ['vp_aaaaaaaaaaaa', 'vp_bbbbbbbbbbbb']}};
  const {srv, call} = await server({trackerState: async () => ({local_digest: 'e', confirmed_digest: 'd', confirmed_box_id: H('c'), confirmed_height: 640110, pending_tx_id: null}),
    setoffs, spendLedger: ledgerFile(LEDGER)});
  try {
    const one = await call('GET', `/pilot/v1/loops/${id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.on_chain, {anchored: true, tx_id: H('2'), explorer_url: `https://testnet.ergoplatform.com/en/transactions/${H('2')}`,
      signed_at: '2026-11-12T15:03:46.369Z', what_this_means: 'Committed on Ergo testnet by the first tracker-box update signed after the set-off (matched by time; valun audit checks only the current box). It stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model.'});
    const all = await call('GET', '/pilot/v1/loops');
    assert.equal(all.body.loops[0].on_chain.tx_id, H('2'));
    const page = await call('GET', `/loop/${id}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<a href="https://testnet.ergoplatform.com/en/transactions/${H('2')}">tx ${H('2').slice(0, 12)}…</a>`));
    assert.ok(page.text.includes('<strong>Committed on Ergo testnet</strong> by the next tracker box'), 'said in the past tense once a box committed it');
    assert.ok(page.text.includes('<dd>0.002 tERG</dd>'), 'amounts as people read them, in tERG');
    assert.doesNotMatch(page.text, /pilot network|credits have no/);
    // What a commitment guarantees, on the card itself (fix inbox #85, #100): committed, not final, with its condition,
    // who holds the key, and the Trust model.
    assert.ok(page.text.includes("Nobody's net position changed, the work stays done, and no coins moved."));
    assert.ok(page.text.includes('Committed, not final: a netting the tracker commits stays committed as long as the tracker key never commits an earlier total again. The operator holds that key, and nothing on chain stops it.'));
    assert.ok(page.text.includes('<a href="/trust#netting">How netting is committed</a>') && page.text.includes('<a href="/trust">Trust model</a>'));
    assert.doesNotMatch(page.text, /\bis final\b|\bare final\b|stays final|debt is gone/);
    const chain = await call('GET', '/pilot/v1/chain');
    assert.equal(chain.body.anchoring.state, 'waiting_for_next_update');
    assert.deepEqual(chain.body.anchoring.last_update, {tx_id: H('5'), signed_at: '2026-11-12T22:27:46.503Z', explorer_url: `https://testnet.ergoplatform.com/en/transactions/${H('5')}`});
  } finally { srv.close(); }
  // no update after the set-off yet
  const late = {[id]: {...setoffs[id], applied_at: '2026-11-12T23:00:00.000Z'}};
  const s2 = await server({trackerState: async () => ({local_digest: 'e', confirmed_digest: 'd', pending_tx_id: null}), setoffs: late, spendLedger: ledgerFile(LEDGER)});
  try {
    const one = await s2.call('GET', `/pilot/v1/loops/${id}`);
    assert.equal(one.body.on_chain.anchored, false);
    // Not committed yet: the next box commits it, usually in minutes, up to about 30 while Ergo testnet blocks are slow, and
    // not before 00:00 UTC once the day's boxes ran out; the loop API and the card say the same (the redesign, round 2).
    assert.equal(one.body.on_chain.what_this_means, `Not committed on chain yet: the next tracker box commits it, usually within minutes, up to about 30 when Ergo testnet blocks are slow, and once the day's 50 boxes are used up, not before 00:00 UTC (the tracker checks every ${anchors.CHECK_INTERVAL_S} seconds; GET /pilot/v1/chain shows its anchoring).`);
    const card = (await s2.call('GET', `/loop/${id}`)).text;
    assert.ok(card.includes('<strong>Not committed on Ergo testnet yet.</strong> The next tracker box commits it, usually within minutes, up to about 30 when Ergo testnet blocks are slow.'));
    assert.ok(card.includes('The tracker posts at most 50 boxes a UTC day: on a busy day they run out, and nothing is committed until 00:00 UTC'));
    assert.doesNotMatch(card + one.body.on_chain.what_this_means, /\bfinal yet\b|within 8 minutes|few minutes|two minutes/);
  } finally { s2.srv.close(); }
});

// Fix inbox #85, #100: a netting revokes nothing on chain, so no anchoring state may call nettings final without the
// Trust model's condition. 103b25f qualified the anchored state only; the in-flight, waiting and daily-cap states still
// said "the nettings ... are final" (GET /chain, also printed by `valun ergo chain`).
test('every anchoring state that speaks of nettings says committed, and committed only as long as the tracker key never commits an earlier total again', () => {
  let now = 1_000_000;
  const w = new anchors.AnchorWatch({now: () => now});
  const day = new Date(now).toISOString().slice(0, 10);
  const states = {
    anchored: w.state({local_digest: 'a', confirmed_digest: 'a'}),
    update_in_flight: w.state({local_digest: 'b', confirmed_digest: 'a', pending_tx_id: H('1')}),
    waiting_for_next_update: w.state({local_digest: 'b', confirmed_digest: 'a', pending_tx_id: null}),
    daily_cap_reached: w.state({local_digest: 'b', confirmed_digest: 'a', pending_tx_id: null}, {limit: 50, signed_today: 50, used_up: true, resets_at: `${day}T23:59:59.000Z`}),
  };
  now += (anchors.CHECK_INTERVAL_S + anchors.OVERDUE_GRACE_S) * 1000 + 1;
  states.overdue = w.state({local_digest: 'c', confirmed_digest: 'a', pending_tx_id: null});
  states.unknown = w.state(null);
  assert.equal(anchors.NETTING_FINALITY, 'it stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model');
  for (const [name, s] of Object.entries(states)) {
    assert.equal(s.state, name);
    assert.doesNotMatch(s.what_this_means, /\bare final\b|\bis final\b|\bfinal once\b|nettings? (?:before|since) (?:it|then) (?:are|is) final/, `${name}: never "final" alone`);
    if (/netting/.test(s.what_this_means) && name !== 'overdue')
      assert.ok(s.what_this_means.includes(`committed (${anchors.NETTING_FINALITY})`), `${name}: committed, with the Trust model's condition`);
  }
  assert.match(states.overdue.what_this_means, /the nettings since then are not committed on chain/);
  assert.deepEqual(Object.keys(states).filter(k => /netting/.test(states[k].what_this_means)).sort(),
    ['anchored', 'daily_cap_reached', 'overdue', 'update_in_flight', 'waiting_for_next_update']);
  // The loop views use the same condition (lib/pilot/http.mjs loopOnChain; the card's footer), and say how the box is
  // matched to the loop: by time, as the card does.
  const src = fs.readFileSync(new URL('../lib/pilot/http.mjs', import.meta.url), 'utf8');
  assert.match(src, /by the first tracker-box update signed after the set-off \(matched by time; valun audit checks only the current box\)\. It stays committed only as long as the tracker key never commits an earlier total again: see skill\.md, Trust model\./);
  // How long a box waits for a block: one wording in every state that names the wait, with no date and none of the old
  // promises (the redesign, round 2).
  assert.equal(anchors.BLOCK_WAIT, 'usually within minutes, up to about 30 when Ergo testnet blocks are slow');
  for (const name of ['update_in_flight', 'waiting_for_next_update', 'daily_cap_reached']) assert.ok(states[name].what_this_means.includes(`once a block includes ${name === 'update_in_flight' ? 'it' : 'that box'} (${anchors.BLOCK_WAIT})`), name);
  for (const s of Object.values(states)) assert.doesNotMatch(s.what_this_means, /few minutes|two minutes|normally within|\bNov\b/);
});

// The readiness assessment of Nov 18 (staging, 01:13:40Z): GET /chain, and `valun ergo chain` with it, said "overdue
// ... a fault of the tracker" with unanchored_since 01:05:16 while the last box had been signed at 01:08:53 and
// confirmed between two looks; the next box was in flight 24 s later. A box that waits for the tracker's next check is
// waiting_for_next_update: a confirmed box that changed starts the wait again, and the newest box signed counts too.
test('a box confirmed between two looks starts the wait again, and one signed lately is not overdue: a wait for the next check is never "a fault of the tracker"', () => {
  const limit = (anchors.CHECK_INTERVAL_S + anchors.OVERDUE_GRACE_S) * 1000;
  const T0 = Date.parse('2026-11-18T01:05:16.188Z'), T1 = T0 + limit + 1, signed = T1 - 60_000;
  let now = T0;
  const ahead = box => ({local_digest: 'f7', confirmed_digest: '6b', confirmed_box_id: box, pending_tx_id: null});
  const w = new anchors.AnchorWatch({now: () => now});
  assert.equal(w.state(ahead(H('a'))).state, 'waiting_for_next_update');
  now = T1;                                        // a new box was confirmed meanwhile, and the state is ahead of it again
  const s = w.state(ahead(H('b')), null, signed);
  assert.equal(s.state, 'waiting_for_next_update');
  assert.equal(s.unanchored_since, new Date(T1).toISOString(), 'the wait starts again at the new box');
  assert.doesNotMatch(s.what_this_means, /fault/);
  assert.equal(w.state(ahead(H('b'))).state, 'waiting_for_next_update', 'the same box seen again keeps the wait');
  now = T1 + limit + 1;
  assert.equal(w.state(ahead(H('b'))).state, 'overdue', 'no box past the interval and its grace: a fault');
  assert.equal(w.state({...ahead(H('b')), pending_tx_id: H('5')}).state, 'update_in_flight');
  // A tracker state that names no box: the newest box the wallet adapter signed counts instead (GET /chain passes it).
  const w2 = new anchors.AnchorWatch({now: () => now});
  now = T0; w2.state(ahead(null));
  now = T1;
  assert.equal(w2.state(ahead(null), null, signed).state, 'waiting_for_next_update');
  assert.equal(w2.state(ahead(null)).state, 'overdue', 'without it, as before');
  now = signed + limit; assert.equal(w2.state(ahead(null), null, signed).state, 'waiting_for_next_update');
  now = signed + limit + 1; assert.equal(w2.state(ahead(null), null, signed).state, 'overdue');
  // A tracker that restarts names no confirmed box until its first update check, then the same box again (the review of
  // gap/first-use, rv-watch-restart.mjs: restarts every few minutes kept the wait from ever being overdue). No box was
  // posted, so the wait goes on, overdue past the interval and its grace as before; a box named in place of the one
  // before the restart is a new box, and starts it again.
  const w3 = new anchors.AnchorWatch({now: () => now}), lastBox = T0 - 60_000;
  now = T0; assert.equal(w3.state(ahead(H('c')), null, lastBox).state, 'waiting_for_next_update');
  for (const [f, box] of [[0.3, null], [0.4, H('c')], [0.6, null], [0.7, null], [0.8, H('c')], [0.95, null]]) {
    now = T0 + Math.round(f * limit);
    assert.equal(w3.state(ahead(box), null, lastBox).state, 'waiting_for_next_update', `${f}: ${box}`);
  }
  now = T0 + limit + 1;
  const same = w3.state(ahead(H('c')), null, lastBox);
  assert.equal(same.state, 'overdue', 'X, null, X: the same box, so none was posted for the interval and its grace');
  assert.equal(same.unanchored_since, new Date(T0).toISOString());
  now += 60_000; assert.equal(w3.state(ahead(null), null, lastBox).state, 'overdue', 'a restart meanwhile changes nothing');
  now += 60_000;
  const next = w3.state(ahead(H('d')), null, lastBox);
  assert.equal(next.state, 'waiting_for_next_update', 'X, null, Y: a new box, so the wait starts again');
  assert.equal(next.unanchored_since, new Date(now).toISOString());
  assert.match(fs.readFileSync(new URL('../lib/pilot/http.mjs', import.meta.url), 'utf8'), /\.\.\.anchorWatch\.state\(st, cap, last\?\.t \?\? null\)/, 'GET /chain passes the newest box signed');
});

// The node that names a box's transaction (creatingTx), now also read for positions and agent pages: a lookup that
// found nothing is not asked again for 30 s, and lookups meanwhile share one read.
test('the confirmed box\'s transaction: a node that does not answer is asked once per 30 s per box, and readers share one read', async () => {
  let asked = 0, t = 5_000_000;
  const down = async () => { asked++; throw new TypeError('fetch failed'); };
  const opts = {fetchFn: down, clock: () => t};
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => anchors.creatingTx('http://node-x', H('d'), opts))), [null, null, null]);
  assert.equal(asked, 1, 'three readers, one read');
  t += anchors.CREATING_TX_FAILED_KEEP_MS - 1;
  assert.equal(await anchors.creatingTx('http://node-x', H('d'), opts), null);
  assert.equal(asked, 1, 'kept');
  t += 1;
  assert.equal(await anchors.creatingTx('http://node-x', H('d'), {fetchFn: async () => { asked++; return {ok: true, json: async () => ({transactionId: H('7')})}; }, clock: () => t}), H('7'));
  assert.equal(asked, 2, 'asked again after 30 s, and kept for good once found');
  assert.equal(await anchors.creatingTx('http://node-x', H('d'), opts), H('7'));
  assert.equal(asked, 2);
});

// The position's settled_how and the agent page (the readiness assessment of Nov 18, staging 00:58Z): after a set-off,
// valun_status said "committed but not final" and the agent page "(committed, not final)" while /pilot/v1/loops said
// on_chain.anchored false and the loop card "Not committed on Ergo testnet yet". They now read every loop of the
// participant as its card does (loopAnchor, as loopOnChain): committed once a confirmed box signed after it commits it.
// The review of gap/first-use: a tour clears two loops 1 to 2 minutes apart (tour-run.out, 01:03:59 and 01:05:2x) and the
// tracker posts a box every 300 s, so both often wait for the next box; "the newest loop" then said the earlier one was
// committed while both cards said not.
test('settled_how and the agent page say committed only of the loops a box committed, as their loop cards say: none, all, or the newest', async () => {
  const early = 'vs_0123456789abcdef', late = 'vs_fedcba9876543210', later = 'vs_00000000000000aa';
  const setoff = (id, at) => ({id, state: 'applied', applied_at: at, amount: 2_000_000, members: ['vp_aaaaaaaaaaaa', 'vp_bbbbbbbbbbbb']});
  const EARLY = setoff(early, '2026-11-12T15:00:10.000Z'), LATE = setoff(late, '2026-11-12T23:00:00.000Z'), LATER = setoff(later, '2026-11-12T23:02:00.000Z');
  const evidence = {delivery: {accepted: {count: 1, buyers: 1, buyers_by_kind: {sandbox_agent: 1}}, disputed_by_buyer: 0, not_delivered: 0},
    repayment: {owed_ever_PC: 4_000_000, settled: {by_setoff_PC: 2_000_000, by_redemption_PC: 0, creditors: 1, creditors_by_kind: {sandbox_agent: 1}}, outstanding_PC: 2_000_000,
      unpaid_accepted_work: {count: 0, PC: 0}}, acceptance: {holders_ever: 1, taken_by_transfer: {PC: 0}}, circle: {size: 2, closed: false}};
  const position = async () => ({claims_held: 0, owes: 2_000_000, cleared_by_setoff: 2_000_000, settled: 2_000_000, settled_how: core.SETTLED_HOW_TESTNET.committed,
    deals: {credit_notes_issued: 1, disputed: 0}, claims: [], debts: [], evidence});
  const extra = {
    participant(id) { return this.s.participants[id]; },
    directoryRecord: x => ({id: x.id, handle: x.handle, display_name: x.handle, operator: 'Basis QA', joined_at: '2026-11-12T14:00:00.000Z', agent_last_seen: '2026-11-12T23:00:00.000Z', sandbox_only: true}),
    publicPosition: position, position,
    // issuer-a's own tokens, for /me (valun_status reads it) and /owner (the owner console reads it).
    authenticate(t) { const p = this.s.participants.vp_aaaaaaaaaaaa; return t === 'vpa_a' ? {role: 'agent', p} : t === 'vpo_a' ? {role: 'owner', p} : null; },
    ledger: async () => [], effectiveLimits: () => ({max_issue_outstanding: 40_000_000}), issueExposure: () => ({total: 0}),
    dealsFor: () => [], inbox: () => ({}), circulationFor: () => false, guarantees: {available: () => false, lapseStale: () => {}}};
  const st = async () => ({local_digest: 'e', confirmed_digest: 'd', confirmed_box_id: H('c'), confirmed_height: 640110, pending_tx_id: null});
  const read = async setoffs => {
    const {srv, call} = await server({trackerState: st, setoffs, spendLedger: ledgerFile(LEDGER), extra});
    try {
      const how = (await call('GET', '/pilot/v1/participants/vp_aaaaaaaaaaaa')).body.public_position.settled_how;
      const page = (await call('GET', '/agent/issuer-a')).text;
      const cards = {};
      for (const id of Object.keys(setoffs)) cards[id] = (await call('GET', `/pilot/v1/loops/${id}`)).body.on_chain.anchored;
      const me = await call('GET', '/pilot/v1/me', undefined, 'vpa_a'), owner = await call('GET', '/pilot/v1/owner', undefined, 'vpo_a');
      assert.equal(me.status, 200, me.text);
      assert.equal(owner.status, 200, owner.text);
      return {how, repayment: /<li><strong>Cleared or redeemed\.<\/strong> ([^<]*)<\/li>/.exec(page)?.[1], cards, me: me.body.position.settled_how, owner: owner.body.position.settled_how};
    } finally { srv.close(); }
  };
  const words = r => /cleared in loops \(([^)]*)\), 0 tERG redeemed/.exec(r.repayment)?.[1];
  // Committed: the update signed at 15:03:46 commits the loop of 15:00:10 (the loop card says so too).
  let r = await read({[early]: EARLY});
  assert.deepEqual(r.cards, {[early]: true});
  assert.equal(r.how, 'cleared in loops, committed but not final, and redeemed on Ergo testnet');
  assert.equal(r.repayment, '0.002 tERG of the 0.004 tERG it owed cleared in loops (committed, not final), 0 tERG redeemed, with 1 holder (1 practice agent); 0.002 tERG outstanding; 0 accepted jobs unpaid.');
  // Not committed yet: no update was signed after the loop of 23:00 (its card: "Not committed on Ergo testnet yet").
  r = await read({[late]: LATE});
  assert.deepEqual(r.cards, {[late]: false});
  assert.equal(r.how, 'cleared in loops, committed once the next tracker box commits it, and redeemed on Ergo testnet');
  assert.equal(words(r), 'committed once the next tracker box commits it');
  // Two loops after the last update, two minutes apart as a tour's are (the review's repro): both wait, and nothing
  // says either is committed.
  r = await read({[late]: LATE, [later]: LATER});
  assert.deepEqual(r.cards, {[late]: false, [later]: false});
  assert.equal(r.how, 'cleared in loops, committed once the next tracker box commits them, and redeemed on Ergo testnet');
  assert.equal(words(r), 'committed once the next tracker box commits them');
  assert.deepEqual([r.me, r.owner], [r.how, r.how], '/me and /owner say it as GET /participants/{id} does');
  // After an earlier loop that a box committed: only the newest wait, and the words count them.
  r = await read({[early]: EARLY, [late]: LATE});
  assert.deepEqual(r.cards, {[early]: true, [late]: false});
  assert.equal(r.how, 'cleared in loops, committed but not final (except the newest loop, which the next tracker box commits), and redeemed on Ergo testnet');
  assert.equal(words(r), 'committed, not final, except the newest loop, which the next tracker box commits');
  r = await read({[early]: EARLY, [late]: LATE, [later]: LATER});
  assert.deepEqual(r.cards, {[early]: true, [late]: false, [later]: false});
  assert.equal(r.how, 'cleared in loops, committed but not final (except the 2 newest loops, which the next tracker box commits), and redeemed on Ergo testnet');
  assert.equal(words(r), 'committed, not final, except the 2 newest loops, which the next tracker box commits');
  assert.deepEqual([r.me, r.owner], [r.how, r.how]);
  // Every loop a box committed: the words as before.
  r = await read({[early]: EARLY, [late]: setoff(late, '2026-11-12T22:00:00.000Z')});
  assert.deepEqual(r.cards, {[early]: true, [late]: true});
  assert.equal(r.how, core.SETTLED_HOW_TESTNET.committed);
  assert.deepEqual([r.me, r.owner, words(r)], [r.how, r.how, 'committed, not final']);
  // The tracker unread: what a committed netting is, as before (never a claim it is not committed).
  const {srv, call} = await server({trackerState: async () => { throw new Error('down'); }, setoffs: {[late]: LATE}, spendLedger: ledgerFile(LEDGER), extra});
  try {
    assert.equal((await call('GET', '/pilot/v1/participants/vp_aaaaaaaaaaaa')).body.public_position.settled_how, core.SETTLED_HOW_TESTNET.committed);
    assert.equal((await call('GET', '/pilot/v1/owner', undefined, 'vpo_a')).body.position.settled_how, core.SETTLED_HOW_TESTNET.committed);
  } finally { srv.close(); }
});

test('a redemption of a note not anchored yet: the refusal says how long that lasts, and it uses up no build', async () => {
  let refuse = true;
  const redemptionBuild = async () => {
    if (refuse) throw Object.assign(new Error('tracker POST /redemption/build: note is not committed on-chain yet; wait for the next tracker box update'), {name: 'BasisError'});
    return {unsigned_tx: {id: 'u', inputs: []}, partial_tx: {id: 'p'}, new_already_redeemed: 1_000_000};
  };
  const {srv, call} = await server({trackerState: async () => ({local_digest: 'e', confirmed_digest: 'd', pending_tx_id: null}), redemptionBuild});
  try {
    for (let i = 0; i < routes.REDEMPTION_BUILDS_PER_DAY + 2; i++) {
      const r = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'tracker_refused');
      assert.match(r.body.message, /^note is not committed on-chain yet; wait for the next tracker box update\. The tracker checks every \d+ seconds/);
      assert.match(r.body.message, /GET \/pilot\/v1\/chain shows its anchoring/);
    }
    refuse = false;
    const ok = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
    assert.equal(ok.status, 200, 'the refused requests used up no build');
  } finally { srv.close(); }
});

test('loop words on the testnet: amounts in tERG, the chain named, never the pilot', () => {
  const loop = loops.loopOf({id: 'vs_0123456789abcdef', state: 'applied', amount: 2_000_000, members: []}, {}, x => x);
  assert.match(loops.loopDescription(loop), /cancelled 0\.002 tERG of notes in one set-off\. No coins moved\./);
  assert.match(loops.loopDescription(loop), /anchors its state on Ergo testnet/);
  assert.doesNotMatch(loops.loopDescription(loop), /pilot|credits/);
});
