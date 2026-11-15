// Fenced blocks in a deal's text, read as CommonMark reads them (port of python/src/valun/fences.py; fix inbox #70).
//
// A block opens at a line of at least three backticks or at least three tildes, after at most three spaces; an info
// string may follow (after backticks it may not hold a backtick: such a line is inline code, not a fence). It closes at
// the first later line that is a fence of the same character, at least as long, after at most three spaces and followed
// by nothing but spaces or tabs; or, as since valun 0.5.2 (fix inbox #2), at the end of a line that ends with such a
// fence: there the fence is the line's last characters, as many as the opening fence has, and any more of that
// character before them are the line's own text. A block that is never closed runs to the end of the text, and says so
// (closed: false). A block's content is its lines between the fences, without the final newline, each without up to as
// many leading spaces as its opening fence had. Lines end at "\n" (a "\r" just before it is allowed after a fence). The
// same blocks as the Python module; their start and end are UTF-16 offsets here (code points in Python). The JavaScript
// client has no check service or receipts, so it has no copy of Python's LEGACY rule.

import {PyError, typeName} from './py.js';

const OPEN = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/u;

// A line's last run of `char`, followed by nothing but spaces or tabs (and a final "\r"): [the text before the run, the
// run's length, where the run ends].
function tail(line, char) {
  const s = (line.endsWith('\r') ? line.slice(0, -1) : line).replace(/[ \t]+$/u, '');
  let k = s.length;
  while (k && s[k - 1] === char) k--;
  return [s.slice(0, k), s.length - k, s.length];
}

function dedent(line, n) {
  let k = 0;
  while (k < n && k < line.length && line[k] === ' ') k++;
  return line.slice(k);
}

/** The fenced blocks of a text, in order: [{content, closed, start, end, eol}]. */
export function blocks(text) {
  if (text === null || text === undefined) text = '';
  if (typeof text !== 'string') throw new PyError('TypeError', `expected string or bytes-like object, got '${typeName(text)}'`);
  const lines = text.split('\n');
  const at = [];
  let pos = 0;
  for (const ln of lines) {
    at.push(pos);
    pos += ln.length + 1;
  }
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = OPEN.exec(lines[i]);
    if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
      i++;
      continue;
    }
    const indent = m[1].length, char = m[2][0], length = m[2].length;
    const body = [];
    let closed = false, eol = false, end = text.length, j = i + 1;
    while (j < lines.length) {
      const [before, run, stop] = tail(lines[j], char);
      if (run >= length) {
        closed = true;
        end = at[j] + stop;
        if (before.replace(/ /gu, '') !== '' || before.length > 3) {    // text before the fence: it closes the last line
          body.push(before + char.repeat(run - length));                // (the run's characters before the fence are text)
          eol = true;
        }
        break;
      }
      body.push(lines[j]);
      j++;
    }
    if (!closed && body.length && body[body.length - 1] === '') body.pop();       // the text's final newline
    out.push({content: body.map(ln => dedent(ln, indent)).join('\n'), closed, start: at[i] + indent, end, eol});
    i = j + 1;
  }
  return out;
}

/** The text with each of its fenced blocks (found: blocks(text)), from its opening fence to the end of its closing fence, replaced by `by`. */
export function without(text, found = null, by = ' ') {
  const t = text || '';
  let out = '', last = 0;
  for (const b of (found === null || found === undefined ? blocks(t) : found)) {
    out += t.slice(last, b.start) + by;
    last = b.end;
  }
  return out + t.slice(last);
}
