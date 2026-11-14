"""Fix inbox #22 and #23 (offline, real signatures), against a fake Valun server that checks the times of every offer as
the server does (server/lib/pilot/core.mjs validateTerms).

#23: a counter-offer's default validity fits offers due within a day: 24 h at most, but never past its own delivery
deadline nor past the end of the offer it answers. valun_respond takes offer_valid_hours for a counter-offer, and an
offer that would stay open past its delivery deadline is refused before anything is signed (bad_arguments), not by the
server.

#22: the price and the hours of valun_propose and valun_respond are JSON integers of at least 1: a float, a numeric
string or a boolean is refused (bad_arguments), never truncated or replaced by a default, and the success messages name
the amount signed. The client itself never truncates a price either (bad_price)."""
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import agent as va  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import schemas  # noqa: E402
from valun.agent import ValunAgent  # noqa: E402
from test_client_complete import ALICE, ALICE_ID, BOB, BOB_ID, DENOM, NFT, MemStore, sign_text  # noqa: E402

T0 = datetime(2026, 11, 13, 12, 0, 0, tzinfo=timezone.utc)      # when Bob made his offer
NOW = T0 + timedelta(minutes=10)                                # when Alice answers it
H = timedelta(hours=1)
DEAL = 'vd_0123456789abcdef'
UNBOUND = 'could not read what you would sign; nothing was signed'


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


def at(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


class Clock(datetime):
    """The clock of the client and the agent in these tests (client.datetime, agent.datetime)."""
    now_at = NOW

    @classmethod
    def now(cls, tz=None):
        return cls.now_at if tz is not None else cls.now_at.replace(tzinfo=None)


def offer(deliver_h, open_h, price=12, expires=None):
    """Bob's (the buyer's) signed offer to Alice (the seller), made at T0: due deliver_h and open open_h hours later."""
    t = {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': DEAL,
         'version': 1, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': BOB_ID,
         'payer': {'id': BOB_ID, 'pubkey': BOB['pubkey']}, 'payee': {'id': ALICE_ID, 'pubkey': ALICE['pubkey']},
         'service': {'title': 'Quick summary', 'description': 'Summarize three sources in 100 words.', 'deliverable': 'Plain text.'},
         'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
         'deliver_by': iso(T0 + deliver_h * H), 'offer_expires_at': expires or iso(T0 + open_h * H)}
    h = vc.terms_hash(t)
    return {'id': DEAL, 'status': 'open', 'your_role': 'payee', 'counterparty': {'id': BOB_ID, 'handle': 'bob'},
            'current': {'version': 1, 'by': BOB_ID, 'state': 'open', 'terms': t, 'terms_hash': h,
                        'signature': sign_text(BOB, vc.statement('propose', h))}}


class Server:
    """A fake Valun server: Bob's offer, the directory, and the server's own checks of the times of what it is sent."""

    def __init__(self, deal=None):
        self.deal, self.log, self.posts = deal, [], []

    @staticmethod
    def check_times(t):
        now, exp, due = Clock.now_at, at(t['offer_expires_at']), at(t['deliver_by'])
        if not now < exp <= now + timedelta(days=7):
            raise vc.ValunError('invalid_terms', 'offer_expires_at must be in the future, at most 7 days ahead', 400)
        if not now < due <= now + timedelta(days=30):
            raise vc.ValunError('invalid_terms', 'deliver_by must be in the future, at most 30 days ahead', 400)
        if not due >= exp:
            raise vc.ValunError('invalid_terms', 'deliver_by must not be earlier than offer_expires_at (a deal must not '
                                                 'be agreed already overdue)', 400)

    def request(self, method, path, body=None):
        self.log.append(f'{method} {path}')
        if path == '/pilot/v1/info':
            return {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM}
        if path == f'/pilot/v1/participants/{BOB_ID}':
            return {'id': BOB_ID, 'handle': 'bob', 'status': 'active', 'pubkey': BOB['pubkey']}
        if path == '/pilot/v1/participants':
            return [{'id': BOB_ID, 'handle': 'bob', 'status': 'active', 'services': '', 'agent_last_seen': iso(Clock.now_at)}]
        if method == 'GET' and self.deal is not None and path == f'/pilot/v1/deals/{DEAL}':
            return json.loads(json.dumps(self.deal))
        if method == 'POST' and path in ('/pilot/v1/deals', f'/pilot/v1/deals/{DEAL}/counter'):
            self.check_times(body['terms'])
            self.posts.append((path, body))
            return {'id': body['terms']['deal_id'], 'status': 'open', 'pending_counter': None, 'next_actions': ['wait'],
                    'current': {'terms': body['terms'], 'terms_hash': body['terms_hash']}}
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)

    def signed(self):
        """The terms of the one offer sent."""
        (_path, body), = self.posts
        return body['terms']


def client(net, store=None):
    class C(vc.Client):
        def request(self, method, path, body=None, auth=True, token=None):
            return net.request(method, path, json.loads(json.dumps(body)) if body is not None else None)
    return C(store or MemStore(), server='http://valun.invalid')


class Agent(ValunAgent):
    def __init__(self, net):
        super().__init__(MemStore(), process_consents=False)
        self.net = net

    def client(self, require_connection=True):
        return client(self.net, self.store)


class Clocked(unittest.TestCase):
    def setUp(self):
        Clock.now_at = NOW
        for module in (vc, va):
            patcher = mock.patch.object(module, 'datetime', Clock)
            patcher.start()
            self.addCleanup(patcher.stop)


class CounterValidity(Clocked):
    """#23 in the client: Client.counter's default validity, the offer_ttl_hours it is given, and the checks before
    anything is signed."""

    def test_a_price_only_counter_to_an_offer_due_within_a_day_is_valid_terms(self):
        # Bob offered at T0, due and open h hours later; Alice counters 10 minutes later with a price only. Delivery keeps
        # his deadline, rounded down to the hour (h - 1 hours from now); the counter-offer stays open as long as that.
        for h in (3, 6, 12, 25):
            with self.subTest(hours=h):
                net = Server(offer(h, h))
                client(net).counter(DEAL, price=15)
                t = net.signed()                    # the server's own checks of the times passed
                self.assertEqual((t['price']['amount'], t['deliver_by']), (15, iso(NOW + (h - 1) * H)))
                self.assertEqual(t['offer_expires_at'], iso(NOW + min(24, h - 1) * H))
                self.assertLessEqual(t['offer_expires_at'], t['deliver_by'])

    def test_a_counter_open_longer_than_it_gives_to_deliver_is_refused_before_signing(self):
        # The tester's repro, with the 24 h the counter used to stay open: refused here, with what to do, and not sent.
        net = Server(offer(6, 6))
        with self.assertRaises(vc.ValunError) as e:
            client(net).counter(DEAL, price=15, offer_ttl_hours=24)
        self.assertEqual(e.exception.code, 'bad_arguments')
        self.assertEqual(str(e.exception), 'the offer would stay open 24 h, longer than the 5 h it gives to deliver: it could '
                         'be accepted after its work is due, which the server refuses. Pass offer_valid_hours of at most 5; '
                         'nothing was signed')
        self.assertEqual(net.posts, [])
        net = Server(offer(6, 6))
        with self.assertRaises(vc.ValunError) as e:
            client(net).counter(DEAL, price=15, deliver_by_hours=2, offer_ttl_hours=3)
        self.assertIn('Pass offer_valid_hours of at most 2', str(e.exception))
        self.assertEqual(net.posts, [])

    def test_a_counter_stays_open_no_longer_than_the_offer_it_answers(self):
        net = Server(offer(48, 1))
        client(net).counter(DEAL, price=15)
        t = net.signed()
        self.assertEqual((t['deliver_by'], t['offer_expires_at']), (iso(NOW + 47 * H), iso(T0 + H)))

    def test_offer_ttl_hours_sets_how_long_it_stays_open(self):
        for ttl in (1, 2, 5):
            with self.subTest(ttl=ttl):
                net = Server(offer(6, 6))
                client(net).counter(DEAL, price=15, offer_ttl_hours=ttl)
                self.assertEqual(net.signed()['offer_expires_at'], iso(NOW + ttl * H))
        net = Server(offer(48, 1))                  # given hours are not capped by the offer it answers
        client(net).counter(DEAL, offer_ttl_hours=24)
        self.assertEqual(net.signed()['offer_expires_at'], iso(NOW + 24 * H))

    def test_an_offer_that_would_not_be_open_is_refused(self):
        net = Server(offer(6, 1, expires=iso(NOW)))      # their offer ends now: still valid, nothing left to counter with
        with self.assertRaises(vc.ValunError) as e:
            client(net).counter(DEAL, price=15)
        self.assertEqual((e.exception.code, str(e.exception)), ('bad_arguments', (
            f'the offer would expire at {iso(NOW)}, before it is sent: it must stay open for at least 1 h (offer_valid_hours); '
            'nothing was signed')))
        self.assertEqual(net.posts, [])

    def test_a_proposal_open_longer_than_it_gives_to_deliver_is_refused_before_any_read(self):
        net = Server()
        with self.assertRaises(vc.ValunError) as e:
            client(net).propose(BOB_ID, 'payer', 't', 'd', 'x', 5, deliver_by_hours=6, offer_ttl_hours=24)
        self.assertEqual(e.exception.code, 'bad_arguments')
        self.assertIn('longer than the 6 h it gives to deliver', str(e.exception))
        self.assertEqual(net.log, [])
        client(net).propose(BOB_ID, 'payer', 't', 'd', 'x', 5, deliver_by_hours=6, offer_ttl_hours=6)
        t = net.signed()
        self.assertEqual((t['deliver_by'], t['offer_expires_at']), (iso(NOW + 6 * H), iso(NOW + 6 * H)))

    def test_the_client_never_truncates_a_price(self):
        for bad in (1.5, 20.0, True, False, 0, -2, '1.5', ' 7', '', None, 2 ** 53):
            with self.subTest(price=bad):
                net = Server()
                with self.assertRaises(vc.ValunError) as e:
                    client(net).build_terms(BOB_ID, 'payer', 't', 'd', 'x', bad)
                self.assertEqual((e.exception.code, str(e.exception)), ('bad_price', 'price must be a whole number of PC, at least 1'))
                self.assertEqual(net.log, [])
        self.assertEqual(client(Server()).build_terms(BOB_ID, 'payer', 't', 'd', 'x', '12')['price'], {'amount': 12, 'unit': 'PC'})


PROPOSE = {'counterparty': 'bob', 'role': 'payer', 'title': 'Quick summary', 'description': 'Summarize three sources.',
           'deliverable': 'Plain text.', 'price': 7}
COUNTER = {'deal_id': DEAL, 'action': 'counter'}


class ToolArguments(Clocked):
    """#22 and #23 through the tools, as an agent calls them."""

    def test_acceptance_a_price_only_counter_on_a_6_hour_deal_succeeds(self):
        net = Server(offer(6, 6))
        r = Agent(net).call('valun_respond', dict(COUNTER, price=15))
        self.assertEqual((r['status'], r['what_happened']), ('open', 'Your counter-offer at 15 PC is open for the other side.'))
        t = net.signed()
        self.assertEqual((t['price']['amount'], t['deliver_by'], t['offer_expires_at']), (15, iso(NOW + 5 * H), iso(NOW + 5 * H)))

    def test_acceptance_an_agent_can_counter_a_3_hour_offer(self):
        for args in (dict(COUNTER, price=15), dict(COUNTER, title='Shorter summary'), dict(COUNTER, price=9, deliver_within_hours=2)):
            with self.subTest(args=args):
                net = Server(offer(3, 3))
                r = Agent(net).call_safe('valun_respond', args)
                self.assertEqual(r.get('status'), 'open', r)
                t = net.signed()
                self.assertEqual(t['offer_expires_at'], t['deliver_by'])
                self.assertEqual(t['offer_expires_at'], iso(NOW + 2 * H))

    def test_offer_valid_hours_on_a_counter(self):
        net = Server(offer(6, 6))
        self.assertEqual(Agent(net).call('valun_respond', dict(COUNTER, price=15, offer_valid_hours=2))['status'], 'open')
        self.assertEqual(net.signed()['offer_expires_at'], iso(NOW + 2 * H))
        net = Server(offer(6, 6))                   # longer than the 5 h left to deliver: refused before signing
        r = Agent(net).call_safe('valun_respond', dict(COUNTER, price=15, offer_valid_hours=6))
        self.assertEqual(r['error'], 'bad_arguments')
        self.assertIn('Pass offer_valid_hours of at most 5', r['message'])
        self.assertEqual(net.posts, [])
        net = Server(offer(6, 6))                   # longer than the hours it gives: refused before anything is read
        r = Agent(net).call_safe('valun_respond', dict(COUNTER, deliver_within_hours=3, offer_valid_hours=4))
        self.assertEqual((r['error'], net.log), ('bad_arguments', []))
        self.assertIn('Pass offer_valid_hours of at most 3', r['message'])

    def test_the_price_and_the_hours_are_json_integers_of_at_least_1(self):
        cases = [('valun_propose', PROPOSE, k) for k in ('price', 'deliver_within_hours', 'offer_valid_hours')] + \
                [('valun_respond', COUNTER, k) for k in ('price', 'deliver_within_hours', 'offer_valid_hours')]
        for tool, base, k in cases:
            units = 'PC' if k == 'price' else 'hours'
            for bad in (1.5, 2.0, '1000', '7', True, False, 0, -1, [7], {'amount': 7}):
                with self.subTest(tool=tool, arg=k, value=bad):
                    net = Server(offer(6, 6))
                    r = Agent(net).call_safe(tool, dict(base, **{k: bad}))
                    self.assertEqual(r['error'], 'bad_arguments', r)
                    self.assertEqual(r['message'], f'{k} must be a whole number of {units}, at least 1 (a JSON integer), not '
                                                   f'{json.dumps(bad, separators=(",", ":"))}; nothing was signed')
                    self.assertEqual((net.log, net.posts), ([], []), 'refused before anything is read or signed')
                    with self.assertRaises(vc.ValunError) as e:      # nor is the owner asked to approve it
                        Agent(net).prepare(tool, dict(base, **{k: bad}))
                    self.assertEqual((e.exception.code, e.exception.extra['cause']), ('approval_unbound', 'bad_arguments'))

    def test_the_success_messages_name_the_amount_signed(self):
        net = Server()
        r = Agent(net).call('valun_propose', PROPOSE)
        self.assertEqual(r['if_agreed'], 'After you accept their delivery you issue them a credit note of 7 PC (you will owe them; not settled).')
        self.assertEqual(net.signed()['price'], {'amount': 7, 'unit': 'PC'})
        net = Server(offer(6, 6))
        r = Agent(net).call('valun_respond', dict(COUNTER, title='Shorter summary'))
        self.assertEqual(r['what_happened'], 'Your counter-offer at the price of their offer is open for the other side.')
        self.assertEqual(net.signed()['price'], {'amount': 12, 'unit': 'PC'})

    def test_a_proposal_open_longer_than_it_gives_to_deliver_is_refused(self):
        net = Server()
        r = Agent(net).call_safe('valun_propose', dict(PROPOSE, deliver_within_hours=6, offer_valid_hours=24))
        self.assertEqual(r, {'error': 'bad_arguments', 'message': (
            'the offer would stay open 24 h, longer than the 6 h it gives to deliver: it could be accepted after its work is '
            'due, which the server refuses. Pass offer_valid_hours of at most 6; nothing was signed')})
        self.assertEqual(net.log, [])
        self.assertEqual(Agent(net).call('valun_propose', dict(PROPOSE, deliver_within_hours=6, offer_valid_hours=6))['status'], 'open')

    def test_a_proposal_s_default_validity_is_never_longer_than_its_delivery_window(self):
        # Without offer_valid_hours a 6 h job's offer stays open 6 h (24 h otherwise), so it is valid terms as it is.
        net = Server()
        self.assertEqual(Agent(net).call('valun_propose', dict(PROPOSE, deliver_within_hours=6))['status'], 'open')
        t = net.signed()
        self.assertEqual(at(t['deliver_by']) - at(t['offer_expires_at']), timedelta(0))

    def test_the_approval_texts_say_how_long_the_counter_offer_stays_open(self):
        d = offer(6, 6)
        text = Agent(Server(d)).prepare('valun_respond', dict(COUNTER, price=15))['text']
        self.assertIn('your agent changes: price 12 -> 15 PC; the counter-offer stays open 24 h, or less: never past its delivery '
                      f"deadline, nor past {d['current']['terms']['offer_expires_at']}, when their offer ends", text)
        text = Agent(Server(d)).prepare('valun_respond', dict(COUNTER, price=15, offer_valid_hours=2))['text']
        self.assertIn('; the counter-offer stays open 2 h\n', text)
        for args in (dict(COUNTER, offer_valid_hours=6), dict(COUNTER, deliver_within_hours=3, offer_valid_hours=4)):
            with self.subTest(args=args):           # the owner is never asked to approve what the client would refuse
                with self.assertRaises(vc.ValunError) as e:
                    Agent(Server(d)).prepare('valun_respond', args)
                self.assertEqual((str(e.exception), e.exception.extra['cause']), (UNBOUND, 'bad_arguments'))
        with self.assertRaises(vc.ValunError) as e:
            Agent(Server()).prepare('valun_propose', dict(PROPOSE, deliver_within_hours=6, offer_valid_hours=24))
        self.assertEqual(e.exception.extra['cause'], 'bad_arguments')

    def test_messages_name_the_networks_unit(self):
        with self.assertRaises(vc.ValunError) as e:
            va._count('price', 1.5, 'nanoERG')
        self.assertEqual(str(e.exception), 'price must be a whole number of nanoERG, at least 1 (a JSON integer), not 1.5; nothing was signed')
        with self.assertRaises(vc.ValunError) as e:
            va._count('price', 'x' * 100, 'PC')
        self.assertEqual(str(e.exception), f'price must be a whole number of PC, at least 1 (a JSON integer), not "{"x" * 36}...; nothing was signed')

    def test_valun_respond_takes_offer_valid_hours(self):
        props = schemas.RESPOND['parameters']['properties']
        self.assertEqual({k: v for k, v in props['offer_valid_hours'].items() if k != 'description'},
                         {'type': 'integer', 'minimum': 1, 'maximum': 168})
        self.assertEqual(list(props)[-2:], ['deliver_within_hours', 'offer_valid_hours'])
        self.assertEqual(schemas.RESPOND['parameters']['required'], ['deal_id', 'action'])
        self.assertEqual(len(schemas.ALL), 14)
        self.assertEqual(va.TOOL_NAMES, [t['name'] for t in schemas.ALL])
        self.assertNotIn('PC', json.dumps(schemas.for_network(schemas.TESTNET)[5]))


if __name__ == '__main__':
    unittest.main()
