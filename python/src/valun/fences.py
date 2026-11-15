"""Fenced blocks in a deal's text, read as CommonMark reads them (fix inbox #70).

Buyers paste text in fenced blocks: the text a seller works on, and for a check the agreed terms and the delivered work.
Until valun 0.7.0 the house agents knew only ``` fences, matched lazily, so a ``` inside the pasted text closed its block
early. Here, as in CommonMark:

- a block opens at a line of at least three backticks or at least three tildes, after at most three spaces; an info
  string may follow (after backticks it may not hold a backtick: such a line is inline code, not a fence);
- it closes at the first later line that is a fence of the same character, at least as long, after at most three spaces
  and followed by nothing but spaces or tabs; or, as since valun 0.5.2 (fix inbox #2), at the end of a line that ends
  with such a fence: there the fence is the line's last characters, as many as the opening fence has, and any more of
  that character before them are the line's own text (its inline code's closing backtick, say);
- a block that is never closed runs to the end of the text, and says so (closed is False), so a caller can refuse it.

So ~~~, or a longer backtick fence, wraps text that holds ``` fences. A block's content is its lines between the fences,
without the final newline, each without up to as many leading spaces as its opening fence had. Lines end at "\\n" (a
"\\r" just before it is allowed after a fence). For plain ``` blocks, the blocks are those of valun 0.7.0 (LEGACY).

measure.py and agent.py import this module, so the Hermes plugin's core carries it too. JavaScript: js/src/fences.js,
the same rules.
"""
import re
from collections import namedtuple

# content: the block's text; closed: False for a block that runs to the end of the text; start, end: where the block is
# in the text, from its opening fence (after its indentation) to the end of its closing fence (the end of the text when
# it is not closed); eol: closed by a fence at the end of its last line (fix inbox #2), not by a fence line of its own.
Block = namedtuple('Block', 'content closed start end eol')

_OPEN = re.compile(r'( {0,3})(`{3,}|~{3,})(.*)')

# The rule of valun 0.5.2 to 0.7.0: ``` fences only, closed lazily by a fence on its own line or at the end of a line.
# The house reviewer read checks with it until valun 0.7.1, so receipts of versions 1 and 2 are checked by it.
LEGACY = re.compile(r'^```[^\n]*\n(.*?)\n?```[ \t]*$', re.S | re.M)


def _tail(line, char):
    """A line's last run of `char`, followed by nothing but spaces or tabs (and a final "\\r"): (the text before the
    run, the run's length, where the run ends)."""
    s = (line[:-1] if line.endswith('\r') else line).rstrip(' \t')
    k = len(s)
    while k and s[k - 1] == char:
        k -= 1
    return s[:k], len(s) - k, len(s)


def _dedent(line, n):
    k = 0
    while k < n and k < len(line) and line[k] == ' ':
        k += 1
    return line[k:]


def blocks(text):
    """The fenced blocks of a text, in order: [Block(content, closed, start, end, eol)]."""
    if text is None:
        text = ''
    if not isinstance(text, str):
        raise TypeError(f"expected string or bytes-like object, got '{type(text).__name__}'")
    lines, at, pos = text.split('\n'), [], 0
    for ln in lines:
        at.append(pos)
        pos += len(ln) + 1
    out, i = [], 0
    while i < len(lines):
        m = _OPEN.fullmatch(lines[i])
        if not m or (m.group(2)[0] == '`' and '`' in m.group(3)):
            i += 1
            continue
        indent, char, length = len(m.group(1)), m.group(2)[0], len(m.group(2))
        body, closed, eol, end, j = [], False, False, len(text), i + 1
        while j < len(lines):
            before, run, stop = _tail(lines[j], char)
            if run >= length:
                closed, end = True, at[j] + stop
                if before.strip(' ') or len(before) > 3:      # text before the fence: it closes the block's last line
                    body.append(before + char * (run - length))   # (the run's characters before the fence are text)
                    eol = True
                break
            body.append(lines[j])
            j += 1
        if not closed and body and body[-1] == '':
            body.pop()                                         # the text's final newline
        out.append(Block('\n'.join(_dedent(ln, indent) for ln in body), closed, at[i] + indent, end, eol))
        i = j + 1
    return out


def without(text, found=None, by=' '):
    """The text with each of its fenced blocks (found: blocks(text)), from its opening fence to the end of its closing
    fence, replaced by `by`."""
    text = text or ''
    parts, last = [], 0
    for b in (blocks(text) if found is None else found):
        parts += [text[last:b.start], by]
        last = b.end
    return ''.join(parts) + text[last:]


def legacy_blocks(text):
    """The blocks of a text as valun 0.5.2 to 0.7.0 read them (LEGACY): ``` fences only."""
    return LEGACY.findall(text or '')
