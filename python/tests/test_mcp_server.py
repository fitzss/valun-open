"""The MCP server over real stdio pipes, as an MCP client sees it. No network: the agent is a fake (protocol tests)
or a real ValunAgent pointed at an unreachable address (secret-leak test)."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')

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
        tools = {t['name']: t for t in s.request('tools/list')['result']['tools']}
        self.assertEqual(len(tools), 9)
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


if __name__ == '__main__':
    unittest.main()
