"""Sandbox services are exact and reproducible (offline)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import sandbox as sb  # noqa: E402


class Services(unittest.TestCase):
    def test_extract_text(self):
        self.assertEqual(sb.extract_text('do this:\n```\nhello  world\nsecond line\n```\nthanks'), 'hello  world\nsecond line')
        self.assertEqual(sb.extract_text('```text\nx\n```'), 'x')
        self.assertIsNone(sb.extract_text('no fence here'))
        # what a real LLM agent wrote (Hermes via MCP, 2026-11-07): the text as the only quoted string
        self.assertEqual(sb.extract_text('text-stats analysis of: "Agents that can make promises need limits their owners set." - exact counts'),
                         'Agents that can make promises need limits their owners set.')
        self.assertEqual(sb.extract_text('stats please\nTEXT: line one\nline two'), 'line one\nline two')
        self.assertEqual(sb.extract_text('of “curly quoted”'), 'curly quoted')
        self.assertIsNone(sb.extract_text('compare "a" with "b"'))          # ambiguous: refuse rather than guess

    def test_text_stats_exact(self):
        r = sb.text_stats('The cat saw the dog.\nThe end')
        self.assertEqual(r['words'], 7)
        self.assertEqual(r['lines'], 2)
        self.assertEqual(r['characters'], 28)
        self.assertEqual(r['unique_words'], 5)                # the/The lower-cased: the, cat, saw, dog., end
        self.assertEqual(r['top_words'][0], ['the', 3])
        import hashlib
        self.assertEqual(r['sha256'], hashlib.sha256('The cat saw the dog.\nThe end'.encode('utf-8')).hexdigest())

    def test_unicode_and_empty(self):
        r = sb.text_stats('naïve café ☕')
        self.assertEqual((r['words'], r['characters']), (3, 12))
        self.assertEqual(sb.notary('naïve')['bytes'], 6)
        self.assertEqual(sb.text_stats('')['words'], 0)

    def test_render_parse_roundtrip(self):
        for svc in ('text-stats', 'notary'):
            res = sb.COMPUTE[svc]('a b c\nd')
            self.assertEqual(sb.parse_result(sb.render(svc, res)), res)

    def test_check_delivery(self):
        terms = {'service': {'title': 'text-stats job', 'description': 'text-stats for:\n```\nhello world hello\n```', 'deliverable': 'JSON'}}
        right = sb.render('text-stats', sb.text_stats('hello world hello'), 'hello world hello')
        self.assertTrue(sb.check_delivery(terms, right)['exact_result_matches'])
        wrong_result = dict(sb.text_stats('hello world hello'), words=4)
        bad = sb.check_delivery(terms, sb.render('text-stats', wrong_result, 'hello world hello'))
        self.assertFalse(bad['exact_result_matches'])
        self.assertEqual(bad['differs_in'], ['words'])
        self.assertEqual((bad['expected']['words'], bad['delivered']['words']), (3, 4))
        self.assertFalse(sb.check_delivery(terms, 'no json here')['exact_result_matches'])
        self.assertFalse(sb.check_delivery({'service': {'title': 'notary', 'description': 'no text'}}, right)['checked'])
        self.assertIsNone(sb.check_delivery({'service': {'title': 'write a poem'}}, right))

    def test_which_service(self):
        self.assertEqual(sb.which_service({'service': {'title': 'Text statistics please'}}), 'text-stats')
        self.assertEqual(sb.which_service({'service': {'description': 'SHA-256 of this'}}), 'notary')
        self.assertIsNone(sb.which_service({'service': {'title': 'write me a poem'}}))

    def test_the_text_to_work_on_names_no_service(self):
        # fix-inbox #12: a code review of code that calls hashlib.sha256 is not a notary job (valun 0.5.1 said it was and
        # advised disputing a good review); the service is named by the buyer's own words, never by the text.
        review = {'service': {'title': 'code-review', 'deliverable': 'bugs and fixes',
                              'description': 'Find bugs, risks and fixes.\n```python\nimport hashlib\nh = hashlib.sha256(b"x")\n```'}}
        self.assertIsNone(sb.which_service(review))
        self.assertIsNone(sb.check_delivery(review, '## Bugs\n1. none'))         # no exact check, so no dispute advice
        self.assertIsNone(sb.which_service({'service': {'title': 'hash', 'description': 'TEXT: notary sha256 word count'}}))
        self.assertIsNone(sb.which_service({'service': {'title': 'quote', 'description': 'say "notary"'}}))
        # the buyer's words still name it, with the text in a block, after TEXT: or quoted
        self.assertEqual(sb.which_service({'service': {'title': 'notary', 'description': '```\nhello\n```'}}), 'notary')
        self.assertEqual(sb.which_service({'service': {'description': 'notary of "The quick brown fox."'}}), 'notary')
        self.assertEqual(sb.which_service({'service': {'description': 'word count please\nTEXT: a b c'}}), 'text-stats')
        self.assertEqual(sb.which_service({'service': {'description': 'compare "notary" with "a"'}}), 'notary')   # two quotes: no text

    def test_request_words(self):
        self.assertEqual(sb.request_words('Review it:\n```\nsha256\n```\nthanks'), 'Review it:\n \nthanks')
        self.assertEqual(sb.request_words('stats please\nTEXT: line one'), 'stats please')
        self.assertEqual(sb.request_words('notary of "x y"'), 'notary of  ')
        self.assertEqual(sb.request_words('compare "a" with "b"'), 'compare "a" with "b"')
        self.assertEqual(sb.request_words(None), '')


if __name__ == '__main__':
    unittest.main()
