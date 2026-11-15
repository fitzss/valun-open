"""The AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62), recomputed from its notes: R5 of the tracker box
commits it, so anyone who has the notes can check the box against them. Standard library only (hashlib.blake2b with
digest_size=32), and it imports nothing else from this package; no I/O and no clock.

A port of the server's lib/avl.mjs (valun-app, as reviewed at c965357): the same construction, the same digests and the
same refusals, checked against the same references (python/tests/test_avl.py).

The construction is the one tracker v4.4 builds its note tree with (TR-19): the crate ergo_avltree_rust 0.1.1 as
upstream Basis vendors it (temp/vendors/ergo_avltree_rust). This file ports its insert path (batch_node.rs,
authenticated_tree_ops.rs, batch_avl_prover.rs) and nothing else: no lookup, removal or proof.
  - key: the note's debt key, blake2b256(issuer public key (33 bytes) || recipient public key (33 bytes) || the token id
    (32 bytes) when the denomination is token:<id>, nothing for erg) (upstream basis_core DenomKey::debt_key);
  - value: the note's total (amount_collected), a u64, as 8 big-endian bytes;
  - tree: an empty BatchAVLProver over AVLTree::new(resolver, key length 32, value length None), then one Insert per note
    in ascending debt-key byte order. The tracker rebuilds its live tree that way after every write, so its digest
    depends only on the set of (key, value) pairs. The shape of an AVL+ tree, and so its digest, depends on the order of
    the inserts: digest() sorts the notes itself and never takes the order it is given;
  - digest: the root's label (32 bytes) || the tree's height (1 byte). The box's R5 holds it as an AvlTree constant:
    0x64 || these 33 bytes || flags 0x03 || key length 0x20 || 0x00 (no fixed value length).

The tree (an AVL+ tree, https://eprint.iacr.org/2016/994), as the crate builds it:
  - Leaves hold (key, value, next-leaf key), in key order, each leaf's next-leaf key the key of the leaf after it. An
    empty tree is one sentinel leaf: key 32 zero bytes, an empty value, next-leaf key 32 0xff bytes. A key equal to a
    sentinel key, or not 32 bytes long, is refused, as the crate refuses it (return_result_of_one_operation).
  - An internal node holds the smallest key of its right subtree, two children and its balance: the right subtree's
    height minus the left's, -1, 0 or 1. A leaf's height is 0; the tree's height is its root's.
  - Labels: a leaf's is blake2b256(0x00 || key || value || next-leaf key), the value's bytes as they are (the length
    prefix of a variable-length value is only in packed nodes and proofs); an internal node's is blake2b256(0x01 ||
    balance as one byte (-1 is 0xff) || left child's label || right child's label).
  - Insert of key k with value v goes down from the root: at an internal node with key j, left if k < j, right if k > j;
    if k = j, right, and from there left at every node (k is the smallest key below). At the leaf: if k was met on the
    way down, the leaf is k's and its value becomes v (the crate's Insert replaces the value of a key already present,
    operation.rs: "AvlTree.insert updates an existing key"); otherwise the leaf (a, value, b) with a < k < b becomes an
    internal node with key k and balance 0 over the leaves (a, value, k) and (k, v, b), one level taller. On the way
    back up each node takes its new child. Where the child grew on the node's taller side, the node is rotated, as
    modify_helper rotates it: once if the child leans the same way, twice (about the grandchild on the inner side)
    otherwise, and the subtree is as tall as before the insert. Where the child grew otherwise, the node's balance moves
    one step towards it, and the node grew too if it was balanced.
The crate changes nodes in place where it may and caches labels; neither changes the result (the fixtures check it three
ways, avl-random.json "checked"). Here every change makes new nodes and labels are computed once, at the end. Byte
strings compare as Python bytes do: unsigned lexicographic order, then the shorter first (Rust's order of byte slices,
the crate's).

Totals, as the JavaScript reference takes them, with each JavaScript type read as the Python type JSON gives:
  - a str: decimal digits only (no sign, space, leading zero or other character), as there;
  - an int (not a bool): taken as it is, as a JavaScript BigInt is. Python's json reads an integer literal exactly, so
    an int is the digits that were written; it never rounds 2^53 + 1 to 2^53 as JSON.parse does (which is why the
    JavaScript reference refuses a Number above 2^53 - 1);
  - a float: as a JavaScript Number is: taken only when it is a safe integer (whole, |x| <= 2^53 - 1; -0.0 is 0). json
    gives a float for "5.0" or "1e3", which JSON.parse reads as the Number 5 or 1000. A float above 2^53 - 1 may already
    have been rounded, so it is refused;
  - anything else is refused (a bool too, although Python counts it as an int).
Neither language can see a rounding done before the value was made: a total above 2^53 - 1 that a JavaScript server
wrote as a JSON number (the Number its own JSON.parse of the tracker's answer made) reads here as an exact int of the
rounded value, whose digest differs from R5 with no error. A caller reading such totals (valun/audit.py, from
GET /pilot/v1/ledger) refuses them itself; the committed snapshot gives totals as decimal strings.

Refused input raises AvlError (defined here, so that this file imports nothing): code invalid_field, a plain-language
message naming the row (or entry) and the field, and `extra` ({row}, {row, duplicate_of} or {entry}). A refusal says the
rows cannot be digested as the tracker digests its notes, so nothing can be compared with R5: a caller checking data it
did not take from its requester (an auditor's reads of the server and the chain) catches it and reports the check as
failed, with the message, never as passed. It is not a ValunError, on purpose: it is never an answer from a server
about a request, and nothing that turns a ValunError into a tool's error payload should take it for one.
"""
import hashlib
import re

KEY_LENGTH = 32
_NEGATIVE_INFINITY, _POSITIVE_INFINITY = bytes(KEY_LENGTH), b'\xff' * KEY_LENGTH
_LEAF_PREFIX, _INTERNAL_PREFIX = b'\x00', b'\x01'
_MISSING = object()                         # a field a row does not have (JavaScript's undefined)


def _blake2b256(*parts):
    """BLAKE2b with digest length 32 (unkeyed) over the concatenation of the byte strings given. BLAKE2b-256 is NOT the
    first 32 bytes of BLAKE2b-512: the digest length is part of the parameter block."""
    h = hashlib.blake2b(digest_size=32)
    for p in parts:
        h.update(p)
    return h.digest()


# ---------------------------------------------------------------------------------------------------------------------
# The tree.

class _Leaf:
    __slots__ = ('key', 'value', 'next', 'label')
    leaf = True

    def __init__(self, key, value, next_key):
        self.key, self.value, self.next, self.label = key, value, next_key, None


class _Internal:
    __slots__ = ('key', 'left', 'right', 'balance', 'label')
    leaf = False

    def __init__(self, key, left, right, balance):
        self.key, self.left, self.right, self.balance, self.label = key, left, right, balance, None


def _next_is_left(key, node, s):
    """The crate's next_direction_is_left with its `found` flag (s[0]): once the key equals a node's key on the way down,
    the search goes right there and left everywhere below, to the leftmost leaf of that right subtree (the key's leaf)."""
    if s[0]:
        return True
    if key == node.key:
        s[0] = True
        return False
    return key < node.key


def _double_rotation_balances(b):
    """The balances of the two children after a double rotation about a grandchild whose balance was b (the crate's
    double_left_rotate and double_right_rotate); the grandchild, the new root of the subtree, takes balance 0."""
    if b == 0:
        return 0, 0
    if b == -1:
        return 0, 1
    if b == 1:
        return -1, 0
    raise RuntimeError(f'AVL+ insert: invalid balance {b}')   # the crate panics: unreachable for a tree built by inserts


def _insert_at(node, key, value, s):
    """One Insert of (key, value) into the subtree at node: the crate's modify_helper for Operation::Insert. Returns the
    subtree's new root and whether it grew taller. s[0] is the crate's prover flag (key_matches_leaf reads and clears it)."""
    if node.leaf:
        found = s[0]
        s[0] = False
        if found:
            return _Leaf(node.key, value, node.next), False             # the key's own leaf: its value is replaced
        # add_node: node.key < key < node.next
        return _Internal(key, _Leaf(node.key, node.value, key), _Leaf(key, value, node.next), 0), True
    if _next_is_left(key, node, s):
        left, grew = _insert_at(node.left, key, value, s)
        if grew and node.balance < 0:                                   # the left side was taller and grew: rotate
            if left.balance < 0:
                return _Internal(left.key, left.left, _Internal(node.key, left.right, node.right, 0), 0), False
            g = left.right                                              # double right rotation about g
            lb, rb = _double_rotation_balances(g.balance)
            return _Internal(g.key, _Internal(left.key, left.left, g.left, lb), _Internal(node.key, g.right, node.right, rb), 0), False
        return _Internal(node.key, left, node.right, node.balance - 1 if grew else node.balance), grew and node.balance == 0
    right, grew = _insert_at(node.right, key, value, s)
    if grew and node.balance > 0:                                       # the right side was taller and grew: rotate
        if right.balance > 0:
            return _Internal(right.key, _Internal(node.key, node.left, right.left, 0), right.right, 0), False
        g = right.left                                                  # double left rotation about g
        lb, rb = _double_rotation_balances(g.balance)
        return _Internal(g.key, _Internal(node.key, node.left, g.left, lb), _Internal(right.key, g.right, right.right, rb), 0), False
    return _Internal(node.key, node.left, right, node.balance + 1 if grew else node.balance), grew and node.balance == 0


def _label(n):
    if n.label is None:
        n.label = (_blake2b256(_LEAF_PREFIX, n.key, n.value, n.next) if n.leaf
                   else _blake2b256(_INTERNAL_PREFIX, bytes((n.balance & 0xff,)), _label(n.left), _label(n.right)))
    return n.label


class AvlError(Exception):
    """Input digest(), debt_key() or insert_digest() refuses (the module docstring says how a caller answers one)."""

    def __init__(self, message, extra=None):
        super().__init__(message)
        self.code = 'invalid_field'
        self.extra = dict(extra) if extra else {}


def _is_object(v):
    """A JSON object or array: what JavaScript's typeof calls an object (null aside). An array has none of a row's or an
    entry's fields, so it is refused at its first field, as there."""
    return isinstance(v, (dict, list))


def _field(o, name, default=_MISSING):
    return o.get(name, default) if isinstance(o, dict) else default


def _is_bytes(v):
    return isinstance(v, (bytes, bytearray))


def insert_digest(entries):
    """The digest of an empty tree after one Insert per entry, in the order given: the lower level digest() builds on.
    entries: [{'key': ..., 'value': ...}], key 32 bytes (bytes or bytearray) strictly between the sentinel keys 00..00
    and ff..ff, value bytes of any length (hashed as they are). An Insert of a key already in the tree replaces its value
    (the crate's insert-or-update; digest() never relies on it). Returns 66 lowercase hex characters: root label ||
    height."""
    if not isinstance(entries, (list, tuple)):
        raise AvlError('entries must be an array of {key, value} byte arrays')
    root, height = _Leaf(_NEGATIVE_INFINITY, b'', _POSITIVE_INFINITY), 0
    for i, e in enumerate(entries):
        extra = {'entry': i}
        if not _is_object(e):
            raise AvlError(f'entries[{i}] must be {{key, value}}', extra)
        key, value = _field(e, 'key'), _field(e, 'value')
        if not _is_bytes(key) or len(key) != KEY_LENGTH:
            raise AvlError(f'entries[{i}].key must be {KEY_LENGTH} bytes (bytes)', extra)
        key = bytes(key)
        if key <= _NEGATIVE_INFINITY or key >= _POSITIVE_INFINITY:
            raise AvlError(f'entries[{i}].key must lie strictly between the sentinel keys 00..00 and ff..ff', extra)
        if not _is_bytes(value):
            raise AvlError(f'entries[{i}].value must be bytes', extra)
        root, grew = _insert_at(root, key, bytes(value), [False])
        if grew:
            height += 1
    if height > 255:
        raise RuntimeError('AVL+ tree height above 255')      # the crate asserts it; it needs some 2^177 leaves
    return _label(root).hex() + format(height, '02x')


# ---------------------------------------------------------------------------------------------------------------------
# Notes.

_PUBKEY_RE = re.compile(r'0[23][0-9a-f]{64}')                  # a compressed public key, as lib/pilot/core.mjs KEY_RE
_DENOMINATION_RE = re.compile(r'(?:erg|token:[0-9a-f]{64})')   # as lib/basis.mjs checks the pilot denomination
_DECIMAL_RE = re.compile(r'(?:0|[1-9][0-9]{0,19})')            # digits only: no sign, space or leading zero; 2^64 has 20
MAX_SAFE_INTEGER = 2 ** 53 - 1                                 # JavaScript's Number.MAX_SAFE_INTEGER
U64_END = 1 << 64
# Every pattern is used with fullmatch: `$` would also match before a final newline.


def _note_key(issuer, recipient, denomination, where, extra):
    for field, v in (('issuer_pubkey', issuer), ('recipient_pubkey', recipient)):
        if not isinstance(v, str) or not _PUBKEY_RE.fullmatch(v):
            raise AvlError(f'{where}{field} must be a 33-byte compressed public key: 66 lowercase hex characters starting 02 or 03', extra)
    if not isinstance(denomination, str) or not _DENOMINATION_RE.fullmatch(denomination):
        raise AvlError(f'{where}denomination must be erg or token:<the token id, 64 lowercase hex characters>', extra)
    parts = [bytes.fromhex(issuer), bytes.fromhex(recipient)]
    if denomination != 'erg':
        parts.append(bytes.fromhex(denomination[len('token:'):]))
    return _blake2b256(*parts)


def _total_bytes(total, where, extra):
    """A total as the tracker stores it, a u64, as its 8 big-endian bytes (the module docstring says which values are
    taken and why)."""
    t = None
    if isinstance(total, bool):
        pass
    elif isinstance(total, int):
        t = total
    elif isinstance(total, str) and _DECIMAL_RE.fullmatch(total):
        t = int(total)
    elif isinstance(total, float) and total.is_integer() and abs(total) <= MAX_SAFE_INTEGER:
        t = int(total)
    if t is None:
        raise AvlError(f'{where} must be a whole number: a decimal string of digits, an int, or a float that is a safe integer '
                       '(a float above 2^53 - 1 may already have been rounded: pass the digits the tracker wrote, as a '
                       'string)', extra)
    if not 0 <= t < U64_END:
        raise AvlError(f'{where} must be from 0 to 2^64 - 1 (a tracker total is a u64)', extra)
    return t.to_bytes(8, 'big')


def debt_key(issuer_hex, recipient_hex, denomination='erg'):
    """A note's debt key, the key of its leaf: blake2b256(issuer || recipient || token id when the denomination is
    token:<id>). issuer_hex, recipient_hex: 33-byte compressed public keys as lowercase hex; denomination 'erg' or
    'token:<64 lowercase hex>'. Returns 32 bytes."""
    return _note_key(issuer_hex, recipient_hex, denomination, '', {})


def digest(rows):
    """The digest a tracker anchors for these notes: rows [{issuer_pubkey, recipient_pubkey, denomination?, total}],
    denomination 'erg' when absent, total a decimal string, an int or a float that is a safe integer, in [0, 2^64). A
    total is taken as given, so it must be exact: the digits the tracker wrote (the module docstring). The rows are
    sorted by debt key here, whatever order they come in; two rows with one debt key (one issuer, recipient and
    denomination) are refused, as are malformed public keys, denominations and totals (AvlError). Other fields of a row
    are ignored, and the rows are not changed. Returns 66 lowercase hex characters, the 33 bytes R5 of the tracker box
    commits."""
    if not isinstance(rows, (list, tuple)):
        raise AvlError('rows must be an array of notes {issuer_pubkey, recipient_pubkey, denomination, total}')
    entries = []
    for row, r in enumerate(rows):
        where, extra = f'rows[{row}].', {'row': row}
        if not _is_object(r):
            raise AvlError(f'rows[{row}] must be a note {{issuer_pubkey, recipient_pubkey, denomination, total}}', extra)
        denomination = _field(r, 'denomination', 'erg')           # absent: erg; present, it must be one (null is not)
        entries.append({'key': _note_key(_field(r, 'issuer_pubkey'), _field(r, 'recipient_pubkey'), denomination, where, extra),
                        'value': _total_bytes(_field(r, 'total'), f'{where}total', extra), 'row': row})
    entries.sort(key=lambda e: (e['key'], e['row']))
    for i in range(1, len(entries)):
        if entries[i - 1]['key'] == entries[i]['key']:
            first, again = entries[i - 1]['row'], entries[i]['row']
            raise AvlError(f'rows[{again}] has the debt key of rows[{first}]: a tracker holds one note per issuer, recipient '
                           'and denomination', {'row': again, 'duplicate_of': first})
    return insert_digest(entries)
