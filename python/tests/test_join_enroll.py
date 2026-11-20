"""The join and enroll path when answers are lost on the way (the tester report, 2026-11-17, valun 0.7.1).

(1) An enrollment whose answer was lost after the server registered the key lost the key: 0.7.1 generated it in memory
    and saved it only with the agent token from that answer, leaving a participant whose registered key nobody held.
    Now the key and the code are saved in the profile before the request is sent, the same request is sent again while
    no answer is read, and `valun join` (again) or `valun enroll` sends it once more later. A server that registered
    the key answers a new token for it (enrolled_again: the key is adopted); one that does not is enroll_token_lost.
(2) `valun enroll` in a new profile signed for the retired pilot's network, and the testnet answered 403 with nothing
    that said why. Now it signs for the network the server names (or the one network when /info cannot be read), a
    profile of another network is refused before anything is sent, and each 403 says which refusal it is.
(3) `valun enroll` wrote none of the settings a join writes, so a sandbox participant enrolled that way signed no
    set-off (the tour stalled at step 3). Now it writes the same consent policy and consent loop for its kind.
Offline: a fake testnet server with the real server's enrollment rules (valun-app lib/pilot/core.mjs enroll) answers
every vc.Client request; transport failures are the exceptions urllib raises."""
import contextlib
import copy
import hashlib
import http.client
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402

SERVER = 'https://valun.example'
PID, OTHER = 'vp_f0ec014633b2', 'vp_0e0e0e0e0e0e'
CODE = 'vpe_test-only-code'
INVITE = 'vpi_test-only-invite'
LOST = http.client.RemoteDisconnected('Remote end closed connection without response')
sha = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()  # noqa: E731


class FakeTestnet:
    """A testnet server's join, enroll and read routes, with the enrollment rules of valun-app's Pilot.enroll: the
    code (invalid_enrollment, 403) is checked first, then the key (key_in_use, 409: a key is registered once, ever),
    then the proof of possession, which signs the server's network (bad_signature, 403); a registration consumes the
    code. reenroll: the proposed server change (valun-app fix/enroll-retry): the same key and code, while the agent
    has not been seen, answer a new agent token (enrolled_again). lose: {'METHOD /path': ['after' | 'before', ...]}:
    the answer to the next such request is lost after (or before) the server did it, as urllib raises it."""

    def __init__(self, network='valun-testnet-1', reenroll=False):
        self.network, self.reenroll = network, reenroll
        self.participants, self.calls, self.lose, self.tokens = {}, [], {}, 0
        self.fail = {}
        # The hold contract (valun-app): a handle taken by a join that did not finish (no key ever registered) answers
        # 409 handle_taken with held_until and retry_after_ms; None: a handle taken is answered without them.
        self.hold = None
        self.lost_with = LOST           # what a lost answer raises (the client's own transport error, when set so)
        self.invite_used = False        # POST /join's one invite (INVITE), used once; an invited join is never held

    def add(self, pid=PID, handle='new-user', sandbox=True, code=CODE):
        self.participants[pid] = {'id': pid, 'handle': handle, 'sandbox_only': sandbox, 'pubkey': None, 'past': [],
                                  'code': sha(code) if code else None, 'used_code': None, 'token': None, 'seen': False}
        return self.participants[pid]

    def request(self, client, method, path, body=None, auth=True, token=None):
        key = f'{method} {path}'
        self.calls.append(key)
        body = json.loads(json.dumps(body)) if body is not None else None
        when = (self.lose.get(key) or [None]).pop(0) if self.lose.get(key) else None
        if when == 'before':
            raise self.lost_with
        if self.fail.get(key):
            raise self.fail[key].pop(0)
        out = self.answer(method, path, body, token if token else (client.store.token() if auth else None))
        if when == 'after':
            raise self.lost_with
        if isinstance(out, Exception):
            raise out
        return json.loads(json.dumps(out))

    def public(self, p):
        return {'id': p['id'], 'handle': p['handle'], 'status': 'active', 'pubkey': p['pubkey'],
                **({'sandbox_only': True} if p['sandbox_only'] else {})}

    def answer(self, method, path, body, token):
        if (method, path) == ('GET', '/pilot/v1/info'):
            return {'network': self.network, 'protocol': vc.PROTOCOL, 'unit': 'nanoERG', 'tracker_nft_id': 'dd' * 32,
                    'denomination': 'erg', 'features': ['circulation/1']}
        if (method, path) == ('POST', '/pilot/v1/join-sandbox'):
            held = [p for p in self.participants.values() if p['handle'] == body['handle']]
            if held and self.hold and held[0]['pubkey'] is None and not held[0]['past']:
                until, ms = self.hold
                return vc.ValunError('handle_taken', f"that handle is held by a join that did not finish, until {until}: join "
                                     'again then, or choose another handle', 409, {'retry_after_ms': ms, 'held_until': until})
            if held:
                return vc.ValunError('handle_taken', 'that handle is taken', 409)
            p = self.add(OTHER if PID in self.participants else PID, body['handle'])
            return {'participant_id': p['id'], 'handle': p['handle'], 'network': self.network,
                    'owner_token': 'vpo_test-only', 'enrollment_code': CODE, 'sandbox_only': True,
                    'enrollment_expires_at': '2026-11-17T03:07:09.000Z', 'note': 'Open network: ...'}
        if (method, path) == ('POST', '/pilot/v1/join'):        # the invite is checked first, as valun-app's join
            if body.get('invite') != INVITE or self.invite_used:
                return vc.ValunError('invalid_invite', 'invite code is invalid, used up or expired', 403)
            if any(p['handle'] == body['handle'] for p in self.participants.values()):
                return vc.ValunError('handle_taken', "that handle is taken (as another participant's handle or display name)", 409)
            self.invite_used = True
            p = self.add(OTHER if PID in self.participants else PID, body['handle'], sandbox=False)
            return {'participant_id': p['id'], 'handle': p['handle'], 'network': self.network, 'owner_token': 'vpo_test-only',
                    'enrollment_code': CODE, 'enrollment_expires_at': '2026-11-17T03:07:09.000Z'}
        if (method, path) == ('POST', '/pilot/v1/enroll'):
            return self.enroll(body)
        if method == 'GET' and path.startswith('/pilot/v1/participants/'):
            p = self.participants.get(path.rsplit('/', 1)[1])
            return self.public(p) if p else vc.ValunError('not_found', 'unknown participant', 404)
        p = next((x for x in self.participants.values() if token and x['token'] == token), None)
        if (method, path) == ('GET', '/pilot/v1/me') and p:
            p['seen'] = True
            return {'participant': self.public(p), 'mandate': {'max_issue_per_deal': 5_000_000}}
        owner = token == 'vpo_test-only'
        if (method, path) == ('GET', '/pilot/v1/owner') and owner:
            return {'mandate': {'max_issue_per_deal': 5_000_000, 'max_accept_per_deal': 5_000_000,
                                'max_issue_outstanding': 40_000_000}}
        if (method, path) == ('PUT', '/pilot/v1/owner/mandate') and owner:
            return {'mandate': {}}
        return vc.ValunError('unauthorized', 'missing or invalid token', 401)

    def enroll(self, b):
        p = self.participants.get(b.get('participant_id'))
        code = sha(b.get('code') or '')
        if p and self.reenroll and p['code'] is None and p['used_code'] == code and p['pubkey'] == b.get('pubkey') \
                and not p['seen'] and self.verifies(p, b):
            self.tokens += 1
            p['token'] = f'vpa_test-only-{self.tokens}'
            return {'participant_id': p['id'], 'agent_token': p['token'], 'network': self.network, 'enrolled_again': True}
        if not p or p['code'] is None or p['code'] != code:
            return vc.ValunError('invalid_enrollment', 'enrollment code is invalid or expired; the owner can issue a new one', 403)
        if any(q['pubkey'] == b['pubkey'] or b['pubkey'] in q['past'] for q in self.participants.values()):
            return vc.ValunError('key_in_use', 'this key is registered, or was registered before', 409)
        if not self.verifies(p, b):
            return vc.ValunError('bad_signature', 'proof-of-possession signature does not verify', 403)
        self.tokens += 1
        p.update(pubkey=b['pubkey'], used_code=p['code'], code=None, token=f'vpa_test-only-{self.tokens}', seen=False)
        return {'participant_id': p['id'], 'agent_token': p['token'], 'network': self.network}

    def verifies(self, p, b):
        msg = vc.statement('enroll', self.network, p['id'], b['pubkey'], sha(b['code'])).encode('utf-8')
        try:
            return vb.verify(bytes.fromhex(b['signature']), msg, bytes.fromhex(b['pubkey']))
        except Exception:  # noqa: BLE001
            return False

    def revoke(self, pid=PID, code='vpe_test-only-new'):
        p = self.participants[pid]
        p.update(past=p['past'] + [p['pubkey']], pubkey=None, token=None, code=sha(code), used_code=None, seen=False)
        return code


class Base(unittest.TestCase):
    reenroll = False

    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.home = home.name
        env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home, 'HOME': self.home, 'USERPROFILE': self.home})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        self.net = FakeTestnet(reenroll=self.reenroll)
        net = self.net
        for p in (mock.patch.object(vc.Client, 'request', lambda c, *a, **kw: net.request(c, *a, **kw)),
                  mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0))):
            p.start()
            self.addCleanup(p.stop)
        self.token_file = os.path.join(self.home, 'owner.txt')

    def path(self, name='m'):
        return os.path.join(self.home, 'profiles', f'{name}.json')

    def disk(self, name='m'):
        with open(self.path(name), encoding='utf-8') as f:
            return json.load(f)

    def write(self, state, name='m'):
        os.makedirs(os.path.dirname(self.path(name)), exist_ok=True)
        with open(self.path(name), 'w', encoding='utf-8') as f:
            json.dump(state, f)

    def cli(self, *argv, stdin='', profile='m', answers=None):
        """cli.main, with `stdin` as its input; with answers, at a terminal (stdin and stdout) whose input() answers
        them."""
        out = EndedInput() if answers is not None else io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(out))
            stack.enter_context(mock.patch.object(sys, 'stdin', EndedInput(stdin) if answers is not None else io.StringIO(stdin)))
            if answers is not None:
                stack.enter_context(mock.patch('builtins.input', side_effect=answers))
            rc = cli.main(['--profile', profile, *argv])
        self.assertNotIn('Traceback', out.getvalue())
        return rc, out.getvalue()

    def join(self, *extra, handle='new-user'):
        return self.cli('join', '--sandbox', '--handle', handle, '--operator', 'Fitz', '--approvals', 'none',
                        '--server', SERVER, '--owner-token-file', self.token_file, *extra)

    def enroll(self, *extra, code=CODE, pid=PID, profile='m'):
        args = ['enroll', '--server', SERVER, *(['--participant', pid] if pid else []), *extra]
        if code is not None:
            args.append('--code-from-stdin')
        return self.cli(*args, stdin=(code or '') + '\n', profile=profile)

    def registered(self, pid=PID):
        return self.net.participants[pid]['pubkey']


class LostEnrollAnswer(Base):
    """(1) The answer to an enrollment is lost after the server registered the key."""

    def test_0_7_1_lost_the_key_this_reproduces_it_with_its_core(self):
        # The report's state, with 0.7.1's enroll (the key in memory only): the server holds a key no one has.
        self.net.add()
        self.net.lose['POST /pilot/v1/enroll'] = ['after']
        secret = vb.generate_secret()
        pk = vb.public_key(secret).hex()
        sig = vb.sign(vc.statement('enroll', 'valun-testnet-1', PID, pk, sha(CODE)).encode('utf-8'), secret,
                      bytes.fromhex(pk)).hex()
        c = vc.Client(vc.FileStore(self.path()), SERVER)
        with self.assertRaises(http.client.RemoteDisconnected):
            c.request('POST', '/pilot/v1/enroll', {'participant_id': PID, 'code': CODE, 'pubkey': pk, 'signature': sig},
                      auth=False)
        self.assertEqual(self.registered(), pk)
        self.assertIsNone(self.net.participants[PID]['code'], 'the code is used up')
        self.assertFalse(os.path.exists(self.path()), 'nothing of the key is anywhere else')

    def test_the_key_is_in_the_profile_before_the_request_is_sent(self):
        self.net.add()
        seen = []
        real = self.net.enroll

        def enroll(b):
            seen.append(self.disk()[vc.PENDING_ENROLLMENT_KEY])
            return real(b)
        self.net.enroll = enroll
        self.write({'network': 'valun-testnet-1'})
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        kept = seen[0]
        self.assertEqual((kept['participant_id'], kept['network'], kept['server'], kept['code']),
                         (PID, 'valun-testnet-1', SERVER, CODE))
        self.assertEqual(kept['pubkey'], self.registered())
        self.assertEqual(vb.public_key(bytes.fromhex(kept['secret'])).hex(), kept['pubkey'])
        disk = self.disk()
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, disk, 'removed once the key and token are stored')
        self.assertEqual((disk['participant_id'], disk['pubkey'], disk['secret']), (PID, kept['pubkey'], kept['secret']))

    def test_an_answer_lost_before_the_server_did_it_is_sent_again_and_registers_the_key(self):
        self.net.lose['POST /pilot/v1/enroll'] = ['before', 'before']
        rc, out = self.join()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.net.calls.count('POST /pilot/v1/enroll'), 3)
        self.assertEqual(self.disk()['pubkey'], self.registered())
        self.assertIn('Joined Valun as new-user', out)

    def test_the_report_an_answer_lost_after_the_server_registered_the_key(self):
        # The server of today answers no token again: the key it registered cannot sign in. join says exactly that, and
        # how to finish (revoke, then enroll with the new code), instead of "the key could not be stored here".
        self.net.lose['POST /pilot/v1/enroll'] = ['after']
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.net.calls.count('POST /pilot/v1/enroll'), 2)
        self.assertIn(f"Your participant {PID} was created, and the server registered this agent's key, but its answer, "
                      "the only copy of the agent's token, was lost on the way", out)
        self.assertIn(f'To finish: in the owner console ({SERVER}/pilot#owner), with your owner token, revoke this agent, '
                      f'which gives a new enrollment code, then run `valun --profile m enroll --server {SERVER} '
                      f'--participant {PID}`.', out)
        self.assertNotIn('could not be stored here', out)
        disk = self.disk()
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, disk, 'a key that cannot sign in is not kept')
        self.assertNotIn('participant_id', disk)
        # The way out it names: revoke (a new code), then enroll in the same profile: a new key, on the testnet.
        code = self.net.revoke()
        rc, out = self.enroll(code=code)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Enrolled {PID} on valun-testnet-1.', out)
        self.assertEqual(self.disk()['pubkey'], self.registered())
        self.assertEqual(self.disk()['consent_policy'], cli._scaled_policy(va.SANDBOX_CONSENT_POLICY, vc.FileStore(self.path())))

    def test_every_answer_lost_keeps_the_key_and_join_again_finishes_it_without_a_new_participant(self):
        self.net.lose['POST /pilot/v1/enroll'] = ['before'] * 3
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn(f"Your participant {PID} was created, and this agent's key is saved in this profile, but no answer "
                      'to its enrollment arrived (3 tries; the last: RemoteDisconnected: Remote end closed connection '
                      'without response).', out)
        self.assertIn('(until 2026-11-17T03:07:09.000Z)', out)
        pending = self.disk()[vc.PENDING_ENROLLMENT_KEY]
        self.assertEqual(pending['context']['handle'], 'new-user')
        rc, out = self.cli('doctor', '--server', SERVER)
        self.assertIn(f"this profile's enrollment of {PID}", out)
        self.assertIn('Run `valun --profile m enroll` to send it again (no code to give)', out)
        # Joining again, with the same command: the same enrollment, no new participant (no POST /join-sandbox).
        before = self.net.calls.count('POST /pilot/v1/join-sandbox')
        rc, out = self.join()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.net.calls.count('POST /pilot/v1/join-sandbox'), before)
        self.assertIn('Finishing the join of new-user', out)
        disk = self.disk()
        self.assertEqual((disk['participant_id'], disk['pubkey']), (PID, pending['pubkey']))
        self.assertEqual(self.registered(), pending['pubkey'])
        self.assertEqual((disk['approvals'], disk['consent_loop'], disk['check_link_hosts']), ('none', 'on', True))
        self.assertEqual(disk['consent_policy']['setoff'], True)
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, disk)

    def test_join_again_with_another_handle_is_refused_and_the_key_stays_kept(self):
        self.net.lose['POST /pilot/v1/enroll'] = ['before'] * 3
        self.join()
        kept = self.disk()[vc.PENDING_ENROLLMENT_KEY]
        rc, out = self.join(handle='someone-else')
        self.assertEqual(rc, 1, out)
        self.assertIn("holds a join that did not finish: participant vp_f0ec014633b2 (new-user)", out)
        self.assertEqual(self.disk()[vc.PENDING_ENROLLMENT_KEY], kept)
        self.assertEqual(self.net.calls.count('POST /pilot/v1/join-sandbox'), 1)

    def test_a_store_that_keeps_no_pending_key_still_sends_the_same_request_again(self):
        class Mem:
            def __init__(self):
                self.state, self.creds = {'network': 'valun-testnet-1'}, None

            def secret(self):
                return self.creds and self.creds[0]

            def token(self):
                return self.creds and self.creds[1]

            def save(self):
                pass

            def save_credentials(self, s, t):
                self.creds = (s, t)
        self.net.add()
        self.net.lose['POST /pilot/v1/enroll'] = ['before']
        store = Mem()
        r = vc.Client(store, SERVER).enroll(PID, CODE)
        self.assertEqual((r['tries'], r['pubkey']), (2, self.registered()))
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, store.state)
        self.net.add(OTHER, 'other')
        self.net.lose['POST /pilot/v1/enroll'] = ['before'] * 3
        with self.assertRaises(vc.ValunError) as e:
            vc.Client(Mem(), SERVER).enroll(OTHER, CODE)
        self.assertEqual((e.exception.code, e.exception.extra['kept_key']), ('enroll_unconfirmed', False))

    def test_a_join_whose_own_answer_is_lost_says_so_without_a_traceback(self):
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining stopped (RemoteDisconnected): the join was sent, and no answer to it arrived', out)
        self.assertIn('If it answers that new-user is held until a time, run it again then', out)
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining failed (handle_taken)', out)


class LostEnrollAnswerAdopted(Base):
    """(1) with the proposed server change: the same key and code answer a new token, so the key is adopted."""
    reenroll = True

    def test_join_adopts_the_key_the_server_registered(self):
        self.net.lose['POST /pilot/v1/enroll'] = ['after']
        rc, out = self.join()
        self.assertEqual(rc, 0, out)
        self.assertIn('Joined Valun as new-user', out)
        disk = self.disk()
        self.assertEqual(disk['pubkey'], self.registered())
        self.assertEqual(disk['agent_token'], self.net.participants[PID]['token'])
        self.assertEqual(self.net.tokens, 2, 'the lost token was replaced')

    def test_enroll_later_adopts_the_key_too(self):
        self.net.lose['POST /pilot/v1/enroll'] = ['after', 'before', 'before']
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        rc, out = self.cli('enroll')
        self.assertEqual(rc, 0, out)
        self.assertIn("answered the agent's token again", out)
        self.assertEqual(self.disk()['pubkey'], self.registered())


class EnrollNetwork(Base):
    """(2) The network an enrollment signs for, and what each 403 says."""

    def test_the_report_a_new_profile_signed_for_the_retired_pilot(self):
        # 0.7.1's core, as `valun enroll` used it in a new profile: the proof names valun-pilot-1, and the testnet
        # answers 403 bad_signature, which nothing explained.
        self.net.add()
        store = vc.FileStore(self.path('fresh'))
        self.assertEqual(vc.Client(store, SERVER).network, 'valun-pilot-1')
        with self.assertRaises(vc.ValunError) as e:
            vc.Client(store, SERVER).enroll(PID, CODE)
        self.assertEqual((e.exception.code, e.exception.status, e.exception.extra['signed_for']),
                         ('bad_signature', 403, 'valun-pilot-1'))
        self.assertIsNotNone(self.net.participants[PID]['code'], 'a refused proof uses no code')

    def test_a_new_profile_enrolls_on_the_network_the_server_names(self):
        self.net.add()
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Enrolled {PID} on valun-testnet-1.', out)
        self.assertEqual(self.disk()['network'], 'valun-testnet-1')

    def test_when_info_cannot_be_read_the_one_network_not_the_pilot(self):
        self.net.add()
        self.net.lose['GET /pilot/v1/info'] = ['before']
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertIn("network could not be read (GET /pilot/v1/info), so this enrollment is signed for valun-testnet-1", out)
        self.assertEqual(self.net.calls.count('GET /pilot/v1/info'), 1 + 1)     # one read, then the pin after enrolling

    def test_info_is_read_once_its_transport_sends_a_read_again_itself(self):
        # The 0.7.2 review: enroll's own three tries around Client.request, which sends a read whose answer was cut
        # again itself, made up to nine requests to a server that did not answer. A lost answer here is what
        # Client.request raised after its own tries (test_transport: Timeouts), so it is not read again.
        self.net.add()
        self.net.lose['GET /pilot/v1/info'] = ['before']
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.net.calls[:2], ['GET /pilot/v1/info', 'POST /pilot/v1/enroll'])

    def test_a_profile_of_another_network_is_refused_before_anything_is_sent(self):
        self.net.add()
        self.write({'network': 'valun-pilot-1', 'server': SERVER})
        rc, out = self.enroll()
        self.assertEqual(rc, 1, out)
        self.assertIn(f'Enrollment not sent: this profile is on valun-pilot-1, and {SERVER} serves valun-testnet-1', out)
        self.assertIn(f'`valun --profile NAME enroll --server {SERVER} --participant {PID}`', out)
        self.assertNotIn('POST /pilot/v1/enroll', self.net.calls)

    def test_bad_signature_says_what_was_signed_and_what_the_server_serves(self):
        self.net.add()
        self.net.lose['GET /pilot/v1/info'] = ['before']
        self.net.network = 'valun-pilot-1'          # the proof names valun-testnet-1 (the fallback); the server another
        rc, out = self.enroll()
        self.assertEqual(rc, 1, out)
        self.assertIn('Enrollment failed (bad_signature): the server did not accept the proof that this agent holds its key.', out)
        self.assertIn(f"this profile signed for valun-testnet-1, and {SERVER}'s network could not be read", out)
        self.assertIn('Nothing was registered, and the code is still valid.', out)
        self.assertIn(f'once {SERVER}/pilot/v1/info answers', out)
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, self.disk(), 'no key was registered: none is kept')
        self.net.network = 'valun-testnet-1'
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)

    def test_a_403_whose_explanation_was_lost_names_both_causes(self):
        self.net.add()
        self.net.fail['POST /pilot/v1/enroll'] = [vc.ValunError('http_error', 'HTTP 403', 403)]
        rc, out = self.enroll()
        self.assertEqual(rc, 1, out)
        self.assertIn('Enrollment failed (HTTP 403): the server refused the enrollment, but its explanation did not arrive.', out)
        self.assertIn('the enrollment code is wrong, used or expired (invalid_enrollment), or the proof names another '
                      f'network than the server\'s (bad_signature: this profile signed for valun-testnet-1, and {SERVER} '
                      'serves valun-testnet-1)', out)

    def test_invalid_enrollment_says_how_to_get_a_code(self):
        self.net.add()
        rc, out = self.enroll(code='vpe_wrong')
        self.assertEqual(rc, 1, out)
        self.assertIn('Enrollment failed (invalid_enrollment): the server registered no key, because it does not take this '
                      'enrollment code: it is wrong, used already, or expired', out)
        self.assertIn('issue a new enrollment code (when the console shows an agent key, revoke that agent instead', out)

    def test_an_answer_to_info_lost_after_enrolling_is_no_traceback(self):
        self.net.add()
        self.net.lose['GET /pilot/v1/info'] = [None, 'after']          # the read before enrolling arrives; the pin's not
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Enrolled {PID} on valun-testnet-1.', out)


class EnrollSettings(Base):
    """(3) An enrolled profile gets the settings a join writes for its kind of participant."""

    def test_a_sandbox_participant_gets_the_sandbox_policy_and_the_consent_loop(self):
        self.net.add(sandbox=True)
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        disk = self.disk()
        store = vc.FileStore(self.path())
        self.assertEqual(disk['consent_policy'], cli._scaled_policy(va.SANDBOX_CONSENT_POLICY, store))
        self.assertEqual((disk['consent_loop'], disk['check_link_hosts'], disk['approvals']), ('on', True, 'ask'))
        self.assertIn('Settings, as a sandbox join writes them', out)
        # ... so its client declares the consent roles it signs, and the server counts it in set-offs (0.7.1: none).
        c = vc.Client(store, SERVER)
        c.info()
        self.assertEqual(c.features_header(), 'consents/1;roles=setoff,issuer,creditor')
        # the same settings as `valun join --sandbox` writes (in a profile of its own)
        rc, out = self.cli('join', '--sandbox', '--approvals', 'console', '--handle', 'joined-one', '--operator', 'Fitz', '--server', SERVER,
                           '--owner-token-file', os.path.join(self.home, 'owner-j.txt'), profile='j')
        self.assertEqual(rc, 0, out)
        joined = self.disk('j')
        for k in ('consent_policy', 'consent_loop', 'check_link_hosts'):
            self.assertEqual(disk[k], joined[k], k)
        # Approvals: a sandbox join holds commitments in the owner console by default (Fitz's decision of 2026-11-17),
        # which takes the owner token it just got; an enrollment has none, so it asks (`config approvals console` then).
        self.assertEqual((joined['approvals'], disk['approvals']), ('console', 'ask'))

    def test_the_closing_lines_tell_a_shell_agent_what_signs_its_consents(self):
        # The first-tester readiness assessment of 2026-11-18 (blocker 7): an agent that runs Valun from a shell never
        # runs `valun mcp`, whose consent loop signs the set-offs and payments to it. An enrollment, and a join that
        # finishes one (its enrollment answer lost), end with what a shell agent runs instead, as join does.
        # The Nov 18 fresh-join run (finding 3): one Next block, with two equal branches, the MCP app's and the shell's.
        shell = ('Next: run `valun --profile {p} doctor`, then, for your agent, one of:\n'
                 '  - In an MCP app: add `valun --profile {p} mcp` to it (see `valun mcp --help`).\n'
                 '  - From a shell: run `valun --profile {p} call valun_inbox` regularly, which shows what waits for your '
                 'agent, and signs the set-offs and payments to you by transfer that your policy allows; or keep '
                 f'`valun --profile {{p}} clearing watch` running, which signs all your policy allows{cli._uvx_too()}.\n')
        self.net.add(sandbox=True)
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertIn(shell.format(p='m'), out)
        self.assertIn('and signs them in the background while `valun --profile m mcp` (consent_loop on) or `valun '
                      '--profile m clearing watch` runs.', out)
        self.net.lose['POST /pilot/v1/enroll'] = ['before'] * vc.ENROLL_TRIES
        rc, out = self.cli('join', '--sandbox', '--approvals', 'console', '--handle', 'joined-two', '--operator', 'Fitz', '--server', SERVER,
                           '--owner-token-file', os.path.join(self.home, 'owner-k.txt'), profile='k')
        self.assertEqual(rc, 1, out)
        self.assertNotIn('From a shell', out, 'not joined yet')
        rc, out = self.cli('join', profile='k')          # finishes it: the same enrollment again
        self.assertEqual(rc, 0, out)
        self.assertIn(shell.format(p='k'), out)

    def test_an_invited_participant_gets_the_invite_policy(self):
        self.net.add(sandbox=False)
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        disk = self.disk()
        self.assertEqual(disk['consent_policy'], cli._scaled_policy(va.INVITE_CONSENT_POLICY, vc.FileStore(self.path())))
        self.assertEqual(disk['consent_loop'], 'off')
        self.assertIn('payments to you by transfer are off until you turn them on', out)

    def test_a_policy_the_profile_has_is_kept(self):
        self.net.add(sandbox=True)
        mine = {'setoff': False, 'as_issuer': False, 'as_new_creditor': False, 'max_PC': 1}
        self.write({'consent_policy': mine, 'consent_loop': 'off', 'approvals': 'console'})
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        disk = self.disk()
        self.assertEqual((disk['consent_policy'], disk['consent_loop'], disk['approvals']), (mine, 'off', 'console'))
        self.assertIn('Settings: the consent policy this profile had is kept.', out)

    def test_when_the_kind_cannot_be_read_no_policy_is_written_and_it_says_so(self):
        self.net.add(sandbox=True)
        self.net.lose['GET /pilot/v1/me'] = ['before']
        self.net.lose[f'GET /pilot/v1/participants/{PID}'] = ['before']
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)
        self.assertNotIn('consent_policy', self.disk())
        self.assertIn('whether this participant is a sandbox one could not be read, so no consent policy was written', out)


class LostJoinAnswer(Base):
    """A lost answer to POST /join-sandbox itself (the newcomer tests, 2026-11-17: 0.7.1 printed a traceback, wrote no
    owner token, and a second join got handle_taken for good). The join stops with no traceback, keeps this agent's key
    (made before the join was sent) and what was lost, says what the server may hold now, and gives the exact next
    command. A second join is answered by the hold contract: 409 handle_taken with held_until and retry_after_ms while
    the unfinished join holds the handle; once it is released, the same join enrolls the key that was kept."""
    UNTIL = '2026-11-18T01:00:00.000Z'
    CMD = (f'`valun --profile m join --sandbox --handle new-user --operator Fitz --approvals none --owner-token-file '
           '{file} --server https://valun.example`')

    def cmd(self, handle='new-user'):
        return self.CMD.replace('{file}', cli._shell_word(self.token_file, 300)).replace('new-user', handle)

    def test_a_cut_answer_keeps_the_key_and_says_what_the_server_may_hold_and_what_to_run(self):
        self.lose_the_join()

    def lose_the_join(self):
        """A join whose answer is lost, and what it says and keeps; returns the kept key's record."""
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining stopped (RemoteDisconnected): the join was sent, and no answer to it arrived '
                      '(RemoteDisconnected: Remote end closed connection without response).', out)
        self.assertIn('The server may now hold a participant new-user made by this join. Its owner token and enrollment code '
                      'were only in that answer, so nobody can finish it', out)
        # the 0.7.2 review (p1b): today's servers never release it, so nothing promises that they do
        self.assertIn('nobody can finish it. A server that releases unfinished joins (no agent key was ever enrolled) frees '
                      'new-user after a while, and until then a join as new-user answers handle_taken with the time it is '
                      'held until; a server that does not keeps new-user taken.', out)
        self.assertNotIn('the handle is free again', out)
        self.assertIn("This agent's key, made here before the join was sent (nothing of it left this machine), is kept in "
                      'this profile for the next join.', out)
        self.assertIn(f'Next: run the same join again: {self.cmd()}. If it answers that new-user is held until a time, run it '
                      'again then; if it answers that new-user is taken, join with another handle: '
                      f"{self.cmd('NEW-HANDLE')} (replace NEW-HANDLE with a handle of your own: public and permanent).", out)
        disk = self.disk()
        kept = disk[cli.JOIN_KEY]
        self.assertEqual(vb.public_key(bytes.fromhex(kept['secret'])).hex(), kept['pubkey'])
        lost = disk[cli.LOST_JOIN]
        self.assertEqual({k: lost.get(k) for k in ('handle', 'server', 'sandbox', 'operator', 'approvals', 'owner_token_file')},
                         {'handle': 'new-user', 'server': SERVER, 'sandbox': True, 'operator': 'Fitz', 'approvals': 'none',
                          'owner_token_file': os.path.abspath(self.token_file)})
        self.assertNotIn('participant_id', disk)
        self.assertFalse(os.path.exists(self.token_file), 'no owner token arrived, so none was written')
        self.assertNotIn(kept['secret'], out)
        # doctor names the join that got no answer, and runs the same join again: its operator, flags and owner token
        # file, never a placeholder for a value the join was given (the 0.7.2 review, p2b)
        rc, out = self.cli('doctor', '--server', SERVER)
        self.assertIn("FIX   Not connected yet: this profile's join of new-user on https://valun.example (sent ", out)
        self.assertIn('got no answer, so the server may hold a participant new-user made by it, whose owner token was only '
                      'in the answer that was lost.', out)
        self.assertIn("This agent's key is kept here.", out)
        self.assertIn(f'Run the join again: {self.cmd()}: if new-user is held, it says until when; if it is taken, join with '
                      'another handle (public and permanent)', out)
        self.assertNotIn('YOUR NAME', out)
        self.assertNotIn(' FILE', out)
        return kept

    def test_the_hold_contract_says_until_when_and_a_released_handle_enrolls_the_kept_key(self):
        kept = self.lose_the_join()
        self.net.hold = (self.UNTIL, 1_799_000)
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn(f'Joining failed (handle_taken): that handle is held by a join that did not finish, until {self.UNTIL}', out)
        self.assertIn(f'new-user is held for a join that did not finish (its agent never enrolled), until {self.UNTIL} (in about '
                      "30 minutes): this profile's join of new-user at ", out)
        self.assertIn('got no answer, so it is probably that one.', out)
        self.assertIn(f"Next: run the same join again then: {self.cmd()}; or join now with another handle: "
                      f"{self.cmd('NEW-HANDLE')} (replace NEW-HANDLE with a handle of your own: public and permanent).", out)
        self.assertEqual(self.disk()[cli.JOIN_KEY], kept, 'the same key, still kept')
        # the hold is released (the server let the unfinished join go): the same join goes through, with the kept key
        del self.net.participants[PID]
        rc, out = self.join()
        self.assertEqual(rc, 0, out)
        disk = self.disk()
        self.assertEqual(disk['pubkey'], kept['pubkey'])
        self.assertEqual(self.net.participants[PID]['pubkey'], kept['pubkey'], 'the server registered the key kept here')
        self.assertNotIn(cli.JOIN_KEY, disk)
        self.assertNotIn(cli.LOST_JOIN, disk)
        self.assertNotIn(vc.PENDING_ENROLLMENT_KEY, disk)

    def test_without_the_hold_a_taken_handle_after_a_lost_join_says_it_cannot_be_finished(self):
        self.lose_the_join()
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining failed (handle_taken): that handle is taken', out)
        self.assertIn("This profile's join of new-user at ", out)
        self.assertIn('the server probably made that participant, and its owner token was only in the answer that was lost, '
                      'so it cannot be finished here. This server names no time it is held until, so it may keep new-user '
                      'taken.', out)
        self.assertIn(f"Next: join with another handle: {self.cmd('NEW-HANDLE')} (replace NEW-HANDLE", out)
        # joining with another handle at once enrolls the kept key, and nothing of the lost join is left
        kept = self.disk()[cli.JOIN_KEY]
        rc, out = self.join(handle='new-user-2')
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.disk()['pubkey'], kept['pubkey'])
        self.assertNotIn(cli.LOST_JOIN, self.disk())

    def test_a_lost_enrollment_says_what_failed_and_never_to_read_what_the_server_holds_first(self):
        # The RC's review (regressions missed[0]): every answer to the enrollment lost, as Client.request raises a cut
        # write, inside `valun join` and in `valun enroll`: the words quoted the write's general advice, "read what it
        # holds before sending it again", next to the one step left, sending the same enrollment again; the enrollee has
        # nothing to read without the agent token that was only in the lost answer.
        self.net.lost_with = vc.ValunError('unreachable', vc.transport_text(SERVER, 'POST', LOST, True, 1), None,
                                           {'cause': 'connection_cut', 'transport_error': 'RemoteDisconnected',
                                            'outcome': 'unknown'})
        self.net.lose['POST /pilot/v1/enroll'] = ['before'] * 6
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn(f"but no answer to its enrollment arrived (3 tries; the last: unreachable: the connection to {SERVER} "
                      'was cut before its whole answer arrived (RemoteDisconnected: Remote end closed connection without '
                      'response)).', out)
        self.assertIn('it sends the same enrollment again', out)
        self.assertNotIn('read what it holds before sending it again', out)
        rc, out = self.enroll()
        self.assertEqual(rc, 1, out)
        self.assertIn('Enrollment not confirmed: no answer to it arrived (3 tries; the last: unreachable: the connection to '
                      f'{SERVER} was cut before its whole answer arrived (RemoteDisconnected: Remote end closed connection '
                      "without response)), so whether the server registered this agent's key is not known.", out)
        self.assertNotIn('read what it holds before sending it again', out)

    def test_the_clients_own_transport_error_and_a_proxys_5xx_are_lost_answers_too(self):
        # as Client.request raises it for a write whose answer was cut
        cut = vc.ValunError('unreachable', vc.transport_text(SERVER, 'POST', LOST, True, 1), None,
                            {'cause': 'connection_cut', 'transport_error': 'RemoteDisconnected', 'outcome': 'unknown'})
        self.net.lost_with = cut
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.join()
        self.assertIn('Joining stopped (unreachable): the join was sent, and no answer to it arrived (unreachable: the '
                      f'connection to {SERVER} was cut before its whole answer arrived (RemoteDisconnected: Remote end '
                      'closed connection without response)).', out)
        # the RC's staging test (2026-11-18): not a write's general advice, since the joiner has nothing to read
        # without the owner token that was only in the lost answer; the join's own next command follows
        self.assertNotIn('read what it holds before sending it again', out)
        self.assertIn('Next: run the same join again', out)
        self.net.participants.clear()
        self.net.fail['POST /pilot/v1/join-sandbox'] = [vc.ValunError('http_error', 'HTTP 502', 502)]
        rc, out = self.join()
        self.assertIn('Joining stopped (http_error): the join was sent, and no answer to it arrived', out)
        self.net.fail['POST /pilot/v1/join-sandbox'] = [vc.ValunError('sandbox_unavailable', 'the sandbox agents are not running', 503)]
        rc, out = self.join()
        self.assertEqual(out.splitlines()[0], 'Joining failed (sandbox_unavailable): the sandbox agents are not running',
                         "the server's own 503 is its answer")

    def test_a_join_that_did_not_reach_the_server_sent_nothing(self):
        self.net.fail['POST /pilot/v1/join-sandbox'] = [vc.ValunError(
            'unreachable', 'cannot reach https://valun.example: [Errno 11001] getaddrinfo failed', None,
            {'cause': 'not_connected', 'transport_error': 'gaierror'})]
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining stopped (unreachable): cannot reach https://valun.example: [Errno 11001] getaddrinfo failed. '
                      'Nothing was sent, so the server holds nothing of this join.', out)
        self.assertIn(f'Next: check the connection with `valun --profile m doctor --server https://valun.example`, then run '
                      f'the same join again: {self.cmd()}.', out)
        self.assertFalse(os.path.exists(self.path()), 'nothing is written for a join that was not sent')
        rc, out = self.join()
        self.assertEqual(rc, 0, out)

    def test_a_refusal_of_the_handle_leaves_no_lost_join_and_the_command_quotes_what_it_can(self):
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.cli('join', '--sandbox', '--approvals', 'console', '--handle', 'new-user', '--operator', "O'Brien", '--about', 'x' * 301,
                           '--server', SERVER)
        # O'Brien in double quotes (the 0.7.2 review: it was "YOUR NAME", a placeholder a server accepted); an --about
        # longer than a command can carry is named apart
        self.assertIn('''--handle new-user --operator "O'Brien" --approvals console --server https://valun.example` (with the '''
                      'same --about as before)', out)
        self.assertNotIn('YOUR NAME', out)
        for unquotable in ("O'Brien $HOME", "it's 100%", "O'Brien \"Jr\"", "don't!", 'x' * 61, 'a "b" c'):
            self.assertIsNone(cli._faithful(unquotable, 60), unquotable)
        self.net.participants.clear()
        self.net.fail['POST /pilot/v1/join-sandbox'] = [vc.ValunError('invalid_field', 'handle: 3-24 characters', 400)]
        rc, out = self.join()
        self.assertEqual(rc, 1, out)
        self.assertNotIn(cli.LOST_JOIN, self.disk(), 'the server refused this handle itself')
        self.assertIn(cli.JOIN_KEY, self.disk(), 'the key stays kept for the next join')
        self.assertIn(f"Next: join with another handle: {self.cmd('NEW-HANDLE')} (replace NEW-HANDLE", out)

    def test_a_refusal_of_anything_but_the_handle_keeps_the_lost_join(self):
        """The 0.7.2 review (p2): after a lost join, doctor's own command (operator "YOUR NAME") got 400 invalid_field
        from a server that refuses placeholders, and the profile forgot the lost join: its next hold message no longer
        said it was probably this profile's. Only a refusal of the handle itself says that join made no participant."""
        self.lose_the_join()
        for refusal in (vc.ValunError('invalid_field', 'operator: "YOUR NAME" is the placeholder in the example commands', 400,
                                      {'field': 'operator'}),
                        vc.ValunError('rate_limited', 'too many sandbox joins from this address in the last hour', 429,
                                      {'retry_after_ms': 60_000}),
                        vc.ValunError('invalid_field', 'about contains control, bidi or invisible characters', 400),
                        vc.ValunError('display_name_taken', "display_name must not copy another participant's handle", 409),
                        vc.ValunError('sandbox_full', 'the sandbox takes at most 200 new participants in any 24 hours', 429)):
            self.net.fail['POST /pilot/v1/join-sandbox'] = [refusal]
            rc, out = self.join()
            self.assertEqual(rc, 1, out)
            self.assertEqual(self.disk()[cli.LOST_JOIN]['handle'], 'new-user', refusal.code)
        self.net.hold = (LostJoinAnswer.UNTIL, 1_799_000)
        rc, out = self.join()
        self.assertIn("this profile's join of new-user at ", out)
        self.assertIn('got no answer, so it is probably that one.', out)
        # a refusal of the handle itself: a reserved one, or one of a shape no server takes
        for refusal in (vc.ValunError('handle_taken', 'that handle is reserved', 409),
                        vc.ValunError('invalid_field', 'handle: must not look like a participant id', 400),
                        vc.ValunError('invalid_field', 'handle: NEW-HANDLE is the placeholder in the example commands', 400,
                                      {'field': 'handle'})):
            self.write(dict(self.disk(), **{cli.LOST_JOIN: dict(handle='new-user', server=SERVER, at='2026-11-17T23:02:11Z',
                                                                sandbox=True)}))
            self.net.fail['POST /pilot/v1/join-sandbox'] = [refusal]
            rc, out = self.join()
            self.assertEqual(rc, 1, out)
            self.assertNotIn(cli.LOST_JOIN, self.disk(), refusal)
            self.assertNotIn('got no answer', out)
            self.assertIn('Next: join with another handle: ', out)

    def test_ctrl_c_while_the_join_is_on_its_way_keeps_the_key_and_says_what_the_server_may_hold(self):
        """The 0.7.2 review (p7): Ctrl+C while the join's answer was awaited (a slow join is when people press it) ended
        with "valun join: stopped (Ctrl+C)." and wrote nothing: no key kept, no lost join, nothing on what the server may
        hold now."""
        self.net.fail['POST /pilot/v1/join-sandbox'] = [KeyboardInterrupt()]
        rc, out = self.join()
        self.assertEqual(rc, 130, out)
        self.assertIn('Joining stopped (Ctrl+C) before an answer to the join arrived: the join may have reached the server.',
                      out)
        self.assertIn('The server may now hold a participant new-user made by this join.', out)
        self.assertIn(f'Next: run the same join again: {self.cmd()}.', out)
        disk = self.disk()
        self.assertEqual((disk[cli.LOST_JOIN]['handle'], disk[cli.LOST_JOIN]['operator']), ('new-user', 'Fitz'))
        # it never reached this server: the same join goes through, and enrolls the key that was kept
        rc, out = self.join()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.disk()['pubkey'], disk[cli.JOIN_KEY]['pubkey'])
        self.assertNotIn(cli.LOST_JOIN, self.disk())

    def test_a_placeholder_handle_or_operator_is_refused_before_anything_is_sent(self):
        """The 0.7.2 review (p2b): the RC's own "another handle" command, pasted unchanged, joined valun.tech's code as
        NEW-HANDLE for good, as README blocks pasted unchanged joined as your-handle, operated by "YOUR NAME" (the
        newcomer tests). `valun join` refuses the placeholders of the example commands (valun-app's list) on any
        server, before anything is sent."""
        for handle, operator, shown in (('NEW-HANDLE', 'Fitz', '--handle NEW-HANDLE'), ('new_handle', 'Fitz', '--handle NEW-HANDLE'),
                                        ('your-handle', 'Fitz', '--handle YOUR-HANDLE'), ('Your_Handle', 'Fitz', '--handle YOUR-HANDLE'),
                                        ('my-seller', 'Fitz', '--handle my-seller'), ('HANDLE', 'Fitz', '--handle HANDLE'),
                                        ('new-user', 'YOUR NAME', '--operator "YOUR NAME"'),
                                        ('new-user', 'your name', '--operator "YOUR NAME"'), ('new-user', 'NAME', '--operator NAME')):
            rc, out = self.cli('join', '--sandbox', '--handle', handle, '--operator', operator, '--server', SERVER,
                               '--owner-token-file', self.token_file)
            self.assertEqual(rc, 1, out)
            self.assertEqual(out.strip().splitlines()[-1],
                             f'Joining refused before anything was sent: {shown} is the placeholder in the example commands. '
                             'Choose your own handle and operator name (both are public, and neither can change after you '
                             'join), and join with them.', handle)
        self.assertEqual(self.net.calls, [], 'nothing was sent')
        self.assertFalse(os.path.exists(self.path()), 'nothing was written')
        # a handle that is more than a placeholder is one of your own
        rc, out = self.join(handle='new-handle-2')
        self.assertEqual(rc, 0, out)

    def test_an_invited_join_whose_answer_is_lost_is_the_inviting_operators_to_finish(self):
        """The 0.7.2 review (p9): no server releases an invited participant that never enrolled (valun-app keeps it for
        the operator who gave the invite to finish, at its owner's request), so the hold words of a sandbox join are
        wrong for it."""
        def join_invited(invite=INVITE):
            return self.cli('join', '--invite-from-stdin', '--handle', 'new-user', '--operator', 'Fitz', '--server', SERVER,
                            stdin=invite + '\n')
        invited = '`valun --profile m join --invite-from-stdin --handle {h} --operator Fitz --server https://valun.example`'
        self.net.lose['POST /pilot/v1/join'] = ['after']
        rc, out = join_invited()
        self.assertEqual(rc, 1, out)
        self.assertIn('Its owner token and enrollment code were only in that answer, so only the operator who gave you the '
                      'invite can finish it: at your request they can give you a new owner token and enrollment code for it, '
                      'or release it. Until then new-user stays taken.', out)
        self.assertNotIn('A server that releases unfinished joins', out)
        self.assertIn(f"Next: run the same join again: {invited.format(h='new-user')} (the invite code may have been used by "
                      'the join that was lost: if it is refused, ask for a new one, or join without one, --sandbox). If it '
                      'answers that new-user is taken, ask the operator who gave you the invite to finish or release that '
                      f"participant, or join with another handle: {invited.format(h='NEW-HANDLE')} (replace NEW-HANDLE", out)
        self.assertIs(self.disk()[cli.LOST_JOIN]['sandbox'], False)
        rc, out = self.cli('doctor', '--server', SERVER)
        self.assertIn(f"Run the join again: {invited.format(h='new-user')}: if new-user is taken, ask the operator who gave you "
                      'the invite to finish or release that participant, or join with another handle (public and permanent)',
                      out)
        self.assertNotIn('it says until when', out)
        # the same join again: the lost join used the invite
        rc, out = join_invited()
        self.assertEqual(rc, 1, out)
        self.assertIn('Joining failed (invalid_invite): invite code is invalid, used up or expired', out)
        self.assertIn('got no answer, so it probably used this invite and made that participant. Its owner token was only in '
                      'the answer that was lost, so only the operator who gave you the invite can finish it', out)
        self.assertIn('Next: ask the operator who gave you the invite to finish or release that participant, or join without '
                      'an invite: `valun --profile m join --sandbox --handle NEW-HANDLE --operator Fitz --server '
                      'https://valun.example` (replace NEW-HANDLE', out)
        self.assertIn(cli.LOST_JOIN, self.disk(), 'a refused invite says nothing of the handle')
        # with a new invite the handle is taken, for good: the operator's to finish
        self.net.invite_used = False
        rc, out = join_invited()
        self.assertIn('Joining failed (handle_taken)', out)
        self.assertIn('got no answer: the server probably made that participant, and its owner token was only in the answer '
                      'that was lost, so only the operator who gave you the invite can finish it', out)
        self.assertIn('Next: ask the operator who gave you the invite to finish or release that participant, or join with '
                      'another handle: ', out)

    def test_doctor_names_the_flags_of_a_lost_join_and_apart_what_a_record_of_the_first_builds_lacks(self):
        self.write({'server': SERVER, cli.LOST_JOIN: {'handle': 'new-user', 'server': SERVER, 'at': '2026-11-17T23:02:11Z',
                                                      'sandbox': True}})
        rc, out = self.cli('doctor', '--server', SERVER)
        self.assertIn('Run the join again: `valun --profile m join --sandbox --handle new-user --operator "YOUR NAME" --server '
                      'https://valun.example` (with the same --operator as before): if new-user is held', out)
        # "YOUR NAME", pasted unchanged, is refused before anything is sent
        self.net.calls.clear()
        rc, out = self.cli('join', '--sandbox', '--handle', 'new-user', '--operator', 'YOUR NAME', '--server', SERVER)
        self.assertIn('Joining refused before anything was sent', out)
        self.assertEqual(self.net.calls, [])


class DoctorBeforeAJoin(Base):
    """The RC's staging test (2026-11-18), problem 6: on a profile that had not joined, or whose join was lost, doctor
    printed "ok Approvals: ask. Before you sign a commitment, your owner is asked ..." while its own FIX line suggested
    `join --sandbox`, which uses console approvals. Before a join, doctor names the mode the join it suggests uses."""

    def doctor(self, profile='m'):
        with mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}):
            return self.cli('doctor', '--server', SERVER, profile=profile)

    def test_a_profile_that_never_joined_names_what_each_join_uses(self):
        rc, out = self.doctor()
        self.assertEqual(rc, 1, out)
        self.assertIn('FIX   Not connected: run `valun --profile m join --sandbox --handle YOUR-HANDLE', out)
        self.assertNotIn('Approvals: ask', out)
        self.assertIn("ok    Approvals: not set yet (this profile has not joined). A sandbox join asks whether a person will "
                      "approve your agent's commitments: console if one will (your agent signs at once, and the Valun "
                      "server holds your agent's offers and counter-offers, its acceptances (taking a job included), its "
                      'guarantee offers, and the note or payment by transfer it signs when it accepts a delivery for them '
                      'in the owner console), none if nobody will (it signs on its own within the self-serve limits); '
                      '--approvals answers it beforehand. A join with an invite uses ask: you are asked before your agent '
                      'signs', out)

    def test_a_lost_join_names_the_mode_of_the_join_it_runs_again(self):
        # a join whose approvals were answered at the terminal (fix inbox #164): recorded as given, and run again so
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.cli('join', '--sandbox', '--handle', 'new-user', '--operator', 'Fitz', '--server', SERVER,
                           '--owner-token-file', self.token_file, answers=['yes'])
        self.assertEqual(rc, 1, out)
        self.assertEqual(self.disk()[cli.LOST_JOIN]['approvals'], 'console')
        rc, out = self.doctor()
        self.assertIn('FIX   Not connected yet: this profile\'s join of new-user', out)
        self.assertIn('--approvals console', out)
        self.assertNotIn('Approvals: ask', out)
        self.assertIn('ok    Approvals: not set yet (this profile has not joined). The join in the FIX line below sets them '
                      'to console.', out)
        self.assertLess(out.index('ok    Approvals: not set yet'), out.index('FIX   Not connected yet'), 'the FIX line is below')
        # a lost join that named no mode (as 0.7.2 recorded one): the join doctor names asks again
        disk = self.disk()
        del disk[cli.LOST_JOIN]['approvals']
        with open(self.path(), 'w', encoding='utf-8') as f:
            json.dump(disk, f)
        rc, out = self.doctor()
        self.assertIn('ok    Approvals: not set yet (this profile has not joined). The join in the FIX line below asks whether '
                      "a person will approve your agent's commitments: console if one will, none if nobody will (with no "
                      'terminal it refuses and prints both joins).', out)
        fix = next(x for x in out.splitlines() if x.strip().startswith('FIX   Not connected yet'))
        self.assertNotIn('--approvals', fix)
        # a lost join that named its mode runs it again, and doctor says so
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.cli('join', '--sandbox', '--handle', 'h-lee', '--operator', 'Fitz', '--approvals', 'none',
                           '--server', SERVER, '--owner-token-file', os.path.join(self.home, 'n.txt'), profile='n')
        self.assertEqual(rc, 1, out)
        rc, out = self.doctor(profile='n')
        self.assertIn('--approvals none', out)
        self.assertIn('ok    Approvals: not set yet (this profile has not joined). The join in the FIX line below sets them '
                      'to none.', out)
        self.assertNotIn('Approvals: none yet', out, 'never read as the mode none')
        # valun status before a join says it has no approval mode yet, as doctor does (0.7.1 and the RC said ask)
        rc, out = self.cli('status', profile='n')
        self.assertIn('approvals:        (not joined)', out)
        self.assertNotIn('approvals:        ask', out)


class PrintedCommandsInEveryShell(Base):
    """The RC's staging test (2026-11-18), problem 4: printed next commands quoted values with single quotes, which Windows
    cmd does not understand: after a lost join, `--operator 'Valun QA rc072'` failed there ("unrecognized arguments: QA
    rc072'"), and the console note named `--owner-token-file 'C:\\...'`. A value is now in double quotes where that is
    the same value in cmd, PowerShell, bash and zsh (no " $ ` ! or %), and named apart otherwise."""
    QUOTED = ['Valun QA rc072', "O'Brien", 'C:\\Users\\Ann Lee\\valun-owner-token-rc72-a.txt', '#1',
              'a&b|c<d>e^f(g);h', '/home/ann lee/valun owner token.txt', 'O\u2019Brien', '\u2018single\u2019',
              'low\u201fquote', 'caf\u00e9 \u65e5\u672c']
    # the RC's review (R2-OTHER-2): curly double quotes, which Windows PowerShell takes for double quotes even inside
    # them, and an empty value, which it drops
    APART = ['100%', 'a$b', 'hi!', 'say "hi"', 'tick`', '\\\\server\\share\\x.txt', 'C:\\dir\\', 'Ann \u201cAce\u201d Lee',
             'low\u201equote', '\u201cquoted\u201d', 'a\u201db\u201dc', '']

    def setUp(self):
        super().setUp()
        # _faithful also names apart a value stdout cannot write (a cp1252 pipe: the RC's review, R3-REG-1): these
        # print to a stdout that writes any character, whatever stdout the tests run with
        utf8 = mock.patch.object(sys, 'stdout', io.StringIO())
        utf8.start()
        self.addCleanup(utf8.stop)

    def test_a_value_is_bare_or_in_double_quotes_or_named_apart(self):
        self.assertEqual(cli._shell_word('rc72-b-1118'), 'rc72-b-1118')
        self.assertEqual(cli._shell_word('Valun QA rc072'), '"Valun QA rc072"')
        self.assertEqual(cli._shell_word('#1'), '"#1"')
        self.assertEqual(cli._faithful('C:\\Users\\Ann\\owner.txt', 300), '"C:\\Users\\Ann\\owner.txt"')
        for v in self.QUOTED:
            self.assertEqual(cli._faithful(v, 300), f'"{v}"', v)
        for v in self.APART:
            self.assertIsNone(cli._faithful(v, 300), v)
        # on a stdout that writes cp1252 (a pipe on Windows), a value with a character it lacks is named apart too
        with mock.patch.object(sys, 'stdout', io.TextIOWrapper(io.BytesIO(), encoding='cp1252')):
            self.assertEqual(cli._faithful('caf\u00e9 Lee', 300), '"caf\u00e9 Lee"')
            self.assertIsNone(cli._faithful('caf\u00e9 \u65e5\u672c', 300))

    def test_a_lost_join_and_the_console_note_print_double_quotes(self):
        self.net.lose['POST /pilot/v1/join-sandbox'] = ['after']
        rc, out = self.cli('join', '--sandbox', '--approvals', 'console', '--handle', 'new-user', '--operator', 'Valun QA rc072', '--server', SERVER,
                           '--owner-token-file', self.token_file)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'--handle new-user --operator "Valun QA rc072" --approvals console --owner-token-file '
                      f'{cli._shell_word(self.token_file, 300)} --server {SERVER}`', out)
        self.assertNotIn("'Valun QA rc072'", out)
        # a join whose approvals question was answered (yes: console): its note names the owner token file in double
        # quotes
        os.makedirs(os.path.join(self.home, 'Ann Lee'))
        written = os.path.abspath(os.path.join(self.home, 'Ann Lee', 'owner.txt'))
        rc, out = self.cli('join', '--sandbox', '--handle', 'h-lee', '--operator', 'Ann Lee', '--server', SERVER,
                           '--owner-token-file', written, profile='n', answers=['yes'])
        self.assertEqual(rc, 0, out)
        self.assertIn(f'If nobody will: `valun --profile n config approvals none --owner-token-file "{written}"`.', out)
        self.assertNotIn(f"'{written}'", out)

    def test_each_quoted_value_is_one_argument_in_the_shells_of_this_machine(self):
        """Runs the quoted words through cmd and PowerShell on Windows, and sh, bash and zsh elsewhere (those found)."""
        words = ' '.join(cli._faithful(v, 300) for v in self.QUOTED)
        for name, argv in self.in_each_shell(words):
            self.assertEqual(argv, self.QUOTED, name)

    def test_the_join_the_not_joined_hints_print_reaches_join_as_printed_in_every_shell(self):
        # The RC's review (R2-OTHER-1): it ended in --owner-token-file "$HOME/valun-m-owner-token.txt", which cmd (and an
        # agent's tool that runs commands through cmd.exe) passes as that very text: the file could not be made, and the
        # owner token was shown. join's own default file ($HOME/valun-owner-token-HANDLE.txt) needs no flag.
        hint = cli._sandbox_join(cli.argparse.Namespace(profile='m'), SERVER)
        self.assertTrue(hint.startswith('valun '), hint)
        want = ['--profile', 'm', 'join', '--sandbox', '--handle', 'YOUR-HANDLE', '--operator', 'YOUR NAME', '--server', SERVER]
        for name, argv in self.in_each_shell(hint[len('valun '):]):
            self.assertEqual(argv, want, name)
        # an empty operator is the placeholder, never "" (which Windows PowerShell drops)
        args = cli.argparse.Namespace(profile='m', sandbox=True, display_name='', about='', services='', wants='',
                                      approvals='console', approvals_given=None, clearing=None, owner_token_file=None)
        self.assertEqual(cli._join_command(args, SERVER, 'h-x', '', lacking=True),
                         f'`valun --profile m join --sandbox --handle h-x --operator "YOUR NAME" --server {SERVER}`')

    def in_each_shell(self, words):
        """[(shell, the arguments a program got)] for `words` (shell words) run in cmd and PowerShell on Windows, the
        .ps1 in UTF-8 with its mark as pasted text reaches PowerShell 5.1 (without it, PowerShell reads its own code
        page, and a curly quote never reached it as one: R2-OTHER-2), and in sh, bash and zsh elsewhere (those found)."""
        import shutil
        import subprocess
        echo = 'import sys,json;print(json.dumps(sys.argv[1:]))'
        runs = []
        if os.name == 'nt':
            runs.append(('cmd', dict(args=f'"{sys.executable}" -c "{echo}" {words}', shell=True)))
            for ps in ('powershell', 'pwsh'):
                if shutil.which(ps):
                    script = os.path.join(self.home, f'{ps}.ps1')
                    with open(script, 'w', encoding='utf-8-sig') as f:
                        f.write(f'& "{sys.executable}" -c "{echo}" {words}\n')
                    runs.append((ps, dict(args=[shutil.which(ps), '-NoProfile', '-NonInteractive', '-ExecutionPolicy',
                                                'Bypass', '-File', script])))
        else:
            for sh in ('sh', 'bash', 'zsh'):
                if shutil.which(sh):
                    runs.append((sh, dict(args=[shutil.which(sh), '-c', f'"{sys.executable}" -c "{echo}" {words}'])))
        self.assertTrue(runs)
        out = []
        for name, kw in runs:
            r = subprocess.run(capture_output=True, timeout=120, env=dict(os.environ, PYTHONIOENCODING='utf-8'), **kw)
            self.assertEqual((r.returncode, r.stderr), (0, b''), name)
            out.append((name, json.loads(r.stdout.decode('utf-8'))))
        return out


class EndedInput(io.StringIO):
    """A stdin that says it is a terminal and has nothing to read: NUL on Windows (`< /dev/null` in Git Bash, `< NUL`
    in cmd), whose isatty() is true."""

    def isatty(self):
        return True


class NoTerminal(Base):
    """The first-tester readiness assessment of 2026-11-18 (other findings): doctor's FIX line, run by a shell agent
    with no terminal (`valun --profile default join --sandbox`, without its handle), ended in an EOFError traceback at
    the handle prompt; `valun enroll` without --participant did too, and an invite join waited for a console nobody was
    at (Windows' getpass reads the console, not stdin). Without a terminal, join and enroll print the command to run,
    with what they lack, and send nothing (exit 2); an input that ends at a prompt does the same."""

    def test_a_join_that_lacks_what_it_would_ask_for_prints_the_command_to_run(self):
        cases = ((['--sandbox', '--approvals', 'console'], 'a handle and an operator name',
                  f'Run `valun --profile m join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --approvals console '
                  f'--server {SERVER}`, with your own handle (public and permanent: 3 to 24 letters, digits, _ or -, '
                  'starting with a letter) and your name (public: who controls this agent).'),
                 (['--sandbox', '--handle', 'new-user', '--approvals', 'none', '--about', 'Summaries.'], 'an operator name',
                  f'Run `valun --profile m join --sandbox --handle new-user --operator "YOUR NAME" --about Summaries. '
                  f'--approvals none --server {SERVER}`, with your name (public: who controls this agent).'),
                 (['--handle', 'new-user', '--operator', 'Fitz'], 'the invite code',
                  f'Run `valun --profile m join --invite-from-stdin --handle new-user --operator Fitz --server {SERVER}`, '
                  'with the invite code on its input (one line).'))
        for extra, lacks, run in cases:
            self.net.calls.clear()
            rc, out = self.cli('join', *extra, '--server', SERVER)
            self.assertEqual(rc, 2, out)
            self.assertIn(f'Nothing was sent: this join needs {lacks}, and there is no terminal here to ask for '
                          f"{'it' if ' and ' not in lacks else 'them'}. {run}", out)
            self.assertEqual(self.net.calls, [], 'nothing was sent')
            self.assertFalse(os.path.exists(self.path()), 'nothing was written')
        # an invite join: the sandbox join is named too, and nothing says to stop with Ctrl+C (no one is there)
        self.assertIn(f'No invite code? Join without one: `valun --profile m join --sandbox --handle YOUR-HANDLE --operator '
                      f'"YOUR NAME" --server {SERVER}`.', out)
        self.assertNotIn('Ctrl+C', out)
        # a sandbox join that names no --approvals: what it lacks, whether a person will approve, and both joins (#164)
        self.net.calls.clear()
        rc, out = self.cli('join', '--sandbox', '--server', SERVER)
        self.assertEqual(rc, 2, out)
        self.assertIn("Nothing was sent: this join needs a handle and an operator name and whether a person will approve "
                      "your agent's commitments, and there is no terminal here to ask for them. Run one of these, with your "
                      'own handle (public and permanent: 3 to 24 letters, digits, _ or -, starting with a letter) and your '
                      'name (public: who controls this agent):\n'
                      f'  if a person will approve each one in the owner console ({SERVER}/pilot#owner): `valun --profile m '
                      f'join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --approvals console --server {SERVER}`\n'
                      '  if nobody will (your agent signs on its own, within the self-serve limits): `valun --profile m join '
                      f'--sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --approvals none --server {SERVER}`', out)
        self.assertEqual(self.net.calls, [], 'nothing was sent')
        self.assertFalse(os.path.exists(self.path()), 'nothing was written')

    def test_an_input_that_ends_at_a_prompt_prints_the_command_too(self):
        # NUL is a "terminal" on Windows: the prompt is shown, and its input ends at once
        for extra in (['--sandbox'], ['--sandbox', '--handle', 'new-user']):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out), \
                    mock.patch.object(sys, 'stdin', EndedInput()):
                rc = cli.main(['--profile', 'm', 'join', *extra, '--server', SERVER])
            self.assertEqual(rc, 2, out.getvalue())
            self.assertNotIn('Traceback', out.getvalue())
            self.assertIn('Nothing was sent: this join needs ', out.getvalue())
            # stdout is not a terminal here: the approvals question cannot be asked either, so both joins (#164)
            for mode in ('console', 'none'):
                self.assertIn(f'`valun --profile m join --sandbox --handle {extra[-1] if len(extra) > 1 else "YOUR-HANDLE"} '
                              f'--operator "YOUR NAME" --approvals {mode} --server {SERVER}`', out.getvalue())
        self.assertEqual(self.net.calls, [])
        # at a terminal that answers, join asks as before
        with contextlib.redirect_stdout(io.StringIO()) as out, mock.patch.object(sys, 'stdin', EndedInput('h-new\nFitz\n')):
            rc = cli.main(['--profile', 'm', 'join', '--sandbox', '--approvals', 'none', '--server', SERVER,
                           '--owner-token-file', self.token_file])
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn('Joined Valun as h-new', out.getvalue())

    def test_an_enroll_that_lacks_its_participant_or_code_prints_the_command_to_run(self):
        self.net.add()
        rc, out = self.cli('enroll', '--server', SERVER)
        self.assertEqual(rc, 2, out)
        self.assertIn('Nothing was sent: this enrollment needs the participant id and the enrollment code from your owner '
                      f'console ({SERVER}/pilot#owner), and there is no terminal here to ask for them. Run `valun --profile m '
                      f'enroll --participant vp_... --code-from-stdin --server {SERVER}`, with your participant id in place of '
                      'vp_... and the code on its input (one line).', out)
        rc, out = self.cli('enroll', '--server', SERVER, '--participant', PID)
        self.assertEqual(rc, 2, out)
        self.assertIn('Nothing was sent: this enrollment needs the enrollment code from your owner console '
                      f'({SERVER}/pilot#owner), and there is no terminal here to ask for it. Run `valun --profile m enroll '
                      f'--participant {PID} --code-from-stdin --server {SERVER}`, with the code on its input (one line).', out)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(sys, 'stdin', EndedInput()):
            rc = cli.main(['--profile', 'm', 'enroll', '--server', SERVER])
        self.assertEqual(rc, 2, out.getvalue())
        self.assertIn('Nothing was sent: this enrollment needs the participant id and the enrollment code', out.getvalue())
        self.assertEqual(self.net.calls, [])
        # with both given, it enrolls as before
        rc, out = self.enroll()
        self.assertEqual(rc, 0, out)


if __name__ == '__main__':
    unittest.main()
