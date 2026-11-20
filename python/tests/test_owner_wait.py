"""Answers that wait for the owner say where to approve and which commitment (the newcomer tests on staging,
2026-11-17): valun_propose (proposed_awaiting_owner), valun_respond (accepted_awaiting_owner, a counter-offer held for
the owner), valun_review_delivery (completion_awaiting_owner, with a credit note or paying with a held note) and the
sandbox tour's wait for the owner said "your owner must approve", but not where, nor which approval. Now each names the
owner console of this server (<server>/pilot#owner) in its words and as owner_console, and the deal and the pending
approval the server's answer names (approval_id; approval_ids for several). The JavaScript agent gives the same answers
(js/test/fixtures/agent-python.json records them)."""
import os
import sys
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402

DEAL = 'vd_0123456789abcdef'
PENDING = {'id': 'va_0a0a0a0a0a0a', 'deal_id': DEAL, 'kind': 'accept', 'state': 'pending'}


class Stub:
    """A client whose answers the test sets: the deal views a held commitment returns."""
    unit, network, scale, pubkey, participant_id = 'nanoERG', 'valun-testnet-1', 1_000_000, '02' + '11' * 32, 'vp_a1a1a1a1a1a1'

    def __init__(self, answer, server='https://valun.example/'):
        self.state = {'server': server} if server else {}
        self.answer = answer

    def complete(self, *a, **k):
        return self.answer

    def accept(self, *a, **k):
        return self.answer

    def counter(self, *a, **k):
        return self.answer

    def propose(self, *a, **k):
        return self.answer


class Store:
    state = {}

    def secret(self):
        return None

    def token(self):
        return None

    def save(self):
        pass


def agent_with(stub):
    ag = va.ValunAgent(Store(), approvals='', check_link_hosts=False)
    ag.client = lambda: stub
    ag._resolve = lambda c, cp: {'id': 'vp_b0b0b0b0b0b0', 'handle': 'bob', 'services': '', 'agent_last_seen': None,
                                 'joined_at': None}
    return ag


class OwnerWait(unittest.TestCase):
    def test_where_and_which(self):
        words, fields = va.owner_wait(Stub(None), {'approvals': [PENDING, dict(PENDING, id='va_0b0b0b0b0b0b', state='approved'),
                                                                 dict(PENDING, id='not an id')]}, DEAL)
        self.assertEqual(words, f' in the owner console, https://valun.example/pilot#owner (deal {DEAL}, approval va_0a0a0a0a0a0a)')
        self.assertEqual(fields, {'owner_console': 'https://valun.example/pilot#owner', 'approval_id': 'va_0a0a0a0a0a0a'})
        words, fields = va.owner_wait(Stub(None), {'approvals': [dict(PENDING, id='va_0d0d0d0d0d0d'), PENDING]}, DEAL)
        self.assertEqual(fields['approval_ids'], ['va_0a0a0a0a0a0a', 'va_0d0d0d0d0d0d'])
        self.assertNotIn('approval_id', fields)
        words, fields = va.owner_wait(Stub(None, server=None), {}, DEAL)
        self.assertEqual((words, fields), (f' in the owner console (deal {DEAL})', {}))
        words, _ = va.owner_wait(Stub(None), {'approvals': 'garbage'}, 'vd_\x1b[31m')
        self.assertNotIn('\x1b', words, "a server's text is shown quoted, never as it is")

    def test_each_answer_that_waits_names_the_console_and_the_approval(self):
        url = 'https://valun.example/pilot#owner'
        T = 1_794_957_033_997                                   # a bound note's timestamp (it ends in 997)
        held = {'id': DEAL, 'status': 'completion_awaiting_owner', 'counterparty': {'handle': 'bob'},
                'credit_note': {'state': 'signed', 'amount': 3_000_000, 'note': {'total': 9_000_000, 'timestamp': T,
                                                                                 'prior_signature': '03' + '11' * 64}},
                'approvals': [PENDING]}
        r = agent_with(Stub(held)).review({'deal_id': DEAL, 'decision': 'accept'})
        # the RC's staging test (2026-11-18): the owner's deadline is the console's Decide by, a minute before the
        # tracker's hour (the server's decide_by: timestamp + 1 h - 60 s), and the tracker's limit is named apart
        self.assertEqual((r['owner_console'], r['approval_id'], r['decide_by'], r['note_expires_at']),
                         (url, 'va_0a0a0a0a0a0a', '2026-11-18T00:09:33.997Z', '2026-11-18T00:10:33.997Z'))
        self.assertEqual(va.HELD_NOTE_SEND_MARGIN_MS, 60_000)
        # the approval semantics of 2026-11-17: what is held, what the payee sees, until when, and what each answer leaves
        self.assertEqual(r['what_happened'], (
            'You accepted the delivery and signed your note to bob for 3000000 nanoERG (0.003 tERG). The Valun server holds '
            "it for your owner: it is not on the tracker yet, and bob sees that you accepted the delivery but not the note's "
            f'signature. Tell your owner to approve or reject it in the owner console, {url} (deal {DEAL}, approval '
            "va_0a0a0a0a0a0a) by 2026-11-18T00:09:33.997Z, the owner console's deadline, a minute before the tracker's "
            'limit (2026-11-18T00:10:33.997Z): a note still held at 2026-11-18T00:10:33.997Z is never recorded and pays '
            'nothing, and valun_deal then says what to do. If approved, you owe bob 3000000 nanoERG (0.003 tERG) more: a '
            'promise to pay that the Valun testnet tracker (anchored on Ergo testnet) records, not a settlement. If '
            'rejected, it is never sent (the server keeps it, still signed) and the deal comes back to you: valun_deal says '
            'what you may do (accept the delivery again with a new note, which waits for your owner again, or dispute it).'))
        # an ordinary note has no hour
        plain = dict(held, credit_note=dict(held['credit_note'], note={'total': 9_000_000, 'timestamp': T - 997 + 500}))
        r = agent_with(Stub(plain)).review({'deal_id': DEAL, 'decision': 'accept'})
        self.assertNotIn('note_expires_at', r)
        self.assertNotIn('decide_by', r)
        self.assertNotIn("the tracker's limit", r['what_happened'])
        r = agent_with(Stub({'id': DEAL, 'status': 'accepted_awaiting_owner', 'next_actions': [], 'approvals': [PENDING]})).respond(
            {'deal_id': DEAL, 'action': 'accept'})
        self.assertEqual(r['owner_console'], url)
        self.assertIn(f'It binds only once your owner approves it in the owner console, {url} (deal {DEAL}, approval '
                      'va_0a0a0a0a0a0a).', r['what_happened'])
        r = agent_with(Stub({'id': DEAL, 'status': 'open', 'pending_counter': {'version': 2}, 'next_actions': [],
                             'counterparty': {'handle': 'bob'},
                             'current': {'terms': {'offer_expires_at': '2026-11-19T10:00:00.000Z'}}})).respond(
            {'deal_id': DEAL, 'action': 'counter', 'price': 2_000_000})
        self.assertEqual(r['what_happened'], (
            'Your signed counter-offer at 2000000 nanoERG (0.002 tERG) waits for your owner. bob cannot see it yet, and its '
            'own offer stays open until 2026-11-19T10:00:00.000Z. While it waits, you can neither accept that offer nor '
            f'counter again. Your owner approves or rejects it in the owner console, {url} (deal {DEAL}). Tell your owner.'))
        r = agent_with(Stub({'id': DEAL, 'status': 'proposed_awaiting_owner',
                             'current': {'terms_hash': 'ab' * 32, 'terms': {'offer_expires_at': '2026-11-19T10:00:00.000Z'}},
                             'approvals': [dict(PENDING, kind='propose')]})).propose(
            {'counterparty': 'bob', 'role': 'payer', 'title': 't', 'description': 'd', 'deliverable': 'x', 'price': 2_000_000})
        self.assertEqual((r['owner_console'], r['approval_id']), (url, 'va_0a0a0a0a0a0a'))
        self.assertEqual(r['what_happened'], (
            'Your signed offer waits for your owner before bob can see it. Your owner approves or rejects it in the owner '
            f'console, {url} (deal {DEAL}, approval va_0a0a0a0a0a0a) before 2026-11-19T10:00:00.000Z. Tell your owner now: '
            'nothing else tells them. While it waits it counts against your limits, and you can still withdraw it; if your '
            'owner rejects it, it binds nobody and the deal ends. valun_deal shows when it is decided.'))
        # an answer that does not wait names no console
        r = agent_with(Stub({'id': DEAL, 'status': 'agreed', 'next_actions': []})).respond({'deal_id': DEAL, 'action': 'accept'})
        self.assertNotIn('owner_console', r)

    def test_the_command_that_opens_the_console_is_named_where_the_agent_knows_it(self):
        # `valun console` (ValunAgent console_command, which the CLI and the MCP server set for the profile)
        url = 'https://valun.example/pilot#owner'
        words, fields = va.owner_wait(Stub(None), {'approvals': [PENDING]}, DEAL, 'valun --profile p console')
        self.assertEqual(words, f' in the owner console, {url} (deal {DEAL}, approval va_0a0a0a0a0a0a; in a terminal, '
                                '`valun --profile p console` opens it)')
        self.assertEqual(fields['console_command'], 'valun --profile p console')
        ag = agent_with(Stub({'id': DEAL, 'status': 'accepted_awaiting_owner', 'next_actions': [], 'approvals': [PENDING]}))
        ag.console_command = 'valun --profile p console'
        r = ag.respond({'deal_id': DEAL, 'action': 'accept'})
        self.assertEqual(r['console_command'], 'valun --profile p console')
        self.assertIn('`valun --profile p console` opens it', r['what_happened'])
        self.assertIsNone(va.ValunAgent(Store(), console_command='').console_command)

    def test_a_held_payment_by_transfer_says_until_when(self):
        url = 'https://valun.example/pilot#owner'
        view = {'id': DEAL, 'status': 'completion_awaiting_owner', 'counterparty': {'handle': 'bob'},
                'current': {'terms': {'price': {'amount': 2_000_000}}},
                'payment': {'state': 'awaiting_owner', 'issuer': {'handle': 'frank'}, 'amount': 2_000_000,
                            'expires_at': '2026-11-17T23:31:20.000Z'},
                'approvals': [dict(PENDING, kind='pay_by_transfer')]}
        stub = Stub(view)
        stub.pay_by_transfer = lambda *a, **k: view
        ag = agent_with(stub)
        ag._remember = lambda c: None
        r = ag._review_pay_with(stub, {'deal_id': DEAL}, 'frank')
        self.assertEqual((r['owner_console'], r['approval_id'], r['hold_expires_at']),
                         (url, 'va_0a0a0a0a0a0a', '2026-11-17T23:31:20.000Z'))
        self.assertIn(f'It waits for your owner in the owner console, {url} (deal {DEAL}, approval va_0a0a0a0a0a0a) until '
                      '2026-11-17T23:31:20.000Z, 20 minutes after you signed it: tell your owner now.', r['what_happened'])
        self.assertIn('Nobody else has signed it.', r['what_happened'])
        self.assertIn('the delivery stays accepted even if the transfer then fails', r['what_happened'])

    def test_an_acceptance_held_only_by_the_proposers_owner_names_no_console_of_yours(self):
        """The 0.7.2 review (p6): the server holds an acceptance for the proposer's owner alone (held_for
        ['proposer_owner']: their limits require it), and a deal view lists only the viewer's own approvals, so the
        acceptor's owner has nothing to approve. 'Yours approves it in the owner console' sent them to look for it.
        Re-checked against the server's heldFor (lib/pilot/core.mjs): 'acceptor_owner' while the acceptor's approval is
        pending, 'proposer_owner' while the proposer's owner must confirm its offer."""
        url = 'https://valun.example/pilot#owner'

        def accept(held_for, approvals=()):
            answer = {'id': DEAL, 'status': 'accepted_awaiting_owner', 'next_actions': [], 'approvals': list(approvals),
                      'counterparty': {'handle': 'bob'}, 'current': {'terms': {'offer_expires_at': '2026-11-19T10:00:00.000Z'}},
                      'acceptance': {'version': 1, 'state': 'awaiting_owner', 'held_for': held_for}}
            return agent_with(Stub(answer)).respond({'deal_id': DEAL, 'action': 'accept'})
        r = accept(['proposer_owner'])
        self.assertEqual(r['what_happened'], "You signed your acceptance. It binds once bob's owner confirms its offer (their "
                                             "limits require it). Nothing waits for your owner. If bob's owner does not "
                                             'confirm, the offer is withdrawn and your acceptance is void; nothing is owed. '
                                             'valun_deal shows when it is decided.')
        self.assertNotIn('owner_console', r)
        self.assertNotIn('approval_id', r)
        seen = (' bob already sees that you accepted and that it waits (not your signature), and may still withdraw its '
                'offer.')
        r = accept(['acceptor_owner'])
        self.assertEqual(r['what_happened'], "You signed your acceptance of bob's offer. It binds only once your owner approves "
                                             f'it in the owner console, {url} (deal {DEAL}) before 2026-11-19T10:00:00.000Z.'
                                             f'{seen} Tell your owner: nothing else tells them. If your owner rejects it, the '
                                             'offer is open again.')
        self.assertEqual(r['owner_console'], url)
        r = accept(['acceptor_owner', 'proposer_owner'], [PENDING])
        self.assertEqual(r['what_happened'], "You signed your acceptance of bob's offer. It binds only once your owner approves "
                                             f'it in the owner console, {url} (deal {DEAL}, approval va_0a0a0a0a0a0a) and '
                                             "bob's owner confirms its offer (their limits require it) before "
                                             f'2026-11-19T10:00:00.000Z.{seen} Tell your owner. If your owner rejects it, the '
                                             'offer is open again. valun_deal shows when both are decided.')
        self.assertEqual((r['owner_console'], r['approval_id']), (url, 'va_0a0a0a0a0a0a'))
        # a pending approval of this participant is the acceptor's owner's, whatever held_for says
        r = accept(['proposer_owner'], [PENDING])
        self.assertIn('It binds only once your owner approves it in the owner console', r['what_happened'])
        # an answer that names neither (a server without held_for): both may, and no console is asserted
        for held_for in (None, [], 'acceptor_owner', [1, None]):
            r = accept(held_for)
            self.assertEqual(r['what_happened'], 'You signed the acceptance; it becomes binding when the owner holding it '
                                                 "approves (yours, or the proposer's if their limits require it; valun_deal "
                                                 f'shows which). If it is yours, your owner approves it in the owner console, '
                                                 f'{url} (deal {DEAL}).', held_for)
            self.assertNotIn('owner_console', r)

    def test_whose_turn_while_an_owner_decides(self):
        """valun_deal named nobody ('nobody: the deal is completion_awaiting_owner') while this agent's own owner held it,
        and told a payer to dispute a note_failed deal, which the server refuses (the approval semantics of 2026-11-17,
        approval probe D3)."""
        me = Stub.participant_id
        cases = [({'status': 'proposed_awaiting_owner', 'your_role': 'payer'}, "your owner's: your signed offer waits"),
                 ({'status': 'rejected_by_owner', 'your_role': 'payer'}, 'nobody: your owner rejected this offer'),
                 ({'status': 'completion_awaiting_owner', 'your_role': 'payer'}, "your owner's: the note or payment by transfer"),
                 ({'status': 'completion_awaiting_owner', 'your_role': 'payee'}, "the payer's owner's: the payment its agent"),
                 ({'status': 'accepted_awaiting_owner', 'acceptance': {'by': me, 'held_for': ['acceptor_owner']}},
                  "an owner's: the acceptance waits for your owner in the owner console"),
                 ({'status': 'accepted_awaiting_owner', 'acceptance': {'by': me, 'held_for': ['proposer_owner']}},
                  "an owner's: the acceptance waits for the proposer's owner in the owner console"),
                 ({'status': 'accepted_awaiting_owner', 'acceptance': {'by': 'vp_b0b0b0b0b0b0',
                                                                       'held_for': ['acceptor_owner', 'proposer_owner']}},
                  "an owner's: the acceptance waits for the acceptor's owner and your owner in the owner console")]
        for d, want in cases:
            self.assertTrue(va.owner_turn(d, me).startswith(want), (d, va.owner_turn(d, me)))
        stub = Stub(None)
        stub.deal = lambda did: {'id': DEAL, 'status': 'note_failed', 'your_role': 'payer', 'current': None}
        stub.learn_owner_decisions = lambda did, d: []
        r = agent_with(stub).deal({'deal_id': DEAL})
        self.assertEqual(r['whose_turn'], 'yours: the delivery stays accepted and is unpaid; pay it again (a new note, or by '
                                          'transfer when the window allows)')

    def test_valun_status_says_what_the_server_holds_by_the_mandate(self):
        url = 'https://valun.example/pilot#owner'
        self.assertEqual(va.held_for_owner({'approve_above': 0, 'review_deliveries': True}, 'https://valun.example/',
                                           'nanoERG', console=True),
                         f'Your owner approves or rejects what waits for them in the owner console: {url}.')
        self.assertEqual(va.held_for_owner({'approve_above': 5_000_000, 'review_deliveries': True}, 'https://valun.example',
                                           'nanoERG'),
                         f'The Valun server also holds these for your owner in the owner console ({url}) until they '
                         'approve: your offers, counter-offers and acceptances priced above 5000000 nanoERG (0.005 tERG), '
                         'and your guarantee offers capped above it (approve_above); and the note or payment by transfer you '
                         'sign when you accept a delivery (review_deliveries is on). It never holds an honor of a guarantee '
                         'call.')
        self.assertIn('Your owner has changed your owner mandate since console set it',
                      va.held_for_owner({'approve_above': 1, 'review_deliveries': False}, 'https://valun.example', 'nanoERG',
                                        console=True))
        self.assertIn('every offer, counter-offer, acceptance and guarantee offer you sign (approve_above 0)',
                      va.held_for_owner({'approve_above': 0}, 'https://valun.example', 'nanoERG'))

    def test_owner_decisions_say_what_a_rejection_leaves(self):
        T = 1_794_957_033_997
        rejected = {'id': 'va_17df22079678', 'kind': 'issue_note', 'state': 'rejected', 'decided_at': '2026-11-17T23:10:55.530Z'}
        d = {'status': 'delivered', 'counterparty': {'handle': 'bob'},
             'approvals': [dict(PENDING, state='approved', kind='propose'), rejected]}
        out = va.owner_decisions(d, [{'route': 'note', 'timestamp': T, 'approval_id': 'va_17df22079678', 'outcome': 'not_applied',
                                      'server_ended': {'state': 'rejected', 'approval_id': 'va_17df22079678', 'at': None}}])
        self.assertEqual([(x['approval_id'], x['kind'], x['state']) for x in out], [('va_17df22079678', 'issue_note', 'rejected')])
        text = out[0]['what_this_means']
        self.assertIn('Your owner rejected the note you signed for this deal. The Valun server did not send it', text)
        self.assertIn('the tracker could still record it until 2026-11-18T00:10:33.997Z', text)
        self.assertIn('Your Valun client counts it as not applied', text)
        out = va.owner_decisions({'status': 'rejected_by_owner', 'counterparty': {'handle': 'bob'},
                                  'approvals': [dict(PENDING, kind='propose', state='rejected')]})
        self.assertIn('Your owner rejected your offer: bob never saw it, and the deal has ended.', out[0]['what_this_means'])
        out = va.owner_decisions({'status': 'delivered', 'approvals': [dict(PENDING, kind='pay_by_transfer', state='void_expired')]})
        self.assertIn('expired before your owner decided (its hold ends 20 minutes after you sign it)', out[0]['what_this_means'])
        self.assertEqual(va.owner_decisions({'approvals': [PENDING, 'garbage', dict(PENDING, id='bad', state='rejected')]}), [])


ME, BOB = Stub.participant_id, 'vp_b0b0b0b0b0b0'
T = 1_794_957_033_997                                   # a bound note's timestamp (it ends in 997): 2026-11-17T23:10:33.997Z


def ended(kind, state, aid='va_17df22079678', at='2026-11-17T23:10:55.530Z'):
    return {'id': aid, 'deal_id': DEAL, 'kind': kind, 'state': state, 'decided_at': at}


def view(status, approvals=(), **kw):
    return dict({'id': DEAL, 'status': status, 'you': ME, 'your_role': 'payer', 'counterparty': {'handle': 'bob'},
                 'current': {'by': BOB, 'terms': {'offer_expires_at': '2026-11-19T10:00:00.000Z'}},
                 'approvals': list(approvals)}, **kw)


class Review072(unittest.TestCase):
    """The 0.7.2 RC's accuracy review: what each text says is what the server and this client do."""

    def test_a_confirmation_the_acceptance_voided_is_no_withdrawal(self):
        # The server (core.mjs decideApproval): the acceptor's owner rejecting the acceptance voids the proposer's
        # pending confirm_offer as void_acceptance_rejected, and the deal is open again with the offer standing. Only a
        # rejection by the proposer's owner withdraws the offer.
        mine = {'by': ME, 'terms': {'offer_expires_at': '2026-11-19T10:00:00.000Z'}}
        out = va.owner_decisions(view('open', [ended('confirm_offer', 'void_acceptance_rejected')], current=mine))
        self.assertEqual(out[0]['what_this_means'], "bob's owner did not approve its acceptance of your offer, so your owner had "
                                                    'nothing to confirm. Nothing was agreed, and your offer is open again '
                                                    'until 2026-11-19T10:00:00.000Z.')
        out = va.owner_decisions(view('withdrawn', [ended('confirm_offer', 'rejected')], current=mine))
        self.assertIn('the offer is withdrawn on your owner\'s behalf and the acceptance is void', out[0]['what_this_means'])
        out = va.owner_decisions(view('expired', [ended('confirm_offer', 'void_expired')], current=mine))
        self.assertEqual(out[0]['what_this_means'], "bob's acceptance of your offer ended before your owner confirmed it "
                                                    '(void_expired): nothing was agreed, and nothing is owed.')
        for x in out:
            self.assertNotIn('withdrawn', x['what_this_means'])
        # the deal moved on since: what it left is in the past
        out = va.owner_decisions(view('agreed', [ended('confirm_offer', 'void_acceptance_rejected')], current=mine))
        self.assertEqual(out[0]['what_this_means'], "Earlier (2026-11-17T23:10:55.530Z), bob's owner did not approve its "
                                                    'acceptance of your offer, so your owner had nothing to confirm: nothing '
                                                    'was agreed by it. The deal has since moved on (agreed).')

    def test_next_steps_only_while_the_deal_still_fits_them(self):
        """The review: on a deal now note_issued, an earlier rejected IOU and an earlier rejected acceptance still said
        'Accept the delivery again ...' and 'the offer is open again ... Accept it again'."""
        rows = [ended('accept', 'rejected', 'va_0a0a0a0a0a01', '2026-11-17T20:00:00.000Z'),
                ended('issue_note', 'rejected', 'va_0a0a0a0a0a02', '2026-11-17T22:00:00.000Z')]
        out = va.owner_decisions(view('note_issued', rows))
        self.assertEqual([x['what_this_means'] for x in out], [
            "Earlier (2026-11-17T20:00:00.000Z), your owner did not approve your acceptance of bob's offer: nothing was "
            'agreed by it. The deal has since moved on (note_issued).',
            'Earlier (2026-11-17T22:00:00.000Z), your owner rejected the note you signed for this deal: it was never sent to '
            'the tracker. The deal has since moved on (note_issued).'])
        # two rejected IOUs on a deal that is delivered again: the last says what to do, the earlier one when it was
        two = [ended('issue_note', 'rejected', 'va_0a0a0a0a0a02', '2026-11-17T22:00:00.000Z'),
               ended('issue_note', 'rejected', 'va_0a0a0a0a0a03', '2026-11-17T22:30:00.000Z')]
        out = va.owner_decisions(view('delivered', two))
        self.assertTrue(out[0]['what_this_means'].startswith('Earlier (2026-11-17T22:00:00.000Z), your owner rejected'))
        self.assertIn('The deal is back to delivered: accept the delivery again to sign a new note', out[1]['what_this_means'])
        # a counter-offer or acceptance: open on the other side's offer only
        out = va.owner_decisions(view('open', [ended('propose', 'rejected')]))
        self.assertIn('Its offer stays as it was until 2026-11-19T10:00:00.000Z: you may accept it', out[0]['what_this_means'])
        out = va.owner_decisions(view('open', [ended('propose', 'rejected')], current={'by': ME, 'terms': {}}))
        self.assertEqual(out[0]['what_this_means'], 'Earlier (2026-11-17T23:10:55.530Z), your owner rejected your '
                                                    'counter-offer, and bob never saw it. The deal has since moved on (open).')
        # a payment still due: the delivery stays accepted, so no dispute is offered
        out = va.owner_decisions(view('payment_due', [ended('issue_note', 'rejected')]))
        self.assertIn('The delivery stays accepted, and you must still pay it: accept it again to sign a new note',
                      out[0]['what_this_means'])
        self.assertNotIn('dispute', out[0]['what_this_means'])

    def test_one_sentence_per_way_a_hold_ends(self):
        """The review (wording slips): a void IOU said 'The rejection did not unsign the old IOU', though nothing was
        rejected; a transfer voided by a revoked key said it went void 'when your owner approved it'."""
        rec = [{'route': 'note', 'timestamp': T, 'approval_id': 'va_17df22079678', 'outcome': 'not_applied',
                'server_ended': {'state': 'void_stale', 'approval_id': 'va_17df22079678', 'at': None}}]
        text = va.owner_decisions(view('delivered', [ended('issue_note', 'void_stale')]), rec)[0]['what_this_means']
        self.assertTrue(text.startswith("The note you signed for this deal went void when your owner approved it "
                                        "(void_stale): the pair's note or a party's key had changed since you signed it."))
        self.assertNotIn('rejection', text)
        self.assertNotIn('could still record it', text)       # a stale note is not claimed to be recordable
        self.assertIn('The server keeps it on record, still signed, and never sends it.', text)
        self.assertIn(", or until your client sees this pair's note move past it.", text)
        text = va.owner_decisions(view('delivered', [ended('pay_by_transfer', 'void_key_revoked')]))[0]['what_this_means']
        self.assertTrue(text.startswith("Your payment by transfer went void before your owner decided (void_key_revoked): "
                                        "a party's key was revoked."), text)
        self.assertNotIn('when your owner approved it', text)
        text = va.owner_decisions(view('delivered', [ended('pay_by_transfer', 'void_stale')]))[0]['what_this_means']
        self.assertIn('went void when your owner approved it (void_stale): it was out of date', text)
        # without a record of this client's, the server's own fallback_after is the time named
        text = va.owner_decisions(view('delivered', [ended('pay_by_transfer', 'rejected')],
                                       payment={'state': 'void_rejected', 'fallback_after': '2026-11-18T00:11:33.999Z'}))[0]
        self.assertIn('or with your own note or another note after 2026-11-18T00:11:33.999Z (or once that note moves past it), or '
                      'dispute the delivery.', text['what_this_means'])
        # a record this client could not mark as not applied still blocks for good once the IOU moves (0.7.1's rule)
        rec = [{'route': 'note', 'timestamp': T, 'approval_id': 'va_17df22079678'}]
        text = va.owner_decisions(view('delivered', [ended('issue_note', 'rejected')]), rec)[0]['what_this_means']
        self.assertIn("Paying this deal by transfer waits until after 2026-11-18T00:12:33.997Z (your Valun client's time, a "
                      "minute after the server's, which the owner console shows, as a margin for clocks that differ). Your "
                      "Valun client still "
                      "counts it as a payment that may apply: once this pair's note moves past it, your client pays this "
                      'deal no more until your owner resolves it (`valun attempts resolve`).', text)
        self.assertNotIn('counts it as not applied', text)
        # no record at all: the server's own rule, which ends once its journal shows the pair's IOU moved past it
        text = va.owner_decisions(view('delivered', [ended('issue_note', 'void_stale')]))[0]['what_this_means']
        self.assertIn("Paying this deal by transfer waits until a little over an hour after you signed it, unless this pair's "
                      'note moves past it first.', text)

    def test_the_other_side_is_told_of_a_console_decision(self):
        """The review: owner_decisions covered only the viewer's own approvals, so after the payer's owner rejected an
        IOU the payee saw 'delivered' and 'they review your delivery' only (the synth's text for the other side)."""
        hist = [{'at': '2026-11-17T23:10:55.530Z', 'by': f'owner:{BOB}', 'event': 'owner_rejected', 'kind': 'issue_note'},
                {'at': '2026-11-17T23:10:56.000Z', 'by': f'owner:{ME}', 'event': 'owner_rejected', 'kind': 'accept'}]
        d = view('delivered', your_role='payee', history=hist)
        self.assertEqual(va.counterparty_owner_decisions(d, ME), [
            {'at': '2026-11-17T23:10:55.530Z', 'kind': 'issue_note', 'event': 'owner_rejected',
             'what_this_means': "bob's owner rejected the note its agent signed for your delivery. Nothing reached the tracker, "
                                'and bob owes you nothing for this deal yet. The deal is back to delivered: bob\'s agent may '
                                'accept it again or dispute it.'}])
        self.assertEqual(va.counterparty_owner_decisions(d, None), [])          # never without knowing who is who
        later = va.counterparty_owner_decisions(dict(d, status='note_issued'), ME)
        self.assertEqual(later[0]['what_this_means'], "Earlier (2026-11-17T23:10:55.530Z), bob's owner rejected the note its "
                                                      'agent signed for your delivery; nothing reached the tracker. The deal '
                                                      'has since moved on (note_issued).')
        acc = [{'at': '2026-11-17T23:10:55.530Z', 'by': f'owner:{BOB}', 'event': 'owner_rejected', 'kind': 'accept'}]
        out = va.counterparty_owner_decisions(view('open', history=acc), ME)
        self.assertEqual(out[0]['what_this_means'], "bob's owner did not approve its acceptance of your offer. Nothing was "
                                                    'agreed, and your offer is open again until 2026-11-19T10:00:00.000Z.')
        conf = [{'at': '2026-11-17T23:10:55.530Z', 'by': f'owner:{BOB}', 'event': 'owner_rejected', 'kind': 'confirm_offer'}]
        out = va.counterparty_owner_decisions(view('withdrawn', history=conf), ME)
        self.assertEqual(out[0]['what_this_means'], "bob's owner withdrew its offer before the deal was agreed. Your "
                                                    'acceptance is void, and nothing is owed.')
        void = [{'at': 'x', 'by': 'valun', 'event': 'payment_void', 'transfer_id': 'vt_0123456789abcdef', 'reason': 'expired'},
                {'at': 'y', 'by': 'valun', 'event': 'payment_void', 'reason': 'rejected_by_owner'}]
        out = va.counterparty_owner_decisions(view('delivered', your_role='payee', history=void), ME)
        self.assertEqual([x['what_this_means'] for x in out],
                         ["bob's payment by transfer expired before its owner decided (20 minutes after its agent signed "
                          'it). Nothing moved, and the deal is back to delivered.'])

    def test_valun_deal_names_a_held_ious_hour_and_after_it_says_to_reject_it(self):
        """The review: valun_deal on a held IOU past its hour still said it waits for the owner, with no deadline; an
        approval then fails at the tracker and leaves the delivery accepted and no longer disputable (approval probe D3)."""
        held = view('completion_awaiting_owner', [dict(PENDING, kind='issue_note')], current=None,
                    credit_note={'state': 'awaiting_owner', 'amount': 3_000_000, 'approval_id': PENDING['id'],
                                 'note': {'total': 9_000_000, 'timestamp': T, 'prior_signature': '03' + '11' * 64}})
        stub = Stub(None)
        stub.deal = lambda did: held
        stub.learn_owner_decisions = lambda did, d: []
        for now, passed in ((T + 1000, False), (T + 3_600_000, True)):
            with mock.patch.object(va.vc, 'time', types.SimpleNamespace(time=lambda now=now: now / 1000)):
                r = agent_with(stub).deal({'deal_id': DEAL})
            self.assertEqual((r['decide_by'], r['note_expires_at']), ('2026-11-18T00:09:33.997Z', '2026-11-18T00:10:33.997Z'))
            if passed:
                self.assertEqual(r['whose_turn'], "your owner's: the note you signed when you accepted the delivery still "
                                                  'waits for them, but the tracker records it only until '
                                                  '2026-11-18T00:10:33.997Z, which has passed: tell your owner to reject '
                                                  'it in the owner console (approved now, it would fail at the tracker and '
                                                  'leave the delivery accepted, unpaid and no longer disputable), then '
                                                  'accept the delivery again to sign a new note')
            else:
                self.assertEqual(r['whose_turn'], "your owner's: the note you signed when you accepted the delivery waits for "
                                                  'them in the owner console: they approve or reject it by '
                                                  "2026-11-18T00:09:33.997Z, the owner console's deadline, a minute before "
                                                  "the tracker's limit (2026-11-18T00:10:33.997Z)")
        # a held payment by transfer names its hold's end; the payee's view names no hour
        pay = view('completion_awaiting_owner', payment={'state': 'awaiting_owner', 'expires_at': '2026-11-17T23:30:00.000Z'})
        self.assertIn('until 2026-11-17T23:30:00.000Z (20 minutes after you signed it)', va.owner_turn(pay, ME, T))
        self.assertEqual(va.held_note_hour(dict(held, your_role='payee'), T + 3_600_000), (None, None, False))
        # the tour's plan, from this client's own record of the IOU it signed for that approval
        c = types.SimpleNamespace(state={'transfer_attempts': {DEAL: [{'route': 'note', 'timestamp': T,
                                                                        'approval_id': PENDING['id']}]}})
        row = {'approval_id': PENDING['id'], 'deal_id': DEAL, 'kind': 'issue_note'}
        self.assertEqual(va.held_note_of(c, row, T + 3_600_000),
                         ('2026-11-18T00:09:33.997Z', '2026-11-18T00:10:33.997Z', True))
        self.assertEqual(va.held_note_of(c, dict(row, kind='accept'), T + 3_600_000), (None, None, False))
        self.assertEqual(va.note_decide_by({'timestamp': T}), '2026-11-18T00:09:33.997Z')
        self.assertIsNone(va.note_decide_by({'timestamp': T - 997 + 500}), 'an ordinary note has no deadline')

    def test_the_honor_reply_names_the_call_the_client_honored(self):
        """The review: with no call_id the client honors its first open or failed call, and the reply named the last
        honored one, and called a failed honor (the tracker refused the note: HTTP 200, call failed) honored."""
        gid, first, second = 'vg_0123456789abcdef', 'vgc_1111111111111111', 'vgc_2222222222222222'

        def stub_with(state_after):
            s = Stub(None)
            s.state[vc_key()] = {gid: {'cap': 2_000_000, 'calls': {second: {'amount': 900_000, 'state': 'honored',
                                                                            'timestamp': T - 50_000}}}}

            def honor(g, cid, exp):
                s.state[vc_key()][gid]['calls'][first] = {'amount': 500_000, 'state': state_after, 'timestamp': T}
                return {'guarantee_id': gid, 'creditor': {'handle': 'carol'},
                        'calls': [{'call_id': first, 'amount': 500_000, 'state': state_after},
                                  {'call_id': second, 'amount': 900_000, 'state': 'honored'}]}
            s.honor_guarantee = honor
            return s
        r = agent_with(stub_with('failed')).respond_guarantee({'guarantee_id': gid, 'action': 'honor'})
        self.assertEqual(r['what_happened'], f'The tracker did not record your note for call {first}, so it adds nothing to '
                                             'what you owe carol. The call still waits to be honored: honor it again (your '
                                             'client signs a new note), and tell your owner.')
        r = agent_with(stub_with('honored')).respond_guarantee({'guarantee_id': gid, 'action': 'honor'})
        self.assertTrue(r['what_happened'].startswith(f'You honored call {first}: your note to carol for 500000 nanoERG'))
        self.assertNotIn(second, r['what_happened'])


def vc_key():
    return va.vc.GUARANTEE_HONORS_KEY


if __name__ == '__main__':
    unittest.main()
