// Circulating credit, client side: the signing firewall (PROTOCOL.md 15.3; design 4.11 and 6.2; decisions D-1, D-2).
//
// Port of python/src/valun/novation.py, function for function: the same rules, constants, refusal codes, check order,
// summary fields (in the same key order) and write-ahead records, so the Python and the JavaScript client refuse and
// sign exactly the same things and can keep one profile between them. The Python module's docstring is the reference
// for the notation and the rules; the notes here are short.
//
// Pure: no clock, no network, no files. The caller passes the time, its own records and pins, its local consent
// policy, the owner's mandate as GET /me shows it, the edge states it read, and verify(pubkeyHex, msgBytes, sigHex).
// Context and records keys are the JSON keys of the Python client (snake_case): ctx = {me_pk, now_ms, verify, me_id,
// pins, records, signed, transfer_attempts, novated_edges, features, deal, payee_current_pk, approved_quote_digest,
// consent_policy, mandate, issuer_ids, edges}.
//
// Each evaluator returns {ok, code, to_sign, summary, write_ahead}:
//   to_sign      [[slot_key, issuer_pk, recipient_pk, total, ts], ...] (slotMessages rebuilds the bytes: R1)
//   summary      role, kind, id, deal_id, timestamp, amount, edges, your_net_change_PC, your_total_owed_change_PC,
//                quote_digest, advisories, applied, paid_deals, retry_after_ms, needs_read_back, reason
//   write_ahead  (only when ok) {op, signed, pending, attempt, attempts_seen}: persisted with applyWriteAhead BEFORE
//                anything is sent (R9)
// Known JavaScript differences (malformed input only, as in the rest of this package): numbers are safe integers (a
// u64 above 2^53 - 1 is not read), an integer-valued float counts as whole, and the reason of an item that could not
// be read names the JavaScript error type (TypeError where Python may say KeyError or AttributeError).

import * as basis from './basis.js';
import {hexToBytes} from './bytes.js';
import {canonical, sha256Hex, statement} from './protocol.js';
import {PyError, digitsInt, get, isDict, item, iterate, or, pyEq, repr, truthy} from './py.js';
import * as records from './records.js';

// ---------- constants (PROTOCOL.md 18.4, 18.8; design 3.1, 4.3; decision D-1) ----------
export const TRANSFER_MS = 999;
export const SETOFF_MS = 998;
export const BOUND_MS = 997;
export const RESIDUE = Object.freeze({transfer: TRANSFER_MS, setoff: SETOFF_MS, bound: BOUND_MS});
/** ts mod 1000 no ordinary credit note may use. */
export const RESERVED_MS = Object.freeze([995, 996, 997, 998, 999]);
/** The tracker refuses novations and bound notes older than this. */
export const MAX_AGE_MS = 3_600_000;
/** The client's margin beyond MAX_AGE_MS (the server's is 60 000). */
export const FALLBACK_MARGIN_MS = 120_000;
/** What the client starts: T >= now - 10 min. */
export const INITIATE_WINDOW_MS = 600_000;
/** A consent: T >= now - 55 min. */
export const CONSENT_WINDOW_MS = 3_300_000;
/** Both: T <= now + 5 s. */
export const FUTURE_SKEW_MS = 5_000;
/** Every number signed here is a safe integer. */
export const MAX_SAFE_INTEGER = 2 ** 53 - 1;
export const QUOTE_KIND = 'valun-transfer-quote/1';
export const QUOTE_FIELDS = Object.freeze(['network', 'tracker_nft_id', 'denomination', 'deal_id', 'terms_hash',
  'deliverable_sha256', 'issuer_pubkey', 'payer_pubkey', 'payee_pubkey', 'amount']);
export const ROLES = Object.freeze(['payer', 'issuer', 'payee', 'member']);
export const ROUTES = Object.freeze(['note', 'transfer']);
/** records[PAID_DEALS_KEY]: the per-deal paid record (D-1 item 5). */
export const PAID_DEALS_KEY = 'paid_deals';
export const REFUSAL_CODES = Object.freeze([
  // PROTOCOL.md 15.3 (normative)
  'bad_prior_signature', 'timestamp_domain', 'timestamp_reused', 'timestamp_stale', 'not_net_neutral',
  'increase_in_setoff', 'duplicate_edge', 'self_edge', 'not_my_edge', 'total_owed_changes', 'pay_with_is_payee',
  'wrong_destination', 'amount_mismatch', 'deal_mismatch', 'policy_off', 'policy_cap', 'issuer_refused',
  'records_unreadable', 'transfer_window_open', 'bound_note_required', 'pending_unbound_note', 'tracker_mismatch',
  // decision D-1
  'attempt_outcome_unknown', 'already_paid',
  // decision D-2 c, on the client: a novation that would let a bound note of mine apply after it
  'payment_attempt',
  // this module: a quote other than the approved one; an item that is not well formed
  'stale_quote', 'bad_template', 'bad_consent',
]);
/** A deal, transfer or set-off id, the only ids a summary carries. */
export const ID_RE = /^v[dts]_[0-9a-f]{16}$/;
/** = Client RECORDS_KEEP_MS: R4 records are kept this long (provenDead). */
export const RECORDS_KEEP_MS = 604_800_000;

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ABSENT = Object.freeze({total: 0, timestamp: 0});   // the state of an edge that does not exist yet
const UNREADABLE = "this profile's records cannot be read; nothing was signed";

const valueError = message => new PyError('ValueError', message);

/**
 * applyWriteAhead() found the state changed since the evaluation it records (another process signed or paid
 * meanwhile): nothing was written, and nothing may be signed; evaluate again. `code` is the refusal code:
 * timestamp_reused, already_paid or transfer_window_open. (Python: a ValueError subclass.)
 */
export class WriteAheadConflict extends PyError {
  constructor(code, message) {
    super('WriteAheadConflict', `${code}: ${message}`);
    this.code = code;
  }
}

// ---------- small helpers ----------
const nat = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const int = v => typeof v === 'number' && Number.isSafeInteger(v);
const u64 = nat;                                   // what records.js itself accepts (safe integers in JavaScript)
const text = v => typeof v === 'string' && v !== '';
const isPk = v => typeof v === 'string' && PUBKEY_RE.test(v);
const sum = xs => xs.reduce((t, x) => t + x, 0);
const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const key = parts => JSON.stringify(parts);       // a tuple as a Set member

/** Python's % on whole numbers (a non-number raises TypeError, as None % 1000 does). */
function mod(a, n) {
  if (typeof a !== 'number') throw new TypeError(`unsupported operand type for %: ${typeof a}`);
  return ((a % n) + n) % n;
}

/** obj[k] = v, also for k === '__proto__' (a JSON key, never the prototype). */
function put(obj, k, v) {
  if (k === '__proto__') Object.defineProperty(obj, k, {value: v, enumerable: true, writable: true, configurable: true});
  else obj[k] = v;
  return v;
}

function stateShape(s) {
  return isDict(s) && nat(get(s, 'total')) && nat(get(s, 'timestamp')) && text(get(s, 'signature'));
}

function idOf(party) {
  return isDict(party) && text(get(party, 'id')) ? party.id : null;
}

/** A party {id, handle} the item names agrees with an id seen elsewhere (true when either is not given). */
function sameId(party, otherId) {
  const pid = idOf(party);
  otherId ??= null;
  return pid === null || otherId === null || pid === otherId;
}

/** The set of strings in list `v`, or null when `v` is not a list of strings. */
function strSet(v) {
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return null;
  return new Set(v);
}

const intersects = (a, b) => [...a].some(x => b.has(x));

/** Transfers and bound notes stop being usable MAX_AGE_MS after their timestamp; an ordinary note never does. */
function expires(attempt) {
  return get(attempt, 'route') === 'transfer' || mod(get(attempt, 'timestamp', 0), 1000) === BOUND_MS;
}

/** The payment a pending records entry is ('note' or 'transfer'), or null. */
function paymentRoute(p) {
  if (get(p, 'kind') === 'note' && get(p, 'direction') === 'out') return 'note';
  const ref = get(p, 'ref');
  if (get(p, 'kind') === 'transfer' && get(p, 'direction') === 'in' && typeof ref === 'string' && ref.startsWith('vd_')) {
    return 'transfer';
  }
  return null;
}

function pendingEntry(pair, total, timestamp, kind, ref, direction) {
  return {pair, total, timestamp, kind, ref, direction};
}

function attemptRecord(dealId, route, edge, prior, priorTimestamp, priorSignature, total, timestamp, quote) {
  return {deal_id: dealId, route, edge, prior, prior_timestamp: priorTimestamp, prior_signature: priorSignature, total,
    timestamp, quote_digest: quote};
}

/** An attempt record of the shape the evaluators write (transfer_attempts[deal_id][i]); else R9 refuses. */
function attemptOk(a) {
  return isDict(a) && ROUTES.includes(get(a, 'route')) && parseEdge(get(a, 'edge')) !== null && u64(get(a, 'prior'))
    && u64(get(a, 'total')) && u64(get(a, 'timestamp'));
}

/** Did attempts a and b acknowledge exactly the same edge state? False when either recorded no prior state. */
function samePriorState(a, b) {
  if (!(u64(get(a, 'prior_timestamp')) && u64(get(b, 'prior_timestamp')))) return false;
  if (!(pyEq(item(a, 'prior'), item(b, 'prior')) && a.prior_timestamp === b.prior_timestamp)) return false;
  const sa = get(a, 'prior_signature'), sb = get(b, 'prior_signature');
  return !(typeof sa === 'string' && typeof sb === 'string') || sa === sb;
}

/**
 * D-2 a: is `state` (the edge's current state, verified; null when not read) exactly the state `attempt` acknowledged:
 * its total, its timestamp (0: an absent edge) and its signature (when recorded)? An attempt that recorded no prior
 * state is compared by its prior total alone, as D-1 does: true.
 */
export function exactPrior(attempt, state) {
  const pt = get(attempt, 'prior_timestamp');
  if (!u64(pt)) return true;
  state ??= null;
  if (state === null) return false;
  if (pt === 0) return !Object.hasOwn(state, 'signature') && pyEq(item(state, 'timestamp'), 0) && pyEq(item(state, 'total'), 0);
  if (!(pyEq(get(state, 'total'), get(attempt, 'prior')) && pyEq(get(state, 'timestamp'), pt))) return false;
  const sig = get(attempt, 'prior_signature');
  return typeof sig !== 'string' || get(state, 'signature') === sig;
}

/** `v` when it is a Valun deal, transfer or set-off id (^v[dts]_[0-9a-f]{16}$), else null. */
export function shownId(v) {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** [route, edge, total, timestamp] (as Set keys) of every payment attempt of the deal that `state` records. */
function attemptKeys(state, dealId) {
  const keys = new Set();
  const att = get(state, 'transfer_attempts');
  if (isDict(att)) {
    for (const a of iterate(or(get(att, dealId), []))) {
      if (isDict(a)) keys.add(key([get(a, 'route'), get(a, 'edge'), get(a, 'total'), get(a, 'timestamp')]));
    }
  }
  const recs = get(state, 'records');
  if (isDict(recs)) {
    for (const [pair, e] of Object.entries(recs)) {
      if (pair === PAID_DEALS_KEY || !isDict(e) || !Array.isArray(get(e, 'pending'))) continue;
      for (const p of e.pending) {
        const route = isDict(p) ? paymentRoute(p) : null;
        if (route !== null && get(p, 'ref') === dealId) keys.add(key([route, pair, get(p, 'total'), get(p, 'timestamp')]));
      }
    }
  }
  return keys;
}

// ---------- names, messages, digests ----------
/** '<issuer_pk>><recipient_pk>', the key of an edge (records.pairKey). */
export function edgeKey(issuerPk, recipientPk) {
  return records.pairKey(issuerPk, recipientPk);
}

/** [issuer_pk, recipient_pk] of an edge key, or null when `k` is not two public keys joined by '>'. */
export function parseEdge(k) {
  if (typeof k !== 'string') return null;
  const parts = k.split('>');
  if (parts.length !== 2 || !isPk(parts[0]) || !isPk(parts[1])) return null;
  return [parts[0], parts[1]];
}

/** '<edge>:prior' or '<edge>:new'. */
export function slotKey(edge, slot) {
  return `${edge}:${slot}`;
}

/** M(I,R,t,ts): the 80-byte Basis note message, basis.noteMessage() over hex keys and tracker id. */
export function message(issuerPk, recipientPk, total, timestamp, trackerNftId, denomination) {
  return basis.noteMessage(hexToBytes(issuerPk), hexToBytes(recipientPk), total, timestamp, hexToBytes(trackerNftId), denomination);
}

/** {slot_key: M(I,R,t,ts)} for an evaluator's to_sign list, in its order: the only bytes a client signs for it (R1). */
export function slotMessages(toSign, trackerNftId, denomination) {
  const out = {};
  for (const [s, i, r, t, ts] of toSign) put(out, s, message(i, r, t, ts, trackerNftId, denomination));
  return out;
}

/**
 * sha256hex(canonical(Q)), Q = {kind 'valun-transfer-quote/1', network, tracker_nft_id, denomination, deal_id,
 * terms_hash, deliverable_sha256, issuer_pubkey, payer_pubkey, payee_pubkey, amount} (PROTOCOL.md 18.3 item 4).
 * ValueError for fields that are not printable ASCII strings and a positive safe integer amount.
 */
export function quoteDigest(fields) {
  if (!isDict(fields)) throw valueError('quote fields must be a dict');
  const q = {kind: QUOTE_KIND};
  for (const k of QUOTE_FIELDS) {
    const v = get(fields, k);
    if (k === 'amount') {
      if (!(nat(v) && v > 0)) throw valueError('a quote amount is a positive whole number of PC (at most 2^53 - 1)');
    } else if (!(text(v) && /^[ -~]+$/.test(v))) {
      throw valueError(`quote field ${k} must be a non-empty printable ASCII string`);
    }
    q[k] = v;
  }
  return sha256Hex(canonical(q));
}

/** The pay statement of a payment by transfer: 'valun-pilot/pay/1' LF deal_id LF quote_digest. */
export function payStatement(dealId, quoteDigestHex) {
  if (!(text(dealId) && typeof quoteDigestHex === 'string' && HEX64_RE.test(quoteDigestHex))) {
    throw valueError('a pay statement needs a deal id and a 64-hex quote digest');
  }
  return statement('pay', dealId, quoteDigestHex);
}

/**
 * ctx.deal from terms the caller has verified (Client.verifiedAgreement): their hash, the sha256 of the delivery it
 * checked (payer roles), and for the payee whether it delivered on the deal and the transfer the deal view says pays
 * it (deal.payment.transfer_id).
 */
export function dealContext(terms, termsHash, deliverableSha256 = null, delivered = false, transferId = null) {
  const payer = item(terms, 'payer'), payee = item(terms, 'payee');
  return {
    deal_id: item(terms, 'deal_id'), network: item(terms, 'network'), tracker_nft_id: item(terms, 'tracker_nft_id'),
    denomination: item(terms, 'denomination'), terms_hash: termsHash, deliverable_sha256: deliverableSha256 ?? null,
    price: item(item(terms, 'price'), 'amount'),
    payer: {id: item(payer, 'id'), pubkey: item(payer, 'pubkey')},
    payee: {id: item(payee, 'id'), pubkey: item(payee, 'pubkey')},
    delivered: delivered === true, transfer_id: transferId ?? null,
  };
}

// ---------- D-1: payment attempts ----------
/**
 * How an earlier payment attempt stands (decision D-1, with D-2 a). `state` is the current, verified EdgeState of the
 * edge it would change ({total: 0, timestamp: 0} for an absent edge), or null when it was not read. Returns 'applied',
 * 'unknown', 'alive', 'dead' or 'unread' (see the Python docstring).
 */
export function attemptOutcome(attempt, nowMs, state = null) {
  const outcome = get(attempt, 'outcome');
  if (outcome === 'applied') return 'applied';
  const T = item(attempt, 'timestamp'), total = item(attempt, 'total');
  const expired = nowMs > T + MAX_AGE_MS + FALLBACK_MARGIN_MS;
  state ??= null;
  if (state !== null && pyEq(item(state, 'timestamp'), T) && pyEq(item(state, 'total'), total)) return 'applied';
  if (outcome === 'not_applied') {
    if (expires(attempt)) return expired ? 'dead' : 'alive';
    return state !== null && state.timestamp > T ? 'dead' : 'alive';    // an ordinary note never expires
  }
  if (state === null) return expires(attempt) && expired ? 'unread' : 'alive';
  if (state.timestamp >= T) return 'unknown';    // not its new state, at or past its timestamp: it may have applied
  if (!expires(attempt)) return 'alive';
  return expired ? 'dead' : 'alive';
}

// ---------- one evaluation ----------
class Refusal extends Error {
  constructor(code, reason) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}

/** The exceptions Python's evaluators turn into a refusal (TypeError, ValueError, KeyError, AttributeError, ...). */
function readError(e) {
  return e instanceof TypeError || e instanceof RangeError || e instanceof PyError || e instanceof basis.SignatureError;
}

class Run {
  constructor(ctx, itemCode, windowMs) {
    if (!isDict(ctx)) throw valueError('ctx must be a dict');
    if (!isPk(get(ctx, 'me_pk'))) throw valueError("ctx['me_pk'] must be this participant's current public key (66 lowercase hex)");
    if (!nat(get(ctx, 'now_ms'))) throw valueError("ctx['now_ms'] must be the time in ms since the epoch");
    if (typeof get(ctx, 'verify') !== 'function') throw valueError("ctx['verify'] must be verify(pubkey_hex, msg_bytes, sig_hex) -> bool");
    if (get(ctx, 'edges') !== null && !isDict(ctx.edges)) throw valueError("ctx['edges'] must be {edge: EdgeState or None}");
    this.ctx = ctx;
    this.me = ctx.me_pk;
    this.now = ctx.now_ms;
    this.verifyFn = ctx.verify;
    this.itemCode = itemCode;
    this.windowMs = windowMs;
    this.ctxEdges = or(get(ctx, 'edges'), {});
    this.shown = new Map();                    // edge -> the state the item shows (verified), ABSENT for an absent edge
    this.recs = {};
    this.paid = {};
    this.signed = {};
    this.attempts = {};
    this.novated = new Set();
    this.seen = [];                            // [route, edge, total, timestamp] of the deal's attempts weighed (D-1)
    this.summary = {
      role: null, kind: null, id: null, deal_id: null, timestamp: null, amount: null, edges: [],
      your_net_change_PC: null, your_total_owed_change_PC: null, quote_digest: null, advisories: [], applied: [],
      paid_deals: {}, retry_after_ms: null, needs_read_back: [], reason: null,
    };
  }

  // ----- running -----
  execute(fn, it) {
    let toSign, writeAhead, ok, code;
    try {
      [toSign, writeAhead] = fn(this, it);
      ok = true;
      code = null;
    } catch (e) {
      if (e instanceof Refusal) {
        [toSign, writeAhead, ok, code] = [[], null, false, e.code];
        this.summary.reason = e.reason;
      } else if (readError(e)) {
        // a shape the checks did not anticipate: refuse (never sign, never crash a consent loop)
        [toSign, writeAhead, ok, code] = [[], null, false, this.itemCode];
        this.summary.reason = `the item could not be read (${e.name}); nothing was signed`;
      } else {
        throw e;
      }
    }
    const edges = this.summary.edges;
    if (edges.length) {
      const owed = sum(edges.filter(e => e.your_role === 'issuer').map(e => e.change));
      this.summary.your_total_owed_change_PC = owed;
      this.summary.your_net_change_PC = sum(edges.filter(e => e.your_role === 'creditor').map(e => e.change)) - owed;
    }
    return {ok, code, to_sign: toSign, summary: this.summary, write_ahead: writeAhead};
  }

  refuse(code, reason) {
    throw new Refusal(code, reason);
  }

  bad(reason) {
    throw new Refusal(this.itemCode, reason);
  }

  unreadable() {
    throw new Refusal('records_unreadable', UNREADABLE);
  }

  // ----- R9: the records -----
  load() {
    const c = this.ctx;
    const recs = get(c, 'records') === null ? {} : c.records;
    if (!isDict(recs)) this.unreadable();
    const paid = get(recs, PAID_DEALS_KEY) === null ? {} : recs[PAID_DEALS_KEY];
    if (!isDict(paid) || !Object.values(paid).every(v => isDict(v))) this.unreadable();
    const signed = get(c, 'signed') === null ? {} : c.signed;
    if (!isDict(signed) || !Object.values(signed).every(v => isDict(v))) this.unreadable();
    const attempts = get(c, 'transfer_attempts') === null ? {} : c.transfer_attempts;
    if (!isDict(attempts) || !Object.values(attempts).every(v => Array.isArray(v))) this.unreadable();
    let nov = get(c, 'novated_edges');
    if (nov === null) nov = new Set();
    else if (isDict(nov)) nov = new Set(Object.keys(nov));
    else if (Array.isArray(nov) && nov.every(x => typeof x === 'string')) nov = new Set(nov);
    else this.unreadable();
    this.recs = recs;
    this.paid = paid;
    this.signed = signed;
    this.attempts = attempts;
    this.novated = nov;
  }

  /** [confirmed, pending] of this client's record of `pair`. */
  pair(pair) {
    const e = get(this.recs, pair);
    if (e === null) return [null, []];
    if (!isDict(e)) this.unreadable();
    const conf = get(e, 'confirmed');
    let pend = get(e, 'pending');
    if (conf !== null && !(isDict(conf) && u64(get(conf, 'total')) && u64(get(conf, 'timestamp')))) this.unreadable();
    pend = pend === null ? [] : pend;
    if (!Array.isArray(pend) || !pend.every(p => isDict(p) && u64(get(p, 'total')) && u64(get(p, 'timestamp')))) this.unreadable();
    return [conf, pend];
  }

  signedEntry(edge, ts) {
    const per = get(this.signed, edge);
    const e = per !== null ? get(per, String(ts)) : null;
    if (e !== null && !(isDict(e) && typeof get(e, 'op') === 'string' && isDict(get(e, 'slots')))) this.unreadable();
    return e;
  }

  /**
   * Earlier payment attempts for the deal: its attempt records, plus pending payment entries of it in the records
   * that no attempt record covers (their prior follows from the price; null when the price is null).
   */
  dealAttempts(dealId, price) {
    const out = [];
    for (const a of iterate(or(get(this.attempts, dealId), []))) {
      if (!attemptOk(a)) this.unreadable();
      out.push(a);
    }
    for (const pair of Object.keys(this.recs)) {
      if (pair === PAID_DEALS_KEY || parseEdge(pair) === null) continue;
      for (const p of this.pair(pair)[1]) {
        const route = paymentRoute(p);
        if (route === null || get(p, 'ref') !== dealId) continue;
        if (out.some(a => a.route === route && a.edge === pair && a.total === p.total && a.timestamp === p.timestamp)) continue;
        const prior = price === null ? null : route === 'note' ? p.total - price : p.total + price;
        out.push(attemptRecord(dealId, route, pair, prior !== null && prior >= 0 ? prior : null, null, null, p.total, p.timestamp, null));
      }
    }
    return out;
  }

  /** [deal_id, attempt] for every attempt record of mine, of any deal, on `edge` (R9: a malformed one refuses). */
  edgeAttempts(edge) {
    const out = [];
    for (const [dealId, lst] of Object.entries(this.attempts)) {
      for (const a of or(lst, [])) {
        if (isDict(a) && get(a, 'edge') === edge) {
          if (!attemptOk(a)) this.unreadable();
          out.push([dealId, a]);
        }
      }
    }
    return out;
  }

  // ----- R13, R2, R5 -----
  havePins() {
    const p = get(this.ctx, 'pins');
    if (!(isDict(p) && text(get(p, 'tracker_nft_id')) && text(get(p, 'denomination')))) {
      this.refuse('tracker_mismatch', 'this profile has no pinned tracker and unit yet; nothing was signed');
    }
    return p;
  }

  pins(nft, denom) {
    const p = this.havePins();
    if (nft !== p.tracker_nft_id || denom !== p.denomination) {
      this.refuse('tracker_mismatch', 'the item names a tracker or unit other than the ones this profile pinned');
    }
  }

  sameTracker(deal) {
    const p = item(this.ctx, 'pins');
    if (deal.tracker_nft_id !== p.tracker_nft_id || deal.denomination !== p.denomination) {
      this.refuse('tracker_mismatch', "the deal's agreed tracker or unit is not the one this profile pinned");
    }
  }

  /** R2: `state` is the issuer's signature over M(issuer, recipient, total, timestamp) on the pinned tracker. */
  verified(issuer, recipient, state) {
    const p = item(this.ctx, 'pins');
    try {
      const msg = message(issuer, recipient, item(state, 'total'), item(state, 'timestamp'), item(p, 'tracker_nft_id'), item(p, 'denomination'));
      return this.verifyFn(issuer, msg, item(state, 'signature')) === true;
    } catch {
      return false;                               // a verifier that fails accepts nothing
    }
  }

  fresh(ts, befores) {
    if (ts < this.now - this.windowMs || ts > this.now + FUTURE_SKEW_MS) {
      this.refuse('timestamp_stale', `the timestamp ${ts} is not within the window this client signs `
        + `(${Math.floor(this.windowMs / 60000)} minutes back, 5 seconds ahead)`);
    }
    if (befores.some(b => ts <= b)) this.refuse('timestamp_stale', `the timestamp ${ts} is not later than the state it changes`);
  }

  // ----- the deal (payer roles, bound notes, payee) -----
  deal() {
    const d = get(this.ctx, 'deal');
    const ok = isDict(d) && text(get(d, 'deal_id')) && nat(get(d, 'price')) && d.price > 0 && text(get(d, 'terms_hash'))
      && text(get(d, 'network')) && text(get(d, 'tracker_nft_id')) && text(get(d, 'denomination'))
      && isDict(get(d, 'payer')) && isDict(get(d, 'payee')) && text(get(d.payer, 'id')) && text(get(d.payee, 'id'))
      && isPk(get(d.payer, 'pubkey')) && isPk(get(d.payee, 'pubkey'));
    if (!ok) this.refuse('deal_mismatch', 'the deal could not be checked against its verified agreement; nothing was signed');
    return d;
  }

  // ----- what the item shows -----
  /**
   * Register a verified state the item shows. On my own edges: pending entries of mine it shows applied go to
   * summary.applied (and the deals they paid to summary.paid_deals); a state that disagrees with my records is an
   * advisory.
   */
  show(edge, state, mine) {
    this.shown.set(edge, state === null ? ABSENT : state);
    if (!mine) return;
    const [conf, pend] = this.pair(edge);
    const s = this.summary;
    if (state !== null) {
      for (const p of pend) {
        if (!(p.total === state.total && p.timestamp === state.timestamp)) continue;
        s.applied.push({pair: edge, total: p.total, timestamp: p.timestamp, kind: get(p, 'kind'), ref: get(p, 'ref'),
          direction: get(p, 'direction'), state: {total: state.total, timestamp: state.timestamp, signature: state.signature}});
        const route = paymentRoute(p);
        if (route !== null && text(get(p, 'ref')) && !Object.hasOwn(s.paid_deals, p.ref)) {
          put(s.paid_deals, p.ref, {route, edge, total: p.total, timestamp: p.timestamp});
        }
      }
      // D-2 a: a payment attempt of mine whose exact new state the item shows applied, even when its pending entry
      // was forgotten (a refused or failed answer keeps only the attempt record): its deal is paid
      for (const [dealId, a] of this.edgeAttempts(edge)) {
        if (a.total === state.total && a.timestamp === state.timestamp && !Object.hasOwn(s.paid_deals, dealId)) {
          put(s.paid_deals, dealId, {route: a.route, edge, total: a.total, timestamp: a.timestamp});
        }
      }
    }
    if (conf !== null) {
      const shown = state !== null ? state : ABSENT;
      const code = conf.timestamp > shown.timestamp ? 'older_than_records'
        : conf.timestamp === shown.timestamp && conf.total !== shown.total ? 'conflicts_with_records' : null;
      if (code) {
        s.advisories.push({code, edge, shown: {total: shown.total, timestamp: shown.timestamp},
          recorded: {total: conf.total, timestamp: conf.timestamp}});
      }
    }
  }

  addEdge(edge, yourRole, beforeTotal, newTotal, ts) {
    this.summary.edges.push({edge, your_role: yourRole, before_total: beforeTotal, new_total: newTotal,
      change: newTotal - beforeTotal, timestamp: ts});
  }

  /** The current state of `edge` for a D-1 read-back: the item's, else ctx.edges (verified here), else null. */
  stateOf(edge) {
    if (this.shown.has(edge)) return this.shown.get(edge);
    if (!Object.hasOwn(this.ctxEdges, edge)) return null;
    const st = this.ctxEdges[edge];
    if (st === null) return ABSENT;
    const keys = parseEdge(edge);
    if (keys === null || !stateShape(st) || !this.verified(keys[0], keys[1], st)) {
      this.refuse('bad_prior_signature', "an edge state the client read is not its issuer's signature");
    }
    return st;
  }

  // ----- D-1 -----
  notPaidYet(dealId) {
    if (Object.hasOwn(this.paid, dealId)) this.refuse('already_paid', 'your records show this deal is already paid; refusing to pay it again');
  }

  /**
   * The current state of attempt a's edge as a D-1 read-back, or null when there is none: not read; absent although
   * the attempt acknowledged a prior above 0; or older than what this client already knows of the edge. My own
   * confirmed state counts as one once it is at or past the attempt's timestamp.
   */
  readBack(a, conf) {
    let state = this.stateOf(a.edge);
    if (state !== null && !Object.hasOwn(state, 'signature') && !pyEq(get(a, 'prior'), 0)) state = null;
    const floor = Math.max(conf !== null ? conf.timestamp : 0, u64(get(a, 'prior_timestamp')) ? a.prior_timestamp : 0);
    if (state === null || state.timestamp < floor) state = conf !== null && conf.timestamp >= a.timestamp ? conf : null;
    return state;
  }

  /**
   * D-2 a: do my own records prove that attempt `a` (a note of mine whose edge moved past its timestamp to `state`)
   * never applied? Yes when a later bound note of mine on the same edge acknowledged exactly the same prior state and
   * applied, and I signed no other operation than credit notes on that edge between the two.
   */
  provenDead(a, state) {
    const edge = a.edge;
    if (state === null || get(a, 'route') !== 'note' || state.timestamp <= a.timestamp || !u64(get(a, 'prior_timestamp'))
        || a.timestamp < this.now - RECORDS_KEEP_MS) {
      return false;
    }
    for (const [dealId, b] of this.edgeAttempts(edge)) {
      if (b === a || b.route !== 'note' || b.timestamp <= a.timestamp || mod(b.timestamp, 1000) !== BOUND_MS || !samePriorState(a, b)) continue;
      const paid = get(this.paid, dealId);
      const applied = (state.total === b.total && state.timestamp === b.timestamp) || get(b, 'outcome') === 'applied'
        || (isDict(paid) && get(paid, 'edge') === edge && pyEq(get(paid, 'total'), b.total) && pyEq(get(paid, 'timestamp'), b.timestamp));
      if (applied && !this.signedBetween(edge, a.timestamp, b.timestamp)) return true;
    }
    return false;
  }

  /** Did I sign an operation other than a credit note on `edge` at a timestamp strictly between t1 and t2 (R4)? */
  signedBetween(edge, t1, t2) {
    const per = or(get(this.signed, edge), {});
    for (const k of Object.keys(per)) {
      if (/^\p{Nd}+$/u.test(k)) {
        const n = digitsInt(k);
        if (t1 < n && n < t2) {
          const e = this.signedEntry(edge, n);
          if (e !== null && !e.op.startsWith('note:')) return true;
        }
      }
    }
    return false;
  }

  /**
   * [[attempt, outcome, read-back state]] for each earlier payment attempt of the deal, as D-1 and D-2 a weigh it:
   * 'applied' when my own confirmed state of its edge is its new state, or my records hold the deal paid by it; else
   * attemptOutcome() on its read-back, an 'unknown' one my own records prove dead being 'dead'.
   */
  classify(dealId, price) {
    const looked = [];
    const paid = get(this.paid, dealId);
    const paidBy = truthy(paid) ? key([get(paid, 'route'), get(paid, 'edge'), get(paid, 'total'), get(paid, 'timestamp')]) : null;
    for (const a of this.dealAttempts(dealId, price)) {
      const conf = this.pair(a.edge)[0];
      if ((conf !== null && conf.total === a.total && conf.timestamp === a.timestamp)
          || paidBy === key([a.route, a.edge, a.total, a.timestamp])) {
        looked.push([a, 'applied', null]);
        continue;
      }
      const state = this.readBack(a, conf);
      let o = attemptOutcome(a, this.now, state);
      if (o === 'unknown' && this.provenDead(a, state)) o = 'dead';
      looked.push([a, o, state]);
    }
    return looked;
  }

  /**
   * D-1 and D-2 a: refuse a new payment attempt (route, edge, acknowledged prior) for the deal unless every earlier
   * attempt is dead or is excluded by this one at the tracker.
   */
  oneLiveAttempt(dealId, price, route, edge, prior) {
    const s = this.summary;
    this.notPaidYet(dealId);
    if (Object.hasOwn(s.paid_deals, dealId)) {
      this.refuse('already_paid', 'a payment of yours for this deal shows as applied; refusing to pay it again');
    }
    const looked = this.classify(dealId, price);
    this.seen = looked.map(([a]) => [a.route, a.edge, a.total, a.timestamp]);
    for (const [a, o] of looked) {
      if (o === 'applied') {
        put(s.paid_deals, dealId, {route: a.route, edge: a.edge, total: a.total, timestamp: a.timestamp});
        this.refuse('already_paid', 'an earlier payment of yours for this deal applied; refusing to pay it again');
      }
    }
    const same = a => a.route === route && a.edge === edge && pyEq(a.prior, prior);
    if (looked.some(([a, o, st]) => o === 'unknown' || (o === 'alive' && same(a) && !exactPrior(a, st))
        || (o === 'alive' && !expires(a) && !same(a)))) {
      this.refuse('attempt_outcome_unknown', 'an earlier payment attempt for this deal may have applied (or may '
        + 'still apply at any time); only your owner can resolve it, after confirming with the payee');
    }
    const blocking = looked.filter(([a, o]) => (o === 'alive' || o === 'unread') && !same(a));
    if (blocking.length) {
      const waits = blocking.filter(([, o]) => o === 'alive').map(([a]) => a.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS + 1 - this.now);
      s.retry_after_ms = waits.length ? Math.max(...waits) : 0;
      s.needs_read_back = [...new Set(blocking.filter(([, o]) => o === 'unread').map(([a]) => a.edge))].sort();
      this.refuse('transfer_window_open', 'an earlier payment attempt for this deal is not known to be dead yet; a '
        + 'different payment waits until its timestamp + 1 h + 2 min and a read-back');
    }
  }

  /** The quote digest of an earlier transfer attempt for the deal through the same held note, if any. */
  approvedQuote(dealId, heldEdge) {
    let found = null;
    for (const a of iterate(or(get(this.attempts, dealId), []))) {
      if (isDict(a) && get(a, 'route') === 'transfer' && get(a, 'edge') === heldEdge && typeof get(a, 'quote_digest') === 'string') {
        found = a.quote_digest;
      }
    }
    return found;
  }

  // ----- R8 -----
  policy(localFlag, mandateFlag) {
    let p = get(this.ctx, 'consent_policy');
    p = isDict(p) ? p : {};
    if (get(p, localFlag) !== true) {
      this.refuse('policy_off', `your local consent policy does not sign this role by itself (${localFlag} is off)`);
    }
    const m = get(this.ctx, 'mandate');
    if (!isDict(m) || get(m, mandateFlag) !== true) this.refuse('policy_off', `your owner's mandate does not allow this (${mandateFlag} is not on)`);
    return [p, m];
  }

  cap(p, amount) {
    const cap = get(p, 'max_PC');
    if (cap !== null && (!nat(cap) || amount > cap)) {
      this.refuse('policy_cap', `${amount} PC is above the cap your local consent policy sets for one consent`);
    }
  }

  /**
   * R8's issuer lists, local (participant ids or public keys) and the mandate's (participant ids), checked against the
   * issuer's key and the participant id this client resolved for that key itself (ctx.issuer_ids), never an id the
   * item names.
   */
  issuerAccepted(p, m, issuerPk, itemIssuerId) {
    const ids = get(this.ctx, 'issuer_ids');
    let resolved = isDict(ids) ? get(ids, issuerPk) : null;
    resolved = text(resolved) ? resolved : null;
    itemIssuerId ??= null;
    if (itemIssuerId !== null && resolved !== null && itemIssuerId !== resolved) {
      this.refuse('issuer_refused', 'the item names another participant as the issuer than the directory lists for '
        + "the issuer's key");
    }
    const names = new Set([issuerPk, ...(resolved ? [resolved] : [])]);
    const refused = get(p, 'refuse_issuers'), accepted = get(p, 'accept_issuers');
    const mRefused = get(m, 'refuse_notes_from'), mAccepted = get(m, 'accept_notes_from');
    let ok = true;
    if (refused !== null) {
      const s = strSet(refused);
      ok = ok && s !== null && !intersects(s, names) && (resolved !== null || [...s].every(isPk));
    }
    if (accepted !== null && accepted !== 'any') {
      const s = strSet(accepted);
      ok = ok && s !== null && intersects(s, names);
    }
    if (mRefused !== null) {
      const s = strSet(mRefused);
      ok = ok && s !== null && (s.size === 0 || (resolved !== null && !s.has(resolved)));
    }
    if (mAccepted !== 'any') {
      const s = strSet(mAccepted);
      ok = ok && s !== null && resolved !== null && s.has(resolved);
    }
    if (!ok) {
      this.refuse('issuer_refused', 'your policy or your owner does not accept notes from this issuer (as the '
        + 'directory names it)');
    }
  }

  // ----- R12, R4 -----
  /** R12: an ordinary note of mine that can still apply (later than the edge's state shown) blocks a novation. */
  noPendingUnbound(edges) {
    for (const edge of edges) {
      const after = (this.shown.has(edge) ? this.shown.get(edge) : ABSENT).timestamp;
      for (const p of this.pair(edge)[1]) {
        if (get(p, 'kind') === 'note' && get(p, 'direction') === 'out' && mod(p.timestamp, 1000) < RESERVED_MS[0] && p.timestamp > after) {
          this.refuse('pending_unbound_note', 'you hold an unapplied ordinary credit note on this edge; a '
            + 'novation is signed only once it is settled either way');
        }
      }
    }
  }

  /**
   * R12 extended, the client side of decision D-2 c: never sign a novation that sets an edge of mine (as issuer) to
   * the acknowledged prior total of a bound note of mine on that edge that is later than the novation and can still
   * apply. `changes`: [[edge, new_total, timestamp]] of the novation's edges where I am the issuer.
   */
  noBoundNoteRestored(changes) {
    for (const [edge, newTotal, ts] of changes) {
      for (const [dealId, b] of this.edgeAttempts(edge)) {
        if (b.route !== 'note' || mod(b.timestamp, 1000) !== BOUND_MS || b.timestamp <= ts
            || this.now > b.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS || get(b, 'outcome') === 'applied') {
          continue;
        }
        const paid = get(this.paid, dealId);
        if (isDict(paid) && get(paid, 'edge') === edge && pyEq(get(paid, 'total'), b.total) && pyEq(get(paid, 'timestamp'), b.timestamp)) continue;
        if (pyEq(b.prior, newTotal)) {
          this.refuse('payment_attempt', 'this would bring your edge back to the prior a bound credit note of '
            + 'yours acknowledged, which could then still apply; it is signed only once that note is past its maximum age');
        }
      }
    }
  }

  noReuse(op, slots) {
    const groups = new Map(), order = [];
    for (const [s, i, r, total, ts] of slots) {
      const e = edgeKey(i, r), k = key([e, ts]);
      if (!groups.has(k)) {
        groups.set(k, {edge: e, ts, slots: {}});
        order.push(k);
      }
      put(groups.get(k).slots, s, total);
    }
    for (const k of order) {
      const g = groups.get(k);
      const have = this.signedEntry(g.edge, g.ts);
      if (have !== null && (have.op !== op || !pyEq(have.slots, g.slots))) {
        this.refuse('timestamp_reused', 'you already signed another operation at this edge and timestamp');
      }
    }
    return order.map(k => {
      const g = groups.get(k);
      return {edge: g.edge, timestamp: g.ts, op, slots: {...g.slots}};
    });
  }

  boundAdvertised() {
    const f = get(this.ctx, 'features');
    return Array.isArray(f) && f.includes('bound_notes/1');
  }
}

// ---------- bound credit notes ----------
/**
 * Check a bound credit-note template (GET credit-note-template?prior=1&bound=1; PROTOCOL.md 18.5) for paying deal
 * ctx.deal with this client's own note. On ok, to_sign is the prior acknowledgment and the note.
 */
export function evaluateBoundTemplate(tpl, ctx) {
  return new Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(bound, tpl);
}

function bound(run, tpl) {
  const s = run.summary;
  s.role = 'payer';
  s.kind = 'bound_note';
  run.load();
  if (!isDict(tpl)) run.bad('the credit-note template is not a JSON object');
  const D = get(tpl, 'deal_id'), I = get(tpl, 'issuer_pubkey'), R = get(tpl, 'recipient_pubkey');
  const P = get(tpl, 'prior_total'), price = get(tpl, 'price'), total = get(tpl, 'total'), ts = get(tpl, 'timestamp');
  const nft = get(tpl, 'tracker_nft_id'), denom = get(tpl, 'denomination');
  if (!(text(D) && isPk(I) && isPk(R) && nat(P) && nat(price) && price > 0 && nat(total) && nat(ts) && text(nft) && text(denom))) {
    run.bad('the credit-note template is missing a field or has one of the wrong type');
  }
  if (!Object.hasOwn(tpl, 'prior_note') || (tpl.prior_note !== null && !stateShape(tpl.prior_note))) {
    run.bad('a bound template carries prior_note: the edge state {total, timestamp, signature}, or null');
  }
  for (const k of ['terms_hash', 'deliverable_sha256']) {
    if (get(tpl, k) !== null && !text(tpl[k])) run.bad(`the template field ${k} is not a string`);
  }
  const prior = tpl.prior_note;
  if (prior === null && P !== 0) run.bad('the template shows no prior note but a prior total above 0');
  if (prior !== null && prior.total !== P) run.bad("the template's prior note does not match its prior total");
  s.deal_id = shownId(D);
  s.timestamp = ts;
  s.amount = price;
  run.notPaidYet(D);
  run.pins(nft, denom);
  const deal = run.deal();
  run.sameTracker(deal);
  const meId = get(run.ctx, 'me_id');
  const th = get(tpl, 'terms_hash'), dh = get(tpl, 'deliverable_sha256');
  if (D !== deal.deal_id || !(th === null || th === deal.terms_hash) || !(dh === null || dh === get(deal, 'deliverable_sha256'))
      || !text(meId) || deal.payer.id !== meId) {
    run.refuse('deal_mismatch', 'the template is not for the deal, terms and delivery you are paying (as the payer)');
  }
  if (I !== run.me) run.refuse('not_my_edge', 'the template is not for a credit note from your key');
  const payeeNow = get(run.ctx, 'payee_current_pk');
  if (!isPk(payeeNow) || R !== payeeNow) run.refuse('wrong_destination', "the template's recipient is not the payee's current key");
  const edge = edgeKey(I, R);
  if (ts % 1000 !== BOUND_MS) {
    if (run.novated.has(edge) || run.boundAdvertised()) run.refuse('bound_note_required', 'this edge takes bound credit notes only (residue 997)');
    run.refuse('timestamp_domain', `a bound credit note has a timestamp ending in 997 ms, not ${ts % 1000}`);
  }
  if (price !== deal.price || total !== P + price) run.refuse('amount_mismatch', `the note must add exactly the agreed price (${deal.price} PC)`);
  if (prior !== null && !run.verified(I, R, prior)) run.refuse('bad_prior_signature', 'the prior note shown is not signed by your key');
  run.fresh(ts, prior === null ? [] : [prior.timestamp]);
  run.show(edge, prior, true);
  run.addEdge(edge, 'issuer', P, total, ts);
  run.oneLiveAttempt(D, deal.price, 'note', edge, P);
  const op = 'note:' + D;
  const slots = [[slotKey(edge, 'prior'), I, R, P, ts], [slotKey(edge, 'new'), I, R, total, ts]];
  const signed = run.noReuse(op, slots);
  return [slots, {
    op, signed, pending: [pendingEntry(edge, total, ts, 'note', D, 'out')],
    attempt: attemptRecord(D, 'note', edge, P, prior === null ? 0 : prior.timestamp, prior === null ? null : prior.signature, total, ts, null),
    attempts_seen: run.seen,
  }];
}

// ---------- paying with a held note ----------
/**
 * Check a transfer template (GET /deals/:id/transfer-template; PROTOCOL.md 18.6 step 2) for paying deal ctx.deal
 * with a note this client holds. On ok, summary.quote_digest is the digest to sign in the pay statement.
 */
export function evaluatePayerTemplate(tpl, ctx) {
  return new Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(payerTemplate, tpl);
}

function payerTemplate(run, tpl) {
  const s = run.summary;
  s.role = 'payer';
  s.kind = 'transfer';
  run.load();
  if (!isDict(tpl)) run.bad('the transfer template is not a JSON object');
  const [iss, pay, pee, fe, te] = ['issuer', 'payer', 'payee', 'from_edge', 'to_edge'].map(k => get(tpl, k));
  const ok = [iss, pay, pee].every(x => isDict(x) && isPk(get(x, 'pubkey')))
    && isDict(fe) && isDict(te) && nat(get(fe, 'new_total')) && nat(get(te, 'new_total'))
    && (get(fe, 'before') === null || stateShape(fe.before))
    && (get(te, 'before') === null || stateShape(te.before))
    && text(get(tpl, 'deal_id')) && text(get(tpl, 'terms_hash')) && text(get(tpl, 'deliverable_sha256'))
    && nat(get(tpl, 'amount')) && tpl.amount > 0 && nat(get(tpl, 'timestamp'))
    && text(get(tpl, 'tracker_nft_id')) && text(get(tpl, 'denomination'))
    && (get(tpl, 'quote_digest') === null || text(tpl.quote_digest));
  if (!ok) run.bad('the transfer template is missing a field or has one of the wrong type');
  const v = {
    deal_id: tpl.deal_id, terms_hash: tpl.terms_hash, deliverable: tpl.deliverable_sha256,
    A: iss.pubkey, A_id: idOf(iss), B: pay.pubkey, B_id: idOf(pay), C: pee.pubkey, C_id: idOf(pee), amount: tpl.amount,
    T: tpl.timestamp, from_before: get(fe, 'before'), from_new: fe.new_total, to_before: get(te, 'before'),
    to_new: te.new_total, server_quote: get(tpl, 'quote_digest'), nft: tpl.tracker_nft_id, denom: tpl.denomination,
    signed_by_you: new Set(),
  };
  return payer(run, v, false);
}

/** The payer's rules, for a template it asked for and for a regenerated transfer it is shown as a consent. */
function payer(run, v, consent) {
  const s = run.summary, me = run.me;
  const D = v.deal_id, A = v.A, C = v.C, a = v.amount, T = v.T;
  s.deal_id = shownId(D);
  s.timestamp = T;
  s.amount = a;
  run.notPaidYet(D);
  run.pins(v.nft, v.denom);
  const deal = run.deal();
  run.sameTracker(deal);
  const meId = get(run.ctx, 'me_id');
  if (D !== deal.deal_id || v.terms_hash !== deal.terms_hash || !text(get(deal, 'deliverable_sha256'))
      || (v.deliverable !== null && v.deliverable !== deal.deliverable_sha256)
      || !text(meId) || deal.payer.id !== meId
      || (v.B_id !== null && v.B_id !== deal.payer.id)) {
    run.refuse('deal_mismatch', 'this payment is not for the deal, terms and delivery you accepted as payer');
  }
  if (v.B !== me) run.refuse('not_my_edge', 'the held note is not on an edge to your key');
  const payeeNow = get(run.ctx, 'payee_current_pk');
  if (A === me) run.refuse('self_edge', 'you cannot pay with a note you issued yourself');
  if ([C, deal.payee.pubkey, payeeNow].includes(A) || (v.A_id !== null && v.A_id === deal.payee.id)) {
    run.refuse('pay_with_is_payee', 'the issuer of the note is the payee itself; a set-off would clear it instead');
  }
  if (!isPk(payeeNow) || C !== payeeNow || (v.C_id !== null && v.C_id !== deal.payee.id)) {
    run.refuse('wrong_destination', "the destination is not the payee's current key");
  }
  if (a !== deal.price) run.refuse('amount_mismatch', `the amount must be the agreed price (${deal.price} PC)`);
  if (T % 1000 !== TRANSFER_MS) run.refuse('timestamp_domain', `a transfer has a timestamp ending in 999 ms, not ${T % 1000}`);
  const fb = v.from_before, tb = v.to_before;
  if (fb === null || fb.total < a || v.from_new !== fb.total - a) {
    run.refuse('amount_mismatch', `your held claim must fall by exactly ${a} PC (and cover it)`);
  }
  const X = fb.total, Y = tb !== null ? tb.total : 0;
  if (v.to_new !== Y + a) run.refuse('amount_mismatch', `the payee's claim must rise by exactly ${a} PC`);
  if (!run.verified(A, me, fb) || (tb !== null && !run.verified(A, C, tb))) {
    run.refuse('bad_prior_signature', "an edge state shown is not the issuer's signature");
  }
  run.fresh(T, [fb.timestamp, ...(tb !== null ? [tb.timestamp] : [])]);
  const held = edgeKey(A, me), dest = edgeKey(A, C);
  run.show(held, fb, true);
  run.show(dest, tb, false);
  run.addEdge(held, 'creditor', X, X - a, T);
  run.addEdge(dest, 'payer', Y, Y + a, T);
  run.oneLiveAttempt(D, deal.price, 'transfer', held, X);
  const q = quoteDigest({network: deal.network, tracker_nft_id: v.nft, denomination: v.denom, deal_id: D,
    terms_hash: deal.terms_hash, deliverable_sha256: deal.deliverable_sha256, issuer_pubkey: A, payer_pubkey: me,
    payee_pubkey: C, amount: a});
  s.quote_digest = q;
  if (v.server_quote !== null && v.server_quote !== q) {
    run.bad("the server's quote digest is not the one this client computes from the checked values");
  }
  let approved = get(run.ctx, 'approved_quote_digest');
  if (approved === null && consent) approved = run.approvedQuote(D, held);
  if ((consent && approved === null) || (approved !== null && approved !== q)) {
    run.refuse('stale_quote', 'this payment is not the one your owner approved (the quote changed)');
  }
  const m = get(run.ctx, 'mandate');
  if (!isDict(m)) run.refuse('policy_off', "your owner's mandate could not be read, so nothing is paid with a held note");
  if (get(m, 'pay_with_held_notes') === 'never') run.refuse('policy_off', "your owner's mandate does not allow paying with held notes");
  const op = 'pay:' + D;
  const slots = [[slotKey(held, 'prior'), A, me, X, T], [slotKey(held, 'new'), A, me, X - a, T], [slotKey(dest, 'new'), A, C, Y + a, T]];
  const signed = run.noReuse(op, slots);
  return [slots.filter(x => !v.signed_by_you.has(x[0])), {
    op, signed, pending: [pendingEntry(held, X - a, T, 'transfer', D, 'in')],
    attempt: attemptRecord(D, 'transfer', held, X, fb.timestamp, fb.signature, X - a, T, q),
    attempts_seen: run.seen,
  }];
}

// ---------- consents ----------
/**
 * Check one GET /consents item (PROTOCOL.md 18.9) for the role it gives this client: payer (a regenerated transfer),
 * issuer, payee or member (a set-off). A refused consent is refused at the server with the code as its reason.
 */
export function evaluateConsent(it, ctx) {
  return new Run(ctx, 'bad_consent', CONSENT_WINDOW_MS).execute(consentRun, it);
}

function consentRun(run, it) {
  const s = run.summary;
  run.load();
  if (!isDict(it)) run.bad('the consent item is not a JSON object');
  const kind = get(it, 'kind'), iid = get(it, 'id'), roles = get(it, 'your_roles');
  if (!['transfer', 'setoff'].includes(kind) || !text(iid)) run.bad('a consent item is a transfer or a set-off with an id');
  s.kind = kind;
  s.id = shownId(iid);
  if (!(Array.isArray(roles) && roles.length === 1 && ROLES.includes(roles[0]))) run.bad('a consent item gives exactly one role of yours');
  const role = s.role = roles[0];
  if ((kind === 'setoff') !== (role === 'member')) run.bad('the role does not fit the kind of consent');
  if (get(it, 'state') !== 'collecting') run.bad('the item is not collecting signatures');
  const nft = get(it, 'tracker_nft_id'), denom = get(it, 'denomination');
  const context = get(it, 'context') === null ? {} : it.context;
  if (!(text(nft) && text(denom) && isDict(context))) run.bad('the consent item is missing its tracker, unit or context');
  const edges = consentEdges(run, it);
  run.pins(nft, denom);
  return {member, issuer, payee, payer: payerConsent}[role](run, it, edges, context);
}

function consentEdges(run, it) {
  const raw = get(it, 'edges');
  if (!Array.isArray(raw) || !raw.length || raw.length > 64) run.bad('a consent item lists between 1 and 64 of your edges');
  const out = [];
  for (const e of raw) {
    const keys = isDict(e) ? parseEdge(get(e, 'edge')) : null;
    if (keys === null) run.bad('an edge is not "<issuer_pubkey>><recipient_pubkey>"');
    const before = get(e, 'before'), nw = get(e, 'new_total'), ts = get(e, 'timestamp'), rev = get(e, 'revision');
    const change = get(e, 'change'), slots = get(e, 'slots');
    const done = get(e, 'signed_by_you') === null ? [] : e.signed_by_you;
    if (!((before === null || stateShape(before)) && nat(nw) && nat(ts) && nat(rev) && int(change)
        && Array.isArray(slots) && slots.length && slots.every(x => x === 'prior' || x === 'new')
        && new Set(slots).size === slots.length && Array.isArray(done) && done.every(x => slots.includes(x))
        && ['issuer', 'creditor', 'payer'].includes(get(e, 'your_role')))) {
      run.bad('an edge of the item is missing a field or has one of the wrong type');
    }
    if (change !== nw - (before !== null ? before.total : 0)) run.bad("an edge's change is not its new total minus its prior total");
    out.push({edge: e.edge, I: keys[0], R: keys[1], before, new: nw, ts, slots: [...slots], done: new Set(done),
      your_role: e.your_role, issuer_id: idOf(get(e, 'issuer')), recipient_id: idOf(get(e, 'recipient'))});
  }
  return out;
}

const beforeTotal = e => (e.before !== null ? e.before.total : 0);
const doneSlots = es => new Set(es.flatMap(e => [...e.done].map(x => slotKey(e.edge, x))));

function member(run, it, edges, context) {
  const me = run.me, s = run.summary;
  if (edges.some(e => !arrEq(e.slots, ['new']) || e.before === null)) run.bad('a set-off edge is an existing edge with one slot, new');
  const seen = new Set();
  for (const e of edges) {
    if (e.I === e.R) run.refuse('self_edge', 'a set-off edge from a key to itself');
    if (me !== e.I && me !== e.R) run.refuse('not_my_edge', 'the item shows an edge you are not a party to');
    if (seen.has(e.edge)) run.refuse('duplicate_edge', 'the item shows the same edge twice');
    seen.add(e.edge);
  }
  if (edges.some(e => e.your_role !== (e.I === me ? 'issuer' : 'creditor'))) run.bad('the role the item gives you on an edge does not fit its keys');
  for (const e of edges) {
    if (e.ts % 1000 !== SETOFF_MS) run.refuse('timestamp_domain', `a set-off edge has a timestamp ending in 998 ms, not ${e.ts % 1000}`);
  }
  for (const e of edges) if (e.new >= e.before.total) run.refuse('increase_in_setoff', 'a set-off only lowers edges');
  const asCreditor = sum(edges.filter(e => e.R === me).map(e => e.before.total - e.new));
  const asIssuer = sum(edges.filter(e => e.I === me).map(e => e.before.total - e.new));
  if (asCreditor !== asIssuer) run.refuse('not_net_neutral', `your claims would fall by ${asCreditor} PC and your debts by ${asIssuer} PC`);
  for (const e of edges) {
    if (!run.verified(e.I, e.R, e.before)) run.refuse('bad_prior_signature', "an edge state shown is not its issuer's signature");
  }
  for (const e of edges) run.fresh(e.ts, [e.before.timestamp]);
  for (const e of edges) {
    run.show(e.edge, e.before, true);
    run.addEdge(e.edge, e.I === me ? 'issuer' : 'creditor', e.before.total, e.new, e.ts);
  }
  s.amount = asCreditor;
  s.timestamp = edges.every(e => e.ts === edges[0].ts) ? edges[0].ts : null;
  const [p] = run.policy('setoff', 'auto_clear');
  run.cap(p, asCreditor);
  run.noPendingUnbound(edges.filter(e => e.I === me).map(e => e.edge));
  run.noBoundNoteRestored(edges.filter(e => e.I === me).map(e => [e.edge, e.new, e.ts]));
  const op = 'setoff:' + it.id;
  const slots = edges.map(e => [slotKey(e.edge, 'new'), e.I, e.R, e.new, e.ts]);
  const signed = run.noReuse(op, slots);
  const done = doneSlots(edges);
  const pending = edges.map(e => pendingEntry(e.edge, e.new, e.ts, 'setoff', it.id, e.I === me ? 'out' : 'in'));
  return [slots.filter(x => !done.has(x[0])), {op, signed, pending, attempt: null, attempts_seen: []}];
}

function issuer(run, it, edges, context) {
  const me = run.me, s = run.summary;
  const a = get(context, 'amount');
  if (edges.length !== 2 || edges.some(e => e.your_role !== 'issuer' || !arrEq(e.slots, ['new']))
      || edges[0].ts !== edges[1].ts || !(nat(a) && a > 0)) {
    run.bad('an issuer consent shows its two edges, one slot (new) each, one timestamp, and the amount');
  }
  const T = edges[0].ts;
  s.timestamp = T;
  s.amount = a;
  for (const e of edges) {
    if (e.I !== me) run.refuse('not_my_edge', 'an edge of the transfer is not yours as issuer');
    if (e.R === me) run.refuse('self_edge', 'a transfer edge from your key to itself');
  }
  if (edges[0].edge === edges[1].edge) run.refuse('duplicate_edge', 'the item shows the same edge twice');
  if (T % 1000 !== TRANSFER_MS) run.refuse('timestamp_domain', `a transfer has a timestamp ending in 999 ms, not ${T % 1000}`);
  const dec = edges.filter(e => e.before !== null && e.new < e.before.total);
  const inc = edges.filter(e => e.new > beforeTotal(e));
  if (dec.length !== 1 || inc.length !== 1) {
    run.refuse('total_owed_changes', 'a transfer lowers one of your edges and raises the other by the same amount');
  }
  const fe = dec[0], te = inc[0];
  if (fe.before.total - fe.new !== a || te.new - beforeTotal(te) !== a) {
    run.refuse('total_owed_changes', `your total owed would change: both edges must move exactly ${a} PC`);
  }
  if (!(sameId(get(context, 'payer'), fe.recipient_id) && sameId(get(context, 'payee'), te.recipient_id))) {
    run.bad('the item names creditors other than the ones its edges are to');
  }
  if ([fe, te].some(e => e.before !== null && !run.verified(me, e.R, e.before))) {
    run.refuse('bad_prior_signature', 'an edge state shown is not signed by your key');
  }
  run.fresh(T, [fe, te].filter(e => e.before !== null).map(e => e.before.timestamp));
  for (const e of [fe, te]) {
    run.show(e.edge, e.before, true);
    run.addEdge(e.edge, 'issuer', beforeTotal(e), e.new, T);
  }
  const [p] = run.policy('as_issuer', 'novate_own_debt');
  run.cap(p, a);
  run.noPendingUnbound([fe.edge, te.edge]);
  run.noBoundNoteRestored([[fe.edge, fe.new, T], [te.edge, te.new, T]]);
  const op = 'transfer:' + it.id;
  const slots = [[slotKey(fe.edge, 'new'), me, fe.R, fe.new, T], [slotKey(te.edge, 'new'), me, te.R, te.new, T]];
  const signed = run.noReuse(op, slots);
  const done = doneSlots([fe, te]);
  const pending = [fe, te].map(e => pendingEntry(e.edge, e.new, T, 'transfer', it.id, 'out'));
  return [slots.filter(x => !done.has(x[0])), {op, signed, pending, attempt: null, attempts_seen: []}];
}

function payee(run, it, edges, context) {
  const me = run.me, s = run.summary;
  const a = get(context, 'amount'), cd = get(context, 'deal');
  if (edges.length !== 1 || edges[0].your_role !== 'creditor' || !arrEq([...edges[0].slots].sort(), ['new', 'prior'])
      || !(nat(a) && a > 0)) {
    run.bad('a payee consent shows its one edge, two slots (prior and new), and the amount');
  }
  const e = edges[0];
  const T = e.ts;
  s.timestamp = T;
  s.amount = a;
  if (e.R !== me) run.refuse('not_my_edge', 'the edge is not to your key');
  if (e.I === me) run.refuse('self_edge', 'a transfer edge from your key to itself');
  const deal = run.deal();
  s.deal_id = shownId(deal.deal_id);
  run.sameTracker(deal);
  const Y = beforeTotal(e);
  const meId = get(run.ctx, 'me_id');
  if (!(isDict(cd) && get(cd, 'deal_id') === deal.deal_id && get(cd, 'terms_hash') === deal.terms_hash
      && pyEq(Object.hasOwn(cd, 'price') ? cd.price : a, a) && deal.price === a && e.new === Y + a
      && deal.payee.pubkey === me && (meId === null || deal.payee.id === meId)
      && get(deal, 'delivered') === true && get(deal, 'transfer_id') === it.id
      && sameId(get(context, 'payer'), deal.payer.id))) {
    run.refuse('deal_mismatch', 'this transfer does not pay a deal you delivered on as payee, by exactly its price');
  }
  if (T % 1000 !== TRANSFER_MS) run.refuse('timestamp_domain', `a transfer has a timestamp ending in 999 ms, not ${T % 1000}`);
  if (e.before !== null && !run.verified(e.I, me, e.before)) run.refuse('bad_prior_signature', "the edge state shown is not the issuer's signature");
  run.fresh(T, e.before !== null ? [e.before.timestamp] : []);
  run.show(e.edge, e.before, true);
  run.addEdge(e.edge, 'creditor', Y, e.new, T);
  const [p, m] = run.policy('as_new_creditor', 'accept_transfers');
  if (get(m, 'may_accept_credit') === false) run.refuse('policy_off', "your owner's mandate does not allow accepting credit");
  run.issuerAccepted(p, m, e.I, or(e.issuer_id, idOf(get(context, 'issuer'))));
  run.cap(p, a);
  const cap = get(m, 'max_accept_per_issuer');
  if (cap !== null && (!nat(cap) || Y + a > cap)) {
    run.refuse('policy_cap', `your claim on this issuer would be ${Y + a} PC, above max_accept_per_issuer`);
  }
  const op = 'transfer:' + it.id;
  const slots = [[slotKey(e.edge, 'prior'), e.I, me, Y, T], [slotKey(e.edge, 'new'), e.I, me, e.new, T]];
  const signed = run.noReuse(op, slots);
  const done = doneSlots([e]);
  return [slots.filter(x => !done.has(x[0])), {
    op, signed, pending: [pendingEntry(e.edge, e.new, T, 'transfer', it.id, 'in')], attempt: null, attempts_seen: [],
  }];
}

function payerConsent(run, it, edges, context) {
  const me = run.me;
  const cd = get(context, 'deal'), a = get(context, 'amount');
  if (edges.length !== 2 || !(isDict(cd) && text(get(cd, 'deal_id')) && text(get(cd, 'terms_hash'))
      && nat(a) && a > 0 && pyEq(Object.hasOwn(cd, 'price') ? cd.price : a, a)
      && (get(cd, 'quote_digest') === null || text(cd.quote_digest)))) {
    run.bad('a payer consent shows the held edge, the destination edge, the deal and the amount it pays');
  }
  const held = edges.filter(e => e.R === me);
  if (held.length !== 1) run.refuse('not_my_edge', 'the item does not show exactly one held edge to your key');
  const fe = held[0];
  const te = edges[0] === fe ? edges[1] : edges[0];
  if (fe.your_role !== 'creditor' || !arrEq([...fe.slots].sort(), ['new', 'prior']) || te.your_role !== 'payer'
      || !arrEq(te.slots, ['new']) || te.I !== fe.I || te.ts !== fe.ts) {
    run.bad('a payer signs prior and new on its held edge and new on the destination, one issuer, one timestamp');
  }
  const v = {
    deal_id: cd.deal_id, terms_hash: cd.terms_hash, deliverable: null,
    A: fe.I, A_id: or(fe.issuer_id, idOf(get(context, 'issuer'))), B: me, B_id: idOf(get(context, 'payer')),
    C: te.R, C_id: or(te.recipient_id, idOf(get(context, 'payee'))), amount: a, T: fe.ts,
    from_before: fe.before, from_new: fe.new, to_before: te.before, to_new: te.new,
    server_quote: get(cd, 'quote_digest'), nft: it.tracker_nft_id, denom: it.denomination,
    signed_by_you: doneSlots([fe, te]),
  };
  return payer(run, v, true);
}

// ---------- helpers for the caller's records (no clock: signedAt is passed in) ----------
function sub(state, k) {
  let v = get(state, k);
  if (v === null) v = put(state, k, {});
  if (!isDict(v)) throw valueError(`records_unreadable: state[${repr(k)}] is not a JSON object`);
  return v;
}

/**
 * R9: record in the client's state (in place) what an evaluation is about to sign, before anything is sent:
 * state.signed (R4), the pending entries in state.records and the payment attempt in state.transfer_attempts[deal_id]
 * (D-1). Run it inside the store's update(), on the state the evaluation read. Idempotent. It writes nothing when the
 * state changed since the evaluation (WriteAheadConflict timestamp_reused, already_paid or transfer_window_open).
 * ValueError (records_unreadable) for a record that is not of its shape.
 */
export function applyWriteAhead(state, writeAhead, signedAt = null) {
  const signed = sub(state, 'signed'), recs = sub(state, 'records'), attempts = sub(state, 'transfer_attempts');
  for (const g of item(writeAhead, 'signed')) {
    const per = get(signed, g.edge);
    if (per !== null && !isDict(per)) throw valueError("records_unreadable: state['signed'] holds an edge that is not a JSON object");
    const have = truthy(per) ? get(per, String(g.timestamp)) : null;
    if (have !== null && (!isDict(have) || get(have, 'op') !== g.op || !pyEq(get(have, 'slots'), g.slots))) {
      throw new WriteAheadConflict('timestamp_reused', 'another operation is already recorded at this edge and timestamp; nothing was signed');
    }
  }
  const a = get(writeAhead, 'attempt');
  if (truthy(a)) {
    const lst = get(attempts, a.deal_id);
    if (lst !== null && !Array.isArray(lst)) throw valueError("records_unreadable: state['transfer_attempts'] holds a deal that is not a list");
    const paid = get(recs, PAID_DEALS_KEY);
    if (isDict(paid) && Object.hasOwn(paid, a.deal_id)) throw new WriteAheadConflict('already_paid', 'this deal is recorded as paid; nothing was signed');
    const mine = key([a.route, a.edge, a.total, a.timestamp]);
    const seen = new Set(iterate(or(get(writeAhead, 'attempts_seen'), [])).filter(x => Array.isArray(x)).map(x => key(x)));
    for (const k of attemptKeys(state, a.deal_id)) {
      if (k !== mine && !seen.has(k)) {
        throw new WriteAheadConflict('transfer_window_open', 'another payment attempt of this deal was recorded '
          + 'meanwhile; evaluate it again; nothing was signed');
      }
    }
  }
  for (const g of writeAhead.signed) {
    const per = isDict(get(signed, g.edge)) ? signed[g.edge] : put(signed, g.edge, {});
    put(per, String(g.timestamp), {op: g.op, slots: {...g.slots}});
  }
  for (const p of item(writeAhead, 'pending')) {
    records.addPending(recs, p.pair, p.total, p.timestamp, p.kind, p.ref, p.direction, signedAt);
  }
  if (truthy(a)) {
    const lst = Array.isArray(get(attempts, a.deal_id)) ? attempts[a.deal_id] : put(attempts, a.deal_id, []);
    const keys = ['route', 'edge', 'prior', 'total', 'timestamp'];
    if (!lst.some(x => isDict(x) && keys.every(k => pyEq(get(x, k), a[k])))) lst.push({...a, signed_at: signedAt});
  }
}

/**
 * Record what an evaluation found, signed or not: pending entries the item showed applied become confirmed
 * (records.confirm; with mePk, the 0.3 'issued' record of an outgoing edge follows), and the deals they paid go into
 * state.records.paid_deals, never to be paid again. Returns the deal ids it newly recorded as paid.
 */
export function applyFindings(state, summary, mePk = null) {
  const recs = sub(state, 'records');
  for (const a of iterate(or(get(summary, 'applied'), []))) {
    const e = records.confirm(recs, a.pair, a.state);
    if (truthy(mePk) && a.pair.startsWith(`${mePk}>`) && truthy(e.confirmed)) put(sub(state, 'issued'), a.pair, e.confirmed.total);
  }
  const fresh = [];
  for (const [dealId, info] of Object.entries(or(get(summary, 'paid_deals'), {}))) {
    if (markPaid(state, dealId, info.route, info.edge, info.total, info.timestamp)) fresh.push(dealId);
  }
  return fresh;
}

/**
 * D-1 item 5: once a payment of the deal is confirmed, record records.paid_deals[deal_id] = {route, edge, total,
 * timestamp}; every payer evaluation then refuses the deal (already_paid). The first record is kept. True when new.
 */
export function markPaid(state, dealId, route, edge, total, timestamp) {
  if (!ROUTES.includes(route)) throw valueError("a paid deal's route is 'note' or 'transfer'");
  const recs = sub(state, 'records');
  const paid = Object.hasOwn(recs, PAID_DEALS_KEY) ? recs[PAID_DEALS_KEY] : put(recs, PAID_DEALS_KEY, {});
  if (!isDict(paid)) throw valueError("records_unreadable: records['paid_deals'] is not a JSON object");
  if (Object.hasOwn(paid, dealId)) return false;
  put(paid, dealId, {route, edge, total, timestamp});
  return true;
}

/**
 * R12 for an ordinary (unbound) credit note on `edge`: 'bound_note_required' when the edge is in novated_edges or the
 * server advertises bound_notes/1, 'records_unreadable' when novated_edges cannot be read, else null.
 */
export function unboundNoteProblem(edge, novatedEdges, features = null) {
  novatedEdges ??= null;
  if (novatedEdges !== null && !isDict(novatedEdges) && !Array.isArray(novatedEdges)) return 'records_unreadable';
  if (Array.isArray(novatedEdges) && !novatedEdges.every(x => typeof x === 'string')) return 'records_unreadable';
  const novated = novatedEdges !== null && (Array.isArray(novatedEdges) ? novatedEdges.includes(edge) : Object.hasOwn(novatedEdges, edge));
  if (novated || (Array.isArray(features) && features.includes('bound_notes/1'))) return 'bound_note_required';
  return null;
}

/**
 * D-1 alone, for a payment the evaluators above do not see (the ordinary complete() path): may a new attempt (route
 * 'note' or 'transfer', the edge whose prior it acknowledges, that prior) be signed for the deal now? Returns {ok,
 * code, summary} with the codes and summary fields of the evaluators.
 */
export function checkPayment(dealId, price, route, edge, prior, ctx) {
  const go = run => {
    const s = run.summary;
    s.role = 'payer';
    s.kind = route;
    s.deal_id = shownId(dealId);
    run.load();
    if (!(text(dealId) && nat(price) && price > 0 && ROUTES.includes(route) && parseEdge(edge) !== null && nat(prior))) {
      run.bad('check_payment takes a deal id, its price, a route, an edge and a prior total');
    }
    run.havePins();
    run.oneLiveAttempt(dealId, price, route, edge, prior);
    return [[], null];
  };
  const r = new Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(go, null);
  return {ok: r.ok, code: r.code, summary: r.summary};
}

/**
 * The earlier payment attempts of a deal and how the evaluators weigh each now (D-1 with D-2 a), for listing them and
 * for the owner's resolution of one: {ok, code, attempts: [{attempt, outcome}]}; ok false (and no attempts) with
 * records_unreadable, bad_prior_signature or bad_template.
 */
export function classifyAttempts(dealId, ctx, price = null) {
  price ??= null;
  const go = run => {
    run.load();
    if (!(text(dealId) && (price === null || (nat(price) && price > 0)))) run.bad('classify_attempts takes a deal id and its price (or None)');
    const p = get(run.ctx, 'pins');
    if (!(isDict(p) && text(get(p, 'tracker_nft_id')) && text(get(p, 'denomination')))) run.ctxEdges = {};
    return [run.classify(dealId, price).map(([a, o]) => ({attempt: a, outcome: o})), null];
  };
  const r = new Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(go, null);
  return {ok: r.ok, code: r.code, attempts: r.ok ? r.to_sign : []};
}
