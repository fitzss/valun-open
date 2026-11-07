#!/usr/bin/env node
// Conformance vectors for valun-deal/1 (network valun-pilot-1), generated from the REAL server code.
//
//   node spec/vectors/generate.mjs        (VALUN_APP_DIR=<path to valun-app> overrides the default ../../../valun-app)
//
// Written against server release v13 = valun-app commit 6a6a34b. Point VALUN_APP_DIR at an export of exactly that commit
// (git archive 6a6a34b), not at a working tree that may hold unreleased changes: the script records the sha256 of the
// server sources it ran, and labels the output "UNRECOGNISED server source" (with a warning) when they are not v13's.
// Every assertion below pins v13 behaviour; a server change that breaks one stops the script before anything is written.
// (Earlier releases: v8 e0b990a, v9 ed1da4a, v11 7880dcf, v12 a61c32e; the transcript keeps their steps first and
// appends later releases' steps.)
//
// Writes, next to this file: canonical.json, statements.json, basis-notes.json, basis-signatures.json,
// terms-validation.json, transcript.json. Output is deterministic: running it twice gives identical files, so a diff
// after a server change shows exactly what changed on the wire.
//
// What is real and what is a stand-in:
// - canonical(), termsHash(), sha256(), statements.*, Pilot (validateTerms, propose, counter, accept, decline, withdraw,
//   deliver, noteTemplate, complete, dispute, approvals, mandates, revocation, views) and the HTTP route table
//   (createPilotRoutes) are imported from valun-app/lib/pilot/{core,http}.mjs and run unchanged, in memory, with a
//   fixed clock. Nothing listens on a port; nothing touches the network or the disk except the output files here.
// - The server checks Basis signatures and builds Basis note messages in a Rust helper (basis/valun_signer.rs ->
//   basis_core, Basis pinned at 3df7ed93). That helper is NOT run here. This script carries a minimal replica
//   (BLAKE2b-256 per RFC 7693, secp256k1, the Basis Schnorr scheme, the 80-byte note message) and refuses to write
//   anything unless the replica reproduces Basis's official cross-validation vectors TV001-TV011 (copied from
//   hermes-plugin-valun/tests/test_valun_basis.py, which cites basis-tracker specs/SCHNORR_SIGNATURE_SPEC.md; Basis is
//   CC0-1.0). The token-denomination debt key has no official vector; see OPEN-QUESTIONS.md.
// - The Basis tracker is an in-memory stand-in: tracker-side fields in the transcript (tracker_note, proof, ledger rows,
//   positions) have the shapes Valun reads, not necessarily the real tracker's values.
// - Signer and tracker failures (OQ-31, OQ-35) are emulated: the transcript's stand-in signer and tracker throw the real
//   BasisError class (imported from valun-app/lib/basis.mjs, which starts nothing on import) with the signer runner's
//   messages and codes: an outage ("signer timed out", code signer_unavailable), input the helper reports as invalid
//   ("signer: ...", code signer_error), a tracker that cannot be reached (code tracker_unavailable). The runner is not run.
// - Errors become responses as lib/http.mjs:96-108 does it (replicated here, since lib/http.mjs serves the whole app;
//   its sha256 is pinned with the other sources).
// - Rate-limit probes (OQ-30) use a second route table over the same Pilot with small budgets and the real clock.
// - The text normalisation clean() is not exported by core.mjs; cleanText() below replicates its normalising part and the
//   script asserts it equals what the real decline()/dispute() code signed over, for every reason vector.
//
// Keys: fixed PUBLIC TEST KEYS derived from public labels (TEST_KEY_LABELS). Anyone can sign with them. Never use them
// for anything real. No real secret is generated, read or written. During generation crypto.randomBytes is replaced by
// a seeded generator so participant/approval ids are reproducible; every token, invite code and the admin token that the
// in-memory server produces is replaced by a placeholder (e.g. "<alice.agent>") in transcript.json. Enrollment codes are
// kept (sha256(code) is part of the signed enroll statement); they are fixtures of this in-memory run, valid nowhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.VALUN_APP_DIR || path.join(here, '..', '..', '..', 'valun-app'));
const CORE = path.join(APP, 'lib', 'pilot', 'core.mjs'), HTTPM = path.join(APP, 'lib', 'pilot', 'http.mjs');

// ---- deterministic randomness for the in-memory server (ids, codes); restored at the end ---------------------------
const realRandomBytes = crypto.randomBytes;
let rngCounter = 0;
crypto.randomBytes = (n, cb) => {
  if (cb) throw Error('async randomBytes is not supported while generating fixtures');
  const out = Buffer.alloc(n);
  for (let off = 0; off < n;) off += crypto.createHash('sha256').update(`valun-open/spec/fixture-rng/${rngCounter++}`).digest().copy(out, off);
  return out;
};

const core = await import(pathToFileURL(CORE).href);
const {createPilotRoutes} = await import(pathToFileURL(HTTPM).href);
// The real BasisError class (lib/basis.mjs; importing it starts nothing): the stand-in signer and tracker throw it, with
// the codes makeSignerRunner and the tracker client use (lib/basis.mjs:16-45).
const {BasisError} = await import(pathToFileURL(path.join(APP, 'lib', 'basis.mjs')).href);
const {canonical, termsHash, statements, sha256, NETWORK, PROTOCOL, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_MANDATE, Pilot} = core;

const fileSha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const SOURCES = {'lib/pilot/core.mjs': fileSha(CORE), 'lib/pilot/http.mjs': fileSha(HTTPM), 'lib/basis.mjs': fileSha(path.join(APP, 'lib', 'basis.mjs')),
  'lib/http.mjs': fileSha(path.join(APP, 'lib', 'http.mjs'))};
// Release v13 = valun-app commit 6a6a34b (git archive 6a6a34b). Other sources still run, but are labelled as such.
const V13_SOURCES = {'lib/pilot/core.mjs': '7dc469e0547ae0a518c022b93cff6181fd116f4fcc3f8f3b7a3deb0e0f240b2e',
  'lib/pilot/http.mjs': '01a505623d64c0a2c00a221240d57b5631c91dec61f5caaeb37113e8497c0f0e', 'lib/basis.mjs': '991e37a2319de3731c0ef84ea5847ba428e3575a3c8facd51be1c7cd52891617',
  'lib/http.mjs': '2ef7d0f77a418da7633d5abd5591f2cec39e455e42b953efc401b8f6061c3baf'};
const IS_V13 = Object.entries(V13_SOURCES).every(([f, h]) => SOURCES[f] === h);
const SERVER_RELEASE = IS_V13 ? 'v13 (valun-app commit 6a6a34b)' : 'UNRECOGNISED server source (not release v13 6a6a34b; see server_source_sha256)';
if (!IS_V13) console.error(`WARNING: ${APP} is not release v13 (6a6a34b): ${JSON.stringify(SOURCES)}. The vectors are labelled accordingly; assertions may fail.`);
// A signature with the shape the server checks before calling the signer (02/03 prefix, 130 lowercase hex: core.mjs:64)
// that can never verify (z = 0). Used for dry runs that record which statements the server would accept. Since v9 an
// all-zero signature ('00' x 65) is refused before the signer runs, so it no longer reveals anything.
const DRY_SIG = '02' + '00'.repeat(64);
const hx = h => Buffer.from(h, 'hex');
const utf8hex = s => Buffer.from(s, 'utf8').toString('hex');

// =====================================================================================================================
// Basis replica: BLAKE2b (RFC 7693), secp256k1, Basis Schnorr (basis_core schnorr_sign / SchnorrVerifier), note message
// =====================================================================================================================
const M64 = (1n << 64n) - 1n;
const B2_IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const B2_SIGMA = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
function blake2b(msg, outLen = 32) {
  const h = B2_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(msg.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = Buffer.alloc(128);
    msg.copy(block, 0, i * 128, Math.min(msg.length, (i + 1) * 128));
    const m = Array.from({length: 16}, (_, j) => block.readBigUInt64LE(j * 8));
    const v = [...h, ...B2_IV], t = BigInt(Math.min(msg.length, (i + 1) * 128));
    v[12] ^= t & M64; v[13] ^= t >> 64n;
    if (i === blocks - 1) v[14] ^= M64;
    const G = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = B2_SIGMA[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let j = 0; j < 8; j++) h[j] ^= v[j] ^ v[j + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((x, j) => out.writeBigUInt64LE(x, j * 8));
  return out.subarray(0, outLen);
}
const blake2b256 = (...parts) => blake2b(Buffer.concat(parts), 32);

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G0 = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function powmod(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function padd(p1, p2) {
  if (!p1) return p2; if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let l;
  if (x1 === x2) { if (mod(y1 + y2) === 0n) return null; l = mod(3n * x1 * x1 * inv(2n * y1)); }
  else l = mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
function pmul(k, pt) { let acc = null, add = pt; while (k > 0n) { if (k & 1n) acc = padd(acc, add); add = padd(add, add); k >>= 1n; } return acc; }
const be32 = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const int = b => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const compress = pt => Buffer.concat([Buffer.from([2 + Number(pt[1] & 1n)]), be32(pt[0])]);
function decompress(b) {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return null;
  const x = int(b.subarray(1));
  if (x >= P) return null;
  const y2 = mod(x ** 3n + 7n); let y = powmod(y2, (P + 1n) / 4n, P);
  if (y * y % P !== y2) return null;
  if (Number(y & 1n) !== (b[0] & 1)) y = P - y;
  return [x, y];
}
const pubOf = sk => compress(pmul(sk, G0));
// Verification exactly as basis_core SchnorrVerifier / valun_basis.verify: sig = a(33) || z(32 BE); e = blake2b256(a||m||X);
// reject when e or z has its top bit set (ErgoScript reads both as signed), when z = 0 or z >= n; accept iff z*G == a + e*X.
function schnorrVerify(sig, msg, pk) {
  if (sig.length !== 65 || (sig[0] !== 2 && sig[0] !== 3)) return false;
  const a = sig.subarray(0, 33), zb = sig.subarray(33);
  if (zb.every(x => x === 0) || zb[0] & 0x80) return false;
  const X = decompress(pk), A = decompress(a);
  if (!X || !A) return false;
  const eb = blake2b256(a, msg, pk), e = int(eb);
  if (eb[0] & 0x80 || e >= N) return false;
  const z = int(zb);
  if (!(z > 0n && z < N)) return false;
  const L = pmul(z, G0), R = padd(A, pmul(e, X));
  return !!L && !!R && L[0] === R[0] && L[1] === R[1];
}
// Signing as basis_core schnorr_sign, with a DETERMINISTIC nonce (sha256 of key, message, counter) so the vector files are
// reproducible. Retry rule as basis_core: e < 2^255 (and < n), 0 < z < 2^255.
function schnorrSign(msg, sk) {
  const pk = pubOf(sk);
  for (let ctr = 0; ; ctr++) {
    const k = int(crypto.createHash('sha256').update(be32(sk)).update(msg).update(String(ctr)).digest()) % (N - 1n) + 1n;
    const a = compress(pmul(k, G0)), eb = blake2b256(a, msg, pk), e = int(eb);
    if (eb[0] >= 0x80 || e >= N) continue;
    const z = (k + e * sk) % N;
    if (z === 0n || z >= 1n << 255n) continue;
    const sig = Buffer.concat([a, be32(z)]);
    assert.ok(schnorrVerify(sig, msg, pk), 'replica signer produced a signature its verifier rejects');
    return sig;
  }
}
// Basis debt key and 80-byte note message (basis_core DenomKey::debt_key / signing_message, as valun_signer note-message).
function debtKey(issuer, recipient, denomination) {
  if (denomination === 'erg') return blake2b256(issuer, recipient);
  const m = /^token:([0-9a-f]{64})$/.exec(denomination);
  if (!m) throw Error(`unsupported denomination ${denomination}`);
  return blake2b256(issuer, recipient, hx(m[1]));
}
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const noteMessage = (issuer, recipient, total, timestamp, nft, denomination) =>
  Buffer.concat([debtKey(issuer, recipient, denomination), u64(total), u64(timestamp), nft]);

// ---- replica self-tests: refuse to write vectors from a replica that does not match the references -------------------
assert.equal(blake2b(Buffer.alloc(0), 32).toString('hex'), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8', 'BLAKE2b-256("") (RFC 7693 / reference)');
for (const len of [0, 1, 3, 127, 128, 129, 255, 256, 300]) {
  const b = crypto.createHash('sha256').update(String(len)).digest(), msg = Buffer.concat(Array(Math.ceil(len / 32) + 1).fill(b)).subarray(0, len);
  assert.equal(blake2b(msg, 64).toString('hex'), crypto.createHash('blake2b512').update(msg).digest('hex'), `BLAKE2b-512 replica vs OpenSSL, ${len} bytes`);
}
// Basis official cross-validation vectors (TV001-TV011; via hermes-plugin-valun/tests/test_valun_basis.py lines 9-27).
const TV_ALICE = '02fc84de78d191f6b47b6ba97bf1eb5ba3b541c8ca247461f41dafdd6db11bc063';
const TV_BOB = '023bc6f9ff8a2af3992d23c145de5a868bae6b80a3dd3b24a1de4c6486472e9dbd';
const TV_TRACKER = '02b651a75c3cec621fa493dfa45fbb42ff77943acdceeb9543163d76e3d81cb645';
const TV_NFT = '42'.repeat(32);
const TV_M1 = '76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000003b9aca0000000195e97f78004242424242424242424242424242424242424242424242424242424242424242';
const OFFICIAL = [
  ['TV001', TV_ALICE, '1000000000', '1743379200000', TV_M1, '027742dac59ea73f7f8710648f17b9fb8ccf570460a727c02b28a6e2f310ebf4711397afdac9e6cc799beedc3309ef2b4989598768f65ea78b95151c844e86408f', true],
  ['TV002', TV_ALICE, '1000000000', '1743379200000', TV_M1, '00'.repeat(65), false],
  ['TV003', TV_TRACKER, '500000000', '1743379201000', '52eb0beb0bd0e86206e0a817785aadabbef08730fd5654ea65ebcbe1ef1b3b9e000000001dcd650000000195e97f7be84242424242424242424242424242424242424242424242424242424242424242', '02d052ebc2a622f61681dc9ad52a8cd062acc4c6acf9ba6cfdd507ae886b8054701319d7378338904e89be9604c16825a06fd831afa598248e3f3902be9d270c39', false],
  ['TV004', TV_ALICE, '1000000000', '1743379200000', TV_M1, '0240d01f20717b244800f147d2c9b559cd836c19aea344071c1639be2a22870e772bdbbaf89bb715fcc8c4ec7d8df464fb196c83a9616ef0ccd392f5ae8022d072', false],
  ['TV005', TV_ALICE, '1000000000', '1743379200000', TV_M1, '036eb16f1611ae82edfd2ca30251e6fbbb3eae03173eb16e270e53ce7f755342a16d86d89db441bb8905f86110f3e615ffaf3ceb9d7b1992c0d14d0e3cbf7f3931', false],
  ['TV006', TV_ALICE, '1000000000', '1743379200000', TV_M1, '028c3d344aefd0caa6a16ffdab0bd154b457585cd998e5ac80b86286a796f33f1e53488afbc8e3160caab535bac018b81bd62acea9b64c2a426d08727d42193720', false],
  ['TV007', TV_ALICE, '1000000000', '1743379200000', TV_M1, '03baecb66840002c131c54134b0abde112a0405f3d6d1d384b5815857ee68b9e624ba6d7c176c8631633c7e609af34f9e389f99c6e3fd64e16aa743956d66e1e11', false],
  ['TV008', TV_ALICE, '1000000000', '1743379200000', TV_M1, '0282fcc89cb99e3491bb43d1797ff2567fde0620ea38d78f937ae122ae0acf2f897169bcb397037aeb94eda8ee6e5642781f8fe1d85f33bc6a8ed5a440760fd029', false],
  ['TV009', TV_ALICE, '18446744073709551615', '18446744073709551615', '76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851fffffffffffffffffffffffffffffffff4242424242424242424242424242424242424242424242424242424242424242', '03917db7e61b54d50409c0447ebd27caa124d2702aa0ae5651381cd662162307c8055e54abdd0ba40be01c695edf95b9026c94f286a3353f63d1e2348e5d455c2f', false],
  ['TV010', TV_ALICE, '0', '0', '76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000000000000000000000000000004242424242424242424242424242424242424242424242424242424242424242', '0235f9989903d1e2ee8c274ba5494119b6deef7cd0d0e15dc07190011b524c891d5deec9c943adce1891dc5977cda361da0a81e81bbf489b3a7f6b8d2c15116ad4', true],
  ['TV011', TV_ALICE, '500000000', '1743379202000', '76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000001dcd650000000195e97f7fd04242424242424242424242424242424242424242424242424242424242424242', '02001d67f568ace3b32c68bd9cfdd3795d5df0f5057b4d837935578697675c8e334668c7b923ae13df8dd9725ac66c63a4ca6f05cc2e7d1c3d23abdcb750dea923', true],
];
for (const [name, issuer, total, ts, msg, sig, ok] of OFFICIAL) {
  assert.equal(noteMessage(hx(issuer), hx(TV_BOB), total, ts, hx(TV_NFT), 'erg').toString('hex'), msg, `${name}: note message replica`);
  assert.equal(schnorrVerify(hx(sig), hx(msg), hx(issuer)), ok, `${name}: verifier replica`);
}

// ---- fixed PUBLIC test keys --------------------------------------------------------------------------------------
// secret = (int(sha256(utf8(label))) mod (n - 1)) + 1. check_python.py derives the same keys from the same labels.
const TEST_KEY_LABELS = {alice: 'valun-open/spec/test-key/alice', bob: 'valun-open/spec/test-key/bob', carol: 'valun-open/spec/test-key/carol', 'carol-2': 'valun-open/spec/test-key/carol-2'};
const K = Object.fromEntries(Object.entries(TEST_KEY_LABELS).map(([name, label]) => {
  const sk = int(crypto.createHash('sha256').update(label, 'utf8').digest()) % (N - 1n) + 1n;
  return [name, {name, label, sk, pub: pubOf(sk).toString('hex')}];
}));
const signText = (key, text) => schnorrSign(Buffer.from(text, 'utf8'), key.sk).toString('hex');
const signHex = (key, h) => schnorrSign(hx(h), key.sk).toString('hex');
const keysMeta = Object.fromEntries(Object.values(K).map(k => [k.name, {pubkey: k.pub, label: k.label}]));

// Normalising part of core.mjs clean() (lib/pilot/core.mjs:57): control characters except TAB, LF, CR -> space, then
// ECMAScript String.prototype.trim(). Asserted below against the real decline()/dispute() code paths. Since v9 a reason
// containing such a control is refused before clean() runs, so for an accepted reason this is only the trim.
const cleanText = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const FIXTURE_NFT = sha256('valun-open/spec/fixture-tracker-nft-id');   // a fixed public 32-byte id; no tracker has it
const iso = t => new Date(t).toISOString();
const isoSec = t => new Date(Math.floor(t / 1000) * 1000).toISOString();   // the Python client writes whole seconds, ".000Z"
const H = 3600e3;

const META = (what, extra = {}) => ({
  what, server_release: SERVER_RELEASE, protocol: PROTOCOL, network: NETWORK, generated_by: 'spec/vectors/generate.mjs',
  server_source_sha256: SOURCES, pilot_token_id: PILOT_TOKEN_ID, pilot_denomination: PILOT_DENOMINATION,
  fixture_clock: iso(T0), fixture_tracker_nft_id: FIXTURE_NFT, test_keys: keysMeta,
  warning: 'All keys, codes, ids and tokens here are PUBLIC TEST FIXTURES from an in-memory run. None is valid on any server. Never use the test keys for anything real.',
  ...extra,
});

// =====================================================================================================================
// A probe Pilot: the real class, in memory, fixed clock; the stand-in Basis records what the server asked it to verify.
// =====================================================================================================================
const ALICE_ID = 'vp_a1a1a1a1a1a1', BOB_ID = 'vp_b0b0b0b0b0b0';
function probePilot({verify = 'replica'} = {}) {
  const participant = (id, handle, key) => ({id, handle, display_name: handle, operator: `test operator of ${handle}`, about: '', services: '',
    pubkey: key.pub, status: 'active', created_at: iso(T0), past_pubkeys: [], mandate: {...DEFAULT_MANDATE, max_issue_per_deal: 1000, max_issue_outstanding: 100000,
      max_accept_per_deal: 1000, max_accept_per_issuer: 100000, approve_above: 1000, expires_at: null}, mandate_version: 1});
  const state = {version: 1, network: NETWORK, createdAt: iso(T0), participants: {[ALICE_ID]: participant(ALICE_ID, 'alice', K.alice), [BOB_ID]: participant(BOB_ID, 'bob', K.bob)},
    deals: {}, approvals: {}, invites: {}};
  const log = [];
  const basis = {nft: FIXTURE_NFT, denomination: PILOT_DENOMINATION, url: 'memory://probe',
    async verify(pubkey, messageHex, sig) {
      log.push({pubkey, message_hex: messageHex, signature: sig});
      return verify === 'capture' ? true : verify === 'reject' ? false : schnorrVerify(hx(sig), hx(messageHex), hx(pubkey));
    },
    async allNotes() { return []; }, async note() { return null; }, async proof() { return null; },
    async noteMessage({issuer, recipient, total, timestamp, denomination = PILOT_DENOMINATION}) {
      return {message_hex: noteMessage(hx(issuer), hx(recipient), total, timestamp, hx(FIXTURE_NFT), denomination).toString('hex'), debt_key_hex: debtKey(hx(issuer), hx(recipient), denomination).toString('hex')};
    }};
  const pilot = new Pilot({store: {state, save() {}, audit() {}}, basis, now: () => T0});
  return {pilot, state, log, alice: state.participants[ALICE_ID], bob: state.participants[BOB_ID]};
}
const outcome = async f => { try { await f(); return 'accepted'; } catch (e) { if (e.name !== 'PilotError') throw e; return {status: e.status, error: e.code, message: e.message}; } };

// Base terms: what the Python client's build_terms produces (valun_client.py:243-257) for alice paying bob.
const baseTerms = (o = {}) => ({
  protocol: PROTOCOL, network: NETWORK, tracker_nft_id: FIXTURE_NFT, denomination: PILOT_DENOMINATION,
  deal_id: 'vd_0123456789abcdef', version: 1, prior_terms_hash: null, nonce: '00112233445566778899aabbccddeeff', proposer: ALICE_ID,
  payer: {id: ALICE_ID, pubkey: K.alice.pub}, payee: {id: BOB_ID, pubkey: K.bob.pub},
  service: {title: 'Short research brief', description: 'Summarise three sources on agent-to-agent credit.', deliverable: 'markdown, 300-500 words, 3 cited sources'},
  price: {amount: 20, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
  deliver_by: isoSec(T0 + 48 * H), offer_expires_at: isoSec(T0 + 24 * H), ...o});
const withService = (o) => baseTerms({service: {...baseTerms().service, ...o}});

// JSON text with a chosen key order (to show that order never matters).
function orderedJson(v, order) {
  if (Array.isArray(v)) return `[${v.map(x => orderedJson(x, order)).join(',')}]`;
  if (v && typeof v === 'object') return `{${order(Object.keys(v)).map(k => `${JSON.stringify(k)}:${orderedJson(v[k], order)}`).join(',')}}`;
  return JSON.stringify(v);
}
const reversed = ks => [...ks].sort().reverse();
const shuffled = ks => [...ks].sort((a, b) => sha256('o' + a).localeCompare(sha256('o' + b)));

// =====================================================================================================================
// canonical.json
// =====================================================================================================================
async function canonicalVectors() {
  const probe = probePilot();
  const out = [];
  // tier 'terms' and 'wire' vectors MUST be accepted by the real validator; tier 'refused' MUST be refused by it (the
  // canonical form is still defined, but no valid deal can carry such terms).
  const add = async (name, tier, description, inputJson, {validate = tier !== 'generic'} = {}) => {
    const value = JSON.parse(inputJson), c = canonical(value);
    const v = {name, tier, description, input_json: inputJson, canonical: c, canonical_utf8_hex: utf8hex(c), terms_hash: termsHash(value)};
    assert.equal(v.terms_hash, sha256(c));
    if (validate) v.server_validation = await outcome(async () => probe.pilot.validateTerms(value, probe.state.participants[value.proposer] || probe.alice));
    if (tier === 'terms' || tier === 'wire') assert.equal(v.server_validation, 'accepted', `${name} must be valid terms`);
    if (tier === 'refused') assert.notEqual(v.server_validation, 'accepted', `${name} must be refused`);
    out.push(v);
  };
  const T = baseTerms();
  await add('terms/base', 'terms', 'Typical v1 terms, keys in canonical order.', canonical(T));
  await add('terms/keys-reversed', 'terms', 'Same terms with every object\'s keys in reverse order: same canonical form and hash.', orderedJson(T, reversed));
  await add('terms/keys-shuffled', 'terms', 'Same terms, keys in an arbitrary order.', orderedJson(T, shuffled));
  await add('terms/pretty-printed', 'terms', 'Same terms with insignificant whitespace (2-space indentation, CRLF line breaks).', JSON.stringify(T, null, 2).replace(/\n/g, '\r\n'));
  const h1 = termsHash(T);
  await add('terms/counter-v2', 'terms', 'A version-2 counter-offer by bob: prior_terms_hash = terms_hash of terms/base.',
    canonical({...T, version: 2, prior_terms_hash: h1, nonce: 'ffeeddccbbaa99887766554433221100', proposer: BOB_ID, price: {amount: 25, unit: 'PC'}}));
  await add('terms/payee-proposes', 'terms', 'bob (payee) proposes to alice (payer).', canonical({...T, proposer: BOB_ID}));
  await add('terms/price-min', 'terms', 'Smallest price (1).', canonical(baseTerms({price: {amount: 1, unit: 'PC'}})));
  await add('terms/price-max', 'terms', 'Largest price the server accepts (1000).', canonical(baseTerms({price: {amount: 1000, unit: 'PC'}})));
  await add('terms/version-max', 'terms', 'Largest version number (50) as a counter.', canonical({...T, version: 50, prior_terms_hash: h1}), {validate: true});
  const svc = [
    ['unicode-latin', 'Latin-1 and accents, precomposed (NFC): kept as UTF-8, never escaped.', {title: 'Résumé of café études', description: 'Ångström, naïve, façade, Øre, ß.'}],
    ['unicode-nfd', 'The same title in decomposed form (NFD: e + U+0301). No Unicode normalisation: a different hash from unicode-latin.', {title: 'Re\u0301sume\u0301 of cafe\u0301 e\u0301tudes', description: 'Ångström, naïve, façade, Øre, ß.'}],
    ['unicode-cjk', 'CJK, Cyrillic, Greek.', {title: '東京の研究 — \u043A\u0440\u0430\u0442\u043A\u0438\u0439 \u043E\u0431\u0437\u043E\u0440', description: 'Ελληνικά και 中文 \u0442\u0435\u043A\u0441\u0442.'}],
    ['unicode-astral', 'Characters outside the BMP (UTF-16 surrogate pairs in JS; 4 UTF-8 bytes each).', {title: 'Brief 🙂🚀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢', description: 'Emoji and a flag (regional indicators): 🧑🏽 🇳🇿.'}],
    ['unicode-rtl', 'Right-to-left scripts without bidi controls: kept literally.', {title: '\u05E2\u05D1\u05E8\u05D9\u05EA \u05D5\u05E2\u0631\u0628\u064A', description: 'mixed \u05E2\u05D1\u05E8\u05D9\u05EA and English'}],
    ['unicode-allowed-invisible', 'NBSP, Arabic letter mark (U+061C), LRM (U+200E) and RLM (U+200F) are NOT refused (v11) and are kept literally. (In v9 this vector also held U+00AD SOFT HYPHEN, refused since v11: see refused/soft-hyphen; in v8 also U+2060 and U+0085, refused since v9.)',
      {title: 'nbsp\u00A0here', description: 'alm\u061Cmark lrm\u200Emark rlm\u200Fmark'}],
    ['emoji-zwj-sequence', 'An emoji ZWJ sequence (U+200D inside \u{1F469}\u200D\u{1F4BB}): valid since v9 (refused in v8).', {title: 'Brief by \u{1F469}\u200D\u{1F4BB}'}],
    ['persian-zwnj', 'Persian text with ZERO WIDTH NON-JOINER (U+200C), required by its orthography: valid since v9 (refused in v8).', {title: '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'}],
    ['emoji-modifiers-and-vs16', 'Skin-tone modifier, variation selector 16 (U+FE0F) directly after an emoji, and a keycap sequence: allowed (v12: after an emoji only U+FE0E/U+FE0F; after 0-9, # or * only inside a keycap, i.e. followed by U+20E3).', {title: 'Thanks \u{1F44D}\u{1F3FD} \u2764\uFE0F 1\uFE0F\u20E3'}],
    ['text-presentation-and-keycaps', 'U+FE0E (text presentation) after an emoji, and keycaps with U+FE0F or without a selector: allowed (v13; a keycap with U+FE0E is refused since v13: refused/keycap-with-fe0e).', {title: 'Heart \u2764\uFE0E', description: 'Keys 1\uFE0F\u20E3 #\uFE0F\u20E3 *\u20E3'}],
    ['single-marks-between-letters', 'Allowed in v13: ZWNJ, ZWJ, LRM, RLM and ALM, each singly, between any two characters, also where they change nothing (here between Latin letters): an invisible mark, or none, after every character (OPEN-QUESTIONS OQ-33).', {title: 'Th\u200Danks f\u200Cor th\u200Ee br\u200Fief\u061C'}],
    ['blank-looking-characters', 'Allowed in v13 (not Cc, Cf or default-ignorable): U+2800 BRAILLE PATTERN BLANK and U+1D159 MUSICAL SYMBOL NULL NOTEHEAD (category So), which render as blank space (OPEN-QUESTIONS OQ-33).', {title: 'Brief\u2800\u2800 x\u{1D159}y'}],
    ['subdivision-flags', 'The three RGI subdivision flags (England, Scotland, Wales: U+1F3F4, tag letters, U+E007F): valid since v11 (refused in v9, which refused every tag character).',
      {title: 'UK brief \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'}],
    ['line-separators', 'U+2028 and U+2029 are NOT escaped by canonical JSON (they are by some encoders, e.g. Go).', {title: 'line\u2028separator', description: 'para\u2029separator'}],
    ['html-chars', '< > & and \' are NOT escaped (Go\'s json.Marshal escapes <, >, & by default: do not use it unmodified).', {title: '<b>Tom & Jerry</b>', description: "it's \"quoted\" & <tagged>"}],
    ['escapes-required', 'Quote and backslash are escaped; "/" is not.', {title: 'say "hi" \\ path/to/file', description: 'C:\\Users\\x and a/b'}],
    ['control-short-escapes', 'TAB, LF and CR (the only controls the server allows in service text) use the short escapes \\t \\n \\r.', {title: 'tab\there', description: 'line1\nline2\r\nline3'}],
    ['title-max-utf16', '120 UTF-16 code units (60 astral emoji = 60 code points): the server\'s length limit counts UTF-16 code units.', {title: '🙂'.repeat(60)}],
    ['padding-within-raw-limit', 'Padding is kept in the signed terms; the raw text may be up to max + 100 UTF-16 code units (title: 220).', {title: ' '.repeat(100) + 'padded' + ' '.repeat(100)}],
  ];
  for (const [n, d, s] of svc) await add(`terms/${n}`, 'terms', d, canonical(withService(s)));
  // Canonical form is defined, but the server (release v11) refuses these in service text with 400 invalid_field.
  const refused = [
    ['escapes-bs-ff', 'BS and FF would use \\b \\f; refused in service text.', {title: 'back\bspace', description: 'form\ffeed'}],
    ['escapes-u00xx', 'Other C0 controls and DEL (\\u00XX, lowercase hex; DEL literal); refused in service text.', {title: 'ctl\u0001\u001f\u007fend', description: 'nul\u0000x vt\u000by esc\u001b[31mred'}],
    ['c1-controls', 'C1 controls U+0080..U+009F (here NEL U+0085 and CSI U+009B; written literally by canonical JSON): refused since v9.', {title: 'nel\u0085x', description: 'csi\u009B31mred'}],
    ['bidi-override', 'Bidi override and pop (U+202E, U+202C); refused.', {title: 'invoice', description: 'abc\u202Edcba\u202C end'}],
    ['bidi-isolate', 'Bidi isolate (U+2066..U+2069); refused.', {title: 'a\u2066b\u2069c'}],
    ['zero-width-space-bom', 'Zero-width space (U+200B) and BOM (U+FEFF); refused.', {title: 'zero\u200Bwidth\uFEFFbom'}],
    ['word-joiner-invisible-operators', 'Word joiner U+2060 and invisible operators U+2061..U+2064: refused since v9.', {title: 'word\u2060joiner', description: 'f\u2061(x) a\u2062b a\u2063b 1\u20642'}],
    ['interlinear-annotation', 'Interlinear annotation characters U+FFF9..U+FFFB: refused since v9.', {title: '\uFFF9base\uFFFAannotation\uFFFB'}],
    ['tag-characters', 'Unicode tag characters U+E0000..U+E007F (invisible ASCII an LLM can still read; here "IGNORE"): refused since v9.', {title: 'Brief\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}'}],
    ['other-tag-flag', 'A tag sequence of the flag form (U+1F3F4, tag letters "usca", U+E007F) that is not one of the three RGI subdivision flags: still refused in v11, because such a sequence could spell hidden text.', {title: 'Brief \u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}'}],
    ['soft-hyphen', 'SOFT HYPHEN U+00AD (invisible unless the word breaks): refused since v11 (accepted in v9).', {title: 'soft\u00ADhyphen'}],
    ['hangul-fillers', 'Hangul fillers U+115F, U+1160, U+3164, U+FFA0 (they show as blank space): refused since v11.', {title: 'a\u115Fb', description: 'c\u1160d e\u3164f g\uFFA0h'}],
    ['ideographic-variation-selectors', 'Ideographic variation selectors U+E0100..U+E01EF (invisible; one per byte value can carry hidden data): refused since v11.', {title: 'ok\u{E0100}\u{E0101}\u{E0102}'}],
    ['stray-variation-selectors', 'A variation selector U+FE00..U+FE0F that does not directly follow an emoji character (after a letter, or a second one after an emoji): refused since v11.', {title: 'ok\uFE0F', description: 'heart ❤\uFE0F\uFE0F'}],
    ['variation-selector-after-digit', 'Variation selectors after digits outside a keycap (U+FE03, U+FE0A; in v11 allowed, 4 invisible bits per digit): refused since v12.', {title: 'Brief 1\uFE03 2\uFE0A'}],
    ['variation-selector-fe00-fe0d-after-emoji', 'U+FE00..U+FE0D after an emoji (only U+FE0E and U+FE0F may follow one): refused since v12.', {title: 'Brief \u{1F642}\uFE05'}],
    ['digit-vs16-without-keycap', 'U+FE0F after a digit that is not followed by U+20E3 (not a keycap): refused since v12.', {title: 'Brief 1\uFE0F done'}],
    ['invisible-format-characters', 'U+180E, U+034F, U+206A..U+206F and U+1D173..U+1D17A (invisible format characters): refused since v12.', {title: 'a\u180Eb c\u034Fd', description: 'e\u206Af g\u206Fh i\u{1D173}j k\u{1D17A}l'}],
    ['mongolian-free-variation-selectors', 'A run of Mongolian free variation selectors U+180B..U+180D, U+180F (default-ignorable): refused since v13 (accepted in v12).', {title: 'Brief\u180B\u180C\u180D\u180F\u180B\u180F'}],
    ['unassigned-default-ignorables', 'Unassigned default-ignorable code points (here U+E0080..U+E00FF): refused since v13 (accepted in v12).', {title: 'Brief\u{E0080}\u{E00A5}\u{E00FF}\u{E0081}'}],
    ['other-default-ignorables-and-format', 'Khmer inherent vowel U+17B4, shorthand format control U+1BCA0 (default-ignorable), Egyptian hieroglyph format control U+13430 (Cf): refused since v13.', {title: 'a\u17B4b c\u{1BCA0}d', description: 'e\u{13430}f'}],
    ['arabic-prepended-concatenation-mark', 'U+0600 ARABIC NUMBER SIGN (category Cf, a visible mark that spans the digits after it): refused since v13, a deliberate trade-off of the property rule (OPEN-QUESTIONS OQ-33).', {title: 'Number \u0600\u0661\u0662\u0663'}],
    ['runs-of-single-marks', 'Two of ZWNJ, ZWJ, LRM, RLM, ALM in a row: refused since v13 (each is allowed only singly).', {title: 'a\u200D\u200Cb', description: 'c\u200E\u200Fd'}],
    ['keycap-with-fe0e', 'A keycap with U+FE0E (# U+FE0E U+20E3): refused since v13 (keycaps need U+FE0F or no selector; accepted in v12).', {title: 'Keys #\uFE0E\u20E3'}],
    ['padding-over-raw-limit', 'A 401-character title that is 1 character after trimming: over max + 100 raw; refused.', {title: ' '.repeat(200) + 'x' + ' '.repeat(200)}],
  ];
  for (const [n, d, s] of refused) await add(`refused/${n}`, 'refused', d, canonical(withService(s)));
  // Inputs the server accepts on the wire, written in non-canonical JSON: the canonical form is what is hashed and signed.
  await add('wire/escaped-unicode-input', 'wire', 'Input uses \\u escapes and an escaped solidus; canonical output is literal UTF-8 and "/" (same hash as terms/unicode-latin).',
    canonical(withService({title: 'Résumé of café études', description: 'Ångström, naïve, façade, Øre, ß.'})).replace(/[^\x00-\x7f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).replace('"vd_', '"vd\\u005f'));
  await add('wire/solidus-escaped', 'wire', 'Input writes "/" as "\\/": parsed to "/", canonical "/" unescaped.', canonical(withService({deliverable: 'markdown/plain'})).replace('markdown/plain', 'markdown\\/plain'));
  await add('wire/number-exponent', 'wire', 'price.amount written as 2e1: parsed to 20, canonical "20". A parser that keeps it as a float must still canonicalise to 20.', canonical(T).replace('"amount":20', '"amount":2e1'));
  await add('wire/number-fraction-zero', 'wire', 'version written as 1.0: the server parses 1 and accepts it; canonical "1".', canonical(T).replace('"version":1', '"version":1.0'));
  await add('wire/duplicate-key', 'wire', 'Duplicate key: the server\'s JSON.parse keeps the LAST value (price 20). A client that shows the first value would mislead its user.', canonical(T).replace('"price":{', '"price":{"amount":999,"unit":"PC"},"price":{'));
  // Generic canonical(): values outside the terms domain. Informative: valid terms never contain these.
  const generic = [
    ['generic/empty', 'Empty object and array.', '{"a":{},"b":[]}'],
    ['generic/nested-arrays', 'Arrays keep their order; objects inside arrays are sorted.', '[3,1,{"z":1,"a":[{"y":2,"b":1}]},[]]'],
    ['generic/literals', 'true, false, null.', '{"t":true,"f":false,"n":null}'],
    ['generic/integer-like-keys', 'Keys are sorted as strings ("10" < "9" < "a"), not numerically.', '{"9":1,"10":2,"a":3,"A":4,"_":5}'],
    ['generic/negative-zero', '-0 canonicalises to 0.', '{"z":-0}'],
    ['generic/negative-int', 'Negative integer.', '{"n":-42}'],
    ['generic/max-safe-int', '2^53-1: exact.', '{"n":9007199254740991}'],
    ['generic/above-safe-int', '2^53+1: JSON.parse rounds it to 2^53 (9007199254740992). Implementations with exact integers differ.', '{"n":9007199254740993}'],
    ['generic/1e21', '10^21: ECMAScript prints "1e+21". Exact-integer implementations print 1000000000000000000000.', '{"n":1000000000000000000000}'],
    ['generic/fraction', 'A non-integer (1.5) prints as 1.5. (Terms contain only integers.)', '{"n":1.5}'],
    ['generic/non-ascii-key-order', 'Keys are sorted by UTF-16 code units (ECMAScript sort): U+1F600 (D83D DE00) sorts before U+FF01. Code-point order puts U+FF01 first.', '{"\\uff01":1,"\\ud83d\\ude00":2,"\\u00e9":3,"e":4}'],
    ['generic/lone-surrogate', 'A lone surrogate is written as the escape \\ud800 (well-formed JSON.stringify). Not encodable as UTF-8 otherwise.', '{"s":"a\\ud800b"}'],
  ];
  for (const [n, d, j] of generic) await add(n, 'generic', d, j);
  return out;
}

// =====================================================================================================================
// statements.json
// =====================================================================================================================
async function statementVectors() {
  const out = [];
  const T = baseTerms(), h = termsHash(T), T2 = {...T, version: 2, prior_terms_hash: h, nonce: 'ffeeddccbbaa99887766554433221100', proposer: BOB_ID, price: {amount: 25, unit: 'PC'}}, h2 = termsHash(T2);
  const push = (name, tier, kind, signer, inputs, statement, extra = {}) => {
    const v = {name, tier, kind, inputs, statement, statement_utf8_hex: utf8hex(statement), signer: signer.name, pubkey: signer.pub, signature: signText(signer, statement), ...extra};
    assert.ok(schnorrVerify(hx(v.signature), Buffer.from(statement, 'utf8'), hx(signer.pub)));
    out.push(v);
  };
  const enrollCode = 'vpe_TESTONLYfixture01';
  push('enroll/basic', 'core', 'enroll', K.alice, {network: NETWORK, participant_id: ALICE_ID, pubkey: K.alice.pub, enrollment_code: enrollCode, enrollment_code_sha256: sha256(enrollCode)},
    statements.enroll(ALICE_ID, K.alice.pub, sha256(enrollCode)));
  push('enroll/other-participant', 'core', 'enroll', K.bob, {network: NETWORK, participant_id: BOB_ID, pubkey: K.bob.pub, enrollment_code: 'vpe_TESTONLYfixture02', enrollment_code_sha256: sha256('vpe_TESTONLYfixture02')},
    statements.enroll(BOB_ID, K.bob.pub, sha256('vpe_TESTONLYfixture02')));
  push('propose/v1', 'core', 'propose', K.alice, {terms_hash: h, terms_name: 'canonical.json terms/base'}, statements.propose(h));
  push('propose/counter-v2', 'core', 'propose', K.bob, {terms_hash: h2, terms_name: 'canonical.json terms/counter-v2'}, statements.propose(h2), {note: 'A counter-offer signs the same "propose" statement over the new version\'s terms_hash.'});
  push('accept/v1', 'core', 'accept', K.bob, {terms_hash: h}, statements.accept(h));
  push('withdraw/v1', 'core', 'withdraw', K.alice, {terms_hash: h}, statements.withdraw(h));
  const contents = [['ascii', '# Brief\nThree sources...'], ['unicode', 'Résumé — 東京 🙂\n'], ['crlf-and-trailing-space', 'line one\r\nline two  \r\n'],
    ['leading-whitespace', '   indented first line\n'], ['tab-and-controls', 'a\tb\u0007c'], ['empty-title-unicode-only', '🙂']];
  for (const [n, c] of contents) push(`deliver/${n}`, 'core', 'deliver', K.bob, {terms_hash: h, content: c, deliverable_sha256: sha256(c)}, statements.deliver(h, sha256(c)),
    {note: 'deliverable_sha256 = sha256 of the content\'s UTF-8 bytes, exactly as sent (the server does not trim or clean delivery content).'});
  push('deliver/lone-surrogate', 'edge', 'deliver', K.bob, {terms_hash: h, content: 'a\ud800b', deliverable_sha256: sha256('a\ud800b')}, statements.deliver(h, sha256('a\ud800b')),
    {note: 'Node hashes a lone surrogate as U+FFFD (EF BF BD). Content should never contain one; strict UTF-8 encoders refuse it.'});
  const dh = sha256(contents[0][1]);
  push('complete/v1', 'core', 'complete', K.alice, {terms_hash: h, deliverable_sha256: dh}, statements.complete(h, dh));

  // decline / dispute (since release v8, e0b990a): the server verifies the signature over sha256(the reason EXACTLY as
  // received) and, as an alternative for older clients, over sha256(clean(reason)); it stores the cleaned text as
  // `reason`, plus `reason_as_signed` when they differ. Since release v9 (ed1da4a) a reason that is not a string (null and
  // absent count as ""), or that contains a refused character (the same set as service text; widened in v11), is refused
  // with 400 invalid_field before any signature is checked. Each case runs through the real Pilot.decline()/dispute():
  //   1. with a signature that has the right shape but cannot verify (DRY_SIG): a reason v11 refuses MUST give
  //      400 invalid_field without the signer being asked; any other reason gives 403 bad_signature, and the stand-in
  //      verifier records every statement the server would accept, in the order it tries them (nothing is recorded);
  //   2. with a test-key signature over the first (as-sent) form: MUST be accepted;
  //   3. when the cleaned form differs, with a signature over it: MUST be accepted too.
  const reasons = [
    // [name, reason, expected v11 outcome as two letters: decline, dispute. A = accepted (signature checked), R = refused
    // with 400 invalid_field before any signature is checked]
    ['empty', '', 'AR'], ['plain', 'Too expensive for me.', 'AA'], ['padded', '  padded both sides  ', 'AA'], ['trailing-newline', 'Not this week, sorry.\n', 'AA'],
    ['internal-newline', 'line one\nline two', 'AA'], ['crlf-trailing', 'reason\r\n', 'AA'], ['tab-inside', 'tab\tinside', 'AA'],
    // refused since v9 (OQ-32/33): C0 controls other than TAB/LF/CR, DEL, C1 controls, BOM, bidi controls, invisible characters
    ['bell-inside', 'bell\u0007inside', 'RR'], ['vertical-tab', 'vertical\u000btab', 'RR'], ['nul-inside', 'nul\u0000char', 'RR'], ['del-inside', 'del\u007fchar', 'RR'],
    ['escape-sequence', '\u001b[31mred\u001b[0m', 'RR'], ['only-controls', '\u0001\u0002', 'RR'], ['nel-leading', '\u0085NEL first', 'RR'], ['nel-trailing', 'NEL last\u0085', 'RR'],
    ['c1-csi', 'csi\u009B31mred', 'RR'], ['bom-leading', '\uFEFFBOM first', 'RR'], ['bidi-inside', 'abc\u202Edcba', 'RR'], ['bidi-isolate', 'a\u2066b\u2069c', 'RR'],
    ['zero-width-inside', 'zero\u200Bwidth', 'RR'], ['word-joiner', 'word\u2060joiner', 'RR'], ['invisible-operators', 'f\u2061(x) a\u2062b', 'RR'],
    ['interlinear-annotation', '\uFFF9base\uFFFAannotation\uFFFB', 'RR'], ['tag-characters', 'No\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}', 'RR'],
    // refused since v11 (OQ-33 residual): soft hyphen, Hangul fillers, ideographic and stray variation selectors, and tag
    // sequences other than the three RGI subdivision flags
    ['soft-hyphen', 'soft\u00ADhyphen', 'RR'], ['hangul-filler', 'x\u3164y', 'RR'], ['variation-selectors', 'ok\u{E0100}\u{E0101}\u{E0102}\uFE0F', 'RR'],
    ['stray-variation-selector', 'ok\uFE0F', 'RR'], ['other-tag-flag', 'Not in \u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}', 'RR'],
    // allowed: whitespace that trim() removes, ZWJ/ZWNJ, LRM/RLM/ALM (v9); RGI subdivision flags, emoji presentation (v11)
    ['nbsp-around', '\u00A0nbsp around\u00A0', 'AA'], ['line-separators-around', '\u2028sep around\u2029', 'AA'], ['ideographic-space', '\u3000wide space\u3000', 'AA'],
    ['zwj-emoji', 'Booked up \u{1F469}\u200D\u{1F4BB} until December', 'AA'], ['zwnj-persian', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', 'AA'],
    ['lrm-rlm-alm', 'price\u200E 20 \u200FPC \u061C.', 'AA'],
    ['subdivision-flag', 'Not in \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'AA'], ['emoji-presentation', 'Love it \u2764\uFE0F but busy', 'AA'],
    ['variation-selector-after-digit', 'Busy until 1\uFE03 2\uFE0A', 'RR'], ['invisible-format', 'not\u180Enow', 'RR'],
    ['keycap', 'Press 1\uFE0F\u20E3 to confirm', 'AA'], ['mongolian-free-variation-selectors', 'Busy\u180B\u180C\u180F', 'RR'],
    ['run-of-joiners', 'no\u200D\u200Cthanks', 'RR'], ['arabic-number-sign', '\u0600\u0661\u0662', 'RR'],
    ['single-marks-between-letters', 'No th\u200Danks f\u200Cor n\u200Eo\u061Cw', 'AA'],
    ['unicode', 'café, 東京, \u{1F642}', 'AA'], ['nfd', 'cafe\u0301', 'AA'],
    // lengths (UTF-16 code units): decline raw <= 600 and cleaned <= 500; dispute raw <= 1100 and cleaned <= 1000
    ['max-500', 'x'.repeat(500), 'AA'], ['over-500', 'x'.repeat(501), 'RA'], ['padded-raw-550', 'x'.repeat(500) + ' '.repeat(50), 'AA'], ['raw-over-600', ' '.repeat(101) + 'x'.repeat(500), 'RA'],
    ['max-1000', 'y'.repeat(1000), 'RA'], ['over-1000', 'y'.repeat(1001), 'RR'], ['padded-raw-1050', 'y'.repeat(1000) + ' '.repeat(50), 'RA'], ['raw-over-1100', ' '.repeat(101) + 'y'.repeat(1000), 'RR'],
    // not text: refused since v9 (OQ-32); a lone surrogate is still accepted (OQ-3)
    ['non-string', 42, 'RR'], ['non-string-array', ['x'], 'RR'], ['lone-surrogate', 'bad\ud800', 'AA'],
  ];
  const setup = (pr, kind, rn) => {
    const id = 'vd_' + sha256(`statement-probe/${kind}/${rn}`).slice(0, 16);
    const t = baseTerms({deal_id: id, proposer: ALICE_ID}), th = termsHash(t);
    const d = pr.state.deals[id] = {id, payer: ALICE_ID, payee: BOB_ID, created_at: iso(T0), status: 'open', history: [],
      versions: [{v: 1, by: ALICE_ID, terms: t, terms_hash: th, signature: '00'.repeat(65), created_at: iso(T0), state: 'open', offered_at: iso(T0)}]};
    if (kind === 'decline') return {id, th};
    d.versions[0].state = 'accepted'; d.status = 'delivered';
    d.agreement = {version: 1, terms: t, terms_hash: th, proposer: ALICE_ID, acceptor: BOB_ID, formed_at: iso(T0)};
    d.delivery = {by: BOB_ID, title: '', content: 'the work', sha256: sha256('the work'), bytes: 8, signature: '00'.repeat(65), at: iso(T0), late: false};
    return {id, th, dh: d.delivery.sha256};
  };
  for (const kind of ['decline', 'dispute']) for (const [rn, raw, expected] of reasons) {
    const signer = kind === 'decline' ? K.bob : K.alice;   // bob declines alice's offer; alice (payer) disputes bob's delivery
    const act = (pr, sig) => {
      const {id, th, dh} = setup(pr, kind, rn);
      return kind === 'decline' ? pr.pilot.decline(pr.bob, id, {terms_hash: th, signature: sig, reason: raw})
        : pr.pilot.dispute(pr.alice, id, {terms_hash: th, deliverable_sha256: dh, signature: sig, reason: raw});
    };
    const pr1 = probePilot({verify: 'reject'}), {id, th, dh} = setup(probePilot(), kind, rn);
    const res1 = await outcome(() => act(pr1, DRY_SIG));
    const inputs = {terms_hash: th, ...(dh ? {deliverable_sha256: dh} : {}), reason: raw};
    const tier = /surrogate/.test(rn) ? 'edge' : 'core';
    if (expected[kind === 'decline' ? 0 : 1] === 'R') {
      // Refused with 400 invalid_field before any signature is checked (the signer is never asked); since v9, set widened in v11.
      assert.equal(res1.error, 'invalid_field', `${kind}/${rn}: v11 refuses this reason (${JSON.stringify(res1)})`);
      assert.equal(res1.status, 400);
      assert.equal(pr1.log.length, 0, `${kind}/${rn}: refused before the signer runs`);
      out.push({name: `${kind}/${rn}`, tier: 'refused', kind, inputs, server_outcome: res1,
        note: 'Refused by the real Pilot.' + kind + '() with 400 invalid_field before any signature is checked; a client must not send it.'});
      continue;
    }
    assert.equal(res1.error, 'bad_signature', `${kind}/${rn}: v11 accepts this reason; only the dry-run signature is refused (${JSON.stringify(res1)})`);
    const forms = [...new Set(pr1.log.map(e => Buffer.from(e.message_hex, 'hex').toString('utf8')))];
    assert.equal(typeof raw, 'string');
    const sent = raw, cleaned = cleanText(sent);
    const stmtOf = r => kind === 'decline' ? statements.decline(th, r) : statements.dispute(th, dh, r);
    assert.deepEqual(forms, [...new Set([stmtOf(sent), stmtOf(cleaned)])], `${kind}/${rn}: statement forms the server tries`);
    const sigSent = signText(signer, forms[0]), pr2 = probePilot();
    assert.equal(await outcome(() => act(pr2, sigSent)), 'accepted', `${kind}/${rn}: signature over the reason as sent`);
    const stored = pr2.state.deals[id][kind];
    assert.equal(stored.reason, cleaned, `cleanText replica vs core ${kind}() stored reason, ${rn}`);
    assert.equal(stored.reason_as_signed, sent !== cleaned ? sent : undefined);
    const alternatives = [];
    if (forms[1]) {
      const sigClean = signText(signer, forms[1]);
      assert.equal(await outcome(() => act(probePilot(), sigClean)), 'accepted', `${kind}/${rn}: signature over the cleaned reason`);
      alternatives.push({form: 'cleaned', statement: forms[1], statement_utf8_hex: utf8hex(forms[1]), signature: sigClean});
    }
    out.push({name: `${kind}/${rn}`, tier, kind, inputs: {...inputs, reason_sha256: sha256(sent), reason_cleaned: cleaned, reason_cleaned_sha256: sha256(cleaned)},
      statement: forms[0], statement_utf8_hex: utf8hex(forms[0]), signer: signer.name, pubkey: signer.pub, signature: sigSent, accepted_alternatives: alternatives,
      server_outcome: 'accepted', stored: {reason: stored.reason, ...(stored.reason_as_signed !== undefined ? {reason_as_signed: stored.reason_as_signed} : {})},
      note: `Real Pilot.${kind}(): signature over sha256(reason as sent) accepted${forms[1] ? '; over sha256(cleaned reason) accepted too' : ''}. Stored reason is the cleaned text.`});
  }
  // Negative signatures: common mistakes. Each must NOT verify against the true statement bytes.
  const stmt = statements.accept(h), sb = Buffer.from(stmt, 'utf8');
  const negatives = [
    ['signed-hex-text', 'signed the ASCII hex encoding of the statement instead of its bytes', schnorrSign(Buffer.from(sb.toString('hex'), 'utf8'), K.bob.sk)],
    ['signed-sha256', 'signed sha256(statement) instead of the statement bytes', schnorrSign(crypto.createHash('sha256').update(sb).digest(), K.bob.sk)],
    ['signed-trailing-newline', 'signed the statement with a trailing "\\n"', schnorrSign(Buffer.from(stmt + '\n', 'utf8'), K.bob.sk)],
    ['signed-crlf', 'signed the statement with CRLF line breaks', schnorrSign(Buffer.from(stmt.replace(/\n/g, '\r\n'), 'utf8'), K.bob.sk)],
    ['signed-uppercase-hash', 'signed the statement with the terms_hash in upper case', schnorrSign(Buffer.from(statements.accept(h.toUpperCase()), 'utf8'), K.bob.sk)],
    ['wrong-key', 'valid signature by alice, checked against bob\'s key', schnorrSign(sb, K.alice.sk)],
    ['wrong-kind', 'bob signed the propose statement for the same hash, presented as an acceptance', schnorrSign(Buffer.from(statements.propose(h), 'utf8'), K.bob.sk)],
  ];
  const negativeVectors = negatives.map(([name, why, sig]) => {
    assert.equal(schnorrVerify(sig, sb, hx(K.bob.pub)), false);
    return {name: `negative/${name}`, tier: 'core', kind: 'accept', statement: stmt, statement_utf8_hex: sb.toString('hex'), pubkey: K.bob.pub, signature: sig.toString('hex'), valid: false, why};
  });
  return {vectors: out, negative_signatures: negativeVectors};
}

// =====================================================================================================================
// basis-notes.json and basis-signatures.json
// =====================================================================================================================
function noteVectors() {
  const out = [];
  const add = (name, tier, issuer, recipient, total, timestamp, nft, denomination, description, {signer = null} = {}) => {
    const m = noteMessage(hx(issuer), hx(recipient), total, timestamp, hx(nft), denomination);
    const v = {name, tier, description, issuer_pubkey: issuer, recipient_pubkey: recipient, total: String(total), timestamp: String(timestamp), tracker_nft_id: nft, denomination,
      server_representable: BigInt(total) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(timestamp) <= BigInt(Number.MAX_SAFE_INTEGER),
      debt_key_hex: debtKey(hx(issuer), hx(recipient), denomination).toString('hex'), message_hex: m.toString('hex')};
    assert.equal(m.length, 80);
    if (signer) { v.signer = signer.name; v.signature = schnorrSign(m, signer.sk).toString('hex'); }
    out.push(v);
  };
  for (const [name, issuer, total, ts, msg] of OFFICIAL.filter(o => ['TV001', 'TV003', 'TV009', 'TV010', 'TV011'].includes(o[0]))) {
    add(`basis-official/${name}`, 'core', issuer, TV_BOB, total, ts, TV_NFT, 'erg', `Basis official vector ${name} (denomination erg): the message must equal Basis's published bytes.`);
    assert.equal(out.at(-1).message_hex, msg);
  }
  const A = K.alice.pub, B = K.bob.pub;
  add('pilot/first-note', 'core', A, B, 20, T0 - 1500, FIXTURE_NFT, PILOT_DENOMINATION, 'Pilot PC note: alice owes bob a cumulative 20 PC (first note for the pair). Denomination token:<PILOT_TOKEN_ID>.', {signer: K.alice});
  add('pilot/cumulative', 'core', A, B, 45, T0 + 60e3, FIXTURE_NFT, PILOT_DENOMINATION, 'Second deal of 25 PC for the same key pair: the note carries the running total 45, not 25.', {signer: K.alice});
  add('pilot/reverse-pair', 'core', B, A, 7, T0, FIXTURE_NFT, PILOT_DENOMINATION, 'bob owes alice: issuer and recipient swapped give a different debt key.', {signer: K.bob});
  add('pilot/official-keys-token', 'core', TV_ALICE, TV_BOB, '1000000000', '1743379200000', TV_NFT, PILOT_DENOMINATION, 'TV001 inputs, but with the pilot token denomination: debt key = blake2b256(issuer||recipient||token_id) (differs from TV001).');
  add('pilot/total-zero', 'edge', A, B, 0, 0, FIXTURE_NFT, PILOT_DENOMINATION, 'Zero total and timestamp (never produced by the pilot: a note always adds a price >= 1).');
  add('pilot/max-safe', 'edge', A, B, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, FIXTURE_NFT, PILOT_DENOMINATION, '2^53-1: the largest total/timestamp the JS server can represent exactly.');
  add('pilot/u64-max', 'edge', A, B, '18446744073709551615', '18446744073709551615', FIXTURE_NFT, PILOT_DENOMINATION, '2^64-1: valid for Basis (u64) but not representable by the JS server (server_representable: false).');
  add('pilot/erg-same-pair', 'core', A, B, 20, T0 - 1500, FIXTURE_NFT, 'erg', 'Same pair and amounts as pilot/first-note but denomination erg: a different message. A pilot note signed this way does not verify.');
  // negative: the erg-denomination signature presented for the token-denomination message
  const tokenMsg = hx(out.find(v => v.name === 'pilot/first-note').message_hex), ergSig = schnorrSign(hx(out.at(-1).message_hex), K.alice.sk);
  assert.equal(schnorrVerify(ergSig, tokenMsg, hx(A)), false);
  const negatives = [{name: 'negative/erg-signature-for-token-note', message_hex: tokenMsg.toString('hex'), pubkey: A, signature: ergSig.toString('hex'), valid: false,
    why: 'signed the erg-denomination message; the pilot verifies the token-denomination message'}];
  return {vectors: out, negative_signatures: negatives};
}
function signatureVectors() {
  return OFFICIAL.map(([name, issuer, total, ts, msg, sig, ok]) => ({name: `basis-official/${name}`, tier: 'core', pubkey: issuer, message_hex: msg, signature: sig, valid: ok,
    source: 'Basis cross-validation vectors (basis-tracker specs/SCHNORR_SIGNATURE_SPEC.md at 3df7ed93, CC0-1.0), as copied in hermes-plugin-valun/tests/test_valun_basis.py'}));
}

// =====================================================================================================================
// terms-validation.json: what the real validateTerms() accepts and refuses (server-only behaviour)
// =====================================================================================================================
async function validationVectors() {
  const probe = probePilot(), out = [];
  const T = baseTerms();
  const cases = [
    ['ok/base', T, 'alice'],
    ['ok/payee-proposes', {...T, proposer: BOB_ID}, 'bob'],
    ['bad/deliver-by-before-offer-expiry', baseTerms({deliver_by: isoSec(T0 + 1 * H), offer_expires_at: isoSec(T0 + 7 * 24 * H)}), 'alice',
      'Refused since release v8 (e0b990a): deliver_by must not be earlier than offer_expires_at.'],
    ['ok/deliver-by-equals-offer-expiry', baseTerms({deliver_by: isoSec(T0 + 24 * H), offer_expires_at: isoSec(T0 + 24 * H)}), 'alice', 'deliver_by == offer_expires_at is allowed (>=).'],
    ['ok/date-only-strings', baseTerms({deliver_by: '2026-11-08', offer_expires_at: '2026-11-07'}), 'alice', 'Accepted: the server parses dates with Date.parse(), so date-only strings pass; they are hashed as written.'],
    ['ok/rfc2822-date', baseTerms({offer_expires_at: 'Sat, 07 Nov 2026 06:00:00 GMT'}), 'alice', 'Accepted by Date.parse(); the Python client cannot parse it (it refuses to sign).'],
    ['ok/offset-date', baseTerms({offer_expires_at: '2026-11-07T20:00:00+08:00'}), 'alice', 'Accepted: a UTC offset other than Z.'],
    ['ok/tab-newline-cr-in-text', withService({title: 'tab\there', description: 'line1\nline2\r\nline3'}), 'alice', 'TAB, LF and CR are the only controls allowed in service text.'],
    ['bad/controls-in-title', withService({title: 'ok\u0007\u001b[31m'}), 'alice', 'Refused since v8: C0 controls (other than TAB/LF/CR) and DEL in service text.'],
    ['bad/del-in-deliverable', withService({deliverable: 'del\u007f'}), 'alice', 'DEL (U+007F) is refused.'],
    ['bad/bidi-override-in-description', withService({description: 'abc\u202Edcba'}), 'alice', 'Bidi overrides U+202A..U+202E are refused.'],
    ['bad/bidi-isolate-in-title', withService({title: 'a\u2067b\u2069'}), 'alice', 'Bidi isolates U+2066..U+2069 are refused.'],
    ['bad/zero-width-space', withService({title: 'zero\u200Bwidth'}), 'alice', 'Zero-width space U+200B is refused (since v9 the only refused character of U+200B..U+200F).'],
    ['ok/zwj-emoji', withService({title: 'by \u{1F469}\u200D\u{1F4BB}'}), 'alice', 'Valid since v9 (refused in v8): emoji ZWJ sequences (U+200D).'],
    ['ok/zwnj-persian', withService({title: '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'}), 'alice', 'Valid since v9 (refused in v8): Persian with ZERO WIDTH NON-JOINER U+200C.'],
    ['ok/lrm-rlm', withService({title: 'price\u200E 20 \u200FPC'}), 'alice', 'Valid since v9 (refused in v8): LEFT-TO-RIGHT MARK U+200E and RIGHT-TO-LEFT MARK U+200F.'],
    ['bad/bom', withService({title: '\uFEFFtitle'}), 'alice', 'BOM U+FEFF is refused.'],
    ['bad/c1-nel', withService({title: 'nel\u0085x'}), 'alice', 'Refused since v9 (accepted in v8): C1 controls U+0080..U+009F, here U+0085.'],
    ['bad/c1-csi', withService({description: 'csi\u009B31mred'}), 'alice', 'Refused since v9: C1 control U+009B (CSI, an 8-bit terminal escape introducer).'],
    ['bad/word-joiner', withService({title: 'wj\u2060x'}), 'alice', 'Refused since v9 (accepted in v8): WORD JOINER U+2060.'],
    ['bad/invisible-operators', withService({deliverable: 'f\u2061(x) a\u2062b a\u2063b 1\u20642'}), 'alice', 'Refused since v9: invisible operators U+2061..U+2064.'],
    ['bad/interlinear-annotation', withService({title: '\uFFF9base\uFFFAannotation\uFFFB'}), 'alice', 'Refused since v9: interlinear annotation U+FFF9..U+FFFB.'],
    ['bad/tag-characters', withService({title: 'tag\u{E0041}\u{E0042}x'}), 'alice', 'Refused since v9 (accepted in v8): Unicode tag characters U+E0000..U+E007F (invisible text).'],
    ['ok/subdivision-flags', withService({title: 'UK brief \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'}), 'alice',
      'Valid since v11 (refused in v9): the three RGI subdivision flags England, Scotland, Wales (U+1F3F4, tag letters, U+E007F); their tag characters are allowed only in exactly these sequences.'],
    ['bad/other-tag-flag', withService({title: 'Brief \u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}'}), 'alice',
      'Refused (v11): a flag-shaped tag sequence that is not one of the three RGI subdivision flags (here "usca"); such sequences could spell hidden text.'],
    ['ok/arabic-letter-mark', withService({title: 'alm\u061Cx'}), 'alice', 'Not refused: ARABIC LETTER MARK U+061C (allowed on purpose, like LRM and RLM).'],
    ['bad/soft-hyphen', withService({title: 'shy\u00ADx'}), 'alice', 'Refused since v11 (accepted in v9): SOFT HYPHEN U+00AD.'],
    ...[[0x115F, 'HANGUL CHOSEONG FILLER'], [0x1160, 'HANGUL JUNGSEONG FILLER'], [0x3164, 'HANGUL FILLER'], [0xFFA0, 'HALFWIDTH HANGUL FILLER']].map(([cp, nm]) =>
      [`bad/hangul-filler-${cp.toString(16)}`, withService({title: `x${String.fromCodePoint(cp)}y`}), 'alice', `Refused since v11 (accepted in v9): ${nm} U+${cp.toString(16).toUpperCase()}, which shows as blank space.`]),
    ['bad/ideographic-variation-selectors', withService({title: 'ok\u{E0100}\u{E0101}\u{E0102}'}), 'alice', 'Refused since v11 (accepted in v9): ideographic variation selectors U+E0100..U+E01EF.'],
    ['bad/stray-variation-selector', withService({title: 'ok\uFE0F'}), 'alice', 'Refused since v11 (accepted in v9): a variation selector after a letter, which is not an emoji character.'],
    ['bad/repeated-variation-selector', withService({title: 'heart \u2764\uFE0F\uFE0F'}), 'alice', 'Refused since v11: a second variation selector after an emoji (it follows U+FE0F, not an emoji character).'],
    ['ok/emoji-presentation', withService({title: 'Thanks \u2764\uFE0F \u{1F44D}\u{1F3FD} 1\uFE0F\u20E3'}), 'alice', 'Not refused: U+FE0F directly after an emoji, a skin-tone modifier, a keycap sequence.'],
    ['bad/variation-selector-after-digit', withService({title: 'Brief 1\uFE03 2\uFE0A'}), 'alice',
      'Refused since v12 (accepted in v11, as ok/variation-selector-after-digit): a variation selector after a digit outside a keycap, and U+FE00..U+FE0D anywhere.'],
    ['bad/variation-selector-fe05-after-emoji', withService({title: 'Brief \u{1F642}\uFE05'}), 'alice', 'Refused since v12: after an emoji only U+FE0E and U+FE0F are allowed.'],
    ['bad/digit-vs16-without-keycap', withService({title: 'Brief 1\uFE0F done'}), 'alice', 'Refused since v12: U+FE0F after a digit is allowed only inside a keycap (followed by U+20E3).'],
    ['ok/keycaps-and-text-presentation', withService({title: 'Keys 1\uFE0F\u20E3 #\uFE0F\u20E3 *\u20E3, heart \u2764\uFE0E'}), 'alice', 'Not refused (v13): keycaps with U+FE0F or no selector, and U+FE0E after an emoji. (v12 also allowed U+FE0E in a keycap: bad/keycap-with-fe0e.)'],
    ['bad/keycap-with-fe0e', withService({title: 'Keys #\uFE0E\u20E3'}), 'alice', 'Refused since v13 (accepted in v12): a keycap needs U+FE0F (or no selector).'],
    ...[[0x180E, 'MONGOLIAN VOWEL SEPARATOR'], [0x034F, 'COMBINING GRAPHEME JOINER'], [0x206A, 'INHIBIT SYMMETRIC SWAPPING'], [0x206F, 'NOMINAL DIGIT SHAPES'],
      [0x1D173, 'MUSICAL SYMBOL BEGIN BEAM'], [0x1D17A, 'MUSICAL SYMBOL END PHRASE']].map(([cp, nm]) =>
      [`bad/invisible-format-${cp.toString(16)}`, withService({title: `x${String.fromCodePoint(cp)}y`}), 'alice', `Refused since v12 (accepted in v11): ${nm} U+${cp.toString(16).toUpperCase()}.`]),
    ['bad/mongolian-free-variation-selectors', withService({title: 'Brief\u180B\u180C\u180D\u180F\u180B\u180F'}), 'alice',
      'Refused since v13 (accepted in v12 as ok/mongolian-free-variation-selectors): Mongolian free variation selectors are default-ignorable.'],
    ['bad/unassigned-default-ignorables', withService({title: 'Brief\u{E0080}\u{E00A5}\u{E00FF}\u{E0081}'}), 'alice',
      'Refused since v13 (accepted in v12 as ok/unassigned-default-ignorables): unassigned default-ignorable code points.'],
    ...[[0x17B4, 'KHMER VOWEL INHERENT AQ (default-ignorable)'], [0x1BCA0, 'SHORTHAND FORMAT LETTER OVERLAP (Cf, default-ignorable)'], [0x13430, 'EGYPTIAN HIEROGLYPH VERTICAL JOINER (Cf)'],
      [0x0600, 'ARABIC NUMBER SIGN (Cf; a visible prepended concatenation mark: a deliberate trade-off of the property rule)']].map(([cp, nm]) =>
      [`bad/format-or-ignorable-${cp.toString(16)}`, withService({title: `x${String.fromCodePoint(cp)}\u0661y`}), 'alice', `Refused since v13 (accepted in v12): ${nm} U+${cp.toString(16).toUpperCase()}.`]),
    ['bad/run-of-joiners', withService({title: 'a\u200D\u200Cb'}), 'alice', 'Refused since v13: ZWNJ, ZWJ, LRM, RLM and ALM are allowed only singly, never two in a row.'],
    ['bad/run-of-direction-marks', withService({title: 'a\u200E\u200Fb'}), 'alice', 'Refused since v13: two direction marks in a row.'],
    ['ok/single-marks-between-letters', withService({title: 'Th\u200Danks f\u200Cor th\u200Ee br\u200Fief\u061C'}), 'alice',
      'Not refused (v13): single ZWNJ, ZWJ, LRM, RLM, ALM between Latin letters, where they change nothing visible: one invisible choice of six per character (OPEN-QUESTIONS OQ-33).'],
    ['ok/blank-looking-characters', withService({title: 'Brief\u2800\u2800 x\u{1D159}y'}), 'alice',
      'Not refused (v13): U+2800 BRAILLE PATTERN BLANK and U+1D159 MUSICAL SYMBOL NULL NOTEHEAD (category So) render as blank space (OPEN-QUESTIONS OQ-33).'],
    ['ok/private-use', withService({title: 'Brief \uE000\uF8FF'}), 'alice', 'Not refused (v13): private-use characters (category Co); how they render depends on the fonts (OPEN-QUESTIONS OQ-33).'],
    ['ok/title-120-utf16', withService({title: '🙂'.repeat(60)}), 'alice', '60 astral characters = 120 UTF-16 code units: at the limit.'],
    ['bad/title-122-utf16', withService({title: '🙂'.repeat(61)}), 'alice', '61 astral characters = 122 UTF-16 code units > 120 (only 61 code points).'],
    ['ok/title-padded-to-raw-limit', withService({title: ' '.repeat(110) + 'x' + ' '.repeat(109)}), 'alice', 'Raw length 220 = 120 + 100: at the raw limit; the padding is hashed and stored.'],
    ['bad/title-padded-over-raw-limit', withService({title: ' '.repeat(110) + 'x' + ' '.repeat(110)}), 'alice', 'Raw length 221 > 120 + 100: refused since v8 even though the trimmed text is 1 character.'],
    ['bad/title-only-spaces', withService({title: '   '}), 'alice', 'Required field that is empty after trimming.'],
    ['bad/unknown-field', {...T, memo: 'x'}, 'alice'],
    ['bad/missing-prior-terms-hash', (({prior_terms_hash, ...r}) => r)(T), 'alice', 'validateTerms() passes; propose() then refuses ("a new deal starts at version 1 with prior_terms_hash null").', 'propose'],
    ['bad/protocol', {...T, protocol: 'valun-deal/2'}, 'alice'],
    ['bad/network', {...T, network: 'valun-pilot-2'}, 'alice'],
    ['bad/tracker', {...T, tracker_nft_id: '00'.repeat(32)}, 'alice'],
    ['bad/denomination', {...T, denomination: 'erg'}, 'alice'],
    ['bad/deal-id-uppercase', {...T, deal_id: 'vd_0123456789ABCDEF'}, 'alice'],
    ['bad/version-0', {...T, version: 0}, 'alice'],
    ['bad/version-51', {...T, version: 51}, 'alice'],
    ['bad/version-string', {...T, version: '1'}, 'alice'],
    ['bad/nonce-short', {...T, nonce: 'abc'}, 'alice'],
    ['bad/proposer-not-caller', T, 'bob'],
    ['bad/payer-extra-field', {...T, payer: {...T.payer, handle: 'alice'}}, 'alice'],
    ['bad/payee-wrong-key', {...T, payee: {id: BOB_ID, pubkey: K.carol.pub}}, 'alice'],
    ['bad/payer-equals-payee', {...T, payee: {...T.payer}}, 'alice'],
    ['bad/service-missing-field', {...T, service: {title: 'x', description: 'y'}}, 'alice'],
    ['bad/price-zero', baseTerms({price: {amount: 0, unit: 'PC'}}), 'alice'],
    ['bad/price-1001', baseTerms({price: {amount: 1001, unit: 'PC'}}), 'alice'],
    ['bad/price-fraction', baseTerms({price: {amount: 1.5, unit: 'PC'}}), 'alice'],
    ['bad/price-unit', baseTerms({price: {amount: 20, unit: 'pc'}}), 'alice'],
    ['bad/consideration', {...T, consideration: 'credit_note_on_acceptance'}, 'alice'],
    ['bad/offer-expired', baseTerms({offer_expires_at: isoSec(T0 - 1000)}), 'alice'],
    ['bad/offer-over-7-days', baseTerms({offer_expires_at: isoSec(T0 + 7 * 24 * H + 1000)}), 'alice'],
    ['bad/deliver-by-over-30-days', baseTerms({deliver_by: isoSec(T0 + 30 * 24 * H + 1000)}), 'alice'],
    ['bad/deliver-by-unparseable', baseTerms({deliver_by: 'next tuesday'}), 'alice'],
  ];
  for (const [name, terms, by, note, via] of cases) {
    const proposer = by === 'bob' ? probe.bob : probe.alice;
    const res = await outcome(async () => {
      probe.pilot.validateTerms(terms, proposer);
      if (via === 'propose') await probe.pilot.propose(proposer, {terms, signature: signText(K[by], statements.propose(termsHash(terms)))});
    });
    if (name.startsWith('ok/')) assert.equal(res, 'accepted', name); else assert.notEqual(res, 'accepted', name);
    out.push({name, tier: 'server', terms, proposer: proposer.id, terms_hash: termsHash(terms), server_outcome: res, ...(note ? {note} : {}), fixture_now: iso(T0)});
  }
  return out;
}

// =====================================================================================================================
// transcript.json: a whole pilot run through the real HTTP route table (createPilotRoutes) and the real Pilot class.
// =====================================================================================================================
async function transcriptVectors() {
  let now = T0;
  const tick = (s = 60) => { now += s * 1000; };
  // In-memory stand-in for the Basis tracker (no network). Verifies notes with the replica, keeps one note per key pair.
  // signer.mode emulates the signer runner (lib/basis.mjs:23-47): 'ok' answers with the replica; 'outage' throws the
  // runner's BasisError('signer timed out', code signer_unavailable) (a timeout, failed start or no output); 'refuses'
  // throws BasisError('signer: invalid signature encoding', code signer_error) (the helper ran and reported an error,
  // valun_signer.rs:82). tracker.mode 'down' makes note reads throw BasisError(code tracker_unavailable), as the tracker
  // client does when the tracker cannot be reached (lib/basis.mjs, Basis.api).
  const notes = new Map(), verifyLog = [], signer = {mode: 'ok'}, tracker = {mode: 'ok'};
  const signerFault = () => {
    if (signer.mode === 'outage') throw new BasisError('signer timed out', {code: 'signer_unavailable'});
    if (signer.mode === 'refuses') throw new BasisError('signer: invalid signature encoding', {code: 'signer_error'});
  };
  const trackerFault = () => { if (tracker.mode === 'down') throw new BasisError('tracker unreachable: ECONNREFUSED', {code: 'tracker_unavailable'}); };
  const basis = {nft: FIXTURE_NFT, denomination: PILOT_DENOMINATION, url: 'memory://stand-in-tracker',
    async verify(pubkey, messageHex, sig) {
      if (signer.mode === 'refuses') verifyLog.push({pubkey, message_hex: messageHex, signature: sig, valid: false, signer_refused: true});
      signerFault();
      const valid = schnorrVerify(hx(sig), hx(messageHex), hx(pubkey)); verifyLog.push({pubkey, message_hex: messageHex, signature: sig, valid}); return valid;
    },
    async noteMessage({issuer, recipient, total, timestamp, denomination = PILOT_DENOMINATION}) {
      signerFault();
      return {message_hex: noteMessage(hx(issuer), hx(recipient), total, timestamp, hx(FIXTURE_NFT), denomination).toString('hex'), debt_key_hex: debtKey(hx(issuer), hx(recipient), denomination).toString('hex')};
    },
    async note(issuer, recipient) { trackerFault(); return notes.get(`${issuer}>${recipient}`) ?? null; },
    async allNotes() { trackerFault(); return [...notes.values()]; },
    async proof() { return null; },
    async api(method, p, body) {
      if (method === 'POST' && p === '/notes') {
        const prev = notes.get(`${body.issuer_pubkey}>${body.recipient_pubkey}`);
        const m = noteMessage(hx(body.issuer_pubkey), hx(body.recipient_pubkey), body.amount, body.timestamp, hx(body.tracker_nft_id), body.denomination);
        if (!schnorrVerify(hx(body.signature), m, hx(body.issuer_pubkey)) || (prev && (body.amount < prev.amount_collected || body.timestamp <= prev.timestamp)))
          return {status: 400, json: {success: false, error: 'stand-in tracker refused the note'}, text: ''};
        notes.set(`${body.issuer_pubkey}>${body.recipient_pubkey}`, {issuer_pubkey: body.issuer_pubkey, recipient_pubkey: body.recipient_pubkey, amount_collected: body.amount,
          amount_redeemed: 0, timestamp: body.timestamp, signature: body.signature, denomination: body.denomination, confirmation: {status: 'local_only'}});
        return {status: 201, json: {success: true, data: null}, text: ''};
      }
      return {status: 404, json: {success: false, error: 'not found'}, text: ''};
    }};
  const state = {version: 1, network: NETWORK, createdAt: iso(T0), participants: {}, deals: {}, approvals: {}, invites: {}};
  const pilot = new Pilot({store: {state, save() {}, audit() {}}, basis, now: () => now});
  const ADMIN = 'TEST-ONLY-admin-token';
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e9}, adminTokenHash: sha256(ADMIN)});
  const redact = new Map([[ADMIN, '<admin_token>']]);
  const tokens = {};

  async function http(method, p, {body, rawBody, auth, admin, bearer, via = routes, ip = '198.51.100.7'} = {}) {
    const raw = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body);
    const headers = {...(auth ? {authorization: `Bearer ${tokens[auth]}`} : bearer ? {authorization: `Bearer ${bearer}`} : {}), ...(admin ? {'x-valun-admin': ADMIN} : {}),
      ...(raw ? {'content-type': 'application/json'} : {})};
    const req = {method, headers, socket: {remoteAddress: admin ? '127.0.0.1' : ip}, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8'); }};
    let res = null;
    const send = (_res, status, b) => { res = {status, body: b}; };
    try { await via(req, {}, new URL('/pilot/v1' + p, 'http://valun.invalid'), send, r => r.socket.remoteAddress); }
    catch (e) {                                       // exactly as lib/http.mjs:96-108 (v11) turns errors into responses
      if (e.name === 'PilotError') res = {status: e.status, body: {error: e.code, message: e.message, ...(e.extra || {})}};
      // Since v11 BasisError has name, code and a fixed publicMessage: 503 for signer_unavailable, else 502 (OQ-35).
      else if (e.name === 'BasisError') res = {status: e.code === 'signer_unavailable' ? 503 : 502, body: {error: e.code, message: e.publicMessage}};
      else res = {status: 502, body: {error: 'internal error'}};
    }
    return {status: res.status, body: JSON.parse(JSON.stringify(res.body ?? null))};   // the wire: JSON.stringify(body, null, 1)
  }
  const steps = [];
  // Every statement form the real server would accept for this request body, in the order it tries them: the same
  // request is sent first with a signature that cannot verify (refused with 403, nothing recorded), and the stand-in
  // verifier records what the server asked it to check.
  async function acceptedForms(method, p, body, auth) {
    const mark = verifyLog.length;
    const r = await http(method, p, {body: {...body, signature: DRY_SIG}, auth});
    assert.equal(r.status, 403, `dry run of ${p}: ${JSON.stringify(r.body)}`);
    return [...new Map(verifyLog.slice(mark).map(e => [e.message_hex, {message_text: Buffer.from(e.message_hex, 'hex').toString('utf8'), message_hex: e.message_hex}])).values()];
  }
  async function step(label, actor, method, p, {body, rawBody, auth, admin, client_call, reads, expect, extra = {}} = {}) {
    const clientReads = {};
    for (const [rp, ra] of reads || []) clientReads[`GET /pilot/v1${rp}`] = await http('GET', rp, {auth: ra});
    const mark = verifyLog.length;
    const response = await http(method, p, {body, rawBody, auth, admin});
    if (expect !== undefined) assert.equal(response.status, expect, `${label}: ${JSON.stringify(response.body).slice(0, 400)}`);
    const s = {n: steps.length + 1, label, actor, at: iso(now),
      request: {method, path: '/pilot/v1' + p, headers: {...(auth ? {authorization: `Bearer <${auth}>`} : {}), ...(admin ? {'x-valun-admin': '<admin_token>'} : {})},
        ...(body !== undefined ? {body} : {}), ...(rawBody !== undefined ? {raw_body: rawBody} : {})},
      ...extra,
      response,
      server_verified: verifyLog.slice(mark).map(e => ({pubkey: e.pubkey, message_hex: e.message_hex, ...(e.message_hex.length === 160 ? {kind: 'basis_note_message'} : {kind: 'statement', message_text: Buffer.from(e.message_hex, 'hex').toString('utf8')}), signature: e.signature, valid: e.valid,
        ...(e.signer_refused ? {signer_refused: 'the signer reported an error for this input ("signer: ..."); the server counts it as does not verify'} : {})})),
      ...(client_call ? {client_call} : {}), ...(reads ? {client_reads: clientReads} : {})};
    steps.push(s); tick();
    return response.body;
  }

  // ---- identities: invites (operator), join (owner), enroll (agent) ----
  const P = {};
  for (const [name, op] of [['alice', 'Spec test operator A'], ['bob', 'Spec test operator B'], ['carol', 'Spec test operator C']]) {
    const inv = await step(`operator creates an invite for ${name}`, 'operator', 'POST', '/admin/invites', {admin: true, body: {note: `for ${name}`, max_uses: 1, ttl_days: 14}, expect: 201});
    redact.set(inv.code, `<invite_code:${name}>`);
    const j = await step(`${name}'s owner joins with the invite`, `${name}.owner`, 'POST', '/join', {body: {invite: inv.code, handle: name, display_name: `${name[0].toUpperCase()}${name.slice(1)} (spec test)`, operator: op,
      about: `${name}: a test participant of the specification transcript`, services: name === 'bob' ? 'research briefs' : ''}, expect: 201});
    tokens[`${name}.owner`] = j.owner_token; redact.set(j.owner_token, `<${name}.owner>`);
    P[name] = {id: j.participant_id, key: K[name], code: j.enrollment_code};
  }
  for (const name of ['alice', 'bob', 'carol']) {
    const x = P[name], stmt = statements.enroll(x.id, x.key.pub, sha256(x.code));
    const e = await step(`${name}'s agent enrolls its locally generated key (proof of possession)`, `${name}.agent`, 'POST', '/enroll', {body: {participant_id: x.id, code: x.code, pubkey: x.key.pub, signature: signText(x.key, stmt)},
      client_call: {method: 'enroll', key: name, args: {participant_id: x.id, code: x.code}}, expect: 201});
    tokens[`${name}.agent`] = e.agent_token; redact.set(e.agent_token, `<${name}.agent>`);
  }
  // ---- owners set mandates; the agent records a stricter limit ----
  await step("alice's owner sets the mandate", 'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200,
    body: {objective: 'Buy short, sourced research briefs.', approve_above: 50, max_issue_per_deal: 100, max_issue_outstanding: 300, max_accept_per_deal: 100, max_accept_per_issuer: 150}});
  await step("bob's owner sets the mandate", 'bob.owner', 'PUT', '/owner/mandate', {auth: 'bob.owner', expect: 200,
    body: {objective: 'Sell research briefs.', approve_above: 100, max_issue_per_deal: 100, max_issue_outstanding: 300, max_accept_per_deal: 100, max_accept_per_issuer: 200, min_price_as_payee: 5}});
  await step("carol's owner sets the mandate", 'carol.owner', 'PUT', '/owner/mandate', {auth: 'carol.owner', expect: 200, body: {approve_above: 100, counterparties: [P.alice.id]}});
  const limits = {max_issue_per_deal: 80, notes: 'Owner said: at most 80 PC for any one brief.'};
  await step("alice's agent records a limit its owner gave it (stricter than the mandate)", 'alice.agent', 'PUT', '/limits', {auth: 'alice.agent', body: limits, expect: 200,
    client_call: {method: 'set_limits', key: 'alice', args: {body: limits}}});
  // ---- public reads ----
  const info = await step('public: network info', 'anyone', 'GET', '/info', {expect: 200});
  await step('public: directory', 'anyone', 'GET', '/participants', {expect: 200});
  await step('agent: who am I', 'alice.agent', 'GET', '/me', {auth: 'alice.agent', expect: 200});

  // reference client (mirrors valun_client.py so the Python client, given the same inputs, must produce the same bytes)
  let dn = 0;
  const nextDeal = () => 'vd_' + sha256(`valun-open/spec/transcript/deal/${++dn}`).slice(0, 16);
  const nextNonce = () => sha256(`valun-open/spec/transcript/nonce/${dn}/${now}`).slice(0, 32);
  const terms = ({me, other, role, title, description, deliverable, price, dueH = 48, ttlH = 24, dealId, version = 1, prior = null, nonce}) => ({
    protocol: PROTOCOL, network: NETWORK, tracker_nft_id: info.tracker_nft_id, denomination: info.denomination, deal_id: dealId, version, prior_terms_hash: prior, nonce,
    proposer: me.id, payer: role === 'payer' ? {id: me.id, pubkey: me.key.pub} : {id: other.id, pubkey: other.key.pub},
    payee: role === 'payer' ? {id: other.id, pubkey: other.key.pub} : {id: me.id, pubkey: me.key.pub},
    service: {title, description, deliverable}, price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: isoSec(now + dueH * H), offer_expires_at: isoSec(now + ttlH * H)});
  const agentOf = name => `${name}.agent`;
  let lastProposal = null;          // the exact body of the last propose() step (to resend it unchanged)
  async function propose(name, otherName, role, svc, price, label, expect = 201, expectError = null) {
    const me = P[name], other = P[otherName], dealId = nextDeal(), nonce = nextNonce();
    const t = terms({me, other, role, ...svc, price, dealId, nonce}), h = termsHash(t);
    const body = {terms: t, terms_hash: h, signature: signText(me.key, statements.propose(h))};
    lastProposal = {dealId, body};
    const v = await step(label, agentOf(name), 'POST', '/deals', {auth: agentOf(name), body, expect,
      reads: [['/info'], [`/participants/${other.id}`]],
      client_call: {method: 'propose', key: name, token_hex: [dealId.slice(3), nonce], args: {counterparty_id: other.id, role, ...svc, price, deliver_by_hours: 48, offer_ttl_hours: 24},
        ...(expectError ? {expect_error: expectError, expected_statement: statements.propose(h),
          note: 'the server verified no statement it could report (the signer did not answer), so the replay checks the signature against statements.propose(terms_hash)'} : {})}});
    return v.id ?? dealId;
  }
  const dealView = async (name, id) => (await http('GET', `/deals/${id}`, {auth: agentOf(name)})).body;
  async function accept(name, id, label) {
    const d = await dealView(name, id), h = d.current.terms_hash;
    return step(label, agentOf(name), 'POST', `/deals/${id}/accept`, {auth: agentOf(name), body: {terms_hash: h, signature: signText(P[name].key, statements.accept(h))}, expect: 200,
      reads: [[`/deals/${id}`, agentOf(name)], ['/info'], [`/participants/${d.current.by}`]],
      client_call: {method: 'accept', key: name, args: {deal_id: id, expected_terms_hash: h}}});
  }
  async function deliver(name, id, content, title, label) {
    const d = await dealView(name, id), h = d.agreement.terms_hash, dh = sha256(content);
    return step(label, agentOf(name), 'POST', `/deals/${id}/deliver`, {auth: agentOf(name), body: {terms_hash: h, content, title, sha256: dh, signature: signText(P[name].key, statements.deliver(h, dh))}, expect: 200,
      reads: [[`/deals/${id}`, agentOf(name)]], client_call: {method: 'deliver', key: name, args: {deal_id: id, content, title}}});
  }
  async function complete(name, payeeName, id, label) {
    const d = await dealView(name, id), tpl = (await http('GET', `/deals/${id}/credit-note-template`, {auth: agentOf(name)})).body;
    const h = d.agreement.terms_hash, dh = d.delivery.sha256;
    const msg = noteMessage(hx(P[name].key.pub), hx(P[payeeName].key.pub), tpl.total, tpl.timestamp, hx(tpl.tracker_nft_id), tpl.denomination).toString('hex');
    assert.equal(msg, tpl.message_hex, 'template message_hex vs local recomputation');
    return step(label, agentOf(name), 'POST', `/deals/${id}/complete`, {auth: agentOf(name), expect: 200,
      body: {terms_hash: h, deliverable_sha256: dh, signature: signText(P[name].key, statements.complete(h, dh)), credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: signHex(P[name].key, msg)}},
      reads: [[`/deals/${id}`, agentOf(name)], [`/deals/${id}/credit-note-template`, agentOf(name)], [`/participants/${P[payeeName].id}`]],
      client_call: {method: 'complete', key: name, args: {deal_id: id, expected_deliverable_sha256: dh}}});
  }
  // Reasons: since release v8 a client signs the reason exactly as it sends it (signForm 'as_sent'); 'cleaned' reproduces
  // a pre-v8 client that signed clean(reason), which the server still accepts. `variants` record, for an agent-tool path
  // that sends a different reason string (valun_respond strips it), the reason it sends and the forms the server accepts
  // for it. They name the tool, not a file: check_python.py finds the call in each client's tool layer (hermes-plugin-valun
  // tools.py, the valun package's agent.py) and checks that `strip` still describes it.
  const RESPOND_DECLINE = {name: 'valun_respond', tool: 'valun_respond', client_method: 'decline', strip: true,
    note: 'the valun_respond tool sends reason.strip() to Client.decline, which signs what it sends (Python str.strip() equals ECMAScript trim() for every reason v9 accepts)'};
  const REVIEW_DISPUTE = {name: 'valun_review_delivery', tool: 'valun_review_delivery', client_method: 'dispute', strip: false,
    note: 'the valun_review_delivery tool passes the reason unchanged to Client.dispute'};
  async function reasonVariants(method, path, body, variants, auth) {
    const out = [];
    for (const v of variants || []) {
      const sent = v.strip ? body.reason.trim() : body.reason;
      out.push({...v, reason_sent: sent, server_accepts: await acceptedForms(method, path, {...body, reason: sent}, auth)});
    }
    return out.length ? {variants: out} : {};
  }
  async function decline(name, id, reason, label, variants, signForm = 'as_sent') {
    const d = await dealView(name, id), h = d.current.terms_hash, path = `/deals/${id}/decline`;
    const body = {terms_hash: h, reason, signature: signText(P[name].key, statements.decline(h, signForm === 'cleaned' ? cleanText(reason) : reason))};
    const accepts = await acceptedForms('POST', path, body, agentOf(name)), vs = await reasonVariants('POST', path, body, variants, agentOf(name));
    return step(label, agentOf(name), 'POST', path, {auth: agentOf(name), expect: 200, body, extra: {signed_form: signForm, server_accepts: accepts},
      reads: [[`/deals/${id}`, agentOf(name)]], client_call: {method: 'decline', key: name, args: {deal_id: id, reason}, ...vs}});
  }
  async function dispute(name, id, reason, label, variants, signForm = 'as_sent') {
    const d = await dealView(name, id), h = d.agreement.terms_hash, dh = d.delivery.sha256, path = `/deals/${id}/dispute`;
    const body = {terms_hash: h, deliverable_sha256: dh, reason, signature: signText(P[name].key, statements.dispute(h, dh, signForm === 'cleaned' ? cleanText(reason) : reason))};
    const accepts = await acceptedForms('POST', path, body, agentOf(name)), vs = await reasonVariants('POST', path, body, variants, agentOf(name));
    return step(label, agentOf(name), 'POST', path, {auth: agentOf(name), expect: 200, body, extra: {signed_form: signForm, server_accepts: accepts},
      reads: [[`/deals/${id}`, agentOf(name)]], client_call: {method: 'dispute', key: name, args: {deal_id: id, reason}, ...vs}});
  }
  const brief = {title: 'Short research brief', description: 'Summarise three sources on agent-to-agent credit.', deliverable: 'markdown, 300-500 words, 3 cited sources'};
  const content = '# Agent-to-agent credit\n\nThree sources, summarised: ...\n\n1. https://example.org/a\n2. https://example.org/b\n3. https://example.org/c\n';

  // ---- flow A: propose (payer), accept, deliver, accept delivery -> credit note ----
  const A = await propose('alice', 'bob', 'payer', brief, 20, 'flow A: alice (payer) proposes 20 PC to bob');
  await step('flow A: bob reads his inbox', 'bob.agent', 'GET', '/inbox', {auth: 'bob.agent', expect: 200});
  await accept('bob', A, 'flow A: bob accepts: agreed');
  await deliver('bob', A, content, 'Brief: agent-to-agent credit', 'flow A: bob delivers');
  await step('flow A: alice fetches the credit-note template', 'alice.agent', 'GET', `/deals/${A}/credit-note-template`, {auth: 'alice.agent', expect: 200});
  await complete('alice', 'bob', A, 'flow A: alice accepts the delivery and signs the Basis note: note_issued');
  await step('public: ledger and reconciliation', 'anyone', 'GET', '/ledger', {expect: 200});
  await step("public: bob's participant page with position", 'anyone', 'GET', `/participants/${P.bob.id}`, {expect: 200});
  await step('third party: carol cannot see the deal (404)', 'carol.agent', 'GET', `/deals/${A}`, {auth: 'carol.agent', expect: 404});

  // ---- flow B: payee proposes, payer counters, payee declines ----
  const B = await propose('bob', 'alice', 'payee', brief, 30, 'flow B: bob (payee) offers his brief for 30 PC');
  {
    const d = await dealView('alice', B), t0 = d.current.terms, nonce = nextNonce();
    const dueH = Math.max(1, Math.floor((Date.parse(t0.deliver_by) - now) / H));
    const t = terms({me: P.alice, other: P.bob, role: 'payer', title: t0.service.title, description: t0.service.description, deliverable: t0.service.deliverable, price: 25, dueH, ttlH: 24,
      dealId: B, version: d.current.version + 1, prior: d.current.terms_hash, nonce}), h = termsHash(t);
    await step('flow B: alice counters at 25 PC (version 2)', 'alice.agent', 'POST', `/deals/${B}/counter`, {auth: 'alice.agent', expect: 200,
      body: {terms: t, terms_hash: h, signature: signText(P.alice.key, statements.propose(h))},
      reads: [[`/deals/${B}`, 'alice.agent'], ['/info'], [`/participants/${P.bob.id}`]],
      client_call: {method: 'counter', key: 'alice', token_hex: [nonce], args: {deal_id: B, price: 25}}});
  }
  await decline('bob', B, 'Below my floor for a sourced brief.', 'flow B: bob declines the counter-offer with a reason');

  // ---- flow C: a decline reason with padding and a trailing newline, signed exactly as sent ----
  const C = await propose('alice', 'bob', 'payer', {...brief, title: 'Tiny fact check'}, 5, 'flow C: alice proposes 5 PC');
  await decline('bob', C, '  Not this week, sorry.\n', 'flow C: bob declines; the reason has leading spaces and a trailing newline and is signed exactly as sent (stored cleaned, with reason_as_signed)',
    [RESPOND_DECLINE]);
  // ---- flow C2: a pre-v8 client that signed the CLEANED reason is still accepted ----
  const C2 = await propose('alice', 'bob', 'payer', {...brief, title: 'Typo check'}, 4, 'flow C2: alice proposes 4 PC');
  await decline('bob', C2, 'Busy this week.\n', 'flow C2: bob declines, signing the cleaned reason as clients did before release v8 (still accepted)', undefined, 'cleaned');

  // ---- flow D: withdraw ----
  const D = await propose('alice', 'bob', 'payer', {...brief, title: 'Quick summary'}, 6, 'flow D: alice proposes 6 PC');
  {
    const h = (await dealView('alice', D)).current.terms_hash;
    await step('flow D: alice withdraws her open offer', 'alice.agent', 'POST', `/deals/${D}/withdraw`, {auth: 'alice.agent', expect: 200,
      body: {terms_hash: h, signature: signText(P.alice.key, statements.withdraw(h))}, reads: [[`/deals/${D}`, 'alice.agent']],
      client_call: {method: 'withdraw', key: 'alice', args: {deal_id: D}}});
  }

  // ---- flow E: above approve_above -> owner approval; then accept, deliver, dispute ----
  const E = await propose('alice', 'bob', 'payer', {...brief, title: 'Long research report'}, 60, 'flow E: alice proposes 60 PC: above her approve_above (50), so it waits for her owner');
  await step('flow E: bob cannot see an offer its proposer\'s owner has not approved (404)', 'bob.agent', 'GET', `/deals/${E}`, {auth: 'bob.agent', expect: 404});
  const owner = await step("flow E: alice's owner console (approvals with subject and effect)", 'alice.owner', 'GET', '/owner', {auth: 'alice.owner', expect: 200});
  const appr = owner.approvals.find(a => a.deal_id === E && a.state === 'pending');
  await step("flow E: alice's owner approves the offer", 'alice.owner', 'POST', `/owner/approvals/${appr.id}`, {auth: 'alice.owner', body: {decision: 'approve', note: 'fine for this one'}, expect: 200});
  await accept('bob', E, 'flow E: bob accepts: agreed');
  await deliver('bob', E, 'Report: only one source, unattributed.', 'Report', 'flow E: bob delivers');
  await dispute('alice', E, 'The report cites no sources.', 'flow E: alice disputes the delivery');

  // ---- flow F: a dispute reason with a trailing newline ----
  const F = await propose('alice', 'bob', 'payer', {...brief, title: 'Link check'}, 10, 'flow F: alice proposes 10 PC');
  await accept('bob', F, 'flow F: bob accepts');
  await deliver('bob', F, 'All links checked.', '', 'flow F: bob delivers');
  await dispute('alice', F, 'Two of the three links are dead.\n', 'flow F: alice disputes; the reason ends with a newline and is signed exactly as sent',
    [REVIEW_DISPUTE]);

  // ---- flow H (adversarial finding F1, fixed in v8): an agent cannot accept while its own counter-offer waits ----
  const Hd = await propose('bob', 'alice', 'payee', {...brief, title: 'Market scan'}, 70, 'flow H: bob (payee) offers a market scan for 70 PC');
  {
    const d = await dealView('alice', Hd), t0 = d.current.terms, nonce = nextNonce();
    const dueH = Math.max(1, Math.floor((Date.parse(t0.deliver_by) - now) / H));
    const t = terms({me: P.alice, other: P.bob, role: 'payer', title: t0.service.title, description: t0.service.description, deliverable: t0.service.deliverable, price: 60, dueH, ttlH: 24,
      dealId: Hd, version: d.current.version + 1, prior: d.current.terms_hash, nonce}), h = termsHash(t);
    await step("flow H: alice counters at 60 PC: above her approve_above (50), so the counter waits for her owner and bob cannot see it", 'alice.agent', 'POST', `/deals/${Hd}/counter`, {auth: 'alice.agent', expect: 200,
      body: {terms: t, terms_hash: h, signature: signText(P.alice.key, statements.propose(h))},
      reads: [[`/deals/${Hd}`, 'alice.agent'], ['/info'], [`/participants/${P.bob.id}`]],
      client_call: {method: 'counter', key: 'alice', token_hex: [nonce], args: {deal_id: Hd, price: 60}}});
  }
  await step("flow H: alice's view: next_actions no longer offers accept while her own counter waits", 'alice.agent', 'GET', `/deals/${Hd}`, {auth: 'alice.agent', expect: 200});
  {
    const d = await dealView('alice', Hd), h = d.current.terms_hash;
    await step("flow H: alice tries to accept bob's 70 PC offer anyway (409 counter_pending)", 'alice.agent', 'POST', `/deals/${Hd}/accept`, {auth: 'alice.agent', expect: 409,
      body: {terms_hash: h, signature: signText(P.alice.key, statements.accept(h))},
      reads: [[`/deals/${Hd}`, 'alice.agent'], ['/info'], [`/participants/${P.bob.id}`]],
      client_call: {method: 'accept', key: 'alice', args: {deal_id: Hd, expected_terms_hash: h}, expect_error: 'counter_pending',
        expected_statement: statements.accept(h), note: 'the server refuses before it checks any signature, so the replay checks the signature against statements.accept(terms_hash)'}});
  }
  {
    const o = await http('GET', '/owner', {auth: 'alice.owner'}), ap = o.body.approvals.find(a => a.deal_id === Hd && a.state === 'pending');
    await step("flow H: alice's owner approves the counter-offer: it becomes the current version", 'alice.owner', 'POST', `/owner/approvals/${ap.id}`, {auth: 'alice.owner', body: {decision: 'approve'}, expect: 200});
  }
  await decline('bob', Hd, 'I cannot do a market scan for 60.', 'flow H: bob declines the counter-offer');

  // ---- errors: the shapes a client must handle ----
  await step('error: no token (401)', 'anyone', 'GET', '/me', {expect: 401});
  {
    const t = terms({me: P.alice, other: P.bob, role: 'payer', ...brief, price: 20, dealId: nextDeal(), nonce: nextNonce()}), h = termsHash(t);
    await step('error: claimed terms_hash differs from the server\'s (400 hash_mismatch, with the canonical text)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 400,
      body: {terms: t, terms_hash: 'f'.repeat(64), signature: signText(P.alice.key, statements.propose(h))}});
    await step('error: signature by another key (403 bad_signature)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 403,
      body: {terms: t, terms_hash: h, signature: signText(P.bob.key, statements.propose(h))}});
    const big = {...t, deal_id: nextDeal(), price: {amount: 81, unit: 'PC'}}, hb = termsHash(big);
    await step('error: above the limit the agent recorded (403 mandate_exceeded, source agent_limits)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 403,
      body: {terms: big, terms_hash: hb, signature: signText(P.alice.key, statements.propose(hb))}});
    const cp = {...t, deal_id: nextDeal(), payee: {id: P.carol.id, pubkey: P.carol.key.pub}, proposer: P.carol.id, payer: {id: P.bob.id, pubkey: P.bob.key.pub}}, hc = termsHash(cp);
    await step("error: counterparty not on carol's owner's list (403 mandate_exceeded, rule counterparties)", 'carol.agent', 'POST', '/deals', {auth: 'carol.agent', expect: 403,
      body: {terms: cp, terms_hash: hc, signature: signText(P.carol.key, statements.propose(hc))}});
    await step('error: unknown terms field (400 invalid_terms)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 400,
      body: {terms: {...t, memo: 'x'}, signature: signText(P.alice.key, statements.propose(h))}});
    const esc = {...t, deal_id: nextDeal(), service: {...t.service, title: 'Brief \u001b[31mURGENT\u001b[0m'}}, he = termsHash(esc);
    await step('error: a control character in signed service text (400 invalid_field, since v8)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 400,
      body: {terms: esc, terms_hash: he, signature: signText(P.alice.key, statements.propose(he))}});
    const early = {...t, deal_id: nextDeal(), deliver_by: isoSec(Date.parse(t.offer_expires_at) - H)}, hy = termsHash(early);
    await step('error: deliver_by earlier than offer_expires_at (400 invalid_terms, since v8)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 400,
      body: {terms: early, terms_hash: hy, signature: signText(P.alice.key, statements.propose(hy))}});
  }
  await step('error: a JSON body that is not an object (400 bad_json, since v8)', 'anyone', 'POST', '/join', {rawBody: 'null', expect: 400});
  await step('error: admin invite outside 1..1000 uses (400 invalid_field, since v8)', 'operator', 'POST', '/admin/invites', {admin: true, body: {max_uses: 0}, expect: 400});
  {
    const inv = await step('operator creates an invite for the join refusals below', 'operator', 'POST', '/admin/invites', {admin: true, body: {note: 'join refusals', max_uses: 1, ttl_days: 1}, expect: 201});
    redact.set(inv.code, '<invite_code:refusals>');
    await step('error: a reserved handle (409 handle_taken, since v8)', 'anyone', 'POST', '/join', {expect: 409, body: {invite: inv.code, handle: 'admin', operator: 'x'}});
    await step("error: a display_name copying another participant's display name (409 display_name_taken since v9; 409 invalid_field in v8)", 'anyone', 'POST', '/join', {expect: 409,
      body: {invite: inv.code, handle: 'dave', operator: 'x', display_name: 'Bob (spec test)'}});
    await step('error: a bidi override in a public profile field (400 invalid_field, since v8)', 'anyone', 'POST', '/join', {expect: 400,
      body: {invite: inv.code, handle: 'dave', operator: 'x', about: 'trusted \u202Eetis\u202C'}});
  }
  const G = await propose('alice', 'bob', 'payer', brief, 8, 'flow G: alice proposes 8 PC');
  await step('error: accepting your own offer (409 own_offer)', 'alice.agent', 'POST', `/deals/${G}/accept`, {auth: 'alice.agent', expect: 409,
    body: {terms_hash: (await dealView('alice', G)).current.terms_hash, signature: signText(P.alice.key, statements.accept((await dealView('alice', G)).current.terms_hash))}});
  await step('error: stale terms_hash (409 stale_terms)', 'bob.agent', 'POST', `/deals/${G}/accept`, {auth: 'bob.agent', expect: 409,
    body: {terms_hash: 'e'.repeat(64), signature: signText(P.bob.key, statements.accept('e'.repeat(64)))}});
  await step('error: an owner token cannot sign deal acts (404)', 'alice.owner', 'POST', `/deals/${G}/withdraw`, {auth: 'alice.owner', expect: 404, body: {terms_hash: 'x', signature: 'y'}});
  await step('error: an agent token cannot change the mandate (404)', 'alice.agent', 'PUT', '/owner/mandate', {auth: 'alice.agent', expect: 404, body: {approve_above: 999}});
  await step("error: an agent cannot raise its owner's ceiling (403 above_owner_mandate)", 'alice.agent', 'PUT', '/limits', {auth: 'alice.agent', expect: 403, body: {max_issue_per_deal: 101}});
  await step('error: invalid invite (403 invalid_invite)', 'anyone', 'POST', '/join', {expect: 403, body: {invite: 'vpi_not-a-real-code', handle: 'eve', operator: 'x'}});

  // ---- key revocation and re-enrollment ----
  const rv = await step("carol's owner revokes carol's agent key", 'carol.owner', 'POST', '/owner/revoke-agent', {auth: 'carol.owner', expect: 200});
  await step("carol's old agent token no longer works (401)", 'carol.agent', 'GET', '/me', {auth: 'carol.agent', expect: 401});
  await step('error: a signature that is not a hex string (here a one-element array) is a refusal, never a 502 (403 bad_signature, since v8)', 'anyone', 'POST', '/enroll', {expect: 403,
    body: {participant_id: P.carol.id, code: rv.enrollment_code, pubkey: K['carol-2'].pub, signature: ['00'.repeat(65)]}});
  await step('error: a public key that is not a hex string (400 invalid_field, since v8)', 'anyone', 'POST', '/enroll', {expect: 400,
    body: {participant_id: P.carol.id, code: rv.enrollment_code, pubkey: [K['carol-2'].pub], signature: '00'.repeat(65)}});
  {
    const stmt = statements.enroll(P.carol.id, K['carol-2'].pub, sha256(rv.enrollment_code));
    const e = await step("carol's agent enrolls a NEW key with the code from the revocation", 'carol.agent', 'POST', '/enroll', {expect: 201,
      body: {participant_id: P.carol.id, code: rv.enrollment_code, pubkey: K['carol-2'].pub, signature: signText(K['carol-2'], stmt)},
      client_call: {method: 'enroll', key: 'carol-2', args: {participant_id: P.carol.id, code: rv.enrollment_code}}});
    tokens['carol.agent'] = e.agent_token; redact.set(e.agent_token, '<carol.agent#2>');
  }
  P.carol.key = K['carol-2']; P.carol.past_keys = ['carol'];
  await step('error: an enrollment code works once (403 invalid_enrollment)', 'anyone', 'POST', '/enroll', {expect: 403,
    body: {participant_id: P.carol.id, code: rv.enrollment_code, pubkey: K.carol.pub, signature: signText(K.carol, statements.enroll(P.carol.id, K.carol.pub, sha256(rv.enrollment_code)))}});
  const rv2 = await step("carol's owner revokes the second key too", 'carol.owner', 'POST', '/owner/revoke-agent', {auth: 'carol.owner', expect: 200});
  await step('error: a key registered before can never be registered again (409 key_in_use)', 'anyone', 'POST', '/enroll', {expect: 409,
    body: {participant_id: P.carol.id, code: rv2.enrollment_code, pubkey: K.carol.pub, signature: signText(K.carol, statements.enroll(P.carol.id, K.carol.pub, sha256(rv2.enrollment_code)))}});
  P.carol.past_keys.push('carol-2'); P.carol.key = null;
  await step("carol's owner console: no agent, two past keys", 'carol.owner', 'GET', '/owner', {auth: 'carol.owner', expect: 200});

  // ===================================================================================================================
  // Release v9 (ed1da4a): OQ-31 signer failures, OQ-32 reasons, OQ-33 characters, OQ-34 names. Appended after the steps
  // above so that those steps, and the ids they produce, are the same as in the v8 transcript.
  // ===================================================================================================================
  // ---- flow I: a decline reason with an emoji ZWJ sequence, a ZWNJ and an LRM (allowed since v9), signed as sent ----
  const I = await propose('alice', 'bob', 'payer', {...brief, title: 'Glossary'}, 7, 'flow I: alice proposes 7 PC');
  await decline('bob', I, 'Booked up \u{1F469}\u200D\u{1F4BB} until December (\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645, \u200Elater). \n',
    'flow I: bob declines; the reason holds an emoji ZWJ sequence, a ZWNJ and an LRM (allowed since v9) and ends with a space and a newline', [RESPOND_DECLINE]);

  // ---- OQ-32: decline reasons v9 refuses before any signature is checked (on flow G's open offer) ----
  for (const [what, reason] of [['a bidi override', 'no thanks\u202Eevil'], ['tag characters (hidden text)', 'No\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}'],
    ['a C1 control', 'no\u0085thanks'], ['a number instead of text', 42]]) {
    const h = (await dealView('bob', G)).current.terms_hash, mark = verifyLog.length;
    await step(`error: a decline reason with ${what} (400 invalid_field, since v9)`, 'bob.agent', 'POST', `/deals/${G}/decline`, {auth: 'bob.agent', expect: 400,
      body: {terms_hash: h, reason, signature: signText(P.bob.key, statements.decline(h, String(reason)))}});
    assert.equal(verifyLog.length, mark, 'a refused reason never reaches the signer');
  }

  // ---- OQ-31: signer failures. An outage is 503 signer_unavailable and nothing is recorded; a signer that reports an
  // error for the input ("signer: ...") means "does not verify"; a signature without a 02/03 prefix never reaches it. ----
  signer.mode = 'outage';
  const J = await propose('alice', 'bob', 'payer', {...brief, title: 'Citation check'}, 9,
    'error: the signature checker is unavailable (503 signer_unavailable, since v9; v8 said 403 bad_signature); nothing is recorded', 503, 'signer_unavailable');
  signer.mode = 'ok';
  assert.equal((await http('GET', `/deals/${J}`, {auth: 'alice.agent'})).status, 404, 'an offer refused with 503 is not recorded');
  await step('after the outage: the same signed offer sent again unchanged is accepted (201)', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', body: lastProposal.body, expect: 201});
  await accept('bob', J, 'flow J: bob accepts: agreed');
  await deliver('bob', J, 'Citations checked: 12 of 12 resolve.', 'Citation check', 'flow J: bob delivers');
  signer.mode = 'outage';
  await step('during an outage the credit-note template is 503 signer_unavailable since v11 (v9: 502 internal error; the note message comes from the same signer, OQ-31)', 'alice.agent', 'GET',
    `/deals/${J}/credit-note-template`, {auth: 'alice.agent', expect: 503});
  signer.mode = 'ok';
  await complete('alice', 'bob', J, 'flow J: after the outage alice accepts the delivery and signs the Basis note (cumulative total 29): note_issued');
  {
    const h = (await dealView('bob', G)).current.terms_hash, stmt = statements.decline(h, 'Not now.');
    const good = signText(P.bob.key, stmt), offCurve = '02' + 'ff'.repeat(32) + good.slice(66);   // x >= p: not a curve point
    signer.mode = 'refuses';
    await step('error: the signer reports an error for the input ("signer: ...", here emulated by the stand-in): does not verify (403 bad_signature, not 503)', 'bob.agent', 'POST',
      `/deals/${G}/decline`, {auth: 'bob.agent', expect: 403, body: {terms_hash: h, reason: 'Not now.', signature: offCurve}});
    signer.mode = 'ok';
    const ah = (await dealView('bob', G)).current.terms_hash, mark = verifyLog.length;
    await step('error: an all-zero signature is refused before the signer runs (403 bad_signature; since v9 a signature must start with 02 or 03)', 'bob.agent', 'POST',
      `/deals/${G}/accept`, {auth: 'bob.agent', expect: 403, body: {terms_hash: ah, signature: '00'.repeat(65)}});
    assert.equal(verifyLog.length, mark, 'an all-zero signature never reaches the signer');
  }

  // ---- OQ-33/OQ-34: profile text and names at join ----
  {
    const inv = await step('operator creates an invite for the release v9 join checks below', 'operator', 'POST', '/admin/invites', {admin: true, body: {note: 'v9 join checks', max_uses: 7, ttl_days: 1}, expect: 201});
    redact.set(inv.code, '<invite_code:v9>');
    const join = (label, expect, body) => step(label, 'anyone', 'POST', '/join', {expect, body: {invite: inv.code, operator: 'x', ...body}});
    await join('error: a reserved word as display_name (409 display_name_taken, since v9)', 409, {handle: 'dave', display_name: 'Valun'});
    await join('error: a reserved word with punctuation as display_name ("V.A.L.U.N": 409 display_name_taken, since v9)', 409, {handle: 'dave', display_name: 'V.A.L.U.N'});
    await join("error: a display_name equal to another participant's display name once normalized (letters and digits, lower case; 409 display_name_taken, since v9)", 409,
      {handle: 'dave', display_name: 'BOB spec-test'});
    await join("error: a display_name equal to another participant's handle once normalized (409 display_name_taken, since v9)", 409, {handle: 'dave', display_name: 'Al-ice'});
    await join("error: a handle equal to another participant's display name once normalized (409 handle_taken, since v9)", 409, {handle: 'alice-spec-test'});
    await join('error: a reserved word as a handle once normalized ("ad-min": 409 handle_taken, since v9)', 409, {handle: 'ad-min'});
    await join('error: tag characters in a public profile field (400 invalid_field, since v9)', 400, {handle: 'dave', about: 'helpful\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}'});
    await join('error: a C1 control in a public profile field (400 invalid_field, since v9)', 400, {handle: 'dave', services: 'briefs\u009B31m'});
    const joined = [
      await join('join: an emoji ZWJ sequence and Persian with ZWNJ in profile fields are accepted (201, since v9); the display name has no letters or digits', 201,
        {handle: 'dave', display_name: '\u{1F642}\u{1F642}', about: 'Research briefs \u{1F469}\u200D\u{1F4BB}', services: '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'}),
      await join("join: the same display name as dave's is accepted, because a name with no letters or digits is never compared (201; OPEN-QUESTIONS OQ-34)", 201,
        {handle: 'erin', display_name: '\u{1F642}\u{1F642}'}),
      await join("join: a confusable copy of bob's display name (CYRILLIC SMALL LETTER O for Latin o) is accepted (201; OPEN-QUESTIONS OQ-34)", 201,
        {handle: 'frank', display_name: 'B\u043Eb (spec test)'}),
      await join('join: a reserved word inside a longer display name ("Valun Support") is accepted: only whole normalized names are compared (201; OPEN-QUESTIONS OQ-34)', 201,
        {handle: 'grace', display_name: 'Valun Support'}),
      await join('join: a reserved word in fullwidth letters as display name is accepted: no compatibility normalization (NFKC) before comparing (201; OPEN-QUESTIONS OQ-34)', 201,
        {handle: 'heidi', display_name: '\uFF36\uFF41\uFF4C\uFF55\uFF4E'}),
      await join('join: a display name with a precomposed accent (NFC) is accepted (201)', 201, {handle: 'judy', display_name: 'Jos\u00E9 Briefs'}),
      await join("join: the same name with a decomposed accent (NFD) is accepted too, although it looks identical: norm() removes the combining mark, so it compares as \"josebriefs\", not \"josébriefs\" (201; OPEN-QUESTIONS OQ-34)", 201,
        {handle: 'kim', display_name: 'Jose\u0301 Briefs'}),
    ];
    joined.forEach((j, i) => redact.set(j.owner_token, `<${['dave', 'erin', 'frank', 'grace', 'heidi', 'judy', 'kim'][i]}.owner>`));
  }

  // ===================================================================================================================
  // Release v11 (7880dcf): OQ-35 error codes, OQ-25, OQ-13, OQ-24, OQ-6, F4/OQ-29, OQ-12, OQ-20 and, last because it
  // moves the clock 9 days, OQ-8. Appended after the v9 steps so that those steps and their ids stay as they were.
  // ===================================================================================================================
  // ---- OQ-35: a tracker failure has its own code and a fixed message ----
  tracker.mode = 'down';
  await step('error: the Basis tracker cannot be reached (502 tracker_unavailable with a fixed message, since v11; v9 answered 502 internal error)', 'anyone', 'GET', '/ledger', {expect: 502});
  tracker.mode = 'ok';

  // ---- OQ-25: a proposal's signature is checked before its deal id is looked up ----
  {
    const reuse = lastProposal.body;                // flow J's offer: its deal id exists
    await step("error: a proposal that reuses an existing deal id with a bad signature is 403 bad_signature, as for an unused id (since v11; v9 answered 409 duplicate, revealing that the id exists)",
      'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 403, body: {...reuse, signature: signText(P.bob.key, statements.propose(reuse.terms_hash))}});
    await step('error: a correctly signed proposal that reuses an existing deal id is still 409 duplicate', 'alice.agent', 'POST', '/deals', {auth: 'alice.agent', expect: 409, body: reuse});
  }

  // ---- OQ-13: a PUT that changes nothing does not make a new mandate version ----
  {
    const before = (await http('GET', '/owner', {auth: 'alice.owner'})).body.mandate_version;
    const r = await step("alice's owner PUTs mandate values it already has: changed false, mandate_version unchanged (since v11)", 'alice.owner', 'PUT', '/owner/mandate',
      {auth: 'alice.owner', expect: 200, body: {approve_above: 50, max_issue_per_deal: 100}});
    assert.equal(r.changed, false); assert.equal(r.mandate_version, before);
  }

  // ---- OQ-24: owner token rotation ----
  {
    const r = await step("carol's owner rotates its owner token: a new one, shown once (POST /owner/rotate-token, since v11)", 'carol.owner', 'POST', '/owner/rotate-token', {auth: 'carol.owner', expect: 200});
    tokens['carol.owner#2'] = r.owner_token; redact.set(r.owner_token, '<carol.owner#2>');
    await step("carol's previous owner token no longer works (401)", 'carol.owner', 'GET', '/owner', {auth: 'carol.owner', expect: 401});
    await step("carol's new owner token works; the console shows owner_token_rotated_at", 'carol.owner', 'GET', '/owner', {auth: 'carol.owner#2', expect: 200});
  }

  // ---- OQ-6 (flow K): withdrawing an offer whose acceptance waits for an owner voids the acceptance ----
  const Kd = await propose('bob', 'alice', 'payee', {...brief, title: 'Source list'}, 60, 'flow K: bob (payee) offers a source list for 60 PC');
  await accept('alice', Kd, "flow K: alice accepts; 60 PC is above her approve_above (50), so the acceptance waits for her owner");
  await step("flow K: bob's view: next_actions lists withdraw while the acceptance waits (since v11)", 'bob.agent', 'GET', `/deals/${Kd}`, {auth: 'bob.agent', expect: 200});
  {
    const h = (await dealView('bob', Kd)).current.terms_hash;
    await step("flow K: bob withdraws; alice's waiting acceptance becomes void_withdrawn and its approval void (since v11; v9 left it awaiting_owner)", 'bob.agent', 'POST', `/deals/${Kd}/withdraw`,
      {auth: 'bob.agent', expect: 200, body: {terms_hash: h, signature: signText(P.bob.key, statements.withdraw(h))}, reads: [[`/deals/${Kd}`, 'bob.agent']],
        client_call: {method: 'withdraw', key: 'bob', args: {deal_id: Kd}}});
    assert.equal((await dealView('alice', Kd)).acceptance.state, 'void_withdrawn');
  }

  // ---- F4 / OQ-29 (flow L): an offer accepted after its owner lowered approve_above waits for that owner ----
  const L1 = await propose('alice', 'bob', 'payer', {...brief, title: 'Survey summary'}, 40, 'flow L: alice proposes 40 PC (within her approve_above of 50: open at once)');
  const L2 = await propose('alice', 'bob', 'payer', {...brief, title: 'Survey appendix'}, 45, 'flow L: alice proposes 45 PC (open at once)');
  await step("flow L: alice's owner lowers approve_above to 30 (changed: true)", 'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200, body: {approve_above: 30}});
  await accept('bob', L1, "flow L: bob accepts the 40 PC offer; it is above alice's owner's threshold now, so it waits for that owner (confirm_offer, held_for proposer_owner; since v11, v9 agreed at once)");
  await accept('bob', L2, "flow L: bob accepts the 45 PC offer; held for alice's owner too");
  {
    const ow = await step("flow L: alice's owner console: two confirm_offer approvals (subject accepted_offer)", 'alice.owner', 'GET', '/owner', {auth: 'alice.owner', expect: 200});
    const pend = id => ow.approvals.find(a => a.deal_id === id && a.kind === 'confirm_offer' && a.state === 'pending');
    assert.ok(pend(L1) && pend(L2), 'two pending confirm_offer approvals');
    await step("flow L: alice's owner confirms the 40 PC offer: agreed", 'alice.owner', 'POST', `/owner/approvals/${pend(L1).id}`, {auth: 'alice.owner', expect: 200, body: {decision: 'approve'}});
    await step("flow L: alice's owner does not confirm the 45 PC offer: the offer is withdrawn and bob's acceptance void", 'alice.owner', 'POST', `/owner/approvals/${pend(L2).id}`,
      {auth: 'alice.owner', expect: 200, body: {decision: 'reject'}});
    assert.equal((await dealView('bob', L1)).status, 'agreed');
    const d2 = await dealView('bob', L2);
    assert.equal(d2.status, 'withdrawn'); assert.equal(d2.acceptance.state, 'void_withdrawn');
  }
  await step("alice's owner restores approve_above to 50", 'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200, body: {approve_above: 50}});

  // ---- OQ-12 (flow L continued): the template's timestamp never exceeds the server's clock ----
  await deliver('bob', L1, 'Survey summary: five surveys, two agree.', 'Survey summary', 'flow L: bob delivers');
  signer.mode = 'refuses';
  await step('error: the signer refuses the note-message request the server built (502 signer_error, since v11; emulated by the stand-in)', 'alice.agent', 'GET',
    `/deals/${L1}/credit-note-template`, {auth: 'alice.agent', expect: 502});
  signer.mode = 'ok';
  {
    // A note for the pair alice -> bob that alice's key signed outside Valun: same total, timestamp 60 s ahead of the clock.
    const k = `${P.alice.key.pub}>${P.bob.key.pub}`, cur = notes.get(k), ts = now + 60e3;
    const m = noteMessage(hx(P.alice.key.pub), hx(P.bob.key.pub), cur.amount_collected, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION);
    notes.set(k, {...cur, timestamp: ts, signature: schnorrSign(m, P.alice.key.sk).toString('hex')});
    await step("flow L: the tracker holds a note for the pair that is 60 s ahead of the server's clock: the template is 409 note_timestamp_ahead with retry_after_ms (since v11; v9 returned a future timestamp that complete then refused)",
      'alice.agent', 'GET', `/deals/${L1}/credit-note-template`, {auth: 'alice.agent', expect: 409,
        extra: {stand_in_tracker: {note_set_outside_valun: {pair: 'alice -> bob', total: cur.amount_collected, timestamp: ts, signed_by: 'alice (test key)'}}}});
  }
  tick(60);
  await complete('alice', 'bob', L1, "flow L: once the clock has passed that note, alice accepts the delivery and signs the Basis note (cumulative total 69): note_issued");

  // ---- OQ-20 (flow N): a limit the owner records through PUT /limits is labelled as the owner's ----
  await step("bob's owner records max_accept_per_deal 40 through PUT /limits with the owner token (agent_limits_recorded_by: owner, since v11)", 'bob.owner', 'PUT', '/limits',
    {auth: 'bob.owner', expect: 200, body: {max_accept_per_deal: 40}});
  const Nd = await propose('alice', 'bob', 'payer', {...brief, title: 'Market sizing'}, 45, 'flow N: alice proposes 45 PC');
  {
    const d = await dealView('bob', Nd), h = d.current.terms_hash;
    await step('flow N: bob accepts: 403 mandate_exceeded, source agent_limits, recorded_by owner, "limit recorded by the owner (PUT /limits)" (since v11)', 'bob.agent', 'POST', `/deals/${Nd}/accept`,
      {auth: 'bob.agent', expect: 403, body: {terms_hash: h, signature: signText(P.bob.key, statements.accept(h))},
        reads: [[`/deals/${Nd}`, 'bob.agent'], ['/info'], [`/participants/${d.current.by}`]],
        client_call: {method: 'accept', key: 'bob', args: {deal_id: Nd, expected_terms_hash: h}, expect_error: 'mandate_exceeded'}});
  }
  await step("bob's owner clears that limit (null)", 'bob.owner', 'PUT', '/limits', {auth: 'bob.owner', expect: 200, body: {max_accept_per_deal: null}});

  // ---- OQ-8 (flow M): an agreed deal not delivered 7 days after deliver_by ends. Moves the clock: keep it last. ----
  const M = await propose('alice', 'bob', 'payer', {...brief, title: 'Glossary check'}, 11, 'flow M: alice proposes 11 PC');
  await accept('bob', M, 'flow M: bob accepts: agreed (the view shows delivery_grace_ends_at = deliver_by + 7 days, since v11)');
  {
    const d = await dealView('bob', M), h = d.agreement.terms_hash;
    now = Date.parse(d.current.terms.deliver_by) + 7 * 24 * H + 60e3;      // the clock jumps past the grace period
    await step('flow M: 7 days after deliver_by bob has not delivered: the deal is expired_undelivered (since v11; v9 kept it agreed forever)', 'bob.agent', 'GET', `/deals/${M}`,
      {auth: 'bob.agent', expect: 200});
    const content = 'Glossary: 40 terms checked.', dh = sha256(content);
    await step('flow M: a delivery after the grace period is refused (409 wrong_state)', 'bob.agent', 'POST', `/deals/${M}/deliver`, {auth: 'bob.agent', expect: 409,
      body: {terms_hash: h, content, title: '', sha256: dh, signature: signText(P.bob.key, statements.deliver(h, dh))}, reads: [[`/deals/${M}`, 'bob.agent']],
      client_call: {method: 'deliver', key: 'bob', args: {deal_id: M, content, title: ''}, expect_error: 'wrong_state', expected_statement: statements.deliver(h, dh),
        note: 'the server refuses before it checks any signature, so the replay checks the signature against statements.deliver(terms_hash, sha256(content))'}});
  }

  // ===================================================================================================================
  // Release v12 (a61c32e): OQ-24 recovery. Appended after the v11 steps.
  // ===================================================================================================================
  {
    const r = await step("operator: a new owner token for carol, at carol's owner's verified request (POST /admin/participants/{id}/owner-token, loopback and admin token; since v12)",
      'operator', 'POST', `/admin/participants/${P.carol.id}/owner-token`, {admin: true, expect: 200});
    tokens['carol.owner#3'] = r.owner_token; redact.set(r.owner_token, '<carol.owner#3>');
    await step("carol's previous owner token (the one the owner rotated) no longer works (401)", 'carol.owner', 'GET', '/owner', {auth: 'carol.owner#2', expect: 401});
    const o = await step("carol's owner console with the operator-issued token: owner_token_rotated_by operator (since v12)", 'carol.owner', 'GET', '/owner', {auth: 'carol.owner#3', expect: 200});
    assert.equal(o.owner_token_rotated_by, 'operator');
    await step('error: the owner-token reset is an admin route: without loopback and the admin token it does not exist (404)', 'anyone', 'POST',
      `/admin/participants/${P.carol.id}/owner-token`, {expect: 404});
  }

  // ---- OQ-30: per-IP read budgets, on a second route table over the same Pilot with small budgets. Server-only
  // behaviour, so these are `probes` (statuses only), not replayed steps. The limiter uses the real clock (60 s window). ----
  const probes = [];
  {
    const cfg = {pilotRateLimitPerMinute: 5, pilotReadLimitPerMinute: 3, pilotIpReadLimitPerMinute: 3};
    const limitedRoutes = createPilotRoutes({pilot, cfg, adminTokenHash: sha256(ADMIN)});
    const probe = async (name, description, ip, reqs, expected) => {
      const results = [];
      for (const [method, p, opt = {}] of reqs) {
        const r = await http(method, p, {...opt, via: limitedRoutes, ip});
        results.push({method, path: '/pilot/v1' + p, authorization: opt.auth ? `Bearer <${opt.auth}>` : opt.bearer ? `Bearer ${opt.bearer}` : null, status: r.status,
          ...(r.status >= 400 ? {body: r.body} : {})});
      }
      assert.deepEqual(results.map(r => r.status), expected, name);
      probes.push({name, description, config: cfg, client_ip: ip, statuses: expected, requests: results});
    };
    await probe('rate-limit/public-reads-without-token', 'Six public reads without an Authorization header, read budget 3 per IP: the fourth and later are 429.', '198.51.100.8',
      Array(6).fill(['GET', '/ledger']), [200, 200, 200, 429, 429, 429]);
    await probe('rate-limit/public-reads-made-up-token', 'The same six reads with a made-up bearer token: since v9 they count against the same per-IP budget (in v8 all six were 200; OQ-30).', '198.51.100.9',
      Array(6).fill(['GET', '/ledger', {bearer: 'vpa_made_up_token'}]), [200, 200, 200, 429, 429, 429]);
    await probe('rate-limit/two-agents-one-address', 'Two agents behind one address, each well within its own token read budget (3): since v9 every read also counts against the per-IP read budget, so the fourth read is 429 (OQ-30 residual: pilotIpReadLimitPerMinute defaults to the per-token read budget).',
      '198.51.100.10', [['GET', '/me', {auth: 'alice.agent'}], ['GET', '/me', {auth: 'alice.agent'}], ['GET', '/me', {auth: 'bob.agent'}], ['GET', '/me', {auth: 'bob.agent'}]], [200, 200, 200, 429]);
  }

  let text = JSON.stringify({meta: META('HTTP transcript of a pilot run through the real route table and Pilot class (in memory, fixed clock, stand-in tracker)', {
    base_url: 'http://valun.invalid', placeholders: 'Bearer tokens, invite codes and the admin token are replaced by <name> placeholders; replace them with your own when replaying.',
    replay: 'check_python.py replays every step with a client_call through a Python client (the Hermes plugin or the valun package): the client is given the recorded client_reads, its request body must equal the recorded one (signatures aside), and its signatures must verify over the exact bytes in server_verified.',
    signer_stand_in: 'Steps marked as signer or tracker failures switch the stand-in to an outage (BasisError "signer timed out", code signer_unavailable, as lib/basis.mjs throws for a timeout, a failed start or no output), to reporting an error for the input (BasisError "signer: ...", code signer_error), or to an unreachable tracker (code tracker_unavailable). The real valun_signer and tracker are not run. One step sets a note on the stand-in tracker directly (stand_in_tracker), as a note submitted around Valun would be.',
    probes: 'probes: server-only rate-limit behaviour on a second route table with small budgets (statuses only; not replayed by any client).'}),
    participants: Object.fromEntries(Object.entries(P).map(([n, x]) => [n, {participant_id: x.id, current_test_key: x.key?.name ?? null, past_test_keys: x.past_keys || []}])), steps, probes}, null, 1);
  for (const [value, placeholder] of redact) text = text.split(value).join(placeholder);
  for (const value of redact.keys()) assert.ok(!text.includes(value));
  return text;
}

// =====================================================================================================================
const write = (file, obj) => { fs.writeFileSync(path.join(here, file), typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj, null, 1) + '\n'); return file; };
const canon = await canonicalVectors();
const st = await statementVectors();
const notesV = noteVectors();
const sigs = signatureVectors();
const valid = await validationVectors();
const transcript = await transcriptVectors();
crypto.randomBytes = realRandomBytes;

write('canonical.json', {meta: META('Canonical JSON and terms_hash = sha256(canonical(terms)), computed by the real canonical()/termsHash()', {
  tiers: {terms: 'valid terms (server_validation shows the real validateTerms() result): every implementation MUST agree',
    wire: 'terms the server accepts written in non-canonical JSON: the canonical form (not the input text) is hashed',
    refused: 'terms the real validateTerms() refuses (server_validation shows how): the canonical form is still defined; informative for clients',
    generic: 'values outside the terms domain: informative only'}}), vectors: canon});
write('statements.json', {meta: META('Signed statements: exact UTF-8 text each act signs; signature = Basis Schnorr over those bytes', {
  tiers: {core: 'MUST agree', edge: 'inputs a client should never produce (informative)',
    refused: 'decline/dispute reasons the real server refuses (400 invalid_field) before any signature is checked; server_outcome shows the refusal; a client must not send them'}}),
  vectors: st.vectors, negative_signatures: st.negative_signatures});
write('basis-notes.json', {meta: META('Basis credit-note message (80 bytes) and debt key; replica of basis_core signing_message, proven against Basis TV001-TV011'), vectors: notesV.vectors, negative_signatures: notesV.negative_signatures});
write('basis-signatures.json', {meta: META('Basis Schnorr signature verification vectors (official Basis TV001-TV011)'), vectors: sigs});
write('terms-validation.json', {meta: META('What the real validateTerms()/propose() accept and refuse at the fixture clock (server-only rules; no Python equivalent)'), vectors: valid});
write('transcript.json', transcript);
const count = (xs, f) => xs.reduce((m, x) => ({...m, [f(x)]: (m[f(x)] || 0) + 1}), {});
console.log(JSON.stringify({
  canonical: count(canon, v => v.tier), statements: count(st.vectors, v => v.kind), statement_negatives: st.negative_signatures.length,
  basis_notes: notesV.vectors.length, basis_note_negatives: notesV.negative_signatures.length, basis_signatures: sigs.length, terms_validation: valid.length,
  transcript_steps: JSON.parse(transcript).steps.length, transcript_client_calls: JSON.parse(transcript).steps.filter(s => s.client_call).length,
}, null, 1));
