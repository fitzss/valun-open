"""The MCP server over real stdio pipes, as an MCP client sees it. No network: the agent is a fake (protocol tests)
or a real ValunAgent pointed at an unreachable address (secret-leak test, consent loop)."""
import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
sys.path.insert(0, SRC)
from valun import mcp_server as mcp  # noqa: E402
ORIGINAL_ORDER =['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond',
                  'valun_deliver', 'valun_review_delivery', 'valun_set_limits']
# 0.6 (fix inbox #18): the guarantee tools, appended after the original nine.
GUARANTEE_TOOLS = ['valun_guarantees', 'valun_offer_guarantee', 'valun_respond_guarantee', 'valun_call_guarantee']
# Budget cards: valun_check_payer (read only), after them.
CARD_TOOLS = ['valun_check_payer']

FAKE = textwrap.dedent('''
    import sys
    sys.path.insert(0, {src!r})
    from valun.mcp_server import McpServer
    from valun.agent import ValunAgent
    class Fake(ValunAgent):
        def __init__(self):
            super().__init__(store=None, approvals='test')
        def call(self, name, args=None):
            return {{'called': name, 'args': args or {{}}}}
        def is_commitment(self, name, args):
            return name in ('valun_propose', 'valun_review_delivery') or (name == 'valun_respond' and (args or {{}}).get('action') in ('accept', 'counter'))
        def describe_commitment(self, name, args):
            return 'Valun - sign a NEW OFFER to bea-briefs: price 15 PC'
        def prepare(self, name, args):
            return {{'args': dict(args or {{}}), 'text': self.describe_commitment(name, args)}}
    sys.exit(McpServer(Fake(), {mode!r}).serve())
''')


class Session:
    def __init__(self, mode='ask', script=None, env=None):
        code = script or FAKE.format(src=SRC, mode=mode)
        self.p = subprocess.Popen([sys.executable, '-I', '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=env)
        self.n = 0
        self.raw = []

    def send(self, msg):
        self.p.stdin.write((json.dumps(msg) + '\n').encode())
        self.p.stdin.flush()

    def recv(self):
        line = self.p.stdout.readline()
        self.raw.append(line)
        return json.loads(line)

    def request(self, method, params=None):
        self.n += 1
        self.send({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params or {}})
        return self.recv()

    def init(self, version='2025-06-18', caps=None):
        r = self.request('initialize', {'protocolVersion': version, 'capabilities': caps or {}, 'clientInfo': {'name': 'test', 'version': '0'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        return r

    def close(self):
        self.p.stdin.close()
        rc = self.p.wait(timeout=20)
        err = self.p.stderr.read()
        self.p.stdout.close()
        self.p.stderr.close()
        return rc, err


class Protocol(unittest.TestCase):
    def test_initialize_list_and_annotations(self):
        s = Session()
        r = s.init('2025-06-18')
        self.assertEqual(r['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(r['result']['serverInfo']['name'], 'valun')
        self.assertIn('tools', r['result']['capabilities'])
        listed = s.request('tools/list')['result']['tools']
        self.assertEqual([t['name'] for t in listed], ORIGINAL_ORDER + GUARANTEE_TOOLS + CARD_TOOLS)   # the nine, then the new ones
        tools = {t['name']: t for t in listed}
        self.assertEqual(len(tools), 14)
        self.assertTrue(tools['valun_guarantees']['annotations']['readOnlyHint'])
        self.assertEqual({k: tools['valun_check_payer']['annotations'][k] for k in ('readOnlyHint', 'destructiveHint', 'idempotentHint')},
                         {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True})
        self.assertEqual(tools['valun_check_payer']['inputSchema']['required'], ['payer', 'amount'])
        self.assertTrue(tools['valun_offer_guarantee']['annotations']['destructiveHint'])
        for t in listed:
            self.assertTrue(t['title'].startswith('Valun: '), t['name'])
            self.assertEqual(t['annotations']['title'], t['title'])
        self.assertEqual(list(tools['valun_review_delivery']['inputSchema']['properties'])[-1], 'pay_with')
        self.assertEqual(list(tools['valun_deliver']['inputSchema']['properties'])[-1], 'exact_result')
        self.assertTrue(tools['valun_status']['annotations']['readOnlyHint'])
        self.assertFalse(tools['valun_propose']['annotations']['readOnlyHint'])
        self.assertTrue(tools['valun_propose']['annotations']['destructiveHint'])
        self.assertEqual(tools['valun_deal']['inputSchema']['required'], ['deal_id'])
        self.assertEqual(s.request('ping')['result'], {})
        self.assertEqual(s.request('no/such')['error']['code'], -32601)
        s.close()

    def test_unknown_version_falls_back_and_old_version_has_no_structured_content(self):
        s = Session()
        self.assertEqual(s.init('1999-01-01')['result']['protocolVersion'], '2025-11-25')
        s.close()
        s = Session()
        s.init('2024-11-05')
        r = s.request('tools/call', {'name': 'valun_status', 'arguments': {}})['result']
        self.assertNotIn('structuredContent', r)
        self.assertEqual(json.loads(r['content'][0]['text'])['called'], 'valun_status')
        s.close()

    def test_read_tool_runs_without_asking(self):
        s = Session('ask')
        s.init()
        r = s.request('tools/call', {'name': 'valun_inbox', 'arguments': {}})['result']
        self.assertFalse(r['isError'])
        self.assertEqual(r['structuredContent']['called'], 'valun_inbox')
        s.close()

    def test_commitment_refused_when_client_cannot_ask(self):
        s = Session('ask')
        s.init(caps={})                                     # no elicitation capability
        r = s.request('tools/call', {'name': 'valun_propose', 'arguments': {'price': 15}})['result']
        self.assertTrue(r['isError'])
        self.assertEqual(r['structuredContent']['error'], 'approval_unavailable')
        self.assertNotIn('called', r['structuredContent'])  # nothing was signed
        s.close()

    def test_commitment_approved_through_elicitation(self):
        s = Session('ask')
        s.init(caps={'elicitation': {}})
        s.n += 1
        # complete arguments: an offer missing one is refused (bad_arguments) without asking the owner (fix inbox #58)
        offer = {'counterparty': 'bea-briefs', 'role': 'payer', 'title': 'Brief', 'description': 'A brief.', 'deliverable': 'Markdown',
                 'price': 15}
        s.send({'jsonrpc': '2.0', 'id': s.n, 'method': 'tools/call', 'params': {'name': 'valun_propose', 'arguments': offer}})
        ask = s.recv()
        self.assertEqual(ask['method'], 'elicitation/create')
        self.assertIn('NEW OFFER to bea-briefs', ask['params']['message'])
        self.assertEqual(ask['params']['requestedSchema']['required'], ['approve'])
        s.send({'jsonrpc': '2.0', 'method': 'notifications/progress', 'params': {}})      # interleaved traffic is tolerated
        s.send({'jsonrpc': '2.0', 'id': ask['id'], 'result': {'action': 'accept', 'content': {'approve': True}}})
        r = s.recv()
        self.assertEqual(r['id'], s.n)
        self.assertFalse(r['result']['isError'])
        self.assertEqual(r['result']['structuredContent']['called'], 'valun_propose')
        s.close()

    def test_commitment_declined_through_elicitation(self):
        for answer in ({'action': 'decline'}, {'action': 'accept', 'content': {'approve': False}}):
            s = Session('ask')
            s.init(caps={'elicitation': {}})
            s.n += 1
            s.send({'jsonrpc': '2.0', 'id': s.n, 'method': 'tools/call',
                    'params': {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1111111111111111', 'action': 'accept'}}})
            ask = s.recv()
            s.send({'jsonrpc': '2.0', 'id': ask['id'], 'result': answer})
            r = s.recv()['result']
            self.assertTrue(r['isError'], answer)
            self.assertEqual(r['structuredContent']['error'], 'owner_declined')
            self.assertNotIn('called', r['structuredContent'])
            s.close()

    def test_a_cancelled_or_dismissed_prompt_is_not_the_owners_refusal(self):
        # The Claude Code host test (2026-11-17): headless Claude Code answered the form cancel by itself, and 0.7.1 said
        # "your owner did not approve". A cancel, an error answer or an action of another kind is approval_cancelled:
        # nothing signed, nobody refused, and console approvals as the way for an app that cannot show the prompt.
        for answer, said in (({'result': {'action': 'cancel'}}, 'cancel'), ({'error': {'code': -32601, 'message': 'no'}}, 'error'),
                             ({'result': {'action': 'whatever'}}, 'unknown')):
            s = Session('ask')
            s.init(caps={'elicitation': {}})
            s.n += 1
            s.send({'jsonrpc': '2.0', 'id': s.n, 'method': 'tools/call',
                    'params': {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1111111111111111', 'action': 'accept'}}})
            ask = s.recv()
            s.send(dict({'jsonrpc': '2.0', 'id': ask['id']}, **answer))
            r = s.recv()['result']['structuredContent']
            self.assertEqual((r['error'], r['owner_answer']), ('approval_cancelled', said), answer)
            self.assertIn('nothing was signed', r['message'])
            self.assertIn("this is not your owner's refusal", r['what_this_means'])
            self.assertIn('config approvals console --owner-token-file FILE', r['what_this_means'])
            self.assertNotIn('called', r)
            s.close()
        # An app that declares no approval forms at initialize: valun_status's approvals text says so, and what to do.
        import types
        for caps, told in (({}, True), ({'elicitation': {}}, False)):
            agent = types.SimpleNamespace(approvals=mcp.APPROVAL_TEXT['ask'])
            mcp.McpServer(agent, 'ask', command='valun --profile p').initialize({'capabilities': caps})
            self.assertEqual(agent.approvals == mcp.ASK_WITHOUT_FORMS.format(command='valun --profile p'), told, caps)
        agent = types.SimpleNamespace(approvals=mcp.APPROVAL_TEXT['console'])
        mcp.McpServer(agent, 'console').initialize({'capabilities': {}})
        self.assertEqual(agent.approvals, mcp.APPROVAL_TEXT['console'], 'only ask needs the forms')
        self.assertIn('`valun --profile p config approvals console --owner-token-file FILE`',
                      mcp.ASK_WITHOUT_FORMS.format(command='valun --profile p'))
        words = mcp.approval_cancelled('uvx --from valun==9.9.9 valun --profile p', 'https://valun.example/')
        self.assertIn('your owner can hold what you sign in the owner console (https://valun.example/pilot#owner) instead '
                      '(your offers, acceptances and guarantee offers, and the note or payment at each delivery): `uvx --from '
                      'valun==9.9.9 valun --profile p config approvals console --owner-token-file FILE`', words['what_this_means'])
        self.assertNotIn('every commitment', words['what_this_means'])

    def test_decline_is_not_a_commitment(self):
        s = Session('ask')
        s.init(caps={})
        r = s.request('tools/call', {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1111111111111111', 'action': 'decline', 'reason': 'x'}})['result']
        self.assertFalse(r['isError'])
        s.close()

    def test_client_prompt_mode_flags_signing_tools(self):
        s = Session('client-prompt')
        s.init()
        tools = {t['name']: t for t in s.request('tools/list')['result']['tools']}
        for name in ('valun_propose', 'valun_respond', 'valun_review_delivery'):
            self.assertTrue(tools[name]['_meta']['anthropic/requiresUserInteraction'], name)
        self.assertNotIn('_meta', tools['valun_status'])
        # audit AI-4: a loosening valun_set_limits is a commitment for the core (and `valun call` asks for it): the app
        # is asked to confirm every call of it, and it is marked destructive, in this mode only
        self.assertTrue(tools['valun_set_limits']['_meta']['anthropic/requiresUserInteraction'])
        self.assertTrue(tools['valun_set_limits']['annotations']['destructiveHint'])
        from valun import mcp_server
        self.assertFalse({t['name']: t for t in mcp_server.tool_list('ask')}['valun_set_limits']['annotations']['destructiveHint'])
        s.close()
        s = Session('none')
        s.init()
        self.assertFalse(any('_meta' in t for t in s.request('tools/list')['result']['tools']))   # owner chose autonomy
        s.close()

    def test_other_modes_do_not_ask(self):
        for mode in ('none', 'console', 'client-prompt'):
            s = Session(mode)
            s.init(caps={'elicitation': {}})
            r = s.request('tools/call', {'name': 'valun_propose', 'arguments': {}})
            self.assertNotIn('method', r, mode)             # no elicitation request was sent
            self.assertEqual(r['result']['structuredContent']['called'], 'valun_propose')
            s.close()

    def test_bad_json_line_gets_parse_error_and_server_keeps_going(self):
        s = Session()
        s.p.stdin.write(b'{not json\n')
        s.p.stdin.flush()
        self.assertEqual(s.recv()['error']['code'], -32700)
        self.assertEqual(s.init()['result']['serverInfo']['name'], 'valun')
        s.close()


WAIT_FAKE = textwrap.dedent('''
    import sys
    sys.path.insert(0, {src!r})
    from valun.mcp_server import McpServer
    from valun.agent import ValunAgent
    class Fake(ValunAgent):
        def __init__(self):
            super().__init__(store=None, approvals='test')
        def call(self, name, args=None):
            print('signed' if name == 'valun_propose' else 'ran', name, file=sys.stderr, flush=True)
            return {{'called': name, 'args': args or {{}}}}
        def is_commitment(self, name, args):
            return name == 'valun_propose'
        def prepare(self, name, args):
            return {{'args': dict(args or {{}}), 'text': 'Valun - sign a NEW OFFER to bea-briefs: price 15 PC'}}
    server = McpServer(Fake(), 'ask')
    server.approval_wait_s = {wait!r}
    sys.exit(server.serve())
''')
OFFER = {'counterparty': 'bea-briefs', 'role': 'payer', 'title': 'Brief', 'description': 'A brief.', 'deliverable': 'Markdown',
         'price': 15}
MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}}


def tool_call(mid, name, args, meta=None):
    params = {'name': name, 'arguments': args}
    if meta:
        params['_meta'] = meta
    return {'jsonrpc': '2.0', 'id': mid, 'method': 'tools/call', 'params': params}


def cancel(mid, reason='timed out'):
    return {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': mid, 'reason': reason}}


class Wire(Session):
    """A Session whose server output is read on a thread of its own (with os.read: a thread left in a buffered read
    must not outlive the test run), so that each answer is awaited with a time limit: an answer that does not come
    fails the test instead of hanging it. The server's stderr says what its fake agent ran or signed."""

    def __init__(self, wait=60.0):
        super().__init__(script=WAIT_FAKE.format(src=SRC, wait=wait))
        self.got = queue.Queue()
        self.seen = []
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()

    def _pump(self):
        fd, rest = self.p.stdout.fileno(), b''
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                self.got.put(None)
                return
            *lines, rest = (rest + chunk).split(b'\n')
            for line in lines:
                if line.strip():
                    m = json.loads(line)
                    self.seen.append(m)
                    self.got.put(m)

    def recv(self, timeout=5.0):
        try:
            m = self.got.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f'the server sent nothing within {timeout} s') from None
        if m is None:
            raise AssertionError('the server closed its output')
        return m

    def close(self):
        self.p.stdin.close()
        rc = self.p.wait(timeout=20)
        self.reader.join(10)
        err = self.p.stderr.read().decode()
        self.p.stdout.close()
        self.p.stderr.close()
        return rc, err

    def kill(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait(timeout=20)
        self.reader.join(10)
        for f in (self.p.stdin, self.p.stdout, self.p.stderr):
            with contextlib.suppress(Exception):
                f.close()


class ApprovalWait(unittest.TestCase):
    """Fix inbox #149 (the first-tester readiness assessment of 2026-11-18, a scripted host on the official MCP SDK): in
    ask mode, on a host with the 2025-11-25 (or an earlier) handshake, one approval form left open or abandoned froze
    every Valun tool until the app restarted: ask_owner queued every other message until the form's answer came, and
    ignored the host's notifications/cancelled. While a form waits, ping and the read-only tools are answered at once,
    the host's cancel of the call ends the wait (approval_cancelled, nothing signed), and the wait gives up by itself
    after approval_wait_s (10 minutes). The 2026-07-28 path never waits: its approval is a result, input_required."""

    def wire(self, wait=60.0):
        s = Wire(wait)
        self.addCleanup(s.kill)
        return s

    def test_a_form_left_open_freezes_nothing_and_the_apps_cancel_signs_nothing(self):
        s = self.wire()
        s.init('2025-11-25', caps={'elicitation': {}})
        s.send(tool_call(2, 'valun_propose', OFFER))
        ask = s.recv()
        self.assertEqual((ask['method'], ask['id']), ('elicitation/create', 'valun-approval-1'))
        # the form stays open: valun_status, ping, tools/list and valun_inbox are answered at once (0.7.1: none was)
        s.send(tool_call(3, 'valun_status', {'brief': True}))
        r = s.recv()
        self.assertEqual((r['id'], r['result']['structuredContent']['called']), (3, 'valun_status'))
        s.send({'jsonrpc': '2.0', 'id': 4, 'method': 'ping'})
        self.assertEqual(s.recv(), {'jsonrpc': '2.0', 'id': 4, 'result': {}})
        s.send({'jsonrpc': '2.0', 'id': 5, 'method': 'tools/list'})
        self.assertEqual(len(s.recv()['result']['tools']), 14)
        s.send(tool_call(6, 'valun_inbox', {}))
        self.assertEqual(s.recv()['result']['structuredContent']['called'], 'valun_inbox')
        # a call that is not read-only still waits its turn, and is dropped when the app cancels it: never run
        s.send(tool_call(7, 'valun_deliver', {'deal_id': 'vd_1111111111111111', 'content': 'x'}))
        s.send(cancel(7))
        # the app cancels the call that asks (its own timeout, the assessment's 12 s): the form is withdrawn, and the
        # call answers approval_cancelled, nothing signed (0.7.1 waited for the end of input, then said owner_declined)
        s.send(cancel(2, 'timed out after 12.0s'))
        self.assertEqual(s.recv(), {'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                    'params': {'requestId': 'valun-approval-1', 'reason': 'the call was cancelled'}})
        r = s.recv()
        sc = r['result']['structuredContent']
        self.assertEqual((r['id'], r['result']['isError'], sc['error'], sc['owner_answer']), (2, True, 'approval_cancelled', 'none'))
        self.assertEqual(sc['message'], 'this app cancelled the call before anyone answered its approval prompt: nothing '
                                        'was signed')
        self.assertIn("this is not your owner's refusal", sc['what_this_means'])
        # an approval of the withdrawn form that still comes signs nothing, and the next call is answered as usual
        s.send({'jsonrpc': '2.0', 'id': 'valun-approval-1', 'result': {'action': 'accept', 'content': {'approve': True}}})
        s.send(tool_call(8, 'valun_status', {}))
        r = s.recv()
        self.assertEqual((r['id'], r['result']['structuredContent']['called']), (8, 'valun_status'))
        rc, err = s.close()
        self.assertEqual(rc, 0)
        self.assertEqual(err.split(), ['ran', 'valun_status', 'ran', 'valun_inbox', 'ran', 'valun_status'])   # nothing signed
        self.assertEqual([m.get('id') for m in s.seen if 'result' in m], [1, 3, 4, 5, 6, 2, 8], 'the cancelled 7: no answer')

    def test_a_form_nobody_answers_is_withdrawn_after_the_wait(self):
        s = self.wire(wait=0.5)
        s.init('2025-11-25', caps={'elicitation': {}})
        start = time.monotonic()
        s.send(tool_call(2, 'valun_propose', OFFER))
        ask = s.recv()
        # the app sends nothing more: the server gives up by itself, withdraws the form and answers the call
        withdrawn = s.recv(10)
        self.assertGreater(time.monotonic() - start, 0.4)        # after the wait (a timer may wake a little early)
        self.assertEqual(withdrawn, {'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                     'params': {'requestId': ask['id'], 'reason': 'no answer within 0.5 seconds'}})
        r = s.recv()
        sc = r['result']['structuredContent']
        self.assertEqual((r['id'], sc['error'], sc['owner_answer']), (2, 'approval_cancelled', 'none'))
        self.assertEqual(sc['message'], 'nobody answered the approval prompt within 0.5 seconds, so it was withdrawn: '
                                        'nothing was signed')
        # an approval that comes later signs nothing; the next call is answered as usual
        s.send({'jsonrpc': '2.0', 'id': ask['id'], 'result': {'action': 'accept', 'content': {'approve': True}}})
        s.send(tool_call(3, 'valun_status', {}))
        r = s.recv()
        self.assertEqual((r['id'], r['result']['structuredContent']['called']), (3, 'valun_status'))
        s.send(cancel(2))                                # the app's own timeout, later: nothing more to answer
        s.send({'jsonrpc': '2.0', 'id': 4, 'method': 'ping'})
        self.assertEqual(s.recv()['id'], 4)
        rc, err = s.close()
        self.assertEqual((rc, err.split()), (0, ['ran', 'valun_status']))
        self.assertEqual([m.get('id') for m in s.seen if 'result' in m], [1, 2, 3, 4])
        self.assertEqual(mcp.APPROVAL_WAIT_S, 600, '10 minutes: as long as a 2026-07-28 approval stays valid')
        self.assertEqual(mcp.APPROVAL_WAIT_S, mcp.APPROVAL_STATE_TTL_S)

    def test_an_answered_form_still_signs_once(self):
        # the wait's other ends, as before: an approval signs once; the end of input is approval_cancelled
        s = self.wire()
        s.init('2025-11-25', caps={'elicitation': {}})
        s.send(tool_call(2, 'valun_propose', OFFER))
        ask = s.recv()
        s.send(tool_call(3, 'valun_deliver', {'deal_id': 'vd_1111111111111111', 'content': 'x'}))   # waits its turn
        s.send({'jsonrpc': '2.0', 'id': ask['id'], 'result': {'action': 'accept', 'content': {'approve': True}}})
        r = s.recv()
        self.assertEqual((r['id'], r['result']['structuredContent']['called']), (2, 'valun_propose'))
        self.assertEqual(s.recv()['id'], 3)
        s.send(tool_call(4, 'valun_propose', OFFER))
        s.recv()                                         # the second form; the app then closes
        rc, err = s.close()
        self.assertEqual(rc, 0)
        last = s.seen[-1]['result']['structuredContent']
        self.assertEqual((s.seen[-1]['id'], last['error'], last['owner_answer']), (4, 'approval_cancelled', 'none'))
        self.assertEqual(err.split(), ['signed', 'valun_propose', 'ran', 'valun_deliver'])

    def test_the_2026_07_28_path_never_waits(self):
        # The approval is a result (input_required) the host answers by calling again: nothing waits, a call the host
        # abandons signs nothing, and its cancel needs no answer. A late answer is asked again (APPROVAL_STATE_TTL_S:
        # Adapters.test_a_2026_07_28_approval_is_used_once_and_only_while_fresh).
        s = self.wire()
        s.send(tool_call(2, 'valun_propose', OFFER, MODERN))
        r = s.recv()['result']
        self.assertEqual((r['resultType'], list(r['inputRequests'])), ('input_required', ['approval']))
        s.send(tool_call(3, 'valun_status', {}, MODERN))
        r = s.recv()
        self.assertEqual((r['id'], r['result']['resultType'], r['result']['structuredContent']['called']),
                         (3, 'complete', 'valun_status'))
        s.send(cancel(2))
        s.send({'jsonrpc': '2.0', 'id': 4, 'method': 'ping', 'params': {'_meta': MODERN}})
        self.assertEqual(s.recv(), {'jsonrpc': '2.0', 'id': 4, 'result': {}})
        rc, err = s.close()
        self.assertEqual((rc, err.split()), (0, ['ran', 'valun_status']))


class NoSecretsLeak(unittest.TestCase):
    def test_real_agent_never_prints_key_or_token(self):
        secret, token = 'ab' * 32, 'vpa_' + 'Z' * 40
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'p.json')
            with open(path, 'w') as f:
                json.dump({'server': 'http://127.0.0.1:9', 'participant_id': 'vp_000000000000', 'secret': secret,
                           'agent_token': token, 'approvals': 'ask'}, f)
            script = f'import sys; sys.path.insert(0, {SRC!r}); from valun import client, mcp_server; ' \
                     f'sys.exit(mcp_server.run(client.FileStore({path!r}), approvals="none"))'
            s = Session(script=script)
            s.init()
            for name, args in (('valun_status', {}), ('valun_inbox', {}), ('valun_deal', {'deal_id': 'vd_1111111111111111'}),
                               ('valun_propose', {'counterparty': 'x', 'role': 'payer', 'title': 't', 'description': 'd',
                                                  'deliverable': 'x', 'price': 1})):
                r = s.request('tools/call', {'name': name, 'arguments': args})['result']
                self.assertTrue(r['isError'])
                self.assertEqual(r['structuredContent']['error'], 'unreachable', name)
            rc, err = s.close()
            everything = b''.join(s.raw) + err
            self.assertNotIn(secret.encode(), everything)
            self.assertNotIn(token.encode(), everything)
            self.assertNotIn(b'Z' * 20, everything)


class ConsentLoop(unittest.TestCase):
    """The optional consent loop (design 6.6): it runs only while the profile's consent_loop is 'on', every agent call
    it makes holds the process-wide STORE_LOCK, and it never writes to stdout (which carries JSON-RPC only)."""

    def setUp(self):
        sys.path.insert(0, SRC)
        from valun import mcp_server
        self.mcp = mcp_server

    def held_elsewhere(self):
        """Is STORE_LOCK held (by the calling thread)? Asked from another thread, which can then not take it."""
        got = []

        def probe():
            ok = self.mcp.STORE_LOCK.acquire(blocking=False)
            got.append(ok)
            if ok:
                self.mcp.STORE_LOCK.release()     # an RLock is released by the thread that holds it
        t = threading.Thread(target=probe)
        t.start()
        t.join()
        return not got[0]

    def fake_agent(self, loop='on'):
        test, calls = self, []

        class Store:
            state = {'consent_loop': loop}

            def reload(self):
                pass

        class Agent:
            store = Store()
            handlers = {}

            def consents_if_due(self):
                calls.append(test.held_elsewhere())
                return None
        return Agent(), calls

    def test_the_loop_holds_the_lock_and_stops(self):
        agent, calls = self.fake_agent()
        loop = self.mcp.ConsentLoop(agent, interval_s=0.01, jitter_s=0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            loop.start()
            deadline = time.time() + 5
            while len(calls) < 3 and time.time() < deadline:
                time.sleep(0.01)
            loop.stop()
            loop.join(5)
        self.assertGreaterEqual(len(calls), 3)
        self.assertTrue(all(calls))                       # every run held STORE_LOCK
        self.assertEqual(out.getvalue(), '')              # and wrote nothing to stdout
        self.assertFalse(loop.is_alive())
        agent, calls = self.fake_agent(loop='off')
        loop = self.mcp.ConsentLoop(agent, interval_s=0.01, jitter_s=0)
        for _ in range(3):
            loop.run_once()
        self.assertEqual((calls, loop.runs), ([], 0))     # consent_loop off: nothing runs

    def test_tool_calls_hold_the_lock_too(self):
        test, seen = self, []
        from valun.agent import ValunAgent

        class Agent(ValunAgent):
            def __init__(self):
                super().__init__(store=None)

            def call(self, name, args=None):
                seen.append(test.held_elsewhere())
                return {'ok': True}

            def is_commitment(self, name, args):
                seen.append(test.held_elsewhere())
                return False
        s = self.mcp.McpServer(Agent(), 'ask', inp=io.BytesIO(b''), out=io.BytesIO(), log=io.StringIO())
        s.call('valun_status', {})
        s.call_modern({'name': 'valun_status', 'arguments': {}}, {})
        self.assertEqual(seen, [True] * 4)
        self.assertFalse(self.held_elsewhere())          # and released afterwards

    def test_a_real_server_with_the_loop_on_writes_only_json_rpc(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'p.json')
            with open(path, 'w') as f:
                json.dump({'server': 'http://127.0.0.1:9', 'participant_id': 'vp_000000000000', 'secret': 'ab' * 32,
                           'agent_token': 'vpa_' + 'Z' * 40, 'approvals': 'ask', 'consent_loop': 'on',
                           'consent_policy': {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 50}}, f)
            script = (f'import sys; sys.path.insert(0, {SRC!r}); from valun import client, mcp_server; '
                      f'sys.exit(mcp_server.run(client.FileStore({path!r}), approvals="ask", consent_loop_s=0.05, '
                      f'consent_loop_jitter_s=0))')
            s = Session(script=script)
            s.init()
            self.assertEqual(len(s.request('tools/list')['result']['tools']), 14)
            deadline = time.time() + 10
            while time.time() < deadline:                 # the loop's first run marks the profile (it cannot reach the server)
                with open(path, encoding='utf-8') as f:
                    if 'consents_last_run_ms' in json.load(f):
                        break
                time.sleep(0.05)
            r = s.request('tools/call', {'name': 'valun_status', 'arguments': {}})['result']
            self.assertEqual(r['structuredContent']['error'], 'unreachable')
            rc, err = s.close()
            with open(path, encoding='utf-8') as f:
                self.assertIn('consents_last_run_ms', json.load(f))   # only the loop runs consents here (status is read-only)
            for line in s.raw:
                if line.strip():
                    m = json.loads(line)
                    self.assertEqual(m.get('jsonrpc'), '2.0')
                    self.assertIn(m.get('id'), (1, 2, 3))       # answers to our requests only: nothing else on stdout
            self.assertNotIn(b'Z' * 20, b''.join(s.raw) + err)


class SetupHint(unittest.TestCase):
    """What the tools tell the agent while its profile is not joined: mcp_server.run's setup_hint (FX3-PY item 5:
    `valun --profile NAME mcp` passes one that names the profile; without one it stays as in 0.3)."""

    def serve_with(self, **kw):
        sys.path.insert(0, SRC)
        from unittest import mock
        from valun import client, mcp_server
        seen = {}

        def serve(server):
            seen['hint'] = server.agent.setup_hint
            seen['status'] = server.call('valun_status', {})        # the tool result while not joined
            return 0
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'p.json')
            with open(path, 'w') as f:
                json.dump({'server': 'http://127.0.0.1:9'}, f)     # not joined: no participant, key or token
            with mock.patch.object(mcp_server.McpServer, 'serve', serve):
                rc = mcp_server.run(client.FileStore(path), approvals='ask', **kw)
        self.assertEqual(rc, 0)
        return seen

    def test_the_default_hint_is_unchanged(self):
        seen = self.serve_with()
        self.assertEqual(seen['hint'], 'run `valun join` in a terminal')

    def test_a_given_hint_reaches_the_tools(self):
        seen = self.serve_with(setup_hint='run `valun --profile work join` in a terminal')
        self.assertEqual(seen['hint'], 'run `valun --profile work join` in a terminal')
        self.assertIn('`valun --profile work join`', json.dumps(seen['status']))


if __name__ == '__main__':
    unittest.main()
