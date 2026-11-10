"""The CLI with circulating credit, against the fake v16 server and sandbox agents of test_agent_circulation.py (offline,
real signatures, throwaway keys, a temporary VALUN_HOME): join writes the local consent policy and sets the owner
mandate's auto_clear (only where the server offers circulation/1), the consents.* and consent_loop settings, `valun
policy show`, `valun clearing status|run`, and `valun sandbox tour` taking a fresh sandbox joiner through the five
steps of design 9.2 with the exact tracker totals after each step; also `valun sandbox earn` and `buy --pay-with`."""
import contextlib
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


class JoinWithoutCirculation(Cli):
    features = None

    def test_the_mandate_put_is_as_in_0_3_and_the_policy_waits_locally(self):
        out = self.join('--clearing', 'off')
        self.assertEqual(self.world.puts, [{'approve_above': 5}])            # no auto_clear: the field does not exist yet
        self.assertEqual(self.disk()['consent_policy'], va.SANDBOX_CONSENT_POLICY)
        self.assertIn('does not offer circulating credit yet', out)
        self.assertNotIn('Clearing:', out)


class JoinKeepsTheOwnerToken(Cli):
    """FX2-PY: `valun join` hands the owner token over (writes --owner-token-file, or shows it) right after enrolment,
    before the pin and mandate steps, so an error in those steps (a 429 here) never loses it; join then says what is
    not in force and how to finish, and exits 1."""
    RATE = ('rate_limited', 'too many requests; slow down', 429)

    def rate_limit(self, route):
        self.world.fail[route] = [vc.ValunError(*self.RATE)]

    def run_join(self, *extra, file=True):
        return self.run_cli('join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--server', SERVER, *extra,
                            *(['--owner-token-file', self.token_file] if file else []))

    def token_in_file(self):
        with open(self.token_file, encoding='utf-8') as f:
            return f.read()

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

    def test_a_429_on_the_mandate_put_without_a_file_shows_the_token_first(self):
        self.rate_limit('PUT /pilot/v1/owner/mandate')
        rc, out = self.run_join('--approvals', 'none', file=False)
        self.assertEqual(rc, 1, out)
        self.assertIn('\n  vpo_test-only\n', out)
        self.assertLess(out.index('vpo_test-only'), out.index('Your owner mandate could not be set (rate_limited)'))
        self.assertIn('approve_above in your owner mandate was not set', out)
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()))

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
        self.assertIn('`valun --profile s config approvals console --owner-token-file FILE`', out)
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
        self.assertIn('Owner mandate updated: every commitment now waits for you in the owner console', out)
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
        self.assertEqual(self.printed(out, 'Next:'), ['--profile', 's', 'doctor'])
        self.assertIn('then add `valun --profile s mcp` to your agent', out)
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
        self.assertIn('\n  vpo_test-only\n', out)
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
        self.assertEqual(self.world.requests()[-2:], ['POST /pilot/v1/enroll', 'GET /pilot/v1/info'])
        self.assertEqual(set(servers), {SERVER})
        self.assertEqual((self.disk()['participant_id'], self.disk()['server']), (S_ID, SERVER))

    def test_a_token_file_that_cannot_be_written_shows_the_token(self):
        # The token is shown instead; join does its other steps, then exits 1 (a script that relies on the file sees it).
        self.token_file = os.path.join(self.home.name, 'no-such-folder', 'owner.txt')
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertIn(f'Cannot write {self.token_file}', out)
        self.assertIn('\n  vpo_test-only\n', out)
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])        # the mandate step was done
        self.assertEqual((self.disk()['participant_id'], self.disk()['approvals']), (S_ID, 'none'))
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()))
        self.assertEqual(out.rstrip().splitlines()[-1],
                         f'Exit code 1: {self.token_file} was not written (your owner token is shown above instead).')
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
        # The token file exists when POST /enroll is sent (here it gets a 429): nothing local is written before it.
        seen, handle = [], self.world.handle

        def spy(method, path, body=None, token=None):
            seen.append((f'{method} {path}', os.path.exists(self.token_file)))
            return handle(method, path, body, token)
        self.world.handle = spy
        self.rate_limit('POST /pilot/v1/enroll')
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertEqual(seen, [('POST /pilot/v1/join-sandbox', False), ('POST /pilot/v1/enroll', True)])
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertLess(out.index('Your OWNER token is in'), out.index("this agent's key could not be registered (rate_limited)"))
        self.assertFalse(os.path.exists(os.path.join(self.home.name, 'profiles', 's.json')))

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
        self.assertFalse(os.path.exists(os.path.join(self.home.name, 'profiles', 's.json')))
        self.assertEqual(self.world.puts, [])

    def test_an_enrolment_whose_answer_was_not_read_may_have_registered_the_key(self):
        # POST /enroll times out while its answer is read (not a ValunError): whether the server holds the key is not
        # known, so join says how to finish either way.
        handle = self.world.handle

        def slow(method, path, body=None, token=None):
            out = handle(method, path, body, token)
            if path == '/pilot/v1/enroll':
                raise TimeoutError('The read operation timed out')
            return out
        self.world.handle = slow
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertIn(f"Your participant {S_ID} was created, and the server may hold this agent's key, but the key could "
                      'not be stored here (TimeoutError): The read operation timed out', out)
        self.assertIn('revoke this agent, which gives a new enrollment code (a new code is refused while a key is '
                      'registered); if the console shows no agent key, issue an enrollment code instead, then run '
                      f'`valun --profile s enroll --server {SERVER} --participant {S_ID}`.', out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertNotIn('Traceback', out)

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

    def test_a_429_after_the_join_answer_never_loses_the_token_shown_on_screen(self):
        # Without --owner-token-file: whichever request gets the 429, the token is shown before that step's report.
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
            self.assertIn('\n  vpo_test-only\n', out, route)
            self.assertLess(out.index('vpo_test-only'), out.index(said), route)
            path = os.path.join(self.home.name, 'profiles', f'{name}.json')
            if os.path.exists(path):
                with open(path, encoding='utf-8') as f:
                    self.assertNotIn('vpo_test-only', f.read(), route)

    def test_an_existing_token_file_is_never_replaced(self):
        # O_EXCL: a file that exists already (another identity's owner token, say) keeps its bytes. The token is shown
        # instead, join does its other steps, and exits 1 after handing it over.
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write('vpo_another-identity\n')
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.token_in_file(), 'vpo_another-identity\n')
        self.assertIn(f'{self.token_file} exists already, so it was not replaced (it may hold another owner token); '
                      'your owner token is shown here instead.', out)
        self.assertIn('\n  vpo_test-only\n', out)
        self.assertLess(out.index('vpo_test-only'), out.index('Joined Valun as stranger'))
        self.assertEqual(self.world.puts, [{'approve_above': 5, 'auto_clear': True}])    # the other steps were done
        self.assertEqual(self.disk()['participant_id'], S_ID)
        self.assertNotIn('vpo_test-only', json.dumps(self.disk()))
        self.assertEqual(out.rstrip().splitlines()[-1],
                         f'Exit code 1: {self.token_file} was not written (your owner token is shown above instead).')

    def test_a_new_token_file_is_created_and_holds_only_the_token(self):
        self.assertFalse(os.path.exists(self.token_file))
        rc, out = self.run_join('--approvals', 'none')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.token_in_file(), 'vpo_test-only\n')
        self.assertNotIn('vpo_test-only', out)                       # written, not shown
        if os.name != 'nt':
            self.assertEqual(os.stat(self.token_file).st_mode & 0o777, 0o600)

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
        self.assertIn('FIX   Not connected: run `valun --profile s join --sandbox` (no invite: sandbox only), '
                      '`valun --profile s join` (with an invite) or `valun --profile s enroll` (with an enrollment code).', out)
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
        self.assertIn('`valun --profile default join --sandbox`', out)
        self.assertNamesProfile(out, 'default')

    def test_the_mcp_not_joined_hint(self):
        err = io.StringIO()
        with mock.patch('valun.mcp_server.run', return_value=0) as run, contextlib.redirect_stderr(err):
            rc, _out = self.run_cli('mcp')
        self.assertEqual((rc, run.call_count), (0, 1))
        self.assertIn("valun mcp: profile 's' is not joined yet; run `valun --profile s join` first.", err.getvalue())
        self.assertNamesProfile(err.getvalue())
        # and what its tools tell the agent while the profile is not joined names the profile too
        self.assertEqual(run.call_args.kwargs.get('setup_hint'), 'run `valun --profile s join` in a terminal')

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
        self.assertIn('run `valun --profile s join` in a terminal', out)
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
        self.assertIn(f'`valun --profile s attempts resolve {self.deal} #1 --not-applied`', out)
        self.assertIn('ask the operator to look into it with the payee', out)
        self.assertNotIn("client's records only?", out)
        self.assertNotIn('\x1b', out)
        disk = self.disk()                                            # nothing resolved, nothing recorded as paid
        self.assertEqual((self.world.resolutions, disk['transfer_attempts']), ([], before))
        self.assertNotIn('paid_deals', disk.get('records') or {})

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


if __name__ == '__main__':
    unittest.main()
