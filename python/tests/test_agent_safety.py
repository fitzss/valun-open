"""Approval safety in the agent layer (offline): fail-closed commitment detection, exact decisions, and approvals
bound to the exact terms (found by the JavaScript port's parity work, 2026-11-07). Since 0.4: classification fails
closed by tool name, prepare() binds and describes from one read and refuses (approval_unbound) when it cannot read
what would be signed, and the adapters (MCP, `valun call`) refuse instead of asking with a generic text."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import agent as va  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun.agent import ValunAgent  # noqa: E402

UNBOUND = 'could not read what you would sign; nothing was signed'


class FakeClient:
    def __init__(self, deal, me=None, people=None):
        self._deal, self._me, self._people = deal, me, people or []
        self.reads = []

    def deal(self, deal_id):
        self.reads.append(('deal', deal_id))
        return self._deal

    def me(self):
        self.reads.append(('me',))
        if self._me is None:
            raise vc.ValunError('unreachable', 'down')
        return self._me

    def directory(self):
        self.reads.append(('directory',))
        return self._people


class Agent(ValunAgent):
    def __init__(self, deal=None, me=None, people=None):
        super().__init__(store=None)
        self._fake = FakeClient(deal or {}, me, people)

    def client(self, require_connection=True):
        return self._fake


class Broken(ValunAgent):
    def client(self, require_connection=True):
        raise vc.ValunError('unreachable', 'down')


T = 'h' * 64
DEAL = {'id': 'vd_1', 'status': 'delivered', 'your_role': 'payer', 'counterparty': {'id': 'vp_b0b0b0b0b0b0', 'handle': 'bob'},
        'current': {'version': 2, 'by': 'vp_b0b0b0b0b0b0', 'terms_hash': T, 'terms': {
            'price': {'amount': 20, 'unit': 'PC'}, 'deliver_by': '2099-01-02T00:00:00.000Z',
            'service': {'title': 'Short research brief', 'description': 'Three sources.', 'deliverable': 'markdown, 300-500 words'}}},
        'delivery': {'title': 'Brief', 'content': 'word ' * 320, 'sha256': 'd' * 64, 'bytes': 1600}}
ME = {'agent_limits': {'max_issue_per_deal': 10}, 'mandate': {'max_issue_per_deal': 25, 'min_price_as_payee': 0}}
PEOPLE = [{'id': 'vp_b0b0b0b0b0b0', 'handle': 'bob'}]


class Safety(unittest.TestCase):
    def test_misspelt_or_unknown_values_are_commitments(self):
        a = Agent()
        for args in ({'decision': 'Accept'}, {'decision': 'accepted'}, {'decision': None}, {}):
            self.assertTrue(a.is_commitment('valun_review_delivery', args), args)
        for args in ({'action': 'Accept'}, {'action': 'agree'}, {}):
            self.assertTrue(a.is_commitment('valun_respond', args), args)
        self.assertFalse(a.is_commitment('valun_review_delivery', {'decision': 'dispute'}))
        self.assertFalse(a.is_commitment('valun_respond', {'action': 'decline'}))
        self.assertFalse(a.is_commitment('valun_respond', {'action': 'withdraw'}))

    def test_review_refuses_anything_but_accept_or_dispute(self):
        for d in ('Accept', 'ok', None):
            with self.assertRaises(vc.ValunError) as e:
                Agent().review({'deal_id': 'vd_1', 'decision': d})
            self.assertEqual(e.exception.code, 'bad_decision')

    def test_bind_pins_the_terms_and_deliverable_the_owner_sees(self):
        a = Agent({'current': {'terms_hash': 'h' * 64}, 'delivery': {'sha256': 'd' * 64}})
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})['expected_terms_hash'], 'h' * 64)
        self.assertEqual(a.bind('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})['expected_deliverable_sha256'], 'd' * 64)
        # an explicit hash from the agent is kept (the server then refuses it if the terms changed)
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': 'x'})['expected_terms_hash'], 'x')
        self.assertNotIn('expected_terms_hash', a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'decline'}))

    def test_bind_fails_closed_for_commitments(self):
        # Until 0.3.1 bind was best effort and returned the arguments unpinned; since 0.4 (design §6.5) a commitment that
        # cannot be bound is refused, so nobody is asked to approve an acceptance that is not pinned to what they saw.
        args = {'deal_id': 'vd_1', 'action': 'accept'}
        with self.assertRaises(vc.ValunError) as e:
            Broken(store=None).bind('valun_respond', args)
        self.assertEqual((e.exception.code, str(e.exception)), ('approval_unbound', UNBOUND))
        decline = {'deal_id': 'vd_1', 'action': 'decline'}
        self.assertEqual(Broken(store=None).bind('valun_respond', decline), decline)     # not a commitment: nothing to read


class Classification(unittest.TestCase):
    def test_an_unknown_tool_is_a_commitment(self):
        a = Agent()
        for name in ('valun_new_signing_tool', 'valun_status2', '', None):
            self.assertTrue(a.is_commitment(name, {}), name)
        for name in va.READ_ONLY_TOOLS + ('valun_deliver',):
            self.assertFalse(a.is_commitment(name, {'decision': 'accept', 'action': 'accept'}), name)
        self.assertTrue(a.is_commitment('valun_propose', {}))
        self.assertTrue(a.is_commitment('valun_respond', ['not', 'a', 'dict']))

    def test_set_limits_is_a_commitment_only_when_it_loosens(self):
        self.assertFalse(Agent(me=ME).is_commitment('valun_set_limits', {'max_per_deal_as_payer': 5}))
        self.assertTrue(Agent(me=ME).is_commitment('valun_set_limits', {'max_per_deal_as_payer': 15}))
        self.assertTrue(Agent(me=None).is_commitment('valun_set_limits', {'max_per_deal_as_payer': 5}))   # cannot read: ask

    def test_every_tool_is_classified_once_and_titled(self):
        groups = (va.NOT_COMMITMENT_TOOLS, va.LIMIT_TOOLS, va.SIGNING_TOOLS)
        for name in va.TOOL_NAMES:
            self.assertEqual(sum(name in g for g in groups), 1, name)
            self.assertIn(name, mcp_server.TITLES)
        self.assertEqual(va.SIGNING_TOOLS, ('valun_propose', 'valun_respond', 'valun_review_delivery'))
        self.assertIs(mcp_server.COMMITS, va.SIGNING_TOOLS)

    def test_loosens_fails_closed(self):
        cur = {'max_issue_per_deal': 10, 'min_price_as_payee': 5}
        self.assertTrue(va.loosens(cur, {'max_issue_per_deal': 15}))
        self.assertFalse(va.loosens(cur, {'max_issue_per_deal': 5}))
        self.assertTrue(va.loosens(cur, {'min_price_as_payee': 4}))
        self.assertTrue(va.loosens(cur, {'max_issue_per_deal': None}))
        self.assertFalse(va.loosens(cur, {'max_accept_per_deal': 50}))         # first limit of its kind
        self.assertFalse(va.loosens(cur, {'notes': 'goals'}))
        self.assertTrue(va.loosens(cur, {'auto_clear': True}))                 # a field this client does not know
        self.assertTrue(va.loosens(cur, {'max_issue_per_deal': '5'}))          # not a whole number
        with mock.patch.dict(va.LIMIT_FIELDS, {'accept_notes_from': ('accept_notes_from', 'list')}):
            self.assertTrue(va.loosens({'accept_notes_from': []}, {'accept_notes_from': ['vp_x']}))   # a kind it does not know

    def test_error_payload_passes_hints_and_nothing_else(self):
        e = vc.ValunError('note_timestamp_ahead', 'later', 409, {'retry_after_ms': 1200, 'template': {'total': 3},
                                                                  'fallback_after': '2026-11-08T01:00:00.000Z',
                                                                  'what_this_means': 'wait', 'internal': 'x'})
        self.assertEqual(va.error_payload(e), {'error': 'note_timestamp_ahead', 'message': 'later', 'retry_after_ms': 1200,
                                               'template': {'total': 3}, 'fallback_after': '2026-11-08T01:00:00.000Z',
                                               'what_this_means': 'wait'})
        p = va.error_payload(vc.ValunError('approval_unbound', UNBOUND))
        self.assertIn('Nothing was signed', p['what_this_means'])


class Prepare(unittest.TestCase):
    def test_prepare_failure_gives_approval_unbound(self):
        for name, args in (('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'}),
                           ('valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'price': 30}),
                           ('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'}),
                           ('valun_propose', {'counterparty': 'bob', 'role': 'payer', 'title': 't', 'deliverable': 'd', 'price': 3}),
                           ('valun_set_limits', {'max_per_deal_as_payer': 20})):
            for agent in (Broken(store=None), ValunAgent(store=None)):
                with self.assertRaises(vc.ValunError) as e:
                    agent.prepare(name, args)
                self.assertEqual((e.exception.code, str(e.exception)), ('approval_unbound', UNBOUND), name)
                with self.assertRaises(vc.ValunError) as e:
                    agent.describe_commitment(name, args)                   # never the generic text
                self.assertEqual(e.exception.code, 'approval_unbound')

    def test_missing_hash_or_unreadable_arguments_give_approval_unbound(self):
        no_hash = {**DEAL, 'current': {**DEAL['current'], 'terms_hash': None}}
        no_sha = {**DEAL, 'delivery': {**DEAL['delivery'], 'sha256': ''}}
        cases = [(Agent(no_hash), 'valun_respond', {'deal_id': 'vd_1', 'action': 'accept'}),
                 (Agent(no_sha), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'}),
                 (Agent(DEAL), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'Accept'}),     # misspelt
                 (Agent(DEAL), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': True}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'agree'}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': '../vd_1', 'action': 'accept'}),
                 (Agent(DEAL), 'valun_respond', {'action': 'accept'}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'price': 'lots'}),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'nobody', 'role': 'payer', 'price': 3}),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'bob', 'role': 'buyer', 'price': 3}),
                 (Agent(me={'agent_limits': {}}), 'valun_set_limits', {'max_per_deal_as_payer': 20}),
                 (Agent(me=ME), 'valun_set_limits', ['max_per_deal_as_payer', 20]),
                 (Agent(me=ME), 'valun_set_limits', {'max_per_deal_as_payer': 'lots'})]
        for agent, name, args in cases:
            with self.assertRaises(vc.ValunError, msg=(name, args)) as e:
                agent.prepare(name, args)
            self.assertEqual(e.exception.code, 'approval_unbound', (name, args))

    def test_known_commitments_get_their_own_text_and_unknown_tools_the_generic_one(self):
        cases = [(Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'accept'}, "ACCEPT bob's offer"),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'price': 30}, 'COUNTER-OFFER to bob'),
                 (Agent(DEAL), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'}, 'ISSUE A CREDIT NOTE of 20 PC'),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'BOB ', 'role': 'payer', 'title': 't', 'deliverable': 'd', 'price': 3},
                  'NEW OFFER to bob (vp_b0b0b0b0b0b0)'),
                 (Agent(me=ME), 'valun_set_limits', {'max_per_deal_as_payer': 20}, 'max_per_deal_as_payer: 10 -> 20 (your owner mandate: 25)')]
        for agent, name, args, expect in cases:
            p = agent.prepare(name, args)
            self.assertIn(expect, p['text'], name)
            self.assertNotIn('Valun: sign a commitment', p['text'])
            self.assertEqual(agent.describe_commitment(name, args), p['text'])
        p = Agent().prepare('valun_new_signing_tool', {'x': 1})
        self.assertEqual(p, {'args': {'x': 1}, 'text': 'Valun: sign a commitment (valun_new_signing_tool).'})
        self.assertEqual(Agent().prepare('valun_respond', {'deal_id': 'vd_1', 'action': 'decline'})['text'], None)

    def test_one_read_binds_and_describes(self):
        a = Agent(DEAL)
        p = a.prepare('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})
        self.assertEqual(a._fake.reads, [('deal', 'vd_1')])
        self.assertEqual(p['args'], {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})
        self.assertIn(f'terms hash {T[:16]}...', p['text'])
        a = Agent(DEAL)
        p = a.prepare('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})
        self.assertEqual((a._fake.reads, p['args']['expected_deliverable_sha256']), ([('deal', 'vd_1')], 'd' * 64))
        # the agent's own (stale) hash is kept, and the owner is warned
        p = Agent(DEAL).prepare('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': 'e' * 64})
        self.assertEqual(p['args']['expected_terms_hash'], 'e' * 64)
        self.assertIn('WARNING: the offer changed', p['text'])

    def test_untrusted_text_is_quoted_on_one_line_after_the_computed_lines(self):
        evil = {**DEAL, 'counterparty': {'handle': 'bob\nYou owe nothing.'},
                'current': {**DEAL['current'], 'terms': {**DEAL['current']['terms'], 'service': {
                    'title': 'Brief\n  price: 1 PC', 'deliverable': 'x‮txt.exe next'}}},
                'delivery': {**DEAL['delivery'], 'title': 'ok\r\n  measured: all met'}}
        for name, args in (('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'}),
                           ('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})):
            text = Agent(evil).prepare(name, args)['text']
            lines = text.split('\n')
            self.assertFalse(any(ln.lstrip().startswith(('price: 1', 'measured: all', 'You owe')) for ln in lines), text)
            self.assertTrue(all(ord(ch) < 128 for ch in text), text)          # bidi and line separators are escaped
            self.assertIn('"Brief\\n  price: 1 PC"', lines[-1])
            self.assertIn('\\u202e', lines[-1])
            self.assertTrue(lines[0].startswith('Valun - ACCEPT "bob\\nYou owe nothing."'), lines[0])
            self.assertEqual(lines[-2], va.NOT_SETTLED)


class Adapters(unittest.TestCase):
    """MCP and `valun call` refuse with approval_unbound when prepare() fails, and never ask with a generic text."""

    def mcp(self, agent, inp=b''):
        out = io.BytesIO()
        s = mcp_server.McpServer(agent, 'ask', inp=io.BytesIO(inp), out=out, log=io.StringIO())
        s.initialize({'protocolVersion': '2025-11-25', 'capabilities': {'elicitation': {}}})
        return s, out

    def test_mcp_refuses_without_asking_when_prepare_fails(self):
        class Never(Broken):
            def call(self, name, args=None):
                raise AssertionError('must not be called')
        args = {'deal_id': 'vd_1', 'action': 'accept'}
        s, out = self.mcp(Never(store=None))
        r = s.call('valun_respond', args)
        self.assertTrue(r['isError'])
        self.assertEqual((r['structuredContent']['error'], r['structuredContent']['message']), ('approval_unbound', UNBOUND))
        r = s.call_modern({'name': 'valun_respond', 'arguments': args}, {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}})
        self.assertEqual((r['resultType'], r['isError'], r['structuredContent']['error']), ('complete', True, 'approval_unbound'))
        self.assertNotIn('inputRequests', r)
        self.assertEqual(out.getvalue(), b'')                               # no elicitation request was sent

    def test_mcp_asks_with_the_prepared_text_and_signs_the_bound_arguments(self):
        called = []

        class Ok(Agent):
            def call(self, name, args=None):
                called.append((name, args))
                return {'ok': True}
        answer = json.dumps({'jsonrpc': '2.0', 'id': 'valun-approval-1', 'result': {'action': 'accept', 'content': {'approve': True}}})
        s, out = self.mcp(Ok(DEAL), (answer + '\n').encode())
        r = s.call('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})
        self.assertFalse(r['isError'])
        ask = json.loads(out.getvalue().decode().splitlines()[0])
        self.assertIn("Valun - ACCEPT bob's offer (deal vd_1, version 2)", ask['params']['message'])
        self.assertEqual(called, [('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})])
        # 2026-07-28: the first round asks with the prepared text, bound into the HMAC request state
        s, _out = self.mcp(Ok(DEAL))
        meta = {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}}
        r = s.call_modern({'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1', 'action': 'accept'}}, meta)
        self.assertEqual(r['resultType'], 'input_required')
        self.assertIn("ACCEPT bob's offer", r['inputRequests']['approval']['params']['message'])

    def test_console_approval_text_says_credit_notes_wait(self):
        self.assertIn('accepting a delivery', mcp_server.APPROVAL_TEXT['console'])
        self.assertIn('credit note', cli.JOIN_APPROVALS['console'])


class Terminal(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home.name})
        self.env.start()
        self.calls = []

    def tearDown(self):
        self.env.stop()
        self.home.cleanup()

    def profile(self, name, state):
        path = os.path.join(self.home.name, 'profiles', name + '.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(state, f)
        return path

    def fake_request(self, routes):
        calls = self.calls

        def request(client, method, path, body=None, auth=True, token=None):
            calls.append((method, path, body, token))
            r = routes.get(f'{method} {path}')
            if r is None:
                raise vc.ValunError('unreachable', 'cannot reach the server')
            return json.loads(json.dumps(r))
        return mock.patch.object(vc.Client, 'request', request)

    def test_valun_call_refuses_when_prepare_fails(self):
        self.profile('p', {'server': 'http://valun.invalid', 'participant_id': 'vp_a1a1a1a1a1a1', 'secret': 'ab' * 32,
                           'agent_token': 'vpa_test-only', 'approvals': 'ask'})

        class Tty(io.StringIO):
            def isatty(self):
                return True
        out = Tty()
        with self.fake_request({}), mock.patch.object(sys, 'stdin', Tty()), mock.patch.object(sys, 'stdout', out), \
                mock.patch('builtins.input', side_effect=AssertionError('the owner must not be asked')):
            rc = cli.main(['--profile', 'p', 'call', 'valun_propose', json.dumps({'counterparty': 'bob', 'role': 'payer', 'title': 't',
                                                                                  'description': 'd', 'deliverable': 'x', 'price': 3})])
        self.assertEqual(rc, 3)
        result = json.loads(out.getvalue())
        self.assertEqual((result['error'], result['message']), ('approval_unbound', UNBOUND))
        self.assertNotIn('POST', [m for m, *_ in self.calls])

    def test_console_mode_sets_approve_above_0_and_review_deliveries(self):
        path = self.profile('c', {'server': 'http://valun.invalid', 'participant_id': 'vp_a1a1a1a1a1a1', 'approvals': 'ask',
                                  'pins': {'tracker_nft_id': '11' * 32, 'denomination': 'erg'}})
        tok = os.path.join(self.home.name, 'owner.txt')
        with open(tok, 'w') as f:
            f.write('vpo_test-only\n')
        routes = {'GET /pilot/v1/owner': {'mandate': {'max_issue_per_deal': 25, 'max_accept_per_deal': 20}}, 'PUT /pilot/v1/owner/mandate': {}}
        with self.fake_request(routes), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'approvals', 'console', '--owner-token-file', tok]), 0)
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'approvals', 'ask', '--owner-token-file', tok]), 0)
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'server', 'http://other.invalid/']), 0)
        puts = [(body, token) for m, p, body, token in self.calls if m == 'PUT']
        self.assertEqual(puts, [({'approve_above': 0, 'review_deliveries': True}, 'vpo_test-only'),
                                ({'approve_above': 25, 'review_deliveries': False}, 'vpo_test-only')])
        with open(path, encoding='utf-8') as f:
            disk = json.load(f)
        self.assertEqual((disk['approvals'], disk['server']), ('ask', 'http://other.invalid'))
        self.assertNotIn('pins', disk)                      # a new server is pinned again on its first call
        self.assertNotIn('vpo_test-only', json.dumps(disk))

    def test_join_in_console_mode_holds_deliveries_and_pins_the_tracker(self):
        tok = os.path.join(self.home.name, 'owner.txt')
        routes = {'POST /pilot/v1/join-sandbox': {'participant_id': 'vp_c1c1c1c1c1c1', 'owner_token': 'vpo_test-only',
                                                  'enrollment_code': 'code', 'sandbox_only': True, 'note': 'sandbox only'},
                  'POST /pilot/v1/enroll': {'network': 'valun-pilot-1', 'agent_token': 'vpa_test-only'},
                  'GET /pilot/v1/me': {},
                  'GET /pilot/v1/info': {'network': 'valun-pilot-1', 'unit': 'PC', 'tracker_nft_id': '22' * 32, 'denomination': 'erg'},
                  'GET /pilot/v1/owner': {'mandate': {'max_issue_per_deal': 5, 'max_accept_per_deal': 5}},
                  'PUT /pilot/v1/owner/mandate': {}}
        with self.fake_request(routes), contextlib.redirect_stdout(io.StringIO()):
            rc = cli.main(['--profile', 'j', 'join', '--sandbox', '--handle', 'tester', '--operator', 'Ann', '--approvals', 'console',
                           '--server', 'http://valun.invalid', '--owner-token-file', tok])
        self.assertEqual(rc, 0)
        self.assertEqual([body for m, p, body, _t in self.calls if m == 'PUT'], [{'approve_above': 0, 'review_deliveries': True}])
        with open(os.path.join(self.home.name, 'profiles', 'j.json'), encoding='utf-8') as f:
            disk = json.load(f)
        self.assertEqual(disk['pins'], {'tracker_nft_id': '22' * 32, 'denomination': 'erg'})
        self.assertEqual(disk['approvals'], 'console')
        self.assertNotIn('vpo_test-only', json.dumps(disk))


if __name__ == '__main__':
    unittest.main()
