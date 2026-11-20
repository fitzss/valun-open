"""Budget cards, against a fake Valun server (offline): an owner may publish its agent's budget card, anyone can read it
(Client.card) and check a payment against it (Client.check_payer, the read-only tool valun_check_payer, `valun card
check`), the owner publishes or hides it with its owner token (Client.set_public_card, `valun card publish|unpublish`),
and valun_status shows the agent's room. Also fix inbox #58: a tool called without a required argument answers
bad_arguments with a plain message, not internal_error; and fix inbox #60: the offer under review (valun_check_payer
deal_id, Client.check_payer deal_id, `valun card check --deal`), counted once, the summary of a new deal at the price
of an offer the payer's outstanding already counts, and `valun card check`, which exits 0 only when the payee's own side
of the step (payee_side) goes ahead too. The same over a recorded server, value for value in the
JavaScript client: the 'check_payer:', 'card:', 'set_public_card:' and #58 scenarios of
js/test/fixtures/generate_python_fixtures.py."""
import contextlib
import io
import json
import os
import re
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
SUMMARY_ACCEPT = 'Accept: within its budget (31 of 40 left), guaranteed for you up to 3.'
SUMMARY_ASK = 'Ask the payer\'s owner: within its budget (13 of 40 left), its owner approves each IOU above 25.'
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
        self.ignores_deal = False       # a server from before fix inbox #60: deal= is ignored
        self.extra = {}                 # more fields of a check's answer without deal= (counted_offers, payee_side)

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
            query = dict(kv.split('=', 1) for kv in path.split('?', 1)[1].split('&'))
            payee = query['payee']
            own = token == AGENT_TOKEN and payee == ME          # the payee's own token: only it sees its cover
            if 'deal' in query and not self.ignores_deal:      # fix inbox #60: the offer under review, the payee's only
                if not own:
                    raise vc.ValunError('not_payee', "deal= is answered only to the payee: send the check with the payee's agent or "
                                                     'owner token', 403)
                return verdict(payee=payee, cover=COVER, deal_id=query['deal'])
            return verdict(payee=payee, cover=COVER if own else NO_COVER_SHOWN, **self.extra)
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
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': []}), "Accept: its owner's budget card allows this note.")
        self.assertEqual(va.check_summary({'verdict': 'ask_owner'}), "Ask the payer\'s owner: the payer\'s owner approves a note this size before it binds.")
        self.assertEqual(va.check_summary({'verdict': 'decline', 'reasons': None}), "Decline: its owner's budget card does not allow this note.")
        self.assertEqual(va.check_summary({'verdict': 'maybe', 'reasons': ['unsure']}), 'Unknown: unsure.')
        self.assertEqual(va.check_summary(None), 'Unknown: the server gave no verdict this client knows.')
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': [' within\nits budget.. ', 3, '', 'fine;']}),
                         'Accept: within its budget, fine.')

    def test_the_summary_names_the_cover_only_when_it_is_shown_and_above_0(self):
        s = lambda verdict, covered: va.check_summary({'verdict': verdict, 'reasons': ['r'], 'cover': {'covered': covered}})   # noqa: E731
        self.assertEqual(s('accept', 3), 'Accept: r, guaranteed for you up to 3.')
        self.assertEqual(s('ask_owner', 2), 'Ask the payer\'s owner: r, guaranteed for you up to 2.')
        for covered in (None, 0, -1, 2.5, True, '3', 2 ** 53):          # null is "not shown", never 0
            self.assertEqual(s('accept', covered), 'Accept: r.', covered)
        self.assertEqual(s('decline', 3), 'Decline: r.', 'a declined IOU would not be issued: its cover is not named')
        self.assertEqual(va.check_summary({'verdict': 'accept', 'cover': {'covered': 3}}),
                         "Accept: its owner's budget card allows this note, guaranteed for you up to 3.")

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
        for bad in (1.5, '18', True, 0, -2):
            r = self.check(payer='bob', amount=bad)
            with self.assertRaises(vc.ValunError) as e:
                va._count('amount', bad, 'PC')
            self.assertEqual(r, {'error': 'bad_arguments', 'message': str(e.exception)}, bad)
        # a null amount is a missing one (fix inbox #58: the tool's schema requires it)
        self.assertEqual(self.check(payer='bob', amount=None), {'error': 'bad_arguments', 'message': (
            "missing argument: amount (what it would owe you, the deal's price: a whole number, at least 1)")})
        self.assertEqual(self.world.log, [], 'refused before anything is read')
        self.assertEqual(self.check(payer=5, amount=18)['error'], 'bad_arguments')
        self.assertEqual(self.check(amount=18), {'error': 'bad_arguments', 'message': 'missing argument: payer (the handle or participant id of '
                                                                                      'the agent that would owe you)'})

    def test_the_description_tells_the_model_when_to_run_it(self):
        d = schemas.CHECK_PAYER['description']
        self.assertTrue(d.startswith('Run this before you accept a note from an agent you do not know'))
        self.assertIn('Read-only', d)
        testnet = schemas.for_network(schemas.TESTNET)[-1]
        self.assertEqual(testnet['name'], 'valun_check_payer')
        self.assertNotRegex(json.dumps(testnet), r'\bPC\b|pilot')
        self.assertIn('in nanoERG of Ergo testnet', testnet['parameters']['properties']['amount']['description'])

    def test_unknown_payers_and_errors_pass_through(self):
        self.assertEqual(self.check(payer='nobody', amount=18)['error'], 'unknown_participant')
        self.assertEqual(self.check(payer='vp_0123456789ab', amount=18)['error'], 'not_found')
        self.assertEqual(self.agent(joined=False).call_safe('valun_check_payer', {'payer': 'bob', 'amount': 18})['error'], 'not_connected')


OFFER, OTHER_OFFER = 'vd_' + '6a' * 8, 'vd_' + '7b' * 8
# The server's own reason for an offer its outstanding counts (valun-app lib/pilot/card.mjs checkPayer, fix inbox #60).
COUNTED_REASON = (f'Its open offer to you ({OFFER}: 18) is already counted in its outstanding: this answer is for a new deal on top. '
                  'To check an offer you received, ask again with deal=<its id>.')


class OfferUnderReview(Card):
    """Fix inbox #60: valun_check_payer's deal_id, the offer under review (deal=), which the server counts once; and the
    summary of a new deal at the price of an offer the payer made this agent, which its outstanding already counts."""

    def check(self, **args):
        return self.agent().call_safe('valun_check_payer', args)

    def test_deal_id_is_sent_as_deal_with_this_agents_token_and_the_answer_names_it(self):
        r = self.check(payer='bob', amount=18, deal_id=OFFER)
        self.assertEqual(self.world.log[-1], ('GET', f'/pilot/v1/participants/{BOB}/check?amount=18&payee={ME}&deal={OFFER}', None, AGENT_TOKEN))
        self.assertEqual((r['deal_id'], r['summary']), (OFFER, SUMMARY_ACCEPT))
        self.assertEqual({k: v for k, v in r.items() if k != 'summary'}, verdict(deal_id=OFFER))
        self.assertEqual(self.client().check_payer('bob', 18, deal_id=OFFER)['deal_id'], OFFER)
        self.client().check_payer('bob', 18, deal_id=None)
        self.assertNotIn('deal=', self.world.log[-1][1], 'null: a new deal')

    def test_a_deal_id_that_is_not_one_is_refused_before_any_read(self):
        for bad in ('vd_123', OFFER.upper(), OFFER + '\n', ' ' + OFFER, '', 5, True, [OFFER], {'deal_id': OFFER}):
            r = self.check(payer='bob', amount=18, deal_id=bad)
            self.assertEqual(r['error'], 'bad_arguments', bad)
            self.assertTrue(r['message'].startswith('deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as '
                                                    'valun_inbox lists it, not '), r['message'])
            with self.assertRaises(vc.ValunError) as e:
                self.client().check_payer('bob', 18, deal_id=bad)
            self.assertEqual((e.exception.code, str(e.exception)), ('bad_arguments', 'deal_id must be a deal id, vd_ and 16 hex digits; '
                                                                                     'nothing was read'))
        self.assertEqual(self.world.log, [])

    def test_a_server_that_ignores_deal_is_never_taken_for_the_offers_answer(self):
        self.world.ignores_deal = True              # a server from before fix inbox #60 answers for a new deal on top
        r = self.check(payer='bob', amount=18, deal_id=OFFER)
        self.assertEqual(r, {'error': 'offer_not_checked', 'message': f'this Valun server does not check the offer under review ({OFFER}): its '
                                                                      'answer is for a new deal on top of that offer, which it counts twice'})
        with self.assertRaises(vc.ValunError) as e:
            self.client().check_payer('bob', 18, deal_id=OFFER)
        self.assertEqual(e.exception.code, 'offer_not_checked')
        self.world.ignores_deal = False
        self.world.routes[f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}&deal={OFFER}'] = (200, verdict(deal_id=OTHER_OFFER))
        self.assertEqual(self.check(payer='bob', amount=18, deal_id=OFFER)['error'], 'offer_not_checked', 'an answer for another deal')

    def test_the_servers_refusals_of_deal_pass_through(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}&deal={OFFER}'
        for status, code in ((409, 'wrong_state'), (400, 'invalid_field'), (404, 'not_found'), (403, 'not_payee')):
            self.world.routes[route] = (status, {'error': code, 'message': f'the server says {code}'})
            self.assertEqual(self.check(payer='bob', amount=18, deal_id=OFFER), {'error': code, 'message': f'the server says {code}'})
        with self.assertRaises(vc.ValunError) as e:             # another payee: the server answers deal= only to the payee
            self.client().check_payer('bob', 18, payee='erin', deal_id=OFFER)
        self.assertEqual((e.exception.code, e.exception.status), ('not_payee', 403))
        del self.world.routes[route]
        self.world.card_public[BOB] = False
        r = self.check(payer='bob', amount=18, deal_id=OFFER)
        self.assertEqual((r['verdict'], r['deal_id'], r['summary']), ('unknown', OFFER, SUMMARY_NOT_PUBLIC))

    def test_a_new_deal_at_the_price_of_an_offer_it_made_you_says_so_and_how_to_check_the_offer(self):
        route = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}'
        self.world.routes[route] = (200, verdict('decline', ['Over its budget: it has 4 of 40 left, less than 18.', COUNTED_REASON],
                                                 cover=NO_COVER_SHOWN, counted_offers=[{'deal_id': OFFER, 'amount': 18}]))
        r = self.check(payer='bob', amount=18)
        # 0.7.2: the server's second sentence follows the first after a stop (0.7.1: after a comma, mid-line)
        self.assertEqual(r['summary'], f'Decline, for a new deal on top of the offer you received at this price ({OFFER}, already counted): '
                                       'Over its budget: it has 4 of 40 left, less than 18. ' + COUNTED_REASON.rstrip('.') +
                         f'. To check that offer itself, call valun_check_payer again with deal_id {OFFER}.')
        self.assertEqual(r['counted_offers'], [{'deal_id': OFFER, 'amount': 18}], 'the answer itself is the server\'s')
        self.assertEqual(r['verdict'], 'decline')
        # the call the summary gives answers for the offer, counted once
        self.assertEqual(self.check(payer='bob', amount=18, deal_id=OFFER)['summary'], SUMMARY_ACCEPT)

    def test_the_counted_offers_the_summary_names(self):
        s = lambda offers, amount=18, **more: va.check_summary({'verdict': 'accept', 'reasons': ['r'], 'amount': amount,   # noqa: E731
                                                                 'counted_offers': offers, **more})
        one = f'Accept, for a new deal on top of the offer you received at this price ({OFFER}, already counted): r. To check that ' \
              f'offer itself, call valun_check_payer again with deal_id {OFFER}.'
        self.assertEqual(s([{'deal_id': OFFER, 'amount': 18}]), one)
        self.assertEqual(s([{'deal_id': OTHER_OFFER, 'amount': 25}, {'deal_id': OFFER, 'amount': 18}]), one, 'only those at this price')
        self.assertEqual(s([{'deal_id': OFFER, 'amount': 18}, {'deal_id': OTHER_OFFER, 'amount': 18}]),
                         f'Accept, for a new deal on top of the 2 offers you received at this price ({OFFER}, {OTHER_OFFER}, already counted): '
                         'r. To check one of them, call valun_check_payer again with its deal_id.')
        for offers in ([{'deal_id': OTHER_OFFER, 'amount': 25}], [], None, {'deal_id': OFFER, 'amount': 18}, [OFFER],
                       [{'deal_id': OFFER.upper(), 'amount': 18}], [{'deal_id': 'vd_1', 'amount': 18}], [{'deal_id': OFFER, 'amount': '18'}],
                       [{'deal_id': OFFER, 'amount': True}], [{'deal_id': OFFER}], [{'amount': 18}]):
            self.assertEqual(s(offers), 'Accept: r.', offers)
        self.assertEqual(s([{'deal_id': OFFER, 'amount': 18}], deal_id=OFFER), 'Accept: r.', 'an answer for the offer itself')
        self.assertEqual(s([{'deal_id': OFFER, 'amount': 18}], amount='18'), 'Accept: r.', 'no amount checked')
        self.assertEqual(s([{'deal_id': OFFER, 'amount': 2 ** 53}], amount=2 ** 53), 'Accept: r.', 'not an amount a client signs')
        self.assertEqual(va.offers_counted_at({'amount': 18, 'counted_offers': [{'deal_id': OFFER, 'amount': 18}]}), [OFFER])
        self.assertEqual(va.offers_counted_at(None), [])

    def test_your_own_side_ends_the_summary_when_it_would_not_simply_go_ahead(self):
        s = lambda side: va.check_summary({'verdict': 'accept', 'reasons': ['r'], 'payee_side': side})   # noqa: E731
        self.assertEqual(s({'verdict': 'decline', 'rule': 'max_accept_per_deal', 'reasons': ['Your own limits refuse it (max_accept_per_deal): '
                                                                                           'over your limit.']}),
                         'Accept: r. Your own side: Your own limits refuse it (max_accept_per_deal): over your limit.')
        self.assertEqual(s({'verdict': 'ask_owner', 'reasons': []}), 'Accept: r. Your own side: your owner approves it before it binds.')
        self.assertEqual(s({'verdict': 'decline'}), 'Accept: r. Your own side: your own limits refuse it.')
        for side in ({'verdict': 'accept', 'reasons': ['Your own limits allow it.']}, {'verdict': 'Decline'}, {'verdict': ['decline']},
                     'decline', None, {}):
            self.assertEqual(s(side), 'Accept: r.', side)
        self.world.extra = {'payee_side': {'verdict': 'decline', 'rule': 'min_price_as_payee', 'reasons': ['Your own limits refuse it.']}}
        self.assertEqual(self.check(payer='bob', amount=18)['summary'], SUMMARY_ACCEPT[:-1] + '. Your own side: Your own limits refuse it.')

    def test_the_schema_offers_deal_id_and_says_when_to_pass_it(self):
        p = schemas.CHECK_PAYER['parameters']
        self.assertEqual(p['required'], ['payer', 'amount'], 'deal_id is optional')
        self.assertEqual({k: v for k, v in p['properties']['deal_id'].items() if k != 'description'},
                         {'type': 'string', 'pattern': '^vd_[0-9a-f]{16}$'})
        self.assertIn('Pass that deal\'s deal_id', schemas.CHECK_PAYER['description'])
        self.assertIn('Without deal_id the answer is for a new deal on top of everything the payer has committed',
                      schemas.CHECK_PAYER['description'])
        testnet = schemas.for_network(schemas.TESTNET)[-1]
        self.assertEqual(testnet['parameters']['properties']['deal_id'], p['properties']['deal_id'])
        self.assertNotRegex(json.dumps(testnet), r'\bPC\b|pilot')


REPO = os.path.dirname(os.path.dirname(HERE))
# The valun release from which a tool reads each of these arguments. A valun from before ignores an argument it does not
# read, so a skill must not pass one to the valun it pins (fix inbox #60: valun 0.7.0's valun_check_payer ignores deal_id
# and answers for a new deal on top of the offer under review, counting that offer twice, with nothing to say so).
ARGUMENTS_SINCE = {('valun_check_payer', 'deal_id'): (0, 7, 1)}
# A skill's tool-call example, `valun_x` (`{...}`), and a valun pin (valun==X.Y.Z, valun[ai]==X.Y.Z).
TOOL_EXAMPLE = re.compile(r'`(valun_[a-z_]+)`\s*\(`(\{[^`]*\})`')
VALUN_PIN = re.compile(r'valun(?:\[[a-z,]+\])?==(\d+)\.(\d+)\.(\d+)')


def skill_problems(text, pins):
    """The arguments of ARGUMENTS_SINCE a skill's tool-call examples pass to a valun that does not read them: pins is
    every valun version the skill runs (its own and, for the Claude Code plugin, its .mcp.json's), as (X, Y, Z)."""
    out = []
    for tool, example in TOOL_EXAMPLE.findall(text):
        for arg in re.findall(r'"([a-z_]+)"\s*:', example):
            since = ARGUMENTS_SINCE.get((tool, arg))
            if since and (not pins or min(pins) < since):
                out.append(f'{tool} {arg} needs valun {".".join(map(str, since))}; the skill runs '
                           f'{", ".join(".".join(map(str, p)) for p in sorted(pins)) or "no pinned valun"}')
    return out


class SkillPins(unittest.TestCase):
    """The skills that pin a valun pass a tool only the arguments that valun reads: the server's (SKILL.md copies it) and
    the Claude Code plugin's, which the marketplace serves from main with the valun its .mcp.json pins. So the plugin's
    skill passes valun_check_payer's deal_id only from the commit that moves its pin to 0.7.1 (`release.py bump`),
    never on main before it (CHANGELOG.md 0.7.1, Server)."""

    def read(self, *parts):
        with open(os.path.join(REPO, *parts), encoding='utf-8') as f:
            return f.read()

    def skills(self):
        plugin = self.read('plugins', 'valun', 'skills', 'valun', 'SKILL.md')
        mcp = self.read('plugins', 'valun', '.mcp.json')
        root = self.read('SKILL.md')
        pins = lambda *texts: {tuple(map(int, v)) for t in texts for v in VALUN_PIN.findall(t)}   # noqa: E731
        return {'plugins/valun/skills/valun/SKILL.md': (plugin, pins(plugin, mcp)), 'SKILL.md': (root, pins(root))}

    def test_no_skill_passes_an_argument_its_pinned_valun_ignores(self):
        for rel, (text, pins) in self.skills().items():
            self.assertTrue(pins, f'{rel} pins no valun')
            self.assertIn('valun_check_payer', [t for t, _e in TOOL_EXAMPLE.findall(text)],
                          f'{rel}: no `valun_check_payer` (`{{...}}`) example found: TOOL_EXAMPLE should match how the skill writes one')
            self.assertEqual(skill_problems(text, pins), [], rel)

    def test_the_plugin_skill_with_deal_id_waits_for_its_pin_to_move(self):
        text = self.skills()['plugins/valun/skills/valun/SKILL.md'][0]
        old = '(`{"payer": "<handle>", "amount": <the price>}`)'
        self.assertIn(old, text)
        planted = text.replace(old, '(`{"payer": "<handle>", "amount": <the price>, "deal_id": "<the deal id>"}`)')
        self.assertEqual(skill_problems(planted, {(0, 7, 0)}), ['valun_check_payer deal_id needs valun 0.7.1; the skill runs 0.7.0'])
        self.assertEqual(skill_problems(planted, {(0, 7, 0), (0, 7, 1)}), ['valun_check_payer deal_id needs valun 0.7.1; the skill '
                                                                           'runs 0.7.0, 0.7.1'], 'every pin must read it')
        self.assertEqual(skill_problems(planted, {(0, 7, 1)}), [])
        self.assertEqual(skill_problems(planted, set()), ['valun_check_payer deal_id needs valun 0.7.1; the skill runs no pinned valun'])
        self.assertEqual(skill_problems(text, {(0, 7, 0)}), [], 'as it is now')


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
        self.assertEqual(r, {'error': 'bad_arguments', 'message': 'missing argument: price (the price: a whole number, at least 1); '
                                                                  'nothing was signed'})
        r = a.call_safe('valun_propose', dict(brief, price=1.5))       # a price that is there, but not a whole number
        self.assertEqual(r, {'error': 'bad_arguments', 'message': 'price must be a whole number of PC, at least 1 (a JSON integer), not 1.5; '
                                                                  'nothing was signed'})
        self.assertEqual(self.world.log, [], 'refused before anything is read')

    def test_an_offer_missing_a_text_is_never_put_to_the_owner(self):
        brief = {'counterparty': 'bob', 'role': 'payer', 'title': 'Brief', 'deliverable': 'Markdown', 'price': 5}
        a = self.agent()
        prepared, refusal = a.prepare_or_refusal('valun_propose', brief)
        self.assertIsNone(prepared)
        self.assertEqual(refusal, {'error': 'bad_arguments', 'message': 'missing argument: description (what exactly is to be done); '
                                                                        'nothing was signed'}, 'the refusal the call itself gives')
        with self.assertRaises(vc.ValunError) as e:
            a.prepare('valun_propose', brief)
        self.assertEqual((e.exception.code, e.exception.extra['cause']), ('approval_unbound', 'bad_arguments'))
        self.assertEqual(self.world.log, [], 'nothing is read for it')


class CliCard(Card):
    """`valun card ...` on a profile in a temporary VALUN_HOME (run_cli), over the fake server."""

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


class CardCommands(CliCard):
    """`valun card [WHO] | check PAYER AMOUNT | publish | unpublish`, on a profile in a temporary VALUN_HOME."""

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

    def test_check_with_deal_checks_the_offer_under_review(self):
        rc, out = self.run_cli('check', 'bob', '18', '--deal', OFFER)
        self.assertEqual((rc, json.loads(out)['deal_id'], json.loads(out)['summary']), (0, OFFER, SUMMARY_ACCEPT))
        self.assertEqual(self.world.log[-1][1], f'/pilot/v1/participants/{BOB}/check?amount=18&payee={ME}&deal={OFFER}')
        self.world.ignores_deal = True
        rc, out = self.run_cli('check', 'bob', '18', '--deal', OFFER)
        self.assertEqual((rc, json.loads(out)['error']), (1, 'offer_not_checked'))
        n = len(self.world.log)
        for bad in ('vd_123', OFFER.upper(), ''):
            rc, out = self.run_cli('check', 'bob', '18', '--deal', bad)
            self.assertEqual(rc, 2, bad)
            self.assertIn('--deal must be a deal id', out)
        for argv in (('bob', '--deal', OFFER), ('publish', '--deal', OFFER), ('--deal', OFFER)):
            rc, out = self.run_cli(*argv)
            self.assertEqual((rc, out.strip()), (2, cli.CARD_USAGE), argv)
        self.assertEqual(len(self.world.log), n, 'nothing read for any of them')
        self.assertIn('[--deal vd_...]', cli.CARD_USAGE)

    def test_check_exits_0_only_when_your_own_side_goes_ahead_too(self):
        # Fix inbox #60: the server shows the payee itself its own side of the step (payee_side). The payer's accept is no
        # go-ahead when the payee's own limits refuse the step (accepting the offer then answers mandate_exceeded) or its
        # owner decides first, so the exit code is 1 then, as for the payer's own ask_owner or decline.
        refused = {'verdict': 'decline', 'rule': 'max_accept_per_deal',
                   'reasons': ['Your own limits refuse it (max_accept_per_deal): price 18 exceeds max_accept_per_deal 4.']}
        held = {'verdict': 'ask_owner', 'rule': 'approve_above',
                'reasons': ['Your own limits allow it.', 'Your owner approves each commitment above 10 PC: your acceptance waits for '
                                                         'your owner before it binds.']}
        allowed = {'verdict': 'accept', 'rule': None, 'reasons': ['Your own limits allow it.']}
        offer = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}&deal={OFFER}'
        new = f'GET /pilot/v1/participants/{BOB}/check?amount=18&payee={ME}'
        for side, rc in ((refused, 1), (held, 1), (allowed, 0)):
            self.world.routes[offer] = (200, verdict(deal_id=OFFER, payee_side=side))
            self.world.routes[new] = (200, verdict(payee_side=side))
            for argv in (('check', 'bob', '18', '--deal', OFFER), ('check', 'bob', '18')):
                got, out = self.run_cli(*argv)
                r = json.loads(out)
                self.assertEqual((got, r['verdict'], r['payee_side']), (rc, 'accept', side), (argv, side['verdict']))
        self.world.routes[offer] = (200, verdict(deal_id=OFFER, payee_side=refused))
        self.assertEqual(json.loads(self.run_cli('check', 'bob', '18', '--deal', OFFER)[1])['summary'],
                         SUMMARY_ACCEPT[:-1] + '. Your own side: ' + refused['reasons'][0], 'the summary says why')
        # A payee_side this client cannot read as accept fails closed; with the payer's decline, its own accept is no help.
        for side in ('accept', ['accept'], {}, {'verdict': 'Accept'}, {'verdict': None}, {'verdict': ['accept']},
                     {'reasons': ['Your own limits allow it.']}, 0, False):
            self.world.routes[offer] = (200, verdict(deal_id=OFFER, payee_side=side))
            self.assertEqual(self.run_cli('check', 'bob', '18', '--deal', OFFER)[0], 1, side)
        for v in ('decline', 'ask_owner', 'unknown'):
            self.world.routes[offer] = (200, verdict(v, deal_id=OFFER, payee_side=allowed))
            self.assertEqual(self.run_cli('check', 'bob', '18', '--deal', OFFER)[0], 1, v)
        # A server that shows no payee_side (one from before #60): the payer's verdict alone decides, as in 0.7.0.
        for extra in ({}, {'payee_side': None}):
            self.world.routes[offer] = (200, verdict(deal_id=OFFER, **extra))
            self.assertEqual(self.run_cli('check', 'bob', '18', '--deal', OFFER)[0], 0, extra)

    def test_usage(self):
        for argv in (('check', 'bob'), ('check',), ('bob', 'erin'), ('publish', 'now'), ('check', 'bob', '1', '2')):
            rc, out = self.run_cli(*argv)
            self.assertEqual((rc, out.strip()), (2, cli.CARD_USAGE), argv)
        self.assertEqual(self.world.log, [])


# Fix inbox #87: answers of the server's own code to the payee's own check, recorded with what valun 0.7.2 makes of
# them; the JavaScript client is held to the same file (js/test/budget-card.test.js).
with open(os.path.join(HERE, 'fixtures', 'check-sides.json'), encoding='utf-8') as _f:
    SIDES = json.load(_f)
BOTH = {'verdict': 'accept', 'rule': None, 'reasons': ['Within its budget.']}


class BothSides(CliCard):
    """Fix inbox #87, the client side: a server that gives the payee's own check one verdict for the step from both sides
    (payer_side, payee_side) gets a summary that leads with it, names whose owner decides an ask_owner, and says the
    cover once, in the server's words (payee_side), never adding its own; `valun card check` exits 0 only when both
    sides go ahead. A server from before #87 (no payer_side) is read as 0.7.1 read it. In both, a sentence of the server's
    follows the one before after a stop, not a comma."""

    def check(self, **args):
        return self.agent().call_safe('valun_check_payer', args)

    def serve(self, case):
        self.world.routes[f"GET {SIDES['request']['path']}"] = (case['status'], case['body'])

    def test_the_recorded_answers_summary_tool_answer_and_exit_code(self):
        self.assertEqual(len(SIDES['cases']), 11)
        req = SIDES['request']
        for case in SIDES['cases']:
            with self.subTest(case['name']):
                self.serve(case)
                r = self.check(payer=req['payer'], amount=req['amount'])
                self.assertEqual(r['summary'], case['summary'])
                if case['status'] == 200:
                    self.assertEqual(va.check_summary(case['body']), case['summary'])
                    self.assertEqual(list(r)[0], 'summary')
                    self.assertEqual({k: v for k, v in r.items() if k != 'summary'}, case['body'], "the rest is the server's answer")
                else:
                    self.assertEqual((r['verdict'], r['payer']), ('unknown', {'id': BOB, 'handle': 'bob'}))
                rc, out = self.run_cli('check', req['payer'], str(req['amount']))
                self.assertEqual((rc, json.loads(out)['summary']), (case['exit'], case['summary']))
        self.assertEqual([c['name'] for c in SIDES['cases'] if c['exit'] == 0], ['accept with cover', 'old server: accept with cover'])

    def test_the_lead_is_the_steps_verdict_and_the_cover_is_the_servers_sentence_said_once(self):
        leads = {'accept': 'Accept: ', 'decline': 'Decline: ', 'unknown': 'Unknown: '}
        for case in SIDES['cases']:
            b = case['body']
            if case['status'] != 200 or 'payer_side' not in b:
                continue
            with self.subTest(case['name']):
                want = leads.get(b['verdict']) or f"{va.CHECK_ASK_LEAD[va.check_owners(b)]}: "
                self.assertTrue(case['summary'].startswith(want + b['reasons'][0][:-1] + '. '), case['summary'])
                said = [x for x in b['payee_side']['reasons'] if x.startswith('Backed for you')]
                self.assertEqual(case['summary'].lower().count('backed for you'), len(said))
                self.assertLessEqual(len(said), 1)
                self.assertTrue(case['summary'].endswith(f" Your own side: {' '.join(b['payee_side']['reasons'])}"), case['summary'])
        names = {c['name']: c for c in SIDES['cases']}
        self.assertTrue(names['ask owner payee with cover']['summary'].startswith('Ask your owner: '))
        self.assertTrue(names['ask owner both']['summary'].startswith("Ask your owner and the payer's owner: "))
        self.assertEqual(names['ask owner payee with cover']['summary'].lower().count('backed for you'), 1)
        # A server from before #87: 0.7.1's reading, the cover named by this client after the step's reasons, and the
        # payee's own reasons only when that side would not simply go ahead.
        old = names['old server: ask owner payee with cover']
        self.assertTrue(old['summary'].startswith('Accept: Within its budget'))
        self.assertIn('by a backer not named here, guaranteed for you up to 2000000. Your own side: Your own limits allow it. Your owner approves',
                      old['summary'])
        self.assertNotIn('Your own side', names['old server: accept with cover']['summary'])

    def test_whose_owner_decides_an_ask_owner(self):
        side = lambda v: {'verdict': v, 'rule': 'approve_above' if v == 'ask_owner' else None, 'reasons': []}   # noqa: E731
        s = lambda payer, payee, **more: va.check_summary({'verdict': 'ask_owner', 'reasons': ['R.'], 'rule': 'approve_above',  # noqa: E731
                                                           'payer_side': payer, 'payee_side': payee, **more})
        self.assertEqual(s(side('accept'), side('ask_owner')), 'Ask your owner: R. Your own side: your owner approves it before it binds.')
        self.assertEqual(s(side('ask_owner'), side('accept')), "Ask the payer's owner: R.")
        self.assertEqual(s(side('ask_owner'), side('ask_owner')), "Ask your owner and the payer's owner: R. Your own side: your owner "
                                                                  'approves it before it binds.')
        # sides that do not say whose: both owners are named, so this agent's own is never left out
        for payer, payee in ((None, None), ('ask_owner', None), (side('accept'), side('accept')), ([side('ask_owner')], 7)):
            self.assertTrue(s(payer, payee).startswith("Ask your owner and the payer's owner: R."), (payer, payee))
        self.assertEqual(va.check_owners({'payer_side': side('ask_owner'), 'payee_side': None}), 'payer')
        self.assertEqual(va.check_owners(None), 'both')
        # no reasons: the words of the owner who decides
        for whose, payer, payee in (('payee', side('accept'), side('ask_owner')), ('payer', side('ask_owner'), side('accept')),
                                    ('both', side('ask_owner'), side('ask_owner'))):
            r = va.check_summary({'verdict': 'ask_owner', 'reasons': [], 'payer_side': payer, 'payee_side': payee})
            self.assertTrue(r.startswith(f'{va.CHECK_ASK_LEAD[whose]}: {va.CHECK_ASK_FALLBACK[whose]}.'), r)
        # a server from before #87 (no payer_side): the payer's owner, as in 0.7.1, and your own side after it
        self.assertEqual(va.check_summary({'verdict': 'ask_owner', 'reasons': ['R.'], 'payee_side': side('ask_owner')}),
                         "Ask the payer's owner: R. Your own side: your owner approves it before it binds.")
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': ['R.'], 'payee_side': side('ask_owner')}),
                         'Accept: R. Your own side: your owner approves it before it binds.')

    def test_with_payer_side_this_client_never_names_the_cover_itself(self):
        for payer in (BOTH, None, 'junk'):
            v = {'verdict': 'accept', 'reasons': ['Both sides allow it.'], 'cover': {'covered': 3}, 'payer_side': payer}
            self.assertEqual(va.check_summary(v), 'Accept: Both sides allow it.', payer)
            self.assertEqual(va.check_summary(dict(v, payee_side={'verdict': 'accept', 'reasons': ['Your own limits allow it.',
                                                                                                    'Backed for you up to 3 by @erin.']})),
                             'Accept: Both sides allow it. Your own side: Your own limits allow it. Backed for you up to 3 by @erin.')
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': ['r'], 'cover': {'covered': 3}}), 'Accept: r, guaranteed for you up to 3.',
                         'a server from before #87: the cover named by this client, as in 0.7.1')
        # your own side's accept: its reasons follow (the cover is among them); without reasons nothing is added
        v = {'verdict': 'accept', 'reasons': ['Both sides allow it.'], 'payer_side': BOTH}
        self.assertEqual(va.check_summary(dict(v, payee_side={'verdict': 'accept', 'reasons': []})), 'Accept: Both sides allow it.')
        for side in ({'verdict': 'Accept', 'reasons': ['x']}, {'verdict': ['accept'], 'reasons': ['x']}, {'reasons': ['x']}, 'accept'):
            self.assertEqual(va.check_summary(dict(v, payee_side=side)), 'Accept: Both sides allow it.', side)
        self.assertEqual(va.check_summary({'verdict': 'accept', 'reasons': ['r'], 'payee_side': {'verdict': 'accept', 'reasons': ['x']}}),
                         'Accept: r.', 'a server from before #87: your own accept adds nothing, as in 0.7.1')

    def test_a_sentence_follows_after_a_stop_and_a_fragment_after_a_comma(self):
        s = lambda *reasons: va.check_summary({'verdict': 'accept', 'reasons': list(reasons)})   # noqa: E731
        self.assertEqual(s('Within its budget.', 'Its owner approves it.'), 'Accept: Within its budget. Its owner approves it.')
        self.assertEqual(s('within its budget', 'fine'), 'Accept: within its budget, fine.')
        self.assertEqual(s('Within its budget.', "bob's IOUs count 50%.", '2 of 40 left', 'Zed;'),
                         "Accept: Within its budget, bob's IOUs count 50%, 2 of 40 left. Zed.")
        self.assertEqual(s('A.', 'Été.', 'B'), 'Accept: A, Été. B.', 'capitals A to Z only, as in JavaScript')
        self.assertEqual(va._summary_text([]), '')

    def test_card_check_exits_0_only_when_both_sides_go_ahead(self):
        req = SIDES['request']
        accept = next(c for c in SIDES['cases'] if c['name'] == 'accept with cover')
        yours = accept['body']['payee_side']
        for payer_side, payee_side, rc in ((BOTH, yours, 0), (None, yours, 1), ('accept', yours, 1), ({'verdict': 'Accept'}, yours, 1),
                                           (BOTH, None, 1), (BOTH, {'verdict': 'ask_owner'}, 1), (BOTH, 'accept', 1),
                                           ({'verdict': 'ask_owner', 'reasons': []}, yours, 1)):
            body = {k: v for k, v in accept['body'].items() if k != 'payee_side'}
            body.update(payer_side=payer_side, **({} if payee_side is None else {'payee_side': payee_side}))
            self.serve({'status': 200, 'body': body})
            self.assertEqual(self.run_cli('check', req['payer'], str(req['amount']))[0], rc, (payer_side, payee_side))
            self.assertEqual(cli._check_goes_ahead(body), rc == 0)
        for v in ('decline', 'ask_owner', 'unknown', None):
            self.assertFalse(cli._check_goes_ahead(dict(accept['body'], verdict=v)), v)
        # a server from before #87: as in 0.7.1 (without payee_side the payer's verdict alone decides)
        self.assertTrue(cli._check_goes_ahead({'verdict': 'accept'}))
        self.assertTrue(cli._check_goes_ahead({'verdict': 'accept', 'payee_side': None}))
        self.assertFalse(cli._check_goes_ahead({'verdict': 'accept', 'payer_side': None}))


if __name__ == '__main__':
    unittest.main()
