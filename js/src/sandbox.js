// Exactly checkable services of the Valun sandbox agents (port of the service functions of python/src/valun/sandbox.py;
// the seller loop and the buyer command are not ported). Results are identical to the Python implementation (and to the
// server's sandbox agents): test/fixtures/sandbox-python.json and python-parity.json hold Python's own outputs.
//
// Services (the text to process goes in a ``` fenced block in the offer's description):
//   text-stats  exact statistics of the text: words (runs of non-whitespace, Python str.split()), characters (Unicode
//               code points), lines (str.splitlines()), unique words (lower-cased), SHA-256 of the UTF-8 bytes, the 10
//               most frequent words.
//   notary      the SHA-256 and byte length of the UTF-8 text.
// The text is the first ``` fenced block (without the fence lines), else everything after a final TEXT: label, else the
// only quoted string in the description. The delivery echoes the exact text processed.

import {utf8} from './bytes.js';
import {NETWORK, networkOf, sha256Hex} from './protocol.js';
import {PyError, WS, ci, cmpCodePoints, get, isDict, lineCount, lower, or, pyEq, repr, splitWords, str, strip, typeName} from './py.js';

export const SERVICES = Object.freeze({
  'text-stats': Object.freeze({price: 3, keywords: Object.freeze(['text-stats', 'text stats', 'text statistics', 'word count'])}),
  notary: Object.freeze({price: 2, keywords: Object.freeze(['notary', 'notar', 'sha-256', 'sha256'])}),
});
/** The published price of a sandbox service in a network's unit: the PC-sized price times the network's scale (PC on
 * the pilot; nanoERG on the testnet, x1e6), what the server's sandbox agents ask (lib/pilot/sandbox.mjs SERVICES). */
export const priceOf = (service, network = NETWORK) => SERVICES[service].price * networkOf(network || NETWORK).scale;
export const unitOf = (network = NETWORK) => networkOf(network || NETWORK).unit;
/** What the services cost and how to send the text, in the network's unit. */
export const servicesText = (network = NETWORK) => `text-stats (${priceOf('text-stats', network)} ${unitOf(network)}): exact `
  + 'word/character/line counts, unique words, SHA-256 and the 10 most frequent words of your text. notary '
  + `(${priceOf('notary', network)} ${unitOf(network)}): SHA-256 and byte length of your text. Put the text in a \`\`\` block, `
  + 'after TEXT: at the end, or as the only quoted string in the description. Deterministic: you can check every '
  + 'number yourself; the delivery echoes the exact text processed. I only do the work (payee).';
export const SERVICES_TEXT = servicesText();      // the pilot's (kept for callers that read it)
export const HOW_TO_SEND = 'Put the text in a ``` fenced block, after a "TEXT:" label at the end of the description, or as the only '
  + 'quoted string in the description. Example description: text-stats of "The quick brown fox."';

// Python: ^```[^\n]*\n(.*?)\n``` with re.S | re.M (^ only at the start or after "\n").
const FENCE = /(?:^|(?<=\n))```[^\n]*\n([\s\S]*?)\n```/u;
// Python: (?:^|\n)\s*TEXT\s*:\s*(.+)\Z with re.S | re.I.
const LABEL = new RegExp(`(?:^|\\n)[${WS}]*${ci('TEXT')}[${WS}]*:[${WS}]*([\\s\\S]+)$`, 'u');
const QUOTED = /"([^"\n]{1,16000})"|\u201c([^\u201d\n]{1,16000})\u201d/gu;
const RESULT_BLOCK = /```json\n([\s\S]*?)\n```/;

function text0(v) {
  const t = or(v, '');
  if (typeof t !== 'string') throw new PyError('TypeError', `expected string or bytes-like object, got '${typeName(t)}'`);
  return t;
}

/**
 * The text to process: a ``` fenced block; else everything after a final TEXT: label; else the only quoted string
 * ("..." or curly quotes). null if absent or ambiguous.
 */
export function extractText(description) {
  const d = text0(description);
  let m = FENCE.exec(d);
  if (m) return m[1];
  m = LABEL.exec(d);
  if (m) return strip(m[1]);
  const quoted = [...d.matchAll(QUOTED)].map(q => q[1] ?? q[2]);
  return quoted.length === 1 ? quoted[0] : null;
}

export function textStats(text) {
  const words = splitWords(text);
  const freq = new Map();
  for (const w of words) {
    const k = w.toLowerCase();                  // Python lower(), not casefold()
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  let characters = 0;
  for (const _ of text) characters++;
  return {words: words.length, characters, lines: lineCount(text), unique_words: freq.size, sha256: sha256Hex(text),
    top_words: [...freq].sort((a, b) => b[1] - a[1] || cmpCodePoints(a[0], b[0])).slice(0, 10).map(([w, n]) => [w, n])};
}

export function notary(text) {
  return {sha256: sha256Hex(text), bytes: utf8(text).length};
}

export const COMPUTE = Object.freeze({'text-stats': textStats, notary});

const HOW = {
  'text-stats': 'Words are runs of non-whitespace characters (Python str.split()); characters are Unicode code '
    + 'points; unique words and top words are lower-cased; SHA-256 is over the UTF-8 bytes of the text.',
  notary: 'SHA-256 and length are over the UTF-8 bytes of the text exactly as processed.',
};

/** The deliverable: a short explanation, the exact text processed (if given), and the exact result as JSON. */
export function render(service, result, text = null) {
  if (!Object.hasOwn(HOW, service)) throw new PyError('KeyError', repr(service));
  const shown = text === null || text === undefined ? '' : `Text processed (exactly, as a JSON string): ${JSON.stringify(text)}\n\n`;
  return `# ${service} result\n\n${HOW[service]}\n\n${shown}The result below is deterministic: anyone can recompute it from that `
    + `text.\n\n\`\`\`json\n${JSON.stringify(result, null, 1)}\n\`\`\`\n`;
}

/** The parsed ```json block of a delivery, or null. Throws (SyntaxError) when the block is not JSON, as Python raises. */
export function parseResult(content) {
  const m = RESULT_BLOCK.exec(text0(content));
  return m ? JSON.parse(m[1]) : null;
}

/** The exactly checkable service named in the terms' service text, or null. */
export function whichService(terms) {
  const svc = or(get(terms, 'service'), {});
  const hay = lower(['title', 'description', 'deliverable'].map(k => str(or(get(svc, k), ''))).join(' '));
  for (const [name, s] of Object.entries(SERVICES)) {
    if (s.keywords.some(k => hay.includes(k))) return name;
  }
  return null;
}

function keysOf(v) {
  if (isDict(v)) return Object.keys(v);
  if (Array.isArray(v) || typeof v === 'string') throw new PyError('AttributeError', `'${typeName(v)}' object has no attribute 'get'`);
  throw new PyError('TypeError', `'${typeName(v)}' object is not iterable`);
}

/**
 * For an exactly checkable service (text-stats, notary): recompute the result from the agreed text and compare it with
 * the delivered JSON. null when the deal is not such a service. The agent tools use it so that a model is told the fact
 * (match or not) instead of having to compute a SHA-256 or count words itself.
 */
export function checkDelivery(terms, content) {
  const service = whichService(terms);
  if (!service) return null;
  const text = extractText(get(or(get(terms, 'service'), {}), 'description'));
  if (text === null) return {service, checked: false, why: 'the agreed terms contain no text to recompute from'};
  const expected = COMPUTE[service](text), got = parseResult(content);
  if (got === null) {
    return {service, checked: true, exact_result_matches: false, why: 'the delivery has no ```json result block to compare', expected};
  }
  const keys = [...new Set([...Object.keys(expected), ...keysOf(got)])];
  const at = (o, k) => (Object.hasOwn(o, k) ? o[k] : null);
  const diff = keys.filter(k => !pyEq(at(got, k), at(expected, k))).sort(cmpCodePoints);
  return {service, checked: true, exact_result_matches: !diff.length, differs_in: diff,
    ...(diff.length ? {expected: Object.fromEntries(diff.map(k => [k, at(expected, k)])),
      delivered: Object.fromEntries(diff.map(k => [k, at(got, k)]))} : {}),
    how: 'recomputed by your Valun client from the agreed text; a mismatch means the delivered result is wrong'};
}
