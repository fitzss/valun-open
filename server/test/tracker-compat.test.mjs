// Opt-in tracker compatibility test (design §3.9, §12 step 2): data Valun wrote on the tracker it ships today (VALUN_OLD_BINS,
// Basis 3df7ed93) opens on tracker v3.2 (VALUN_NEW_BINS) exactly as it was, and data v3.2 wrote opens on the old binary
// again. Not part of `npm test` (scripts/run-tests.mjs leaves it out): it runs only when VALUN_OLD_BINS and VALUN_NEW_BINS
// are set (each a staged release folder with basis_server and examples/valun_signer); otherwise every step is skipped.
// The binaries run in WSL valun-ic1 (BASIS_RUNNER=wsl, the default on Windows), on port 3142.
//   (a) seed through Valun on the old binary: the pilot (HTTP, mode off) in its token denomination: credit notes on
//       several pairs, out-of-order updates (a pair raised again after newer pairs), a note whose timestamp ends in 999 ms
//       (a client may choose it; the old tracker takes it), a first note with a 0 total (Valun's Basis driver) that a
//       deal then raises; the demo desk (lib/valun.mjs) in erg: offers accepted and issued, out of order, a 0-total first
//       note, and two uploaded acceptance policies;
//   (b) the old binary restarted on the same folder: a snapshot of every /notes field, the count, every per-edge read
//       (both denominations), the per-issuer and per-recipient lists, the policies, the key status and GET /tracker/state
//       (local_digest); nothing was lost across the restart;
//   (c) a copy of the folder opened by the new binary with the scanner layout (pure_credit): the snapshot is identical
//       and its local_digest is the old binary's after its restart; Valun reads the same ledger and reconciliation;
//   (d) through Valun (the pilot in circulation mode on, the issuer, payee and set-off members signing through the server
//       signer): a bound note on the edge last written at 999 ms and on another migrated edge, a payment by transfer of
//       a migrated note, and a set-off of migrated edges; then a restart: everything, the digest included, is unchanged,
//       and every edge reconciles exactly with Valun's journal;
//   (e) a copy of the v3.2-written folder opened by the old binary (node layout): it reads the same notes, lists,
//       policies, key status and digest, and Valun's ledger through it is the same.
// One tracker process at a time, each stopped (SIGTERM through its pid file) before its folder is copied or reopened, so
// no two processes ever share a folder. Run folders live only under /home/valun, in one folder this test creates and
// removes (nothing else is removed); the Windows-side state folders are temporary and removed too.
// Run: MSYS2_ENV_CONV_EXCL=VALUN_ VALUN_OLD_BINS=/home/valun/valun-app-bins-20261105T024815Z/t/release \
//        VALUN_NEW_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release node --test test/tracker-compat.test.mjs
// The signer is the new release's (VALUN_SIGNER overrides it): tracker v3.2's prior acknowledgments need its
// prior-ack-message.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Basis, makeSignerRunner, capabilitiesFrom} from '../lib/basis.mjs';
import {Store} from '../lib/store.mjs';
import {Valun} from '../lib/valun.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest} from '../lib/pilot/novation.mjs';
import {edgeKey} from '../lib/pilot/journal.mjs';
import {Clearing} from '../lib/pilot/clearing.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {runner} from './tracker-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WSL = 'C:/Windows/System32/wsl.exe', D = ['-d', 'valun-ic1', '-u', 'valun'];
// Git Bash rewrites /home/... in environment variables for Windows programs: undo that (or set MSYS2_ENV_CONV_EXCL=VALUN_).
const unGit = v => (v && /^[A-Za-z]:[\\/].*?[\\/]Git[\\/](home[\\/].*)$/i.test(v) ? '/' + /[\\/]Git[\\/](home[\\/].*)$/i.exec(v)[1].replace(/\\/g, '/') : v);
const OLD_BINS = unGit(process.env.VALUN_OLD_BINS), NEW_BINS = unGit(process.env.VALUN_NEW_BINS);
const OLD_BIN = OLD_BINS && `${OLD_BINS}/basis_server`, NEW_BIN = NEW_BINS && `${NEW_BINS}/basis_server`;
const SIGNER = unGit(process.env.VALUN_SIGNER) || (NEW_BINS && `${NEW_BINS}/examples/valun_signer`);
const PORT = 3142, TRACKER = `http://127.0.0.1:${PORT}`, ADMIN = 'tracker-compat-admin', ADM = {'x-valun-admin': ADMIN};
const DENOMS = Object.freeze(['erg', PILOT_DENOMINATION]);
const FOLDER_RE = /^\/home\/valun\/valun-app-compat-\d{8}T\d{6}Z-\d+-[0-9a-f]{8}$/;
const skipWhy = !OLD_BINS || !NEW_BINS ? 'opt-in: set VALUN_OLD_BINS and VALUN_NEW_BINS (the release folders of the old tracker and of tracker v3.2)'
  : runner !== 'wsl' ? 'this test runs the tracker binaries in WSL valun-ic1 (BASIS_RUNNER=wsl), with run folders under /home/valun' : null;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = 3600e3;

let work = null, live = null, broken = null;              // the folder this test made; the tracker running now
const temps = [];                                        // Windows-side temporary folders this test made
let basis, ergBasis, pilot = null, server = null, base = null, desk = null, deskDir = null, pilotDir = null;
const people = {}, serverKeys = new Map(), snaps = {};
const sh = (script, ...args) => spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', script, 'sh', ...args], {encoding: 'utf8', windowsHide: true});
const clean = s => String(s ?? '').replace(/\0/g, '').trim();

// ---------- trackers: one process at a time on a folder of `work` ----------
async function answering() {
  try { const r = await fetch(TRACKER + '/', {signal: AbortSignal.timeout(1500)}); return {status: r.status, text: await r.text()}; } catch { return null; }
}
// Starts `bin` on run folder `dir` (a subfolder of `work`) with config layout `layout`, through basis/run-tracker.sh.
async function launch(bin, dir, layout) {
  assert.equal(live, null, 'one tracker at a time');
  const other = await answering();
  if (other) throw new Error(`something already answers on ${TRACKER} (HTTP ${other.status}); this test needs the port to itself`);
  const env = {BASIS_PORT: String(PORT), BASIS_SERVED_TOKEN_ID: PILOT_TOKEN_ID, BASIS_SERVED_TOKEN_SYMBOL: 'PC', BASIS_CONFIG_LAYOUT: layout, RUST_LOG: 'warn'};
  const child = spawn(WSL, [...D, '--exec', '/usr/bin/env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), `${work}/run-tracker.sh`, `${work}/${dir}`, bin],
    {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const t = {child, dir, bin, layout, exit: null, out: '', err: ''};
  child.on('exit', (code, signal) => { t.exit ??= {code, signal}; });
  child.on('error', e => { t.exit ??= {error: e.message}; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { t.out = (t.out + d).slice(-20000); });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { t.err = (t.err + d).slice(-20000); });
  live = t;
  for (const end = Date.now() + 30000; ;) {
    if (t.exit) { live = null; throw new Error(`${bin} (${layout} layout) on ${dir} exited (${JSON.stringify(t.exit)}): ${clean(t.err).slice(-1500)} ${clean(t.out).slice(-500)}`); }
    const h = await answering();
    if (h?.status === 200 && /Basis Tracker/.test(h.text)) break;
    if (Date.now() > end) { await stop(); throw new Error(`${bin} on ${dir} did not answer within 30 s: ${clean(t.err).slice(-1500)}`); }
    await sleep(250);
  }
  t.nft = /TRACKER_NFT_ID=([0-9a-f]{64})/.exec(t.out)?.[1] ?? null;
  return t;
}
// SIGTERM through the run folder's pid file (only while the process this test started runs), then wait until it has
// exited and the port is free: a folder is copied or reopened only once nothing runs on it.
async function stop() {
  const t = live;
  if (!t) return;
  if (!t.exit) sh('[ -s "$1/tracker.pid" ] && kill "$(cat "$1/tracker.pid")"', `${work}/${t.dir}`);
  for (let i = 0; i < 150 && !t.exit; i++) await sleep(100);
  if (!t.exit) { t.child.kill(); for (let i = 0; i < 50 && !t.exit; i++) await sleep(100); }
  for (let i = 0; i < 50 && await answering(); i++) await sleep(100);
  const alive = sh('[ -s "$1/tracker.pid" ] && kill -0 "$(cat "$1/tracker.pid")" 2>/dev/null && echo alive || echo stopped', `${work}/${t.dir}`);
  live = null;
  assert.match(clean(alive.stdout), /stopped/, `the tracker on ${t.dir} has stopped`);
  assert.equal(await answering(), null, `port ${PORT} is free again`);
}
function copyFolder(from, to) {
  assert.equal(live, null, 'no tracker runs while a folder is copied');
  const r = sh('[ ! -e "$2" ] && cp -a "$1" "$2"', `${work}/${from}`, `${work}/${to}`);
  assert.equal(r.status, 0, `cp -a ${from} ${to}: ${clean(r.stderr)}`);
}
const sha256Of = bin => { const r = sh('sha256sum -- "$1"', bin), m = /^([0-9a-f]{64})\s/.exec(r.stdout || ''); assert.ok(m, `sha256sum ${bin}: ${clean(r.stderr)}`); return m[1]; };
async function trackerGet(p) {
  const r = await fetch(TRACKER + p, {signal: AbortSignal.timeout(10000)});
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* a plain-text answer */ }
  return [r.status, body];
}
async function trackerCaps() { const [s, b] = await trackerGet('/capabilities'); return capabilitiesFrom(s, typeof b === 'object' ? b : null); }

// ---------- the snapshot: everything the tracker serves about the participants' keys ----------
// age_seconds (derived from the clock) is left out of every note.
const strip = n => (n && typeof n === 'object' && !Array.isArray(n) ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'age_seconds')) : n);
const sortNotes = l => (Array.isArray(l) ? l.map(strip).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : l);
const stripBody = b => (b && typeof b === 'object' && Array.isArray(b.data) ? {...b, data: sortNotes(b.data)} : b && typeof b === 'object' && b.data && typeof b.data === 'object' ? {...b, data: strip(b.data)} : b);
async function snapshot() {
  const keys = Object.entries(people).map(([name, P]) => [name, P.pubkey]), snap = {};
  const [ns, nb] = await trackerGet('/notes'), list = Array.isArray(nb?.data) ? nb.data : null;
  snap.notes_status = ns; snap.count = list?.length ?? null;
  snap.notes = Object.fromEntries((list ?? []).map(n => [`${n.issuer_pubkey}>${n.recipient_pubkey} ${n.denomination}`, strip(n)]).sort(([a], [b]) => (a < b ? -1 : 1)));
  snap.edges = {};
  for (const [i, ik] of keys) for (const [r, rk] of keys) if (i !== r) for (const dn of DENOMS) {
    const [s, b] = await trackerGet(`/notes/issuer/${ik}/recipient/${rk}?denomination=${encodeURIComponent(dn)}`);
    snap.edges[`${i}>${r} ${dn === 'erg' ? 'erg' : 'PC'}`] = [s, stripBody(b)];
  }
  snap.by_issuer = {}; snap.by_recipient = {}; snap.policies = {}; snap.key_status = {};
  for (const [n, k] of keys) {
    const [s1, b1] = await trackerGet(`/notes/issuer/${k}`), [s2, b2] = await trackerGet(`/notes/recipient/${k}`);
    snap.by_issuer[n] = [s1, stripBody(b1)]; snap.by_recipient[n] = [s2, stripBody(b2)];
    snap.policies[n] = await trackerGet(`/acceptance/policy/${k}`);
    snap.key_status[n] = await trackerGet(`/key-status/${k}`);
  }
  const [ss, sb] = await trackerGet('/tracker/state');
  snap.state = ss === 200 && sb?.data && typeof sb.data === 'object' ? sb.data : [ss, sb];
  return snap;
}
const digestOf = snap => (snap.state && typeof snap.state === 'object' && !Array.isArray(snap.state) ? snap.state.local_digest : null);
// Every field the tracker serves is the same in `got` as in `ref` (the digest too, unless digest: false).
function same(what, ref, got, {digest = true} = {}) {
  assert.equal(got.notes_status, 200, `${what}: GET /notes answers`);
  assert.equal(got.count, ref.count, `${what}: the note count`);
  assert.deepEqual(got.notes, ref.notes, `${what}: every note, every field`);
  assert.deepEqual(got.edges, ref.edges, `${what}: every per-edge read, in both denominations`);
  assert.deepEqual(got.by_issuer, ref.by_issuer, `${what}: the per-issuer note lists`);
  assert.deepEqual(got.by_recipient, ref.by_recipient, `${what}: the per-recipient note lists`);
  assert.deepEqual(got.policies, ref.policies, `${what}: the acceptance policies`);
  assert.deepEqual(got.key_status, ref.key_status, `${what}: the key status`);
  const {local_digest: a, ...restRef} = ref.state, {local_digest: b, ...restGot} = got.state;
  assert.match(String(b), /^[0-9a-f]{2,}$/, `${what}: GET /tracker/state has data.local_digest`);
  if (digest) assert.equal(b, a, `${what}: data.local_digest`);
  assert.deepEqual(restGot, restRef, `${what}: the rest of GET /tracker/state`);
}

// ---------- Valun: the pilot (HTTP) and the demo desk ----------
async function serve(p) {
  pilot = p;
  const routes = createPilotRoutes({pilot: p, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6, pilotIpReadLimitPerMinute: 1e6}, adminTokenHash: sha(ADMIN)});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function unserve() { if (server) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); } server = null; pilot = null; }
async function call(method, p, body, token, headers = {}) {
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers},
    body: body == null ? undefined : JSON.stringify(body)});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 600)); return r.body; };
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
const msg = async (I, R, total, ts) => (await basis.noteMessage({issuer: I, recipient: R, total, timestamp: ts})).message_hex;
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) of edge I>R's state (X, p) at T.
const pa = async (I, R, total, priorTs, ts) => (await basis.priorAckMessage({issuer: I, recipient: R, priorTotal: total, priorTimestamp: priorTs, timestamp: ts})).message_hex;
async function party(name) {
  const handle = `compat-${name.toLowerCase()}-${rnd(2)}`;
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `tracker-compat test, ${name}`}), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  const P = {name, id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 1000, max_accept_per_deal: 100, max_accept_per_issuer: 1000}, P.owner));
  people[name] = P;
  return P;
}
function terms(payer, payee, price) {
  const t = Date.now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: pilot.basis.nft, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + rnd(8), version: 1, prior_terms_hash: null,
    nonce: rnd(16), proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Compatibility job', description: `A job for the tracker compatibility test (${rnd(4)}).`, deliverable: 'any text'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(t + 48 * H).toISOString(), offer_expires_at: new Date(t + 24 * H).toISOString()};
}
// A deal taken to "delivered": the payer proposes, the payee accepts and delivers.
async function delivered(X, Y, price) {
  const t = terms(X, Y, price), h = termsHash(t);
  const d = ok(await call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(X, statements.propose(h))}, X.agent), 201);
  assert.equal(ok(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: await sign(Y, statements.accept(h))}, Y.agent)).status, 'agreed');
  const content = `work ${rnd(4)}`, dh = sha(content);
  ok(await call('POST', `/deals/${d.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Y, statements.deliver(h, dh))}, Y.agent));
  return d.id;
}
// The payer pays with its own note: ordinary (the template's timestamp, or one the client chose: `timestamp`), or bound
// (?bound=1: the note and the issuer's prior acknowledgment PA of the pair's note, asserting its timestamp).
async function payOwn(X, id, {timestamp = null, bound = false} = {}) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template${bound ? '?prior=1&bound=1' : ''}`, null, X.agent));
  const ts = timestamp ?? tpl.timestamp;
  const note = {total: tpl.total, timestamp: ts, signature: await basis.signHex(X.pubkey, await msg(tpl.issuer_pubkey, tpl.recipient_pubkey, tpl.total, ts), X.secret),
    ...(bound ? {prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp,
      prior_signature: await basis.signHex(X.pubkey, await pa(tpl.issuer_pubkey, tpl.recipient_pubkey, tpl.prior_total, tpl.prior_timestamp, ts), X.secret)} : {})};
  const v = ok(await call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(X, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: note}, X.agent));
  assert.equal(v.status, 'note_issued', JSON.stringify(v.credit_note)?.slice(0, 400));
  return v;
}
const edge = async (I, R, b = basis) => { const n = await b.note(I.pubkey, R.pubkey); return n && {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature}; };
// What Valun reads through its driver: the pilot's ledger and reconciliation, the demo desk's ledger (no ages).
async function valunView(p = pilot) {
  const l = await p.ledger();
  return {pilot_ledger: l.map(x => JSON.stringify(x)).sort(), pilot_reconcile: (await p.reconcile(l)).map(x => JSON.stringify(x)).sort(),
    desk_ledger: (await desk.ledger()).map(({age_seconds: _, ...x}) => JSON.stringify(x)).sort(), desk_reconcile: (await desk.reconcile()).map(x => JSON.stringify(x)).sort()};
}

// ---------- setup and cleanup ----------
before(async () => {
  if (skipWhy) return;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const dir = `/home/valun/valun-app-compat-${stamp}-${process.pid}-${rnd(4)}`;
  assert.match(dir, FOLDER_RE);
  // A new folder (mkdir without -p fails if it exists): nothing else uses it.
  const put = spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', 'mkdir "$1" && cat > "$1/run-tracker.sh" && chmod 700 "$1/run-tracker.sh"', 'sh', dir],
    {input: fs.readFileSync(path.join(root, 'basis', 'run-tracker.sh')), windowsHide: true});
  if (put.status !== 0) throw new Error(`cannot create ${dir} in WSL: ${clean(put.stderr)}`);
  work = dir;
});
after(async () => {
  await unserve().catch(() => {});
  try { await stop(); } catch (e) { console.warn(`stopping the tracker: ${e.message}`); }
  if (work && FOLDER_RE.test(work)) {
    if (broken || process.env.VALUN_TEST_KEEP) console.log(`tracker-compat: ${broken ? `failed at "${broken}"; ` : ''}removing ${work}`);
    const r = spawnSync(WSL, [...D, '--exec', '/bin/rm', '-rf', '--one-file-system', work], {encoding: 'utf8', windowsHide: true});
    if (r.status !== 0) console.warn(`could not remove ${work}: ${clean(r.stderr)}`);
  }
  for (const d of temps) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});
// Each step builds on the one before: once a step fails, the later ones are skipped.
const step = (name, fn) => test(name, {timeout: 10 * 60e3}, async t => {
  if (skipWhy) return t.skip(skipWhy);
  if (broken) return t.skip(`an earlier step failed (${broken})`);
  try { await fn(t); } catch (e) { broken = name.slice(0, 60); throw e; }
});

// =================================================================================================================
step('the binaries: the old one is a tracker before v3 (no capabilities); the new one is tracker v3.2, its capabilities validate and its sha256 is pinned', async () => {
  snaps.oldSha = sha256Of(OLD_BIN); snaps.newSha = sha256Of(NEW_BIN);
  assert.notEqual(snaps.oldSha, snaps.newSha, 'two different binaries');
  assert.ok(TRACKER_SHA256_PINS.includes(snaps.newSha), `the new basis_server ${snaps.newSha} is pinned in lib/pilot/pins.mjs`);
  assert.ok(!TRACKER_SHA256_PINS.includes(snaps.oldSha), 'the old basis_server is not pinned');
  console.log(`old ${OLD_BIN} sha256 ${snaps.oldSha}\nnew ${NEW_BIN} sha256 ${snaps.newSha}\nsigner ${SIGNER}; run folders in ${work}`);
});

step('(a) seed through Valun on the old binary: the pilot (token: several pairs, out-of-order updates, a note at 999 ms, a 0-total first note then raised) and the demo desk (erg: offers issued out of order, a 0-total first note, two acceptance policies)', async () => {
  const t = await launch(OLD_BIN, 'old', 'node');
  assert.equal(await trackerCaps(), null, 'the old binary has no GET /capabilities');
  snaps.nft = t.nft;
  const runSigner = makeSignerRunner({mode: 'wsl', signerPath: SIGNER});
  basis = new Basis({trackerUrl: TRACKER, trackerNftId: t.nft, denomination: PILOT_DENOMINATION, runSigner});
  ergBasis = new Basis({trackerUrl: TRACKER, trackerNftId: t.nft, denomination: 'erg', runSigner});
  pilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-compat-pilot-')); temps.push(pilotDir);
  deskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-compat-desk-')); temps.push(deskDir);
  // The pilot as server.mjs runs it against this tracker: mode off (an old tracker has no capabilities).
  await serve(new Pilot({store: new PilotStore(pilotDir), basis, circulation: 'off', trackerCaps: null, log: () => {}}));
  assert.equal(pilot.mode, 'off');
  const A = await party('A'), B = await party('B'), C = await party('C'), Dp = await party('D');
  await payOwn(A, await delivered(A, B, 5));                    // A>B 5
  await payOwn(B, await delivered(B, C, 3));                    // B>C 3
  await payOwn(C, await delivered(C, A, 4));                    // C>A 4
  await payOwn(A, await delivered(A, C, 2));                    // A>C 2
  await payOwn(A, await delivered(A, B, 3));                    // A>B 8: an older pair raised again after newer ones
  // D>A: the payer's client chooses a timestamp ending in 999 ms (any in (last, now] is a valid note here).
  const top = Date.now() - 1500, at999 = top - (((top - 999) % 1000) + 1000) % 1000;
  await payOwn(Dp, await delivered(Dp, A, 2), {timestamp: at999});
  assert.deepEqual([(await edge(Dp, A)).timestamp % 1000, (await edge(Dp, A)).total], [999, 2], 'the old tracker holds D>A at 999 ms');
  // B>D: a first note with a 0 total (Valun's Basis driver), then a deal raises it.
  const zero = await basis.issueNote({issuer: B.pubkey, recipient: Dp.pubkey, total: 0, secretHex: B.secret});
  assert.equal(zero.response.status, 201, JSON.stringify(zero.response));
  assert.equal((await edge(B, Dp)).total, 0);
  await payOwn(B, await delivered(B, Dp, 2));                   // B>D 0 -> 2
  // The demo desk in erg: participants with keys in its own (temporary) store, offers accepted and issued.
  desk = new Valun({store: new Store(deskDir), basis: ergBasis});
  const E1 = await desk.createParticipant({name: 'Compat One'}), E2 = await desk.createParticipant({name: 'Compat Two'}), E3 = await desk.createParticipant({name: 'Compat Three'});
  Object.assign(people, {E1, E2, E3});
  const issue = async (I, R, nano) => { const o = await desk.createOffer({issuerId: I.id, recipientId: R.id, amount: nano}); assert.equal((await desk.decide(o.id, {actorId: R.id, decision: 'accept'})).status, 'issued'); };
  await issue(E1, E2, '1500000000');
  await issue(E2, E3, '700000000');
  await issue(E1, E3, '250000000');
  await issue(E1, E2, '300000000');                              // E1>E2 raised again after newer pairs
  const zeroErg = await ergBasis.issueNote({issuer: E3.pubkey, recipient: E1.pubkey, total: 0, secretHex: desk.store.getSecret(E3.id)});
  assert.equal(zeroErg.response.status, 201, JSON.stringify(zeroErg.response));
  await desk.setPolicy(E3.id, {mode: 'accept-any'});
  await desk.setPolicy(E2.id, {mode: 'whitelist', trustedIds: [E1.id], maxDebt: '5000000000'});
  snaps.live = await snapshot();
  const n = snaps.live.notes, at = (I, R, dn) => n[`${people[I].pubkey}>${people[R].pubkey} ${dn}`];
  assert.equal(snaps.live.count, 10, 'ten notes: six pairs in the pilot token, four in erg');
  assert.deepEqual([at('A', 'B', PILOT_DENOMINATION).amount_collected, at('D', 'A', PILOT_DENOMINATION).timestamp % 1000, at('B', 'D', PILOT_DENOMINATION).amount_collected,
    at('E1', 'E2', 'erg').amount_collected, at('E3', 'E1', 'erg').amount_collected], [8, 999, 2, 1800000000, 0]);
  assert.deepEqual([snaps.live.policies.E2[0], snaps.live.policies.E3[0], snaps.live.policies.A[0]], [200, 200, 404], 'two uploaded policies');
  assert.ok((await valunView()).pilot_reconcile.every(r => JSON.parse(r).status === 'match'), 'Valun reconciles every pilot edge');
});

step('(b) the old binary restarted on the same folder: every note, list, policy and key status is as before the restart; this snapshot (and its digest) is the reference', async () => {
  await stop();
  const t = await launch(OLD_BIN, 'old', 'node');
  assert.equal(t.nft, snaps.nft, 'the same tracker identity');
  snaps.ref = await snapshot();
  same('the old binary after a restart vs before it', snaps.live, snaps.ref, {digest: false});
  snaps.refView = await valunView();
  console.log(`old binary: local_digest live ${digestOf(snaps.live)}, after restart ${digestOf(snaps.ref)} (the reference)`);
});

step('(c) a copy opened by tracker v3.2 with the scanner layout (pure_credit): every field identical, the digest equal to the old binary\'s after its restart; Valun reads the same ledger and reconciliation', async () => {
  await stop();
  copyFolder('old', 'v3');
  const t = await launch(NEW_BIN, 'v3', 'scanner');
  assert.equal(t.nft, snaps.nft);
  assert.match(clean(t.err), /config layout scanner, pure_credit = true/, 'run-tracker.sh wrote the scanner layout with pure_credit');
  const caps = await trackerCaps();
  assert.ok(validateCaps(caps).ok, `capabilities: ${validateCaps(caps).reason}`);
  assert.deepEqual([caps.pure_credit, caps.onchain_edges, caps.novations_disabled_reason], [true, 0, null]);
  snaps.caps = caps;
  snaps.migrated = await snapshot();
  same('tracker v3.2 on the migrated copy vs the old binary after its restart', snaps.ref, snaps.migrated, {digest: true});
  assert.deepEqual(await valunView(), snaps.refView, 'Valun\'s pilot ledger, reconciliation and demo-desk ledger are the same');
});

step('(d) through Valun on tracker v3.2 (the pilot in circulation mode on): bound notes on migrated edges (one last written at 999 ms), a payment by transfer of a migrated note, a set-off of migrated edges; a restart leaves everything and the digest unchanged, and every edge reconciles exactly', async () => {
  // The same pilot state, now served by v16 in mode on (the upgrade): migrate() keeps the journal written in mode off.
  await unserve();
  const p = new Pilot({store: new PilotStore(pilotDir), basis, circulation: 'on', trackerCaps: snaps.caps, trackerSha256: snaps.newSha, log: () => {}});
  assert.equal(p.mode, 'on');
  await serve(p);
  const {A, B, C, D: Dp} = people, migrated = new Set(Object.values(snaps.ref.notes).filter(n => n.denomination === PILOT_DENOMINATION).map(n => edgeKey(n.issuer_pubkey, n.recipient_pubkey)));
  // A, B and C sign their consents through the server signer (a stub with their test keys); D is a client.
  for (const P of [A, B, C]) serverKeys.set(P.id, P);
  pilot.serverSigner = {has: id => serverKeys.has(id), signFor: async (id, hexMsg) => basis.signHex(serverKeys.get(id).pubkey, hexMsg, serverKeys.get(id).secret)};
  for (const P of [A, B, C, Dp]) ok(await call('PUT', '/owner/mandate', {accept_transfers: true, accept_notes_from: 'any', novate_own_debt: true, auto_clear: true, pay_with_held_notes: 'when_asked'}, P.owner));
  const nets = {}, net = async P => ok(await call('GET', `/participants/${P.id}`)).public_position.net;
  // A bound note on the edge last written at 999 ms (D>A 2 -> 3), and on A>B (8 -> 10).
  const d1 = await payOwn(Dp, await delivered(Dp, A, 1), {bound: true});
  assert.deepEqual([d1.credit_note.note.timestamp % 1000, d1.credit_note.prior_total, (await edge(Dp, A)).total], [997, 2, 3]);
  const d2 = await payOwn(A, await delivered(A, B, 2), {bound: true});
  assert.deepEqual([d2.credit_note.note.timestamp % 1000, (await edge(A, B)).total], [997, 10]);
  // B pays C 3 with A's note: A>B 10 -> 7, A>C 2 -> 5 (A and C sign at once: applied in the request).
  const id = await delivered(B, C, 3), tpl = ok(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent));
  const T = tpl.timestamp, X = tpl.from_edge.before.total, Y = tpl.to_edge.before?.total ?? 0, a = tpl.amount, pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  assert.deepEqual([T % 1000, X, Y, a, migrated.has(tpl.from_edge.edge), migrated.has(tpl.to_edge.edge)], [999, 10, 2, 3, true, true]);
  const q = quoteDigest({network: NETWORK, tracker_nft_id: pilot.basis.nft, denomination: PILOT_DENOMINATION, deal_id: id, terms_hash: tpl.terms_hash,
    deliverable_sha256: tpl.deliverable_sha256, issuer_pubkey: A.pubkey, payer_pubkey: B.pubkey, payee_pubkey: C.pubkey, amount: a});
  assert.equal(tpl.quote_digest, q);
  const slot = async (R, total) => basis.signHex(B.pubkey, await msg(A.pubkey, R, total, T), B.secret);
  for (const P of [A, B, C]) nets[P.name] = await net(P);
  const paid = ok(await call('POST', `/deals/${id}/pay-by-transfer`, {issuer_id: A.id, terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, quote_digest: q,
    timestamp: T, from_prior_total: X, to_prior_total: Y, from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await sign(B, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), pay_signature: await sign(B, circulationStatements.pay(id, q)),
    signatures: {[`${A.pubkey}>${B.pubkey}:prior`]: await basis.signHex(B.pubkey, await pa(A.pubkey, B.pubkey, X, pX, T), B.secret), [`${A.pubkey}>${B.pubkey}:new`]: await slot(B.pubkey, X - a),
      [`${A.pubkey}>${C.pubkey}:new`]: await slot(C.pubkey, Y + a)}}, B.agent));
  assert.deepEqual([paid.status, paid.transfer.state], ['paid_by_transfer', 'applied']);
  assert.deepEqual([await net(A), await net(B), await net(C)], [nets.A, nets.B - 3, nets.C + 3], 'A owes the same; B paid 3 with its claim on A; C gained 3');
  // A set-off of the cycles among A, B and C (every member server-run: applied at once), by the clearing engine, attached
  // only now (with it attached, a note or a transfer that closes a cycle is set off at once): its batch, on admin request
  // (not started: no timers). Every edge it changes is a migrated one, and no net position moves.
  pilot.clearing = new Clearing({pilot});
  for (const P of [A, B, C]) nets[P.name] = await net(P);
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  // A proposal between server-run members may wait a moment for a timestamp ending in 998 ms (Clearing.defer): until every
  // proposal has ended, nothing is read.
  for (const end = Date.now() + 20000; Object.values(pilot.s.setoffs).some(o => o.state === 'collecting' || o.state === 'applying') && Date.now() < end;) await sleep(200);
  assert.ok(!Object.values(pilot.s.setoffs).some(o => o.state === 'collecting' || o.state === 'applying'), 'every set-off proposal has ended');
  const setoffs = Object.values(pilot.s.setoffs).filter(o => o.state === 'applied');
  assert.ok(setoffs.length >= 1, `a set-off applied: ${JSON.stringify(Object.values(pilot.s.setoffs).map(o => [o.state, o.result?.code]))}`);
  for (const o of setoffs) assert.ok(o.edges.every(e => migrated.has(e.edge)), `set-off ${o.id} changes only migrated edges`);
  assert.deepEqual([await net(A), await net(B), await net(C)], [nets.A, nets.B, nets.C], 'the set-off moved no net position');
  // The last tracker write was a set-off: v3 rebuilds its tree canonically, so the live digest is the restart digest.
  snaps.written = await snapshot();
  await stop();
  const t = await launch(NEW_BIN, 'v3', 'scanner');
  assert.equal(t.nft, snaps.nft);
  snaps.v3restarted = await snapshot();
  same('tracker v3.2 after a restart vs before it', snaps.written, snaps.v3restarted, {digest: true});
  const rows = await pilot.reconcile();
  assert.ok(rows.length === 6 && rows.every(r => r.status === 'match' && r.exact === true), `every edge reconciles exactly with Valun's journal: ${JSON.stringify(rows.filter(r => r.status !== 'match' || !r.exact))}`);
  snaps.v3View = await valunView();
  const changed = Object.keys(snaps.v3restarted.notes).filter(k => JSON.stringify(snaps.v3restarted.notes[k]) !== JSON.stringify(snaps.ref.notes[k]));
  console.log(`tracker v3.2: digest after the writes ${digestOf(snaps.written)}, after a restart ${digestOf(snaps.v3restarted)}; ${changed.length} of ${snaps.v3restarted.count} notes written on v3.2; set-offs ${setoffs.map(o => `${o.id} (${o.edges.length} edges, ${o.amount} PC)`).join(', ')}`);
});

step('(e) a copy of the v3.2-written folder opened by the old binary (node layout): the same notes, lists, policies, key status and digest; Valun reads the same ledger through it', async () => {
  await stop();
  copyFolder('v3', 'back');
  const t = await launch(OLD_BIN, 'back', 'node');
  assert.equal(t.nft, snaps.nft);
  assert.equal(await trackerCaps(), null, 'the old binary again');
  const rolled = await snapshot();
  same('the old binary on a copy of the v3.2-written data vs tracker v3.2', snaps.v3restarted, rolled, {digest: true});
  const view = await valunView();
  assert.deepEqual([view.pilot_ledger, view.desk_ledger], [snaps.v3View.pilot_ledger, snaps.v3View.desk_ledger], 'Valun\'s ledgers read through the old binary are the same');
  await stop();
});
