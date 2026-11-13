"""bind_bot.py offline: X's published OAuth 1.0a signature example, reading posts, every rule, and the whole flow with
a fake X and a fake Valun (no network, nothing posted, nothing spent)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bind_bot as B  # noqa: E402


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
        self.assertEqual(B.parse_owe('@bindvalun I owe @Bob 5 for the logo.'), ('bob', 5, 'the logo'))
        self.assertEqual(B.parse_owe('@bindvalun i owe @bob 3 credits'), ('bob', 3, ''))
        self.assertEqual(B.parse_owe('@bindvalun I owe @bob 2: a review of @carol_x work'), ('bob', 2, 'a review of carol_x work'))
        self.assertIsNone(B.parse_owe('@bindvalun @bob owes me 5'))
        self.assertIsNone(B.parse_owe('@bindvalun hello'))

    def test_accept(self):
        for t in ('@bindvalun accept', '@bindvalun @alice Accepted!', 'yes', '@bindvalun bind'):
            self.assertTrue(B.is_accept(t), t)
        for t in ('@bindvalun I do not accept', 'no', '@bindvalun what is this'):
            self.assertFalse(B.is_accept(t), t)

    def test_profile_name(self):
        self.assertEqual(B.profile_name('Alice_99'), 'x_alice_99')


class FakeX:
    def __init__(self):
        self.posts, self.feed, self.n = [], [], 1000

    def me(self):
        return {'id': 'bot', 'username': 'bindvalun'}

    def mentions(self, uid, since_id=None):
        data, self.feed = self.feed, []
        users = {}
        for t in data:
            users[t['author_id']] = {'id': t['author_id'], 'username': t.pop('_author')}
        return {'data': data, 'includes': {'users': list(users.values())}, 'meta': {'newest_id': data[-1]['id']} if data else {}}

    def post(self, text, reply_to=None):
        self.n += 1
        self.posts.append((text, reply_to))
        return {'id': str(self.n)}


class FakeValun:
    def __init__(self, fail=None):
        self.binds, self.fail, self.touched = [], fail, []

    def bind(self, state, offer):
        if self.fail:
            raise B.BindError(self.fail, 'no')
        for x in (offer['debtor'], offer['creditor']):
            state.s['profiles'].setdefault(B.profile_name(x), {'x': x})
        self.binds.append(dict(offer))
        return 'vd_' + '1' * 16

    def touch(self, name):
        self.touched.append(name)


def tweet(tid, author, author_id, text, reply_to=None, mentions=()):
    return {'id': str(tid), 'author_id': author_id, '_author': author, 'text': text,
            'entities': {'mentions': [{'username': m, 'id': f'id-{m}'} for m in ('bindvalun', *mentions)]},
            **({'referenced_tweets': [{'type': 'replied_to', 'id': reply_to}]} if reply_to else {})}


class Flow(unittest.TestCase):
    def bot(self, valun=None):
        st = B.State(tempfile.mktemp(suffix='.json'))
        return B.Bot(FakeX(), valun or FakeValun(), st, log=lambda **kw: None)

    def test_offer_accept_bound(self):
        b = self.bot()
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @bob 5 for the logo', mentions=('bob',))]
        b.poll()
        text, reply_to = b.x.posts[0]
        self.assertEqual(reply_to, '1')
        self.assertEqual(text, 'Offer: @alice owes @bob 5 credits for the logo. @bob, reply "accept" to this post to bind it. Open for 24 hours.')
        offer_id = '1001'
        b.x.feed = [tweet(2, 'mallory', 'id-mallory', '@bindvalun accept', reply_to=offer_id)]   # not the creditor
        b.poll()
        self.assertEqual(len(b.x.posts), 1)
        b.x.feed = [tweet(3, 'bob', 'id-bob', '@bindvalun @alice accept', reply_to=offer_id)]
        b.poll()
        self.assertEqual(b.v.binds[0]['amount'], 5)
        self.assertEqual(b.v.binds[0]['accept_id'], '3')
        self.assertEqual(b.x.posts[1], ('Bound. @alice owes @bob 5 credits for the logo. Recorded by a Basis tracker: valun.tech/agent/x_alice', '3'))
        self.assertEqual(b.st.s['offers'][offer_id]['state'], 'bound')
        # spending: one plain reply, one with a link, the posts and users read
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
        self.assertEqual(len(b.x.posts), 1)
        self.assertIn('1 to 5 credits', b.x.posts[0][0])
        for i in range(5):
            b.x.feed = [tweet(10 + i, 'carol', 'id-carol', f'@bindvalun I owe @dan {1 + i % 5}', mentions=('dan',))]
            b.poll()
        self.assertEqual(sum(1 for p in b.x.posts if p[0].startswith('Offer: @carol')), 3, 'three offers a day from one debtor')

    def test_refused_bind_says_nothing_is_owed(self):
        b = self.bot(FakeValun(fail='mandate_exceeded'))
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

    def test_loops(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}, 'x_bob': {'x': 'bob'}}
        loops = {'loops': [{'id': 'vs_0123456789abcdef', 'each_PC': 2, 'members': [{'handle': 'x_alice'}, {'handle': 'x_bob'}, {'handle': 'house-scribe'}]},
                           {'id': 'vs_fedcba9876543210', 'each_PC': 1, 'members': [{'handle': 'sandbox-exact'}, {'handle': 'tn'}]}]}
        b.loops(fetch=lambda: loops)
        self.assertEqual(b.x.posts, [('Loop closed: @alice → @bob → house-scribe → @alice. 2 credits of promises cancelled. '
                                      'Nobody paid anyone. valun.tech/loop/vs_0123456789abcdef', None)])
        self.assertEqual(sorted(b.v.touched), ['x_alice', 'x_bob'])
        b.loops(fetch=lambda: loops)
        self.assertEqual(len(b.x.posts), 1, 'each loop once')


if __name__ == '__main__':
    unittest.main()
