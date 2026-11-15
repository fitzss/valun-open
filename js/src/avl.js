// The AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62 and #66), recomputed from its notes: R5 of the tracker
// box commits it, so anyone who has the notes can check the box against them. Pure: no I/O and no clock; it imports only
// this package's BLAKE2b and byte helpers, so it runs in Node, Deno, Bun and browsers.
//
// The port of python/src/valun/avl.py, itself the port of the server's lib/avl.mjs (valun-app, as reviewed at c965357):
// the same construction, the same digests and the same refusals, held to the same references (test/avl.test.js reads
// python/tests/fixtures/avl-random.json, and fixtures/python-parity.json records what avl.py gives for the same inputs).
// It is lib/avl.mjs with this package's blake2b256 for the copy of BLAKE2b that file carries, and so takes totals as
// JavaScript types, as there.
//
// The construction is the one tracker v4.4 builds its note tree with (TR-19): the crate ergo_avltree_rust 0.1.1 as
// upstream Basis vendors it (temp/vendors/ergo_avltree_rust). This file ports its insert path (batch_node.rs,
// authenticated_tree_ops.rs, batch_avl_prover.rs) and nothing else: no lookup, removal or proof.
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
// three ways, avl-random.json "checked"). Here every change makes new nodes and labels are computed once, at the end.
// Byte strings compare in unsigned lexicographic order, then the shorter first (Rust's order of byte slices, the crate's).
//
// Refused input throws an AvlError (exported; not a ValunError, on purpose): code invalid_field, a plain-language
// message naming the row (or entry) and the field, and `extra` ({row}, {row, duplicate_of} or {entry}). A refusal says
// the rows cannot be digested as the tracker digests its notes, so nothing can be compared with R5: a caller checking
// data it did not take from its requester (an auditor's reads of the server and the chain) catches it and reports the
// check as failed, with the message, never as passed. It is never an answer from a server about a request, and nothing
// that turns a ValunError into a tool's error payload should take it for one.

import {blake2b256} from './blake2b.js';
import {bytesToHex, hexToBytes} from './bytes.js';

/** The length of a key of the tree: a debt key, 32 bytes. */
export const KEY_LENGTH = 32;
const NEGATIVE_INFINITY = new Uint8Array(KEY_LENGTH), POSITIVE_INFINITY = new Uint8Array(KEY_LENGTH).fill(0xff);
const LEAF_PREFIX = Uint8Array.of(0), INTERNAL_PREFIX = Uint8Array.of(1);

// ---------------------------------------------------------------------------------------------------------------------
// The tree.

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
  if (c === 0) {
    s.found = true;
    return false;
  }
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

/** Input digest(), debtKey() or insertDigest() refuses (the module comment says how a caller answers one). */
export class AvlError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'AvlError';
    this.code = 'invalid_field';
    this.extra = extra;
  }
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
  return bytesToHex(label(root)) + height.toString(16).padStart(2, '0');
}

// ---------------------------------------------------------------------------------------------------------------------
// Notes.

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;               // a compressed public key, as the server's lib/pilot/core.mjs KEY_RE
const DENOMINATION_RE = /^(erg|token:[0-9a-f]{64})$/;  // as the server's lib/basis.mjs checks the pilot denomination
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
  const parts = [hexToBytes(issuer), hexToBytes(recipient)];
  if (denomination !== 'erg') parts.push(hexToBytes(denomination.slice('token:'.length)));
  return blake2b256(...parts);
}

// A total as the tracker stores it, a u64, as its 8 big-endian bytes. It may be a decimal string (digits only), a BigInt
// or a Number that is a safe integer, and must be in [0, 2^64). A larger Number is refused: JSON.parse reads an integer
// above 2^53 - 1 as the nearest double (9007199254740993 as 9007199254740992), so such a Number may not be the total the
// tracker wrote. A string or a BigInt is taken as it is: it cannot show a rounding done before it was made, and String()
// or BigInt() of a rounded Number is a total the tracker never held, whose digest differs from R5 with no error. So a
// total above 2^53 - 1 must be the digits the tracker wrote, never a Number made into a string or a BigInt. (avl.py takes
// the Python types JSON gives for these: a str of digits, an int as a BigInt, a float only when it is a safe integer.)
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
 * and totals (AvlError). Other fields of a row are ignored, and the rows are not changed. Returns 66 lowercase hex
 * characters, the 33 bytes R5 of the tracker box commits.
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
