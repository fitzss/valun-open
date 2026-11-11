// Release v16 audit fixes, at the unit level (a Pilot over a stub tracker and a throwaway store, so these run with any
// tracker binaries, in the default `npm test`; the scripts run as child processes):
//   - SV-ROB-1: pilot-edge-log.jsonl is never read as one string: startup, the per-edge index and GET /edges stream it
//     (a large log under --max-old-space-size=128), and a GET /edges page reads only its own lines (an offset index);
//   - SV-PRIV-1: the public GET /ledger keeps v15's reconciliation rows in every mode (owner decision 9, design 4.9);
//   - SV-ROB-2: ledger() looks keys up in one map (no participant scan per note), and a consent poll of a member with no
//     edge takes neither the lock nor a tracker read;
//   - SV-DOS-1: members that never signed a set-off (or whose last one expired unsigned) hold at most one collecting
//     set-off each and at most max_collecting_unproven in all, so part of the global cap stays for members that sign;
//   - SV-LIVE-1: an ended transfer attempt holds its to-edge (A->C, without the payer) only until its fallback_after;
//   - SV-AUTH-1: the payer's owner cannot resolve an attempt as applied while the payee's edge shows it did not apply;
//   - MIG-1: the downgrade check purges every unapplied note signature (sha256 kept), and a v16 server on a tracker
//     without capabilities raises an alarm for the circulation records the 3df7ed93 tracker would revive;
//   - MIG-3: the downgrade check is in the image, and the entrypoint runs it in maintenance mode before anything starts;
//   - MIG-4: an attempt left unresolved can be resolved in every mode but off;
//   - MIG-5: ordinary templates skip the reserved residues also when the startup capabilities read failed;
//   - R-1: a payment by transfer never gets the (edge, T) of an earlier attempt of the same deal.
// Run: node --test test/audit-fixes.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK} from '../lib/pilot/core.mjs';
import {appendEntries, EDGE_LOG_FILE} from '../lib/pilot/journal.mjs';
import {fallbackAfter} from '../lib/pilot/novation.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {Clearing, LIMITS, eligibleGraph, boundedCycles, planProposals} from '../lib/pilot/clearing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-audit-')); dirs.push(d); return d; };
// As test/operations.test.mjs: a test that reads repository files this copy of the app lacks is skipped, with the reason,
// in the container image's copy (VALUN_APP_COPY=image: the image and its rehearsal hold only the image's files), and
// fails anywhere else ('missing <file>').
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sigSha = s => crypto.createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex');
const H = 3600e3, DAY = 24 * H, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;      // a timestamp ending in `ms` a little before t
const note = (total, timestamp, signature = '02' + hex(64)) => ({amount_collected: String(total), amount_redeemed: '0', timestamp, signature});

// A Pilot in `mode` over a stub tracker: `edges` (Map '<issuer>><recipient>' -> tracker note) is what basis.note() and
// basis.allNotes() read. P pays every deal, Q is paid, A and B are other participants. `clock.t` is the Pilot's clock.
function world({clock = {t: Date.now()}, mode = 'on', caps = V3_CAPS, log = () => {}} = {}) {
  const dir = tmp(), edges = new Map();
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async (i, r) => { const n = edges.get(`${i}>${r}`); return n ? {issuer_pubkey: i, recipient_pubkey: r, denomination: PILOT_DENOMINATION, ...n} : null; },
    allNotes: async () => [...edges.entries()].map(([k, n]) => { const [i, r] = k.split('>'); return {issuer_pubkey: i, recipient_pubkey: r, denomination: PILOT_DENOMINATION, ...n}; }),
    capabilities: async () => V3_CAPS, noteMessage: async () => ({message_hex: '00'.repeat(80)}), priorAckMessage: async () => ({message_hex: '00'.repeat(105)})};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: caps, trackerSha256: PIN, trackerPins: [PIN], log});
  const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE, auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'},
    mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null});
  const add = (...hs) => hs.map(h => { const x = person(h); pilot.s.participants[x.id] = x; return x; });
  const [P, Q, A, B] = add('au-payer', 'au-payee', 'au-issuer', 'au-other');
  return {pilot, edges, clock, dir, P, Q, A, B, add};
}
function addDeal(w, status, {price = 3} = {}) {
  const {pilot, P, Q, clock} = w, id = 'vd_' + hex(8);
  const terms = {network: NETWORK, tracker_nft_id: '0'.repeat(64), denomination: PILOT_DENOMINATION, deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, service: {title: 'audit job', description: 'synthetic', deliverable: 'text'},
    price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
  const v = {v: 1, by: P.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
  const d = {id, payer: P.id, payee: Q.id, created_at: iso(clock.t), status, versions: [v], history: [], agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)},
    delivery: {by: Q.id, sha256: hex(32), content: 'x', at: iso(clock.t)}};
  pilot.s.deals[id] = d;
  return d;
}
// An issued note Valun journaled on edge I>R, also on the stub tracker (so the edge reconciles exactly).
function issued(w, I, R, total, ts) {
  const sig = '02' + hex(64);
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total, total_after: total, timestamp: ts, signature: sig}]);
  w.edges.set(`${I.pubkey}>${R.pubkey}`, note(total, ts, sig));
}
// A payment-by-transfer attempt of deal d (A's note held by P, paid to Q) in `state`, as the Pilot records it.
function attempt(w, d, state, {T = ending(w.clock.t - 60e3, 999), result = null, amount = 3, from = {total: 5, timestamp: T - 30e3, signature: '02' + hex(64)}, to = null} = {}) {
  const {pilot, A, P, Q} = w;
  const t = pilot.newTransfer(d, {A, B: P, C: Q, a: amount, T, from, to, quote: hex(32)});
  t.state = state; t.result = result ?? {code: state, at: iso(w.clock.t)};
  for (const s of ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient']) t.slots[s] = {signature: '02' + hex(64), by: 'x', at: iso(w.clock.t)};
  if (!['outcome_unknown', 'inconsistent', 'collecting', 'awaiting_owner', 'applying', 'applied'].includes(state)) { t.fallback_after = fallbackAfter(T); pilot.purgeTransfer(t); }
  pilot.s.transfers[t.id] = t;
  d.transfer_ids = [...(d.transfer_ids || []), t.id];
  d.payment = {method: 'transfer', transfer_id: t.id};
  return t;
}
// Calls the pilot router with a fake request; returns {status, body}.
async function call(routes, {method = 'GET', path: p, token = null, body = null, ip = '203.0.113.9'}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {method, headers: token ? {authorization: `Bearer ${token}`} : {}, socket: {remoteAddress: ip}, [Symbol.asyncIterator]: async function* () { yield* chunks; }};
  let out = null;
  const send = (res, status, b) => { out = {status, body: b}; };
  try { await routes(req, {}, new URL('http://x/pilot/v1' + p), send, () => ip); }
  catch (e) { out = {status: e.status ?? 500, body: {error: e.code, message: e.message, ...(e.extra || {})}}; }
  return out;
}
const runNode = (args, {env = {}, cwd = root} = {}) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, args, {cwd, env: {...process.env, ...env}});
  let out = '', err = '';
  c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
  c.on('error', reject); c.on('close', code => resolve({code, out, err}));
});

// ---------------------------------------------------------------------------------------------------------------
// SV-ROB-1
test('SV-ROB-1: a 150 000-entry pilot-edge-log.jsonl (about 90 MiB) under --max-old-space-size=128: the restart, the per-edge index and GET /edges pages all stream it, never one string, and answer in full', async () => {
  const dir = tmp();
  const r = await runNode(['--max-old-space-size=128', path.join(root, 'test', 'fixtures', 'large-journal.mjs'), dir, '150000']);
  assert.equal(r.code, 0, `the child process failed (exit ${r.code}):\n${r.out}\n${r.err.split('\n').slice(0, 12).join('\n')}`);
  const res = JSON.parse(r.out.trim().split('\n').at(-1));
  assert.ok(res.log_mib > 80, `precondition: a large log (${res.log_mib} MiB)`);
  assert.deepEqual(res.first_page, {length: 200, first_seq: 1, last_seq: 1 + 199 * 375, next_seq: 1 + 199 * 375}, 'the caller\'s first 200 entries, oldest first');
  assert.equal(res.second_page_first_seq, 1 + 200 * 375);
  assert.equal(res.pages_total, 400, 'the caller\'s 400 entries in two pages, and none for a stranger');
  assert.deepEqual([res.edge_entries, res.partial], [150000 / 3, false], 'the per-edge index holds every entry on the edge');
  assert.equal(res.dead_proven, true, 'the D-2 e proof reads the index');
});

test('SV-ROB-1: once indexed, a GET /edges page reads only the caller\'s own older lines (an offset index), never the whole file; appended entries are found without a rescan from the start', async () => {
  const w = world(), {pilot, P, Q, A, B} = w;
  const [S] = w.add('au-stranger');
  // 3 entries of P's, then 1500 between A and B push them out of the 500-entry tail: only the log file holds them.
  for (let i = 0; i < 3; i++) appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, delta: 1, total_after: i + 1, timestamp: 1000 + i, signature: '02' + hex(64)}]);
  for (let i = 0; i < 1500; i++) appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: A.pubkey, recipient_pubkey: B.pubkey, delta: 1, total_after: i + 1, timestamp: 2000 + i, signature: '02' + hex(64)}]);
  pilot.save();
  const LOG = path.join(w.dir, EDGE_LOG_FILE), size = fs.statSync(LOG).size;
  assert.ok(pilot.s.edge_log_tail[0].seq > 3 && size > 500e3, 'precondition');
  const p2 = new Pilot({store: new PilotStore(w.dir), basis: pilot.basis, now: () => w.clock.t, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  // Count what is read of the log file: whole-file reads and the bytes of positional reads.
  const orig = {readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync};
  const logFds = new Set();
  let whole = 0, bytes = 0;
  fs.readFileSync = function (f, ...rest) { if (String(f).endsWith(EDGE_LOG_FILE)) whole++; return orig.readFileSync.call(this, f, ...rest); };
  fs.openSync = function (f, ...rest) { const fd = orig.openSync.call(this, f, ...rest); if (String(f).endsWith(EDGE_LOG_FILE)) logFds.add(fd); return fd; };
  fs.readSync = function (fd, ...rest) { const n = orig.readSync.call(this, fd, ...rest); if (logFds.has(fd)) bytes += n; return n; };
  fs.closeSync = function (fd) { logFds.delete(fd); return orig.closeSync.call(this, fd); };
  try {
    const first = await p2.edges(p2.s.participants[P.id], {since: 0});             // builds the index (one pass)
    assert.deepEqual(first.journal.map(e => e.seq), [1, 2, 3]);
    whole = 0; bytes = 0;
    for (let i = 0; i < 5; i++) {
      assert.deepEqual((await p2.edges(p2.s.participants[P.id], {since: 0})).journal.map(e => [e.seq, e.total_after]), [[1, 1], [2, 2], [3, 3]]);
      assert.deepEqual((await p2.edges(p2.s.participants[S.id], {since: 0})).journal, [], 'a caller with no entries');
    }
    assert.equal(whole, 0, 'no whole-file read per page');
    assert.ok(bytes < 5 * 3 * 1024, `5 pages of 3 entries read ${bytes} bytes of a ${size}-byte log`);
    // New entries, appended and rolled out of the tail by 600 more: found by reading only what was appended.
    appendEntries(p2, [{kind: 'setoff', ref: 'vs_' + hex(8), issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, delta: -1, total_after: 2, timestamp: 9000, signature: '02' + hex(64)}]);
    for (let i = 0; i < 600; i++) appendEntries(p2, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: A.pubkey, recipient_pubkey: B.pubkey, delta: 1, total_after: 1501 + i, timestamp: 9001 + i, signature: '02' + hex(64)}]);
    p2.save();
    assert.ok(p2.s.edge_log_tail[0].seq > 1504, 'precondition: the set-off entry is in the file only');
    bytes = 0;
    const page = await p2.edges(p2.s.participants[P.id], {since: 3});
    assert.deepEqual(page.journal.map(e => [e.seq, e.kind, e.delta]), [[1504, 'setoff', -1]]);
    assert.ok(bytes < 600 * 700, `only the appended part was read (${bytes} bytes)`);
  } finally { Object.assign(fs, orig); }
});

// ---------------------------------------------------------------------------------------------------------------
// SV-PRIV-1
test('SV-PRIV-1: the public GET /ledger keeps v15\'s reconciliation rows in every mode (no per-edge transfer or set-off history); the journal columns stay internal', async () => {
  for (const mode of ['off', 'bound', 'sandbox', 'on']) {
    const w = world({mode}), {pilot, A, P, Q} = w, t0 = w.clock.t - 60e3;
    const sAB = '02' + hex(64), sAC = '02' + hex(64);
    appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: A.pubkey, recipient_pubkey: P.pubkey, delta: 8, total_after: 8, timestamp: t0, signature: '02' + hex(64)}]);
    appendEntries(pilot, [{kind: 'transfer_out', ref: 'vt_' + hex(8), issuer_pubkey: A.pubkey, recipient_pubkey: P.pubkey, delta: -3, total_after: 5, timestamp: t0 + 1999, signature: sAB},
      {kind: 'transfer_in', ref: 'vt_x', issuer_pubkey: A.pubkey, recipient_pubkey: Q.pubkey, delta: 3, total_after: 3, timestamp: t0 + 1999, signature: sAC}]);
    w.edges.set(`${A.pubkey}>${P.pubkey}`, note(5, t0 + 1999, sAB)); w.edges.set(`${A.pubkey}>${Q.pubkey}`, note(3, t0 + 1999, sAC));
    const r = await call(createPilotRoutes({pilot, cfg: {}}), {path: '/ledger'});
    assert.equal(r.status, 200);
    assert.equal(pilot.mode, mode);
    for (const row of r.body.reconciliation) assert.deepEqual(Object.keys(row), ['issuer', 'recipient', 'tracker_total', 'issued_via_valun', 'status'], `mode ${mode}: v15's row`);
    assert.deepEqual(r.body.reconciliation.map(x => [x.tracker_total, x.issued_via_valun, x.status]), [[5, 5, 'match'], [3, 3, 'match']], `mode ${mode}: the journal's expected totals, nothing more`);
    assert.ok(!JSON.stringify(r.body).includes('transferred'), `mode ${mode}: no transfer history`);
    if (pilot.circulating) {
      const full = await pilot.reconcile();
      assert.deepEqual(full.map(x => [x.transferred_out, x.transferred_in, x.exact]), [[3, 0, true], [0, 3, true]], 'internal rows keep the journal columns');
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// SV-ROB-2
test('SV-ROB-2: ledger() does not scan the participants per note; a consent poll of a member with no eligible edge takes neither the lock nor a tracker read', async () => {
  const w = world(), {pilot, clock} = w;
  const many = w.add(...Array.from({length: 120}, (_, i) => `au-m${String(i).padStart(3, '0')}`));
  let ts = clock.t - 10 * H;
  for (let i = 0; i < 300; i++) { const a = many[i % 120], b = many[(i + 1 + Math.floor(i / 120)) % 120]; w.edges.set(`${a.pubkey}>${b.pubkey}`, note(1, ts += 1000)); }
  let scans = 0;
  const real = pilot.s.participants;
  pilot.store.state.participants = new Proxy(real, {ownKeys(t) { scans++; return Reflect.ownKeys(t); }});
  try {
    const l = await pilot.ledger();
    assert.ok(l.length === 300 && l.every(x => x.issuer && x.recipient), 'precondition: every key resolved');
    assert.ok(scans <= 3, `participants scanned ${scans} times for ${l.length} notes`);
  } finally { pilot.store.state.participants = real; }
  // A member that declared the set-off role but holds no edge: its poll returns at once.
  const [S] = w.add('au-sybil');
  S.client_features = {consents: true, roles: ['setoff'], at: iso(clock.t)}; S.last_seen_agent = iso(clock.t);
  pilot.clearing = new Clearing({pilot});
  let serials = 0, reads = 0;
  const serial = pilot.serial.bind(pilot), allNotes = pilot.basis.allNotes;
  pilot.serial = fn => { serials++; return serial(fn); };
  pilot.basis.allNotes = async () => { reads++; return allNotes(); };
  assert.deepEqual(await pilot.clearing.proposeFor(S), []);
  assert.deepEqual([serials, reads], [0, 0], 'no lock, no tracker read');
  // One with a claim and a debt (a possible cycle) still gets its search.
  const [U, V] = [many[0], many[1]];
  for (const x of [U, V]) { x.client_features = {consents: true, roles: ['setoff', 'issuer', 'creditor'], at: iso(clock.t)}; x.last_seen_agent = iso(clock.t); }
  issued(w, U, V, 2, ts += 1000); issued(w, V, U, 2, ts += 1000);
  await pilot.clearing.proposeFor(U);
  assert.equal(serials, 1, 'a member with edges both ways is searched under the lock');
});

// ---------------------------------------------------------------------------------------------------------------
// SV-DOS-1
test('SV-DOS-1: never-signing members cannot fill the global cap: each holds at most one collecting set-off, and those with members that never signed stop at max_collecting_unproven, so a member that signs still gets its proposal', async () => {
  const w = world(), {pilot, clock} = w;
  const [X, Y] = w.add('au-agent-x', 'au-agent-y');                       // server-run (the sandbox agents)
  pilot.serverSigner = {has: id => id === X.id || id === Y.id, signFor: async () => '02' + hex(64)};
  const sybils = w.add(...Array.from({length: 50}, (_, i) => `au-sybil${i}`));
  const [L] = w.add('au-legit');
  let ts = clock.t - H;
  for (const s of [...sybils, L]) for (const g of [X, Y]) { issued(w, s, g, 3, ts += 1000); issued(w, g, s, 3, ts += 1000); }
  const declare = p => { p.client_features = {consents: true, roles: ['setoff', 'issuer', 'creditor'], at: iso(clock.t)}; p.last_seen_agent = iso(clock.t); };
  for (const s of sybils) declare(s);
  pilot.save();
  const clearing = pilot.clearing = new Clearing({pilot});
  assert.equal(clearing.limits.max_collecting_total, 50);
  for (const s of sybils) await clearing.proposeFor(s);
  const live = Object.values(pilot.s.setoffs).filter(o => o.state === 'collecting');
  const per = new Map();
  for (const o of live) for (const id of o.members) per.set(id, (per.get(id) ?? 0) + 1);
  assert.ok(sybils.every(s => (per.get(s.id) ?? 0) <= 1), 'a member that never signed holds at most one collecting set-off');
  assert.ok(live.length <= LIMITS.max_collecting_unproven && live.length < 50, `the never-signing members hold ${live.length} of the 50`);
  // A member with a signing record (it signed its last set-off) is proposed to although the never-signing ones collect.
  declare(L);
  pilot.s.clearing.signed_at = {...(pilot.s.clearing.signed_at || {}), [L.id]: iso(clock.t - H)};
  const made = await clearing.proposeFor(L);
  assert.ok(made.some(o => o?.members?.includes(L.id)), `a proposal for the member that signs: ${JSON.stringify(made.map(o => o?.skipped ?? o?.state))}`);
});

test('SV-DOS-1: the plan: proposals with a member that has not signed stop at max_collecting_unproven (40 of the 50), one per such member; members that sign use the whole cap', () => {
  const ids = Array.from({length: 100}, (_, i) => `vp_${String(i).padStart(12, '0')}`), key = i => '02' + String(i).padStart(64, '0');
  const participants = Object.fromEntries(ids.map((id, i) => [id, {id, pubkey: key(i), member: true, sandbox: false, server_run: false, present: true}]));
  const edges = [];
  for (let i = 0; i < 100; i += 2) for (const [a, b] of [[i, i + 1], [i + 1, i]])                        // 50 disjoint 2-cycles
    edges.push({edge: `${key(a)}>${key(b)}`, issuer_pubkey: key(a), recipient_pubkey: key(b), total: 2, outstanding: 2, timestamp: 1000 + a, signature: 'aa', reconciled: true, reserved: 0, exclusive: false, busy: false});
  const g = eligibleGraph({mode: 'on', participants, edges}), cycles = boundedCycles(g).cycles;
  assert.equal(planProposals(g, cycles, {now: 0}).length, 50, 'members that sign: the whole cap');
  assert.equal(planProposals(g, cycles, {now: 0, unproven: new Set(ids)}).length, LIMITS.max_collecting_unproven, 'members that never signed: 40');
  assert.equal(planProposals(g, cycles, {now: 0, unproven: new Set(ids), collectingUnproven: 39, collectingTotal: 39}).length, 1 + 0, 'one more up to 40; the rest of the cap is not theirs');
  assert.equal(planProposals(g, cycles, {now: 0, unproven: new Set(ids.slice(0, 50)), collectingUnproven: 40, collectingTotal: 40}).length, 10, 'members that sign still get the last 10');
  assert.equal(planProposals(g, cycles, {now: 0, unproven: new Set(ids), collecting: new Map([[ids[0], 1]])}).filter(p => p.members.includes(key(0))).length, 0, 'one at a time each');
});

test('SV-DOS-1: a set-off signature records the member as one that signs; an expiry it left unsigned forgets that', async () => {
  const w = world(), {pilot, clock} = w;
  const [X] = w.add('au-agent-x');
  pilot.serverSigner = {has: id => id === X.id, signFor: async () => '02' + hex(64)};
  const {P: U} = w, at = iso(clock.t);
  const o = {id: 'vs_' + hex(8), kind: 'setoff', state: 'collecting', created_at: at, expires_at: iso(clock.t + 1000), updated_at: at, members: [U.id, X.id], amount: 2,
    edges: [{edge: `${U.pubkey}>${X.pubkey}`, issuer: {id: U.id, pubkey: U.pubkey}, recipient: {id: X.id, pubkey: X.pubkey}, decrease: 1, before: {total: 1, timestamp: 1, signature: 'aa'}, new_total: 0, timestamp: 2, revision: 1, server_only: false, slots: {issuer: null, recipient: {signature: 'bb', by: X.id, at}}},
      {edge: `${X.pubkey}>${U.pubkey}`, issuer: {id: X.id, pubkey: X.pubkey}, recipient: {id: U.id, pubkey: U.pubkey}, decrease: 1, before: {total: 1, timestamp: 1, signature: 'cc'}, new_total: 0, timestamp: 2, revision: 1, server_only: false, slots: {issuer: {signature: 'dd', by: X.id, at}, recipient: null}}],
    cycles: [], edge_set: hex(16), history: []};
  pilot.s.clearing.signed_at = {[U.id]: at};
  pilot.s.setoffs[o.id] = o;
  clock.t += 2000;
  pilot.sweepSetoff(o);
  assert.equal(o.state, 'expired');
  assert.equal(pilot.s.clearing.signed_at[U.id], undefined, 'its unsigned expiry makes it a member that has not signed again');
});

// ---------------------------------------------------------------------------------------------------------------
// SV-LIVE-1
test('SV-LIVE-1: an ended payment attempt of a deal not yet paid holds its from-edge (the payer\'s claim) for set-offs, but its to-edge (A->C, without the payer) only until its fallback_after', async () => {
  const w = world(), {pilot, clock} = w;
  const d = addDeal(w, 'payment_due'), t = attempt(w, d, 'cancelled');
  assert.ok(pilot.paymentAttemptHolds().has(t.to_edge.edge) && pilot.paymentAttemptHolds().has(t.from_edge.edge), 'within its window both edges are held');
  clock.t = t.fallback_after + 1;
  const holds = pilot.paymentAttemptHolds();
  assert.ok(holds.has(t.from_edge.edge), 'the payer\'s own claim stays held while the deal is unpaid');
  assert.equal(holds.has(t.to_edge.edge), false, 'the payee\'s edge is released once the attempt is dead');
  // An unresolved attempt keeps both, whatever its age.
  const d2 = addDeal(w, 'payment_due'), u = attempt(w, d2, 'outcome_unknown', {T: ending(clock.t - 3 * H, 999), result: {code: 'attempt_outcome_unknown', at: iso(clock.t), edges: {from: 'unknown', to: 'unknown'}}});
  assert.ok(pilot.paymentAttemptHolds().has(u.to_edge.edge));
});

// ---------------------------------------------------------------------------------------------------------------
// SV-AUTH-1
test('SV-AUTH-1: the payer\'s owner cannot resolve an attempt as applied while the payee\'s edge, read back, shows it did not apply there (409 payee_edge_not_applied, nothing changed); it can when that edge holds the new state', async () => {
  const w = world(), {pilot, P, clock} = w;
  const unknownWith = (to) => {
    const d = addDeal(w, 'payment_due');
    const t = attempt(w, d, 'outcome_unknown', {result: {code: 'attempt_outcome_unknown', at: iso(clock.t), edges: {from: 'unknown', to}}, to: {total: 4, timestamp: clock.t - 90e3, signature: '02' + hex(64)}});
    return {d, t};
  };
  // The payee's edge read back at its prior state (untouched): applied is refused, the deal stays blocked for the owner.
  const a = unknownWith('prior');
  w.edges.set(a.t.to_edge.edge, note(4, a.t.to_edge.before.timestamp, a.t.to_edge.before.signature));
  await assert.rejects(pilot.resolveAttempt(P, a.d.id, a.t.id, {outcome: 'applied'}), e => e instanceof PilotError && e.code === 'payee_edge_not_applied' && e.status === 409);
  assert.deepEqual([a.t.state, a.d.status, pilot.s.counters.edge_seq], ['outcome_unknown', 'payment_due', 0], 'nothing changed, nothing journaled');
  const r = await pilot.resolveAttempt(P, a.d.id, a.t.id, {outcome: 'not_applied'});
  assert.equal(r.resolution.outcome, 'not_applied', 'not_applied stays open to the owner');
  // Stored 'changed' (the edge moved, but before T): refused too.
  const c = unknownWith('changed');
  w.edges.set(c.t.to_edge.edge, note(9, c.t.timestamp - 5000));
  await assert.rejects(pilot.resolveAttempt(P, c.d.id, c.t.id, {outcome: 'applied'}), e => e.code === 'payee_edge_not_applied');
  // Stored 'unknown', and the payee's edge now holds exactly the attempt's new state: applied is accepted.
  const u = unknownWith('unknown');
  w.edges.set(u.t.to_edge.edge, note(u.t.to_edge.new_total, u.t.timestamp, u.t.slots.issuer_to.signature));
  assert.equal((await pilot.resolveAttempt(P, u.d.id, u.t.id, {outcome: 'applied'})).resolution.outcome, 'applied');
  assert.equal(u.d.status, 'paid_by_transfer');
  // Stored 'new' (the payee's edge showed the new state when it was decided): accepted without a read.
  const n = unknownWith('new');
  pilot.basis.note = async () => { throw new Error('no read expected'); };
  assert.equal((await pilot.resolveAttempt(P, n.d.id, n.t.id, {outcome: 'applied'})).resolution.outcome, 'applied');
});

// ---------------------------------------------------------------------------------------------------------------
// MIG-1
function v16State(now) {
  const deal = (id, status, more = {}) => ({id, status, payer: 'vp_aaaaaaaaaaaa', payee: 'vp_bbbbbbbbbbbb', versions: [{v: 1, by: 'vp_aaaaaaaaaaaa'}], history: [], ...more});
  const n = (state, ts, extra = {}) => ({state, issuer_pubkey: '02' + 'a'.repeat(64), recipient_pubkey: '02' + 'b'.repeat(64), prior_total: 0, amount: 3,
    note: {total: 3, timestamp: ts, signature: 'f'.repeat(128), ...extra}});
  return {participants: {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa'}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb'}}, invites: {}, approvals: {},
    deals: {
      // Paid by transfer after its bound note F failed: F's signatures are kept (the scenario of MIG-1).
      vd_0000000000000001: deal('vd_0000000000000001', 'paid_by_transfer', {credit_note: n('failed', now - 2 * 3600e3 + 997, {prior_signature: 'e'.repeat(128)}),
        payment: {method: 'transfer', transfer_id: 'vt_0000000000000001', applied_at: iso(now - 3600e3)}, transfer_ids: ['vt_0000000000000001'],
        rejected_notes: [n('rejected_by_owner', now - 3 * 3600e3 + 997, {prior_signature: 'd'.repeat(128)})]}),
      // An ordinary note that failed (note_failed: the payer pays with a new note) and a voided one.
      vd_0000000000000002: deal('vd_0000000000000002', 'note_failed', {credit_note: n('failed', now - 3600e3 + 123), void_notes: [n('void_key_revoked', now - 4 * 3600e3 + 5)]}),
      // Recorded: on the tracker already; kept.
      vd_0000000000000003: deal('vd_0000000000000003', 'note_issued', {credit_note: n('recorded', now - 5 * 3600e3 + 7)}),
      // Held for its owner (an ordinary note v15 still sends once approved): kept.
      vd_0000000000000004: deal('vd_0000000000000004', 'completion_awaiting_owner', {credit_note: n('signed', now - 60e3 + 11)}),
    },
    transfers: {vt_0000000000000001: {id: 'vt_0000000000000001', deal_id: 'vd_0000000000000001', state: 'applied', timestamp: now - 3600e3 + 999, expires_at: iso(now - 3000e3)}},
    setoffs: {}, edges: {}, edge_log_tail: [], counters: {edge_seq: 0, journal_backfilled: true}};
}
test('MIG-1: the downgrade check purges every note signature the tracker did not record and v15 will not send (sha256 kept; the backup keeps the file as it was); held and recorded notes keep theirs; --dry-run only counts them', async () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z'), dir = tmp(), file = path.join(dir, 'pilot-state.json');
  fs.writeFileSync(file, JSON.stringify(v16State(now), null, 1));
  const text = fs.readFileSync(file, 'utf8');
  const dry = await runNode([path.join(root, 'scripts', 'pilot-downgrade-check.mjs'), file, '--dry-run', '--now', iso(now)]);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /unapplied note signatures purged \(sha256 kept\): 4 notes in 2 deals \(not written\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'dry run: unchanged');
  const r = await runNode([path.join(root, 'scripts', 'pilot-downgrade-check.mjs'), file, '--now', iso(now)]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /unapplied note signatures purged \(sha256 kept\): 4 notes in 2 deals: vd_0000000000000001, vd_0000000000000002/);
  assert.match(r.out, /the backup keeps them/);
  const s = JSON.parse(fs.readFileSync(file, 'utf8')), before = JSON.parse(text);
  const d1 = s.deals.vd_0000000000000001, d2 = s.deals.vd_0000000000000002;
  for (const [x, was] of [[d1.credit_note, before.deals.vd_0000000000000001.credit_note], [d1.rejected_notes[0], before.deals.vd_0000000000000001.rejected_notes[0]],
    [d2.credit_note, before.deals.vd_0000000000000002.credit_note], [d2.void_notes[0], before.deals.vd_0000000000000002.void_notes[0]]]) {
    assert.equal(x.note.signature, undefined, 'purged');
    assert.equal(x.note.prior_signature, undefined, 'purged');
    assert.equal(x.note.signature_sha256, sigSha(was.note.signature), 'its sha256 kept');
    if (was.note.prior_signature) assert.equal(x.note.prior_signature_sha256, sigSha(was.note.prior_signature));
    assert.deepEqual([x.note.total, x.note.timestamp], [was.note.total, was.note.timestamp]);
  }
  assert.deepEqual(s.deals.vd_0000000000000003, before.deals.vd_0000000000000003, 'a recorded note is kept');
  assert.deepEqual(s.deals.vd_0000000000000004, before.deals.vd_0000000000000004, 'a note held for its owner is kept (v15 sends it once approved)');
  const backup = fs.readdirSync(dir).find(f => f.includes('v16-backup'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), text, 'the backup is the file as it was');
  const audit = fs.readFileSync(path.join(dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(audit[0].signatures_purged, {notes: 4, deals: ['vd_0000000000000001', 'vd_0000000000000002']});
});

test('MIG-1: a v16 server whose pilot tracker reports no capabilities (the 3df7ed93 build) raises one alarm, logged and audited, for unapplied note signatures that tracker would accept although v16 counts them dead; a v15 state raises none', async () => {
  const logs = [], clock = {t: Date.parse('2026-11-09T12:00:00.000Z')};
  const dir = tmp(), st = v16State(clock.t);
  for (const d of Object.values(st.deals)) d.versions = [];
  st.edges = {[`02${'a'.repeat(64)}>02${'b'.repeat(64)}`]: {novated: true, expected_total: 3}};   // a transfer or set-off changed the pair
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify(st));
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], capabilities: async () => null};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: 'off', log: m => logs.push(m)});
  assert.equal(logs.filter(l => l.includes('ALARM')).length, 0, 'nothing while the capabilities are not read');
  pilot.trackerCaps = null;                                   // as server.mjs sets it from GET /capabilities
  pilot.trackerCaps = null;
  const alarms = logs.filter(l => l.includes('ALARM'));
  assert.equal(alarms.length, 1, alarms.join('\n'));
  assert.match(alarms[0], /4 unapplied note signatures \(deals vd_0000000000000001, vd_0000000000000002\).*pilot-downgrade-check\.mjs/);
  const audit = fs.readFileSync(path.join(dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.type === 'pilot.revivable_signatures');
  assert.deepEqual(audit.map(x => [x.notes, x.deals]), [[4, ['vd_0000000000000001', 'vd_0000000000000002']]]);
  // A v15 state (no circulation history: ordinary notes only, no novated edge) on the same tracker: no alarm.
  const logs2 = [], dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'pilot-state.json'), JSON.stringify({participants: {}, invites: {}, approvals: {}, deals: {vd_0000000000000002: {...st.deals.vd_0000000000000002, void_notes: []}}}));
  const p2 = new Pilot({store: new PilotStore(dir2), basis, now: () => clock.t, circulation: 'off', log: m => logs2.push(m)});
  p2.trackerCaps = null;
  assert.deepEqual(logs2.filter(l => l.includes('ALARM')), []);
});

// ---------------------------------------------------------------------------------------------------------------
// MIG-3
test('MIG-3: the downgrade check is in the image (Dockerfile, .dockerignore, the rehearsal\'s list), and the entrypoint\'s maintenance mode runs it on the volume\'s state before any tracker or the app starts, and exits with its result', async t => {
  if (!needs(t, 'Dockerfile', '.dockerignore', 'scripts/rehearse-container.mjs', 'scripts/docker-entrypoint.sh', 'scripts/pilot-downgrade-check.mjs')) return;
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.match(docker, /^COPY .*scripts\/pilot-downgrade-check\.mjs.* \/opt\/valun\/app\/scripts\/$/m);
  assert.match(ignore, /^!scripts\/pilot-downgrade-check\.mjs$/m);
  const R = await import(new URL('../scripts/rehearse-container.mjs', import.meta.url).href);
  assert.ok(R.APP_FILES.includes('scripts/pilot-downgrade-check.mjs'));
  const entry = fs.readFileSync(path.join(root, 'scripts', 'docker-entrypoint.sh'), 'utf8').replace(/\r\n/g, '\n');
  const m = entry.indexOf('VALUN_MAINTENANCE');
  assert.ok(m > 0 && m < entry.indexOf('run-tracker.sh" "$DATA/tracker"') && m < entry.indexOf('node "$ROOT/app/server.mjs"'), 'before the trackers and the app');
  // Run it (bash: Git for Windows on Windows, /bin/bash elsewhere; never the WSL launcher in System32).
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(bash)) { t.skip(`needs ${bash}`); return; }
  const opt = tmp(), data = tmp();
  fs.mkdirSync(path.join(opt, 'app', 'scripts'), {recursive: true}); fs.mkdirSync(path.join(data, 'pilot'));
  fs.copyFileSync(path.join(root, 'scripts', 'pilot-downgrade-check.mjs'), path.join(opt, 'app', 'scripts', 'pilot-downgrade-check.mjs'));
  const now = Date.now(), stateFile = path.join(data, 'pilot', 'pilot-state.json');
  const runEntry = mode => new Promise((resolve, reject) => {
    const c = spawn(bash, [path.join(root, 'scripts', 'docker-entrypoint.sh').replace(/\\/g, '/')], {env: {...process.env, VALUN_ROOT: opt.replace(/\\/g, '/'), VALUN_DATA: data.replace(/\\/g, '/'), VALUN_MAINTENANCE: mode, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`}});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject); c.on('close', code => resolve({code, out, err}));
  });
  // A state with a transfer still collecting: refused, exit 1, nothing started or written.
  const busy = v16State(now); busy.transfers.vt_0000000000000009 = {id: 'vt_0000000000000009', deal_id: 'vd_0000000000000002', state: 'collecting', timestamp: now - 1, expires_at: iso(now + 600e3)};
  fs.writeFileSync(stateFile, JSON.stringify(busy));
  const refused = await runEntry('downgrade-check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.out, /REFUSED/);
  assert.deepEqual(fs.readdirSync(path.join(data, 'pilot')), ['pilot-state.json'], 'nothing written');
  assert.ok(!fs.existsSync(path.join(data, 'tracker')), 'no tracker started');
  // A drained state: dry run, then the real run (backup and audit line); exit 0 without starting anything.
  fs.writeFileSync(stateFile, JSON.stringify(v16State(now)));
  const dry = await runEntry('downgrade-check-dry-run');
  assert.equal(dry.code, 0, dry.out + dry.err); assert.match(dry.out, /DRY RUN, nothing written: OK for a v15 rollback/);
  const ok = await runEntry('downgrade-check');
  assert.equal(ok.code, 0, ok.out + ok.err); assert.match(ok.out, /OK for a v15 rollback/); assert.match(ok.out + ok.err, /maintenance: .*deploy release v15/);
  assert.ok(fs.readdirSync(path.join(data, 'pilot')).some(f => f.includes('v16-backup')));
  assert.ok(!fs.existsSync(path.join(data, 'tracker')), 'no tracker started');
  const unknown = await runEntry('something-else');
  assert.equal(unknown.code, 2); assert.match(unknown.err, /VALUN_MAINTENANCE/);
});

// ---------------------------------------------------------------------------------------------------------------
// MIG-4
test('MIG-4: a payment attempt left unresolved can be resolved by the payer\'s owner in every mode but off (also mode bound, and mode sandbox for a participant outside the sandbox); a resolved or ordinary attempt there is still the 404 of a route the mode does not have', async () => {
  for (const mode of ['bound', 'sandbox', 'on', 'off']) {
    const w = world({mode}), {pilot, P, clock} = w;
    P.owner_token_hash = sha('vpo_audit_owner');
    const d = addDeal(w, 'payment_due'), t = attempt(w, d, 'outcome_unknown', {result: {code: 'attempt_outcome_unknown', at: iso(clock.t), edges: {from: 'unknown', to: 'unknown'}}});
    const d2 = addDeal(w, 'payment_due'), t2 = attempt(w, d2, 'cancelled');
    const routes = createPilotRoutes({pilot, cfg: {}});
    const resolve = (dd, tt) => call(routes, {method: 'POST', path: `/owner/deals/${dd.id}/attempts/${tt.id}/resolve`, token: 'vpo_audit_owner', body: {outcome: 'not_applied'}});
    const r = await resolve(d, t);
    if (mode === 'off') { assert.equal(r.status, 404, 'mode off: the route does not exist'); assert.equal(t.state, 'outcome_unknown'); continue; }
    assert.equal(r.status, 200, `mode ${mode}: ${JSON.stringify(r.body)}`);
    assert.equal(t.state, 'resolved_not_applied');
    if (mode !== 'on') assert.equal((await resolve(d2, t2)).status, 404, `mode ${mode}: only an unresolved attempt has the route`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// MIG-5
test('MIG-5: an ordinary credit-note template skips 995-999 ms on a tracker that keeps them, also when the capabilities read at startup failed (trackerCaps null): they are read again', async () => {
  const clock = {t: Date.parse('2026-11-09T12:00:01.497Z')};       // now - 1500 ms ends in 997 ms
  const w = world({clock, mode: 'off', caps: null}), {pilot, P} = w;
  assert.equal(pilot.trackerCaps, null);
  const d = addDeal(w, 'delivered');
  const tpl = await pilot.noteTemplate(P, d.id);
  assert.ok(![995, 996, 997, 998, 999].includes(tpl.timestamp % 1000), `timestamp ${tpl.timestamp} ends in ${tpl.timestamp % 1000} ms`);
  // A tracker that really has no capabilities (3df7ed93): v15's template, unchanged.
  const w2 = world({clock, mode: 'off', caps: null});
  w2.pilot.basis.capabilities = async () => null;
  const d2 = addDeal(w2, 'delivered');
  assert.equal((await w2.pilot.noteTemplate(w2.P, d2.id)).timestamp, clock.t - 1500);
});

// ---------------------------------------------------------------------------------------------------------------
// R-1
test('R-1 and the same-prior exemption (design v3.2 section 4): after an attempt its owner rejected, a payment by transfer through the same note on the same prior state starts at once, with a later T than every earlier attempt of the deal (never the same (edge, T)); a post at an earlier attempt\'s T is stale; on another state of the note (the same total at another timestamp) it waits for the window', async () => {
  const clock = {t: Date.parse('2026-11-09T12:00:05.600Z')};
  const w = world({clock}), {pilot, A, P, Q} = w;
  for (const x of [A, Q]) { x.client_features = {consents: true, roles: ['issuer', 'creditor', 'setoff'], at: iso(clock.t)}; x.last_seen_agent = iso(clock.t); }
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'payment_due', {price: 3});
  const tpl1 = await pilot.transferTemplate(P, d.id, A.id);
  const T1 = tpl1.timestamp;
  // That first attempt was posted, its owner rejected it (void_rejected); the edges are untouched.
  attempt(w, d, 'void_rejected', {T: T1, amount: 3, from: tpl1.from_edge.before, to: tpl1.to_edge.before});
  // The same note on the same prior state (5 PC at its note's timestamp): not held back by the window (at the tracker,
  // PA(A,P,5,p,T) lets at most one of the two apply). Within T1's 999-ms window there is no later T yet (R-1): only the
  // timestamp domain makes it wait, for well under a second.
  clock.t += 300;
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id, {wait: false}), e => e instanceof PilotError && e.code === 'note_timestamp_ahead' && e.extra.retry_after_ms < 1000, '+300 ms');
  clock.t += 1000;
  const tpl2 = await pilot.transferTemplate(P, d.id, A.id, {wait: false});
  assert.ok(tpl2.timestamp > T1, `${tpl2.timestamp} > ${T1}`);
  assert.deepEqual([tpl2.from_edge.before, tpl2.from_edge.prior_timestamp, tpl2.to_edge.prior_timestamp], [tpl1.from_edge.before, tpl1.from_edge.before.timestamp, 0]);
  // A post that names the rejected attempt's T (the identical operation, which the window does not hold back) is refused
  // as stale, before any signature check.
  await assert.rejects(pilot.payByTransfer(P, d.id, {issuer_id: A.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, from_prior_total: 5, to_prior_total: 0,
    timestamp: T1, quote_digest: tpl1.quote_digest, completion_signature: '02' + hex(64), pay_signature: '02' + hex(64), signatures: {}}),
  e => e instanceof PilotError && e.code === 'transfer_stale');
  // The note in another state with the same total (its timestamp moved, before T1: the attempt is not dead by the
  // journal): a new attempt there waits for the rejected one's window (VS-1's ABA is closed only for the same state).
  const k = `${A.pubkey}>${P.pubkey}`, moved = note(5, tpl1.from_edge.before.timestamp + 10);
  w.edges.set(k, moved);
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id, {wait: false}),
    e => e instanceof PilotError && e.code === 'transfer_window_open' && Math.abs(e.extra.retry_after_ms - (fallbackAfter(T1) - clock.t + 1)) <= 1, 'another prior state');
  // Once the window has passed, a template is given there too, with a T later than every earlier attempt of the deal.
  w.pilot.s.edges[k].last = {total: 5, timestamp: moved.timestamp, signature: moved.signature};
  clock.t = fallbackAfter(T1) + 1;
  const T3 = (await pilot.transferTemplate(P, d.id, A.id, {wait: false})).timestamp;
  assert.ok(T3 > T1, `${T3} > ${T1}`);
});

// ---------- PA-SV, as changed by tracker v3.2: the server and the 0.4 clients after audit VS-1 ----------
// Tracker v3.1's prior acknowledgments M(A,B,X,T) and M(A,C,Y,T) carried no prior timestamp, so two attempts of a deal
// through the same held note on the same priors at different T could both apply should both edges come back to X and Y;
// the server held every such retry back for the earlier attempt's window. Tracker v3.2's PA(A,B,X,p,T) binds the
// from-edge's state (X, p), which the edge has at most once: a retry on the same prior state of the same from-edge is
// allowed at once (the same-prior exemption, design v3.2 section 4; the clients' R11 the same); every other payment keeps
// the window. The server still makes no transfer again by itself (no regeneration).
const vs1 = w => {
  for (const x of [w.A, w.Q]) { x.client_features = {consents: true, roles: ['issuer', 'creditor', 'setoff'], at: iso(w.clock.t)}; x.last_seen_agent = iso(w.clock.t); }
};
const postBody = (d, A, tpl, T, {timestamps = true} = {}) => ({issuer_id: A.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, from_prior_total: tpl.from_edge.before.total,
  to_prior_total: tpl.to_edge.before?.total ?? 0, ...(timestamps ? {from_prior_timestamp: tpl.from_edge.before.timestamp, to_prior_timestamp: tpl.to_edge.before?.timestamp ?? 0} : {}),
  timestamp: T, quote_digest: tpl.quote_digest, completion_signature: '02' + hex(64), pay_signature: '02' + hex(64), signatures: {}});

test('PA-SV / same-prior exemption: within an earlier attempt\'s window a payment through the same note on the same prior state at a new T is not held back (the template, the post, the payment options, next_actions), while an own note waits; the note in another state (same total, another timestamp), another issuer\'s note, an attempt that recorded no prior timestamp and one recorded unverified all keep the window (409 transfer_window_open)', async () => {
  const clock = {t: Date.parse('2026-11-10T12:00:05.600Z')};
  const w = world({clock}), {pilot, A, B, P} = w;
  vs1(w);
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'payment_due', {price: 3});
  const tpl = await pilot.transferTemplate(P, d.id, A.id), T1 = tpl.timestamp, AP = `${A.pubkey}>${P.pubkey}`, p = tpl.from_edge.before.timestamp;
  const t1 = attempt(w, d, 'cancelled', {T: T1, amount: 3, from: tpl.from_edge.before, to: tpl.to_edge.before});
  clock.t += 5000;
  const wait = () => fallbackAfter(T1) - clock.t + 1;
  const open = e => e instanceof PilotError && e.code === 'transfer_window_open' && e.status === 409 && e.extra.retry_after_ms === wait() && /the same issuer's included/.test(e.message);
  // The same note on the same prior state: a template at once, at a later T.
  const tpl2 = await pilot.transferTemplate(P, d.id, A.id, {wait: false});
  assert.ok(tpl2.timestamp > T1);
  assert.deepEqual(tpl2.from_edge.before, tpl.from_edge.before, 'the same prior state');
  // A post at a new T on it passes the D-1 check (refused later, by its signatures: not for the window), with or
  // without the prior timestamps asserted; asserting another one is 409 transfer_stale with a fresh template.
  pilot.basis.verify = async () => false;
  for (const timestamps of [true, false])
    await assert.rejects(pilot.payByTransfer(P, d.id, postBody(d, A, tpl, tpl2.timestamp, {timestamps})), e => e instanceof PilotError && e.code === 'bad_signature', `timestamps asserted: ${timestamps}`);
  for (const wrong of [{from_prior_timestamp: p + 1}, {to_prior_timestamp: 1}, {from_prior_timestamp: String(p)}])
    await assert.rejects(pilot.payByTransfer(P, d.id, {...postBody(d, A, tpl, tpl2.timestamp), ...wrong}),
      e => e instanceof PilotError && e.code === 'transfer_stale' && /timestamped/.test(e.message) && e.extra.template?.from_edge?.before?.timestamp === p, JSON.stringify(wrong));
  // The identical operation (T1 again) is not held back by the window either; it is refused as stale (R-1).
  await assert.rejects(pilot.payByTransfer(P, d.id, postBody(d, A, tpl, T1)), e => e instanceof PilotError && e.code === 'transfer_stale', 'the identical operation');
  const opts = await pilot.paymentOptions(P, d.id);
  assert.deepEqual([opts.own_note.why_not, opts.held_notes.find(h => h.issuer.id === A.id)?.why_not], ['transfer_window_open', null], 'an own note waits; the same note does not');
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'pay_by_transfer']);
  assert.equal((await pilot.paymentBlock(d, {route: 'note'}))?.code, 'transfer_window_open', 'an own note (another kind) waits');
  // What keeps the window: another prior state of the same note (the same total, another timestamp), another note
  // (another from-edge), no prior timestamp named.
  for (const [why, args] of [['another timestamp', {fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p + 1}], ['another total', {fromEdge: AP, fromPrior: 4, fromPriorTimestamp: p}],
    ['another note', {fromEdge: `${B.pubkey}>${P.pubkey}`, fromPrior: 5, fromPriorTimestamp: p}], ['no prior timestamp', {fromEdge: AP, fromPrior: 5}]])
    assert.deepEqual(await pilot.paymentBlock(d, {route: 'transfer', ...args}), {code: 'transfer_window_open', retry_after_ms: wait()}, why);
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}), null, 'the same prior state');
  // The template on another state of the note waits (the edge moved before T1 and came back to 5 PC).
  w.edges.set(AP, note(5, p + 10));
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id, {wait: false}), open, 'the template on another state');
  assert.equal((await pilot.paymentOptions(P, d.id)).held_notes.find(h => h.issuer.id === A.id)?.why_not, 'transfer_window_open');
  w.edges.set(AP, note(5, p, pilot.s.edges[AP].last.signature));
  // An earlier attempt recorded without its prior state's timestamp (legacy) is never exempt.
  delete t1.from_edge.before.timestamp;
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id, {wait: false}), open, 'a legacy attempt with no prior timestamp');
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window']);
  t1.from_edge.before.timestamp = p;
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'pay_by_transfer']);
  // A refused attempt (D-2 b) on the same prior state is exempt as well, unless it was recorded unverified.
  const d2 = addDeal(w, 'delivered', {price: 3}), T0 = ending(clock.t - 4000, 999);
  d2.refused_attempts = [{kind: 'transfer', timestamp: T0, issuer: {id: A.id, pubkey: A.pubkey}, amount: 3, code: 'transfer_stale', at: iso(clock.t),
    edges: [{which: 'from', edge: AP, prior_total: 5, prior_timestamp: p, new_total: 2}, {which: 'to', edge: `${A.pubkey}>${w.Q.pubkey}`, prior_total: 0, prior_timestamp: 0, new_total: 3}],
    signature_sha256: {[`${AP}:prior`]: hex(32)}}];
  assert.equal(await pilot.paymentBlock(d2, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}), null, 'a refused attempt on the same prior state');
  assert.equal((await pilot.paymentBlock(d2, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p + 1}))?.code, 'transfer_window_open');
  d2.refused_attempts[0].unverified = true;
  assert.equal((await pilot.paymentBlock(d2, {route: 'transfer', fromEdge: AP, fromPrior: 5, fromPriorTimestamp: p}))?.code, 'transfer_window_open', 'recorded unverified: never exempt');
  // After the window, as before.
  clock.t = fallbackAfter(T1) + 1;
  assert.ok((await pilot.transferTemplate(P, d.id, A.id, {wait: false})).timestamp > T1, 'after the window');
  assert.deepEqual(pilot.view(d, P).next_actions, ['complete', 'pay_by_transfer']);
});

test('same-prior exemption on the held transfer\'s approval re-check (stalePayment): an earlier attempt of the deal on the same prior state does not make the held one stale; on another prior state it does (transfer_window_open)', async () => {
  const clock = {t: Date.parse('2026-11-10T12:00:05.600Z')};
  const w = world({clock}), {pilot, A, P, Q} = w;
  vs1(w);
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'delivered', {price: 3});
  const tpl = await pilot.transferTemplate(P, d.id, A.id), T1 = tpl.timestamp;
  attempt(w, d, 'cancelled', {T: T1, amount: 3, from: tpl.from_edge.before, to: tpl.to_edge.before});
  clock.t += 2000;
  const tpl2 = await pilot.transferTemplate(P, d.id, A.id, {wait: false});
  const held = attempt(w, d, 'awaiting_owner', {T: tpl2.timestamp, amount: 3, from: tpl2.from_edge.before, to: tpl2.to_edge.before});
  held.quote_digest = pilot.quoteFor(d, A, P, Q, 3);
  d.status = 'completion_awaiting_owner';
  assert.equal(await pilot.stalePayment(held, d), null, 'the earlier attempt on the same prior state: not stale');
  // The earlier attempt recorded on another state of the note (the same total at another timestamp): stale.
  pilot.s.transfers[d.transfer_ids[0]].from_edge.before = {...tpl.from_edge.before, timestamp: tpl.from_edge.before.timestamp - 1};
  assert.equal((await pilot.stalePayment(held, d))?.code, 'transfer_window_open');
});

test('PA-SV: a transfer whose edge changed before it applied is not made again by the server (no automatic same-issuer retry): it ends failed (edge_changed), the deal is payment_due with fallback_after, no second transfer and no payer consent exist, and the 409 says when another payment may start; a new one through the same note (still in the state it acknowledged) may start at once', async () => {
  const clock = {t: Date.parse('2026-11-10T12:00:05.600Z')};
  const w = world({clock}), {pilot, A, P, Q} = w;
  vs1(w);
  issued(w, A, P, 5, clock.t - 60e3);
  const d = addDeal(w, 'delivered', {price: 3});
  const tpl = await pilot.transferTemplate(P, d.id, A.id), T1 = tpl.timestamp;
  const t = attempt(w, d, 'collecting', {T: T1, amount: 3, from: tpl.from_edge.before, to: tpl.to_edge.before});
  d.status = 'paying_by_transfer'; d.completion = {by: P.id, signature: '02' + hex(64), at: iso(clock.t), deliverable_sha256: d.delivery.sha256};
  t.quote_digest = pilot.quoteFor(d, A, P, Q, 3);                 // the deal's own quote, as a posted transfer has it
  // A's note to Q appears at the tracker (around Valun) before the transfer applies; the held edge keeps its total.
  w.edges.set(`${A.pubkey}>${Q.pubkey}`, note(1, T1 - 200));
  clock.t += 5000;
  await pilot.serial(() => pilot.applyTransfer(t));
  assert.deepEqual([t.state, t.result.code, t.regenerated_as ?? null, t.fallback_after], ['failed', 'edge_changed', null, fallbackAfter(T1)]);
  assert.equal(pilot.transfersOf(d).length, 1, 'no second transfer');
  assert.deepEqual([d.status, d.payment.transfer_id], ['payment_due', t.id]);
  assert.ok(!d.history.some(e => e.event === 'payment_by_transfer_regenerated'));
  assert.ok(d.history.some(e => e.event === 'payment_due' && e.fallback_after === iso(fallbackAfter(T1))));
  assert.equal(pilot.consentsFor(P).consents.length, 0, 'the payer is asked to sign nothing');
  // Only A's note to Q moved: A's note to P is still in the state the failed attempt acknowledged, so the payer's own
  // client may pay through it again at once (the same-prior exemption); an own note waits.
  assert.deepEqual(pilot.view(d, P).next_actions, ['wait_for_transfer_window', 'pay_by_transfer']);
  // throwIfTransferFailed, as a post or an approval that applied answers it.
  assert.throws(() => pilot.throwIfTransferFailed(t, d, P), e => e.code === 'transfer_stale' && e.extra.regenerated_as === null && e.extra.transfer_id === t.id
    && e.message.includes(iso(fallbackAfter(T1))) && /unless it is a transfer through the same note/.test(e.message) && !/made again/.test(e.message));
  const again = await pilot.transferTemplate(P, d.id, A.id, {wait: false});
  assert.ok(again.timestamp > T1 && again.from_edge.before.total === 5 && again.to_edge.before.total === 1, 'a fresh template, at a later T, on the edges as they are');
});
