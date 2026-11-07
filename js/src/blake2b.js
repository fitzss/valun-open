// BLAKE2b (RFC 7693) in plain JavaScript: digest length 1..64 bytes set in the parameter block, optional key (0..64
// bytes). 64-bit words are held as (low, high) pairs of 32-bit integers in Uint32Arrays, as in the RFC's reference
// structure. BLAKE2b-256 here is BLAKE2b with digest length 32, which is NOT the first 32 bytes of BLAKE2b-512.

// Initialisation vector, as (low, high) 32-bit halves of the eight 64-bit words.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// v[a] += v[b]   (64-bit, word indices are pair offsets)
function add64(v, a, b) {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

// v[a] += (lo, hi)
function add64c(v, a, lo, hi) {
  const l = v[a] + lo;
  v[a + 1] = v[a + 1] + hi + (l >= 0x100000000 ? 1 : 0);
  v[a] = l;
}

function mix(v, m, a, b, c, d, x, y) {
  add64(v, a, b);
  add64c(v, a, m[x], m[x + 1]);
  // v[d] = (v[d] ^ v[a]) >>> 32
  let lo = v[d] ^ v[a], hi = v[d + 1] ^ v[a + 1];
  v[d] = hi; v[d + 1] = lo;
  add64(v, c, d);
  // v[b] = (v[b] ^ v[c]) >>> 24
  lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
  v[b] = (lo >>> 24) | (hi << 8); v[b + 1] = (hi >>> 24) | (lo << 8);
  add64(v, a, b);
  add64c(v, a, m[y], m[y + 1]);
  // v[d] = (v[d] ^ v[a]) >>> 16
  lo = v[d] ^ v[a]; hi = v[d + 1] ^ v[a + 1];
  v[d] = (lo >>> 16) | (hi << 16); v[d + 1] = (hi >>> 16) | (lo << 16);
  add64(v, c, d);
  // v[b] = (v[b] ^ v[c]) >>> 63  (= rotate left by 1)
  lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
  v[b] = (hi >>> 31) | (lo << 1); v[b + 1] = (lo >>> 31) | (hi << 1);
}

function compress(ctx, last) {
  const {h, v, m, b} = ctx;
  for (let i = 0; i < 16; i++) { v[i] = h[i]; v[i + 16] = IV[i]; }
  // t is a byte counter < 2^53 (the 128-bit counter's high 64 bits stay 0)
  v[24] ^= ctx.t >>> 0;
  v[25] ^= Math.floor(ctx.t / 0x100000000);
  if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
  for (let i = 0; i < 32; i++) m[i] = b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24);
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    mix(v, m, 0, 8, 16, 24, s[0] * 2, s[1] * 2);
    mix(v, m, 2, 10, 18, 26, s[2] * 2, s[3] * 2);
    mix(v, m, 4, 12, 20, 28, s[4] * 2, s[5] * 2);
    mix(v, m, 6, 14, 22, 30, s[6] * 2, s[7] * 2);
    mix(v, m, 0, 10, 20, 30, s[8] * 2, s[9] * 2);
    mix(v, m, 2, 12, 22, 24, s[10] * 2, s[11] * 2);
    mix(v, m, 4, 14, 16, 26, s[12] * 2, s[13] * 2);
    mix(v, m, 6, 8, 18, 28, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

/** Incremental BLAKE2b. `outLen` 1..64, optional `key` (Uint8Array, 0..64 bytes). */
export class Blake2b {
  constructor(outLen = 64, key = undefined) {
    const keyLen = key ? key.length : 0;
    if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('BLAKE2b digest length must be 1..64');
    if (keyLen > 64) throw new RangeError('BLAKE2b key must be at most 64 bytes');
    this.outLen = outLen;
    this.h = new Uint32Array(IV);
    this.h[0] ^= 0x01010000 ^ (keyLen << 8) ^ outLen;   // parameter block: digest length, key length, fanout 1, depth 1
    this.v = new Uint32Array(32);
    this.m = new Uint32Array(32);
    this.b = new Uint8Array(128);
    this.c = 0;
    this.t = 0;
    this.done = false;
    if (keyLen > 0) {
      this.update(key);
      this.c = 128;   // the key block is always a full (zero-padded) block
    }
  }

  update(data) {
    if (this.done) throw new Error('BLAKE2b: update after digest');
    for (let i = 0; i < data.length; i++) {
      if (this.c === 128) {
        this.t += 128;
        compress(this, false);
        this.c = 0;
      }
      this.b[this.c++] = data[i];
    }
    return this;
  }

  digest() {
    if (this.done) throw new Error('BLAKE2b: digest called twice');
    this.done = true;
    this.t += this.c;
    this.b.fill(0, this.c);
    compress(this, true);
    const out = new Uint8Array(this.outLen);
    for (let i = 0; i < this.outLen; i++) out[i] = this.h[i >> 2] >>> (8 * (i & 3));
    return out;
  }
}

/** One-shot BLAKE2b of `data` with digest length `outLen` (default 64) and optional key. */
export function blake2b(data, outLen = 64, key = undefined) {
  return new Blake2b(outLen, key).update(data).digest();
}

/** BLAKE2b-256 (digest length 32, unkeyed) over the concatenation of the byte arrays given. */
export function blake2b256(...parts) {
  const h = new Blake2b(32);
  for (const p of parts) h.update(p);
  return h.digest();
}
