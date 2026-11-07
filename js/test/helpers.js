// Shared test helpers (not a test file). Everything here is offline: vectors come from ../../spec/vectors and the only
// "server" is a fake fetch that answers from recorded responses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {basis, bytesToHex, hexToBytes} from '../src/index.js';

export const VECTORS_DIR = fileURLToPath(new URL('../../spec/vectors/', import.meta.url));

export function vec(name) {
  return JSON.parse(fs.readFileSync(VECTORS_DIR + name, 'utf8'));
}

const int = b => BigInt('0x' + Buffer.from(b).toString('hex'));
const be32 = x => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');

/** The PUBLIC test-key derivation of generate.mjs / check_python.py: (int(sha256(utf8(label))) mod (n-1)) + 1. */
export function testKey(label) {
  const s = int(crypto.createHash('sha256').update(label, 'utf8').digest()) % (basis.N - 1n) + 1n;
  return new Uint8Array(be32(s));
}

/**
 * A nonce source reproducing generate.mjs schnorrSign(): attempt ctr uses k = int(sha256(be32(sk) || msg || String(ctr)))
 * mod (n-1) + 1. Handed to basis.sign() as options.randomBytes, it makes sign() produce the generator's exact bytes,
 * provided sign() draws one 32-byte value per attempt and applies the same retry rules in the same order.
 */
export function generatorNonces(secret, message) {
  let ctr = 0;
  const sk = be32(int(secret));
  return n => {
    if (n !== 32) throw new Error(`unexpected randomBytes(${n})`);
    const k = int(crypto.createHash('sha256').update(sk).update(message).update(String(ctr++)).digest()) % (basis.N - 1n) + 1n;
    return new Uint8Array(be32(k));
  };
}

/** Test keys of the vectors, by name: {secret, pubkey}. */
export function testKeys(meta) {
  return Object.fromEntries(Object.entries(meta.test_keys).map(([name, k]) => [name, {secret: testKey(k.label), pubkey: k.pubkey, label: k.label}]));
}

export function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
}

/** A fake fetch serving {"METHOD /path": {status, body}}; records every call. */
export function fakeFetch(routes, base = 'http://valun.invalid') {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    const key = `${init.method || 'GET'} ${path}`;
    calls.push({key, url, init, body: init.body ? JSON.parse(init.body) : undefined, headers: {...(init.headers || {})}});
    const r = typeof routes === 'function' ? routes(key, init) : routes[key];
    if (!r) return jsonResponse(599, {error: 'unexpected_request', message: key});
    return jsonResponse(r.status ?? 200, r.body);
  };
  f.calls = calls;
  return f;
}

export {bytesToHex, hexToBytes};
