"""The CLI with circulating credit, against the fake v16 server and sandbox agents of test_agent_circulation.py (offline,
real signatures, throwaway keys, a temporary VALUN_HOME): join writes the local consent policy and sets the owner
mandate's auto_clear (only where the server offers circulation/1), the consents.* and consent_loop settings, `valun
policy show`, `valun clearing status|run`, and `valun sandbox tour` taking a fresh sandbox joiner through the five
steps of design 9.2 with the exact tracker totals after each step; also `valun sandbox earn` and `buy --pay-with`."""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import agent as va  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import sandbox as sb  # noqa: E402
from test_agent_circulation import CIRC, M_ID, SERVER, S_ID, X_ID, World, now_ms, routed, sign_note  # noqa: E402

# S's edges (as `valun sandbox tour` prints them) after each step, and the sandbox agents' own edges at the end (design 9.2).
TOUR_TOTALS = {1: {'sandbox-exact -> you': 3},
               2: {'sandbox-exact -> you': 1},
               3: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 1},
               4: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 0, 'sandbox-mallory -> you': 2},
               5: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 0, 'sandbox-mallory -> you': 0}}


class Tty(io.StringIO):
    def isatty(self):
        return True


class Cli(unittest.TestCase):
    features = CIRC

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home.name})
        env.start()
        self.addCleanup(env.stop)
        self.world = World(self.features, s_key=None)
        p = routed(self.world)
        p.start()
        self.addCleanup(p.stop)
        # The sandbox helpers' clock: a sleep moves it on at once, so waiting costs nothing and a tour that never
        # finishes reaches its deadline (and fails) in moments instead of hanging.
        clock = [sb.time.time()]
        nap = mock.patch.object(sb, 'time', types.SimpleNamespace(time=lambda: clock[0],
                                                                  sleep=lambda s: clock.__setitem__(0, clock[0] + max(s, 0.001))))
        nap.start()
        self.addCleanup(nap.stop)
        self.token_file = os.path.join(self.home.name, 'owner.txt')

    def run_cli(self, *argv, stdin=None, tty=False, answers=None):
        out = Tty() if tty else io.StringIO()
        patches = [contextlib.redirect_stdout(out)]
        if stdin is not None or tty:
            patches.append(mock.patch.object(sys, 'stdin', Tty(stdin or '') if tty else io.StringIO(stdin)))
        if answers is not None:
            patches.append(mock.patch('builtins.input', side_effect=answers))
        with contextlib.ExitStack() as stack:
            for x in patches:
                stack.enter_context(x)
            rc = cli.main(['--profile', 's', *argv])
        return rc, out.getvalue()

    def join(self, *extra, sandbox=True):
        args = ['join', '--handle', 'stranger', '--operator', 'Ann', '--approvals', 'none', '--server', SERVER,
                '--owner-token-file', self.token_file, *extra]
        args.append('--sandbox' if sandbox else '--invite-from-stdin')
        rc, out = self.run_cli(*args, stdin=None if sandbox else 'invite-code\n')
        self.assertEqual(rc, 0, out)
        return out

    def disk(self):
        with open(os.path.join(self.home.name, 'profiles', 's.json'), encoding='utf-8') as f:
            return json.load(f)


class Join(Cli):
    def test_a_sandbox_join_signs_all_three_roles_and_runs_the_loop(self):
        out = self.join()
        disk = self.disk()
        self.assertEqual((disk['consent_policy'], disk['consent_loop']), (va.SANDBOX_CONSENT_POLICY, 'on'))
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])
        self.assertIn('Clearing: auto.', out)
        self.assertNotIn('vpo_test-only', json.dumps(disk))

    def test_clearing_off_turns_auto_clear_off(self):
        self.join('--clearing', 'off')
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': False}])

    def test_an_invite_join_does_not_accept_transfers_by_itself(self):
        self.join(sandbox=False)
        disk = self.disk()
        self.assertEqual((disk['consent_policy'], disk['consent_loop']), (va.INVITE_CONSENT_POLICY, 'off'))
        self.assertEqual(va.INVITE_CONSENT_POLICY, {'setoff': True, 'as_issuer': True, 'as_new_creditor': False, 'max_PC': 50})


class JoinWithoutCirculation(Cli):
    features = None

    def test_the_mandate_put_is_as_in_0_3_and_the_policy_waits_locally(self):
        out = self.join('--clearing', 'off')
        self.assertEqual(self.world.puts, [{'approve_above': 5}])            # no auto_clear: the field does not exist yet
        self.assertEqual(self.disk()['consent_policy'], va.SANDBOX_CONSENT_POLICY)
        self.assertIn('does not offer circulating credit yet', out)
        self.assertNotIn('Clearing:', out)


class Settings(Cli):
    def test_consent_settings_and_policy_show(self):
        self.join(sandbox=False)
        self.assertEqual(self.run_cli('config', 'consents.as_new_creditor', 'on')[0], 0)
        self.assertEqual(self.run_cli('config', 'consents.max_PC', '7')[0], 0)
        self.assertEqual(self.run_cli('config', 'consent_loop', 'on')[0], 0)
        self.assertEqual(self.disk()['consent_policy'], {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 7})
        self.assertEqual(self.disk()['consent_loop'], 'on')
        self.assertEqual(self.run_cli('config', 'consents.max_PC', 'none')[0], 0)
        self.assertNotIn('max_PC', self.disk()['consent_policy'])
        for key, value in (('consents.setoff', 'maybe'), ('consents.max_PC', '-1'), ('consent_loop', 'sometimes')):
            rc, _out = self.run_cli('config', key, value)
            self.assertEqual(rc, 1, key)
        rc, out = self.run_cli('policy', 'show')
        self.assertEqual(rc, 0)
        self.assertIn('Local consent policy', out)
        self.assertIn('set-offs (net-neutral): signed by your client (local on, owner auto_clear on)', out)
        self.assertIn('payments to you by transfer: signed by your client', out)
        self.world.mandate['accept_transfers'] = False
        rc, out = self.run_cli('policy', 'show')
        self.assertIn('payments to you by transfer: not signed (local on, owner accept_transfers off)', out)
        rc, out = self.run_cli('status')
        self.assertIn('consents:         setoff on, as_issuer on, as_new_creditor on, max_PC none; consent loop: on', out)

    def test_a_0_3_profile_gets_a_policy_with_every_other_role_off(self):
        path = os.path.join(self.home.name, 'profiles', 's.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': S_ID}, f)
        self.assertEqual(self.run_cli('config', 'consents.setoff', 'on')[0], 0)
        self.assertEqual(self.disk()['consent_policy'], {'setoff': True, 'as_issuer': False, 'as_new_creditor': False})

    def test_clearing_status_and_run(self):
        # A profile with the stranger's throwaway key (written here), so that the fake can hold edges S signed.
        from test_agent_circulation import NFT, DENOM, S, X
        self.world.keys[S_ID] = S
        self.world.welcome = False
        path = os.path.join(self.home.name, 'profiles', 's.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': S_ID, 'pubkey': S['pubkey'], 'secret': S['secret'].hex(),
                       'agent_token': 'vpa_test-only', 'approvals': 'none', 'consent_policy': dict(va.SANDBOX_CONSENT_POLICY),
                       'consent_loop': 'off', 'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}}, f)
        rc, out = self.run_cli('clearing', 'run')
        self.assertEqual((rc, out.strip()), (0, 'Nothing waits for your client.'))
        t1, t2 = now_ms() - 120_000 + 1, now_ms() - 110_000 + 2
        self.world.set_edge(X_ID, S_ID, 1, t1)
        self.world.set_edge(S_ID, X_ID, 2, t2, signature=sign_note(S, X['pubkey'], 2, t2))
        self.world.clear()
        rc, out = self.run_cli('clearing', 'status')
        self.assertEqual(rc, 0, out)
        self.assertIn('Your Valun client signs by itself: set-offs', out)
        self.assertIn('Consents waiting for your client: 1', out)
        rc, out = self.run_cli('clearing', 'run')
        self.assertEqual(rc, 0, out)
        self.assertRegex(out.strip(), r'^signed +setoff vs_[0-9a-f]{16} as member, 1 PC \(your net change 0 PC\)$')
        self.assertEqual((self.world.total(X_ID, S_ID), self.world.total(S_ID, X_ID)), (0, 1))
        rc, out = self.run_cli('clearing', 'status')
        self.assertIn('Recent decisions of your client:', out)
        self.assertIn('Cleared by set-off so far: 1 PC', out)


class Tour(Cli):
    def tour_lines(self, out):
        """{step: {edge: total}} from the tour's 'step N done' lines."""
        found = {}
        for line in out.splitlines():
            if line.startswith('step ') and ' done. Your edges on the tracker: ' in line:
                step = int(line.split()[1])
                found[step] = {k: int(v.split()[0]) for k, v in (x.split(': ') for x in line.split(': ', 1)[1].split('; '))}
        return found

    def test_the_tour_takes_a_fresh_sandbox_joiner_through_the_five_steps(self):
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.tour_lines(out), TOUR_TOTALS)
        self.assertIn('The tour is complete', out)
        w = self.world
        self.assertEqual((w.total(X_ID, M_ID), w.total(M_ID, X_ID)), (0, 1))     # the server-only cycle cleared too
        self.assertEqual([d['status'] for d in w.deals.values()],
                         ['note_issued', 'disputed', 'paid_by_transfer', 'note_issued', 'note_issued', 'paid_by_transfer'])
        setoffs = [j for j in w.journal if j['kind'] == 'setoff' and j['ref'] != 'vs_server']
        self.assertEqual(len({j['ref'] for j in setoffs}), 2)                     # the 2-cycle and the 3-cycle, signed by S
        self.assertIn('Valun - PAY sandbox-mallory 2 PC', out)                    # the commitments it signed are shown
        self.assertIn('Valun - PAY sandbox-exact 2 PC', out)
        disk = self.disk()
        self.assertEqual(sorted(disk['records']['paid_deals']), sorted(did for did, d in w.deals.items() if d['payer'] == S_ID
                                                                         and d['status'] in ('note_issued', 'paid_by_transfer')))
        self.assertEqual(sum(1 for e in disk['consent_log'] if e['decision'] == 'signed' and e['kind'] == 'setoff'), 2)
        # The tour is done: running it again changes nothing.
        posts = len(w.posts)
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual((rc, len(w.posts)), (0, posts))
        self.assertIn('The tour is complete', out)

    def test_the_tour_asks_at_the_terminal_and_stops_when_declined(self):
        self.join()
        rc, out = self.run_cli('sandbox', 'tour')                                 # no person at this terminal
        self.assertEqual(rc, 3)
        self.assertIn('--yes', out)
        rc, out = self.run_cli('sandbox', 'tour', tty=True, answers=['n'])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['error'], 'owner_declined')
        self.assertEqual(self.world.deals[self.world.order[0]]['status'], 'open')  # the welcome job was not accepted
        asked = []

        def yes(prompt):
            asked.append(prompt)
            return 'y'
        with mock.patch('builtins.input', side_effect=yes):
            rc, out = self.run_cli('sandbox', 'tour', tty=True)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.tour_lines(out), TOUR_TOTALS)
        # Asked for: the welcome acceptance; two purchases and the payment of step 2 (one wrong delivery disputed); the
        # purchase and payment of step 3; the sale of step 4; the purchase and payment of step 5.
        self.assertEqual(len(asked), 9)
        self.assertIn("Valun - ACCEPT sandbox-exact's offer", out)

    def test_the_tour_is_only_for_sandbox_participants_on_a_circulating_server(self):
        self.join(sandbox=False)
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual((rc, json.loads(out.strip().splitlines()[-1])['error']), (1, 'not_sandbox_only'))


class TourWithoutCirculation(Cli):
    features = None

    def test_feature_unavailable(self):
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual((rc, json.loads(out.strip().splitlines()[-1])['error']), (1, 'feature_unavailable'))


class EarnAndBuy(Cli):
    def test_earn_does_the_welcome_job(self):
        self.join()
        rc, out = self.run_cli('sandbox', 'earn')
        self.assertEqual(rc, 0, out)
        r = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((r['status'], r['paid'], r['amount']), ('note_issued', True, 3))
        self.assertEqual(self.world.total(X_ID, S_ID), 3)

    def test_earn_sells_text_stats_when_no_job_waits(self):
        self.world.welcome = False
        self.join()
        rc, out = self.run_cli('sandbox', 'earn')
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['status'], 'note_issued')
        d = next(iter(self.world.deals.values()))
        self.assertEqual((d['payer'], d['payee'], d['current']['terms']['service']['title']), (X_ID, S_ID, 'text-stats job'))
        self.assertEqual(self.world.total(X_ID, S_ID), 3)

    def test_buy_pays_with_a_note_held(self):
        self.world.welcome = False
        self.world.wrong_left = 0
        self.join()
        self.world.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        rc, out = self.run_cli('sandbox', 'buy', 'sandbox-mallory', 'notary', '--text', 'hello', '--pay-with', 'sandbox-exact')
        self.assertEqual(rc, 0, out)
        r = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((r['status'], r['verified'], r['paid_with']), ('paid_by_transfer', True, 'sandbox-exact'))
        self.assertEqual((self.world.total(X_ID, S_ID), self.world.total(X_ID, M_ID)), (1, 2))

    def test_the_seller_processes_consents_at_most_once_a_minute(self):
        self.join()
        self.world.welcome = False
        log = io.StringIO()
        seller = sb.Seller(vc.FileStore(os.path.join(self.home.name, 'profiles', 's.json')), server=SERVER, log=log)
        seller.step()
        seller.step()
        self.assertEqual(self.world.requests().count('GET /pilot/v1/consents'), 1)


if __name__ == '__main__':
    unittest.main()
