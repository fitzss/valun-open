// The Valun TESTNET network's configuration (PILOT_NETWORK=valun-testnet-1, lib/pilot/units.mjs), in its own process:
// the unit and scale, the PC-sized defaults and prices scaled to nanoERG, the formatting people read, the honest
// description in /info, and the guard that takes no deal before the tracker is on chain. The pilot's own tests run with
// the default network and are unchanged.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const units = await import('../lib/pilot/units.mjs');
const core = await import('../lib/pilot/core.mjs');
const sandbox = await import('../lib/pilot/sandbox.mjs');
const routes = await import('../lib/pilot/http.mjs');

test('the network, its unit and scale; amounts as people read them', () => {
  assert.equal(units.NETWORK, 'valun-testnet-1');
  assert.equal(core.NETWORK, 'valun-testnet-1', 'core re-exports the one network');
  assert.equal(units.UNIT, 'nanoERG');
  assert.equal(units.SCALE, 1_000_000);
  assert.equal(units.ON_TESTNET, true);
  assert.equal(units.pc(5), 5_000_000);
  assert.equal(units.amt(3_000_000), '3000000 nanoERG (0.003 tERG)');
  assert.equal(units.amt(1_500_000_000), '1500000000 nanoERG (1.5 tERG)');
  assert.match(units.BACKING, /Ergo TESTNET/);
});

test('PC-sized defaults and prices are scaled: mandates, sandbox prices, the welcome job, the earn cap', () => {
  assert.equal(core.DEFAULT_MANDATE.max_issue_per_deal, 25_000_000);
  assert.equal(core.DEFAULT_MANDATE.max_accept_per_issuer, 50_000_000);
  assert.equal(sandbox.SERVICES['text-stats'].price, 3_000_000);
  assert.equal(sandbox.SERVICES.notary.price, 2_000_000);
  assert.equal(sandbox.WELCOME.price, 3_000_000);
  assert.equal(sandbox.STRANGER_EARN_CAP, 20_000_000);
  // The approval threshold is an amount too (1000 PC-sized units): a sandbox agent's welcome offer, and a self-serve
  // participant's commitments within its limits, never wait for an owner (the first testnet run found it at 1000
  // nanoERG, which held sandbox-exact's welcome offer for an owner nobody is).
  for (const circulating of [true, false]) assert.equal(sandbox.mandateFor('sandbox-exact', circulating).approve_above, 1_000_000_000);
  assert.ok(sandbox.WELCOME.price <= sandbox.mandateFor('sandbox-exact', true).approve_above);
});

test('/info describes the testnet honestly; before the bootstrap every write is refused with 503', async () => {
  assert.match(routes.INFO_DESCRIPTIONS.off, /^Valun testnet network/);
  assert.match(routes.INFO_DESCRIPTIONS.off, /Ergo TESTNET: test coins with no monetary value/);
  assert.match(routes.INFO_DESCRIPTIONS.off, /netting\) are not on for this network yet/);
  assert.doesNotMatch(routes.INFO_DESCRIPTIONS.off, /PC \(pilot credits\)/);
  const pilot = {chain: {on_chain: false}, s: {participants: {}}, openSandbox: true, unit: 'nanoERG', mode: 'off',
    basis: {denomination: 'erg', nft: 'ab'.repeat(32)}, selfServe: () => null, authenticate: () => null};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body) => { r.writeHead(status, {'content-type': 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try { await handler(req, res, url, send, () => '127.0.0.1'); }
    catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message}); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/pilot/v1`;
  try {
    for (const [method, p] of [['POST', '/join-sandbox'], ['POST', '/join'], ['POST', '/deals'], ['PUT', '/profile']]) {
      const r = await fetch(base + p, {method, headers: {'content-type': 'application/json'}, body: '{}'});
      assert.equal(r.status, 503, `${method} ${p}`);
      assert.equal((await r.json()).error, 'testnet_bootstrapping');
    }
    const info = await (await fetch(base + '/info')).json();
    assert.equal(info.network, 'valun-testnet-1');
    assert.equal(info.unit, 'nanoERG');
    assert.equal(info.denomination, 'erg');
    assert.equal(info.tracker_on_chain, false);
    assert.deepEqual(info.chain, {on_chain: false});
    for (const p of ['/chain', '/reserves']) assert.equal((await fetch(base + p)).status, 503, `GET ${p} before the bootstrap`);
  } finally { server.close(); }
});

test('the testnet serves its own skill.md (nanoERG, valun 0.5, settlement on Ergo testnet); the pilot file is unchanged', async () => {
  const {createHandler} = await import('../lib/http.mjs');
  const pathMod = await import('node:path'), {fileURLToPath} = await import('node:url');
  const root = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: pathMod.join(root, 'public')}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    for (const p of ['/skill.md', '/agents.md']) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`);
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.match(text, /^---\nname: valun-testnet\n/, p);
      assert.match(text, /nanoERG of Ergo\ntestnet/);
      assert.match(text, /valun 0\.5 or later/);
      assert.match(text, /valun --profile testnet ergo redeem sandbox-exact 3000000 --broadcast/);
      assert.doesNotMatch(text, /\bPC\b/, 'no pilot credits on the testnet');
    }
  } finally { srv.close(); }
});

// Circulation on the testnet needs tracker v4 with anchored netting (TR-15): the anchored-netting capability, version 1,
// not pure credit, any whole number of on-chain edges. A pure-credit tracker, or one without anchored netting, runs as
// off here (fail closed); the pilot's contract is unchanged.
test('the testnet takes circulation only from a tracker with anchored netting (version 1)', async () => {
  const caps = await import('../lib/pilot/caps.mjs');
  const anchored = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: 'x', pure_credit: false, reserved_ms: [995, 996, 997, 998, 999],
    bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
    novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to',
      'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
    onchain_edges: 7, novations_disabled_reason: null,
    anchored_netting: {version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720, observation_max_age_ms: 7200000}};
  assert.deepEqual(caps.validateCaps(anchored), {ok: true, reason: null});
  assert.deepEqual(caps.validateCaps({...anchored, onchain_edges: 0}), {ok: true, reason: null});
  const refused = (c, re) => { const v = caps.validateCaps(c); assert.equal(v.ok, false, JSON.stringify(c).slice(0, 80)); assert.match(v.reason, re); };
  refused({...anchored, pure_credit: true}, /pure_credit is true, expected false/);
  const {anchored_netting: _, ...without} = anchored;
  refused(without, /anchored_netting\.version is missing/);
  refused({...anchored, anchored_netting: {...anchored.anchored_netting, fresh_blocks: 2160}}, /anchored_netting\.fresh_blocks is 2160, expected 1440/);
  refused({...anchored, anchored_netting: {...anchored.anchored_netting, authorization_floor: false}}, /authorization_floor/);
  refused({...anchored, onchain_edges: -1}, /onchain_edges is -1, expected a whole number/);
  refused({...anchored, onchain_edges: '7'}, /onchain_edges/);
  refused({...anchored, novations_disabled_reason: 'x'}, /novations_disabled_reason/);
  // On the pilot the same tracker does not qualify: the pilot's tracker is pure credit with no on-chain edge.
  assert.match(caps.validateCaps(anchored, {testnet: false}).reason, /pure_credit is false, expected true/);
  assert.equal(caps.validateCaps({...anchored, pure_credit: true, onchain_edges: 0}, {testnet: false}).ok, true, 'the v3.2 contract ignores the extra capability');
});

// The settlement routes once the tracker is on chain: the chain view and the reserves (public), and the relay of an
// agent's reserve creation and redemption to the tracker. A fake tracker client records what it is asked; the agent's
// own key (never a key from the request) is the reserve owner and the redemption's recipient.
const EXT = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 8].map(k => [String(k), `0e0${k}`]));
async function onChainServer() {
  const PKA = '02' + 'a1'.repeat(32), PKB = '03' + 'b2'.repeat(32);
  const participants = {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb', handle: 'holder-b', pubkey: PKB}};
  const calls = [], audit = [];
  const refuse = msg => Object.assign(new Error(`tracker POST /redemption/submit: ${msg}`), {name: 'BasisError'});
  const basis = {denomination: 'erg', nft: 'ab'.repeat(32),
    trackerState: async () => ({local_digest: 'd1', confirmed_digest: 'd1', confirmed_box_id: 'bx', confirmed_height: 639800, pending_tx_id: null}),
    reserves: async () => [{box_id: 'r1', owner_pubkey: PKA, collateral_amount: 50_000_000, total_debt: 3_000_000, collateralization_ratio: 16.7,
      last_updated_height: 639790, refund_initiation_height: null, reserve_token_id: 'cd'.repeat(32)}, {box_id: 'r2', owner_pubkey: '02' + 'ee'.repeat(32), collateral_amount: 10_000_000}],
    note: async (issuer, recipient) => (issuer === PKA && recipient === PKB ? {amount_collected: 3_000_000, amount_redeemed: 1_000_000, timestamp: 1_700_000_000_123, signature: 'aa'.repeat(65)} : null),
    reserveCreate: async a => { calls.push(['reserveCreate', a]); return {requests: [{address: 'x', value: a.ergAmount}]}; },
    redemptionBuild: async a => { calls.push(['redemptionBuild', a]); return {unsigned_tx: {id: 'u', inputs: [{boxId: 'r', extension: EXT}]}, partial_tx: {id: 'p'}, new_already_redeemed: 3_000_000}; },
    redemptionSubmit: async a => { calls.push(['redemptionSubmit', a]); if (a.signed_tx === 'bad') throw refuse('input 0: proof does not verify'); return {tx_id: 'f0'.repeat(32)}; }};
  const pilot = {chain: {name: 'ergo-testnet', on_chain: true, tracker_nft_id: 'ab'.repeat(32), tracker_address: '3Wtest', reserve_contract: 'P2Stest', explorer: 'https://testnet.ergoplatform.com'},
    s: {participants}, openSandbox: true, unit: 'nanoERG', mode: 'off', basis, store: {audit: e => audit.push(e)}, selfServe: () => null,
    byPubkey: pk => Object.values(participants).find(x => x.pubkey === pk) || null,
    authenticate: t => (t === 'vpa_b' ? {role: 'agent', p: participants.vp_bbbbbbbbbbbb} : t === 'vpo_b' ? {role: 'owner', p: participants.vp_bbbbbbbbbbbb} : null)};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body) => { r.writeHead(status, {'content-type': 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try { await handler(req, res, url, send, () => '127.0.0.1'); }
    catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message}); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/pilot/v1`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, body: JSON.parse(text), text};
  };
  return {server, call, calls, audit, PKA, PKB};
}

test('on chain: GET /chain shows the anchoring and the explorer links; GET /reserves names the owners who are participants', async () => {
  const {server, call} = await onChainServer();
  try {
    const c = await call('GET', '/chain');
    assert.equal(c.status, 200);
    assert.equal(c.body.network, 'valun-testnet-1');
    assert.deepEqual(c.body.anchoring, {local_digest: 'd1', confirmed_digest: 'd1', confirmed_box_id: 'bx', confirmed_height: 639800, pending_tx_id: null, anchored: true});
    assert.equal(c.body.links.tracker_nft, `https://testnet.ergoplatform.com/en/token/${'ab'.repeat(32)}`);
    assert.equal(c.body.links.tracker_address, 'https://testnet.ergoplatform.com/en/addresses/3Wtest');
    const r = await call('GET', '/reserves');
    assert.equal(r.status, 200);
    assert.equal(r.body.unit, 'nanoERG');
    assert.equal(r.body.reserve_contract, 'P2Stest');
    assert.equal(r.body.reserves.length, 2);
    assert.equal(r.body.reserves[0].handle, 'issuer-a');
    assert.equal(r.body.reserves[0].collateral_nanoerg, 50_000_000);
    assert.equal(r.body.reserves[0].total_debt_nanoerg, 3_000_000);
    assert.equal(r.body.reserves[1].handle, null, 'an owner who is not a participant has no handle');
  } finally { server.close(); }
});

test('on chain: an agent asks for its own reserve; the owner key is always the agent\'s; amounts and ids are checked', async () => {
  const {server, call, calls, PKB} = await onChainServer();
  try {
    assert.equal((await call('POST', '/reserves/create', {erg_amount: 50_000_000, nft_id: 'c0'.repeat(32)})).status, 401, 'no token');
    const owner = await call('POST', '/reserves/create', {erg_amount: 50_000_000, nft_id: 'c0'.repeat(32)}, 'vpo_b');
    assert.equal(owner.status, 403);
    assert.equal(owner.body.error, 'agent_only');
    for (const [body, field] of [[{erg_amount: 9_999_999, nft_id: 'c0'.repeat(32)}, 'erg_amount'], [{erg_amount: 2_000_000_001, nft_id: 'c0'.repeat(32)}, 'erg_amount'],
      [{erg_amount: 0.5e8 + 0.5, nft_id: 'c0'.repeat(32)}, 'erg_amount'], [{erg_amount: 50_000_000, nft_id: 'C0'.repeat(32)}, 'nft_id'], [{erg_amount: 50_000_000}, 'nft_id']]) {
      const r = await call('POST', '/reserves/create', body, 'vpa_b');
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid_field');
      assert.match(r.body.message, new RegExp(`^${field}:`));
    }
    assert.equal(calls.length, 0, 'nothing reached the tracker');
    const ok = await call('POST', '/reserves/create', {erg_amount: 50_000_000, nft_id: 'c0'.repeat(32), owner_pubkey: '02' + 'ee'.repeat(32)}, 'vpa_b');
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [['reserveCreate', {nftId: 'c0'.repeat(32), ownerPubkey: PKB, ergAmount: 50_000_000}]], 'the owner key is the agent\'s own, not the one in the request');
  } finally { server.close(); }
});

test('on chain: a redemption is built only for a note the agent holds and within what is outstanding; the tracker\'s refusal is a 409', async () => {
  const {server, call, calls, audit, PKA, PKB} = await onChainServer();
  try {
    assert.equal((await call('POST', '/redemption/build', {issuer: 'nobody', amount: 1}, 'vpa_b')).status, 404);
    const none = await call('POST', '/redemption/build', {issuer: 'holder-b', amount: 1_000_000}, 'vpa_b');
    assert.equal(none.status, 409, 'its own note to itself does not exist');
    assert.equal(none.body.error, 'no_note');
    assert.equal((await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 0}, 'vpa_b')).body.error, 'invalid_field');
    const tiny = await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 999_999}, 'vpa_b');
    assert.equal(tiny.body.error, 'invalid_field');
    assert.match(tiny.body.message, /at least 1000000 \(the miner fee the tracker pays\)/);
    const over = await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 2_000_001}, 'vpa_b');
    assert.equal(over.status, 409);
    assert.equal(over.body.error, 'insufficient_claim');
    assert.match(over.body.message, /at most 2000000 nanoERG of issuer-a's note/);
    const ok = await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 2_000_000}, 'vpa_b');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.issuer, {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA});
    assert.deepEqual(ok.body.unsigned_tx, {id: 'u', inputs: [{boxId: 'r', extension: EXT}]});
    assert.match(ok.text, /"extension":\{"0":"0e00","5":"0e05","1":"0e01","6":"0e06","2":"0e02","3":"0e03","8":"0e08","4":"0e04"\}/,
      'relayed with the extension in the order of the tracker (Scala order), which JSON.stringify would sort');
    assert.deepEqual(calls.at(-1), ['redemptionBuild', {issuer_pubkey: PKA, recipient_pubkey: PKB, amount: 2_000_000, timestamp: 1_700_000_000_123,
      issuer_signature: 'aa'.repeat(65), denomination: 'erg'}]);
    const byId = await call('POST', '/redemption/build', {issuer: 'vp_aaaaaaaaaaaa', amount: 1_000_000}, 'vpa_b');
    assert.equal(byId.status, 200, 'the issuer by participant id');
    const sub = await call('POST', '/redemption/submit', {signed_tx: {id: 'p'}, unsigned_tx: {id: 'u'}}, 'vpa_b');
    assert.equal(sub.status, 200);
    // The tracker's submit request also takes the build's issuer, recipient and amounts (it reads its own build entry).
    assert.deepEqual(calls.at(-1), ['redemptionSubmit', {signed_tx: {id: 'p'}, unsigned_tx: {id: 'u'}, issuer_pubkey: PKA, recipient_pubkey: PKB,
      redeemed_amount: 1_000_000, new_already_redeemed: 3_000_000}]);
    assert.equal(sub.body.explorer, `https://testnet.ergoplatform.com/en/transactions/${'f0'.repeat(32)}`);
    const bad = await call('POST', '/redemption/submit', {signed_tx: 'bad'}, 'vpa_b');
    assert.equal(bad.status, 409);
    assert.deepEqual(bad.body, {error: 'tracker_refused', message: 'input 0: proof does not verify'});
    assert.deepEqual(audit.map(a => a.type), ['redemption.built', 'redemption.built', 'redemption.submitted']);
    // At most REDEMPTION_BUILDS_PER_DAY builds a day per agent (each costs the tracker a miner fee); refused ones count.
    let last;
    for (let i = 0; i < routes.REDEMPTION_BUILDS_PER_DAY; i++) last = await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'rate_limited');
    assert.match(last.body.message, /redemption builds a day per agent/);
  } finally { server.close(); }
});

// The testnet's public links point to the testnet (lib/pilot/units.mjs PUBLIC_ORIGIN): the first testnet run found its
// loop cards at valun.tech/loop/<id> (a 404 there), its A2A card sending agents to the pilot's endpoint, and the join
// prompt on its agent pages onboarding to the pilot.
test('the testnet links to itself: loop cards, agent pages, the A2A card, llms.txt', async () => {
  const T = 'https://valun-testnet.fly.dev';
  assert.equal(units.PUBLIC_ORIGIN, T);
  const loops = await import('../lib/pilot/loops.mjs');
  const loop = loops.loopOf({id: 'vs_0123456789abcdef', state: 'applied', amount: 2_000_000, members: []}, {}, x => x);
  assert.equal(loop.card_url, `${T}/loop/vs_0123456789abcdef`);
  assert.equal(loops.startHref('#agent'), `${T}/skill.md`);
  const agents = await import('../lib/pilot/agents.mjs');
  for (const html of [agents.renderAgentNotFound(), agents.renderMaintainersPage()]) {
    assert.ok(html.includes(`href="${T}/skill.md"`));
    assert.doesNotMatch(html, /valun\.tech\/(#agent|skill\.md)/);
  }
  assert.ok(agents.renderMaintainersPage().includes(`Read ${T}/skill.md and follow it`));
  const a2a = await import('../lib/a2a.mjs');
  const origin = a2a.originOf({headers: {host: 'valun-testnet.fly.dev'}});
  assert.equal(origin, T);
  const card = JSON.stringify(a2a.agentCard(origin));
  assert.ok(card.includes(`${T}/a2a`) && card.includes(`${T}/skill.md`) && card.includes('valun-testnet.fly.dev/loop/<id>'));
  assert.doesNotMatch(card, /valun\.tech\/(a2a|skill\.md|loop)/);
  const {createHandler} = await import('../lib/http.mjs');
  const pathMod = await import('node:path'), {fileURLToPath} = await import('node:url');
  const root = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: pathMod.join(root, 'public')}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/llms.txt`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /^# Valun testnet\n/);
    assert.match(text, /reads https:\/\/valun-testnet\.fly\.dev\/skill\.md/);
    assert.doesNotMatch(text, /https:\/\/valun\.tech\/(skill\.md|a2a|pilot|network|\.well-known)/, 'no pilot links but the landing');
  } finally { srv.close(); }
});
