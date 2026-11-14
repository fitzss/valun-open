"""Budget cards, against a fake Valun server (offline): an owner may publish its agent's budget card, anyone can read it
(Client.card) and check a payment against it (Client.check_payer, the read-only tool valun_check_payer, `valun card
check`), the owner publishes or hides it with its owner token (Client.set_public_card, `valun card publish|unpublish`),
and valun_status shows the agent's room. Also fix inbox #58: a tool called without a required argument answers
bad_arguments with a plain message, not internal_error. The same over a recorded server, value for value in the
JavaScript client: the 'check_payer:', 'card:', 'set_public_card:' and #58 scenarios of
js/test/fixtures/generate_python_fixtures.py."""
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
from valun import schemas  # noqa: E402

SERVER = 'http://valun.invalid'
ME, BOB, ERIN, HIDDEN = 'vp_a1a1a1a1a1a1', 'vp_b0b0b0b0b0b0', 'vp_e0e0e0e0e0e0', 'vp_0f0f0f0f0f0f'
AGENT_TOKEN, OWNER_TOKEN, BOBS_OWNER_TOKEN = 'vpa_test-agent', 'vpo_test-owner-of-alice', 'vpo_test-owner-of-bob'
PEOPLE = [{'id': ME, 'handle': 'alice', 'status': 'active'}, {'id': BOB, 'handle': 'bob', 'status': 'active'},
          {'id': ERIN, 'handle': 'erin', 'status': 'active'}]
CARD = {'card': 1, 'network': vc.NETWORK, 'unit': 'PC',
        'agent': {'id': BOB, 'handle': 'bob', 'display_name': 'Bob', 'operator': 'Bob Example'},
        'mandate': {'version': 4, 'expires_at': '2026-12-01T00:00:00.000Z', 'may_issue_credit': True, 'per_deal': 30,
                    'outstanding_cap': 40, 'approve_above': 25, 'counterparties': 'any', 'objective': 'Write briefs.'},
        'room': {'outstanding': 9, 'room_left': 31, 'as_of': '2026-11-06T12:00:00.000Z'},
        'backing': {'active': 1, 'total_cap': 5, 'remaining': 3, 'public': []},
        'record': {'completed': 3, 'disputed': 1, 'holds': 40, 'owes': 9, 'cleared': 2}, 'card_hash': 'c4' * 32,
        'check': f'{SERVER}/pilot/v1/participants/{BOB}/check', 'page': f'{SERVER}/agent/bob'}
MANDATE = {'max_issue_per_deal': 30, 'max_issue_outstanding': 100, 'max_accept_per_deal': 50, 'max_accept_per_issuer': 200,
           'min_price_as_payee': 5, 'min_payer_coverage_pct': 0, 'approve_above': 25, 'objective': 'Buy briefs.'}
ME_VIEW = {'participant': {'id': ME, 'handle': 'alice', 'status': 'active'}, 'mandate': MANDATE, 'mandate_version': 3,
           'position': {'claims_held': 0, 'owes': 9, 'net': -9}, 'authority': {}}
INFO = {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC'}
NOT_PUBLIC = (404, {'error': 'card_not_public', 'message': "this participant's owner has not published its budget card"})
SUMMARY_ACCEPT = 'Accept: within its budget (31 of 40 left), backed for you up to 3.'
SUMMARY_ASK = 'Ask owner: within its budget (13 of 40 left), its owner approves each IOU above 25.'
SUMMARY_DECLINE = 'Decline: above its limit per deal (30), more than the room it has left (31).'
SUMMARY_NOT_PUBLIC = ("Unknown: bob's owner has not published a budget card, so its budget cannot be checked; decide from its "
                      'record (valun_directory) or ask your owner.')


# The cover the server shows the payee itself (a request with its own token), and what anyone else sees: null, not 0.
COVER = {'covered': 3, 'guarantees': [{'guarantee_id': 'vg_' + '3c' * 8, 'backer': {'id': ERIN, 'handle': 'erin'}, 'remaining': 3}]}
NO_COVER_SHOWN = {'covered': None, 'guarantees': []}


def verdict(v='accept', reasons=('within its budget (31 of 40 left)',), payee=ME, amount=18, cover=COVER, **extra):
    out = {'verdict': v, 'reasons': list(reasons), 'rule': None, 'payer': {'id': BOB, 'handle': 'bob'},
           'payee': {'id': payee, 'handle': None}, 'amount': amount, 'mandate': {'version': 4, 'expires_at': '2026-12-01T00:00:00.000Z'},
           'room_left': 31, 'approval_needed': False, 'cover': json.loads(json.dumps(cover)),
           'record': {'completed': 3, 'disputed': 1}, 'card_hash': 'c4' * 32, 'checked_at': '2026-11-06T12:00:00.000Z', 'took_ms': 7}
    out.update(extra)
    return out


class World:
    """A fake server: the directory, cards and checks (public; a check shows the cover only to a request with the payee's
    own token), GET /me and /info (the agent's token), the owner routes (an owner token). Every request is logged as
    (method, path, body, token): token is the bearer sent, None for none."""

    def __init__(self):
        self.log = []
        self.routes = {}                # 'METHOD /path' -> (status, body), checked first
        self.card_public = {BOB: True, HIDDEN: True, ME: False}
        self.me = dict(ME_VIEW)
        self.put_answer = None          # the PUT /owner/mandate answer, if not the default

    def handle(self, method, path, body, token):
        self.log.append((method, path, body, token))
        key = f'{method} {path}'
        if key in self.routes:
            status, out = self.routes[key]
            if status >= 400:
                raise vc.ValunError(out.get('error', 'http_error'), out.get('message') or 'error', status,
                                    {k: v for k, v in out.items() if k not in ('error', 'message')})
            return json.loads(json.dumps(out))
        if key == 'GET /pilot/v1/participants':
            return json.loads(json.dumps(PEOPLE))
        if key == 'GET /pilot/v1/info':
            return dict(INFO)
        if key == 'GET /pilot/v1/me':
            if token != AGENT_TOKEN:
                raise vc.ValunError('unauthorized', 'missing or invalid token', 401)
            return json.loads(json.dumps(self.me))
        if path.startswith('/pilot/v1/owner'):
            who = {OWNER_TOKEN: ME, BOBS_OWNER_TOKEN: BOB}.get(token)
            if who is None:
                raise vc.ValunError('not_found', 'not found', 404)
            if key == 'GET /pilot/v1/owner':
                return {'participant': {'id': who, 'handle': 'alice' if who == ME else 'bob'}, 'mandate': dict(MANDATE)}
            if key == 'PUT /pilot/v1/owner/mandate':
                if self.put_answer is not None:
                    return self.put_answer
                self.card_public[who] = body['public_card']
                return {'mandate': dict(MANDATE, public_card=body['public_card']), 'mandate_version': 4, 'changed_by': 'owner',
                        'changed': True}
        parts = path.split('?', 1)[0].split('/')
        if method == 'GET' and len(parts) == 6 and parts[3] == 'participants' and parts[5] in ('card', 'check'):
            pid = parts[4]
            if pid not in self.card_public:
                raise vc.ValunError('not_found', f'unknown participant {pid}', 404)
            if not self.card_public[pid]:
                raise vc.ValunError(NOT_PUBLIC[1]['error'], NOT_PUBLIC[1]['message'], NOT_PUBLIC[0])
            if parts[5] == 'card':
                return dict(CARD)
            payee = path.split('payee=', 1)[1]
            own = token == AGENT_TOKEN and payee == ME          # the payee's own token: only it sees its cover
            return verdict(payee=payee, cover=COVER if own else NO_COVER_SHOWN)
        raise vc.ValunError('not_found', f'no route {key}', 404)


class MemStore:
    def __init__(self, joined=True):
        self.state = {'server': SERVER, **({'participant_id': ME, 'pubkey': '02' + '11' * 32} if joined else {})}
        self.joined = joined

    def secret(self):
        return '11' * 32 if self.joined else None

    def token(self):
        return AGENT_TOKEN if self.joined else None

    def save(self):
        pass

    def save_credentials(self, *_a):
        pass


class Card(unittest.TestCase):
    def setUp(self):
        self.world = World()
        world = self.world

        def request(client, method, path, body=None, auth=True, token=None):
            return world.handle(method, path, json.loads(json.dumps(body)) if body is not None else None,
                                token or (client.store.token() if auth else None))
        p = mock.patch.object(vc.Client, 'request', request)
        p.start()
        self.addCleanup(p.stop)

    def client(self, joined=True):
        return vc.Client(MemStore(joined), server=SERVER)

    def agent(self, joined=True):
        return va.ValunAgent(MemStore(joined), server=SERVER)

    def paths(self):
        return [(m, p) for m, p, _b, _t in self.world.log]


class ClientMethods(Card):
    def test_a_card_by_handle_reads_the_directory_then_the_card_without_a_token(self):
        self.assertEqual(self.client().card('  Bob '), CARD)
        self.assertEqual(self.world.log, [('GET', '/pilot/v1/participants', None, None), ('GET', f'/pilot/v1/participants/{BOB}/card', None, None)])

    def test_a_card_by_participant_id_needs_no_directory_and_no_profile(self):
        self.assertEqual(self.client(joined=False).card(HIDDEN.upper()), CARD)       # not listed in the directory: found by id
        self.assertEqual(self.paths(), [('GET', f'/pilot/v1/participants/{HIDDEN}/card')])

    def test_a_card_its_owner_did_not_publish_and_a_server_without_cards(self):
        with self.assertRaises(vc.ValunError) as e:
            self.client().card(ME)
        self.assertEqual((e.exception.code, e.exception.status), ('card_not_public', 404))
        self.world.routes[f'GET /pilot/v1/participants/{BOB}/card'] = (401, {'error': 'unauthorized', 'message': 'missing or invalid token'})
        with self.assertRaises(vc.ValunError) as e:
            self.client().card(BOB)
        self.assertEqual(e.exception.code, 'feature_unavailable')
        self.assertIn('offers no budget cards', str(e.exception))
        for who, code in (('nobody', 'unknown_participant'), ('', 'bad_arguments'), (None, 'bad_arguments'), (7, 'bad_arguments')):
            with self.assertRaises(vc.ValunError) as e:
                self.client().card(who)
            self.assertEqual(e.exception.code, code, who)

    def test_check_payer_asks_for_this_participant_with_its_own_token_and_signs_nothing(self):
        c = self.client()
        self.assertEqual(c.check_payer('bob', 18), verdict())          # this agent is the payee: it sees its own cover
        self.assertEqual(self.world.log[-1], ('GET', f'/pilot/v1/participants/{BOB}/check?amount=18&payee={ME}', None, AGENT_TOKEN))
        r = c.check_payer(BOB, 5, payee='erin')                         # another payee: its cover is not shown (null)
        self.assertEqual(self.world.log[-1], ('GET', f'/pilot/v1/participants/{BOB}/check?amount=5&payee={ERIN}', None, AGENT_TOKEN))
        self.assertEqual(r['cover'], NO_COVER_SHOWN)
        self.assertTrue(all(m == 'GET' for m, _p in self.paths()))
        self.assertEqual([t for m, p, _b, t in self.world.log if '/check' not in p], [None, None], 'the directory is read without a token')

    def test_check_payer_refuses_an_amount_that_is_not_a_whole_number_before_any_read(self):
        for amount in (0, -1, 1.5, '18', True, None, 2 ** 53):
            with self.assertRaises(vc.ValunError) as e:
                self.client().check_payer('bob', amount)
            self.assertEqual((e.exception.code, str(e.exception)), ('bad_arguments', 'amount must be a whole number of PC, at least 1; nothing was read'))
        with self.assertRaises(vc.ValunError) as e:
            self.client(joined=False).check_payer('bob', 18)
        self.assertEqual(e.exception.code, 'bad_arguments')
        self.assertIn('give payee', str(e.exception))
        self.assertEqual(self.world.log, [])
        self.assertEqual(self.client(joined=False).check_payer(BOB, 18, payee=ERIN), verdict(payee=ERIN, cover=NO_COVER_SHOWN))
        self.assertEqual(self.world.log[-1][3], None, 'an unjoined client has no token to send')

    def test_a_401_means_no_budget_cards_only_for_a_request_without_a_token(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee=%s'
        self.world.routes[route % ERIN] = self.world.routes[route % ME] = (401, {'error': 'unauthorized', 'message': 'missing or invalid token'})
        with self.assertRaises(vc.ValunError) as e:
            self.client(joined=False).check_payer(BOB, 18, payee=ERIN)     # a server from before budget cards
        self.assertEqual(e.exception.code, 'feature_unavailable')
        with self.assertRaises(vc.ValunError) as e:
            self.client().check_payer(BOB, 18)                               # this agent's token refused
        self.assertEqual((e.exception.code, e.exception.status), ('unauthorized', 401))

    def test_set_public_card_checks_the_owner_token_then_puts_and_never_stores_it(self):
        c = self.client()
        r = c.set_public_card(True, f' {OWNER_TOKEN}\n')
        self.assertEqual((r['mandate']['public_card'], r['changed']), (True, True))
        self.assertEqual(self.world.log, [('GET', '/pilot/v1/owner', None, OWNER_TOKEN),
                                          ('PUT', '/pilot/v1/owner/mandate', {'public_card': True}, OWNER_TOKEN)])
        self.assertTrue(self.world.card_public[ME])
        self.assertNotIn(OWNER_TOKEN, json.dumps(c.state))
        c.set_public_card(False, OWNER_TOKEN)
        self.assertFalse(self.world.card_public[ME])

    def test_set_public_card_with_another_token_or_bad_arguments_changes_nothing(self):
        for token in (BOBS_OWNER_TOKEN, AGENT_TOKEN):           # another participant's owner token; the agent's token (404)
            with self.assertRaises(vc.ValunError) as e:
                self.client().set_public_card(True, token)
            self.assertEqual(e.exception.code, 'not_owner', token)
        for on, token, code in ((1, OWNER_TOKEN, 'invalid_field'), ('yes', OWNER_TOKEN, 'invalid_field'), (True, ' ', 'bad_arguments'),
                                (True, None, 'bad_arguments')):
            with self.assertRaises(vc.ValunError) as e:
                self.client().set_public_card(on, token)
            self.assertEqual(e.exception.code, code)
        self.assertFalse(any(m == 'PUT' for m, _p in self.paths()))
        self.assertEqual(self.world.card_public, {BOB: True, HIDDEN: True, ME: False})


class CheckPayerTool(Card):
    def check(self, **args):
        return self.agent().call_safe('valun_check_payer', args)

    def test_the_summary_for_accept_ask_owner_decline_and_not_public(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=%d&payee={ME}'
        self.assertEqual(self.check(payer='bob', amount=18)['summary'], SUMMARY_ACCEPT)
        self.world.routes[route % 30] = (200, verdict('ask_owner', ['within its budget (13 of 40 left)', 'its owner approves each IOU above 25'],
                                                      amount=30, rule='approve_above', approval_needed=True, cover={'covered': 0, 'guarantees': []}))
        self.assertEqual(self.check(payer='bob', amount=30)['summary'], SUMMARY_ASK)
        self.world.routes[route % 45] = (200, verdict('decline', ['above its limit per deal (30)', 'more than the room it has left (31)'],
                                                      amount=45, rule='max_issue_per_deal', cover=NO_COVER_SHOWN))
        self.assertEqual(self.check(payer='bob', amount=45)['summary'], SUMMARY_DECLINE)
        self.world.card_public[BOB] = False
        r = self.check(payer='bob', amount=18)
        self.assertEqual(r, {'summary': SUMMARY_NOT_PUBLIC, 'verdict': 'unknown', 'reasons': ["the payer's owner has not published a budget card"],
                             'rule': None, 'payer': {'id': BOB, 'handle': 'bob'}, 'amount': 18})
        self.assertNotIn('error', r)

    def test_the_summary_without_reasons_and_for_a_verdict_this_client_does_not_know(self):
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': []}), "Accept: its owner's budget card allows this IOU.")
        self.assertEqual(va.check_summary({'verdict': 'ask_owner'}), "Ask owner: an owner's approval is needed for an IOU this size.")
        self.assertEqual(va.check_summary({'verdict': 'decline', 'reasons': None}), "Decline: its owner's budget card does not allow this IOU.")
        self.assertEqual(va.check_summary({'verdict': 'maybe', 'reasons': ['unsure']}), 'Unknown: unsure.')
        self.assertEqual(va.check_summary(None), 'Unknown: the server gave no verdict this client knows.')
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': [' within\nits budget.. ', 3, '', 'fine;']}),
                         'Accept: within its budget, fine.')

    def test_the_summary_names_the_cover_only_when_it_is_shown_and_above_0(self):
        s = lambda verdict, covered: va.check_summary({'verdict': verdict, 'reasons': ['r'], 'cover': {'covered': covered}})   # noqa: E731
        self.assertEqual(s('accept', 3), 'Accept: r, backed for you up to 3.')
        self.assertEqual(s('ask_owner', 2), 'Ask owner: r, backed for you up to 2.')
        for covered in (None, 0, -1, 2.5, True, '3', 2 ** 53):          # null is "not shown", never 0
            self.assertEqual(s('accept', covered), 'Accept: r.', covered)
        self.assertEqual(s('decline', 3), 'Decline: r.', 'a declined IOU would not be issued: its cover is not named')
        self.assertEqual(va.check_summary({'verdict': 'accept', 'cover': {'covered': 3}}),
                         "Accept: its owner's budget card allows this IOU, backed for you up to 3.")

    def test_the_new_decline_rules_read_as_other_declines(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=%d&payee={ME}'
        self.world.routes[route % 18] = (200, verdict('decline', ['bob has no active agent key, so it cannot sign an IOU'], rule='no_agent'))
        r = self.check(payer='bob', amount=18)
        self.assertEqual((r['summary'], r['rule']), ('Decline: bob has no active agent key, so it cannot sign an IOU.', 'no_agent'))
        self.world.routes[route % 5000] = (200, verdict('decline', ["5000 is above the network's limit per deal (1000)."], amount=5000,
                                                        rule='network_limit', cover=NO_COVER_SHOWN))
        r = self.check(payer='bob', amount=5000)
        self.assertEqual((r['summary'], r['rule']), ("Decline: 5000 is above the network's limit per deal (1000).", 'network_limit'))

    def test_the_answer_is_the_servers_verdict_with_the_summary_first(self):
        self.world.routes[f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}'] = (200, verdict(summary='Decline: not ours'))
        r = self.check(payer='bob', amount=18)
        self.assertEqual(list(r)[0], 'summary')
        self.assertEqual(r['summary'], SUMMARY_ACCEPT, "the server's own summary is replaced")
        self.assertEqual({k: v for k, v in r.items() if k != 'summary'}, {k: v for k, v in verdict().items()})

    def test_a_refused_token_and_a_server_from_before_budget_cards_are_errors(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}'
        self.world.routes[route] = (401, {'error': 'unauthorized', 'message': 'missing or invalid token'})
        self.assertEqual(self.check(payer=BOB, amount=18)['error'], 'unauthorized')     # the check carried this agent's token
        self.world.routes[route] = (404, {'error': 'not_found', 'message': 'not found'})
        self.assertEqual(self.check(payer=BOB, amount=18), {'error': 'not_found', 'message': 'not found'})

    def test_it_is_read_only_never_asks_the_owner_and_sends_only_its_own_token(self):
        a = self.agent()
        self.assertIn('valun_check_payer', va.READ_ONLY_TOOLS)
        self.assertNotIn('valun_check_payer', va.SIGNING_TOOLS)
        self.assertFalse(a.is_commitment('valun_check_payer', {'payer': 'bob', 'amount': 18}))
        self.assertEqual(a.prepare('valun_check_payer', {'payer': 'bob', 'amount': 18}), {'args': {'payer': 'bob', 'amount': 18}, 'text': None})
        self.assertEqual(a.call('valun_check_payer', {'payer': 'bob', 'amount': 18})['cover'], COVER, 'its own cover, shown to it')
        self.assertEqual([(m, p, t) for m, p, _b, t in self.world.log],
                         [('GET', '/pilot/v1/participants', None), ('GET', f'/pilot/v1/participants/{BOB}/check?amount=18&payee={ME}', AGENT_TOKEN)])

    def test_the_amount_is_checked_as_valun_propose_checks_its_price(self):
        price = schemas.PROPOSE['parameters']['properties']['price']
        amount = schemas.CHECK_PAYER['parameters']['properties']['amount']
        self.assertEqual({k: v for k, v in amount.items() if k != 'description'}, {k: v for k, v in price.items() if k != 'description'})
        self.assertEqual(schemas.CHECK_PAYER['parameters']['required'], ['payer', 'amount'])
        for bad in (1.5, '18', True, 0, -2, None):
            r = self.check(payer='bob', amount=bad)
            with self.assertRaises(vc.ValunError) as e:
                va._count('amount', bad, 'PC')
            self.assertEqual(r, {'error': 'bad_arguments', 'message': str(e.exception)}, bad)
        self.assertEqual(self.world.log, [], 'refused before anything is read')
        self.assertEqual(self.check(payer=5, amount=18)['error'], 'bad_arguments')
        self.assertEqual(self.check(amount=18), {'error': 'bad_arguments', 'message': 'missing argument: payer (the handle or participant id of '
                                                                                      'the agent that would owe you)'})

    def test_the_description_tells_the_model_when_to_run_it(self):
        d = schemas.CHECK_PAYER['description']
        self.assertTrue(d.startswith('Run this before you accept an IOU (a credit note) from an agent you do not know'))
        self.assertIn('Read-only', d)
        testnet = schemas.for_network(schemas.TESTNET)[-1]
        self.assertEqual(testnet['name'], 'valun_check_payer')
        self.assertNotRegex(json.dumps(testnet), r'\bPC\b|pilot')
        self.assertIn('in nanoERG of Ergo testnet', testnet['parameters']['properties']['amount']['description'])

    def test_unknown_payers_and_errors_pass_through(self):
        self.assertEqual(self.check(payer='nobody', amount=18)['error'], 'unknown_participant')
        self.assertEqual(self.check(payer='vp_0123456789ab', amount=18)['error'], 'not_found')
        self.assertEqual(self.agent(joined=False).call_safe('valun_check_payer', {'payer': 'bob', 'amount': 18})['error'], 'not_connected')


class StatusRoom(Card):
    def test_status_shows_the_room_get_me_shows_in_the_full_and_brief_views(self):
        self.assertNotIn('room', self.agent().call('valun_status', {}))
        self.world.me['room'] = {'outstanding': 9, 'room_left': 91}
        full = self.agent().call('valun_status', {})
        self.assertEqual(full['room'], {'outstanding': 9, 'room_left': 91})
        keys = list(full)
        self.assertEqual(keys[keys.index('position') + 1], 'room')
        self.assertEqual(self.agent().call('valun_status', {'brief': True})['room'], {'outstanding': 9, 'room_left': 91})
        self.world.me['room'] = 'lots'
        self.assertNotIn('room', self.agent().call('valun_status', {}))


class MissingArguments(Card):
    """Fix inbox #58: a missing (or null) required argument is bad_arguments with a plain message, never internal_error."""

    def test_valun_respond_without_deal_id_or_action(self):
        a = self.agent()
        self.assertEqual(a.call_safe('valun_respond', {'deal_id': 'vd_1111111111111111'}),
                         {'error': 'bad_arguments', 'message': 'missing argument: action (accept, decline, counter or withdraw); nothing was signed'})
        self.assertEqual(a.call_safe('valun_respond', {'action': 'accept'})['message'],
                         'missing argument: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it); nothing was signed')
        self.assertEqual(a.call_safe('valun_respond', {'deal_id': None, 'action': None})['message'],
                         'missing arguments: deal_id (the deal id, vd_ + 16 hex, as valun_inbox lists it), action (accept, decline, counter '
                         'or withdraw); nothing was signed')
        self.assertEqual(a.call_safe('valun_respond', ['vd_1111111111111111', 'accept']),
                         {'error': 'bad_arguments', 'message': 'the arguments are not a JSON object; nothing was signed'})
        self.assertEqual(self.world.log, [])

    def test_the_other_tools_that_failed_on_a_missing_argument(self):
        a = self.agent()
        brief = {'counterparty': 'bob', 'role': 'payer', 'title': 'Brief', 'description': 'A brief.', 'deliverable': 'Markdown', 'price': 5}
        for tool, args, missing in (('valun_deal', {}, 'deal_id'), ('valun_deliver', {'content': 'x' * 300}, 'deal_id'),
                                    ('valun_deliver', {'exact_result': True}, 'deal_id'),
                                    ('valun_review_delivery', {'decision': 'accept'}, 'deal_id'),
                                    ('valun_review_delivery', {'decision': 'dispute', 'reason': 'Wrong.'}, 'deal_id'),
                                    ('valun_propose', {k: v for k, v in brief.items() if k != 'title'}, 'title'),
                                    ('valun_propose', dict(brief, role=None), 'role')):
            r = a.call_safe(tool, args)
            self.assertEqual(r['error'], 'bad_arguments', (tool, args))
            self.assertTrue(r['message'].startswith(f'missing argument: {missing} ('), r['message'])
        r = a.call_safe('valun_propose', {k: v for k, v in brief.items() if k != 'price'})
        self.assertEqual(r, {'error': 'bad_arguments', 'message': 'price must be a whole number of PC, at least 1 (a JSON integer), not null; '
                                                                  'nothing was signed'})
        self.assertEqual(self.world.log, [], 'refused before anything is read')

    def test_an_offer_missing_a_text_is_never_put_to_the_owner(self):
        brief = {'counterparty': 'bob', 'role': 'payer', 'title': 'Brief', 'deliverable': 'Markdown', 'price': 5}
        prepared, refusal = self.agent().prepare_or_refusal('valun_propose', brief)
        self.assertIsNone(prepared)
        self.assertEqual((refusal['error'], refusal['cause']), ('approval_unbound', 'bad_arguments'))


class CardCommands(Card):
    """`valun card [WHO] | check PAYER AMOUNT | publish | unpublish`, on a profile in a temporary VALUN_HOME."""

    def setUp(self):
        super().setUp()
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': self.home.name})
        env.start()
        self.addCleanup(env.stop)
        os.makedirs(os.path.join(self.home.name, 'profiles'))
        self.profile = os.path.join(self.home.name, 'profiles', 's.json')
        with open(self.profile, 'w', encoding='utf-8') as f:
            json.dump({'server': SERVER, 'participant_id': ME, 'pubkey': '02' + '11' * 32, 'secret': '11' * 32,
                       'agent_token': AGENT_TOKEN, 'approvals': 'ask'}, f)
        self.token_file = os.path.join(self.home.name, 'owner.txt')
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write(OWNER_TOKEN + '\n')

    def run_cli(self, *argv, profile='s'):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['--profile', profile, 'card', *argv])
        return rc, out.getvalue()

    def test_show_a_card_or_say_it_is_not_public(self):
        rc, out = self.run_cli('bob')
        self.assertEqual((rc, json.loads(out)), (0, CARD))
        rc, out = self.run_cli()
        self.assertEqual(rc, 1)
        self.assertIn('Your budget card is not public.', out)
        self.assertIn('`valun --profile s card publish --owner-token-file FILE`', out)
        self.world.card_public[BOB] = False
        self.assertEqual(self.run_cli('bob'), (1, "bob's owner has not published a budget card.\n"))
        rc, out = self.run_cli(HIDDEN, profile='nobody')          # another's card needs no joined profile
        self.assertEqual((rc, json.loads(out)['card_hash']), (0, CARD['card_hash']))
        self.assertEqual(self.run_cli(profile='nobody')[0], 1)    # one's own does
        self.assertEqual(json.loads(self.run_cli('nobody')[1])['error'], 'unknown_participant')

    def test_check_prints_the_tools_answer_and_exits_0_only_for_accept(self):
        rc, out = self.run_cli('check', 'bob', '18')
        self.assertEqual((rc, json.loads(out)['summary']), (0, SUMMARY_ACCEPT))
        self.world.routes[f'GET /pilot/v1/participants/{BOB}/check?amount=45&payee={ME}'] = (
            200, verdict('decline', ['above its limit per deal (30)', 'more than the room it has left (31)'], amount=45))
        rc, out = self.run_cli('check', 'bob', '45')
        self.assertEqual((rc, json.loads(out)['summary']), (1, SUMMARY_DECLINE))
        self.world.card_public[BOB] = False
        rc, out = self.run_cli('check', 'bob', '18')
        self.assertEqual((rc, json.loads(out)['verdict'], json.loads(out)['summary']), (1, 'unknown', SUMMARY_NOT_PUBLIC))
        self.assertEqual(self.run_cli('check', 'bob', '1.5')[0], 2)
        self.assertEqual(json.loads(self.run_cli('check', 'bob', '0')[1])['error'], 'bad_arguments')
        self.assertEqual(self.run_cli('check', 'bob', '18', profile='nobody')[0], 1)

    def test_publish_and_unpublish_use_the_owner_token_once(self):
        rc, out = self.run_cli('publish', '--owner-token-file', self.token_file)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'Your budget card is public: {SERVER}/agent/bob', out)    # the page the card names
        self.assertIn('`valun --profile s card unpublish --owner-token-file FILE`', out)
        self.assertTrue(self.world.card_public[ME])
        self.assertEqual([(m, p, t) for m, p, _b, t in self.world.log[:2]],
                         [('GET', '/pilot/v1/owner', OWNER_TOKEN), ('PUT', '/pilot/v1/owner/mandate', OWNER_TOKEN)])
        with open(self.profile, encoding='utf-8') as f:
            self.assertNotIn(OWNER_TOKEN, f.read())
        rc, out = self.run_cli('unpublish', '--owner-token-file', self.token_file)
        self.assertEqual(rc, 0, out)
        self.assertIn('no longer public', out)
        self.assertFalse(self.world.card_public[ME])

    def test_publish_with_another_participants_token_or_on_a_server_without_cards(self):
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write(BOBS_OWNER_TOKEN)
        rc, out = self.run_cli('publish', '--owner-token-file', self.token_file)
        self.assertEqual(rc, 1)
        self.assertIn('(not_owner)', out)
        self.assertFalse(any(m == 'PUT' for m, _p in self.paths()))
        with open(self.token_file, 'w', encoding='utf-8') as f:
            f.write(OWNER_TOKEN)
        self.world.put_answer = {'mandate': dict(MANDATE), 'mandate_version': 3, 'changed': False}   # the field ignored
        rc, out = self.run_cli('publish', '--owner-token-file', self.token_file)
        self.assertEqual(rc, 1)
        self.assertIn('may not offer budget cards', out)
        rc, out = self.run_cli('publish', '--owner-token-file', os.path.join(self.home.name, 'missing.txt'))
        self.assertEqual(rc, 1)
        self.assertIn('Cannot read the owner token file', out)

    def test_usage(self):
        for argv in (('check', 'bob'), ('check',), ('bob', 'erin'), ('publish', 'now'), ('check', 'bob', '1', '2')):
            rc, out = self.run_cli(*argv)
            self.assertEqual((rc, out.strip()), (2, cli.CARD_USAGE), argv)
        self.assertEqual(self.world.log, [])


if __name__ == '__main__':
    unittest.main()
