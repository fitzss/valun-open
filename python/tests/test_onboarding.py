"""What a tester meets first (0.7.2: fix inbox #15 and #30, the onboarding review). A profile of the pilot network,
retired on 2026-11-13, is told so, with how to go on in a profile of the network its server now serves: doctor and
status say it, and so do the agent's error hints (`valun call`, the MCP server, the approval path). `valun mcp` and
`valun tools` speak the testnet's words before a profile joins. A profile file that cannot be read is a FIX line, not
a traceback. `valun enroll` of a profile that names no network signs for the network its server names. Offline: a fake
server answers every vc.Client request."""
import contextlib
import importlib.metadata
import io
import json
import os
import re
import shlex
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import __version__  # noqa: E402
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun import schemas  # noqa: E402

SERVER = 'https://valun.example'
PILOT_ID, NEW_ID = 'vp_d77a7c3b6b23', 'vp_0e0e0e0e0e0e'
TESTNET_INFO = {'network': 'valun-testnet-1', 'protocol': 'valun-deal/1', 'unit': 'nanoERG',
                'tracker_nft_id': 'dd' * 32, 'denomination': 'erg'}
PILOT_INFO = {'network': 'valun-pilot-1', 'protocol': 'valun-deal/1', 'unit': 'PC', 'tracker_nft_id': '11' * 32,
              'denomination': 'token:' + vc.PILOT_TOKEN_ID}
# A profile made for the pilot before 0.5 (it names no network), with the pilot's pins and an agent token the testnet
# server does not know.
PILOT_PROFILE = {'server': SERVER, 'participant_id': PILOT_ID, 'pubkey': '02' + 'ab' * 32, 'secret': '11' * 32,
                 'agent_token': 'vpa_PILOT-test-only', 'approvals': 'ask',
                 'pins': {'tracker_nft_id': PILOT_INFO['tracker_nft_id'], 'denomination': PILOT_INFO['denomination']}}
JOIN = '`valun --profile testnet join --sandbox --handle HANDLE --operator "YOUR NAME" --owner-token-file FILE`'
JOIN_WORDS = '(HANDLE: public and permanent; FILE: a new file for its owner token)'
UNKNOWN_AGENT = vc.ValunError('unauthorized', 'agent token required', 401)
OFFER = {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 't', 'description': 'd', 'deliverable': 'x',
         'price': 3}


_REAL_DISTRIBUTION = importlib.metadata.distribution


def _no_valun_install(name):
    """importlib.metadata.distribution, as if no valun were installed: the hints under test then name `valun==X`
    (cli._uvx_from), as for a valun from an index, whatever installed this one (CI: `pip install ./python`, whose
    direct_url.json names the folder's URL, which the hints would name)."""
    if name == 'valun':
        raise importlib.metadata.PackageNotFoundError(name)
    return _REAL_DISTRIBUTION(name)


class Terminal(io.StringIO):
    """A stream that says it is a terminal."""

    def isatty(self):
        return True


class FakeServer:
    """Every vc.Client request: the answer for 'METHOD /path' (a value, a callable of (client, body, token), or a
    ValunError to raise; unauthorized for a route it does not list, as for an agent the server does not know)."""

    def __init__(self, answers):
        self.answers, self.calls = dict(answers), []

    def request(self, client, method, path, body=None, auth=True, token=None):
        key = f'{method} {path}'
        self.calls.append(key)
        a = self.answers.get(key, UNKNOWN_AGENT)
        if callable(a):
            a = a(client, body, token)
        if isinstance(a, Exception):
            raise a
        return json.loads(json.dumps(a))


class Profiles(unittest.TestCase):
    answers = {'GET /pilot/v1/info': TESTNET_INFO}

    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.home = home.name
        env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home, 'HOME': self.home, 'USERPROFILE': self.home})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        meta = mock.patch('importlib.metadata.distribution', _no_valun_install)
        meta.start()
        self.addCleanup(meta.stop)
        self.server = FakeServer(self.answers)
        server = self.server
        p = mock.patch.object(vc.Client, 'request', lambda c, *a, **kw: server.request(c, *a, **kw))
        p.start()
        self.addCleanup(p.stop)

    def path(self, name):
        return os.path.join(self.home, 'profiles', f'{name}.json')

    def write(self, name, state=None, raw=None):
        os.makedirs(os.path.join(self.home, 'profiles'), exist_ok=True)
        with open(self.path(name), 'wb') as f:
            f.write(raw if raw is not None else json.dumps(state).encode('utf-8'))
        if os.name != 'nt':                     # as valun writes a profile: doctor names one others can read
            os.chmod(self.path(name), 0o600)

    def read(self, name):
        with open(self.path(name), encoding='utf-8') as f:
            return json.load(f)

    def cli(self, *argv, stdin='', answers=None):
        """cli.main(argv): (exit code, stdout, stderr). With answers: at a terminal (stdin and stdout), whose input()
        answers them."""
        out, err = (Terminal() if answers is not None else io.StringIO()), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            stack.enter_context(mock.patch.object(sys, 'stdin', Terminal(stdin) if answers is not None else io.StringIO(stdin)))
            if answers is not None:
                stack.enter_context(mock.patch('builtins.input', side_effect=answers))
            rc = cli.main(list(argv))
        return rc, out.getvalue(), err.getvalue()


class RetiredPilot(Profiles):
    """A profile of the pilot network on a server that now serves the testnet (valun.tech since 2026-11-13): doctor,
    status and the agent's hints say so, and how to go on; none sends its owner to `config server` or `enroll`, which
    lead in circles (the onboarding review)."""

    def test_doctor_names_the_retired_network_and_the_join_that_goes_on(self):
        for state in (PILOT_PROFILE, dict(PILOT_PROFILE, network='valun-pilot-1')):
            self.write('default', state)
            self.server.calls.clear()
            rc, out, _err = self.cli('doctor')
            self.assertEqual(rc, 1, out)
            fix = [line for line in out.splitlines() if line.startswith('  FIX')]
            self.assertEqual(len(fix), 1, out)
            self.assertIn('This profile joined the pilot network (valun-pilot-1), which was retired on 2026-11-13: '
                          'https://valun.example now serves valun-testnet-1, which knows neither this participant nor '
                          'its key, so this profile signs nothing there. Use a profile on valun-testnet-1: join in a '
                          f'new profile, in a terminal: {JOIN} {JOIN_WORDS}.', fix[0])
            for circle in ('config server', 'enroll', 'tracker_mismatch'):
                self.assertNotIn(circle, out)
            self.assertEqual(self.server.calls, ['GET /pilot/v1/info'], 'the agent is not checked against that server')

    def test_the_join_doctor_prints_runs_as_written(self):
        self.write('default', PILOT_PROFILE)
        rc, out, _err = self.cli('doctor')
        argv = shlex.split(re.search(r'`valun (--profile testnet join [^`]+)`', out).group(1))
        token_file = os.path.join(self.home, 'owner-token.txt')
        argv = [{'HANDLE': 'tn-newcomer', 'YOUR NAME': 'Ann', 'FILE': token_file}.get(a, a) for a in argv]
        mandate = {'max_issue_per_deal': 5_000_000, 'max_accept_per_deal': 5_000_000,
                   'max_issue_outstanding': 40_000_000}
        self.server.answers.update({
            'POST /pilot/v1/join-sandbox': {'participant_id': NEW_ID, 'owner_token': 'vpo_test-only',
                                            'enrollment_code': 'vpe_x', 'network': 'valun-testnet-1',
                                            'sandbox_only': True, 'note': 'Self-serve.'},
            'POST /pilot/v1/enroll': {'participant_id': NEW_ID, 'agent_token': 'vpa_NEW-test-only',
                                      'network': 'valun-testnet-1'},
            'GET /pilot/v1/owner': {'mandate': mandate}, 'PUT /pilot/v1/owner/mandate': {}})
        rc, out, _err = self.cli(*argv)             # with no terminal it asks nothing: both joins (fix inbox #164)
        self.assertEqual(rc, 2, out)
        self.assertIn('Nothing was sent: a sandbox join that names no --approvals asks whether a person will approve', out)
        rc, out, _err = self.cli(*argv, answers=['no'])     # run as written in a terminal: nobody will approve
        self.assertEqual(rc, 0, out)
        new = self.read('testnet')
        self.assertEqual((new['participant_id'], new['network']), (NEW_ID, 'valun-testnet-1'))
        self.assertEqual(self.read('default')['participant_id'], PILOT_ID, 'the pilot profile is left as it is')

    def test_a_profile_testnet_that_is_on_the_testnet_is_offered_first(self):
        self.write('default', PILOT_PROFILE)
        self.write('testnet', {'server': SERVER, 'participant_id': NEW_ID, 'network': 'valun-testnet-1'})
        rc, out, _err = self.cli('doctor')
        self.assertIn("Use a profile on valun-testnet-1: use your profile 'testnet', which is on valun-testnet-1: "
                      '`valun --profile testnet doctor` (and `valun --profile testnet mcp` in an MCP app).', out)
        self.assertNotIn('join --sandbox', out)
        # a profile 'testnet' that is itself the pilot's: a new name
        self.write('testnet', dict(PILOT_PROFILE))
        rc, out, _err = self.cli('doctor')
        self.assertIn('`valun --profile NAME join --sandbox --handle HANDLE --operator "YOUR NAME" --owner-token-file '
                      'FILE` (NAME: a profile name not used yet; HANDLE: public and permanent;', out)

    def test_status_says_so_and_reads_the_server_only_for_a_pilot_profile(self):
        self.write('default', PILOT_PROFILE)
        rc, out, _err = self.cli('status')
        self.assertEqual(rc, 0, out)
        self.assertIn('network:          valun-pilot-1, retired on 2026-11-13 (https://valun.example now serves '
                      'valun-testnet-1)', out)
        self.assertIn(f'Use a profile on valun-testnet-1: join in a new profile, in a terminal: {JOIN}', out)
        self.assertEqual(self.server.calls, ['GET /pilot/v1/info'])
        testnet = {'server': SERVER, 'participant_id': NEW_ID, 'network': 'valun-testnet-1'}
        for state, network in ((testnet, 'valun-testnet-1'), ({}, '(not joined)')):
            self.write('default', state)
            self.server.calls.clear()
            rc, out, _err = self.cli('status')
            self.assertEqual(rc, 0, out)
            self.assertIn(f'network:          {network}\n', out)
            self.assertNotIn('retired', out)
            self.assertEqual(self.server.calls, [], 'status of any other profile reads nothing')

    def test_a_server_that_still_runs_the_pilot_or_cannot_be_read_retires_nothing(self):
        self.write('default', PILOT_PROFILE)
        for info in (PILOT_INFO, vc.ValunError('unreachable', 'cannot reach it')):
            self.server.answers['GET /pilot/v1/info'] = info
            rc, out, _err = self.cli('status')
            self.assertIn('network:          valun-pilot-1\n', out)
            self.assertNotIn('retired', out)
            rc, out, _err = self.cli('call', 'valun_status')
            self.assertEqual(json.loads(out)['error'], 'unauthorized', 'the refusal stands')
        rc, out, _err = self.cli('doctor')
        self.assertNotIn('retired', out)
        self.assertNotIn('The server refused this agent', out, 'a server that cannot be read does not check the agent')

    def test_the_agent_gets_network_retired_with_the_command(self):
        self.write('default', PILOT_PROFILE)
        rc, out, _err = self.cli('call', 'valun_status')
        self.assertEqual(rc, 1, out)
        r = json.loads(out)
        self.assertEqual(r['error'], 'network_retired')
        self.assertEqual(r['message'], 'this profile is on the pilot network (valun-pilot-1), retired on 2026-11-13; '
                                       'the server now serves valun-testnet-1; nothing was signed')
        self.assertIn("This agent's profile joined the pilot network (valun-pilot-1), which was retired on 2026-11-13: "
                      'the Valun server now serves valun-testnet-1, which knows neither this participant nor its key. '
                      'Nothing was signed. Its owner must use a profile on valun-testnet-1: join in a new profile, '
                      f'in a terminal: {JOIN}', r['what_this_means'])
        # a testnet profile the server does not know is told what it was told before
        self.write('default', dict(PILOT_PROFILE, network='valun-testnet-1', pins={}))
        rc, out, _err = self.cli('call', 'valun_status')
        r = json.loads(out)
        self.assertEqual(r['error'], 'unauthorized')
        self.assertIn('This agent is not connected to Valun.', r['what_this_means'])

    def test_the_mcp_server_and_the_approval_path_answer_network_retired(self):
        self.write('default', PILOT_PROFILE)
        agent = va.ValunAgent(vc.FileStore(self.path('default')), server=SERVER)
        s = mcp_server.McpServer(agent, 'ask', inp=io.BytesIO(), out=io.BytesIO())
        s.initialize({'protocolVersion': '2025-06-18', 'capabilities': {'elicitation': {}}})
        r = s.call('valun_inbox', {})
        self.assertEqual((r['isError'], r['structuredContent']['error']), (True, 'network_retired'))
        self.assertIn(va.DEFAULT_REJOIN_HINT, r['structuredContent']['what_this_means'], 'the default hint')
        # a commitment: the owner is not asked; the refusal is network_retired, not approval_unbound
        prepared, refusal = agent.prepare_or_refusal('valun_propose', OFFER)
        self.assertIsNone(prepared)
        self.assertEqual(refusal['error'], 'network_retired')
        r = s.call('valun_propose', OFFER)
        self.assertEqual(r['structuredContent']['error'], 'network_retired')
        self.assertEqual(s.out.getvalue(), b'', 'nobody was asked')

    def test_a_pilot_profile_without_pins_signs_nothing_there(self):
        """A profile of the pilot without pins (`config server URL` removes them, which 0.7.1's doctor advised, as does
        one unused since before pins), on a server of the testnet whose public reads answer: its client refuses before
        anything is signed (wrong_network), and pins nothing, so network_retired's 'nothing was signed', and doctor's
        'signs nothing there', are true. Both kinds of pilot profile; `valun call` in the modes that sign straight away,
        the MCP server in client-prompt, and in ask, where the owner is not even asked (the onboarding review)."""
        secret = '22' * 32
        unpinned = {k: v for k, v in PILOT_PROFILE.items() if k != 'pins'}
        unpinned.update(secret=secret, pubkey=vb.public_key(bytes.fromhex(secret)).hex())   # a key that can sign
        exact = {'id': 'vp_' + 'e' * 12, 'handle': 'sandbox-exact', 'status': 'active', 'pubkey': '03' + 'cd' * 32}
        self.server.answers.update({'GET /pilot/v1/participants': [exact],
                                    f"GET /pilot/v1/participants/{exact['id']}": exact})
        retired = ('this profile is on the pilot network (valun-pilot-1), retired on 2026-11-13; the server now serves '
                   'valun-testnet-1; nothing was signed')
        for state in (unpinned, dict(unpinned, network='valun-pilot-1')):
            for mode in ('none', 'console'):
                self.write('default', dict(state, approvals=mode))
                self.server.calls.clear()
                rc, out, _err = self.cli('call', 'valun_propose', json.dumps(OFFER))
                self.assertEqual((rc, json.loads(out)['message']), (1, retired), (mode, state.get('network')))
                self.assertEqual([c for c in self.server.calls if not c.startswith('GET ')], [], 'nothing was sent')
                self.assertNotIn('pins', self.read('default'), "the testnet's tracker is not pinned")
            approve = {'jsonrpc': '2.0', 'id': 'valun-approval-1',       # the owner's answer, were the owner asked
                       'result': {'action': 'accept', 'content': {'approve': True}}}
            for mode, caps, answer in (('client-prompt', {}, b''),
                                       ('ask', {'elicitation': {}}, json.dumps(approve).encode() + b'\n')):
                self.write('default', dict(state, approvals=mode))
                self.server.calls.clear()
                agent = va.ValunAgent(vc.FileStore(self.path('default')), server=SERVER)
                s = mcp_server.McpServer(agent, mode, inp=io.BytesIO(answer), out=io.BytesIO())
                s.initialize({'protocolVersion': '2025-06-18', 'capabilities': caps})
                r = s.call('valun_propose', OFFER)['structuredContent']
                self.assertEqual((r['error'], r['message']), ('network_retired', retired), mode)
                self.assertEqual(s.out.getvalue(), b'', 'nobody was asked')
                self.assertEqual([c for c in self.server.calls if not c.startswith('GET ')], [], 'nothing was sent')
                self.assertNotIn('pins', self.read('default'))

    def test_a_pilot_profile_that_0_7_1_pinned_to_the_testnets_tracker_is_not_asked_either(self):
        """valun 0.7.1 pinned an unpinned pilot profile to whatever server it read, the testnet's tracker included. Such
        a profile is refused on the network, before its pins are checked: the owner is not asked to approve terms that
        cannot be signed, and nothing is sent (the 0.7.2 review)."""
        secret = '22' * 32
        state = {k: v for k, v in PILOT_PROFILE.items() if k != 'pins'}
        state.update(secret=secret, pubkey=vb.public_key(bytes.fromhex(secret)).hex(),
                     pins={'tracker_nft_id': TESTNET_INFO['tracker_nft_id'], 'denomination': TESTNET_INFO['denomination']})
        exact = {'id': 'vp_' + 'e' * 12, 'handle': 'sandbox-exact', 'status': 'active', 'pubkey': '03' + 'cd' * 32}
        self.server.answers.update({'GET /pilot/v1/participants': [exact],
                                    f"GET /pilot/v1/participants/{exact['id']}": exact})
        approve = {'jsonrpc': '2.0', 'id': 'valun-approval-1', 'result': {'action': 'accept', 'content': {'approve': True}}}
        self.write('default', dict(state, approvals='ask'))
        self.server.calls.clear()
        agent = va.ValunAgent(vc.FileStore(self.path('default')), server=SERVER)
        prepared, refusal = agent.prepare_or_refusal('valun_propose', OFFER)
        self.assertIsNone(prepared)
        self.assertEqual(refusal['error'], 'network_retired')
        answer = json.dumps(approve).encode() + bytes([10])            # the owner's answer, one JSON-RPC line
        s = mcp_server.McpServer(agent, 'ask', inp=io.BytesIO(answer), out=io.BytesIO())
        s.initialize({'protocolVersion': '2025-06-18', 'capabilities': {'elicitation': {}}})
        r = s.call('valun_propose', OFFER)['structuredContent']
        self.assertEqual(r['error'], 'network_retired')
        self.assertEqual(s.out.getvalue(), b'', 'nobody was asked')
        self.assertEqual([c for c in self.server.calls if not c.startswith('GET ')], [], 'nothing was sent')

    def test_valun_mcp_passes_the_rejoin_hint_of_this_profile(self):
        self.write('default', PILOT_PROFILE)
        with mock.patch('valun.mcp_server.run', return_value=0) as run:
            self.cli('mcp')
        self.assertEqual(run.call_args.kwargs['rejoin_hint'],
                         f'join in a new profile, in a terminal: {JOIN} {JOIN_WORDS}')
        self.write('default', dict(PILOT_PROFILE, network='valun-testnet-1'))
        with mock.patch('valun.mcp_server.run', return_value=0) as run:
            self.cli('mcp')
        self.assertIsNone(run.call_args.kwargs['rejoin_hint'], 'any other profile: the default, never read')


class NotJoinedYet(Profiles):
    """fix inbox #15, the onboarding review: before a profile joins, `valun mcp` (which the Claude Code plugin starts
    before the join) and `valun tools` describe the one network, valun-testnet-1, as a joined testnet profile sees it;
    the pilot's words, prices in PC, only for a profile of the pilot."""

    def test_the_mcp_server_speaks_the_testnet_words(self):
        for state, words, instructions in (({}, schemas.for_network(schemas.TESTNET), mcp_server.INSTRUCTIONS_TESTNET),
                                           ({'participant_id': PILOT_ID}, schemas.ALL, mcp_server.INSTRUCTIONS),
                                           ({'network': 'valun-pilot-1'}, schemas.ALL, mcp_server.INSTRUCTIONS)):
            store = vc.FileStore(self.path('default'))
            store.state.update(state)
            s = mcp_server.McpServer(va.ValunAgent(store), 'ask', inp=io.BytesIO(), out=io.BytesIO())
            init = s.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                             'params': {'protocolVersion': '2025-06-18'}})
            self.assertEqual(init['result']['instructions'], instructions, state)
            tools = s.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})['result']['tools']
            self.assertEqual([t['description'] for t in tools], [t['description'] for t in words], state)
            self.assertEqual([t['inputSchema'] for t in tools], [t['parameters'] for t in words], state)
        text = json.dumps(mcp_server.tool_list('ask', vc.profile_network({})))
        self.assertNotRegex(text, r'\bPC\b|pilot')
        self.assertIn('Price in nanoERG of Ergo testnet', text)
        self.assertNotIn('PC have no monetary value', mcp_server.INSTRUCTIONS_TESTNET)

    def test_valun_tools_and_the_argument_refusals(self):
        rc, out, _err = self.cli('tools')
        self.assertEqual((rc, json.loads(out)), (0, json.loads(json.dumps(schemas.for_network(schemas.TESTNET)))))
        r = va.ValunAgent(vc.FileStore(self.path('default'))).call_safe('valun_propose', dict(OFFER, price='3'))
        self.assertEqual(r['message'], 'price must be a whole number of nanoERG, at least 1 (a JSON integer), not "3"; '
                                       'nothing was signed')
        self.assertEqual(self.server.calls, [], 'nothing was read')

    def test_a_commitment_before_a_join_gets_the_join_hint(self):
        """In an app that cannot show approval prompts (the MCP server's two paths without elicitation) and in `valun
        call` without a terminal, a commitment of a profile that has not joined answers not_connected with the join
        hint, as valun_status does: not approval_unavailable, whose `config approvals console --owner-token-file` cannot
        work before a join, nor any other mode last past it (the onboarding review). Nothing is read. A joined profile
        still gets approval_unavailable."""
        # what `valun --profile fresh call` and `valun --profile fresh mcp` tell the agent (cli._join_hint): the sandbox
        # join, complete as written (the 0.7.2 clean-user test), then its uvx form
        join = ('run `valun --profile fresh join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME"` in a terminal '
                f'(with uvx: `uvx --from valun=={__version__} valun ...`)')
        hint = f'This agent is not connected to Valun. Its owner must {join}.'
        agent = va.ValunAgent(vc.FileStore(self.path('fresh')), setup_hint=join)
        s = mcp_server.McpServer(agent, 'ask', inp=io.BytesIO(), out=io.BytesIO(), command='valun --profile fresh')
        s.initialize({'protocolVersion': '2025-11-25', 'capabilities': {}})
        status = s.call('valun_status', {})['structuredContent']
        self.assertEqual((status['error'], status['what_this_means']), ('not_connected', hint))
        for r in (s.call('valun_propose', OFFER),
                  s.call_modern({'name': 'valun_propose', 'arguments': OFFER},
                                {'io.modelcontextprotocol/clientCapabilities': {}})):
            self.assertEqual((r['isError'], r['structuredContent']), (True, status))
        rc, out, _err = self.cli('--profile', 'fresh', 'call', 'valun_propose', json.dumps(OFFER))
        self.assertEqual((rc, json.loads(out)), (3, status), 'valun call without a terminal')
        self.assertEqual(self.server.calls, [], 'nothing was read')
        # a joined profile: its owner can choose another mode, as approval_unavailable says
        self.write('joined', {'server': SERVER, 'participant_id': NEW_ID, 'network': 'valun-testnet-1',
                              'secret': '11' * 32, 'agent_token': 'vpa_NEW-test-only'})
        s = mcp_server.McpServer(va.ValunAgent(vc.FileStore(self.path('joined'))), 'ask', inp=io.BytesIO(),
                                 out=io.BytesIO(), command='valun --profile joined')
        s.initialize({'protocolVersion': '2025-11-25', 'capabilities': {}})
        self.assertEqual(s.call('valun_propose', OFFER)['structuredContent'], s.approval_unavailable)
        rc, out, _err = self.cli('--profile', 'joined', 'call', 'valun_propose', json.dumps(OFFER))
        self.assertEqual((rc, json.loads(out)['error']), (3, 'approval_unavailable'))

    def test_the_networks_a_profile_is_on(self):
        self.assertEqual(vc.profile_network({}), 'valun-testnet-1')
        self.assertEqual(vc.profile_network(None), 'valun-testnet-1')
        self.assertEqual(vc.profile_network({'participant_id': PILOT_ID}), 'valun-pilot-1', 'enrolled before 0.5')
        self.assertEqual(vc.profile_network({'participant_id': PILOT_ID, 'network': 'valun-testnet-1'}),
                         'valun-testnet-1')
        self.assertEqual(vc.profile_network({'network': 'valun-pilot-1'}), 'valun-pilot-1')
        self.assertEqual(vc.Client(vc.FileStore(self.path('x'))).network, 'valun-pilot-1',
                         'what a profile signs for: as before')
        self.assertTrue(vc.retired_pilot({'participant_id': PILOT_ID}, 'valun-testnet-1'))
        self.assertFalse(vc.retired_pilot({'participant_id': PILOT_ID}, 'valun-pilot-1'))
        self.assertFalse(vc.retired_pilot({'participant_id': PILOT_ID}, None))
        self.assertFalse(vc.retired_pilot({}, 'valun-testnet-1'), 'not joined: nothing is retired')


class UnreadableProfile(Profiles):
    """A profile file that is there but cannot be read: doctor gives a FIX line and still checks the server, status
    says so, and every other command a message on stderr; never a traceback, and nothing is signed or written."""
    CASES = ((b'{"server": "https://valun.tech", "partic',
              'it is not valid JSON: Unterminated string starting at: line 1 column 34 (char 33)'),
             (b'[1, 2]', 'it is not a JSON object'),
             (b'\xff\xfe{}', 'it is not UTF-8 text'))

    def test_doctor_status_and_the_rest(self):
        for raw, why in self.CASES:
            self.write('default', raw=raw)
            start = (f'The profile {self.path("default")} cannot be read ({why}). Nothing was signed. Restore it from '
                     'a backup, ')
            rc, out, err = self.cli('doctor')
            self.assertEqual(rc, 1, out + err)
            self.assertIn('  FIX   ' + start + 'or move it aside and join again in a new profile (`valun --profile '
                          'NAME join --sandbox ...`)', out)
            self.assertIn('  ok    Server https://valun.tech reachable: valun-testnet-1', out)
            self.assertEqual(err, '')
            rc, out, err = self.cli('status')
            self.assertEqual(rc, 1, out + err)
            self.assertIn(start, out)
            for argv in (('call', 'valun_status'), ('mcp',), ('policy', 'show'), ('config', 'approvals', 'none')):
                rc, out, err = self.cli(*argv)
                self.assertEqual((rc, out), (1, ''), argv)
                self.assertIn(f'valun {argv[0]}: {start}', err)
                self.assertNotIn('Traceback', err)
            with open(self.path('default'), 'rb') as f:
                self.assertEqual(f.read(), raw, 'left as it is')


class EnrollNamesTheServersNetwork(Profiles):
    """`valun enroll` of a profile that names no network (a new one, or a join that stopped before the key was stored,
    whose recovery is this command) signs its enrollment for the network the server names, or for the one network when
    that cannot be read: the client's default is the pilot's, and the testnet server refuses that signature."""

    @staticmethod
    def enroll(client, body, token):
        """The testnet server's enroll: the statement it verifies names its own network."""
        msg = vc.statement('enroll', TESTNET_INFO['network'], body['participant_id'], body['pubkey'],
                           vc.sha256_hex(body['code'])).encode('utf-8')
        if not vb.verify(bytes.fromhex(body['signature']), msg, bytes.fromhex(body['pubkey'])):
            return vc.ValunError('bad_signature', 'proof-of-possession signature does not verify', 403)
        return {'participant_id': body['participant_id'], 'agent_token': 'vpa_NEW-test-only',
                'network': TESTNET_INFO['network']}

    def test_a_new_profile_enrolls_on_the_servers_network(self):
        self.server.answers['POST /pilot/v1/enroll'] = self.enroll
        enroll = ('enroll', '--participant', NEW_ID, '--server', SERVER, '--code-from-stdin')
        rc, out, _err = self.cli(*enroll, stdin='vpe_code\n')
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Enrolled {NEW_ID} on valun-testnet-1.', out)
        self.assertEqual((self.read('default')['network'], self.read('default')['participant_id']),
                         ('valun-testnet-1', NEW_ID))
        # the server's network cannot be read: the one network, never the retired pilot's, whose statement this server
        # refuses (the Nov 17 tester report: 0.7.1 signed for valun-pilot-1, and got a 403)
        self.server.answers['GET /pilot/v1/info'] = vc.ValunError('unreachable', 'cannot reach it')
        rc, out, _err = self.cli('--profile', 'other', *enroll, stdin='vpe_code\n')
        self.assertEqual(rc, 0, out)
        self.assertIn("network could not be read (GET /pilot/v1/info), so this enrollment is signed for valun-testnet-1, "
                      'the one network.', out)
        self.assertEqual(self.read('other')['network'], 'valun-testnet-1')


if __name__ == '__main__':
    unittest.main()
