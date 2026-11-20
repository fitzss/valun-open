// Fix inbox #192/#196 (offline, real signatures), the JavaScript twin of python/tests/test_payment_issuer.py, against a
// fake Valun server: an offer can name the payment issuer, the participant whose note the payer will pass to the payee
// (payment_issuer {id, pubkey} in the signed terms).
//   - valun_propose and valun_respond counter take pay_with (a handle or id) and sign payment_issuer into the terms; a
//     counter without it keeps the issuer of the offer it answers, 'own_note' drops it; terms without it are as before;
//   - the payee sees it before it agrees: valun_deal and valun_inbox say what it means, and the approval texts name it;
//   - the client refuses terms that name a party, or the issuer under another key; terms with any other unknown field
//     stay refused;
//   - valun_review_delivery accept on such a deal pays with the named issuer when pay_with is left out, and refuses the
//     payer's own note (terms_name_payment_issuer) and another issuer (payment_issuer_mismatch) before anything is signed.
// The payee's consent loop (novation.evaluateConsent) runs test_novation.py's decision table (python-parity.test.js).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  Client, MemoryStore, NETWORK, PILOT_DENOMINATION, PROTOCOL, ValunAgent, ValunError, basis, bytesToHex, sha256Hex, statements,
  termsHash, utf8,
} from '../src/index.js';
import {jsonResponse, testKey} from './helpers.js';
import * as nv from '../src/novation.js';

const SERVER = 'https://valun.invalid';
const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const key = label => { const secret = testKey(label); return {secret, pubkey: bytesToHex(basis.publicKey(secret))}; };
const ALICE = key('test/alice'), BOB = key('test/bob'), ANN = key('test/ann'), MALLORY = key('test/mallory');
const ALICE_ID = 'vp_a1a1a1a1a1a1', BOB_ID = 'vp_b0b0b0b0b0b0', ANN_ID = 'vp_a2a2a2a2a2a2', MAL_ID = 'vp_ae0ae0ae0ae0';
const PEOPLE = {[ALICE_ID]: ['alice', ALICE], [BOB_ID]: ['bob', BOB], [ANN_ID]: ['ann', ANN], [MAL_ID]: ['mallory', MALLORY]};
const DEAL = 'vd_0123456789abcdef';
const H = 3_600_000;
const T0 = Date.parse('2026-11-13T12:00:00.000Z'), NOW = T0 + 10 * 60_000;
const iso = ms => new Date(ms).toISOString();
const signText = (k, text) => bytesToHex(basis.sign(utf8(text), k.secret));
const named = (id = ANN_ID, k = ANN) => ({id, pubkey: k.pubkey});

function terms({proposer = BOB_ID, payer = BOB_ID, payee = ALICE_ID, ...extra} = {}) {
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: DEAL, version: 1,
    prior_terms_hash: null, nonce: 'ab'.repeat(16), proposer, payer: {id: payer, pubkey: PEOPLE[payer][1].pubkey},
    payee: {id: payee, pubkey: PEOPLE[payee][1].pubkey},
    service: {title: 'Quick summary', description: 'Summarize three sources in 100 words.', deliverable: 'Plain text.'},
    price: {amount: 12, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: iso(T0 + 48 * H), offer_expires_at: iso(T0 + 24 * H), ...extra};
}

function offerView(t, {by = BOB_ID, signer = BOB} = {}) {
  const h = termsHash(t), role = t.payer.id === ALICE_ID ? 'payer' : 'payee', other = role === 'payer' ? t.payee.id : t.payer.id;
  const v = {id: DEAL, status: 'open', your_role: role, counterparty: {id: other, handle: PEOPLE[other][0]},
    current: {version: t.version, by, state: 'open', terms: t, terms_hash: h, signature: signText(signer, statements.propose(h))}, versions: [], history: []};
  if (t.payment_issuer) v.payment_issuer = {id: t.payment_issuer.id, handle: PEOPLE[t.payment_issuer.id]?.[0] ?? '?', pubkey: t.payment_issuer.pubkey, words: 'server words'};
  return v;
}

/** Alice pays Bob: Alice proposed, Bob accepted, Bob delivered. */
function deliveredView(t) {
  const h = termsHash(t), content = 'The work, exactly as agreed. '.repeat(10), dh = sha256Hex(content);
  const v = offerView(t, {by: ALICE_ID, signer: ALICE});
  Object.assign(v, {status: 'delivered', next_actions: ['pay_by_transfer', 'dispute'],
    agreement: {version: 1, terms_hash: h, proposer_signature: signText(ALICE, statements.propose(h)), acceptor_signature: signText(BOB, statements.accept(h))},
    delivery: {by: BOB_ID, sha256: dh, content, bytes: content.length, title: '', signature: signText(BOB, statements.deliver(h, content))}});
  v.current.state = 'accepted';
  return v;
}

function server(deal = null, held = [ANN_ID, MAL_ID]) {
  const s = {log: [], posts: []};
  s.fetch = async (url, init = {}) => {
    const p = url.slice(SERVER.length), method = init.method || 'GET';
    s.log.push(`${method} ${p}`);
    if (p === '/pilot/v1/info') {
      return jsonResponse(200, {network: NETWORK, protocol: PROTOCOL, unit: 'PC', tracker_nft_id: NFT, denomination: PILOT_DENOMINATION,
        features: ['bound_notes/1', 'circulation/1'], novation: {...nv.CONTRACT}});
    }
    for (const [pid, [handle, k]] of Object.entries(PEOPLE)) {
      if (p === `/pilot/v1/participants/${pid}`) return jsonResponse(200, {id: pid, handle, status: 'active', pubkey: k.pubkey});
    }
    if (p === '/pilot/v1/participants') {
      return jsonResponse(200, Object.entries(PEOPLE).map(([id, [handle]]) => ({id, handle, status: 'active', services: '', agent_last_seen: iso(NOW)})));
    }
    if (p === '/pilot/v1/me') return jsonResponse(200, {id: ALICE_ID, mandate: {}});
    if (method === 'GET' && deal && p === `/pilot/v1/deals/${DEAL}`) return jsonResponse(200, deal);
    if (method === 'GET' && p === `/pilot/v1/deals/${DEAL}/payment-options`) {
      return jsonResponse(200, {deal_id: DEAL, own_note: {available: false, why_not: 'terms_name_payment_issuer'},
        held_notes: held.map(i => ({issuer: {id: i, handle: PEOPLE[i][0]}, why_not: null, enough: true}))});
    }
    if (method === 'POST' && (p === '/pilot/v1/deals' || p === `/pilot/v1/deals/${DEAL}/counter`)) {
      const body = JSON.parse(init.body);
      s.posts.push([p, body]);
      return jsonResponse(200, {id: body.terms.deal_id, status: 'open', pending_counter: null, next_actions: ['wait'],
        current: {terms: body.terms, terms_hash: body.terms_hash}});
    }
    if (method === 'GET' && p === '/pilot/v1/inbox') {
      return jsonResponse(200, {respond: [{deal_id: DEAL, status: 'open', counterparty: 'bob', your_role: 'payee', title: 'Quick summary',
        payment_issuer: {id: ANN_ID, handle: 'ann'}}], deliver: [], review_delivery: [], awaiting_your_owner: [], waiting_on_others: [], recent_closed: []});
    }
    return jsonResponse(404, {error: 'not_found', message: p});
  };
  s.signed = () => { assert.equal(s.posts.length, 1, 'one offer sent'); return s.posts[0][1].terms; };
  return s;
}

const client = s => new Client({store: new MemoryStore({state: {participant_id: ALICE_ID, pubkey: ALICE.pubkey, issued: {}},
  secret: bytesToHex(ALICE.secret), token: 'vpa_test-only'}), server: SERVER, fetch: s.fetch, now: () => NOW});
const agent = s => new ValunAgent(client(s), {now: () => NOW, processConsents: false});
async function refusal(promise) {
  try { await promise; } catch (e) { assert.ok(e instanceof ValunError, String(e)); return e; }
  assert.fail('expected a refusal');
}
const PROPOSE = {counterparty: 'bob', role: 'payee', title: 'Quick summary', description: 'Summarize three sources in 100 words.',
  deliverable: 'Plain text.', price: 12};

test('valun_propose with pay_with signs payment_issuer into the terms; without it (or own_note) the terms are as before', async () => {
  let s = server();
  const r = await agent(s).call('valun_propose', {...PROPOSE, pay_with: 'ann'});
  const t = s.signed();
  assert.deepEqual(t.payment_issuer, named());
  assert.equal(r.terms_hash, termsHash(t));
  assert.match(r.if_agreed, /pay you by passing on 12 PC of ann's note/);
  for (const extra of [{}, {pay_with: 'own_note'}]) {
    s = server();
    await agent(s).call('valun_propose', {...PROPOSE, ...extra});
    assert.equal(Object.hasOwn(s.signed(), 'payment_issuer'), false);
  }
});

test('pay_with naming a party is refused before anything is signed', async () => {
  for (const who of ['bob', ALICE_ID]) {
    const s = server();
    const r = await agent(s).callSafe('valun_propose', {...PROPOSE, pay_with: who});
    assert.equal(r.error, 'bad_arguments', JSON.stringify(r));
    assert.match(r.message, /third participant/);
    assert.deepEqual(s.posts, []);
  }
  assert.equal((await agent(server()).callSafe('valun_propose', {...PROPOSE, pay_with: 7})).error, 'bad_arguments');
});

test("an offer's approval text names the issuer and its args pin the issuer's id", async () => {
  const p = await agent(server()).prepare('valun_propose', {...PROPOSE, role: 'payer', pay_with: 'ann'});
  assert.equal(p.args.pay_with, ANN_ID);
  assert.ok(p.text.includes(`payment issuer named in the terms: ann (${ANN_ID}): you will pay bob by passing on a note issued by `
    + `ann (${ANN_ID}) that you hold, not a note of your own`), p.text);
  assert.ok(!(await agent(server()).prepare('valun_propose', PROPOSE)).text.includes('payment issuer'));
});

test('a counter keeps, replaces or drops the issuer of the offer it answers', async () => {
  const lines = {
    none: `payment issuer named in the terms, as in their offer: ann (${ANN_ID}): bob will pay by passing you a note issued by ann (${ANN_ID})`,
    mallory: `payment issuer named in the terms: mallory (${MAL_ID}): bob will pay by passing you a note issued by mallory`,
    own_note: `your agent removes the payment issuer of their offer (ann (${ANN_ID}))`,
  };
  for (const [pw, expect] of [[null, named()], ['mallory', named(MAL_ID, MALLORY)], ['own_note', undefined]]) {
    const s = server(offerView(terms({payment_issuer: named()})));
    const a = {deal_id: DEAL, action: 'counter', price: 14, ...(pw ? {pay_with: pw} : {})};
    const p = await agent(s).prepare('valun_respond', a);
    const r = await agent(s).call('valun_respond', p.args);
    assert.equal(r.status, 'open');
    assert.deepEqual(s.signed().payment_issuer, expect, String(pw));
    assert.ok(p.text.includes(lines[pw ?? 'none']), p.text);
  }
});

test('the payee sees the issuer before it agrees: valun_deal, valun_inbox and the acceptance text', async () => {
  const s = server(offerView(terms({payment_issuer: named()})));
  const d = await agent(s).call('valun_deal', {deal_id: DEAL});
  assert.equal(d.payment_issuer.id, ANN_ID);
  assert.equal(d.payment_issuer.what_it_means, `bob will pay by passing you a note issued by ann (${ANN_ID}), not a note of its own; no `
    + 'other note pays these terms. Accepting them agrees to that; declining or countering refuses it');
  assert.equal(d.checked_by_your_client.proposer_signature_valid, true);
  const box = await agent(s).call('valun_inbox', {});
  assert.ok(box.respond[0].payment_issuer.what_it_means.includes(`bob will pay by passing you a note issued by ann (${ANN_ID})`));
  const text = (await agent(s).prepare('valun_respond', {deal_id: DEAL, action: 'accept'})).text;
  assert.ok(text.includes(`payment issuer named in the terms: ann (${ANN_ID}): bob will pay by passing you a note issued by ann (${ANN_ID})`), text);
  assert.equal(Object.hasOwn(await agent(server(offerView(terms()))).call('valun_deal', {deal_id: DEAL}), 'payment_issuer'), false);
});

test('the client refuses terms that name a party or another key, and any other unknown field as before', async () => {
  for (const [pi, code] of [[named(BOB_ID, BOB), 'bad_terms'], [named(ANN_ID, MALLORY), 'wrong_key'], [{id: ANN_ID}, 'bad_terms']]) {
    const c = client(server(offerView(terms({payment_issuer: pi}))));
    assert.equal((await refusal(c.verifyOffer(await c.deal(DEAL)))).code, code, JSON.stringify(pi));
  }
  let c = client(server(offerView(terms({payment_issuer: named()}))));
  assert.deepEqual((await c.verifyOffer(await c.deal(DEAL))).terms.payment_issuer, named());
  c = client(server(offerView(terms({pay_with: ANN_ID}))));
  assert.equal((await refusal(c.verifyOffer(await c.deal(DEAL)))).code, 'bad_terms');
});

test("paying: the own note is refused before any template; left out, pay_with is the named issuer; another issuer is refused", async () => {
  const deal = () => deliveredView(terms({proposer: ALICE_ID, payer: ALICE_ID, payee: BOB_ID, payment_issuer: named()}));
  let s = server(deal());
  let e = await refusal(client(s).complete(DEAL));
  assert.deepEqual([e.code, e.extra.payment_issuer], ['terms_name_payment_issuer', {id: ANN_ID}]);
  assert.equal((await agent(s).callSafe('valun_review_delivery', {deal_id: DEAL, decision: 'accept', pay_with: 'own_note'})).error, 'terms_name_payment_issuer');
  assert.deepEqual(s.log.filter(x => x.includes('template')), []);
  // Left out: the agent pays with ann's note (the fake server has no template, so it stops there, having asked for ann's).
  s = server(deal());
  await agent(s).callSafe('valun_review_delivery', {deal_id: DEAL, decision: 'accept'});
  assert.deepEqual(s.log.filter(x => x.includes('template')), [`GET /pilot/v1/deals/${DEAL}/transfer-template?issuer=${ANN_ID}`]);
  // Another issuer: refused before any template, by the client and by the approval path.
  s = server(deal());
  e = await refusal(client(s).payByTransfer(DEAL, 'mallory'));
  assert.deepEqual([e.code, e.extra], ['payment_issuer_mismatch', {payment_issuer: {id: ANN_ID}, issuer: MAL_ID}]);
  const [p, r] = await agent(s).prepareOrRefusal('valun_review_delivery', {deal_id: DEAL, decision: 'accept', pay_with: 'mallory'});
  assert.equal(p, null);
  assert.equal(r.error, 'approval_unbound');
  assert.deepEqual(s.log.filter(x => x.includes('template')), []);
});
