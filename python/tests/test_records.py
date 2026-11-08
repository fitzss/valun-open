"""The client's own records of its edges (records.py), and OQ-23: an owner who rejects a held credit note no longer
leaves the client's record ahead of the tracker, so the next completion to that payee succeeds."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import client as vc  # noqa: E402
from valun import records  # noqa: E402
from test_client_complete import ALICE, BOB, MALLORY, NFT, DENOM, MemStore, World, WorldClient, sign_note  # noqa: E402

PAIR = f"{ALICE['pubkey']}>{BOB['pubkey']}"


def verify(issuer, recipient, total, ts, sig):
    return vc.verify_note(issuer, recipient, total, ts, sig, NFT, DENOM)


def state(total, ts, signer=ALICE):
    return {'total': total, 'timestamp': ts, 'signature': sign_note(signer, BOB['pubkey'], total, ts)}


class RecordFunctions(unittest.TestCase):
    def test_pending_entries(self):
        recs = {}
        p = records.add_pending(recs, PAIR, 20, 1000, 'note', 'vd_1', 'out', '2026-11-08T00:00:00.000Z')
        self.assertIs(records.add_pending(recs, PAIR, 20, 1000, 'note', 'vd_1', 'out'), p)     # no second copy
        self.assertEqual(recs[PAIR], {'confirmed': None, 'pending': [p]})
        self.assertEqual(p, {'total': 20, 'timestamp': 1000, 'kind': 'note', 'ref': 'vd_1', 'direction': 'out',
                             'signed_at': '2026-11-08T00:00:00.000Z'})
        self.assertEqual(records.remove_pending(recs, PAIR, 20, 1000, 'vd_other'), 0)
        self.assertEqual(records.remove_pending(recs, PAIR, 20, 1000, 'vd_1'), 1)
        for bad in ((True, 1), (-1, 1), (1, 1.5), ('1', 1)):
            with self.assertRaises(ValueError):
                records.add_pending(recs, PAIR, *bad, 'note')
        with self.assertRaises(ValueError):
            records.add_pending(recs, PAIR, 1, 1, 'note', direction='sideways')

    def test_confirm_promotes_and_drops_what_can_never_apply(self):
        recs = {}
        for total, ts in ((10, 1000), (20, 2000), (99, 2000), (30, 3000)):
            records.add_pending(recs, PAIR, total, ts, 'note', f'vd_{total}')
        e = records.confirm(recs, PAIR, {'total': 20, 'timestamp': 2000, 'signature': 'aa'})
        self.assertEqual(e['confirmed'], {'total': 20, 'timestamp': 2000, 'signature': 'aa'})
        self.assertEqual([(p['total'], p['timestamp']) for p in e['pending']], [(30, 3000)])   # 10@1000 and 99@2000 are dead
        self.assertEqual(records.confirmed_total(recs, PAIR), 20)
        # never back in time
        records.confirm(recs, PAIR, {'total': 5, 'timestamp': 1500, 'signature': 'bb'})
        self.assertEqual(records.get(recs, PAIR)['confirmed']['total'], 20)
        with self.assertRaises(ValueError):
            records.confirm(recs, PAIR, {'total': 5, 'timestamp': 1500})

    def test_sync_promotion(self):
        recs = {}
        records.add_pending(recs, PAIR, 20, 2000, 'note', 'vd_1')
        records.add_pending(recs, PAIR, 25, 3000, 'setoff', 'vs_1', 'out')
        r = records.sync_edge(recs, {'edge': PAIR, 'total': 20, 'timestamp': 2000, 'signature': 'aa', 'exact': True})
        self.assertTrue(r['changed'])
        self.assertEqual(r['promoted']['ref'], 'vd_1')
        self.assertEqual(r['dropped'], [])
        self.assertEqual(r['confirmed'], {'total': 20, 'timestamp': 2000, 'signature': 'aa'})
        self.assertEqual([p['ref'] for p in records.get(recs, PAIR)['pending']], ['vs_1'])    # still possible
        # the edge moved past the set-off without it: the set-off is dropped, nothing is promoted
        r = records.sync_edge(recs, {'issuer_pubkey': ALICE['pubkey'], 'recipient_pubkey': BOB['pubkey'],
                                     'total': 40, 'timestamp': 4000, 'signature': 'cc'})
        self.assertEqual((r['pair'], r['promoted'], [p['ref'] for p in r['dropped']]), (PAIR, None, ['vs_1']))
        # an older row (a stale view) changes nothing
        r = records.sync_edge(recs, {'edge': PAIR, 'total': 20, 'timestamp': 2000, 'signature': 'aa'})
        self.assertFalse(r['changed'])
        self.assertEqual(r['confirmed']['total'], 40)
        for bad in ({'total': 1, 'timestamp': 1, 'signature': 's'}, {'edge': 'nokey', 'total': 1, 'timestamp': 1, 'signature': 's'},
                    {'edge': PAIR, 'total': '1', 'timestamp': 1, 'signature': 's'}, ['not', 'a', 'row']):
            with self.assertRaises(ValueError):
                records.sync_edge(recs, bad)

    def test_accept_prior(self):
        recs = {}
        mine = state(30, 5000)
        self.assertTrue(records.accept_prior(recs, PAIR, mine, ALICE['pubkey'], verify))         # nothing confirmed yet
        records.confirm(recs, PAIR, state(10, 4000))
        self.assertTrue(records.accept_prior(recs, PAIR, mine, ALICE['pubkey'], verify))         # newer than my record
        records.confirm(recs, PAIR, state(10, 6000))
        self.assertEqual(records.prior_problem(recs, PAIR, mine, ALICE['pubkey'], verify), 'stale_prior')
        self.assertEqual(records.prior_problem(recs, PAIR, state(11, 6000), ALICE['pubkey'], verify), 'stale_prior')
        self.assertIsNone(records.prior_problem(recs, PAIR, state(10, 6000), ALICE['pubkey'], verify))
        self.assertEqual(records.prior_problem({}, PAIR, state(30, 5000, signer=MALLORY), ALICE['pubkey'], verify), 'bad_prior_signature')
        self.assertEqual(records.prior_problem({}, PAIR, mine, BOB['pubkey'], verify), 'bad_prior_signature')   # not my edge
        self.assertEqual(records.prior_problem({}, PAIR, {'total': 30, 'timestamp': 5000}, ALICE['pubkey'], verify), 'bad_prior_signature')
        self.assertFalse(records.accept_prior({}, PAIR, mine, ALICE['pubkey'], lambda *a: 1 / 0))   # a broken verifier accepts nothing


class OwnerDecisions(unittest.TestCase):
    """The owner reviews deliveries (review_deliveries): the agent's signed note is held until the owner decides."""

    def test_oq23_owner_rejects_then_the_next_completion_succeeds(self):
        w, s = World(review_deliveries=True), MemStore()
        w.add_deal('vd_1')
        self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'completion_awaiting_owner')
        w.owner_reject('vd_1')                       # the tracker never saw the note
        w.review_deliveries = False
        # 0.3.1 had recorded issued[pair] = 20 here and refused this with ledger_mismatch (tracker prior 0).
        r = WorldClient(w, s).complete('vd_1')
        self.assertEqual(r['status'], 'note_issued')
        self.assertEqual(w.tracker[w.pair]['total'], 20)
        self.assertEqual(s.state['issued'], {w.pair: 20})
        rec = records.get(s.state['records'], w.pair)
        self.assertEqual(rec['confirmed']['total'], 20)
        self.assertEqual(rec['pending'], [])          # the rejected note is dead: dropped

    def test_a_held_note_the_owner_approves_later_is_confirmed_from_its_deal(self):
        w, s = World(), MemStore()
        w.add_deal('vd_0', price=10)
        WorldClient(w, s).complete('vd_0')            # confirmed 10
        w.review_deliveries = True
        w.add_deal('vd_1', price=20)
        WorldClient(w, s).complete('vd_1')            # held: 30 pending
        w.owner_approve('vd_1')                       # later, the owner approves: the tracker now holds 30
        w.review_deliveries = False
        w.add_deal('vd_2', price=5)
        # 0.3.1 recorded 30 when the note was held, so this worked; the new record is confirmed from vd_1's outcome.
        r = WorldClient(w, s).complete('vd_2')
        self.assertEqual(r['status'], 'note_issued')
        self.assertIn('GET /pilot/v1/deals/vd_1', w.log)
        self.assertEqual(s.state['issued'], {w.pair: 35})
        self.assertEqual(records.get(s.state['records'], w.pair)['pending'], [])

    def test_a_deal_its_own_issued_note_paid_is_not_paid_again(self):
        w, s = World(), MemStore()
        w.add_deal('vd_0', price=10)
        WorldClient(w, s).complete('vd_0')            # confirmed 10
        w.review_deliveries = True
        w.add_deal('vd_1', price=20)
        WorldClient(w, s).complete('vd_1')            # held: 30 pending
        w.owner_approve('vd_1')                       # applied; its deal records it as issued
        w.review_deliveries = False
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')        # asked to pay vd_1 again
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual(s.state['issued'], {w.pair: 30})
        self.assertEqual(w.log.count('POST /pilot/v1/deals/vd_1/complete'), 1)

    def test_a_pending_note_is_not_confirmed_by_a_deal_that_was_not_issued(self):
        w, s = World(), MemStore()
        w.add_deal('vd_0', price=10)
        WorldClient(w, s).complete('vd_0')            # confirmed 10
        w.review_deliveries = True
        w.add_deal('vd_1', price=20)
        WorldClient(w, s).complete('vd_1')            # held: 30 pending, still held
        w.set_edge(30, w.tracker[w.pair]['timestamp'] + 1, signer=ALICE)   # the tracker moved, but vd_1 does not say so
        w.review_deliveries = False
        w.add_deal('vd_2', price=5)
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_2')
        self.assertEqual(e.exception.code, 'ledger_mismatch')
        self.assertEqual(s.state['issued'], {w.pair: 10})


if __name__ == '__main__':
    unittest.main()
