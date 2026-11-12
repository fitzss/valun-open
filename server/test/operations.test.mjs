// Release v16 operations and documentation, without a tracker:
//   - scripts/pilot-downgrade-check.mjs refuses a v15 rollback while circulating credit is under way and otherwise writes a
//     backup and maps payment_due to note_failed;
//   - scripts/pilot-admin.mjs clearing run|status through the loopback admin routes;
//   - scripts/check-persistence.mjs --pilot (ledger notes, reconciliation, participants, the pilot tracker's digest);
//   - GET /info's description in each mode (OQ-49; mode off word for word v15's);
//   - lib/basis.mjs trackerPin (what /api/status names as the tracker source);
//   - the launchers pass the tracker binary's sha256 and the config layout;
//   - docs/PILOT-API.md names every route lib/pilot/http.mjs serves and every error code the pilot server answers.
// The container image (Dockerfile) and its rehearsal (scripts/rehearse-container.mjs) copy package.json, server.mjs,
// lib/, public/, test/ and only a few scripts, and both set the marker VALUN_APP_COPY=image: there a test whose files
// are not in that copy of the app is skipped, with the reason (needs() below), as the tracker tests skip on a tracker
// they cannot use. Anywhere else a missing file fails the test ('missing <file>'): a deliverable is gone.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHandler} from '../lib/http.mjs';
import {createPilotRoutes, INFO_DESCRIPTIONS} from '../lib/pilot/http.mjs';
import {trackerPin, TRACKER_BUILDS} from '../lib/basis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');     // a working tree may have CRLF
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Whether this copy of the app has every file a test reads or runs. If not: in the image's copy (VALUN_APP_COPY=image,
// the image and its rehearsal) the test is skipped with the reason; anywhere else it fails ('missing <file>').
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image: the image and its rehearsal copy only some of the repository's files)`);
  return false;
}
// Every temp folder a test makes is removed when the file ends.
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-ops-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const run = (script, args, {cwd = root, env = {}} = {}) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {cwd, env: {...process.env, ...env}});
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  c.on('error', reject); c.on('close', code => resolve({code, out, err}));
});
const listen = handler => new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const close = s => new Promise(r => { s.closeAllConnections?.(); s.close(r); });

// ---------------------------------------------------------------------------------------------------------------
// scripts/pilot-downgrade-check.mjs
const iso = t => new Date(t).toISOString();
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
function state(extra = {}) {
  const deal = (id, status, more = {}) => ({id, status, payer: 'vp_aaaaaaaaaaaa', payee: 'vp_bbbbbbbbbbbb', versions: [{v: 1, by: 'vp_aaaaaaaaaaaa'}], history: [], ...more});
  return {participants: {vp_aaaaaaaaaaaa: {id: 'vp_aaaaaaaaaaaa'}, vp_bbbbbbbbbbbb: {id: 'vp_bbbbbbbbbbbb'}}, invites: {}, approvals: {},
    deals: {
      vd_0000000000000001: deal('vd_0000000000000001', 'note_issued'),
      vd_0000000000000002: deal('vd_0000000000000002', 'payment_due', {payment: {method: 'transfer', transfer_id: 'vt_0000000000000002'}, transfer_ids: ['vt_0000000000000002'], payment_due_since: iso(NOW - 7200e3)}),
      vd_0000000000000003: deal('vd_0000000000000003', 'paid_by_transfer', {payment: {method: 'transfer', transfer_id: 'vt_0000000000000003', applied_at: iso(NOW - 3600e3)}, transfer_ids: ['vt_0000000000000003']}),
    },
    transfers: {
      vt_0000000000000002: {id: 'vt_0000000000000002', deal_id: 'vd_0000000000000002', state: 'expired', timestamp: NOW - 7200e3 + 999, fallback_after: NOW - 7200e3 + 999 + 3660e3, expires_at: iso(NOW - 6000e3)},
      vt_0000000000000003: {id: 'vt_0000000000000003', deal_id: 'vd_0000000000000003', state: 'applied', timestamp: NOW - 3600e3 + 999, expires_at: iso(NOW - 3000e3)},
    },
    setoffs: {vs_0000000000000001: {id: 'vs_0000000000000001', state: 'applied', expires_at: iso(NOW - 1000e3)}},
    edges: {'02aa>02bb': {novated: true}}, edge_log_tail: [], counters: {edge_seq: 3, journal_backfilled: true},
    ...extra};
}
const fixture = s => { const dir = tmp(), file = path.join(dir, 'pilot-state.json'); fs.writeFileSync(file, JSON.stringify(s, null, 1)); return {dir, file, text: fs.readFileSync(file, 'utf8')}; };
const unchanged = f => { assert.equal(fs.readFileSync(f.file, 'utf8'), f.text, 'the state file is unchanged'); assert.deepEqual(fs.readdirSync(f.dir), ['pilot-state.json'], 'no backup, no audit line'); };

test('pilot-downgrade-check refuses while a transfer collects, waits for its owner or is applied, and writes nothing', async t => {
  if (!needs(t, 'scripts/pilot-downgrade-check.mjs')) return;
  for (const tstate of ['collecting', 'awaiting_owner', 'applying']) {
    const s = state(); s.transfers.vt_0000000000000002.state = tstate; s.transfers.vt_0000000000000002.expires_at = iso(NOW + 600e3);
    s.deals.vd_0000000000000002.status = tstate === 'awaiting_owner' ? 'completion_awaiting_owner' : 'paying_by_transfer';
    const f = fixture(s), r = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
    assert.equal(r.code, 1, `${tstate}: ${r.out}${r.err}`);
    assert.match(r.out, /^REFUSED: /);
    assert.match(r.out, new RegExp(`transfer vt_0000000000000002 \\(deal vd_0000000000000002\\) is ${tstate}`));
    unchanged(f);
  }
});

test('pilot-downgrade-check refuses on an attempt of unknown outcome, a live set-off, a pending pay_by_transfer approval, a held bound note and a deal paying_by_transfer (also once its transfer has ended)', async t => {
  if (!needs(t, 'scripts/pilot-downgrade-check.mjs')) return;
  const cases = {
    outcome_unknown: s => { s.transfers.vt_0000000000000002.state = 'outcome_unknown'; },
    inconsistent: s => { s.transfers.vt_0000000000000002.state = 'inconsistent'; },
    setoff_collecting: s => { s.setoffs.vs_0000000000000001.state = 'collecting'; s.setoffs.vs_0000000000000001.expires_at = iso(NOW + 900e3); },
    setoff_applying: s => { s.setoffs.vs_0000000000000001.state = 'applying'; },
    approval: s => { s.approvals.va_000000000001 = {id: 'va_000000000001', kind: 'pay_by_transfer', state: 'pending', deal_id: 'vd_0000000000000002'}; },
    bound_note: s => { s.deals.vd_0000000000000002.status = 'completion_awaiting_owner'; s.deals.vd_0000000000000002.credit_note = {state: 'signed', note: {total: 3, timestamp: NOW - 10e3 + 997, signature: 'aa', prior_signature: 'bb'}}; },
    // The deal's own status refuses on its own: its transfer (vt_...2, expired) has already ended, so no transfer refuses.
    paying_deal: s => { s.deals.vd_0000000000000002.status = 'paying_by_transfer'; },
  };
  const expect = {outcome_unknown: /is outcome_unknown: it may have paid the deal/, inconsistent: /is inconsistent: it may have paid the deal/,
    setoff_collecting: /set-off vs_0000000000000001 is collecting/, setoff_applying: /set-off vs_0000000000000001 is applying/,
    approval: /approval va_000000000001 .* pending pay_by_transfer approval/, bound_note: /deal vd_0000000000000002 holds a bound credit note/,
    paying_deal: /deal vd_0000000000000002 is paying_by_transfer \(v15 does not know this status\)/};
  for (const [name, change] of Object.entries(cases)) {
    const s = state(); change(s);
    const f = fixture(s), r = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
    assert.equal(r.code, 1, `${name}: ${r.out}${r.err}`);
    assert.match(r.out, expect[name], name);
    if (name === 'paying_deal') assert.match(r.out, /still has 1 item of circulating credit under way/, 'the deal is the only refusal');
    unchanged(f);
  }
  // A collecting transfer past its window: still refused, with what to do.
  const s = state(); s.transfers.vt_0000000000000002.state = 'collecting'; s.transfers.vt_0000000000000002.expires_at = iso(NOW - 60e3);
  const f = fixture(s), r = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
  assert.equal(r.code, 1); assert.match(r.out, /its collection window ended .*run it once more/); unchanged(f);
});

test('pilot-downgrade-check succeeds without circulating credit under way: backup, payment_due -> note_failed, audit line; --dry-run writes nothing', async t => {
  if (!needs(t, 'scripts/pilot-downgrade-check.mjs')) return;
  const f = fixture(state());
  const dry = await run('pilot-downgrade-check.mjs', [f.file, '--dry-run', '--now', iso(NOW)]);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /^DRY RUN, nothing written: OK for a v15 rollback/);
  assert.match(dry.out, /payment_due -> note_failed: vd_0000000000000002 \(not written\)/);
  unchanged(f);
  const r = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^OK for a v15 rollback: no payment by transfer or set-off is under way\./);
  const files = fs.readdirSync(f.dir).sort();
  assert.deepEqual(files, ['pilot-audit.jsonl', 'pilot-state.json', 'pilot-state.json.v16-backup-20261109T120000Z']);
  assert.equal(fs.readFileSync(path.join(f.dir, files[2]), 'utf8'), f.text, 'the backup is the file as it was, byte for byte');
  const after = JSON.parse(fs.readFileSync(f.file, 'utf8')), before = JSON.parse(f.text);
  assert.equal(after.deals.vd_0000000000000002.status, 'note_failed');
  before.deals.vd_0000000000000002.status = 'note_failed';
  assert.deepEqual(after, before, 'nothing else changed');
  const audit = fs.readFileSync(path.join(f.dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(audit, [{at: iso(NOW), type: 'downgrade.v15_prepared', backup: 'pilot-state.json.v16-backup-20261109T120000Z', payment_due_to_note_failed: ['vd_0000000000000002']}]);
  assert.match(r.out, /migrate\(\) turns the payment-by-transfer record .* vd_0000000000000002, vd_0000000000000003/);
  assert.match(r.out, /paid_by_transfer, which v15 does not know.*vd_0000000000000003/);
  assert.match(r.out, /the 1 edge\(s\) a transfer or set-off changed will not match/);
  // v15 code on tracker v3.2: ordinary notes at the reserved endings and unbound notes on bound-only edges are refused.
  assert.match(r.out, /note: if only the app goes back to v15 and tracker v3\.2 keeps running: v15's ordinary credit-note templates can end in 995-999 ms, which tracker v3\.2 keeps for other operations and refuses \(an occasional note_failed: the payer signs a new note\), and tracker v3\.2 refuses every unbound note on a bound-only edge, so the 1 edge\(s\) a transfer or set-off changed can no longer be paid with v15's credit notes; run v15 with the 3df7ed93 tracker binary/);
  // Run again: another backup, never overwriting the first; nothing left to map.
  const again = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
  assert.equal(again.code, 0);
  assert.ok(fs.existsSync(path.join(f.dir, 'pilot-state.json.v16-backup-20261109T120000Z-1')));
  assert.equal(fs.readFileSync(path.join(f.dir, 'pilot-state.json.v16-backup-20261109T120000Z'), 'utf8'), f.text);
  assert.match(again.out, /payment_due -> note_failed: none/);
  // A deal whose earlier attempt is still in its D-1 window is named (v15 does not enforce it).
  const w = state(); w.transfers.vt_0000000000000002.fallback_after = NOW + 600e3;
  const g = fixture(w), rw = await run('pilot-downgrade-check.mjs', [g.file, '--dry-run', '--now', iso(NOW)]);
  assert.equal(rw.code, 0); assert.match(rw.out, /D-1's waiting time.*vd_0000000000000002 until 2026-11-09T12:10:00\.000Z/);
});

test('pilot-downgrade-check: a v15 state passes unchanged; usage and unreadable files exit 2', async t => {
  if (!needs(t, 'scripts/pilot-downgrade-check.mjs')) return;
  const v15 = {participants: {}, invites: {}, approvals: {}, deals: {vd_0000000000000001: {id: 'vd_0000000000000001', status: 'note_failed'}}};
  const f = fixture(v15), r = await run('pilot-downgrade-check.mjs', [f.file, '--now', iso(NOW)]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.text, 'nothing to map: the state is not rewritten');
  assert.ok(fs.existsSync(path.join(f.dir, 'pilot-state.json.v16-backup-20261109T120000Z')));
  assert.equal((await run('pilot-downgrade-check.mjs', [])).code, 2);
  assert.equal((await run('pilot-downgrade-check.mjs', [path.join(f.dir, 'missing.json')])).code, 2);
  const bad = fixture({nothing: true});
  const rb = await run('pilot-downgrade-check.mjs', [bad.file]);
  assert.equal(rb.code, 2); assert.match(rb.err, /is not a pilot state/); unchanged(bad);
});

// ---------------------------------------------------------------------------------------------------------------
// scripts/pilot-admin.mjs clearing run | status
test('pilot-admin clearing run and clearing status go through the loopback admin routes', async t => {
  if (!needs(t, 'scripts/pilot-admin.mjs')) return;
  const TOKEN = 'admin-token-for-the-test', dir = tmp();
  fs.writeFileSync(path.join(dir, 'admin-token'), TOKEN + '\n');
  const RUN = {id: 'run_1', at: '2026-11-09T12:00:00.000Z', reason: 'admin', eligible_edges: 5, excluded: {busy: 1, reserved: 0}, cycles_found: 2, expansions: 40,
    truncated: false, proposed: 2, applied_now: 1, skipped: [], setoffs: ['vs_aaaaaaaaaaaaaaaa', 'vs_bbbbbbbbbbbbbbbb']};
  const DIAG = {mode: 'on', engine: {enabled: true, interval_ms: 600000, limits: {}, last_run: null, started: true, last_batch_at: '2026-11-09T11:50:00.000Z'}, runs: [RUN],
    live: [{id: 'vs_bbbbbbbbbbbbbbbb', state: 'collecting', source: 'admin', run_id: 'run_1', created_at: RUN.at, expires_at: RUN.at, updated_at: RUN.at, amount: 2,
      members: ['vp_aaaaaaaaaaaa', 'vp_bbbbbbbbbbbb'], result: null, last_submission: null,
      edges: [{edge: 'a>b', issuer: 'vp_aaaaaaaaaaaa', recipient: 'vp_bbbbbbbbbbbb', decrease: 1, before: 2, new_total: 1, timestamp: 1, revision: 1, server_only: false, signed: {issuer: true, recipient: false}},
        {edge: 'b>a', issuer: 'vp_bbbbbbbbbbbb', recipient: 'vp_aaaaaaaaaaaa', decrease: 1, before: 3, new_total: 2, timestamp: 1, revision: 1, server_only: false, signed: {issuer: false, recipient: true}}]}],
    recent: [], cooldowns: {'set:abc': {until: '2026-11-09T18:00:00.000Z', reason: 'expired', setoff: 'vs_cccccccccccccccc'}}, expiry_streaks: {}, refusals: []};
  const seen = [];
  const pilot = {circulating: true, s: {invites: {}}, clearing: {run: async reason => { seen.push(reason); return RUN; }}, clearingDiagnostics: () => DIAG};
  const srv = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {}, adminTokenHash: sha(TOKEN)})}));
  try {
    const port = String(srv.address().port), args = ['--data', dir, '--port', port];
    const r1 = await run('pilot-admin.mjs', ['clearing', 'run', ...args]);
    assert.equal(r1.code, 0, r1.out + r1.err);
    assert.deepEqual(seen, ['admin']);
    assert.match(r1.out, /^clearing run run_1 at 2026-11-09T12:00:00\.000Z \(admin\): 5 eligible edges, 2 cycles found \(40 expansions\), 2 set-offs proposed, 1 applied at once/);
    assert.match(r1.out, /excluded edges: busy 1/);
    assert.match(r1.out, /set-offs: vs_aaaaaaaaaaaaaaaa, vs_bbbbbbbbbbbbbbbb/);
    const r2 = await run('pilot-admin.mjs', ['clearing', 'status', ...args]);
    assert.equal(r2.code, 0, r2.out + r2.err);
    assert.match(r2.out, /^mode on; engine enabled, batch every 600 s, last batch 2026-11-09T11:50:00\.000Z/);
    // signed n/m counts the issuer and the recipient slots of every edge (here one of each is signed).
    assert.match(r2.out, /live set-offs \(1\):\n {2}vs_bbbbbbbbbbbbbbbb {2}collecting {2}2 PC {2}2 members {2}2 edges {2}signed 2\/4/);
    assert.match(r2.out, /set:abc {2}until 2026-11-09T18:00:00\.000Z {2}\(expired, vs_cccccccccccccccc\)/);
    const r3 = await run('pilot-admin.mjs', ['clearing', 'status', '--json', ...args]);
    assert.deepEqual(JSON.parse(r3.out), DIAG);
    // Without the admin token the route is a 404 like any unknown one.
    fs.writeFileSync(path.join(dir, 'admin-token'), 'wrong');
    const r4 = await run('pilot-admin.mjs', ['clearing', 'run', ...args]);
    assert.equal(r4.code, 1); assert.match(r4.err, /HTTP 404: not found \(the clearing routes exist only while circulating credit runs/);
    fs.writeFileSync(path.join(dir, 'admin-token'), TOKEN);
    // Circulation off: the routes do not exist.
    pilot.circulating = false;
    const r5 = await run('pilot-admin.mjs', ['clearing', 'status', ...args]);
    assert.equal(r5.code, 1); assert.match(r5.err, /HTTP 404/);
    assert.deepEqual(seen, ['admin'], 'nothing ran');
  } finally { await close(srv); fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------------------------------------------------------
// scripts/check-persistence.mjs --pilot
test('check-persistence --pilot snapshots and compares the pilot ledger, reconciliation, participants and tracker digest', async t => {
  if (!needs(t, 'scripts/check-persistence.mjs')) return;
  const world = {digest: 'd'.repeat(64), total: 7, exact: true};
  const app = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), j = b => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(b)); };
    if (u.pathname === '/pilot/v1/info') return j({network: 'valun-pilot-1', tracker_nft_id: 'n'.repeat(64), denomination: `token:${'e'.repeat(64)}`});
    if (u.pathname === '/pilot/v1/ledger') return j({unit: 'PC', notes: [{issuer: 'vp_a', issuer_pubkey: '02aa', recipient: 'vp_b', recipient_pubkey: '02bb', total: world.total, redeemed: 0, outstanding: world.total, timestamp: 5, confirmation: 'local_only'}],
      reconciliation: [{issuer: 'a', recipient: 'b', tracker_total: world.total, issued_via_valun: 7, status: 'match', expected_total: 7, set_off: 0, transferred_in: 0, transferred_out: 0, exact: world.exact}]});
    if (u.pathname === '/pilot/v1/participants') return j([{id: 'vp_a', handle: 'a', pubkey: '02aa', status: 'active'}, {id: 'vp_b', handle: 'b', pubkey: '02bb', status: 'active'}]);
    if (u.pathname === '/api/status') return j({basis: {trackerNftId: 'm'.repeat(64)}});
    if (u.pathname === '/api/ledger') return j({trackerState: {local_digest: 'f'.repeat(64)}, notes: [], reconciliation: []});
    if (u.pathname === '/api/offers' || u.pathname === '/api/participants') return j([]);
    res.writeHead(404); res.end('{}');
  });
  const tracker = await listen((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({success: true, data: {local_digest: world.digest}})); });
  const dir = tmp(), file = path.join(dir, 'snap.json'), base = `http://127.0.0.1:${app.address().port}`, trk = `http://127.0.0.1:${tracker.address().port}`;
  try {
    const s = await run('check-persistence.mjs', ['snapshot', base, file, '--pilot', '--pilot-tracker', trk]);
    assert.equal(s.code, 0, s.out + s.err);
    assert.match(s.out, /^snapshot: pilot tracker NFT id, digest dddddddddddd\.\.\., 1 notes, 1 reconciliation rows, 2 participants/);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(snap.check, 'pilot'); assert.equal(snap.localDigest, world.digest);
    const same = await run('check-persistence.mjs', ['compare', base, file, '--pilot', '--pilot-tracker', trk]);
    assert.equal(same.code, 0, same.out + same.err); assert.match(same.out, /^SAME after restart: pilot tracker NFT id/);
    world.total = 8;
    const moved = await run('check-persistence.mjs', ['compare', base, file, '--pilot', '--pilot-tracker', trk]);
    assert.equal(moved.code, 1); assert.match(moved.out, /^DIFFERENT after restart: notes, reconciliation/); assert.match(moved.out, /notes: gone {5}02aa>02bb=7\/0@5/);
    world.total = 7; world.exact = false;
    const inexact = await run('check-persistence.mjs', ['compare', base, file, '--pilot', '--pilot-tracker', trk]);
    assert.equal(inexact.code, 1); assert.match(inexact.out, /^DIFFERENT after restart: reconciliation/);
    world.exact = true; world.digest = 'c'.repeat(64);
    const dig = await run('check-persistence.mjs', ['compare', base, file, '--pilot', '--pilot-tracker', trk]);
    assert.equal(dig.code, 1); assert.match(dig.out, /^DIFFERENT after restart: localDigest\n {2}Only the digest differs/);
    // A pilot snapshot is not compared without --pilot, and the demo check is as before.
    const wrong = await run('check-persistence.mjs', ['compare', base, file]);
    assert.equal(wrong.code, 2); assert.match(wrong.err, /is a pilot snapshot; compare it with --pilot/);
    const demo = path.join(dir, 'demo.json');
    assert.equal((await run('check-persistence.mjs', ['snapshot', base, demo])).code, 0);
    const dsame = await run('check-persistence.mjs', ['compare', base, demo]);
    assert.equal(dsame.code, 0); assert.equal(dsame.out, 'SAME after restart: tracker NFT id, digest, 0 notes, 0 offers, 0 participants\n');
    // The tracker cannot be reached: exit 2, nothing compared.
    const gone = await run('check-persistence.mjs', ['compare', base, file, '--pilot', '--pilot-tracker', 'http://127.0.0.1:9']);
    assert.equal(gone.code, 2); assert.match(gone.err, /^could not read/);
  } finally { await close(app); await close(tracker); fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------------------------------------------------------
// GET /info description (OQ-49)
test('/info description: v15\'s word for word in modes off and bound; with circulating credit it ends with the settlement label', async () => {
  const V15 = 'Valun pilot network: independently controlled agents propose, negotiate and accept service-for-credit deals. PC (pilot credits) are simulated units with no monetary value. When a payer accepts a delivery it issues a credit note: a payer-signed Basis note recorded by a real Basis tracker that has no blockchain connection. An issued note is an outstanding obligation; nothing in the pilot is settled (no redemption, reserve or clearing).';
  const settlement = /const CIRCULATION_SETTLEMENT = '([^']+)';/.exec(read('lib/pilot/core.mjs'))[1];
  const seen = {};
  for (const mode of ['off', 'bound', 'sandbox', 'on']) {
    const pilot = {mode, unit: 'PC', basis: {denomination: `token:${'e'.repeat(64)}`, nft: 'd'.repeat(64)}, s: {participants: {}}};
    const srv = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {}})}));
    try { seen[mode] = (await (await fetch(`http://127.0.0.1:${srv.address().port}/pilot/v1/info`)).json()).description; } finally { await close(srv); }
  }
  assert.equal(seen.off, V15); assert.equal(seen.bound, V15); assert.equal(INFO_DESCRIPTIONS.off, V15);
  for (const mode of ['sandbox', 'on']) {
    assert.doesNotMatch(seen[mode], /no redemption, reserve or clearing/, mode);
    assert.ok(seen[mode].startsWith(V15.slice(0, V15.indexOf(' An issued note'))), `${mode}: the same first sentences`);
    assert.ok(seen[mode].includes(`An issued note is ${settlement}`), `${mode}: the deal's settlement label with circulating credit`);
  }
  assert.ok(seen.on.endsWith(settlement));
  assert.ok(seen.sandbox.endsWith(' On this server circulating credit is on for sandbox participants only: the sandbox agents and those who joined with join-sandbox.'));
});

// ---------------------------------------------------------------------------------------------------------------
// lib/basis.mjs trackerPin and the pins
test('trackerPin names the Valun fork commit of a tracker v3 as the tracker\'s own report, "(binary not pinned)" unless its sha256 is pinned, and keeps the given text for any other tracker', () => {
  const FALLBACK = 'Basis 3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3 + sigma-rust 8120eddd';
  const caps = (commit, build = 'valun-circulating-credit/4') => ({tracker: 'basis', build, commit});
  const V32 = 'Basis tracker v3.2: Valun fork commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a (branch circulating-credit-v3.2 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself';
  const V31 = 'Basis tracker v3.1: Valun fork commit 24675ec1c0f374f29101812caf2fc87ab48468c9 (branch circulating-credit-v3 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself';
  for (const pinned of [true, false, undefined]) {
    assert.equal(trackerPin(null, FALLBACK, {pinned}), FALLBACK, 'a tracker before v3 (no capabilities)');
    assert.equal(trackerPin(undefined, FALLBACK, {pinned}), FALLBACK);
    assert.equal(trackerPin(caps('unknown'), FALLBACK, {pinned}), FALLBACK, 'no commit reported');
    assert.equal(trackerPin({...caps('1'.repeat(40)), build: 'other'}, FALLBACK, {pinned}), FALLBACK);
  }
  assert.equal(trackerPin(caps('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a'), FALLBACK, {pinned: true}), V32, 'a pinned binary: the report alone');
  assert.equal(trackerPin(caps('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a'), FALLBACK, {pinned: false}), `${V32} (binary not pinned)`,
    'an unpinned binary that reports the v3.2 commit (it could report any)');
  assert.equal(trackerPin(caps('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a'), FALLBACK), `${V32} (binary not pinned)`, 'not pinned unless said so');
  // Tracker v4 and v4.1 (the Valun testnet network) report the v3.2 build from another branch and base.
  assert.equal(trackerPin(caps('6f00d1636d5eff2122dfd2d57b3f2ad876e3a031'), FALLBACK, {pinned: true}),
    'Basis tracker v4.1 (anchored netting): Valun fork commit 6f00d1636d5eff2122dfd2d57b3f2ad876e3a031 (branch circulating-credit-v4 on Basis upstream 43e2173), as the tracker reports itself');
  assert.match(trackerPin(caps('602565e3179b1656d4cf35a292006a6899ac5c61'), FALLBACK), /^Basis tracker v4: .* \(branch circulating-credit-v4 on Basis upstream 43e2173\), .* \(binary not pinned\)$/);
  // Tracker v3.1 and v3 (build valun-circulating-credit/3) are still named as they report themselves; their binaries are
  // no longer pinned (circulating credit stays off on them: lib/pilot/caps.mjs).
  assert.equal(trackerPin(caps('24675ec1c0f374f29101812caf2fc87ab48468c9', 'valun-circulating-credit/3'), FALLBACK), `${V31} (binary not pinned)`);
  assert.match(trackerPin(caps('08f889931906beff6c2b69346965f400d740aa4a', 'valun-circulating-credit/3'), FALLBACK, {pinned: true}), /^Basis tracker v3: Valun fork commit 08f8899.* \(branch circulating-credit-v3 on .*, as the tracker reports itself$/);
  assert.match(trackerPin(caps('1'.repeat(40)), FALLBACK), /^Basis tracker v3\.2 \(an unlisted build\): Valun fork commit 1{40} \(branch circulating-credit-v3\.2 on .*, as the tracker reports itself \(binary not pinned\)$/);
  assert.match(trackerPin(caps('1'.repeat(40), 'valun-circulating-credit/3'), FALLBACK), /^Basis tracker v3 \(an unlisted build\): Valun fork commit 1{40} \(branch circulating-credit-v3 on .*\(binary not pinned\)$/);
  // A listed commit that reports another build than its own is an unlisted build of the build it reports.
  assert.match(trackerPin(caps('24675ec1c0f374f29101812caf2fc87ab48468c9'), FALLBACK), /^Basis tracker v3\.2 \(an unlisted build\): Valun fork commit 24675ec/);
  assert.match(trackerPin(caps('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', 'valun-circulating-credit/3'), FALLBACK), /^Basis tracker v3 \(an unlisted build\): Valun fork commit 4370418/);
  assert.deepEqual(Object.keys(TRACKER_BUILDS), ['b84b2e780894beb980d789be22ec888ffe97d65a', '4d91c47f3c51b1a3fa1a44951e7e389243c3fe7e', '6f00d1636d5eff2122dfd2d57b3f2ad876e3a031', '602565e3179b1656d4cf35a292006a6899ac5c61',
    '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', '24675ec1c0f374f29101812caf2fc87ab48468c9', '08f889931906beff6c2b69346965f400d740aa4a']);
  // server.mjs uses it for /api/status, pinned when the launcher's PILOT_TRACKER_SHA256 is in pins.mjs, and pins.mjs
  // names the same build.
  assert.match(read('server.mjs'), /cfg\.basisPin = trackerPin\(await basis\.capabilities\(\)\.catch\(\(\) => null\), cfg\.basisPin, \{pinned: TRACKER_SHA256_PINS\.includes\(env\.PILOT_TRACKER_SHA256\)\}\)/);
  assert.match(read('server.mjs'), /^import \{TRACKER_SHA256_PINS\} from '\.\/lib\/pilot\/pins\.mjs';$/m);
  assert.ok(read('lib/pilot/pins.mjs').includes('e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5'), 'pins.mjs: the v3.2 basis_server sha256');
  assert.ok(read('lib/pilot/pins.mjs').includes('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a'), 'pins.mjs: the v3.2 commit');
  assert.match(read('lib/basis.mjs').split('\n')[1], /tracker v3\.2 = Valun fork commit 4370418/);
});

test('basis/BUILD.md and basis/valun_signer.rs name the tracker v3.2 build that lib/pilot/pins.mjs pins', t => {
  if (!needs(t, 'basis/BUILD.md', 'basis/valun_signer.rs')) return;
  const build = read('basis/BUILD.md');
  assert.ok(build.includes('e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5'), 'BUILD.md: the v3.2 basis_server sha256');
  assert.ok(build.includes('43704183e1ba372e1b1788c414dfe4c8b0bc3f2a'), 'BUILD.md: the v3.2 commit');
  assert.ok(build.includes('dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a'), 'BUILD.md: the v3.2 valun_signer sha256');
  assert.ok(build.includes('cargo-home-v32'), 'BUILD.md: the CARGO_HOME the hashes depend on');
  assert.match(read('basis/valun_signer.rs').split('\n')[0], /tracker v3\.2 adds/);
  assert.ok(read('basis/valun_signer.rs').includes('Some("prior-ack-message")'), 'valun_signer.rs: the prior-ack-message subcommand');
});

test('the container entrypoint passes the tracker binary\'s own sha256 and BASIS_CONFIG_LAYOUT=auto', t => {
  if (!needs(t, 'scripts/docker-entrypoint.sh')) return;
  const entry = read('scripts/docker-entrypoint.sh');
  assert.match(entry, /export BASIS_CONFIG_LAYOUT="\$\{BASIS_CONFIG_LAYOUT:-auto\}"/);
  assert.match(entry, /PILOT_TRACKER_SHA256="\$\(sha256sum "\$ROOT\/bin\/basis_server" \| cut -d' ' -f1\)" \|\| PILOT_TRACKER_SHA256=""\nexport PILOT_TRACKER_SHA256/);
  assert.ok(entry.indexOf('export PILOT_TRACKER_SHA256') < entry.indexOf('node "$ROOT/app/server.mjs"'), 'computed before the app starts');
});

test('start-local gives the app the sha256 it computed in WSL, never one from the environment, and starts each tracker with BASIS_CONFIG_LAYOUT=auto', async t => {
  if (!needs(t, 'scripts/start-local.mjs')) return;
  // Importing start-local starts nothing: it runs only as the entry point.
  const {trackerSha256, trackerArgv, appEnv} = await import(pathToFileURL(path.join(root, 'scripts', 'start-local.mjs')).href);
  const H = c => c.repeat(64);
  assert.equal(trackerSha256({status: 0, stdout: `${H('c')}  /home/valun/bins/basis_server\n`, stderr: ''}), H('c'));
  for (const r of [{status: 1, stdout: '', stderr: 'sha256sum: /home/valun/bins/basis_server: No such file or directory\n'}, {status: null, stdout: null, error: new Error('spawnSync wsl.exe ENOENT')},
    {status: 1, stdout: `${H('c')}  /home/valun/bins/basis_server\n`, stderr: 'wsl: an error'}, {status: 0, stdout: 'not a hash\n'}, {status: 0, stdout: ''}, null])
    assert.equal(trackerSha256(r), '', `no hash from ${JSON.stringify(r)} (fail closed)`);
  const opts = sha256 => ({ports: {app: '4320', demo: '3048', pilot: '3058'}, bins: '/home/valun/bins', nfts: {demo: H('a'), pilot: H('b')}, dataDir: 'C:/v/data', pilotDir: 'C:/v/data-pilot', sha256});
  const outer = Object.freeze({PILOT_TRACKER_SHA256: H('0'), PILOT_CIRCULATION: 'on', PORT: '9999', VALUN_SOMETHING: 'kept'});
  assert.deepEqual(appEnv(outer, opts(H('c'))), {PILOT_CIRCULATION: 'on', VALUN_SOMETHING: 'kept', PORT: '4320', BASIS_RUNNER: 'wsl', BASIS_SIGNER: '/home/valun/bins/examples/valun_signer',
    BASIS_TRACKER_URL: 'http://127.0.0.1:3048', BASIS_TRACKER_NFT_ID: H('a'), VALUN_DATA_DIR: 'C:/v/data', VALUN_DEPLOYMENT: 'local', PILOT_TRACKER_URL: 'http://127.0.0.1:3058',
    PILOT_TRACKER_NFT_ID: H('b'), PILOT_DATA_DIR: 'C:/v/data-pilot', PILOT_TRACKER_SHA256: H('c')}, 'the computed sha256 replaces the environment\'s; the rest of the environment is kept');
  assert.equal(appEnv(outer, opts('')).PILOT_TRACKER_SHA256, '', 'no hash computed: empty (circulation stays off), never the environment\'s');
  assert.deepEqual(trackerArgv('/home/valun/run', '/home/valun/bins', ['BASIS_PORT=3058', 'BASIS_SERVED_TOKEN_SYMBOL=PC']),
    ['-d', 'valun-ic1', '-u', 'valun', '--exec', '/usr/bin/env', 'BASIS_CONFIG_LAYOUT=auto', 'BASIS_PORT=3058', 'BASIS_SERVED_TOKEN_SYMBOL=PC', '/home/valun/run/run-tracker.sh', '/home/valun/run', '/home/valun/bins/basis_server']);
  // And start-local uses them: the hash of the binary both trackers run, read in WSL, and the app started with appEnv.
  const src = read('scripts/start-local.mjs');
  assert.match(src, /const hashed = spawnSync\(WSL, \[\.\.\.D, '--exec', '\/usr\/bin\/sha256sum', `\$\{BINS\}\/basis_server`\], \{encoding: 'utf8'\}\);\n\s*const TRACKER_SHA256 = trackerSha256\(hashed\);/);
  assert.match(src, /spawn\(process\.execPath, \[path\.join\(root, 'server\.mjs'\)\], \{stdio: 'inherit',\n\s*env: appEnv\(process\.env, \{ports: PORTS, bins: BINS, nfts, dataDir, pilotDir, sha256: TRACKER_SHA256\}\)\}\)/);
  assert.match(src, /spawn\(WSL, trackerArgv\(RUNS\[name\], BINS, env\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// The image's copy of the app: what the container rehearsal stages, and needs()
test('needs(): a file a test needs that this copy of the app lacks fails the test (missing <file>), except in the image\'s copy (VALUN_APP_COPY=image: the image and its rehearsal), where the test is skipped with the reason', () => {
  const skipped = [], fake = {skip: m => skipped.push(m)}, saved = process.env.VALUN_APP_COPY;
  try {
    for (const v of [undefined, '', 'rehearsal', '1']) {
      if (v === undefined) delete process.env.VALUN_APP_COPY; else process.env.VALUN_APP_COPY = v;
      assert.equal(needs(fake, 'package.json', 'test/operations.test.mjs'), true, 'files that exist');
      assert.throws(() => needs(fake, 'package.json', 'scripts/no-such-script.mjs'), e => e instanceof assert.AssertionError && e.message === 'missing scripts/no-such-script.mjs', `VALUN_APP_COPY ${JSON.stringify(v)}`);
    }
    assert.deepEqual(skipped, [], 'nothing skipped outside the image\'s copy');
    process.env.VALUN_APP_COPY = 'image';
    assert.equal(needs(fake, 'scripts/no-such-script.mjs', 'docs/no-such-doc.md'), false);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /^needs scripts\/no-such-script\.mjs, docs\/no-such-doc\.md, which the container image's copy of the app does not have \(VALUN_APP_COPY=image/);
  } finally { if (saved === undefined) delete process.env.VALUN_APP_COPY; else process.env.VALUN_APP_COPY = saved; }
});

test('the container rehearsal stages every file the Dockerfile copies (the app folder\'s files and scripts; the binaries, run-tracker.sh and the entrypoint at the image\'s places) and sets the image\'s VALUN_APP_COPY marker; at the end it removes its WSL staging folder, unless --keep', async t => {
  if (!needs(t, 'Dockerfile', 'scripts/rehearse-container.mjs')) return;
  // The Dockerfile's COPY lines (continuation lines joined): each source, by whether it goes into /opt/valun/app.
  const docker = read('Dockerfile').replace(/\\\n/g, ' '), app = [], image = [];
  for (const line of docker.split('\n')) {
    const m = /^COPY\s+(?:--\S+\s+)*(.+)\s+(\S+)$/.exec(line.trim());
    if (m) for (const src of m[1].split(/\s+/)) (m[2].startsWith('/opt/valun/app') ? app : image).push(src);
  }
  assert.ok(app.includes('scripts/pilot-admin.mjs') && app.includes('lib') && image.includes('dist/bin/basis_server'), 'precondition: the COPY lines were read');
  // Importing the rehearsal starts nothing: it runs only as the entry point.
  const R = await import(pathToFileURL(path.join(root, 'scripts', 'rehearse-container.mjs')).href);
  for (const f of app) assert.ok(R.APP_FILES.includes(f), `the rehearsal stages ${f}, which the Dockerfile copies into the app folder`);
  for (const f of ['scripts/check-persistence.mjs', 'scripts/check-exposure.mjs', 'scripts/pilot-admin.mjs', 'scripts/valun-mcp-stdio.mjs', 'scripts/run-tests.mjs'])
    assert.ok(R.APP_FILES.includes(f), `the rehearsal stages ${f}`);
  assert.deepEqual(R.APP_FILES.filter(f => !app.includes(f)), ['scripts/run-tests.mjs'], 'besides the image\'s files, only the test list it runs');
  assert.deepEqual(R.IMAGE_FILES.map(([src]) => src).sort(), [...image].sort(), 'the files outside the app folder');
  assert.match(docker, /^ENV .*\bVALUN_APP_COPY=image\b/m, 'the image sets the marker');
  assert.equal(R.APP_COPY_MARKER, 'VALUN_APP_COPY=image', 'and the rehearsal sets the same');
  // The end of a rehearsal: its staging folder is removed (only a folder this script names), or kept with --keep.
  assert.deepEqual(R.parseArgs(['--tests-only']), {testsOnly: true, keep: false});
  assert.deepEqual(R.parseArgs(['--keep', '--tests-only']), {testsOnly: true, keep: true});
  assert.deepEqual(R.parseArgs([]), {testsOnly: false, keep: false});
  const T = '/home/valun/valun-app-ctest-20261109T120000Z', ran = [], sh = cmd => { ran.push(cmd); return {status: 0, stderr: ''}; };
  assert.equal(R.finish(T, {keep: false, sh}), `removed ${T}`);
  assert.deepEqual(ran, ['rm -rf -- "$1"'], 'one removal, of the folder passed as $1');
  assert.equal(R.finish(T, {keep: true, sh}), `kept ${T}`);
  assert.equal(ran.length, 1, '--keep: nothing removed');
  for (const other of ['/home/valun', '/home/valun/valun-app-ctest-', '/home/valun/valun-app-local', '/', `${T}/..`])
    assert.throws(() => R.finish(other, {keep: false, sh}), /refusing to remove/, other);
  assert.equal(ran.length, 1, 'never anything else');
  assert.match(R.finish(T, {keep: false, sh: () => ({status: 1, stderr: 'Device or resource busy\n'})}), /^could not remove \/home\/valun\/valun-app-ctest-20261109T120000Z \(remove it by hand\): Device or resource busy$/);
  // And the rehearsal uses them: the staged list, the marker in the test run's environment and the entrypoint's, finish at the end.
  const src = read('scripts/rehearse-container.mjs');
  assert.match(src, /spawnSync\('tar', \['-cf', '-', \.\.\.APP_FILES\]/);
  assert.match(src, /for \(const \[src, dst, mode\] of IMAGE_FILES\)/);
  assert.match(src, /const env = `[^`]*\$\{APP_COPY_MARKER\}`;/);
  assert.match(src, /`VALUN_DATA=\$\{DATA\}`, APP_COPY_MARKER,/);
  assert.match(src, /const end = code => \{ console\.log\(finish\(T, \{keep, sh\}\)\); process\.exit\(code\); \};/);
  assert.match(src, /if \(testsOnly\) \{ console\.log\(`test run exit code \$\{r\.status\}`\); end\(r\.status \?\? 1\); return; \}/);
  assert.match(src, /app\.on\('exit', c => end\(c \?\? 1\)\);/);
});

test('the container rehearsal passes PILOT_CIRCULATION, PILOT_OPEN_SANDBOX and NODE_OPTIONS to the entrypoint only when they are set, and never PILOT_TRACKER_SHA256', async t => {
  if (!needs(t, 'scripts/rehearse-container.mjs')) return;
  const R = await import(pathToFileURL(path.join(root, 'scripts', 'rehearse-container.mjs')).href);
  assert.deepEqual(R.PASS_ENV, ['PILOT_CIRCULATION', 'PILOT_OPEN_SANDBOX', 'NODE_OPTIONS']);
  assert.deepEqual(R.passEnv({}), [], 'a plain rehearsal: nothing added');
  assert.deepEqual(R.passEnv({PILOT_CIRCULATION: '', PILOT_OPEN_SANDBOX: undefined}), [], 'empty or unset: nothing');
  assert.deepEqual(R.passEnv({NODE_OPTIONS: '--max-old-space-size=128', PILOT_TRACKER_SHA256: 'cc0a6ade', VALUN_BINS: '/x', PATH: '/bin',
    PILOT_OPEN_SANDBOX: '1', PILOT_CIRCULATION: 'on', VALUN_WRITE_TOKEN: 'w'}),
  ['PILOT_CIRCULATION=on', 'PILOT_OPEN_SANDBOX=1', 'NODE_OPTIONS=--max-old-space-size=128'], 'only the three, in a fixed order');
  // The entrypoint's environment gets them (after the image's settings); the test run's environment does not.
  const src = read('scripts/rehearse-container.mjs');
  assert.match(src, /\.\.\.passEnv\(process\.env\),\n\s*`\$\{OPT\}\/docker-entrypoint\.sh`\]/);
  assert.doesNotMatch(/const env = `[^`]*`;/.exec(src)[0], /passEnv|PILOT_|NODE_OPTIONS/);
});

// ---------------------------------------------------------------------------------------------------------------
// docs/PILOT-API.md
test('docs/PILOT-API.md names every route the pilot server serves and every error code it answers', t => {
  if (!needs(t, 'docs/PILOT-API.md')) return;
  const doc = read('docs/PILOT-API.md'), src = read('lib/pilot/http.mjs');
  const ID = {'vd_[0-9a-f]{16}': '{vd}', 'vt_[0-9a-f]{16}': '{vt}', 'vs_[0-9a-f]{16}': '{vs}', 'v[st]_[0-9a-f]{16}': '{vt|vs}', 'vp_[0-9a-f]{12}': '{vp}', 'va_[0-9a-f]{12}': '{va}'};
  const routes = new Set([...src.matchAll(/p === '(\/[a-z/-]*)'/g)].map(m => m[1]));
  for (const m of src.matchAll(/\/\^((?:\\\/[^/$]*)+)\$\//g)) {
    let r = m[1].replace(/\\\//g, '/');
    for (const [re, name] of Object.entries(ID)) r = r.split(`(${re})`).join(name);
    const alt = /\(([a-z|]+)\)$/.exec(r);
    if (alt) for (const verb of alt[1].split('|')) routes.add(r.replace(alt[0], verb)); else routes.add(r);
  }
  assert.ok(routes.size >= 40, `routes found: ${routes.size}`);
  for (const r of routes) {
    const verb = /\/deals\/\{vd\}\/(counter|accept|decline|withdraw|deliver|complete|dispute)$/.exec(r);
    if (verb) { assert.ok(doc.includes(`/deals/{vd}/${verb[1]}`) || doc.includes(`…/${verb[1]}`), `docs name ${r}`); continue; }
    assert.ok(doc.includes(r), `docs name the route ${r}`);
  }
  const codes = new Set();
  for (const f of fs.readdirSync(path.join(root, 'lib', 'pilot')).filter(f => f.endsWith('.mjs'))) for (const m of fs.readFileSync(path.join(root, 'lib', 'pilot', f), 'utf8').matchAll(/new PilotError\('([a-z_]+)'/g)) codes.add(m[1]);
  for (const c of ['signer_unavailable', 'tracker_unavailable', 'signer_error']) codes.add(c);   // lib/basis.mjs BasisError
  assert.ok(codes.size >= 60, `codes found: ${codes.size}`);
  for (const c of codes) assert.ok(doc.includes(`\`${c}`), `docs name the error code ${c}`);
  // What release v16 changed in the operator's and the agent's powers and budgets.
  for (const s of ['POST /join-sandbox', 'PUT /limits', '360 reads per minute per token', '/admin/participants/{vp}/owner-token', 'npm test` is **not available inside the Docker image**',
    '20 minutes after it was **created**', '9. **No regeneration.**', '**+ 7 days**', 'These holds have no time limit', 'POST /owner/deals/{vd}/attempts/{vt}/resolve'])
    assert.ok(doc.includes(s), `docs: ${s}`);
  // Fix round 3: v15 code on tracker v3.2, the open owner decisions, the journal's completeness (D-3 d), retracted
  // consent roles (D-3 b), the pin text, the sandbox box shown, and where a missing file is skipped.
  for (const s of ['**v15 code on tracker v3.2**', 'can end in 995-999\n  ms, which tracker v3.2 keeps', 'refuses every unbound note on a bound-only edge', '**Open owner decisions**',
    '*Bounding `deliver_by` on sandbox purchases.*', '*v15\'s `migrate()` and a v16 deal\'s `payment` record.*', '`503\n  journal_unavailable {missing_from, missing_to}`',
    '`journal.incomplete {where, missing_from, missing_to}`', '`X-Valun-Features: consents/1;roles=` (an empty list)', 'as the\n  tracker reports itself`', '(binary not pinned)',
    'its `credit_policy` and `effective_limits` show `max_claims_total: 40`', 'counts once, as\nits transfer', 'set `VALUN_APP_COPY=image`', 'unless `--keep`'])
    assert.ok(doc.includes(s), `docs: ${JSON.stringify(s)}`);
  // The reasons of 409 stale_payment (approving a pay_by_transfer approval): every code stalePayment returns, itself or
  // through paymentBlock (decision D-1), and the codes of the creation checks it runs again.
  const core = read('lib/pilot/core.mjs'), body = name => { const i = core.search(new RegExp(`\\n  (async )?${name}\\(`)); assert.ok(i > 0, name); return core.slice(i, core.indexOf('\n  }\n', i)); };
  const reasons = new Set(['payment_not_accepted', 'edge_busy']);
  for (const f of ['stalePayment', 'paymentBlock', 'paymentBlockAt', 'transferAttemptsBlock']) for (const m of body(f).matchAll(/\{code: '([a-z_]+)'/g)) reasons.add(m[1]);
  assert.ok(reasons.size >= 11, [...reasons].join());
  const para = doc.slice(doc.indexOf('`409 stale_payment {reason'), doc.indexOf('Otherwise the server-run issuer'));
  assert.ok(para.length > 100 && para.length < 2000, 'the docs paragraph on approving a payment by transfer');
  for (const r of reasons) assert.ok(para.includes(`\`${r}\``), `docs: stale_payment reason ${r}`);
});
