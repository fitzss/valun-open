// transcript.json: a whole pilot run through the real server route table. For every step: every signature the server
// verified gives the recorded verdict; every terms_hash in every response recomputes; every signature the generator
// made with a test key is reproduced byte for byte (same nonces). Every step with a client_call is REPLAYED through the
// real JS Client against a fake fetch serving the recorded client_reads, with the recorded clock and random values:
// its request (method, path, Authorization header, body) must equal the recorded one, signatures aside, and its
// signatures must verify over the exact bytes the server verified (decline/dispute: over a form the server accepts for
// the body sent). This is check_python.py's replay, for the JS client.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client, MemoryStore, ValunError, basis, bytesToHex, hexToBytes, termsHash, utf8} from '../src/index.js';
import {FEATURES_HEADER} from '../src/client.js';
import {generatorNonces, jsonResponse, testKeys, vec} from './helpers.js';

const data = vec('transcript.json');
const {meta, participants, steps} = data;
const BASE = meta.base_url;
const KEYS = testKeys(meta);
const BY_PUB = Object.fromEntries(Object.values(KEYS).map(k => [k.pubkey, k]));
const label = s => `step ${s.n}: ${s.label.slice(0, 80)}`;

/**
 * The body with its signatures taken out (check_python.py strip_sigs): every key named 'signature' or ending in
 * '_signature' is dropped, at any depth and inside lists too; a 'signatures' map (slot -> signature) keeps its slots,
 * each with the value '<signature>', so the set of slots signed is still compared.
 */
function stripSigs(body) {
  if (Array.isArray(body)) return body.map(stripSigs);
  if (body === null || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'signature' || k.endsWith('_signature')) continue;
    if (k === 'signatures' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.keys(v).map(slot => [slot, '<signature>']));
      continue;
    }
    out[k] = stripSigs(v);
  }
  return out;
}

const pointerEscape = k => String(k).replaceAll('~', '~0').replaceAll('/', '~1');

/** The JSON pointers of every signature a body carries: exactly the values stripSigs takes out (check_python.py sig_paths). */
function sigPaths(body, base = '') {
  const out = new Set();
  if (Array.isArray(body)) {
    body.forEach((x, i) => { for (const p of sigPaths(x, `${base}/${i}`)) out.add(p); });
  } else if (body !== null && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      const p = `${base}/${pointerEscape(k)}`;
      if (k === 'signature' || k.endsWith('_signature')) out.add(p);
      else if (k === 'signatures' && v && typeof v === 'object' && !Array.isArray(v)) for (const slot of Object.keys(v)) out.add(`${p}/${pointerEscape(slot)}`);
      else for (const x of sigPaths(v, p)) out.add(x);
    }
  }
  return out;
}

/** The value at JSON pointer `ptr` (RFC 6901), or undefined. */
function pointerGet(doc, ptr) {
  let cur = doc;
  for (const raw of ptr === '' ? [] : ptr.split('/').slice(1)) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, Array.isArray(cur) ? Number(part) : part)) return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/**
 * client_state_after (check_python.py state_problems): the records a client must hold after the call. A dict compares
 * its given keys, a list compares element by element and must have the same length, other values compare equal; null
 * means the key must be absent or null.
 */
function stateProblems(state, want, path = 'state') {
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(want)) {
    if (Object.keys(want).length && !isObj(state)) return [`${path} is ${JSON.stringify(state)?.slice(0, 120)}, not an object`];
    const out = [];
    for (const [k, v] of Object.entries(want)) {
      if (v === null) {
        if (isObj(state) && (state[k] ?? null) !== null) out.push(`${path}.${k} is ${JSON.stringify(state[k]).slice(0, 120)}, expected none`);
        continue;
      }
      if (!isObj(state) || !Object.hasOwn(state, k)) { out.push(`${path}.${k} is missing`); continue; }
      out.push(...stateProblems(state[k], v, `${path}.${k}`));
    }
    return out;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(state) || state.length !== want.length) {
      return [`${path} is ${JSON.stringify(state)?.slice(0, 160)}, expected ${want.length} item(s) like ${JSON.stringify(want).slice(0, 160)}`];
    }
    return want.flatMap((y, i) => stateProblems(state[i], y, `${path}[${i}]`));
  }
  return state === want ? [] : [`${path} is ${JSON.stringify(state)?.slice(0, 120)}, expected ${JSON.stringify(want).slice(0, 120)}`];
}

test('transcript: every signature the server verified gives the recorded verdict', () => {
  let n = 0;
  for (const s of steps) {
    for (const e of s.server_verified) {
      assert.equal(basis.verifyHex(e.signature, hexToBytes(e.message_hex), e.pubkey), e.valid, `${label(s)} (${e.kind})`);
      if (e.kind === 'statement') assert.equal(bytesToHex(utf8(e.message_text)), e.message_hex, `${label(s)} message_text`);
      n++;
    }
  }
  assert.ok(n > 0);
});

test('transcript: every valid test-key signature is reproduced byte for byte by sign() with the generator\'s nonces', () => {
  let n = 0;
  for (const s of steps) {
    for (const e of s.server_verified.filter(x => x.valid && BY_PUB[x.pubkey])) {
      const k = BY_PUB[e.pubkey], msg = hexToBytes(e.message_hex);
      assert.equal(bytesToHex(basis.sign(msg, k.secret, hexToBytes(k.pubkey), {randomBytes: generatorNonces(k.secret, msg)})), e.signature, label(s));
      n++;
    }
  }
  assert.ok(n > 0);
});

test('transcript: every terms_hash in every response and client read recomputes from its terms', () => {
  let n = 0;
  for (const s of steps) {
    const bodies = [s.response.body, ...Object.values(s.client_reads || {}).map(r => r.body)];
    for (const b of bodies) {
      for (const x of Array.isArray(b) ? b : [b]) {
        for (const part of ['current', 'pending_counter']) {
          const c = x && typeof x === 'object' ? x[part] : null;
          if (c && typeof c === 'object' && c.terms) { assert.equal(termsHash(c.terms), c.terms_hash, `${label(s)} ${part}`); n++; }
        }
      }
    }
  }
  assert.ok(n > 0);
});

// ---- replay ---------------------------------------------------------------------------------------------------------
/**
 * Runs the step's client_call through the real JS Client against the recorded answers: the reads it recorded
 * (client_reads, as often as the client asks) and the step's own request, which the recorded run sent once. Of that
 * request the first send is kept (body, Authorization and X-Valun-Features headers) and every send is counted.
 * client_call.client_state (release v16 steps) is the profile's records before the call, merged over the enrolled
 * profile (participant_id, pubkey, issued), as check_python.py does.
 */
async function replay(step, variant) {
  const call = step.client_call;
  const key = KEYS[call.key];
  const actor = step.actor.split('.')[0];
  const pid = participants[actor].participant_id;
  const at = Date.parse(step.at);
  const reads = step.client_reads || {};
  const queue = [...(call.token_hex || [])];
  const problems = [];
  let captured, capturedAuth, features = null, sends = 0;
  const randomBytes = n => {
    if (!queue.length) throw new Error('the client asked for more random values than the transcript recorded');
    const v = queue.shift();
    if (v.length !== 2 * n) throw new Error(`randomBytes(${n}) but the recorded value has ${v.length} hex chars`);
    return hexToBytes(v);
  };
  const fetch = async (url, init = {}) => {
    const path = url.slice(BASE.length), method = init.method || 'GET', k = `${method} ${path}`;
    if (!url.startsWith(BASE)) problems.push(`request outside the server: ${url}`);
    if (reads[k]) return jsonResponse(reads[k].status, reads[k].body);
    if (method === step.request.method && path === step.request.path) {
      if (++sends === 1) {
        captured = init.body === undefined ? null : JSON.parse(init.body);
        capturedAuth = init.headers?.Authorization;
        features = init.headers?.[FEATURES_HEADER] ?? null;
      }
      return jsonResponse(step.response.status, step.response.body);
    }
    problems.push(`unexpected request ${k}`);
    return jsonResponse(599, {error: 'unexpected_request'});
  };
  const token = (step.request.headers?.authorization || 'Bearer <none>').slice('Bearer '.length);
  const store = call.method === 'enroll'
    ? new MemoryStore({state: {}})
    : new MemoryStore({state: {participant_id: pid, pubkey: key.pubkey, issued: {}, ...structuredClone(call.client_state || {})},
      secret: bytesToHex(key.secret), token});
  const client = new Client({store, server: BASE, fetch, now: () => at, randomBytes, generateSecret: () => key.secret.slice()});
  const a = {...call.args};
  if (variant?.strip) a.reason = a.reason.trim();
  let raised = null;
  try {
    switch (call.method) {
      case 'enroll': await client.enroll(a.participant_id, a.code); break;
      case 'set_limits': await client.setLimits(a.body); break;
      case 'propose': await client.propose({counterpartyId: a.counterparty_id, role: a.role, title: a.title, description: a.description,
        deliverable: a.deliverable, price: a.price, deliverByHours: a.deliver_by_hours, offerTtlHours: a.offer_ttl_hours}); break;
      case 'counter': await client.counter(a.deal_id, {price: a.price, title: a.title, description: a.description, deliverable: a.deliverable,
        deliverByHours: a.deliver_by_hours, offerTtlHours: a.offer_ttl_hours}); break;
      case 'accept': await client.accept(a.deal_id, {expectedTermsHash: a.expected_terms_hash}); break;
      case 'decline': await client.decline(a.deal_id, a.reason); break;
      case 'withdraw': await client.withdraw(a.deal_id); break;
      case 'deliver': await client.deliver(a.deal_id, a.content, {title: a.title}); break;
      case 'complete': await client.complete(a.deal_id, {expectedDeliverableSha256: a.expected_deliverable_sha256,
        expectedTermsHash: a.expected_terms_hash}); break;
      case 'dispute': await client.dispute(a.deal_id, a.reason); break;
      case 'pay_by_transfer': await client.payByTransfer(a.deal_id, a.issuer, {expectedDeliverableSha256: a.expected_deliverable_sha256,
        expectedQuoteDigest: a.expected_quote_digest, expectedClaimTotal: a.expected_claim_total}); break;
      case 'process_consents': await client.processConsents({policy: a.policy, nowMs: a.now_ms, valueSafeOnly: a.value_safe_only}); break;
      default: throw new Error(`no replay mapping for ${call.method}`);
    }
  } catch (e) {
    if (!(e instanceof ValunError)) throw e;
    raised = e;
  }
  if (queue.length) problems.push(`${queue.length} recorded random value(s) were not used`);
  return {captured, capturedAuth, features, sends, raised, problems, key, client, store};
}

const replayed = steps.filter(s => s.client_call);

test('transcript: the replay covers every client_call step', () => {
  assert.ok(replayed.length > 0);
  const methods = new Set(replayed.map(s => s.client_call.method));
  for (const m of ['enroll', 'set_limits', 'propose', 'counter', 'accept', 'decline', 'withdraw', 'deliver', 'complete', 'dispute',
    'pay_by_transfer', 'process_consents']) {
    assert.ok(methods.has(m), `a replayed ${m}`);
  }
  // release v16 (steps 148+, replayed with circulation on): every step of circulation/1 names the signatures its request carries
  assert.ok(replayed.filter(s => s.n >= 148).length >= 14);
  const v16 = replayed.filter(s => s.client_call.feature === 'circulation/1');
  assert.ok(v16.length >= 12, `${v16.length} circulation steps`);
  for (const s of v16) assert.ok(Array.isArray(s.client_call.signature_fields), label(s));
});

/** Release v16 steps: the signatures the body carries are exactly the ones the step names, each over its message. */
function v16SignatureProblems(step, call, got, key) {
  const problems = [];
  const extra = [...sigPaths(got)].filter(p => !call.signature_fields.includes(p)).sort();
  if (extra.length) problems.push(`the body carries signature(s) the step does not name: ${extra.join(', ')}`);
  const sent = got ?? {};
  const byField = Object.fromEntries(step.server_verified.filter(e => e.field).map(e => [e.field, e]));
  const expected = call.expected_messages || {};
  for (const ptr of call.signature_fields) {
    const sig = pointerGet(sent, ptr);
    if (sig === undefined) {
      problems.push(`no signature at ${ptr}`);
      continue;
    }
    const e = byField[ptr];
    const msg = e ? e.message_hex : expected[ptr];
    if (msg === undefined) problems.push(`the vectors name no message for the signature at ${ptr}`);
    else if (e && e.pubkey !== key.pubkey) problems.push(`the server verified the signature at ${ptr} under another key`);
    else if (!(typeof sig === 'string' && basis.verifyHex(sig, hexToBytes(msg), key.pubkey))) problems.push(`the signature at ${ptr} does not verify`);
  }
  return problems;
}

for (const step of replayed) {
  for (const variant of [null, ...(step.client_call.variants || [])]) {
    test(`transcript replay ${label(step)}${variant ? ` via ${variant.name}` : ''}`, async () => {
      const {captured, capturedAuth, features, sends, raised, problems, key, client, store} = await replay(step, variant);
      const call = step.client_call;
      assert.deepEqual(problems, []);
      const wantErr = call.expect_error;
      if (wantErr) {
        assert.ok(raised, `expected the client to raise ${wantErr}`);
        assert.equal(raised.code, wantErr);
        assert.equal(raised.status, step.response.status);
      } else {
        assert.equal(raised, null, raised && `client raised ${raised.code}: ${raised.message}`);
      }
      assert.ok(sends > 0, 'the client sent the step\'s request');
      assert.equal(sends, 1, 'the recorded run sent the step\'s request once');
      assert.equal(capturedAuth, step.request.headers?.authorization ? step.request.headers.authorization : undefined, 'Authorization header');
      // The capability header (PROTOCOL.md 18.1) exactly as recorded: none where none is recorded (steps 1-147 ran with
      // circulation off; decision D-2 h), the roles the records declare once GET /info lists circulation/1, and the empty
      // list once to withdraw them (decision D-3 b).
      assert.equal(features, step.request.headers?.[FEATURES_HEADER.toLowerCase()] ?? null, `${FEATURES_HEADER} header`);
      let want = step.request.body ?? null;
      if (variant) want = {...want, reason: variant.reason_sent};
      assert.deepEqual(stripSigs(captured), stripSigs(want), 'request body (signatures aside)');

      if (Array.isArray(call.signature_fields)) {
        assert.deepEqual(v16SignatureProblems(step, call, captured, key), []);
      } else {
        assert.deepEqual([...sigPaths(captured)].sort(), [...sigPaths(want)].sort(), 'the body carries exactly the recorded signatures');
        const stmts = step.server_verified.filter(e => e.kind === 'statement');
        const notes = step.server_verified.filter(e => e.kind === 'basis_note_message');
        const accepts = (variant || step).server_accepts;
        if (captured.signature !== undefined) {
          if (accepts) {
            assert.ok(accepts.some(f => basis.verifyHex(captured.signature, hexToBytes(f.message_hex), key.pubkey)),
              'the signature verifies over a statement the server accepts for the body sent');
            if (step.signed_form && !variant && step.signed_form === 'as_sent') {
              assert.ok(basis.verifyHex(captured.signature, hexToBytes(stmts[0].message_hex), key.pubkey), 'signed exactly as sent');
            }
          } else if (!stmts.length && call.expected_statement !== undefined) {
            assert.ok(basis.verifyHex(captured.signature, utf8(call.expected_statement), key.pubkey), `signature over ${JSON.stringify(call.expected_statement)}`);
          } else {
            assert.ok(stmts.length > 0, 'the server verified a statement for this step');
            assert.ok(basis.verifyHex(captured.signature, hexToBytes(stmts[0].message_hex), stmts[0].pubkey),
              `the signature verifies over the statement the server verified: ${JSON.stringify(stmts[0].message_text)}`);
          }
        }
        if (captured.credit_note) {
          assert.ok(notes.length > 0, 'the server verified a note message');
          assert.ok(basis.verifyHex(captured.credit_note.signature, hexToBytes(notes[0].message_hex), notes[0].pubkey),
            'the Basis note signature verifies over the note message the server verified');
        }
      }
      if (call.method === 'enroll') {
        assert.equal(captured.pubkey, key.pubkey, 'enrolled the expected public key');
        assert.equal(store.secret(), bytesToHex(key.secret));
        assert.equal(store.token(), step.response.body.agent_token);
        assert.equal(client.participantId, call.args.participant_id);
        assert.equal(client.connected, true);
      }
      if (call.method === 'complete' && !wantErr && step.response.body?.status === 'note_issued') {
        assert.equal(client.state.issued[`${key.pubkey}>${step.response.body.credit_note.recipient_pubkey}`], captured.credit_note.total,
          'the client records the total it issued');
      }
      if (call.client_state_after !== undefined) {
        assert.deepEqual(stateProblems(store.state, call.client_state_after), [], 'client records after the call');
      }
    });
  }
}
