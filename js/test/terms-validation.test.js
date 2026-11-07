// terms-validation.json: the server's validator is server-only, so what a client can be held to is (1) the terms_hash
// of every case and (2) what the JS client itself does when it is offered each case: Client.verifyOffer() is run from
// the other party's side against a stub network, and its outcome is compared with a table. The table records where the
// client refuses on its own (safe refusals) and where it relies on the server (accepts locally what the server refuses).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client, MemoryStore, ValunError, basis, bytesToHex, hasUnsafeText, statements, termsHash, utf8} from '../src/index.js';
import {fakeFetch, testKeys, vec} from './helpers.js';

const data = vec('terms-validation.json');
const KEYS = testKeys(data.meta);
const ALICE = 'vp_a1a1a1a1a1a1', BOB = 'vp_b0b0b0b0b0b0';

// null = the client accepts the offer (any refusal is left to the server); a string = the ValunError code it raises.
const CLIENT = {
  'ok/base': null, 'ok/payee-proposes': null, 'ok/deliver-by-equals-offer-expiry': null, 'ok/offset-date': null,
  'ok/date-only-strings': 'bad_terms', 'ok/rfc2822-date': 'bad_terms',               // not RFC 3339: the client refuses to sign
  'ok/tab-newline-cr-in-text': null, 'ok/zwj-emoji': null, 'ok/zwnj-persian': null, 'ok/lrm-rlm': null,
  'ok/arabic-letter-mark': null, 'ok/emoji-presentation': null, 'ok/variation-selector-after-digit': null,
  'ok/subdivision-flags': null, 'ok/title-120-utf16': null, 'ok/title-padded-to-raw-limit': null,
  // server-only rules: service text (release v11's refused characters), lengths, ranges, id formats, deadlines
  'bad/deliver-by-before-offer-expiry': null, 'bad/controls-in-title': null, 'bad/del-in-deliverable': null,
  'bad/bidi-override-in-description': null, 'bad/bidi-isolate-in-title': null, 'bad/zero-width-space': null, 'bad/bom': null,
  'bad/c1-nel': null, 'bad/c1-csi': null, 'bad/word-joiner': null, 'bad/invisible-operators': null, 'bad/interlinear-annotation': null,
  'bad/tag-characters': null, 'bad/other-tag-flag': null, 'bad/soft-hyphen': null, 'bad/hangul-filler-115f': null,
  'bad/hangul-filler-1160': null, 'bad/hangul-filler-3164': null, 'bad/hangul-filler-ffa0': null,
  'bad/ideographic-variation-selectors': null, 'bad/stray-variation-selector': null, 'bad/repeated-variation-selector': null,
  'bad/title-122-utf16': null, 'bad/title-padded-over-raw-limit': null, 'bad/title-only-spaces': null,
  'bad/deal-id-uppercase': null, 'bad/version-0': 'bad_terms', 'bad/version-51': 'bad_terms', 'bad/nonce-short': null,
  'bad/price-zero': null, 'bad/price-1001': null, 'bad/offer-over-7-days': null, 'bad/deliver-by-over-30-days': null,
  // the client's own checks (spec 15.2)
  'bad/unknown-field': 'bad_terms', 'bad/missing-prior-terms-hash': 'bad_terms', 'bad/payer-extra-field': 'bad_terms',
  'bad/service-missing-field': 'bad_terms', 'bad/version-string': 'bad_terms', 'bad/price-fraction': 'bad_terms',
  'bad/price-unit': 'bad_terms', 'bad/consideration': 'bad_terms', 'bad/deliver-by-unparseable': 'bad_terms',
  'bad/protocol': 'wrong_network', 'bad/network': 'wrong_network', 'bad/tracker': 'wrong_tracker', 'bad/denomination': 'wrong_tracker',
  'bad/proposer-not-caller': 'wrong_proposer', 'bad/payee-wrong-key': 'wrong_key', 'bad/payer-equals-payee': 'not_a_party',
  'bad/offer-expired': 'expired',
};

test('terms-validation.json: terms_hash of every case equals the server\'s', () => {
  assert.ok(data.vectors.length > 0);
  for (const v of data.vectors) assert.equal(termsHash(v.terms), v.terms_hash, v.name);
});

test('terms-validation.json: ok/* cases are accepted by the server, bad/* refused with 400', () => {
  for (const v of data.vectors) {
    if (v.name.startsWith('ok/')) assert.equal(v.server_outcome, 'accepted', v.name);
    else assert.equal(v.server_outcome.status, 400, v.name);
  }
});

async function offerTo(v) {
  const signerId = v.proposer;   // the participant whose agent submitted the terms
  const viewer = signerId === ALICE ? BOB : ALICE;
  const signerKey = signerId === ALICE ? KEYS.alice : KEYS.bob, viewerKey = viewer === ALICE ? KEYS.alice : KEYS.bob;
  const h = termsHash(v.terms);
  const sig = bytesToHex(basis.sign(utf8(statements.propose(h)), signerKey.secret));
  const deal = {id: v.terms.deal_id, current: {version: v.terms.version, by: signerId, terms: v.terms, terms_hash: h, signature: sig}};
  const dir = {[ALICE]: KEYS.alice.pubkey, [BOB]: KEYS.bob.pubkey};
  const fetch = fakeFetch(key => {
    if (key === 'GET /pilot/v1/info') {
      return {body: {network: data.meta.network, protocol: data.meta.protocol, denomination: data.meta.pilot_denomination,
        tracker_nft_id: data.meta.fixture_tracker_nft_id}};
    }
    const m = /^GET \/pilot\/v1\/participants\/(.+)$/.exec(key);
    if (m && dir[m[1]]) return {body: {id: m[1], pubkey: dir[m[1]], status: 'active'}};
    return undefined;
  });
  const store = new MemoryStore({state: {participant_id: viewer, pubkey: viewerKey.pubkey}, secret: bytesToHex(viewerKey.secret), token: 'stub'});
  const client = new Client({store, server: 'http://valun.invalid', fetch, now: () => Date.parse(v.fixture_now)});
  try {
    await client.verifyOffer(deal);
    return null;
  } catch (e) {
    if (!(e instanceof ValunError)) throw e;
    return e.code;
  }
}

test('terms-validation.json: Client.verifyOffer() on each case matches the table of client-side outcomes', async () => {
  const unknown = [];
  for (const v of data.vectors) {
    const got = await offerTo(v);   // never throws anything but a ValunError
    if (!(v.name in CLIENT)) { unknown.push(`${v.name} -> ${got ?? 'accepts'}`); continue; }
    assert.equal(got, CLIENT[v.name], v.name);
  }
  assert.deepEqual(unknown, [], 'every case has an entry in the table');
  assert.deepEqual(Object.keys(CLIENT).filter(n => !data.vectors.some(v => v.name === n)), [], 'no entry for a case that is gone');
});

test('hasUnsafeText() refuses the service text of exactly the cases the server refuses for their characters (release v11)', () => {
  const byChars = v => typeof v.server_outcome === 'object' && /contains control, bidi or zero-width characters/.test(v.server_outcome.message);
  const unsafe = v => Object.values(v.terms.service || {}).some(f => typeof f === 'string' && hasUnsafeText(f));   // per field, as the server
  let refused = 0;
  for (const v of data.vectors) {
    if (byChars(v)) { refused++; assert.equal(unsafe(v), true, v.name); }
    else if (v.server_outcome === 'accepted') assert.equal(unsafe(v), false, v.name);
  }
  assert.ok(refused >= 20, `${refused} character cases`);
});

test('every terms case the server accepts is either accepted by the client or refused as a safe refusal (bad_terms)', async () => {
  for (const v of data.vectors.filter(x => x.server_outcome === 'accepted')) {
    const got = await offerTo(v);
    assert.ok(got === null || got === 'bad_terms', `${v.name}: ${got}`);
  }
});
