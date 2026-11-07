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
        self.assertEqual(r['unique_words'], 5)                # the/The case-folded: the, cat, saw, dog., end
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

    def test_which_service(self):
        self.assertEqual(sb.which_service({'service': {'title': 'Text statistics please'}}), 'text-stats')
        self.assertEqual(sb.which_service({'service': {'description': 'SHA-256 of this'}}), 'notary')
        self.assertIsNone(sb.which_service({'service': {'title': 'write me a poem'}}))


if __name__ == '__main__':
    unittest.main()
