"""bind_bot.py offline: X's published OAuth 1.0a signature example, reading posts, every rule, and the whole flow with
a fake X and a fake Valun (no network, nothing posted, nothing spent). The flows run on two networks: one counted in
PC (scale 1, as the pilot was) and the testnet (nanoERG, scale 1,000,000). On both, people write and read credits;
Valun is sent credits x the client's scale, and what the server reports in its units is posted in credits.

    cd examples/ai-seller && PYTHONPATH=../../python/src python -m unittest test_bind_bot.py"""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bind_bot as B  # noqa: E402

PILOT, TESTNET = 'valun-pilot-1', 'valun-testnet-1'


def unit_scale(network):
    """(unit, scale) of a network, from the client's own table."""
    n = B.vc.network_of(network)
    return n['unit'], n['scale']


def write_profile(home, name, network):
    """A profile as `valun join` leaves it, for the fields the bot reads (participant id, network). Test only: no key."""
    os.makedirs(os.path.join(home, 'profiles'), exist_ok=True)
    pid = 'vp_' + hashlib.sha256(name.encode()).hexdigest()[:12]
    with open(os.path.join(home, 'profiles', name + '.json'), 'w', encoding='utf-8') as f:
        json.dump({'participant_id': pid, 'network': network}, f)


def no_fetch(path):
    raise AssertionError(f'the server was read ({path}): the scale should come from a profile')


class OAuth(unittest.TestCase):
    def test_x_documented_example(self):
        # developer.x.com "Creating a signature": the documented request and its signature hCtSmYh+iHYCEqBWrE7C7hYmtUk=
        keys = {'api_key': 'xvz1evFS4wEEPTGEFPHBog', 'api_secret': 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
                'access_token': '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', 'access_secret': 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE'}
        h = B.oauth1_header('POST', 'https://api.twitter.com/1.1/statuses/update.json',
                            {'include_entities': 'true', 'status': 'Hello Ladies + Gentlemen, a signed OAuth request!'}, keys,
                            nonce='kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp=1318622958)
        self.assertIn('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"', h)
        self.assertTrue(h.startswith('OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce='))


class Reading(unittest.TestCase):
    def test_owe(self):
        self.assertEqual(B.parse_owe('@bindvalun I owe @Bob 5 for the logo.'), ('bob', 5, 'the logo', None))
        self.assertEqual(B.parse_owe('@bindvalun i owe @bob 3 credits'), ('bob', 3, '', None))
        self.assertEqual(B.parse_owe('@bindvalun I owe @bob 2: a review of @carol_x work'), ('bob', 2, 'a review of carol_x work', None))
        self.assertEqual(B.parse_owe('@bindvalun I owe @bob 5 for dinner with @carol'), ('bob', 5, 'dinner with carol', None))
        self.assertIsNone(B.parse_owe('@bindvalun @bob owes me 5'))
        self.assertIsNone(B.parse_owe('@bindvalun hello'))

    def test_pay_with_a_promise(self):
        self.assertEqual(B.parse_owe('@bindvalun I owe @carol 3 for the review, pay with @alice'), ('carol', 3, 'the review', 'alice'))
        self.assertEqual(B.parse_owe("@bindvalun pay @carol 3 with @alice's promise for the review"), ('carol', 3, 'the review', 'alice'))
        self.assertEqual(B.parse_owe('@bindvalun I owe @carol 2, paid with @Alice’s IOU.'), ('carol', 2, '', 'alice'))
        self.assertEqual(B.parse_owe('@bindvalun I owe @carol 1, pay with @alice, for a test'), ('carol', 1, 'a test', 'alice'))
        self.assertIsNone(B.parse_owe('@bindvalun pay @carol 3'), 'a bare "pay" binds nothing')
        self.assertIsNone(B.parse_owe('@bindvalun pay @carol 3 with @alice'), 'pay ... with @x needs "promise" (or "pay with")')

    def test_record(self):
        self.assertEqual(B.parse_record('@bindvalun record'), '')
        self.assertEqual(B.parse_record('@bindvalun my record'), '')
        self.assertEqual(B.parse_record('@bindvalun record @Alice'), 'alice')
        self.assertIsNone(B.parse_record('@bindvalun recording a video'))
        self.assertIsNone(B.parse_record('@bindvalun I owe @bob 1'))

    def test_fit(self):
        make = lambda w: f'Offer: @aaaaaaaaaaaaaaa owes @bbbbbbbbbbbbbbb 5 credits for {w}. Open.'  # noqa: E731
        text = B.fit(make, 'x' * 300)
        self.assertLessEqual(len(text), B.MAX_TEXT)
        self.assertTrue(text.endswith('x…. Open.'))
        self.assertEqual(B.fit(make, 'a logo'), make('a logo'))

    def test_fit_keeps_the_note_while_the_post_can_hold_it(self):
        note = B.credit_note(*unit_scale(TESTNET))
        make = lambda w: 'y' * 200 + (f' for {w}' if w else '') + '.'  # noqa: E731
        self.assertEqual(B.fit(make, 'a logo', note), make('a logo') + note)
        cut = B.fit(make, 'a' * 100, note)
        self.assertTrue(cut.endswith('a….' + note), 'the description is cut first')
        self.assertLessEqual(len(cut), B.MAX_TEXT)
        long = lambda w: 'y' * 240 + (f' for {w}' if w else '') + '.'  # noqa: E731
        self.assertEqual(B.fit(long, 'a logo', note), B.fit(long, 'a logo'), 'no room even without the description: no note')
        self.assertEqual(B.fit(make, 'a logo', ''), make('a logo'))

    def test_tldr_and_feedback(self):
        for t in ('@bindvalun tldr', '@bob @bindvalun TL;DR please', '@bindvalun summarize this', '@bindvalun tl;dr: x'):
            self.assertTrue(B.TLDR.match(B.post_text({'text': t})), t)
        for t in ('@bindvalun tldrs are fun', '@bindvalun I owe @bob 1', '@bindvalun record'):
            self.assertFalse(B.TLDR.match(B.post_text({'text': t})), t)
        self.assertEqual(B.FEEDBACK.match('feedback: the offer reply is too long').group(1), 'the offer reply is too long')
        self.assertEqual(B.post_text({'text': 'short', 'note_tweet': {'text': '@a long text'}}), 'long text')

    def test_clean_for_x(self):
        t = B.clean_for_x('TL;DR: **Bold** claim by @alice about #AI, see https://evil.example/x and valun.tech.\n- a bullet', 200)
        self.assertEqual(t, 'Bold claim by alice about AI, see and valun․tech. a bullet')
        self.assertNotRegex(t, B.URL_RE)
        long = B.clean_for_x('word ' * 100, 50)
        self.assertLessEqual(len(long), 50)
        self.assertTrue(long.endswith('word…'))

    def test_accept(self):
        for t in ('@bindvalun accept', '@bindvalun @alice Accepted!', 'yes', '@bindvalun bind'):
            self.assertTrue(B.is_accept(t), t)
        for t in ('@bindvalun I do not accept', 'no', '@bindvalun what is this'):
            self.assertFalse(B.is_accept(t), t)

    def test_profile_name(self):
        self.assertEqual(B.profile_name('Alice_99'), 'x_alice_99')


class Amounts(unittest.TestCase):
    """Credits (what people write and read) and the network's units (what Valun signs), with the client's scale."""
    def test_credits_to_units_and_back(self):
        for network in (PILOT, TESTNET):
            _unit, scale = unit_scale(network)
            for n in range(B.MIN_CREDITS, B.MAX_CREDITS + 1):
                self.assertEqual(B.to_units(n, scale), n * scale)
                self.assertEqual(B.in_credits(B.to_units(n, scale), scale), str(n))
        self.assertEqual(B.to_units(5, 1_000_000), 5_000_000, 'the most a promise holds on the testnet: 0.005 tERG')
        self.assertEqual([B.in_credits(u, 1_000_000) for u in (0, 1, 2_500_000, 30_000_000, 123_456_789)],
                         ['0', '0.000001', '2.5', '30', '123.456789'], 'exact: never rounded')
        self.assertEqual([B.in_credits(u, 1) for u in (0, 7, 10)], ['0', '7', '10'])
        for bad in (None, '5', 2.5, True):
            self.assertEqual(B.in_credits(bad, 1_000_000), '0', bad)
        self.assertEqual([B.credits(x) for x in (1, '1', 2, '2.5', '0', '0.000001')],
                         ['1 credit', '1 credit', '2 credits', '2.5 credits', '0 credits', '0.000001 credits'])

    def test_what_a_credit_is(self):
        self.assertEqual(unit_scale(TESTNET), ('nanoERG', 1_000_000))
        self.assertEqual(unit_scale(PILOT), ('PC', 1))
        self.assertEqual(B.credit_note(*unit_scale(TESTNET)), ' A credit is 0.001 tERG, test coins with no value.')
        self.assertEqual(B.credit_note(*unit_scale(PILOT)), '')
        self.assertIsNone(B.URL_RE.search(B.credit_note(*unit_scale(TESTNET))), 'no link: the post keeps the plain price')
        self.assertEqual(B.vc.amount_text(B.to_units(1, 1_000_000), 'nanoERG'), '1000000 nanoERG (0.001 tERG)')

    def test_the_defaults_are_the_testnet_and_a_new_home(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('BIND_')}
        with mock.patch.dict(os.environ, env, clear=True):
            spec = importlib.util.spec_from_file_location('bind_bot_defaults', os.path.join(HERE, 'bind_bot.py'))
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
        self.assertEqual((m.SERVER, m.HOME, m.CARRY_STATE), ('https://valun-testnet.fly.dev', '/data/bind-testnet', ''))
        self.assertNotIn('pilot network', m.__doc__)


class FakeX:
    def __init__(self):
        self.posts, self.feed, self.n, self.since_ids = [], [], 1000, []

    def me(self):
        return {'id': 'bot', 'username': 'bindvalun'}

    def mentions(self, uid, since_id=None):
        self.since_ids.append(since_id)
        data, self.feed = self.feed, []
        refs, self.refs = getattr(self, 'refs', []), []
        users = {}
        for t in data:
            users[t['author_id']] = {'id': t['author_id'], 'username': t.pop('_author')}
        return {'data': data, 'includes': {'users': list(users.values()), 'tweets': refs},
                'meta': {'newest_id': data[-1]['id']} if data else {}}

    def post(self, text, reply_to=None):
        self.n += 1
        self.posts.append((text, reply_to))
        return {'id': str(self.n)}


class FakeValun:
    """Valun as the Bot sees it: amounts it reports (held, public, loops) are the network's units."""
    def __init__(self, fail=None, how='note', held=None, settle_to='transfer', public=None, network=PILOT):
        self.binds, self.fail, self.touched, self.how, self._held = [], fail, [], how, held or {}
        self.settle_to, self._public, self.settles = settle_to, public, 0
        self._network = unit_scale(network)

    def network(self):
        return self._network

    def bind(self, state, offer):
        if self.fail:
            raise B.BindError(self.fail, 'no')
        for x in (offer['debtor'], offer['creditor']):
            state.s['profiles'].setdefault(B.profile_name(x), {'x': x})
        self.binds.append(dict(offer))
        return 'vd_' + '1' * 16, self.how

    def settle(self, offer, did, tries=1, wait_s=5):
        self.settles += 1
        return self.settle_to

    def held(self, name):
        return self._held.get(name, {})

    def public(self, name, fetch=None):
        return self._public

    def touch(self, name):
        self.touched.append(name)


class FakeCLI:
    """The `python -m valun` commands Valun runs, answered as the pilot answered them (pay_probe, 2026-11-13); a join
    leaves a profile on `network` in `home`."""
    def __init__(self, transfer_applies=True, home=None, network=PILOT):
        self.status, self.calls, self.cleared, self.applies = None, [], set(), transfer_applies
        self.home, self.network, self.proposed = home, network, []

    def __call__(self, args, timeout=180):
        profile, cmd = args[1], args[2]
        self.calls.append((profile, *args[2:]))
        if cmd == 'join':
            write_profile(self.home, profile, self.network)
            return 0, 'joined', ''
        if cmd == 'clearing':
            self.cleared.add(profile)
            if self.status == 'paying_by_transfer' and {'x_alice', 'x_carol'} <= self.cleared:
                self.status = 'paid_by_transfer' if self.applies else 'payment_due'
            return 0, 'signed', ''
        tool, a = args[3], json.loads(args[4])
        if tool == 'valun_propose':
            self.proposed.append(a)
        r = {'valun_propose': lambda: {'deal_id': 'vd_2', 'status': 'open'},
             'valun_respond': lambda: {'status': 'agreed'},
             'valun_deliver': lambda: {'status': 'delivered'},
             'valun_deal': lambda: {'status': self.status or 'delivered', 'delivery': {'sha256': 'ab' * 32}}}.get(tool)
        if r:
            return 0, json.dumps(r()), ''
        if tool == 'valun_review_delivery':
            assert a['expected_deliverable_sha256'] == 'ab' * 32
            self.status = 'paying_by_transfer' if a.get('pay_with') else 'note_issued'
            return 0, json.dumps({'status': self.status}), ''
        raise AssertionError(tool)


def tweet(tid, author, author_id, text, reply_to=None, mentions=()):
    return {'id': str(tid), 'author_id': author_id, '_author': author, 'text': text,
            'entities': {'mentions': [{'username': m, 'id': f'id-{m}'} for m in ('bindvalun', *mentions)]},
            **({'referenced_tweets': [{'type': 'replied_to', 'id': reply_to}]} if reply_to else {})}


class Flow(unittest.TestCase):
    """The whole flow on a network counted in PC (scale 1); FlowTestnet runs it again on the testnet."""
    NETWORK = PILOT

    def setUp(self):
        self.unit, self.scale = unit_scale(self.NETWORK)
        self.note = B.credit_note(self.unit, self.scale)
        self.bots = []

    def tearDown(self):
        for b in self.bots:
            for text, _ in b.x.posts:
                self.assertLessEqual(len(text), B.MAX_TEXT, text)
                self.assertNotIn('nanoERG', text, 'posts say credits')
                self.assertNotIn('000000', text, 'never a raw amount in units')

    def u(self, n):
        """`n` credits as the server reports them: in the network's units."""
        return n * self.scale

    def bot(self, valun=None):
        st = B.State(tempfile.mktemp(suffix='.json'))
        b = B.Bot(FakeX(), valun or FakeValun(network=self.NETWORK), st, log=lambda **kw: None)
        self.bots.append(b)
        return b

    def test_offer_accept_bound(self):
        b = self.bot()
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @bob 5 for the logo', mentions=('bob',))]
        b.poll()
        text, reply_to = b.x.posts[0]
        self.assertEqual(reply_to, '1')
        self.assertEqual(text, 'Offer: @alice owes @bob 5 credits for the logo. @bob, reply "accept" to this post to bind it. '
                               'Open for 24 hours. Once bound, @bob can pass it on.' + self.note)
        offer_id = '1001'
        b.x.feed = [tweet(2, 'mallory', 'id-mallory', '@bindvalun accept', reply_to=offer_id)]   # not the creditor
        b.poll()
        self.assertEqual(len(b.x.posts), 1)
        b.x.feed = [tweet(3, 'bob', 'id-bob', '@bindvalun @alice accept', reply_to=offer_id)]
        b.poll()
        self.assertEqual(b.v.binds[0]['amount'], 5, 'the offer keeps credits; Valun.bind sends credits x scale')
        self.assertEqual(b.v.binds[0]['accept_id'], '3')
        self.assertEqual(b.x.posts[1], ('Bound. @alice owes @bob 5 credits for the logo. @bob can now pay others with it. '
                                        'Recorded by a Basis tracker: valun.tech/agent/x_alice', '3'))
        self.assertEqual(b.st.s['offers'][offer_id]['state'], 'bound')
        # spending: one plain reply (what a credit is holds no link), one with a link, the posts and users read
        self.assertAlmostEqual(b.st.s['month_usd'], 0.015 + 0.20 + 3 * 0.005 + 3 * 0.010 + 0.010, places=6)
        b.x.feed = [tweet(4, 'bob', 'id-bob', 'accept', reply_to=offer_id)]                   # already bound
        b.poll()
        self.assertEqual(len(b.v.binds), 1)

    def test_rules(self):
        b = self.bot()
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @alice 5', mentions=('alice',)),        # to oneself
                    tweet(2, 'alice', 'id-alice', '@bindvalun I owe @bindvalun 5'),                           # to the bot
                    tweet(3, 'alice', 'id-alice', '@bindvalun I owe @bob 5'),                                 # @bob not mentioned
                    tweet(4, 'alice', 'id-alice', '@bindvalun I owe @bob 50', mentions=('bob',))]             # too much
        b.poll()
        self.assertEqual(b.x.posts, [('@alice A promise here is 1 to 5 credits for now.' + self.note
                                      + ' Try again with an amount in that range.', '4')])
        for i in range(5):
            b.x.feed = [tweet(10 + i, 'carol', 'id-carol', f'@bindvalun I owe @dan {1 + i % 5}', mentions=('dan',))]
            b.poll()
        self.assertEqual(sum(1 for p in b.x.posts if p[0].startswith('Offer: @carol')), 3, 'three offers a day from one debtor')

    def test_long_handles_keep_the_names_and_amount(self):
        b = self.bot(FakeValun(network=self.NETWORK, held={'x_bbbbbbbbbbbbbbb': {'x_ccccccccccccccc': self.u(5)}}))
        b.st.s['profiles'] = {'x_bbbbbbbbbbbbbbb': {'x': 'bbbbbbbbbbbbbbb'}, 'x_ccccccccccccccc': {'x': 'ccccccccccccccc'}}
        b.x.feed = [tweet(1, 'bbbbbbbbbbbbbbb', 'id-b', '@bindvalun I owe @aaaaaaaaaaaaaaa 5 for ' + 'z' * 90
                          + ', pay with @ccccccccccccccc', mentions=('aaaaaaaaaaaaaaa', 'ccccccccccccccc'))]
        b.poll()
        text = b.x.posts[0][0]
        self.assertTrue(text.startswith('Offer: @bbbbbbbbbbbbbbb pays @aaaaaaaaaaaaaaa 5 credits'), text)
        self.assertIn('Open for 24 hours.', text)

    def test_refused_bind_says_nothing_is_owed(self):
        b = self.bot(FakeValun(fail='mandate_exceeded', network=self.NETWORK))
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @bob 2', mentions=('bob',))]
        b.poll()
        b.x.feed = [tweet(2, 'bob', 'id-bob', 'accept', reply_to='1001')]
        b.poll()
        self.assertEqual(b.x.posts[-1], ('@bob Not bound: Valun refused it (mandate_exceeded). Nothing is owed.', '2'))

    def test_budget(self):
        b = self.bot()
        b.st.s['month_usd'] = B.MONTHLY_USD - 0.01
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @bob 2', mentions=('bob',))]
        b.poll()
        self.assertEqual(b.x.posts, [], 'no room: nothing is read or posted')

    def circulating(self, **kw):
        b = self.bot(FakeValun(network=self.NETWORK, **kw))
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}, 'x_bob': {'x': 'bob'}}
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun I owe @carol 3 for the review, pay with @alice', mentions=('carol', 'alice'))]
        b.poll()
        return b

    def test_pay_with_a_promise(self):
        b = self.circulating(how='transfer', held={'x_bob': {'x_alice': self.u(3)}})
        self.assertEqual(b.x.posts[0], ("Offer: @bob pays @carol 3 credits for the review with @alice's promise: @alice would "
                                        'owe @carol instead of @bob. @carol, reply "accept" to take it. Open for 24 hours.'
                                        + self.note, '1'))
        b.x.feed = [tweet(2, 'carol', 'id-carol', '@bindvalun accept', reply_to='1001')]
        b.poll()
        self.assertEqual(b.v.binds[0]['via'], 'alice')
        self.assertEqual(b.x.posts[1], ("Paid with a promise. 3 credits of @alice's IOU to @bob now belong to @carol: @alice owes "
                                        '@carol instead, and @bob paid for the review with no new IOU. Recorded by a Basis '
                                        'tracker: valun.tech/agent/x_carol', '2'))
        self.assertEqual(b.st.s['offers']['1001']['state'], 'bound')

    def test_pay_with_a_promise_one_does_not_hold(self):
        b = self.circulating(held={'x_bob': {'x_alice': self.u(1)}})
        self.assertEqual(b.x.posts, [("@bob You hold 1 credit of alice's promises here, so you cannot pay 3 with them. "
                                      'Nothing was offered.', '1')])
        self.assertEqual(b.st.s['offers'], {})
        b = self.bot()
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun I owe @carol 3, pay with @carol', mentions=('carol',)),
                    tweet(2, 'bob', 'id-bob', '@bindvalun I owe @carol 3, pay with @alice', mentions=('carol',))]   # @alice not tagged
        b.poll()
        self.assertEqual(b.x.posts, [])

    def test_transfer_waiting_then_settled(self):
        b = self.circulating(how='pending', held={'x_bob': {'x_alice': self.u(3)}}, settle_to='pending')
        b.x.feed = [tweet(2, 'carol', 'id-carol', 'accept', reply_to='1001')]
        b.poll()
        self.assertIn('waits for its signatures', b.x.posts[1][0])
        self.assertEqual(b.st.s['offers']['1001']['state'], 'settling')
        b.settle_pending()
        self.assertEqual(len(b.x.posts), 2, 'still pending: nothing posted')
        b.v.settle_to = 'own_note'
        b.settle_pending()
        self.assertEqual(b.x.posts[2], ("Bound. Moving @alice's promise did not apply, so @bob's own IOU paid: @bob owes @carol "
                                        '3 credits for the review. Recorded by a Basis tracker: valun.tech/agent/x_bob', '2'))
        b.settle_pending()
        self.assertEqual((len(b.x.posts), b.v.settles), (3, 2), 'settled once')

    def test_record(self):
        pos = {'owes': self.u(2), 'claims_held': self.u(5), 'cleared_by_setoff': self.u(1), 'novated_as_issuer': self.u(3)}
        b = self.bot(FakeValun(public=pos, network=self.NETWORK))
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}}
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun record @alice', mentions=('alice',)),
                    tweet(2, 'bob', 'id-bob', '@bindvalun record')]          # one a day per author
        b.poll()
        self.assertEqual(b.x.posts, [("alice's record: owes 2 credits, holds 5 of others' promises; 3 credits of alice's "
                                      "promises changed hands; 1 cancelled in loops. valun.tech/agent/x_alice", '1')])
        b.x.feed = [tweet(3, 'dan', 'id-dan', '@bindvalun my record')]
        b.poll()
        self.assertEqual(b.x.posts[1][0], '@dan has no promises bound here yet. One starts with a post like "@bindvalun I owe" '
                                          "plus someone's handle and 1 to 5 credits." + self.note)

    def test_record_from_the_evidence(self):
        ev = {'delivery': {'accepted': {'count': 3, 'buyers': 2}}, 'repayment': {'owed_ever_PC': self.u(6), 'settled': {'by_setoff_PC': self.u(4)},
              'unpaid_accepted_work': {'count': 1}}, 'acceptance': {'holders_ever': 2}, 'circle': {'closed': True}}
        b = self.bot(FakeValun(public={'owes': self.u(2), 'evidence': ev}, network=self.NETWORK))
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}}
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun record @alice', mentions=('alice',))]
        b.poll()
        self.assertEqual(b.x.posts[0][0], "alice's record, kept apart. Delivered: 3 accepted, by 2 buyers. Repaid: 4 of 6 credits owed, "
                                          '1 accepted job unpaid. Accepted: 2 took its IOU. Its circle is closed. Evidence, not a score. '
                                          'valun.tech/agent/x_alice')
        big = {'delivery': {'accepted': {'count': 99999, 'buyers': 99999}}, 'repayment': {'owed_ever_PC': self.u(99999), 'settled': {'by_setoff_PC': self.u(99999)},
               'unpaid_accepted_work': {'count': 99999}}, 'acceptance': {'holders_ever': 99999}, 'circle': {'closed': True}}
        self.assertLessEqual(len(B.record_text('abcdefghijklmno', big, 'x_abcdefghijklmno', self.scale)), B.MAX_TEXT)

    def test_loops(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}, 'x_bob': {'x': 'bob'}}
        loops = {'loops': [{'id': 'vs_0123456789abcdef', 'each_PC': self.u(2), 'members': [{'handle': 'x_alice'}, {'handle': 'x_bob'}, {'handle': 'house-scribe'}]},
                           {'id': 'vs_fedcba9876543210', 'each_PC': self.u(1), 'members': [{'handle': 'sandbox-exact'}, {'handle': 'tn'}]}]}
        b.loops(fetch=lambda: loops)
        self.assertEqual(b.x.posts, [('Loop closed: @alice → @bob → house-scribe (AI) → @alice. 2 credits of promises '
                                      'cancelled. Nobody paid anyone. valun.tech/loop/vs_0123456789abcdef', None)])
        self.assertEqual(sorted(b.v.touched), ['x_alice', 'x_bob'])
        b.loops(fetch=lambda: loops)
        self.assertEqual(len(b.x.posts), 1, 'each loop once')

    def test_a_loop_with_an_ai_agent_starts_at_the_person(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_bob': {'x': 'bob'}}
        b.loops(fetch=lambda: {'loops': [{'id': 'vs_7df1466e64b5a3bc', 'each_PC': self.u(2),       # as the live one was listed
                                          'members': [{'handle': 'house-scribe'}, {'handle': 'x_bob'}]}]})
        self.assertEqual(b.x.posts[0][0], 'Loop closed: @bob → house-scribe (AI) → @bob. 2 credits of promises cancelled. '
                                          'Nobody paid anyone. valun.tech/loop/vs_7df1466e64b5a3bc')

    def test_a_loop_of_unequal_amounts(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_bob': {'x': 'bob'}}
        b.loops(fetch=lambda: {'loops': [{'id': 'vs_aaaaaaaaaaaaaaaa', 'each_PC': None, 'members': [{'handle': 'x_bob'}, {'handle': 'tn'}]}]})
        self.assertEqual(b.x.posts[0][0], 'Loop closed: @bob → tn → @bob. Promises cancelled. Nobody paid anyone. '
                                          'valun.tech/loop/vs_aaaaaaaaaaaaaaaa')


class FlowTestnet(Flow):
    """The same flow on the testnet: the server's amounts are nanoERG (credits x 1,000,000), the posts still say
    credits, and the posts that introduce credits say once what one is."""
    NETWORK = TESTNET

    def test_the_testnet_says_what_a_credit_is(self):
        self.assertEqual(self.note, ' A credit is 0.001 tERG, test coins with no value.')

    def test_part_of_a_credit_is_shown_exactly(self):
        b = self.circulating(held={'x_bob': {'x_alice': 2_500_000}})
        self.assertEqual(b.x.posts, [("@bob You hold 2.5 credits of alice's promises here, so you cannot pay 3 with them. "
                                      'Nothing was offered.', '1')])
        b = self.circulating(held={'x_bob': {'x_alice': 2_999_999}})
        self.assertIn('You hold 2.999999 credits', b.x.posts[0][0], 'one nanoERG short of 3 credits is short')
        b = self.circulating(held={'x_bob': {'x_alice': 3_000_000}})
        self.assertTrue(b.x.posts[0][0].startswith('Offer: @bob pays @carol 3 credits'), 'exactly 3 credits held: offered')
        ev = {'repayment': {'owed_ever_PC': 6_500_000, 'settled': {'by_setoff_PC': 4_000_000, 'by_redemption_PC': 250_000}}}
        self.assertIn('Repaid: 4.25 of 6.5 credits owed.', B.record_text('alice', ev, 'x_alice', self.scale))


class FakeScribe:
    """The CLI with house-scribe on the other side: a tl;dr is delivered on the second read of the deal; feedback is
    accepted, then checked once delivered (paid, or disputed with a note). A join leaves a profile on `network`."""
    def __init__(self, answer='Valun lets AI agents pay each other with signed IOUs, and debts that form a loop cancel.',
                 feedback_ok=True):
        self.answer, self.ok, self.deals, self.calls = answer, feedback_ok, {}, []
        self.home, self.network = None, PILOT

    def __call__(self, args, timeout=180):
        profile, cmd = args[1], args[2]
        self.calls.append((profile, *args[2:4]))
        if cmd == 'join':
            write_profile(self.home, profile, self.network)
            return 0, 'ok', ''
        if cmd == 'clearing':
            return 0, 'ok', ''
        tool, a = args[3], json.loads(args[4])
        if tool == 'valun_propose':
            did = f'vd_{len(self.deals) + 1}'
            self.deals[did] = {'role': a['role'], 'reads': 0, 'status': 'open', 'text': a['description'], 'price': a['price']}
            return 0, json.dumps({'deal_id': did, 'status': 'open'}), ''
        d = self.deals[a['deal_id']]
        if tool == 'valun_deal':
            d['reads'] += 1
            if d['role'] == 'payer' and d['status'] == 'open' and d['reads'] >= 2:
                d['status'], d['delivery'] = 'delivered', {'content': self.answer, 'sha256': 'cd' * 32}
            elif d['role'] == 'payee' and d['status'] == 'open':
                d['status'] = 'agreed'
            elif d['role'] == 'payee' and d['status'] == 'delivered':
                d['status'] = 'note_issued' if self.ok else 'disputed'
                d['dispute'] = None if self.ok else {'reason': 'Verdict: does not meet the terms. It is only praise. Name one thing that was unclear.'}
            return 0, json.dumps({'status': d['status'], 'delivery': d.get('delivery'), 'dispute': d.get('dispute')}), ''
        if tool == 'valun_review_delivery':
            d['status'] = 'note_issued' if a['decision'] == 'accept' else 'disputed'
            d['review'] = a
            return 0, json.dumps({'status': d['status']}), ''
        if tool == 'valun_deliver':
            d['status'], d['delivered'] = 'delivered', a['content']
            return 0, json.dumps({'status': 'delivered'}), ''
        raise AssertionError(tool)


class Agents(unittest.TestCase):
    """tl;dr and feedback: the real Bot and Valun steps, X and the scribe faked; AgentsTestnet runs them on the testnet.
    The price sent to the scribe is credits x the client's scale (read from the profile the identity joined with)."""
    NETWORK = PILOT

    def setUp(self):
        self.unit, self.scale = unit_scale(self.NETWORK)
        self.fetched = []

    def bot(self, scribe):
        home = tempfile.mkdtemp()
        scribe.home, scribe.network = home, self.NETWORK
        st = B.State(os.path.join(home, 's.json'))
        v = B.Valun(home=home, server='https://example.invalid', run=scribe,
                    fetch=lambda path: self.fetched.append(path) or {'network': self.NETWORK})
        return B.Bot(FakeX(), v, st, log=lambda **kw: None)

    def test_tldr_under_a_post(self):
        scribe = FakeScribe()
        b = self.bot(scribe)
        long_post = 'A long post about agents and credit. ' * 8
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bob @bindvalun tldr', reply_to='500', mentions=('bob',))]
        b.x.refs = [{'id': '500', 'author_id': 'id-bob', 'text': long_post}]
        b.poll()
        self.assertEqual(b.x.posts, [], 'asked, not yet delivered')
        self.assertIn(long_post.strip(), scribe.deals['vd_1']['text'])
        self.assertIn('at most 200 characters', scribe.deals['vd_1']['text'])
        self.assertEqual(scribe.deals['vd_1']['price'], B.TLDR_PRICE * self.scale, 'the scribe is offered its price in the unit')
        self.assertEqual(self.fetched, [], "the scale is the client's, from the profile the identity joined with")
        b.poll()
        self.assertEqual(b.x.posts, [('Valun lets AI agents pay each other with signed IOUs, and debts that form a loop cancel.'
                                      '\n\n— tl;dr by house-scribe, an AI agent, for 2 credits that @alice now owes it.', '1')])
        self.assertEqual(scribe.deals['vd_1']['review']['expected_deliverable_sha256'], 'cd' * 32)
        b.poll()
        self.assertEqual(len(b.x.posts), 1, 'answered once')
        b = self.bot(FakeScribe(answer='word ' * 40))                    # a full 200 characters, a 15-letter handle
        b.x.feed = [tweet(2, 'abcdefghijklmno', 'id-l', '@bob @bindvalun tldr', reply_to='500', mentions=('bob',))]
        b.x.refs = [{'id': '500', 'author_id': 'id-bob', 'text': long_post}]
        b.poll()
        b.poll()
        self.assertLessEqual(len(b.x.posts[0][0]), B.MAX_TEXT)
        self.assertTrue(b.x.posts[0][0].endswith('that @abcdefghijklmno now owes it.'))

    def test_tldr_refusals(self):
        b = self.bot(FakeScribe())
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun tldr'),                                # under nothing
                    tweet(2, 'carol', 'id-carol', '@bob @bindvalun tldr', reply_to='501', mentions=('bob',))]
        b.x.refs = [{'id': '501', 'author_id': 'id-bob', 'text': 'too short'}]
        b.poll()
        self.assertEqual([p[0][:22] for p in b.x.posts], ['@alice Reply "@bindval', '@carol That one is sho'])
        self.assertEqual(b.x.posts[0][0], '@alice Reply "@bindvalun tldr" under a long post, and an AI agent summarizes it for '
                                          '2 credits.' + B.credit_note(self.unit, self.scale))
        self.assertEqual(self.fetched, ['/pilot/v1/info'], 'no identity yet: the network the server names, read once')
        b = self.bot(FakeScribe(answer='x' * 2000))                                                  # far too long: disputed
        b.x.feed = [tweet(3, 'dan', 'id-dan', '@bob @bindvalun tldr', reply_to='502', mentions=('bob',))]
        b.x.refs = [{'id': '502', 'author_id': 'id-bob', 'text': 'y' * 300}]
        b.poll()
        b.poll()
        self.assertEqual(b.x.posts, [])
        self.assertEqual(b.v.run.deals['vd_1']['review']['decision'], 'dispute')

    def test_feedback_paid_and_passed(self):
        scribe = FakeScribe()
        b = self.bot(scribe)
        fb = 'feedback: the offer reply should show the link to the record before I accept, not after.'
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun ' + fb)]
        b.poll()                                    # offered, then accepted by the scribe (agreed): delivered
        self.assertEqual(scribe.deals['vd_1']['delivered'], fb[len('feedback: '):])
        self.assertEqual(scribe.deals['vd_1']['price'], B.FEEDBACK_PAY * self.scale, "the scribe's pay for x-feedback, in the unit")
        b.poll()                                    # checked and paid
        self.assertEqual(b.x.posts, [('Thank you. house-scribe, an AI agent, read this and found it specific enough to act on: '
                                      'it now owes @alice 2 credits. A tl;dr @alice owes it cancels against that.', '1')])
        b.x.feed = [tweet(2, 'alice', 'id-alice', '@bindvalun feedback: and another thing about the record page.')]
        b.poll()
        self.assertEqual(len(b.x.posts), 1, 'one feedback a day per person')
        b = self.bot(FakeScribe(feedback_ok=False))
        b.x.feed = [tweet(3, 'bob', 'id-bob', '@bindvalun feedback: this is great, I love it, well done everyone!!')]
        b.poll()
        b.poll()
        self.assertEqual(b.x.posts, [('@bob house-scribe, an AI agent, passed on this one, so nothing is owed. Its note: '
                                      'Name one thing that was unclear.', '3')])

    def test_feedback_too_short(self):
        b = self.bot(FakeScribe())
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun feedback: nice')]
        b.poll()
        self.assertEqual(b.x.posts, [('@alice Say a little more: what you tried, and what was unclear, broken or missing. The '
                                      'scribe pays 2 credits for feedback it can act on.' + B.credit_note(self.unit, self.scale), '1')])


class AgentsTestnet(Agents):
    NETWORK = TESTNET


class ValunSteps(unittest.TestCase):
    """Valun.bind and Valun.settle against a fake CLI: which key signs what, and the price in the network's unit;
    ValunStepsTestnet runs them on the testnet."""
    NETWORK = PILOT

    def run_bind(self, applies, via='alice'):
        home = tempfile.mkdtemp()
        cli = FakeCLI(transfer_applies=applies, home=home, network=self.NETWORK)
        v = B.Valun(home=home, server='https://example.invalid', run=cli, fetch=no_fetch)
        st = B.State(os.path.join(home, 's.json'))
        offer = {'debtor': 'bob', 'creditor': 'carol', 'via': via, 'amount': 3, 'what': 'the review', 'text': 't',
                 'post_id': '1', 'accept_id': '2'}
        return v.bind(st, offer), cli

    def test_paid_with_a_promise(self):
        (did, how), cli = self.run_bind(True)
        self.assertEqual((did, how), ('vd_2', 'transfer'))
        review = [c for c in cli.calls if c[1:3] == ('call', 'valun_review_delivery')]
        self.assertEqual([(c[0], json.loads(c[3]).get('pay_with')) for c in review], [('x_bob', 'x_alice')])
        self.assertEqual(sorted(c[0] for c in cli.calls if c[1] == 'clearing'), ['x_alice', 'x_carol'], 'the issuer and the payee sign')

    def test_transfer_fails_own_iou_pays(self):
        (did, how), cli = self.run_bind(False)
        self.assertEqual(how, 'own_note')
        review = [json.loads(c[3]) for c in cli.calls if c[1:3] == ('call', 'valun_review_delivery')]
        self.assertEqual([r.get('pay_with') for r in review], ['x_alice', None])

    def test_the_price_is_credits_times_the_clients_scale(self):
        (did, how), cli = self.run_bind(True, via=None)
        self.assertEqual(how, 'note')
        unit, scale = unit_scale(self.NETWORK)
        self.assertEqual(cli.proposed[0]['price'], 3 * scale)
        self.assertIn(f'in credits: 3 credits = {B.vc.amount_text(3 * scale, unit)}.', cli.proposed[0]['description'])


class ValunStepsTestnet(ValunSteps):
    NETWORK = TESTNET

    def test_the_testnet_price(self):
        (_did, _how), cli = self.run_bind(True, via=None)
        self.assertEqual(cli.proposed[0]['price'], 3_000_000)
        self.assertIn('in credits: 3 credits = 3000000 nanoERG (0.003 tERG).', cli.proposed[0]['description'])


class Network(unittest.TestCase):
    """Valun.network(): the client's unit and scale for the identities the bot holds, found once."""
    def valun(self, answers):
        home, reads = tempfile.mkdtemp(), []

        def fetch(path):
            reads.append(path)
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
        return B.Valun(home=home, server='https://example.invalid', run=None, fetch=fetch), home, reads

    def test_a_joined_profile_names_it(self):
        v, home, reads = self.valun([])
        write_profile(home, 'x_alice', TESTNET)
        self.assertEqual(v.network(), ('nanoERG', 1_000_000))
        self.assertEqual(v.units(5), 5_000_000)
        self.assertEqual(reads, [])

    def test_before_any_join_the_server_names_it_once(self):
        v, home, reads = self.valun([{'network': TESTNET, 'unit': 'nanoERG'}])
        os.makedirs(os.path.join(home, 'profiles'))
        with open(os.path.join(home, 'profiles', 'x_bob.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': 'https://example.invalid'}, f)                  # a join that stopped: no participant
        self.assertEqual(v.network(), ('nanoERG', 1_000_000))
        self.assertEqual(v.network(), ('nanoERG', 1_000_000))
        self.assertEqual(reads, ['/pilot/v1/info'])

    def test_a_server_before_networks_is_the_clients_default(self):
        v, _home, _reads = self.valun([{'unit': 'PC'}])
        self.assertEqual(v.network(), ('PC', 1))

    def test_an_unknown_network_or_no_answer_is_refused(self):
        v, _home, _reads = self.valun([{'network': 'valun-mainnet-9'}])
        with self.assertRaises(B.BindError) as e:
            v.network()
        self.assertEqual(e.exception.code, 'network_unknown')
        v, _home, _reads = self.valun([OSError('unreachable'), {'network': TESTNET}])
        with self.assertRaises(B.BindError):
            v.network()
        self.assertEqual(v.network(), ('nanoERG', 1_000_000), 'a failed read is not kept: the next one asks again')

    def test_no_network_no_note_and_no_offer_to_the_scribe(self):
        v, _home, _reads = self.valun([OSError('unreachable'), OSError('unreachable')])
        b = B.Bot(FakeX(), v, B.State(tempfile.mktemp(suffix='.json')), log=lambda **kw: None)
        self.assertEqual(b.note(), '', 'the words fail open')
        with self.assertRaises(B.BindError):
            v.units(2)                                                           # an amount fails closed


class Carry(unittest.TestCase):
    """A new home (the testnet's) takes the X side of the old state: no post answered twice, no X spending restarted."""
    def old_state(self, **extra):
        path = os.path.join(tempfile.mkdtemp(), 'bind-state.json')
        s = {'since_id': '1900', 'handled': ['1850', '1900'], 'month': B.now().strftime('%Y-%m'), 'month_usd': 7.25,
             'day': B.now().strftime('%Y-%m-%d'), 'day_usd': 0.5, 'counts': {'records': 2, 'offers:alice': 3},
             'offers': {'1001': {'state': 'open', 'debtor': 'alice'}}, 'jobs': {'1500': {'kind': 'tldr'}},
             'profiles': {'x_alice': {'x': 'alice'}}, 'loops_posted': ['vs_0123456789abcdef'], **extra}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(s, f)
        with open(path, 'rb') as f:
            return path, f.read()

    def test_the_x_side_carries_over_and_the_old_file_is_only_read(self):
        old, before = self.old_state()
        new = os.path.join(tempfile.mkdtemp(), 'bind-state.json')
        st = B.State(new, carry=old)
        self.assertEqual((st.s['since_id'], st.s['handled'], st.s['month_usd'], st.s['day_usd']), ('1900', ['1850', '1900'], 7.25, 0.5))
        self.assertEqual(st.s['counts'], {'records': 2, 'offers:alice': 3}, "today's limits go on")
        self.assertEqual((st.s['offers'], st.s['jobs'], st.s['profiles'], st.s['loops_posted']), ({}, {}, {}, []),
                         "the old network's identities, offers and jobs stay there")
        self.assertEqual(st.s['carried_from'], old)
        self.assertAlmostEqual(st.room(), min(B.MONTHLY_USD - 7.25, B.DAILY_USD - 0.5))
        st.save()
        with open(old, 'rb') as f:
            self.assertEqual(f.read(), before, 'the old state is never written')
        st.s['since_id'] = '2000'
        st.save()
        self.assertEqual(B.State(new, carry=old).s['since_id'], '2000', 'once the new home has a state, it is its own')

    def test_a_carried_post_is_not_answered_again(self):
        old, _ = self.old_state(handled=['1850', '1900'])
        b = B.Bot(FakeX(), FakeValun(network=TESTNET), B.State(os.path.join(tempfile.mkdtemp(), 's.json'), carry=old),
                  log=lambda **kw: None)
        b.x.feed = [tweet(1900, 'alice', 'id-alice', '@bindvalun I owe @bob 5 for the logo', mentions=('bob',))]
        b.poll()
        self.assertEqual(b.x.since_ids, ['1900'], 'reading goes on after the last post the old home read')
        self.assertEqual(b.x.posts, [])

    def test_a_spent_month_stays_spent(self):
        old, _ = self.old_state(month_usd=B.MONTHLY_USD - 0.01)
        b = B.Bot(FakeX(), FakeValun(network=TESTNET), B.State(os.path.join(tempfile.mkdtemp(), 's.json'), carry=old),
                  log=lambda **kw: None)
        b.x.feed = [tweet(2000, 'alice', 'id-alice', '@bindvalun I owe @bob 2', mentions=('bob',))]
        b.poll()
        self.assertEqual(b.x.posts, [], "this month's X budget is used up in the old home too")

    def test_a_missing_or_bad_old_state_is_a_fresh_start(self):
        st = B.State(os.path.join(tempfile.mkdtemp(), 's.json'), carry=os.path.join(tempfile.mkdtemp(), 'none.json'))
        self.assertEqual((st.s['handled'], st.s['month_usd'], st.s.get('carried_from')), ([], 0.0, None))
        old, _ = self.old_state(handled='not a list', month_usd='lots')
        st = B.State(os.path.join(tempfile.mkdtemp(), 's.json'), carry=old)
        self.assertEqual((st.s['handled'], st.s['month_usd'], st.s['since_id']), ([], 0.0, '1900'), 'only well-formed values carry')


if __name__ == '__main__':
    unittest.main()
