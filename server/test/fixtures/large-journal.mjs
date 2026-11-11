// Child process of test/audit-fixes.test.mjs (SV-ROB-1), run with --max-old-space-size=128: writes, in `dir`, a pilot
// state and a pilot-edge-log.jsonl of N entries (streamed, never held whole), then restarts a Pilot on the folder (its
// startup repair reads the log) and reads the journal as GET /edges and the D-2 e proof do. Prints one JSON line.
// The caller P has an entry every 375th seq (seq 1, 376, ...); the edge X>Y every 3rd; the stranger none.
// Usage: node --max-old-space-size=128 test/fixtures/large-journal.mjs <dir> <N>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../../lib/pilot/core.mjs';
import {edgeEntries, EDGE_LOG_FILE, EDGE_LOG_TAIL} from '../../lib/pilot/journal.mjs';

const [dir, nArg] = process.argv.slice(2), N = Number(nArg);
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const PIN = 'cd'.repeat(32), T0 = Date.parse('2026-11-01T00:00:00.000Z');
const CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32), status: 'active',
  created_at: iso(T0), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null, mandate: {...DEFAULT_MANDATE}, mandate_version: 1, past_pubkeys: [],
  last_seen_agent: null, last_seen_owner: null});
const [P, Q, X, Y, Z, S] = ['big-caller', 'big-payee', 'big-x', 'big-y', 'big-z', 'big-stranger'].map(person);
const edgeOf = seq => (seq - 1) % 375 === 0 ? [P, Q] : seq % 3 === 0 ? [X, Y] : [Y, Z];
const totals = new Map(), tail = [];
const fd = fs.openSync(path.join(dir, EDGE_LOG_FILE), 'w');
let buf = [];
for (let seq = 1; seq <= N; seq++) {
  const [I, R] = edgeOf(seq), edge = `${I.pubkey}>${R.pubkey}`, total = (totals.get(edge) ?? 0) + 1;
  totals.set(edge, total);
  const e = {seq, at: iso(T0 + seq * 1000), kind: 'issue', ref: 'vd_' + hex(8), edge, issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: 1, total_after: total,
    timestamp: T0 + seq * 1000, signature: '02' + hex(63)};
  buf.push(JSON.stringify(e) + '\n');
  if (seq > N - EDGE_LOG_TAIL) tail.push(e);
  if (buf.length >= 2000) { fs.writeSync(fd, buf.join('')); buf = []; }
}
if (buf.length) fs.writeSync(fd, buf.join(''));
fs.closeSync(fd);
const participants = Object.fromEntries([P, Q, X, Y, Z, S].map(p => [p.id, p]));
fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify({version: 1, network: 'valun-pilot-1', createdAt: iso(T0), participants, deals: {}, approvals: {}, invites: {},
  transfers: {}, setoffs: {}, clearing: {runs: [], cooldowns: {}, refusals: []}, edges: {}, edge_log_tail: tail, counters: {edge_seq: N, journal_backfilled: true}}));
const logMiB = fs.statSync(path.join(dir, EDGE_LOG_FILE)).size / 1048576;

// A restart on the folder, then the reads.
const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], capabilities: async () => CAPS};
const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => T0 + (N + 10) * 1000, circulation: 'on', trackerCaps: CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
const page1 = await pilot.edges(pilot.s.participants[P.id], {since: 0});
const page2 = await pilot.edges(pilot.s.participants[P.id], {since: page1.next_seq});
const none = await pilot.edges(pilot.s.participants[S.id], {since: 0});
const XY = `${X.pubkey}>${Y.pubkey}`, list = edgeEntries(pilot, XY);
const k = list[100];
const dead = pilot.attemptDeadByJournal(XY, k.total_after - k.delta, k.timestamp - 1);
console.log(JSON.stringify({log_mib: Math.round(logMiB * 10) / 10, heap_mib: Math.round(process.memoryUsage().heapUsed / 1048576),
  first_page: {length: page1.journal.length, first_seq: page1.journal[0]?.seq, last_seq: page1.journal.at(-1)?.seq, next_seq: page1.next_seq},
  second_page_first_seq: page2.journal[0]?.seq, pages_total: page1.journal.length + page2.journal.length + none.journal.length,
  edge_entries: list.length, partial: !!list.partial, dead_proven: dead}));
