// valun-deal/1: protocol constants, canonical JSON, terms hash and the signed statement texts (spec sections 7 and 8).

import {bytesToHex, utf8} from './bytes.js';
import {ValunError} from './errors.js';
import {sha256} from './sha256.js';

export const NETWORK = 'valun-pilot-1';
export const PROTOCOL = 'valun-deal/1';
export const UNIT = 'PC';
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
 * Characters the server refuses in decline and dispute reasons since release v9 (statements.json tier "refused"):
 * C0 controls except TAB/LF/CR, DEL, C1 controls, ZERO WIDTH SPACE, bidi embeddings/overrides and isolates, word
 * joiner and invisible operators, BOM, interlinear annotation and tag characters. ZWJ, ZWNJ, LRM, RLM, ALM, soft hyphen
 * and variation selectors are allowed. Exactly the set of spec section 2.3 (release v9), which also applies to signed
 * service text and public profile fields.
 */
export const REASON_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{200b}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{fff9}-\u{fffb}\u{e0000}-\u{e007f}]/u;

const REASON_LIMITS = {decline: {max: 500, raw: 600, required: false}, dispute: {max: 1000, raw: 1100, required: true}};

/**
 * The refusal the server (release v9) gives for a decline or dispute reason before checking any signature, as
 * {error: 'invalid_field', message}, or null when it accepts the reason. Lengths are UTF-16 code units: raw text at
 * most max + 100, cleaned text at most max (500 decline, 1000 dispute); a dispute needs a non-empty cleaned reason.
 */
export function reasonProblem(kind, reason) {
  const lim = REASON_LIMITS[kind];
  if (!lim) throw new TypeError('kind must be "decline" or "dispute"');
  const refuse = message => ({error: 'invalid_field', message});
  if (reason === null || reason === undefined) reason = '';   // the server counts null/absent as ""
  if (typeof reason !== 'string') return refuse('reason must be text');
  if (REASON_UNSAFE.test(reason)) return refuse('reason contains control, bidi or invisible characters; remove them and sign again');
  const cleaned = cleanText(reason);
  if (reason.length > lim.raw) return refuse(`reason is longer than ${lim.max} characters`);
  if (lim.required && cleaned === '') return refuse('reason is required');
  if (cleaned.length > lim.max) return refuse(`reason is longer than ${lim.max} characters`);
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
