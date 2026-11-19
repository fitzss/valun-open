"""The client half of the Nov 18 fresh-join run (Basis, on the live testnet, with valun 0.7.1), offline.

Finding 10: "word count" anywhere in a free-form job's terms (basis-fj-b sold "word count of a short text") made both
clients take it for the built-in text-stats job, check a correct plain-text answer against its JSON result and tell the
buyer "Dispute it ... instead of issuing a credit note". Now the exact check runs, and a dispute is advised, only in a
built-in job: with sandbox-exact or sandbox-mallory, or terms titled text-stats or notary, or that ask for the ```json
result block. A delivery without that block is "not in the built-in format", never "does not match (differs in )".

Finding 12: accepting a delivery ended with status note_issued, local_only and 600 characters of settlement text for the
buyer, and nothing for the seller. Now valun_deal (either side) and valun_review_delivery open with a plain summary, the
server's when it sends one, else one built from the deal view: who owes whom, the pair's running total, where the IOU
stands (local_only explained), how to check it and how it is paid back; valun_inbox's recent_closed says it in a line.

The same in the JavaScript client: the scenarios of js/test/fixtures/generate_python_fixtures.py ('deal: free-form ...',
'deal: credit note issued ...', 'review: accept issues the note', 'inbox')."""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import sandbox as sb  # noqa: E402

SERVER = 'https://valun.example'
ME = 'vp_aaaaaaaaaaaa'
SENTENCE = 'the cat sat on the mat with the hat'
WORD_STATS = {'title': 'word stats',
              'description': f'Word stats for this sentence: "{SENTENCE}". Tell me the word count and the most frequent '
                             'word, in plain text.',
              'deliverable': 'plain text: the word count and the most frequent word'}
PLAIN_ANSWER = 'Word count: 9. Most frequent word: "the" (3 times).'
SUMMARY = {'title': 'Summary', 'description': 'Summarize this, word count at most 30:\n```\n' + ('A long text. ' * 20) + '\n```',
           'deliverable': 'A summary in plain text, word count at most 30'}
STATS = {'title': 'text-stats job', 'description': 'text-stats for this text:\n```\nThe cat saw the dog.\nThe end\n```',
         'deliverable': 'The exact text-stats result as JSON.'}


def terms(service, price=2_000_000):
    return {'service': service, 'price': {'amount': price, 'unit': 'nanoERG'}}


def view(service, content, counterparty, status='delivered', role='payer', **extra):
    """A deal view as the server shows it, for this agent (ME) as `role`, with `counterparty` (a handle)."""
    d = {'id': 'vd_0123456789abcdef', 'status': status, 'your_role': role, 'you': ME,
         'counterparty': {'id': 'vp_bbbbbbbbbbbb', 'handle': counterparty}, 'next_actions': [],
         'current': {'version': 1, 'by': ME, 'state': 'agreed', 'terms': terms(service), 'terms_hash': 'ab' * 32},
         'versions': [], 'history': [], 'labels': {}}
    if content is not None:
        d['delivery'] = {'title': 'Result', 'content': content, 'sha256': vc.sha256_hex(content),
                         'bytes': len(content.encode('utf-8')), 'late': False, 'signature': 'cd' * 32}
    d.update(extra)
    return d


class FakeClient:
    participant_id = ME
    network = va.TESTNET
    unit = 'nanoERG'
    scale = 1_000_000

    def __init__(self, deal=None, completed=None, box=None):
        self.state = {'server': SERVER}
        self._deal, self._completed, self._box = deal, completed, box

    def deal(self, did):
        return json.loads(json.dumps(self._deal))

    def learn_owner_decisions(self, did, d):
        pass

    def complete(self, did, sha=None, terms_hash=None):
        return json.loads(json.dumps(self._completed))

    def inbox(self):
        return json.loads(json.dumps(self._box))

    def payment_options(self, did):                 # a delivered deal's payer, with circulating credit
        return {'own_note': {'available': True}, 'held_notes': []}


class Agent(va.ValunAgent):
    def __init__(self, fake, features=('circulation/1',)):
        super().__init__(store=None, check_link_hosts=False)
        self.fake, self.features = fake, list(features) if features is not None else None

    def client(self, require_connection=True):
        return self.fake


def deal(d, **kw):
    return Agent(FakeClient(deal=d), **kw).call('valun_deal', {'deal_id': d['id']})


class BuiltInJobs(unittest.TestCase):
    def test_a_free_form_word_count_job_is_not_checked_and_gets_no_advice(self):
        # Finding 10's repro: a correct plain-text word count, from an agent that is not a sandbox agent. 0.7.1 and the
        # RC: exact_result_matches false, "the delivery has no ```json result block to compare", and the advice
        # "The delivered result does not match ... Dispute it ... instead of issuing a credit note".
        self.assertEqual(sb.which_service(terms(WORD_STATS)), 'text-stats')          # a seller still sells by it
        self.assertFalse(sb.built_in_job(terms(WORD_STATS), 'basis-fj-b'))
        for service in (WORD_STATS, SUMMARY):
            with self.subTest(title=service['title']):
                out = deal(view(service, PLAIN_ANSWER, 'basis-fj-b'))
                self.assertNotIn('advice', out['delivery'])
                self.assertEqual(out['delivery']['checked_exactly_by_your_client'],
                                 {'checked': False, 'built_in_job': False, 'why': sb.NOT_BUILT_IN})
                self.assertTrue(sb.NOT_BUILT_IN.startswith('not a built-in job: not checked exactly. '))
                self.assertEqual(va.exact_facts(terms(service), PLAIN_ANSWER, 'basis-fj-b'), [], 'nothing on the card')

    def test_a_built_in_job_is_checked_and_a_wrong_result_disputed(self):
        wrong = sb.render('text-stats', dict(sb.text_stats('The cat saw the dog.\nThe end'), words=8), 'x')
        for service, who in ((WORD_STATS, 'sandbox-mallory'), (STATS, 'basis-fj-b'),
                             (dict(WORD_STATS, title='Text-Stats'), 'someone'),
                             (dict(WORD_STATS, deliverable='the exact result as a ```json block'), 'someone')):
            with self.subTest(title=service['title'], who=who):
                self.assertTrue(sb.built_in_job(terms(service), who))
        out = deal(view(STATS, wrong, 'sandbox-mallory'))
        exact = out['delivery']['checked_exactly_by_your_client']
        self.assertEqual((exact['checked'], exact['exact_result_matches'], exact['differs_in']), (True, False, ['words']))
        self.assertEqual(out['delivery']['advice'], 'The delivered result does not match the exact result of the agreed '
                                                    'text (differs in: words). Dispute it with that reason instead of '
                                                    'issuing an IOU.')
        self.assertNotIn('advice', deal(view(STATS, wrong, 'sandbox-mallory', role='payee'))['delivery'])

    def test_a_built_in_job_without_the_result_block_is_not_in_the_built_in_format(self):
        # Never "does not match", and never the empty "differs in )" of 0.7.1's approval card.
        out = deal(view(STATS, PLAIN_ANSWER, 'sandbox-exact'))
        exact = out['delivery']['checked_exactly_by_your_client']
        self.assertEqual((exact['checked'], exact['exact_result_matches'], exact['built_in_format'], exact['why']),
                         (True, False, False, 'not in the built-in format: the delivery has no ```json result block to compare'))
        self.assertEqual(out['delivery']['advice'], 'The delivery is not in the built-in format: it has no ```json result '
                                                    'block to compare with the exact result of the agreed text. Dispute it '
                                                    'with that reason instead of issuing an IOU.')
        self.assertEqual(va.exact_facts(terms(STATS), PLAIN_ANSWER, 'sandbox-exact'),
                         ['exact result: not in the built-in format (no ```json result block)'])
        self.assertNotIn('differs in', json.dumps(out['delivery']))

    def test_a_title_in_the_text_to_work_on_or_a_near_title_is_no_built_in_job(self):
        for title in ('text-stats of my essay', 'notary public', 'word count', ''):
            self.assertFalse(sb.built_in_job({'service': {'title': title, 'description': 'TEXT: a'}}, 'x'), title)
        # the text to work on can hold anything, a ```json fence included
        self.assertFalse(sb.built_in_job({'service': {'title': 'review', 'description': 'Review:\n```json\n{"a": 1}\n```'}}))
        self.assertTrue(sb.built_in_job({'service': {'title': ' Notary   Job '}}))
        self.assertTrue(sb.built_in_job({'service': {'title': 'Welcome job: text-stats'}}))
        self.assertIsNone(sb.check_built_in({'service': {'title': 'write a poem'}}, 'x', 'sandbox-exact'))


def issued(role='payer', confirmation='local_only', **extra):
    d = view(WORD_STATS, PLAIN_ANSWER, 'basis-fj-b' if role == 'payer' else 'basis-fj-a', status='note_issued', role=role,
             credit_note={'state': 'recorded', 'amount': 2_000_000, 'tracker_status': 'recorded', 'outstanding': True,
                          'confirmation': confirmation,
                          'tracker_note': {'amount_collected': 5_000_000, 'confirmation': confirmation}})
    d.update(extra)
    return d


class PlainEnding(unittest.TestCase):
    PAYER = ("You owe basis-fj-b 2000000 nanoERG (0.002 tERG) more by this deal's IOU (the tracker's running total for "
             "that pair: 5000000 nanoERG (0.005 tERG)). Where it stands: local_only, recorded by the tracker; no tracker "
             'box on Ergo testnet commits it yet. The tracker posts one tracker box at a time, at most 50 a UTC day: the '
             'next one commits it, usually within 15 minutes of a change, as measured on the testnet, and once the '
             "day's 50 are used up, only after 00:00 UTC. The confirmation then reads pending, then confirmed. Check it: the "
             f'row from you to basis-fj-b in GET {SERVER}/pilot/v1/ledger (its total and confirmation), and `valun audit '
             '--mine`, which checks your records against the box once the next box commits them. It stays outstanding '
             'until a loop clears it (a set-off around a cycle of debts), basis-fj-b passes it on (pays another agent '
             'with it, which changes only whom you owe), or basis-fj-b redeems it on Ergo testnet against your reserve, '
             'if you post one.')

    def test_valun_deal_opens_with_the_ending_for_both_sides(self):
        out = deal(issued())
        self.assertEqual(list(out)[0], 'summary')
        self.assertEqual(out['summary'], self.PAYER)
        self.assertEqual(out['credit_note']['confirmation_means'], va.CONFIRMATION_WORDS['local_only'])
        theirs = deal(issued('payee', 'confirmed'))
        self.assertTrue(theirs['summary'].startswith("basis-fj-a owes you 2000000 nanoERG (0.002 tERG) more by this deal's "
                                                     'IOU'), theirs['summary'])
        for words in ('Where it stands: confirmed, a confirmed tracker box on Ergo testnet commits it.',
                      f'the row from basis-fj-a to you in GET {SERVER}/pilot/v1/ledger',
                      'you pass it on (pay_with when you accept a delivery, which changes only whom basis-fj-a owes)',
                      "or you redeem it on Ergo testnet against basis-fj-a's reserve, if it posts one."):
            self.assertIn(words, theirs['summary'])
        # without circulating credit: no loop and nothing passed on, only redemption
        plain = deal(issued(), features=())
        self.assertTrue(plain['summary'].endswith('It stays outstanding until basis-fj-b redeems it on Ergo testnet '
                                                  'against your reserve, if you post one.'), plain['summary'])
        self.assertNotIn('summary', deal(view(WORD_STATS, PLAIN_ANSWER, 'basis-fj-b')))

    def test_the_servers_own_summary_comes_first_when_it_sends_one(self):
        said = 'basis-fj-a owes basis-fj-b 2,000,000 nanoERG (0.002 tERG): recorded at 00:02Z, committed at the next box.'
        self.assertEqual(deal(issued(summary=said))['summary'], said)
        self.assertEqual(deal(issued(labels={'summary': said}))['summary'], said)
        self.assertEqual(deal(issued(summary=7))['summary'], self.PAYER, 'not text: the client builds it')

    def test_accepting_a_delivery_opens_with_the_ending(self):
        r = issued()
        out = Agent(FakeClient(completed=r)).call('valun_review_delivery', {'deal_id': r['id'], 'decision': 'accept'})
        self.assertEqual(list(out)[:4], ['summary', 'deal_id', 'status', 'what_happened'])
        self.assertEqual(out['summary'], self.PAYER)
        self.assertEqual(out['credit_note']['confirmation_means'], va.CONFIRMATION_WORDS['local_only'])
        # the payer's ending even where the view names no role
        r.pop('your_role')
        out = Agent(FakeClient(completed=r)).call('valun_review_delivery', {'deal_id': r['id'], 'decision': 'accept'})
        self.assertEqual(out['summary'], self.PAYER)

    def test_the_inbox_says_each_issued_iou_in_a_line(self):
        box = {'respond': [], 'recent_closed': [
            {'deal_id': 'vd_1', 'status': 'note_issued', 'counterparty': 'basis-fj-b', 'your_role': 'payer',
             'title': 'word stats', 'price': {'amount': 2_000_000, 'unit': 'nanoERG'}},
            {'deal_id': 'vd_2', 'status': 'note_issued', 'counterparty': 'basis-fj-a', 'your_role': 'payee',
             'title': 'word stats', 'price': {'amount': 2_000_000, 'unit': 'nanoERG'}},
            {'deal_id': 'vd_3', 'status': 'declined', 'counterparty': 'x', 'your_role': 'payer'}]}
        out = Agent(FakeClient(box=box)).call('valun_inbox', {})
        rows = out['recent_closed']
        self.assertEqual([list(x)[0] for x in rows], ['summary', 'summary', 'deal_id'])
        self.assertEqual(rows[0]['summary'], 'Paid with your IOU: this deal added 2000000 nanoERG (0.002 tERG) to what you '
                                             'owe basis-fj-b. valun_deal shows where it stands on the tracker and how it '
                                             'is paid back.')
        self.assertEqual(rows[1]['summary'], 'basis-fj-a paid with its IOU: this deal added 2000000 nanoERG (0.002 tERG) '
                                             'to what basis-fj-a owes you. valun_deal shows where it stands on the tracker '
                                             'and how it is paid back.')
        self.assertEqual(out['respond'], [])

    def test_every_confirmation_is_explained_on_the_testnet_and_the_pilot(self):
        for conf in ('local_only', 'pending', 'confirmed'):
            self.assertTrue(va.confirmation_means(conf, va.TESTNET), conf)
        self.assertIn('no blockchain connection', va.confirmation_means('local_only', vc.NETWORK))
        self.assertIsNone(va.confirmation_means('pending', vc.NETWORK))
        self.assertIsNone(va.confirmation_means(None, va.TESTNET))

    def test_the_time_to_commit_is_the_servers(self):
        """The replay of 2026-11-18 (problem 3): one deal view gave the time to commit two ways. The server's summary
        (valun-app d269b1e, Pilot.issuedSummary) says one box at a time, at most 50 a UTC day, "usually within 15
        minutes of a change, as measured on this network"; credit_note.confirmation_means said "usually 5 to 15 minutes
        after the IOU, up to about 30", and left out the daily cap, after which loops waited 3.9 to 5.5 hours (Nov 16).
        Now the client's words give the server's figure, the cap (the one in server/'s anchors.mjs) and what follows it."""
        words = va.confirmation_means('local_only', va.TESTNET)
        self.assertIn('usually within 15 minutes of a change, as measured on the testnet', words)
        self.assertIn('one tracker box at a time, at most 50 a UTC day', words)
        self.assertIn("once the day's 50 are used up, only after 00:00 UTC", words)
        for old in ('5 to 15 minutes', 'about 30'):
            self.assertNotIn(old, json.dumps([va.CONFIRMATION_WORDS, va.CONFIRMATION_WORDS_PILOT]))
        anchors = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'server', 'lib', 'pilot', 'anchors.mjs')
        if not os.path.exists(anchors):
            self.skipTest('no server/ copy here')
        with open(anchors, encoding='utf-8') as f:
            cap = re.search(r'^export const DAILY_TRACKER_SIGNATURES = (\d+);', f.read(), re.M)
        self.assertIsNotNone(cap, 'the server names its daily cap')
        self.assertIn(f'at most {cap.group(1)} a UTC day', words)


if __name__ == '__main__':
    unittest.main()
