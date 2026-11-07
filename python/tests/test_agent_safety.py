"""Approval safety in the agent layer (offline): fail-closed commitment detection, exact decisions, and approvals
bound to the exact terms (found by the JavaScript port's parity work, 2026-11-07)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import client as vc  # noqa: E402
from valun.agent import ValunAgent  # noqa: E402


class FakeClient:
    def __init__(self, deal):
        self._deal = deal

    def deal(self, deal_id):
        return self._deal


class Agent(ValunAgent):
    def __init__(self, deal=None):
        super().__init__(store=None)
        self._fake = FakeClient(deal or {})

    def client(self, require_connection=True):
        return self._fake


class Safety(unittest.TestCase):
    def test_misspelt_or_unknown_values_are_commitments(self):
        a = Agent()
        for args in ({'decision': 'Accept'}, {'decision': 'accepted'}, {'decision': None}, {}):
            self.assertTrue(a.is_commitment('valun_review_delivery', args), args)
        for args in ({'action': 'Accept'}, {'action': 'agree'}, {}):
            self.assertTrue(a.is_commitment('valun_respond', args), args)
        self.assertFalse(a.is_commitment('valun_review_delivery', {'decision': 'dispute'}))
        self.assertFalse(a.is_commitment('valun_respond', {'action': 'decline'}))
        self.assertFalse(a.is_commitment('valun_respond', {'action': 'withdraw'}))

    def test_review_refuses_anything_but_accept_or_dispute(self):
        for d in ('Accept', 'ok', None):
            with self.assertRaises(vc.ValunError) as e:
                Agent().review({'deal_id': 'vd_1', 'decision': d})
            self.assertEqual(e.exception.code, 'bad_decision')

    def test_bind_pins_the_terms_and_deliverable_the_owner_sees(self):
        a = Agent({'current': {'terms_hash': 'h' * 64}, 'delivery': {'sha256': 'd' * 64}})
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})['expected_terms_hash'], 'h' * 64)
        self.assertEqual(a.bind('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})['expected_deliverable_sha256'], 'd' * 64)
        # an explicit hash from the agent is kept (the server then refuses it if the terms changed)
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': 'x'})['expected_terms_hash'], 'x')
        self.assertNotIn('expected_terms_hash', a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'decline'}))

    def test_bind_is_best_effort(self):
        class Broken(ValunAgent):
            def client(self, require_connection=True):
                raise vc.ValunError('unreachable', 'down')
        args = {'deal_id': 'vd_1', 'action': 'accept'}
        self.assertEqual(Broken(store=None).bind('valun_respond', args), args)


if __name__ == '__main__':
    unittest.main()
