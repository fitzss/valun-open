// valunTools(): the framework shape {name, description, parameters, execute} and the approval hook in front of every
// commitment, with the arguments and the approval text prepared from one read (prepare()) so that what is signed is what
// the owner saw. Fail closed: no hook means commitments are refused unless approvals: 'none' is chosen explicitly, and a
// commitment whose read fails is refused (approval_unbound) without asking. Offline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {APPROVAL_TEXT, NO_APPROVAL_STEP, basis, bytesToHex, schemas, statements, termsHash, utf8, valunTools} from '../src/index.js';
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

test('nine tools in the common framework shape; parameters are mutable copies of the Python-equal schemas', async () => {
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
  assert.deepEqual(await deal.execute(), {error: 'internal_error', message: "KeyError: 'deal_id'"});
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
