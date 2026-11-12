// valun-deal/1: protocol constants, canonical JSON, terms hash and the signed statement texts (spec sections 7 and 8).

import {bytesToHex, utf8} from './bytes.js';
import {ValunError} from './errors.js';
import {str} from './py.js';
import {sha256} from './sha256.js';

export const NETWORK = 'valun-pilot-1';   // the default network: a profile enrolled before 0.5 is on it
/** The networks this client signs for (as the Python client's NETWORKS): amounts are whole numbers in `unit`; `scale`
 *  sizes the defaults written in PC (never a signed amount). valun-testnet-1 is Ergo TESTNET (nanoERG, test coins). */
export const NETWORKS = Object.freeze({'valun-pilot-1': Object.freeze({unit: 'PC', scale: 1}),
  'valun-testnet-1': Object.freeze({unit: 'nanoERG', scale: 1_000_000})});
export function networkOf(name) {
  if (typeof name !== 'string' || !Object.hasOwn(NETWORKS, name)) {
    throw new ValunError('unknown_network', `this client does not know the Valun network ${JSON.stringify(name)} (it knows ${Object.keys(NETWORKS).join(', ')}); nothing was signed. Update the client if this is a new network.`);
  }
  return NETWORKS[name];
}
export const PROTOCOL = 'valun-deal/1';
export const UNIT = 'PC';
/** An amount as people read it, in its network's unit: '3 PC' on the pilot; '3000000 nanoERG (0.003 tERG)' on the
 *  testnet (exact: whole nanoERG to tERG by integer arithmetic). Anything but a whole number is shown as is, as
 *  Python's str() shows it (the Python client's amount_text). */
export function amountText(n, unit = UNIT) {
  if (unit !== 'nanoERG' || !Number.isInteger(n)) return `${str(n)} ${unit}`;
  const a = BigInt(Math.abs(n)), whole = a / 1_000_000_000n, frac = a % 1_000_000_000n;
  const terg = `${whole}.${String(frac).padStart(9, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
  return `${n} nanoERG (${n < 0 ? '-' : ''}${terg} tERG)`;
}
export const CONSIDERATION = 'credit_note_on_delivery_accepted';
/** sha256hex("valun-pilot-credit/1"): the pilot's PC token id (it exists on no chain). */
export const PILOT_TOKEN_ID = bytesToHex(sha256(utf8('valun-pilot-credit/1')));
export const PILOT_DENOMINATION = `token:${PILOT_TOKEN_ID}`;
/** The pilot server the Python CLI uses by default. The Client never contacts it unless you pass it as `server`. */
export const DEFAULT_SERVER = 'https://valun-desk.fly.dev';

/** Lowercase hex SHA-256 of a string's UTF-8 bytes (or of a byte array). */
export function sha256Hex(x) {
  if (typeof x === 'string') return bytesToHex(sha256(utf8(x)));
  if (x instanceof Uint8Array) return bytesToHex(sha256(x));
  throw new TypeError('sha256Hex takes a string or a Uint8Array');
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The server's canonical JSON (core.mjs canonical()): object keys sorted by UTF-16 code units, no whitespace, strings
 * exactly as ECMAScript JSON.stringify writes them (non-ASCII kept as is, lone surrogates as \udxxx), numbers as
 * ECMAScript prints them (-0 -> 0). Refuses values JSON cannot carry (undefined, functions, BigInt, NaN, Infinity,
 * class instances) instead of guessing.
 */
export function canonical(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new ValunError('bad_terms', 'unsupported value in terms: a non-finite number');
      return JSON.stringify(v);
    case 'object':
      if (!isPlainObject(v)) throw new ValunError('bad_terms', 'unsupported value in terms: a non-plain object');
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    default:
      throw new ValunError('bad_terms', `unsupported value in terms: ${typeof v}`);
  }
}

/** terms_hash = sha256hex(canonical(terms)). */
export function termsHash(terms) {
  return sha256Hex(canonical(terms));
}

/** A statement text: "valun-pilot/<kind>/1" and the parts, joined by LF, no trailing newline. */
export function statement(kind, ...parts) {
  return [`valun-pilot/${kind}/1`, ...parts].join('\n');
}

/** The statement each act signs (spec 8.1). Reasons, content and enrollment codes are hashed here, exactly as given. */
export const statements = Object.freeze({
  enroll: (participantId, pubkey, enrollmentCode, network = NETWORK) =>
    statement('enroll', network, participantId, pubkey, sha256Hex(enrollmentCode)),
  propose: termsHashHex => statement('propose', termsHashHex),
  accept: termsHashHex => statement('accept', termsHashHex),
  decline: (termsHashHex, reason) => statement('decline', termsHashHex, sha256Hex(reason)),
  withdraw: termsHashHex => statement('withdraw', termsHashHex),
  deliver: (termsHashHex, content) => statement('deliver', termsHashHex, sha256Hex(content)),
  complete: (termsHashHex, deliverableSha256) => statement('complete', termsHashHex, deliverableSha256),
  dispute: (termsHashHex, deliverableSha256, reason) => statement('dispute', termsHashHex, deliverableSha256, sha256Hex(reason)),
});

/**
 * The server's text normalisation clean() without its length checks (spec 2.3): C0 controls except TAB/LF/CR and DEL
 * become spaces, then ECMAScript trim(). The server stores and shows reasons in this form.
 */
export function cleanText(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
}

/**
 * The characters the text rule starts from (spec 2.3, release v13): controls (Cc), format characters (Cf) and
 * Default_Ignorable_Code_Point characters. A superset of what the server refuses: TAB/LF/CR, the five single marks and
 * the selectors, keycaps and flags of the rule's contexts are allowed. To test text, use hasUnsafeText(); a check with
 * this expression alone is stricter than the server.
 */
export const REASON_UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /\p{Emoji}/u;
// ZWNJ, ZWJ, LRM, RLM, ALM: allowed singly, never two in a row
const SINGLE_OK = new Set([0x200c, 0x200d, 0x200e, 0x200f, 0x061c]);
const FLAG_TAGS = new Set(['gbeng', 'gbsct', 'gbwls']);   // the RGI subdivision flags of England, Scotland, Wales
const keycapBase = cp => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a;

/**
 * Does the server (release v13, valun-app 6a6a34b, core.mjs hasUnsafeText) refuse this text? Spec 2.3, normative: per
 * code point (a lone surrogate counts as one), TAB/LF/CR are allowed; ZWNJ, ZWJ, LRM, RLM and ALM are allowed unless the
 * next code point is one of them too; U+FE0E/U+FE0F are allowed directly after an emoji other than 0-9, # and *, and
 * U+FE0F in a keycap (0-9, # or *, U+FE0F, U+20E3); U+1F3F4 followed by the tag letters gbeng, gbsct or gbwls and
 * U+E007F is allowed as a whole (the RGI flags of England, Scotland and Wales); any other Cc, Cf or
 * Default_Ignorable_Code_Point character is refused. Unicode properties are those of the JavaScript engine (the server's
 * is Node.js 24.21.0, Unicode 17.0). The same port of the server's function, step for step.
 */
export function hasUnsafeText(s) {
  const cps = Array.from(String(s), c => c.codePointAt(0));
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 9 || cp === 10 || cp === 13) continue;
    if (SINGLE_OK.has(cp)) {
      if (SINGLE_OK.has(cps[i + 1])) return true;
      continue;
    }
    if (cp === 0xfe0e || cp === 0xfe0f) {
      const prev = cps[i - 1];
      if (prev !== undefined && !keycapBase(prev) && EMOJI.test(String.fromCodePoint(prev))) continue;
      if (prev !== undefined && keycapBase(prev) && cp === 0xfe0f && cps[i + 1] === 0x20e3) continue;
      return true;
    }
    if (cp === 0x1f3f4) {
      let j = i + 1, tag = '';
      while (j < cps.length && cps[j] >= 0xe0061 && cps[j] <= 0xe007a && tag.length < 6) tag += String.fromCharCode(cps[j++] - 0xe0000);
      if (cps[j] === 0xe007f && FLAG_TAGS.has(tag)) i = j;
      continue;
    }
    if (REASON_UNSAFE.test(String.fromCodePoint(cp))) return true;
  }
  return false;
}

const REASON_LIMITS = {decline: {max: 500, raw: 600, required: false}, dispute: {max: 1000, raw: 1100, required: true}};

/**
 * The refusal the server (release v13) gives for a decline or dispute reason before checking any signature, as
 * {error: 'invalid_field', message}, or null when it accepts the reason. In the server's order: the type, the raw length
 * (at most 600 / 1100 UTF-16 code units), the refused characters, then clean(): a dispute needs a reason, and the cleaned
 * text may have at most 500 / 1000 code units.
 */
export function reasonProblem(kind, reason) {
  const lim = REASON_LIMITS[kind];
  if (!lim) throw new TypeError('kind must be "decline" or "dispute"');
  const refuse = message => ({error: 'invalid_field', message});
  if (reason === null || reason === undefined) reason = '';   // the server counts null/absent as ""
  if (typeof reason !== 'string') return refuse('reason must be text');
  if (reason.length > lim.raw) {
    return refuse(`reason is longer than ${lim.raw} characters, counting leading and trailing whitespace (at most ${lim.max} without it)`);
  }
  if (hasUnsafeText(reason)) return refuse('reason contains control, bidi or invisible characters; remove them and sign again');
  if (reason === '') return lim.required ? refuse('reason is required') : null;
  const cleaned = cleanText(reason);
  if (cleaned.length > lim.max) return refuse(`reason is longer than ${lim.max} characters`);
  if (lim.required && cleaned === '') return refuse('reason is required');
  return null;
}

/**
 * Text from the server or a counterparty, safe to show to a person or a model: every control, format (bidi, zero-width,
 * BOM, soft hyphen, tag characters), line/paragraph separator and lone surrogate is replaced by a visible \u{XXXX}
 * marker. TAB, LF and CR are kept. For display only: never sign or hash the result.
 */
export function neutralize(text) {
  return String(text).replace(/(?![\t\n\r])[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu,
    ch => `\\u{${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`);
}
