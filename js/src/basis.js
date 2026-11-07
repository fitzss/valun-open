// Basis-compatible Schnorr signatures over secp256k1, in plain JavaScript with BigInt (no dependencies).
//
// A port of the Python client's basis.py, which mirrors basis_core::schnorr_sign / SchnorrVerifier at Basis 3df7ed93:
//   signature = a (33-byte compressed point k*G) || z (32 bytes, big-endian)
//   e = blake2b256(a || message || public_key), read as a big-endian integer
//   z = k + e*s mod n, retried until e < 2^255 and 0 < z < 2^255 (ErgoScript reads both as signed integers),
//   verified as z*G == a + e*X.
// Note message (80 bytes): debt_key(32) || total(8 BE) || timestamp(8 BE) || tracker_nft_id(32),
// debt_key = blake2b256(issuer_pk || recipient_pk [|| token_id]).
//
// A client-side signer, so a participant's key never leaves its machine. Not constant-time (BigInt arithmetic): fine
// for a local signer in an experiment, not for an exposed signing service.

import {blake2b256} from './blake2b.js';
import {bigIntToBytes, bytesToBigInt, concatBytes, equalBytes, hexToBytes, toBytes} from './bytes.js';
import {SignatureError} from './errors.js';
import {randomBytes as defaultRandomBytes} from './random.js';

export const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
export const G = Object.freeze([
  0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
]);
export const HALF = 1n << 255n;

export {blake2b256, SignatureError};

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function powmod(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function invert(a, m = P) {
  let [r0, r1] = [mod(a, m), m], [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new SignatureError('not invertible');
  return mod(s0, m);
}

// ---- secp256k1 arithmetic (Jacobian coordinates; null is the point at infinity) ----
function double(j) {
  if (j === null) return null;
  const [x, y, z] = j;
  if (y === 0n) return null;
  const yy = (y * y) % P;
  const s = (4n * x * yy) % P;
  const m = (3n * x * x) % P;
  const x3 = mod(m * m - 2n * s);
  const y3 = mod(m * (s - x3) - 8n * yy * yy);
  return [x3, y3, (2n * y * z) % P];
}

function add(j1, j2) {
  if (j1 === null) return j2;
  if (j2 === null) return j1;
  const [x1, y1, z1] = j1, [x2, y2, z2] = j2;
  const z1z1 = (z1 * z1) % P, z2z2 = (z2 * z2) % P;
  const u1 = (x1 * z2z2) % P, u2 = (x2 * z1z1) % P;
  const s1 = (y1 * z2 * z2z2) % P, s2 = (y2 * z1 * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? double(j1) : null;
  const h = mod(u2 - u1), r = mod(s2 - s1);
  const h2 = (h * h) % P;
  const h3 = (h * h2) % P, u1h2 = (u1 * h2) % P;
  const x3 = mod(r * r - h3 - 2n * u1h2);
  const y3 = mod(r * (u1h2 - x3) - s1 * h3);
  return [x3, y3, (h * z1 * z2) % P];
}

function affine(j) {
  if (j === null || j[2] % P === 0n) return null;
  const zi = invert(j[2]);
  const zi2 = (zi * zi) % P;
  return [(j[0] * zi2) % P, (j[1] * zi2 * zi) % P];
}

function mul(k, pt) {
  let acc = null, addend = [pt[0], pt[1], 1n];
  while (k > 0n) {
    if (k & 1n) acc = add(acc, addend);
    addend = double(addend);
    k >>= 1n;
  }
  return acc;   // Jacobian
}

function compress(pt) {
  return concatBytes(Uint8Array.of(2 + Number(pt[1] & 1n)), bigIntToBytes(pt[0], 32));
}

function decompress(b) {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) throw new SignatureError('not a compressed secp256k1 point');
  const x = bytesToBigInt(b.subarray(1));
  if (x >= P) throw new SignatureError('point x out of range');
  const y2 = mod(x * x * x + 7n);
  let y = powmod(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) throw new SignatureError('point is not on the curve');
  if ((y & 1n) !== BigInt(b[0] & 1)) y = P - y;
  return [x, y];
}

// ---- keys ----
function scalarFrom(secret) {
  const sk = toBytes(secret, 'secret key');
  const s = sk.length === 32 ? bytesToBigInt(sk) : 0n;
  if (!(s > 0n && s < N)) throw new SignatureError('secret key out of range');
  return s;
}

/** A uniformly random scalar in [1, n-1] from 32-byte draws (rejection sampling; a draw is rejected with p ~ 2^-128). */
function randomScalar(randomBytes) {
  for (;;) {
    const b = randomBytes(32);
    if (!(b instanceof Uint8Array) || b.length !== 32) throw new TypeError('randomBytes(32) must return 32 bytes');
    const k = bytesToBigInt(b);
    if (k > 0n && k < N) return k;
  }
}

/** A new secret key: 32 bytes, uniform in [1, n-1], from the platform CSPRNG (or the `randomBytes` given). */
export function generateSecret(randomBytes = defaultRandomBytes) {
  return bigIntToBytes(randomScalar(randomBytes), 32);
}

/** The 33-byte compressed public key of a 32-byte secret (Uint8Array or hex). */
export function publicKey(secret) {
  return compress(affine(mul(scalarFrom(secret), G)));
}

/** Throws SignatureError unless `pk` is a valid compressed secp256k1 point. */
export function validatePublicKey(pk) {
  decompress(toBytes(pk, 'public key'));
}

// ---- Schnorr (Basis) ----
function challenge(a, message, pk) {
  return blake2b256(a, message, pk);
}

/**
 * Sign `message` (Uint8Array: the exact bytes, e.g. UTF-8 of a statement or the 80-byte note message) with `secret`.
 * `pk`, if given, must be the secret's public key. `options.randomBytes` replaces the nonce source (tests only).
 * Returns the 65-byte signature a || z.
 */
export function sign(message, secret, pk = undefined, options = {}) {
  if (!(message instanceof Uint8Array)) throw new TypeError('message must be a Uint8Array (the exact bytes to sign)');
  const s = scalarFrom(secret);
  const own = compress(affine(mul(s, G)));
  const X = pk === undefined || pk === null ? own : toBytes(pk, 'public key');
  if (!equalBytes(X, own)) throw new SignatureError('secret does not match public key');
  const rnd = options.randomBytes || defaultRandomBytes;
  for (;;) {
    const k = randomScalar(rnd);
    const a = compress(affine(mul(k, G)));
    const eBytes = challenge(a, message, X);
    const e = bytesToBigInt(eBytes);
    if (eBytes[0] >= 0x80 || e >= N) continue;           // the contract reads e as a signed integer
    const z = (k + e * s) % N;
    if (z === 0n || z >= HALF) continue;                 // same retry rule as basis_core / SigUtils
    const sig = concatBytes(a, bigIntToBytes(z, 32));
    if (!verify(sig, message, X)) continue;              // never emit a signature Basis would reject
    return sig;
  }
}

/** True iff `sig` (65 bytes) is a valid Basis Schnorr signature of `message` by public key `pk`. Never throws. */
export function verify(sig, message, pk) {
  try {
    sig = toBytes(sig, 'signature');
    pk = toBytes(pk, 'public key');
    if (!(message instanceof Uint8Array)) return false;
    if (sig.length !== 65 || (sig[0] !== 2 && sig[0] !== 3)) return false;
    const a = sig.subarray(0, 33), zBytes = sig.subarray(33);
    if (zBytes.every(x => x === 0) || (zBytes[0] & 0x80)) return false;
    const xPt = decompress(pk);
    const aPt = decompress(a);
    const eBytes = challenge(a, message, pk);
    const e = bytesToBigInt(eBytes);
    if ((eBytes[0] & 0x80) || e >= N) return false;
    const z = bytesToBigInt(zBytes);
    if (!(z > 0n && z < N)) return false;
    const left = affine(mul(z, G));
    const right = affine(add([aPt[0], aPt[1], 1n], mul(e, xPt)));
    return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
  } catch {
    return false;
  }
}

/** verify() over hex inputs: false (never an exception) for anything malformed. */
export function verifyHex(sigHex, message, pkHex) {
  if (typeof sigHex !== 'string' || typeof pkHex !== 'string') return false;
  if (!/^[0-9a-f]{130}$/.test(sigHex) || !/^0[23][0-9a-f]{64}$/.test(pkHex)) return false;
  return verify(hexToBytes(sigHex), message, hexToBytes(pkHex));
}

// ---- Basis note messages ----
const TOKEN_DENOMINATION = /^token:([0-9a-f]{64})$/;

/** Basis debt key: blake2b256(issuer || recipient) for "erg", blake2b256(issuer || recipient || token_id) for "token:<id>". */
export function debtKey(issuerPk, recipientPk, denomination = 'erg') {
  const i = toBytes(issuerPk, 'issuer public key'), r = toBytes(recipientPk, 'recipient public key');
  if (i.length !== 33 || r.length !== 33) throw new SignatureError('public keys must be 33 bytes');
  if (denomination === 'erg') return blake2b256(i, r);
  const m = typeof denomination === 'string' ? TOKEN_DENOMINATION.exec(denomination) : null;
  if (m) return blake2b256(i, r, hexToBytes(m[1]));
  throw new SignatureError(`unsupported denomination ${JSON.stringify(denomination)}`);
}

function u64(x, what) {
  let v;
  if (typeof x === 'bigint') v = x;
  else if (typeof x === 'number' && Number.isSafeInteger(x)) v = BigInt(x);
  else if (typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x)) v = BigInt(x);
  else throw new SignatureError(`bad note fields: ${what} must be an integer`);
  if (v < 0n || v >= 1n << 64n) throw new SignatureError(`bad note fields: ${what} out of u64 range`);
  return bigIntToBytes(v, 8);
}

/**
 * The 80-byte Basis note message. `total` and `timestamp` (ms) are integers (number, bigint or decimal string) in
 * [0, 2^64); `trackerNftId` is 32 bytes (or 64 hex).
 */
export function noteMessage(issuerPk, recipientPk, total, timestamp, trackerNftId, denomination = 'erg') {
  const nft = toBytes(trackerNftId, 'tracker_nft_id');
  if (nft.length !== 32) throw new SignatureError('bad note fields: tracker_nft_id must be 32 bytes');
  return concatBytes(debtKey(issuerPk, recipientPk, denomination), u64(total, 'total'), u64(timestamp, 'timestamp'), nft);
}
