// Fix inbox #13, #14 and the loop pages' explorer links, on the testnet network (its own process): the tracker's
// anchoring state (anchored, waiting for the next update, an update in flight, overdue), which tracker-box update made a
// loop's netting final (from the wallet adapter's spend ledger), a deal's note as the tracker holds it now (confirmed,
// redeemed), the position's redemptions, the wait hints of deal views, and a redemption refused for a note not anchored
// yet (it says how long that lasts, and it uses up no build).
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

test('a loop is final in the first confirmed update signed after it; one signed just after it counts only while anchored', () => {
  const rows = anchors.trackerBoxUpdates(ledgerFile(LEDGER));
  const anchored = {local_digest: 'd', confirmed_digest: 'd', pending_tx_id: null};
  const changed = {local_digest: 'e', confirmed_digest: 'd', pending_tx_id: null};
  // the three set-offs of the live netting run (applied about 15:00, final in the update of 15:03:46)
  assert.equal(anchors.loopAnchor('2026-11-12T15:00:10.000Z', rows, changed).tx_id, H('2'));
  assert.equal(anchors.loopAnchor('2026-11-12T22:30:00.000Z', rows, changed), null, 'no update since: not final yet');
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
    keysOf: () => new Set(['pk']), isPastKey: () => false, operatorRun: () => false, serverRun: () => false};
  const pos = await core.Pilot.prototype.position.call(self, {id: 'vp_me'});
  assert.equal(pos.redeemed_claims, 3_000_000);
  assert.equal(pos.redeemed_debts, 0);
  assert.equal(pos.settled, 3_000_000);
  assert.equal(pos.settled_how, 'by set-off and by redemption on Ergo testnet');
  assert.doesNotMatch(pos.meaning, /pilot|Nothing is redeemed|there is no reserve/);
  assert.match(pos.meaning, /redeems it on Ergo testnet/);
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

// The routes, with a fake tracker client and a spend ledger on disk.
async function server({trackerState, redemptionBuild, setoffs = {}, spendLedger = null}) {
  const PKA = '02' + 'a1'.repeat(32), PKB = '03' + 'b2'.repeat(32);
  const participants = {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb', handle: 'holder-b', pubkey: PKB}};
  const basis = {denomination: 'erg', nft: 'ab'.repeat(32), trackerState,
    note: async () => ({amount_collected: 3_000_000, amount_redeemed: 0, timestamp: 1_700_000_000_123, signature: 'aa'.repeat(65)}),
    redemptionBuild};
  const pilot = {chain: {name: 'ergo-testnet', on_chain: true, tracker_nft_id: 'ab'.repeat(32), explorer: 'https://testnet.ergoplatform.com', spend_ledger: spendLedger},
    s: {participants, setoffs}, openSandbox: true, unit: 'nanoERG', mode: 'off', basis, store: {audit: () => {}}, selfServe: () => null,
    setoff: id => setoffs[id] ?? null, publicParticipant: x => ({handle: x.handle}),
    byPubkey: pk => Object.values(participants).find(x => x.pubkey === pk) || null,
    authenticate: t => (t === 'vpa_b' ? {role: 'agent', p: participants.vp_bbbbbbbbbbbb} : null)};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body, type) => { r.writeHead(status, {'content-type': type || 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      const m = /^\/loop\/(.+)$/.exec(url.pathname);
      if (m) return await handler.loopPage(req, res, m[1], send, () => '127.0.0.1');
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

test('loops on the testnet link the tracker-box update that made them final; GET /chain names the last update', async () => {
  const id = 'vs_0123456789abcdef';
  const setoffs = {[id]: {id, state: 'applied', applied_at: '2026-11-12T15:00:10.000Z', amount: 2_000_000, members: ['vp_aaaaaaaaaaaa', 'vp_bbbbbbbbbbbb']}};
  const {srv, call} = await server({trackerState: async () => ({local_digest: 'e', confirmed_digest: 'd', confirmed_box_id: H('c'), confirmed_height: 640110, pending_tx_id: null}),
    setoffs, spendLedger: ledgerFile(LEDGER)});
  try {
    const one = await call('GET', `/pilot/v1/loops/${id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.on_chain, {anchored: true, tx_id: H('2'), explorer_url: `https://testnet.ergoplatform.com/en/transactions/${H('2')}`,
      signed_at: '2026-11-12T15:03:46.369Z', what_this_means: 'Final on Ergo testnet: this tracker-box update is the first that commits the set-off.'});
    const all = await call('GET', '/pilot/v1/loops');
    assert.equal(all.body.loops[0].on_chain.tx_id, H('2'));
    const page = await call('GET', `/loop/${id}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<a href="https://testnet.ergoplatform.com/en/transactions/${H('2')}">tx ${H('2').slice(0, 12)}…</a>`));
    assert.ok(page.text.includes('Final on Ergo testnet'));
    assert.ok(page.text.includes('2000000 nanoERG (0.002 tERG)'), 'amounts in the testnet unit');
    assert.doesNotMatch(page.text, /pilot network|credits have no/);
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
    assert.match(one.body.on_chain.what_this_means, /^Not final on chain yet: the next tracker box commits it/);
    assert.ok((await s2.call('GET', `/loop/${id}`)).text.includes('not final yet: the next tracker box commits it'));
  } finally { s2.srv.close(); }
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
  assert.match(loops.loopDescription(loop), /cancelled 2000000 nanoERG \(0\.002 tERG\) of IOUs/);
  assert.match(loops.loopDescription(loop), /anchors its state on Ergo testnet/);
  assert.doesNotMatch(loops.loopDescription(loop), /pilot|credits/);
});
