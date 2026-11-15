"""`valun audit`'s pin of the tracker NFT (fix inbox #66 item 1). GET /pilot/v1/chain names the tracker NFT, and that is
the server's word: a tracker the operator made itself could commit whatever the server publishes (a decoy), while the
reserves, and so every redemption, trust the real one. Offline, on test_audit.py's World (synthetic keys, notes and
boxes; the reserve contract is the testnet's, which is public, and its reserve boxes are synthetic boxes at its
ErgoTree):
  - the table of the servers this audit knows mirrors the operator's auditor's (valun-app scripts/ops/anchor-audit.mjs
    TRACKER_NFTS and RESERVE_CONTRACT_SHA256), looked up by origin as there;
  - each pin in its order: --tracker-nft alone; else this profile's pin (its own server, or --mine) and the table's,
    each holding where it applies, and for a server the table does not know the reserves as well; else the reserves;
  - a decoy, a box holding another NFT that commits exactly the published rows: never a MATCH under any pin, and its box
    is never read; with no pin, only a reserve the operator made for it at the pinned contract lets it through, with
    the warning that asks for the pin (the operator's auditor's limit too);
  - the reserves of a server no pin covers: a pass, with that warning, and each way they refuse (exit 2);
  - --tracker-nft over the table, and over this profile's pin (whose records are then not compared);
  - the 41 recorded reads both auditors are held to (fixtures/audit-verdicts/xtool.json, byte for byte valun-app's
    test/fixtures/anchor-vectors/xtool.json): each gives the exit code of the verdict table, as anchor-audit.mjs does,
    with the NFT pinned as its runner pins it, and without a pin none of them passes."""
import collections
import hashlib
import json
import os
import re
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import audit as vaudit  # noqa: E402
from valun import cli  # noqa: E402
from valun import ergo  # noqa: E402
from test_audit import (ALICE, ALICE_OLD, BOB, CAROL, DAVE, EXPLORER, NFT, NODE, OTHER_TRACKER, RESERVE_CONTRACT,  # noqa: E402
                        SERVER, AuditCase, World, profile_state)

TESTNET, TESTNET_FLY, STAGING = 'https://valun.tech', 'https://valun-testnet.fly.dev', 'https://valun-staging.fly.dev'
TESTNET_NFT = 'dca981fc5d4842caf230e1b3a83cd3289663afc61b10b3f53678ccdefea5add2'
STAGING_NFT = '170213cb89e5c0286d390a8cc0015de3c19688f77aa0dddbf3a3d235ea22d42d'
DECOY = 'de' * 32                                       # a tracker of the operator's own making
NEW = '4e' * 32                                         # a new tracker the operator moved to
FIXTURES = os.path.join(HERE, 'fixtures', 'audit-verdicts')
CHAIN = f'{SERVER}/pilot/v1/chain'
RESERVES = f'{EXPLORER}/api/v1/boxes/unspent/byAddress/{RESERVE_CONTRACT}?offset=0&limit=100'


def read_kinds(log):
    """What a log of reads read: chain, reserves, committed, box, height (the World's routes)."""
    kinds = {'/pilot/v1/chain': 'chain', '/boxes/unspent/byAddress/': 'reserves', '/pilot/v1/ledger/committed': 'committed',
             '/byTokenId/': 'box', '/networkState': 'height', '/info': 'info'}
    return [next((k for p, k in kinds.items() if p in u), u) for u in log]


class Table(unittest.TestCase):
    def test_the_pins_are_the_operators_auditors(self):
        """anchor-audit.mjs (valun-app 9748f39) TRACKER_NFTS, as GET /chain of each server named it on 2026-11-14 (and
        on 2026-11-15), and RESERVE_CONTRACT_SHA256, the sha256 of the reserve contract's address the testnet's GET
        /chain names; this repository's server deploys set that contract too."""
        self.assertEqual(vaudit.TRACKER_NFTS, {TESTNET: TESTNET_NFT, TESTNET_FLY: TESTNET_NFT, STAGING: STAGING_NFT})
        self.assertEqual(hashlib.sha256(RESERVE_CONTRACT.encode('utf-8')).hexdigest(), vaudit.RESERVE_CONTRACT_SHA256)
        self.assertTrue(ergo.address_to_tree(RESERVE_CONTRACT).startswith('1b'), 'a P2S address: its ErgoTree')
        for toml in ('fly.testnet.toml', 'fly.staging.toml'):
            path = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'server', toml)
            if os.path.exists(path):                   # the server's published copy, where this checkout has it
                with open(path, encoding='utf-8') as f:
                    self.assertIn(f'BASIS_RESERVE_CONTRACT_TESTNET = "{RESERVE_CONTRACT}"', f.read(), toml)

    def test_a_server_is_looked_up_by_its_origin_as_anchor_audit_mjs_looks_it_up(self):
        for url, key in ((TESTNET, TESTNET), ('https://VALUN.Tech/', TESTNET), ('https://valun.tech:443/pilot', TESTNET),
                         ('http://valun.tech', 'http://valun.tech'), ('https://valun.tech:8443', 'https://valun.tech:8443'),
                         ('http://127.0.0.1:80/', 'http://127.0.0.1'), ('http://[::1]:9052/x', 'http://[::1]:9052')):
            self.assertEqual(vaudit.origin(url), key, url)
        for bad in ('valun.tech', 'ftp://valun.tech', '', None, 'https://', 'http://x.example:99999'):
            self.assertIsNone(vaudit.origin(bad), bad)
        self.assertEqual(vaudit.TRACKER_NFTS.get(vaudit.origin('https://Valun.tech/')), TESTNET_NFT)
        self.assertIsNone(vaudit.TRACKER_NFTS.get(vaudit.origin('http://valun.tech')),
                          'another scheme or port is another origin, as anchor-audit.mjs reads it: the reserves are asked')

    def test_a_tracker_nft_id_is_64_lowercase_hex(self):
        self.assertEqual(vaudit.tracker_nft_id(NFT), NFT)
        for bad in (NFT.upper(), NFT[:-2], NFT + 'ab', 'zz' * 32, '', 5):
            self.assertRaises(ValueError, vaudit.tracker_nft_id, bad)
            self.assertRaises(ValueError, World().audit, tracker_nft=bad)


class Pins(AuditCase):
    def test_a_server_this_audit_knows_is_held_to_its_pin_per_server_not_per_network(self):
        for server, nft in ((TESTNET, TESTNET_NFT), (TESTNET_FLY, TESTNET_NFT), (STAGING, STAGING_NFT)):
            w = World(server=server, nft=nft)
            r = w.audit(tracker_nft=None)
            with self.subTest(server=server):
                self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['warnings']), ('MATCH', True, []))
                self.assertEqual(r['tracker'], {'nft': nft, 'pin': nft, 'pinned_by': 'this audit', 'reserves_naming_it': None})
                self.assertNotIn('reserves', read_kinds(w.log), 'a pinned NFT asks no reserve')
                self.assertIn(f'as GET /pilot/v1/chain names it, and the one this audit pins for {server}\n',
                              '\n'.join(cli._audit_lines(r, False)))
        # Staging and the testnet both say network valun-testnet-1, each with a tracker of its own.
        w = World(server=STAGING, nft=TESTNET_NFT)
        self.unknown(w.audit(tracker_nft=None), 'tracker_mismatch', f'{STAGING} names tracker NFT {TESTNET_NFT}, not '
                     f'{STAGING_NFT}, the one this audit pins for {STAGING}', f'then pass --tracker-nft {TESTNET_NFT}')
        self.assertEqual(w.log, [f'{STAGING}/pilot/v1/chain'], 'nothing else is read')

    def test_each_pin_in_its_order(self):
        """--tracker-nft alone; else this profile's pin (where it applies) and the table's, each holding where it
        applies (pinned_by names the first), and for a server the table does not know the reserves as well; else the
        reserves alone, with the warning."""
        mine = profile_state(server=SERVER)
        # 1. --tracker-nft: nothing else is asked, not even the reserves.
        w = World()
        r = w.audit(profile_state=mine, tracker_nft=NFT)
        self.assertEqual((r['verdict'], r['tracker']['pinned_by'], r['tracker']['reserves_naming_it']), ('MATCH', 'you', None))
        self.assertEqual(read_kinds(w.log), ['chain', 'committed', 'box', 'height'])
        # 2. This profile's pin, on a server the table does not know: the reserves are asked as well, and are no pin.
        w = World()
        r = w.audit(profile_state=mine, tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker'], r['warnings']),
                         ('MATCH', {'nft': NFT, 'pin': NFT, 'pinned_by': 'profile', 'reserves_naming_it': 1}, []))
        self.assertEqual(read_kinds(w.log), ['chain', 'reserves', 'committed', 'box', 'height'])
        self.assertIn('names it, and the one this profile pinned; 1 reserve box at the pinned reserve contract names it\n',
                      '\n'.join(cli._audit_lines(r, False)))
        w = World()
        w.reserves = [w.reserve_box(OTHER_TRACKER, CAROL)]
        self.unknown(w.audit(profile_state=mine, tracker_nft=None), 'tracker_not_pinned',
                     f'no reserve box at the pinned reserve contract names the tracker NFT {NFT} the server gives (1 name '
                     "another) (this profile's pin is not enough: it took the server's word at the profile's first read of it)")
        # 3. A server the table knows: its pin, and no reserve is asked, with this profile's pin or without it.
        for state, by in ((None, 'this audit'), (profile_state(server=TESTNET, pins={'tracker_nft_id': TESTNET_NFT, 'denomination': 'erg'}), 'profile')):
            w = World(server=TESTNET, nft=TESTNET_NFT)
            r = w.audit(profile_state=state, tracker_nft=None)
            self.assertEqual((r['verdict'], r['tracker']['pinned_by'], r['tracker']['reserves_naming_it']), ('MATCH', by, None))
            self.assertNotIn('reserves', read_kinds(w.log))
        # A profile pinned to another tracker than the table's: whichever the server names, the other pin refuses it.
        other = profile_state(server=TESTNET, pins={'tracker_nft_id': NEW, 'denomination': 'erg'})
        self.unknown(World(server=TESTNET, nft=TESTNET_NFT).audit(profile_state=other, tracker_nft=None), 'tracker_mismatch',
                     f'not {NEW}, the one this profile is pinned to')
        self.unknown(World(server=TESTNET, nft=NEW).audit(profile_state=other, tracker_nft=None), 'tracker_mismatch',
                     f'not {TESTNET_NFT}, the one this audit pins for {TESTNET}')
        # 4. Nothing pins it: the reserves alone.
        w = World()
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['tracker']['pin'], r['tracker']['reserves_naming_it']),
                         ('MATCH', False, None, 1))
        self.assertIn('pin it with --tracker-nft', r['warnings'][0])

    def test_a_decoy_whose_box_commits_exactly_the_published_rows_is_never_a_match(self):
        """The operator names a tracker of its own making (DECOY), whose one unspent box commits exactly the rows the
        server publishes, so the rows' digest is that box's R5. Whatever pins the real NFT, the decoy is refused before
        any box or row is read (exit 2), naming the NFT pinned and the one named; with no pin, the reserves refuse it."""
        self.assertEqual(World(nft=DECOY).audit(tracker_nft=DECOY)['verdict'], 'MATCH', 'its box commits the published rows')
        on_testnet = profile_state(server=TESTNET, pins={'tracker_nft_id': TESTNET_NFT, 'denomination': 'erg'})
        for what, server, kw, words in (
                ('--tracker-nft', SERVER, {'tracker_nft': NFT}, f'not {NFT}, the one you pinned (--tracker-nft)'),
                ("the profile's own server", SERVER, {'profile_state': profile_state(server=SERVER)},
                 f'not {NFT}, the one this profile is pinned to'),
                ('--mine', SERVER, {'profile_state': profile_state(), 'mine': True}, f'not {NFT}, the one this profile is pinned to'),
                ('the table', TESTNET, {}, f'not {TESTNET_NFT}, the one this audit pins for {TESTNET}'),
                ('the table and the profile', TESTNET, {'profile_state': on_testnet}, f'not {TESTNET_NFT}, the one this profile')):
            w = World(server=server, nft=DECOY)
            r = w.audit(**{'tracker_nft': None, **kw})
            with self.subTest(what):
                self.unknown(r, 'tracker_mismatch', f'{server} names tracker NFT {DECOY}, ', words)
                self.assertEqual(w.log, [f'{server}/pilot/v1/chain'], 'nothing else is read: no reserve, row or box')
                self.assertEqual((r['tracker']['nft'], r['tracker_nft_pinned'], r['box'], r['rows']), (DECOY, False, None, None))
        # No pin: the reserves at the pinned contract trust the real tracker and another, none the decoy.
        w = World(nft=DECOY)
        w.reserves = [w.reserve_box(NFT, BOB), w.reserve_box(OTHER_TRACKER, CAROL)]
        self.unknown(w.audit(tracker_nft=None), 'tracker_not_pinned',
                     f'no reserve box at the pinned reserve contract names the tracker NFT {DECOY} the server gives (2 name another)',
                     'which no redemption trusts', 'pin the tracker NFT you expect with --tracker-nft')
        self.assertEqual(read_kinds(w.log), ['chain', 'reserves'], 'its box is never read')
        # Nor a reserve contract of the operator's own, where a reserve names the decoy: no box is read there.
        w = World(nft=DECOY)
        w.reserve_contract = ergo.p2pk_address(DAVE)
        self.unknown(w.audit(tracker_nft=None), 'tracker_not_pinned', f"the tracker NFT {DECOY} and the reserve contract are "
                     "both only the server's word")
        self.assertEqual(read_kinds(w.log), ['chain'])
        # What no reserve check can tell: a reserve the operator made at the pinned contract for its decoy. Never a pin:
        # a MATCH with the warning that asks for one (the operator's auditor passes it so too).
        w = World(nft=DECOY)
        w.reserves = [w.reserve_box(NFT, BOB), w.reserve_box(DECOY, DAVE)]
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker_nft_pinned'], r['tracker']['reserves_naming_it']), ('MATCH', False, 1))
        self.assertIn(f'the tracker NFT {DECOY} is not pinned for {SERVER}: 1 reserve box at the pinned reserve contract names '
                      'it, which an operator can arrange for a tracker of its own too; pin it with --tracker-nft', r['warnings'])


class Reserves(AuditCase):
    def test_a_server_no_pin_covers_passes_on_the_reserves_with_a_warning_that_asks_for_the_pin(self):
        w = World()
        w.reserves = [w.reserve_box(NFT, BOB), w.reserve_box(OTHER_TRACKER, CAROL), w.reserve_box(NFT, DAVE)]
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], vaudit.exit_code(r)), ('MATCH', 0))
        self.assertEqual(r['tracker'], {'nft': NFT, 'pin': None, 'pinned_by': None, 'reserves_naming_it': 2})
        self.assertEqual(r['warnings'], [f'the tracker NFT {NFT} is not pinned for {SERVER}: 2 reserve boxes at the pinned '
                                         'reserve contract name it, which an operator can arrange for a tracker of its own '
                                         'too; pin it with --tracker-nft'])
        self.assertEqual(w.log, [CHAIN, RESERVES, f'{SERVER}/pilot/v1/ledger/committed',
                                 f'{EXPLORER}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10', f'{EXPLORER}/api/v1/networkState'])
        self.assertIn(f'tracker   NFT {NFT}, as GET /pilot/v1/chain names it; not pinned: 2 reserve boxes at the pinned reserve '
                      'contract name it\n', '\n'.join(cli._audit_lines(r, False)))
        w = World()                                     # the reserves vouch for the NFT, never for the rows
        w.published[0]['total'] += 1
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], vaudit.exit_code(r), r['tracker']['reserves_naming_it']), ('MISMATCH', 1, 1))

    def test_the_reserves_refuse_an_nft_none_of_them_names_and_any_contract_but_the_pinned_one(self):
        def world(reserves=None, contract=RESERVE_CONTRACT):
            w = World()
            w.reserve_contract = contract
            if reserves is not None:
                w.reserves = reserves(w)
            return w
        no_key = lambda w: [dict(w.reserve_box(NFT, BOB), additionalRegisters=dict(  # noqa: E731
            w.reserve_box(NFT, BOB)['additionalRegisters'], R4={'serializedValue': '0e20' + BOB[2:]}))]
        for what, w, reads, words in (
                ('another tracker only', world(lambda w: [w.reserve_box(OTHER_TRACKER, CAROL)]), ['chain', 'reserves'],
                 f'names the tracker NFT {NFT} the server gives (1 name another): it may be a tracker the operator made'),
                ('no reserve at all', world(lambda w: []), ['chain', 'reserves'], f'names the tracker NFT {NFT} the server gives: '),
                ('an owner key that is no GroupElement', world(no_key), ['chain', 'reserves'], f'names the tracker NFT {NFT}'),
                ('an R6 that is no Coll[Byte]', world(lambda w: [dict(w.reserve_box(NFT, BOB), additionalRegisters={
                    'R4': {'serializedValue': '07' + BOB}, 'R6': {'serializedValue': '0e21' + NFT}})]), ['chain', 'reserves'],
                 f'names the tracker NFT {NFT}'),
                ('another contract', world(contract=ergo.p2pk_address(CAROL)), ['chain'], "both only the server's word"),
                ('no contract named', world(contract=None), ['chain'], 'GET /pilot/v1/chain names no reserve contract')):
            r = w.audit(tracker_nft=None)
            with self.subTest(what):
                self.unknown(r, 'tracker_not_pinned', words)
                self.assertEqual(read_kinds(w.log), reads, 'no row or box is read')

    def test_a_node_lists_no_reserve_for_a_get(self):
        """A node lists the boxes at an address only for a POST (/blockchain/box/unspent/byAddress), which this audit
        does not send: for a server the table does not know, a node needs --tracker-nft."""
        w = World()
        r = w.audit(NODE, tracker_nft=None)
        self.unknown(r, 'tracker_not_pinned', 'lists the boxes at the reserve contract only for a POST', '--tracker-nft', '--explorer')
        self.assertEqual(w.log, [CHAIN, f'{NODE}/info'], 'the node is asked only whether it is on testnet')
        self.unknown(World().audit(NODE, profile_state=profile_state(server=SERVER), tracker_nft=None), 'tracker_not_pinned', 'POST')
        self.assertEqual(World().audit(NODE)['verdict'], 'MATCH', 'the NFT pinned (--tracker-nft), a node audits as before')
        r = World(server=TESTNET, nft=TESTNET_NFT).audit(NODE, tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker']['pinned_by']), ('MATCH', 'this audit'), 'and so for a server the table knows')

    def test_what_the_source_lists_at_the_contract_is_checked_as_anchor_audit_mjs_checks_it(self):
        def listing(boxes):
            w = World()
            w.reserves = boxes(w)
            return w
        for what, w, reason, words in (
                ('another ErgoTree', listing(lambda w: [w.reserve_box(NFT, BOB, tree='0008cd' + BOB)]), 'source_inconsistent',
                 'is not at its address (another ErgoTree)'),
                ('a spent box', listing(lambda w: [w.reserve_box(NFT, BOB, spentTransactionId='aa' * 32)]), 'source_inconsistent',
                 'listed as unspent, was spent'),
                ('a box without a box id', listing(lambda w: [w.reserve_box(NFT, BOB, boxId=None)]), 'source_inconsistent',
                 'without a box id'),
                ('a value that is not whole', listing(lambda w: [w.reserve_box(NFT, BOB, value=1.5)]), 'source_inconsistent',
                 'not a whole number'),
                ('a token amount that is not whole', listing(lambda w: [w.reserve_box(NFT, BOB, assets=[{'tokenId': 'cc' * 32}])]),
                 'source_inconsistent', 'not a whole number'),
                ('something that is no box', listing(lambda w: ['a box']), 'source_inconsistent', 'not a box')):
            with self.subTest(what):
                self.unknown(w.audit(tracker_nft=None), reason, words)
        w = World()
        w.overrides[RESERVES] = [(200, {'boxes': []})]
        self.unknown(w.audit(tracker_nft=None), 'source_inconsistent', '{items, total}', 'reserve contract')
        w = World()
        w.overrides[RESERVES] = [(500, {'error': 'internal_error'})]
        self.unknown(w.audit(tracker_nft=None), 'source_unreadable', 'did not list the boxes at the reserve contract')
        # The explorer's address of the long script is an abbreviation, so a box is at the contract by its ErgoTree; one
        # listed twice counts once; values written as decimal strings are whole numbers.
        w = World()
        box = w.reserve_box(NFT, BOB, value='50000000')
        w.reserves = [box, box, w.reserve_box(NFT, DAVE, address=RESERVE_CONTRACT[:16])]
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker']['reserves_naming_it']), ('MATCH', 2))
        # A node's form of a box (registers as plain hex) reads the same, wherever a source gives it.
        x = vaudit._reserve_box(dict(w.reserve_box(NFT, BOB), additionalRegisters={'R4': '07' + BOB, 'R6': '0e20' + NFT}),
                                'node', ergo.address_to_tree(RESERVE_CONTRACT), RESERVE_CONTRACT)
        self.assertEqual((x['tracker'], x['owner']), (NFT, BOB))

    def test_the_reserves_are_read_100_at_a_time_and_5000_at_most(self):
        w = World()
        w.reserves = [w.reserve_box(OTHER_TRACKER, CAROL, n) for n in range(150)] + [w.reserve_box(NFT, BOB)]
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker']['reserves_naming_it']), ('MATCH', 1), 'the one on the second page')
        self.assertEqual([u for u in w.log if 'byAddress' in u], [RESERVES, RESERVES.replace('offset=0', 'offset=100')])
        with mock.patch.object(vaudit, 'RESERVE_LIST_MAX', 200):
            w = World()
            w.reserves = [w.reserve_box(OTHER_TRACKER, CAROL, n) for n in range(250)] + [w.reserve_box(NFT, BOB)]
            self.unknown(w.audit(tracker_nft=None), 'tracker_not_pinned', f'names the tracker NFT {NFT} the server gives (200 '
                         'name another) among the first 200 the explorer lists')
            self.assertEqual(len([u for u in w.log if 'byAddress' in u]), 2)
        w = World()                                     # a total the explorer gives ends the listing at it
        w.overrides[RESERVES] = [(200, {'items': [w.reserve_box(NFT, BOB, n) for n in range(100)], 'total': 100})]
        r = w.audit(tracker_nft=None)
        self.assertEqual((r['verdict'], r['tracker']['reserves_naming_it'], len([u for u in w.log if 'byAddress' in u])),
                         ('MATCH', 100, 1))


class Flag(AuditCase):
    def test_the_flag_overrides_the_table(self):
        """The testnet moved to a new tracker the table does not name yet: its pin refuses it (with the way out), and
        --tracker-nft takes it, with a warning; the flag naming the table's NFT refuses another."""
        w = World(server=TESTNET, nft=NEW)
        self.unknown(w.audit(tracker_nft=None), 'tracker_mismatch', f'not {TESTNET_NFT}, the one this audit pins for {TESTNET} '
                     '(its GET /pilot/v1/chain of 2026-11-14)', 'check that the reserves trust it', f'pass --tracker-nft {NEW}')
        w = World(server=TESTNET, nft=NEW)
        r = w.audit(tracker_nft=NEW)
        self.assertEqual((r['verdict'], r['tracker'], vaudit.exit_code(r)),
                         ('MATCH', {'nft': NEW, 'pin': NEW, 'pinned_by': 'you', 'reserves_naming_it': None}, 0))
        self.assertEqual(r['warnings'], [f'this audit pins tracker {TESTNET_NFT} for {TESTNET} (its GET /pilot/v1/chain of '
                                         f'2026-11-14), and you pinned {NEW} (--tracker-nft)'])
        self.assertNotIn('reserves', read_kinds(w.log))
        w = World(server=TESTNET, nft=NEW)
        self.unknown(w.audit(tracker_nft=TESTNET_NFT), 'tracker_mismatch',
                     f'{TESTNET} names tracker NFT {NEW}, not {TESTNET_NFT}, the one you pinned (--tracker-nft)')
        self.assertEqual(w.log, [f'{TESTNET}/pilot/v1/chain'])

    def test_the_flag_overrides_the_profiles_pin_and_its_records_are_then_not_compared(self):
        w = World(nft=NEW)
        self.unknown(w.audit(profile_state=profile_state(), mine=True, tracker_nft=None), 'tracker_mismatch',
                     f'not {NFT}, the one this profile is pinned to')
        r = World(nft=NEW).audit(profile_state=profile_state(), mine=True, tracker_nft=NEW)
        m = r['mine']
        self.assertEqual((r['verdict'], r['tracker']['pinned_by'], m['problem'], m['edges'], vaudit.exit_code(r)),
                         ('MATCH', 'you', 'another_tracker', [], vaudit.EXIT_NOT_PROVEN))
        self.assertIn(f'this profile is pinned to tracker {NFT}, and these rows are what the box of tracker {NEW} commits',
                      m['message'])
        self.assertIn(f'this profile is pinned to tracker {NFT}, and you pinned {NEW} (--tracker-nft)', r['warnings'][0])
        self.assertIn('none compared (another_tracker)', '\n'.join(cli._audit_lines(r, True)))


# ---------------------------------------------------------------------------------------------------------------------
# The recorded reads both auditors are held to.

def recorded_reads():
    """fixtures/audit-verdicts/xtool.json: (the file, its scenarios with each answer's body in place of its index)."""
    with open(os.path.join(FIXTURES, 'xtool.json'), encoding='utf-8') as f:
        doc = json.load(f)
    return doc, [dict(s, responses={u: [[st, doc['bodies'][i]] for st, i in v] for u, v in s['responses'].items()})
                 for s in doc['scenarios']]


def run_recorded(s, **kw):
    """valun.audit on one recorded read as valun-app's xtool/run_client.py runs it: each url's answers in turn, the last
    repeating, and any other url a 404; no waits. Returns (the result, the urls read)."""
    queues, log = {u: [list(x) for x in v] for u, v in s['responses'].items()}, []

    def get(url):
        log.append(url)
        q = queues.get(url)
        status, body = (q.pop(0) if len(q) > 1 else q[0]) if q else (404, {'error': 'not_found'})
        body = json.loads(body) if isinstance(body, str) else body
        if status >= 400:
            b = body if isinstance(body, dict) else {}
            raise vaudit.ReadError(url, f"HTTP {status} {b.get('error', '')}".strip(), status, b.get('error'), b)
        return body
    return vaudit.audit(s['server'], vaudit.Explorer(s['explorer'], get=get), get=get, sleep=lambda _s: None, **kw), log


class VerdictTable(unittest.TestCase):
    def test_each_recorded_read_gives_the_exit_code_of_the_verdict_table(self):
        """Each of the 41 with its tracker NFT pinned, as valun-app's xtool/run_server_tool.mjs runs anchor-audit.mjs on
        them (trackerNft): the exit code each must give (docs/PILOT-API.md "Verdicts"), and the verdict and reason this
        audit gave when they were recorded."""
        doc, scenarios = recorded_reads()
        self.assertEqual(len(scenarios), 41)
        self.assertEqual(collections.Counter(s['exit'] for s in scenarios), {0: 7, 1: 5, 2: 29})
        for s in scenarios:
            r, _log = run_recorded(s, tracker_nft=s['nft'])
            with self.subTest(s['name']):
                self.assertEqual(vaudit.exit_code(r), s['exit'], r['message'])
                self.assertEqual((r['verdict'], r['reason']), (s['client']['verdict'], s['client']['reason']))

    def test_without_a_pin_none_of_them_passes(self):
        """The recorded server is none this audit knows, and its GET /chain names no reserve contract: with no pin,
        nothing is compared on any of them, and no tracker box is read."""
        _doc, scenarios = recorded_reads()
        for s in scenarios:
            r, log = run_recorded(s)
            with self.subTest(s['name']):
                self.assertEqual(vaudit.exit_code(r), vaudit.EXIT_NOTHING_COMPARED)
                self.assertIn(r['reason'], ('tracker_not_pinned', 'server_unreadable'))
                self.assertFalse(any('byTokenId' in u for u in log), r['message'])

    def test_the_recorded_reads_are_synthetic(self):
        """Public: test_audit.py's World only (its keys, its .invalid hosts, the documentation address of its operator's
        node, the explorer's public page), no read of the testnet."""
        doc, _scenarios = recorded_reads()
        text = json.dumps(doc)
        self.assertEqual(set(re.findall(r'0[23][0-9a-f]{64}', text)), {ALICE, ALICE_OLD, BOB, CAROL, DAVE})
        self.assertEqual(set(re.findall(r'https?://[A-Za-z0-9.:-]+', text)),
                         {SERVER, EXPLORER, 'http://203.0.113.9:9052', 'https://testnet.ergoplatform.com'})
        self.assertEqual({s['nft'] for s in doc['scenarios']}, {NFT})
        for live in (TESTNET_NFT, STAGING_NFT, 'valun.tech', 'fly.dev'):
            self.assertNotIn(live, text)


if __name__ == '__main__':
    unittest.main()
