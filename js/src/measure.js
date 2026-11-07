// Deterministic facts about a delivery, for the agent that reviews it (port of python/src/valun/measure.py).
//
// Counts words and links and checks them against the numeric requirements written in the agreed terms ("300-500
// words", "at least 3 cited sources"), and can check whether each link's host name exists in DNS. These are
// measurements, not judgements: whether the work is accurate, on topic and good is still the reviewing agent's call.
// DNS only: no page is fetched, no connection is opened to the linked hosts. This module looks nothing up by itself:
// host checks need a resolver (in Node: resolveHost from "valun/dns"); without one (a browser) the result says the hosts
// were not checked. The regular expressions follow Python's semantics (its whitespace, re.IGNORECASE letters, Unicode
// digits), so both implementations measure the same text the same way.

import {DIGIT, PyError, WS, ci, digitsInt, or, rstripChars, truthy, typeName} from './py.js';

const S = `[${WS}]`;
const URL_RE = new RegExp(`${ci('http')}${ci('s')}?://[^${WS}<>\\[\\]"'\`]+`, 'gu');
const HOST_RE = new RegExp(`^${ci('http')}${ci('s')}?://([^/:?#]+)`, 'u');
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g;
const WORDS = `${ci('word')}${ci('s')}?`;
const WORD_RANGE = new RegExp(`(${DIGIT}{2,5})${S}*(?:-|\u2013|\u2014|${ci('to')})${S}*(${DIGIT}{2,5})[${WS}\\-]*${WORDS}`, 'u');
const MIN_WORDS = new RegExp(`(?:${ci('at least')}|${ci('minimum')}(?: ${ci('of')})?|${ci('min')}\\.?|${ci('no fewer than')})${S}*(${DIGIT}{2,5})${S}*${WORDS}`, 'u');
const MAX_WORDS = new RegExp(`(?:${ci('at most')}|${ci('up to')}|${ci('maximum')}(?: ${ci('of')})?|${ci('max')}\\.?|${ci('under')}|${ci('no more than')})${S}*(${DIGIT}{2,5})${S}*${WORDS}`, 'u');
const MIN_LINKS = new RegExp(`${ci('at least')}${S}*(${DIGIT}{1,2})${S}*(?:${ci('cited')}${S}+|${ci('linked')}${S}+)?(?:${ci('sources')}|${ci('links')}|${ci('references')}|${ci('citations')})`, 'u');

export const MAX_LINKS_CHECKED = 10;
export const HOW_MEASURED = 'by your plugin, deterministically: words = runs of letters/digits; links = distinct http(s) URLs. '
  + 'These are facts to use in your review, not a verdict on quality, accuracy or relevance.';
/** Shown instead of link_hosts when host checks are on but this runtime has no DNS resolver (JavaScript only). */
export const HOSTS_NOT_CHECKED = 'Link hosts were not looked up: this Valun client has no DNS resolver in this runtime (for '
  + 'example a browser), so it cannot tell whether the link hosts exist. Judge the sources yourself.';
const TIMED_OUT = 'unknown (lookup timed out)';

function text0(v) {
  const t = or(v, '');
  if (typeof t !== 'string') throw new PyError('TypeError', `expected string or bytes-like object, got '${typeName(t)}'`);
  return t;
}

export function wordCount(text) {
  return (text0(text).match(WORD_RE) || []).length;
}

/** Distinct http(s) URLs in order of first appearance, without trailing punctuation or an unbalanced closing bracket. */
export function links(text) {
  const out = [];
  for (const m of text0(text).matchAll(URL_RE)) {
    let u = rstripChars(m[0], '.,;:!?*_');
    // "(see https://x/y)." -> drop the closing bracket
    while (u.endsWith(')') && u.split(')').length > u.split('(').length) u = rstripChars(u.slice(0, -1), '.,;:!?*_');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** The lower-cased host name of an http(s) URL, or ''. */
export function hostOf(url) {
  const m = HOST_RE.exec(url);
  return m ? m[1].toLowerCase() : '';
}

/** Numeric requirements found in the agreed service text (title, description, deliverable). */
export function requirements(termsText) {
  const t = text0(termsText), req = {};
  let m = WORD_RANGE.exec(t);
  if (m) {
    const [lo, hi] = [digitsInt(m[1]), digitsInt(m[2])].sort((a, b) => a - b);
    req.min_words = lo;
    req.max_words = hi;
  } else {
    if ((m = MIN_WORDS.exec(t))) req.min_words = digitsInt(m[1]);
    if ((m = MAX_WORDS.exec(t))) req.max_words = digitsInt(m[1]);
  }
  if ((m = MIN_LINKS.exec(t))) req.min_links = digitsInt(m[1]);
  return req;
}

// ---------- DNS: what the addresses a host name resolves to say about it ----------
const V4 = (s, p) => ({net: parseV4(s), prefix: p, bits: 32});
const V6 = (s, p) => ({net: parseV6(s), prefix: p, bits: 128});
// CPython 3.14 ipaddress: not globally reachable blocks of the IANA special-purpose registries, and their exceptions.
const V4_PRIVATE = [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.0.170', 31], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['240.0.0.0', 4], ['255.255.255.255', 32]].map(([s, p]) => V4(s, p));
const V4_EXCEPTIONS = [V4('192.0.0.9', 32), V4('192.0.0.10', 32)];
const V4_SHARED = V4('100.64.0.0', 10);          // neither private nor global
const V6_PRIVATE = [['::1', 128], ['::', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10]].map(([s, p]) => V6(s, p));
const V6_EXCEPTIONS = [['2001:1::1', 128], ['2001:1::2', 128], ['2001:3::', 32], ['2001:4:112::', 48], ['2001:20::', 28],
  ['2001:30::', 28]].map(([s, p]) => V6(s, p));

function parseV4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const x of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(x) || Number(x) > 255) return null;
    n = n * 256n + BigInt(x);
  }
  return n;
}

function parseV6(s) {
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let body = s, tail = [];
  if (s.includes('.')) {                       // an IPv4 address in the last 32 bits
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    body = s.slice(0, lastColon + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const groups = h => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]), back = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...back].every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const n = head.length + back.length + tail.length;
  if (halves.length === 2 ? n > 7 : n !== 8) return null;   // "::" stands for at least one group
  const words = [...head.map(g => parseInt(g, 16)), ...Array(8 - n).fill(0), ...back.map(g => parseInt(g, 16)), ...tail];
  return words.reduce((x, w) => (x << 16n) | BigInt(w), 0n);
}

const inNet = (x, {net, prefix, bits}) => x >> BigInt(bits - prefix) === net >> BigInt(bits - prefix);

function v4Global(x) {
  const priv = V4_PRIVATE.some(n => inNet(x, n)) && !V4_EXCEPTIONS.some(n => inNet(x, n));
  return !inNet(x, V4_SHARED) && !priv;
}

/** Python's ipaddress.ip_address(a).is_global for an IPv4 or IPv6 address string. Throws TypeError if it is neither. */
export function isGlobalAddress(address) {
  const s = String(address);
  const v4 = parseV4(s);
  if (v4 !== null) return v4Global(v4);
  const v6 = s.includes(':') ? parseV6(s) : null;
  if (v6 === null) throw new TypeError(`${JSON.stringify(s)} does not appear to be an IPv4 or IPv6 address`);
  if (v6 >> 32n === 0xffffn) return v4Global(v6 & 0xffffffffn);       // IPv4-mapped: the IPv4 address decides
  return !(V6_PRIVATE.some(n => inNet(v6, n)) && !V6_EXCEPTIONS.some(n => inNet(v6, n)));
}

/** 'public' if any address is globally reachable, else 'private' (only private, loopback or reserved addresses). */
export function classifyAddresses(addresses) {
  return addresses.some(a => isGlobalAddress(String(a).split('%')[0])) ? 'public' : 'private';
}

/**
 * A host checker from an address lookup: lookupAll(host) resolves to the host's address strings (or rejects when the
 * name does not exist). The checker resolves to 'public' | 'private' | 'not_found', as the Python resolver does.
 */
export function hostResolver(lookupAll) {
  if (typeof lookupAll !== 'function') throw new TypeError('hostResolver needs a lookup function');
  return async host => {
    let addresses;
    try {
      addresses = await lookupAll(host);
    } catch {
      return 'not_found';
    }
    return classifyAddresses([...new Set(addresses)]);
  };
}

/**
 * {host: 'public' | 'private' | 'not_found' | 'unknown (lookup timed out)'} for the distinct hosts of `urls` (at most
 * MAX_LINKS_CHECKED), looked up concurrently, waiting at most timeoutMs (default 4000) for all of them together.
 */
export async function hostStatus(urls, resolveHost, {timeoutMs = 4000} = {}) {
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))].slice(0, MAX_LINKS_CHECKED);
  const result = new Map(hosts.map(h => [h, TIMED_OUT]));   // a Map, so a host called "__proto__" is kept like any other
  if (!hosts.length) return {};
  let open = true, timer, failure;
  const work = Promise.all(hosts.map(h => Promise.resolve().then(() => resolveHost(h)).then(
    s => { if (open) result.set(h, s); },
    e => { if (open && failure === undefined) failure = {e}; })));
  await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  open = false;
  clearTimeout(timer);
  if (failure) throw failure.e;
  return Object.fromEntries(result);
}

/**
 * The measurements of a delivery against the agreed terms text (Python measure.measure). Resolves to
 * {word_count, links, checks_against_agreed_terms, how_measured} plus, when checkHosts and there are links: link_hosts
 * (and a warning for hosts that do not exist), or link_hosts_not_checked when no resolveHost is given.
 */
export async function measure(text, termsText, {checkHosts = true, resolveHost = null, timeoutMs = 4000} = {}) {
  const words = wordCount(text), found = links(text);
  const req = requirements(termsText), checks = [];
  if ('min_words' in req || 'max_words' in req) {
    const lo = req.min_words ?? null, hi = req.max_words ?? null;
    const ok = (lo === null || words >= lo) && (hi === null || words <= hi);
    const want = lo !== null && hi !== null ? `${lo}-${hi} words` : (lo !== null ? `at least ${lo} words` : `at most ${hi} words`);
    checks.push({requirement: want, measured: `${words} words`, met: ok});
  }
  if ('min_links' in req) {
    checks.push({requirement: `at least ${req.min_links} sources with links`, measured: `${found.length} distinct links`,
      met: found.length >= req.min_links});
  }
  const out = {word_count: words, links: found, checks_against_agreed_terms: checks, how_measured: HOW_MEASURED};
  if (truthy(checkHosts) && found.length) {
    if (typeof resolveHost !== 'function') {
      out.link_hosts_not_checked = HOSTS_NOT_CHECKED;
      return out;
    }
    const st = await hostStatus(found, resolveHost, {timeoutMs});
    out.link_hosts = st;
    const missing = Object.entries(st).filter(([, s]) => s === 'not_found').map(([h]) => h);
    if (missing.length) {
      out.warning = 'These link hosts do not exist in DNS, so those sources cannot be real: ' + missing.join(', ')
        + '. A source whose link cannot work does not count as a working link.';
    }
  }
  return out;
}
