// Python semantics that the agent tools depend on, so this port gives the results the Python reference
// (python/src/valun) gives: str.isspace() whitespace (= re's \s), strip()/split()/splitlines(), the letters re.IGNORECASE
// matches, \d (any Unicode decimal digit) and int(), truthiness of `x or default`, str()/repr() of JSON values, dict
// subscripts that raise KeyError, == between JSON values, and code point ordering of strings.
// Internal module (not exported from index.js). Measured against CPython 3.14 over every code point; the Unicode
// tables are the JavaScript engine's own, so characters newer than Python's Unicode version may differ.

/** Python whitespace (str.isspace(), re's \s for str patterns) as the body of a regex character class (u flag). */
export const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's \d for str patterns: Unicode category Nd (u flag). */
export const DIGIT = '\\p{Nd}';

const WS_CHAR = new RegExp(`^[${WS}]$`, 'u');
const WS_RUN = new RegExp(`[${WS}]+`, 'u');
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const ND_CHAR = /^\p{Nd}$/u;
const INT_LITERAL = new RegExp(`^[${WS}]*([+-]?)(${DIGIT}+(?:_${DIGIT}+)*)[${WS}]*$`, 'u');
const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
// Letters re.IGNORECASE matches beyond their two ASCII cases (CPython 3.14, measured over every code point).
const CASE_EXTRA = {i: '\u0130\u0131', k: '\u212a', s: '\u017f'};

/** A Python exception as JavaScript sees it: errorPayload() prints `${name}: ${message}`, like type(e).__name__. */
export class PyError extends Error {
  constructor(type, message) {
    super(message);
    this.name = type;
  }
}

export const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function typeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isSafeInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return typeof v === 'object' ? 'dict' : typeof v;
}

/** bool(v) for JSON values (NaN is truthy in Python). */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python `v or dflt`. */
export const or = (v, dflt) => (truthy(v) ? v : dflt);

/** dict.get(key, dflt): AttributeError on anything that is not a dict. */
export function get(obj, key, dflt = null) {
  if (isDict(obj)) return Object.hasOwn(obj, key) ? obj[key] : dflt;
  throw new PyError('AttributeError', `'${typeName(obj)}' object has no attribute 'get'`);
}

/** obj[key] on a dict: KeyError when absent, TypeError on what is not subscriptable by a string. */
export function item(obj, key) {
  if (isDict(obj)) {
    if (Object.hasOwn(obj, key)) return obj[key];
    throw new PyError('KeyError', repr(key));
  }
  if (Array.isArray(obj)) throw new PyError('TypeError', 'list indices must be integers or slices, not str');
  if (typeof obj === 'string') throw new PyError('TypeError', "string indices must be integers, not 'str'");
  throw new PyError('TypeError', `'${typeName(obj)}' object is not subscriptable`);
}

/** dict.items() as entries: AttributeError on anything that is not a dict. */
export function items(obj) {
  if (isDict(obj)) return Object.entries(obj);
  throw new PyError('AttributeError', `'${typeName(obj)}' object has no attribute 'items'`);
}

/** Iterating a JSON value as Python does: lists by element, strings by character, dicts by key. */
export function iterate(v) {
  if (Array.isArray(v) || typeof v === 'string') return [...v];
  if (isDict(v)) return Object.keys(v);
  throw new PyError('TypeError', `'${typeName(v)}' object is not iterable`);
}

function needStr(v, method) {
  if (typeof v !== 'string') throw new PyError('AttributeError', `'${typeName(v)}' object has no attribute '${method}'`);
  return v;
}

export const isSpace = ch => WS_CHAR.test(ch);

/** str.strip() (Python whitespace). */
export function strip(s) {
  needStr(s, 'strip');
  let a = 0, b = s.length;
  while (a < b && isSpace(s[a])) a++;
  while (b > a && isSpace(s[b - 1])) b--;
  return s.slice(a, b);
}

/** str.rstrip(chars) for ASCII `chars`. */
export function rstripChars(s, chars) {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1])) b--;
  return s.slice(0, b);
}

/** str.lower() (the engine's full Unicode lower-casing, as Python's). */
export const lower = s => needStr(s, 'lower').toLowerCase();

/** str.split() with no arguments. */
export const splitWords = s => s.split(WS_RUN).filter(Boolean);

/** len(str.splitlines()). */
export function lineCount(s) {
  if (!s) return 0;
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** len(str): code points (a lone surrogate counts as one, as in a Python str). */
export function cpLength(s) {
  if (typeof s !== 'string') throw new PyError('TypeError', `object of type '${typeName(s)}' has no len()`);
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[:n] by code points. */
export function cpSlice(s, n) {
  let out = '', i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

/** v[:n] of a str (by code points) or a list; anything else fails as in Python. */
export function slice(v, n) {
  if (typeof v === 'string') return cpSlice(v, n);
  if (Array.isArray(v)) return v.slice(0, n);
  if (isDict(v)) throw new PyError('KeyError', `slice(None, ${n}, None)`);
  throw new PyError('TypeError', `'${typeName(v)}' object is not subscriptable`);
}

/** dict(v): a shallow copy of a dict, or the dict of a list of key/value pairs; TypeError or ValueError otherwise. */
export function dictCopy(v) {
  if (isDict(v)) return {...v};
  if (!Array.isArray(v) && typeof v !== 'string') throw new PyError('TypeError', `'${typeName(v)}' object is not iterable`);
  const out = {};
  [...v].forEach((e, i) => {
    if (!Array.isArray(e) && typeof e !== 'string') {
      throw new PyError('TypeError', `cannot convert dictionary update sequence element #${i} to a sequence`);
    }
    const pair = [...e];
    if (pair.length !== 2) throw new PyError('ValueError', `dictionary update sequence element #${i} has length ${pair.length}; 2 is required`);
    Object.defineProperty(out, str(pair[0]), {value: pair[1], enumerable: true, writable: true, configurable: true});
  });
  return out;
}

/** Python string ordering (by code point, not by UTF-16 unit). */
export function cmpCodePoints(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i), y = b.codePointAt(j);
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (i < a.length) - (j < b.length);
}

function digitValue(ch) {
  // Decimal digits are encoded in contiguous runs 0..9 (Unicode stability policy); adjacent runs form one block.
  const cp = ch.codePointAt(0);
  let start = cp;
  while (ND_CHAR.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** int() of a string of Unicode decimal digits. */
export function digitsInt(s) {
  let n = 0;
  for (const ch of s) n = n * 10 + digitValue(ch);
  return n;
}

/** int(v) for JSON values: truncates floats, parses strings as Python does (whitespace, sign, _ separators, Nd digits). */
export function int(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new PyError('ValueError', 'cannot convert float NaN to integer');
    if (!Number.isFinite(v)) throw new PyError('OverflowError', 'cannot convert float infinity to integer');
    return Math.trunc(v) || 0;
  }
  if (typeof v === 'string') {
    const m = INT_LITERAL.exec(v);
    if (m) {
      const n = digitsInt(m[2].replaceAll('_', ''));
      return (m[1] === '-' ? -n : n) || 0;
    }
    throw new PyError('ValueError', `invalid literal for int() with base 10: ${repr(v)}`);
  }
  throw new PyError('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}

function hex(cp, width) {
  return cp.toString(16).padStart(width, '0');
}

function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
    else if (cp < 0x7f || !NON_PRINTABLE.test(ch)) out += ch;
    else if (cp < 0x100) out += '\\x' + hex(cp, 2);
    else if (cp < 0x10000) out += '\\u' + hex(cp, 4);
    else out += '\\U' + hex(cp, 8);
  }
  return out + q;
}

function floatRepr(v) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  const [mant, e] = v.toExponential().split('e');        // shortest digits that round-trip, as Python's repr
  const exp = Number(e), neg = mant.startsWith('-'), digits = mant.replace('-', '').replace('.', '');
  let out;
  if (exp >= -4 && exp < 16) {
    out = exp >= 0
      ? digits.slice(0, exp + 1).padEnd(exp + 1, '0') + '.' + (digits.slice(exp + 1) || '0')
      : '0.' + '0'.repeat(-exp - 1) + digits;
  } else {
    out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  }
  return (neg ? '-' : '') + out;
}

/**
 * repr(v) of a JSON value. A safe integer is an int, any other number a float (JavaScript cannot tell 5.0 from 5, nor
 * 10000000000000000000000 from 1e22: Python reads the first as int, the second as float).
 */
export function repr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : floatRepr(v);
  if (typeof v === 'string') return strRepr(v);
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => strRepr(k) + ': ' + repr(x)).join(', ') + '}';
  return String(v);
}

/** str(v) (and f-string formatting) of a JSON value. */
export const str = v => (typeof v === 'string' ? v : repr(v));

/** Python == between JSON values (True == 1, 1 == 1.0, lists and dicts element-wise). */
export function pyEq(a, b) {
  a ??= null;
  b ??= null;
  if (a === null || b === null) return a === b;
  const na = typeof a === 'number' || typeof a === 'boolean', nb = typeof b === 'number' || typeof b === 'boolean';
  if (na || nb) return na && nb && Number(a) === Number(b);
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (!isDict(a) || !isDict(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
}

/** A case-insensitive literal as Python's re.IGNORECASE matches it (letters only; other characters stay literal). */
export const ci = word => word.replace(/[A-Za-z]/g, ch => {
  const l = ch.toLowerCase();
  return `[${l}${l.toUpperCase()}${CASE_EXTRA[l] || ''}]`;
});

// HH[:MM[:SS[.f]]] or HH[MM[SS[.f]]] (one style per value), as fromisoformat reads times and UTC offsets.
const CLOCK = '(\\d{2})(?:(:?)(\\d{2})(?:\\2(\\d{2})(?:[.,](\\d+))?)?)?';
const ISO_DATE = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))/;
const ISO_CLOCK = new RegExp(`^${CLOCK}$`);

function clock(m) {
  return {h: Number(m[1]), mi: Number(m[3] || 0), s: Number(m[4] || 0), us: m[5] ? Number(m[5].slice(0, 6).padEnd(6, '0')) : 0};
}

/**
 * Milliseconds since the epoch of datetime.fromisoformat(s) when that gives an AWARE datetime (one with a UTC offset);
 * null where Python gives a naive datetime or raises ValueError. Covers the forms Python accepts for dates (extended
 * or basic calendar dates; not week dates), any one-character date/time separator, hour 24 (the next midnight), and
 * offsets of hours to fractional seconds. Callers replace 'Z' by '+00:00' first, as the Python code does.
 */
export function isoAwareMs(s) {
  const dm = ISO_DATE.exec(s);
  if (!dm || s.length <= dm[0].length + 1) return null;
  const [y, mo, d] = (dm[1] ? dm.slice(1, 4) : dm.slice(4, 7)).map(Number);
  const rest = [...s.slice(dm[0].length)].slice(1).join('');            // drop the separator (one code point)
  const k = rest.search(/[+-]/);
  if (k < 0) return null;                                                 // naive, or not ISO: no aware datetime
  const cm = ISO_CLOCK.exec(rest.slice(0, k)), om = ISO_CLOCK.exec(rest.slice(k + 1));
  if (!cm || !om) return null;
  const t = clock(cm), o = clock(om);
  const day = Date.UTC(y, mo - 1, d), back = new Date(day);
  if (y < 1 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (t.h === 24 ? t.mi || t.s || t.us : t.h > 23 || t.mi > 59 || t.s > 59) return null;
  if (o.mi > 59 || o.s > 59) return null;
  const offsetUs = ((o.h * 60 + o.mi) * 60 + o.s) * 1e6 + o.us;
  if (offsetUs >= 86_400e6) return null;
  const localMs = day + ((t.h * 60 + t.mi) * 60 + t.s) * 1000 + t.us / 1000;
  return localMs - (rest[k] === '-' ? -1 : 1) * offsetUs / 1000;
}
