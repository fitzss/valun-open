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
import {NEVER_APPLIED_TRANSFER, TOOL_NAMES, basis, bytesToHex, hexToBytes} from '../src/index.js';

const SECRETS = [FIX.token, ...Object.values(KEYS).map(k => bytesToHex(k.secret))];
const same = (got, want, what) => {
  assert.deepEqual(got, want, what);
  assert.equal(JSON.stringify(got), JSON.stringify(want), `${what}: same keys in the same order`);
};

/**
 * The answers of the routes that show edge states (with their issuers' signatures), and only those: GET /edges, a bound
 * credit-note template (the prior state of my edge) and a transfer template (the state of the note I pay with).
 */
const EDGE_STATE_ROUTE = /^GET \/pilot\/v1\/(edges(\?|$)|deals\/[^/?]+\/(credit-note-template|transfer-template)(\?|$))/;
const edgeRoutes = routes => Object.entries(routes ?? {}).filter(([k]) => EDGE_STATE_ROUTE.test(k)).map(([, v]) => v);

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
      // a signature in the records is one the client sent, had, or read in an edge state the server showed (edgeRoutes)
      const known = new Set([...signed.flatMap(s => s.signatures), ...signaturesIn(sc.state ?? {}), ...signaturesIn(edgeRoutes(sc.routes)),
        ...signaturesIn(edgeRoutes(FIX.base_routes))]);
      for (const sig of signaturesIn(state)) assert.ok(known.has(sig), 'a signature in the records is one the client sent, had or read');
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
    'bad_arguments', 'not_connected', 'not_found', 'approval_unbound', 'ValueError']) assert.ok(causes.has(cause), `prepare refuses: ${cause}`);
  // fix inbox #58: a missing argument is bad_arguments, never a KeyError (internal_error), in the tools and in prepare()
  assert.ok(!causes.has('KeyError') && !FIX.scenarios.some(s => /KeyError/.test(s.result.message ?? '')), 'no KeyError left');
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
  assert.ok(FIX.scenarios.some(s => s.requests.some(r => r.key.endsWith('?prior=1&bound=1'))), 'a bound-notes template request');
});

test('the recorded scenarios cover circulating credit: pay_with, bound notes, exact_result, consents and the D-1/D-2/D-3 decisions', () => {
  const S = FIX.scenarios;
  const errors = new Set(S.map(s => s.result.error).filter(Boolean));
  for (const code of ['feature_unavailable', 'unknown_issuer', 'stale_claim', 'stale_quote', 'not_exact_service', 'transfer_window_open',
    'bound_note_required', 'issuer_refused', 'bad_arguments', 'already_paid', 'bad_prior_signature', 'ledger_mismatch']) {
    assert.ok(errors.has(code), code);
  }
  const statuses = new Set(S.map(s => s.result.status).filter(Boolean));
  for (const st of ['paid_by_transfer', 'paying_by_transfer', 'payment_due', 'note_issued', 'delivered']) assert.ok(statuses.has(st), st);
  // pay_with: the owner is asked with the PAY text, and the arguments pin the issuer, the quote and my claim on it
  const pay = S.filter(s => s.prepare.value?.text?.startsWith('Valun - PAY '));
  assert.ok(pay.length > 0, 'a PAY approval text');
  assert.ok(pay.every(s => s.prepare.value.args.expected_quote_digest && Number.isInteger(s.prepare.value.args.expected_claim_total)));
  assert.ok(S.some(s => s.signed.some(r => r.key.endsWith('/pay-by-transfer') && r.signed.length === 5)), 'a payment by transfer: 5 signatures');
  assert.ok(S.some(s => s.signed.some(r => r.key.endsWith('/complete') && r.signed.length === 3)), 'a bound note: statement, note, prior');
  // D-1: one GET /edges read-back before refusing transfer_window_open; D-2 h: no consent request without circulation
  assert.ok(S.some(s => s.tool === 'valun_review_delivery' && s.result.status === 'note_issued'
    && s.requests.some(r => r.key.startsWith('GET /pilot/v1/edges'))), 'a payment after one GET /edges read-back');
  assert.ok(S.some(s => s.state.consent_policy && !s.requests.some(r => r.key === 'GET /pilot/v1/consents')
    && s.requests.some(r => r.key === 'GET /pilot/v1/info')), 'a consent run that stops at /info');
  // D-3 a: consents signed before a read-only tool are reported; D-3 b: the empty roles header once, then the record of it
  assert.ok(S.some(s => s.result.consents_signed_now?.length > 0), 'consents_signed_now');
  assert.ok(S.some(s => s.requests.some(r => r.features === 'consents/1;roles=') && s.state_after.consent_roles_declared === ''));
  assert.ok(S.some(s => s.requests.some(r => r.features === 'consents/1;roles=setoff,issuer,creditor')));
  assert.ok(S.some(s => s.state_after.consent_log?.some(e => e.decision === 'refused')), 'a refused consent');
  assert.ok(S.some(s => s.result.exact_result?.service === 'text-stats'), 'exact_result delivered');
  assert.ok(S.some(s => s.result.sandbox_next_steps?.next_calls?.length > 0), 'sandbox tour next calls');
  assert.ok(S.some(s => s.result.notes_you_can_spend?.some(n => n.checked_by_your_client === true)), 'a note checked against GET /edges');
  assert.ok(S.some(s => s.result.how_you_can_pay?.options?.length > 1), 'how_you_can_pay');
});

// ---- Client methods of circulating credit the tools do not reach (edge sync, payment attempts, consents, retries) ----
const CALL = {
  sync_edges: (c, k) => c.syncEdges({nowMs: k.now_ms ?? null}),
  payment_attempts: (c, k) => c.paymentAttempts({edges: k.edges ?? null, nowMs: k.now_ms ?? null, doubtful: k.doubtful ?? null}),
  attempts_overview: (c, k) => c.attemptsOverview({edges: k.edges ?? null, nowMs: k.now_ms ?? null, doubtful: k.doubtful ?? null}),
  resolution_plan: (c, k) => c.resolutionPlan(k.deal_id, k.attempt, {edges: k.edges ?? null, nowMs: k.now_ms ?? null, doubtful: k.doubtful ?? null}),
  resolve_attempt: (c, k) => c.resolveAttempt(k.deal_id, k.attempt, k.outcome, k.owner_token, {note: k.note ?? null,
    localOnly: k.local_only ?? false, edges: k.edges ?? null, nowMs: k.now_ms ?? null, doubtful: k.doubtful ?? null,
    ...('expected_attempt' in k ? {expectedAttempt: k.expected_attempt} : {})}),
  cancel_transfer: (c, k) => c.cancelTransfer(k.deal_id),
  process_consents: (c, k) => c.processConsents({policy: k.policy ?? null, nowMs: k.now_ms ?? null, valueSafeOnly: k.value_safe_only ?? false}),
  refuse_consent: (c, k) => c.refuseConsent(k.consent_id, k.reason ?? null),
  pay_by_transfer: (c, k) => c.payByTransfer(k.deal_id, k.issuer, {expectedDeliverableSha256: k.expected_deliverable_sha256,
    expectedQuoteDigest: k.expected_quote_digest, expectedClaimTotal: k.expected_claim_total}),
  // budget cards
  resolve_participant: (c, k) => c.resolveParticipant(k.who),
  card: (c, k) => c.card(k.who),
  check_payer: (c, k) => c.checkPayer(k.payer, k.amount, {payee: k.payee ?? null}),
  set_public_card: (c, k) => c.setPublicCard(k.on, k.owner_token),
};

test(`client methods: ${FIX.client_scenarios.length} scenarios give the Python reference's results, requests, signatures and records`, async t => {
  assert.ok(FIX.client_scenarios.length >= 30);
  for (const sc of FIX.client_scenarios) {
    await t.test(sc.name, async () => {
      assert.ok(Object.hasOwn(CALL, sc.method), `a mapping for Client.${sc.method}`);
      const w = world(sc);
      same(json(await outcome(() => CALL[sc.method](w.client, sc.kwargs))), sc.result, 'result');
      assert.deepEqual(requests(w.fetch), sc.requests, 'requests (signatures aside) and their X-Valun-Features headers');
      const signed = signedRequests(w.fetch);
      assert.deepEqual(signed.map(s => s.key), sc.signed.map(s => s.key), 'the requests that carry signatures');
      signed.forEach((s, i) => {
        const want = sc.signed[i].signed;
        assert.equal(s.signatures.length, want.length, `${s.key}: as many signatures as Python sent`);
        s.signatures.forEach((sig, j) => assert.ok(basis.verifyHex(sig, hexToBytes(want[j].message_hex), want[j].pubkey),
          `${s.key}: signature ${j} is over exactly the bytes Python signed`));
      });
      assert.deepEqual(unsigned(json(w.store.state)), sc.state_after, 'records afterwards (signatures aside)');
    });
  }
  const methods = new Set(FIX.client_scenarios.map(s => s.method));
  for (const m of Object.keys(CALL)) assert.ok(methods.has(m), `a scenario for ${m}`);
});

// valun-app SV-AUTH-1: the server answers 'applied' with 409 payee_edge_not_applied {payee_edge} while the payee's edge on
// the tracker does not show the transfer. resolveAttempt says why and what to do instead (the scenarios above compare the
// message with Python's), with the same extra, offers no resolution in the records only and records nothing.
test('resolveAttempt: a 409 payee_edge_not_applied says why and what to do instead, and records nothing', async () => {
  const scs = FIX.client_scenarios.filter(s => s.name.startsWith("resolve_attempt: applied, refused while the payee's edge"));
  assert.equal(scs.length, 2);
  for (const sc of scs) {
    const w = world(sc);
    const e = await CALL.resolve_attempt(w.client, sc.kwargs).then(() => null, x => x);
    assert.equal(e?.name, 'ValunError', sc.name);
    const edge = sc.routes[Object.keys(sc.routes).find(k => k.endsWith('/resolve'))].body.payee_edge ?? null;
    assert.deepEqual([e.code, e.status], ['payee_edge_not_applied', 409]);
    same(json(e.extra), {payee_edge: edge, next_steps: ['not_applied', 'ask_operator'], local_possible: false,
      server: {error: 'payee_edge_not_applied', message: "the payee's edge does not show this transfer"}}, 'extra');
    assert.match(e.message, edge === 'moved_past' ? /moved past the transfer's timestamp at its earlier total/
      : /the server did not say how it reads the payee's edge/);
    assert.match(e.message, /resolve it as not applied; if the payee says it arrived, ask the operator/);
    assert.deepEqual(unsigned(json(w.store.state)), sc.state_after, 'records unchanged, as in Python');
    assert.ok(!JSON.stringify(w.store.state).includes('paid_deals') && !JSON.stringify(w.store.state).includes('"outcome"'));
  }
});

// 0.4.1 (readiness R-22): an attempt the records cannot prove dead ('unknown'), whose transfer the server ended before it
// ever reached the tracker, is shown as ended there (ended_at_server); a state that proves nothing leaves it as it was.
// Display only: nothing is recorded and the classification R11 uses is the same.
test('attemptsOverview (R-22): ended_at_server only for the states that prove the transfer never reached the tracker', async () => {
  const scs = FIX.client_scenarios.filter(s => s.name.startsWith('attempts_overview: R-22, the earlier attempt the server holds as '));
  assert.equal(scs.length, 9);
  const ended = {void_rejected: true, cancelled: true, expired: true, refused: true, failed: false, outcome_unknown: false,
    resolved_not_applied: false, applied: false, collecting: false};
  assert.deepEqual([...NEVER_APPLIED_TRANSFER].sort(), ['cancelled', 'expired', 'refused', 'void_expired', 'void_key_revoked',
    'void_rejected', 'void_stale']);
  for (const sc of scs) {
    const state = sc.name.split(' ').pop();
    const w = world(sc);
    const read = {edges: sc.kwargs.edges, doubtful: sc.kwargs.doubtful};
    const before = json(w.store.state);
    const plain = w.client.paymentAttempts(read);
    const rows = await w.client.attemptsOverview(read);
    assert.deepEqual(rows.map(r => [r.ref, r.state, r.paid, r.ended_at_server]),
      [['#1', 'unknown', false, ended[state] ? state : null], ['#2', 'alive', false, null], ['#1', 'applied', true, null]], state);
    assert.equal(NEVER_APPLIED_TRANSFER.includes(state), ended[state], state);
    assert.deepEqual(rows.map(({ended_at_server: _e, ...r}) => r), plain, `${state}: the classification R11 uses is unchanged`);
    assert.deepEqual(json(w.store.state), before, `${state}: nothing recorded`);
    assert.deepEqual(w.fetch.calls.map(c => c.key), ['GET /pilot/v1/info', 'GET /pilot/v1/transfers/vt_3c3c3c3c3c3c3c3c']);
    // the plan for the attempt shows it the same way, reading the transfer once (a live one can still apply: refused)
    const p = world(sc);
    const plan = await outcome(() => p.client.resolutionPlan(rows[0].deal_id, '#1', read));
    if (state === 'collecting') assert.equal(plan.code, 'attempt_in_progress');
    else assert.equal(plan.value.attempt.ended_at_server, ended[state] ? state : null, `plan: ${state}`);
    assert.equal(p.fetch.calls.filter(c => c.key.startsWith('GET /pilot/v1/transfers/')).length, 1, `plan: ${state}: read once`);
  }
});

// What is signed is unchanged: an earlier attempt of mine (its window open) that the server shows as void_rejected still
// holds back a payment on another state of my claim (transfer_window_open), and the same state of my claim is signed at once
// (the same-prior exemption), as without that word; paying never reads GET /transfers.
test('payByTransfer after an attempt the server says it ended: R11 waits for the window, the same-prior exemption stands', async () => {
  const pick = part => FIX.client_scenarios.find(s => s.name.startsWith('pay_by_transfer: after an attempt the server says it '
    + `ended (void_rejected), ${part}`));
  const waits = world(pick('another state of my claim waits'));
  const e = await waits.client.payByTransfer(pick('another state').kwargs.deal_id, 'frank').then(() => null, x => x);
  assert.equal(e?.code, 'transfer_window_open');
  assert.ok(e.extra.retry_after_ms > 3_600_000 - 180_000, 'about an hour to wait');
  assert.ok(!waits.fetch.calls.some(c => c.key.startsWith('POST ') || c.key.startsWith('GET /pilot/v1/transfers/')));
  const same = world(pick('the same state of my claim is signed'));
  const r = await same.client.payByTransfer(pick('the same state').kwargs.deal_id, 'frank');
  assert.equal(r.status, 'paid_by_transfer');
  assert.ok(same.fetch.calls.some(c => c.key.endsWith('/pay-by-transfer')));
  assert.ok(!same.fetch.calls.some(c => c.key.startsWith('GET /pilot/v1/transfers/')));
});
