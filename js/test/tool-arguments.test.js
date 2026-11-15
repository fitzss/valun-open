// Fix inbox #58, the sweep, the JavaScript twin of python/tests/test_tool_arguments.py: every tool, called with no
// arguments ({}, null or undefined) and with arguments that are not a JSON object, answers bad_arguments naming each
// argument its schema requires, before anything is read or signed, or, for a tool that requires none, what it answers for
// {}; never internal_error. It is checked once, where every call comes in (ValunAgent.call, toolArguments), and through
// the adapters: prepareOrRefusal() (the refusal it returns instead of asking the owner) and valunTools() in each mode.
// Offline: a fake fetch. The 'arguments:' scenarios of agent-parity.test.js compare the same calls with Python, value for
// value.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  ARGUMENT_WORDS, ARGUMENT_WORDS_OF, Client, LIMIT_TOOLS, MemoryStore, NETWORK, READ_ONLY_TOOLS, REQUIRED_ARGUMENTS, SIGNING_TOOLS,
  TOOL_NAMES, ValunAgent, ValunError, schemas, toolArguments, valunTools,
} from '../src/index.js';
import {fakeFetch} from './helpers.js';

const BASE = 'http://valun.invalid';
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

function world() {
  const fetch = fakeFetch(ROUTES, BASE);
  const client = new Client({server: BASE, fetch,
    store: new MemoryStore({state: {server: BASE, participant_id: ME, pubkey: '02' + '11'.repeat(32)}, secret: '11'.repeat(32), token: 'vpa_test-agent'})});
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
