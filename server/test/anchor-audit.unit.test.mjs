// scripts/ops/anchor-audit.mjs, the independent anchor audit (fix inbox #62, steps 5 and 5b), on recorded reads and no
// network (an in-process fetch serves them; the CLI test serves them on loopback):
//   - the three live anchors (test/fixtures/anchor-vectors/<height>.responses.json: GET /pilot/v1/chain before and after
//     GET /pilot/v1/ledger, as the testnet answered them, and the explorer's one unspent box holding the tracker NFT)
//     give MATCH, with the box, its creation height, the rows, the box's age and the two windows, the rows in any order;
//   - one verdict table for both auditors (fix inbox #66): on the 41 recorded reads of test/fixtures/anchor-vectors/
//     xtool.json this audit gives the exit code `valun audit` gives (docs/PILOT-API.md "Verdicts", which says where
//     the client still compares less, and calls no RACE "not tampering"), and a MISMATCH (exit 1) is only a box that
//     on the source does not commit what the server says it commits;
//   - a published total moved by 1, a dropped row or a fabricated row is a MISMATCH (exit 1) in the committed snapshot,
//     and in GET /ledger rows that give neither R5 nor the digest GET /chain names, exit 2 (not the anchored state);
//   - the chain source is inconsistent (exit 2) when it lists two unspent boxes for the NFT, a spent box, a box without
//     the NFT, no box, or an R5 that is no AvlTree; an R5 of another construction is exit 2 too; no source, or two, is
//     refused (exit 2), and the node the server itself names is used with a warning;
//   - the server's state: not anchored now (or not naming its box), or moving between the reads, is exit 2, never a
//     false MISMATCH; rows that cannot be digested (two with one debt key, a total of 2^64) are exit 2, and so is a
//     total written as a JSON number above 2^53 - 1, which a JavaScript server may have rounded; a decimal string is
//     read exactly at any size;
//   - the box the server names, when its rows give that box's claimed digest and not the chain's: looked up on the
//     source, a MISMATCH when its R5 there is another digest, when it holds no tracker NFT, and when the source does
//     not have it although it holds a tracker box created later than the height claimed; exit 2 for a box the source
//     may not have yet (or past SOURCE_GRACE_BLOCKS: a lagging index), one holding the NFT later than first, or one
//     replaced (within MOVED_GRACE_BLOCKS or long ago), and for rows that give neither digest (a snapshot saying
//     consistent: true then contradicts itself, and the line says so);
//   - the tracker NFT: pinned for the known servers and by --tracker-nft, else named by the reserves at the pinned
//     contract; a decoy is exit 2; rows that give R5 of a box holding it later than first (no redemption can use the
//     box) are exit 2;
//   - GET /pilot/v1/ledger/committed when the server has it (its rows, box and check), retried on 503 snapshot_moving;
//     a MISMATCH its own check reports (consistent: false) with its digest R5 is consistent with tracker v4.4's race
//     (fix inbox #65) and with a server serving other rows that says so: its line says both, and tracker_race marks it;
//   - the direct reserve cover per issuer key, apart from the verdict, and only on a MATCH, from the reserves the tracker
//     admits (each lineage replayed to a root the owner paid for, clean): dust and other keys' boxes are quarantined,
//     two lineages count the smaller, a fork 0; a cut listing or used-up reads fail closed;
//   - the register and address decoders, the node as a source, the CLI's exit codes and --json line (through a linked
//     folder too, and the entry check of a node without import.meta.main), and scripts/ops/anchor-watch.sh, which fails
//     closed and counts tracker_race runs apart (RACE), not as MISMATCHes, except on a box one of its runs MATCHed
//     (RACE_AFTER_MATCH, exit 2) (bash only: skipped on Windows itself).
// The script and the live vectors are private (scripts/ops/sync-open.py PRIVATE_PATHS) and the container image ships
// neither: there (the public copy, or VALUN_APP_COPY=image) these tests are skipped; anywhere else a missing file fails.
// Run: node --test test/anchor-audit.unit.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {debtKey, digest} from '../lib/avl.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'ops', 'anchor-audit.mjs');
const vectors = path.join(root, 'test', 'fixtures', 'anchor-vectors');
const HEIGHTS = [644995, 645135, 645189];
const needed = [script, path.join(vectors, 'reserves.explorer.json'), path.join(vectors, 'xtool.json'),
  ...HEIGHTS.flatMap(h => [path.join(vectors, `${h}.json`), path.join(vectors, `${h}.responses.json`)])];
const OTHER_COPY = fs.existsSync(path.join(root, '.synced-from')) || process.env.VALUN_APP_COPY === 'image';
let A = null;
async function load(t) {
  const missing = needed.filter(f => !fs.existsSync(f)).map(f => path.relative(root, f));
  if (missing.length) {
    if (!OTHER_COPY) assert.fail(`missing ${missing.join(', ')}`);
    t.skip(`needs ${missing.join(', ')}, which the public copy and the container image do not have`);
    return null;
  }
  A ??= await import(pathToFileURL(script).href);
  return A;
}
const read = f => JSON.parse(fs.readFileSync(path.join(vectors, f), 'utf8'));
const V = {}, VEC = {};
const vector = h => (V[h] ??= read(`${h}.responses.json`));
const vec = h => (VEC[h] ??= read(`${h}.json`));

const SERVER = 'https://valun.test', EXPLORER = 'https://explorer.test', NODE = 'https://node.test';
const clone = x => JSON.parse(JSON.stringify(x));
const AGE = 120;
const EMPTY_TREE = '4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900';
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

// The recorded reads of one anchor as a fetch: the server (GET /chain answers its recorded reads in turn, then the last
// again; GET /ledger/committed is the testnet's 401 for a route it does not have) and the explorer, whose boxes/{id} and
// transactions/{id} answer from w.boxes and w.txs (404 for any other id). `o` overrides any part; `calls` records every
// request as 'METHOD path'.
function world(h, o = {}) {
  const v = vector(h), nft = v.chain[0].tracker_nft_id, address = v.chain[0].reserve_contract;
  const w = {calls: [], chain: o.chain ?? clone(v.chain), ledger: o.ledger ?? clone(v.ledger), committed: o.committed ?? null,
    byToken: o.byToken ?? clone(v.explorer_unspent_by_token), height: o.height ?? h + AGE, reserves: o.reserves ?? [], nft, address,
    boxes: new Map(Object.entries(o.boxes ?? {})), txs: new Map(Object.entries(o.txs ?? {}))};
  let chainReads = 0;
  w.fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    w.calls.push(`${method} ${u.origin === SERVER ? '' : `${u.origin}`}${u.pathname}${u.search}`);
    if (u.origin === SERVER) {
      assert.equal(method, 'GET', 'the audit only GETs from the server');
      if (u.pathname === '/pilot/v1/chain') return json(200, w.chain[Math.min(chainReads++, w.chain.length - 1)]);
      if (u.pathname === '/pilot/v1/ledger') return json(200, w.ledger);
      if (u.pathname === '/pilot/v1/ledger/committed') {
        const c = typeof w.committed === 'function' ? w.committed() : w.committed;
        return c ? (c instanceof Response ? c : json(200, c)) : json(401, {error: 'unauthorized', message: 'missing or invalid token'});
      }
      return json(404, {error: 'not_found'});
    }
    if (u.origin === EXPLORER) {
      assert.equal(method, 'GET', 'the audit only GETs from the explorer');
      if (u.pathname === `/api/v1/boxes/unspent/byTokenId/${w.nft}`) return json(200, w.byToken);
      if (u.pathname === '/api/v1/networkState') return json(200, {lastBlockId: 'ab'.repeat(32), height: w.height, maxBoxGix: 1, maxTxGix: 1});
      if (u.pathname === `/api/v1/boxes/unspent/byAddress/${w.address}`) {
        const offset = Number(u.searchParams.get('offset')), limit = Number(u.searchParams.get('limit'));
        return json(200, {items: w.reserves.slice(offset, offset + limit), total: w.reserves.length});
      }
      const m = u.pathname.match(/^\/api\/v1\/(boxes|transactions)\/([0-9a-f]{64})$/);
      const hit = m && (m[1] === 'boxes' ? w.boxes : w.txs).get(m[2]);
      if (hit) return json(200, hit);
    }
    return json(404, {status: 404, reason: 'not-found'});
  };
  return w;
}
// The audit of a world, with the tracker NFT pinned (as for a known server; test/anchor-audit's own server is not one).
const run = (w, o = {}) => A.audit({server: SERVER, explorer: EXPLORER, fetchImpl: w.fetchImpl, settleMs: 0, sleep: async () => {}, cover: false, trackerNft: w.nft, ...o});
const rowsOf = notes => notes.map(n => ({issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, total: n.total}));
// The explorer box of `h`, with R5 set to commit `d` (and optional other fields).
const boxWith = (h, d, more = {}) => {
  const b = clone(vector(h).explorer_unspent_by_token);
  b.items[0].additionalRegisters.R5.serializedValue = `64${d}032000`;
  Object.assign(b.items[0], more);
  return b;
};

test('three live anchors: the recorded reads give MATCH, with the box, its height, the rows, its age and the two windows', async t => {
  if (!await load(t)) return;
  for (const h of HEIGHTS) {
    const w = world(h), r = await run(w), v = vec(h);
    assert.equal(r.verdict, 'MATCH', `${h}: ${r.reason}`);
    assert.equal(r.exit, 0);
    assert.deepEqual([r.box.box_id, r.box.tx_id, r.box.height, r.box.digest, r.box.r5], [v.box_id, v.tx_id, h, v.r5_digest, v.r5]);
    assert.deepEqual(r.box.tree, {flags: 3, key_length: 32, value_length: null});
    assert.deepEqual([r.data.rows, r.data.digest, r.data.route], [v.rows.length, v.r5_digest, 'GET /pilot/v1/chain, /pilot/v1/ledger, /pilot/v1/chain']);
    assert.deepEqual(r.data.server, {box_id: v.box_id, height: h, digest: v.r5_digest, consistent: null});
    assert.deepEqual([r.chain_height, r.box_age_blocks], [h + AGE, AGE]);
    assert.deepEqual(r.windows, {novations_refused_from_height: h + 1440, tracker_less_redemption_from_height: h + 2161, novations_refused_now: false, tracker_less_redemption_open_now: false});
    assert.equal(r.box.tracker_pubkey, v.chain?.tracker_pubkey ?? vector(h).explorer_unspent_by_token.items[0].additionalRegisters.R4.renderedValue);
    assert.deepEqual([r.network, r.source, r.warnings], ['valun-testnet-1', {kind: 'explorer', url: EXPLORER, named_by_server: false}, []]);
    assert.deepEqual(w.calls, ['GET /pilot/v1/chain', 'GET /pilot/v1/ledger/committed', 'GET /pilot/v1/ledger', 'GET /pilot/v1/chain',
      `GET ${EXPLORER}/api/v1/boxes/unspent/byTokenId/${w.nft}?offset=0&limit=10`, `GET ${EXPLORER}/api/v1/networkState`], `${h}: the reads, in order`);
    assert.match(A.render(r), new RegExp(`^MATCH: R5 of the one unspent box holding the tracker NFT commits exactly the ${v.rows.length} notes`, 'm'));
  }
  // The windows as heights pass: refused nettings from +1440, tracker-less redemption from +2161 (HEIGHT - H > 2160).
  for (const [age, refused, open] of [[1439, false, false], [1440, true, false], [2160, true, false], [2161, true, true]]) {
    const r = await run(world(645189, {height: 645189 + age}));
    assert.deepEqual([r.box_age_blocks, r.windows.novations_refused_now, r.windows.tracker_less_redemption_open_now], [age, refused, open], `age ${age}`);
  }
});

test('the rows in any order still MATCH: shuffled, reversed, by total; the explorer URL may name /api/v1 itself', async t => {
  if (!await load(t)) return;
  const v = vector(645135);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const orders = [[...v.ledger.notes].reverse(), [...v.ledger.notes].sort((a, b) => a.total - b.total), [...v.ledger.notes].sort(() => rnd() - 0.5)];
  for (const notes of orders) {
    const r = await run(world(645135, {ledger: {...v.ledger, notes}}));
    assert.equal(r.verdict, 'MATCH');
  }
  assert.equal((await run(world(645135), {explorer: `${EXPLORER}/api/v1/`})).verdict, 'MATCH');
});

test('a published total moved by 1, a dropped row or a fabricated row (also of total 0): in the committed snapshot a MISMATCH, exit 1; in GET /ledger exit 2 unless /chain names their digest', async t => {
  if (!await load(t)) return;
  const h = 644995, v = vector(h), notes = v.ledger.notes, box = vec(h).box_id, r5 = vec(h).r5_digest;
  const cases = {
    'a total + 1': notes.map((n, i) => (i === 17 ? {...n, total: n.total + 1} : n)),
    'a total - 1': notes.map((n, i) => (i === 200 && n.total > 0 ? {...n, total: n.total - 1} : i === 200 ? {...n, total: 1} : n)),
    'a dropped row': notes.filter((_, i) => i !== 42),
    'a dropped zero row': notes.filter((n, i) => i !== notes.findIndex(x => x.total === 0)),
    'a fabricated row': [...notes, {...notes[0], issuer_pubkey: `02${'ab'.repeat(32)}`, total: 1500000}],
    'a fabricated zero row': [...notes, {...notes[0], issuer_pubkey: `02${'ab'.repeat(32)}`, total: 0}],
  };
  for (const [name, n] of Object.entries(cases)) {
    // The committed snapshot: the server says box 644995 commits these rows, and that they give its digest
    // (consistent: true): they do not give R5 of that box on the source.
    const w = world(h, {committed: committedOf(h, rowsOf(n))}), r = await run(w, {cover: true});
    assert.deepEqual([r.verdict, r.exit, r.tracker_race], ['MISMATCH', 1, false], name);
    assert.ok(!w.calls.some(c => c.includes('byAddress')), `${name}: no reserve reads`);
    assert.match(r.reason, new RegExp(`^the ${n.length} rows give [0-9a-f]{66}; R5 of box ${box} at height ${h} commits ${r5}; the rows do not give the digest the server says its box commits either \\(${r5}\\)$`), name);
    assert.deepEqual(r.reserve_cover, {computed: false, reason: 'not computed: the rows were not shown to be what the chain commits (MISMATCH)'}, `${name}: no cover`);
    // GET /ledger between two reads of GET /chain that name R5 as the anchored digest: rows that give neither are not
    // the state the server calls anchored (a cache longer than the settle time reads so): exit 2, nothing compared.
    const wl = world(h, {ledger: {...v.ledger, notes: n}}), older = await run(wl, {cover: true});
    assert.deepEqual([older.verdict, older.exit, older.reserve_cover], ['INCONSISTENT', 2, null], name);
    assert.ok(older.reason.startsWith(`the ${n.length} rows of GET /pilot/v1/ledger give `), older.reason);
    assert.ok(older.reason.includes(`: neither R5 of box ${box} (height ${h}), ${r5}, nor the digest GET /pilot/v1/chain, read before and after them, names as the tracker's anchored state, ${r5}. They are not the state the server calls anchored, so nothing was compared`), older.reason);
    assert.match(older.reason, /a server cache longer than this audit waits between its reads \(0 ms\) looks so.*Run again, and if it stays so, against a server with GET \/pilot\/v1\/ledger\/committed, which lists every note$/);
    assert.ok(!wl.calls.some(c => c.includes('byAddress')), `${name}: no reserve reads`);
    // The same rows, with both reads of GET /chain naming their digest as the anchored one: the server says the
    // tracker's confirmed box commits that digest, which is not its R5. A MISMATCH.
    const d = digest(rowsOf(n)), claims = v.chain.map(c => ({...clone(c), anchoring: {...clone(c.anchoring), local_digest: d, confirmed_digest: d}}));
    const lie = await run(world(h, {ledger: {...v.ledger, notes: n}, chain: claims}));
    assert.deepEqual([lie.verdict, lie.exit], ['MISMATCH', 1], name);
    assert.equal(lie.reason, `the ${n.length} rows give ${d}; R5 of box ${box} at height ${h} commits ${r5}; the rows give the digest the server says its box commits, which is not the box's R5: the server's confirmed digest is not on chain`, name);
  }
});

// The recorded reads both auditors are run on (fix inbox #66): test/fixtures/anchor-vectors/xtool.json, made from
// valun audit's own test World (synthetic keys and boxes; xtool/README.md). Each url answers in turn, the last
// repeating; any other url is a 404.
test('one verdict table for both auditors: on the 41 recorded reads this audit gives the exit code valun audit gives (docs/PILOT-API.md "Verdicts")', async t => {
  if (!await load(t)) return;
  const doc = read('xtool.json');
  assert.equal(doc.scenarios.length, 41);
  // valun audit's map: 0 MATCH, 1 MISMATCH and nothing else, 2 nothing compared (3 is its --mine only).
  assert.deepEqual({...A.EXIT}, {MATCH: 0, MISMATCH: 1, INCONSISTENT: 2, REFUSED: 2, ERROR: 2});
  const verdictOf = {0: ['MATCH'], 1: ['MISMATCH'], 2: ['INCONSISTENT']};
  const by = {0: 0, 1: 0, 2: 0};
  for (const s of doc.scenarios) {
    const queues = Object.fromEntries(Object.entries(s.responses).map(([u, list]) => [u, list.map(([st, i]) => [st, doc.bodies[i]])]));
    const fetchImpl = async url => {
      const q = queues[url];
      const [status, body] = q?.length ? (q.length > 1 ? q.shift() : q[0]) : [404, '{"error":"not_found"}'];
      return new Response(body, {status, headers: {'content-type': 'application/json'}});
    };
    const r = await A.audit({server: s.server, explorer: s.explorer, trackerNft: s.nft, cover: false, fetchImpl, settleMs: 0, sleep: async () => {}});
    assert.equal(r.exit, s.exit, `${s.name}: exit ${r.exit} (${r.verdict}: ${r.reason}), valun audit ${s.exit} (${s.client.verdict} ${s.client.reason})`);
    assert.ok(verdictOf[s.exit].includes(r.verdict), `${s.name}: ${r.verdict}`);
    // Every MISMATCH is the server saying a box commits rows or a digest, while that box's R5 is another digest.
    if (r.exit === 1) assert.match(r.reason, /R5 of box [0-9a-f]{64} (at height \d+ )?commits [0-9a-f]{66}/, s.name);
    by[r.exit]++;
  }
  assert.deepEqual(by, {0: 7, 1: 5, 2: 29}, 'the table\'s spread: 7 MATCH, 5 MISMATCH, 29 nothing compared');
  // The table is pinned in docs/PILOT-API.md, after the construction it is for.
  const api = fs.readFileSync(path.join(root, 'docs', 'PILOT-API.md'), 'utf8').replace(/\s+/g, ' '), at = api.indexOf('**Verdicts** (fix inbox #66)');
  assert.ok(at > api.indexOf('**Construction `basis-avl/1`**') && at < api.indexOf('**When the records disagree**'), 'in "Committed ledger", after the construction');
  const verdicts = api.slice(at, api.indexOf('**When the records disagree**'));
  for (const f of ['0 MATCH; 1 MISMATCH, and nothing else; 2 nothing was compared, never a pass',
    'A MISMATCH always means that the server says a box commits these rows, or this digest, and that box on your source does not: its R5 is another digest, or it is no tracker box',
    'a MISMATCH whose snapshot says `consistent: false` while its `digest` is R5 is what tracker v4.4\'s known race gives (below; fix inbox #65), and also what a server gives that serves other rows and says `consistent: false`: no audit can tell the two apart',
    // The parity it claims is the 41 recorded reads', and it says where the client still compares less (review 2026-11-15).
    '`valun audit` and the operator\'s auditor give the same exit code on 41 recorded reads', 'byte for byte the same file in valun-open\'s `python/tests/fixtures/audit-verdicts/`',
    '**a box the server names**', '**the tracker NFT**: from valun 0.7.1 both pin the same servers, take `--tracker-nft`',
    '**a 503 from `GET /ledger/committed`**', '**`GET /pilot/v1/info`**', '**reading again**', 'Elsewhere they differ in five ways']) {
    assert.ok(verdicts.includes(f), f);
  }
  // An audit cannot know a RACE is no tampering, and the two auditors do not agree on every read.
  for (const f of ['not tampering', 'give the same exit code on the same reads']) assert.ok(!verdicts.includes(f), f);
});

test('the chain source is inconsistent (exit 2): two unspent boxes, a spent box, a box without the NFT, none, an R5 that is no AvlTree', async t => {
  if (!await load(t)) return;
  const h = 645189, b = vector(h).explorer_unspent_by_token, item = b.items[0];
  const other = {...clone(item), boxId: 'ee'.repeat(32)};
  const cases = [
    ['two boxes', {items: [clone(item), other], total: 2}, /2 unspent boxes hold the tracker NFT/],
    ['two boxes, one page shown', {items: [clone(item)], total: 2}, /2 unspent boxes hold the tracker NFT/],
    ['a spent box', {items: [{...clone(item), spentTransactionId: 'cd'.repeat(32)}], total: 1}, new RegExp(`box ${item.boxId}, listed as unspent, was spent by transaction ${'cd'.repeat(32)}`)],
    ['no NFT', {items: [{...clone(item), assets: []}], total: 1}, /does not hold it/],
    ['the NFT twice over', {items: [{...clone(item), assets: [{...item.assets[0], amount: 2}]}], total: 1}, /does not hold it/],
    ['another token', {items: [{...clone(item), assets: [{...item.assets[0], tokenId: 'ab'.repeat(32)}]}], total: 1}, /does not hold it/],
    ['no box', {items: [], total: 0}, /no unspent box holds the tracker NFT/],
    ['off the main chain', {items: [{...clone(item), mainChain: false}], total: 1}, /is not on the main chain/],
    ['R5 no AvlTree', boxWith(h, vec(h).r5_digest), /R5 is not an AvlTree constant/],
    ['no R5', boxWith(h, vec(h).r5_digest), /R5 is not lowercase hex bytes/],
    ['not a list', {total: 1}, /did not list boxes/],
  ];
  cases[8][1].items[0].additionalRegisters.R5.serializedValue = `0e21${vec(h).r5_digest}`;
  delete cases[9][1].items[0].additionalRegisters.R5;
  for (const [name, byToken, why] of cases) {
    const r = await run(world(h, {byToken}));
    assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2], name);
    assert.match(r.reason, /^source inconsistent: /, name);
    assert.match(r.reason, why, name);
    assert.equal(r.reserve_cover, null, `${name}: nothing computed`);
    assert.match(A.render(r), /^NOT CHECKED \(source or state inconsistent\): source inconsistent: /m);
  }
  // R5 that decodes, but is not a tree of the tracker's construction: exit 2 whether or not its digest bytes are the
  // rows' (rows of basis-avl/1 cannot be compared with another tree; valun audit's not_an_avl_tree), on either route.
  const d = vec(h).r5_digest, box = vec(h).box_id, raised = committedOf(h, rowsOf(vector(h).ledger.notes).map((x, i) => (i === 4 ? {...x, total: x.total + 1} : x)));
  for (const [r5, k, vl] of [[`64${d}032100`, 33, 'none'], [`64${d}03200108`, 32, 8], [`64${d}031000`, 16, 'none']]) {
    for (const [what, o] of [['rows giving its digest', {}], ['rows that do not', {committed: raised}]]) {
      const byToken = boxWith(h, d);
      byToken.items[0].additionalRegisters.R5.serializedValue = r5;
      const r = await run(world(h, {byToken, ...o}), {cover: true});
      assert.deepEqual([r.verdict, r.exit, r.reserve_cover], ['INCONSISTENT', 2, null], `${r5}, ${what}`);
      assert.equal(r.reason, `R5 of box ${box} is a tree of another construction (key length ${k}, value length ${vl}; basis-avl/1, the tracker's, has 32 and none): the rows' digest under basis-avl/1 cannot be compared with it, so nothing was compared`);
      assert.deepEqual(r.box.tree, {flags: 3, key_length: k, value_length: vl === 'none' ? null : vl}, 'the box is reported');
    }
  }
  // Another flags byte is reported, not refused: lookups do not read it.
  const flags = boxWith(h, d);
  flags.items[0].additionalRegisters.R5.serializedValue = `64${d}072000`;
  const r = await run(world(h, {byToken: flags}));
  assert.equal(r.verdict, 'MATCH');
  assert.deepEqual(r.warnings, ['R5\'s flags are 7, not 3 (insert and update), as the tracker writes them']);
});

test('no chain source is refused, two are refused, a bad URL is refused; the source the server names itself is used with a warning', async t => {
  if (!await load(t)) return;
  for (const [o, why] of [[{explorer: null}, /^no chain source\. Name one with --explorer URL/], [{node: NODE}, /^two chain sources/],
    [{explorer: 'ftp://x'}, /--explorer must be an http\(s\) URL/], [{explorer: 'not a url'}, /--explorer is not a URL/], [{server: 'https://x/?a=1'}, /--server must have no query/],
    [{trackerNft: 'xyz'}, /--tracker-nft must be a token id/], [{explorer: `${SERVER}/api/v1`}, /^the chain source is the server itself \(https:\/\/valun\.test\)/],
    [{explorer: null, node: `${SERVER}/`}, /^the chain source is the server itself/]]) {
    const w = world(645189), r = await run(w, o);
    assert.deepEqual([r.verdict, r.exit], ['REFUSED', 2], JSON.stringify(o));
    assert.match(r.reason, why);
    assert.deepEqual(w.calls, [], 'nothing is read');
  }
  // The explorer the server's /chain names (its UI host here) as the source: a warning, and the audit runs.
  const w = world(645189), named = w.chain[0].explorer;
  const fetchImpl = async (url, init) => w.fetchImpl(String(url).replace(named, EXPLORER), init);
  const r = await A.audit({server: SERVER, explorer: named, fetchImpl, settleMs: 0, sleep: async () => {}, cover: false, trackerNft: w.nft});
  assert.equal(r.verdict, 'MATCH');
  assert.equal(r.source.named_by_server, true);
  assert.deepEqual(r.warnings, [`the chain source is the explorer the server's GET /chain names (${named}): it is the operator's choice of source, not yours; name another to check the operator independently`]);
  // A pinned tracker NFT the server does not name: exit 2.
  const pin = await run(world(645189), {trackerNft: 'ab'.repeat(32)});
  assert.deepEqual([pin.verdict, pin.exit], ['INCONSISTENT', 2]);
  assert.match(pin.reason, /^the server names tracker NFT dca981fc.*, not abab.*, the one you pinned$/);
  assert.equal((await run(world(645189), {trackerNft: world(645189).nft})).verdict, 'MATCH');
});

test('the server\'s state: not anchored now is exit 2 at once; a state that moves between the reads is read again, then exit 2', async t => {
  if (!await load(t)) return;
  const h = 645189, c = vector(h).chain[0];
  const waiting = {...clone(c), anchoring: {...clone(c.anchoring), local_digest: 'ab'.repeat(33), anchored: false, state: 'waiting_for_next_update'}};
  const capped = {...clone(c), anchoring: {...clone(c.anchoring), local_digest: 'ab'.repeat(33), anchored: false, state: 'daily_cap_reached', resumes_at: '2026-11-15T00:00:00.000Z'}};
  // Anchored by its digests but not by its own flag, or naming no confirmed box: the published ledger cannot be judged
  // against a box either (valun audit asks the same: not_anchored).
  const unflagged = {...clone(c), anchoring: {...clone(c.anchoring), anchored: false}};
  const boxless = {...clone(c), anchoring: {...clone(c.anchoring), confirmed_box_id: null}};
  for (const [chain, why] of [[[waiting], /not anchored now \(waiting_for_next_update\)/], [[capped], /not anchored now \(daily_cap_reached, next box after 2026-11-15T00:00:00\.000Z\)/],
    [[unflagged], /^the tracker's state is not anchored now \(anchored\): this server has no GET \/ledger\/committed/],
    [[boxless], /^the tracker's state is anchored, but GET \/pilot\/v1\/chain names no confirmed box \(confirmed_box_id\): this server has no GET \/ledger\/committed/]]) {
    const w = world(h, {chain}), r = await run(w);
    assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2]);
    assert.match(r.reason, why);
    assert.deepEqual(w.calls, ['GET /pilot/v1/chain', 'GET /pilot/v1/ledger/committed'], 'no ledger read, no chain read');
  }
  // Moved: the confirmed box changed (a new anchor) between the reads, every time: three attempts, then exit 2.
  const moved = k => ({...clone(c), anchoring: {...clone(c.anchoring), confirmed_box_id: String(k).repeat(64).slice(0, 64), confirmed_height: h + k}});
  const w = world(h, {chain: [moved(1), moved(2), moved(3), moved(4), moved(5)]}), r = await run(w);
  assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2]);
  assert.match(r.reason, /^the tracker's state moved while it was read, 3 times/);
  assert.equal(w.calls.filter(x => x === 'GET /pilot/v1/ledger').length, 3);
  // Unanchored by the second read: read again; anchored and unchanged the next time: MATCH.
  const again = world(h, {chain: [clone(c), waiting, clone(c), clone(c)]});
  const r2 = await run(again);
  assert.equal(r2.verdict, 'INCONSISTENT', 'the second read is not anchored: the next attempt starts from it and stops');
  const settled = world(h, {chain: [clone(c), moved(1), moved(1)]});
  const r3 = await run(settled);
  // The rows were read while the box was c's: the attempt from moved(1) reads the same rows, which give c's digest, and
  // the chain still holds c's box: the server names another box, the rows give the chain box's digest: MATCH, warned.
  assert.equal(r3.verdict, 'MATCH');
  assert.match(r3.warnings[0], /^the server's snapshot names box 1111.* \(height 645190\); the chain's unspent box is 57849575/);
  // The pause between the reads is the settle time (the server's public read cache is 3 s).
  const pauses = [];
  await A.audit({server: SERVER, explorer: EXPLORER, fetchImpl: world(h).fetchImpl, sleep: async ms => { pauses.push(ms); }, cover: false, trackerNft: world(h).nft});
  assert.deepEqual(pauses, [A.SETTLE_MS, A.SETTLE_MS]);
  assert.ok(A.SETTLE_MS > 3000);
});

// A box as the explorer answers boxes/{id}: the recorded unspent box of `h`, spent by `spentBy` (or not), with `more`.
const boxOf = (h, spentBy = null, more = {}) => ({...clone(vector(h).explorer_unspent_by_token.items[0]), spentTransactionId: spentBy, ...more});
// A transaction as the explorer answers transactions/{id} (the audit reads its inclusion height and its inputs).
const txOf = (id, inclusionHeight, inputs = []) => ({id, blockId: 'cd'.repeat(32), inclusionHeight, timestamp: 1, index: 0, globalIndex: 1, numConfirmations: 1, inputs, dataInputs: [], outputs: [], size: 1});

test('box identity: rows for the chain\'s box MATCH; for another box the server names, that box on the source decides, a MISMATCH only when it does not commit the digest claimed', async t => {
  if (!await load(t)) return;
  const old = vec(645135).box_id, cur = vec(645189).box_id, moved = 'ac'.repeat(32);
  const head = `the 251 rows give ${vec(645135).r5_digest}, the digest the server says its box ${old} (height 645135) commits, not R5 of the chain's unspent tracker box ${cur} (height 645189), ${vec(645189).r5_digest}`;
  // The chain replaced the server's 645135 box with the 645189 one: the rows give what the old box commits, so the
  // server's claim is true, and nothing is compared with the box redemptions use now. Exit 2 at any age: "run again"
  // while that is recent (the server may not have seen its new box yet), after MOVED_GRACE_BLOCKS the server publishes
  // a superseded box's rows (valun audit: box_moved).
  const replaced = height => world(645135, {byToken: clone(vector(645189).explorer_unspent_by_token), height, boxes: {[old]: boxOf(645135, moved)}, txs: {[moved]: txOf(moved, 645190)}});
  const fresh = await run(replaced(645190 + A.MOVED_GRACE_BLOCKS));
  assert.deepEqual([fresh.verdict, fresh.exit], ['INCONSISTENT', 2]);
  assert.equal(fresh.reason, `${head}; box ${old} is a tracker box the chain replaced 10 blocks ago (transaction ${moved}), within the 10 the server may take to see the new one: the chain moved since the server read it; run again`);
  for (const age of [A.MOVED_GRACE_BLOCKS + 1, 500, 2000]) {
    const late = await run(replaced(645190 + age), {cover: true});
    assert.deepEqual([late.verdict, late.exit, late.reserve_cover], ['INCONSISTENT', 2, null], `replaced ${age} blocks ago`);
    assert.equal(late.reason, `${head}; box ${old} is a tracker box the chain replaced ${age} blocks ago (transaction ${moved}; the unspent one is ${cur}): the server publishes the rows of a superseded box, which are not compared with the box redemptions use now, so nothing was compared (a server that keeps naming it fails a watch closed)`);
  }
  // The source lags (its box index and its height): the server's 645189 box, the source still at 645135. Run again,
  // also once the source is SOURCE_GRACE_BLOCKS past the height the server claims and still has no such box (exit 2:
  // the rows are compared with no box, and a lagging box index may still lack it).
  const lagging = height => world(645189, {byToken: clone(vector(645135).explorer_unspent_by_token), height});
  const lag = await run(lagging(645189 + A.SOURCE_GRACE_BLOCKS - 1));
  assert.deepEqual([lag.verdict, lag.exit], ['INCONSISTENT', 2]);
  assert.ok(lag.reason.endsWith(`; the source, at height 645198, has no box ${cur} yet, which the server says was created at height 645189: the source is behind the server; run again`), lag.reason);
  const gone = await run(lagging(645189 + A.SOURCE_GRACE_BLOCKS));
  assert.deepEqual([gone.verdict, gone.exit], ['INCONSISTENT', 2]);
  const missing = `the server names a tracker box the chain may not have, or one a lagging box index of the source does not have yet, so its rows were compared with no box and nothing was compared (a server that keeps naming it fails a watch closed)`;
  assert.ok(gone.reason.endsWith(`; the source, at height 645199, has no box ${cur}: ${missing}`), gone.reason);
  // A made-up box: rows with one total raised, and the server naming a box id the chain never had, with their digest.
  // Claimed at the height of the tracker box the source holds (645189) or after it, the source may be behind, or its
  // box index lag: nothing to compare the rows with (exit 2; a watch that keeps seeing it fails closed), as valun audit
  // has it. (Claimed below that height it is a MISMATCH: the next test.)
  const v89 = vector(645189), raised = v89.ledger.notes.map((n, i) => (i === 7 ? {...n, total: n.total + 1_000_000} : n)), d = digest(rowsOf(raised)), FAKE = 'f'.repeat(64);
  const liar = (claimed, boxes = {}) => world(645189, {ledger: {...v89.ledger, notes: raised}, height: 645249, boxes,
    chain: v89.chain.map(c => ({...clone(c), anchoring: {...clone(c.anchoring), local_digest: d, confirmed_digest: d, confirmed_box_id: FAKE, confirmed_height: claimed}}))});
  for (const claimed of [645189, 645190, 645249 - A.SOURCE_GRACE_BLOCKS]) {
    const r = await run(liar(claimed));
    assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2], `claimed height ${claimed}`);
    assert.ok(r.reason.endsWith(`; the source, at height 645249, has no box ${FAKE}: ${missing}`), r.reason);
  }
  // Claimed past what the source has seen: the source cannot have it yet. Exit 2, and scripts/ops/anchor-watch.sh fails
  // a watch that keeps checking nothing.
  const ahead = await run(liar(999999));
  assert.deepEqual([ahead.verdict, ahead.exit], ['INCONSISTENT', 2]);
  assert.match(ahead.reason, /the source is behind the server; run again$/);
  const noHeight = await run(liar(null));
  assert.deepEqual([noHeight.verdict, noHeight.exit], ['INCONSISTENT', 2]);
  assert.match(noHeight.reason, /and the server gives no height for it, so the source cannot be judged behind or not; run again$/);
  // The same made-up box, served by GET /ledger/committed.
  const viaRoute = await run(world(645189, {committed: committedOf(645189, rowsOf(raised), {box_id: FAKE, height: 645219, digest: d}), height: 645249}));
  assert.deepEqual([viaRoute.verdict, viaRoute.exit], ['INCONSISTENT', 2]);
  assert.ok(viaRoute.reason.endsWith(`; the source, at height 645249, has no box ${FAKE}: ${missing}`), viaRoute.reason);
  // A box the source has, whose R5 is not the digest claimed for it (or no AvlTree): the server misstates what its box
  // commits, a MISMATCH, also when that box is no tracker box. One whose R5 is that digest is judged on (holding no
  // tracker NFT at all: a MISMATCH, the next test): holding it later than first, or a tree of another construction,
  // exit 2; holding it unspent next to the chain's box, the source's inconsistency.
  const misstated = await run(liar(645240, {[FAKE]: boxOf(645189, moved, {boxId: FAKE})}), {cover: true});
  assert.deepEqual([misstated.verdict, misstated.exit, misstated.tracker_race], ['MISMATCH', 1, false]);
  assert.ok(misstated.reason.endsWith(`; on chain, R5 of box ${FAKE} commits ${vec(645189).r5_digest}: the server misstates what its box commits`), misstated.reason);
  assert.deepEqual(misstated.reserve_cover, {computed: false, reason: 'not computed: the rows were not shown to be what the chain commits (MISMATCH)'});
  const noNft = await run(liar(645240, {[FAKE]: boxOf(645189, moved, {boxId: FAKE, assets: []})}));
  assert.deepEqual([noNft.verdict, noNft.exit], ['MISMATCH', 1]);
  assert.ok(noNft.reason.endsWith(`; on chain, R5 of box ${FAKE} commits ${vec(645189).r5_digest}: the server misstates what its box commits, and that box does not hold the tracker NFT as its first token either`), noNft.reason);
  const noTree = boxOf(645189, moved, {boxId: FAKE});
  noTree.additionalRegisters.R5.serializedValue = `0e20${'ab'.repeat(32)}`;
  const none = await run(liar(645240, {[FAKE]: noTree}));
  assert.deepEqual([none.verdict, none.exit], ['MISMATCH', 1]);
  assert.ok(none.reason.endsWith(`; on chain, R5 of box ${FAKE} commits no AvlTree: the server misstates what its box commits`), none.reason);
  // Holding the NFT, but after another token: a box of the NFT's lineage no redemption can use (as for the chain's own
  // box, exit 2).
  const second = boxOf(645189, moved, {boxId: FAKE, assets: [{tokenId: 'ab'.repeat(32), index: 0, amount: 1}, {...boxOf(645189).assets[0], index: 1}]});
  second.additionalRegisters.R5.serializedValue = `64${d}032000`;
  const notFirst = await run(liar(645240, {[FAKE]: second}));
  assert.deepEqual([notFirst.verdict, notFirst.exit], ['INCONSISTENT', 2]);
  assert.ok(notFirst.reason.endsWith(`; on chain, R5 of box ${FAKE} is that digest, and the box holds the tracker NFT, but not as its first token with one unit, which is where the reserve contract reads a tracker's identity (basis.es tracker.tokens(0)): no redemption can use it, so nothing was compared (a server that keeps naming it fails a watch closed)`), notFirst.reason);
  const otherTree = boxOf(645189, moved, {boxId: FAKE});
  otherTree.additionalRegisters.R5.serializedValue = `64${d}031000`;
  const other = await run(liar(645240, {[FAKE]: otherTree}));
  assert.deepEqual([other.verdict, other.exit], ['INCONSISTENT', 2]);
  assert.ok(other.reason.endsWith(`; on chain, R5 of box ${FAKE} is that digest, of a tree of another construction (key length 16, value length none; basis-avl/1 has 32 and none), so nothing was compared`), other.reason);
  const twin = boxOf(645189, null, {boxId: FAKE});
  twin.additionalRegisters.R5.serializedValue = `64${d}032000`;
  const two = await run(liar(645240, {[FAKE]: twin}));
  assert.deepEqual([two.verdict, two.exit], ['INCONSISTENT', 2]);
  assert.match(two.reason, /^source inconsistent: box f+, which the server names, holds the tracker NFT unspent, and so does box 57849575/);
  // Neither: tampered rows with the server naming the old box. They give neither the chain box's R5 nor the digest the
  // server claims for its box: the chain moved, or the source lags (valun audit: box_moved). Exit 2, on either route,
  // and the box the server names is not looked up.
  const v = vector(645135), notes = v.ledger.notes.map((n, i) => (i === 3 ? {...n, total: n.total + 5} : n)), dn = digest(rowsOf(notes));
  const neither = `the 251 rows give ${dn}: neither R5 of the chain's unspent tracker box ${cur} (height 645189), ${vec(645189).r5_digest}, nor the digest the server says its box ${old} (height 645135) commits, ${vec(645135).r5_digest}`;
  const w2 = world(645135, {ledger: {...v.ledger, notes}, byToken: clone(vector(645189).explorer_unspent_by_token)}), r2 = await run(w2);
  assert.deepEqual([r2.verdict, r2.exit], ['INCONSISTENT', 2]);
  assert.equal(r2.reason, `${neither}. Rows for another box than the chain's are compared only through the digest the server claims for that box, so nothing was compared: the chain moved during the audit, or the source lags; run again`);
  assert.ok(!w2.calls.some(c => c.includes('/api/v1/boxes/') && !c.includes('unspent')), 'no box lookup');
  const r3 = await run(world(645135, {committed: committedOf(645135, rowsOf(notes), {consistent: false}), byToken: clone(vector(645189).explorer_unspent_by_token)}));
  assert.deepEqual([r3.verdict, r3.exit], ['INCONSISTENT', 2]);
  assert.ok(r3.reason.startsWith(`${neither} (its own check says so too: consistent: false). Rows for another box`), r3.reason);
  // The server's claim about the box it names: another creation height is a warning; a confirmed digest that its rows
  // give but the box's R5 is not is a MISMATCH that says so.
  const c = vector(645189).chain.map(x => ({...clone(x), anchoring: {...clone(x.anchoring), confirmed_height: 645188}}));
  const off = await run(world(645189, {chain: c}));
  assert.deepEqual([off.verdict, off.warnings], ['MATCH', [`the server says box ${vec(645189).box_id} was created at height 645188; the chain says 645189`]]);
  const fake = await run(world(645189, {byToken: boxWith(645189, vec(645135).r5_digest)}));
  assert.deepEqual([fake.verdict, fake.exit], ['MISMATCH', 1]);
  assert.match(fake.reason, /the rows give the digest the server says its box commits, which is not the box's R5: the server's confirmed digest is not on chain$/);
});

// Review of 2026-11-15 (finding 2): a box the server names that no lag of the source explains is not "nothing compared".
// The server serves rows with one total raised under a box id of its own making (or a box of anyone's making) with the
// rows' digest; before this, each was exit 2, so a server doing it on most reads passed a watch (exit 0) as long as it
// served the true rows now and then.
test('a box the server names that the source shows is none of the tracker\'s is a MISMATCH: absent although the source holds a later tracker box, or holding no tracker NFT; a snapshot saying consistent: true while its rows give neither digest says it contradicts itself', async t => {
  if (!await load(t)) return;
  const cur = vec(645189).box_id, moved = 'ac'.repeat(32), FAKE = 'f'.repeat(64);
  const v89 = vector(645189), raised = v89.ledger.notes.map((n, i) => (i === 7 ? {...n, total: n.total + 1_000_000} : n)), d = digest(rowsOf(raised));
  const liar = (claimed, boxes = {}) => world(645189, {ledger: {...v89.ledger, notes: raised}, height: 645249, boxes,
    chain: v89.chain.map(c => ({...clone(c), anchoring: {...clone(c.anchoring), local_digest: d, confirmed_digest: d, confirmed_box_id: FAKE, confirmed_height: claimed}}))});
  const head = claimed => `the 251 rows give ${d}, the digest the server says its box ${FAKE} (height ${claimed}) commits, not R5 of the chain's unspent tracker box ${cur} (height 645189), ${vec(645189).r5_digest}`;
  // Claimed below the tracker box the source holds (645189) and absent from the source: a tracker box made before that
  // one is one of its ancestors, which the source has, and one made after it is created at its height or later, so no
  // lag explains it. A MISMATCH, on either route, with no cover; at 645189 itself the source may lag (the box
  // identity test: exit 2).
  for (const claimed of [645100, 645188]) {
    const r = await run(liar(claimed), {cover: true});
    assert.deepEqual([r.verdict, r.exit, r.tracker_race, r.reserve_cover?.computed], ['MISMATCH', 1, false, false], `claimed height ${claimed}`);
    assert.equal(r.reason, `${head(claimed)}; the source has no box ${FAKE}, and the tracker box it holds was created at height 645189, after the height the server claims for that box: a tracker box made before it is one of its ancestors, which the source has, so the server names a tracker box the chain does not have`);
  }
  const viaRoute = await run(world(645189, {committed: committedOf(645189, rowsOf(raised), {box_id: FAKE, height: 645100, digest: d}), height: 645249}));
  assert.deepEqual([viaRoute.verdict, viaRoute.exit, viaRoute.tracker_race], ['MISMATCH', 1, false]);
  assert.equal(viaRoute.reason, `${head(645100)}; the source has no box ${FAKE}, and the tracker box it holds was created at height 645189, after the height the server claims for that box: a tracker box made before it is one of its ancestors, which the source has, so the server names a tracker box the chain does not have`);
  // A box on the source whose R5 is the digest claimed, holding no tracker NFT (anyone can make one): no tracker box,
  // so the server names as its tracker's box one that is not. A MISMATCH whatever tree its R5 holds.
  const decoy = boxOf(645189, null, {boxId: FAKE, assets: []});
  decoy.additionalRegisters.R5.serializedValue = `64${d}032000`;
  const notTracker = await run(liar(645240, {[FAKE]: decoy}), {cover: true});
  assert.deepEqual([notTracker.verdict, notTracker.exit, notTracker.reserve_cover?.computed], ['MISMATCH', 1, false]);
  assert.equal(notTracker.reason, `${head(645240)}; on chain, R5 of box ${FAKE} is that digest, but the box does not hold the tracker NFT: it is no tracker box, so the server names as its tracker's box one that is not`);
  const decoyTree = clone(decoy);
  decoyTree.additionalRegisters.R5.serializedValue = `64${d}031000`;
  const otherTree = await run(liar(645240, {[FAKE]: decoyTree}));
  assert.deepEqual([otherTree.verdict, otherTree.exit], ['MISMATCH', 1]);
  assert.equal(otherTree.reason, notTracker.reason);
  // A snapshot naming the old box, whose rows give neither the chain box's R5 nor the digest it claims, while it says
  // its rows give that digest (consistent: true): the server computes the flag from these very rows, so the snapshot
  // contradicts itself, which no move of the chain and no lag explains. Its line says so, not "run again"; still exit
  // 2, as its rows were compared with no box (valun audit gives 2 too).
  const old = vec(645135).box_id, v = vector(645135), notes = v.ledger.notes.map((n, i) => (i === 3 ? {...n, total: n.total + 5} : n)), dn = digest(rowsOf(notes));
  const selfContradicting = await run(world(645135, {committed: committedOf(645135, rowsOf(notes)), byToken: clone(vector(645189).explorer_unspent_by_token)}));
  assert.deepEqual([selfContradicting.verdict, selfContradicting.exit], ['INCONSISTENT', 2]);
  assert.equal(selfContradicting.reason, `the 251 rows give ${dn}: neither R5 of the chain's unspent tracker box ${cur} (height 645189), ${vec(645189).r5_digest}, nor the digest the server says its box ${old} (height 645135) commits, ${vec(645135).r5_digest}, although the snapshot says they give that digest (consistent: true): the snapshot contradicts itself, which no honest server serves (it computes consistent from these very rows) and which neither a chain that moved nor a source that lags explains. Rows for another box than the chain's are compared only through the digest the server claims for that box, so nothing was compared (a server that keeps serving it fails a watch closed)`);
  assert.doesNotMatch(selfContradicting.reason, /run again/);
  // Unchanged: a box the source has, with the claimed digest, holding the NFT later than first (exit 2, the box
  // identity test), and one whose R5 is another digest (a MISMATCH, as before).
  const misstated = await run(liar(645240, {[FAKE]: boxOf(645189, moved, {boxId: FAKE})}));
  assert.deepEqual([misstated.verdict, misstated.exit], ['MISMATCH', 1]);
});

test('the tracker NFT is pinned: a known server\'s by default, any by --tracker-nft; another server\'s must be named by the reserves (a decoy is exit 2)', async t => {
  if (!await load(t)) return;
  const v = vector(645189), real = v.chain[0].tracker_nft_id, decoy = 'de'.repeat(32), rec = read('reserves.explorer.json').response;
  // The operator's decoy: a tracker NFT of its own, whose one box commits the rows it publishes (one total lowered).
  const j = v.ledger.notes.findIndex(n => n.total > 0), notes = v.ledger.notes.map((n, i) => (i === j ? {...n, total: n.total - 1} : n)), d = digest(rowsOf(notes)), box = boxWith(645189, d);
  box.items[0].assets = [{...box.items[0].assets[0], tokenId: decoy}];
  const decoyWorld = (server, reserves = rec.items) => {
    const w = world(645189, {ledger: {...v.ledger, notes}, byToken: box, reserves, chain: v.chain.map(c => ({...clone(c), tracker_nft_id: decoy, anchoring: {...clone(c.anchoring), local_digest: d, confirmed_digest: d}}))});
    w.nft = decoy;
    const serve = w.fetchImpl;
    w.fetchImpl = (url, init) => serve(String(url).replace(server, SERVER), init);
    return w;
  };
  const audit = (server, w, o = {}) => A.audit({server, explorer: EXPLORER, fetchImpl: w.fetchImpl, settleMs: 0, sleep: async () => {}, cover: false, ...o});
  // A known server: its pin, whatever the reserves say.
  for (const server of ['https://valun.tech', 'https://valun-testnet.fly.dev']) {
    const w = decoyWorld(server), r = await audit(server, w);
    assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2], server);
    assert.ok(r.reason.startsWith(`the server names tracker NFT ${decoy}, not ${real}, the one this audit pins for ${server} (its GET /chain of 2026-11-14)`), r.reason);
    assert.ok(!w.calls.some(x => x.includes('byTokenId')), 'nothing is compared');
  }
  assert.equal(A.TRACKER_NFTS['https://valun-staging.fly.dev'], '170213cb89e5c0286d390a8cc0015de3c19688f77aa0dddbf3a3d235ea22d42d', 'staging, its own tracker');
  // Another server: the reserves at the pinned contract are read first, with --no-cover too; all 7 name other trackers.
  const other = decoyWorld(SERVER), r = await audit(SERVER, other);
  assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2]);
  assert.ok(r.reason.startsWith(`no reserve box at the pinned reserve contract names the tracker NFT ${decoy} the server gives (7 name another): it may be a tracker the operator made`), r.reason);
  assert.ok(other.calls.some(x => x.includes('byAddress')) && !other.calls.some(x => x.includes('byTokenId')), 'the reserves are read before anything is compared');
  // With no reserve at all, exit 2 too (a tracker with no reserve yet must be pinned). Pinned by you, the decoy MATCHes:
  // it is what you asked to check.
  assert.equal((await audit(SERVER, decoyWorld(SERVER, []))).exit, 2);
  assert.equal((await audit(SERVER, decoyWorld(SERVER), {trackerNft: decoy})).verdict, 'MATCH');
  // The real NFT on another server, which six reserves name: the audit runs, with a warning that asks for the pin.
  const h = await audit(SERVER, world(645189, {reserves: rec.items}));
  assert.deepEqual([h.verdict, h.tracker], ['MATCH', {nft: real, pinned_by: null, reserves_naming_it: 6}]);
  assert.deepEqual(h.warnings, [`the tracker NFT ${real} is not pinned for ${SERVER}: 6 reserve boxes at the pinned reserve contract name it, which an operator can arrange for a tracker of its own too; pin it with --tracker-nft`]);
  assert.match(A.render(h), /\n {2}tracker {4}NFT dca981fc[0-9a-f]+ \(not pinned: named by 6 reserve box\(es\)\)\n/);
  assert.deepEqual((await run(world(645189))).tracker, {nft: real, pinned_by: 'you', reserves_naming_it: null});
  // Another reserve contract than the pinned one, and no pin: both are only the server's word.
  const contract = '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB', moved = world(645189, {chain: v.chain.map(c => ({...clone(c), reserve_contract: contract}))});
  moved.address = contract;
  const both = await audit(SERVER, moved);
  assert.deepEqual([both.verdict, both.exit], ['INCONSISTENT', 2]);
  assert.match(both.reason, /are both only the server's word/);
});

test('the tracker NFT must be the box\'s first token, where the reserve contract reads it: rows giving R5 of a box holding it later are exit 2, with no windows', async t => {
  if (!await load(t)) return;
  const h = 645189, byToken = clone(vector(h).explorer_unspent_by_token), nft = byToken.items[0].assets[0];
  byToken.items[0].assets = [{tokenId: 'ab'.repeat(32), index: 0, amount: 1}, {...nft, index: 1}];
  // The rows give R5, but no redemption can use the box: nothing is proven (valun audit: nft_not_first).
  const r = await run(world(h, {byToken, height: h + 2200}), {cover: true});
  assert.deepEqual([r.verdict, r.exit, r.windows, r.reserve_cover], ['INCONSISTENT', 2, null, null]);
  assert.equal(r.reason, `the 251 rows give R5 of box ${vec(h).box_id}, but the box holds the tracker NFT not as its first token, which is where the reserve contract reads a tracker's identity (basis.es tracker.tokens(0)): no redemption can use this box, the tracker-less one included, so what it commits proves nothing and nothing was compared`);
  assert.equal(r.box.box_id, vec(h).box_id, 'the box is reported');
  // Rows that do not give R5 of that box (the server's own): a MISMATCH, which says the NFT's place too.
  const raised = committedOf(h, rowsOf(vector(h).ledger.notes).map((x, i) => (i === 2 ? {...x, total: x.total + 1} : x)), {consistent: false});
  const m = await run(world(h, {byToken, committed: raised}));
  assert.deepEqual([m.verdict, m.exit, m.windows, m.tracker_race], ['MISMATCH', 1, null, false], 'not the race: the box is no tracker box a redemption can use');
  assert.match(m.reason, /; the box holds the tracker NFT not as its first token, which is where the reserve contract reads a tracker's identity \(basis\.es tracker\.tokens\(0\)\), so no redemption can use it either; the server's own check says so too \(consistent: false\)$/);
  // The order is the source's index, not the order it lists them in.
  byToken.items[0].assets = [{...nft, index: 0}, {tokenId: 'ab'.repeat(32), index: 1, amount: 1}].reverse();
  assert.equal((await run(world(h, {byToken}))).verdict, 'MATCH');
});

test('rows that cannot be digested are exit 2; a total written as a JSON number above 2^53 - 1 is exit 2 (inexact); as a decimal string it is read exactly at any size', async t => {
  if (!await load(t)) return;
  const h = 645189, v = vector(h), notes = v.ledger.notes;
  const dup = await run(world(h, {ledger: {...v.ledger, notes: [...notes, {...notes[5], total: 1}]}}));
  assert.deepEqual([dup.verdict, dup.exit], ['INCONSISTENT', 2]);
  assert.match(dup.reason, /^the server's rows cannot be digested as the tracker digests its notes: rows\[251\] has the debt key of rows\[5\]/);
  // A total the server writes as a JSON number, the box committing exactly the digits written: up to 2^53 - 1 the
  // digits are exact and MATCH; above it a JavaScript server's Number may have been rounded before it was written, so
  // the audit compares nothing (valun audit: inexact_total), whether or not the digits give R5 (2^60 here gives it).
  const asNumber = (total, i = 9) => JSON.stringify({...v.ledger, notes: notes.map((n, k) => (k === i ? {...n, total: '@'} : n))}).replace('"@"', total);
  const anchoredAt = d => ({byToken: boxWith(h, d), chain: v.chain.map(c => ({...clone(c), anchoring: {...c.anchoring, local_digest: d, confirmed_digest: d}}))});
  for (const [total, exit] of [['9007199254740991', 0], ['9007199254740992', 2], ['1152921504606846976', 2], ['1152921504606846977', 2], ['18446744073709551616', 2]]) {
    let d = vec(h).r5_digest;
    try { d = digest(rowsOf(notes).map((r, i) => (i === 9 ? {...r, total} : r))); } catch {}
    const r = await run(world(h, {ledger: asNumber(total), ...anchoredAt(d)}));
    assert.deepEqual([r.verdict, r.exit], [exit ? 'INCONSISTENT' : 'MATCH', exit], total);
    if (exit) assert.equal(r.reason, `the total of GET /pilot/v1/ledger note 9 is ${total}, written as a JSON number above 2^53 - 1, which a JavaScript server may have rounded before it wrote it: it cannot be read as an exact total, so nothing was compared (GET /pilot/v1/ledger/committed writes every total as a decimal string)`);
  }
  assert.notEqual(JSON.parse(asNumber('1152921504606846977')).notes[9].total.toString(), '1152921504606846977', 'JSON.parse alone rounds it');
  // The committed snapshot: a committed_total written as a JSON number above 2^53 - 1 is exit 2 too; as the decimal
  // string the server writes, 2^60 + 1 is read exactly and MATCHes, and 2^64 cannot be digested (exit 2).
  const big = '1152921504606846977', rows = rowsOf(notes).map((r, i) => (i === 9 ? {...r, total: big} : r)), d = digest(rows);
  const snap = committedOf(h, rows, {digest: d}), k = snap.rows.findIndex(x => x.committed_total === big);
  assert.equal((await run(world(h, {committed: snap, byToken: boxWith(h, d)}))).verdict, 'MATCH', 'a decimal string, exact');
  const text = JSON.stringify(snap).replace(`"committed_total":"${big}"`, `"committed_total":${big}`);
  const inexact = await run(world(h, {committed: json(200, text), byToken: boxWith(h, d)}));
  assert.deepEqual([inexact.verdict, inexact.exit], ['INCONSISTENT', 2]);
  assert.equal(inexact.reason, `committed row ${k}'s committed_total is ${big}, written as a JSON number above 2^53 - 1, which a JavaScript server may have rounded before it wrote it: it cannot be read as an exact total, so nothing was compared (GET /pilot/v1/ledger/committed writes every total as a decimal string)`);
  const safe = JSON.stringify(committedOf(h)).replace(/"committed_total":"(\d+)"/g, '"committed_total":$1');
  assert.equal((await run(world(h, {committed: json(200, safe)}))).verdict, 'MATCH', 'committed totals below 2^53 written as numbers are exact');
  const over = committedOf(h, rowsOf(notes).map((r, i) => (i === 9 ? {...r, total: '18446744073709551616'} : r)));
  const r = await run(world(h, {committed: over}));
  assert.deepEqual([r.verdict, r.exit], ['INCONSISTENT', 2]);
  assert.match(r.reason, /^the server's rows cannot be digested as the tracker digests its notes: rows\[\d+\]\.total must be from 0 to 2\^64 - 1/);
  // An amount in another form than plain digits is refused as the server's state.
  const odd = await run(world(h, {ledger: JSON.stringify(v.ledger).replace(`"total":${notes[0].total},`, `"total":${notes[0].total}.0,`)}));
  assert.deepEqual([odd.verdict, odd.exit], ['INCONSISTENT', 2]);
  assert.match(odd.reason, /total is not a whole number in plain digits/);
});

// GET /pilot/v1/ledger/committed as the server builds it (lib/pilot/committed.mjs on the server branch): rows in
// debt-key order with the decimal strings the tracker wrote, the confirmed box, its height and digest, the self-check.
function committedOf(h, rows = rowsOf(vector(h).ledger.notes), more = {}) {
  const v = vec(h);
  const out = rows.map(r => ({debt_key: Buffer.from(debtKey(r.issuer_pubkey, r.recipient_pubkey, r.denomination ?? 'erg')).toString('hex'),
    issuer_pubkey: r.issuer_pubkey, recipient_pubkey: r.recipient_pubkey, denomination: r.denomination ?? 'erg', committed_total: String(r.total)}));
  out.sort((a, b) => (a.debt_key < b.debt_key ? -1 : 1));
  return {network: 'valun-testnet-1', construction: 'basis-avl/1', box_id: v.box_id, height: h, digest: v.r5_digest, read_at: '2026-11-14T23:10:00.000Z', consistent: true, rows: out, ...more};
}

test('GET /ledger/committed when the server has it: its rows MATCH in any order; its box and check are reported; bad rows are refused', async t => {
  if (!await load(t)) return;
  const h = 645189, c = vector(h).chain[0];
  // Not anchored now: the older path could not check it, the committed snapshot can.
  const busy = {...clone(c), anchoring: {...clone(c.anchoring), local_digest: 'ab'.repeat(33), anchored: false, state: 'daily_cap_reached'}};
  const w = world(h, {chain: [busy], committed: committedOf(h)}), r = await run(w);
  assert.equal(r.verdict, 'MATCH', r.reason);
  assert.deepEqual([r.data.route, r.data.rows, r.data.digest], ['GET /pilot/v1/ledger/committed', 251, vec(h).r5_digest]);
  assert.deepEqual(r.data.server, {box_id: vec(h).box_id, height: h, digest: vec(h).r5_digest, consistent: true});
  assert.deepEqual(w.calls.slice(0, 2), ['GET /pilot/v1/chain', 'GET /pilot/v1/ledger/committed'], 'no /ledger read without the cover');
  assert.equal(w.calls.length, 4);
  const shuffled = committedOf(h);
  shuffled.rows.reverse();
  assert.equal((await run(world(h, {committed: shuffled}))).verdict, 'MATCH');
  // The server's own check says false, its digest is R5, and the rows do not give it: what tracker v4.4's promotion and
  // mark races leave after a box update on an honest server (fix inbox #65), and what a server serving other rows gives
  // when it says consistent: false. Still a MISMATCH (exit 1, as valun audit says; the rows are not what the box
  // commits), whose line says it is consistent with the known race, that no audit tells it from those other rows (it
  // never calls it "not tampering": review of 2026-11-15), and what to do; tracker_race marks it for a watch.
  const racedRows = rowsOf(vector(h).ledger.notes).map((x, i) => (i === 0 ? {...x, total: x.total + 1} : x));
  const m = await run(world(h, {committed: committedOf(h, racedRows, {consistent: false})}));
  assert.deepEqual([m.verdict, m.exit, m.tracker_race], ['MISMATCH', 1, true]);
  assert.equal(m.reason, `the 251 rows give ${digest(racedRows)}; R5 of box ${vec(h).box_id} at height ${h} commits ${vec(h).r5_digest}; the rows do not give the digest the server says its box commits either (${vec(h).r5_digest}); the server's own check says so too (consistent: false), and the digest it names is R5: that is consistent with tracker v4.4's known race after a box update (fix inbox #65), which leaves the tracker's records of a box wrong from its confirmation until the next box, and this audit cannot tell it from a server that serves other rows and says consistent: false. Wait for the next tracker box (GET /pilot/v1/chain anchoring) and run again: the race ends with its box`);
  assert.match(A.render(m), /^MISMATCH: .*consistent with tracker v4\.4's known race after a box update \(fix inbox #65\)/m);
  assert.doesNotMatch(A.render(m), /not tampering/);
  // Not the race: the server says its check passes (consistent: true), or names a digest that is not R5.
  const claimed = await run(world(h, {committed: committedOf(h, racedRows)}));
  assert.deepEqual([claimed.verdict, claimed.tracker_race], ['MISMATCH', false]);
  assert.doesNotMatch(claimed.reason, /#65/);
  const wrongDigest = await run(world(h, {committed: committedOf(h, racedRows, {consistent: false, digest: vec(645135).r5_digest})}));
  assert.deepEqual([wrongDigest.verdict, wrongDigest.tracker_race], ['MISMATCH', false]);
  assert.ok(wrongDigest.reason.endsWith('; the server\'s own check reports that its rows do not give its digest (consistent: false), but the tracker\'s known race (fix inbox #65) leaves that digest equal to R5, which it is not here'), wrongDigest.reason);
  // A snapshot whose rows give the digest it names, which is not R5 of its box: the server misstates what the box
  // commits, a MISMATCH whatever its own check says.
  const misstates = await run(world(h, {committed: committedOf(h, racedRows, {digest: digest(racedRows), consistent: false})}));
  assert.deepEqual([misstates.verdict, misstates.tracker_race], ['MISMATCH', false]);
  assert.match(misstates.reason, /the rows give the digest the server says its box commits, which is not the box's R5: the server's confirmed digest is not on chain; the server's own check reports that its rows do not give its digest \(consistent: false\), but/);
  // A debt_key that is not its row's, another construction, a missing box: exit 2.
  const wrongKey = committedOf(h);
  wrongKey.rows[3].debt_key = wrongKey.rows[4].debt_key;
  for (const [snap, why] of [[wrongKey, /committed row 3: debt_key .* is not the debt key of its issuer, recipient and denomination/],
    [committedOf(h, undefined, {construction: 'basis-avl/2'}), /uses construction basis-avl\/2, which this audit cannot rebuild/],
    [committedOf(h, undefined, {box_id: null}), /has no box_id, height, digest or rows/],
    [committedOf(h, undefined, {network: 'valun-pilot-1'}), /the committed snapshot is of network valun-pilot-1, GET \/chain of valun-testnet-1/]]) {
    const x = await run(world(h, {committed: snap}));
    assert.deepEqual([x.verdict, x.exit], ['INCONSISTENT', 2]);
    assert.match(x.reason, why);
  }
  // 503 snapshot_moving: waited for (retry_after_ms, at most 10 s) and asked again; three answers of it: exit 2.
  let n = 0;
  const moving = () => (n++ < 2 ? json(503, {error: 'snapshot_moving', message: 'the snapshot moved', retry_after_ms: 5000}) : committedOf(h));
  const waits = [], ok = await A.audit({server: SERVER, explorer: EXPLORER, fetchImpl: world(h, {committed: moving}).fetchImpl, sleep: async ms => { waits.push(ms); }, cover: false, trackerNft: world(h).nft});
  assert.deepEqual([ok.verdict, waits], ['MATCH', [5000, 5000]]);
  const never = await run(world(h, {committed: () => json(503, {error: 'snapshot_moving', retry_after_ms: 60_000})}));
  assert.deepEqual([never.verdict, never.exit], ['INCONSISTENT', 2]);
  assert.match(never.reason, /ledger\/committed answered 503/);
  const down = await run(world(h, {committed: () => json(502, {error: 'tracker_unavailable'})}));
  assert.match(down.reason, /ledger\/committed answered 502/);
});

// A reserve box at the reserve contract, as the explorer lists it: R4 the owner, R5 its redemption tree (the empty one
// unless given), R6 the tracker NFT, R7 when given (its serialized value), one reserve NFT of its own (or `tokens`). Its
// `address` is what the explorer answered for the testnet's reserves on 2026-11-15: an abbreviation of the long P2S
// address, not the address; its ergoTree is the contract's. Its lineage goes into w.txs as the explorer serves
// transactions: `generations` earlier boxes of the owner, each spent by the transaction making the next with the same
// tokens, back to a root made by a transaction spending a P2PK box of `payer` (the owner unless given), the root with
// R5 `rootR5` (the empty tree unless given) and R7 `rootR7` (none unless given). With generations 0 the box is its own
// root. `made` is the transaction that made it (and its making transaction is then not recorded: a missing one).
const EXPLORER_SHORT_ADDRESS = 'Ms7smJmdbakqfwNo';
let serial = 0;
const nextId = () => (++serial).toString(16).padStart(64, '0');
function reserveBox(w, {owner, value, nft = w.nft, r7, r4, r5, tree = A.p2sTree(w.address), address = EXPLORER_SHORT_ADDRESS, tokens,
  generations = 0, payer = owner, rootR5, rootR7, record = true}) {
  const regsOf = (R5, R7) => {
    const g = {R4: {serializedValue: r4 ?? `07${owner}`, sigmaType: 'SGroupElement', renderedValue: owner}, R5: {serializedValue: R5, sigmaType: null, renderedValue: null},
      R6: {serializedValue: `0e20${nft}`, sigmaType: 'Coll[SByte]', renderedValue: nft}};
    if (R7 !== undefined) g.R7 = {serializedValue: R7, sigmaType: 'SLong', renderedValue: null};
    return g;
  };
  const boxId = nextId(), assets = tokens ?? [{tokenId: boxId.replace(/^0+/, 'f'), index: 0, amount: 1, name: null, decimals: null, type: null}];
  let input = {boxId: nextId(), value: 2_000_000_000, index: 0, outputTransactionId: nextId(), ergoTree: `0008cd${payer}`, address: '3Wpayer', assets: [], additionalRegisters: {}};
  let made = null, registers = null;
  for (let g = 0; g <= generations; g++) {
    const last = g === generations;
    registers = g === 0 ? regsOf(rootR5 ?? (last && r5 !== undefined ? r5 : A.EMPTY_RESERVE_TREE), rootR7 ?? (last ? r7 : undefined)) : last ? regsOf(r5 ?? A.EMPTY_RESERVE_TREE, r7) : regsOf(A.EMPTY_RESERVE_TREE, undefined);
    made = nextId();
    if (record) w.txs.set(made, txOf(made, 640001 + g, [input]));
    input = {boxId: last ? boxId : nextId(), value, index: 0, outputTransactionId: made, ergoTree: tree, address, assets, additionalRegisters: registers};
  }
  return {boxId, transactionId: made, blockId: 'cd'.repeat(32), value, index: 0, globalIndex: serial, creationHeight: 640000 + generations, settlementHeight: 640001 + generations,
    ergoTree: tree, address, assets, additionalRegisters: registers, spentTransactionId: null, mainChain: true};
}

test('direct reserve cover per issuer key: min(owed, redeemable) / owed, from the reserves the tracker admits; refunds, R7, other trackers, two lineages', async t => {
  if (!await load(t)) return;
  const h = 645189, notes = vector(h).ledger.notes;
  const owedOf = k => notes.filter(n => n.issuer_pubkey === k).reduce((s, n) => s + BigInt(Math.max(0, n.total - n.redeemed)), 0n);
  const exact = '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', stranger = `02${'5a'.repeat(32)}`;
  const idle = '030b278216327a855318c857db84417e9682301352cc57f3d194a114891a7d8c52';
  const owing = [...new Set(notes.map(n => n.issuer_pubkey))].filter(k => owedOf(k) > 0n);
  const [k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13] = owing.filter(k => k !== exact);
  assert.equal(owedOf(exact), 54250000n, 'the testnet\'s house issuer: total - redeemed over its 46 notes');
  assert.equal(owedOf(idle), 0n);
  const w = world(h);
  const fork = reserveBox(w, {owner: k12, value: 20000000, tokens: [], generations: 1});
  w.reserves = [
    reserveBox(w, {owner: exact, value: 137250000, generations: 3, r5: `64${vec(h).r5_digest}032000`}), // covers all it owes, 3 redemptions on
    reserveBox(w, {owner: exact, value: 400000, tokens: [], payer: stranger}),     // a stranger's dust box naming it: quarantined
    reserveBox(w, {owner: k2, value: 5000000, r7: '0500'}),                       // R7 = 0: no refund pending; 4,000,000 of what it owes
    reserveBox(w, {owner: k3, value: 50000000, r7: '0590de4e', generations: 1}), // a refund pending since height 645000
    reserveBox(w, {owner: k4, value: 30000000}), reserveBox(w, {owner: k4, value: 10000000}), // two lineages of its own: the smaller
    reserveBox(w, {owner: k5, value: 1000000}),                                   // exactly the remainder: nothing to take
    reserveBox(w, {owner: k6, value: 90000000, nft: 'ab'.repeat(32)}),            // another tracker's reserve: not counted
    reserveBox(w, {owner: k7, value: 90000000, r7: '0490de4e', generations: 1}), // R7 an Int: the box cannot be spent
    reserveBox(w, {owner: k8, value: 70000000, payer: stranger}),                 // another key paid for its root: quarantined
    reserveBox(w, {owner: k9, value: 70000000, generations: 2, rootR5: `64${vec(h).r5_digest}032000`}), // made with its tree filled in
    reserveBox(w, {owner: k10, value: 70000000, rootR7: '0502', generations: 1}), // made with a refund set
    reserveBox(w, {owner: k11, value: 70000000, record: false}),                  // the source has no transaction of it: not checked
    fork, {...fork, boxId: nextId()},                                             // two unspent boxes of one lineage: refused
    reserveBox(w, {owner: k13, value: 80000000, generations: A.MAX_LINEAGE_GENERATIONS}), // a lineage longer than this audit replays
    reserveBox(w, {owner: idle, value: 50000000}),                                // backs nothing owed
    reserveBox(w, {owner: idle, value: 5, r4: '0e01ff'}),                         // R4 no key: unreadable
  ];
  assert.equal(A.decodeLong('0590de4e'), 645000n);
  const r = await run(w, {cover: true});
  assert.equal(r.verdict, 'MATCH');
  const c = r.reserve_cover, key = k => c.keys.find(x => x.issuer_pubkey === k);
  assert.equal(c.computed, true, c.reason);
  const [house, dust] = w.reserves;
  assert.deepEqual(key(exact), {issuer_pubkey: exact, label: null, owed: '54250000', redeemable: '136250000', cover: 1, why: null, reserves: [
    {box_id: house.boxId, value: '137250000', refund_height: '0', admitted: true, root_box_id: key(exact).reserves[0].root_box_id, generations: 3, why: null},
    {box_id: dust.boxId, value: '400000', refund_height: '0', admitted: false, root_box_id: dust.boxId, generations: 0,
      why: `its root ${dust.boxId} was made by transaction ${dust.transactionId}, which spends no input of the owner's key: nothing authenticates R4, so the tracker quarantines it`}]},
  'a dust box naming the house key covers nothing and hides nothing');
  assert.notEqual(key(exact).reserves[0].root_box_id, house.boxId);
  const owedK2 = owedOf(k2), owedK4 = owedOf(k4);
  assert.deepEqual([key(k2).redeemable, key(k2).cover, key(k2).why], ['4000000', Number(((owedK2 < 4000000n ? owedK2 : 4000000n) * 10000n) / owedK2) / 10000, null]);
  assert.deepEqual([key(k3).redeemable, key(k3).cover, key(k3).why], ['0', 0, 'refund pending since height 645000']);
  assert.deepEqual([key(k4).redeemable, key(k4).why, key(k4).reserves.map(x => x.admitted)],
    ['9000000', '2 lineages opened by this key: the tracker tracks the one it saw first, which the chain does not say, and quarantines the others; counted at the smaller', [true, true]]);
  assert.equal(key(k4).cover, Number(((owedK4 < 9000000n ? owedK4 : 9000000n) * 10000n) / owedK4) / 10000);
  assert.deepEqual([key(k5).redeemable, key(k5).cover, key(k5).why], ['0', 0, null]);
  assert.deepEqual([key(k6).redeemable, key(k6).why, key(k6).reserves], ['0', 'no reserve', []], 'another tracker\'s reserve backs nothing here');
  assert.deepEqual([key(k7).redeemable, key(k7).why, key(k7).reserves[0].refund_height], ['0', 'R7 is not a Long: the contract cannot read it, so the reserve cannot be spent', null]);
  for (const [k, why] of [[k8, /which spends no input of the owner's key: nothing authenticates R4, so the tracker quarantines it$/], [k9, /was made with a redemption tree in R5 that is not empty: the tracker quarantines it$/],
    [k10, /was made with R7 set \(a refund from height 1\): the tracker quarantines it$/], [k11, /^not checked: the source has no transaction [0-9a-f]{64}, which made box [0-9a-f]{64}$/],
    [k13, new RegExp(`^not checked: its lineage is longer than ${A.MAX_LINEAGE_GENERATIONS} boxes$`)]]) {
    assert.deepEqual([key(k).redeemable, key(k).cover], ['0', 0], k);
    assert.match(key(k).why, why, k);
  }
  assert.deepEqual([key(k12).redeemable, key(k12).why, key(k12).reserves.map(x => x.root_box_id === key(k12).reserves[0].root_box_id)],
    ['0', '2 unspent boxes of one lineage: the tracker tracks each box that spends its reserve, and refuses every redemption until one is left (upstream ensure_single_issuer_reserve)', [true, true]]);
  assert.deepEqual(c.reserves_backing_nothing, [{owner_pubkey: idle, label: null, boxes: [{box_id: w.reserves.at(-2).boxId, value: '50000000', admitted: true}]}]);
  assert.deepEqual(c.reserves, {listed: 18, this_tracker: 16, other_trackers: 1, unreadable: 1, quarantined: 4, not_checked: 2});
  assert.deepEqual(r.warnings, [`2 reserve boxes of this tracker could not be checked (${key(k13).why}): counted as covering nothing`], 'the most valuable box unchecked is named');
  // Totals, computed here from the recorded ledger independently.
  const admitted = [exact, k2, k3, k4, k5, k7, k12], covered = 54250000n + (owedK2 < 4000000n ? owedK2 : 4000000n) + (owedK4 < 9000000n ? owedK4 : 9000000n);
  const owedAll = owing.reduce((s, k) => s + owedOf(k), 0n), noReserve = owing.filter(k => !admitted.includes(k));
  assert.deepEqual(c.totals, {owed: String(owedAll), covered: String(covered), cover: Number((covered * 10000n) / owedAll) / 10000,
    owed_by_keys_without_a_reserve: String(noReserve.reduce((s, k) => s + owedOf(k), 0n)), keys_without_a_reserve: noReserve.length, keys_owing: owing.length});
  assert.equal(c.keys.length, owing.length, 'every key that owes, once');
  assert.equal(new Set(c.keys.map(k => k.issuer_pubkey)).size, c.keys.length);
  assert.match(c.what, /evidence, not solvency/);
  assert.match(c.owed_is, /the tracker's counter \(GET \/ledger\), not reconciled from chain/);
  const text = A.render(r);
  assert.match(text, /Direct reserve cover per issuer key \(nanoERG\).*Evidence, not solvency\./);
  assert.match(text, /redeemed is the tracker's counter, not reconciled from chain/);
  assert.match(text, / 400,000 quarantined/);
  assert.match(text, /reserve boxes at the contract: 18 \(this tracker's 16, of them quarantined 4 and not checked 2; other trackers' 1, unreadable 1\)/);
  assert.doesNotMatch(text, /solvent|solvency of/i);
  // The reserve reads come after the verdict's, from the user's source only: the listing, then the lineages.
  const after = w.calls.slice(w.calls.indexOf(`GET ${EXPLORER}/api/v1/networkState`) + 1);
  assert.equal(after[0], `GET ${EXPLORER}/api/v1/boxes/unspent/byAddress/${w.address}?offset=0&limit=100`);
  assert.ok(after.slice(1).every(x => x.startsWith(`GET ${EXPLORER}/api/v1/transactions/`)), 'then each lineage, transaction by transaction');
  // Pages of 100 are read to the end.
  const many = world(h);
  many.reserves = Array.from({length: 230}, () => reserveBox(many, {owner: idle, value: 2000000}));
  const rm = await run(many, {cover: true});
  assert.deepEqual([rm.reserve_cover.reserves.listed, many.calls.filter(x => x.includes('byAddress')).length], [230, 3]);
});

test('the cover fails closed: a reserve listing cut at RESERVE_LIST_MAX, and a run\'s lineage reads used up, count nothing, the most valuable boxes read first', async t => {
  if (!await load(t)) return;
  const h = 645189, exact = '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', stranger = `02${'5a'.repeat(32)}`;
  // 5,100 junk boxes at the contract ahead of the house reserve: the listing stops at 5,000, so no cover is computed.
  const w = world(h), junk = reserveBox(w, {owner: stranger, value: 1000000, nft: 'ab'.repeat(32), record: false});
  w.reserves = [...Array.from({length: A.RESERVE_LIST_MAX + 100}, (_, i) => ({...junk, boxId: (i + 1).toString(16).padStart(64, 'e')})), reserveBox(w, {owner: exact, value: 137250000})];
  const r = await run(w, {cover: true});
  assert.deepEqual([r.verdict, r.reserve_cover.computed], ['MATCH', false]);
  assert.equal(r.reserve_cover.reason, `source inconsistent: the reserve contract holds more than the ${A.RESERVE_LIST_MAX} unspent boxes this audit reads (the source says ${A.RESERVE_LIST_MAX + 101}): the cover is not computed from part of them`);
  assert.equal(w.calls.filter(x => x.includes('byAddress')).length, A.RESERVE_LIST_MAX / 100);
  // Dust of this tracker naming many keys, each its own root: the house reserve, the most valuable, is read first and
  // stays covered; what the run's reads do not reach counts nothing, with a warning.
  const many = world(h);
  many.reserves = [...Array.from({length: A.MAX_LINEAGE_READS + 5}, () => reserveBox(many, {owner: stranger, value: 400000, tokens: []})), reserveBox(many, {owner: exact, value: 137250000})];
  const m = await run(many, {cover: true});
  const house = m.reserve_cover.keys.find(k => k.issuer_pubkey === exact);
  assert.deepEqual([house.redeemable, house.cover], ['136250000', 1]);
  assert.deepEqual([m.reserve_cover.reserves.not_checked, many.calls.filter(x => x.includes('/transactions/')).length], [6, A.MAX_LINEAGE_READS]);
  assert.match(m.warnings.join('\n'), new RegExp(`^6 reserve boxes of this tracker could not be checked \\(not checked: this run's ${A.MAX_LINEAGE_READS} transaction reads for lineages were used up\\): counted as covering nothing$`, 'm'));
});

test('the testnet\'s real reserve boxes (the explorer\'s answer): six of this tracker, one of the demo tracker\'s; the cover per owner', async t => {
  if (!await load(t)) return;
  const h = 645189, notes = vector(h).ledger.notes, rec = read('reserves.explorer.json').response;
  const w = world(h, {reserves: rec.items});
  assert.equal(rec.items.length, 7);
  assert.ok(rec.items.every(b => b.address !== w.address && b.ergoTree === A.p2sTree(w.address)), 'abbreviated addresses, the contract\'s tree');
  // Their lineages, which the fixture does not record: each box made by its owner (a box whose tree is not empty after
  // one redemption from an empty root), as the tracker admitted them.
  for (const b of rec.items) {
    const owner = b.additionalRegisters.R4.serializedValue.slice(2), payer = {boxId: nextId(), outputTransactionId: nextId(), ergoTree: `0008cd${owner}`, assets: [], additionalRegisters: {}};
    if (b.additionalRegisters.R5.serializedValue === A.EMPTY_RESERVE_TREE) { w.txs.set(b.transactionId, txOf(b.transactionId, b.settlementHeight, [payer])); continue; }
    const root = nextId(), rootTx = nextId();
    w.txs.set(rootTx, txOf(rootTx, b.settlementHeight - 5, [payer]));
    w.txs.set(b.transactionId, txOf(b.transactionId, b.settlementHeight, [{boxId: root, outputTransactionId: rootTx, ergoTree: b.ergoTree, assets: b.assets,
      additionalRegisters: {...b.additionalRegisters, R5: {serializedValue: A.EMPTY_RESERVE_TREE}}}]));
  }
  const r = await run(w, {cover: true});
  assert.equal(r.verdict, 'MATCH');
  const c = r.reserve_cover;
  assert.equal(c.computed, true, c.reason);
  assert.deepEqual(c.reserves, {listed: 7, this_tracker: 6, other_trackers: 1, unreadable: 0, quarantined: 0, not_checked: 0});
  assert.equal(rec.items.filter(b => b.additionalRegisters.R5.serializedValue === A.EMPTY_RESERVE_TREE).length, 4, 'four of the live boxes still hold the empty tree, R5 exactly as the tracker admits a root');
  // Each owner's cover, from the boxes and the recorded ledger, worked out here: min(owed, value - 1,000,000) / owed.
  const owners = rec.items.filter(b => b.additionalRegisters.R6.serializedValue === `0e20${w.nft}`).map(b => [b.additionalRegisters.R4.serializedValue.slice(2), BigInt(b.value)]);
  assert.equal(new Set(owners.map(o => o[0])).size, 6, 'one reserve per owner');
  for (const [owner, value] of owners) {
    const owed = notes.filter(n => n.issuer_pubkey === owner).reduce((s, n) => s + BigInt(Math.max(0, n.total - n.redeemed)), 0n);
    const k = c.keys.find(x => x.issuer_pubkey === owner);
    if (owed === 0n) {
      assert.equal(k, undefined, `${owner} owes nothing`);
      assert.ok(c.reserves_backing_nothing.some(x => x.owner_pubkey === owner), `${owner}'s reserve backs nothing owed`);
      continue;
    }
    const redeemable = value - 1000000n, covered = owed < redeemable ? owed : redeemable;
    assert.deepEqual([k.owed, k.redeemable, k.cover, k.why], [String(owed), String(redeemable), Number((covered * 10000n) / owed) / 10000, null], owner);
  }
  assert.equal(c.keys.find(x => x.issuer_pubkey.startsWith('031457b9')).cover, 1, 'the house issuer: covered');
  assert.deepEqual(r.warnings, []);
  // The review's probe: one dust box of 400,000 nanoERG naming the house key, made by someone else, changes nothing.
  const house = '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf';
  w.reserves = [...rec.items, reserveBox(w, {owner: house, value: 400000, tokens: [], payer: `02${'5a'.repeat(32)}`})];
  const again = await run(w, {cover: true});
  assert.deepEqual([again.reserve_cover.totals, again.reserve_cover.keys.find(x => x.issuer_pubkey === house).cover], [c.totals, 1]);
});

test('the cover is not computed on a MISMATCH or with --no-cover; a reserve not at the address is a source inconsistency for the cover alone', async t => {
  if (!await load(t)) return;
  const h = 645189, w = world(h);
  // A box at another script (a P2PK box) listed at the reserve contract; its address field does not matter either way.
  const p2pk = `0008cd${'031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf'}`;
  w.reserves = [reserveBox(w, {owner: '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', value: 137250000, tree: p2pk, address: w.address})];
  const r = await run(w, {cover: true});
  assert.deepEqual([r.verdict, r.exit], ['MATCH', 0], 'the digest verdict stands');
  assert.equal(r.reserve_cover.computed, false);
  assert.match(r.reserve_cover.reason, /^source inconsistent: box 0+[0-9a-f]+, listed at the reserve contract, is not at its address \(another ErgoTree\)$/);
  // The explorer's abbreviated address with the contract's tree is at the address (every other cover test uses it).
  const short = world(h);
  short.reserves = [reserveBox(short, {owner: '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', value: 137250000})];
  assert.equal(short.reserves[0].address, EXPLORER_SHORT_ADDRESS);
  assert.equal((await run(short, {cover: true})).reserve_cover.computed, true);
  const spent = world(h);
  spent.reserves = [{...reserveBox(spent, {owner: '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', value: 1}), spentTransactionId: 'ef'.repeat(32)}];
  assert.match((await run(spent, {cover: true})).reserve_cover.reason, /was spent by transaction/);
  const none = await run(world(h), {cover: false});
  assert.deepEqual(none.reserve_cover, {computed: false, reason: '--no-cover'});
  // Another reserve contract than the pinned one: a warning; no reserve naming this tracker while others do: a warning.
  const v = vector(h), other = world(h, {chain: v.chain.map(c => ({...clone(c), reserve_contract: '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB'}))});
  other.address = '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB';
  const ro = await run(other, {cover: true});
  assert.match(ro.warnings.join('\n'), /a reserve contract other than the one this audit pins/);
  const foreign = world(h);
  foreign.reserves = [reserveBox(foreign, {owner: '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', value: 137250000, nft: 'ab'.repeat(32)})];
  assert.match((await run(foreign, {cover: true})).warnings.join('\n'), /no reserve at the reserve contract names the tracker NFT the server gives \(1 name another\): this tracker has no reserve, or the reserves people fund trust another tracker$/);
});

test('the register and address decoders: AvlTree, GroupElement, Coll[Byte], Long (ZigZag), a P2S address', async t => {
  if (!await load(t)) return;
  const d = vec(645189).r5_digest;
  assert.deepEqual(A.decodeAvlTree(`64${d}032000`), {digest: d, flags: 3, key_length: 32, value_length: null});
  assert.deepEqual(A.decodeAvlTree(`64${d}03200110`), {digest: d, flags: 3, key_length: 32, value_length: 16});
  assert.deepEqual(A.decodeAvlTree(`64${d}03808001` + '00'), {digest: d, flags: 3, key_length: 16384, value_length: null});
  for (const [bad, why] of [[`65${d}032000`, /type code is not 0x64/], [`64${d}0320`, /too short/], [`64${d}038001`, /ends before its value length/], [`64${d}03200000`, /1 bytes after its AvlTree/],
    [`64${d}032002`, /not an option \(tag 2\)/], [`64${d.slice(2)}`, /too short/], [`64${d}0320 0`.replace(' ', ''), /not lowercase hex bytes/], [undefined, /not lowercase hex/],
    [`64${d}03ffffffffff0100`, /does not fit 32 bits/], [`64${d}03${'80'.repeat(10)}00`, /longer than 10 bytes/], [`64${d.toUpperCase()}032000`, /lowercase hex/]]) {
    assert.throws(() => A.decodeAvlTree(bad), why, String(bad));
  }
  const pk = `03${'ab'.repeat(32)}`;
  assert.equal(A.decodeGroupElement(`07${pk}`), pk);
  for (const bad of [`06${pk}`, `07${pk}00`, `0704${'ab'.repeat(32)}`, '07', null]) assert.throws(() => A.decodeGroupElement(bad), /not a GroupElement/);
  assert.equal(A.decodeCollByte(`0e20${'cd'.repeat(32)}`), 'cd'.repeat(32));
  assert.equal(A.decodeCollByte('0e00'), '');
  for (const bad of [`0e21${'cd'.repeat(32)}`, `0f20${'cd'.repeat(32)}`, '0e']) assert.throws(() => A.decodeCollByte(bad));
  for (const [hex, v] of [['0500', 0n], ['0501', -1n], ['0502', 1n], ['0590de4e', 645000n], [`05fe${'ff'.repeat(8)}01`, (1n << 63n) - 1n], [`05${'ff'.repeat(9)}01`, -(1n << 63n)]]) assert.equal(A.decodeLong(hex), v, hex);
  for (const bad of ['0490de4e', '05', '050000', `05${'ff'.repeat(9)}03`]) assert.throws(() => A.decodeLong(bad), undefined, bad);
  // The reserve contract's P2S address gives a tree; a P2PK address or junk gives none.
  const v = vector(645189).chain[0];
  assert.match(A.p2sTree(v.reserve_contract), /^[0-9a-f]+$/);
  assert.equal(A.p2sTree(v.reserve_contract).length, 2 * 764);
  assert.deepEqual([A.p2sTree(v.tracker_address), A.p2sTree('0OIl'), A.p2sTree(''), A.p2sTree(null)], [null, null, null, null]);
});

test('an Ergo node as the source: GET byTokenId (a list), GET /info, the read-only POST by address: MATCH and the cover', async t => {
  if (!await load(t)) return;
  const h = 645135, w = world(h), item = vector(h).explorer_unspent_by_token.items[0];
  // The node's index describes a box with its registers as serialized hex and no mainChain.
  const nodeBox = b => ({boxId: b.boxId, value: b.value, ergoTree: b.ergoTree, assets: b.assets.map(a => ({tokenId: a.tokenId, amount: a.amount})), creationHeight: b.creationHeight,
    additionalRegisters: Object.fromEntries(Object.entries(b.additionalRegisters).map(([k, x]) => [k, x.serializedValue])), transactionId: b.transactionId, index: b.index,
    address: b.address, spentTransactionId: null, inclusionHeight: b.settlementHeight, globalIndex: b.globalIndex});
  // A transaction as the node's index serves it: each input a whole box, whose transactionId is the one that made it.
  const nodeTx = x => ({...x, inputs: x.inputs.map(i => ({boxId: i.boxId, value: i.value ?? 1, ergoTree: i.ergoTree, assets: (i.assets || []).map(a => ({tokenId: a.tokenId, amount: a.amount})),
    additionalRegisters: Object.fromEntries(Object.entries(i.additionalRegisters || {}).map(([k, v]) => [k, v.serializedValue])), transactionId: i.outputTransactionId, creationHeight: 1}))});
  const reserves = [reserveBox(w, {owner: '031457b944b3d584eecef1ff82f2f9c4aac1082d51768e9a6c25a4ef5cb01a13bf', value: 137250000, generations: 1})];
  const calls = [];
  const nodeFetch = (vw, {byToken = [nodeBox(item)], height = h + 7} = {}) => async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    if (u.origin !== NODE) return vw.fetchImpl(url, init);
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname === `/blockchain/box/unspent/byTokenId/${vw.nft}`) return json(200, byToken);
    if (u.pathname === '/info') return json(200, {network: 'testnet', fullHeight: height, headersHeight: height});
    if (u.pathname === '/blockchain/box/unspent/byAddress' && method === 'POST') {
      assert.equal(JSON.parse(init.body), vw.address, 'the body is the address as a JSON string');
      return json(200, u.searchParams.get('offset') === '0' ? reserves.map(nodeBox) : []);
    }
    const m = u.pathname.match(/^\/blockchain\/(box|transaction)\/byId\/([0-9a-f]{64})$/);
    if (m && m[1] === 'transaction' && vw.txs.has(m[2])) return json(200, nodeTx(vw.txs.get(m[2])));
    if (m && m[1] === 'box' && vw.boxes.has(m[2])) return json(200, {...nodeBox(vw.boxes.get(m[2])), spentTransactionId: vw.boxes.get(m[2]).spentTransactionId});
    return json(404, {error: 404});
  };
  const fetchImpl = nodeFetch(w);
  const r = await A.audit({server: SERVER, node: NODE, fetchImpl, settleMs: 0, sleep: async () => {}, trackerNft: w.nft});
  assert.equal(r.verdict, 'MATCH', r.reason);
  assert.deepEqual([r.source.kind, r.box_age_blocks, r.box.settlement_height], ['node', 7, item.settlementHeight]);
  const house = r.reserve_cover.keys.find(k => k.issuer_pubkey.startsWith('031457b9'));
  assert.deepEqual([house.cover, house.reserves[0].admitted, house.reserves[0].generations], [1, true, 1], 'its lineage replayed on the node');
  assert.deepEqual(calls, [`GET /blockchain/box/unspent/byTokenId/${w.nft}?offset=0&limit=10`, 'GET /info', 'POST /blockchain/box/unspent/byAddress?offset=0&limit=100',
    `GET /blockchain/transaction/byId/${reserves[0].transactionId}`, `GET /blockchain/transaction/byId/${w.txs.get(reserves[0].transactionId).inputs[0].outputTransactionId}`]);
  // The box the server names, looked up on the node: the 645135 box, replaced 50 blocks ago by the 645189 one (exit 2:
  // the server publishes a superseded box's rows); and the same box id with another R5 (a MISMATCH).
  const old = vec(645135).box_id, moved = 'ac'.repeat(32), stale = world(645135, {boxes: {[old]: boxOf(645135, moved)}, txs: {[moved]: txOf(moved, 645190)}});
  const onNode = w2 => A.audit({server: SERVER, node: NODE, fetchImpl: nodeFetch(w2, {byToken: [nodeBox(vector(645189).explorer_unspent_by_token.items[0])], height: 645240}), settleMs: 0, sleep: async () => {}, cover: false, trackerNft: w2.nft});
  const r3 = await onNode(stale);
  assert.deepEqual([r3.verdict, r3.exit], ['INCONSISTENT', 2]);
  assert.match(r3.reason, /is a tracker box the chain replaced 50 blocks ago .*: the server publishes the rows of a superseded box, which are not compared with the box redemptions use now, so nothing was compared/);
  assert.ok(calls.includes(`GET /blockchain/box/byId/${old}`) && calls.includes(`GET /blockchain/transaction/byId/${moved}`));
  const misstated = boxOf(645135, moved);
  misstated.additionalRegisters.R5.serializedValue = `64${vec(645189).r5_digest}032000`;
  const r4 = await onNode(world(645135, {boxes: {[old]: misstated}}));
  assert.deepEqual([r4.verdict, r4.exit], ['MISMATCH', 1]);
  assert.match(r4.reason, new RegExp(`; on chain, R5 of box ${old} commits ${vec(645189).r5_digest}: the server misstates what its box commits$`));
  // The node the server's /chain names (http://213.239.193.208:9052) as the source: used, with a warning.
  const named = vector(h).chain[0].node;
  const r2 = await A.audit({server: SERVER, node: named, fetchImpl: async (url, init) => fetchImpl(String(url).replace(named, NODE), init), settleMs: 0, sleep: async () => {}, cover: false, trackerNft: w.nft});
  assert.equal(r2.verdict, 'MATCH');
  assert.deepEqual(r2.warnings, [`the chain source is the node the server's GET /chain names (${named}): it is the operator's choice of source, not yours; name another to check the operator independently`]);
  // A node that is not indexed (404 on the blockchain API) is a source that cannot answer: exit 2.
  const bare = await A.audit({server: SERVER, node: NODE, fetchImpl: async (url, init) => (new URL(url).origin === NODE ? json(404, {error: 404, reason: 'not-found'}) : w.fetchImpl(url, init)), settleMs: 0, sleep: async () => {}, trackerNft: w.nft});
  assert.deepEqual([bare.verdict, bare.exit], ['INCONSISTENT', 2]);
  assert.match(bare.reason, /byTokenId.* answered 404/);
});

test('the CLI: importing it runs nothing; exit 0, 1 and 2, one JSON line with --json, the text report, refusals', async t => {
  if (!await load(t)) return;
  assert.equal(typeof A.main, 'function', 'imported, not run');
  // A fault of the script itself (here a fetch that answers no body) is exit 2, verdict ERROR: never 1, a MISMATCH.
  const lines = [];
  const code = await A.main(['--server', SERVER, '--explorer', EXPLORER, '--json'], {fetchImpl: async () => ({status: 200}), stdout: {write: s => lines.push(s)}});
  assert.equal(code, 2);
  assert.deepEqual([JSON.parse(lines[0]).verdict, JSON.parse(lines[0]).exit], ['ERROR', 2]);
  assert.match(JSON.parse(lines[0]).reason, /^the audit failed: TypeError/);
  const h = 645189, w = world(h);
  let ledger = vector(h).ledger;
  // The recorded reads on loopback: the server on one port, the explorer on another (the audit refuses the server's own
  // origin as a chain source).
  const serve = origin => http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = origin === SERVER && u.pathname === '/pilot/v1/ledger' ? json(200, ledger) : await w.fetchImpl(`${origin}${u.pathname}${u.search}`, {method: req.method});
    res.writeHead(r.status, {'content-type': 'application/json'});
    res.end(await r.text());
  });
  const srv = serve(SERVER), exp = serve(EXPLORER);
  await Promise.all([srv, exp].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const base = `http://127.0.0.1:${srv.address().port}`, explorerBase = `http://127.0.0.1:${exp.address().port}`;
  const cli = args => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script, ...args], {cwd: root});
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('error', reject); c.on('close', code => resolve({code, out, err}));
  });
  try {
    const ok = await cli(['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--json', '--no-cover']);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out.split('\n').filter(Boolean).length, 1, 'one line');
    const j = JSON.parse(ok.out);
    assert.deepEqual([j.verdict, j.exit, j.box.box_id, j.data.rows], ['MATCH', 0, vec(h).box_id, 251]);
    const text = await cli(['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--no-cover']);
    assert.equal(text.code, 0);
    assert.match(text.out, /^Anchor audit of http:\/\/127\.0\.0\.1:\d+ \(valun-testnet-1\), chain source: explorer http:\/\/127\.0\.0\.1:\d+\nMATCH: /);
    assert.match(text.out, /\n {2}windows {4}nettings refused from height 646629 \(\+1440: in 1320 blocks\); tracker-less redemption from 647350 \(\+2161: in 2041 blocks\)\n/);
    // One total raised in GET /ledger: rows that give neither digest, exit 2; in the committed snapshot: MISMATCH, 1.
    const raised = ledger.notes.map((n, i) => (i === 0 ? {...n, total: n.total + 1} : n));
    ledger = {...ledger, notes: raised};
    const older = await cli(['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--json']);
    assert.deepEqual([older.code, JSON.parse(older.out).verdict], [2, 'INCONSISTENT']);
    const neither = await cli(['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--no-cover']);
    assert.equal(neither.code, 2);
    assert.match(neither.out, /\nNOT CHECKED \(source or state inconsistent\): the 251 rows of GET \/pilot\/v1\/ledger give [0-9a-f]{66}: neither R5 of box /);
    w.committed = committedOf(h, rowsOf(raised));
    const bad = await cli(['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--json']);
    assert.deepEqual([bad.code, JSON.parse(bad.out).verdict, JSON.parse(bad.out).tracker_race], [1, 'MISMATCH', false]);
    w.committed = null;
    const none = await cli(['--server', base]);
    assert.equal(none.code, 2);
    assert.match(none.out, /^REFUSED: no chain source\. Name one with --explorer URL/);
    const itself = await cli(['--server', base, '--node', `${base}/`, '--json']);
    assert.deepEqual([itself.code, JSON.parse(itself.out).verdict], [2, 'REFUSED']);
    const unknown = await cli(['--server', base, '--explorer', explorerBase, '--json', '--fast']);
    assert.deepEqual([unknown.code, JSON.parse(unknown.out).verdict], [2, 'REFUSED']);
    const value = await cli(['--explorer']);
    assert.equal(value.code, 2);
    assert.match(value.out, /--explorer needs a value/);
    // Run through a linked folder (a symlink; a junction on Windows): still the script, never a silent exit 0, which
    // reads as MATCH. Only the link is removed afterwards, never what it points to.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-audit-')), link = path.join(dir, 'repo');
    fs.symlinkSync(root, link, 'junction');
    try {
      const linked = await new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [path.join(link, 'scripts', 'ops', 'anchor-audit.mjs'), '--server', base], {cwd: dir});
        let out = '';
        c.stdout.on('data', d => { out += d; }); c.on('error', reject); c.on('close', code => resolve({code, out}));
      });
      assert.deepEqual([linked.code, linked.out.split(':')[0]], [2, 'REFUSED'], linked.out);
    } finally {
      try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
      fs.rmdirSync(dir);
    }
  } finally { srv.close(); exp.close(); }
});

// The entry check of a node without import.meta.main (Node 22 to 24.1; CI runs 24, where it is not used): a check that
// never matched would print nothing and exit 0, which reads as MATCH.
test('isEntry, the entry check without import.meta.main: this script by its path or through a linked folder; no other file, no file', async t => {
  if (!await load(t)) return;
  assert.equal(A.isEntry(script), true);
  assert.equal(A.isEntry(path.join(root, 'scripts', 'ops', '..', 'ops', 'anchor-audit.mjs')), true, 'an unnormalized path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-entry-')), link = path.join(dir, 'repo');
  fs.symlinkSync(root, link, 'junction');
  try {
    assert.equal(A.isEntry(path.join(link, 'scripts', 'ops', 'anchor-audit.mjs')), true, 'through a linked folder');
    assert.equal(A.isEntry(script, path.join(link, 'scripts', 'ops', 'anchor-audit.mjs')), true, 'the module itself at a linked path (--preserve-symlinks-main)');
  } finally {
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
    fs.rmdirSync(dir);
  }
  for (const other of [path.join(root, 'scripts', 'ops', 'anchor-watch.sh'), path.join(root, 'scripts', 'ops', 'no-such-file.mjs'), '', null]) {
    assert.equal(A.isEntry(other), false, String(other));
  }
  assert.equal(A.isEntry(), false, 'this test file is node\'s entry here, not the script');
});

// scripts/ops/anchor-watch.sh, on the recorded reads served on loopback (bash: CI and WSL, not Windows itself).
const NO_BASH = process.platform === 'win32' && 'the watcher is a bash script: run it in WSL or CI';
// The recorded reads of `h` on loopback, as world(h) serves them (w.committed and w.byToken may change between runs),
// and watch(args), the watcher run with OPS_OUT a folder of its own; audit: the flags of a run against them. close()
// stops both servers and removes the folder.
async function watcherOn(h) {
  const w = world(h), watcher = path.join(root, 'scripts', 'ops', 'anchor-watch.sh'), opsOut = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-watch-'));
  const serve = origin => http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), r = await w.fetchImpl(`${origin}${u.pathname}${u.search}`, {method: req.method});
    res.writeHead(r.status, {'content-type': 'application/json'});
    res.end(await r.text());
  });
  const srv = serve(SERVER), exp = serve(EXPLORER);
  await Promise.all([srv, exp].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const base = `http://127.0.0.1:${srv.address().port}`, explorerBase = `http://127.0.0.1:${exp.address().port}`;
  const watch = args => new Promise((resolve, reject) => {
    const c = spawn('bash', [watcher, ...args], {cwd: root, env: {...process.env, OPS_OUT: opsOut}});
    let out = '';
    const kill = setTimeout(() => c.kill('SIGKILL'), 30_000);
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    c.on('error', reject); c.on('close', code => { clearTimeout(kill); resolve({code, out}); });
  });
  const close = () => {
    srv.close(); exp.close();
    for (const f of fs.readdirSync(opsOut)) fs.unlinkSync(path.join(opsOut, f));
    fs.rmdirSync(opsOut);
  };
  return {w, watch, base, explorerBase, close, audit: ['--server', base, '--explorer', explorerBase, '--tracker-nft', w.nft, '--settle-ms', '0', '--no-cover']};
}
// A snapshot of the 645189 box whose own check says consistent: false, its digest R5, its rows (one total raised) not
// giving it: what tracker v4.4 serves for a box after a raced update, and what a server serving other rows would.
const racedOf = h => committedOf(h, rowsOf(vector(h).ledger.notes).map((x, i) => (i === 0 ? {...x, total: x.total + 1} : x)), {consistent: false});

test('anchor-watch.sh fails closed: a flag missing its value is refused, a watch with no MATCH or too many unchecked runs in a row is exit 2; a tracker_race run is counted apart (RACE); a MISMATCH is exit 1', {skip: NO_BASH}, async t => {
  if (!await load(t)) return;
  const h = 645189, {w, watch, audit, base, explorerBase, close} = await watcherOn(h);
  // GET /ledger/committed answers 503 snapshot_moving to its first three reads (one run: INCONSISTENT), then the snapshot.
  let reads = 0;
  w.committed = () => (reads++ < 3 ? json(503, {error: 'snapshot_moving', retry_after_ms: 250}) : committedOf(h));
  try {
    for (const args of [['--server', base, '--explorer'], ['--server', base, '--explorer', explorerBase, '--hours'], ['--every', '--server', base, '--explorer', explorerBase]]) {
      const r = await watch(args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, new RegExp(`refused: ${args.find((a, i) => a.startsWith('--') && (i === args.length - 1 || args[i + 1].startsWith('--')))} needs a value`));
    }
    const none = await watch(['--hours', '0', ...audit]);
    assert.equal(none.code, 2, none.out);
    assert.match(none.out, /0 runs: .*FAIL: no run compared the server's rows with the chain \(no MATCH\)/s);
    // A run that compared nothing, then MATCHes: more than --max-unchecked 0 in a row is exit 2; the default passes.
    const strict = await watch(['--hours', '0.001', '--every', '1', '--max-unchecked', '0', ...audit]);
    assert.equal(strict.code, 2, strict.out);
    assert.match(strict.out, /INCONSISTENT 1.*\n {2}1: http:\/\/127\.0\.0\.1:\d+\/pilot\/v1\/ledger\/committed answered 503.*FAIL: 1 runs in a row proved nothing \(compared nothing, or a RACE\), more than --max-unchecked 0/s);
    assert.match(strict.out, /MATCH [1-9]/);
    const ok = await watch(['--hours', '0.001', '--every', '1', ...audit]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /runs: MATCH [1-9]\d*, MISMATCH 0, RACE 0, RACE_AFTER_MATCH 0, INCONSISTENT 0, ERROR 0; 0 compared nothing, 0 consistent with the tracker's known race, 0 a RACE on a box after a MATCH of it; at most 0 in a row proved nothing/);
    // fix inbox #65: a snapshot whose own check says consistent: false, its digest R5, its rows not giving it, as
    // tracker v4.4 serves for a box after a raced update (and as a server serving other rows would). A RACE run, listed
    // apart and not a MISMATCH, never called "not tampering"; it still proves nothing, so it counts in the runs in a
    // row (exit 2 past --max-unchecked). Records that come to agree with the box afterwards (a MATCH) are the race's
    // repair: the watch passes.
    const raced = racedOf(h);
    let races = 0;
    w.committed = () => (races++ < 1 ? raced : committedOf(h));
    const race = await watch(['--hours', '0.001', '--every', '1', ...audit]);
    assert.equal(race.code, 0, race.out);
    assert.match(race.out, /run 1: RACE \(MATCH 0, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 0, INCONSISTENT 0, ERROR 0\)/);
    assert.match(race.out, /runs: MATCH [1-9]\d*, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 0, INCONSISTENT 0, ERROR 0; 0 compared nothing, 1 consistent with the tracker's known race, 0 a RACE on a box after a MATCH of it; at most 1 in a row proved nothing/);
    assert.match(race.out, /\nRACE lines \(each consistent with tracker v4\.4's known race after a box update, fix inbox #65, which clears at the tracker's next box; an audit cannot tell it from a server that serves other rows and says consistent: false\):\n1:\{"tool":"anchor-audit".*"verdict":"MISMATCH"/);
    assert.doesNotMatch(race.out, /MISMATCH lines:|RACE_AFTER_MATCH lines|not tampering/);
    races = 0;
    const raceStrict = await watch(['--hours', '0.001', '--every', '1', '--max-unchecked', '0', ...audit]);
    assert.equal(raceStrict.code, 2, raceStrict.out);
    assert.match(raceStrict.out, /FAIL: 1 runs in a row proved nothing \(compared nothing, or a RACE\), more than --max-unchecked 0/);
    // The same rows with the server's check saying they pass (consistent: true): no race, a MISMATCH, exit 1.
    const lied = {...raced, consistent: true};
    let lies = 0;
    w.committed = () => (lies++ < 1 ? lied : committedOf(h));
    const mismatch = await watch(['--hours', '0.001', '--every', '1', ...audit]);
    assert.equal(mismatch.code, 1, mismatch.out);
    assert.match(mismatch.out, /run 1: MISMATCH \(MATCH 0, MISMATCH 1, RACE 0,/);
    assert.match(mismatch.out, /\nMISMATCH lines:\n1:\{"tool":"anchor-audit".*"verdict":"MISMATCH"/);
    assert.doesNotMatch(mismatch.out, /RACE lines/);
    // A server that answers nothing: INCONSISTENT at most, never a pass.
    const down = await watch(['--hours', '0.0005', '--every', '1', '--server', 'http://127.0.0.1:9', '--explorer', explorerBase, '--tracker-nft', w.nft, '--no-cover']);
    assert.equal(down.code, 2, down.out);
    assert.match(down.out, /FAIL: no run compared/);
  } finally { close(); }
});

// Review of 2026-11-15 (finding 1): the server's own flag must not pass a watch. RACE rested on consistent: false alone,
// and never made a watch exit 1, so a server serving the chain's own box with other rows and consistent: false on most
// reads, and the box's own rows now and then, passed a watch with exit 0 (the base, d45ebe9, gave exit 1 there).
test('anchor-watch.sh: a RACE on a box after a MATCH of it is RACE_AFTER_MATCH and fails the watch (exit 2); a RACE on the box that follows is that box\'s race', {skip: NO_BASH}, async t => {
  if (!await load(t)) return;
  const h = 645189, {w, watch, audit, close} = await watcherOn(h), raced = racedOf(h);
  try {
    // RACE, then MATCH, then the same RACE on that one box. The race leaves the records the tracker promotes for a box
    // wrong until its next box, and they may come to agree with it, never the other way: after the MATCH the RACE is
    // RACE_AFTER_MATCH, listed apart, and the watch fails (exit 2, not 1: a keep-alive box read before its promotion,
    // or a tracker that lost or restored its records, could give one too).
    let turns = 0;
    w.committed = () => (turns++ === 1 ? committedOf(h) : raced);
    const late = await watch(['--hours', '0.002', '--every', '1', ...audit]);
    assert.equal(late.code, 2, late.out);
    assert.match(late.out, /run 1: RACE \(MATCH 0, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 0,/);
    assert.match(late.out, /run 2: MATCH \(MATCH 1, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 0,/);
    assert.match(late.out, /run 3: RACE_AFTER_MATCH \(MATCH 1, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 1,/);
    assert.match(late.out, /\nRACE lines \(.*\):\n1:\{"tool":"anchor-audit".*"verdict":"MISMATCH".*\nRACE_AFTER_MATCH lines \(a RACE on a box after a MATCH of it: once the tracker has promoted a box, the known race may let its records come to agree with it, never the other way\):\n3:\{"tool":"anchor-audit".*"verdict":"MISMATCH"/s);
    assert.match(late.out, /\nFAIL: \d+ runs were a RACE on a box after a MATCH of it: the server served rows that give its R5, then rows that do not, saying consistent: false, which tracker v4\.4's known race does not do once it has promoted the box; see the RACE_AFTER_MATCH lines\n/);
    assert.doesNotMatch(late.out, /MISMATCH lines:|not tampering/);
    // A RACE on another box than the one MATCHed is the race of that box's update: here the chain's next box is a
    // keep-alive (another id, the same R5), whose records race, then agree. The watch passes.
    const next = clone(vector(h).explorer_unspent_by_token), id = 'c0'.repeat(32);
    next.items[0].boxId = id;
    let step = 0;
    w.committed = () => {
      const n = step++;
      w.byToken = n === 0 ? clone(vector(h).explorer_unspent_by_token) : next;
      return n === 0 ? committedOf(h) : n === 1 ? {...raced, box_id: id} : committedOf(h, undefined, {box_id: id});
    };
    const moved = await watch(['--hours', '0.002', '--every', '1', ...audit]);
    assert.equal(moved.code, 0, moved.out);
    assert.match(moved.out, /run 1: MATCH .*\n.*run 2: RACE \(MATCH 1, MISMATCH 0, RACE 1, RACE_AFTER_MATCH 0,.*\n.*run 3: MATCH /);
    assert.match(moved.out, /, 1 consistent with the tracker's known race, 0 a RACE on a box after a MATCH of it;/);
  } finally { close(); }
});
