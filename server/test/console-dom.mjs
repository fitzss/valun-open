// A minimal DOM for running public/pilot.js (the pilot owner console) under node:test: just what that page uses
// (elements, text nodes, attributes, classList, dataset, events, forms, FormData, a small selector engine, location,
// sessionStorage). Not a browser: no layout, no CSS, no HTML parser. test/console.test.mjs builds the page skeleton of
// public/pilot.html from it and drives the console with a fake fetch.

export class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' || v == null ? [] : [new Text(String(v))])); }
  append(...nodes) {
    for (const n of nodes) {
      const x = n instanceof Node ? n : new Text(String(n));
      if (x.parentNode) x.parentNode.childNodes = x.parentNode.childNodes.filter(c => c !== x);
      x.parentNode = this; this.childNodes.push(x);
    }
  }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  replaceWith(n) {
    const p = this.parentNode; if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter(c => c !== n);
    p.childNodes.splice(i, 1, n); n.parentNode = p; this.parentNode = null;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
}
export class Text extends Node {
  constructor(t) { super(); this.data = t; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
export class Element extends Node {
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.className = '';
    this.hidden = false; this.disabled = false; this.checked = false; this.selected = false; this._value = null;
  }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v) { this.attrs.set('id', String(v)); }
  get value() {
    if (this.tagName === 'TEXTAREA') return this._value ?? this.textContent;
    if (this.tagName === 'SELECT') { const opts = this.all('option'); return (opts.find(o => o.selected) ?? opts[0])?.value ?? ''; }
    if (this.tagName === 'OPTION') return this.attrs.get('value') ?? this.textContent;
    return this._value ?? (this.attrs.get('type') === 'checkbox' || this.attrs.get('type') === 'radio' ? 'on' : '');
  }
  set value(v) { this._value = String(v); }
  get type() { return this.attrs.get('type') ?? (this.tagName === 'BUTTON' ? 'submit' : 'text'); }
  get name() { return this.attrs.get('name') ?? ''; }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'checked') this.checked = true; else if (k === 'disabled') this.disabled = true; else if (k === 'hidden') this.hidden = true;
    else if (k === 'selected') this.selected = true; else if (k === 'value') this._value = String(v); else if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean), set = xs => { this.className = xs.join(' '); };
    return {contains: c => get().includes(c), add: (...cs) => set([...new Set([...get(), ...cs])]), remove: (...cs) => set(get().filter(x => !cs.includes(x))),
      toggle: (c, on) => { const has = get().includes(c), want = on === undefined ? !has : !!on; if (want && !has) set([...get(), c]); if (!want && has) set(get().filter(x => x !== c)); return want; }};
  }
  get children() { return this.childNodes.filter(c => c instanceof Element); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatch(type, extra = {}) {
    const ev = {type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra};
    for (const fn of [...(this.listeners[type] || [])]) fn(ev);
    return ev;
  }
  click() {
    if (this.disabled) return;
    if ((this.attrs.get('type') === 'checkbox')) { this.checked = !this.checked; this.dispatch('change'); }
    else if (this.attrs.get('type') === 'radio') { this.checked = true; this.dispatch('change'); }
    this.dispatch('click');
    if (this.tagName === 'BUTTON' && this.type === 'submit') this.closest('form')?.dispatch('submit');
  }
  focus() { globalThis.document.activeElement = this; }
  setSelectionRange() {}
  all(sel) { const out = []; const walk = n => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null; }
  closest(sel) { for (let x = this; x instanceof Element; x = x.parentNode) if (matchesSelector(x, sel)) return x; return null; }
  get elements() {
    const out = {};
    for (const x of this.all('*')) if (x.name && !(x.name in out) && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(x.tagName)) out[x.name] = x;
    return out;
  }
  reset() {}
}

// Selectors: compound simple selectors (tag, #id, .class, [attr], [attr=value]) joined by descendant (space) or child
// (>) combinators; no commas, no pseudo-classes.
function parseCompound(s) {
  const c = {tag: null, id: null, classes: [], attrs: []};
  const re = /([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toUpperCase(); else if (m[2]) c.id = m[2]; else if (m[3]) c.classes.push(m[3]); else c.attrs.push([m[4], m[5]]);
  }
  return c;
}
function matches(el, s) {
  const c = typeof s === 'string' ? parseCompound(s) : s;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (c.classes.some(x => !el.classList.contains(x))) return false;
  return c.attrs.every(([k, v]) => (v === undefined ? el.hasAttribute(k) || (k === 'type' && el.type) : String(el.getAttribute(k) ?? (k === 'type' ? el.type : '')) === v));
}
function tokens(sel) { return sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/); }
function matchesSelector(el, sel) {
  const parts = tokens(sel);
  const rec = (node, i) => {
    if (!matches(node, parts[i])) return false;
    if (i === 0) return true;
    if (parts[i - 1] === '>') return node.parentNode instanceof Element && rec(node.parentNode, i - 2);
    for (let p = node.parentNode; p instanceof Element; p = p.parentNode) if (rec(p, i - 1)) return true;
    return false;
  };
  return rec(el, parts.length - 1);
}
function queryAll(root, sel) {
  const out = [];
  const walk = n => { for (const c of n.children) { if (matchesSelector(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

export class FormData {
  constructor(form) {
    this.entries = [];
    for (const x of form ? form.all('*') : []) {
      if (!x.name || x.disabled) continue;
      if (x.tagName === 'INPUT' && (x.type === 'checkbox' || x.type === 'radio')) { if (x.checked) this.entries.push([x.name, x.value]); }
      else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(x.tagName)) this.entries.push([x.name, x.value]);
    }
  }
  get(k) { return this.entries.find(([n]) => n === k)?.[1] ?? null; }
  getAll(k) { return this.entries.filter(([n]) => n === k).map(([, v]) => v); }
}

// The page skeleton of public/pilot.html: every element pilot.js looks up by id or selector.
export function makeDocument() {
  const body = new Element('body');
  const doc = {
    body, title: '', hidden: false, activeElement: null,
    createElement: t => new Element(t), createTextNode: t => new Text(t),
    querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s),
  };
  const E = (tag, attrs = {}, ...kids) => { const e = new Element(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
  const form = (id, ...inputs) => E('form', {id}, ...inputs, E('button', {type: 'submit'}, 'Submit'));
  body.append(
    E('span', {id: 'conn'}), E('div', {id: 'offline', hidden: ''}),
    E('nav', {id: 'tabs'}, E('a', {href: '#network', 'data-tab': 'network'}), E('a', {href: '#join', 'data-tab': 'join'}), E('a', {href: '#owner', 'data-tab': 'owner'}, E('span', {id: 'pending-badge'}))),
    E('main', {},
      E('section', {id: 'tab-network', class: 'tab'}, E('div', {id: 'info'}), E('span', {id: 'net-updated'}), E('button', {id: 'net-refresh', type: 'button'}),
        E('div', {id: 'directory'}), E('div', {id: 'ledger'}), E('div', {id: 'reconcile'})),
      E('section', {id: 'tab-join', class: 'tab'}, E('div', {id: 'join-result'}), E('div', {id: 'join-grid'}, form('join-form', E('input', {name: 'invite'})), E('div', {id: 'join-msg'}))),
      E('section', {id: 'tab-owner', class: 'tab'}, E('div', {id: 'owner-login'}, form('login-form', E('input', {name: 'token'}), E('input', {name: 'keep', type: 'checkbox'})), E('div', {id: 'login-msg'})),
        E('div', {id: 'owner-console'}), E('div', {id: 'deal-view'}))));
  return doc;
}

// Installs a fresh page (document, window, location, sessionStorage, FormData, Node) and a fake fetch serving
// `routes(method, path, body, headers)` -> {status, body} | undefined (404). Returns the page and the request log.
// setInterval is replaced by a recorder while pilot.js is imported, so its polling timers never run.
export function installPage({routes, token = null, hash = ''}) {
  const doc = makeDocument(), store = new Map(token ? [['valun-pilot-owner-token', token]] : []), calls = [], listeners = {};
  Object.assign(globalThis, {document: doc, Node, Text, Element, FormData,
    window: {addEventListener: (t, f) => { (listeners[t] ??= []).push(f); }, scrollTo() {}},
    location: {hash, origin: 'http://console.test'},
    sessionStorage: {getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); }}});
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://console.test'), body = opts.body ? JSON.parse(opts.body) : undefined;
    const path = u.pathname.replace(/^\/pilot\/v1/, '') + u.search;
    calls.push({method: opts.method || 'GET', path, body, auth: opts.headers?.authorization ?? null});
    const r = routes(opts.method || 'GET', path, body, opts.headers || {}) ?? {status: 404, body: {error: 'not_found', message: 'not found'}};
    const text = JSON.stringify(r.body ?? {});
    return {ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text};
  };
  return {doc, calls, store, hashchange: () => { for (const f of listeners.hashchange || []) f(); }};
}

// Lets the page's pending promises (fetches, renders) finish.
export async function settle(rounds = 30) { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); }
// The text of a node, with whitespace runs collapsed.
export const text = n => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
// The elements under `root` whose own text (including descendants) contains `s`, innermost first.
export function findByText(root, s, tag = null) {
  const out = [];
  const walk = n => { for (const c of n.children) { walk(c); if ((!tag || c.tagName === tag.toUpperCase()) && c.textContent.includes(s)) out.push(c); } };
  walk(root);
  return out;
}
