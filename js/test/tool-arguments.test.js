// Fix inbox #58, the sweep, the JavaScript twin of python/tests/test_tool_arguments.py: every tool, called with no
// arguments ({}, null or undefined) and with arguments that are not a JSON object, answers bad_arguments naming each
// argument its schema requires, before anything is read or signed, or, for a tool that requires none, what it answers for
// {}; never internal_error. It is checked once, where every call comes in (ValunAgent.call, toolArguments), and through
// the adapters: prepareOrRefusal() (the refusal it returns instead of asking the owner) and valunTools() in each mode.
// Offline: a fake fetch. The 'arguments:' scenarios of agent-parity.test.js compare the same calls with Python, value for
// value.
//
// 0.7.2, the type sweep: each argument given must also be of its schema's type. Basis's 15 internal_errors of this client
// (fix inbox evidence testnet-0.7.1-1115, 58-npm-typesweep.txt; 18 in the Python one) and every argument of every tool with
// a value of another type answer bad_arguments naming it and what it must be (or the tool's own refusal of a value an enum
// does not list), before anything is read or signed, in every adapter; ids of the shapes the server's routes take; an
// amount's words in the profile's unit. python-parity.test.js holds argumentRefusal to the Python core value for value.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  ARGUMENT_WORDS, ARGUMENT_WORDS_OF, Client, ENUM_REFUSALS, ID_SHAPES, LIMIT_TOOLS, MemoryStore, NETWORK, PROPERTIES, READ_ONLY_TOOLS,
  HOURS_MAX, REQUIRED_ARGUMENTS, SIGNING_TOOLS, TOOL_NAMES, ValunAgent, ValunError, argumentRefusal, quoted, schemas, toolArguments,
  valunTools,
} from '../src/index.js';
import {fakeFetch} from './helpers.js';

const BASE = 'https://valun.invalid';
const ME = 'vp_a1a1a1a1a1a1', BOB = 'vp_b0b0b0b0b0b0';
const PEOPLE = [{id: ME, handle: 'alice', display_name: 'Alice', operator: 'Alice Example', about: '', services: '', status: 'active'},
  {id: BOB, handle: 'bob', display_name: 'Bob', operator: 'Bob Example', about: 'Briefs.', services: 'Briefs', status: 'active'}];
const ME_VIEW = {participant: {id: ME, handle: 'alice', status: 'active'}, mandate: {approve_above: 25}, mandate_version: 3,
  position: {claims_held: 0, owes: 9, net: -9}, authority: {}};
const ROUTES = {'GET /pilot/v1/info': {body: {network: NETWORK, protocol: 'valun-deal/1', unit: 'PC'}}, 'GET /pilot/v1/me': {body: ME_VIEW},
  'GET /pilot/v1/participants': {body: PEOPLE}, [`GET /pilot/v1/participants/${BOB}`]: {body: {id: BOB, public_position: {}}},
  'GET /pilot/v1/inbox': {body: {respond: []}}, 'GET /pilot/v1/guarantees': {body: []}};
// What 0.7.0 took as {} (the falsy ones) and what failed in the Python client with an AttributeError (internal_error).
const NOT_AN_OBJECT = ['x', '', 42, 0, 1.5, true, false, [], [1], ['vd_1111111111111111', 'accept']];

/** The answer toolArguments gives: for arguments that are not a JSON object (missing null), or that lack `missing`. */
function refusal(name, missing = null) {
  const tail = READ_ONLY_TOOLS.includes(name) ? '' : '; nothing was signed';
  if (missing === null) return {error: 'bad_arguments', message: 'the arguments are not a JSON object' + tail};
  const words = {...ARGUMENT_WORDS, ...(ARGUMENT_WORDS_OF[name] ?? {})};
  return {error: 'bad_arguments', message: (missing.length === 1 ? 'missing argument: ' : 'missing arguments: ')
    + missing.map(k => `${k} (${words[k]})`).join(', ') + tail};
}

function world(network = null) {
  const fetch = fakeFetch(ROUTES, BASE);
  const state = {server: BASE, participant_id: ME, pubkey: '02' + '11'.repeat(32), ...(network ? {network} : {})};
  const client = new Client({server: BASE, fetch, store: new MemoryStore({state, secret: '11'.repeat(32), token: 'vpa_test-agent'})});
  return {fetch, agent: new ValunAgent(client)};
}

test('every required argument is the schema\'s and has its words; the classes and words are the Python core\'s', () => {
  for (const network of [null, schemas.TESTNET]) {
    for (const t of schemas.forNetwork(network)) assert.deepEqual([...REQUIRED_ARGUMENTS[t.name]], [...t.parameters.required], t.name);
  }
  assert.deepEqual(Object.keys(REQUIRED_ARGUMENTS), [...TOOL_NAMES]);
  for (const [name, keys] of Object.entries(REQUIRED_ARGUMENTS)) {
    for (const k of keys) {
      const words = ARGUMENT_WORDS_OF[name]?.[k] ?? ARGUMENT_WORDS[k];
      assert.ok(typeof words === 'string' && words && !words.endsWith('.'), `${name}.${k}`);
    }
  }
  const or = e => `${e.slice(0, -1).join(', ')} or ${e.at(-1)}`;
  assert.equal(ARGUMENT_WORDS_OF.valun_respond_guarantee.action, or(schemas.RESPOND_GUARANTEE.parameters.properties.action.enum));
  assert.equal(ARGUMENT_WORDS.action, or(schemas.RESPOND.parameters.properties.action.enum));
  assert.ok(Object.isFrozen(ARGUMENT_WORDS) && Object.isFrozen(REQUIRED_ARGUMENTS) && Object.isFrozen(REQUIRED_ARGUMENTS.valun_propose));
});

test('toolArguments(): {} for none, the object itself, or bad_arguments naming what is missing', () => {
  assert.deepEqual(toolArguments('valun_status', null), {});
  assert.deepEqual(toolArguments('valun_status', undefined), {});
  const a = {deal_id: 'vd_1111111111111111'};
  assert.equal(toolArguments('valun_deal', a), a, 'the object given, itself');
  assert.throws(() => toolArguments('valun_deal', {deal_id: null}), e => e instanceof ValunError && e.code === 'bad_arguments'
    && e.message === 'missing argument: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it)');
  assert.throws(() => toolArguments('valun_respond', [a]), e => e.code === 'bad_arguments'
    && e.message === 'the arguments are not a JSON object; nothing was signed');
  assert.deepEqual(toolArguments('valun_offer_guarantee', {issuer: 'bob', creditor: 'bob', cap: 0, due_in_hours: 0}),
    {issuer: 'bob', creditor: 'bob', cap: 0, due_in_hours: 0}, '0, false and "" are there: only absent or null is missing');
});

test('no arguments: a tool names every argument its schema requires, before anything is read; the others answer as for {}', async () => {
  for (const name of TOOL_NAMES) {
    for (const args of [{}, null, undefined]) {
      const w = world();
      const r = await w.agent.callSafe(name, args);
      const req = [...REQUIRED_ARGUMENTS[name]];
      if (req.length) {
        assert.deepEqual(r, refusal(name, req), `${name} ${String(args)}`);
        assert.deepEqual(w.fetch.calls, [], `${name}: refused before anything is read`);
      } else {
        assert.ok(!['internal_error', 'bad_arguments'].includes(r.error), `${name}: ${JSON.stringify(r).slice(0, 200)}`);
      }
    }
  }
  const {agent} = world();
  assert.equal((await agent.callSafe('valun_set_limits', {})).error, 'nothing_to_record');
  assert.equal((await agent.callSafe('valun_review_delivery', {})).message, 'missing arguments: deal_id (the deal id, vd_ + 16 hex, as '
    + 'valun_inbox lists it), decision (accept or dispute); nothing was signed');
  assert.equal((await agent.callSafe('valun_respond_guarantee', {guarantee_id: 'vg_' + '1a'.repeat(8)})).message,
    'missing argument: action (accept, decline, release, withdraw or honor); nothing was signed');
});

test('arguments that are not a JSON object are refused for every tool, before anything is read', async () => {
  const w = world();
  for (const name of TOOL_NAMES) {
    for (const bad of NOT_AN_OBJECT) {
      assert.deepEqual(await w.agent.callSafe(name, bad), refusal(name), `${name} ${JSON.stringify(bad)}`);
      await assert.rejects(w.agent.call(name, bad), e => e instanceof ValunError && e.code === 'bad_arguments');
    }
  }
  assert.deepEqual(w.fetch.calls, []);
});

test('prepareOrRefusal() gives the refusal the call itself gives; prepare() refuses it too, and isCommitment() stays fail closed', async () => {
  for (const name of TOOL_NAMES) {
    const cases = NOT_AN_OBJECT.map(bad => [bad, refusal(name)]);
    if (REQUIRED_ARGUMENTS[name].length) cases.push([{}, refusal(name, [...REQUIRED_ARGUMENTS[name]])]);
    for (const [args, want] of cases) {
      const w = world();
      assert.deepEqual(await w.agent.prepareOrRefusal(name, args), [null, want], `${name} ${JSON.stringify(args)}`);
      assert.deepEqual(w.fetch.calls, [], `${name}: nothing is read for it`);
      if (await world().agent.isCommitment(name, args)) {
        const v = world();
        const e = await v.agent.prepare(name, args).then(() => null, x => x);
        assert.deepEqual([e?.code, e?.extra?.cause], ['approval_unbound', 'bad_arguments'], `${name} ${JSON.stringify(args)}`);
        assert.deepEqual(v.fetch.calls, []);
      }
    }
  }
  const {agent} = world();
  assert.equal(await agent.isCommitment('valun_respond', ['not', 'a', 'dict']), true, 'fail closed by name and value, as before');
  assert.equal(await agent.isCommitment('valun_propose', {}), true);
  const decline = {deal_id: 'vd_1111111111111111', action: 'decline', reason: 'No.'};
  assert.deepEqual(await agent.prepareOrRefusal('valun_respond', decline), [{args: decline, text: null}, null], 'complete arguments as before');
});

test('valunTools(): bad_arguments in every mode; with no way to ask the owner, a commitment is approval_unavailable as before', async () => {
  for (const mode of ['none', 'ask', 'unavailable']) {
    const w = world();
    const asked = [];
    const options = mode === 'none' ? {approvals: 'none'} : mode === 'ask' ? {approve: async text => { asked.push(text); return true; }} : {};
    const tools = Object.fromEntries(valunTools(w.agent, options).map(t => [t.name, t]));
    for (const name of TOOL_NAMES) {
      const cases = [];
      if (REQUIRED_ARGUMENTS[name].length) cases.push([{}, refusal(name, [...REQUIRED_ARGUMENTS[name]])], ['{}', refusal(name, [...REQUIRED_ARGUMENTS[name]])]);
      for (const [args, want] of cases) {
        const r = await tools[name].execute(args);
        if (mode === 'unavailable' && [...SIGNING_TOOLS, ...LIMIT_TOOLS].includes(name) && await world().agent.isCommitment(name, {})) {
          assert.equal(r.error, 'approval_unavailable', `${mode} ${name}`);    // no commitment can be signed here at all
        } else {
          assert.deepEqual(r, want, `${mode} ${name} ${JSON.stringify(args)}`);
        }
      }
      // the adapter's own check of what is not a JSON object (or a JSON text of one), before the agent's
      for (const raw of ['"x"', '42', '[1]', [1], 7, 'not json']) {
        const r = await tools[name].execute(raw);
        assert.equal(r.error, 'bad_arguments', `${mode} ${name} ${JSON.stringify(raw)}`);
        assert.match(r.message, /^arguments must be a JSON object: /);
      }
    }
    assert.deepEqual(asked, [], `${mode}: the owner is never asked about any of them`);
    assert.ok(w.fetch.calls.every(c => c.key === 'GET /pilot/v1/me'), `${mode}: nothing read but GET /me (valun_set_limits' classification)`);
  }
});

// ---------- 0.7.2: the type sweep ----------
// Basis's base arguments (58-npm-typesweep.mjs), with due_in_hours for valun_offer_guarantee (without it every call of
// that tool is a missing argument first).
const SWEEP_BASE = {valun_respond: {deal_id: 'vd_0000000000000000', action: 'decline'}, valun_deal: {deal_id: 'vd_0000000000000000'},
  valun_propose: {counterparty: 'sandbox-exact', role: 'payer', title: 't', description: 'd', deliverable: 'x', price: 1},
  valun_deliver: {deal_id: 'vd_0000000000000000', content: 'x'},
  valun_review_delivery: {deal_id: 'vd_0000000000000000', decision: 'dispute', reason: 'r'},
  valun_check_payer: {payer: 'sandbox-exact', amount: 1},
  valun_offer_guarantee: {issuer: 'sandbox-exact', creditor: 'sandbox-mallory', cap: 1, due_in_hours: 0},
  valun_respond_guarantee: {guarantee_id: 'vg_0000000000000000', action: 'decline'},
  valun_call_guarantee: {guarantee_id: 'vg_0000000000000000'}, valun_guarantees: {}, valun_directory: {}, valun_set_limits: {goals: 'g'},
  valun_status: {}, valun_inbox: {}};
// 58-npm-typesweep.txt INTERNAL_ERRORS 15 (58-py-typesweep.txt: these and three deal_id {"a": 1}, 18): 33 in all.
const BASIS_INTERNAL_ERRORS = [['valun_directory', 'query'], ['valun_propose', 'counterparty'], ['valun_propose', 'description'],
  ['valun_respond', 'reason'], ['valun_review_delivery', 'reason']].flatMap(([t, k]) => [42, [1], {a: 1}].map(v => [t, k, v]));
const PY_ONLY = ['valun_deal', 'valun_deliver', 'valun_review_delivery'].map(t => [t, 'deal_id', {a: 1}]);
const WRONG = {string: [42, [1], {a: 1}, true], integer: ['7', 1.5, true, [1], 2 ** 53], boolean: ['yes', 1, 'false', [true]],
  array: ['x', 5, {a: 1}, [5]]};
const ENUM_WRONG = ['Accept', 'accepted', '', 7, ['accept'], true];
const ID_WRONG = {
  deal_id: ['vd_1', 'vd_' + '6A'.repeat(8), 'VD_' + '6a'.repeat(8), 'vd_' + '6a'.repeat(8) + '\n', ' vd_' + '6a'.repeat(8), 'vg_' + '6a'.repeat(8), '', 7],
  guarantee_id: ['vg_1', 'vg_' + '3C'.repeat(8), 'vd_' + '3c'.repeat(8), '', 7],
  call_id: ['vgc_1', 'vg_' + '3c'.repeat(8), '', 7]};
const wrongValues = (spec, k) => (Array.isArray(spec.enum) ? ENUM_WRONG : ID_WRONG[k] ?? WRONG[spec.type] ?? []);

test('Basis\'s 33 internal_errors: bad_arguments naming the field and what it must be, before anything is read', async () => {
  assert.equal(BASIS_INTERNAL_ERRORS.length + PY_ONLY.length, 18, 'JavaScript 15, the Python client these and 3 more: 33');
  for (const [tool, k, v] of [...BASIS_INTERNAL_ERRORS, ...PY_ONLY]) {
    const w = world();
    const r = await w.agent.callSafe(tool, {...SWEEP_BASE[tool], [k]: v});
    assert.equal(r.error, 'bad_arguments', `${tool} ${k}=${JSON.stringify(v)}: ${JSON.stringify(r)}`);
    assert.ok(r.message.startsWith(`${k} must be `), r.message);
    assert.ok(r.message.includes(`not ${quoted(v)}`), r.message);
    assert.deepEqual(w.fetch.calls, [], `${tool} ${k}: refused before anything is read`);
  }
  const {agent} = world();
  assert.deepEqual(await agent.callSafe('valun_propose', {...SWEEP_BASE.valun_propose, counterparty: 42}),
    {error: 'bad_arguments', message: 'counterparty must be a string (their handle or participant id), not 42; nothing was signed'});
  assert.deepEqual(await agent.callSafe('valun_directory', {query: [1]}), {error: 'bad_arguments', message: 'query must be a string, not [1]'});
  assert.deepEqual(await agent.callSafe('valun_deal', {deal_id: {a: 1}}),
    {error: 'bad_arguments', message: 'deal_id must be the deal id, vd_ + 16 hex, as valun_inbox lists it, not {"a":1}'});
  assert.deepEqual(await agent.callSafe('valun_respond', {...SWEEP_BASE.valun_respond, reason: {a: 1}}),
    {error: 'bad_arguments', message: 'reason must be a string, not {"a":1}; nothing was signed'});
});

test('every argument of every tool of another type is refused before anything is read', async () => {
  let n = 0;
  for (const t of schemas.ALL) {
    for (const [k, spec] of Object.entries(t.parameters.properties)) {
      for (const v of wrongValues(spec, k)) {
        const w = world();
        const r = await w.agent.callSafe(t.name, {...SWEEP_BASE[t.name], [k]: v});
        n++;
        const want = Array.isArray(spec.enum) ? ENUM_REFUSALS[t.name][k][0] : 'bad_arguments';
        assert.equal(r.error, want, `${t.name} ${k}=${JSON.stringify(v)}: ${JSON.stringify(r)}`);
        assert.ok(r.message.includes(k), r.message);
        assert.deepEqual(w.fetch.calls, [], `${t.name} ${k}: nothing is read`);
        assert.equal(argumentRefusal(t.name, k, v).code, want);
      }
    }
  }
  assert.ok(n > 200, String(n));
});

test('what fits passes, null is absent, and the first argument of the wrong type is named (a missing one first)', async () => {
  for (const t of schemas.ALL) for (const k of Object.keys(t.parameters.properties)) assert.equal(argumentRefusal(t.name, k, null), null);
  const ok = {valun_deal: {deal_id: 'vd_' + '6a'.repeat(8)}, valun_status: {brief: false}, valun_directory: {query: '', limit: 0, offset: -2},
    valun_propose: {...SWEEP_BASE.valun_propose, price: 0, deliver_within_hours: 10 ** 9}, valun_set_limits: {clear: [], goals: ''},
    valun_respond_guarantee: {guarantee_id: 'vg_' + '3c'.repeat(8), action: 'honor', call_id: 'vgc_' + '3c'.repeat(8)},
    valun_offer_guarantee: {...SWEEP_BASE.valun_offer_guarantee, deals: ['vd_' + '6a'.repeat(8)], note: ''},
    valun_check_payer: {payer: ' ', amount: -1, deal_id: 'vd_' + '6a'.repeat(8)}};
  for (const [name, args] of Object.entries(ok)) assert.equal(toolArguments(name, args), args, name);
  const pins = {deal_id: 'vd_' + '6a'.repeat(8), decision: 'accept', expected_quote_digest: 5, expected_claim_total: 'x'};
  assert.equal(toolArguments('valun_review_delivery', pins), pins, 'an argument the schema does not give is the tool\'s');
  assert.deepEqual(toolArguments('valun_new_tool', {deal_id: 7}), {deal_id: 7});
  const {agent} = world();
  assert.equal((await agent.callSafe('valun_propose', {...SWEEP_BASE.valun_propose, price: 'x', title: 5})).message,
    'title must be a string (a short name of the service), not 5; nothing was signed');
  assert.equal((await agent.callSafe('valun_respond', {deal_id: 7})).message,
    'missing argument: action (accept, decline, counter or withdraw); nothing was signed');
  assert.deepEqual(Object.keys(PROPERTIES), [...TOOL_NAMES]);
  assert.ok(Object.isFrozen(PROPERTIES) && Object.isFrozen(ENUM_REFUSALS) && Object.isFrozen(ID_SHAPES));
});

test('deal_id, guarantee_id and call_id are of the shapes the server\'s routes take', async () => {
  const w = world();
  for (const name of ['valun_deal', 'valun_respond', 'valun_deliver', 'valun_review_delivery']) {
    for (const bad of ID_WRONG.deal_id) {
      const r = await w.agent.callSafe(name, {...SWEEP_BASE[name], deal_id: bad});
      assert.equal(r.error, 'bad_arguments', `${name} ${JSON.stringify(bad)}`);
      assert.ok(r.message.startsWith('deal_id must be the deal id, vd_ + 16 hex'), r.message);
    }
  }
  for (const name of ['valun_guarantees', 'valun_respond_guarantee', 'valun_call_guarantee']) {
    for (const bad of ID_WRONG.guarantee_id) {
      assert.deepEqual(await w.agent.callSafe(name, {...SWEEP_BASE[name], guarantee_id: bad}),
        {error: 'bad_arguments', message: 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees lists them)'}, `${name} ${bad}`);
    }
  }
  for (const bad of ID_WRONG.call_id) {
    assert.deepEqual(await w.agent.callSafe('valun_respond_guarantee', {...SWEEP_BASE.valun_respond_guarantee, call_id: bad}),
      {error: 'bad_arguments', message: 'call_id is malformed (vgc_ + 16 hex)'}, String(bad));
  }
  assert.deepEqual(w.fetch.calls, []);
  assert.deepEqual(Object.fromEntries(Object.entries(ID_SHAPES).map(([k, re]) => [k, re.source])),
    {deal_id: '^vd_[0-9a-f]{16}$', guarantee_id: '^vg_[0-9a-f]{16}$', call_id: '^vgc_[0-9a-f]{16}$'});
});

test('the refusals the tools gave before are kept word for word; the new ones name a whole number, true or false', async () => {
  const same = [
    ['valun_review_delivery', 'decision', 'Accept', 'bad_decision', 'decision must be exactly \'accept\' or \'dispute\'; nothing was signed'],
    ['valun_respond', 'action', 7, 'bad_action', 'action must be accept, decline, counter or withdraw'],
    ['valun_propose', 'role', 'buyer', 'bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)'],
    ['valun_respond_guarantee', 'action', 'Accept', 'bad_arguments', 'action must be accept, decline, release, withdraw or honor'],
    ['valun_propose', 'price', 1.5, 'bad_arguments', 'price must be a whole number of PC, at least 1 (a JSON integer), not 1.5; nothing was signed'],
    ['valun_check_payer', 'deal_id', 5, 'bad_arguments',
      'deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox lists it, not 5'],
    ['valun_directory', 'limit', '10', 'bad_arguments',
      'limit must be a whole number (how many participants to show: 1 to 50, 10 by default), not "10"'],
    ['valun_status', 'brief', 'yes', 'bad_arguments', 'brief must be true or false'],
    ['valun_deliver', 'exact_result', 'yes', 'bad_arguments', 'exact_result is true or false'],
    ['valun_offer_guarantee', 'note', 5, 'bad_arguments', 'note must be text'],
    ['valun_offer_guarantee', 'cap', 'x', 'bad_arguments', 'cap must be a whole number'],
    ['valun_offer_guarantee', 'deals', ['vd_1'], 'bad_arguments', 'deals must be 1 to 10 different deal ids (vd_ + 16 hex)'],
    ['valun_call_guarantee', 'amount', 'x', 'bad_arguments', 'amount must be a whole number of at least 1'],
    ['valun_check_payer', 'payer', 5, 'bad_arguments', 'payer must be the handle or participant id (text) of the agent that would owe you']];
  const w = world();
  for (const [name, k, v, error, message] of same) {
    assert.deepEqual(await w.agent.callSafe(name, {...SWEEP_BASE[name], [k]: v}), {error, message}, `${name} ${k}`);
  }
  const enums = schemas.ALL.flatMap(t => Object.entries(t.parameters.properties).filter(([, s]) => Array.isArray(s.enum)).map(([k]) => `${t.name} ${k}`));
  assert.deepEqual(enums.sort(), Object.entries(ENUM_REFUSALS).flatMap(([t, by]) => Object.keys(by).map(k => `${t} ${k}`)).sort());
  assert.deepEqual(await w.agent.callSafe('valun_set_limits', {max_total_owed: '60'}),
    {error: 'bad_arguments', message: 'max_total_owed must be a whole number (a JSON integer), not "60"; nothing was signed'});
  assert.deepEqual(await w.agent.callSafe('valun_deliver', {...SWEEP_BASE.valun_deliver, send_anyway: 'false'}),
    {error: 'bad_arguments', message: 'send_anyway must be true or false, not "false"; nothing was signed'});
  assert.deepEqual(await w.agent.callSafe('valun_set_limits', {goals: 42}),
    {error: 'bad_arguments', message: 'goals must be a string, not 42; nothing was signed'});
  assert.deepEqual(w.fetch.calls, [], 'nothing was read or recorded: valun_set_limits {"goals": 42} is not recorded either');
});

test('an amount\'s words are in the profile\'s unit', async () => {
  const {agent} = world(schemas.TESTNET);
  assert.equal((await agent.callSafe('valun_propose', {...SWEEP_BASE.valun_propose, price: '1000000'})).message,
    'price must be a whole number of nanoERG, at least 1 (a JSON integer), not "1000000"; nothing was signed');
  assert.equal((await agent.prepareOrRefusal('valun_check_payer', {payer: 'bob', amount: 2.5}))[1].message,
    'amount must be a whole number of nanoERG, at least 1 (a JSON integer), not 2.5; nothing was signed');
  assert.throws(() => toolArguments('valun_propose', {...SWEEP_BASE.valun_propose, price: true}), e => e.message.includes('a whole number of PC'),
    'without a unit: the pilot\'s');
  assert.deepEqual(agent.toolArguments('valun_deal', {deal_id: 'vd_' + '6a'.repeat(8)}), {deal_id: 'vd_' + '6a'.repeat(8)});
});

test('the adapters give the same refusal without asking, and prepare() refuses it with its code as the cause', async () => {
  const extra = [['valun_respond', 'action', 'Accept'], ['valun_review_delivery', 'decision', true], ['valun_propose', 'price', '15'],
    ['valun_offer_guarantee', 'deals', []]];
  for (const [tool, k, v] of [...BASIS_INTERNAL_ERRORS, ...PY_ONLY, ...extra]) {
    const args = {...SWEEP_BASE[tool], [k]: v};
    const want = await world().agent.callSafe(tool, args);
    const w = world();
    assert.deepEqual(await w.agent.prepareOrRefusal(tool, args), [null, want], `${tool} ${k}`);
    assert.deepEqual(w.fetch.calls, []);
    if (await world().agent.isCommitment(tool, args)) {
      const e = await world().agent.prepare(tool, args).then(() => null, x => x);
      assert.deepEqual([e?.code, e?.extra?.cause], ['approval_unbound', want.error], `${tool} ${k}`);
    }
  }
  for (const mode of ['none', 'ask']) {
    const w = world();
    const asked = [];
    const options = mode === 'none' ? {approvals: 'none'} : {approve: async text => { asked.push(text); return true; }};
    const tools = Object.fromEntries(valunTools(w.agent, options).map(t => [t.name, t]));
    for (const [tool, k, v] of [...BASIS_INTERNAL_ERRORS, ...PY_ONLY]) {
      const r = await tools[tool].execute({...SWEEP_BASE[tool], [k]: v});
      assert.equal(r.error, 'bad_arguments', `${mode} ${tool} ${k}`);
    }
    assert.deepEqual(asked, [], `${mode}: the owner is never asked`);
    assert.ok(w.fetch.calls.every(c => c.key === 'GET /pilot/v1/me'), `${mode}: nothing read but GET /me (valun_set_limits' classification)`);
  }
});

// The 0.7.2 review of fix inbox #58: null is not given wherever a tool has a default, and the hours of an offer are refused
// above the schema's maximum (the server's) before anything is read or signed. (A whole number written 40.0 is 40 here
// already: JSON.parse gives it as 40; the Python core takes it as 40 too.)
test('null is not given for valun_status brief and the guarantee hours', async () => {
  for (const args of [{brief: null}, {}, {brief: false}]) assert.ok(!('error' in await world().agent.callSafe('valun_status', args)), JSON.stringify(args));
  assert.equal((await world().agent.callSafe('valun_status', {brief: 'no'})).message, 'brief must be true or false');
  const offer = {...SWEEP_BASE.valun_offer_guarantee, issuer: 'bob', creditor: 'bob', callable_for_hours: null, honor_within_hours: null};
  const r = await world().agent.callSafe('valun_offer_guarantee', offer);
  assert.ok(!/is required/.test(r.message ?? ''), r.message);
  assert.equal((await world().agent.callSafe('valun_offer_guarantee', {...offer, callable_for_hours: 1.5})).error, 'bad_arguments');
});

test('the hours of an offer are at most the schema\'s maximum, refused before anything is read', async () => {
  for (const tool of [schemas.PROPOSE, schemas.RESPOND]) {
    const props = tool.parameters.properties;
    assert.deepEqual(Object.fromEntries(Object.keys(HOURS_MAX).map(k => [k, props[k].maximum])), {...HOURS_MAX}, tool.name);
  }
  const counter = {deal_id: 'vd_' + '0'.repeat(16), action: 'counter'};
  for (const [k, v] of [['deliver_within_hours', 721], ['offer_valid_hours', 169], ['deliver_within_hours', 70_000_000], ['offer_valid_hours', 10 ** 15]]) {
    const want = {error: 'bad_arguments', message: `${k} must be at most ${HOURS_MAX[k]} hours (${HOURS_MAX[k] / 24} days, the most the server `
      + `takes), not ${v}; nothing was signed`};
    for (const [tool, args] of [['valun_propose', SWEEP_BASE.valun_propose], ['valun_respond', counter]]) {
      const w = world();
      assert.deepEqual(await w.agent.callSafe(tool, {...args, [k]: v}), want, `${tool} ${k}=${v}`);
      assert.deepEqual(w.fetch.calls, [], 'refused before anything is read');
    }
  }
  assert.equal((await world().agent.callSafe('valun_propose', {...SWEEP_BASE.valun_propose, deliver_within_hours: 720, offer_valid_hours: 168})).error,
    'unknown_participant', 'at the maximum it is the tool\'s own business as before');
});
