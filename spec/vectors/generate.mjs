#!/usr/bin/env node
// Conformance vectors for valun-deal/1 (network valun-pilot-1), generated from the REAL server code.
//
//   node spec/vectors/generate.mjs
//
// Written against server release v16 (valun-app commit fa38334, branch circulation-v16; circulating credit, spec
// revision v14). Its server sources are byte-identical to 94797c6's, the commit that makes a same-issuer transfer retry
// wait for the earlier attempt's window and makes no transfer again (audit VS-1); the vectors before it came from
// cfe698b. The script never runs a working tree: by default it exports exactly that commit with `git archive` from the
// valun-app repository next to this one (VALUN_APP_REPO=<path> names another clone) into a temporary folder, runs it,
// and removes the folder at the end. VALUN_APP_DIR=<path> runs an export made by hand instead (README-ci.md). The
// script records the sha256 of every server source it ran (RELEASES below) and labels the output "UNRECOGNISED server
// source" (with a warning) when they are not a known release's. Every assertion below pins that release's behaviour; a
// server change that breaks one stops the script before anything is written.
// Release v13 (6a6a34b) is still recognised: its export gives the v13 vectors (steps 1-147, no circulation.json).
// (Earlier releases: v8 e0b990a, v9 ed1da4a, v11 7880dcf, v12 a61c32e, v13 6a6a34b; the transcript keeps their steps
// first and appends later releases' steps. Steps 1-147 run with circulation off and are byte-identical to v13's.)
//
// Writes, next to this file: canonical.json, statements.json, basis-notes.json, basis-signatures.json,
// terms-validation.json, transcript.json and (v16) circulation.json. Output is deterministic: running it twice gives
// identical files, so a diff after a server change shows exactly what changed on the wire.
//
// What is real and what is a stand-in:
// - canonical(), termsHash(), sha256(), statements.*, circulationStatements.pay, Pilot (validateTerms, propose,
//   counter, accept, decline, withdraw, deliver, noteTemplate, complete, dispute, approvals, mandates, revocation,
//   views; since v16 the circulation modes: bound notes, payment by transfer, consents, set-offs, the edge journal,
//   credit policies, the owner's resolution of an attempt), the clearing engine (lib/pilot/clearing.mjs Clearing) and the
//   HTTP route table (createPilotRoutes) are imported from valun-app/lib and run unchanged, in memory, with a fixed
//   clock. Nothing listens on a port; nothing touches the network or the disk except the output files here (and the
//   temporary export).
// - The server checks Basis signatures and builds Basis note messages in a Rust helper (basis/valun_signer.rs ->
//   basis_core, Basis pinned at 3df7ed93). That helper is NOT run here. This script carries a minimal replica
//   (BLAKE2b-256 per RFC 7693, secp256k1, the Basis Schnorr scheme, the 80-byte note message) and refuses to write
//   anything unless the replica reproduces Basis's official cross-validation vectors TV001-TV011 (copied from
//   hermes-plugin-valun/tests/test_valun_basis.py, which cites basis-tracker specs/SCHNORR_SIGNATURE_SPEC.md; Basis is
//   CC0-1.0). The token-denomination debt key has no official vector; see OPEN-QUESTIONS.md.
// - The Basis tracker is an in-memory stand-in: tracker-side fields in the transcript (tracker_note, proof, ledger rows,
//   positions) have the shapes Valun reads, not necessarily the real tracker's values. From step 148 on it enforces
//   the tracker v3.1 contract Valun relies on (GET /capabilities; POST /notes residues and bound notes with their
//   one-hour maximum age; POST /notes/transfer with seven signatures and both prior acknowledgments; POST /notes/setoff
//   with per-key balance and per-edge timestamps; bound-only edges; unknown fields refused), every signature checked with
//   the replica, and answers with the real tracker's status codes and `code` values (basis_server api.rs). Its binary
//   "sha256" is a fixed fixture value, pinned only for this in-memory Pilot (trackerPins), so the circulation modes can
//   take effect; no real tracker has it.
// - Server-run parties (the sandbox's operator-held agent keys, pilot.serverSigner) are a stand-in signer over public test
//   keys, as the Sandbox installs one: has(id) and signFor(id, messageHex).
// - Signer and tracker failures (OQ-31, OQ-35) are emulated: the transcript's stand-in signer and tracker throw the real
//   BasisError class (imported from valun-app/lib/basis.mjs, which starts nothing on import) with the signer runner's
//   messages and codes: an outage ("signer timed out", code signer_unavailable), input the helper reports as invalid
//   ("signer: ...", code signer_error), a tracker that cannot be reached (code tracker_unavailable). The runner is not run.
// - Errors become responses as lib/http.mjs:96-108 does it (replicated here, since lib/http.mjs serves the whole app;
//   its sha256 is pinned with the other sources).
// - Rate-limit probes (OQ-30) use a second route table over the same Pilot with small budgets and the real clock.
// - The text normalisation clean() is not exported by core.mjs; cleanText() below replicates its normalising part and the
//   script asserts it equals what the real decline()/dispute() code signed over, for every reason vector.
// - The client side of circulating credit (circulation.json consents[], payer_templates[], bound_templates[]) is
//   normative, PROTOCOL.md 15.3: each case is built here to meet or break one rule, from views the real server produced
//   in this run, and states the decision every conforming client must reach ('sign' with the exact slots, or the refusal
//   code). The client records expected after a replayed step (client_state_after) are stated the same way.
//
// Keys: fixed PUBLIC TEST KEYS derived from public labels (TEST_KEY_LABELS). Anyone can sign with them. Never use them
// for anything real. No real secret is generated, read or written. During generation crypto.randomBytes is replaced by
// a seeded generator so participant/approval ids are reproducible; every token, invite code and the admin token that the
// in-memory server produces is replaced by a placeholder (e.g. "<alice.agent>") in transcript.json. Enrollment codes are
// kept (sha256(code) is part of the signed enroll statement); they are fixtures of this in-memory run, valid nowhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- the server release: pinned sources, exported with git archive (never a working tree) -------------------------
// Each release names its valun-app commit and the sha256 of every server source the generator imports (as `git archive`
// writes them: the committed bytes). v13 is kept so its export is still recognised (it has no circulation sources).
const RELEASES = {
  v13: {commit: '6a6a34b', label: 'v13 (valun-app commit 6a6a34b)', sources: {
    'lib/pilot/core.mjs': '7dc469e0547ae0a518c022b93cff6181fd116f4fcc3f8f3b7a3deb0e0f240b2e',
    'lib/pilot/http.mjs': '01a505623d64c0a2c00a221240d57b5631c91dec61f5caaeb37113e8497c0f0e',
    'lib/basis.mjs': '991e37a2319de3731c0ef84ea5847ba428e3575a3c8facd51be1c7cd52891617',
    'lib/http.mjs': '2ef7d0f77a418da7633d5abd5591f2cec39e455e42b953efc401b8f6061c3baf'}},
  v16: {commit: 'fa3833479e91126b07a0ab81d574ca98fbfd0755', label: 'v16 (valun-app commit fa38334)', sources: {
    'lib/pilot/core.mjs': '4d8b5cbd81559c2f0a908108b447b41e9843850868b2edc3903dcccdfe0dfcb2',
    'lib/pilot/http.mjs': '76e9e3603b0f5a3a7e693855c4b8fbc1474ac7be29d3c812a9ea77ebf2cf7dba',
    'lib/basis.mjs': '733953129eb86708e6c3424887cef3c0d32bcdc0cc282d5434286c2cab9d3a96',
    'lib/http.mjs': '2ef7d0f77a418da7633d5abd5591f2cec39e455e42b953efc401b8f6061c3baf',
    'lib/pilot/caps.mjs': 'b64bc079b84d8180aa0025259539eb18a1dc9676b74f6a25b772cc1851ad9596',
    'lib/pilot/clearing.mjs': '457dcf1f21dda3ad9ebeaea18a1b713fd75dcef515cb64222aff5993386fec18',
    'lib/pilot/journal.mjs': '7078357fc4e7b02093ada55f5148122e2c92198329da5ca9a7737d31bf9809a3',
    'lib/pilot/novation.mjs': '02a4f40faf6de079d30a152b861e18fbbc3b1618d17bcc7ea6023383f0530874',
    'lib/pilot/pins.mjs': 'af6525ef61361a49b0644a83dbee516bba687fddf51db821a0d91ede64e4324a',
    'lib/pilot/policy.mjs': 'da7e9fff13fb29408182db4d08a2816fb48463c2685b47b733fdb15c5c169e8f',
    'lib/pilot/sandbox.mjs': '56be7acf50bfeac2cdf81cb76ccb1f8c9827d304a689f23add697bdebdf93f3c',
    'lib/pilot/status.mjs': '9a2d9ae94fe90cca700977c5024e64ead164bc6f167e86b8c83f3495be56286c'}},
};
const CURRENT_RELEASE = 'v16';

// A minimal reader of the tar stream `git archive` writes (ustar, with pax headers for long paths): regular files and
// folders only, every path kept inside `dir`.
function untar(buf, dir) {
  const root = path.resolve(dir);
  let off = 0, paxPath = null;
  const field = (b, o, n) => b.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(x => x === 0)) break;
    const size = parseInt(field(h, 124, 12).trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
    const name = paxPath ?? ((field(h, 345, 155) ? field(h, 345, 155) + '/' : '') + field(h, 0, 100));
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); paxPath = m ? m[1] : null; }
      continue;
    }
    paxPath = null;
    const out = path.resolve(root, name);
    if (out !== root && !out.startsWith(root + path.sep)) throw Error(`git archive: a path outside the export: ${name}`);
    if (type === '5') fs.mkdirSync(out, {recursive: true});
    else if (type === '0' || type === '7') { fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, data); }
  }
}
let EXPORTED = null;   // the temporary export, removed at the end
function exportRelease() {
  const repo = path.resolve(process.env.VALUN_APP_REPO || path.join(here, '..', '..', '..', 'valun-app'));
  const commit = RELEASES[CURRENT_RELEASE].commit;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-vectors-app-'));
  try { untar(execFileSync('git', ['-C', repo, 'archive', '--format=tar', commit], {maxBuffer: 1 << 30}), dir); }
  catch (e) { fs.rmSync(dir, {recursive: true, force: true}); throw Error(`could not export valun-app ${commit} from ${repo} with git archive: ${e.message}`); }
  EXPORTED = dir;
  process.on('exit', () => fs.rmSync(dir, {recursive: true, force: true}));   // also when an assertion stops the run
  return dir;
}
const APP = path.resolve(process.env.VALUN_APP_DIR || exportRelease());
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
const basisModule = await import(pathToFileURL(path.join(APP, 'lib', 'basis.mjs')).href);
const {BasisError} = basisModule;
const {canonical, termsHash, statements, sha256, NETWORK, PROTOCOL, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_MANDATE, Pilot} = core;
// Release v16: the clearing engine (multilateral set-off), run in memory by the transcript (never on a timer here), and
// the server's own ordinary-note clamp (lib/basis.mjs ordinaryTimestamp) and novation timestamp rule (novation.mjs).
const clearingModule = fs.existsSync(path.join(APP, 'lib', 'pilot', 'clearing.mjs')) ? await import(pathToFileURL(path.join(APP, 'lib', 'pilot', 'clearing.mjs')).href) : null;
const novationModule = fs.existsSync(path.join(APP, 'lib', 'pilot', 'novation.mjs')) ? await import(pathToFileURL(path.join(APP, 'lib', 'pilot', 'novation.mjs')).href) : null;

const fileSha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ALL_SOURCES = [...new Set(Object.values(RELEASES).flatMap(r => Object.keys(r.sources)))];
const PRESENT = Object.fromEntries(ALL_SOURCES.filter(f => fs.existsSync(path.join(APP, f))).map(f => [f, fileSha(path.join(APP, f))]));
const RELEASE = Object.entries(RELEASES).sort((a, b) => Object.keys(b[1].sources).length - Object.keys(a[1].sources).length)
  .find(([, r]) => Object.entries(r.sources).every(([f, h]) => PRESENT[f] === h))?.[0] ?? null;
// The sources recorded in every file's meta: the recognised release's own list, else every source found.
const SOURCES = RELEASE ? Object.fromEntries(Object.keys(RELEASES[RELEASE].sources).map(f => [f, PRESENT[f]])) : PRESENT;
// Circulating credit (release v16): the Pilot takes a circulation mode and the tracker's capabilities.
const CIRCULATION = typeof Pilot.prototype.circulationStatus === 'function';
const KNOWN = Object.entries(RELEASES).map(([k, r]) => `${k} ${r.commit.slice(0, 7)}`).join(', ');
const SERVER_RELEASE = RELEASE ? RELEASES[RELEASE].label : `UNRECOGNISED server source (not release ${KNOWN.replace(', ', ' or ')}; see server_source_sha256)`;
if (!RELEASE) console.error(`WARNING: ${APP} is not a known release (${KNOWN}): ${JSON.stringify(SOURCES)}. The vectors are labelled accordingly; assertions may fail.`);
if (!CIRCULATION) console.error(`NOTE: ${APP} has no circulating credit (release ${RELEASE ?? 'unknown'}): transcript steps 148+ and circulation.json are not generated.`);
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
// nina (a client agent) and sam (an agent the server runs, as the sandbox's are) join in release v16's steps (148+).
const TEST_KEY_LABELS = {alice: 'valun-open/spec/test-key/alice', bob: 'valun-open/spec/test-key/bob', carol: 'valun-open/spec/test-key/carol', 'carol-2': 'valun-open/spec/test-key/carol-2',
  nina: 'valun-open/spec/test-key/nina', sam: 'valun-open/spec/test-key/sam'};
const K = Object.fromEntries(Object.entries(TEST_KEY_LABELS).map(([name, label]) => {
  const sk = int(crypto.createHash('sha256').update(label, 'utf8').digest()) % (N - 1n) + 1n;
  return [name, {name, label, sk, pub: pubOf(sk).toString('hex')}];
}));
const signText = (key, text) => schnorrSign(Buffer.from(text, 'utf8'), key.sk).toString('hex');
const signHex = (key, h) => schnorrSign(hx(h), key.sk).toString('hex');
// The keys of release v16's steps are listed only when they are used (an export of v13 gives exactly v13's files).
const keysMeta = Object.fromEntries(Object.values(K).filter(k => CIRCULATION || !['nina', 'sam'].includes(k.name)).map(k => [k.name, {pubkey: k.pub, label: k.label}]));

// Normalising part of core.mjs clean() (lib/pilot/core.mjs:57): control characters except TAB, LF, CR -> space, then
// ECMAScript String.prototype.trim(). Asserted below against the real decline()/dispute() code paths. Since v9 a reason
// containing such a control is refused before clean() runs, so for an accepted reason this is only the trim.
const cleanText = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const FIXTURE_NFT = sha256('valun-open/spec/fixture-tracker-nft-id');   // a fixed public 32-byte id; no tracker has it
// The stand-in tracker v3.1 (transcript steps 148+): its GET /capabilities data, exactly what basis_server v3.1 reports
// (design 3.6 with decision D-1 item 1: bound notes version 2, with the maximum age) except the informative `commit`, and
// the fixed "sha256 of its binary", pinned only for the generator's in-memory Pilot (trackerPins).
const STAND_IN_CAPS = Object.freeze({tracker: 'basis', build: 'valun-circulating-credit/3', commit: 'stand-in (valun-open spec/vectors/generate.mjs)',
  pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 2, max_age_ms: 3600000}, bound_only_edges: true,
  novation: {max_age_ms: 3600000,
    transfer: {ms: 999, version: 3, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient']},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 0, novations_disabled_reason: null});
const STAND_IN_SHA = sha256('valun-open/spec/stand-in-tracker-binary');
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
// Since v16 it is built as the transcript's Pilot is: with the stand-in tracker v3.1's capabilities and pinned fixture sha,
// circulation off unless `circulation` says otherwise (the statement and validation probes run with it off).
function probePilot({verify = 'replica', circulation = 'off'} = {}) {
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
  const pilot = new Pilot({store: {state, save() {}, audit() {}, appendEdgeLog() {}}, basis, now: () => T0,
    ...(CIRCULATION ? {circulation, trackerCaps: STAND_IN_CAPS, trackerSha256: STAND_IN_SHA, trackerPins: [STAND_IN_SHA], log: () => {}} : {})});
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
// circulation.json (release v16): built by transcriptVectors() from what its run produced; written below.
let CIRCULATION_VECTORS = null, CIRCULATION_REDACT = null;
async function transcriptVectors() {
  let now = T0;
  const tick = (s = 60) => { now += s * 1000; };
  // In-memory stand-in for the Basis tracker (no network). Verifies notes with the replica, keeps one note per key pair.
  // signer.mode emulates the signer runner (lib/basis.mjs:23-47): 'ok' answers with the replica; 'outage' throws the
  // runner's BasisError('signer timed out', code signer_unavailable) (a timeout, failed start or no output); 'refuses'
  // throws BasisError('signer: invalid signature encoding', code signer_error) (the helper ran and reported an error,
  // valun_signer.rs:82). tracker.mode 'down' makes note reads throw BasisError(code tracker_unavailable), as the tracker
  // client does when the tracker cannot be reached (lib/basis.mjs, Basis.api).
  const notes = new Map(), verifyLog = [], signer = {mode: 'ok'}, tracker = {mode: 'ok', v3: false, novation: 'ok', applyOnTimeout: false};
  const signerFault = () => {
    if (signer.mode === 'outage') throw new BasisError('signer timed out', {code: 'signer_unavailable'});
    if (signer.mode === 'refuses') throw new BasisError('signer: invalid signature encoding', {code: 'signer_error'});
  };
  const trackerFault = () => { if (tracker.mode === 'down') throw new BasisError('tracker unreachable: ECONNREFUSED', {code: 'tracker_unavailable'}); };
  // ---- tracker v3.1 rules (from step 148; before it the stand-in is exactly the v13 one above) -----------------------
  // The checks and their order are basis_store's (lib.rs: create_note, transfer_note, set_off) and the answers are
  // basis_server's (api.rs: HTTP status, `code`); the error texts are the stand-in's own (Valun never reads them).
  // tracker.v3 switches the rules on; tracker.novation 'timeout' makes the next novation write throw the tracker
  // client's BasisError (no answer: the write may or may not have happened), with tracker.applyOnTimeout deciding which.
  const MAX_AGE = 3600000, I64_MAX = 2n ** 63n - 1n;
  const boundOnly = new Set(), trackerRequests = [];
  const refuse = (status, code, error) => ({status, json: {success: false, error, ...(code ? {code} : {})}, text: ''});
  const noteKey = (i, r) => `${i}>${r}`;
  const msgOf = (i, r, total, ts) => noteMessage(hx(i), hx(r), total, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION);
  const sigOk = (sig, m, pk) => typeof sig === 'string' && /^0[23][0-9a-f]{128}$/.test(sig) && schnorrVerify(hx(sig), m, hx(pk));
  const u64ok = v => Number.isSafeInteger(v) && v >= 0;
  const store3 = (i, r, total, ts, sig, prev) => notes.set(noteKey(i, r), {issuer_pubkey: i, recipient_pubkey: r, amount_collected: total,
    amount_redeemed: prev?.amount_redeemed ?? 0, timestamp: ts, signature: sig, denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}});
  // Fields a request struct allows (deny_unknown_fields): anything else is 422, as axum's Json extractor answers.
  const unknownField = (body, allowed) => Object.keys(body || {}).find(k => !allowed.includes(k));
  const unprocessable = text => ({status: 422, json: null, text});
  function v3Note(body) {
    const {issuer_pubkey: I, recipient_pubkey: R, amount: total, timestamp: ts} = body, key = noteKey(I, R), prev = notes.get(key) ?? null;
    if (!u64ok(total) || !u64ok(ts)) return refuse(400, null, 'amount and timestamp must be whole numbers');
    if (ts > now) return refuse(400, 'future_timestamp', 'timestamp is in the future');
    if (prev && ts <= prev.timestamp) return refuse(400, 'past_timestamp', "timestamp must be newer than the edge's current timestamp");
    if (prev && total < prev.amount_collected) return refuse(400, null, 'a note never lowers the debt');
    if (!sigOk(body.signature, msgOf(I, R, total, ts), I)) return refuse(400, 'invalid_signature', 'Invalid signature');
    const residue = ts % 1000, P = prev?.amount_collected ?? 0;
    if ([995, 996, 998, 999].includes(residue)) return refuse(400, 'reserved_timestamp', `timestamps ending in ${residue} ms are reserved; ordinary notes use 000-994 ms`);
    if (residue === 997) {
      if (body.prior_signature === undefined) return refuse(400, 'reserved_timestamp', 'a bound note needs prior_signature');
      if (ts < now - MAX_AGE) return refuse(400, 'novation_expired', 'the bound note is older than the maximum novation age');
      if (body.prior_total !== undefined && body.prior_total !== P) return refuse(409, 'stale_prior', "prior_total is not the edge's current total");
      if (!sigOk(body.prior_signature, msgOf(I, R, P, ts), I)) return refuse(400, 'invalid_prior_signature', "the issuer's prior acknowledgment does not verify");
      if (!(total > P)) return refuse(400, 'not_an_increase', 'a bound note must raise the total');
    } else {
      if (body.prior_signature !== undefined || body.prior_total !== undefined) return refuse(400, 'invalid_request', 'prior_signature and prior_total belong to bound notes (timestamps ending in 997 ms)');
      if (boundOnly.has(key)) return refuse(400, 'bound_note_required', 'a novation changed this edge: it takes bound notes only');
    }
    store3(I, R, total, ts, body.signature, prev);
    return {status: 201, json: {success: true, data: null}, text: ''};
  }
  const TRANSFER_FIELDS = ['issuer_pubkey', 'from_recipient_pubkey', 'to_recipient_pubkey', 'denomination', 'amount', 'timestamp', 'issuer_from_signature', 'issuer_to_signature',
    'from_recipient_prior_signature', 'from_recipient_signature', 'from_recipient_to_signature', 'to_recipient_prior_signature', 'to_recipient_signature', 'from_prior_total', 'to_prior_total'];
  const TRANSFER_REQUIRED = TRANSFER_FIELDS.filter(k => !k.endsWith('_prior_total'));
  // POST /notes/transfer (version 3): A = issuer, B = old creditor, C = new creditor, a = amount, T = timestamp.
  function v3Transfer(body) {
    const extra = unknownField(body, TRANSFER_FIELDS);
    if (extra) return unprocessable(`Failed to deserialize the JSON body into the target type: unknown field \`${extra}\``);
    const missing = TRANSFER_REQUIRED.find(k => body[k] === undefined);
    if (missing) return unprocessable(`Failed to deserialize the JSON body into the target type: missing field \`${missing}\``);
    const {issuer_pubkey: A, from_recipient_pubkey: B, to_recipient_pubkey: C, amount: a, timestamp: T} = body;
    if (B === C) return refuse(400, 'invalid_transfer', 'Invalid transfer: the old and new creditor must differ');
    if (A === B || A === C) return refuse(400, 'invalid_transfer', 'Invalid transfer: the issuer cannot be a creditor');
    if (!u64ok(a) || a === 0) return refuse(400, 'invalid_transfer', 'Invalid transfer: the amount must be positive');
    if (!u64ok(T) || T % 1000 !== 999) return refuse(400, 'invalid_transfer', 'Invalid transfer: a transfer timestamp ends in 999 ms');
    if (T > now) return refuse(400, 'future_timestamp', 'timestamp is in the future');
    if (T < now - MAX_AGE) return refuse(400, 'novation_expired', "the novation's timestamp is older than the maximum novation age");
    const from = notes.get(noteKey(A, B)) ?? null, to = notes.get(noteKey(A, C)) ?? null;
    if (!from) return refuse(404, 'not_found', 'Note not found');
    const X = from.amount_collected, Y = to?.amount_collected ?? 0;
    if ((body.from_prior_total !== undefined && body.from_prior_total !== X) || (body.to_prior_total !== undefined && body.to_prior_total !== Y))
      return refuse(409, 'stale_prior', "from_prior_total or to_prior_total is not the edge's current total");
    if (X < a) return refuse(400, 'invalid_transfer', 'Invalid transfer: the amount exceeds the from-edge total');
    if (X - a < from.amount_redeemed) return refuse(400, 'invalid_transfer', 'Invalid transfer: below the redeemed amount');
    if (BigInt(Y) + BigInt(a) > I64_MAX) return refuse(400, 'invalid_transfer', 'Invalid transfer: the new to-edge total overflows');
    if (T <= from.timestamp || (to && T <= to.timestamp)) return refuse(400, 'past_timestamp', "timestamp must be newer than both edges' current timestamps");
    const slots = [['issuer_from_signature', A, msgOf(A, B, X - a, T)], ['issuer_to_signature', A, msgOf(A, C, Y + a, T)],
      ['from_recipient_prior_signature', B, msgOf(A, B, X, T)], ['from_recipient_signature', B, msgOf(A, B, X - a, T)], ['from_recipient_to_signature', B, msgOf(A, C, Y + a, T)],
      ['to_recipient_prior_signature', C, msgOf(A, C, Y, T)], ['to_recipient_signature', C, msgOf(A, C, Y + a, T)]];
    for (const [field, signer, m] of slots) if (!sigOk(body[field], m, signer))
      return refuse(400, field.endsWith('prior_signature') ? 'invalid_prior_signature' : 'invalid_signature', `Invalid signature (${field})`);
    store3(A, B, X - a, T, body.issuer_from_signature, from); store3(A, C, Y + a, T, body.issuer_to_signature, to);
    boundOnly.add(noteKey(A, B)); boundOnly.add(noteKey(A, C));
    return {status: 200, json: {success: true, data: {from_new_total: X - a, to_new_total: Y + a, timestamp: T, from_prior_total: X, to_prior_total: Y}}, text: ''};
  }
  const SETOFF_FIELDS = ['denomination', 'timestamp', 'edges'], SETOFF_EDGE_FIELDS = ['issuer_pubkey', 'recipient_pubkey', 'decrease', 'timestamp', 'issuer_signature', 'recipient_signature'];
  // POST /notes/setoff (version 3): every edge I->R lowered by d at its own timestamp ts_e (default: the request's).
  function v3Setoff(body) {
    const extra = unknownField(body, SETOFF_FIELDS) ?? (Array.isArray(body?.edges) ? body.edges.map(e => unknownField(e, SETOFF_EDGE_FIELDS)).find(Boolean) : undefined);
    if (extra) return unprocessable(`Failed to deserialize the JSON body into the target type: unknown field \`${extra}\``);
    if (!Array.isArray(body?.edges) || !u64ok(body.timestamp)) return unprocessable('Failed to deserialize the JSON body into the target type: missing field `edges` or `timestamp`');
    const edges = body.edges.map(e => ({...e, ts: e.timestamp ?? body.timestamp}));
    if (edges.length < 2) return refuse(400, 'invalid_setoff', 'Invalid set-off: a set-off lowers at least two edges');
    if (edges.length > 64) return refuse(400, 'invalid_setoff', 'Invalid set-off: a set-off lowers at most 64 edges');
    for (const e of edges) {
      if (!u64ok(e.ts) || e.ts % 1000 !== 998) return refuse(400, 'invalid_setoff', "Invalid set-off: every edge's timestamp must end in 998 ms");
      if (e.ts > now) return refuse(400, 'future_timestamp', 'timestamp is in the future');
      if (e.ts < now - MAX_AGE) return refuse(400, 'novation_expired', "the novation's timestamp is older than the maximum novation age");
    }
    const seen = new Set();
    for (const e of edges) {
      if (e.issuer_pubkey === e.recipient_pubkey) return refuse(400, 'invalid_setoff', "Invalid set-off: an edge's issuer and creditor must differ");
      if (!u64ok(e.decrease) || e.decrease === 0) return refuse(400, 'invalid_setoff', 'Invalid set-off: every decrease must be positive');
      if (seen.has(noteKey(e.issuer_pubkey, e.recipient_pubkey))) return refuse(400, 'invalid_setoff', 'Invalid set-off: an edge appears more than once');
      seen.add(noteKey(e.issuer_pubkey, e.recipient_pubkey));
    }
    const asCreditor = new Map(), asIssuer = new Map();
    for (const e of edges) {
      asCreditor.set(e.recipient_pubkey, (asCreditor.get(e.recipient_pubkey) ?? 0) + e.decrease);
      asIssuer.set(e.issuer_pubkey, (asIssuer.get(e.issuer_pubkey) ?? 0) + e.decrease);
    }
    for (const k of new Set([...asCreditor.keys(), ...asIssuer.keys()]))
      if ((asCreditor.get(k) ?? 0) !== (asIssuer.get(k) ?? 0)) return refuse(400, 'invalid_setoff', 'Invalid set-off: the decreases do not balance for one participant');
    const plan = [];
    for (const e of edges) {
      const cur = notes.get(noteKey(e.issuer_pubkey, e.recipient_pubkey)) ?? null;
      if (!cur) return refuse(404, 'not_found', 'Note not found');
      if (e.decrease > cur.amount_collected) return refuse(400, 'invalid_setoff', "Invalid set-off: a decrease exceeds the edge's total");
      if (cur.amount_collected - e.decrease < cur.amount_redeemed) return refuse(400, 'invalid_setoff', 'Invalid set-off: below the redeemed amount');
      if (e.ts <= cur.timestamp) return refuse(400, 'past_timestamp', "timestamp must be newer than the edge's current timestamp");
      const m = msgOf(e.issuer_pubkey, e.recipient_pubkey, cur.amount_collected - e.decrease, e.ts);
      if (!sigOk(e.issuer_signature, m, e.issuer_pubkey) || !sigOk(e.recipient_signature, m, e.recipient_pubkey)) return refuse(400, 'invalid_signature', 'Invalid signature');
      plan.push([e, cur]);
    }
    for (const [e, cur] of plan) { store3(e.issuer_pubkey, e.recipient_pubkey, cur.amount_collected - e.decrease, e.ts, e.issuer_signature, cur); boundOnly.add(noteKey(e.issuer_pubkey, e.recipient_pubkey)); }
    return {status: 200, json: {success: true, data: {edges: plan.map(([e, cur]) => ({issuer_pubkey: e.issuer_pubkey, recipient_pubkey: e.recipient_pubkey, new_total: cur.amount_collected - e.decrease, timestamp: e.ts}))}}, text: ''};
  }
  // The tracker client's novation answer (lib/basis.mjs novation()): {status, success, code, error, data}.
  const novationAnswer = r => ({status: r.status, success: r.json?.success === true, code: typeof r.json?.code === 'string' ? r.json.code : null,
    error: r.json ? (r.json.error ?? null) : (r.text ? r.text.slice(0, 300) : null), data: r.json?.data ?? null});
  // The notes a novation request reads (its edges' states before it), for circulation.json.
  const novationBefore = (kind, body) => Object.fromEntries((kind === 'transfer'
    ? [noteKey(body.issuer_pubkey, body.from_recipient_pubkey), noteKey(body.issuer_pubkey, body.to_recipient_pubkey)]
    : (Array.isArray(body?.edges) ? body.edges : []).map(e => noteKey(e.issuer_pubkey, e.recipient_pubkey)))
    .map(k => { const n = notes.get(k); return [k, n ? {total: n.amount_collected, timestamp: n.timestamp, signature: n.signature} : null]; }));
  async function novation(kind, body) {
    trackerFault();
    const run = kind === 'transfer' ? v3Transfer : v3Setoff, before = novationBefore(kind, body), at = now;
    if (tracker.novation === 'timeout') {
      tracker.novation = 'ok';
      const r = tracker.applyOnTimeout ? run(body) : null;
      trackerRequests.push({route: `POST /notes/${kind}`, at, before, request: body, answer: 'none (timeout)', applied: !!(r && r.status < 300)});
      // another write that reaches the tracker before Valun reads the edges back (tracker.onTimeout, once)
      if (tracker.onTimeout) { const f = tracker.onTimeout; tracker.onTimeout = null; f(); }
      throw new BasisError('tracker unreachable: UND_ERR_HEADERS_TIMEOUT', {code: 'tracker_unavailable'});
    }
    const r = run(body);
    trackerRequests.push({route: `POST /notes/${kind}`, at, before, request: body, answer: {status: r.status, ...(r.json ? {json: r.json} : {text: r.text})}});
    return novationAnswer(r);
  }
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
      if (method === 'POST' && p === '/notes' && tracker.v3) {
        const r = v3Note(body);
        trackerRequests.push({route: 'POST /notes', request: body, answer: {status: r.status, json: r.json}});
        return r;
      }
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
    },
    // Tracker v3 (from step 148): GET /capabilities, and the novation writes (lib/basis.mjs transfer() / setoff()).
    async capabilities() { return tracker.v3 ? STAND_IN_CAPS : null; },
    transfer(body) { return novation('transfer', body); },
    setoff(body) { return novation('setoff', body); }};
  const state = {version: 1, network: NETWORK, createdAt: iso(T0), participants: {}, deals: {}, approvals: {}, invites: {}};
  // Since v16 the Pilot is built as server.mjs builds it for a pinned tracker v3: with the tracker's capabilities and its
  // binary's sha256 (the stand-in's fixture value, pinned for this Pilot only). PILOT_CIRCULATION starts off, so steps
  // 1-147 run exactly as before; step 148 switches it on (the operator restarts with PILOT_CIRCULATION=on).
  const auditLog = [], pilotLog = [];
  const store = {state, save() {}, audit(e) { auditLog.push(e); }, appendEdgeLog() {}};
  const pilot = new Pilot({store, basis, now: () => now,
    ...(CIRCULATION ? {circulation: 'off', trackerCaps: STAND_IN_CAPS, trackerSha256: STAND_IN_SHA, trackerPins: [STAND_IN_SHA], log: m => pilotLog.push(m)} : {})});
  const ADMIN = 'TEST-ONLY-admin-token';
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e9}, adminTokenHash: sha256(ADMIN)});
  const redact = new Map([[ADMIN, '<admin_token>']]);
  const tokens = {};

  async function http(method, p, {body, rawBody, auth, admin, bearer, via = routes, ip = '198.51.100.7', features} = {}) {
    const raw = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body);
    const headers = {...(auth ? {authorization: `Bearer ${tokens[auth]}`} : bearer ? {authorization: `Bearer ${bearer}`} : {}), ...(admin ? {'x-valun-admin': ADMIN} : {}),
      ...(raw ? {'content-type': 'application/json'} : {}), ...(features !== undefined ? {'x-valun-features': features} : {})};
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
  // From step 148 on (circ.on) a server_verified entry also names the field of the request body that holds the signature
  // the server verified (field, a JSON pointer, RFC 6901; absent when the signature was not in the body: a stored or
  // server-made one) and, for a Basis note message, the edge it is for (edge '<issuer key>><recipient key>').
  const circ = {on: false, edges: new Map()};
  const pointerTo = (v, sig, ptr = '') => {
    if (v === sig) return ptr;
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      const r = pointerTo(x, sig, `${ptr}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (r !== null) return r;
    }
    return null;
  };
  const edgeOfMessage = mh => {
    if (mh.length !== 160) return null;
    const dk = mh.slice(0, 64);
    if (!circ.edges.has(dk)) for (const a of Object.values(K)) for (const b of Object.values(K)) if (a !== b) circ.edges.set(debtKey(hx(a.pub), hx(b.pub), PILOT_DENOMINATION).toString('hex'), `${a.pub}>${b.pub}`);
    return circ.edges.get(dk) ?? null;
  };
  async function step(label, actor, method, p, {body, rawBody, auth, admin, client_call, reads, expect, extra = {}, features} = {}) {
    const clientReads = {};
    for (const [rp, ra] of reads || []) clientReads[`GET /pilot/v1${rp}`] = await http('GET', rp, {auth: ra, features: ra ? features : undefined});
    const mark = verifyLog.length;
    const response = await http(method, p, {body, rawBody, auth, admin, features});
    if (expect !== undefined) assert.equal(response.status, expect, `${label}: ${JSON.stringify(response.body).slice(0, 400)}`);
    const s = {n: steps.length + 1, label, actor, at: iso(now),
      request: {method, path: '/pilot/v1' + p, headers: {...(auth ? {authorization: `Bearer <${auth}>`} : {}), ...(admin ? {'x-valun-admin': '<admin_token>'} : {}),
        ...(features !== undefined ? {'x-valun-features': features} : {})},
        ...(body !== undefined ? {body} : {}), ...(rawBody !== undefined ? {raw_body: rawBody} : {})},
      ...extra,
      response,
      server_verified: verifyLog.slice(mark).map(e => {
        const where = circ.on ? pointerTo(body, e.signature) : null, edge = circ.on ? edgeOfMessage(e.message_hex) : null;
        return {pubkey: e.pubkey, message_hex: e.message_hex, ...(e.message_hex.length === 160 ? {kind: 'basis_note_message'} : {kind: 'statement', message_text: Buffer.from(e.message_hex, 'hex').toString('utf8')}), signature: e.signature, valid: e.valid,
          ...(e.signer_refused ? {signer_refused: 'the signer reported an error for this input ("signer: ..."); the server counts it as does not verify'} : {}),
          ...(where !== null ? {field: where} : {}), ...(edge ? {edge} : {})};
      }),
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

  // ==== CIRCULATION BEGIN ============================================================================================
  // Release v16 (valun-app fa38334): circulating credit, appended after every earlier release's steps and after the
  // probes (steps 148+). The operator restarts with PILOT_CIRCULATION=on on the pinned tracker v3.1 (here: the
  // stand-in switches its v3.1 rules on and the Pilot's mode becomes on); every request below that an agent's client
  // makes carries the capability header its consent policy gives (X-Valun-Features, PROTOCOL.md 18.1).
  const circulation = {first_step: null, consent_items: {}, templates: {}, notes: {}, transfers: {}, setoffs: {}, tracker: trackerRequests, pilot_log: pilotLog};
  if (CIRCULATION) {
    pilot.circulation = 'on'; tracker.v3 = true; circ.on = true;
    assert.equal(pilot.mode, 'on', `the in-memory Pilot did not take mode on: ${JSON.stringify(pilot.circulationStatus())}`);
    circulation.first_step = steps.length + 1;
    const FEAT = 'consents/1;roles=setoff,issuer,creditor';
    const PINS = {tracker_nft_id: FIXTURE_NFT, denomination: PILOT_DENOMINATION};
    const POLICY_ALL = {setoff: true, as_issuer: true, as_new_creditor: true, max_PC: 50, accept_issuers: 'any', refuse_issuers: []};
    const MANDATE_ON = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', pay_with_held_notes: 'when_asked'};
    const edgeK = (a, b) => `${P[a].key.pub}>${P[b].key.pub}`;
    const msgHex = (i, r, total, ts) => noteMessage(hx(P[i].key.pub), hx(P[r].key.pub), total, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex');
    // VALUN_VECTORS_DEBUG=1: when a step of this part fails, its steps so far and the server's log lines go to debug-steps.json.
    const sdump = () => { if (process.env.VALUN_VECTORS_DEBUG) fs.writeFileSync(path.join(OUT, 'debug-steps.json'), JSON.stringify({steps: steps.slice(circulation.first_step - 1), pilot_log: pilotLog}, null, 1)); };
    try {
      const info16 = await step('public: network info with circulating credit on (since v16: features bound_notes/1 and circulation/1, the novation constants and the pay statement)', 'anyone', 'GET', '/info',
        {expect: 200, extra: {server_config: {PILOT_CIRCULATION: 'on', tracker: 'stand-in tracker v3.1 (GET /capabilities validates; its binary sha256 is pinned for this Pilot)', capabilities: STAND_IN_CAPS}}});
      assert.deepEqual(info16.features, ['bound_notes/1', 'circulation/1']);

      // ---- two new participants: nina (a client agent) and sam (an agent the server runs; its consents are signed at once) ----
      for (const [name, op] of [['nina', 'Spec test operator N'], ['sam', 'Spec test operator S (runs the agent on the server)']]) {
        const inv = await step(`operator creates an invite for ${name}`, 'operator', 'POST', '/admin/invites', {admin: true, body: {note: `for ${name}`, max_uses: 1, ttl_days: 14}, expect: 201});
        redact.set(inv.code, `<invite_code:${name}>`);
        const j = await step(`${name}'s owner joins with the invite`, `${name}.owner`, 'POST', '/join', {body: {invite: inv.code, handle: name, display_name: `${name[0].toUpperCase()}${name.slice(1)} (spec test)`, operator: op,
          about: `${name}: a test participant of the specification transcript`, services: name === 'nina' ? 'glossaries' : 'summaries'}, expect: 201});
        tokens[`${name}.owner`] = j.owner_token; redact.set(j.owner_token, `<${name}.owner>`);
        P[name] = {id: j.participant_id, key: K[name], code: j.enrollment_code};
        const x = P[name], stmt = statements.enroll(x.id, x.key.pub, sha256(x.code));
        const e = await step(`${name}'s agent enrolls its locally generated key (proof of possession)`, `${name}.agent`, 'POST', '/enroll', {body: {participant_id: x.id, code: x.code, pubkey: x.key.pub, signature: signText(x.key, stmt)},
          client_call: {method: 'enroll', key: name, args: {participant_id: x.id, code: x.code}}, expect: 201});
        tokens[`${name}.agent`] = e.agent_token; redact.set(e.agent_token, `<${name}.agent>`);
      }
      // sam's agent runs on the server (as the sandbox's agents do): pilot.serverSigner signs its consent slots.
      pilot.serverSigner = {has: id => id === P.sam.id, async signFor(id, messageHex) { assert.equal(id, P.sam.id); return signHex(K.sam, messageHex); }};

      // ---- owners opt in to circulating credit (participants who joined before start with every new permission off) ----
      const limits16 = {approve_above: 100, max_issue_per_deal: 100, max_issue_outstanding: 300, max_accept_per_deal: 100, max_accept_per_issuer: 200};
      await step("alice's owner turns circulating credit on in the mandate (auto_clear, novate_own_debt, accept_transfers, accept_notes_from any, pay_with_held_notes when_asked; since v16)",
        'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200, body: MANDATE_ON});
      await step("bob's owner turns circulating credit on in the mandate", 'bob.owner', 'PUT', '/owner/mandate', {auth: 'bob.owner', expect: 200, body: MANDATE_ON});
      await step("nina's owner sets the mandate: set-offs and own bound notes, but no payments by transfer yet (accept_transfers false)", 'nina.owner', 'PUT', '/owner/mandate',
        {auth: 'nina.owner', expect: 200, body: {objective: 'Sell glossaries.', ...limits16, auto_clear: true, novate_own_debt: true, accept_transfers: false, pay_with_held_notes: 'when_asked'}});
      await step("sam's owner sets the mandate with circulating credit on", 'sam.owner', 'PUT', '/owner/mandate', {auth: 'sam.owner', expect: 200, body: {objective: 'Sell summaries.', ...limits16, ...MANDATE_ON}});
      for (const name of ['alice', 'bob', 'nina']) {
        const me = await step(`${name}'s agent: who am I, with the capability header ${FEAT} (the roles its client signs by itself; since v16)`, `${name}.agent`, 'GET', '/me', {auth: `${name}.agent`, features: FEAT, expect: 200});
        assert.deepEqual(me.features?.consent_roles, ['setoff', 'issuer', 'creditor'], JSON.stringify(me.features));
      }
      { const n = notes.get(edgeK('alice', 'bob')); circulation.notes.alice_bob_flowL = {total: n.amount_collected, timestamp: n.timestamp, signature: n.signature}; }
      // ---- reference client of release v16 (mirrors the valun 0.4 package: every message rebuilt here, rule R1) ----
      const svc16 = (title, description, deliverable = 'plain text') => ({title, description, deliverable});
      // The capability header each agent's client sends (its consent policy's roles); undefined: none.
      const featuresOf = {alice: FEAT, bob: FEAT, nina: FEAT, sam: FEAT};
      const hdr = name => Object.hasOwn(featuresOf, name) ? featuresOf[name] : FEAT;
      async function propose16(name, otherName, role, svc, price, label) {
        const me = P[name], other = P[otherName], dealId = nextDeal(), nonce = nextNonce();
        const t = terms({me, other, role, ...svc, price, dealId, nonce}), h = termsHash(t);
        const v = await step(label, agentOf(name), 'POST', '/deals', {auth: agentOf(name), features: hdr(name), expect: 201, body: {terms: t, terms_hash: h, signature: signText(me.key, statements.propose(h))}});
        return v.id ?? dealId;
      }
      async function accept16(name, id, label) {
        const d = await dealView(name, id), h = d.current.terms_hash;
        return step(label, agentOf(name), 'POST', `/deals/${id}/accept`, {auth: agentOf(name), features: hdr(name), expect: 200, body: {terms_hash: h, signature: signText(P[name].key, statements.accept(h))}});
      }
      async function deliver16(name, id, content, title, label) {
        const d = await dealView(name, id), h = d.agreement.terms_hash, dh = sha256(content);
        return step(label, agentOf(name), 'POST', `/deals/${id}/deliver`, {auth: agentOf(name), features: hdr(name), expect: 200,
          body: {terms_hash: h, content, title, sha256: dh, signature: signText(P[name].key, statements.deliver(h, dh))}});
      }
      // A deal from proposal to delivery: `payer` proposes, `payee` accepts and delivers.
      async function dealToDelivery(payer, payee, svc, price, content, tag) {
        const id = await propose16(payer, payee, 'payer', svc, price, `${tag}: ${payer} proposes ${price} PC for '${svc.title}' to ${payee}`);
        await accept16(payee, id, `${tag}: ${payee} accepts`);
        await deliver16(payee, id, content, svc.title, `${tag}: ${payee} delivers`);
        return id;
      }
      // Q = valun-transfer-quote/1 and its digest (PROTOCOL.md 18.3), built here from checked values.
      const quoteOf = (d, A, B, C, a) => ({kind: 'valun-transfer-quote/1', network: NETWORK, tracker_nft_id: d.current.terms.tracker_nft_id, denomination: d.current.terms.denomination,
        deal_id: d.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, issuer_pubkey: A, payer_pubkey: B, payee_pubkey: C, amount: a});
      const digestOf = Q => sha256(canonical(Q));
      const payStatement = (dealId, q) => `valun-pilot/pay/1\n${dealId}\n${q}`;
      // The payer's request body for a payment by transfer (the valun package's order of fields), from a template it
      // checked: the five signatures of B over the complete statement, the pay statement and its three slots.
      function payBody(name, d, tpl, {sign = (slot, m) => signHex(P[name].key, m), quote} = {}) {
        const A = tpl.issuer.pubkey, B = tpl.payer.pubkey, C = tpl.payee.pubkey, a = tpl.amount, T = tpl.timestamp;
        const X = tpl.from_edge.before.total, Y = tpl.to_edge.before ? tpl.to_edge.before.total : 0;
        assert.equal(B, P[name].key.pub); assert.equal(T % 1000, 999); assert.equal(tpl.from_edge.new_total, X - a); assert.equal(tpl.to_edge.new_total, Y + a);
        const q = quote ?? digestOf(quoteOf(d, A, B, C, a));
        if (!quote) assert.equal(q, tpl.quote_digest, 'quote digest: the reference recomputation vs the template');
        const h = d.agreement.terms_hash, dh = d.delivery.sha256;
        const slots = [[`${A}>${B}:prior`, noteMessage(hx(A), hx(B), X, T, hx(FIXTURE_NFT), PILOT_DENOMINATION)], [`${A}>${B}:new`, noteMessage(hx(A), hx(B), X - a, T, hx(FIXTURE_NFT), PILOT_DENOMINATION)],
          [`${A}>${C}:new`, noteMessage(hx(A), hx(C), Y + a, T, hx(FIXTURE_NFT), PILOT_DENOMINATION)]];
        return {issuer_id: tpl.issuer.id, terms_hash: h, deliverable_sha256: dh, quote_digest: q, timestamp: T, from_prior_total: X, to_prior_total: Y,
          completion_signature: signText(P[name].key, statements.complete(h, dh)), pay_signature: signText(P[name].key, payStatement(d.id, q)),
          signatures: Object.fromEntries(slots.map(([slot, m]) => [slot, sign(slot, m.toString('hex'))]))};
      }
      // The JSON pointers of every signature in a request body (client_call.signature_fields).
      const sigFields = (v, ptr = '') => v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => {
        const q = `${ptr}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
        return typeof x === 'string' && (k === 'signature' || k.endsWith('_signature') || ptr.endsWith('/signatures')) ? [q] : sigFields(x, q);
      }) : [];
      const transferTemplate = async (name, id, issuer) => (await http('GET', `/deals/${id}/transfer-template?issuer=${P[issuer].id}`, {auth: agentOf(name), features: FEAT})).body;
      // The consent item `name` sees for id (GET /consents), and the body that signs its unsigned slots (R1: each
      // message from the item's own edges: prior = before.total, new = new_total).
      const consentItem = async (name, id) => (await http('GET', '/consents', {auth: agentOf(name), features: FEAT})).body.consents.find(c => c.id === id);
      function consentBody(name, item) {
        const signatures = {}, revisions = {};
        for (const e of item.edges) {
          const [I, R] = e.edge.split('>');
          for (const slot of e.slots) {
            if (e.signed_by_you.includes(slot)) continue;
            const total = slot === 'prior' ? (e.before?.total ?? 0) : e.new_total;
            signatures[`${e.edge}:${slot}`] = signHex(P[name].key, noteMessage(hx(I), hx(R), total, e.timestamp, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex'));
          }
          revisions[e.edge] = e.revision;
        }
        return {signatures, revisions};
      }

      // ---- payment by debt transfer, client parties only: bob pays nina with part of alice's note (A = alice, B = bob, C = nina) ----
      const N1 = await dealToDelivery('bob', 'nina', svc16('Glossary of credit terms', 'Twenty terms with one-line definitions.'), 10,
        'Glossary: twenty terms, one line each.', 'flow T (v16)');
      await step("flow T: bob's payment options: his own note, or alice's note he holds (held, spendable, payee_accepts, consent speeds; since v16)", 'bob.agent', 'GET',
        `/deals/${N1}/payment-options`, {auth: 'bob.agent', features: FEAT, expect: 200});
      await step("flow T: a policy refusal: nina's owner does not accept payments by transfer, so the transfer template is 403 payment_not_accepted (rule, by payee; since v16)", 'bob.agent', 'GET',
        `/deals/${N1}/transfer-template?issuer=${P.alice.id}`, {auth: 'bob.agent', features: FEAT, expect: 403});
      await step("flow T: nina's owner accepts payments by transfer, with notes from any issuer", 'nina.owner', 'PUT', '/owner/mandate',
        {auth: 'nina.owner', expect: 200, body: {accept_transfers: true, accept_notes_from: 'any'}});
      {
        const d = await dealView('bob', N1), tpl = await transferTemplate('bob', N1, 'alice');
        circulation.templates.transfer_N1 = {tpl, now_ms: now};
        const body = payBody('bob', d, tpl);
        const r = await step("flow T: bob accepts nina's delivery and pays by transfer with 10 PC of alice's note: five signatures (complete, pay, A>B:prior, A>B:new, A>C:new); the transfer collects alice's and nina's",
          'bob.agent', 'POST', `/deals/${N1}/pay-by-transfer`, {auth: 'bob.agent', features: FEAT, expect: 200, body,
            reads: [[`/deals/${N1}`, 'bob.agent'], ['/info'], [`/participants/${P.nina.id}`], [`/deals/${N1}/payment-options`, 'bob.agent'], [`/participants/${P.alice.id}`], ['/me', 'bob.agent'],
              [`/deals/${N1}/transfer-template?issuer=${P.alice.id}`, 'bob.agent']],
            client_call: {method: 'pay_by_transfer', key: 'bob', feature: 'circulation/1', args: {deal_id: N1, issuer: P.alice.id, expected_deliverable_sha256: d.delivery.sha256},
              client_state: {pins: PINS, consent_policy: POLICY_ALL}, signature_fields: sigFields(body), client_state_after: {}}});
        assert.equal(r.status, 'paying_by_transfer', JSON.stringify(r).slice(0, 300));
        circulation.transfers.T1 = r.transfer?.id ?? r.payment?.transfer_id;
      }
      {
        const vt = circulation.transfers.T1;
        const ia = await step('flow T: alice (the issuer) reads her consents: her two slots on this transfer, never the deal', 'alice.agent', 'GET', '/consents', {auth: 'alice.agent', features: FEAT, expect: 200});
        const itemA = ia.consents.find(c => c.id === vt);
        circulation.consent_items.issuer_T1 = {item: itemA, now_ms: now - 60e3};
        const bodyA = consentBody('alice', itemA);
        await step('flow T: alice signs her issuer slots (A>B:new, A>C:new) after her client checked them', 'alice.agent', 'POST', `/consents/${vt}`,
          {auth: 'alice.agent', features: FEAT, expect: 200, body: bodyA, reads: [['/info'], ['/consents', 'alice.agent'], ['/me', 'alice.agent']],
            client_call: {method: 'process_consents', key: 'alice', feature: 'circulation/1', args: {}, client_state: {pins: PINS, consent_policy: POLICY_ALL},
              signature_fields: sigFields(bodyA), client_state_after: {}}});
        const ic = await step('flow T: nina (the payee, new creditor) reads her consents: her edge A>C and the deal', 'nina.agent', 'GET', '/consents', {auth: 'nina.agent', features: FEAT, expect: 200});
        const itemC = ic.consents.find(c => c.id === vt);
        circulation.consent_items.payee_T1 = {item: itemC, now_ms: now - 60e3};
        const bodyC = consentBody('nina', itemC);
        const done = await step("flow T: nina signs her payee slots (A>C:prior, A>C:new): the last signature applies the transfer on the tracker (read back: applied)", 'nina.agent', 'POST', `/consents/${vt}`,
          {auth: 'nina.agent', features: FEAT, expect: 200, body: bodyC, reads: [['/info'], ['/consents', 'nina.agent'], ['/me', 'nina.agent'], [`/deals/${N1}`, 'nina.agent'], ['/participants']],
            client_call: {method: 'process_consents', key: 'nina', feature: 'circulation/1', args: {}, client_state: {pins: PINS, consent_policy: POLICY_ALL},
              signature_fields: sigFields(bodyC), client_state_after: {}}});
        assert.equal(done.state, 'applied', JSON.stringify(done).slice(0, 400));
        const dv = await step('flow T: bob reads the deal: paid_by_transfer', 'bob.agent', 'GET', `/deals/${N1}`, {auth: 'bob.agent', features: FEAT, expect: 200});
        assert.equal(dv.status, 'paid_by_transfer');
        await step("flow T: bob's receipt: GET /transfers/{vt} with the signatures on his edge", 'bob.agent', 'GET', `/transfers/${vt}`, {auth: 'bob.agent', features: FEAT, expect: 200});
      }
      // ---- expected client records (client_state_after, PROTOCOL.md 15.3 R4 and R9; design 6.1): helpers ----
      const xSigned = (T, slots) => { const out = {}; for (const [edge, slot, total] of slots) ((out[edge] ??= {})[String(T)] ??= {slots: {}}).slots[`${edge}:${slot}`] = total; return out; };
      const xPending = rows => { const out = {}; for (const [edge, total, ts, kind, ref, direction] of rows) (out[edge] ??= {pending: []}).pending.push({total, timestamp: ts, kind, ref, direction}); return out; };
      const merge = (...xs) => { const out = {}; for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = out[k] && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v; return out; };
      const edgeState = (a, b) => { const n = notes.get(edgeK(a, b)); return n ? {total: n.amount_collected, timestamp: n.timestamp, signature: n.signature} : null; };
      // Bound credit note (PROTOCOL.md 18.5): the payer signs M(B,C,P+a,T) and its prior acknowledgment M(B,C,P,T), T
      // ending in 997, from the template asked for with ?prior=1&bound=1 (values checked here, messages rebuilt).
      async function completeBound(name, payeeName, id, label, {expect = 200, client_state, client_state_after, extraReads = [], features = FEAT, mutate} = {}) {
        const d = await dealView(name, id);
        const tpl = (await http('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, {auth: agentOf(name), features})).body;
        const I = P[name].key.pub, R = P[payeeName].key.pub, h = d.agreement.terms_hash, dh = d.delivery.sha256;
        assert.equal(tpl.timestamp % 1000, 997, JSON.stringify(tpl).slice(0, 200)); assert.equal(tpl.issuer_pubkey, I); assert.equal(tpl.recipient_pubkey, R);
        assert.equal(tpl.prior_message_hex, msgHex(name, payeeName, tpl.prior_total, tpl.timestamp)); assert.equal(tpl.message_hex, msgHex(name, payeeName, tpl.total, tpl.timestamp));
        const body = {terms_hash: h, deliverable_sha256: dh, signature: signText(P[name].key, statements.complete(h, dh)),
          credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: signHex(P[name].key, tpl.message_hex), prior_total: tpl.prior_total, prior_signature: signHex(P[name].key, tpl.prior_message_hex)}};
        if (mutate) mutate(body, tpl);
        const out = await step(label, agentOf(name), 'POST', `/deals/${id}/complete`, {auth: agentOf(name), features, expect, body,
          reads: [[`/deals/${id}`, agentOf(name)], ['/info'], [`/deals/${id}/credit-note-template?prior=1&bound=1`, agentOf(name)], [`/participants/${P[payeeName].id}`], ...extraReads],
          ...(client_state ? {client_call: {method: 'complete', key: name, feature: 'circulation/1', args: {deal_id: id, expected_deliverable_sha256: dh},
            client_state, signature_fields: sigFields(body), ...(client_state_after ? {client_state_after: client_state_after(tpl)} : {})}} : {})});
        return {out, tpl, body};
      }

      // ---- a completion after a novation, without ledger_mismatch: alice pays bob with a bound note on the edge the transfer lowered ----
      {
        const C2 = await dealToDelivery('alice', 'bob', svc16('Two-source check', 'Check two claims against their sources.'), 5, 'Checked: both claims hold.', 'flow U (v16)');
        const T1 = circulation.templates.transfer_N1.tpl.timestamp, vt = circulation.transfers.T1;
        const ab = edgeK('alice', 'bob'), an = edgeK('alice', 'nina');
        // alice's client records: her note of flow L (69 PC, confirmed) and her consent to transfer T1 (pending)
        const before = {pins: PINS, consent_policy: POLICY_ALL,
          records: {[ab]: {confirmed: circulation.notes.alice_bob_flowL, pending: [{total: 59, timestamp: T1, kind: 'transfer', ref: vt, direction: 'out', signed_at: iso(now - 20 * 60e3)}]},
            [an]: {confirmed: null, pending: [{total: 10, timestamp: T1, kind: 'transfer', ref: vt, direction: 'out', signed_at: iso(now - 20 * 60e3)}]}},
          signed: xSigned(T1, [[ab, 'new', 59], [an, 'new', 10]])};
        const {out, tpl} = await completeBound('alice', 'bob', C2,
          "flow U: alice accepts bob's delivery and pays with a BOUND note (timestamp ending in 997, with her prior acknowledgment of the edge the transfer lowered to 59): note_issued, no ledger_mismatch",
          {client_state: before, client_state_after: t => ({records: {[ab]: {confirmed: {total: t.total, timestamp: t.timestamp}}, paid_deals: {[C2]: {route: 'note', edge: ab, total: t.total, timestamp: t.timestamp}}},
            signed: xSigned(t.timestamp, [[ab, 'prior', t.prior_total], [ab, 'new', t.total]]),
            transfer_attempts: {[C2]: [{route: 'note', edge: ab, prior: t.prior_total, prior_timestamp: t.prior_note.timestamp, total: t.total, timestamp: t.timestamp}]}})});
        assert.equal(out.status, 'note_issued', JSON.stringify(out).slice(0, 300));
        assert.equal(tpl.prior_total, 59); assert.equal(tpl.prior_note.timestamp, T1);
        circulation.templates.bound_C2 = {tpl, now_ms: now - 60e3};
      }
      // ---- set-off (multilateral clearing, here a cycle of two): nina owes alice, alice owes nina ----
      {
        const na = edgeK('nina', 'alice'), an = edgeK('alice', 'nina');
        const N2 = await dealToDelivery('nina', 'alice', svc16('Source list', 'Five sources on credit clearing.'), 4, 'Sources: five, with links.', 'flow V (v16)');
        const {out: o2, tpl: t2} = await completeBound('nina', 'alice', N2, "flow V: nina pays alice with a bound note on a new edge (prior total 0, no prior note): note_issued",
          {client_state: {pins: PINS, consent_policy: POLICY_ALL}, client_state_after: t => ({records: {[na]: {confirmed: {total: t.total, timestamp: t.timestamp}}, paid_deals: {[N2]: {route: 'note', edge: na, total: t.total, timestamp: t.timestamp}}},
            signed: xSigned(t.timestamp, [[na, 'prior', 0], [na, 'new', t.total]]), transfer_attempts: {[N2]: [{route: 'note', edge: na, prior: 0, prior_timestamp: 0, total: t.total, timestamp: t.timestamp}]}})});
        assert.equal(o2.status, 'note_issued'); assert.equal(t2.prior_note, null);
        circulation.templates.bound_N2 = {tpl: t2, now_ms: now - 60e3};
        // The clearing engine (lib/pilot/clearing.mjs), as server.mjs starts it, except that it never runs on a timer here:
        // it proposes when a member's agent reads its consents (presence) or the operator asks (POST /admin/clearing/run).
        pilot.clearing = new clearingModule.Clearing({pilot, log: m => pilotLog.push(m)});
        pilot.clearing.later = () => null;
        await step("flow V: nina's owner reviews deliveries before her notes are issued (review_deliveries: a completion waits for the owner, its note held)", 'nina.owner', 'PUT', '/owner/mandate',
          {auth: 'nina.owner', expect: 200, body: {review_deliveries: true}});
        const c1 = await step("flow V: nina's agent reads its consents: the clearing engine finds the cycle alice -> nina -> alice and proposes a set-off of 4 PC (each member signs its own edges; since v16)",
          'nina.agent', 'GET', '/consents', {auth: 'nina.agent', features: FEAT, expect: 200});
        const S1 = c1.consents.find(c => c.kind === 'setoff');
        assert.ok(S1, `no set-off proposed: ${JSON.stringify(c1).slice(0, 300)} ${JSON.stringify(pilot.clearing.lastRun)}`);
        circulation.setoffs.S1 = S1.id; circulation.consent_items.member_S1_nina = {item: S1, now_ms: now - 60e3};
        const a1 = await step('flow V: alice reads her consents: the same set-off, her two edges', 'alice.agent', 'GET', '/consents', {auth: 'alice.agent', features: FEAT, expect: 200});
        const S1a = a1.consents.find(c => c.id === S1.id);
        circulation.consent_items.member_S1_alice = {item: S1a, now_ms: now - 60e3};
        const bA = consentBody('alice', S1a);
        await step('flow V: alice signs her slots of the set-off (net change 0 for her: as much off her claims as off her debts)', 'alice.agent', 'POST', `/consents/${S1.id}`,
          {auth: 'alice.agent', features: FEAT, expect: 200, body: bA, reads: [['/info'], ['/consents', 'alice.agent'], ['/me', 'alice.agent']],
            client_call: {method: 'process_consents', key: 'alice', feature: 'circulation/1', args: {}, client_state: {pins: PINS, consent_policy: POLICY_ALL}, signature_fields: sigFields(bA),
              client_state_after: {signed: xSigned(S1a.edges[0].timestamp === S1a.edges[1].timestamp ? S1a.edges[0].timestamp : 0, []), records: xPending(S1a.edges.map(e => [e.edge, e.new_total, e.timestamp, 'setoff', S1.id, e.your_role === 'issuer' ? 'out' : 'in']))}}});
        // decision D-2 c: a held note on a pair of a collecting set-off supersedes it (held_note); none is proposed while it waits
        const N3 = await dealToDelivery('nina', 'alice', svc16('Short summary', 'One paragraph on set-off.'), 2, 'Set-off cancels equal opposite debts.', 'flow V (v16)');
        const {out: o3} = await completeBound('nina', 'alice', N3, "flow V: nina accepts a second delivery from alice; her owner reviews deliveries, so the bound note is HELD (completion_awaiting_owner): the collecting set-off on that pair is superseded (held_note, decision D-2 c)");
        assert.equal(o3.status, 'completion_awaiting_owner', JSON.stringify(o3).slice(0, 300));
        const c2 = await step('flow V: nina reads her consents: the set-off was superseded (held_note), and no new one is proposed while her note is held', 'nina.agent', 'GET', '/consents',
          {auth: 'nina.agent', features: FEAT, expect: 200});
        assert.ok(c2.recently_resolved.some(x => x.id === S1.id && x.state === 'superseded'), JSON.stringify(c2).slice(0, 400));
        assert.ok(!c2.consents.some(c => c.kind === 'setoff'), 'a set-off was proposed while the note is held');
        await step('flow V: the set-off as its member sees it: superseded with code held_note', 'nina.agent', 'GET', `/setoffs/${S1.id}`, {auth: 'nina.agent', features: FEAT, expect: 200});
        const ap = Object.values(state.approvals).find(a => a.deal_id === N3 && a.state === 'pending');
        assert.ok(ap, 'no pending approval for the held note');
        await step("flow V: nina's owner approves the held completion: the bound note is recorded (nina -> alice now 6)", 'nina.owner', 'POST', `/owner/approvals/${ap.id}`,
          {auth: 'nina.owner', expect: 200, body: {decision: 'approve'}});
        await step("flow V: nina's owner stops reviewing deliveries", 'nina.owner', 'PUT', '/owner/mandate', {auth: 'nina.owner', expect: 200, body: {review_deliveries: false}});
        tick(60);
        const c3 = await step('flow V: nina reads her consents: a new set-off of 6 PC (alice -> nina 10 and nina -> alice 6 each fall by 6)', 'nina.agent', 'GET', '/consents',
          {auth: 'nina.agent', features: FEAT, expect: 200});
        const S2 = c3.consents.find(c => c.kind === 'setoff');
        assert.ok(S2, `no second set-off: ${JSON.stringify(c3).slice(0, 300)}`);
        circulation.setoffs.S2 = S2.id; circulation.consent_items.member_S2_nina = {item: S2, now_ms: now - 60e3};
        const bN = consentBody('nina', S2);
        await step('flow V: nina signs her slots of the set-off', 'nina.agent', 'POST', `/consents/${S2.id}`,
          {auth: 'nina.agent', features: FEAT, expect: 200, body: bN, reads: [['/info'], ['/consents', 'nina.agent'], ['/me', 'nina.agent']],
            client_call: {method: 'process_consents', key: 'nina', feature: 'circulation/1', args: {}, client_state: {pins: PINS, consent_policy: POLICY_ALL}, signature_fields: sigFields(bN),
              client_state_after: {records: xPending(S2.edges.map(e => [e.edge, e.new_total, e.timestamp, 'setoff', S2.id, e.your_role === 'issuer' ? 'out' : 'in']))}}});
        const S2a = await consentItem('alice', S2.id);
        circulation.consent_items.member_S2_alice = {item: S2a, now_ms: now};
        const done = await step('flow V: alice signs hers: the last signature applies the set-off on the tracker (both edges lowered by 6, each at its own timestamp ending in 998)', 'alice.agent', 'POST', `/consents/${S2.id}`,
          {auth: 'alice.agent', features: FEAT, expect: 200, body: consentBody('alice', S2a)});
        assert.equal(done.state, 'applied', JSON.stringify(done).slice(0, 400));
        await step("flow V: alice's receipt: GET /setoffs/{vs} with the signatures on her edges", 'alice.agent', 'GET', `/setoffs/${S2.id}`, {auth: 'alice.agent', features: FEAT, expect: 200});
        await step('public: GET /clearing: aggregates only (PC cleared by set-off; no participant ids, handles or keys; since v16)', 'anyone', 'GET', '/clearing', {expect: 200});
        assert.equal(edgeState('nina', 'alice').total, 0); assert.equal(edgeState('alice', 'nina').total, 4);
      }
      // ---- decision D-2 b and D-1 item 2: a payment refused when posted is still an attempt; every other payment waits for its window ----
      {
        const ab = edgeK('alice', 'bob'), an = edgeK('alice', 'nina'), bn = edgeK('bob', 'nina');
        const X1 = await dealToDelivery('bob', 'nina', svc16('Term check', 'Check one term against two glossaries.'), 2, 'The term matches both glossaries.', 'flow W (v16)');
        const d = await dealView('bob', X1), tpl = await transferTemplate('bob', X1, 'alice');
        const body = payBody('bob', d, tpl);
        tick(11 * 60);   // a slow client: the template's timestamp is now more than 10 minutes old
        const st = await step("flow W: bob's client posts a payment by transfer signed over a template 11 minutes old: 409 transfer_stale; the server keeps the refused attempt (decision D-2 b), so the answer's template is null: a new transfer, through the same issuer too, waits for that attempt's window (audit VS-1)",
          'bob.agent', 'POST', `/deals/${X1}/pay-by-transfer`, {auth: 'bob.agent', features: FEAT, expect: 409, body});
        assert.equal(st.error, 'transfer_stale');
        assert.equal(st.template, null, JSON.stringify(st).slice(0, 300));
        const T = tpl.timestamp, X = tpl.from_edge.before.total, attemptRec = {deal_id: X1, route: 'transfer', edge: ab, prior: X, prior_timestamp: tpl.from_edge.before.timestamp,
          prior_signature: tpl.from_edge.before.signature, total: X - 2, timestamp: T, quote_digest: tpl.quote_digest, signed_at: iso(now - 12 * 60e3)};
        const bobBefore = {pins: PINS, consent_policy: POLICY_ALL, transfer_attempts: {[X1]: [attemptRec]}, signed: xSigned(T, [[ab, 'prior', X], [ab, 'new', X - 2], [edgeK('alice', 'nina'), 'new', (edgeState('alice', 'nina')?.total ?? 0) + 2]])};
        // the server (D-1 across kinds) and bob's own client (R11) refuse his own note until the window has passed
        const w = await step("flow W: bob tries to pay with his own bound note instead: the template is 409 transfer_window_open (retry_after_ms) until T + 1 h + 60 s (decision D-1 across kinds); nothing is signed",
          'bob.agent', 'GET', `/deals/${X1}/credit-note-template?prior=1&bound=1`, {auth: 'bob.agent', features: FEAT, expect: 409, reads: [[`/deals/${X1}`, 'bob.agent'], ['/info']],
            client_call: {method: 'complete', key: 'bob', feature: 'circulation/1', args: {deal_id: X1, expected_deliverable_sha256: d.delivery.sha256}, client_state: bobBefore,
              signature_fields: [], expect_error: 'transfer_window_open'}});
        assert.equal(w.error, 'transfer_window_open', JSON.stringify(w).slice(0, 300));
        await step('flow W: the deal says what is possible now: wait for the transfer window (next_actions)', 'bob.agent', 'GET', `/deals/${X1}`, {auth: 'bob.agent', features: FEAT, expect: 200});
        now = T + 3600e3 + 125e3;   // past T + 1 h + 2 min, the client's own margin
        const ok = await completeBound('bob', 'nina', X1, 'flow W: after the window bob pays with his own bound note: note_issued (the refused attempt can never apply now)',
          {extraReads: [['/edges?since=0', 'bob.agent']], client_state: bobBefore,
            client_state_after: t => ({records: {[bn]: {confirmed: {total: t.total, timestamp: t.timestamp}}, paid_deals: {[X1]: {route: 'note', edge: bn, total: t.total, timestamp: t.timestamp}}},
              signed: xSigned(t.timestamp, [[bn, 'prior', t.prior_total], [bn, 'new', t.total]])})});
        assert.equal(ok.out.status, 'note_issued', JSON.stringify(ok.out).slice(0, 300));
      }
      // ---- decision D-1 item 4: a held bound note older than one hour is refused by the tracker (novation_expired) ----
      {
        const ab = edgeK('alice', 'bob');
        await step("flow X: alice's owner reviews deliveries (each completion waits for the owner)", 'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200, body: {review_deliveries: true}});
        const E1 = await dealToDelivery('alice', 'bob', svc16('Fact check', 'Check one figure.'), 6, 'The figure is right.', 'flow X (v16)');
        const first = await completeBound('alice', 'bob', E1, "flow X: alice signs a bound note; her owner reviews deliveries, so it is held (completion_awaiting_owner)");
        assert.equal(first.out.status, 'completion_awaiting_owner');
        tick(61 * 60);
        const ap = Object.values(state.approvals).find(a => a.deal_id === E1 && a.state === 'pending');
        await step("flow X: 61 minutes later alice's owner approves: the tracker refuses the held bound note as older than its maximum age (400 novation_expired): note_failed, with the tracker's code (decision D-1 item 4)",
          'alice.owner', 'POST', `/owner/approvals/${ap.id}`, {auth: 'alice.owner', expect: 200, body: {decision: 'approve'}});
        const dv = await step('flow X: the deal: note_failed, credit_note.error_code novation_expired; alice may sign a new bound note at once (it acknowledges the same prior)', 'alice.agent', 'GET', `/deals/${E1}`,
          {auth: 'alice.agent', features: FEAT, expect: 200});
        assert.equal(dv.status, 'note_failed'); assert.equal(dv.credit_note?.error_code, 'novation_expired', JSON.stringify(dv.credit_note));
        const t0 = first.tpl, prior = edgeState('alice', 'bob');
        const aliceBefore = {pins: PINS, consent_policy: POLICY_ALL, records: {[ab]: {confirmed: {total: prior.total, timestamp: prior.timestamp, signature: prior.signature}, pending: []}},
          transfer_attempts: {[E1]: [{deal_id: E1, route: 'note', edge: ab, prior: t0.prior_total, prior_timestamp: t0.prior_note.timestamp, prior_signature: t0.prior_note.signature,
            total: t0.total, timestamp: t0.timestamp, quote_digest: null, signed_at: iso(now - 62 * 60e3)}]},
          signed: xSigned(t0.timestamp, [[ab, 'prior', t0.prior_total], [ab, 'new', t0.total]])};
        const again = await completeBound('alice', 'bob', E1, 'flow X: alice signs a fresh bound note (new timestamp, the same acknowledged prior): held for her owner again',
          {client_state: aliceBefore, client_state_after: t => ({transfer_attempts: {[E1]: [{route: 'note', timestamp: t0.timestamp}, {route: 'note', edge: ab, prior: t.prior_total, total: t.total, timestamp: t.timestamp}]},
            signed: xSigned(t.timestamp, [[ab, 'prior', t.prior_total], [ab, 'new', t.total]])})});
        assert.equal(again.out.status, 'completion_awaiting_owner');
        const ap2 = Object.values(state.approvals).find(a => a.deal_id === E1 && a.state === 'pending');
        await step("flow X: alice's owner approves at once: the bound note is recorded (note_issued)", 'alice.owner', 'POST', `/owner/approvals/${ap2.id}`, {auth: 'alice.owner', expect: 200, body: {decision: 'approve'}});
        await step("flow X: alice's owner stops reviewing deliveries", 'alice.owner', 'PUT', '/owner/mandate', {auth: 'alice.owner', expect: 200, body: {review_deliveries: false}});
        assert.equal((await dealView('alice', E1)).status, 'note_issued');
      }
      // ---- a server-run party (sam) and a client party (alice); attacks the server refuses; an outcome nobody can read
      //      back (decision D-1 item 3) and the owner's resolution of it (D-2 d) ----
      {
        const ab = edgeK('alice', 'bob'), as = edgeK('alice', 'sam');
        const S3 = await dealToDelivery('bob', 'sam', svc16('One-line summary', 'Summarise one paragraph in one line.'), 3, 'Set-off cancels equal debts; nothing is redeemed.', 'flow Y (v16)');
        const d = await dealView('bob', S3), tpl = await transferTemplate('bob', S3, 'alice');
        const A = tpl.issuer.pubkey, B = tpl.payer.pubkey, C = tpl.payee.pubkey, T = tpl.timestamp, X = tpl.from_edge.before.total, Y = 0, a = tpl.amount;
        // attack 1: a "puppet" destination, the to-slot signed for a key bob controls (here the public test key carol-2)
        // instead of sam's
        const puppetKey = K['carol-2'].pub;
        const puppet = payBody('bob', d, tpl, {sign: (slot, m) => slot.endsWith(`>${C}:new`) ? signHex(P.bob.key, noteMessage(hx(A), hx(puppetKey), Y + a, T, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex')) : signHex(P.bob.key, m)});
        await step("flow Y: an attack the server refuses: bob's A>C:new slot is signed for another destination key (a puppet), so it does not verify over the message for sam's key: 403 bad_signature, nothing recorded",
          'bob.agent', 'POST', `/deals/${S3}/pay-by-transfer`, {auth: 'bob.agent', features: FEAT, expect: 403, body: puppet});
        // attack 2: amplification, the from-edge lowered by twice the price
        const amplified = payBody('bob', d, tpl, {sign: (slot, m) => slot === `${A}>${B}:new` ? signHex(P.bob.key, noteMessage(hx(A), hx(B), X - 2 * a, T, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex')) : signHex(P.bob.key, m)});
        await step("flow Y: another: bob's A>B:new slot lowers his claim by twice the price (amplification): 403 bad_signature, nothing recorded",
          'bob.agent', 'POST', `/deals/${S3}/pay-by-transfer`, {auth: 'bob.agent', features: FEAT, expect: 403, body: amplified});
        const tplNow = await transferTemplate('bob', S3, 'alice'), body = payBody('bob', d, tplNow);
        const r = await step("flow Y: bob pays sam by transfer with 3 PC of alice's note: sam's agent runs on the server, so its slots (A>C:prior, A>C:new) are signed at once; alice's are missing",
          'bob.agent', 'POST', `/deals/${S3}/pay-by-transfer`, {auth: 'bob.agent', features: FEAT, expect: 200, body,
            reads: [[`/deals/${S3}`, 'bob.agent'], ['/info'], [`/participants/${P.sam.id}`], [`/deals/${S3}/payment-options`, 'bob.agent'], [`/participants/${P.alice.id}`], ['/me', 'bob.agent'],
              [`/deals/${S3}/transfer-template?issuer=${P.alice.id}`, 'bob.agent']],
            client_call: {method: 'pay_by_transfer', key: 'bob', feature: 'circulation/1', args: {deal_id: S3, issuer: P.alice.id, expected_deliverable_sha256: d.delivery.sha256},
              client_state: {pins: PINS, consent_policy: POLICY_ALL}, signature_fields: sigFields(body),
              client_state_after: {transfer_attempts: {[S3]: [{route: 'transfer', edge: ab, prior: X, prior_timestamp: tplNow.from_edge.before.timestamp, total: X - a, timestamp: tplNow.timestamp, quote_digest: tplNow.quote_digest}]},
                signed: xSigned(tplNow.timestamp, [[ab, 'prior', X], [ab, 'new', X - a], [as, 'new', Y + a]]), records: xPending([[ab, X - a, tplNow.timestamp, 'transfer', S3, 'in']]), approved_payments: {[S3]: tplNow.quote_digest}}}});
        const vt = r.transfer?.id ?? r.payment?.transfer_id;
        circulation.transfers.T3 = vt; circulation.templates.transfer_S3 = {tpl: tplNow, now_ms: now - 60e3};
        // The tracker applies the transfer but its answer is lost (a timeout); before Valun reads the edges back, alice's key
        // raises A>B with a bound note submitted around Valun: A>B is then past T at a total that is neither the transfer's
        // new total nor its prior, so the read-back cannot decide (decision D-1 item 3).
        let outside = null;
        tracker.novation = 'timeout'; tracker.applyOnTimeout = true;
        tracker.onTimeout = () => {
          const cur = notes.get(ab), x = now - 1000, T2 = x - (x % 1000) + 997 - ((x % 1000) < 997 ? 1000 : 0);
          outside = {issuer_pubkey: A, recipient_pubkey: B, amount: cur.amount_collected + 2, timestamp: T2, signature: signHex(K.alice, msgHex('alice', 'bob', cur.amount_collected + 2, T2)),
            tracker_nft_id: FIXTURE_NFT, denomination: PILOT_DENOMINATION, prior_signature: signHex(K.alice, msgHex('alice', 'bob', cur.amount_collected, T2)), prior_total: cur.amount_collected};
          const ans = v3Note(outside);
          assert.equal(ans.status, 201, JSON.stringify(ans));
        };
        const item = await consentItem('alice', vt);
        circulation.consent_items.issuer_T3 = {item, now_ms: now};
        const x = await step("flow Y: alice signs her issuer slots: the last signature applies the transfer, but the tracker's answer is lost, and before the read-back a bound note signed by alice's key, submitted around Valun, raises A>B: the read-back cannot decide (outcome_unknown)",
          'alice.agent', 'POST', `/consents/${vt}`, {auth: 'alice.agent', features: FEAT, expect: 200, body: consentBody('alice', item),
            extra: {stand_in_tracker: {novation: 'applied; its answer lost (timeout)', then: 'a bound note on alice -> bob, +2 PC, signed by alice (test key) and submitted around Valun'}}});
        tracker.applyOnTimeout = false;
        assert.ok(outside, 'the outside note was not written');
        assert.equal(x.state, 'outcome_unknown', JSON.stringify(x).slice(0, 300));
        const dv = await step("flow Y: bob reads the deal: payment_due, and the transfer's outcome is unknown; only the payer's owner can resolve it (decision D-1 item 3)",
          'bob.agent', 'GET', `/deals/${S3}`, {auth: 'bob.agent', features: FEAT, expect: 200});
        assert.equal(dv.status, 'payment_due', JSON.stringify(dv).slice(0, 300));
        const po = await step("flow Y: bob's payment options while the outcome is unknown: none is available (why_not attempt_outcome_unknown)", 'bob.agent', 'GET',
          `/deals/${S3}/payment-options`, {auth: 'bob.agent', features: FEAT, expect: 200});
        assert.equal(po.own_note?.why_not, 'attempt_outcome_unknown', JSON.stringify(po).slice(0, 300));
        const again = await step('flow Y: any payment of the deal is refused while the outcome is unknown: the own-note template is 409 attempt_outcome_unknown', 'bob.agent', 'GET',
          `/deals/${S3}/credit-note-template?prior=1&bound=1`, {auth: 'bob.agent', features: FEAT, expect: 409});
        assert.equal(again.error, 'attempt_outcome_unknown', JSON.stringify(again).slice(0, 300));
        const again2 = await step('flow Y: so is another transfer: the transfer template is 409 attempt_outcome_unknown', 'bob.agent', 'GET',
          `/deals/${S3}/transfer-template?issuer=${P.alice.id}`, {auth: 'bob.agent', features: FEAT, expect: 409});
        assert.equal(again2.error, 'attempt_outcome_unknown', JSON.stringify(again2).slice(0, 300));
        await step("flow Y: bob's owner sees the attempt to resolve in the owner console", 'bob.owner', 'GET', '/owner', {auth: 'bob.owner', expect: 200});
        const res = await step("flow Y: bob's owner, after sam confirmed the payment arrived, resolves the attempt as applied (POST /owner/deals/{vd}/attempts/{vt}/resolve, decision D-2 d): paid_by_transfer",
          'bob.owner', 'POST', `/owner/deals/${S3}/attempts/${vt}/resolve`, {auth: 'bob.owner', expect: 200, body: {outcome: 'applied', note: 'sam confirmed that 3 PC arrived'}});
        assert.equal(res.deal?.status, 'paid_by_transfer', JSON.stringify(res).slice(0, 300));
        await step('error: an attempt that is not unresolved cannot be resolved again (409 wrong_state)', 'bob.owner', 'POST', `/owner/deals/${S3}/attempts/${vt}/resolve`,
          {auth: 'bob.owner', expect: 409, body: {outcome: 'not_applied'}});
      }
      // ---- decision D-3 b: a client whose consent roles are all off declares the empty list once; the server forgets its roles at once ----
      {
        const off = {setoff: false, as_issuer: false, as_new_creditor: false, max_PC: 50, accept_issuers: 'any', refuse_issuers: []};
        await step("flow Z: nina's client turns every consent role off: its next request declares none (X-Valun-Features: consents/1;roles=) and the server forgets her roles at once (decision D-3 b)",
          'nina.agent', 'GET', '/consents', {auth: 'nina.agent', features: 'consents/1;roles=', expect: 200, reads: [['/info']],
            client_call: {method: 'process_consents', key: 'nina', feature: 'circulation/1', args: {}, client_state: {pins: PINS, consent_policy: off, consent_roles_declared: 'setoff,issuer,creditor'},
              signature_fields: [], client_state_after: {consent_roles_declared: ''}}});
        featuresOf.nina = undefined;     // her client sends no header from now on (consent_roles_declared is '')
        const me = await step("flow Z: nina's agent: who am I (no header): consent_roles [] and consents_count_until null", 'nina.agent', 'GET', '/me', {auth: 'nina.agent', expect: 200});
        assert.deepEqual(me.features.consent_roles, []); assert.equal(me.features.consents_count_until, null);
        const Z1 = await dealToDelivery('bob', 'nina', svc16('Definition', 'Define one term.'), 1, 'Set-off: cancelling equal opposite debts.', 'flow Z (v16)');
        const po = await step("flow Z: bob's payment options for a deal with nina: her consent as payee is unavailable now", 'bob.agent', 'GET', `/deals/${Z1}/payment-options`, {auth: 'bob.agent', features: FEAT, expect: 200});
        circulation.payment_options_Z1 = po;
      }
      // =================================================================================================================
      // circulation.json: the bytes and the decisions of circulating credit, from what this run produced
      // =================================================================================================================
      {
        const V = {timestamps: [], messages: [], quote_digests: [], statements: [], transfers: [], setoffs: [], consents: [], payer_templates: [], bound_templates: []};
        const pk = n => P[n].key.pub, M = (i, r, t, ts) => noteMessage(hx(i), hx(r), t, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex');
        const keyName = pub => Object.values(K).find(k => k.pub === pub)?.name ?? null;
        const meOf = async name => (await http('GET', '/me', {auth: agentOf(name)})).body;
        const mandates = {};
        for (const n of ['alice', 'bob', 'nina']) mandates[n] = (await meOf(n)).effective_limits;
        circulation.mandates = mandates;
        const dealOf = async (name, id, {delivered = false, transferId = null} = {}) => {
          const d = await dealView(name, id), t = d.current.terms;
          return {deal_id: t.deal_id, network: t.network, tracker_nft_id: t.tracker_nft_id, denomination: t.denomination, terms_hash: d.agreement.terms_hash,
            deliverable_sha256: d.delivery.sha256, price: t.price.amount, payer: {id: t.payer.id, pubkey: t.payer.pubkey}, payee: {id: t.payee.id, pubkey: t.payee.pubkey},
            delivered, transfer_id: transferId};
        };

        // ---- timestamps (PROTOCOL.md 18.4): residues, the ordinary clamp, the novation rule, boundaries ----
        const classes = ts => ({ordinary: Number.isSafeInteger(ts) && ![995, 996, 997, 998, 999].includes(ts % 1000), bound: Number.isSafeInteger(ts) && ts % 1000 === 997,
          transfer: Number.isSafeInteger(ts) && ts % 1000 === 999, setoff: Number.isSafeInteger(ts) && ts % 1000 === 998});
        const base = Date.parse('2026-11-15T15:00:00.000Z');
        for (const [name, ts] of [['zero', 0], ['ordinary-994', base + 994], ['exchange-995', base + 995], ['compress-996', base + 996], ['bound-997', base + 997],
          ['setoff-998', base + 998], ['transfer-999', base + 999], ['next-second-000', base + 1000], ['max-safe-integer', Number.MAX_SAFE_INTEGER]]) {
          V.timestamps.push({name: `residue/${name}`, ts, residue: ts % 1000, accepted_as: classes(ts),
            ordinary_clamp: basisModule.ordinaryTimestamp(ts), why: 'ordinary notes use 000-994 ms; 995 exchange and 996 compress are reserved, 997 bound note, 998 set-off, 999 transfer; the server moves an ordinary timestamp ending in 995-999 to the next whole second (ordinaryTimestamp)'});
        }
        // Beyond the safe integers (2^53 - 1): written as exact JSON numbers. No client signs them (every number a client
        // signs is a safe integer, for JavaScript parity); the tracker's own limit for totals is i64::MAX.
        for (const [name, digits] of [['above-max-safe-integer', '9007199254740993'], ['i64-max', '9223372036854775807'], ['u64-max', '18446744073709551615']])
          V.timestamps.push({name: `residue/${name}`, ts: `@@int:${digits}@@`, residue: Number(BigInt(digits) % 1000n), accepted_as: {ordinary: false, bound: false, transfer: false, setoff: false},
            ordinary_clamp: null, why: 'not a safe integer: no client signs it, whatever its residue (the server clamp refuses it too: ordinaryTimestamp throws)'});
        // the server's choice of T for each operation: the largest t <= now - 1500 with the residue and t > after, or ahead_ms
        for (const [name, nowT, residue, after] of [['transfer', base + 30000, 999, base], ['setoff', base + 30000, 998, base + 28998], ['bound', base + 30000, 997, base + 27997],
          ['bound-wait', base + 30000, 997, base + 28997], ['transfer-at-lag-boundary', base + 1500 + 999, 999, base + 998]]) {
          V.timestamps.push({name: `choice/${name}`, now: nowT, residue, after, server_choice: novationModule.novationTimestamp({now: nowT, residue, after}),
            why: 'novationTimestamp (lib/pilot/novation.mjs): T ending in the residue, at least 1.5 s before the clock and after the edge state (or every live set-off on it); otherwise the server waits ahead_ms (at most 3 s) or answers 409 note_timestamp_ahead'});
        }

        // ---- messages: a bound note and its prior, the seven transfer slots, the set-off slots (deterministic signatures) ----
        const bC2 = circulation.templates.bound_C2.tpl;
        const pushMsg = (name, slot, i, r, total, ts, signer) => {
          const message_hex = M(i, r, total, ts);
          V.messages.push({name, slot, issuer_pubkey: i, recipient_pubkey: r, total, timestamp: ts, tracker_nft_id: FIXTURE_NFT, denomination: PILOT_DENOMINATION,
            message_hex, signer: keyName(signer), signer_pubkey: signer, signature: signHex(Object.values(K).find(k => k.pub === signer), message_hex), valid: true});
        };
        pushMsg('bound-note/prior-acknowledgment', `${bC2.issuer_pubkey}>${bC2.recipient_pubkey}:prior`, bC2.issuer_pubkey, bC2.recipient_pubkey, bC2.prior_total, bC2.timestamp, bC2.issuer_pubkey);
        pushMsg('bound-note/note', `${bC2.issuer_pubkey}>${bC2.recipient_pubkey}:new`, bC2.issuer_pubkey, bC2.recipient_pubkey, bC2.total, bC2.timestamp, bC2.issuer_pubkey);
        const tN1 = circulation.templates.transfer_N1.tpl;
        {
          const A = tN1.issuer.pubkey, B = tN1.payer.pubkey, C = tN1.payee.pubkey, a = tN1.amount, T = tN1.timestamp, X = tN1.from_edge.before.total, Y = tN1.to_edge.before?.total ?? 0;
          for (const [slot, signer, i, r, total] of [['issuer_from', A, A, B, X - a], ['issuer_to', A, A, C, Y + a], ['from_recipient_prior', B, A, B, X], ['from_recipient', B, A, B, X - a],
            ['from_recipient_to', B, A, C, Y + a], ['to_recipient_prior', C, A, C, Y], ['to_recipient', C, A, C, Y + a]]) pushMsg(`transfer/${slot}`, slot, i, r, total, T, signer);
        }
        const S2item = circulation.consent_items.member_S2_alice.item;
        for (const e of S2item.edges) {
          const [I, R] = e.edge.split('>');
          pushMsg(`setoff/${keyName(I)}>${keyName(R)}/issuer`, `${e.edge}:new`, I, R, e.new_total, e.timestamp, I);
          pushMsg(`setoff/${keyName(I)}>${keyName(R)}/recipient`, `${e.edge}:new`, I, R, e.new_total, e.timestamp, R);
        }
        V.messages.push({...V.messages[0], name: 'bound-note/prior-acknowledgment-signed-by-the-creditor', signer: keyName(bC2.recipient_pubkey), signer_pubkey: bC2.recipient_pubkey,
          signature: V.messages[0].signature, valid: false, why: "the issuer's signature does not verify under the creditor's key"});

        // ---- quote digests (PROTOCOL.md 18.3 item 4) ----
        const quoteCase = (name, Q, why) => { const text = canonical(Q); V.quote_digests.push({name, quote: Q, canonical: text, quote_digest: sha256(text), why}); };
        {
          const d = await dealView('bob', N1);
          quoteCase('transfer-T1', quoteOf(d, tN1.issuer.pubkey, tN1.payer.pubkey, tN1.payee.pubkey, tN1.amount), 'the quote bob approved for paying nina with 10 PC of alice\'s note');
          assert.equal(V.quote_digests[0].quote_digest, tN1.quote_digest);
          // the cross-check of PROTOCOL.md 18.3 (SP-1): canonical.json base terms (alice pays bob 20), issuer carol, delivery 'example delivery'
          const tb = baseTerms();
          const Q = {kind: 'valun-transfer-quote/1', network: NETWORK, tracker_nft_id: tb.tracker_nft_id, denomination: tb.denomination, deal_id: tb.deal_id, terms_hash: termsHash(tb),
            deliverable_sha256: sha256('example delivery'), issuer_pubkey: K.carol.pub, payer_pubkey: K.alice.pub, payee_pubkey: K.bob.pub, amount: 20};
          quoteCase('worked-example-18.3', Q, 'PROTOCOL.md 18.3 worked example: base terms of canonical.json, issuer carol, deliverable sha256("example delivery")');
          assert.equal(V.quote_digests[1].quote_digest, '377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e', 'the PROTOCOL.md 18.3 worked example');
          quoteCase('another-payee-key', {...V.quote_digests[0].quote, payee_pubkey: K.carol.pub}, 'any field changed (here the payee key) gives another digest, so the owner approves exactly one destination');
        }
        // ---- the pay statement: valun-pilot/pay/1 LF deal_id LF quote_digest (102 bytes) ----
        {
          const q = tN1.quote_digest, text = payStatement(tN1.deal_id, q);
          assert.equal(text, core.circulationStatements.pay(tN1.deal_id, q)); assert.equal(Buffer.byteLength(text), 102);
          V.statements.push({name: 'pay/T1', kind: 'pay', tier: 'core', inputs: {deal_id: tN1.deal_id, quote_digest: q}, statement: text, statement_utf8_hex: utf8hex(text),
            signer: 'bob', pubkey: K.bob.pub, signature: signText(K.bob, text), valid: true});
          V.statements.push({...V.statements[0], name: 'pay/T1-signed-as-a-note-message', signature: signHex(K.bob, M(tN1.issuer.pubkey, tN1.payer.pubkey, tN1.from_edge.new_total, tN1.timestamp)),
            valid: false, why: 'a slot signature is over an 80-byte note message, never over the 102-byte pay statement'});
        }
        circulation.vectors = V; CIRCULATION_VECTORS = V; CIRCULATION_REDACT = redact;
      }
      // ---- tracker requests (POST /notes/transfer, /notes/setoff), each run on the stand-in tracker v3.1 in the state the
      //      transcript's request found, at its time; negatives are the attacks and mistakes the tracker refuses ----
      {
        const V = circulation.vectors, pk = n => K[n].pub;
        const M = (i, r, t, ts) => noteMessage(hx(i), hx(r), t, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex');
        const keyOf = pub => Object.values(K).find(k => k.pub === pub);
        const sg = (pub, m) => signHex(keyOf(pub), m);
        // run fn on the stand-in with exactly the notes `before` ({edge: state or null}) at tracker time t; restored after
        function probe(before, t, fn) {
          const savedNotes = new Map(notes), savedBound = new Set(boundOnly), savedNow = now;
          try {
            for (const [k, st] of Object.entries(before)) {
              if (st === null) notes.delete(k);
              else { const [i, r] = k.split('>'); notes.set(k, {issuer_pubkey: i, recipient_pubkey: r, amount_collected: st.total, amount_redeemed: 0, timestamp: st.timestamp, signature: st.signature, denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}}); }
            }
            now = t;
            const r = fn();
            return {status: r.status, ...(r.json?.code ? {code: r.json.code} : {}), ...(r.status >= 300 ? {error: r.json ? r.json.error : r.text} : {})};
          } finally { notes.clear(); for (const [k, v] of savedNotes) notes.set(k, v); boundOnly.clear(); for (const k of savedBound) boundOnly.add(k); now = savedNow; }
        }
        // what the tracker checks for each signature of a transfer body, given the state before
        const transferSigs = (b, before) => {
          const A = b.issuer_pubkey, B = b.from_recipient_pubkey, C = b.to_recipient_pubkey, a = b.amount, T = b.timestamp;
          const X = before[`${A}>${B}`]?.total ?? 0, Y = before[`${A}>${C}`]?.total ?? 0;
          return [['issuer_from_signature', A, A, B, X - a], ['issuer_to_signature', A, A, C, Y + a], ['from_recipient_prior_signature', B, A, B, X], ['from_recipient_signature', B, A, B, X - a],
            ['from_recipient_to_signature', B, A, C, Y + a], ['to_recipient_prior_signature', C, A, C, Y], ['to_recipient_signature', C, A, C, Y + a]]
            .filter(([f]) => typeof b[f] === 'string' && Number.isSafeInteger(a) && Number.isSafeInteger(T) && X - a >= 0)
            .map(([field, signer, i, r, total]) => { const message_hex = M(i, r, total, T); return {field, signer_pubkey: signer, issuer_pubkey: i, recipient_pubkey: r, total, timestamp: T, message_hex, signature: b[field], valid: schnorrVerify(hx(b[field]), hx(message_hex), hx(signer))}; });
        };
        const setoffSigs = (b, before) => (b.edges || []).flatMap((e, n) => {
          const P0 = before[`${e.issuer_pubkey}>${e.recipient_pubkey}`]?.total ?? 0, ts = e.timestamp ?? b.timestamp, total = P0 - e.decrease;
          if (!(total >= 0) || !Number.isSafeInteger(ts)) return [];
          const message_hex = M(e.issuer_pubkey, e.recipient_pubkey, total, ts);
          return [['issuer_signature', e.issuer_pubkey], ['recipient_signature', e.recipient_pubkey]].filter(([f]) => typeof e[f] === 'string')
            .map(([f, signer]) => ({field: `edges/${n}/${f}`, signer_pubkey: signer, issuer_pubkey: e.issuer_pubkey, recipient_pubkey: e.recipient_pubkey, total, timestamp: ts, message_hex, signature: e[f],
              valid: schnorrVerify(hx(e[f]), hx(message_hex), hx(signer))}));
        });
        const T1req = trackerRequests.find(x => x.route === 'POST /notes/transfer');
        const add = (group, name, route, before, at, request, why, expect) => {
          const outcome = probe(before, at, () => route === 'POST /notes' ? v3Note(request) : route === 'POST /notes/transfer' ? v3Transfer(request) : v3Setoff(request));
          if (expect !== undefined) assert.equal(outcome.code ?? outcome.status, expect, `${name}: ${JSON.stringify(outcome)}`);
          V[group].push({name, route, valid: outcome.status < 300, why, state_before: before, tracker_now: at, tracker_request: request, tracker_outcome: outcome,
            signatures: route === 'POST /notes/setoff' ? setoffSigs(request, before) : route === 'POST /notes/transfer' ? transferSigs(request, before) : []});
        };
        {
          const b0 = T1req.request, before = T1req.before, at = T1req.at;
          const A = b0.issuer_pubkey, B = b0.from_recipient_pubkey, C = b0.to_recipient_pubkey, a = b0.amount, T = b0.timestamp;
          const X = before[`${A}>${B}`].total, Y = before[`${A}>${C}`]?.total ?? 0;
          // a transfer body for other values, every slot signed by its true signer (an honest body for those values)
          const signedBody = ({A: A2 = A, B: B2 = B, C: C2 = C, a: a2 = a, T: T2 = T, X: X2 = X, Y: Y2 = Y} = {}) => ({issuer_pubkey: A2, from_recipient_pubkey: B2, to_recipient_pubkey: C2, denomination: PILOT_DENOMINATION,
            amount: a2, timestamp: T2, issuer_from_signature: sg(A2, M(A2, B2, X2 - a2, T2)), issuer_to_signature: sg(A2, M(A2, C2, Y2 + a2, T2)),
            from_recipient_prior_signature: sg(B2, M(A2, B2, X2, T2)), from_recipient_signature: sg(B2, M(A2, B2, X2 - a2, T2)), from_recipient_to_signature: sg(B2, M(A2, C2, Y2 + a2, T2)),
            to_recipient_prior_signature: sg(C2, M(A2, C2, Y2, T2)), to_recipient_signature: sg(C2, M(A2, C2, Y2 + a2, T2)), from_prior_total: X2, to_prior_total: Y2});
          add('transfers', 'transfer/T1-as-applied', 'POST /notes/transfer', before, at, b0, 'the seven signatures of transfer T1 (transcript), each over M(I,R,t,T) for its slot: applied', 200);
          add('transfers', 'transfer/standalone-raised-edge', 'POST /notes', before, at,
            {issuer_pubkey: A, recipient_pubkey: C, amount: Y + a, timestamp: T, signature: b0.issuer_to_signature, tracker_nft_id: FIXTURE_NFT, denomination: PILOT_DENOMINATION},
            "the issuer's raise of the new creditor's edge, sent alone as a note: a timestamp ending in 999 belongs to transfers", 'reserved_timestamp');
          add('transfers', 'transfer/missing-residue', 'POST /notes/transfer', before, at, signedBody({T: T - 999}), 'every slot signed, but the timestamp does not end in 999 ms', 'invalid_transfer');
          const puppet = K['carol-2'].pub;
          add('transfers', 'transfer/puppet-destination', 'POST /notes/transfer', {...before, [`${A}>${puppet}`]: null}, at,
            {...b0, to_recipient_pubkey: puppet, from_recipient_to_signature: sg(B, M(A, puppet, a, T)), to_recipient_prior_signature: sg(puppet, M(A, puppet, 0, T)), to_recipient_signature: sg(puppet, M(A, puppet, a, T)), to_prior_total: 0},
            "the payer and a key it controls sign a destination the issuer never signed: the issuer's to-slot does not verify for it", 'invalid_signature');
          const four = {issuer_pubkey: A, from_recipient_pubkey: B, to_recipient_pubkey: C, denomination: PILOT_DENOMINATION, amount: a, timestamp: T,
            issuer_from_signature: b0.issuer_from_signature, issuer_to_signature: b0.issuer_to_signature, from_recipient_signature: b0.from_recipient_signature, to_recipient_signature: b0.to_recipient_signature};
          add('transfers', 'transfer/four-signature-body', 'POST /notes/transfer', before, at, four, 'the four-signature body of tracker versions before v3: refused (422, missing fields)', 422);
          add('transfers', 'transfer/five-signature-body', 'POST /notes/transfer', before, at, {...four, from_recipient_to_signature: b0.from_recipient_to_signature},
            "five signatures (no prior acknowledgments): refused (422), so neither creditor's current total can be skipped", 422);
          add('transfers', 'transfer/amplification', 'POST /notes/transfer', before, at, {...b0, amount: 2 * a},
            'twice the amount with the signatures of the true transfer: the decrease and the increase must each be exactly what was signed', 'invalid_signature');
          add('transfers', 'transfer/colluding-payer', 'POST /notes/transfer', {...before, [`${A}>${C}`]: {total: 5, timestamp: T - 5000, signature: sg(A, M(A, C, 5, T - 5000))}}, at,
            (({to_prior_total, ...rest}) => ({...rest, issuer_to_signature: sg(A, M(A, C, 5 + a, T)), from_recipient_to_signature: sg(B, M(A, C, 5 + a, T))}))(b0),
            "the issuer and a colluding payer sign the destination over a note they hid from the new creditor (its edge at 5): the creditor's own prior acknowledgment (over 0) does not verify for the tracker's prior (5)", 'invalid_prior_signature');
          const T998 = T - 1;
          add('transfers', 'transfer/setoff-signatures-used-as-a-transfer', 'POST /notes/transfer', before, at, signedBody({T: T998}),
            'signatures over a timestamp ending in 998 ms (a set-off) presented as a transfer: refused before any signature is checked', 'invalid_transfer');
          add('transfers', 'transfer/too-old', 'POST /notes/transfer', before, T + 3600001, b0, 'the same body one hour and 1 ms after T: novation_expired, the maximum age (also for bound notes)', 'novation_expired');
          add('transfers', 'transfer/unknown-field', 'POST /notes/transfer', before, at, {...b0, memo: 'thanks'}, 'a field the version-3 request does not have: refused (422, deny_unknown_fields)', 422);
          add('transfers', 'transfer/stale-prior-total', 'POST /notes/transfer', before, at, {...b0, from_prior_total: X + 1}, "from_prior_total is not the edge's current total", 'stale_prior');
          add('transfers', 'transfer/self-transfer', 'POST /notes/transfer', before, at, {...b0, to_recipient_pubkey: B}, 'the old and the new creditor are the same key', 'invalid_transfer');
        }
        {
          const Sreq = trackerRequests.filter(x => x.route === 'POST /notes/setoff' && x.answer?.status === 200).at(-1);
          const b0 = Sreq.request, before = Sreq.before, at = Sreq.at;
          const resign = b => ({...b, edges: b.edges.map(e => {
            const P0 = before[`${e.issuer_pubkey}>${e.recipient_pubkey}`]?.total ?? 0, m = M(e.issuer_pubkey, e.recipient_pubkey, P0 - e.decrease, e.timestamp ?? b.timestamp);
            return {...e, issuer_signature: sg(e.issuer_pubkey, m), recipient_signature: sg(e.recipient_pubkey, m)};
          })});
          add('setoffs', 'setoff/S2-as-applied', 'POST /notes/setoff', before, at, b0, 'every member signed M(I,R,P-d,ts_e) on each of its edges (per-edge timestamps ending in 998): applied', 200);
          add('setoffs', 'setoff/unbalanced', 'POST /notes/setoff', before, at, resign({...b0, edges: [{...b0.edges[0], decrease: b0.edges[0].decrease - 1}, ...b0.edges.slice(1)]}),
            "honestly signed, but one participant's decreases as creditor and as issuer differ", 'invalid_setoff');
          add('setoffs', 'setoff/one-edge', 'POST /notes/setoff', before, at, {...b0, edges: b0.edges.slice(0, 1)}, 'a set-off lowers at least two edges', 'invalid_setoff');
          add('setoffs', 'setoff/residue-997', 'POST /notes/setoff', before, at, resign({...b0, edges: b0.edges.map(e => ({...e, timestamp: e.timestamp - 1}))}),
            "every edge's timestamp must end in 998 ms", 'invalid_setoff');
          add('setoffs', 'setoff/too-old', 'POST /notes/setoff', before, Math.max(...b0.edges.map(e => e.timestamp)) + 3600001, b0, 'one hour and 1 ms after an edge timestamp: novation_expired', 'novation_expired');
          add('setoffs', 'setoff/recipient-signature-missing', 'POST /notes/setoff', before, at, {...b0, edges: [{...b0.edges[0], recipient_signature: b0.edges[0].issuer_signature}, ...b0.edges.slice(1)]},
            "the creditor's slot holds the issuer's signature: every edge needs both", 'invalid_signature');
          add('setoffs', 'setoff/decrease-above-total', 'POST /notes/setoff', before, at, {...b0, edges: b0.edges.map(e => ({...e, decrease: e.decrease + 100}))}, "a decrease larger than the edge's total (refused before any signature is checked)", 'invalid_setoff');
          add('setoffs', 'setoff/past-timestamp', 'POST /notes/setoff', before, at, resign({...b0, edges: b0.edges.map(e => ({...e, timestamp: before[`${e.issuer_pubkey}>${e.recipient_pubkey}`].timestamp - (before[`${e.issuer_pubkey}>${e.recipient_pubkey}`].timestamp % 1000) - 2}))}),
            "an edge timestamp before the edge's current note", 'past_timestamp');
          add('setoffs', 'setoff/unknown-field', 'POST /notes/setoff', before, at, {...b0, edges: [{...b0.edges[0], memo: 'x'}, ...b0.edges.slice(1)]}, 'an edge field the version-3 request does not have (422)', 422);
        }
      }
      // ---- the client signing firewall (PROTOCOL.md 15.3): decisions every conforming client reaches ----
      // Each case starts from an item or template the server produced in this run (its consent view or template, the
      // participant's mandate as GET /me shows it, its pins) and breaks at most one rule, so the expected code is the
      // rule's; 'sign' cases name the exact slots, in order, and the bytes of each.
      {
        const V = circulation.vectors, CI = circulation.consent_items, TP = circulation.templates, MD = circulation.mandates;
        const M = (i, r, t, ts) => noteMessage(hx(i), hx(r), t, ts, hx(FIXTURE_NFT), PILOT_DENOMINATION).toString('hex');
        const clone = x => JSON.parse(JSON.stringify(x));
        const other = K['carol-2'].pub, otherSig = (st, I, R) => signHex(K['carol-2'], M(I, R, st.total, st.timestamp));
        const FEATS = ['bound_notes/1', 'circulation/1'];
        // an edge state at another timestamp, signed by its issuer (so it verifies: only the timestamp rule is broken)
        const keyOfPub = pub => Object.values(K).find(k => k.pub === pub);
        const restamp = (st, I, R, ts) => ({total: st.total, timestamp: ts, signature: signHex(keyOfPub(I), M(I, R, st.total, ts))});
        const ctxFor = (name, now_ms, extra = {}) => ({me_pk: K[name].pub, me_id: P[name].id, now_ms, pins: {...PINS}, consent_policy: {...POLICY_ALL}, mandate: clone(MD[name]),
          records: null, signed: null, transfer_attempts: null, novated_edges: null, features: [...FEATS], ...extra});
        const dealCtx = async (name, id, extra = {}) => {
          const d = await dealView(name, id), t = d.current.terms;
          return {deal_id: t.deal_id, network: t.network, tracker_nft_id: t.tracker_nft_id, denomination: t.denomination, terms_hash: d.agreement.terms_hash,
            deliverable_sha256: d.delivery.sha256, price: t.price.amount, payer: {id: t.payer.id, pubkey: t.payer.pubkey}, payee: {id: t.payee.id, pubkey: t.payee.pubkey},
            delivered: false, transfer_id: null, ...extra};
        };
        // the slots and messages a 'sign' decision names, from the input as given
        const consentSlots = item => item.edges.flatMap(e => {
          const [I, R] = e.edge.split('>');
          return e.slots.filter(sl => !e.signed_by_you.includes(sl)).map(sl => [`${e.edge}:${sl}`, M(I, R, sl === 'prior' ? (e.before?.total ?? 0) : e.new_total, e.timestamp)]);
        });
        const payerSlots = t => {
          const A = t.issuer.pubkey, B = t.payer.pubkey, C = t.payee.pubkey, X = t.from_edge.before.total, Y = t.to_edge.before?.total ?? 0, a = t.amount, T = t.timestamp;
          return [[`${A}>${B}:prior`, M(A, B, X, T)], [`${A}>${B}:new`, M(A, B, X - a, T)], [`${A}>${C}:new`, M(A, C, Y + a, T)]];
        };
        const boundSlots = t => [[`${t.issuer_pubkey}>${t.recipient_pubkey}:prior`, M(t.issuer_pubkey, t.recipient_pubkey, t.prior_total, t.timestamp)],
          [`${t.issuer_pubkey}>${t.recipient_pubkey}:new`, M(t.issuer_pubkey, t.recipient_pubkey, t.total, t.timestamp)]];
        const push = (group, name, evaluator, rule, input, ctx, expected, why, summary) => {
          const slotsOf = {consent: consentSlots, payer_template: payerSlots, bound_template: boundSlots}[evaluator];
          const sl = expected === 'sign' ? slotsOf(input) : null;
          V[group].push({name, tier: 'consent', evaluator, rule, input, ctx, expected: expected === 'sign' ? 'sign' : {refuse: expected},
            ...(sl ? {slots: sl.map(x => x[0]), messages: Object.fromEntries(sl)} : {}), ...(summary ? {summary} : {}), why});
        };

        // ---- set-off member (alice's view of set-off S2) ----
        {
          const {item, now_ms} = CI.member_S2_alice, base = () => [clone(item), ctxFor('alice', now_ms)];
          const e0 = item.edges[0], mineAsIssuer = item.edges.find(e => e.your_role === 'issuer');
          const c = (name, rule, f, expected, why, summary) => { const [i, x] = base(); f(i, x); push('consents', `member/${name}`, 'consent', rule, i, x, expected, why, summary); };
          c('sign', 'R6', () => {}, 'sign', 'a balanced set-off of her own edges: sign the new slot of each, in item order');
          c('not-net-neutral', 'R6', i => { i.edges[0].new_total += 1; i.edges[0].change += 1; }, 'not_net_neutral', 'one edge falls by 1 PC less: her claims and debts would not fall by the same amount');
          c('increase-in-setoff', 'R6', i => { for (const e of i.edges) { e.new_total = (e.before?.total ?? 0) + 1; e.change = 1; } }, 'increase_in_setoff', 'a set-off only lowers edges');
          c('duplicate-edge', 'R6', i => { i.edges = [clone(e0), clone(e0)]; }, 'duplicate_edge', 'the same edge twice');
          c('self-edge', 'R6', i => { i.edges[0].edge = `${K.alice.pub}>${K.alice.pub}`; }, 'self_edge', 'an edge from her key to itself');
          c('not-my-edge', 'R6', i => { i.edges[0].edge = `${K.bob.pub}>${K.nina.pub}`; }, 'not_my_edge', 'an edge she is not a party to');
          c('timestamp-domain', 'R3', i => { for (const e of i.edges) e.timestamp -= 1; }, 'timestamp_domain', 'set-off timestamps end in 998 ms');
          c('bad-prior-signature', 'R2', i => { const [I, R] = i.edges[0].edge.split('>'); i.edges[0].before.signature = otherSig(i.edges[0].before, I, R); }, 'bad_prior_signature',
            "the prior state shown is not its issuer's signature");
          c('timestamp-stale', 'R5', (i, x) => { x.now_ms = Math.max(...i.edges.map(e => e.timestamp)) + 56 * 60e3; }, 'timestamp_stale', 'a consent is signed only within 55 minutes of its timestamp');
          c('timestamp-not-later-than-the-prior', 'R5', i => { const [I, R] = i.edges[0].edge.split('>'); i.edges[0].before = restamp(i.edges[0].before, I, R, i.edges[0].timestamp); }, 'timestamp_stale',
            'an edge timestamp equal to the state it changes (a novation is later than every prior shown)');
          c('policy-off-local', 'R8', (i, x) => { x.consent_policy.setoff = false; }, 'policy_off', 'her local consent policy does not sign set-offs');
          c('policy-off-without-a-mandate', 'R8', (i, x) => { delete x.mandate; }, 'policy_off', "no mandate in the context (GET /me not read): every role is off");
          c('policy-cap', 'R8', (i, x) => { x.consent_policy.max_PC = 1; }, 'policy_cap', 'above the cap of one consent');
          c('timestamp-reused', 'R4', (i, x) => { x.signed = {[e0.edge]: {[String(e0.timestamp)]: {op: 'transfer:vt_0000000000000000', slots: {[`${e0.edge}:new`]: e0.new_total}}}}; }, 'timestamp_reused',
            'she already signed another operation at this edge and timestamp');
          c('records-unreadable', 'R9', (i, x) => { x.records = 'not a record'; }, 'records_unreadable', 'records that cannot be read refuse everything');
          c('tracker-mismatch', 'R13', (i, x) => { x.pins.tracker_nft_id = '11'.repeat(32); }, 'tracker_mismatch', 'another tracker than the pinned one');
          c('not-collecting', '-', i => { i.state = 'applied'; }, 'bad_consent', 'an item that is not collecting signatures is not well formed for signing');
          c('pending-unbound-note', 'R12', (i, x) => { x.records = {[mineAsIssuer.edge]: {confirmed: null, pending: [{total: mineAsIssuer.before.total + 3, timestamp: mineAsIssuer.before.timestamp + 1000 - (mineAsIssuer.before.timestamp % 1000) + 500, kind: 'note', ref: 'vd_00000000000000aa', direction: 'out', signed_at: iso(now_ms)}]}}; },
            'pending_unbound_note', 'she holds an ordinary note of hers on the edge that may still apply');
          c('payment-attempt', 'D-2 c', (i, x) => {
            const e = i.edges.find(z => z.your_role === 'issuer'), ts = e.timestamp - (e.timestamp % 1000) + 1997;
            x.now_ms = Math.max(x.now_ms, ts + 1000);
            x.transfer_attempts = {vd_00000000000000ab: [{deal_id: 'vd_00000000000000ab', route: 'note', edge: e.edge, prior: e.new_total, prior_timestamp: e.before.timestamp, prior_signature: e.before.signature,
              total: e.new_total + 3, timestamp: ts, quote_digest: null, signed_at: iso(x.now_ms)}]};
          }, 'payment_attempt', 'a bound note of hers acknowledged the total this set-off brings her edge back to, and it could still apply after it');
        }
        // ---- transfer issuer (alice's view of transfer T1) ----
        {
          const {item, now_ms} = CI.issuer_T1, base = () => [clone(item), ctxFor('alice', now_ms)];
          const c = (name, rule, f, expected, why, summary) => { const [i, x] = base(); f(i, x); push('consents', `issuer/${name}`, 'consent', rule, i, x, expected, why, summary); };
          c('sign', 'R6', () => {}, 'sign', 'her debt moves from bob to nina, unchanged in total: sign both new slots, the decreased edge first');
          c('total-owed-changes', 'R6', i => { const t = i.edges.find(e => e.change > 0); t.new_total += 1; t.change += 1; }, 'total_owed_changes', 'the raised edge rises by more than the lowered one falls');
          c('not-my-edge', 'R6', i => { i.edges[0].edge = `${K.bob.pub}>${i.edges[0].edge.split('>')[1]}`; }, 'not_my_edge', 'an edge whose issuer is not her key');
        }
        // ---- transfer payee (nina's view of transfer T1) ----
        {
          const {item, now_ms} = CI.payee_T1, deal = await dealCtx('nina', item.context.deal.deal_id, {delivered: true, transfer_id: item.id});
          const base = () => [clone(item), ctxFor('nina', now_ms, {deal: clone(deal), issuer_ids: {[K.alice.pub]: P.alice.id}})];
          const c = (name, rule, f, expected, why, summary) => { const [i, x] = base(); f(i, x); push('consents', `payee/${name}`, 'consent', rule, i, x, expected, why, summary); };
          c('sign', 'R7', () => {}, 'sign', 'paid for her own delivered deal by exactly its price: sign the prior and the new slot of her edge');
          c('not-delivered', 'R7', (i, x) => { x.deal.delivered = false; }, 'deal_mismatch', 'not a deal she delivered on');
          c('another-transfer', 'R7', (i, x) => { x.deal.transfer_id = 'vt_0000000000000000'; }, 'deal_mismatch', 'the deal view names another transfer as its payment');
          c('issuer-refused', 'R8', (i, x) => { x.consent_policy.refuse_issuers = [P.alice.id]; }, 'issuer_refused', 'her local policy refuses notes from this issuer (resolved through the directory)');
          c('policy-off-mandate', 'R8', (i, x) => { x.mandate.accept_transfers = false; }, 'policy_off', "her owner's mandate does not accept payments by transfer");
        }
        // ---- payer template (bob paying nina with alice's note: transfer T1's template) ----
        {
          const {tpl, now_ms} = TP.transfer_N1, deal = await dealCtx('bob', tpl.deal_id);
          const base = () => [clone(tpl), ctxFor('bob', now_ms, {deal: clone(deal), payee_current_pk: K.nina.pub, approved_quote_digest: null})];
          const c = (name, rule, f, expected, why, summary) => { const [i, x] = base(); f(i, x); push('payer_templates', `payer/${name}`, 'payer_template', rule, i, x, expected, why, summary); };
          const held = `${tpl.issuer.pubkey}>${tpl.payer.pubkey}`, bn = `${K.bob.pub}>${K.nina.pub}`;
          c('sign', 'R7', () => {}, 'sign', 'the three slots of the payer: prior and new on the held edge, new on the destination', {quote_digest: tpl.quote_digest});
          c('pay-with-is-payee', 'R7', i => { i.issuer = {...i.issuer, id: P.nina.id, pubkey: K.nina.pub}; }, 'pay_with_is_payee', 'the note to pay with is the payee\'s own');
          c('wrong-destination', 'R7', (i, x) => { x.payee_current_pk = other; }, 'wrong_destination', "the destination is not the payee's current directory key");
          c('amount-mismatch', 'R7', i => { i.amount += 1; i.from_edge.new_total -= 1; i.to_edge.new_total += 1; }, 'amount_mismatch', 'the amount is not the agreed price');
          c('self-edge', 'R7', i => { i.issuer = {...i.issuer, id: P.bob.id, pubkey: K.bob.pub}; }, 'self_edge', 'paying with a note he issued himself');
          c('timestamp-domain', 'R3', i => { i.timestamp -= 1; }, 'timestamp_domain', 'a transfer timestamp ends in 999 ms');
          c('bad-prior-signature', 'R2', i => { i.from_edge.before.signature = otherSig(i.from_edge.before, i.issuer.pubkey, i.payer.pubkey); }, 'bad_prior_signature', "the held edge's state is not the issuer's signature");
          c('timestamp-stale', 'R5', (i, x) => { x.now_ms = i.timestamp + 11 * 60e3; }, 'timestamp_stale', 'what the client starts is signed only within 10 minutes of its timestamp');
          c('timestamp-equal-to-the-held-state', 'R5', i => { i.from_edge.before = restamp(i.from_edge.before, i.issuer.pubkey, i.payer.pubkey, i.timestamp); }, 'timestamp_stale',
            'T equal to the held edge state (it must be later than every prior shown)');
          c('already-paid', 'D-1', (i, x) => { x.records = {paid_deals: {[tpl.deal_id]: {route: 'note', edge: bn, total: 10, timestamp: i.timestamp - 60e3}}}; }, 'already_paid', 'his records show the deal paid');
          c('attempt-outcome-unknown', 'D-1', (i, x) => {
            x.transfer_attempts = {[tpl.deal_id]: [{deal_id: tpl.deal_id, route: 'note', edge: bn, prior: 0, prior_timestamp: 0, prior_signature: null, total: 10, timestamp: i.timestamp - 120e3 - 499,
              quote_digest: null, signed_at: iso(x.now_ms - 120e3)}]};
          }, 'attempt_outcome_unknown', 'an ordinary note of his for the deal may still apply at any time: only his owner can resolve it');
          c('transfer-window-open', 'D-1', (i, x) => {
            x.transfer_attempts = {[tpl.deal_id]: [{deal_id: tpl.deal_id, route: 'note', edge: bn, prior: 0, prior_timestamp: 0, prior_signature: null, total: 10, timestamp: i.timestamp - (i.timestamp % 1000) - 2003,
              quote_digest: null, signed_at: iso(x.now_ms - 60e3)}]};
          }, 'transfer_window_open', 'a bound note of his for the deal can still apply until its timestamp + 1 h: another kind of payment waits');
          c('needs-read-back', 'D-1', (i, x) => {
            const T0b = i.timestamp - (i.timestamp % 1000) - 3600e3 - 180e3 - 3;
            x.transfer_attempts = {[tpl.deal_id]: [{deal_id: tpl.deal_id, route: 'note', edge: bn, prior: 0, prior_timestamp: 0, prior_signature: null, total: 10, timestamp: T0b,
              quote_digest: null, signed_at: iso(T0b)}]};
          }, 'transfer_window_open', "a bound note's window has passed, but its edge was not read back: the client reads GET /edges and decides again", {needs_read_back: [bn]});
          // audit VS-1: the creditors' prior acknowledgments carry no prior timestamp, so a retry through the same issuer at
          // another T is not excluded by the first at the tracker; the identical operation (same T) is
          const sameIssuer = (i, x, T) => {
            const fb = i.from_edge.before;
            assert.ok(T > fb.timestamp && T <= i.timestamp && T % 1000 === 999, 'an earlier transfer attempt later than the held state');
            x.transfer_attempts = {[tpl.deal_id]: [{deal_id: tpl.deal_id, route: 'transfer', edge: held, prior: fb.total, prior_timestamp: fb.timestamp, prior_signature: fb.signature,
              total: fb.total - i.amount, timestamp: T, quote_digest: tpl.quote_digest, signed_at: iso(x.now_ms - 1000)}]};
          };
          c('same-prior-retry-at-another-timestamp', 'D-1', (i, x) => sameIssuer(i, x, i.timestamp - 1000), 'transfer_window_open',
            "an earlier transfer of his through the same issuer acknowledged exactly this held state at an earlier T: both could apply once A->B and A->C come back to the same totals (audit VS-1), so a retry waits for the first one's window");
          c('same-operation-signed-again', 'D-1', (i, x) => sameIssuer(i, x, i.timestamp), 'sign',
            'his earlier attempt is this very operation (the same prior state and the same T): the tracker applies at most one of the two', {quote_digest: tpl.quote_digest});
          c('stale-quote', '-', (i, x) => { x.approved_quote_digest = '00'.repeat(32); }, 'stale_quote', 'not the quote his owner approved');
          c('bad-template', '-', i => { i.amount = String(i.amount); }, 'bad_template', 'a template field of the wrong type');
          c('deal-mismatch-without-me-id', 'R7', (i, x) => { delete x.me_id; }, 'deal_mismatch', 'without its own participant id the client cannot check that it is the payer: refuse');
          c('policy-off-without-a-mandate', 'R8', (i, x) => { delete x.mandate; }, 'policy_off', "no mandate in the context: nothing is paid with a held note");
          c('policy-off-never', 'R8', (i, x) => { x.mandate.pay_with_held_notes = 'never'; }, 'policy_off', "his owner's mandate never pays with held notes");
        }
        // ---- bound credit-note templates (alice paying bob after the novation; nina's first note to alice) ----
        {
          const {tpl, now_ms} = TP.bound_C2, deal = await dealCtx('alice', tpl.deal_id);
          const base = () => [clone(tpl), ctxFor('alice', now_ms, {deal: clone(deal), payee_current_pk: K.bob.pub})];
          const c = (name, rule, f, expected, why, summary) => { const [i, x] = base(); f(i, x); push('bound_templates', `bound/${name}`, 'bound_template', rule, i, x, expected, why, summary); };
          const ab = `${tpl.issuer_pubkey}>${tpl.recipient_pubkey}`;
          c('sign', 'R12', () => {}, 'sign', 'a bound note on the edge the transfer lowered: prior acknowledgment then note, both at the timestamp ending in 997');
          c('bound-note-required', 'R12', i => { i.timestamp = i.timestamp - (i.timestamp % 1000) + 500; }, 'bound_note_required', 'bound_notes/1 is advertised (and the edge was novated): an ordinary timestamp is refused');
          c('timestamp-domain', 'R3', (i, x) => { i.timestamp = i.timestamp - (i.timestamp % 1000) + 998; x.features = []; }, 'timestamp_domain', 'without bound_notes/1 and on an edge not novated: a bound note ends in 997 ms');
          c('amount-mismatch', 'R7', i => { i.total += 1; }, 'amount_mismatch', 'the note adds more than the agreed price');
          c('wrong-destination', 'R7', (i, x) => { x.payee_current_pk = other; }, 'wrong_destination', "the recipient is not the payee's current key");
          c('not-my-edge', 'R6', i => { i.issuer_pubkey = K.bob.pub; }, 'not_my_edge', 'a note from another key');
          c('bad-prior-signature', 'R2', i => { i.prior_note.signature = otherSig(i.prior_note, tpl.issuer_pubkey, tpl.recipient_pubkey); }, 'bad_prior_signature', 'the prior note shown is not signed by her key');
          c('deal-mismatch-without-me-id', 'R7', (i, x) => { delete x.me_id; }, 'deal_mismatch', 'without its own participant id the client cannot check that it is the payer: refuse');
          c('transfer-window-open', 'D-1', (i, x) => {
            const T = i.timestamp - (i.timestamp % 1000) - 1001, held = `${K.carol.pub}>${K.alice.pub}`;
            x.transfer_attempts = {[tpl.deal_id]: [{deal_id: tpl.deal_id, route: 'transfer', edge: held, prior: 9, prior_timestamp: T - 60e3, prior_signature: signHex(K.carol, M(K.carol.pub, K.alice.pub, 9, T - 60e3)),
              total: 4, timestamp: T, quote_digest: '22'.repeat(32), signed_at: iso(x.now_ms - 60e3)}]};
          }, 'transfer_window_open', 'a payment by transfer of hers for this deal can still apply until its timestamp + 1 h');
          // audit VS-1, the note route's twin of D-2 c: no bound note of hers brings her edge back to the prior a later bound
          // note of hers (another deal) acknowledged while that one can still apply
          c('payment-attempt', 'D-2 c', (i, x) => {
            const Tb = i.timestamp + 1000, other = 'vd_00000000000000ac';
            x.transfer_attempts = {[other]: [{deal_id: other, route: 'note', edge: ab, prior: i.total, prior_timestamp: i.timestamp - 60e3, prior_signature: signHex(K.alice, M(K.alice.pub, K.bob.pub, i.total, i.timestamp - 60e3)),
              total: i.total + 2, timestamp: Tb, quote_digest: null, signed_at: iso(x.now_ms)}]};
          }, 'payment_attempt', 'a later bound note of hers for another deal acknowledged the total this note brings her edge to, and could still apply after it');
          const nb = TP.bound_N2, dealN = await dealCtx('nina', nb.tpl.deal_id);
          push('bound_templates', 'bound/sign-new-edge', 'bound_template', 'R12', clone(nb.tpl), ctxFor('nina', nb.now_ms, {deal: dealN, payee_current_pk: K.alice.pub}), 'sign',
            'the first note on an edge: prior total 0 and prior_note null; the prior acknowledgment is M(I,R,0,T)');
        }
      }
    } catch (e) { sdump(); throw e; }
    if (process.env.VALUN_VECTORS_DEBUG) sdump();
  }
  // ==== CIRCULATION END ==============================================================================================

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
// The output folder: next to this file, or VALUN_VECTORS_OUT (to compare two runs without touching the committed files).
const OUT = path.resolve(process.env.VALUN_VECTORS_OUT || here);
const write = (file, obj) => { fs.writeFileSync(path.join(OUT, file), typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj, null, 1) + '\n'); return file; };
const canon = await canonicalVectors();
const st = await statementVectors();
const notesV = noteVectors();
const sigs = signatureVectors();
const valid = await validationVectors();
const transcript = await transcriptVectors();
crypto.randomBytes = realRandomBytes;
if (EXPORTED) fs.rmSync(EXPORTED, {recursive: true, force: true});

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
if (CIRCULATION_VECTORS) {
  let text = JSON.stringify({meta: META('Circulating credit (release v16, PROTOCOL.md 15.3 and 18): timestamp residues, the 80-byte messages every operation signs, quote digests, the pay statement, tracker requests with the stand-in tracker v3.1 outcome, and the decisions of the client signing firewall', {
    tiers: {core: 'bytes every implementation MUST agree on (messages, signatures, canonical quote, pay statement)',
      circulation: 'client-side rules of circulating credit (residue classes, novation.quote_digest, novation.pay_statement): checked for a client that declares circulation/1 (or is required to)',
      consent: 'the client signing firewall: given the item or template and the context, sign exactly these slots or refuse with this code (normative, PROTOCOL.md 15.3); checked for a client that declares circulation/1 (or is required to)',
      edge: 'tracker-side outcomes (the stand-in tracker v3.1): informative for clients'},
    decisions: 'consents[], payer_templates[], bound_templates[]: input (a GET /consents item, a transfer template or a bound credit-note template, as the server produced it in transcript.json, or changed to break one rule), ctx (the evaluator context: me_pk, me_id, now_ms, pins, records, signed, transfer_attempts, novated_edges, features, deal, payee_current_pk, approved_quote_digest, consent_policy, mandate, issuer_ids, edges; verify is the Basis verifier), expected "sign" with slots (in order) and their messages, or {refuse: code}; summary: fields the evaluation summary must also show'}),
    ...CIRCULATION_VECTORS}, null, 1);
  for (const [value, placeholder] of CIRCULATION_REDACT) text = text.split(value).join(placeholder);
  for (const value of CIRCULATION_REDACT.keys()) assert.ok(!text.includes(value));
  text = text.replace(/"@@int:(\d+)@@"/g, '$1');      // exact integers beyond 2^53 (timestamps[])
  write('circulation.json', text);
}
const count = (xs, f) => xs.reduce((m, x) => ({...m, [f(x)]: (m[f(x)] || 0) + 1}), {});
console.log(JSON.stringify({
  canonical: count(canon, v => v.tier), statements: count(st.vectors, v => v.kind), statement_negatives: st.negative_signatures.length,
  basis_notes: notesV.vectors.length, basis_note_negatives: notesV.negative_signatures.length, basis_signatures: sigs.length, terms_validation: valid.length,
  transcript_steps: JSON.parse(transcript).steps.length, transcript_client_calls: JSON.parse(transcript).steps.filter(s => s.client_call).length,
  ...(CIRCULATION_VECTORS ? {circulation: Object.fromEntries(Object.entries(CIRCULATION_VECTORS).map(([k, v]) => [k, v.length]))} : {}),
}, null, 1));
