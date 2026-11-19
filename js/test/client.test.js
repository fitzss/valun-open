// The Client's own behaviour, offline: what it refuses to sign (spec 15.2), the credit-note template checks, its record
// of notes issued, HTTP and error handling, and that the key and the agent token never leave the store.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {test} from 'node:test';
import util from 'node:util';
import {
  Client, MemoryStore, ValunError, CONSIDERATION, NETWORK, PILOT_DENOMINATION, PROTOCOL, basis, bytesToHex, hexToBytes,
  neutralize, sha256Hex, statements, termsHash, utf8, errorPayload,
} from '../src/index.js';
import * as clientModule from '../src/client.js';
import {REDIRECT_WHY, loopbackHost} from '../src/client.js';
import * as agentModule from '../src/agent.js';
import {PLAIN_HTTP_PROXY_TEXT, PLAIN_HTTP_TEXT, redirectedText} from '../src/agent.js';

// the RC's review, round 3: texts for a dispatcher that may proxy, and for certificate checks that are off (undefined
// before they existed, so that the test that names them fails on its assertions, not on an import)
const {PLAIN_HTTP_DISPATCHER_TEXT, TLS_UNVERIFIED_TEXT} = agentModule;
// the RC's review, round 3 (js-hostless-server-url-bypasses-both-guards): undefined before it existed, as above
const serverProblem = clientModule.serverProblem ?? (() => assert.fail('client.js has no serverProblem'));

const execFileP = util.promisify(execFile);
import {fakeFetch, testKey, jsonResponse} from './helpers.js';

// For the scripts the transport tests run in Node processes of their own: `sym`, the global dispatcher slot this
// Node's fetch reads, and setGlobal(d), which sets d there as undici's own setGlobalDispatcher does (the RC's review,
// round 5: undici 8, Node 26, keeps it in .2 and a Dispatcher1Wrapper of it in .1; undici 5 to 7 read .1).
const GLOBAL_SLOT = `const undici8 = Number.parseInt(process.versions.undici ?? '0', 10) >= 8;
    const sym = Symbol.for(undici8 ? 'undici.globalDispatcher.2' : 'undici.globalDispatcher.1');
    const setGlobal = d => {
      globalThis[sym] = d;
      const legacy = Symbol.for('undici.globalDispatcher.1');
      if (undici8 && globalThis[legacy]) globalThis[legacy] = new globalThis[legacy].constructor(d);
    };`;

const BASE = 'https://valun.invalid';
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

test('request(): a read cut on the way is sent again (three tries), a write never is (fix inbox #132)', async () => {
  const fast = {readRetryWaitsMs: [0, 0]};
  const reset = () => Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});
  // a connection reset twice, then the answer
  let n = 0;
  const flaky = async () => { if (++n < 3) throw reset(); return jsonResponse(200, INFO); };
  assert.equal((await client(ALICE, flaky, fast).info()).network, NETWORK);
  assert.equal(n, 3);
  // a body that stops arriving, every time: unreachable, connection_cut, after three tries
  n = 0;
  const cutBody = async () => { n++; return {ok: true, status: 200, text: async () => { throw new TypeError('terminated'); }}; };
  await assert.rejects(client(ALICE, cutBody, fast).me(), e => e.code === 'unreachable' && e.extra.cause === 'connection_cut'
    && !('outcome' in e.extra) && /was cut before its whole answer arrived \(terminated\) \(3 tries\)/.test(e.message));
  assert.equal(n, 3);
  // a write is sent once: its cut answer has an unknown outcome
  n = 0;
  await assert.rejects(client(ALICE, cutBody, fast).request('POST', '/pilot/v1/deals', {terms: {}}),
    e => e.code === 'unreachable' && e.extra.cause === 'connection_cut' && e.extra.outcome === 'unknown');
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(client(ALICE, async () => { n++; throw reset(); }, fast).request('POST', '/pilot/v1/deals', {}), e => e.code === 'unreachable');
  assert.equal(n, 1, 'a write is never sent again');
  // a proxy's own 502 (no Valun error), then the answer; the server's own 503 is answered at once
  const f = fakeFetch(k => (k === 'GET /pilot/v1/me' ? (++n === 1 ? {status: 502, body: '<html>Bad Gateway</html>'} : {body: {ok: 1}})
    : {status: 503, body: {error: 'tracker_unavailable', message: 'later'}}), BASE);
  n = 0;
  assert.deepEqual(await client(ALICE, f, fast).me(), {ok: 1});
  await assert.rejects(client(ALICE, f, fast).inbox(), e => e.code === 'tracker_unavailable' && e.status === 503);
  assert.equal(f.calls.filter(x => x.key === 'GET /pilot/v1/inbox').length, 1);
  // a connection that cannot be made (refused: no cause code of a cut) is not sent again
  n = 0;
  await assert.rejects(client(ALICE, async () => { n++; throw new TypeError('fetch failed'); }, fast).me(), e => e.code === 'unreachable');
  assert.equal(n, 1);
  // the default waits are 500 and 1500 ms; [] is one try; anything else is refused
  n = 0;
  await assert.rejects(client(ALICE, async () => { n++; throw reset(); }, {readRetryWaitsMs: []}).me(), e => e.code === 'unreachable');
  assert.equal(n, 1);
  for (const bad of [null, [-1], ['1'], 5]) assert.throws(() => new Client({readRetryWaitsMs: bad}), TypeError);
});

test('request(): every try of a cut read is a new fetch of the configured https URL, its token in the headers and redirects refused (the 0.7.2 candidate staging test)', async () => {
  // The Python candidate sent the same urllib Request object again, and urllib rewrites that object behind an HTTPS proxy:
  // its third try went out as plain HTTP to port 80 with the token. This client hands fetch() the URL string and a new
  // init on every try (fetch builds a new request from them), so no try can differ from the first. Node's fetch uses
  // HTTPS_PROXY only with NODE_USE_ENV_PROXY=1; with it (Node 24.21), each try was CONNECT host:443 and TLS.
  const calls = [];
  const reset = () => Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});
  const f = async (url, init) => { calls.push({url, init}); if (calls.length < 3) throw reset(); return jsonResponse(200, {ok: 1}); };
  const c = new Client({server: 'https://valun-test.invalid', fetch: f, readRetryWaitsMs: [0, 0],
    store: new MemoryStore({state: {}, token: TOKEN})});
  assert.deepEqual(await c.me(), {ok: 1});
  assert.equal(calls.length, 3);
  for (const {url, init} of calls) {
    assert.equal(url, 'https://valun-test.invalid/pilot/v1/me');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('request(): a redirect is its own error, redirected, in the Python client\'s words: never followed, nothing done, never "cannot reach" (the RC\'s review)', async () => {
  // fetch refuses it (redirect: 'error'); Node names the cause 'unexpected redirect'. 0.7.1 and the RC said
  // "cannot reach <server>: fetch failed", which reads as a lost connection.
  const words = `${BASE} answered with a redirect. This client follows no redirect, so nothing was done (${REDIRECT_WHY})`;
  let n = 0;
  const refused = async () => { n++; throw Object.assign(new TypeError('fetch failed'), {cause: new Error('unexpected redirect')}); };
  for (const method of ['GET', 'HEAD', 'POST']) {
    n = 0;
    await assert.rejects(client(ALICE, refused, {readRetryWaitsMs: [0, 0]}).request(method, '/pilot/v1/me', method === 'POST' ? {} : undefined),
      e => e.code === 'redirected' && e.status === undefined && e.extra.cause === 'redirect' && e.extra.location === null
        && e.message === words && !('outcome' in e.extra));
    assert.equal(n, 1, 'never sent again');
  }
  const r = errorPayload(new ValunError('redirected', words, undefined, {cause: 'redirect', location: null}));
  assert.equal(r.what_this_means, redirectedText(null));
  assert.match(r.what_this_means, /answered with a redirect, which your Valun client never follows, so nothing was done and nothing refused this agent/);
  assert.doesNotMatch(r.what_this_means, /not connected/);
  // where the Python client names where it pointed, the same words name it
  assert.match(redirectedText('https://valun.example'), /answered with a redirect to https:\/\/valun\.example, which/);
  assert.equal(redirectedText('https://valun.example/x?token=1'), redirectedText(null), 'an origin only');
  // end to end, through Node's own fetch: a local server that answers 301
  const srv = http.createServer((req, res) => { res.writeHead(301, {Location: 'https://elsewhere.invalid/pilot/v1/me'}); res.end(); });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const c = new Client({server: base, store: new MemoryStore({state: {}, token: TOKEN}), readRetryWaitsMs: [0, 0]});
    await assert.rejects(c.me(), e => e.code === 'redirected' && e.message.startsWith(`${base} answered with a redirect. This client follows no redirect`));
  } finally {
    srv.close();
  }
});

test('request(): no token, and no join or enrollment, goes over plain http to another machine unless VALUN_ALLOW_PLAIN_HTTP=1 (the RC\'s review)', async () => {
  const saved = process.env.VALUN_ALLOW_PLAIN_HTTP;
  delete process.env.VALUN_ALLOW_PLAIN_HTTP;
  try {
    const f = fakeFetch(() => ({body: {ok: 1}}), 'http://valun-test.invalid');
    const plain = (opts = {}) => new Client({server: 'http://valun-test.invalid', fetch: f, readRetryWaitsMs: [0, 0],
      store: new MemoryStore({state: {network: NETWORK}, token: TOKEN}), ...opts});
    const words = 'http://valun-test.invalid is plain http on another machine, so this client sends it no token, nor a join or an '
      + 'enrollment, whose answers carry one: over plain http a token crosses the network in clear text, for anyone on the way '
      + 'to read and use. Nothing was sent. Use its https:// address (https://valun-test.invalid), or, only on a network you '
      + 'trust, set VALUN_ALLOW_PLAIN_HTTP=1 to send tokens over plain http anyway';
    const refused = e => e.code === 'plain_http' && e.status === undefined && e.extra.cause === 'plain_http'
      && e.extra.opt_in === 'VALUN_ALLOW_PLAIN_HTTP' && e.message === words;
    for (const call of [c => c.me(), c => c.request('POST', '/pilot/v1/deals', {terms: {}}),
      c => c.request('GET', '/pilot/v1/owner', undefined, {token: 'vpo_TEST-ONLY'}), c => c.joinSandbox({handle: 'h-plain', operator: 'Ann'}),
      c => c.join({invite: 'x', handle: 'h-plain', operator: 'Ann'})]) {
      await assert.rejects(call(plain()), refused);
    }
    await assert.rejects(new Client({server: 'http://valun-test.invalid', fetch: f, store: new MemoryStore({state: {network: NETWORK}})})
      .enroll('vp_0a0a0a0a0a0a', 'TEST-ONLY-code'), refused);
    assert.equal(f.calls.length, 0, 'nothing was sent');
    assert.equal(errorPayload(new ValunError('plain_http', words, undefined, {cause: 'plain_http'})).what_this_means, PLAIN_HTTP_TEXT);
    // a read that carries no token, and whose answer carries none, goes
    assert.deepEqual(await plain().request('GET', '/pilot/v1/info', undefined, {auth: false}), {ok: 1});
    assert.equal(f.calls.length, 1);
    // this machine: a custom fetch's proxy settings are its own, so it is sent as asked
    for (const server of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:9']) {
      const g = fakeFetch(() => ({body: {ok: 1}}), server);
      assert.deepEqual(await new Client({server, fetch: g, store: new MemoryStore({state: {}, token: TOKEN})}).me(), {ok: 1}, server);
    }
    // only 1 opts in
    for (const v of ['0', 'yes', 'true', ' ']) {
      process.env.VALUN_ALLOW_PLAIN_HTTP = v;
      await assert.rejects(plain().me(), refused);
    }
    process.env.VALUN_ALLOW_PLAIN_HTTP = '1';
    assert.deepEqual(await plain().me(), {ok: 1});
    assert.equal(f.calls.at(-1).headers.Authorization, `Bearer ${TOKEN}`);
  } finally {
    if (saved === undefined) delete process.env.VALUN_ALLOW_PLAIN_HTTP; else process.env.VALUN_ALLOW_PLAIN_HTTP = saved;
  }
  for (const [host, mine] of [['127.0.0.1', true], ['127.8.9.10', true], ['[::1]', true], ['::1', true], ['[::ffff:127.0.0.1]', true],
    ['LocalHost', true], ['localhost.', false], ['LOCALHOST.', false], ['127.1', true], ['valun.tech', false], ['10.0.0.1', false],
    ['[::2]', false], ['127.0.0.1.example', false], ['', false], [null, false]]) {
    assert.equal(loopbackHost(host), mine, String(host));
  }
});

test('request(): a server setting that is not a URL with a host is refused before anything is sent, naming the setting (the RC\'s review, round 3)', async () => {
  // transport-security js-hostless-server-url-bypasses-both-guards: 'http:' (what `valun config server http://` stored)
  // is not a URL on its own, so neither guard judged it, but 'http:' + '/pilot/v1/me' is http://pilot/v1/me: Node's
  // fetch sent the agent and owner tokens, joins and enrollments to whatever the name 'pilot' reached, in clear text (and
  // over unverified TLS for 'https://'). The fake fetch here stands for it: it is never called.
  const HOSTLESS = ['http:', 'http:/', 'http://', 'HTTP:/', 'https:', 'https://'];
  const saved = process.env.VALUN_ALLOW_PLAIN_HTTP;
  try {
    for (const optIn of [undefined, '1']) {          // the opt-in to plain http changes nothing here
      if (optIn === undefined) delete process.env.VALUN_ALLOW_PLAIN_HTTP; else process.env.VALUN_ALLOW_PLAIN_HTTP = optIn;
      for (const server of HOSTLESS) {
        for (const given of ['client', 'profile']) {
          const f = fakeFetch(() => ({body: {ok: 1}}), 'http://pilot');
          const make = (token = TOKEN) => new Client({fetch: f, readRetryWaitsMs: [], ...(given === 'client' ? {server} : {}),
            store: new MemoryStore({state: {network: NETWORK, ...(given === 'profile' ? {server} : {})}, token})});
          const shown = JSON.stringify(given === 'client' ? server.replace(/\/+$/, '') : server);
          const words = `${given === 'client' ? 'The server option' : 'This profile\'s server'} must be an http(s) URL with a `
            + `host, such as https://valun.tech: ${shown} has no host. Nothing was sent.`;
          const refused = e => (e.code === 'unreachable' && e.extra.cause === 'not_connected' && e.extra.setting === given
            && e.message.startsWith(words)) || assert.fail(`${server} (${given}): ${e.code} ${e.message}`);
          for (const call of [c => c.me(), c => c.request('GET', '/pilot/v1/owner', undefined, {token: 'vpo_TEST-ONLY'}),
            c => c.joinSandbox({handle: 'h-nohost', operator: 'Ann'}), c => c.join({invite: 'x', handle: 'h-nohost', operator: 'Ann'}),
            c => c.info()]) {
            await assert.rejects(call(make()), refused);
          }
          await assert.rejects(make(null).enroll('vp_0a0a0a0a0a0a', 'TEST-ONLY-code'), refused);
          assert.equal(f.calls.length, 0, `nothing was sent for ${server} (${given})`);
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.VALUN_ALLOW_PLAIN_HTTP; else process.env.VALUN_ALLOW_PLAIN_HTTP = saved;
  }
  // a profile the Python CLI wrote with that server, read by a FileStore: refused the same way, the fix named
  const {FileStore} = await import('../src/file-store.js');
  const fsm = await import('node:fs'), os = await import('node:os'), pathm = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'valun-nohost-'));
  try {
    const file = pathm.join(dir, 'default.json');
    fsm.writeFileSync(file, JSON.stringify({server: 'http:', participant_id: ALICE, network: NETWORK, secret: bytesToHex(A.secret),
      agent_token: TOKEN}, null, 1));
    const f = fakeFetch(() => ({body: {ok: 1}}), 'http://pilot');
    await assert.rejects(new Client({store: new FileStore(file), fetch: f}).me(), e => e.code === 'unreachable'
      && e.message === 'This profile\'s server must be an http(s) URL with a host, such as https://valun.tech: "http:" has no '
        + 'host. Nothing was sent. Correct the profile\'s "server" (`valun --profile NAME config server URL` with the Python '
        + 'client), or give this Client a server option.');
    assert.equal(f.calls.length, 0);
  } finally {
    fsm.rmSync(dir, {recursive: true, force: true});
  }
  // a user and password: refused, and never repeated
  const g = fakeFetch(() => ({body: {ok: 1}}), 'https://valun.example');
  const withUser = 'https://TEST-ONLY-user:TEST-ONLY-pass@valun.example';
  await assert.rejects(new Client({server: withUser, fetch: g, store: new MemoryStore({state: {}, token: TOKEN})}).me(),
    e => e.code === 'unreachable' && e.message === 'The server option must be an http(s) URL with a host, such as '
      + 'https://valun.tech: it has a user name or password (before an @), which a server URL never carries, so it is not '
      + 'repeated here. Nothing was sent.' && !JSON.stringify(errorPayload(e)).includes('TEST-ONLY'));
  assert.equal(g.calls.length, 0);
  // a path is part of a server URL (a server behind a prefix): kept, on the server's own host
  const p = fakeFetch(() => ({body: {ok: 1}}), 'https://valun.example/base');
  assert.deepEqual(await new Client({server: 'https://valun.example/base/', fetch: p, store: new MemoryStore({state: {}, token: TOKEN})}).me(),
    {ok: 1});
  assert.equal(p.calls[0].url, 'https://valun.example/base/pilot/v1/me');
  // a request path joins onto the server's host unless it starts from its root: refused before anything is sent
  for (const path of ['.evil.example/x', '@evil.example/x', 'pilot/v1/me', '']) {
    await assert.rejects(new Client({server: 'https://valun.example', fetch: g, store: new MemoryStore({state: {}, token: TOKEN})})
      .request('GET', path), e => e.code === 'bad_arguments', path);
  }
  assert.equal(g.calls.length, 0);
  // the same judgement as the Python client's server_problem, on the same samples
  for (const [s, why] of [['https://valun.tech', null], ['http://127.0.0.1:8080', null], ['http://[::1]:9', null],
    ['https://valun.example/base', null], ['HTTPS://VALUN.TECH', null], ['valun.tech', 'has no scheme (a server URL starts with https://)'],
    ['ftp://x', 'is not an http:// or https:// URL'], ['http://127.0.0.1:80x', 'has a port that is not a number from 1 to 65535'],
    ['https://h?x=1', 'has a query or a fragment (? or #), which a server URL never carries'],
    ['https://bücher.example', 'has a host that is not a host name (letters, digits, dots, hyphens and underscores) or an IP address'],
    ['https://h/a b', 'has a space, a backslash or a control character in it'], ['', 'is empty'], [5, 'is not text']]) {
    assert.equal(serverProblem(s), why, String(s));
  }
});

test('request(): localhost with a final dot is another machine, so no token goes to it over plain http (the RC\'s review, round 3)', async () => {
  // transport-security localhost-trailing-dot-resolved-by-dns: 'localhost.' counted as this machine, and glibc's
  // getaddrinfo (which Node resolves through) looks that name up in DNS, so the token went in clear text to whatever the
  // DNS server named. Now it is refused as plain http to another machine, before anything is sent.
  const saved = process.env.VALUN_ALLOW_PLAIN_HTTP;
  delete process.env.VALUN_ALLOW_PLAIN_HTTP;
  try {
    for (const server of ['http://localhost.:8080', 'http://LOCALHOST.:8080']) {
      const f = fakeFetch(() => ({body: {ok: 1}}), server);
      const c = new Client({server, fetch: f, store: new MemoryStore({state: {}, token: TOKEN})});
      for (const call of [x => x.me(), x => x.joinSandbox({handle: 'h-dot', operator: 'Ann'})]) {
        await assert.rejects(call(c), e => e.code === 'plain_http' && e.extra.cause === 'plain_http'
          && e.message.startsWith(`${server} is plain http on another machine`)
          || assert.fail(`${server}: ${e.code} ${e.message}`));
      }
      assert.equal(f.calls.length, 0, `nothing was sent to ${server}`);
    }
    const g = fakeFetch(() => ({body: {ok: 1}}), 'http://localhost:8080');
    assert.deepEqual(await new Client({server: 'http://localhost:8080', fetch: g, store: new MemoryStore({state: {}, token: TOKEN})}).me(),
      {ok: 1}, 'localhost itself is this machine');
  } finally {
    if (saved === undefined) delete process.env.VALUN_ALLOW_PLAIN_HTTP; else process.env.VALUN_ALLOW_PLAIN_HTTP = saved;
  }
});

// The first line a proxy sees of a plain-http request it carries to 127.0.0.1:`port`: undici 5 to 7 tunnel it
// (CONNECT), undici 8 (Node 26) asks the proxy for the URL itself (absolute form).
const proxiedTo = port => new RegExp(`^proxy (CONNECT 127\\.0\\.0\\.1:${port} |GET http://127\\.0\\.0\\.1:${port}/)`);

test('request(): where Node\'s own fetch would send a server on this machine through a proxy (NODE_USE_ENV_PROXY), a token is not sent over plain http (the RC\'s review)', async () => {
  // Node reads NODE_USE_ENV_PROXY and HTTP_PROXY when it starts, so each case runs in a Node process of its own. Its fetch
  // takes no per-request proxy setting, so this client cannot send the server directly as the Python client does; it
  // refuses where the proxy would carry the token, and the server named in NO_PROXY (as undici reads it) goes direct.
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  const proxy = net.createServer(s => s.once('data', d => { seen.push(`proxy ${d.toString('latin1').split('\r\n')[0]}`); s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port, P = `http://127.0.0.1:${proxy.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    const c = new Client({server: process.argv[1], readRetryWaitsMs: [], store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    try { console.log(JSON.stringify({ok: await c.me()})); } catch (e) { console.log(JSON.stringify({code: e.code, message: e.message, extra: e.extra})); }`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http)$/i.test(k)));
  const run = async (env, server = `http://127.0.0.1:${port}`) => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--input-type=module', '-e', script, server], {env: {...base, ...env}, timeout: 30_000});
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  try {
    const on = {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P};
    let r = await run(on);
    assert.equal(r.code, 'plain_http', JSON.stringify(r));
    assert.equal(r.extra.via, 'proxy');
    assert.match(r.message, /is plain http on this machine, but Node's fetch sends it through the proxy HTTP_PROXY names .* Name it in NO_PROXY as its URL does \(127\.0\.0\.1\)/);
    assert.deepEqual(seen, [], 'nothing was sent, to the proxy or the server');
    assert.equal(errorPayload(new ValunError('plain_http', r.message, undefined, r.extra)).what_this_means, PLAIN_HTTP_PROXY_TEXT);
    for (const noProxy of ['127.0.0.1', `127.0.0.1:${port}`, 'localhost,127.0.0.1', '*']) {
      r = await run({...on, NO_PROXY: noProxy});
      assert.deepEqual(r, {ok: {ok: 1}}, noProxy);
      assert.deepEqual(seen, [`origin /pilot/v1/me Bearer vpa_TEST-ONLY`], noProxy);
    }
    for (const noProxy of ['localhost', '127.0.0.1:1', '::1']) {   // none of these names the server as undici reads it
      r = await run({...on, NO_PROXY: noProxy});
      assert.equal(r.code, 'plain_http', noProxy);
    }
    // opted in: through the proxy, which refuses it here, where this Node has an environment proxy (Node 18 and 20 have
    // none, whatever NODE_USE_ENV_PROXY says, so their fetch sends it directly)
    const envProxy = (await execFileP(process.execPath, ['-p', "[1, 2].some(n => globalThis[Symbol.for('undici.globalDispatcher.' + n)]?.constructor?.name === 'EnvHttpProxyAgent')"],
      {env: {...base, ...on}, timeout: 30_000})).stdout.trim() === 'true';
    r = await run({...on, VALUN_ALLOW_PLAIN_HTTP: '1'});
    assert.equal(seen.length, 1);
    assert.match(seen[0], envProxy ? proxiedTo(port) : /^origin \/pilot\/v1\/me Bearer vpa_TEST-ONLY$/);
    r = await run({HTTP_PROXY: P});                              // Node's environment proxy off: direct
    assert.deepEqual(r, {ok: {ok: 1}});
    r = await run({NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: P});    // no proxy for http: direct
    assert.deepEqual(r, {ok: {ok: 1}});
  } finally {
    origin.close();
    proxy.close();
  }
});

test('request(): the dispatcher Node\'s fetch uses decides, not the environment: an application\'s global dispatcher, a proxy Node read at its start, and certificate checks that are off (the RC\'s review, round 3)', async () => {
  // transport-security js-process-dispatcher-inherited: the client judged from NODE_USE_ENV_PROXY, HTTP_PROXY at request
  // time and the dispatcher's class name only. (a) setGlobalDispatcher(new ProxyAgent(url)), undici's usual way to proxy
  // fetch, and (b) HTTP_PROXY removed after Node started (its EnvHttpProxyAgent keeps the proxy it read) sent the token
  // for a plain-http server on this machine to the proxy in clear text; (c) NODE_TLS_REJECT_UNAUTHORIZED=0, or a global
  // Agent with connect.rejectUnauthorized false, sent it to a server whose certificate this machine does not trust.
  // Each case runs in a Node process of its own: Node reads its proxy settings when it starts, and Node exports no undici,
  // so the script takes its classes from the dispatchers Node itself made.
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  const proxy = net.createServer(s => s.once('data', d => { seen.push(`proxy ${d.toString('latin1').split('\r\n')[0]}`); s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }));
  const tlsPort = net.createServer(s => { seen.push('tls listener'); s.destroy(); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => tlsPort.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port, P = `http://127.0.0.1:${proxy.address().port}`;
  const httpsServer = `https://127.0.0.1:${tlsPort.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    ${GLOBAL_SLOT}
    const field = (o, n) => {
      if (o === null || typeof o !== 'object') return undefined;
      const k = Object.getOwnPropertySymbols(o).find(s => s.description === n);
      return k && o[k];
    };
    const mode = process.argv[2];
    let readable = null;                      // could the agent's own TLS setting be read (undici's internals)?
    if (mode === 'app-proxyagent') {          // as setGlobalDispatcher(new ProxyAgent(P)) leaves it, in an app started without proxy variables
      const p = field(globalThis[sym], 'http proxy agent');
      if (p !== undefined) setGlobal(p);
      delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    } else if (mode === 'env-cleared') {      // the app removes HTTP_PROXY after Node started
      delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    } else if (mode === 'default-agent' || mode === 'unverified-agent') {
      try { await fetch('data:,x'); } catch {}           // Node makes its default Agent
      if (mode === 'unverified-agent' && globalThis[sym]) {
        setGlobal(new globalThis[sym].constructor({connect: {rejectUnauthorized: false}}));
        readable = field(globalThis[sym], 'options')?.connect?.rejectUnauthorized === false;
      }
    }
    const c = new Client({server: process.argv[1], readRetryWaitsMs: [], timeoutMs: 5000,
      store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    const dispatcher = () => globalThis[sym]?.constructor?.name ?? null;
    try { console.log(JSON.stringify({ok: await c.me(), dispatcher: dispatcher(), readable})); }
    catch (e) { console.log(JSON.stringify({code: e.code, message: e.message, extra: e.extra, dispatcher: dispatcher(), readable})); }`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http|node_tls_reject_unauthorized)$/i.test(k)));
  const run = async (env, mode = '', server = `http://127.0.0.1:${port}`) => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, server, mode],
      {env: {...base, ...env}, timeout: 30_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  try {
    // certificate checks off: no token, nor a join or an enrollment, is sent over https (every Node)
    let r = await run({NODE_TLS_REJECT_UNAUTHORIZED: '0'}, '', httpsServer);
    assert.equal(r.code, 'tls_unverified', JSON.stringify(r));
    assert.equal(r.extra.via, 'env');
    assert.deepEqual(seen, [], 'nothing was sent');
    assert.equal(errorPayload(new ValunError('tls_unverified', r.message, undefined, r.extra)).what_this_means, TLS_UNVERIFIED_TEXT);
    r = await run({}, 'unverified-agent', httpsServer);
    if (r.readable) {                       // undici keeps the Agent's options where this client reads them (Node 24)
      assert.equal(r.code, 'tls_unverified', JSON.stringify(r));
      assert.equal(r.extra.via, 'dispatcher');
      assert.deepEqual(seen, [], 'nothing was sent');
    }
    r = await run({NODE_TLS_REJECT_UNAUTHORIZED: '1'}, '', httpsServer);    // checks on: sent, and the server is not trusted
    assert.equal(r.code, 'unreachable', JSON.stringify(r));
    assert.deepEqual(seen, ['tls listener']);
    r = await run({}, 'default-agent');                                    // Node's own Agent: direct, as before
    assert.deepEqual(r.ok, {ok: 1}, JSON.stringify(r));
    assert.ok([null, 'Agent'].includes(r.dispatcher), r.dispatcher);
    assert.deepEqual(seen, ['origin /pilot/v1/me Bearer vpa_TEST-ONLY']);
    // the proxy cases need Node's environment proxy (NODE_USE_ENV_PROXY), whose undici classes the script takes
    const on = {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P};
    r = await run(on, 'app-proxyagent');
    if (r.dispatcher !== 'ProxyAgent') return;       // a Node without NODE_USE_ENV_PROXY: no undici class to take here
    assert.equal(r.code, 'plain_http', JSON.stringify(r));
    assert.equal(r.extra.via, 'dispatcher');
    assert.match(r.message, /^http:\/\/127\.0\.0\.1:\d+ is plain http on this machine, but this process's fetch dispatcher \(ProxyAgent, set with setGlobalDispatcher\) may send it through a proxy, which would read the token in clear text/);
    assert.deepEqual(seen, [], 'nothing was sent, to the proxy or the server');
    assert.equal(errorPayload(new ValunError('plain_http', r.message, undefined, r.extra)).what_this_means, PLAIN_HTTP_DISPATCHER_TEXT);
    r = await run({...on, VALUN_ALLOW_PLAIN_HTTP: '1'}, 'app-proxyagent');    // opted in: through that proxy
    assert.match(seen[0] ?? '', /^proxy /);
    r = await run(on, 'env-cleared');
    assert.equal(r.code, 'plain_http', JSON.stringify(r));
    assert.equal(r.extra.via, 'proxy');
    assert.match(r.message, /but Node's fetch sends it through the proxy HTTP_PROXY named when Node started/);
    assert.deepEqual(seen, []);
    r = await run({...on, NO_PROXY: '127.0.0.1'}, 'env-cleared');         // NO_PROXY, read now as undici reads it: direct
    assert.deepEqual(r.ok, {ok: 1});
    r = await run({NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: P});              // Node's agent, with no proxy for http: direct
    assert.deepEqual(r.ok, {ok: 1});
  } finally {
    origin.close();
    proxy.close();
    tlsPort.close();
  }
});

test('request(): a global dispatcher composed with interceptors is not Node\'s own Agent, so over plain http a token goes to this machine through it only with VALUN_ALLOW_PLAIN_HTTP=1 (the RC\'s review, round 4)', async () => {
  // js-composed-agent-judged-as-nodes-own-agent: undici 7's Agent.compose() (Node 24's own undici) returns a Proxy whose
  // class name is still 'Agent', so the client took it for Node's own Agent and sent the token directly; but its
  // interceptors may send a request anywhere, and one that dispatched through a ProxyAgent carried the agent token to the
  // proxy in clear text. undici 6's compose made a ComposedDispatcher, refused already. Each case runs in a Node process
  // of its own, with Node's own Agent class (from the dispatcher Node made) and its compose() where Node's undici has
  // one, and on every Node the Proxy undici 7's compose makes, around Node's own Agent.
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${origin.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    ${GLOBAL_SLOT}
    try { await fetch('data:,x'); } catch {}           // Node makes its own dispatcher
    const own = globalThis[sym], hops = [], mode = process.argv[2];
    const interceptor = dispatch => (opts, handler) => { hops.push('interceptor'); return dispatch(opts, handler); };
    let made = null;
    if (mode === 'compose' && own?.constructor?.name === 'Agent' && typeof own.compose === 'function') {
      setGlobal(new own.constructor().compose(interceptor)); made = mode;
    } else if (mode === 'standin' && own?.constructor?.name === 'Agent') {      // what undici 7's compose returns
      const a = new own.constructor(), dispatch = interceptor(a.dispatch.bind(a));
      setGlobal(new Proxy(a, {get: (t, k) => (k === 'dispatch' ? dispatch : t[k])})); made = mode;
    } else if (mode === 'own-dispatch' && own?.constructor?.name === 'Agent') {  // a dispatch set on the Agent itself
      const a = new own.constructor(), dispatch = interceptor(a.dispatch.bind(a));
      a.dispatch = dispatch; setGlobal(a); made = mode;
    } else if (mode === 'env-compose' && own?.constructor?.name === 'EnvHttpProxyAgent' && typeof own.compose === 'function') {
      setGlobal(own.compose(interceptor)); made = mode;
    }
    const c = new Client({server: process.argv[1], readRetryWaitsMs: [], timeoutMs: 5000,
      store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    const name = globalThis[sym]?.constructor?.name ?? null;
    try { console.log(JSON.stringify({ok: await c.me(), made, name, hops})); }
    catch (e) { console.log(JSON.stringify({code: e.code, message: e.message, extra: e.extra, made, name, hops})); }`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http|node_tls_reject_unauthorized)$/i.test(k)));
  const run = async (mode, env = {}) => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, server, mode],
      {env: {...base, ...env}, timeout: 30_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const refused = r => {
    assert.equal(r.code, 'plain_http', JSON.stringify(r));
    assert.equal(r.extra.via, 'dispatcher');
    assert.match(r.message, /^http:\/\/127\.0\.0\.1:\d+ is plain http on this machine, but this process's fetch dispatcher \((Agent composed with interceptors|EnvHttpProxyAgent composed with interceptors|ComposedDispatcher), set with setGlobalDispatcher\) may send it through a proxy, which would read the token in clear text/);
    assert.deepEqual([r.hops, seen], [[], []], 'nothing was sent, through the interceptors or to the server');
    assert.equal(errorPayload(new ValunError('plain_http', r.message, undefined, r.extra)).what_this_means, PLAIN_HTTP_DISPATCHER_TEXT);
  };
  try {
    let r = await run('plain');                    // Node's own Agent, as Node made it: direct, as before
    assert.deepEqual([r.ok, r.name, seen], [{ok: 1}, 'Agent', ['origin /pilot/v1/me Bearer vpa_TEST-ONLY']], JSON.stringify(r));
    for (const mode of ['standin', 'own-dispatch']) {
      r = await run(mode);
      assert.deepEqual([r.made, r.name], [mode, 'Agent'], JSON.stringify(r));
      refused(r);
    }
    r = await run('compose');                      // Node's own compose(), where its undici has one (6: ComposedDispatcher)
    if (r.made === 'compose') refused(r); else assert.deepEqual(r.ok, {ok: 1}, JSON.stringify(r));
    // opted in: sent, through the interceptors
    r = await run('standin', {VALUN_ALLOW_PLAIN_HTTP: '1'});
    assert.deepEqual([r.ok, r.hops, seen], [{ok: 1}, ['interceptor'], ['origin /pilot/v1/me Bearer vpa_TEST-ONLY']], JSON.stringify(r));
    // Node's environment proxy agent, composed: NO_PROXY names the server, but an interceptor may send it elsewhere
    const env = {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1'};
    r = await run('env-compose', env);
    if (r.made === 'env-compose') {
      refused(r);
      r = await run('', env);                      // the same agent, not composed: direct
      assert.deepEqual([r.ok, r.name], [{ok: 1}, 'EnvHttpProxyAgent'], JSON.stringify(r));
    }
  } finally {
    origin.close();
  }
});

test('request(): a globalThis.fetch that is not Node\'s own is not judged by Node\'s dispatcher: over plain http a token goes to this machine through it only with VALUN_ALLOW_PLAIN_HTTP=1 or as options.fetch, and its TLS by what holds for every fetch (the RC\'s review, round 4)', async () => {
  // js-replaced-global-fetch-judged-as-nodes-own: an application replaced globalThis.fetch with a wrapper that passes a
  // dispatcher of its own (a ProxyAgent), and the client judged that fetch by the global dispatcher (Node's own Agent),
  // so the agent and owner tokens went through the application's proxy in clear text to a server on this machine. Each
  // case runs in a Node process of its own; the wrapper hands each request on to Node's own fetch, with a ProxyAgent of
  // Node's own undici where one can be taken (NODE_USE_ENV_PROXY), as the review's did.
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  const proxy = net.createServer(s => s.once('data', d => { seen.push(`proxy ${d.toString('latin1').split('\r\n')[0]}`); s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }));
  const tlsPort = net.createServer(s => { seen.push('tls listener'); s.destroy(); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => tlsPort.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${origin.address().port}`, httpsServer = `https://127.0.0.1:${tlsPort.address().port}`;
  const P = `http://127.0.0.1:${proxy.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    ${GLOBAL_SLOT}
    const field = (o, n) => {
      if (o === null || typeof o !== 'object') return undefined;
      const k = Object.getOwnPropertySymbols(o).find(s => s.description === n);
      return k && o[k];
    };
    try { await fetch('data:,x'); } catch {}           // Node makes its own dispatcher
    const nodeOwn = globalThis.fetch, hops = [], [server, mode, via] = process.argv.slice(1);
    let dispatcher, readable = null;
    if (via === 'proxyagent') {                         // the review's: a ProxyAgent of Node's own undici, in an app with no proxy variables
      const ProxyAgent = field(globalThis[sym], 'http proxy agent')?.constructor;
      const Agent = field(globalThis[sym], 'no proxy agent')?.constructor;
      if (ProxyAgent?.name !== 'ProxyAgent' || Agent?.name !== 'Agent') { console.log(JSON.stringify({skipped: true})); process.exit(0); }
      dispatcher = new ProxyAgent(process.env.LAB_PROXY);
      setGlobal(new Agent());
      delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    } else if (via === 'unverified-global') {          // a global dispatcher that checks no certificate
      setGlobal(new globalThis[sym].constructor({connect: {rejectUnauthorized: false}}));
      readable = field(globalThis[sym], 'options')?.connect?.rejectUnauthorized === false;
    }
    const wrapper = (u, init = {}) => { hops.push('wrapper'); return nodeOwn(u, dispatcher ? {...init, dispatcher} : init); };
    if (mode !== 'node') globalThis.fetch = wrapper;
    const given = mode === 'wrap-given' ? {fetch: wrapper} : mode === 'node-given' ? {fetch: nodeOwn} : {};
    const c = new Client({server, readRetryWaitsMs: [], timeoutMs: 5000, ...given,
      store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    const out = {mode, readable, hops};
    try { out.me = await c.me(); } catch (e) { Object.assign(out, {code: e.code, message: e.message, extra: e.extra}); }
    try { out.owner = await c.request('GET', '/pilot/v1/owner', undefined, {token: 'vpo_TEST-ONLY'}); } catch (e) { out.ownerCode = e.code; }
    console.log(JSON.stringify(out));`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http|node_tls_reject_unauthorized)$/i.test(k)));
  const run = async (mode, env = {}, target = server, via = '') => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, target, mode, via],
      {env: {...base, ...env}, timeout: 30_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const words = `${server} is plain http on this machine, but this process's fetch is not Node's own (an application or a `
    + 'library replaced globalThis.fetch), so this client cannot tell whether it sends it through a proxy, which would read '
    + 'the token in clear text. Nothing was sent. Give this client the fetch to use (options.fetch), use its https:// '
    + 'address, or, only if you trust that fetch, set VALUN_ALLOW_PLAIN_HTTP=1';
  const refused = r => {
    assert.equal(r.code, 'plain_http', JSON.stringify(r));
    assert.deepEqual([r.message, r.extra, r.ownerCode], [words, {cause: 'plain_http', via: 'fetch', opt_in: 'VALUN_ALLOW_PLAIN_HTTP'}, 'plain_http']);
    assert.deepEqual([r.hops, seen], [[], []], 'nothing was sent, through the wrapper, the proxy or to the server');
  };
  const sent = (r, hops) => {
    assert.deepEqual([r.me, r.owner, r.hops], [{ok: 1}, {ok: 1}, hops], JSON.stringify(r));
    assert.deepEqual(seen, ['origin /pilot/v1/me Bearer vpa_TEST-ONLY', 'origin /pilot/v1/owner Bearer vpo_TEST-ONLY']);
  };
  try {
    let r = await run('node');                     // Node's own fetch: judged by its dispatcher, Node's Agent: direct
    sent(r, []);
    r = await run('wrap');                         // a wrapper that hands each request on to Node's own fetch
    refused(r);
    assert.equal(errorPayload(new ValunError('plain_http', r.message, undefined, r.extra)).what_this_means, agentModule.PLAIN_HTTP_FETCH_TEXT);
    const on = {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P, LAB_PROXY: P};
    r = await run('wrap', on, server, 'proxyagent');   // the review's case: the wrapper sends through its own ProxyAgent
    if (!r.skipped) {
      refused(r);
      r = await run('wrap', {...on, VALUN_ALLOW_PLAIN_HTTP: '1'}, server, 'proxyagent');    // opted in: through that proxy
      assert.match(seen[0] ?? '', proxiedTo(origin.address().port), JSON.stringify(seen));
    }
    r = await run('wrap', {VALUN_ALLOW_PLAIN_HTTP: '1'});   // opted in: sent, through the wrapper
    sent(r, ['wrapper', 'wrapper']);
    r = await run('wrap-given');                   // the application's fetch passed in options.fetch: as asked
    sent(r, ['wrapper', 'wrapper']);
    r = await run('node-given');                   // Node's own fetch in options.fetch, the global one replaced: Node's own
    sent(r, []);
    // its TLS settings are unknown here: refused for what holds for every fetch in this process, as for Node's own
    r = await run('wrap', {NODE_TLS_REJECT_UNAUTHORIZED: '0'}, httpsServer);
    assert.deepEqual([r.code, r.extra?.via, r.hops, seen], ['tls_unverified', 'env', [], []], JSON.stringify(r));
    r = await run('wrap', {}, httpsServer, 'unverified-global');
    if (r.readable) assert.deepEqual([r.code, r.extra?.via, r.hops, seen], ['tls_unverified', 'dispatcher', [], []], JSON.stringify(r));
    r = await run('wrap', {}, httpsServer);       // nothing says it checks no certificate: sent, as asked
    assert.deepEqual([r.code, r.hops, seen.includes('tls listener')], ['unreachable', ['wrapper', 'wrapper'], true], JSON.stringify(r));
  } finally {
    origin.close();
    proxy.close();
    tlsPort.close();
  }
});

test('request(): the dispatcher each Node\'s fetch sends through is judged: undici 8 (Node 26) keeps it in undici.globalDispatcher.2, with a Dispatcher1Wrapper of it in .1 (the RC\'s review, round 5)', async () => {
  // js-node26-local-server-refused: the client read .1 only, so on Node 26 it judged that wrapper as an application's
  // dispatcher: once the process had made a fetch, every token for a server on this machine was refused (plain_http),
  // with no proxy anywhere and with NO_PROXY naming the server. js-node26-tls-guard-misses-undici8-dispatcher: the
  // wrapper keeps the dispatcher it sends through in a private field, so an application's global dispatcher that checks
  // no certificate, set as undici 8 sets one, went unseen, and the agent and owner tokens went to a server Node could
  // not verify. npm's undici 8 sets an older Node's .1 slot so too: there the wrapper is judged as the dispatcher in .2
  // beside it. Each case runs in a Node process of its own; where Node's undici has no Dispatcher1Wrapper (Node 18 to
  // 25) the script uses a stand-in of npm undici 8's.
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  const proxy = net.createServer(s => s.once('data', d => { seen.push(`proxy ${d.toString('latin1').split('\r\n')[0]}`); s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }));
  const tlsPort = net.createServer(s => { seen.push('tls listener'); s.destroy(); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => tlsPort.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${origin.address().port}`, httpsServer = `https://127.0.0.1:${tlsPort.address().port}`;
  const P = `http://127.0.0.1:${proxy.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    const S1 = Symbol.for('undici.globalDispatcher.1'), S2 = Symbol.for('undici.globalDispatcher.2');
    const undici8 = Number.parseInt(process.versions.undici ?? '0', 10) >= 8;
    const field = (o, n) => {
      if (o === null || typeof o !== 'object') return undefined;
      const k = Object.getOwnPropertySymbols(o).find(s => s.description === n);
      return k && o[k];
    };
    class Dispatcher1Wrapper {                 // npm undici 8's, for a Node whose undici has none: its dispatcher is private
      #dispatcher;
      constructor(d) { this.#dispatcher = d; }
      dispatch(opts, handler) { return this.#dispatcher.dispatch(opts, handler); }
      close(...a) { return this.#dispatcher.close(...a); }
      destroy(...a) { return this.#dispatcher.destroy(...a); }
    }
    const asUndici8 = d => {                   // undici 8's setGlobalDispatcher(d): d in .2, a Dispatcher1Wrapper of d in .1
      const W = undici8 ? globalThis[S1].constructor : Dispatcher1Wrapper;
      globalThis[S2] = d;
      globalThis[S1] = d instanceof W ? d : new W(d);
    };
    const [server, mode] = process.argv.slice(1);
    if (mode !== 'fresh') { try { await fetch('data:,x'); } catch {} }          // the application made a fetch first
    const own = undici8 ? globalThis[S2] : globalThis[S1];                       // Node's own dispatcher, as Node made it
    let made = null;
    if (mode === 'own-agent') {
      asUndici8(new own.constructor()); made = mode;
    } else if (mode === 'unverified') {
      asUndici8(new own.constructor({connect: {rejectUnauthorized: false}})); made = mode;
    } else if (mode === 'proxyagent') {        // a ProxyAgent of Node's own undici (its environment proxy agent's), in an app with no proxy variables
      const ProxyAgent = field(own, 'http proxy agent')?.constructor;
      if (ProxyAgent?.name === 'ProxyAgent') { asUndici8(new ProxyAgent(process.env.LAB_PROXY)); made = mode; }
      delete process.env.NODE_USE_ENV_PROXY; delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    } else if (mode === 'wrapper') {           // a Dispatcher1Wrapper itself set as the global dispatcher
      asUndici8(undici8 ? globalThis[S1] : new Dispatcher1Wrapper(own)); made = mode;
    }
    const c = new Client({server, readRetryWaitsMs: [], timeoutMs: 5000, store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    const out = {made, answers: []};
    for (const ask of [() => c.me(), () => c.request('GET', '/pilot/v1/owner', undefined, {token: 'vpo_TEST-ONLY'})]) {
      try { out.answers.push({ok: await ask()}); } catch (e) { out.answers.push({code: e.code, via: e.extra?.via, message: e.message}); }
    }
    console.log(JSON.stringify(out));`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http|node_tls_reject_unauthorized)$/i.test(k)));
  const run = async (mode, env = {}, target = server) => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, target, mode],
      {env: {...base, ...env}, timeout: 30_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const sent = (r, what) => {
    assert.deepEqual(r.answers, [{ok: {ok: 1}}, {ok: {ok: 1}}], `${what}: ${JSON.stringify(r)}`);
    assert.deepEqual(seen, ['origin /pilot/v1/me Bearer vpa_TEST-ONLY', 'origin /pilot/v1/owner Bearer vpo_TEST-ONLY'], what);
  };
  const refused = (r, code, via, words) => {
    for (const a of r.answers) {
      assert.deepEqual([a.code, a.via], [code, via], JSON.stringify(r));
      assert.match(a.message, words);
    }
    assert.deepEqual(seen, [], 'nothing was sent, to the server or to the proxy');
  };
  try {
    sent(await run('fresh'), 'a fresh process: Node makes its Agent at the first fetch, and the second request is sent too');
    sent(await run('warm'), 'after a fetch: Node\'s own Agent');
    sent(await run('warm', {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P, NO_PROXY: '127.0.0.1'}), 'NO_PROXY names the server');
    sent(await run('own-agent'), 'Node\'s own Agent, set as undici 8 sets one');
    let r = await run('unverified', {}, httpsServer);
    refused(r, 'tls_unverified', 'dispatcher', /this process's fetch dispatcher \(Agent\) does not check a server's certificate/);
    r = await run('proxyagent', {NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P, LAB_PROXY: P});
    if (r.made) refused(r, 'plain_http', 'dispatcher', /this process's fetch dispatcher \(ProxyAgent, set with setGlobalDispatcher\) may send it through a proxy/);
    // a wrapper set as the global dispatcher itself: what it sends through cannot be seen, so it may proxy
    refused(await run('wrapper'), 'plain_http', 'dispatcher', /this process's fetch dispatcher \(Dispatcher1Wrapper, set with setGlobalDispatcher\)/);
    sent(await run('wrapper', {VALUN_ALLOW_PLAIN_HTTP: '1'}), 'opted in: through the wrapper');
  } finally {
    origin.close();
    proxy.close();
    tlsPort.close();
  }
});

test('request(): a global dispatcher made with undici\'s tls option at rejectUnauthorized false checks no certificate either, so no token goes over https through it (found while fixing the RC\'s review, round 5)', async () => {
  // Only connect.rejectUnauthorized was read, so new Agent({tls: {rejectUnauthorized: false}}), whose tls settings
  // undici gives each connection under connect's own, went unseen on every Node, and the agent and owner tokens went to
  // a server whose certificate Node was not given. connect's own rejectUnauthorized wins over it, and a connect function
  // of its own replaces both: those are judged as before. Each case in a Node process of its own (GLOBAL_SLOT).
  const seen = [];
  const tlsPort = net.createServer(s => { seen.push('tls listener'); s.destroy(); });
  await new Promise(resolve => tlsPort.listen(0, '127.0.0.1', resolve));
  const httpsServer = `https://127.0.0.1:${tlsPort.address().port}`;
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    ${GLOBAL_SLOT}
    const tls = await import('node:tls');
    try { await fetch('data:,x'); } catch {}           // Node makes its default Agent
    const Agent = globalThis[sym].constructor, mode = process.argv[2];
    const connect = (o, cb) => {                       // a connect function of its own, which checks certificates
      const s = tls.connect({host: o.hostname, port: Number(o.port), servername: o.servername || undefined});
      s.once('secureConnect', () => cb(null, s));
      s.once('error', e => cb(e, null));
    };
    const off = {rejectUnauthorized: false};
    setGlobal(new Agent(mode === 'tls-off' ? {tls: off} : mode === 'connect-checks' ? {tls: off, connect: {rejectUnauthorized: true}}
      : {tls: off, connect}));
    const c = new Client({server: process.argv[1], readRetryWaitsMs: [], timeoutMs: 5000,
      store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    const out = [];
    for (const ask of [() => c.me(), () => c.request('GET', '/pilot/v1/owner', undefined, {token: 'vpo_TEST-ONLY'})]) {
      try { out.push({ok: await ask()}); } catch (e) { out.push({code: e.code, via: e.extra?.via ?? null, message: e.message}); }
    }
    console.log(JSON.stringify(out));`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http|node_tls_reject_unauthorized|node_extra_ca_certs)$/i.test(k)));
  const run = async mode => {
    seen.length = 0;
    const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, httpsServer, mode],
      {env: base, timeout: 30_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  try {
    let r = await run('tls-off');
    for (const a of r) {
      assert.deepEqual([a.code, a.via], ['tls_unverified', 'dispatcher'], JSON.stringify(r));
      assert.match(a.message, /this process's fetch dispatcher \(Agent\) does not check a server's certificate \(rejectUnauthorized: false\)/);
    }
    assert.deepEqual(seen, [], 'nothing was sent');
    for (const mode of ['connect-checks', 'connect-function']) {   // certificates checked: sent, and the handshake fails
      r = await run(mode);
      assert.deepEqual(r.map(a => [a.code, a.via]), [['unreachable', null], ['unreachable', null]], `${mode}: ${JSON.stringify(r)}`);
      assert.ok(seen.includes('tls listener'), mode);
    }
  } finally {
    tlsPort.close();
  }
});

test('request(): NO_PROXY names a server on this machine only where every undici reads it so: an entry that starts with * but not *. names none (found while fixing the RC\'s review, round 5)', async () => {
  // The client read NO_PROXY as undici 6 (Node 22) does, where '*0.0.1' is the end of a host name; undici 7 (Node 24)
  // and 8 (Node 26) read it, and undici 7 a '*' among other entries too, as no name, so with NODE_USE_ENV_PROXY=1 the
  // token for http://127.0.0.1 went directly in this client's judgement and through the proxy in Node's fetch.
  const names = clientModule.noProxyNames ?? (() => assert.fail('client.js has no noProxyNames'));
  for (const [value, host, port, named] of [['127.0.0.1', '127.0.0.1', 80, true], ['127.0.0.1:8080', '127.0.0.1', 8080, true],
    ['127.0.0.1:8080', '127.0.0.1', 80, false], ['localhost', 'localhost', 80, true], ['[::1]', '[::1]', 80, true],
    ['::1', '[::1]', 80, false], ['*', '127.0.0.1', 80, true], ['.0.0.1', '127.0.0.1', 80, true], ['*.0.0.1', '127.0.0.1', 80, true],
    ['localhost,127.0.0.1', '127.0.0.1', 80, true], ['*0.0.1', '127.0.0.1', 80, false], ['example.invalid,*', '127.0.0.1', 80, false],
    ['*host', 'localhost', 80, false], [' * ', '127.0.0.1', 80, false], ['*:80', '127.0.0.1', 80, false]]) {
    assert.equal(names(value, host, port), named, `${JSON.stringify(value)} for ${host}:${port}`);
  }
  // against the EnvHttpProxyAgent of the Node this runs on (Node 22 and later make one with NODE_USE_ENV_PROXY=1): over
  // many NO_PROXY values, what this client names, that agent never sends through the proxy. Its proxy and direct agents
  // are stubs that only record which was asked: nothing is sent.
  const client = new URL('../src/client.js', import.meta.url).href;
  const pieces = ['127.0.0.1', '127.8.9.10', 'localhost', 'LOCALHOST', '[::1]', '::1', '[::ffff:7f00:1]', '*', '.1', '*.1', '*1', '0.0.1',
    '.0.0.1', '*.0.0.1', '*0.0.1', 'host', '.host', '*host', '*.host', 'localhost.', '.localhost', '*.localhost', '*localhost', ']',
    '*]', '.]', '127.0.0.1:8080', '127.0.0.1:80', '127.0.0.1:1', 'localhost:8080', '[::1]:8080', '*:8080', '*:80', '.1:8080',
    'example.invalid', ''];
  const compare = `const {noProxyNames} = await import(${JSON.stringify(client)});
    const pieces = ${JSON.stringify(pieces)};
    const values = [...new Set([...pieces, ...pieces.map(p => ' ' + p + ' '), ...pieces.flatMap(a => pieces.map(b => a + ',' + b))])];
    const own = [2, 1].map(n => globalThis[Symbol.for('undici.globalDispatcher.' + n)]).find(d => d?.constructor?.name === 'EnvHttpProxyAgent');
    if (!own) { console.log(JSON.stringify({agent: false})); process.exit(0); }
    const field = (o, n) => Object.getOwnPropertySymbols(o).find(s => s.description === n);
    const handler = {onConnect() {}, onHeaders() {}, onData() {}, onComplete() {}, onError() {}, onRequestStart() {},
      onResponseStart() {}, onResponseData() {}, onResponseEnd() {}, onResponseError() {}};
    const route = (noProxy, host, port) => {
      const a = new own.constructor({httpProxy: 'http://127.0.0.1:9', noProxy});
      let r = null;
      a[field(a, 'no proxy agent')] = {dispatch: () => { r = 'direct'; return true; }};
      a[field(a, 'http proxy agent')] = {dispatch: () => { r = 'proxy'; return true; }};
      a.dispatch({origin: 'http://' + host + ':' + port, path: '/', method: 'GET'}, handler);
      return r;
    };
    const unsafe = [];
    let checked = 0;
    for (const v of values) {
      for (const host of ['127.0.0.1', '127.8.9.10', 'localhost', '[::1]', '[::ffff:7f00:1]']) {
        for (const port of [80, 8080]) {
          const r = route(v, host, port);
          checked += r === null ? 0 : 1;
          if (noProxyNames(v, host, port) && r !== 'direct') unsafe.push(JSON.stringify(v) + ' ' + host + ':' + port + ' -> ' + r);
        }
      }
    }
    console.log(JSON.stringify({agent: true, undici: process.versions.undici, cases: values.length * 10, checked,
      unsafe: unsafe.slice(0, 20), count: unsafe.length}));`;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options|valun_allow_plain_http)$/i.test(k)));
  const {stdout} = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', compare],
    {env: {...base, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9'}, timeout: 60_000, maxBuffer: 1 << 24});
  const c = JSON.parse(stdout.trim().split('\n').at(-1));
  if (c.agent) {
    assert.ok(c.cases > 10_000 && c.checked === c.cases, `the agent answered every case: ${JSON.stringify(c)}`);
    assert.deepEqual(c.unsafe, [], `undici ${c.undici}: ${c.count} cases named here that its agent proxies`);
  }
  // end to end: with NODE_USE_ENV_PROXY=1 those values send nothing, to the proxy or to the server
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(`origin ${req.url} ${req.headers.authorization ?? '-'}`); res.end('{"ok":1}'); });
  const proxy = net.createServer(s => s.once('data', d => { seen.push(`proxy ${d.toString('latin1').split('\r\n')[0]}`); s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `const {Client, MemoryStore} = await import(${JSON.stringify(index)});
    const c = new Client({server: process.argv[1], readRetryWaitsMs: [], timeoutMs: 5000, store: new MemoryStore({state: {}, token: 'vpa_TEST-ONLY'})});
    try { console.log(JSON.stringify({ok: await c.me()})); } catch (e) { console.log(JSON.stringify({code: e.code, via: e.extra?.via})); }`;
  try {
    for (const noProxy of ['*0.0.1', 'example.invalid,*']) {
      seen.length = 0;
      const r = await execFileP(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, `http://127.0.0.1:${origin.address().port}`],
        {env: {...base, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: noProxy}, timeout: 30_000});
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), {code: 'plain_http', via: 'proxy'}, noProxy);
      assert.deepEqual(seen, [], `${noProxy}: nothing was sent, to the proxy or the server`);
    }
  } finally {
    origin.close();
    proxy.close();
  }
});

test('request(): no answer in time is asked once (timed_out); a socket closed with no answer is connection_cut, as in Python (the 0.7.2 review)', async () => {
  const fast = {readRetryWaitsMs: [0, 0]};
  let n = 0;
  // the review's p5: a 1.5 s timeout took 6.5 s and three requests, and the words said "cannot reach"
  const hang = (url, init) => { n++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})))); };
  await assert.rejects(client(ALICE, hang, {...fast, timeoutMs: 30}).me(), e => e.code === 'unreachable' && e.extra.cause === 'timed_out'
    && !('outcome' in e.extra) && e.message === `${BASE} did not answer within 0.03 s (timed out): it may be busy, or something between this `
    + 'machine and the server held the answer, not a refusal: try again in a minute');
  assert.equal(n, 1, 'a read that timed out is not sent again');
  n = 0;
  await assert.rejects(client(ALICE, hang, {...fast, timeoutMs: 30}).request('POST', '/pilot/v1/deals', {}), e => e.extra.cause === 'timed_out'
    && e.extra.outcome === 'unknown' && /did not answer within 0\.03 s \(timed out\)\. The request was sent, so the server may have done it/.test(e.message));
  assert.equal(n, 1);
  n = 0;
  const undiciTimeout = async () => { n++; throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'UND_ERR_HEADERS_TIMEOUT'}}); };
  await assert.rejects(client(ALICE, undiciTimeout, fast).me(), e => e.extra.cause === 'timed_out');
  assert.equal(n, 1, "undici's own timeout is not sent again either");
  // the server closed the socket with no answer (undici: UND_ERR_SOCKET): a read is sent again, then connection_cut
  n = 0;
  const closed = async () => { n++; throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'UND_ERR_SOCKET', message: 'other side closed'}}); };
  await assert.rejects(client(ALICE, closed, fast).me(), e => e.code === 'unreachable' && e.extra.cause === 'connection_cut' && !('outcome' in e.extra)
    && /was cut before its whole answer arrived \(fetch failed \(UND_ERR_SOCKET\)\) \(3 tries\)$/.test(e.message));
  assert.equal(n, 3);
  // a write in the same case is sent once, and its outcome is unknown
  n = 0;
  await assert.rejects(client(ALICE, closed, fast).request('POST', '/pilot/v1/deals', {}), e => e.extra.cause === 'connection_cut'
    && e.extra.outcome === 'unknown' && /The request was sent, so the server may have done it/.test(e.message));
  assert.equal(n, 1);
  // a connection that could not be made names no cut
  await assert.rejects(client(ALICE, async () => { throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}}); }, fast).me(),
    e => e.code === 'unreachable' && !('cause' in e.extra) && e.message === `cannot reach ${BASE}: fetch failed (ECONNREFUSED)`);
  // an answer that is not JSON names its cause (a consent's deal read then waits: transient)
  await assert.rejects(client(ALICE, async () => new Response('<html>Sign in</html>', {status: 200})).me(),
    e => e.code === 'bad_response' && e.extra.cause === 'not_json' && e.status === 200);
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
  // Fix inbox #31: public vouches, true or false.
  await me.setProfile({publicVouches: true});
  assert.deepEqual(f.calls.at(-1).body, {public_vouches: true});
  await me.setProfile({publicVouches: false});
  assert.deepEqual(f.calls.at(-1).body, {public_vouches: false});
  const sent = f.calls.length;
  await refuses(me.setProfile({publicVouches: 'yes'}), 'invalid_field');
  assert.equal(f.calls.length, sent, 'nothing sent for a bad value');
});
