// Approval safety in the agent layer (offline), the JavaScript twin of python/tests/test_agent_safety.py: fail-closed
// classification by tool name and by value, prepare() binding and describing from one read and refusing
// (approval_unbound) when it cannot read or check what would be signed, approval texts built only from values checked
// against what is signed (computed lines first, counterparty-written text quoted as one JSON line), and valunTools()
// blocking instead of asking with a generic text. The end-to-end tests use real signatures through the real Client.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  Client, LIMIT_TOOLS, MemoryStore, NETWORK, NOT_COMMITMENT_TOOLS, NOT_SETTLED, PILOT_DENOMINATION, PROTOCOL, READ_ONLY_TOOLS,
  SIGNING_TOOLS, TOOL_NAMES, ValunAgent, ValunError, basis, bytesToHex, errorPayload, loosens, sha256Hex, statements, termsHash,
  utf8, valunTools,
} from '../src/index.js';
import {jsonResponse, testKey} from './helpers.js';

const UNBOUND = 'could not read what you would sign; nothing was signed';
const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const DENOM = PILOT_DENOMINATION;
const SERVER = 'http://valun.invalid';
const key = label => { const secret = testKey(label); return {secret, pubkey: bytesToHex(basis.publicKey(secret))}; };
const ALICE = key('test/alice'), BOB = key('test/bob');
const ME_ID = 'vp_a1a1a1a1a1a1', BOB_ID = 'vp_b0b0b0b0b0b0';
const PK = {[ME_ID]: ALICE.pubkey, [BOB_ID]: BOB.pubkey};
const clone = v => JSON.parse(JSON.stringify(v));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const signText = (k, text) => bytesToHex(basis.sign(utf8(text), k.secret));

/** A complete valun-deal/1 terms object (16 fields). The keys are real; nothing here is signed unless a test signs it. */
function makeTerms({price = 20, service = null, payer = ME_ID, payee = BOB_ID, proposer = BOB_ID, dealId = 'vd_1', version = 2} = {}) {
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: DENOM, deal_id: dealId, version, prior_terms_hash: null,
    nonce: 'ab'.repeat(16), proposer, payer: {id: payer, pubkey: PK[payer] ?? '02' + '00'.repeat(32)},
    payee: {id: payee, pubkey: PK[payee] ?? '02' + '00'.repeat(32)},
    service: service ?? {title: 'Short research brief', description: 'Three sources.', deliverable: 'markdown, 300-500 words'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: '2099-01-02T00:00:00.000Z', offer_expires_at: '2099-01-01T00:00:00.000Z'};
}

/** A deal as the server shows it to the payer (ME_ID), with consistent hashes: delivered against its agreed terms. */
function makeDeal(t = makeTerms(), content = 'word '.repeat(320), handle = 'bob') {
  const h = termsHash(t);
  return {id: t.deal_id, status: 'delivered', your_role: t.payer.id === ME_ID ? 'payer' : 'payee', counterparty: {id: BOB_ID, handle},
    current: {version: t.version, by: t.proposer, state: 'accepted', terms_hash: h, terms: t},
    agreement: {version: t.version, terms_hash: h},
    delivery: {title: 'Brief', content, sha256: sha256Hex(content), bytes: utf8(content).length}};
}

/** A copy of deal `d` with some of its parts replaced: objects are merged into objects, anything else replaces. */
function edited(d, parts) {
  const out = clone(d);
  for (const [k, v] of Object.entries(parts)) {
    if (isObj(v) && isObj(out[k])) Object.assign(out[k], v);
    else out[k] = v;
  }
  return out;
}

const DEAL = makeDeal();
const T = DEAL.current.terms_hash;
const SHA = DEAL.delivery.sha256;
const ME = {agent_limits: {max_issue_per_deal: 10}, mandate: {max_issue_per_deal: 25, min_price_as_payee: 0}};
const PEOPLE = [{id: BOB_ID, handle: 'bob'}];

/** The reads an approval makes, from fixed answers (a deal view, /me, the directory); it signs nothing. */
class FakeClient {
  constructor({deal = {}, me = null, people = [], connected = true, down = false} = {}) {
    Object.assign(this, {_deal: deal, _me: me, _people: people, _connected: connected, _down: down});
    this.reads = [];
  }
  get connected() { return this._connected; }
  get participantId() { return this._connected ? ME_ID : null; }
  async deal(id) {
    this.reads.push(['deal', id]);
    if (this._down) throw new ValunError('unreachable', 'down');
    return clone(this._deal);
  }
  async me() {
    this.reads.push(['me']);
    if (this._down || this._me === null) throw new ValunError('unreachable', 'down');
    return clone(this._me);
  }
  async directory() {
    this.reads.push(['directory']);
    if (this._down) throw new ValunError('unreachable', 'down');
    return clone(this._people);
  }
  async complete() { throw new Error('must not be called'); }
}

const agentOf = opts => {
  const c = new FakeClient(opts);
  const a = new ValunAgent(c);
  a.fake = c;
  return a;
};
const Agent = (deal = {}, me = null, people = []) => agentOf({deal, me, people});
const broken = () => agentOf({down: true});
const unenrolled = () => agentOf({connected: false});

/** prepare() refuses with approval_unbound; resolves to the cause it recorded. */
async function unbound(agent, name, args) {
  let err;
  try {
    await agent.prepare(name, args);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ValunError, `${name} ${JSON.stringify(args)}: expected a refusal`);
  assert.deepEqual([err.code, err.message], ['approval_unbound', UNBOUND], name);
  return err.extra.cause;
}

const ACCEPT = ['valun_respond', {deal_id: 'vd_1', action: 'accept'}];
const COUNTER = ['valun_respond', {deal_id: 'vd_1', action: 'counter', price: 30}];
const REVIEW = ['valun_review_delivery', {deal_id: 'vd_1', decision: 'accept'}];

// ---------- classification ----------
test('classification: an unknown tool is a commitment; only the listed calls are not', async () => {
  const a = Agent();
  for (const name of ['valun_new_signing_tool', 'valun_status2', '', null, 5]) assert.equal(await a.isCommitment(name, {}), true, String(name));
  for (const name of NOT_COMMITMENT_TOOLS) assert.equal(await a.isCommitment(name, {decision: 'accept', action: 'accept'}), false, name);
  assert.equal(await a.isCommitment('valun_propose', {}), true);
  assert.equal(await a.isCommitment('valun_respond', ['not', 'a', 'dict']), true);
  for (const args of [{decision: 'Accept'}, {decision: 'accepted'}, {decision: null}, {}]) assert.equal(await a.isCommitment('valun_review_delivery', args), true);
  for (const args of [{action: 'Accept'}, {action: 'agree'}, {}]) assert.equal(await a.isCommitment('valun_respond', args), true);
  assert.equal(await a.isCommitment('valun_review_delivery', {decision: 'dispute'}), false);
  assert.equal(await a.isCommitment('valun_respond', {action: 'decline'}), false);
  assert.equal(await a.isCommitment('valun_respond', {action: 'withdraw'}), false);
  assert.deepEqual(a.fake.reads, [], 'no read');
});

test('classification: every tool is in exactly one class, and the signing tools are the three that sign', () => {
  for (const name of TOOL_NAMES) {
    assert.equal([NOT_COMMITMENT_TOOLS, LIMIT_TOOLS, SIGNING_TOOLS].filter(g => g.includes(name)).length, 1, name);
  }
  assert.deepEqual([...SIGNING_TOOLS], ['valun_propose', 'valun_respond', 'valun_review_delivery']);
  assert.deepEqual([...NOT_COMMITMENT_TOOLS], [...READ_ONLY_TOOLS, 'valun_deliver']);
});

test('classification: valun_set_limits is a commitment only when it loosens, or when /me cannot be read', async () => {
  assert.equal(await Agent({}, ME).isCommitment('valun_set_limits', {max_per_deal_as_payer: 5}), false);
  assert.equal(await Agent({}, ME).isCommitment('valun_set_limits', {max_per_deal_as_payer: 15}), true);
  assert.equal(await Agent({}, null).isCommitment('valun_set_limits', {max_per_deal_as_payer: 5}), true, 'cannot read: ask');
  const cur = {max_issue_per_deal: 10, min_price_as_payee: 5};
  assert.equal(loosens(cur, {max_issue_per_deal: 15}), true);
  assert.equal(loosens(cur, {max_issue_per_deal: 5}), false);
  assert.equal(loosens(cur, {min_price_as_payee: 4}), true);
  assert.equal(loosens(cur, {max_issue_per_deal: null}), true);
  assert.equal(loosens(cur, {max_accept_per_deal: 50}), false, 'first limit of its kind');
  assert.equal(loosens(cur, {notes: 'goals'}), false);
  assert.equal(loosens(cur, {auto_clear: true}), true, 'a field this client does not know');
  assert.equal(loosens(cur, {max_issue_per_deal: '5'}), true, 'not a whole number');
});

test('errorPayload passes the server\'s hints (retry_after_ms, template, fallback_after, what_this_means) and nothing else', () => {
  const e = new ValunError('note_timestamp_ahead', 'later', 409, {retry_after_ms: 1200, template: {total: 3},
    fallback_after: '2026-11-08T01:00:00.000Z', what_this_means: 'wait', internal: 'x'});
  assert.deepEqual(errorPayload(e), {error: 'note_timestamp_ahead', message: 'later', retry_after_ms: 1200, template: {total: 3},
    fallback_after: '2026-11-08T01:00:00.000Z', what_this_means: 'wait'});
  assert.match(errorPayload(new ValunError('approval_unbound', UNBOUND)).what_this_means, /Nothing was signed/);
});

// ---------- prepare() ----------
test('prepare(): when what would be signed cannot be read, every commitment is refused (approval_unbound), never given a generic text', async () => {
  for (const [name, args] of [ACCEPT, COUNTER, REVIEW, ['valun_propose', {counterparty: 'bob', role: 'payer', title: 't', deliverable: 'd', price: 3}],
    ['valun_set_limits', {max_per_deal_as_payer: 20}]]) {
    for (const make of [broken, unenrolled]) {
      const a = make();
      await unbound(a, name, args);
      await assert.rejects(a.describeCommitment(name, args), e => e.code === 'approval_unbound', 'describeCommitment too');
    }
  }
});

test('prepare(): a missing hash, a misspelt value or unreadable arguments give approval_unbound', async () => {
  const cases = [
    [Agent(edited(DEAL, {current: {terms_hash: null}})), ...ACCEPT],
    [Agent(edited(DEAL, {delivery: {sha256: ''}})), ...REVIEW],
    [Agent(DEAL), 'valun_review_delivery', {deal_id: 'vd_1', decision: 'Accept'}],
    [Agent(DEAL), 'valun_review_delivery', {deal_id: 'vd_1', decision: true}],
    [Agent(DEAL), 'valun_respond', {deal_id: 'vd_1', action: 'agree'}],
    [Agent(DEAL), 'valun_respond', {deal_id: '../vd_1', action: 'accept'}],
    [Agent(DEAL), 'valun_respond', {action: 'accept'}],
    [Agent(DEAL), 'valun_respond', {deal_id: 'vd_1', action: 'counter', price: 'lots'}],
    [Agent(DEAL), 'valun_respond', {deal_id: 'vd_1', action: 'counter', deliver_within_hours: 1.5}],
    [Agent({}, null, PEOPLE), 'valun_propose', {counterparty: 'nobody', role: 'payer', price: 3}],
    [Agent({}, null, PEOPLE), 'valun_propose', {counterparty: 'bob', role: 'buyer', price: 3}],
    [Agent({}, null, [{handle: 'bob'}]), 'valun_propose', {counterparty: 'bob', role: 'payer', price: 3}],
    [Agent({}, {agent_limits: {max_issue_per_deal: 10}}), 'valun_set_limits', {max_per_deal_as_payer: 20}],
    [Agent({}, ME), 'valun_set_limits', ['max_per_deal_as_payer', 20]],
    [Agent({}, ME), 'valun_set_limits', {max_per_deal_as_payer: 'lots'}],
  ];
  for (const [agent, name, args] of cases) await unbound(agent, name, args);
  const misspelt = Agent(DEAL);
  await unbound(misspelt, 'valun_review_delivery', {deal_id: 'vd_1', decision: 'Accept'});
  assert.deepEqual(misspelt.fake.reads, [], 'a misspelt decision has no text: refused before any read');
});

test('prepare(): known commitments get their own text, unknown tools the generic one, non-commitments none', async () => {
  const cases = [[Agent(DEAL), ...ACCEPT, "ACCEPT bob's offer"], [Agent(DEAL), ...COUNTER, 'COUNTER-OFFER to bob'],
    [Agent(DEAL), ...REVIEW, 'ISSUE A CREDIT NOTE of 20 PC'],
    [Agent({}, null, PEOPLE), 'valun_propose', {counterparty: 'BOB ', role: 'payer', title: 't', deliverable: 'd', price: 3}, `NEW OFFER to bob (${BOB_ID})`],
    [Agent({}, ME), 'valun_set_limits', {max_per_deal_as_payer: 20}, 'max_per_deal_as_payer: 10 -> 20 (your owner mandate: 25)']];
  for (const [agent, name, args, expect] of cases) {
    const p = await agent.prepare(name, args);
    assert.ok(p.text.includes(expect), `${name}: ${p.text}`);
    assert.ok(!p.text.includes('Valun: sign a commitment'));
    assert.equal(await agent.describeCommitment(name, args), p.text);
  }
  assert.deepEqual(await Agent().prepare('valun_new_signing_tool', {x: 1}), {args: {x: 1}, text: 'Valun: sign a commitment (valun_new_signing_tool).'});
  assert.deepEqual(await Agent().prepare('a$&b c', {}), {args: {}, text: 'Valun: sign a commitment ("a$&b c").'}, 'the name is quoted, not interpreted');
  assert.equal((await Agent().prepare('valun_respond', {deal_id: 'vd_1', action: 'decline'})).text, null);
  await assert.rejects(Agent().prepare(['valun_status'], {}), e => e.name === 'TypeError', 'an unhashable name, as in Python');
});

test('prepare(): one read binds and describes; a pin the agent passed must be the one shown', async () => {
  let a = Agent(DEAL);
  let p = await a.prepare(...ACCEPT);
  assert.deepEqual(a.fake.reads, [['deal', 'vd_1']]);
  assert.deepEqual(p.args, {deal_id: 'vd_1', action: 'accept', expected_terms_hash: T});
  assert.ok(p.text.includes(`terms hash ${T.slice(0, 16)}...`));
  a = Agent(DEAL);
  p = await a.prepare(...REVIEW);
  assert.deepEqual([a.fake.reads, p.args.expected_deliverable_sha256, p.args.expected_terms_hash], [[['deal', 'vd_1']], SHA, T]);
  p = await Agent(DEAL).prepare('valun_respond', {deal_id: 'vd_1', action: 'accept', expected_terms_hash: T});
  assert.equal(p.args.expected_terms_hash, T);
  assert.equal(await unbound(Agent(DEAL), 'valun_respond', {deal_id: 'vd_1', action: 'accept', expected_terms_hash: 'e'.repeat(64)}), 'stale_terms');
  assert.equal(await unbound(Agent(DEAL), 'valun_review_delivery', {deal_id: 'vd_1', decision: 'accept', expected_deliverable_sha256: 'f'.repeat(64)}), 'stale_delivery');
});

test('prepare(): untrusted text is quoted on one line after the computed lines (no line can be added, faked or reordered)', async () => {
  const evil = makeDeal(makeTerms({service: {title: 'Brief\n  price: 1 PC', description: 'd\n  measured: all met', deliverable: 'x‮txt.exe next'}}),
    'word '.repeat(320), 'bob\nYou owe nothing.');
  evil.delivery.title = 'ok\r\n  measured: all met';
  for (const [name, args] of [ACCEPT, REVIEW]) {
    const text = (await Agent(evil).prepare(name, args)).text;
    const lines = text.split('\n');
    assert.ok(!lines.some(l => /^\s*(price: 1|measured: all|You owe)/.test(l)), text);
    assert.ok([...text].every(ch => ch.charCodeAt(0) < 128), 'bidi and line separators are escaped');
    assert.ok(lines.at(-1).includes('"Brief\\n  price: 1 PC"'));
    assert.ok(lines.at(-1).includes('\\u202e'));
    assert.ok(lines[0].startsWith('Valun - ACCEPT "bob\\nYou owe nothing."'), lines[0]);
    assert.equal(lines.at(-2), NOT_SETTLED);
  }
});

test('prepare(): a valun_set_limits call that loosens nothing has no text; prepareOrRefusal passes that through', async () => {
  const a = Agent({}, ME);
  const tighter = {max_per_deal_as_payer: 5};
  assert.deepEqual(await a.prepare('valun_set_limits', tighter), {args: tighter, text: null});
  assert.deepEqual(await a.prepareOrRefusal('valun_set_limits', tighter), [{args: tighter, text: null}, null]);
  assert.deepEqual(await a.prepareOrRefusal('valun_respond', {deal_id: 'vd_1', action: 'decline'}),
    [{args: {deal_id: 'vd_1', action: 'decline'}, text: null}, null]);
  const [prepared, refusal] = await broken().prepareOrRefusal(...ACCEPT);
  assert.deepEqual([prepared, refusal.error, refusal.message], [null, 'approval_unbound', UNBOUND]);
});

// ---------- bound to the snapshot ----------
test('snapshot: terms that do not hash to the stated hash are refused (a lying server), for accept, counter and review', async () => {
  // The server shows 5 PC terms with the hash of a genuine 500 PC offer: the owner would approve "5 PC" and the pinned
  // hash would make the client sign the 500 PC terms.
  const lying = makeDeal(makeTerms({price: 5}));
  lying.current.terms_hash = lying.agreement.terms_hash = termsHash(makeTerms({price: 500}));
  for (const [name, args] of [ACCEPT, COUNTER, REVIEW]) {
    assert.equal(await unbound(Agent(lying), name, args), 'hash_mismatch', name);
    await assert.rejects(Agent(lying).bind(name, args), e => e.code === 'approval_unbound');
  }
  assert.equal(await unbound(Agent(edited(DEAL, {current: {terms: {...DEAL.current.terms, price: {amount: 2.5}}}})), ...ACCEPT), 'bad_terms');
  assert.equal(await unbound(Agent(edited(DEAL, {current: {terms: null}})), ...ACCEPT), 'approval_unbound');
});

test('snapshot: a delivery that does not match its hashes is refused', async () => {
  assert.equal(await unbound(Agent(edited(DEAL, {delivery: {content: 'word '.repeat(450)}})), ...REVIEW), 'hash_mismatch');
  assert.equal(await unbound(Agent(edited(DEAL, {agreement: {terms_hash: termsHash(makeTerms({price: 500}))}})), ...REVIEW), 'hash_mismatch');
  for (const bad of [{content: null}, {content: 7}]) assert.equal(await unbound(Agent(edited(DEAL, {delivery: bad})), ...REVIEW), 'approval_unbound');
  assert.equal(await unbound(Agent(edited(DEAL, {delivery: null})), ...REVIEW), 'not_delivered');
  assert.equal(await unbound(Agent(edited(DEAL, {delivery: {content: 'lone \ud800 surrogate'}})), ...REVIEW), 'UnicodeEncodeError', 'as Python encodes it');
});

test('snapshot: the role comes from the signed terms, and what the server says about the deal must agree with them', async () => {
  assert.equal(await unbound(Agent(edited(DEAL, {your_role: 'payee'})), ...ACCEPT), 'role_mismatch');
  let text = (await Agent(edited(makeDeal(makeTerms({price: 500})), {your_role: null})).prepare(...ACCEPT)).text;
  assert.ok(text.includes('you are the payer; price: 500 PC'));
  assert.ok(text.includes('you will owe bob 500 PC'));
  const selling = makeDeal(makeTerms({price: 7, payer: BOB_ID, payee: ME_ID}));
  text = (await Agent(selling).prepare(...ACCEPT)).text;
  assert.ok(text.includes('you are the payee (you do the work); price: 7 PC'));
  assert.ok(text.includes('bob would then owe you 7 PC'));
  assert.equal(await unbound(Agent(selling), ...REVIEW), 'not_payer', 'only the payer accepts a delivery');
  for (const t of [makeTerms({payer: 'vp_c0c0c0c0c0c0'}), makeTerms({payer: ME_ID, payee: ME_ID})]) {
    assert.equal(await unbound(Agent(makeDeal(t)), ...ACCEPT), 'not_a_party');
  }
  assert.equal(await unbound(Agent(edited(DEAL, {counterparty: {id: 'vp_c0c0c0c0c0c0'}})), ...ACCEPT), 'counterparty_mismatch');
  assert.equal(await unbound(Agent(makeDeal(makeTerms({dealId: 'vd_2'}))), ...ACCEPT), 'deal_mismatch');
  assert.equal(await unbound(Agent(makeDeal(makeTerms({proposer: ME_ID}))), ...ACCEPT), 'own_offer', 'only theirs is answered');
  assert.equal(await unbound(Agent(makeDeal(makeTerms({proposer: ME_ID}))), ...COUNTER), 'own_offer');
  assert.ok((await Agent(makeDeal(makeTerms({proposer: ME_ID}))).prepare(...REVIEW)).text.includes('ISSUE A CREDIT NOTE'), 'either side proposed');
  const euros = makeTerms();
  euros.price = {amount: 20, unit: 'EUR'};
  assert.equal(await unbound(Agent(makeDeal(euros)), ...ACCEPT), 'bad_terms');
});

test('snapshot: the text shows computed values, not the server\'s claims; counter and review pin the terms hash', async () => {
  const text = (await Agent(edited(DEAL, {delivery: {bytes: 12}})).prepare(...REVIEW)).text;
  assert.ok(text.includes(`delivered: ${utf8(DEAL.delivery.content).length} bytes, sha256 ${SHA.slice(0, 16)}...`));
  assert.ok(text.includes('300-500 words: 320 words (met)'));
  assert.ok(text.includes(`agreed terms hash ${T.slice(0, 16)}...`));
  assert.ok(!text.includes('12 bytes'));
  const lines = (await Agent(DEAL).prepare(...ACCEPT)).text.split('\n');
  assert.equal(lines[0], `Valun - ACCEPT bob's offer (${BOB_ID}, deal vd_1, version 2):`);
  assert.equal(lines[1], '  you are the payer; price: 20 PC; deliver by 2099-01-02T00:00:00.000Z');
  let p = await Agent(DEAL).prepare(...COUNTER);
  assert.deepEqual(p.args, {deal_id: 'vd_1', action: 'counter', price: 30, expected_terms_hash: T});
  assert.ok(p.text.includes('price: 30 PC'));
  assert.ok(p.text.includes('your agent changes: price 20 -> 30 PC; the counter-offer stays open 24 h'));
  assert.ok(p.text.includes('as in their offer'));
  p = await Agent(DEAL).prepare('valun_respond', {deal_id: 'vd_1', action: 'counter', deliver_within_hours: 12, title: 'New'});
  assert.ok(p.text.includes('price: 20 PC'));
  assert.ok(p.text.includes('deliver within 12 h of signing'));
  assert.ok(p.text.split('\n').at(-1).includes('"title":"New"'));
  assert.ok(p.text.split('\n').at(-1).includes('"description":"Three sources."'), 'unchanged text, copied from their offer');
  p = await Agent(DEAL).prepare(...REVIEW);
  assert.deepEqual(p.args, {deal_id: 'vd_1', decision: 'accept', expected_deliverable_sha256: SHA, expected_terms_hash: T});
});

test('snapshot: a new offer is signed for the participant shown; offer texts quote the description and cut long fields', async () => {
  let p = await Agent({}, null, PEOPLE).prepare('valun_propose', {counterparty: 'BOB ', role: 'payee', title: 't', description: 'd', deliverable: 'x', price: 4});
  assert.equal(p.args.counterparty, BOB_ID, 'not the name: it could resolve differently later');
  assert.ok(p.text.includes(`NEW OFFER to bob (${BOB_ID})`));
  assert.ok(p.text.includes('you are the payee (you do the work); price: 4 PC'));
  p = await Agent({}, null, PEOPLE).prepare('valun_propose', {counterparty: 'bob', role: 'payer', title: 't', deliverable: 'x',
    description: 'Count the words of: TEXT: hello', price: 3});
  assert.equal(p.text.split('\n').at(-1), 'Offer text written by your agent (quoted exactly): '
    + '{"title":"t","description":"Count the words of: TEXT: hello","deliverable":"x"}');
  const long = makeDeal(makeTerms({service: {title: 'T', description: 'a'.repeat(2500), deliverable: 'x'}}));
  const last = (await Agent(long).prepare(...ACCEPT)).text.split('\n').at(-1);
  assert.ok(last.startsWith('Offer text written by bob (quoted exactly; fields over 2000 characters are cut to their first 2000): '), last);
  assert.ok(last.includes('"description":"' + 'a'.repeat(2000) + '"'));
  assert.ok(!last.includes('a'.repeat(2001)));
  const emoji = makeDeal(makeTerms({service: {title: 'T', description: '\u{1F600}'.repeat(2001), deliverable: 'x'}}));
  const cut = (await Agent(emoji).prepare(...ACCEPT)).text.split('\n').at(-1);
  assert.equal(cut.split('\\ud83d\\ude00').length - 1, 2000, 'cut by code points, as Python counts them');
});

// ---------- end to end, with real signatures ----------
const INFO = {network: NETWORK, protocol: PROTOCOL, unit: 'PC', tracker_nft_id: NFT, denomination: DENOM};

/** Bob's genuinely signed open offer to Alice, as the server shows it. */
function offer(price, title = 'Brief') {
  const t = makeTerms({price, version: 1, service: {title, description: 'Three sources.', deliverable: 'markdown'}});
  const h = termsHash(t);
  return {id: 'vd_1', status: 'open', your_role: 'payer', counterparty: {id: BOB_ID, handle: 'bob'},
    current: {version: 1, by: BOB_ID, state: 'open', terms: t, terms_hash: h, signature: signText(BOB, statements.propose(h))}};
}

/** A fake server for offers: `views` are the deal as successive GETs show it (the last one repeats). */
function desk(views) {
  const d = {views, posts: [], reads: 0};
  d.fetch = async (url, init = {}) => {
    const p = url.slice(SERVER.length), method = init.method || 'GET';
    if (p === '/pilot/v1/info') return jsonResponse(200, INFO);
    if (p === `/pilot/v1/participants/${BOB_ID}`) return jsonResponse(200, {id: BOB_ID, handle: 'bob', status: 'active', pubkey: BOB.pubkey});
    if (method === 'GET' && p === '/pilot/v1/deals/vd_1') return jsonResponse(200, d.views[Math.min(++d.reads, d.views.length) - 1]);
    if (method === 'POST') {
      d.posts.push([p, JSON.parse(init.body)]);
      return jsonResponse(200, {id: 'vd_1', status: p.endsWith('/accept') ? 'agreed' : 'open'});
    }
    return jsonResponse(404, {error: 'not_found', message: p});
  };
  return d;
}

const aliceAgent = d => new ValunAgent(new Client({store: new MemoryStore({state: {participant_id: ME_ID, pubkey: ALICE.pubkey, issued: {}},
  secret: bytesToHex(ALICE.secret), token: 'vpa_test-only'}), server: SERVER, fetch: d.fetch, now: () => Date.parse('2026-11-08T12:00:00Z')}));

test('end to end: an approved acceptance signs exactly the terms shown', async () => {
  const d = desk([offer(500)]);
  const a = aliceAgent(d);
  const p = await a.prepare(...ACCEPT);
  assert.ok(p.text.includes('price: 500 PC'));
  await a.call('valun_respond', p.args);
  const [[pth, body]] = d.posts;
  const h = termsHash(offer(500).current.terms);
  assert.deepEqual([pth, body.terms_hash], ['/pilot/v1/deals/vd_1/accept', h]);
  assert.ok(basis.verifyHex(body.signature, utf8(statements.accept(h)), ALICE.pubkey));
});

test('end to end: a lying snapshot is refused, and terms that change after the snapshot are not signed', async () => {
  const lying = offer(5, 'Cheap job');
  lying.current.terms_hash = offer(500).current.terms_hash;     // the hash (and signature) of the 500 PC offer
  lying.current.signature = offer(500).current.signature;
  for (const [name, args] of [ACCEPT, COUNTER]) {
    const d = desk([lying, offer(500)]);
    assert.equal(await unbound(aliceAgent(d), name, args), 'hash_mismatch');
    assert.deepEqual(d.posts, []);
  }
  for (const [name, args] of [ACCEPT, COUNTER]) {              // a consistent 5 PC snapshot; when signing, a genuine 500 PC offer
    const d = desk([offer(5), offer(500)]);
    const a = aliceAgent(d);
    const p = await a.prepare(name, args);
    assert.ok(p.text.includes(args.action === 'accept' ? 'price: 5 PC' : 'price 5 -> 30 PC'), p.text);
    await assert.rejects(a.call(name, p.args), e => e.code === 'stale_terms', name);
    assert.deepEqual(d.posts, []);
  }
});

// ---------- adapters ----------
test('valunTools(): a lying snapshot is refused without asking; a good one asks with the prepared text and signs the bound arguments', async () => {
  const lying = offer(5, 'Cheap job');
  lying.current.terms_hash = offer(500).current.terms_hash;
  lying.current.signature = offer(500).current.signature;
  const asked = [];
  const approve = async (text, name, args) => { asked.push({text, name, args}); return true; };
  let d = desk([lying, offer(500)]);
  let r = await valunTools(aliceAgent(d), {approve}).find(t => t.name === 'valun_respond').execute(ACCEPT[1]);
  assert.deepEqual([r.error, r.message, asked.length, d.posts.length], ['approval_unbound', UNBOUND, 0, 0]);
  d = desk([offer(500)]);
  r = await valunTools(aliceAgent(d), {approve}).find(t => t.name === 'valun_respond').execute(ACCEPT[1]);
  assert.equal(r.status, 'agreed');
  assert.equal(asked.length, 1);
  assert.match(asked[0].text, new RegExp(`^Valun - ACCEPT bob's offer \\(${BOB_ID}, deal vd_1, version 1\\):`));
  const h = termsHash(offer(500).current.terms);
  assert.deepEqual(asked[0].args, {deal_id: 'vd_1', action: 'accept', expected_terms_hash: h});
  assert.equal(d.posts[0][1].terms_hash, h);
});

test('valunTools(): a call the read shows commits nothing runs without asking, even when classified as a commitment', async () => {
  // isCommitment could not read /me (so it says ask); prepare()'s own read shows the limit only tightens.
  const c = new FakeClient({me: ME});
  c.setLimits = async body => ({agent_limits: body, effective_limits: body});
  const a = new ValunAgent(c);
  a.isCommitment = async () => true;
  const asked = [];
  const r = await valunTools(a, {approve: async text => { asked.push(text); return false; }})
    .find(t => t.name === 'valun_set_limits').execute({max_per_deal_as_payer: 5});
  assert.equal(asked.length, 0);
  assert.deepEqual(r.recorded, {max_issue_per_deal: 5});
  // an agent whose prepareOrRefusal throws or answers nonsense is refused too
  for (const bad of [async () => { throw new Error('boom'); }, async () => [{args: 'x'}, null]]) {
    const b = new ValunAgent(new FakeClient({deal: DEAL}));
    b.prepareOrRefusal = bad;
    const out = await valunTools(b, {approve: async () => true}).find(t => t.name === 'valun_respond').execute(ACCEPT[1]);
    assert.equal(out.error, 'approval_unbound');
  }
});
