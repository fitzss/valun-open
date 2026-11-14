// valunTools(): the framework shape {name, description, parameters, execute} and the approval hook in front of every
// commitment, with the arguments and the approval text prepared from one read (prepare()) so that what is signed is what
// the owner saw. Fail closed: no hook means commitments are refused unless approvals: 'none' is chosen explicitly, and a
// commitment whose read fails is refused (approval_unbound) without asking. Offline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {APPROVAL_TEXT, CONSENT_LOOP_MS, NO_APPROVAL_STEP, basis, bytesToHex, schemas, startConsentLoop, statements, termsHash, utf8,
  valunTools} from '../src/index.js';
import {KEYS, posts, scenario, world} from './agent-world.js';

const ACCEPT = scenario('respond: accept');
const tool = (tools, name) => tools.find(t => t.name === name);

function hook(answer) {
  const calls = [];
  const f = async (text, name, args) => {
    calls.push({text, name, args});
    return typeof answer === 'function' ? answer(text, name, args) : answer;
  };
  f.calls = calls;
  return f;
}

test('the tools in the common framework shape; parameters are mutable copies of the Python-equal schemas', async () => {
  const tools = valunTools(world().agent, {approvals: 'none'});
  assert.deepEqual(tools.map(t => t.name), schemas.ALL.map(t => t.name));
  for (const [i, t] of tools.entries()) {
    assert.deepEqual(Object.keys(t), ['name', 'description', 'parameters', 'execute']);
    assert.equal(t.description, schemas.ALL[i].description);
    assert.deepEqual(t.parameters, schemas.ALL[i].parameters);
    assert.notEqual(t.parameters, schemas.ALL[i].parameters);
    assert.equal(typeof t.execute, 'function');
  }
  tools[4].parameters.additionalProperties = false;   // a framework may change its copy
  assert.equal(schemas.PROPOSE.parameters.additionalProperties, undefined);
  const st = await tool(tools, 'valun_status').execute({});
  assert.equal(st.connected, true);
});

test('approve hook: approved -> signed; it sees the exact approval text, the tool name and a frozen copy of the arguments', async () => {
  const w = world(ACCEPT);
  const approve = hook(true);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_respond').execute(ACCEPT.args);
  assert.equal(r.status, 'agreed');
  assert.equal(approve.calls.length, 1);
  const [c] = approve.calls;
  assert.equal(c.text, ACCEPT.prepare.value.text);       // the Python reference's approval text, word for word
  assert.match(c.text, /^Valun - ACCEPT bob's offer \(vp_b0b0b0b0b0b0, deal vd_1111111111111111, version 1\):/);
  assert.equal(c.name, 'valun_respond');
  assert.deepEqual(c.args, ACCEPT.args);
  assert.ok(Object.isFrozen(c.args));
  assert.deepEqual(posts(w.fetch).map(x => x.key), ['POST /pilot/v1/deals/vd_1111111111111111/accept']);
});

test('approve hook: anything but true declines -> owner_declined, nothing signed or sent', async () => {
  for (const answer of [false, undefined, null, 'yes', 1, {approve: true}]) {
    const w = world(ACCEPT);
    const r = await tool(valunTools(w.agent, {approve: hook(answer)}), 'valun_respond').execute(ACCEPT.args);
    assert.deepEqual(r, {error: 'owner_declined', message: 'your owner did not approve this commitment; nothing was signed',
      what_this_means: 'Your owner did not approve this commitment. Nothing was signed or sent.'}, String(answer));
    assert.equal(posts(w.fetch).length, 0);
  }
});

test('no hook: commitments fail closed with approval_unavailable; reads and non-commitments still work', async () => {
  const w = world(ACCEPT);
  const tools = valunTools(w.agent);
  for (const [name, args] of [['valun_respond', ACCEPT.args], ['valun_propose', scenario('propose: payer to bob').args],
    ['valun_review_delivery', scenario('review: accept issues the note').args], ['valun_set_limits', {max_per_deal_as_payer: 25}]]) {
    const r = await tool(tools, name).execute(args);
    assert.equal(r.error, 'approval_unavailable', name);
    assert.match(r.message, /^Not signed\./);
    assert.match(r.what_this_means, /^Nothing was signed\./);
  }
  assert.equal(posts(w.fetch).length, 0);
  assert.equal(w.agent.approvals, NO_APPROVAL_STEP);
  assert.match((await tool(tools, 'valun_status').execute()).approvals, /^Commitments cannot be signed here/);
  const dec = scenario('respond: decline');
  const w2 = world(dec);
  assert.equal((await tool(valunTools(w2.agent), 'valun_respond').execute(dec.args)).status, 'declined');
  const lim = scenario('set_limits: tighten and record goals');
  assert.ok((await tool(valunTools(world(lim).agent), 'valun_set_limits').execute(lim.args)).recorded);
});

test("approvals: 'none' signs without asking anyone (and does not even look up whether it is a commitment)", async () => {
  const w = world(ACCEPT);
  const r = await tool(valunTools(w.agent, {approvals: 'none'}), 'valun_respond').execute(ACCEPT.args);
  assert.equal(r.status, 'agreed');
  assert.equal(w.agent.approvals, APPROVAL_TEXT.none);
  const lim = scenario('set_limits: loosen a recorded cap');
  const w2 = world(lim);
  await tool(valunTools(w2.agent, {approvals: 'none'}), 'valun_set_limits').execute(lim.args);
  assert.deepEqual(w2.fetch.calls.map(c => c.key), ['PUT /pilot/v1/limits']);
});

test('limits: tightening needs no approval, loosening asks with the Python approval text, a failing hook fails closed', async () => {
  const tighten = scenario('set_limits: tighten and record goals');
  const approve = hook(true);
  await tool(valunTools(world(tighten).agent, {approve}), 'valun_set_limits').execute(tighten.args);
  assert.equal(approve.calls.length, 0);
  const loosen = scenario('set_limits: loosen a recorded cap');
  const w = world(loosen);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_set_limits').execute(loosen.args);
  assert.ok(r.recorded);
  assert.equal(approve.calls.length, 1);
  assert.equal(approve.calls[0].text, loosen.prepare.value.text);
  const w2 = world(loosen);
  const r2 = await tool(valunTools(w2.agent, {approve: async () => { throw new Error('approval window closed'); }}), 'valun_set_limits').execute(loosen.args);
  assert.equal(r2.error, 'approval_unavailable');
  assert.match(r2.message, /approval window closed/);
  assert.equal(w2.fetch.calls.filter(c => c.key === 'PUT /pilot/v1/limits').length, 0);
  // a hook that tries to change the arguments it was shown cannot: they are frozen
  const w3 = world(ACCEPT);
  const sneaky = async (text, name, args) => { args.expected_terms_hash = 'ff'; return true; };
  assert.equal((await tool(valunTools(w3.agent, {approve: sneaky}), 'valun_respond').execute(ACCEPT.args)).error, 'approval_unavailable');
  assert.equal(posts(w3.fetch).length, 0);
});

test('when it cannot tell whether a call commits the owner, it is a commitment, and one it cannot read is refused without asking', async () => {
  // Until 0.3.1 the owner was asked with the generic text 'Valun: sign a commitment (valun_set_limits).' here; since 0.4
  // (design 6.5) a known commitment never gets the generic text: when what it would sign cannot be read, it is refused.
  const w = world({routes: {'GET /pilot/v1/me': {status: 503, body: {error: 'unavailable'}}}});
  assert.equal(await w.agent.isCommitment('valun_set_limits', {max_per_deal_as_payer: 1}), true);
  const approve = hook(true);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_set_limits').execute({max_per_deal_as_payer: 1});
  assert.equal(r.error, 'approval_unbound');
  assert.equal(r.message, 'could not read what you would sign; nothing was signed');
  assert.match(r.what_this_means, /^Nothing was signed and your owner was not asked/);
  assert.equal(approve.calls.length, 0, 'the owner is never asked with a generic text');
  assert.equal(w.fetch.calls.filter(c => c.key === 'PUT /pilot/v1/limits').length, 0);
});

test('a misspelt review decision is a commitment (fail closed) with no approval text: refused without asking or sending anything', async () => {
  // Until 0.3.1 the owner was asked (with a generic text) and the tool then refused with bad_decision; since 0.4 (design
  // 6.5) prepare() has no text for it, so the call is refused (approval_unbound) before anything is read or signed.
  const sc = scenario('review: accept issues the note');
  const w = world(sc);
  const args = {...sc.args, decision: 'Accept'};
  assert.equal(await w.agent.isCommitment('valun_review_delivery', args), true, 'a commitment');
  const approve = hook(true);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_review_delivery').execute(args);
  assert.equal(r.error, 'approval_unbound');
  assert.equal(approve.calls.length, 0, 'the owner is not asked');
  assert.equal(w.fetch.calls.length, 0, 'no request at all');
  assert.deepEqual(await w.agent.callSafe('valun_review_delivery', args),
    {error: 'bad_decision', message: "decision must be exactly 'accept' or 'dispute'; nothing was signed"}, 'the tool itself refuses it too');
});

test('prepare() before the hook: the hook sees the pinned terms hash, and exactly that hash is signed', async () => {
  const sc = scenario('respond: accept held for my owner');   // the agent passed no expected_terms_hash
  const w = world(sc);
  const approve = hook(true);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_respond').execute(sc.args);
  assert.equal(r.status, 'accepted_awaiting_owner');
  const [c] = approve.calls;
  assert.equal(c.args.expected_terms_hash, sc.bound.value.expected_terms_hash);
  assert.equal(c.args.expected_terms_hash, sc.prepare.value.args.expected_terms_hash);
  assert.equal(c.text, sc.prepare.value.text);
  assert.equal(c.text, sc.describe_bound.value);
  const [p] = posts(w.fetch);
  assert.equal(p.key, `POST /pilot/v1/deals/${sc.args.deal_id}/accept`);
  assert.equal(p.body.terms_hash, sc.bound.value.expected_terms_hash);
  const rev = scenario('review: accept held for my owner');   // and the deliverable hash (and terms hash) for a delivery
  const w2 = world(rev);
  const approve2 = hook(true);
  await tool(valunTools(w2.agent, {approve: approve2}), 'valun_review_delivery').execute(rev.args);
  assert.equal(approve2.calls[0].args.expected_deliverable_sha256, rev.bound.value.expected_deliverable_sha256);
  assert.equal(approve2.calls[0].args.expected_terms_hash, rev.prepare.value.args.expected_terms_hash);
  assert.equal(posts(w2.fetch)[0].body.deliverable_sha256, rev.bound.value.expected_deliverable_sha256);
  assert.equal(posts(w2.fetch)[0].body.terms_hash, rev.prepare.value.args.expected_terms_hash);
});

test('an offer that changes after the owner approved it is not signed (stale_terms)', async () => {
  const sc = scenario('respond: accept held for my owner');
  const key = `GET /pilot/v1/deals/${sc.args.deal_id}`;
  const before = sc.routes[key].body;
  // the same deal, re-offered by bob at a higher price after the owner saw the first terms
  const terms = {...before.current.terms, price: {amount: 35, unit: 'PC'}, nonce: 'cd'.repeat(16)};
  const h = termsHash(terms);
  const after = {...before, current: {...before.current, terms, terms_hash: h,
    signature: bytesToHex(basis.sign(utf8(statements.propose(h)), KEYS.bob.secret))}};
  let reads = 0;
  // The one read prepare() makes (bind and describe together): before; the read when signing: after. (Until 0.3.1
  // bind and describe read the deal separately, so the switch came at the third read.)
  const w = world({routes: k => (k === key ? {body: ++reads <= 1 ? before : after} : sc.routes[k])});
  const approve = hook(true);
  const r = await tool(valunTools(w.agent, {approve}), 'valun_respond').execute(sc.args);
  assert.match(approve.calls[0].text, /price: 20 PC/);
  assert.equal(r.error, 'stale_terms');
  assert.equal(posts(w.fetch).length, 0, 'nothing signed or sent');
  // without binding (approvals: 'none' asks nobody and pins nothing) the newer terms would have been accepted
  let reads2 = 0;
  const w2 = world({routes: k => (k === key ? {body: ++reads2 <= 2 ? before : after} : sc.routes[k])});
  await w2.agent.call('valun_deal', {deal_id: sc.args.deal_id});
  await w2.agent.call('valun_deal', {deal_id: sc.args.deal_id});
  assert.equal((await tool(valunTools(w2.agent, {approvals: 'none'}), 'valun_respond').execute(sc.args)).status, 'accepted_awaiting_owner');
  assert.equal(posts(w2.fetch)[0].body.terms_hash, h);
});

test('execute() takes an object, a JSON string or nothing; anything else is bad_arguments', async () => {
  const sc = scenario('deal: open offer from bob, verified');
  const deal = tool(valunTools(world(sc).agent, {approvals: 'none'}), 'valun_deal');
  assert.equal((await deal.execute(JSON.stringify(sc.args))).status, 'open');
  assert.equal((await deal.execute(sc.args)).status, 'open');
  assert.deepEqual(await deal.execute(), {error: 'bad_arguments', message: 'missing argument: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it)'});   // fix inbox #58
  for (const bad of ['{not json', '[1,2]', '"text"', '7']) {
    const r = await deal.execute(bad);
    assert.equal(r.error, 'bad_arguments', bad);
    assert.match(r.message, /^arguments must be a JSON object: /);
  }
  assert.equal((await deal.execute([1])).error, 'bad_arguments');
});

test('valunTools() refuses contradictory or unknown options and keeps an approvals sentence the caller set', () => {
  const {agent} = world();
  assert.throws(() => valunTools(agent, {approvals: 'none', approve: async () => true}), TypeError);
  assert.throws(() => valunTools(agent, {approvals: 'sometimes'}), TypeError);
  assert.throws(() => valunTools(agent, {approve: 'yes'}), TypeError);
  assert.throws(() => valunTools({}), TypeError);
  agent.approvals = 'Approvals happen in the Acme console.';
  valunTools(agent, {approve: async () => true});
  assert.equal(agent.approvals, 'Approvals happen in the Acme console.');
  const other = world().agent;
  valunTools(other, {approve: async () => true});
  assert.equal(other.approvals, APPROVAL_TEXT.ask);
});

// ---------- the optional consent loop for long-running hosts ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('startConsentLoop(): nothing runs until a host starts it; then rounds while consent_loop is on, never overlapping, until stop()', async () => {
  assert.equal(CONSENT_LOOP_MS, 60_000);
  let calls = 0, inFlight = 0, most = 0, reloads = 0;
  const state = {consent_loop: 'on'};
  const fake = {client: () => ({state, reload: async () => { reloads++; }}),
    consentsIfDue: async () => {
      calls++;
      most = Math.max(most, ++inFlight);
      await sleep(15);
      inFlight--;
    }};
  const loop = startConsentLoop(fake, {intervalMs: 5, jitterMs: 2});
  await sleep(90);
  loop.stop();
  const n = calls;
  assert.ok(n >= 2, `${n} rounds`);
  assert.equal(most, 1, 'rounds never overlap');
  assert.ok(reloads >= n, 'the profile is read again before each round');
  assert.equal(loop.runs, n);
  await sleep(40);
  assert.equal(calls, n, 'no round after stop()');
  // off in the profile: nothing is run; runOnce() during a round is that round
  state.consent_loop = 'off';
  const off = startConsentLoop(fake, {intervalMs: 1_000_000});
  await off.runOnce();
  assert.equal(off.runs, 0);
  state.consent_loop = 'on';
  const [a, b] = [off.runOnce(), off.runOnce()];
  assert.equal(a, b, 'one round at a time');
  await a;
  assert.equal(off.runs, 1);
  off.stop();
  // a round that throws, or a profile that cannot be read, never reaches the host
  const bad = startConsentLoop({client: () => { throw new Error('unreadable'); }, consentsIfDue: async () => { throw new Error('x'); }},
    {intervalMs: 1_000_000});
  await bad.runOnce();
  assert.equal(bad.runs, 0);
  bad.stop();
  assert.throws(() => startConsentLoop({}), TypeError);
  assert.throws(() => startConsentLoop(fake, {intervalMs: 0}), TypeError);
});

test('startConsentLoop(): a round signs the set-off a due consent run signs (the profile turned the loop on)', async () => {
  const sc = scenario('propose: a due consent run signs a set-off first');
  const w = world({...sc, state: {...sc.state, consent_loop: 'on'}});
  const loop = startConsentLoop(w.agent, {intervalMs: 1_000_000});
  await loop.runOnce();
  loop.stop();
  assert.equal(loop.runs, 1);
  const keys = w.fetch.calls.map(c => c.key);
  assert.deepEqual(keys.slice(0, 4), ['GET /pilot/v1/info', 'GET /pilot/v1/consents', 'GET /pilot/v1/me', 'POST /pilot/v1/consents/vs_5e70ff5e70ff5e70']);
  assert.equal(w.store.state.consent_log.at(-1).decision, 'signed');
  // within a minute of that round, a tool call does not run consents again
  await w.agent.callSafe('valun_propose', sc.args);
  assert.equal(w.fetch.calls.filter(c => c.key === 'GET /pilot/v1/consents').length, 1);
});

// ---------- one consent run at a time: the agent's lock (Python's STORE_LOCK) ----------
// The recorded set-off answers the first POST; a second POST of the same signatures gets what the server answers then
// (409 already_signed): a client that sent it would forget the pending entries the first one wrote ahead.
const DUE = scenario('propose: a due consent run signs a set-off first');
const CONSENT_POST = Object.keys(DUE.routes).find(k => k.startsWith('POST /pilot/v1/consents/'));
const ALREADY = {status: 409, body: {error: 'already_signed', message: 'these signatures were taken already'}};
const dueWorld = (state = {}) => world({...DUE, routes: {...DUE.routes, [CONSENT_POST]: {sequence: [DUE.routes[CONSENT_POST], ALREADY]}},
  state: {...DUE.state, ...state}});
const count = (w, pred) => w.fetch.calls.filter(c => pred(c.key)).length;
const pendingOf = st => Object.fromEntries(Object.entries(st.records || {}).filter(([k]) => k !== 'paid_deals')
  .map(([k, e]) => [k, e.pending || []]));

test('a consent loop round next to a tool call, two tool calls or two runs at once: one consent run, one POST, the pending entries kept', async () => {
  const one = dueWorld();
  await one.agent.consentsIfDue();
  const expected = pendingOf(one.store.state);
  assert.ok(Object.values(expected).some(p => p.length), 'the run wrote its signatures ahead');
  const check = (w, what) => {
    assert.equal(count(w, k => k === 'GET /pilot/v1/consents'), 1, `${what}: one consent run`);
    assert.equal(count(w, k => k === CONSENT_POST), 1, `${what}: the consent is sent once`);
    assert.deepEqual(w.store.state.consent_log.map(e => e.decision), ['signed'], what);
    assert.deepEqual(pendingOf(w.store.state), expected, `${what}: the pending entries are kept`);
  };
  // a loop round alongside a tool call (the round first, then the call: neither interleaves with the other)
  const w1 = dueWorld({consent_loop: 'on'});
  const loop = startConsentLoop(w1.agent, {intervalMs: 1_000_000});
  const [, proposed] = await Promise.all([loop.runOnce(), w1.agent.callSafe('valun_propose', DUE.args)]);
  loop.stop();
  assert.equal(loop.runs, 1);
  assert.equal(proposed.error, undefined);
  check(w1, 'loop round and tool call');
  const keys = w1.fetch.calls.map(c => c.key);
  assert.ok(keys.indexOf(CONSENT_POST) < keys.indexOf('POST /pilot/v1/deals'), 'the round ran first, whole');
  // the tool call first, then the round
  const w2 = dueWorld({consent_loop: 'on'});
  const loop2 = startConsentLoop(w2.agent, {intervalMs: 1_000_000});
  await Promise.all([w2.agent.callSafe('valun_propose', DUE.args), loop2.runOnce()]);
  loop2.stop();
  check(w2, 'tool call and loop round');
  // two tool calls at once
  const w3 = dueWorld();
  await Promise.all([w3.agent.callSafe('valun_propose', DUE.args), w3.agent.callSafe('valun_propose', DUE.args)]);
  check(w3, 'two tool calls');
  assert.equal(count(w3, k => k === 'POST /pilot/v1/deals'), 2);
  // two runs at once: the second finds the first's run less than a minute ago
  const w4 = dueWorld();
  const [a, b] = await Promise.all([w4.agent.consentsIfDue(), w4.agent.consentsIfDue()]);
  assert.equal(a.signed.length, 1);
  assert.equal(b, null);
  check(w4, 'two runs');
});

test('the agent lock: exclusive() runs one holder at a time, in order, whatever each one does; valunTools() never holds it while the owner is asked', async () => {
  const {agent} = world();
  const order = [];
  let inside = 0, most = 0;
  const holder = (name, ms, fail = false) => agent.exclusive(async () => {
    most = Math.max(most, ++inside);
    order.push(`${name} in`);
    await sleep(ms);
    order.push(`${name} out`);
    inside--;
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([holder('a', 15, true), holder('b', 1), holder('c', 5)]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(order, ['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
  assert.equal(most, 1);
  assert.throws(() => agent.exclusive(null), TypeError);
  // while the approve hook waits for the owner, the agent's other calls go on
  const w = world(ACCEPT);
  let release;
  const waiting = new Promise(r => { release = r; });
  const approve = async () => { await waiting; return false; };
  const pending = tool(valunTools(w.agent, {approve}), 'valun_respond').execute(ACCEPT.args);
  await sleep(5);
  const st = await Promise.race([w.agent.callSafe('valun_status'), sleep(2000).then(() => 'blocked')]);
  assert.notEqual(st, 'blocked', 'a call while the owner is asked is not held up');
  release();
  assert.equal((await pending).error, 'owner_declined');
});

test('startConsentLoop(): a round reads the profile again only once it holds the agent lock (never in the middle of a tool call)', async () => {
  const w = dueWorld({consent_loop: 'on'});
  let holding = false;
  const seen = [];
  w.store.reload = async () => { seen.push(holding); };      // a store that can read the profile again (as FileStore)
  const loop = startConsentLoop(w.agent, {intervalMs: 1_000_000});
  const held = w.agent.exclusive(async () => {               // a tool call in progress
    holding = true;
    await sleep(20);
    holding = false;
  });
  await Promise.all([held, loop.runOnce()]);
  loop.stop();
  assert.equal(loop.runs, 1);
  assert.ok(seen.length >= 1, 'the round read the profile');
  assert.deepEqual(seen, seen.map(() => false), 'never while another holder had the lock');
  assert.equal(count(w, k => k === 'GET /pilot/v1/consents'), 1);
  // a ValunAgent's round: {ran, report}; an enabled() that throws or says no runs nothing
  const w2 = dueWorld();
  assert.deepEqual(await w2.agent.consentRound(async () => false), {ran: false, report: null});
  assert.deepEqual(await w2.agent.consentRound(async () => { throw new Error('unreadable'); }), {ran: false, report: null});
  assert.equal(w2.fetch.calls.length, 0);
  const r = await w2.agent.consentRound(() => true);
  assert.equal(r.ran, true);
  assert.equal(r.report.signed.length, 1);
  await assert.rejects(async () => w2.agent.consentRound(null), TypeError);
});

test('the agent lock covers isCommitment(), prepare(), bind() and consentsOnRead(): none of them starts while another holder has it', async () => {
  const unpinned = {deal_id: ACCEPT.args.deal_id, action: 'accept'};      // bind() reads only when a pin is missing
  const sites = {
    isCommitment: a => a.isCommitment('valun_set_limits', {max_per_deal_as_payer: 5}),
    prepare: a => a.prepare('valun_respond', unpinned),
    bind: a => a.bind('valun_respond', unpinned),
    consentsOnRead: a => a.consentsOnRead(),
  };
  for (const [name, run] of Object.entries(sites)) {
    const w = world({...ACCEPT, agent: {consents_on_reads: true}});
    let release;
    const gate = new Promise(r => { release = r; });
    const held = w.agent.exclusive(() => gate);
    let settled = false;
    const site = Promise.resolve().then(() => run(w.agent)).then(() => {}, () => {}).finally(() => { settled = true; });
    await sleep(20);
    assert.equal(settled, false, `${name} waits for the lock`);
    assert.equal(w.fetch.calls.length, 0, `${name} reads nothing while another holder has the lock`);
    release();
    await held;
    await site;
    assert.equal(settled, true, `${name} runs once the lock is free`);
  }
});
