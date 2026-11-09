"""The MCP server over real stdio pipes, as an MCP client sees it. No network: the agent is a fake (protocol tests)
or a real ValunAgent pointed at an unreachable address (secret-leak test, consent loop)."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
ORIGINAL_ORDER = ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond',
                  'valun_deliver', 'valun_review_delivery', 'valun_set_limits']

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
        self.assertEqual([t['name'] for t in listed], ORIGINAL_ORDER)        # still nine tools, in the original order
        tools = {t['name']: t for t in listed}
        self.assertEqual(len(tools), 9)
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
        s.send({'jsonrpc': '2.0', 'id': s.n, 'method': 'tools/call', 'params': {'name': 'valun_propose', 'arguments': {'price': 15}}})
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
        for answer in ({'action': 'decline'}, {'action': 'accept', 'content': {'approve': False}}, {'action': 'cancel'}):
            s = Session('ask')
            s.init(caps={'elicitation': {}})
            s.n += 1
            s.send({'jsonrpc': '2.0', 'id': s.n, 'method': 'tools/call',
                    'params': {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1', 'action': 'accept'}}})
            ask = s.recv()
            s.send({'jsonrpc': '2.0', 'id': ask['id'], 'result': answer})
            r = s.recv()['result']
            self.assertTrue(r['isError'], answer)
            self.assertEqual(r['structuredContent']['error'], 'owner_declined')
            self.assertNotIn('called', r['structuredContent'])
            s.close()

    def test_decline_is_not_a_commitment(self):
        s = Session('ask')
        s.init(caps={})
        r = s.request('tools/call', {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1', 'action': 'decline', 'reason': 'x'}})['result']
        self.assertFalse(r['isError'])
        s.close()

    def test_client_prompt_mode_flags_signing_tools(self):
        s = Session('client-prompt')
        s.init()
        tools = {t['name']: t for t in s.request('tools/list')['result']['tools']}
        for name in ('valun_propose', 'valun_respond', 'valun_review_delivery'):
            self.assertTrue(tools[name]['_meta']['anthropic/requiresUserInteraction'], name)
        self.assertNotIn('_meta', tools['valun_status'])
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
            for name, args in (('valun_status', {}), ('valun_inbox', {}), ('valun_deal', {'deal_id': 'vd_1'}),
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
            self.assertEqual(len(s.request('tools/list')['result']['tools']), 9)
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
