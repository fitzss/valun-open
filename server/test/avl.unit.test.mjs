// lib/avl.mjs, the AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62, steps 1-2), against references it cannot
// produce itself:
//   - three live anchors of the testnet tracker (test/fixtures/anchor-vectors/<height>.json): the published notes, in
//     debt-key order, give the R5 digest of the one unspent tracker-NFT box; inserted in the order listed (their
//     timestamps') they give the other digest the Rust crate computed for that order. The vectors are not published
//     (scripts/ops/sync-open.py PRIVATE_PATHS): in the public copy, and only there, the tests that need them are skipped;
//   - test/fixtures/avl-random.json, digests computed by ergo_avltree_rust as upstream Basis vendors it (the crate tracker
//     v4.4 builds its tree with; basis/avl-fixtures): cases generated from seeds by splitmix64, inserted in ascending
//     key order, in random order and with keys inserted again; debt keys in erg and token denominations; explicit rows;
//     the empty tree;
//   - and what digest() refuses: two rows with one debt key, malformed public keys and denominations, totals outside
//     [0, 2^64) or in an ambiguous form. Shuffled input gives the same digest; tampered input another (the 150 explicit
//     rows of avl-random.json, and a live vector);
//   - a refusal is an AvlError, not a PilotError: one that a route lets through is logged and answered 502 by
//     lib/http.mjs, never as the requester's 400 invalid_field;
//   - a total above 2^53 - 1 read from the tracker (lib/basis.mjs allNotes): exact: true gives the digest of the total
//     the tracker wrote; the Number JSON.parse makes of it is refused, and String() or BigInt() of that Number is
//     accepted with another digest, which is why digest() needs the digits.
// Run: node --test test/avl.unit.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AvlError, debtKey, digest, insertDigest} from '../lib/avl.mjs';
import {Basis, BasisError} from '../lib/basis.mjs';
import {createHandler} from '../lib/http.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = f => JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8'));
const RANDOM = read('avl-random.json');
// The live vectors stay in this repository: scripts/ops/sync-open.py leaves test/fixtures/anchor-vectors out of the
// public copy (valun-open server/, which its .synced-from marks), dated snapshots of every testnet note being the owner's
// call to publish. There the tests that need them are skipped; anywhere else a missing vector fails.
const PUBLIC_COPY = fs.existsSync(path.join(fixtures, '..', '..', '.synced-from')) && !fs.existsSync(path.join(fixtures, 'anchor-vectors'));
const NO_VECTORS = PUBLIC_COPY && 'the live anchor vectors are not in the public copy';
const VECTORS = PUBLIC_COPY ? [] : ['644995', '645135', '645189'].map(h => read(`anchor-vectors/${h}.json`));
// The digests R5 of the tracker box held at each height (Ergo testnet, read on 2026-11-14), written here as well, so
// that an edit of a fixture cannot move them.
const LIVE = [
  [644995, 250, 'da212e4773a6894d0cd2131551ae58e315943282f27400efd5fbb23e1e2d772808'],
  [645135, 251, '0d60d54d9871d4ecfc1d9eb1dbaf69a2eef75730b92425b24b6ab00104fe7aa508'],
  [645189, 251, '237616c865b69edef051b6b1edc3adf4072bf4d602cc174561fbc74fe8ec64e708'],
];
const EMPTY_TREE = '4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900';   // the crate's own unit test
// Rows with the digest the Rust crate gives them in debt-key order: the 150 explicit rows of avl-random.json (erg and
// three tokens, ten zero totals, totals up to 2^64 - 1), always here, and the live vectors where they are.
const EXPLICIT = RANDOM.rows_cases.find(c => c.rows.length === 150);
const SETS = [{name: 'the 150 explicit rows', rows: EXPLICIT.rows, expected: EXPLICIT.debt_key_order},
  ...VECTORS.map(v => ({name: `height ${v.height}`, rows: v.rows, expected: v.r5_digest}))];

const hex = b => Buffer.from(b).toString('hex');
const u64 = t => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, t); return b; };
const entriesOf = rows => rows.map(r => ({key: debtKey(r.issuer_pubkey, r.recipient_pubkey, r.denomination), value: u64(BigInt(r.total))}));
const refused = (fn, field, what) => assert.throws(fn, e => e instanceof AvlError && e.name === 'AvlError' && e.code === 'invalid_field' && e.message.includes(field), what);

// The fixtures' generator, as avl-random.json states it ("prng", "entry", "orders") and basis/avl-fixtures/src/main.rs
// draws it: splitmix64 over u64 (BigInt, reduced mod 2^64).
const M64 = (1n << 64n) - 1n, P53 = 1n << 53n, P63 = 1n << 63n;
function splitmix64(seed) {
  let state = seed;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & M64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  };
}
function drawKey(next) {
  const k = new Uint8Array(32), view = new DataView(k.buffer);
  for (let i = 0; i < 4; i++) view.setBigUint64(8 * i, next());
  return k;
}
function drawValue(next) {
  switch (Number(next() % 10n)) {
    case 0: return 0n;
    case 1: return next() % 256n;
    case 2: return next() % (1n << 32n);
    case 3: return P53 - 3n + next() % 7n;
    case 4: return P53 + next() % P53;
    case 5: return P63 - 3n + next() % 7n;
    case 6: return M64 - next() % 4n;
    case 7: return M64;
    default: return next();
  }
}
const SENTINELS = new Set(['00'.repeat(32), 'ff'.repeat(32)]);
function caseEntries(seedHex, n, order) {
  const next = splitmix64(BigInt(`0x${seedHex}`)), out = [], seen = new Set();
  for (let i = 0; i < n; i++) {
    let key;
    if (order === 'repeats' && i > 0 && next() % 4n === 0n) key = out[Number(next() % BigInt(i))].key;
    else do key = drawKey(next); while (SENTINELS.has(hex(key)) || seen.has(hex(key)));
    seen.add(hex(key));
    out.push({key, value: u64(drawValue(next))});
  }
  if (order === 'ascending') out.sort((a, b) => Buffer.compare(a.key, b.key));
  return out;
}
// Fisher-Yates with a seeded generator: a different, repeatable order each call.
function shuffled(rows, next) {
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Number(next() % BigInt(i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('three live anchors: the published notes, in debt-key order, give R5 of the one unspent tracker box', {skip: NO_VECTORS}, () => {
  assert.deepEqual(VECTORS.map(v => [v.height, v.rows.length, v.r5_digest]), LIVE);
  for (const v of VECTORS) {
    assert.equal(v.r5, `64${v.r5_digest}032000`, 'R5 is an AvlTree constant: the digest, flags 03, key length 32, no value length');
    for (const r of v.rows) assert.deepEqual(Object.keys(r), ['issuer_pubkey', 'recipient_pubkey', 'denomination', 'total'], 'no handles, no participant ids');
    assert.equal(digest(v.rows), v.r5_digest, `height ${v.height}`);
    assert.equal(digest(v.rows.map(({denomination, ...r}) => r)), v.r5_digest, 'denomination erg when absent, as in GET /ledger rows');
    assert.equal(digest(v.rows).slice(64), '08', 'the last byte is the height: 8 for some 250 notes');
  }
});

test('timestamp order, the rows as listed, gives the other digest the Rust crate computed for it; digest() never takes it', {skip: NO_VECTORS}, () => {
  for (const v of VECTORS) {
    assert.notEqual(v.timestamp_order_digest, v.r5_digest);
    assert.equal(insertDigest(entriesOf(v.rows)), v.timestamp_order_digest, `height ${v.height}: inserted as listed`);
    assert.equal(digest(v.rows), v.r5_digest, `height ${v.height}: the same rows, sorted by debt key inside digest()`);
  }
});

test('the order rows come in never changes the digest (shuffled, reversed, by total), and the rows are not changed', () => {
  const next = splitmix64(62n);
  for (const {name, rows, expected} of SETS) {
    const before = JSON.stringify(rows);
    for (let k = 0; k < 4; k++) assert.equal(digest(shuffled(rows, next)), expected, `${name}, shuffle ${k}`);
    assert.equal(digest([...rows].reverse()), expected, name);
    assert.equal(digest([...rows].sort((a, b) => (BigInt(a.total) > BigInt(b.total)) - (BigInt(a.total) < BigInt(b.total)))), expected, name);
    assert.equal(JSON.stringify(rows), before);
  }
});

test('tampering changes the digest: any total moved by 1, any dropped row, a fabricated row (also of total 0), swapped totals', () => {
  const moved = t => String(t === M64 ? t - 1n : t + 1n);   // + 1, or - 1 at 2^64 - 1 (2^64 is refused)
  const stranger = `02${'ab'.repeat(32)}`, token = `token:${'cd'.repeat(32)}`;
  for (const {name, rows, expected} of SETS.slice(0, 2)) {   // the explicit rows and the first live vector
    for (let i = 0; i < rows.length; i++) {
      assert.notEqual(digest(rows.map((r, j) => (j === i ? {...r, total: moved(BigInt(r.total))} : r))), expected, `${name}: row ${i} moved by 1`);
      assert.notEqual(digest(rows.filter((_, j) => j !== i)), expected, `${name}: row ${i} dropped`);
    }
    assert.ok(rows.some(r => r.total === '0'), `${name} has zero totals: each is a leaf`);
    assert.ok(!rows.some(r => r.issuer_pubkey === stranger || r.denomination === token), 'the stranger and the token are new');
    for (const total of ['0', '1', '1500000']) {
      assert.notEqual(digest([...rows, {issuer_pubkey: stranger, recipient_pubkey: rows[0].recipient_pubkey, denomination: 'erg', total}]), expected, `${name}: fabricated ${total}`);
    }
    const [i, j] = [rows.findIndex(r => r.total !== rows[0].total), 0];
    const swapped = rows.map((r, k) => (k === i ? {...r, total: rows[j].total} : k === j ? {...r, total: rows[i].total} : r));
    assert.notEqual(digest(swapped), expected, `${name}: two totals swapped`);
    assert.notEqual(digest(rows.map((r, k) => (k === 3 ? {...r, denomination: token} : r))), expected, `${name}: a note moved to another denomination`);
    const lone = rows.findIndex(r => !rows.some(s => s.issuer_pubkey === r.recipient_pubkey && s.recipient_pubkey === r.issuer_pubkey));
    const reversed = rows.map((r, k) => (k === lone ? {...r, issuer_pubkey: r.recipient_pubkey, recipient_pubkey: r.issuer_pubkey} : r));
    assert.notEqual(digest(reversed), expected, `${name}: a note turned around (the recipient owing)`);
  }
});

for (const order of ['ascending', 'random', 'repeats']) {
  test(`every random fixture inserted ${order === 'ascending' ? 'in ascending key order' : order === 'random' ? 'in random order' : 'with keys inserted again'}: the digest ergo_avltree_rust computed`, () => {
    const cases = RANDOM.cases.filter(c => c.order === order);
    const values = {zero: 0, small: 0, above_2_53: 0, max: 0};
    for (const c of cases) {
      const entries = caseEntries(c.seed, c.n, order);
      assert.equal(entries.length, c.n);
      assert.equal(insertDigest(entries), c.digest, `${order} seed ${c.seed} n ${c.n}`);
      for (const {value} of entries) {
        const t = new DataView(value.buffer).getBigUint64(0);
        if (t === 0n) values.zero++; else if (t < 1000n) values.small++;
        if (t > P53) values.above_2_53++;
        if (t === M64) values.max++;
      }
    }
    assert.ok(cases.length >= {ascending: 1000, random: 200, repeats: 100}[order], `${cases.length} cases`);
    assert.deepEqual([Math.min(...cases.map(c => c.n)), Math.max(...cases.map(c => c.n))], [0, 600]);
    for (const [k, count] of Object.entries(values)) assert.ok(count > 0, `values ${k}: ${count}`);
  });
}

test('the generator is the Rust one: splitmix64 outputs, and one case\'s entries in each order', () => {
  for (const {seed, outputs} of RANDOM.prng_vectors) {
    const next = splitmix64(BigInt(`0x${seed}`));
    assert.deepEqual(outputs.map(() => next().toString(16).padStart(16, '0')), outputs, `seed ${seed}`);
  }
  for (const v of RANDOM.entry_vectors) {
    const entries = caseEntries(v.seed, v.n, v.order);
    assert.deepEqual(entries.map(e => [hex(e.key), hex(e.value)]), v.entries, v.order);
    assert.equal(insertDigest(entries), v.digest, v.order);
  }
  const repeats = RANDOM.entry_vectors.find(v => v.order === 'repeats');
  assert.ok(new Set(repeats.entries.map(e => e[0])).size < repeats.n, 'the repeats vector inserts a key again');
});

test('debt keys: blake2b256(issuer || recipient || token id), as the Rust crates compute them; erg when not given', () => {
  for (const c of RANDOM.debt_keys) assert.equal(hex(debtKey(c.issuer_pubkey, c.recipient_pubkey, c.denomination)), c.debt_key, JSON.stringify(c));
  const [a, b] = [RANDOM.debt_keys[0].issuer_pubkey, RANDOM.debt_keys[0].recipient_pubkey];
  assert.deepEqual(debtKey(a, b), debtKey(a, b, 'erg'));
  assert.equal(debtKey(a, b).length, 32);
  assert.equal(new Set(RANDOM.debt_keys.slice(0, 4).map(c => c.debt_key)).size, 4, 'erg, two tokens and the swapped pair: four keys');
});

test('rows with token denominations and totals up to 2^64 - 1 give the Rust digests, in debt-key order and as listed', () => {
  assert.ok(RANDOM.rows_cases.some(c => c.rows.some(r => r.denomination.startsWith('token:'))));
  assert.ok(RANDOM.rows_cases.some(c => c.rows.some(r => r.total === '18446744073709551615')));
  for (const c of RANDOM.rows_cases) {
    assert.equal(digest(c.rows), c.debt_key_order, `${c.rows.length} rows`);
    assert.equal(digest(c.rows.map(r => ({...r, total: BigInt(r.total)}))), c.debt_key_order, 'totals as BigInt');
    assert.equal(insertDigest(entriesOf(c.rows)), c.given_order, `${c.rows.length} rows as listed`);
  }
});

test('two rows with one debt key are refused, whatever their totals; the same pair in another denomination is another note', () => {
  const rows = EXPLICIT.rows, at = rows.findIndex((x, i) => i >= 5 && x.denomination === 'erg'), r = rows[at];
  assert.throws(() => digest([...rows, r]), e => e instanceof AvlError && e.extra.row === rows.length && e.extra.duplicate_of === at && e.message.includes(`debt key of rows[${at}]`));
  refused(() => digest([...rows, {...rows[3], total: '1'}]), `debt key of rows[3]`, 'a token note twice');
  refused(() => digest([r, {...r, total: '1'}]), 'debt key', 'another total');
  refused(() => digest([{issuer_pubkey: r.issuer_pubkey, recipient_pubkey: r.recipient_pubkey, total: 7}, r]), 'debt key', 'erg by default and erg named');
  const token = {...r, denomination: `token:${'ab'.repeat(32)}`};
  assert.notEqual(digest([r, token]), digest([r]));
  assert.notEqual(digest([r, token]), digest([token]));
});

test('malformed public keys, denominations and rows are refused', () => {
  const r = EXPLICIT.rows[0], k = r.issuer_pubkey;
  const badKeys = [k.toUpperCase(), k.slice(0, 64), `${k}00`, `04${k.slice(2)}`, `00${k.slice(2)}`, ` ${k.slice(1)}`, `${k.slice(0, 65)}g`, '', undefined, null, 2, Buffer.from(k, 'hex')];
  assert.notEqual(k.toUpperCase(), k);
  for (const bad of badKeys) {
    refused(() => digest([{...r, issuer_pubkey: bad}]), 'rows[0].issuer_pubkey', String(bad));
    refused(() => digest([r, {...r, recipient_pubkey: bad}]), 'rows[1].recipient_pubkey', String(bad));
    refused(() => debtKey(bad, r.recipient_pubkey), 'issuer_pubkey', String(bad));
  }
  for (const d of ['ERG', 'Erg', 'token:', `token:${'AB'.repeat(32)}`, `token:${'ab'.repeat(31)}`, `token:${'ab'.repeat(33)}`, `token:0x${'ab'.repeat(31)}`, 'usd', '', null, 0]) {
    refused(() => digest([{...r, denomination: d}]), 'denomination', String(d));
    refused(() => debtKey(r.issuer_pubkey, r.recipient_pubkey, d), 'denomination', String(d));
  }
  for (const rowsArg of [null, undefined, {}, 'rows', 5]) refused(() => digest(rowsArg), 'rows', String(rowsArg));
  for (const row of [null, 5, 'row']) refused(() => digest([r, row]), 'rows[1]', String(row));
  const extra = EXPLICIT.rows.map(x => ({...x, issuer: 'vp_000000000000', issuer_handle: 'someone', timestamp: 1, redeemed: 1}));
  assert.equal(digest(extra), EXPLICIT.debt_key_order, 'other fields of a row are ignored');
});

test('totals outside [0, 2^64), unsafe numbers and ambiguous strings are refused; the bounds count in every accepted form', () => {
  const r = EXPLICIT.rows[0], one = total => digest([{...r, total}]);
  const bad = ['18446744073709551616', '99999999999999999999', '100000000000000000000', '-1', '-0', '+1', ' 1', '1 ', '01', '00', '1e6', '0x10', '1.5', '1_000', '',
    2 ** 53, 2 ** 64, -1, 1.5, NaN, Infinity, -Infinity, -1n, 1n << 64n, null, undefined, true, {}, [1]];
  for (const total of bad) refused(() => one(total), 'rows[0].total', `${typeof total} ${String(total)}`);
  assert.equal(one('18446744073709551615'), one((1n << 64n) - 1n));
  assert.equal(one('9007199254740991'), one(Number.MAX_SAFE_INTEGER));
  assert.equal(one('9007199254740991'), one(9007199254740991n));
  assert.equal(one('0'), one(0));
  assert.equal(one('0'), one(0n));
  assert.equal(one('0'), one(-0));
  assert.notEqual(one('9007199254740992'), one('9007199254740993'), 'above 2^53 every total stays exact');
  assert.notEqual(one('18446744073709551614'), one('18446744073709551615'));
});

test('a total above 2^53 - 1 read from the tracker: exact with allNotes({exact: true}); the rounded Number is refused, and a string or BigInt of it gives another digest', async t => {
  const issuer = `02${'aa'.repeat(32)}`, recipient = `03${'bb'.repeat(32)}`, digits = '9007199254740993';   // 2^53 + 1
  // GET /notes as the tracker writes it (basis_server SerializableIouNoteWithAge and NoteConfirmationSummary), the
  // note's amounts as `amount`.
  const answer = amount => `{"success":true,"data":[{"issuer_pubkey":"${issuer}","recipient_pubkey":"${recipient}","amount_collected":${amount},`
    + `"amount_redeemed":0,"timestamp":1763150000000,"signature":"${'11'.repeat(65)}","tracker_nft_id":"${'00'.repeat(32)}","age_seconds":5,`
    + `"denomination":"erg","confirmation":{"status":"confirmed","confirmed_total_debt":${amount},"pending_total_debt":null,`
    + `"confirmed_box_id":"${'22'.repeat(32)}","confirmed_height":645189,"pending_tx_id":null,"redeemable":true,"redeemable_amount":${amount}}}],"error":null}`;
  const tracker = text => new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: '00'.repeat(32), runSigner: null, fetchImpl: async () => new Response(text, {status: 200})});
  const row = (n, total) => ({issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, denomination: n.denomination, total});
  const want = digest([{issuer_pubkey: issuer, recipient_pubkey: recipient, total: digits}]);
  assert.equal(want, insertDigest([{key: debtKey(issuer, recipient), value: u64(P53 + 1n)}]));

  // The read every caller has today: JSON.parse rounds the amount, the guard refuses the Number, and nothing can see
  // the rounding once the Number is a string or a BigInt.
  const [lossy] = await tracker(answer(digits)).allNotes();
  assert.equal(lossy.amount_collected, 2 ** 53, 'JSON.parse read 2^53 + 1 as 2^53');
  refused(() => digest([row(lossy, lossy.amount_collected)]), 'rows[0].total', 'the rounded Number');
  refused(() => digest([row(lossy, lossy.confirmation.confirmed_total_debt)]), 'rows[0].total', 'the rounded Number');
  assert.notEqual(digest([row(lossy, String(lossy.amount_collected))]), want, 'String() of it: accepted, a total the tracker never held');
  assert.notEqual(digest([row(lossy, BigInt(lossy.amount_collected))]), want, 'BigInt() of it: the same');

  // exact: true: every amount is the digits the tracker wrote; other numbers are as JSON.parse reads them.
  const [n] = await tracker(answer(digits)).allNotes({exact: true});
  assert.deepEqual([n.amount_collected, n.confirmation.confirmed_total_debt, n.confirmation.redeemable_amount, n.amount_redeemed], [digits, digits, digits, '0']);
  assert.deepEqual([n.confirmation.pending_total_debt, n.timestamp, n.age_seconds, n.confirmation.confirmed_height], [null, 1763150000000, 5, 645189]);
  assert.equal(digest([row(n, n.amount_collected)]), want);
  assert.equal(digest([row(n, n.confirmation.confirmed_total_debt)]), want);
  const [m] = await tracker(answer('18446744073709551615')).allNotes({exact: true});
  assert.equal(digest([row(m, m.amount_collected)]), digest([row(m, M64)]), '2^64 - 1');
  const [small] = await tracker(answer('12000000')).allNotes(), [smallExact] = await tracker(answer('12000000')).allNotes({exact: true});
  assert.equal(digest([row(small, small.amount_collected)]), digest([row(smallExact, smallExact.amount_collected)]), 'up to 2^53 - 1 both reads give one digest');

  // It fails closed: an amount not in plain digits, or a runtime whose JSON.parse gives no source text, is refused.
  for (const odd of ['1e3', '1.5', '-1', '9007199254740993.0', '0.0']) {
    await assert.rejects(tracker(answer(odd)).allNotes({exact: true}), e => e instanceof BasisError && /not a whole number in plain digits/.test(e.message), odd);
  }
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, reviver) => parse(text, reviver && ((key, value) => reviver(key, value))));
  await assert.rejects(tracker(answer(digits)).allNotes({exact: true}), e => e instanceof BasisError && /gives no source text/.test(e.message));
  assert.equal((await tracker(answer(digits)).allNotes())[0].amount_collected, 2 ** 53, 'the default read is unchanged');
});

test('a refusal is an AvlError, not a PilotError: one that a route lets through is logged and answered 502, never as the requester\'s 400', async t => {
  const bad = [{...EXPLICIT.rows[0], total: 2 ** 53}];
  let refusal = null;
  try { digest(bad); } catch (e) { refusal = e; }
  assert.ok(refusal instanceof AvlError && refusal instanceof Error);
  assert.deepEqual([refusal.name, refusal.code, refusal.extra, refusal.status], ['AvlError', 'invalid_field', {row: 0}, undefined]);
  assert.throws(() => debtKey('02', EXPLICIT.rows[0].recipient_pubkey), AvlError);
  assert.throws(() => insertDigest([{key: new Uint8Array(32), value: new Uint8Array(0)}]), AvlError);
  // A GET whose handler digests rows the server holds and lets the refusal through (GET /ledger/committed must catch it
  // and answer consistent false; this pins what happens if one does not).
  const logged = [];
  t.mock.method(console, 'error', line => logged.push(line));
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public', pilotRoutes: async () => digest(bad)}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/pilot/v1/ledger/committed`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {error: 'internal error'}, 'no invalid_field, no row');
  } finally { server.close(); }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /GET \/pilot\/v1\/ledger\/committed: rows\[0\]\.total must be a whole number/);
});

test('the empty ledger gives the empty tree\'s digest, as the Rust crate computes it', () => {
  assert.equal(RANDOM.empty_digest, EMPTY_TREE);
  assert.equal(digest([]), EMPTY_TREE);
  assert.equal(insertDigest([]), EMPTY_TREE);
});

test('insertDigest refuses the keys the crate refuses; an Insert of a key present replaces its value; values are hashed as they are', () => {
  const value = u64(5n), k = new Uint8Array(32).fill(7);
  const badKeys = [new Uint8Array(32), new Uint8Array(32).fill(0xff), new Uint8Array(31).fill(1), new Uint8Array(33).fill(1), Array(32).fill(1), 'ab'.repeat(32), null];
  for (const key of badKeys) refused(() => insertDigest([{key, value}]), 'entries[0].key', String(key));
  refused(() => insertDigest([{key: k, value: [0, 0, 0, 0, 0, 0, 0, 5]}]), 'entries[0].value', 'an Array is not bytes');
  refused(() => insertDigest([null]), 'entries[0]', 'null entry');
  refused(() => insertDigest({}), 'entries', 'not an array');
  const low = new Uint8Array(32), high = new Uint8Array(32).fill(0xff);
  low[31] = 1; high[31] = 0xfe;
  assert.match(insertDigest([{key: low, value}, {key: high, value}]), /^[0-9a-f]{64}02$/, 'the keys next to the sentinels are fine');
  assert.equal(insertDigest([{key: k, value: u64(1n)}, {key: k, value: u64(2n)}]), insertDigest([{key: k, value: u64(2n)}]));
  assert.notEqual(insertDigest([{key: k, value: new Uint8Array(0)}]), insertDigest([{key: k, value: new Uint8Array(8)}]));
});
