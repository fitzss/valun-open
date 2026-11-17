// One redemption against an issuer's reserve at a time (lib/pilot/http.mjs reserveHolds): concurrent builds against
// one reserve both succeeded and the node rejected the second as a double spend (Basis E13b, unfiled); just after a
// spend the tracker refused for minutes with "no unspent reserve ..." (fix inbox #26). Testnet routes, fake tracker.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const routes = await import('../lib/pilot/http.mjs');

async function server({redemptionBuild, redemptionSubmit = async () => ({tx_id: 'ab'.repeat(32)}), heldForBackers = null}) {
  const PKA = '02' + 'a1'.repeat(32), PKB = '03' + 'b2'.repeat(32), PKC = '03' + 'c3'.repeat(32);
  const participants = {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb', handle: 'holder-b', pubkey: PKB},
    vp_cccccccccccc: {id: 'vp_cccccccccccc', handle: 'holder-c', pubkey: PKC}};
  const basis = {denomination: 'erg', nft: 'ab'.repeat(32), trackerState: async () => ({local_digest: 'e', confirmed_digest: 'e', pending_tx_id: null}),
    note: async () => ({amount_collected: 9_000_000, amount_redeemed: 0, timestamp: 1_700_000_000_123, signature: 'aa'.repeat(65)}), redemptionBuild, redemptionSubmit};
  const pilot = {chain: {name: 'ergo-testnet', on_chain: true, tracker_nft_id: 'ab'.repeat(32), explorer: 'https://testnet.ergoplatform.com'},
    s: {participants, setoffs: {}}, openSandbox: true, unit: 'nanoERG', mode: 'off', basis, store: {audit: () => {}}, selfServe: () => null,
    setoff: () => null, publicParticipant: x => ({handle: x.handle}), byPubkey: pk => Object.values(participants).find(x => x.pubkey === pk) || null,
    authenticate: t => (t === 'vpa_b' ? {role: 'agent', p: participants.vp_bbbbbbbbbbbb} : t === 'vpa_c' ? {role: 'agent', p: participants.vp_cccccccccccc} : null),
    ...(heldForBackers ? {heldForBackers} : {})};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body, type) => { r.writeHead(status, {'content-type': type || 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try { await handler(req, res, url, send, () => '127.0.0.1'); } catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message, ...(e.extra || {})}); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {method, headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
    return {status: r.status, body: await r.json().catch(() => null)};
  };
  return {srv, call};
}

test('two builds against one reserve at once: one is built, the other is reserve_busy with retry_after_ms (no node double spend)', async () => {
  let n = 0, release;
  const gate = new Promise(r => { release = r; });
  const redemptionBuild = async () => { n++; await gate; return {unsigned_tx: {id: `u${n}`, inputs: []}, partial_tx: {id: `p${n}`}, new_already_redeemed: 2_000_000}; };
  const {srv, call} = await server({redemptionBuild});
  try {
    const a = call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 2_000_000}, 'vpa_b');
    await new Promise(r => setTimeout(r, 50));
    const b = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 2_000_000}, 'vpa_c');    // another holder, same reserve
    release();
    const ra = await a;
    assert.equal(ra.status, 200);
    assert.equal(b.status, 409);
    assert.equal(b.body.error, 'reserve_busy');
    assert.ok(b.body.retry_after_ms >= 1000);
    assert.equal(n, 1, 'the tracker was asked to build once');
    // Still held until the first is submitted (or the build hold runs out).
    const c = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_c');
    assert.equal(c.body.error, 'reserve_busy');
    // Submitted: held while the spend confirms, and the refusal names the spending tx.
    const sub = await call('POST', '/pilot/v1/redemption/submit', {signed_tx: {id: 'p1'}, unsigned_tx: {id: 'u1'}}, 'vpa_b');
    assert.equal(sub.status, 200);
    const d = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_c');
    assert.deepEqual([d.status, d.body.error, d.body.spending_tx], [409, 'reserve_busy', 'ab'.repeat(32)]);
    assert.match(d.body.message, /being confirmed \(tx abab/);
  } finally { srv.close(); }
});

test('a build the tracker refuses frees the reserve at once and uses up no build', async () => {
  let refuse = true;
  const redemptionBuild = async () => {
    if (refuse) throw Object.assign(new Error('tracker POST /redemption/build: note is not committed on-chain yet; wait for the next tracker box update'), {name: 'BasisError'});
    return {unsigned_tx: {id: 'u', inputs: []}, partial_tx: {id: 'p'}, new_already_redeemed: 1_000_000};
  };
  const {srv, call} = await server({redemptionBuild});
  try {
    const r = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
    assert.equal(r.body.error, 'tracker_refused');
    refuse = false;
    assert.equal((await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_c')).status, 200, 'not held by the refused build');
  } finally { srv.close(); }
});

test('#26: the tracker\'s "no unspent reserve" just after a spend is reserve_busy with a retry, not a refusal', async () => {
  const redemptionBuild = async () => {
    throw Object.assign(new Error('tracker POST /redemption/build: no unspent reserve with >= 4000000 units collateral and a reserve tree matching the tracker (digest c7b95c6c5ba2904e)'), {name: 'BasisError'});
  };
  const {srv, call} = await server({redemptionBuild});
  try {
    const r = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 4_000_000}, 'vpa_b');
    assert.deepEqual([r.status, r.body.error], [409, 'reserve_busy']);
    assert.ok(r.body.retry_after_ms >= 30000);
  } finally { srv.close(); }
});

test('fix inbox #123: a broadcast the node refuses as a double spend (the box moved since the build) is reserve_busy with retry_after_ms, not a raw tracker_refused', async () => {
  const redemptionBuild = async () => ({unsigned_tx: {id: 'u1', inputs: []}, partial_tx: {id: 'p1'}, new_already_redeemed: 1_000_000});
  const redemptionSubmit = async () => {
    throw Object.assign(new Error('tracker POST /redemption/submit: broadcast failed: broadcast rejected HTTP 400 Bad Request: the Ergo node answered 400 to POST /transactions: {"error":400,"reason":"bad.request","detail":"Double spending attempt"}'), {name: 'BasisError'});
  };
  const {srv, call} = await server({redemptionBuild, redemptionSubmit});
  try {
    assert.equal((await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b')).status, 200);
    const sub = await call('POST', '/pilot/v1/redemption/submit', {signed_tx: {id: 'p1'}, unsigned_tx: {id: 'u1'}}, 'vpa_b');
    assert.deepEqual([sub.status, sub.body.error, sub.body.cause, sub.body.retry_after_ms], [409, 'reserve_busy', 'box_moved', 180000]);
    assert.match(sub.body.message, /nothing was spent/);
    // The holder may build again at once (its own build was dropped); the dropped build cannot be submitted again.
    assert.equal((await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b')).status, 200);
    // Any other refusal is relayed as before.
  } finally { srv.close(); }
});

test(`fix inbox #107: a creditor cannot redeem the part of an issuer's note that backers paid it for`, async () => {
  const redemptionBuild = async () => ({unsigned_tx: {id: 'u1', inputs: []}, partial_tx: {id: 'p1'}, new_already_redeemed: 1_000_000});
  // holder-b holds 9,000,000 of issuer-a's note (the stub tracker's note); backers paid it 7,000,000 for that debt.
  const heldForBackers = (issuerId, creditorId) => (issuerId === 'vp_aaaaaaaaaaaa' && creditorId === 'vp_bbbbbbbbbbbb' ? 7_000_000 : 0);
  const {srv, call} = await server({redemptionBuild, heldForBackers});
  try {
    const over = await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 3_000_000}, 'vpa_b');
    assert.deepEqual([over.status, over.body.error], [409, 'insufficient_claim']);
    assert.match(over.body.message, /at most 2000000 nanoERG of issuer-a's note: 7000000 nanoERG of it is held: backers already paid you that much/);
    assert.equal((await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 2_000_000}, 'vpa_b')).status, 200, 'what is left is redeemable');
  } finally { srv.close(); }
});

test('fix inbox #107: a redemption built before a backer paid for that debt is refused at submit, and nothing is sent', async () => {
  let held = 0;
  const submitted = [];
  const redemptionBuild = async b => ({unsigned_tx: {id: 'u1', inputs: []}, partial_tx: {id: 'p1'}, new_already_redeemed: b.amount});
  const redemptionSubmit = async b => { submitted.push(b); return {tx_id: 'cd'.repeat(32)}; };
  const heldForBackers = (i, c) => (i === 'vp_aaaaaaaaaaaa' && c === 'vp_bbbbbbbbbbbb' ? held : 0);
  const {srv, call} = await server({redemptionBuild, redemptionSubmit, heldForBackers});
  try {
    assert.equal((await call('POST', '/pilot/v1/redemption/build', {issuer: 'issuer-a', amount: 9_000_000}, 'vpa_b')).status, 200);
    held = 9_000_000;                                           // a backer now honors holder-b's call for that debt
    const s = await call('POST', '/pilot/v1/redemption/submit', {signed_tx: {id: 'p1'}, unsigned_tx: {id: 'u1'}}, 'vpa_b');
    assert.deepEqual([s.status, s.body.error], [409, 'insufficient_claim']);
    assert.match(s.body.message, /held: backers already paid you that much/);
    assert.equal(submitted.length, 0, 'nothing reached the tracker');
  } finally { srv.close(); }
});

