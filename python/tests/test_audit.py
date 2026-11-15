"""`valun audit` and valun/audit.py (fix inbox #62, step 6b): the published ledger against the one unspent tracker-NFT box
of a chain source the user names. Offline: a fake Valun server, explorer and node answer (synthetic keys, notes and
boxes; no testnet data), and the command runs once over real HTTP on 127.0.0.1. The digest itself is held to the
tracker's own crate in test_avl.py; here the boxes commit avl.digest of the notes they are meant to commit.
  - MATCH from the committed snapshot (explorer and node), the box's age and the two windows; rows in any order;
  - MISMATCH: a total raised by 1, a dropped row, a fabricated row, a snapshot whose totals include a later write;
  - UNKNOWN, never a pass: malformed rows (a duplicate debt key, 2^64), a total written as a JSON number above
    2^53 - 1, a spent box, two boxes, a box without the NFT or off the main chain, no box, an R5 that is not the tree,
    a node that is not on testnet (refused before its boxes are read), an unreadable server or source, another
    construction, a box or snapshot that keeps moving (read again first: never a false MISMATCH), a ledger not anchored;
  - a server without GET /ledger/committed: GET /ledger between two reads of GET /chain;
  - the server's own node as the source: a warning;
  - --mine: every edge of the participant on every key (this agent's and a past one GET /ledger names), each one's
    status against the profile's records and their issuer signatures; exit 4 unless every edge is signed;
  - the command: exit codes, text and JSON, GET only, no token sent, nothing written."""
import contextlib
import copy
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import __version__  # noqa: E402
from valun import audit as vaudit  # noqa: E402
from valun import avl  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402

SERVER, EXPLORER, NODE = 'http://valun.invalid', 'http://explorer.invalid', 'http://node.invalid:9052'
OPERATOR_NODE = 'http://203.0.113.9:9052'               # the node GET /chain names
NFT = 'd1' * 32
BOX_ID, NEW_BOX_ID, TX_ID = 'b5' * 32, 'b6' * 32, 'e7' * 32
HEIGHT, TIP = 645189, 645230
T0 = 1794600000000
TOKEN = 'token:' + 'ab' * 32


def _keypair(name):
    secret = hashlib.sha256(f'valun audit test key: {name}'.encode()).digest()
    return secret, vb.public_key(secret).hex()


(ALICE_S, ALICE), (OLD_S, ALICE_OLD), (BOB_S, BOB), (CAROL_S, CAROL), (DAVE_S, DAVE) = (
    _keypair(n) for n in ('alice', 'alice, a past key', 'bob', 'carol', 'dave'))
SECRETS = {ALICE: ALICE_S, ALICE_OLD: OLD_S, BOB: BOB_S, CAROL: CAROL_S, DAVE: DAVE_S}
ME, BOB_ID, CAROL_ID, DAVE_ID = 'vp_a1a1a1a1a1a1', 'vp_b0b0b0b0b0b0', 'vp_c0c0c0c0c0c0', 'vp_d0d0d0d0d0d0'
OWNER = {ALICE: ME, ALICE_OLD: ME, BOB: BOB_ID, CAROL: CAROL_ID, DAVE: DAVE_ID}


def signed(issuer, recipient, total, ts):
    """An EdgeState as the records hold it: the issuer's Basis signature on (issuer, recipient, total, ts), tracker NFT."""
    msg = vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, ts, bytes.fromhex(NFT), 'erg')
    return {'total': total, 'timestamp': ts, 'signature': vb.sign(msg, SECRETS[issuer], bytes.fromhex(issuer)).hex()}


def note(issuer, recipient, total, denomination='erg'):
    return {'issuer_pubkey': issuer, 'recipient_pubkey': recipient, 'denomination': denomination, 'total': total}


def anchored_notes():
    """What the tracker box commits (and, untampered, what the server publishes)."""
    return [note(ALICE, BOB, 3_000_000), note(BOB, ALICE, 1_500_000), note(CAROL, ALICE, 2_000_000),
            note(ALICE_OLD, DAVE, 700_000), note(ALICE, DAVE, 100), note(DAVE, ALICE, 50),
            note(BOB, CAROL, 900_000), note(CAROL, BOB, 0), note(DAVE, CAROL, 1 << 60), note(ALICE, BOB, 5, TOKEN)]


# This profile's records (alice's agent, key ALICE): what each edge's status below is about.
SIGNED = {(ALICE, BOB): signed(ALICE, BOB, 3_000_000, T0 + 1), (BOB, ALICE): signed(BOB, ALICE, 1_500_000, T0 + 2),
          (CAROL, ALICE): signed(CAROL, ALICE, 2_500_000, T0 + 3), (DAVE, ALICE): signed(DAVE, ALICE, 60, T0 + 5),
          (ALICE, CAROL): signed(ALICE, CAROL, 400_000, T0 + 6)}


def records_of():
    e = lambda st, pending=(): {'confirmed': dict(st), 'pending': list(pending)}  # noqa: E731
    return {
        f'{ALICE}>{BOB}': e(SIGNED[(ALICE, BOB)]),                                      # signed (as issuer)
        f'{BOB}>{ALICE}': e(SIGNED[(BOB, ALICE)]),                                      # signed (as recipient)
        f'{CAROL}>{ALICE}': e(SIGNED[(CAROL, ALICE)]),                                  # differs: 2,500,000 recorded
        f'{ALICE}>{DAVE}': e({'total': 100, 'timestamp': T0 + 4},                       # signature dropped (30 days)
                             [{'total': 300, 'timestamp': T0 + 9, 'kind': 'note', 'ref': 'vd_' + '12' * 8,
                               'direction': 'out', 'signed_at': None}]),
        f'{DAVE}>{ALICE}': e(dict(SIGNED[(DAVE, ALICE)], total=50)),                    # a signature of 60, recorded as 50
        f'{ALICE}>{CAROL}': e(SIGNED[(ALICE, CAROL)]),                                  # not anchored
        'paid_deals': {'vd_' + '34' * 8: {'route': 'note', 'edge': f'{ALICE}>{BOB}', 'total': 3_000_000, 'timestamp': T0 + 1}},
    }


def profile_state(**changes):
    s = {'participant_id': ME, 'pubkey': ALICE, 'network': 'valun-testnet-1',
         'pins': {'tracker_nft_id': NFT, 'denomination': 'erg'}, 'records': records_of()}
    s.update(changes)
    return s


def digest_of(notes):
    return avl.digest([dict(n, total=str(n['total'])) for n in notes])


class World:
    """A fake Valun server (GET /chain, /ledger/committed, /info, /ledger), an explorer and nodes. anchored: the notes
    the tracker box commits; published: the notes the server publishes (the same until a test changes them); boxes: the
    unspent boxes the sources list. overrides: url -> [(status, body), ...] answered in turn (the last one repeats);
    a body may be a callable. Every request is logged."""

    def __init__(self, server=SERVER, explorer=EXPLORER, node=NODE, committed=True, plain=False):
        self.server, self.explorer, self.nodes = server, explorer, {node, OPERATOR_NODE}
        self.anchored = [n for n in anchored_notes() if not plain or (n['denomination'] == 'erg' and n['total'] < 2 ** 53)]
        self.published = copy.deepcopy(self.anchored)
        self.committed, self.anchored_now, self.consistent = committed, True, None
        self.boxes = [self.box()]
        self.node_network, self.overrides, self.log, self.sleeps = 'testnet', {}, [], []

    def box(self, box_id=BOX_ID, **kw):
        return {'box_id': box_id, 'creation_height': HEIGHT, 'r5': None, 'spent': None, 'amount': 1, 'main': True,
                'tokens_before': [], **kw}

    def r5(self):
        return '64' + digest_of(self.anchored) + '032000'

    # ---------- the answers ----------
    def chain(self, box_id=None):
        d = digest_of(self.anchored)
        return {'network': 'valun-testnet-1', 'name': 'ergo-testnet', 'on_chain': True, 'tracker_nft_id': NFT,
                'tracker_address': '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB', 'node': OPERATOR_NODE,
                'explorer': 'https://testnet.ergoplatform.com',
                'anchoring': {'local_digest': d if self.anchored_now else 'ff' * 33, 'confirmed_digest': d,
                              'confirmed_box_id': box_id or BOX_ID,
                              'confirmed_height': HEIGHT, 'pending_tx_id': None, 'anchored': self.anchored_now,
                              'check_interval_seconds': 300, 'state': 'anchored' if self.anchored_now else 'waiting'}}

    def snapshot(self, notes=None, box_id=None):
        notes = self.published if notes is None else notes

        def attempt(fn, *a):                              # the server's own check of rows it cannot digest: false
            try:
                return fn(*a)
            except avl.AvlError:
                return None
        consistent = (attempt(digest_of, notes) == digest_of(self.anchored)) if self.consistent is None else self.consistent
        return {'network': 'valun-testnet-1', 'construction': 'basis-avl/1', 'box_id': box_id or BOX_ID, 'height': HEIGHT,
                'digest': digest_of(self.anchored), 'read_at': '2026-11-14T23:10:00.000Z', 'consistent': consistent,
                'rows': [{'debt_key': (attempt(avl.debt_key, n['issuer_pubkey'], n['recipient_pubkey'], n['denomination']) or b'').hex(),
                          'issuer_pubkey': n['issuer_pubkey'], 'recipient_pubkey': n['recipient_pubkey'],
                          'denomination': n['denomination'], 'committed_total': str(n['total'])} for n in notes]}

    def ledger(self):
        notes = [{'issuer': OWNER.get(n['issuer_pubkey']), 'issuer_handle': None, 'recipient': OWNER.get(n['recipient_pubkey']),
                  'recipient_handle': None, 'issuer_pubkey': n['issuer_pubkey'], 'recipient_pubkey': n['recipient_pubkey'],
                  'total': n['total'], 'redeemed': 0, 'outstanding': n['total'], 'timestamp': T0 + k, 'confirmation': 'confirmed',
                  'unit': 'nanoERG'} for k, n in enumerate(self.published) if n['denomination'] == 'erg']
        return {'unit': 'nanoERG', 'notes': notes, 'reconciliation': []}

    def explorer_box(self, b):
        r5 = b['r5'] if b['r5'] is not None else self.r5()
        regs = {'R4': {'serializedValue': '07' + ALICE, 'sigmaType': 'SGroupElement', 'renderedValue': ALICE},
                'R6': {'serializedValue': '0e20' + NFT, 'sigmaType': 'Coll[SByte]', 'renderedValue': NFT}}
        if r5 != 'absent':
            regs['R5'] = {'serializedValue': r5, 'sigmaType': None, 'renderedValue': None}
        assets = b['tokens_before'] + ([{'tokenId': NFT, 'index': 0, 'amount': b['amount'], 'name': None, 'decimals': None, 'type': None}]
                                       if b['amount'] else [])
        return {'boxId': b['box_id'], 'transactionId': TX_ID, 'blockId': '00' * 32, 'value': 10_000_000, 'index': 0,
                'globalIndex': 2450832, 'creationHeight': b['creation_height'], 'settlementHeight': (b['creation_height'] or 0) + 1,
                'ergoTree': '0008cd' + ALICE, 'address': '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB',
                'assets': assets, 'additionalRegisters': regs, 'spentTransactionId': b['spent'], 'mainChain': b['main']}

    def node_box(self, b):
        x = self.explorer_box(b)
        regs = {k: v['serializedValue'] for k, v in x['additionalRegisters'].items()}
        return {'boxId': x['boxId'], 'value': x['value'], 'ergoTree': x['ergoTree'],
                'assets': [{'tokenId': a['tokenId'], 'amount': a['amount']} for a in x['assets']],
                'creationHeight': x['creationHeight'], 'additionalRegisters': regs, 'transactionId': TX_ID, 'index': 0,
                'address': x['address'], 'spentTransactionId': b['spent'], 'spendingHeight': None,
                'inclusionHeight': (x['creationHeight'] or 0) + 1, 'globalIndex': 2450832}

    def answer(self, url):
        s, e = self.server, self.explorer
        if url == f'{s}/pilot/v1/chain':
            return 200, self.chain()
        if url == f'{s}/pilot/v1/ledger/committed':
            return (200, self.snapshot()) if self.committed else (401, {'error': 'unauthorized', 'message': 'missing or invalid token'})
        if url == f'{s}/pilot/v1/info':
            return 200, {'network': 'valun-testnet-1', 'unit': 'nanoERG', 'denomination': 'erg', 'tracker_nft_id': NFT}
        if url == f'{s}/pilot/v1/ledger':
            return 200, self.ledger()
        if url == f'{e}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10':
            return 200, {'items': [self.explorer_box(b) for b in self.boxes], 'total': len(self.boxes)}
        if url == f'{e}/api/v1/networkState':
            return 200, {'lastBlockId': '00' * 32, 'height': TIP, 'maxBoxGix': 1, 'maxTxGix': 1}
        for n in self.nodes:
            if url == f'{n}/info':
                return 200, {'name': 'a test node', 'network': self.node_network, 'fullHeight': TIP, 'headersHeight': TIP}
            if url == f'{n}/blockchain/box/unspent/byTokenId/{NFT}?offset=0&limit=10':
                return 200, [self.node_box(b) for b in self.boxes]
        return 404, {'error': 'not_found', 'message': 'not found'}

    def respond(self, url):
        self.log.append(url)
        if url in self.overrides:
            answers = self.overrides[url]
            status, body = answers.pop(0) if len(answers) > 1 else answers[0]
        else:
            status, body = self.answer(url)
        return status, json.loads(json.dumps(body() if callable(body) else body))

    def get(self, url):
        status, body = self.respond(url)
        if status >= 400:
            b = body if isinstance(body, dict) else {}
            raise vaudit.ReadError(url, f"HTTP {status} {b.get('error', '')}".strip(), status, b.get('error'), b)
        return body

    def sleep(self, s):
        self.sleeps.append(s)

    def audit(self, source='explorer', **kw):
        src = vaudit.Explorer(self.explorer, get=self.get) if source == 'explorer' else vaudit.Node(source, get=self.get)
        return vaudit.audit(self.server, src, get=self.get, sleep=self.sleep, **kw)


class AuditCase(unittest.TestCase):
    def unknown(self, r, reason, *words):
        self.assertEqual((r['verdict'], r['reason']), ('UNKNOWN', reason), r['message'])
        self.assertEqual(vaudit.exit_code(r), vaudit.EXIT_UNKNOWN)
        self.assertNotIn('does_not_prove', r)
        self.assertNotIn('mine', r)
        for w in words:
            self.assertIn(w, r['message'])


class Verdicts(AuditCase):
    def test_match_from_the_committed_snapshot_with_the_box_its_age_and_the_two_windows(self):
        w = World()
        r = w.audit()
        d = digest_of(w.anchored)
        self.assertEqual((r['verdict'], r['reason'], vaudit.exit_code(r)), ('MATCH', None, 0))
        self.assertEqual(r['rows'], {'from': '/pilot/v1/ledger/committed', 'count': 10, 'digest': d})
        self.assertEqual(r['box'], {'box_id': BOX_ID, 'tx_id': TX_ID, 'creation_height': HEIGHT, 'r5': f'64{d}032000',
                                    'digest': d, 'flags': 3})
        self.assertEqual((r['height'], r['box_age_blocks']), (TIP, 41))
        self.assertEqual((r['nettings_refused_from_height'], r['tracker_less_redemption_from_height']), (HEIGHT + 1440, HEIGHT + 2161))
        self.assertEqual(r['server_says'], {'box_id': BOX_ID, 'height': HEIGHT, 'digest': d, 'consistent': True})
        self.assertEqual((r['network'], r['tracker_nft_id'], r['construction']), ('valun-testnet-1', NFT, 'basis-avl/1'))
        self.assertEqual(r['chain_source'], {'kind': 'explorer', 'url': EXPLORER, 'named_by_server': False})
        self.assertEqual((r['warnings'], r['attempts']), ([], 1))
        self.assertIn(f'created at height {HEIGHT}', r['message'])
        self.assertIn('that a key belongs to a handle: names are not anchored', r['does_not_prove'])
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain', f'{SERVER}/pilot/v1/ledger/committed',
                                 f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10', f'{EXPLORER}/api/v1/networkState'])
        self.assertIn(str(1 << 60), [x['committed_total'] for x in w.snapshot()['rows']], '2^60 as a decimal string, exact')
        self.assertIn(TOKEN, [x['denomination'] for x in w.snapshot()['rows']], 'the snapshot lists every denomination')

    def test_match_from_a_node_that_says_it_is_on_testnet_before_its_boxes_are_read(self):
        w = World()
        r = w.audit(NODE)
        self.assertEqual((r['verdict'], r['chain_source'], r['box_age_blocks']), ('MATCH', {'kind': 'node', 'url': NODE, 'named_by_server': False}, 41))
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain', f'{NODE}/info', f'{SERVER}/pilot/v1/ledger/committed',
                                 f'{NODE}/blockchain/box/unspent/byTokenId/{NFT}?offset=0&limit=10', f'{NODE}/info'])
        w = World()
        w.node_network = 'mainnet'
        r = w.audit(NODE)
        self.unknown(r, 'source_inconsistent', "'mainnet', not testnet")
        self.assertFalse(any('byTokenId' in u for u in w.log), 'no box is read from it')

    def test_the_order_rows_come_in_never_changes_the_verdict(self):
        for order in (lambda ns: ns[::-1], lambda ns: sorted(ns, key=lambda n: n['total']), lambda ns: ns[3:] + ns[:3]):
            w = World()
            w.published = order(w.published)
            self.assertEqual(w.audit()['verdict'], 'MATCH')

    def test_a_total_raised_by_1_a_dropped_row_or_a_fabricated_row_is_a_mismatch(self):
        changes = {'a total raised by 1': lambda ns: [dict(n, total=n['total'] + 1) if k == 1 else n for k, n in enumerate(ns)],
                   'a dropped row': lambda ns: ns[1:],
                   'a fabricated row of total 0': lambda ns: ns + [note(CAROL, DAVE, 0)],
                   'a fabricated row': lambda ns: ns + [note(CAROL, DAVE, 1_500_000)],
                   'a note turned around': lambda ns: [note(n['recipient_pubkey'], n['issuer_pubkey'], n['total']) if k == 3 else n
                                                       for k, n in enumerate(ns)]}
        for what, change in changes.items():
            w = World()
            w.published = change(w.published)
            r = w.audit()
            self.assertEqual((r['verdict'], r['reason'], vaudit.exit_code(r)), ('MISMATCH', 'records_disagree_with_chain', 1), what)
            self.assertIn(f'for box {BOX_ID}', r['message'])
            self.assertIn(digest_of(w.anchored), r['message'])
            self.assertIn(digest_of(w.published), r['message'])
            self.assertIn('consistent: false', r['message'], 'the server\'s own check is shown')
            self.assertEqual(r['rows']['digest'], digest_of(w.published))
            self.assertNotIn('does_not_prove', r)

    def test_committed_totals_that_include_a_write_after_the_anchored_digest_are_a_mismatch_even_when_the_server_says_consistent(self):
        """The mid-anchor race (upstream mark_notes_pending): the confirmed totals include a later write. The server's
        snapshot says consistent: true here (a server that does not check, or checks wrongly): the audit decides."""
        w = World()
        w.published = [dict(n, total=n['total'] + 250_000) if n['issuer_pubkey'] == BOB and n['recipient_pubkey'] == ALICE else n
                       for n in w.published]
        w.consistent = True
        r = w.audit()
        self.assertEqual((r['verdict'], r['reason']), ('MISMATCH', 'records_disagree_with_chain'))
        self.assertIn('consistent: true', r['message'])
        self.assertEqual(r['server_says']['consistent'], True)

    def test_rows_that_cannot_be_digested_are_unknown_never_a_verdict(self):
        cases = {'a duplicate debt key': lambda ns: ns + [dict(ns[2], total=7)],
                 'a total of 2^64': lambda ns: [dict(n, total=1 << 64) if k == 0 else n for k, n in enumerate(ns)],
                 'a malformed key': lambda ns: [dict(n, issuer_pubkey=n['issuer_pubkey'].upper()) if k == 0 else n for k, n in enumerate(ns)]}
        for what, change in cases.items():
            w = World()
            w.published = change(w.published)
            self.unknown(w.audit(), 'rows_malformed', 'cannot be digested as the tracker digests its notes')

    def test_a_total_written_as_a_json_number_above_2_53_minus_1_is_unknown_inexact(self):
        w = World()
        snap = w.snapshot()
        snap['rows'][8]['committed_total'] = 1 << 60          # the JSON number a JavaScript server might have rounded
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(200, snap)]
        self.unknown(w.audit(), 'inexact_total', 'rows[8]', str(1 << 60))
        w = World(committed=False)                             # GET /ledger writes every total as a JSON number
        w.anchored = [n for n in w.anchored if n['denomination'] == 'erg']
        w.published = copy.deepcopy(w.anchored)
        self.unknown(w.audit(), 'inexact_total', 'GET /pilot/v1/ledger')
        w = World()
        snap = w.snapshot()
        snap['rows'][1]['committed_total'] = 1_500_000         # a JSON number up to 2^53 - 1 is exact
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(200, snap)]
        self.assertEqual(w.audit()['verdict'], 'MATCH')

    def test_a_snapshot_for_another_box_than_the_sources_is_read_again_and_never_a_false_mismatch(self):
        w = World()
        old = copy.deepcopy(w.anchored)
        w.anchored.append(note(CAROL, DAVE, 1_000))           # the chain moved on: box NEW_BOX_ID commits one more note
        w.boxes = [w.box(NEW_BOX_ID)]
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(200, w.snapshot(old, BOX_ID)), (200, w.snapshot(w.anchored, NEW_BOX_ID))]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts'], w.sleeps), ('MATCH', 2, [vaudit.RETRY_S]))
        self.assertEqual(r['box']['box_id'], NEW_BOX_ID)
        w = World()
        w.anchored.append(note(CAROL, DAVE, 1_000))
        w.boxes = [w.box(NEW_BOX_ID)]
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(200, w.snapshot(anchored_notes(), BOX_ID))]
        r = w.audit()
        self.unknown(r, 'box_moved', BOX_ID, NEW_BOX_ID, 'run the audit again')
        self.assertEqual((r['attempts'], w.sleeps), (3, [vaudit.RETRY_S, vaudit.RETRY_S]))

    def test_a_snapshot_for_another_box_with_the_same_digest_is_a_match_with_a_warning(self):
        w = World()
        w.boxes = [w.box(NEW_BOX_ID)]                          # a refresh of an unchanged tree: another box, the same R5
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts']), ('MATCH', 1))
        self.assertIn(f"the server's rows are for box {BOX_ID}", r['warnings'][0])

    def test_a_snapshot_still_moving_is_waited_for_as_the_server_says_then_unknown(self):
        moving = (503, {'error': 'snapshot_moving', 'message': 'the tracker box moved during the read', 'retry_after_ms': 1200})
        w = World()
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [moving, moving, (200, w.snapshot)]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts'], w.sleeps), ('MATCH', 3, [1.2, 1.2]))
        w = World()
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(503, dict(moving[1], retry_after_ms=600_000))]
        r = w.audit()
        self.unknown(r, 'snapshot_moving', 'kept moving')
        self.assertEqual(w.sleeps, [vaudit.MAX_WAIT_S, vaudit.MAX_WAIT_S], 'at most MAX_WAIT_S between reads')

    def test_a_server_without_the_committed_route_the_ledger_between_two_reads_of_chain(self):
        for status, body in ((401, {'error': 'unauthorized', 'message': 'missing or invalid token'}), (404, {'error': 'not_found'})):
            w = World(committed=False, plain=True)
            w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(status, body)]
            r = w.audit()
            self.assertEqual((r['verdict'], r['rows']['from'], r['rows']['count']), ('MATCH', '/pilot/v1/ledger', 8), status)
            self.assertEqual(w.log[:5], [f'{SERVER}/pilot/v1/chain', f'{SERVER}/pilot/v1/ledger/committed', f'{SERVER}/pilot/v1/info',
                                         f'{SERVER}/pilot/v1/ledger', f'{SERVER}/pilot/v1/chain'])
            self.assertEqual(r['server_says'], {'box_id': BOX_ID, 'height': HEIGHT, 'digest': digest_of(w.anchored), 'consistent': None})
        w = World(committed=False, plain=True)
        w.published[0]['total'] += 1
        r = w.audit()
        self.assertEqual(r['verdict'], 'MISMATCH')
        self.assertIn("lists the notes in the network's denomination only", r['message'])
        w = World(committed=False)                           # the tracker holds a token note GET /ledger does not list
        w.anchored = [n for n in w.anchored if n['total'] < 2 ** 53]
        w.published = copy.deepcopy(w.anchored)
        self.assertEqual(w.audit()['verdict'], 'MISMATCH', 'the limit the module states: only the committed snapshot lists it')

    def test_the_ledger_is_not_taken_while_the_tracker_is_not_anchored_and_is_read_again_when_chain_moves_around_it(self):
        w = World(committed=False, plain=True)
        w.anchored_now = False
        r = w.audit()
        self.unknown(r, 'not_anchored', 'state waiting', 'after the next anchor')
        self.assertFalse(any('byTokenId' in u or '/ledger' == u[-7:] for u in w.log), 'neither the ledger nor the chain read')
        w = World(committed=False, plain=True)                # a server that says anchored, with two digests
        lying = w.chain()
        lying['anchoring']['local_digest'] = 'ee' * 33
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, lying)]
        self.unknown(w.audit(), 'not_anchored')
        w = World(committed=False, plain=True)
        moved = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], confirmed_box_id=NEW_BOX_ID))
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, moved), (200, w.chain)]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts'], w.sleeps), ('MATCH', 2, [vaudit.RETRY_S]))
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, moved)] * 3     # it moves around every read
        r = w.audit()
        self.unknown(r, 'ledger_moving')
        self.assertEqual(r['attempts'], 3)

    def test_a_server_that_cannot_be_read_or_names_another_construction(self):
        url = f'{SERVER}/pilot/v1/chain'
        for answer, reason in (((404, {'error': 'not_found'}), 'not_on_chain'),
                               ((503, {'error': 'testnet_bootstrapping'}), 'not_on_chain'),
                               ((200, {'network': 'valun-pilot-1', 'on_chain': False}), 'not_on_chain'),
                               ((500, {'error': 'internal error'}), 'server_unreadable'),
                               ((200, dict(World().chain(), tracker_nft_id='D1' * 32)), 'server_unreadable'),
                               ((200, ['not', 'a', 'chain']), 'not_on_chain')):
            w = World()
            w.overrides[url] = [answer]
            self.unknown(w.audit(), reason)
        snap_url = f'{SERVER}/pilot/v1/ledger/committed'
        for change, reason in ((lambda s: dict(s, construction='basis-avl/2'), 'unknown_construction'),
                               (lambda s: {k: v for k, v in s.items() if k != 'box_id'}, 'server_unreadable'),
                               (lambda s: dict(s, rows={}), 'server_unreadable')):
            w = World()
            w.overrides[snap_url] = [(200, change(w.snapshot()))]
            self.unknown(w.audit(), reason)
        w = World()
        w.overrides[snap_url] = [(502, {'error': 'internal error'})]
        self.unknown(w.audit(), 'server_unreadable', 'ledger/committed')


class Sources(AuditCase):
    def test_a_spent_box_two_boxes_a_box_without_the_nft_or_off_the_main_chain_is_source_inconsistent(self):
        def boxes(w):
            return {'a spent box': [w.box(spent='aa' * 32)],
                    'two unspent boxes': [w.box(), w.box(NEW_BOX_ID)],
                    'a box without the NFT': [w.box(amount=0)],
                    'two of the NFT\'s token': [w.box(amount=2)],
                    'a box off the main chain': [w.box(main=False)],
                    'a box without a box id': [w.box('')],
                    'a box without a creation height': [w.box(creation_height=None)]}
        for source in ('explorer', NODE):
            for what in boxes(World()):
                w = World()
                w.boxes = boxes(w)[what]
                if what == 'a box off the main chain' and source == NODE:
                    continue                                  # a node lists main-chain boxes only, with no such field
                with self.subTest(source=source, what=what):
                    self.unknown(w.audit(source), 'source_inconsistent')
        w = World()
        listed = {'items': [w.explorer_box(w.boxes[0])], 'total': 2}
        w.overrides[f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10'] = [(200, listed)]
        self.unknown(w.audit(), 'source_inconsistent', 'counts 2', 'lists 1')
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10'] = [(200, [w.explorer_box(w.boxes[0])])]
        self.unknown(w.audit(), 'source_inconsistent', '{items, total}')

    def test_no_unspent_box_holding_the_nft_is_unknown(self):
        for source in ('explorer', NODE):
            w = World()
            w.boxes = []
            self.unknown(w.audit(source), 'no_tracker_box', NFT)

    def test_an_r5_that_is_not_the_tracker_tree_is_unknown(self):
        d = digest_of(World().anchored)
        for r5, words in (('absent', 'no R5'), ('0e20' + NFT, 'not an AvlTree'), (f'64{d}031000', 'key length 16'),
                          (f'64{d}03200108', 'value length 8'), (f'64{d}03200000', 'bytes follow'), (f'64{d}03a020', 'ends before'),
                          (f'64{d}0320', 'not an AvlTree'),
                          ('64' + d[:60], 'not an AvlTree'), ('zz', 'not hex')):
            w = World()
            w.boxes = [w.box(r5=r5)]
            self.unknown(w.audit(), 'not_an_avl_tree', words)

    def test_decode_r5_reads_the_avl_tree_constant(self):
        d = 'ab' * 33
        self.assertEqual(vaudit.decode_r5(f'64{d}032000'), {'digest': d, 'flags': 3, 'key_length': 32, 'value_length': None})
        self.assertEqual(vaudit.decode_r5(f'64{d}07200108'), {'digest': d, 'flags': 7, 'key_length': 32, 'value_length': 8})
        self.assertEqual(vaudit.decode_r5(f'64{d.upper()}03800100')['key_length'], 128, 'a two-byte VLQ; hex in any case')
        for bad in (f'65{d}032000', f'64{d}03', f'64{d}0320ff', f'64{d}03ffffffffff00', '', None, 64):
            self.assertRaises(ValueError, vaudit.decode_r5, bad)

    def test_flags_other_than_03_are_shown_and_do_not_change_the_verdict(self):
        w = World()
        w.boxes = [w.box(r5='64' + digest_of(w.anchored) + '072000')]
        r = w.audit()
        self.assertEqual((r['verdict'], r['box']['flags']), ('MATCH', 7))

    def test_the_node_the_server_names_is_used_with_a_warning(self):
        for url in (OPERATOR_NODE, OPERATOR_NODE + '/', OPERATOR_NODE.replace('http://', 'HTTP://')):
            w = World()
            w.nodes.add(url.rstrip('/'))
            r = w.audit(url)
            self.assertEqual((r['verdict'], r['chain_source']['named_by_server']), ('MATCH', True), url)
            self.assertIn('the node the server itself names', r['warnings'][0])
        self.assertFalse(World().audit(NODE)['chain_source']['named_by_server'])

    def test_a_source_that_cannot_be_read_is_unknown_and_one_without_a_height_only_loses_the_age(self):
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10'] = [(502, {'error': 'bad gateway'})]
        self.unknown(w.audit(), 'source_unreadable', EXPLORER)
        w = World()
        w.overrides[f'{NODE}/info'] = [(500, {})]
        self.unknown(w.audit(NODE), 'source_unreadable', NODE)
        w = World()
        w.overrides[f'{NODE}/blockchain/box/unspent/byTokenId/{NFT}?offset=0&limit=10'] = [(404, {'error': 404, 'reason': 'not-found'})]
        self.unknown(w.audit(NODE), 'source_unreadable', 'extraIndex = true')
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10'] = [(404, {})]
        self.unknown(w.audit(), 'source_unreadable', "name the explorer's API")
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/networkState'] = [(500, {})]
        r = w.audit()
        self.assertEqual((r['verdict'], r['height'], r['box_age_blocks'], vaudit.exit_code(r)), ('MATCH', None, None, 0))
        self.assertIn("so the box's age is not known", r['warnings'][0])
        self.assertEqual(r['tracker_less_redemption_from_height'], HEIGHT + 2161, 'the windows need only the box')
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/networkState'] = [(200, {'height': HEIGHT - 2})]
        r = w.audit()
        self.assertEqual((r['verdict'], r['box_age_blocks']), ('MATCH', -2))
        self.assertIn('below the box\'s creation height', r['warnings'][0])

    def test_the_nft_as_another_token_than_the_first_is_a_warning(self):
        w = World()
        w.boxes = [w.box(tokens_before=[{'tokenId': 'cc' * 32, 'index': 0, 'amount': 5}])]
        r = w.audit()
        self.assertEqual(r['verdict'], 'MATCH')
        self.assertIn('holds the tracker NFT as its token 1', r['warnings'][0])

    def test_source_and_server_urls(self):
        self.assertEqual(vaudit.Explorer('https://api-testnet.ergoplatform.com/').api, 'https://api-testnet.ergoplatform.com/api/v1')
        self.assertEqual(vaudit.Explorer('https://api-testnet.ergoplatform.com/api/v1').api, 'https://api-testnet.ergoplatform.com/api/v1')
        self.assertEqual(vaudit.Node('http://127.0.0.1:9052/').url, 'http://127.0.0.1:9052')
        for bad in ('ftp://x.example', 'http://', 'https://x.example/?limit=1', 'x.example', ' http://x.example', 'http://x.example#f',
                    'http://x.example:0', 'http://x.example:99999', '', None):
            self.assertRaises(ValueError, vaudit.base_url, bad, '--node')
        self.assertTrue(vaudit.same_place('http://Node.Example:80/', 'http://node.example'))
        self.assertFalse(vaudit.same_place('http://node.example:9052', 'http://node.example:9053'))
        self.assertFalse(vaudit.same_place('http://node.example', None))


class Mine(AuditCase):
    def test_every_edge_of_the_participant_on_every_key_with_its_status(self):
        w = World()
        state = profile_state()
        before = copy.deepcopy(state)
        r = w.audit(profile_state=state, mine=True)
        self.assertEqual(state, before, 'the profile state is read, never changed')
        m = r['mine']
        self.assertEqual((r['verdict'], vaudit.exit_code(r)), ('MATCH', vaudit.EXIT_NOT_PROVEN))
        self.assertEqual(m['keys'], [{'pubkey': ALICE, 'known_from': 'this_agent'}, {'pubkey': ALICE_OLD, 'known_from': 'ledger'}])
        got = {(e['edge'], e['denomination']): e for e in m['edges']}
        want = {(f'{ALICE}>{BOB}', 'erg'): ('issuer', BOB_ID, 3_000_000, 'signed'),
                (f'{BOB}>{ALICE}', 'erg'): ('recipient', BOB_ID, 1_500_000, 'signed'),
                (f'{CAROL}>{ALICE}', 'erg'): ('recipient', CAROL_ID, 2_000_000, 'differs'),
                (f'{ALICE_OLD}>{DAVE}', 'erg'): ('issuer', DAVE_ID, 700_000, 'not_in_records'),
                (f'{ALICE}>{DAVE}', 'erg'): ('issuer', DAVE_ID, 100, 'signature_not_held'),
                (f'{DAVE}>{ALICE}', 'erg'): ('recipient', DAVE_ID, 50, 'bad_signature'),
                (f'{ALICE}>{BOB}', TOKEN): ('issuer', BOB_ID, 5, 'not_in_records'),
                (f'{ALICE}>{CAROL}', 'erg'): ('issuer', CAROL_ID, None, 'not_anchored')}
        self.assertEqual({k: (e['role'], e['counterparty'], e['anchored_total'], e['status']) for k, e in got.items()}, want)
        self.assertEqual((m['participant'], m['proven'], m['not_proven'], m['all_proven']), (ME, 2, 6, False))
        self.assertEqual(got[(f'{BOB}>{ALICE}', 'erg')]['signature_verified'], True)
        self.assertEqual(got[(f'{DAVE}>{ALICE}', 'erg')]['signature_verified'], False)
        self.assertEqual(got[(f'{CAROL}>{ALICE}', 'erg')]['recorded'], {'total': 2_500_000, 'timestamp': T0 + 3, 'signature': 'held'})
        self.assertEqual(got[(f'{ALICE}>{DAVE}', 'erg')]['recorded']['signature'], 'not_held')
        self.assertEqual(got[(f'{ALICE}>{DAVE}', 'erg')]['pending_totals'], [300])
        self.assertEqual(got[(f'{ALICE}>{BOB}', 'erg')]['counterparty_key'], BOB)
        self.assertTrue(all(e['status'] in vaudit.MINE_STATUS for e in m['edges']))
        self.assertFalse(any(BOB in e['edge'] and CAROL in e['edge'] for e in m['edges']), 'edges between others are not listed')
        for st in SIGNED.values():
            self.assertNotIn(st['signature'], json.dumps(r), 'no signature is printed')
        self.assertEqual(w.log[-1], f'{SERVER}/pilot/v1/ledger', 'GET /ledger names the participant of each key')

    def test_every_edge_signed_exits_0(self):
        w = World()
        w.anchored = [n for n in w.anchored if n['issuer_pubkey'] != ALICE_OLD and n['denomination'] == 'erg']
        w.published = copy.deepcopy(w.anchored)
        recs = records_of()
        recs[f'{CAROL}>{ALICE}']['confirmed'] = signed(CAROL, ALICE, 2_000_000, T0 + 7)
        recs[f'{ALICE}>{DAVE}']['confirmed'] = signed(ALICE, DAVE, 100, T0 + 4)
        recs[f'{DAVE}>{ALICE}']['confirmed'] = signed(DAVE, ALICE, 50, T0 + 8)
        del recs[f'{ALICE}>{CAROL}']
        r = w.audit(profile_state=profile_state(records=recs), mine=True)
        self.assertEqual((r['mine']['proven'], r['mine']['all_proven'], vaudit.exit_code(r)), (5, True, 0))
        r = w.audit(profile_state=profile_state(records={}), mine=True)
        self.assertEqual({e['status'] for e in r['mine']['edges']}, {'not_in_records'})
        self.assertEqual(vaudit.exit_code(r), vaudit.EXIT_NOT_PROVEN, 'no records: nothing proven')

    def test_a_mismatch_or_unknown_lists_no_edge(self):
        w = World()
        w.published[0]['total'] += 1
        r = w.audit(profile_state=profile_state(), mine=True)
        self.assertEqual((r['verdict'], 'mine' in r, vaudit.exit_code(r)), ('MISMATCH', False, 1))
        w = World()
        w.boxes = []
        r = w.audit(profile_state=profile_state(), mine=True)
        self.assertEqual((r['verdict'], 'mine' in r, vaudit.exit_code(r)), ('UNKNOWN', False, 3))

    def test_a_server_on_another_tracker_than_the_pinned_one_is_unknown_before_any_box_is_read(self):
        w = World()
        r = w.audit(profile_state=profile_state(pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}), mine=True)
        self.unknown(r, 'tracker_mismatch', 'ee' * 32)
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain'])
        r = World().audit(profile_state=profile_state(pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}))
        self.assertEqual((r['verdict'], r['tracker_nft_pinned']), ('MATCH', False),
                         "without --mine, the pins of a profile on another server are not used: any server can be audited")

    def test_the_profiles_own_server_must_name_the_pinned_tracker_with_or_without_mine(self):
        w = World()
        r = w.audit(profile_state=profile_state(server=SERVER + '/', pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}))
        self.unknown(r, 'tracker_mismatch', 'the notes it signs and verifies name that one')
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain'], 'nothing else is read')
        r = World().audit(profile_state=profile_state(server=SERVER))
        self.assertEqual((r['verdict'], r['tracker_nft_pinned']), ('MATCH', True))
        r = World().audit(profile_state=profile_state(), mine=True)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned']), ('MATCH', True), '--mine: the pin is checked on any server')
        self.assertFalse(World().audit()['tracker_nft_pinned'], 'no profile: the NFT is the server\'s word')

    def test_a_profile_without_a_pinned_tracker_and_denomination_compares_nothing_and_proves_nothing(self):
        for pins in (None, {'tracker_nft_id': NFT}):
            state = profile_state(pins=pins)
            r = World().audit(profile_state=state, mine=True)
            m = r['mine']
            self.assertEqual((r['verdict'], m['problem'], m['edges'], m['all_proven'], vaudit.exit_code(r)),
                             ('MATCH', 'no_pinned_tracker', [], False, vaudit.EXIT_NOT_PROVEN), pins)
            self.assertIn('nothing of yours is proven', m['message'])

    def test_an_unreadable_ledger_leaves_only_this_agents_key(self):
        w = World()
        w.overrides[f'{SERVER}/pilot/v1/ledger'] = [(500, {})]
        r = w.audit(profile_state=profile_state(), mine=True)
        self.assertEqual(r['mine']['keys'], [{'pubkey': ALICE, 'known_from': 'this_agent'}])
        self.assertIn('only this agent\'s own key is known', r['warnings'][0])
        self.assertNotIn(f'{ALICE_OLD}>{DAVE}', [e['edge'] for e in r['mine']['edges']])

    def test_from_the_ledger_between_two_reads_of_chain_the_ledger_read_also_names_the_keys(self):
        w = World(committed=False, plain=True)
        r = w.audit(profile_state=profile_state(), mine=True)
        self.assertEqual(r['verdict'], 'MATCH')
        self.assertEqual([u for u in w.log if u.endswith('/pilot/v1/ledger')], [f'{SERVER}/pilot/v1/ledger'], 'read once')
        self.assertIn({'pubkey': ALICE_OLD, 'known_from': 'ledger'}, r['mine']['keys'])


# ---------------------------------------------------------------------------------------------------------------------
# The command, over real HTTP.

class _Handler(BaseHTTPRequestHandler):
    world, base, requests = None, None, []

    def do_GET(self):
        type(self).requests.append({'method': 'GET', 'path': self.path, 'authorization': self.headers.get('Authorization'),
                                    'user_agent': self.headers.get('User-Agent'), 'features': self.headers.get('X-Valun-Features')})
        status, body = self.world.respond(self.base + self.path)
        raw = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):                                       # never used: the audit sends GET only
        type(self).requests.append({'method': 'POST', 'path': self.path})
        self.send_response(405)
        self.end_headers()

    def log_message(self, *a):
        pass


class Command(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        _Handler.base = cls.base
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.world = World(server=self.base, explorer=self.base, node=self.base)
        _Handler.world, _Handler.requests = self.world, []
        self.home = tempfile.mkdtemp(prefix='valun-audit-test-')
        self.addCleanup(shutil.rmtree, self.home, True)
        p = mock.patch.dict(os.environ, {'VALUN_HOME': self.home})
        p.start()
        self.addCleanup(p.stop)

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(list(argv))
        return rc, out.getvalue()

    def joined_profile(self, name='alice'):
        """A joined profile on this world's server (test-only key and token)."""
        path = os.path.join(self.home, 'profiles', f'{name}.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(dict(profile_state(), server=self.base, secret=ALICE_S.hex(), agent_token='vpa_TEST-ONLY'), f, indent=1)
        return path

    def test_match_exits_0_in_text_and_json(self):
        rc, text = self.run_cli('audit', '--explorer', self.base, '--server', self.base)
        self.assertEqual(rc, 0, text)
        self.assertTrue(text.startswith(f'MATCH: the 10 notes {self.base} publishes are exactly what its tracker box'), text)
        for words in (f'box       {BOX_ID} (created at height {HEIGHT}, 41 blocks old at height {TIP})',
                      f'R5        {digest_of(self.world.anchored)}, read from the explorer {self.base}',
                      'rows of GET /pilot/v1/ledger/committed', f'refused from height {HEIGHT + 1440}',
                      f'redemption without the tracker from height {HEIGHT + 2161}', 'It does not prove what is outstanding',
                      f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it\n'):
            self.assertIn(words, text)
        self.joined_profile()
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.base)
        self.assertEqual(rc, 0, text)
        self.assertIn(f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it, and the one this profile pinned', text)
        rc, text = self.run_cli('audit', '--node', self.base + '/', '--server', self.base + '/', '--json')
        r = json.loads(text)
        self.assertEqual((rc, r['verdict'], r['chain_source']['kind'], r['server']), (0, 'MATCH', 'node', self.base))

    def test_get_only_no_token_and_nothing_written_even_with_a_joined_profile_and_mine(self):
        path = self.joined_profile()
        files = lambda: sorted(os.listdir(os.path.dirname(path)))  # noqa: E731
        with open(path, 'rb') as f:
            before, listing = f.read(), files()
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.base, '--mine')
        self.assertEqual(rc, vaudit.EXIT_NOT_PROVEN, text)
        self.assertIn('Your edges (participant vp_a1a1a1a1a1a1', text)
        self.assertIn('2 of 8 edges proven (signed)', text)
        self.assertIn('differs             owed to you by vp_c0c0c0c0c0c0: anchored 2000000 nanoERG (0.002 tERG), your records: '
                      '2500000 nanoERG (0.0025 tERG): your records confirm another total', text)
        self.assertIn('not_anchored        you owe vp_c0c0c0c0c0c0: your records: 400000 nanoERG (0.0004 tERG): the anchored rows', text)
        self.assertIn('not_in_records      you owe vp_b0b0b0b0b0b0: anchored 5 in token:abababababababab...', text)
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), before, 'the profile is not written')
        self.assertEqual(files(), listing, 'no lock or temporary file either')
        reqs = _Handler.requests
        self.assertTrue(reqs)
        self.assertEqual({r['method'] for r in reqs}, {'GET'})
        self.assertEqual({r['authorization'] for r in reqs}, {None}, 'the agent token is never sent')
        self.assertEqual({r['features'] for r in reqs}, {None})
        self.assertEqual({r['user_agent'] for r in reqs}, {f'valun-audit/{__version__}'})
        self.assertNotIn(ALICE_S.hex(), text)
        self.assertNotIn('vpa_TEST-ONLY', text)
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.base, '--mine', '--json')
        r = json.loads(text)
        self.assertEqual((rc, r['mine']['participant']), (vaudit.EXIT_NOT_PROVEN, ME))
        self.assertNotIn(ALICE_S.hex(), text)
        self.assertNotIn('vpa_TEST-ONLY', text)

    def test_mismatch_exits_1_and_unknown_exits_3(self):
        self.world.published[0]['total'] += 1
        rc, text = self.run_cli('audit', '--explorer', self.base, '--server', self.base)
        self.assertEqual(rc, 1)
        self.assertTrue(text.startswith('MISMATCH: The 10 rows of GET /pilot/v1/ledger/committed'), text)
        self.world.published[0]['total'] -= 1
        self.world.boxes = []
        rc, text = self.run_cli('audit', '--explorer', self.base, '--server', self.base, '--mine')
        self.assertEqual(rc, vaudit.EXIT_USAGE, '--mine needs a joined profile')
        self.assertIn('is not joined yet', text)
        rc, text = self.run_cli('audit', '--explorer', self.base, '--server', self.base)
        self.assertEqual(rc, 3)
        self.assertTrue(text.startswith('UNKNOWN (no_tracker_box): not checked, so nothing is proven. The explorer at'), text)

    def test_usage_one_chain_source_exactly_and_urls(self):
        for argv in (['audit'], ['audit', '--explorer', self.base, '--node', self.base], ['audit', '--explorer']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as e:
                cli.main(argv)
            self.assertEqual(e.exception.code, 2, argv)
        for argv in (['audit', '--explorer', 'ftp://x.example'], ['audit', '--node', 'node.example'],
                     ['audit', '--explorer', self.base, '--server', 'valun.tech']):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, vaudit.EXIT_USAGE, argv)
            self.assertIn('must be an http(s) URL', text)
        self.assertEqual(_Handler.requests, [], 'nothing is read before the arguments are checked')

    def test_get_json_over_http_errors_bodies_that_are_not_json_and_no_answer(self):
        w = self.world
        w.overrides[self.base + '/e'] = [(500, {'error': 'internal error', 'message': 'boom'})]
        w.overrides[self.base + '/text'] = [(200, 'not json')]
        w.overrides[self.base + '/nan'] = [(200, '{"total": NaN}')]
        w.overrides[self.base + '/big'] = [(200, '{"total": 18446744073709551615}')]
        with self.assertRaises(vaudit.ReadError) as e:
            vaudit.get_json(self.base + '/e')
        self.assertEqual((e.exception.status, e.exception.code), (500, 'internal error'))
        self.assertIn('boom', str(e.exception))
        for path in ('/text', '/nan'):
            with self.assertRaises(vaudit.ReadError) as e:
                vaudit.get_json(self.base + path)
            self.assertIn('not JSON', str(e.exception), path)
        self.assertEqual(vaudit.get_json(self.base + '/big'), {'total': 18446744073709551615}, 'integers stay exact')
        with self.assertRaises(vaudit.ReadError) as e:
            vaudit.get_json('http://127.0.0.1:9/pilot/v1/chain', timeout=5)
        self.assertEqual(e.exception.status, None)
        self.assertIn('no answer', str(e.exception))


if __name__ == '__main__':
    unittest.main()
