"""Fix inbox #192/#196 (offline, real signatures), against a fake Valun server: an offer can name the payment issuer, the
participant whose note the payer will pass to the payee (payment_issuer {id, pubkey} in the signed terms).

- valun_propose and valun_respond counter take pay_with (a handle or id) and sign payment_issuer into the terms; a counter
  without it keeps the issuer of the offer it answers, 'own_note' drops it; terms without it are exactly as before;
- the payee sees it before it agrees: valun_deal and valun_inbox say what it means, and the approval texts name it;
- the client refuses terms that name a party, or the issuer under another key than its registered one;
- valun_review_delivery accept on such a deal pays with the named issuer when pay_with is left out, and refuses the payer's
  own note (terms_name_payment_issuer) and another issuer (payment_issuer_mismatch) before anything is signed.
The payee's consent loop (novation.evaluate_consent) is in test_novation.py's decision table."""
import json
import os
import sys
import unittest
from datetime import timedelta
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import client as vc  # noqa: E402
from valun.agent import ValunAgent  # noqa: E402
from test_client_complete import ALICE, ALICE_ID, BOB, BOB_ID, DENOM, MALLORY, NFT, MemStore, key, sign_text  # noqa: E402
from test_offer_terms import DEAL, H, T0, Clock, iso  # noqa: E402

ANN, ANN_ID, MAL_ID = key('test/ann'), 'vp_a2a2a2a2a2a2', 'vp_ae0ae0ae0ae0'
PEOPLE = {ALICE_ID: ('alice', ALICE), BOB_ID: ('bob', BOB), ANN_ID: ('ann', ANN), MAL_ID: ('mallory', MALLORY)}


def terms(proposer=BOB_ID, payer=BOB_ID, payee=ALICE_ID, **extra):
    t = {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': DEAL,
         'version': 1, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': proposer,
         'payer': {'id': payer, 'pubkey': PEOPLE[payer][1]['pubkey']}, 'payee': {'id': payee, 'pubkey': PEOPLE[payee][1]['pubkey']},
         'service': {'title': 'Quick summary', 'description': 'Summarize three sources in 100 words.', 'deliverable': 'Plain text.'},
         'price': {'amount': 12, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
         'deliver_by': iso(T0 + 48 * H), 'offer_expires_at': iso(T0 + 24 * H)}
    t.update(extra)
    return t


def named(pid=ANN_ID, k=ANN):
    return {'id': pid, 'pubkey': k['pubkey']}


def offer_view(t, by=BOB_ID, signer=BOB, you=ALICE_ID):
    h = vc.terms_hash(t)
    role = 'payer' if t['payer']['id'] == you else 'payee'
    other = t['payee']['id'] if role == 'payer' else t['payer']['id']
    v = {'id': DEAL, 'status': 'open', 'your_role': role, 'counterparty': {'id': other, 'handle': PEOPLE[other][0]},
         'current': {'version': t['version'], 'by': by, 'state': 'open', 'terms': t, 'terms_hash': h,
                     'signature': sign_text(signer, vc.statement('propose', h))}, 'versions': [], 'history': []}
    if 'payment_issuer' in t:       # as the server adds it (lib/pilot/core.mjs view)
        v['payment_issuer'] = {'id': t['payment_issuer']['id'], 'handle': PEOPLE.get(t['payment_issuer']['id'], ('?',))[0],
                               'pubkey': t['payment_issuer'].get('pubkey'), 'words': 'server words'}
    return v


def delivered_view(t):
    """Alice pays Bob: Alice proposed, Bob accepted, Bob delivered."""
    h = vc.terms_hash(t)
    content = 'The work, exactly as agreed. ' * 10
    dh = vc.sha256_hex(content)
    v = offer_view(t, by=ALICE_ID, signer=ALICE)
    v.update(status='delivered', agreement={'version': 1, 'terms_hash': h, 'proposer_signature': sign_text(ALICE, vc.statement('propose', h)),
                                            'acceptor_signature': sign_text(BOB, vc.statement('accept', h))},
             delivery={'by': BOB_ID, 'sha256': dh, 'content': content, 'bytes': len(content), 'title': '',
                       'signature': sign_text(BOB, vc.statement('deliver', h, dh))}, next_actions=['pay_by_transfer', 'dispute'])
    v['current']['state'] = 'accepted'
    return v


class Server:
    """A fake Valun server: the directory (Alice, Bob, Ann, Mallory), one deal, and what it is sent."""

    def __init__(self, deal=None, held=(ANN_ID, MAL_ID)):
        self.deal, self.log, self.posts, self.held = deal, [], [], held

    def request(self, method, path, body=None):
        self.log.append(f'{method} {path}')
        if path == '/pilot/v1/info':
            return {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM,
                    'features': ['bound_notes/1', 'circulation/1']}
        for pid, (handle, k) in PEOPLE.items():
            if path == f'/pilot/v1/participants/{pid}':
                return {'id': pid, 'handle': handle, 'status': 'active', 'pubkey': k['pubkey']}
        if path == '/pilot/v1/participants':
            return [{'id': pid, 'handle': h, 'status': 'active', 'services': '', 'agent_last_seen': iso(Clock.now_at)}
                    for pid, (h, _k) in PEOPLE.items()]
        if path == '/pilot/v1/me':
            return {'id': ALICE_ID, 'mandate': {}}
        if method == 'GET' and self.deal is not None and path == f'/pilot/v1/deals/{DEAL}':
            return json.loads(json.dumps(self.deal))
        if method == 'GET' and path == f'/pilot/v1/deals/{DEAL}/payment-options':
            return {'deal_id': DEAL, 'own_note': {'available': False, 'why_not': 'terms_name_payment_issuer'},
                    'held_notes': [{'issuer': {'id': i, 'handle': PEOPLE[i][0]}, 'why_not': None, 'enough': True} for i in self.held]}
        if method == 'POST' and path in ('/pilot/v1/deals', f'/pilot/v1/deals/{DEAL}/counter'):
            self.posts.append((path, body))
            return {'id': body['terms']['deal_id'], 'status': 'open', 'pending_counter': None, 'next_actions': ['wait'],
                    'current': {'terms': body['terms'], 'terms_hash': body['terms_hash']}}
        if method == 'GET' and path == '/pilot/v1/inbox':
            row = {'deal_id': DEAL, 'status': 'open', 'counterparty': 'bob', 'your_role': 'payee', 'title': 'Quick summary',
                   'payment_issuer': {'id': ANN_ID, 'handle': 'ann'}}
            return {'respond': [row], 'deliver': [], 'review_delivery': [], 'awaiting_your_owner': [], 'waiting_on_others': [],
                    'recent_closed': []}
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)

    def signed(self):
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


PROPOSE = {'counterparty': 'bob', 'role': 'payee', 'title': 'Quick summary', 'description': 'Summarize three sources in 100 words.',
           'deliverable': 'Plain text.', 'price': 12}


@mock.patch('valun.client.datetime', Clock)
@mock.patch('valun.agent.datetime', Clock)
class Offers(unittest.TestCase):
    def setUp(self):
        Clock.now_at = T0 + timedelta(minutes=10)

    def test_propose_with_pay_with_signs_payment_issuer_into_the_terms(self):
        net = Server()
        r = Agent(net).call('valun_propose', dict(PROPOSE, pay_with='ann'))
        t = net.signed()
        self.assertEqual(t['payment_issuer'], named())
        self.assertEqual(r['terms_hash'], vc.terms_hash(t))
        self.assertIn("pay you by passing on 12 PC of ann's note", r['if_agreed'])
        # Without pay_with (or with 'own_note'): no field at all, as before.
        for extra in ({}, {'pay_with': 'own_note'}):
            net = Server()
            Agent(net).call('valun_propose', dict(PROPOSE, **extra))
            self.assertNotIn('payment_issuer', net.signed())

    def test_pay_with_naming_a_party_is_refused_before_anything_is_signed(self):
        for who in ('bob', ALICE_ID):
            net = Server()
            r = Agent(net).call_safe('valun_propose', dict(PROPOSE, pay_with=who))
            self.assertEqual(r['error'], 'bad_arguments', r)
            self.assertIn('third participant', r['message'])
            self.assertEqual(net.posts, [])
        r = Agent(Server()).call_safe('valun_propose', dict(PROPOSE, pay_with=7))
        self.assertEqual(r['error'], 'bad_arguments')

    def test_the_approval_text_of_an_offer_names_the_issuer_and_the_args_pin_its_id(self):
        p = Agent(Server()).prepare('valun_propose', dict(PROPOSE, role='payer', pay_with='ann'))
        self.assertEqual(p['args']['pay_with'], ANN_ID)
        self.assertIn(f'payment issuer named in the terms: ann ({ANN_ID}): you will pay bob by passing on a note issued by '
                      f'ann ({ANN_ID}) that you hold, not a note of your own', p['text'])
        self.assertNotIn('payment issuer', Agent(Server()).prepare('valun_propose', PROPOSE)['text'])

    def test_a_counter_keeps_replaces_or_drops_the_issuer_of_the_offer_it_answers(self):
        for pay_with, expect in ((None, named()), ('mallory', named(MAL_ID, MALLORY)), ('own_note', None)):
            net = Server(offer_view(terms(payment_issuer=named())))
            a = {'deal_id': DEAL, 'action': 'counter', 'price': 14, **({'pay_with': pay_with} if pay_with else {})}
            p = Agent(net).prepare('valun_respond', a)
            r = Agent(net).call('valun_respond', p['args'])
            self.assertEqual(r['status'], 'open', r)
            self.assertEqual(net.signed().get('payment_issuer'), expect, pay_with)
            line = {None: f'payment issuer named in the terms, as in their offer: ann ({ANN_ID}): bob will pay by passing you a note issued by ann ({ANN_ID})',
                    'mallory': f'payment issuer named in the terms: mallory ({MAL_ID}): bob will pay by passing you a note issued by mallory',
                    'own_note': f'your agent removes the payment issuer of their offer (ann ({ANN_ID}))'}[pay_with]
            self.assertIn(line, p['text'])

    def test_the_payee_sees_the_issuer_before_it_agrees(self):
        net = Server(offer_view(terms(payment_issuer=named())))
        d = Agent(net).call('valun_deal', {'deal_id': DEAL})
        self.assertEqual(d['payment_issuer']['id'], ANN_ID)
        self.assertEqual(d['payment_issuer']['what_it_means'],
                         f'bob will pay by passing you a note issued by ann ({ANN_ID}), not a note of its own; no other note pays '
                         'these terms. Accepting them agrees to that; declining or countering refuses it')
        self.assertEqual(d['checked_by_your_client']['proposer_signature_valid'], True)
        box = Agent(net).call('valun_inbox', {})
        self.assertIn(f'bob will pay by passing you a note issued by ann ({ANN_ID})', box['respond'][0]['payment_issuer']['what_it_means'])
        text = Agent(net).prepare('valun_respond', {'deal_id': DEAL, 'action': 'accept'})['text']
        self.assertIn(f'payment issuer named in the terms: ann ({ANN_ID}): bob will pay by passing you a note issued by ann ({ANN_ID})', text)
        # Terms without it: no such key.
        self.assertNotIn('payment_issuer', Agent(Server(offer_view(terms()))).call('valun_deal', {'deal_id': DEAL}))

    def test_terms_naming_a_party_or_another_key_are_refused_by_the_client(self):
        for pi, code in ((named(BOB_ID, BOB), 'bad_terms'), (named(ANN_ID, MALLORY), 'wrong_key'), ({'id': ANN_ID}, 'bad_terms')):
            c = client(Server(offer_view(terms(payment_issuer=pi))))
            with self.assertRaises(vc.ValunError) as e:
                c.verify_offer(c.deal(DEAL))
            self.assertEqual(e.exception.code, code, pi)
        c = client(Server(offer_view(terms(payment_issuer=named()))))
        self.assertEqual(c.verify_offer(c.deal(DEAL))['terms']['payment_issuer'], named())


@mock.patch('valun.client.datetime', Clock)
@mock.patch('valun.agent.datetime', Clock)
class Paying(unittest.TestCase):
    def setUp(self):
        Clock.now_at = T0 + timedelta(minutes=10)

    def deal(self):
        return delivered_view(terms(proposer=ALICE_ID, payer=ALICE_ID, payee=BOB_ID, payment_issuer=named()))

    def test_the_own_note_is_refused_before_any_template_is_read(self):
        net = Server(self.deal())
        with self.assertRaises(vc.ValunError) as e:
            client(net).complete(DEAL)
        self.assertEqual(e.exception.code, 'terms_name_payment_issuer')
        self.assertEqual(e.exception.extra['payment_issuer'], {'id': ANN_ID})
        self.assertFalse([x for x in net.log if 'template' in x], net.log)
        r = Agent(net).call_safe('valun_review_delivery', {'deal_id': DEAL, 'decision': 'accept', 'pay_with': 'own_note'})
        self.assertEqual(r['error'], 'terms_name_payment_issuer')

    def test_review_without_pay_with_pays_with_the_named_issuer(self):
        net = Server(self.deal())
        with mock.patch.object(Agent, '_review_pay_with', return_value={'status': 'paying_by_transfer'}) as pay:
            r = Agent(net).call('valun_review_delivery', {'deal_id': DEAL, 'decision': 'accept'})
        self.assertEqual(r, {'status': 'paying_by_transfer'})
        self.assertEqual(pay.call_args.args[2], ANN_ID)
        self.assertFalse([x for x in net.log if 'template' in x], net.log)

    def test_another_issuer_is_refused_before_anything_is_signed(self):
        net = Server(self.deal())
        c = client(net)
        with mock.patch.object(vc.Client, '_contract', return_value=None):
            with self.assertRaises(vc.ValunError) as e:
                c.pay_by_transfer(DEAL, 'mallory')
        self.assertEqual(e.exception.code, 'payment_issuer_mismatch')
        self.assertEqual(e.exception.extra, {'payment_issuer': {'id': ANN_ID}, 'issuer': MAL_ID})
        self.assertFalse([x for x in net.log if 'template' in x], net.log)
        # The approval path refuses it too, and asks nobody.
        with mock.patch.object(vc.Client, '_contract', return_value=None):
            p, refusal = Agent(net).prepare_or_refusal('valun_review_delivery', {'deal_id': DEAL, 'decision': 'accept', 'pay_with': 'mallory'})
        self.assertIsNone(p)
        self.assertEqual(refusal['error'], 'approval_unbound')


if __name__ == '__main__':
    unittest.main()
