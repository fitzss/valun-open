// The AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62), recomputed from its notes: R5 of the tracker box
// commits it, so anyone who has the notes can check the box against them. Pure: no I/O, no clock and no imports, so the
// same file runs in Node, in a browser and in an auditor's script.
//
// The construction is the one tracker v4.4 builds its note tree with (TR-19, lib/pilot/pins.mjs): the crate
// ergo_avltree_rust 0.1.1 as upstream Basis vendors it (temp/vendors/ergo_avltree_rust). This file ports its insert path
// (batch_node.rs, authenticated_tree_ops.rs, batch_avl_prover.rs) and nothing else: no lookup, removal or proof.
//   - key: the note's debt key, blake2b256(issuer public key (33 bytes) || recipient public key (33 bytes) || the token
//     id (32 bytes) when the denomination is token:<id>, nothing for erg) (upstream basis_core DenomKey::debt_key);
//   - value: the note's total (amount_collected), a u64, as 8 big-endian bytes;
//   - tree: an empty BatchAVLProver over AVLTree::new(resolver, key length 32, value length None), then one Insert per
//     note in ascending debt-key byte order. The tracker rebuilds its live tree that way after every write, so its digest
//     depends only on the set of (key, value) pairs. The shape of an AVL+ tree, and so its digest, depends on the order
//     of the inserts: digest() sorts the notes itself and never takes the order it is given;
//   - digest: the root's label (32 bytes) || the tree's height (1 byte). The box's R5 holds it as an AvlTree constant:
//     0x64 || these 33 bytes || flags 0x03 || key length 0x20 || 0x00 (no fixed value length).
//
// The tree (an AVL+ tree, https://eprint.iacr.org/2016/994), as the crate builds it:
//   - Leaves hold (key, value, next-leaf key), in key order, each leaf's next-leaf key the key of the leaf after it. An
//     empty tree is one sentinel leaf: key 32 zero bytes, an empty value, next-leaf key 32 0xff bytes. A key equal to a
//     sentinel key, or not 32 bytes long, is refused, as the crate refuses it (return_result_of_one_operation).
//   - An internal node holds the smallest key of its right subtree, two children and its balance: the right subtree's
//     height minus the left's, -1, 0 or 1. A leaf's height is 0; the tree's height is its root's.
//   - Labels: a leaf's is blake2b256(0x00 || key || value || next-leaf key), the value's bytes as they are (the length
//     prefix of a variable-length value is only in packed nodes and proofs); an internal node's is blake2b256(0x01 ||
//     balance as one byte (-1 is 0xff) || left child's label || right child's label).
//   - Insert of key k with value v goes down from the root: at an internal node with key j, left if k < j, right if
//     k > j; if k = j, right, and from there left at every node (k is the smallest key below). At the leaf: if k was met
//     on the way down, the leaf is k's and its value becomes v (the crate's Insert replaces the value of a key already
//     present, operation.rs: "AvlTree.insert updates an existing key"); otherwise the leaf (a, value, b) with a < k < b
//     becomes an internal node with key k and balance 0 over the leaves (a, value, k) and (k, v, b), one level taller.
//     On the way back up each node takes its new child. Where the child grew on the node's taller side, the node is
//     rotated, as modify_helper rotates it: once if the child leans the same way, twice (about the grandchild on the
//     inner side) otherwise, and the subtree is as tall as before the insert. Where the child grew otherwise, the
//     node's balance moves one step towards it, and the node grew too if it was balanced.
// The crate changes nodes in place where it may and caches labels; neither changes the result (the fixtures check it
// three ways, test/fixtures/avl-random.json "checked"). Here every change makes new nodes and labels are computed once,
// at the end.
//
// Refused input throws an AvlError (exported; defined here, so that this file imports nothing): code invalid_field, a
// plain-language message naming the row (or entry) and the field, and `extra` ({row}, {row, duplicate_of} or {entry}).
// A refusal says the rows cannot be digested as the tracker digests its notes, so nothing can be compared with R5: a
// caller checking data it did not take from its requester (the server's own tracker reads, an auditor's reads of the
// server and the chain) catches it and reports the check as failed, with the message, never as passed. It is not a
// PilotError, on purpose: one that a route lets through reaches lib/http.mjs as an unknown error, which is logged and
// answered 502, not as a 400 invalid_field that blames the requester and is not logged. A route that digests rows a
// client sent answers a refusal as that client's 400 itself.

// ---------------------------------------------------------------------------------------------------------------------
// BLAKE2b, copied from valun-open js/src/blake2b.js (the same project's JavaScript client, commit 716d01d), unchanged
// apart from the exports and the one-shot blake2b(), left out. node:crypto has BLAKE2b only with a 64-byte digest
// (blake2b512), and BLAKE2b-256 is not a truncation of it.

// BLAKE2b (RFC 7693) in plain JavaScript: digest length 1..64 bytes set in the parameter block, optional key (0..64
// bytes). 64-bit words are held as (low, high) pairs of 32-bit integers in Uint32Arrays, as in the RFC's reference
// structure. BLAKE2b-256 here is BLAKE2b with digest length 32, which is NOT the first 32 bytes of BLAKE2b-512.

// Initialisation vector, as (low, high) 32-bit halves of the eight 64-bit words.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// v[a] += v[b]   (64-bit, word indices are pair offsets)
function add64(v, a, b) {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

// v[a] += (lo, hi)
function add64c(v, a, lo, hi) {
  const l = v[a] + lo;
  v[a + 1] = v[a + 1] + hi + (l >= 0x100000000 ? 1 : 0);
  v[a] = l;
}

function mix(v, m, a, b, c, d, x, y) {
  add64(v, a, b);
  add64c(v, a, m[x], m[x + 1]);
  // v[d] = (v[d] ^ v[a]) >>> 32
  let lo = v[d] ^ v[a], hi = v[d + 1] ^ v[a + 1];
  v[d] = hi; v[d + 1] = lo;
  add64(v, c, d);
  // v[b] = (v[b] ^ v[c]) >>> 24
  lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
  v[b] = (lo >>> 24) | (hi << 8); v[b + 1] = (hi >>> 24) | (lo << 8);
  add64(v, a, b);
  add64c(v, a, m[y], m[y + 1]);
  // v[d] = (v[d] ^ v[a]) >>> 16
  lo = v[d] ^ v[a]; hi = v[d + 1] ^ v[a + 1];
  v[d] = (lo >>> 16) | (hi << 16); v[d + 1] = (hi >>> 16) | (lo << 16);
  add64(v, c, d);
  // v[b] = (v[b] ^ v[c]) >>> 63  (= rotate left by 1)
  lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
  v[b] = (hi >>> 31) | (lo << 1); v[b + 1] = (lo >>> 31) | (hi << 1);
}

function compress(ctx, last) {
  const {h, v, m, b} = ctx;
  for (let i = 0; i < 16; i++) { v[i] = h[i]; v[i + 16] = IV[i]; }
  // t is a byte counter < 2^53 (the 128-bit counter's high 64 bits stay 0)
  v[24] ^= ctx.t >>> 0;
  v[25] ^= Math.floor(ctx.t / 0x100000000);
  if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
  for (let i = 0; i < 32; i++) m[i] = b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24);
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    mix(v, m, 0, 8, 16, 24, s[0] * 2, s[1] * 2);
    mix(v, m, 2, 10, 18, 26, s[2] * 2, s[3] * 2);
    mix(v, m, 4, 12, 20, 28, s[4] * 2, s[5] * 2);
    mix(v, m, 6, 14, 22, 30, s[6] * 2, s[7] * 2);
    mix(v, m, 0, 10, 20, 30, s[8] * 2, s[9] * 2);
    mix(v, m, 2, 12, 22, 24, s[10] * 2, s[11] * 2);
    mix(v, m, 4, 14, 16, 26, s[12] * 2, s[13] * 2);
    mix(v, m, 6, 8, 18, 28, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

/** Incremental BLAKE2b. `outLen` 1..64, optional `key` (Uint8Array, 0..64 bytes). */
class Blake2b {
  constructor(outLen = 64, key = undefined) {
    const keyLen = key ? key.length : 0;
    if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('BLAKE2b digest length must be 1..64');
    if (keyLen > 64) throw new RangeError('BLAKE2b key must be at most 64 bytes');
    this.outLen = outLen;
    this.h = new Uint32Array(IV);
    this.h[0] ^= 0x01010000 ^ (keyLen << 8) ^ outLen;   // parameter block: digest length, key length, fanout 1, depth 1
    this.v = new Uint32Array(32);
    this.m = new Uint32Array(32);
    this.b = new Uint8Array(128);
    this.c = 0;
    this.t = 0;
    this.done = false;
    if (keyLen > 0) {
      this.update(key);
      this.c = 128;   // the key block is always a full (zero-padded) block
    }
  }

  update(data) {
    if (this.done) throw new Error('BLAKE2b: update after digest');
    for (let i = 0; i < data.length; i++) {
      if (this.c === 128) {
        this.t += 128;
        compress(this, false);
        this.c = 0;
      }
      this.b[this.c++] = data[i];
    }
    return this;
  }

  digest() {
    if (this.done) throw new Error('BLAKE2b: digest called twice');
    this.done = true;
    this.t += this.c;
    this.b.fill(0, this.c);
    compress(this, true);
    const out = new Uint8Array(this.outLen);
    for (let i = 0; i < this.outLen; i++) out[i] = this.h[i >> 2] >>> (8 * (i & 3));
    return out;
  }
}

/** BLAKE2b-256 (digest length 32, unkeyed) over the concatenation of the byte arrays given. */
function blake2b256(...parts) {
  const h = new Blake2b(32);
  for (const p of parts) h.update(p);
  return h.digest();
}

// ---------------------------------------------------------------------------------------------------------------------
// The tree.

const KEY_LENGTH = 32;
const NEGATIVE_INFINITY = new Uint8Array(KEY_LENGTH), POSITIVE_INFINITY = new Uint8Array(KEY_LENGTH).fill(0xff);
const LEAF_PREFIX = Uint8Array.of(0), INTERNAL_PREFIX = Uint8Array.of(1);

const leaf = (key, value, next) => ({leaf: true, key, value, next, label: null});
const internal = (key, left, right, balance) => ({leaf: false, key, left, right, balance, label: null});

// Unsigned lexicographic order of byte strings, then the shorter first (Rust's order of byte slices, the crate's).
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// The crate's next_direction_is_left with its `found` flag: once the key equals a node's key on the way down, the
// search goes right there and left everywhere below, to the leftmost leaf of that right subtree (the key's leaf).
function nextIsLeft(key, node, s) {
  if (s.found) return true;
  const c = compareBytes(key, node.key);
  if (c === 0) { s.found = true; return false; }
  return c < 0;
}

// The balances of the two children after a double rotation about a grandchild whose balance was b (the crate's
// double_left_rotate and double_right_rotate); the grandchild, the new root of the subtree, takes balance 0.
function doubleRotationBalances(b) {
  if (b === 0) return [0, 0];
  if (b === -1) return [0, 1];
  if (b === 1) return [-1, 0];
  throw new Error(`AVL+ insert: invalid balance ${b}`);   // the crate panics: unreachable for a tree built by inserts
}

// One Insert of (key, value) into the subtree at node: the crate's modify_helper for Operation::Insert. Returns the
// subtree's new root and whether it grew taller. s.found is the crate's prover flag (key_matches_leaf reads and clears it).
function insertAt(node, key, value, s) {
  if (node.leaf) {
    const found = s.found;
    s.found = false;
    if (found) return [leaf(node.key, value, node.next), false];        // the key's own leaf: its value is replaced
    // add_node: node.key < key < node.next
    return [internal(key, leaf(node.key, node.value, key), leaf(key, value, node.next), 0), true];
  }
  if (nextIsLeft(key, node, s)) {
    const [left, grew] = insertAt(node.left, key, value, s);
    if (grew && node.balance < 0) {                                       // the left side was taller and grew: rotate
      if (left.balance < 0) return [internal(left.key, left.left, internal(node.key, left.right, node.right, 0), 0), false];
      const g = left.right, [lb, rb] = doubleRotationBalances(g.balance);   // double right rotation about g
      return [internal(g.key, internal(left.key, left.left, g.left, lb), internal(node.key, g.right, node.right, rb), 0), false];
    }
    return [internal(node.key, left, node.right, grew ? node.balance - 1 : node.balance), grew && node.balance === 0];
  }
  const [right, grew] = insertAt(node.right, key, value, s);
  if (grew && node.balance > 0) {                                         // the right side was taller and grew: rotate
    if (right.balance > 0) return [internal(right.key, internal(node.key, node.left, right.left, 0), right.right, 0), false];
    const g = right.left, [lb, rb] = doubleRotationBalances(g.balance);     // double left rotation about g
    return [internal(g.key, internal(node.key, node.left, g.left, lb), internal(right.key, g.right, right.right, rb), 0), false];
  }
  return [internal(node.key, node.left, right, grew ? node.balance + 1 : node.balance), grew && node.balance === 0];
}

function label(n) {
  if (n.label === null) {
    n.label = n.leaf ? blake2b256(LEAF_PREFIX, n.key, n.value, n.next)
      : blake2b256(INTERNAL_PREFIX, Uint8Array.of(n.balance & 0xff), label(n.left), label(n.right));
  }
  return n.label;
}

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Input digest(), debtKey() or insertDigest() refuses (the module comment says how a caller answers one). */
export class AvlError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'AvlError'; this.code = 'invalid_field'; this.extra = extra; }
}

/**
 * The digest of an empty tree after one Insert per entry, in the order given: the lower level digest() builds on.
 * entries: [{key, value}], key 32 bytes (a Uint8Array) strictly between the sentinel keys 00..00 and ff..ff, value a
 * Uint8Array of any length (hashed as it is). An Insert of a key already in the tree replaces its value (the crate's
 * insert-or-update; digest() never relies on it). Returns 66 lowercase hex characters: root label || height.
 */
export function insertDigest(entries) {
  if (!Array.isArray(entries)) throw new AvlError('entries must be an array of {key, value} byte arrays');
  let root = leaf(NEGATIVE_INFINITY, new Uint8Array(0), POSITIVE_INFINITY), height = 0;
  entries.forEach((e, i) => {
    const extra = {entry: i};
    if (e === null || typeof e !== 'object') throw new AvlError(`entries[${i}] must be {key, value}`, extra);
    const {key, value} = e;
    if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH) throw new AvlError(`entries[${i}].key must be ${KEY_LENGTH} bytes (a Uint8Array)`, extra);
    if (compareBytes(key, NEGATIVE_INFINITY) <= 0 || compareBytes(key, POSITIVE_INFINITY) >= 0) {
      throw new AvlError(`entries[${i}].key must lie strictly between the sentinel keys 00..00 and ff..ff`, extra);
    }
    if (!(value instanceof Uint8Array)) throw new AvlError(`entries[${i}].value must be bytes (a Uint8Array)`, extra);
    const [next, grew] = insertAt(root, key, value, {found: false});
    root = next;
    if (grew) height++;
  });
  if (height > 255) throw new Error('AVL+ tree height above 255');   // the crate asserts it; it needs some 2^177 leaves
  return toHex(label(root)) + height.toString(16).padStart(2, '0');
}

// ---------------------------------------------------------------------------------------------------------------------
// Notes.

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;               // a compressed public key, as lib/pilot/core.mjs KEY_RE
const DENOMINATION_RE = /^(erg|token:[0-9a-f]{64})$/;  // as lib/basis.mjs checks the pilot denomination
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;           // digits only: no sign, space or leading zero; 2^64 has 20
const U64_END = 1n << 64n;

function noteKey(issuer, recipient, denomination, where, extra) {
  for (const [field, v] of [['issuer_pubkey', issuer], ['recipient_pubkey', recipient]]) {
    if (typeof v !== 'string' || !PUBKEY_RE.test(v)) {
      throw new AvlError(`${where}${field} must be a 33-byte compressed public key: 66 lowercase hex characters starting 02 or 03`, extra);
    }
  }
  if (typeof denomination !== 'string' || !DENOMINATION_RE.test(denomination)) {
    throw new AvlError(`${where}denomination must be erg or token:<the token id, 64 lowercase hex characters>`, extra);
  }
  const parts = [hexBytes(issuer), hexBytes(recipient)];
  if (denomination !== 'erg') parts.push(hexBytes(denomination.slice('token:'.length)));
  return blake2b256(...parts);
}

// A total as the tracker stores it, a u64, as its 8 big-endian bytes. It may be a decimal string (digits only), a BigInt
// or a Number that is a safe integer, and must be in [0, 2^64). A larger Number is refused: JSON.parse reads an integer
// above 2^53 - 1 as the nearest double (9007199254740993 as 9007199254740992), so such a Number may not be the total the
// tracker wrote. A string or a BigInt is taken as it is: it cannot show a rounding done before it was made, and
// String() or BigInt() of a rounded Number is a total the tracker never held, whose digest differs from R5 with no error.
// So a total above 2^53 - 1 must be the digits the tracker wrote, never a Number made into a string or a BigInt
// (lib/basis.mjs allNotes({exact: true}) reads them so).
function totalBytes(total, where, extra) {
  let t;
  if (typeof total === 'bigint') t = total;
  else if (typeof total === 'string' && DECIMAL_RE.test(total)) t = BigInt(total);
  else if (Number.isSafeInteger(total)) t = BigInt(total);
  else throw new AvlError(`${where} must be a whole number: a decimal string of digits, a BigInt or a safe integer (a Number above 2^53 - 1 may already have been rounded: pass the digits the tracker wrote, as a string)`, extra);
  if (t < 0n || t >= U64_END) throw new AvlError(`${where} must be from 0 to 2^64 - 1 (a tracker total is a u64)`, extra);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, t);
  return out;
}

/**
 * A note's debt key, the key of its leaf: blake2b256(issuer || recipient || token id when the denomination is
 * token:<id>). issuerHex, recipientHex: 33-byte compressed public keys as lowercase hex; denomination 'erg' or
 * 'token:<64 lowercase hex>'. Returns 32 bytes (a Uint8Array).
 */
export function debtKey(issuerHex, recipientHex, denomination = 'erg') {
  return noteKey(issuerHex, recipientHex, denomination, '', {});
}

/**
 * The digest a tracker anchors for these notes: rows [{issuer_pubkey, recipient_pubkey, denomination?, total}],
 * denomination 'erg' when absent, total a decimal string, a BigInt or a safe integer in [0, 2^64). A total is taken as
 * given, so it must be exact: above 2^53 - 1, the digits the tracker wrote, never String() or BigInt() of a Number that
 * JSON.parse may have rounded (totalBytes). The rows are sorted by debt key here, whatever order they come in; two rows
 * with one debt key (one issuer, recipient and denomination) are refused, as are malformed public keys, denominations
 * and totals (AvlError). Other fields of a row are ignored. Returns 66 lowercase hex characters, the 33 bytes R5 of the
 * tracker box commits.
 */
export function digest(rows) {
  if (!Array.isArray(rows)) throw new AvlError('rows must be an array of notes {issuer_pubkey, recipient_pubkey, denomination, total}');
  const entries = rows.map((r, row) => {
    const where = `rows[${row}].`, extra = {row};
    if (r === null || typeof r !== 'object') throw new AvlError(`rows[${row}] must be a note {issuer_pubkey, recipient_pubkey, denomination, total}`, extra);
    const denomination = r.denomination === undefined ? 'erg' : r.denomination;
    return {key: noteKey(r.issuer_pubkey, r.recipient_pubkey, denomination, where, extra), value: totalBytes(r.total, `${where}total`, extra), row};
  });
  entries.sort((a, b) => compareBytes(a.key, b.key) || a.row - b.row);
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1].key, entries[i].key) === 0) {
      const first = entries[i - 1].row, again = entries[i].row;
      throw new AvlError(`rows[${again}] has the debt key of rows[${first}]: a tracker holds one note per issuer, recipient and denomination`, {row: again, duplicate_of: first});
    }
  }
  return insertDigest(entries);
}
