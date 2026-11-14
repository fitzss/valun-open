// Budget cards, the JavaScript twin of python/tests/test_budget_card.py, against a fake fetch (offline): an owner may
// publish its agent's budget card, anyone can read it (Client.card) and check a payment against it (Client.checkPayer,
// the read-only tool valun_check_payer), the owner publishes or hides it with its owner token (Client.setPublicCard), and
// valun_status shows the agent's room. Also fix inbox #58: a tool called without a required argument answers
// bad_arguments with a plain message, not internal_error. The same over a recorded server, value for value with Python:
// the 'check_payer:', 'card:', 'set_public_card:' and #58 scenarios of agent-parity.test.js.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  CHECK_FALLBACK, CHECK_LEAD, Client, MemoryStore, NETWORK, READ_ONLY_TOOLS, SIGNING_TOOLS, ValunAgent, ValunError, checkSummary, schemas,
  valunTools,
} from '../src/index.js';
import {fakeFetch} from './helpers.js';

const BASE = 'http://valun.invalid';
const ME = 'vp_a1a1a1a1a1a1', BOB = 'vp_b0b0b0b0b0b0', ERIN = 'vp_e0e0e0e0e0e0', HIDDEN = 'vp_0f0f0f0f0f0f';
const AGENT_TOKEN = 'vpa_test-agent', OWNER_TOKEN = 'vpo_test-owner-of-alice', BOBS_OWNER_TOKEN = 'vpo_test-owner-of-bob';
const PEOPLE = [{id: ME, handle: 'alice', status: 'active'}, {id: BOB, handle: 'bob', status: 'active'}, {id: ERIN, handle: 'erin', status: 'active'}];
const CARD = {card: 1, network: NETWORK, unit: 'PC', agent: {id: BOB, handle: 'bob', display_name: 'Bob', operator: 'Bob Example'},
  mandate: {version: 4, expires_at: '2026-12-01T00:00:00.000Z', may_issue_credit: true, per_deal: 30, outstanding_cap: 40, approve_above: 25,
    counterparties: 'any', objective: 'Write briefs.'},
  room: {outstanding: 9, room_left: 31, as_of: '2026-11-06T12:00:00.000Z'}, backing: {active: 1, total_cap: 5, remaining: 3, public: []},
  record: {completed: 3, disputed: 1, holds: 40, owes: 9, cleared: 2}, card_hash: 'c4'.repeat(32),
  check: `${BASE}/pilot/v1/participants/${BOB}/check`, page: `${BASE}/agent/bob`};
const MANDATE = {max_issue_per_deal: 30, max_issue_outstanding: 100, max_accept_per_deal: 50, max_accept_per_issuer: 200, min_price_as_payee: 5,
  min_payer_coverage_pct: 0, approve_above: 25, objective: 'Buy briefs.'};
const ME_VIEW = {participant: {id: ME, handle: 'alice', status: 'active'}, mandate: MANDATE, mandate_version: 3,
  position: {claims_held: 0, owes: 9, net: -9}, authority: {}};
const INFO = {network: NETWORK, protocol: 'valun-deal/1', unit: 'PC'};
const SUMMARY_ACCEPT = 'Accept: within its budget (31 of 40 left), backed for you up to 3.';
const SUMMARY_ASK = 'Ask owner: within its budget (13 of 40 left), its owner approves each IOU above 25.';
const SUMMARY_DECLINE = 'Decline: above its limit per deal (30), more than the room it has left (31).';
const SUMMARY_NOT_PUBLIC = "Unknown: bob's owner has not published a budget card, so its budget cannot be checked; decide from its "
  + 'record (valun_directory) or ask your owner.';
const MISSING_DEAL = 'missing argument: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it)';

function verdict(v = 'accept', reasons = ['within its budget (31 of 40 left)', 'backed for you up to 3'], extra = {}) {
  return {verdict: v, reasons, rule: null, payer: {id: BOB, handle: 'bob'}, payee: {id: ME, handle: null}, amount: 18,
    mandate: {version: 4, expires_at: '2026-12-01T00:00:00.000Z'}, room_left: 31, approval_needed: false,
    cover: {covered: true, guarantees: [{guarantee_id: 'vg_' + '3c'.repeat(8), backer: {id: ERIN, handle: 'erin'}, remaining: 3}]},
    record: {completed: 3, disputed: 1}, card_hash: 'c4'.repeat(32), checked_at: '2026-11-06T12:00:00.000Z', took_ms: 7, ...extra};
}

/** A fake server as in the Python test: the directory, cards and checks (public), /me and /info, the owner routes. */
function world() {
  const w = {routes: {}, cardPublic: {[BOB]: true, [HIDDEN]: true, [ME]: false}, me: structuredClone(ME_VIEW), putAnswer: null};
  w.fetch = fakeFetch((key, init) => {
    const token = (init.headers?.Authorization ?? '').replace(/^Bearer /, '') || null;
    if (Object.hasOwn(w.routes, key)) return w.routes[key];
    if (key === 'GET /pilot/v1/participants') return {body: PEOPLE};
    if (key === 'GET /pilot/v1/info') return {body: INFO};
    if (key === 'GET /pilot/v1/me') return token === AGENT_TOKEN ? {body: w.me} : {status: 401, body: {error: 'unauthorized'}};
    if (key.includes(' /pilot/v1/owner')) {
      const who = {[OWNER_TOKEN]: ME, [BOBS_OWNER_TOKEN]: BOB}[token];
      if (!who) return {status: 404, body: {error: 'not_found', message: 'not found'}};
      if (key === 'GET /pilot/v1/owner') return {body: {participant: {id: who}, mandate: MANDATE}};
      if (key === 'PUT /pilot/v1/owner/mandate') {
        if (w.putAnswer) return {body: w.putAnswer};
        const on = JSON.parse(init.body).public_card;
        w.cardPublic[who] = on;
        return {body: {mandate: {...MANDATE, public_card: on}, mandate_version: 4, changed_by: 'owner', changed: true}};
      }
    }
    const m = /^GET \/pilot\/v1\/participants\/([^/?]+)\/(card|check)(\?.*)?$/.exec(key);
    if (m) {
      if (!Object.hasOwn(w.cardPublic, m[1])) return {status: 404, body: {error: 'not_found', message: `unknown participant ${m[1]}`}};
      if (!w.cardPublic[m[1]]) return {status: 404, body: {error: 'card_not_public', message: "this participant's owner has not published its budget card"}};
      return {body: m[2] === 'card' ? CARD : verdict()};
    }
    return undefined;
  }, BASE);
  w.client = (joined = true) => new Client({server: BASE, fetch: w.fetch, store: joined
    ? new MemoryStore({state: {server: BASE, participant_id: ME, pubkey: '02' + '11'.repeat(32)}, secret: '11'.repeat(32), token: AGENT_TOKEN})
    : new MemoryStore({state: {server: BASE}})});
  w.agent = (joined = true) => new ValunAgent(w.client(joined));
  w.calls = () => w.fetch.calls.map(c => [c.init.method || 'GET', c.key.slice(c.key.indexOf(' ') + 1), c.headers.Authorization ?? null]);
  return w;
}

const rejects = (p, code) => assert.rejects(p, e => e instanceof ValunError && e.code === code);

// ---------- the client ----------
test('card(): by handle, the directory then the card, both without a token; by id, no directory (an unlisted participant too)', async () => {
  const w = world();
  assert.deepEqual(await w.client().card('  Bob '), CARD);
  assert.deepEqual(w.calls(), [['GET', '/pilot/v1/participants', null], ['GET', `/pilot/v1/participants/${BOB}/card`, null]]);
  const v = world();
  assert.deepEqual(await v.client(false).card(HIDDEN.toUpperCase()), CARD);
  assert.deepEqual(v.calls(), [['GET', `/pilot/v1/participants/${HIDDEN}/card`, null]]);
});

test('card(): not public, a server from before budget cards, and names that are not one', async () => {
  const w = world();
  await assert.rejects(w.client().card(ME), e => e.code === 'card_not_public' && e.status === 404);
  w.routes[`GET /pilot/v1/participants/${BOB}/card`] = {status: 401, body: {error: 'unauthorized', message: 'missing or invalid token'}};
  await assert.rejects(w.client().card(BOB), e => e.code === 'feature_unavailable' && /offers no budget cards/.test(e.message));
  await rejects(w.client().card('nobody'), 'unknown_participant');
  for (const who of ['', '  ', null, 7]) await rejects(w.client().card(who), 'bad_arguments');
});

test('checkPayer(): this participant is the payee by default; an explicit payee by handle; public GETs only', async () => {
  const w = world();
  assert.deepEqual(await w.client().checkPayer('bob', 18), verdict());
  assert.deepEqual(w.calls().at(-1), ['GET', `/pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`, null]);
  await w.client().checkPayer(BOB, 5, {payee: 'erin'});
  assert.deepEqual(w.calls().at(-1), ['GET', `/pilot/v1/participants/${BOB}/check?amount=5&payee=${ERIN}`, null]);
  assert.ok(w.calls().every(([m, , auth]) => m === 'GET' && auth === null));
});

test('checkPayer(): an amount that is not a whole number, or no payee for an unjoined client, is refused before any read', async () => {
  const w = world();
  for (const amount of [0, -1, 1.5, '18', true, null, 2 ** 53]) {
    await assert.rejects(w.client().checkPayer('bob', amount),
      e => e.code === 'bad_arguments' && e.message === 'amount must be a whole number of PC, at least 1; nothing was read', String(amount));
  }
  await assert.rejects(w.client(false).checkPayer('bob', 18), e => e.code === 'bad_arguments' && /give payee/.test(e.message));
  assert.deepEqual(w.fetch.calls, []);
  assert.deepEqual(await w.client(false).checkPayer(BOB, 18, {payee: ERIN}), verdict());
});

test('setPublicCard(): checks the owner token (GET /owner), then PUTs public_card with it; the token is never stored', async () => {
  const w = world();
  const c = w.client();
  const r = await c.setPublicCard(true, ` ${OWNER_TOKEN}\n`);
  assert.deepEqual([r.mandate.public_card, r.changed], [true, true]);
  assert.deepEqual(w.calls(), [['GET', '/pilot/v1/owner', `Bearer ${OWNER_TOKEN}`], ['PUT', '/pilot/v1/owner/mandate', `Bearer ${OWNER_TOKEN}`]]);
  assert.deepEqual(w.fetch.calls[1].body, {public_card: true});
  assert.equal(w.cardPublic[ME], true);
  assert.ok(!JSON.stringify(c.state).includes(OWNER_TOKEN));
  await c.setPublicCard(false, OWNER_TOKEN);
  assert.equal(w.cardPublic[ME], false);
});

test("setPublicCard(): another participant's owner token, the agent's token, or bad arguments change nothing", async () => {
  const w = world();
  for (const token of [BOBS_OWNER_TOKEN, AGENT_TOKEN]) await rejects(w.client().setPublicCard(true, token), 'not_owner');
  for (const [on, token, code] of [[1, OWNER_TOKEN, 'invalid_field'], ['yes', OWNER_TOKEN, 'invalid_field'], [true, ' ', 'bad_arguments'],
    [true, null, 'bad_arguments']]) {
    await rejects(w.client().setPublicCard(on, token), code);
  }
  assert.ok(!w.calls().some(([m]) => m === 'PUT'));
  assert.deepEqual(w.cardPublic, {[BOB]: true, [HIDDEN]: true, [ME]: false});
});

// ---------- the tool ----------
test('valun_check_payer: the summary for accept, ask_owner, decline and not public', async () => {
  const w = world();
  const check = args => w.agent().callSafe('valun_check_payer', args);
  const route = amount => `GET /pilot/v1/participants/${BOB}/check?amount=${amount}&payee=${ME}`;
  assert.equal((await check({payer: 'bob', amount: 18})).summary, SUMMARY_ACCEPT);
  w.routes[route(30)] = {body: verdict('ask_owner', ['within its budget (13 of 40 left)', 'its owner approves each IOU above 25'],
    {amount: 30, rule: 'approve_above', approval_needed: true})};
  assert.equal((await check({payer: 'bob', amount: 30})).summary, SUMMARY_ASK);
  w.routes[route(45)] = {body: verdict('decline', ['above its limit per deal (30)', 'more than the room it has left (31)'],
    {amount: 45, rule: 'max_issue_per_deal'})};
  assert.equal((await check({payer: 'bob', amount: 45})).summary, SUMMARY_DECLINE);
  w.cardPublic[BOB] = false;
  assert.deepEqual(await check({payer: 'bob', amount: 18}), {summary: SUMMARY_NOT_PUBLIC, verdict: 'unknown',
    reasons: ["the payer's owner has not published a budget card"], rule: null, payer: {id: BOB, handle: 'bob'}, amount: 18});
});

test('checkSummary(): without reasons, a verdict this client does not know, and reasons put on one line', () => {
  assert.equal(checkSummary({verdict: 'accept', reasons: []}), "Accept: its owner's budget card allows this IOU.");
  assert.equal(checkSummary({verdict: 'ask_owner'}), "Ask owner: an owner's approval is needed for an IOU this size.");
  assert.equal(checkSummary({verdict: 'decline', reasons: null}), "Decline: its owner's budget card does not allow this IOU.");
  assert.equal(checkSummary({verdict: 'maybe', reasons: ['unsure']}), 'Unknown: unsure.');
  assert.equal(checkSummary(null), 'Unknown: the server gave no verdict this client knows.');
  assert.equal(checkSummary({verdict: 'accept', reasons: [' within\nits budget.. ', 3, '', 'backed;']}), 'Accept: within its budget, backed.');
  assert.deepEqual(Object.keys(CHECK_LEAD), ['accept', 'ask_owner', 'decline']);
  assert.deepEqual(Object.keys(CHECK_FALLBACK), ['accept', 'ask_owner', 'decline']);
});

test("valun_check_payer: the server's verdict with the summary first (the server's own summary is replaced)", async () => {
  const w = world();
  w.routes[`GET /pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`] = {body: verdict('accept', undefined, {summary: 'Decline: not ours'})};
  const r = await w.agent().call('valun_check_payer', {payer: 'bob', amount: 18});
  assert.equal(Object.keys(r)[0], 'summary');
  assert.equal(r.summary, SUMMARY_ACCEPT);
  const {summary: _s, ...rest} = r;
  assert.deepEqual(rest, verdict());
});

test('valun_check_payer: a server without budget cards (401) is an answer too, naming the payer by id', async () => {
  const w = world();
  w.routes[`GET /pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`] = {status: 401, body: {error: 'unauthorized'}};
  const r = await w.agent().call('valun_check_payer', {payer: BOB, amount: 18});
  assert.deepEqual([r.verdict, r.reasons, r.payer], ['unknown', ['this Valun server offers no budget cards'], {id: BOB, handle: null}]);
  assert.match(r.summary, /offers no budget cards, so the budget of vp_b0b0b0b0b0b0 cannot be checked/);
});

test('valun_check_payer: read only, never asks the owner, runs where commitments cannot be approved', async () => {
  const w = world();
  const a = w.agent();
  assert.ok(READ_ONLY_TOOLS.includes('valun_check_payer') && !SIGNING_TOOLS.includes('valun_check_payer'));
  assert.equal(await a.isCommitment('valun_check_payer', {payer: 'bob', amount: 18}), false);
  assert.deepEqual(await a.prepare('valun_check_payer', {payer: 'bob', amount: 18}), {args: {payer: 'bob', amount: 18}, text: null});
  const tool = valunTools(a).find(t => t.name === 'valun_check_payer');          // no approve hook: commitments fail closed
  assert.equal((await tool.execute({payer: 'bob', amount: 18})).summary, SUMMARY_ACCEPT);
  assert.ok(w.calls().every(([m, , auth]) => m === 'GET' && auth === null), 'public reads, no token, nothing sent');
});

test('valun_check_payer: the amount is checked as valun_propose checks its price, before anything is read', async () => {
  const {description: _p, ...price} = schemas.PROPOSE.parameters.properties.price;
  const {description: _a, ...amount} = schemas.CHECK_PAYER.parameters.properties.amount;
  assert.deepEqual(amount, price);
  assert.deepEqual([...schemas.CHECK_PAYER.parameters.required], ['payer', 'amount']);
  const w = world();
  for (const [bad, shownAs] of [[1.5, '1.5'], ['18', '"18"'], [true, 'true'], [0, '0'], [-2, '-2'], [null, 'null']]) {
    assert.deepEqual(await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: bad}), {error: 'bad_arguments',
      message: `amount must be a whole number of PC, at least 1 (a JSON integer), not ${shownAs}; nothing was signed`}, String(bad));
  }
  assert.deepEqual(w.fetch.calls, []);
  assert.equal((await w.agent().callSafe('valun_check_payer', {payer: 5, amount: 18})).error, 'bad_arguments');
  assert.deepEqual(await w.agent().callSafe('valun_check_payer', {amount: 18}), {error: 'bad_arguments',
    message: 'missing argument: payer (the handle or participant id of the agent that would owe you)'});
});

test('valun_check_payer: its description tells a model to run it before accepting an IOU, in the words of each network', () => {
  assert.ok(schemas.CHECK_PAYER.description.startsWith('Run this before you accept an IOU (a credit note) from an agent you do not know'));
  const testnet = schemas.forNetwork(schemas.TESTNET).at(-1);
  assert.equal(testnet.name, 'valun_check_payer');
  assert.doesNotMatch(JSON.stringify(testnet), /\bPC\b|pilot/);
  assert.match(testnet.parameters.properties.amount.description, /in nanoERG of Ergo testnet/);
});

test('valun_check_payer: an unknown payer, an unknown id and an unjoined agent pass through as errors', async () => {
  const w = world();
  assert.equal((await w.agent().callSafe('valun_check_payer', {payer: 'nobody', amount: 18})).error, 'unknown_participant');
  assert.equal((await w.agent().callSafe('valun_check_payer', {payer: 'vp_0123456789ab', amount: 18})).error, 'not_found');
  assert.equal((await w.agent(false).callSafe('valun_check_payer', {payer: 'bob', amount: 18})).error, 'not_connected');
});

// ---------- valun_status ----------
test('valun_status shows the room GET /me shows, right after the position, in the full and brief views', async () => {
  const w = world();
  assert.ok(!('room' in await w.agent().call('valun_status', {})));
  w.me.room = {outstanding: 9, room_left: 91};
  const full = await w.agent().call('valun_status', {});
  assert.deepEqual(full.room, {outstanding: 9, room_left: 91});
  const keys = Object.keys(full);
  assert.equal(keys[keys.indexOf('position') + 1], 'room');
  assert.deepEqual((await w.agent().call('valun_status', {brief: true})).room, {outstanding: 9, room_left: 91});
  w.me.room = 'lots';
  assert.ok(!('room' in await w.agent().call('valun_status', {})));
});

// ---------- fix inbox #58 ----------
test('fix inbox #58: valun_respond without deal_id or action is bad_arguments with a plain message, not internal_error', async () => {
  const w = world();
  const a = w.agent();
  assert.deepEqual(await a.callSafe('valun_respond', {deal_id: 'vd_1111111111111111'}),
    {error: 'bad_arguments', message: 'missing argument: action (accept, decline, counter or withdraw); nothing was signed'});
  assert.equal((await a.callSafe('valun_respond', {action: 'accept'})).message, `${MISSING_DEAL}; nothing was signed`);
  assert.equal((await a.callSafe('valun_respond', {deal_id: null, action: null})).message,
    'missing arguments: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it), action (accept, decline, counter or withdraw); '
    + 'nothing was signed');
  assert.deepEqual(await a.callSafe('valun_respond', ['vd_1111111111111111', 'accept']),
    {error: 'bad_arguments', message: 'the arguments are not a JSON object; nothing was signed'});
  assert.deepEqual(w.fetch.calls, []);
});

test('fix inbox #58: the other tools that failed on a missing argument, refused before anything is read', async () => {
  const w = world();
  const a = w.agent();
  const brief = {counterparty: 'bob', role: 'payer', title: 'Brief', description: 'A brief.', deliverable: 'Markdown', price: 5};
  const {title: _t, ...noTitle} = brief;
  for (const [tool, args, missing] of [['valun_deal', {}, 'deal_id'], ['valun_deliver', {content: 'x'.repeat(300)}, 'deal_id'],
    ['valun_deliver', {exact_result: true}, 'deal_id'], ['valun_review_delivery', {decision: 'accept'}, 'deal_id'],
    ['valun_review_delivery', {decision: 'dispute', reason: 'Wrong.'}, 'deal_id'], ['valun_propose', noTitle, 'title'],
    ['valun_propose', {...brief, role: null}, 'role']]) {
    const r = await a.callSafe(tool, args);
    assert.equal(r.error, 'bad_arguments', `${tool} ${JSON.stringify(args)}`);
    assert.ok(r.message.startsWith(`missing argument: ${missing} (`), r.message);
  }
  const {price: _p, ...noPrice} = brief;
  assert.deepEqual(await a.callSafe('valun_propose', noPrice), {error: 'bad_arguments',
    message: 'price must be a whole number of PC, at least 1 (a JSON integer), not null; nothing was signed'});
  assert.deepEqual(w.fetch.calls, []);
  const [prepared, refusal] = await a.prepareOrRefusal('valun_propose', {...noTitle, title: undefined});
  assert.equal(prepared, null);
  assert.deepEqual([refusal.error, refusal.cause], ['approval_unbound', 'bad_arguments'], 'an offer missing a text is never put to the owner');
});
