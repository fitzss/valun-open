"""0.5: the networks a client signs for. A profile takes its network from the join's answer (servers since 0.5 name
it), enrolls on it, builds terms for it in its unit, and refuses terms for another network and any network it does not
know; the default consent cap is scaled to the network (50 PC-sized amounts). Offline: a recorder stands in for HTTP."""
import tempfile
import unittest

from valun import client as vc
from valun import cli

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


if __name__ == '__main__':
    unittest.main()
