// The Basis Schnorr signer/verifier and note messages: Basis's official vectors (basis-signatures.json TV001-TV011),
// basis-notes.json, the public test keys, the retry rule on e and z, and byte-exact reproduction of every signature
// the vector generator made (same nonces in, same bytes out).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {basis, bytesToHex, hexToBytes, utf8} from '../src/index.js';
import {generatorNonces, testKeys, vec} from './helpers.js';

const sigs = vec('basis-signatures.json');
const notes = vec('basis-notes.json');
const statementsVec = vec('statements.json');
const KEYS = testKeys(notes.meta);

test('basis-signatures.json: verify() agrees with every official Basis vector (TV001-TV011)', () => {
  assert.equal(sigs.vectors.length, 11);
  for (const v of sigs.vectors) {
    assert.equal(basis.verify(hexToBytes(v.signature), hexToBytes(v.message_hex), hexToBytes(v.pubkey)), v.valid, v.name);
    assert.equal(basis.verifyHex(v.signature, hexToBytes(v.message_hex), v.pubkey), v.valid, `${v.name} (hex)`);
  }
});

test('basis-notes.json: debt keys and 80-byte note messages rebuild exactly; given signatures verify; the negative does not', () => {
  assert.equal(notes.vectors.length, 13);
  for (const v of notes.vectors) {
    assert.equal(bytesToHex(basis.debtKey(v.issuer_pubkey, v.recipient_pubkey, v.denomination)), v.debt_key_hex, `${v.name} debt key`);
    const m = basis.noteMessage(hexToBytes(v.issuer_pubkey), hexToBytes(v.recipient_pubkey), v.total, v.timestamp,
      hexToBytes(v.tracker_nft_id), v.denomination);
    assert.equal(m.length, 80);
    assert.equal(bytesToHex(m), v.message_hex, `${v.name} message`);
    // number and bigint forms give the same bytes where they are exact
    assert.equal(bytesToHex(basis.noteMessage(v.issuer_pubkey, v.recipient_pubkey, BigInt(v.total), BigInt(v.timestamp), v.tracker_nft_id, v.denomination)), v.message_hex);
    if (v.server_representable) {
      assert.equal(bytesToHex(basis.noteMessage(v.issuer_pubkey, v.recipient_pubkey, Number(v.total), Number(v.timestamp), v.tracker_nft_id, v.denomination)), v.message_hex);
    }
    if (v.signature) assert.equal(basis.verifyHex(v.signature, hexToBytes(v.message_hex), v.issuer_pubkey), true, `${v.name} signature`);
  }
  assert.equal(notes.negative_signatures.length, 1);
  for (const v of notes.negative_signatures) {
    assert.equal(basis.verifyHex(v.signature, hexToBytes(v.message_hex), v.pubkey), v.valid, v.name);
  }
});

test('note-message field checks: u64 range, integer forms, 32-byte tracker id, 33-byte keys, denominations', () => {
  const [a, b] = [KEYS.alice.pubkey, KEYS.bob.pubkey], nft = '42'.repeat(32);
  assert.throws(() => basis.noteMessage(a, b, -1, 0, nft), basis.SignatureError);
  assert.throws(() => basis.noteMessage(a, b, 1n << 64n, 0, nft), basis.SignatureError);
  assert.throws(() => basis.noteMessage(a, b, 1.5, 0, nft), basis.SignatureError);
  assert.throws(() => basis.noteMessage(a, b, 2 ** 53, 0, nft), basis.SignatureError);   // not a safe integer: use bigint
  assert.throws(() => basis.noteMessage(a, b, '20', '01', nft), basis.SignatureError);   // no leading zeros
  assert.throws(() => basis.noteMessage(a, b, 1, 0, '42'.repeat(31)), basis.SignatureError);
  assert.throws(() => basis.debtKey(a.slice(0, 64), b), basis.SignatureError);
  assert.throws(() => basis.debtKey(a, b, 'token:zz'), basis.SignatureError);
  assert.throws(() => basis.debtKey(a, b, 'token:' + 'AB'.repeat(32)), basis.SignatureError);
  assert.throws(() => basis.debtKey(a, b, 'usd'), basis.SignatureError);
  assert.equal(bytesToHex(basis.debtKey(a, b, 'token:' + 'ab'.repeat(32))),
    bytesToHex(basis.blake2b256(hexToBytes(a), hexToBytes(b), hexToBytes('ab'.repeat(32)))));
});

test('public test keys: secrets derived from the public labels give the published public keys', () => {
  for (const [name, k] of Object.entries(KEYS)) assert.equal(bytesToHex(basis.publicKey(k.secret)), k.pubkey, name);
});

test('sign/verify round trip; tampering, other keys and other messages fail; signatures keep z < 2^255', () => {
  const sk = basis.generateSecret();
  const pk = basis.publicKey(sk);
  assert.equal(sk.length, 32);
  assert.equal(pk.length, 33);
  for (let i = 0; i < 25; i++) {
    const msg = utf8(`valun-pilot/accept/1\n${String(i).repeat(64).slice(0, 64)}`);
    const sig = basis.sign(msg, sk, pk);
    assert.equal(sig.length, 65);
    assert.ok(sig[0] === 2 || sig[0] === 3);
    assert.ok(sig[33] < 0x80, 'z < 2^255');
    const e = basis.blake2b256(sig.subarray(0, 33), msg, pk);
    assert.ok(e[0] < 0x80, 'e < 2^255');
    assert.equal(basis.verify(sig, msg, pk), true);
    const bad = sig.slice();
    bad[40] ^= 1;
    assert.equal(basis.verify(bad, msg, pk), false);
    assert.equal(basis.verify(sig, utf8('x'), pk), false);
    assert.equal(basis.verify(sig, msg, hexToBytes(KEYS.bob.pubkey)), false);
  }
});

test('the secret must match the public key given; keys out of range are refused', () => {
  const sk = basis.generateSecret();
  assert.throws(() => basis.sign(utf8('x'), sk, hexToBytes(KEYS.alice.pubkey)), basis.SignatureError);
  assert.throws(() => basis.publicKey(new Uint8Array(32)), basis.SignatureError);                       // 0
  assert.throws(() => basis.publicKey(basis.N.toString(16).padStart(64, '0')), basis.SignatureError);  // n
  assert.throws(() => basis.publicKey(new Uint8Array(31).fill(1)), basis.SignatureError);              // wrong length
  assert.throws(() => basis.sign('text, not bytes', sk), TypeError);
  assert.throws(() => basis.validatePublicKey('04' + '00'.repeat(32)), basis.SignatureError);
  assert.throws(() => basis.validatePublicKey('02' + 'ff'.repeat(32)), basis.SignatureError);          // x >= p
  basis.validatePublicKey(KEYS.carol.pubkey);
});

test('verify() refuses malformed input without throwing', () => {
  const msg = hexToBytes(sigs.vectors[0].message_hex), pk = sigs.vectors[0].pubkey, good = sigs.vectors[0].signature;
  for (const s of ['', 'zz', good.slice(0, 128), '04' + good.slice(2), good.slice(0, 66) + '80' + good.slice(68),
    good.slice(0, 66) + '00'.repeat(32), good.toUpperCase()]) {
    assert.equal(basis.verifyHex(s, msg, pk), false, s.slice(0, 20));
  }
  assert.equal(basis.verify(hexToBytes(good), msg, hexToBytes('02' + 'ff'.repeat(32))), false);
  assert.equal(basis.verify(hexToBytes(good), 'not bytes', hexToBytes(pk)), false);
  assert.equal(basis.verifyHex(null, msg, pk), false);
});

test('retry rule: sign() skips every nonce whose e has the top bit set or whose z is 0 or >= 2^255, in order', () => {
  // Drive sign() with a fixed nonce sequence and recompute, independently, which attempt must be the first valid one.
  const {secret, pubkey} = KEYS.alice;
  const s = BigInt('0x' + bytesToHex(secret)), X = hexToBytes(pubkey);
  let sawE = 0, sawZ = 0;
  for (let seed = 0; seed < 40; seed++) {
    const msg = utf8(`retry-rule test message ${seed}`);
    const ks = Array.from({length: 64}, (_, i) => {
      const k = BigInt('0x' + bytesToHex(basis.blake2b256(utf8(`nonce ${seed}/${i}`)))) % (basis.N - 1n) + 1n;
      return hexToBytes(k.toString(16).padStart(64, '0'));
    });
    let expected = null;
    for (const kb of ks) {
      const k = BigInt('0x' + bytesToHex(kb));
      const a = basis.publicKey(kb);                    // compress(k*G)
      const eb = basis.blake2b256(a, msg, X);
      if (eb[0] >= 0x80) { sawE++; continue; }
      const z = (k + BigInt('0x' + bytesToHex(eb)) * s) % basis.N;
      if (z === 0n || z >= basis.HALF) { sawZ++; continue; }
      expected = bytesToHex(a) + z.toString(16).padStart(64, '0');
      break;
    }
    let i = 0;
    const sig = basis.sign(msg, secret, X, {randomBytes: () => ks[i++]});
    assert.equal(bytesToHex(sig), expected, `seed ${seed}`);
  }
  assert.ok(sawE > 0 && sawZ > 0, `both retry branches exercised (e: ${sawE}, z: ${sawZ})`);
});

test('sign() reproduces, byte for byte, every statement signature the vector generator made (same nonces)', () => {
  const byPub = Object.fromEntries(Object.values(testKeys(statementsVec.meta)).map(k => [k.pubkey, k]));
  let n = 0;
  for (const v of statementsVec.vectors) {
    const forms = v.signature ? [{hex: v.statement_utf8_hex, sig: v.signature}] : [];
    for (const alt of v.accepted_alternatives || []) forms.push({hex: alt.statement_utf8_hex, sig: alt.signature});
    for (const f of forms) {
      const key = byPub[v.pubkey];
      const msg = hexToBytes(f.hex);
      const sig = basis.sign(msg, key.secret, hexToBytes(key.pubkey), {randomBytes: generatorNonces(key.secret, msg)});
      assert.equal(bytesToHex(sig), f.sig, v.name);
      n++;
    }
  }
  const expected = statementsVec.vectors.reduce((c, v) => c + (v.signature ? 1 : 0) + (v.accepted_alternatives || []).length, 0);
  assert.equal(n, expected);   // every accepted statement (refused inputs carry no signature) and every alternative form
  assert.ok(n > 50);
});
