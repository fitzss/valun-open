// Inline code in running text whose flags, handles and placeholders never break across lines.
//
// A browser may end a line after any hyphen, so `--sandbox` or `sandbox-mallory` in a sentence can be split in two
// ("--" at the end of one line, "sandbox" on the next), and a reader who types what they see types another command.
// Inline code has no Copy button, so what it shows is what people type. The rule, for the text of one inline <code>:
//   - it breaks only between its words (at its spaces), as public/site.css's command blocks do;
//   - a word that holds a hyphen (a flag, a handle, YOUR-HANDLE) is kept whole: <span class="nw"> (white-space: nowrap
//     in public/site.css), as /trust's code is (scripts/build-trust.mjs);
//   - a word longer than WHOLE_MAX characters (a path or a URL) would not fit the line of a 320 px phone, so it may also
//     break after a / or \ and before a placeholder in capitals that follows a hyphen (token-|YOUR-HANDLE), with <wbr>;
//     each of its pieces that holds a hyphen is kept whole, and a piece longer than WHOLE_MAX breaks as it would anyway.
// What a reader copies is unchanged: the spans and <wbr> add no characters. Handles are at most 24 characters
// (lib/pilot: ^[a-z][a-z0-9_-]{2,23}$) and the longest flag of valun 0.7.1 is under 20, so neither is ever split.
//
// codeWords(inner): the inside of one inline <code> (HTML text: entities, no tags) as HTML that keeps those words whole.
// keepCodeWhole(html): a page with every inline <code> outside <pre> written that way. It is idempotent (it reads its
// own spans and <wbr> back first) and leaves a <code> holding any other markup as it is. scripts/code-words.mjs applies
// it to the static pages; test/home-page.test.mjs checks they are kept so.

export const WHOLE_MAX = 24;
// The static pages of public/ whose inline code is written this way (scripts/code-words.mjs writes them; a page added
// here is checked by test/home-page.test.mjs). /trust is built so by scripts/build-trust.mjs.
export const PAGES = ['home.html', 'story-fragment.html', 'memory.html', 'start.html', 'pilot.html'];
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi;
const chars = s => s.replace(ENTITY, '_').length;   // an entity is one character
// Where a long word may break: after a / or \ that follows another character (not after a leading one, nor in or after
// https://), and between a hyphen that ends a lowercase run and a placeholder in capitals (valun-owner-token-|YOUR-
// HANDLE.txt; never inside YOUR-HANDLE).
const POINTS = /(?<=[^/\\][/\\])(?![/\\])|(?<=[a-z0-9]-)(?=[A-Z])/;
const whole = s => (s.includes('-') && chars(s) <= WHOLE_MAX ? `<span class="nw">${s}</span>` : s);

// (A browser does not break after a / by itself: a long path without a hyphen, ~/.openclaw/skills/valun/SKILL.md, was
// cut inside SKILL by overflow-wrap. So every long word gets these points, with or without a hyphen.)
const word = w => (chars(w) <= WHOLE_MAX ? whole(w) : w.split(POINTS).filter(Boolean).map(whole).join('<wbr>'));
export function codeWords(inner) {
  // the spaces (and a line break of the HTML source) stay exactly as they are: they are where a line may break
  return String(inner).split(/(\s+)/).map((w, i) => (i % 2 ? w : word(w))).join('');
}

const CODE = /<code\b([^>]*)>([\s\S]*?)<\/code>/g;
const OURS = /<span class="nw">|<\/span>|<wbr>/g;
export function keepCodeWhole(html) {
  // A <pre> block keeps its text as written (the page's script shows it whole, wrapped only at its spaces).
  return String(html).split(/(<pre\b[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.replace(CODE, (all, attrs, inner) => {
    const bare = inner.replace(OURS, '');
    return /[<>]/.test(bare) ? all : `<code${attrs}>${codeWords(bare)}</code>`;
  }))).join('');
}
