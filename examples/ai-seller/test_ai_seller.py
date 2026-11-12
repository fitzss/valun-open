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
            self.assertLessEqual(len(spec['about']), 300, f'{h}: the server keeps at most 300 characters')
            self.assertLessEqual(len(H.services_text(h)), 300, h)
            self.assertLessEqual(len(H.wants_text(h)), 300, h)
        self.assertIn('check (2 PC)', H.services_text('house-reviewer'))
        self.assertIn('summary (2 PC)', H.services_text('house-scribe'))

    def test_the_wants_are_whole_specs_and_affordable_to_check(self):
        for h in H.AGENTS:
            self.assertEqual(sorted(H.wants_of(h)), ['docs-fix', 'report'])
            self.assertTrue(H.wants_text(h).startswith('report (2 PC): an onboarding report on Valun'))
        for name, spec in H.WANTS.items():
            for k in ('price', 'max_chars', 'max_tokens', 'effort', 'keywords', 'blurb', 'criteria'):
                self.assertIn(k, spec, f'{name}.{k}')
            self.assertLessEqual(spec['price'], H.MANDATE['max_issue_per_deal'], name)
            self.assertEqual(ais.which_want(H.WANTS, {'service': {'title': f'{name}: one for you'}}), name)
        self.assertEqual(H.WANTS['docs-fix']['reference_url'], H.SERVER + '/skill.md')
        # The dearest check stays well under the daily cap.
        s = H.sellers({h: H.vc.FileStore(tempfile.mktemp(suffix='.json')) for h in H.AGENTS}, types.SimpleNamespace(model=H.MODEL),
                      ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1))[0]
        self.assertLess(max(s.want_worst(spec) for spec in H.WANTS.values()), 0.25)

    def test_sellers_share_one_budget_and_keep_checks_apart(self):
        b = ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1)
        stores = {h: H.vc.FileStore(tempfile.mktemp(suffix='.json')) for h in H.AGENTS}
        run = H.sellers(stores, None, b)
        self.assertEqual([s.handle for s in run], list(H.AGENTS))
        self.assertEqual([s.services for s in run], [tuple(a['services']) for a in H.AGENTS.values()])
        self.assertTrue(all(s.budget is b for s in run))
        self.assertEqual((run[1].jobs_per_buyer, run[1].checks_per_buyer), (H.JOBS_PER_BUYER_PER_DAY, H.CHECKS_PER_BUYER_PER_DAY))
        self.assertEqual([sorted(s.wants) for s in run], [['docs-fix', 'report']] * 2)
        self.assertEqual((run[0].wants_per_payee, run[0].wants_per_day), (1, H.WANTS_PER_DAY))
        self.assertTrue(run[0].received.endswith('wants-received-house-scribe.jsonl'))
        self.assertNotEqual(run[1].counted('ana', 'check'), run[1].counted('ana', 'code-review'))

    def test_the_first_run_needs_an_invite(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VALUN_INVITE_HOUSE_SCRIBE', None)
            with self.assertRaises(SystemExit) as e:
                H.bootstrap('house-scribe')
            self.assertIn('VALUN_INVITE_HOUSE_SCRIBE', str(e.exception))

    def test_profile_sync_sends_only_what_differs(self):
        sent = []
        fake = types.SimpleNamespace(me=lambda: {'participant': {'about': H.AGENTS['house-reviewer']['about'], 'services': 'old',
                                                                 'wants': H.wants_text('house-reviewer')}},
                                     set_profile=lambda **kw: sent.append(kw))
        with mock.patch.object(H.vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            H.sync_profile('house-reviewer', None)
        self.assertEqual(sent, [{'services': H.services_text('house-reviewer')}])
        # A server record without wants (none set yet): they are sent.
        sent.clear()
        fake.me = lambda: {'participant': {'about': H.AGENTS['house-scribe']['about'], 'services': H.services_text('house-scribe')}}
        with mock.patch.object(H.vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            H.sync_profile('house-scribe', None)
        self.assertEqual(sent, [{'wants': H.wants_text('house-scribe')}])

    def test_mandate_sync_lets_it_pay_and_never_prints_the_token(self):
        home = os.environ['VALUN_HOME']
        with open(os.path.join(home, 'owner-house-scribe.txt'), 'w', encoding='utf-8') as f:
            f.write('vpo_TEST-ONLY-owner-token\n')
        calls, out = [], io.StringIO()
        mandate = {'may_issue_credit': False, 'max_issue_per_deal': 25, 'max_issue_outstanding': 40, 'approve_above': 10}
        fake = types.SimpleNamespace(request=lambda method, path, body=None, token=None:
                                     calls.append((method, path, body, token)) or {'mandate': mandate})
        with mock.patch.object(H.vc, 'Client', return_value=fake), mock.patch('sys.stdout', out):
            H.sync_mandate('house-scribe', None)
        self.assertEqual(calls, [('GET', '/pilot/v1/owner', None, 'vpo_TEST-ONLY-owner-token'),
                                 ('PUT', '/pilot/v1/owner/mandate', {'may_issue_credit': True, 'max_issue_per_deal': 2}, 'vpo_TEST-ONLY-owner-token')])
        self.assertNotIn('vpo_', out.getvalue())
        self.assertIn('mandate_synced', out.getvalue())
        calls.clear()
        mandate.update(H.MANDATE)
        with mock.patch.object(H.vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            H.sync_mandate('house-scribe', None)
        self.assertEqual([c[0] for c in calls], ['GET'], 'nothing to change: nothing sent')
        with mock.patch('sys.stdout', io.StringIO()) as o:
            H.sync_mandate('house-reviewer', None)            # no owner token file for it here
        self.assertIn('mandate_sync_skipped', o.getvalue())


class Testnet(unittest.TestCase):
    """AI_SELLER_NETWORK=testnet (the second seller the entrypoint runs): the words and the mandate in nanoERG, the testnet's
    own skill.md, a self-serve join with no invite; prices stay PC-sized (valun.ai_seller scales them by the network)."""
    def load(self):
        import importlib.util
        env = {'AI_SELLER_NETWORK': 'testnet', 'VALUN_SERVER': 'https://valun-testnet.fly.dev'}
        with mock.patch.dict(os.environ, env):
            spec = importlib.util.spec_from_file_location('ai_seller_testnet', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_seller.py'))
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
        return m

    def test_words_and_mandate_in_nanoerg_the_testnets_skill_md(self):
        T = self.load()
        self.assertEqual((T.UNIT, T.SCALE, T.HOST), ('nanoERG', 1_000_000, 'valun-testnet.fly.dev'))
        about = T.AGENTS['house-scribe']['about']
        self.assertIn('I also pay 0.002 tERG for an onboarding report', about)
        for h in T.AGENTS:
            self.assertLessEqual(len(T.AGENTS[h]['about']), 300, h)
        self.assertIn('valun-testnet.fly.dev/skill.md', about)
        self.assertNotIn('valun.tech', about + T.AGENTS['house-reviewer']['about'] + T.WANTS['docs-fix']['blurb'] + T.WANTS['report']['criteria'])
        self.assertEqual(T.WANTS['docs-fix']['reference_url'], 'https://valun-testnet.fly.dev/skill.md')
        self.assertEqual((T.WANTS['report']['price'], T.WANTS['docs-fix']['price']), (2, 2), 'PC-sized: the seller scales them')
        self.assertEqual(T.MANDATE, {'may_issue_credit': True, 'max_issue_per_deal': 2_000_000, 'max_issue_outstanding': 40_000_000})
        for h in T.AGENTS:
            self.assertLessEqual(len(T.services_text(h)), 300, 'the server keeps at most 300 characters')
            self.assertLessEqual(len(T.wants_text(h)), 300)
        self.assertIn('summary (2000000 nanoERG (0.002 tERG))', T.services_text('house-scribe'))
        self.assertIn('report (2000000 nanoERG (0.002 tERG))', T.wants_text('house-scribe'))
        self.assertEqual(H.services_text('house-scribe'), ais.services_text(H.AGENTS['house-scribe']['services']), 'the pilot: the full blurbs')

    def test_the_pilot_reads_as_before(self):
        self.assertEqual((H.UNIT, H.SCALE), ('PC', 1))
        self.assertIn('I also pay 2 PC for an onboarding report or a fix to valun.tech/skill.md', H.AGENTS['house-scribe']['about'])
        self.assertEqual(H.MANDATE, {'may_issue_credit': True, 'max_issue_per_deal': 2, 'max_issue_outstanding': 40})


if __name__ == '__main__':
    unittest.main()
