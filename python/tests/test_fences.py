"""valun.fences (fix inbox #70): fenced blocks read as CommonMark reads them. Backtick and tilde fences, longer fences
around text that holds ``` fences, info strings, indentation, unclosed blocks reported as such, the closing fence at the
end of the last line (fix inbox #2), and the blocks of valun 0.7.0 (fences.LEGACY) for every plain ``` text."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))

from valun import fences as F  # noqa: E402

T = '`' * 3
# Plain ``` texts: fences on lines of their own (or closing at the end of the last line, fix inbox #2), nothing nested.
PLAIN = [
    f'Sum:\n{T}\nline one\nline two\n{T}\nthanks', f'Sum:\n{T}\nline one{T}', f'{T}\nterms\n{T}\nand\n{T}\nwork\n{T}',
    f'Check it.\n{T}\nTERMS: two bullets\n- a\n- b{T}', f'Review:\n{T}python\ndef add(a, b):\n    return a + b\n{T}',
    f'x\n{T}\n{T}', f'x\n{T}\n\n{T}', f'x\n{T}\n\n\n{T}', f'{T}\nA\n{T}  \nB', f'{T}\nA\n{T}\t\n', f'{T}\nA b {T}\nrest',
    f'Check this delivery.\nTERMS:\n{T}\nthree bullet points\n{T}\nDELIVERY:\n{T}\n- a\n- b\n- c\n{T}',
    f'Check whether the work meets the terms.\n{T}\nTERMS: five bullets\n{T}\n{T}\nThe parser.\n- a\n{T}',
    f'{T}text\nx\n{T}', f'a {T}inline{T} mention\n{T}\nreal\n{T}', f'Summarize this for a newsletter.\n{T}\nAgents.\n{T}',
    '', 'no fence here', 'summary of "a quoted text"', 'stats please\nTEXT: line one\nline two',
    # closed at the end of a last line that ends in inline code: the code's closing backtick is the text's
    f'Explain this line:\n{T}\nRun `make test`{T}', f'{T}\nterms: use `-v`{T}\n{T}\nwork: I used `-v`{T}', f'{T}\nuse ``x``{T}',
    f'Check:\n{T}\nTERMS: one line\n{T}\n{T}\nRun the tests with `make test`{T}',
]


def contents(text):
    return [b.content for b in F.blocks(text)]


class Fences(unittest.TestCase):
    def test_plain_backtick_blocks_are_those_of_0_7_0(self):
        for text in PLAIN:
            self.assertEqual(contents(text), F.legacy_blocks(text), repr(text))
            self.assertTrue(all(b.closed for b in F.blocks(text)), repr(text))

    def test_a_tilde_or_longer_fence_wraps_text_that_holds_backtick_fences(self):
        terms = f'title: summary\ndescription: Summarize in one sentence:\n{T}\nThe fox.\n{T}\ndeliverable: one sentence'
        for fence in ('~~~', '````', '~~~~~', '`' * 7):
            text = f'TERMS:\n{fence}\n{terms}\n{fence}\nWORK:\n{fence}\nA fox.\n{fence}'
            self.assertEqual(contents(text), [terms, 'A fox.'], fence)
        # ...where a ``` fence splits it (fences.LEGACY splits it the same way: three pieces, the sentence lost).
        nested = f'TERMS:\n{T}\n{terms}\n{T}\nWORK:\n{T}\nA fox.\n{T}'
        self.assertEqual(contents(nested), ['title: summary\ndescription: Summarize in one sentence:', 'deliverable: one sentence', 'A fox.'])
        self.assertEqual(F.legacy_blocks(nested), contents(nested))

    def test_a_block_closes_only_at_a_fence_of_its_character_at_least_as_long(self):
        self.assertEqual(contents(f'~~~\na\n{T}\nb\n~~~'), [f'a\n{T}\nb'])
        self.assertEqual(contents(f'{T}\na\n~~~\nb\n{T}'), ['a\n~~~\nb'])
        self.assertEqual(contents(f'````\na\n{T}\nb\n````'), [f'a\n{T}\nb'])
        self.assertEqual(contents(f'{T}\na\n`````\nb'), ['a'], 'a longer closing fence closes it')
        self.assertEqual(contents('~~~~\na\n~~~\nb\n~~~~~~'), ['a\n~~~\nb'])

    def test_a_closing_fence_is_followed_by_nothing_but_spaces_or_tabs(self):
        self.assertEqual(F.blocks(f'{T}\na\n{T} \t\nb'), [F.Block('a', True, 0, 9, False)])
        b = F.blocks(f'{T}\na\n{T} x\nb')
        self.assertEqual(([x.content for x in b], b[0].closed), ([f'a\n{T} x\nb'], False), 'text after it: not a fence')
        self.assertEqual(contents(f'{T}\na\n{T}python\nb\n{T}'), [f'a\n{T}python\nb'], 'an info string: not a closing fence')

    def test_info_strings(self):
        self.assertEqual(contents(f'{T}python title="x"\nprint(1)\n{T}'), ['print(1)'])
        self.assertEqual(contents('~~~ text `with` backticks\nx\n~~~'), ['x'], 'after tildes an info string may hold backticks')
        # After backticks it may not: the line is inline code, so the next fence opens the block.
        self.assertEqual(contents(f'{T}x{T}\nA\n{T}'), [''])
        self.assertFalse(F.blocks(f'{T}x{T}\nA\n{T}')[0].closed)
        self.assertEqual(F.blocks(f'{T} `a` b\nA'), [])

    def test_indentation(self):
        self.assertEqual(contents(f'  {T}\n  two\n   three\n one\n  {T}'), ['two\n three\none'], 'up to the fence\'s indentation removed')
        self.assertEqual(contents(f'{T}\nx\n   {T}'), ['x'], 'a closing fence after three spaces')
        self.assertEqual(contents(f'   ~~~\nx\n~~~'), ['x'])
        self.assertEqual(F.blocks(f'    {T}\nx\n{T}')[0].start, len(f'    {T}\nx\n'), 'four spaces: not a fence (the second one opens)')
        self.assertEqual(F.blocks(f'\t{T}\nx\n{T}')[0].start, len(f'\t{T}\nx\n'), 'a tab: not a fence')

    def test_an_unclosed_block_runs_to_the_end_and_says_so(self):
        self.assertEqual(F.blocks(f'Sum:\n{T}\nline one\nline two\n'), [F.Block('line one\nline two', False, 5, 27, False)])
        self.assertEqual(F.blocks(f'x\n{T}'), [F.Block('', False, 2, 5, False)])
        self.assertEqual([(b.content, b.closed) for b in F.blocks(f'{T}\na\n{T}\n~~~\nb\n{T}')], [('a', True), (f'b\n{T}', False)])

    def test_a_closing_fence_at_the_end_of_the_last_line(self):
        """Fix inbox #2 (valun 0.5.2), kept: a fence at the end of a line closes the block there."""
        self.assertEqual(F.blocks(f'Sum:\n{T}\nline one\nline two{T}\nafter'),
                         [F.Block('line one\nline two', True, 5, len(f'Sum:\n{T}\nline one\nline two{T}'), True)])
        self.assertEqual(contents('~~~\nterms ~~~'), ['terms '])
        self.assertEqual(contents(f'````\nuse {T}\nmore````'), [f'use {T}\nmore'], 'a shorter run does not close it')
        # There the fence is the line's last characters, as many as the opening fence has; any more before them are the
        # text's (inline code's closing backtick), as valun 0.7.0 read them. The block still ends where the run ends.
        text = f'Explain this line:\n{T}\nRun `make test`{T}'
        self.assertEqual(F.blocks(text), [F.Block('Run `make test`', True, len('Explain this line:\n'), len(text), True)])
        self.assertEqual(F.without(text), 'Explain this line:\n ')
        self.assertEqual(contents('````\nx ``````'), ['x ``'])
        self.assertEqual(contents('~~~\nthe end ~~~~~\n'), ['the end ~~'])
        self.assertEqual(contents(f'{T}\nx\n`````'), ['x'], 'a fence on a line of its own takes the whole run')

    def test_offsets_and_without(self):
        text = f'Check:\n{T}\nterms\n{T}\nand\n~~~\nwork\n~~~\nthanks'
        bs = F.blocks(text)
        self.assertEqual([text[b.start:b.end] for b in bs], [f'{T}\nterms\n{T}', '~~~\nwork\n~~~'])
        self.assertEqual(F.without(text), 'Check:\n \nand\n \nthanks')
        self.assertEqual(F.without(f'a\n{T}\nb'), 'a\n ')
        self.assertEqual(F.without('no blocks', by='X'), 'no blocks')

    def test_line_ends(self):
        self.assertEqual(contents(f'{T}\r\nA\r\n{T}\r\nB'), ['A\r'], 'a "\\r" after a fence is part of its line end')
        self.assertEqual(contents(f'{T}\nA\u2028B\n{T}'), ['A\u2028B'], 'only "\\n" ends a line')

    def test_not_text(self):
        self.assertEqual(F.blocks(None), [])
        self.assertEqual(F.blocks(''), [])
        with self.assertRaises(TypeError):
            F.blocks(5)

    def test_a_long_line_of_backticks_is_linear(self):
        import time
        t = time.time()
        F.blocks(f'{T}\n' + '`' * 200000 + 'x\n' + '~' * 200000 + 'y')
        self.assertLess(time.time() - t, 2.0)


if __name__ == '__main__':
    unittest.main()
