// A participant's own record of the credit edges it is party to (port of python/src/valun/records.py, function for
// function: the same rules, the same refusals, the same shapes, so the Python and the JavaScript client can keep one
// profile between them).
//
// Pure: no I/O, and nothing but JSON values in and out. It imports nothing but the Python semantics it mirrors.
//
//     records = {pair: {confirmed: EdgeState | null, pending: [entry, ...]}}
//     pair    = '<issuer_pubkey>><recipient_pubkey>' (hex keys)
//
// EdgeState  {total, timestamp, signature}: the edge's note as last confirmed applied on the Basis tracker. The
//            signature is the issuer's: the tracker stores the issuer's new signature for notes, transfers and set-offs.
// entry      {total, timestamp, kind, ref, direction, signed_at}: something this client signed for the edge whose
//            outcome is not known yet. kind: 'note' (a credit note) or a novation kind such as 'transfer' or 'setoff';
//            ref: the deal, transfer or set-off id; direction: 'out' when this client is the edge's issuer, 'in' when it
//            is the creditor; signed_at: when it was signed (ISO 8601, UTC), as the caller gives it.
//
// Rules
// - A pending entry becomes confirmed only when a recorded outcome or the edge's current state shows it applied
//   (confirm, syncEdge). Nothing is confirmed just because it was signed: an owner can still reject a held credit note,
//   and a held note can go stale (OQ-23).
// - A tracker edge's timestamps strictly increase. Once a state at timestamp T is confirmed, a pending entry at or
//   before T can never apply, so it is dropped; and the confirmed state never moves back to an older timestamp.
// - acceptPrior: a prior note shown by the server is acceptable when it is the issuer's own signature (checked by the
//   caller's verifier) and is not older than the confirmed state. The tracker enforces the rest (bound notes).
//
// Errors are thrown as Python's are: a ValueError (an Error whose name is 'ValueError') for a malformed argument, and
// AttributeError where the Python code would call a dict method on something that is not a dict.

import {PyError, get as pyGet, isDict, pyEq, str, truthy} from './py.js';

/** 2^64: totals and timestamps are unsigned 64-bit on the tracker (here: safe integers, 0 <= v < 2^53). */
export const MAX_U64 = 2 ** 64;

const valueError = message => new PyError('ValueError', message);

/** '<issuer_pubkey>><recipient_pubkey>'. */
export function pairKey(issuerPubkey, recipientPubkey) {
  return `${issuerPubkey}>${recipientPubkey}`;
}

/** A whole number 0 <= v < 2^64 (a JavaScript number: a safe integer; never a boolean or a string). */
function nat(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < MAX_U64;
}

/** str.partition('>'): [before, sep, after]. */
function partition(s) {
  const i = s.indexOf('>');
  return i < 0 ? [s, '', ''] : [s.slice(0, i), '>', s.slice(i + 1)];
}

/** A checked copy of an EdgeState {total, timestamp, signature}; ValueError when `s` is not one. */
export function edgeState(s) {
  if (!isDict(s) || !nat(pyGet(s, 'total')) || !nat(pyGet(s, 'timestamp')) || typeof pyGet(s, 'signature') !== 'string' || !s.signature) {
    throw valueError('an edge state is {total, timestamp, signature}: two whole numbers and a signature');
  }
  return {total: s.total, timestamp: s.timestamp, signature: s.signature};
}

/** One edge's record, without adding it: {confirmed: EdgeState | null, pending: [entries]}. */
export function get(recs, pair) {
  let e = pyGet(truthy(recs) ? recs : {}, pair);
  e = isDict(e) ? e : {};
  const c = pyGet(e, 'confirmed'), p = pyGet(e, 'pending');
  return {confirmed: isDict(c) ? c : null, pending: Array.isArray(p) ? [...p] : []};
}

/** The confirmed total of one edge, or null when nothing on it is confirmed. */
export function confirmedTotal(recs, pair) {
  const c = get(recs, pair).confirmed;
  return truthy(c) ? pyGet(c, 'total') : null;
}

function entry(recs, pair) {
  let e = pyGet(recs, pair);
  if (!isDict(e)) {
    e = {};
    recs[pair] = e;
  }
  if (!isDict(pyGet(e, 'confirmed'))) e.confirmed = null;
  if (!Array.isArray(pyGet(e, 'pending'))) e.pending = [];
  return e;
}

/**
 * Record something just signed for `pair` whose outcome is not known yet. Returns the entry (an identical entry already
 * recorded is returned instead of a second copy).
 */
export function addPending(recs, pair, total, timestamp, kind, ref = null, direction = 'out', signedAt = null) {
  if (!(nat(total) && nat(timestamp))) throw valueError('a pending entry needs a whole-number total and timestamp');
  if (direction !== 'out' && direction !== 'in') throw valueError("direction is 'out' (I am the issuer) or 'in' (I am the creditor)");
  const e = entry(recs, pair);
  for (const p of e.pending) {
    if (isDict(p) && pyEq(pyGet(p, 'total'), total) && pyEq(pyGet(p, 'timestamp'), timestamp) && pyEq(pyGet(p, 'kind'), kind)
        && pyEq(pyGet(p, 'ref'), ref)) {
      return p;
    }
  }
  const p = {total, timestamp, kind, ref, direction, signed_at: signedAt};
  e.pending.push(p);
  return p;
}

/** Forget a pending entry that can never apply (for example the server refused it). Returns how many were removed. */
export function removePending(recs, pair, total, timestamp, ref = null) {
  const e = isDict(recs) ? pyGet(recs, pair) : null;
  if (!isDict(e) || !Array.isArray(pyGet(e, 'pending'))) return 0;
  const keep = e.pending.filter(p => !(isDict(p) && pyEq(pyGet(p, 'total'), total) && pyEq(pyGet(p, 'timestamp'), timestamp)
    && (ref === null || ref === undefined || pyEq(pyGet(p, 'ref'), ref))));
  const removed = e.pending.length - keep.length;
  e.pending = keep;
  return removed;
}

function apply(recs, pair, st) {
  const e = entry(recs, pair);
  const cur = e.confirmed;
  if (cur !== null && nat(pyGet(cur, 'timestamp')) && st.timestamp < cur.timestamp) {
    return [e, null, [], false];                 // older than what is confirmed: nothing changes
  }
  const found = e.pending.find(p => isDict(p) && pyEq(pyGet(p, 'total'), st.total) && pyEq(pyGet(p, 'timestamp'), st.timestamp));
  const match = found === undefined ? null : found;
  const keep = [], dropped = [];
  for (const p of e.pending) {
    if (isDict(p) && nat(pyGet(p, 'timestamp')) && p.timestamp > st.timestamp) keep.push(p);   // may still apply later
    else if (p !== match) dropped.push(p);       // at or before the confirmed state: it can never apply
  }
  e.confirmed = st;
  e.pending = keep;
  return [e, match, dropped, true];
}

/**
 * A recorded outcome shows `state` (an EdgeState) applied on `pair`: it becomes the confirmed state, a matching pending
 * entry is promoted, and pending entries at or before its timestamp are dropped. A state older than the one already
 * confirmed changes nothing. Returns the edge's record.
 */
export function confirm(recs, pair, state) {
  return apply(recs, pair, edgeState(state))[0];
}

/**
 * Apply one row of the edge's current state as the server shows it ({edge, or issuer_pubkey and recipient_pubkey,
 * total, timestamp, signature}; the caller verifies the signature first). Promotes a matching pending entry, drops
 * pending entries older than the new confirmed timestamp, and never moves the confirmed state back in time.
 * Returns {pair, changed, promoted (the pending entry that applied, or null), dropped [entries], confirmed}.
 */
export function syncEdge(recs, edge) {
  if (!isDict(edge)) throw valueError('an edge row is a JSON object');
  let pair = pyGet(edge, 'edge') ?? null;
  if (pair === null && typeof pyGet(edge, 'issuer_pubkey') === 'string' && typeof pyGet(edge, 'recipient_pubkey') === 'string') {
    pair = pairKey(edge.issuer_pubkey, edge.recipient_pubkey);
  }
  const [issuer, sep, recipient] = typeof pair === 'string' ? partition(pair) : ['', '', ''];
  if (!(sep && issuer && recipient && !recipient.includes('>'))) {
    throw valueError('an edge row names its edge as "<issuer_pubkey>><recipient_pubkey>"');
  }
  const [e, match, dropped, changed] = apply(recs, pair, edgeState(edge));
  return {pair, changed, promoted: match, dropped, confirmed: e.confirmed};
}

/**
 * Why `priorNote` (the current note on my outgoing edge `pair`, as the server shows it) is not an acceptable prior, or
 * null when it is. verify(issuerPubkey, recipientPubkey, total, timestamp, signature) -> boolean checks the issuer's
 * Basis note signature (the caller binds the tracker and unit).
 *   'bad_prior_signature'  it is not my own signature as the edge's issuer (or it is malformed)
 *   'stale_prior'          it is older than the state my records confirm (or contradicts it at the same timestamp)
 */
export function priorProblem(recs, pair, priorNote, myPubkey, verify) {
  const [issuer, sep, recipient] = partition(str(pair));
  if (!sep || issuer !== myPubkey || !recipient || !isDict(priorNote)) return 'bad_prior_signature';
  const total = pyGet(priorNote, 'total'), ts = pyGet(priorNote, 'timestamp'), sig = pyGet(priorNote, 'signature');
  if (!(nat(total) && nat(ts) && typeof sig === 'string' && sig)) return 'bad_prior_signature';
  let ok;
  try {
    ok = verify(issuer, recipient, total, ts, sig) === true;
  } catch {
    ok = false;                                  // a verifier that fails accepts nothing
  }
  if (!ok) return 'bad_prior_signature';
  const cur = get(recs, pair).confirmed;
  if (cur !== null && nat(pyGet(cur, 'timestamp'))) {
    if (ts < cur.timestamp || (ts === cur.timestamp && !pyEq(total, pyGet(cur, 'total')))) return 'stale_prior';
  }
  return null;
}

/** True when `priorNote` is a prior I signed as the edge's issuer and is not older than my confirmed state. */
export function acceptPrior(recs, pair, priorNote, myPubkey, verify) {
  return priorProblem(recs, pair, priorNote, myPubkey, verify) === null;
}
