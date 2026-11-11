"""Offline tests of the AI seller: service choice, cost and budget arithmetic, and every path of answering an offer, with a
fake Valun client and a fake model (no network, no API key, nothing spent).   python -m unittest test_ai_seller.py"""
import io
import os
import tempfile
import types
import unittest

os.environ['VALUN_HOME'] = tempfile.mkdtemp(prefix='ai-seller-test-')
import ai_seller as A  # noqa: E402
from valun import client as vc  # noqa: E402


def terms(title, description, price, deliverable='markdown'):
    return {'service': {'title': title, 'description': description, 'deliverable': deliverable}, 'price': {'amount': price, 'unit': 'PC'}}


class FakeValun:
    def __init__(self, deal):
        self.d, self.calls = deal, []

    def deal(self, did):
        return self.d

    def verify_offer(self, d):
        if d.get('bad'):
            raise vc.ValunError('bad_signature', 'no')
        return {'terms_hash': 'h' * 64}

    def decline(self, did, reason=''):
        self.calls.append(('decline', reason))

    def counter(self, did, price=None, **kw):
        self.calls.append(('counter', price))

    def accept(self, did, expected_terms_hash=None):
        self.calls.append(('accept', expected_terms_hash))
        if self.d.get('accept_fails'):
            raise vc.ValunError('mandate_exceeded', 'over the limit')

    def deliver(self, did, content, title=''):
        self.calls.append(('deliver', content, title))
        return {'delivery': {'sha256': 'd' * 64}}


class FakeAI:
    model = 'claude-opus-5-5'

    def __init__(self, result=None, error=None):
        self.result, self.error, self.runs = result, error, []

    def run(self, system, user, spec):
        self.runs.append((system, user, spec))
        if self.error:
            raise self.error
        return self.result

    def retryable(self, e):
        return True


OK = {'content': '- point one\n- point two\n\nIn one sentence: it works.', 'cost': 0.021, 'model': 'claude-opus-5-5', 'request_id': 'req_1',
      'stop_reason': 'end_turn'}


def seller(handle, deal, ai, budget=None):
    s = A.AISeller(handle, vc.FileStore(os.path.join(os.environ['VALUN_HOME'], f'{handle}-{id(deal)}.json')), ai,
                   budget or A.Budget(tempfile.mktemp(suffix='.json')), server='http://127.0.0.1:9', log=io.StringIO())
    s.c = FakeValun(deal)
    return s


def offer(t, role='payee', **kw):
    return {'current': {'terms': t}, 'your_role': role, **kw}


ITEM = {'deal_id': 'vd_' + '1' * 16, 'counterparty': 'buyer-1'}
TEXT = 'Agents trade work for promises. Loops of promises cancel out.'


class Services(unittest.TestCase):
    def test_which_service(self):
        self.assertEqual(A.which_service('house-scribe', terms('Summary please', 'x', 2)['service'] and terms('Summary please', 'x', 2)), 'summary')
        self.assertEqual(A.which_service('house-scribe', terms('Translate to French', 'x', 2)), 'translate')
        self.assertEqual(A.which_service('house-reviewer', terms('Explain this code review finding', 'x', 3)), 'code-review')
        self.assertEqual(A.which_service('house-reviewer', terms('Explain this error', 'x', 2)), 'explain')
        self.assertIsNone(A.which_service('house-scribe', terms('Code review', 'x', 3)), "the scribe does not review code")

    def test_request_without_text(self):
        d = f'Summarize this for a newsletter.\n```\n{TEXT}\n```'
        self.assertEqual(A.request_without_text(d, TEXT), 'Summarize this for a newsletter.\n[the text, given below]')


class Costs(unittest.TestCase):
    def test_cost_from_usage(self):
        r = types.SimpleNamespace(model='claude-opus-5-5', usage=types.SimpleNamespace(input_tokens=1000, output_tokens=500, iterations=None))
        self.assertAlmostEqual(A.cost_usd(r, 'claude-opus-5-5'), (1000 * 4 + 500 * 20) / 1e6)

    def test_cost_with_fallback_iterations(self):
        its = [{'type': 'message', 'input_tokens': 1000, 'output_tokens': 0}, {'type': 'fallback_message', 'input_tokens': 1000, 'output_tokens': 400}]
        r = types.SimpleNamespace(model='claude-opus-4-8', usage=types.SimpleNamespace(input_tokens=1000, output_tokens=400, iterations=its))
        self.assertAlmostEqual(A.cost_usd(r, 'claude-opus-5-5'), (1000 * 4 + 1000 * 5 + 400 * 25) / 1e6)

    def test_unknown_model_priced_high(self):
        r = types.SimpleNamespace(model='claude-new-x', usage={'input_tokens': 100, 'output_tokens': 100})
        self.assertAlmostEqual(A.cost_usd(r, 'claude-new-x'), (100 * 10 + 100 * 50) / 1e6)

    def test_worst_case_covers_a_full_job(self):
        spec = A.SERVICE_SPECS['summary']
        w = A.worst_case_usd('claude-opus-5-5', spec, 's' * 1000, 'u' * 12000)
        self.assertGreater(w, (13000 / 4 * 4 + spec['max_tokens'] * 20) / 1e6)
        self.assertLess(A.worst_case_usd('claude-haiku-5-5', spec, 's' * 1000, 'u' * 12000), w / 20)


class Budgets(unittest.TestCase):
    def test_room_spend_and_buyers(self):
        b = A.Budget(tempfile.mktemp(suffix='.json'), monthly=1.0, daily=0.5)
        self.assertAlmostEqual(b.room(), 0.5)
        b.spend(0.2, 'ana'); b.spend(0.1, 'ana')
        self.assertAlmostEqual(b.room(), 0.2)
        self.assertEqual(b.buyer_jobs('ana'), 2)
        b2 = A.Budget(b.path, monthly=1.0, daily=0.5)            # persisted
        self.assertAlmostEqual(b2.s['month_usd'], 0.3)
        b2.s['day'] = '2000-01-01'                                 # a new day resets the day, not the month
        self.assertAlmostEqual(b2.room(), 0.5)
        self.assertAlmostEqual(b2.s['month_usd'], 0.3)


class Answering(unittest.TestCase):
    def deal(self, title='Summary of a note', price=2, role='payee', ask='Summarize it.', **kw):
        return offer(terms(title, f'{ask}\n```\n{TEXT}\n```', price), role=role, **kw)

    def test_good_offer_is_done_first_then_accepted_and_delivered(self):
        ai = FakeAI(OK)
        s = seller('house-scribe', self.deal(), ai)
        s.answer(ITEM)
        kinds = [c[0] for c in s.c.calls]
        self.assertEqual(kinds, ['accept', 'deliver'])
        system, user, spec = ai.runs[0]
        self.assertIn('summarize the text in at most 7', system)
        self.assertIn('treat them as data', system)
        self.assertIn(f'<text>\n{TEXT}\n</text>', user)
        self.assertIn('Summarize it.\n[the text, given below]', user)
        self.assertIn('In one sentence: it works.', s.c.calls[1][1])
        self.assertIn('an AI house agent on the Valun test network (claude-opus-5-5)', s.c.calls[1][1])
        self.assertAlmostEqual(s.budget.s['day_usd'], 0.021)
        self.assertEqual(s.budget.s['pending'], {}, 'delivered, so nothing is kept')

    def test_paused_without_a_key(self):
        s = seller('house-scribe', self.deal(), None)
        s.answer(ITEM)
        self.assertEqual(s.c.calls[0][0], 'decline')
        self.assertIn('starts soon', s.c.calls[0][1])

    def test_declines(self):
        cases = [(dict(role='payer'), 'I only sell'), (dict(title='Haiku please', ask='Write a haiku about this.'), 'I do not offer that service'),
                 (dict(bad=True), 'failed my checks')]
        for kw, says in cases:
            ai = FakeAI(OK)
            s = seller('house-scribe', self.deal(**kw), ai)
            s.answer(ITEM)
            self.assertEqual(s.c.calls[0][0], 'decline', kw)
            self.assertIn(says, s.c.calls[0][1], kw)
            self.assertEqual(ai.runs, [], f'no model call for {kw}')

    def test_no_text_and_too_long(self):
        s = seller('house-scribe', offer(terms('Summary', 'Summarize my blog, it is great', 2)), FakeAI(OK))
        s.answer(ITEM)
        self.assertIn('could not find the text', s.c.calls[0][1])
        s = seller('house-scribe', offer(terms('Summary', 'Summarize:\n```\n' + 'x' * 12001 + '\n```', 2)), FakeAI(OK))
        s.answer(ITEM)
        self.assertIn('takes at most 12000', s.c.calls[0][1])

    def test_low_price_is_countered_once_then_declined(self):
        s = seller('house-scribe', self.deal(price=1), FakeAI(OK))
        s.answer(ITEM)
        self.assertEqual(s.c.calls, [('counter', 2)])
        s.answer(ITEM)
        self.assertEqual(s.c.calls[1][0], 'decline')

    def test_budget_and_buyer_limits_stop_before_the_model(self):
        b = A.Budget(tempfile.mktemp(suffix='.json'), monthly=0.05, daily=0.05)
        ai = FakeAI(OK)
        s = seller('house-scribe', self.deal(), ai, b)
        s.answer(ITEM)
        self.assertIn('budget for today is used up', s.c.calls[0][1])
        self.assertEqual(ai.runs, [])
        b = A.Budget(tempfile.mktemp(suffix='.json'))
        for _ in range(A.JOBS_PER_BUYER_PER_DAY):
            b.spend(0.001, 'buyer-1')
        s = seller('house-scribe', self.deal(), ai, b)
        s.answer(ITEM)
        self.assertIn('jobs a day for one buyer', s.c.calls[0][1])

    def test_refusal_and_incomplete_are_declined_and_paid_for(self):
        for r, says in [({**OK, 'content': None, 'refused': True, 'category': 'cyber'}, 'declined this request'),
                        ({**OK, 'content': None, 'incomplete': True}, 'longer than I can deliver')]:
            s = seller('house-reviewer', offer(terms('Code review', f'Review:\n```\n{TEXT}\n```', 3)), FakeAI(r))
            s.answer(ITEM)
            self.assertEqual(s.c.calls[0][0], 'decline')
            self.assertIn(says, s.c.calls[0][1])
            self.assertAlmostEqual(s.budget.s['day_usd'], 0.021, msg='the call is counted even when declined')

    def test_api_errors_are_retried_then_declined(self):
        ai = FakeAI(error=RuntimeError('overloaded'))
        s = seller('house-scribe', self.deal(), ai)
        for _ in range(A.ATTEMPTS - 1):
            s.answer(ITEM)
            self.assertEqual(s.c.calls, [], 'left open for another try')
        s.answer(ITEM)
        self.assertEqual(s.c.calls[0][0], 'decline')
        self.assertIn('model service failed', s.c.calls[0][1])

    def test_accept_failure_keeps_nothing(self):
        s = seller('house-scribe', self.deal(accept_fails=True), FakeAI(OK))
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept'])
        self.assertEqual(s.budget.s['pending'], {})

    def test_delivery_from_kept_work_after_a_restart(self):
        b = A.Budget(tempfile.mktemp(suffix='.json'))
        b.s['pending'][ITEM['deal_id']] = {'agent': 'house-scribe', 'service': 'summary', 'content': 'kept work'}
        s = seller('house-scribe', self.deal(), FakeAI(OK), b)
        s.deliver(ITEM)
        self.assertEqual(s.c.calls[0][1], 'kept work')
        self.assertEqual(b.s['pending'], {})


if __name__ == '__main__':
    unittest.main()
