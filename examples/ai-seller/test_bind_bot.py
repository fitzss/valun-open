"""bind_bot.py offline: X's published OAuth 1.0a signature example, reading posts, every rule, and the whole flow with
a fake X and a fake Valun (no network, nothing posted, nothing spent)."""
import json
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
        self.assertEqual(B.parse_owe('@bindvalun I owe @Bob 5 for the logo.'), ('bob', 5, 'the logo', None))
        self.assertEqual(B.parse_owe('@bindvalun i owe @bob 3 credits'), ('bob', 3, '', None))
        self.assertEqual(B.parse_owe('@bindvalun I owe @bob 2: a review of @carol_x work'), ('bob', 2, 'a review of carol_x work', None))
        self.assertEqual(B.parse_owe('@bindvalun I owe @bob 5 for dinner with @carol'), ('bob', 5, 'dinner with carol', None))
        self.assertIsNone(B.parse_owe('@bindvalun @bob owes me 5'))
        self.assertIsNone(B.parse_owe('@bindvalun hello'))

    def test_pay_with_a_promise(self):
        self.assertEqual(B.parse_owe('@bindvalun I owe @carol 3 for the review, pay with @alice'), ('carol', 3, 'the review', 'alice'))
        self.assertEqual(B.parse_owe("@bindvalun pay @carol 3 with @alice's promise for the review"), ('carol', 3, 'the review', 'alice'))
        self.assertEqual(B.parse_owe('@bindvalun I owe @carol 2, paid with @Alice\u2019s IOU.'), ('carol', 2, '', 'alice'))
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
        self.assertTrue(text.endswith('x\u2026. Open.'))
        self.assertEqual(B.fit(make, 'a logo'), make('a logo'))

    def test_tldr_and_feedback(self):
        for t in ('@bindvalun tldr', '@bob @bindvalun TL;DR please', '@bindvalun summarize this', '@bindvalun tl;dr: x'):
            self.assertTrue(B.TLDR.match(B.post_text({'text': t})), t)
        for t in ('@bindvalun tldrs are fun', '@bindvalun I owe @bob 1', '@bindvalun record'):
            self.assertFalse(B.TLDR.match(B.post_text({'text': t})), t)
        self.assertEqual(B.FEEDBACK.match('feedback: the offer reply is too long').group(1), 'the offer reply is too long')
        self.assertEqual(B.post_text({'text': 'short', 'note_tweet': {'text': '@a long text'}}), 'long text')

    def test_clean_for_x(self):
        t = B.clean_for_x('TL;DR: **Bold** claim by @alice about #AI, see https://evil.example/x and valun.tech.\n- a bullet', 200)
        self.assertEqual(t, 'Bold claim by alice about AI, see and valun\u2024tech. a bullet')
        self.assertNotRegex(t, B.URL_RE)
        long = B.clean_for_x('word ' * 100, 50)
        self.assertLessEqual(len(long), 50)
        self.assertTrue(long.endswith('word\u2026'))

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
    def __init__(self, fail=None, how='note', held=None, settle_to='transfer', public=None):
        self.binds, self.fail, self.touched, self.how, self._held = [], fail, [], how, held or {}
        self.settle_to, self._public, self.settles = settle_to, public, 0

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
    """The `python -m valun` commands Valun runs, answered as the pilot answered them (pay_probe, 2026-11-13)."""
    def __init__(self, transfer_applies=True):
        self.status, self.calls, self.cleared, self.applies = None, [], set(), transfer_applies

    def __call__(self, args, timeout=180):
        profile, cmd = args[1], args[2]
        self.calls.append((profile, *args[2:]))
        if cmd == 'join':
            return 0, 'joined', ''
        if cmd == 'clearing':
            self.cleared.add(profile)
            if self.status == 'paying_by_transfer' and {'x_alice', 'x_carol'} <= self.cleared:
                self.status = 'paid_by_transfer' if self.applies else 'payment_due'
            return 0, 'signed', ''
        tool, a = args[3], json.loads(args[4])
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
    def bot(self, valun=None):
        st = B.State(tempfile.mktemp(suffix='.json'))
        return B.Bot(FakeX(), valun or FakeValun(), st, log=lambda **kw: None)

    def test_offer_accept_bound(self):
        b = self.bot()
        b.x.feed = [tweet(1, 'alice', 'id-alice', '@bindvalun I owe @bob 5 for the logo', mentions=('bob',))]
        b.poll()
        text, reply_to = b.x.posts[0]
        self.assertEqual(reply_to, '1')
        self.assertEqual(text, 'Offer: @alice owes @bob 5 credits for the logo. @bob, reply "accept" to this post to bind it. '
                               'Open for 24 hours. Once bound, @bob can pass it on.')
        offer_id = '1001'
        b.x.feed = [tweet(2, 'mallory', 'id-mallory', '@bindvalun accept', reply_to=offer_id)]   # not the creditor
        b.poll()
        self.assertEqual(len(b.x.posts), 1)
        b.x.feed = [tweet(3, 'bob', 'id-bob', '@bindvalun @alice accept', reply_to=offer_id)]
        b.poll()
        self.assertEqual(b.v.binds[0]['amount'], 5)
        self.assertEqual(b.v.binds[0]['accept_id'], '3')
        self.assertEqual(b.x.posts[1], ('Bound. @alice owes @bob 5 credits for the logo. @bob can now pay others with it. '
                                        'Recorded by a Basis tracker: valun.tech/agent/x_alice', '3'))
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

    def circulating(self, **kw):
        b = self.bot(FakeValun(**kw))
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}, 'x_bob': {'x': 'bob'}}
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun I owe @carol 3 for the review, pay with @alice', mentions=('carol', 'alice'))]
        b.poll()
        return b

    def test_pay_with_a_promise(self):
        b = self.circulating(how='transfer', held={'x_bob': {'x_alice': 3}})
        self.assertEqual(b.x.posts[0], ("Offer: @bob pays @carol 3 credits for the review with @alice's promise: @alice would "
                                        'owe @carol instead of @bob. @carol, reply "accept" to take it. Open for 24 hours.', '1'))
        b.x.feed = [tweet(2, 'carol', 'id-carol', '@bindvalun accept', reply_to='1001')]
        b.poll()
        self.assertEqual(b.v.binds[0]['via'], 'alice')
        self.assertEqual(b.x.posts[1], ("Paid with a promise. 3 credits of @alice's IOU to @bob now belong to @carol: @alice owes "
                                        '@carol instead, and @bob paid for the review with no new IOU. Recorded by a Basis '
                                        'tracker: valun.tech/agent/x_carol', '2'))
        self.assertEqual(b.st.s['offers']['1001']['state'], 'bound')

    def test_pay_with_a_promise_one_does_not_hold(self):
        b = self.circulating(held={'x_bob': {'x_alice': 1}})
        self.assertEqual(b.x.posts, [("@bob You hold 1 credit of alice's promises here, so you cannot pay 3 with them. "
                                      'Nothing was offered.', '1')])
        self.assertEqual(b.st.s['offers'], {})
        b = self.bot()
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun I owe @carol 3, pay with @carol', mentions=('carol',)),
                    tweet(2, 'bob', 'id-bob', '@bindvalun I owe @carol 3, pay with @alice', mentions=('carol',))]   # @alice not tagged
        b.poll()
        self.assertEqual(b.x.posts, [])

    def test_transfer_waiting_then_settled(self):
        b = self.circulating(how='pending', held={'x_bob': {'x_alice': 3}}, settle_to='pending')
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
        pos = {'owes': 2, 'claims_held': 5, 'cleared_by_setoff': 1, 'novated_as_issuer': 3}
        b = self.bot(FakeValun(public=pos))
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}}
        b.x.feed = [tweet(1, 'bob', 'id-bob', '@bindvalun record @alice', mentions=('alice',)),
                    tweet(2, 'bob', 'id-bob', '@bindvalun record')]          # one a day per author
        b.poll()
        self.assertEqual(b.x.posts, [("alice's record: owes 2 credits, holds 5 of others' promises; 3 credits of alice's "
                                      "promises changed hands; 1 cancelled in loops. valun.tech/agent/x_alice", '1')])
        b.x.feed = [tweet(3, 'dan', 'id-dan', '@bindvalun my record')]
        b.poll()
        self.assertEqual(b.x.posts[1][0], '@dan has no promises bound here yet. One starts with a post like "@bindvalun I owe" '
                                          "plus someone's handle and 1 to 5 credits.")

    def test_loops(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_alice': {'x': 'alice'}, 'x_bob': {'x': 'bob'}}
        loops = {'loops': [{'id': 'vs_0123456789abcdef', 'each_PC': 2, 'members': [{'handle': 'x_alice'}, {'handle': 'x_bob'}, {'handle': 'house-scribe'}]},
                           {'id': 'vs_fedcba9876543210', 'each_PC': 1, 'members': [{'handle': 'sandbox-exact'}, {'handle': 'tn'}]}]}
        b.loops(fetch=lambda: loops)
        self.assertEqual(b.x.posts, [('Loop closed: @alice → @bob → house-scribe (AI) → @alice. 2 credits of promises '
                                      'cancelled. Nobody paid anyone. valun.tech/loop/vs_0123456789abcdef', None)])
        self.assertEqual(sorted(b.v.touched), ['x_alice', 'x_bob'])
        b.loops(fetch=lambda: loops)
        self.assertEqual(len(b.x.posts), 1, 'each loop once')

    def test_a_loop_with_an_ai_agent_starts_at_the_person(self):
        b = self.bot()
        b.st.s['profiles'] = {'x_bob': {'x': 'bob'}}
        b.loops(fetch=lambda: {'loops': [{'id': 'vs_7df1466e64b5a3bc', 'each_PC': 2,       # as the live one was listed
                                          'members': [{'handle': 'house-scribe'}, {'handle': 'x_bob'}]}]})
        self.assertEqual(b.x.posts[0][0], 'Loop closed: @bob → house-scribe (AI) → @bob. 2 credits of promises cancelled. '
                                          'Nobody paid anyone. valun.tech/loop/vs_7df1466e64b5a3bc')


class FakeScribe:
    """The CLI with house-scribe on the other side: a tl;dr is delivered on the second read of the deal; feedback is
    accepted, then checked once delivered (paid, or disputed with a note)."""
    def __init__(self, answer='Valun lets AI agents pay each other with signed IOUs, and debts that form a loop cancel.',
                 feedback_ok=True):
        self.answer, self.ok, self.deals, self.calls = answer, feedback_ok, {}, []

    def __call__(self, args, timeout=180):
        profile, cmd = args[1], args[2]
        self.calls.append((profile, *args[2:4]))
        if cmd in ('join', 'clearing'):
            return 0, 'ok', ''
        tool, a = args[3], json.loads(args[4])
        if tool == 'valun_propose':
            did = f'vd_{len(self.deals) + 1}'
            self.deals[did] = {'role': a['role'], 'reads': 0, 'status': 'open', 'text': a['description']}
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
    """tl;dr and feedback: the real Bot and Valun steps, X and the scribe faked."""
    def bot(self, scribe):
        home = tempfile.mkdtemp()
        st = B.State(os.path.join(home, 's.json'))
        return B.Bot(FakeX(), B.Valun(home=home, server='https://example.invalid', run=scribe), st, log=lambda **kw: None)

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
        b.poll()
        self.assertEqual(b.x.posts, [('Valun lets AI agents pay each other with signed IOUs, and debts that form a loop cancel.'
                                      '\n\n\u2014 tl;dr by house-scribe, an AI agent, for 2 credits that @alice now owes it.', '1')])
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


class ValunSteps(unittest.TestCase):
    """Valun.bind and Valun.settle against a fake CLI: which key signs what."""
    def run_bind(self, applies):
        home = tempfile.mkdtemp()
        cli = FakeCLI(transfer_applies=applies)
        v = B.Valun(home=home, server='https://example.invalid', run=cli)
        st = B.State(os.path.join(home, 's.json'))
        offer = {'debtor': 'bob', 'creditor': 'carol', 'via': 'alice', 'amount': 3, 'what': 'the review', 'text': 't',
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


if __name__ == '__main__':
    unittest.main()
