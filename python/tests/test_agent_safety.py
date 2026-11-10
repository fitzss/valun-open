"""Approval safety in the agent layer (offline): fail-closed commitment detection, exact decisions, and approvals
bound to the exact terms (found by the JavaScript port's parity work, 2026-11-07). Since 0.4: classification fails
closed by tool name, prepare() binds and describes from one read and refuses (approval_unbound) when it cannot read
what would be signed, and the adapters (MCP, `valun call`) refuse instead of asking with a generic text. The approval
text is built only from values checked against what is signed: the terms and the delivered text must hash to the
hashes that the arguments pin, and the role comes from the signed terms (a lying snapshot is refused)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun.agent import ValunAgent  # noqa: E402
from test_client_complete import ALICE, ALICE_ID, BOB, BOB_ID, DENOM, NFT, MemStore, World, WorldClient, sign_text  # noqa: E402

UNBOUND = 'could not read what you would sign; nothing was signed'
ME_ID = ALICE_ID
PK = {ALICE_ID: ALICE['pubkey'], BOB_ID: BOB['pubkey']}


def make_terms(price=20, service=None, payer=ME_ID, payee=BOB_ID, proposer=BOB_ID, deal_id='vd_1', version=2):
    """A complete valun-deal/1 terms object (16 fields). The keys are real, but these tests check what is shown, so
    nothing here is signed unless a test signs it."""
    return {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': deal_id,
            'version': version, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': proposer,
            'payer': {'id': payer, 'pubkey': PK.get(payer, '02' + '00' * 32)}, 'payee': {'id': payee, 'pubkey': PK.get(payee, '02' + '00' * 32)},
            'service': service or {'title': 'Short research brief', 'description': 'Three sources.', 'deliverable': 'markdown, 300-500 words'},
            'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
            'deliver_by': '2099-01-02T00:00:00.000Z', 'offer_expires_at': '2099-01-01T00:00:00.000Z'}


def make_deal(terms=None, content='word ' * 320, handle='bob'):
    """A deal as the server shows it to the payer (ME_ID), with consistent hashes: delivered against its agreed terms."""
    t = terms or make_terms()
    h = vc.terms_hash(t)
    return {'id': t['deal_id'], 'status': 'delivered', 'your_role': 'payer' if t['payer']['id'] == ME_ID else 'payee',
            'counterparty': {'id': BOB_ID, 'handle': handle},
            'current': {'version': t['version'], 'by': t['proposer'], 'state': 'accepted', 'terms_hash': h, 'terms': t},
            'agreement': {'version': t['version'], 'terms_hash': h},
            'delivery': {'title': 'Brief', 'content': content, 'sha256': vc.sha256_hex(content), 'bytes': len(content.encode('utf-8'))}}


def edited(d, **parts):
    """A copy of deal `d` with some of its parts replaced: current=..., delivery=..., or top-level keys."""
    d = json.loads(json.dumps(d))
    for k, v in parts.items():
        if isinstance(v, dict) and isinstance(d.get(k), dict):
            d[k].update(v)
        else:
            d[k] = v
    return d


DEAL = make_deal()
T = DEAL['current']['terms_hash']
SHA = DEAL['delivery']['sha256']
ME = {'agent_limits': {'max_issue_per_deal': 10}, 'mandate': {'max_issue_per_deal': 25, 'min_price_as_payee': 0}}
PEOPLE = [{'id': BOB_ID, 'handle': 'bob'}]


class FakeClient:
    participant_id = ME_ID

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


def unbound(test, agent, name, args):
    """prepare() refuses with approval_unbound; returns the cause it recorded."""
    with test.assertRaises(vc.ValunError, msg=(name, args)) as e:
        agent.prepare(name, args)
    test.assertEqual((e.exception.code, str(e.exception)), ('approval_unbound', UNBOUND), (name, args))
    return e.exception.extra.get('cause')


ACCEPT = ('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})
COUNTER = ('valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'price': 30})
REVIEW = ('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})


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
        # Until 0.3.1 the fixture here was {'current': {'terms_hash': 'h'*64}, 'delivery': {'sha256': 'd'*64}}: hashes
        # with no terms or text behind them. Since 0.4 (design §6.5, §10.2 item 9) bind pins only hashes it recomputed
        # from what the deal shows, so the deal here is a consistent one and an inconsistent one is refused.
        a = Agent(DEAL)
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})['expected_terms_hash'], T)
        bound = a.bind('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})
        self.assertEqual((bound['expected_deliverable_sha256'], bound['expected_terms_hash']), (SHA, T))
        # an explicit hash from the agent is kept (the client then refuses it if the terms changed)
        self.assertEqual(a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': 'x'})['expected_terms_hash'], 'x')
        self.assertNotIn('expected_terms_hash', a.bind('valun_respond', {'deal_id': 'vd_1', 'action': 'decline'}))
        with self.assertRaises(vc.ValunError) as e:
            Agent({'current': {'terms_hash': 'h' * 64}, 'delivery': {'sha256': 'd' * 64}}).bind('valun_respond', {'deal_id': 'vd_1', 'action': 'accept'})
        self.assertEqual(e.exception.code, 'approval_unbound')

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
        for name, args in (ACCEPT, COUNTER, REVIEW,
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
        no_hash = edited(DEAL, current={'terms_hash': None})
        no_sha = edited(DEAL, delivery={'sha256': ''})
        cases = [(Agent(no_hash), *ACCEPT),
                 (Agent(no_sha), *REVIEW),
                 (Agent(DEAL), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'Accept'}),     # misspelt
                 (Agent(DEAL), 'valun_review_delivery', {'deal_id': 'vd_1', 'decision': True}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'agree'}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': '../vd_1', 'action': 'accept'}),
                 (Agent(DEAL), 'valun_respond', {'action': 'accept'}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'price': 'lots'}),
                 (Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'deliver_within_hours': 1.5}),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'nobody', 'role': 'payer', 'price': 3}),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'bob', 'role': 'buyer', 'price': 3}),
                 (Agent(people=[{'handle': 'bob'}]), 'valun_propose', {'counterparty': 'bob', 'role': 'payer', 'price': 3}),
                 (Agent(me={'agent_limits': {'max_issue_per_deal': 10}}), 'valun_set_limits', {'max_per_deal_as_payer': 20}),
                 (Agent(me=ME), 'valun_set_limits', ['max_per_deal_as_payer', 20]),
                 (Agent(me=ME), 'valun_set_limits', {'max_per_deal_as_payer': 'lots'})]
        for agent, name, args in cases:
            unbound(self, agent, name, args)

    def test_known_commitments_get_their_own_text_and_unknown_tools_the_generic_one(self):
        cases = [(Agent(DEAL), *ACCEPT, "ACCEPT bob's offer"),
                 (Agent(DEAL), *COUNTER, 'COUNTER-OFFER to bob'),
                 (Agent(DEAL), *REVIEW, 'ISSUE A CREDIT NOTE of 20 PC'),
                 (Agent(people=PEOPLE), 'valun_propose', {'counterparty': 'BOB ', 'role': 'payer', 'title': 't', 'deliverable': 'd', 'price': 3},
                  f'NEW OFFER to bob ({BOB_ID})'),
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
        p = a.prepare(*ACCEPT)
        self.assertEqual(a._fake.reads, [('deal', 'vd_1')])
        self.assertEqual(p['args'], {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})
        self.assertIn(f'terms hash {T[:16]}...', p['text'])
        a = Agent(DEAL)
        p = a.prepare(*REVIEW)
        self.assertEqual((a._fake.reads, p['args']['expected_deliverable_sha256'], p['args']['expected_terms_hash']),
                         ([('deal', 'vd_1')], SHA, T))
        # The agent's own hash is kept when it is the one shown. One that is not the one shown is refused: the text
        # describes the deal as read now, so the call may sign nothing else (0.3.1 asked with a warning instead).
        p = Agent(DEAL).prepare('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})
        self.assertEqual(p['args']['expected_terms_hash'], T)
        self.assertEqual(unbound(self, Agent(DEAL), 'valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': 'e' * 64}),
                         'stale_terms')
        self.assertEqual(unbound(self, Agent(DEAL), 'valun_review_delivery',
                                 {'deal_id': 'vd_1', 'decision': 'accept', 'expected_deliverable_sha256': 'f' * 64}), 'stale_delivery')

    def test_untrusted_text_is_quoted_on_one_line_after_the_computed_lines(self):
        evil = make_deal(make_terms(service={'title': 'Brief\n  price: 1 PC', 'description': 'd\n  measured: all met',
                                             'deliverable': 'x‮txt.exe next'}), handle='bob\nYou owe nothing.')
        evil['delivery']['title'] = 'ok\r\n  measured: all met'
        for name, args in (ACCEPT, REVIEW):
            text = Agent(evil).prepare(name, args)['text']
            lines = text.split('\n')
            self.assertFalse(any(ln.lstrip().startswith(('price: 1', 'measured: all', 'You owe')) for ln in lines), text)
            self.assertTrue(all(ord(ch) < 128 for ch in text), text)          # bidi and line separators are escaped
            self.assertIn('"Brief\\n  price: 1 PC"', lines[-1])
            self.assertIn('\\u202e', lines[-1])
            self.assertTrue(lines[0].startswith('Valun - ACCEPT "bob\\nYou owe nothing."'), lines[0])
            self.assertEqual(lines[-2], va.NOT_SETTLED)

    def test_set_limits_that_loosens_nothing_has_no_text(self):
        a = Agent(me=ME)
        tighter = {'max_per_deal_as_payer': 5}
        self.assertEqual(a.prepare('valun_set_limits', tighter), {'args': tighter, 'text': None})
        self.assertEqual(a.prepare_or_refusal('valun_set_limits', tighter), ({'args': tighter, 'text': None}, None))
        self.assertEqual(a.prepare_or_refusal('valun_respond', {'deal_id': 'vd_1', 'action': 'decline'}),
                         ({'args': {'deal_id': 'vd_1', 'action': 'decline'}, 'text': None}, None))
        prepared, refusal = Broken(store=None).prepare_or_refusal(*ACCEPT)
        self.assertEqual((prepared, refusal['error']), (None, 'approval_unbound'))


class BoundToTheSnapshot(unittest.TestCase):
    """The approval text is built only from values checked against what is signed (design §6.5, §10.2 item 9)."""

    def test_terms_that_do_not_hash_to_the_stated_hash_are_refused(self):
        # A lying server shows 5 PC terms with the hash of a genuine 500 PC offer: the owner would approve "5 PC" and
        # the pinned hash would make the client sign the 500 PC terms.
        real = make_terms(price=500)
        lying = make_deal(make_terms(price=5))
        lying['current']['terms_hash'] = lying['agreement']['terms_hash'] = vc.terms_hash(real)
        for name, args in (ACCEPT, COUNTER, REVIEW):
            self.assertEqual(unbound(self, Agent(lying), name, args), 'hash_mismatch', name)
            with self.assertRaises(vc.ValunError):
                Agent(lying).bind(name, args)
        # terms that cannot be hashed at all, or are missing
        self.assertEqual(unbound(self, Agent(edited(DEAL, current={'terms': {**DEAL['current']['terms'], 'price': {'amount': 2.5}}})), *ACCEPT),
                         'bad_terms')
        self.assertEqual(unbound(self, Agent(edited(DEAL, current={'terms': None})), *ACCEPT), 'approval_unbound')

    def test_a_delivery_that_does_not_match_its_hashes_is_refused(self):
        other_text = edited(DEAL, delivery={'content': 'word ' * 450})          # the text shown is not the one hashed
        self.assertEqual(unbound(self, Agent(other_text), *REVIEW), 'hash_mismatch')
        other_agreement = edited(DEAL, agreement={'terms_hash': vc.terms_hash(make_terms(price=500))})
        self.assertEqual(unbound(self, Agent(other_agreement), *REVIEW), 'hash_mismatch')
        for bad in ({'content': None}, {'content': 7}):
            self.assertEqual(unbound(self, Agent(edited(DEAL, delivery=bad)), *REVIEW), 'approval_unbound')
        self.assertEqual(unbound(self, Agent(edited(DEAL, delivery=None)), *REVIEW), 'not_delivered')

    def test_the_role_comes_from_the_signed_terms(self):
        # The server says payee; the signed terms make the owner the payer: refused, not described as a sale.
        self.assertEqual(unbound(self, Agent(edited(DEAL, your_role='payee')), *ACCEPT), 'role_mismatch')
        # Without the server's word, the role (and what is owed) is the terms' own.
        text = Agent(edited(make_deal(make_terms(price=500)), your_role=None)).prepare(*ACCEPT)['text']
        self.assertIn('you are the payer; price: 500 PC', text)
        self.assertIn('you will owe bob 500 PC', text)
        selling = make_deal(make_terms(price=7, payer=BOB_ID, payee=ME_ID))
        text = Agent(selling).prepare(*ACCEPT)['text']
        self.assertIn('you are the payee (you do the work); price: 7 PC', text)
        self.assertIn('bob would then owe you 7 PC', text)
        self.assertEqual(unbound(self, Agent(selling), *REVIEW), 'not_payer')            # only the payer accepts a delivery
        for t in (make_terms(payer='vp_c0c0c0c0c0c0'), make_terms(payer=ME_ID, payee=ME_ID)):   # not a party, or both
            self.assertEqual(unbound(self, Agent(make_deal(t)), *ACCEPT), 'not_a_party')

    def test_what_the_server_says_about_the_deal_must_agree_with_the_terms(self):
        self.assertEqual(unbound(self, Agent(edited(DEAL, counterparty={'id': 'vp_c0c0c0c0c0c0'})), *ACCEPT), 'counterparty_mismatch')
        self.assertEqual(unbound(self, Agent(make_deal(make_terms(deal_id='vd_2'))), *ACCEPT), 'deal_mismatch')
        self.assertEqual(unbound(self, Agent(make_deal(make_terms(proposer=ME_ID))), *ACCEPT), 'own_offer')   # only theirs is answered
        self.assertEqual(unbound(self, Agent(make_deal(make_terms(proposer=ME_ID))), *COUNTER), 'own_offer')
        self.assertIn('ISSUE A CREDIT NOTE', Agent(make_deal(make_terms(proposer=ME_ID))).prepare(*REVIEW)['text'])   # either side proposed
        euros = make_terms()
        euros['price'] = {'amount': 20, 'unit': 'EUR'}
        self.assertEqual(unbound(self, Agent(make_deal(euros)), *ACCEPT), 'bad_terms')

    def test_the_text_shows_computed_values_not_the_servers_claims(self):
        d = edited(DEAL, delivery={'bytes': 12})                                 # the server's byte count is ignored
        text = Agent(d).prepare(*REVIEW)['text']
        self.assertIn(f"delivered: {len(DEAL['delivery']['content'].encode())} bytes, sha256 {SHA[:16]}...", text)
        self.assertIn('300-500 words: 320 words (met)', text)
        self.assertIn(f'agreed terms hash {T[:16]}...', text)
        self.assertNotIn('12 bytes', text)
        lines = Agent(DEAL).prepare(*ACCEPT)['text'].split('\n')
        self.assertEqual(lines[0], f"Valun - ACCEPT bob's offer ({BOB_ID}, deal vd_1, version 2):")
        self.assertEqual(lines[1], '  you are the payer; price: 20 PC; deliver by 2099-01-02T00:00:00.000Z')

    def test_counter_and_review_pin_the_terms_hash(self):
        p = Agent(DEAL).prepare(*COUNTER)
        self.assertEqual(p['args'], {'deal_id': 'vd_1', 'action': 'counter', 'price': 30, 'expected_terms_hash': T})
        self.assertIn('price: 30 PC', p['text'])
        self.assertIn('your agent changes: price 20 -> 30 PC; the counter-offer stays open 24 h', p['text'])
        self.assertIn('as in their offer', p['text'])
        p = Agent(DEAL).prepare('valun_respond', {'deal_id': 'vd_1', 'action': 'counter', 'deliver_within_hours': 12, 'title': 'New'})
        self.assertIn('price: 20 PC', p['text'])
        self.assertIn('deliver within 12 h of signing', p['text'])
        self.assertIn('"title":"New"', p['text'].split('\n')[-1])
        self.assertIn('"description":"Three sources."', p['text'].split('\n')[-1])     # unchanged text, copied from their offer
        p = Agent(DEAL).prepare(*REVIEW)
        self.assertEqual(p['args'], {'deal_id': 'vd_1', 'decision': 'accept', 'expected_deliverable_sha256': SHA, 'expected_terms_hash': T})

    def test_propose_signs_for_the_participant_shown(self):
        a = Agent(people=PEOPLE)
        p = a.prepare('valun_propose', {'counterparty': 'BOB ', 'role': 'payee', 'title': 't', 'description': 'd', 'deliverable': 'x', 'price': 4})
        self.assertEqual(p['args']['counterparty'], BOB_ID)                     # not the name: it could resolve differently later
        self.assertIn(f'NEW OFFER to bob ({BOB_ID})', p['text'])
        self.assertIn('you are the payee (you do the work); price: 4 PC', p['text'])

    def test_offer_texts_quote_the_description_and_cut_long_fields(self):
        p = Agent(people=PEOPLE).prepare('valun_propose', {'counterparty': 'bob', 'role': 'payer', 'title': 't', 'deliverable': 'x',
                                                           'description': 'Count the words of: TEXT: hello', 'price': 3})
        self.assertEqual(p['text'].split('\n')[-1], 'Offer text written by your agent (quoted exactly): '
                         '{"title":"t","description":"Count the words of: TEXT: hello","deliverable":"x"}')
        long = make_deal(make_terms(service={'title': 'T', 'description': 'a' * 2500, 'deliverable': 'x'}))
        last = Agent(long).prepare(*ACCEPT)['text'].split('\n')[-1]
        self.assertTrue(last.startswith('Offer text written by bob (quoted exactly; fields over 2000 characters are cut to their first 2000): '), last)
        self.assertIn('"description":"' + 'a' * 2000 + '"', last)
        self.assertNotIn('a' * 2001, last)


class Desk:
    """A fake Valun server for offers (accept and counter), with real keys: Bob proposes, Alice (this client) answers.
    views: the deal as successive GETs show it (the last one repeats)."""

    def __init__(self, views):
        self.views, self.posts, self.reads = list(views), [], 0

    def request(self, method, path, body=None):
        if path == '/pilot/v1/info':
            return {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM}
        if path == f'/pilot/v1/participants/{BOB_ID}':
            return {'id': BOB_ID, 'handle': 'bob', 'status': 'active', 'pubkey': BOB['pubkey']}
        if method == 'GET' and path == '/pilot/v1/deals/vd_1':
            self.reads += 1
            return json.loads(json.dumps(self.views[min(self.reads, len(self.views)) - 1]))
        if method == 'POST':
            self.posts.append((path, body))
            return {'id': 'vd_1', 'status': 'agreed' if path.endswith('/accept') else 'open'}
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)


def offer(price, title='Brief'):
    """Bob's genuinely signed open offer to Alice, as the server shows it."""
    t = make_terms(price=price, service={'title': title, 'description': 'Three sources.', 'deliverable': 'markdown'}, version=1)
    h = vc.terms_hash(t)
    return {'id': 'vd_1', 'status': 'open', 'your_role': 'payer', 'counterparty': {'id': BOB_ID, 'handle': 'bob'},
            'current': {'version': 1, 'by': BOB_ID, 'state': 'open', 'terms': t, 'terms_hash': h,
                        'signature': sign_text(BOB, vc.statement('propose', h))}}


class DeskAgent(ValunAgent):
    def __init__(self, desk):
        super().__init__(MemStore())
        self.desk = desk

    def client(self, require_connection=True):
        desk = self.desk

        class C(vc.Client):
            def request(self, method, path, body=None, auth=True, token=None):
                return desk.request(method, path, json.loads(json.dumps(body)) if body is not None else None)
        return C(self.store, server='http://valun.invalid')


class EndToEnd(unittest.TestCase):
    """With real signatures: what the owner approves is what the client signs, or nothing is signed."""

    def test_an_approved_acceptance_signs_the_terms_shown(self):
        desk = Desk([offer(500)])
        a = DeskAgent(desk)
        p = a.prepare(*ACCEPT)
        self.assertIn('price: 500 PC', p['text'])
        a.call('valun_respond', p['args'])
        (path, body), = desk.posts
        h = vc.terms_hash(offer(500)['current']['terms'])
        self.assertEqual((path, body['terms_hash']), ('/pilot/v1/deals/vd_1/accept', h))
        self.assertTrue(vb.verify(bytes.fromhex(body['signature']), vc.statement('accept', h).encode(), bytes.fromhex(ALICE['pubkey'])))

    def test_a_lying_snapshot_is_refused_and_nothing_is_signed(self):
        lying = offer(5, 'Cheap job')
        lying['current']['terms_hash'] = offer(500)['current']['terms_hash']     # the hash (and signature) of the 500 PC offer
        lying['current']['signature'] = offer(500)['current']['signature']
        for name, args in (ACCEPT, COUNTER):
            desk = Desk([lying, offer(500)])
            self.assertEqual(unbound(self, DeskAgent(desk), name, args), 'hash_mismatch')
            self.assertEqual(desk.posts, [])

    def test_terms_that_change_after_the_snapshot_are_not_signed(self):
        # The snapshot is consistent (5 PC); when the client signs, the server shows a genuine 500 PC offer instead.
        for name, args in (ACCEPT, COUNTER):
            desk = Desk([offer(5), offer(500)])
            a = DeskAgent(desk)
            p = a.prepare(name, args)
            self.assertIn('price: 5 PC' if args['action'] == 'accept' else 'price 5 -> 30 PC', p['text'])
            with self.assertRaises(vc.ValunError) as e:
                a.call(name, p['args'])
            self.assertEqual(e.exception.code, 'stale_terms', name)
            self.assertEqual(desk.posts, [])

    def test_a_delivery_acceptance_signs_only_the_agreement_shown(self):
        # The snapshot shows a delivery on a 5 PC agreement; when the client signs, the same text is shown on another
        # genuinely agreed 500 PC deal under this id: nothing is signed, not even the template is asked for.
        w, s = World(), MemStore()
        w.add_deal('vd_1', price=5)

        class WorldAgent(ValunAgent):
            def client(self, require_connection=True):
                return WorldClient(w, s)
        a = WorldAgent(s)
        p = a.prepare(*REVIEW)
        self.assertIn('ISSUE A CREDIT NOTE of 5 PC', p['text'])
        w.add_deal('vd_1', price=500)
        w.log.clear()
        with self.assertRaises(vc.ValunError) as e:
            a.call('valun_review_delivery', p['args'])
        self.assertEqual(e.exception.code, 'stale_terms')
        self.assertEqual(w.log, ['GET /pilot/v1/deals/vd_1'])
        self.assertEqual(w.tracker, {})
        # The consistent case pays exactly the price shown.
        w2, s2 = World(), MemStore()
        w2.add_deal('vd_1', price=5)

        class WorldAgent2(ValunAgent):
            def client(self, require_connection=True):
                return WorldClient(w2, s2)
        a2 = WorldAgent2(s2)
        self.assertEqual(a2.call('valun_review_delivery', a2.prepare(*REVIEW)['args'])['status'], 'note_issued')
        self.assertEqual(w2.tracker[w2.pair]['total'], 5)


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

    def test_mcp_refuses_a_lying_snapshot_without_asking(self):
        lying = edited(DEAL, current={'terms': make_terms(price=5)})
        s, out = self.mcp(Agent(lying))
        r = s.call(*ACCEPT)
        self.assertEqual((r['isError'], r['structuredContent']['error']), (True, 'approval_unbound'))
        self.assertEqual(out.getvalue(), b'')

    def test_mcp_asks_with_the_prepared_text_and_signs_the_bound_arguments(self):
        called = []

        class Ok(Agent):
            def call(self, name, args=None):
                called.append((name, args))
                return {'ok': True}
        answer = json.dumps({'jsonrpc': '2.0', 'id': 'valun-approval-1', 'result': {'action': 'accept', 'content': {'approve': True}}})
        s, out = self.mcp(Ok(DEAL), (answer + '\n').encode())
        r = s.call(*ACCEPT)
        self.assertFalse(r['isError'])
        ask = json.loads(out.getvalue().decode().splitlines()[0])
        self.assertIn(f"Valun - ACCEPT bob's offer ({BOB_ID}, deal vd_1, version 2)", ask['params']['message'])
        self.assertEqual(called, [('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})])
        # 2026-07-28: the first round asks with the prepared text, bound into the HMAC request state
        s, _out = self.mcp(Ok(DEAL))
        meta = {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}}
        r = s.call_modern({'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1', 'action': 'accept'}}, meta)
        self.assertEqual(r['resultType'], 'input_required')
        self.assertIn("ACCEPT bob's offer", r['inputRequests']['approval']['params']['message'])

    def test_mcp_runs_without_asking_when_the_read_shows_nothing_to_approve(self):
        # is_commitment could not read /me (so it says ask); prepare()'s own read shows the limit only tightens.
        called = []

        class Flaky(Agent):
            def is_commitment(self, name, args):
                return True

            def call(self, name, args=None):
                called.append((name, args))
                return {'ok': True}
        for modern in (False, True):
            s, out = self.mcp(Flaky(me=ME))
            args = {'max_per_deal_as_payer': 5}
            if modern:
                r = s.call_modern({'name': 'valun_set_limits', 'arguments': args}, {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}})
            else:
                r = s.call('valun_set_limits', args)
            self.assertEqual((r['isError'], r['structuredContent']), (False, {'ok': True}))
            self.assertEqual(out.getvalue(), b'')
        self.assertEqual(called, [('valun_set_limits', {'max_per_deal_as_payer': 5})] * 2)

    def test_a_2026_07_28_approval_is_used_once_and_only_while_fresh(self):
        # Audit AI-2: a host that resends a completed, approved tools/call (a retry, a replay) is asked again; it does
        # not sign another commitment. The state also expires after APPROVAL_STATE_TTL_S.
        called = []

        class Ok(Agent):
            def call(self, name, args=None):
                called.append((name, args))
                return {'ok': True}
        s, _out = self.mcp(Ok(DEAL))
        meta = {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}}
        p = {'name': 'valun_respond', 'arguments': {'deal_id': 'vd_1', 'action': 'accept'}}
        first = s.call_modern(dict(p), meta)
        self.assertEqual(first['resultType'], 'input_required')
        yes = {'approval': {'action': 'accept', 'content': {'approve': True}}}
        done = s.call_modern(dict(p, requestState=first['requestState'], inputResponses=yes), meta)
        self.assertEqual((done['resultType'], done['isError']), ('complete', False))
        self.assertEqual(called, [('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T})])
        again = s.call_modern(dict(p, requestState=first['requestState'], inputResponses=yes), meta)   # the same resent
        self.assertEqual(again['resultType'], 'input_required')
        self.assertNotEqual(again['requestState'], first['requestState'])
        self.assertEqual(len(called), 1)
        # a state older than the limit is asked again too; one that is not this process's is never accepted
        old = s._state('valun_respond', {'deal_id': 'vd_1', 'action': 'accept', 'expected_terms_hash': T},
                       now=time.time() - mcp_server.APPROVAL_STATE_TTL_S - 5)
        late = s.call_modern(dict(p, requestState=old, inputResponses=yes), meta)
        self.assertEqual(late['resultType'], 'input_required')
        forged = 'ab' * 16 + f'.{int(time.time())}.' + '00' * 32
        self.assertEqual(s.call_modern(dict(p, requestState=forged, inputResponses=yes), meta)['resultType'], 'input_required')
        self.assertEqual(len(called), 1)
        # a fresh state, answered once, signs once more
        fresh = s.call_modern(dict(p), meta)['requestState']
        self.assertFalse(s.call_modern(dict(p, requestState=fresh, inputResponses=yes), meta)['isError'])
        self.assertEqual(len(called), 2)

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
        # GET /owner names the token's participant, as every server version does (PROTOCOL.md: GET /owner); the CLI
        # switches only with the owner token of this profile's participant (FX2-PY).
        routes = {'GET /pilot/v1/owner': {'participant': {'id': 'vp_a1a1a1a1a1a1'},
                                          'mandate': {'max_issue_per_deal': 25, 'max_accept_per_deal': 20, 'review_deliveries': True}},
                  'PUT /pilot/v1/owner/mandate': {}}
        printed = io.StringIO()
        with self.fake_request(routes), contextlib.redirect_stdout(printed):
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'approvals', 'console', '--owner-token-file', tok]), 0)
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'approvals', 'ask', '--owner-token-file', tok]), 0)
            self.assertEqual(cli.main(['--profile', 'c', 'config', 'server', 'http://other.invalid/']), 0)
        puts = [(body, token) for m, p, body, token in self.calls if m == 'PUT']
        # Leaving console restores approve_above only: review_deliveries may be the owner's own choice, so it stays, and
        # the owner is told how to turn it off.
        self.assertEqual(puts, [({'approve_above': 0, 'review_deliveries': True}, 'vpo_test-only'),
                                ({'approve_above': 25}, 'vpo_test-only')])
        self.assertIn('Accepted deliveries still wait for your review (review_deliveries is on); turn that off in the owner console '
                      '(http://valun.invalid/pilot#owner)', printed.getvalue())
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
