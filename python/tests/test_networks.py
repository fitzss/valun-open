"""0.5: the networks a client signs for. A profile takes its network from the join's answer (servers since 0.5 name
it), enrolls on it, builds terms for it in its unit, and refuses terms for another network and any network it does not
know; the default consent cap is scaled to the network (50 PC-sized amounts). Offline: a recorder stands in for HTTP."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import client as vc  # noqa: E402
from valun import cli  # noqa: E402

HOME = tempfile.mkdtemp(prefix='valun-networks-test-')


class Recorder(vc.Client):
    def __init__(self, *a, answers=None, **kw):
        super().__init__(*a, **kw)
        self.calls, self.answers = [], answers or {}

    def request(self, method, path, body=None, auth=True, token=None):
        self.calls.append((method, path, body))
        return self.answers.get((method, path), {})


def store():
    return vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME))


class Networks(unittest.TestCase):
    def test_known_networks_and_their_units(self):
        self.assertEqual(vc.network_of('valun-pilot-1'), {'unit': 'PC', 'scale': 1})
        self.assertEqual(vc.network_of('valun-testnet-1'), {'unit': 'nanoERG', 'scale': 1_000_000})
        for bad in ('valun-mainnet-1', '', None, 'VALUN-TESTNET-1'):
            with self.assertRaises(vc.ValunError) as e:
                vc.network_of(bad)
            self.assertEqual(e.exception.code, 'unknown_network')

    def test_a_profile_without_a_network_is_on_the_pilot(self):
        c = Recorder(store(), 'https://example.test')
        self.assertEqual((c.network, c.unit, c.scale), ('valun-pilot-1', 'PC', 1))

    def test_the_join_names_the_network_and_the_key_enrolls_on_it(self):
        c = Recorder(store(), 'https://example.test', answers={
            ('POST', '/pilot/v1/join-sandbox'): {'participant_id': 'vp_' + 'a' * 12, 'network': 'valun-testnet-1', 'enrollment_code': 'vpe_x'},
            ('POST', '/pilot/v1/enroll'): {'participant_id': 'vp_' + 'a' * 12, 'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1'}})
        c.join_sandbox('tn-agent', 'Ann')
        self.assertEqual(c.state['network'], 'valun-testnet-1')
        c.enroll('vp_' + 'a' * 12, 'vpe_x')
        method, path, body = c.calls[-1]
        self.assertEqual(path, '/pilot/v1/enroll')
        self.assertEqual([p for _m, p, _b in c.calls], ['/pilot/v1/join-sandbox', '/pilot/v1/enroll'], 'no extra request')
        from valun import basis as vb
        msg = vc.statement('enroll', 'valun-testnet-1', 'vp_' + 'a' * 12, body['pubkey'], vc.sha256_hex('vpe_x')).encode('utf-8')
        self.assertTrue(vb.verify(bytes.fromhex(body['signature']), msg, bytes.fromhex(body['pubkey'])), 'signed for the testnet')
        self.assertEqual((c.network, c.unit), ('valun-testnet-1', 'nanoERG'))

    def test_an_unknown_network_in_the_join_or_the_enroll_is_refused(self):
        c = Recorder(store(), 'https://example.test', answers={('POST', '/pilot/v1/join'): {'participant_id': 'vp_' + 'b' * 12, 'network': 'valun-mainnet-1'}})
        with self.assertRaises(vc.ValunError) as e:
            c.join('inv', 'x-agent', 'Ann')
        self.assertEqual(e.exception.code, 'unknown_network')
        c = Recorder(store(), 'https://example.test', answers={
            ('POST', '/pilot/v1/enroll'): {'participant_id': 'vp_' + 'c' * 12, 'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1'}})
        with self.assertRaises(vc.ValunError) as e:
            c.enroll('vp_' + 'c' * 12, 'vpe_y')           # the profile is on the pilot; the server says testnet
        self.assertEqual(e.exception.code, 'wrong_network')

    def test_terms_carry_the_profiles_network_and_unit(self):
        s = store()
        s.state.update({'participant_id': 'vp_' + 'd' * 12, 'pubkey': '02' + 'ab' * 32, 'network': 'valun-testnet-1'})
        c = Recorder(s, 'https://example.test', answers={
            ('GET', '/pilot/v1/info'): {'network': 'valun-testnet-1', 'tracker_nft_id': 'ee' * 32, 'denomination': 'erg'},
            ('GET', '/pilot/v1/participants/vp_' + 'f' * 12): {'id': 'vp_' + 'f' * 12, 'pubkey': '03' + 'cd' * 32, 'status': 'active'}})
        t = c.build_terms('vp_' + 'f' * 12, 'payer', 'Summary', 'Summarize it', 'markdown', 2_000_000)
        self.assertEqual((t['network'], t['price'], t['denomination']), ('valun-testnet-1', {'amount': 2_000_000, 'unit': 'nanoERG'}, 'erg'))

    def test_the_default_consent_cap_is_scaled_to_the_network(self):
        s = store()
        s.state['network'] = 'valun-testnet-1'
        self.assertEqual(cli._scaled_policy({'setoff': True, 'max_PC': 50}, s), {'setoff': True, 'max_PC': 50_000_000})
        p = store()
        self.assertEqual(cli._scaled_policy({'max_PC': 50}, p)['max_PC'], 50, 'the pilot: unchanged')


# ---------- what the testnet texts say (0.5): amounts in nanoERG with tERG, and labels true on Ergo testnet ----------
from valun import agent as va  # noqa: E402

# The server's deal labels on the testnet (valun-app lib/pilot/core.mjs), word for word.
SERVER_TESTNET_REDEMPTION = ("Its creditor can redeem it on Ergo testnet against the issuer's tERG reserve, if the issuer "
                             'posted one; tERG are test coins with no monetary value.')
SERVER_CIRCULATION_SETTLEMENT_TESTNET = (
    'not settled until redeemed: a credit note is an outstanding obligation. With circulating credit it can move to a new '
    'creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation '
    '(set-off, signed by every party; no net position changes); a netting is final once a tracker box on Ergo testnet commits '
    'it. ' + SERVER_TESTNET_REDEMPTION)
SERVER_SETTLEMENT_TESTNET = 'not settled until redeemed: issuing a credit note creates an outstanding obligation. ' + SERVER_TESTNET_REDEMPTION
# What is true on the pilot and false on the testnet.
PILOT_ONLY = ('PC', 'Nothing is redeemed', 'no reserve', 'local_only', 'no blockchain connection', 'pilot tracker',
              'settlement does not exist')


class TestnetWording(unittest.TestCase):
    def test_amounts_read_in_nanoerg_and_terg_exactly(self):
        for n, text in [(3_000_000, '3000000 nanoERG (0.003 tERG)'), (1_500_000_000, '1500000000 nanoERG (1.5 tERG)'),
                        (1_000_000_000, '1000000000 nanoERG (1 tERG)'), (1, '1 nanoERG (0.000000001 tERG)'),
                        (0, '0 nanoERG (0 tERG)'), (-2_000_000, '-2000000 nanoERG (-0.002 tERG)'),
                        (123_456_789_012, '123456789012 nanoERG (123.456789012 tERG)')]:
            self.assertEqual(vc.amount_text(n, 'nanoERG'), text)
        self.assertEqual(vc.amount_text(3, 'PC'), '3 PC', 'the pilot: as before')
        self.assertEqual(vc.amount_text(None, 'nanoERG'), 'None nanoERG', 'not a whole number: shown as is')

    def test_the_testnet_labels_are_the_servers_and_say_nothing_only_the_pilot_is(self):
        for circulating, settlement in ((True, SERVER_CIRCULATION_SETTLEMENT_TESTNET), (False, SERVER_SETTLEMENT_TESTNET)):
            lab = va.labels(circulating, 'valun-testnet-1')
            self.assertEqual(lab['settlement'], settlement, 'word for word the server\'s deal label')
            self.assertEqual(lab['not_settled'], settlement)
            texts = [lab['settlement'], *lab['honest_labels'].values(), *lab['real_vs_simulated'].values()]
            for t in texts:
                for words in PILOT_ONLY:
                    self.assertNotIn(words, t, f'{circulating}: {t[:60]}')
            self.assertIn('anchors them on Ergo testnet', lab['honest_labels']['what_basis_records'])
            self.assertIn("issuer's reserve", lab['honest_labels']['what_basis_records'])
        self.assertEqual(va.labels(True), va.labels(True, 'valun-pilot-1'), 'the pilot: as before')
        self.assertIn('Nothing is redeemed', va.labels(True)['settlement'])

    def test_approval_texts_and_the_tour_on_the_testnet(self):
        self.assertEqual(va.owes('payer', 'bob', 3_000_000, 'nanoERG'),
                         'after you accept their delivery you will owe bob 3000000 nanoERG (0.003 tERG) (your credit note).')
        self.assertEqual(va.owes('payee', 'bob', 3, 'PC'), 'you must deliver; bob would then owe you 3 PC (their credit note).')
        self.assertEqual(va.client_signs({'setoff': True, 'max_PC': 50_000_000}, 'nanoERG'),
                         ['set-offs that cancel equal claims and debts of yours around a cycle (your net position does not change), '
                          'up to 50000000 nanoERG (0.05 tERG) each'])
        goal = va.tour_goal(3, 'nanoERG', 1_000_000)
        self.assertEqual(goal, 'Pay with your own note: buy notary from sandbox-exact (2000000 nanoERG (0.002 tERG)). Then the '
                               '2-cycle you -> sandbox-exact -> you (1000000 nanoERG (0.001 tERG)) is cleared by a set-off your '
                               'Valun client signs by itself.')
        self.assertEqual(va.tour_goal(3), va.TOUR_GOALS[3], 'the pilot: as before')
        self.assertEqual(va.tour_goal('done', 'nanoERG', 1_000_000), 'The tour is complete.')
        snap = {'counterparty': {'id': 'vp_' + 'f' * 12, 'handle': 'sandbox-exact'}, 'unit': 'nanoERG', 'network': 'valun-testnet-1',
                'not_settled': va.labels(True, 'valun-testnet-1')['not_settled']}
        text = va.ValunAgent._text_propose({'role': 'payer', 'price': 3_000_000, 'title': 't', 'description': 'd', 'deliverable': 'x'}, snap)
        self.assertIn('price: 3000000 nanoERG (0.003 tERG)', text)
        self.assertIn('you will owe sandbox-exact 3000000 nanoERG (0.003 tERG)', text)
        self.assertNotIn(' PC', text)
        self.assertIn('redeem it on Ergo testnet', text)
        self.assertEqual(va.tracker_words('valun-testnet-1'), 'the Valun testnet tracker (anchored on Ergo testnet)')
        self.assertEqual(va.brief_status({'network': 'valun-testnet-1'})['note'], va.BRIEF_NOTE_TESTNET)
        self.assertNotIn('PC', va.BRIEF_NOTE_TESTNET)
        self.assertEqual(va.brief_status({'network': 'valun-pilot-1'})['note'], va.BRIEF_NOTE)


if __name__ == '__main__':
    unittest.main()
