"""Offline tests of the house agents' own parts: which agents run with which services, their joining and profile sync,
and the sellers built over one budget, on both networks the file knows: the testnet (the default: nanoERG, scale
1,000,000) and one counted in PC (scale 1, as the pilot was). The seller itself (answering offers, budgets, checks,
receipts) is valun.ai_seller's and is tested with the package (python/tests/test_ai_seller.py).

    cd examples/ai-seller && PYTHONPATH=../../python/src python -m unittest test_ai_seller.py"""
import importlib.util
import io
import json
import os
import tempfile
import types
import unittest
from unittest import mock

os.environ['VALUN_HOME'] = tempfile.mkdtemp(prefix='house-agents-test-')
HERE = os.path.dirname(os.path.abspath(__file__))
from valun import ai_seller as ais  # noqa: E402
from valun import client as vc  # noqa: E402


def load(name, **env):
    """ai_seller.py loaded afresh as module `name`, with AI_SELLER_NETWORK and VALUN_SERVER only as `env` gives them."""
    base = {k: v for k, v in os.environ.items() if k not in ('AI_SELLER_NETWORK', 'VALUN_SERVER')}
    with mock.patch.dict(os.environ, {**base, **env}, clear=True):
        spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, 'ai_seller.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
    return m


H = load('house_agents_default')                                                         # no settings: the testnet
T = load('house_agents_testnet', AI_SELLER_NETWORK='testnet', VALUN_SERVER='https://valun-testnet.fly.dev')
P = load('house_agents_pilot', AI_SELLER_NETWORK='pilot', VALUN_SERVER='https://valun.tech')     # PC, scale 1


def network_name(m):
    return 'valun-testnet-1' if m.NETWORK == 'testnet' else 'valun-pilot-1'


class Agents(unittest.TestCase):
    """On the testnet (what the entrypoint runs); AgentsPilot runs them again on a network counted in PC."""
    M = T

    def stores(self):
        """A profile per agent, as a join on this module's network leaves it (FileStores in temporary files)."""
        out = {}
        for h in self.M.AGENTS:
            st = vc.FileStore(tempfile.mktemp(suffix='.json'))
            st.state['network'] = network_name(self.M)
            out[h] = st
        return out

    def test_every_service_exists_and_the_text_lists_them(self):
        M = self.M
        for h, spec in M.AGENTS.items():
            self.assertEqual(ais.parse_services(','.join(spec['services'])), tuple(spec['services']), h)
            self.assertLessEqual(len(spec['about']), 300, f'{h}: the server keeps at most 300 characters')
            self.assertLessEqual(len(M.services_text(h)), 300, h)
            self.assertLessEqual(len(M.wants_text(h)), 300, h)
        self.assertIn(f'check ({M.amt(2)})', M.services_text('house-reviewer'))
        self.assertIn(f'code-review ({M.amt(3)})', M.services_text('house-reviewer'))
        self.assertIn(f'summary ({M.amt(2)})', M.services_text('house-scribe'))

    def test_the_wants_are_whole_specs_and_affordable_to_check(self):
        M = self.M
        self.assertEqual(list(M.wants_of('house-scribe')), ['x-feedback', 'report', 'docs-fix'])   # x-feedback first
        self.assertEqual(list(M.wants_of('house-reviewer')), ['report', 'docs-fix'])
        self.assertTrue(M.wants_text('house-reviewer').startswith(f'report ({M.amt(2)})'), M.wants_text('house-reviewer'))
        self.assertTrue(M.wants_text('house-scribe').startswith(f'x-feedback ({M.amt(2)})'), M.wants_text('house-scribe'))
        # "feedback" is also a report's keyword: the scribe's x-feedback is found first, a plain report stays a report.
        scribe = M.wants_of('house-scribe')
        self.assertEqual(ais.which_want(scribe, {'service': {'title': 'x-feedback from @alice on X'}}), 'x-feedback')
        self.assertEqual(ais.which_want(scribe, {'service': {'title': 'Onboarding feedback report'}}), 'report')
        for name, spec in M.WANTS.items():
            for k in ('price', 'max_chars', 'max_tokens', 'effort', 'keywords', 'blurb', 'criteria'):
                self.assertIn(k, spec, f'{name}.{k}')
            self.assertLessEqual(spec['price'] * M.SCALE, M.MANDATE['max_issue_per_deal'], f'{name}: its pay, in the unit')
            self.assertEqual(ais.which_want(M.WANTS, {'service': {'title': f'{name}: one for you'}}), name)
        self.assertEqual(M.WANTS['docs-fix']['reference_url'], M.SERVER + '/skill.md')
        # The dearest check stays well under the daily cap.
        s = M.sellers(self.stores(), types.SimpleNamespace(model=M.MODEL), ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1))[0]
        self.assertLess(max(s.want_worst(spec) for spec in M.WANTS.values()), 0.25)

    def test_sellers_share_one_budget_and_keep_checks_apart(self):
        M = self.M
        b = ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1)
        run = M.sellers(self.stores(), None, b)
        self.assertEqual([s.handle for s in run], list(M.AGENTS))
        self.assertEqual([s.services for s in run], [tuple(a['services']) for a in M.AGENTS.values()])
        self.assertTrue(all(s.budget is b for s in run))
        self.assertEqual((run[1].jobs_per_buyer, run[1].checks_per_buyer), (M.JOBS_PER_BUYER_PER_DAY, M.CHECKS_PER_BUYER_PER_DAY))
        self.assertEqual([sorted(s.wants) for s in run], [['docs-fix', 'report', 'x-feedback'], ['docs-fix', 'report']])
        self.assertEqual((run[0].wants_per_payee, run[0].wants_per_day), (1, M.WANTS_PER_DAY))
        self.assertTrue(run[0].received.endswith('wants-received-house-scribe.jsonl'))
        self.assertNotEqual(run[1].counted('ana', 'check'), run[1].counted('ana', 'code-review'))

    def test_the_seller_prices_in_its_clients_unit(self):
        M = self.M
        run = M.sellers(self.stores(), None, ais.Budget(tempfile.mktemp(suffix='.json'), 18, 1))
        self.assertEqual([s.c.scale for s in run], [M.SCALE, M.SCALE], "the client's scale, from the network it enrolled on")
        self.assertEqual(run[0]._price(M.WANTS['x-feedback']), 2 * M.SCALE, 'the PC-sized pay, in the unit')
        self.assertEqual(run[0]._price(ais.SERVICE_SPECS['summary']), 2 * M.SCALE, "what @bindvalun's tl;dr offers")
        self.assertEqual(run[1]._price(ais.SERVICE_SPECS['code-review']), 3 * M.SCALE)
        self.assertEqual(M.MANDATE['max_issue_per_deal'], run[0]._price(M.WANTS['report']), 'the mandate allows exactly the pay')

    def test_profile_sync_sends_only_what_differs(self):
        M = self.M
        sent = []
        fake = types.SimpleNamespace(me=lambda: {'participant': {'about': M.AGENTS['house-reviewer']['about'], 'services': 'old',
                                                                 'wants': M.wants_text('house-reviewer')}},
                                     set_profile=lambda **kw: sent.append(kw))
        with mock.patch.object(vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            M.sync_profile('house-reviewer', None)
        self.assertEqual(sent, [{'services': M.services_text('house-reviewer')}])
        # A server record without wants (none set yet): they are sent.
        sent.clear()
        fake.me = lambda: {'participant': {'about': M.AGENTS['house-scribe']['about'], 'services': M.services_text('house-scribe')}}
        with mock.patch.object(vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            M.sync_profile('house-scribe', None)
        self.assertEqual(sent, [{'wants': M.wants_text('house-scribe')}])

    def test_mandate_sync_lets_it_pay_and_never_prints_the_token(self):
        M, S = self.M, self.M.SCALE
        home = os.environ['VALUN_HOME']
        with open(os.path.join(home, 'owner-house-scribe.txt'), 'w', encoding='utf-8') as f:
            f.write('vpo_TEST-ONLY-owner-token\n')
        calls, out = [], io.StringIO()
        mandate = {'may_issue_credit': False, 'max_issue_per_deal': 25 * S, 'max_issue_outstanding': 40 * S, 'approve_above': 10 * S}
        fake = types.SimpleNamespace(request=lambda method, path, body=None, token=None:
                                     calls.append((method, path, body, token)) or {'mandate': mandate})
        with mock.patch.object(vc, 'Client', return_value=fake), mock.patch('sys.stdout', out):
            M.sync_mandate('house-scribe', None)
        self.assertEqual(calls, [('GET', '/pilot/v1/owner', None, 'vpo_TEST-ONLY-owner-token'),
                                 ('PUT', '/pilot/v1/owner/mandate', {'may_issue_credit': True, 'max_issue_per_deal': 2 * S},
                                  'vpo_TEST-ONLY-owner-token')])
        self.assertNotIn('vpo_', out.getvalue())
        self.assertIn('mandate_synced', out.getvalue())
        calls.clear()
        mandate.update(M.MANDATE)
        with mock.patch.object(vc, 'Client', return_value=fake), mock.patch('sys.stdout', io.StringIO()):
            M.sync_mandate('house-scribe', None)
        self.assertEqual([c[0] for c in calls], ['GET'], 'nothing to change: nothing sent')
        with mock.patch('sys.stdout', io.StringIO()) as o:
            M.sync_mandate('house-reviewer', None)            # no owner token file for it here
        self.assertIn('mandate_sync_skipped', o.getvalue())


class AgentsPilot(Agents):
    """The same on a network counted in PC (AI_SELLER_NETWORK=pilot): scale 1, invited participants."""
    M = P

    def test_the_first_run_needs_an_invite(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VALUN_INVITE_HOUSE_SCRIBE', None)
            with self.assertRaises(SystemExit) as e:
                P.bootstrap('house-scribe')
            self.assertIn('VALUN_INVITE_HOUSE_SCRIBE', str(e.exception))


class Testnet(unittest.TestCase):
    """AI_SELLER_NETWORK=testnet, the house agents the entrypoint runs (and the file's default): the words and the
    mandate in nanoERG, the testnet's own skill.md, a self-serve join with no invite; prices stay PC-sized
    (valun.ai_seller scales them by the client's network)."""

    def test_the_defaults_are_the_testnet(self):
        self.assertEqual((H.NETWORK, H.SERVER, H.HOST), ('testnet', 'https://valun-testnet.fly.dev', 'valun-testnet.fly.dev'))
        self.assertEqual((H.UNIT, H.SCALE), (vc.NETWORKS['valun-testnet-1']['unit'], vc.NETWORKS['valun-testnet-1']['scale']))
        self.assertEqual((H.MANDATE, H.AGENTS, H.WANTS), (T.MANDATE, T.AGENTS, T.WANTS))
        self.assertEqual((P.UNIT, P.SCALE), (vc.NETWORKS['valun-pilot-1']['unit'], vc.NETWORKS['valun-pilot-1']['scale']))
        with self.assertRaises(SystemExit):
            load('house_agents_bad', AI_SELLER_NETWORK='mainnet')

    def test_words_and_mandate_in_nanoerg_the_testnets_skill_md(self):
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
        m = T.selling_mandate()
        self.assertEqual((m['max_accept_per_deal'], m['max_accept_per_issuer'], m['approve_above']), (5_000_000, 20_000_000, 10_000_000), 'within the self-serve caps')
        self.assertNotIn('expires_at', m, 'the server keeps the self-serve expiry')
        self.assertIsNone(P.selling_mandate()['expires_at'], 'the pilot: no expiry, as before')
        for h in T.AGENTS:
            self.assertLessEqual(len(T.services_text(h)), 300, 'the server keeps at most 300 characters')
            self.assertLessEqual(len(T.wants_text(h)), 300)
        self.assertIn('summary (2000000 nanoERG (0.002 tERG))', T.services_text('house-scribe'))
        self.assertIn('report (2000000 nanoERG (0.002 tERG))', T.wants_text('house-scribe'))
        self.assertEqual(P.services_text('house-scribe'), ais.services_text(P.AGENTS['house-scribe']['services']), 'the pilot: the full blurbs')

    def test_the_first_run_joins_self_serve_and_sets_the_mandate_in_nanoerg(self):
        home, calls, sent, out = tempfile.mkdtemp(prefix='house-agents-join-'), [], [], io.StringIO()

        def run(argv, **kw):                       # `python -m valun ...`: a join leaves the profile and the owner token
            calls.append(list(argv))
            if 'join' in argv:
                with open(os.path.join(home, 'profiles', 'house-scribe.json'), 'w', encoding='utf-8') as f:
                    json.dump({'participant_id': 'vp_0123456789ab', 'network': 'valun-testnet-1'}, f)
                with open(argv[argv.index('--owner-token-file') + 1], 'w', encoding='utf-8') as f:
                    f.write('vpo_TEST-ONLY-owner-token\n')
            return types.SimpleNamespace(returncode=0, stdout='Enrolled vp_0123456789ab on valun-testnet-1.', stderr='')
        fake = types.SimpleNamespace(request=lambda method, path, body=None, token=None: sent.append((method, path, body, token)) or {})
        env = {k: v for k, v in os.environ.items() if not k.startswith('VALUN_INVITE_')}
        with mock.patch.dict(os.environ, dict(env, VALUN_HOME=home), clear=True), mock.patch.object(T.subprocess, 'run', run), \
                mock.patch.object(vc, 'Client', return_value=fake), mock.patch('sys.stdout', out):
            store = T.bootstrap('house-scribe')
        join = calls[0]
        self.assertIn('--sandbox', join, 'self-serve: no invite on the testnet')
        self.assertNotIn('--invite-from-stdin', join)
        self.assertEqual(join[join.index('--server') + 1], 'https://valun-testnet.fly.dev')
        self.assertEqual(join[join.index('--services') + 1], T.services_text('house-scribe'))
        self.assertEqual([(m, p) for m, p, _b, _t in sent], [('PUT', '/pilot/v1/owner/mandate')])
        m = sent[0][2]
        self.assertEqual((m['max_accept_per_deal'], m['max_accept_per_issuer'], m['approve_above']), (5_000_000, 20_000_000, 10_000_000))
        self.assertNotIn('expires_at', m)
        self.assertTrue(store.state.get('house_selling_mandate'))
        self.assertEqual(calls[1][-3:], ['config', 'consents.as_new_creditor', 'on'])
        self.assertNotIn('vpo_', out.getvalue(), 'the owner token is never printed')

    def test_the_pilot_reads_as_before(self):
        self.assertEqual((P.UNIT, P.SCALE), ('PC', 1))
        self.assertIn('I also pay 2 PC for an onboarding report or a fix to valun.tech/skill.md', P.AGENTS['house-scribe']['about'])
        self.assertEqual(P.MANDATE, {'may_issue_credit': True, 'max_issue_per_deal': 2, 'max_issue_outstanding': 40})
        self.assertTrue(P.wants_text('house-reviewer').startswith('report (2 PC): an onboarding report on Valun'))


if __name__ == '__main__':
    unittest.main()
