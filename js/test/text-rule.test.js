// hasUnsafeText(): the text rule of spec section 2.3 (normative since server release v13, valun-app 6a6a34b), rule by
// rule, and a sweep of every code point against rule 5. The vectors (statements.json, terms-validation.json) hold the
// server's own outcomes; this file pins the rule's contexts so a change shows up as a named case. Offline.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {REASON_UNSAFE, hasUnsafeText, reasonProblem} from '../src/index.js';

const FLAG = {england: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
  scotland: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', wales: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}'};
const SINGLE = ['\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{61c}'];

const ALLOWED = {
  'rule 1: tab, LF, CR': 'a\u{9}b\u{a}c\u{d}d\u{9}\u{9}',
  'rule 2: each single mark alone, also at the start and the end': SINGLE.map(m => `x${m}y`).join(' ') + ` ${SINGLE[0]}start end${SINGLE[1]}`,
  'rule 2: an emoji ZWJ sequence': '\u{1f469}\u{200d}\u{1f4bb}',
  'rule 3: emoji presentation and text presentation after an emoji': '\u{2764}\u{fe0f} \u{263a}\u{fe0e} \u{a9}\u{fe0f}',
  'rule 3: keycaps': '1\u{fe0f}\u{20e3} #\u{fe0f}\u{20e3} *\u{fe0f}\u{20e3} 0\u{fe0f}\u{20e3}',
  'rule 4: the three RGI subdivision flags': `${FLAG.england} ${FLAG.scotland}${FLAG.wales}`,
  'rule 4: the black flag alone': '\u{1f3f4} \u{1f3f4}x',
  'rule 5: ordinary letters, private use, blank-looking spaces, a lone surrogate': 'caf\u{e9} \u{e000} \u{2003}\u{3000} \u{d800}',
};
const REFUSED = {
  'rule 1: other controls': ['\u{0}', '\u{b}', '\u{7f}', '\u{85}', '\u{9f}'],
  'rule 2: two single marks in a row': [`a${SINGLE[0]}${SINGLE[1]}b`, `a${SINGLE[2]}${SINGLE[2]}b`, `a${SINGLE[4]}${SINGLE[0]}`],
  'rule 3: a selector after ordinary text, first or after a selector': ['a\u{fe0f}', '\u{fe0f}', '\u{2764}\u{fe0f}\u{fe0f}', '\u{2764}\u{fe0e}\u{fe0f}'],
  'rule 3: after 0-9 # * only inside a keycap, only U+FE0F': ['1\u{fe0f}', '#\u{fe0e}\u{20e3}', '*\u{fe0e}', '1\u{fe0f}x'],
  'rule 3: after a single mark or after U+E007F': [`\u{2764}${SINGLE[1]}\u{fe0f}`, `${FLAG.wales}\u{fe0f}`],
  'rule 4: any other tag sequence': ['\u{1f3f4}\u{e0067}\u{e0062}\u{e0078}\u{e0078}\u{e0078}\u{e007f}', '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}',
    '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e0067}\u{e007f}', 'x\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', '\u{e0001}'],
  'rule 5: format and default-ignorable characters': ['\u{ad}', '\u{200b}', '\u{202e}', '\u{2066}', '\u{feff}', '\u{115f}', '\u{3164}', '\u{34f}',
    '\u{180e}', '\u{17b4}', '\u{fe00}', '\u{e0100}', '\u{1d173}', '\u{600}', '\u{2065}', '\u{fff0}', '\u{e0fff}'],
};

test('spec 2.3 rules 1-4: what the contexts allow', () => {
  for (const [name, text] of Object.entries(ALLOWED)) assert.equal(hasUnsafeText(text), false, name);
});

test('spec 2.3 rules 1-5: what is refused', () => {
  for (const [name, texts] of Object.entries(REFUSED)) {
    for (const t of texts) assert.equal(hasUnsafeText(t), true, `${name}: ${[...t].map(c => c.codePointAt(0).toString(16)).join(' ')}`);
  }
});

test('every code point between two letters: refused exactly when it is Cc, Cf or default-ignorable, but for the exceptions', () => {
  // The exceptions on their own between letters are TAB, LF, CR and the five single marks (selectors need an emoji
  // before them, tag characters a black flag): the sweep of spec 2.3 found exactly these eight.
  const allowedOfTheSet = [];
  for (let c = 0; c < 0x110000; c++) {
    const ch = c >= 0xd800 && c <= 0xdfff ? String.fromCharCode(c) : String.fromCodePoint(c);
    const inSet = REASON_UNSAFE.test(ch), refused = hasUnsafeText(`a${ch}b`);
    if (!inSet) assert.equal(refused, false, c.toString(16));
    else if (!refused) allowedOfTheSet.push(c);
  }
  assert.deepEqual(allowedOfTheSet, [0x9, 0xa, 0xd, 0x61c, 0x200c, 0x200d, 0x200e, 0x200f]);
});

test('reasons follow the same rule (decline and dispute), after the raw length check', () => {
  const refused = {error: 'invalid_field', message: 'reason contains control, bidi or invisible characters; remove them and sign again'};
  for (const kind of ['decline', 'dispute']) {
    assert.equal(reasonProblem(kind, `Too late ${FLAG.scotland} and 1\u{fe0f}\u{20e3} \u{2764}\u{fe0f}`), null);
    assert.deepEqual(reasonProblem(kind, `Too late${SINGLE[0]}${SINGLE[1]}`), refused);
    assert.deepEqual(reasonProblem(kind, 'x\u{fe0f}'), refused);
  }
  assert.match(reasonProblem('decline', '\u{ad}'.repeat(601)).message, /^reason is longer than 600 characters/);
});
