// Valun pilot client: the participant side. Holds the participant's signing key locally and talks to a Valun server.
//
// A port of the Python reference client (python/src/valun/client.py). Trust model: the server is not trusted to tell
// this client what to sign. Before signing, the client recomputes the terms hash itself, checks the counterparty's
// signature against the key in the public directory, and checks credit-note templates against the agreed price and its
// own records of the edges it is party to (records.js). The key and the agent token live in a store and are never
// returned by any method, logged, or put into an error.
//
// Records (as in the Python client): a credit note is recorded as pending before it is sent, and confirmed only when
// the server answers note_issued (or a later read shows it applied); a held note an owner rejects is simply dropped
// (OQ-23). Every change to the records goes through store.update(fn) when the store has it (FileStore: under the
// profile lock shared with the Python client), and one Client makes its changes one after another (a promise chain),
// so concurrent calls never lose each other's records.

import {sign, verifyHex, noteMessage, publicKey, generateSecret as defaultGenerateSecret} from './basis.js';
import {bytesToHex, hexToBytes, utf8} from './bytes.js';
import {SignatureError, ValunError} from './errors.js';
import * as nv from './novation.js';
import {CONSIDERATION, NETWORK, PROTOCOL, UNIT, reasonProblem, sha256Hex, statement, statements, termsHash} from './protocol.js';
import {get as pyGet, isDict, or, pyEq, repr, str, strip, truthy, cpSlice} from './py.js';
import {randomBytes as defaultRandomBytes} from './random.js';
import * as records from './records.js';

const HOUR = 3600_000;
const NOTE_CLOCK_TOLERANCE_MS = 10 * 60_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Optional state keys a store keeps for this client (every store must keep them; all may be absent), as in the Python
 * client: issued {pair: confirmed total} of this client's outgoing edges (the 0.3 record, kept equal to the records'
 * confirmed total); records (records.js, with records.paid_deals {deal_id: {route, edge, total, timestamp}}: deals a
 * confirmed payment paid, never paid again); pins {tracker_nft_id, denomination} (R13); circulation (novation.js):
 * signed (R4), novated_edges (R12), transfer_attempts (D-1), approved_payments {deal_id: quote_digest}, consent_policy,
 * consent_loop, consents_last_run_ms and consent_log, journal_seq, consents_last_safe_run_ms (decision D-3 a) and
 * consent_roles_declared (the roles the server last took from this client's X-Valun-Features header; '' once it took
 * the empty list, decision D-3 b).
 */
export const CORE_STATE_KEYS = Object.freeze(['issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments',
  'consent_policy', 'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq', 'consents_last_safe_run_ms',
  'consent_roles_declared']);
/** Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them. */
export const RESERVED_MS_FROM = 995;
// Circulating credit (PROTOCOL.md 18; design 4.1, 6.3, 6.6, 11).
/** 'consents/1;roles=<roles>', sent once GET /info lists circulation/1. */
export const FEATURES_HEADER = 'X-Valun-Features';
/** [policy flag, header role] pairs, in header order. */
export const CONSENT_ROLES = Object.freeze([Object.freeze(['setoff', 'setoff']), Object.freeze(['as_issuer', 'issuer']),
  Object.freeze(['as_new_creditor', 'creditor'])]);
/** The consent roles (novation.ROLES) a run before a read-only tool may sign (decision D-3 a), and the same as header roles. */
export const VALUE_SAFE_ROLES = Object.freeze(['member', 'payee']);
export const VALUE_SAFE_HEADER_ROLES = Object.freeze(['setoff', 'creditor']);
/** processConsents() keeps the last 100 decisions in consent_log. */
export const CONSENT_LOG_MAX = 100;
/** What did not apply is dropped after 7 days (design 11). */
export const RECORDS_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A confirmed (applied) state keeps its signature 30 days (design 11). */
export const SIGNATURES_KEEP_MS = 30 * 24 * 3600 * 1000;
/** What the owner can decide about a payment attempt (decision D-2 d). */
export const ATTEMPT_OUTCOMES = Object.freeze(['not_applied', 'applied']);
export const UNRESOLVED_TRANSFER = Object.freeze(['outcome_unknown', 'inconsistent']);
export const LIVE_TRANSFER = Object.freeze(['awaiting_owner', 'collecting', 'applying']);
export const LOCAL_CHOICES = Object.freeze(['no_server_id', 'server_unknown', 'server_ended']);
export const RESOLVE_NOTE_MAX = 300;
/** GET /edges answers at most this many journal entries at a time; syncEdges() reads at most EDGES_MAX_PAGES pages. */
export const EDGES_PAGE = 200;
export const EDGES_MAX_PAGES = 50;
const JOURNAL_NOVATIONS = ['transfer_out', 'transfer_in', 'setoff'];     // journal kinds that make an edge bound-only
const EXPIRING_MS = [997, 998, 999];
const PUBLIC_ROUTES = ['/pilot/v1/info', '/pilot/v1/participants', '/pilot/v1/ledger', '/pilot/v1/clearing', '/pilot/v1/join',
  '/pilot/v1/join-sandbox', '/pilot/v1/enroll'];
const DEAL_ID_RE = /^vd_[0-9a-f]{16}$/;
const TRANSFER_ID_RE = /^vt_[0-9a-f]{16}$/;
const ATTEMPT_REF_RE = /^#[1-9][0-9]{0,3}$/;
const SERVER_WORD_RE = /^[a-z_]{1,40}$/;
// Default_Ignorable_Code_Point characters outside the categories C* (they hide text): refused in the owner's note.
const IGNORABLE = [[0x034F, 0x034F], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x3164, 0x3164],
  [0xFE00, 0xFE0F], [0xFFA0, 0xFFA0], [0xE0100, 0xE01EF]];
const UNSAFE_CATEGORY = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]$/u;
const UNREADABLE = "this profile's records cannot be read; nothing was signed";
const UNCHECKED = Symbol('unchecked');             // resolveAttempt({expectedAttempt}) not given: no check

/**
 * The consent roles a local consent policy signs by itself, as the capability header names them: a subset of
 * ['setoff', 'issuer', 'creditor'], in that order. An absent or malformed policy signs none (design 6.6).
 */
export function consentRoles(policy) {
  if (!isDict(policy)) return [];
  return CONSENT_ROLES.filter(([flag]) => pyGet(policy, flag) === true).map(([, role]) => role);
}

/**
 * [route, edge, total, timestamp]: what names one payment attempt (an attempt record, a pending payment entry seen as
 * an attempt, a paymentAttempts() row, resolutionPlan().attempt); null for null. For resolveAttempt({expectedAttempt}).
 */
export function attemptKey(a) {
  if (a === null || a === undefined) return null;
  return [pyGet(a, 'route'), pyGet(a, 'edge'), pyGet(a, 'total'), pyGet(a, 'timestamp')];
}

/** Two attemptKey() values element by element (null only equals null). */
function sameAttemptKey(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === 4 && b.length === 4 && a.every((x, i) => pyEq(x, b[i]));
}

/** Does the server authenticate the caller of this request path? Only there does an agent's header reach its roles. */
function authenticatedRoute(path) {
  const route = path.split('?', 1)[0];
  return route.startsWith('/pilot/v1/') && !PUBLIC_ROUTES.some(r => route === r || route.startsWith(r + '/'));
}

/** The one role a GET /consents item gives this client (novation.ROLES), or null. */
function oneRole(it) {
  const roles = isDict(it) ? pyGet(it, 'your_roles') : null;
  return Array.isArray(roles) && roles.length === 1 && nv.ROLES.includes(roles[0]) ? roles[0] : null;
}

/** The feature tags a GET /info answer lists: [] without `features`; ['?'] when the list is malformed. */
function featuresOf(info) {
  if (!isDict(info)) throw new ValunError('bad_response', 'GET /info did not answer a JSON object');
  const raw = pyGet(info, 'features');
  if (raw === null) return [];
  if (Array.isArray(raw) && raw.every(f => typeof f === 'string')) return [...raw];
  return ['?'];
}

/** The owner's mandate as GET /me shows it (effective_limits, else mandate): the mandate side of R8, or null. */
function mandateOf(me) {
  if (isDict(me)) {
    for (const k of ['effective_limits', 'mandate']) if (isDict(pyGet(me, k))) return me[k];
  }
  return null;
}

/** novation.js's verifier: a Basis signature (hex) over msg (bytes) by pubkeyHex. */
const verifyHexFor = (pubkeyHex, msg, sigHex) => verifyHex(sigHex, msg, pubkeyHex);

const natural = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPubkey = v => typeof v === 'string' && /^0[23][0-9a-f]{64}$/.test(v);

/** A failure to reach or be served by the server, not an answer about the request itself: try again later. */
function transient(e) {
  return e.code === 'unreachable' || (typeof e.status === 'number' && (e.status >= 500 || e.status === 429));
}

/**
 * A novation.js records helper; its ValueError (a record that is not of its shape) is records_unreadable (R9), and its
 * WriteAheadConflict keeps its own refusal code.
 */
function guarded(fn, ...args) {
  try {
    return fn(...args);
  } catch (e) {
    if (isValunError(e)) throw e;
    const code = e?.code;
    if (typeof code === 'string' && nv.REFUSAL_CODES.includes(code)) throw new ValunError(code, e.message);
    if (e?.name === 'ValueError' || e?.name === 'WriteAheadConflict') throw new ValunError('records_unreadable', UNREADABLE);
    throw e;
  }
}

function dictIn(state, key) {
  let v = state[key] ?? null;
  if (v === null) v = state[key] = {};
  if (!isDict(v)) throw new ValunError('records_unreadable', `this profile's ${key} record cannot be read; nothing was signed`);
  return v;
}

/** An evaluation turned into a refusal (another code and reason than the evaluator's, when given). */
function refused(r, code = null, reason = null) {
  const s = reason !== null ? {...r.summary, reason} : r.summary;
  return {ok: false, code: code || r.code, to_sign: [], summary: s, write_ahead: null};
}

/** The ValunError for an evaluation that refuses: its code and reason, and what the caller needs to act on it. */
function refusalError(r) {
  const s = or(pyGet(r, 'summary'), {});
  const extra = {summary: s};
  if ((pyGet(s, 'retry_after_ms') ?? null) !== null) extra.retry_after_ms = s.retry_after_ms;
  if (truthy(pyGet(s, 'needs_read_back'))) extra.needs_read_back = [...s.needs_read_back];
  return new ValunError(r.code, or(pyGet(s, 'reason'), `refused (${r.code}); nothing was signed`), undefined, extra);
}

/** The payment a pending entry of mine is, when it applied: 'note', 'transfer' (ref 'vd_...'), or null. */
function paidRoute(p) {
  if (!isDict(p) || typeof pyGet(p, 'ref') !== 'string' || !p.ref) return null;
  if (pyGet(p, 'kind') === 'note' && pyGet(p, 'direction') === 'out') return 'note';
  if (pyGet(p, 'kind') === 'transfer' && pyGet(p, 'direction') === 'in' && p.ref.startsWith('vd_')) return 'transfer';
  return null;
}

/** A payment attempt record as novation.js writes it (transfer_attempts[deal_id][i]). */
function attemptShape(a) {
  return isDict(a) && nv.ROUTES.includes(pyGet(a, 'route')) && typeof pyGet(a, 'edge') === 'string'
    && natural(pyGet(a, 'prior')) && natural(pyGet(a, 'total')) && natural(pyGet(a, 'timestamp'));
}

/** A code or state the server chose, copied only in the form ^[a-z_]{1,40}$; else null. */
function serverWord(v) {
  return typeof v === 'string' && SERVER_WORD_RE.test(v) ? v : null;
}

const said = code => (code ? ` (${code})` : '');

/** Does `s` hold a character that hides text or displays differently (stricter than the server's rule)? */
function unsafeText(s) {
  for (const ch of s) {
    if (ch === '\t' || ch === '\n' || ch === '\r') continue;
    const cp = ch.codePointAt(0);
    if (UNSAFE_CATEGORY.test(ch) || IGNORABLE.some(([lo, hi]) => lo <= cp && cp <= hi)) return true;
  }
  return false;
}

/** The owner's note for the server's audit line of a resolution: null when absent or blank, else checked and trimmed. */
function ownerNote(note) {
  if (note === null || note === undefined) return null;
  if (typeof note !== 'string') throw new ValunError('bad_arguments', 'the note is text; nothing was changed');
  const t = strip(note);
  if (!t) return null;
  if (unsafeText(t)) {
    throw new ValunError('bad_arguments', 'the note contains control, bidi or invisible characters; remove them (nothing was changed)');
  }
  if (t.length > RESOLVE_NOTE_MAX) {
    throw new ValunError('bad_arguments', `the note is longer than ${RESOLVE_NOTE_MAX} characters; shorten it (nothing was changed)`);
  }
  return t;
}

function pendingLists(state) {
  const recs = state.records;
  return isDict(recs) ? Object.entries(recs).filter(([pair, e]) => pair !== nv.PAID_DEALS_KEY && isDict(e) && Array.isArray(e.pending)) : [];
}

/** The edges of this client's payment attempts: those of its attempt records and of its pending payment entries. */
function attemptEdges(state) {
  const edges = new Set();
  const att = state.transfer_attempts;
  for (const lst of isDict(att) ? Object.values(att) : []) {
    for (const a of Array.isArray(lst) ? lst : []) if (isDict(a) && typeof pyGet(a, 'edge') === 'string') edges.add(a.edge);
  }
  for (const [pair, e] of pendingLists(state)) if (e.pending.some(p => paidRoute(p) !== null)) edges.add(pair);
  return edges;
}

/** The deals this client records payment attempts of (attempt records and pending payment entries). */
function attemptDeals(state) {
  const deals = new Set();
  const att = state.transfer_attempts;
  for (const [dealId, lst] of isDict(att) ? Object.entries(att) : []) if (truthy(lst)) deals.add(dealId);
  for (const [, e] of pendingLists(state)) for (const p of e.pending) if (paidRoute(p) !== null) deals.add(p.ref);
  return deals;
}

/** R12: remember that a novation changed `edge` (it now takes bound notes only). True when it is new. */
function markNovated(state, edge) {
  let nov = state.novated_edges ?? null;
  if (nov === null) nov = state.novated_edges = {};
  if (isDict(nov)) {
    if (Object.hasOwn(nov, edge)) return false;
    nov[edge] = true;
    return true;
  }
  if (Array.isArray(nov) && nov.every(x => typeof x === 'string')) {
    if (nov.includes(edge)) return false;
    nov.push(edge);
    return true;
  }
  throw new ValunError('records_unreadable', "this profile's record of novated edges cannot be read; nothing was signed");
}

/** Python's sorted() of strings (by code point). */
const sortedStrings = xs => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** state.records (created when absent, unless create is false: then {}); a value that is not a record refuses everything (R9). */
function recordsIn(state, create = true) {
  const r = state.records;
  if (r === null || r === undefined) {
    if (!create) return {};
    state.records = {};
    return state.records;
  }
  if (!isDict(r)) throw new ValunError('records_unreadable', "this profile's records cannot be read; nothing was signed");
  return r;
}

function issuedIn(state, create = true) {
  const r = state.issued;
  if (r === null || r === undefined) {
    if (!create) return {};
    state.issued = {};
    return state.issued;
  }
  if (!isDict(r)) throw new ValunError('records_unreadable', "this profile's record of issued credit notes cannot be read; nothing was signed");
  return r;
}

function pinsOf(state) {
  const p = state.pins;
  return isDict(p) && truthy(p.tracker_nft_id) ? p : null;
}

function pinProblem(pins, trackerNftId, denomination) {
  if (pins && (pins.tracker_nft_id !== trackerNftId || pins.denomination !== denomination)) {
    return new ValunError('tracker_mismatch',
      `this Valun server names tracker ${cpSlice(str(trackerNftId), 16)}... and unit ${cpSlice(str(denomination), 22)}..., but this `
      + `profile is pinned to tracker ${cpSlice(str(pyGet(pins, 'tracker_nft_id')), 16)}... and unit ${cpSlice(str(pyGet(pins, 'denomination')), 22)}...; `
      + 'nothing was signed. Ask your owner.', undefined, {pinned: {...pins}});
  }
  return null;
}

/** Node's errors from the file system and other system calls (Python's OSError). */
function isSystemError(e) {
  return e instanceof Error && (typeof e.errno === 'number' || typeof e.syscall === 'string');
}

function isValunError(e) {
  return e instanceof ValunError || (e instanceof Error && e.name === 'ValunError' && typeof e.code === 'string');
}

/**
 * Is `signature` the issuer's Basis signature over the note (issuer, recipient, total, timestamp) on this tracker and
 * unit? Hex strings and whole numbers in; false for anything malformed (never throws).
 */
export function verifyNote(issuerPubkey, recipientPubkey, total, timestamp, signature, trackerNftId, denomination) {
  try {
    if (![issuerPubkey, recipientPubkey, signature, trackerNftId].every(x => typeof x === 'string')) return false;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(timestamp)) return false;
    const msg = noteMessage(issuerPubkey, recipientPubkey, total, timestamp, trackerNftId, denomination);
    return verifyHex(signature, msg, issuerPubkey);
  } catch {
    return false;
  }
}

const noteVerifier = (trackerNftId, denomination) =>
  (issuer, recipient, total, ts, sig) => verifyNote(issuer, recipient, total, ts, sig, trackerNftId, denomination);

/** Whole-second UTC time as the Python client writes it: YYYY-MM-DDTHH:MM:SS.000Z. */
function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const TERMS_FIELDS = ['protocol', 'network', 'tracker_nft_id', 'denomination', 'deal_id', 'version', 'prior_terms_hash',
  'nonce', 'proposer', 'payer', 'payee', 'service', 'price', 'consideration', 'deliver_by', 'offer_expires_at'];

function exactKeys(o, keys) {
  return isObject(o) && Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
}

function isRfc3339(s) {
  return typeof s === 'string' && RFC3339.test(s) && !Number.isNaN(Date.parse(s));
}

function seg(id) {
  if (typeof id !== 'string' || id === '') throw new ValunError('bad_id', 'ids must be non-empty strings');
  return encodeURIComponent(id);
}

function toPrice(price) {
  const n = typeof price === 'string' && /^[0-9]+$/.test(price) ? Number(price) : price;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) return n;
  throw new ValunError('bad_price', 'price must be a whole number of PC, at least 1');
}

function toHours(h, what) {
  if (typeof h !== 'number' || !Number.isFinite(h)) throw new ValunError('bad_terms', `${what} must be a number of hours`);
  return h;
}

/** Structural guard: the fields every check below reads, with the types it relies on. */
function checkTermsShape(t) {
  const party = p => isObject(p) && typeof p.id === 'string' && typeof p.pubkey === 'string';
  if (!isObject(t) || !party(t.payer) || !party(t.payee) || !isObject(t.service) || !isObject(t.price)
      || typeof t.tracker_nft_id !== 'string' || typeof t.denomination !== 'string') {
    throw new ValunError('bad_terms', 'the terms are not shaped as valun-deal/1 terms; refusing to sign');
  }
}

/** A reason the server would refuse is not sent (statements.json tier "refused": a client must not send them). */
function refuseReason(kind, reason) {
  const p = reasonProblem(kind, reason);
  if (p) throw new ValunError(p.error, p.message, undefined, {field: 'reason', local: true});
}

function timeoutSignal(ms) {
  if (typeof AbortController !== 'function' || !(ms > 0)) return {signal: undefined, cancel() {}};
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return {signal: c.signal, cancel: () => clearTimeout(t)};
}

/**
 * In-memory store: settings and the agent's record of notes issued in `state` (plain, non-secret), the signing key
 * and agent token in private fields that no enumeration, JSON.stringify or util.inspect can reach.
 */
export class MemoryStore {
  #secret;
  #token;

  constructor({state = {}, secret = null, token = null} = {}) {
    this.state = state;
    this.#secret = secret;
    this.#token = token;
  }

  secret() { return this.#secret; }
  token() { return this.#token; }
  saveCredentials(secretHex, token) { this.#secret = secretHex; this.#token = token; }
  save() {}
}

export class Client {
  #store;
  #fetch;
  #timeoutMs;
  #now;
  #randomBytes;
  #generateSecret;
  #pin;
  #signerRetries;
  #retryDelayMs;
  #server;
  #queue = {tail: Promise.resolve()};           // this client's state changes, one after another (shared by fresh())
  #advertised = [];                             // the features the last GET /info listed (for the capability header)

  /**
   * @param {object} options
   *   store          an object with .state (non-secret, plain object), .secret(), .token(), .save() and
   *                  .saveCredentials(secretHex, token) (save/saveCredentials may return a Promise). Default: MemoryStore.
   *   server         base URL of the Valun server, e.g. "https://host" (the API is under /pilot/v1). Kept in state.
   *   timeoutMs      per request (default 30000).
   *   fetch          a fetch implementation (default globalThis.fetch).
   *   pin            {trackerNftId, denomination}: values the network must have (spec 15.2: SHOULD pin).
   *   signerRetries  how many times to send the same signed request again after 503 signer_unavailable (default 0:
   *                  the error is thrown, as the Python client does); retryDelayMs (default 1000) doubles each time.
   *   declareRoles   false for a client whose adapter signs no consent by itself: it declares no consent role in
   *                  X-Valun-Features, whatever its consent policy says, and withdraws the roles it declared before
   *                  (featuresHeader; decision D-3 b). Default true. A ValunAgent sets it from its own options.
   *   now, randomBytes, generateSecret   clock (ms), id/nonce source and key generator: test hooks only.
   */
  constructor(options = {}) {
    const {store = new MemoryStore(), server, timeoutMs = 30_000, fetch, pin = {}, signerRetries = 0, retryDelayMs = 1000,
      now, randomBytes, generateSecret, declareRoles = true} = options;
    this.declareRoles = declareRoles !== false;
    if (!Number.isInteger(signerRetries) || signerRetries < 0) throw new TypeError('signerRetries must be a whole number');
    this.#signerRetries = signerRetries;
    this.#retryDelayMs = retryDelayMs;
    for (const m of ['secret', 'token', 'save', 'saveCredentials']) {
      if (typeof store?.[m] !== 'function') throw new TypeError(`store must have a ${m}() method`);
    }
    if (!isObject(store.state)) throw new TypeError('store.state must be a plain object');
    this.#store = store;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#pin = {trackerNftId: pin.trackerNftId ?? null, denomination: pin.denomination ?? null};
    this.#now = now || (() => Date.now());
    this.#randomBytes = randomBytes || defaultRandomBytes;
    this.#generateSecret = generateSecret || (() => defaultGenerateSecret());
    // Kept apart (as in Python): a profile reloaded from disk never redirects this client's requests.
    this.#server = server ? String(server).replace(/\/+$/, '') : null;
    if (this.#server) this.state.server = this.#server;
  }

  /**
   * Non-secret state: server, participant_id, pubkey, network, enrolled_at, issued (confirmed totals of notes issued,
   * per key pair), records (confirmed and pending, per key pair: records.js), pins {tracker_nft_id, denomination}.
   */
  get state() { return this.#store.state; }

  /** True when the store holds both a signing key and an agent token. */
  get connected() { return Boolean(this.#store.token() && this.#store.secret()); }

  /** This agent's public key (66 hex), or null before enrollment. */
  get pubkey() {
    if (!this.state.pubkey && this.#store.secret()) this.state.pubkey = bytesToHex(publicKey(hexToBytes(this.#store.secret())));
    return this.state.pubkey ?? null;
  }

  get participantId() { return this.state.participant_id ?? null; }

  /** The feature tags the last GET /info this client read listed ([] before any; ['?'] for a malformed list). */
  get advertised() { return [...this.#advertised]; }

  /**
   * A new Client on this client's store, server, clock, fetch, pins and other options, as a new Client starts: it has
   * read no GET /info yet (advertised is [], so its requests carry no X-Valun-Features header until it reads one).
   * Nothing it does changes this client's features, nor this client's its own; their state changes still run one after
   * another (one queue). ValunAgent takes one for every use of its client, as the Python agent makes a new Client for
   * each (so both send the same headers, and two uses at once never change each other's features).
   */
  fresh() {
    const c = new Client({store: this.#store, server: this.#server ?? undefined, timeoutMs: this.#timeoutMs, fetch: this.#fetch,
      pin: {...this.#pin}, signerRetries: this.#signerRetries, retryDelayMs: this.#retryDelayMs, now: this.#now,
      randomBytes: this.#randomBytes, generateSecret: this.#generateSecret, declareRoles: this.declareRoles});
    c.#queue = this.#queue;
    return c;
  }

  /** This client's clock (ms since the epoch). */
  nowMs() { return this.#now(); }

  #secretBytes() {
    const s = this.#store.secret();
    if (!s) throw new ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it');
    return hexToBytes(s);
  }

  #signBytes(message) {
    const secret = this.#secretBytes();
    try {
      return bytesToHex(sign(message, secret, hexToBytes(this.pubkey)));
    } catch (e) {
      if (e instanceof SignatureError) throw new ValunError('bad_key', `the stored signing key is unusable: ${e.message}`);
      throw e;
    } finally {
      secret.fill(0);
    }
  }

  #sign(text) {
    return this.#signBytes(utf8(text));
  }

  async #save() {
    await this.#store.save();
  }

  // ---------- state changes: one after another, through store.update() where the store has it ----------
  /** Run `task` after every change this client started before it (whatever their outcome). */
  #serial(task) {
    const q = this.#queue;
    const run = q.tail.then(() => task());
    q.tail = run.then(() => undefined, () => undefined);         // the queue itself never rejects
    return run;
  }

  /**
   * Change this client's records: fn(state) on the store's state, then save. With a store that has update()
   * (FileStore), under the profile lock and on the state reloaded from disk, so concurrent processes (Python ones too)
   * never lose each other's records; other stores apply fn to a copy of their state, which then replaces it, and save().
   * If fn throws, nothing changes. fn is synchronous. Resolves to fn's result.
   */
  #update(fn) {
    return this.#serial(async () => {
      const store = this.#store;
      let result;
      if (typeof store.update === 'function') {
        result = await store.update(fn);
      } else {
        const work = structuredClone(this.state);
        result = fn(work);
        for (const k of Object.keys(this.state)) delete this.state[k];
        Object.assign(this.state, work);
        await store.save();
      }
      if (this.#server) this.state.server = this.#server;
      return result;
    });
  }

  /** Read the records again where the store can (a FileStore: another process may have recorded notes meanwhile). */
  async reload() {
    await this.#reload();
  }

  /**
   * Record that a consent run took place at nowMs (state[key]: consents_last_run_ms, or consents_last_safe_run_ms for a
   * run before a read-only tool), for the agent layer's rate limit when a run failed. Never rejects: a mark that fails
   * is not retried.
   */
  async markConsentsRun(nowMs, key = 'consents_last_run_ms') {
    try {
      await this.#update(state => { state[key] = nowMs; });
    } catch { /* not retried */ }
  }

  /** Read the records again where the store can (another process may have recorded notes since this one loaded). */
  async #reload() {
    if (typeof this.#store.reload !== 'function') return;
    await this.#serial(async () => {
      await this.#store.reload();
      if (this.#server) this.state.server = this.#server;
    });
  }

  /**
   * Record an outcome after the server answered. The attempt was written ahead, so if this fails (the profile is busy
   * or unreadable, or the disk refuses the write) the entry simply stays pending and is settled later; the server's
   * answer is what counts.
   */
  async #settle(fn) {
    try {
      await this.#update(fn);
    } catch (e) {
      if (!isValunError(e) && !isSystemError(e)) throw e;
    }
  }

  // ---------- HTTP ----------
  /** One API call. Returns the parsed JSON body; throws ValunError(code = the server's `error`) for HTTP errors. */
  async request(method, path, body = undefined, {auth = true, token = undefined} = {}) {
    const server = this.#server || this.state.server;
    if (!server) throw new ValunError('not_configured', 'no Valun server configured');
    const f = this.#fetch || globalThis.fetch;
    if (typeof f !== 'function') throw new ValunError('not_configured', 'no fetch implementation: pass options.fetch');
    const headers = {Accept: 'application/json'};
    let payload;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const tok = token || (auth ? this.#store.token() : null);
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const caps = this.featuresHeader();
    if (caps) headers[FEATURES_HEADER] = caps;
    for (let attempt = 0; ; attempt++) {
      const {signal, cancel} = timeoutSignal(this.#timeoutMs);
      let res, text;
      try {
        // redirect: 'error' so the bearer token is never forwarded to wherever a redirect points.
        res = await f.call(globalThis, server + path, {method, headers, body: payload, signal, redirect: 'error'});
        text = await res.text();
      } catch (e) {
        const why = e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timed out' : (e?.message || String(e));
        throw new ValunError('unreachable', `cannot reach ${server}: ${why}`);
      } finally {
        cancel();
      }
      if (res.ok) {
        let out = null;
        if (text) {
          try {
            out = JSON.parse(text);
          } catch {
            throw new ValunError('bad_response', `the server sent a response that is not JSON (HTTP ${res.status})`, res.status);
          }
        }
        if (caps && (token ?? null) === null && auth && tok && authenticatedRoute(path)) await this.#rolesDeclared(caps);
        return out;
      }
      let j = {};
      try {
        const parsed = JSON.parse(text);
        if (isObject(parsed)) j = parsed;
      } catch { /* not JSON */ }
      const {error, message, ...extra} = j;
      const code = typeof error === 'string' && error ? error : 'http_error';
      // spec 15.2: on 503 signer_unavailable nothing was recorded; send the same signed request again, with back-off
      if (res.status === 503 && code === 'signer_unavailable' && attempt < this.#signerRetries) {
        await new Promise(resolve => setTimeout(resolve, this.#retryDelayMs * 2 ** attempt));
        continue;
      }
      const msg = (typeof message === 'string' && message) || (typeof error === 'string' && error) || `HTTP ${res.status}`;
      throw new ValunError(code, msg, res.status, extra);
    }
  }

  // ---------- joining ----------
  /**
   * Create a participant (owner side). The response holds the owner token and the enrollment code: both are for the
   * HUMAN operator, not for the agent.
   */
  async join({invite, handle, operator, displayName = '', about = '', services = ''}) {
    return this.request('POST', '/pilot/v1/join',
      {invite, handle, display_name: displayName, operator, about, services}, {auth: false});
  }

  /** Join without an invite as a sandbox-only participant (deals only with the sandbox agents, small limits, 7 days),
   *  where the server offers it (server release v14+, PILOT_OPEN_SANDBOX=1); otherwise ValunError('not_found'). */
  async joinSandbox({handle, operator, displayName = '', about = ''}) {
    return this.request('POST', '/pilot/v1/join-sandbox', {handle, display_name: displayName, operator, about}, {auth: false});
  }

  /** Generate this agent's key locally and register its public key with a proof-of-possession signature. */
  async enroll(participantId, code) {
    if (this.connected) throw new ValunError('already_connected', 'this client already holds an enrolled key');
    if (typeof participantId !== 'string' || typeof code !== 'string') {
      throw new ValunError('bad_enrollment', 'participant id and enrollment code must be strings');
    }
    const secret = this.#generateSecret();
    try {
      const pk = bytesToHex(publicKey(secret));
      const sig = bytesToHex(sign(utf8(statements.enroll(participantId, pk, code)), secret, hexToBytes(pk)));
      const r = await this.request('POST', '/pilot/v1/enroll',
        {participant_id: participantId, code, pubkey: pk, signature: sig}, {auth: false});
      if (!isObject(r) || typeof r.agent_token !== 'string' || !r.agent_token) {
        throw new ValunError('bad_response', 'the enroll response carries no agent token');
      }
      const secretHex = bytesToHex(secret);
      await this.#serial(async () => {
        Object.assign(this.state, {participant_id: participantId, pubkey: pk, network: r.network,
          enrolled_at: isoSeconds(this.#now()), issued: this.state.issued || {}});
        await this.#store.saveCredentials(secretHex, r.agent_token);
        await this.#save();
      });
      return {participant_id: participantId, pubkey: pk, network: r.network};
    } finally {
      secret.fill(0);
    }
  }

  // ---------- reads ----------
  /**
   * The network's public description. Its tracker and unit are pinned in an enrolled profile the first time they are
   * read (on the first call after enrolling or after an upgrade); a later answer naming others is refused
   * (tracker_mismatch, R13).
   */
  async info() {
    const r = await this.request('GET', '/pilot/v1/info', undefined, {auth: false});
    await this.#pinFrom(r);
    this.#advertised = isObject(r) ? featuresOf(r) : [];
    return r;
  }

  /**
   * The X-Valun-Features value this client sends with its requests (PROTOCOL.md 18.1; design 4.1):
   * 'consents/1;roles=<roles>', the consent roles its local consent_policy signs by itself (consentRoles; none with
   * declareRoles false), once the server's GET /info has listed circulation/1; null before. With no role on, the
   * empty list 'consents/1;roles=' is sent while the server may still count roles this client declared before
   * (consent_roles_declared names some), so that it forgets them at once (decision D-3 b); once the server has taken
   * it, no header is sent (null). The server takes a header from an agent request it authenticated and answered with
   * 2xx (request() then records it in consent_roles_declared).
   */
  featuresHeader() {
    if (!this.#advertised.includes('circulation/1')) return null;
    const roles = this.declareRoles ? consentRoles(this.state.consent_policy) : [];
    if (roles.length) return `consents/1;roles=${roles.join(',')}`;
    const declared = this.state.consent_roles_declared;
    return typeof declared === 'string' && declared ? 'consents/1;roles=' : null;
  }

  /** Record (consent_roles_declared) the roles a header the server took declared; written only when it changes. */
  async #rolesDeclared(caps) {
    const i = caps.indexOf('roles=');
    const roles = i >= 0 ? caps.slice(i + 'roles='.length) : '';
    if (this.state.consent_roles_declared === roles) return;
    try {
      await this.#update(state => { state.consent_roles_declared = roles; });
    } catch (e) {
      if (!isValunError(e) && !isSystemError(e)) throw e;
    }
  }

  me() { return this.request('GET', '/pilot/v1/me'); }
  inbox() { return this.request('GET', '/pilot/v1/inbox'); }
  deals() { return this.request('GET', '/pilot/v1/deals'); }
  deal(dealId) { return this.request('GET', `/pilot/v1/deals/${seg(dealId)}`); }
  directory() { return this.request('GET', '/pilot/v1/participants', undefined, {auth: false}); }
  participant(pid) { return this.request('GET', `/pilot/v1/participants/${seg(pid)}`, undefined, {auth: false}); }
  ledger() { return this.request('GET', '/pilot/v1/ledger', undefined, {auth: false}); }

  /** Record limits and goals the owner gave this agent; the server keeps them within the owner's mandate. */
  setLimits(body) { return this.request('PUT', '/pilot/v1/limits', body); }

  // ---------- pins (R13) ----------
  #pinned() {
    return pinsOf(this.state) !== null;
  }

  #checkPins(trackerNftId, denomination) {
    const err = pinProblem(pinsOf(this.state), trackerNftId, denomination);
    if (err) throw err;
  }

  async #pinFrom(info) {
    if (!isObject(info)) return;
    const nft = info.tracker_nft_id, denom = info.denomination;
    if (!(typeof nft === 'string' && nft && typeof denom === 'string' && denom)) return;
    if (this.#pinned()) {
      this.#checkPins(nft, denom);
      return;
    }
    if (!truthy(this.state.participant_id ?? null)) return;     // only an enrolled profile is pinned
    await this.#update(state => {
      const err = pinProblem(pinsOf(state), nft, denom);
      if (err) throw err;
      if (!pinsOf(state)) state.pins = {tracker_nft_id: nft, denomination: denom};
    });
  }

  /**
   * The feature tags the server advertises in GET /info (which also checks the pins), for a pinned profile. A profile
   * not pinned yet is served exactly as by 0.3 (no extra request): it is pinned by its first call.
   */
  async #features() {
    if (!this.#pinned()) return [];
    return featuresOf(await this.info());    // malformed: ['?'] (features count as advertised, none is recognised)
  }

  /** GET /info (which pins an enrolled profile) and its feature tags: feature_unavailable unless they list circulation/1. */
  async #circulation() {
    const features = featuresOf(await this.info());
    if (!features.includes('circulation/1')) {
      throw new ValunError('feature_unavailable', 'this Valun server does not offer circulating credit (circulation/1); nothing was signed');
    }
    return features;
  }

  // ---------- independent checks ----------
  async #registeredKey(pid) {
    const p = await this.participant(pid);
    if (!isObject(p) || p.status !== 'active' || !p.pubkey) {
      throw new ValunError('counterparty_inactive', `${pid} has no active registered key`);
    }
    return p.pubkey;
  }

  /** GET /info, checked against the protocol constants and the pins given to the constructor. */
  async #networkInfo() {
    const info = await this.info();
    if (!isObject(info)) throw new ValunError('bad_response', 'GET /info did not return an object');
    if (info.network !== NETWORK) throw new ValunError('wrong_network', `the server is on network ${JSON.stringify(info.network)}, not ${NETWORK}`);
    if (this.#pin.trackerNftId && info.tracker_nft_id !== this.#pin.trackerNftId) {
      throw new ValunError('wrong_tracker', 'the server names a different tracker than the one pinned for this client');
    }
    if (this.#pin.denomination && info.denomination !== this.#pin.denomination) {
      throw new ValunError('wrong_tracker', 'the server names a different unit than the one pinned for this client');
    }
    return info;
  }

  /**
   * Check the current offer of a deal view before accepting or countering it (spec 15.2 items 1-5 as the Python
   * client does them, then item 6): recompute the terms hash, check network/tracker/unit, that this agent is a party
   * named with its own key, the proposer's key against the directory and its signature, and expiry.
   * Returns {terms_hash, proposer_signature_valid: true, terms}.
   */
  async verifyOffer(d) {
    const cur = isObject(d) ? d.current : null;
    if (!isObject(cur)) throw new ValunError('no_offer', 'this deal has no visible offer');
    const t = cur.terms;
    checkTermsShape(t);
    const h = termsHash(t);
    if (h !== cur.terms_hash) throw new ValunError('hash_mismatch', 'the terms do not hash to the stated terms_hash; refusing to sign');
    if (t.network !== NETWORK || t.protocol !== PROTOCOL) throw new ValunError('wrong_network', 'terms are for a different network or protocol');
    const info = await this.#networkInfo();
    if (t.tracker_nft_id !== info.tracker_nft_id || t.denomination !== info.denomination) {
      throw new ValunError('wrong_tracker', 'terms name a different tracker or unit than this network');
    }
    const me = this.participantId;
    if (me !== t.payer.id && me !== t.payee.id) throw new ValunError('not_a_party', 'you are not a party to these terms');
    for (const role of ['payer', 'payee']) {
      if (t[role].id === me && t[role].pubkey !== this.pubkey) throw new ValunError('wrong_key', `the terms name a different key for you as ${role}`);
    }
    if (cur.by !== t.payer.id && cur.by !== t.payee.id) throw new ValunError('not_a_party', 'the offer was not made by a party to its terms');
    const proposerKey = await this.#registeredKey(cur.by);
    if (proposerKey !== (t.payer.id === cur.by ? t.payer : t.payee).pubkey) {
      throw new ValunError('wrong_key', 'the proposer key in the terms is not the registered key');
    }
    if (!verifyHex(cur.signature, utf8(statements.propose(h)), proposerKey)) {
      throw new ValunError('bad_signature', "the proposer's signature does not verify");
    }
    if (!isRfc3339(t.offer_expires_at) || !isRfc3339(t.deliver_by)) {
      throw new ValunError('bad_terms', 'the offer times are not RFC 3339 date-times; refusing to sign');
    }
    if (Date.parse(t.offer_expires_at) < this.#now()) throw new ValunError('expired', 'the offer has expired');
    // spec 15.2 item 6 (SHOULD): the Python client does not make these checks.
    if (d.id !== undefined && t.deal_id !== d.id) throw new ValunError('wrong_deal', 'the terms are for a different deal id');
    if (t.proposer !== cur.by) throw new ValunError('wrong_proposer', 'the terms name a different proposer than the signer');
    if (!Number.isSafeInteger(t.version) || (cur.version !== undefined && t.version !== cur.version)) {
      throw new ValunError('bad_terms', 'the terms version is not the offer version');
    }
    if (t.price.unit !== UNIT || !Number.isSafeInteger(t.price.amount)) throw new ValunError('bad_terms', 'the price is not a whole number of PC');
    if (t.consideration !== CONSIDERATION) throw new ValunError('bad_terms', `the consideration is not ${CONSIDERATION}`);
    if (!exactKeys(t, TERMS_FIELDS) || !exactKeys(t.payer, ['id', 'pubkey']) || !exactKeys(t.payee, ['id', 'pubkey'])
        || !exactKeys(t.price, ['amount', 'unit']) || !exactKeys(t.service, ['title', 'description', 'deliverable'])
        || !['title', 'description', 'deliverable'].every(k => typeof t.service[k] === 'string')) {
      throw new ValunError('bad_terms', 'the terms have missing or unknown fields; refusing to sign what may not be shown');
    }
    if (t.version === 1 ? t.prior_terms_hash !== null : !/^[0-9a-f]{64}$/.test(String(t.prior_terms_hash))) {
      throw new ValunError('bad_terms', 'prior_terms_hash does not fit the version');
    }
    const prev = t.version > 1 && Array.isArray(d.versions) ? d.versions.find(x => x?.version === t.version - 1) : undefined;
    if (prev && prev.terms_hash !== t.prior_terms_hash) {
      throw new ValunError('bad_terms', 'the offer does not continue the version before it (prior_terms_hash)');
    }
    return {terms_hash: h, proposer_signature_valid: true, terms: t};
  }

  /** The agreed terms of a deal view, checked: hash, and both parties' signatures against the keys named in them. */
  verifiedAgreement(d) {
    const a = isObject(d) ? d.agreement : null;
    if (!isObject(a)) throw new ValunError('not_agreed', 'no agreement on this deal');
    const cur = d.current;
    if (!isObject(cur)) throw new ValunError('not_agreed', 'the agreement has no terms in this view');
    const t = cur.terms;
    checkTermsShape(t);
    const h = termsHash(t);
    if (h !== a.terms_hash) throw new ValunError('hash_mismatch', 'agreement hash does not match its terms');
    const keys = {[t.payer.id]: t.payer.pubkey, [t.payee.id]: t.payee.pubkey};
    const prop = cur.by;
    if (prop !== t.payer.id && prop !== t.payee.id) throw new ValunError('bad_signature', 'the agreement was not proposed by a party to its terms');
    const acc = prop === t.payer.id ? t.payee.id : t.payer.id;
    if (!verifyHex(a.proposer_signature, utf8(statements.propose(h)), keys[prop])) {
      throw new ValunError('bad_signature', 'proposer signature on the agreement does not verify');
    }
    if (!verifyHex(a.acceptor_signature, utf8(statements.accept(h)), keys[acc])) {
      throw new ValunError('bad_signature', 'acceptor signature on the agreement does not verify');
    }
    return t;
  }

  // ---------- acts (all signed locally) ----------
  /** valun-deal/1 terms for a new proposal (or, with dealId/version/prior, a counter-offer). Signs nothing. */
  async buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24,
    dealId = undefined, version = 1, prior = null}) {
    if (role !== 'payer' && role !== 'payee') {
      throw new ValunError('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)');
    }
    if (![title, description, deliverable].every(x => typeof x === 'string')) {
      throw new ValunError('bad_terms', 'title, description and deliverable must be strings');
    }
    const amount = toPrice(price);
    const dueH = toHours(deliverByHours, 'deliverByHours'), ttlH = toHours(offerTtlHours, 'offerTtlHours');
    this.#secretBytes().fill(0);   // fail early (not_connected) rather than after the reads
    const info = await this.#networkInfo();
    const other = {id: counterpartyId, pubkey: await this.#registeredKey(counterpartyId)};
    const me = {id: this.participantId, pubkey: this.pubkey};
    const now = this.#now();
    return {
      protocol: PROTOCOL, network: NETWORK, tracker_nft_id: info.tracker_nft_id, denomination: info.denomination,
      deal_id: dealId || ('vd_' + bytesToHex(this.#randomBytes(8))), version, prior_terms_hash: prior,
      nonce: bytesToHex(this.#randomBytes(16)), proposer: this.participantId,
      payer: role === 'payer' ? me : other, payee: role === 'payer' ? other : me,
      service: {title, description, deliverable},
      price: {amount, unit: UNIT}, consideration: CONSIDERATION,
      deliver_by: isoSeconds(now + dueH * HOUR), offer_expires_at: isoSeconds(now + ttlH * HOUR),
    };
  }

  /** Propose a new deal (version 1), signed by this agent. */
  async propose({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24}) {
    const t = await this.buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours});
    const h = termsHash(t);
    return this.request('POST', '/pilot/v1/deals', {terms: t, terms_hash: h, signature: this.#sign(statements.propose(h))});
  }

  /**
   * Counter the current offer: verify it, then sign new terms (version + 1, prior = its hash). Unset fields carry over.
   * With expectedTermsHash (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current
   * offer is another.
   */
  async counter(dealId, {price = undefined, title = undefined, description = undefined, deliverable = undefined,
    deliverByHours = undefined, offerTtlHours = 24, expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    const chk = await this.verifyOffer(d);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== chk.terms_hash) {
      throw new ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before countering');
    }
    const t0 = chk.terms;
    const role = t0.payer.id === this.participantId ? 'payer' : 'payee';
    const other = role === 'payer' ? t0.payee.id : t0.payer.id;
    const dueH = deliverByHours ?? Math.max(1, Math.floor((Date.parse(t0.deliver_by) - this.#now()) / HOUR));
    const t = await this.buildTerms({
      counterpartyId: other, role,
      title: title || t0.service.title, description: description || t0.service.description,
      deliverable: deliverable || t0.service.deliverable, price: price ?? t0.price.amount,
      deliverByHours: dueH, offerTtlHours, dealId, version: t0.version + 1, prior: chk.terms_hash,
    });
    const h = termsHash(t);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/counter`,
      {terms: t, terms_hash: h, signature: this.#sign(statements.propose(h))});
  }

  /** Accept the current offer after verifyOffer(); refuses if it changed since `expectedTermsHash` was inspected. */
  async accept(dealId, {expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    const chk = await this.verifyOffer(d);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== chk.terms_hash) {
      throw new ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before accepting');
    }
    const h = chk.terms_hash;
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/accept`, {terms_hash: h, signature: this.#sign(statements.accept(h))});
  }

  /** Decline the current offer. The signature covers sha256(reason) of exactly the reason sent (spec 8.3). */
  async decline(dealId, reason = '') {
    reason ??= '';
    refuseReason('decline', reason);
    const d = await this.deal(dealId);
    const h = this.#offerHash(d?.current);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/decline`,
      {terms_hash: h, reason, signature: this.#sign(statements.decline(h, reason))});
  }

  /** Withdraw this agent's open offer, or its counter-offer held for its owner. */
  async withdraw(dealId) {
    const d = await this.deal(dealId);
    const h = this.#offerHash(d?.pending_counter || d?.current);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/withdraw`, {terms_hash: h, signature: this.#sign(statements.withdraw(h))});
  }

  /** The terms_hash of an offer in a view, recomputed from its terms when the view carries them. */
  #offerHash(offer) {
    if (!isObject(offer) || typeof offer.terms_hash !== 'string') throw new ValunError('no_offer', 'this deal has no visible offer');
    if (offer.terms !== undefined && termsHash(offer.terms) !== offer.terms_hash) {
      throw new ValunError('hash_mismatch', 'the terms do not hash to the stated terms_hash; refusing to sign');
    }
    return offer.terms_hash;
  }

  /** Deliver the work (payee): verifies the agreement first, then signs sha256(content) exactly as sent. */
  async deliver(dealId, content, {title = ''} = {}) {
    if (typeof content !== 'string') throw new ValunError('bad_content', 'content must be a string');
    const d = await this.deal(dealId);
    if (!isObject(d?.agreement)) throw new ValunError('not_agreed', 'there is no agreement to deliver against');
    const h = termsHash(this.verifiedAgreement(d));
    const dh = sha256Hex(content);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/deliver`,
      {terms_hash: h, content, title, sha256: dh, signature: this.#sign(statements.deliver(h, content))});
  }

  /**
   * Accept the delivery and pay with this agent's own credit note, after checking the template independently.
   *
   * Checked before anything is signed (#acceptedDelivery): the content matches its hash (and the one the caller
   * reviewed); the agreement's hash (and the one the caller reviewed) and both signatures, and that the terms are this
   * deal's (deal_mismatch); then the payee's signature on the delivery, under the key the terms name or the payee's
   * current directory key.
   *
   * With a server that lists bound_notes/1 (a pinned profile reads /info), the note is a BOUND note (PROTOCOL.md 18.5,
   * design 6.3): the template is asked for with ?prior=1&bound=1 and checked by novation.evaluateBoundTemplate (15.3
   * R1-R13, and decision D-1: one live payment attempt per deal, with one GET /edges read-back when an earlier attempt's
   * edge must be read); a prior older than this client's own confirmed state of the edge is refused as well
   * (ledger_mismatch). The note and its prior acknowledgment are built and signed here and sent as credit_note {total,
   * timestamp, signature, prior_total, prior_signature}, after the R4 record, the payment attempt and the pending entry
   * are saved.
   *
   * Otherwise (no features, or a profile not pinned yet: exactly as 0.3 on the wire) an ORDINARY note: the template names
   * this agent's key and the payee's current key, adds exactly the agreed price, names the agreed (and pinned) tracker and
   * unit, is current and, when features are advertised, avoids the reserved residues 995-999 (bad_template); the prior
   * total must equal this client's own record of the confirmed total (ledger_mismatch); an edge a novation changed takes
   * bound notes only (R12, bound_note_required); and D-1 applies (novation.checkPayment).
   *
   * Both: a pending note of its own that its deal shows applied is confirmed on the way, and the deal it paid is recorded
   * as paid (records.paid_deals). A deal its records show paid, or one whose note of its own may have applied, is never
   * paid again (already_paid). The note is recorded as pending before it is sent, and confirmed only when the server
   * answers note_issued (the deal is then recorded as paid): an owner can still reject a held note (OQ-23).
   */
  async complete(dealId, {expectedDeliverableSha256 = undefined, expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    const [terms, h, dh] = this.#acceptedDelivery(d, dealId, expectedDeliverableSha256, expectedTermsHash);
    // A pinned (0.4) profile reads /info: a server offering bound_notes/1 takes bound notes, and with any feature the
    // tracker keeps the timestamp residues 995-999 for other operations. Otherwise exactly as 0.3.
    const features = await this.#features();
    if (features.includes('bound_notes/1')) return this.#completeBound(dealId, d, terms, h, dh, features);
    const tpl = await this.request('GET', `/pilot/v1/deals/${seg(dealId)}/credit-note-template`);
    if (!isObject(tpl) || !['total', 'prior_total', 'price', 'timestamp'].every(k => Number.isSafeInteger(tpl[k]))) {
      throw new ValunError('bad_template', 'credit-note template is malformed');
    }
    // The note is between the parties' CURRENT keys (an owner may have replaced an agent key after the deal was
    // agreed): it must be signed by this agent's key and credit the payee's key as the directory lists it now.
    const payee = await this.#registeredKey(terms.payee.id);
    const price = terms.price.amount;
    if (tpl.issuer_pubkey !== this.pubkey || tpl.recipient_pubkey !== payee) {
      throw new ValunError('bad_template', 'credit-note template names the wrong parties');
    }
    if (tpl.price !== price || tpl.total !== tpl.prior_total + price) {
      throw new ValunError('bad_template', 'credit-note template does not add exactly the agreed price');
    }
    Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
    const pair = `${this.pubkey}>${payee}`;
    const verify = noteVerifier(terms.tracker_nft_id, terms.denomination);
    await this.#reload();
    await this.#checkRecords(pair, tpl, payee, verify, dealId, d);
    const nft = tpl.tracker_nft_id, denom = tpl.denomination;
    if (nft !== terms.tracker_nft_id || denom !== terms.denomination) {
      throw new ValunError('bad_template', 'credit-note template names a different tracker or unit');
    }
    this.#checkPins(nft, denom);
    const nowMs = this.#now();
    if (Math.abs(tpl.timestamp - nowMs) > NOTE_CLOCK_TOLERANCE_MS) {
      throw new ValunError('bad_template', 'credit-note template timestamp is not current');
    }
    if (features.length && tpl.timestamp % 1000 >= RESERVED_MS_FROM) {
      throw new ValunError('bad_template', `credit-note template timestamp ${tpl.timestamp} ends in ${tpl.timestamp % 1000}: `
        + 'the tracker keeps residues 995-999 for other operations; refusing to sign it as a credit note');
    }
    // Recompute the 80-byte message from the checked values; never sign the template's message_hex.
    let msg;
    try {
      msg = noteMessage(this.pubkey, payee, tpl.total, tpl.timestamp, nft, denom);
    } catch (e) {
      throw new ValunError('bad_template', `credit-note template cannot form a Basis note: ${e.message}`);
    }
    this.#secretBytes().fill(0);                 // not_connected before anything is recorded
    const note = {total: tpl.total, timestamp: tpl.timestamp};
    const agreed = {tracker_nft_id: nft, denomination: denom};
    const signedAt = isoSeconds(nowMs);
    const r = await this.#update(state => {      // written before the note is signed and sent: its outcome is not known yet
      const err = pinProblem(pinsOf(state), nft, denom);
      if (err) throw err;
      // R12: an edge a novation changed takes bound notes only. D-1: one live payment attempt per deal.
      const problem = nv.unboundNoteProblem(pair, state.novated_edges ?? null, features);
      if (problem === 'bound_note_required') {
        throw new ValunError(problem, 'a novation changed this edge, so it takes bound credit notes only, and this server '
          + 'offers none; nothing was signed');
      }
      if (problem) throw new ValunError(problem, "this profile's record of novated edges cannot be read; nothing was signed");
      const res = nv.checkPayment(dealId, price, 'note', pair, tpl.prior_total, this.#ctx(state, nowMs, features, {pins: pinsOf(state) || agreed}));
      guarded(nv.applyFindings, state, res.summary, this.pubkey);
      if (!res.ok) return res;
      if (!pinsOf(state)) state.pins = {...agreed};      // the first call after an upgrade pins the agreed tracker and unit
      records.addPending(recordsIn(state), pair, note.total, note.timestamp, 'note', dealId, 'out', signedAt);
      return res;
    });
    if (!r.ok) throw refusalError(r);
    note.signature = this.#signBytes(msg);
    const body = {terms_hash: h, deliverable_sha256: dh, signature: this.#sign(statements.complete(h, dh)), credit_note: {...note}};
    return this.#sendNote(dealId, pair, body, note);
  }

  /** complete() with a server that lists bound_notes/1: a bound note (see complete()). */
  async #completeBound(dealId, d, terms, h, dh, features) {
    const tpl = await this.request('GET', `/pilot/v1/deals/${seg(dealId)}/credit-note-template?prior=1&bound=1`);
    const payee = await this.#registeredKey(terms.payee.id);
    Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
    const pair = `${this.pubkey}>${payee}`;
    await this.#reload();
    const known = this.#knownTotal(pair);
    if (this.#pendingNotes(pair, dealId).length || (isObject(tpl) && (pyGet(tpl, 'prior_note') ?? null) === null
        && known !== null && !pyEq(known, pyGet(tpl, 'prior_total')))) {
      await this.#confirmIssued(pair, payee, noteVerifier(terms.tracker_nft_id, terms.denomination), dealId, d);
    }
    this.#secretBytes().fill(0);
    const deal = nv.dealContext(terms, h, dh);
    const nowMs = this.#now();
    const signedAt = isoSeconds(nowMs);
    const olderPrior = r => {                    // design 6.3: a prior I signed, not older than my own confirmed state
      for (const a of r.summary.advisories) {
        if (a.edge === pair) {
          const shown = a.shown, mine = a.recorded;
          return refused(r, 'ledger_mismatch', `the server shows an older prior credit note to this payee (${shown.total} PC at `
            + `${shown.timestamp}) than your own record (${mine.total} PC at ${mine.timestamp}). Ask your operator.`);
        }
      }
      return null;
    };
    const r = await this.#decide((state, edges) => nv.evaluateBoundTemplate(tpl, this.#ctx(state, nowMs, features,
      {deal, payee_current_pk: payee, edges})), signedAt, {refuse: olderPrior});
    if (!r.ok) throw refusalError(r);
    const msgs = nv.slotMessages(r.to_sign, tpl.tracker_nft_id, tpl.denomination);
    const note = {total: tpl.total, timestamp: tpl.timestamp, signature: this.#signBytes(msgs[nv.slotKey(pair, 'new')])};
    const body = {terms_hash: h, deliverable_sha256: dh, signature: this.#sign(statements.complete(h, dh)),
      credit_note: {...note, prior_total: tpl.prior_total, prior_signature: this.#signBytes(msgs[nv.slotKey(pair, 'prior')])}};
    return this.#sendNote(dealId, pair, body, note);
  }

  /**
   * POST complete with a credit note already recorded as pending, and record the outcome. note_issued: the note is
   * confirmed and its deal recorded as paid. completion_awaiting_owner, issuing_note: it stays pending. Any other answer,
   * or a refusal (4xx): the pending entry is forgotten (a bound note's payment attempt stays until it is dead, D-1). No
   * answer (unreachable, 5xx): it stays pending, since the outcome is not known.
   */
  async #sendNote(dealId, pair, body, note) {
    const forget = state => { records.removePending(recordsIn(state), pair, note.total, note.timestamp, dealId); };
    let r;
    try {
      r = await this.request('POST', `/pilot/v1/deals/${seg(dealId)}/complete`, body);
    } catch (e) {
      if (isValunError(e) && typeof e.status === 'number' && e.status >= 400 && e.status < 500) await this.#settle(forget);   // refused
      throw e;                                  // otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
    }
    const status = isObject(r) ? r.status : null;
    if (status === 'note_issued') {
      await this.#settle(state => this.#noteApplied(state, dealId, pair, note));
    } else if (status !== 'completion_awaiting_owner' && status !== 'issuing_note') {
      await this.#settle(forget);               // e.g. note_failed: the tracker does not hold it
    }
    return r;
  }

  /** The server answered note_issued: the note is the edge's confirmed state, and it paid its deal (D-1 item 5). */
  #noteApplied(state, dealId, pair, note) {
    this.#confirmIn(state, pair, note);
    guarded(nv.markPaid, state, dealId, 'note', pair, note.total, note.timestamp);
  }

  /**
   * What a payer accepts, checked before anything is asked for or signed (complete() and payByTransfer()). Returns
   * [terms, terms_hash, deliverable_sha256].
   */
  #acceptedDelivery(d, dealId, expectedDeliverableSha256 = undefined, expectedTermsHash = undefined) {
    if (!isObject(d) || !isObject(d.delivery) || !truthy(d.delivery) || !isObject(d.agreement) || !truthy(d.agreement)) {
      throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    }
    const dh = d.delivery.sha256;
    if (typeof d.delivery.content !== 'string' || sha256Hex(d.delivery.content) !== dh) {
      throw new ValunError('hash_mismatch', 'the delivered content does not match its hash');
    }
    if (truthy(expectedDeliverableSha256 ?? null) && expectedDeliverableSha256 !== dh) {
      throw new ValunError('stale_delivery', 'the delivery changed since you reviewed it');
    }
    const terms = this.verifiedAgreement(d);
    if (pyGet(terms, 'deal_id') !== dealId) {
      throw new ValunError('deal_mismatch', 'the agreed terms the server shows are for another deal; nothing was signed');
    }
    const h = termsHash(terms);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== h) {
      throw new ValunError('stale_terms', 'the agreed terms are not the ones you reviewed; refusing to accept the delivery');
    }
    return [terms, h, dh];
  }

  // ---------- the signing firewall (novation.js) ----------
  /** The evaluators' context, from this client's state as just reloaded under the profile lock. */
  #ctx(state, nowMs, features, extra = {}) {
    return {me_pk: this.pubkey, me_id: this.participantId, now_ms: nowMs, verify: verifyHexFor, pins: pinsOf(state),
      records: state.records ?? null, signed: state.signed ?? null, transfer_attempts: state.transfer_attempts ?? null,
      novated_edges: state.novated_edges ?? null, features: [...features], consent_policy: state.consent_policy ?? null, ...extra};
  }

  /**
   * Run a novation.js evaluator, evaluate(state, edges), on this client's state under the profile lock and record, in
   * the same step, what it found (applyFindings), whether or not it allows signing. When it does, refuse(result) names
   * no other refusal and something is left to sign, also record what is about to be signed (applyWriteAhead, R9) and
   * run also(state, result). An evaluation refused with transfer_window_open because an earlier attempt's edge was not
   * read is decided once more after a read-back of my edges (readBack(), by default syncEdges(); decision D-1).
   */
  async #decide(evaluate, signedAt, {refuse = null, also = null, edges = null, readBack = null} = {}) {
    const deciding = ctxEdges => state => {
      let r = evaluate(state, ctxEdges);
      guarded(nv.applyFindings, state, r.summary, this.pubkey);
      if (r.ok && refuse !== null) r = refuse(r) || r;
      if (r.ok && r.to_sign.length) {
        guarded(nv.applyWriteAhead, state, r.write_ahead, signedAt);
        if (also !== null) also(state, r);
      }
      return r;
    };
    let r = await this.#update(deciding(edges));
    const need = !r.ok && r.code === 'transfer_window_open' ? r.summary.needs_read_back : null;
    if (truthy(need)) {
      const fresh = await (readBack || (() => this.#readBack()))();
      if (fresh !== null && fresh !== undefined) {
        const ctxEdges = {...fresh.edges};
        for (const e of need) if (!fresh.doubtful.includes(e) && !Object.hasOwn(ctxEdges, e)) ctxEdges[e] = null;
        r = await this.#update(deciding(ctxEdges));
      }
    }
    return r;
  }

  /** My edges as GET /edges shows them now (syncEdges(): {edges, doubtful, ...}), or null when they cannot be read. */
  async #readBack() {
    try {
      return await this.syncEdges();
    } catch (e) {
      if (isValunError(e)) return null;
      throw e;
    }
  }

  // ---------- records of credit notes (records.js) ----------
  #confirmIn(state, pair, edge) {
    const e = records.confirm(recordsIn(state), pair, edge);
    if (truthy(e.confirmed) && pair.startsWith(`${this.pubkey}>`)) issuedIn(state)[pair] = e.confirmed.total;   // the 0.3 record stays the confirmed total
  }

  /** My own record of the confirmed total on an outgoing edge: the records' confirmed state, else the 0.3 record. */
  #knownTotal(pair) {
    const c = records.confirmedTotal(recordsIn(this.state, false), pair);
    if (c !== null && c !== undefined) return c;
    const issued = issuedIn(this.state, false);
    return Object.hasOwn(issued, pair) ? issued[pair] ?? null : null;
  }

  /**
   * An ordinary note's prior total must equal my record of the confirmed total, when I have one, and this deal must not
   * be one my records may show paid. First, a held or issuing note of mine that its deal now records as issued is
   * confirmed (owner approvals happen after this client signed): when the totals disagree, and whenever a note of mine
   * for this deal is pending.
   */
  async #checkRecords(pair, tpl, payee, verify, dealId, d) {
    const known = this.#knownTotal(pair);
    if (this.#pendingNotes(pair, dealId).length || (known !== null && !pyEq(known, tpl.prior_total))) {
      await this.#confirmIssued(pair, payee, verify, dealId, d);
    }
    const now = this.#knownTotal(pair);
    if (now !== null && !pyEq(now, tpl.prior_total)) {
      throw new ValunError('ledger_mismatch', `the server says you have issued this payee ${tpl.prior_total} PC of credit notes so far; your own record says ${str(now)}. Ask your operator.`);
    }
    for (const p of this.#pendingNotes(pair, dealId)) {
      // Still pending, so neither its deal nor the edge shows its outcome. If the edge has reached its total, it may have
      // applied (an owner approved it after this client signed): paying the deal again could pay it twice.
      const total = pyGet(p, 'total');
      if (typeof total === 'number' && Number.isSafeInteger(total) && tpl.prior_total >= total) {
        throw new ValunError('already_paid', `your earlier credit note for this deal (${total} PC in total to this payee) may `
          + `already be on the tracker: the edge's total is ${tpl.prior_total} PC now. Refusing `
          + 'to pay it again. Ask your operator.');
      }
    }
  }

  /** My pending credit notes for this deal on this edge. */
  #pendingNotes(pair, dealId) {
    return records.get(recordsIn(this.state, false), pair).pending
      .filter(p => isDict(p) && pyGet(p, 'kind') === 'note' && pyGet(p, 'ref') === dealId);
  }

  /**
   * Confirm my pending notes on this edge that their deals record as issued (with the note's own signature), and record
   * the deals they paid (decision D-1 item 5).
   */
  async #confirmIssued(pair, payee, verify, dealId, current = null) {
    const found = [];
    for (const p of records.get(recordsIn(this.state, false), pair).pending) {
      if (!(isDict(p) && pyGet(p, 'kind') === 'note' && pyGet(p, 'direction') === 'out' && typeof pyGet(p, 'ref') === 'string')) continue;
      let d;
      try {
        d = current !== null && p.ref === dealId ? current : await this.deal(p.ref);
      } catch (e) {
        if (isValunError(e)) continue;
        throw e;
      }
      if (!isDict(d)) continue;
      const tn = pyGet(d, 'status') === 'note_issued' ? or(pyGet(or(pyGet(d, 'credit_note'), {}), 'tracker_note'), {}) : {};
      const st = {total: pyGet(tn, 'amount_collected'), timestamp: pyGet(tn, 'timestamp'), signature: pyGet(tn, 'signature')};
      if (pyEq(st.total, pyGet(p, 'total')) && pyEq(st.timestamp, pyGet(p, 'timestamp'))
          && verify(this.pubkey, payee, st.total, st.timestamp, st.signature)) {
        found.push([st, p]);
      }
    }
    if (found.length) {
      let latest = found[0][0];
      for (const [st] of found) if (st.timestamp > latest.timestamp) latest = st;
      await this.#update(state => {
        this.#confirmIn(state, pair, latest);
        for (const [st, p] of found) guarded(nv.markPaid, state, p.ref, 'note', pair, st.total, st.timestamp);
      });
      Client.#refusePaidAgain(dealId, found.map(([, p]) => p));
    }
  }

  /** A note of mine that applied paid its own deal: never sign a second payment for it, whatever the server says. */
  static #refusePaidAgain(dealId, applied) {
    for (const p of applied) {
      if (pyGet(p, 'kind') === 'note' && pyGet(p, 'ref') === dealId) {
        throw new ValunError('already_paid', `your credit note for this deal (${str(pyGet(p, 'total'))} PC) is already on the tracker, so `
          + 'the deal is paid; refusing to pay it again. Ask your operator.');
      }
    }
  }

  /**
   * The payee signed this delivery: statement('deliver', terms_hash, sha256) verifies under one of `payeeKeys` (the key
   * the terms name, or the payee's current directory key after an owner replaced it). Else bad_delivery_signature.
   */
  static checkDeliverySignature(delivery, termsHashHex, ...payeeKeys) {
    const sig = isObject(delivery) ? delivery.signature : undefined;
    const dh = isObject(delivery) ? delivery.sha256 ?? null : null;
    const text = utf8(statement('deliver', termsHashHex, str(dh)));
    for (const k of new Set(payeeKeys)) {
      if (typeof sig === 'string' && typeof k === 'string' && verifyHex(sig, text, k)) return;
    }
    throw new ValunError('bad_delivery_signature', "the delivery is not signed by the payee's key; refusing to accept it");
  }

  /** Dispute the delivery (payer). The signature covers sha256(reason) of exactly the reason sent (spec 8.3). */
  async dispute(dealId, reason) {
    reason ??= '';
    refuseReason('dispute', reason);
    const d = await this.deal(dealId);
    this.verifiedAgreement(d);   // throws unless d.agreement.terms_hash is the hash of the terms, signed by both parties
    if (!isObject(d.delivery) || typeof d.delivery.sha256 !== 'string') throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const dh = d.delivery.sha256;
    if (typeof d.delivery.content === 'string' && sha256Hex(d.delivery.content) !== dh) {
      throw new ValunError('hash_mismatch', 'the delivered content does not match its hash');
    }
    const h = d.agreement.terms_hash;
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/dispute`,
      {terms_hash: h, deliverable_sha256: dh, reason, signature: this.#sign(statements.dispute(h, dh, reason))});
  }

  // ---------- circulating credit: payment by transfer (PROTOCOL.md 18.6; design 4.5, 6.3) ----------
  /**
   * GET /deals/{id}/payment-options (the payer; a deal delivered, note_failed or payment_due): the own-note option and
   * the notes this agent holds that could pay the deal ({issuer {id, handle, pubkey, operator_run}, held, reserved,
   * spendable, enough, payee_accepts, issuer_consents, payee_consents, why_not}), any pending transfer and
   * fallback_after. The server's view, for choosing: payByTransfer() checks the template itself.
   */
  paymentOptions(dealId) {
    return this.request('GET', `/pilot/v1/deals/${seg(dealId)}/payment-options`);
  }

  /**
   * GET /deals/{id}/transfer-template?issuer=<participant id>: what paying the deal with that issuer's note would sign.
   * Unchecked: payByTransfer() checks it before signing anything.
   */
  transferTemplate(dealId, issuerId) {
    return this.request('GET', `/pilot/v1/deals/${seg(dealId)}/transfer-template?issuer=${seg(issuerId)}`);
  }

  /**
   * Accept the delivery and pay the payee C with part of a note this agent holds: the issuer A's debt to me falls by the
   * price and A's debt to C rises by it (PROTOCOL.md 18.6). `issuer` names A among the notes the deal's payment options
   * list: by participant id, or by handle when no id matches (unknown_issuer otherwise).
   *
   * Checked before anything is signed: the delivery and the agreement as for complete(), and the payee's signature on
   * the delivery; the server lists circulation/1 (feature_unavailable); the template is for the issuer chosen, under that
   * participant's current key (bad_template); novation.evaluatePayerTemplate (15.3 R1-R13, and decision D-1, with one
   * GET /edges read-back when an earlier attempt's edge must be read). With expectedQuoteDigest (the quote the owner
   * approved) another quote is stale_quote; with expectedClaimTotal (my claim on A that the owner saw) another prior
   * total of A->me is stale_claim.
   *
   * Saved before anything is sent (R9): the R4 record of the three slots, the payment attempt (transfer_attempts), the
   * pending decrease of my claim on A (records) and approved_payments[deal_id] = the quote digest. A 409 transfer_stale
   * that the server answers with a fresh template is retried once under the same quote digest; one that names the
   * transfer it recorded (transfer_id, regenerated_as) is not retried, and the deal view is returned. paid_by_transfer
   * records the deal as paid; a refusal, or payment_due, forgets the pending entry, and the attempt stays until it is
   * dead (with the server's id of it, attempt_id, once known). Resolves to the deal view.
   */
  async payByTransfer(dealId, issuer, {expectedDeliverableSha256 = undefined, expectedQuoteDigest = undefined,
    expectedClaimTotal = undefined} = {}) {
    const claim = expectedClaimTotal ?? null;
    if (claim !== null && !natural(claim)) {
      throw new ValunError('bad_arguments', 'expected_claim_total is a whole number of PC (the claim your owner saw); nothing was signed');
    }
    this.#secretBytes().fill(0);
    const d = await this.deal(dealId);
    const [terms, h, dh] = this.#acceptedDelivery(d, dealId, expectedDeliverableSha256);
    const payee = await this.#registeredKey(terms.payee.id);
    Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
    const features = await this.#circulation();
    const issuerId = await this.#resolveIssuer(dealId, issuer);
    const issuerPk = await this.#registeredKey(issuerId);
    const mandate = mandateOf(await this.me());
    const deal = nv.dealContext(terms, h, dh);
    let tpl = await this.transferTemplate(dealId, issuerId);
    let approved = expectedQuoteDigest ?? null;
    for (const retry of [false, true]) {
      const [r, body] = await this.#transferSigned(tpl, issuerId, issuerPk, payee, deal, features, mandate, approved, claim);
      const a = r.write_ahead.attempt;
      const forget = state => { records.removePending(recordsIn(state), a.edge, a.total, a.timestamp, deal.deal_id); };
      let view;
      try {
        view = await this.request('POST', `/pilot/v1/deals/${seg(deal.deal_id)}/pay-by-transfer`, body);
      } catch (e) {
        if (isValunError(e) && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {   // refused, or recorded and failed
          await this.#settle(forget);
          const ex = isDict(e.extra) ? e.extra : {};
          const recorded = nv.shownId(pyGet(ex, 'transfer_id')) || nv.shownId(pyGet(ex, 'regenerated_as'));
          if (e.code === 'transfer_stale' && recorded) {
            // The server recorded this transfer and the edges changed before it applied: never retried here. A transfer
            // made again is signed as a consent, under the quote approved now (processConsents).
            const tid = nv.shownId(pyGet(ex, 'transfer_id'));
            if (tid) await this.#settle(state => Client.#noteAttemptId(state, a, tid));
            return isDict(pyGet(ex, 'deal')) ? ex.deal : this.deal(dealId);
          }
          if (e.code === 'transfer_stale' && !retry) {
            const fresh = pyGet(ex, 'template');
            tpl = isDict(fresh) ? fresh : await this.transferTemplate(dealId, issuerId);
            approved = truthy(approved) ? approved : r.summary.quote_digest;
            continue;
          }
        }
        throw e;                                  // otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
      }
      const status = isDict(view) ? pyGet(view, 'status') : null;
      const pay = isDict(view) && isDict(pyGet(view, 'payment')) ? view.payment : {};
      const tid = nv.shownId(pyGet(pay, 'transfer_id'));
      if (tid) await this.#settle(state => Client.#noteAttemptId(state, a, tid));
      if (status === 'paid_by_transfer') {
        await this.#settle(state => guarded(nv.markPaid, state, a.deal_id, 'transfer', a.edge, a.total, a.timestamp));
      } else if (status === 'payment_due') {
        await this.#settle(forget);
      }
      return view;
    }
    return undefined;                             // not reached: the second attempt returns or throws
  }

  /** Record the server's id of a payment attempt (its transfer id) on my record of it. An id it already has is kept. */
  static #noteAttemptId(state, attempt, attemptId) {
    const att = state.transfer_attempts;
    const lst = isDict(att) ? or(pyGet(att, attempt.deal_id), []) : [];
    for (const x of Array.isArray(lst) ? lst : []) {
      if (isDict(x) && ['route', 'edge', 'total', 'timestamp'].every(k => pyEq(pyGet(x, k), attempt[k])) && !truthy(pyGet(x, 'attempt_id'))) {
        x.attempt_id = attemptId;
      }
    }
  }

  /** One attempt of payByTransfer(): check the template, save what is about to be signed, sign it. [evaluation, body]. */
  async #transferSigned(tpl, issuerId, issuerPk, payee, deal, features, mandate, approved, claim) {
    const iss = isDict(tpl) ? pyGet(tpl, 'issuer') : null;
    if (!(isDict(iss) && pyGet(iss, 'id') === issuerId && pyGet(iss, 'pubkey') === issuerPk)) {
      throw new ValunError('bad_template', "the transfer template is not for the issuer you chose, under that issuer's current key; nothing was signed");
    }
    const nowMs = this.#now();
    const signedAt = isoSeconds(nowMs);
    const claimShown = r => {
      const held = tpl.from_edge.before.total;
      if (claim !== null && !pyEq(held, claim)) {
        return refused(r, 'stale_claim', `your claim on this issuer is ${str(held)} PC now, not the ${str(claim)} PC you reviewed; `
          + 'nothing was signed. Review the payment again.');
      }
      return null;
    };
    const approve = (state, r) => { dictIn(state, 'approved_payments')[deal.deal_id] = r.summary.quote_digest; };
    const r = await this.#decide((state, edges) => nv.evaluatePayerTemplate(tpl, this.#ctx(state, nowMs, features,
      {deal, payee_current_pk: payee, approved_quote_digest: approved, mandate, edges})), signedAt, {refuse: claimShown, also: approve});
    if (!r.ok) throw refusalError(r);
    const q = r.summary.quote_digest;
    const toBefore = pyGet(tpl.to_edge, 'before');
    const msgs = nv.slotMessages(r.to_sign, tpl.tracker_nft_id, tpl.denomination);
    const body = {issuer_id: issuerId, terms_hash: deal.terms_hash, deliverable_sha256: deal.deliverable_sha256, quote_digest: q,
      timestamp: tpl.timestamp, from_prior_total: tpl.from_edge.before.total, to_prior_total: toBefore !== null ? toBefore.total : 0,
      completion_signature: this.#sign(statements.complete(deal.terms_hash, deal.deliverable_sha256)),
      pay_signature: this.#sign(nv.payStatement(deal.deal_id, q)), signatures: {}};
    for (const [slot, m] of Object.entries(msgs)) body.signatures[slot] = this.#signBytes(m);
    return [r, body];
  }

  /**
   * The participant id of the issuer `issuer` names among the notes the deal's payment options list: an exact
   * participant id first; a handle only when no id matches, and only when exactly one listed issuer has it.
   */
  async #resolveIssuer(dealId, issuer) {
    if (typeof issuer !== 'string' || !issuer) {
      throw new ValunError('unknown_issuer', 'name the issuer of the note to pay with, by participant id or handle');
    }
    const opts = await this.paymentOptions(dealId);
    const held = isDict(opts) ? pyGet(opts, 'held_notes') : null;
    const issuers = (Array.isArray(held) ? held : [])
      .filter(x => isDict(x) && isDict(pyGet(x, 'issuer')) && typeof pyGet(x.issuer, 'id') === 'string').map(x => x.issuer);
    for (const x of issuers) if (x.id === issuer) return x.id;
    const named = issuers.filter(x => pyGet(x, 'handle') === issuer);
    if (named.length === 1) return named[0].id;
    throw new ValunError('unknown_issuer', `the payment options for this deal list no note of yours from ${repr(cpSlice(issuer, 64))}; `
      + 'nothing was signed');
  }

  /**
   * POST /deals/{id}/cancel-transfer (the payer, while its transfer collects signatures). Not signed: a refusal cannot
   * move value. The deal becomes payment_due. The pending decrease of my held claim is forgotten; the payment attempt
   * stays until it is dead (decision D-1), because its signatures exist until their maximum age.
   */
  async cancelTransfer(dealId) {
    const r = await this.request('POST', `/pilot/v1/deals/${seg(dealId)}/cancel-transfer`, {});
    if (isDict(r) && ['payment_due', 'delivered'].includes(pyGet(r, 'status'))) {
      await this.#settle(state => Client.#forgetTransfers(state, dealId));
    }
    return r;
  }

  // ---------- payment attempts, and the owner's resolution of one (decisions D-1 item 3, D-2 d) ----------
  /** [[attempt, outcome]] of the deal's payment attempts in `state`, as the payer evaluators weigh them. */
  #dealRows(state, dealId, nowMs, edges = null) {
    if (!this.pubkey) throw new ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it');
    const r = nv.classifyAttempts(dealId, this.#ctx(state, nowMs, [], {edges: truthy(edges) ? edges : null}));
    if (!r.ok) {
      throw new ValunError(nv.REFUSAL_CODES.includes(r.code) ? r.code : 'records_unreadable',
        "this profile's record of payment attempts cannot be read, or an edge state read does not verify; nothing was changed");
    }
    return r.attempts.map(x => [x.attempt, x.outcome]);
  }

  /**
   * This client's payment attempts, deal by deal, as its records hold them, each with how the payer evaluators classify
   * it now (novation.classifyAttempts). `edges` is a read-back of my edges, {edge: EdgeState} this client verified
   * (syncEdges().edges): an edge of my attempts that it does not list does not exist, unless `doubtful`
   * (syncEdges().doubtful) lists it; null: nothing was read. Makes no request.
   * Returns [{deal_id, ref ('#n'), attempt_id, route, edge, prior, total, timestamp, outcome, state ('applied' | 'unknown'
   * | 'alive' | 'dead' | 'unread'), paid, paid_by}]. records_unreadable when the records cannot be read.
   */
  paymentAttempts({edges = null, nowMs = null, doubtful = null} = {}) {
    const now = nowMs ?? this.#now();
    const state = this.state;
    const recs = recordsIn(state, false);
    const paid = isDict(pyGet(recs, nv.PAID_DEALS_KEY)) ? recs[nv.PAID_DEALS_KEY] : {};
    let read = null;
    if (edges !== null && edges !== undefined) {
      read = {...edges};
      const skip = new Set(doubtful || []);
      for (const e of attemptEdges(state)) if (!Object.hasOwn(read, e) && !skip.has(e)) read[e] = null;   // not listed: absent
    }
    const out = [];
    for (const dealId of sortedStrings(attemptDeals(state))) {
      const rows = this.#dealRows(state, dealId, now, read).map(([a, o], i) => ({
        deal_id: dealId, ref: `#${i + 1}`, attempt_id: nv.shownId(pyGet(a, 'attempt_id')), route: a.route, edge: a.edge,
        prior: pyGet(a, 'prior'), total: a.total, timestamp: a.timestamp,
        outcome: ATTEMPT_OUTCOMES.includes(pyGet(a, 'outcome')) ? a.outcome : null, state: o, paid: Object.hasOwn(paid, dealId)}));
      const by = isDict(pyGet(paid, dealId)) ? attemptKey(paid[dealId]) : null;
      const hit = by !== null ? rows.find(r => sameAttemptKey(attemptKey(r), by)) : undefined;
      for (const r of rows) r.paid_by = hit ? hit.ref : null;
      out.push(...rows);
    }
    return out;
  }

  /**
   * How resolveAttempt() would resolve payment attempt `attempt` ('#n', or the server's id of a transfer) of deal `dealId`
   * (decision D-2 d), so that the owner sees it before deciding. Reads GET /info, and GET /transfers/{id} for a transfer
   * whose server id is known, on a server that lists circulation/1. Changes nothing. Resolves to {deal_id, attempt,
   * attempts, attempt_id, route, transfer, server, local} (see the Python reference's resolution_plan()).
   */
  async resolutionPlan(dealId, attempt, {edges = null, nowMs = null, doubtful = null} = {}) {
    if (!(typeof dealId === 'string' && DEAL_ID_RE.test(dealId))) {
      throw new ValunError('bad_arguments', 'name the deal by its id (vd_ and 16 hex digits)');
    }
    const byRef = typeof attempt === 'string' && ATTEMPT_REF_RE.test(attempt);
    if (!(byRef || (typeof attempt === 'string' && TRANSFER_ID_RE.test(attempt)))) {
      throw new ValunError('bad_arguments', "name the attempt as #n from `valun attempts list`, or by the server's id "
        + 'of a transfer (vt_ and 16 hex digits)');
    }
    const circulation = featuresOf(await this.info()).includes('circulation/1');
    const rows = this.paymentAttempts({edges, nowMs, doubtful}).filter(r => r.deal_id === dealId);
    let target, sid;
    if (byRef) {
      const n = Number(attempt.slice(1));
      if (n > rows.length) {
        throw new ValunError('unknown_attempt', `your records hold no attempt ${attempt} of this deal; see \`valun `
          + 'attempts list`; nothing was changed');
      }
      target = rows[n - 1];
      sid = target.route === 'transfer' ? target.attempt_id : null;
    } else {
      sid = attempt;
      target = rows.find(r => r.attempt_id === sid) ?? null;
    }
    const plan = {deal_id: dealId, attempt: target, attempts: rows, attempt_id: sid, route: target !== null ? target.route : 'transfer',
      transfer: null, server: false, local: null};
    if (plan.route === 'note') plan.local = 'note';
    else if (!circulation) plan.local = 'no_circulation';
    else if (sid === null) plan.local = 'no_server_id';
    else await this.#planTransfer(plan);
    return plan;
  }

  /** resolutionPlan() for a transfer with a server id, on a circulation server (GET /transfers/{id}). */
  async #planTransfer(plan) {
    const sid = plan.attempt_id;
    let target = plan.attempt;
    let t;
    try {
      t = await this.request('GET', `/pilot/v1/transfers/${seg(sid)}`);
    } catch (e) {
      if (!isValunError(e) || e.status !== 404) throw e;
      t = null;
    }
    t = isDict(t) ? t : {};
    const deal = isDict(pyGet(t, 'deal')) ? t.deal : {};
    const roles = Array.isArray(pyGet(t, 'your_roles')) ? t.your_roles : [];
    const info = {...this.#heldOf(t), id: sid, state: serverWord(pyGet(t, 'state'))};
    const same = r => r.route === 'transfer' && info.timestamp !== null && pyEq(r.timestamp, info.timestamp)
      && r.edge === info.edge && (info.total === null || pyEq(r.total, info.total));
    const tid = pyGet(t, 'id');
    const mine = truthy(t) && pyGet(deal, 'deal_id') === plan.deal_id && roles.includes('payer') && (tid === null || tid === sid);
    if (mine && target === null) {
      const found = plan.attempts.filter(same);
      plan.attempt = target = found.length === 1 ? found[0] : null;
    }
    if (!mine || (target !== null && !same(target))) {
      if (target === null) {
        throw new ValunError('unknown_attempt', `the server shows no transfer ${sid} of yours for this deal, and your `
          + 'records hold no attempt with that id; name it as #n from `valun attempts list` (nothing was changed)');
      }
      plan.local = 'server_unknown';
      return;
    }
    plan.transfer = info;
    if (UNRESOLVED_TRANSFER.includes(info.state)) {
      plan.server = true;
    } else if (LIVE_TRANSFER.includes(info.state)) {
      throw new ValunError('attempt_in_progress', `the server shows this transfer ${info.state}: it can still apply. `
        + 'Wait until it ends (or cancel it); nothing was changed');
    } else {
      plan.local = 'server_ended';
    }
  }

  /** {timestamp, edge, total} of a transfer view: its timestamp, and my held edge (to my key) at its new total. */
  #heldOf(t) {
    t = isDict(t) ? t : {};
    const es = pyGet(t, 'edges');
    const held = (Array.isArray(es) ? es : []).filter(e => isDict(e) && typeof pyGet(e, 'edge') === 'string'
      && nv.parseEdge(e.edge) !== null && e.edge.endsWith(`>${this.pubkey}`));
    return {timestamp: natural(pyGet(t, 'timestamp')) ? t.timestamp : null, edge: held.length === 1 ? held[0].edge : null,
      total: held.length === 1 && natural(pyGet(held[0], 'new_total')) ? held[0].new_total : null};
  }

  /**
   * The owner token is the owner's of this profile's participant: GET /pilot/v1/owner with it (read only). not_owner
   * when the server refuses the token (401, 403, 404) or names another participant, or none.
   */
  async #checkOwner(ownerToken) {
    let me;
    try {
      me = await this.request('GET', '/pilot/v1/owner', undefined, {token: ownerToken});
    } catch (e) {
      if (isValunError(e) && [401, 403, 404].includes(e.status)) {
        throw new ValunError('not_owner', 'this is not the owner token of this participant; nothing was changed', e.status);
      }
      throw e;
    }
    const p = isDict(me) && isDict(pyGet(me, 'participant')) ? me.participant : {};
    if (!truthy(pyGet(p, 'id')) || pyGet(p, 'id') !== this.participantId) {
      throw new ValunError('not_owner', "this owner token is not the owner's of this profile's participant; nothing was changed");
    }
    return me;
  }

  /**
   * The OWNER's resolution of a payment attempt whose outcome is unknown, after confirming with the payee whether the
   * payment arrived (decision D-2 d). Never called by an agent. outcome 'not_applied' | 'applied'; ownerToken is used once
   * as the bearer of one request and never stored. Options: note (for the server's audit line), localOnly (record the
   * decision in this client's records only: LOCAL_CHOICES), edges, nowMs, doubtful, expectedAttempt (attemptKey() of the
   * attempt the owner confirmed, or null; refuses attempt_changed when the plan now names another). Resolves to
   * {deal_id, attempt_id, outcome, server, local, matched, paid} (see the Python reference's resolve_attempt()).
   */
  async resolveAttempt(dealId, attempt, outcome, ownerToken, {note = null, localOnly = false, edges = null, nowMs = null,
    doubtful = null, expectedAttempt = UNCHECKED} = {}) {
    if (!ATTEMPT_OUTCOMES.includes(outcome)) throw new ValunError('bad_arguments', "outcome is 'not_applied' or 'applied'");
    if (!(typeof ownerToken === 'string' && strip(ownerToken))) {
      throw new ValunError('bad_arguments', 'the owner token is needed to resolve a payment attempt; nothing was changed');
    }
    if (!(expectedAttempt === UNCHECKED || expectedAttempt === null || (Array.isArray(expectedAttempt) && expectedAttempt.length === 4))) {
      throw new ValunError('bad_arguments', 'expected_attempt is the attempt_key() of the attempt confirmed, or None; nothing was changed');
    }
    ownerToken = strip(ownerToken);
    note = ownerNote(note);
    const now = nowMs ?? this.#now();
    await this.#reload();                         // plan again on the records as they are now (another process may write)
    const plan = await this.resolutionPlan(dealId, attempt, {edges, nowMs: now, doubtful});
    const target = plan.attempt, shownT = plan.transfer || {};
    if (expectedAttempt !== UNCHECKED && !sameAttemptKey(attemptKey(target), expectedAttempt === null ? null : [...expectedAttempt])) {
      throw new ValunError('attempt_changed', `the deal's payment attempts changed since you confirmed: ${attempt} no `
        + 'longer names the attempt you were shown; nothing was changed; look at them again (`valun attempts list`) and '
        + 'resolve the one you mean');
    }
    if (outcome === 'not_applied' && ((target !== null && target.state === 'applied') || pyGet(shownT, 'state') === 'applied')) {
      throw new ValunError('already_paid', 'your records (or the server) show this payment applied, so the deal is paid; it is '
        + 'not resolved as not applied; nothing was changed');
    }
    if (LOCAL_CHOICES.includes(plan.local) && !localOnly) {
      const code = {no_server_id: 'attempt_id_unknown', server_unknown: 'not_found', server_ended: 'wrong_state'}[plan.local];
      throw new ValunError(code, 'the server cannot resolve this transfer; only your owner can choose to record the decision '
        + "in your client's records only; nothing was changed", undefined, {local_possible: true, local: plan.local});
    }
    let price = null;
    if (target !== null && target.prior === null) {     // a pending entry: its record needs the verified price
      price = this.verifiedAgreement(await this.deal(dealId)).price.amount;
    }
    let answer = null;
    if (plan.server && !localOnly) {
      const body = note === null ? {outcome} : {outcome, note};
      try {
        answer = await this.request('POST', `/pilot/v1/owner/deals/${seg(dealId)}/attempts/${seg(plan.attempt_id)}/resolve`, body,
          {token: ownerToken});
      } catch (e) {
        if (isValunError(e) && ((e.status === 404 && e.code === 'not_found') || (e.status === 409 && e.code === 'wrong_state'))) {
          // The owner routes answer 404 to an agent token and to another participant's owner token too: a resolution in
          // my records only is offered for a 404 only with this participant's owner token (not_owner otherwise).
          if (e.status === 404) await this.#checkOwner(ownerToken);
          throw new ValunError(e.code, `the server did not resolve it: ${cpSlice(e.message, 300)}`, e.status,
            {local_possible: true, server: {error: e.code, message: cpSlice(e.message, 300)}});
        }
        throw e;
      }
    } else {
      await this.#checkOwner(ownerToken);
    }
    const sid = plan.route === 'transfer' ? plan.attempt_id : null;
    const resolved = target === null && isDict(answer) ? this.#heldOf(pyGet(answer, 'transfer')) : {};
    const signedAt = isoSeconds(this.#now());
    const key = a => [a.route, a.edge, a.total, a.timestamp];
    const [matched, paid] = await this.#update(state => {
      const att = dictIn(state, 'transfer_attempts');
      let lst = pyGet(att, dealId);
      if (lst === null) lst = att[dealId] = [];
      if (!Array.isArray(lst)) throw new ValunError('records_unreadable', "this profile's record of payment attempts cannot be read");
      const rows = this.#dealRows(state, dealId, now).map(([a]) => a);
      let hits;
      if (target !== null) {
        hits = rows.filter(a => pyEq(key(a), key(target)));
      } else {                                     // recorded with the server's id meanwhile, or the one the answer shows
        hits = rows.filter(a => sid && a.route === 'transfer' && pyGet(a, 'attempt_id') === sid);
        if (!hits.length && (pyGet(resolved, 'timestamp') ?? null) !== null && truthy(pyGet(resolved, 'edge'))) {
          hits = rows.filter(a => a.route === 'transfer' && pyEq(a.timestamp, resolved.timestamp) && a.edge === resolved.edge
            && (resolved.total === null || pyEq(resolved.total, a.total))).slice(0, 1);
        }
      }
      const out = [];
      for (const a of hits) {
        let rec = lst.find(x => x === a) ?? null;
        if (rec === null) {                       // a pending entry: recorded as an attempt from now on
          if (price === null) continue;
          rec = {...a, prior: a.route === 'note' ? a.total - price : a.total + price};
          if (rec.prior < 0) continue;
          lst.push(rec);
        }
        if (outcome === 'applied' || pyGet(rec, 'outcome') !== 'applied') rec.outcome = outcome;   // evidence that it applied is kept
        if (sid && rec.route === 'transfer' && !truthy(pyGet(rec, 'attempt_id'))) rec.attempt_id = sid;
        rec.resolved_at = signedAt;
        out.push({...rec});
        if (outcome === 'applied') guarded(nv.markPaid, state, dealId, rec.route, rec.edge, rec.total, rec.timestamp);
      }
      if (outcome === 'applied' && !out.length) {
        const seen = truthy(pyGet(shownT, 'edge')) ? shownT : resolved;
        guarded(nv.markPaid, state, dealId, plan.route, pyGet(seen, 'edge'), pyGet(seen, 'total'), pyGet(seen, 'timestamp'));
      }
      if (!lst.length) delete att[dealId];
      if (outcome === 'not_applied' && !out.length && answer === null) {
        throw new ValunError('unknown_attempt', 'your records hold no attempt this names, so nothing is resolved in them; name it '
          + 'as #n from `valun attempts list`');
      }
      const p = pyGet(recordsIn(state), nv.PAID_DEALS_KEY);
      return [out, isDict(p) && Object.hasOwn(p, dealId)];
    });
    return {deal_id: dealId, attempt_id: sid, outcome, server: answer, local: answer !== null ? null : (plan.local || 'owner_choice'),
      matched, paid};
  }

  static #forgetTransfers(state, dealId) {
    const att = state.transfer_attempts;
    const lst = isDict(att) ? pyGet(att, dealId) : null;
    const recs = recordsIn(state);
    for (const a of Array.isArray(lst) ? lst : []) {
      if (isDict(a) && pyGet(a, 'route') === 'transfer' && typeof pyGet(a, 'edge') === 'string') {
        records.removePending(recs, a.edge, pyGet(a, 'total'), pyGet(a, 'timestamp'), dealId);
      }
    }
  }

  // ---------- circulating credit: consents (PROTOCOL.md 15.3, 18.9; design 6.6) ----------
  /** GET /consents: the transfers and set-offs that wait for this agent's signatures ({consents: [item], recently_resolved}). */
  consents() {
    return this.request('GET', '/pilot/v1/consents');
  }

  /** POST /consents/{id} {signatures {'<edge>:<slot>': sig}, revisions {edge: n}}: send signatures this client made. */
  submitConsent(consentId, signatures, revisions) {
    return this.request('POST', `/pilot/v1/consents/${seg(consentId)}`, {signatures, revisions});
  }

  /** POST /consents/{id}/refuse {reason?}: end a transfer or a set-off. Not signed: a refusal cannot move value. */
  refuseConsent(consentId, reason = null) {
    return this.request('POST', `/pilot/v1/consents/${seg(consentId)}/refuse`, reason === null || reason === undefined ? {} : {reason});
  }

  /**
   * Sign by itself the consents its owner's policy allows, and refuse the others (PROTOCOL.md 15.3, 18.9; design 6.6).
   * Deterministic; no rate limit here (the agent layer runs it at most once per 60 s).
   *
   * valueSafeOnly (decision D-3 a): the run an adapter without a consent loop makes before a read-only tool
   * (valun_status, valun_inbox). It handles only the items whose one role is in VALUE_SAFE_ROLES (member: a set-off;
   * payee: a payment to me by transfer), and only by signing what the firewall and the policy allow: it refuses nothing
   * (an item they refuse waits, with their code, for a full run), and an item in any other role is neither read further,
   * signed nor refused (waiting, code 'not_value_safe'; not written to consent_log). The run is recorded in
   * consents_last_safe_run_ms, never in consents_last_run_ms.
   *
   * `policy` is the local consent policy; null takes the profile's consent_policy, and an absent policy signs nothing.
   * The owner's side is the mandate GET /me shows; the stricter of the two applies (R8). Nothing more is read or sent
   * unless GET /info lists circulation/1. Resolves to {signed: [entry], refused: [entry], waiting: [entry]}, entry =
   * {id, kind, role, deal_id, amount, your_net_change_PC, your_total_owed_change_PC, code, reason} (signed entries add
   * state and rejected; an entry whose request failed adds error). Each decision is appended to consent_log (the last
   * CONSENT_LOG_MAX), and consents_last_run_ms (or consents_last_safe_run_ms) is set to nowMs.
   */
  async processConsents({policy = null, nowMs = null, valueSafeOnly = false} = {}) {
    this.#secretBytes().fill(0);
    const report = {signed: [], refused: [], waiting: []};
    const now = nowMs ?? this.#now();
    const log = [];
    const ran = valueSafeOnly ? 'consents_last_safe_run_ms' : 'consents_last_run_ms';
    const logged = state => {
      const old = state.consent_log;
      state.consent_log = [...(Array.isArray(old) ? old : []), ...log].slice(-CONSENT_LOG_MAX);
      state[ran] = now;
    };
    const skipped = it => valueSafeOnly && !VALUE_SAFE_ROLES.includes(oneRole(it));   // an item this run leaves as it is
    try {
      const features = featuresOf(await this.info());
      if (!features.includes('circulation/1')) return report;   // still a run, for the agent layer's rate limit
      const data = await this.consents();
      const items = isDict(data) ? pyGet(data, 'consents') : null;
      if (!Array.isArray(items)) throw new ValunError('bad_response', 'GET /consents did not answer {consents: [...]}');
      let mandate = null, run = null, readBack = null;
      if (items.some(it => !skipped(it))) {
        mandate = mandateOf(await this.me());
        run = {deals: new Map(), edges: null, read: false, issuer_ids: null};
        readBack = async () => {                  // at most one GET /edges per run
          if (!run.read) {
            run.read = true;
            run.edges = await this.#readBack();
          }
          return run.edges;
        };
      }
      for (const it of items) {
        if (skipped(it)) {
          report.waiting.push(Client.#consentEntry(it, null, {code: 'not_value_safe',
            reason: 'a consent in this role is signed or refused only before a tool call that is not read-only'}));
          continue;
        }
        let bucket, entry;
        try {
          [bucket, entry] = await this.#consent(it, policy, mandate, features, now, run, readBack, !valueSafeOnly);
        } catch (e) {                             // one item never stops the others, nor the record of the run
          const code = isValunError(e) ? serverWord(e.code) : 'internal_error';
          bucket = 'waiting';
          entry = Client.#consentEntry(it, null, {code, error: code,
            reason: `this item could not be handled now${said(code)}; it is handled again on a later run`});
        }
        report[bucket].push(entry);
        log.push({at: isoSeconds(this.#now()), id: entry.id, kind: entry.kind, role: entry.role, decision: bucket, code: entry.code,
          deal_id: entry.deal_id, amount: entry.amount, your_net_change_PC: entry.your_net_change_PC});
      }
      return report;
    } finally {
      await this.#settle(logged);
    }
  }

  /** processConsents() for one item: [bucket, entry]. refuse false (a valueSafeOnly run): a refusal waits for a full run. */
  async #consent(it, policy, mandate, features, now, run, readBack, refuse = true) {
    if (!isDict(it) || typeof pyGet(it, 'id') !== 'string' || !it.id) {
      return ['waiting', Client.#consentEntry(it, null, {code: 'bad_consent', reason: 'a consent item without an id'})];
    }
    if (pyGet(it, 'state') !== 'collecting') {
      return ['waiting', Client.#consentEntry(it, null, {reason: 'the item is not collecting signatures'})];
    }
    const roles = pyGet(it, 'your_roles');
    const role = Array.isArray(roles) && roles.length === 1 ? roles[0] : null;
    let deal = null, payeePk = null, issuerIds = null;
    if (role === 'payer' || role === 'payee') {
      try {
        [deal, payeePk] = await this.#consentDeal(it, role, run);
        if (role === 'payee') issuerIds = await this.#consentIssuerIds(run);
      } catch (e) {                               // the deal or the directory could not be read now: decide on a later run
        if (!isValunError(e)) throw e;
        const code = serverWord(e.code);
        return ['waiting', Client.#consentEntry(it, null, {code, error: code, reason: `could not be read now${said(code)}; decided on a later run`})];
      }
    }
    const signedAt = isoSeconds(this.#now());
    const evaluate = (state, edges) => {
      let approved = null;
      if (role === 'payer' && deal !== null) {
        const ap = state.approved_payments;
        approved = isDict(ap) ? pyGet(ap, deal.deal_id) : null;
      }
      return nv.evaluateConsent(it, this.#ctx(state, now, features, {
        consent_policy: policy !== null && policy !== undefined ? policy : (state.consent_policy ?? null), mandate, deal,
        payee_current_pk: payeePk, approved_quote_digest: approved, edges, issuer_ids: issuerIds}));
    };
    const r = await this.#decide(evaluate, signedAt, {edges: truthy(run.edges) ? run.edges.edges : null, readBack});
    if (!r.ok && !refuse) {
      return ['waiting', Client.#consentEntry(it, r, {reason: 'refused only by a consent run before a tool call that is not read-only'})];
    }
    if (!r.ok) {
      try {
        await this.refuseConsent(it.id, r.code);
      } catch (e) {
        if (!isValunError(e)) throw e;
        return ['refused', Client.#consentEntry(it, r, {error: serverWord(e.code)})];
      }
      return ['refused', Client.#consentEntry(it, r)];
    }
    if (!r.to_sign.length) {
      return ['waiting', Client.#consentEntry(it, r, {reason: 'you have signed every slot of yours; waiting for the others'})];
    }
    const msgs = nv.slotMessages(r.to_sign, it.tracker_nft_id, it.denomination);
    const sigs = {};
    for (const [slot, m] of Object.entries(msgs)) sigs[slot] = this.#signBytes(m);
    const mine = new Set(Object.keys(sigs).map(s => s.slice(0, s.lastIndexOf(':'))));
    const revisions = {};
    for (const e of it.edges) if (mine.has(e.edge)) revisions[e.edge] = e.revision;
    let ans;
    try {
      ans = await this.submitConsent(it.id, sigs, revisions);
    } catch (e) {
      if (!isValunError(e)) throw e;
      if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {   // refused: the server recorded none of these
        await this.#settle(state => Client.#forgetPending(state, r.write_ahead.pending));
      }
      const code = serverWord(e.code);
      return ['waiting', Client.#consentEntry(it, r, {error: code,
        reason: `the server did not take the signatures${said(code)}; tried again on a later run`})];
    }
    const answer = isDict(ans) ? serverWord(pyGet(ans, 'state')) : null;
    const rejectedRaw = isDict(ans) && Array.isArray(pyGet(ans, 'rejected')) ? ans.rejected : [];
    const rejected = rejectedRaw.filter(isDict).map(x => ({
      slot: typeof pyGet(x, 'slot') === 'string' && Object.hasOwn(sigs, x.slot) ? x.slot : null, code: serverWord(pyGet(x, 'code')),
      revision: natural(pyGet(x, 'revision')) ? x.revision : null}));
    const a = r.write_ahead.attempt ?? null;
    const tid = nv.shownId(it.id);
    if (a !== null && tid) await this.#settle(st => Client.#noteAttemptId(st, a, tid));   // a regenerated transfer of my payment
    if (answer === 'applied' && a !== null) {
      await this.#settle(st => guarded(nv.markPaid, st, a.deal_id, a.route, a.edge, a.total, a.timestamp));
    }
    if (rejected.length) {
      return ['waiting', Client.#consentEntry(it, r, {code: 'stale_revision', state: answer, rejected,
        reason: 'an edge was regenerated while you signed; it is signed again on a later run'})];
    }
    return ['signed', Client.#consentEntry(it, r, {state: answer, rejected: []})];
  }

  /**
   * [deal context, payee's current key] for a payer or payee consent, from the deal it names, read and verified here
   * (cached per run); [null, null] when it cannot be checked (the item is then refused: deal_mismatch). ValunError when
   * the server cannot be read now.
   */
  async #consentDeal(it, role, run) {
    const cv = pyGet(it, 'context');
    const cd = isDict(cv) ? pyGet(cv, 'deal') : null;
    const dealId = isDict(cd) ? pyGet(cd, 'deal_id') : null;
    if (typeof dealId !== 'string' || !dealId) return [null, null];
    const key = JSON.stringify([dealId, role]);
    if (run.deals.has(key)) return run.deals.get(key);
    let out = [null, null];
    try {
      const d = await this.deal(dealId);
      if (role === 'payer') {
        const [terms, h, dh] = this.#acceptedDelivery(d, dealId);
        const payee = await this.#registeredKey(terms.payee.id);
        Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
        out = [nv.dealContext(terms, h, dh), payee];
      } else {
        const terms = this.verifiedAgreement(d);
        const dv = pyGet(d, 'delivery'), pay = pyGet(d, 'payment');
        const delivered = isDict(dv) && pyGet(dv, 'by') === this.participantId && typeof pyGet(dv, 'content') === 'string'
          && sha256Hex(dv.content) === pyGet(dv, 'sha256');
        out = [nv.dealContext(terms, termsHash(terms), delivered ? dv.sha256 : null, delivered,
          isDict(pay) ? pyGet(pay, 'transfer_id') : null), null];
      }
    } catch (e) {
      if (isValunError(e) && transient(e)) throw e;   // anything else: it cannot be checked (refused: deal_mismatch)
    }
    run.deals.set(key, out);
    return out;
  }

  /**
   * {public key: participant id} of the active participants the public directory lists (one read per run), each key that
   * exactly one of them holds: the ids a payee's issuer lists are checked against (R8). ValunError when the directory
   * cannot be read now.
   */
  async #consentIssuerIds(run) {
    if (run.issuer_ids === null) {
      const people = await this.directory();
      if (!Array.isArray(people)) throw new ValunError('bad_response', 'GET /participants did not answer a list');
      const byKey = new Map();
      for (const p of people) {
        if (isDict(p) && pyGet(p, 'status', 'active') === 'active' && typeof pyGet(p, 'id') === 'string' && p.id && isPubkey(pyGet(p, 'pubkey'))) {
          if (!byKey.has(p.pubkey)) byKey.set(p.pubkey, new Set());
          byKey.get(p.pubkey).add(p.id);
        }
      }
      run.issuer_ids = Object.fromEntries([...byKey].filter(([, v]) => v.size === 1).map(([k, v]) => [k, [...v][0]]));
    }
    return run.issuer_ids;
  }

  /** One entry of processConsents()'s report: what the server wrote, only in a checked form; the rest the evaluator's. */
  static #consentEntry(it, r, more = {}) {
    const res = isDict(r) ? r : {};
    const s = or(pyGet(res, 'summary'), {});
    const item = isDict(it) ? it : {};
    const roles = pyGet(item, 'your_roles');
    const role = nv.ROLES.includes(pyGet(s, 'role')) ? s.role
      : (Array.isArray(roles) && roles.length === 1 && nv.ROLES.includes(roles[0]) ? roles[0] : null);
    const e = {id: nv.shownId(pyGet(item, 'id')), kind: ['transfer', 'setoff'].includes(pyGet(item, 'kind')) ? item.kind : null, role,
      deal_id: nv.shownId(pyGet(s, 'deal_id')), amount: pyGet(s, 'amount'), your_net_change_PC: pyGet(s, 'your_net_change_PC'),
      your_total_owed_change_PC: pyGet(s, 'your_total_owed_change_PC'), code: pyGet(res, 'code'), reason: pyGet(s, 'reason')};
    return Object.assign(e, more);
  }

  static #forgetPending(state, pending) {
    const recs = recordsIn(state);
    for (const p of pending) records.removePending(recs, p.pair, p.total, p.timestamp, p.ref);
  }

  // ---------- circulating credit: my edges (PROTOCOL.md 18.14; design 6.1, 11) ----------
  /**
   * Bring this client's records up to date from GET /edges?since=<journal_seq>. Every EdgeState shown (the current rows
   * and the journal entries) is verified as its issuer's signature on the pinned tracker and unit (R2); one that does not
   * verify is listed in rejected and used for nothing. With what verifies, in journal order and then the current rows:
   * records.syncEdge confirms each state, a pending entry of mine that a state shows is promoted, the deal a payment of
   * mine paid goes into records.paid_deals (as does the deal of a payment attempt whose own state an edge shows); an edge
   * a transfer or set-off changed goes into novated_edges (R12); the 0.3 issued record of an outgoing edge follows its
   * confirmed total. Then what is past use is pruned (design 11: RECORDS_KEEP_MS, SIGNATURES_KEEP_MS). journal_seq
   * advances to next_seq. Pages of EDGES_PAGE journal entries are read until a shorter one (at most EDGES_MAX_PAGES).
   *
   * Resolves to {applied, paid_deals, novated, pruned {signed, pending, attempts, signatures}, edges {edge: EdgeState},
   * rejected [{edge, seq, reason}], doubtful [edges listed only with a state that did not verify], journal_seq}.
   */
  async syncEdges({nowMs = null} = {}) {
    if (!this.#pinned()) await this.info();       // pins an enrolled profile
    const pins = pinsOf(this.state);
    if (!pins) throw new ValunError('tracker_mismatch', 'this profile has no pinned tracker and unit yet; nothing was read');
    const me = this.pubkey;
    if (!me) throw new ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it');
    const verify = noteVerifier(pins.tracker_nft_id, pins.denomination);
    const since = this.state.journal_seq;
    let cursor = natural(since) ? since : 0;
    let rows = [], nextSeq = cursor;
    const journal = [];
    for (let page = 0; page < EDGES_MAX_PAGES; page++) {
      const data = await this.request('GET', `/pilot/v1/edges?since=${cursor}`);
      if (!isDict(data)) throw new ValunError('bad_response', 'GET /edges did not answer a JSON object');
      const pg = Array.isArray(pyGet(data, 'journal')) ? data.journal : [];
      rows = ['incoming', 'outgoing'].flatMap(k => (Array.isArray(pyGet(data, k)) ? data[k] : []));
      journal.push(...pg);
      const nxt = pyGet(data, 'next_seq');
      nextSeq = natural(nxt) && nxt >= cursor ? nxt : cursor;
      if (pg.length < EDGES_PAGE || nextSeq <= cursor) break;
      cursor = nextSeq;
    }
    const current = new Map(), rejected = [], history = [], doubtful = new Set();
    for (const row of rows) {
      const got = Client.#edgeState(row, 'total', verify);
      if (typeof got === 'string') {
        rejected.push({edge: isDict(row) ? pyGet(row, 'edge') : null, seq: null, reason: got});
        if (isDict(row) && typeof pyGet(row, 'edge') === 'string') doubtful.add(row.edge);   // listed, but not readable
        continue;
      }
      current.set(got[0], [got[1], isDict(row) && pyGet(row, 'bound_only') === true]);
    }
    for (const e of journal) {
      const got = Client.#edgeState(e, 'total_after', verify);
      if (typeof got === 'string') {
        rejected.push({edge: isDict(e) ? pyGet(e, 'edge') : null, seq: isDict(e) ? pyGet(e, 'seq') : null, reason: got});
        continue;
      }
      history.push([natural(pyGet(e, 'seq')) ? e.seq : 0, got[0], got[1], pyGet(e, 'kind')]);
    }
    history.sort((x, y) => x[0] - y[0]);
    const now = nowMs ?? this.#now();
    const out = await this.#update(state => {
      const recs = recordsIn(state), issued = issuedIn(state);
      const res = {applied: [], paid_deals: [], novated: []};
      const seen = new Map();
      const take = (edge, st) => {
        if (!seen.has(edge)) seen.set(edge, new Set());
        seen.get(edge).add(JSON.stringify([st.total, st.timestamp]));
        const r = records.syncEdge(recs, {...st, edge});
        const p = r.promoted;
        if (p !== null && p !== undefined) {
          res.applied.push({pair: edge, total: pyGet(p, 'total'), timestamp: pyGet(p, 'timestamp'), kind: pyGet(p, 'kind'),
            ref: pyGet(p, 'ref'), direction: pyGet(p, 'direction')});
          const route = paidRoute(p);
          if (route && guarded(nv.markPaid, state, p.ref, route, edge, p.total, p.timestamp)) res.paid_deals.push(p.ref);
        }
        if (edge.startsWith(`${me}>`) && truthy(r.confirmed)) issued[edge] = r.confirmed.total;
      };
      for (const [, edge, st, kind] of history) {
        take(edge, st);
        if (JOURNAL_NOVATIONS.includes(kind) && markNovated(state, edge)) res.novated.push(edge);
      }
      for (const [edge, [st, boundOnly]] of current) {
        take(edge, st);
        if (boundOnly && markNovated(state, edge) && !res.novated.includes(edge)) res.novated.push(edge);
      }
      const att = state.transfer_attempts;
      for (const [dealId, lst] of isDict(att) ? Object.entries(att) : []) {
        for (const a of Array.isArray(lst) ? lst : []) {
          if (attemptShape(a) && (seen.get(a.edge)?.has(JSON.stringify([a.total, a.timestamp])) ?? false)
              && guarded(nv.markPaid, state, dealId, a.route, a.edge, a.total, a.timestamp)) {
            res.paid_deals.push(dealId);
          }
        }
      }
      res.pruned = Client.#prune(state, now, Object.fromEntries([...current].map(([e, [st]]) => [e, st])), doubtful);
      state.journal_seq = nextSeq;
      return res;
    });
    return {...out, edges: Object.fromEntries([...current].map(([e, [st]]) => [e, {...st}])), rejected,
      doubtful: sortedStrings([...doubtful].filter(e => !current.has(e))), journal_seq: nextSeq};
  }

  /** [edge, EdgeState] of a GET /edges row or journal entry whose issuer's signature verifies, else why not. */
  static #edgeState(row, totalKey, verify) {
    if (!isDict(row)) return 'not_an_object';
    const i = pyGet(row, 'issuer_pubkey'), r = pyGet(row, 'recipient_pubkey');
    const edge = pyGet(row, 'edge');
    const keys = edge !== null ? nv.parseEdge(edge) : (nv.parseEdge(`${str(i)}>${str(r)}`) ? [i, r] : null);
    if (keys === null || (i !== null && i !== keys[0]) || (r !== null && r !== keys[1])) return 'bad_edge';
    const st = {total: pyGet(row, totalKey), timestamp: pyGet(row, 'timestamp'), signature: pyGet(row, 'signature')};
    if (!(natural(st.total) && natural(st.timestamp) && typeof st.signature === 'string' && st.signature)) return 'bad_state';
    if (!verify(keys[0], keys[1], st.total, st.timestamp, st.signature)) return 'bad_signature';
    return [nv.edgeKey(keys[0], keys[1]), st];
  }

  /**
   * Drop what can no longer matter (design 11), RECORDS_KEEP_MS after it: see syncEdges(). `current` holds the verified
   * current state of each edge just read; an edge it does not list, that is not in `doubtful` and that my records hold no
   * state of does not exist. A confirmed state drops its signature SIGNATURES_KEEP_MS after its timestamp. Returns
   * {signed, pending, attempts, signatures}: how many entries (signatures) were dropped.
   */
  static #prune(state, nowMs, current, doubtful = new Set()) {
    const horizon = nowMs - RECORDS_KEEP_MS;
    const n = {signed: 0, pending: 0, attempts: 0, signatures: 0};
    const signed = state.signed;
    if (isDict(signed)) {
      for (const edge of Object.keys(signed)) {
        const per = signed[edge];
        if (!isDict(per)) continue;
        for (const ts of Object.keys(per)) {
          if (/^[0-9]+$/.test(ts) && Number(ts) < horizon) {
            delete per[ts];
            n.signed++;
          }
        }
        if (!Object.keys(per).length) delete signed[edge];
      }
    }
    const recs = isDict(state.records) ? state.records : {};
    const readBack = edge => {                    // the edge's current state as just read, or null when there is no read-back
      const conf = records.get(recs, edge).confirmed;
      const st = Object.hasOwn(current, edge) ? current[edge] : null;
      if (st === null) return conf !== null || doubtful.has(edge) ? null : {total: 0, timestamp: 0};
      if (isDict(conf) && natural(pyGet(conf, 'timestamp')) && conf.timestamp > st.timestamp) return null;   // a stale read
      return st;
    };
    for (const [pair, e] of Object.entries(recs)) {
      if (pair === nv.PAID_DEALS_KEY || !isDict(e) || !Array.isArray(e.pending)) continue;
      const st = readBack(pair);
      if (st === null) continue;
      const keep = e.pending.filter(p => !(isDict(p) && natural(pyGet(p, 'timestamp')) && EXPIRING_MS.includes(p.timestamp % 1000)
        && p.timestamp < horizon && p.timestamp > st.timestamp));
      n.pending += e.pending.length - keep.length;
      e.pending = keep;
    }
    const sigHorizon = nowMs - SIGNATURES_KEEP_MS;
    for (const [pair, e] of Object.entries(recs)) {
      const conf = pair !== nv.PAID_DEALS_KEY && isDict(e) ? pyGet(e, 'confirmed') : null;
      if (isDict(conf) && natural(pyGet(conf, 'timestamp')) && conf.timestamp < sigHorizon && Object.hasOwn(conf, 'signature')) {
        delete conf.signature;                    // applied long ago: its total and timestamp are what is still used
        n.signatures++;
      }
    }
    const paid = isDict(pyGet(recs, nv.PAID_DEALS_KEY)) ? recs[nv.PAID_DEALS_KEY] : {};
    const att = state.transfer_attempts;
    const done = (dealId, a) => {
      if (!(attemptShape(a) && a.timestamp < horizon)) return false;   // a malformed attempt is kept: the evaluators refuse it
      if (Object.hasOwn(paid, dealId)) return true;
      const st = readBack(a.edge);
      if (st === null || (!Object.hasOwn(st, 'signature') && a.prior > 0)) return false;
      const conf = records.get(recs, a.edge).confirmed;
      const floor = Math.max(isDict(conf) && natural(pyGet(conf, 'timestamp')) ? conf.timestamp : 0,
        natural(pyGet(a, 'prior_timestamp')) ? a.prior_timestamp : 0);
      return st.timestamp >= floor && nv.attemptOutcome(a, nowMs, st) === 'dead';
    };
    for (const dealId of isDict(att) ? Object.keys(att) : []) {
      const lst = att[dealId];
      if (!Array.isArray(lst)) continue;
      const keep = lst.filter(a => !done(dealId, a));
      n.attempts += lst.length - keep.length;
      if (keep.length) att[dealId] = keep;
      else delete att[dealId];
    }
    return n;
  }
}
