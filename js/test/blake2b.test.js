// BLAKE2b (RFC 7693) and SHA-256: RFC/FIPS test vectors, the RFC 7693 Appendix E self-test (all digest lengths, keyed
// and unkeyed), and node:crypto where it overlaps (blake2b512 = unkeyed 64-byte digests; sha256).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {Blake2b, blake2b, blake2b256, bytesToHex, hexToBytes, sha256, utf8} from '../src/index.js';

function seq(len, seed) {   // RFC 7693 Appendix E selftest_seq()
  const out = new Uint8Array(len);
  let a = Math.imul(0xDEAD4BAD, seed) >>> 0, b = 1;
  for (let i = 0; i < len; i++) {
    const t = (a + b) >>> 0;
    a = b;
    b = t;
    out[i] = (t >>> 24) & 0xff;
  }
  return out;
}

const fill = len => Uint8Array.from({length: len}, (_, i) => (i * 131 + 7) & 0xff);

test('RFC 7693 Appendix A: BLAKE2b-512("abc")', () => {
  assert.equal(bytesToHex(blake2b(utf8('abc'), 64)),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});

test('RFC 7693 Appendix E: BLAKE2b self-test grand hash (digest lengths 20/32/48/64, keyed and unkeyed)', () => {
  const ctx = new Blake2b(32);
  for (const outLen of [20, 32, 48, 64]) {
    for (const inLen of [0, 3, 128, 129, 255, 1024]) {
      const input = seq(inLen, inLen);
      ctx.update(blake2b(input, outLen));
      ctx.update(blake2b(input, outLen, seq(outLen, outLen)));
    }
  }
  assert.equal(bytesToHex(ctx.digest()), 'c23a7800d98123bd10f506c61e29da5603d763b8bbad2e737f5e765a7bccd475');
});

test('BLAKE2b-256("") is the value the protocol states (section 6), and is not truncated BLAKE2b-512', () => {
  assert.equal(bytesToHex(blake2b256()), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
  assert.notEqual(bytesToHex(blake2b256(utf8('abc'))), bytesToHex(blake2b(utf8('abc'), 64)).slice(0, 64));
});

test('BLAKE2b-512 equals node:crypto blake2b512 for 0..300 bytes and larger inputs, one-shot and incremental', () => {
  for (const len of [...Array(301).keys(), 511, 512, 513, 1000, 4096, 65537]) {
    const m = fill(len);
    const want = crypto.createHash('blake2b512').update(m).digest('hex');
    assert.equal(bytesToHex(blake2b(m, 64)), want, `length ${len}`);
    const inc = new Blake2b(64);
    for (let i = 0; i < len; i += 37) inc.update(m.subarray(i, i + 37));
    assert.equal(bytesToHex(inc.digest()), want, `incremental, length ${len}`);
  }
});

test('blake2b256(...parts) hashes the concatenation of its parts', () => {
  const a = fill(33), b = fill(80), c = fill(33);
  const joined = new Uint8Array([...a, ...b, ...c]);
  assert.equal(bytesToHex(blake2b256(a, b, c)), bytesToHex(blake2b(joined, 32)));
});

test('BLAKE2b parameter checks', () => {
  assert.throws(() => new Blake2b(0), RangeError);
  assert.throws(() => new Blake2b(65), RangeError);
  assert.throws(() => new Blake2b(32, new Uint8Array(65)), RangeError);
  const h = new Blake2b(32);
  h.digest();
  assert.throws(() => h.update(new Uint8Array(1)));
});

test('SHA-256: FIPS 180-4 vectors and node:crypto for 0..300 bytes and larger inputs', () => {
  assert.equal(bytesToHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(bytesToHex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(bytesToHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  for (const len of [...Array(301).keys(), 1000, 4096, 65537]) {
    const m = fill(len);
    assert.equal(bytesToHex(sha256(m)), crypto.createHash('sha256').update(m).digest('hex'), `length ${len}`);
  }
});

test('hex helpers are strict', () => {
  assert.deepEqual([...hexToBytes('00ff10')], [0, 255, 16]);
  assert.throws(() => hexToBytes('abc'), TypeError);
  assert.throws(() => hexToBytes('zz'), TypeError);
  assert.throws(() => hexToBytes(' 00'), TypeError);
});
