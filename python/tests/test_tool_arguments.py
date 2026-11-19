"""Fix inbox #58, the sweep: every tool, called with no arguments ({} or null) and with arguments that are not a JSON
object, answers bad_arguments naming each argument its schema requires, before anything is read or signed, or, for a tool
that requires none, what it answers for {}; never internal_error. It is checked once, where every call comes in
(ValunAgent.call, valun.agent.tool_arguments), and through each adapter: prepare_or_refusal() (the refusal it returns
instead of asking the owner), the MCP server (tools/call, in process, in every approvals mode) and `valun call`. Against
a fake server (offline). The same over a recorded server, value for value in the JavaScript client: the 'arguments:'
scenarios of js/test/fixtures/generate_python_fixtures.py, and js/test/tool-arguments.test.js.

0.7.2, the type sweep (TypeSweep): each argument given must also be of its schema's type. Basis's 33 internal_errors
(fix inbox evidence testnet-0.7.1-1115: 18 calls in the Python client, 15 of the same in the JavaScript one) and every
argument of every tool with a value of another type answer bad_arguments naming the argument and what it must be (or
the tool's own refusal of a value an enum does not list), before anything is read or signed, in every adapter; deal_id,
guarantee_id and call_id are ids of the shapes the server's routes take; an amount's words are in the profile's unit."""
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


class FakeServer(unittest.TestCase):
    """A fake server (ROUTES) whose requests are logged, an agent over it, and the MCP server over that agent."""

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


class Sweep(FakeServer):
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


# Fix inbox #58 (0.7.2): Basis's base arguments (58-py-typesweep.py), with due_in_hours for valun_offer_guarantee (without
# it every call of that tool is a missing argument first), and the calls that answered internal_error in 0.7.1.
BASE = {'valun_respond': {'deal_id': 'vd_0000000000000000', 'action': 'decline'}, 'valun_deal': {'deal_id': 'vd_0000000000000000'},
        'valun_propose': {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 't', 'description': 'd', 'deliverable': 'x', 'price': 1},
        'valun_deliver': {'deal_id': 'vd_0000000000000000', 'content': 'x'},
        'valun_review_delivery': {'deal_id': 'vd_0000000000000000', 'decision': 'dispute', 'reason': 'r'},
        'valun_check_payer': {'payer': 'sandbox-exact', 'amount': 1},
        'valun_offer_guarantee': {'issuer': 'sandbox-exact', 'creditor': 'sandbox-mallory', 'cap': 1, 'due_in_hours': 0},
        'valun_respond_guarantee': {'guarantee_id': 'vg_0000000000000000', 'action': 'decline'},
        'valun_call_guarantee': {'guarantee_id': 'vg_0000000000000000'}, 'valun_guarantees': {}, 'valun_directory': {},
        'valun_set_limits': {'goals': 'g'}, 'valun_status': {}, 'valun_inbox': {}}
# 58-py-typesweep.txt INTERNAL_ERRORS 18 (58-npm-typesweep.txt: the same but the three deal_id {"a": 1}, 15): 33 in all.
BASIS_INTERNAL_ERRORS = [(t, k, v) for t, ks in (('valun_directory', ('query',)), ('valun_propose', ('counterparty', 'description')),
                                                 ('valun_respond', ('reason',)), ('valun_review_delivery', ('reason',)))
                         for k in ks for v in (42, [1], {'a': 1})] + \
                        [(t, 'deal_id', {'a': 1}) for t in ('valun_deal', 'valun_deliver', 'valun_review_delivery')]
# A value of another type for each JSON type (an enum: a value it does not list; an id: one of another shape).
WRONG = {'string': (42, [1], {'a': 1}, True), 'integer': ('7', 1.5, True, [1], 2 ** 53), 'boolean': ('yes', 1, 'false', [True]),
         'array': ('x', 5, {'a': 1}, [5])}
ENUM_WRONG = ('Accept', 'accepted', '', 7, ['accept'], True)
ID_WRONG = {'deal_id': ('vd_1', 'vd_' + '6A' * 8, 'VD_' + '6a' * 8, 'vd_' + '6a' * 8 + '\n', ' vd_' + '6a' * 8, 'vg_' + '6a' * 8, '', 7),
            'guarantee_id': ('vg_1', 'vg_' + '3C' * 8, 'vd_' + '3c' * 8, '', 7), 'call_id': ('vgc_1', 'vg_' + '3c' * 8, '', 7)}


def wrong_values(spec, k):
    return ENUM_WRONG if 'enum' in spec else ID_WRONG.get(k) or WRONG.get(spec.get('type'), ())


class TypeSweep(FakeServer):
    def test_basis_33_internal_errors_are_bad_arguments_naming_the_field_before_anything_is_read(self):
        a = self.agent()
        self.assertEqual(len(BASIS_INTERNAL_ERRORS), 18, 'Python 18; the JavaScript client 15 of them (the deal_id ones aside): 33')
        for tool, k, v in BASIS_INTERNAL_ERRORS:
            self.log.clear()
            r = a.call_safe(tool, dict(BASE[tool], **{k: v}))
            self.assertEqual(r['error'], 'bad_arguments', (tool, k, v, r))
            self.assertTrue(r['message'].startswith(f'{k} must be '), r['message'])
            self.assertIn(f'not {va.quoted(v)}', r['message'])
            self.assertEqual(self.log, [], f'{tool} {k}: refused before anything is read')
        self.assertEqual(a.call_safe('valun_propose', dict(BASE['valun_propose'], counterparty=42)),
                         {'error': 'bad_arguments', 'message': 'counterparty must be a string (their handle or participant id), not 42; '
                                                               'nothing was signed'})
        self.assertEqual(a.call_safe('valun_directory', {'query': [1]}),
                         {'error': 'bad_arguments', 'message': 'query must be a string, not [1]'})
        self.assertEqual(a.call_safe('valun_deal', {'deal_id': {'a': 1}}),
                         {'error': 'bad_arguments', 'message': 'deal_id must be the deal id, vd_ + 16 hex, as valun_inbox lists it, not {"a":1}'})
        self.assertEqual(a.call_safe('valun_respond', dict(BASE['valun_respond'], reason={'a': 1})),
                         {'error': 'bad_arguments', 'message': 'reason must be a string, not {"a":1}; nothing was signed'})

    def test_every_argument_of_every_tool_of_another_type_is_refused_before_anything_is_read(self):
        a = self.agent()
        n = 0
        for t in schemas.ALL:
            name = t['name']
            for k, spec in t['parameters']['properties'].items():
                for v in wrong_values(spec, k):
                    self.log.clear()
                    r = a.call_safe(name, dict(BASE[name], **{k: v}))
                    n += 1
                    self.assertNotEqual(r.get('error'), 'internal_error', (name, k, v, r))
                    want = va.ENUM_REFUSALS[name][k][0] if 'enum' in spec else 'bad_arguments'
                    self.assertEqual(r.get('error'), want, (name, k, v, r))
                    self.assertIn(k, r['message'], (name, k, v))
                    self.assertEqual(self.log, [], f'{name} {k}={v!r}: nothing is read')
                    self.assertEqual(va.argument_refusal(name, k, v).code, want)
        self.assertGreater(n, 200)

    def test_what_fits_passes_and_null_is_absent(self):
        for t in schemas.ALL:
            for k, spec in t['parameters']['properties'].items():
                self.assertIsNone(va.argument_refusal(t['name'], k, None), (t['name'], k))
        ok = {'valun_deal': {'deal_id': 'vd_' + '6a' * 8}, 'valun_status': {'brief': False},
              'valun_directory': {'query': '', 'limit': 0, 'offset': -2},       # the tool's own check takes the range
              'valun_propose': dict(BASE['valun_propose'], price=0, deliver_within_hours=10 ** 9),
              'valun_set_limits': {'clear': [], 'goals': ''}, 'valun_respond_guarantee': {'guarantee_id': 'vg_' + '3c' * 8,
                                                                                          'action': 'honor', 'call_id': 'vgc_' + '3c' * 8},
              'valun_offer_guarantee': dict(BASE['valun_offer_guarantee'], deals=['vd_' + '6a' * 8], note=''),
              'valun_check_payer': {'payer': ' ', 'amount': -1, 'deal_id': 'vd_' + '6a' * 8}}
        for name, args in ok.items():
            self.assertIs(va.tool_arguments(name, args), args, name)
        # an argument the schema does not give is the tool's (the pins prepare() adds among them), and so is an unknown tool
        args = {'deal_id': 'vd_' + '6a' * 8, 'decision': 'accept', 'expected_quote_digest': 5, 'expected_claim_total': 'x'}
        self.assertIs(va.tool_arguments('valun_review_delivery', args), args)
        self.assertEqual(va.tool_arguments('valun_new_tool', {'deal_id': 7}), {'deal_id': 7})
        # the first argument of the wrong type, in the schema's order; a missing one is named first
        self.assertEqual(self.agent().call_safe('valun_propose', dict(BASE['valun_propose'], price='x', title=5))['message'],
                         'title must be a string (a short name of the service), not 5; nothing was signed')
        self.assertEqual(self.agent().call_safe('valun_respond', {'deal_id': 7})['message'],
                         'missing argument: action (accept, decline, counter or withdraw); nothing was signed')

    def test_ids_are_of_the_shapes_the_servers_routes_take(self):
        a = self.agent()
        for name in ('valun_deal', 'valun_respond', 'valun_deliver', 'valun_review_delivery'):
            for bad in ID_WRONG['deal_id']:
                self.log.clear()
                r = a.call_safe(name, dict(BASE[name], deal_id=bad))
                self.assertEqual((r['error'], self.log), ('bad_arguments', []), (name, bad))
                self.assertTrue(r['message'].startswith('deal_id must be the deal id, vd_ + 16 hex'), r['message'])
        for name in ('valun_guarantees', 'valun_respond_guarantee', 'valun_call_guarantee'):
            for bad in ID_WRONG['guarantee_id']:
                self.assertEqual(a.call_safe(name, dict(BASE[name], guarantee_id=bad)),
                                 {'error': 'bad_arguments', 'message': 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees '
                                                                       'lists them)'}, (name, bad))
        for bad in ID_WRONG['call_id']:
            self.assertEqual(a.call_safe('valun_respond_guarantee', dict(BASE['valun_respond_guarantee'], call_id=bad)),
                             {'error': 'bad_arguments', 'message': 'call_id is malformed (vgc_ + 16 hex)'}, bad)
        self.assertEqual(self.log, [])
        self.assertEqual({k: p.pattern for k, p in va.ID_SHAPES.items()},
                         {'deal_id': 'vd_[0-9a-f]{16}', 'guarantee_id': 'vg_[0-9a-f]{16}', 'call_id': 'vgc_[0-9a-f]{16}'})

    def test_the_refusals_the_tools_gave_before_are_kept_word_for_word(self):
        a = self.agent()
        same = [
            ('valun_review_delivery', 'decision', 'Accept', 'bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed"),
            ('valun_respond', 'action', 7, 'bad_action', 'action must be accept, decline, counter or withdraw'),
            ('valun_propose', 'role', 'buyer', 'bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)'),
            ('valun_respond_guarantee', 'action', 'Accept', 'bad_arguments', 'action must be accept, decline, release, withdraw or honor'),
            ('valun_propose', 'price', 1.5, 'bad_arguments',
             'price must be a whole number of PC, at least 1 (a JSON integer), not 1.5; nothing was signed'),
            ('valun_check_payer', 'deal_id', 5, 'bad_arguments',
             'deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox lists it, not 5'),
            ('valun_directory', 'limit', '10', 'bad_arguments',
             'limit must be a whole number (how many participants to show: 1 to 50, 10 by default), not "10"'),
            ('valun_status', 'brief', 'yes', 'bad_arguments', 'brief must be true or false'),
            ('valun_deliver', 'exact_result', 'yes', 'bad_arguments', 'exact_result is true or false'),
            ('valun_offer_guarantee', 'note', 5, 'bad_arguments', 'note must be text'),
            ('valun_offer_guarantee', 'cap', 'x', 'bad_arguments', 'cap must be a whole number'),
            ('valun_offer_guarantee', 'deals', ['vd_1'], 'bad_arguments', 'deals must be 1 to 10 different deal ids (vd_ + 16 hex)'),
            ('valun_call_guarantee', 'amount', 'x', 'bad_arguments', 'amount must be a whole number of at least 1'),
            ('valun_check_payer', 'payer', 5, 'bad_arguments', 'payer must be the handle or participant id (text) of the agent that would owe you')]
        for name, k, v, code, message in same:
            self.assertEqual(a.call_safe(name, dict(BASE[name], **{k: v})), {'error': code, 'message': message}, (name, k))
        # every enum of a tool's schema has its tool's refusal, and every refusal is of an enum
        enums = {(t['name'], k) for t in schemas.ALL for k, s in t['parameters']['properties'].items() if 'enum' in s}
        self.assertEqual(enums, {(t, k) for t, by in va.ENUM_REFUSALS.items() for k in by})
        self.assertEqual(set(va.PROPERTIES), set(va.TOOL_NAMES))
        # new words where a tool had none: a whole number or true or false, and no value the tool would have taken
        self.assertEqual(a.call_safe('valun_set_limits', {'max_total_owed': '60'}),
                         {'error': 'bad_arguments', 'message': 'max_total_owed must be a whole number (a JSON integer), not "60"; nothing was signed'})
        self.assertEqual(a.call_safe('valun_deliver', dict(BASE['valun_deliver'], send_anyway='false')),
                         {'error': 'bad_arguments', 'message': 'send_anyway must be true or false, not "false"; nothing was signed'})
        self.assertEqual(a.call_safe('valun_set_limits', {'clear': ['max_owed']})['message'],
                         'clear must be a list of the limits to remove (max_per_deal_as_payer, max_total_owed, max_per_deal_as_payee, '
                         'max_claim_per_payer, min_price_as_payee, min_payer_coverage_pct), not ["max_owed"]; nothing was signed')
        self.assertEqual(self.log, [], 'nothing was read or recorded: valun_set_limits {"goals": 42} is not recorded either')
        self.assertEqual(a.call_safe('valun_set_limits', {'goals': 42}),
                         {'error': 'bad_arguments', 'message': 'goals must be a string, not 42; nothing was signed'})

    def test_an_amounts_words_are_in_the_profiles_unit(self):
        store = MemStore()
        store.state['network'] = schemas.TESTNET
        a = va.ValunAgent(store, server=SERVER)
        self.assertEqual(a.call_safe('valun_propose', dict(BASE['valun_propose'], price='1000000'))['message'],
                         'price must be a whole number of nanoERG, at least 1 (a JSON integer), not "1000000"; nothing was signed')
        self.assertEqual(a.prepare_or_refusal('valun_check_payer', {'payer': 'bob', 'amount': 2.5})[1]['message'],
                         'amount must be a whole number of nanoERG, at least 1 (a JSON integer), not 2.5; nothing was signed')
        self.assertEqual(va.tool_arguments('valun_deal', {'deal_id': 'vd_' + '6a' * 8}, 'nanoERG'), {'deal_id': 'vd_' + '6a' * 8})
        with self.assertRaises(vc.ValunError) as e:
            va.tool_arguments('valun_propose', dict(BASE['valun_propose'], price=True))
        self.assertIn('a whole number of PC', str(e.exception), 'without a unit: the pilot\'s')
        self.assertEqual(va.ValunAgent(None).tool_arguments('valun_status', None), {}, 'a profile it cannot read: PC words')

    def test_the_adapters_give_the_same_refusal_without_asking_and_prepare_refuses_it(self):
        a = self.agent()
        for tool, k, v in BASIS_INTERNAL_ERRORS + [('valun_respond', 'action', 'Accept'), ('valun_review_delivery', 'decision', True),
                                                  ('valun_propose', 'price', '15'), ('valun_offer_guarantee', 'deals', [])]:
            args = dict(BASE[tool], **{k: v})
            want = a.call_safe(tool, args)
            self.log.clear()
            self.assertEqual(a.prepare_or_refusal(tool, args), (None, want), (tool, k, v))
            self.assertEqual(self.log, [], 'nothing is read')
            if a.is_commitment(tool, args):
                with self.assertRaises(vc.ValunError) as e:
                    a.prepare(tool, args)
                self.assertEqual((e.exception.code, e.exception.extra['cause']), ('approval_unbound', want['error']), (tool, k))
        for approvals, caps in (('ask', {'elicitation': {}}), ('none', {}), ('console', {}), ('client-prompt', {})):
            call = self.mcp(approvals, caps)
            for tool, k, v in BASIS_INTERNAL_ERRORS:
                is_error, payload = call(tool, dict(BASE[tool], **{k: v}))
                self.assertTrue(is_error)
                self.assertEqual(payload['error'], 'bad_arguments', (approvals, tool, k))
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name})
        env.start()
        self.addCleanup(env.stop)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 's.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': ME, 'pubkey': '02' + '11' * 32, 'secret': '11' * 32,
                       'agent_token': AGENT_TOKEN, 'approvals': 'none', 'network': schemas.TESTNET}, f)
        for tool, k, v in BASIS_INTERNAL_ERRORS[:6]:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = cli.main(['--profile', 's', 'call', tool, json.dumps(dict(BASE[tool], **{k: v}))])
            self.assertEqual((rc, json.loads(out.getvalue())['error']), (1, 'bad_arguments'), (tool, k, v))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli.main(['--profile', 's', 'call', 'valun_propose', json.dumps(dict(BASE['valun_propose'], price='x'))])
        self.assertIn('a whole number of nanoERG', json.loads(out.getvalue())['message'], "`valun call`: the profile's unit")
        self.assertNotIn('GET /pilot/v1/participants', self.log)


class ReviewFixes(FakeServer):
    """The 0.7.2 review of fix inbox #58: a limit with a fraction is refused, never truncated; null is not given wherever
    a tool has a default; and the hours of an offer are refused above the schema's maximum (the server's) before
    anything is read or signed."""

    def test_a_limit_is_a_json_integer_never_truncated(self):
        # 0.7.1 recorded int(v): 40.5 as 40 (a floor such as min_price_as_payee 4.5 as 4, looser than asked). Python refuses
        # a float for every whole-number argument, as for the price since fix inbox #22; JSON.parse gives 40.0 to the
        # JavaScript client as 40, so only a fraction is refused there.
        for v in (40.5, 40.0, 4e1, float('inf'), float('nan')):
            with self.assertRaises(vc.ValunError) as e:
                va.tool_arguments('valun_set_limits', {'max_total_owed': v})
            self.assertEqual(e.exception.code, 'bad_arguments', v)
        self.assertEqual(self.agent().call_safe('valun_set_limits', {'min_price_as_payee': 4.5}),
                         {'error': 'bad_arguments', 'message': 'min_price_as_payee must be a whole number (a JSON integer), not 4.5; '
                                                               'nothing was signed'})
        self.assertEqual(self.log, [], 'refused before anything is read')

    def test_null_is_not_given_for_brief_and_the_guarantee_hours(self):
        a = self.agent()
        for args in ({'brief': None}, {}, {'brief': False}):
            self.assertNotIn('error', a.call_safe('valun_status', args), args)
        self.assertEqual(a.call_safe('valun_status', {'brief': 'no'})['message'], 'brief must be true or false')
        self.assertEqual(va._guarantee_int({'callable_for_hours': None}, 'callable_for_hours', 168), 168)
        with self.assertRaises(vc.ValunError) as e:
            va._guarantee_int({'cap': None}, 'cap', None)
        self.assertEqual(str(e.exception), 'cap is required')

    def test_the_hours_of_an_offer_are_at_most_the_schemas_maximum(self):
        for tool in (schemas.PROPOSE, schemas.RESPOND):
            props = tool['parameters']['properties']
            self.assertEqual({k: props[k]['maximum'] for k in va.HOURS_MAX}, va.HOURS_MAX, tool['name'])
        a = self.agent()
        propose, counter = BASE['valun_propose'], {'deal_id': 'vd_' + '0' * 16, 'action': 'counter'}
        for k, v in (('deliver_within_hours', 721), ('offer_valid_hours', 169), ('deliver_within_hours', 70_000_000),
                     ('offer_valid_hours', 10 ** 15)):
            days = va.HOURS_MAX[k] // 24
            want = {'error': 'bad_arguments', 'message': f'{k} must be at most {va.HOURS_MAX[k]} hours ({days} days, the most the '
                                                          f'server takes), not {v}; nothing was signed'}
            for tool, args in (('valun_propose', propose), ('valun_respond', counter)):
                self.log.clear()
                self.assertEqual(a.call_safe(tool, dict(args, **{k: v})), want, (tool, k, v))
                self.assertEqual(self.log, [], 'refused before anything is read')
        # at the maximum it is the tool's own business as before (here: the counterparty this fake server does not know)
        self.assertEqual(a.call_safe('valun_propose', dict(propose, deliver_within_hours=720, offer_valid_hours=168))['error'],
                         'unknown_participant')


if __name__ == '__main__':
    unittest.main()
