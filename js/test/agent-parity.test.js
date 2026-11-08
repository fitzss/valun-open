// The JavaScript agent tools against the Python reference: every scenario recorded by
// test/fixtures/generate_python_fixtures.py (the Python ValunAgent over the same server responses, clock, ids and DNS
// table) is replayed here. Results must be equal value for value and key for key (key order included), the requests
// the same (bodies without signatures), every signature sent must verify over exactly the bytes Python signed for that
// request, the client's state afterwards must be the same (signatures aside, and those must be ones the client sent),
// and so must is_commitment(), prepare() (the arguments it binds and the approval text, or the refusal and its cause),
// prepare_or_refusal(), describe_commitment() and bind(). Offline: the server is a fake fetch.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FIX, KEYS, json, outcome, requests, signaturesIn, signedRequests, unsigned, world} from './agent-world.js';
import {TOOL_NAMES, basis, bytesToHex, hexToBytes} from '../src/index.js';

const SECRETS = [FIX.token, ...Object.values(KEYS).map(k => bytesToHex(k.secret))];
const same = (got, want, what) => {
  assert.deepEqual(got, want, what);
  assert.equal(JSON.stringify(got), JSON.stringify(want), `${what}: same keys in the same order`);
};

test(`agent tools: ${FIX.scenarios.length} scenarios give the Python reference's results, requests, signatures and approval texts`, async t => {
  for (const sc of FIX.scenarios) {
    await t.test(sc.name, async () => {
      // the call itself
      const w = world(sc);
      const result = json(await w.agent.callSafe(sc.tool, sc.args));
      same(result, sc.result, 'result');
      assert.deepEqual(requests(w.fetch), sc.requests, 'requests (signatures aside)');
      const signed = signedRequests(w.fetch);
      assert.deepEqual(signed.map(s => s.key), sc.signed.map(s => s.key), 'the requests that carry signatures');
      signed.forEach((s, i) => {
        const want = sc.signed[i].signed;
        assert.equal(s.signatures.length, want.length, `${s.key}: as many signatures as Python sent`);
        s.signatures.forEach((sig, j) => assert.ok(basis.verifyHex(sig, hexToBytes(want[j].message_hex), want[j].pubkey),
          `${s.key}: signature ${j} is over exactly the bytes Python signed (${want[j].message_hex.slice(0, 24)}...)`));
      });
      const state = json(w.store.state);
      assert.deepEqual(unsigned(state), sc.state_after, 'state afterwards (signatures aside)');
      const known = new Set([...signed.flatMap(s => s.signatures), ...signaturesIn(sc.state ?? {})]);
      for (const sig of signaturesIn(state)) assert.ok(known.has(sig), 'a signature in the records is one the client sent (or had)');
      for (const s of SECRETS) assert.ok(!JSON.stringify(result).includes(s) && !JSON.stringify(state).includes(s), 'no secret in the result or state');

      let commits;
      try {
        commits = await world(sc).agent.isCommitment(sc.tool, sc.args);
      } catch (e) {
        commits = {raises: e.name};
      }
      assert.deepEqual(commits, sc.is_commitment, 'isCommitment');

      // what an adapter does before asking the owner: one read binds and describes (or refuses)
      const p = world(sc);
      same(json(await outcome(() => p.agent.prepare(sc.tool, sc.args))), sc.prepare, 'prepare');
      assert.deepEqual(requests(p.fetch), sc.prepare_requests, 'prepare reads');
      assert.equal(posts(p), 0, 'prepare sends nothing');
      same(json(await world(sc).agent.prepareOrRefusal(sc.tool, sc.args)), sc.prepare_or_refusal, 'prepareOrRefusal');
      if (sc.is_commitment !== true) return;
      same(json(await outcome(() => world(sc).agent.describeCommitment(sc.tool, sc.args))), sc.describe, 'describeCommitment');
      const b = world(sc);
      const bound = json(await outcome(() => b.agent.bind(sc.tool, sc.args)));
      same(bound, sc.bound, 'bind');
      assert.deepEqual(requests(b.fetch), sc.bind_requests, 'bind reads');
      if ('value' in sc.bound) {
        same(json(await outcome(() => world(sc).agent.describeCommitment(sc.tool, sc.bound.value))), sc.describe_bound, 'describe the bound arguments');
      }
    });
  }
});

function posts(w) {
  return w.fetch.calls.filter(c => !c.key.startsWith('GET ')).length;
}

test('the recorded scenarios cover every tool, every commitment kind and the main error and refusal codes', () => {
  const tools = new Set(FIX.scenarios.map(s => s.tool));
  for (const name of TOOL_NAMES) assert.ok(tools.has(name), name);
  assert.ok(FIX.scenarios.some(s => !TOOL_NAMES.includes(s.tool) && s.is_commitment === true), 'an unknown tool is a commitment');
  const errors = new Set(FIX.scenarios.map(s => s.result.error).filter(Boolean));
  for (const code of ['not_connected', 'unauthorized', 'unknown_tool', 'internal_error', 'not_found', 'missing_text', 'unknown_participant',
    'mandate_exceeded', 'bad_role', 'stale_terms', 'bad_signature', 'reason_required', 'bad_action', 'offer_not_authorized',
    'draft_does_not_meet_terms', 'not_agreed', 'stale_delivery', 'nothing_to_record', 'bad_decision', 'hash_mismatch',
    'bad_delivery_signature', 'ledger_mismatch', 'already_paid', 'bad_prior_signature', 'bad_template', 'tracker_mismatch',
    'stale_note']) assert.ok(errors.has(code), code);
  const causes = new Set(FIX.scenarios.map(s => s.prepare.cause).filter(Boolean));
  for (const cause of ['hash_mismatch', 'role_mismatch', 'counterparty_mismatch', 'own_offer', 'not_payer', 'stale_terms', 'stale_delivery',
    'bad_arguments', 'not_connected', 'not_found', 'approval_unbound', 'KeyError', 'ValueError']) assert.ok(causes.has(cause), `prepare refuses: ${cause}`);
  const texts = FIX.scenarios.filter(s => typeof s.prepare.value?.text === 'string');
  assert.ok(texts.length >= 30, 'approval texts recorded');
  assert.ok(texts.some(s => s.prepare.value.text.startsWith('Valun: sign a commitment (')), 'the generic text, for an unknown tool');
  assert.ok(texts.some(s => /fields over 2000 characters are cut/.test(s.prepare.value.text)), 'a cut field');
  assert.ok(FIX.scenarios.some(s => s.tool === 'valun_set_limits' && s.prepare.value && s.prepare.value.text === null),
    'a limits call whose read shows nothing loosened: nothing to approve');
  const pinned = FIX.scenarios.filter(s => s.bound?.value && JSON.stringify(s.bound.value) !== JSON.stringify(s.args ?? {}));
  assert.ok(pinned.some(s => s.bound.value.expected_terms_hash) && pinned.some(s => s.bound.value.expected_deliverable_sha256), 'bind() pins both kinds');
  // 0.3.1 asked with a "WARNING: the offer changed" text when the agent's pin was stale; since 0.4 prepare() refuses.
  assert.ok(FIX.scenarios.some(s => s.args?.expected_terms_hash && s.prepare.cause === 'stale_terms'), 'a stale pin is refused, not asked about');
  assert.ok(FIX.scenarios.some(s => s.signed.some(r => r.signed.length === 2)), 'a request with two signatures (statement and note)');
  assert.ok(FIX.scenarios.some(s => s.requests.some(r => r.key.endsWith('?prior=1'))), 'a bound-notes template request');
});
