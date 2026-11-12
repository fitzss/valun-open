"""Offline tests of the house agents' own parts: which agents run with which services, their joining and profile sync,
and the sellers built over one budget. The seller itself (answering offers, budgets, checks, receipts) is
valun.ai_seller's and is tested with the package (python/tests/test_ai_seller.py).   python -m unittest test_ai_seller.py"""
import io
import os
import tempfile
import types
import unittest
from unittest import mock

os.environ['VALUN_HOME'] = tempfile.mkdtemp(prefix='house-agents-test-')
import ai_seller as H  # noqa: E402
from valun import ai_seller as ais  # noqa: E402


class Agents(unittest.TestCase):
    def test_every_service_exists_and_the_text_lists_them(self):
        for h, spec in H.AGENTS.items():
            self.assertEqual(ais.parse_services(','.join(spec['services'])), tuple(spec['services']), h)
        self.assertIn('check (2 PC)', H.services_text('house-reviewer'))
        self.assertIn('summary (2 PC)', H.services_text('house-scribe'))

    def test_sellers_share_one_budget_and_keep_checks_apart(self):
        b = ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1)
        stores = {h: H.vc.FileStore(tempfile.mktemp(suffix='.json')) for h in H.AGENTS}
        run = H.sellers(stores, None, b)
        self.assertEqual([s.handle for s in run], list(H.AGENTS))
        self.assertEqual([s.services for s in run], [tuple(a['services']) for a in H.AGENTS.values()])
        self.assertTrue(all(s.budget is b for s in run))
        self.assertEqual((run[1].jobs_per_buyer, run[1].checks_per_buyer), (H.JOBS_PER_BUYER_PER_DAY, H.CHECKS_PER_BUYER_PER_DAY))
        self.assertNotEqual(run[1].counted('ana', 'check'), run[1].counted('ana', 'code-review'))

    def test_the_first_run_needs_an_invite(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VALUN_INVITE_HOUSE_SCRIBE', None)
            with self.assertRaises(SystemExit) as e:
                H.bootstrap('house-scribe')
            self.assertIn('VALUN_INVITE_HOUSE_SCRIBE', str(e.exception))

    def test_profile_sync_sends_only_what_differs(self):
        sent = []
        fake = types.SimpleNamespace(me=lambda: {'participant': {'about': H.AGENTS['house-reviewer']['about'], 'services': 'old'}},
                                     set_profile=lambda **kw: sent.append(kw))
        with mock.patch.object(H.vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            H.sync_profile('house-reviewer', None)
        self.assertEqual(sent, [{'services': H.services_text('house-reviewer')}])


if __name__ == '__main__':
    unittest.main()
