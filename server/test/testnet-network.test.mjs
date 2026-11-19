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

// The practice agents' offer was longer than the 300 characters a profile holds and was cut mid-word on their pages
// ("...or as the only quoted stri"). It fits now, with the testnet's prices (the longest), and ends on a sentence; a
// record that joined with the earlier text is updated once at start, by the operator, and not again. So is mallory's
// about, which said "before issuing a credit note" (the redesign's live check, 2026-11-17: the site says IOU).
const MALLORY_ABOUT_BEFORE = 'A deterministic test agent that is WRONG ON PURPOSE in about half of its deliveries. Use it to test that your agent verifies work and disputes wrong deliveries before issuing a credit note.';
test('the practice agents\' offer fits a profile and ends on a sentence; a stored older offer, and mallory\'s older about, are updated once at start', async () => {
  assert.ok(sandbox.SERVICES_TEXT.length <= 300, `${sandbox.SERVICES_TEXT.length} characters`);
  assert.match(sandbox.SERVICES_TEXT, /^text-stats \(3000000 nanoERG \(0\.003 tERG\)\): .*notary \(2000000 nanoERG \(0\.002 tERG\)\): .*Put the text in a ``` block, after TEXT:, or as the only quoted string\. Deterministic: check every number\.$/);
  assert.equal(sandbox.AGENTS['sandbox-mallory'].about, 'A deterministic test agent that is WRONG ON PURPOSE in about half of its deliveries. Use it to test that your agent verifies work and disputes wrong deliveries before issuing an IOU (credit note).');
  for (const a of Object.values(sandbox.AGENTS)) assert.ok(a.about.length <= 300 && !/\bcredit note\b(?! *\))/.test(a.about), a.about);
  const fs = await import('node:fs'), os = await import('node:os'), pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'valun-testnet-sandbox-'));
  try {
    const pilot = new core.Pilot({store: new core.PilotStore(dir), basis: {nft: '0'.repeat(64), denomination: 'erg', allNotes: async () => [], note: async () => null}, log: () => {}});
    const keys = {}, cut = `${sandbox.SERVICES_TEXT.slice(0, 280)} stri`;
    // As valun.tech's records were on Nov 17: both offers cut; mallory's about the older text, sandbox-exact's as this build words it.
    for (const [i, handle] of ['sandbox-exact', 'sandbox-mallory'].entries()) {
      const id = `vp_00000000000${i}`, about = handle === 'sandbox-mallory' ? MALLORY_ABOUT_BEFORE : sandbox.AGENTS[handle].about;
      pilot.s.participants[id] = {id, handle, display_name: handle, operator: 'Valun operator (sandbox agent run by the server, no AI)', about, services: cut, status: 'active',
        created_at: new Date().toISOString(), mandate: {...core.DEFAULT_MANDATE}, mandate_version: 1, pubkey: '02' + 'ab'.repeat(32), past_pubkeys: []};
      keys[handle] = {id, pubkey: '02' + 'ab'.repeat(32), secret: 'cd'.repeat(32)};
    }
    fs.writeFileSync(pathMod.join(dir, 'sandbox-keys.json'), JSON.stringify(keys));
    const agents = new sandbox.Sandbox(pilot, {dataDir: dir});
    await agents.ensure();
    for (const p of Object.values(pilot.s.participants)) assert.deepEqual([p.about, p.services, p.profile_changed_by], [sandbox.AGENTS[p.handle].about, sandbox.SERVICES_TEXT, 'operator'], p.handle);
    // One profile change each, of only the fields that differed.
    const changes = () => fs.readFileSync(pathMod.join(dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'profile.updated');
    assert.deepEqual(changes().map(e => [e.id, e.by, e.fields]), [['vp_000000000000', 'operator', ['services']], ['vp_000000000001', 'operator', ['about', 'services']]]);
    const once = JSON.stringify(pilot.s.participants);
    await agents.ensure();
    assert.equal(JSON.stringify(pilot.s.participants), once, 'and not again');
    assert.equal(changes().length, 2, 'no change recorded the second time');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// What the server tells agents about a guarantee (GET /info guarantees.means, and every guarantee view's
// what_this_means) and how its evidence reads (public_position.evidence reads_as). Since fix inbox #107 the part a backer
// paid is held, so the issuer's IOU does not "stay as it is", and nothing gives the backer the claim; a set-off clears a
// debt (committed, not final), it does not settle it; and on the testnet holding an IOU is often a default, not a choice.
test('the server\'s words on the testnet: a paid guarantee holds that much of the IOU and gives the backer no claim; evidence says cleared, not settled', async () => {
  const {GUARANTEE_INFO} = await import('../lib/pilot/guarantees.mjs');
  const {EVIDENCE_READS_AS} = await import('../lib/pilot/evidence.mjs');
  assert.ok(GUARANTEE_INFO.means.includes("Once a backer pays, the same amount of the issuer's IOU is held, so the creditor isn't paid twice: the creditor can't spend, set off or redeem that part (held_for_backers). The backer doesn't take over the claim (no subrogation yet)"));
  assert.ok(GUARANTEE_INFO.means.includes('redeemable on Ergo testnet against the backer\'s tERG reserve if it posted one'));
  assert.doesNotMatch(GUARANTEE_INFO.means, /stays as it is|belongs to the backer|held for the backer|held from the creditor/);
  assert.equal(EVIDENCE_READS_AS.repayment, 'What it owed as an issuer, and how much of that was cleared in loops (by set-off: committed, not final) or redeemed against its reserve on Ergo testnet, kept apart under settled (by_setoff, by_redemption). A set-off among participants one operator runs can be staged: it shows debts cleared inside that group, not that it can pay anyone else.');
  assert.ok(EVIDENCE_READS_AS.acceptance.includes('on the testnet a new self-serve agent accepts any issuer\'s IOUs as payment by transfer by default, and its client signs that consent by itself'));
  assert.doesNotMatch(JSON.stringify(EVIDENCE_READS_AS), /\bsettlement\b|was settled|chose to hold/);
});

test('/info describes the testnet honestly; before the bootstrap every write is refused with 503', async () => {
  assert.match(routes.INFO_DESCRIPTIONS.off, /^Valun testnet network/);
  assert.match(routes.INFO_DESCRIPTIONS.off, /Ergo TESTNET: test coins with no monetary value/);
  assert.match(routes.INFO_DESCRIPTIONS.off, /netting\) are not on for this network yet/);
  assert.doesNotMatch(routes.INFO_DESCRIPTIONS.off, /PC \(pilot credits\)/);
  // Who the agents are so far, in the site's words (the redesign's live check, 2026-11-17: the server called them
  // "independently controlled", which /start lists as a known issue of valun 0.7.1's MCP server), in every mode.
  for (const [mode, text] of Object.entries(routes.INFO_DESCRIPTIONS)) {
    assert.ok(text.startsWith("Valun testnet network: agents, each holding its own key, propose, negotiate and accept deals paid with IOUs (credit notes). So far almost every agent is the team's or the operator's. Amounts are nanoERG on Ergo TESTNET: test coins with no monetary value. When a payer accepts a delivery it issues an IOU: a payer-signed Basis note recorded by a Basis tracker that anchors its state on Ergo testnet. "), mode);
    assert.doesNotMatch(text, /independent|service-for-credit|issues a credit note|\bfinal\b/, mode);
  }
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
      assert.match(text, /^---\nname: valun\n/, p);
      assert.match(text, /nanoERG\s+of\s+Ergo\s+testnet/);
      assert.match(text, /valun 0\.5 or later/);
      assert.match(text, /uvx --from valun==0\.7\.2 valun ergo redeem sandbox-exact 3000000 --broadcast/);
      // No PC: valun 0.7.2 names nanoERG with tERG in clearing run, clearing watch, status and policy show (its CHANGELOG:
      // "Amounts in the network's unit, never PC"), where skill.md had to say that 0.7.1's called nanoERG amounts PC, so
      // an agent never reads "3000000 PC" as 3,000,000 of the retired pilot's credits.
      assert.doesNotMatch(text.replace(/\s+/g, ' '), /\bPC\b/, 'no pilot credits on the testnet');
      // A shell agent copies a join that holds commitments for its human first; acting alone is the second, named as such.
      const shell = text.slice(text.indexOf('### Any agent with a shell'), text.indexOf('## 2. '));
      const joins = [...shell.matchAll(/^uvx --from valun==0\.7\.2 valun join --sandbox [^\n]*--approvals (\w+)$/gm)].map(m => m[1]);
      assert.deepEqual(joins, ['console', 'none'], p);
      assert.ok(shell.indexOf('Only if your human said you may act alone:') < shell.lastIndexOf('--approvals none'), p);
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
async function onChainServer({chain: moreChain = {}} = {}) {
  const PKA = '02' + 'a1'.repeat(32), PKB = '03' + 'b2'.repeat(32);
  const participants = {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa', handle: 'issuer-a', pubkey: PKA}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb', handle: 'holder-b', pubkey: PKB}};
  const calls = [], audit = [];
  const refuse = msg => Object.assign(new Error(`tracker POST /redemption/submit: ${msg}`), {name: 'BasisError'});
  const basis = {denomination: 'erg', nft: 'ab'.repeat(32),
    trackerState: async () => ({local_digest: 'd1', confirmed_digest: 'd1', confirmed_box_id: 'bx', confirmed_height: 639800, pending_tx_id: null}),
    // As the testnet's tracker gives them: its own total_debt is a placeholder it never maintains (0; the ratio infinite,
    // written as null). The server reads the debt from the tracker's notes instead (fix inbox #83).
    reserves: async () => [{box_id: 'r1', owner_pubkey: PKA, collateral_amount: 50_000_000, total_debt: 0, collateralization_ratio: null,
      last_updated_height: 639790, refund_initiation_height: null, reserve_token_id: null}, {box_id: 'r2', owner_pubkey: '02' + 'ee'.repeat(32), collateral_amount: 10_000_000}],
    note: async (issuer, recipient) => (issuer === PKA && recipient === PKB ? {amount_collected: 3_000_000, amount_redeemed: 1_000_000, timestamp: 1_700_000_000_123, signature: 'aa'.repeat(65)} : null),
    reserveCreate: async a => { calls.push(['reserveCreate', a]); return {requests: [{address: 'x', value: a.ergAmount}]}; },
    redemptionBuild: async a => { calls.push(['redemptionBuild', a]); return {unsigned_tx: {id: 'u', inputs: [{boxId: 'r', extension: EXT}]}, partial_tx: {id: 'p'}, new_already_redeemed: 3_000_000}; },
    redemptionSubmit: async a => { calls.push(['redemptionSubmit', a]); if (a.signed_tx === 'bad') throw refuse('input 0: proof does not verify'); return {tx_id: 'f0'.repeat(32)}; }};
  const pilot = {chain: {name: 'ergo-testnet', on_chain: true, tracker_nft_id: 'ab'.repeat(32), tracker_address: '3Wtest', reserve_contract: 'P2Stest', explorer: 'https://testnet.ergoplatform.com', ...moreChain},
    s: {participants}, openSandbox: true, unit: 'nanoERG', mode: 'off', basis, store: {audit: e => audit.push(e)}, selfServe: () => null,
    byPubkey: pk => Object.values(participants).find(x => x.pubkey === pk) || null,
    // The tracker's notes as Pilot.ledger gives them: issuer-a's note to holder-b, 3000000 recorded and 1000000 redeemed.
    ledger: async () => [{issuer: 'vp_aaaaaaaaaaaa', issuer_handle: 'issuer-a', recipient: 'vp_bbbbbbbbbbbb', recipient_handle: 'holder-b', issuer_pubkey: PKA, recipient_pubkey: PKB,
      total: 3_000_000, redeemed: 1_000_000, outstanding: 2_000_000, timestamp: 1_700_000_000_123, confirmation: 'local_only', unit: 'nanoERG'}],
    authenticate: t => (t === 'vpa_b' ? {role: 'agent', p: participants.vp_bbbbbbbbbbbb} : t === 'vpo_b' ? {role: 'owner', p: participants.vp_bbbbbbbbbbbb} : null)};
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body) => { r.writeHead(status, {'content-type': 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try { await handler(req, res, url, send, () => '127.0.0.1'); }
    // A refusal's own fields (retry_after_ms, ...) too, as lib/http.mjs answers it.
    catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message, ...(e.extra || {})}); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/pilot/v1`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, body: JSON.parse(text), text};
  };
  return {server, call, calls, audit, PKA, PKB, base};
}

test('on chain: GET /chain shows the anchoring and the explorer links; GET /reserves names the owners who are participants', async () => {
  const {server, call, base} = await onChainServer();
  try {
    const c = await call('GET', '/chain');
    assert.equal(c.status, 200);
    assert.equal(c.body.network, 'valun-testnet-1');
    // fix inbox #62: the box's windows from its height (no node here, so no age), and the anchored text that says what
    // holds while the box is fresh (test/anchoring.test.mjs pins it); a netting is committed, not final (fix inbox #85).
    const {ANCHORED_MEANS} = await import('../lib/pilot/anchors.mjs');
    assert.deepEqual(c.body.anchoring, {local_digest: 'd1', confirmed_digest: 'd1', confirmed_box_id: 'bx', confirmed_height: 639800,
      node_height: null, box_age_blocks: null, novations_refused_from_height: 641240, tracker_less_redemption_from_height: 641961, pending_tx_id: null, anchored: true,
      check_interval_seconds: 1800, state: 'anchored', what_this_means: ANCHORED_MEANS});
    assert.match(ANCHORED_MEANS, /every netting so far is committed \(it stays committed only as long as the tracker key never commits an earlier total again: see skill\.md, Trust model\)\./);
    assert.equal(c.body.spend_ledger, undefined, 'the server-side ledger path is never public');
    assert.equal(c.body.links.tracker_nft, `https://testnet.ergoplatform.com/en/token/${'ab'.repeat(32)}`);
    assert.equal(c.body.links.tracker_address, 'https://testnet.ergoplatform.com/en/addresses/3Wtest');
    const r = await call('GET', '/reserves');
    assert.equal(r.status, 200);
    assert.equal(r.body.unit, 'nanoERG');
    assert.equal(r.body.reserve_contract, 'P2Stest');
    assert.equal(r.body.reserves.length, 2);
    assert.equal(r.body.reserves[0].handle, 'issuer-a');
    assert.equal(r.body.reserves[0].collateral_nanoerg, 50_000_000);
    assert.deepEqual([r.body.reserves[0].total_debt_nanoerg, r.body.reserves[0].collateralization_ratio, 'why_null' in r.body.reserves[0]], [2_000_000, 25, false],
      'what issuer-a owes on the tracker\'s notes (3000000 recorded, 1000000 redeemed), not the tracker\'s placeholder 0 (fix inbox #83)');
    assert.equal(r.body.reserves[1].handle, null, 'an owner who is not a participant has no handle');
    assert.deepEqual([r.body.reserves[1].total_debt_nanoerg, r.body.reserves[1].collateralization_ratio], [0, null]);
    assert.match(r.body.reserves[1].why_null, /^nothing is owed on the notes signed with this reserve's key \(the owner has none outstanding on this tracker\)/);
    assert.equal(r.body.meaning, routes.RESERVES_MEANING);
    // Fix inbox #142: a HEAD is answered as the GET, with no body (`curl -sI .../pilot/v1/chain` said 401).
    for (const p of ['/chain', '/reserves']) {
      const h = await fetch(base + p, {method: 'HEAD'});
      assert.deepEqual([h.status, (await h.arrayBuffer()).byteLength], [200, 0], `HEAD ${p}`);
    }
  } finally { server.close(); }
});

// Fix inbox #83: GET /reserves gave total_debt_nanoerg 0 and collateralization_ratio null for every reserve (sandbox-exact
// owed 56,250,000 against a 133,250,000 reserve): it passed on the tracker's own total_debt, a placeholder the tracker
// never maintains. A real Pilot over a fake tracker, through the HTTP routes: each reserve's debt is what IT backs, the
// outstanding amount of the notes signed with its own key (its contract pays no others), and the ratio is collateral /
// that; the owner's debt under its other keys is shown apart and not in the ratio, so public_position.owes (every key)
// is the sum of the two. A reserve whose key owes anything never shows 0; a figure that cannot be computed is null.
test('fix inbox #83: GET /reserves gives each reserve what it backs (the notes signed with its own key) and the ratio over that; the owner\'s debt under its other keys apart, so public_position.owes is their sum; a reserve whose key owes anything never shows 0, and a figure that cannot be computed is null with why_null', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), pathMod = await import('node:path'), crypto = await import('node:crypto');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'valun-testnet-reserves-')), hex = n => crypto.randomBytes(n).toString('hex'), key = () => '02' + hex(32);
  const notes = [], reserves = [];
  let notesDown = false;
  const basis = {nft: '0'.repeat(64), denomination: 'erg', note: async () => null, reserves: async () => reserves,
    allNotes: async () => { if (notesDown) throw new Error('tracker unreachable'); return notes; }};
  const pilot = new core.Pilot({store: new core.PilotStore(dir), basis, log: () => {}});
  pilot.chain = {name: 'ergo-testnet', on_chain: true, tracker_nft_id: basis.nft, reserve_contract: 'P2Stest', explorer: 'https://testnet.ergoplatform.com'};
  const person = (handle, past = []) => { const id = 'vp_' + hex(6); return (pilot.s.participants[id] = {id, handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: key(),
    status: 'active', created_at: new Date().toISOString(), mandate: {...core.DEFAULT_MANDATE}, mandate_version: 1, past_pubkeys: past.map(pubkey => ({pubkey, registered_at: null, revoked_at: null}))}); };
  const note = (issuer, recipient, total, redeemed = 0) => notes.push({issuer_pubkey: issuer, recipient_pubkey: recipient, amount_collected: total, amount_redeemed: redeemed,
    timestamp: 1_700_000_000_000 + notes.length, signature: '02' + hex(64), denomination: 'erg'});
  const reserve = (owner, collateral, extra = {}) => { const box_id = hex(32); reserves.push({box_id, owner_pubkey: owner, collateral_amount: collateral, total_debt: 0, collateralization_ratio: null,
    last_updated_height: 646822, refund_initiation_height: 0, reserve_token_id: null, ...extra}); return box_id; };
  const old = key(), idle = key(), outsider = key();
  const X = person('exact-like'), Y = person('rotated', [old]), V = person('rotated-idle', [idle]), Z = person('owes-nothing'), A = person('creditor-a'), B = person('creditor-b');
  // exact-like has sandbox-exact's shape: notes partly and fully redeemed (6000000 + 0 + 3000000 owed of 18000000 recorded).
  note(X.pubkey, A.pubkey, 10_000_000, 4_000_000); note(X.pubkey, B.pubkey, 5_000_000, 5_000_000); note(X.pubkey, Y.pubkey, 3_000_000);
  // rotated has two keys: it owes 3000000 under its earlier key and 2000000 under its current one, with a reserve under
  // each; rotated-idle owes 1000000 under its current key, and its reserve is under its earlier key, which owes nothing;
  // an outsider key (no participant's) owes 1000000.
  note(old, A.pubkey, 4_000_000, 1_000_000); note(Y.pubkey, B.pubkey, 2_000_000); note(V.pubkey, A.pubkey, 1_000_000); note(outsider, A.pubkey, 1_500_000, 500_000);
  const rX = reserve(X.pubkey, 20_000_000), rY = reserve(Y.pubkey, 5_000_000), rOld = reserve(old, 4_000_000), rIdle = reserve(idle, 6_000_000), rZ = reserve(Z.pubkey, 7_000_000);
  const rOut = reserve(outsider, 3_000_000), rToken = reserve(X.pubkey, 999, {reserve_token_id: 'cd'.repeat(32)}), rNoOwner = reserve(null, 8_000_000), rNoValue = reserve(X.pubkey, undefined);
  const handler = routes.createPilotRoutes({pilot, cfg: {}, adminTokenHash: 'x'.repeat(64)});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (r, status, body) => { r.writeHead(status, {'content-type': 'application/json'}); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try { await handler(req, res, url, send, () => '127.0.0.1'); }
    catch (e) { send(res, e.status || 500, {error: e.code || 'error', message: e.message}); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const get = async p => { const r = await fetch(`http://127.0.0.1:${server.address().port}/pilot/v1${p}`); assert.equal(r.status, 200, p); return r.json(); };
  try {
    const body = await get('/reserves'), row = id => body.reserves.find(r => r.box_id === id);
    const figures = id => { const r = row(id); return [r.collateral_nanoerg, r.total_debt_nanoerg, r.collateralization_ratio, r.debt_under_other_keys_nanoerg ?? null]; };
    assert.equal(body.reserves.length, reserves.length);
    assert.deepEqual(figures(rX), [20_000_000, 9_000_000, 2.2222, null], 'total - redeemed over the notes its key signed; the ratio rounded down to 4 decimals');
    assert.equal('why_null' in row(rX), false);
    // An owner with two keys: each reserve backs the notes its own key signed; the rest is apart and not in the ratio.
    assert.deepEqual(figures(rY), [5_000_000, 2_000_000, 2.5, 3_000_000], 'the reserve under its current key: 2000000 owed there; 3000000 under its earlier key, not in the ratio');
    assert.deepEqual(figures(rOld), [4_000_000, 3_000_000, 1.3333, 2_000_000], 'the reserve under its earlier key: 3000000 owed there; 2000000 under its current key');
    assert.equal('why_null' in row(rY) || 'why_null' in row(rOld), false);
    assert.deepEqual(figures(rIdle), [6_000_000, 0, null, 1_000_000], 'its key owes nothing: no ratio, though the owner owes under its other key');
    assert.equal(row(rIdle).why_null, 'nothing is owed on the notes signed with this reserve\'s key (rotated-idle has none outstanding on this tracker), so there is no collateralization ratio');
    assert.deepEqual([row(rOut).handle, ...figures(rOut)], [null, 3_000_000, 1_000_000, 3, null], 'an owner key that is no participant\'s: what that key owes');
    assert.deepEqual(figures(rZ), [7_000_000, 0, null, null]);
    assert.equal(row(rZ).why_null, 'nothing is owed on the notes signed with this reserve\'s key (owes-nothing has none outstanding on this tracker), so there is no collateralization ratio');
    assert.deepEqual([...figures(rToken), row(rToken).collateral_token_units], [null, null, null, null, 999], 'a token reserve: nothing in nanoERG');
    assert.match(row(rToken).why_null, /^a token reserve \(reserve_token_id\): its collateral is in units of that token, not nanoERG/);
    assert.deepEqual([row(rNoOwner).owner_pubkey, ...figures(rNoOwner)], [null, 8_000_000, null, null, null]);
    assert.equal(row(rNoOwner).why_null, 'the tracker names no owner key for this reserve, so whose notes it backs is unknown');
    assert.deepEqual(figures(rNoValue), [null, 9_000_000, null, null], 'no collateral read as 0');
    assert.equal(row(rNoValue).why_null, 'the tracker gives no whole collateral amount for this reserve');
    // public_position.owes counts every key the owner has had: it is total_debt_nanoerg plus debt_under_other_keys_nanoerg,
    // the same as total_debt_nanoerg for an owner with one key, and more for rotated (5000000 against 2000000 and 3000000).
    for (const p of [X, Y, V, Z]) {
      const owes = (await get(`/participants/${p.id}`)).public_position.owes;
      for (const r of body.reserves.filter(r => r.handle === p.handle && !r.reserve_token_id))
        assert.equal(r.total_debt_nanoerg + (r.debt_under_other_keys_nanoerg ?? 0), owes, `${p.handle}: /reserves and public_position.owes`);
      if (p === Y) assert.deepEqual([owes, row(rY).total_debt_nanoerg, row(rOld).total_debt_nanoerg], [5_000_000, 2_000_000, 3_000_000]);
    }
    // A reserve whose own key has outstanding notes never reports 0: exactly the sum of total - redeemed over them; and its
    // owner's other keys are exactly the rest of what the participant owes.
    const otherKeysOf = r => { const q = pilot.byPubkey(r.owner_pubkey); return new Set(q ? [q.pubkey, ...q.past_pubkeys.map(k => k.pubkey)].filter(k => k !== r.owner_pubkey) : []); };
    const owedBy = keys => notes.filter(n => keys.has(n.issuer_pubkey)).reduce((a, n) => a + Math.max(0, n.amount_collected - n.amount_redeemed), 0);
    let checked = 0;
    for (const r of body.reserves.filter(r => r.owner_pubkey && !r.reserve_token_id)) {
      const owed = owedBy(new Set([r.owner_pubkey]));
      if (owed > 0) { checked++; assert.ok(r.total_debt_nanoerg > 0, `${r.box_id} reports ${r.total_debt_nanoerg} with ${owed} outstanding`); }
      assert.deepEqual([r.total_debt_nanoerg, r.debt_under_other_keys_nanoerg ?? 0], [owed, owedBy(otherKeysOf(r))], r.box_id);
    }
    assert.equal(checked, 5);
    // What cannot be computed is null, never 0: a note without a whole redeemed amount under rotated's earlier key (what the
    // reserve under that key backs, and rotated's debt under its other keys as the current key's reserve sees it), then the
    // tracker's notes unreadable.
    notes.push({issuer_pubkey: old, recipient_pubkey: B.pubkey, amount_collected: 1_000_000, timestamp: 1_700_000_001_000, signature: '02' + hex(64), denomination: 'erg'});
    const bad = (await get('/reserves')).reserves, badRow = id => bad.find(r => r.box_id === id);
    assert.deepEqual([badRow(rOld).total_debt_nanoerg, badRow(rOld).collateralization_ratio, badRow(rOld).debt_under_other_keys_nanoerg], [null, null, 2_000_000]);
    assert.equal(badRow(rOld).why_null, 'a note signed with this reserve\'s key has no whole total or redeemed amount on the tracker (or they add up past 2^53 - 1), so what the reserve backs is unknown');
    assert.deepEqual([badRow(rY).total_debt_nanoerg, badRow(rY).collateralization_ratio, badRow(rY).debt_under_other_keys_nanoerg], [2_000_000, 2.5, null], 'what the reserve backs is still known');
    assert.equal(badRow(rY).why_null, 'a note rotated issued under another key has no whole total or redeemed amount on the tracker (or they add up past 2^53 - 1), so what it owes under its other keys is unknown');
    notesDown = true;
    const down = await get('/reserves'), downRow = id => down.reserves.find(r => r.box_id === id);
    assert.equal(down.reserves.length, reserves.length, 'the reserves are still listed');
    for (const r of down.reserves.filter(r => r.owner_pubkey && !r.reserve_token_id)) {
      assert.deepEqual([r.total_debt_nanoerg, r.collateralization_ratio], [null, null], r.box_id);
      assert.match(r.why_null, /the tracker's notes could not be read just now, so what this reserve backs is unknown \(not 0\); try again/);
    }
    assert.deepEqual([rY, rOld, rIdle].map(id => downRow(id).debt_under_other_keys_nanoerg), [null, null, null], 'an owner with other keys: unknown, not 0');
    assert.deepEqual([rX, rZ, rOut].map(id => 'debt_under_other_keys_nanoerg' in downRow(id)), [false, false, false], 'an owner with one key has no other keys');
  } finally { server.close(); fs.rmSync(dir, {recursive: true, force: true}); }
  // The rule itself: at least 0 a note (the tracker's outstanding_debt), and nothing read as 0 that is not a whole number.
  const K = key();
  assert.deepEqual(routes.reserveRows([{owner_pubkey: K, collateral_amount: 10}], [{issuer: null, issuer_pubkey: K, total: 5, redeemed: 7}], () => null).map(r => r.total_debt_nanoerg), [0]);
  assert.deepEqual(routes.reserveRows([{owner_pubkey: K, collateral_amount: '12'}, {owner_pubkey: K, collateral_amount: 1.5}, {owner_pubkey: K, collateral_amount: -3}], [], () => null)
    .map(r => r.collateral_nanoerg), [12, null, null]);
});

// Fix inbox #88: GET /info published the chain whole, the wallet adapter's spend ledger with it (a path on the server's
// volume), and named the node it reads with nothing to say what it is. Both public answers now give the chain without
// the server's own files, and the node, still a URL (the clients and the auditors read it as one), with node_note.
test('fix inbox #88: GET /info and GET /chain show no server path (spend_ledger), and name the node the server reads for what it is (node_note)', async () => {
  const ledger = '/data/pilot/tracker/spend-ledger.jsonl', node = 'http://213.239.193.208:9052';
  const {server, call} = await onChainServer({chain: {node, spend_ledger: ledger}});
  try {
    for (const p of ['/info', '/chain']) {
      const r = await call('GET', p);
      assert.equal(r.status, 200, p);
      const chain = p === '/info' ? r.body.chain : r.body;
      assert.equal('spend_ledger' in chain, false, p);
      assert.ok(!r.text.includes(ledger) && !r.text.includes('/data/'), `${p}: no server path`);
      assert.deepEqual([chain.node, chain.node_note], [node, routes.NODE_NOTE], p);
      assert.match(chain.node_note, /^The Ergo testnet node this server reads the chain from, .*not as a node to trust: .*your own node or an explorer\.$/);
    }
    const info = (await call('GET', '/info')).body;
    assert.deepEqual(Object.keys(info.chain), ['name', 'on_chain', 'tracker_nft_id', 'tracker_address', 'reserve_contract', 'explorer', 'node', 'node_note']);
  } finally { server.close(); }
  // Without a node configured there is nothing to label.
  assert.deepEqual(routes.publicChain({on_chain: false, spend_ledger: ledger}), {on_chain: false});
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
    // The reserve's box is spent: the next build against it waits until the tracker follows its new box (fix inbox #26).
    const busy = await call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
    assert.deepEqual([busy.status, busy.body.error], [409, 'reserve_busy']);
    assert.ok(busy.body.message.includes(`being confirmed (tx ${'f0'.repeat(32)})`), busy.body.message);
  } finally { server.close(); }
  // At most REDEMPTION_BUILDS_PER_DAY builds a day per agent (each can cost the tracker a miner fee); refused requests
  // count only towards REDEMPTION_ATTEMPTS_PER_DAY (fix inbox #14: a note not anchored yet used up a build). Builds an
  // agent replaces (none submitted) are its own: the reserve's hold does not refuse them.
  const s2 = await onChainServer();
  try {
    let last;
    for (let i = 0; i <= routes.REDEMPTION_BUILDS_PER_DAY; i++) last = await s2.call('POST', '/redemption/build', {issuer: 'issuer-a', amount: 1_000_000}, 'vpa_b');
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'rate_limited');
    assert.match(last.body.message, /redemption builds a day per agent/);
    // With how long until the next build is taken: once the first of these builds is 24 hours old (the local-readiness
    // audit of Nov 18, MR-4: every rate_limited answer says how long; this one said nothing). Made within seconds.
    assert.ok(Number.isInteger(last.body.retry_after_ms) && last.body.retry_after_ms > 864e5 - 600e3 && last.body.retry_after_ms <= 864e5,
      `retry_after_ms ${last.body.retry_after_ms}`);
  } finally { s2.server.close(); }
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
  // A person's buttons (Close your own loop, Bring your own agent) open the page for people, /start; agents read skill.md.
  assert.equal(loops.startHref('#agent'), `${T}/start#agent`);
  assert.equal(loops.startHref(''), `${T}/start`);
  const agents = await import('../lib/pilot/agents.mjs');
  for (const html of [agents.renderAgentNotFound(), agents.renderMaintainersPage()]) {
    assert.ok(html.includes(`href="${T}/start#agent"`));
    assert.doesNotMatch(html, /valun\.tech\/(#agent|skill\.md|start)/);
  }
  const loopCard = loops.renderLoopPage({...loop, participants: 2, cycles: [{length: 2, each_PC: 1_000_000, members: [{handle: 'a', kind: 'invited'}, {handle: 'b', kind: 'invited'}]}]});
  assert.ok(loopCard.includes(`<a class="btn primary" href="${T}/start">Close your own loop</a>`));
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
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    const text = await r.text();
    assert.match(text, /^# Valun testnet\n/);
    assert.match(text, /reads https:\/\/valun-testnet\.fly\.dev\/skill\.md/);
    // Fix inbox #88: every link is the network's own (its public origin, here the test's), and nothing says pilot.
    const urls = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map(x => x[0]);
    assert.ok(urls.length >= 10 && urls.every(u => u.startsWith(`${T}/`) || u.startsWith('https://github.com/fitzss/')), JSON.stringify(urls));
    assert.doesNotMatch(text, /\{origin\}|pilot network|no backing/i);
  } finally { srv.close(); }
});

// Fix inbox #88: valun.tech serves the testnet (its app replays to the testnet's since 2026-11-13), and its llms.txt
// sent every link to valun-testnet.fly.dev and called valun.tech "the pilot network (credits with no backing)". It now
// names the network at its public origin, as the pages the server renders do: valun.tech, as fly.testnet.toml sets it.
test('fix inbox #88: llms.txt names the testnet at its public origin, valun.tech as the testnet sets it, and never calls it the pilot', async () => {
  const fs = await import('node:fs'), pathMod = await import('node:path'), {fileURLToPath, pathToFileURL} = await import('node:url'), {spawnSync} = await import('node:child_process');
  const root = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const origin = /^\s*VALUN_PUBLIC_ORIGIN\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(pathMod.join(root, 'fly.testnet.toml'), 'utf8'))?.[1];
  assert.equal(origin, 'https://valun.tech');
  // The testnet's process as its deploy configures it (PILOT_NETWORK and VALUN_PUBLIC_ORIGIN are read at load).
  const code = `const {llmsText} = await import(${JSON.stringify(pathToFileURL(pathMod.join(root, 'lib/http.mjs')).href)}); process.stdout.write(llmsText(${JSON.stringify(pathMod.join(root, 'public'))}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {env: {...process.env, PILOT_NETWORK: 'valun-testnet-1', VALUN_PUBLIC_ORIGIN: origin}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout;
  assert.match(text, /^# Valun testnet\n/);
  assert.ok(text.includes('To join, an agent reads https://valun.tech/skill.md and follows it.'));
  for (const p of ['/skill.md', '/skill.md#trust-model', '/.well-known/agent-card.json', '/a2a', '/pilot/v1/info', '/pilot/v1/chain', '/pilot/v1/reserves', '/pilot/v1/participants', '/pilot/v1/loops', '/network', '/start',
    '/start#look', '/start#tour', '/start#agent', '/start#ergo', '/start#report', '/trust', '/memory', '/agent/<handle>', '/loop/<id>', '/pilot#owner'])
    assert.ok(text.includes(`https://valun.tech${p}`), p);
  // The home page is the origin itself (/home is the same page on every host, but valun.tech's address for it is /).
  assert.ok(text.includes('[Home](https://valun.tech/)'));
  assert.doesNotMatch(text, /valun\.tech\/home\b/);
  const urls = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map(x => x[0]);
  assert.ok(urls.every(u => u.startsWith('https://valun.tech/') || u.startsWith('https://github.com/fitzss/')), JSON.stringify(urls));
  assert.doesNotMatch(text, /valun-testnet\.fly\.dev|\{origin\}|pilot network|no backing/i);
  // What it says of the chain stays within what works (outside-tester review, 2026-11-15; fix inbox #85, #100): anchored,
  // not "settled"; redemption only against a reserve the issuer posted; a netting committed, never "final", and only
  // with its condition; and nothing that reads as adoption.
  assert.ok(text.includes('> Credit for machines, anchored on Ergo testnet.'));
  assert.ok(text.includes('A creditor can redeem a note for tERG against its issuer\'s reserve, if the issuer posted one.'));
  assert.ok(text.includes('a committed netting stays committed only as long as the tracker key never commits an earlier total again'));
  assert.ok(text.includes('So far almost every agent on the network is the team\'s or the operator\'s.'));
  assert.doesNotMatch(text, /\bsettled\b|anchors every set-off|\bfinal\b|\bguarantee[sd]?\b/);
  // The review of 24bec43: a loop lowers every debt in it by the smallest, not "cancelled"; the testnet's default
  // acceptance said where passing on is; the tour's length as everywhere else; few reserves; the console shows the card.
  for (const s of ['When IOUs form a loop, every debt in it falls by the same amount, the smallest one.',
    'By default a new agent on this network accepts any issuer\'s IOUs that way, up to 0.04 tERG per issuer, and its owner can narrow that.',
    'the tour in 2 to 3 minutes', 'the few reserves posted (most issuers have none), and the debt each backs',
    'see whether the budget card is public (publish it with valun card publish)',
    // What console approvals hold, the backing offers included, and what they never hold: a consent, or the IOU that
    // honors a call (guarantees.mjs honor: recorded at once). Said without the word this file keeps out (above).
    'console approvals hold (its offers, counter-offers and acceptances, its offers to back another agent\'s debt, and the IOU or payment by transfer at each delivery; never a consent, nor the IOU it pays when a debt it backs is called)'])
    assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /the loop is cancelled|about 3 minutes|publish the budget card,|reserves that back this network's notes/);
  // The same text with an origin given, in this process; the pilot's own file is served as it is.
  const {llmsText, LLMS_ORIGIN} = await import('../lib/http.mjs');
  assert.equal(llmsText(pathMod.join(root, 'public'), origin), text);
  assert.ok(fs.readFileSync(pathMod.join(root, 'public', 'llms-testnet.txt'), 'utf8').includes(`${LLMS_ORIGIN}/skill.md`));
  assert.equal(fs.readFileSync(pathMod.join(root, 'public', 'llms.txt'), 'utf8').includes(LLMS_ORIGIN), false);
});

// Fix inbox #48: the pages the server renders say no PC on the testnet. The maintainers page's example of what an agent
// offers priced it in PC, the retired pilot's unit; its prices are the network's, read as the house agents' own offers are.
test('the testnet\'s rendered pages say no PC: the maintainers page prices its example in nanoERG (tERG) (fix inbox #48)', async () => {
  const agents = await import('../lib/pilot/agents.mjs'), loops = await import('../lib/pilot/loops.mjs');
  const html = agents.renderMaintainersPage();
  assert.ok(html.includes('<code>uvx --from valun==0.7.2 valun profile --services "PR review for Python projects (3000000 nanoERG (0.003 tERG)); issue triage (2000000 nanoERG (0.002 tERG))"</code>'));
  assert.ok(html.includes('<code>uvx --from valun==0.7.2 valun profile --wants "docs for new modules (3000000 nanoERG (0.003 tERG))"</code>'));
  for (const page of [html, agents.renderAgentNotFound(), loops.renderLoopNotFound()]) assert.doesNotMatch(page, /\bPC\b/);
});

// The outside-tester review (2026-11-15): the maintainers page said "nothing is ever paid out" (testnet redemptions pay
// tERG) and "the whole stack is open source" (the tracker fork is not public: fix inbox #99), priced its jobs in bare
// credits, and ended as the pilot did; agent pages said "credits have no monetary value" and called a sandbox agent with
// no AI model "an AI agent". On the testnet they say what the network is.
test('the maintainers page and agent pages in the testnet\'s words: tERG, redemption only against a reserve, the tracker not public', async () => {
  const agents = await import('../lib/pilot/agents.mjs'), loops = await import('../lib/pilot/loops.mjs');
  const html = agents.renderMaintainersPage();
  assert.ok(html.includes('<li>It runs on Ergo testnet: tERG are test coins with no monetary value. An IOU can be redeemed for tERG only against its issuer&#39;s reserve, if the issuer posted one.</li>'));
  assert.ok(html.includes('The Basis tracker the network runs is Valun\'s fork of basis-tracker, and its source is not public yet.'));
  for (const job of ['Review a pull request</strong> · about 0.003 tERG', 'Triage issues</strong> · about 0.002 tERG']) assert.ok(html.includes(job), job);
  assert.ok(html.includes('reviews code for 0.003 tERG, up to 3 jobs a day for each buyer'));
  assert.doesNotMatch(html, /\bcredits\b|\d\s*credit\b/, 'the testnet prices in tERG, not credits (the brand line, credit for machines, is not a price)');
  // The honest line ends the page, above the shared footer, which says test coins too.
  assert.ok(html.includes(`<p class="provenance">${loops.ON_TESTNET_FOOTER}</p>`));
  assert.ok(html.includes('<footer class="foot">\n  <p>Ergo testnet · test coins only, with no monetary value</p>'));
  assert.doesNotMatch(html, /nothing is ever paid out|whole stack|credits have no monetary value|about \d credits</i);
  const view = agents.agentView({id: 'vp_000000000001', handle: 'sandbox-exact', joined_at: '2026-11-12', agent_last_seen: null, operator: 'Valun operator'}, null, [], {now: Date.now()});
  const page = agents.renderAgentPage(view);
  assert.ok(page.includes(`Operated by Valun operator. Joined 2026-11-12. ${loops.ON_TESTNET_FOOTER}</p>`));
  assert.match(agents.agentDescription(view), /^sandbox-exact is an agent on Valun, where agents work/);
  assert.doesNotMatch(page, /credits have no monetary value|an AI agent on Valun/);
  assert.equal(loops.ON_TESTNET_FOOTER, 'Valun testnet: promises are recorded by a Basis tracker that anchors its state on Ergo testnet; tERG are test coins with no monetary value.');
});

// The A2A front door on the testnet: its join answer gives commands an agent can run as they are (the pinned client, the
// handle and operator given, the owner token written to a file), and its limits and card in tERG, not credits.
test('the A2A join answer and card on the testnet: runnable commands, limits in nanoERG with tERG, test coins', async () => {
  const {createHandler} = await import('../lib/http.mjs');
  const {createA2A, agentCard} = await import('../lib/a2a.mjs');
  const {fakePilot} = await import('./fixtures/a2a-pilot.mjs');
  const core2 = await import('../lib/pilot/core.mjs');
  const pilot = {...fakePilot(), unit: 'nanoERG', selfServe: () => ({join: '/pilot/v1/join-sandbox', open_network: true, days: 7, limits: {...core2.SANDBOX_CAPS},
    max_open_offers: core2.OPEN_NETWORK_MAX_OPEN_OFFERS, renews_while_active: true})};
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public', a2a: createA2A({pilot})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/a2a`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {message: {messageId: 'm', role: 'ROLE_USER', parts: [{text: 'How do I join?'}]}}})});
    const m = (await r.json()).result.message, text = m.parts[0].text, data = m.parts[1].data;
    // The limits GET /info self_serve gives (Pilot.selfServe), the open-offer limit included, as skill.md says them.
    assert.match(text, /for 7 days, renewed while it is active, at most 5000000 nanoERG \(0\.005 tERG\) per deal and 40000000 nanoERG \(0\.04 tERG\) owed in total, and at most 10 open offers of its own at once\. Amounts are nanoERG of Ergo testnet: tERG are test coins with no monetary value\.$/);
    assert.equal(data.limits.max_open_offers, 10);
    assert.equal(data.unit, 'nanoERG');
    assert.equal(data.limits.limits.max_issue_per_deal, 5_000_000);
    // A shell can't prompt the human: console first (the human approves each commitment), none only if they said so.
    const join = 'uvx --from valun==0.7.2 valun join --sandbox --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';
    assert.ok(text.includes(`If your human wants to approve what you sign (console approvals, the first tester's default): ${join} --approvals console (they approve at ${data.network.replace(/\/network$/, '')}/pilot#owner). Only if your human said you may act alone: ${join} --approvals none.`));
    assert.ok(text.indexOf('--approvals console') < text.indexOf('--approvals none'), 'console first');
    assert.equal(data.shell[0], `${join} --approvals console`);
    assert.ok(text.includes('Console approvals protect your human only while you can\'t read the owner token: tell them to move that file into their password manager.'));
    // The testnet's default acceptance, said to the joiner; the evidence for each way in, labelled.
    // Each client signs only for its own key (D3b, the redesign's round 2): never "its client signs ... the issuer's".
    assert.ok(text.includes('By default your agent accepts any issuer\'s IOUs as payment by transfer, up to 0.04 tERG per issuer. Your client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. Your human can narrow whose IOUs it accepts under "Accept notes from" in the owner console.'));
    assert.doesNotMatch(text, /signs that consent, and the issuer's/);
    assert.ok(text.includes('These two lines have run end to end once (Claude Code 2.1.326, Nov 17, headless); Claude Code\'s own approval prompts are not yet tested.'));
    assert.ok(text.includes('There is also a plugin (/plugin marketplace add fitzss/valun-open, then /plugin install valun@valun): an install check only, not yet run end to end.'));
    // The MCP join is skill.md's with --approvals console, as the run that went end to end used (and the live build has).
    assert.equal(data.mcp[0], `${join} --approvals console`);
    assert.ok(text.includes('Apart from the Claude Code run, only scripted MCP clients have run it; no other app (Codex, Cursor, Claude Desktop, VS Code) has been verified.'));
    assert.doesNotMatch(text, /\bcredits\b|\bPC\b/);
  } finally { srv.close(); }
  const card = agentCard('https://valun.tech');
  assert.match(card.description, /Valun runs on Ergo testnet: tERG are test coins with no monetary value\.$/);
  assert.doesNotMatch(card.description, /credits have no monetary value/i);
  // What an agent can do, not adoption: so far the network is the team's and the operator's; and the testnet's default
  // acceptance, in the words the site uses.
  assert.ok(card.description.includes('On Valun, an AI agent can agree jobs with agents other people run and pay with signed IOUs'));
  assert.doesNotMatch(card.description, /AI agents run by different people agree/);
  assert.ok(card.description.includes('So far almost every agent on the network is the team\'s or the operator\'s.'));
  assert.ok(card.description.includes('On the testnet a new self-serve agent accepts any issuer\'s IOUs as payment by transfer, up to 0.04 tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. Its owner can narrow whose IOUs it accepts under "Accept notes from" in the owner console.'));
});

// The budget card (lib/pilot/card.mjs) on the testnet: its amounts are nanoERG, its reasons and the agent page's line read
// them as people do (nanoERG with tERG), its links are the testnet's, and nothing says PC.
test('the budget card on the testnet: nanoERG amounts, reasons and the page line in nanoERG (tERG), testnet links, no PC', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), pathMod = await import('node:path'), crypto = await import('node:crypto');
  const {budgetCard, checkPayer} = await import('../lib/pilot/card.mjs');
  const agents = await import('../lib/pilot/agents.mjs');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'valun-testnet-card-')), hex = n => crypto.randomBytes(n).toString('hex'), now = Date.now();
  try {
    const notes = [];
    const pilot = new core.Pilot({store: new core.PilotStore(dir), basis: {nft: '0'.repeat(64), denomination: 'erg', allNotes: async () => notes, note: async () => null}, log: () => {}});
    const person = handle => (pilot.s.participants['vp_' + hex(6)] = {handle, display_name: handle, operator: 'test', pubkey: '02' + hex(32), status: 'active', created_at: new Date(now).toISOString(),
      mandate: {...core.DEFAULT_MANDATE, ...core.SANDBOX_CAPS, approve_above: units.pc(1000), expires_at: new Date(now + 864e5).toISOString()}, mandate_version: 1, past_pubkeys: []});
    const amy = person('amy-payer'), bob = person('bob-payee');
    for (const [id, p] of Object.entries(pilot.s.participants)) p.id = id;
    notes.push({issuer_pubkey: amy.pubkey, recipient_pubkey: bob.pubkey, amount_collected: '9000000', amount_redeemed: '0', timestamp: 1000, signature: '02' + hex(64), denomination: 'erg'});
    pilot.setMandate(amy, {public_card: true});
    const card = await budgetCard(pilot, amy);
    assert.deepEqual([card.network, card.unit, card.mandate.per_deal, card.mandate.outstanding_cap, card.room.outstanding, card.room.room_left], ['valun-testnet-1', 'nanoERG', 5_000_000, 40_000_000, 9_000_000, 31_000_000]);
    assert.equal(card.check, `https://valun-testnet.fly.dev/pilot/v1/participants/${amy.id}/check?amount={amount}&payee={payee}`);
    assert.equal(card.page, 'https://valun-testnet.fly.dev/agent/amy-payer');
    const c = await checkPayer(pilot, amy, {amount: 3_000_000, payee: bob});
    assert.deepEqual([c.verdict, c.payer_side.reasons], ['accept', ['Within its budget: up to 5000000 nanoERG (0.005 tERG) a deal, 31000000 nanoERG (0.031 tERG) of 40000000 nanoERG (0.04 tERG) left.']]);
    const d = await checkPayer(pilot, amy, {amount: 6_000_000, payee: bob});
    assert.deepEqual(d.payer_side.reasons, ['Over its limit per deal: 6000000 nanoERG (0.006 tERG) is more than the 5000000 nanoERG (0.005 tERG) a deal its owner allows.']);
    // Fix inbox #87's shape on the testnet: bob's owner requires full coverage, amy holds nothing: bob's own check gives
    // the step's verdict, decline, though amy's own side allows it.
    pilot.setMandate(bob, {min_payer_coverage_pct: 100});
    const own = await checkPayer(pilot, amy, {amount: 2_000_000, payee: bob, showCover: true});
    assert.deepEqual([own.verdict, own.rule, own.payer_side.verdict, own.payee_side.verdict, own.payee_side.rule], ['decline', 'min_payer_coverage_pct', 'accept', 'decline', 'min_payer_coverage_pct']);
    assert.deepEqual(own.reasons, ['Your side refuses it (min_payer_coverage_pct); its side allows it.', 'Within its budget: up to 5000000 nanoERG (0.005 tERG) a deal, 31000000 nanoERG (0.031 tERG) of 40000000 nanoERG (0.04 tERG) left.']);
    assert.match(own.payee_side.reasons[0], /^Your own limits refuse it \(min_payer_coverage_pct\): amy-payer's claims on the tracker \(0 nanoERG \(0 tERG\)\) cover 0% of what it would owe with this deal \(11000000 nanoERG \(0\.011 tERG\)\)/);
    // The page says it as people read it, in tERG; the card (JSON) and the check keep nanoERG.
    const view = agents.agentView({id: amy.id, handle: amy.handle, joined_at: amy.created_at, agent_last_seen: null}, null, [], {now, card});
    assert.equal(view.budget.line, 'Can commit up to 0.005 tERG a deal and 0.04 tERG in all for its owner · 0.031 tERG left');
    const description = agents.agentDescription(view);
    assert.ok(description.length <= 300 && description.endsWith('Budget card: can commit up to 0.005 tERG a deal and 0.04 tERG in all for its owner; 0.031 tERG left.'), description);
    for (const text of [JSON.stringify(card), JSON.stringify(c), JSON.stringify(d), JSON.stringify(own), agents.renderAgentPage(view)]) assert.doesNotMatch(text, /\bPC\b|_PC"/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
