// statements.json: every statement text rebuilds exactly, every signature verifies (and every negative does not), every
// accepted alternative form rebuilds and verifies, and the JS Client's decline/dispute send each reason the server
// accepts unchanged and sign a form it accepts, while refusing, without sending anything, each reason the server
// refuses (tier "refused": "a client must not send them").
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client, MemoryStore, ValunError, basis, bytesToHex, cleanText, hexToBytes, reasonProblem, sha256Hex, statement, statements, utf8} from '../src/index.js';
import {fakeFetch, testKeys, vec} from './helpers.js';

const data = vec('statements.json');
const KEYS = testKeys(data.meta);
const accepted = v => v.server_outcome === undefined || v.server_outcome === 'accepted';

function rebuild(v) {
  const i = v.inputs;
  switch (v.kind) {
    case 'enroll': return statements.enroll(i.participant_id, i.pubkey, i.enrollment_code, i.network);
    case 'propose': return statements.propose(i.terms_hash);
    case 'accept': return statements.accept(i.terms_hash);
    case 'withdraw': return statements.withdraw(i.terms_hash);
    case 'decline': return statements.decline(i.terms_hash, i.reason);
    case 'deliver': return statements.deliver(i.terms_hash, i.content);
    case 'complete': return statements.complete(i.terms_hash, i.deliverable_sha256);
    case 'dispute': return statements.dispute(i.terms_hash, i.deliverable_sha256, i.reason);
    default: throw new Error(`unknown kind ${v.kind}`);
  }
}

test('statements.json has the tiers and kinds this suite knows', () => {
  for (const v of data.vectors) {
    assert.ok(['core', 'edge', 'refused'].includes(v.tier), `${v.name}: tier ${v.tier}`);
    assert.ok(['enroll', 'propose', 'accept', 'withdraw', 'decline', 'deliver', 'complete', 'dispute'].includes(v.kind), v.name);
  }
});

test('statements.json: accepted statements rebuild exactly (text and UTF-8 bytes) and their signatures verify', () => {
  for (const v of data.vectors.filter(accepted)) {
    const s = rebuild(v);
    assert.equal(s, v.statement, v.name);
    assert.equal(bytesToHex(utf8(s)), v.statement_utf8_hex, `${v.name} bytes`);
    assert.equal(basis.verifyHex(v.signature, hexToBytes(v.statement_utf8_hex), v.pubkey), true, `${v.name} signature`);
    assert.equal(v.pubkey, KEYS[v.signer].pubkey, `${v.name} signer key`);
    // hashed inputs, where the vector states them
    const i = v.inputs;
    if (i.enrollment_code_sha256) assert.equal(sha256Hex(i.enrollment_code), i.enrollment_code_sha256, v.name);
    if (i.deliverable_sha256 && v.kind === 'deliver') assert.equal(sha256Hex(i.content), i.deliverable_sha256, v.name);
    if (i.reason_sha256) assert.equal(sha256Hex(i.reason), i.reason_sha256, v.name);
  }
});

test('statements.json: statement() joins with LF and adds no trailing newline', () => {
  assert.equal(statement('accept', 'h'), 'valun-pilot/accept/1\nh');
  assert.equal(statements.enroll('vp_1', '02ab', ''), `valun-pilot/enroll/1\nvalun-pilot-1\nvp_1\n02ab\n${sha256Hex('')}`);
});

test('statements.json: every accepted alternative (the cleaned reason) rebuilds and verifies; stored reasons are the cleaned text', () => {
  for (const v of data.vectors.filter(x => accepted(x) && (x.kind === 'decline' || x.kind === 'dispute'))) {
    const i = v.inputs;
    assert.equal(cleanText(i.reason), i.reason_cleaned, `${v.name}: cleanText`);
    if (i.reason_cleaned_sha256) assert.equal(sha256Hex(i.reason_cleaned), i.reason_cleaned_sha256, v.name);
    for (const alt of v.accepted_alternatives || []) {
      const s = v.kind === 'decline' ? statements.decline(i.terms_hash, i.reason_cleaned) : statements.dispute(i.terms_hash, i.deliverable_sha256, i.reason_cleaned);
      assert.equal(s, alt.statement, `${v.name} alternative ${alt.form}`);
      assert.equal(bytesToHex(utf8(s)), alt.statement_utf8_hex, `${v.name} alternative bytes`);
      assert.equal(basis.verifyHex(alt.signature, hexToBytes(alt.statement_utf8_hex), v.pubkey), true, `${v.name} alternative signature`);
    }
    if (v.stored) {
      assert.equal(v.stored.reason, cleanText(i.reason), `${v.name} stored reason`);
      if (cleanText(i.reason) !== i.reason) assert.equal(v.stored.reason_as_signed, i.reason, `${v.name} reason_as_signed`);
    }
  }
});

test('statements.json negative_signatures: none verifies', () => {
  assert.ok(data.negative_signatures.length > 0);
  for (const v of data.negative_signatures) {
    assert.equal(v.valid, false);
    assert.equal(basis.verifyHex(v.signature, hexToBytes(v.statement_utf8_hex), v.pubkey), false, `${v.name}: ${v.why}`);
  }
});

// The real Client.decline / Client.dispute against a stub server (as check_python.py client_reason_request does): only
// the reason handling is under test; for a dispute the agreement check is stubbed out because full disputes, agreement
// check included, are replayed from transcript.json.
async function clientReasonRequest(kind, inputs, key) {
  const th = inputs.terms_hash, id = 'vd_0000000000000000';
  const deal = {id, current: {terms_hash: th}, agreement: {terms_hash: th}, delivery: {sha256: inputs.deliverable_sha256}};
  const fetch = fakeFetch({
    [`GET /pilot/v1/deals/${id}`]: {body: deal},
    [`POST /pilot/v1/deals/${id}/${kind}`]: {body: {id, status: kind === 'decline' ? 'declined' : 'disputed'}},
  });
  const store = new MemoryStore({state: {participant_id: 'vp_000000000000', pubkey: key.pubkey, issued: {}}, secret: bytesToHex(key.secret), token: 'stub-token'});
  const client = new Client({store, server: 'http://valun.invalid', fetch});
  client.verifiedAgreement = () => ({});
  let error = null;
  try {
    await client[kind](id, inputs.reason);
  } catch (e) {
    error = e;
  }
  return {error, posts: fetch.calls.filter(c => c.key.startsWith('POST ')), calls: fetch.calls};
}

test('Client.decline / Client.dispute send every reason the server accepts unchanged and sign a form it accepts', async () => {
  let n = 0;
  for (const v of data.vectors.filter(x => accepted(x) && (x.kind === 'decline' || x.kind === 'dispute'))) {
    assert.equal(reasonProblem(v.kind, v.inputs.reason), null, `${v.name}: the local check must accept it`);
    const {error, posts} = await clientReasonRequest(v.kind, v.inputs, KEYS[v.signer]);
    assert.equal(error, null, `${v.name}: ${error?.message}`);
    assert.equal(posts.length, 1, v.name);
    const body = posts[0].body;
    assert.equal(body.reason, v.inputs.reason, `${v.name}: the reason is sent exactly as given`);
    const forms = [v.statement, ...(v.accepted_alternatives || []).map(a => a.statement)];
    assert.ok(forms.some(s => basis.verifyHex(body.signature, utf8(s), v.pubkey)), `${v.name}: signature over an accepted form`);
    assert.ok(basis.verifyHex(body.signature, utf8(v.statement), v.pubkey), `${v.name}: signed exactly as sent (the v8+ rule)`);
    n++;
  }
  assert.ok(n > 0);
});

test('reasons the server refuses (tier "refused"): the client refuses them with the server\'s error and sends nothing', async () => {
  let n = 0;
  for (const v of data.vectors.filter(x => !accepted(x))) {
    const o = v.server_outcome;
    assert.equal(o.status, 400, v.name);
    if (v.kind !== 'decline' && v.kind !== 'dispute') continue;
    assert.deepEqual(reasonProblem(v.kind, v.inputs.reason), {error: o.error, message: o.message}, v.name);
    const {error, calls} = await clientReasonRequest(v.kind, v.inputs, KEYS.alice);
    assert.ok(error instanceof ValunError, v.name);
    assert.equal(error.code, o.error, v.name);
    assert.equal(error.message, o.message, v.name);
    assert.equal(error.extra.local, true, v.name);
    assert.equal(calls.length, 0, `${v.name}: nothing is sent, not even a read`);
    n++;
  }
  assert.ok(n > 0);
});

test('edge tier (inputs a client should never produce): lone surrogates hash as U+FFFD, exactly as the server does', () => {
  for (const v of data.vectors.filter(x => x.tier === 'edge' && accepted(x))) {
    const text = v.inputs.content ?? v.inputs.reason;
    assert.ok(/\p{Cs}/u.test(text), `${v.name} carries a lone surrogate`);
    assert.equal(sha256Hex(text), sha256Hex(text.replace(/\p{Cs}/gu, '\u{FFFD}')), v.name);
  }
});
