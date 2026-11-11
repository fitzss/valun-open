// Circulating credit, pure helpers (design §3.1, §3.3, §4.2-§4.5, §5.1, §5.5; spec 18.3, 18.4, 18.6, 18.8; decision D-1):
// the timestamp residues, the choice of a novation timestamp, the quote digest, the seven slots of a debt transfer
// (who signs which note message), the tracker request body, the X-Valun-Features header, and how a read-back of an
// edge classifies an attempt. No I/O and no clock: callers pass the time and the states they read.
//
// Notation (spec 18): A = issuer, B = old creditor (the deal's payer), C = new creditor (the deal's payee), a = amount,
// T = the transfer's timestamp (residue 999), X = the tracker total of A->B, Y = that of A->C (0 when it does not exist),
// p_AB and p_AC the timestamps of those edges' notes (0 for A->C when it does not exist).
// M(I,R,t,ts) is the 80-byte Basis note message (Basis.noteMessage); PA(I,R,X,p,T) the 105-byte prior acknowledgment of
// tracker v3.2 (Basis.priorAckMessage: the edge's prior state (X, p) at the operation's timestamp T). An edge key is
// '<issuer_pubkey>><recipient_pubkey>'; a slot key '<edge>:prior' or '<edge>:new'.
//
// The cycle with core.mjs (canonical, sha256) is safe: this module uses them only inside functions.
import {canonical, sha256} from './core.mjs';
import {BOUND_NOTE_MS, SETOFF_MS, TRANSFER_MS, NOVATION_MAX_AGE_MS, TRANSFER_TTL_MS, SETOFF_TTL_MS, FALLBACK_MARGIN_MS} from './caps.mjs';
import {edgeKey} from './journal.mjs';

export {TRANSFER_TTL_MS, SETOFF_TTL_MS, FALLBACK_MARGIN_MS, edgeKey};
// The residue (ts mod 1000) of each novation kind (design §3.1).
export const RESIDUE = Object.freeze({transfer: TRANSFER_MS, setoff: SETOFF_MS, bound: BOUND_NOTE_MS});
// The tracker refuses transfers, set-off edges and bound notes older than this (tracker v3.1; D-1 item 1).
export const MAX_AGE_MS = NOVATION_MAX_AGE_MS;
// At most this many transfer attempts per deal in 24 hours (each a new attempt its payer posted; the server makes none
// again by itself).
export const MAX_ATTEMPTS_PER_DAY = 3;
// A chosen timestamp is at least this far behind the server's clock (design §4.3), so the tracker never sees it ahead.
export const TIMESTAMP_LAG_MS = 1500;
export const QUOTE_KIND = 'valun-transfer-quote/1';
export const QUOTE_FIELDS = Object.freeze(['network', 'tracker_nft_id', 'denomination', 'deal_id', 'terms_hash', 'deliverable_sha256',
  'issuer_pubkey', 'payer_pubkey', 'payee_pubkey', 'amount']);
// The roles a client can declare it signs by itself (X-Valun-Features, design §4.1).
export const CONSENT_ROLES = Object.freeze(['setoff', 'issuer', 'creditor']);

const KEY_RE = /^0[23][0-9a-f]{64}$/, SIG_RE = /^0[23][0-9a-f]{128}$/;
const nat = v => Number.isSafeInteger(v) && v >= 0;
const mod = (x, m) => ((x % m) + m) % m;

// The largest t with t % 1000 === residue, t <= now - 1500 and t > after, as {timestamp}; when there is none yet,
// {ahead_ms}: how long until there is one (design §4.3). `after` is the latest timestamp the new one must follow (an
// absent edge: 0).
export function novationTimestamp({now, residue, after = 0}) {
  if (!nat(now) || !nat(after) || !Number.isSafeInteger(residue) || residue < 0 || residue > 999)
    throw new TypeError('novationTimestamp: now and after are whole ms (>= 0) and residue is 0..999');
  const top = now - TIMESTAMP_LAG_MS, t = top - mod(top - residue, 1000);
  if (t > after) return {timestamp: t};
  const first = after + 1 + mod(residue - (after + 1), 1000);       // the first such t after `after`
  return {ahead_ms: first + TIMESTAMP_LAG_MS - now};
}

// quote_digest = sha256hex(canonical(Q)), Q = {kind: 'valun-transfer-quote/1', network, tracker_nft_id, denomination,
// deal_id, terms_hash, deliverable_sha256, issuer_pubkey, payer_pubkey, payee_pubkey, amount} (design §4.2, spec 18.3
// item 4). Q has no timestamp and no total, so every attempt through the same issuer has the same digest. The text
// values must be printable ASCII and the amount a positive safe integer, so every implementation of canonical() gives
// the same bytes; anything else is a TypeError. Other keys of `q` are ignored.
export function quoteDigest(q) {
  if (!q || typeof q !== 'object') throw new TypeError('quoteDigest: the quote fields must be an object');
  const out = {kind: QUOTE_KIND};
  for (const k of QUOTE_FIELDS) {
    const v = q[k];
    if (k === 'amount') { if (!Number.isSafeInteger(v) || v < 1) throw new TypeError('quoteDigest: amount must be a positive whole number of PC'); }
    else if (typeof v !== 'string' || !v || !/^[\x20-\x7e]+$/.test(v)) throw new TypeError(`quoteDigest: ${k} must be a non-empty printable ASCII string`);
    out[k] = v;
  }
  return sha256(canonical(out));
}

// The seven signatures of a debt transfer (tracker POST /notes/transfer, version 4; design §3.3, v3.2 section 2, spec
// 18.6), in the order the payer, the issuer and the payee sign them. `name` is the tracker field without its _signature
// suffix; `which` the edge (from = A->B, to = A->C); `slot` prior or new. A prior slot is the creditor's prior
// acknowledgment PA(A,R,prior,p,T) of the edge's state; a new slot the note message M(A,R,new,T). The issuer and the
// payer both sign '<A>><B>:new' and '<A>><C>:new' (each with its own key), so a stored slot is keyed by `name`, never by
// its slot key alone.
export const TRANSFER_SLOTS = Object.freeze([
  {name: 'from_recipient_prior', role: 'payer', which: 'from', slot: 'prior'},
  {name: 'from_recipient', role: 'payer', which: 'from', slot: 'new'},
  {name: 'from_recipient_to', role: 'payer', which: 'to', slot: 'new'},
  {name: 'issuer_from', role: 'issuer', which: 'from', slot: 'new'},
  {name: 'issuer_to', role: 'issuer', which: 'to', slot: 'new'},
  {name: 'to_recipient_prior', role: 'payee', which: 'to', slot: 'prior'},
  {name: 'to_recipient', role: 'payee', which: 'to', slot: 'new'},
].map(s => Object.freeze(s)));
export const TRANSFER_ROLES = Object.freeze(['payer', 'issuer', 'payee']);

// The numbers a transfer is made of, checked: {A, B, C, a, T, X, Y, pX, pY} (pX = p_AB, pY = p_AC). `t`: {issuer, payer,
// payee ({pubkey}), amount, timestamp, from_edge {before {total, timestamp}}, to_edge {before {total, timestamp} | null}}
// (a transfer record or a template). An absent to-edge is (0, 0); a prior timestamp is before T.
function parts(t) {
  const A = t?.issuer?.pubkey, B = t?.payer?.pubkey, C = t?.payee?.pubkey, a = t?.amount, T = t?.timestamp;
  const X = t?.from_edge?.before?.total, Y = t?.to_edge?.before == null ? 0 : t.to_edge.before.total;
  const pX = t?.from_edge?.before?.timestamp, pY = t?.to_edge?.before == null ? 0 : t.to_edge.before.timestamp;
  if (![A, B, C].every(k => typeof k === 'string' && KEY_RE.test(k))) throw new TypeError('transfer: issuer, payer and payee need 33-byte public keys');
  if (A === B || A === C || B === C) throw new TypeError('transfer: issuer, payer and payee keys must all differ');
  if (!Number.isSafeInteger(a) || a < 1) throw new TypeError('transfer: amount must be a positive whole number');
  if (!nat(T) || T % 1000 !== TRANSFER_MS) throw new TypeError(`transfer: the timestamp must end in ${TRANSFER_MS} ms`);
  if (!nat(X) || X < a) throw new TypeError('transfer: the from-edge must hold at least the amount');
  if (!nat(Y) || !Number.isSafeInteger(Y + a)) throw new TypeError('transfer: the to-edge total must be a whole number');
  if (!nat(pX) || pX >= T) throw new TypeError("transfer: the from-edge's prior timestamp must be a whole number before T");
  if (!nat(pY) || pY >= T) throw new TypeError("transfer: the to-edge's prior timestamp must be a whole number before T (0 for a new edge)");
  return {A, B, C, a, T, X, Y, pX, pY};
}

// Every slot of transfer `t` with what its signer signs: {name, role, which, slot, field (the tracker field), edge,
// key (the slot key), issuer_pubkey, recipient_pubkey, total, timestamp, prior_timestamp}. A new slot signs
// M(issuer_pubkey, recipient_pubkey, total, timestamp) (prior_timestamp null); a prior slot the prior acknowledgment
// PA(issuer_pubkey, recipient_pubkey, total, prior_timestamp, timestamp) of the edge's state (total, prior_timestamp)
// (tracker v3.2). Throws TypeError when `t` is not a well-formed transfer.
export function transferSlots(t) {
  const {A, B, C, a, T, X, Y, pX, pY} = parts(t);
  const recipient = {from: B, to: C}, total = {from: {prior: X, new: X - a}, to: {prior: Y, new: Y + a}}, priorTs = {from: pX, to: pY};
  return TRANSFER_SLOTS.map(s => {
    const edge = edgeKey(A, recipient[s.which]);
    return {...s, field: `${s.name}_signature`, edge, key: `${edge}:${s.slot}`, issuer_pubkey: A, recipient_pubkey: recipient[s.which],
      total: total[s.which][s.slot], timestamp: T, prior_timestamp: s.slot === 'prior' ? priorTs[s.which] : null};
  });
}

// What slot `s` (transferSlots) signs, as a message descriptor: {issuer, recipient, total, timestamp} for a note message
// M (the arguments of Basis.noteMessage), plus prior_timestamp for a prior acknowledgment PA (Basis.priorAckMessage
// with priorTotal = total).
export const slotMessage = s => ({issuer: s.issuer_pubkey, recipient: s.recipient_pubkey, total: s.total, timestamp: s.timestamp,
  ...(s.slot === 'prior' ? {prior_timestamp: s.prior_timestamp} : {})});

// The distinct messages of a transfer, by slot key ('<A>><B>:prior', '<A>><B>:new', '<A>><C>:prior', '<A>><C>:new'):
// a descriptor each (slotMessage): the two prior slots are PA, the two new ones M.
export function transferMessages(t) {
  const out = {};
  for (const s of transferSlots(t)) out[s.key] ??= slotMessage(s);
  return out;
}

// The tracker request (POST /notes/transfer, version 4; its fields only, since the tracker refuses unknown ones) for a
// transfer whose seven slots are signed: t.slots[name].signature. from_prior_total, to_prior_total and (tracker v3.2)
// from_prior_timestamp, to_prior_timestamp (0 for a new to-edge) are sent, so a stale prior state is refused by the
// tracker as well (409 stale_prior; the signatures are what bind). Throws TypeError when a slot is missing.
export function trackerTransferBody(t) {
  const {A, B, C, a, T, X, Y, pX, pY} = parts(t);
  if (typeof t.denomination !== 'string' || !t.denomination) throw new TypeError('transfer: denomination is required');
  const sig = name => {
    const s = t.slots?.[name]?.signature;
    if (typeof s !== 'string' || !SIG_RE.test(s)) throw new TypeError(`transfer: the ${name} slot is not signed`);
    return s;
  };
  return {issuer_pubkey: A, from_recipient_pubkey: B, to_recipient_pubkey: C, denomination: t.denomination, amount: a, timestamp: T,
    issuer_from_signature: sig('issuer_from'), issuer_to_signature: sig('issuer_to'),
    from_recipient_prior_signature: sig('from_recipient_prior'), from_recipient_signature: sig('from_recipient'),
    from_recipient_to_signature: sig('from_recipient_to'),
    to_recipient_prior_signature: sig('to_recipient_prior'), to_recipient_signature: sig('to_recipient'),
    from_prior_total: X, to_prior_total: Y, from_prior_timestamp: pX, to_prior_timestamp: pY};
}

// The same-prior exemption of decision D-1 (design v3.2 section 4). An earlier payment attempt of a deal that can still
// apply does not hold back a new transfer attempt that acknowledges the SAME prior state of the SAME edge it changes
// first: both transfers on the same from-edge A->B whose PA(A,B,X,p,T) acknowledge the same (X, p). The edge has that
// state at most once (an edge's timestamps only grow), so at the tracker the first of the two to apply leaves the other
// dead for good (tracker v3.2). `earlier` and `next`: {kind ('transfer' | 'bound' | 'note'), edge (the edge it changes
// first: a transfer's from-edge, a note's pair), prior (its total), prior_timestamp}. True only for two transfers, or two
// bound notes, on the same edge with the same total and the same whole-number prior timestamp; an attempt that recorded
// no prior timestamp, an ordinary note and anything of another kind are never exempt (they keep the windows).
export function samePriorState(earlier, next) {
  if (!earlier || !next || earlier.kind !== next.kind || (next.kind !== 'transfer' && next.kind !== 'bound')) return false;
  return typeof next.edge === 'string' && earlier.edge === next.edge && nat(next.prior) && earlier.prior === next.prior
    && nat(next.prior_timestamp) && earlier.prior_timestamp === next.prior_timestamp;
}

// When a payment of another kind (or on another prior state: samePriorState) may follow an attempt at timestamp T that
// did not apply (design §4.3, D-1): once the tracker refuses the attempt by age, plus the server's margin.
export const fallbackAfter = T => T + MAX_AGE_MS + FALLBACK_MARGIN_MS;

// The X-Valun-Features request header (design §4.1): 'consents/1;roles=setoff,issuer,creditor'. Returns
// {consents: true, roles} (the known roles it lists, in CONSENT_ROLES order) or null for a missing or unreadable header.
export function parseFeatures(header) {
  if (typeof header !== 'string' || !header || header.length > 200) return null;
  const parts = header.split(';').map(s => s.trim());
  if (parts[0] !== 'consents/1') return null;
  let roles = [];
  for (const p of parts.slice(1)) {
    const m = /^roles=([a-z,]*)$/.exec(p);
    if (!m) return null;
    roles = m[1].split(',').filter(Boolean);
  }
  return {consents: true, roles: CONSENT_ROLES.filter(r => roles.includes(r))};
}

// How the current state of one edge an attempt would change stands against that attempt (design §5.5, D-1 item 3).
// `state` is the tracker's EdgeState now ({total, timestamp, signature}) or null (the edge does not exist); `before` the
// state the attempt was built on (null: absent); `next` = {total, timestamp, signature}, the state the attempt sets.
//   'new'            the edge holds exactly the attempt's new state: it applied
//   'prior'          the edge is exactly as the attempt found it: it did not apply (it may if submitted)
//   'changed'        another state with a timestamp before the attempt's: it did not apply (applying sets its timestamp)
//   'moved_past'     moved past the attempt's timestamp, back at its prior total: it did not apply and never can
//   'applied_moved'  moved past the attempt's timestamp, at its new total: taken as applied (D-1)
//   'unknown'        another state at the attempt's timestamp, or past it at another total: it may have applied
export function classifyEdge(state, before, next) {
  const same = (s, b) => (s == null ? b == null : b != null && s.total === b.total && s.timestamp === b.timestamp && s.signature === b.signature);
  if (state != null && state.total === next.total && state.timestamp === next.timestamp && state.signature === next.signature) return 'new';
  if (same(state, before)) return 'prior';
  const ts = state?.timestamp ?? 0, total = state?.total ?? 0;
  if (ts < next.timestamp) return 'changed';
  if (ts === next.timestamp) return 'unknown';
  if (total === next.total) return 'applied_moved';
  if (total === (before?.total ?? 0)) return 'moved_past';
  return 'unknown';
}

// A transfer's outcome from its two edges' classes (classifyEdge): 'applied'; 'prior' (both untouched: not applied, it
// may still be submitted); 'not_applied' (an edge changed or moved past: it did not apply); 'unknown' (it may have
// applied: only the owner can resolve it, D-1 item 3); 'inconsistent' (one edge applied and the other not, which one
// tracker batch cannot produce: an alarm).
export function transferOutcome(from, to) {
  const done = c => c === 'new' || c === 'applied_moved';
  if (done(from) && done(to)) return 'applied';
  if (from === 'unknown' || to === 'unknown') return 'unknown';
  if (done(from) || done(to)) return 'inconsistent';
  if (from === 'prior' && to === 'prior') return 'prior';
  return 'not_applied';
}
