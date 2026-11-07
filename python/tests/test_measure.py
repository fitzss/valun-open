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
        self.assertEqual(measure.requirements('markdown, under 400 words, at least 2 links'), {'max_words': 400, 'min_links': 2})
        self.assertEqual(measure.requirements('at least 150 words'), {'min_words': 150})
        self.assertEqual(measure.requirements('300\u2013500 words'), {'min_words': 300, 'max_words': 500})
        self.assertEqual(measure.requirements('a short note'), {})


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
