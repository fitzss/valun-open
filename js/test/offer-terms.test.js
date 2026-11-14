// Fix inbox #22 and #23 (offline, real signatures), the JavaScript twin of python/tests/test_offer_terms.py, against a
// fake Valun server that checks the times of every offer as the server does (server/lib/pilot/core.mjs validateTerms).
//
// #23: a counter-offer's default validity fits offers due within a day: 24 h at most, but never past its own delivery
// deadline nor past the end of the offer it answers. valun_respond takes offer_valid_hours for a counter-offer, and an
// offer that would stay open past its delivery deadline is refused before anything is signed (bad_arguments).
// #22: the price and the hours of valun_propose and valun_respond are JSON integers of at least 1: a fraction, a numeric
// string or a boolean is refused (bad_arguments), never truncated or replaced by a default, and the success messages name
// the amount signed. The client itself never truncates a price either (bad_price).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  COUNTER_OFFER_HOURS, Client, MemoryStore, NETWORK, PILOT_DENOMINATION, PROTOCOL, TOOL_NAMES, ValunAgent, ValunError, basis,
  bytesToHex, checkOfferHours, schemas, statements, termsHash, utf8,
} from '../src/index.js';
import {jsonResponse, testKey} from './helpers.js';

const SERVER = 'http://valun.invalid';
const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const key = label => { const secret = testKey(label); return {secret, pubkey: bytesToHex(basis.publicKey(secret))}; };
const ALICE = key('test/alice'), BOB = key('test/bob');
const ALICE_ID = 'vp_a1a1a1a1a1a1', BOB_ID = 'vp_b0b0b0b0b0b0';
const DEAL = 'vd_0123456789abcdef';
const H = 3_600_000, DAY = 24 * H;
const T0 = Date.parse('2026-11-13T12:00:00.000Z');              // when Bob made his offer
const NOW = T0 + 10 * 60_000;                                    // when Alice answers it
const UNBOUND = 'could not read what you would sign; nothing was signed';
const iso = ms => new Date(ms).toISOString();
const signText = (k, text) => bytesToHex(basis.sign(utf8(text), k.secret));

/** Bob's (the buyer's) signed offer to Alice (the seller), made at T0: due deliverH and open openH hours later. */
function offer(deliverH, openH, {price = 12, expires = null} = {}) {
  const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: DEAL, version: 1,
    prior_terms_hash: null, nonce: 'ab'.repeat(16), proposer: BOB_ID, payer: {id: BOB_ID, pubkey: BOB.pubkey},
    payee: {id: ALICE_ID, pubkey: ALICE.pubkey},
    service: {title: 'Quick summary', description: 'Summarize three sources in 100 words.', deliverable: 'Plain text.'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: iso(T0 + deliverH * H), offer_expires_at: expires ?? iso(T0 + openH * H)};
  const h = termsHash(t);
  return {id: DEAL, status: 'open', your_role: 'payee', counterparty: {id: BOB_ID, handle: 'bob'},
    current: {version: 1, by: BOB_ID, state: 'open', terms: t, terms_hash: h, signature: signText(BOB, statements.propose(h))}};
}

/** The server's own checks of an offer's times (validateTerms): a refusal, or null. */
function timesProblem(t) {
  const exp = Date.parse(t.offer_expires_at), due = Date.parse(t.deliver_by);
  if (!(exp > NOW && exp <= NOW + 7 * DAY)) return 'offer_expires_at must be in the future, at most 7 days ahead';
  if (!(due > NOW && due <= NOW + 30 * DAY)) return 'deliver_by must be in the future, at most 30 days ahead';
  if (!(due >= exp)) return 'deliver_by must not be earlier than offer_expires_at (a deal must not be agreed already overdue)';
  return null;
}

/** A fake Valun server: Bob's offer, the directory, and the server's own checks of the times of what it is sent. */
function server(deal = null) {
  const s = {log: [], posts: []};
  s.fetch = async (url, init = {}) => {
    const p = url.slice(SERVER.length), method = init.method || 'GET';
    s.log.push(`${method} ${p}`);
    if (p === '/pilot/v1/info') return jsonResponse(200, {network: NETWORK, protocol: PROTOCOL, unit: 'PC', tracker_nft_id: NFT, denomination: PILOT_DENOMINATION});
    if (p === `/pilot/v1/participants/${BOB_ID}`) return jsonResponse(200, {id: BOB_ID, handle: 'bob', status: 'active', pubkey: BOB.pubkey});
    if (p === '/pilot/v1/participants') return jsonResponse(200, [{id: BOB_ID, handle: 'bob', status: 'active', services: '', agent_last_seen: iso(NOW)}]);
    if (method === 'GET' && deal && p === `/pilot/v1/deals/${DEAL}`) return jsonResponse(200, deal);
    if (method === 'POST' && (p === '/pilot/v1/deals' || p === `/pilot/v1/deals/${DEAL}/counter`)) {
      const body = JSON.parse(init.body);
      const why = timesProblem(body.terms);
      if (why) return jsonResponse(400, {error: 'invalid_terms', message: why});
      s.posts.push([p, body]);
      return jsonResponse(200, {id: body.terms.deal_id, status: 'open', pending_counter: null, next_actions: ['wait'],
        current: {terms: body.terms, terms_hash: body.terms_hash}});
    }
    return jsonResponse(404, {error: 'not_found', message: p});
  };
  s.signed = () => {
    assert.equal(s.posts.length, 1, 'one offer sent');
    return s.posts[0][1].terms;
  };
  return s;
}

const client = s => new Client({store: new MemoryStore({state: {participant_id: ALICE_ID, pubkey: ALICE.pubkey, issued: {}},
  secret: bytesToHex(ALICE.secret), token: 'vpa_test-only'}), server: SERVER, fetch: s.fetch, now: () => NOW});
const agent = s => new ValunAgent(client(s), {now: () => NOW, processConsents: false});

async function refusal(promise) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof ValunError, String(e));
    return e;
  }
  assert.fail('expected a refusal');
}

// ---------- #23 in the client ----------
test('counter(): a price-only counter to an offer due within a day is valid terms (fix inbox #23)', async () => {
  // Bob offered at T0, due and open h hours later; Alice counters 10 minutes later with a price only. Delivery keeps his
  // deadline, rounded down to the hour (h - 1 hours from now); the counter-offer stays open as long as that.
  for (const h of [3, 6, 12, 25]) {
    const s = server(offer(h, h));
    await client(s).counter(DEAL, {price: 15});
    const t = s.signed();                       // the server's own checks of the times passed
    assert.deepEqual([t.price.amount, t.deliver_by, t.offer_expires_at], [15, iso(NOW + (h - 1) * H), iso(NOW + Math.min(24, h - 1) * H)], `${h} h`);
    assert.ok(t.offer_expires_at <= t.deliver_by);
  }
  assert.equal(COUNTER_OFFER_HOURS, 24);
});

test('counter(): one open longer than it gives to deliver is refused before signing; one never outlives the offer it answers', async () => {
  let s = server(offer(6, 6));
  let e = await refusal(client(s).counter(DEAL, {price: 15, offerTtlHours: 24}));    // the tester's repro, with the old 24 h
  assert.deepEqual([e.code, e.message], ['bad_arguments', 'the offer would stay open 24 h, longer than the 5 h it gives to '
    + 'deliver: it could be accepted after its work is due, which the server refuses. Pass offer_valid_hours of at most 5; nothing was signed']);
  assert.deepEqual(s.posts, []);
  s = server(offer(6, 6));
  e = await refusal(client(s).counter(DEAL, {price: 15, deliverByHours: 2, offerTtlHours: 3}));
  assert.match(e.message, /Pass offer_valid_hours of at most 2;/);
  assert.deepEqual(s.posts, []);
  s = server(offer(48, 1));
  await client(s).counter(DEAL, {price: 15});
  assert.deepEqual([s.signed().deliver_by, s.signed().offer_expires_at], [iso(NOW + 47 * H), iso(T0 + H)]);
  for (const ttl of [1, 2, 5]) {
    s = server(offer(6, 6));
    await client(s).counter(DEAL, {price: 15, offerTtlHours: ttl});
    assert.equal(s.signed().offer_expires_at, iso(NOW + ttl * H));
  }
  s = server(offer(48, 1));                     // given hours are not capped by the offer it answers
  await client(s).counter(DEAL, {offerTtlHours: 24});
  assert.equal(s.signed().offer_expires_at, iso(NOW + 24 * H));
  s = server(offer(6, 1, {expires: iso(NOW)})); // their offer ends now: still valid, nothing left to counter with
  e = await refusal(client(s).counter(DEAL, {price: 15}));
  assert.deepEqual([e.code, e.message], ['bad_arguments', `the offer would expire at ${iso(NOW)}, before it is sent: it must stay `
    + 'open for at least 1 h (offer_valid_hours); nothing was signed']);
  assert.deepEqual(s.posts, []);
});

test('propose()/buildTerms(): an offer open longer than it gives to deliver is refused before any read; a price is never truncated', async () => {
  const args = {counterpartyId: BOB_ID, role: 'payer', title: 't', description: 'd', deliverable: 'x', price: 5};
  let s = server();
  const e = await refusal(client(s).propose({...args, deliverByHours: 6, offerTtlHours: 24}));
  assert.equal(e.code, 'bad_arguments');
  assert.match(e.message, /longer than the 6 h it gives to deliver/);
  assert.deepEqual(s.log, []);
  await client(s).propose({...args, deliverByHours: 6, offerTtlHours: 6});
  assert.deepEqual([s.signed().deliver_by, s.signed().offer_expires_at], [iso(NOW + 6 * H), iso(NOW + 6 * H)]);
  for (const price of [1.5, true, false, 0, -2, '1.5', ' 7', '', null, 2 ** 53]) {
    s = server();
    const r = await refusal(client(s).buildTerms({...args, price}));
    assert.deepEqual([r.code, r.message], ['bad_price', 'price must be a whole number of PC, at least 1'], String(price));
    assert.deepEqual(s.log, []);
  }
  assert.deepEqual((await client(server()).buildTerms({...args, price: '12'})).price, {amount: 12, unit: 'PC'});
  assert.throws(() => checkOfferHours(7, 6), e2 => e2 instanceof ValunError && e2.code === 'bad_arguments');
  assert.equal(checkOfferHours(6, 6), undefined);
});

// ---------- through the tools ----------
const PROPOSE = {counterparty: 'bob', role: 'payer', title: 'Quick summary', description: 'Summarize three sources.', deliverable: 'Plain text.', price: 7};
const COUNTER = {deal_id: DEAL, action: 'counter'};

test('valun_respond: a price-only counter on a 6 h deal succeeds; an agent can counter a 3 h offer (the acceptance tests)', async () => {
  let s = server(offer(6, 6));
  const r = await agent(s).call('valun_respond', {...COUNTER, price: 15});
  assert.deepEqual([r.status, r.what_happened], ['open', 'Your counter-offer at 15 PC is open for the other side.']);
  const t = s.signed();
  assert.deepEqual([t.price.amount, t.deliver_by, t.offer_expires_at], [15, iso(NOW + 5 * H), iso(NOW + 5 * H)]);
  for (const args of [{...COUNTER, price: 15}, {...COUNTER, title: 'Shorter summary'}, {...COUNTER, price: 9, deliver_within_hours: 2}]) {
    s = server(offer(3, 3));
    const out = await agent(s).callSafe('valun_respond', args);
    assert.equal(out.status, 'open', JSON.stringify(out));
    assert.equal(s.signed().offer_expires_at, s.signed().deliver_by);
    assert.equal(s.signed().offer_expires_at, iso(NOW + 2 * H));
  }
});

test('valun_respond: offer_valid_hours sets how long a counter-offer stays open, never past its delivery deadline', async () => {
  let s = server(offer(6, 6));
  assert.equal((await agent(s).call('valun_respond', {...COUNTER, price: 15, offer_valid_hours: 2})).status, 'open');
  assert.equal(s.signed().offer_expires_at, iso(NOW + 2 * H));
  s = server(offer(6, 6));                      // longer than the 5 h left to deliver: refused before signing
  let r = await agent(s).callSafe('valun_respond', {...COUNTER, price: 15, offer_valid_hours: 6});
  assert.equal(r.error, 'bad_arguments');
  assert.match(r.message, /Pass offer_valid_hours of at most 5;/);
  assert.deepEqual(s.posts, []);
  s = server(offer(6, 6));                      // longer than the hours it gives: refused before anything is read
  r = await agent(s).callSafe('valun_respond', {...COUNTER, deliver_within_hours: 3, offer_valid_hours: 4});
  assert.deepEqual([r.error, s.log], ['bad_arguments', []]);
  assert.match(r.message, /Pass offer_valid_hours of at most 3;/);
});

test('valun_propose and valun_respond: the price and the hours are JSON integers of at least 1 (fix inbox #22)', async () => {
  const cases = [...['price', 'deliver_within_hours', 'offer_valid_hours'].map(k => ['valun_propose', PROPOSE, k]),
    ...['price', 'deliver_within_hours', 'offer_valid_hours'].map(k => ['valun_respond', COUNTER, k])];
  for (const [tool, base, k] of cases) {
    const units = k === 'price' ? 'PC' : 'hours';
    for (const bad of [1.5, '1000', '7', true, false, 0, -1, [7], {amount: 7}]) {
      const s = server(offer(6, 6));
      const r = await agent(s).callSafe(tool, {...base, [k]: bad});
      assert.deepEqual(r, {error: 'bad_arguments', message: `${k} must be a whole number of ${units}, at least 1 (a JSON integer), not `
        + `${JSON.stringify(bad)}; nothing was signed`}, `${tool} ${k}=${JSON.stringify(bad)}`);
      assert.deepEqual([s.log, s.posts], [[], []], 'refused before anything is read or signed');
      const e = await refusal(agent(s).prepare(tool, {...base, [k]: bad}));   // nor is the owner asked to approve it
      assert.deepEqual([e.code, e.extra.cause], ['approval_unbound', 'bad_arguments']);
    }
  }
  const r = await agent(server()).callSafe('valun_propose', {...PROPOSE, price: 'x'.repeat(100)});
  assert.equal(r.message, `price must be a whole number of PC, at least 1 (a JSON integer), not "${'x'.repeat(36)}...; nothing was signed`);
});

test('valun_propose and valun_respond: the success messages name the amount signed; a proposal open past its deadline is refused', async () => {
  let s = server();
  let r = await agent(s).call('valun_propose', PROPOSE);
  assert.equal(r.if_agreed, 'After you accept their delivery you issue them a credit note of 7 PC (you will owe them; not settled).');
  assert.deepEqual(s.signed().price, {amount: 7, unit: 'PC'});
  s = server(offer(6, 6));
  r = await agent(s).call('valun_respond', {...COUNTER, title: 'Shorter summary'});
  assert.equal(r.what_happened, 'Your counter-offer at the price of their offer is open for the other side.');
  assert.deepEqual(s.signed().price, {amount: 12, unit: 'PC'});
  s = server();
  r = await agent(s).callSafe('valun_propose', {...PROPOSE, deliver_within_hours: 6, offer_valid_hours: 24});
  assert.deepEqual(r, {error: 'bad_arguments', message: 'the offer would stay open 24 h, longer than the 6 h it gives to deliver: it '
    + 'could be accepted after its work is due, which the server refuses. Pass offer_valid_hours of at most 6; nothing was signed'});
  assert.deepEqual(s.log, []);
  assert.equal((await agent(s).call('valun_propose', {...PROPOSE, deliver_within_hours: 6, offer_valid_hours: 6})).status, 'open');
  // Without offer_valid_hours a 6 h job's offer stays open 6 h (24 h otherwise): valid terms as they are.
  s = server();
  assert.equal((await agent(s).call('valun_propose', {...PROPOSE, deliver_within_hours: 6})).status, 'open');
  assert.equal(Date.parse(s.signed().deliver_by) - Date.parse(s.signed().offer_expires_at), 0);
});

test('prepare(): the counter-offer text says how long it stays open; what the client would refuse is never put to the owner', async () => {
  const d = offer(6, 6);
  let p = await agent(server(d)).prepare('valun_respond', {...COUNTER, price: 15});
  assert.ok(p.text.includes('your agent changes: price 12 -> 15 PC; the counter-offer stays open 24 h, or less: never past its delivery '
    + `deadline, nor past ${d.current.terms.offer_expires_at}, when their offer ends`), p.text);
  p = await agent(server(d)).prepare('valun_respond', {...COUNTER, price: 15, offer_valid_hours: 2});
  assert.ok(p.text.includes('; the counter-offer stays open 2 h\n'), p.text);
  for (const args of [{...COUNTER, offer_valid_hours: 6}, {...COUNTER, deliver_within_hours: 3, offer_valid_hours: 4}]) {
    const e = await refusal(agent(server(d)).prepare('valun_respond', args));
    assert.deepEqual([e.message, e.extra.cause], [UNBOUND, 'bad_arguments'], JSON.stringify(args));
  }
  const e = await refusal(agent(server()).prepare('valun_propose', {...PROPOSE, deliver_within_hours: 6, offer_valid_hours: 24}));
  assert.equal(e.extra.cause, 'bad_arguments');
});

test('valun_respond takes offer_valid_hours (a whole number of hours, 1 to 168); the tools are the thirteen and valun_check_payer', () => {
  const props = schemas.RESPOND.parameters.properties;
  const {description, ...rest} = props.offer_valid_hours;
  assert.deepEqual(rest, {type: 'integer', minimum: 1, maximum: 168});
  assert.match(description, /^counter only: /);
  assert.deepEqual(Object.keys(props).slice(-2), ['deliver_within_hours', 'offer_valid_hours']);
  assert.deepEqual(schemas.RESPOND.parameters.required, ['deal_id', 'action']);
  assert.equal(TOOL_NAMES.length, 14);
  assert.deepEqual(TOOL_NAMES, schemas.ALL.map(t => t.name));
  assert.doesNotMatch(JSON.stringify(schemas.forNetwork(schemas.TESTNET)[5]), /\bPC\b/);
});
