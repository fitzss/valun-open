"""Offline checks of the deterministic delivery measurements (no network: the DNS resolver is replaced)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from valun import measure  # noqa: E402

TERMS = 'Research brief. 300-500 word research brief with at least 3 cited sources each with a working-looking link'


class Requirements(unittest.TestCase):
    def test_range_and_links(self):
        self.assertEqual(measure.requirements(TERMS), {'min_words': 300, 'max_words': 500, 'min_links': 3})

    def test_other_phrasings(self):
        # 'under 400 words' means fewer than 400 (fix-inbox #1), as do 'fewer than' and 'less than'
        self.assertEqual(measure.requirements('markdown, under 400 words, at least 2 links'), {'max_words': 399, 'min_links': 2})
        self.assertEqual(measure.requirements('fewer than 50 words'), {'max_words': 49})
        self.assertEqual(measure.requirements('less than 50 words'), {'max_words': 49})
        self.assertEqual(measure.requirements('no more than 50 words'), {'max_words': 50})
        self.assertEqual(measure.requirements('at least 150 words'), {'min_words': 150})
        self.assertEqual(measure.requirements('no fewer than 300 words'), {'min_words': 300})
        self.assertEqual(measure.requirements('No less than 250 words, at most 400 words'), {'min_words': 250, 'max_words': 400})
        self.assertEqual(measure.requirements('300\u2013500 words'), {'min_words': 300, 'max_words': 500})
        self.assertEqual(measure.requirements('a short note'), {})

    def test_per_item_limits(self):
        # fix-inbox #1: a limit on each bullet is measured per bullet, never as a limit on the whole delivery
        live = ('Summary: exactly 3 bullets Summarize the text below in exactly 3 bullet points. Each bullet must be under '
                '15 words. Output only the 3 bullets, nothing else. markdown, exactly 3 bullets, each bullet under 15 words, no other text')
        self.assertEqual(measure.requirements(live), {'max_words_per_item': 14})
        self.assertEqual(measure.requirements('exactly 3 bullets, each under 15 words, no other text'), {'max_words_per_item': 14})
        self.assertEqual(measure.requirements('Each bullet must be at most 20 words.'), {'max_words_per_item': 20})
        self.assertEqual(measure.requirements('3 bullets, 12 words each'), {'max_words_per_item': 12})
        self.assertEqual(measure.requirements('every line under 9 words'), {'max_words_per_item': 8})
        self.assertEqual(measure.requirements('per bullet at most 8 words'), {'max_words_per_item': 8})
        self.assertEqual(measure.requirements('at most 100 words in total, each bullet under 15 words'),
                         {'max_words_per_item': 14, 'max_words': 100})
        self.assertEqual(measure.requirements('reach under 5 words'), {'max_words': 4}, '"each" inside a word is not "each"')

    def test_quoted_text_holds_no_requirement(self):
        # a check's description pastes the original terms in a ``` block: they are not the check's own terms
        self.assertEqual(measure.requirements('Check a delivery.\n```\nTerms: under 20 words, at least 3 links\nWork: x\n```\nverdict'), {})
        self.assertEqual(measure.requirements('300-500 words about this:\n```\nunder 20 words\n```'), {'min_words': 300, 'max_words': 500})


class Measure(unittest.TestCase):
    fake = staticmethod(lambda h: 'not_found' if h.endswith('.invalid') else 'public')

    def test_counts_and_checks(self):
        text = ('word ' * 481) + ' See https://example.org/a, https://example.com/b and (https://made-up.invalid/c).'
        m = measure.measure(text, TERMS, resolver=self.fake)
        self.assertEqual(m['links'], ['https://example.org/a', 'https://example.com/b', 'https://made-up.invalid/c'])
        self.assertTrue(all(c['met'] for c in m['checks_against_agreed_terms']))
        self.assertEqual(m['link_hosts']['made-up.invalid'], 'not_found')
        self.assertIn('made-up.invalid', m['warning'])

    def test_word_count_ignores_markdown_rules(self):
        self.assertEqual(measure.word_count('Title\n=====\n\nOne two-three, four.\n---'), 4)

    def test_each_item_is_measured(self):
        d = '- one two three four\n- five six seven\n\nIn one sentence: a gist line that is longer than the bullets.'
        c = measure.measure(d, '2 bullets, each under 5 words', check_hosts=False)['checks_against_agreed_terms']
        self.assertEqual(c, [{'requirement': 'at most 4 words in each bullet or line', 'measured': '2 items of 4, 3 words', 'met': True}])
        c = measure.measure(d, '2 bullets, each under 4 words', check_hosts=False)['checks_against_agreed_terms']
        self.assertEqual([x['met'] for x in c], [False])
        c = measure.measure('1. alpha beta\n2) gamma', 'each item at most 2 words', check_hosts=False)['checks_against_agreed_terms']
        self.assertEqual(c[0]['measured'], '2 items of 2, 1 words', 'the numbers of a numbered list are not words')
        c = measure.measure('A paragraph of five words.\n\nTwo words.', 'each line under 6 words', check_hosts=False)['checks_against_agreed_terms']
        self.assertEqual((c[0]['measured'], c[0]['met']), ('2 items of 5, 2 words', True))
        c = measure.measure('', 'each under 4 words', check_hosts=False)['checks_against_agreed_terms']
        self.assertEqual((c[0]['measured'], c[0]['met']), ('no items', False))

    def test_too_long(self):
        m = measure.measure('word ' * 575, TERMS, check_hosts=False)
        self.assertEqual([c['met'] for c in m['checks_against_agreed_terms']], [False, False])
        self.assertNotIn('link_hosts', m)


if __name__ == '__main__':
    unittest.main()


class Links(unittest.TestCase):
    def test_parentheses(self):
        t = ('See https://en.wikipedia.org/wiki/Decentralized_finance_(cryptocurrency)). And (https://bitcoin.org/bitcoin.pdf), '
             'plus [paper](https://arxiv.org/abs/2103.06749).')
        self.assertEqual(measure.links(t), ['https://en.wikipedia.org/wiki/Decentralized_finance_(cryptocurrency)',
                                            'https://bitcoin.org/bitcoin.pdf', 'https://arxiv.org/abs/2103.06749'])
