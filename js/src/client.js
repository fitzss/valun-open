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
import {CONSIDERATION, NETWORK, NETWORKS, PROTOCOL, UNIT, networkOf, reasonProblem, sha256Hex, statement, statements, termsHash} from './protocol.js';
import {get as pyGet, isDict, or, pyEq, repr, str, strip, truthy, cpSlice, cpLength} from './py.js';
import {randomBytes as defaultRandomBytes} from './random.js';
import * as records from './records.js';
import * as ergo from './ergo.js';

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
 * the empty list, decision D-3 b); guarantee_honors (fix inbox #18) {guarantee_id: {cap, calls: {call_id: {amount, state
 * ('pending', 'honored' or 'failed'), total, timestamp}}}}: the calls this client honored or is honoring as a backer, so
 * it never pays beyond the cap it signed, whatever a server shows. sandbox_tour_done (for the agent layer, 0.7.2): the
 * participant id whose sandbox tour valun_status saw done; its sandbox_next_steps then stays done (agent TOUR_DONE_KEY).
 */
export const CORE_STATE_KEYS = Object.freeze(['issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments',
  'consent_policy', 'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq', 'consents_last_safe_run_ms',
  'consent_roles_declared', 'guarantee_honors', 'sandbox_tour_done']);
/** Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them. */
export const RESERVED_MS_FROM = 995;
/** Guarantees (servers listing guarantees/1; fix inbox #18): the terms protocol and the one kind of cover it has. */
export const GUARANTEE_PROTOCOL = 'valun-guarantee/1';
export const GUARANTEE_COVERS = 'issuer_debt_to_creditor';
/** The deal mode (fix inbox #29): the terms name the deals they back (terms.deals) and cover only what is unpaid of them. */
export const GUARANTEE_COVERS_DEALS = 'issuer_payment_for_deals';
export const GUARANTEE_MAX_DEALS = 10;
/** The deals a guarantee names (fix inbox #29): 1 to GUARANTEE_MAX_DEALS different deal ids, else ValunError(code). */
function checkDealIds(deals, code) {
  if (!Array.isArray(deals) || deals.length < 1 || deals.length > GUARANTEE_MAX_DEALS || new Set(deals).size !== deals.length
      || !deals.every(d => typeof d === 'string' && DEAL_ID_RE.test(d))) {
    throw new ValunError(code, `deals must be 1 to ${GUARANTEE_MAX_DEALS} different deal ids (vd_ + 16 hex)`);
  }
}
/** state[GUARANTEE_HONORS_KEY][guarantee_id] = {cap, calls: {call_id: {amount, state, total, timestamp}}}. */
export const GUARANTEE_HONORS_KEY = 'guarantee_honors';
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
/**
 * The transfer states the server sets only before it ever submits a transfer to the tracker (PROTOCOL.md 18.6; valun-app
 * PILOT-API.md "Payment by debt transfer" steps 6-10): void_rejected and void_stale while it waits for the payer's owner
 * (nobody else has signed), cancelled and refused while it collects signatures, expired and void_expired (its collection
 * window passed) and void_key_revoked in either, or in the re-check before its first submission. The server saves
 * `applying` before every tracker call and purges these transfers' signatures, so on its word they never applied. Not
 * failed (it can follow a tracker call), resolved_not_applied (an owner's decision), outcome_unknown, inconsistent,
 * applied or a live state. Only what this client shows and advises uses it (attemptsOverview, resolutionPlan); the payer
 * evaluators (R11) never see it, so the server's word never lets this client sign a payment sooner.
 */
export const NEVER_APPLIED_TRANSFER = Object.freeze(['void_rejected', 'void_stale', 'void_expired', 'expired', 'cancelled', 'refused',
  'void_key_revoked']);
/**
 * A payment this client signed that the server held for the payer's owner (console approvals: review_deliveries holds
 * the IOU, or the payment by transfer, signed when the agent accepts a delivery) and that ended without being released:
 * its owner rejected it in the owner console, or the server voided it (as the Python client's OWNER_HELD_KINDS; the
 * approval semantics of 2026-11-17, approval probe D2). learnOwnerDecisions() records it as not applied.
 */
export const OWNER_HELD_KINDS = Object.freeze(['issue_note', 'pay_by_transfer']);
export const HELD_MATCH_MS = 600_000;              // an IOU's approval is made within 10 minutes of its timestamp (R5 window)

/** Did a held commitment's approval end without releasing it (rejected by the owner, or void)? */
export function holdEnded(approvalState) {
  return typeof approvalState === 'string' && (approvalState === 'rejected' || approvalState.startsWith('void_'));
}
export const RESOLVE_NOTE_MAX = 300;
/**
 * The server records an attempt as applied only while the payee's edge on the tracker shows the transfer (valun-app
 * SV-AUTH-1): otherwise 409 payee_edge_not_applied {payee_edge}, the class of that edge as it read it, and nothing changes.
 * resolveAttempt() explains it in these words and offers no resolution in this client's records only (PAYEE_EDGE_NEXT).
 */
export const PAYEE_EDGE_WHY = Object.freeze({
  prior: "the payee's edge is still at the state the transfer started from",
  changed: "the payee's edge changed before the transfer's timestamp, so the transfer cannot have applied there",
  moved_past: "the payee's edge moved past the transfer's timestamp at its earlier total",
  unknown: "the payee's edge is at a state that does not show the transfer",
});
export const PAYEE_EDGE_NEXT = Object.freeze(['not_applied', 'ask_operator']);
/** GET /edges answers at most this many journal entries at a time; syncEdges() reads at most EDGES_MAX_PAGES pages. */
export const EDGES_PAGE = 200;
export const EDGES_MAX_PAGES = 50;
const JOURNAL_NOVATIONS = ['transfer_out', 'transfer_in', 'setoff'];     // journal kinds that make an edge bound-only
const EXPIRING_MS = [997, 998, 999];
const PUBLIC_ROUTES = ['/pilot/v1/info', '/pilot/v1/participants', '/pilot/v1/ledger', '/pilot/v1/clearing', '/pilot/v1/join',
  '/pilot/v1/join-sandbox', '/pilot/v1/enroll'];
const DEAL_ID_RE = /^vd_[0-9a-f]{16}$/;
const PARTICIPANT_ID_RE = /^vp_[0-9a-f]{12}$/;
const TRANSFER_ID_RE = /^vt_[0-9a-f]{16}$/;
const ATTEMPT_REF_RE = /^#[1-9][0-9]{0,3}$/;
const SERVER_WORD_RE = /^[a-z_]{1,40}$/;
const APPROVAL_ID_RE = /^va_[0-9a-f]{12}$/;
const ISO_MS_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$/;

/**
 * A time as the server writes it (ISO 8601 in UTC: 2026-11-17T23:10:36.315Z) in ms since the epoch, or null for anything
 * else (another form, a date that does not exist, a year before 1970), as the Python client's _iso_to_ms.
 */
export function isoToMs(s) {
  const m = typeof s === 'string' ? ISO_MS_RE.exec(s) : null;
  if (m === null) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1, 7).map(Number);
  if (y < 1970 || mo < 1 || mo > 12 || hh > 23 || mm > 59 || ss > 59) return null;
  const t = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t + Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
}

/** An attempt record's server_ended ({state, approval_id, at}: learnOwnerDecisions) in that shape, or null. */
function heldEnd(v) {
  if (!isDict(v) || serverWord(pyGet(v, 'state')) === null) return null;
  const aid = pyGet(v, 'approval_id');
  return {state: v.state, approval_id: typeof aid === 'string' && APPROVAL_ID_RE.test(aid) ? aid : null,
    at: isoToMs(pyGet(v, 'at')) !== null ? v.at : null};
}
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

/**
 * Is the transfer GET /transfers showed (info: Client.#shownTransfer) the payment attempt row `r`: a transfer at the same
 * timestamp on the same held edge of mine, at the same new total (when the view shows one)?
 */
function showsAttempt(info, r) {
  return r.route === 'transfer' && info.timestamp !== null && pyEq(r.timestamp, info.timestamp) && r.edge === info.edge
    && (info.total === null || pyEq(r.total, info.total));
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

/**
 * Whether sigHex is a Basis signature by pubkeyHex over the UTF-8 bytes of `text` (a Valun statement); false for
 * anything malformed.
 */
function textSigned(pubkeyHex, text, sigHex) {
  if (!(isPubkey(pubkeyHex) && typeof sigHex === 'string' && /^0[23][0-9a-f]{128}$/.test(sigHex))) return false;
  try {
    return verifyHex(sigHex, utf8(text), pubkeyHex) === true;
  } catch {
    return false;                               // a verifier that fails accepts nothing
  }
}

const natural = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPubkey = v => typeof v === 'string' && /^0[23][0-9a-f]{64}$/.test(v);

/** A failure to reach or be served by the server, not an answer about the request itself: try again later. */
function transient(e) {
  // An answer that is not JSON (cut short, or a captive portal's or proxy's page) is one too: wait, as the Python
  // client's _transient does (the 0.7.2 review).
  return e.code === 'unreachable' || (typeof e.status === 'number' && (e.status >= 500 || e.status === 429))
    || (e.code === 'bad_response' && isDict(e.extra) && e.extra.cause === 'not_json');
}

// The transport (fix inbox #132, as the Python client's Client.request): a read (GET or HEAD) is sent again after each of
// READ_RETRY_WAITS_MS when its connection was cut (a reset socket, a socket closed with no answer, a body that stopped
// arriving) or when a proxy answered 502, 503 or 504 itself (no Valun error in its body); a write never is. A connection
// refused or a name that does not resolve is not sent again: a second try does not change it. Nor is a request whose
// answer did not come within the timeout (cause timed_out; the 0.7.2 review: three tries took three timeouts and tripled
// a busy server's load). A cut connection is cause connection_cut, as in Python, and a write's outcome is then unknown.
// fetch() asks for compressed answers and decodes them by itself.
export const READ_RETRY_WAITS_MS = Object.freeze([500, 1500]);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const PROXY_STATUSES = new Set([502, 503, 504]);
const CUT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const failureCode = e => e?.cause?.code ?? e?.code;
/** Was this fetch failure a connection cut on the way, once the server was reached (worth one more try of a read)? */
function cutOnTheWay(e) {
  return CUT_CODES.has(failureCode(e));
}
/** Did this fetch fail because no answer came in time (this client's timeout, or undici's own)? Never tried again. */
function timedOut(e) {
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || TIMEOUT_CODES.has(failureCode(e));
}
// A redirect (the RC's review: fetch refused it, redirect: 'error', and this client said "cannot reach ...: fetch
// failed"): Node's fetch names it in its cause, 'unexpected redirect'. It is the Python client's ValunError('redirected'),
// in the same words, without where it pointed or its status: fetch does not show them for a redirect it refused.
export const REDIRECT_WHY = "Valun's API sends no redirect itself: something at that address answered in its place, "
  + 'such as a host that moves http:// to https://, a server that moved, or a captive portal or proxy';
function refusedRedirect(e) {
  return e?.cause?.message === 'unexpected redirect';
}

// Plain http (the RC's review, as client.py's PLAIN_HTTP_ENV): a token goes over plain http only to a server on this
// machine, unless the person running this client sets VALUN_ALLOW_PLAIN_HTTP=1. Otherwise request() refuses, before
// anything is sent (plain_http), every request that carries a token, and every one whose answer carries one
// (SECRET_ROUTES: a join's owner token and enrollment code, an enrollment's agent token). Unlike the Python client, this
// one cannot send a server on this machine directly when Node's own fetch sends requests through a proxy: Node's fetch
// takes no per-request proxy setting without an undici dispatcher, which Node does not export. So it refuses a token
// over plain http to this machine too where the process-wide dispatcher Node's fetch uses would send it through a proxy
// (nodeRoute, judged from that dispatcher itself, the RC's review, round 3): Node's environment proxy (NODE_USE_ENV_PROXY=1
// or --use-env-proxy), with the http proxy it read at its start, unless NO_PROXY, read now as undici reads it, names the
// server's host (it says to name it there); or any other dispatcher an application set (setGlobalDispatcher: a
// ProxyAgent, say), which may proxy everything. Over https it sends no token, nor a join or an enrollment, while Node
// checks no certificate (tlsRefusal: NODE_TLS_REJECT_UNAUTHORIZED=0, or a global dispatcher made with
// connect.rejectUnauthorized false), as the Python client, which always checks, never does. Through a fetch passed in
// options.fetch, whose proxy and TLS settings this client cannot see, it sends as asked. A globalThis.fetch that is not
// Node's own (nodeFetch: an application or a library replaced it, with a wrapper that passes a dispatcher of its own,
// say) is neither (the RC's review, round 4, js-replaced-global-fetch-judged-as-nodes-own: it was judged by the global
// dispatcher, which such a wrapper need not use, and the tokens went through its proxy in clear text): it may send
// anywhere, so over plain http a token goes to this machine through it only with VALUN_ALLOW_PLAIN_HTTP=1, and its own
// TLS settings are unknown here, so over https only what holds for every fetch in this process is judged.
export const PLAIN_HTTP_ENV = 'VALUN_ALLOW_PLAIN_HTTP';
const SECRET_ROUTES = new Set(['/pilot/v1/join', '/pilot/v1/join-sandbox', '/pilot/v1/enroll']);
const environment = () => {
  const e = globalThis.process?.env;
  return e && typeof e === 'object' ? e : {};
};
/** Has the person running this client opted in to tokens over plain http to another machine (VALUN_ALLOW_PLAIN_HTTP=1)? */
export function plainHttpAllowed() {
  return String(environment()[PLAIN_HTTP_ENV] ?? '').trim() === '1';
}
/** Is `host` (a URL's host name; an IPv6 address with or without its brackets) this machine: 127.0.0.0/8, ::1 (an
 *  IPv4-mapped 127.x too) or the name localhost exactly? As the URL parser reads it (127.1 is 127.0.0.1). Not
 *  'localhost.' with a final dot (the RC's review, round 3, transport-security localhost-trailing-dot-resolved-by-dns):
 *  getaddrinfo, which Node resolves through, looks that name up in DNS on glibc, so it may be any machine. */
export function loopbackHost(host) {
  if (typeof host !== 'string' || !host.trim()) return false;
  const h = host.trim();
  let name;
  try {
    name = new URL(`http://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}/`).hostname;
  } catch {
    return false;
  }
  return name === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) || name === '[::1]'
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(name);
}
// A server URL is absolute: http:// or https://, a host (a host name or an IP address), an optional port and path, and
// no user name or password, query or fragment. Anything else is refused before anything is sent, naming the setting it
// came from (the RC's review, round 3, transport-security js-hostless-server-url-bypasses-both-guards: a server with no
// host, such as 'http://', is not a URL on its own, so neither guard below judged it, but `server + path` was one, whose
// host was the path's first segment: 'http:' + '/pilot/v1/me' is http://pilot/v1/me, so the agent's token went in
// clear text to whatever the name 'pilot' reached, and over unverified TLS for 'https://'). As the Python client's
// server_problem.
const EXAMPLE_SERVER = 'https://valun.tech';
const SERVER_USERINFO = 'has a user name or password (before an @), which a server URL never carries, so it is not repeated here';
const SERVER_HOST = 'has a host that is not a host name (letters, digits, dots, hyphens and underscores) or an IP address';
/** Why `server` is not a Valun server URL, in words that follow the setting as shownServer() names it ('"http:" has no
 *  host'), or null for one: scheme://host[:port][/path], the scheme http or https (any case), the host a name of
 *  letters, digits, dots, hyphens and underscores (a name outside ASCII in its xn-- form) or an IP address (IPv6 in
 *  brackets), the port a number from 1 to 65535, and no user name or password, query, fragment, space, backslash or
 *  control character. */
export function serverProblem(server) {
  if (typeof server !== 'string') return 'is not text';
  if (!server) return 'is empty';
  if (/[\\\s\p{C}\p{Z}]/u.test(server)) return 'has a space, a backslash or a control character in it';
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(server);
  const scheme = m ? m[1].toLowerCase() : null, rest = m ? m[2] : '';
  if (scheme !== 'http' && scheme !== 'https') {
    return scheme !== null && rest.startsWith('//') ? 'is not an http:// or https:// URL'
      : 'has no scheme (a server URL starts with https://)';
  }
  if (!rest.startsWith('//')) return 'has no host';
  const authority = rest.slice(2).split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return SERVER_USERINFO;
  if (/[?#]/.test(server)) return 'has a query or a fragment (? or #), which a server URL never carries';
  let host = authority, port = '';
  if (authority.startsWith('[')) {                 // an IPv6 address, [::1]
    const end = authority.indexOf(']');
    if (end < 0) return SERVER_HOST;
    host = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after && !after.startsWith(':')) return SERVER_HOST;
    port = after.slice(1);
  } else if (authority.includes(':')) {
    const i = authority.indexOf(':');
    [host, port] = [authority.slice(0, i), authority.slice(i + 1)];
  }
  if (!host) return 'has no host';
  if (host.startsWith('[') ? host.includes('%') || !ipv6Literal(host) : !/^[A-Za-z0-9._~-]+$/.test(host)) return SERVER_HOST;
  if (port && !(/^[0-9]+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    return 'has a port that is not a number from 1 to 65535';
  }
  try {
    new URL(server);                               // as fetch reads it too
  } catch {
    return 'has a host or port that is not valid';
  }
  return null;
}
/** Is `host` ('[...]') an IPv6 address, as the URL parser reads one? */
function ipv6Literal(host) {
  try {
    return new URL(`http://${host}/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}
/** A server setting as an error names it: in double quotes (JSON, characters outside ASCII escaped, as Python's
 *  json.dumps), at most 120 characters; 'it' for one with an @ in it, which may carry a password. */
function shownServer(server) {
  if (typeof server !== 'string' || server.includes('@')) return 'it';
  return JSON.stringify(server.length <= 120 ? server : server.slice(0, 117) + '...')
    .replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
/** The URL a request to `path` goes to on `server` (`setting`: where that server came from, for the words), judged as
 *  fetch reads `server + path` (the RC's review, round 3): the server a server URL (serverProblem), the path from its
 *  root, and the joined URL on the server's own origin. Otherwise nothing is sent: unreachable, cause not_connected,
 *  naming the setting (as for a URL fetch cannot parse), or bad_arguments for a path. */
function requestUrl(server, path, setting) {
  const why = serverProblem(server);
  if (why !== null) {                              // setting: 'client' (the server option) or 'profile' (state.server)
    const fix = setting === 'client' ? ''
      : ' Correct the profile\'s "server" (`valun --profile NAME config server URL` with the Python client), or give '
        + 'this Client a server option.';
    throw new ValunError('unreachable', `${setting === 'client' ? 'The server option' : 'This profile\'s server'} must be an `
      + `http(s) URL with a host, such as ${EXAMPLE_SERVER}: ${shownServer(server)} ${why}. Nothing was sent.${fix}`,
    undefined, {cause: 'not_connected', setting});
  }
  let url = null;
  try {
    if (typeof path === 'string' && path.startsWith('/')) url = new URL(server + path);
  } catch { /* below */ }
  if (url === null || url.origin !== new URL(server).origin) {
    throw new ValunError('bad_arguments', 'a request path starts with / (from the server\'s root); nothing was sent');
  }
  return url;
}

/** The https:// address of an http:// server URL (the same host, a port that is not 80, the path), or null. */
function httpsOf(server) {
  try {
    const u = new URL(server);
    if (u.protocol !== 'http:') return null;
    return `https://${u.hostname}${u.port && u.port !== '80' ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}
/** Would NO_PROXY's `value` keep a request to `host` (as a URL's host names it: IPv6 in brackets) and `port` from the
 *  proxy, as every undici reads it (EnvHttpProxyAgent: entries apart by commas or spaces, '*' alone, a port after the
 *  last colon, a leading '.' or '*.' for a domain and its names, else the exact host)? Only what each of undici 6
 *  (Node 22), 7 (Node 24) and 8 (Node 26) reads so, whichever the dispatcher is: undici 7 and 8 take an entry that
 *  starts with '*' but not '*.' for no name (undici 7 a '*' among other entries too), where undici 6 takes it for the
 *  end of a host name, as this client did (found while fixing the RC's review, round 5: with NO_PROXY '*0.0.1', or
 *  'example.com,*', it sent the token for 127.0.0.1 directly, and Node 24's fetch sent it through the proxy). */
export function noProxyNames(value, host, port) {
  if (value === '*') return true;
  for (const entry of String(value).split(/[,\s]/)) {
    if (!entry) continue;
    const m = entry.match(/^(.+):(\d+)$/);
    const name = (m ? m[1] : entry).toLowerCase(), p = m ? Number.parseInt(m[2], 10) : 0;
    if (p && p !== port) continue;
    if (name.startsWith('*') && !name.startsWith('*.')) continue;
    if (!/^[.*]/.test(name) ? host === name : host.endsWith(name.replace(/^\*/, ''))) return true;
  }
  return false;
}
// The process-wide dispatcher Node's fetch sends every request through (undici's global dispatcher): Node's own Agent,
// made at the first fetch; Node's EnvHttpProxyAgent, made at its start with NODE_USE_ENV_PROXY=1 or --use-env-proxy;
// or whatever an application set with setGlobalDispatcher. Where undici keeps it depends on its version
// (process.versions.undici): undici 5 to 7 (Node 18 to 25) in the .1 slot, which their fetch reads (undici 7 puts it in
// .2 too); undici 8 (Node 26) in .2, which its fetch reads, with a Dispatcher1Wrapper around it in .1 for older undici
// code in the process (fetchDispatcher; the RC's review, round 5, js-node26-local-server-refused: this client read .1
// only, so on Node 26 it took that wrapper for an application's dispatcher and refused every token to a server on this
// machine once the process had made a fetch, NO_PROXY or not; and js-node26-tls-guard-misses-undici8-dispatcher: the
// wrapper keeps its dispatcher's TLS settings out of sight, so one that checks no certificate went unseen).
const GLOBAL_DISPATCHER_1 = Symbol.for('undici.globalDispatcher.1');
const GLOBAL_DISPATCHER_2 = Symbol.for('undici.globalDispatcher.2');
const DISPATCHER1_WRAPPER = 'Dispatcher1Wrapper';
// Node's own fetch, as every Node from 18.0.0 to 26 defines globalThis.fetch: its source loads Node's undici
// (`require('internal/deps/undici/undici')`, which no code outside Node can do), through `lazyUndici().fetch(` up to
// Node 21.0. It sends every request through the global dispatcher (fetchDispatcher), which nodeRoute and tlsRefusal
// judge. A fetch whose source is anything else (an application's or a library's wrapper, Node's own fetch bound,
// another runtime's) may send a request anywhere, whatever that dispatcher is.
const NODE_FETCH_SOURCE = /\brequire\('internal\/deps\/undici\/undici'\)|\blazyUndici\(\)\.fetch\(/;
const functionSource = Function.prototype.toString;
/** Is `f` Node's own fetch (NODE_FETCH_SOURCE)? */
function nodeFetch(f) {
  try {
    return typeof f === 'function' && NODE_FETCH_SOURCE.test(functionSource.call(f));
  } catch {
    return false;
  }
}
/** The value of undici's own field `name` of `object` (a symbol it describes so), or undefined. */
function undiciField(object, name) {
  if (object === null || typeof object !== 'object') return undefined;
  try {
    const k = Object.getOwnPropertySymbols(object).find(s => s.description === name);
    return k === undefined ? undefined : object[k];
  } catch {
    return undefined;
  }
}
/** The class name of a dispatcher, when it is a plain name (for a message), or null. */
function className(d) {
  const n = d?.constructor?.name;
  return typeof n === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/.test(n) ? n : null;
}
/** The major version of the undici this Node bundles (process.versions.undici: '8.12.4' on Node 26.13.1), or 0. */
function undiciMajor() {
  const m = /^(\d+)\./.exec(String(globalThis.process?.versions?.undici ?? ''));
  return m ? Number(m[1]) : 0;
}
/** The global dispatcher Node's own fetch sends through now, or undefined before a fetch made one: the .2 slot with
 *  undici 8 or later, else .1 (GLOBAL_DISPATCHER_1). A Dispatcher1Wrapper there holds the dispatcher it sends through
 *  in a private field. undici 8's setGlobalDispatcher(d) puts d in .2 and a wrapper of d in .1, so on a Node before 26
 *  an application's dispatcher set by npm's undici 8 is sent through that wrapper: it is judged as the dispatcher in .2
 *  beside it. Any other wrapper (one set as the global dispatcher itself) is judged as what it is, a dispatcher this
 *  client cannot see into. */
function fetchDispatcher() {
  const d = globalThis[undiciMajor() >= 8 ? GLOBAL_DISPATCHER_2 : GLOBAL_DISPATCHER_1];
  if (className(d) !== DISPATCHER1_WRAPPER) return d;
  const held = globalThis[GLOBAL_DISPATCHER_2];
  return held !== d && held !== undefined && held !== null && className(held) !== DISPATCHER1_WRAPPER ? held : d;
}
/** Does the dispatcher `d` send through another dispatch than its class's (the RC's review, round 4,
 *  js-composed-agent-judged-as-nodes-own-agent)? So is undici 7's Agent.compose(): a Proxy whose class name is still
 *  'Agent', and whose dispatch runs the interceptors given, which may send a request anywhere (undici 6's compose made
 *  a ComposedDispatcher, another class). A dispatch an application set on the object itself is one too. */
function composedDispatch(d) {
  try {
    return d.dispatch !== Object.getPrototypeOf(d)?.dispatch;
  } catch {
    return true;
  }
}
/** How Node's own fetch would send this plain-http URL (a server on this machine), judged from the dispatcher it uses
 *  (the RC's review, round 3: from the environment and the class name only, an application's ProxyAgent and a proxy
 *  Node read at its start went unseen): null directly; {via: 'proxy', name} through Node's environment proxy
 *  (EnvHttpProxyAgent: the http proxy it was made with, whatever HTTP_PROXY says now, unless NO_PROXY, which undici
 *  reads at each request, names the host; name: the variable that names it now, or null); {via: 'dispatcher', name}
 *  through another dispatcher than Node's own Agent, which may proxy everything, one composed with interceptors
 *  included (composedDispatch). With no dispatcher yet (no fetch so far), Node's environment proxy is on only with
 *  NODE_USE_ENV_PROXY=1 or --use-env-proxy at its start. The dispatcher it uses: fetchDispatcher(). */
function nodeRoute(url) {
  const e = environment();
  const host = url.host.replace(/:\d*$/, '').toLowerCase();
  const named = () => noProxyNames(e.no_proxy ?? e.NO_PROXY ?? '', host, Number.parseInt(url.port, 10) || 80);
  const variable = () => Object.keys(e).includes('http_proxy') ? 'http_proxy'
    : Object.keys(e).includes('HTTP_PROXY') ? 'HTTP_PROXY' : null;      // as it is set (Windows: either case)
  const d = fetchDispatcher();
  if (d !== undefined && d !== null) {
    const name = className(d);
    if ((name === 'Agent' || name === 'EnvHttpProxyAgent') && composedDispatch(d)) {
      return {via: 'dispatcher', name: `${name} composed with interceptors`};
    }
    if (name === 'Agent') return null;                // Node's own: no proxy
    if (name === 'EnvHttpProxyAgent') {
      const proxied = undiciField(d, 'http proxy agent'), direct = undiciField(d, 'no proxy agent');
      if (proxied !== undefined && proxied === direct) return null;     // made with no proxy for http
      return named() ? null : {via: 'proxy', name: variable()};
    }
    return {via: 'dispatcher', name};
  }
  const on = e.NODE_USE_ENV_PROXY === '1' || (globalThis.process?.execArgv ?? []).includes('--use-env-proxy');
  if (!on || !(e.http_proxy ?? e.HTTP_PROXY) || named()) return null;
  return {via: 'proxy', name: variable()};
}
/** Does the dispatcher `d` (or one it holds: Node's environment proxy agent's) skip the server's certificate check
 *  (connect.rejectUnauthorized false, or the tls option's, or a ProxyAgent's requestTls so)? What it was made with, as
 *  undici keeps it; a dispatcher whose settings this client cannot read (a Dispatcher1Wrapper fetchDispatcher cannot
 *  see into, say) is not judged. undici's tls option holds an Agent's TLS settings too: connect's own
 *  rejectUnauthorized wins over it, and a connect function of its own replaces both (found while fixing the RC's
 *  review, round 5: an Agent made with tls: {rejectUnauthorized: false} went unseen on every Node, and the agent and
 *  owner tokens went to a server whose certificate Node was not given). */
function uncheckedDispatcher(d, depth = 0) {
  if (d === null || typeof d !== 'object' || depth > 2) return false;
  const off = o => o !== null && typeof o === 'object' && o.rejectUnauthorized === false;
  const agentOff = o => off(o?.connect)
    || (typeof o?.connect !== 'function' && o?.connect?.rejectUnauthorized === undefined && off(o?.tls));
  const options = undiciField(d, 'options'), proxyOptions = undiciField(d, 'proxy agent options');
  if (agentOff(options) || off(undiciField(d, 'request tls settings')) || off(proxyOptions?.connect)
      || off(proxyOptions?.requestTls)) {
    return true;
  }
  return ['no proxy agent', 'http proxy agent', 'https proxy agent', 'proxy agent']
    .some(f => uncheckedDispatcher(undiciField(d, f), depth + 1));
}
/** The refusal of a request over https that carries a token, or whose answer does, while Node's fetch checks no
 *  certificate (NODE_TLS_REJECT_UNAUTHORIZED=0, or a global dispatcher made so): any server could then read and use the
 *  token, so nothing is sent (tls_unverified; the RC's review, round 3). null to send it. `url`: the URL fetch is given
 *  (requestUrl), never the server alone (round 3: a server with no host was no URL, so this sent it as asked).
 *  `sender`, whose fetch sends it (request()): 'node', or 'replaced' (a globalThis.fetch that is not Node's own, whose
 *  own TLS settings are unknown here: judged by what holds for every fetch in this process, NODE_TLS_REJECT_UNAUTHORIZED
 *  and the global dispatcher, which a wrapper that hands requests on to Node's fetch uses); 'given' (options.fetch, not
 *  Node's own) is never refused. */
function tlsRefusal(server, url, path, tok, sender) {
  if (url.protocol !== 'https:' || sender === 'given' || !(tok || SECRET_ROUTES.has(path.split('?', 1)[0]))) return null;
  const env = String(environment().NODE_TLS_REJECT_UNAUTHORIZED ?? '') === '0';
  const d = fetchDispatcher();
  if (!env && !uncheckedDispatcher(d)) return null;
  const what = env ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off Node\'s check of a server\'s certificate'
    : `this process's fetch dispatcher (${className(d) ?? 'set with setGlobalDispatcher'}) does not check a server's certificate`
      + ' (rejectUnauthorized: false)';
  const fix = env ? 'Unset it; a certificate authority this machine does not trust goes in NODE_EXTRA_CA_CERTS'
    : 'The application that runs this client checks certificates, or gives this client a fetch that does (options.fetch)';
  return new ValunError('tls_unverified', `${server}: ${what}, so this client sends it no token, nor a join or an `
    + 'enrollment, whose answers carry one: whoever answered in its place could read and use them. Nothing was sent. '
    + fix, undefined, {cause: 'tls_unverified', via: env ? 'env' : 'dispatcher'});
}
/** The plain_http refusal of a request that carries a token, or whose answer does, or null to send it (above). `url`:
 *  the URL fetch is given (requestUrl); `sender`, whose fetch sends it (tlsRefusal): to this machine, Node's own is
 *  judged by its dispatcher (nodeRoute), one in options.fetch sends as asked, and a replaced one may send anywhere. */
function plainHttpRefusal(server, url, path, tok, sender) {
  if (url.protocol !== 'http:' || !(tok || SECRET_ROUTES.has(path.split('?', 1)[0])) || plainHttpAllowed()) return null;
  if (!loopbackHost(url.hostname)) {
    const https = httpsOf(server);
    return new ValunError('plain_http', `${server} is plain http on another machine, so this client sends it no token, nor `
      + 'a join or an enrollment, whose answers carry one: over plain http a token crosses the network in clear text, '
      + `for anyone on the way to read and use. Nothing was sent. Use its https:// address${https ? ` (${https})` : ''}, or, `
      + `only on a network you trust, set ${PLAIN_HTTP_ENV}=1 to send tokens over plain http anyway`, undefined,
    {cause: 'plain_http', opt_in: PLAIN_HTTP_ENV});
  }
  const route = sender === 'node' ? nodeRoute(url) : sender === 'replaced' ? {via: 'fetch'} : null;
  if (route === null) return null;
  if (route.via === 'fetch') {
    return new ValunError('plain_http', `${server} is plain http on this machine, but this process's fetch is not Node's own `
      + '(an application or a library replaced globalThis.fetch), so this client cannot tell whether it sends it through a '
      + 'proxy, which would read the token in clear text. Nothing was sent. Give this client the fetch to use '
      + `(options.fetch), use its https:// address, or, only if you trust that fetch, set ${PLAIN_HTTP_ENV}=1`, undefined,
    {cause: 'plain_http', via: 'fetch', opt_in: PLAIN_HTTP_ENV});
  }
  if (route.via === 'dispatcher') {
    return new ValunError('plain_http', `${server} is plain http on this machine, but this process's fetch dispatcher `
      + `(${route.name ?? 'an object'}, set with setGlobalDispatcher) may send it through a proxy, which would read the token `
      + 'in clear text, and this client cannot send it directly. Nothing was sent. Give this client a fetch that reaches it '
      + `directly (options.fetch), use its https:// address, or, only if you trust that dispatcher, set ${PLAIN_HTTP_ENV}=1`,
    undefined, {cause: 'plain_http', via: 'dispatcher', opt_in: PLAIN_HTTP_ENV});
  }
  const which = route.name ? `the proxy ${route.name} names` : 'the proxy HTTP_PROXY named when Node started';
  return new ValunError('plain_http', `${server} is plain http on this machine, but Node's fetch sends it through ${which} `
    + '(its environment proxy is on: NODE_USE_ENV_PROXY), which would read the token in clear text, and this client cannot '
    + `send it directly. Nothing was sent. Name it in NO_PROXY as its URL does (${url.host.replace(/:\d*$/, '')}), or, only `
    + `if you trust that proxy, set ${PLAIN_HTTP_ENV}=1`, undefined,
  {cause: 'plain_http', via: 'proxy', opt_in: PLAIN_HTTP_ENV});
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

/**
 * The server's 409 payee_edge_not_applied to a resolution as applied, as the ValunError resolveAttempt() throws: why, and
 * what to do instead (extra {payee_edge, next_steps, local_possible: false, server}); see the Python reference.
 */
function payeeEdgeRefusal(e) {
  const edge = serverWord(pyGet(e.extra ?? {}, 'payee_edge'));
  const why = edge !== null && Object.hasOwn(PAYEE_EDGE_WHY, edge) ? PAYEE_EDGE_WHY[edge]
    : "the server did not say how it reads the payee's edge";
  return new ValunError('payee_edge_not_applied', "the server did not record this payment as applied: the payee's edge on the "
    + `tracker does not show this transfer (${why}); nothing was changed, at the server or in your records. If the payee `
    + 'confirms that the payment did not arrive, resolve it as not applied; if the payee says it arrived, ask the operator '
    + 'to look into it with the payee before you resolve it', 409,
  {payee_edge: edge, next_steps: [...PAYEE_EDGE_NEXT], local_possible: false,
    server: {error: 'payee_edge_not_applied', message: cpSlice(e.message, 300)}});
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
  if (!isDict(r)) throw new ValunError('records_unreadable', "this profile's record of the notes it issued cannot be read; nothing was signed");
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

/**
 * wrong_network unless GET /info (`info`) names `network`, the profile's own (Client.network: the pilot's for a profile
 * enrolled before 0.5, which names none). A server that names another network, or none, does not serve the profile's:
 * it knows neither its participant nor its key, and nothing is pinned or signed for it (the onboarding review). null
 * when it names `network`.
 */
function networkProblem(network, info) {
  const net = isObject(info) ? (info.network ?? null) : null;
  if (net === network) return null;
  return new ValunError('wrong_network', `the server is on network ${JSON.stringify(net)}, not ${network}; `
    + 'nothing was signed');
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

/** A list from a server value: the list itself, or [] for anything else (Python's `x or []` over a list field). */
function iterateList(v) {
  return Array.isArray(v) ? v : [];
}

const TERMS_FIELDS = ['protocol', 'network', 'tracker_nft_id', 'denomination', 'deal_id', 'version', 'prior_terms_hash',
  'nonce', 'proposer', 'payer', 'payee', 'service', 'price', 'consideration', 'deliver_by', 'offer_expires_at'];
// Terms may also name a payment issuer (fix inbox #192/#196): payment_issuer {id, pubkey}, optional.
const OPTIONAL_TERMS_FIELDS = ['payment_issuer'];

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

/** A price as it is signed: a whole number of at least 1, or a string of its decimal digits; never truncated (bad_price). */
function toPrice(price, unit = 'PC') {
  const n = typeof price === 'string' && /^[0-9]+$/.test(price) ? Number(price) : price;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) return n;
  throw new ValunError('bad_price', `price must be a whole number of ${unit}, at least 1`);
}

function toHours(h, what) {
  if (typeof h !== 'number' || !Number.isFinite(h)) throw new ValunError('bad_terms', `${what} must be a number of hours`);
  return h;
}

/**
 * How long a counter-offer stays open by default, at most (fix inbox #23): never past its own delivery deadline, nor past
 * the end of the offer it answers (Client.counter).
 */
export const COUNTER_OFFER_HOURS = 24;

/**
 * Refuse (bad_arguments, fix inbox #23), before anything is signed, an offer that would stay open longer than the hours
 * it gives to deliver: it could be accepted after its work is due, and the server refuses such terms (deliver_by must not
 * be earlier than offer_expires_at). The Python client's check_offer_hours.
 */
export function checkOfferHours(offerHours, deliverHours) {
  if (offerHours > deliverHours) {
    throw new ValunError('bad_arguments', `the offer would stay open ${offerHours} h, longer than the ${deliverHours} h it `
      + 'gives to deliver: it could be accepted after its work is due, which the server '
      + `refuses. Pass offer_valid_hours of at most ${deliverHours}; nothing was signed`);
  }
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
  #readRetryWaitsMs;
  #server;
  #queue = {tail: Promise.resolve()};           // this client's state changes, one after another (shared by fresh())
  #advertised = [];                             // the features the last GET /info listed (for the capability header)
  #novation = null;                             // the last GET /info novation: the tracker contract (novation.CONTRACT)

  /**
   * @param {object} options
   *   store          an object with .state (non-secret, plain object), .secret(), .token(), .save() and
   *                  .saveCredentials(secretHex, token) (save/saveCredentials may return a Promise). Default: MemoryStore.
   *   server         base URL of the Valun server, e.g. "https://host" (the API is under /pilot/v1). Kept in state. A
   *                  request to one that is not a server URL (serverProblem: "http://", with no host, say) sends nothing.
   *   timeoutMs      per request (default 30000).
   *   fetch          a fetch implementation (default globalThis.fetch).
   *   pin            {trackerNftId, denomination}: values the network must have (spec 15.2: SHOULD pin).
   *   signerRetries  how many times to send the same signed request again after 503 signer_unavailable (default 0:
   *                  the error is thrown, as the Python client does); retryDelayMs (default 1000) doubles each time.
   *   readRetryWaitsMs  the waits (ms) before each new try of a read whose connection was cut on the way (default
   *                  READ_RETRY_WAITS_MS, [500, 1500]: three tries in all; [] for one try). Writes are never sent again.
   *   declareRoles   false for a client whose adapter signs no consent by itself: it declares no consent role in
   *                  X-Valun-Features, whatever its consent policy says, and withdraws the roles it declared before
   *                  (featuresHeader; decision D-3 b). Default true. A ValunAgent sets it from its own options.
   *   now, randomBytes, generateSecret   clock (ms), id/nonce source and key generator: test hooks only.
   */
  constructor(options = {}) {
    const {store = new MemoryStore(), server, timeoutMs = 30_000, fetch, pin = {}, signerRetries = 0, retryDelayMs = 1000,
      readRetryWaitsMs = READ_RETRY_WAITS_MS, now, randomBytes, generateSecret, declareRoles = true} = options;
    this.declareRoles = declareRoles !== false;
    if (!Number.isInteger(signerRetries) || signerRetries < 0) throw new TypeError('signerRetries must be a whole number');
    if (!Array.isArray(readRetryWaitsMs) || !readRetryWaitsMs.every(ms => Number.isFinite(ms) && ms >= 0)) {
      throw new TypeError('readRetryWaitsMs must be an array of waits in ms');
    }
    this.#signerRetries = signerRetries;
    this.#retryDelayMs = retryDelayMs;
    this.#readRetryWaitsMs = Object.freeze([...readRetryWaitsMs]);
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
  /** This profile's network: the one it enrolled on, valun-pilot-1 for a profile without one; its unit and scale. */
  get network() { const n = this.state.network || NETWORK; networkOf(n); return n; }
  get unit() { return NETWORKS[this.network].unit; }
  get scale() { return NETWORKS[this.network].scale; }

  /** The feature tags the last GET /info this client read listed ([] before any; ['?'] for a malformed list). */
  get advertised() { return [...this.#advertised]; }
  /** The `novation` object of the last GET /info (the server's report of its tracker's contract), a copy; or null. */
  get novationInfo() { return this.#novation === null ? null : structuredClone(this.#novation); }

  /**
   * A new Client on this client's store, server, clock, fetch, pins and other options, as a new Client starts: it has
   * read no GET /info yet (advertised is [], so its requests carry no X-Valun-Features header until it reads one).
   * Nothing it does changes this client's features, nor this client's its own; their state changes still run one after
   * another (one queue). ValunAgent takes one for every use of its client, as the Python agent makes a new Client for
   * each (so both send the same headers, and two uses at once never change each other's features).
   *
   * It is made with this client's own class (a host's Client subclass stays one: its constructor must take the options
   * Client takes), and it keeps the methods a host set on this instance itself (own properties that are functions).
   */
  fresh() {
    const Cls = typeof this.constructor === 'function' ? this.constructor : Client;
    const c = new Cls({store: this.#store, server: this.#server ?? undefined, timeoutMs: this.#timeoutMs, fetch: this.#fetch,
      pin: {...this.#pin}, signerRetries: this.#signerRetries, retryDelayMs: this.#retryDelayMs,
      readRetryWaitsMs: this.#readRetryWaitsMs, now: this.#now,
      randomBytes: this.#randomBytes, generateSecret: this.#generateSecret, declareRoles: this.declareRoles});
    c.#queue = this.#queue;
    for (const k of Object.keys(this)) {
      if (typeof this[k] === 'function') c[k] = this[k];              // instance-patched methods
    }
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

  /**
   * Record that this profile's participant finished the sandbox tour (state.sandbox_tour_done = its participant id), so
   * the agent layer's sandbox_next_steps stays done whatever is dealt with the sandbox agents later (the 0.7.2 clean-user
   * test). Never rejects: a mark that fails is not retried.
   */
  async markSandboxTourDone() {
    const pid = this.participantId;
    try {
      await this.#update(state => { state.sandbox_tour_done = pid; });
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
    const url = requestUrl(server, path, this.#server ? 'client' : 'profile');   // a server with no host: nothing sent
    const f = this.#fetch || globalThis.fetch;
    if (typeof f !== 'function') throw new ValunError('not_configured', 'no fetch implementation: pass options.fetch');
    const headers = {Accept: 'application/json'};
    let payload;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const tok = token || (auth ? this.#store.token() : null);
    // Whose fetch sends it, for the guards: Node's own (nodeFetch, in options.fetch or not), judged by the dispatcher it
    // sends through; another one passed in options.fetch, as asked; or a globalThis.fetch that is not Node's own, which
    // may send anywhere (the RC's review, round 4: it was judged as Node's own).
    const sender = nodeFetch(f) ? 'node' : this.#fetch ? 'given' : 'replaced';
    const refusal = plainHttpRefusal(server, url, path, tok, sender) ?? tlsRefusal(server, url, path, tok, sender);
    if (refusal !== null) throw refusal;          // a token in clear text, or to a server whose certificate is not checked
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const caps = this.featuresHeader();
    if (caps) headers[FEATURES_HEADER] = caps;
    const safe = SAFE_METHODS.has(method), waits = this.#readRetryWaitsMs;
    let reads = 0;                                // the new tries of a read made so far (READ_RETRY_WAITS_MS)
    const readAgain = async () => {
      if (!(safe && reads < waits.length)) return false;
      await new Promise(resolve => setTimeout(resolve, waits[reads++]));
      return true;
    };
    for (let attempt = 0; ; attempt++) {
      const {signal, cancel} = timeoutSignal(this.#timeoutMs);
      let res, text;
      try {
        // redirect: 'error' so the bearer token is never forwarded to wherever a redirect points.
        res = await f.call(globalThis, server + path, {method, headers, body: payload, signal, redirect: 'error'});
        text = await res.text();
      } catch (e) {
        if (refusedRedirect(e)) {               // never followed, so nothing was done (and never sent again)
          throw new ValunError('redirected', `${server} answered with a redirect. This client follows no redirect, so `
            + `nothing was done (${REDIRECT_WHY})`, undefined, {cause: 'redirect', location: null});
        }
        const late = timedOut(e), code = failureCode(e);
        const named = typeof code === 'string' && code ? ` (${code})` : '';
        const why = late ? 'timed out' : (e?.message || String(e)) + named;
        const unknown = safe ? {} : {outcome: 'unknown'};
        const sentWords = safe ? '' : '. The request was sent, so the server may have done it: read what it holds '
          + 'before sending it again';
        if (late) {                               // no answer in time: asked once (the 0.7.2 review)
          const within = this.#timeoutMs > 0 ? ` within ${this.#timeoutMs / 1000} s` : '';
          const busy = ': it may be busy, or something between this machine and the server held the answer, not a '
            + 'refusal: try again in a minute';
          throw new ValunError('unreachable', `${server} did not answer${within} (timed out)${safe ? busy : sentWords}`,
            undefined, {cause: 'timed_out', ...unknown});
        }
        // An answer whose body stopped arriving, or a connection cut on the way: a read is sent again.
        if ((res !== undefined || cutOnTheWay(e)) && await readAgain()) continue;
        const tries = reads ? ` (${reads + 1} tries)` : '';
        if (res !== undefined || cutOnTheWay(e)) {  // the server was reached, and the connection was cut
          throw new ValunError('unreachable', `the connection to ${server} was cut before its whole answer arrived `
            + `(${why})${tries}${sentWords}`, undefined, {cause: 'connection_cut', ...unknown});
        }
        throw new ValunError('unreachable', `cannot reach ${server}: ${why}${tries}`);
      } finally {
        cancel();
      }
      if (res.ok) {
        let out = null;
        if (text) {
          try {
            out = JSON.parse(text);
          } catch {
            throw new ValunError('bad_response', `the server sent a response that is not JSON (HTTP ${res.status})`,
              res.status, {cause: 'not_json'});
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
      // A proxy's own 502, 503 or 504 (no Valun error in its body): the server did not answer yet; a read is sent again.
      if (code === 'http_error' && PROXY_STATUSES.has(res.status) && await readAgain()) continue;
      // spec 15.2: on 503 signer_unavailable nothing was recorded; send the same signed request again, with back-off
      const signerAttempt = attempt - reads;
      if (res.status === 503 && code === 'signer_unavailable' && signerAttempt < this.#signerRetries) {
        await new Promise(resolve => setTimeout(resolve, this.#retryDelayMs * 2 ** signerAttempt));
        continue;
      }
      const msg = (typeof message === 'string' && message) || (typeof error === 'string' && error) || `HTTP ${res.status}`;
      throw new ValunError(code, msg, res.status, extra);
    }
  }

  // ---------- joining ----------
  /**
   * Create a participant (owner side). The response holds the owner token and the enrollment code: both are for the
   * HUMAN operator, not for the agent. `wants` (the work it pays others for, public) is sent only when given.
   */
  async join({invite, handle, operator, displayName = '', about = '', services = '', wants = ''}) {
    return this.#joined(await this.request('POST', '/pilot/v1/join',
      {invite, handle, display_name: displayName, operator, about, services, ...(wants ? {wants} : {})}, {auth: false}));
  }

  /** Join without an invite as a self-serve participant, where the server offers it (server release v14+,
   *  PILOT_OPEN_SANDBOX=1; otherwise ValunError('not_found')): small limits, 7 days renewed while its agent is active;
   *  with the open network it may deal with any participant whose owner allows it, otherwise only with the sandbox
   *  agents. `services` (what it offers) and `wants` (what it pays others for), both public, are sent only when given. */
  async joinSandbox({handle, operator, displayName = '', about = '', services = '', wants = ''}) {
    return this.#joined(await this.request('POST', '/pilot/v1/join-sandbox',
      {handle, display_name: displayName, operator, about, ...(services ? {services} : {}), ...(wants ? {wants} : {})}, {auth: false}));
  }

  /** A join's answer: servers since 0.5 name their network, which this profile then enrolls on (a known one only). */
  #joined(r) {
    if (isObject(r) && r.network !== undefined && r.network !== null) { networkOf(r.network); this.state.network = r.network; }
    return r;
  }

  /** Change this participant's public profile (PUT /pilot/v1/profile, the agent's token): only the fields given
   *  (displayName, about, services, wants; an empty string clears one). publicVouches (true or false; fix inbox #31):
   *  whether the guarantees between it and agents that also chose this are public (never the creditor). */
  async setProfile({displayName, about, services, wants, publicVouches} = {}) {
    if (publicVouches !== undefined && publicVouches !== null && typeof publicVouches !== 'boolean') {
      throw new ValunError('invalid_field', 'publicVouches must be true or false');
    }
    const body = Object.fromEntries([['display_name', displayName], ['about', about], ['services', services], ['wants', wants],
      ['public_vouches', publicVouches]].filter(([, v]) => v !== undefined && v !== null));
    if (!Object.keys(body).length) throw new ValunError('invalid_field', 'give at least one of display_name, about, services, wants, public_vouches');
    return this.request('PUT', '/pilot/v1/profile', body);
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
      const net = this.state.network || NETWORK;   // the network the join named (join, joinSandbox)
      networkOf(net);
      const sig = bytesToHex(sign(utf8(statements.enroll(participantId, pk, code, net)), secret, hexToBytes(pk)));
      const r = await this.request('POST', '/pilot/v1/enroll',
        {participant_id: participantId, code, pubkey: pk, signature: sig}, {auth: false});
      if (isObject(r) && r.network !== net) throw new ValunError('wrong_network', `the server enrolled this key on ${JSON.stringify(r.network)}, not ${net}`);
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
   * (tracker_mismatch, R13). Its `novation` object, the server's report of its tracker's contract, decides whether prior
   * acknowledgments are signed (novation.contractProblem: tracker v3.2 only).
   */
  async info() {
    const r = await this.request('GET', '/pilot/v1/info', undefined, {auth: false});
    await this.#pinFrom(r);
    this.#advertised = isObject(r) ? featuresOf(r) : [];
    this.#novation = isObject(r) ? (pyGet(r, 'novation') ?? null) : null;
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

  // ---------- budget cards ----------
  // An owner may publish its agent's budget card (setPublicCard): the limits of its mandate, the room it leaves, the
  // guarantees that back the agent in public, and its record. Anyone can read a card (card) and check a payment against it
  // (checkPayer): public reads that sign nothing. A card is read without a token; a check carries this agent's own token,
  // because the server shows the cover (what guarantees would pay the payee) only to the payee itself. Where the owner has
  // not published its card, both answer 404 card_not_public, but for the payee's own check on a server with fix inbox #87,
  // which answers for the payee's own side.

  /**
   * The participant `who` names, as {id, handle}. `who` is stripped and lower-cased; a participant id (vp_ + 12 hex) is
   * taken as it is, with handle null, without a read (it may be an unlisted participant). Anything else is a handle,
   * looked up in the directory (GET /participants) the way the agent tools look up a counterparty: a participant with
   * exactly that id first, else the one with that handle. unknown_participant when there is none; bad_arguments for a
   * `who` that is not a name.
   */
  async resolveParticipant(who) {
    if (typeof who !== 'string' || !strip(who)) throw new ValunError('bad_arguments', 'name the participant by its handle or participant id');
    const w = strip(who).toLowerCase();
    if (PARTICIPANT_ID_RE.test(w)) return {id: w, handle: null};
    const listed = await this.directory();
    const people = (Array.isArray(listed) ? listed : []).filter(isDict);
    for (const key of ['id', 'handle']) {
      for (const p of people) {
        if (pyGet(p, key) === w && typeof pyGet(p, 'id') === 'string' && p.id) return {id: p.id, handle: pyGet(p, 'handle')};
      }
    }
    throw new ValunError('unknown_participant', `no participant called ${repr(w)}; use valun_directory`);
  }

  /**
   * A budget-card read (GET), with this agent's token when `auth` and the store holds one. A server from before budget
   * cards answers a request without a token 401 (the route is not public there): feature_unavailable. A 401 to a request
   * that carried the token is the server refusing that token, thrown as it is.
   */
  async #cardRead(path, {auth = false} = {}) {
    const sent = auth && Boolean(this.#store.token());
    try {
      return await this.request('GET', path, undefined, {auth});
    } catch (e) {
      if (isValunError(e) && e.status === 401 && !sent) {
        throw new ValunError('feature_unavailable', 'this Valun server offers no budget cards (it does not serve '
          + 'GET /participants/{id}/card); nothing was read', 401);
      }
      throw e;
    }
  }

  /**
   * The budget card of the participant `who` names (a handle or participant id: resolveParticipant), as GET
   * /participants/{id}/card shows it: {card, network, unit, agent, mandate, room, backing, record, card_hash, check,
   * page}, amounts in the network's unit. card_not_public (404) when its owner has not published it.
   */
  async card(who) {
    const {id} = await this.resolveParticipant(who);
    return this.#cardRead(`/pilot/v1/participants/${seg(id)}/card`);
  }

  /**
   * May `payer` (a handle or participant id) owe `payee` (a handle or participant id; default: this participant)
   * `amount` more, by the budget card its owner published? GET /participants/{id}/check?amount=N&payee=ID answers
   * {verdict ('accept', 'ask_owner' or 'decline'), reasons, rule, payer, payee, amount, mandate {version, expires_at},
   * room_left, approval_needed, cover {covered, guarantees}, record, card_hash, checked_at, took_ms}. Read only: it signs
   * nothing. The request carries this agent's own token (when it has one): the server shows the cover only to the payee
   * itself, so with another payee (or without a token) cover.covered is null, not shown, and so is its own side of the
   * step (payee_side {verdict, rule, reasons}, from a server that sends it). amount is a whole number of this network's
   * unit, at least 1 (bad_arguments otherwise, before anything is read). card_not_public (404) when the payer's owner has
   * not published its card.
   *
   * Fix inbox #87: a server with it gives every answer payer_side, the payer's own {verdict, rule, reasons}, and gives the
   * payee's own check (its token) the step's verdict from both sides, as it enforces them: decline if either side
   * declines, ask_owner if an owner on either side decides first, accept only if both go ahead. It answers the payee's
   * own check of a payer whose owner has not published its card too, for the payee's side only: verdict decline when that
   * side declines, else 'unknown'; payer_side, mandate, room_left, record and card_hash null, the cover not shown.
   *
   * dealId (fix inbox #60; &deal=): the offer under review, a deal where the payer pays the payee, still in its offer
   * phase (open, waiting for its proposer's owner, or accepted and waiting for an owner), at exactly `amount`, its price
   * as it stands. The server then leaves that deal out of the payer's outstanding before it adds `amount`, so an offer the
   * payee received is counted once, and answers for what the deal's next steps do for the payer (deal_id in the answer).
   * Without it the answer is for a new deal on top of everything the payer committed, its open offers to the payee
   * included: the payee's own answer lists those its outstanding already counts (counted_offers [{deal_id, amount}],
   * newest first). A dealId that is not one (vd_ + 16 hex) is bad_arguments, before anything is read. The server answers
   * it only to the payee's own token (403 not_payee otherwise, so for another payee or a client that is not joined), and
   * refuses a deal not between these two or not at that price (400 invalid_field), unknown to the payee (404 not_found),
   * or past its offer phase (409 wrong_state); each rejects as the server gives it. A server from before fix inbox #60
   * ignores deal=: its answer, which names no deal_id (or another one), is for a new deal on top of the offer, counted
   * twice, so it is refused (offer_not_checked), never returned as the offer's. The Python client's check_payer.
   */
  async checkPayer(payer, amount, {payee = null, dealId = null} = {}) {
    if (!(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 1)) {
      throw new ValunError('bad_arguments', `amount must be a whole number of ${this.unit}, at least 1; nothing was read`);
    }
    const deal = dealId === null || dealId === undefined ? null : dealId;
    if (deal !== null && !(typeof deal === 'string' && DEAL_ID_RE.test(deal))) {
      throw new ValunError('bad_arguments', 'deal_id must be a deal id, vd_ and 16 hex digits; nothing was read');
    }
    const own = payee === null || payee === undefined;
    if (own && !this.participantId) {
      throw new ValunError('bad_arguments', 'give payee: this client has no participant id of its own (it is not joined)');
    }
    const payerId = (await this.resolveParticipant(payer)).id;
    const payeeId = own ? this.participantId : (await this.resolveParticipant(payee)).id;
    const r = await this.#cardRead(`/pilot/v1/participants/${seg(payerId)}/check?amount=${amount}&payee=${seg(payeeId)}`
      + (deal === null ? '' : `&deal=${deal}`), {auth: true});
    if (deal !== null && isDict(r) && (Object.hasOwn(r, 'deal_id') ? r.deal_id : null) !== deal) {
      throw new ValunError('offer_not_checked', `this Valun server does not check the offer under review (${deal}): its answer `
        + 'is for a new deal on top of that offer, which it counts twice');
    }
    return r;
  }

  /**
   * The OWNER's choice: publish (on true) or hide (on false) this participant's budget card, PUT /owner/mandate
   * {public_card}. ownerToken is the owner token of this profile's participant: checked first (GET /owner; not_owner when
   * it is not, and nothing changes), used as the bearer of these requests only, never stored. Resolves to the server's
   * answer ({mandate, mandate_version, changed_by, changed}).
   */
  async setPublicCard(on, ownerToken) {
    if (typeof on !== 'boolean') throw new ValunError('invalid_field', 'on must be true or false');
    if (!(typeof ownerToken === 'string' && strip(ownerToken))) {
      throw new ValunError('bad_arguments', 'the owner token is needed to publish or hide the budget card; nothing was changed');
    }
    const token = strip(ownerToken);
    await this.#checkOwner(token);
    return this.request('PUT', '/pilot/v1/owner/mandate', {public_card: on}, {token});
  }

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
    if (!truthy(this.state.participant_id ?? null)) {               // only an enrolled profile is pinned
      if (this.#pinned()) this.#checkPins(nft, denom);
      return;
    }
    // An enrolled profile serves only a server of its own network, pinned or not: a pilot profile that valun 0.7.1
    // pinned to the testnet's tracker is refused here too, before any approval is asked for terms that cannot be signed.
    const err = networkProblem(this.network, info);
    if (err) throw err;
    if (this.#pinned()) {
      this.#checkPins(nft, denom);
      return;
    }
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

  /**
   * Tracker v3.2 (design v3.2 section 5): what signs a prior acknowledgment PA(...) (a bound note, a payment by transfer,
   * a payee's or payer's consent) is signed only when the last GET /info's novation object reports exactly the contract
   * novation.CONTRACT; otherwise feature_unavailable before anything is asked for or signed.
   */
  #contract() {
    const problem = nv.contractProblem(this.#novation);
    if (problem) throw new ValunError('feature_unavailable', problem + '; nothing was signed');
  }

  // ---------- guarantees (servers listing guarantees/1; fix inbox #18) ----------
  // A guarantee is a backer's signed promise to pay one creditor, up to a cap, what one issuer still owes that creditor
  // after a due time, if the creditor calls before the expiry. What is signed here is checked first, as for deals: the
  // terms hash to their hash, are valun-guarantee/1 for this network and tracker, and name this agent with its current
  // key; the backer's offer verifies under the backer's registered key. The backer honors a call with its own credit
  // note to the creditor, for exactly the amount the creditor signed and never beyond the cap by its own records,
  // written ahead in its records before anything is sent. A port of the Python client's guarantee methods.
  guarantees() {
    return this.request('GET', '/pilot/v1/guarantees');
  }

  guarantee(guaranteeId) {
    return this.request('GET', `/pilot/v1/guarantees/${seg(guaranteeId)}`);
  }

  async #guaranteesOffered() {
    // GET /info itself (it pins a profile not pinned yet), not #features(), which serves such a profile as 0.3 did.
    if (!featuresOf(await this.info()).includes('guarantees/1')) {
      throw new ValunError('feature_unavailable', 'this Valun server offers no guarantees (GET /info features has no guarantees/1); nothing was signed');
    }
  }

  /**
   * The terms of a guarantee view, checked before anything is signed for it: they hash to terms_hash, are
   * valun-guarantee/1 for this network and its tracker, cover issuer_debt_to_creditor with a whole cap in this
   * network's unit, name this agent (as `role`, when given) with its current key, and the backer's offer signature
   * verifies under the backer key the terms name, which must be the backer's registered key. Resolves to
   * {terms_hash, terms, role}.
   */
  async verifyGuarantee(g, role = null) {
    if (!isObject(g) || !isObject(g.terms)) throw new ValunError('bad_response', "the server did not return the guarantee's terms");
    const t = g.terms;
    const h = termsHash(t);
    if (h !== pyGet(g, 'terms_hash')) throw new ValunError('hash_mismatch', "the guarantee's terms do not hash to its terms_hash; refusing to sign");
    if (pyGet(t, 'protocol') !== GUARANTEE_PROTOCOL || pyGet(t, 'network') !== this.network) {
      throw new ValunError('wrong_network', 'the guarantee is for a different network or protocol');
    }
    const info = await this.#onNetwork();
    if (pyGet(t, 'tracker_nft_id') !== info.tracker_nft_id || pyGet(t, 'denomination') !== info.denomination) {
      throw new ValunError('wrong_tracker', 'the guarantee names a different tracker or unit than this network');
    }
    const cap = isObject(t.cap) ? t.cap : {};
    if (![GUARANTEE_COVERS, GUARANTEE_COVERS_DEALS].includes(pyGet(t, 'covers')) || !(natural(cap.amount) && cap.amount > 0) || pyGet(cap, 'unit') !== this.unit) {
      throw new ValunError('bad_terms', "the guarantee does not cover issuer_debt_to_creditor or issuer_payment_for_deals up to a whole cap in this network's unit");
    }
    if (pyGet(t, 'covers') === GUARANTEE_COVERS_DEALS) checkDealIds(pyGet(t, 'deals'), 'bad_terms');
    else if (Object.hasOwn(t, 'deals')) throw new ValunError('bad_terms', 'the guarantee names deals but does not cover issuer_payment_for_deals');
    const roles = ['backer', 'issuer', 'creditor'];
    if (!roles.every(r => isObject(t[r]) && typeof t[r].id === 'string' && isPubkey(t[r].pubkey))) {
      throw new ValunError('bad_terms', 'the guarantee must name a backer, an issuer and a creditor, each with its key');
    }
    const mine = roles.filter(r => t[r].id === this.participantId);
    if (!mine.length || (role !== null && !mine.includes(role))) throw new ValunError('not_a_party', `you are not the ${role || 'a party'} of this guarantee`);
    const r = role || mine[0];
    if (t[r].pubkey !== this.pubkey) throw new ValunError('wrong_key', `the guarantee names a different key for you as its ${r}; ask your operator`);
    const backerKey = t.backer.pubkey;
    if (r !== 'backer' && (await this.#registeredKey(t.backer.id)) !== backerKey) {
      throw new ValunError('wrong_key', "the backer key in the terms is not the backer's registered key");
    }
    if (!textSigned(backerKey, statement('guarantee-offer', h), pyGet(isObject(g.offer) ? g.offer : {}, 'signature'))) {
      throw new ValunError('bad_signature', "the backer's offer signature does not verify");
    }
    return {terms_hash: h, terms: t, role: r};
  }

  /**
   * The terms of a guarantee this agent offers as backer: the issuer's and the creditor's registered keys, the cap in
   * this network's unit, callable from dueInHours from now for callableForHours, honored within honorWithinHours, open
   * for offerValidHours (never past the expiry).
   */
  async buildGuaranteeTerms({issuerId, creditorId, cap, dueInHours, callableForHours = 168, honorWithinHours = 24, offerValidHours = 24, note = '', deals = null}) {
    // With deals (1 to 10 deal ids in which the issuer pays the creditor) it covers only what is unpaid of them (#29).
    if (deals !== null && deals !== undefined) checkDealIds(deals, 'bad_arguments');
    const dealMode = deals !== null && deals !== undefined;
    for (const [name, v, lo, hi] of [['cap', cap, 1, null], ['due_in_hours', dueInHours, 0, 1440], ['callable_for_hours', callableForHours, 1, 1440],
      ['honor_within_hours', honorWithinHours, 1, 168], ['offer_valid_hours', offerValidHours, 1, 168]]) {
      if (!natural(v) || v < lo || (hi !== null && v > hi)) {
        throw new ValunError('bad_arguments', `${name} must be a whole number from ${lo}` + (hi !== null ? ` to ${hi}` : ''));
      }
    }
    if (typeof note !== 'string' || cpLength(note) > 500) throw new ValunError('bad_arguments', 'note must be text of at most 500 characters');
    if (issuerId === creditorId || [issuerId, creditorId].includes(this.participantId)) {
      throw new ValunError('bad_arguments', 'the issuer, the creditor and you (the backer) must be three different participants');
    }
    const info = await this.#onNetwork();
    const now = this.#now(), due = now + dueInHours * HOUR, expires = due + callableForHours * HOUR;
    const guaranteeId = 'vg_' + bytesToHex(this.#randomBytes(8)), nonce = bytesToHex(this.#randomBytes(16));
    const issuer = {id: issuerId, pubkey: await this.#registeredKey(issuerId)};
    const creditor = {id: creditorId, pubkey: await this.#registeredKey(creditorId)};
    return {protocol: GUARANTEE_PROTOCOL, network: this.network, tracker_nft_id: info.tracker_nft_id, denomination: info.denomination,
      guarantee_id: guaranteeId, nonce, backer: {id: this.participantId, pubkey: this.pubkey}, issuer, creditor,
      cap: {amount: cap, unit: this.unit}, covers: dealMode ? GUARANTEE_COVERS_DEALS : GUARANTEE_COVERS, ...(dealMode ? {deals: [...deals]} : {}),
      due_at: isoSeconds(due), expires_at: isoSeconds(expires),
      honor_within_hours: honorWithinHours, offer_expires_at: isoSeconds(Math.min(now + offerValidHours * HOUR, expires)), note};
  }

  /** Offer a guarantee as its backer (buildGuaranteeTerms), signed with statement guarantee-offer. */
  async offerGuarantee(options) {
    await this.#guaranteesOffered();
    const t = await this.buildGuaranteeTerms(options);
    const h = termsHash(t);
    return this.request('POST', '/pilot/v1/guarantees', {terms: t, terms_hash: h, signature: this.#sign(statement('guarantee-offer', h))});
  }

  async #checkedGuarantee(guaranteeId, role, expectedTermsHash) {
    await this.#guaranteesOffered();
    const g = await this.guarantee(guaranteeId);
    const chk = await this.verifyGuarantee(g, role);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== chk.terms_hash) {
      throw new ValunError('stale_terms', 'the guarantee is not the one you reviewed; read it again (valun_guarantees) first');
    }
    return [g, chk];
  }

  /** Accept a guarantee offered to this agent as its creditor (it commits the creditor to nothing). */
  async acceptGuarantee(guaranteeId, {expectedTermsHash = undefined} = {}) {
    const [, chk] = await this.#checkedGuarantee(guaranteeId, 'creditor', expectedTermsHash);
    const h = chk.terms_hash;
    return this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/accept`, {terms_hash: h, signature: this.#sign(statement('guarantee-accept', h))});
  }

  async declineGuarantee(guaranteeId, reason = '') {
    const g = await this.guarantee(guaranteeId);
    const h = g.terms_hash;
    return this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/decline`, {terms_hash: h, reason,
      signature: this.#sign(statement('guarantee-decline', h, sha256Hex(reason)))});
  }

  async withdrawGuarantee(guaranteeId) {
    const g = await this.guarantee(guaranteeId);
    const h = g.terms_hash;
    return this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/withdraw`, {terms_hash: h, signature: this.#sign(statement('guarantee-withdraw', h))});
  }

  /** End a guarantee this agent accepted as its creditor: it can no longer be called. */
  async releaseGuarantee(guaranteeId, {expectedTermsHash = undefined} = {}) {
    const [, chk] = await this.#checkedGuarantee(guaranteeId, 'creditor', expectedTermsHash);
    const h = chk.terms_hash;
    return this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/release`, {terms_hash: h, signature: this.#sign(statement('guarantee-release', h))});
  }

  /**
   * Call a guarantee this agent holds as its creditor, for `amount` (default: everything callable now, as the server
   * computes it from the tracker). The server checks the amount again against the tracker.
   */
  async callGuarantee(guaranteeId, {amount = null, expectedTermsHash = undefined} = {}) {
    const [g, chk] = await this.#checkedGuarantee(guaranteeId, 'creditor', expectedTermsHash);
    const t = chk.terms, callableNow = pyGet(g, 'callable_now');
    const a = amount === null || amount === undefined ? callableNow : amount;
    if (!natural(a) || a < 1) {
      throw new ValunError('nothing_callable', `nothing can be called on this guarantee now (callable_now: ${str(callableNow)}). It is callable `
        + `from ${str(t.due_at)} until ${str(t.expires_at)}, for what the issuer still owes you, `
        + 'less what earlier calls claimed, within the cap left; nothing was signed');
    }
    const cid = 'vgc_' + bytesToHex(this.#randomBytes(8));
    const h = chk.terms_hash;
    return this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/calls`, {call_id: cid, amount: a, terms_hash: h,
      signature: this.#sign(statement('guarantee-call', h, cid, String(a)))});
  }

  /**
   * Pay a call of a guarantee this agent gave, with its own credit note to the creditor. Checked before anything is
   * signed (as in the Python client): the guarantee (verifyGuarantee, as its backer); the call (open or failed, its id
   * and a whole amount, signed by the creditor over exactly that id and amount, under the key the terms name or its
   * registered key); this agent's own record of the calls it honored or is honoring, which with this one must stay
   * within the cap it signed (exceeds_cap); and the note template as complete() checks a deal's. With a server listing
   * bound_notes/1 the note is bound (its prior is this agent's own signature and not older than its records, and the
   * prior acknowledgment is signed too; tracker v3.2 contract only); otherwise ordinary. R4 and the pending record are
   * written ahead before anything is sent; an earlier note for the same call that may have applied is never followed
   * by another (honor_pending).
   */
  async honorGuarantee(guaranteeId, {callId = null, expectedTermsHash = undefined} = {}) {
    const [g, chk] = await this.#checkedGuarantee(guaranteeId, 'backer', expectedTermsHash);
    const t = chk.terms, h = chk.terms_hash;
    const calls = iterateList(pyGet(g, 'calls')).filter(isObject);
    let c;
    if (callId === null || callId === undefined) {
      const waiting = calls.filter(x => ['open', 'failed'].includes(pyGet(x, 'state')));
      if (!waiting.length) throw new ValunError('nothing_to_honor', 'no call of this guarantee is waiting to be honored; nothing was signed');
      c = waiting[0];
    } else {
      c = calls.find(x => pyGet(x, 'call_id') === callId) ?? null;
      if (c === null) throw new ValunError('not_found', `this guarantee has no call ${str(callId)}`);
    }
    const cid = pyGet(c, 'call_id'), amount = pyGet(c, 'amount');
    if (pyGet(c, 'state') === 'honored') throw new ValunError('already_honored', `call ${str(cid)} is honored already`);
    if (!['open', 'failed'].includes(pyGet(c, 'state')) || typeof cid !== 'string' || !/^vgc_[0-9a-f]{16}$/.test(cid) || !(natural(amount) && amount > 0)) {
      throw new ValunError('wrong_state', `call ${str(cid)} is ${str(pyGet(c, 'state'))}; nothing to honor`);
    }
    const creditorPk = await this.#registeredKey(t.creditor.id);
    const callText = statement('guarantee-call', h, cid, String(amount));
    if (![t.creditor.pubkey, creditorPk].some(k => textSigned(k, callText, pyGet(c, 'signature')))) {
      throw new ValunError('bad_signature', "the creditor's signature on this call does not verify; nothing was signed");
    }
    const cap = t.cap.amount;
    const features = await this.#features();
    const bound = features.includes('bound_notes/1');
    if (bound) this.#contract();                 // never an ordinary note instead: fail closed
    const tpl = await this.request('GET', `/pilot/v1/guarantees/${seg(guaranteeId)}/calls/${seg(cid)}/note-template` + (bound ? '?prior=1&bound=1' : ''));
    if (!isObject(tpl) || pyGet(tpl, 'issuer_pubkey') !== this.pubkey || pyGet(tpl, 'recipient_pubkey') !== creditorPk) {
      throw new ValunError('bad_template', "the note template does not name your key and the creditor's current key");
    }
    const P = pyGet(tpl, 'prior_total'), total = pyGet(tpl, 'total'), ts = pyGet(tpl, 'timestamp');
    if (pyGet(tpl, 'amount') !== amount || !(natural(P) && natural(total) && natural(ts)) || total !== P + amount) {
      throw new ValunError('bad_template', "the note template does not add exactly the call's amount");
    }
    const nft = pyGet(tpl, 'tracker_nft_id'), denom = pyGet(tpl, 'denomination');
    if (nft !== t.tracker_nft_id || denom !== t.denomination) throw new ValunError('bad_template', 'the note template names a different tracker or unit');
    this.#checkPins(nft, denom);
    const nowMs = this.#now();
    if (bound) {
      if (ts % 1000 !== nv.BOUND_MS || !(nowMs - NOTE_CLOCK_TOLERANCE_MS <= ts && ts <= nowMs + 5000)) {
        throw new ValunError('bad_template', 'the note template is not a current bound note (residue 997)');
      }
    } else if (Math.abs(ts - nowMs) > NOTE_CLOCK_TOLERANCE_MS || (features.length && ts % 1000 >= RESERVED_MS_FROM)) {
      throw new ValunError('bad_template', 'the note template timestamp is not current, or ends in a residue kept for other operations');
    }
    const pair = `${this.pubkey}>${creditorPk}`;
    const verify = noteVerifier(nft, denom);
    await this.#reload();
    let p = 0;
    if (bound) {
      const prior = pyGet(tpl, 'prior_note');
      if (prior === null || prior === undefined) {
        const known = this.#knownTotal(pair);
        if (P !== 0 || pyGet(tpl, 'prior_timestamp') !== 0 || !(known === null || known === 0)) {
          throw new ValunError('ledger_mismatch', 'the server shows no note on this edge, but its template or your own records say otherwise. Ask your operator.');
        }
      } else {
        const problem = records.priorProblem(recordsIn(this.state, false), pair, prior, this.pubkey, verify);
        if (problem || pyGet(prior, 'total') !== P || pyGet(prior, 'timestamp') !== pyGet(tpl, 'prior_timestamp')) {
          throw new ValunError('ledger_mismatch', 'the prior note the server shows on this edge is not your own latest note '
            + `(${problem || 'it does not match the template'}). Ask your operator.`);
        }
        p = prior.timestamp;
      }
    } else {
      const known = this.#knownTotal(pair);
      if (known !== null && known !== P) {
        throw new ValunError('ledger_mismatch', `the server says the notes you issued this creditor total ${P} ${this.unit} so far; your own record says ${str(known)}. Ask your operator.`);
      }
    }
    const op = 'guarantee_note:' + cid, signedAt = isoSeconds(this.#now());
    let slots = {[nv.slotKey(pair, 'new')]: total};
    if (bound) slots = {[nv.slotKey(pair, 'prior')]: P, ...slots};
    const wa = {op, signed: [{edge: pair, timestamp: ts, op, slots, ...(bound ? {prior_state: {total: P, timestamp: p}} : {})}],
      pending: [{pair, total, timestamp: ts, kind: 'guarantee_note', ref: cid, direction: 'out'}], attempt: null};
    const agreed = {tracker_nft_id: nft, denomination: denom};
    this.#secretBytes().fill(0);                 // not_connected before anything is recorded
    await this.#update(state => {                // written before the note is signed and sent: its outcome is not known yet
      const err = pinProblem(pinsOf(state), nft, denom);
      if (err) throw err;
      if (!bound) {
        const problem = nv.unboundNoteProblem(pair, state.novated_edges ?? null, features);
        if (problem) {
          throw new ValunError(problem, problem === 'bound_note_required' ? 'a novation changed this edge, so it takes bound notes only; nothing was signed'
            : "this profile's record of novated edges cannot be read; nothing was signed");
        }
      }
      const honors = dictIn(state, GUARANTEE_HONORS_KEY);
      const rec = isObject(honors[guaranteeId]) ? honors[guaranteeId] : {};
      const mine = isObject(rec.calls) ? rec.calls : {};
      let others = 0;
      for (const [k, x] of Object.entries(mine)) {
        if (k !== cid && isObject(x) && ['pending', 'honored'].includes(pyGet(x, 'state')) && natural(pyGet(x, 'amount'))) others += x.amount;
      }
      if (others + amount > cap) {
        throw new ValunError('exceeds_cap', `honoring ${amount} ${this.unit} would bring what you paid or are paying under this guarantee to `
          + `${others + amount} ${this.unit}, above its cap of ${cap} ${this.unit} (by your own records); nothing was signed`);
      }
      const was = mine[cid];
      if (isObject(was) && pyGet(was, 'state') === 'pending' && natural(pyGet(was, 'total')) && P >= was.total) {
        throw new ValunError('honor_pending', `your earlier note for this call (${was.total} ${this.unit} in total to this creditor) may already be on `
          + `the tracker: the edge is at ${P} ${this.unit} now. Refusing to sign another. Ask your operator.`);
      }
      guarded(nv.applyWriteAhead, state, wa, signedAt);
      if (!pinsOf(state)) state.pins = {...agreed};
      honors[guaranteeId] = {cap, calls: {...mine, [cid]: {amount, state: 'pending', total, timestamp: ts}}};
    });
    const note = {total, timestamp: ts, signature: this.#signBytes(nv.message(this.pubkey, creditorPk, total, ts, nft, denom))};
    const creditNote = {...note};
    if (bound) Object.assign(creditNote, {prior_total: P, prior_timestamp: p, prior_signature: this.#signBytes(nv.priorMessage(this.pubkey, creditorPk, P, p, ts, nft, denom))});
    const body = {terms_hash: h, amount, signature: this.#sign(statement('guarantee-honor', h, cid, String(amount))), credit_note: creditNote};
    const settle = (state, outcome) => {
      const honors = dictIn(state, GUARANTEE_HONORS_KEY);
      const rec = honors[guaranteeId];
      const callsRec = isObject(rec) && isObject(rec.calls) ? rec.calls : null;
      if (outcome === 'honored') {
        this.#confirmIn(state, pair, note);
        if (callsRec !== null && isObject(callsRec[cid])) callsRec[cid].state = 'honored';
      } else {                                   // refused or failed: this note will not be recorded
        records.removePending(recordsIn(state), pair, total, ts, cid);
        if (callsRec !== null && isObject(callsRec[cid]) && callsRec[cid].timestamp === ts) callsRec[cid].state = 'failed';
      }
    };
    let r;
    try {
      r = await this.request('POST', `/pilot/v1/guarantees/${seg(guaranteeId)}/calls/${seg(cid)}/honor`, body);
    } catch (e) {
      if (isValunError(e) && typeof e.status === 'number' && e.status >= 400 && e.status < 500) await this.#settle(state => settle(state, 'refused'));
      throw e;                                   // otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
    }
    const shown = isObject(r) ? iterateList(pyGet(r, 'calls')).find(x => isObject(x) && pyGet(x, 'call_id') === cid) ?? null : null;
    const st = isObject(shown) ? pyGet(shown, 'state') : null;
    if (st === 'honored') await this.#settle(state => settle(state, 'honored'));
    else if (st === 'failed') await this.#settle(state => settle(state, 'failed'));
    return r;
  }

  // ---------- independent checks ----------
  async #registeredKey(pid) {
    const p = await this.participant(pid);
    if (!isObject(p) || p.status !== 'active' || !p.pubkey) {
      throw new ValunError('counterparty_inactive', `${pid} has no active registered key`);
    }
    return p.pubkey;
  }

  /**
   * GET /info, for terms built or checked from it: refused before anything is signed when the server does not name
   * this profile's network (wrong_network; Client.network, so also for a profile enrolled before 0.5, which names
   * none), also for a profile pinned to a tracker that server names too. The Python _network_info.
   */
  async #onNetwork() {
    const info = await this.info();
    if (!isObject(info)) throw new ValunError('bad_response', 'GET /info did not return an object');
    const err = networkProblem(this.network, info);
    if (err) throw err;
    return info;
  }

  /** GET /info, checked against this profile's network (#onNetwork) and the pins given to the constructor. */
  async #networkInfo() {
    const info = await this.#onNetwork();
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
    if (t.network !== this.network || t.protocol !== PROTOCOL) throw new ValunError('wrong_network', 'terms are for a different network or protocol');
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
    if (Object.hasOwn(t, 'payment_issuer')) await this.#checkPaymentIssuer(t);
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
    if (t.price.unit !== this.unit || !Number.isSafeInteger(t.price.amount)) throw new ValunError('bad_terms', `the price is not a whole number of ${this.unit}`);
    if (t.consideration !== CONSIDERATION) throw new ValunError('bad_terms', `the consideration is not ${CONSIDERATION}`);
    if (!exactKeys(t, [...TERMS_FIELDS, ...OPTIONAL_TERMS_FIELDS.filter(k => Object.hasOwn(t, k))]) || !exactKeys(t.payer, ['id', 'pubkey']) || !exactKeys(t.payee, ['id', 'pubkey'])
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

  /**
   * Terms that name a payment issuer (payment_issuer {id, pubkey}; fix inbox #192/#196): a third participant, neither
   * party, under its current registered key (bad_terms, wrong_key otherwise).
   */
  async #checkPaymentIssuer(t) {
    const x = t.payment_issuer;
    if (!(exactKeys(x, ['id', 'pubkey']) && typeof x.id === 'string' && typeof x.pubkey === 'string')) {
      throw new ValunError('bad_terms', 'the terms name a payment_issuer that is not {id, pubkey}; refusing to sign');
    }
    if (x.id === t.payer.id || x.id === t.payee.id) {
      throw new ValunError('bad_terms', 'the terms name a party of the deal as its payment_issuer; refusing to sign');
    }
    if (await this.#registeredKey(x.id) !== x.pubkey) throw new ValunError('wrong_key', "the payment issuer's key in the terms is not its registered key");
    return x;
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
  /**
   * valun-deal/1 terms for a new proposal (or, with dealId/version/prior, a counter-offer). Signs nothing. The price is a
   * whole number of this network's unit, at least 1 (bad_price; never truncated). Delivery is due deliverByHours from now;
   * the offer stays open offerTtlHours, or, with offerTtlHours null, COUNTER_OFFER_HOURS but never past deliver_by nor
   * past priorExpiresAt (an RFC 3339 time: the end of the offer a counter-offer answers). Times are whole seconds,
   * rounded down. Terms the server would refuse for their times are refused here first (bad_arguments, fix inbox #23): an
   * offer open longer than the hours it gives to deliver (checkOfferHours), or one already expired when it is sent.
   * paymentIssuer (a participant id; fix inbox #192/#196): the terms name that participant, under its current registered
   * key, as the issuer whose note the payer will pass to the payee (payment_issuer {id, pubkey}); neither party may be it
   * (bad_arguments). Without it the terms are exactly as before.
   */
  async buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24,
    dealId = undefined, version = 1, prior = null, priorExpiresAt = null, paymentIssuer = null}) {
    if (role !== 'payer' && role !== 'payee') {
      throw new ValunError('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)');
    }
    if (![title, description, deliverable].every(x => typeof x === 'string')) {
      throw new ValunError('bad_terms', 'title, description and deliverable must be strings');
    }
    const amount = toPrice(price, this.unit);
    const dueH = toHours(deliverByHours, 'deliverByHours');
    const ttlH = offerTtlHours === null ? null : toHours(offerTtlHours, 'offerTtlHours');
    if (ttlH !== null) checkOfferHours(ttlH, dueH);
    this.#secretBytes().fill(0);   // fail early (not_connected) rather than after the reads
    const info = await this.#networkInfo();
    const other = {id: counterpartyId, pubkey: await this.#registeredKey(counterpartyId)};
    const me = {id: this.participantId, pubkey: this.pubkey};
    const now = this.#now();
    const deliverBy = now + dueH * HOUR;
    const ends = ttlH === null ? [now + COUNTER_OFFER_HOURS * HOUR, deliverBy] : [now + ttlH * HOUR];
    if (ttlH === null && priorExpiresAt !== null && priorExpiresAt !== undefined) ends.push(Date.parse(priorExpiresAt));
    const expires = isoSeconds(Math.min(...ends));
    if (!(Date.parse(expires) > now)) {
      throw new ValunError('bad_arguments', `the offer would expire at ${expires}, before it is sent: it must stay open `
        + 'for at least 1 h (offer_valid_hours); nothing was signed');
    }
    const t = {
      protocol: PROTOCOL, network: this.network, tracker_nft_id: info.tracker_nft_id, denomination: info.denomination,
      deal_id: dealId || ('vd_' + bytesToHex(this.#randomBytes(8))), version, prior_terms_hash: prior,
      nonce: bytesToHex(this.#randomBytes(16)), proposer: this.participantId,
      payer: role === 'payer' ? me : other, payee: role === 'payer' ? other : me,
      service: {title, description, deliverable},
      price: {amount, unit: this.unit}, consideration: CONSIDERATION,
      deliver_by: isoSeconds(deliverBy), offer_expires_at: expires,
    };
    if (paymentIssuer !== null && paymentIssuer !== undefined) {
      if (typeof paymentIssuer !== 'string' || !paymentIssuer) throw new ValunError('bad_arguments', 'the payment issuer is a participant id; nothing was signed');
      if (paymentIssuer === this.participantId || paymentIssuer === counterpartyId) {
        throw new ValunError('bad_arguments', 'pay_with must name a third participant, whose note the payer passes on: '
          + "not the payer (its own note is what an offer without pay_with says) and not the payee; nothing was signed");
      }
      t.payment_issuer = {id: paymentIssuer, pubkey: await this.#registeredKey(paymentIssuer)};
    }
    return t;
  }

  /**
   * Propose a new deal (version 1), signed by this agent. payWith (a participant id; null or 'own_note': none) names the
   * payment issuer in the terms (buildTerms paymentIssuer).
   */
  async propose({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24, payWith = null}) {
    const t = await this.buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours,
      paymentIssuer: payWith === null || payWith === undefined || payWith === 'own_note' ? null : payWith});
    const h = termsHash(t);
    return this.request('POST', '/pilot/v1/deals', {terms: t, terms_hash: h, signature: this.#sign(statements.propose(h))});
  }

  /**
   * Counter the current offer: verify it, then sign new terms (version + 1, prior = its hash). Unset fields carry over.
   * With expectedTermsHash (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current
   * offer is another. Delivery is due deliverByHours from now, by default by the current offer's deadline (rounded down
   * to the hour, at least 1 h from now). The counter-offer stays open offerTtlHours; by default (fix inbox #23)
   * COUNTER_OFFER_HOURS, but never past its own delivery deadline nor past the end of the offer it answers, so a
   * price-only counter to an offer due within a day is valid terms too. payWith: null keeps the payment issuer of the
   * current offer (none when it names none), 'own_note' names none, and a participant id names that participant
   * (buildTerms paymentIssuer).
   */
  async counter(dealId, {price = undefined, title = undefined, description = undefined, deliverable = undefined,
    deliverByHours = undefined, offerTtlHours = undefined, expectedTermsHash = undefined, payWith = null} = {}) {
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
      deliverByHours: dueH, offerTtlHours: offerTtlHours ?? null, dealId, version: t0.version + 1, prior: chk.terms_hash,
      priorExpiresAt: t0.offer_expires_at,
      paymentIssuer: payWith === null || payWith === undefined ? (isObject(t0.payment_issuer) ? t0.payment_issuer.id : null)
        : payWith === 'own_note' ? null : payWith,
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
   * (ledger_mismatch). Only for the tracker v3.2 contract (GET /info novation, novation.CONTRACT; feature_unavailable
   * otherwise, before the template is asked for). The note M(I,R,P+price,ts) and its prior acknowledgment PA(I,R,P,p,ts)
   * (p the prior note's timestamp, 0 for a new edge) are built and signed here and sent as credit_note {total,
   * timestamp, signature, prior_total, prior_timestamp, prior_signature}, after the R4 record, the payment attempt and
   * the pending entry are saved.
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
    await this.learnOwnerDecisions(dealId, d);    // a payment held for the owner that ended unreleased is not applied
    const [terms, h, dh] = this.#acceptedDelivery(d, dealId, expectedDeliverableSha256, expectedTermsHash);
    const named = terms.payment_issuer;
    if (isObject(named)) {                  // fix inbox #192/#196: these terms are paid only with that issuer's note
      throw new ValunError('terms_name_payment_issuer', `the agreed terms name ${named.id} as the payment issuer: this deal is paid `
        + `only by passing on that issuer's note (pay_with=${named.id}), not with a note of your own; nothing was signed`,
      undefined, {payment_issuer: {id: named.id}});
    }
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
        + 'the tracker keeps residues 995-999 for other operations; refusing to sign it as a note');
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
        throw new ValunError(problem, 'a novation changed this edge, so it takes bound notes only, and this server '
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
    this.#contract();                            // never an ordinary note instead: fail closed
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
          return refused(r, 'ledger_mismatch', `the server shows an older prior note to this payee (${shown.total} ${this.unit} at `
            + `${shown.timestamp}) than your own record (${mine.total} ${this.unit} at ${mine.timestamp}). Ask your operator.`);
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
      credit_note: {...note, prior_total: tpl.prior_total, prior_timestamp: r.write_ahead.attempt.prior_timestamp,
        prior_signature: this.#signBytes(msgs[nv.slotKey(pair, 'prior')])}};
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
    } else if (status === 'completion_awaiting_owner') {
      // Held for the owner: the id of the approval that holds it goes on its attempt record, so that the owner's
      // decision is known on a later read of the deal (learnOwnerDecisions).
      const cn = isDict(pyGet(r, 'credit_note')) ? r.credit_note : {};
      const aid = typeof pyGet(cn, 'approval_id') === 'string' && APPROVAL_ID_RE.test(cn.approval_id) ? cn.approval_id
        : Client.#heldApproval(r, 'issue_note');
      if (aid) {
        const held = {deal_id: dealId, route: 'note', edge: pair, total: note.total, timestamp: note.timestamp};
        await this.#settle(state => Client.#noteAttemptId(state, held, aid, 'approval_id'));
      }
    } else if (status !== 'issuing_note') {
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
    return {me_pk: this.pubkey, me_id: this.participantId, now_ms: nowMs, verify: verifyHexFor, unit: this.unit, pins: pinsOf(state),
      records: state.records ?? null, signed: state.signed ?? null, transfer_attempts: state.transfer_attempts ?? null,
      novated_edges: state.novated_edges ?? null, features: [...features], consent_policy: state.consent_policy ?? null,
      novation: this.#novation, ...extra};
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
      throw new ValunError('ledger_mismatch', `the server says the notes you issued this payee total ${tpl.prior_total} ${this.unit} so far; your own record says ${str(now)}. Ask your operator.`);
    }
    for (const p of this.#pendingNotes(pair, dealId)) {
      // Still pending, so neither its deal nor the edge shows its outcome. If the edge has reached its total, it may have
      // applied (an owner approved it after this client signed): paying the deal again could pay it twice.
      const total = pyGet(p, 'total');
      if (typeof total === 'number' && Number.isSafeInteger(total) && tpl.prior_total >= total) {
        throw new ValunError('already_paid', `your earlier note for this deal (${total} ${this.unit} in total to this payee) may `
          + `already be on the tracker: the edge's total is ${tpl.prior_total} ${this.unit} now. Refusing `
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
      Client.#refusePaidAgain(dealId, found.map(([, p]) => p), this.unit);
    }
  }

  /** A note of mine that applied paid its own deal: never sign a second payment for it, whatever the server says. */
  static #refusePaidAgain(dealId, applied, unit = UNIT) {
    for (const p of applied) {
      if (pyGet(p, 'kind') === 'note' && pyGet(p, 'ref') === dealId) {
        throw new ValunError('already_paid', `your note for this deal (${str(pyGet(p, 'total'))} ${unit}) is already on the tracker, so `
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
   * the delivery; the server lists circulation/1 and reports the tracker v3.2 contract (GET /info novation,
   * novation.CONTRACT; feature_unavailable); the template is for the issuer chosen, under that
   * participant's current key (bad_template); novation.evaluatePayerTemplate (15.3 R1-R13, and decision D-1, with one
   * GET /edges read-back when an earlier attempt's edge must be read). With expectedQuoteDigest (the quote the owner
   * approved) another quote is stale_quote; with expectedClaimTotal (my claim on A that the owner saw) another prior
   * total of A->me is stale_claim.
   *
   * Saved before anything is sent (R9): the R4 record of the three slots, the payment attempt (transfer_attempts), the
   * pending decrease of my claim on A (records) and approved_payments[deal_id] = the quote digest. The prior slot is
   * PA(A,me,X,p_AB,T) (tracker v3.2), and the body carries from_prior_total, from_prior_timestamp, to_prior_total and
   * to_prior_timestamp (the states the template showed; 0 and 0 for a new destination edge). A 409 transfer_stale
   * that the server answers with a fresh template is checked once more under the same quote digest: D-1 signs it as
   * the identical operation (the first attempt's timestamp) or, at a new T, when it acknowledges the same state of my
   * claim on A as the first attempt (total and timestamp: on tracker v3.2 at most one of the two can apply, audit VS-1
   * closed); a template on another state of my claim is transfer_window_open until the first attempt is dead; one that
   * names the transfer it recorded (transfer_id, regenerated_as) is not retried, and the deal view is returned. paid_by_transfer
   * records the deal as paid; a refusal, or payment_due, forgets the pending entry, and the attempt stays until it is
   * dead (with the server's id of it, attempt_id, once known). Resolves to the deal view.
   */
  async payByTransfer(dealId, issuer, {expectedDeliverableSha256 = undefined, expectedQuoteDigest = undefined,
    expectedClaimTotal = undefined} = {}) {
    const claim = expectedClaimTotal ?? null;
    if (claim !== null && !natural(claim)) {
      throw new ValunError('bad_arguments', `expected_claim_total is a whole number of ${this.unit} (the claim your owner saw); nothing was signed`);
    }
    this.#secretBytes().fill(0);
    const d = await this.deal(dealId);
    await this.learnOwnerDecisions(dealId, d);    // a payment held for the owner that ended unreleased is not applied
    const [terms, h, dh] = this.#acceptedDelivery(d, dealId, expectedDeliverableSha256);
    const payee = await this.#registeredKey(terms.payee.id);
    Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
    const features = await this.#circulation();
    this.#contract();
    const issuerId = await this.#resolveIssuer(dealId, issuer);
    const named = terms.payment_issuer;
    if (isObject(named) && named.id !== issuerId) {             // fix inbox #192/#196
      throw new ValunError('payment_issuer_mismatch', `the agreed terms name ${named.id} as the payment issuer: this deal is paid `
        + `only with that issuer's note, not ${issuerId}'s (pay_with=${named.id}); nothing was signed`,
      undefined, {payment_issuer: {id: named.id}, issuer: issuerId});
    }
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
      const aid = status === 'completion_awaiting_owner' ? Client.#heldApproval(view, 'pay_by_transfer') : null;
      if (aid) await this.#settle(state => Client.#noteAttemptId(state, a, aid, 'approval_id'));   // held for the owner
      if (status === 'paid_by_transfer') {
        await this.#settle(state => guarded(nv.markPaid, state, a.deal_id, 'transfer', a.edge, a.total, a.timestamp));
      } else if (status === 'payment_due') {
        await this.#settle(forget);
      }
      return view;
    }
    return undefined;                             // not reached: the second attempt returns or throws
  }

  /**
   * Record the server's id of a payment attempt (its transfer id; key 'approval_id': the id of the owner's approval that
   * holds it) on my record of it. An id it already has is kept.
   */
  static #noteAttemptId(state, attempt, attemptId, key = 'attempt_id') {
    const att = state.transfer_attempts;
    const lst = isDict(att) ? or(pyGet(att, attempt.deal_id), []) : [];
    for (const x of Array.isArray(lst) ? lst : []) {
      if (isDict(x) && ['route', 'edge', 'total', 'timestamp'].every(k => pyEq(pyGet(x, k), attempt[k])) && !truthy(pyGet(x, key))) {
        x[key] = attemptId;
      }
    }
  }

  /** The id of the one pending approval of `kind` a deal view lists (this participant's own), or null. */
  static #heldApproval(view, kind) {
    const rows = isDict(view) && Array.isArray(pyGet(view, 'approvals')) ? view.approvals : [];
    const ids = rows.filter(a => isDict(a) && pyGet(a, 'kind') === kind && pyGet(a, 'state') === 'pending'
      && typeof pyGet(a, 'id') === 'string' && APPROVAL_ID_RE.test(a.id)).map(a => a.id);
    return ids.length === 1 ? ids[0] : null;
  }

  /**
   * What the payer's owner, or the server, decided about a payment of deal `dealId` that this client signed and the
   * server held for the owner (OWNER_HELD_KINDS), from the deal view `d`, as the Python client's learn_owner_decisions:
   * each payment attempt whose hold ended without being released (holdEnded: rejected in the owner console, or void) is
   * recorded as not applied (outcome 'not_applied', server_ended {state, approval_id, at}), and its pending entry is
   * forgotten. Resolves to the attempts recorded now; a profile that cannot be written leaves the records as they were.
   */
  async learnOwnerDecisions(dealId, d) {
    if (!(isDict(d) && typeof dealId === 'string' && [null, undefined, 'payer'].includes(pyGet(d, 'your_role')))) return [];
    const rows = (Array.isArray(pyGet(d, 'approvals')) ? d.approvals : []).filter(a => isDict(a)
      && OWNER_HELD_KINDS.includes(pyGet(a, 'kind')) && typeof pyGet(a, 'id') === 'string' && APPROVAL_ID_RE.test(a.id)
      && [null, undefined, dealId].includes(pyGet(a, 'deal_id')));
    const ended = new Map(rows.filter(a => holdEnded(pyGet(a, 'state'))).map(a => [a.id, a]));
    const cn = isDict(pyGet(d, 'credit_note')) ? d.credit_note : {};
    const cnote = isDict(pyGet(cn, 'note')) ? cn.note : {};
    const tooLate = pyGet(d, 'status') === 'note_failed' && pyGet(cn, 'error_code') === 'novation_expired'
      && natural(pyGet(cnote, 'timestamp')) ? cnote.timestamp : null;
    const pay = isDict(pyGet(d, 'payment')) ? d.payment : {};
    if (!ended.size && tooLate === null) return [];
    const near = (x, b) => {
      const made = isoToMs(pyGet(x, 'created_at'));
      return made !== null && made - b.timestamp >= 0 && made - b.timestamp <= HELD_MATCH_MS;
    };
    const endedBy = (a, openRows) => {
      const aid = typeof pyGet(a, 'approval_id') === 'string' && a.approval_id ? a.approval_id : null;
      if (a.route === 'note' && tooLate !== null && a.timestamp === tooLate) return ['novation_expired', aid, null];
      if (aid) {
        const x = ended.get(aid);
        return x ? [pyGet(x, 'state'), aid, pyGet(x, 'decided_at')] : null;
      }
      if (a.route === 'transfer') {
        const held = [...ended.values()].filter(x => pyGet(x, 'kind') === 'pay_by_transfer');
        if (held.length && truthy(pyGet(a, 'attempt_id')) && a.attempt_id === pyGet(pay, 'transfer_id')
            && NEVER_APPLIED_TRANSFER.includes(pyGet(pay, 'state'))) return [serverWord(pay.state), null, null];
        return null;
      }
      const notes = rows.filter(x => pyGet(x, 'kind') === 'issue_note' && near(x, a));
      if (notes.length !== 1 || !ended.has(notes[0].id) || claimed.has(notes[0].id)) return null;   // another attempt's own
      const x = notes[0];
      const mine = openRows.filter(b => b.route === 'note' && !truthy(pyGet(b, 'approval_id')) && near(x, b));
      return mine.length === 1 && mine[0] === a ? [pyGet(x, 'state'), x.id, pyGet(x, 'decided_at')] : null;
    };
    const claimed = new Set();                 // approval ids an attempt record of this deal holds as its own
    const marks = state => {
      const att = isDict(state) ? pyGet(state, 'transfer_attempts') : null;
      const lst = (Array.isArray(isDict(att) ? pyGet(att, dealId) : null) ? att[dealId] : []).filter(isDict);
      claimed.clear();
      for (const a of lst) if (typeof pyGet(a, 'approval_id') === 'string') claimed.add(a.approval_id);
      const openRows = lst.filter(a => pyGet(a, 'outcome') === null
        && nv.ROUTES.includes(pyGet(a, 'route')) && nv.parseEdge(pyGet(a, 'edge')) !== null
        && natural(pyGet(a, 'total')) && natural(pyGet(a, 'timestamp')));
      return openRows.map(a => [a, endedBy(a, openRows)]).filter(([, w]) => w !== null);
    };
    await this.#reload();                        // another process may have recorded one
    if (!marks(this.state).length) return [];   // nothing to record: the profile is not written
    const found = [];
    try {
      await this.#update(state => {
        for (const [a, [st, aid, at]] of marks(state)) {
          a.outcome = 'not_applied';
          a.server_ended = {state: serverWord(st), approval_id: aid, at: isoToMs(at) !== null ? at : null};
          records.removePending(recordsIn(state), a.edge, a.total, a.timestamp, dealId);
          found.push({route: a.route, edge: a.edge, total: a.total, timestamp: a.timestamp, server_ended: {...a.server_ended}});
        }
      });
    } catch (e) {
      if (!isValunError(e) && !isSystemError(e) && !(e instanceof TypeError)) throw e;
      return [];
    }
    return found;
  }

  /**
   * learnOwnerDecisions() for each deal not recorded as paid with a payment attempt still open in this client's records
   * (one GET /deals/{id} each); a deal that cannot be read now is left as its records hold it. Resolves to the attempts
   * recorded as not applied.
   */
  async refreshOwnerDecisions() {
    const att = pyGet(this.state, 'transfer_attempts');
    const recs = recordsIn(this.state, false);
    const paid = isDict(pyGet(recs, nv.PAID_DEALS_KEY)) ? recs[nv.PAID_DEALS_KEY] : {};
    const found = [];
    for (const dealId of isDict(att) ? sortedStrings(Object.keys(att)) : []) {
      const lst = att[dealId];
      if (Object.hasOwn(paid, dealId) || !DEAL_ID_RE.test(dealId) || !Array.isArray(lst)
          || !lst.some(a => isDict(a) && pyGet(a, 'outcome') === null)) continue;
      let d;
      try {
        d = await this.deal(dealId);
      } catch (e) {
        if (isValunError(e)) continue;
        throw e;
      }
      found.push(...await this.learnOwnerDecisions(dealId, d));
    }
    return found;
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
        return refused(r, 'stale_claim', `your claim on this issuer is ${str(held)} ${this.unit} now, not the ${str(claim)} ${this.unit} you reviewed; `
          + 'nothing was signed. Review the payment again.');
      }
      return null;
    };
    const approve = (state, r) => { dictIn(state, 'approved_payments')[deal.deal_id] = r.summary.quote_digest; };
    const r = await this.#decide((state, edges) => nv.evaluatePayerTemplate(tpl, this.#ctx(state, nowMs, features,
      {deal, payee_current_pk: payee, approved_quote_digest: approved, mandate, edges})), signedAt, {refuse: claimShown, also: approve});
    if (!r.ok) throw refusalError(r);
    const q = r.summary.quote_digest;
    const fromBefore = tpl.from_edge.before, toBefore = pyGet(tpl.to_edge, 'before');
    const msgs = nv.slotMessages(r.to_sign, tpl.tracker_nft_id, tpl.denomination);
    const body = {issuer_id: issuerId, terms_hash: deal.terms_hash, deliverable_sha256: deal.deliverable_sha256, quote_digest: q,
      timestamp: tpl.timestamp, from_prior_total: fromBefore.total, from_prior_timestamp: fromBefore.timestamp,
      to_prior_total: toBefore !== null ? toBefore.total : 0, to_prior_timestamp: toBefore !== null ? toBefore.timestamp : 0,
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
        outcome: ATTEMPT_OUTCOMES.includes(pyGet(a, 'outcome')) ? a.outcome : null, server_ended: heldEnd(pyGet(a, 'server_ended')),
        state: o, paid: Object.hasOwn(paid, dealId)}));
      const by = isDict(pyGet(paid, dealId)) ? attemptKey(paid[dealId]) : null;
      const hit = by !== null ? rows.find(r => sameAttemptKey(attemptKey(r), by)) : undefined;
      for (const r of rows) r.paid_by = hit ? hit.ref : null;
      out.push(...rows);
    }
    return out;
  }

  /**
   * paymentAttempts() as `valun attempts list` shows them: each row also has ended_at_server, the state in which the
   * server ended a transfer attempt before it ever reached the tracker (NEVER_APPLIED_TRANSFER), or null. Only a transfer
   * attempt the records classify 'unknown' whose server id they hold is looked up, on a server whose GET /info (read once,
   * when one is) lists circulation/1: GET /transfers/{id} must show it as that attempt of mine. A read that fails, or a
   * transfer shown otherwise or in another state, leaves null. What is shown only: `state` stays the records'
   * classification, which R11 uses, and nothing is recorded (see the Python reference's attempts_overview()).
   */
  async attemptsOverview({edges = null, nowMs = null, doubtful = null} = {}) {
    const rows = this.paymentAttempts({edges, nowMs, doubtful});
    await this.#endedAtServer(rows, null, new Map());
    return rows;
  }

  /** Set ended_at_server on each of `rows`; circulation null: read GET /info when a row needs it; views: reads so far. */
  async #endedAtServer(rows, circulation, views) {
    const ask = rows.filter(r => r.route === 'transfer' && r.state === 'unknown' && truthy(r.attempt_id));
    if (ask.length && circulation === null) {
      try {
        circulation = featuresOf(await this.info()).includes('circulation/1');
      } catch (e) {
        if (!isValunError(e)) throw e;
        circulation = false;
      }
    }
    for (const r of rows) r.ended_at_server = null;
    for (const r of circulation ? ask : []) {
      let t;
      try {
        t = await this.#transferView(r.attempt_id, views);
      } catch (e) {
        if (!isValunError(e)) throw e;
        continue;                                   // not read: shown as the records classify it
      }
      const info = this.#shownTransfer(t, r.attempt_id, r.deal_id);
      if (info !== null && showsAttempt(info, r) && NEVER_APPLIED_TRANSFER.includes(info.state)) r.ended_at_server = info.state;
    }
  }

  /** GET /transfers/{sid}, once per call that passes the same `views`; {} for a 404 or an answer that is not an object. */
  async #transferView(sid, views) {
    if (!views.has(sid)) {
      let t;
      try {
        t = await this.request('GET', `/pilot/v1/transfers/${seg(sid)}`);
      } catch (e) {
        if (!isValunError(e) || e.status !== 404) throw e;
        t = null;
      }
      views.set(sid, isDict(t) ? t : {});
    }
    return views.get(sid);
  }

  /** {timestamp, edge, total, id, state} of a transfer view that shows a transfer of mine as payer for the deal; else null. */
  #shownTransfer(t, sid, dealId) {
    const deal = isDict(pyGet(t, 'deal')) ? t.deal : {};
    const roles = Array.isArray(pyGet(t, 'your_roles')) ? t.your_roles : [];
    const tid = pyGet(t, 'id');
    if (!(truthy(t) && pyGet(deal, 'deal_id') === dealId && roles.includes('payer') && (tid === null || tid === sid))) return null;
    return {...this.#heldOf(t), id: sid, state: serverWord(pyGet(t, 'state'))};
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
    const views = new Map();
    await this.#endedAtServer(rows, circulation, views);    // the rows as attemptsOverview() shows them
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
    else await this.#planTransfer(plan, views);
    return plan;
  }

  /**
   * resolutionPlan() for a transfer with a server id, on a circulation server (GET /transfers/{id}, read once: `views`).
   * An 'unknown' attempt the server shows ended in a NEVER_APPLIED_TRANSFER state gets ended_at_server.
   */
  async #planTransfer(plan, views) {
    const sid = plan.attempt_id;
    let target = plan.attempt;
    const info = this.#shownTransfer(await this.#transferView(sid, views), sid, plan.deal_id);
    const mine = info !== null;
    if (mine && target === null) {
      const found = plan.attempts.filter(r => showsAttempt(info, r));
      plan.attempt = target = found.length === 1 ? found[0] : null;
    }
    if (!mine || (target !== null && !showsAttempt(info, target))) {
      if (target === null) {
        throw new ValunError('unknown_attempt', `the server shows no transfer ${sid} of yours for this deal, and your `
          + 'records hold no attempt with that id; name it as #n from `valun attempts list` (nothing was changed)');
      }
      plan.local = 'server_unknown';
      return;
    }
    plan.transfer = info;
    if (target !== null && target.state === 'unknown' && NEVER_APPLIED_TRANSFER.includes(info.state)) target.ended_at_server = info.state;
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
        if (isValunError(e) && e.status === 409 && e.code === 'payee_edge_not_applied') throw payeeEdgeRefusal(e);
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
   * unless GET /info lists circulation/1. A payer or payee item, which signs a prior acknowledgment PA(...), waits with
   * code feature_unavailable (neither signed nor refused) unless GET /info novation reports the tracker v3.2 contract
   * (novation.CONTRACT). Resolves to {signed: [entry], refused: [entry], waiting: [entry]}, entry =
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
    const problem = role === 'payer' || role === 'payee' ? nv.contractProblem(this.#novation) : null;
    if (problem) {                                // tracker v3.2: a prior slot is signed for that contract only (fail closed)
      return ['waiting', Client.#consentEntry(it, null, {code: 'feature_unavailable', reason: problem + '; nothing was signed or refused'})];
    }
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
    // fix inbox #86: the records keep, with each new state written ahead, the signature made over it (before it is sent,
    // as the write-ahead itself), so they show the after-state this client signed whatever the answer
    await this.#settle(state => Client.#keepSignatures(state, r.write_ahead.pending, sigs));
    let ans;
    try {
      ans = await this.submitConsent(it.id, sigs, revisions);
    } catch (e) {
      if (!isValunError(e)) throw e;
      // refused: the server recorded none of these, unless it holds every one of this client's slots already
      // (already_signed: another consent run sent them), when the entries are the states they sign, and stay (fix inbox
      // #86, review: two runs at once lost the signatures --mine proves a netted edge by)
      if (typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.code !== 'already_signed') {
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
    if (answer === 'applied' && !rejected.length) {   // fix inbox #86: the item applied, so its new states are the edges' now
      await this.#settle(st => this.#appliedStates(st, r.write_ahead.pending, sigs));
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

  /**
   * Fix inbox #86: each new state a consent wrote ahead (pending) keeps, in this client's records, the signature this
   * client just made over it (its slot '<edge>:new'; records.noteSignature): on an edge it issues, the issuer's signature
   * of the state the tracker records once the consent applies; on one it is the creditor of, its consent to it. The
   * Python client's _keep_signatures.
   */
  static #keepSignatures(state, pending, sigs) {
    const recs = recordsIn(state);
    for (const p of pending) {
      const sig = Object.hasOwn(sigs, nv.slotKey(p.pair, 'new')) ? sigs[nv.slotKey(p.pair, 'new')] : null;
      if (sig) records.noteSignature(recs, p.pair, p.total, p.timestamp, p.ref, sig);
    }
  }

  /**
   * Fix inbox #86: a consent the server answered applied: on each edge this client issues, the new state it signed is the
   * edge's confirmed state now, with its own signature, the issuer's (records.confirm; the 0.3 'issued' record follows).
   * On an edge it is the creditor of the new state stays pending, with this client's consent signature, until a read of
   * the edge confirms it (syncEdges). The Python client's _applied_states.
   */
  #appliedStates(state, pending, sigs) {
    for (const p of pending) {
      const sig = Object.hasOwn(sigs, nv.slotKey(p.pair, 'new')) ? sigs[nv.slotKey(p.pair, 'new')] : null;
      if (sig && p.direction === 'out' && p.pair.startsWith(`${this.pubkey}>`)) {
        this.#confirmIn(state, p.pair, {total: p.total, timestamp: p.timestamp, signature: sig});
      }
    }
  }

  // ---------- circulating credit: my edges (PROTOCOL.md 18.14; design 6.1, 11) ----------
  // ---------- settlement on Ergo testnet (the Valun testnet network, valun-testnet-1; js/src/ergo.js) ----------
  // The agent's Ergo address is the P2PK address of its Valun key: its own key signs its own Ergo transactions, the
  // server never holds it. Signing needs ergo-lib (npm i ergo-lib-wasm-nodejs@0.28.0); tERG have no monetary value.

  #onTestnet() {
    if (this.network !== 'valun-testnet-1') throw new ValunError('not_testnet', `settlement on Ergo testnet is for the Valun testnet network (valun-testnet-1); this profile is on ${this.network}`);
    if (!this.pubkey) throw new ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it');
  }

  /** This agent's Ergo testnet address (the P2PK address of its Valun key). */
  ergoAddress() { this.#onTestnet(); return ergo.p2pkAddress(this.pubkey); }

  /** GET /chain: the tracker's anchoring on Ergo testnet (tracker NFT, tracker box, digests) and the explorer links. */
  chain() { return this.request('GET', '/pilot/v1/chain', undefined, {auth: false}); }

  /** GET /reserves: the Basis reserves the network's tracker sees, with their owners' handles. */
  reserves() { return this.request('GET', '/pilot/v1/reserves', undefined, {auth: false}); }

  #ergoNode(chain, nodeUrl) {
    const url = nodeUrl || chain?.node;
    if (typeof url !== 'string' || !url) throw new ValunError('not_configured', 'no Ergo testnet node: GET /chain names none; pass nodeUrl');
    return ergo.nodeClient(url, {fetchImpl: this.#fetch || globalThis.fetch, timeoutMs: this.#timeoutMs});
  }

  /**
   * Lock `ergAmount` nanoERG (0.01 to 2 tERG) of this agent's own tERG in a Basis reserve: the tracker builds the
   * payment request (POST /reserves/create), this client checks it (ergo.checkReservePayload), builds and signs the
   * transaction from plain boxes at its own address, and with `broadcast` sends it to the Ergo testnet node. Without
   * `broadcast` nothing leaves this client: the signed transaction is returned for a look first.
   * Resolves to {broadcast, tx_id, nft_id, reserve_box_id, locked_nanoerg, address, explorer, signed?}.
   */
  async createReserve(ergAmount, {broadcast = false, nodeUrl = undefined} = {}) {
    this.#onTestnet();
    const chain = await this.chain();
    const node = this.#ergoNode(chain, nodeUrl);
    const secretHex = bytesToHex(this.#secretBytes());
    const r = await ergo.buildReserve({secretHex, pubkeyHex: this.pubkey, ergAmount, node, trackerNftId: chain.tracker_nft_id,
      reserveContract: chain.reserve_contract, payloadFor: nftId => this.request('POST', '/pilot/v1/reserves/create', {erg_amount: ergAmount, nft_id: nftId})});
    const out = {broadcast: !!broadcast, tx_id: r.tx_id, nft_id: r.nft_id, reserve_box_id: r.reserve_box_id, locked_nanoerg: r.locked_nanoerg,
      address: ergo.p2pkAddress(this.pubkey), explorer: chain.explorer ? `${chain.explorer}/en/transactions/${r.tx_id}` : null};
    if (!broadcast) return {...out, signed: r.signed};
    await node.broadcast(r.signed);
    return out;
  }

  /**
   * Redeem `amount` nanoERG of the note `issuer` (a participant id or handle) issued to this agent, against the issuer's
   * reserve: the tracker builds the transaction and pays its fee (POST /redemption/build), this client checks it against
   * the boxes as the Ergo node reports them (ergo.checkRedemption: the issuer's reserve, nothing of this agent's own
   * spent, exactly `amount` paid to this agent's address), adds its own proof for the reserve input (ergo.signRedemption:
   * no ergo-lib needed), and with `broadcast` submits it (POST /redemption/submit). Without `broadcast` nothing is
   * submitted (and the tracker's build lapses).
   * Resolves to {broadcast, tx_id, issuer, amount, reserve_box_id, address, explorer, signed?}.
   */
  async redeem(issuer, amount, {broadcast = false} = {}) {
    this.#onTestnet();
    if (typeof issuer !== 'string' || !issuer) throw new ValunError('invalid_field', 'issuer: the participant id or handle of the agent whose note you hold');
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ValunError('invalid_field', 'amount: whole nanoERG to redeem');
    const chain = await this.chain();
    const node = this.#ergoNode(chain, undefined);
    await node.assertTestnet();
    const reserveTree = chain.reserve_contract ? ergo.addressToTree(chain.reserve_contract) : null;
    const built = await this.request('POST', '/pilot/v1/redemption/build', {issuer, amount});
    const issuerPubkey = built?.issuer?.pubkey;
    if (typeof issuerPubkey !== 'string') throw new ValunError('bad_redemption', 'the server named no issuer key');
    // The boxes it spends, as the Ergo node reports them (not the tracker's copies).
    const inputBoxes = await Promise.all((built?.unsigned_tx?.inputs || []).map(i => node.box(i.boxId)));
    const checked = ergo.checkRedemption(built, {issuerPubkey, recipientPubkey: this.pubkey, amount, trackerNftId: chain.tracker_nft_id, reserveTree, inputBoxes});
    const signed = ergo.signRedemption(built, bytesToHex(this.#secretBytes()));
    const out = {broadcast: !!broadcast, tx_id: signed.id ?? null, issuer: built.issuer, amount, reserve_box_id: checked.reserve_box_id,
      address: ergo.p2pkAddress(this.pubkey), explorer: chain.explorer && signed.id ? `${chain.explorer}/en/transactions/${signed.id}` : null};
    if (!broadcast) return {...out, signed};
    const sub = await this.request('POST', '/pilot/v1/redemption/submit', {signed_tx: signed, unsigned_tx: built.unsigned_tx});
    return {...out, tx_id: sub?.tx_id ?? out.tx_id, explorer: sub?.explorer ?? out.explorer};
  }

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
