"""valun/avl.py, the AVL+ digest a Basis tracker anchors on Ergo (fix inbox #62, step 6a), against references it cannot
produce itself, the same ones the server's lib/avl.mjs is held to (valun-app test/avl.unit.test.mjs):
  - fixtures/avl-random.json, byte for byte the server's test/fixtures/avl-random.json: digests computed by
    ergo_avltree_rust as upstream Basis vendors it (the crate tracker v4.4 builds its tree with; valun-app
    basis/avl-fixtures): cases generated from seeds by splitmix64, inserted in ascending key order, in random order and
    with keys inserted again; debt keys in erg and token denominations; explicit rows; the empty tree;
  - three live anchors of the testnet tracker: the R5 digests, heights and row counts are written here (public on the
    chain); the rows are dated snapshots of every testnet note, kept out of every public repository (the owner's call,
    valun-app scripts/ops/sync-open.py PRIVATE_PATHS), so the tests that need them read them from the folder
    VALUN_ANCHOR_VECTORS names (valun-app test/fixtures/anchor-vectors) and are skipped without it;
  - what digest() refuses: two rows with one debt key, malformed public keys and denominations, totals outside
    [0, 2^64) or in an ambiguous form. Shuffled input gives the same digest; tampered input another;
  - the types totals come in, as the JavaScript reference takes them: a str of digits, an int (a JavaScript BigInt), a
    float only when it is a safe integer (a JavaScript Number); a JSON integer literal above 2^53 - 1 is exact here;
  - a refusal is an AvlError, not a ValunError: one that reaches a tool's error payload is an internal error, never an
    answer about the request.
Run: python -m unittest python/tests/test_avl.py (or python -m pytest python/tests/test_avl.py)."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import avl  # noqa: E402
from valun import client as vc  # noqa: E402


def _read(name):
    with open(os.path.join(HERE, 'fixtures', name), encoding='utf-8') as f:
        return json.load(f)


RANDOM = _read('avl-random.json')
# The digests R5 of the tracker box held at each height (Ergo testnet, read on 2026-11-14), and the row counts, as the
# server's test writes them, so that an edit of a vector cannot move them.
LIVE = [
    (644995, 250, 'da212e4773a6894d0cd2131551ae58e315943282f27400efd5fbb23e1e2d772808'),
    (645135, 251, '0d60d54d9871d4ecfc1d9eb1dbaf69a2eef75730b92425b24b6ab00104fe7aa508'),
    (645189, 251, '237616c865b69edef051b6b1edc3adf4072bf4d602cc174561fbc74fe8ec64e708'),
]
VECTORS_DIR = os.environ.get('VALUN_ANCHOR_VECTORS')
NO_VECTORS = 'the live anchor vectors are private: set VALUN_ANCHOR_VECTORS to valun-app test/fixtures/anchor-vectors'


def _vectors():
    """The three live vectors from VALUN_ANCHOR_VECTORS; a missing one fails (only an unset variable skips)."""
    out = []
    for height, _n, _digest in LIVE:
        with open(os.path.join(VECTORS_DIR, f'{height}.json'), encoding='utf-8') as f:
            out.append(json.load(f))
    return out


VECTORS = _vectors() if VECTORS_DIR else []
EMPTY_TREE = '4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900'   # the crate's own unit test
# Rows with the digest the Rust crate gives them in debt-key order: the 150 explicit rows of avl-random.json (erg and
# three tokens, ten zero totals, totals up to 2^64 - 1), always here, and the live vectors where they are.
EXPLICIT = next(c for c in RANDOM['rows_cases'] if len(c['rows']) == 150)
SETS = [('the 150 explicit rows', EXPLICIT['rows'], EXPLICIT['debt_key_order'])] + \
    [(f"height {v['height']}", v['rows'], v['r5_digest']) for v in VECTORS]

M64, P53, P63 = (1 << 64) - 1, 1 << 53, 1 << 63


def u64(t):
    return t.to_bytes(8, 'big')


def entries_of(rows):
    return [{'key': avl.debt_key(r['issuer_pubkey'], r['recipient_pubkey'], r['denomination']), 'value': u64(int(r['total']))}
            for r in rows]


# The fixtures' generator, as avl-random.json states it ("prng", "entry", "orders") and basis/avl-fixtures/src/main.rs
# draws it: splitmix64 over u64 (all arithmetic mod 2^64).
def splitmix64(seed):
    state = [seed]

    def nxt():
        state[0] = (state[0] + 0x9e3779b97f4a7c15) & M64
        z = state[0]
        z = ((z ^ (z >> 30)) * 0xbf58476d1ce4e5b9) & M64
        z = ((z ^ (z >> 27)) * 0x94d049bb133111eb) & M64
        return z ^ (z >> 31)
    return nxt


def draw_key(nxt):
    return b''.join(nxt().to_bytes(8, 'big') for _ in range(4))


def draw_value(nxt):
    c = nxt() % 10
    if c == 0:
        return 0
    if c == 1:
        return nxt() % 256
    if c == 2:
        return nxt() % (1 << 32)
    if c == 3:
        return P53 - 3 + nxt() % 7
    if c == 4:
        return P53 + nxt() % P53
    if c == 5:
        return P63 - 3 + nxt() % 7
    if c == 6:
        return M64 - nxt() % 4
    if c == 7:
        return M64
    return nxt()


SENTINELS = (bytes(32), b'\xff' * 32)


def case_entries(seed_hex, n, order):
    nxt, out, seen = splitmix64(int(seed_hex, 16)), [], set()
    for i in range(n):
        if order == 'repeats' and i > 0 and nxt() % 4 == 0:
            key = out[nxt() % i]['key']
        else:
            key = draw_key(nxt)
            while key in SENTINELS or key in seen:
                key = draw_key(nxt)
        seen.add(key)
        out.append({'key': key, 'value': u64(draw_value(nxt))})
    if order == 'ascending':
        out.sort(key=lambda e: e['key'])
    return out


def shuffled(rows, nxt):
    """Fisher-Yates with a seeded generator: a different, repeatable order each call."""
    a = list(rows)
    for i in range(len(a) - 1, 0, -1):
        j = nxt() % (i + 1)
        a[i], a[j] = a[j], a[i]
    return a


class Refusals(unittest.TestCase):
    def refused(self, fn, field, what=None):
        with self.assertRaises(avl.AvlError, msg=what) as e:
            fn()
        self.assertEqual(e.exception.code, 'invalid_field', what)
        self.assertIn(field, str(e.exception), what)
        return e.exception


@unittest.skipUnless(VECTORS_DIR, NO_VECTORS)
class LiveAnchors(unittest.TestCase):
    def test_the_published_notes_in_debt_key_order_give_r5_of_the_one_unspent_tracker_box(self):
        self.assertEqual([(v['height'], len(v['rows']), v['r5_digest']) for v in VECTORS], LIVE)
        for v in VECTORS:
            self.assertEqual(v['r5'], f"64{v['r5_digest']}032000", 'R5 is an AvlTree constant: the digest, flags 03, key length 32, no value length')
            for r in v['rows']:
                self.assertEqual(list(r), ['issuer_pubkey', 'recipient_pubkey', 'denomination', 'total'], 'no handles, no participant ids')
            self.assertEqual(avl.digest(v['rows']), v['r5_digest'], v['height'])
            self.assertEqual(avl.digest([{k: x for k, x in r.items() if k != 'denomination'} for r in v['rows']]), v['r5_digest'],
                             'denomination erg when absent, as in GET /ledger rows')
            self.assertEqual(avl.digest(v['rows'])[64:], '08', 'the last byte is the height: 8 for some 250 notes')

    def test_timestamp_order_the_rows_as_listed_gives_the_other_digest_the_rust_crate_computed_digest_never_takes_it(self):
        for v in VECTORS:
            self.assertNotEqual(v['timestamp_order_digest'], v['r5_digest'])
            self.assertEqual(avl.insert_digest(entries_of(v['rows'])), v['timestamp_order_digest'], f"height {v['height']}: inserted as listed")
            self.assertEqual(avl.digest(v['rows']), v['r5_digest'], f"height {v['height']}: the same rows, sorted by debt key inside digest()")


class Digest(Refusals):
    def test_the_order_rows_come_in_never_changes_the_digest_and_the_rows_are_not_changed(self):
        nxt = splitmix64(62)
        for name, rows, expected in SETS:
            before = json.dumps(rows)
            for k in range(4):
                self.assertEqual(avl.digest(shuffled(rows, nxt)), expected, f'{name}, shuffle {k}')
            self.assertEqual(avl.digest(list(reversed(rows))), expected, name)
            self.assertEqual(avl.digest(sorted(rows, key=lambda r: int(r['total']))), expected, name)
            self.assertEqual(avl.digest(tuple(rows)), expected, 'a tuple of rows is a list of rows')
            self.assertEqual(json.dumps(rows), before)

    def test_tampering_changes_the_digest_a_total_moved_by_1_a_dropped_row_a_fabricated_row_swapped_totals(self):
        def moved(t):
            return str(t - 1 if t == M64 else t + 1)            # + 1, or - 1 at 2^64 - 1 (2^64 is refused)
        stranger, token = '02' + 'ab' * 32, 'token:' + 'cd' * 32
        for name, rows, expected in SETS[:2]:                   # the explicit rows and the first live vector
            for i in range(len(rows)):
                changed = [dict(r, total=moved(int(r['total']))) if j == i else r for j, r in enumerate(rows)]
                self.assertNotEqual(avl.digest(changed), expected, f'{name}: row {i} moved by 1')
                self.assertNotEqual(avl.digest(rows[:i] + rows[i + 1:]), expected, f'{name}: row {i} dropped')
            self.assertTrue(any(r['total'] == '0' for r in rows), f'{name} has zero totals: each is a leaf')
            self.assertFalse(any(r['issuer_pubkey'] == stranger or r['denomination'] == token for r in rows))
            for total in ('0', '1', '1500000'):
                fabricated = rows + [{'issuer_pubkey': stranger, 'recipient_pubkey': rows[0]['recipient_pubkey'], 'denomination': 'erg', 'total': total}]
                self.assertNotEqual(avl.digest(fabricated), expected, f'{name}: fabricated {total}')
            i = next(k for k, r in enumerate(rows) if r['total'] != rows[0]['total'])
            swapped = [dict(r, total=rows[0]['total']) if k == i else dict(r, total=rows[i]['total']) if k == 0 else r for k, r in enumerate(rows)]
            self.assertNotEqual(avl.digest(swapped), expected, f'{name}: two totals swapped')
            self.assertNotEqual(avl.digest([dict(r, denomination=token) if k == 3 else r for k, r in enumerate(rows)]), expected,
                                f'{name}: a note moved to another denomination')
            lone = next(k for k, r in enumerate(rows) if not any(s['issuer_pubkey'] == r['recipient_pubkey'] and s['recipient_pubkey'] == r['issuer_pubkey'] for s in rows))
            turned = [dict(r, issuer_pubkey=r['recipient_pubkey'], recipient_pubkey=r['issuer_pubkey']) if k == lone else r for k, r in enumerate(rows)]
            self.assertNotEqual(avl.digest(turned), expected, f'{name}: a note turned around (the recipient owing)')

    def test_rows_with_token_denominations_and_totals_up_to_2_64_minus_1_give_the_rust_digests_in_debt_key_order_and_as_listed(self):
        self.assertTrue(any(r['denomination'].startswith('token:') for c in RANDOM['rows_cases'] for r in c['rows']))
        self.assertTrue(any(r['total'] == '18446744073709551615' for c in RANDOM['rows_cases'] for r in c['rows']))
        for c in RANDOM['rows_cases']:
            self.assertEqual(avl.digest(c['rows']), c['debt_key_order'], f"{len(c['rows'])} rows")
            self.assertEqual(avl.digest([dict(r, total=int(r['total'])) for r in c['rows']]), c['debt_key_order'], 'totals as int')
            self.assertEqual(avl.insert_digest(entries_of(c['rows'])), c['given_order'], f"{len(c['rows'])} rows as listed")

    def test_two_rows_with_one_debt_key_are_refused_whatever_their_totals_the_same_pair_in_another_denomination_is_another_note(self):
        rows = EXPLICIT['rows']
        at = next(i for i, x in enumerate(rows) if i >= 5 and x['denomination'] == 'erg')
        r = rows[at]
        e = self.refused(lambda: avl.digest(rows + [r]), f'debt key of rows[{at}]')
        self.assertEqual(e.extra, {'row': len(rows), 'duplicate_of': at})
        self.refused(lambda: avl.digest(rows + [dict(rows[3], total='1')]), 'debt key of rows[3]', 'a token note twice')
        self.refused(lambda: avl.digest([r, dict(r, total='1')]), 'debt key', 'another total')
        self.refused(lambda: avl.digest([{'issuer_pubkey': r['issuer_pubkey'], 'recipient_pubkey': r['recipient_pubkey'], 'total': 7}, r]),
                     'debt key', 'erg by default and erg named')
        e = self.refused(lambda: avl.digest([dict(r, total='3'), dict(r, total='2'), dict(r, total='1')]), 'debt key of rows[0]', 'three')
        self.assertEqual(e.extra, {'row': 1, 'duplicate_of': 0}, 'the first two rows that share the key')
        e = self.refused(lambda: avl.digest([r, r, dict(r, total='x')]), 'rows[2].total', 'a malformed row first')
        self.assertEqual(e.extra, {'row': 2})
        token = dict(r, denomination='token:' + 'ab' * 32)
        self.assertNotEqual(avl.digest([r, token]), avl.digest([r]))
        self.assertNotEqual(avl.digest([r, token]), avl.digest([token]))

    def test_malformed_public_keys_denominations_and_rows_are_refused(self):
        r = EXPLICIT['rows'][0]
        k = r['issuer_pubkey']
        bad_keys = [k.upper(), k[:64], k + '00', '04' + k[2:], '00' + k[2:], ' ' + k[1:], k[:65] + 'g', k + '\n', '', None, 2,
                    bytes.fromhex(k), [k]]
        self.assertNotEqual(k.upper(), k)
        for bad in bad_keys:
            e = self.refused(lambda: avl.digest([dict(r, issuer_pubkey=bad)]), 'rows[0].issuer_pubkey', repr(bad))
            self.assertEqual(e.extra, {'row': 0})
            e = self.refused(lambda: avl.digest([r, dict(r, recipient_pubkey=bad)]), 'rows[1].recipient_pubkey', repr(bad))
            self.assertEqual(e.extra, {'row': 1})
            self.refused(lambda: avl.debt_key(bad, r['recipient_pubkey']), 'issuer_pubkey', repr(bad))
            self.refused(lambda: avl.debt_key(r['issuer_pubkey'], bad), 'recipient_pubkey', repr(bad))
        for d in ['ERG', 'Erg', 'erg\n', 'token:', 'token:' + 'AB' * 32, 'token:' + 'ab' * 31, 'token:' + 'ab' * 33,
                  'token:0x' + 'ab' * 31, 'usd', '', None, 0]:
            self.refused(lambda: avl.digest([dict(r, denomination=d)]), 'rows[0].denomination', repr(d))
            self.refused(lambda: avl.debt_key(r['issuer_pubkey'], r['recipient_pubkey'], d), 'denomination', repr(d))
        for rows_arg in (None, {}, 'rows', 5, b'rows'):
            e = self.refused(lambda: avl.digest(rows_arg), 'rows', repr(rows_arg))
            self.assertEqual(e.extra, {})
        for row in (None, 5, 'row', True, 1.5):
            e = self.refused(lambda: avl.digest([r, row]), 'rows[1] must be a note', repr(row))
            self.assertEqual(e.extra, {'row': 1})
        for row in ([], [1, 2]):     # a JSON array is an object to JavaScript's typeof, with none of the fields
            self.refused(lambda: avl.digest([r, row]), 'rows[1].issuer_pubkey', repr(row))
        extra = [dict(x, issuer='vp_000000000000', issuer_handle='someone', timestamp=1, redeemed=1) for x in EXPLICIT['rows']]
        self.assertEqual(avl.digest(extra), EXPLICIT['debt_key_order'], 'other fields of a row are ignored')

    def test_totals_outside_0_2_64_unsafe_floats_and_ambiguous_strings_are_refused_the_bounds_count_in_every_accepted_form(self):
        r = EXPLICIT['rows'][0]

        def one(total):
            return avl.digest([dict(r, total=total)])
        bad = ['18446744073709551616', '99999999999999999999', '100000000000000000000', '-1', '-0', '+1', ' 1', '1 ', '1\n',
               '01', '00', '1e6', '0x10', '1.5', '1_000', '', '١', '１',
               float(2 ** 53), float(2 ** 64), -1, -1.0, 1.5, float('nan'), float('inf'), float('-inf'), 1 << 64, -(1 << 64),
               None, True, False, {}, [1], b'1']
        for total in bad:
            e = self.refused(lambda: one(total), 'rows[0].total', f'{type(total).__name__} {total!r}')
            self.assertEqual(e.extra, {'row': 0})
        self.assertEqual(one('18446744073709551615'), one((1 << 64) - 1))
        self.assertEqual(one('9007199254740991'), one(9007199254740991))
        self.assertEqual(one('9007199254740991'), one(9007199254740991.0), 'a float that is a safe integer, as a Number is')
        self.assertEqual(one('0'), one(0))
        self.assertEqual(one('0'), one(0.0))
        self.assertEqual(one('0'), one(-0.0), '-0.0 is 0, as -0 is')
        self.assertEqual(one('5'), one(5.0))
        self.assertNotEqual(one('9007199254740992'), one('9007199254740993'), 'above 2^53 every total stays exact')
        self.assertNotEqual(one('18446744073709551614'), one('18446744073709551615'))

    def test_a_json_integer_above_2_53_minus_1_is_exact_here_a_float_of_it_is_refused(self):
        """What JSON.parse cannot do: json reads 2^53 + 1 as the int 2^53 + 1, so its digest is the exact one (the
        JavaScript reference refuses the Number 2^53 that JSON.parse makes of it). A float of it may be rounded and is
        refused, as the Number is; a float of a total up to 2^53 - 1 gives the same digest as its digits."""
        issuer, recipient, digits = '02' + 'aa' * 32, '03' + 'bb' * 32, '9007199254740993'
        want = avl.digest([{'issuer_pubkey': issuer, 'recipient_pubkey': recipient, 'total': digits}])
        self.assertEqual(want, avl.insert_digest([{'key': avl.debt_key(issuer, recipient), 'value': u64(P53 + 1)}]))
        text = '[{"issuer_pubkey": "%s", "recipient_pubkey": "%s", "total": %s}]'
        rows = json.loads(text % (issuer, recipient, digits))
        self.assertEqual(rows[0]['total'], P53 + 1)
        self.assertEqual(avl.digest(rows), want)
        rounded = json.loads(text % (issuer, recipient, digits + '.0'))
        self.assertIsInstance(rounded[0]['total'], float)
        self.refused(lambda: avl.digest(rounded), 'rows[0].total', 'the float json makes of 9007199254740993.0')
        small = json.loads(text % (issuer, recipient, '12000000.0')), json.loads(text % (issuer, recipient, '12000000'))
        self.assertEqual(avl.digest(small[0]), avl.digest(small[1]), 'up to 2^53 - 1 both forms give one digest')
        self.assertEqual(avl.digest(json.loads(text % (issuer, recipient, '1.2e7'))), avl.digest(small[1]))

    def test_a_refusal_is_an_avl_error_not_a_valun_error_a_tool_payload_shows_it_as_an_internal_error(self):
        bad = [dict(EXPLICIT['rows'][0], total=float(2 ** 53))]
        with self.assertRaises(avl.AvlError) as e:
            avl.digest(bad)
        refusal = e.exception
        self.assertNotIsInstance(refusal, vc.ValunError)
        self.assertFalse(issubclass(avl.AvlError, vc.ValunError))
        self.assertEqual((type(refusal).__name__, refusal.code, refusal.extra), ('AvlError', 'invalid_field', {'row': 0}))
        self.assertFalse(hasattr(refusal, 'status'), 'no HTTP status: never an answer about a request')
        self.assertRaises(avl.AvlError, avl.debt_key, '02', EXPLICIT['rows'][0]['recipient_pubkey'])
        self.assertRaises(avl.AvlError, avl.insert_digest, [{'key': bytes(32), 'value': b''}])
        payload = va.error_payload(refusal)
        self.assertEqual(payload['error'], 'internal_error', 'not invalid_field: the requester did not send these rows')
        self.assertTrue(payload['message'].startswith('AvlError: rows[0].total must be a whole number'))

    def test_the_empty_ledger_gives_the_empty_trees_digest_as_the_rust_crate_computes_it(self):
        self.assertEqual(RANDOM['empty_digest'], EMPTY_TREE)
        self.assertEqual(avl.digest([]), EMPTY_TREE)
        self.assertEqual(avl.insert_digest([]), EMPTY_TREE)


class RandomFixtures(Refusals):
    def check_order(self, order, minimum):
        cases = [c for c in RANDOM['cases'] if c['order'] == order]
        values = {'zero': 0, 'small': 0, 'above_2_53': 0, 'max': 0}
        for c in cases:
            entries = case_entries(c['seed'], c['n'], order)
            self.assertEqual(len(entries), c['n'])
            self.assertEqual(avl.insert_digest(entries), c['digest'], f"{order} seed {c['seed']} n {c['n']}")
            for e in entries:
                t = int.from_bytes(e['value'], 'big')
                values['zero'] += t == 0
                values['small'] += 0 < t < 1000
                values['above_2_53'] += t > P53
                values['max'] += t == M64
        self.assertGreaterEqual(len(cases), minimum)
        self.assertEqual((min(c['n'] for c in cases), max(c['n'] for c in cases)), (0, 600))
        for k, count in values.items():
            self.assertGreater(count, 0, f'values {k}')

    def test_every_random_fixture_inserted_in_ascending_key_order_the_digest_ergo_avltree_rust_computed(self):
        self.check_order('ascending', 1000)

    def test_every_random_fixture_inserted_in_random_order_the_digest_ergo_avltree_rust_computed(self):
        self.check_order('random', 200)

    def test_every_random_fixture_with_keys_inserted_again_the_digest_ergo_avltree_rust_computed(self):
        self.check_order('repeats', 100)

    def test_the_generator_is_the_rust_one_splitmix64_outputs_and_one_cases_entries_in_each_order(self):
        for v in RANDOM['prng_vectors']:
            nxt = splitmix64(int(v['seed'], 16))
            self.assertEqual([format(nxt(), '016x') for _ in v['outputs']], v['outputs'], v['seed'])
        for v in RANDOM['entry_vectors']:
            entries = case_entries(v['seed'], v['n'], v['order'])
            self.assertEqual([[e['key'].hex(), e['value'].hex()] for e in entries], v['entries'], v['order'])
            self.assertEqual(avl.insert_digest(entries), v['digest'], v['order'])
        repeats = next(v for v in RANDOM['entry_vectors'] if v['order'] == 'repeats')
        self.assertLess(len({e[0] for e in repeats['entries']}), repeats['n'], 'the repeats vector inserts a key again')

    def test_debt_keys_blake2b256_of_issuer_recipient_and_token_id_as_the_rust_crates_compute_them_erg_when_not_given(self):
        for c in RANDOM['debt_keys']:
            self.assertEqual(avl.debt_key(c['issuer_pubkey'], c['recipient_pubkey'], c['denomination']).hex(), c['debt_key'], c)
        a, b = RANDOM['debt_keys'][0]['issuer_pubkey'], RANDOM['debt_keys'][0]['recipient_pubkey']
        self.assertEqual(avl.debt_key(a, b), avl.debt_key(a, b, 'erg'))
        self.assertIsInstance(avl.debt_key(a, b), bytes)
        self.assertEqual(len(avl.debt_key(a, b)), 32)
        self.assertEqual(len({c['debt_key'] for c in RANDOM['debt_keys'][:4]}), 4, 'erg, two tokens and the swapped pair: four keys')

    def test_insert_digest_refuses_the_keys_the_crate_refuses_an_insert_of_a_key_present_replaces_its_value(self):
        value, k = u64(5), b'\x07' * 32
        bad_keys = [bytes(32), b'\xff' * 32, b'\x01' * 31, b'\x01' * 33, [1] * 32, 'ab' * 32, None, bytearray(32)]
        for key in bad_keys:
            e = self.refused(lambda: avl.insert_digest([{'key': key, 'value': value}]), 'entries[0].key', repr(key))
            self.assertEqual(e.extra, {'entry': 0})
        self.refused(lambda: avl.insert_digest([{'key': k, 'value': [0, 0, 0, 0, 0, 0, 0, 5]}]), 'entries[0].value', 'a list is not bytes')
        self.refused(lambda: avl.insert_digest([{'key': k}]), 'entries[0].value', 'no value')
        self.refused(lambda: avl.insert_digest([None]), 'entries[0]', 'None entry')
        self.refused(lambda: avl.insert_digest([(k, value)]), 'entries[0] must be {key, value}', 'a tuple is not an entry')
        self.refused(lambda: avl.insert_digest([[k, value]]), 'entries[0].key', 'a list has none of the fields')
        self.refused(lambda: avl.insert_digest({}), 'entries', 'not a list')
        low, high = bytes(31) + b'\x01', b'\xff' * 31 + b'\xfe'
        d = avl.insert_digest([{'key': low, 'value': value}, {'key': high, 'value': value}])
        self.assertRegex(d, r'\A[0-9a-f]{64}02\Z', 'the keys next to the sentinels are fine')
        self.assertEqual(avl.insert_digest([{'key': bytearray(low), 'value': bytearray(value)}, {'key': high, 'value': value}]), d,
                         'a bytearray is bytes')
        self.assertEqual(avl.insert_digest([{'key': k, 'value': u64(1)}, {'key': k, 'value': u64(2)}]),
                         avl.insert_digest([{'key': k, 'value': u64(2)}]))
        self.assertNotEqual(avl.insert_digest([{'key': k, 'value': b''}]), avl.insert_digest([{'key': k, 'value': bytes(8)}]))


if __name__ == '__main__':
    unittest.main()
