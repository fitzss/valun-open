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
import {generatorNonces, jsonResponse, testKeys, vec} from './helpers.js';

const data = vec('transcript.json');
const {meta, participants, steps} = data;
const BASE = meta.base_url;
const KEYS = testKeys(meta);
const BY_PUB = Object.fromEntries(Object.values(KEYS).map(k => [k.pubkey, k]));
const label = s => `step ${s.n}: ${s.label.slice(0, 80)}`;

function stripSigs(body) {
  const b = structuredClone(body);
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    delete b.signature;
    if (b.credit_note && typeof b.credit_note === 'object') delete b.credit_note.signature;
  }
  return b;
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
async function replay(step, variant) {
  const call = step.client_call;
  const key = KEYS[call.key];
  const actor = step.actor.split('.')[0];
  const pid = participants[actor].participant_id;
  const at = Date.parse(step.at);
  const reads = step.client_reads || {};
  const queue = [...(call.token_hex || [])];
  const problems = [];
  let captured = null, capturedAuth;
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
      if (captured !== null) problems.push('the client sent the step\'s request twice');
      captured = init.body === undefined ? undefined : JSON.parse(init.body);
      capturedAuth = init.headers?.Authorization;
      return jsonResponse(step.response.status, step.response.body);
    }
    problems.push(`unexpected request ${k}`);
    return jsonResponse(599, {error: 'unexpected_request'});
  };
  const token = (step.request.headers?.authorization || 'Bearer <none>').slice('Bearer '.length);
  const store = call.method === 'enroll'
    ? new MemoryStore({state: {}})
    : new MemoryStore({state: {participant_id: pid, pubkey: key.pubkey, issued: {}}, secret: bytesToHex(key.secret), token});
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
      case 'complete': await client.complete(a.deal_id, {expectedDeliverableSha256: a.expected_deliverable_sha256}); break;
      case 'dispute': await client.dispute(a.deal_id, a.reason); break;
      default: throw new Error(`no replay mapping for ${call.method}`);
    }
  } catch (e) {
    if (!(e instanceof ValunError)) throw e;
    raised = e;
  }
  if (queue.length) problems.push(`${queue.length} recorded random value(s) were not used`);
  return {captured, capturedAuth, raised, problems, key, client, store};
}

const replayed = steps.filter(s => s.client_call);

test('transcript: the replay covers every client_call step', () => {
  assert.ok(replayed.length > 0);
  const methods = new Set(replayed.map(s => s.client_call.method));
  for (const m of ['enroll', 'set_limits', 'propose', 'counter', 'accept', 'decline', 'withdraw', 'deliver', 'complete', 'dispute']) {
    assert.ok(methods.has(m), `a replayed ${m}`);
  }
});

for (const step of replayed) {
  for (const variant of [null, ...(step.client_call.variants || [])]) {
    test(`transcript replay ${label(step)}${variant ? ` via ${variant.name}` : ''}`, async () => {
      const {captured, capturedAuth, raised, problems, key, client, store} = await replay(step, variant);
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
      assert.notEqual(captured, null, 'the client sent the step\'s request');
      assert.equal(capturedAuth, step.request.headers?.authorization ? step.request.headers.authorization : undefined, 'Authorization header');
      let want = step.request.body;
      if (variant) want = {...want, reason: variant.reason_sent};
      assert.deepEqual(stripSigs(captured), stripSigs(want), 'request body (signatures aside)');

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
      if (call.method === 'enroll') {
        assert.equal(captured.pubkey, key.pubkey, 'enrolled the expected public key');
        assert.equal(store.secret(), bytesToHex(key.secret));
        assert.equal(store.token(), step.response.body.agent_token);
        assert.equal(client.participantId, call.args.participant_id);
        assert.equal(client.connected, true);
      }
      if (call.method === 'complete' && ['note_issued', 'completion_awaiting_owner', 'issuing_note'].includes(step.response.body.status)) {
        assert.equal(client.state.issued[`${key.pubkey}>${step.response.body.credit_note.recipient_pubkey}`], captured.credit_note.total,
          'the client records the total it issued');
      }
    });
  }
}
