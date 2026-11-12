"""valun_status brief mode (for small models): the brief view keeps what an agent needs to act and drops the long honest
labels (they stay in the full view); brief=true / false on the call, or brief_status as the agent's default; the
profile setting `valun config brief_status on|off` read by `valun call` and `valun mcp`. The behaviour over a server is
covered by the JS parity fixtures (js/test/fixtures/generate_python_fixtures.py, the 'status: brief' scenarios)."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from valun import agent as va
from valun import cli
from valun import client as vc
from valun import schemas

FULL = {
    'connected': True, 'server': 'https://valun.tech', 'network': 'valun-pilot-1', 'unit': 'PC (pilot credits, no monetary value)',
    'you': {'id': 'vp_a1a1a1a1a1a1', 'handle': 'alice', 'about': 'x' * 300, 'sandbox_only': True, 'sandbox_expires_at': '2026-11-19T00:00:00Z'},
    'objective_from_your_owner': 'Buy research briefs', 'goals_your_owner_told_you': 'stay under 10 PC',
    'limits_you_recorded': {}, 'limits_in_force': {'max_per_deal_as_payer': 5}, 'mandate': {'approve_above': 1000},
    'mandate_version': 3, 'approvals': 'Commitments are signed without asking your owner first.',
    'position': {'claims_held': 3, 'owes': 2, 'net': 1, 'meaning': 'y' * 300}, 'authority': 'agent token...',
    'settlement': 's' * 300, 'honest_labels': {'a': 'h' * 900}, 'real_vs_simulated': {'b': 'r' * 500},
    'summary': 'You hold 3 PC...', 'money_view': {'how_to_read': 'm' * 400},
    'notes_you_can_spend': [{'issuer': 'sandbox-exact', 'amount_PC': 3, 'checked_by_your_client': True, 'issuer_consents': 'immediate',
                             'how': 'valun_review_delivery ...' * 5}],
    'payments_in_progress': [{'deal_id': 'vd_1'}], 'clearing': {'your_client_signs': ['set-offs'], 'consents_pending': 2, 'recent': []},
    'consent_policy_in_force': {'setoff': True}, 'sandbox_next_steps': {'tour_step': 2, 'of': 5, 'goal': 'g' * 200,
                                                                         'next_calls': [{'tool': 'valun_propose'}], 'then': 'call again',
                                                                         'with_the_sandbox_agents': {'x': 1}},
}


class BriefView(unittest.TestCase):
    def test_keeps_what_an_agent_needs_and_drops_the_long_labels(self):
        b = va.brief_status(FULL)
        self.assertEqual(b['brief'], True)
        self.assertEqual(b['you'], {'id': 'vp_a1a1a1a1a1a1', 'handle': 'alice', 'sandbox_expires_at': '2026-11-19T00:00:00Z'})
        self.assertEqual((b['you_hold_PC'], b['you_owe_PC'], b['net_PC']), (3, 2, 1))
        self.assertEqual(b['notes_you_can_spend'], [{'issuer': 'sandbox-exact', 'amount_PC': 3, 'checked_by_your_client': True}])
        self.assertEqual((b['payments_in_progress'], b['consents_pending']), (1, 2))
        self.assertEqual(b['sandbox_next_steps'], {'tour_step': 2, 'next_calls': [{'tool': 'valun_propose'}], 'then': 'call again'})
        for k in ('honest_labels', 'real_vs_simulated', 'settlement', 'mandate', 'money_view', 'consent_policy_in_force', 'authority'):
            self.assertNotIn(k, b)
        self.assertIn('no monetary value', b['note'])
        self.assertLess(len(json.dumps(b)), len(json.dumps(FULL)) / 3)

    def test_without_circulating_credit_no_circulation_keys(self):
        full = {k: v for k, v in FULL.items() if k not in ('notes_you_can_spend', 'payments_in_progress', 'clearing', 'sandbox_next_steps')}
        b = va.brief_status(full)
        for k in ('notes_you_can_spend', 'payments_in_progress', 'consents_pending', 'sandbox_next_steps'):
            self.assertNotIn(k, b)

    def test_the_schema_offers_brief(self):
        props = schemas.STATUS['parameters']['properties']
        self.assertEqual(props['brief']['type'], 'boolean')
        self.assertIn('brief=true', schemas.STATUS['description'])


class Choosing(unittest.TestCase):
    def agent(self, **kw):
        a = va.ValunAgent(None, **kw)
        a._full_status = lambda: dict(FULL)
        return a

    def test_the_call_and_the_default(self):
        self.assertNotIn('brief', self.agent().status({}))
        self.assertTrue(self.agent().status({'brief': True})['brief'])
        self.assertTrue(self.agent(brief_status=True).status({})['brief'])
        self.assertTrue(self.agent(brief_status=True).status(None)['brief'])
        self.assertNotIn('brief', self.agent(brief_status=True).status({'brief': False}))
        with self.assertRaises(vc.ValunError) as e:
            self.agent().status({'brief': 'yes'})
        self.assertEqual(e.exception.code, 'bad_arguments')


class Setting(unittest.TestCase):
    def test_valun_config_brief_status(self):
        home = tempfile.mkdtemp(prefix='valun-brief-')
        with mock.patch.dict(os.environ, {'VALUN_HOME': home}):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(cli.main(['config', 'brief_status', 'on']), 0)
            self.assertIn('brief view', out.getvalue())
            store = cli._store(cli.argparse.Namespace(profile='default'))
            self.assertIs(store.state.get('brief_status'), True)
            agent, _mode = cli._agent(cli.argparse.Namespace(profile='default', server=None), store)
            self.assertIs(agent.brief_status, True)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['config', 'brief_status', 'maybe']), 1)
                self.assertEqual(cli.main(['config', 'brief_status', 'off']), 0)
            self.assertIs(cli._store(cli.argparse.Namespace(profile='default')).state.get('brief_status'), False)


if __name__ == '__main__':
    unittest.main()
