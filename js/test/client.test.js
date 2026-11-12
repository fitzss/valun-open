// The Client's own behaviour, offline: what it refuses to sign (spec 15.2), the credit-note template checks, its record
// of notes issued, HTTP and error handling, and that the key and the agent token never leave the store.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import util from 'node:util';
import {
  Client, MemoryStore, ValunError, CONSIDERATION, NETWORK, PILOT_DENOMINATION, PROTOCOL, basis, bytesToHex, hexToBytes,
  neutralize, sha256Hex, statements, termsHash, utf8,
} from '../src/index.js';
import {fakeFetch, testKey, jsonResponse} from './helpers.js';

const BASE = 'http://valun.invalid';
const key = label => { const secret = testKey(`valun-open/spec/test-key/${label}`); return {secret, pubkey: bytesToHex(basis.publicKey(secret))}; };
const A = key('alice'), B = key('bob'), C = key('carol');
const ALICE = 'vp_a1a1a1a1a1a1', BOB = 'vp_b0b0b0b0b0b0';
const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const TOKEN = 'vpa_TEST-ONLY-token-never-logged';
const sig = (k, text) => bytesToHex(basis.sign(utf8(text), k.secret));

function terms(over = {}) {
  return {
    protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: 'vd_0123456789abcdef',
    version: 1, prior_terms_hash: null, nonce: '00112233445566778899aabbccddeeff', proposer: ALICE,
    payer: {id: ALICE, pubkey: A.pubkey}, payee: {id: BOB, pubkey: B.pubkey},
    service: {title: 'Short research brief', description: 'Summarise three sources.', deliverable: 'markdown'},
    price: {amount: 20, unit: 'PC'}, consideration: CONSIDERATION,
    deliver_by: '2026-11-08T12:00:00.000Z', offer_expires_at: '2026-11-07T12:00:00.000Z', ...over,
  };
}

function offer(t = terms(), signer = A, by = ALICE) {
  const h = termsHash(t);
  return {id: t.deal_id, status: 'open', current: {version: t.version, by, terms: t, terms_hash: h, signature: sig(signer, statements.propose(h))}, pending_counter: null};
}

function agreed(t = terms()) {
  const d = offer(t), h = d.current.terms_hash;
  return {...d, status: 'agreed', agreement: {version: 1, terms_hash: h, proposer_signature: d.current.signature, acceptor_signature: sig(B, statements.accept(h))}};
}

const CONTENT = '# Brief\nThree sources.\n';
// Signed by the payee, as the server shows a delivery (since 0.4 complete() checks the payee's delivery signature).
function delivered(t = terms(), content = CONTENT) {
  const d = agreed(t);
  return {...d, status: 'delivered', delivery: {by: BOB, title: 'Brief', content, sha256: sha256Hex(content),
    signature: sig(B, statements.deliver(d.agreement.terms_hash, content))}};
}

function template(over = {}) {
  return {deal_id: 'vd_0123456789abcdef', terms_hash: termsHash(terms()), deliverable_sha256: sha256Hex(CONTENT),
    issuer_pubkey: A.pubkey, recipient_pubkey: B.pubkey, keys_as_agreed: true, prior_total: 0, price: 20, total: 20,
    timestamp: T0 - 1500, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, message_hex: '00', ...over};
}

const INFO = {network: NETWORK, protocol: PROTOCOL, unit: 'PC', denomination: PILOT_DENOMINATION, tracker_nft_id: NFT, tracker_on_chain: false};

/** A stub network: public reads, one deal, and whatever extra routes a test adds. */
function network({deal, tpl, dir = {[ALICE]: A.pubkey, [BOB]: B.pubkey}, info = INFO, extra = {}, post = {status: 200, body: {status: 'note_issued'}}} = {}) {
  return fakeFetch(k => {
    if (k in extra) return extra[k];
    if (k === 'GET /pilot/v1/info') return {body: info};
    const m = /^GET \/pilot\/v1\/participants\/(vp_\w+)$/.exec(k);
    if (m) return dir[m[1]] ? {body: {id: m[1], pubkey: dir[m[1]], status: 'active'}} : {body: {id: m[1], pubkey: null, status: 'awaiting_agent'}};
    if (deal && k === `GET /pilot/v1/deals/${deal.id}`) return {body: deal};
    if (deal && tpl && k === `GET /pilot/v1/deals/${deal.id}/credit-note-template`) return {body: tpl};
    if (k.startsWith('POST ')) return post;
    return undefined;
  }, BASE);
}

function client(who, fetch, opts = {}) {
  const k = who === ALICE ? A : who === BOB ? B : C;
  const store = new MemoryStore({state: {participant_id: who, pubkey: k.pubkey, issued: {}}, secret: bytesToHex(k.secret), token: TOKEN});
  return new Client({store, server: BASE, fetch, now: () => T0, ...opts});
}

const posts = f => f.calls.filter(c => c.key.startsWith('POST '));
async function refuses(promise, code) {
  await assert.rejects(promise, e => e instanceof ValunError && e.code === code, `expected ${code}`);
}

// ---------- complete: the credit-note template is checked, the message is recomputed ----------
test('complete(): signs the completion and a note over the recomputed 80-byte message (message_hex ignored), records the total', async () => {
  const d = delivered(), f = network({deal: d, tpl: template()});
  const c = client(ALICE, f);
  const r = await c.complete(d.id, {expectedDeliverableSha256: sha256Hex(CONTENT)});
  assert.equal(r.status, 'note_issued');
  const [p] = posts(f);
  assert.equal(p.key, `POST /pilot/v1/deals/${d.id}/complete`);
  const h = d.agreement.terms_hash;
  assert.deepEqual(Object.keys(p.body).sort(), ['credit_note', 'deliverable_sha256', 'signature', 'terms_hash']);
  assert.equal(p.body.terms_hash, h);
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.complete(h, sha256Hex(CONTENT))), A.pubkey));
  assert.equal(p.body.credit_note.total, 20);
  assert.equal(p.body.credit_note.timestamp, T0 - 1500);
  const msg = basis.noteMessage(A.pubkey, B.pubkey, 20, T0 - 1500, NFT, PILOT_DENOMINATION);
  assert.ok(basis.verifyHex(p.body.credit_note.signature, msg, A.pubkey));
  assert.equal(c.state.issued[`${A.pubkey}>${B.pubkey}`], 20);
  // the next note to the same payee key must build on 20; a template claiming 0 again is refused
  const f2 = network({deal: d, tpl: template()});
  const c2 = new Client({store: new MemoryStore({state: c.state, secret: bytesToHex(A.secret), token: TOKEN}), server: BASE, fetch: f2, now: () => T0});
  await refuses(c2.complete(d.id), 'ledger_mismatch');
  assert.equal(posts(f2).length, 0);
});

test('complete(): every template inconsistency is refused before anything is signed or sent', async () => {
  const cases = [
    ['wrong issuer', {issuer_pubkey: C.pubkey}],
    ['wrong recipient', {recipient_pubkey: C.pubkey}],
    ['wrong price', {price: 21, total: 21}],
    ['total is not prior + price', {prior_total: 5, total: 20}],
    ['string total', {total: '20'}],
    ['string prior total', {prior_total: '0', total: '020'}],
    ['other tracker', {tracker_nft_id: '00'.repeat(32)}],
    ['other unit', {denomination: 'erg'}],
    ['timestamp 11 minutes ahead', {timestamp: T0 + 11 * 60_000}],
    ['timestamp 11 minutes behind', {timestamp: T0 - 11 * 60_000}],
    ['fractional timestamp', {timestamp: T0 + 0.5}],
  ];
  for (const [name, over] of cases) {
    const f = network({deal: delivered(), tpl: template(over)});
    await refuses(client(ALICE, f).complete('vd_0123456789abcdef'), 'bad_template');
    assert.equal(posts(f).length, 0, name);
  }
});

test('complete(): refuses altered content, a changed delivery and a broken agreement', async () => {
  const d = delivered();
  let f = network({deal: {...d, delivery: {...d.delivery, content: CONTENT + 'x'}}, tpl: template()});
  await refuses(client(ALICE, f).complete(d.id), 'hash_mismatch');
  f = network({deal: d, tpl: template()});
  await refuses(client(ALICE, f).complete(d.id, {expectedDeliverableSha256: sha256Hex('other')}), 'stale_delivery');
  f = network({deal: {...d, agreement: {...d.agreement, acceptor_signature: sig(C, statements.accept(d.agreement.terms_hash))}}, tpl: template()});
  await refuses(client(ALICE, f).complete(d.id), 'bad_signature');
  f = network({deal: {...d, agreement: {...d.agreement, terms_hash: sha256Hex('x')}}, tpl: template()});
  await refuses(client(ALICE, f).complete(d.id), 'hash_mismatch');
  f = network({deal: agreed(), tpl: template()});
  await refuses(client(ALICE, f).complete(d.id), 'not_delivered');
  assert.equal(posts(f).length, 0);
});

test('complete(): after a key rotation the note credits the payee key the directory lists now; note_failed records nothing', async () => {
  const d = delivered();
  const f = network({deal: d, tpl: template({recipient_pubkey: C.pubkey, keys_as_agreed: false}), dir: {[ALICE]: A.pubkey, [BOB]: C.pubkey},
    post: {status: 200, body: {status: 'note_failed'}}});
  const c = client(ALICE, f);
  assert.equal((await c.complete(d.id)).status, 'note_failed');
  assert.ok(basis.verifyHex(posts(f)[0].body.credit_note.signature, basis.noteMessage(A.pubkey, C.pubkey, 20, T0 - 1500, NFT, PILOT_DENOMINATION), A.pubkey));
  assert.deepEqual(c.state.issued, {});
});

// ---------- verifyOffer / accept / counter ----------
test('verifyOffer(): accepts a good offer and returns the recomputed hash', async () => {
  const d = offer();
  const r = await client(BOB, network({deal: d})).verifyOffer(d);
  assert.equal(r.terms_hash, d.current.terms_hash);
  assert.equal(r.proposer_signature_valid, true);
});

test('verifyOffer(): refuses what the server is not trusted to vouch for', async () => {
  const good = offer();
  const tampered = structuredClone(good);
  tampered.current.terms.price.amount = 2;
  const cases = [
    ['hash_mismatch', tampered, {}],
    ['bad_signature', {...good, current: {...good.current, signature: sig(A, statements.accept(good.current.terms_hash))}}, {}],
    ['bad_signature', {...good, current: {...good.current, signature: 'zz'}}, {}],
    ['wrong_key', good, {dir: {[ALICE]: C.pubkey, [BOB]: B.pubkey}}],
    ['counterparty_inactive', good, {dir: {[BOB]: B.pubkey}}],
    ['wrong_tracker', good, {info: {...INFO, tracker_nft_id: '00'.repeat(32)}}],
    ['wrong_network', good, {info: {...INFO, network: 'valun-pilot-2'}}],
    ['no_offer', {id: good.id, current: null}, {}],
    ['not_a_party', offer(terms({payee: {id: 'vp_cccccccccccc', pubkey: C.pubkey}})), {}],
    ['wrong_key', offer(terms({payee: {id: BOB, pubkey: C.pubkey}})), {}],
    ['wrong_deal', {...good, id: 'vd_ffffffffffffffff'}, {}],
    ['bad_terms', offer(terms({version: 2, prior_terms_hash: null})), {}],
    ['bad_terms', {...offer(terms({version: 2, prior_terms_hash: 'ab'.repeat(32)})), versions: [{version: 1, terms_hash: 'cd'.repeat(32)}]}, {}],
  ];
  for (const [code, d, net] of cases) {
    await refuses(client(BOB, network({deal: d, ...net})).verifyOffer(d), code);
  }
  await refuses(client(BOB, network({deal: good}), {now: () => Date.parse('2026-11-07T12:00:01.000Z')}).verifyOffer(good), 'expired');
  await refuses(client(BOB, network({deal: good}), {pin: {trackerNftId: 'ab'.repeat(32)}}).verifyOffer(good), 'wrong_tracker');
  await refuses(client(BOB, network({deal: good}), {pin: {denomination: 'erg'}}).verifyOffer(good), 'wrong_tracker');
  const r = await client(BOB, network({deal: good}), {pin: {trackerNftId: NFT, denomination: PILOT_DENOMINATION}}).verifyOffer(good);
  assert.equal(r.terms_hash, good.current.terms_hash);
});

test('accept(): signs the recomputed hash; refuses an offer that changed since it was inspected', async () => {
  const d = offer();
  let f = network({deal: d});
  await client(BOB, f).accept(d.id, {expectedTermsHash: d.current.terms_hash});
  const [p] = posts(f);
  assert.deepEqual(Object.keys(p.body).sort(), ['signature', 'terms_hash']);
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.accept(d.current.terms_hash)), B.pubkey));
  f = network({deal: d});
  await refuses(client(BOB, f).accept(d.id, {expectedTermsHash: sha256Hex('old')}), 'stale_terms');
  assert.equal(posts(f).length, 0);
});

test('counter(): version + 1, prior = the verified hash, carried-over fields, a fresh nonce, same deal id', async () => {
  const d = offer();
  const f = network({deal: d});
  const bytes = [hexToBytes('ab'.repeat(16))];
  await client(BOB, f, {randomBytes: n => { assert.equal(n, 16); return bytes.shift(); }}).counter(d.id, {price: 15});
  const [p] = posts(f);
  assert.equal(p.key, `POST /pilot/v1/deals/${d.id}/counter`);
  const t = p.body.terms;
  assert.equal(t.version, 2);
  assert.equal(t.prior_terms_hash, d.current.terms_hash);
  assert.equal(t.deal_id, d.id);
  assert.equal(t.nonce, 'ab'.repeat(16));
  assert.equal(t.proposer, BOB);
  assert.deepEqual(t.payer, d.current.terms.payer);
  assert.deepEqual(t.payee, d.current.terms.payee);
  assert.deepEqual(t.service, d.current.terms.service);
  assert.deepEqual(t.price, {amount: 15, unit: 'PC'});
  assert.equal(t.deliver_by, '2026-11-08T12:00:00.000Z');   // the remaining 48 h carried over, whole hours
  assert.equal(t.offer_expires_at, '2026-11-07T12:00:00.000Z');
  assert.equal(p.body.terms_hash, termsHash(t));
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.propose(termsHash(t))), B.pubkey));
});

// ---------- propose / buildTerms ----------
test('buildTerms(): the exact terms the Python client builds (field set, whole-second times, ids from the random source)', async () => {
  const draws = [hexToBytes('0123456789abcdef'), hexToBytes('00112233445566778899aabbccddeeff')];
  const c = client(ALICE, network(), {now: () => T0 + 999, randomBytes: n => draws.shift().slice(0, n)});
  const t = await c.buildTerms({counterpartyId: BOB, role: 'payer', title: 'Short research brief', description: 'Summarise three sources.',
    deliverable: 'markdown', price: 20, deliverByHours: 48, offerTtlHours: 24});
  assert.deepEqual(t, terms());
  assert.equal(draws.length, 0);
});

test('propose()/buildTerms(): refuse a bad role, a price that is not a whole number, and an agent with no key', async () => {
  const args = {counterpartyId: BOB, role: 'payer', title: 't', description: 'd', deliverable: 'x', price: 5};
  await refuses(client(ALICE, network()).propose({...args, role: 'buyer'}), 'bad_role');
  for (const price of [20.5, '1e3', -1, null, '']) await refuses(client(ALICE, network()).propose({...args, price}), 'bad_price');
  const f = network();
  await refuses(new Client({server: BASE, fetch: f}).propose(args), 'not_connected');
  assert.equal(f.calls.length, 0, 'fails before any request');
  const f2 = network({dir: {[ALICE]: A.pubkey}});
  await refuses(client(ALICE, f2).propose(args), 'counterparty_inactive');
  assert.equal(posts(f2).length, 0);
});

// ---------- decline / withdraw / deliver / dispute ----------
test('decline()/withdraw(): recompute the offer hash when the view carries terms; withdraw targets a held counter-offer', async () => {
  const d = offer();
  const tampered = structuredClone(d);
  tampered.current.terms.price.amount = 999;
  await refuses(client(BOB, network({deal: tampered})).decline(d.id, 'no'), 'hash_mismatch');
  await refuses(client(ALICE, network({deal: tampered})).withdraw(d.id), 'hash_mismatch');
  const held = offer(terms({version: 2, prior_terms_hash: d.current.terms_hash, proposer: BOB, nonce: 'ff'.repeat(16)}), B, BOB).current;
  const f = network({deal: {...d, pending_counter: held}});
  await client(BOB, f).withdraw(d.id);
  assert.equal(posts(f)[0].body.terms_hash, held.terms_hash);
  assert.ok(basis.verifyHex(posts(f)[0].body.signature, utf8(statements.withdraw(held.terms_hash)), B.pubkey));
});

test('deliver(): verifies the agreement first; signs sha256 of the content exactly as sent', async () => {
  const d = agreed();
  let f = network({deal: d});
  await client(BOB, f).deliver(d.id, '  content with padding \n', {title: 'T'});
  const [p] = posts(f);
  assert.deepEqual(p.body, {...p.body, terms_hash: d.agreement.terms_hash, content: '  content with padding \n', title: 'T', sha256: sha256Hex('  content with padding \n')});
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.deliver(d.agreement.terms_hash, '  content with padding \n')), B.pubkey));
  f = network({deal: {...d, agreement: {...d.agreement, proposer_signature: sig(C, statements.propose(d.agreement.terms_hash))}}});
  await refuses(client(BOB, f).deliver(d.id, 'x'), 'bad_signature');
  f = network({deal: offer()});
  await refuses(client(BOB, f).deliver(d.id, 'x'), 'not_agreed');
  await refuses(client(BOB, f).deliver(d.id, 42), 'bad_content');
  assert.equal(posts(f).length, 0);
});

test('dispute(): needs a verified agreement and a delivery whose content matches its hash', async () => {
  const d = delivered();
  let f = network({deal: d});
  await client(ALICE, f).dispute(d.id, 'The brief cites no sources.\n');
  const [p] = posts(f);
  assert.equal(p.body.reason, 'The brief cites no sources.\n');
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.dispute(d.agreement.terms_hash, d.delivery.sha256, 'The brief cites no sources.\n')), A.pubkey));
  f = network({deal: {...d, delivery: {...d.delivery, content: 'swapped'}}});
  await refuses(client(ALICE, f).dispute(d.id, 'bad'), 'hash_mismatch');
  f = network({deal: agreed()});
  await refuses(client(ALICE, f).dispute(d.id, 'bad'), 'not_delivered');
  await refuses(client(ALICE, f).dispute(d.id, ''), 'invalid_field');
  assert.equal(posts(f).length, 0);
});

// ---------- HTTP ----------
test('request(): server errors become ValunError(code, message, status, extra); 2xx JSON is returned', async () => {
  const f = fakeFetch({
    'GET /pilot/v1/me': {status: 403, body: {error: 'mandate_exceeded', message: 'over the limit', rule: 'max_issue_per_deal', source: 'owner_mandate'}},
    'GET /pilot/v1/inbox': {status: 502, body: {error: 'tracker unreachable'}},
    'GET /pilot/v1/deals': {status: 200, body: [{id: 'vd_1'}]},
  }, BASE);
  const c = client(ALICE, f);
  await assert.rejects(c.me(), e => e.code === 'mandate_exceeded' && e.message === 'over the limit' && e.status === 403
    && e.extra.rule === 'max_issue_per_deal' && e.extra.source === 'owner_mandate' && !('error' in e.extra));
  await assert.rejects(c.inbox(), e => e.code === 'tracker unreachable' && e.message === 'tracker unreachable' && e.status === 502);
  assert.deepEqual(await c.deals(), [{id: 'vd_1'}]);
  const html = async () => new Response('<html>oops</html>', {status: 500});
  await assert.rejects(client(ALICE, html).me(), e => e.code === 'http_error' && e.message === 'HTTP 500' && e.status === 500);
  const notJson = async () => new Response('not json', {status: 200});
  await assert.rejects(client(ALICE, notJson).me(), e => e.code === 'bad_response');
});

test('request(): Authorization only on authenticated routes, JSON content type only with a body, redirects refused', async () => {
  const f = fakeFetch(() => ({body: {ok: true}}), BASE);
  const c = client(ALICE, f);
  await c.me();
  await c.info();
  await c.participant('vp_9850bb41e214');
  await c.setLimits({max_issue_per_deal: 5});
  const [me, info, part, limits] = f.calls;
  assert.equal(me.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(info.headers.Authorization, undefined);
  assert.equal(part.headers.Authorization, undefined);
  assert.equal(limits.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(me.headers['Content-Type'], undefined);
  assert.equal(limits.headers['Content-Type'], 'application/json');
  assert.equal(limits.init.method, 'PUT');
  assert.deepEqual(limits.body, {max_issue_per_deal: 5});
  for (const call of f.calls) assert.equal(call.init.redirect, 'error');
  assert.equal(part.url, `${BASE}/pilot/v1/participants/vp_9850bb41e214`);
  await c.deal('vd_../../admin');
  assert.equal(f.calls.at(-1).url, `${BASE}/pilot/v1/deals/vd_..%2F..%2Fadmin`, 'ids are path-encoded');
});

test('request(): unreachable server, timeout, no server configured', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(client(ALICE, down).me(), e => e.code === 'unreachable' && /fetch failed/.test(e.message));
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));
  await assert.rejects(client(ALICE, hang, {timeoutMs: 20}).me(), e => e.code === 'unreachable' && /timed out/.test(e.message));
  await assert.rejects(new Client({fetch: hang}).info(), e => e.code === 'not_configured');
  const c = new Client({server: 'https://example.invalid///', fetch: hang});
  assert.equal(c.state.server, 'https://example.invalid');
});

test('503 signer_unavailable: thrown by default; with signerRetries the identical signed request is sent again', async () => {
  const outage = {status: 503, body: {error: 'signer_unavailable', message: 'signature checking is temporarily unavailable; nothing was recorded; try again'}};
  const flaky = answers => fakeFetch(k => (k === 'POST /pilot/v1/deals' ? answers.shift() : k === 'GET /pilot/v1/info' ? {body: INFO}
    : {body: {id: BOB, pubkey: B.pubkey, status: 'active'}}), BASE);
  const args = {counterpartyId: BOB, role: 'payer', title: 't', description: 'd', deliverable: 'x', price: 5};
  let f = flaky([outage, {status: 201, body: {status: 'open'}}]);
  await assert.rejects(client(ALICE, f).propose(args), e => e.code === 'signer_unavailable' && e.status === 503);
  assert.equal(posts(f).length, 1);
  f = flaky([outage, outage, {status: 201, body: {status: 'open'}}]);
  assert.equal((await client(ALICE, f, {signerRetries: 2, retryDelayMs: 1}).propose(args)).status, 'open');
  const sent = posts(f);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].init.body, sent[0].init.body, 'the same signed body, byte for byte');
  assert.equal(sent[2].init.body, sent[0].init.body);
  f = flaky([outage, outage]);
  await assert.rejects(client(ALICE, f, {signerRetries: 1, retryDelayMs: 1}).propose(args), e => e.code === 'signer_unavailable');
  f = flaky([{status: 503, body: {error: 'maintenance'}}]);
  await assert.rejects(client(ALICE, f, {signerRetries: 3, retryDelayMs: 1}).propose(args), e => e.code === 'maintenance');
  assert.equal(posts(f).length, 1, 'only signer_unavailable is retried');
  assert.throws(() => new Client({signerRetries: -1}), TypeError);
});

test('a null or absent reason counts as "" (as on the server): a decline is sent with "", a dispute is refused locally', async () => {
  const d = offer();
  const f = network({deal: d});
  await client(BOB, f).decline(d.id, null);
  assert.equal(posts(f)[0].body.reason, '');
  assert.ok(basis.verifyHex(posts(f)[0].body.signature, utf8(statements.decline(d.current.terms_hash, '')), B.pubkey));
  const f2 = network({deal: delivered()});
  await assert.rejects(client(ALICE, f2).dispute(d.id), e => e.code === 'invalid_field' && e.message === 'reason is required' && e.extra.local);
  await assert.rejects(client(ALICE, f2).dispute(d.id, ['x']), e => e.code === 'invalid_field' && e.message === 'reason must be text');
  assert.equal(f2.calls.length, 0);
});

// ---------- enrollment and secrets ----------
test('enroll(): generates the key locally, proves possession, stores key and token, returns neither', async () => {
  const f = fakeFetch({'POST /pilot/v1/enroll': {status: 201, body: {participant_id: ALICE, agent_token: TOKEN, network: NETWORK}}}, BASE);
  const store = new MemoryStore();
  const c = new Client({store, server: BASE, fetch: f, now: () => T0 + 1234, generateSecret: () => A.secret.slice()});
  const r = await c.enroll(ALICE, 'vpe_TESTONLYcode');
  assert.deepEqual(r, {participant_id: ALICE, pubkey: A.pubkey, network: NETWORK});
  const [p] = f.calls;
  assert.equal(p.headers.Authorization, undefined);
  assert.deepEqual(Object.keys(p.body).sort(), ['code', 'participant_id', 'pubkey', 'signature']);
  assert.ok(basis.verifyHex(p.body.signature, utf8(statements.enroll(ALICE, A.pubkey, 'vpe_TESTONLYcode')), A.pubkey));
  assert.equal(store.secret(), bytesToHex(A.secret));
  assert.equal(store.token(), TOKEN);
  assert.deepEqual(c.state, {server: BASE, participant_id: ALICE, pubkey: A.pubkey, network: NETWORK, enrolled_at: '2026-11-06T12:00:01.000Z', issued: {}});
  assert.equal(c.connected, true);
  await refuses(c.enroll(ALICE, 'again'), 'already_connected');
});

test('the signing key and the agent token never appear in state, return values, inspection, JSON or errors', async () => {
  const secretHex = bytesToHex(A.secret);
  const d = delivered();
  const f = network({deal: d, tpl: template(), extra: {'GET /pilot/v1/me': {status: 401, body: {error: 'unauthorized', message: 'no valid token'}}}});
  const store = new MemoryStore({state: {participant_id: ALICE, issued: {}}, secret: secretHex, token: TOKEN});
  const c = new Client({store, server: BASE, fetch: f, now: () => T0});
  const results = [c.pubkey, await c.complete(d.id), await c.verifyOffer(offer()).catch(e => e)];
  const err = await c.me().catch(e => e);
  assert.ok(err instanceof ValunError);
  const seen = [JSON.stringify(c), JSON.stringify(store), JSON.stringify(c.state), JSON.stringify(results), JSON.stringify(err),
    String(err), err.stack, util.inspect(c, {showHidden: true, depth: Infinity, getters: true}),
    util.inspect(store, {showHidden: true, depth: Infinity, getters: true}), util.inspect(err, {showHidden: true, depth: Infinity})];
  for (const s of seen) {
    assert.ok(!s.includes(secretHex), 'secret key leaked');
    assert.ok(!s.includes(TOKEN), 'token leaked');
  }
  assert.equal(c.pubkey, A.pubkey, 'pubkey is derived from the secret');
});

test('neutralize(): controls, bidi, zero-width, tag characters and lone surrogates become visible markers; TAB/LF/CR stay', () => {
  const s = ['a', String.fromCodePoint(0x202e), 'b', String.fromCodePoint(0x2028), 'c\td\ne\r', String.fromCodePoint(0xe0041), String.fromCharCode(0xd800), String.fromCodePoint(0x7)].join('');
  assert.equal(neutralize(s), 'a\\u{202E}b\\u{2028}c\td\ne\r\\u{E0041}\\u{D800}\\u{0007}');
  assert.equal(neutralize('plain caf\u{E9} \u{1F642}'), 'plain caf\u{E9} \u{1F642}');
});

test('a stub fetch helper sanity check: unknown routes answer 599 (never a real network call)', async () => {
  const r = await fakeFetch({})(`${BASE}/x`, {method: 'GET'});
  assert.equal(r.status, 599);
  assert.equal((await jsonResponse(200, {a: 1}).json()).a, 1);
});

test('Client.fresh(): the same store and settings, features of its own, state changes in one queue with its parent', async () => {
  const state = {server: 'https://h', participant_id: 'vp_a', pubkey: null, issued: {}};
  const answers = {'GET /pilot/v1/info': {body: {network: 'n', features: ['circulation/1']}}};
  const fetch = async (url, init) => {
    const key = `${init?.method || 'GET'} ${new URL(url).pathname}`;
    const a = answers[key] || {status: 404, body: {error: 'not_found', message: key}};
    return new Response(JSON.stringify(a.body), {status: a.status || 200, headers: {'content-type': 'application/json'}});
  };
  let saves = 0, inSave = 0, most = 0;
  const store = new MemoryStore({state, secret: '11'.repeat(32), token: 't'});
  store.save = async () => {
    most = Math.max(most, ++inSave);
    saves++;
    await new Promise(r => setTimeout(r, 5));
    inSave--;
  };
  const parent = new Client({store, server: 'https://h', fetch, declareRoles: false});
  const child = parent.fresh();
  assert.ok(child instanceof Client);
  assert.notEqual(child, parent);
  assert.equal(child.state, parent.state);
  assert.equal(child.connected, true);
  assert.equal(child.declareRoles, false);
  await child.info();
  assert.deepEqual(child.advertised, ['circulation/1']);
  assert.deepEqual(parent.advertised, [], "the child's GET /info is its own");
  assert.deepEqual(parent.fresh().advertised, [], 'a new one starts with none');
  await Promise.all([parent.markConsentsRun(1), child.markConsentsRun(2, 'consents_last_safe_run_ms'), parent.fresh().markConsentsRun(3)]);
  assert.equal(saves, 3);
  assert.equal(most, 1, 'one change at a time across parent and children');
  assert.equal(state.consents_last_run_ms, 3);
  assert.equal(state.consents_last_safe_run_ms, 2);
});

test('the public profile: join, joinSandbox and setProfile send services and wants only when given', async () => {
  const f = fakeFetch({'POST /pilot/v1/join': {status: 201, body: {participant_id: 'vp_c0c0c0c0c0c0'}},
    'POST /pilot/v1/join-sandbox': {status: 201, body: {participant_id: 'vp_c0c0c0c0c0c0'}},
    'PUT /pilot/v1/profile': {body: {participant: {handle: 'carol'}, changed: ['wants']}}}, BASE);
  const c = new Client({server: BASE, fetch: f, now: () => T0});
  await c.join({invite: 'inv', handle: 'carol', operator: 'Carol'});
  await c.join({invite: 'inv', handle: 'carol', operator: 'Carol', wants: 'translations (2 PC)'});
  await c.joinSandbox({handle: 'carol', operator: 'Carol'});
  await c.joinSandbox({handle: 'carol', operator: 'Carol', services: 'haiku (1 PC)', wants: 'reviews (2 PC)'});
  const [j1, j2, s1, s2] = f.calls.map(x => x.body);
  assert.equal('wants' in j1, false);
  assert.equal(j2.wants, 'translations (2 PC)');
  assert.deepEqual([('services' in s1), ('wants' in s1)], [false, false]);
  assert.deepEqual([s2.services, s2.wants], ['haiku (1 PC)', 'reviews (2 PC)']);
  const me = client(ALICE, f);
  await me.setProfile({wants: ''});
  assert.deepEqual(f.calls.at(-1).body, {wants: ''}, 'an empty string clears it');
  await me.setProfile({services: 'summary (2 PC)', wants: 'reports (2 PC)'});
  assert.deepEqual(f.calls.at(-1).body, {services: 'summary (2 PC)', wants: 'reports (2 PC)'});
  await refuses(me.setProfile({}), 'invalid_field');
});
