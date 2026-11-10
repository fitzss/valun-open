// circulation.json (server release v16, circulating credit; PROTOCOL.md 15.3 and 18): every record is consumed here, the
// way spec/vectors/check_python.py consumes it for a Python client that declares circulation/1. Timestamp residue
// classes; every 80-byte message and signature (reproduced byte for byte with the generator's nonces where a test key
// made it); the transfer quote, its canonical form and digest; the pay statement; the signatures of the tracker
// requests; and the client signing firewall's decisions (novation.js must sign exactly the slots given, with these
// messages, or refuse with the code given). A guard test fails when a record (or a kind of record) is not consumed.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {basis, bytesToHex, hexToBytes, novation as nv, utf8} from '../src/index.js';
import {canonical, sha256Hex, statement} from '../src/protocol.js';
import {generatorNonces, testKeys, vec} from './helpers.js';

const data = vec('circulation.json');
const {meta} = data;
const NFT = meta.fixture_tracker_nft_id, DENOM = meta.pilot_denomination;
const KEYS = testKeys(meta);
const BY_PUB = Object.fromEntries(Object.values(KEYS).map(k => [k.pubkey, k]));

// ---- the closed world: the groups, tiers and kinds of record this file knows ----
const GROUPS = ['timestamps', 'messages', 'quote_digests', 'statements', 'transfers', 'setoffs', 'consents', 'payer_templates', 'bound_templates'];
const TIERS = ['core', 'circulation', 'consent', 'edge'];
const STATEMENT_KINDS = ['pay'];
const EVALUATORS = {consents: 'consent', payer_templates: 'payer_template', bound_templates: 'bound_template'};
const CONSENT_KINDS = ['transfer', 'setoff'];
const ROUTES = {transfers: ['POST /notes/transfer', 'POST /notes'], setoffs: ['POST /notes/setoff']};
const SIGNATURE_FIELDS = ['issuer_from_signature', 'issuer_to_signature', 'from_recipient_prior_signature', 'from_recipient_signature',
  'from_recipient_to_signature', 'to_recipient_prior_signature', 'to_recipient_signature', 'edges/0/issuer_signature',
  'edges/0/recipient_signature', 'edges/1/issuer_signature', 'edges/1/recipient_signature'];

const consumed = new Map(GROUPS.map(g => [g, new Set()]));
const consume = (group, v) => {
  assert.ok(!consumed.get(group).has(v.name), `${group}: the name ${v.name} is not unique`);
  consumed.get(group).add(v.name);
};
const guardedVerify = (pubkeyHex, msg, sigHex) => {
  try {
    return basis.verifyHex(sigHex, msg, pubkeyHex);
  } catch {
    return false;
  }
};

/** A valid signature by a test key is reproduced byte for byte by sign() with the generator's nonces. */
function reproduce(pubkey, msg, signature, where) {
  const k = BY_PUB[pubkey];
  assert.ok(k, `${where}: signed by a test key`);
  assert.equal(bytesToHex(basis.sign(msg, k.secret, hexToBytes(k.pubkey), {randomBytes: generatorNonces(k.secret, msg)})), signature,
    `${where}: reproduced with the generator's nonces`);
}

test('circulation.json: the groups, tiers and kinds are exactly the ones this test consumes (closed world)', () => {
  assert.deepEqual(Object.keys(data).sort(), ['meta', ...GROUPS].sort());
  assert.deepEqual(Object.keys(meta.tiers).sort(), [...TIERS].sort());
  for (const g of GROUPS) {
    assert.ok(Array.isArray(data[g]) && data[g].length > 0, g);
    for (const v of data[g]) {
      assert.equal(typeof v.name, 'string', g);
      if (v.tier !== undefined) assert.ok(TIERS.includes(v.tier), `${g}/${v.name}: tier ${v.tier}`);
    }
  }
  for (const v of data.statements) assert.ok(STATEMENT_KINDS.includes(v.kind), `statement kind ${v.kind}`);
  for (const [g, ev] of Object.entries(EVALUATORS)) {
    for (const v of data[g]) {
      assert.equal(v.evaluator, ev, `${g}/${v.name}`);
      assert.equal(v.tier, 'consent', `${g}/${v.name}`);
      assert.ok(v.expected === 'sign' || (typeof v.expected?.refuse === 'string' && Object.keys(v.expected).length === 1), `${g}/${v.name}: expected`);
    }
  }
  for (const v of data.consents) assert.ok(CONSENT_KINDS.includes(v.input.kind), `consent kind ${v.input.kind}`);
  for (const g of ['transfers', 'setoffs']) {
    for (const v of data[g]) {
      assert.ok(ROUTES[g].includes(v.route), `${g}/${v.name}: route ${v.route}`);
      for (const s of v.signatures) assert.ok(SIGNATURE_FIELDS.includes(s.field), `${g}/${v.name}: field ${s.field}`);
    }
  }
  for (const v of data.timestamps) assert.ok(('accepted_as' in v) !== ('server_choice' in v), `${v.name}: a residue class or a server choice`);
  // every refusal code the vectors use is one novation.js knows
  for (const g of Object.keys(EVALUATORS)) {
    for (const v of data[g]) if (v.expected !== 'sign') assert.ok(nv.REFUSAL_CODES.includes(v.expected.refuse), v.expected.refuse);
  }
});

test('circulation.json: timestamp residue classes (PROTOCOL.md 18.4) and the server\'s choices', () => {
  const classes = ts => {
    const safe = Number.isSafeInteger(ts) && ts >= 0 && ts <= nv.MAX_SAFE_INTEGER;   // every signed number is a safe integer
    return {ordinary: safe && !nv.RESERVED_MS.includes(ts % 1000),
      ...Object.fromEntries(['bound', 'transfer', 'setoff'].map(k => [k, safe && ts % 1000 === nv.RESIDUE[k]]))};
  };
  for (const v of data.timestamps) {
    consume('timestamps', v);
    if ('server_choice' in v) {             // the server's choice of a timestamp (novationTimestamp): server-side, informative
      assert.ok(Object.values(nv.RESIDUE).includes(v.residue), v.name);
      assert.ok(Number.isSafeInteger(v.now) && Number.isSafeInteger(v.after), v.name);
      if ('timestamp' in v.server_choice) {
        assert.equal(v.server_choice.timestamp % 1000, v.residue, `${v.name}: the choice ends in its residue`);
        assert.ok(v.server_choice.timestamp > v.after && v.server_choice.timestamp <= v.now - 1500, `${v.name}: after, and at least 1.5 s before now`);
      } else {
        assert.ok(Number.isSafeInteger(v.server_choice.ahead_ms), v.name);
      }
      continue;
    }
    assert.deepEqual(classes(v.ts), v.accepted_as, v.name);
    if (Number.isSafeInteger(v.ts)) {
      assert.equal(v.ts % 1000, v.residue, v.name);
      // the v16 server moves an ordinary timestamp out of 995-999 itself (what the test servers here do too)
      assert.equal(v.ts % 1000 >= 995 ? v.ts + 1000 - (v.ts % 1000) : v.ts, v.ordinary_clamp, `${v.name}: ordinary clamp`);
    } else {
      assert.equal(v.ordinary_clamp, null, v.name);
    }
  }
});

test('circulation.json: every message is the 80-byte note message M(I,R,t,ts), and every signature verifies as recorded', () => {
  for (const v of data.messages) {
    consume('messages', v);
    const m = nv.message(v.issuer_pubkey, v.recipient_pubkey, v.total, v.timestamp, v.tracker_nft_id, v.denomination);
    assert.equal(bytesToHex(m), v.message_hex, v.name);
    assert.equal(m.length, 80, v.name);
    assert.equal(bytesToHex(basis.noteMessage(v.issuer_pubkey, v.recipient_pubkey, v.total, v.timestamp, v.tracker_nft_id, v.denomination)),
      v.message_hex, v.name);
    if (v.slot.includes('>')) assert.ok(v.slot.startsWith(`${nv.edgeKey(v.issuer_pubkey, v.recipient_pubkey)}:`), `${v.name}: the slot names its edge`);
    assert.equal(guardedVerify(v.signer_pubkey, m, v.signature), v.valid ?? true, `${v.name}: verifies == ${v.valid}`);
    assert.equal(BY_PUB[v.signer_pubkey]?.label, meta.test_keys[v.signer]?.label, `${v.name}: signer`);
    if (v.valid ?? true) reproduce(v.signer_pubkey, m, v.signature, v.name);
  }
});

test('circulation.json: the transfer quote, its canonical form and digest (PROTOCOL.md 18.3 item 4)', () => {
  for (const v of data.quote_digests) {
    consume('quote_digests', v);
    assert.equal(canonical(v.quote), v.canonical, v.name);
    assert.equal(sha256Hex(v.canonical), v.quote_digest, v.name);
    const {kind, ...fields} = v.quote;
    assert.equal(kind, nv.QUOTE_KIND, v.name);
    assert.deepEqual(Object.keys(fields).sort(), [...nv.QUOTE_FIELDS].sort(), v.name);
    assert.equal(nv.quoteDigest(v.quote), v.quote_digest, `${v.name}: novation.quoteDigest`);
  }
});

test('circulation.json: the pay statement (valun-pilot/pay/1): text, bytes, signature', () => {
  for (const v of data.statements) {
    consume('statements', v);
    const st = statement(v.kind, v.inputs.deal_id, v.inputs.quote_digest);
    assert.equal(st, v.statement, v.name);
    assert.equal(bytesToHex(utf8(st)), v.statement_utf8_hex, v.name);
    assert.equal(nv.payStatement(v.inputs.deal_id, v.inputs.quote_digest), v.statement, `${v.name}: novation.payStatement`);
    const msg = hexToBytes(v.statement_utf8_hex);
    assert.equal(guardedVerify(v.pubkey, msg, v.signature), v.valid ?? true, `${v.name}: verifies == ${v.valid}`);
    if (v.valid ?? true) reproduce(v.pubkey, msg, v.signature, v.name);
  }
});

test('circulation.json: tracker requests: each signature over the message the tracker checks for its field', () => {
  let n = 0;
  for (const g of ['transfers', 'setoffs']) {
    for (const v of data[g]) {
      consume(g, v);
      for (const s of v.signatures) {
        const m = nv.message(s.issuer_pubkey, s.recipient_pubkey, s.total, s.timestamp, NFT, DENOM);
        assert.equal(bytesToHex(m), s.message_hex, `${v.name} ${s.field}: message`);
        assert.equal(guardedVerify(s.signer_pubkey, m, s.signature), s.valid, `${v.name} ${s.field}: verifies == ${s.valid}`);
        if (s.valid) reproduce(s.signer_pubkey, m, s.signature, `${v.name} ${s.field}`);
        n++;
      }
      // the tracker's answer is tracker-side (informative): recorded with a status
      assert.ok(Number.isInteger(v.tracker_outcome.status), `${v.name}: tracker outcome`);
    }
  }
  assert.ok(n > 0);
});

const EVALUATE = {consent: nv.evaluateConsent, payer_template: nv.evaluatePayerTemplate, bound_template: nv.evaluateBoundTemplate};

for (const g of Object.keys(EVALUATORS)) {
  test(`circulation.json: ${g}: the firewall signs exactly these slots or refuses with this code (PROTOCOL.md 15.3)`, () => {
    for (const v of data[g]) {
      consume(g, v);
      const input = structuredClone(v.input), ctx = {...structuredClone(v.ctx), verify: guardedVerify};
      const r = EVALUATE[v.evaluator](input, ctx);
      assert.deepEqual(input, v.input, `${v.name}: the input is not changed`);
      if (v.expected === 'sign') {
        assert.equal(r.ok, true, `${v.name}: refused with ${r.code}: ${r.summary?.reason}`);
        const slots = r.to_sign.map(t => t[0]);
        assert.deepEqual(slots, v.slots, `${v.name}: slots`);
        const msgs = nv.slotMessages(r.to_sign, NFT, DENOM);
        for (const slot of slots) assert.equal(bytesToHex(msgs[slot]), v.messages[slot], `${v.name}: the message for ${slot}`);
        assert.ok(r.write_ahead, `${v.name}: written ahead`);
      } else {
        assert.equal(r.ok, false, `${v.name}: would sign ${JSON.stringify(r.to_sign.map(t => t[0]))}`);
        assert.equal(r.code, v.expected.refuse, `${v.name}: ${r.summary?.reason}`);
        assert.deepEqual([r.to_sign, r.write_ahead], [[], null], v.name);
      }
      for (const [k, x] of Object.entries(v.summary || {})) assert.deepEqual(r.summary[k], x, `${v.name}: summary.${k}`);
    }
  });
}

test('circulation.json: every record was consumed by the tests above (guard)', () => {
  for (const g of GROUPS) {
    const left = data[g].map(v => v.name).filter(nm => !consumed.get(g).has(nm));
    assert.deepEqual(left, [], `${g}: records no test consumed`);
    assert.equal(consumed.get(g).size, data[g].length, g);
  }
});
