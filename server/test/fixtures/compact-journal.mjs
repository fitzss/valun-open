// Child process of test/release-v16-1.test.mjs (SV-ROB-1, release v16.1), run with --expose-gc --max-old-space-size=128:
// writes, in `dir`, a pilot state and a pilot-edge-log.jsonl of N entries written 40 days ago and YOUNG entries of the
// last day (streamed, never held whole); then (1) a restart on the folder and the journal's index built by a GET /edges
// page, measured; (2) the compaction (Pilot.maybeCompactJournal, forced past its size condition), measured; (3) a
// restart on the compacted journal and the index again, measured, with the same reads. Prints one JSON line.
// As in test/fixtures/large-journal.mjs: the caller P has an entry every 375th seq; the edge X>Y every 3rd.
// Usage: node --expose-gc --max-old-space-size=128 test/fixtures/compact-journal.mjs <dir> <N> <YOUNG>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../../lib/pilot/core.mjs';
import {edgeEntries, readCheckpoint, EDGE_LOG_FILE, EDGE_LOG_TAIL} from '../../lib/pilot/journal.mjs';

const [dir, nArg, yArg] = process.argv.slice(2), N = Number(nArg), YOUNG = Number(yArg), TOTAL = N + YOUNG;
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const PIN = 'cd'.repeat(32), NOW = Date.parse('2026-11-11T12:00:00.000Z'), OLD = NOW - 40 * 864e5, RECENT = NOW - 864e5;
const CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32), status: 'active',
  created_at: iso(OLD), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null, mandate: {...DEFAULT_MANDATE}, mandate_version: 1, past_pubkeys: [],
  last_seen_agent: null, last_seen_owner: null});
const [P, Q, X, Y, Z, S] = ['cj-caller', 'cj-payee', 'cj-x', 'cj-y', 'cj-z', 'cj-stranger'].map(person);
const edgeOf = seq => (seq - 1) % 375 === 0 ? [P, Q] : seq % 3 === 0 ? [X, Y] : [Y, Z];
const totals = new Map(), tail = [], edges = {};
const fd = fs.openSync(path.join(dir, EDGE_LOG_FILE), 'w');
let buf = [];
for (let seq = 1; seq <= TOTAL; seq++) {
  const [I, R] = edgeOf(seq), edge = `${I.pubkey}>${R.pubkey}`, total = (totals.get(edge) ?? 0) + 1, young = seq > N;
  const ts = (young ? RECENT : OLD) + seq * 1000;
  totals.set(edge, total);
  const e = {seq, at: iso(ts), kind: 'issue', ref: 'vd_' + hex(8), edge, issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: 1, total_after: total,
    timestamp: ts, signature: '02' + hex(63)};
  edges[edge] = {issuer: I.id, recipient: R.id, expected_total: total, issued_PC: total, setoff_PC: 0, transferred_in_PC: 0, transferred_out_PC: 0, novated: false,
    last: {total, timestamp: ts, signature: e.signature}, last_seq: seq};
  buf.push(JSON.stringify(e) + '\n');
  if (seq > TOTAL - EDGE_LOG_TAIL) tail.push(e);
  if (buf.length >= 2000) { fs.writeSync(fd, buf.join('')); buf = []; }
}
if (buf.length) fs.writeSync(fd, buf.join(''));
fs.closeSync(fd);
const participants = Object.fromEntries([P, Q, X, Y, Z, S].map(p => [p.id, p]));
fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify({version: 1, network: 'valun-pilot-1', createdAt: iso(OLD), participants, deals: {}, approvals: {}, invites: {},
  transfers: {}, setoffs: {}, clearing: {runs: [], cooldowns: {}, refusals: []}, edges, edge_log_tail: tail, counters: {edge_seq: TOTAL, journal_backfilled: true}}));
const fileBefore = fs.statSync(path.join(dir, EDGE_LOG_FILE)).size;

const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], capabilities: async () => CAPS};
const mib = n => Math.round(n / 1048576 * 10) / 10;
// A restart (the constructor's startup repair streams the log), then the index (built by the first GET /edges page).
async function start() {
  global.gc(); const m0 = process.memoryUsage();
  const t0 = performance.now();
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => NOW, circulation: 'on', trackerCaps: CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const page = await pilot.edges(pilot.s.participants[P.id], {since: 0});
  const ms = performance.now() - t0;
  global.gc(); const m1 = process.memoryUsage(), ix = pilot.journalIndex;
  let listed = 0;
  for (const l of ix.edges.values()) listed += l.length;
  return {pilot, page, out: {startup_ms: Math.round(ms), heap_mib: mib(m1.heapUsed), heap_added_mib: mib(m1.heapUsed - m0.heapUsed), array_buffers_mib: mib(m1.arrayBuffers),
    index: {base: ix.base, capacity: ix.cap, old: ix.old.size, edge_list_entries: listed}}};
}
const before = await start();
const XY = `${X.pubkey}>${Y.pubkey}`;
const t1 = performance.now();
const r = await before.pilot.maybeCompactJournal({force: true});
const compactMs = Math.round(performance.now() - t1);
before.pilot = null;
const after = await start();
const pilot = after.pilot, cp = readCheckpoint(path.join(dir, EDGE_LOG_FILE));
const second = await pilot.edges(pilot.s.participants[P.id], {since: after.page.next_seq});
const fromK = await pilot.edges(pilot.s.participants[P.id], {since: cp.through_seq});
const young = edgeEntries(pilot, XY, {afterSeq: cp.through_seq}), k = young[5];
console.log(JSON.stringify({log_mib_before: mib(fileBefore), log_mib_after: mib(fs.statSync(path.join(dir, EDGE_LOG_FILE)).size),
  before: before.out, after: after.out, compaction: {ms: compactMs, through_seq: r.through_seq, dropped: r.dropped, kept: r.kept, stopped_by: r.stopped_by},
  first_page_before: {length: before.page.journal.length, first_seq: before.page.journal[0]?.seq, checkpoint: before.page.checkpoint ?? null},
  first_page_after: {length: after.page.journal.length, seqs: after.page.journal.slice(0, 3).map(e => e.seq), checkpoint: after.page.checkpoint ?? null, next_seq: after.page.next_seq},
  second_page_after: second.journal.length, from_checkpoint: fromK.journal.map(e => e.seq),
  young_on_xy: young.length, young_dead_proven: pilot.attemptDeadByJournal(XY, k.total_after - k.delta, k.timestamp - 1),
  old_dead_proven: pilot.attemptDeadByJournal(XY, 0, 0), gap: pilot.edgeIndexGap}));
