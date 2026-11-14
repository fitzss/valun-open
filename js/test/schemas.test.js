// The tool definitions equal python/src/valun/schemas.py value for value (fixtures/schemas-python.json is Python's own
// json.dumps of schemas.ALL), and the adapter hands frameworks copies of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {READ_ONLY_TOOLS, TOOL_NAMES, schemas} from '../src/index.js';

const PY_ALL = JSON.parse(fs.readFileSync(new URL('./fixtures/schemas-python.json', import.meta.url), 'utf8'));
const PY = PY_ALL.tools;

test('the tool definitions are exactly Python schemas.ALL (names, descriptions, JSON Schemas, key order)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(schemas.ALL)), PY);
  assert.equal(JSON.stringify(schemas.ALL), JSON.stringify(PY));
  // 0.5.2 (fix inbox #15): the testnet's tools in its own words, exactly Python schemas.for_network('valun-testnet-1')
  assert.equal(JSON.stringify(schemas.forNetwork(schemas.TESTNET)), JSON.stringify(PY_ALL.tools_testnet));
  assert.equal(schemas.forNetwork(null), schemas.ALL);
  assert.equal(schemas.forNetwork('valun-pilot-1'), schemas.ALL);
  assert.doesNotMatch(JSON.stringify(schemas.forNetwork(schemas.TESTNET)), /\bPC\b|pilot/);
  assert.deepEqual(TOOL_NAMES, PY.map(t => t.name));
  const byName = {STATUS: 'valun_status', DIRECTORY: 'valun_directory', INBOX: 'valun_inbox', DEAL: 'valun_deal', PROPOSE: 'valun_propose',
    RESPOND: 'valun_respond', DELIVER: 'valun_deliver', REVIEW: 'valun_review_delivery', SET_LIMITS: 'valun_set_limits',
    GUARANTEES: 'valun_guarantees', OFFER_GUARANTEE: 'valun_offer_guarantee', RESPOND_GUARANTEE: 'valun_respond_guarantee',
    CALL_GUARANTEE: 'valun_call_guarantee', CHECK_PAYER: 'valun_check_payer'};
  for (const [k, name] of Object.entries(byName)) assert.equal(schemas[k].name, name);
  assert.equal(schemas.ALL.length, 14);
  assert.deepEqual([...READ_ONLY_TOOLS], ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_guarantees',
    'valun_check_payer']);
});

test('every definition is a JSON Schema object whose required fields exist, and the exported definitions are frozen', () => {
  for (const t of schemas.ALL) {
    assert.equal(t.parameters.type, 'object', t.name);
    for (const r of t.parameters.required) assert.ok(r in t.parameters.properties, `${t.name}.${r}`);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.parameters) && Object.isFrozen(t.parameters.properties), t.name);
  }
  assert.ok(Object.isFrozen(schemas.ALL));
  assert.throws(() => { 'use strict'; schemas.PROPOSE.parameters.required.push('x'); }, TypeError);
});
