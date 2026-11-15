// src/avl.js, the AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62; #66 item 4: the JavaScript client's), against
// the references python/tests/test_avl.py holds python/src/valun/avl.py to, and the server's test/avl.unit.test.mjs its
// lib/avl.mjs:
//   - python/tests/fixtures/avl-random.json, shared with the Python client (byte for byte the server's
//     test/fixtures/avl-random.json): digests computed by ergo_avltree_rust as upstream Basis vendors it (the crate
//     tracker v4.4 builds its tree with): cases generated from seeds by splitmix64, inserted in ascending key order, in
//     random order and with keys inserted again; debt keys in erg and token denominations; explicit rows; the empty tree;
//   - three live anchors of the testnet tracker: the R5 digests, heights and row counts are written here (public on the
//     chain); the rows are private (valun-app scripts/ops/sync-open.py PRIVATE_PATHS), so the tests that need them read
//     the folder VALUN_ANCHOR_VECTORS names (valun-app test/fixtures/anchor-vectors) and are skipped without it;
//   - fixtures/python-parity.json "avl": what avl.py gives for 105 inputs (digests, debt keys, insertDigest, refusals with
//     their code, extra and message), value for value; the totals' type sentence names each language's types;
//   - what digest() refuses, and that order never changes a digest and tampering always does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {avl, bytesToHex, hexToBytes} from '../src/index.js';
import {PARITY as P} from './agent-world.js';

const {AvlError, KEY_LENGTH, debtKey, digest, insertDigest} = avl;
const SHARED = fileURLToPath(new URL('../../python/tests/fixtures/avl-random.json', import.meta.url));
const RANDOM = fs.existsSync(SHARED) ? JSON.parse(fs.readFileSync(SHARED, 'utf8')) : null;
const NO_SHARED = RANDOM === null && 'python/tests/fixtures is not next to js/ (published package)';
const VECTORS_DIR = process.env.VALUN_ANCHOR_VECTORS;
const NO_VECTORS = !VECTORS_DIR && 'the live anchor vectors are private: set VALUN_ANCHOR_VECTORS to valun-app test/fixtures/anchor-vectors';
// The digests R5 of the tracker box held at each height (Ergo testnet, read on 2026-11-14), and the row counts, as the
// server's and the Python client's tests write them, so that an edit of a vector cannot move them.
const LIVE = [
  [644995, 250, 'da212e4773a6894d0cd2131551ae58e315943282f27400efd5fbb23e1e2d772808'],
  [645135, 251, '0d60d54d9871d4ecfc1d9eb1dbaf69a2eef75730b92425b24b6ab00104fe7aa508'],
  [645189, 251, '237616c865b69edef051b6b1edc3adf4072bf4d602cc174561fbc74fe8ec64e708'],
];
const VECTORS = VECTORS_DIR ? LIVE.map(([h]) => JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, `${h}.json`), 'utf8'))) : [];
const EMPTY_TREE = '4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900';   // the crate's own unit test
const EXPLICIT = RANDOM?.rows_cases.find(c => c.rows.length === 150);

const u64 = t => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, t); return b; };
const entriesOf = rows => rows.map(r => ({key: debtKey(r.issuer_pubkey, r.recipient_pubkey, r.denomination), value: u64(BigInt(r.total))}));
const refused = (fn, field, what) => assert.throws(fn, e => e instanceof AvlError && e.name === 'AvlError' && e.code === 'invalid_field'
  && e.message.includes(field), what);

// The fixtures' generator, as avl-random.json states it ("prng", "entry", "orders"): splitmix64 over u64 (BigInt, mod 2^64).
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
    else do key = drawKey(next); while (SENTINELS.has(bytesToHex(key)) || seen.has(bytesToHex(key)));
    seen.add(bytesToHex(key));
    out.push({key, value: u64(drawValue(next))});
  }
  if (order === 'ascending') out.sort((a, b) => Buffer.compare(a.key, b.key));
  return out;
}
function shuffled(rows, next) {
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Number(next() % BigInt(i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

for (const order of ['ascending', 'random', 'repeats']) {
  test(`every random fixture inserted ${order === 'ascending' ? 'in ascending key order' : order === 'random' ? 'in random order'
    : 'with keys inserted again'}: the digest ergo_avltree_rust computed`, {skip: NO_SHARED}, () => {
    const cases = RANDOM.cases.filter(c => c.order === order);
    for (const c of cases) assert.equal(insertDigest(caseEntries(c.seed, c.n, order)), c.digest, `${order} seed ${c.seed} n ${c.n}`);
    assert.ok(cases.length >= {ascending: 1000, random: 200, repeats: 100}[order], `${cases.length} cases`);
    assert.deepEqual([Math.min(...cases.map(c => c.n)), Math.max(...cases.map(c => c.n))], [0, 600]);
  });
}

test('the generator is the Rust one: splitmix64 outputs, and one case\'s entries in each order', {skip: NO_SHARED}, () => {
  for (const {seed, outputs} of RANDOM.prng_vectors) {
    const next = splitmix64(BigInt(`0x${seed}`));
    assert.deepEqual(outputs.map(() => next().toString(16).padStart(16, '0')), outputs, `seed ${seed}`);
  }
  for (const v of RANDOM.entry_vectors) {
    const entries = caseEntries(v.seed, v.n, v.order);
    assert.deepEqual(entries.map(e => [bytesToHex(e.key), bytesToHex(e.value)]), v.entries, v.order);
    assert.equal(insertDigest(entries), v.digest, v.order);
  }
});

test('debt keys, token rows and totals up to 2^64 - 1 give the Rust digests, in debt-key order and as listed', {skip: NO_SHARED}, () => {
  for (const c of RANDOM.debt_keys) assert.equal(bytesToHex(debtKey(c.issuer_pubkey, c.recipient_pubkey, c.denomination)), c.debt_key);
  const [a, b] = [RANDOM.debt_keys[0].issuer_pubkey, RANDOM.debt_keys[0].recipient_pubkey];
  assert.deepEqual(debtKey(a, b), debtKey(a, b, 'erg'));
  assert.equal(debtKey(a, b).length, KEY_LENGTH);
  assert.ok(RANDOM.rows_cases.some(c => c.rows.some(r => r.total === '18446744073709551615')));
  for (const c of RANDOM.rows_cases) {
    assert.equal(digest(c.rows), c.debt_key_order, `${c.rows.length} rows`);
    assert.equal(digest(c.rows.map(r => ({...r, total: BigInt(r.total)}))), c.debt_key_order, 'totals as BigInt');
    assert.equal(insertDigest(entriesOf(c.rows)), c.given_order, `${c.rows.length} rows as listed`);
  }
  assert.equal(RANDOM.empty_digest, EMPTY_TREE);
  assert.equal(digest([]), EMPTY_TREE);
  assert.equal(insertDigest([]), EMPTY_TREE);
});

test('the order rows come in never changes the digest, the rows are not changed, and tampering always changes it', {skip: NO_SHARED}, () => {
  const next = splitmix64(62n);
  const sets = [{name: 'the 150 explicit rows', rows: EXPLICIT.rows, expected: EXPLICIT.debt_key_order},
    ...VECTORS.map(v => ({name: `height ${v.height}`, rows: v.rows, expected: v.r5_digest}))];
  for (const {name, rows, expected} of sets) {
    const before = JSON.stringify(rows);
    for (let k = 0; k < 3; k++) assert.equal(digest(shuffled(rows, next)), expected, `${name}, shuffle ${k}`);
    assert.equal(digest([...rows].reverse()), expected, name);
    assert.equal(JSON.stringify(rows), before);
  }
  const rows = EXPLICIT.rows, expected = EXPLICIT.debt_key_order;
  const moved = t => String(t === M64 ? t - 1n : t + 1n);
  for (let i = 0; i < rows.length; i++) {
    assert.notEqual(digest(rows.map((r, j) => (j === i ? {...r, total: moved(BigInt(r.total))} : r))), expected, `row ${i} moved by 1`);
    assert.notEqual(digest(rows.filter((_, j) => j !== i)), expected, `row ${i} dropped`);
  }
  for (const total of ['0', '1', '1500000']) {
    assert.notEqual(digest([...rows, {issuer_pubkey: `02${'ab'.repeat(32)}`, recipient_pubkey: rows[0].recipient_pubkey, total}]), expected);
  }
});

test('three live anchors: the published notes, in debt-key order, give R5 of the one unspent tracker box', {skip: NO_VECTORS}, () => {
  assert.deepEqual(VECTORS.map(v => [v.height, v.rows.length, v.r5_digest]), LIVE);
  for (const v of VECTORS) {
    assert.equal(v.r5, `64${v.r5_digest}032000`, 'R5 is an AvlTree constant: the digest, flags 03, key length 32, no value length');
    assert.equal(digest(v.rows), v.r5_digest, `height ${v.height}`);
    assert.equal(digest(v.rows.map(({denomination: _d, ...r}) => r)), v.r5_digest, 'denomination erg when absent, as in GET /ledger rows');
    assert.notEqual(v.timestamp_order_digest, v.r5_digest);
    assert.equal(insertDigest(entriesOf(v.rows)), v.timestamp_order_digest, `height ${v.height}: inserted as listed`);
  }
});

// avl.py names the Python types a total may come in; this file, as lib/avl.mjs, names JavaScript's. Everything else of
// a refusal is the same, word for word.
const PY_TYPES = 'an int, or a float that is a safe integer (a float above', JS_TYPES = 'a BigInt or a safe integer (a Number above';

test('python-parity.json: every digest, debt key and refusal of avl.py, value for value', () => {
  const A = P.avl;
  assert.ok(A.digest.length >= 80 && A.debt_key.length >= 10 && A.insert_digest.length >= 8, 'the generator records the avl cases');
  const outcome = fn => {
    try {
      const v = fn();
      return {value: v instanceof Uint8Array ? bytesToHex(v) : v};
    } catch (e) {
      if (!(e instanceof AvlError)) throw e;
      return {raises: 'AvlError', code: e.code, extra: e.extra, message: e.message};
    }
  };
  const want = o => (o.raises ? {...o, message: o.message.replace(PY_TYPES, JS_TYPES)} : o);
  let refusals = 0, typed = 0;
  for (const [rows, o] of A.digest) {
    assert.deepEqual(outcome(() => digest(rows)), want(o), JSON.stringify(rows)?.slice(0, 160));
    if (o.raises) refusals++;
    if (o.message?.includes(PY_TYPES)) typed++;
  }
  for (const [args, o] of A.debt_key) assert.deepEqual(outcome(() => debtKey(...args)), want(o), JSON.stringify(args));
  for (const [entries, o] of A.insert_digest) {
    const es = entries.map(e => ({key: hexToBytes(e.key), value: hexToBytes(e.value)}));
    assert.deepEqual(outcome(() => insertDigest(es)), o, JSON.stringify(entries));
  }
  assert.ok(refusals >= 50 && typed >= 20, `${refusals} refusals, ${typed} of the totals' type`);
  assert.ok(A.digest.some(([, o]) => o.extra?.duplicate_of !== undefined), 'a duplicate debt key');
});

test('what only JavaScript can be given: BigInt totals, Numbers above 2^53 - 1 refused, keys that are not Uint8Arrays', () => {
  const issuer = `02${'aa'.repeat(32)}`, recipient = `03${'bb'.repeat(32)}`, one = total => digest([{issuer_pubkey: issuer, recipient_pubkey: recipient, total}]);
  assert.equal(one(5n), one('5'));
  assert.equal(one((1n << 64n) - 1n), one('18446744073709551615'));
  for (const total of [2 ** 53, 2 ** 64, NaN, Infinity, -1n, 1n << 64n, undefined]) refused(() => one(total), 'rows[0].total', String(total));
  assert.notEqual(one('9007199254740992'), one('9007199254740993'), 'above 2^53 a string stays exact');
  const value = u64(5n);
  for (const key of [Array(32).fill(1), 'ab'.repeat(32), new Uint8Array(31).fill(1), null]) refused(() => insertDigest([{key, value}]), 'entries[0].key');
  refused(() => insertDigest([{key: new Uint8Array(32).fill(7), value: [0, 0, 0, 0, 0, 0, 0, 5]}]), 'entries[0].value', 'an Array is not bytes');
  refused(() => insertDigest({}), 'entries');
  let e = null;
  try { digest([{issuer_pubkey: issuer, recipient_pubkey: recipient, total: 2 ** 53}]); } catch (x) { e = x; }
  assert.ok(e instanceof AvlError && e instanceof Error && !('status' in e), 'an AvlError, not a ValunError');
  assert.deepEqual([e.name, e.code, e.extra], ['AvlError', 'invalid_field', {row: 0}]);
});
