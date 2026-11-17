// What test/network-page.test.mjs needs to run the live network page (public/network.html and network.js) under
// node:test: the page's own <body>, read from network.html by a small HTML reader into test/console-dom.mjs's elements
// (with what network.js also uses: prepend, remove, appendChild, lastElementChild, a box for the graph); network.js run on
// it in a context of its own (node:vm), with a fake fetch and timers that never fire, so a test decides when each read
// answers; and the rules of a stylesheet. Not a browser: no layout and no cascade.
import vm from 'node:vm';
import fs from 'node:fs';
import {Node, Text, Element as BaseElement} from './console-dom.mjs';

// A page's local module imports (`import {...} from './who.js';`), inlined from public/ so the page runs as one script;
// a re-export (`export {...};`) is dropped. Only flat, side-effect-free modules of public/ are imported this way.
export const inlineLocalImports = js => js
  .replace(/^import \{[^}]*\} from '\.\/([a-z0-9-]+\.js)';$/gm, (m, f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'))
  .replace(/^export \{[^}]*\};$/gm, '');

export class Element extends BaseElement {
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) {
    const xs = nodes.map(n => (n instanceof Node ? n : new Text(String(n))));
    for (const x of xs) { if (x.parentNode) x.parentNode.childNodes = x.parentNode.childNodes.filter(c => c !== x); x.parentNode = this; }
    this.childNodes = [...xs, ...this.childNodes];
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; } }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x.tagName === 'BODY'; }
  get offsetWidth() { return 0; }
  getBoundingClientRect() { return {x: 0, y: 0, top: 0, left: 0, width: 1250, height: 800, right: 1250, bottom: 800}; }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NAMED = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
const decode = s => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : NAMED[n] ?? m));
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

// The <body> of a page as elements: tags, attributes, text and character references; comments dropped. Enough for the
// pages of public/ (every element closed or void, no script or style in the body), not a general HTML parser.
export function readBody(html) {
  const body = new Element('body'), open = [body];
  for (const [, close, tag, attrs, selfClosing, text] of (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? '').matchAll(TOKEN)) {
    const at = open.at(-1);
    if (close) { const i = open.findLastIndex(e => e.tagName === close.toUpperCase()); if (i > 0) open.length = i; }
    else if (tag) {
      const el = new Element(tag);
      for (const [, k, a, b, c] of attrs.matchAll(ATTR)) el.setAttribute(k, decode(a ?? b ?? c ?? ''));
      at.append(el);
      if (!selfClosing && !VOID.has(tag.toLowerCase())) open.push(el);
    } else if (text) at.append(new Text(decode(text)));
  }
  return body;
}

// public/network.js (its source, `js`) started on a page `body` (readBody), as a browser starts it, in a context of its
// own: `fetch(path)` answers its reads; its timers and animation frames never fire (one poll, no repeats). The page sets
// its next poll after each one, so unlike memory.js (test/memory-page.test.mjs) it does not run on this process's own
// globals and timers. `setTimeout`: the page's, for a test that runs the next poll itself (it records what the page
// sets; nothing fires by itself). `globals`: more of the page's globals (navigator, for a test of its Copy buttons).
// Returns the page's document.
export function runNetworkPage(js, body, fetch, {setTimeout = null, globals = {}} = {}) {
  const never = () => 0;
  const document = {body, hidden: false, getElementById: id => body.all('*').find(e => e.id === id) ?? null,
    createElement: t => new Element(t), createElementNS: (ns, t) => new Element(t), createTextNode: t => new Text(t),
    querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s), addEventListener() {}};
  const context = vm.createContext({document, window: {}, fetch, console, performance, setTimeout: setTimeout ?? never, setInterval: never,
    clearTimeout: never, clearInterval: never, requestAnimationFrame: never, ResizeObserver: class { observe() {} }, ...globals});
  // The module's exports are plain declarations in a script; its local imports (public/who.js) are inlined first.
  vm.runInContext(inlineLocalImports(js).replace(/^export /gm, ''), context, {filename: 'public/network.js'});
  return document;
}

// The rules of a stylesheet, in order: {media, selector, decls}, one per selector of a list, comments dropped. A rule
// inside @media carries its condition; other at-rules (@font-face, @keyframes) are left out.
export function cssRules(css, media = null) {
  const out = [], src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < src.length;) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    let j = open + 1;
    for (let depth = 1; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
    const head = src.slice(i, open).trim(), inner = src.slice(open + 1, j - 1);
    if (head.startsWith('@media')) out.push(...cssRules(inner, head.slice(6).trim()));
    else if (!head.startsWith('@')) {
      const decls = {};
      for (const d of inner.split(';')) { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
      for (const s of head.split(',')) out.push({media, selector: s.trim().replace(/\s+/g, ' '), decls});
    }
    i = j;
  }
  return out;
}
