"""`valun audit` and valun/audit.py (fix inbox #62, step 6b): the published ledger against the one unspent tracker-NFT box
of a chain source the user names. Offline: a fake Valun server, explorer and node answer (synthetic keys, notes and
boxes; no testnet data), and the command runs once over real HTTP on 127.0.0.1. The digest itself is held to the
tracker's own crate in test_avl.py; here the boxes commit avl.digest of the notes they are meant to commit. The World's
audits pin its tracker NFT with --tracker-nft unless a test says otherwise; the pins themselves (a profile's, the
table of known servers, the reserves) are test_audit_pin.py's.
  - MATCH from the committed snapshot (explorer and node), the box's age and the two windows; rows in any order;
  - MISMATCH: a total raised by 1, a dropped row, a fabricated row, a snapshot whose totals include a later write;
  - UNKNOWN, never a pass: malformed rows (a duplicate debt key, 2^64), a total written as a JSON number above
    2^53 - 1, a spent box, two boxes, a box without the NFT or off the main chain, no box, an R5 that is not the tree,
    a box holding the NFT other than as its first token, a node that is not on testnet (refused before its boxes are
    read), an unreadable server or source (its height included), another construction or none, a snapshot of another
    network, without its box, height or digest, or with a debt key that is not its row's, a box or snapshot that keeps
    moving (read again first: never a false MISMATCH), a ledger not anchored; a null denomination is erg;
  - a server without GET /ledger/committed: GET /ledger between two reads of GET /chain, SETTLE_S apart, so that a
    server whose public reads are cached (as the deployed one's are, 3 s per entry until it saves) and that writes the
    tracker before it saves is never a false MISMATCH; rows that give neither R5 nor the digest the server's own /chain
    names are read again and stay UNKNOWN, also without the wait or under a longer cache: a MISMATCH there needs rows
    that give that digest; an update in flight or another NFT between the reads is not the anchored state either;
  - the server's own node as the source: a warning; the server itself as the source: refused;
  - --mine: every edge of the participant on every key (this agent's, a past one GET /ledger names, one its records
    show it signed with), each one's status against the profile's records and their issuer signatures, a records edge
    on a key nothing places at its anchored total; exit 3 unless every edge is signed;
  - the command: exit codes, those of the server-side anchor audit (0 MATCH, 1 MISMATCH, 2 nothing compared), text and
    JSON, GET only, no token sent, nothing written; a profile it cannot read is exit 2 and so is a fault, never 1
    (MISMATCH), and text any stdout can print."""
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
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import __version__  # noqa: E402
from valun import audit as vaudit  # noqa: E402
from valun import avl  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import ergo  # noqa: E402

SERVER, EXPLORER, NODE = 'http://valun.invalid', 'http://explorer.invalid', 'http://node.invalid:9052'
OPERATOR_NODE = 'http://203.0.113.9:9052'               # the node GET /chain names
NFT = 'd1' * 32
BOX_ID, NEW_BOX_ID, TX_ID = 'b5' * 32, 'b6' * 32, 'e7' * 32
HEIGHT, TIP = 645189, 645230
T0 = 1794600000000
TOKEN = 'token:' + 'ab' * 32
OTHER_TRACKER = 'a7' * 32                               # a tracker some reserve at the contract trusts instead
# The testnet's Basis reserve contract (public: every GET /pilot/v1/chain names it), whose address valun.audit pins by its
# sha256: the World's reserve boxes are synthetic boxes at its ErgoTree.
with open(os.path.join(HERE, 'fixtures', 'audit-verdicts', 'reserve-contract.json'), encoding='utf-8') as _f:
    RESERVE_CONTRACT = json.load(_f)['address']
RESERVE_TREE = ergo.address_to_tree(RESERVE_CONTRACT)


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
    unspent boxes the sources list; nft: the tracker NFT GET /chain names and those boxes hold; reserves: the unspent
    boxes the explorer lists at the reserve contract GET /chain names (reserve_contract), which a node lists only for a
    POST. overrides: url -> [(status, body), ...] answered in turn (the last one repeats); a body may be a callable.
    Every request is logged."""

    def __init__(self, server=SERVER, explorer=EXPLORER, node=NODE, committed=True, plain=False, nft=NFT):
        self.server, self.explorer, self.nodes, self.nft = server, explorer, {node, OPERATOR_NODE}, nft
        self.anchored = [n for n in anchored_notes() if not plain or (n['denomination'] == 'erg' and n['total'] < 2 ** 53)]
        self.published = copy.deepcopy(self.anchored)
        self.committed, self.anchored_now, self.consistent = committed, True, None
        self.boxes = [self.box()]
        self.reserve_contract = RESERVE_CONTRACT
        self.reserves = [self.reserve_box(nft, BOB), self.reserve_box(OTHER_TRACKER, CAROL)]
        self.node_network, self.overrides, self.log, self.sleeps = 'testnet', {}, [], []

    def reserve_box(self, tracker, owner, n=0, tree=None, **kw):
        """A Basis reserve box at the contract as the explorer lists it (owner key R4, empty redemption tree R5, the NFT
        of the tracker it trusts R6, no refund R7); its address is the explorer's abbreviation of the long P2S address,
        as the explorer gives it."""
        box_id = hashlib.sha256(f'reserve {tracker} {owner} {n}'.encode()).hexdigest()
        regs = {'R4': {'serializedValue': '07' + owner, 'sigmaType': 'SGroupElement', 'renderedValue': owner},
                'R5': {'serializedValue': '64' + avl.digest([]) + '032000', 'sigmaType': 'SAvlTree', 'renderedValue': None},
                'R6': {'serializedValue': '0e20' + tracker, 'sigmaType': 'Coll[SByte]', 'renderedValue': tracker},
                'R7': {'serializedValue': '0500', 'sigmaType': 'SLong', 'renderedValue': '0'}}
        return {'boxId': box_id, 'transactionId': hashlib.sha256(box_id.encode()).hexdigest(), 'blockId': '00' * 32,
                'value': 50_000_000, 'index': 0, 'globalIndex': 2450000 + n, 'creationHeight': HEIGHT - 500,
                'settlementHeight': HEIGHT - 499, 'ergoTree': tree or RESERVE_TREE, 'address': 'Ms7smJmdbakqfwNo',
                'assets': [{'tokenId': box_id[::-1], 'index': 0, 'amount': 1, 'name': None, 'decimals': None, 'type': None}],
                'additionalRegisters': regs, 'spentTransactionId': None, 'mainChain': True, **kw}

    def box(self, box_id=BOX_ID, **kw):
        """A box the sources list: tokens_before, assets listed before the NFT; nft_index, the index the explorer gives
        the NFT (a node gives none)."""
        return {'box_id': box_id, 'creation_height': HEIGHT, 'r5': None, 'spent': None, 'amount': 1, 'main': True,
                'tokens_before': [], 'nft_index': 0, **kw}

    def r5(self):
        return '64' + digest_of(self.anchored) + '032000'

    # ---------- the answers ----------
    def chain(self, box_id=None):
        d = digest_of(self.anchored)
        return {'network': 'valun-testnet-1', 'name': 'ergo-testnet', 'on_chain': True, 'tracker_nft_id': self.nft,
                'tracker_address': '3WyfqR7EFnMFMsEcVikxmNmrb7bNrwNAbGgzBTSzBJfg1fHhMvVB',
                'reserve_contract': self.reserve_contract, 'node': OPERATOR_NODE, 'explorer': 'https://testnet.ergoplatform.com',
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
                'R6': {'serializedValue': '0e20' + self.nft, 'sigmaType': 'Coll[SByte]', 'renderedValue': self.nft}}
        if r5 != 'absent':
            regs['R5'] = {'serializedValue': r5, 'sigmaType': None, 'renderedValue': None}
        assets = b['tokens_before'] + ([{'tokenId': self.nft, 'index': b['nft_index'], 'amount': b['amount'], 'name': None,
                                         'decimals': None, 'type': None}] if b['amount'] else [])
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
            return 200, {'network': 'valun-testnet-1', 'unit': 'nanoERG', 'denomination': 'erg', 'tracker_nft_id': self.nft}
        if url == f'{s}/pilot/v1/ledger':
            return 200, self.ledger()
        if url == f'{e}/api/v1/boxes/unspent/byTokenId/{self.nft}?offset=0&limit=10':
            return 200, {'items': [self.explorer_box(b) for b in self.boxes], 'total': len(self.boxes)}
        if url.startswith(f'{e}/api/v1/boxes/unspent/byAddress/{self.reserve_contract}?'):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            offset, limit = int(q['offset']), int(q['limit'])
            return 200, {'items': self.reserves[offset:offset + limit], 'total': len(self.reserves)}
        if url == f'{e}/api/v1/networkState':
            return 200, {'lastBlockId': '00' * 32, 'height': TIP, 'maxBoxGix': 1, 'maxTxGix': 1}
        for n in self.nodes:
            if url == f'{n}/info':
                return 200, {'name': 'a test node', 'network': self.node_network, 'fullHeight': TIP, 'headersHeight': TIP}
            if url == f'{n}/blockchain/box/unspent/byTokenId/{self.nft}?offset=0&limit=10':
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
        """The audit of this world, the tracker NFT pinned with --tracker-nft (tracker_nft) to the one GET /chain names
        unless a test says otherwise (tracker_nft=None: no flag, so this profile's pin, TRACKER_NFTS or the reserves
        decide), as anchor-audit.mjs's recorded runs pin it."""
        kw.setdefault('tracker_nft', self.nft)
        src = vaudit.Explorer(self.explorer, get=self.get) if source == 'explorer' else vaudit.Node(source, get=self.get)
        return vaudit.audit(self.server, src, get=self.get, sleep=self.sleep, **kw)


class CachedServer(World):
    """The deployed server's public reads (valun-app lib/pilot/http.mjs at 68f09c0, cachedRead): GET /chain, /info and
    /ledger each served from a cache entry for ttl_ms while Pilot.generation is unchanged, the generation changing only
    in Pilot.save(); no GET /ledger/committed (401 without a token). The pilot writes the tracker before it saves
    (submitNote: POST /notes, its read-back and proof, a valun_signer re-check, then save()). A clock moves rtt_ms per
    request and as the audit sleeps. write_after: the request after whose answer the pilot records a note (the tracker's
    live totals move; the box, and so R5, does not), saved gap_ms later."""
    CACHED = {'/pilot/v1/chain': 'chain', '/pilot/v1/info': 'info', '/pilot/v1/ledger': 'ledger'}

    def __init__(self, ttl_ms, write_after=None, gap_ms=400, rtt_ms=150):
        super().__init__(committed=False, plain=True)
        self.live = copy.deepcopy(self.anchored)            # the tracker's live notes; self.anchored: what the box commits
        self.ttl, self.gen, self.cache, self.now, self.rtt, self.requests = ttl_ms, 0, {}, 0, rtt_ms, 0
        self.write_after, self.gap, self.written_at, self.saved = write_after, gap_ms, None, False

    def chain(self, box_id=None):
        c = super().chain(box_id)
        a = c['anchoring']
        a['local_digest'] = digest_of(self.live)
        a['anchored'] = a['local_digest'] == a['confirmed_digest']
        a['state'] = 'anchored' if a['anchored'] else 'waiting'
        return c

    def ledger(self):
        self.published = copy.deepcopy(self.live)
        return super().ledger()

    def answer(self, url):
        self.now += self.rtt
        self.requests += 1
        if self.written_at is not None and not self.saved and self.now >= self.written_at + self.gap:
            self.saved, self.gen = True, self.gen + 1        # Pilot.save(): every cache entry ends
        key = self.CACHED.get(url[len(self.server):]) if url.startswith(self.server) else None
        hit = self.cache.get(key)
        if key and hit and hit[1] == self.gen and self.now - hit[0] < self.ttl:
            out = hit[2]
        else:
            out = super().answer(url)
            if key:
                self.cache[key] = (self.now, self.gen, copy.deepcopy(out))
        if self.requests == self.write_after:              # POST /notes, right after this answer
            self.written_at = self.now
            self.live[0] = dict(self.live[0], total=self.live[0]['total'] + 1_000_000)
        return out

    def sleep(self, s):
        super().sleep(s)
        self.now += round(s * 1000)


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
        w = World(committed=False, plain=True)                # a published ledger that is not the state /chain names
        w.published[0]['total'] += 1
        r = w.audit()
        settle = [vaudit.SETTLE_S, vaudit.SETTLE_S]
        self.unknown(r, 'ledger_moving', f'give {digest_of(w.published)}, which is neither R5 of box {BOX_ID}',
                     f'names as the tracker\'s anchored state ({digest_of(w.anchored)})', 'not the state it calls anchored',
                     'GET /pilot/v1/ledger/committed')
        self.assertEqual((r['attempts'], w.sleeps), (3, (settle + [vaudit.RETRY_S]) * 2 + settle),
                         'read again (a ledger that moved under a longer cache looks so), and never a MISMATCH')
        w = World(committed=False)                           # the tracker holds a token note GET /ledger does not list
        w.anchored = [n for n in w.anchored if n['total'] < 2 ** 53]
        w.published = copy.deepcopy(w.anchored)
        r = w.audit()
        self.unknown(r, 'ledger_moving', "it lists the network's denomination only")
        self.assertEqual(r['attempts'], 3, 'the limit the module states: only the committed snapshot lists every note, and '
                                           'an honest operator is never accused for it')

    def test_older_reads_whose_rows_give_the_digest_the_server_names_and_not_r5_are_a_mismatch_at_once(self):
        """The server's /chain says its box commits exactly the ledger it publishes, and the box's R5 says otherwise: no
        read can move that, so there is no reading again."""
        w = World(committed=False, plain=True)
        w.published[0]['total'] += 1
        claims = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], local_digest=digest_of(w.published),
                                                confirmed_digest=digest_of(w.published)))
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, claims)]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts'], vaudit.exit_code(r)), ('MISMATCH', 1, 1))
        self.assertIn("The rows give the digest the server says that box commits", r['message'])
        self.assertIn("the server's confirmed digest is not on chain", r['message'])
        self.assertNotIn("network's denomination only", r['message'], 'they give the whole tree the server names')

    def test_the_ledger_is_not_taken_while_the_tracker_is_not_anchored_and_is_read_again_when_chain_moves_around_it(self):
        w = World(committed=False, plain=True)
        w.anchored_now = False
        r = w.audit()
        self.unknown(r, 'not_anchored', 'state waiting', 'has no committed-snapshot route yet', 'right after the next tracker box', 'pass --wait-anchored')
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
        settle = [vaudit.SETTLE_S, vaudit.SETTLE_S]               # before GET /ledger and before the second GET /chain
        self.assertEqual((r['verdict'], r['attempts'], w.sleeps), ('MATCH', 2, settle + [vaudit.RETRY_S] + settle))
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, moved)] * 3     # it moves around every read
        r = w.audit()
        self.unknown(r, 'ledger_moving')
        self.assertEqual(r['attempts'], 3)

    def test_an_update_in_flight_or_another_nft_between_the_reads_of_chain_is_not_the_anchored_state(self):
        """As anchor-audit.mjs sameAnchoring: the update in flight (pending_tx_id) must stay the same too, and so must the
        tracker NFT."""
        w = World(committed=False, plain=True)
        inflight = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], pending_tx_id='77' * 32))
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, inflight), (200, w.chain)]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts']), ('MATCH', 2), 'read again')
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, inflight)] * 3
        self.unknown(w.audit(), 'ledger_moving', 'changed while its ledger was read')
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, w.chain()), (200, dict(w.chain(), tracker_nft_id='ee' * 32))]
        self.unknown(w.audit(), 'server_inconsistent', 'another tracker NFT')
        self.assertFalse(any('byTokenId' in u for u in w.log), 'no box is read')

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

    def test_a_snapshot_names_its_construction_and_the_network_chain_names_and_one_with_no_box_yet_is_not_anchored(self):
        snap_url = f'{SERVER}/pilot/v1/ledger/committed'
        w = World()
        w.overrides[snap_url] = [(200, {k: v for k, v in w.snapshot().items() if k != 'construction'})]
        self.unknown(w.audit(), 'unknown_construction', 'names no construction', 'basis-avl/1')
        w = World()
        w.overrides[snap_url] = [(200, dict(w.snapshot(), network='valun-pilot-1'))]
        self.unknown(w.audit(), 'server_inconsistent', "'valun-pilot-1'", "'valun-testnet-1'")
        w = World()
        w.overrides[snap_url] = [(200, {k: v for k, v in w.snapshot().items() if k != 'network'})]
        self.assertEqual(w.audit()['verdict'], 'MATCH', 'a snapshot that names no network is not compared with /chain')
        w = World()
        w.overrides[snap_url] = [(503, {'error': 'no_confirmed_box', 'message': 'the tracker names no confirmed tracker box yet',
                                        'retry_after_ms': 60_000})]
        r = w.audit()
        self.unknown(r, 'not_anchored', 'names no confirmed tracker box yet', 'run the audit again in a minute')
        self.assertEqual((r['attempts'], w.sleeps), (1, []))

    def test_a_snapshot_names_its_box_height_and_digest_and_each_rows_own_debt_key(self):
        """As anchor-audit.mjs reads a snapshot: one without a box, a height or a digest compares nothing, and so does a
        row whose debt_key is not the debt key of its issuer, recipient and denomination (a null one is none)."""
        snap_url = f'{SERVER}/pilot/v1/ledger/committed'
        for what, change in (('no height', lambda s: s.pop('height')), ('a height in a string', lambda s: s.update(height=str(HEIGHT))),
                             ('no digest', lambda s: s.pop('digest')), ('a digest in capitals', lambda s: s.update(digest=s['digest'].upper())),
                             ('a digest of 32 bytes', lambda s: s.update(digest=s['digest'][2:])), ('no box', lambda s: s.pop('box_id'))):
            w = World()
            s = w.snapshot()
            change(s)
            w.overrides[snap_url] = [(200, s)]
            with self.subTest(what):
                self.unknown(w.audit(), 'server_unreadable', 'names no box, height or digest')
        w = World()
        s = w.snapshot()
        s['rows'][2]['debt_key'] = 'ab' * 32
        w.overrides[snap_url] = [(200, s)]
        self.unknown(w.audit(), 'server_inconsistent', 'rows[2]', f"names the debt key {'ab' * 32}",
                     avl.debt_key(CAROL, ALICE).hex())
        w = World()
        s = w.snapshot()
        s['rows'][2]['debt_key'] = None
        del s['rows'][3]['debt_key']
        w.overrides[snap_url] = [(200, s)]
        self.assertEqual(w.audit()['verdict'], 'MATCH', 'a row without a debt key is digested from its fields')

    def test_a_null_denomination_is_erg_as_anchor_audit_reads_it(self):
        snap_url = f'{SERVER}/pilot/v1/ledger/committed'
        for null in (lambda row: row.update(denomination=None), lambda row: row.pop('denomination')):
            w = World()
            s = w.snapshot()
            for row in s['rows']:
                if row['denomination'] == 'erg':
                    null(row)
            w.overrides[snap_url] = [(200, s)]
            r = w.audit()
            self.assertEqual((r['verdict'], r['rows']['count']), ('MATCH', 10))
        w = World()                                          # a token note written with no denomination is read as erg,
        s = w.snapshot()                                     # and its debt key (the token's) says it is not one
        s['rows'][9]['denomination'] = None
        w.overrides[snap_url] = [(200, s)]
        self.unknown(w.audit(), 'server_inconsistent', 'rows[9]', avl.debt_key(ALICE, BOB, TOKEN).hex())
        w = World(committed=False, plain=True)               # GET /ledger: the network's denomination (GET /info)
        ledger = w.ledger()
        for n in ledger['notes']:
            n['denomination'] = None
        w.overrides[f'{SERVER}/pilot/v1/ledger'] = [(200, ledger)]
        self.assertEqual(w.audit()['verdict'], 'MATCH')

    def test_what_the_server_says_of_its_box_where_the_chain_says_otherwise_is_a_warning_on_a_match(self):
        snap_url = f'{SERVER}/pilot/v1/ledger/committed'
        for change, words in ((lambda s: dict(s, digest='ee' * 33), f"the server says box {BOX_ID} commits {'ee' * 33}, and its R5 is"),
                              (lambda s: dict(s, height=HEIGHT - 3), f'was created at height {HEIGHT - 3}; the explorer says {HEIGHT}'),
                              (lambda s: dict(s, consistent=False), 'consistent: false, and they give R5')):
            w = World()
            w.overrides[snap_url] = [(200, change(w.snapshot()))]
            r = w.audit()
            self.assertEqual((r['verdict'], vaudit.exit_code(r)), ('MATCH', 0), words)
            self.assertEqual(len(r['warnings']), 1, r['warnings'])
            self.assertIn(words, r['warnings'][0])

    def test_a_mismatch_says_whether_the_rows_give_the_digest_the_server_names(self):
        w = World()
        w.published[0]['total'] += 1                          # the snapshot names R5, which the rows do not give
        self.assertIn(f"do not give the digest the server says that box commits either ({digest_of(w.anchored)})", w.audit()['message'])
        w = World()
        w.published[0]['total'] += 1
        w.overrides[f'{SERVER}/pilot/v1/ledger/committed'] = [(200, dict(w.snapshot(), digest=digest_of(w.published)))]
        r = w.audit()
        self.assertEqual((r['verdict'], r['attempts']), ('MISMATCH', 1))
        self.assertIn(f"The rows give the digest the server says that box commits ({digest_of(w.published)}), which is not its R5", r['message'])


class ServerCache(AuditCase):
    """The older reads (no GET /ledger/committed) against a server whose public reads are cached, as the deployed
    server's are (CachedServer), with a note written after GET /info and saved later: never a false MISMATCH. On this
    timeline (the fix inbox #62 review's probe_cache_race.py) the audit gave MISMATCH, exit 1, against an operator whose
    box commits exactly its anchored state."""

    def test_the_deployed_cache_and_a_note_saved_400_ms_after_it_is_written_is_never_a_mismatch(self):
        w = CachedServer(3000, write_after=3, gap_ms=400)
        r = w.audit()
        self.unknown(r, 'not_anchored', 'right after the next tracker box')
        self.assertEqual((r['attempts'], w.sleeps), (2, [vaudit.SETTLE_S, vaudit.SETTLE_S, vaudit.RETRY_S]),
                         'the ledger and the second /chain each wait out the cache; the second /chain shows the write')
        self.assertEqual(CachedServer(3000).audit()['verdict'], 'MATCH', 'no write: the cached reads are the anchored state')

    def test_each_guard_alone_keeps_the_deployed_cache_from_a_mismatch(self):
        """The wait: the second /chain is computed after the ledger, so it shows the write, whatever the gap before the
        save. Without the wait (SETTLE_S 0) the second /chain is the first one's cached answer, older than the note the
        ledger shows: the rows then give neither R5 nor the digest /chain names, and are read again, never a MISMATCH."""
        for gap in (400, 3_000, 10_000):
            r = CachedServer(3000, write_after=3, gap_ms=gap).audit(attempts=1)   # one attempt: no reading again
            self.unknown(r, 'ledger_moving', 'changed while its ledger was read')
        with mock.patch.object(vaudit, 'SETTLE_S', 0.0):
            w = CachedServer(3000, write_after=3, gap_ms=400)
            r = w.audit(attempts=1)
            self.unknown(r, 'ledger_moving', f'give {digest_of(w.live)}, which is neither R5', 'not the state it calls anchored')
            self.assertEqual(w.sleeps, [0.0, 0.0])
            w = CachedServer(3000, write_after=3, gap_ms=400)
            r = w.audit()
            self.unknown(r, 'not_anchored', 'right after the next tracker box')
            self.assertEqual((r['attempts'], w.sleeps), (2, [0.0, 0.0, vaudit.RETRY_S]), 'read again: then the write shows')

    def test_a_cache_longer_than_the_wait_is_read_again_and_never_a_mismatch(self):
        w = CachedServer(10_000, write_after=3, gap_ms=10_000)                 # a server set to cache for 10 s
        r = w.audit()
        self.unknown(r, 'not_anchored')
        self.assertEqual(r['attempts'], 2)
        r = CachedServer(10_000, write_after=3, gap_ms=10_000).audit(attempts=1)
        self.unknown(r, 'ledger_moving', 'not the state it calls anchored', 'a server cache longer than this audit waits')


class WaitAnchored(AuditCase):
    """Fix inbox #86: a server without GET /ledger/committed compares only while its published ledger is the anchored
    state, and says so plainly when it is ahead of the box; --wait-anchored waits (GET /chain every WAIT_POLL_S, for at
    most the seconds given) until the tracker's state is anchored, then audits."""

    def ahead(self, w):
        return dict(w.chain(), anchoring=dict(w.chain()['anchoring'], anchored=False, local_digest='ff' * 33, state='waiting'))

    def test_without_the_committed_route_the_message_says_why_nothing_is_compared(self):
        w = World(committed=False, plain=True)
        w.anchored_now = False
        r = w.audit()
        self.unknown(r, 'not_anchored', 'this server has no committed-snapshot route yet (GET /pilot/v1/ledger/committed is not '
                                        'deployed on it)', 'only while that ledger is the state its last tracker box anchored',
                     'Right now the ledger is ahead of that box', 'Run the audit right after the next tracker box',
                     'or pass --wait-anchored to wait for it')
        self.assertNotIn('waited', r['message'])
        self.assertIsNone(r['waited_s'])

    def test_it_waits_for_the_next_box_then_compares_the_ledger(self):
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, self.ahead(w))] * 3 + [(200, w.chain)]
        said = []
        r = w.audit(wait_anchored=60, log=said.append)
        self.assertEqual((r['verdict'], r['waited_s'], r['rows']['from']), ('MATCH', 3 * vaudit.WAIT_POLL_S, '/pilot/v1/ledger'))
        self.assertEqual(w.sleeps, [vaudit.WAIT_POLL_S] * 3 + [vaudit.SETTLE_S] * 2)
        self.assertEqual(len(said), 1)
        self.assertIn('waiting up to 60 s for the next box, reading GET /pilot/v1/chain every 15 s', said[0])
        w = World(committed=False, plain=True)                # anchored already: no wait, nothing said
        said = []
        r = w.audit(wait_anchored=60, log=said.append)
        self.assertEqual((r['verdict'], r['waited_s'], said), ('MATCH', 0.0, []))

    def test_the_wait_is_bounded_and_then_unknown_says_how_long_it_waited(self):
        w = World(committed=False, plain=True)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, self.ahead(w))]
        r = w.audit(wait_anchored=40)
        self.unknown(r, 'not_anchored', 'and it was so still when the 40 s this audit waited for a box ran out (--wait-anchored)',
                     'or wait longer (--wait-anchored SECONDS)')
        self.assertNotIn('or pass --wait-anchored', r['message'])
        self.assertEqual((r['waited_s'], w.sleeps), (40.0, [15.0, 15.0, 10.0]))
        self.assertEqual(vaudit.exit_code(r), vaudit.EXIT_UNKNOWN, 'the verdict table: UNKNOWN is exit 2')

    def test_the_reads_count_against_the_wait_on_its_clock(self):
        """The 0.7.2 review: the wait ends at its deadline on the clock, reads included (0.7.2 before it counted only its
        sleeps, so a server slow to answer made 600 s nearer 1800 s); it may end one read after it, never later."""
        w = World(committed=False, plain=True)
        url = f'{SERVER}/pilot/v1/chain'
        w.overrides[url] = [(200, self.ahead(w))]
        now = [0.0]
        get = w.get

        def slow(u):
            if u == url:
                now[0] += 30.0                  # each read of GET /chain takes 30 s (a server that answers at its timeout)
            return get(u)
        w.get = slow

        def sleep(s):
            w.sleeps.append(s)
            now[0] += s
        src = vaudit.Explorer(w.explorer, get=w.get)
        r = vaudit.audit(w.server, src, get=w.get, sleep=sleep, clock=lambda: now[0], tracker_nft=w.nft, wait_anchored=100)
        self.unknown(r, 'not_anchored', 'ran out (--wait-anchored)')
        self.assertEqual(w.sleeps, [15.0, 15.0, 10.0], 'read, 15 s, read (30 s), 15 s ... until 100 s are gone')
        self.assertLessEqual(now[0], 100 + 30 + 30, 'the deadline, one read after it, and the read the attempt makes')
        self.assertEqual(r['waited_s'], 130.0, 'what the clock says it waited, its reads included')

    def test_a_state_that_moves_on_after_the_wait_is_waited_for_again_under_the_same_deadline(self):
        """The 0.7.2 review: the state is anchored at the wait's first poll, then the ledger moves while it is read (a
        note arrived: ledger_moving), and GET /chain is ahead again: the next attempt waits again, under the deadline the
        first wait had (0.7.2 before it ended UNKNOWN at once, saying the state stayed unanchored)."""
        w = World(committed=False, plain=True)
        ahead = self.ahead(w)
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, ahead), (200, w.chain), (200, ahead), (200, ahead), (200, w.chain)]
        r = w.audit(wait_anchored=600)
        self.assertEqual((r['verdict'], r['attempts']), ('MATCH', 2), r['message'])
        self.assertEqual(r['waited_s'], 2 * vaudit.WAIT_POLL_S)
        w = World(committed=False, plain=True)                # and when the deadline is gone, it says so truly
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, ahead), (200, w.chain), (200, ahead)]
        r = w.audit(wait_anchored=20)
        self.unknown(r, 'not_anchored', f"when the {r['waited_s']:g} s this audit waited for a box ran out (--wait-anchored)")
        self.assertLessEqual(r['waited_s'], 20, 'the second wait had what was left of the 20 s, the first one\'s deadline')

    def test_a_failed_read_while_waiting_is_read_again_and_another_nft_is_unknown(self):
        w = World(committed=False, plain=True)
        url = f'{SERVER}/pilot/v1/chain'
        w.overrides[url] = [(200, self.ahead(w)), (502, {'error': 'bad_gateway'}), (200, w.chain)]
        self.assertEqual(w.audit(wait_anchored=60)['verdict'], 'MATCH')
        w = World(committed=False, plain=True)
        w.overrides[url] = [(200, self.ahead(w)), (200, dict(w.chain(), tracker_nft_id='ee' * 32))]
        self.unknown(w.audit(wait_anchored=60), 'server_inconsistent', 'another tracker NFT')
        self.assertFalse(any('byTokenId' in u for u in w.log), 'no box is read')

    def test_with_the_committed_route_it_waits_too_so_mine_compares_records_the_box_caught_up_with(self):
        w = World()
        w.overrides[f'{SERVER}/pilot/v1/chain'] = [(200, self.ahead(w)), (200, w.chain)]
        r = w.audit(wait_anchored=60, profile_state=profile_state(), mine=True)
        self.assertEqual((r['verdict'], r['waited_s'], r['rows']['from']), ('MATCH', vaudit.WAIT_POLL_S, '/pilot/v1/ledger/committed'))
        self.assertIn('mine', r)


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

    def test_a_source_that_cannot_be_read_or_gives_no_height_is_unknown(self):
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
        # The source's height (the box's age and windows) is part of the audit, as anchor-audit.mjs reads it: none is
        # UNKNOWN, whatever the digests (a MISMATCH too: nothing is compared without it).
        for published in (lambda ns: ns, lambda ns: ns[1:]):
            w = World()
            w.published = published(w.published)
            w.overrides[f'{EXPLORER}/api/v1/networkState'] = [(500, {})]
            self.unknown(w.audit(), 'source_unreadable', "did not give its height, so the box's age is not known", EXPLORER)
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/networkState'] = [(200, {'lastBlockId': '00' * 32})]
        self.unknown(w.audit(), 'source_inconsistent', 'did not give its height')
        w = World()
        w.overrides[f'{NODE}/info'] = [(200, {'network': 'testnet', 'fullHeight': TIP}), (200, {'network': 'testnet'})]
        self.unknown(w.audit(NODE), 'source_inconsistent', 'fullHeight')
        w = World()
        w.overrides[f'{EXPLORER}/api/v1/networkState'] = [(200, {'height': HEIGHT - 2})]
        r = w.audit()
        self.assertEqual((r['verdict'], r['box_age_blocks']), ('MATCH', -2))
        self.assertIn('below the box\'s creation height', r['warnings'][0])

    def test_the_nft_as_another_token_than_the_first_is_unknown_when_the_rows_give_r5(self):
        """The reserve contract reads a tracker box's NFT as its first token (basis.es tracker.tokens(0)): no redemption
        can use another box. anchor-audit.mjs calls it a MISMATCH; here it is never a MATCH (UNKNOWN), and rows that do
        not give R5 stay a MISMATCH, with the warning."""
        before = [{'tokenId': 'cc' * 32, 'index': 0, 'amount': 5}]
        for source in ('explorer', NODE):
            w = World()
            w.boxes = [w.box(tokens_before=before, nft_index=1)]
            r = w.audit(source)
            with self.subTest(source=source):
                self.unknown(r, 'nft_not_first', 'holds the tracker NFT as its token 1', 'tracker.tokens(0)', 'nothing is proven')
                self.assertEqual((r['box']['box_id'], r['nettings_refused_from_height'], r['tracker_less_redemption_from_height']),
                                 (BOX_ID, None, None), 'the box is shown, and no window: no redemption can use it')
        w = World()
        w.boxes = [w.box(tokens_before=before, nft_index=1)]
        w.published[0]['total'] += 1
        r = w.audit()
        self.assertEqual((r['verdict'], vaudit.exit_code(r)), ('MISMATCH', 1))
        self.assertIn('holds the tracker NFT as its token 1', r['warnings'][0])
        w = World()                                           # listed second, and its index says it is the first
        w.boxes = [w.box(tokens_before=[{'tokenId': 'cc' * 32, 'index': 1, 'amount': 5}], nft_index=0)]
        r = w.audit()
        self.assertEqual((r['verdict'], r['warnings']), ('MATCH', []), "the explorer's index orders the tokens")
        self.assertEqual(w.audit(NODE)['reason'], 'nft_not_first', 'a node gives no index: the order it lists them in')
        text = '\n'.join(cli._audit_lines(World().audit(), False))
        self.assertIn('  windows   nettings of anchored edges refused from height', text)
        w = World()
        w.boxes = [w.box(tokens_before=before, nft_index=1)]
        text = '\n'.join(cli._audit_lines(w.audit(), False))
        self.assertTrue(text.startswith('UNKNOWN (nft_not_first): '), text)
        self.assertIn(f'  box       {BOX_ID}', text)
        self.assertNotIn('windows', text)

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
        self.assertEqual((r['verdict'], 'mine' in r, vaudit.exit_code(r)), ('UNKNOWN', False, 2))

    def test_a_server_on_another_tracker_than_the_pinned_one_is_unknown_before_any_box_is_read(self):
        w = World()
        r = w.audit(profile_state=profile_state(pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}), mine=True,
                    tracker_nft=None)
        self.unknown(r, 'tracker_mismatch', f'names tracker NFT {NFT}, not {"ee" * 32}, the one this profile is pinned to')
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain'])
        r = World().audit(profile_state=profile_state(pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}), tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['tracker']['reserves_naming_it']), ('MATCH', False, 1),
                         'without --mine, the pins of a profile on another server are not used: any server can be audited, '
                         'and this one, which this audit pins no NFT for, by what the reserves say')

    def test_the_profiles_own_server_must_name_the_pinned_tracker_with_or_without_mine(self):
        w = World()
        r = w.audit(profile_state=profile_state(server=SERVER + '/', pins={'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'}),
                    tracker_nft=None)
        self.unknown(r, 'tracker_mismatch', 'the notes it signs and verifies name that one')
        self.assertEqual(w.log, [f'{SERVER}/pilot/v1/chain'], 'nothing else is read')
        r = World().audit(profile_state=profile_state(server=SERVER), tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['tracker']['pinned_by']), ('MATCH', True, 'profile'))
        r = World().audit(profile_state=profile_state(), mine=True, tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned']), ('MATCH', True), '--mine: the pin is checked on any server')
        r = World().audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['tracker']['pinned_by']), ('MATCH', False, None),
                         'no profile and a server this audit does not know: only the reserves name the NFT')

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
        self.assertIn('only this agent\'s own key and the keys this profile\'s records show are known', r['warnings'][0])
        self.assertNotIn(f'{ALICE_OLD}>{DAVE}', [e['edge'] for e in r['mine']['edges']])

    def test_a_records_edge_on_a_key_nothing_places_is_compared_at_its_anchored_total_never_not_anchored(self):
        """GET /ledger unreadable leaves only this agent's key; the records hold an edge on the participant's past key,
        anchored at the recorded total, with a signature that verifies."""
        w = World()
        w.anchored.append(note(CAROL, ALICE_OLD, 1_234))       # another anchored edge on that past key
        w.published = copy.deepcopy(w.anchored)
        w.overrides[f'{SERVER}/pilot/v1/ledger'] = [(500, {})]
        recs = records_of()
        recs[f'{ALICE_OLD}>{DAVE}'] = {'confirmed': signed(ALICE_OLD, DAVE, 700_000, T0 + 11), 'pending': []}
        r = w.audit(profile_state=profile_state(records=recs), mine=True)
        m = r['mine']
        got = {e['edge']: e for e in m['edges']}
        e = got[f'{ALICE_OLD}>{DAVE}']
        self.assertEqual((e['status'], e['anchored_total'], e['signature_verified'], e['role']), ('signed', 700_000, True, None),
                         'compared at its anchored total; which side is this agent cannot be told')
        self.assertEqual(m['keys'], [{'pubkey': ALICE, 'known_from': 'this_agent'}])
        self.assertNotIn(f'{CAROL}>{ALICE_OLD}', got, 'a key nothing places lists no other edge')
        self.assertIn(f'signed              edge {ALICE_OLD[:10]}...>{DAVE[:10]}...: anchored 700000 nanoERG',
                      '\n'.join(cli._audit_lines(r, True)))
        # A pending entry this client signed as that edge's issuer places the key: the edge's role, and its other edges.
        recs[f'{ALICE_OLD}>{DAVE}']['pending'] = [{'total': 800_000, 'timestamp': T0 + 12, 'kind': 'note', 'ref': 'vd_' + '56' * 8,
                                                   'direction': 'out', 'signed_at': None}]
        r = w.audit(profile_state=profile_state(records=recs), mine=True)
        m = r['mine']
        got = {e['edge']: e for e in m['edges']}
        self.assertEqual(m['keys'], [{'pubkey': ALICE, 'known_from': 'this_agent'}, {'pubkey': ALICE_OLD, 'known_from': 'records'}])
        e = got[f'{ALICE_OLD}>{DAVE}']
        self.assertEqual((e['status'], e['role'], e['counterparty_key'], e['pending_totals']), ('signed', 'issuer', DAVE, [800_000]))
        self.assertEqual((got[f'{CAROL}>{ALICE_OLD}']['status'], got[f'{CAROL}>{ALICE_OLD}']['role']), ('not_in_records', 'recipient'))
        lines = '\n'.join(cli._audit_lines(r, True))
        self.assertIn(f'{ALICE_OLD[:10]}... (signed with, by your records)', lines)
        self.assertIn(f'signed              you owe {DAVE[:16]}: anchored 700000 nanoERG', lines)

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
        """Two local servers: base, the Valun server; chain, the explorer and the node (a chain source of the server's own
        origin is refused). One world answers both, and _Handler.requests logs both."""
        cls.httpds, bases = [], []
        for _ in range(2):
            handler = type('_OneHandler', (_Handler,), {})
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            handler.base = f'http://127.0.0.1:{httpd.server_address[1]}'
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            cls.httpds.append(httpd)
            bases.append(handler.base)
        cls.base, cls.chain = bases

    @classmethod
    def tearDownClass(cls):
        for httpd in cls.httpds:
            httpd.shutdown()
            httpd.server_close()

    def setUp(self):
        self.world = World(server=self.base, explorer=self.chain, node=self.chain)
        _Handler.world, _Handler.requests = self.world, []
        self.home = tempfile.mkdtemp(prefix='valun-audit-test-')
        self.addCleanup(shutil.rmtree, self.home, True)
        p = mock.patch.dict(os.environ, {'VALUN_HOME': self.home})
        p.start()
        self.addCleanup(p.stop)

    def run_cli(self, *argv, encoding=None):
        """cli.main(argv): (exit code, what it printed). encoding: a stdout that writes that code page (as a redirected
        stdout on Windows writes the ANSI one), else one that takes any character."""
        out = io.TextIOWrapper(io.BytesIO(), encoding=encoding, newline='\n') if encoding else io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(list(argv))
        if not encoding:
            return rc, out.getvalue()
        out.flush()
        return rc, out.buffer.getvalue().decode(encoding)

    def joined_profile(self, name='alice'):
        """A joined profile on this world's server (test-only key and token)."""
        path = os.path.join(self.home, 'profiles', f'{name}.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(dict(profile_state(), server=self.base, secret=ALICE_S.hex(), agent_token='vpa_TEST-ONLY'), f, indent=1)
        return path

    def test_match_exits_0_in_text_and_json(self):
        """A server this audit pins no NFT for (the local one): the reserves at the pinned reserve contract are asked,
        and the MATCH warns that the NFT is not pinned. A profile's pin, and --tracker-nft (which a node needs: it lists
        no reserve for a GET), say how the NFT was pinned."""
        rc, text = self.run_cli('audit', '--explorer', self.chain, '--server', self.base)
        self.assertEqual(rc, 0, text)
        self.assertTrue(text.startswith(f'MATCH: the 10 notes {self.base} publishes are exactly what its tracker box'), text)
        for words in (f'box       {BOX_ID} (created at height {HEIGHT}, 41 blocks old at height {TIP})',
                      f'R5        {digest_of(self.world.anchored)}, read from the explorer {self.chain}',
                      'rows of GET /pilot/v1/ledger/committed', f'refused from height {HEIGHT + 1440}',
                      f'redemption without the tracker from height {HEIGHT + 2161}', 'It does not prove what is outstanding',
                      f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it; not pinned: 1 reserve box at the pinned reserve '
                      'contract names it\n',
                      f'warning: the tracker NFT {NFT} is not pinned for {self.base}: 1 reserve box at the pinned reserve '
                      'contract names it, which an operator can arrange for a tracker of its own too; pin it with --tracker-nft'):
            self.assertIn(words, text)
        self.joined_profile()
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.chain)
        self.assertEqual(rc, 0, text)
        self.assertIn(f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it, and the one this profile pinned; 1 reserve box '
                      'at the pinned reserve contract names it\n', text)
        self.assertNotIn('warning', text)
        rc, text = self.run_cli('audit', '--node', self.chain + '/', '--server', self.base + '/', '--json')
        r = json.loads(text)
        self.assertEqual((rc, r['verdict'], r['reason']), (2, 'UNKNOWN', 'tracker_not_pinned'))
        self.assertIn('lists the boxes at the reserve contract only for a POST', r['message'])
        rc, text = self.run_cli('audit', '--node', self.chain + '/', '--server', self.base + '/', '--json', '--tracker-nft', NFT)
        r = json.loads(text)
        self.assertEqual((rc, r['verdict'], r['chain_source']['kind'], r['server']), (0, 'MATCH', 'node', self.base))
        self.assertEqual(r['tracker'], {'nft': NFT, 'pin': NFT, 'pinned_by': 'you', 'reserves_naming_it': None})
        rc, text = self.run_cli('audit', '--node', self.chain, '--server', self.base, '--tracker-nft', NFT)
        self.assertIn(f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it, and the one you pinned (--tracker-nft)\n', text)

    def test_mine_refreshes_the_records_first_with_the_agent_token_on_the_profiles_own_server_only(self):
        """0.7.2 (#86): --mine first refreshes the records as valun_status does: GET /pilot/v1/info and, where the server
        shows edges, GET /pilot/v1/edges from the profile's own server, the agent token on the edges read only; the
        audit's own reads carry none. This world's GET /info lists no feature that shows edges, so only it is read."""
        self.joined_profile()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.chain, '--mine')
        self.assertEqual(rc, vaudit.EXIT_NOT_PROVEN, text)
        reqs = _Handler.requests
        self.assertEqual({r['method'] for r in reqs}, {'GET'})
        refresh = [r for r in reqs if r['user_agent'] != f'valun-audit/{__version__}']
        self.assertTrue(refresh and all(r['path'].startswith(('/pilot/v1/info', '/pilot/v1/edges')) for r in refresh), refresh)
        self.assertEqual({r['authorization'] for r in reqs if r not in refresh}, {None}, "the audit's own reads send no token")
        self.assertEqual({r['authorization'] for r in refresh if r['path'].startswith('/pilot/v1/info')}, {None})
        self.assertEqual([r['path'] for r in refresh], ['/pilot/v1/info'], 'no edges shown here: nothing else is read')
        self.assertEqual(err.getvalue(), '')
        self.assertNotIn('vpa_TEST-ONLY', text + err.getvalue())
        _Handler.requests = []
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.chain, '--mine', '--server', self.chain)
        self.assertEqual(rc, vaudit.EXIT_USAGE, 'the chain source itself as the server: refused before anything is read')

    def test_get_only_no_token_and_nothing_written_even_with_a_joined_profile_and_mine(self):
        path = self.joined_profile()
        files = lambda: sorted(os.listdir(os.path.dirname(path)))  # noqa: E731
        with open(path, 'rb') as f:
            before, listing = f.read(), files()
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.chain, '--mine', '--no-refresh')
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
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.chain, '--mine', '--json', '--no-refresh')
        r = json.loads(text)
        self.assertEqual((rc, r['mine']['participant']), (vaudit.EXIT_NOT_PROVEN, ME))
        self.assertNotIn(ALICE_S.hex(), text)
        self.assertNotIn('vpa_TEST-ONLY', text)

    def test_tracker_nft_pins_the_nft_and_one_that_is_no_token_id_is_a_usage_error(self):
        """--tracker-nft ID: the server must name that NFT, else nothing is compared (exit 2, naming both; only GET /chain
        is read). One that is not a token id is a usage error, before anything is read. Without it, a server the table
        knows (TRACKER_NFTS: here made to know this one) is held to its pin, which the flag overrides."""
        argv = ('audit', '--explorer', self.chain, '--server', self.base)
        for bad in (NFT.upper(), NFT[:-2], 'zz' * 32, ''):
            rc, text = self.run_cli(*argv, '--tracker-nft', bad)
            self.assertEqual(rc, vaudit.EXIT_USAGE, bad)
            self.assertIn('--tracker-nft must be a token id: 64 lowercase hex characters', text)
        self.assertEqual(_Handler.requests, [], 'nothing is read before the arguments are checked')
        rc, text = self.run_cli(*argv, '--tracker-nft', 'ee' * 32)
        self.assertEqual(rc, vaudit.EXIT_UNKNOWN, text)
        self.assertTrue(text.startswith(f'UNKNOWN (tracker_mismatch): not checked, so nothing is proven. The server {self.base} '
                                        f'names tracker NFT {NFT}, not {"ee" * 32}, the one you pinned (--tracker-nft)'), text)
        self.assertEqual([r['path'] for r in _Handler.requests], ['/pilot/v1/chain'])
        with mock.patch.dict(vaudit.TRACKER_NFTS, {self.base: 'ee' * 32}):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, vaudit.EXIT_UNKNOWN, text)
            self.assertIn(f'names tracker NFT {NFT}, not {"ee" * 32}, the one this audit pins for {self.base}', text)
            self.assertIn(f'then pass --tracker-nft {NFT}', text)
            rc, text = self.run_cli(*argv, '--tracker-nft', NFT, '--json')
            r = json.loads(text)
            self.assertEqual((rc, r['verdict'], r['tracker']['pinned_by']), (0, 'MATCH', 'you'), 'the flag overrides the table')
            self.assertIn(f'this audit pins tracker {"ee" * 32} for {self.base}', r['warnings'][0])
        with mock.patch.dict(vaudit.TRACKER_NFTS, {self.base: NFT}):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, 0, text)
            self.assertIn(f'names it, and the one this audit pins for {self.base}\n', text)
            self.assertNotIn('warning', text)

    def test_mismatch_exits_1_and_unknown_exits_2(self):
        self.world.published[0]['total'] += 1
        rc, text = self.run_cli('audit', '--explorer', self.chain, '--server', self.base)
        self.assertEqual(rc, 1)
        self.assertTrue(text.startswith('MISMATCH: The 10 rows of GET /pilot/v1/ledger/committed'), text)
        self.world.published[0]['total'] -= 1
        self.world.boxes = []
        rc, text = self.run_cli('audit', '--explorer', self.chain, '--server', self.base, '--mine')
        self.assertEqual(rc, vaudit.EXIT_USAGE, '--mine needs a joined profile')
        self.assertIn('is not joined yet', text)
        rc, text = self.run_cli('audit', '--explorer', self.chain, '--server', self.base)
        self.assertEqual(rc, 2)
        self.assertTrue(text.startswith('UNKNOWN (no_tracker_box): not checked, so nothing is proven. The explorer at'), text)

    def test_the_exit_codes_are_those_of_the_server_side_anchor_audit(self):
        """valun-app scripts/ops/anchor-audit.mjs EXIT {MATCH: 0, MISMATCH: 1, INCONSISTENT: 2, REFUSED: 2}, and a fault
        of it 2: one code for every audit that compared nothing, so one watcher reads both. --mine has no counterpart."""
        self.assertEqual((vaudit.EXIT_MATCH, vaudit.EXIT_MISMATCH, vaudit.EXIT_NOTHING_COMPARED, vaudit.EXIT_NOT_PROVEN), (0, 1, 2, 3))
        self.assertEqual((vaudit.EXIT_UNKNOWN, vaudit.EXIT_USAGE), (2, 2))
        self.assertEqual([vaudit.exit_code({'verdict': v}) for v in ('MATCH', 'MISMATCH', 'UNKNOWN', None)], [0, 1, 2, 2])
        self.assertEqual(vaudit.exit_code({'verdict': 'MATCH', 'mine': {'all_proven': False}}), 3)
        self.assertEqual(vaudit.exit_code({'verdict': 'MATCH', 'mine': {'all_proven': True}}), 0)

    def test_a_profile_it_cannot_read_and_a_fault_are_exit_2_never_1(self):
        """Exit 1 is a MISMATCH found by a comparison, and nothing else: a watcher reading exit codes must never see it
        for a profile it could not read or a fault of the command."""
        argv = ('audit', '--explorer', self.chain, '--server', self.base)
        rc, text = self.run_cli('--profile', 'Bad Name!', *argv)
        self.assertEqual(rc, vaudit.EXIT_USAGE, text)
        self.assertIn("Profile 'bad name!' cannot be used (a profile name is 1-32 lowercase letters", text)
        os.makedirs(os.path.join(self.home, 'profiles'), exist_ok=True)
        for name, content in (('broken', '{"server": '), ('listed', '["not", "a", "profile"]')):
            with open(os.path.join(self.home, 'profiles', f'{name}.json'), 'w', encoding='utf-8') as f:
                f.write(content)
            rc, text = self.run_cli('--profile', name, *argv)
            self.assertEqual(rc, vaudit.EXIT_USAGE, text)
            self.assertIn(f"Profile '{name}' cannot be used", text)
        self.assertEqual(_Handler.requests, [], 'nothing is read for a profile that cannot be used')
        with mock.patch.object(vaudit, 'audit', side_effect=RuntimeError('a bug')):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, vaudit.EXIT_NOTHING_COMPARED, text)
            self.assertTrue(text.startswith('UNKNOWN (fault): not checked, so nothing is proven. The audit itself failed '
                                            '(RuntimeError: a bug), so nothing was compared.'), text)
            rc, text = self.run_cli(*argv, '--json')
            self.assertEqual((rc, json.loads(text)['verdict'], json.loads(text)['reason']), (2, 'UNKNOWN', 'fault'))
        # A profile that reads as JSON whose server is not a string: exit 2 too, before the audit runs (a usage error
        # since the RC's review, round 3, which names the setting: client.server_problem; a fault before, AttributeError).
        with open(os.path.join(self.home, 'profiles', 'odd.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': 5}, f)
        rc, text = self.run_cli('--profile', 'odd', 'audit', '--explorer', self.chain)
        self.assertEqual(rc, 2, text)
        self.assertTrue(text.startswith("This profile's server must be an http(s) URL with a host, such as "
                                        'https://valun.tech: it is not text. Nothing was sent.'), text)
        self.assertEqual(_Handler.requests, [])

    def test_any_character_a_server_writes_prints_on_a_stdout_that_cannot_encode_it(self):
        """A redirected stdout on Windows writes the ANSI code page (cp1252 here): text from a server, explorer or node
        that it cannot encode is printed as '?', and the exit code stays the verdict's (UNKNOWN: 2, never a crash's 1)."""
        self.world.overrides[f'{self.base}/pilot/v1/chain'] = [(500, {'error': 'internal_error',
                                                                      'message': 'the tracker is restarting → try again'})]
        argv = ('audit', '--explorer', self.chain, '--server', self.base)
        rc, text = self.run_cli(*argv, encoding='cp1252')
        self.assertEqual(rc, vaudit.EXIT_UNKNOWN, text)
        self.assertTrue(text.startswith('UNKNOWN (server_unreadable): not checked'), text)
        self.assertIn('the tracker is restarting ? try again', text)
        rc, text = self.run_cli(*argv, '--json', encoding='cp1252')
        self.assertEqual((rc, json.loads(text)['reason']), (vaudit.EXIT_UNKNOWN, 'server_unreadable'))
        self.assertIn('the tracker is restarting → try again', json.loads(text)['message'], 'the JSON keeps it, escaped')

    def test_the_server_itself_is_never_the_chain_source(self):
        for argv in (('audit', '--explorer', self.base, '--server', self.base),
                     ('audit', '--node', self.base + '/node', '--server', self.base + '/'),
                     ('audit', '--explorer', self.base.replace('http://', 'HTTP://') + '/api/v1', '--server', self.base)):
            rc, text = self.run_cli(*argv)
            self.assertEqual(rc, vaudit.EXIT_USAGE, argv)
            self.assertIn('is the server itself', text)
        self.joined_profile()
        rc, text = self.run_cli('--profile', 'alice', 'audit', '--explorer', self.base)      # the profile's server
        self.assertEqual(rc, vaudit.EXIT_USAGE, text)
        self.assertEqual(_Handler.requests, [], 'nothing is read')
        self.assertTrue(vaudit.same_origin('HTTP://Node.Example:80/a', 'http://node.example/b'))
        self.assertFalse(vaudit.same_origin('http://node.example:9052', 'http://node.example:9053'))
        self.assertFalse(vaudit.same_origin('https://node.example', 'http://node.example'))
        self.assertFalse(vaudit.same_origin('http://node.example', None))

    def test_wait_anchored_takes_seconds_or_its_default_and_refuses_anything_else(self):
        """--wait-anchored (fix inbox #86): without a value the default (WAIT_ANCHORED_S), else 1 to a day of seconds; a
        tracker already anchored is audited at once. Anything else is a usage error, before anything is read."""
        argv = ('audit', '--explorer', self.chain, '--server', self.base, '--json')
        for flag in (('--wait-anchored',), ('--wait-anchored', '30'), ('--wait-anchored', '1.5')):
            rc, text = self.run_cli(*argv, *flag)
            r = json.loads(text)
            self.assertEqual((rc, r['verdict'], r['waited_s']), (0, 'MATCH', 0.0), flag)
        self.assertEqual(cli._wait_seconds(None), None)
        self.assertEqual(cli._wait_seconds(vaudit.WAIT_ANCHORED_S), 600.0)
        _Handler.requests = []
        for bad in ('0', '-5', 'soon', 'nan', 'inf', '86401'):
            rc, text = self.run_cli(*argv, '--wait-anchored', bad)
            self.assertEqual(rc, vaudit.EXIT_USAGE, bad)
            self.assertIn('--wait-anchored takes a number of seconds from 1 to 86400', text)
        self.assertEqual(_Handler.requests, [], 'nothing is read before the arguments are checked')

    def test_usage_one_chain_source_exactly_and_urls(self):
        for argv in (['audit'], ['audit', '--explorer', self.base, '--node', self.base], ['audit', '--explorer']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as e:
                cli.main(argv)
            self.assertEqual(e.exception.code, vaudit.EXIT_USAGE, argv)          # argparse's own usage error: 2
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

    def test_get_json_cuts_off_an_answer_sent_too_slowly(self):
        """The 0.7.2 review: `timeout` bounds a read in all, not only each socket operation, so a server that sends its
        answer a byte at a time cannot hold the audit (or a --wait-anchored poll) open."""
        class Slow:
            """An answer whose body comes a byte per read; each read takes 1 s on the clock below."""
            def __init__(self):
                self.left = b'{"a": 1}'

            def read1(self, _n):
                b, self.left = self.left[:1], self.left[1:]
                return b

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False
        now = [0.0]

        def tick():
            now[0] += 1.0
            return now[0]
        with mock.patch.object(vaudit.urllib.request, 'urlopen', lambda _req, timeout: Slow()), mock.patch.object(vaudit.time, 'monotonic', tick):
            with self.assertRaises(vaudit.ReadError) as e:
                vaudit.get_json('http://slow.invalid/chain', timeout=4)
        self.assertIn('no answer in time', str(e.exception))
        with mock.patch.object(vaudit.urllib.request, 'urlopen', lambda _req, timeout: Slow()), mock.patch.object(vaudit.time, 'monotonic', lambda: 0.0):
            self.assertEqual(vaudit.get_json('http://slow.invalid/chain', timeout=4), {'a': 1}, 'in time, it is read whole')


if __name__ == '__main__':
    unittest.main()
