"""0.7.2 wording (the newcomer tests and the docs path, 2026-11-17):
- amounts in the network's unit: on valun-testnet-1 nanoERG with tERG beside, never PC (`valun clearing run` printed
  "3000000 PC (your net change 0 PC)", `valun status` "max_PC 50000000", join --help "(3 PC)");
- a netting is committed, not final (the server's own label since Nov 16);
- counterparties are not "independently controlled agents": most listed so far are the operator's test agents or the
  team's own (the site's words)."""
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import cli  # noqa: E402
from valun import mcp_server as mcp  # noqa: E402
from valun import schemas  # noqa: E402

PC = re.compile(r'\bPC\b')


class Amounts(unittest.TestCase):
    def test_the_policy_line_and_the_decisions_name_the_unit(self):
        self.assertEqual(cli._policy_line({'setoff': True, 'max_PC': 50_000_000}, 'nanoERG'),
                         'setoff on, as_issuer off, as_new_creditor off, at most 50000000 nanoERG (0.05 tERG) each (consents.max_PC)')
        self.assertEqual(cli._policy_line({}, 'nanoERG'), 'setoff off, as_issuer off, as_new_creditor off, no cap (consents.max_PC none)')
        lines = cli._decisions({'signed': [{'kind': 'setoff', 'id': 'vs_6cd4ef0ffae9592b', 'role': 'member', 'amount': 3_000_000,
                                            'your_net_change_PC': 0}]}, 'nanoERG')
        self.assertEqual(lines, ['  signed   setoff vs_6cd4ef0ffae9592b as member, 3000000 nanoERG (0.003 tERG) (your net change '
                                 '0 nanoERG (0 tERG))'])

    def help_of(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(list(argv))
        return out.getvalue()

    def test_help_texts_name_no_pc(self):
        for argv in (('join', '--help'), ('sell', '--help')):
            text = self.help_of(*argv)
            self.assertIsNone(PC.search(text), (argv, text))
        self.assertIn('the Valun server to join (default https://valun.tech, the public testnet; also VALUN_SERVER)',
                      ' '.join(self.help_of('join', '--help').split()))

    def test_status_of_a_testnet_profile(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {'VALUN_HOME': home}):
            os.makedirs(os.path.join(home, 'profiles'))
            with open(os.path.join(home, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
                json.dump({'server': 'https://valun.example', 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                           'consent_policy': {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 50_000_000},
                           'consent_loop': 'on'}, f)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                os.environ.pop('VALUN_PROFILE', None)
                cli.main(['status'])
        self.assertIn('consents:         setoff on, as_issuer on, as_new_creditor on, at most 50000000 nanoERG (0.05 tERG) each '
                      '(consents.max_PC); consent loop: on', out.getvalue())
        self.assertIsNone(PC.search(out.getvalue()), out.getvalue())


class Words(unittest.TestCase):
    def test_no_netting_is_final_and_no_counterparty_is_called_independent(self):
        texts = [mcp.INSTRUCTIONS, mcp.INSTRUCTIONS_TESTNET, json.dumps(schemas.ALL), json.dumps(schemas.for_network(schemas.TESTNET))]
        for net in ('valun-testnet-1', 'valun-pilot-1'):
            for circulating in (True, False):
                texts.append(json.dumps(va.labels(circulating, net)))
        for text in texts:
            self.assertNotIn('independently controlled', text)
            self.assertNotIn('stays final', text)
            self.assertNotIn('is final once', text)
        self.assertIn("Most agents listed so far are the operator's test agents (house-*, sandbox-*, lab-*) or the team's own.",
                      mcp.INSTRUCTIONS_TESTNET)
        self.assertIn("counterparties are other agents, each holding its own key: most listed so far are the operator's test "
                      "agents (house-*, sandbox-*, lab-*) or the team's own.", schemas.for_network(schemas.TESTNET)[0]['description'])
        self.assertIn('a netting is committed once a tracker box on Ergo testnet commits it, and stays committed only as long as '
                      'the tracker key never commits an earlier total again', va.labels(True, 'valun-testnet-1')['settlement'])


if __name__ == '__main__':
    unittest.main()
