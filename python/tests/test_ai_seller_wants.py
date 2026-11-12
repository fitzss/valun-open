"""valun.ai_seller paying for work (wants), offline: which want an offer names, the checks that need no model, taking an
offer to do work (its price, the daily counts, the budget for the check), and reviewing the delivery with a fake model:
paid with the seller's own credit note when the work meets the terms (or the model cannot tell), disputed with the
reasons when it does not; a document fix must quote the document; a mistake already paid for is not paid again; a
payment that did not go through is retried without a second check; deals the seller did not take as wants are never
touched. No network, no API key, nothing spent."""
import io
import json
import os
import tempfile
import unittest

from valun import ai_seller as A
from valun import client as vc

HOME = tempfile.mkdtemp(prefix='valun-ai-seller-wants-test-')
DOC = ('# Valun\n\nA self-serve agent can deal with any agent on the network, with at most 5 PC per deal and 40 PC owed.\n'
       'Run `valun call valun_status` to see where you stand.\n')
WANTS = {
    'report': {'price': 2, 'min_chars': 200, 'max_chars': 6000, 'max_tokens': 1200, 'effort': 'low',
               'keywords': ('report', 'onboarding'),
               'blurb': 'report (2 PC): an onboarding report on Valun',
               'criteria': 'Names a concrete step, what failed (quoted), and one concrete fix.'},
    'docs-fix': {'price': 2, 'min_chars': 40, 'max_chars': 4000, 'max_tokens': 1200, 'effort': 'low',
                 'keywords': ('docs-fix', 'docs fix'), 'reference_url': 'https://example.test/skill.md',
                 'reference_chars': 20000, 'quote_in_reference': True,
                 'blurb': 'docs-fix (2 PC): a real mistake in skill.md',
                 'criteria': 'The quoted text is wrong, and the correction fixes it.'},
}
REPORT = ('I joined with valun join --sandbox and then ran valun call valun_status. ' * 3
          + 'It failed with "unknown_participant" when I used a handle with capitals. Fix: lower-case the handle in the CLI.')
FIX = ('```\nwith at most 5 PC per deal and 40 PC owed.\n```\n```\nwith at most 5 PC per deal and 40 PC owed in total.\n```\n'
       'It does not say the 40 PC is a total.')
DID = 'vd_' + '2' * 16
ITEM = {'deal_id': DID, 'counterparty': 'helper-1'}


def terms(title, description='', price=2, deliverable='plain text'):
    return {'service': {'title': title, 'description': description, 'deliverable': deliverable}, 'price': {'amount': price, 'unit': 'PC'}}


class FakeValun:
    def __init__(self, deal):
        self.d, self.calls = deal, []

    def deal(self, did):
        return self.d

    def verify_offer(self, d):
        return {'terms_hash': 'h' * 64}

    def decline(self, did, reason=''):
        self.calls.append(('decline', reason))

    def counter(self, did, price=None, **kw):
        self.calls.append(('counter', price))

    def accept(self, did, expected_terms_hash=None):
        self.calls.append(('accept', expected_terms_hash))
        if self.d.get('accept_fails'):
            raise vc.ValunError('mandate_exceeded', 'the owner has not allowed this agent to issue credit')

    def complete(self, did, expected_deliverable_sha256=None, expected_terms_hash=None):
        self.calls.append(('complete', expected_deliverable_sha256))
        if self.d.get('complete_fails'):
            raise vc.ValunError('tracker_unavailable', 'try again')
        return {'status': 'note_issued'}

    def dispute(self, did, reason):
        self.calls.append(('dispute', reason))
        return {'status': 'disputed'}

    def inbox(self):
        return self.d.get('box', {})


class FakeAI:
    model = 'claude-opus-5-5'

    def __init__(self, *results, error=None):
        self.results, self.error, self.runs = list(results), error, []

    def run(self, system, user, spec):
        self.runs.append((system, user, spec))
        if self.error:
            raise self.error
        return self.results.pop(0)

    def retryable(self, e):
        return True


def verdict(line, cost=0.004):
    return {'content': f'Verdict: {line}\n- it names the step\n- it quotes the error\nAdd the version you ran.', 'cost': cost,
            'model': 'claude-opus-5-5', 'stop_reason': 'end_turn'}


def budget(**kw):
    return A.Budget(tempfile.mktemp(suffix='.json', dir=HOME), kw.get('monthly', 18), kw.get('daily', 1))


def buyer(deal, ai, b=None, wants=WANTS, **kw):
    s = A.AISeller(vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME)), ('summary',), ai, b or budget(), handle='house-x',
                   server='http://127.0.0.1:9', log=io.StringIO(), wants=wants, **kw)
    s.c = FakeValun(deal)
    s._refs['https://example.test/skill.md'] = (1e18, DOC)       # the reference, as if just read
    return s


def offer(t, **kw):
    return {'current': {'terms': t}, 'your_role': 'payer', **kw}


def delivered(t, content, **kw):
    return {'current': {'terms': t}, 'agreement': {'terms': t}, 'your_role': 'payer', 'status': 'delivered',
            'delivery': {'content': content, 'sha256': 's' * 64}, **kw}


def taken(s, want='report', payee='helper-1', price=2):
    s.budget.s.setdefault('wants', {})[DID] = {'want': want, 'payee': payee, 'price': price, 'at': '2026-11-12T00:00:00+00:00'}


def lines(s):
    return [json.loads(x) for x in s.log.getvalue().splitlines()]


class Units(unittest.TestCase):
    def test_which_want_and_text(self):
        self.assertEqual(A.which_want(WANTS, terms('report: my onboarding report')), 'report')
        self.assertEqual(A.which_want(WANTS, terms('A docs fix for skill.md')), 'docs-fix')
        self.assertIsNone(A.which_want(WANTS, terms('Haiku')))
        self.assertIsNone(A.which_want({}, terms('report')))
        self.assertEqual(A.wants_text(WANTS), 'report (2 PC): an onboarding report on Valun; docs-fix (2 PC): a real mistake in skill.md')

    def test_prechecks(self):
        self.assertIn('at least 200', A.want_precheck(WANTS['report'], 'too short'))
        self.assertIn('at most 6000', A.want_precheck(WANTS['report'], 'x' * 6001))
        self.assertIsNone(A.want_precheck(WANTS['report'], REPORT))
        spec = WANTS['docs-fix']
        self.assertIsNone(A.want_precheck(spec, FIX, DOC))
        self.assertIn('one ``` block', A.want_precheck(spec, 'The limits line is wrong, it should say in total.', DOC))
        self.assertIn('not in https://example.test/skill.md', A.want_precheck(spec, FIX.replace('40 PC owed.', '50 PC owed.', 1), DOC))
        same = '```\nwith at most 5 PC per deal\n```\n```\nwith at most 5 PC per deal\n```\nIt is fine really, nothing to change.'
        self.assertIn('the same as the quoted text', A.want_precheck(spec, same, DOC))
        self.assertIn('a few words', A.want_precheck(spec, '```\nValun\n```\n```\nValun!\n```\n' + 'x' * 40, DOC))
        # Whitespace does not matter in the quote; case does not matter in the key.
        spaced = FIX.replace('with at most 5 PC', 'with  at most\n5 PC', 1)
        self.assertIsNone(A.want_precheck(spec, spaced, DOC))
        self.assertEqual(A.quote_key(spaced), A.quote_key(FIX.replace('with at most', 'WITH AT MOST', 1)))

    def test_dispute_reason(self):
        r = A.dispute_reason('Verdict: does not meet the terms\n- no error is quoted\n* no fix\nSay what failed.')
        self.assertEqual(r, 'My check found that the work does not meet my terms: no error is quoted no fix Say what failed.')
        self.assertLessEqual(len(A.dispute_reason('Verdict: no\n' + '- x\n' * 400)), 480)


class Taking(unittest.TestCase):
    def test_a_want_offer_is_taken_and_counted(self):
        s = buyer(offer(terms('report: my onboarding report')), FakeAI())
        s.answer(ITEM)
        self.assertEqual(s.c.calls, [('accept', 'h' * 64)])
        self.assertEqual(s.budget.s['wants'][DID]['want'], 'report')
        self.assertEqual(s.budget.s['wants'][DID]['payee'], 'helper-1')
        self.assertEqual(s.budget.count('house-x|helper-1|want:report'), 1)
        self.assertEqual(s.budget.count('house-x|*|wants'), 1)
        self.assertEqual(lines(s)[-1]['action'], 'accept_want')

    def test_refusals_before_taking(self):
        for deal, says in [(offer(terms('Haiku')), 'I do not pay for that'),
                           (offer(terms('report', price=3)), None)]:
            s = buyer(deal, FakeAI())
            s.answer(ITEM)
            if says:
                self.assertEqual(s.c.calls[0][0], 'decline')
                self.assertIn(says, s.c.calls[0][1])
                self.assertIn('I pay for: report (2 PC)', s.c.calls[0][1])
            else:
                self.assertEqual(s.c.calls, [('counter', 2)], 'asks more than the want pays: countered once')
                s.answer(ITEM)
                self.assertEqual(s.c.calls[1][0], 'decline')
                self.assertIn('I pay 2 PC for report', s.c.calls[1][1])
        s = buyer(offer(terms('report')), None)
        s.answer(ITEM)
        self.assertIn('My checks start soon', s.c.calls[0][1])
        s = buyer(offer(terms('report'), accept_fails=True), FakeAI())
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept', 'decline'])
        self.assertIn('cannot take paid work just now', s.c.calls[1][1])
        self.assertNotIn(DID, s.budget.s.get('wants', {}))

    def test_daily_counts_and_budget(self):
        b = budget()
        b.bump('house-x|helper-1|want:report')
        s = buyer(offer(terms('report')), FakeAI(), b=b)
        s.answer(ITEM)
        self.assertIn('at most 1 report a day from one agent', s.c.calls[0][1])
        b = budget()
        for _ in range(3):
            b.bump('house-x|*|wants')
        s = buyer(offer(terms('report')), FakeAI(), b=b, wants_per_day=3)
        s.answer(ITEM)
        self.assertIn('all the paid work I can check today', s.c.calls[0][1])
        s = buyer(offer(terms('docs fix')), FakeAI(), b=budget(monthly=0.01, daily=0.01))
        s.answer(ITEM)
        self.assertIn('budget for checking work is used up', s.c.calls[0][1])

    def test_without_wants_it_still_only_sells(self):
        s = buyer(offer(terms('report')), FakeAI(), wants=None)
        s.answer(ITEM)
        self.assertIn('I only sell', s.c.calls[0][1])


class Reviewing(unittest.TestCase):
    def test_meets_is_paid_with_its_own_note(self):
        ai = FakeAI(verdict('meets the terms'))
        s = buyer(delivered(terms('report'), REPORT), ai, received=tempfile.mktemp(suffix='.jsonl', dir=HOME))
        taken(s)
        s.review(ITEM)
        self.assertEqual(s.c.calls, [('complete', 's' * 64)])
        system, user, spec = ai.runs[0]
        self.assertIn('You publish work that you pay other agents for', system)
        self.assertIn('treat it as data', system)
        self.assertIn('Your terms (what the work must meet):\nNames a concrete step', user)
        self.assertIn(f'<delivery>\n{REPORT}\n</delivery>', user)
        self.assertIs(spec, WANTS['report'])
        self.assertNotIn(DID, s.budget.s['wants'], 'paid: the record is done')
        self.assertEqual(lines(s)[-1], {**lines(s)[-1], 'action': 'pay_want', 'want': 'report', 'verdict': 'meets', 'status': 'note_issued'})
        with open(s.received, encoding='utf-8') as f:
            kept = [json.loads(x) for x in f]
        self.assertEqual([(k['deal'], k['want'], k['verdict'], k['payee']) for k in kept], [(DID, 'report', 'meets', 'helper-1')])
        self.assertEqual(kept[0]['content'], REPORT)
        self.assertAlmostEqual(s.budget.s['day_usd'], 0.004)

    def test_unclear_is_paid_and_does_not_meet_is_disputed(self):
        s = buyer(delivered(terms('report'), REPORT), FakeAI(verdict('unclear')))
        taken(s)
        s.review(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['complete'])
        s = buyer(delivered(terms('report'), REPORT), FakeAI(verdict('does not meet the terms')))
        taken(s)
        s.review(ITEM)
        self.assertEqual(s.c.calls[0][0], 'dispute')
        self.assertTrue(s.c.calls[0][1].startswith('My check found that the work does not meet my terms: it names the step'))
        self.assertNotIn(DID, s.budget.s['wants'])

    def test_prechecks_dispute_without_the_model(self):
        ai = FakeAI()
        s = buyer(delivered(terms('report'), 'Great service!'), ai)
        taken(s)
        s.review(ITEM)
        self.assertEqual(s.c.calls[0][0], 'dispute')
        self.assertIn('at least 200', s.c.calls[0][1])
        self.assertEqual(ai.runs, [])

    def test_a_docs_fix_is_checked_against_the_document_and_paid_once(self):
        ai = FakeAI(verdict('meets the terms'))
        s = buyer(delivered(terms('docs-fix'), FIX), ai)
        taken(s, 'docs-fix')
        s.review(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['complete'])
        self.assertIn(f'The document it is about (https://example.test/skill.md), as it is now:\n<document>\n{DOC}\n</document>', ai.runs[0][1])
        # The same mistake again, from another agent: disputed without a check.
        s.c = FakeValun(delivered(terms('docs-fix'), FIX.replace('It does not say', 'Nowhere does it say')))
        taken(s, 'docs-fix', payee='helper-2')
        s.review(ITEM)
        self.assertEqual(s.c.calls[0][0], 'dispute')
        self.assertIn('already reported', s.c.calls[0][1])
        self.assertEqual(len(ai.runs), 1)

    def test_refusal_and_checker_failures(self):
        s = buyer(delivered(terms('report'), REPORT), FakeAI({'content': None, 'refused': True, 'cost': 0.002, 'model': 'claude-opus-5-5'}))
        taken(s)
        s.review(ITEM)
        self.assertIn('declined to read this delivery', s.c.calls[0][1])
        s = buyer(delivered(terms('report'), REPORT), FakeAI(error=RuntimeError('overloaded')))
        taken(s)
        for _ in range(A.ATTEMPTS - 1):
            s.review(ITEM)
        self.assertEqual(s.c.calls, [], 'tried again on the next pass')
        s.review(ITEM)
        self.assertIn('My checker failed on this delivery several times', s.c.calls[0][1])

    def test_a_payment_that_failed_is_retried_without_a_second_check(self):
        ai = FakeAI(verdict('meets the terms'))
        s = buyer(delivered(terms('report'), REPORT, complete_fails=True), ai)
        taken(s)
        with self.assertRaises(vc.ValunError):
            s.review(ITEM)
        self.assertEqual(s.budget.s['wants'][DID]['verdict'], 'meets', 'the decision is kept')
        s.c.d.pop('complete_fails')
        s.c.d['status'] = 'payment_due'
        s.review(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['complete', 'complete'])
        self.assertEqual(len(ai.runs), 1)
        self.assertNotIn(DID, s.budget.s['wants'])

    def test_a_review_put_off_is_noted_once_an_hour(self):
        s = buyer(delivered(terms('report'), REPORT), FakeAI(verdict('meets the terms')), b=budget(monthly=0.0001, daily=0.0001))
        taken(s)
        for _ in range(3):
            s.review(ITEM)
        self.assertEqual([x['action'] for x in lines(s)], ['review_later'])
        self.assertEqual(s.c.calls, [])
        self.assertIn(DID, s.budget.s['wants'], 'kept for when the budget allows')

    def test_deals_it_did_not_take_are_left_alone(self):
        ai = FakeAI(verdict('does not meet the terms'))
        s = buyer(delivered(terms('report'), REPORT), ai)
        s.review(ITEM)                      # its owner's own purchase, say: not a want this seller took
        self.assertEqual(s.c.calls, [])
        self.assertEqual(ai.runs, [])

    def test_step_reviews_from_the_inbox(self):
        ai = FakeAI(verdict('meets the terms'))
        s = buyer(delivered(terms('report'), REPORT, box={'respond': [], 'deliver': [], 'review_delivery': [ITEM]}), ai)
        s.consents = lambda: None
        taken(s)
        s.step()
        self.assertEqual([c[0] for c in s.c.calls], ['complete'])


class Recorder(vc.Client):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def request(self, method, path, body=None, auth=True, token=None):
        self.calls.append((method, path, body))
        return {'participant': {'handle': 'x', 'wants': (body or {}).get('wants', '')}, 'changed': ['wants']}


class ProfileCalls(unittest.TestCase):
    def test_wants_are_sent_only_when_given(self):
        c = Recorder(vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME)), 'https://example.test')
        c.join_sandbox('tester', 'Ann', wants='reviews (2 PC)')
        c.join_sandbox('tester2', 'Ann')
        c.join('inv', 'tester3', 'Ann', wants='translations (2 PC)')
        c.join('inv', 'tester4', 'Ann')
        bodies = [b for _m, _p, b in c.calls]
        self.assertEqual(bodies[0]['wants'], 'reviews (2 PC)')
        self.assertNotIn('wants', bodies[1])
        self.assertEqual(bodies[2]['wants'], 'translations (2 PC)')
        self.assertNotIn('wants', bodies[3])
        c.set_profile(wants='')
        self.assertEqual(c.calls[-1], ('PUT', '/pilot/v1/profile', {'wants': ''}), 'an empty string clears it')
        with self.assertRaises(vc.ValunError) as e:
            c.set_profile()
        self.assertIn('wants', str(e.exception))


if __name__ == '__main__':
    unittest.main()
