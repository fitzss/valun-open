"""Fix inbox #58, the sweep: every tool, called with no arguments ({} or null) and with arguments that are not a JSON
object, answers bad_arguments naming each argument its schema requires, before anything is read or signed, or, for a tool
that requires none, what it answers for {}; never internal_error. It is checked once, where every call comes in
(ValunAgent.call, valun.agent.tool_arguments), and through each adapter: prepare_or_refusal() (the refusal it returns
instead of asking the owner), the MCP server (tools/call, in process, in every approvals mode) and `valun call`. Against
a fake server (offline). The same over a recorded server, value for value in the JavaScript client: the 'arguments:'
scenarios of js/test/fixtures/generate_python_fixtures.py, and js/test/tool-arguments.test.js."""
import contextlib
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
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun import schemas  # noqa: E402

SERVER = 'http://valun.invalid'
ME, BOB = 'vp_a1a1a1a1a1a1', 'vp_b0b0b0b0b0b0'
AGENT_TOKEN = 'vpa_test-agent'
PEOPLE = [{'id': ME, 'handle': 'alice', 'display_name': 'Alice', 'operator': 'Alice Example', 'about': '', 'services': '',
           'status': 'active'},
          {'id': BOB, 'handle': 'bob', 'display_name': 'Bob', 'operator': 'Bob Example', 'about': 'Briefs.', 'services': 'Briefs',
           'status': 'active'}]
ME_VIEW = {'participant': {'id': ME, 'handle': 'alice', 'status': 'active'}, 'mandate': {'approve_above': 25}, 'mandate_version': 3,
           'position': {'claims_held': 0, 'owes': 9, 'net': -9}, 'authority': {}}
ROUTES = {'GET /pilot/v1/info': {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC'}, 'GET /pilot/v1/me': ME_VIEW,
          'GET /pilot/v1/participants': PEOPLE, f'GET /pilot/v1/participants/{BOB}': {'id': BOB, 'public_position': {}},
          'GET /pilot/v1/inbox': {'respond': []}, 'GET /pilot/v1/guarantees': []}
# What 0.7.0 took as {} (the falsy ones) and what failed in it with an AttributeError (internal_error) on 7 tools.
NOT_AN_OBJECT = ('x', '', 42, 0, 1.5, True, False, [], [1], ['vd_1111111111111111', 'accept'])


def refusal(name, args_missing=None):
    """The answer tool_arguments gives: for arguments that are not a JSON object (args_missing None), or that lack
    args_missing (each in the schema's order), with each one's words."""
    tail = '' if name in va.READ_ONLY_TOOLS else '; nothing was signed'
    if args_missing is None:
        return {'error': 'bad_arguments', 'message': 'the arguments are not a JSON object' + tail}
    words = {**va.ARGUMENT_WORDS, **va.ARGUMENT_WORDS_OF.get(name, {})}
    head = 'missing argument: ' if len(args_missing) == 1 else 'missing arguments: '
    return {'error': 'bad_arguments', 'message': head + ', '.join(f'{k} ({words[k]})' for k in args_missing) + tail}


class MemStore:
    def __init__(self):
        self.state = {'server': SERVER, 'participant_id': ME, 'pubkey': '02' + '11' * 32}

    def secret(self):
        return '11' * 32

    def token(self):
        return AGENT_TOKEN

    def save(self):
        pass

    def save_credentials(self, *_a):
        pass


class Sweep(unittest.TestCase):
    def setUp(self):
        self.log = []

        def request(client, method, path, body=None, auth=True, token=None):
            self.log.append(f'{method} {path}')
            key = f'{method} {path}'
            if key not in ROUTES:
                raise vc.ValunError('not_found', f'no route {key}', 404)
            return json.loads(json.dumps(ROUTES[key]))
        p = mock.patch.object(vc.Client, 'request', request)
        p.start()
        self.addCleanup(p.stop)

    def agent(self):
        return va.ValunAgent(MemStore(), server=SERVER)

    def test_every_required_argument_is_the_schemas_and_has_its_words(self):
        for network in (None, schemas.TESTNET):
            for t in schemas.for_network(network):
                self.assertEqual(va.REQUIRED_ARGUMENTS[t['name']], tuple(t['parameters']['required']), t['name'])
        self.assertEqual(list(va.REQUIRED_ARGUMENTS), va.TOOL_NAMES)
        for name, keys in va.REQUIRED_ARGUMENTS.items():
            for k in keys:
                words = va.ARGUMENT_WORDS_OF.get(name, {}).get(k) or va.ARGUMENT_WORDS.get(k)
                self.assertTrue(isinstance(words, str) and words and not words.endswith('.'), (name, k))
        self.assertEqual(set(va.ARGUMENT_WORDS_OF), {'valun_respond_guarantee'})
        enum = schemas.RESPOND_GUARANTEE['parameters']['properties']['action']['enum']
        self.assertEqual(va.ARGUMENT_WORDS_OF['valun_respond_guarantee']['action'], ', '.join(enum[:-1]) + ' or ' + enum[-1])
        enum = schemas.RESPOND['parameters']['properties']['action']['enum']
        self.assertEqual(va.ARGUMENT_WORDS['action'], ', '.join(enum[:-1]) + ' or ' + enum[-1])

    def test_no_arguments_names_every_required_one_before_anything_is_read(self):
        a = self.agent()
        for name in va.TOOL_NAMES:
            for args in ({}, None):
                self.log.clear()
                r = a.call_safe(name, args)
                required = va.REQUIRED_ARGUMENTS[name]
                if required:
                    self.assertEqual(r, refusal(name, required), (name, args))
                    self.assertEqual(self.log, [], f'{name}: refused before anything is read')
                else:
                    self.assertNotIn(r.get('error'), ('internal_error', 'bad_arguments'), (name, args, r))
        self.assertEqual(a.call_safe('valun_set_limits', {})['error'], 'nothing_to_record')
        self.assertEqual(a.call_safe('valun_review_delivery', {})['message'],
                         'missing arguments: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it), decision (accept or dispute); '
                         'nothing was signed')
        self.assertEqual(a.call_safe('valun_respond_guarantee', {'action': 'honor'})['message'],
                         'missing argument: guarantee_id (the guarantee id, vg_ + 16 hex, as valun_guarantees lists it); nothing was signed')
        self.assertEqual(a.call_safe('valun_respond_guarantee', {'guarantee_id': 'vg_' + '1a' * 8})['message'],
                         'missing argument: action (accept, decline, release, withdraw or honor); nothing was signed')
        self.assertEqual(a.call_safe('valun_check_payer', {'amount': None, 'payer': None})['message'],
                         'missing arguments: payer (the handle or participant id of the agent that would owe you), amount (what it '
                         "would owe you, the deal's price: a whole number, at least 1)")

    def test_arguments_that_are_not_an_object_are_refused_for_every_tool(self):
        a = self.agent()
        for name in va.TOOL_NAMES:
            for bad in NOT_AN_OBJECT:
                self.assertEqual(a.call_safe(name, bad), refusal(name), (name, bad))
                with self.assertRaises(vc.ValunError) as e:
                    a.call(name, bad)
                self.assertEqual(e.exception.code, 'bad_arguments')
        self.assertEqual(self.log, [], 'nothing is read for any of them')

    def test_a_present_argument_is_never_called_missing(self):
        a = self.agent()
        # 0, false and '' are there (each tool says what it takes); only absent or null is missing
        self.assertNotEqual(a.call_safe('valun_offer_guarantee', {'issuer': 'bob', 'creditor': 'bob', 'cap': 1, 'due_in_hours': 0})
                            .get('message', '').split(':')[0], 'missing argument')
        r = a.call_safe('valun_deal', {'deal_id': ''})
        self.assertNotIn('missing argument', r.get('message', ''), r)
        self.assertEqual(a.call_safe('valun_review_delivery', {'deal_id': 'vd_1111111111111111', 'decision': 'Accept'})['error'], 'bad_decision')

    def test_the_adapters_give_the_same_refusal_and_never_ask_the_owner(self):
        a = self.agent()
        for name in va.TOOL_NAMES:
            cases = [(bad, refusal(name)) for bad in NOT_AN_OBJECT]
            if va.REQUIRED_ARGUMENTS[name]:
                cases.append(({}, refusal(name, va.REQUIRED_ARGUMENTS[name])))
            for args, want in cases:
                self.log.clear()
                self.assertEqual(a.prepare_or_refusal(name, args), (None, want), (name, args))
                self.assertEqual(self.log, [], f'{name}: nothing is read for it')
                if a.is_commitment(name, args):         # the classification stays fail closed: prepare() refuses it too
                    self.log.clear()
                    with self.assertRaises(vc.ValunError) as e:
                        a.prepare(name, args)
                    self.assertEqual((e.exception.code, e.exception.extra.get('cause')), ('approval_unbound', 'bad_arguments'), (name, args))
                    self.assertEqual(self.log, [], f'{name}: prepare() reads nothing for it')
        # complete arguments are prepared as before
        self.assertEqual(a.prepare_or_refusal('valun_respond', {'deal_id': 'vd_1111111111111111', 'action': 'decline', 'reason': 'No.'}),
                         ({'args': {'deal_id': 'vd_1111111111111111', 'action': 'decline', 'reason': 'No.'}, 'text': None}, None))

    def mcp(self, approvals, caps):
        server = mcp_server.McpServer(self.agent(), approvals)
        server.handle({'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': caps, 'clientInfo': {'name': 'test', 'version': '0'}}})
        n = [0]

        def call(name, args):
            n[0] += 1
            r = server.handle({'jsonrpc': '2.0', 'id': n[0], 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})
            res = r['result']
            return res['isError'], json.loads(res['content'][0]['text'])
        return call

    def test_the_mcp_server_answers_bad_arguments_in_every_approvals_mode(self):
        for approvals, caps in (('ask', {'elicitation': {}}), ('none', {}), ('console', {}), ('client-prompt', {}), ('ask', {})):
            call = self.mcp(approvals, caps)
            for name in va.TOOL_NAMES:
                cases = [(bad, refusal(name)) for bad in ('x', 42, 1.5, True, [1])]
                if va.REQUIRED_ARGUMENTS[name]:
                    cases.append(({}, refusal(name, va.REQUIRED_ARGUMENTS[name])))
                for args, want in cases:
                    is_error, payload = call(name, args)
                    self.assertTrue(is_error)
                    if approvals == 'ask' and not caps and name in va.SIGNING_TOOLS + va.LIMIT_TOOLS and \
                            self.agent().is_commitment(name, args):
                        # no way to ask the owner: no commitment can be signed here at all, whatever its arguments
                        self.assertEqual(payload['error'], 'approval_unavailable', (approvals, name, args))
                    else:
                        self.assertEqual(payload, want, (approvals, caps, name, args))
        # nothing is read for any of them but GET /me: is_commitment() reads it to classify valun_set_limits (approvals ask)
        self.assertEqual(set(self.log), {'GET /pilot/v1/me'})

    def test_valun_call_prints_the_refusal(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name})
        env.start()
        self.addCleanup(env.stop)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': ME, 'pubkey': '02' + '11' * 32, 'secret': '11' * 32,
                       'agent_token': AGENT_TOKEN, 'approvals': 'none'}, f)
        for name in va.TOOL_NAMES:
            cases = [('"x"', refusal(name)), ('42', refusal(name)), ('[1]', refusal(name)), ('null', None)]
            if va.REQUIRED_ARGUMENTS[name]:
                cases.append(('{}', refusal(name, va.REQUIRED_ARGUMENTS[name])))
            for raw, want in cases:
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    rc = cli.main(['--profile', 's', 'call', name, raw])
                got = json.loads(out.getvalue())
                if want is None:                     # null: no arguments, as {} (json.loads gives None)
                    want = refusal(name, va.REQUIRED_ARGUMENTS[name]) if va.REQUIRED_ARGUMENTS[name] else None
                if want is None:
                    self.assertNotIn(got.get('error'), ('internal_error', 'bad_arguments'), (name, raw, got))
                    continue
                self.assertEqual((rc, got), (1, want), (name, raw))


if __name__ == '__main__':
    unittest.main()
