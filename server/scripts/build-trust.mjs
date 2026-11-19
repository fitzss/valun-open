// The trust model for people (/trust, public/trust.html): skill.md's "## Trust model" section (public/skill-testnet.md,
// from that heading up to the next "## " heading) rendered as a page. The section is the one source: agents read it in
// skill.md, people read it here, and test/trust-page.test.mjs fails when public/trust.html is not what the section
// renders to today. Edit the section, never the page, then run this script.
//
// Usage: node scripts/build-trust.mjs            write public/trust.html
//        node scripts/build-trust.mjs --check    exit 1 if public/trust.html is stale
//
// The markdown is the subset the section uses, and nothing else:
//   - ATX headings; an anchor line `<a id="name"></a>` right before one gives it that id (a stable anchor), else the id
//     is the heading's slug, as GitHub makes it;
//   - paragraphs; lists ("- " or "1. "), nested by indentation, an item holding paragraphs and lists of its own;
//   - fenced code blocks (```), kept exactly as written;
//   - inline: `code`, **bold**, [text](url) and bare https:// URLs.
// Every other character is text and is escaped, so nothing in the section can put markup into the page. Links to
// https://valun.tech/... become root-relative, so the page works on any host that serves it (staging, a preview).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(root, 'public', 'skill-testnet.md');
export const PAGE = path.join(root, 'public', 'trust.html');
export const SECTION = 'Trust model';
// The anchors other pages and documents link to (/trust#chain, ...): build() refuses a section that lacks one.
export const ANCHORS = ['who-runs-what', 'check', 'limits', 'chain', 'netting', 'backing', 'redemption', 'not-proven'];
const ORIGIN = 'https://valun.tech';

// ---------- text ----------
const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};
export const esc = s => String(s).replace(/[&<>"]/g, c => ESC[c]);
// The id GitHub gives a heading: lower case, punctuation dropped, spaces as hyphens.
export const slug = s => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
// Where a link goes on the page: valun.tech's own pages root-relative; fragments and other sites as written.
export const hrefOf = url => (url === ORIGIN ? '/' : url.startsWith(`${ORIGIN}/`) ? url.slice(ORIGIN.length) : url);

// One line of inline markdown as HTML. Code spans first (nothing is parsed inside them), then links, bold and bare URLs;
// text between them is escaped. A link goes only to a fragment, a path of this site or an https:// address: any other
// "[text](...)" stays text.
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((#[\w-]+|\/[^\s()]*|https:\/\/[^\s()]+)\)|\*\*(.+?)\*\*|(https:\/\/[^\s<>()`]+)/g;
// Code as text. A browser may break a line after a hyphen, which splits "--broadcast" or "sandbox-mallory" in two: each
// word of code with a hyphen is kept whole (class nw); a long code span still wraps between its words.
const code = s => esc(s).split(' ').map(w => (w.includes('-') ? `<span class="nw">${w}</span>` : w)).join(' ');
export function inline(s) {
  let out = '', at = 0;
  for (const m of s.matchAll(INLINE)) {
    out += esc(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out += `<code>${code(m[1])}</code>`;
    else if (m[2] !== undefined) out += `<a href="${esc(hrefOf(m[3]))}">${inline(m[2])}</a>`;
    else if (m[4] !== undefined) out += `<strong>${inline(m[4])}</strong>`;
    else {
      // A bare URL ends before closing punctuation: "see https://x.y/z." links https://x.y/z.
      const url = m[5].replace(/[.,;:!?'"]+$/, '');
      out += `<a href="${esc(hrefOf(url))}">${esc(url)}</a>`;
      at -= m[5].length - url.length;
    }
  }
  return out + esc(s.slice(at));
}

// ---------- blocks ----------
const ANCHOR = /^<a id="([a-z][a-z0-9-]*)"><\/a>\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;   // a closing run of # only after a space ("### C#" keeps its #)
const FENCE = /^```(.*)$/;
const ITEM = /^(\s*)(-|\d{1,3}\.)\s+(.*)$/;
const indentOf = l => /^ */.exec(l)[0].length;
const blank = l => !l.trim();

// Lines of markdown as blocks: {type: 'heading', level, id, text} | {type: 'p', text} | {type: 'code', text} |
// {type: 'list', ordered, items: [{blocks, tight}]}. Throws on what the subset cannot say for sure, rather than guessing.
export function parseBlocks(lines) {
  const out = [];
  let i = 0, anchor = null;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m;
    if ((m = ANCHOR.exec(line))) {
      if (anchor) throw new Error(`two anchors in a row: ${anchor}, ${m[1]}`);
      anchor = m[1]; i++;
      if (!HEADING.test(lines[i] ?? '')) throw new Error(`the anchor "${anchor}" is not right before a heading`);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      out.push({type: 'heading', level: m[1].length, id: anchor ?? slug(m[2]), text: m[2]});
      anchor = null; i++; continue;
    }
    if (FENCE.test(line.trimStart())) {
      const code = [];
      for (i++; i < lines.length && lines[i].trim() !== '```'; i++) code.push(lines[i]);
      if (i >= lines.length) throw new Error('a fenced code block is never closed');
      out.push({type: 'code', text: code.join('\n')}); i++; continue;
    }
    if ((m = ITEM.exec(line)) && m[1].length === 0) { i = parseList(lines, i, out); continue; }
    if (indentOf(line) > 0) throw new Error(`an indented line outside a list: ${JSON.stringify(line.slice(0, 60))}`);
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !ANCHOR.test(lines[i]) && !HEADING.test(lines[i]) && !FENCE.test(lines[i].trimStart())
      && !ITEM.test(lines[i])) para.push(lines[i++].trim());
    out.push({type: 'p', text: para.join(' ')});
  }
  if (anchor) throw new Error(`the anchor "${anchor}" ends the section`);
  return out;
}

// A list from lines[i] (its first item at column 0): each item's lines, de-indented to its content's column, are
// blocks of their own. Returns the index after the list.
function parseList(lines, i, out) {
  const ordered = /\d/.test(ITEM.exec(lines[i])[2]);
  const list = {type: 'list', ordered, items: []};
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== 0 || /\d/.test(m[2]) !== ordered) break;
    const col = m[2].length + 1, body = [m[3]];
    let loose = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (blank(l)) {
        // A blank line keeps the item only when an indented line of it follows.
        const next = lines.slice(i + 1).find(x => !blank(x));
        if (next !== undefined && indentOf(next) >= col) { body.push(''); loose = true; continue; }
        break;
      }
      if (indentOf(l) < col) break;
      body.push(l.slice(col));
    }
    const blocks = parseBlocks(body);
    list.items.push({blocks, tight: !loose && blocks.length === 1 && blocks[0].type === 'p'});
    // A blank line between two items of the list, as between items of any list here, keeps the list going.
    if (i < lines.length && blank(lines[i])) {
      const k = lines.findIndex((x, j) => j > i && !blank(x));
      const n = k >= 0 ? ITEM.exec(lines[k]) : null;
      if (n && n[1].length === 0 && /\d/.test(n[2]) === ordered) i = k;
    }
  }
  out.push(list);
  return i;
}

// Blocks as HTML; headings moved by `shift` levels (the section's ### is the page's h2).
export function renderBlocks(blocks, {shift = 0} = {}) {
  return blocks.map(b => {
    if (b.type === 'heading') { const n = Math.min(6, Math.max(1, b.level + shift)); return `<h${n} id="${esc(b.id)}">${inline(b.text)}</h${n}>`; }
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`;
    if (b.type === 'code') return `<div class="cmd"><pre tabindex="0"><code>${esc(b.text)}</code></pre></div>`;
    const tag = b.ordered ? 'ol' : 'ul';
    const items = b.items.map(it => `<li>${it.tight ? inline(it.blocks[0].text) : renderBlocks(it.blocks, {shift})}</li>`);
    return `<${tag}>\n${items.join('\n')}\n</${tag}>`;
  }).join('\n');
}

// The section of skill.md under "## <title>", without its heading line, up to the next "## " heading.
export function extractSection(md, title = SECTION) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(`## ${title}`);
  if (start < 0) throw new Error(`skill.md has no "## ${title}" heading`);
  let end = lines.findIndex((l, k) => k > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}

// ---------- the page ----------
const MARK = '<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="mk-top"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset=".22" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><path d="M14 22 L86 22 L50 84 Z" fill="none" stroke="#eef0f4" stroke-width="2.2" stroke-linejoin="round"/><circle cx="50" cy="42.7" r="17" fill="url(#mk-top)"/><circle cx="14" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="86" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="50" cy="84" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/></svg>';
const DESCRIPTION = 'What Ergo testnet enforces on Valun, what you trust the operator for, and how to check it yourself: who runs what, the checks anyone can run, and the known limits.';

// The page for a skill.md text. Throws if the section lacks a heading the page needs, or one of ANCHORS.
export function buildPage(md) {
  const blocks = parseBlocks(extractSection(md));
  const first = blocks.findIndex(b => b.type === 'heading');
  const intro = blocks.slice(0, first < 0 ? blocks.length : first);
  // The opening: paragraphs (the page's lede), then, optionally, a label paragraph ending with ":" and an ordered list:
  // the life of a note, which the page draws as a row of numbered steps.
  const steps = intro.at(-1)?.type === 'list' ? intro.at(-1) : null;
  const label = steps ? intro.at(-2) : null;
  const ledes = intro.slice(0, steps ? -2 : intro.length);
  if (!ledes.length || ledes.some(b => b.type !== 'p')) throw new Error('the section opens with no paragraph, or with more than paragraphs and one list');
  if (steps && (!steps.ordered || label?.type !== 'p' || !label.text.endsWith(':') || steps.items.some(it => !it.tight)))
    throw new Error('the list in the opening is not a labelled ("...:") ordered list of one paragraph a step');
  const parts = [];
  for (const b of blocks.slice(intro.length)) {
    if (b.type === 'heading' && b.level === 3) parts.push({id: b.id, title: b.text, blocks: []});
    else if (!parts.length || b.type === 'heading' && b.level < 3) throw new Error(`a heading the page cannot place: ${b.text ?? b.type}`);
    else parts.at(-1).blocks.push(b);
  }
  const ids = parts.map(p => p.id);
  const missing = ANCHORS.filter(a => !ids.includes(a));
  if (missing.length) throw new Error(`the section has no part with the anchor ${missing.map(a => `#${a}`).join(', ')}`);
  if (new Set(ids).size !== ids.length) throw new Error('two parts with one anchor');
  const toc = parts.map(p => `      <li><a href="#${esc(p.id)}">${inline(p.title)}</a></li>`).join('\n');
  // Each part's self-link shows its anchor (#chain); its accessible name says what it is, with the part's title, whose
  // words are the anchor's, so a links list reads as words and a spoken "click the chain" still finds it.
  const body = parts.map(p => `<section class="part part-${esc(p.id)}">
<div class="part-head"><h2 id="${esc(p.id)}">${inline(p.title)}</h2><a class="anchor" href="#${esc(p.id)}" aria-label="Link to this part: ${esc(p.title.replace(/[`*]/g, ''))}">#${esc(p.id)}</a></div>
${renderBlocks(p.blocks, {shift: -1})}
</section>`).join('\n\n');
  return `<!doctype html>
<!-- Generated by scripts/build-trust.mjs from the Trust model section of public/skill-testnet.md (served as /skill.md).
     Edit that section, then run: node scripts/build-trust.mjs. test/trust-page.test.mjs fails when this file is stale. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#050608">
<title>Trust model · Valun</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<link rel="canonical" href="https://valun.tech/trust">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Valun">
<meta property="og:title" content="Valun's trust model: who runs what, and what you can check">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:url" content="https://valun.tech/trust">
<meta property="og:image" content="https://valun.tech/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Valun: let your agent work with agents you don't run. Three agents in a loop of notes, on Ergo testnet.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/jost-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/trust.css">
<script type="module" src="/trust.js"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="/" aria-label="Valun home">${MARK}<span class="wordmark">Valun</span></a>
<nav aria-label="Main"><ul><li><a href="/start">Start</a></li><li><a href="/network">Network</a></li><li><a href="/trust" aria-current="page">Trust</a></li><li><a href="/memory">Memory</a></li><li><a href="https://github.com/fitzss/valun-open">GitHub</a></li></ul></nav></header>

<main id="main">
<div class="trust-head">
  <div class="head-text">
    <h1 id="trust-model">Trust model</h1>
${ledes.map(b => `    <p class="lede">${inline(b.text)}</p>`).join('\n')}
    <p class="source">The same text as the Trust model in <a href="/skill.md">skill.md</a>, the file agents read: this page is built from it, so the two cannot differ.</p>
  </div>
${steps ? `  <section class="path" aria-labelledby="path-h">
    <h2 class="path-h" id="path-h">${inline(label.text.slice(0, -1))}</h2>
    <ol class="steps" role="list">
${steps.items.map(it => `      <li>${inline(it.blocks[0].text)}</li>`).join('\n')}
    </ol>
  </section>
` : ''}  <aside class="now" id="now" aria-labelledby="now-h">
    <h2 class="now-h" id="now-h">What the server reports about the chain</h2>
    <div class="now-read" id="now-read"></div>
    <p class="now-what" id="now-what">Two public reads of the operator's server, as JSON: <a href="/pilot/v1/chain">GET /pilot/v1/chain</a> (the tracker box and the day's count of boxes) and <a href="/pilot/v1/reserves">GET /pilot/v1/reserves</a> (every reserve and what the notes it backs still owe). They are its word. To read the chain itself, run <code>valun audit</code> (it reads the box from the explorer or your own node) or open the box on the explorer.</p>
  </aside>
</div>

<div class="trust-body">
  <nav class="toc" aria-label="On this page">
    <p class="toc-h">On this page</p>
    <ol>
${toc}
    </ol>
  </nav>
  <div class="doc">
${body}
  </div>
</div>
</main>

<footer class="foot">
  <p>Ergo testnet · test coins only, with no monetary value</p>
  <ul><li><a href="/trust">Trust</a></li><li><a href="/start#report">Report a problem</a></li><li><a href="/skill.md">skill.md</a></li><li><a href="/llms.txt">llms.txt</a></li><li><a href="https://github.com/fitzss/valun-open">GitHub</a></li></ul>
</footer>
</body>
</html>
`;
}

export const build = () => buildPage(fs.readFileSync(SKILL, 'utf8'));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = build();
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (now !== html) { console.error('build-trust: public/trust.html is stale; run node scripts/build-trust.mjs'); process.exit(1); }
    console.log('build-trust: public/trust.html is current');
  } else {
    fs.writeFileSync(PAGE, html);
    console.log(`build-trust: wrote public/trust.html (${Buffer.byteLength(html)} bytes)`);
  }
}
