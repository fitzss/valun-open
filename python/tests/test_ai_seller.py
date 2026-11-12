"""valun.ai_seller and `valun sell` / `valun profile`, offline: service choice, cost and budget arithmetic, every path of
answering an offer with a fake Valun client and a fake model, the client calls for the profile, and the CLI's refusals
before anything runs (no network, no API key, nothing spent; the Anthropic SDK is not needed)."""
import io
import json
import os
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

from valun import ai_seller as A
from valun import cli
from valun import client as vc

HOME = tempfile.mkdtemp(prefix='valun-ai-seller-test-')


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
        if self.d.get('deliver_fails'):
            raise vc.ValunError('not_agreed', 'waits for the owner')
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


OK = {'content': '- one\n- two\n\nIn one sentence: it works.', 'cost': 0.021, 'model': 'claude-opus-5-5', 'request_id': 'req_1',
      'stop_reason': 'end_turn'}
ITEM = {'deal_id': 'vd_' + '1' * 16, 'counterparty': 'buyer-1'}
TEXT = 'Agents trade work for promises. Loops of promises cancel out.'


def budget(**kw):
    return A.Budget(tempfile.mktemp(suffix='.json', dir=HOME), kw.get('monthly', 18), kw.get('daily', 1))


def seller(deal, ai, services=('summary', 'rewrite', 'translate'), b=None, **kw):
    s = A.AISeller(vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME)), services, ai, b or budget(), handle='my-seller',
                   server='http://127.0.0.1:9', log=io.StringIO(), **kw)
    s.c = FakeValun(deal)
    return s


def offer(t, role='payee', **kw):
    return {'current': {'terms': t}, 'your_role': role, **kw}


def summary_deal(title='Summary of a note', price=2, role='payee', ask='Summarize it.', **kw):
    return offer(terms(title, f'{ask}\n```\n{TEXT}\n```', price), role=role, **kw)


class Services(unittest.TestCase):
    def test_parse_services(self):
        self.assertEqual(A.parse_services(' Summary , code-review,summary'), ('summary', 'code-review'))
        for bad in ('', 'haiku', 'summary,haiku'):
            with self.assertRaises(ValueError):
                A.parse_services(bad)

    def test_which_service(self):
        both = ('summary', 'translate', 'code-review', 'explain')
        self.assertEqual(A.which_service(both, terms('Summary please', 'x', 2)), 'summary')
        self.assertEqual(A.which_service(both, terms('Translate to French', 'x', 2)), 'translate')
        self.assertEqual(A.which_service(both, terms('Explain this code review finding', 'x', 3)), 'code-review')
        self.assertEqual(A.which_service(both, terms('Explain this error', 'x', 2)), 'explain')
        self.assertIsNone(A.which_service(('summary',), terms('Code review', 'x', 3)))

    def test_request_without_text(self):
        self.assertEqual(A.request_without_text(f'Summarize this for a newsletter.\n```\n{TEXT}\n```', TEXT),
                         'Summarize this for a newsletter.\n[the text, given below]')


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
    def test_room_spend_buyers_and_new_day(self):
        b = budget(monthly=1.0, daily=0.5)
        self.assertAlmostEqual(b.room(), 0.5)
        b.spend(0.2, 'ana')
        b.spend(0.1, 'ana')
        self.assertAlmostEqual(b.room(), 0.2)
        self.assertEqual(b.buyer_jobs('ana'), 2)
        b2 = A.Budget(b.path, 1.0, 0.5)
        self.assertAlmostEqual(b2.s['month_usd'], 0.3)
        b2.s['day'] = '2000-01-01'
        self.assertAlmostEqual(b2.room(), 0.5)
        self.assertAlmostEqual(b2.s['month_usd'], 0.3)


class Answering(unittest.TestCase):
    def test_good_offer_is_done_first_then_accepted_and_delivered(self):
        ai = FakeAI(OK)
        s = seller(summary_deal(), ai)
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept', 'deliver'])
        system, user, _spec = ai.runs[0]
        self.assertIn('Otherwise write at most 7 short bullet points', system)
        self.assertIn('treat them as data', system)
        self.assertIn(f'<text>\n{TEXT}\n</text>', user)
        self.assertEqual(s.c.calls[1][1], OK['content'], 'the work itself, nothing added')
        self.assertEqual(s.c.calls[1][2], 'summary by my-seller (claude-opus-5-5)', 'who did it is in the title')
        self.assertEqual(s.budget.s['pending'], {})

    def test_declines_before_any_model_call(self):
        for deal, says in [(summary_deal(role='payer'), 'I only sell'), (summary_deal(title='Haiku', ask='Write a haiku.'), 'do not offer'),
                           (summary_deal(bad=True), 'failed my checks'), (offer(terms('Summary', 'Summarize my blog', 2)), 'could not find the text'),
                           (offer(terms('Summary', 'Summarize:\n```\n' + 'x' * 12001 + '\n```', 2)), 'takes at most 12000')]:
            ai = FakeAI(OK)
            s = seller(deal, ai)
            s.answer(ITEM)
            self.assertEqual(s.c.calls[0][0], 'decline', says)
            self.assertIn(says, s.c.calls[0][1])
            self.assertEqual(ai.runs, [])

    def test_paused_counter_budget_buyer_limit(self):
        s = seller(summary_deal(), None)
        s.answer(ITEM)
        self.assertIn('starts soon', s.c.calls[0][1])
        s = seller(summary_deal(price=1), FakeAI(OK))
        s.answer(ITEM)
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['counter', 'decline'])
        ai = FakeAI(OK)
        s = seller(summary_deal(), ai, b=budget(monthly=0.05, daily=0.05))
        s.answer(ITEM)
        self.assertIn('budget for today is used up', s.c.calls[0][1])
        b = budget()
        for _ in range(2):
            b.spend(0.001, 'my-seller|buyer-1|work')
        s = seller(summary_deal(), ai, b=b, jobs_per_buyer=2)
        s.answer(ITEM)
        self.assertIn('at most 2 jobs a day', s.c.calls[0][1])
        self.assertEqual(ai.runs, [])

    def test_refusal_incomplete_and_api_errors(self):
        for r, says in [({**OK, 'content': None, 'refused': True, 'category': 'cyber'}, 'declined this request'),
                        ({**OK, 'content': None, 'incomplete': True}, 'longer than I can deliver')]:
            s = seller(offer(terms('Code review', f'Review:\n```\n{TEXT}\n```', 3)), FakeAI(r), services=('code-review',))
            s.answer(ITEM)
            self.assertIn(says, s.c.calls[0][1])
            self.assertAlmostEqual(s.budget.s['day_usd'], 0.021)
        s = seller(summary_deal(), FakeAI(error=RuntimeError('overloaded')))
        for _ in range(A.ATTEMPTS - 1):
            s.answer(ITEM)
        self.assertEqual(s.c.calls, [])
        s.answer(ITEM)
        self.assertIn('model service failed', s.c.calls[0][1])

    def test_accept_failure_keeps_nothing_and_a_held_acceptance_delivers_later(self):
        s = seller(summary_deal(accept_fails=True), FakeAI(OK))
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept'])
        self.assertEqual(s.budget.s['pending'], {})
        s = seller(summary_deal(deliver_fails=True), FakeAI(OK))
        s.answer(ITEM)                                   # accepted, but the deal waits for the owner: the work is kept
        self.assertIn(ITEM['deal_id'], s.budget.s['pending'])
        s.c.d.pop('deliver_fails')
        s.deliver(ITEM)                                  # once agreed, the inbox lists it to deliver: from the kept work
        self.assertEqual(s.c.calls[-1][1], s.c.calls[1][1])
        self.assertEqual(s.budget.s['pending'], {})


class Recorder(vc.Client):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    def request(self, method, path, body=None, auth=True, token=None):
        self.calls.append((method, path, body))
        return {'participant': {'handle': 'x'}, 'changed': ['services']}


class ClientCalls(unittest.TestCase):
    def test_join_sandbox_sends_services_only_when_given(self):
        c = Recorder(vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME)), 'https://example.test')
        c.join_sandbox('tester', 'Ann', services='haiku (2 PC)')
        self.assertEqual(c.calls[0][2]['services'], 'haiku (2 PC)')
        c.join_sandbox('tester2', 'Ann')
        self.assertNotIn('services', c.calls[1][2])

    def test_set_profile(self):
        c = Recorder(vc.FileStore(tempfile.mktemp(suffix='.json', dir=HOME)), 'https://example.test')
        c.set_profile(services='summary (2 PC)')
        self.assertEqual(c.calls, [('PUT', '/pilot/v1/profile', {'services': 'summary (2 PC)'})])
        with self.assertRaises(vc.ValunError):
            c.set_profile()


class Cli(unittest.TestCase):
    def run_cli(self, *argv, env=None):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'VALUN_HOME': tempfile.mkdtemp(dir=HOME), **(env or {})}), redirect_stdout(out):
            if 'ANTHROPIC_API_KEY' not in (env or {}):
                os.environ.pop('ANTHROPIC_API_KEY', None)
            rc = cli.main(list(argv))
        return rc, out.getvalue()

    def test_sell_refuses_before_anything_runs(self):
        rc, out = self.run_cli('sell', '--services', 'summary')
        self.assertEqual(rc, 1)
        self.assertIn('not joined yet', out)

    def test_sell_bad_services_and_missing_key(self):
        joined = types.SimpleNamespace(state={'participant_id': 'vp_000000000001', 'server': 'http://127.0.0.1:9'}, secret=lambda: 'x')
        with mock.patch.object(cli, '_store', return_value=joined):
            rc, out = self.run_cli('sell', '--services', 'haiku')
            self.assertEqual(rc, 2)
            self.assertIn('comma-separated list of', out)
            rc, out = self.run_cli('sell', '--services', 'summary')
            self.assertEqual(rc, 2)
            self.assertIn('Set ANTHROPIC_API_KEY', out)

    def test_profile_needs_a_joined_profile(self):
        rc, out = self.run_cli('profile', '--services', 'x')
        self.assertEqual(rc, 1)
        self.assertIn('not joined yet', out)

    def test_help_names_the_services(self):
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(['sell', '--help'])
        self.assertIn('summary, rewrite, translate, code-review, explain', ' '.join(out.getvalue().split()))


if __name__ == '__main__':
    unittest.main()


class PaidCheck(unittest.TestCase):
    def test_check_is_chosen_and_reads_every_block(self):
        services = ('code-review', 'explain', 'check')
        self.assertEqual(A.which_service(services, terms('Check a delivery', 'x', 2)), 'check')
        self.assertEqual(A.which_service(services, terms('Please verify the work', 'x', 2)), 'check')
        ai = FakeAI({**OK, 'content': 'Verdict: meets the terms\n- ok'})
        desc = 'Check this delivery against its terms.\nTERMS:\n```\nthree bullet points\n```\nDELIVERY:\n```\n- a\n- b\n- c\n```'
        s = seller(offer(terms('Check a delivery', desc, 2)), ai, services=services)
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept', 'deliver'])
        system, user, spec = ai.runs[0]
        self.assertIn('Judge whether the delivery meets the terms', system)
        self.assertIn('<text>\nthree bullet points\n\n- a\n- b\n- c\n</text>', user)
        self.assertEqual(spec['price'], 2)


class ChecksAndReceipts(unittest.TestCase):
    def test_checks_have_their_own_allowance(self):
        b = budget()
        for _ in range(3):
            b.spend(0.001, 'my-seller|buyer-1|work')              # the day's jobs are used up...
        ai = FakeAI({**OK, 'content': 'Verdict: meets the terms\n- fine'})
        desc = 'Check this delivery.\n```\nTERMS: two bullets\n\n- a\n- b\n```'
        s = seller(offer(terms('Check a delivery', desc, 2)), ai, services=('code-review', 'check'), b=b)
        s.answer(ITEM)                                            # ...but a check is still taken
        self.assertEqual([c[0] for c in s.c.calls], ['accept', 'deliver'])
        self.assertEqual(b.buyer_jobs('my-seller|buyer-1|check'), 1)
        for _ in range(5):
            b.spend(0.001, 'my-seller|buyer-1|check')
        s2 = seller(offer(terms('Check a delivery', desc, 2)), FakeAI(OK), services=('check',), b=b)
        s2.answer(ITEM)
        self.assertIn('at most 6 checks a day', s2.c.calls[0][1])

    def test_a_check_ends_with_its_receipt(self):
        import hashlib
        ai = FakeAI({**OK, 'content': 'Verdict: does not meet the terms\n- three bullets, not five'})
        checked = 'TERMS: five bullets\n\n- a\n- b\n- c'
        s = seller(offer(terms('Check a delivery', f'Check it.\n```\n{checked}\n```', 2)), ai, services=('check',))
        s.answer(ITEM)
        content = s.c.calls[1][1]
        self.assertTrue(content.startswith('Verdict: does not meet the terms'))
        receipt = json.loads(content.split('```json\n', 1)[1].split('\n```', 1)[0])
        self.assertEqual(receipt, {'service': 'check', 'check_deal_id': ITEM['deal_id'], 'verdict': 'does_not_meet',
                                   'checked_by': 'my-seller', 'model': 'claude-opus-5-5',
                                   'checked_text_sha256': hashlib.sha256(checked.encode('utf-8')).hexdigest()})
        self.assertEqual(s.c.calls[1][2], 'check by my-seller (claude-opus-5-5)')

    def test_verdict_codes(self):
        self.assertEqual([A.verdict_of(t) for t in ('Verdict: meets the terms', "Verdict: doesn't meet the terms",
                                                     'Verdict: does not meet the terms', 'Verdict: unclear', '')],
                         ['meets', 'does_not_meet', 'does_not_meet', 'unclear', 'unclear'])


class Testnet(unittest.TestCase):
    # 0.5.1: on the testnet network the seller's PC-sized prices are in nanoERG (x 1,000,000), in its checks, its counter
    # offers and its words; on the pilot (a client without a scale) nothing changes.
    def _seller(self, deal, ai):
        s = seller(deal, ai, services=('summary',))
        s.c.unit, s.c.scale, s.c.network = 'nanoERG', 1_000_000, 'valun-testnet-1'
        return s

    def test_prices_counters_and_words_in_nanoerg(self):
        s = self._seller(summary_deal(price=1_000_000), FakeAI(OK))
        s.answer(ITEM)
        s.answer(ITEM)
        self.assertEqual(s.c.calls[0], ('counter', 2_000_000))
        self.assertEqual(s.c.calls[1], ('decline', 'My price for summary is 2000000 nanoERG (0.002 tERG).'))
        s = self._seller(summary_deal(price=2), FakeAI(OK))
        s.answer(ITEM)
        self.assertEqual(s.c.calls[0], ('counter', 2_000_000), 'a PC-sized offer is far below the price in nanoERG')
        s = self._seller(summary_deal(price=2_000_000), FakeAI(OK))
        s.answer(ITEM)
        self.assertIn('accept', [c[0] for c in s.c.calls])
        s = self._seller(offer(terms('Haiku please', 'x', 2_000_000)), FakeAI(OK))
        s.answer(ITEM)
        self.assertIn('summary (2000000 nanoERG (0.002 tERG)): up to 7 bullets', s.c.calls[0][1])

    def test_the_texts(self):
        self.assertTrue(A.services_text(('summary', 'code-review'), 'nanoERG', 1_000_000).startswith(
            'summary (2000000 nanoERG (0.002 tERG)): '))
        self.assertIn('code-review (3000000 nanoERG (0.003 tERG)): ', A.services_text(('summary', 'code-review'), 'nanoERG', 1_000_000))
        self.assertIn('check (2000000 nanoERG (0.002 tERG)): does a delivery', A.services_text(('check',), 'nanoERG', 1_000_000))
        self.assertEqual(A.services_text(('summary',)), A.SERVICE_SPECS['summary']['blurb'], 'the pilot: as is')
        wants = {'docs': {'blurb': 'docs fixes (3 PC): a fix to the README'}}
        self.assertEqual(A.wants_text(wants, 'nanoERG', 1_000_000), 'docs fixes (3000000 nanoERG (0.003 tERG)): a fix to the README')
        self.assertEqual(A.wants_text(wants), 'docs fixes (3 PC): a fix to the README')


class FixInbox(unittest.TestCase):
    """Findings from the fix inbox (fitzss/valun-fix-inbox): #11 a check titled "check" was declined as an unknown service,
    #2 a closing fence at the end of the last line hid the text, #7 a summary always added a gist, #3 receipts name the deal."""
    REVIEWER = ('code-review', 'explain', 'check')

    def test_a_title_that_names_the_service(self):
        for title in ('check', 'Check', 'check: does it meet its terms?', 'Check - a parser', 'check (delivery)'):
            self.assertEqual(A.which_service(self.REVIEWER, terms(title, 'x', 2)), 'check', title)
        self.assertEqual(A.which_service(self.REVIEWER, terms('code-review', 'x', 3)), 'code-review')
        self.assertEqual(A.which_service(self.REVIEWER, terms('Explain this code review finding', 'x', 3)), 'code-review')
        self.assertIsNone(A.which_service(('summary',), terms('check', 'x', 2)), 'a service the seller does not offer')
        # the catalog's own words name it too
        catalog = 'does a delivery meet its terms? A verdict and the reasons, for the terms and the work you paste.'
        self.assertEqual(A.which_service(self.REVIEWER, terms('Quality', catalog, 2)), 'check')

    def test_the_text_to_work_on_names_no_service(self):
        self.assertIsNone(A.which_service(self.REVIEWER, terms('Help', 'Please.\n```\nverify the work, check the delivery\n```', 2)))

    def test_the_three_declined_check_offers_are_taken(self):
        ai = FakeAI({**OK, 'content': 'Verdict: meets the terms\n- fine'})
        for desc in ('Check a small Python function for correctness.\n```python\ndef add(a, b):\n    return a + b\n```',
                     'A delivery-check: does a delivery meet its terms?\nTERMS:\n```\nreturn the sum\n```\nDELIVERY:\n```\ndef add(a, b): return a + b\n```',
                     'does a delivery meet its terms? A verdict and the reasons.\n```\nTerms: 3 bullets\n- a\n- b\n- c\n```'):
            s = seller(offer(terms('check', desc, 2)), ai, services=self.REVIEWER)
            s.answer(ITEM)
            self.assertEqual([c[0] for c in s.c.calls], ['accept', 'deliver'], desc)

    def test_a_closing_fence_at_the_end_of_the_last_line(self):
        ai = FakeAI({**OK, 'content': 'Verdict: meets the terms\n- ok'})
        s = seller(offer(terms('Check a delivery', 'Check it.\n```\nTERMS: two bullets\n- a\n- b```', 2)), ai, services=('check',))
        s.answer(ITEM)
        self.assertEqual([c[0] for c in s.c.calls], ['accept', 'deliver'])
        self.assertIn('<text>\nTERMS: two bullets\n- a\n- b\n</text>', ai.runs[0][1])
        self.assertEqual(A.job_text('summary', 'Sum:\n```\nline one\nline two\n```\nthanks'), 'line one\nline two')
        self.assertEqual(A.job_text('summary', 'Sum:\n```\nline one```'), 'line one')
        self.assertEqual(A.job_text('summary', 'summary of "a quoted text"'), 'a quoted text')
        self.assertEqual(A.job_text('check', '```\nterms\n```\nand\n```\nwork\n```'), 'terms\n\nwork')

    def test_a_summary_follows_the_format_the_terms_set(self):
        task = A.SERVICE_SPECS['summary']['task']
        self.assertIn('sets a format', task)
        self.assertIn('follow it exactly and add nothing it does not allow', task)
        self.assertIn('Otherwise write at most 7 short bullet points, then one line that begins "In one sentence:"', task)

    def test_the_decline_says_how_to_name_the_service(self):
        s = seller(offer(terms('Haiku', 'x', 2)), FakeAI(OK), services=self.REVIEWER)
        s.answer(ITEM)
        self.assertIn('Name the service as the first word of the title (for example "code-review: ...")', s.c.calls[0][1])
        self.assertLessEqual(len(s.c.calls[0][1]), 480)
