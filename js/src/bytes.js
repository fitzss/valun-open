// Byte helpers shared by every module. No dependencies; works in Node, Deno, Bun and browsers.

const HEX = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'));
const ENCODER = new TextEncoder();

/** Lowercase hex of a byte array. */
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/** Bytes of an even-length hex string (upper or lower case, nothing else). Throws TypeError otherwise. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError('expected an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** UTF-8 bytes of a string (a lone surrogate becomes U+FFFD, exactly as Node's Buffer does on the server). */
export function utf8(text) {
  return ENCODER.encode(text);
}

export function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Big-endian unsigned integer of a byte array. */
export function bytesToBigInt(bytes) {
  return bytes.length === 0 ? 0n : BigInt('0x' + bytesToHex(bytes));
}

/** `len` bytes, big-endian, of a non-negative BigInt that fits. */
export function bigIntToBytes(x, len) {
  if (typeof x !== 'bigint' || x < 0n || x >= 1n << BigInt(8 * len)) throw new RangeError(`value does not fit in ${len} bytes`);
  return hexToBytes(x.toString(16).padStart(len * 2, '0'));
}

/** Accepts a Uint8Array or a hex string and returns bytes (hex strings are decoded). */
export function toBytes(x, what = 'value') {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return hexToBytes(x);
  throw new TypeError(`${what} must be a Uint8Array or a hex string`);
}
