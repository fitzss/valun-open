// Budget cards, the JavaScript twin of python/tests/test_budget_card.py, against a fake fetch (offline): an owner may
// publish its agent's budget card, anyone can read it (Client.card) and check a payment against it (Client.checkPayer,
// the read-only tool valun_check_payer), the owner publishes or hides it with its owner token (Client.setPublicCard), and
// valun_status shows the agent's room. Also fix inbox #58: a tool called without a required argument answers
// bad_arguments with a plain message, not internal_error; and fix inbox #60: the offer under review (deal_id). The same
// over a recorded server, value for value with Python: the 'check_payer:', 'card:', 'set_public_card:' and #58 scenarios
// of agent-parity.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  CHECK_ASK_FALLBACK, CHECK_ASK_LEAD, CHECK_FALLBACK, CHECK_LEAD, CHECK_PAYEE_SIDE, Client, MemoryStore, NETWORK, READ_ONLY_TOOLS,
  SIGNING_TOOLS, ValunAgent, ValunError, checkOwners, checkSummary, offersCountedAt, schemas, valunTools,
} from '../src/index.js';
import {fakeFetch} from './helpers.js';

// Fix inbox #87: answers of the server's own code to the payee's own check, recorded with what valun 0.7.2 makes of them,
// shared with the Python client (python/tests/test_budget_card.py BothSides).
const SIDES_FILE = fileURLToPath(new URL('../../python/tests/fixtures/check-sides.json', import.meta.url));
const SIDES = fs.existsSync(SIDES_FILE) ? JSON.parse(fs.readFileSync(SIDES_FILE, 'utf8')) : null;
const NO_SIDES = SIDES === null && 'python/tests/fixtures is not next to js/ (published package)';

const BASE = 'https://valun.invalid';
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
const SUMMARY_ASK = 'Ask the payer\'s owner: within its budget (13 of 40 left), its owner approves each IOU above 25.';
const SUMMARY_DECLINE = 'Decline: above its limit per deal (30), more than the room it has left (31).';
const SUMMARY_NOT_PUBLIC = "Unknown: bob's owner has not published a budget card, so its budget cannot be checked; decide from its "
  + 'record (valun_directory) or ask your owner.';
const MISSING_DEAL = 'missing argument: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it)';

// The cover the server shows the payee itself (a request with its own token), and what anyone else sees: null, not 0.
const COVER = {covered: 3, guarantees: [{guarantee_id: 'vg_' + '3c'.repeat(8), backer: {id: ERIN, handle: 'erin'}, remaining: 3}]};
const NO_COVER_SHOWN = {covered: null, guarantees: []};

function verdict(v = 'accept', reasons = ['within its budget (31 of 40 left)'], extra = {}) {
  return {verdict: v, reasons, rule: null, payer: {id: BOB, handle: 'bob'}, payee: {id: ME, handle: null}, amount: 18,
    mandate: {version: 4, expires_at: '2026-12-01T00:00:00.000Z'}, room_left: 31, approval_needed: false, cover: structuredClone(COVER),
    record: {completed: 3, disputed: 1}, card_hash: 'c4'.repeat(32), checked_at: '2026-11-06T12:00:00.000Z', took_ms: 7, ...extra};
}

/**
 * A fake server as in the Python test: the directory, cards and checks (public; a check shows the cover only to a request
 * with the payee's own token), /me and /info, the owner routes.
 */
function world() {
  // ignoresDeal: a server from before fix inbox #60 (deal= ignored); extra: more fields of a check without deal=
  const w = {routes: {}, cardPublic: {[BOB]: true, [HIDDEN]: true, [ME]: false}, me: structuredClone(ME_VIEW), putAnswer: null,
    ignoresDeal: false, extra: {}};
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
      if (m[2] === 'card') return {body: CARD};
      const query = new URLSearchParams(m[3].slice(1)), payee = query.get('payee');
      const own = token === AGENT_TOKEN && payee === ME;           // the payee's own token: only it sees its cover
      if (query.has('deal') && !w.ignoresDeal) {                   // fix inbox #60: the offer under review, the payee's only
        if (!own) return {status: 403, body: {error: 'not_payee', message: "deal= is answered only to the payee: send the check with the payee's agent or owner token"}};
        return {body: verdict('accept', undefined, {payee: {id: payee, handle: null}, deal_id: query.get('deal')})};
      }
      return {body: verdict('accept', undefined, {payee: {id: payee, handle: null}, cover: own ? structuredClone(COVER) : NO_COVER_SHOWN, ...w.extra})};
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

test("checkPayer(): this participant is the payee by default, asked with its own token (its cover shown); another payee's is not", async () => {
  const w = world();
  assert.deepEqual(await w.client().checkPayer('bob', 18), verdict());
  assert.deepEqual(w.calls().at(-1), ['GET', `/pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`, `Bearer ${AGENT_TOKEN}`]);
  const r = await w.client().checkPayer(BOB, 5, {payee: 'erin'});
  assert.deepEqual(w.calls().at(-1), ['GET', `/pilot/v1/participants/${BOB}/check?amount=5&payee=${ERIN}`, `Bearer ${AGENT_TOKEN}`]);
  assert.deepEqual(r.cover, NO_COVER_SHOWN);
  assert.ok(w.calls().every(([m]) => m === 'GET'));
  assert.deepEqual(w.calls().filter(([, p]) => !p.includes('/check')).map(([, , auth]) => auth), [null, null], 'the directory without a token');
});

test('checkPayer(): an amount that is not a whole number, or no payee for an unjoined client, is refused before any read', async () => {
  const w = world();
  for (const amount of [0, -1, 1.5, '18', true, null, 2 ** 53]) {
    await assert.rejects(w.client().checkPayer('bob', amount),
      e => e.code === 'bad_arguments' && e.message === 'amount must be a whole number of PC, at least 1; nothing was read', String(amount));
  }
  await assert.rejects(w.client(false).checkPayer('bob', 18), e => e.code === 'bad_arguments' && /give payee/.test(e.message));
  assert.deepEqual(w.fetch.calls, []);
  assert.deepEqual(await w.client(false).checkPayer(BOB, 18, {payee: ERIN}),
    verdict('accept', undefined, {payee: {id: ERIN, handle: null}, cover: NO_COVER_SHOWN}));
  assert.equal(w.calls().at(-1)[2], null, 'an unjoined client has no token to send');
});

test("checkPayer(): a 401 means no budget cards only for a request without a token; with this agent's token it is refused", async () => {
  const w = world();
  for (const payee of [ERIN, ME]) {
    w.routes[`GET /pilot/v1/participants/${BOB}/check?amount=18&payee=${payee}`] = {status: 401, body: {error: 'unauthorized', message: 'missing or invalid token'}};
  }
  await rejects(w.client(false).checkPayer(BOB, 18, {payee: ERIN}), 'feature_unavailable');
  await assert.rejects(w.client().checkPayer(BOB, 18), e => e.code === 'unauthorized' && e.status === 401);
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
    {amount: 30, rule: 'approve_above', approval_needed: true, cover: {covered: 0, guarantees: []}})};
  assert.equal((await check({payer: 'bob', amount: 30})).summary, SUMMARY_ASK);
  w.routes[route(45)] = {body: verdict('decline', ['above its limit per deal (30)', 'more than the room it has left (31)'],
    {amount: 45, rule: 'max_issue_per_deal', cover: NO_COVER_SHOWN})};
  assert.equal((await check({payer: 'bob', amount: 45})).summary, SUMMARY_DECLINE);
  w.cardPublic[BOB] = false;
  assert.deepEqual(await check({payer: 'bob', amount: 18}), {summary: SUMMARY_NOT_PUBLIC, verdict: 'unknown',
    reasons: ["the payer's owner has not published a budget card"], rule: null, payer: {id: BOB, handle: 'bob'}, amount: 18});
});

test('checkSummary(): without reasons, a verdict this client does not know, and reasons put on one line', () => {
  assert.equal(checkSummary({verdict: 'accept', reasons: []}), "Accept: its owner's budget card allows this note.");
  assert.equal(checkSummary({verdict: 'ask_owner'}), "Ask the payer\'s owner: the payer\'s owner approves a note this size before it binds.");
  assert.equal(checkSummary({verdict: 'decline', reasons: null}), "Decline: its owner's budget card does not allow this note.");
  assert.equal(checkSummary({verdict: 'maybe', reasons: ['unsure']}), 'Unknown: unsure.');
  assert.equal(checkSummary(null), 'Unknown: the server gave no verdict this client knows.');
  assert.equal(checkSummary({verdict: 'accept', reasons: [' within\nits budget.. ', 3, '', 'fine;']}), 'Accept: within its budget, fine.');
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

test('checkSummary(): the cover is named only when it is shown and above 0, and not for a decline', () => {
  const s = (verdict, covered) => checkSummary({verdict, reasons: ['r'], cover: {covered}});
  assert.equal(s('accept', 3), 'Accept: r, backed for you up to 3.');
  assert.equal(s('ask_owner', 2), 'Ask the payer\'s owner: r, backed for you up to 2.');
  for (const covered of [null, undefined, 0, -1, 2.5, true, '3', 2 ** 53]) assert.equal(s('accept', covered), 'Accept: r.', String(covered));
  assert.equal(s('decline', 3), 'Decline: r.', 'a declined IOU would not be issued: its cover is not named');
  assert.equal(checkSummary({verdict: 'accept', cover: {covered: 3}}), "Accept: its owner's budget card allows this note, backed for you up to 3.");
});

test('valun_check_payer: the new decline rules (no_agent, network_limit) read as other declines', async () => {
  const w = world();
  const route = amount => `GET /pilot/v1/participants/${BOB}/check?amount=${amount}&payee=${ME}`;
  w.routes[route(18)] = {body: verdict('decline', ['bob has no active agent key, so it cannot sign an IOU'], {rule: 'no_agent'})};
  let r = await w.agent().call('valun_check_payer', {payer: 'bob', amount: 18});
  assert.deepEqual([r.summary, r.rule], ['Decline: bob has no active agent key, so it cannot sign an IOU.', 'no_agent']);
  w.routes[route(5000)] = {body: verdict('decline', ["5000 is above the network's limit per deal (1000)."],
    {amount: 5000, rule: 'network_limit', cover: NO_COVER_SHOWN})};
  r = await w.agent().call('valun_check_payer', {payer: 'bob', amount: 5000});
  assert.deepEqual([r.summary, r.rule], ["Decline: 5000 is above the network's limit per deal (1000).", 'network_limit']);
});

test("valun_check_payer: a refused token and a server from before budget cards are errors (the check carries this agent's token)", async () => {
  const w = world();
  const route = `GET /pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`;
  w.routes[route] = {status: 401, body: {error: 'unauthorized', message: 'missing or invalid token'}};
  assert.equal((await w.agent().callSafe('valun_check_payer', {payer: BOB, amount: 18})).error, 'unauthorized');
  w.routes[route] = {status: 404, body: {error: 'not_found', message: 'not found'}};
  assert.deepEqual(await w.agent().callSafe('valun_check_payer', {payer: BOB, amount: 18}), {error: 'not_found', message: 'not found'});
});

test('valun_check_payer: read only, never asks the owner, runs where commitments cannot be approved', async () => {
  const w = world();
  const a = w.agent();
  assert.ok(READ_ONLY_TOOLS.includes('valun_check_payer') && !SIGNING_TOOLS.includes('valun_check_payer'));
  assert.equal(await a.isCommitment('valun_check_payer', {payer: 'bob', amount: 18}), false);
  assert.deepEqual(await a.prepare('valun_check_payer', {payer: 'bob', amount: 18}), {args: {payer: 'bob', amount: 18}, text: null});
  const tool = valunTools(a).find(t => t.name === 'valun_check_payer');          // no approve hook: commitments fail closed
  const r = await tool.execute({payer: 'bob', amount: 18});
  assert.deepEqual([r.summary, r.cover], [SUMMARY_ACCEPT, COVER], 'its own cover, shown to it');
  assert.deepEqual(w.calls(), [['GET', '/pilot/v1/participants', null],
    ['GET', `/pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}`, `Bearer ${AGENT_TOKEN}`]], 'nothing sent but its own token');
});

test('valun_check_payer: the amount is checked as valun_propose checks its price, before anything is read', async () => {
  const {description: _p, ...price} = schemas.PROPOSE.parameters.properties.price;
  const {description: _a, ...amount} = schemas.CHECK_PAYER.parameters.properties.amount;
  assert.deepEqual(amount, price);
  assert.deepEqual([...schemas.CHECK_PAYER.parameters.required], ['payer', 'amount']);
  const w = world();
  for (const [bad, shownAs] of [[1.5, '1.5'], ['18', '"18"'], [true, 'true'], [0, '0'], [-2, '-2']]) {
    assert.deepEqual(await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: bad}), {error: 'bad_arguments',
      message: `amount must be a whole number of PC, at least 1 (a JSON integer), not ${shownAs}; nothing was signed`}, String(bad));
  }
  // a null amount is a missing one (fix inbox #58: the tool's schema requires it)
  assert.deepEqual(await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: null}), {error: 'bad_arguments',
    message: "missing argument: amount (what it would owe you, the deal's price: a whole number, at least 1)"});
  assert.deepEqual(w.fetch.calls, []);
  assert.equal((await w.agent().callSafe('valun_check_payer', {payer: 5, amount: 18})).error, 'bad_arguments');
  assert.deepEqual(await w.agent().callSafe('valun_check_payer', {amount: 18}), {error: 'bad_arguments',
    message: 'missing argument: payer (the handle or participant id of the agent that would owe you)'});
});

test('valun_check_payer: its description tells a model to run it before accepting an IOU, in the words of each network', () => {
  assert.ok(schemas.CHECK_PAYER.description.startsWith('Run this before you accept a note from an agent you do not know'));
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
    message: 'missing argument: price (the price: a whole number, at least 1); nothing was signed'});
  assert.deepEqual(await a.callSafe('valun_propose', {...brief, price: 1.5}), {error: 'bad_arguments',
    message: 'price must be a whole number of PC, at least 1 (a JSON integer), not 1.5; nothing was signed'}, 'a price there, not whole');
  assert.deepEqual(w.fetch.calls, []);
  const [prepared, refusal] = await a.prepareOrRefusal('valun_propose', {...noTitle, title: undefined});
  assert.equal(prepared, null);
  assert.deepEqual(refusal, {error: 'bad_arguments', message: 'missing argument: title (a short name of the service); nothing was signed'},
    'an offer missing a text is never put to the owner: the refusal the call itself gives');
  const e = await a.prepare('valun_propose', noTitle).then(() => null, x => x);
  assert.deepEqual([e?.code, e?.extra?.cause], ['approval_unbound', 'bad_arguments']);
  assert.deepEqual(w.fetch.calls, [], 'nothing is read for it');
});

// ---------- fix inbox #60: the offer under review (deal_id), and a new deal at the price of an offer counted already ----------
const OFFER = 'vd_' + '6a'.repeat(8), OTHER_OFFER = 'vd_' + '7b'.repeat(8);

test('valun_check_payer deal_id: sent as deal= with this agent\'s token, and the answer names it', async () => {
  const w = world();
  const r = await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: 18, deal_id: OFFER});
  assert.deepEqual(w.calls().at(-1), ['GET', `/pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}&deal=${OFFER}`, `Bearer ${AGENT_TOKEN}`]);
  assert.deepEqual([r.deal_id, r.summary], [OFFER, SUMMARY_ACCEPT]);
  assert.equal((await w.client().checkPayer('bob', 18, {dealId: OFFER})).deal_id, OFFER);
  await w.client().checkPayer('bob', 18, {dealId: null});
  assert.ok(!w.calls().at(-1)[1].includes('deal='), 'null: a new deal');
});

test('valun_check_payer deal_id: one that is not a deal id is refused before any read, in the tool and the client', async () => {
  const w = world();
  for (const bad of ['vd_123', OFFER.toUpperCase(), OFFER + '\n', ' ' + OFFER, '', 5, true, [OFFER], {deal_id: OFFER}]) {
    const r = await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: 18, deal_id: bad});
    assert.equal(r.error, 'bad_arguments', String(bad));
    assert.ok(r.message.startsWith('deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox lists it, not '));
    await assert.rejects(w.client().checkPayer('bob', 18, {dealId: bad}),
      e => e.code === 'bad_arguments' && e.message === 'deal_id must be a deal id, vd_ and 16 hex digits; nothing was read');
  }
  assert.deepEqual(w.fetch.calls, []);
});

test('valun_check_payer deal_id: a server that ignores deal= (or answers for another deal) is refused: offer_not_checked', async () => {
  const w = world();
  w.ignoresDeal = true;
  assert.deepEqual(await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: 18, deal_id: OFFER}), {error: 'offer_not_checked',
    message: `this Valun server does not check the offer under review (${OFFER}): its answer is for a new deal on top of that offer, which it counts twice`});
  w.ignoresDeal = false;
  w.routes[`GET /pilot/v1/participants/${BOB}/check?amount=18&payee=${ME}&deal=${OFFER}`] = {body: verdict('accept', undefined, {deal_id: OTHER_OFFER})};
  await assert.rejects(w.client().checkPayer('bob', 18, {dealId: OFFER}), e => e.code === 'offer_not_checked');
  await assert.rejects(world().client().checkPayer('bob', 18, {payee: 'erin', dealId: OFFER}), e => e.code === 'not_payee' && e.status === 403);
});

test('valun_check_payer: a new deal at the price of an offer the payer made you says so, and how to check that offer', async () => {
  const w = world();
  w.extra = {counted_offers: [{deal_id: OFFER, amount: 18}]};
  const r = await w.agent().callSafe('valun_check_payer', {payer: 'bob', amount: 18});
  assert.equal(r.summary, `Accept, for a new deal on top of the offer you received at this price (${OFFER}, already counted): within its `
    + `budget (31 of 40 left), backed for you up to 3. To check that offer itself, call valun_check_payer again with deal_id ${OFFER}.`);
  const s = (offers, more = {}) => checkSummary({verdict: 'accept', reasons: ['r'], amount: 18, counted_offers: offers, ...more});
  assert.equal(s([{deal_id: OFFER, amount: 18}, {deal_id: OTHER_OFFER, amount: 18}]), `Accept, for a new deal on top of the 2 offers you `
    + `received at this price (${OFFER}, ${OTHER_OFFER}, already counted): r. To check one of them, call valun_check_payer again with its deal_id.`);
  for (const offers of [[{deal_id: OTHER_OFFER, amount: 25}], [], null, [{deal_id: OFFER, amount: '18'}], [{deal_id: 'vd_1', amount: 18}]]) {
    assert.equal(s(offers), 'Accept: r.', JSON.stringify(offers));
  }
  assert.equal(s([{deal_id: OFFER, amount: 18}], {deal_id: OFFER}), 'Accept: r.', 'an answer for the offer itself');
  assert.deepEqual(offersCountedAt({amount: 18, counted_offers: [{deal_id: OFFER, amount: 18}]}), [OFFER]);
});

test('valun_check_payer: your own side (payee_side) ends the summary when it would not simply go ahead', () => {
  const s = side => checkSummary({verdict: 'accept', reasons: ['r'], payee_side: side});
  assert.equal(s({verdict: 'decline', reasons: ['Your own limits refuse it (max_accept_per_deal): over your limit.']}),
    'Accept: r. Your own side: Your own limits refuse it (max_accept_per_deal): over your limit.');
  assert.equal(s({verdict: 'ask_owner', reasons: []}), `Accept: r. Your own side: ${CHECK_PAYEE_SIDE.ask_owner}.`);
  for (const side of [{verdict: 'accept', reasons: ['Your own limits allow it.']}, {verdict: 'toString'}, {verdict: ['decline']}, 'decline', null]) {
    assert.equal(s(side), 'Accept: r.', JSON.stringify(side));
  }
});

test('valun_check_payer: the schema offers deal_id, optional, and says when to pass it', () => {
  const p = schemas.CHECK_PAYER.parameters;
  assert.deepEqual([...p.required], ['payer', 'amount']);
  const {description: _d, ...dealId} = p.properties.deal_id;
  assert.deepEqual(dealId, {type: 'string', pattern: '^vd_[0-9a-f]{16}$'});
  assert.match(schemas.CHECK_PAYER.description, /Pass that deal's deal_id/);
});

// ---------- fix inbox #87: the step's verdict from both sides (payer_side, payee_side) ----------
const BOTH = {verdict: 'accept', rule: null, reasons: ['Within its budget.']};

test('fix inbox #87: the recorded answers give the summary the Python client gives, first in the tool\'s answer', {skip: NO_SIDES}, async () => {
  assert.equal(SIDES.cases.length, 11);
  const {payer, amount, path} = SIDES.request;
  for (const c of SIDES.cases) {
    const w = world();
    w.routes[`GET ${path}`] = {status: c.status, body: c.body};
    const r = await w.agent().callSafe('valun_check_payer', {payer, amount});
    assert.equal(r.summary, c.summary, c.name);
    if (c.status === 200) {
      assert.equal(checkSummary(c.body), c.summary, c.name);
      assert.equal(Object.keys(r)[0], 'summary');
      const {summary: _s, ...rest} = r;
      assert.deepEqual(rest, c.body, `${c.name}: the rest is the server's answer`);
    } else {
      assert.deepEqual([r.verdict, r.payer], ['unknown', {id: BOB, handle: 'bob'}], c.name);
    }
  }
});

test('fix inbox #87: the lead is the step\'s verdict, an ask_owner names whose owner, and the cover is the server\'s sentence, said once', {skip: NO_SIDES}, () => {
  const leads = {accept: 'Accept: ', decline: 'Decline: ', unknown: 'Unknown: '};
  for (const c of SIDES.cases.filter(x => x.status === 200 && Object.hasOwn(x.body, 'payer_side'))) {
    const b = c.body;
    const want = leads[b.verdict] ?? `${CHECK_ASK_LEAD[checkOwners(b)]}: `;
    assert.ok(c.summary.startsWith(`${want}${b.reasons[0].slice(0, -1)}. `), c.summary);
    const said = b.payee_side.reasons.filter(x => x.startsWith('Backed for you'));
    assert.equal(c.summary.toLowerCase().split('backed for you').length - 1, said.length, c.name);
    assert.ok(said.length <= 1);
    assert.ok(c.summary.endsWith(` Your own side: ${b.payee_side.reasons.join(' ')}`), c.summary);
  }
  const named = Object.fromEntries(SIDES.cases.map(c => [c.name, c]));
  assert.ok(named['ask owner payee with cover'].summary.startsWith('Ask your owner: '));
  assert.ok(named['ask owner both'].summary.startsWith("Ask your owner and the payer's owner: "));
  assert.ok(named['old server: ask owner payee with cover'].summary.startsWith('Accept: Within its budget'), 'a server from before #87: as in 0.7.1');
});

test('fix inbox #87: whose owner decides an ask_owner (checkOwners), with and without reasons', () => {
  const side = v => ({verdict: v, rule: v === 'ask_owner' ? 'approve_above' : null, reasons: []});
  const s = (payer, payee) => checkSummary({verdict: 'ask_owner', reasons: ['R.'], rule: 'approve_above', payer_side: payer, payee_side: payee});
  assert.equal(s(side('accept'), side('ask_owner')), `Ask your owner: R. Your own side: ${CHECK_PAYEE_SIDE.ask_owner}.`);
  assert.equal(s(side('ask_owner'), side('accept')), "Ask the payer's owner: R.");
  assert.equal(s(side('ask_owner'), side('ask_owner')), `Ask your owner and the payer's owner: R. Your own side: ${CHECK_PAYEE_SIDE.ask_owner}.`);
  for (const [payer, payee] of [[null, null], ['ask_owner', null], [side('accept'), side('accept')], [[side('ask_owner')], 7],
    [{verdict: 'toString'}, {verdict: 'constructor'}]]) {
    assert.ok(s(payer, payee).startsWith("Ask your owner and the payer's owner: R."), JSON.stringify([payer, payee]));
  }
  assert.equal(checkOwners({payer_side: side('ask_owner'), payee_side: null}), 'payer');
  assert.equal(checkOwners(null), 'both');
  for (const [whose, payer, payee] of [['payee', side('accept'), side('ask_owner')], ['payer', side('ask_owner'), side('accept')],
    ['both', side('ask_owner'), side('ask_owner')]]) {
    const r = checkSummary({verdict: 'ask_owner', reasons: [], payer_side: payer, payee_side: payee});
    assert.ok(r.startsWith(`${CHECK_ASK_LEAD[whose]}: ${CHECK_ASK_FALLBACK[whose]}.`), r);
  }
  // a server from before #87 (no payer_side): the payer's owner, as in 0.7.1, and your own side after it
  assert.equal(checkSummary({verdict: 'ask_owner', reasons: ['R.'], payee_side: side('ask_owner')}),
    `Ask the payer's owner: R. Your own side: ${CHECK_PAYEE_SIDE.ask_owner}.`);
});

test('fix inbox #87: with payer_side this client never names the cover itself; your own accept adds its reasons', () => {
  for (const payer of [BOTH, null, 'junk']) {
    const v = {verdict: 'accept', reasons: ['Both sides allow it.'], cover: {covered: 3}, payer_side: payer};
    assert.equal(checkSummary(v), 'Accept: Both sides allow it.', JSON.stringify(payer));
    assert.equal(checkSummary({...v, payee_side: {verdict: 'accept', reasons: ['Your own limits allow it.', 'Backed for you up to 3 by @erin.']}}),
      'Accept: Both sides allow it. Your own side: Your own limits allow it. Backed for you up to 3 by @erin.');
  }
  assert.equal(checkSummary({verdict: 'accept', reasons: ['r'], cover: {covered: 3}}), 'Accept: r, backed for you up to 3.', 'before #87: as in 0.7.1');
  const v = {verdict: 'accept', reasons: ['Both sides allow it.'], payer_side: BOTH};
  assert.equal(checkSummary({...v, payee_side: {verdict: 'accept', reasons: []}}), 'Accept: Both sides allow it.');
  for (const side of [{verdict: 'Accept', reasons: ['x']}, {verdict: ['accept'], reasons: ['x']}, {reasons: ['x']}, 'accept']) {
    assert.equal(checkSummary({...v, payee_side: side}), 'Accept: Both sides allow it.', JSON.stringify(side));
  }
  assert.equal(checkSummary({verdict: 'accept', reasons: ['r'], payee_side: {verdict: 'accept', reasons: ['x']}}), 'Accept: r.',
    'before #87: your own accept adds nothing, as in 0.7.1');
});

test('the summary: a sentence of the server\'s follows after a stop, a fragment after a comma', () => {
  const s = (...reasons) => checkSummary({verdict: 'accept', reasons});
  assert.equal(s('Within its budget.', 'Its owner approves it.'), 'Accept: Within its budget. Its owner approves it.');
  assert.equal(s('within its budget', 'fine'), 'Accept: within its budget, fine.');
  assert.equal(s('Within its budget.', "bob's IOUs count 50%.", '2 of 40 left', 'Zed;'), "Accept: Within its budget, bob's IOUs count 50%, 2 of 40 left. Zed.");
  assert.equal(s('A.', 'Été.', 'B'), 'Accept: A, Été. B.', 'capitals A to Z only, as in Python');
});
