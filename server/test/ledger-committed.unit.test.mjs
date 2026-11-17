// The committed snapshot (fix inbox #62, step 3): Pilot.committedSnapshot and GET /pilot/v1/ledger/committed, on the
// testnet network (its own process), over a stub tracker (no tracker binary) read through the real Basis driver, so
// every amount goes through exactAmounts as the tracker writes it:
//   - the rows are the notes with a confirmed_total_debt, at that total, in every denomination, whatever the note's live
//     total and status: a note raised or lowered since the box (local_only) and one an update in flight carries
//     (pending) are rows at their committed totals; a note no box committed (confirmed_total_debt null) is not; token
//     rows, zero totals and totals up to 2^64 - 1 are rows, exactly; the rows' digest is the one the Rust crate computed
//     for them (test/fixtures/avl-random.json), while the live totals give another;
//   - a read the anchoring moved under is read again: one move, one retry; four moves in a row, 503 snapshot_moving
//     {retry_after_ms} and no audit line (never a false mismatch); notes pending under an update that is not the one in
//     flight are read again: mid-promotion, the next read finds them promoted; marks the tracker left on a note (the
//     same at every read) settle at the second read, so they never lock the route out; marks that change at every read
//     are 503 snapshot_moving; no confirmed box, 503 no_confirmed_box; a note without a confirmation, 502
//     tracker_unavailable;
//   - consistent true and false: a confirmed total the box never committed (the mark race) is served as consistent
//     false with the rebuilt digest and the reason, written once as an anchor.inconsistent audit line, change event and
//     log line (no ALARM: scripts/live-check.mjs WARNs on it), and never turned into a true; the promotion race (notes
//     written again while the box's update was in flight keep the earlier totals and its marks) is a false that names
//     the update, also when such a note is pending again; rows that cannot be digested are a false too;
//   - the route: public, testnet and on chain only, the current box only (any query parameter is 400 invalid_field, so
//     never an earlier box), read once per box and digest (kept at most COMMITTED_KEEP_MS), never inside the serial()
//     lock; on the pilot network it does not exist;
//   - Pilot.ledger() is unchanged by it: live totals, the pilot denomination only;
//   - docs/PILOT-API.md pins the construction and its vectors as the code has them.
// Run: node --test test/ledger-committed.unit.test.mjs
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const core = await import('../lib/pilot/core.mjs');
const routes = await import('../lib/pilot/http.mjs');
const committed = await import('../lib/pilot/committed.mjs');
const {createHandler} = await import('../lib/http.mjs');
const {Basis, BasisError, exactAmounts} = await import('../lib/basis.mjs');
const {debtKey, digest} = await import('../lib/avl.mjs');

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const RANDOM = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'avl-random.json'), 'utf8'));
// The 150 explicit rows (erg and three tokens, ten zero totals, totals up to 2^64 - 1) and the digest ergo_avltree_rust
// gives them in debt-key order.
const EXPLICIT = RANDOM.rows_cases.find(c => c.rows.length === 150);
// The live anchor 644995 (250 rows and R5 of its box), where the private checkout has it (avl.unit.test.mjs: the public
// copy leaves the vectors out).
const VECTOR = path.join(here, 'fixtures', 'anchor-vectors', '644995.json');
const PUBLIC_COPY = fs.existsSync(path.join(root, '.synced-from')) && !fs.existsSync(path.dirname(VECTOR));
const dirs = [], servers = [];
after(() => { for (const s of servers) s.close(); for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });

const H = c => c.repeat(64 / c.length), NFT = H('ab'), BOX1 = H('b1'), BOX2 = H('b2'), TX = H('7f'), TX_OLD = H('6e');
const hex = b => Buffer.from(b).toString('hex');
const ROW_KEYS = ['debt_key', 'issuer_pubkey', 'recipient_pubkey', 'denomination', 'committed_total'];
const U63 = 1n << 63n;

// GET /tracker/state data, as tracker v4.4 writes it.
const state = (over = {}) => ({local_digest: H('dd') + '08', confirmed_digest: EXPLICIT.debt_key_order, confirmed_box_id: BOX1, confirmed_height: 645189,
  pending_digest: H('ee') + '08', pending_tx_id: TX, pending_submitted_height: 645190, tracker_box_id: BOX1, ...over});

// A note as the tracker holds it: live total, and its confirmation {status, confirmed (digits or null), pending, tx}.
// confirmation null: the field is left out, as the tracker leaves it out when it cannot read it.
const note = (issuer, recipient, denomination, live, c = {status: 'confirmed', confirmed: live}) => ({issuer, recipient, denomination, live: String(live), confirmation: c});
const u64 = v => (v === null || v === undefined ? 'null' : String(v));    // a u64 as the tracker writes it: JSON number digits
function notesText(notes) {
  return `{"success":true,"data":[${notes.map((n, i) => {
    const c = n.confirmation;
    const conf = c === null ? '' : `,"confirmation":{"status":"${c.status}","confirmed_total_debt":${u64(c.confirmed)},"pending_total_debt":${u64(c.pending)},`
      + `"confirmed_box_id":${c.confirmed === null ? 'null' : `"${BOX1}"`},"confirmed_height":${c.confirmed === null ? 'null' : 645189},"pending_tx_id":${c.tx ? `"${c.tx}"` : 'null'},`
      + `"redeemable":false,"redeemable_amount":0}`;
    return `{"issuer_pubkey":"${n.issuer}","recipient_pubkey":"${n.recipient}","amount_collected":${n.live},"amount_redeemed":0,"timestamp":${1763150000000 + i},`
      + `"signature":"${'11'.repeat(65)}","tracker_nft_id":"${NFT}","age_seconds":5,"denomination":"${n.denomination}"${conf}}`;
  }).join(',')}],"error":null}`;
}

// The stub tracker: GET /tracker/state answers the next state of `states` (then `st`), GET /notes the notes; reads are
// counted. beforeNotes() runs at each notes read (a test moves the state there).
function stubTracker(notes, st = state()) {
  const t = {notes, st, states: [], reads: {state: 0, notes: 0}, beforeNotes: null};
  t.fetch = async url => {
    const p = new URL(url).pathname;
    if (p === '/tracker/state') {
      t.reads.state++;
      return new Response(JSON.stringify({success: true, data: t.states.length ? t.states.shift() : t.st, error: null}), {status: 200});
    }
    if (p === '/notes') { t.reads.notes++; t.beforeNotes?.(); return new Response(notesText(t.notes), {status: 200}); }
    return new Response('{"success":false,"error":"not found"}', {status: 404});
  };
  t.basis = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: NFT, denomination: 'erg', runSigner: () => { throw new Error('no signing here'); }, fetchImpl: t.fetch});
  return t;
}

// The explicit rows as tracker notes whose confirmations differ from their live totals: rows 1, 8, ... raised since the
// box (local_only, live = committed + 5), rows 2, 9, ... lowered since (a set-off: live = committed - 3), rows 3, 10, ...
// raised by the update in flight (pending under TX); the rest confirmed (live = committed). Plus notes no box committed
// (an erg note, a zero one, a token one): not rows.
const STRANGERS = [['02' + 'e1'.repeat(32), '03' + 'e2'.repeat(32), 'erg', 4_000_000], ['02' + 'e3'.repeat(32), '03' + 'e4'.repeat(32), 'erg', 0],
  ['03' + 'e5'.repeat(32), '02' + 'e6'.repeat(32), `token:${'c7'.repeat(32)}`, 12]];
function explicitNotes() {
  const out = EXPLICIT.rows.map((r, i) => {
    const t = BigInt(r.total), k = i % 7;
    if (k === 1 && t < U63) return note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, t + 5n, {status: 'local_only', confirmed: r.total});
    if (k === 2 && t >= 3n && t < U63) return note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, t - 3n, {status: 'local_only', confirmed: r.total});
    if (k === 3 && t < U63) return note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, t + 9n, {status: 'pending', confirmed: r.total, pending: t + 9n, tx: TX});
    return note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, r.total);
  });
  for (const [i, r, d, live] of STRANGERS) out.splice(17 * (out.length % 5), 0, note(i, r, d, live, {status: 'local_only', confirmed: null}));
  return out;
}

function pilotOver(t, {chain = {on_chain: true}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-committed-')); dirs.push(dir);
  const logs = [], events = [];
  const pilot = new core.Pilot({store: new core.PilotStore(dir), basis: t.basis, log: m => logs.push(m)});
  pilot.chain = {name: 'ergo-testnet', tracker_nft_id: NFT, explorer: 'https://testnet.ergoplatform.com', node: null, ...chain};
  pilot.changeListeners.add(c => events.push(c));
  const audit = () => { try { return fs.readFileSync(path.join(dir, 'pilot-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const anchorAudit = () => audit().filter(a => a.type === 'anchor.inconsistent');
  return {pilot, logs, events, anchorAudit, dir};
}

// The routes over real HTTP (lib/http.mjs, as the hosted server): get(path) -> {status, body}.
async function serve(pilot, cfg = {}) {
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public',
    pilotRoutes: routes.createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6, pilotIpReadLimitPerMinute: 1e6, committedRoute: true, ...cfg}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async p => {
    const r = await fetch(base + p);
    const text = await r.text();
    return {status: r.status, body: JSON.parse(text), text};
  };
}
const quiet = async (t, fn) => { t.mock.method(console, 'error', () => {}); return fn(); };
// A box per read (its id from the read's number), and a beforeNotes that moves the confirmed box at each of the first
// `times` notes reads: each read's second state read then names another box than its first.
const boxNo = n => n.toString(16).padStart(2, '0').repeat(32);
const moving = (t, times = Infinity) => { let n = 0; return () => { if (++n <= times) t.st = state({confirmed_box_id: boxNo(n)}); }; };

test('the rows are the committed totals, in every denomination: rows raised, lowered or in flight since the box keep the total it commits; uncommitted notes are not rows', async () => {
  const t = stubTracker(explicitNotes()), {pilot, anchorAudit, events} = pilotOver(t);
  const s = await pilot.committedSnapshot();
  assert.deepEqual(Object.keys(s), ['network', 'construction', 'box_id', 'height', 'digest', 'read_at', 'consistent', 'what_this_means', 'rows']);
  assert.deepEqual([s.network, s.construction, s.box_id, s.height, s.digest], ['valun-testnet-1', 'basis-avl/1', BOX1, 645189, EXPLICIT.debt_key_order]);
  assert.equal(s.consistent, true, 'the rows give the digest the Rust crate computed for them');
  assert.match(s.read_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(s.rows.length, 150, 'the three notes no box committed are left out');
  for (const r of s.rows) assert.deepEqual(Object.keys(r), ROW_KEYS);
  // every explicit row, at its committed total, exactly (decimal strings, up to 2^64 - 1)
  const want = new Map(EXPLICIT.rows.map(r => [hex(debtKey(r.issuer_pubkey, r.recipient_pubkey, r.denomination)), r]));
  for (const r of s.rows) {
    const w = want.get(r.debt_key);
    assert.ok(w, `row ${r.debt_key} is an explicit row`);
    assert.deepEqual([r.issuer_pubkey, r.recipient_pubkey, r.denomination, r.committed_total], [w.issuer_pubkey, w.recipient_pubkey, w.denomination, w.total]);
  }
  assert.deepEqual(s.rows.map(r => r.debt_key), [...s.rows.map(r => r.debt_key)].sort(), 'in ascending debt-key order');
  assert.ok(s.rows.some(r => r.denomination.startsWith('token:')), 'token rows');
  assert.ok(s.rows.filter(r => r.committed_total === '0').length >= 10, 'zero totals are rows');
  assert.ok(s.rows.some(r => r.committed_total === '18446744073709551615'), '2^64 - 1, exactly');
  for (const [i, r] of STRANGERS) assert.ok(!s.rows.some(x => x.issuer_pubkey === i && x.recipient_pubkey === r), 'a note no box committed is not a row');
  // the live totals are another ledger, with another digest
  const live = t.notes.map(n => ({issuer_pubkey: n.issuer, recipient_pubkey: n.recipient, denomination: n.denomination, total: n.live}));
  assert.notEqual(digest(live), s.digest);
  const differ = t.notes.filter(n => n.confirmation.confirmed !== null && n.live !== String(n.confirmation.confirmed));
  const raised = differ.filter(n => BigInt(n.live) > BigInt(n.confirmation.confirmed));
  assert.deepEqual([differ.length, raised.filter(n => n.confirmation.status === 'local_only').length, differ.filter(n => n.confirmation.status === 'pending').length], [43, 12, 16],
    '43 committed rows differ from their live totals: 12 raised and 15 lowered since the box (local_only), 16 raised by the update in flight (pending)');
  assert.deepEqual([t.reads.state, t.reads.notes], [2, 1], 'one settled read: state, notes, state');
  assert.deepEqual([anchorAudit(), events], [[], []], 'nothing is recorded for a consistent snapshot');
});

test('the live anchor 644995: its 250 published notes as committed rows give R5 of its box', {skip: PUBLIC_COPY && 'the live anchor vectors are not in the public copy'}, async () => {
  const v = JSON.parse(fs.readFileSync(VECTOR, 'utf8'));
  const t = stubTracker(v.rows.map(r => note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, r.total)),
    state({confirmed_digest: v.r5_digest, confirmed_box_id: v.box_id, confirmed_height: v.height, pending_tx_id: null, pending_digest: null}));
  const s = await pilotOver(t).pilot.committedSnapshot();
  assert.deepEqual([s.consistent, s.rows.length, s.box_id, s.height, s.digest], [true, 250, v.box_id, 644995, v.r5_digest]);
});

test('Pilot.ledger() is unchanged by the snapshot: live totals, in the pilot denomination only', async () => {
  const t = stubTracker(explicitNotes()), {pilot} = pilotOver(t);
  const before = JSON.stringify(await pilot.ledger());
  await pilot.committedSnapshot();
  const rows = await pilot.ledger();
  assert.equal(JSON.stringify(rows), before);
  const erg = t.notes.filter(n => n.denomination === 'erg');
  assert.equal(rows.length, erg.length, 'erg notes only, the three committed-or-not alike');
  assert.deepEqual(rows.map(r => r.total), erg.map(n => Number(n.live)), 'live totals, as Numbers, as before');
  assert.deepEqual(rows.map(r => r.confirmation), erg.map(n => n.confirmation.status));
  for (const r of rows) assert.deepEqual(Object.keys(r), ['issuer', 'issuer_handle', 'recipient', 'recipient_handle', 'issuer_pubkey', 'recipient_pubkey', 'total', 'redeemed', 'outstanding', 'timestamp', 'confirmation', 'unit']);
});

test('the box moving between the two state reads: one move is one retry; three moves, three; four in a row is 503 snapshot_moving and nothing recorded', async () => {
  // one move: the box changes while the notes are read, then holds
  let t = stubTracker(explicitNotes()), w = pilotOver(t);
  t.states = [state(), state({confirmed_box_id: BOX2, confirmed_height: 645190})];
  t.st = state({confirmed_box_id: BOX2, confirmed_height: 645190});
  let s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([t.reads.state, t.reads.notes], [4, 2], 'read again once');
  assert.deepEqual([s.box_id, s.height, s.consistent], [BOX2, 645190, true], 'the box the settled read names');
  // the digest alone, the height alone, and the update in flight alone each count as a move
  for (const moved of [{confirmed_digest: H('0d') + '08'}, {confirmed_height: 645191}, {pending_tx_id: TX_OLD}]) {
    t = stubTracker(explicitNotes()); w = pilotOver(t);
    t.states = [state(moved)];
    s = await w.pilot.committedSnapshot({pauseMs: 0});
    assert.equal(t.reads.notes, 2, JSON.stringify(moved));
    assert.equal(s.consistent, true);
  }
  // three moves in a row, then a settled read: the fourth read is the last allowed
  t = stubTracker(explicitNotes()); w = pilotOver(t);
  t.beforeNotes = moving(t, 3);
  s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([t.reads.notes, s.box_id, s.consistent], [4, boxNo(3), true]);
  // four moves in a row: 503, never a mismatch
  t = stubTracker(explicitNotes()); w = pilotOver(t);
  t.beforeNotes = moving(t);
  await assert.rejects(w.pilot.committedSnapshot({pauseMs: 0}), e => e.name === 'PilotError' && e.code === 'snapshot_moving' && e.status === 503
    && e.extra.retry_after_ms === committed.SNAPSHOT_RETRY_AFTER_MS && /4 times in a row/.test(e.message));
  assert.deepEqual([t.reads.notes, committed.SNAPSHOT_RETRIES], [4, 3], 'the first read and three more');
  assert.deepEqual([w.anchorAudit(), w.events, w.logs], [[], [], []], 'an unsettled read is never checked against the box');
});

test('notes mid-promotion (pending under an update that is not the one in flight) are read again; pending under the one in flight is settled', async () => {
  // The updater has recorded box 2 and cleared its update in flight, but not yet copied the pending totals: a read now
  // would mix the boxes. The next read finds them promoted.
  const promoted = explicitNotes(), mid = promoted.map(x => (x.confirmation.status === 'pending' ? {...x, confirmation: {...x.confirmation}} : x));
  for (const x of promoted) if (x.confirmation.status === 'pending') x.confirmation = {status: 'confirmed', confirmed: x.confirmation.pending};
  // box 2 commits the promoted totals (their digest, from the rows read exactly)
  const box2 = digest(committed.committedRows(exactAmounts(notesText(promoted)).data).map(r => ({...r, total: r.committed_total})));
  const t = stubTracker(mid, state({confirmed_box_id: BOX2, confirmed_digest: box2, pending_tx_id: null, pending_digest: null}));
  t.beforeNotes = () => { if (t.reads.notes === 2) t.notes = promoted; };
  const w = pilotOver(t);
  const s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([t.reads.notes, t.reads.state, s.box_id, s.digest, s.consistent], [2, 4, BOX2, box2, true]);
  assert.deepEqual(w.anchorAudit(), [], 'no false mismatch from the half-promoted read');
  // pendingElsewhere: the notes pending under an update other than the one in flight, as one string
  const read = exactAmounts(notesText(mid)).data, pending = mid.filter(x => x.confirmation.status === 'pending').length;
  assert.ok(pending >= 16);
  assert.equal(committed.pendingElsewhere(read, state({pending_tx_id: null})).split('\n').length, pending, 'no update in flight: every pending note');
  assert.equal(committed.pendingElsewhere(read, state({pending_tx_id: TX_OLD})).split('\n').length, pending, 'another update in flight: every pending note');
  assert.equal(committed.pendingElsewhere(read, state()), '', 'pending under the update in flight: none');
  // settleRead: such a read settles only when the read before it found the same notes under the same anchoring
  const idle = state({pending_tx_id: null, pending_digest: null}), first = committed.settleRead(idle, read, idle);
  assert.deepEqual([first.settled, first.held.marks], [false, committed.pendingElsewhere(read, idle)]);
  assert.equal(committed.settleRead(idle, read, idle, first.held).settled, true, 'the same marks under the same anchoring: no promotion is under way');
  assert.deepEqual(committed.settleRead(idle, read, {...idle, confirmed_box_id: BOX2}, first.held), {settled: false, held: null}, 'a move');
  const box2State = {...idle, confirmed_box_id: BOX2};
  assert.equal(committed.settleRead(box2State, read, box2State, first.held).settled, false, 'the same marks under another anchoring');
  const one = read.findIndex(x => x.confirmation.status === 'pending');
  const fewer = read.map((x, i) => (i === one ? {...x, confirmation: {...x.confirmation, status: 'confirmed', confirmed_total_debt: x.confirmation.pending_total_debt, pending_total_debt: null, pending_tx_id: null}} : x));
  assert.equal(committed.settleRead(idle, fewer, idle, first.held).settled, false, 'one promoted since: other marks, read again');
  assert.equal(committed.settleRead(idle, exactAmounts(notesText(promoted)).data, idle, first.held).settled, true, 'none left: settled');
  // the read with the in-flight update named is taken at once: its committed totals are still box 1's
  const t1 = stubTracker(mid), w1 = pilotOver(t1);
  const s1 = await w1.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([s1.box_id, s1.consistent, t1.reads.notes], [BOX1, true, 1]);
});

test('marks the tracker left on a note (pending under an update long confirmed, the same at every read) settle at the second read: they never lock the route out', async t => {
  // Tracker v4.4 keeps a note's marks when a write moves it off its marked total while the update is in flight, and the
  // note is pending again whenever a later write brings it back there. Here one note, under TX_OLD (confirmed long ago),
  // while TX is in flight; the records agree with the box. Before, every read of it was 503 snapshot_moving, until the
  // next update marked the note again.
  const notes = explicitNotes(), k = notes.findIndex(x => x.confirmation.status === 'confirmed' && BigInt(x.live) < U63 - 7n);
  const at = notes[k].live, back = String(BigInt(at) + 7n);
  notes[k] = {...notes[k], live: back, confirmation: {status: 'pending', confirmed: at, pending: back, tx: TX_OLD}};
  const tr = stubTracker(notes), w = pilotOver(tr);
  const s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tr.reads.notes, tr.reads.state, s.box_id, s.consistent], [2, 4, BOX1, true], 'read twice, then taken');
  assert.ok(s.rows.some(r => r.issuer_pubkey === notes[k].issuer && r.recipient_pubkey === notes[k].recipient && r.committed_total === at), 'the row is its committed total');
  // with no update in flight, the in-flight notes' marks are such marks too
  const tq = stubTracker(notes, state({pending_tx_id: null, pending_digest: null}));
  const sq = await pilotOver(tq).pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tq.reads.notes, sq.consistent], [2, true]);
  // through the route: 200 at every read, also once the snapshot kept for the box is older than COMMITTED_KEEP_MS
  const get = await serve(w.pilot);
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  try {
    for (let i = 0; i < 3; i++) {
      const r = await get('/pilot/v1/ledger/committed');
      assert.deepEqual([r.status, r.body.consistent, r.body.error], [200, true, undefined], `read ${i + 1}`);
      t.mock.timers.tick(routes.COMMITTED_KEEP_MS + 1000);
    }
  } finally { t.mock.timers.reset(); }
  assert.equal(tr.reads.notes, 2 + 3 * 2, 'each new snapshot of the box: two notes reads');
  assert.deepEqual(w.anchorAudit(), []);
});

test('marks that change at every read are not settled: four reads, then 503 snapshot_moving; marks that change once, then hold, settle', async () => {
  const notes = explicitNotes(), k = notes.findIndex(x => x.confirmation.status === 'confirmed' && BigInt(x.live) < U63 - 7n);
  const at = notes[k].live, back = String(BigInt(at) + 7n);
  const markedBy = tx => ({...notes[k], live: back, confirmation: {status: 'pending', confirmed: at, pending: back, tx}});
  let tr = stubTracker(notes), w = pilotOver(tr);
  tr.beforeNotes = () => { tr.notes = notes.map((x, i) => (i === k ? markedBy(boxNo(tr.reads.notes)) : x)); };
  await assert.rejects(w.pilot.committedSnapshot({pauseMs: 0}), e => e.code === 'snapshot_moving' && e.status === 503 && e.extra.retry_after_ms === committed.SNAPSHOT_RETRY_AFTER_MS
    && /4 times in a row/.test(e.message) && /was being promoted in its records/.test(e.message));
  assert.deepEqual([tr.reads.notes, w.anchorAudit(), w.logs], [4, [], []]);
  tr = stubTracker(notes); w = pilotOver(tr);
  tr.beforeNotes = () => { tr.notes = notes.map((x, i) => (i === k ? markedBy(tr.reads.notes === 1 ? TX_OLD : H('6f')) : x)); };
  const s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tr.reads.notes, s.consistent], [3, true], 'other marks at the second read, the same at the third');
});

test('consistent false: a confirmed total the box never committed (the mark_notes_pending race) is served, recorded once, and never turned into a true', async () => {
  // The box committed the explicit rows, but the tracker recorded one note at the live total of the moment it marked
  // the notes pending: a write that came after the digest was read.
  const notes = explicitNotes(), raced = notes.findIndex(x => x.confirmation.status === 'confirmed' && BigInt(x.live) < U63);
  const was = notes[raced].live;
  notes[raced] = {...notes[raced], live: String(BigInt(was) + 1n), confirmation: {status: 'confirmed', confirmed: String(BigInt(was) + 1n)}};
  const t = stubTracker(notes), w = pilotOver(t);
  const s = await w.pilot.committedSnapshot();
  assert.equal(s.consistent, false);
  assert.deepEqual(Object.keys(s), ['network', 'construction', 'box_id', 'height', 'digest', 'read_at', 'consistent', 'rebuilt_digest', 'inconsistency', 'what_this_means', 'rows']);
  assert.equal(s.digest, EXPLICIT.debt_key_order, 'the digest is the box\'s, as the tracker names it');
  assert.equal(s.rebuilt_digest, digest(s.rows.map(r => ({...r, total: r.committed_total}))), 'the rows\' own digest');
  assert.notEqual(s.rebuilt_digest, s.digest);
  assert.match(s.inconsistency, new RegExp(`the rows give digest ${s.rebuilt_digest} under basis-avl/1, not ${s.digest}`));
  assert.ok(s.rows.some(r => r.committed_total === String(BigInt(was) + 1n)), 'the rows are served as the tracker records them');
  assert.match(s.what_this_means, /do not give that box's digest/);
  // what the tracker does meanwhile: it refuses every build (it checks its records first), nothing reaches the chain
  assert.match(s.what_this_means, /the tracker refuses to build any redemption, for every note: it checks its records against the box before it builds one/);
  assert.doesNotMatch(s.what_this_means, /fail on chain/);
  assert.doesNotMatch(s.inconsistency, /still marked for update/, 'no marks left: the mark race leaves no tell');
  // fix inbox #65: what it is on an honest server, said plainly wherever it is reported, and what a reader does
  assert.ok(s.inconsistency.endsWith(`disagree with it (${committed.KNOWN_RACE})`), s.inconsistency);
  assert.equal(committed.KNOWN_RACE, 'tracker v4.4\'s known race after a box update, fix inbox #65: not tampering; it lasts until the tracker\'s next box');
  assert.match(s.what_this_means, /During or right after a box update this is tracker v4\.4's known race \(fix inbox #65\), not tampering/);
  assert.match(s.what_this_means, /What to do: wait for the tracker's next box \(GET \/pilot\/v1\/chain anchoring names it: usually within minutes, up to about 30 when Ergo testnet blocks are slow, or after 00:00 UTC once the daily cap of boxes is used up\) and read this again\./);
  assert.match(s.what_this_means, /The race never makes digest differ from R5 of the box: check that on a chain source of your own\.$/);
  const [line, ...more] = w.anchorAudit();
  assert.deepEqual(more, []);
  assert.deepEqual({...line, at: undefined}, {at: undefined, type: 'anchor.inconsistent', box_id: BOX1, height: 645189, digest: s.digest, rebuilt_digest: s.rebuilt_digest, rows: 150,
    read_at: s.read_at, inconsistency: s.inconsistency});
  assert.deepEqual(w.events, [{event: 'anchor.inconsistent', box_id: BOX1, height: 645189, digest: s.digest, rebuilt_digest: s.rebuilt_digest, rows: 150, read_at: s.read_at, inconsistency: s.inconsistency}]);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /^Pilot: anchor\.inconsistent: tracker box b1b1.*; the tracker builds no redemption until its records agree with the box$/);
  assert.ok(w.logs[0].includes(`(${committed.KNOWN_RACE})`) && line.inconsistency.includes(committed.KNOWN_RACE), 'the log line and the audit line say what it is (fix inbox #65)');
  // No ALARM: tracker v4.4's races make it routine, and a public read decides when it is written, so the operator's
  // live check WARNs on it and never FAILs (scripts/live-check.mjs, when this copy has it).
  assert.doesNotMatch(w.logs[0], /alarm|fail closed/i);
  const liveCheck = path.join(root, 'scripts', 'live-check.mjs');
  if (fs.existsSync(liveCheck)) {
    const report = (await import(pathToFileURL(liveCheck).href)).evaluate({status: {}, info: {}, ledger: {}, clearingCode: 200, fly: {mem: null, logs: {lines: [`app[x] ord [info] ${w.logs[0]}`]}}});
    const level = name => report.filter(x => x.name.includes(name)).map(x => x.level);
    assert.deepEqual([level('ALARM'), level('anchor.inconsistent'), level('errors in the recent logs')], [['ok'], ['warn'], []]);
  }
  // read again: still false, nothing recorded twice
  const again = await w.pilot.committedSnapshot();
  assert.deepEqual([again.consistent, again.rebuilt_digest], [false, s.rebuilt_digest]);
  assert.deepEqual([w.anchorAudit().length, w.events.length, w.logs.length], [1, 1, 1]);
  // through the route: served as 200, consistent false
  const get = await serve(w.pilot);
  const r = await get('/pilot/v1/ledger/committed');
  assert.deepEqual([r.status, r.body.consistent, r.body.rebuilt_digest], [200, false, s.rebuilt_digest]);
  // a failed audit write: the snapshot is still served, and the line is tried again at the next read
  const w2 = pilotOver(stubTracker(notes));
  w2.pilot.store.audit = () => { throw new Error('disk full'); };
  const s2 = await w2.pilot.committedSnapshot();
  assert.equal(s2.consistent, false);
  assert.match(w2.logs[0], /\(the audit line could not be written\)$/);
  delete w2.pilot.store.audit;
  await w2.pilot.committedSnapshot();
  assert.equal(w2.anchorAudit().length, 1, 'written at the next read');
});

test('the promotion race: notes written again while the box\'s update was in flight keep the earlier box\'s totals; consistent false names the update, also when such a note is pending again', async () => {
  // Update TX_BOX made the box (it commits the explicit rows), but three notes it carried were written again during its
  // flight, so the tracker did not promote them: they keep the earlier box's totals (4 less) and TX_BOX's marks. No
  // update is in flight now (the daily cap, say).
  const TX_BOX = H('5b'), idle = state({pending_tx_id: null, pending_digest: null});
  const base = EXPLICIT.rows.map(r => note(r.issuer_pubkey, r.recipient_pubkey, r.denomination, r.total));
  const raced = base.map((n, i) => i).filter(i => BigInt(base[i].live) >= 4n && BigInt(base[i].live) < U63).slice(0, 3);
  // status local_only: raised past the marked total during the flight; confirmed: lowered back to the earlier total (a
  // set-off or a transfer); pending: back at the marked total since (a later write)
  const racedNote = (n, status) => ({...n, live: String(BigInt(n.live) + {local_only: 11n, confirmed: -4n, pending: 0n}[status]),
    confirmation: {status, confirmed: String(BigInt(n.live) - 4n), pending: n.live, tx: TX_BOX}});
  const notes = base.map((n, i) => (raced.includes(i) ? racedNote(n, 'local_only') : n));
  const tr = stubTracker(notes, idle), w = pilotOver(tr);
  const s = await w.pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tr.reads.notes, s.consistent, s.digest], [1, false, EXPLICIT.debt_key_order], 'settled at once: no note is pending');
  const tell = `; with the 3 notes still marked for update ${TX_BOX} at the totals marked (pending_total_debt), the rows give that digest: the box commits what that update carried, and the tracker did not promote those notes, written again while it was in flight`;
  assert.ok(s.inconsistency.endsWith(tell), s.inconsistency);
  assert.ok(s.inconsistency.startsWith(`the rows give digest ${s.rebuilt_digest} under basis-avl/1, not ${s.digest}`));
  assert.equal(w.anchorAudit()[0].inconsistency, s.inconsistency, 'the audit line names the update');
  assert.match(w.logs[0], new RegExp(`still marked for update ${TX_BOX}`));
  // One of them lowered back to the earlier box's total during the flight: confirmed, its marks kept; the same tell.
  const lowered = base.map((n, i) => (raced.includes(i) ? racedNote(n, i === raced[1] ? 'confirmed' : 'local_only') : n));
  const tl = stubTracker(lowered, idle), sl = await pilotOver(tl).pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tl.reads.notes, sl.consistent], [1, false]);
  assert.ok(sl.inconsistency.endsWith(tell));
  // One of them brought back to its marked total by a later write: pending again under TX_BOX, the same at every read.
  // Before, every read of it was 503 snapshot_moving, which hid the disagreement until the next update.
  const again = base.map((n, i) => (raced.includes(i) ? racedNote(n, i === raced[0] ? 'pending' : 'local_only') : n));
  const tp = stubTracker(again, idle), sp = await pilotOver(tp).pilot.committedSnapshot({pauseMs: 0});
  assert.deepEqual([tp.reads.notes, sp.consistent], [2, false]);
  assert.ok(sp.inconsistency.endsWith(tell));
  // One note only: the singular
  const single = base.map((n, i) => (i === raced[0] ? racedNote(n, 'local_only') : n));
  const s1 = await pilotOver(stubTracker(single, idle)).pilot.committedSnapshot({pauseMs: 0});
  assert.ok(s1.inconsistency.endsWith(`; with the 1 note still marked for update ${TX_BOX} at the total marked (pending_total_debt), the rows give that digest: the box commits what that update carried, and the tracker did not promote that note, written again while it was in flight`));
  // A mark race on another note as well: the marked totals do not give the box's digest, so no update is named
  const both = notes.map((n, i) => (i === raced.at(-1) + 1 ? {...n, live: String(BigInt(n.live) + 1n), confirmation: {status: 'confirmed', confirmed: String(BigInt(n.live) + 1n)}} : n));
  const sb = await pilotOver(stubTracker(both, idle)).pilot.committedSnapshot({pauseMs: 0});
  assert.equal(sb.consistent, false);
  assert.doesNotMatch(sb.inconsistency, /still marked for update/);
  // The update in flight is never the tell: its marks are an update not made yet
  const inFlight = stubTracker(notes, state({pending_tx_id: TX_BOX}));
  const sf = await pilotOver(inFlight).pilot.committedSnapshot({pauseMs: 0});
  assert.equal(sf.consistent, false);
  assert.doesNotMatch(sf.inconsistency, /still marked for update/);
});

test('unpromoted: a note no box committed before becomes a row at its marked total; marks of an older update do not match; at most UNPROMOTED_TRIES updates are tried', () => {
  const [I, R] = STRANGERS[0], [I2, R2] = STRANGERS[1];
  const c = (status, confirmed, pending, tx) => ({status, confirmed_total_debt: confirmed, pending_total_debt: pending, pending_tx_id: tx});
  const n = (issuer, recipient, live, conf) => ({issuer_pubkey: issuer, recipient_pubkey: recipient, denomination: 'erg', amount_collected: live, confirmation: conf});
  // The box (update TX) commits I>R 50 and the new note I2>R2 9; the tracker kept I>R at 40 and I2>R2 uncommitted.
  const box = digest([{issuer_pubkey: I, recipient_pubkey: R, total: '50'}, {issuer_pubkey: I2, recipient_pubkey: R2, total: '9'}]);
  const read = [n(I, R, '60', c('local_only', '40', '50', TX)), n(I2, R2, '12', c('local_only', null, '9', TX))];
  assert.deepEqual(committed.unpromoted(read, {pending_tx_id: null}, box), {tx_id: TX, notes: 2});
  assert.equal(committed.selfCheck(committed.committedRows(read), box, {notes: read, st: {pending_tx_id: null}}).inconsistency.includes(`the 2 notes still marked for update ${TX}`), true);
  // marks of an older update (TX_OLD, a box before this one): its totals are not what this box commits
  const old = [n(I, R, '60', c('local_only', '40', '45', TX_OLD)), n(I2, R2, '12', c('local_only', null, '9', TX_OLD))];
  assert.equal(committed.unpromoted(old, {pending_tx_id: null}, box), null);
  // an update id that is not 64 lowercase hex characters is never named (the text is served and logged)
  for (const bad of [TX.toUpperCase(), `${TX}\nPilot: forged line`, 7, TX.slice(2)]) {
    assert.equal(committed.unpromoted(read.map(x => ({...x, confirmation: {...x.confirmation, pending_tx_id: bad}})), {pending_tx_id: null}, box), null, String(bad));
  }
  // Many updates' marks: only the UNPROMOTED_TRIES updates marked on the most notes are tried. The update that made the
  // box (boxNo(1)) is marked on one note, each other update on two.
  const key = i => '02' + (0x20 + i).toString(16).repeat(32);
  const marks = others => {
    const notes = [n(key(0), R, '5', c('local_only', '4', '5', boxNo(1)))];
    for (let j = 0; j < others; j++) for (const k of [1, 2]) notes.push(n(key(2 * j + k), R, '5', c('local_only', '4', '5', boxNo(2 + j))));
    return {notes, box: digest(notes.map((x, i) => ({issuer_pubkey: x.issuer_pubkey, recipient_pubkey: R, total: i === 0 ? '5' : '4'})))};
  };
  assert.equal(committed.UNPROMOTED_TRIES, 4);
  const four = marks(4), three = marks(3);
  assert.equal(committed.unpromoted(four.notes, {pending_tx_id: null}, four.box), null, 'four updates marked on more notes are tried first: the fifth is not');
  assert.deepEqual(committed.unpromoted(three.notes, {pending_tx_id: null}, three.box), {tx_id: boxNo(1), notes: 1}, 'the fourth is');
});

test('rows that cannot be digested (a malformed key, one debt key twice) are a failed check with the reason, never a pass or a 400', async () => {
  const notes = explicitNotes(), k = notes.findIndex(x => x.confirmation.status === 'confirmed');
  notes[k] = {...notes[k], issuer: notes[k].issuer.toUpperCase()};
  const w = pilotOver(stubTracker(notes));
  const s = await w.pilot.committedSnapshot();
  assert.deepEqual([s.consistent, s.rebuilt_digest], [false, null]);
  assert.match(s.inconsistency, /^the rows cannot be digested as the tracker digests its notes \(rows\[149\]\.issuer_pubkey must be a 33-byte compressed public key/);
  assert.equal(s.rows.at(-1).debt_key, null, 'a row without a debt key comes last, as the tracker gave it');
  assert.equal(s.rows.at(-1).issuer_pubkey, notes[k].issuer);
  assert.equal(w.anchorAudit().length, 1);
  const twice = explicitNotes();
  twice.push({...twice.find(x => x.confirmation.status === 'confirmed')});
  const s2 = await pilotOver(stubTracker(twice)).pilot.committedSnapshot();
  assert.equal(s2.consistent, false);
  assert.match(s2.inconsistency, /has the debt key of rows\[\d+\]: a tracker holds one note per issuer, recipient and denomination/);
});

test('the tracker\'s answer must say what is committed: no confirmed box is 503 no_confirmed_box; a note without its confirmation is 502, never a guess', async t => {
  const w = pilotOver(stubTracker(explicitNotes(), state({confirmed_digest: null, confirmed_box_id: null, confirmed_height: null})));
  await assert.rejects(w.pilot.committedSnapshot(), e => e.code === 'no_confirmed_box' && e.status === 503 && e.extra.retry_after_ms === committed.NO_BOX_RETRY_AFTER_MS);
  const get = await serve(w.pilot);
  const r = await get('/pilot/v1/ledger/committed');
  assert.deepEqual([r.status, r.body.error, r.body.retry_after_ms], [503, 'no_confirmed_box', 60000]);
  const notes = explicitNotes();
  notes[5] = {...notes[5], confirmation: null};
  const w2 = pilotOver(stubTracker(notes));
  await assert.rejects(w2.pilot.committedSnapshot(), e => e instanceof BasisError && /note 5 has no confirmation with confirmed_total_debt/.test(e.message));
  const get2 = await serve(w2.pilot);
  const r2 = await quiet(t, () => get2('/pilot/v1/ledger/committed'));
  assert.deepEqual([r2.status, r2.body.error], [502, 'tracker_unavailable']);
  assert.deepEqual(w2.anchorAudit(), []);
});

test('GET /ledger/committed: public, the current box only, read once per box and digest, kept at most COMMITTED_KEEP_MS', async t => {
  const tr = stubTracker(explicitNotes()), w = pilotOver(tr), get = await serve(w.pilot);
  const a = await get('/pilot/v1/ledger/committed');
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.body), ['network', 'construction', 'box_id', 'height', 'digest', 'read_at', 'consistent', 'what_this_means', 'rows']);
  assert.deepEqual([a.body.box_id, a.body.consistent, a.body.rows.length], [BOX1, true, 150]);
  assert.doesNotMatch(a.text, /_PC"/, 'unit-neutral names (fix inbox #32)');
  assert.deepEqual([tr.reads.state, tr.reads.notes], [3, 1], 'a state read for the box, then the snapshot\'s own read');
  const b = await get('/pilot/v1/ledger/committed');
  assert.equal(b.text, a.text, 'the same box and digest: the snapshot kept');
  assert.deepEqual([tr.reads.state, tr.reads.notes], [4, 1], 'one state read, no notes read');
  // concurrent requests share one read
  tr.st = state({confirmed_box_id: BOX2, confirmed_height: 645190});
  const both = await Promise.all([get('/pilot/v1/ledger/committed'), get('/pilot/v1/ledger/committed')]);
  assert.deepEqual(both.map(x => x.body.box_id), [BOX2, BOX2]);
  assert.equal(tr.reads.notes, 2, 'a new box: one new read for both requests');
  // older than COMMITTED_KEEP_MS: read again, though the box is the same
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  t.mock.timers.tick(routes.COMMITTED_KEEP_MS - 1000);
  await get('/pilot/v1/ledger/committed');
  assert.equal(tr.reads.notes, 2);
  t.mock.timers.tick(2000);
  await get('/pilot/v1/ledger/committed');
  assert.equal(tr.reads.notes, 3);
  t.mock.timers.reset();
});

test('GET /ledger/committed takes no parameters, so it never serves an earlier box; four moves are 503 snapshot_moving with retry_after_ms', async () => {
  const tr = stubTracker(explicitNotes()), w = pilotOver(tr), get = await serve(w.pilot);
  assert.equal((await get('/pilot/v1/ledger/committed')).body.box_id, BOX1);
  tr.st = state({confirmed_box_id: BOX2, confirmed_height: 645190});
  for (const q of [`?box=${BOX1}`, `?box_id=${BOX1}`, '?height=645189', '?at=2026-11-14T00:00:00Z', '?issuer=02' + 'aa'.repeat(32), '?x', '?=']) {
    const r = await get(`/pilot/v1/ledger/committed${q}`);
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_field'], q);
    assert.match(r.body.message, /takes no parameters: it serves the snapshot of the current tracker box only, never an earlier box/);
    assert.equal(r.body.rows, undefined, q);
  }
  assert.equal((await get('/pilot/v1/ledger/committed')).body.box_id, BOX2, 'only the current box');
  // a new box, then the box moving at every read
  tr.st = state({confirmed_box_id: H('c0')});
  tr.beforeNotes = moving(tr);
  const started = Date.now(), r = await get('/pilot/v1/ledger/committed');
  assert.deepEqual([r.status, r.body.error, r.body.retry_after_ms], [503, 'snapshot_moving', 5000]);
  assert.ok(Date.now() - started >= 6 * committed.SNAPSHOT_PAUSE_MS - 50, 'it paused before each read again (250, 500 and 750 ms)');
  assert.deepEqual(w.anchorAudit(), []);
});

test('GET /ledger/committed never takes the serial() lock: it answers while the lock is held', async () => {
  const w = pilotOver(stubTracker(explicitNotes())), get = await serve(w.pilot);
  let serials = 0;
  const serial = w.pilot.serial.bind(w.pilot);
  w.pilot.serial = fn => { serials++; return serial(fn); };
  w.pilot.lock = new Promise(() => {});          // a write that never finishes
  const r = await get('/pilot/v1/ledger/committed');
  assert.deepEqual([r.status, r.body.consistent, serials], [200, true, 0]);
});

test('fix inbox #65: GET /ledger/committed is served only while the tracker binary has TR-20; on tracker v4.4.1 it answers as a route the testnet does not have', async () => {
  const {TRACKER_SHA256_PINS, TRACKER_SHA256_TR20} = await import('../lib/pilot/pins.mjs');
  const V441 = 'd24e9a450030c918b1a553a2c3821bbbea1b4243a83c00f832b26150d9050a87';
  assert.ok(TRACKER_SHA256_PINS.includes(V441) && !TRACKER_SHA256_TR20.includes(V441), 'v4.4.1 is pinned and has no TR-20');
  for (const [sha, cfg, want] of [[V441, {committedRoute: undefined}, 401], [null, {committedRoute: undefined}, 401],
    [TRACKER_SHA256_TR20[0], {committedRoute: undefined}, 200], [V441, {committedRoute: true}, 200], [TRACKER_SHA256_TR20[0], {committedRoute: false}, 401]]) {
    const w = pilotOver(stubTracker(explicitNotes()));
    w.pilot.circulationConfig.trackerSha256 = sha;
    const get = await serve(w.pilot, cfg);
    const r = await get('/pilot/v1/ledger/committed');
    assert.equal(r.status, want, `sha ${sha} cfg ${JSON.stringify(cfg)}`);
    if (want === 401) assert.equal(r.body.error, 'unauthorized', 'the answer of any route the testnet does not have');
  }
});

test('GET /ledger/committed is on the testnet once on chain only: before the bootstrap 503, and on the pilot network it does not exist', async () => {
  const w = pilotOver(stubTracker(explicitNotes()), {chain: {on_chain: false}}), get = await serve(w.pilot);
  const r = await get('/pilot/v1/ledger/committed');
  assert.deepEqual([r.status, r.body.error], [503, 'testnet_bootstrapping']);
  // The pilot network (valun-pilot-1, its own process): the route falls through to the authenticated routes.
  const script = `import http from 'node:http';
    const {createPilotRoutes} = await import(${JSON.stringify(pathToFileURL(path.join(root, 'lib/pilot/http.mjs')).href)});
    const pilot = {chain: {on_chain: true}, s: {participants: {}}, unit: 'PC', mode: 'off', basis: {denomination: 'erg', nft: '${NFT}',
      trackerState: async () => ({}), allNotes: async () => []}, committedSnapshot: async () => ({rows: []}), selfServe: () => null, authenticate: () => null};
    const h = createPilotRoutes({pilot, cfg: {}});
    const srv = http.createServer(async (req, res) => {
      const send = (r, status, body) => { r.writeHead(status, {'content-type': 'application/json'}); r.end(JSON.stringify(body)); };
      try { await h(req, res, new URL(req.url, 'http://x'), send, () => '127.0.0.1'); } catch (e) { send(res, e.status || 500, {error: e.code}); }
    });
    srv.listen(0, '127.0.0.1', async () => {
      const r = await fetch('http://127.0.0.1:' + srv.address().port + '/pilot/v1/ledger/committed');
      console.log(JSON.stringify({status: r.status, body: await r.json()})); srv.close();
    });`;
  const env = {...process.env};
  delete env.PILOT_NETWORK;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {env, encoding: 'utf8', timeout: 20000});
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), {status: 401, body: {error: 'unauthorized'}}, 'no public route on the pilot');
});

test('the helpers: a move is the box, its digest or height, or the update in flight; rows come from confirmed_total_debt alone', () => {
  const a = state();
  assert.equal(committed.anchoringMoved(a, {...a}), false);
  assert.equal(committed.anchoringMoved(a, {...a, local_digest: H('01') + '08', pending_digest: null}), false, 'the live digest moves with every write: not a move');
  for (const f of ['confirmed_box_id', 'confirmed_digest', 'confirmed_height', 'pending_tx_id']) assert.equal(committed.anchoringMoved(a, {...a, [f]: null}), true, f);
  assert.equal(committed.anchoringMoved({...a, pending_tx_id: undefined}, {...a, pending_tx_id: null}), false, 'absent is null');
  const rows = committed.committedRows([{issuer_pubkey: STRANGERS[0][0], recipient_pubkey: STRANGERS[0][1], denomination: 'erg', amount_collected: '9', confirmation: {status: 'local_only', confirmed_total_debt: '0'}},
    {issuer_pubkey: STRANGERS[1][0], recipient_pubkey: STRANGERS[1][1], denomination: 'erg', amount_collected: '5', confirmation: {status: 'local_only', confirmed_total_debt: null}}]);
  assert.deepEqual(rows, [{debt_key: hex(debtKey(STRANGERS[0][0], STRANGERS[0][1])), issuer_pubkey: STRANGERS[0][0], recipient_pubkey: STRANGERS[0][1], denomination: 'erg', committed_total: '0'}]);
  assert.throws(() => committed.committedRows([{issuer_pubkey: STRANGERS[0][0], recipient_pubkey: STRANGERS[0][1], denomination: 'erg', confirmation: {status: 'confirmed'}}]), BasisError);
  assert.throws(() => committed.committedRows(null), BasisError);
  assert.deepEqual(committed.selfCheck([], RANDOM.empty_digest), {consistent: true, rebuilt_digest: RANDOM.empty_digest, inconsistency: null}, 'no committed note: the empty tree');
});

test('docs/PILOT-API.md pins the construction and its vectors, as the code and the fixtures have them', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'PILOT-API.md'), 'utf8');
  assert.ok(doc.includes(`\`${committed.CONSTRUCTION}\``));
  for (const d of ['da212e4773a6894d0cd2131551ae58e315943282f27400efd5fbb23e1e2d772808', '0d60d54d9871d4ecfc1d9eb1dbaf69a2eef75730b92425b24b6ab00104fe7aa508',
    '237616c865b69edef051b6b1edc3adf4072bf4d602cc174561fbc74fe8ec64e708', 'be6c8c55a438cb145a344bb42e1b2b81a5b946f7742bda3dfd3c2c3e09a41c3809', RANDOM.empty_digest]) {
    assert.ok(doc.includes(d), `the doc names ${d.slice(0, 12)}...`);
  }
  for (const box of ['37c96fe8bc6acc7103fd31c0e4c61487bd9a133dae1c9a1711d87b0e78502366', '857f963800cd350824e19e68407febd8ae3044a2b1cc535cb3451c8dc959043f',
    '5784957596ab07122d952e24a43e6edf3d83c668595c130922ec5ad20c5974c3']) assert.ok(doc.includes(box), `box ${box.slice(0, 12)}...`);
  assert.ok(doc.includes('GET /ledger/committed'));
  for (const f of ['box_age_blocks', 'novations_refused_from_height', 'tracker_less_redemption_from_height', 'snapshot_moving', 'no_confirmed_box',
    '**The promotion race.**', '**The mark race.**', 'the tracker refuses every redemption build']) assert.ok(doc.includes(f), f);
});
