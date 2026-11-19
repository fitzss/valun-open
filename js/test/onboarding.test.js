// What a tester meets first (0.7.2: fix inbox #15 and #30, the onboarding review), as the Python core's
// test_onboarding.py checks it: a profile of the pilot network, retired on 2026-11-13, gets network_retired from the
// agent, with how to join again, when its server now serves another network; a profile that has not joined yet gets
// the testnet's words (valunTools, the argument refusals). Offline: a fake fetch.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  Client, DEFAULT_REJOIN_HINT, MemoryStore, NETWORK, PILOT_RETIRED_ON, RETIRED_CODES, TOUR_COMPLETED, TOUR_DONE_KEY,
  UNBOUND_MESSAGE, UNKNOWN_PARTICIPANT_TEXT, ValunAgent, ValunError, errorPayload, owes, profileNetwork, retiredPilot,
  retiredText, schemas, valunTools,
} from '../src/index.js';
import {scenario, world} from './agent-world.js';
import {fakeFetch} from './helpers.js';

const BASE = 'https://valun.invalid';
const PILOT_ID = 'vp_d77a7c3b6b23';
const TESTNET_INFO = {network: 'valun-testnet-1', protocol: 'valun-deal/1', unit: 'nanoERG',
  tracker_nft_id: 'dd'.repeat(32), denomination: 'erg'};
const PILOT_INFO = {network: 'valun-pilot-1', protocol: 'valun-deal/1', unit: 'PC', tracker_nft_id: '11'.repeat(32),
  denomination: 'x'};
const UNKNOWN_AGENT = {status: 401, body: {error: 'unauthorized', message: 'agent token required'}};
const OFFER = {counterparty: 'sandbox-exact', role: 'payer', title: 't', description: 'd', deliverable: 'x', price: 3};

/** An agent over a profile with `state`, against a server whose GET /info is `info` (null: it cannot be read). */
function agent(state, info = TESTNET_INFO, options = {}) {
  const fetch = fakeFetch(k => {
    if (k === 'GET /pilot/v1/info') return info === null ? {status: 503, body: {error: 'unavailable'}} : {body: info};
    return UNKNOWN_AGENT;                                   // a server that does not know this agent
  }, BASE);
  const store = new MemoryStore({state: {...state}, secret: '11'.repeat(32), token: 'vpa_PILOT-test-only'});
  const a = new ValunAgent(new Client({store, server: BASE, fetch}), options);
  return {agent: a, fetch};
}

test('profileNetwork and retiredPilot: the network a profile is on, and a profile of the retired pilot', () => {
  assert.equal(profileNetwork({}), 'valun-testnet-1');
  assert.equal(profileNetwork(null), 'valun-testnet-1');
  assert.equal(profileNetwork({participant_id: PILOT_ID}), NETWORK, 'enrolled before 0.5: the pilot');
  assert.equal(profileNetwork({participant_id: PILOT_ID, network: 'valun-testnet-1'}), 'valun-testnet-1');
  assert.equal(profileNetwork({network: 'valun-pilot-1'}), 'valun-pilot-1');
  assert.equal(new Client({store: new MemoryStore()}).network, 'valun-pilot-1', 'what a profile signs for: as before');
  assert.equal(retiredPilot({participant_id: PILOT_ID}, 'valun-testnet-1'), true);
  assert.equal(retiredPilot({participant_id: PILOT_ID}, 'valun-pilot-1'), false);
  assert.equal(retiredPilot({participant_id: PILOT_ID}, undefined), false);
  assert.equal(retiredPilot({}, 'valun-testnet-1'), false, 'not joined: nothing is retired');
  assert.equal(PILOT_RETIRED_ON, '2026-11-13');
  assert.deepEqual([...RETIRED_CODES], ['unauthorized', 'not_connected', 'tracker_mismatch', 'wrong_network',
    'wrong_tracker']);
});

test('a profile of the retired pilot gets network_retired, with the command that joins again', async () => {
  for (const state of [{participant_id: PILOT_ID}, {participant_id: PILOT_ID, network: 'valun-pilot-1'}]) {
    const {agent: a} = agent(state);
    const r = await a.callSafe('valun_status', {});
    assert.equal(r.error, 'network_retired');
    assert.equal(r.message, 'this profile is on the pilot network (valun-pilot-1), retired on 2026-11-13; the server '
      + 'now serves valun-testnet-1; nothing was signed');
    assert.equal(r.what_this_means, retiredText('valun-testnet-1'));
    assert.match(r.what_this_means,
      /^This agent's profile joined the pilot network \(valun-pilot-1\), which was retired on 2026-11-13: /);
    assert.ok(r.what_this_means.endsWith(`Its owner must use a profile on valun-testnet-1: ${DEFAULT_REJOIN_HINT}.`));
  }
  const {agent: b} = agent({participant_id: PILOT_ID}, TESTNET_INFO, {rejoinHint: 'run `my-host rejoin`'});
  assert.ok((await b.callSafe('valun_inbox', {})).what_this_means.endsWith('valun-testnet-1: run `my-host rejoin`.'));
});

test('the approval path answers network_retired, and the owner is never asked', async () => {
  const {agent: a} = agent({participant_id: PILOT_ID});
  const [prepared, refusal] = await a.prepareOrRefusal('valun_propose', OFFER);
  assert.equal(prepared, null);
  assert.equal(refusal.error, 'network_retired');
  let asked = 0;
  const tools = valunTools(a, {approve: async () => { asked++; return true; }});
  const r = await tools.find(t => t.name === 'valun_propose').execute(OFFER);
  assert.equal(r.error, 'network_retired');
  assert.equal(asked, 0, 'nobody was asked');
});

test('the refusal stands for any other profile, and where the server runs the pilot or cannot be read', async () => {
  for (const [state, info] of [[{participant_id: PILOT_ID, network: 'valun-testnet-1'}, TESTNET_INFO],
    [{participant_id: PILOT_ID}, PILOT_INFO], [{participant_id: PILOT_ID}, null]]) {
    const {agent: a, fetch} = agent(state, info);
    const r = await a.callSafe('valun_status', {});
    assert.equal(r.error, 'unauthorized', JSON.stringify(state));
    assert.match(r.what_this_means, /^This agent is not connected to Valun\./);
    if (state.network === 'valun-testnet-1') {
      assert.ok(!fetch.calls.some(c => c.key === 'GET /pilot/v1/info'), 'a testnet profile reads no /info for it');
    }
  }
  const {agent: a} = agent({participant_id: PILOT_ID});
  assert.equal(await a.retired(new ValunError('bad_arguments', 'x')), null);
  assert.equal(await a.retired(new Error('x')), null);
});

test('before a join: valunTools in the testnet\'s words, and argument refusals in nanoERG', async () => {
  const {agent: a, fetch} = agent({});
  const tools = valunTools(a, {approvals: 'none'});
  assert.deepEqual(tools.map(t => t.description), schemas.forNetwork(schemas.TESTNET).map(t => t.description));
  assert.doesNotMatch(JSON.stringify(tools.map(t => [t.description, t.parameters])), /\bPC\b|pilot/);
  const r = await a.callSafe('valun_propose', {...OFFER, price: '3'});
  assert.equal(r.message, 'price must be a whole number of nanoERG, at least 1 (a JSON integer), not "3"; nothing '
    + 'was signed');
  assert.equal(fetch.calls.length, 0, 'nothing was read');
  const {agent: pilot} = agent({participant_id: PILOT_ID});
  assert.deepEqual(valunTools(pilot, {approvals: 'none'}).map(t => t.description), schemas.ALL.map(t => t.description),
    'a profile of the pilot: its own words, as before');
});

const EXACT = {id: 'vp_' + 'e'.repeat(12), handle: 'sandbox-exact', status: 'active', pubkey: '03' + 'cd'.repeat(32)};
const RETIRED = 'this profile is on the pilot network (valun-pilot-1), retired on 2026-11-13; the server now serves '
  + 'valun-testnet-1; nothing was signed';
/** A server of the testnet whose public reads answer (its directory, a participant) and which knows no agent token. */
const testnetServer = () => fakeFetch(k => {
  if (k === 'GET /pilot/v1/info') return {body: TESTNET_INFO};
  if (k === 'GET /pilot/v1/participants') return {body: [EXACT]};
  if (k === `GET /pilot/v1/participants/${EXACT.id}`) return {body: EXACT};
  return UNKNOWN_AGENT;
}, BASE);
const sent = fetch => fetch.calls.filter(c => !c.key.startsWith('GET ')).map(c => c.key);

test('a profile of the pilot without pins signs nothing on a server of another network, and pins nothing', async () => {
  // `config server URL` removes a profile's pins, which 0.7.1's doctor advised; a profile unused since before pins has
  // none either. Its client refuses before anything is signed (wrong_network), so network_retired's "nothing was
  // signed" is true; with an approve hook its owner is not even asked (the onboarding review).
  for (const state of [{participant_id: PILOT_ID}, {participant_id: PILOT_ID, network: 'valun-pilot-1'}]) {
    for (const how of ['callSafe', 'none', 'approve']) {
      const fetch = testnetServer();
      const store = new MemoryStore({state: {...state}, secret: '11'.repeat(32), token: 'vpa_PILOT-test-only'});
      const a = new ValunAgent(new Client({store, server: BASE, fetch}));
      let asked = 0;
      const r = how === 'callSafe' ? await a.callSafe('valun_propose', OFFER)
        : await valunTools(a, how === 'none' ? {approvals: 'none'} : {approve: async () => { asked++; return true; }})
          .find(t => t.name === 'valun_propose').execute(OFFER);
      assert.deepEqual([r.error, r.message], ['network_retired', RETIRED], `${how} ${JSON.stringify(state)}`);
      assert.equal(asked, 0, 'nobody was asked');
      assert.deepEqual(sent(fetch), [], 'nothing was sent');
      assert.equal('pins' in store.state, false, "the testnet's tracker is not pinned");
    }
  }
});

test('the client pins and signs nothing for a server of another network (wrong_network)', async () => {
  const OTHER = 'vp_' + 'f'.repeat(12), CREDITOR = 'vp_' + 'a'.repeat(12);
  const info = {...TESTNET_INFO, features: ['guarantees/1']};
  const people = {[OTHER]: '03' + 'cd'.repeat(32), [CREDITOR]: '03' + 'ab'.repeat(32)};
  const routes = k => {
    if (k === 'GET /pilot/v1/info') return {body: info};
    const id = k.startsWith('GET /pilot/v1/participants/') ? k.slice('GET /pilot/v1/participants/'.length) : null;
    return Object.hasOwn(people, id ?? '') ? {body: {id, pubkey: people[id], status: 'active'}} : undefined;
  };
  const client = state => {
    const fetch = fakeFetch(routes, BASE);
    const store = new MemoryStore({state, secret: '11'.repeat(32), token: 'vpa_test-only'});
    return {c: new Client({store, server: BASE, fetch}), store, fetch};
  };
  const offer = {counterpartyId: OTHER, role: 'payer', title: 'S', description: 'd', deliverable: 'x', price: 2};
  const backing = {issuerId: OTHER, creditorId: CREDITOR, cap: 2, dueInHours: 1};
  const terms = c => [() => c.buildTerms(offer), () => c.buildGuaranteeTerms(backing)];
  for (const state of [{participant_id: PILOT_ID}, {participant_id: PILOT_ID, network: 'valun-pilot-1'}]) {
    const {c, store, fetch} = client(state);
    for (const fn of [() => c.info(), ...terms(c)]) {
      await assert.rejects(fn(), e => e.code === 'wrong_network'
        && e.message === 'the server is on network "valun-testnet-1", not valun-pilot-1; nothing was signed');
    }
    assert.equal('pins' in store.state, false, "never the testnet's tracker in a pilot profile");
    assert.deepEqual([...new Set(fetch.calls.map(x => x.key))], ['GET /pilot/v1/info'], 'refused at the first read');
  }
  // its own network: pinned as before; a profile that has not joined: neither refused nor pinned
  const own = client({participant_id: PILOT_ID, network: 'valun-testnet-1'});
  await own.c.info();
  assert.deepEqual(own.store.state.pins, {tracker_nft_id: 'dd'.repeat(32), denomination: 'erg'});
  const fresh = client({});
  assert.deepEqual(await fresh.c.info(), info);
  assert.equal('pins' in fresh.store.state, false);
  // pinned to the tracker that server names, but it names another network: no terms for it either
  const pinned = client({participant_id: PILOT_ID, pins: {tracker_nft_id: 'dd'.repeat(32), denomination: 'erg'}});
  for (const fn of terms(pinned.c)) await assert.rejects(fn(), e => e.code === 'wrong_network');
  // and GET /info itself refuses it, before its pins are checked (the 0.7.2 review)
  await assert.rejects(pinned.c.info(), e => e.code === 'wrong_network');
});

test('a pilot profile that 0.7.1 pinned to the testnet\'s tracker gets network_retired, and its owner is not asked', async () => {
  // valun 0.7.1 pinned an unpinned pilot profile to whatever server it read, the testnet's tracker included (the 0.7.2
  // review): the network is checked before the pins, so no approval is asked for terms that cannot be signed.
  const fetch = testnetServer();
  const store = new MemoryStore({state: {participant_id: PILOT_ID, pins: {tracker_nft_id: 'dd'.repeat(32), denomination: 'erg'}},
    secret: '11'.repeat(32), token: 'vpa_PILOT-test-only'});
  const a = new ValunAgent(new Client({store, server: BASE, fetch}));
  let asked = 0;
  const r = await valunTools(a, {approve: async () => { asked++; return true; }}).find(t => t.name === 'valun_propose').execute(OFFER);
  assert.deepEqual([r.error, r.message], ['network_retired', RETIRED]);
  assert.equal(asked, 0, 'nobody was asked');
  assert.deepEqual(sent(fetch), [], 'nothing was sent');
});

test('valunTools without an approve hook: before a join, a commitment gets the join hint', async () => {
  // approval_unavailable is for an app that cannot ask; before a join, its owner must join first, as valun_status says
  // (the onboarding review).
  const fetch = fakeFetch(() => undefined, BASE);
  const a = new ValunAgent(new Client({store: new MemoryStore({state: {server: BASE}}), server: BASE, fetch}),
    {setupHint: 'run `valun --profile fresh join` in a terminal'});
  const tools = valunTools(a);
  const status = await tools.find(t => t.name === 'valun_status').execute({});
  assert.deepEqual([status.error, status.what_this_means], ['not_connected',
    'This agent is not connected to Valun. Its owner must run `valun --profile fresh join` in a terminal.']);
  assert.deepEqual(await tools.find(t => t.name === 'valun_propose').execute(OFFER), status);
  assert.equal(fetch.calls.length, 0, 'nothing was read');
});

// ---------- the 0.7.2 clean-user test (both clients; the Python core's tests of the same names) ----------
test('the end of the sandbox tour is kept: a note earned after it is not step 3 again', async () => {
  // After the tour, `valun sandbox earn` left a note of sandbox-exact held, and the next steps, read from what is held
  // and owed with the sandbox agents, said step 3 again. Once valun_status has seen the end, the profile keeps it.
  const done = scenario('status: sandbox tour, complete');
  const after = scenario('status: sandbox tour, complete before, then a note earned from sandbox-exact: still complete');
  const earned = {...after.routes, 'GET /pilot/v1/inbox': {body: {...after.routes['GET /pilot/v1/inbox'].body, respond: []}}};
  const before = world({routes: earned, state: done.state});
  const reopened = (await before.agent.callSafe('valun_status', {})).sandbox_next_steps;
  assert.deepEqual([reopened.tour_step, reopened.next_calls[0].why], [3, 'buy notary from sandbox-exact for 2 PC'],
    'without the end kept: step 3 again, as 0.7.1 said');
  let routes = done.routes;
  const w = world({routes: key => routes[key], state: done.state});
  assert.equal((await w.agent.callSafe('valun_status', {})).sandbox_next_steps.tour_step, 'done');
  assert.equal(w.store.state[TOUR_DONE_KEY], w.client.participantId, 'the end is kept in the profile');
  routes = earned;                                  // then `valun sandbox earn`
  for (const brief of [false, true]) {
    const n = (await w.agent.callSafe('valun_status', {brief})).sandbox_next_steps;
    assert.deepEqual([n.tour_step, n.next_calls, n.then, 'retry_after_seconds' in n], ['done', [], TOUR_COMPLETED, false], `brief ${brief}`);
  }
});

test('a commitment to a handle the network does not have says so, and points to valun_directory', async () => {
  // valun_propose to house-scribe on a server without it told the agent to read the deal again with valun_deal.
  const offer = {counterparty: 'house-scribe', role: 'payer', title: 'summary', description: 'd', deliverable: 'x', price: 3};
  const [prepared, refusal] = await world({}).agent.prepareOrRefusal('valun_propose', offer);
  assert.equal(prepared, null);
  assert.deepEqual(refusal, {error: 'approval_unbound', message: UNBOUND_MESSAGE, cause: 'unknown_participant',
    what_this_means: UNKNOWN_PARTICIPANT_TEXT});
  assert.equal(UNKNOWN_PARTICIPANT_TEXT, 'Nothing was signed and your owner was not asked: no participant with that '
    + 'handle exists on this network. Find the one you mean with valun_directory, and use the handle it lists.');
  const other = errorPayload(new ValunError('approval_unbound', UNBOUND_MESSAGE, undefined, {cause: 'stale_terms'}));
  assert.match(other.what_this_means, /Read the deal again with valun_deal and retry/, 'another cause keeps its advice');
});

test('with circulating credit a payer is promised no credit note before it accepts the delivery', async () => {
  // The tour's step 2 offer said "(your credit note)" for a deal the tour then paid with a note held.
  assert.equal(owes('payer', 'sandbox-mallory', 2000000, 'nanoERG', true), 'after you accept their delivery you will pay '
    + 'sandbox-mallory 2000000 nanoERG (0.002 tERG): with your credit note, or with notes you hold if you choose to.');
  assert.equal(owes('payer', 'sandbox-mallory', 2000000, 'nanoERG'), 'after you accept their delivery you will owe '
    + 'sandbox-mallory 2000000 nanoERG (0.002 tERG) (your credit note).', 'without circulating credit: as before');
  assert.equal(owes('payee', 'bob', 3, 'PC', true), 'you must deliver; bob would then owe you 3 PC (their credit note).');
  for (const name of ['respond: accept as the payer on a circulation server (0.7.2)',
    'respond: counter as the payer on a circulation server (0.7.2)', 'propose: a due consent run signs a set-off first']) {
    const sc = scenario(name);
    const {text} = await world(sc).agent.prepare(sc.tool, sc.args);
    assert.ok(text.includes('with your credit note, or with notes you hold if you choose to.') && !text.includes('(your credit note)'), name);
  }
});
