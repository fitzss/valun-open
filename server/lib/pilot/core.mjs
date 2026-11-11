// Valun pilot network core (valun-pilot-1). See docs/PILOT-API.md.
// Authentication = hashed bearer tokens; signing authority = participant-held keys (server only verifies, using Basis's
// own basis_core code through the signer runner); delegation = owner-set mandate enforced here at every agent action.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {statusClass, bucketCounts, inboxSection, POSITION_BUCKETS} from './status.mjs';
import {ordinaryTimestamp, BasisError} from '../basis.mjs';
import {effectiveMode, featuresFor, validateCaps, BOUND_NOTE_MS, TRANSFER_MS, SETOFF_MS, SETOFF_TTL_MS, PRIOR_ACK} from './caps.mjs';
import {TRACKER_SHA256_PINS} from './pins.mjs';
import {ensureJournal, appendEntries, backfillJournal, flushEdgeLog, repairEdgeLog, journalFor, edgeEntries, firstEdgeEntryAfter, edgeKey, EDGE_LOG_FILE,
  compactJournal, journalCheckpoint, readCheckpoint, JOURNAL_HORIZON_MS, JOURNAL_COMPACT_EVERY_MS, JOURNAL_COMPACT_MIN_BYTES} from './journal.mjs';
// The clearing engine's pure parts (multilateral set-off: eligibility, metrics, the tracker body, the outcome rule).
import {eligibleGraph, metrics as clearingMetrics, setoffOutcome, trackerSetoffBody, balanced as setoffBalanced, edgeSetId, LIMITS as CLEARING_LIMITS,
  COOLDOWN_FAILED_MS, COOLDOWN_REFUSED_MS, EXPIRIES_TO_EXCLUDE, EXCLUSION_MS} from './clearing.mjs';
// Payment by debt transfer (pure helpers). novation.mjs imports canonical and sha256 from this module; neither module
// uses the other's bindings at load time, only inside functions, so the import cycle is safe.
import {novationTimestamp, quoteDigest, transferSlots, transferMessages, slotMessage, samePriorState, trackerTransferBody, fallbackAfter, parseFeatures, classifyEdge,
  transferOutcome, TRANSFER_SLOTS, MAX_AGE_MS, MAX_ATTEMPTS_PER_DAY, TRANSFER_TTL_MS} from './novation.mjs';
// Phase-2 credit policies (circulation modes sandbox and on): the credit rules, the credit history, the agent limit kinds.
import {creditCheck, creditHistory, publicCreditPolicy, policyValue, impliedPhase2, strictestLimit, agentLimitWidens, PHASE2_FIELDS, SANDBOX_MAX_CLAIMS_TOTAL} from './policy.mjs';

export const NETWORK = 'valun-pilot-1';
export const PROTOCOL = 'valun-deal/1';
// The pilot unit: a synthetic token id the pilot tracker serves (it exists on no chain).
export const PILOT_TOKEN_ID = crypto.createHash('sha256').update('valun-pilot-credit/1').digest('hex');
export const PILOT_DENOMINATION = `token:${PILOT_TOKEN_ID}`;
const PRICE_CAP = 1000;                   // PC per deal, network-wide sanity cap
const MAX_OFFER_TTL_MS = 7 * 864e5, MAX_DELIVERY_MS = 30 * 864e5;
const ENROLL_TTL_MS = 30 * 60e3;
// An agreed deal the payee has not delivered this long after deliver_by ends as expired_undelivered (OQ-8). A delivery
// waiting for the payer's review never expires.
export const UNDELIVERED_GRACE_DAYS = 7;
const UNDELIVERED_GRACE_MS = UNDELIVERED_GRACE_DAYS * 864e5;
// How long a credit-note template waits for this server's clock to pass the pair's last note timestamp (OQ-12).
const NOTE_CLOCK_WAIT_MS = 3000;
const CAPS_REREAD_MS = 60e3;           // reservedResidues: a tracker that named no residues is asked again at most this often
// While another deal on the same key pair is issuing_note (its note may already be on the tracker, unconfirmed), a new
// note on that pair is refused with 409 pair_busy and this retry time; recovery runs every 60 s (server.mjs).
const PAIR_BUSY_RETRY_MS = 60000;
// The approval kinds this server decides. Any other kind (state from a newer release, or damaged) is refused before
// anything changes; it used to fall through to the confirm_offer code, so rejecting it withdrew the deal.
// pay_by_transfer (circulating credit): a payment by debt transfer held for the payer's owner (review_deliveries).
const APPROVAL_KINDS = Object.freeze(['issue_note', 'pay_by_transfer', 'propose', 'accept', 'confirm_offer']);

export class PilotError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.name = 'PilotError'; this.code = code; this.status = status; this.extra = extra; }
}

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const termsHash = terms => sha256(canonical(terms));
export const statements = {
  enroll: (pid, pubkey, codeHash) => `valun-pilot/enroll/1\n${NETWORK}\n${pid}\n${pubkey}\n${codeHash}`,
  propose: h => `valun-pilot/propose/1\n${h}`,
  accept: h => `valun-pilot/accept/1\n${h}`,
  decline: (h, reason) => `valun-pilot/decline/1\n${h}\n${sha256(reason)}`,
  withdraw: h => `valun-pilot/withdraw/1\n${h}`,
  deliver: (h, d) => `valun-pilot/deliver/1\n${h}\n${d}`,
  complete: (h, d) => `valun-pilot/complete/1\n${h}\n${d}`,
  dispute: (h, d, reason) => `valun-pilot/dispute/1\n${h}\n${d}\n${sha256(reason)}`,
};
// The statement circulating credit adds (design §4.2): the payer of a payment by debt transfer signs it ("I pay this deal
// by exactly the transfer this quote describes"). It is kept apart from `statements`, which /info publishes unchanged in
// every mode; /info lists it as circulation_statements only when circulation is on.
export const circulationStatements = {
  pay: (dealId, quoteDigest) => `valun-pilot/pay/1\n${dealId}\n${quoteDigest}`,
};
const hexOf = s => Buffer.from(s, 'utf8').toString('hex');
const token = prefix => prefix + crypto.randomBytes(32).toString('base64url');
const rid = (prefix, n = 8) => prefix + crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
// Ledger row -> the tracker note it was made from (Pilot.ledger()), so reconcile() can compare signatures without the
// ledger rows, which are public, carrying them.
const TRACKER_NOTE = new WeakMap();

// Fields an agent may tighten (record) within its owner's mandate: caps can only go lower, floors only higher.
// With circulating credit on (modes sandbox and on; in other modes they are ignored, as any unknown field is) also the
// credit policy (lib/pilot/policy.mjs has the kinds): null-caps (ncap: an owner's null is no cap; an agent sets one or
// lowers it), allow-lists (subset only), deny-lists (superset only) and off-only fields (booleans, and
// pay_with_held_notes, can only be turned off).
const AGENT_LIMIT_FIELDS = Object.freeze({max_issue_per_deal: 'cap', max_issue_outstanding: 'cap', max_accept_per_deal: 'cap',
  max_accept_per_issuer: 'cap', min_price_as_payee: 'floor', min_payer_coverage_pct: 'floor',
  max_claims_total: 'ncap', max_issuer_net_debt: 'ncap', accept_operator_issuers: 'off_only',
  auto_clear: 'off_only', novate_own_debt: 'off_only', accept_transfers: 'off_only', pay_with_held_notes: 'off_only',
  accept_notes_from: 'allow', refuse_notes_from: 'deny'});
const CIRCULATION_LIMIT_KINDS = new Set(['ncap', 'off_only', 'allow', 'deny']);

export const DEFAULT_MANDATE = Object.freeze({
  objective: '', may_issue_credit: true, may_accept_credit: true,
  max_issue_per_deal: 25, max_issue_outstanding: 50, max_accept_per_deal: 25, max_accept_per_issuer: 50, min_price_as_payee: 0,
  min_payer_coverage_pct: 0,
  counterparties: 'any', approve_above: 0, review_deliveries: false, expires_at: null,
});
// The owner's credit policy for circulating credit (design §8). These mandate fields exist only once circulation is on
// (effective mode sandbox or on); DEFAULT_MANDATE stays as it is, because /me returns the mandate verbatim. Values:
// migrate() gives participants who joined before (LEGACY: nothing moves without the owner), join() an invited joiner,
// joinSandbox() a sandbox joiner. accept_notes_from is 'any' or a list of participant ids ([] = nobody; never derived
// from counterparties).
export const CIRCULATION_MANDATE_FIELDS = Object.freeze(['auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from', 'refuse_notes_from', 'pay_with_held_notes']);
export const PAY_WITH_HELD_NOTES = Object.freeze(['never', 'when_asked', 'prefer']);
const LEGACY_CIRCULATION = () => ({auto_clear: false, novate_own_debt: false, accept_transfers: false, accept_notes_from: [], refuse_notes_from: [], pay_with_held_notes: 'never'});
const INVITE_CIRCULATION = () => ({auto_clear: true, novate_own_debt: true, accept_transfers: false, accept_notes_from: [], refuse_notes_from: [], pay_with_held_notes: 'when_asked'});
const SANDBOX_CIRCULATION = from => ({auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: from === 'any' ? 'any' : [...from], refuse_notes_from: [], pay_with_held_notes: 'when_asked'});

// The largest timestamp t with t % 1000 === residue, t <= now - 1500 and t > after, as {timestamp}; when there is none
// yet, {ahead_ms}: how long until there is (design §4.3: bound notes 997, set-off edges 998, transfers 999). The same
// as novationTimestamp (lib/pilot/novation.mjs).
export function residueTimestamp(now, residue, after) { return novationTimestamp({now, residue, after}); }

// ---------- circulating credit: payment by debt transfer (design §4.5, §5.4, §5.5; spec 18.6, 18.8, 18.9; D-1) ----------
// Transfer states (s.transfers[vt_...].state). Live ones hold their two edges exclusively; unresolved ones (the read-back
// could not decide, or showed one edge applied and the other not) wait for the owner and block every other payment of
// the deal (D-1 item 3) until the payer's owner resolves them (decision D-2 d: applied, or resolved_not_applied); every
// other state is an end without effect, after which every other payment of the deal (one through the same issuer
// included) waits until fallback_after = T + 1 h + 60 s, except a transfer through the same note acknowledging the same
// prior state of it (total and timestamp: the same-prior exemption of tracker v3.2, samePriorState).
const LIVE_TRANSFER = new Set(['awaiting_owner', 'collecting', 'applying']);
const UNRESOLVED_TRANSFER = new Set(['outcome_unknown', 'inconsistent']);
// Payment attempts the payer posted and the server refused before recording them (decision D-2 b), kept per deal.
const REFUSED_ATTEMPTS_KEPT = 32;
// Deal statuses a payment (by transfer or own note) can start from.
const PAYABLE = Object.freeze(['delivered', 'note_failed', 'payment_due']);
const CONSENT_ROLE_MS = 7 * 864e5, PRESENCE_MS = 10 * 60e3;       // a declared consent role counts 7 days; present = seen in 10 min
const INITIATE_WINDOW_MS = 600e3;                                 // a posted transfer timestamp is at most 10 min old (R5)
const MAX_COLLECTING_AS_PAYER = 2;
const RECENTLY_RESOLVED_MS = 864e5;
const WITHHELD = 'withheld until the Basis tracker records the transfer; then each party sees the signatures on its own edges';
// A transfer whose payer's owner approves it collects its other signatures for TRANSFER_TTL_MS from then, but never past
// T + 50 min: a client signs a consent only while T is at most 55 minutes old (rule R5), and the tracker refuses T past
// 1 hour.
const APPROVED_COLLECT_UNTIL_MS = 50 * 60e3;
// Journal kinds that change an issued note's claim afterwards (credit_note.pair_changes_since, spec 16.1).
const PAIR_CHANGE_KINDS = new Set(['transfer_out', 'transfer_in', 'setoff']);
// The deal's settlement label with circulating credit on (design §4.12, spec 16.1; the same text in the 0.4 clients).
const CIRCULATION_SETTLEMENT = 'not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, there is no reserve, and PC have no value.';
// A position row of a note issued by a participant the server runs (the sandbox agents; design §4.12, spec 16.1).
const OPERATOR_RUN_NOTE = Object.freeze({operator_run: true, label: 'issued with keys the operator holds'});
// The tracker's EdgeState of a note it returned (null: the edge does not exist).
const edgeState = n => (n ? {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature} : null);
// What is kept of a purged signature, and what audit lines carry: the sha256 of its 65 bytes.
const sigSha256 = sig => crypto.createHash('sha256').update(Buffer.from(String(sig), 'hex')).digest('hex');
const sameState = (a, b) => (a == null ? b == null : b != null && a.total === b.total && a.timestamp === b.timestamp && a.signature === b.signature);
// ---------- circulating credit: multilateral set-off (design §4.6, §5.4, §5.5, §5.7; spec 18.7, 18.9, 18.12) ----------
// Set-off states (s.setoffs[vs_...].state): live ones (collecting, applying) hold their edges; every other state is an
// end (applied; failed, expired, refused, superseded, void_key_revoked without effect; inconsistent: the read-back
// could not decide, an alarm for the operator).
const LIVE_SETOFF = new Set(['collecting', 'applying']);
const SETOFF_SLOTS = Object.freeze(['issuer', 'recipient']);
const SETOFF_WITHHELD = 'withheld until the Basis tracker records the set-off; then each member sees the signatures on its own edges';
// Records that did not apply are dropped after 7 days; applied ones drop their signatures after 30 days (design §11),
// transfers and set-offs alike (novationHousekeeping).
const SETOFF_KEEP_MS = 7 * 864e5, SETOFF_SIGNATURES_KEEP_MS = 30 * 864e5;
const NOVATION_KEEP_MS = SETOFF_KEEP_MS, NOVATION_SIGNATURES_KEEP_MS = SETOFF_SIGNATURES_KEEP_MS;
const CLEARING_RUNS_KEPT = 20, CLEARING_REFUSALS_KEPT = 200;
const pause = ms => new Promise(r => setTimeout(r, ms));

function clean(s, max, field, {required = false} = {}) {
  if (s == null || s === '') { if (required) throw new PilotError('invalid_field', `${field} is required`); return ''; }
  if (typeof s !== 'string') throw new PilotError('invalid_field', `${field} must be text`);
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (t.length > max) throw new PilotError('invalid_field', `${field} is longer than ${max} characters`);
  if (required && !t) throw new PilotError('invalid_field', `${field} is required`);
  return t;
}
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
// Self-serve sandbox participants (joinSandbox): limits they can lower but never raise, and how long they last.
// max_claims_total (phase-2 credit policy) is stored and enforced only with circulating credit on; with it off setMandate
// ignores it, as any unknown field.
const SANDBOX_CAPS = {max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40, max_claims_total: SANDBOX_MAX_CLAIMS_TOTAL}, SANDBOX_DAYS = 7;
const SANDBOX_JOINS_PER_DAY = 200;
// The open network (Pilot openNetwork, PILOT_OPEN_NETWORK=1): a self-serve participant may deal with any participant
// whose own mandate allows it (other self-serve participants, invited participants, the sandbox agents), still within
// SANDBOX_CAPS and its SANDBOX_DAYS. It has at most this many offers of its own open (or waiting for its owner) at once,
// so one stranger cannot flood other agents' inboxes. Off, a self-serve participant deals with the sandbox agents only,
// as before, and that is enforced at every action (a mandate written while it was on does not reopen it).
export const OPEN_NETWORK_MAX_OPEN_OFFERS = 10;
// With the open network, an active self-serve agent stays: when its agent is seen with less than this many days of
// sandbox time left (or after the time ended), the time is renewed to SANDBOX_DAYS from then (Pilot.renewSandbox), so
// it is renewed at most once a day and ends SANDBOX_DAYS after its agent was last seen.
export const SANDBOX_RENEW_WITHIN_DAYS = 6;
// A Basis signature is a compressed point (02/03 prefix) followed by a 32-byte scalar.
const SIG_RE = /^0[23][0-9a-f]{128}$/, KEY_RE = /^0[23][0-9a-f]{64}$/, PID_RE = /^vp_[0-9a-f]{12}$/;
// Characters that hide text or make it display differently from what was signed: C0/C1 controls other than tab,
// newline and CR; zero-width space; word joiner and invisible operators; bidi overrides and isolates; BOM;
// interlinear annotation; Unicode tag characters (invisible text an LLM still reads). Refused in signed and public text
// (F9, F10). Allowed on purpose: ZWNJ/ZWJ (Persian, Indic scripts, emoji sequences) and LRM/RLM/ALM marks.
// Also refused since 2026-11-07 (OQ-33 residual): U+00AD soft hyphen; the Hangul fillers U+115F, U+1160, U+3164 and
// U+FFA0 (they show as blank space); the ideographic variation selectors U+E0100-U+E01EF; and a variation selector
// U+FE00-U+FE0F that does not directly follow an emoji character (a run of them after any character, or one after
// ordinary text, is invisible and can carry hidden data). Emoji presentation (U+FE0F after an emoji), keycaps and skin
// tones stay allowed. Tag characters stay refused except inside the three RGI subdivision flags (England, Scotland,
// Wales: U+1F3F4, the tag letters gbeng / gbsct / gbwls, U+E007F); any other tag sequence could spell hidden text.
// Tightened (OQ-33 residual, rev 4): after an emoji only U+FE0E/U+FE0F are allowed (U+FE00-U+FE0D could carry hidden
// values); after 0-9, # or * only inside a keycap (followed by U+20E3); also refused: U+180E, U+034F, U+206A-U+206F and
// U+1D173-U+1D17A (invisible format characters).
// The rule (OQ-33, rev 5): refuse every control (Cc, except tab/LF/CR), format (Cf) and Default_Ignorable_Code_Point
// character: together they cover every invisible character, assigned or not, that could hide text from a reader
// while an agent still reads it. Allowed, because real text needs them, but only singly (never a run): ZWNJ, ZWJ,
// LRM, RLM, ALM. Allowed in context: U+FE0E/U+FE0F directly after an emoji other than 0-9 # *; a keycap (0-9 # *,
// U+FE0F, U+20E3); the three RGI subdivision flags (U+1F3F4, tag letters gbeng / gbsct / gbwls, U+E007F).
const IGNORABLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u, EMOJI = /\p{Emoji}/u;
const SINGLE_OK = new Set([0x200c, 0x200d, 0x200e, 0x200f, 0x061c]), FLAG_TAGS = new Set(['gbeng', 'gbsct', 'gbwls']);
const keycapBase = cp => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a;
export function hasUnsafeText(s) {
  const cps = Array.from(String(s), c => c.codePointAt(0));
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 9 || cp === 10 || cp === 13) continue;
    if (SINGLE_OK.has(cp)) { if (SINGLE_OK.has(cps[i + 1])) return true; continue; }
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
    if (IGNORABLE.test(String.fromCodePoint(cp))) return true;
  }
  return false;
}
const RESERVED_HANDLES = new Set(['valun', 'admin', 'administrator', 'operator', 'owner', 'system', 'support', 'root', 'basis', 'tracker', 'null', 'undefined']);
function signedText(s, max, field) {
  const out = clean(s, max, field, {required: true});          // same type, length and required checks (and codes) as before
  if (hasUnsafeText(s)) throw new PilotError('invalid_field', `${field} contains control, bidi or zero-width characters; remove them and sign again`);
  if (s.length > max + 100) throw new PilotError('invalid_field', `${field} is longer than ${max} characters (including padding)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
export class PilotStore {
  constructor(dir) {
    this.dir = dir; fs.mkdirSync(dir, {recursive: true});
    this.file = path.join(dir, 'pilot-state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : {version: 1, network: NETWORK, createdAt: new Date().toISOString(), participants: {}, deals: {}, approvals: {}, invites: {}};
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1)); fs.renameSync(tmp, this.file); }
  audit(e) { fs.appendFileSync(path.join(this.dir, 'pilot-audit.jsonl'), JSON.stringify({at: new Date().toISOString(), ...e}) + '\n'); }
  // The append-only edge journal (lib/pilot/journal.mjs), one entry per line; written right after the save that holds them.
  appendEdgeLog(entries) { fs.appendFileSync(path.join(this.dir, EDGE_LOG_FILE), entries.map(e => JSON.stringify(e) + '\n').join('')); }
}

// ---------------------------------------------------------------------------------------------------------------
export class Pilot {
  // Circulating credit (design §4.1): `circulation` is the mode the operator asks for (PILOT_CIRCULATION: off, bound,
  // sandbox or on; default off); `trackerCaps` the pilot tracker's GET /capabilities data (null: none, a tracker before
  // v3; undefined: not read yet, as while server.mjs starts); `trackerSha256` the running tracker binary's sha256
  // (PILOT_TRACKER_SHA256, computed by the launcher); `trackerPins` the pinned hashes (lib/pilot/pins.mjs; tests may
  // pass their own). The effective mode is `mode` below. `log` receives one line per distinct reason the mode is off.
  constructor({store, basis, unitLabel = 'PC', now = () => Date.now(), openSandbox = false, openNetwork = false,
    circulation = 'off', trackerCaps = undefined, trackerSha256 = null, trackerPins = TRACKER_SHA256_PINS, log = m => console.warn(m)}) {
    this.store = store; this.basis = basis; this.unit = unitLabel; this.now = now;
    this.openSandbox = openSandbox; this.sandboxIds = new Set();   // filled by the Sandbox when it starts
    this.openNetwork = !!openNetwork;   // self-serve participants may deal with anyone (OPEN_NETWORK_MAX_OPEN_OFFERS)
    this.lock = Promise.resolve();
    this.log = log; this.modeLogged = new Set(); this.edgeLogQueue = [];
    // Functions called after a change others may react to (the Sandbox's poke): {deal, event} after every deal event,
    // {participant, event: 'enrolled'} after an enrollment. Called with the lock held, so a listener only schedules
    // work; what it throws is ignored.
    this.changeListeners = new Set();
    this.circulationConfig = {circulation, trackerCaps, trackerSha256, trackerPins};
    this.writesRefused = null;          // MIG-1 (release v16.1): {code, reason, since} while pilot writes are refused (writeRefusal)
    this.migrate();
    this.constructed = true;
    if (trackerCaps !== undefined) this.writeRefusal();
  }
  get s() { return this.store.state; }

  // ---------- circulating credit: the effective mode (lib/pilot/caps.mjs) ----------
  // Changing any of these after construction (server.mjs sets trackerCaps once it has read them) runs migrate() again,
  // which adds what the new mode needs; it is idempotent.
  get circulation() { return this.circulationConfig.circulation; }
  set circulation(v) { this.configureCirculation({circulation: v}); }
  get trackerCaps() { return this.circulationConfig.trackerCaps; }
  set trackerCaps(v) { this.configureCirculation({trackerCaps: v}); if (this.constructed) this.writeRefusal(); }
  get trackerSha256() { return this.circulationConfig.trackerSha256; }
  set trackerSha256(v) { this.configureCirculation({trackerSha256: v}); }
  get trackerPins() { return this.circulationConfig.trackerPins; }
  set trackerPins(v) { this.configureCirculation({trackerPins: v}); }
  configureCirculation(changes) {
    Object.assign(this.circulationConfig, changes);
    if (this.constructed) this.migrate();
  }
  // {requested, mode, reason, pending}: see effectiveMode (caps.mjs).
  circulationStatus() {
    const c = this.circulationConfig;
    return effectiveMode({requested: c.circulation, caps: c.trackerCaps, sha256: c.trackerSha256, pins: c.trackerPins});
  }
  // The effective mode: the requested one only when the tracker's capabilities validate and its binary's sha256 is
  // pinned; otherwise 'off' (fail closed), with the reason logged once. While the capabilities have not been read yet
  // (server start) nothing is logged.
  get mode() {
    const st = this.circulationStatus();
    if (st.reason && !st.pending) {
      const line = `Pilot: circulation ${JSON.stringify(st.requested)} was requested; running with circulation off (fail closed): ${st.reason}`;
      if (!this.modeLogged.has(line)) { this.modeLogged.add(line); this.log?.(line); }
    }
    return st.mode;
  }
  // Novations, consents and the circulation fields of mandates, positions and reconciliation: modes sandbox and on.
  get circulating() { const m = this.mode; return m === 'sandbox' || m === 'on'; }

  // The timestamp residues the tracker keeps for operations other than ordinary notes (tracker v3: 995-999), or null
  // for a tracker that reports none. From trackerCaps when they name them; otherwise read from the tracker (Basis keeps a
  // read that answered), so that ordinary notes skip those residues on a v3 tracker in every mode. trackerCaps null may
  // be a capabilities read at startup that failed (server.mjs: the mode stays off until a restart, fail closed), so
  // without residues the tracker is asked again, at most once per CAPS_REREAD_MS (MIG-5); a tracker without
  // capabilities (3df7ed93) keeps v15's templates.
  async reservedResidues() {
    const valid = c => (Array.isArray(c?.reserved_ms) && c.reserved_ms.every(Number.isSafeInteger) ? c.reserved_ms : null);
    const given = valid(this.trackerCaps);
    if (given || typeof this.basis?.capabilities !== 'function') return given;
    const now = this.now();
    if (this.trackerCaps !== undefined && typeof this.basis.refresh === 'function' && !(now - (this.capsRereadAt ?? -Infinity) < CAPS_REREAD_MS)) {
      this.capsRereadAt = now;
      return valid(await this.basis.refresh().catch(() => null));
    }
    return valid(await this.basis.capabilities().catch(() => null));
  }

  // State written by earlier versions: one revoked key per participant (now a list); versions without an offered_at
  // marker (now: when the counterparty could first see the version; null = never offered).
  migrate() {
    let changed = false;
    // Mandate fields added after a participant joined start at their neutral defaults (every new one is 0/false = off).
    for (const p of Object.values(this.s.participants)) if (p.mandate) for (const [k, v] of Object.entries(DEFAULT_MANDATE)) {
      if (k !== 'expires_at' && p.mandate[k] === undefined) { p.mandate[k] = v; changed = true; }
    }
    for (const p of Object.values(this.s.participants)) if (!Array.isArray(p.past_pubkeys)) {
      p.past_pubkeys = p.pubkey_revoked ? [{pubkey: p.pubkey_revoked, registered_at: null, revoked_at: null}] : [];
      delete p.pubkey_revoked; changed = true;
    }
    for (const d of Object.values(this.s.deals)) for (const v of [...d.versions, ...(d.pending_counter ? [d.pending_counter] : []), ...(d.superseded_counters || [])]) {
      if (v.offered_at !== undefined) continue;
      v.offered_at = v.owner_approval?.at ?? (v.approval_id ? null : v.created_at); changed = true;
    }
    // Earlier versions kept only the most recently revoked key, so a second revocation lost the link to the first key.
    // Every version's terms name each party's key as registered when it was signed: recover lost links from them.
    for (const d of Object.values(this.s.deals)) for (const v of d.versions) for (const r of ['payer', 'payee']) {
      const x = v.terms?.[r], q = x && this.s.participants[x.id];
      if (!q || !x.pubkey || q.pubkey === x.pubkey || (q.past_pubkeys || []).some(k => k.pubkey === x.pubkey)) continue;
      q.past_pubkeys = [...(q.past_pubkeys || []), {pubkey: x.pubkey, registered_at: null, revoked_at: null, recovered_from: `deal ${d.id} terms`}];
      changed = true;
    }
    // The first pilot version called an issued credit note a "payment": statuses paid / paying / payment_failed, and the
    // note record d.payment {state, note, prior_total, started_at, ...}. A payment by debt transfer (circulating credit)
    // is kept as d.payment too, but always with its method ({method: 'transfer', transfer_id, applied_at?}), so only a
    // record without a method is the first version's note record; a v16 payment is never renamed into a credit note.
    const renamed = {paid: 'note_issued', paying: 'issuing_note', payment_failed: 'note_failed'};
    for (const d of Object.values(this.s.deals)) {
      if (renamed[d.status]) { d.status = renamed[d.status]; changed = true; }
      if (d.payment && typeof d.payment === 'object' && d.payment.method === undefined && !d.credit_note) {
        d.credit_note = {...d.payment, amount: d.payment.amount ?? d.agreement?.terms.price.amount, ...(d.payment.state === 'recorded' ? {outstanding: true, settled: false} : {})};
        delete d.payment; changed = true;
      }
    }
    // Circulating credit (in every mode, invisible with circulation off): the collections for transfers, set-offs, the
    // clearing engine and the edge journal; then the journal backfill, from the note_issued deals (lib/pilot/journal.mjs).
    if (ensureJournal(this.s)) changed = true;
    // At startup, journal entries a crash kept out of pilot-edge-log.jsonl are appended to it (the state holds them).
    if (!this.constructed) { const n = repairEdgeLog(this); if (n) this.store.audit({type: 'journal.log_repaired', entries: n}); }
    const backfilled = backfillJournal(this);
    if (backfilled) { changed = true; this.store.audit({type: 'journal.backfilled', entries: backfilled, first: !this.s.counters.journal_backfilled}); }
    if (!this.s.counters.journal_backfilled) { this.s.counters.journal_backfilled = true; changed = true; }
    // With circulation on, a participant who joined before has the credit-policy fields at their LEGACY values: nothing
    // moves, is cleared or is accepted for it until its owner says so.
    if (this.circulating) for (const p of Object.values(this.s.participants)) if (p.mandate) for (const [k, v] of Object.entries(LEGACY_CIRCULATION())) {
      if (p.mandate[k] === undefined) { p.mandate[k] = v; changed = true; }
    }
    if (changed) this.save();
  }
  // One global lock for every change to deals, approvals and the tracker: a promise chain, so calls run one at a time in
  // arrival order. Methods that run inside serial() (submitNote, settleAcceptance, form, voidPending, the approval and
  // revocation helpers, and every later apply or recovery helper) never call serial() themselves: a nested call would
  // wait for the call holding the lock, which waits for it, so both would hang. Public entry points take the lock once;
  // recover() takes it itself (at startup and every 60 s, server.mjs).
  serial(fn) { const run = this.lock.then(fn, fn); this.lock = run.catch(() => {}); return run; }
  // Journal entries written since the last save reach pilot-edge-log.jsonl right after the state that holds them.
  // Every save bumps `generation`: the public read cache (lib/pilot/http.mjs) serves an entry only while it is unchanged.
  save() { this.store.save(); flushEdgeLog(this); this.generation = (this.generation ?? 0) + 1; }

  // ---------- identities & credentials ----------
  createInvite({note = '', maxUses = 1, ttlDays = 14} = {}) {
    if (!isInt(maxUses, 1, 1000) || !isInt(ttlDays, 1, 90)) throw new PilotError('invalid_field', 'max_uses must be 1..1000 and ttl_days 1..90 (whole numbers)');
    const code = 'vpi_' + crypto.randomBytes(9).toString('base64url');
    const id = rid('inv_', 4);
    this.s.invites[id] = {id, code_hash: sha256(code), note: clean(note, 200, 'note'), max_uses: maxUses, uses: 0,
      created_at: iso(this.now()), expires_at: iso(this.now() + ttlDays * 864e5)};
    this.save(); this.store.audit({type: 'invite.created', id});
    return {id, code, expires_at: this.s.invites[id].expires_at};
  }

  join({invite, handle, display_name, operator, about, services}) {
    return this.serial(async () => {
      const inv = Object.values(this.s.invites).find(i => i.code_hash === sha256(String(invite || '')));
      if (!inv || inv.uses >= inv.max_uses || Date.parse(inv.expires_at) < this.now()) throw new PilotError('invalid_invite', 'invite code is invalid, used up or expired', 403);
      handle = clean(handle, 24, 'handle', {required: true}).toLowerCase();
      if (!/^[a-z][a-z0-9_-]{2,23}$/.test(handle)) throw new PilotError('invalid_field', 'handle: 3-24 characters, letters, digits, _ or -, starting with a letter');
      // A handle shaped like a participant id (vp_ + 12 hex) could be taken for another participant wherever a handle or
      // an id is accepted (for example an issuer named to pay with): refused in every mode (join and join-sandbox).
      if (PID_RE.test(handle)) throw new PilotError('invalid_field', 'handle: must not look like a participant id (vp_ followed by 12 hex digits)');
      // Names are compared in a normalized form (letters and digits only, lower case): "Bea-Briefs", "bea briefs" and
      // "bea_briefs" are the same name to a reader.
      const others = Object.values(this.s.participants), norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const reserved = s => [...RESERVED_HANDLES].some(r => norm(s) === norm(r));
      if (RESERVED_HANDLES.has(handle) || reserved(handle)) throw new PilotError('handle_taken', 'that handle is reserved', 409);
      if (others.some(p => p.handle === handle || norm(p.handle) === norm(handle) || norm(p.display_name) === norm(handle)))
        throw new PilotError('handle_taken', "that handle is taken (as another participant's handle or display name)", 409);
      for (const [f, v] of Object.entries({display_name, operator, about, services}))
        if (typeof v === 'string' && hasUnsafeText(v)) throw new PilotError('invalid_field', `${f} contains control, bidi or invisible characters`);
      const shown = norm(clean(display_name, 40, 'display_name'));
      if (shown && shown !== norm(handle) && (reserved(shown) || others.some(p => norm(p.handle) === shown || norm(p.display_name) === shown)))
        throw new PilotError('display_name_taken', "display_name must not be reserved or copy another participant's handle or display name", 409);
      const ownerToken = token('vpo_'), code = 'vpe_' + crypto.randomBytes(12).toString('base64url');
      const p = {
        id: rid('vp_', 6), handle, display_name: clean(display_name, 40, 'display_name') || handle,
        operator: clean(operator, 60, 'operator', {required: true}), about: clean(about, 300, 'about'), services: clean(services, 300, 'services'),
        pubkey: null, status: 'awaiting_agent', created_at: iso(this.now()), invite_id: inv.id,
        owner_token_hash: sha256(ownerToken), agent_token_hash: null,
        enrollment: {code_hash: sha256(code), expires_at: iso(this.now() + ENROLL_TTL_MS)},
        // With circulation on, an invited joiner clears and novates its own debt automatically (net-neutral), but
        // accepts no transfers and nobody's notes until its owner names whose (design §8).
        mandate: {...DEFAULT_MANDATE, expires_at: iso(this.now() + 14 * 864e5), ...(this.circulating ? INVITE_CIRCULATION() : {})}, mandate_version: 1,
        last_seen_agent: null, last_seen_owner: null,
      };
      inv.uses += 1;
      this.s.participants[p.id] = p; this.save();
      this.store.audit({type: 'participant.joined', id: p.id, handle, invite: inv.id});
      return {participant_id: p.id, handle, owner_token: ownerToken, enrollment_code: code, enrollment_expires_at: p.enrollment.expires_at};
    });
  }

  // `by`: 'owner' (owner console / owner token) or 'operator' (the network operator on the host, at the owner's request;
  // shown to the owner).
  newEnrollmentCode(p, {by = 'owner'} = {}) {
    const code = 'vpe_' + crypto.randomBytes(12).toString('base64url');
    p.enrollment = {code_hash: sha256(code), expires_at: iso(this.now() + ENROLL_TTL_MS), issued_by: by};
    this.save(); this.store.audit({type: 'enrollment.code_issued', id: p.id, by});
    return {enrollment_code: code, enrollment_expires_at: p.enrollment.expires_at};
  }

  enroll({participant_id, code, pubkey, signature}) {
    return this.serial(async () => {
      const p = typeof participant_id === 'string' && Object.hasOwn(this.s.participants, participant_id) ? this.s.participants[participant_id] : null;
      if (!p || !p.enrollment || typeof code !== 'string' || p.enrollment.code_hash !== sha256(code) || Date.parse(p.enrollment.expires_at) < this.now())
        throw new PilotError('invalid_enrollment', 'enrollment code is invalid or expired; the owner can issue a new one', 403);
      if (typeof pubkey !== 'string' || !KEY_RE.test(pubkey)) throw new PilotError('invalid_field', 'pubkey must be a 33-byte compressed key (hex string)');
      // A key is registered once, ever: tracker notes are keyed by public key, so a reused key would blur who owes what.
      if (Object.values(this.s.participants).some(o => o.pubkey === pubkey || (o.past_pubkeys || []).some(k => k.pubkey === pubkey)))
        throw new PilotError('key_in_use', 'this key is registered, or was registered before; enroll a newly generated key', 409);
      const ok = await this.safeVerify(pubkey, hexOf(statements.enroll(p.id, pubkey, p.enrollment.code_hash)), signature);
      if (!ok) throw new PilotError('bad_signature', 'proof-of-possession signature does not verify', 403);
      const agentToken = token('vpa_');
      p.pubkey = pubkey; p.agent_token_hash = sha256(agentToken); p.enrollment = null; p.status = 'active'; p.key_registered_at = iso(this.now());
      p.last_seen_agent = null;                      // "last seen" is per key: the new agent has not been seen yet
      this.save(); this.store.audit({type: 'participant.enrolled', id: p.id, pubkey});
      this.notifyChange({participant: p, event: 'enrolled'});
      return {participant_id: p.id, agent_token: agentToken, network: NETWORK};
    });
  }

  // `features`: the agent's X-Valun-Features header (design §4.1): with circulation on (modes sandbox and on) a client
  // that can sign consents declares 'consents/1;roles=<setoff,issuer,creditor>', and the roles are kept as
  // p.client_features {consents, roles, at} (consentCapable). Each declaration replaces the one before: a client whose
  // consent roles are all off (or that stopped processing consents) sends 'consents/1;roles=' (empty), and from that
  // request on no role counts for it, at once, with no 7-day carry-over (decision D-3 b); a request without the header
  // changes nothing. Owner requests never set it.
  authenticate(bearer, {features} = {}) {
    if (!bearer) return null;
    const h = sha256(bearer);
    for (const p of Object.values(this.s.participants)) {
      if (p.agent_token_hash && p.agent_token_hash === h && p.status === 'active') {
        p.last_seen_agent = iso(this.now());
        if (p.sandbox_only && this.openNetwork) this.renewSandbox(p);
        const f = features !== undefined && this.circulating ? parseFeatures(features) : null;
        if (f) p.client_features = {consents: true, roles: f.roles, at: iso(this.now())};
        return {role: 'agent', p};
      }
      if (p.owner_token_hash === h) { p.last_seen_owner = iso(this.now()); return {role: 'owner', p}; }
    }
    return null;
  }
  // A participant whose agent the server runs (the sandbox agents, through pilot.serverSigner: has(id), signFor(id,
  // messageHex, {op}), installed by the Sandbox; op names the operation, a transfer's or set-off's id, so the signer can
  // keep one operation per (edge, timestamp)): it signs its consents at once and is always present. With circulating
  // credit on, its participant record and its credit history are labelled operator_run (the operator holds its keys).
  serverRun(p) { return !!p && typeof this.serverSigner?.has === 'function' && !!this.serverSigner.has(p.id); }
  // A self-serve sandbox participant whose sandbox time has ended.
  dormant(p) { return !!p?.sandbox_only && Date.parse(p.sandbox_expires_at) < this.now(); }
  // The open network keeps an active self-serve agent (SANDBOX_RENEW_WITHIN_DAYS): its sandbox time, and its mandate's
  // expiry with it, move to SANDBOX_DAYS from now; one that had ended (dormant) wakes up. A mandate expiry its owner set
  // earlier than the sandbox end stays as the owner set it. The mandate change is recorded as the operator's.
  renewSandbox(p) {
    const now = this.now(), end = Date.parse(p.sandbox_expires_at);
    if (Number.isFinite(end) && end - now >= SANDBOX_RENEW_WITHIN_DAYS * 864e5) return false;
    const until = iso(now + SANDBOX_DAYS * 864e5), from = p.sandbox_expires_at;
    const ownerEarlier = !!p.mandate?.expires_at && Number.isFinite(end) && Date.parse(p.mandate.expires_at) < end;
    p.sandbox_expires_at = until;
    if (ownerEarlier) this.save(); else this.setMandate(p, {expires_at: until}, {by: 'operator'});
    this.store.audit({type: 'participant.sandbox_renewed', id: p.id, from, until, ...(ownerEarlier ? {mandate_expiry_kept: p.mandate.expires_at} : {})});
    return true;
  }
  // What GET /info says about joining without an invite (null when this server does not offer it).
  selfServe() {
    return this.openSandbox ? {join: '/pilot/v1/join-sandbox', open_network: this.openNetwork, days: SANDBOX_DAYS, limits: {...SANDBOX_CAPS},
      ...(this.openNetwork ? {max_open_offers: OPEN_NETWORK_MAX_OPEN_OFFERS, renews_while_active: true} : {})} : null;
  }
  // Whether p can sign a consent in `role` (setoff, issuer or creditor): server-run, or its client declared the role
  // (X-Valun-Features) within the last 7 days.
  consentCapable(p, role) {
    if (this.serverRun(p)) return true;
    const f = p?.client_features;
    return !!(f?.consents && Array.isArray(f.roles) && f.roles.includes(role) && this.now() - Date.parse(f.at) <= CONSENT_ROLE_MS);
  }
  // Present: server-run, or its agent was seen in the last 10 minutes.
  present(p) { return this.serverRun(p) || (!!p?.last_seen_agent && this.now() - Date.parse(p.last_seen_agent) <= PRESENCE_MS); }
  // How soon p signs a consent in `role` (payment options, design §4.5): immediate, auto, when_online or unavailable.
  consentSpeed(p, role) {
    if (this.serverRun(p)) return 'immediate';
    if (!this.consentCapable(p, role)) return 'unavailable';
    return this.present(p) ? 'auto' : 'when_online';
  }
  // In mode sandbox, novations only between sandbox agents and sandbox_only participants.
  inSandbox(p) { return !!p && (this.sandboxIds?.has(p.id) || !!p.sandbox_only); }
  // Whether the circulation routes exist for p: mode on, or mode sandbox and p is a sandbox party.
  circulationFor(p) { const m = this.mode; return m === 'on' || (m === 'sandbox' && this.inSandbox(p)); }

  // The owner revokes the agent: its token and key stop working at once. Everything not yet agreed that names the revoked
  // key ends ("cancelled"): offers either side made, acceptances waiting for an owner. A credit note the agent signed that
  // waits for the owner is voided (the deal returns to "delivered"). Agreed deals stand: they bind the participant, and
  // the next enrolled key delivers, accepts or issues the credit note for them.
  revokeAgent(p) {
    return this.serial(async () => {
      if (!p.pubkey) throw new PilotError('no_agent', 'no agent key is registered; issue an enrollment code instead', 409);
      const at = iso(this.now()), old = p.pubkey;
      p.past_pubkeys = [...(p.past_pubkeys || []), {pubkey: old, registered_at: p.key_registered_at ?? null, revoked_at: at}];
      p.agent_token_hash = null; p.pubkey = null; p.status = 'awaiting_agent'; p.last_seen_agent = null; p.key_registered_at = null;
      const cancelled = [], voided = [];
      // Circulating credit: a transfer collecting signatures, or waiting for the payer's owner, that names the revoked key
      // in any role (issuer, payer or payee) is voided and purged; its deal becomes payment_due (or returns to delivered
      // while it was still waiting for the owner). This runs first, so the deals below see their new status. A transfer
      // being applied is left to recovery, which decides by read-back.
      const voidedTransfers = [];
      for (const t of Object.values(this.s.transfers || {})) {
        if ((t.state === 'collecting' || t.state === 'awaiting_owner') && [t.issuer, t.payer, t.payee].some(x => x.pubkey === old)) {
          this.endTransfer(t, 'void_key_revoked', 'key_revoked', {participant: p.id});
          voidedTransfers.push(t.id);
        }
      }
      // A set-off collecting signatures with an edge under the revoked key is voided and purged too (one being applied
      // is left to recovery, which decides by read-back); the edges under that key are frozen from now on.
      const voidedSetoffs = [];
      for (const o of Object.values(this.s.setoffs || {})) {
        if (o.state === 'collecting' && o.edges.some(e => e.issuer.pubkey === old || e.recipient.pubkey === old)) {
          this.endSetoff(o, 'void_key_revoked', 'key_revoked');
          voidedSetoffs.push(o.id);
        }
      }
      for (const d of Object.values(this.s.deals)) {
        if (d.payer !== p.id && d.payee !== p.id) continue;
        // What happens to each status: STATUS_CLASS[status].revoke (lib/pilot/status.mjs). 'void_transfer'
        // (paying_by_transfer) was handled above, by the transfer (an applying one is left to recovery).
        const revoke = statusClass(d.status)?.revoke ?? 'keep';
        if (revoke === 'cancel') {
          const cur = this.current(d);
          if (['open', 'awaiting_owner'].includes(cur.state)) cur.state = 'cancelled';
          if (d.acceptance && d.acceptance.state === 'awaiting_owner') d.acceptance.state = 'cancelled';
          this.voidPending(d, 'key_revoked');
          d.status = 'cancelled'; d.cancellation = {reason: 'agent_key_revoked', participant: p.id, revoked_pubkey: old, at};
          this.event(d, 'valun', 'cancelled', {reason: 'agent_key_revoked', participant: p.id}, this.visibleTo(d, this.s.participants[d.payer === p.id ? d.payee : d.payer]) ? null : d.versions[0].by);
          cancelled.push(d.id);
        } else if (revoke === 'void_held_note' && d.credit_note) {
          d.void_notes = [...(d.void_notes || []), {...d.credit_note, state: 'void_key_revoked'}];
          // A deal whose acceptance already stood (payment_due, circulating credit) keeps it and owes the payment again.
          d.credit_note = null; this.releaseAcceptance(d);
          this.voidPending(d, 'key_revoked');
          this.event(d, 'valun', 'credit_note_void', {reason: 'agent_key_revoked', participant: p.id});
          voided.push(d.id);
        }
      }
      const code = this.newEnrollmentCode(p);
      this.store.audit({type: 'agent.revoked', id: p.id, pubkey: old, cancelled, voided_credit_notes: voided, ...(voidedTransfers.length ? {voided_transfers: voidedTransfers} : {}),
        ...(voidedSetoffs.length ? {voided_setoffs: voidedSetoffs} : {})});
      return {...code, revoked_pubkey: old, cancelled_deals: cancelled, voided_credit_notes: voided, ...(this.circulating ? {voided_transfers: voidedTransfers, voided_setoffs: voidedSetoffs} : {})};
    });
  }

  // The owner replaces its owner token (OQ-24): the new token is returned once (only its hash is kept) and the old one
  // stops working at once. The agent token and key are not affected.
  // by 'operator' (OQ-24 recovery): when an owner's token is lost or stolen (a thief could rotate it first), the pilot
  // operator issues a new one after confirming the owner out of band; shown to the owner as replaced by the operator.
  rotateOwnerToken(p, {by = 'owner'} = {}) {
    return this.serial(async () => {
      const ownerToken = token('vpo_'), at = iso(this.now());
      p.owner_token_hash = sha256(ownerToken); p.owner_token_rotated_at = at; p.owner_token_rotated_by = by;
      this.save(); this.store.audit({type: by === 'operator' ? 'owner_token.reset_by_operator' : 'owner_token.rotated', id: p.id});
      return {participant_id: p.id, owner_token: ownerToken, rotated_at: at,
        note: 'Shown once: the server keeps only a hash. The previous owner token no longer works.'};
    });
  }

  // The public profile a participant's agent or owner can change after joining: display_name, about and services (what
  // it offers), with join's checks (lengths, invisible characters, a display name that copies another participant's
  // name). The handle and the operator stay as joined. Only a real change is saved and audited.
  setProfile(p, body = {}, {by = 'agent'} = {}) {
    const next = {};
    for (const [f, max] of [['display_name', 40], ['about', 300], ['services', 300]]) if (body[f] !== undefined) {
      if (typeof body[f] === 'string' && hasUnsafeText(body[f])) throw new PilotError('invalid_field', `${f} contains control, bidi or invisible characters`);
      next[f] = clean(body[f], max, f);
    }
    if (!Object.keys(next).length) throw new PilotError('invalid_field', 'give at least one of display_name, about, services');
    if (next.display_name !== undefined) {
      const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''), shown = norm(next.display_name);
      next.display_name ||= p.handle;
      if (shown && shown !== norm(p.handle) && ([...RESERVED_HANDLES].some(r => norm(r) === shown)
        || Object.values(this.s.participants).some(q => q.id !== p.id && (norm(q.handle) === shown || norm(q.display_name) === shown))))
        throw new PilotError('display_name_taken', "display_name must not be reserved or copy another participant's handle or display name", 409);
    }
    const changed = Object.keys(next).filter(f => next[f] !== p[f]);
    if (changed.length) {
      for (const f of changed) p[f] = next[f];
      p.profile_changed_at = iso(this.now()); p.profile_changed_by = by;
      this.save(); this.store.audit({type: 'profile.updated', id: p.id, by, fields: changed});
    }
    return {participant: this.publicParticipant(p), changed};
  }

  setMandate(p, m, {by = 'owner'} = {}) {
    const cur = p.mandate, next = {...cur};
    if (m.objective !== undefined) next.objective = clean(m.objective, 1000, 'objective');
    for (const k of ['may_issue_credit', 'may_accept_credit', 'review_deliveries']) if (m[k] !== undefined) {
      if (typeof m[k] !== 'boolean') throw new PilotError('invalid_field', `${k} must be true or false`); next[k] = m[k]; }
    for (const k of ['max_issue_per_deal', 'max_issue_outstanding', 'max_accept_per_deal', 'max_accept_per_issuer', 'min_price_as_payee', 'min_payer_coverage_pct', 'approve_above']) if (m[k] !== undefined) {
      if (!isInt(m[k], 0, 100000)) throw new PilotError('invalid_field', `${k} must be a whole number 0..100000`); next[k] = m[k]; }
    if (m.counterparties !== undefined) {
      if (m.counterparties === 'any') next.counterparties = 'any';
      else if (Array.isArray(m.counterparties) && m.counterparties.every(id => typeof id === 'string' && PID_RE.test(id) && Object.hasOwn(this.s.participants, id)))
        next.counterparties = [...new Set(m.counterparties)];
      else throw new PilotError('invalid_field', 'counterparties must be "any" or a list of participant ids');
    }
    if (m.expires_at !== undefined) {
      if (m.expires_at !== null && isNaN(Date.parse(m.expires_at))) throw new PilotError('invalid_field', 'expires_at must be a date or null');
      next.expires_at = m.expires_at && iso(Date.parse(m.expires_at));
    }
    // The credit-policy fields of circulating credit (design §8) exist only in mode sandbox or on; in other modes they
    // are ignored, as any unknown field is.
    const circulating = this.circulating;
    if (circulating) {
      const ids = (v, field) => {
        if (Array.isArray(v) && v.every(id => typeof id === 'string' && PID_RE.test(id) && Object.hasOwn(this.s.participants, id))) return [...new Set(v)];
        throw new PilotError('invalid_field', `${field} must be ${field === 'accept_notes_from' ? '"any" or ' : ''}a list of participant ids`);
      };
      for (const k of ['auto_clear', 'novate_own_debt', 'accept_transfers']) if (m[k] !== undefined) {
        if (typeof m[k] !== 'boolean') throw new PilotError('invalid_field', `${k} must be true or false`); next[k] = m[k]; }
      if (m.accept_notes_from !== undefined) next.accept_notes_from = m.accept_notes_from === 'any' ? 'any' : ids(m.accept_notes_from, 'accept_notes_from');
      if (m.refuse_notes_from !== undefined) next.refuse_notes_from = ids(m.refuse_notes_from, 'refuse_notes_from');
      if (m.pay_with_held_notes !== undefined) {
        if (!PAY_WITH_HELD_NOTES.includes(m.pay_with_held_notes)) throw new PilotError('invalid_field', `pay_with_held_notes must be ${PAY_WITH_HELD_NOTES.join(', ')}`);
        next.pay_with_held_notes = m.pay_with_held_notes;
      }
      // Phase-2 credit policy (lib/pilot/policy.mjs): a mandate that does not hold one of these has its default
      // (max_claims_total null, or 40 for a sandbox joiner; max_issuer_net_debt null; accept_operator_issuers true).
      for (const k of ['max_claims_total', 'max_issuer_net_debt']) if (m[k] !== undefined) {
        if (m[k] !== null && !isInt(m[k], 0, 100000)) throw new PilotError('invalid_field', `${k} must be null (no limit) or a whole number 0..100000`);
        next[k] = m[k];
      }
      if (m.accept_operator_issuers !== undefined) {
        if (typeof m.accept_operator_issuers !== 'boolean') throw new PilotError('invalid_field', 'accept_operator_issuers must be true or false');
        next.accept_operator_issuers = m.accept_operator_issuers;
      }
    }
    // A self-serve sandbox participant stays inside its box whatever its owner asks: small limits, and an expiry that
    // cannot be extended; without the open network also only the sandbox agents as counterparties and as issuers of the
    // notes it accepts. The operator can still change it. max_claims_total (circulating credit) can be lowered, never
    // raised or set to null (no cap); a mandate without it has the box's value.
    if (p.sandbox_only && by !== 'operator') {
      const allowed = this.sandboxIds || new Set();
      if (!this.openNetwork && (next.counterparties === 'any' || !next.counterparties.every(id => allowed.has(id))))
        throw new PilotError('sandbox_only', 'a self-serve sandbox participant can only deal with the sandbox agents', 403);
      for (const [k, cap] of Object.entries(SANDBOX_CAPS)) if (next[k] === null || next[k] > cap)
        throw new PilotError('sandbox_only', `a self-serve sandbox participant's ${k} is at most ${cap}`, 403);
      if (!next.expires_at || Date.parse(next.expires_at) > Date.parse(p.sandbox_expires_at))
        throw new PilotError('sandbox_only', `a self-serve sandbox participant's mandate ends ${p.sandbox_expires_at} at the latest`, 403);
      if (!this.openNetwork && circulating && (!Array.isArray(next.accept_notes_from) || !next.accept_notes_from.every(id => allowed.has(id))))
        throw new PilotError('sandbox_only', 'a self-serve sandbox participant can only accept notes issued by the sandbox agents', 403);
    }
    // Only a real change makes a new mandate version (OQ-13): an empty PUT, the same values, the same counterparties in
    // another order or the same expiry instant written differently leave the version, and who changed it, as they were.
    // The same holds for the two lists of the credit policy, and for a phase-2 field set to the default it had already.
    const sorted = (x, k) => (Array.isArray(x[k]) ? {[k]: [...x[k]].sort()} : {});
    const comparable = x => canonical({...x, counterparties: Array.isArray(x.counterparties) ? [...x.counterparties].sort() : x.counterparties,
      ...sorted(x, 'accept_notes_from'), ...sorted(x, 'refuse_notes_from'), ...Object.fromEntries(PHASE2_FIELDS.map(k => [k, policyValue(p, x, k)]))});
    if (comparable(next) === comparable(cur)) return {mandate: cur, mandate_version: p.mandate_version, changed_by: p.mandate_changed_by || 'owner', changed: false};
    p.mandate = next; p.mandate_version += 1; p.mandate_changed_by = by; p.mandate_changed_at = iso(this.now()); this.save();
    this.store.audit({type: 'mandate.updated', id: p.id, version: p.mandate_version, by});
    return {mandate: next, mandate_version: p.mandate_version, changed_by: by, changed: true};
  }

  // Limits an agent records from what its owner tells it (in conversation). They can only be stricter than the owner's
  // mandate (a lower cap or a higher floor); the server enforces the stricter of the two at every action. The owner's
  // mandate stays the ceiling: an agent can never raise it. `notes`: the owner's goals in the agent's words (private).
  // `by`: 'agent' or 'owner' (the owner token may use the same route). Who recorded each field is kept beside the limits
  // (`agent_limits_recorded_by`), so refusals and views name the right source (OQ-20). Fields recorded before that was
  // kept count as recorded by the agent, as they were labelled before.
  // With circulating credit on (modes sandbox and on) the credit-policy fields can be recorded too, only ever stricter
  // (lib/pilot/policy.mjs: agentLimitWidens); in other modes they are ignored, as any unknown field is.
  setAgentLimits(p, body = {}, {by = 'agent'} = {}) {
    const next = {...(p.agent_limits || {})}, recordedBy = {...(p.agent_limits_recorded_by || {})}, circulating = this.circulating;
    for (const [k, kind] of Object.entries(AGENT_LIMIT_FIELDS)) {
      if (body[k] === undefined || (CIRCULATION_LIMIT_KINDS.has(kind) && !circulating)) continue;
      if (body[k] === null) { delete next[k]; delete recordedBy[k]; continue; }
      if (CIRCULATION_LIMIT_KINDS.has(kind)) {
        const value = this.agentLimitValue(k, kind, body[k]), owner = this.ownerValue(p, k);
        const wider = agentLimitWidens(kind, k, owner, value);
        if (wider) throw new PilotError(wider.code, wider.message, 403, {field: k, owner_value: owner ?? null});
        next[k] = value; recordedBy[k] = by;
        continue;
      }
      if (!isInt(body[k], 0, 100000)) throw new PilotError('invalid_field', `${k} must be a whole number 0..100000 (or null to clear it)`);
      const owner = p.mandate[k] ?? 0;
      if (kind === 'cap' && body[k] > owner) throw new PilotError('above_owner_mandate', `${k} ${body[k]} is above the owner's ceiling of ${owner}; only the owner can raise that`, 403, {field: k, owner_value: owner});
      if (kind === 'floor' && body[k] < owner) throw new PilotError('below_owner_mandate', `${k} ${body[k]} is below the owner's minimum of ${owner}; only the owner can lower that`, 403, {field: k, owner_value: owner});
      next[k] = body[k]; recordedBy[k] = by;
    }
    if (body.notes !== undefined) { next.notes = clean(body.notes, 1000, 'notes'); recordedBy.notes = by; }
    next.set_at = iso(this.now());
    p.agent_limits = next; p.agent_limits_recorded_by = recordedBy; this.save();
    this.store.audit({type: 'agent_limits.updated', id: p.id, by, fields: Object.keys(next).filter(k => k in AGENT_LIMIT_FIELDS)});
    return {agent_limits: next, agent_limits_recorded_by: recordedBy, effective_limits: this.effectiveLimits(p)};
  }
  // An agent limit of a credit-policy kind (ncap, off_only, allow, deny), checked for its type: a whole number; true or
  // false (one of PAY_WITH_HELD_NOTES for pay_with_held_notes); a list of participant ids, without repeats (an agent
  // cannot record 'any': it would be no limit).
  agentLimitValue(k, kind, v) {
    const bad = what => { throw new PilotError('invalid_field', `${k} must be ${what} (or null to clear it)`); };
    if (kind === 'ncap') return isInt(v, 0, 100000) ? v : bad('a whole number 0..100000');
    if (kind === 'off_only') {
      if (k === 'pay_with_held_notes') return PAY_WITH_HELD_NOTES.includes(v) ? v : bad(PAY_WITH_HELD_NOTES.join(', '));
      return typeof v === 'boolean' ? v : bad('true or false');
    }
    if (Array.isArray(v) && v.every(id => typeof id === 'string' && PID_RE.test(id) && Object.hasOwn(this.s.participants, id))) return [...new Set(v)];
    return bad('a list of participant ids');
  }
  // The owner's value of field k: the mandate's, or a phase-2 field's default when the mandate does not hold it.
  ownerValue(p, k) { return policyValue(p, p.mandate, k); }
  limitRecordedBy(p, k) { return (p.agent_limits_recorded_by || {})[k] ?? 'agent'; }
  // With circulating credit on (modes sandbox and on), a phase-2 field whose default is enforced for p without the mandate
  // holding it (a sandbox_only participant's max_claims_total 40, policy.mjs impliedPhase2) is shown at that value.
  effectiveLimits(p) {
    const m = p.mandate, a = p.agent_limits || {}, out = {...m, ...(this.circulating ? impliedPhase2(p, m) : {})};
    for (const [k, kind] of Object.entries(AGENT_LIMIT_FIELDS)) if (a[k] != null) {
      out[k] = kind === 'cap' ? Math.min(m[k], a[k]) : kind === 'floor' ? Math.max(m[k] || 0, a[k]) : strictestLimit(kind, k, this.ownerValue(p, k), a[k]);
    }
    return out;
  }
  // Which limit set gave the value that refused, for rule k: the agent's recorded limit when it is the stricter one (for
  // a list, when it alone refuses `issuer`), else the owner's mandate.
  limitSource(p, k, {issuer = null} = {}) {
    const a = p.agent_limits || {}, kind = AGENT_LIMIT_FIELDS[k];
    if (a[k] == null || !kind) return 'owner_mandate';
    if (kind === 'deny' || kind === 'allow') {
      const owner = this.ownerValue(p, k);
      const ownerRefuses = kind === 'deny' ? Array.isArray(owner) && owner.includes(issuer) : !(owner === 'any' || (Array.isArray(owner) && owner.includes(issuer)));
      return !ownerRefuses && (kind === 'deny' ? a[k].includes(issuer) : !a[k].includes(issuer)) ? 'agent_limits' : 'owner_mandate';
    }
    const eff = this.effectiveLimits(p)[k], owner = CIRCULATION_LIMIT_KINDS.has(kind) ? this.ownerValue(p, k) : p.mandate[k];
    return eff === a[k] && a[k] !== owner ? 'agent_limits' : 'owner_mandate';
  }

  // ---------- views ----------
  // With circulating credit on (modes sandbox and on), a participant the server runs (the sandbox agents) is labelled
  // operator_run: the operator holds its keys (spec 3, 18.15). In other modes the record is v15's.
  publicParticipant(p) {
    return {id: p.id, handle: p.handle, display_name: p.display_name, operator: p.operator, about: p.about, services: p.services,
      pubkey: p.pubkey, status: p.status, joined_at: p.created_at, agent_last_seen: p.last_seen_agent,
      ...(p.sandbox_only ? {sandbox_only: true, sandbox_expires_at: p.sandbox_expires_at} : {}),
      ...(this.serverRun(p) && this.circulating ? {operator_run: true} : {})};
  }
  // Whether the participant with this id is one the server runs (its notes are issued with keys the operator holds).
  operatorRun(id) { const q = typeof id === 'string' && Object.hasOwn(this.s.participants, id) ? this.s.participants[id] : null; return this.serverRun(q); }

  // Self-serve sandbox join (off unless the server is started with it): no invite; the participant can deal only with
  // the always-on sandbox agents, within small limits, for SANDBOX_DAYS. Lets anyone try Valun with their own agent.
  // With the open network (openNetwork) it may deal with any participant whose mandate allows it, and accepts notes of
  // any issuer, within the same limits and days; `services` (what it offers, public) is kept as an invited joiner's is.
  async joinSandbox({handle, display_name, operator, about, services} = {}) {
    if (!this.openSandbox) throw new PilotError('not_found', 'self-serve sandbox joining is not enabled on this server', 404);
    const ids = [...(this.sandboxIds || [])];
    if (!ids.length) throw new PilotError('sandbox_unavailable', 'the sandbox agents are not running on this server', 503);
    // A cap for the whole server, on top of the per-address limit: many addresses cannot fill a small machine's state.
    const since = this.now() - 864e5;
    if (Object.values(this.s.participants).filter(x => x.sandbox_only && Date.parse(x.created_at) > since).length >= SANDBOX_JOINS_PER_DAY)
      throw new PilotError('sandbox_full', `the sandbox takes at most ${SANDBOX_JOINS_PER_DAY} new participants a day; try again later`, 503);
    const inv = this.createInvite({note: 'self-serve sandbox join', maxUses: 1, ttlDays: 1});
    const open = this.openNetwork;
    const j = await this.join({invite: inv.code, handle, display_name, operator: operator || 'self-serve sandbox tester', about,
      services: open ? services : ''});
    const p = this.s.participants[j.participant_id], until = iso(this.now() + SANDBOX_DAYS * 864e5);
    p.sandbox_only = true; p.sandbox_expires_at = until;
    // With circulation on, a sandbox joiner also accepts transfers of notes the sandbox agents issued (and only those);
    // with the open network, of any issuer's notes (within the same limits).
    this.setMandate(p, {...SANDBOX_CAPS, counterparties: open ? 'any' : ids, approve_above: 1000, min_payer_coverage_pct: 0, expires_at: until,
      objective: open ? 'Self-serve: deal with any agent on the Valun test network, within small limits.' : 'Self-serve sandbox: deal with sandbox-exact and sandbox-mallory to try Valun.',
      ...(this.circulating ? SANDBOX_CIRCULATION(open ? 'any' : ids) : {})}, {by: 'operator'});
    this.store.audit({type: 'participant.sandbox_joined', id: p.id, ...(open ? {open_network: true} : {})});
    return {...j, sandbox_only: true, sandbox_expires_at: until, counterparties: open ? 'any' : ids,
      note: open
        ? `Open network: you can deal with any agent on the network whose owner allows it (sandbox-exact and sandbox-mallory are always on), at most ${SANDBOX_CAPS.max_issue_per_deal} PC per deal and ${SANDBOX_CAPS.max_issue_outstanding} PC owed in total, until ${until}, renewed for another ${SANDBOX_DAYS} days whenever your agent is active. Synthetic units.`
        : `Sandbox only: you can deal with the sandbox agents (sandbox-exact, sandbox-mallory) until ${until}. Synthetic units.`};
  }
  // A self-serve participant boxed in (no open network) refuses every counterparty, and every issuer, but the sandbox
  // agents, whatever its mandate says (one written while the network was open included).
  boxedOut(p, otherId) { return !!p?.sandbox_only && !this.openNetwork && !this.sandboxIds?.has(otherId); }
  participant(id) {
    const p = typeof id === 'string' && Object.hasOwn(this.s.participants, id) ? this.s.participants[id] : null;
    if (!p) throw new PilotError('not_found', `unknown participant ${id}`, 404);
    return p;
  }
  // Every key a participant has ever registered stays linked to it (tracker notes under an earlier key are still its own).
  byPubkey(pk) { return Object.values(this.s.participants).find(p => p.pubkey === pk || (p.past_pubkeys || []).some(k => k.pubkey === pk)) || null; }
  // Every key, current or past, -> its participant, in one pass (the one byPubkey finds: the first participant holding
  // the key); for reads that look up many keys (ledger, reconcile, GET /edges): O(participants + notes), not
  // O(participants x notes) (SV-ROB-2). Built per read, so it never goes stale.
  pubkeyMap() {
    const m = new Map();
    for (const p of Object.values(this.s.participants)) for (const k of [p.pubkey, ...(p.past_pubkeys || []).map(x => x?.pubkey)]) if (k && !m.has(k)) m.set(k, p);
    return m;
  }

  // The tracker's notes in the pilot denomination (a tracker may also hold notes in other denominations).
  async trackerNotes() {
    const notes = await this.basis.allNotes();
    return notes.filter(n => n?.denomination === this.basis.denomination);
  }
  async ledger() {
    const notes = await this.trackerNotes(), keys = this.pubkeyMap();
    return notes.map(n => {
      const a = keys.get(n.issuer_pubkey) ?? null, b = keys.get(n.recipient_pubkey) ?? null;
      const row = {issuer: a?.id ?? null, issuer_handle: a?.handle ?? null, recipient: b?.id ?? null, recipient_handle: b?.handle ?? null,
        issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, total: Number(n.amount_collected), redeemed: Number(n.amount_redeemed),
        outstanding: Number(n.amount_collected) - Number(n.amount_redeemed), timestamp: n.timestamp, confirmation: n.confirmation?.status ?? 'unknown', unit: this.unit};
      TRACKER_NOTE.set(row, n);            // the row's note (its signature) for reconcile(); never part of the row itself
      return row;
    });
  }
  // Whether the tracker's note on an edge is exactly the state Valun's last event there left (total, timestamp and the
  // issuer's signature): design §5.6 `exact`.
  exactEdge(k, note) {
    const last = this.s.edges[k]?.last;
    return !!(last && note && Number(note.amount_collected) === last.total && note.timestamp === last.timestamp && note.signature === last.signature);
  }
  // Reconciliation (I-RECON): per edge, the tracker's total against the total Valun expects from its edge journal
  // (lib/pilot/journal.mjs), which is v15's sum of issued prices while nothing has been novated. Rows, fields and statuses
  // are v15's; with circulation on (modes sandbox and on) rows add expected_total, set_off, transferred_in,
  // transferred_out and exact, and edges only Valun knows get the same row shape as the tracker's. `public`: the rows of
  // the public GET /ledger, v15's in every mode (owner decision 9, design §4.9; SV-PRIV-1): issued_via_valun is the
  // journal's expected total, so a row shows no per-edge history of transfers and set-offs (the tracker's total, which
  // the ledger shows anyway, is all it adds); the journal columns serve the server's own reads and tests.
  async reconcile(ledger = null, {public: publicRows = false} = {}) {
    ledger ??= await this.ledger();
    const circulating = this.circulating && !publicRows, edges = this.s.edges;
    const status = (tracker, expected) => tracker === expected ? 'match' : tracker > expected ? 'tracker-has-debt-not-agreed-in-valun' : 'valun-records-exceed-tracker';
    const extra = (k, exact) => {
      const e = edges[k];
      return {expected_total: e?.expected_total ?? 0, set_off: e?.setoff_PC ?? 0, transferred_in: e?.transferred_in_PC ?? 0, transferred_out: e?.transferred_out_PC ?? 0, exact};
    };
    const rows = [], seen = new Set();
    for (const l of ledger) {
      const k = edgeKey(l.issuer_pubkey, l.recipient_pubkey); seen.add(k);
      const v = edges[k]?.expected_total ?? 0;
      const row = {issuer: l.issuer_handle ?? l.issuer_pubkey, recipient: l.recipient_handle ?? l.recipient_pubkey, tracker_total: l.total,
        issued_via_valun: circulating ? edges[k]?.issued_PC ?? 0 : v, status: status(l.total, v)};
      rows.push(circulating ? {...row, ...extra(k, this.exactEdge(k, TRACKER_NOTE.get(l)))} : row);
    }
    // Edges Valun expects that the tracker does not hold: in the order v15 listed them (the note_issued deals' pairs, by
    // deal), then any other journal edge.
    const order = new Set();
    for (const d of Object.values(this.s.deals)) if (d.status === 'note_issued') {
      const t = d.agreement?.terms, n = d.credit_note, i = n?.issuer_pubkey ?? t?.payer?.pubkey, r = n?.recipient_pubkey ?? t?.payee?.pubkey;
      if (i && r) order.add(edgeKey(i, r));
    }
    for (const k of Object.keys(edges)) order.add(k);
    const keyMap = circulating ? this.pubkeyMap() : null;
    for (const k of order) if (!seen.has(k) && edges[k]) {
      const v = edges[k].expected_total;
      if (!circulating) rows.push({pair: k, tracker_total: 0, issued_via_valun: v, status: 'valun-records-exceed-tracker'});
      else {
        const [ik, rk] = k.split('>'), a = keyMap.get(ik), b = keyMap.get(rk);
        rows.push({issuer: a?.handle ?? ik, recipient: b?.handle ?? rk, tracker_total: 0, issued_via_valun: edges[k].issued_PC, status: status(0, v), ...extra(k, false)});
      }
    }
    return rows;
  }
  // `own`: the participant's own position (/me, /owner). With circulating credit on it also lists the notes it holds that
  // it could pay with (spendable_notes) and its payments by transfer under way (pending); the public position
  // (GET /participants/:id) leaves both out, since they show transfers in progress and the issuers' consent ability.
  async position(p, ledger = null, {own = false} = {}) {
    ledger ??= await this.ledger();
    const owed = ledger.filter(l => l.recipient === p.id), owes = ledger.filter(l => l.issuer === p.id);
    const sum = xs => xs.reduce((a, l) => a + l.outstanding, 0);
    const deals = this.dealsFor(p).map(d => this.sweep(d));          // counts use current statuses, not unswept ones (OQ-7)
    const buckets = bucketCounts(deals);                             // by STATUS_CLASS[status].bucket (lib/pilot/status.mjs)
    const backing = 'none: the pilot tracker has no chain and no reserves; PC are simulated units';
    if (!this.circulating) return {participant_id: p.id, unit: this.unit, claims_held: sum(owed), owes: sum(owes), net: sum(owed) - sum(owes),
      claims: owed.map(l => ({from: l.issuer_handle, amount: l.outstanding})), debts: owes.map(l => ({to: l.recipient_handle, amount: l.outstanding})),
      deals: Object.fromEntries(POSITION_BUCKETS.map(b => [b, buckets[b]])),
      settled: 0, backing,
      meaning: 'claims and debts are outstanding credit notes (cumulative per pair, as the tracker records them). None has been settled: the pilot has no redemption, reserve or clearing.'};
    // Circulating credit (modes sandbox and on; design §5.6): what moved, from the edge journal, over every key the
    // participant has had. Set-offs cancel as much of its claims as of its debts, so cleared_by_setoff counts one side.
    const keys = this.keysOf(p), journal = {in: 0, out: 0, setoff: 0, novated: 0};
    for (const [k, e] of Object.entries(this.s.edges)) {
      const [i, r] = k.split('>');
      if (keys.has(r)) { journal.in += e.transferred_in_PC; journal.out += e.transferred_out_PC; }
      if (keys.has(i)) { journal.setoff += e.setoff_PC; journal.novated += e.transferred_out_PC; }
    }
    const frozen = owed.filter(l => this.isPastKey(l.issuer_pubkey) || this.isPastKey(l.recipient_pubkey));
    return {participant_id: p.id, unit: this.unit, claims_held: sum(owed), owes: sum(owes), net: sum(owed) - sum(owes),
      gross: sum(owed) + sum(owes), cleared_by_setoff: journal.setoff, transferred_in: journal.in, transferred_out: journal.out, novated_as_issuer: journal.novated,
      ...(own ? {spendable_notes: this.spendableNotes(p, ledger)} : {}),
      frozen_claims: sum(frozen),
      ...(own ? {pending: this.pendingOf(p)} : {}),
      // Notes a participant the server runs issued (the sandbox agents) carry operator_run and the label of spec 16.1:
      // the claims on it, and its own debts (its credit history).
      claims: owed.map(l => ({from: l.issuer_handle, amount: l.outstanding, issuer_id: l.issuer, issuer_pubkey: l.issuer_pubkey, recipient_pubkey: l.recipient_pubkey,
        ...(this.operatorRun(l.issuer) ? OPERATOR_RUN_NOTE : {})})),
      debts: owes.map(l => ({to: l.recipient_handle, amount: l.outstanding, recipient_id: l.recipient, recipient_pubkey: l.recipient_pubkey, issuer_pubkey: l.issuer_pubkey,
        ...(this.serverRun(p) ? OPERATOR_RUN_NOTE : {})})),
      deals: {...Object.fromEntries(POSITION_BUCKETS.map(b => [b, buckets[b]])), paid_by_transfer: buckets.paid_by_transfer, payment_due: deals.filter(d => d.status === 'payment_due').length},
      settled: journal.setoff, settled_how: 'by set-off only; nothing is redeemed', backing,
      meaning: 'claims and debts are outstanding obligations recorded by the pilot Basis tracker (cumulative per pair). Some may have moved between creditors (transfer) or been cancelled in cycles (set-off); settled counts only set-off. Nothing is redeemed; there is no reserve.'};
  }
  // GET /participants/:id public_position: position(p), and with circulating credit on (modes sandbox and on) the
  // predicate fields of p's credit policy (whose notes it accepts; never its caps) and its credit history, aggregates only
  // (lib/pilot/policy.mjs). In other modes it is position(p), v15's.
  async publicPosition(p, ledger = null) {
    const pos = await this.position(p, ledger);
    if (!this.circulating) return pos;
    return {...pos, credit_policy: publicCreditPolicy(this, p), credit_history: creditHistory(this, p, this.dealsFor(p).map(d => this.sweep(d)))};
  }
  // Every key a participant has registered (current and past), and whether a key is a participant's past key.
  keysOf(p) { return new Set([p.pubkey, ...(p.past_pubkeys || []).map(k => k.pubkey)].filter(Boolean)); }
  isPastKey(pk) { const q = this.byPubkey(pk); return !!q && q.pubkey !== pk; }

  // GET /edges (mode bound and above): the participant's edges as the tracker holds them (EdgeStates, which the client
  // verifies), with what Valun knows about each, and its journal entries after `since` (design §4.10, spec 18.14).
  async edges(p, {since = 0} = {}) {
    if (!Number.isSafeInteger(since) || since < 0) throw new PilotError('invalid_field', 'since must be a whole number (a journal seq from an earlier answer)');
    const keys = this.keysOf(p), notes = await this.trackerNotes(), keyMap = this.pubkeyMap();
    const who = pk => { const q = keyMap.get(pk); return {id: q?.id ?? null, handle: q?.handle ?? null}; };
    const past = pk => { const q = keyMap.get(pk); return !!q && q.pubkey !== pk; };
    const row = n => {
      const k = edgeKey(n.issuer_pubkey, n.recipient_pubkey);
      return {edge: k, issuer: who(n.issuer_pubkey), recipient: who(n.recipient_pubkey), issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey,
        total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature, exact: this.exactEdge(k, n), bound_only: !!this.s.edges[k]?.novated,
        reserved: this.edgeReserved(k), frozen: past(n.issuer_pubkey) || past(n.recipient_pubkey)};
    };
    const {entries, next_seq, partial, gap, checkpoint} = journalFor(this, keys, {since});
    // A page that needs pilot-edge-log.jsonl while it cannot be read is refused, never answered with entries missing
    // (the client would move its `since` past them); so is one whose entries the server no longer has in full (the file
    // lost or cut after the tail rolled over, decision D-3 d), with the first missing seqs.
    if (partial && gap) throw new PilotError('journal_unavailable', `the edge journal is missing entries ${gap.from}..${gap.to} (${EDGE_LOG_FILE} was lost or cut): this page cannot be answered in full until the operator restores the file`, 503, {missing_from: gap.from, missing_to: gap.to});
    if (partial) throw new PilotError('journal_unavailable', 'the older part of the edge journal cannot be read just now; try again (no entry is lost)', 503);
    return {incoming: notes.filter(n => keys.has(n.recipient_pubkey)).map(row), outgoing: notes.filter(n => keys.has(n.issuer_pubkey)).map(row),
      journal: entries, next_seq, ...(checkpoint ? {checkpoint} : {})};
  }
  // PC of an edge held by novations being collected: edgeReserved(k), with the transfers and set-offs below.

  // ---------- mandate enforcement (deterministic) ----------
  // Credit a participant has committed to, on the tracker and in Valun. "committed": agreed or awaiting the acceptor's
  // owner; "reserved": offers this participant made that the other side could still accept. The deal being acted on is
  // excluded (its price is added explicitly by the caller), so nothing is counted twice. Each deal is swept first: an offer
  // or held acceptance past offer_expires_at, or an agreed deal past its delivery grace period, no longer counts even if
  // nobody has read it since (OQ-7, OQ-8).
  // Circulating credit: for a payee, the transfers it is being paid by that are still collecting (or applying) count
  // against their issuer (`pending_in`, design §5.4); `excludeTransferId` leaves one out (the transfer being checked).
  exposure(p, ledger, {asRole, counterpartyId = null, excludeDealId = null, excludeTransferId = null}) {
    const deals = Object.values(this.s.deals).filter(d => d.id !== excludeDealId && (asRole === 'payer'
      ? d.payer === p.id : d.payee === p.id && d.payer === counterpartyId)).map(d => this.sweep(d));
    const price = d => this.current(d).terms.price.amount;
    // Which statuses are committed or reserved: STATUS_CLASS (lib/pilot/status.mjs).
    const committed = deals.filter(d => statusClass(d.status)?.committed).reduce((a, d) => a + price(d), 0);
    const reserved = deals.filter(d => statusClass(d.status)?.reserved && this.current(d).by === p.id).reduce((a, d) => a + price(d), 0)
      + deals.filter(d => d.pending_counter?.by === p.id).reduce((a, d) => a + d.pending_counter.terms.price.amount, 0);
    const tracker = asRole === 'payer'
      ? ledger.filter(l => l.issuer === p.id).reduce((a, l) => a + l.outstanding, 0)
      : ledger.filter(l => l.recipient === p.id && l.issuer === counterpartyId).reduce((a, l) => a + l.outstanding, 0);
    const pendingIn = asRole === 'payee' ? Object.values(this.s.transfers || {}).map(t => this.sweepTransfer(t))
      .filter(t => t.id !== excludeTransferId && LIVE_TRANSFER.has(t.state) && t.payee.id === p.id && t.issuer.id === counterpartyId).reduce((a, t) => a + t.amount, 0) : 0;
    return {tracker, committed, reserved, ...(pendingIn ? {pending_in: pendingIn} : {}), total: tracker + committed + reserved + pendingIn};
  }
  // What p holds and is owed as payee on every issuer together (the phase-2 max_claims_total, lib/pilot/policy.mjs): its
  // claims on the tracker, its committed deals as payee (any payer; `excludeDealId` left out, the deal being agreed or
  // paid, whose amount the caller adds) and the payments by transfer to it still collecting or being applied
  // (`excludeTransferId` left out). Each payment counts once: a deal whose payment by transfer is in flight (a live
  // transfer to p for it: the deal paying_by_transfer, or completion_awaiting_owner with the transfer awaiting its owner)
  // counts as that transfer (pending_in), not also as a committed deal; and a transfer for the deal being agreed or paid
  // is that deal's amount, which the caller adds. Transfers are swept first: one that just expired has returned its deal
  // to delivered or payment_due, which then counts as committed.
  claimsHeld(p, ledger, {excludeDealId = null, excludeTransferId = null} = {}) {
    const tracker = ledger.filter(l => l.recipient === p.id).reduce((a, l) => a + l.outstanding, 0);
    const live = Object.values(this.s.transfers || {}).map(t => this.sweepTransfer(t)).filter(t => LIVE_TRANSFER.has(t.state) && t.payee.id === p.id);
    const inFlight = new Set(live.map(t => t.deal_id));
    const committed = Object.values(this.s.deals).filter(d => d.payee === p.id && d.id !== excludeDealId).map(d => this.sweep(d))
      .filter(d => statusClass(d.status)?.committed && !inFlight.has(d.id)).reduce((a, d) => a + this.current(d).terms.price.amount, 0);
    const pendingIn = live.filter(t => t.id !== excludeTransferId && t.deal_id !== excludeDealId).reduce((a, t) => a + t.amount, 0);
    return {tracker, committed, pending_in: pendingIn, total: tracker + committed + pendingIn};
  }

  // Deterministic delegation check at the action boundary. Throws mandate_exceeded (nothing recorded) for a hard limit;
  // otherwise says whether the owner must approve.
  async checkMandate(p, role, counterpartyId, price, {excludeDealId = null} = {}) {
    const m = this.effectiveLimits(p);                // owner mandate, tightened by any limits the agent recorded
    const fail = (rule, detail, from = null) => {
      // `source` keeps naming the limit set that applied (agent_limits | owner_mandate); `recorded_by` says who recorded an
      // agent_limits value: the agent from its owner's instructions, or the owner itself through PUT /limits (OQ-20).
      // A credit rule (lib/pilot/policy.mjs) names its own source (`from`: for a list, the one that refused the issuer).
      const source = from ?? (rule in AGENT_LIMIT_FIELDS ? this.limitSource(p, rule) : 'owner_mandate');
      const recordedBy = source === 'agent_limits' ? this.limitRecordedBy(p, rule) : null;
      const label = source !== 'agent_limits' ? 'mandate' : recordedBy === 'owner' ? 'limit recorded by the owner (PUT /limits)' : "limit recorded from the owner's instructions";
      throw new PilotError('mandate_exceeded', `${label}: ${detail}`, 403, {rule, source, ...(recordedBy ? {recorded_by: recordedBy} : {}), mandate_version: p.mandate_version});
    };
    if (m.expires_at && Date.parse(m.expires_at) < this.now()) fail('expires_at', `the mandate expired at ${m.expires_at}; the owner must renew it`);
    if (m.counterparties !== 'any' && !m.counterparties.includes(counterpartyId)) fail('counterparties', `${this.participant(counterpartyId).handle} is not on the owner's counterparty list`);
    if (this.boxedOut(p, counterpartyId)) fail('counterparties', `a self-serve sandbox participant can deal only with the sandbox agents on this server, not ${this.participant(counterpartyId).handle}`);
    const ledger = await this.ledger();
    const checks = [];
    if (role === 'payer') {
      if (!m.may_issue_credit) fail('may_issue_credit', 'the owner has not allowed this agent to issue credit');
      if (price > m.max_issue_per_deal) fail('max_issue_per_deal', `price ${price} exceeds max_issue_per_deal ${m.max_issue_per_deal}`);
      const e = this.exposure(p, ledger, {asRole: 'payer', excludeDealId});
      // A sandbox agent with circulating credit on (design §5.8, spec 18.15): what it owes sandbox participants whose
      // sandbox time has ended (dormant) does not count against its own max_issue_outstanding; the check reports it as
      // dormant_PC (owed_on_tracker is then the part that counts). Every other check is v15's.
      const dormant = this.circulating && this.sandboxIds?.has(p.id)
        ? ledger.filter(l => l.issuer === p.id && this.dormant(this.s.participants[l.recipient])).reduce((a, l) => a + l.outstanding, 0) : null;
      const owed = e.tracker - (dormant ?? 0), total = e.total - (dormant ?? 0);
      checks.push({rule: 'max_issue_outstanding', owed_on_tracker: owed, ...(dormant === null ? {} : {dormant_PC: dormant}), committed: e.committed, reserved: e.reserved,
        this_deal: price, limit: m.max_issue_outstanding});
      if (total + price > m.max_issue_outstanding) fail('max_issue_outstanding', `issuing ${price} would bring this agent's outstanding credit to ${total + price}, above max_issue_outstanding ${m.max_issue_outstanding}`);
    } else {
      if (!m.may_accept_credit) fail('may_accept_credit', 'the owner has not allowed this agent to accept credit');
      if (price < (m.min_price_as_payee || 0)) fail('min_price_as_payee', `price ${price} is below this agent's minimum of ${m.min_price_as_payee} PC set by its owner`);
      if (price > m.max_accept_per_deal) fail('max_accept_per_deal', `price ${price} exceeds max_accept_per_deal ${m.max_accept_per_deal}`);
      const e = this.exposure(p, ledger, {asRole: 'payee', counterpartyId, excludeDealId});
      // Payments by transfer to p from this payer's notes still being collected (circulating credit) count too, and are
      // shown when there are any.
      checks.push({rule: 'max_accept_per_issuer', claim_on_tracker: e.tracker, committed: e.committed, reserved: e.reserved, ...(e.pending_in ? {pending_in: e.pending_in} : {}), this_deal: price, limit: m.max_accept_per_issuer});
      if (e.total + price > m.max_accept_per_issuer) fail('max_accept_per_issuer', `accepting ${price} more from ${this.participant(counterpartyId).handle} would bring exposure to ${e.total + price}, above max_accept_per_issuer ${m.max_accept_per_issuer}`);
      // Whose credit to accept, by the tracker's own figures: the payer's claims on others (credit notes it holds) must
      // cover the given share of everything it would owe: its outstanding notes, its agreed deals whose note is not
      // issued yet, and this deal. This is the payer's OWN promise; no note held by the payer is transferred.
      if (m.min_payer_coverage_pct > 0) {
        const payer = this.participant(counterpartyId), pe = this.exposure(payer, ledger, {asRole: 'payer', excludeDealId});
        const claims = ledger.filter(l => l.recipient === payer.id).reduce((a, l) => a + l.outstanding, 0);
        const owes = pe.tracker + pe.committed + price, pct = Math.floor(claims * 100 / owes);
        checks.push({rule: 'min_payer_coverage_pct', payer_claims_on_tracker: claims, payer_owes_on_tracker: pe.tracker, payer_committed: pe.committed, this_deal: price, coverage_pct: pct, limit: m.min_payer_coverage_pct});
        if (pct < m.min_payer_coverage_pct) fail('min_payer_coverage_pct', `${payer.handle}'s claims on the tracker (${claims} PC) cover ${pct}% of what it would owe with this deal (${owes} PC); this agent's owner requires at least ${m.min_payer_coverage_pct}%`);
      }
      // Circulating credit (modes sandbox and on): the phase-2 credit rules on the payer, as the issuer of the note p would
      // hold (lib/pilot/policy.mjs: refuse_notes_from, accept_operator_issuers, max_claims_total, max_issuer_net_debt).
      // Each adds an entry only when it is set, so with none set the checks are as before.
      if (this.circulating) {
        const r = await creditCheck(this, p, this.participant(counterpartyId), price, {via: 'agreement', ledger, excludeDealId});
        if (!r.ok) fail(r.rule, r.detail, r.source);
        checks.push(...r.checks);
      }
    }
    return {needsOwner: price > p.mandate.approve_above, checks, mandate_version: p.mandate_version};
  }

  // ---------- deals ----------
  current(d) { return d.versions[d.versions.length - 1]; }
  deal(id) { const d = this.s.deals[id]; if (!d) throw new PilotError('not_found', `unknown deal ${id}`, 404); return d; }
  // A deal exists for the counterparty only once its first version was offered (an offer still waiting for, or rejected
  // by, its proposer's owner was never made). Its creator always sees it.
  visibleTo(d, p) { return d.versions[0].by === p.id || !!d.versions[0].offered_at; }
  dealsFor(p) { return Object.values(this.s.deals).filter(d => (d.payer === p.id || d.payee === p.id) && this.visibleTo(d, p)); }
  partyDeal(id, p) { const d = this.deal(id); if ((d.payer !== p.id && d.payee !== p.id) || !this.visibleTo(d, p)) throw new PilotError('not_found', `unknown deal ${id}`, 404); return d; }
  // `only`: the participant who alone may see this event (about something the other side was never offered).
  event(d, by, event, detail = {}, only = null) {
    d.history.push({at: iso(this.now()), by, event, ...detail, ...(only ? {only} : {})}); d.updated_at = iso(this.now());
    this.notifyChange({deal: d, event});
  }
  notifyChange(change) { for (const f of this.changeListeners) { try { f(change); } catch { /* a listener only schedules work */ } } }

  // When an agreed deal that is still not delivered ends (deliver_by + the grace period).
  deliveryGraceEnd(d) { return d.agreement ? Date.parse(d.agreement.terms.deliver_by) + UNDELIVERED_GRACE_MS : null; }

  // Lazy expiry of open offers (and of a counter-offer still waiting for its proposer's owner), and of agreed deals the
  // payee never delivered (OQ-8: they end, releasing the exposure they held; nothing is owed under them). Which statuses
  // expire, and how: STATUS_CLASS[status].expiry (lib/pilot/status.mjs), read again after each step.
  sweep(d) {
    const v = this.current(d), late = x => Date.parse(x.terms.offer_expires_at) < this.now();
    const expiry = () => statusClass(d.status)?.expiry ?? null;
    if (expiry() === 'offer' && late(v)) {
      const offered = !!v.offered_at;
      v.state = 'expired'; d.status = 'expired'; this.voidPending(d, 'expired');
      this.event(d, 'valun', 'expired', {version: v.v}, offered ? null : v.by);
      this.save();
    }
    if (expiry() === 'held_acceptance' && late(v)) {
      d.status = 'expired'; v.state = 'expired'; if (d.acceptance) d.acceptance.state = 'expired';
      this.voidPending(d, 'expired');
      this.event(d, 'valun', 'expired_before_owner_approval', {version: v.v});
      this.save();
    }
    if (d.pending_counter && late(d.pending_counter)) {
      const c = d.pending_counter;
      this.voidPending(d, 'expired');
      this.event(d, 'valun', 'counter_expired_before_owner_approval', {version: c.v}, c.by);
      this.save();
    }
    if (expiry() === 'delivery' && this.now() > this.deliveryGraceEnd(d)) {
      d.status = 'expired_undelivered';
      this.event(d, 'valun', 'expired_undelivered', {version: d.agreement.version, deliver_by: d.agreement.terms.deliver_by, grace_days: UNDELIVERED_GRACE_DAYS});
      this.save(); this.store.audit({type: 'deal.expired_undelivered', deal: d.id});
    }
    // Circulating credit: the deal's payment by transfer, past its collection window, expires (the deal becomes
    // payment_due, or returns to where it was while it waited for the payer's owner).
    if (d.payment?.method === 'transfer') { const t = this.transfer(d.payment.transfer_id); if (t) this.sweepTransfer(t); }
    return d;
  }

  validateTerms(t, proposer) {
    const bad = m => { throw new PilotError('invalid_terms', m); };
    if (!t || typeof t !== 'object') bad('terms must be an object');
    const keys = ['protocol', 'network', 'tracker_nft_id', 'denomination', 'deal_id', 'version', 'prior_terms_hash', 'nonce', 'proposer', 'payer', 'payee',
      'service', 'price', 'consideration', 'deliver_by', 'offer_expires_at'];
    for (const k of Object.keys(t)) if (!keys.includes(k)) bad(`unknown terms field ${k}`);
    if (t.protocol !== PROTOCOL) bad(`protocol must be ${PROTOCOL}`);
    if (t.network !== NETWORK) bad(`network must be ${NETWORK}`);
    if (t.tracker_nft_id !== this.basis.nft) bad('tracker_nft_id does not match this pilot tracker');
    if (t.denomination !== this.basis.denomination) bad(`denomination must be ${this.basis.denomination}`);
    if (!/^vd_[0-9a-f]{16}$/.test(t.deal_id || '')) bad('deal_id must be vd_ + 16 hex');
    if (!isInt(t.version, 1, 50)) bad('version must be 1..50');
    if (!/^[0-9a-f]{32}$/.test(t.nonce || '')) bad('nonce must be 32 hex');
    if (t.proposer !== proposer.id) bad('proposer must be the caller');
    for (const r of ['payer', 'payee']) {
      const x = t[r];
      if (!x || typeof x !== 'object' || Object.keys(x).sort().join() !== 'id,pubkey') bad(`${r} must be {id, pubkey}`);
      const q = typeof x.id === 'string' && PID_RE.test(x.id) && Object.hasOwn(this.s.participants, x.id) ? this.s.participants[x.id] : null;
      if (!q || q.status !== 'active' || q.pubkey !== x.pubkey) bad(`${r} must be an active participant with its registered key`);
    }
    if (t.payer.id === t.payee.id) bad('payer and payee must differ');
    if (proposer.id !== t.payer.id && proposer.id !== t.payee.id) bad('the proposer must be the payer or the payee');
    const sv = t.service;
    if (!sv || typeof sv !== 'object' || Object.keys(sv).sort().join() !== 'deliverable,description,title') bad('service must be {title, description, deliverable}');
    signedText(sv.title, 120, 'service.title'); signedText(sv.description, 2000, 'service.description'); signedText(sv.deliverable, 500, 'service.deliverable');
    if (!t.price || Object.keys(t.price).sort().join() !== 'amount,unit' || t.price.unit !== this.unit || !isInt(t.price.amount, 1, PRICE_CAP)) bad(`price must be {amount: 1..${PRICE_CAP}, unit: "${this.unit}"}`);
    if (t.consideration !== 'credit_note_on_delivery_accepted') bad('consideration must be "credit_note_on_delivery_accepted" (the payer issues a credit note when it accepts the delivery)');
    const exp = Date.parse(t.offer_expires_at), due = Date.parse(t.deliver_by), now = this.now();
    if (!(exp > now && exp <= now + MAX_OFFER_TTL_MS)) bad('offer_expires_at must be in the future, at most 7 days ahead');
    if (!(due > now && due <= now + MAX_DELIVERY_MS)) bad('deliver_by must be in the future, at most 30 days ahead');
    if (!(due >= exp)) bad('deliver_by must not be earlier than offer_expires_at (a deal must not be agreed already overdue)');
    return t;
  }

  // A signature is a 65-byte hex STRING (never an array or other type: F12); anything the signer cannot process
  // (all-zero, all-ff, ...) simply does not verify (F5: a refusal, not a 502).
  async safeVerify(pubkey, msgHex, sig) {
    if (typeof sig !== 'string' || !SIG_RE.test(sig) || typeof pubkey !== 'string' || !KEY_RE.test(pubkey)) return false;
    try { return !!(await this.basis.verify(pubkey, msgHex, sig)); } catch (e) {
      // "signer: ..." = the signer ran and rejected the input: the signature does not verify. Anything else (timeout,
      // failed start, no output) is an outage, never reported as the client's bad signature (OQ-31).
      if (/^signer: /.test(String(e?.message))) return false;
      throw new PilotError('signer_unavailable', 'signature checking is temporarily unavailable; nothing was recorded; try again', 503);
    }
  }

  // The Basis note message is built by the same helper: during a signer outage the credit-note template and completion
  // are a 503 with nothing recorded, like a signature check (OQ-31 residual), never a 502.
  async noteMessage(args) {
    try { return await this.basis.noteMessage(args); }
    catch (e) {
      if (e?.code === 'signer_unavailable') throw new PilotError('signer_unavailable', 'signature checking is temporarily unavailable; nothing was recorded; try again', 503);
      throw e;
    }
  }
  // Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) (lib/basis.mjs priorAckMessage), from the same helper (503 during
  // an outage, as noteMessage).
  async priorAckMessage(args) {
    try { return await this.basis.priorAckMessage(args); }
    catch (e) {
      if (e?.code === 'signer_unavailable') throw new PilotError('signer_unavailable', 'signature checking is temporarily unavailable; nothing was recorded; try again', 503);
      throw e;
    }
  }
  // The hex of a message descriptor {issuer, recipient, total, timestamp, prior_timestamp?} (novation.mjs slotMessage):
  // the prior acknowledgment PA(issuer, recipient, total, prior_timestamp, timestamp) when prior_timestamp is given (a
  // creditor's prior slot of a transfer, a bound note's prior_signature), else the note message M(issuer, recipient,
  // total, timestamp).
  async messageHex(m) {
    const r = m.prior_timestamp !== undefined && m.prior_timestamp !== null
      ? await this.priorAckMessage({issuer: m.issuer, recipient: m.recipient, priorTotal: m.total, priorTimestamp: m.prior_timestamp, timestamp: m.timestamp})
      : await this.noteMessage({issuer: m.issuer, recipient: m.recipient, total: m.total, timestamp: m.timestamp});
    return r.message_hex;
  }

  async verifySig(p, statement, sig, what, alternatives = []) {
    if (!p.pubkey) throw new PilotError('no_key', 'participant has no registered key', 403);
    if (typeof sig !== 'string' || !SIG_RE.test(sig)) throw new PilotError('bad_signature', `${what} signature must be 65 bytes hex`, 403);
    for (const s of [statement, ...alternatives]) if (await this.safeVerify(p.pubkey, hexOf(s), sig)) return;
    throw new PilotError('bad_signature', `${what} signature does not verify for ${p.handle}'s registered key`, 403);
  }

  // Terms name each party's key. Before terms become an agreement (or an open offer), both parties must still be active
  // with exactly those keys: a revoked or replaced key can no longer commit its participant.
  partiesCurrent(v) {
    for (const r of ['payer', 'payee']) {
      const q = this.s.participants[v.terms[r].id];
      if (!q || q.status !== 'active' || q.pubkey !== v.terms[r].pubkey)
        throw new PilotError('key_changed', `${q?.handle ?? v.terms[r].id}'s registered agent key is no longer the one these terms name (its owner revoked or replaced it); these terms can no longer be agreed`, 409, {party: v.terms[r].id});
    }
  }
  // At acceptance the proposer's mandate is checked again (hard limits and expiry): its owner may have tightened it, or
  // other commitments may have used it up, since the offer was made. The reason stays private to the proposer's side.
  // Returns the proposer's mandate check as it is now (its needsOwner is used below).
  async proposerStillAuthorized(d, v) {
    const q = this.s.participants[v.by], role = d.payer === v.by ? 'payer' : 'payee';
    try { return await this.checkMandate(q, role, role === 'payer' ? d.payee : d.payer, v.terms.price.amount, {excludeDealId: d.id}); }
    catch (e) {
      if (e.code !== 'mandate_exceeded') throw e;
      this.store.audit({type: 'deal.accept_refused_proposer_mandate', deal: d.id, proposer: q.id, rule: e.extra.rule});
      throw new PilotError('offer_not_authorized', `this offer is no longer within ${q.handle}'s mandate (its owner changed the limits, or other commitments used them up); it cannot be accepted now. Decline it, or wait for a new offer.`, 409);
    }
  }

  // When the proposer's owner confirms an accepted offer later, the acceptor's hard limits are checked again too (its
  // owner may have tightened them since); the reason stays private to the acceptor's side.
  async acceptorStillAuthorized(d, v) {
    const q = this.s.participants[d.acceptance.by], role = d.payer === q.id ? 'payer' : 'payee';
    try { await this.checkMandate(q, role, role === 'payer' ? d.payee : d.payer, v.terms.price.amount, {excludeDealId: d.id}); }
    catch (e) {
      if (e.code !== 'mandate_exceeded') throw e;
      this.store.audit({type: 'deal.confirm_refused_acceptor_mandate', deal: d.id, acceptor: q.id, rule: e.extra.rule});
      throw new PilotError('acceptance_not_authorized', `${q.handle}'s acceptance is no longer within its mandate (its owner changed the limits, or other commitments used them up); it cannot take effect now. Reject to withdraw the offer, or decide later.`, 409);
    }
  }

  // F4 / OQ-29: the proposer's approve_above applies as it is when the offer is accepted. An offer its owner never
  // approved, priced above the owner's threshold now (the owner lowered it after the agent made the offer), waits for that
  // owner (approval kind confirm_offer) before it binds. An offer the owner approved is not held again.
  proposerMustConfirm(v, pchk) { return !!pchk?.needsOwner && !v.owner_approval; }
  holdForProposer(d, v, pchk) {
    const q = this.s.participants[v.by], a = this.approval(q, d, 'confirm_offer', v);
    d.acceptance.proposer_approval_id = a.id; d.acceptance.proposer_mandate_check = pchk;
    this.event(d, 'valun', 'held_for_proposer_owner', {version: v.v, proposer: v.by});
    this.store.audit({type: 'deal.held_for_proposer_owner', deal: d.id, proposer: v.by, approval: a.id});
  }
  // The acceptance takes effect once every owner who must decide has approved: the acceptor's owner (approve_above when
  // its agent accepted) and, where needed, the proposer's owner. Otherwise the deal stays accepted_awaiting_owner.
  // `pchk`: the proposer's mandate check now, or null when it was not run (the proposer's owner is deciding).
  settleAcceptance(d, v, pchk) {
    const acc = d.acceptance, hold = () => { d.status = 'accepted_awaiting_owner'; acc.state = 'awaiting_owner'; };
    if (!acc.proposer_approval_id && this.proposerMustConfirm(v, pchk)) this.holdForProposer(d, v, pchk);   // both owners may decide in parallel
    if (acc.approval_id && !acc.owner_approval) return hold();
    if (acc.proposer_approval_id && !v.owner_approval) return hold();
    acc.state = 'final'; this.form(d);
  }
  heldFor(d) {
    const acc = d.acceptance, v = acc && d.versions.find(x => x.v === acc.version);
    if (!acc || acc.state !== 'awaiting_owner') return undefined;
    return [acc.approval_id && !acc.owner_approval && 'acceptor_owner', acc.proposer_approval_id && !v?.owner_approval && 'proposer_owner'].filter(Boolean);
  }

  // Any approval still pending for a deal that has moved on can never be used: mark it void (kept for the record).
  voidPending(d, reason, keepId = null) {
    for (const a of Object.values(this.s.approvals)) if (a.deal_id === d.id && a.state === 'pending' && a.id !== keepId) a.state = `void_${reason}`;
    if (d.pending_counter && d.pending_counter.approval_id !== keepId) { d.pending_counter.state = `void_${reason}`; d.superseded_counters = [...(d.superseded_counters || []), d.pending_counter]; d.pending_counter = null; }
  }

  approval(p, d, kind, v) {
    const a = {id: rid('va_', 6), participant: p.id, deal_id: d.id, kind, version: v.v, terms_hash: v.terms_hash, created_at: iso(this.now()), state: 'pending'};
    this.s.approvals[a.id] = a;
    return a;
  }

  propose(p, {terms, terms_hash: claimed, signature}) {
    return this.serial(async () => {
      const t = this.validateTerms(terms, p);
      if (t.version !== 1 || t.prior_terms_hash !== null) throw new PilotError('invalid_terms', 'a new deal starts at version 1 with prior_terms_hash null');
      const h = termsHash(t);
      if (claimed && claimed !== h) throw new PilotError('hash_mismatch', `the server computes terms_hash ${h}; the client sent ${claimed} (canonical JSON differs)`, 400, {canonical: canonical(t)});
      // The signature is checked before the deal id is looked up, so an unsigned probe cannot learn which ids exist (OQ-25).
      await this.verifySig(p, statements.propose(h), signature, 'proposal');
      if (Object.hasOwn(this.s.deals, t.deal_id)) throw new PilotError('duplicate', 'that deal id already exists', 409);
      const role = t.payer.id === p.id ? 'payer' : 'payee', other = role === 'payer' ? t.payee.id : t.payer.id;
      if (this.openNetwork && p.sandbox_only) {
        const mine = Object.values(this.s.deals).filter(x => (x.payer === p.id || x.payee === p.id)).map(x => this.sweep(x))
          .filter(x => (x.status === 'open' || x.status === 'proposed_awaiting_owner') && this.current(x).by === p.id).length;
        if (mine >= OPEN_NETWORK_MAX_OPEN_OFFERS) throw new PilotError('too_many_open_offers',
          `a self-serve participant has at most ${OPEN_NETWORK_MAX_OPEN_OFFERS} offers of its own open at once; withdraw one or wait for answers`, 429);
      }
      const chk = await this.checkMandate(p, role, other, t.price.amount);
      const v = {v: 1, by: p.id, terms: t, terms_hash: h, signature, created_at: iso(this.now()), state: chk.needsOwner ? 'awaiting_owner' : 'open', mandate_check: chk,
        offered_at: chk.needsOwner ? null : iso(this.now())};
      const d = {id: t.deal_id, payer: t.payer.id, payee: t.payee.id, created_at: iso(this.now()), status: chk.needsOwner ? 'proposed_awaiting_owner' : 'open', versions: [v], history: []};
      if (chk.needsOwner) v.approval_id = this.approval(p, d, 'propose', v).id;
      this.s.deals[d.id] = d;
      this.event(d, p.id, 'proposed', {version: 1, terms_hash: h, awaiting_owner: chk.needsOwner}, chk.needsOwner ? p.id : null);
      this.save(); this.store.audit({type: 'deal.proposed', deal: d.id, by: p.id, terms_hash: h});
      return this.dealView(d, p);
    });
  }

  counter(p, id, {terms, terms_hash: claimed, signature}) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p)), cur = this.current(d);
      if (d.status !== 'open' || cur.state !== 'open') throw new PilotError('not_open', `deal is ${d.status}; only an open offer can be countered`, 409);
      if (cur.by === p.id) throw new PilotError('own_offer', 'you cannot counter your own open offer; withdraw it instead', 409);
      const t = this.validateTerms(terms, p);
      if (t.deal_id !== d.id || t.version !== cur.v + 1 || t.prior_terms_hash !== cur.terms_hash) throw new PilotError('invalid_terms', `a counter must use deal_id ${d.id}, version ${cur.v + 1}, prior_terms_hash ${cur.terms_hash}`);
      if (t.payer.id !== d.payer || t.payee.id !== d.payee) throw new PilotError('invalid_terms', 'a counter cannot change who pays and who performs');
      if (d.pending_counter) throw new PilotError('counter_pending', "a counter-offer from you is already waiting for your owner's approval", 409);
      const h = termsHash(t);
      if (claimed && claimed !== h) throw new PilotError('hash_mismatch', `the server computes terms_hash ${h}; the client sent ${claimed}`, 400, {canonical: canonical(t)});
      await this.verifySig(p, statements.propose(h), signature, 'counter-offer');
      const role = d.payer === p.id ? 'payer' : 'payee';
      const chk = await this.checkMandate(p, role, role === 'payer' ? d.payee : d.payer, t.price.amount);
      const v = {v: t.version, by: p.id, terms: t, terms_hash: h, signature, created_at: iso(this.now()), state: chk.needsOwner ? 'awaiting_owner' : 'open', mandate_check: chk,
        offered_at: chk.needsOwner ? null : iso(this.now())};
      if (chk.needsOwner) { v.approval_id = this.approval(p, d, 'propose', v).id; d.pending_counter = v; }
      else { cur.state = 'countered'; d.versions.push(v); }
      this.event(d, p.id, 'countered', {version: v.v, terms_hash: h, awaiting_owner: chk.needsOwner}, chk.needsOwner ? p.id : null);
      this.save(); this.store.audit({type: 'deal.countered', deal: d.id, by: p.id, terms_hash: h});
      return this.dealView(d, p);
    });
  }

  accept(p, id, {terms_hash, signature}) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p)), cur = this.current(d);
      if (d.status !== 'open' || cur.state !== 'open') throw new PilotError('not_open', `deal is ${d.status}; nothing to accept`, 409);
      if (cur.by === p.id) throw new PilotError('own_offer', 'you cannot accept your own offer', 409);
      if (d.pending_counter?.by === p.id)
        throw new PilotError('counter_pending', "your own counter-offer is waiting for your owner's approval; withdraw it before accepting", 409);
      if (terms_hash !== cur.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match the current open version ${cur.v} (${cur.terms_hash})`, 409);
      this.partiesCurrent(cur);
      await this.verifySig(p, statements.accept(cur.terms_hash), signature, 'acceptance');
      const role = d.payer === p.id ? 'payer' : 'payee';
      const chk = await this.checkMandate(p, role, role === 'payer' ? d.payee : d.payer, cur.terms.price.amount);
      const pchk = await this.proposerStillAuthorized(d, cur);
      d.acceptance = {version: cur.v, by: p.id, terms_hash: cur.terms_hash, signature, at: iso(this.now()), mandate_check: chk, state: 'awaiting_owner'};
      this.event(d, p.id, 'accepted', {version: cur.v, terms_hash: cur.terms_hash, awaiting_owner: chk.needsOwner});
      if (chk.needsOwner) d.acceptance.approval_id = this.approval(p, d, 'accept', cur).id;
      this.settleAcceptance(d, cur, pchk);              // agreed now, or held for the acceptor's and/or the proposer's owner
      this.save(); this.store.audit({type: 'deal.accepted', deal: d.id, by: p.id, terms_hash: cur.terms_hash});
      return this.dealView(d, p);
    });
  }

  form(d) {
    const cur = this.current(d), acc = d.acceptance;
    // An agreement is the current version signed by its proposer and accepted, over the same terms, by the OTHER party.
    if (!acc || acc.version !== cur.v || acc.terms_hash !== cur.terms_hash || acc.by === cur.by || ![d.payer, d.payee].includes(acc.by))
      throw new PilotError('not_pending', 'the acceptance does not match the current terms; nothing was agreed', 409);
    cur.state = 'accepted'; d.status = 'agreed';
    this.voidPending(d, 'superseded');
    d.agreement = {version: cur.v, terms: cur.terms, terms_hash: cur.terms_hash, proposer_signature: cur.signature, acceptor_signature: d.acceptance.signature,
      proposer: cur.by, acceptor: d.acceptance.by, formed_at: iso(this.now())};
    this.event(d, 'valun', 'agreed', {version: cur.v, terms_hash: cur.terms_hash});
  }

  decline(p, id, {terms_hash, signature, reason = ''}) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p)), cur = this.current(d);
      if (d.status !== 'open' || cur.state !== 'open') throw new PilotError('not_open', `deal is ${d.status}; nothing to decline`, 409);
      if (cur.by === p.id) throw new PilotError('own_offer', 'withdraw your own offer instead of declining it', 409);
      if (terms_hash !== cur.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match the current version ${cur.v}`, 409);
      // The signature covers the reason exactly as the client sent it; older clients signed the cleaned text, accepted too.
      if (reason != null && typeof reason !== 'string') throw new PilotError('invalid_field', 'reason must be text');
      const signed = reason ?? '';
      if (signed.length > 600) throw new PilotError('invalid_field', 'reason is longer than 600 characters, counting leading and trailing whitespace (at most 500 without it)');   // OQ-32
      if (hasUnsafeText(signed)) throw new PilotError('invalid_field', 'reason contains control, bidi or invisible characters; remove them and sign again');
      reason = clean(signed, 500, 'reason');
      await this.verifySig(p, statements.decline(cur.terms_hash, signed), signature, 'decline', [statements.decline(cur.terms_hash, reason)]);
      this.voidPending(d, 'declined');
      cur.state = 'declined'; d.status = 'declined';
      d.decline = {version: cur.v, by: p.id, reason, ...(signed !== reason ? {reason_as_signed: signed} : {}), signature, at: iso(this.now())};
      this.event(d, p.id, 'declined', {version: cur.v, reason});
      this.save(); this.store.audit({type: 'deal.declined', deal: d.id, by: p.id});
      return this.dealView(d, p);
    });
  }

  withdraw(p, id, {terms_hash, signature}) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p)), cur = d.pending_counter?.by === p.id ? d.pending_counter : this.current(d);
      if (cur.by !== p.id || !['open', 'awaiting_owner'].includes(cur.state)) throw new PilotError('not_open', 'you have no open offer on this deal to withdraw', 409);
      if (terms_hash !== cur.terms_hash) throw new PilotError('stale_terms', 'terms_hash does not match your open offer', 409);
      await this.verifySig(p, statements.withdraw(cur.terms_hash), signature, 'withdrawal');
      cur.state = 'withdrawn';
      for (const a of Object.values(this.s.approvals)) if (a.deal_id === d.id && a.terms_hash === cur.terms_hash && a.state === 'pending') a.state = 'void_withdrawn';
      let acceptanceVoided = false;
      if (cur === d.pending_counter) { d.superseded_counters = [...(d.superseded_counters || []), cur]; d.pending_counter = null; }
      else {
        d.status = 'withdrawn'; this.voidPending(d, 'withdrawn');
        // An acceptance still waiting for an owner never took effect: it is void with the offer it accepted (OQ-6).
        if (d.acceptance?.state === 'awaiting_owner') { d.acceptance.state = 'void_withdrawn'; d.acceptance.voided_at = iso(this.now()); acceptanceVoided = true; }
      }
      this.event(d, p.id, 'withdrawn', {version: cur.v, ...(acceptanceVoided ? {acceptance_voided: true} : {})}, cur.offered_at ? null : p.id);
      this.save(); this.store.audit({type: 'deal.withdrawn', deal: d.id, by: p.id});
      return this.dealView(d, p);
    });
  }

  // Owner decides a pending approval (server-attested: recorded under the owner token, not a key signature).
  // Dispatch is explicit on the approval kind (APPROVAL_KINDS): issue_note, pay_by_transfer, propose, accept,
  // confirm_offer. Any other kind is refused with 409 unknown_approval_kind before anything changes (the deal is not even
  // swept).
  decideApproval(p, approvalId, {decision, note = ''}) {
    return this.serial(async () => {
      const a = this.s.approvals[approvalId];
      if (!a || a.participant !== p.id) throw new PilotError('not_found', 'unknown approval', 404);
      if (a.state !== 'pending') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
      if (!['approve', 'reject'].includes(decision)) throw new PilotError('invalid_field', 'decision must be approve or reject');
      if (!APPROVAL_KINDS.includes(a.kind)) {
        this.store.audit({type: 'approval.unknown_kind', id: a.id, deal: a.deal_id, kind: a.kind});
        throw new PilotError('unknown_approval_kind', `this server cannot decide an approval of kind ${JSON.stringify(a.kind)} (it decides ${APPROVAL_KINDS.join(', ')}); nothing was changed`, 409);
      }
      // MIG-1: approving a held credit note or payment by transfer sends it to the tracker; a rejection sends nothing.
      if (decision === 'approve' && (a.kind === 'issue_note' || a.kind === 'pay_by_transfer')) this.assertTrackerWritable();
      const d = this.sweep(this.deal(a.deal_id));
      if (a.state !== 'pending') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
      const cleanNote = clean(note, 300, 'note');
      const role = d.payer === p.id ? 'payer' : 'payee', other = role === 'payer' ? d.payee : d.payer;
      // The owner's note is for this participant's side only: it is kept on the approval, never in the shared history.
      if (a.kind === 'issue_note') {
        // The owner reviews a delivery the agent accepted; approving releases the agent-signed credit note to the tracker.
        if (d.status !== 'completion_awaiting_owner' || d.credit_note?.approval_id !== a.id) throw new PilotError('not_pending', 'this approval no longer matches the deal', 409);
        // Releasing a held note while another note on its pair is unconfirmed could leave one of the two off the tracker:
        // the approval stays pending (pair_busy) until that note is settled.
        if (decision === 'approve') { const k = this.noteKeysOf(d); this.assertPairFree(d, k.issuer, k.recipient); this.assertNoteEdgeFree(k.issuer, k.recipient); }
        a.decided_at = iso(this.now()); a.note = cleanNote;
        if (decision === 'approve') {
          const {issuer, recipient} = this.noteKeysOf(d), cur = await this.basis.note(issuer, recipient);
          const keysNow = this.s.participants[d.payer].pubkey === issuer && this.s.participants[d.payee].pubkey === recipient;
          // The pair's tracker state must still be exactly the one the agent signed against: the total, and also the last
          // note's timestamp and signature (d.note_prior, kept by complete()), so a pair that went down and back up to the
          // same total is stale too. A note held by an older version has no d.note_prior: only its total is compared.
          // A bound note held past the tracker's maximum age (decision D-1 item 4) is not stale here: the tracker refuses
          // it (novation_expired), the read-back shows it did not apply, and the deal is note_failed (submitNote).
          const totalSame = Number(cur?.amount_collected ?? 0) === d.credit_note.prior_total, prior = d.note_prior;
          const noteSame = !prior || (Number(cur?.amount_collected ?? 0) === prior.total && (cur?.timestamp ?? null) === prior.timestamp && (cur?.signature ?? null) === prior.signature);
          if (!keysNow || !totalSame || !noteSame) {
            // A deal whose acceptance already stood (payment_due, circulating credit) returns to payment_due.
            a.state = 'void_stale'; d.credit_note.state = 'stale'; d.status = d.payment_due_since ? 'payment_due' : 'delivered';
            this.event(d, `owner:${p.id}`, 'owner_approval_void_stale', {kind: 'issue_note'});
            this.save(); this.store.audit({type: 'approval.void_stale', id: a.id, deal: d.id, keys_changed: !keysNow, ...(keysNow && totalSame ? {last_note_changed: true} : {})});
            throw new PilotError('stale_note', !keysNow ? "a party's agent key changed since the agent signed this credit note; the agent must sign a new one with the current keys"
              : totalSame ? "the pair's last credit note on the tracker changed since the agent signed this credit note (the total is the same, the note is not); the agent must sign a new one"
                : "the pair's tracker total changed since the agent signed this credit note; the agent must sign a new one", 409);
          }
          a.state = 'approved';
          d.credit_note.owner_approval = {approval_id: a.id, at: a.decided_at}; d.credit_note.state = 'submitting'; d.status = 'issuing_note';
          this.event(d, `owner:${p.id}`, 'owner_approved', {kind: 'issue_note'});
          this.save(); this.store.audit({type: 'approval.approved', id: a.id, deal: d.id});
          await this.submitNote(d);
        } else {
          a.state = 'rejected';
          d.rejected_notes = [...(d.rejected_notes || []), {...d.credit_note, state: 'rejected_by_owner'}];
          d.credit_note = null; this.releaseAcceptance(d);       // delivered (completion cleared), or payment_due if it stood
          this.event(d, `owner:${p.id}`, 'owner_rejected', {kind: 'issue_note'});
          this.save(); this.store.audit({type: 'approval.rejected', id: a.id, deal: d.id});
        }
        return {approval: a, deal: await this.dealView(d, p)};
      }
      // A payment by debt transfer the payer's agent posted while its owner reviews deliveries (circulating credit).
      if (a.kind === 'pay_by_transfer') return this.decidePayByTransfer(p, a, d, decision, cleanNote);
      // propose, accept or confirm_offer (the only kinds left: APPROVAL_KINDS was checked above).
      // For an acceptance, the version is the one the agent accepted, and it must still be the current one (F1: never
      // whatever happens to be current when the owner decides).
      // A confirm_offer approval (F4) is the proposer's owner confirming the offer its agent made, now accepted: the same
      // acceptance, decided from the proposer's side.
      // The version the approval is for, while the deal still waits for this decision (else null).
      const matching = () => {
        const v = a.kind === 'propose' ? (d.pending_counter?.approval_id === a.id ? d.pending_counter : d.versions.find(x => x.approval_id === a.id))
          : d.versions.find(x => x.v === d.acceptance?.version);         // accept, confirm_offer
        const ownSide = a.kind === 'accept' ? d.acceptance?.approval_id === a.id && v?.by !== p.id
          : a.kind === 'confirm_offer' && d.acceptance?.proposer_approval_id === a.id && v?.by === p.id;
        return !v || (a.kind !== 'propose' && (!ownSide || d.status !== 'accepted_awaiting_owner' || v !== this.current(d) || v.terms_hash !== d.acceptance.terms_hash)) ? null : v;
      };
      const v = matching();
      if (!v) throw new PilotError('not_pending', 'this approval no longer matches the deal', 409);
      // A counter-offer cannot replace the version under a pending acceptance: decide (or reject) the acceptance first.
      if (a.kind === 'propose' && decision === 'approve' && v === d.pending_counter && (d.status === 'accepted_awaiting_owner' || d.acceptance))
        throw new PilotError('conflicting_pending', 'an acceptance of the current version is waiting for an owner; decide it first', 409);
      // Everything is validated before anything changes, so a failure leaves the approval pending and the deal untouched:
      // the hard limits again (other commitments may have been made since the agent acted), both parties' keys, and for an
      // acceptance the proposer's mandate.
      let pchk = null;
      if (decision === 'approve') {
        if (Date.parse(v.terms.offer_expires_at) < this.now()) throw new PilotError('expired', 'the offer expired before this decision', 409);
        this.partiesCurrent(v);
        await this.checkMandate(p, role, other, v.terms.price.amount, {excludeDealId: d.id});
        if (a.kind === 'accept') pchk = await this.proposerStillAuthorized(d, v);
        if (a.kind === 'confirm_offer') await this.acceptorStillAuthorized(d, v);
        // The lock serialises writes only: while the checks above awaited the tracker, a read that sweeps (a deal view,
        // /inbox, /owner) may have expired the offer or the held acceptance, voiding this approval. The deal is swept
        // again and must still wait for this decision, so an expired offer is never revived; otherwise 409 not_pending
        // and nothing is decided. Without such a race nothing changes here.
        this.sweep(d);
        if (a.state !== 'pending') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
        if (matching() !== v || (a.kind === 'propose' && v.state !== 'awaiting_owner')) throw new PilotError('not_pending', 'this approval no longer matches the deal', 409);
      }
      a.state = decision === 'approve' ? 'approved' : 'rejected'; a.decided_at = iso(this.now()); a.note = cleanNote;
      const offered = a.kind === 'propose' && decision === 'approve';
      this.event(d, `owner:${p.id}`, `owner_${a.state}`, {kind: a.kind, version: a.version, ...(offered ? {offered: true} : {})},
        a.kind === 'propose' && decision !== 'approve' ? p.id : null);
      if (a.kind === 'propose') {
        if (decision === 'approve') {
          v.state = 'open'; v.owner_approval = {approval_id: a.id, at: a.decided_at}; v.offered_at = a.decided_at;
          if (v === d.pending_counter) { this.current(d).state = 'countered'; d.versions.push(v); d.pending_counter = null; }
          d.status = 'open';
        } else {
          v.state = 'rejected_by_owner';
          if (v === d.pending_counter) { d.superseded_counters = [...(d.superseded_counters || []), v]; d.pending_counter = null; }
          else d.status = 'rejected_by_owner';
        }
      } else if (a.kind === 'accept') {
        if (decision === 'approve') { d.acceptance.owner_approval = {approval_id: a.id, at: a.decided_at}; this.settleAcceptance(d, v, pchk); }
        else {
          // A confirmation the proposer's owner was asked for belongs to this acceptance: it is void with it.
          for (const x of Object.values(this.s.approvals)) if (x.id === d.acceptance.proposer_approval_id && x.state === 'pending') x.state = 'void_acceptance_rejected';
          d.acceptance.state = 'rejected_by_owner'; d.rejected_acceptances = [...(d.rejected_acceptances || []), d.acceptance]; d.acceptance = null; d.status = 'open';
        }
      } else if (a.kind === 'confirm_offer') {
        if (decision === 'approve') { v.owner_approval = {approval_id: a.id, at: a.decided_at, after_acceptance: true}; this.settleAcceptance(d, v, null); }
        else {
          // The proposer's owner does not confirm its agent's offer: the offer is withdrawn (by the owner, server-attested)
          // and the acceptance is void, as when the agent withdraws it (OQ-6).
          v.state = 'withdrawn'; d.status = 'withdrawn'; d.acceptance.state = 'void_withdrawn'; d.acceptance.voided_at = a.decided_at;
          this.voidPending(d, 'withdrawn');
          this.event(d, `owner:${p.id}`, 'withdrawn', {version: v.v, acceptance_voided: true, by_owner: true});
        }
      }
      this.save(); this.store.audit({type: `approval.${a.state}`, id: a.id, deal: d.id});
      return {approval: a, deal: await this.dealView(d, p)};
    });
  }

  deliver(p, id, {terms_hash, content, title = '', sha256: claimed, signature}) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p));          // past its delivery grace period an agreed deal has ended (OQ-8)
      if (d.payee !== p.id) throw new PilotError('not_payee', 'only the payee delivers', 403);
      if (d.status !== 'agreed') throw new PilotError('wrong_state', `deal is ${d.status}; delivery needs an agreed deal`, 409);
      if (terms_hash !== d.agreement.terms_hash) throw new PilotError('stale_terms', 'terms_hash does not match the agreement', 409);
      if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 32768) throw new PilotError('invalid_field', 'content must be 1..32768 bytes of text');
      const h = sha256(content);
      if (claimed && claimed !== h) throw new PilotError('hash_mismatch', 'sha256 does not match the content', 400);
      await this.verifySig(p, statements.deliver(d.agreement.terms_hash, h), signature, 'delivery');
      const late = this.now() > Date.parse(d.agreement.terms.deliver_by);
      d.delivery = {by: p.id, title: clean(title, 120, 'title'), content, sha256: h, bytes: Buffer.byteLength(content), signature, at: iso(this.now()), late};
      d.status = 'delivered';
      this.event(d, p.id, 'delivered', {sha256: h, late});
      this.save(); this.store.audit({type: 'deal.delivered', deal: d.id, sha256: h});
      return this.dealView(d, p);
    });
  }

  // Which keys a credit note is between. An agreement binds the participants, not their keys: if an owner revoked an agent
  // after the deal was agreed, the note is signed by the payer's current key and credits the payee's current key. A note
  // already signed records its own keys.
  noteParties(d) {
    const a = this.s.participants[d.payer], b = this.s.participants[d.payee];
    if (a.status !== 'active' || !a.pubkey) throw new PilotError('no_key', 'the payer has no registered agent key', 409);
    if (b.status !== 'active' || !b.pubkey) throw new PilotError('payee_no_key', `${b.handle} has no registered agent key right now (its owner revoked it); the credit note can be issued once a new key is enrolled`, 409);
    return {issuer: a.pubkey, recipient: b.pubkey};
  }
  noteKeysOf(d) {
    const t = d.agreement.terms, n = d.credit_note;
    return {issuer: n?.issuer_pubkey ?? t.payer.pubkey, recipient: n?.recipient_pubkey ?? t.payee.pubkey};
  }
  // 409 pair_busy while ANOTHER deal on this issuer>recipient key pair is issuing_note: its note was written ahead and
  // may already be on the tracker without Valun having read it back (a tracker failure in the middle of submitNote).
  // A new note on the pair meanwhile would be signed over a prior that already includes it, and the first deal's own
  // note would then fail on resubmission, so the payer would be asked to pay it again. recover() (every 60 s) settles it.
  assertPairFree(d, issuer, recipient) {
    for (const o of Object.values(this.s.deals)) {
      if (o.id === d.id || o.status !== 'issuing_note') continue;
      const k = this.noteKeysOf(o);
      if (k.issuer === issuer && k.recipient === recipient)
        throw new PilotError('pair_busy', "another credit note for this key pair is being issued and the tracker has not confirmed it yet; a new note now could count it twice. Try again in 60 s.", 409, {retry_after_ms: PAIR_BUSY_RETRY_MS});
    }
  }

  // The template's timestamp is after the pair's last note and never after this server's clock (OQ-12), which is the rule
  // complete() enforces and the Basis tracker applies with its own clock (later than the pair's last note, not in the
  // future). If the pair's last note is ahead of this clock (a note submitted around Valun, or a tracker clock running
  // ahead), the template waits up to NOTE_CLOCK_WAIT_MS for the clock to pass it; further ahead, it refuses with
  // 409 note_timestamp_ahead and retry_after_ms. `wait: false`: never wait (refuse instead).
  // Against a tracker that keeps timestamp residues for other operations (tracker v3: 995-999), the timestamp skips them
  // (ordinaryTimestamp: at most 5 ms later), since that tracker refuses them for an ordinary note.
  // Opt-in, so that a template asked for without them stays exactly as before:
  //   prior: true (?prior=1, any mode)  adds prior_note, the pair's tracker note {total, timestamp, signature} (its
  //                                     signature is the issuer's own, so the payer can verify it), or null;
  //   bound: true (?bound=1, mode bound and above; else 409 feature_unavailable)  a bound note (design §3.2, §4.3): the
  //                                     timestamp is the largest one ending in 997 ms, at least 1.5 s before this
  //                                     server's clock and after the pair's last note; adds prior_note,
  //                                     prior_timestamp (prior_note's timestamp, 0 when the pair has no note) and
  //                                     prior_message_hex, the issuer's prior acknowledgment
  //                                     PA(I,R,prior_total,prior_timestamp,timestamp) of tracker v3.2 (for information:
  //                                     the payer builds and signs it itself).
  // Circulating credit: also from payment_due (a payment by transfer did not apply); refused while an earlier transfer
  // attempt can still apply (409 transfer_window_open, D-1), and while a payment by transfer holds the note's edge (409
  // novation_pending with the consents the payer must sign or refuse first, else 409 edge_busy).
  async noteTemplate(p, id, {wait = true, prior: withPrior = false, bound = false} = {}) {
    const d = this.partyDeal(id, p);
    if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer signs the credit note', 403);
    if (!PAYABLE.includes(d.status)) throw new PilotError('wrong_state', `deal is ${d.status}; a credit note follows a delivery`, 409);
    if (bound && this.mode === 'off') throw new PilotError('feature_unavailable', 'bound credit notes are not enabled on this server (circulating credit is off); fetch the template without bound=1', 409);
    const t = d.agreement.terms, {issuer, recipient} = this.noteParties(d);
    this.assertPairFree(d, issuer, recipient);
    this.assertNoteEdgeFree(issuer, recipient);
    if (this.hasTransferAttempts(d)) { const block = await this.paymentBlock(d, {route: 'note'}); if (block) throw this.paymentBlockError(block); }
    const reserved = bound ? null : await this.reservedResidues();
    const cur = await this.basis.note(issuer, recipient);
    const prior = Number(cur?.amount_collected ?? 0), total = prior + t.price.amount, last = Number(cur?.timestamp ?? 0);
    let timestamp, ahead;
    if (bound) {
      // Circulating credit (decision D-2 b): also after every live set-off's timestamp on the pair, so that a set-off
      // applied between this template and the note's post leaves the pair at a timestamp before the note's.
      const after = this.circulating ? Math.max(last, this.liveSetoffTimestamp(edgeKey(issuer, recipient))) : last;
      const r = residueTimestamp(this.now(), BOUND_NOTE_MS, after);
      timestamp = r.timestamp; ahead = r.ahead_ms ?? 0;
    } else {
      timestamp = Math.max(this.now() - 1500, last + 1);
      if (reserved) timestamp = ordinaryTimestamp(timestamp);
      ahead = timestamp - this.now();
    }
    if (ahead > 0) {
      if (!wait || ahead > NOTE_CLOCK_WAIT_MS) throw new PilotError('note_timestamp_ahead', bound
        ? `a bound credit note needs a timestamp ending in ${BOUND_NOTE_MS} ms, after the pair's last credit note on the tracker (timestamped ${last}) and at least 1.5 s before this server's clock; there is one in ${ahead} ms. Fetch the template again in ${Math.ceil(ahead / 1000)} s.`
        : `the pair's last credit note on the tracker is timestamped ${last}, ${ahead} ms after this server's clock; a new note must be later than it and not in the future. Fetch the template again in ${Math.ceil(ahead / 1000)} s.`,
      409, {retry_after_ms: ahead, last_note_timestamp: last});
      await new Promise(r => setTimeout(r, ahead + 5));
      return this.noteTemplate(p, id, {wait: false, prior: withPrior, bound});     // read the tracker again: the pair's note may have changed meanwhile
    }
    const {message_hex} = await this.noteMessage({issuer, recipient, total, timestamp});
    const out = {deal_id: d.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, issuer_pubkey: issuer, recipient_pubkey: recipient,
      keys_as_agreed: issuer === t.payer.pubkey && recipient === t.payee.pubkey,
      prior_total: prior, price: t.price.amount, total, timestamp, tracker_nft_id: this.basis.nft, denomination: this.basis.denomination, message_hex};
    if (withPrior || bound) out.prior_note = cur ? {total: prior, timestamp: cur.timestamp, signature: cur.signature} : null;
    if (bound) {
      out.prior_timestamp = cur ? cur.timestamp : 0;
      out.prior_message_hex = await this.messageHex({issuer, recipient, total: prior, prior_timestamp: out.prior_timestamp, timestamp});
    }
    return out;
  }

  // Circulating credit: also from payment_due (the acceptance stands; the payer pays with its own note), but refused with
  // 409 transfer_window_open (retry_after_ms) while an earlier transfer attempt of the deal can still apply (D-1), and
  // while a payment by transfer holds the note's edge (409 novation_pending / edge_busy).
  // Circulating credit (decision D-2 b): a note the payer signed and posted that is refused here is still a payment
  // attempt its client keeps until it is dead, so it is recorded (recordRefusedNote) before the refusal is answered.
  complete(p, id, {terms_hash, deliverable_sha256, signature, credit_note: note}) {
    return this.serial(async () => {
      this.assertTrackerWritable();                 // MIG-1: before anything is checked, sent or recorded
      try { return await this.completeLocked(p, id, {terms_hash, deliverable_sha256, signature, note}); }
      catch (e) { await this.recordRefusedNote(p, id, note, e); throw e; }
    }).catch(async e => {
      // A stale bound note: its fresh bound template, made now that the lock is released (it may wait up to
      // NOTE_CLOCK_WAIT_MS for a timestamp ending in 997 ms, as GET credit-note-template?bound=1 does); null if none.
      if (e instanceof PilotError && e.freshBoundTemplate) e.extra.template = await this.noteTemplate(p, id, {bound: true}).catch(() => null);
      throw e;
    });
  }
  // complete() with the lock held.
  async completeLocked(p, id, {terms_hash, deliverable_sha256, signature, note}) {
    {
      const d = this.partyDeal(id, p);
      if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer accepts the delivery', 403);
      if (!PAYABLE.includes(d.status)) throw new PilotError('wrong_state', `deal is ${d.status}; nothing to complete`, 409);
      if (terms_hash !== d.agreement.terms_hash || deliverable_sha256 !== d.delivery.sha256) throw new PilotError('stale_terms', 'hashes do not match the agreement and delivery', 409);
      await this.verifySig(p, statements.complete(terms_hash, deliverable_sha256), signature, 'completion');
      const t = d.agreement.terms, {issuer, recipient} = this.noteParties(d);
      this.assertPairFree(d, issuer, recipient);
      this.assertNoteEdgeFree(issuer, recipient);
      if (this.hasTransferAttempts(d)) { const block = await this.paymentBlock(d, {route: 'note'}); if (block) throw this.paymentBlockError(block); }
      // Against a tracker that keeps timestamp residues (tracker v3: 995-999), a timestamp ending in 997 ms makes this a
      // bound note (design §3.2): it carries the issuer's prior acknowledgment, prior_signature over
      // PA(I,R,prior_total,prior_timestamp,timestamp) (tracker v3.2: the pair's note as it is now, its total and its
      // timestamp, 0 and 0 for a pair with no note), and the tracker applies it only while the pair is still in exactly
      // that state. A posted prior_timestamp (optional, as prior_total is) must be that timestamp (else 409 stale_note);
      // without one it is not asserted, and the acknowledgment is checked over the pair's current state all the same.
      // The other reserved residues are refused for a credit note. Against an older tracker every residue is ordinary.
      const reserved = await this.reservedResidues();
      const bound = !!reserved?.includes(BOUND_NOTE_MS) && Number.isSafeInteger(note?.timestamp) && note.timestamp % 1000 === BOUND_NOTE_MS;
      // 409 stale_note with a fresh template. A fresh bound template is made once the lock is released (below): it may
      // have to wait for a timestamp ending in 997 ms, and nothing else should wait for it.
      const staleNote = async message => bound ? Object.assign(new PilotError('stale_note', message, 409, {template: null}), {freshBoundTemplate: true})
        : new PilotError('stale_note', message, 409, {template: await this.noteTemplate(p, id, {wait: false}).catch(() => null)});
      const cur = await this.basis.note(issuer, recipient);
      const prior = Number(cur?.amount_collected ?? 0);
      if (!note || note.total !== prior + t.price.amount) throw await staleNote(`the credit note total must be ${prior + t.price.amount} (tracker prior ${prior} + price ${t.price.amount}); fetch a new credit-note template${bound ? ' (bound=1)' : ''}`);
      if (!isInt(note.timestamp, Number(cur?.timestamp ?? 0) + 1, this.now())) throw new PilotError('stale_note', 'the credit note timestamp must be after the pair\'s last note and not in the future', 409);
      // A bound note older than the tracker's maximum age (tracker v3.1, decision D-1) can never apply.
      if (bound && note.timestamp < this.now() - MAX_AGE_MS) throw await staleNote('a bound credit note more than one hour old can no longer be recorded by the tracker; fetch a new credit-note template (bound=1)');
      if (reserved && !bound && reserved.includes(note.timestamp % 1000))
        throw await staleNote(`the credit note timestamp ${note.timestamp} ends in ${note.timestamp % 1000} ms, which the tracker keeps for other operations (${reserved.join(', ')}); fetch a new credit-note template`);
      if (bound && note.prior_total !== prior)
        throw await staleNote(`a bound credit note's prior_total must be the pair's current total on the tracker, ${prior}; fetch a new credit-note template (bound=1)`);
      const priorTs = cur ? cur.timestamp : 0;
      if (bound && note.prior_timestamp != null && note.prior_timestamp !== priorTs)
        throw await staleNote(`a bound credit note's prior_timestamp must be the timestamp of the pair's current note on the tracker, ${priorTs} (0 for a pair with no note); fetch a new credit-note template (bound=1)`);
      const {message_hex} = await this.noteMessage({issuer, recipient, total: note.total, timestamp: note.timestamp});
      if (!(await this.safeVerify(issuer, message_hex, note.signature))) throw new PilotError('bad_signature', 'the Basis note signature does not verify', 403);
      if (bound) {
        const ack = await this.messageHex({issuer, recipient, total: prior, prior_timestamp: priorTs, timestamp: note.timestamp});
        if (!(await this.safeVerify(issuer, ack, note.prior_signature)))
          throw new PilotError('bad_signature', `the prior acknowledgment (credit_note.prior_signature) does not verify: it must be the issuer's signature over the prior acknowledgment ${PRIOR_ACK} of the pair's current note (total ${prior}, timestamp ${priorTs}) at the note's timestamp`, 403);
      }
      d.completion = {by: p.id, signature, at: iso(this.now()), deliverable_sha256};
      // Circulating credit: a note the payer signed for this deal earlier, which the tracker refused or which went stale
      // for its owner, is still a payment attempt its client checks by reading the pair back (decision D-1), so the
      // clearing engine keeps off the pair while the deal is unpaid (paymentAttemptHolds), and a payment by transfer waits
      // for it (paymentBlock). Its keys, totals, timestamp and the sha256 of its signature (never the signature) are
      // kept when this new note replaces it (internal only; never shown).
      const earlier = d.credit_note;
      if (this.circulating && earlier?.note && earlier.state !== 'recorded')
        d.replaced_notes = [...(d.replaced_notes || []), {state: earlier.state, issuer_pubkey: earlier.issuer_pubkey, recipient_pubkey: earlier.recipient_pubkey,
          prior_total: earlier.prior_total ?? null, note: {total: earlier.note.total ?? null, timestamp: earlier.note.timestamp, bound: !!earlier.note.prior_signature,
            signature_sha256: earlier.note.signature ? sigSha256(earlier.note.signature) : null}}];
      // A bound note keeps its prior acknowledgment with it (also while held for the owner); it goes to the tracker with it.
      d.credit_note = {state: 'signed', issuer_pubkey: issuer, recipient_pubkey: recipient, keys_as_agreed: issuer === t.payer.pubkey && recipient === t.payee.pubkey,
        note: {total: note.total, timestamp: note.timestamp, signature: note.signature, message_hex, ...(bound ? {prior_signature: note.prior_signature} : {})},
        prior_total: prior, amount: t.price.amount, signed_at: iso(this.now()),
        completion: {signature, deliverable_sha256}};
      // The pair's tracker state this note was signed against, for the held-note staleness check (decideApproval). It is
      // kept on the deal, not in d.credit_note, which the parties' views show.
      d.note_prior = {total: prior, timestamp: cur?.timestamp ?? null, signature: cur?.signature ?? null};
      this.event(d, p.id, 'delivery_accepted', {sha256: deliverable_sha256});
      if (p.mandate.review_deliveries) {
        // The owner reviews the delivery before the credit note is issued. The signed note is held, not submitted.
        const a = this.approval(p, d, 'issue_note', {v: d.agreement.version, terms_hash: d.agreement.terms_hash});
        d.credit_note.approval_id = a.id; d.status = 'completion_awaiting_owner';
        this.event(d, 'valun', 'credit_note_awaiting_owner', {amount: t.price.amount});
        // Circulating credit (decision D-2 c): no set-off applies on a pair whose note waits for its owner; a collecting
        // one on it is superseded now (held_note).
        if (this.circulating) this.supersedeSetoffsOn([edgeKey(issuer, recipient)], 'held_note');
        this.save(); this.store.audit({type: 'deal.completion_awaiting_owner', deal: d.id});
        return this.dealView(d, p);
      }
      d.credit_note.state = 'submitting'; d.status = 'issuing_note';
      this.save();                                    // write-ahead: recover() finishes this after a crash
      return this.dealView(await this.submitNote(d), p);
    }
  }
  // Decision D-2 b (circulating credit): a credit note the payer posted to complete deal `id` and that was refused (`err`)
  // is recorded as a payment attempt of the deal (d.refused_attempts: its kind, timestamp, edge, prior and new totals and
  // the sha256 of its signatures, never a signature), when it is one the tracker could take: the deal is the caller's to
  // pay and not ended, and the note (with its prior acknowledgment, for a bound note) verifies for the payer's current
  // key. A bound note's acknowledgment is PA over the prior state it names (tracker v3.2): its posted prior_timestamp,
  // else (not asserted) the pair's note as it is now; that state is kept with the record (prior_total,
  // prior_timestamp). The D-1 windows then apply to it as to every other attempt (paymentBlock). A payer the server
  // runs (the sandbox agents) is left out: the server signs for it only what it records. While the signature checker is
  // unavailable (503 signer_unavailable) the note is recorded unverified (attemptSignaturesCheck). Never throws.
  async recordRefusedNote(p, id, note, err) {
    if (!this.circulating || this.serverRun(p) || !(err instanceof PilotError || err instanceof BasisError)) return;
    try {
      const d = typeof id === 'string' && Object.hasOwn(this.s.deals, id) ? this.s.deals[id] : null;
      if (!d || d.payer !== p.id || !d.agreement || !d.delivery || statusClass(d.status)?.terminal) return;
      if (!note || typeof note !== 'object' || !isInt(note.timestamp, 1, Number.MAX_SAFE_INTEGER) || !isInt(note.total, 1, Number.MAX_SAFE_INTEGER)
        || typeof note.signature !== 'string' || !SIG_RE.test(note.signature)) return;
      const {issuer, recipient} = this.noteParties(d), price = d.agreement.terms.price.amount, reserved = await this.reservedResidues();
      const bound = note.timestamp % 1000 === BOUND_NOTE_MS && !!reserved?.includes(BOUND_NOTE_MS);
      // An ordinary note at a residue the tracker keeps for other operations (995, 996, 998, 999 on tracker v3) is refused
      // by the tracker whatever else holds: it can never apply, so it is no attempt.
      if (!bound && reserved?.includes(note.timestamp % 1000)) return;
      const prior = bound ? note.prior_total : note.total - price;
      if (!Number.isSafeInteger(prior) || prior < 0 || prior >= note.total) return;
      if (bound && (typeof note.prior_signature !== 'string' || !SIG_RE.test(note.prior_signature))) return;
      const sha = sigSha256(note.signature);
      if (this.ownNoteAttempts(d).some(a => a.signature_sha256 === sha)) return;           // recorded already
      let priorTs = null;
      if (bound) {
        if (note.prior_timestamp == null) { const cur = await this.basis.note(issuer, recipient); priorTs = cur ? cur.timestamp : 0; }
        else priorTs = note.prior_timestamp;
        if (!isInt(priorTs, 0, note.timestamp - 1)) return;            // a prior state at or after the note: it can never apply
      }
      const checked = await this.attemptSignaturesCheck(issuer, [{issuer, recipient, total: note.total, timestamp: note.timestamp, signature: note.signature},
        ...(bound ? [{issuer, recipient, total: prior, prior_timestamp: priorTs, timestamp: note.timestamp, signature: note.prior_signature}] : [])]);
      if (!checked) return;
      this.addRefusedAttempt(d, {kind: 'note', bound, timestamp: note.timestamp,
        edges: [{edge: edgeKey(issuer, recipient), prior_total: prior, ...(bound ? {prior_timestamp: priorTs} : {}), new_total: note.total}],
        signature_sha256: {note: sha, ...(bound ? {prior: sigSha256(note.prior_signature)} : {})}, ...(checked === 'unverified' ? {unverified: true} : {})}, err);
    } catch { /* the refusal is answered as it was; nothing more is recorded */ }
  }
  // The signature check of a refused attempt's record (decision D-2 b): each of `sigs` ({issuer, recipient, total,
  // timestamp, prior_timestamp?, signature}) over its message (messageHex: the note message M(issuer, recipient, total,
  // timestamp), or with prior_timestamp the prior acknowledgment PA(issuer, recipient, total, prior_timestamp,
  // timestamp)) for `pubkey`. true when every
  // one verifies, false when one does not (no attempt: nothing is recorded), and 'unverified' when the signature checker
  // or the message helper is unavailable just now (503 signer_unavailable): the attempt is then recorded unverified,
  // because the payer's client keeps it as an attempt all the same, so it counts for the D-1 windows and the set-off
  // holds like any other. Like every refused attempt it is never shown, and its audit line says unverified. After the
  // first unavailable check no other is tried: the record is made under the lock, and each failed check waits for the
  // helper's timeout.
  async attemptSignaturesCheck(pubkey, sigs) {
    for (const s of sigs) {
      let ok;
      try { ok = await this.safeVerify(pubkey, await this.messageHex(s), s.signature); }
      catch (e) { if (e instanceof PilotError && e.code === 'signer_unavailable') return 'unverified'; throw e; }
      if (!ok) return false;
    }
    return true;
  }
  // Decision D-2 b: a payment by transfer the payer posted and that was refused (`err`) before the server recorded it,
  // recorded as an attempt of the deal when it is one the tracker could take with the other parties' signatures: the
  // deal is the caller's to pay and not ended, the issuer is another participant with a key, the timestamp ends in
  // 999 ms, the priors are whole numbers that cover the price, and the payer's three slot signatures verify for its
  // current key over the messages rebuilt from those values (recorded unverified while the signature checker is
  // unavailable: attemptSignaturesCheck): its prior slot over PA(A,B,X,p_AB,T) with the posted from_prior_timestamp, else
  // (not asserted) the timestamp of A->B's note as it is now; the record keeps that prior state of its from-edge (for
  // the same-prior exemption, samePriorState) and the posted to_prior_timestamp (null when none was posted). Never
  // throws.
  async recordRefusedTransfer(p, id, b, err) {
    if (!this.circulating || this.serverRun(p) || !(err instanceof PilotError || err instanceof BasisError)) return;
    try {
      const d = typeof id === 'string' && Object.hasOwn(this.s.deals, id) ? this.s.deals[id] : null;
      if (!d || d.payer !== p.id || !d.agreement || !d.delivery || statusClass(d.status)?.terminal || !p.pubkey) return;
      const A = typeof b?.issuer_id === 'string' && PID_RE.test(b.issuer_id) && Object.hasOwn(this.s.participants, b.issuer_id) ? this.s.participants[b.issuer_id] : null;
      const C = this.s.participants[d.payee], a = d.agreement.terms.price.amount, T = b?.timestamp, X = b?.from_prior_total, Y = b?.to_prior_total;
      if (!A?.pubkey || !C?.pubkey || A.id === p.id || A.id === C.id || !Number.isSafeInteger(T) || T < 0 || T % 1000 !== TRANSFER_MS) return;
      if (!Number.isSafeInteger(X) || X < a || !Number.isSafeInteger(Y) || Y < 0 || !Number.isSafeInteger(Y + a)) return;
      const asserted = v => v !== undefined && v !== null;
      if ((asserted(b.from_prior_timestamp) && !isInt(b.from_prior_timestamp, 0, T - 1)) || (asserted(b.to_prior_timestamp) && !isInt(b.to_prior_timestamp, 0, T - 1))) return;
      const pX = asserted(b.from_prior_timestamp) ? b.from_prior_timestamp : (await this.basis.note(A.pubkey, p.pubkey))?.timestamp ?? 0;
      const pY = asserted(b.to_prior_timestamp) ? b.to_prior_timestamp : null;
      if (!isInt(pX, 0, T - 1)) return;
      // The payee's prior slot (to-edge) is not the payer's: only the from-edge's prior state enters the payer's messages.
      const t = {issuer: {pubkey: A.pubkey}, payer: {pubkey: p.pubkey}, payee: {pubkey: C.pubkey}, amount: a, timestamp: T, from_edge: {before: {total: X, timestamp: pX}},
        to_edge: {before: Y || pY ? {total: Y, timestamp: pY ?? 0} : null}};
      const mine = transferSlots(t).filter(s => s.role === 'payer'), sigs = b.signatures;
      if (!sigs || typeof sigs !== 'object' || !mine.every(s => typeof sigs[s.key] === 'string' && SIG_RE.test(sigs[s.key]))) return;
      const sha = Object.fromEntries(mine.map(s => [s.key, sigSha256(sigs[s.key])])), prior = sha[mine.find(s => s.name === 'from_recipient_prior').key];
      if ((d.refused_attempts || []).some(x => x.kind === 'transfer' && Object.values(x.signature_sha256 ?? {}).includes(prior))) return;      // recorded already
      if (this.transfersOf(d).some(x => x.timestamp === T && (x.slots.from_recipient_prior?.signature ? sigSha256(x.slots.from_recipient_prior.signature) : x.signature_sha256?.from_recipient_prior) === prior)) return;
      const checked = await this.attemptSignaturesCheck(p.pubkey, mine.map(s => ({...slotMessage(s), signature: sigs[s.key]})));
      if (!checked) return;
      this.addRefusedAttempt(d, {kind: 'transfer', timestamp: T, issuer: {id: A.id, pubkey: A.pubkey}, amount: a,
        edges: [{which: 'from', edge: edgeKey(A.pubkey, p.pubkey), prior_total: X, prior_timestamp: pX, new_total: X - a},
          {which: 'to', edge: edgeKey(A.pubkey, C.pubkey), prior_total: Y, prior_timestamp: pY, new_total: Y + a}],
        signature_sha256: sha, ...(checked === 'unverified' ? {unverified: true} : {})}, err);
    } catch { /* the refusal is answered as it was; nothing more is recorded */ }
  }
  // Keeps refused attempt `a` on deal d (with the refusal's code and when), at most REFUSED_ATTEMPTS_KEPT of them, and
  // supersedes a collecting set-off on the edge of the payer's it would change (decision D-2 c). Saves.
  addRefusedAttempt(d, a, err) {
    const list = d.refused_attempts ??= [];
    list.push({...a, code: typeof err?.code === 'string' ? err.code : 'error', at: iso(this.now())});
    if (list.length > REFUSED_ATTEMPTS_KEPT) list.splice(0, list.length - REFUSED_ATTEMPTS_KEPT);
    this.supersedeSetoffsOn([this.refusedAttemptEdge(a)], 'payment_attempt');
    this.save();
    this.store.audit({type: 'payment.refused_attempt', deal: d.id, kind: a.kind, code: list.at(-1).code, timestamp: a.timestamp,
      edges: a.edges.map(e => ({edge: e.edge, prior: e.prior_total, after: e.new_total})), signature_sha256: a.signature_sha256, ...(a.unverified ? {unverified: true} : {})});
  }
  // The edge of the payer's that a refused attempt would change: the from-edge of a transfer (its claim), a note's pair.
  refusedAttemptEdge(a) { return (a.kind === 'transfer' ? a.edges.find(e => e.which === 'from') : a.edges[0])?.edge ?? null; }

  async submitNote(d, {recovering = false} = {}) {
    const n = d.credit_note.note, {issuer, recipient} = this.noteKeysOf(d);
    const before = recovering ? await this.basis.note(issuer, recipient) : null;
    let r = null;
    // A bound note goes with its prior acknowledgment (tracker v3 POST /notes: prior_signature, and prior_total; tracker
    // v3.2 also prior_timestamp, the timestamp of the pair's note it acknowledges, kept in d.note_prior: 0 for none).
    const priorTs = n.prior_signature && d.note_prior ? {prior_timestamp: d.note_prior.timestamp ?? 0} : {};
    // MIG-1: nothing is sent while pilot writes are refused; the deal stays issuing_note for recovery, which finishes it
    // once the tracker is v3.2 again (the write paths refuse before they get here: this only backs them up).
    if (before?.signature !== n.signature && this.writeRefusal()) return d;
    if (before?.signature !== n.signature) r = await this.basis.api('POST', '/notes', {issuer_pubkey: issuer, recipient_pubkey: recipient,
      amount: n.total, timestamp: n.timestamp, signature: n.signature, tracker_nft_id: this.basis.nft, denomination: this.basis.denomination,
      ...(n.prior_signature ? {prior_signature: n.prior_signature, prior_total: d.credit_note.prior_total, ...priorTs} : {})});
    const rb = await this.basis.note(issuer, recipient);
    const held = !!rb && rb.signature === n.signature && Number(rb.amount_collected) === n.total && rb.timestamp === n.timestamp;
    if (!held) {
      d.status = 'note_failed'; d.credit_note.state = 'failed';
      const code = typeof r?.json?.code === 'string' ? r.json.code : null;
      // A bound note in modes bound, sandbox and on (decision D-2 f) keeps only the tracker's status and code, never its
      // text, as novations do: credit_note.error is then this server's own sentence. Mode off (and an ordinary note)
      // keeps v15's text.
      if (n.prior_signature && this.mode !== 'off') {
        d.credit_note.error = r ? `the tracker did not record the note (HTTP ${r.status}${code ? `, ${code}` : ''})` : 'the tracker does not hold the note';
        if (r) d.credit_note.tracker_status = r.status;
      } else d.credit_note.error = r?.json?.error ?? r?.text?.slice(0, 300) ?? 'the tracker does not hold the note';
      // A bound note also keeps the tracker's code (for example novation_expired: held for its owner past the tracker's
      // maximum age, decision D-1 item 4); the payer then signs a new bound note.
      if (n.prior_signature && code) d.credit_note.error_code = code;
      this.event(d, 'basis-tracker', 'credit_note_failed', {error: d.credit_note.error});
      // Circulating credit (decision D-2 c): the failed note is a payment attempt of an unpaid deal; a collecting set-off
      // on its pair is superseded.
      if (this.circulating) this.supersedeSetoffsOn([edgeKey(issuer, recipient)], 'payment_attempt');
    } else {
      const proof = await this.basis.proof(issuer, recipient);
      // Valun verified this exact signature over this exact message when the payer completed; the re-check below is a second
      // look. If the helper is down at this moment the tracker already holds the note, so the deal is recorded as issued
      // (not left issuing_note) and the skipped re-check is said so (OQ-31 residual).
      let reverifySkipped = false;
      const verified = await this.basis.verify(issuer, n.message_hex, rb.signature)
        .catch(e => { if (e?.code === 'signer_unavailable') { reverifySkipped = true; return true; } throw e; });
      d.status = 'note_issued';
      d.credit_note = {...d.credit_note, issuer_pubkey: issuer, recipient_pubkey: recipient, state: 'recorded', outstanding: true, settled: false, tracker_status: r ? r.status : 'already held (recovered)', recovered: recovering || undefined, recorded_at: iso(this.now()),
        tracker_note: {amount_collected: Number(rb.amount_collected), amount_redeemed: Number(rb.amount_redeemed), timestamp: rb.timestamp, signature: rb.signature, confirmation: rb.confirmation?.status},
        verified_by_valun: verified, ...(reverifySkipped ? {reverify_skipped: 'signer unavailable; the tracker holds exactly the signature Valun verified at completion'} : {}),
        proof: proof && {key: proof.key, value: proof.value, proof: proof.proof, tracker_state_digest: proof.tracker_state_digest}};
      this.event(d, 'basis-tracker', 'credit_note_recorded', {amount: d.credit_note.amount, cumulative_total: n.total, confirmation: rb.confirmation?.status, recovered: recovering});
      // The edge journal (in the same save): the price issued, and the pair's note on the tracker now.
      const [entry] = appendEntries(this, [{kind: 'issue', ref: d.id, issuer_pubkey: issuer, recipient_pubkey: recipient, delta: d.agreement.terms.price.amount,
        total_after: Number(rb.amount_collected), timestamp: rb.timestamp, signature: rb.signature}]);
      d.journal_seq = entry.seq;
    }
    this.save(); this.store.audit({type: `deal.${d.status}`, deal: d.id});
    // Circulating credit: the raised edge may close a cycle of debt (the clearing engine; never throws).
    if (d.status === 'note_issued') await this.clearingAfterIncrease([edgeKey(issuer, recipient)]);
    return d;
  }

  // Credit notes left issuing_note, then (circulating credit) transfers and set-offs: expired ones are swept, those left
  // applying are decided by read-back (recoverTransfer, recoverSetoff), and those left collecting with every signature
  // (a crash between the save of the last signature and the write-ahead of the apply) are applied now (applyTransfer,
  // applySetoff, which check everything again); each reported as '<vt or vs id>:<state>'. Then the records are pruned
  // (novationHousekeeping).
  // MIG-1 (release v16.1): while pilot writes are refused (writeRefusal) recovery sends nothing: it still reads, and decides
  // what the read-back decides (a note or a novation the tracker shows applied, or one that can no longer apply), but
  // what would need a submission stays as it is (issuing_note, applying) and is not reported until it changes.
  recover() {
    return this.serial(async () => {
      const out = [], refused = !!this.writeRefusal();
      for (const d of Object.values(this.s.deals)) if (d.status === 'issuing_note') { const st = (await this.submitNote(d, {recovering: true})).status; if (!refused || st !== 'issuing_note') out.push(st); }
      for (const t of Object.values(this.s.transfers || {})) {
        this.sweepTransfer(t);
        if (t.state === 'applying') { const st = (await this.recoverTransfer(t)).state; if (!refused || st !== 'applying') out.push(`${t.id}:${st}`); }
        else if (t.state === 'collecting' && this.circulating && !refused && this.transferComplete(t)) out.push(`${t.id}:${(await this.applyTransfer(t)).state}`);
      }
      for (const o of Object.values(this.s.setoffs || {})) {
        this.sweepSetoff(o);
        if (o.state === 'applying') { const st = (await this.recoverSetoff(o)).state; if (!refused || st !== 'applying') out.push(`${o.id}:${st}`); }
        else if (o.state === 'collecting' && this.circulating && !refused && this.setoffComplete(o)) {
          const st = (await this.applySetoff(o)).state;                 // one that must still wait stays collecting, unreported
          if (st !== 'collecting') out.push(`${o.id}:${st}`);
        }
      }
      this.novationHousekeeping();
      return out;
    });
  }
  // Records of payments by transfer, set-offs and refused attempts (design §11; with the lock held): a transfer or
  // set-off that ended without applying is dropped 7 days after it ended, and an applied one keeps its totals and drops
  // its signatures (their sha256 kept) 30 days after it applied. An attempt whose outcome is unknown is kept until its
  // owner resolves it. A transfer of a deal not yet paid is kept, without its signatures, for as long as the deal is
  // unpaid: decision D-1 still needs its timestamp and edges (paymentBlock, paymentAttemptHolds). Refused attempts of a
  // deal that has ended go 7 days after they were refused. Saves only when something changed.
  novationHousekeeping() {
    const now = this.now(), unpaid = d => !!d && !statusClass(d.status)?.terminal;
    let changed = false;
    for (const [id, t] of Object.entries(this.s.transfers || {})) {
      if (LIVE_TRANSFER.has(this.sweepTransfer(t).state) || UNRESOLVED_TRANSFER.has(t.state)) continue;
      const d = this.s.deals[t.deal_id];
      if (t.state === 'applied') {
        if (now - Date.parse(t.applied_at ?? t.updated_at) > NOVATION_SIGNATURES_KEEP_MS && this.hasSignatures(t)) { this.pruneSignatures(t); changed = true; }
      } else if (now - Date.parse(t.updated_at) > NOVATION_KEEP_MS) {
        if (!unpaid(d)) { delete this.s.transfers[id]; changed = true; }
        else if (this.hasSignatures(t)) { this.pruneSignatures(t); changed = true; }
      }
    }
    for (const [id, o] of Object.entries(this.s.setoffs || {})) {
      if (LIVE_SETOFF.has(this.sweepSetoff(o).state) || o.state === 'inconsistent') continue;
      if (o.state !== 'applied') { if (now - Date.parse(o.updated_at) > NOVATION_KEEP_MS) { delete this.s.setoffs[id]; changed = true; } }
      else if (now - Date.parse(o.applied_at ?? o.updated_at) > NOVATION_SIGNATURES_KEEP_MS && this.hasSignatures(o)) { this.pruneSignatures(o); changed = true; }
    }
    for (const d of Object.values(this.s.deals)) {
      if (!d.refused_attempts?.length || unpaid(d)) continue;
      const kept = d.refused_attempts.filter(a => !(now - Date.parse(a.at) > NOVATION_KEEP_MS));
      if (kept.length !== d.refused_attempts.length) { if (kept.length) d.refused_attempts = kept; else delete d.refused_attempts; changed = true; }
    }
    if (changed) this.save();
  }
  // ---------- the edge journal's compaction (release v16.1; readiness R-19, audit SV-ROB-1) ----------
  // The payment attempts that may still read old journal entries (decision D-2 e reads the first entry on an attempt's
  // edge after its timestamp): every attempt of a deal that is not paid and has not ended (its transfers that did not
  // apply, live ones included, on both edges; its own credit notes the tracker did not record; its refused attempts, on
  // every edge), and every transfer whose outcome only its owner can decide. Map edge -> the earliest such timestamp:
  // compactJournal keeps every entry on that edge after it (and everything after that entry).
  journalProtection() {
    const out = new Map(), add = (k, ts) => { if (typeof k === 'string' && Number.isSafeInteger(ts) && !(out.get(k) <= ts)) out.set(k, ts); };
    for (const d of Object.values(this.s.deals)) {
      if (statusClass(d.status)?.terminal || !d.agreement) continue;
      for (const t of this.transfersOf(d)) if (t.state !== 'applied') { add(t.from_edge?.edge, t.timestamp); add(t.to_edge?.edge, t.timestamp); }
      for (const n of this.ownNoteAttempts(d)) add(n.edge, n.timestamp);
      for (const a of d.refused_attempts || []) for (const e of a.edges || []) add(e?.edge, a.timestamp);
    }
    for (const t of Object.values(this.s.transfers || {})) if (UNRESOLVED_TRANSFER.has(t.state)) { add(t.from_edge?.edge, t.timestamp); add(t.to_edge?.edge, t.timestamp); }
    return out;
  }
  // Compacts pilot-edge-log.jsonl (journal.mjs compactJournal) at most once every JOURNAL_COMPACT_EVERY_MS (a day, also
  // across restarts: the checkpoint says when it was written), and only while the file is larger than
  // JOURNAL_COMPACT_MIN_BYTES (16 MiB); server.mjs calls it at startup and on its 60 s timer. The horizon,
  // JOURNAL_HORIZON_DAYS (31): an entry is dropped only once nothing reads it any more.
  //   - Decision D-2 e proves an attempt dead only while it could still apply: a transfer or a bound note until its
  //     timestamp + 1 hour (+ 60 s here, + 2 min in the clients), far inside 31 days. journalProtection keeps, whatever
  //     their age, the entries every attempt of an unpaid deal, or an unresolved one, could read (an ordinary note has
  //     no maximum age); and should an entry an attempt reads be gone anyway, the proof is partial (fail closed:
  //     firstEdgeEntryAfter).
  //   - Transfer and set-off records that did not apply are dropped 7 days after they ended, applied ones keep their
  //     signatures 30 days (readiness R-6); the 0.4.0 clients keep their records 7 days and confirmed signatures 30
  //     (design 11). 31 days is past all of them, with a day's margin.
  //   - credit_note.pair_changes_since keeps, per deal, the sum of what the dropped entries did on its pair (the
  //     checkpoint's cp_deal lines; pairChangesSince).
  //   - A client whose GET /edges `since` is before the checkpoint resynchronizes from the kept entries (each edge's
  //     state as of it) and its current rows (journalFor).
  // `force` (tests, an operator) skips the once-a-day and size conditions. Never throws: a failure is logged, and the old
  // journal stands.
  maybeCompactJournal({force = false, minBytes = JOURNAL_COMPACT_MIN_BYTES, horizonMs = JOURNAL_HORIZON_MS} = {}) {
    return this.serial(async () => {
      const dir = this.store?.dir;
      if (!dir) return {skipped: 'no_store'};
      const file = path.join(dir, EDGE_LOG_FILE), now = this.now();
      if (this.journalCompactedAt === undefined) {
        let at = NaN;
        try { at = Date.parse(readCheckpoint(file)?.at ?? ''); } catch { /* unreadable just now: no date */ }
        this.journalCompactedAt = Number.isFinite(at) ? at : null;
      }
      if (!force && this.journalCompactedAt !== null && now - this.journalCompactedAt < JOURNAL_COMPACT_EVERY_MS) return {skipped: 'too_soon'};
      let size;
      try { size = fs.statSync(file).size; } catch { return {skipped: 'no_journal'}; }
      if (!force && !(size > minBytes)) return {skipped: 'small', bytes: size};
      this.journalCompactedAt = now;
      let r;
      try { r = compactJournal(this, {now, horizonMs, protect: this.journalProtection()}); }
      catch (e) {
        this.log?.(`Pilot: the edge journal could not be compacted (the old journal stands): ${e.code || e.message}`);
        return {skipped: 'failed', error: e.code || e.message};
      }
      if (r.compacted) {
        this.log?.(`Pilot: the edge journal is compacted through seq ${r.through_seq} (entries older than ${Math.round(horizonMs / 864e5)} days; ${r.dropped} dropped, ${r.kept} kept as the edges' states): ${EDGE_LOG_FILE} ${r.bytes_before} -> ${r.bytes_after} bytes`);
        try { this.store.audit({type: 'journal.compacted', through_seq: r.through_seq, previous: r.previous, dropped: r.dropped, dropped_total: r.dropped_total, kept: r.kept, edges: r.edges, deals: r.deals, bytes_before: r.bytes_before, bytes_after: r.bytes_after}); } catch { /* the log line stands */ }
      }
      return r;
    });
  }
  // Whether a transfer or set-off record still holds a signature (its slots, or the edges as read back once applied).
  hasSignatures(x) {
    const after = Object.values(x.tracker_after ?? {}).some(s => typeof s?.signature === 'string');
    if (x.kind === 'setoff') return after || x.edges.some(e => SETOFF_SLOTS.some(r => typeof e.slots?.[r]?.signature === 'string'));
    return after || Object.values(x.slots ?? {}).some(s => typeof s?.signature === 'string');
  }
  // Drops every signature of a transfer or set-off record, keeping its totals and each signature's sha256: the slots
  // (purgeTransfer, purgeSetoff) and the edges' states as read back once it applied (tracker_after: total and timestamp,
  // and signature_sha256 in place of the signature).
  pruneSignatures(x) {
    if (x.kind === 'setoff') this.purgeSetoff(x); else this.purgeTransfer(x);
    for (const [k, s] of Object.entries(x.tracker_after ?? {})) if (typeof s?.signature === 'string') x.tracker_after[k] = {total: s.total, timestamp: s.timestamp, signature_sha256: sigSha256(s.signature)};
    x.signatures_pruned_at = iso(this.now());
  }

  dispute(p, id, {terms_hash, deliverable_sha256, signature, reason}) {
    return this.serial(async () => {
      const d = this.partyDeal(id, p);
      if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer disputes a delivery', 403);
      if (d.status !== 'delivered') throw new PilotError('wrong_state', `deal is ${d.status}; only a delivery can be disputed`, 409);
      if (terms_hash !== d.agreement.terms_hash || deliverable_sha256 !== d.delivery.sha256) throw new PilotError('stale_terms', 'hashes do not match the agreement and delivery', 409);
      if (reason != null && typeof reason !== 'string') throw new PilotError('invalid_field', 'reason must be text');
      const signed = reason ?? '';
      if (signed.length > 1100) throw new PilotError('invalid_field', 'reason is longer than 1100 characters, counting leading and trailing whitespace (at most 1000 without it)');   // OQ-32
      if (hasUnsafeText(signed)) throw new PilotError('invalid_field', 'reason contains control, bidi or invisible characters; remove them and sign again');
      reason = clean(signed, 1000, 'reason', {required: true});
      await this.verifySig(p, statements.dispute(terms_hash, deliverable_sha256, signed), signature, 'dispute',
        [statements.dispute(terms_hash, deliverable_sha256, reason)]);
      d.dispute = {by: p.id, reason, ...(signed !== reason ? {reason_as_signed: signed} : {}), signature, at: iso(this.now())}; d.status = 'disputed';
      this.event(d, p.id, 'disputed', {reason});
      this.save(); this.store.audit({type: 'deal.disputed', deal: d.id});
      return this.dealView(d, p);
    });
  }

  // =================================================================================================================
  // ---------- circulating credit: payment by debt transfer (design §4.5, §5.4, §5.5; spec 18.6, 18.8, 18.9; D-1) ----------
  // B (the deal's payer) pays C (its payee) with part of A's debt to B: A->B falls by the price a and A->C rises by it, in
  // one tracker write (POST /notes/transfer, seven signatures, timestamp T ending in 999 ms). Modes sandbox and on only
  // (in mode sandbox every party is a sandbox agent or sandbox_only). A transfer is s.transfers[vt_ + 16 hex]:
  //   {id, kind 'transfer', deal_id, state, attempt, regenerated_from, created_at, expires_at (+20 min), updated_at,
  //    network, tracker_nft_id, denomination, timestamp (T), amount (a), quote_digest, issuer/payer/payee {id, pubkey},
  //    from_edge {edge, before {total, timestamp, signature}, new_total, revision}, to_edge {edge, before | null,
  //    new_total, revision}, slots {name -> {signature, by, at}} (name: TRANSFER_SLOTS in novation.mjs; the issuer and the
  //    payer both sign '<A>><B>:new' and '<A>><C>:new', so slots are kept by tracker field), messages {slot key -> hex}
  //    (the four note messages, never shown in a consent), completion_signature, pay_signature, approval_id,
  //    result {code, at, ...}, fallback_after (ms), history, signature_sha256 {name -> sha256 of the signature's bytes}
  //    (once purged), tracker_after {from, to} (applied: both edges as read back)}.
  // Withholding (I-WITHHOLD): until the tracker records a transfer no response carries a signature collected from another
  // party; one that ends without applying has its slot signatures purged (their sha256 kept). Audit lines carry ids,
  // edge keys, totals and signature sha256 only, never a signature, and never the tracker's error text (only its status
  // and code).
  transfer(id) { return typeof id === 'string' && Object.hasOwn(this.s.transfers || {}, id) ? this.s.transfers[id] : null; }
  transfersOf(d) { return (d.transfer_ids || []).map(id => this.s.transfers?.[id]).filter(Boolean); }
  transferRoles(t, p) { return ['issuer', 'payer', 'payee'].filter(r => t[r].id === p.id); }
  slotsOf(t, role) { return transferSlots(t).filter(s => s.role === role); }
  transferComplete(t) { return TRANSFER_SLOTS.every(s => typeof t.slots[s.name]?.signature === 'string'); }
  transferKeysCurrent(t) {
    return [t.issuer, t.payer, t.payee].every(x => { const q = this.s.participants[x.id]; return q?.status === 'active' && q.pubkey === x.pubkey; });
  }
  transferEvent(t, event, detail = {}) { t.history.push({at: iso(this.now()), event, ...detail}); t.updated_at = iso(this.now()); }
  // What an audit line says about a transfer: ids, edge keys, totals and the sha256 of each signature, never a signature.
  transferAudit(t, type, extra = {}) {
    const sigs = Object.fromEntries(TRANSFER_SLOTS.map(s => [s.name, t.slots[s.name]?.signature ? sigSha256(t.slots[s.name].signature) : t.signature_sha256?.[s.name] ?? null]));
    this.store.audit({type, id: t.id, deal: t.deal_id, state: t.state, attempt: t.attempt, issuer: t.issuer.id, payer: t.payer.id, payee: t.payee.id, amount: t.amount, timestamp: t.timestamp,
      from: {edge: t.from_edge.edge, before: t.from_edge.before?.total ?? 0, after: t.from_edge.new_total}, to: {edge: t.to_edge.edge, before: t.to_edge.before?.total ?? 0, after: t.to_edge.new_total},
      signature_sha256: sigs, ...extra});
  }

  // ---------- edge reservations (design §5.4) ----------
  // The live transfers holding edge k (as their from- or to-edge), expired ones swept first.
  transfersOnEdge(k, exceptId = null) {
    return Object.values(this.s.transfers || {}).map(t => this.sweepTransfer(t))
      .filter(t => t.id !== exceptId && LIVE_TRANSFER.has(t.state) && (t.from_edge.edge === k || t.to_edge.edge === k));
  }
  // PC of an edge held by novations being collected or applied (GET /edges `reserved`): a transfer reserves its amount
  // on the edge it spends (its from-edge; both its edges are held exclusively, transfersOnEdge), a set-off its decrease
  // on each of its edges. A set-off never blocks a payment (a payment makes the set-off's edge stale instead), so what
  // a payer can spend, and what payment options show as reserved, counts the transfers only (transferReserved).
  transferReserved(k) { return this.transfersOnEdge(k).filter(t => t.from_edge.edge === k).reduce((a, t) => a + t.amount, 0); }
  edgeReserved(k) { return this.transferReserved(k) + this.setoffReserved(k); }
  retryAfter(t) { return t.state === 'applying' ? PAIR_BUSY_RETRY_MS : Math.max(1000, Date.parse(t.expires_at) - this.now()); }
  // 409 edge_busy while a set-off on edge k is being applied: its outcome is decided by reading its edges back, so
  // nothing else may change them meanwhile (a tracker failure leaves it applying until recovery, every 60 s, decides).
  // A set-off still collecting signatures never blocks anything.
  assertNoSetoffApplying(k) {
    if (this.setoffsOnEdge(k).some(o => o.state === 'applying'))
      throw new PilotError('edge_busy', 'a set-off on this edge is being applied and the tracker has not confirmed it yet; try again in 60 s', 409, {retry_after_ms: PAIR_BUSY_RETRY_MS});
  }
  // A new transfer on edge k: 409 edge_busy while another live transfer, a set-off being applied, or a credit note being
  // issued or held for an owner, is on it.
  assertTransferEdgeFree(k, {exceptTransfer = null} = {}) {
    this.assertNoSetoffApplying(k);
    const other = this.transfersOnEdge(k, exceptTransfer)[0];
    if (other) throw new PilotError('edge_busy', 'another payment by transfer holds this edge until it is applied or ends; try again later', 409, {retry_after_ms: this.retryAfter(other)});
    const [i, r] = k.split('>');
    for (const d of Object.values(this.s.deals)) {
      if ((d.status !== 'issuing_note' && d.status !== 'completion_awaiting_owner') || !d.credit_note) continue;
      const n = this.noteKeysOf(d);
      if (n.issuer === i && n.recipient === r)
        throw new PilotError('edge_busy', 'a credit note on this edge is being issued or waits for an owner; try again later', 409, {retry_after_ms: PAIR_BUSY_RETRY_MS});
    }
  }
  // A credit note on an edge a live transfer holds (noteTemplate, complete, the owner's release): 409 novation_pending
  // with the transfers whose issuer signatures (the note issuer's own) are still missing, so its client first signs or
  // refuses them (GET /consents); otherwise 409 edge_busy. Also 409 edge_busy while a set-off on the edge is being
  // applied (a collecting one never blocks a note: the note makes the set-off's edge stale).
  assertNoteEdgeFree(issuer, recipient) {
    this.assertNoSetoffApplying(edgeKey(issuer, recipient));
    if (!this.s.transfers || !Object.keys(this.s.transfers).length) return;
    const held = this.transfersOnEdge(edgeKey(issuer, recipient));
    if (!held.length) return;
    const pending = held.filter(t => t.state === 'collecting' && t.issuer.pubkey === issuer && this.slotsOf(t, 'issuer').some(s => !t.slots[s.name]?.signature));
    if (pending.length) throw new PilotError('novation_pending', 'a payment by transfer of your debt on this edge waits for your consent; sign or refuse it (GET /consents) before a new credit note here', 409, {consent_ids: pending.map(t => t.id)});
    throw new PilotError('edge_busy', 'a payment by transfer holds this edge until it is applied or ends; try again later', 409, {retry_after_ms: Math.max(...held.map(t => this.retryAfter(t)))});
  }

  // ---------- the checks (design §5.4, spec 18.13): at creation, at every consent and again right before apply ----------
  // A refusal records nothing. 403 payment_not_accepted names the rule and who it is for (payer, payee or issuer); the
  // other party's policy itself stays private.
  refusePayment(by, rule, message) { throw new PilotError('payment_not_accepted', message, 403, {rule, by}); }
  spendingPayerCheck(B, d, {exceptTransfer = null} = {}) {
    const m = this.effectiveLimits(B), no = (rule, why) => this.refusePayment('payer', rule, `this agent cannot pay by transfer now: ${why}`);
    if (!m.pay_with_held_notes || m.pay_with_held_notes === 'never') no('pay_with_held_notes', "its owner's mandate does not allow paying with notes it holds (pay_with_held_notes is never)");
    if (m.expires_at && Date.parse(m.expires_at) < this.now()) no('expires_at', `the mandate expired at ${m.expires_at}; the owner must renew it`);
    const mine = Object.values(this.s.transfers || {}).filter(t => t.id !== exceptTransfer && t.payer.id === B.id);
    if (mine.filter(t => LIVE_TRANSFER.has(this.sweepTransfer(t).state)).length >= MAX_COLLECTING_AS_PAYER)
      no('max_collecting_transfers', `at most ${MAX_COLLECTING_AS_PAYER} of its payments by transfer can be in progress at once`);
    const since = this.now() - 864e5;
    if (mine.filter(t => t.deal_id === d.id && Date.parse(t.created_at) > since).length >= MAX_ATTEMPTS_PER_DAY)
      no('max_attempts_per_deal', `at most ${MAX_ATTEMPTS_PER_DAY} attempts to pay one deal by transfer in 24 hours`);
  }
  // C being paid `a` PC of A's notes, for deal `dealId` (left out of C's committed deals: the transfer pays it). After
  // C's own switches, its counterparties and its mandate's expiry, the credit rules in their order (lib/pilot/policy.mjs
  // creditCheck): refuse_notes_from, accept_notes_from, accept_operator_issuers, max_accept_per_issuer (C's claim on A on
  // the tracker + committed deals with payer A + transfers from A still collecting + a), max_claims_total and
  // max_issuer_net_debt; then the coverage floor and C's creditor role.
  async receivingTransferCheck(C, A, a, {ledger = null, exceptTransfer = null, dealId = null} = {}) {
    const m = this.effectiveLimits(C), no = rule => this.refusePayment('payee', rule, `${C.handle} does not accept being paid with ${A.handle}'s note (its owner's policy: ${rule})`);
    if (!m.may_accept_credit) no('may_accept_credit');
    if (!m.accept_transfers) no('accept_transfers');
    if (m.counterparties !== 'any' && !(Array.isArray(m.counterparties) && m.counterparties.includes(A.id))) no('counterparties');
    if (this.boxedOut(C, A.id)) no('accept_notes_from');
    if (m.expires_at && Date.parse(m.expires_at) < this.now()) no('expires_at');
    ledger ??= await this.ledger();
    const r = await creditCheck(this, C, A, a, {via: 'transfer', ledger, excludeDealId: dealId, excludeTransferId: exceptTransfer});
    if (!r.ok) no(r.rule);
    // Coverage is judged on the issuer of the note received, without adding a (A's total does not change).
    if (m.min_payer_coverage_pct > 0) {
      const pe = this.exposure(A, ledger, {asRole: 'payer'}), owes = pe.tracker + pe.committed;
      const claims = ledger.filter(l => l.recipient === A.id).reduce((x, l) => x + l.outstanding, 0);
      if (owes > 0 && Math.floor(claims * 100 / owes) < m.min_payer_coverage_pct) no('min_payer_coverage_pct');
    }
    if (!this.consentCapable(C, 'creditor')) no('creditor_consent');
  }
  novatingIssuerCheck(A, C, {pubkey = null} = {}) {
    const no = rule => this.refusePayment('issuer', rule, `${A.handle} cannot move its debt to ${C.handle} now (${rule})`);
    if (A.status !== 'active' || !A.pubkey || (pubkey && A.pubkey !== pubkey)) no('issuer_key');
    const m = this.effectiveLimits(A);
    if (m.expires_at && Date.parse(m.expires_at) < this.now()) no('expires_at');
    if (!m.novate_own_debt) no('novate_own_debt');
    if (m.counterparties !== 'any' && !(Array.isArray(m.counterparties) && m.counterparties.includes(C.id))) no('counterparties');
    if (this.boxedOut(A, C.id)) no('counterparties');
    if (!this.consentCapable(A, 'issuer')) no('issuer_consent');
  }
  // In mode sandbox, every party of a transfer is a sandbox agent or a sandbox_only participant.
  sandboxScope(A, C) {
    if (this.mode !== 'sandbox') return;
    if (!this.inSandbox(A)) this.refusePayment('issuer', 'sandbox_only', 'in the sandbox only notes of sandbox participants move');
    if (!this.inSandbox(C)) this.refusePayment('payee', 'sandbox_only', 'in the sandbox only sandbox participants are paid by transfer');
  }
  // What B can spend of A's note (`note`: the tracker's note on A's current key -> B's current key): its outstanding
  // total less what live transfers reserve on it, and 0 unless that edge reconciles exactly (its tracker total is the
  // journal's expected total and its note the one Valun's last event left), both keys are current, A can sign as issuer,
  // and no live transfer holds the edge (`exceptTransfer`: other than that one, the transfer being decided).
  spendableNote(B, A, note, {exceptTransfer = null} = {}) {
    if (!note || !A?.pubkey || !B?.pubkey || A.status !== 'active' || B.status !== 'active' || note.issuer_pubkey !== A.pubkey || note.recipient_pubkey !== B.pubkey) return 0;
    const k = edgeKey(A.pubkey, B.pubkey), e = this.s.edges[k], total = Number(note.amount_collected);
    if (!e || e.expected_total !== total || !this.exactEdge(k, note) || !this.consentCapable(A, 'issuer')) return 0;
    if (this.transfersOnEdge(k, exceptTransfer).length) return 0;
    return Math.max(0, total - Number(note.amount_redeemed ?? 0));         // nothing else reserves it: no live transfer holds it
  }
  async roleCheck(t, role, {ledger = null} = {}) {
    const A = this.s.participants[t.issuer.id], B = this.s.participants[t.payer.id], C = this.s.participants[t.payee.id];
    if (role === 'issuer') return this.novatingIssuerCheck(A, C, {pubkey: t.issuer.pubkey});
    if (role === 'payee') return this.receivingTransferCheck(C, A, t.amount, {ledger, exceptTransfer: t.id, dealId: t.deal_id});
    return this.spendingPayerCheck(B, this.s.deals[t.deal_id], {exceptTransfer: t.id});
  }

  // ---------- D-1: one live payment attempt per deal ----------
  // May a payment of `route` start for deal d now? route 'note': the payer's own credit note; 'transfer': a held note,
  // whose edge `fromEdge` the payer acknowledges in the state (`fromPrior`, `fromPriorTimestamp`): its total and its
  // note's timestamp. An earlier transfer attempt that ended without applying (the server decided it by read-back) stays
  // usable at the tracker until its T + 1 h, so every other payment (an own note, another issuer, the same issuer on
  // another prior state) waits until fallback_after = T + 1 h + 60 s. Not held back (they exclude each other at the
  // tracker, so at most one of the two can apply): the identical operation posted again (`timestamp` the earlier
  // attempt's T, on the same held note with the same prior total: an edge's operations apply at strictly increasing
  // timestamps), and (the same-prior exemption, design v3.2 section 4, samePriorState) a transfer at any later T whose
  // from-edge is the earlier attempt's and acknowledges the same prior state, total AND timestamp, as that attempt did:
  // tracker v3.2's PA(A,B,X,p,T) binds (X, p), which the edge has at most once (audit VS-1 closed). An earlier attempt
  // that recorded no prior timestamp is never exempt. An
  // attempt whose outcome the read-back could not decide blocks every payment until the payer's owner resolves it. For a
  // transfer, the payer's own credit notes that the tracker did not record are earlier attempts too (ownNoteAttempts:
  // failed, stale, rejected by the owner, voided by a revocation, replaced, or refused when posted): a bound note stays
  // usable until its timestamp + 1 h, an ordinary one until its edge moves past it (it never expires: 409
  // pending_unbound_note). Attempts refused when posted (decision D-2 b) count like the others. An attempt that Valun's
  // own edge journal proves dead (attemptDeadByJournal, decision D-2 e) never blocks.
  // Returns null, or {code: transfer_window_open (retry_after_ms) | attempt_outcome_unknown | already_paid | edge_busy
  // | pending_unbound_note}. `exceptTransfer`: leave out that attempt (the one being decided, held for the payer's owner).
  // `timestamp`: the T of the transfer being posted (null for a template: always a new attempt). Own credit notes are
  // another kind: a transfer always waits for them as before.
  async paymentBlock(d, opts) {
    const attempts = this.transferAttemptsBlock(d, opts);
    if (attempts.code) return attempts;
    return this.paymentBlockAt(d, opts, opts.route === 'transfer' ? await this.ownNoteNotes(d) : new Map());
  }
  // paymentBlock with the tracker's notes on the own-note attempts' edges given (`notes`: Map edge -> the tracker's note
  // or null, as ownNoteNotes reads them): synchronous, so that the routes (paymentBlock), the deal views' next_actions
  // (paymentGate: the same notes read from the tracker) and Valun's own estimate of them (paymentGateEstimate: the
  // journal's last state of each edge) all apply this one rule.
  paymentBlockAt(d, {route, fromEdge = null, fromPrior = null, fromPriorTimestamp = null, timestamp = null, exceptTransfer = null}, notes) {
    const now = this.now(), attempts = this.transferAttemptsBlock(d, {route, fromEdge, fromPrior, fromPriorTimestamp, timestamp, exceptTransfer});
    if (attempts.code) return attempts;
    let wait = attempts.wait;
    if (route === 'transfer') {
      for (const n of this.ownNoteAttempts(d)) {
        if (this.attemptDeadByJournal(n.edge, n.prior_total, n.timestamp)) continue;
        const cur = notes.get(n.edge) ?? null;
        if (cur && Number(cur.amount_collected) === n.total && cur.timestamp === n.timestamp && (cur.signature === n.signature || sigSha256(cur.signature) === n.signature_sha256)) return {code: 'already_paid'};
        if (n.bound) { const until = fallbackAfter(n.timestamp); if (now <= until) wait = Math.max(wait, until - now + 1); }
        else if (!(cur && cur.timestamp >= n.timestamp) && !this.s.edges[n.edge]?.novated) return {code: 'pending_unbound_note'};
      }
    }
    return wait > 0 ? {code: 'transfer_window_open', retry_after_ms: wait} : null;
  }
  // The tracker's notes now on the edges of deal d's own-note attempts that the journal does not prove dead (what
  // paymentBlockAt reads for a transfer): Map edge -> note or null.
  async ownNoteNotes(d) {
    const read = new Map();
    for (const n of this.ownNoteAttempts(d)) {
      if (read.has(n.edge) || this.attemptDeadByJournal(n.edge, n.prior_total, n.timestamp)) continue;
      const [i, r] = n.edge.split('>');
      read.set(n.edge, await this.basis.note(i, r));
    }
    return read;
  }
  // What the payment routes answer about decision D-1 for deal d right now, for the deal view's next_actions (release
  // v16.1): {note: paymentBlock for the payer's own credit note (complete), transfer: paymentBlock for a payment by
  // transfer through the held note that fares best}, each null (allowed) or the block. A transfer through a note no
  // earlier attempt names is blocked by every attempt whose window is open, so only a note an open attempt names can be
  // exempt (the same-prior exemption): each such note is judged in the state the tracker holds it in now, as
  // transferTemplate and pay-by-transfer judge it. The tracker is read only for what the rule needs: the own-note
  // attempts' edges and, while a window is open, the notes the open attempts name.
  async paymentGate(d) {
    const notes = await this.ownNoteNotes(d), from = new Map();
    for (const k of this.paymentGateCandidates(d)) { if (!from.has(k)) { const [i, r] = k.split('>'); from.set(k, await this.basis.note(i, r)); } }
    return this.paymentGateAt(d, notes, k => from.get(k) ?? null);
  }
  // The same judgment without a tracker read: every edge taken in the state Valun's journal last recorded for it. Only
  // where no answer is served (a deal view made synchronously, as tests do; dealView always reads the tracker).
  paymentGateEstimate(d) {
    const asNote = k => { const l = this.s.edges[k]?.last; return l ? {amount_collected: l.total, timestamp: l.timestamp, signature: l.signature} : null; };
    const notes = new Map(this.ownNoteAttempts(d).map(n => [n.edge, asNote(n.edge)]));
    return this.paymentGateAt(d, notes, asNote);
  }
  // The from-edges of deal d's attempts whose window is open (transferAttemptsBlock): the only notes a transfer could be
  // exempt through.
  paymentGateCandidates(d) {
    const b = this.transferAttemptsBlock(d, {route: 'note'});
    return b.code || !(b.wait > 0) ? [] : [...new Set(b.open.map(o => o.edge))];
  }
  paymentGateAt(d, notes, noteOf) {
    const note = this.paymentBlockAt(d, {route: 'note'}, notes);
    let transfer = this.paymentBlockAt(d, {route: 'transfer'}, notes);
    if (transfer?.code === 'transfer_window_open') {
      for (const k of this.paymentGateCandidates(d)) {
        const n = noteOf(k);
        if (!n) continue;
        const b = this.paymentBlockAt(d, {route: 'transfer', fromEdge: k, fromPrior: Number(n.amount_collected), fromPriorTimestamp: n.timestamp}, notes);
        if (!b) { transfer = null; break; }
      }
    }
    return {note, transfer};
  }
  // Whether deal d has any payment attempt by transfer (recorded, or refused when posted): only then can an own credit
  // note have to wait for one (D-1). Never with circulation off, so mode off reads nothing more.
  hasTransferAttempts(d) { return !!d.transfer_ids?.length || !!d.refused_attempts?.some(a => a.kind === 'transfer'); }
  // The part of paymentBlock that needs no tracker read: the deal's earlier transfer attempts (its transfers, and those
  // refused when posted). {code, retry_after_ms?} for an attempt that applied, is unresolved or is live; otherwise
  // {wait, open}: the ms until every attempt that ended without applying, and does not exclude this one at the tracker,
  // is dead (0: none), and those attempts' from-edge prior states ({edge, prior, prior_timestamp}, the latest first). An
  // attempt is dead once T + 1 h + 60 s has passed, or when the journal proves it (D-2 e). An earlier attempt excluded
  // by this one at the tracker does not count: the identical operation (a transfer at the same T on the same held note
  // and prior total), and a transfer on the same prior state of the same from-edge (samePriorState: total and
  // timestamp; design v3.2 section 4). Route 'note' (an own credit note: another kind) is never exempt.
  transferAttemptsBlock(d, {route, fromEdge = null, fromPrior = null, fromPriorTimestamp = null, timestamp = null, exceptTransfer = null}) {
    const now = this.now(), open = [];
    const next = route === 'transfer' ? {kind: 'transfer', edge: fromEdge, prior: fromPrior, prior_timestamp: fromPriorTimestamp} : null;
    let wait = 0;
    const consider = (T, from, to, fallback) => {
      if (!(now <= fallback)) return;                                                 // dead: it can no longer apply
      if (route === 'transfer' && Number.isSafeInteger(timestamp) && T === timestamp && from.edge === fromEdge && from.prior === fromPrior) return;   // the identical operation
      if (samePriorState({kind: 'transfer', ...from}, next)) return;                    // the same prior state of the same from-edge
      if (this.attemptDeadByJournal(from.edge, from.prior, T) || this.attemptDeadByJournal(to.edge, to.prior, T)) return;
      wait = Math.max(wait, fallback - now + 1);
      open.push({T, edge: from.edge, prior: from.prior, prior_timestamp: from.prior_timestamp});
    };
    for (const t of this.transfersOf(d)) {
      if (t.id === exceptTransfer) continue;
      this.sweepTransfer(t);
      if (t.state === 'applied') return {code: 'already_paid'};
      if (UNRESOLVED_TRANSFER.has(t.state)) return {code: 'attempt_outcome_unknown'};
      if (LIVE_TRANSFER.has(t.state)) return {code: 'edge_busy', retry_after_ms: this.retryAfter(t)};
      consider(t.timestamp, {edge: t.from_edge.edge, prior: t.from_edge.before.total, prior_timestamp: t.from_edge.before.timestamp ?? null},
        {edge: t.to_edge.edge, prior: t.to_edge.before?.total ?? 0}, t.fallback_after ?? fallbackAfter(t.timestamp));
    }
    for (const a of d.refused_attempts || []) {
      if (a.kind !== 'transfer') continue;
      const f = a.edges.find(e => e.which === 'from'), c = a.edges.find(e => e.which === 'to');
      // One recorded unverified (the signature checker was unavailable) is never exempt: its prior state is only what
      // the post claimed.
      consider(a.timestamp, {edge: f.edge, prior: f.prior_total, prior_timestamp: a.unverified ? null : f.prior_timestamp ?? null}, {edge: c.edge, prior: c.prior_total}, fallbackAfter(a.timestamp));
    }
    open.sort((x, y) => y.T - x.T);
    return {wait, open: open.map(({T, ...o}) => o)};
  }
  // The payer's own credit notes for deal d that the tracker has not recorded (payment attempts, decision D-1): the
  // deal's note while it is held, being issued, failed or stale; notes its owner rejected or a revocation voided;
  // earlier ones a newer note replaced; and notes refused when posted (decision D-2 b). Each as {edge, timestamp, total,
  // prior_total, bound, signature, signature_sha256}, with null for what the record does not keep.
  ownNoteAttempts(d) {
    const terms = d.agreement?.terms, out = [];
    for (const n of [d.credit_note, ...(d.rejected_notes || []), ...(d.void_notes || []), ...(d.replaced_notes || [])]) {
      if (!n?.note || n.state === 'recorded' || !Number.isSafeInteger(n.note.timestamp)) continue;
      const i = n.issuer_pubkey ?? terms?.payer?.pubkey, r = n.recipient_pubkey ?? terms?.payee?.pubkey;
      if (!i || !r) continue;
      out.push({edge: edgeKey(i, r), timestamp: n.note.timestamp, total: n.note.total ?? null, prior_total: n.prior_total ?? null,
        bound: !!n.note.prior_signature || n.note.bound === true || n.note.timestamp % 1000 === BOUND_NOTE_MS, signature: n.note.signature ?? null,
        signature_sha256: n.note.signature_sha256 ?? (n.note.signature ? sigSha256(n.note.signature) : null)});
    }
    for (const a of d.refused_attempts || []) {
      if (a.kind !== 'note' || !a.edges?.[0]) continue;
      out.push({edge: a.edges[0].edge, timestamp: a.timestamp, total: a.edges[0].new_total, prior_total: a.edges[0].prior_total, bound: !!a.bound, signature: null,
        signature_sha256: a.signature_sha256?.note ?? null});
    }
    return out;
  }
  // Decision D-2 e: whether Valun's own edge journal proves that a payment attempt which would have changed `edge` from
  // priorTotal, at timestamp ts, never applied and never can: the first journal entry on the edge after ts (tracker
  // timestamps on an edge only grow) changed the edge from exactly priorTotal. Had the attempt applied, the edge would
  // have left priorTotal at ts; and once the edge is past ts the tracker refuses the attempt.
  // A journal that could not be read in full just now (pilot-edge-log.jsonl unreadable: journal.mjs edgeEntries partial),
  // or whose entries do not cover every seq from 1 to counters.edge_seq (the file lost or cut after the tail rolled over,
  // decision D-3 d), proves nothing: a missing entry may be the first one after ts (fail closed).
  attemptDeadByJournal(edge, priorTotal, ts) {
    if (typeof edge !== 'string' || !Number.isSafeInteger(priorTotal) || !Number.isSafeInteger(ts)) return false;
    const {entry: first, partial} = firstEdgeEntryAfter(this, edge, ts);
    if (partial) return false;
    return !!first && Number.isSafeInteger(first.total_after) && first.total_after - first.delta === priorTotal;
  }
  paymentBlockError(b) {
    if (b.code === 'transfer_window_open') return new PilotError('transfer_window_open', `an earlier attempt to pay this deal can still apply at the tracker (until its timestamp + 1 hour); another payment (with any note, the same issuer's included, unless it is a transfer through the same note acknowledging the same prior state, total and timestamp, as that attempt did) can start in ${Math.ceil(b.retry_after_ms / 1000)} s`, 409, {retry_after_ms: b.retry_after_ms});
    if (b.code === 'attempt_outcome_unknown') return new PilotError('attempt_outcome_unknown', "an earlier attempt to pay this deal may have applied (the tracker's state cannot tell); no other payment starts until the payer's owner resolves it, after confirming with the payee", 409);
    if (b.code === 'already_paid') return new PilotError('already_paid', 'an earlier payment of this deal applied; it is not paid again', 409);
    if (b.code === 'pending_unbound_note') return new PilotError('pending_unbound_note', 'an earlier credit note of yours for this deal (an ordinary note: it has no maximum age) was not recorded but could still be, so a payment by transfer could pay the deal twice; pay it with a new credit note (complete) instead', 409);
    return new PilotError('edge_busy', 'a payment of this deal is in progress', 409, {retry_after_ms: b.retry_after_ms ?? PAIR_BUSY_RETRY_MS});
  }

  // ---------- building a transfer ----------
  // The parties of a payment of deal d by A's note (issuerId), and the checks that need no tracker read.
  transferParties(p, d, issuerId) {
    if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer pays', 403);
    if (!PAYABLE.includes(d.status)) throw new PilotError('wrong_state', `deal is ${d.status}; a payment follows a delivery`, 409);
    if (typeof issuerId !== 'string' || !PID_RE.test(issuerId)) throw new PilotError('invalid_field', 'issuer must be the id (vp_ + 12 hex) of the participant whose note you hold');
    const A = Object.hasOwn(this.s.participants, issuerId) ? this.s.participants[issuerId] : null;
    if (!A) throw new PilotError('not_found', `unknown participant ${issuerId}`, 404);
    const B = p, C = this.s.participants[d.payee], a = d.agreement.terms.price.amount;
    if (A.id === B.id) throw new PilotError('self_edge', 'you cannot pay with a note you issued yourself', 400);
    if (A.id === C.id) throw new PilotError('pay_with_is_payee', `${C.handle} issued this note itself: paying it with its own note would be a set-off, not a transfer`, 400);
    if (B.status !== 'active' || !B.pubkey) throw new PilotError('no_key', 'the payer has no registered agent key', 409);
    if (C.status !== 'active' || !C.pubkey) throw new PilotError('payee_no_key', `${C.handle} has no registered agent key right now (its owner revoked it); it cannot be paid by transfer`, 409);
    this.sandboxScope(A, C);
    this.novatingIssuerCheck(A, C);
    return {A, B, C, a, fromEdge: edgeKey(A.pubkey, B.pubkey), toEdge: edgeKey(A.pubkey, C.pubkey)};
  }
  quoteFor(d, A, B, C, a) {
    const t = d.agreement.terms;
    return quoteDigest({network: t.network, tracker_nft_id: t.tracker_nft_id, denomination: t.denomination, deal_id: d.id, terms_hash: d.agreement.terms_hash,
      deliverable_sha256: d.delivery.sha256, issuer_pubkey: A.pubkey, payer_pubkey: B.pubkey, payee_pubkey: C.pubkey, amount: a});
  }
  // What a transfer's timestamp must follow: both edges' last notes, every live set-off's timestamp on either edge, and
  // (R-1) the T of every transfer recorded for deal d, so a retry never gets the (edge, T) of an earlier transfer with
  // its own id (a client keeps one record per (edge, T), with the first id: one that its owner rejected, say). Posts
  // refused before a transfer was recorded (D-2 b) have no id and are left out: their T may be any the client signed,
  // ahead of the clock included, and a later template must not wait for it.
  transferAfter(fromEdge, toEdge, from, to, d = null) {
    return Math.max(from?.timestamp ?? 0, to?.timestamp ?? 0, this.liveSetoffTimestamp(fromEdge), this.liveSetoffTimestamp(toEdge), d ? this.lastTransferAttemptT(d) : 0);
  }
  // The latest T of the transfers recorded for deal d (0: none).
  lastTransferAttemptT(d) {
    let t = 0;
    for (const x of this.transfersOf(d)) if (Number.isSafeInteger(x.timestamp) && x.timestamp > t) t = x.timestamp;
    return t;
  }
  // The latest timestamp a live set-off (collecting or applying) has on edge k (0: none).
  liveSetoffTimestamp(k) {
    let t = 0;
    for (const o of this.setoffsOnEdge(k)) for (const e of o.edges) if (e.edge === k && Number.isSafeInteger(e.timestamp) && e.timestamp > t) t = e.timestamp;
    return t;
  }
  // regenerated_from (and regenerated_as) stay in the record and its views for their shape, always null: the server no
  // longer makes a transfer again by itself (an automatic same-issuer retry, audit VS-1).
  newTransfer(d, {A, B, C, a, T, from, to, quote}) {
    const now = this.now();
    return {id: rid('vt_', 8), kind: 'transfer', deal_id: d.id, state: 'collecting', attempt: this.transfersOf(d).length + 1, regenerated_from: null,
      created_at: iso(now), expires_at: iso(now + TRANSFER_TTL_MS), updated_at: iso(now),
      network: d.agreement.terms.network, tracker_nft_id: this.basis.nft, denomination: this.basis.denomination,
      timestamp: T, amount: a, quote_digest: quote,
      issuer: {id: A.id, pubkey: A.pubkey}, payer: {id: B.id, pubkey: B.pubkey}, payee: {id: C.id, pubkey: C.pubkey},
      from_edge: {edge: edgeKey(A.pubkey, B.pubkey), before: from, new_total: from.total - a, revision: 1},
      to_edge: {edge: edgeKey(A.pubkey, C.pubkey), before: to, new_total: (to?.total ?? 0) + a, revision: 1},
      slots: {}, messages: {}, completion_signature: null, pay_signature: null, approval_id: null, result: null, fallback_after: null, history: []};
  }
  // The four messages of a transfer, by slot key (built by the Basis helper; 503 during a signer outage): the two prior
  // slots' prior acknowledgments PA(A,B,X,p_AB,T) and PA(A,C,Y,p_AC,T) (tracker v3.2) and the two new slots' note
  // messages M(A,B,X-a,T) and M(A,C,Y+a,T).
  async messagesFor(t) {
    const out = {};
    for (const [k, m] of Object.entries(transferMessages(t))) out[k] = await this.messageHex(m);
    return out;
  }
  // The slots of the server-run parties among `roles` (pilot.serverSigner), signed now and checked; 503
  // signer_unavailable (nothing recorded) when the signer fails. Rule R1 for the server signer: each message is rebuilt
  // here (messageHex: PA for a prior slot, M for a new one) from the transfer's own parties, totals, prior timestamps and
  // T (transferSlots), never taken from stored or supplied hex.
  async serverSignatures(t, roles) {
    const out = {}, at = iso(this.now()), built = new Map();
    const message = async s => {
      if (!built.has(s.key)) built.set(s.key, await this.messageHex(slotMessage(s)));
      return built.get(s.key);
    };
    for (const role of roles) {
      const q = this.s.participants[t[role].id];
      if (!this.serverRun(q)) continue;
      for (const s of this.slotsOf(t, role)) {
        if (t.slots[s.name]?.signature) continue;
        const msg = await message(s);
        let sig = null;
        try { sig = await this.serverSigner.signFor(q.id, msg, {op: t.id}); } catch { sig = null; }
        if (!(await this.safeVerify(t[role].pubkey, msg, sig)))
          throw new PilotError('signer_unavailable', `the server could not sign for ${q.handle} just now; nothing was recorded; try again`, 503);
        out[s.name] = {signature: sig, by: q.id, at, server_signed: true};
      }
    }
    return out;
  }

  // GET /deals/:id/payment-options (the payer's agent; deal delivered, note_failed or payment_due; design §4.5 step 1).
  async paymentOptions(p, id) {
    const d = this.sweep(this.partyDeal(id, p));
    if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer pays', 403);
    if (!PAYABLE.includes(d.status)) throw new PilotError('wrong_state', `deal is ${d.status}; payment options follow a delivery`, 409);
    const B = p, C = this.s.participants[d.payee], price = d.agreement.terms.price.amount, ledger = await this.ledger();
    const code = e => { if (e instanceof PilotError) return e.extra?.rule ? `${e.code}:${e.extra.rule}` : e.code; throw e; };
    let payerWhy = null;
    try { this.spendingPayerCheck(B, d); } catch (e) { payerWhy = code(e); }
    const ownBlock = await this.paymentBlock(d, {route: 'note'});
    let own = {available: !ownBlock, why_not: ownBlock?.code ?? null};
    if (own.available) {
      try { const {issuer, recipient} = this.noteParties(d); this.assertPairFree(d, issuer, recipient); this.assertNoteEdgeFree(issuer, recipient); }
      catch (e) { own = {available: false, why_not: code(e)}; }
    }
    const held = [];
    for (const l of ledger) {
      if (!B.pubkey || l.recipient_pubkey !== B.pubkey || l.outstanding <= 0) continue;
      const A = this.byPubkey(l.issuer_pubkey);
      if (!A || A.id === B.id) continue;
      const note = TRACKER_NOTE.get(l), k = edgeKey(l.issuer_pubkey, l.recipient_pubkey);
      const spendable = this.spendableNote(B, A, note);
      let payeeAccepts = false;
      if (A.id !== C.id && C.pubkey) { try { await this.receivingTransferCheck(C, A, price, {ledger, dealId: d.id}); payeeAccepts = true; } catch (e) { code(e); } }
      let why = null;
      if (A.id === C.id) why = 'pay_with_is_payee';
      else if (A.pubkey !== l.issuer_pubkey || A.status !== 'active') why = 'frozen_key';
      else if (!C.pubkey || C.status !== 'active') why = 'payee_no_key';
      else if (this.mode === 'sandbox' && !(this.inSandbox(A) && this.inSandbox(C))) why = 'sandbox_only';
      else if (payerWhy) why = payerWhy;
      if (!why) { const b = await this.paymentBlock(d, {route: 'transfer', fromEdge: k, fromPrior: Number(note.amount_collected), fromPriorTimestamp: note.timestamp}); if (b) why = b.code; }
      if (!why) { try { this.novatingIssuerCheck(A, C); } catch (e) { why = code(e); } }
      if (!why && !payeeAccepts) why = 'payment_not_accepted:payee';
      // edge_busy: whatever the route refuses with it (assertTransferEdgeFree, release v16.1: also a credit note being
      // issued or held for an owner on either edge, which this used to miss): a live transfer, a set-off being applied.
      const busy = x => { try { this.assertTransferEdgeFree(x); return false; } catch (e) { if (e instanceof PilotError && e.code === 'edge_busy') return true; throw e; } };
      if (!why && (busy(k) || busy(edgeKey(A.pubkey, C.pubkey)))) why = 'edge_busy';
      if (!why && spendable < price) why = spendable === 0 && l.outstanding > 0 && !this.transfersOnEdge(k).length ? 'not_reconciled' : 'insufficient_claim';
      held.push({issuer: {id: A.id, handle: A.handle, pubkey: l.issuer_pubkey, operator_run: this.serverRun(A)}, held: l.outstanding, reserved: this.transferReserved(k),
        spendable, enough: spendable >= price, payee_accepts: payeeAccepts, issuer_consents: this.consentSpeed(A, 'issuer'), payee_consents: this.consentSpeed(C, 'creditor'), why_not: why});
    }
    const open = this.transfersOf(d).filter(t => !LIVE_TRANSFER.has(t.state) && t.state !== 'applied' && this.now() <= t.fallback_after).at(-1) ?? null;
    return {deal_id: d.id, price, payee: {id: C.id, handle: C.handle, pubkey: C.pubkey}, own_note: own, held_notes: held,
      pending_transfer: open && {id: open.id, state: open.state, issuer: {id: open.issuer.id, handle: this.s.participants[open.issuer.id]?.handle ?? null}, timestamp: open.timestamp, fallback_after: iso(open.fallback_after)},
      fallback_after: ownBlock?.retry_after_ms ? iso(this.now() + ownBlock.retry_after_ms) : null};
  }

  // GET /deals/:id/transfer-template?issuer=vp_... (the payer's agent; design §4.5 step 2). Every check runs first (a
  // template is given only for a payment that can be made); T is the largest timestamp ending in 999 ms, at least 1.5 s
  // behind this server's clock and later than both edges' timestamps (waiting up to NOTE_CLOCK_WAIT_MS, else 409
  // note_timestamp_ahead with retry_after_ms). `messages` (the four messages: PA for the two prior slots, M for the two
  // new ones) are for information only: the payer builds and signs them itself. from_edge and to_edge also name
  // prior_timestamp, the timestamp of the state each slot acknowledges (their before's; 0 for a new to-edge).
  async transferTemplate(p, id, issuerId, {wait = true} = {}) {
    const d = this.sweep(this.partyDeal(id, p));
    const {A, B, C, a, fromEdge, toEdge} = this.transferParties(p, d, issuerId);
    this.spendingPayerCheck(B, d);
    const [fromNote, toNote] = await Promise.all([this.basis.note(A.pubkey, B.pubkey), this.basis.note(A.pubkey, C.pubkey)]);
    const from = edgeState(fromNote), to = edgeState(toNote);
    if (!from || from.total - Number(fromNote.amount_redeemed ?? 0) < a) throw new PilotError('insufficient_claim', `you hold less than ${a} PC of ${A.handle}'s notes`, 409);
    const block = await this.paymentBlock(d, {route: 'transfer', fromEdge, fromPrior: from.total, fromPriorTimestamp: from.timestamp});
    if (block) throw this.paymentBlockError(block);
    const ledger = await this.ledger();
    await this.receivingTransferCheck(C, A, a, {ledger, dealId: d.id});
    this.assertTransferEdgeFree(fromEdge); this.assertTransferEdgeFree(toEdge);
    if (this.spendableNote(B, A, fromNote) < a) throw new PilotError('insufficient_claim', `${a} PC of ${A.handle}'s note to you cannot be spent now (held ${from.total}; it must reconcile exactly with Valun's journal)`, 409);
    // T is later than both edges' notes and (decision D-2 b) than every live set-off's timestamp on them, so that a
    // set-off applied between this template and the post leaves both edges at timestamps before T.
    const r = novationTimestamp({now: this.now(), residue: TRANSFER_MS, after: this.transferAfter(fromEdge, toEdge, from, to, d)});
    if (r.timestamp === undefined) {
      if (!wait || r.ahead_ms > NOTE_CLOCK_WAIT_MS) throw new PilotError('note_timestamp_ahead', `a transfer needs a timestamp ending in ${TRANSFER_MS} ms, later than both edges' last notes (and the set-offs being collected on them, and this deal's earlier transfers) and at least 1.5 s before this server's clock; there is one in ${r.ahead_ms} ms. Fetch the template again in ${Math.ceil(r.ahead_ms / 1000)} s.`, 409, {retry_after_ms: r.ahead_ms});
      await new Promise(res => setTimeout(res, r.ahead_ms + 5));
      return this.transferTemplate(p, id, issuerId, {wait: false});           // read the tracker again
    }
    const T = r.timestamp, draft = this.newTransfer(d, {A, B, C, a, T, from, to, quote: null});
    const who = q => ({id: q.id, handle: q.handle, pubkey: q.pubkey});
    return {deal_id: d.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, issuer: who(A), payer: who(B), payee: who(C), amount: a, timestamp: T,
      from_edge: {edge: fromEdge, before: from, prior_timestamp: from.timestamp, new_total: from.total - a},
      to_edge: {edge: toEdge, before: to, prior_timestamp: to ? to.timestamp : 0, new_total: (to?.total ?? 0) + a},
      tracker_nft_id: this.basis.nft, denomination: this.basis.denomination, quote_digest: this.quoteFor(d, A, B, C, a),
      collect_until: iso(this.now() + TRANSFER_TTL_MS), messages: await this.messagesFor(draft)};
  }

  // POST /deals/:id/pay-by-transfer (the payer's agent; design §4.5 steps 3-4). The edges' totals must still be the
  // posted priors, and (tracker v3.2) their notes' timestamps the posted from_prior_timestamp and to_prior_timestamp (0
  // for a new to-edge; optional: one not posted is not asserted) (else 409 transfer_stale with a fresh template); B's
  // five signatures (the completion, the pay statement and its three slots: its prior slot over PA of A->B's state as it
  // is now) verify against its current key; every check passes; both edges are reserved for this transfer.
  // The completion is recorded (an unconditional acceptance: no dispute afterwards), and the deal is paying_by_transfer,
  // or completion_awaiting_owner with a pay_by_transfer approval when the payer's owner reviews deliveries. Server-run
  // issuers and payees sign at once; when every slot is signed the transfer is applied in this request. A tracker refusal
  // is 409 transfer_failed (with the tracker's code) or 409 transfer_stale, never 502; the state is saved either way.
  // A payment the payer posted and that is refused before the transfer is recorded stays a payment attempt its client
  // keeps until it is dead (decision D-2 b): it is recorded (recordRefusedTransfer) before the refusal is answered.
  payByTransfer(p, id, body) {
    const b = body && typeof body === 'object' ? body : {};
    return this.serial(async () => {
      this.assertTrackerWritable();                 // MIG-1
      try { return await this.payByTransferLocked(p, id, b); }
      catch (e) { await this.recordRefusedTransfer(p, id, b, e); throw e; }
    }).catch(async e => {
      // A stale payment: a fresh template, made now that the lock is released (it may wait for a 999 ms timestamp).
      if (e instanceof PilotError && e.freshTransferTemplate) e.extra.template = await this.transferTemplate(p, id, e.freshTransferTemplate).catch(() => null);
      throw e;
    });
  }
  // payByTransfer() with the lock held.
  async payByTransferLocked(p, id, b) {
    {
      const d = this.sweep(this.partyDeal(id, p));
      const {A, B, C, a, fromEdge, toEdge} = this.transferParties(p, d, b.issuer_id);
      if (b.terms_hash !== d.agreement.terms_hash || b.deliverable_sha256 !== d.delivery.sha256) throw new PilotError('stale_terms', 'hashes do not match the agreement and delivery', 409);
      this.spendingPayerCheck(B, d);
      const [fromNote, toNote] = await Promise.all([this.basis.note(A.pubkey, B.pubkey), this.basis.note(A.pubkey, C.pubkey)]);
      const from = edgeState(fromNote), to = edgeState(toNote);
      if (!from || from.total - Number(fromNote.amount_redeemed ?? 0) < a) throw new PilotError('insufficient_claim', `you hold less than ${a} PC of ${A.handle}'s notes`, 409);
      const block = await this.paymentBlock(d, {route: 'transfer', fromEdge, fromPrior: from.total, fromPriorTimestamp: from.timestamp, timestamp: b.timestamp});
      if (block) throw this.paymentBlockError(block);
      const stale = why => Object.assign(new PilotError('transfer_stale', `${why}; fetch a new transfer template`, 409, {template: null}), {freshTransferTemplate: A.id});
      if (b.from_prior_total !== from.total || b.to_prior_total !== (to?.total ?? 0)) throw stale(`the edges' totals are ${from.total} (${A.handle} to you) and ${to?.total ?? 0} (${A.handle} to ${C.handle}) now`);
      const toTs = to ? to.timestamp : 0;
      if ((b.from_prior_timestamp != null && b.from_prior_timestamp !== from.timestamp) || (b.to_prior_timestamp != null && b.to_prior_timestamp !== toTs))
        throw stale(`the edges' notes are timestamped ${from.timestamp} (${A.handle} to you) and ${toTs} (${A.handle} to ${C.handle}; 0: no note) now`);
      const T = b.timestamp, now = this.now();
      if (!Number.isSafeInteger(T) || T % 1000 !== TRANSFER_MS || T <= from.timestamp || (to && T <= to.timestamp) || T > now || T < now - INITIATE_WINDOW_MS)
        throw stale(`the timestamp must end in ${TRANSFER_MS} ms, be later than both edges' last notes, not in the future and at most 10 minutes old`);
      if (T <= this.lastTransferAttemptT(d)) throw stale('the timestamp must be later than every earlier transfer of this deal');
      const q = this.quoteFor(d, A, B, C, a);
      if (b.quote_digest !== q) throw stale('the quote digest is not the one this payment has now (a key may have changed)');
      await this.verifySig(B, statements.complete(b.terms_hash, b.deliverable_sha256), b.completion_signature, 'completion');
      await this.verifySig(B, circulationStatements.pay(d.id, q), b.pay_signature, 'pay statement');
      const t = this.newTransfer(d, {A, B, C, a, T, from, to, quote: q});
      t.messages = await this.messagesFor(t);
      const mine = this.slotsOf(t, 'payer'), sigs = b.signatures;
      if (!sigs || typeof sigs !== 'object' || Array.isArray(sigs) || Object.keys(sigs).length !== mine.length || !mine.every(s => Object.hasOwn(sigs, s.key)))
        throw new PilotError('invalid_field', `signatures must hold exactly the payer's three slots: ${mine.map(s => s.key).join(', ')}`);
      for (const s of mine) if (!(await this.safeVerify(B.pubkey, t.messages[s.key], sigs[s.key])))
        throw new PilotError('bad_signature', `the ${s.key} signature does not verify for ${B.handle}'s registered key over this transfer's ${s.slot === 'prior' ? `prior acknowledgment (${PRIOR_ACK} of the edge's current total and timestamp at T)` : 'note message'}`, 403);
      const ledger = await this.ledger();
      await this.receivingTransferCheck(C, A, a, {ledger, dealId: d.id});
      this.assertTransferEdgeFree(fromEdge); this.assertTransferEdgeFree(toEdge);
      if (this.spendableNote(B, A, fromNote) < a) throw new PilotError('insufficient_claim', `${a} PC of ${A.handle}'s note to you cannot be spent now (it must reconcile exactly with Valun's journal)`, 409);
      const held = !!B.mandate.review_deliveries;
      const serverSigned = held ? {} : await this.serverSignatures(t, ['issuer', 'payee']);
      // Everything checked: record it.
      const at = iso(this.now());
      for (const s of mine) t.slots[s.name] = {signature: sigs[s.key], by: B.id, at};
      Object.assign(t.slots, serverSigned);
      t.completion_signature = b.completion_signature; t.pay_signature = b.pay_signature;
      this.s.transfers[t.id] = t;
      if (d.status === 'delivered') this.event(d, B.id, 'delivery_accepted', {sha256: b.deliverable_sha256});
      d.transfer_ids = [...(d.transfer_ids || []), t.id];
      d.completion = {by: B.id, signature: b.completion_signature, at, deliverable_sha256: b.deliverable_sha256};
      d.payment = {method: 'transfer', transfer_id: t.id};
      this.event(d, B.id, 'payment_by_transfer', {transfer_id: t.id, issuer: A.id, amount: a});
      if (held) {
        const ap = this.approval(B, d, 'pay_by_transfer', {v: d.agreement.version, terms_hash: d.agreement.terms_hash});
        t.approval_id = ap.id; t.state = 'awaiting_owner'; d.status = 'completion_awaiting_owner';
        this.event(d, 'valun', 'payment_awaiting_owner', {transfer_id: t.id});
      } else d.status = 'paying_by_transfer';
      this.transferEvent(t, 'created', {state: t.state});
      // Decision D-2 c: a collecting set-off on either edge could never apply now (a live payment attempt changes them):
      // superseded at once.
      this.supersedeSetoffsOn([fromEdge, toEdge], 'payment_attempt');
      this.save(); this.transferAudit(t, 'transfer.created');
      if (t.state === 'collecting' && this.transferComplete(t)) await this.applyTransfer(t);
      this.throwIfTransferFailed(t, d, B, t.state === 'failed' ? await this.dealView(d, B) : undefined);
      return {...(await this.dealView(d, B)), transfer: this.transferView(t, B)};
    }
  }
  // After an apply within a request: a transfer the tracker refused (or whose edges changed) is answered as 409
  // transfer_failed (with the code) or 409 transfer_stale; its state is saved already.
  // `deal`: the deal view to answer with (dealView), else one made now without a tracker read.
  throwIfTransferFailed(t, d, viewer, deal = undefined) {
    if (t.state !== 'failed') return;
    const extra = {transfer_id: t.id, code: t.result?.code ?? null, regenerated_as: t.regenerated_as ?? null, deal: deal ?? this.view(d, viewer)};
    if (t.result?.code === 'edge_changed') throw new PilotError('transfer_stale', `an edge changed before the transfer was applied; nothing moved and the deal is payment_due (another payment, the same issuer's included, waits until ${iso(t.fallback_after)}, unless it is a transfer through the same note while that note is still in the state this one acknowledged)`, 409, extra);
    throw new PilotError('transfer_failed', `the tracker did not apply the transfer (${t.result?.code ?? 'refused'}); nothing moved and the deal is payment_due`, 409, extra);
  }

  // POST /deals/:id/cancel-transfer (the payer's agent, while the transfer collects signatures): it ends (cancelled,
  // purged) and the deal becomes payment_due.
  cancelTransfer(p, id) {
    return this.serial(async () => {
      const d = this.sweep(this.partyDeal(id, p));
      if (d.payer !== p.id) throw new PilotError('not_payer', 'only the payer cancels its payment', 403);
      const t = d.payment?.method === 'transfer' ? this.transfer(d.payment.transfer_id) : null;
      if (!t || d.status !== 'paying_by_transfer' || t.state !== 'collecting') throw new PilotError('wrong_state', `deal is ${d.status}; only a payment by transfer still collecting signatures can be cancelled`, 409);
      this.endTransfer(t, 'cancelled', 'cancelled_by_payer');
      return {...(await this.dealView(d, p)), transfer: this.transferView(t, p)};
    });
  }

  // ---------- the pay_by_transfer approval (design §4.8, spec 18.11) ----------
  // The payer's owner reviews deliveries: payByTransfer held the transfer (awaiting_owner; the deal
  // completion_awaiting_owner; nobody else has signed). With the lock held (decideApproval); never calls serial().
  //   approve: everything is checked again first (stalePayment); anything stale voids the approval and the transfer
  //            (void_stale, purged), the deal returns to where it was (delivered with the completion cleared, or
  //            payment_due when its acceptance already stood) and the call answers 409 stale_payment. Otherwise the
  //            server-run issuer and payee sign, the transfer collects the other signatures (for TRANSFER_TTL_MS from
  //            now, at most until T + 50 min) and the deal is paying_by_transfer; with every slot signed it is applied
  //            in this request. A signer outage (503) or a tracker read that fails changes nothing. The approval is
  //            recorded once it passed, so the answer is 200 {approval, deal, transfer} even when the tracker then
  //            refuses the transfer, as for a held credit note (note_failed): transfer.state and transfer.result name
  //            the outcome (failed with the tracker's code or edge_changed, the deal payment_due).
  //   reject:  the transfer is voided and purged (void_rejected); the deal returns as above.
  // A transfer ended so keeps fallback_after = T + 1 h + 60 s: the payer signed its slots, so every other payment of the
  // deal waits until then (D-1), through the same note too, except one that acknowledges the same prior state of it (the
  // same-prior exemption: at the tracker at most one of the two can apply).
  // The lock serialises writes only: a read that sweeps (deal views, /inbox, /owner, /me, /consents, payment options)
  // can end the held transfer while this call awaits a tracker read (stalePayment) or the server signer (expired: the
  // approval becomes void_expired, the slots are purged and the deal is released). So that the decision never revives
  // or ends an attempt a second time, `stillHeld` runs before anything changes and again after every await: the
  // transfer is swept first, and the approval must still be pending, the transfer still awaiting this approval and the
  // deal still waiting for it; otherwise 409 not_pending and the decision changes nothing.
  async decidePayByTransfer(p, a, d, decision, cleanNote) {
    const t = this.paymentTransfer(d);
    const stillHeld = () => {
      if (t) this.sweepTransfer(t);
      if (a.state !== 'pending') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
      if (d.payer !== p.id || d.status !== 'completion_awaiting_owner' || !t || d.payment?.transfer_id !== t.id || t.approval_id !== a.id || t.state !== 'awaiting_owner')
        throw new PilotError('not_pending', 'this approval no longer matches the deal', 409);
    };
    stillHeld();
    const decided = (at = this.now()) => { a.decided_at = iso(at); a.note = cleanNote; };
    if (decision === 'reject') {
      a.state = 'rejected'; decided();
      this.event(d, `owner:${p.id}`, 'owner_rejected', {kind: 'pay_by_transfer'});
      this.endTransfer(t, 'void_rejected', 'rejected_by_owner');      // purged; the deal returns to delivered or payment_due; saves
      this.store.audit({type: 'approval.rejected', id: a.id, deal: d.id, transfer: t.id});
      return {approval: a, deal: await this.dealView(d, p), transfer: this.transferView(t, p)};
    }
    const stale = await this.stalePayment(t, d);
    stillHeld();                                    // ended meanwhile (expired): 409 not_pending, the stale branch never runs
    if (stale) {
      a.state = 'void_stale'; decided();
      const detail = {...(stale.rule ? {rule: stale.rule} : {}), ...(stale.by ? {by: stale.by} : {})};
      this.event(d, `owner:${p.id}`, 'owner_approval_void_stale', {kind: 'pay_by_transfer', reason: stale.code});
      this.endTransfer(t, 'void_stale', stale.code, detail);
      this.store.audit({type: 'approval.void_stale', id: a.id, deal: d.id, transfer: t.id, reason: stale.code, ...detail});
      throw new PilotError('stale_payment', `${stale.why}; nothing moved and the approval is void: the deal is ${d.status} again and your agent must pay it again`, 409,
        {reason: stale.code, ...detail, transfer_id: t.id, deal_status: d.status});
    }
    const signed = await this.serverSignatures(t, ['issuer', 'payee']);      // 503 signer_unavailable: nothing changed, still pending
    stillHeld();                                    // ended meanwhile: 409 not_pending, the signatures just made are dropped
    const now = this.now();
    a.state = 'approved'; decided(now);
    t.state = 'collecting'; t.owner_approval = {approval_id: a.id, at: a.decided_at};
    t.expires_at = iso(Math.max(now, Math.min(now + TRANSFER_TTL_MS, t.timestamp + APPROVED_COLLECT_UNTIL_MS)));
    Object.assign(t.slots, signed);
    d.status = 'paying_by_transfer';
    this.event(d, `owner:${p.id}`, 'owner_approved', {kind: 'pay_by_transfer'});
    this.transferEvent(t, 'owner_approved', {state: t.state});
    this.save(); this.transferAudit(t, 'transfer.owner_approved'); this.store.audit({type: 'approval.approved', id: a.id, deal: d.id, transfer: t.id});
    if (this.transferComplete(t)) await this.applyTransfer(t);
    return {approval: a, deal: await this.dealView(d, p), transfer: this.transferView(t, p)};
  }
  // Whether a held transfer can no longer be made as the payer's agent signed it: null, or {code, why, rule?, by?}.
  // Both edges must still be exactly as it found them (total, timestamp and signature), all three keys current,
  // circulating credit still on for its parties, and every check of its creation must pass again (the payer's, the
  // payee's and the issuer's policies, the sandbox scope, the edges free of other payments, the claim spendable, and
  // D-1: no other attempt of the deal that could still apply). A tracker read that fails throws (BasisError).
  async stalePayment(t, d) {
    const A = this.s.participants[t.issuer.id], B = this.s.participants[t.payer.id], C = this.s.participants[t.payee.id];
    if (!this.circulationFor(B)) return {code: 'circulation_off', why: 'payment by transfer is not enabled for this deal on this server any more'};
    if (!this.transferKeysCurrent(t)) return {code: 'key_changed', why: "a party's agent key changed since your agent signed this payment"};
    const [fromNote, toNote] = await Promise.all([this.basis.note(t.issuer.pubkey, t.payer.pubkey), this.basis.note(t.issuer.pubkey, t.payee.pubkey)]);
    if (!sameState(edgeState(fromNote), t.from_edge.before) || !sameState(edgeState(toNote), t.to_edge.before))
      return {code: 'edge_changed', why: `${A.handle}'s note to you or to ${C.handle} changed on the tracker (its total, timestamp or signature) since your agent signed this payment`};
    if (this.quoteFor(d, A, B, C, t.amount) !== t.quote_digest) return {code: 'quote_changed', why: 'the payment is not the one your agent signed (its quote changed)'};
    try {
      this.sandboxScope(A, C);
      for (const role of ['payer', 'issuer', 'payee']) await this.roleCheck(t, role);
      this.assertTransferEdgeFree(t.from_edge.edge, {exceptTransfer: t.id}); this.assertTransferEdgeFree(t.to_edge.edge, {exceptTransfer: t.id});
    } catch (e) {
      if (e instanceof PilotError && e.status < 500) return {code: e.code, why: e.message, rule: e.extra?.rule ?? null, by: e.extra?.by ?? null};
      throw e;
    }
    if (this.spendableNote(B, A, fromNote, {exceptTransfer: t.id}) < t.amount)
      return {code: 'insufficient_claim', why: `${t.amount} PC of ${A.handle}'s note to you can no longer be spent (it must reconcile exactly with Valun's journal)`};
    const block = await this.paymentBlock(d, {route: 'transfer', fromEdge: t.from_edge.edge, fromPrior: t.from_edge.before.total, fromPriorTimestamp: t.from_edge.before.timestamp,
      timestamp: t.timestamp, exceptTransfer: t.id});
    if (block) return {code: block.code, why: this.paymentBlockError(block).message};
    return null;
  }

  // ---------- consents (design §4.7, spec 18.9) ----------
  // The role a participant signs a collecting transfer in: the issuer and the payee always; the payer only when its own
  // slots are unsigned (a transfer an earlier v16 build made again by itself; this one never does).
  consentRole(t, p) {
    if (t.issuer.id === p.id) return 'issuer';
    if (t.payee.id === p.id) return 'payee';
    if (t.payer.id === p.id && this.slotsOf(t, 'payer').some(s => !t.slots[s.name]?.signature)) return 'payer';
    return null;
  }
  // A transfer as a consent item for p in `role`: only p's own edges (the payee: A->C; the issuer: both; the payer: both),
  // their EdgeStates (the tracker's notes, signed by the issuer), never a message hex or another party's signature. Each
  // edge also names prior_timestamp, its before's timestamp (0 for a new edge): a prior slot is PA(I,R,before.total,
  // prior_timestamp,timestamp).
  consentItem(t, p, role) {
    const who = id => ({id, handle: this.s.participants[id]?.handle ?? null}), slots = this.slotsOf(t, role), d = this.s.deals[t.deal_id];
    const row = (which, yourRole) => {
      const e = t[`${which}_edge`], recipient = which === 'from' ? t.payer : t.payee, own = slots.filter(s => s.which === which);
      return {edge: e.edge, issuer: who(t.issuer.id), recipient: who(recipient.id), your_role: yourRole, before: e.before, prior_timestamp: e.before ? e.before.timestamp : 0,
        change: e.new_total - (e.before?.total ?? 0), new_total: e.new_total, timestamp: t.timestamp, revision: e.revision, slots: own.map(s => s.slot),
        signed_by_you: own.filter(s => t.slots[s.name]?.signature).map(s => s.slot)};
    };
    const edges = role === 'issuer' ? [row('from', 'issuer'), row('to', 'issuer')] : role === 'payee' ? [row('to', 'creditor')] : [row('from', 'creditor'), row('to', 'payer')];
    const owed = edges.filter(e => e.your_role === 'issuer').reduce((x, e) => x + e.change, 0);
    const net = edges.filter(e => e.your_role === 'creditor').reduce((x, e) => x + e.change, 0) - owed;
    return {kind: 'transfer', id: t.id, state: t.state, your_roles: [role], created_at: t.created_at, expires_at: t.expires_at,
      network: t.network, tracker_nft_id: t.tracker_nft_id, denomination: t.denomination, edges,
      context: {amount: t.amount, issuer: who(t.issuer.id), payer: who(t.payer.id), payee: who(t.payee.id),
        ...(role !== 'issuer' && d ? {deal: {deal_id: d.id, terms_hash: d.agreement.terms_hash, price: d.agreement.terms.price.amount, quote_digest: t.quote_digest}} : {})},
      summary: {your_net_change_PC: net, your_total_owed_change_PC: owed}};
  }
  // GET /consents (agent; the owner token reads the same, and cannot sign): the caller's transfers and set-offs
  // collecting signatures, and those that ended in the last 24 hours. Expired ones are swept first. A set-off is listed
  // for a member the server does not run (the server signs for the others at apply time), with only its own edges.
  consentsFor(p) {
    const consents = [], resolved = [];
    const recent = x => !LIVE_TRANSFER.has(x.state) && !LIVE_SETOFF.has(x.state) && this.now() - Date.parse(x.updated_at) <= RECENTLY_RESOLVED_MS;
    for (const t of Object.values(this.s.transfers || {})) {
      if (!this.transferRoles(t, p).length) continue;
      this.sweepTransfer(t);
      const role = t.state === 'collecting' ? this.consentRole(t, p) : null;
      if (role) consents.push(this.consentItem(t, p, role));
      else if (recent(t)) resolved.push({kind: 'transfer', id: t.id, state: t.state, at: t.updated_at});
    }
    for (const o of Object.values(this.s.setoffs || {})) {
      if (!o.members.includes(p.id)) continue;
      this.sweepSetoff(o);
      if (o.state === 'collecting' && !this.serverRun(p)) consents.push(this.setoffItem(o, p));
      else if (recent(o)) resolved.push({kind: 'setoff', id: o.id, state: o.state, at: o.updated_at});
    }
    return {consents, recently_resolved: resolved};
  }
  // A transfer p is a party to, else the same 404 as for an unknown id.
  partyTransfer(id, p) {
    const t = this.transfer(id);
    if (!t || !this.transferRoles(t, p).length) throw new PilotError('not_found', `unknown transfer ${id}`, 404);
    return this.sweepTransfer(t);
  }
  // POST /consents/:id {signatures {'<edge>:<slot>': signature}, revisions {'<edge>': n}}: all of the caller's unsigned
  // slots, or none; each verified against its current key over the message the server built for the edge's current
  // revision (a stale revision is listed in `rejected`); the caller's checks run again; the last missing signature
  // applies the transfer in this request. Answers the item as it now stands (state may be applied or failed).
  // A set-off (vs_...): setoffConsent.
  submitConsent(p, id, body) {
    const b = body && typeof body === 'object' ? body : {};
    if (typeof id === 'string' && id.startsWith('vs_')) return this.serial(() => { this.assertTrackerWritable(); return this.setoffConsent(p, id, b); });
    return this.serial(async () => {
      this.assertTrackerWritable();                 // MIG-1: the last signature applies the transfer
      const t = this.partyTransfer(id, p);
      if (t.state !== 'collecting') throw new PilotError('wrong_state', `this transfer is ${t.state}; it no longer collects signatures`, 409);
      const role = this.consentRole(t, p), mine = role ? this.slotsOf(t, role).filter(s => !t.slots[s.name]?.signature) : [], sigs = b.signatures;
      if (!mine.length) throw new PilotError('already_signed', 'you have signed every slot of yours on this transfer', 409);
      if (p.pubkey !== t[role].pubkey) throw new PilotError('key_changed', 'your registered key is not the one this transfer names', 409);
      if (!sigs || typeof sigs !== 'object' || Array.isArray(sigs) || Object.keys(sigs).length !== mine.length || !mine.every(s => Object.hasOwn(sigs, s.key)))
        throw new PilotError('invalid_field', `signatures must hold exactly your unsigned slots on this item, all at once: ${mine.map(s => s.key).join(', ')}`);
      const revs = b.revisions && typeof b.revisions === 'object' ? b.revisions : {};
      const rejected = mine.filter(s => revs[s.edge] !== undefined && revs[s.edge] !== t[`${s.which}_edge`].revision)
        .map(s => ({slot: s.key, code: 'stale_revision', revision: t[`${s.which}_edge`].revision}));
      if (rejected.length) return {...this.consentItem(t, p, role), rejected};
      for (const s of mine) if (!(await this.safeVerify(p.pubkey, t.messages[s.key], sigs[s.key])))
        throw new PilotError('bad_signature', `the ${s.key} signature does not verify for your registered key over this transfer's ${s.slot === 'prior' ? `prior acknowledgment (${PRIOR_ACK} of the edge's prior total and timestamp at T)` : 'note message'}`, 403);
      // The caller's checks again (design §5.4: at every consent). One that fails now ends the transfer (failed,
      // mandate_changed, as right before apply; its deal becomes payment_due), instead of leaving it to collect until it
      // expires; then 403 payment_not_accepted names the rule.
      try { await this.roleCheck(t, role); }
      catch (e) {
        if (e instanceof PilotError && e.code === 'payment_not_accepted' && this.sweepTransfer(t).state === 'collecting')
          this.endTransfer(t, 'failed', 'mandate_changed', {rule: e.extra?.rule ?? null, by: e.extra?.by ?? null});
        throw e;
      }
      // A lock-free read may have ended it while the signatures were checked: swept first (the window may have passed).
      this.sweepTransfer(t);
      if (t.state !== 'collecting') throw new PilotError('wrong_state', `this transfer is ${t.state}; it no longer collects signatures`, 409);
      const at = iso(this.now());
      for (const s of mine) t.slots[s.name] = {signature: sigs[s.key], by: p.id, at};
      this.transferEvent(t, 'signed', {role});
      this.save(); this.transferAudit(t, 'transfer.signed', {role});
      if (this.transferComplete(t)) await this.applyTransfer(t);
      return {...this.consentItem(t, p, role), result: t.result, rejected: []};
    });
  }
  // POST /consents/:id/refuse {reason?}: the transfer ends (refused, purged) and its deal becomes payment_due. Not signed:
  // a refusal cannot move value. A set-off (vs_...): refuseSetoff.
  refuseConsent(p, id, body) {
    const b = body && typeof body === 'object' ? body : {};
    if (typeof id === 'string' && id.startsWith('vs_')) return this.serial(async () => this.refuseSetoff(p, id, b));
    return this.serial(async () => {
      const t = this.partyTransfer(id, p);
      if (t.state !== 'collecting') throw new PilotError('wrong_state', `this transfer is ${t.state}; there is nothing to refuse`, 409);
      const role = this.consentRole(t, p);
      if (!role) throw new PilotError('wrong_state', 'you have no consent to give on this transfer (the payer cancels it instead)', 409);
      if (b.reason != null && typeof b.reason !== 'string') throw new PilotError('invalid_field', 'reason must be text');
      const reason = b.reason ?? '';
      if (reason.length > 300) throw new PilotError('invalid_field', 'reason is longer than 300 characters');
      if (hasUnsafeText(reason)) throw new PilotError('invalid_field', 'reason contains control, bidi or invisible characters');
      this.endTransfer(t, 'refused', 'refused', {by: role, reason: clean(reason, 300, 'reason')});
      return {...this.consentItem(t, p, role), result: t.result};
    });
  }

  // GET /transfers/:vt (the parties, agent and owner). The issuer sees the amount and both creditors, never the deal; the
  // payee its own edge and the deal; the payer both edges and the deal. Signatures are withheld until the tracker
  // records the transfer; then each party sees those on the edges it is party to (and the payer its own), as its
  // receipt. Everything else about one edge (its state as read back, the sha256 of its signatures, how the read-back
  // classified it) goes only to the parties of that edge: the issuer both, the payer A->B, the payee A->C.
  transferFor(p, id) { return this.transferView(this.partyTransfer(id, p), p); }
  transferView(t, p) {
    const roles = this.transferRoles(t, p), who = id => ({id, handle: this.s.participants[id]?.handle ?? null}), d = this.s.deals[t.deal_id];
    const sees = which => roles.includes('issuer') || roles.includes('payer') || (which === 'to' && roles.includes('payee'));
    const edges = ['from', 'to'].filter(sees).map(which => {
      const e = t[`${which}_edge`];
      return {edge: e.edge, issuer: who(t.issuer.id), recipient: who((which === 'from' ? t.payer : t.payee).id), before: e.before, new_total: e.new_total,
        change: e.new_total - (e.before?.total ?? 0), timestamp: t.timestamp};
    });
    const party = which => roles.includes('issuer') || (which === 'from' ? roles.includes('payer') : roles.includes('payee'));
    const slotSeen = s => party(s.which) || (s.role === 'payer' && roles.includes('payer'));
    const applied = t.state === 'applied';
    const signatures = applied ? Object.fromEntries(TRANSFER_SLOTS.filter(slotSeen).map(s => [s.name, t.slots[s.name]?.signature ?? null])) : null;
    const onOwnEdges = o => (o && typeof o === 'object' ? Object.fromEntries(['from', 'to'].filter(w => party(w) && Object.hasOwn(o, w)).map(w => [w, o[w]])) : o);
    const sha = t.signature_sha256 ? Object.fromEntries(TRANSFER_SLOTS.filter(s => slotSeen(s) && Object.hasOwn(t.signature_sha256, s.name)).map(s => [s.name, t.signature_sha256[s.name]])) : null;
    const result = t.result && Object.hasOwn(t.result, 'edges') ? {...t.result, edges: onOwnEdges(t.result.edges)} : t.result;
    return {id: t.id, kind: 'transfer', state: t.state, your_roles: roles, attempt: t.attempt, regenerated_from: t.regenerated_from ?? null, regenerated_as: t.regenerated_as ?? null,
      created_at: t.created_at, expires_at: t.expires_at, updated_at: t.updated_at, timestamp: t.timestamp, amount: t.amount,
      issuer: who(t.issuer.id), payer: who(t.payer.id), payee: who(t.payee.id), edges,
      ...(roles.some(r => r !== 'issuer') && d ? {deal: {deal_id: d.id, terms_hash: d.agreement.terms_hash, price: d.agreement.terms.price.amount, quote_digest: t.quote_digest}} : {}),
      result, fallback_after: t.fallback_after ? iso(t.fallback_after) : null,
      signatures, ...(applied ? {tracker_after: t.tracker_after ? onOwnEdges(t.tracker_after) : null} : {signatures_withheld: WITHHELD}),
      ...(sha && Object.keys(sha).length ? {signature_sha256: sha} : {}),
      ...(t.resolution ? {resolution: {outcome: t.resolution.outcome, at: t.resolution.at}} : {})};
  }

  // ---------- apply, read back, recover (design §5.5, I-DECIDE) ----------
  async readTransferEdges(t) {
    const [f, c] = await Promise.all([this.basis.note(t.issuer.pubkey, t.payer.pubkey), this.basis.note(t.issuer.pubkey, t.payee.pubkey)]);
    return [edgeState(f), edgeState(c)];
  }
  // With the lock held; never calls serial(). (a) applying is saved first (write-ahead); (b) both edges must still be
  // exactly as the transfer found them, and every check must still pass; (c) POST /notes/transfer; (d) both edges are
  // ALWAYS read back, and that decides: applied iff A->B = (X-a, T, A's issuer_from signature) and A->C = (Y+a, T, A's
  // issuer_to signature). A tracker answer of 4xx with both edges untouched ends it as failed (the code kept, never the
  // tracker's text); a network error, a 5xx or a timeout leaves it applying, for recovery to decide.
  async applyTransfer(t) {
    t.state = 'applying'; t.applying_since = iso(this.now());
    this.transferEvent(t, 'applying');
    this.save(); this.transferAudit(t, 'transfer.applying');
    return this.submitTransfer(t, {recheck: true});
  }
  async submitTransfer(t, {recheck}) {
    let from, to;
    try { [from, to] = await this.readTransferEdges(t); } catch (e) { if (e instanceof BasisError) return this.stillApplying(t, null); throw e; }
    if (recheck) {
      if (!sameState(from, t.from_edge.before) || !sameState(to, t.to_edge.before)) return this.endTransfer(t, 'failed', 'edge_changed');
      if (!this.transferKeysCurrent(t)) return this.endTransfer(t, 'void_key_revoked', 'key_revoked');
      try { for (const role of ['payer', 'issuer', 'payee']) await this.roleCheck(t, role); }
      catch (e) {
        if (e instanceof PilotError) return this.endTransfer(t, 'failed', 'mandate_changed', {rule: e.extra?.rule ?? null, by: e.extra?.by ?? null});
        if (e instanceof BasisError) return this.stillApplying(t, null);
        throw e;
      }
    }
    if (this.writeRefusal()) return t;              // MIG-1: nothing is sent; left applying for recovery (a backstop)
    let r = null;
    try { r = await this.basis.transfer(trackerTransferBody(t)); } catch (e) { if (!(e instanceof BasisError)) throw e; }
    try { [from, to] = await this.readTransferEdges(t); } catch (e) { if (e instanceof BasisError) return this.stillApplying(t, r); throw e; }
    return this.decideTransfer(t, from, to, r);
  }
  // The outcome of transfer t from its edges as read back (classifyEdge, transferOutcome in novation.mjs); `r` the
  // tracker's answer to the submission just made (null: none, as in recovery).
  async decideTransfer(t, from, to, r) {
    const fc = classifyEdge(from, t.from_edge.before, {total: t.from_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_from?.signature ?? null});
    const tc = classifyEdge(to, t.to_edge.before, {total: t.to_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_to?.signature ?? null});
    const o = transferOutcome(fc, tc);
    if (o === 'applied') {
      this.transferApplied(t, from, to, r);
      await this.clearingAfterIncrease([t.to_edge.edge]);          // the raised edge may close a cycle (never throws)
      return t;
    }
    if (o === 'unknown') return this.endTransfer(t, 'outcome_unknown', 'attempt_outcome_unknown', {edges: {from: fc, to: tc}});
    if (o === 'inconsistent') return this.endTransfer(t, 'inconsistent', 'inconsistent', {edges: {from: fc, to: tc}});
    if (o === 'not_applied') return this.endTransfer(t, 'failed', 'edge_changed', {edges: {from: fc, to: tc}});
    // Both edges untouched: a refusal is final (the tracker answered 4xx); anything else is decided later.
    if (r && r.status >= 400 && r.status < 500) return this.endTransfer(t, 'failed', r.code ?? `tracker_${r.status}`, {tracker_status: r.status});
    return this.stillApplying(t, r);
  }
  stillApplying(t, r) {
    t.last_submission = {at: iso(this.now()), tracker_status: r?.status ?? null, tracker_code: r?.code ?? null};
    this.save(); this.transferAudit(t, 'transfer.applying_undecided', {tracker_status: r?.status ?? null});
    return t;
  }
  // Applied: the journal entries (transfer_out -a on A->B, transfer_in +a on A->C: the states the transfer set), the
  // deal paid_by_transfer, and the receipts (GET /transfers/:vt shows each party the signatures on its edges).
  transferApplied(t, from, to, r) {
    const d = this.s.deals[t.deal_id], at = iso(this.now());
    t.state = 'applied'; t.applied_at = at;
    t.result = {code: 'applied', at, ...(r ? {tracker_status: r.status} : {recovered: true})};
    t.tracker_after = {from, to};
    appendEntries(this, [
      {kind: 'transfer_out', ref: t.id, issuer_pubkey: t.issuer.pubkey, recipient_pubkey: t.payer.pubkey, delta: -t.amount,
        total_after: t.from_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_from.signature},
      {kind: 'transfer_in', ref: t.id, issuer_pubkey: t.issuer.pubkey, recipient_pubkey: t.payee.pubkey, delta: t.amount,
        total_after: t.to_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_to.signature}]);
    this.transferEvent(t, 'applied');
    if (d && d.payment?.transfer_id === t.id) {
      d.status = 'paid_by_transfer'; d.payment = {...d.payment, applied_at: at};
      this.event(d, 'basis-tracker', 'paid_by_transfer', {transfer_id: t.id, amount: t.amount});
    }
    this.save(); this.transferAudit(t, 'transfer.applied', {tracker_status: r?.status ?? null});
    return t;
  }
  // A transfer ends without applying (failed, expired, cancelled, refused, void_key_revoked), or is left for the payer's
  // owner (outcome_unknown, inconsistent: the read-back could not decide; an alarm). Synchronous (the lazy sweep calls
  // it); saves. The slot signatures are purged (their sha256 kept); fallback_after = T + 1 h + 60 s for an end without
  // effect. Its deal becomes payment_due (the acceptance stands), or, for a transfer still waiting for the payer's owner,
  // returns to where it was before (delivered with the completion cleared, or payment_due). After an unresolved one the
  // deal is payment_due too, but every payment of it is refused with 409 attempt_outcome_unknown (paymentBlock) until
  // the owner resolves it (after confirming with the payee; resolveAttempt): it may have been paid. An unresolved one
  // keeps its signatures (still withheld from every response) until then, so that a transfer its owner finds applied
  // still has its receipts and journal entries.
  endTransfer(t, state, code, extra = {}) {
    const awaitingOwner = t.state === 'awaiting_owner', d = this.s.deals[t.deal_id], at = iso(this.now()), unresolved = UNRESOLVED_TRANSFER.has(state);
    t.state = state; t.result = {code, at, ...extra};
    if (!unresolved) { t.fallback_after = fallbackAfter(t.timestamp); this.purgeTransfer(t); }
    this.transferEvent(t, state, {code});
    if (d && d.payment?.transfer_id === t.id) {
      if (awaitingOwner) {
        for (const a of Object.values(this.s.approvals)) if (a.id === t.approval_id && a.state === 'pending') a.state = state.startsWith('void_') ? state : `void_${state}`;
        this.releaseAcceptance(d);
        this.event(d, 'valun', 'payment_void', {transfer_id: t.id, reason: code});
      } else {
        d.status = 'payment_due'; d.payment_due_since ??= at;
        this.event(d, 'valun', unresolved ? 'payment_outcome_unknown' : 'payment_due', {transfer_id: t.id, reason: code, ...(unresolved ? {} : {fallback_after: iso(t.fallback_after)})});
      }
    }
    this.save(); this.transferAudit(t, `transfer.${state}`, {code, ...(extra.tracker_status ? {tracker_status: extra.tracker_status} : {})});
    if (unresolved) this.log?.(`Pilot: ALARM: transfer ${t.id} (deal ${t.deal_id}) is ${state}: the read-back cannot decide whether it applied; no other payment of the deal starts until its payer's owner resolves it`);
    return t;
  }
  purgeTransfer(t) {
    for (const [name, s] of Object.entries(t.slots)) if (s?.signature) { (t.signature_sha256 ??= {})[name] = sigSha256(s.signature); delete s.signature; }
  }
  // Lazy expiry (design §5.5, §11): a transfer collecting signatures, or waiting for the payer's owner, past expires_at
  // ends as expired. Called from sweep (views, inbox, exposure), consentsFor, the checks and recover.
  sweepTransfer(t) {
    if ((t.state === 'collecting' || t.state === 'awaiting_owner') && this.now() > Date.parse(t.expires_at)) this.endTransfer(t, 'expired', 'expired');
    return t;
  }
  // A completion that was held for the owner (a credit note or a transfer) is undone: a deal whose acceptance already
  // stood (payment_due, circulating credit) keeps it and owes the payment again; otherwise it returns to delivered and
  // the completion is cleared (as in v15).
  releaseAcceptance(d) {
    if (d.payment_due_since) { d.status = 'payment_due'; return; }
    d.completion = null; d.status = 'delivered';
  }
  // A transfer that failed because an edge changed (edge_changed) is not made again by the server (no regeneration: a
  // new attempt is the payer's own, signed by its client from a fresh template). The deal is payment_due; a new attempt
  // through the same note starts at once while that note is still in the state the failed one acknowledged (the
  // same-prior exemption: only its to-edge moved), and otherwise after the failed one's fallback_after (or once the
  // journal proves it dead).
  // Recovery (startup and every 60 s; with the lock held) of a transfer left applying: both edges at the new state ->
  // applied; both untouched with T within the maximum age -> submitted again (keys still current); untouched but T too
  // old -> failed; an edge changed or moved past T at its prior total -> failed; an edge past T at another total, or at T
  // in another state -> outcome_unknown; one edge applied and the other not -> inconsistent (an audit alarm).
  async recoverTransfer(t) {
    let from, to;
    try { [from, to] = await this.readTransferEdges(t); } catch (e) { if (e instanceof BasisError) return t; throw e; }
    const fc = classifyEdge(from, t.from_edge.before, {total: t.from_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_from?.signature});
    const tc = classifyEdge(to, t.to_edge.before, {total: t.to_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_to?.signature});
    if (transferOutcome(fc, tc) !== 'prior') return this.decideTransfer(t, from, to, null);
    if (t.timestamp < this.now() - MAX_AGE_MS) return this.endTransfer(t, 'failed', 'novation_expired');
    if (!this.transferKeysCurrent(t)) return this.endTransfer(t, 'failed', 'key_revoked');
    return this.submitTransfer(t, {recheck: false});
  }

  // POST /owner/deals/:vd/attempts/:attempt/resolve {outcome: 'not_applied' | 'applied', note?} (the payer's owner; modes
  // sandbox and on; decision D-2 d): resolves a payment attempt whose outcome the read-back could not decide
  // (outcome_unknown or inconsistent; any other state is 409 wrong_state), after the owner confirmed with the payee.
  //   not_applied  the attempt ends without effect (resolved_not_applied; its signatures purged, sha256 kept): it no
  //                longer blocks the deal's payments (attempt_outcome_unknown) nor holds its edges for set-offs, and
  //                another payment (the same issuer's included) may start once its fallback_after (T + 1 h + 60 s)
  //                has passed (a transfer through the same note on the same prior state of it at once: the same-prior
  //                exemption);
  //   applied      the attempt is taken as applied: its journal entries are written (as for a transfer the read-back
  //                showed applied), the deal is paid_by_transfer and the parties' receipts show its signatures.
  // Recorded under the owner token (not key-signed), with an audit line; the owner's note (at most 300 characters, as
  // for an approval decision) stays on its own side. Answers {resolution {attempt_id, outcome, previous_state, at, note},
  // attempt {id, kind 'transfer', timestamp: its T} (what a client matches its own records by), deal, transfer}.
  // Only payments by transfer (vt_) are resolved here: the payer's own credit notes are decided by this server's own
  // read-back of the tracker (paymentBlock never answers attempt_outcome_unknown for one), so a client's resolution of
  // its own note's attempt changes only that client's records.
  // MIG-4: whether deal dealId has the payment attempt attemptId by p (its payer) and its outcome is unknown. Such an
  // attempt blocks every payment of the deal until the payer's owner resolves it, so the resolve route serves it in
  // every mode but off, also where the other circulation routes do not exist (mode bound; mode sandbox for a
  // participant outside the sandbox: an attempt left over from a mode the operator stepped back from).
  unresolvedAttemptOf(p, dealId, attemptId) {
    const d = typeof dealId === 'string' && Object.hasOwn(this.s.deals, dealId) ? this.s.deals[dealId] : null;
    if (!d || d.payer !== p?.id || !(d.transfer_ids || []).includes(attemptId)) return false;
    const t = this.s.transfers?.[attemptId];
    return !!t && UNRESOLVED_TRANSFER.has(t.state);
  }
  resolveAttempt(p, dealId, attemptId, body) {
    const b = body && typeof body === 'object' ? body : {};
    return this.serial(async () => {
      const d = this.partyDeal(dealId, p);
      if (d.payer !== p.id) throw new PilotError('not_payer', "only the payer's owner resolves the deal's payment attempts", 403);
      const t = typeof attemptId === 'string' && (d.transfer_ids || []).includes(attemptId) ? this.transfer(attemptId) : null;
      if (!t) throw new PilotError('not_found', `unknown payment attempt ${attemptId}`, 404);
      if (!UNRESOLVED_TRANSFER.has(t.state)) throw new PilotError('wrong_state', `this payment attempt is ${t.state}; only one whose outcome is unknown (outcome_unknown or inconsistent) is resolved by its owner`, 409);
      if (b.outcome !== 'not_applied' && b.outcome !== 'applied') throw new PilotError('invalid_field', 'outcome must be "not_applied" or "applied"');
      if (b.note != null && typeof b.note !== 'string') throw new PilotError('invalid_field', 'note must be text');
      if (typeof b.note === 'string' && hasUnsafeText(b.note)) throw new PilotError('invalid_field', 'note contains control, bidi or invisible characters');
      // SV-AUTH-1: 'applied' writes the payee's edge as raised in the journal and ends the payee's deal as paid, so the
      // payer's owner may assert it only while the payee's edge shows the transfer: its class at the read-back that left
      // it unresolved, else its state read again now, is the attempt's new state (new, or applied_moved: past T at the
      // new total). An edge at its earlier state, changed before T, moved past it at its earlier total or otherwise
      // unknown does not show it (409, nothing changed); the owner resolves it as not_applied instead.
      if (b.outcome === 'applied') {
        const shows = c => c === 'new' || c === 'applied_moved';
        let cls = t.result?.edges?.to ?? null;
        if (!shows(cls)) {
          const [, to] = await this.readTransferEdges(t);
          cls = classifyEdge(to, t.to_edge.before, {total: t.to_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_to?.signature ?? null});
        }
        if (!shows(cls)) throw new PilotError('payee_edge_not_applied', "the payee's edge on the tracker does not show this transfer (it is at its earlier state or in another one), so the payer's owner cannot resolve it as applied; resolve it as not_applied, or ask the operator to look into it with the payee", 409, {payee_edge: cls});
      }
      const note = clean(b.note ?? '', 300, 'note'), at = iso(this.now()), previous = t.state;
      t.resolution = {outcome: b.outcome, by: 'owner', participant: p.id, at, previous_state: previous, ...(note ? {note} : {})};
      if (b.outcome === 'not_applied') {
        t.state = 'resolved_not_applied'; t.result = {code: 'resolved_not_applied', at, previous: t.result?.code ?? previous};
        t.fallback_after = fallbackAfter(t.timestamp);
        this.purgeTransfer(t);
        this.transferEvent(t, 'resolved_not_applied', {by: 'owner'});
        this.event(d, `owner:${p.id}`, 'payment_attempt_resolved', {transfer_id: t.id, outcome: 'not_applied', fallback_after: iso(t.fallback_after)});
      } else {
        t.state = 'applied'; t.applied_at = at; t.result = {code: 'applied', at, resolved_by_owner: true, previous: t.result?.code ?? previous};
        t.tracker_after = null;
        appendEntries(this, [
          {kind: 'transfer_out', ref: t.id, issuer_pubkey: t.issuer.pubkey, recipient_pubkey: t.payer.pubkey, delta: -t.amount,
            total_after: t.from_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_from?.signature ?? null},
          {kind: 'transfer_in', ref: t.id, issuer_pubkey: t.issuer.pubkey, recipient_pubkey: t.payee.pubkey, delta: t.amount,
            total_after: t.to_edge.new_total, timestamp: t.timestamp, signature: t.slots.issuer_to?.signature ?? null}]);
        this.transferEvent(t, 'applied', {by: 'owner'});
        d.status = 'paid_by_transfer'; d.payment = {method: 'transfer', transfer_id: t.id, applied_at: at};
        this.event(d, `owner:${p.id}`, 'payment_attempt_resolved', {transfer_id: t.id, outcome: 'applied'});
        this.event(d, 'valun', 'paid_by_transfer', {transfer_id: t.id, amount: t.amount, resolved_by_owner: true});
      }
      this.save();
      this.transferAudit(t, 'transfer.resolved_by_owner', {outcome: b.outcome, previous_state: previous, owner: p.id});
      return {resolution: {attempt_id: t.id, outcome: b.outcome, previous_state: previous, at, note}, attempt: {id: t.id, kind: 'transfer', timestamp: t.timestamp},
        deal: await this.dealView(d, p), transfer: this.transferView(t, p)};
    });
  }

  // =================================================================================================================
  // ---------- circulating credit: multilateral set-off (design §4.6, §5.4, §5.5, §5.7; spec 18.7, 18.9, 18.12) ----------
  // Only the clearing engine (lib/pilot/clearing.mjs) proposes set-offs, in modes sandbox and on (in mode sandbox every
  // member is a sandbox agent or a sandbox_only participant). A set-off is s.setoffs[vs_ + 16 hex]:
  //   {id, kind 'setoff', state, created_at, expires_at (+30 min), updated_at, network, tracker_nft_id, denomination,
  //    amount (the sum of its decreases: what it clears), members (participant ids), edges [{edge, issuer {id, pubkey},
  //    recipient {id, pubkey}, decrease, before {total, timestamp, signature}, new_total, timestamp (ts_e), revision,
  //    server_only, slots {issuer, recipient: {signature, by, at, server_signed?} | null}}], cycles [{edges, length,
  //    amount}] (what was packaged), edge_set (its edge set's id, for cooldowns), per_edge_timestamps, source
  //    (incremental, batch, presence or admin), run_id, messages {edge -> the note message hex; never shown}, result
  //    {code, at, ...}, history, read_back (the edges' classes when it did not end applied or untouched),
  //    signature_sha256 {edge -> {issuer, recipient}} (once purged), tracker_after {edge -> EdgeState} (applied),
  //    applying_since, last_submission, applied_at}.
  // Every member signs, for each edge it is party to (as issuer or creditor), the slot '<I>><R>:new' = M(I,R,P-d,ts_e).
  // There are no prior acknowledgments: the tracker refuses any set of edges that does not balance for every key, so
  // every set-off it accepts, even one assembled from part of the signatures, leaves every key's net position unchanged,
  // and each signature fixes its edge's final total. An edge with a member the server does not run (a client edge) gets
  // its ts_e when the proposal is made and is held exclusively; an edge between two server-run members (server-only)
  // gets its state, its ts_e and its signatures at apply time and only reserves its decrease. Withholding as for
  // transfers: no response carries a collected signature before the tracker records the set-off, then each member sees
  // those on its own edges; one that ends without applying has its signatures purged (sha256 kept). A member sees only
  // its own edges, never the other members or who refused. Audit lines carry ids, edge keys, totals and sha256 only,
  // and the tracker's status and code, never its text.
  // Set-offs and payments (decision D-1): a set-off never blocks a payment, but it keeps off every edge that an earlier
  // payment attempt of a deal not yet paid would change (paymentAttemptHolds): moving such an edge past the attempt's
  // timestamp would make the payer's client read the attempt back as applied, or as of unknown outcome. And while one
  // set-off is being applied, no other novation or note changes its edges (its outcome is decided by reading them back).
  setoff(id) { return typeof id === 'string' && Object.hasOwn(this.s.setoffs || {}, id) ? this.s.setoffs[id] : null; }
  setoffEvent(o, event, detail = {}) { o.history.push({at: iso(this.now()), event, ...detail}); o.updated_at = iso(this.now()); }
  setoffAudit(o, type, extra = {}) {
    const sha = (e, r) => (e.slots?.[r]?.signature ? sigSha256(e.slots[r].signature) : o.signature_sha256?.[e.edge]?.[r] ?? null);
    this.store.audit({type, id: o.id, state: o.state, source: o.source, run_id: o.run_id, members: o.members, amount: o.amount,
      edges: o.edges.map(e => ({edge: e.edge, before: e.before?.total ?? null, after: e.new_total, decrease: e.decrease, timestamp: e.timestamp, revision: e.revision,
        signature_sha256: {issuer: sha(e, 'issuer'), recipient: sha(e, 'recipient')}})), ...extra});
  }
  // The live set-offs (collecting or applying) with edge k (other than `exceptId`), expired ones swept first.
  setoffsOnEdge(k, exceptId = null) {
    const out = [];
    for (const o of Object.values(this.s.setoffs || {})) {
      if (o.id === exceptId || !LIVE_SETOFF.has(o.state) || !o.edges.some(e => e.edge === k)) continue;
      if (LIVE_SETOFF.has(this.sweepSetoff(o).state)) out.push(o);
    }
    return out;
  }
  // PC of edge k the live set-offs reserve: their decreases on it.
  setoffReserved(k, exceptId = null) { return this.setoffsOnEdge(k, exceptId).reduce((a, o) => a + o.edges.filter(e => e.edge === k).reduce((x, e) => x + e.decrease, 0), 0); }
  // p's slot on edge e of a set-off: 'issuer', 'recipient' or null.
  setoffRole(e, p) { return e.issuer.id === p.id ? 'issuer' : e.recipient.id === p.id ? 'recipient' : null; }
  // The slots that clients sign ({e, role}: every slot whose party the server does not run), and p's unsigned ones.
  setoffClientSlots(o) {
    const out = [];
    for (const e of o.edges) for (const role of SETOFF_SLOTS) if (!this.serverRun(this.s.participants[e[role].id])) out.push({e, role});
    return out;
  }
  setoffUnsigned(o, p) {
    if (this.serverRun(p)) return [];
    return o.edges.map(e => ({e, role: this.setoffRole(e, p)})).filter(({e, role}) => role && !e.slots[role]?.signature);
  }
  setoffComplete(o) { return this.setoffClientSlots(o).every(({e, role}) => typeof e.slots[role]?.signature === 'string'); }
  setoffKeysCurrent(o) {
    return o.edges.every(e => SETOFF_SLOTS.every(r => { const q = this.s.participants[e[r].id]; return q?.status === 'active' && q.pubkey === e[r].pubkey; }));
  }
  setoffEdgeSets(o) { return [...new Set([o.edge_set, ...(o.cycles ?? []).map(c => edgeSetId(c.edges))])]; }
  perEdgeTimestamps() { return this.trackerCaps?.novation?.setoff?.per_edge_timestamps === true; }
  // The latest ts_e any set-off (in any state) chose on edge k: a new one on k is later still, so that no client is ever
  // asked to sign two different set-offs at the same (edge, timestamp) (rule R4).
  lastSetoffTimestamp(k, exceptId = null) {
    let t = 0;
    for (const o of Object.values(this.s.setoffs || {})) if (o.id !== exceptId) for (const e of o.edges) if (e.edge === k && Number.isSafeInteger(e.timestamp) && e.timestamp > t) t = e.timestamp;
    return t;
  }
  // Whether pair k (issuer key > recipient key) has a deal issuing_note, or (unless `issuing`) one whose credit note
  // waits for its owner.
  pairHoldsNote(k, {issuing = false} = {}) {
    for (const d of Object.values(this.s.deals)) {
      if (!d.credit_note || !(d.status === 'issuing_note' || (!issuing && d.status === 'completion_awaiting_owner'))) continue;
      const n = this.noteKeysOf(d);
      if (edgeKey(n.issuer, n.recipient) === k) return true;
    }
    return false;
  }
  // Decision D-1 and set-offs: the edges that an earlier payment attempt of a deal not yet paid would change, each with
  // the earliest such attempt's timestamp (Map edge -> ms). A payer's client decides whether an earlier attempt can
  // still apply, or applied, by reading its edge back (D-1 items 2 and 3; valun novation attempt_outcome): an edge past
  // the attempt's timestamp at the attempt's new total reads as applied (already_paid), and one past it at a total that
  // is neither the attempt's prior nor its new total as "may have applied" (attempt_outcome_unknown, for the owner to
  // resolve). A set-off that moved such an edge past that timestamp would make the payer's client treat the deal as paid,
  // or refuse to pay it, although nothing paid it. So while the deal is unpaid and has not ended (its status is not
  // terminal), no set-off is proposed on such an edge (clearingSnapshot, createSetoff), and (decision D-2 c) none applies
  // on it, whatever its timestamps: one proposed before the attempt appeared is superseded (payment_attempt) when the
  // attempt is recorded, and again at apply and in housekeeping, and one left applying is not submitted again by
  // recovery (failed) (setoffPaymentBlock, supersedeSetoffsOn).
  // The attempts are what the payer signed for the deal: every transfer of the deal that is not live and did not apply
  // (both its edges; failed, expired, refused, cancelled, void_*, outcome_unknown, inconsistent; not one its owner
  // resolved as not applied, decision D-2 d), every credit note the payer signed that the tracker has not recorded
  // (ownNoteAttempts: the payer>payee pair), and every attempt refused when posted (decision D-2 b, also one recorded
  // unverified; the edge of the payer's it would change: its claim for a transfer, its pair for a note). A live
  // transfer holds its edges already (exclusively), as does a note being issued (setoffPaymentBlock).
  paymentAttemptHolds() {
    const out = new Map(), add = (k, ts) => { if (typeof k === 'string' && Number.isSafeInteger(ts) && !(out.get(k) <= ts)) out.set(k, ts); };
    const now = this.now();
    for (const d of Object.values(this.s.deals)) {
      if (statusClass(d.status)?.terminal || !d.agreement) continue;     // paid (note_issued, paid_by_transfer) or ended
      for (const t of this.transfersOf(d)) {
        if (this.sweepTransfer(t).state === 'applied' || LIVE_TRANSFER.has(t.state) || t.state === 'resolved_not_applied') continue;
        add(t.from_edge.edge, t.timestamp);
        // SV-LIVE-1: the to-edge (A->C) has not the payer on it, and only the server's own D-1 judgment reads it, which
        // takes an ended attempt as dead after its fallback_after; so an ended one holds it only until then (one whose
        // outcome is unknown holds it until its owner resolves it).
        if (UNRESOLVED_TRANSFER.has(t.state) || now <= (t.fallback_after ?? fallbackAfter(t.timestamp))) add(t.to_edge.edge, t.timestamp);
      }
      for (const n of this.ownNoteAttempts(d)) add(n.edge, n.timestamp);
      for (const a of d.refused_attempts || []) if (a.kind === 'transfer') add(this.refusedAttemptEdge(a), a.timestamp);
    }
    return out;
  }
  // Decision D-2 c: why set-off o can never apply now, or null: 'held_note' while a deal on one of its pairs holds a
  // credit note for its owner (completion_awaiting_owner); 'payment_attempt' while a payment attempt would change one of
  // its edges (a live transfer, a note being issued, or an earlier attempt of a deal not yet paid: paymentAttemptHolds).
  setoffPaymentBlock(o, attempts = this.paymentAttemptHolds()) {
    if (o.edges.some(e => this.pairHeldForOwner(e.edge))) return 'held_note';
    if (o.edges.some(e => attempts.has(e.edge) || this.transfersOnEdge(e.edge).length || this.pairHoldsNote(e.edge, {issuing: true}))) return 'payment_attempt';
    return null;
  }
  // Whether a deal on pair k (issuer key > recipient key) holds a credit note for its owner (completion_awaiting_owner
  // with its signed note; a deal whose payment by transfer waits for its owner holds that transfer's edges instead).
  pairHeldForOwner(k) {
    for (const d of Object.values(this.s.deals)) {
      if (d.status !== 'completion_awaiting_owner' || d.credit_note?.state !== 'signed') continue;
      const n = this.noteKeysOf(d);
      if (edgeKey(n.issuer, n.recipient) === k) return true;
    }
    return false;
  }
  // Decision D-2 c: every collecting set-off with an edge in `keys` is superseded (`code`: held_note or
  // payment_attempt; no cooldown). Called where a payment attempt or a held note appears on those edges. Returns their
  // ids.
  supersedeSetoffsOn(keys, code) {
    const set = new Set(keys.filter(k => typeof k === 'string')), out = [];
    if (!set.size) return out;
    for (const o of Object.values(this.s.setoffs || {})) {
      if (o.state !== 'collecting' || this.sweepSetoff(o).state !== 'collecting' || !o.edges.some(e => set.has(e.edge))) continue;
      this.endSetoff(o, 'superseded', code);
      out.push(o.id);
    }
    return out;
  }
  // The clearing member check (design §5.4, spec 18.13): null when p may be a member of a set-off now, otherwise the rule
  // it fails: active with a key; auto_clear on; the mandate not expired; it signs set-off consents (its client declared
  // the setoff role in the last 7 days) or the server runs it; not excluded after three expiries in a row. At a consent
  // and right before apply (`signing`) only what its owner controls is checked again: a member that signs, or signed,
  // is not refused for a declaration or an exclusion that lapsed since.
  clearingParticipantCheck(p, {signing = false} = {}) {
    if (!p || p.status !== 'active' || !p.pubkey) return 'inactive';
    const m = this.effectiveLimits(p);
    if (m.auto_clear !== true) return 'auto_clear';
    if (m.expires_at && Date.parse(m.expires_at) < this.now()) return 'expires_at';
    if (signing) return null;
    if (!this.consentCapable(p, 'setoff')) return 'setoff_consent';
    if (Number(this.s.clearing?.cooldowns?.[`participant:${p.id}`]?.until) > this.now()) return 'cooldown';
    return null;
  }

  // Whether a cycle through p's current key could be eligible at all (SV-ROB-2), from the journal in memory and without
  // the lock or a tracker read: an eligible edge reconciles exactly, so its journal total is its outstanding total (at
  // least 1), and a cycle through p needs one edge from p and one to p. False lets a consent poll skip the search.
  clearingMayCycle(p) {
    const k = p?.pubkey;
    if (!k) return false;
    let out = false, inn = false;
    for (const [edge, e] of Object.entries(this.s.edges || {})) {
      if (!(e?.expected_total >= 1)) continue;
      if (!out && edge.startsWith(`${k}>`)) out = true;
      else if (!inn && edge.endsWith(`>${k}`)) inn = true;
      if (out && inn) return true;
    }
    return false;
  }

  // MIG-1: what tracker 3df7ed93 (no capabilities: no maximum age, no bound-only edges, no reserved residues) would
  // accept although this release counts it dead: the payer-signed notes the tracker did not record whose signatures the
  // state keeps (a deal's failed, stale, rejected, voided or replaced note; not the note of a deal issuing_note or
  // completion_awaiting_owner, which v15 still sends) that are bound notes or are on an edge a transfer or set-off
  // changed, and the transfers and set-offs not applied that keep slot signatures (live or unresolved ones). A v15 state
  // has none. {notes, deals, novations}.
  revivableSignatures() {
    const deals = [];
    let notes = 0, novations = 0;
    for (const d of Object.values(this.s.deals)) {
      const live = d.status === 'issuing_note' || d.status === 'completion_awaiting_owner' ? d.credit_note : null, terms = d.agreement?.terms;
      let found = false;
      for (const n of [d.credit_note, ...(d.rejected_notes || []), ...(d.void_notes || []), ...(d.replaced_notes || [])]) {
        if (!n?.note || n === live || n.state === 'recorded' || !(n.note.signature || n.note.prior_signature)) continue;
        const i = n.issuer_pubkey ?? terms?.payer?.pubkey, r = n.recipient_pubkey ?? terms?.payee?.pubkey;
        const bound = !!n.note.prior_signature || n.note.bound === true || n.note.timestamp % 1000 === BOUND_NOTE_MS;
        if (!bound && !(i && r && this.s.edges?.[edgeKey(i, r)]?.novated)) continue;
        notes += 1; found = true;
      }
      if (found) deals.push(d.id);
    }
    for (const t of Object.values(this.s.transfers || {})) if (t.state !== 'applied' && Object.values(t.slots || {}).some(x => x?.signature)) novations += 1;
    for (const o of Object.values(this.s.setoffs || {})) if (o.state !== 'applied' && (o.edges || []).some(e => e.slots?.issuer?.signature || e.slots?.recipient?.signature)) novations += 1;
    return {notes, deals, novations};
  }
  // ---------- MIG-1 (release v16.1): no pilot writes on a downgraded tracker ----------
  // The circulating-credit history the state holds, or null for none (a v15 state, or one that never left mode off):
  // edges a transfer or set-off changed (bound-only on tracker v3.2; s.edges[k].novated), transfer and set-off records,
  // recorded bound notes, and what revivableSignatures() counts. {novated_edges, transfers, setoffs, bound_notes,
  // revivable: {notes, deals, novations}}.
  circulationHistory() {
    const s = this.s, count = o => Object.keys(o || {}).length;
    let novated = 0, bound = 0;
    for (const e of Object.values(s.edges || {})) if (e?.novated) novated += 1;
    for (const d of Object.values(s.deals || {})) { const n = d.credit_note; if (n?.state === 'recorded' && (n.note?.prior_signature || n.note?.bound === true)) bound += 1; }
    const revivable = this.revivableSignatures(), h = {novated_edges: novated, transfers: count(s.transfers), setoffs: count(s.setoffs), bound_notes: bound, revivable};
    return novated || bound || h.transfers || h.setoffs || revivable.notes || revivable.novations ? h : null;
  }
  // Whether pilot writes are refused now: {code: 'tracker_downgraded', reason, since, history}, or null. They are while the
  // pilot tracker's capabilities have been read and are not tracker v3.2's (validateCaps: null for the Basis 3df7ed93
  // build or a read that failed, or anything else that does not validate) AND the state holds circulating-credit history
  // (circulationHistory). Such a tracker does not enforce bound-only edges or the maximum age of bound notes and
  // novations, so v16 must not write to it: not even an ordinary note (it could land on a bound-only edge) or a held
  // note's release, and recovery sends nothing. A state without that history (v15's) is never refused, so v16 on the
  // 3df7ed93 tracker with a v15 state works as before. Capabilities not read yet (the server is still starting) refuse
  // nothing; nothing is served then. Evaluated at every write and whenever the capabilities are set; when the refusal
  // starts, one ALARM line (with what the state holds that the tracker would revive, MIG-1's alarm) and the audit lines
  // pilot.writes_refused (and pilot.revivable_signatures, when there are such signatures); when it ends (recheckTracker:
  // the 60 s timer reads the capabilities again while refusing), one line and pilot.writes_resumed.
  writeRefusal() {
    const caps = this.trackerCaps, v = caps === undefined ? {ok: true} : validateCaps(caps), history = v.ok ? null : this.circulationHistory();
    if (history && !this.writesRefused) {
      this.writesRefused = {code: 'tracker_downgraded', reason: v.reason, since: iso(this.now()), history};
      const r = history.revivable;
      const held = [history.novated_edges ? `${history.novated_edges} bound-only edge${history.novated_edges === 1 ? '' : 's'}` : null,
        history.transfers ? `${history.transfers} transfer record${history.transfers === 1 ? '' : 's'}` : null,
        history.setoffs ? `${history.setoffs} set-off record${history.setoffs === 1 ? '' : 's'}` : null,
        history.bound_notes ? `${history.bound_notes} recorded bound note${history.bound_notes === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
      const revive = [r.notes ? `${r.notes} unapplied note signature${r.notes === 1 ? '' : 's'} (deals ${r.deals.join(', ')})` : null,
        r.novations ? `${r.novations} transfer or set-off record${r.novations === 1 ? '' : 's'} with unapplied signatures` : null].filter(Boolean).join(' and ');
      this.log?.(`Pilot: ALARM: pilot writes are refused (503 tracker_downgraded): the pilot tracker reports no valid tracker v3.2 capabilities (${v.reason}), and the state holds circulating-credit history (${held || 'unapplied signatures'})${revive ? `, among it ${revive} that this release counts as dead but that tracker would accept (no maximum age, no bound-only edges)` : ''}. Nothing is sent to the tracker, and the capabilities are read again every 60 s. Put the tracker v3.2 binary back (docs/DEPLOY-0.4-RUNBOOK.md step 4); or, to go back to release v15, drain circulating credit and run scripts/pilot-downgrade-check.mjs in maintenance mode (runbook R3), which purges them, before running that tracker`);
      try {
        this.store.audit({type: 'pilot.writes_refused', code: 'tracker_downgraded', reason: v.reason, history: {novated_edges: history.novated_edges, transfers: history.transfers, setoffs: history.setoffs, bound_notes: history.bound_notes}});
        if (r.notes || r.novations) this.store.audit({type: 'pilot.revivable_signatures', notes: r.notes, deals: r.deals, novations: r.novations});
      } catch { /* the log line stands */ }
    } else if (!history && this.writesRefused) {
      const was = this.writesRefused;
      this.writesRefused = null;
      const why = v.ok ? 'the pilot tracker reports the tracker v3.2 contract again' : 'the state no longer holds circulating-credit history';
      this.log?.(`Pilot: pilot writes resumed: ${why} (writes were refused since ${was.since}); circulating credit: ${this.mode}`);
      try { this.store.audit({type: 'pilot.writes_resumed', refused_since: was.since, why: v.ok ? 'tracker_v3.2' : 'no_history'}); } catch { /* the log line stands */ }
    }
    return this.writesRefused;
  }
  // 503 tracker_downgraded, before anything is sent or recorded, while pilot writes are refused (writeRefusal).
  assertTrackerWritable() {
    const r = this.writeRefusal();
    if (r) throw new PilotError('tracker_downgraded', 'this server does not write to its pilot tracker just now: the tracker reports no valid tracker v3.2 capabilities, and this server\'s state holds circulating-credit history that such a tracker does not protect (bound-only edges, the maximum age of bound notes and novations). Nothing was sent or recorded. The operator puts the tracker v3.2 binary back (deploy runbook step 4), or, before going back to release v15, runs the downgrade check in maintenance mode (runbook R3). Try again later.', 503, {retry_after_ms: CAPS_REREAD_MS});
  }
  // While pilot writes are refused, the 60 s timer (server.mjs) reads the tracker's capabilities again (Basis.refresh);
  // a read that validates (tracker v3.2) becomes trackerCaps, which applies the requested circulation mode as at startup
  // and lifts the refusal. Returns true when it lifted the refusal. Never throws.
  async recheckTracker() {
    if (!this.writeRefusal() || typeof this.basis?.refresh !== 'function') return false;
    const caps = await Promise.resolve().then(() => this.basis.refresh()).catch(() => null);
    if (!validateCaps(caps).ok) return false;
    this.trackerCaps = caps;
    return !this.writesRefused;
  }

  // ---------- what the clearing engine reads ----------
  // The snapshot of clearing.mjs eligibleGraph and metrics: every participant's standing (current key, member check,
  // sandbox, server-run, present, dormant: a sandbox participant whose sandbox time has ended) and every tracker edge in
  // the pilot denomination, with its reconciliation (match and exact with the journal), the PC live set-offs reserve on
  // it, whether a live transfer or a set-off with a client signer holds it exclusively, and whether it is busy (a deal
  // on the pair issuing_note or holding a note for its owner, a set-off on it being applied, or an earlier payment
  // attempt of a deal not yet paid that would change it: paymentAttemptHolds, decision D-1). Reads the tracker once
  // (unless `ledger` is given); changes nothing but lazy expiry.
  async clearingSnapshot({ledger = null} = {}) {
    ledger ??= await this.ledger();
    const now = this.now(), participants = {}, live = new Map(), moving = new Set(), held = new Set(), attempts = this.paymentAttemptHolds();
    for (const p of Object.values(this.s.participants)) {
      const active = p.status === 'active' && !!p.pubkey;
      participants[p.id] = {id: p.id, pubkey: active ? p.pubkey : null, member: active && this.clearingParticipantCheck(p) === null, sandbox: this.inSandbox(p),
        server_run: this.serverRun(p), present: this.present(p), dormant: !!p.sandbox_only && Date.parse(p.sandbox_expires_at) < now};
    }
    for (const o of Object.values(this.s.setoffs || {})) {
      if (!LIVE_SETOFF.has(this.sweepSetoff(o).state)) continue;
      for (const e of o.edges) { if (!live.has(e.edge)) live.set(e.edge, []); live.get(e.edge).push({o, e}); }
    }
    for (const t of Object.values(this.s.transfers || {})) if (LIVE_TRANSFER.has(this.sweepTransfer(t).state)) { moving.add(t.from_edge.edge); moving.add(t.to_edge.edge); }
    for (const d of Object.values(this.s.deals)) {
      if (d.credit_note && (d.status === 'issuing_note' || d.status === 'completion_awaiting_owner')) { const n = this.noteKeysOf(d); held.add(edgeKey(n.issuer, n.recipient)); }
    }
    const edges = ledger.map(l => {
      const k = edgeKey(l.issuer_pubkey, l.recipient_pubkey), note = TRACKER_NOTE.get(l), j = this.s.edges[k], on = live.get(k) ?? [];
      return {edge: k, issuer_pubkey: l.issuer_pubkey, recipient_pubkey: l.recipient_pubkey, issuer: l.issuer, recipient: l.recipient, total: l.total, outstanding: l.outstanding,
        timestamp: l.timestamp, signature: note?.signature ?? null, reconciled: !!j && j.expected_total === l.total && this.exactEdge(k, note),
        reserved: on.reduce((a, x) => a + x.e.decrease, 0), exclusive: moving.has(k) || on.some(x => !x.e.server_only),
        busy: held.has(k) || on.some(x => x.o.state === 'applying') || attempts.has(k)};
    });
    return {mode: this.mode, now, participants, edges};
  }
  // What the engine's plan reads (clearing.mjs planProposals): the cooldowns, how many live set-offs each member the
  // server does not run is in, and in all; and (SV-DOS-1) the members the server does not run that have not signed a
  // set-off since their last expiry left unsigned (s.clearing.signed_at: set at a set-off signature, removed at such an
  // expiry; a member that never signed has none), with how many live set-offs have such a member.
  clearingPlanState() {
    const collecting = new Map(), unproven = new Set(), signed = this.s.clearing?.signed_at ?? {};
    for (const p of Object.values(this.s.participants)) if (!this.serverRun(p) && !Object.hasOwn(signed, p.id)) unproven.add(p.id);
    let total = 0, collectingUnproven = 0;
    for (const o of Object.values(this.s.setoffs || {})) {
      if (!LIVE_SETOFF.has(this.sweepSetoff(o).state)) continue;
      total += 1;
      if (o.members.some(id => unproven.has(id))) collectingUnproven += 1;
      for (const id of o.members) if (!this.serverRun(this.s.participants[id])) collecting.set(id, (collecting.get(id) ?? 0) + 1);
    }
    return {cooldowns: this.s.clearing?.cooldowns ?? {}, collecting, collectingTotal: total, unproven, collectingUnproven};
  }

  // ---------- making a proposal ----------
  // A proposal from the engine (clearing.mjs packageCycles: {edges [{edge, decrease, state}], cycles}), with the lock
  // held; never calls serial(). Everything is checked first, and a proposal that fails a check records nothing
  // ({skipped: reason}): every edge's keys are its participants' current keys; at most max_package_edges distinct edges
  // and max_package_parties members; the decreases balance for every key; every member passes the clearing member check
  // (mode sandbox: a sandbox participant); the caps and the cooldowns; no live transfer, and for a client edge no other
  // live set-off, holds an edge, and no edge is busy (a deal on its pair issuing_note or holding a note for its owner, a
  // set-off on it being applied, or an earlier payment attempt of a deal not yet paid that would change it:
  // paymentAttemptHolds, decision D-1); then every edge, read again from the tracker, is exactly as the
  // engine saw it, reconciles exactly with the journal and still has its decrease available after what other set-offs
  // reserve. Client edges get their ts_e now (none 1.5 s back yet: {skipped: 'timestamp_ahead', retry_after_ms}); a
  // tracker without per-edge timestamps gets one for every edge. A proposal with no client slot (every member is
  // server-run) is applied at once. Returns the record.
  async createSetoff(pkg, {source = 'batch', runId = null, limits = CLEARING_LIMITS} = {}) {
    const skip = (why, extra = {}) => ({skipped: why, ...extra});
    if (this.writeRefusal()) return skip('tracker_downgraded');          // MIG-1
    if (!this.circulating) return skip('circulation_off');
    const list = Array.isArray(pkg?.edges) ? pkg.edges : [];
    if (list.length < 2 || list.length > Math.min(64, limits.max_package_edges)) return skip('invalid');
    const rows = [], keys = new Set();
    for (const pe of list) {
      const k = typeof pe?.edge === 'string' ? pe.edge : '', [ik = '', rk = ''] = k.split('>');
      if (!KEY_RE.test(ik) || !KEY_RE.test(rk) || ik === rk || keys.has(k) || !Number.isSafeInteger(pe.decrease) || pe.decrease < 1) return skip('invalid');
      keys.add(k);
      const A = this.byPubkey(ik), R = this.byPubkey(rk);
      if (!A || !R || A.id === R.id || A.pubkey !== ik || R.pubkey !== rk || A.status !== 'active' || R.status !== 'active') return skip('key_changed');
      rows.push({k, ik, rk, A, R, d: pe.decrease, seen: pe.state ?? null, serverOnly: this.serverRun(A) && this.serverRun(R)});
    }
    if (!setoffBalanced(rows.map(r => ({from: r.ik, to: r.rk, decrease: r.d})))) return skip('not_balanced');
    const members = [...new Map(rows.flatMap(r => [[r.A.id, r.A], [r.R.id, r.R]])).values()];
    if (members.length > limits.max_package_parties) return skip('invalid');
    for (const q of members) { const rule = this.clearingParticipantCheck(q); if (rule) return skip('member_check', {rule}); }
    if (this.mode === 'sandbox' && !members.every(q => this.inSandbox(q))) return skip('sandbox_only');
    const plan = this.clearingPlanState(), now0 = this.now(), set = edgeSetId([...keys]);
    if (plan.collectingTotal >= limits.max_collecting_total) return skip('max_collecting_total');
    if (members.some(q => !this.serverRun(q) && (plan.collecting.get(q.id) ?? 0) >= limits.max_collecting_per_participant)) return skip('max_collecting_per_participant');
    // SV-DOS-1: members that have not signed (plan.unproven) hold at most max_collecting_per_unproven each, and proposals
    // with such a member at most max_collecting_unproven in all, so the rest of the cap stays for members that sign.
    const weak = members.filter(q => plan.unproven?.has(q.id));
    if (weak.length && plan.collectingUnproven >= (limits.max_collecting_unproven ?? Infinity)) return skip('max_collecting_unproven');
    if (weak.some(q => (plan.collecting.get(q.id) ?? 0) >= (limits.max_collecting_per_unproven ?? Infinity))) return skip('max_collecting_per_participant');
    if (Number(plan.cooldowns[`set:${set}`]?.until) > now0 || members.some(q => Number(plan.cooldowns[`refusal:${q.id}:${set}`]?.until) > now0)) return skip('cooldown');
    const attempts = this.paymentAttemptHolds();
    for (const r of rows) {
      const live = this.setoffsOnEdge(r.k);
      if (this.transfersOnEdge(r.k).length || (!r.serverOnly && live.length)) return skip('reserved');
      if (live.some(o => o.state === 'applying') || this.pairHoldsNote(r.k) || attempts.has(r.k)) return skip('busy');
    }
    let notes;
    try { notes = await Promise.all(rows.map(r => this.basis.note(r.ik, r.rk))); } catch (e) { if (e instanceof BasisError) return skip('tracker_unavailable'); throw e; }
    for (const [i, r] of rows.entries()) {
      const n = notes[i], st = edgeState(n), j = this.s.edges[r.k];
      if (!st || (r.seen && !sameState(st, r.seen))) return skip('edge_changed');
      if (!j || j.expected_total !== st.total || !this.exactEdge(r.k, n)) return skip('not_reconciled');
      if (st.total - Number(n.amount_redeemed ?? 0) - this.setoffReserved(r.k) < r.d) return skip('insufficient');
      r.before = st;
    }
    // ts_e: the largest timestamp ending in 998 ms at least 1.5 s back, after the edge's note and after every earlier
    // set-off timestamp on it (design §4.3).
    const perEdge = this.perEdgeTimestamps(), now = this.now(), after = r => Math.max(r.before.timestamp, this.lastSetoffTimestamp(r.k));
    const shared = perEdge ? null : novationTimestamp({now, residue: SETOFF_MS, after: Math.max(...rows.map(after))});
    for (const r of rows) {
      const t = shared ?? (r.serverOnly ? {timestamp: null} : novationTimestamp({now, residue: SETOFF_MS, after: after(r)}));
      if (t.timestamp === undefined) return skip('timestamp_ahead', {retry_after_ms: t.ahead_ms});
      r.ts = t.timestamp;
    }
    const messages = {};
    try {
      for (const r of rows) if (r.ts !== null) messages[r.k] = (await this.noteMessage({issuer: r.ik, recipient: r.rk, total: r.before.total - r.d, timestamp: r.ts})).message_hex;
    } catch (e) { if (e instanceof PilotError && e.status === 503) return skip('signer_unavailable'); throw e; }
    const at = iso(now);
    const o = {id: rid('vs_', 8), kind: 'setoff', state: 'collecting', created_at: at, expires_at: iso(now + SETOFF_TTL_MS), updated_at: at,
      network: NETWORK, tracker_nft_id: this.basis.nft, denomination: this.basis.denomination, amount: rows.reduce((a, r) => a + r.d, 0), members: members.map(q => q.id),
      edges: rows.map(r => ({edge: r.k, issuer: {id: r.A.id, pubkey: r.ik}, recipient: {id: r.R.id, pubkey: r.rk}, decrease: r.d, before: r.before,
        new_total: r.before.total - r.d, timestamp: r.ts, revision: 1, server_only: r.serverOnly, slots: {issuer: null, recipient: null}})),
      cycles: (Array.isArray(pkg.cycles) ? pkg.cycles : []).map(c => ({edges: [...c.edges], length: c.length, amount: c.amount})),
      edge_set: set, per_edge_timestamps: perEdge, source, run_id: runId, messages, result: null, history: []};
    this.s.setoffs[o.id] = o;
    this.setoffEvent(o, 'created', {state: o.state, source});
    this.save(); this.setoffAudit(o, 'setoff.created');
    if (!this.setoffClientSlots(o).length) await this.applySetoff(o);
    return o;
  }

  // ---------- consents, views (design §4.7, §4.9; spec 18.9, 18.12) ----------
  // A set-off p is a member of, else the same 404 as for an unknown id.
  partySetoff(id, p) {
    const o = this.setoff(id);
    if (!o || !o.members.includes(p.id)) throw new PilotError('not_found', `unknown set-off ${id}`, 404);
    return this.sweepSetoff(o);
  }
  // A set-off as member p's consent item (GET /consents): only p's own edges, with their EdgeStates (the edge issuer's
  // signature, which the client verifies) and its one slot on each ('new'), never a message hex, another member or a
  // signature. summary: the changes where p is creditor minus those where it is issuer (always 0), and those where it
  // is issuer; context.amount: what it clears of p's claims (as much as of its debts).
  setoffItem(o, p) {
    const who = id => ({id, handle: this.s.participants[id]?.handle ?? null});
    const edges = o.edges.filter(e => this.setoffRole(e, p)).map(e => {
      const role = this.setoffRole(e, p);
      return {edge: e.edge, issuer: who(e.issuer.id), recipient: who(e.recipient.id), your_role: role === 'issuer' ? 'issuer' : 'creditor', before: e.before,
        change: e.new_total - (e.before?.total ?? 0), new_total: e.new_total, timestamp: e.timestamp, revision: e.revision, slots: ['new'],
        signed_by_you: e.slots[role]?.signature ? ['new'] : []};
    });
    const owed = edges.filter(e => e.your_role === 'issuer').reduce((a, e) => a + e.change, 0), claims = edges.filter(e => e.your_role === 'creditor').reduce((a, e) => a + e.change, 0);
    return {kind: 'setoff', id: o.id, state: o.state, your_roles: ['member'], created_at: o.created_at, expires_at: o.expires_at,
      network: o.network, tracker_nft_id: o.tracker_nft_id, denomination: o.denomination, edges,
      context: {amount: -claims}, summary: {your_net_change_PC: claims - owed, your_total_owed_change_PC: owed}};
  }
  // What a member sees of a set-off's result: its code and when (and the tracker's status), never who refused or which
  // member's rule failed (that would name another member).
  setoffResult(o) { return o.result ? {code: o.result.code, at: o.result.at, ...(o.result.tracker_status ? {tracker_status: o.result.tracker_status} : {})} : null; }
  // GET /setoffs/:vs (its members, agent and owner): the member's own edges only; signatures withheld until the tracker
  // records the set-off, then those on the member's own edges (its receipt) and those edges as read back.
  setoffFor(p, id) { return this.setoffView(this.partySetoff(id, p), p); }
  setoffView(o, p) {
    const item = this.setoffItem(o, p), mine = o.edges.filter(e => this.setoffRole(e, p)), applied = o.state === 'applied';
    const sha = Object.fromEntries(mine.filter(e => o.signature_sha256?.[e.edge]).map(e => [e.edge, o.signature_sha256[e.edge]]));
    return {id: o.id, kind: 'setoff', state: o.state, your_roles: ['member'], created_at: o.created_at, expires_at: o.expires_at, updated_at: o.updated_at,
      applied_at: o.applied_at ?? null, edges: item.edges.map(({slots, signed_by_you, ...e}) => e), summary: item.summary, result: this.setoffResult(o),
      signatures: applied ? Object.fromEntries(mine.map(e => [e.edge, {issuer: e.slots.issuer?.signature ?? null, recipient: e.slots.recipient?.signature ?? null}])) : null,
      ...(applied ? {tracker_after: Object.fromEntries(mine.map(e => [e.edge, o.tracker_after?.[e.edge] ?? null]))} : {signatures_withheld: SETOFF_WITHHELD}),
      ...(Object.keys(sha).length ? {signature_sha256: sha} : {})};
  }
  // POST /consents/vs_... (with the lock held; never calls serial()): every unsigned slot of the caller's own edges, or
  // none, each verified against its current key over the message for the edge's current revision (a slot signed for an
  // older revision goes into `rejected`, and nothing is recorded); then the member check again: one its owner's mandate
  // no longer passes ends the set-off (failed, mandate_changed, as right before apply; design §5.4) and answers 403
  // payment_not_accepted (by member, with the rule). The last missing client signature applies the set-off in this
  // request. Answers the item as it now stands (its state may be applied, collecting again after a regeneration,
  // superseded or failed).
  async setoffConsent(p, id, b) {
    const o = this.partySetoff(id, p);
    if (o.state !== 'collecting') throw new PilotError('wrong_state', `this set-off is ${o.state}; it no longer collects signatures`, 409);
    if (this.serverRun(p)) throw new PilotError('wrong_state', 'the server signs this participant\'s part of a set-off itself', 409);
    const mine = this.setoffUnsigned(o, p), slotKey = e => `${e.edge}:new`, sigs = b.signatures;
    if (!mine.length) throw new PilotError('already_signed', 'you have signed every slot of yours on this set-off', 409);
    if (mine.some(({e, role}) => e[role].pubkey !== p.pubkey)) throw new PilotError('key_changed', 'your registered key is not the one this set-off names', 409);
    if (!sigs || typeof sigs !== 'object' || Array.isArray(sigs) || Object.keys(sigs).length !== mine.length || !mine.every(({e}) => Object.hasOwn(sigs, slotKey(e))))
      throw new PilotError('invalid_field', `signatures must hold exactly your unsigned slots on this item, all at once: ${mine.map(({e}) => slotKey(e)).join(', ')}`);
    const revs = b.revisions && typeof b.revisions === 'object' && !Array.isArray(b.revisions) ? b.revisions : {};
    const rejected = mine.filter(({e}) => revs[e.edge] !== undefined && revs[e.edge] !== e.revision).map(({e}) => ({slot: slotKey(e), code: 'stale_revision', revision: e.revision}));
    if (rejected.length) return {...this.setoffItem(o, p), result: this.setoffResult(o), rejected};
    const revision = new Map(mine.map(({e}) => [e.edge, e.revision]));
    for (const {e} of mine) if (!(await this.safeVerify(p.pubkey, o.messages[e.edge], sigs[slotKey(e)])))
      throw new PilotError('bad_signature', `the ${slotKey(e)} signature does not verify for your registered key over this set-off's note message`, 403);
    const rule = this.clearingParticipantCheck(p, {signing: true});
    if (rule) {
      if (this.sweepSetoff(o).state === 'collecting') this.endSetoff(o, 'failed', 'mandate_changed', {rule});
      this.refusePayment('member', rule, `${p.handle} cannot take part in this set-off now: its owner's mandate does not allow it (${rule}); the set-off has ended and nothing was applied`);
    }
    // A lock-free read may have ended it while the signatures were checked.
    if (this.sweepSetoff(o).state !== 'collecting' || mine.some(({e, role}) => e.revision !== revision.get(e.edge) || e.slots[role]?.signature))
      throw new PilotError('wrong_state', `this set-off is ${o.state}; it no longer collects these signatures`, 409);
    const at = iso(this.now());
    for (const {e, role} of mine) e.slots[role] = {signature: sigs[slotKey(e)], by: p.id, at};
    if (this.s.clearing.expiry_streaks?.[p.id]) delete this.s.clearing.expiry_streaks[p.id];
    (this.s.clearing.signed_at ??= {})[p.id] = at;                 // a member that signs (SV-DOS-1, clearingPlanState)
    this.setoffEvent(o, 'signed', {member: p.id});
    this.save(); this.setoffAudit(o, 'setoff.signed', {member: p.id});
    if (this.setoffComplete(o)) await this.applySetoff(o);
    return {...this.setoffItem(o, p), result: this.setoffResult(o), rejected: []};
  }
  // POST /consents/vs_.../refuse {reason?} (with the lock held): the set-off ends (refused, purged; nothing applies) and a
  // 24-hour cooldown starts for this member and its edge set (and each cycle packaged in it). Not signed: a refusal
  // moves nothing. The other members see only that it was refused.
  refuseSetoff(p, id, b) {
    const o = this.partySetoff(id, p);
    if (o.state !== 'collecting') throw new PilotError('wrong_state', `this set-off is ${o.state}; there is nothing to refuse`, 409);
    if (this.serverRun(p)) throw new PilotError('wrong_state', 'the server decides this participant\'s part of a set-off itself', 409);
    if (b.reason != null && typeof b.reason !== 'string') throw new PilotError('invalid_field', 'reason must be text');
    const reason = b.reason ?? '';
    if (reason.length > 300) throw new PilotError('invalid_field', 'reason is longer than 300 characters');
    if (hasUnsafeText(reason)) throw new PilotError('invalid_field', 'reason contains control, bidi or invisible characters');
    const now = this.now(), c = this.s.clearing;
    for (const s of this.setoffEdgeSets(o)) c.cooldowns[`refusal:${p.id}:${s}`] = {until: now + COOLDOWN_REFUSED_MS, reason: 'refused', setoff: o.id};
    c.refusals.push({setoff: o.id, member: p.id, at: iso(now), reason: clean(reason, 300, 'reason')});
    if (c.refusals.length > CLEARING_REFUSALS_KEPT) c.refusals.splice(0, c.refusals.length - CLEARING_REFUSALS_KEPT);
    this.endSetoff(o, 'refused', 'refused');
    return {...this.setoffItem(o, p), result: this.setoffResult(o)};
  }

  // ---------- apply, read back, recover (design §5.5, I-DECIDE) ----------
  // Applies a set-off once every client slot is signed, with the lock held; never calls serial().
  //   (a) every edge is read again (refreshSetoff): a client edge that moved is made again on its own (its state now,
  //       a new ts_e and its revision + 1; the signatures on it are purged and its client parties sign again, while
  //       the other edges keep theirs), and when an edge no longer has its decrease the proposal is superseded; a
  //       server-only edge takes its state now and a fresh ts_e (when there is none 1.5 s back yet, the apply waits
  //       for one: Clearing.defer);
  //   (b) every server-run role signs just in time (pilot.serverSigner); the members' mandates (mandate_changed) and
  //       the balance are checked again;
  //   (c) applying is saved (write-ahead); (d) the edges are read once more and must be exactly as signed (else it
  //       goes back to collecting and is tried again); (e) POST /notes/setoff; (f) every edge is ALWAYS read back, and
  //       that decides (decideSetoff).
  // It waits, collecting (the engine's tick applies it later), while another set-off on one of its edges is being
  // applied (that one's outcome is decided by reading its edges back, so nothing else may change them meanwhile), and
  // when a tracker read or the server signer fails. Decision D-2 c: it never applies while a deal on one of its pairs
  // holds a credit note for its owner (superseded, held_note) or while a payment attempt would change one of its edges
  // (superseded, payment_attempt): a live transfer, a note being issued, or an earlier attempt of a deal not yet paid
  // (paymentAttemptHolds), whatever the timestamps.
  // Lock-free reads sweep, so they can expire it while this awaits: after every await it must still be collecting, else
  // nothing more happens.
  async applySetoff(o) {
    const ready = () => this.sweepSetoff(o).state === 'collecting' && this.setoffComplete(o);
    const mandates = () => {
      for (const id of o.members) { const rule = this.clearingParticipantCheck(this.s.participants[id], {signing: true}); if (rule) return rule; }
      return null;
    };
    if (!ready()) return o;
    if (!this.circulating) return this.endSetoff(o, 'failed', 'circulation_off');
    if (!this.setoffKeysCurrent(o)) return this.endSetoff(o, 'void_key_revoked', 'key_revoked');
    let rule = mandates();
    if (rule) return this.endSetoff(o, 'failed', 'mandate_changed', {rule});
    if (o.edges.some(e => this.setoffsOnEdge(e.edge, o.id).some(x => x.state === 'applying'))) return o;
    const attempts = this.paymentAttemptHolds(), blocked = this.setoffPaymentBlock(o, attempts);
    if (blocked) return this.endSetoff(o, 'superseded', blocked);
    let notes;
    try { notes = await this.readSetoffEdges(o); } catch (e) { if (e instanceof BasisError) return o; throw e; }
    if (!ready()) return o;
    const step = await this.refreshSetoff(o, notes, attempts);                             // (a)
    if (step.status !== 'ready' || !ready()) return o;
    let signed;
    try { signed = await this.setoffServerSignatures(o, step.fresh); }                     // (b)
    catch (e) { if (e instanceof PilotError && e.status === 503) { this.setoffAudit(o, 'setoff.signer_unavailable'); return o; } throw e; }
    if (!ready()) return o;                                                                // ended meanwhile: the signatures just made are dropped
    rule = mandates();
    if (rule) return this.endSetoff(o, 'failed', 'mandate_changed', {rule});
    if (!setoffBalanced(o.edges)) return this.endSetoff(o, 'failed', 'not_balanced');      // a guard: decreases never change
    if (!o.edges.every(e => SETOFF_SLOTS.every(r => typeof (signed[e.edge]?.[r] ?? e.slots[r])?.signature === 'string'))) return o;
    const now = this.now();
    for (const e of o.edges) {                                                             // (c)
      const f = step.fresh.get(e.edge);
      if (f) { if (!sameState(f.before, e.before)) e.revision += 1; e.before = f.before; e.new_total = f.new_total; e.timestamp = f.timestamp; o.messages[e.edge] = f.message; }
      for (const [role, s] of Object.entries(signed[e.edge] ?? {})) e.slots[role] = s;
    }
    o.state = 'applying'; o.applying_since = iso(now);
    this.setoffEvent(o, 'applying');
    this.save(); this.setoffAudit(o, 'setoff.applying');
    let again;
    try { again = await this.readSetoffEdges(o); } catch (e) { if (e instanceof BasisError) return this.setoffStillApplying(o, null); throw e; }   // (d)
    if (o.edges.some((e, i) => !sameState(edgeState(again[i]), e.before))) {
      // Moved since (a), which only a write around Valun can do: back to collecting; the next attempt makes the moved
      // edges again. The server-run signatures just recorded are dropped (they are made again then).
      for (const e of o.edges) for (const r of SETOFF_SLOTS) if (e.slots[r]?.server_signed) e.slots[r] = null;
      o.state = 'collecting'; delete o.applying_since;
      this.setoffEvent(o, 'apply_deferred', {reason: 'edge_changed'});
      this.save(); this.setoffAudit(o, 'setoff.apply_deferred', {reason: 'edge_changed'});
      this.clearing?.defer(o.id, 1000);
      return o;
    }
    return this.submitSetoff(o);                                                           // (e), (f)
  }
  // (a) of applySetoff: what the edges as read now (`notes`) mean for the proposal, with the lock held. Returns {status:
  // 'ready', fresh} (fresh: edge -> {before, new_total, timestamp} for each server-only edge, not recorded yet), or
  // {status} 'ended' (superseded), 'regenerated' (collecting again: a client edge was made again and its parties sign
  // again) or 'waiting' (no fresh ts_e for a server-only edge yet: Clearing.defer; a signer outage; ended meanwhile).
  // A moved client edge that an earlier payment attempt of a deal not yet paid would change (`attempts`,
  // paymentAttemptHolds) is not made again (its new ts_e would follow that attempt's): superseded, payment_attempt.
  async refreshSetoff(o, notes, attempts = this.paymentAttemptHolds()) {
    const perEdge = o.per_edge_timestamps, moved = [], fresh = new Map();
    const end = (code) => { if (o.state === 'collecting') this.endSetoff(o, 'superseded', code); return {status: 'ended'}; };
    // An edge taken at a new state must still reconcile exactly with the journal (as at creation).
    const exact = (k, n, st) => { const j = this.s.edges[k]; return !!j && j.expected_total === st.total && this.exactEdge(k, n); };
    for (const [i, e] of o.edges.entries()) {
      const n = notes[i], st = edgeState(n), room = st ? st.total - Number(n.amount_redeemed ?? 0) : 0;
      if (e.server_only && perEdge) {
        if (!st || room < e.decrease) return end('insufficient');
        if (!sameState(st, e.before) && !exact(e.edge, n, st)) return end('not_reconciled');
        // After every set-off timestamp on the edge, this set-off's own earlier one included (one operation per (edge,
        // timestamp): after an apply_deferred revert its server-run parties never sign a second message there).
        const t = novationTimestamp({now: this.now(), residue: SETOFF_MS, after: Math.max(st.timestamp, this.lastSetoffTimestamp(e.edge))});
        if (t.timestamp === undefined) { this.clearing?.defer(o.id, t.ahead_ms); return {status: 'waiting'}; }
        fresh.set(e.edge, {before: st, new_total: st.total - e.decrease, timestamp: t.timestamp});
        continue;
      }
      if (sameState(st, e.before)) continue;
      if (!perEdge) return end('edge_changed');                // one timestamp for every edge: the whole proposal is stale
      if (!st || room < e.decrease) return end('insufficient');
      if (!exact(e.edge, n, st)) return end('not_reconciled');
      if (attempts.has(e.edge)) return end('payment_attempt');
      moved.push({e, st});
    }
    if (!moved.length) return {status: 'ready', fresh};
    // Each moved client edge is made again on its own: its state now and a new ts_e (waiting up to NOTE_CLOCK_WAIT_MS
    // for one, as a template does; this rare path holds the lock meanwhile).
    const next = [];
    for (const {e, st} of moved) {
      const after = () => Math.max(st.timestamp, this.lastSetoffTimestamp(e.edge));
      let t = novationTimestamp({now: this.now(), residue: SETOFF_MS, after: after()});
      if (t.timestamp === undefined && t.ahead_ms <= NOTE_CLOCK_WAIT_MS) { await pause(t.ahead_ms + 5); t = novationTimestamp({now: this.now(), residue: SETOFF_MS, after: after()}); }
      if (t.timestamp === undefined) return end('timestamp_ahead');
      let message;
      try { message = (await this.noteMessage({issuer: e.issuer.pubkey, recipient: e.recipient.pubkey, total: st.total - e.decrease, timestamp: t.timestamp})).message_hex; }
      catch (err) { if (err instanceof PilotError && err.status === 503) return {status: 'waiting'}; throw err; }
      next.push({e, st, ts: t.timestamp, message});
    }
    if (this.sweepSetoff(o).state !== 'collecting') return {status: 'waiting'};
    for (const {e, st, ts, message} of next) {
      for (const r of SETOFF_SLOTS) { const s = e.slots[r]; if (s?.signature) ((o.signature_sha256 ??= {})[e.edge] ??= {})[r] = sigSha256(s.signature); e.slots[r] = null; }
      e.before = st; e.new_total = st.total - e.decrease; e.timestamp = ts; e.revision += 1; o.messages[e.edge] = message;
    }
    const edges = next.map(x => x.e.edge);
    this.setoffEvent(o, 'regenerated', {edges});
    this.save(); this.setoffAudit(o, 'setoff.regenerated', {regenerated: edges});
    return {status: 'regenerated'};
  }
  // (b) of applySetoff: the server-run roles' signatures (pilot.serverSigner) over each edge's message (for a server-only
  // edge, over its fresh state, whose message is added to `fresh`). {edge -> {issuer?, recipient?: slot}}; 503
  // signer_unavailable when the signer fails (nothing kept). Rule R1 for the server signer: every message is rebuilt
  // here (noteMessage) from the edge's keys, its new total and its timestamp, never taken from stored hex.
  async setoffServerSignatures(o, fresh) {
    const out = {}, at = iso(this.now());
    for (const e of o.edges) {
      const f = fresh.get(e.edge);
      let msg = null;
      for (const role of SETOFF_SLOTS) {
        const q = this.s.participants[e[role].id];
        if (!this.serverRun(q) || (!f && e.slots[role]?.signature)) continue;
        if (!msg) {
          msg = (await this.noteMessage({issuer: e.issuer.pubkey, recipient: e.recipient.pubkey, total: f ? f.new_total : e.new_total, timestamp: f ? f.timestamp : e.timestamp})).message_hex;
          if (f) f.message = msg;
        }
        let sig = null;
        try { sig = await this.serverSigner.signFor(q.id, msg, {op: o.id}); } catch { sig = null; }
        if (!(await this.safeVerify(e[role].pubkey, msg, sig))) throw new PilotError('signer_unavailable', `the server could not sign for ${q.handle} just now; nothing was recorded`, 503);
        (out[e.edge] ??= {})[role] = {signature: sig, by: q.id, at, server_signed: true};
      }
    }
    return out;
  }
  readSetoffEdges(o) { return Promise.all(o.edges.map(e => this.basis.note(e.issuer.pubkey, e.recipient.pubkey))); }
  // (e) and (f): POST /notes/setoff, then every edge read back, which decides. A network error, a 5xx or a timeout
  // leaves it applying, for recovery to decide.
  async submitSetoff(o) {
    if (this.writeRefusal()) return o;              // MIG-1: nothing is sent; left applying for recovery (a backstop)
    let r = null;
    try { r = await this.basis.setoff(trackerSetoffBody(o, {perEdgeTimestamps: o.per_edge_timestamps})); } catch (e) { if (!(e instanceof BasisError)) throw e; }
    let notes;
    try { notes = await this.readSetoffEdges(o); } catch (e) { if (e instanceof BasisError) return this.setoffStillApplying(o, r); throw e; }
    return this.decideSetoff(o, notes.map(edgeState), r);
  }
  // Each edge's class (novation.mjs classifyEdge) against its state before and the state the set-off sets.
  setoffClasses(o, states) {
    return o.edges.map((e, i) => classifyEdge(states[i], e.before, {total: e.new_total, timestamp: e.timestamp, signature: e.slots.issuer?.signature ?? null}));
  }
  // The outcome from the edges as read back (`states`; `r` the tracker's answer to the submission just made, or null):
  // applied iff every edge equals (P - d, ts_e, the issuer's signature) (clearing.mjs setoffOutcome); every edge
  // untouched after a 4xx -> failed with the tracker's code; an edge changed or moved past without it -> failed
  // edge_changed; undecidable or mixed -> inconsistent (an alarm); otherwise (no answer, a 5xx) still applying.
  decideSetoff(o, states, r) {
    const classes = this.setoffClasses(o, states), out = setoffOutcome(classes);
    if (out === 'applied') return this.setoffApplied(o, states, r);
    if (out !== 'prior') o.read_back = classes;
    if (out === 'unknown' || out === 'inconsistent') return this.endSetoff(o, 'inconsistent', out === 'unknown' ? 'outcome_unknown' : 'inconsistent');
    if (out === 'not_applied') return this.endSetoff(o, 'failed', 'edge_changed');
    if (r && r.status >= 400 && r.status < 500) return this.endSetoff(o, 'failed', r.code ?? `tracker_${r.status}`, {tracker_status: r.status});
    return this.setoffStillApplying(o, r);
  }
  setoffStillApplying(o, r) {
    o.last_submission = {at: iso(this.now()), tracker_status: r?.status ?? null, tracker_code: r?.code ?? null};
    this.save(); this.setoffAudit(o, 'setoff.applying_undecided', {tracker_status: r?.status ?? null});
    return o;
  }
  // Applied: the journal entries (setoff -d on every edge: the states the set-off set), the members' expiry streaks
  // cleared, and the receipts (GET /setoffs/:vs shows each member the signatures on its edges).
  setoffApplied(o, states, r) {
    const at = iso(this.now());
    o.state = 'applied'; o.applied_at = at;
    o.result = {code: 'applied', at, ...(r ? {tracker_status: r.status} : {recovered: true})};
    o.tracker_after = Object.fromEntries(o.edges.map((e, i) => [e.edge, states[i]]));
    appendEntries(this, o.edges.map(e => ({kind: 'setoff', ref: o.id, issuer_pubkey: e.issuer.pubkey, recipient_pubkey: e.recipient.pubkey, delta: -e.decrease,
      total_after: e.new_total, timestamp: e.timestamp, signature: e.slots.issuer.signature})));
    const streaks = this.s.clearing.expiry_streaks;
    if (streaks) for (const id of o.members) delete streaks[id];
    this.setoffEvent(o, 'applied');
    this.save(); this.setoffAudit(o, 'setoff.applied', {tracker_status: r?.status ?? null});
    return o;
  }
  // A set-off ends without applying (failed, expired, refused, superseded, void_key_revoked), or is left for the operator
  // (inconsistent: the read-back could not decide; an alarm). Synchronous (the lazy sweep calls it); saves. Its slot
  // signatures are purged (sha256 kept). Cooldowns (lib/pilot/clearing.mjs): 6 h for its edge sets after an expiry or a
  // failure (refuseSetoff sets the 24 h one). An expiry counts against each member the server does not run whose
  // signatures were missing: three in a row exclude it from clearing for 24 h (a signature clears its count).
  endSetoff(o, state, code, extra = {}) {
    const now = this.now(), c = this.s.clearing;
    const late = state === 'expired' ? [...new Set(this.setoffClientSlots(o).filter(({e, role}) => !e.slots[role]?.signature).map(({e, role}) => e[role].id))] : [];
    o.state = state; o.result = {code, at: iso(now), ...extra};
    this.purgeSetoff(o);
    this.setoffEvent(o, state, {code});
    if (state === 'expired' || state === 'failed') for (const s of this.setoffEdgeSets(o)) c.cooldowns[`set:${s}`] = {until: now + COOLDOWN_FAILED_MS, reason: state, setoff: o.id};
    if (late.length) {
      const streaks = c.expiry_streaks ??= {};
      for (const id of late) if (c.signed_at) delete c.signed_at[id];   // it has not signed since (SV-DOS-1)
      for (const id of late) {
        streaks[id] = (streaks[id] ?? 0) + 1;
        if (streaks[id] >= EXPIRIES_TO_EXCLUDE) { c.cooldowns[`participant:${id}`] = {until: now + EXCLUSION_MS, reason: 'expiries_in_a_row', setoff: o.id}; delete streaks[id]; }
      }
    }
    this.save(); this.setoffAudit(o, `setoff.${state}`, {code, ...(extra.tracker_status ? {tracker_status: extra.tracker_status} : {}), ...(o.read_back ? {read_back: o.read_back} : {})});
    if (state === 'inconsistent') this.log?.(`Pilot: ALARM: set-off ${o.id} is inconsistent (${code}): reading its edges back cannot tell whether it applied; nothing is corrected (the reconciliation shows any difference)`);
    return o;
  }
  purgeSetoff(o) {
    for (const e of o.edges) for (const r of SETOFF_SLOTS) {
      const s = e.slots[r];
      if (s?.signature) { ((o.signature_sha256 ??= {})[e.edge] ??= {})[r] = sigSha256(s.signature); delete s.signature; }
    }
  }
  // Lazy expiry (design §11): a set-off still collecting past expires_at ends as expired. Called from every read that
  // shows set-offs, the engine's snapshot, the checks, recover() and the engine's tick.
  sweepSetoff(o) { if (o.state === 'collecting' && this.now() > Date.parse(o.expires_at)) this.endSetoff(o, 'expired', 'expired'); return o; }
  // Recovery (startup and every 60 s; with the lock held) of a set-off left applying: every edge at its new state ->
  // applied; every edge untouched with every ts_e within the tracker's maximum age (and the keys current) -> submitted
  // again; untouched but too old -> failed novation_expired; an edge changed or moved past without it -> failed;
  // undecidable or mixed -> inconsistent (an alarm). Untouched, it is never submitted again while a held note or a
  // payment attempt is on one of its edges (decision D-2 c, setoffPaymentBlock; applySetoff never lets one start
  // applying so, and while it applies no payment can start on its edges): failed, held_note or payment_attempt.
  async recoverSetoff(o) {
    let notes;
    try { notes = await this.readSetoffEdges(o); } catch (e) { if (e instanceof BasisError) return o; throw e; }
    const states = notes.map(edgeState);
    if (setoffOutcome(this.setoffClasses(o, states)) !== 'prior') return this.decideSetoff(o, states, null);
    if (o.edges.some(e => e.timestamp < this.now() - MAX_AGE_MS)) return this.endSetoff(o, 'failed', 'novation_expired');
    if (!this.setoffKeysCurrent(o)) return this.endSetoff(o, 'failed', 'key_revoked');
    const blocked = this.setoffPaymentBlock(o);
    if (blocked) return this.endSetoff(o, 'failed', blocked);
    return this.submitSetoff(o);
  }

  // ---------- the engine's housekeeping, metrics and diagnostics ----------
  // With the lock held (Clearing.tick): lazy expiry; records that did not apply dropped after 7 days, the signatures of
  // applied ones after 30 days (sha256 kept; design §11); collecting proposals that a held note or a payment attempt
  // keeps from ever applying superseded (decision D-2 c); cooldowns that ended; the refusal log capped.
  setoffHousekeeping() {
    const now = this.now(), c = this.s.clearing, attempts = this.paymentAttemptHolds();
    let changed = false;
    for (const [id, o] of Object.entries(this.s.setoffs || {})) {
      this.sweepSetoff(o);
      if (!LIVE_SETOFF.has(o.state) && o.state !== 'applied' && o.state !== 'inconsistent' && now - Date.parse(o.updated_at) > SETOFF_KEEP_MS) { delete this.s.setoffs[id]; changed = true; }
      else if (o.state === 'applied' && now - Date.parse(o.applied_at) > SETOFF_SIGNATURES_KEEP_MS && this.hasSignatures(o)) { this.pruneSignatures(o); changed = true; }
      // Decision D-2 c: a collecting proposal on a pair with a note held for its owner, or on an edge a live payment
      // attempt would change, is superseded (it could never apply).
      else if (o.state === 'collecting') { const why = this.setoffPaymentBlock(o, attempts); if (why) { this.endSetoff(o, 'superseded', why); changed = true; } }
    }
    for (const [k, v] of Object.entries(c.cooldowns)) if (!(Number(v?.until) > now)) { delete c.cooldowns[k]; changed = true; }
    if (c.refusals.length > CLEARING_REFUSALS_KEPT) { c.refusals.splice(0, c.refusals.length - CLEARING_REFUSALS_KEPT); changed = true; }
    if (changed) this.save();
  }
  // Complete set-offs that had to wait (a busy pair, a live transfer on an edge, a timestamp, a tracker or signer
  // outage), with the lock held: applied now where they can be. '<vs id>:<state>' each.
  async applyReadySetoffs() {
    const out = [];
    for (const o of Object.values(this.s.setoffs || {})) if (this.sweepSetoff(o).state === 'collecting' && this.setoffComplete(o)) out.push(`${o.id}:${(await this.applySetoff(o)).state}`);
    return out;
  }
  async applyReadySetoff(id) { const o = this.setoff(id); return o ? this.applySetoff(o) : null; }
  // A batch run of the engine (with the lock held), kept in s.clearing.runs (the last 20).
  recordClearingRun(run) {
    const runs = this.s.clearing.runs;
    runs.push(run);
    if (runs.length > CLEARING_RUNS_KEPT) runs.splice(0, runs.length - CLEARING_RUNS_KEPT);
    this.save();
  }
  // After the journal recorded an increase (a credit note, an incoming transfer), with the lock held: the clearing
  // engine looks for cycles through the raised edges (Clearing.afterChange; it never throws).
  async clearingAfterIncrease(keys) { if (this.clearing && this.circulating) await this.clearing.afterChange(keys); }
  // GET /clearing (public; lib/pilot/clearing.mjs metrics): aggregates only, no participant ids, handles or keys.
  async publicClearing({engine = null} = {}) {
    const ledger = await this.ledger(), snapshot = await this.clearingSnapshot({ledger});
    const issued = Object.values(this.s.deals).filter(d => d.status === 'note_issued' && d.credit_note?.recorded_at && d.agreement)
      .map(d => ({at: Date.parse(d.credit_note.recorded_at), amount: d.agreement.terms.price.amount}));
    const last = this.s.clearing.runs.at(-1);
    return clearingMetrics({now: this.now(), unit: this.unit, snapshot, graph: eligibleGraph(snapshot), setoffs: Object.values(this.s.setoffs || {}),
      transfers: Object.values(this.s.transfers || {}), issued, dormant: Object.values(snapshot.participants).filter(p => p.dormant).map(p => p.id),
      engine: engine ?? this.clearing?.engineInfo() ?? {enabled: false, interval_ms: null, limits: CLEARING_LIMITS,
        last_run: last ? {at: last.at, reason: last.reason, eligible_edges: last.eligible_edges, excluded: last.excluded} : null}});
  }
  // GET /admin/clearing (loopback admin): the engine, its recent runs, the live and recently ended set-offs (ids,
  // members, edges and which slots are signed; never a signature), the active cooldowns and the last refusals.
  clearingDiagnostics() {
    const now = this.now(), live = [], ended = [];
    for (const o of Object.values(this.s.setoffs || {})) (LIVE_SETOFF.has(this.sweepSetoff(o).state) ? live : ended).push(o);
    const brief = o => ({id: o.id, state: o.state, source: o.source, run_id: o.run_id, created_at: o.created_at, expires_at: o.expires_at, updated_at: o.updated_at,
      amount: o.amount, members: o.members, result: o.result, last_submission: o.last_submission ?? null,
      edges: o.edges.map(e => ({edge: e.edge, issuer: e.issuer.id, recipient: e.recipient.id, decrease: e.decrease, before: e.before?.total ?? null, new_total: e.new_total,
        timestamp: e.timestamp, revision: e.revision, server_only: e.server_only, signed: {issuer: !!e.slots.issuer?.signature, recipient: !!e.slots.recipient?.signature}}))});
    const c = this.s.clearing, eng = this.clearing;
    return {mode: this.mode, engine: eng ? {...eng.engineInfo(), started: eng.started, last_batch_at: eng.lastBatchAt === null ? null : iso(eng.lastBatchAt)} : null,
      runs: c.runs, live: live.map(brief), recent: ended.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 20).map(brief),
      cooldowns: Object.fromEntries(Object.entries(c.cooldowns).filter(([, v]) => Number(v?.until) > now).map(([k, v]) => [k, {...v, until: iso(v.until)}])),
      expiry_streaks: c.expiry_streaks ?? {}, refusals: c.refusals.slice(-20)};
  }

  // ---------- views for parties ----------
  // What each side sees. The counterparty never sees a version that was not offered to it (one waiting for, rejected by,
  // or ended before its proposer's owner decided), the events about it, the other owner's notes, an acceptance signature
  // that is not final yet, or a signed credit note the Basis tracker does not hold yet.
  // `gate`: what the payment routes answer about D-1 now (paymentGate), for next_actions; dealView reads it.
  view(d, p, {gate = null} = {}) {
    this.sweep(d);
    const other = d.payer === p.id ? d.payee : d.payer, seen = v => v.by === p.id || !!v.offered_at;
    const versions = d.versions.filter(seen);
    const pending = d.pending_counter && d.pending_counter.by === p.id ? d.pending_counter : null;
    const cur = this.current(d);
    const overdue = d.status === 'agreed' && this.now() > Date.parse(d.agreement.terms.deliver_by);
    const my = role => (role === 'payer' ? d.payer : d.payee) === p.id;
    // Circulating credit (modes sandbox and on; spec 14.4): the payment block, credit_note.pair_changes_since, the
    // next_actions of 10.4 and the labels of 16.1. In modes off and bound the view is v15's, byte for byte.
    const circulating = this.circulating, t = circulating ? this.paymentTransfer(d) : null;
    const price = d.agreement?.terms.price.amount, handle = id => this.s.participants[id]?.handle ?? id;
    return {
      id: d.id, status: d.status, overdue, you: p.id, your_role: my('payer') ? 'payer' : 'payee',
      counterparty: this.publicParticipant(this.s.participants[other]), next_actions: this.nextActions(d, p, gate),
      current: seen(cur) ? {version: cur.v, by: cur.by, state: cur.state, terms: cur.terms, terms_hash: cur.terms_hash, signature: cur.signature, offered_at: cur.offered_at} : null,
      pending_counter: pending && {version: pending.v, state: pending.state, terms: pending.terms, terms_hash: pending.terms_hash, signature: pending.signature, created_at: pending.created_at},
      versions: versions.map(v => ({version: v.v, by: v.by, state: v.state, terms_hash: v.terms_hash, price: v.terms.price, signature: v.signature, created_at: v.created_at, offered_at: v.offered_at})),
      acceptance: d.acceptance && {version: d.acceptance.version, by: d.acceptance.by, state: d.acceptance.state, at: d.acceptance.at,
        signature: d.acceptance.by === p.id || d.acceptance.state === 'final' ? d.acceptance.signature : null,
        held_for: this.heldFor(d)},              // while awaiting_owner: 'acceptor_owner' and/or 'proposer_owner' (F4)
      agreement: d.agreement && {version: d.agreement.version, terms_hash: d.agreement.terms_hash, formed_at: d.agreement.formed_at, proposer_signature: d.agreement.proposer_signature, acceptor_signature: d.agreement.acceptor_signature},
      // An agreed deal not delivered by then ends as expired_undelivered (OQ-8).
      delivery_grace_ends_at: d.agreement && ['agreed', 'expired_undelivered'].includes(d.status) ? iso(this.deliveryGraceEnd(d)) : null,
      decline: d.decline ?? null,
      delivery: d.delivery && {...d.delivery},
      completion: d.completion ?? null, dispute: d.dispute ?? null,
      credit_note: this.noteView(d, p),
      ...(circulating ? {payment: this.paymentView(d)} : {}),
      cancellation: d.cancellation ?? null,
      approvals: Object.values(this.s.approvals).filter(a => a.deal_id === d.id && a.participant === p.id),
      history: d.history.filter(h => !h.only || h.only === p.id).map(h => h.note !== undefined && h.by !== `owner:${p.id}` ? (({note, ...rest}) => rest)(h) : h),
      labels: {
        signed_by_parties: 'proposals, acceptances, deliveries, completions and disputes carry the acting participant\'s key signature',
        owner_approvals: 'owner approvals are recorded by the Valun server under the owner token (not key-signed); an owner\'s note is seen only by that participant\'s side',
        basis: d.status === 'note_issued' ? `credit note issued: the payer-signed Basis note is held by the pilot tracker (local, no chain); ${this.s.participants[d.payer].handle} owes ${this.s.participants[d.payee].handle} ${d.agreement.terms.price.amount} PC more`
          : circulating && d.status === 'paid_by_transfer' && t ? `${handle(t.issuer.id)} now owes ${handle(d.payee)} ${price} PC that it owed ${handle(d.payer)} before; ${handle(d.payer)} issued no credit note for this deal`
            : 'no credit note for this deal is in the Basis tracker',
        settlement: circulating ? CIRCULATION_SETTLEMENT : 'not settled: issuing a credit note creates an outstanding obligation; the pilot has no redemption, reserve or clearing, so nothing is ever settled here',
        work: 'delivery and acceptance are the parties\' statements; Valun does not judge the work',
      },
    };
  }

  // The deal view the server answers with (release v16.1; every route and every write that returns a deal): view(),
  // with next_actions judged as the payment routes judge them (paymentGate: paymentBlock with the tracker's notes, read
  // only for what decision D-1 needs) for a deal its payer may pay now, with circulating credit on. A tracker read that
  // fails leaves the view to Valun's own estimate (the payment route would fail the same way).
  async dealView(d, p) {
    this.sweep(d);
    const set = statusClass(d.status)?.actions[d.payer === p.id ? 'payer' : 'payee'] ?? null;
    const gate = this.circulating && (set === 'review' || set === 'pay')
      ? await this.paymentGate(d).catch(e => { if (e instanceof BasisError) return null; throw e; }) : null;
    return this.view(d, p, {gate});
  }
  // A deal view's next_actions (advisory; the routes decide): the action set STATUS_CLASS[status].actions names for the
  // viewer's role (lib/pilot/status.mjs). With circulation off they are v15's. With circulating credit on (modes sandbox
  // and on, spec 10.4): a payer that may pay this deal by transfer also gets pay_by_transfer; while an earlier payment
  // attempt can still apply (decision D-1) each payment it excludes is wait_for_transfer_window instead (an earlier
  // transfer attempt excludes every payment, one through the same issuer included, except a transfer through the same
  // note on the same prior state: the same-prior exemption, design v3.2 section 4); an
  // attempt whose outcome is unknown leaves nothing to do until the payer's owner resolves it, and neither does one
  // that applied (already paid); cancel_transfer only while the transfer still collects signatures.
  // Release v16.1: the D-1 part is the routes' own rule, paymentBlock (paymentGate), never an estimate of it: served deal
  // views (dealView) pass the gate read from the tracker, so after a note moved outside Valun a view never offers
  // pay_by_transfer while the route answers 409 transfer_window_open; a view made without one (view(d, p) called
  // synchronously, which no route answers with) uses the journal's estimate (paymentGateEstimate).
  nextActions(d, p, gate = null) {
    const role = d.payer === p.id ? 'payer' : 'payee', set = statusClass(d.status)?.actions[role] ?? null, own = this.current(d).by === p.id;
    switch (set) {
      case 'offer': return own ? ['withdraw', 'wait_for_counterparty'] : d.pending_counter?.by === p.id ? ['wait_for_owner_approval', 'withdraw', 'decline'] : ['accept', 'decline', 'counter'];
      // The proposer may still withdraw an offer whose acceptance waits for an owner (OQ-6): it is not binding yet.
      case 'held_acceptance': return own ? ['wait_for_owner_approval', 'withdraw'] : ['wait_for_owner_approval'];
      case 'wait_for_owner': return ['wait_for_owner_approval'];
      case 'deliver': return ['deliver'];
      case 'review': case 'pay': {
        const tail = set === 'review' ? ['dispute'] : [];
        if (!this.circulating) return ['complete', ...tail];
        const g = gate ?? this.paymentGateEstimate(d);
        // An attempt that applied, or whose outcome only the payer's owner can decide: nothing to do (every payment route
        // refuses: already_paid, attempt_outcome_unknown).
        if (g.note?.code === 'already_paid' || g.note?.code === 'attempt_outcome_unknown') return [];
        const out = [g.note ? 'wait_for_transfer_window' : 'complete'];
        // Never an action the route refuses (decision D-1): pay_by_transfer only when a transfer through some held note
        // passes paymentBlock (g.transfer null), a wait while the routes answer transfer_window_open (or edge_busy), and
        // nothing while they refuse it for good for now (pending_unbound_note: an earlier ordinary note of the payer's
        // could still be recorded; already_paid: one of them was).
        if (this.mayPayByTransfer(d)) {
          if (!g.transfer) out.push('pay_by_transfer');
          else if (g.transfer.code === 'transfer_window_open' || g.transfer.code === 'edge_busy') out.push('wait_for_transfer_window');
        }
        return [...new Set([...out, ...tail])];
      }
      case 'paying': return this.circulationFor(p) && this.paymentTransfer(d)?.state === 'collecting' ? ['wait_for_consents', 'cancel_transfer'] : ['wait_for_consents'];
      case 'wait_for_consents': return ['wait_for_consents'];
      default: return [];
    }
  }
  // Whether the payer of deal d may pay it by transfer in this mode (on, or sandbox with both parties in the sandbox)
  // under its own policy (pay_with_held_notes is not never). Which notes it could use: GET payment-options.
  mayPayByTransfer(d) {
    const B = this.s.participants[d.payer], C = this.s.participants[d.payee], m = this.mode;
    if (!(m === 'on' || (m === 'sandbox' && this.inSandbox(B) && this.inSandbox(C)))) return false;
    const pay = this.effectiveLimits(B).pay_with_held_notes;
    return !!pay && pay !== 'never';
  }
  // The deal's (latest) payment by transfer, or null.
  paymentTransfer(d) { return d.payment?.method === 'transfer' ? this.transfer(d.payment.transfer_id) : null; }
  // The deal view's payment block (circulating credit, spec 14.4, 18.12): the deal's latest payment by transfer, for
  // its payer and payee alike; never a signature (signatures_withheld says why, until the tracker records it).
  paymentView(d) {
    const t = this.paymentTransfer(d);
    if (!t) return null;
    return {method: 'transfer', state: t.state, transfer_id: t.id, issuer: {id: t.issuer.id, handle: this.s.participants[t.issuer.id]?.handle ?? null}, amount: t.amount,
      expires_at: t.expires_at, fallback_after: t.fallback_after ? iso(t.fallback_after) : null, signatures_withheld: t.state === 'applied' ? null : WITHHELD};
  }

  noteView(d, p) {
    const n = d.credit_note;
    let out;
    if (!n || d.payer === p.id || n.state === 'recorded') out = n ?? null;
    else {
      // Until the tracker records it, a payer-signed note is withheld from the payee: Basis trackers accept any validly
      // signed note, so the signature itself must not leave Valun before the payer side has released it.
      const {approval_id, note, completion, ...rest} = n;
      out = {...rest, note: note && {total: note.total, timestamp: note.timestamp, signature: null}, signature_withheld: 'shown once the Basis tracker records the note'};
    }
    // Circulating credit (spec 16.1): what later transfers and set-offs did to the claim on this note's pair.
    return out && this.circulating ? {...out, pair_changes_since: this.pairChangesSince(d)} : out;
  }
  // The edge journal's transfers and set-offs on a recorded note's pair after it was recorded: [{kind, ref, delta}] (a
  // note not recorded: []), from the journal's per-edge index (journal.mjs edgeEntries: pilot-edge-log.jsonl is read
  // once per process, never per view).
  pairChangesSince(d) {
    const n = d.credit_note;
    if (n?.state !== 'recorded' || !Number.isSafeInteger(d.journal_seq) || !n.issuer_pubkey || !n.recipient_pubkey) return [];
    const k = edgeKey(n.issuer_pubkey, n.recipient_pubkey);
    if (!this.s.edges?.[k]?.novated) return [];
    // Release v16.1: for a note recorded at or before the journal's checkpoint, what the compacted entries did on its pair
    // comes from the checkpoint, one item per kind ({kind, ref: null, delta, count, through_seq}: their sum and number),
    // then each later change as before. A note recorded after it lists every change, one by one.
    const cp = journalCheckpoint(this), early = !!cp && d.journal_seq <= cp.through_seq;
    const summary = early ? (cp.deals.get(d.id)?.changes ?? []).filter(c => PAIR_CHANGE_KINDS.has(c?.kind) && Number.isSafeInteger(c.count) && c.count > 0 && Number.isSafeInteger(c.delta))
      .map(c => ({kind: c.kind, ref: null, delta: c.delta, count: c.count, through_seq: cp.through_seq})) : [];
    return [...summary, ...edgeEntries(this, k, {afterSeq: early ? cp.through_seq : d.journal_seq}).filter(e => PAIR_CHANGE_KINDS.has(e.kind)).map(e => ({kind: e.kind, ref: e.ref, delta: e.delta}))];
  }

  // ---------- owner approvals: exactly what is being approved ----------
  approvalSubject(a, d) {
    const keyOf = (v, id) => v.terms[d.payer === id ? 'payer' : 'payee'].pubkey;
    if (a.kind === 'propose') {
      const v = d.pending_counter?.approval_id === a.id ? d.pending_counter
        : d.versions.find(x => x.approval_id === a.id) ?? (d.superseded_counters || []).find(x => x.approval_id === a.id);
      if (!v) return null;
      const prev = v.v > 1 ? d.versions.find(x => x.terms_hash === v.terms.prior_terms_hash) : null;
      return {what: v.v === 1 ? 'new_proposal' : 'counter_offer', version: v.v, terms: v.terms, terms_hash: v.terms_hash,
        signer: v.by, signer_pubkey: keyOf(v, v.by), statement: statements.propose(v.terms_hash), signature: v.signature, signed_at: v.created_at,
        mandate_check: v.mandate_check ?? null,
        countered: prev && {version: prev.v, by: prev.by, terms: prev.terms, terms_hash: prev.terms_hash, signature: prev.signature}};
    }
    if (a.kind === 'accept') {
      const acc = d.acceptance?.approval_id === a.id ? d.acceptance : (d.rejected_acceptances || []).find(x => x.approval_id === a.id);
      const v = d.versions.find(x => x.v === a.version && x.terms_hash === a.terms_hash);
      if (!acc || !v) return null;
      return {what: 'acceptance', version: v.v, terms: v.terms, terms_hash: v.terms_hash, offered_by: v.by, offer_signature: v.signature,
        signer: acc.by, signer_pubkey: keyOf(v, acc.by), statement: statements.accept(v.terms_hash), signature: acc.signature, signed_at: acc.at,
        mandate_check: acc.mandate_check ?? null};
    }
    if (a.kind === 'confirm_offer') {
      // The owner's own agent's offer, accepted by the other side. The acceptor's signature is not handed over until the
      // acceptance is final.
      const acc = d.acceptance?.proposer_approval_id === a.id ? d.acceptance : (d.rejected_acceptances || []).find(x => x.proposer_approval_id === a.id);
      const v = d.versions.find(x => x.v === a.version && x.terms_hash === a.terms_hash);
      if (!acc || !v) return null;
      return {what: 'accepted_offer', version: v.v, terms: v.terms, terms_hash: v.terms_hash,
        signer: v.by, signer_pubkey: keyOf(v, v.by), statement: statements.propose(v.terms_hash), signature: v.signature, signed_at: v.created_at,
        mandate_check: acc.proposer_mandate_check ?? null, accepted_by: acc.by, accepted_at: acc.at, acceptance_state: acc.state,
        acceptor_owner_must_approve: !!acc.approval_id && !acc.owner_approval,
        why: 'your agent made this offer when its price was within your approve_above; you have lowered approve_above since, so the accepted offer waits for you'};
    }
    const delivery = () => d.delivery && {by: d.delivery.by, title: d.delivery.title, content: d.delivery.content, sha256: d.delivery.sha256, bytes: d.delivery.bytes, at: d.delivery.at, late: d.delivery.late};
    if (a.kind === 'pay_by_transfer') {
      // The payment the payer's agent signed (spec 18.11): the pay statement over the deal and its quote digest, the
      // transfer it describes (both of the payer's edges as the tracker held them, signed by their issuer) and the
      // completion it signed with it. No slot signature: the agent's own are withheld like every other until the
      // tracker records the transfer.
      const t = this.transfersOf(d).find(x => x.approval_id === a.id);
      if (!t || !d.agreement) return null;
      const who = x => ({id: x.id, handle: this.s.participants[x.id]?.handle ?? null, pubkey: x.pubkey});
      const edge = (e, recipient) => ({edge: e.edge, issuer: who(t.issuer), recipient: who(recipient), before: e.before, new_total: e.new_total, change: e.new_total - (e.before?.total ?? 0)});
      const dh = d.completion?.deliverable_sha256 ?? d.delivery?.sha256;
      return {what: 'payment_by_transfer', version: d.agreement.version, terms: d.agreement.terms, terms_hash: d.agreement.terms_hash,
        signer: t.payer.id, signer_pubkey: t.payer.pubkey, statement: circulationStatements.pay(d.id, t.quote_digest), signature: t.pay_signature ?? null,
        signed_at: t.created_at, mandate_check: null, delivery: delivery(),
        transfer: {id: t.id, state: t.state, issuer: who(t.issuer), payer: who(t.payer), payee: who(t.payee), amount: t.amount,
          from_edge: edge(t.from_edge, t.payer), to_edge: edge(t.to_edge, t.payee), timestamp: t.timestamp, quote_digest: t.quote_digest, expires_at: t.expires_at},
        completion: {statement: statements.complete(d.agreement.terms_hash, dh), signature: t.completion_signature ?? null}};
    }
    const n = d.credit_note?.approval_id === a.id ? d.credit_note : [...(d.rejected_notes || []), ...(d.void_notes || [])].find(x => x.approval_id === a.id);
    if (!n || !d.agreement) return null;
    const c = n.completion ?? d.completion ?? {};
    // A bound note (circulating credit, spec 18.5) also shows its prior acknowledgment: the payer's signature over the
    // pair's total before it (prior_total) at the note's timestamp. An ordinary note's subject is as in v15.
    const bound = n.note?.prior_signature ? {bound: true, prior_signature: n.note.prior_signature, expires_at: iso(n.note.timestamp + MAX_AGE_MS)} : {};
    return {what: 'credit_note', version: d.agreement.version, terms: d.agreement.terms, terms_hash: d.agreement.terms_hash,
      signer: d.payer, signer_pubkey: n.issuer_pubkey ?? d.agreement.terms.payer.pubkey,
      statement: statements.complete(d.agreement.terms_hash, c.deliverable_sha256 ?? d.delivery?.sha256), signature: c.signature ?? null, signed_at: n.signed_at,
      mandate_check: null,
      delivery: delivery(),
      credit_note: {issuer_pubkey: n.issuer_pubkey ?? d.agreement.terms.payer.pubkey, recipient_pubkey: n.recipient_pubkey ?? d.agreement.terms.payee.pubkey,
        keys_as_agreed: n.keys_as_agreed ?? true, amount: n.amount, prior_total: n.prior_total, total: n.note.total, timestamp: n.note.timestamp,
        message_hex: n.note.message_hex, signature: n.note.signature, signed_at: n.signed_at, ...bound}};
  }

  approvalEffect(a, d, s) {
    if (!s) return null;
    const h = id => this.s.participants[id]?.handle ?? id, me = a.participant, other = h(d.payer === me ? d.payee : d.payer), price = s.terms.price.amount;
    const recheck = 'When you approve, the server first checks again: your mandate\'s hard limits (with your other commitments), that both parties still have the keys named in the terms, and that the offer has not expired.';
    if (a.kind === 'propose' && s.version === 1) return {
      if_approved: `${other} can see this offer and accept, counter or decline it until ${s.terms.offer_expires_at}. If ${other} accepts it, the deal is agreed without asking you again.`,
      if_rejected: `Nothing is offered and the deal ends. ${other} never sees it.`, checks_on_approve: recheck};
    if (a.kind === 'propose') return {
      if_approved: `This counter-offer replaces ${other}'s offer (version ${s.version - 1}). If ${other} accepts it, the deal is agreed without asking you again.`,
      if_rejected: `Nothing is offered. ${other}'s offer stays open and ${other} never sees this counter-offer; your agent may answer it again.`, checks_on_approve: recheck};
    const binding = `binding on both sides: ${h(d.payee)} delivers by ${s.terms.deliver_by}; when ${h(d.payer)} accepts the delivery, it issues a credit note for ${price} PC (an outstanding obligation; nothing is settled).`;
    if (a.kind === 'accept') {
      const proposerToo = d.acceptance?.approval_id === a.id && d.acceptance.proposer_approval_id && !d.versions.find(x => x.v === d.acceptance.version)?.owner_approval;
      return {
        if_approved: proposerToo ? `The deal is agreed once ${other}'s owner also confirms ${other}'s offer (it is above ${other}'s current threshold); it is then ${binding}`
          : `The deal is agreed and ${binding}`,
        if_rejected: `Your agent's acceptance does not take effect. The offer stays open until it expires and your agent may act on it again; ${other} sees that the acceptance was not approved.`,
        checks_on_approve: `${recheck} The offer must also still be within ${other}'s mandate.`};
    }
    if (a.kind === 'confirm_offer') return {
      if_approved: s.acceptor_owner_must_approve ? `The deal is agreed once ${other}'s owner also approves ${other}'s acceptance; it is then ${binding}`
        : `The deal is agreed and ${binding}`,
      if_rejected: `Your agent's offer is withdrawn and ${other}'s acceptance is void. Nothing is agreed; ${other} sees that the offer was withdrawn.`,
      checks_on_approve: `${recheck} ${other}'s acceptance must also still be within ${other}'s mandate.`};
    // A payment by debt transfer held for the payer's owner (spec 18.11); a deal whose acceptance already stood
    // (payment_due) returns there on a rejection, and owes the payment still.
    if (a.kind === 'pay_by_transfer') {
      const tr = s.transfer, A = tr.issuer.handle ?? tr.issuer.id, C = tr.payee.handle ?? tr.payee.id, amt = tr.amount;
      // Decision D-1: the payer signed this payment's slots, so the tracker could still apply it until one hour after its
      // timestamp; every other payment waits until fallback_after, one through the same note too unless it acknowledges
      // the same prior state of it (the same-prior exemption of tracker v3.2).
      const wait = `only after ${iso(fallbackAfter(tr.timestamp))}, with its own credit note or any note it holds (${A}'s included), since the tracker could still apply this payment until one hour after its timestamp; through ${A}'s note at once, but only while ${A}'s note to you is exactly as this payment found it (the tracker applies at most one of the two)`;
      return {
        if_approved: `The transfer is submitted once ${A} and ${C} sign: ${A} then owes ${C} ${amt} PC more and you ${amt} PC less; you issue no credit note.`,
        if_rejected: d.payment_due_since ? `Nothing moves. The deal returns to payment_due: the delivery stays accepted, and your agent must still pay it (${wait}).`
          : `Nothing moves. The deal returns to delivered: your agent may accept again (paying ${wait}) or dispute.`,
        checks_on_approve: `When you approve, the server first checks again that ${A}'s notes to you and to ${C} on the tracker (their totals, timestamps and signatures) are unchanged since your agent signed, that all three parties still have the keys named in the transfer, and that the payment still passes every check it passed when your agent made it (your agent's limits for paying with notes it holds, that ${C} still accepts ${A}'s notes, that ${A} may still move its debt to ${C}, and that no other payment of this deal could still apply); if not, the approval becomes void and your agent must pay again.`};
    }
    // With circulation on, the texts say what the server checks (the pair's whole last note, SV-1) and, for a deal whose
    // acceptance already stood (payment_due), where a rejection leaves it. A bound note also says until when the tracker
    // takes it (decision D-1 item 4).
    const bound = s.credit_note.bound ? ` It is a bound note: the tracker records it only while the pair's note is still the one it acknowledges (total ${s.credit_note.prior_total} PC, the state it was signed on), and only until ${s.credit_note.expires_at} (one hour after its timestamp); after that it fails and your agent signs a new one.` : '';
    // Circulating credit (decision D-1): a rejected bound note stays usable at the tracker until one hour after its
    // timestamp, so a payment by transfer waits until then (paymentBlock).
    const waitTransfer = this.circulating && s.credit_note.bound ? ` A payment by transfer can start only after ${iso(fallbackAfter(s.credit_note.timestamp))}: the tracker could still record this note until one hour after its timestamp.` : '';
    return {
      if_approved: `The signed credit note goes to the Basis tracker: ${h(d.payer)} then owes ${h(d.payee)} ${price} PC more (the running total for this key pair becomes ${s.credit_note.total} PC). It is an outstanding obligation; nothing is settled.${bound}`,
      if_rejected: (d.payment_due_since ? 'Nothing reaches the tracker. The deal returns to "payment_due": the delivery stays accepted, and your agent must still pay it (with a new credit note, or by transfer).'
        : 'Nothing reaches the tracker. The deal returns to "delivered": your agent may accept the delivery again (signing a new note) or dispute it.') + waitTransfer,
      checks_on_approve: this.circulating
        ? "When you approve, the server first checks that the pair's last credit note on the tracker (its total, timestamp and signature) and both parties' keys are unchanged since your agent signed; if not, the approval becomes void and your agent must sign a new note."
        : "When you approve, the server first checks that the pair's tracker total and both parties' keys are unchanged since your agent signed; if not, the approval becomes void and your agent must sign a new note."};
  }

  approvalView(a, p, {deal = null} = {}) {
    const d = this.sweep(this.deal(a.deal_id)), subject = this.approvalSubject(a, d);
    return {...a, subject, mandate_check: subject?.mandate_check ?? null, effect: this.approvalEffect(a, d, subject), deal: deal ?? this.view(d, p)};
  }
  // The approval view the server answers with (GET /owner): its deal as dealView makes it.
  async servedApprovalView(a, p) { return this.approvalView(a, p, {deal: await this.dealView(this.deal(a.deal_id), p)}); }

  inbox(p) {
    const deals = this.dealsFor(p).map(d => this.sweep(d));
    const brief = d => { const c = this.current(d); return {deal_id: d.id, status: d.status, counterparty: this.s.participants[d.payer === p.id ? d.payee : d.payer].handle,
      your_role: d.payer === p.id ? 'payer' : 'payee', title: c.terms.service.title, price: c.terms.price, version: c.v, offer_expires_at: c.terms.offer_expires_at, deliver_by: c.terms.deliver_by}; };
    const cur = d => this.current(d), other = d => d.payer === p.id ? d.payee : d.payer;
    const pendingFor = (d, id) => Object.values(this.s.approvals).some(a => a.deal_id === d.id && a.participant === id && a.state === 'pending');
    // Each deal is listed in at most one section: STATUS_CLASS[status].payer_inbox / payee_inbox (lib/pilot/status.mjs).
    const sections = deals.map(d => [inboxSection(d.status, d.payer === p.id ? 'payer' : 'payee',
      {ownOffer: () => cur(d).by === p.id, counterpartyOwnerPending: () => pendingFor(d, other(d))}), d]);
    const listed = s => sections.filter(([x]) => x === s).map(([, d]) => d);
    const box = {
      respond: listed('respond').map(brief),
      deliver: listed('deliver').map(brief),
      review_delivery: listed('review_delivery').map(brief),
      awaiting_your_owner: Object.values(this.s.approvals).filter(a => a.participant === p.id && a.state === 'pending').map(a => {
        const s = this.approvalSubject(a, this.deal(a.deal_id));
        return {approval_id: a.id, deal_id: a.deal_id, kind: a.kind, version: a.version, terms_hash: a.terms_hash, title: s?.terms.service.title ?? null, price: s?.terms.price ?? null};
      }),
      waiting_on_others: listed('waiting_on_others').map(brief),
      recent_closed: listed('recent_closed').slice(-10).map(brief),
    };
    if (!this.circulating) return box;
    // Circulating credit (modes sandbox and on; spec 18.14): how many consent items wait for this participant's client
    // (GET /consents), and the deals whose payment by transfer is under way (waiting for the payer's owner, collecting,
    // being applied, or of an outcome only the owner can resolve) with their payment block. Consents are not deals: they
    // never go into the deal lists above.
    const inProgress = deals.filter(d => { const t = this.paymentTransfer(d); return !!t && (LIVE_TRANSFER.has(t.state) || UNRESOLVED_TRANSFER.has(t.state)); });
    return {...box, consents_waiting_for_your_client: this.pendingOf(p).consents_waiting_for_you,
      payments_in_progress: inProgress.map(d => ({...brief(d), payment: this.paymentView(d)}))};
  }

  // ---------- circulating credit: what /me, /owner and the participant's own position add (modes sandbox and on) ----------
  // The owner's credit policy (design §8, spec 18.13): the circulation fields of the mandate, and each phase-2 field the
  // mandate holds (one it does not hold has its default: lib/pilot/policy.mjs), or whose default the server enforces for
  // p without the mandate holding it (a sandbox_only participant's max_claims_total 40: impliedPhase2).
  creditPolicy(p) {
    const implied = impliedPhase2(p, p.mandate);
    return {...Object.fromEntries(CIRCULATION_MANDATE_FIELDS.map(k => [k, p.mandate?.[k] ?? null])),
      ...Object.fromEntries(PHASE2_FIELDS.filter(k => p.mandate?.[k] !== undefined || k in implied).map(k => [k, p.mandate?.[k] !== undefined ? p.mandate[k] : implied[k]]))};
  }
  // The features this server offers (as GET /info lists them) and the consent roles it counts for p's client (from its
  // X-Valun-Features header, for 7 days after it was sent; a server-run participant signs every role). After an empty
  // declaration ('consents/1;roles=', decision D-3 b) no role counts and nothing counts until a time: null.
  featuresOf(p) {
    const f = p.client_features, roles = this.serverRun(p) ? ['setoff', 'issuer', 'creditor'] : f?.consents && this.now() - Date.parse(f.at) <= CONSENT_ROLE_MS ? f.roles : [];
    return {server: featuresFor(this.mode), consent_roles: roles, server_run: this.serverRun(p),
      consents_declared_at: f?.at ?? null, consents_count_until: f?.at && f.roles?.length ? iso(Date.parse(f.at) + CONSENT_ROLE_MS) : null};
  }
  // The notes p holds on its current key (claims it could pay with): per issuer, the outstanding total, what live
  // transfers reserve of it, what can be spent now (spendableNote) and how soon the issuer signs its consent.
  spendableNotes(p, ledger) {
    if (!p.pubkey || p.status !== 'active') return [];
    const out = [];
    for (const l of ledger) {
      if (l.recipient_pubkey !== p.pubkey || !(l.outstanding > 0)) continue;
      const A = this.byPubkey(l.issuer_pubkey);
      if (!A || A.id === p.id) continue;
      out.push({issuer_id: A.id, issuer_handle: A.handle, issuer_pubkey: l.issuer_pubkey, outstanding: l.outstanding, reserved: this.transferReserved(edgeKey(l.issuer_pubkey, l.recipient_pubkey)),
        spendable: this.spendableNote(p, A, TRACKER_NOTE.get(l)), issuer_consents: this.consentSpeed(A, 'issuer')});
    }
    return out;
  }
  // Counts of the payments by transfer p takes part in that are under way: those it pays (waiting for its owner,
  // collecting or being applied); those collecting signatures in which p still has a slot to sign (the consent items
  // waiting for its client, GET /consents); and those collecting only other parties' signatures. Set-offs collecting
  // signatures count in the last two the same way (a member the server runs never waits: the server signs for it).
  pendingOf(p) {
    const mine = Object.values(this.s.transfers || {}).map(t => this.sweepTransfer(t)).filter(t => this.transferRoles(t, p).length);
    const waitsForMe = t => { const role = this.consentRole(t, p); return !!role && this.slotsOf(t, role).some(s => !t.slots[s.name]?.signature); };
    const setoffs = Object.values(this.s.setoffs || {}).filter(o => o.members.includes(p.id)).map(o => this.sweepSetoff(o)).filter(o => o.state === 'collecting');
    const setoffsForMe = setoffs.filter(o => this.setoffUnsigned(o, p).length).length;
    return {paying_by_transfer: mine.filter(t => t.payer.id === p.id && LIVE_TRANSFER.has(t.state)).length,
      consents_waiting_for_you: mine.filter(t => t.state === 'collecting' && waitsForMe(t)).length + setoffsForMe,
      consents_waiting_for_others: mine.filter(t => t.state === 'collecting' && !waitsForMe(t)).length + setoffs.length - setoffsForMe};
  }
}
