// The edge journal (design §5.6; invariant I-RECON): for every edge Valun touched (issuer key > recipient key in the pilot
// denomination), the total Valun expects from its own events, and the last state each event left on the tracker.
//
// State (in pilot-state.json, kept by migrate()):
//   s.edges[key]       {issuer, recipient (participant ids, or null), expected_total, issued_PC, setoff_PC,
//                       transferred_in_PC, transferred_out_PC, novated, last {total, timestamp, signature}, last_seq}
//   s.edge_log_tail    the last EDGE_LOG_TAIL entries
//   s.counters         {edge_seq (the last seq given), journal_backfilled}
// plus an append-only pilot-edge-log.jsonl beside the state, one entry per line.
//
// An entry is {seq, at, kind, ref, edge, issuer_pubkey, recipient_pubkey, delta, total_after, timestamp, signature}:
// `kind` is issue (a credit note Valun issued), transfer_out / transfer_in (the two edges of a debt transfer), setoff,
// or backfill (a note_issued deal journaled after the fact); `ref` the deal, transfer or set-off id; `delta` the change
// in PC (negative for transfer_out and setoff); `total_after`, `timestamp` and `signature` the edge's tracker note right
// after the event (an EdgeState: its signature is always the issuer's). Entries are written only for events the tracker
// has recorded, so no unapplied signature is ever in the journal.
//
// appendEntries() is called with the pilot lock held, in the same change (and the same save) as the state change that
// caused it; the entries reach pilot-edge-log.jsonl right after that save (Pilot.save()).
//
// pilot-edge-log.jsonl is never read as one string (SV-ROB-1): it is streamed (scanLogLines) at startup (repairEdgeLog)
// and once per process into the journal's index (JournalIndex), and a GET /edges page reads only its own lines from the
// offsets the index keeps.
//
// Compaction (release v16.1; readiness R-19, audit SV-ROB-1): compactJournal() replaces the entries up to a seq K with a
// checkpoint, written atomically (a new file, then a rename over the old one: a crash leaves either the old journal or
// the new one). The compacted file is, line by line:
//   {"checkpoint":1,"through_seq":K,"at","horizon_days","dropped","edges","deals"}   the header (the first line)
//   {"cp_edge":<edge>,"dropped":n,"dropped_max_ts":t}     per edge some entries of which were dropped: how many, and the
//                                                         largest timestamp among the entries up to K (D-2 e, below)
//   {"cp_deal":<deal>,"edge":<edge>,"changes":[{kind, count, delta}]}
//                                                         per recorded deal whose note's entry is at or before K: what
//                                                         transfers and set-offs did on its pair after it up to K (the
//                                                         part of credit_note.pair_changes_since the dropped entries held)
//   the kept entries up to K, as they were: on every edge, its last entry by seq and its last by timestamp (its state as
//   of K: what GET /edges serves a client whose `since` is before K, so the 0.4.0 clients resynchronize from real,
//   verifiable entries)
//   every entry after K, as it was.
// Completeness (decision D-3 d) is then the checkpoint plus every seq from K+1 to counters.edge_seq; the index holds the
// kept entries and those after K only (it never grows with compacted entries). Which entries may go, and when, is in
// compactJournal() and Pilot.maybeCompactJournal().
import fs from 'node:fs';
import path from 'node:path';

export const EDGE_LOG_TAIL = 500, JOURNAL_PAGE = 200, EDGE_LOG_FILE = 'pilot-edge-log.jsonl';
export const JOURNAL_KINDS = Object.freeze(['issue', 'transfer_out', 'transfer_in', 'setoff', 'backfill']);
// The kinds that change an issued note's claim afterwards (credit_note.pair_changes_since).
export const NOVATION_KINDS = Object.freeze(['transfer_out', 'transfer_in', 'setoff']);
// Compaction (release v16.1). Only entries written more than JOURNAL_HORIZON_DAYS ago may be dropped: nothing that reads
// the journal needs them by then (Pilot.maybeCompactJournal says why); it runs at most once every
// JOURNAL_COMPACT_EVERY_MS, and only while the file is larger than JOURNAL_COMPACT_MIN_BYTES.
export const JOURNAL_HORIZON_DAYS = 31, JOURNAL_HORIZON_MS = JOURNAL_HORIZON_DAYS * 864e5;
export const JOURNAL_COMPACT_EVERY_MS = 864e5, JOURNAL_COMPACT_MIN_BYTES = 16 * 1048576;
export const COMPACT_TMP_SUFFIX = '.compact';
// The sign each kind's delta has: notes and incoming transfers raise an edge, outgoing transfers and set-offs lower it.
const RAISES = new Set(['issue', 'transfer_in', 'backfill']);
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const iso = t => new Date(t).toISOString();

export const edgeKey = (issuer, recipient) => `${issuer}>${recipient}`;

// Adds the collections the journal and circulating credit keep (s.transfers, s.setoffs, s.clearing {runs, cooldowns,
// refusals}, s.edges, s.edge_log_tail, s.counters {edge_seq, journal_backfilled}), and any of their parts that is
// missing. Returns true when something was added. Existing values are never changed.
export function ensureJournal(s) {
  let changed = false;
  const put = (o, k, make) => { if (o[k] === undefined || o[k] === null) { o[k] = make(); changed = true; } };
  put(s, 'transfers', () => ({})); put(s, 'setoffs', () => ({}));
  put(s, 'clearing', () => ({}));
  put(s.clearing, 'runs', () => []); put(s.clearing, 'cooldowns', () => ({})); put(s.clearing, 'refusals', () => []);
  put(s, 'edges', () => ({})); put(s, 'edge_log_tail', () => []);
  put(s, 'counters', () => ({}));
  put(s.counters, 'edge_seq', () => 0); put(s.counters, 'journal_backfilled', () => false);
  return changed;
}

function newEdge(pilot, issuer, recipient) {
  return {issuer: pilot.byPubkey(issuer)?.id ?? null, recipient: pilot.byPubkey(recipient)?.id ?? null, expected_total: 0, issued_PC: 0, setoff_PC: 0,
    transferred_in_PC: 0, transferred_out_PC: 0, novated: false, last: null, last_seq: 0};
}

// Writes journal entries (with the pilot lock held) and returns them as written. Each input is {kind, ref, issuer_pubkey,
// recipient_pubkey, delta, total_after, timestamp, signature, at?}; seq, at and edge are filled in here.
export function appendEntries(pilot, entries) {
  const s = pilot.s, now = iso(pilot.now()), out = [];
  for (const x of entries) {
    if (!JOURNAL_KINDS.includes(x?.kind)) throw new TypeError(`journal: unknown entry kind ${JSON.stringify(x?.kind)}`);
    if (!KEY_RE.test(x.issuer_pubkey ?? '') || !KEY_RE.test(x.recipient_pubkey ?? '')) throw new TypeError('journal: an entry needs both edge keys');
    if (!Number.isSafeInteger(x.delta) || (RAISES.has(x.kind) ? x.delta < 1 : x.delta > -1)) throw new TypeError(`journal: a ${x.kind} entry's delta must be a whole number ${RAISES.has(x.kind) ? 'above' : 'below'} 0, not ${x.delta}`);
    const edge = edgeKey(x.issuer_pubkey, x.recipient_pubkey), seq = s.counters.edge_seq + 1;
    s.counters.edge_seq = seq;
    const entry = {seq, at: x.at ?? now, kind: x.kind, ref: x.ref ?? null, edge, issuer_pubkey: x.issuer_pubkey, recipient_pubkey: x.recipient_pubkey,
      delta: x.delta, total_after: x.total_after ?? null, timestamp: x.timestamp ?? null, signature: x.signature ?? null};
    const e = s.edges[edge] ??= newEdge(pilot, x.issuer_pubkey, x.recipient_pubkey);
    e.expected_total += x.delta;
    if (x.kind === 'issue' || x.kind === 'backfill') e.issued_PC += x.delta;
    else if (x.kind === 'transfer_in') { e.transferred_in_PC += x.delta; e.novated = true; }
    else if (x.kind === 'transfer_out') { e.transferred_out_PC -= x.delta; e.novated = true; }
    else { e.setoff_PC -= x.delta; e.novated = true; }
    // The edge's last state is the newest event's (tracker timestamps on an edge only grow); an entry backfilled out of
    // order never replaces a newer state.
    if (e.last === null || (Number.isSafeInteger(entry.timestamp) && !(Number.isSafeInteger(e.last.timestamp) && e.last.timestamp >= entry.timestamp)))
      e.last = {total: entry.total_after, timestamp: entry.timestamp, signature: entry.signature};
    e.last_seq = seq;
    s.edge_log_tail.push(entry);
    (pilot.edgeLogQueue ??= []).push(entry);
    pilot.journalIndex?.add(entry);
    out.push(entry);
  }
  if (s.edge_log_tail.length > EDGE_LOG_TAIL) s.edge_log_tail.splice(0, s.edge_log_tail.length - EDGE_LOG_TAIL);
  return out;
}

// Journals every note_issued deal that has no journal entry yet (d.journal_seq), as kind 'backfill', in the order its
// note was recorded (credit_note.recorded_at, then the deal id): the keys the note is between (Pilot.noteKeysOf), the
// agreed price, and the note the tracker held when it was recorded (credit_note.tracker_note). migrate() runs it: the
// first time for every deal issued before the journal existed, later only for a deal a release without the journal
// issued (after a rollback). A deal with no keys to journal it by (state from the first pilot version) is left out.
// Returns how many entries were written.
export function backfillJournal(pilot) {
  const items = [];
  for (const d of Object.values(pilot.s.deals)) {
    if (d.status !== 'note_issued' || d.journal_seq !== undefined) continue;
    const t = d.agreement?.terms, n = d.credit_note;
    const issuer = n?.issuer_pubkey ?? t?.payer?.pubkey, recipient = n?.recipient_pubkey ?? t?.payee?.pubkey, price = t?.price?.amount;
    if (!KEY_RE.test(issuer ?? '') || !KEY_RE.test(recipient ?? '') || !Number.isSafeInteger(price) || price < 1) continue;
    items.push({d, issuer, recipient, price, at: typeof n?.recorded_at === 'string' ? n.recorded_at : ''});
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  items.sort((a, b) => cmp(a.at, b.at) || cmp(a.d.id, b.d.id));
  const num = v => (v === undefined || v === null || v === '' || !Number.isSafeInteger(Number(v)) ? null : Number(v));
  const str = v => (typeof v === 'string' ? v : null);
  for (const {d, issuer, recipient, price, at} of items) {
    const tn = d.credit_note?.tracker_note, nn = d.credit_note?.note;
    const [entry] = appendEntries(pilot, [{kind: 'backfill', ref: d.id, issuer_pubkey: issuer, recipient_pubkey: recipient, delta: price,
      total_after: num(tn?.amount_collected) ?? num(nn?.total), timestamp: num(tn?.timestamp) ?? num(nn?.timestamp),
      signature: str(tn?.signature) ?? str(nn?.signature), ...(at ? {at} : {})}]);
    d.journal_seq = entry.seq;
  }
  return items.length;
}

// After a save: appends the queued entries to pilot-edge-log.jsonl. A failed append keeps them queued for the next save.
export function flushEdgeLog(pilot) {
  const q = pilot.edgeLogQueue;
  if (!q?.length) return;
  if (typeof pilot.store?.appendEdgeLog !== 'function') { q.length = 0; return; }   // a store without a log file
  const batch = q.slice();
  try { pilot.store.appendEdgeLog(batch); q.splice(0, batch.length); }
  catch (e) { pilot.log?.(`Pilot: could not append ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} to ${EDGE_LOG_FILE} (kept for the next save): ${e.code || e.message}`); }
}

// At startup: entries of the in-memory tail that never reached pilot-edge-log.jsonl (the process stopped between a save
// and its log append) are appended now, after the newest seq the file holds, so paging the journal from the file never
// skips them once newer entries push them out of the tail. A last line cut short by a crash is left on its own line.
// Entries neither the file nor the tail holds (the file lost or cut after the tail rolled over: decision D-3 d) cannot
// be repaired: that is logged and audited (journal.incomplete), and the tail's entries are still appended, so they are
// kept; the journal then proves nothing (edgeEntries, journalFor), as a file that starts after seq 1 is never taken for
// the whole journal. The file is streamed (scanLogLines), never read as one string. Returns how many entries were
// appended.
// A checkpoint (compactJournal) covers seqs 1..K: only the seqs after it must be in the file (or the tail); the newest seq
// the file holds is then at least K. A checkpoint past counters.edge_seq belongs to no state this process has and is
// ignored, so the seqs it covered are missing (fail closed). A compaction that a crash interrupted before its rename left
// only its temporary file: it is removed (the journal is the old file).
export function repairEdgeLog(pilot) {
  const dir = pilot.store?.dir, tail = pilot.s.edge_log_tail;
  if (!dir || typeof pilot.store?.appendEdgeLog !== 'function') return 0;
  const file = path.join(dir, EDGE_LOG_FILE), max = pilot.s.counters?.edge_seq ?? 0;
  try { fs.rmSync(file + COMPACT_TMP_SUFFIX, {force: true}); } catch { /* removed at the next start */ }
  if (!tail?.length) return 0;
  let base = 0, last = 0, held = null, scan = {end: 0, size: 0};
  const bits = () => (held ??= new Uint8Array(Math.max(0, max - base) + 2));
  try {
    scan = scanLogLines(file, 0, (text, offset) => {
      if (offset === 0 && held === null) {
        const cp = checkpointOf(text);
        if (cp && cp.through_seq <= max) { base = cp.through_seq; last = base; }
        if (cp) return;
      }
      const seq = seqOf(text);
      if (seq === null) return;                                    // a damaged line, or a checkpoint line
      if (seq > base && seq <= max) bits()[seq - base] = 1;
      if (seq > last) last = seq;
    });
  } catch (e) { if (e.code !== 'ENOENT') return 0; }
  bits();
  const queued = new Set((pilot.edgeLogQueue || []).map(e => e.seq));
  for (const e of [...tail, ...(pilot.edgeLogQueue || [])]) if (Number.isSafeInteger(e?.seq) && e.seq > base && e.seq <= max) held[e.seq - base] = 1;
  const gap = firstGap(seq => held[seq - base] === 1, base + 1, max);
  if (gap) journalIncomplete(pilot, gap, 'startup');
  const missing = tail.filter(e => Number.isSafeInteger(e?.seq) && e.seq > last && !queued.has(e.seq));
  if (!missing.length) return 0;
  try {
    if (scan.size > scan.end) fs.appendFileSync(file, '\n');      // a last line cut short stays on its own line
    pilot.store.appendEdgeLog(missing);
  } catch (e) {
    pilot.log?.(`Pilot: could not re-append ${missing.length} journal entr${missing.length === 1 ? 'y' : 'ies'} to ${EDGE_LOG_FILE}: ${e.code || e.message}`);
    return 0;
  }
  return missing.length;
}

// ---------- reading pilot-edge-log.jsonl ----------
const LOG_CHUNK = 1 << 20, MAX_LINE = 1 << 16;
// Calls fn(text, offset, length) for every complete line of `file` from byte `from` on, reading LOG_CHUNK bytes at a
// time (offset and length in bytes, without the '\n'; a line longer than MAX_LINE is skipped as damaged, an empty one
// is skipped). A last line without its '\n' is not read. Returns {end: the byte after the last complete line, size:
// the file's size}. Throws what fs throws (ENOENT included).
export function scanLogLines(file, from, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, buf = Buffer.allocUnsafe(LOG_CHUNK);
    let pos = from, lineStart = from, parts = [], partLen = 0, damaged = false;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(LOG_CHUNK, size - pos), pos);
      if (n <= 0) break;
      let i = 0;
      for (;;) {
        let nl = buf.indexOf(10, i);
        if (nl >= n) nl = -1;
        if (nl === -1) {                                            // the rest of this chunk starts a line
          if (!damaged && n > i) {
            if (partLen + n - i > MAX_LINE) { damaged = true; parts = []; partLen = 0; } else { parts.push(Buffer.from(buf.subarray(i, n))); partLen += n - i; }
          }
          break;
        }
        let text = null;
        if (!damaged && partLen + nl - i <= MAX_LINE) text = partLen ? Buffer.concat([...parts, buf.subarray(i, nl)]).toString('utf8') : buf.toString('utf8', i, nl);
        const at = lineStart, len = pos + nl - lineStart;
        parts = []; partLen = 0; damaged = false; lineStart = pos + nl + 1; i = nl + 1;
        if (text) fn(text, at, len);
      }
      pos += n;
    }
    return {end: lineStart, size};
  } finally { fs.closeSync(fd); }
}
// A line's seq without parsing all of it (an entry is written with seq first), else from the parsed line; null if none.
function seqOf(text) {
  const m = /^\{"seq":(\d{1,15}),/.exec(text);
  if (m) return Number(m[1]);
  try { const e = JSON.parse(text); return Number.isSafeInteger(e?.seq) && e.seq >= 1 ? e.seq : null; } catch { return null; }
}
// The line of entry `seq` at `offset` (`length` bytes), parsed; null when it is not that entry.
function readLogLine(fd, offset, length, seq) {
  const b = Buffer.allocUnsafe(length);
  if (fs.readSync(fd, b, 0, length, offset) !== length) return null;
  try { const e = JSON.parse(b.toString('utf8')); return e?.seq === seq ? e : null; } catch { return null; }
}
// The checkpoint header of pilot-edge-log.jsonl (its first line, written by compactJournal): {through_seq, at,
// horizon_days, dropped}, or null when the file does not start with one (an uncompacted journal) or does not exist.
// Throws what fs throws for a file that cannot be read (not ENOENT).
export function readCheckpoint(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const b = Buffer.allocUnsafe(4096), n = fs.readSync(fd, b, 0, 4096, 0), nl = b.indexOf(10);
    return nl < 0 || nl >= n ? null : checkpointOf(b.toString('utf8', 0, nl));
  } finally { fs.closeSync(fd); }
}
// The checkpoint header a line is ({through_seq, at, horizon_days, dropped}), or null.
function checkpointOf(text) {
  if (!text.startsWith('{"checkpoint":')) return null;
  let h;
  try { h = JSON.parse(text); } catch { return null; }
  return h?.checkpoint === 1 && Number.isSafeInteger(h.through_seq) && h.through_seq >= 1
    ? {through_seq: h.through_seq, at: typeof h.at === 'string' ? h.at : null, horizon_days: h.horizon_days ?? null, dropped: h.dropped ?? null} : null;
}
// A failed read of the log is logged once, until a read succeeds again.
function unreadable(pilot, e) {
  if (pilot.edgeLogUnreadable !== (e?.code || e?.message)) {
    pilot.edgeLogUnreadable = e?.code || e?.message;
    pilot.log?.(`Pilot: ${EDGE_LOG_FILE} cannot be read just now (${pilot.edgeLogUnreadable}); journal reads that need it are refused or prove nothing until it can`);
  }
}

// The journal's index, in memory, one per process (pilot.journalIndex; pilot.edgeIndex is its per-edge Map): per seq,
// in typed arrays, the line's offset and length in the log file (-1: not in the file, or not found there yet), its
// kind, delta, total_after, timestamp and ref; per edge and per key (issuer or recipient), the seqs of its entries in
// order. About 50 bytes an entry, and no signatures: a GET /edges page reads its entries' lines from the file (or takes
// them from the tail or the queue). A ref of the form vd_/vt_/vs_ + 16 hex is kept as numbers, any other as text.
// It serves the reads that need one edge's whole history on a hot path (a deal view's credit_note.pair_changes_since;
// the proof that a payment attempt can never apply, decision D-2 e) and the journal pages of GET /edges.
// With a checkpoint (compactJournal) the typed arrays start after it (`base` = its through_seq): the few entries up to it
// that are still held (the kept ones, and any the state's tail still has) are in `old`, so the index never grows with
// compacted entries; `checkpoint` holds the header and, per edge and per deal, what the checkpoint says about the
// dropped entries.
const REF_PREFIXES = ['vd_', 'vt_', 'vs_'], REF_RE = /^(v[dts]_)([0-9a-f]{8})([0-9a-f]{8})$/;
class JournalIndex {
  constructor(base, top) {
    this.base = base; this.cap = 0; this.end = 0; this.gaps = []; this.checkpoint = null;
    this.old = new Map();
    this.edges = new Map(); this.keys = new Map(); this.otherRefs = new Map(); this.otherKinds = new Map();
    this.grow(Math.max(1024, top - base + 1));
  }
  grow(cap) {
    const old = this.cap;
    if (cap <= old) return;
    const g = (A, x, fill) => { const n = new A(cap); if (x) n.set(x); if (fill !== undefined) n.fill(fill, old); return n; };
    this.off = g(Float64Array, this.off, -1); this.len = g(Uint32Array, this.len); this.kind = g(Uint8Array, this.kind);
    this.delta = g(Float64Array, this.delta); this.total = g(Float64Array, this.total); this.ts = g(Float64Array, this.ts);
    this.refKind = g(Uint8Array, this.refKind); this.refHi = g(Uint32Array, this.refHi); this.refLo = g(Uint32Array, this.refLo);
    this.cap = cap;
  }
  has(seq) {
    if (seq <= this.base) return seq >= 1 && this.old.has(seq);
    const i = seq - this.base;
    return i < this.cap && this.kind[i] !== 0;
  }
  // Adds entry e (read from the file at offset/length, or from memory: offset -1). An entry already indexed only learns
  // where its line is. Returns whether it was new.
  add(e, offset = -1, length = 0) {
    const seq = e?.seq;
    if (!Number.isSafeInteger(seq) || seq < 1 || typeof e.edge !== 'string') return false;
    const num = v => (typeof v === 'number' ? v : NaN);
    if (seq <= this.base) {
      const o = this.old.get(seq);
      if (o) { if (offset >= 0 && o.off < 0) { o.off = offset; o.len = length; } return false; }
      this.old.set(seq, {off: offset, len: length, kind: e.kind ?? null, ref: e.ref ?? null, delta: num(e.delta), total: num(e.total_after), ts: num(e.timestamp)});
    } else {
      const i = seq - this.base;
      if (i >= this.cap) { let c = this.cap * 2; while (c <= i) c *= 2; this.grow(c); }
      if (this.kind[i] !== 0) { if (offset >= 0 && this.off[i] < 0) { this.off[i] = offset; this.len[i] = length; } return false; }
      const k = JOURNAL_KINDS.indexOf(e.kind);
      this.kind[i] = k >= 0 ? k + 1 : 255;
      if (k < 0) this.otherKinds.set(seq, e.kind ?? null);
      this.delta[i] = num(e.delta); this.total[i] = num(e.total_after); this.ts[i] = num(e.timestamp);
      const m = typeof e.ref === 'string' ? REF_RE.exec(e.ref) : null;
      if (m) { this.refKind[i] = REF_PREFIXES.indexOf(m[1]) + 1; this.refHi[i] = parseInt(m[2], 16); this.refLo[i] = parseInt(m[3], 16); }
      else if (e.ref !== undefined && e.ref !== null) this.otherRefs.set(seq, e.ref);
      if (offset >= 0) { this.off[i] = offset; this.len[i] = length; }
    }
    insertSeq(this.edges, e.edge, seq);
    if (typeof e.issuer_pubkey === 'string') insertSeq(this.keys, e.issuer_pubkey, seq);
    if (typeof e.recipient_pubkey === 'string' && e.recipient_pubkey !== e.issuer_pubkey) insertSeq(this.keys, e.recipient_pubkey, seq);
    return true;
  }
  offOf(seq) { return seq <= this.base ? this.old.get(seq)?.off ?? -1 : this.off[seq - this.base]; }
  lenOf(seq) { return seq <= this.base ? this.old.get(seq)?.len ?? 0 : this.len[seq - this.base]; }
  tsOf(seq) { return seq <= this.base ? this.old.get(seq)?.ts ?? NaN : this.ts[seq - this.base]; }
  // Learns where entry seq's line is (when it did not know).
  place(seq, offset, length) {
    if (seq <= this.base) { const o = this.old.get(seq); if (o && o.off < 0) { o.off = offset; o.len = length; } return; }
    const i = seq - this.base;
    if (this.off[i] < 0) { this.off[i] = offset; this.len[i] = length; }
  }
  ref(seq) {
    if (seq <= this.base) return this.old.get(seq)?.ref ?? null;
    const r = this.refKind[seq - this.base], i = seq - this.base;
    return r ? REF_PREFIXES[r - 1] + this.refHi[i].toString(16).padStart(8, '0') + this.refLo[i].toString(16).padStart(8, '0') : this.otherRefs.get(seq) ?? null;
  }
  // The compact entry of seq: {seq, kind, ref, delta, total_after, timestamp}.
  entry(seq) {
    const v = x => (Number.isNaN(x) ? null : x);
    if (seq <= this.base) { const o = this.old.get(seq); return {seq, kind: o.kind, ref: o.ref, delta: v(o.delta), total_after: v(o.total), timestamp: v(o.ts)}; }
    const i = seq - this.base, k = this.kind[i];
    return {seq, kind: k === 255 ? this.otherKinds.get(seq) : JOURNAL_KINDS[k - 1], ref: this.ref(seq), delta: v(this.delta[i]), total_after: v(this.total[i]), timestamp: v(this.ts[i])};
  }
  // Reads only the lines appended to the file since the index last read it, learning where entries it holds are.
  catchUp(file) {
    this.end = scanLogLines(file, this.end, (text, offset, length) => {
      const seq = seqOf(text);
      if (seq !== null && this.has(seq) && this.offOf(seq) < 0) this.place(seq, offset, length);
    }).end;
  }
  // A checkpoint line other than the header (per edge, per deal).
  checkpointLine(x) {
    const cp = this.checkpoint;
    if (typeof x.cp_edge === 'string') cp.edges.set(x.cp_edge, {dropped: Number.isSafeInteger(x.dropped) ? x.dropped : 0, dropped_max_ts: Number.isSafeInteger(x.dropped_max_ts) ? x.dropped_max_ts : null});
    else if (typeof x.cp_deal === 'string' && Array.isArray(x.changes)) cp.deals.set(x.cp_deal, {edge: x.edge ?? null, changes: x.changes});
  }
}
function insertSeq(map, key, seq) {
  const l = map.get(key);
  if (!l) { map.set(key, [seq]); return; }
  if (l[l.length - 1] < seq) { l.push(seq); return; }
  const i = firstAfter(l, seq - 1);
  if (l[i] !== seq) l.splice(i, 0, seq);
}
// The first index of sorted list l whose seq is above `since` (l.length if none).
function firstAfter(l, since) {
  let lo = 0, hi = l.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid] <= since) lo = mid + 1; else hi = mid; }
  return lo;
}

// The index, built on first use by streaming pilot-edge-log.jsonl (entries with seq up to counters.edge_seq; a line
// past it belongs to no state this process has), then the state's tail and the entries not appended to the file yet;
// appendEntries() keeps it up to date. A log file that does not exist (ENOENT) is an empty journal. Any other error
// (the file cannot be read just now) keeps no index and returns null, so the next call reads the file again and a
// caller never takes what it has for the whole journal (fail closed); the failure is logged once.
// Decision D-3 d: the journal proves nothing unless the entries read cover every seq from 1 to counters.edge_seq, or,
// after a compaction, the checkpoint (seqs 1..K) and every seq from K+1 to counters.edge_seq. A gap
// (pilot-edge-log.jsonl lost, or cut, after the tail rolled over) does not close by reading the file again, so the index
// is kept with its gaps (pilot.edgeIndexGap {from, to}: the first one) until the next start, and every answer that
// needs them is partial; the first gap is logged and audited once (journal.incomplete). A checkpoint past the counter
// (a state restored without its journal) is ignored, so the seqs it covered count as missing.
function journalIndex(pilot) {
  if (pilot.journalIndex) return pilot.journalIndex;
  const s = pilot.s, max = s.counters?.edge_seq ?? 0, dir = pilot.store?.dir, file = dir ? path.join(dir, EDGE_LOG_FILE) : null;
  // Made at the file's first line, which says whether a checkpoint covers the start (the arrays then start after it).
  let ix = null;
  const make = (cp = null) => {
    if (ix) return ix;
    ix = new JournalIndex(cp ? cp.through_seq : 0, max);
    if (cp) ix.checkpoint = {...cp, edges: new Map(), deals: new Map()};
    return ix;
  };
  if (file) {
    try {
      const end = scanLogLines(file, 0, (text, offset, length) => {
        if (offset === 0 && !ix) {
          const cp = checkpointOf(text);
          make(cp && cp.through_seq <= max ? cp : null);
          if (cp) return;
        }
        let e;
        try { e = JSON.parse(text); } catch { return; }
        if (Number.isSafeInteger(e?.seq)) { if (e.seq <= max) make().add(e, offset, length); }
        else if (make().checkpoint && e && typeof e === 'object') ix.checkpointLine(e);
      }).end;
      make().end = end;
    } catch (e) {
      if (e?.code !== 'ENOENT') { unreadable(pilot, e); return null; }
    }
  }
  make();
  pilot.edgeLogUnreadable = null;
  for (const e of [...(s.edge_log_tail || []), ...(pilot.edgeLogQueue || [])]) ix.add(e);
  for (let i = ix.base + 1; i <= max; i++) {
    if (ix.has(i)) continue;
    let j = i;
    while (j < max && !ix.has(j + 1)) j++;
    ix.gaps.push({from: i, to: j});
    i = j;
  }
  pilot.journalIndex = ix; pilot.edgeIndex = ix.edges;
  pilot.edgeIndexGap = ix.gaps[0] ?? null;
  if (pilot.edgeIndexGap) journalIncomplete(pilot, pilot.edgeIndexGap, 'index');
  return ix;
}
// The journal's checkpoint as the index read it ({through_seq, at, edges, deals}), or null (none, or the file cannot be
// read just now).
export function journalCheckpoint(pilot) { return journalIndex(pilot)?.checkpoint ?? null; }
// One edge's journal entries with seq > afterSeq, oldest first: [{seq, kind, ref, delta, total_after, timestamp}] (no
// signatures). While the log file cannot be read (no index) only the tail's and the queue's entries are returned,
// marked `partial: true`; so is the whole list while the index has a gap (D-3 d): an older entry may be missing, so it
// proves nothing (Pilot.attemptDeadByJournal). So is a list from before a checkpoint (afterSeq < its through_seq): the
// entries it dropped are not in it.
const compactEntry = e => ({seq: e.seq, kind: e.kind, ref: e.ref ?? null, delta: e.delta, total_after: e.total_after ?? null, timestamp: e.timestamp ?? null});
export function edgeEntries(pilot, edge, {afterSeq = 0} = {}) {
  const ix = journalIndex(pilot);
  if (!ix) {
    const seen = new Set(), out = [];
    for (const e of [...(pilot.s.edge_log_tail || []), ...(pilot.edgeLogQueue || [])]) if (e?.edge === edge && Number.isSafeInteger(e.seq) && e.seq > afterSeq && !seen.has(e.seq)) { seen.add(e.seq); out.push(compactEntry(e)); }
    return Object.assign(out.sort((a, b) => a.seq - b.seq), {partial: true});
  }
  const seqs = ix.edges.get(edge) ?? [], list = seqs.slice(firstAfter(seqs, afterSeq)).map(seq => ix.entry(seq));
  return pilot.edgeIndexGap || (ix.checkpoint && afterSeq < ix.base && ix.checkpoint.edges.has(edge)) ? Object.assign(list, {partial: true}) : list;
}
// Decision D-2 e: the entry on `edge` with the smallest timestamp above ts (tracker timestamps on an edge only grow, but
// a backfilled entry may be out of order), read from the index without building the edge's list: {entry, partial}
// (entry null: none; partial as for edgeEntries). After a compaction it is also partial when an entry the checkpoint
// dropped on this edge has a timestamp above ts (cp_edge.dropped_max_ts): that one may be the first after ts, so
// nothing is proven (fail closed). Compaction keeps every entry an attempt of an unpaid deal still needs
// (Pilot.journalProtection), so such an attempt is never affected.
export function firstEdgeEntryAfter(pilot, edge, ts) {
  const ix = journalIndex(pilot);
  if (!ix) return {entry: null, partial: true};
  let best = -1, bestTs = 0;
  for (const seq of ix.edges.get(edge) ?? []) { const t = ix.tsOf(seq); if (Number.isSafeInteger(t) && t > ts && (best < 0 || t < bestTs)) { best = seq; bestTs = t; } }
  const cut = ix.checkpoint?.edges.get(edge), compacted = !!cut && Number.isSafeInteger(cut.dropped_max_ts) && cut.dropped_max_ts > ts;
  return {entry: best < 0 ? null : ix.entry(best), partial: !!pilot.edgeIndexGap || compacted};
}

// The first run of seqs from..to (inclusive) that `seqs` (a Set) lacks, as {from, to}; null when it has them all.
export function seqGap(seqs, from, to) { return firstGap(i => seqs.has(i), from, to); }
function firstGap(has, from, to) {
  for (let i = from; i <= to; i++) {
    if (has(i)) continue;
    let j = i;
    while (j < to && !has(j + 1)) j++;
    return {from: i, to: j};
  }
  return null;
}
// An incomplete journal (D-3 d) is an operator matter: one log line and one audit line per gap (found at startup by
// repairEdgeLog, or when the index is built).
function journalIncomplete(pilot, gap, where) {
  const key = `${gap.from}-${gap.to}`;
  if ((pilot.journalGapsReported ??= new Set()).has(key)) return;
  pilot.journalGapsReported.add(key);
  pilot.log?.(`Pilot: the edge journal is missing entries ${gap.from}..${gap.to} (${EDGE_LOG_FILE} lost or cut after the in-memory tail rolled over): it proves no payment attempt dead, and GET /edges pages that need those entries answer 503, until the file is restored and the server restarted`);
  try { pilot.store?.audit?.({type: 'journal.incomplete', where, missing_from: gap.from, missing_to: gap.to}); } catch { /* the log line stands */ }
}

// The journal entries on edges with an issuer or recipient key in `keys` (a Set), with seq > since, oldest first, at most
// `limit`; and next_seq, the `since` for the next call: the last entry's seq when more remain, else the newest seq.
// A page within the in-memory tail is answered from it. An older one is answered from the index (the caller's entries,
// by key) and only those entries' lines of the log file (entries in the tail or the queue are taken from there).
// partial: true when the page needs the log file and it cannot be read just now, or (decision D-3 d) when the journal
// does not cover every seq after `since` up to counters.edge_seq (`gap` {from, to}: the first missing seqs; the file was
// lost or cut after the tail rolled over). The caller refuses such a page rather than skip entries.
// After a compaction, a page from a `since` before the checkpoint is answered from the index as any older page: the
// caller's kept entries up to the checkpoint (each edge's state as of it: real entries with their own seqs) and every
// later entry; `checkpoint` {through_seq, at} then says that the entries in between were compacted.
export function journalFor(pilot, keys, {since = 0, limit = JOURNAL_PAGE} = {}) {
  const s = pilot.s, tail = s.edge_log_tail, mine = e => keys.has(e.issuer_pubkey) || keys.has(e.recipient_pubkey);
  const first = tail.length ? tail[0].seq : s.counters.edge_seq + 1;
  if (!(since + 1 < first)) {
    const newer = tail.filter(e => e.seq > since);
    const gap = seqGap(new Set(newer.map(e => e.seq)), since + 1, s.counters.edge_seq);
    const all = newer.filter(mine), entries = all.slice(0, limit);
    return {entries, next_seq: all.length > limit ? entries[entries.length - 1].seq : s.counters.edge_seq, ...(gap ? {partial: true, gap} : {})};
  }
  const ix = journalIndex(pilot);
  if (!ix) return {entries: [], next_seq: s.counters.edge_seq, partial: true};
  const g = ix.gaps.find(x => x.to >= since + 1);
  if (g) { const gap = {from: Math.max(g.from, since + 1), to: g.to}; return {entries: [], next_seq: s.counters.edge_seq, partial: true, gap}; }
  // The caller's seqs after `since`, merged over its keys, at most limit + 1 (to know whether more remain).
  const lists = [...keys].map(k => ix.keys.get(k)).filter(Boolean), at = lists.map(l => firstAfter(l, since)), seqs = [];
  while (seqs.length <= limit) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) if (at[i] < lists[i].length && (best < 0 || lists[i][at[i]] < lists[best][at[best]])) best = i;
    if (best < 0) break;
    const seq = lists[best][at[best]];
    for (let i = 0; i < lists.length; i++) while (at[i] < lists[i].length && lists[i][at[i]] === seq) at[i]++;
    seqs.push(seq);
  }
  const page = seqs.slice(0, limit), entries = [];
  const queued = new Map((pilot.edgeLogQueue || []).map(e => [e.seq, e]));
  const dir = pilot.store?.dir, file = dir ? path.join(dir, EDGE_LOG_FILE) : null, partial = {entries: [], next_seq: s.counters.edge_seq, partial: true};
  let fd = null, caughtUp = false;
  try {
    for (const seq of page) {
      let e = seq >= first ? tail[seq - first]?.seq === seq ? tail[seq - first] : tail.find(x => x.seq === seq) : null;
      e ??= queued.get(seq) ?? null;
      if (!e) {
        if (!file) return partial;
        if (ix.offOf(seq) < 0 && !caughtUp) { ix.catchUp(file); caughtUp = true; }
        if (ix.offOf(seq) < 0) return partial;
        fd ??= fs.openSync(file, 'r');
        e = readLogLine(fd, ix.offOf(seq), ix.lenOf(seq), seq);
      }
      if (!e || !mine(e)) return partial;                          // not the line the index points at: prove nothing
      entries.push(e);
    }
  } catch (e) {
    unreadable(pilot, e);
    return partial;
  } finally { if (fd !== null) fs.closeSync(fd); }
  pilot.edgeLogUnreadable = null;
  return {entries, next_seq: seqs.length > limit ? entries[entries.length - 1].seq : s.counters.edge_seq,
    ...(ix.checkpoint && since < ix.base ? {checkpoint: {through_seq: ix.base, at: ix.checkpoint.at}} : {})};
}

// ---------- compaction (release v16.1; readiness R-19, audit SV-ROB-1) ----------
// Replaces the entries of pilot-edge-log.jsonl up to a seq K with a checkpoint (the file's layout is at the top of this
// module). K is the largest seq such that every entry up to it
//   - was written (its `at`) more than horizonMs before `now` (JOURNAL_HORIZON_MS; why that is safe:
//     Pilot.maybeCompactJournal);
//   - is not needed by an attempt in `protect` (a Map edge -> the earliest timestamp T of the payment attempts on that
//     edge that may still need the journal, Pilot.journalProtection): an entry on that edge with a timestamp above T
//     stays, and so does every entry after it, since the cut is a prefix;
//   - is in the file after the previous checkpoint, in seq order and with no seq missing: an incomplete journal is never
//     compacted, so a checkpoint never stands for entries the journal did not have (decision D-3 d);
//   - is at most counters.edge_seq.
// Synchronous, with the pilot lock held (Pilot.maybeCompactJournal): nothing reads or appends meanwhile. It reads the file
// twice (the cut; then what the checkpoint holds and where the entries after K start), writes the new journal to
// pilot-edge-log.jsonl.compact, flushes it to disk and renames it over pilot-edge-log.jsonl, as PilotStore.save does
// with the state; then it drops the index (the next read builds it from the new file). A crash before the rename leaves
// the old journal (repairEdgeLog removes the .compact file at the next start); one after it, the new one. `fault(step)`
// (tests) is called at each step ('scanned', 'tmp_partial', 'tmp_written', 'renamed') and may throw there to stand for a
// crash. Returns {compacted: true, through_seq, previous, dropped (this run), dropped_total, kept, edges, deals,
// bytes_before, bytes_after} or {skipped: why, ...}.
export function compactJournal(pilot, {now, horizonMs = JOURNAL_HORIZON_MS, protect = new Map(), fault = null} = {}) {
  const dir = pilot.store?.dir;
  if (!dir) return {skipped: 'no_store'};
  if (!Number.isSafeInteger(now)) throw new TypeError('compactJournal: now is a whole number of ms');
  const s = pilot.s, max = s.counters?.edge_seq ?? 0, file = path.join(dir, EDGE_LOG_FILE), tmp = file + COMPACT_TMP_SUFFIX;
  const step = name => { if (fault) fault(name); };
  let prev, size;
  try { prev = readCheckpoint(file); size = fs.statSync(file).size; }
  catch (e) { return e.code === 'ENOENT' ? {skipped: 'no_journal'} : {skipped: 'unreadable', error: e.code || e.message}; }
  if (prev && !(prev.through_seq <= max)) return {skipped: 'checkpoint_ahead', through_seq: prev.through_seq, edge_seq: max};
  const kPrev = prev ? prev.through_seq : 0, oldEnough = now - horizonMs;
  const parse = text => { try { const e = JSON.parse(text); return e && typeof e === 'object' ? e : null; } catch { return null; } };

  // Pass A: the cut. `next` is the seq the next entry must have; the first entry that is young, needed, out of order or
  // missing stops it.
  let next = kPrev + 1, stop = null, why = null;
  try {
    scanLogLines(file, 0, text => {
      if (stop !== null) return;
      const seq = seqOf(text);
      if (seq === null || seq <= kPrev) return;          // a checkpoint line, a damaged line, or a kept entry of the last checkpoint
      if (seq !== next) { stop = next; why = seq > next ? 'gap' : 'order'; return; }
      if (seq > max) { stop = seq; why = 'past_counter'; return; }
      const e = parse(text), T = e ? protect.get(e.edge) : undefined;
      if (!e || typeof e.edge !== 'string') { stop = seq; why = 'damaged'; return; }
      if (!(Date.parse(e.at) <= oldEnough)) { stop = seq; why = 'horizon'; return; }
      if (T !== undefined && Number.isSafeInteger(e.timestamp) && e.timestamp > T) { stop = seq; why = 'attempt'; return; }
      next = seq + 1;
    });
  } catch (e) { return {skipped: 'unreadable', error: e.code || e.message}; }
  const K = (stop ?? next) - 1;
  if (K <= kPrev) return {skipped: 'nothing_to_compact', through_seq: kPrev, stopped_by: why ?? 'end'};

  // Pass B: per edge, how many entries up to K the file holds, the largest timestamp among them and the ones kept (its
  // last by seq and by timestamp); per deal whose note's entry is at or before K, the novations on its pair after that
  // entry up to K (added to what the last checkpoint had for it); and where the entries after K begin.
  const edgeInfo = new Map(), oldDeals = new Map(), cum = new Map(), starts = new Map(), at = new Map(), deals = [];
  for (const d of Object.values(s.deals || {})) {
    const n = d.credit_note, j = d.journal_seq;
    if (n?.state !== 'recorded' || !Number.isSafeInteger(j) || j < 1 || j > K || typeof n.issuer_pubkey !== 'string' || typeof n.recipient_pubkey !== 'string') continue;
    const item = {id: d.id, edge: edgeKey(n.issuer_pubkey, n.recipient_pubkey), j};
    deals.push(item);
    if (j > kPrev) { if (!at.has(j)) at.set(j, []); at.get(j).push(item); }
  }
  const info = edge => { let x = edgeInfo.get(edge); if (!x) edgeInfo.set(edge, x = {dropped: 0, maxTs: null, n: 0, lastSeq: null, lastTs: null}); return x; };
  const zero = () => Object.fromEntries(NOVATION_KINDS.map(k => [k, [0, 0]]));
  const seenOld = new Set();
  let suffixAt = null, last = kPrev, end = 0;
  try {
    end = scanLogLines(file, 0, (text, offset, length) => {
      if (suffixAt !== null) return;
      const e = parse(text);
      if (!e) return;
      if (!Number.isSafeInteger(e.seq)) {
        if (!prev || (offset === 0 && e.checkpoint === 1)) return;
        if (typeof e.cp_edge === 'string') {
          const x = info(e.cp_edge);
          x.dropped += Number.isSafeInteger(e.dropped) ? e.dropped : 0;
          if (Number.isSafeInteger(e.dropped_max_ts)) x.maxTs = Math.max(x.maxTs ?? e.dropped_max_ts, e.dropped_max_ts);
        } else if (typeof e.cp_deal === 'string' && Array.isArray(e.changes)) oldDeals.set(e.cp_deal, e.changes);
        return;
      }
      if (e.seq > K) { suffixAt = offset; return; }
      if (typeof e.edge !== 'string') return;
      if (e.seq <= kPrev) { if (seenOld.has(e.seq)) return; seenOld.add(e.seq); }
      else if (e.seq === last + 1) last = e.seq;
      else return;                                          // a second copy of an entry: counted once
      const x = info(e.edge);
      x.n += 1;
      if (Number.isSafeInteger(e.timestamp)) {
        x.maxTs = Math.max(x.maxTs ?? e.timestamp, e.timestamp);
        if (!x.lastTs || e.timestamp > x.lastTs.ts || (e.timestamp === x.lastTs.ts && e.seq > x.lastTs.seq)) x.lastTs = {seq: e.seq, ts: e.timestamp, off: offset, len: length};
      }
      if (!x.lastSeq || e.seq > x.lastSeq.seq) x.lastSeq = {seq: e.seq, off: offset, len: length};
      if (e.seq <= kPrev) return;
      if (NOVATION_KINDS.includes(e.kind) && Number.isSafeInteger(e.delta)) {
        let c = cum.get(e.edge);
        if (!c) cum.set(e.edge, c = zero());
        c[e.kind][0] += 1; c[e.kind][1] += e.delta;
      }
      for (const item of at.get(e.seq) ?? []) { const c = cum.get(item.edge); starts.set(item.id, c ? Object.fromEntries(NOVATION_KINDS.map(k => [k, [...c[k]]])) : zero()); }
    }).end;
  } catch (e) { return {skipped: 'unreadable', error: e.code || e.message}; }
  if (last !== K) return {skipped: 'changed', through_seq: kPrev};       // never: both passes read the same file
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const dealLines = [];
  for (const it of deals.sort((a, b) => cmp(a.id, b.id))) {
    if (it.j > kPrev && !starts.has(it.id)) continue;
    const prior = it.j <= kPrev ? oldDeals.get(it.id) : null, start = it.j > kPrev ? starts.get(it.id) : zero(), c = cum.get(it.edge) ?? zero(), changes = [];
    for (const k of NOVATION_KINDS) {
      const was = Array.isArray(prior) ? prior.find(x => x?.kind === k) : null;
      const count = (Number.isSafeInteger(was?.count) ? was.count : 0) + c[k][0] - start[k][0], delta = (Number.isSafeInteger(was?.delta) ? was.delta : 0) + c[k][1] - start[k][1];
      if (count > 0) changes.push({kind: k, count, delta});
    }
    if (changes.length) dealLines.push({cp_deal: it.id, edge: it.edge, changes});
  }
  const edgeLines = [], kept = [];
  let droppedTotal = 0, droppedNow = 0;
  for (const [edge, x] of [...edgeInfo].sort((a, b) => cmp(a[0], b[0]))) {
    const keep = new Map();
    if (x.lastSeq) keep.set(x.lastSeq.seq, x.lastSeq);
    if (x.lastTs) keep.set(x.lastTs.seq, x.lastTs);
    kept.push(...keep.values());
    const gone = x.dropped + x.n - keep.size;
    droppedTotal += gone; droppedNow += x.n - keep.size;
    if (gone > 0) edgeLines.push({cp_edge: edge, dropped: gone, dropped_max_ts: x.maxTs});
  }
  kept.sort((a, b) => a.seq - b.seq);
  step('scanned');

  // The new journal, beside the old one; then the rename.
  const header = {checkpoint: 1, through_seq: K, at: new Date(now).toISOString(), horizon_days: horizonMs / 864e5, dropped: droppedTotal, edges: edgeLines.length, deals: dealLines.length};
  let bytes = 0;
  const fd = fs.openSync(tmp, 'w');
  let src = null;
  try {
    const write = buf => { fs.writeSync(fd, buf); bytes += buf.length; };
    write(Buffer.from([header, ...edgeLines, ...dealLines].map(x => JSON.stringify(x) + '\n').join('')));
    step('tmp_partial');
    src = fs.openSync(file, 'r');
    for (const k of kept) {
      const b = Buffer.allocUnsafe(k.len + 1);
      if (fs.readSync(src, b, 0, k.len, k.off) !== k.len) throw new Error('compactJournal: a kept entry could not be read again');
      b[k.len] = 10; write(b);
    }
    // The entries after K: the rest of the file as it is, up to its last complete line.
    if (suffixAt !== null) {
      const buf = Buffer.allocUnsafe(LOG_CHUNK);
      for (let pos = suffixAt; pos < end;) {
        const n = fs.readSync(src, buf, 0, Math.min(LOG_CHUNK, end - pos), pos);
        if (n <= 0) throw new Error('compactJournal: the journal ended early');
        write(buf.subarray(0, n)); pos += n;
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
    if (src !== null) fs.closeSync(src);
  }
  step('tmp_written');
  fs.renameSync(tmp, file);
  step('renamed');
  pilot.journalIndex = null; pilot.edgeIndex = null; pilot.edgeIndexGap = null;
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* a directory cannot be flushed on every platform (Windows) */ }
  return {compacted: true, through_seq: K, previous: kPrev, dropped: droppedNow, dropped_total: droppedTotal, kept: kept.length, edges: edgeLines.length, deals: dealLines.length,
    bytes_before: size, bytes_after: bytes, stopped_by: why ?? 'end'};
}
