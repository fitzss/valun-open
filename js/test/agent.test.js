// ValunAgent: the safety checks spelled out (what is refused before anything is signed or sent: bad_decision, the
// deliver gate, the missing-text guard, fail-closed classification and binding), host checks with and without a DNS
// resolver, and that callSafe() never rejects. Results equal to Python's are checked scenario by scenario in
// agent-parity.test.js; prepare() and the records in records.test.js. Offline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client, MemoryStore, TOOL_NAMES, ValunAgent, ValunError, measure, sandbox} from '../src/index.js';
import {FIX, ID, T0, posts, scenario, world} from './agent-world.js';

const routesOf = name => scenario(name).routes;
const dealId = name => scenario(name).args.deal_id;

test('every tool runs through call() and callSafe(); call() rejects with ValunError, callSafe() resolves to {error}', async () => {
  const {agent} = world();
  const st = await agent.call('valun_status');
  assert.equal(st.connected, true);
  assert.equal(st.you.handle, 'alice');
  await assert.rejects(agent.call('valun_nope', {}), e => e instanceof ValunError && e.code === 'unknown_tool');
  await assert.rejects(agent.call('valun_deal', {}), e => e.name === 'KeyError' && e.message === "'deal_id'");
  assert.deepEqual(await agent.callSafe('valun_deal', {}), {error: 'internal_error', message: "KeyError: 'deal_id'"});
  assert.deepEqual(Object.keys(agent.handlers), [...TOOL_NAMES]);
});

test('callSafe() never rejects: a fetch that throws, a server that answers garbage, a store that fails', async () => {
  const store = new MemoryStore({state: {server: FIX.base, participant_id: ID.alice, pubkey: 'ab'}, secret: '11'.repeat(32), token: 't'});
  const boom = async () => { throw new Error('socket hang up'); };
  const a = new ValunAgent(new Client({store, fetch: boom}));
  for (const name of Object.keys(a.handlers)) {
    const r = await a.callSafe(name, {deal_id: 'vd_1', counterparty: 'bob', action: 'accept', decision: 'accept', content: 'x', max_total_owed: 5});
    assert.equal(typeof r.error, 'string', name);
  }
  assert.equal((await a.callSafe('valun_status')).error, 'unreachable');
  const garbage = async () => new Response('<html>', {status: 200});
  const b = new ValunAgent(new Client({store, fetch: garbage}));
  assert.equal((await b.callSafe('valun_inbox')).error, 'bad_response');
  const nullBody = async () => new Response('null', {status: 200});
  const c = new ValunAgent(new Client({store, fetch: nullBody}));
  assert.equal((await c.callSafe('valun_status')).error, 'internal_error');
  assert.throws(() => new ValunAgent(null), TypeError);
  assert.throws(() => new ValunAgent({}), TypeError);
  assert.throws(() => new ValunAgent(new Client({store}), {resolveHost: 'dns'}), TypeError);
});

test('deliver gate: a draft that misses the measured terms is not signed or sent, and the payer-side numbers come back', async () => {
  const w = world({routes: routesOf('deliver: gate refuses a short draft')});
  const r = await w.agent.callSafe('valun_deliver', {deal_id: dealId('deliver: gate refuses a short draft'), content: 'Too short: only a few words here.'});
  assert.equal(r.error, 'draft_does_not_meet_terms');
  assert.match(r.message, /^Not sent\. .*at least 150 words: measured 7 words/);
  assert.deepEqual(r.measured.checks_against_agreed_terms, [{requirement: 'at least 150 words', measured: '7 words', met: false}]);
  assert.equal(posts(w.fetch).length, 0, 'nothing sent');
  // made-up link hosts count as problems too (DNS answers from the recorded table)
  const sc = scenario('deliver: gate refuses made-up and missing link hosts');
  const w2 = world(sc);
  const r2 = await w2.agent.callSafe(sc.tool, sc.args);
  assert.equal(r2.error, 'draft_does_not_meet_terms');
  assert.match(r2.message, /made-up-source\.invalid/);
  assert.equal(r2.measured.link_hosts['intranet.example'], 'private');
  assert.equal(posts(w2.fetch).length, 0);
  // send_anyway signs and sends the same draft
  const w3 = world({routes: routesOf('deliver: send_anyway')});
  const r3 = await w3.agent.callSafe('valun_deliver', {deal_id: dealId('deliver: send_anyway'), content: 'Too short: only a few words here.', send_anyway: true});
  assert.equal(r3.status, 'delivered');
  assert.deepEqual(posts(w3.fetch).map(c => c.key), [`POST /pilot/v1/deals/${dealId('deliver: send_anyway')}/deliver`]);
});

test('missing-text guard: an offer to a seller of exactly checkable work without the text is refused before signing', async () => {
  const sc = scenario('propose: sandbox seller without the text');
  const w = world(sc);
  const r = await w.agent.callSafe(sc.tool, sc.args);
  assert.equal(r.error, 'missing_text');
  assert.match(r.message, /^Not signed\. sandbox-exact needs the text to process inside the description/);
  assert.equal(posts(w.fetch).length, 0, 'nothing signed or sent');
  const ok = scenario('propose: sandbox seller with the text in a fence');
  const w2 = world(ok);
  assert.equal((await w2.agent.callSafe(ok.tool, ok.args)).status, 'open');
  assert.deepEqual(posts(w2.fetch).map(c => c.key), ['POST /pilot/v1/deals']);
  assert.equal(posts(w2.fetch)[0].body.terms.service.description, ok.args.description);
});

test('exact check: valun_deal recomputes a text-stats result; a match says so, a mismatch advises a dispute', async () => {
  const right = scenario('deal: sandbox result matches');
  const a = await world(right).agent.call(right.tool, right.args);
  assert.equal(a.delivery.checked_exactly_by_your_client.exact_result_matches, true);
  assert.deepEqual(a.delivery.checked_exactly_by_your_client.differs_in, []);
  assert.equal(a.delivery.advice, undefined);
  const wrong = scenario('deal: sandbox result wrong');
  const b = await world(wrong).agent.call(wrong.tool, wrong.args);
  const exact = b.delivery.checked_exactly_by_your_client;
  assert.equal(exact.exact_result_matches, false);
  assert.deepEqual(exact.differs_in, ['unique_words', 'words']);
  assert.deepEqual(exact.expected, {unique_words: 5, words: 7});
  assert.deepEqual(exact.delivered, {unique_words: 6, words: 8});
  assert.match(b.delivery.advice, /differs in: unique_words, words\)\. Dispute it/);
  // the approval text for accepting it says so too
  const text = await world(wrong).agent.describeCommitment('valun_review_delivery', {deal_id: wrong.args.deal_id, decision: 'accept'});
  assert.match(text, /exact result: DOES NOT MATCH \(differs in unique_words, words\)/);
  const okText = await world(right).agent.describeCommitment('valun_review_delivery', {deal_id: right.args.deal_id, decision: 'accept'});
  assert.match(okText, /exact result: matches the agreed text/);
  // and the same functions are exported for direct use
  const terms = {service: {title: 'notary', description: 'TEXT: abc'}};
  assert.equal(sandbox.checkDelivery(terms, sandbox.render('notary', sandbox.notary('abc'), 'abc')).exact_result_matches, true);
});

test("fail closed: a misspelt decision or action counts as a commitment, and review refuses it before connecting", async () => {
  const sc = scenario('review: accept issues the note');
  for (const decision of ['Accept', 'approve', 'yes', '', 5, null, true]) {
    const w = world(sc);
    assert.equal(await w.agent.isCommitment('valun_review_delivery', {deal_id: sc.args.deal_id, decision}), true, String(decision));
    const r = await w.agent.callSafe('valun_review_delivery', {deal_id: sc.args.deal_id, decision});
    assert.deepEqual(r, {error: 'bad_decision', message: "decision must be exactly 'accept' or 'dispute'; nothing was signed"}, String(decision));
    assert.equal(w.fetch.calls.length, 0, 'no request at all: refused before connecting');
  }
  const w = world(sc);
  assert.equal(await w.agent.isCommitment('valun_review_delivery', {deal_id: sc.args.deal_id, decision: 'dispute'}), false);
  for (const action of ['Accept', 'counter-offer', undefined, 'accept', 'counter']) {
    assert.equal(await w.agent.isCommitment('valun_respond', {deal_id: 'vd_1', action}), true, String(action));
  }
  for (const action of ['decline', 'withdraw']) assert.equal(await w.agent.isCommitment('valun_respond', {deal_id: 'vd_1', action}), false);
  assert.equal(w.fetch.calls.length, 0);
});

test('bind(): pins the recomputed terms hash or deliverable hash unless the agent passed one; fails closed for a commitment it cannot read', async () => {
  const acc = scenario('respond: accept held for my owner');
  const w = world(acc);
  const bound = await w.agent.bind(acc.tool, acc.args);
  assert.equal(bound.expected_terms_hash, acc.bound.value.expected_terms_hash);
  assert.notEqual(bound, acc.args);
  assert.equal(acc.args.expected_terms_hash, undefined, 'the arguments given are not changed');
  const given = {...acc.args, expected_terms_hash: 'ab'.repeat(32)};
  assert.deepEqual(await world(acc).agent.bind(acc.tool, given), given, 'a hash the agent passed is kept');
  const rev = scenario('review: accept held for my owner');
  const revBound = await world(rev).agent.bind(rev.tool, rev.args);
  assert.equal(revBound.expected_deliverable_sha256, rev.bound.value.expected_deliverable_sha256);
  assert.equal(revBound.expected_terms_hash, rev.bound.value.expected_terms_hash);
  for (const [name, args] of [['valun_respond', {deal_id: 'vd_x', action: 'decline'}], ['valun_review_delivery', {deal_id: 'vd_x', decision: 'Accept'}],
    ['valun_propose', {price: 3}]]) {
    const w2 = world();
    assert.deepEqual(await w2.agent.bind(name, args), args, name);
  }
  // Until 0.3.1 bind was best effort and returned these unpinned; since 0.4 (design 6.5) a commitment that cannot be
  // bound is refused, so nobody is asked to approve an acceptance that is not pinned to what they saw.
  const unbound = cause => e => e instanceof ValunError && e.code === 'approval_unbound'
    && e.message === 'could not read what you would sign; nothing was signed' && e.extra.cause === cause;
  await assert.rejects(world().agent.bind('valun_respond', {action: 'accept'}), unbound('bad_arguments'));
  const offline = world({store: 'unenrolled'});
  await assert.rejects(offline.agent.bind(acc.tool, acc.args), unbound('not_connected'));
  assert.equal(offline.fetch.calls.length, 0);
  assert.deepEqual(await world().agent.bind('valun_respond', null), {});
});

test('link hosts: without a resolver nothing is looked up and the result says so; the gate still checks counts', async () => {
  const sc = scenario('deal: short delivery with a made-up host');
  const w = world({...sc, agent: {resolveHost: null}});
  const r = await w.agent.call(sc.tool, sc.args);
  const m = r.delivery.measured_by_your_client;
  assert.equal(m.link_hosts, undefined);
  assert.equal(m.link_hosts_not_checked, measure.HOSTS_NOT_CHECKED);
  assert.match(m.link_hosts_not_checked, /no DNS resolver/);
  // a draft that misses the counts is still refused, without any DNS sentence
  const g = scenario('deliver: gate counts links and words of a brief');
  const r2 = await world({...g, agent: {resolveHost: null}}).agent.callSafe(g.tool, g.args);
  assert.equal(r2.error, 'draft_does_not_meet_terms');
  assert.doesNotMatch(r2.message, /DNS/);
  assert.equal(r2.measured.link_hosts_not_checked, measure.HOSTS_NOT_CHECKED);
  // ...but one whose only problem is a made-up host goes through: without DNS that cannot be seen
  const h = scenario('deliver: host checks off let the made-up host through');
  const w3 = world({...h, agent: {resolveHost: null}});
  assert.equal((await w3.agent.callSafe(h.tool, h.args)).status, 'delivered');
  assert.equal(posts(w3.fetch).length, 1);
  // checkHosts false: no lookup and no note
  const off = await measure.measure('see https://example.org/x', '', {checkHosts: false, resolveHost: () => { throw new Error('called'); }});
  assert.equal(off.link_hosts, undefined);
  assert.equal(off.link_hosts_not_checked, undefined);
});

test('link hosts: lookups that do not answer in time are reported as unknown, and no timer is left behind', async () => {
  const started = Date.now();
  const slow = host => (host === 'fast.example' ? Promise.resolve('public') : new Promise(() => {}));
  const m = await measure.measure('https://fast.example/a https://slow.example/b', 'at least 2 links', {resolveHost: slow, timeoutMs: 50});
  assert.deepEqual(m.link_hosts, {'fast.example': 'public', 'slow.example': 'unknown (lookup timed out)'});
  assert.ok(Date.now() - started < 2000);
  // a lookup error from the address source means the name does not exist; a resolver that throws propagates (as in Python)
  const r = measure.hostResolver(async () => { throw Object.assign(new Error('nope'), {code: 'ENOTFOUND'}); });
  assert.equal(await r('x.example'), 'not_found');
  await assert.rejects(measure.hostStatus(['https://x.example/'], async () => { throw new Error('resolver bug'); }), /resolver bug/);
  // host names are kept whatever they are called (no object-key surprises)
  assert.deepEqual(Object.keys(await measure.hostStatus(['http://__proto__/x', 'https://constructor/y'], async () => 'not_found')),
    ['__proto__', 'constructor']);
  // at most ten distinct hosts are looked up
  const seen = [];
  await measure.hostStatus(Array.from({length: 14}, (_, i) => `https://h${i % 12}.example/`), async h => { seen.push(h); return 'public'; });
  assert.equal(seen.length, 10);
});

test('the clock of the agent decides who is idle; the Client clock decides offer expiry', async () => {
  const sc = scenario('propose: idle seller gets a warning');
  const later = world(sc);
  assert.match((await later.agent.call(sc.tool, sc.args)).warning, /frank's agent has not been seen in the last 24 hours/);
  const w = world(sc);
  const early = new ValunAgent(w.client, {now: () => Date.parse('2026-11-03T13:00:00Z'), resolveHost: null});
  assert.equal((await early.call(sc.tool, sc.args)).warning, undefined);
  assert.equal(T0, Date.parse('2026-11-06T12:00:00Z'));
});
