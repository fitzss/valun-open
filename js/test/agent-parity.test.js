// The JavaScript agent tools against the Python reference: every scenario recorded by
// test/fixtures/generate_python_fixtures.py (the Python ValunAgent over the same server responses, clock, ids and DNS
// table) is replayed here. Results must be equal value for value and key for key (key order included), the requests
// the same (bodies without signatures), the client's state afterwards the same, and so must is_commitment() and the
// approval text of describe_commitment(). Offline: the server is a fake fetch.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FIX, KEYS, json, requests, world} from './agent-world.js';
import {bytesToHex} from '../src/index.js';

const SECRETS = [FIX.token, ...Object.values(KEYS).map(k => bytesToHex(k.secret))];

test(`agent tools: ${FIX.scenarios.length} scenarios give the Python reference's results, requests and approval texts`, async t => {
  for (const sc of FIX.scenarios) {
    await t.test(sc.name, async () => {
      const w = world(sc);
      const result = json(await w.agent.callSafe(sc.tool, sc.args));
      assert.deepEqual(result, sc.result);
      assert.equal(JSON.stringify(result), JSON.stringify(sc.result), 'same keys in the same order');
      assert.deepEqual(requests(w.fetch), sc.requests);
      assert.deepEqual(json(w.store.state), sc.state_after);
      for (const s of SECRETS) assert.ok(!JSON.stringify(result).includes(s), 'no secret in the result');

      let commits;
      try {
        commits = await world(sc).agent.isCommitment(sc.tool, sc.args);
      } catch (e) {
        commits = {raises: e.name};
      }
      assert.deepEqual(commits, sc.is_commitment);
      if (sc.is_commitment !== true) return;
      assert.equal(await world(sc).agent.describeCommitment(sc.tool, sc.args), sc.describe);
      // what an adapter does before asking the owner: bind, then describe the bound arguments
      const b = world(sc);
      const bound = await b.agent.bind(sc.tool, sc.args);
      assert.equal(JSON.stringify(json(bound)), JSON.stringify(sc.bound));
      assert.deepEqual(requests(b.fetch), sc.bind_requests);
      assert.equal(await world(sc).agent.describeCommitment(sc.tool, bound), sc.describe_bound);
    });
  }
});

test('the recorded scenarios cover all nine tools, every commitment kind and the main error codes', () => {
  const tools = new Set(FIX.scenarios.map(s => s.tool));
  for (const name of ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond', 'valun_deliver',
    'valun_review_delivery', 'valun_set_limits']) assert.ok(tools.has(name), name);
  const errors = new Set(FIX.scenarios.map(s => s.result.error).filter(Boolean));
  for (const code of ['not_connected', 'unauthorized', 'unknown_tool', 'internal_error', 'not_found', 'missing_text', 'unknown_participant',
    'mandate_exceeded', 'bad_role', 'stale_terms', 'bad_signature', 'reason_required', 'bad_action', 'offer_not_authorized',
    'draft_does_not_meet_terms', 'not_agreed', 'stale_delivery', 'nothing_to_record', 'bad_decision']) assert.ok(errors.has(code), code);
  assert.ok(FIX.scenarios.filter(s => s.describe).length >= 15, 'approval texts recorded');
  const pinned = FIX.scenarios.filter(s => s.bound && JSON.stringify(s.bound) !== JSON.stringify(s.args ?? {}));
  assert.ok(pinned.some(s => s.bound.expected_terms_hash) && pinned.some(s => s.bound.expected_deliverable_sha256), 'bind() pins both kinds');
  assert.ok(FIX.scenarios.some(s => /WARNING: the offer changed/.test(s.describe_bound || '')), 'the changed-offer warning is recorded');
});
