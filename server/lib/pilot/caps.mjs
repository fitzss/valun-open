// Tracker v3 capabilities and the effective circulation mode (design §3.6, §4.1; spec 18.1, 18.2).
//
// The operator asks for a mode with PILOT_CIRCULATION: off (the default), bound, sandbox or on. It takes effect only when
// the pilot tracker's GET /capabilities has exactly the v3 rule values (validateCaps) AND the sha256 of the running
// tracker binary, computed by the launcher (PILOT_TRACKER_SHA256), is pinned in lib/pilot/pins.mjs. Otherwise the
// server runs as off (fail closed) and says why. Probing routes is never used for this: it cannot tell which rules a
// tracker enforces.

import {ON_TESTNET} from './units.mjs';

export const CIRCULATION_MODES = Object.freeze(['off', 'bound', 'sandbox', 'on']);

// The v3.2 rule values (tracker GET /capabilities). Timestamp residues (ms mod 1000), allocated once for the whole
// roadmap: 999 transfer, 998 set-off, 997 bound note, 996 triad compress (later), 995 exchange (reserved).
// Tracker v3.2 (design v3.2 sections 2-3): a transfer's two creditor prior slots and a bound note's prior_signature are
// the 105-byte prior acknowledgment PRIOR_ACK, PA(I,R,X,p,T), which binds the edge's prior total X AND its note's
// timestamp p (audit VS-1, R-17); transfers are version 4 and bound notes version 3. A v3 or v3.1 tracker (build
// valun-circulating-credit/3: its acknowledgments M(I,R,X,T) bind only the total) no longer validates: circulation
// runs as off on it (fail closed).
export const CAPABILITIES_BUILD = 'valun-circulating-credit/4';
export const PRIOR_ACK = 'basis/prior-ack/1';
export const TRANSFER_VERSION = 4, BOUND_NOTE_VERSION = 3, SETOFF_VERSION = 3;
export const RESERVED_MS = Object.freeze([995, 996, 997, 998, 999]);
export const BOUND_NOTE_MS = 997, SETOFF_MS = 998, TRANSFER_MS = 999;
export const NOVATION_MAX_AGE_MS = 3600000;
export const TRANSFER_SIGNATURES = Object.freeze(['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to',
  'to_recipient_prior', 'to_recipient']);
export const SETOFF_SIGNATURES_PER_EDGE = Object.freeze(['issuer', 'recipient']);
// Server-side windows (design §4.3): collection TTLs, shorter than the tracker's maximum age, and the margin after it
// before a payment of another kind is allowed.
export const TRANSFER_TTL_MS = 1200000, SETOFF_TTL_MS = 1800000, FALLBACK_MARGIN_MS = 60000;

// What GET /info publishes as `novation` when the effective mode is not off (bound, sandbox, on). Since tracker v3.2 it
// also names the tracker contract the server enforces (tracker_build, transfer_version, bound_note_version, prior_ack):
// the 0.4 clients sign prior acknowledgments only for exactly these values (valun-open novation CONTRACT).
export const NOVATION_INFO = Object.freeze({transfer_ms: TRANSFER_MS, setoff_ms: SETOFF_MS, bound_note_ms: BOUND_NOTE_MS, reserved_ms: RESERVED_MS,
  max_age_ms: NOVATION_MAX_AGE_MS, transfer_ttl_ms: TRANSFER_TTL_MS, setoff_ttl_ms: SETOFF_TTL_MS, fallback_margin_ms: FALLBACK_MARGIN_MS,
  tracker_build: CAPABILITIES_BUILD, transfer_version: TRANSFER_VERSION, bound_note_version: BOUND_NOTE_VERSION, prior_ack: PRIOR_ACK});

// GET /info `features` for an effective mode (absent in mode off). guarantees/1 (fix inbox #18, lib/pilot/guarantees.mjs):
// guarantees between participants circulating credit is on for.
export const featuresFor = mode => mode === 'bound' ? ['bound_notes/1'] : mode === 'sandbox' || mode === 'on' ? ['bound_notes/1', 'circulation/1', 'guarantees/1'] : [];

// The fields validateCaps requires, with the exact value each must have. `commit` is informative, and the set-off's
// `max_edges` and `per_edge_timestamps` are read where they are used (per-edge timestamps may be false, design §3.4).
// Bound notes expire since tracker v3.1 (decision D-1 item 1): the tracker refuses a bound note older than max_age_ms
// (400 novation_expired), as it does a transfer or a set-off edge. Tracker v3.2 (bound notes version 3, transfers
// version 4) checks their prior acknowledgments over PRIOR_ACK.
const REQUIRED = Object.freeze([
  ['build', CAPABILITIES_BUILD],
  ['pure_credit', true],
  ['reserved_ms', RESERVED_MS],
  ['bound_notes.ms', BOUND_NOTE_MS],
  ['bound_notes.version', BOUND_NOTE_VERSION],
  ['bound_notes.max_age_ms', NOVATION_MAX_AGE_MS],
  ['bound_notes.prior_ack', PRIOR_ACK],
  ['bound_only_edges', true],
  ['novation.max_age_ms', NOVATION_MAX_AGE_MS],
  ['novation.transfer.ms', TRANSFER_MS],
  ['novation.transfer.version', TRANSFER_VERSION],
  ['novation.transfer.signatures', TRANSFER_SIGNATURES],
  ['novation.transfer.prior_ack', PRIOR_ACK],
  ['novation.setoff.ms', SETOFF_MS],
  ['novation.setoff.version', SETOFF_VERSION],
  ['novation.setoff.signatures_per_edge', SETOFF_SIGNATURES_PER_EDGE],
  ['onchain_edges', 0],
  ['novations_disabled_reason', null],
]);

// The Valun TESTNET network (valun-testnet-1): tracker v4 with anchored netting (TR-15) on Ergo testnet. Not pure credit:
// its edges have on-chain totals (any count), and debt transfers and set-offs may lower them under the anchored-netting
// rules, version 1: never below a total the tracker signed a redemption authorization for, and an edge with an on-chain
// total only while the tracker box on chain is younger than 1440 blocks (the contract waives the tracker's signature
// for a tracker box older than 2160); the tracker refreshes an unchanged tracker box at 720 blocks.
export const ANCHORED_NETTING = Object.freeze({version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720});
const REQUIRED_TESTNET = Object.freeze([
  ...REQUIRED.filter(([field]) => field !== 'pure_credit' && field !== 'onchain_edges'),
  ['pure_credit', false],
  ...Object.entries(ANCHORED_NETTING).map(([k, v]) => [`anchored_netting.${k}`, v]),
]);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// The value at a dotted path, through own properties of plain objects only; undefined when any step is missing.
function at(o, dotted) {
  let v = o;
  for (const k of dotted.split('.')) { if (!isObject(v) || !Object.hasOwn(v, k)) return undefined; v = v[k]; }
  return v;
}
// Exactly equal: the same scalar (no type coercion: "997" is not 997, a missing field is not null), or an array with
// the same elements in the same order.
const same = (got, want) => Array.isArray(want)
  ? Array.isArray(got) && got.length === want.length && got.every((x, i) => x === want[i])
  : got === want;
// A value for a log line: JSON, at most 120 characters, 'missing' for an absent field.
export const show = v => { const s = v === undefined ? 'missing' : JSON.stringify(v) ?? String(v); return s.length > 120 ? `${s.slice(0, 117)}...` : s; };

// The build a tracker v3 or v3.1 reports: its prior acknowledgments bind only the prior total (audit VS-1).
const V31_BUILD = 'valun-circulating-credit/3';
// {ok: true, reason: null} when `caps` (the data of the tracker's GET /capabilities, or null when it gave no 200 answer)
// has exactly the v3.2 values above; otherwise {ok: false, reason} naming the first field that differs (for a v3 or
// v3.1 tracker, also why it no longer qualifies). On the testnet network (`testnet`, by default this server's network)
// the values are the anchored-netting ones (REQUIRED_TESTNET), with any whole number of on-chain edges.
export function validateCaps(caps, {testnet = ON_TESTNET} = {}) {
  if (caps === undefined) return {ok: false, reason: 'the tracker capabilities have not been read yet'};
  if (caps === null) return {ok: false, reason: 'the tracker reports no capabilities (GET /capabilities gave no 200 answer: a tracker before v3)'};
  if (!isObject(caps)) return {ok: false, reason: `the tracker capabilities are not an object (${show(caps)})`};
  if (testnet && !(Number.isSafeInteger(caps.onchain_edges) && caps.onchain_edges >= 0))
    return {ok: false, reason: `tracker capabilities: onchain_edges is ${show(caps.onchain_edges)}, expected a whole number`};
  for (const [field, want] of testnet ? REQUIRED_TESTNET : REQUIRED) {
    const got = at(caps, field);
    if (!same(got, want)) {
      const why = field === 'build' && got === V31_BUILD
        ? ` (a tracker v3 or v3.1: its prior acknowledgments bind only the prior total, not the prior state, audit VS-1; circulating credit needs tracker v3.2, ${PRIOR_ACK})` : '';
      return {ok: false, reason: `tracker capabilities: ${field} is ${show(got)}, expected ${show(want)}${why}`};
    }
  }
  return {ok: true, reason: null};
}

// The effective mode: {requested, mode, reason, pending}. `mode` is the requested one only when it is a known mode
// other than off, validateCaps(caps) passes and `sha256` is in `pins`; otherwise 'off', with the reason (null when off
// was asked for). `pending`: the capabilities have not been read yet (a server that is still starting).
export function effectiveMode({requested, caps, sha256, pins}) {
  const off = (reason, pending = false) => ({requested, mode: 'off', reason, pending});
  if (!CIRCULATION_MODES.includes(requested)) return off(`PILOT_CIRCULATION is ${show(requested)}; it must be one of ${CIRCULATION_MODES.join(', ')}`);
  if (requested === 'off') return off(null);
  const v = validateCaps(caps);
  if (!v.ok) return off(v.reason, caps === undefined);
  if (typeof sha256 !== 'string' || !sha256.trim()) return off('the sha256 of the tracker binary is not known (PILOT_TRACKER_SHA256 is not set; the launcher computes it)');
  const sha = sha256.trim().toLowerCase();
  if (!Array.isArray(pins) || !pins.includes(sha)) return off(`the tracker binary's sha256 ${show(sha)} is not pinned in lib/pilot/pins.mjs`);
  return {requested, mode: requested, reason: null, pending: false};
}
