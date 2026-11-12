// The nine Valun agent tools, independent of any agent framework (port of python/src/valun/agent.py).
//
// An adapter supplies a Client (whose store holds the participant's key, token and non-secret state), a few settings and
// a sentence saying where approvals happen; this module does the protocol work: it builds and verifies what is signed
// (through the Client), measures deliveries against the agreed terms, and explains results in plain words. Results,
// error payloads and approval texts are the Python reference's, word for word (test/agent-parity.test.js replays
// scenarios recorded from the Python code). Every tool result is a plain JSON-compatible object.
//
// Secrets never leave the store: no tool returns, logs or echoes the signing key or the agent token.
// Approvals fail closed, as in the Python core. isCommitment() treats every tool name it does not know as a commitment,
// and prepare() returns the arguments to sign with and the owner's approval text from one snapshot of what would be
// signed. The text is built only from values checked against what is signed (recomputed hashes, which the arguments then
// pin); when the snapshot cannot be read or does not hold together it rejects with approval_unbound, and every adapter
// then refuses the call instead of asking with a generic text.
//
// Circulating credit (0.4; only where the server's GET /info lists circulation/1): valun_review_delivery can pay with a
// note the agent holds (pay_with, a commitment the owner approves with its own text), valun_deliver can deliver the exact
// result of a text-stats or notary job (exact_result), valun_status, valun_deal and valun_inbox show what can be spent,
// what is being paid and what the client clears, and the client signs the consents its owner's policy allows by itself
// (processConsents(), at most once per CONSENTS_EVERY_MS, before every tool call that is not read-only; with
// consentsOnReads, an adapter without a consent loop also signs the value-safe ones, set-offs and payments to it by
// transfer, before valun_status and valun_inbox: decision D-3 a). Tool calls and consent runs of one agent hold its lock
// (exclusive(), as the Python MCP server's STORE_LOCK) so that no two of them interleave, and every use of the client is
// a client of its own (Client.fresh(), as the Python agent makes a new Client for each).

import {verifyHex} from './basis.js';
import {VALUE_SAFE_HEADER_ROLES, consentRoles} from './client.js';
import {ValunError} from './errors.js';
import {measure} from './measure.js';
import * as nv from './novation.js';
import {UNIT, sha256Hex, termsHash} from './protocol.js';
import {utf8} from './bytes.js';
import * as sandbox from './sandbox.js';
import {checkDelivery, extractText} from './sandbox.js';
import * as schemas from './schemas.js';
import {
  PyError, cpLength, cpSlice, dictCopy, get, int, isDict, isoAwareMs, item, items, iterate, lower, or, pyEq, repr, str, strip, truthy,
  typeName,
} from './py.js';

export const SETTLEMENT_NOTE = 'Issuing a credit note creates an outstanding obligation (the payer owes the payee that many PC). '
  + 'Nothing is settled in the Valun pilot: there is no redemption, reserve or clearing yet.';
export const NOT_SETTLED = 'A credit note is an outstanding promise to pay, not a payment: nothing is settled in the pilot. '
  + 'PC are synthetic units with no monetary value.';
export const HONEST_LABELS = Object.freeze({
  what_basis_records: 'When a payer accepts a delivery, its agent signs a Basis note and the pilot Basis tracker '
    + 'records it: the payer key, the payee key, the running total that payer owes that payee '
    + '(one cumulative total per key pair) and a timestamp. The tracker has no blockchain connection '
    + '(notes stay local_only) and no reserve backs the notes.',
  outstanding_promise: 'An issued credit note is an outstanding promise by the payer to pay that many PC. Nothing in '
    + 'the pilot settles it: there is no redemption, reserve, clearing or netting. PC are synthetic '
    + 'pilot units with no monetary value.',
  third_party: 'Supported: paying a third party with your OWN credit note; the third party may require that your '
    + 'claims on the tracker cover it (min_payer_coverage_pct). Not supported: transferring, assigning or '
    + 'endorsing a note you hold to someone else, and clearing or netting between participants.',
});
export const REAL_VS_SIMULATED = Object.freeze({
  real: "signatures by each participant's own key; Valun's acceptance and approval records; credit notes held by a "
    + 'real Basis tracker (read back and reconciled by Valun)',
  simulated: 'PC (pilot credits) have no monetary value; the Basis tracker has no blockchain connection (notes are '
    + 'local_only, never on-chain); settlement does not exist in the pilot',
  not_proven: 'that delivered work is good (Valun records statements, it does not judge work); that any participant '
    + 'will ever honour a credit note',
});
// The same labels where the server offers circulating credit (GET /info lists circulation/1): word for word the server's
// deal label (PROTOCOL.md 16.1, design 4.12), and nothing that says notes cannot move or be cleared.
export const CIRCULATION_SETTLEMENT = 'not settled: a credit note is an outstanding obligation. With circulating credit it can move to a '
  + 'new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an '
  + 'equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is '
  + 'redeemed, there is no reserve, and PC have no value.';
export const SETTLEMENT_NOTE_CIRCULATION = CIRCULATION_SETTLEMENT;
export const NOT_SETTLED_CIRCULATION = CIRCULATION_SETTLEMENT;
export const HONEST_LABELS_CIRCULATION = Object.freeze({
  what_basis_records: 'The pilot Basis tracker keeps one running total per key pair: what the issuer key owes the '
    + 'recipient key, with a timestamp, signed by the issuer. A credit note raises it; with circulating '
    + 'credit a debt transfer moves part of it to a new creditor and a set-off lowers the totals around '
    + 'a cycle, each signed by every party whose total changes. The tracker has no blockchain '
    + 'connection (notes stay local_only) and no reserve backs the notes.',
  outstanding_promise: CIRCULATION_SETTLEMENT,
  third_party: "Supported: paying a third party with your OWN credit note, or with a note you hold (pay_with: the "
    + "issuer's debt to you moves to the payee; the issuer, you and the payee each sign, and the issuer's "
    + 'total debt does not change), and set-offs that cancel equal debts around a cycle (every party signs; '
    + 'no net position changes). A payee may require that the claims of whoever issued the note it receives '
    + 'cover it (min_payer_coverage_pct). Not supported: redeeming a note for anything outside the pilot.',
});
export const REAL_VS_SIMULATED_CIRCULATION = Object.freeze({
  real: "signatures by each participant's own key; Valun's acceptance and approval records; credit notes, debt "
    + 'transfers and set-offs held by a real Basis tracker (read back and reconciled by Valun, and checked by your '
    + 'client against the signatures)',
  simulated: 'PC (pilot credits) have no monetary value; the Basis tracker has no blockchain connection (notes are '
    + 'local_only, never on-chain); nothing is redeemed and there is no reserve: a set-off only cancels equal '
    + 'opposite obligations',
  not_proven: REAL_VS_SIMULATED.not_proven,
});
export const CIRCULATION = 'circulation/1';
/** processConsents() runs at most this often (state consents_last_run_ms; design 6.6). */
export const CONSENTS_EVERY_MS = 60_000;
// The local consent policy a join writes (design 6.6, 8): an invited participant's client signs set-offs and transfers of
// its own debt by itself, not payments to it by transfer (opt-in); a sandbox participant's client signs all three. The
// owner's mandate still has to allow each role (the stricter of the two applies), and max_PC caps one consent.
export const INVITE_CONSENT_POLICY = Object.freeze({setoff: true, as_issuer: true, as_new_creditor: false, max_PC: 50});
export const SANDBOX_CONSENT_POLICY = Object.freeze({setoff: true, as_issuer: true, as_new_creditor: true, max_PC: 50});
export const CONSENT_POLICY_KEYS = Object.freeze(['setoff', 'as_issuer', 'as_new_creditor', 'max_PC']);
/** Where the payer may pay from: the deal statuses GET /deals/{id}/payment-options serves (PROTOCOL.md 18.6 step 1). */
export const PAYABLE = Object.freeze(['delivered', 'note_failed', 'payment_due']);
/** How fast an issuer signs a transfer of its debt (payment options issuer_consents), in an approval text. */
export const CONSENT_SPEED_WORDS = Object.freeze({immediate: 'immediately', auto: 'automatically',
  when_online: 'when its agent is next online', unavailable: 'not at the moment (unavailable)'});
/** prepare() failures that keep their own code and setup hint instead of approval_unbound (still nothing is signed). */
export const UNBOUND_PASS_THROUGH = Object.freeze(['not_connected', 'not_configured', 'tracker_mismatch']);
// The server's sandbox agents (PROTOCOL.md 18.15) and the five-step tour a sandbox_only participant can take with them.
export const SANDBOX_EXACT = 'sandbox-exact';
export const SANDBOX_MALLORY = 'sandbox-mallory';
export const SANDBOX_AGENTS = Object.freeze([SANDBOX_EXACT, SANDBOX_MALLORY]);
export const TOUR_GOALS = Object.freeze({
  1: 'Earn: sandbox-exact buys text-stats from you (the welcome job, 3 PC). Deliver the exact result; it pays with its '
    + 'own credit note.',
  2: 'Spend a note you hold: buy notary from sandbox-mallory (2 PC) and pay with pay_with="sandbox-exact" (2 PC of '
    + "sandbox-exact's debt to you move to sandbox-mallory). Dispute a wrong delivery and buy again.",
  3: 'Pay with your own note: buy notary from sandbox-exact (2 PC). Then the 2-cycle you -> sandbox-exact -> you (1 PC) '
    + 'is cleared by a set-off your Valun client signs by itself.',
  4: 'Sell: offer text-stats to sandbox-mallory (3 PC). It pays with its own note, and the 3-cycle sandbox-mallory -> '
    + 'you -> sandbox-exact -> sandbox-mallory (1 PC) clears.',
  5: 'Spend again: buy notary from sandbox-exact (2 PC) and pay with pay_with="sandbox-mallory". Then the server-only '
    + 'cycle between sandbox-exact and sandbox-mallory clears.',
});
export const TOUR_TEXTS = Object.freeze({1: 'Valun sandbox tour, step 1: my first paid job.',
  2: 'Valun sandbox tour, step 2: paid with a note I hold.',
  3: 'Valun sandbox tour, step 3: paid with my own note.',
  4: 'Valun sandbox tour, step 4: I sell my work.',
  5: 'Valun sandbox tour, step 5: paid with a note I hold again.'});
/** What you hold / owe (PC) once each step is done, as tracker totals (design 9.2). */
export const TOUR_AFTER = Object.freeze({1: Object.freeze([3, 0]), 2: Object.freeze([1, 0]), 3: Object.freeze([0, 1]),
  4: Object.freeze([2, 0]), 5: Object.freeze([0, 0])});

/** The honest labels for a server with circulating credit (true) or without it: {settlement, not_settled, honest_labels, real_vs_simulated}. */
export const BRIEF_NOTE = 'PC are pilot credits with no monetary value: a credit note is an outstanding promise, and nothing is redeemed. '
  + 'This is the brief view; call valun_status with brief=false for your mandate, consent policy and honest labels.';

/**
 * valun_status's brief view (brief=true, for small models), made from the full view, so it reads and signs exactly the
 * same: who you are, your owner's objective and goals, the limits in force, where approvals happen, what you hold and
 * owe, the notes you can spend, the payments and consents in progress, the next sandbox step, and one line on what PC
 * are (the honest labels stay in the full view). The same as the Python core's brief_status.
 */
export function briefStatus(out) {
  const d = v => (isDict(v) ? v : {});
  const you = d(get(out, 'you')), pos = d(get(out, 'position'));
  const b = {brief: true, connected: get(out, 'connected'),
    you: Object.fromEntries(['id', 'handle', 'sandbox_expires_at'].filter(k => get(you, k) !== null).map(k => [k, you[k]])),
    objective_from_your_owner: get(out, 'objective_from_your_owner'), goals_your_owner_told_you: get(out, 'goals_your_owner_told_you'),
    limits_in_force: get(out, 'limits_in_force'), approvals: get(out, 'approvals'),
    you_hold_PC: get(pos, 'claims_held'), you_owe_PC: get(pos, 'owes'), net_PC: get(pos, 'net')};
  if ('notes_you_can_spend' in out) {
    b.notes_you_can_spend = (get(out, 'notes_you_can_spend') || []).filter(isDict)
      .map(n => Object.fromEntries(['issuer', 'amount_PC', 'checked_by_your_client'].map(k => [k, get(n, k)])));
    b.payments_in_progress = (get(out, 'payments_in_progress') || []).length;
    b.consents_pending = get(d(get(out, 'clearing')), 'consents_pending');
  }
  const step = get(out, 'sandbox_next_steps');
  if (isDict(step)) b.sandbox_next_steps = Object.fromEntries(['tour_step', 'next_calls', 'then'].filter(k => k in step).map(k => [k, step[k]]));
  b.note = BRIEF_NOTE;
  return b;
}

export function labels(circulating) {
  if (circulating) {
    return {settlement: SETTLEMENT_NOTE_CIRCULATION, not_settled: NOT_SETTLED_CIRCULATION, honest_labels: HONEST_LABELS_CIRCULATION,
      real_vs_simulated: REAL_VS_SIMULATED_CIRCULATION};
  }
  return {settlement: SETTLEMENT_NOTE, not_settled: NOT_SETTLED, honest_labels: HONEST_LABELS, real_vs_simulated: REAL_VS_SIMULATED};
}

/** The feature tags a GET /info answer lists ([] for a v15 server or circulation off; malformed: ['?']). */
export function featuresOf(info) {
  const raw = isDict(info) ? get(info, 'features') : null;
  if (raw === null) return [];
  return Array.isArray(raw) && raw.every(f => typeof f === 'string') ? [...raw] : ['?'];
}

/**
 * What a Valun client signs by itself, per consent role: the stricter of the local consent policy (the profile's
 * consent_policy) and the owner's mandate as GET /me shows it (rule R8 of PROTOCOL.md 15.3). Booleans per role, the
 * local per-consent cap, and both sides as they are.
 */
export function consentPolicyInForce(local, mandate) {
  const p = isDict(local) ? local : {};
  const m = isDict(mandate) ? mandate : {};
  return {
    setoff: get(p, 'setoff') === true && get(m, 'auto_clear') === true,
    as_issuer: get(p, 'as_issuer') === true && get(m, 'novate_own_debt') === true,
    as_new_creditor: get(p, 'as_new_creditor') === true && get(m, 'accept_transfers') === true && get(m, 'may_accept_credit') !== false,
    max_PC: get(p, 'max_PC'),
    local_policy: Object.fromEntries(['setoff', 'as_issuer', 'as_new_creditor', 'max_PC', 'accept_issuers', 'refuse_issuers']
      .filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]])),
    owner_mandate: Object.fromEntries(['auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from', 'refuse_notes_from',
      'pay_with_held_notes', 'max_accept_per_issuer'].map(k => [k, get(m, k)])),
    how_to_change: 'your owner changes the local policy with `valun config consents.setoff|consents.as_issuer|'
      + 'consents.as_new_creditor on|off` and `valun config consents.max_PC N`, and the mandate in '
      + 'the owner console; the stricter of the two applies',
  };
}

/** consentPolicyInForce() as sentences: what the client signs by itself, without asking the owner. */
export function clientSigns(policy) {
  const cap = get(policy, 'max_PC');
  const upto = whole(cap) ? `, up to ${cap} PC each` : '';
  const out = [];
  if (truthy(get(policy, 'setoff'))) {
    out.push(`set-offs that cancel equal claims and debts of yours around a cycle (your net position does not change)${upto}`);
  }
  if (truthy(get(policy, 'as_issuer'))) out.push(`debt transfers that move your own debt to a new creditor (your total owed does not change)${upto}`);
  if (truthy(get(policy, 'as_new_creditor'))) out.push(`payments to you by debt transfer, of notes from issuers your owner accepts${upto}`);
  return out;
}

/**
 * Does this profile take part in consents at all? It has a consent policy, or it has paid by transfer (a regenerated
 * transfer needs its signature again). A 0.3 profile has neither, so it is served exactly as by 0.3 (no consent request).
 */
export function wantsConsents(state) {
  if (!isDict(state)) return false;
  return isDict(get(state, 'consent_policy')) || truthy(get(state, 'approved_payments')) || truthy(get(state, 'transfer_attempts'));
}

/**
 * Client.processConsents() for a profile that takes part in consents (wantsConsents), when its last run
 * (consents_last_run_ms) is at least `everyMs` ago. Resolves to the run's report, or null when it did not run. Errors
 * are the caller's (the agent's hook swallows them).
 *
 * valueSafeOnly (decision D-3 a; before a read-only tool): processConsents({valueSafeOnly: true}), only for a local
 * consent policy with a value-safe role on (consents.setoff or consents.as_new_creditor), and only when neither kind of
 * run (consents_last_run_ms, consents_last_safe_run_ms) is less than `everyMs` ago.
 */
export async function consentsDue(c, {nowMs = null, everyMs = CONSENTS_EVERY_MS, valueSafeOnly = false} = {}) {
  const state = c.state;
  if (!wantsConsents(state) || !c.connected) return null;
  if (valueSafeOnly && !consentRoles(get(state, 'consent_policy')).some(r => VALUE_SAFE_HEADER_ROLES.includes(r))) {
    return null;                                    // nothing a read could sign: no request at all
  }
  const now = nowMs ?? (typeof c.nowMs === 'function' ? c.nowMs() : Date.now());
  for (const key of valueSafeOnly ? ['consents_last_run_ms', 'consents_last_safe_run_ms'] : ['consents_last_run_ms']) {
    const last = get(state, key);
    if (whole(last) && now - last >= 0 && now - last < everyMs) return null;
  }
  return valueSafeOnly ? c.processConsents({nowMs: now, valueSafeOnly: true}) : c.processConsents({nowMs: now});
}

/** novation.js's verifier: a Basis signature (hex) over msg (bytes) by pubkeyHex. */
const verifyHexFor = (pubkeyHex, msg, sigHex) => verifyHex(sigHex, msg, pubkeyHex);

/** valun_set_limits argument -> [server field, kind]. Caps can only be lowered below the owner's mandate, floors raised. */
export const LIMIT_FIELDS = Object.freeze({
  max_per_deal_as_payer: Object.freeze(['max_issue_per_deal', 'cap']), max_total_owed: Object.freeze(['max_issue_outstanding', 'cap']),
  max_per_deal_as_payee: Object.freeze(['max_accept_per_deal', 'cap']), max_claim_per_payer: Object.freeze(['max_accept_per_issuer', 'cap']),
  min_price_as_payee: Object.freeze(['min_price_as_payee', 'floor']), min_payer_coverage_pct: Object.freeze(['min_payer_coverage_pct', 'floor']),
});
export const TOOL_NAMES = Object.freeze(schemas.ALL.map(t => t.name));
export const READ_ONLY_TOOLS = Object.freeze(['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal']);
// The read-only tools before which an agent with consentsOnReads signs the value-safe consents (decision D-3 a), and the
// keys of each entry of their consents_signed_now.
export const CONSENTS_ON_READ_TOOLS = Object.freeze(['valun_status', 'valun_inbox']);
export const SIGNED_NOW_KEYS = Object.freeze(['id', 'kind', 'role', 'deal_id', 'amount', 'your_net_change_PC', 'your_total_owed_change_PC', 'state']);
// The classification every adapter takes from here (fail closed by name): these tools never commit the owner...
export const NOT_COMMITMENT_TOOLS = Object.freeze([...READ_ONLY_TOOLS, 'valun_deliver']);
// ...this one does only when it loosens a limit recorded before...
export const LIMIT_TOOLS = Object.freeze(['valun_set_limits']);
// ...and every other tool signs a commitment for some arguments (a new tool counts until it is classified above).
export const SIGNING_TOOLS = Object.freeze(TOOL_NAMES.filter(n => !NOT_COMMITMENT_TOOLS.includes(n) && !LIMIT_TOOLS.includes(n)));
/** The refusal when what would be signed cannot be read or checked (approval_unbound). */
export const UNBOUND_MESSAGE = 'could not read what you would sign; nothing was signed';
/** The approval text for a tool this client does not know ({name} is the tool name, shown). */
export const GENERIC_TEXT = 'Valun: sign a commitment ({name}).';
/** Per quoted field of an approval text (the server's own limit for service.description). */
export const QUOTE_MAX_CHARS = 2000;
export const ROLE_WORDS = Object.freeze({payer: 'payer', payee: 'payee (you do the work)'});
export const DEFAULT_SETUP_HINT = 'run `valun join` (or `valun enroll`) in a terminal';
/** Where approvals happen, as the Python MCP server and CLI tell the model (python/src/valun/mcp_server.py). */
export const APPROVAL_TEXT = Object.freeze({
  ask: 'Before you sign an offer, counter-offer, acceptance or credit note, your owner is asked through this app and '
    + 'sees exactly what you would sign; if they decline, nothing is signed.',
  'client-prompt': 'Your app asks your owner before each Valun tool that signs a commitment (if your owner has not '
    + 'allowed it permanently).',
  console: 'Every commitment you sign waits for your owner in the Valun owner console before it takes effect: offers, '
    + 'counter-offers and acceptances, and accepting a delivery (its credit note is issued only after your owner '
    + 'approves it).',
  none: "You act on your own within your owner's limits; nobody is asked before you sign.",
});

const DEAL_FIELDS = ['id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement', 'decline',
  'completion', 'dispute', 'cancellation', 'approvals', 'labels'];
const LIMITS_SHOWN = Object.entries(LIMIT_FIELDS);
const PLAIN = /^[A-Za-z0-9_.:@+-]{1,120}$/;
const DEAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LONE_SURROGATE = /\p{Cs}/u;
const TEXT_FIELDS = ['title', 'description', 'deliverable'];

/** Python's isinstance(v, int) and not isinstance(v, bool), for JSON numbers (a safe integer). */
const whole = v => typeof v === 'number' && Number.isSafeInteger(v);

function jsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * Untrusted text (written by a counterparty, or by the agent from what it read) as ONE line of JSON, exactly as Python's
 * json.dumps(value, ensure_ascii=True, separators=(',', ':')) writes it. Newlines, control, bidi and all other non-ASCII
 * characters are escaped, so it can never add, fake or reorder a line of an approval text.
 */
export function quoted(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return repr(value);
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) return '[' + value.map(quoted).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => jsonString(k) + ':' + quoted(v)).join(',') + '}';
  return jsonString(String(value));
}

/**
 * A server-supplied value for a computed line of an approval text: as is when it cannot carry layout (a whole number,
 * or a short id, hash, handle or date), otherwise quoted as JSON.
 */
export function shown(value) {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (whole(value) || (typeof value === 'string' && PLAIN.test(value))) return String(value);
  return quoted(value);
}

/**
 * The last line of an approval text: `label`, then `fields` (text a counterparty or the agent wrote) quoted as ONE JSON
 * line. A text field longer than QUOTE_MAX_CHARS (code points, as Python counts them) is cut to that many, and the label
 * says so.
 */
export function quoteLine(label, fields) {
  const out = {};
  let cut = false;
  for (const [k, value] of Object.entries(fields)) {
    let v = value;
    if (typeof v === 'string' && cpLength(v) > QUOTE_MAX_CHARS) {
      v = cpSlice(v, QUOTE_MAX_CHARS);
      cut = true;
    }
    out[k] = v;
  }
  const note = cut ? `; fields over ${QUOTE_MAX_CHARS} characters are cut to their first ${QUOTE_MAX_CHARS}` : '';
  return `${label} (quoted exactly${note}): ` + quoted(out);
}

/** What a binding deal means for this participant, in the role the signed terms give it. */
export function owes(role, who, price) {
  return role === 'payer' ? `after you accept their delivery you will owe ${who} ${price} PC (your credit note).`
    : `you must deliver; ${who} would then owe you ${price} PC (their credit note).`;
}

/** Map valun_set_limits arguments to the server's /limits body. */
export function limitsBody(args) {
  const body = {};
  for (const [arg, [field]] of LIMITS_SHOWN) {
    if (get(args, arg) !== null) body[field] = int(item(args, arg));
  }
  for (const arg of iterate(or(get(args, 'clear'), []))) {
    if (Array.isArray(arg) || isDict(arg)) throw new PyError('TypeError', `cannot use '${typeName(arg)}' as a dict key (unhashable type: '${typeName(arg)}')`);
    if (typeof arg === 'string' && Object.hasOwn(LIMIT_FIELDS, arg)) body[LIMIT_FIELDS[arg][0]] = null;
  }
  if (get(args, 'goals') !== null) body.notes = str(item(args, 'goals'));
  return body;
}

/**
 * True when a /limits body would loosen a limit the agent recorded before (a higher cap, a lower floor, or removing
 * one). Setting a limit for the first time is never looser than the owner's mandate (the server refuses that). Fails
 * closed: a field this client does not know, a kind of limit it does not know, or a value that is not a whole number
 * counts as loosening. 'notes' (the owner's goals, as text) is not a limit.
 */
export function loosens(current, body) {
  const kinds = Object.fromEntries(Object.values(LIMIT_FIELDS));
  for (const [field, next] of items(body)) {
    if (field === 'notes') continue;
    const kind = Object.hasOwn(kinds, field) ? kinds[field] : null;
    if (kind !== 'cap' && kind !== 'floor') return true;
    const old = get(current, field) ?? null;
    if (old === null) continue;
    if (next === null || next === undefined || !(whole(next) && whole(old)) || (kind === 'cap' && next > old) || (kind === 'floor' && next < old)) {
      return true;
    }
  }
  return false;
}

/**
 * Has this participant's agent made a call to Valun within the last `hours`? A participant that joined within that
 * window counts as active even before its agent's first call (it is new, not idle). Times without a UTC offset, or
 * not ISO 8601, count as not recent (as in Python, where comparing them fails).
 */
export function recentlyActive(lastSeen, hours = 24, joinedAt = null, nowMs = Date.now()) {
  const within = iso => {
    const t = isoAwareMs(str(iso).replaceAll('Z', '+00:00'));
    return t !== null && nowMs - t < hours * 3_600_000;
  };
  return within(lastSeen) || within(joinedAt);
}

/** The agreed (or current) service text: where numeric requirements such as '300-500 words' are written. */
export function termsText(d) {
  const t = or(get(or(get(or(get(d, 'current'), {}), 'terms'), {}), 'service'), {});
  return TEXT_FIELDS.map(k => str(or(get(t, k), ''))).join(' ');
}

function isValunError(e) {
  return e instanceof ValunError || (e instanceof Error && e.name === 'ValunError' && typeof e.code === 'string');
}

/** Python's canonical() refuses what is not a whole number among the terms' numbers: ValunError bad_terms ('float'). */
function pyTermsHash(t) {
  const walk = v => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new ValunError('bad_terms', 'unsupported value in terms: float');
    if (Array.isArray(v)) v.forEach(walk);
    else if (isDict(v)) Object.values(v).forEach(walk);
  };
  walk(t);
  return termsHash(t);
}

/** sha256 of the UTF-8 text, refusing a lone surrogate as Python's str.encode('utf-8') does. */
function pySha256(s) {
  if (LONE_SURROGATE.test(s)) throw new PyError('UnicodeEncodeError', "'utf-8' codec can't encode a surrogate: surrogates not allowed");
  return sha256Hex(s);
}

/** A ValunError (or any exception) as a plain object an agent can act on. Never includes secrets. */
export function errorPayload(e, setupHint = DEFAULT_SETUP_HINT) {
  if (isValunError(e)) {
    const out = {error: e.code, message: e.message};
    const extra = isDict(e.extra) ? e.extra : {};
    for (const k of ['rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means', 'cause']) {
      if (Object.hasOwn(extra, k)) out[k] = extra[k];
    }
    if (e.code === 'approval_unbound') {
      out.what_this_means = 'Nothing was signed and your owner was not asked: your Valun client could not read and check '
        + 'exactly what this call would sign (the deal, offer or delivery could not be read, does not '
        + 'match its hash, or changed after you read it). Read the deal again with valun_deal and retry; '
        + 'if it keeps failing, tell your owner.';
    }
    if (e.code === 'tracker_mismatch') {
      out.what_this_means = 'The Valun server now names a different Basis tracker or unit than the one this profile was '
        + 'set up with. Nothing was signed. Stop and tell your owner.';
    }
    if (e.code === 'bad_delivery_signature') {
      out.what_this_means = "The delivery is not signed by the payee's key, so it may not come from the payee. Nothing "
        + 'was signed. Do not accept it; tell your owner.';
    }
    if (e.code === 'records_unreadable') {
      out.what_this_means = 'Your Valun client cannot read its own records, so it signs nothing until they are fixed. '
        + 'Nothing was signed. Tell your owner.';
    }
    if (e.code === 'already_paid') {
      out.what_this_means = 'Your earlier credit note for this deal is (or may already be) on the tracker, so the deal '
        + 'counts as paid. Nothing was signed. Do not try to pay it again; tell your owner.';
    }
    if (e.code === 'mandate_exceeded') {
      out.what_this_means = "Your owner's mandate does not allow this. Nothing was recorded. Do not try to work around "
        + 'it; tell your owner if you think the limit should change.';
    }
    if (e.code === 'offer_not_authorized') {
      out.what_this_means = "The other side's owner no longer allows this offer (their mandate changed or is used up). "
        + 'Nothing was recorded. You may decline it or wait for a new offer.';
    }
    if (e.code === 'key_changed' || e.code === 'payee_no_key') {
      out.what_this_means = "A party's agent key was revoked or replaced by its owner. Offers that name the old key can "
        + 'no longer be agreed; agreed deals continue once the party has a new key.';
    }
    if (['unauthorized', 'not_connected', 'not_configured'].includes(e.code)) {
      out.what_this_means = `This agent is not connected to Valun. Its owner must ${setupHint}.`;
    }
    if (e.code === 'owner_declined') out.what_this_means = 'Your owner did not approve this commitment. Nothing was signed or sent.';
    if (e.code === 'attempt_outcome_unknown') {
      out.what_this_means = 'An earlier payment of this deal may have applied: the edge it would change has moved '
        + 'past it to a state your Valun client cannot explain. Nothing was signed, and your client '
        + 'will not pay this deal again by itself. Only your owner can resolve it, after confirming '
        + 'with the payee whether the payment arrived (in a terminal: `valun attempts list`, which '
        + 'also says when the Valun server ended an attempt before it reached the tracker, then '
        + '`valun attempts resolve`). Tell your owner.';
    }
    if (e.code === 'transfer_window_open') {
      out.what_this_means = 'An earlier payment attempt of this deal can still apply until it is more than an hour '
        + 'old, so another kind of payment could pay the deal twice. Nothing was signed. Retry the '
        + 'same payment, or wait retry_after_ms before paying another way.';
    }
    if (e.code === 'stale_quote' || e.code === 'stale_claim') {
      out.what_this_means = 'The payment changed after it was approved (another quote, or your claim on the issuer '
        + 'moved). Nothing was signed. Read the deal again and accept again; your owner is asked '
        + 'again.';
    }
    if (e.code === 'feature_unavailable') {
      out.what_this_means = 'This Valun server does not offer circulating credit (paying with notes you hold, '
        + 'set-offs), or not on the tracker contract your client signs for (tracker v3.2). '
        + 'Nothing was signed. Pay with your own credit note (leave pay_with out); if that fails '
        + 'too, tell your owner: the server must run tracker v3.2.';
    }
    if (e.code === 'unknown_issuer') {
      out.what_this_means = 'The payment options for this deal list no note of yours from that issuer. Nothing was '
        + 'signed. valun_status notes_you_can_spend and valun_deal how_you_can_pay give the exact '
        + 'pay_with values.';
    }
    if (e.code === 'not_exact_service') {
      out.what_this_means = 'exact_result works only for text-stats and notary jobs whose agreed description '
        + 'carries the text to process. Nothing was sent. Deliver the content yourself.';
    }
    return out;
  }
  if (e instanceof Error) return {error: 'internal_error', message: `${e.name}: ${e.message}`};
  return {error: 'internal_error', message: `Error: ${String(e)}`};
}
/**
 * The nine Valun tools over one participant's Client.
 *
 * options:
 *   approvals       one sentence telling the model where commitments are approved (adapter-specific; APPROVAL_TEXT has
 *                   the Python adapters' sentences). valunTools() fills it in when it is empty.
 *   checkLinkHosts  look up link host names when measuring deliveries (default true; no page is fetched). Needs
 *                   resolveHost; without one the measurement says the hosts were not checked.
 *   resolveHost     async host => 'public' | 'private' | 'not_found' (Node: resolveHost from "@fitzdoud/valun/dns").
 *   hostTimeoutMs   how long all host lookups of one measurement may take together (default 4000, as in Python).
 *   setupHint       what the owner must do to connect the agent (default: run `valun join` (or `valun enroll`) ...).
 *   processConsents sign the consents the owner's policy allows before tools that are not read-only (consentsIfDue;
 *                   default true). A host with a consent loop of its own (tools.js startConsentLoop) may turn it off.
 *   declareRoles    (null: as processConsents) does the client declare the consent roles its policy signs to the server
 *                   (X-Valun-Features; Client declareRoles; decision D-3 b)? With it off it declares none, and withdraws
 *                   the roles declared before. A host that turns processConsents off only because it signs consents
 *                   through this agent's client by itself (a consent loop of its own) passes true.
 *   consentsOnReads (decision D-3 a; default false) for a host without a background consent loop: before valun_status
 *                   and valun_inbox, sign the value-safe consents only (set-offs, and payments to me by transfer as the
 *                   standing policy allows; never an issuer's or a payer's), at most once per CONSENTS_EVERY_MS; the
 *                   tool's result then says what was signed (consents_signed_now). Only with processConsents on.
 *   now             clock in ms (test hook; the Client has its own).
 */
export class ValunAgent {
  #client;
  #now;
  #held = Promise.resolve();                         // the agent's lock (Python's STORE_LOCK): see exclusive()

  constructor(client, options = {}) {
    if (!client || typeof client.deal !== 'function' || typeof client.complete !== 'function') {
      throw new TypeError('ValunAgent needs a valun Client');
    }
    const {approvals = '', checkLinkHosts = true, resolveHost = null, hostTimeoutMs = 4000, setupHint = null, now = null,
      processConsents = true, consentsOnReads = false, declareRoles = null, briefStatus = false} = options;
    if (resolveHost !== null && typeof resolveHost !== 'function') throw new TypeError('resolveHost must be a function');
    this.#client = client;
    this.#now = now || (() => Date.now());
    this.approvals = approvals;
    this.checkLinkHosts = checkLinkHosts;
    this.resolveHost = resolveHost;
    this.hostTimeoutMs = hostTimeoutMs;
    this.setupHint = setupHint || DEFAULT_SETUP_HINT;
    this.processConsents = processConsents === true;
    this.consentsOnReads = consentsOnReads === true;
    this.briefStatus = briefStatus === true;   // valun_status answers the brief view unless brief=false is passed
    this.declareRoles = declareRoles === null || declareRoles === undefined ? this.processConsents : declareRoles === true;
    client.declareRoles = this.declareRoles;          // the client's X-Valun-Features header follows the agent (D-3 b)
    /** The feature tags the last GET /info this agent read listed (null: none read yet). */
    this.features = null;
    this.handlers = Object.freeze({
      valun_status: a => this.status(a), valun_directory: a => this.directory(a), valun_inbox: a => this.inbox(a),
      valun_deal: a => this.deal(a), valun_propose: a => this.propose(a), valun_respond: a => this.respond(a),
      valun_deliver: a => this.deliver(a), valun_review_delivery: a => this.review(a), valun_set_limits: a => this.setLimits(a),
    });
  }

  // ---------- plumbing ----------
  /**
   * Run `fn` holding this agent's lock, after every earlier holder is done (whatever its outcome); resolves or rejects
   * as fn does. It is what STORE_LOCK is to the Python MCP server: call() (so callSafe()), isCommitment(), prepare() (so
   * prepareOrRefusal() and describeCommitment()), bind(), consentsIfDue(), consentsOnRead() and consentRound() each
   * hold it, so a consent loop round never interleaves with a tool call, nor two tool calls with each other (two
   * consent runs could otherwise sign and send the same consent). valunTools() never holds it while the owner is asked.
   * The lock is not reentrant: fn must not call those methods of this agent (they would wait for fn). A host that calls
   * the tool methods themselves (status(), propose(), ...) next to a consent loop can run them through exclusive().
   */
  exclusive(fn) {
    if (typeof fn !== 'function') throw new TypeError('exclusive needs a function');
    const run = this.#held.then(() => fn());
    this.#held = run.then(() => undefined, () => undefined);   // the lock itself never rejects
    return run;
  }

  /**
   * A Client for one use, after checking that it is enrolled (not_connected otherwise). It starts as a new client would
   * (the Python agent makes one per use): Client.fresh() of the agent's client, which has read no GET /info yet, so its
   * requests carry the capability header only after this use reads GET /info, and no other use changes its features.
   * (A client without fresh() is used as it is.) Its declareRoles is the agent's as it is now (set on every use, as
   * the Python agent passes declare_roles to each Client), so a change of agent.declareRoles takes effect.
   */
  client(requireConnection = true) {
    const base = this.#client;
    const c = typeof base.fresh === 'function' ? base.fresh() : base;
    c.declareRoles = this.declareRoles === true;
    if (requireConnection && (!c.connected || !c.participantId)) {
      throw new ValunError('not_connected', `not enrolled: the owner must ${this.setupHint}`);
    }
    return c;
  }

  /**
   * Run one tool. Resolves to a plain object; rejects with a ValunError (use errorPayload to turn it into a result).
   * Before a tool that is not read-only, the client signs the consents its owner's policy allows (consentsIfDue). With
   * consentsOnReads, before valun_status and valun_inbox it signs the value-safe ones (consentsOnRead), and when that
   * run took place the result adds consents_signed_now: one entry (SIGNED_NOW_KEYS) for each consent it signed ([]: none).
   */
  async call(name, args = null) {
    if (typeof name !== 'string' || !Object.hasOwn(this.handlers, name)) {
      throw new ValunError('unknown_tool', `no Valun tool called ${repr(name)}`);
    }
    return this.exclusive(() => this.#call(name, args));
  }

  async #call(name, args) {
    if (!READ_ONLY_TOOLS.includes(name)) {
      await this.#consentsIfDue();
      return this.handlers[name](truthy(args) ? args : {});
    }
    const report = CONSENTS_ON_READ_TOOLS.includes(name) ? await this.#consentsOnRead() : null;
    const out = await this.handlers[name](truthy(args) ? args : {});
    if (report !== null && isDict(out)) {
      out.consents_signed_now = iterate(or(get(report, 'signed'), [])).filter(isDict)
        .map(e => Object.fromEntries(SIGNED_NOW_KEYS.map(k => [k, get(e, k)])));
    }
    return out;
  }

  /**
   * Process consents (Client.processConsents: set-offs, transfers of my own debt, payments to me, regenerated transfers
   * of my payments) when they are due: at most once per CONSENTS_EVERY_MS, and only for a profile that takes part in
   * consents (wantsConsents), with this agent's processConsents on, on a server not already known to lack circulating
   * credit (decision D-2 h). Never from a read-only tool. Never rejects: resolves to the report, or null when it did not
   * run or failed (a failed run counts as a run). Holds the agent's lock (exclusive()).
   */
  async consentsIfDue(nowMs = null) {
    return this.exclusive(() => this.#consentsIfDue(nowMs));
  }

  /**
   * One round of a consent loop (tools.js startConsentLoop; the Python MCP server's ConsentLoop.run_once), all of it
   * holding the agent's lock: `enabled()` (the loop reads the profile's consent_loop again) and, when it resolves to
   * true, the consent run that is due (consentsIfDue). Resolves to {ran, report}: ran says whether enabled() said yes,
   * report is the run's report (null: none was due, or it failed). Never rejects (an enabled() that throws: ran false).
   */
  async consentRound(enabled) {
    if (typeof enabled !== 'function') throw new TypeError('consentRound needs an enabled() function');
    return this.exclusive(async () => {
      let on;
      try {
        on = (await enabled()) === true;
      } catch {
        on = false;
      }
      return on ? {ran: true, report: await this.#consentsIfDue()} : {ran: false, report: null};
    });
  }

  async #consentsIfDue(nowMs = null) {
    if (!this.processConsents) return null;
    if (this.features !== null && !this.features.includes(CIRCULATION)) return null;
    let c;
    try {
      c = this.client();
    } catch {                                         // not connected: there is nothing to consent to
      return null;
    }
    const now = nowMs ?? (typeof c.nowMs === 'function' ? c.nowMs() : this.#now());
    let report;
    try {
      report = await consentsDue(c, {nowMs: now});
    } catch {                                         // a consent run must never stop the tool the agent asked for
      await ValunAgent.#markConsentsRun(c, now);
      return null;
    }
    if (report !== null) this.#rememberClient(c);
    return report;
  }

  /**
   * Decision D-3 a: before valun_status and valun_inbox, for an agent with consentsOnReads and processConsents on, sign
   * the value-safe consents (Client.processConsents({valueSafeOnly: true})) when they are due: at most once per
   * CONSENTS_EVERY_MS (a full run before a tool that is not read-only counts too, and this run never delays one), for a
   * profile whose local policy has a value-safe role on, on a server not already known to lack circulating credit. Never
   * rejects: resolves to the report, or null when it did not run, failed (a failed run counts as a run, in
   * consents_last_safe_run_ms) or found that the server does not offer circulating credit. Holds the agent's lock.
   */
  async consentsOnRead(nowMs = null) {
    return this.exclusive(() => this.#consentsOnRead(nowMs));
  }

  async #consentsOnRead(nowMs = null) {
    if (!(this.consentsOnReads && this.processConsents)) return null;
    if (this.features !== null && !this.features.includes(CIRCULATION)) return null;
    let c;
    try {
      c = this.client();
    } catch {
      return null;
    }
    const now = nowMs ?? (typeof c.nowMs === 'function' ? c.nowMs() : this.#now());
    let report;
    try {
      report = await consentsDue(c, {nowMs: now, valueSafeOnly: true});
    } catch {                                         // a consent run must never stop the read the agent asked for
      await ValunAgent.#markConsentsRun(c, now, 'consents_last_safe_run_ms');
      return null;
    }
    if (report === null) return null;
    return this.#rememberClient(c).includes(CIRCULATION) ? report : null;
  }

  static async #markConsentsRun(c, now, key = 'consents_last_run_ms') {
    try {
      await c.markConsentsRun(now, key);
    } catch { /* a mark that fails is not retried */ }
  }

  /** Remember (and return) the feature tags of a GET /info answer. */
  #remember(info) {
    this.features = featuresOf(info);
    return this.features;
  }

  /** Remember (and return) the feature tags of the last GET /info the client read. */
  #rememberClient(c) {
    this.features = [...(c.advertised || [])];
    return this.features;
  }

  /** Does the server offer circulating credit, as the last GET /info read (by `c`, or by this agent) said? */
  #circulating(c = null) {
    const seen = c !== null ? [...(c.advertised || [])] : [];
    return seen.includes(CIRCULATION) || (this.features || []).includes(CIRCULATION);
  }

  /**
   * Does the server offer circulating credit? From the features this agent already knows when it knows them; otherwise
   * from one GET /info, read only when it can matter (decision D-2 h): always for a call that names no deal, and for a
   * deal only when its view carries the `payment` key, which a server shows only with circulation on. A failed read
   * counts as no circulation, except a tracker the profile is not pinned to (tracker_mismatch), which stops the call.
   */
  async #knownCirculation(c, deal = null) {
    if (this.features !== null) return this.features.includes(CIRCULATION);
    if (deal !== null && !(isDict(deal) && Object.hasOwn(deal, 'payment'))) return false;
    try {
      return this.#remember(await c.info()).includes(CIRCULATION);
    } catch (e) {
      if (isValunError(e) && e.code === 'tracker_mismatch') throw e;
      return false;                                   // a client that cannot read /info: as without circulation
    }
  }

  /** Like call(), but never rejects: errors come back as {error: ...}. */
  async callSafe(name, args = null) {
    try {
      return await this.call(name, args);
    } catch (e) {
      return errorPayload(e, this.setupHint);
    }
  }

  #measureOptions(checkHosts) {
    return {checkHosts, resolveHost: this.resolveHost, timeoutMs: this.hostTimeoutMs};
  }

  /**
   * The directory entry `who` names: the participant with exactly that id; a handle only when no id matches (a handle may
   * look like another participant's id).
   */
  async #resolve(c, who) {
    who = lower(strip(or(who, '')));
    const people = iterate(await c.directory()).filter(isDict);
    for (const p of people) if (get(p, 'id') === who) return p;
    for (const p of people) if (get(p, 'handle') === who) return p;
    throw new ValunError('unknown_participant', `no participant called ${repr(who)}; use valun_directory`);
  }

  // ---------- approvals ----------
  /**
   * Does this call sign something that commits the owner (or loosen a limit)? Adapters ask the owner first. Fails closed
   * by name and by value: only these are not commitments: the read-only tools, valun_deliver, valun_respond with action
   * exactly 'decline' or 'withdraw', valun_review_delivery with decision exactly 'dispute', and valun_set_limits calls
   * that do not loosen a recorded limit. Every other call, including any tool name this client does not know and a
   * misspelt "Accept", is a commitment.
   */
  async isCommitment(name, args = null) {
    const a = isDict(args) ? args : {};
    if (LIMIT_TOOLS.includes(name)) {
      return this.exclusive(async () => {
        try {
          const me = await this.client().me();
          return loosens(or(get(me, 'agent_limits'), {}), limitsBody(args));
        } catch {
          return true;    // when in doubt, ask the owner
        }
      });
    }
    return ValunAgent.#mayCommit(name, a);
  }

  /** The classification without any read: false only for calls that can never commit the owner. */
  static #mayCommit(name, a) {
    if (NOT_COMMITMENT_TOOLS.includes(name)) return false;
    if (name === 'valun_respond') return !['decline', 'withdraw'].includes(get(a, 'action'));
    if (name === 'valun_review_delivery') return get(a, 'decision') !== 'dispute';
    return true;
  }

  /**
   * Bind and describe a commitment from ONE snapshot of what it would sign. Resolves to {args, text}: the arguments to
   * sign with and the owner's approval text. Adapters ask the owner with `text`, then call the tool with exactly `args`.
   * text is null for a call that commits nothing (also a valun_set_limits call that this snapshot shows loosens
   * nothing): it runs without asking.
   *
   * The text is built only from values checked against what is signed. An acceptance or counter-offer: the terms shown
   * hash to the stated terms hash, are this deal's, name this participant as exactly one party and were offered by the
   * other one, and the server's role and counterparty for the deal agree with them. A delivery acceptance: the same, and
   * the agreement has that terms hash and the delivered text hashes to its sha256. The recomputed hashes are pinned in
   * `args` (expected_terms_hash; for a delivery also expected_deliverable_sha256); the client reads the deal again when
   * it signs and refuses anything else (stale_terms, stale_delivery). A new offer is pinned to the participant id the
   * text shows. So the signature covers what the owner saw.
   *
   * Rejects with ValunError('approval_unbound') when what would be signed cannot be read or checked (any error, a missing
   * or wrong hash, or a pin the agent passed that is not the snapshot's): the adapter must then refuse the call. A tool
   * this client does not know gets a generic text; a known commitment never does. Holds the agent's lock (exclusive()).
   */
  async prepare(name, args = null) {
    return this.exclusive(() => this.#prepare(name, args));
  }

  async #prepare(name, args) {
    const a = isDict(args) ? dictCopy(args) : {};
    if (Array.isArray(name) || isDict(name)) throw new PyError('TypeError', `unhashable type: '${typeName(name)}'`);
    if (typeof name !== 'string' || !Object.hasOwn(this.handlers, name)) {
      return {args: a, text: GENERIC_TEXT.replace('{name}', () => shown(name))};
    }
    if (!ValunAgent.#mayCommit(name, a)) return {args: a, text: null};
    let bound, text;
    try {
      if (args !== null && args !== undefined && !isDict(args)) throw new ValunError('bad_arguments', 'the arguments are not a JSON object');
      const render = this.#textFor(name, a);          // before any read: a misspelt action or decision has no text
      const snap = await this.#snapshot(name, a);
      if (LIMIT_TOOLS.includes(name) && !loosens(or(get(snap.me, 'agent_limits'), {}), limitsBody(a))) {
        return {args: a, text: null};                 // this read shows nothing loosened: nothing to approve
      }
      bound = ValunAgent.#bindFrom(name, a, snap, true);
      text = await render(bound, snap);
    } catch (e) {                                     // nothing may be approved that could not be read and checked
      throw ValunAgent.#unbound(e);
    }
    return {args: bound, text};
  }

  /**
   * For adapters: [prepared, null], or [null, refusal]. Ask the owner with prepared.text, then sign with prepared.args;
   * when prepared.text is null the call commits nothing and runs without asking. The refusal is the result to return
   * instead of asking when what would be signed cannot be read or checked: the owner is then never asked with a generic
   * text, and nothing is signed (approval_unbound).
   */
  async prepareOrRefusal(name, args = null) {
    let prepared, extra = {};
    try {
      prepared = await this.prepare(name, args);
    } catch (e) {                                     // whatever went wrong, nothing is asked and nothing is signed
      prepared = null;
      const info = isValunError(e) && isDict(e.extra) ? e.extra : {};
      if (UNBOUND_PASS_THROUGH.includes(get(info, 'cause'))) {
        return [null, errorPayload(new ValunError(info.cause, or(get(info, 'cause_message'), UNBOUND_MESSAGE)), this.setupHint)];
      }
      extra = Object.fromEntries(['cause', 'retry_after_ms'].filter(k => Object.hasOwn(info, k)).map(k => [k, info[k]]));
    }
    if (isDict(prepared) && isDict(prepared.args)
        && ((prepared.text ?? null) === null || (typeof prepared.text === 'string' && prepared.text))) {
      return [prepared, null];
    }
    return [null, errorPayload(new ValunError('approval_unbound', UNBOUND_MESSAGE, undefined, extra), this.setupHint)];
  }

  /**
   * prepare()'s pins alone, for adapters that ask with their own text (kept for compatibility): an acceptance or
   * counter-offer is pinned to the recomputed hash of the terms shown, a delivery acceptance also to the recomputed hash
   * of the delivered text, each checked as prepare() checks it. Pins the agent passed are kept (the client refuses to
   * sign anything else). For a commitment it never resolves to the arguments unpinned: when the deal cannot be read or
   * checked it rejects with ValunError('approval_unbound'). Holds the agent's lock while it reads.
   */
  async bind(name, args = null) {
    const a = isDict(args) ? dictCopy(args) : {};
    if (!ValunAgent.#needsPins(name, a)) return a;
    return this.exclusive(async () => {
      try {
        return ValunAgent.#bindFrom(name, a, await this.#snapshot(name, a), false);
      } catch (e) {
        throw ValunAgent.#unbound(e);
      }
    });
  }

  /**
   * Text for an approval prompt: exactly what the agent is about to sign, and what it means (prepare() gives it together
   * with the arguments it binds). Rejects with ValunError('approval_unbound') for a known commitment it cannot read and
   * check: it never falls back to a generic text. null for a call that is not a commitment.
   */
  async describeCommitment(name, args = null) {
    return (await this.prepare(name, args)).text;
  }

  static #unbound(e) {
    const cause = isValunError(e) ? e.code : (e instanceof Error ? e.name : typeName(e));
    const extra = {cause};
    if (isValunError(e)) {
      extra.cause_message = cpSlice(String(e.message), 300);
      const ex = isDict(e.extra) ? e.extra : {};
      if ((get(ex, 'retry_after_ms') ?? null) !== null) extra.retry_after_ms = ex.retry_after_ms;
    }
    return new ValunError('approval_unbound', UNBOUND_MESSAGE, undefined, extra);
  }

  /**
   * The issuer a delivery acceptance pays with (pay_with, stripped and lower-cased), or null for the agent's own credit
   * note (pay_with absent or 'own_note'). bad_arguments for anything else.
   */
  static #payWith(a) {
    const pw = get(a, 'pay_with');
    if (pw === null || pw === 'own_note') return null;
    if (typeof pw !== 'string' || !strip(pw) || cpLength(pw) > 64) {
      throw new ValunError('bad_arguments', "pay_with is 'own_note' or the handle or id of an issuer whose note you hold");
    }
    const p = lower(strip(pw));
    return p === 'own_note' ? null : p;
  }

  static #needsPins(name, a) {
    if (name === 'valun_respond' && ['accept', 'counter'].includes(get(a, 'action'))) return !truthy(get(a, 'expected_terms_hash'));
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') {
      let pins = ['expected_deliverable_sha256', 'expected_terms_hash'];
      try {
        if (ValunAgent.#payWith(a) !== null) pins = [...pins, 'expected_quote_digest', 'expected_claim_total'];
      } catch (e) {
        if (isValunError(e)) return true;             // a malformed pay_with: binding refuses it (approval_unbound)
        throw e;
      }
      return !pins.every(k => truthy(get(a, k)));
    }
    return false;
  }

  /** The one read an approval is bound to and described from (checked: see prepare). */
  async #snapshot(name, a) {
    const c = this.client();
    if (name === 'valun_propose') {
      const other = await this.#resolve(c, get(a, 'counterparty'));
      if (!(isDict(other) && typeof get(other, 'id') === 'string' && other.id)) {
        throw new ValunError('approval_unbound', 'the directory names no participant id');
      }
      return {counterparty: other, not_settled: labels(await this.#knownCirculation(c)).not_settled};
    }
    if (name === 'valun_set_limits') {
      const me = await c.me();
      if (!isDict(me)) throw new ValunError('approval_unbound', 'the server sent no participant record');
      return {me};
    }
    const did = get(a, 'deal_id');
    if (!(typeof did === 'string' && DEAL_ID.test(did))) throw new ValunError('bad_arguments', 'deal_id is missing or malformed');
    const d = await c.deal(did);
    if (!isDict(d)) throw new ValunError('approval_unbound', 'the deal could not be read');
    const snap = {deal: d, checked: ValunAgent.#checked(d, did, c.participantId, name === 'valun_review_delivery')};
    snap.not_settled = labels(await this.#knownCirculation(c, d)).not_settled;
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept' && ValunAgent.#payWith(a) !== null) {
      snap.transfer = await this.#transferSnapshot(c, did, snap.checked, ValunAgent.#payWith(a));
      snap.not_settled = NOT_SETTLED_CIRCULATION;
    }
    return snap;
  }

  /**
   * What paying deal `did` with a held note would sign, read and checked once (see prepare): the server offers
   * circulation/1 and reports the tracker v3.2 contract (GET /info novation); the deal's payment options list a note of
   * mine from the issuer `payWith` names (an exact participant
   * id first, else a handle only one listed issuer has); the issuer's and the payee's current directory keys; and a fresh
   * transfer template for exactly that issuer and key, accepted by novation.evaluatePayerTemplate for the deal, terms and
   * delivery `chk` checked (with one GET /edges read-back when D-1 needs one).
   */
  async #transferSnapshot(c, did, chk, payWith) {
    if (!this.#remember(await c.info()).includes(CIRCULATION)) {
      throw new ValunError('feature_unavailable', 'this Valun server does not offer circulating credit (circulation/1)');
    }
    const problem = nv.contractProblem(c.novationInfo ?? null);    // tracker v3.2, as Client.payByTransfer checks
    if (problem) throw new ValunError('feature_unavailable', problem);
    const option = ValunAgent.#heldNote(await c.paymentOptions(did), payWith);
    const iid = option.issuer.id;
    const issuer = await ValunAgent.#current(c, iid);
    const payee = await ValunAgent.#current(c, chk.other_id);
    const me = await c.me();
    const mandate = isDict(me) ? (['effective_limits', 'mandate'].map(k => get(me, k)).find(isDict) ?? null) : null;
    const tpl = await c.transferTemplate(did, iid);
    const iss = isDict(tpl) ? get(tpl, 'issuer') : null;
    if (!(isDict(iss) && get(iss, 'id') === iid && get(iss, 'pubkey') === issuer.pubkey)) {
      throw new ValunError('bad_template', 'the transfer template is not for that issuer under its current key');
    }
    const deal = nv.dealContext(chk.terms, chk.terms_hash, chk.sha256);
    const r = await this.#evaluatePayment(c, tpl, deal, payee.pubkey, mandate);
    if (!r.ok) {
      const s = or(get(r, 'summary'), {});
      throw new ValunError(r.code, or(get(s, 'reason'), r.code), undefined,
        (get(s, 'retry_after_ms') ?? null) !== null ? {retry_after_ms: s.retry_after_ms} : {});
    }
    const before = get(item(tpl, 'to_edge'), 'before');
    return {template: tpl, option, issuer: {id: iid, handle: or(get(issuer, 'handle'), get(option.issuer, 'handle')), pubkey: issuer.pubkey},
      payee: {id: chk.other_id, handle: get(payee, 'handle'), pubkey: payee.pubkey},
      quote_digest: r.summary.quote_digest, claim: tpl.from_edge.before.total, to_prior: isDict(before) ? before.total : 0};
  }

  /**
   * The payment option (a note I hold) `payWith` names: an exact participant id first; a handle only when no id matches
   * and exactly one listed issuer has it. unknown_issuer otherwise.
   */
  static #heldNote(opts, payWith) {
    const held = isDict(opts) ? get(opts, 'held_notes') : null;
    const rows = (Array.isArray(held) ? held : []).filter(h => isDict(h) && isDict(get(h, 'issuer'))
      && typeof get(h.issuer, 'id') === 'string' && h.issuer.id);
    for (const h of rows) if (h.issuer.id === payWith) return h;
    const named = rows.filter(h => get(h.issuer, 'handle') === payWith);
    if (named.length === 1) return named[0];
    throw new ValunError('unknown_issuer', `the payment options for this deal list no note of yours from ${repr(cpSlice(payWith, 64))}`);
  }

  /** A participant's directory record, with its current (active) key. */
  static async #current(c, pid) {
    const p = await c.participant(pid);
    if (!(isDict(p) && get(p, 'status') === 'active' && typeof get(p, 'pubkey') === 'string' && p.pubkey)) {
      throw new ValunError('counterparty_inactive', `${str(pid)} has no active registered key`);
    }
    return p;
  }

  /**
   * novation.evaluatePayerTemplate on this profile's records as they are now, without recording anything (the client
   * evaluates again, and records, when it signs). D-1: an earlier attempt whose edge must be read gets one GET /edges
   * read-back (Client.syncEdges), as Client.payByTransfer does.
   */
  async #evaluatePayment(c, tpl, deal, payeePk, mandate) {
    await c.reload();
    const state = c.state;
    const pins = isDict(get(state, 'pins')) && truthy(get(state.pins, 'tracker_nft_id')) ? state.pins : null;
    const ctx = {me_pk: c.pubkey, me_id: c.participantId, now_ms: c.nowMs(), verify: verifyHexFor, pins, records: get(state, 'records'),
      signed: get(state, 'signed'), transfer_attempts: get(state, 'transfer_attempts'), novated_edges: get(state, 'novated_edges'),
      features: [...(this.features || [])], consent_policy: get(state, 'consent_policy'), deal, payee_current_pk: payeePk,
      approved_quote_digest: null, mandate, edges: null, novation: c.novationInfo ?? null};
    let r = nv.evaluatePayerTemplate(tpl, ctx);
    const need = !r.ok && r.code === 'transfer_window_open' ? get(r.summary, 'needs_read_back') : null;
    if (truthy(need)) {
      let fresh;
      try {
        fresh = await c.syncEdges();
      } catch (e) {
        if (isValunError(e)) return r;
        throw e;
      }
      const edges = {...fresh.edges};
      for (const e of need) if (!fresh.doubtful.includes(e) && !Object.hasOwn(edges, e)) edges[e] = null;
      r = nv.evaluatePayerTemplate(tpl, {...ctx, edges});
    }
    return r;
  }

  /**
   * The values an approval text is built from, each checked against what the call signs (prepare). Throws ValunError
   * when the deal as shown does not hold together.
   */
  static #checked(d, did, me, delivery = false) {
    const cur = get(d, 'current');
    if (!isDict(cur) || !truthy(cur)) throw new ValunError('no_offer', 'this deal has no visible offer');
    const t = get(cur, 'terms');
    if (!isDict(t)) throw new ValunError('approval_unbound', 'the offer shows no terms');
    const h = pyTermsHash(t);
    if (get(cur, 'terms_hash') !== h) throw new ValunError('hash_mismatch', 'the terms shown do not hash to the stated terms hash');
    if (get(t, 'deal_id') !== did) throw new ValunError('deal_mismatch', 'the terms shown are for another deal');
    const ids = Object.fromEntries(['payer', 'payee'].map(r => [r, isDict(get(t, r)) ? get(t[r], 'id') : null]));
    const mine = Object.entries(ids).filter(([, pid]) => typeof me === 'string' && me && pid === me).map(([r]) => r);
    if (mine.length !== 1) throw new ValunError('not_a_party', 'the terms do not name you as exactly one of the two parties');
    const role = mine[0];
    const other = ids[role === 'payer' ? 'payee' : 'payer'];
    if (!(typeof other === 'string' && other)) throw new ValunError('not_a_party', 'the terms name no other party');
    const yourRole = get(d, 'your_role') ?? null;
    if (yourRole !== null && yourRole !== role) {
      throw new ValunError('role_mismatch', `the server says you are the ${shown(yourRole)}; the terms make you the ${role}`);
    }
    const cp = isDict(get(d, 'counterparty')) ? d.counterparty : {};
    const cpId = get(cp, 'id') ?? null;
    if (cpId !== null && cpId !== other) throw new ValunError('counterparty_mismatch', "the server's counterparty is not the other party in the terms");
    const price = get(t, 'price');
    if (!(isDict(price) && whole(get(price, 'amount')) && get(price, 'unit') === UNIT)) {
      throw new ValunError('bad_terms', 'the price is not a whole number of PC');
    }
    const out = {terms: t, terms_hash: h, role, other_id: other, handle: get(cp, 'handle'), price: price.amount,
      service: isDict(get(t, 'service')) ? t.service : {}};
    if (!delivery) {
      if (get(t, 'proposer') !== other) throw new ValunError('own_offer', "the current offer is not the other party's: only they can be answered");
      return out;
    }
    if (role !== 'payer') throw new ValunError('not_payer', 'only the payer accepts a delivery');
    const ag = get(d, 'agreement');
    if (!isDict(ag) || get(ag, 'terms_hash') !== h) throw new ValunError('hash_mismatch', "the agreement's terms hash is not the hash of the terms shown");
    const dl = get(d, 'delivery');
    if (!isDict(dl) || !truthy(dl)) throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const content = get(dl, 'content');
    if (typeof content !== 'string') throw new ValunError('approval_unbound', 'the delivery shows no text');
    const sha = pySha256(content);
    if (get(dl, 'sha256') !== sha) throw new ValunError('hash_mismatch', 'the delivered content does not match its sha256');
    return {...out, delivery: dl, content, sha256: sha};
  }

  /**
   * The arguments to sign with: the agent's, plus the pins taken from the checked snapshot. With strict (prepare) a pin
   * the agent passed must be the snapshot's: the text describes the snapshot, so the call may sign nothing else.
   */
  static #bindFrom(name, a0, snap, strict) {
    const a = dictCopy(a0);
    const chk = or(snap.checked ?? null, {});
    const pin = (key, value, code, why) => {
      if (!truthy(get(a, key))) a[key] = value;
      else if (strict && (typeName(a[key]) !== typeName(value) || !pyEq(a[key], value))) throw new ValunError(code, why);   // True is not 1
    };
    if (name === 'valun_respond' && ['accept', 'counter'].includes(get(a, 'action'))) {
      pin('expected_terms_hash', item(chk, 'terms_hash'), 'stale_terms', 'the offer changed after your agent read it');
    } else if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') {
      pin('expected_deliverable_sha256', item(chk, 'sha256'), 'stale_delivery', 'the delivery changed after your agent read it');
      pin('expected_terms_hash', item(chk, 'terms_hash'), 'stale_terms', 'the agreed terms are not the ones your agent read');
      const tr = snap.transfer ?? null;
      if (tr !== null) {                              // paying with a held note: exactly the issuer, quote and claim shown
        a.pay_with = tr.issuer.id;
        pin('expected_quote_digest', tr.quote_digest, 'stale_quote', 'the payment changed after your agent read it');
        pin('expected_claim_total', tr.claim, 'stale_claim', 'your claim on the issuer changed after your agent read it');
      }
    } else if (name === 'valun_propose' && Object.hasOwn(snap, 'counterparty')) {
      a.counterparty = snap.counterparty.id;          // the offer is signed for exactly the participant shown
    }
    return a;
  }

  /** The approval text builder for this call: (args, snapshot) => text. */
  #textFor(name, a) {
    if (name === 'valun_set_limits') return (b, s) => this.#textLimits(b, s);
    if (name === 'valun_propose') return (b, s) => this.#textPropose(b, s);
    if (name === 'valun_respond' && get(a, 'action') === 'accept') return (b, s) => this.#textAccept(b, s);
    if (name === 'valun_respond' && get(a, 'action') === 'counter') return (b, s) => this.#textCounter(b, s);
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') {
      return ValunAgent.#payWith(a) !== null ? (b, s) => this.#textPay(b, s) : (b, s) => this.#textReview(b, s);
    }
    throw new ValunError('approval_unbound', `no approval text for ${name} with these arguments`);
  }

  // The texts: computed lines first (values the client computed or checked against what is signed, shown so that they
  // cannot carry layout), then text written by a counterparty or by the agent, quoted as one JSON line (quoteLine).
  #who(chk) {
    const h = chk.handle;
    return typeof h === 'string' && h ? shown(h) : shown(chk.other_id);
  }

  #textLimits(a, snap) {
    const me = snap.me;
    const mandate = get(me, 'mandate');
    if (!isDict(mandate)) throw new ValunError('approval_unbound', 'the server sent no owner mandate');
    const cur = or(get(me, 'agent_limits'), {}), body = limitsBody(a);
    const names = Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [field, arg]));
    const lines = ['Valun - LOOSEN limits recorded from your instructions (the Valun server enforces them):'];
    for (const [field, next] of Object.entries(body)) {
      if (Object.hasOwn(names, field)) {
        lines.push(`  ${names[field]}: ${shown(get(cur, field, get(mandate, field)))} -> `
          + `${next !== null ? shown(next) : 'removed'} (your owner mandate: ${shown(get(mandate, field))})`);
      }
    }
    lines.push('Approve only if you asked your agent for this.');
    if (Object.hasOwn(body, 'notes')) lines.push('Goals written by your agent (quoted exactly): ' + quoted(body.notes));
    return lines.join('\n');
  }

  #textPropose(a, snap) {
    const other = snap.counterparty;
    const role = get(a, 'role');
    if (role !== 'payer' && role !== 'payee') throw new ValunError('bad_role', 'role must be payer or payee');
    const price = int(item(a, 'price')), due = int(or(get(a, 'deliver_within_hours'), 48)), ttl = int(or(get(a, 'offer_valid_hours'), 24));
    const who = shown(get(other, 'handle'));
    return [
      `Valun - sign a NEW OFFER to ${who} (${shown(item(other, 'id'))}):`,
      `  you are the ${ROLE_WORDS[role]}; price: ${price} PC`,
      `  deliver within ${due} h; the offer stays open ${ttl} h`,
      `If ${who} accepts, the deal is binding without asking you again: ` + owes(role, who, price),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine('Offer text written by your agent', Object.fromEntries(TEXT_FIELDS.map(k => [k, get(a, k)])))].join('\n');
  }

  #textAccept(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service;
    return [
      `Valun - ACCEPT ${who}'s offer (${shown(chk.other_id)}, deal ${shown(t.deal_id)}, version ${shown(get(t, 'version'))}):`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${price} PC; deliver by ${shown(get(t, 'deliver_by'))}`,
      `  terms hash ${chk.terms_hash.slice(0, 16)}... (recomputed from these terms; your Valun client checks it again before signing)`,
      'This makes the deal binding on both sides: ' + owes(chk.role, who, price),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine(`Offer text written by ${who}`, Object.fromEntries(TEXT_FIELDS.map(k => [k, get(svc, k)])))].join('\n');
  }

  #textCounter(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), old = chk.price, svc = chk.service;
    // Exactly what Client.counter() signs: these arguments, and the rest copied from the terms pinned by hash.
    const price = get(a, 'price') !== null ? int(item(a, 'price')) : old;
    const hours = get(a, 'deliver_within_hours');
    if (hours !== null && !whole(hours)) throw new ValunError('bad_arguments', 'deliver_within_hours must be a whole number of hours');
    const texts = TEXT_FIELDS.filter(k => truthy(get(a, k)));
    const changes = [...(get(a, 'price') !== null ? [`price ${old} -> ${price} PC`] : []),
      ...(hours !== null ? [`deliver within ${hours} h`] : []), ...texts.map(k => `${k} (quoted below)`)];
    return [
      `Valun - sign a COUNTER-OFFER to ${who} (${shown(chk.other_id)}, deal ${shown(t.deal_id)}), `
        + `replacing their version ${shown(get(t, 'version'))}:`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${price} PC`,
      '  deliver ' + (hours !== null ? `within ${hours} h of signing`
        : `by ${shown(get(t, 'deliver_by'))} as in their offer (rounded down to the hour, at least 1 h after signing)`),
      '  your agent changes: ' + (changes.join(', ') || 'nothing') + '; the counter-offer stays open 24 h',
      `If ${who} accepts it, the deal is binding without asking you again: ` + owes(chk.role, who, price),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine(`Counter-offer text, with what your agent did not change copied from ${who}'s offer`,
        Object.fromEntries(TEXT_FIELDS.map(k => [k, truthy(get(a, k)) ? item(a, k) : get(svc, k)])))].join('\n');
  }

  async #textReview(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service, dl = chk.delivery, content = chk.content;
    const m = await measure(content, TEXT_FIELDS.map(k => str(or(get(svc, k), ''))).join(' '), {checkHosts: false});
    const facts = m.checks_against_agreed_terms.map(x => `${x.requirement}: ${x.measured} (${x.met ? 'met' : 'NOT met'})`);
    let exact;
    try {
      exact = checkDelivery(t, content);
    } catch {                                         // a malformed result block is a fact to show, not a reason to hide the prompt
      exact = null;
      facts.push('exact result: could not be checked');
    }
    if (truthy(exact) && truthy(get(exact, 'checked'))) {
      facts.push('exact result: ' + (truthy(get(exact, 'exact_result_matches')) ? 'matches the agreed text'
        : 'DOES NOT MATCH (differs in ' + iterate(or(get(exact, 'differs_in'), [])).map(k => shown(k)).join(', ') + ')'));
    }
    return [
      `Valun - ACCEPT ${who}'s delivery (${shown(chk.other_id)}, deal ${shown(t.deal_id)}) and ISSUE A CREDIT NOTE `
        + `of ${price} PC to ${who}:`,
      `  delivered: ${utf8(content).length} bytes, sha256 ${chk.sha256.slice(0, 16)}... (recomputed from the text measured here)`,
      '  measured: ' + (facts.join('; ') || `${m.word_count} words, ${m.links.length} links`),
      `  agreed terms hash ${chk.terms_hash.slice(0, 16)}... (your Valun client checks both hashes again before signing)`,
      `Your agent signs a Basis note; the pilot tracker then records that you owe ${who} ${price} PC more.`,
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine('Delivery title and agreed service text', {delivery_title: or(get(dl, 'title'), ''), title: get(svc, 'title'),
        deliverable: get(svc, 'deliverable')})].join('\n');
  }

  /** A delivery acceptance paid with a held note (pay_with): what moves, from the checked transfer template. */
  async #textPay(a, snap) {
    const chk = snap.checked, tr = snap.transfer;
    const t = chk.terms, svc = chk.service, dl = chk.delivery, content = chk.content, price = chk.price;
    const payee = this.#who(chk);
    const iss = tr.issuer;
    const issuer = typeof get(iss, 'handle') === 'string' && iss.handle ? shown(iss.handle) : shown(iss.id);
    const x = tr.claim, y = tr.to_prior;
    const speed = get(tr.option, 'issuer_consents');
    const m = await measure(content, TEXT_FIELDS.map(k => str(or(get(svc, k), ''))).join(' '), {checkHosts: false});
    const facts = m.checks_against_agreed_terms.map(f => `${f.requirement}: ${f.measured} (${f.met ? 'met' : 'NOT met'})`);
    let exact;
    try {
      exact = checkDelivery(t, content);
    } catch {                                         // a malformed result block is a fact to show, not a reason to hide the prompt
      exact = null;
      facts.push('exact result: could not be checked');
    }
    if (truthy(exact) && truthy(get(exact, 'checked'))) {
      facts.push('exact result: ' + (truthy(get(exact, 'exact_result_matches')) ? 'matches the agreed text'
        : 'DOES NOT MATCH (differs in ' + iterate(or(get(exact, 'differs_in'), [])).map(k => shown(k)).join(', ') + ')'));
    }
    const speedWords = typeof speed === 'string' && Object.hasOwn(CONSENT_SPEED_WORDS, speed) ? CONSENT_SPEED_WORDS[speed] : shown(speed);
    return [
      `Valun - PAY ${payee} ${price} PC for deal ${shown(t.deal_id)} by moving ${price} PC of ${issuer}'s debt from you `
        + `to ${payee}:`,
      `  your claim on ${issuer}: ${x} -> ${x - price} PC (issuer signature checked by your client)`,
      `  ${issuer} will owe ${payee} ${y} -> ${y + price} PC; its total debt does not change`,
      '  you issue no credit note for this deal',
      `  ${issuer} consents ${speedWords}; accepting is final: if the transfer does not `
        + 'complete the deal stays accepted and you pay later',
      `  ${issuer} is ${shown(iss.id)} and ${payee} is ${shown(chk.other_id)}; quote ${tr.quote_digest.slice(0, 16)}... `
        + '(computed by your Valun client; it checks it again before signing)',
      `  you accept the delivery: ${utf8(content).length} bytes, sha256 ${chk.sha256.slice(0, 16)}... (recomputed from `
        + 'the text measured here); agreed terms hash ' + chk.terms_hash.slice(0, 16) + '...',
      '  measured: ' + (facts.join('; ') || `${m.word_count} words, ${m.links.length} links`),
      get(snap, 'not_settled', NOT_SETTLED_CIRCULATION),
      quoteLine('Delivery title and agreed service text', {delivery_title: or(get(dl, 'title'), ''), title: get(svc, 'title'),
        deliverable: get(svc, 'deliverable')})].join('\n');
  }

  // ---------- tools ----------
  async status(a) {
    const brief = isDict(a) && 'brief' in a ? a.brief : this.briefStatus;
    if (typeof brief !== 'boolean') throw new ValunError('bad_arguments', 'brief must be true or false');
    const out = await this.#fullStatus();
    return brief ? briefStatus(out) : out;
  }

  async #fullStatus() {
    const c = this.client();
    const me = await c.me(), info = await c.info();
    const circulating = this.#remember(info).includes(CIRCULATION);
    const lab = labels(circulating);
    const recorded = or(get(me, 'agent_limits'), {});
    let approvals = or(this.approvals, 'Commitments are signed without asking your owner first.');
    approvals += ` The server also holds commitments priced above ${str(get(item(me, 'mandate'), 'approve_above'))} PC for the owner console.`;
    const inForce = or(get(me, 'effective_limits'), item(me, 'mandate'));
    const out = {
      connected: true, server: item(c.state, 'server'), network: item(info, 'network'),
      unit: item(info, 'unit') + ' (pilot credits, no monetary value)',
      you: item(me, 'participant'), objective_from_your_owner: or(get(item(me, 'mandate'), 'objective'), '(none set)'),
      goals_your_owner_told_you: or(get(recorded, 'notes'), '(none recorded yet: ask your owner, then use valun_set_limits)'),
      limits_you_recorded: Object.fromEntries(items(recorded).filter(([k]) => k !== 'notes' && k !== 'set_at')),
      limits_in_force: Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [arg, get(inForce, field)])),
      mandate: Object.fromEntries(items(item(me, 'mandate')).filter(([k]) => k !== 'objective')), mandate_version: item(me, 'mandate_version'),
      approvals, position: item(me, 'position'), authority: item(me, 'authority'), settlement: lab.settlement,
      honest_labels: {...lab.honest_labels}, real_vs_simulated: {...lab.real_vs_simulated},
    };
    if (circulating) Object.assign(out, await this.#circulationStatus(c, me));
    return out;
  }

  /**
   * valun_status with circulating credit: what you hold and owe, the notes you can spend (each checked against the
   * issuer's signature on the tracker state GET /edges shows), payments in progress, what your client clears by itself,
   * and for a sandbox_only participant the next tool calls of the five-step tour.
   */
  async #circulationStatus(c, me) {
    const pos = isDict(get(me, 'position')) ? me.position : {};
    let box;
    try {
      box = await c.inbox();
    } catch (e) {
      if (!isValunError(e)) throw e;
      box = {};
    }
    box = isDict(box) ? box : {};
    let verified;
    try {
      verified = (await c.syncEdges()).edges;
    } catch (e) {
      if (!isValunError(e)) throw e;
      verified = {};
    }
    const notes = this.#notesYouCanSpend(c, pos, verified);
    const policy = consentPolicyInForce(get(c.state, 'consent_policy'), ['effective_limits', 'mandate'].map(k => get(me, k)).find(isDict) ?? null);
    const signs = clientSigns(policy);
    const hold = get(pos, 'claims_held'), owe = get(pos, 'owes'), net = get(pos, 'net');
    const cleared = get(pos, 'cleared_by_setoff', get(pos, 'settled', 0));
    let pending = get(box, 'consents_waiting_for_your_client');
    if (pending === null && isDict(get(pos, 'pending'))) pending = get(pos.pending, 'consents_waiting_for_you');
    const log = Array.isArray(get(c.state, 'consent_log')) ? c.state.consent_log : [];
    const spend = notes.reduce((t, n) => t + n.amount_PC, 0);
    const summary = `You hold ${shown(hold)} PC of credit notes others issued to you and owe ${shown(owe)} PC (net ${shown(net)} PC); `
      + `set-offs have cleared ${shown(cleared)} PC so far. `
      + (notes.length ? `You can spend ${spend} PC of notes you hold (${notes.map(n => shown(n.issuer)).join(', ')}) with pay_with `
        + 'when you accept a delivery. ' : 'You hold no notes you can spend now. ')
      + (signs.length ? 'Your Valun client signs by itself: ' + signs.join('; ') + '.' : 'Your Valun client signs no consents by itself.')
      + (whole(pending) && pending > 0 ? ` ${pending} consent(s) wait for your client.` : '');
    const out = {summary,
      money_view: {you_hold_PC: hold, you_owe_PC: owe, net_PC: net, cleared_so_far_PC: cleared,
        how_to_read: 'hold: credit notes others issued to you that are still outstanding (what they '
          + 'owe you); owe: your own outstanding notes; net = hold - owe. Paying with a note '
          + 'you hold moves it to the payee (hold falls by the price); a set-off cancels equal '
          + 'claims and debts around a cycle (hold and owe fall together, net does not change); '
          + 'cleared_so_far counts what set-offs cancelled. Nothing is redeemed and PC have '
          + 'no value.'},
      notes_you_can_spend: notes,
      payments_in_progress: Array.isArray(get(box, 'payments_in_progress')) ? box.payments_in_progress : [],
      clearing: {your_client_signs: signs, consents_pending: pending,
        recent: log.slice(-5).filter(isDict).map(e => Object.fromEntries(['at', 'kind', 'decision', 'code', 'amount', 'your_net_change_PC']
          .map(k => [k, get(e, k)])))},
      consent_policy_in_force: policy};
    const participant = isDict(get(me, 'participant')) ? me.participant : {};
    if (get(participant, 'sandbox_only') === true) out.sandbox_next_steps = await this.#sandboxNextSteps(c, participant, pos, box, notes);
    return out;
  }

  /**
   * The notes I hold that the server says I can spend now (position.spendable_notes; else the claims), each marked
   * checked_by_your_client when the tracker state of that edge, as GET /edges showed it, carries the issuer's valid
   * signature over a total that covers the amount.
   */
  #notesYouCanSpend(c, pos, verified) {
    let rows = get(pos, 'spendable_notes');
    if (!Array.isArray(rows)) {
      const claims = get(pos, 'claims');
      rows = (Array.isArray(claims) ? claims : []).filter(isDict).map(r => ({issuer_id: get(r, 'issuer_id'), issuer_handle: get(r, 'from'),
        issuer_pubkey: get(r, 'issuer_pubkey'), spendable: get(r, 'amount'), issuer_consents: null}));
    }
    const out = [];
    for (const n of rows) {
      if (!isDict(n)) continue;
      const amount = get(n, 'spendable');
      const name = or(get(n, 'issuer_handle'), or(get(n, 'handle'), get(n, 'issuer_id')));
      if (!(whole(amount) && amount > 0 && typeof name === 'string' && name)) continue;
      const st = isDict(verified) ? get(verified, `${str(get(n, 'issuer_pubkey'))}>${c.pubkey}`) : null;
      out.push({issuer: name, amount_PC: amount,
        checked_by_your_client: isDict(st) && whole(get(st, 'total')) && st.total >= amount,
        issuer_consents: get(n, 'issuer_consents'),
        how: `valun_review_delivery decision='accept' pay_with=${quoted(name)}: pays a delivery by moving that `
          + 'much of their debt to you onto the payee'});
    }
    return out;
  }

  /**
   * The exact next tool calls of the five-step sandbox tour (design 9.2), from the inbox and the position: answer what
   * waits for you first (an offer, a delivery to make, a delivery to review), then the next deal of the tour from what
   * you hold and owe. Wait (no calls) while the sandbox agents or a set-off are working.
   */
  async #sandboxNextSteps(c, participant, pos, box, notes) {
    const amount = (rows, key, who) => (Array.isArray(rows) ? rows : [])
      .filter(r => isDict(r) && get(r, key) === who && whole(get(r, 'amount'))).reduce((t, r) => t + r.amount, 0);
    const hx = amount(get(pos, 'claims'), 'from', SANDBOX_EXACT), hm = amount(get(pos, 'claims'), 'from', SANDBOX_MALLORY);
    const ox = amount(get(pos, 'debts'), 'to', SANDBOX_EXACT);
    const spendable = new Map(notes.map(n => [n.issuer, n.amount_PC]));
    const listed = Object.fromEntries(['respond', 'deliver', 'review_delivery', 'waiting_on_others', 'awaiting_your_owner', 'recent_closed']
      .map(k => [k, (Array.isArray(get(box, k)) ? box[k] : [])
        .filter(x => isDict(x) && (SANDBOX_AGENTS.includes(get(x, 'counterparty')) || k === 'awaiting_your_owner'))]));
    const held = {[SANDBOX_EXACT]: {you_hold_PC: hx, you_owe_PC: ox}, [SANDBOX_MALLORY]: {you_hold_PC: hm, you_owe_PC: 0}};
    const notary = sandbox.SERVICES.notary.price;
    const stepOf = (cp, role) => (cp === SANDBOX_EXACT ? (role === 'payee' ? 1 : (hm >= notary ? 5 : 3)) : (role === 'payer' ? 2 : 4));
    const plan = (step, calls, then) => {
      const done = whole(step) && Object.hasOwn(TOUR_AFTER, step) ? TOUR_AFTER[step] : null;
      return {tour_step: step, of: 5, goal: whole(step) && Object.hasOwn(TOUR_GOALS, step) ? TOUR_GOALS[step] : 'The tour is complete.',
        next_calls: calls, then, with_the_sandbox_agents: held,
        ...(done ? {when_done: {you_hold_PC: done[0], you_owe_PC: done[1]}} : {})};
    };
    const call = (tool, args, why) => ({tool, arguments: args, why});
    const offer = (step, cp, role, service) => {
      const price = sandbox.SERVICES[service].price;
      const args = {counterparty: cp, role, title: `${service} job`,
        description: `${service} for this text:\n\`\`\`\n${TOUR_TEXTS[step]}\n\`\`\``,
        deliverable: `The exact ${service} result as JSON.`, price, deliver_within_hours: 24, offer_valid_hours: 1};
      const why = role === 'payer' ? `buy ${service} from ${cp} for ${price} PC` : `offer to sell ${service} to ${cp} for ${price} PC`;
      return plan(step, [call('valun_propose', args, why)], `${cp} answers within a few seconds; call valun_status again for the next step.`);
    };
    const wait = 'The sandbox agents act within a few seconds: call valun_status again.';
    if (listed.awaiting_your_owner.length) {
      const x = listed.awaiting_your_owner[0];
      return plan(null, [], `Your owner must first approve deal ${shown(get(x, 'deal_id'))} in the owner console; then call `
        + 'valun_status again.');
    }
    for (const x of listed.review_delivery) {
      const did = get(x, 'deal_id'), cp = get(x, 'counterparty');
      const step = stepOf(cp, 'payer');
      let d;
      try {
        d = await c.deal(did);
      } catch (e) {                                   // one deal that cannot be read now never fails the whole status
        if (!isValunError(e)) throw e;
        return plan(step, [], `Deal ${shown(did)} could not be read just now (${shown(e.code)}); call valun_status again in a few seconds.`);
      }
      const terms = isDict(d) ? or(get(or(get(d, 'current'), {}), 'terms'), {}) : {};
      const dl = isDict(d) ? or(get(d, 'delivery'), {}) : {};
      const price = get(or(get(terms, 'price'), {}), 'amount');
      let exact;
      try {
        exact = checkDelivery(terms, get(dl, 'content'));
      } catch {                                       // an unreadable result block is a wrong one
        exact = {checked: true, exact_result_matches: false, differs_in: ['the result block'], service: sandbox.whichService(terms)};
      }
      if ((isDict(d) && get(d, 'status') === 'payment_due') || (truthy(exact) && truthy(get(exact, 'exact_result_matches')))) {
        const other = cp === SANDBOX_EXACT ? SANDBOX_MALLORY : SANDBOX_EXACT;
        const pay = whole(price) && (spendable.get(other) ?? 0) >= price ? other : 'own_note';
        const args = {deal_id: did, decision: 'accept', expected_deliverable_sha256: get(dl, 'sha256'), pay_with: pay};
        const why = 'the delivery matches the exact result of the agreed text: accept it and pay '
          + (pay === 'own_note' ? 'with your own credit note' : `with the note ${pay} issued to you`);
        return plan(step, [call('valun_review_delivery', args, why)],
          'Payment by transfer applies at once with the sandbox agents; call valun_status again.');
      }
      const fields = iterate(or(get(or(exact, {}), 'differs_in'), ['the result'])).map(k => str(k)).join(', ');
      const reason = `The delivered result does not match the exact ${str(or(get(or(exact, {}), 'service'), 'result'))} of the agreed `
        + `text (differs in: ${fields}).`;
      return plan(step, [call('valun_review_delivery', {deal_id: did, decision: 'dispute', reason},
        'the delivery is wrong: dispute it (nothing is paid), then buy again')],
      'After the dispute, call valun_status again: the next call buys again.');
    }
    for (const x of listed.deliver) {
      return plan(stepOf(get(x, 'counterparty'), 'payee'),
        [call('valun_deliver', {deal_id: get(x, 'deal_id'), exact_result: true}, 'deliver the exact result your Valun client computes from the agreed text')],
        `${str(get(x, 'counterparty'))} checks it exactly and pays within a few seconds; call valun_status again.`);
    }
    for (const x of listed.respond) {
      const role = get(x, 'your_role'), price = isDict(get(x, 'price')) ? get(x.price, 'amount') : null;
      const ok = role === 'payee' || (whole(price) && price <= Math.max(...Object.values(sandbox.SERVICES).map(s => s.price)));
      const args = ok ? {deal_id: get(x, 'deal_id'), action: 'accept'}
        : {deal_id: get(x, 'deal_id'), action: 'decline', reason: 'above the published price'};
      return plan(stepOf(get(x, 'counterparty'), role),
        [call('valun_respond', args, ok ? 'accept the offer (your Valun client checks its signature and terms)'
          : 'decline: the price is above the published one')],
        'Then deliver (or wait for the delivery); call valun_status again.');
    }
    if (listed.waiting_on_others.length) {
      const x = listed.waiting_on_others[0];
      return plan(stepOf(get(x, 'counterparty'), get(x, 'your_role')), [], wait);
    }
    const deals = isDict(get(pos, 'deals')) ? pos.deals : {};
    const count = bucket => (whole(get(deals, bucket)) && deals[bucket] > 0 ? deals[bucket] : 0);
    // A deal agreed and not yet paid (position bucket agreed_note_not_issued) that no inbox list above shows: its credit
    // note is being recorded (the inbox lists issuing_note in no section, nor note_failed for the payee), or it was paid
    // between the GET /me these holdings come from and the GET /inbox read after it. Either way its note is not in the
    // holdings yet: wait, never start another deal on them (that sold a second job to sandbox-exact).
    if (count('agreed_note_not_issued')) {
      return plan(ox > 0 ? 4 : 1, [], 'A deal of yours with a sandbox agent is being paid (its credit note is being '
        + 'recorded on the tracker); wait for it: call valun_status again in a few seconds.');
    }
    if ((hx > 0 || hm > 0) && ox > 0) {
      return plan(hx > 0 ? 3 : 4, [], 'A set-off of the cycle is due: your Valun client signs it by itself at its '
        + 'next consent run (within about a minute). Call valun_status again.');
    }
    const paidByTransfer = count('paid_by_transfer');
    let cleared = get(pos, 'cleared_by_setoff', get(pos, 'settled', 0));
    cleared = whole(cleared) && cleared > 0 ? cleared : 0;
    if (hm >= notary) return offer(5, SANDBOX_EXACT, 'payer', 'notary');
    if (hx >= notary && paidByTransfer === 0) return offer(2, SANDBOX_MALLORY, 'payer', 'notary');
    if (hx > 0) return offer(3, SANDBOX_EXACT, 'payer', 'notary');   // once step 2 paid by transfer: pay sandbox-exact with your own note
    if (ox > 0) return offer(4, SANDBOX_MALLORY, 'payee', 'text-stats');
    if (paidByTransfer > 0 && cleared > 0) return plan('done', [], ValunAgent.#tourDoneText(pos, cleared));
    const anyExact = Object.values(listed).some(xs => xs.some(x => get(x, 'counterparty') === SANDBOX_EXACT));
    if (!anyExact && recentlyActive(null, 10 / 60, get(participant, 'joined_at'), this.#now())) {
      return plan(1, [], 'The welcome job from sandbox-exact usually arrives within a minute of joining; call '
        + 'valun_status again.');
    }
    const p = offer(1, SANDBOX_EXACT, 'payee', 'text-stats');
    if (paidByTransfer > 0) {                         // spent by transfer, but no set-off has cleared anything: not done yet
      p.then = 'The tour is not complete: no set-off has cleared any of your claims or debts yet, and you hold no '
        + "note to spend now. Earn sandbox-exact's note again; then pay sandbox-exact with your own note, and "
        + 'the 2-cycle that forms is cleared by a set-off. sandbox-exact answers within a few seconds; call '
        + 'valun_status again for the next step.';
    }
    return p;
  }

  /**
   * What the tour did, from the participant's own position: earned (hold + spent by transfer + cleared), spent by
   * transfer (transferred_out) and with its own notes (owes + cleared), and what set-offs cleared. Only a set-off that
   * cleared something (cleared > 0) ends the tour, so this never claims one that did not happen.
   */
  static #tourDoneText(pos, cleared) {
    const hold = get(pos, 'claims_held'), owe = get(pos, 'owes'), out = get(pos, 'transferred_out');
    let text = 'The tour is complete: ';
    if (whole(hold) && whole(owe) && whole(out)) {
      text += `you earned ${hold + out + cleared} PC and spent ${out + owe + cleared} PC (${out} by transfer, `
        + `${owe + cleared} with your own note), and `;
    }
    text += `set-offs cancelled ${cleared} PC of your claims and ${cleared} PC of your debts without changing your net `
      + 'position.';
    if ((whole(hold) && hold > 0) || (whole(owe) && owe > 0)) text += ` You still hold ${shown(hold)} PC and owe ${shown(owe)} PC.`;
    return text + ' You can keep trading with the sandbox agents.';
  }

  async setLimits(a) {
    const c = this.client();
    const body = limitsBody(a);
    if (!truthy(body)) throw new ValunError('nothing_to_record', "give at least one limit, a limit to clear, or your owner's goals");
    const r = await c.setLimits(body);
    const eff = or(get(r, 'effective_limits'), {});
    return {recorded: get(r, 'agent_limits'), limits_in_force: Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [arg, get(eff, field)])),
      what_this_means: "The Valun server now enforces these limits at every action, together with your owner's mandate "
        + '(the stricter of the two applies). Only your owner can raise the mandate.'};
  }

  async directory(a) {
    const c = this.client();
    const q = lower(or(get(a, 'query'), ''));
    const out = [];
    for (const p of iterate(await c.directory())) {
      if (item(p, 'id') === c.participantId || item(p, 'status') !== 'active') continue;
      const text = lower(['handle', 'display_name', 'about', 'services'].map(k => str(or(get(p, k), ''))).join(' '));
      if (q && !text.includes(q)) continue;
      const pos = get(await c.participant(item(p, 'id')), 'public_position', {});
      out.push({handle: item(p, 'handle'), id: item(p, 'id'), name: item(p, 'display_name'), operator: item(p, 'operator'), about: item(p, 'about'),
        services: item(p, 'services'), credit_notes_they_hold_PC: get(pos, 'claims_held'), credit_notes_they_owe_PC: get(pos, 'owes'),
        deals: get(pos, 'deals'), agent_last_seen: get(p, 'agent_last_seen'),
        agent_recently_active: recentlyActive(get(p, 'agent_last_seen'), 24, get(p, 'joined_at'), this.#now())});
    }
    out.sort((x, y) => Number(!x.agent_recently_active) - Number(!y.agent_recently_active));   // stable: active first
    return {participants: out, note: 'positions are outstanding credit notes recorded by the pilot Basis tracker; nothing is settled; '
      + 'PC have no value. A participant whose agent has not been seen in the last 24 hours may never answer an offer.'};
  }

  async inbox() {
    return this.client().inbox();
  }

  async deal(a) {
    const c = this.client();
    const d = await c.deal(item(a, 'deal_id'));
    const out = Object.fromEntries(DEAL_FIELDS.map(k => [k, get(d, k)]));
    if (truthy(get(d, 'pending_counter'))) {
      const pc = item(d, 'pending_counter');
      out.your_counter_offer_awaiting_owner = {version: item(pc, 'version'), state: item(pc, 'state'), terms: get(pc, 'terms'),
        terms_hash: item(pc, 'terms_hash'), note: 'the other side cannot see it until your owner approves it'};
    }
    const cur = or(get(d, 'current'), {}), st = get(d, 'status');
    if (st === 'open' && truthy(cur)) {
      out.whose_turn = get(cur, 'by') !== c.participantId ? 'yours: accept, counter or decline'
        : 'theirs: your offer is open; you cannot accept your own offer, only withdraw it or wait';
    } else if (st === 'agreed') {
      out.whose_turn = get(d, 'your_role') === 'payee' ? 'yours: deliver the work' : 'theirs: they deliver';
    } else if (st === 'delivered' || st === 'note_failed') {
      out.whose_turn = get(d, 'your_role') === 'payer' ? 'yours: accept the delivery or dispute it' : 'theirs: they review your delivery';
    } else if (st === 'paying_by_transfer') {
      out.whose_turn = get(d, 'your_role') === 'payer'
        ? 'theirs: the issuer and the payee sign the debt transfer that pays this deal (your Valun client signed your part)'
        : 'theirs: the debt transfer that pays you collects its signatures (your Valun client signs yours by itself if your owner allows it)';
    } else if (st === 'payment_due') {
      out.whose_turn = get(d, 'your_role') === 'payer'
        ? "yours: you accepted the delivery but it is not paid yet; pay it with valun_review_delivery decision='accept' (see how_you_can_pay)"
        : 'theirs: the payer accepted your delivery and must still pay it';
    } else if (st === 'paid_by_transfer') {
      out.whose_turn = 'nobody: the deal is paid by debt transfer';
    } else {
      out.whose_turn = `nobody: the deal is ${str(st)}`;
    }
    const current = item(d, 'current');
    out.current_terms = truthy(current) ? {version: item(current, 'version'), by: item(current, 'by'), state: item(current, 'state'),
      terms: item(current, 'terms'), terms_hash: item(current, 'terms_hash')} : current;
    if (get(d, 'status') === 'open' && truthy(get(d, 'current'))) {
      try {
        const chk = await c.verifyOffer(d);
        out.checked_by_your_client = {terms_hash_recomputed: item(chk, 'terms_hash'), proposer_signature_valid: true};
      } catch (e) {
        if (!isValunError(e)) throw e;
        out.checked_by_your_client = {problem: e.code, message: e.message, advice: 'do not accept these terms'};
      }
    }
    if (truthy(get(d, 'delivery'))) {
      const dl = item(d, 'delivery');
      const content = item(dl, 'content');
      const body = cpLength(content) <= 16000 ? content
        : cpSlice(content, 16000) + '\n[... truncated for display; full text is on the server ...]';
      out.delivery = {title: get(dl, 'title'), sha256: item(dl, 'sha256'), bytes: item(dl, 'bytes'), late: get(dl, 'late'), content: body};
      const reviewing = get(d, 'your_role') === 'payer' && ['delivered', 'note_failed'].includes(get(d, 'status'));
      out.delivery.measured_by_your_client = await measure(content, termsText(d), this.#measureOptions(reviewing && this.checkLinkHosts));
      const exact = checkDelivery(or(get(or(get(d, 'current'), {}), 'terms'), {}), content);
      if (exact !== null) {
        out.delivery.checked_exactly_by_your_client = exact;
        if (reviewing && truthy(exact.checked) && !truthy(exact.exact_result_matches)) {
          out.delivery.advice = 'The delivered result does not match the exact result of the agreed text '
            + `(differs in: ${or(exact.differs_in, ['the result block']).join(', ')}). `
            + 'Dispute it with that reason instead of issuing a credit note.';
        }
      }
    }
    if (truthy(get(d, 'credit_note'))) {
      const n = item(d, 'credit_note');
      const tn = or(get(n, 'tracker_note'), {});
      out.credit_note = {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        tracker_cumulative_total_PC: get(tn, 'amount_collected'), confirmation: get(tn, 'confirmation'),
        verified_by_valun: get(n, 'verified_by_valun'), outstanding: get(n, 'outstanding'), settled: get(n, 'settled', false),
        issuer_pubkey: get(n, 'issuer_pubkey'), recipient_pubkey: get(n, 'recipient_pubkey')};
      if (truthy(get(n, 'signature_withheld'))) out.credit_note.signature = 'withheld until the Basis tracker records the note';
    }
    if ((get(d, 'payment') ?? null) !== null) out.payment = d.payment;   // circulating credit: the payment by transfer, as shown
    if (get(d, 'your_role') === 'payer' && PAYABLE.includes(st) && await this.#offersCirculation(c, d)) {
      try {
        out.how_you_can_pay = await ValunAgent.#howYouCanPay(c, item(a, 'deal_id'));
      } catch (e) {
        if (!isValunError(e)) throw e;
        out.how_you_can_pay = {problem: e.code, message: e.message};
      }
    }
    out.history = get(d, 'history', []).slice(-12);
    const them = get(or(get(d, 'counterparty'), {}), 'handle');
    const prices = iterate(or(get(d, 'versions'), [])).map(v => {
      const n = item(v, 'version'), who = item(v, 'by') === c.participantId ? 'you' : them;
      return [n, who, item(item(v, 'price'), 'amount')];
    });
    if (prices.length) {
      out.negotiation = {prices_by_version: prices.map(([n, who, p]) => `v${str(n)} ${str(who)}: ${str(p)} PC`)};
      const mine = prices.filter(([, who]) => who === 'you').map(([, , p]) => p).slice(-2);
      const theirs = prices.filter(([, who]) => who !== 'you').map(([, , p]) => p).slice(-2);
      if (mine.length === 2 && theirs.length === 2 && pyEq(mine[0], mine[1]) && pyEq(theirs[0], theirs[1]) && !pyEq(mine[0], theirs[0])) {
        out.negotiation.stalemate = `Both sides have repeated the same price (${str(mine[0])} vs ${str(theirs[0])} PC). If no price `
          + 'within your limits works for the other side, decline with a reason instead of countering again.';
      }
    }
    return out;
  }

  /**
   * Does the server offer circulation/1, for valun_deal? The features this agent already knows when it knows them; else
   * one GET /info, only for a deal view that carries the `payment` key (with circulation off, valun_deal makes no request
   * more than 0.3; decision D-2 h). false when /info cannot be read: the view is then as without circulation.
   */
  async #offersCirculation(c, d = null) {
    if (this.features !== null) return this.features.includes(CIRCULATION);
    if (!(isDict(d) && Object.hasOwn(d, 'payment'))) return false;
    try {
      return this.#remember(await c.info()).includes(CIRCULATION);
    } catch (e) {
      if (isValunError(e)) return false;
      throw e;
    }
  }

  /**
   * The payer's ways to pay a delivered (or note_failed, payment_due) deal, from GET payment-options: the own note and
   * each note held, with the exact pay_with value. The server's view, for choosing: what is finally signed is checked
   * again by the client (and asked of the owner with its own text).
   */
  static async #howYouCanPay(c, dealId) {
    let opts = await c.paymentOptions(dealId);
    opts = isDict(opts) ? opts : {};
    const own = isDict(get(opts, 'own_note')) ? opts.own_note : {};
    const options = [{pay_with: 'own_note', available: get(own, 'available') === true, why_not: get(own, 'why_not')}];
    for (const h of Array.isArray(get(opts, 'held_notes')) ? opts.held_notes : []) {
      if (!isDict(h) || !isDict(get(h, 'issuer'))) continue;
      const iss = h.issuer;
      options.push({pay_with: or(get(iss, 'handle'), get(iss, 'id')), issuer_id: get(iss, 'id'), operator_run: get(iss, 'operator_run'),
        spendable_PC: get(h, 'spendable'), enough: get(h, 'enough'), payee_accepts: get(h, 'payee_accepts'),
        issuer_consents: get(h, 'issuer_consents'), payee_consents: get(h, 'payee_consents'),
        available: get(h, 'why_not') === null && get(h, 'enough') === true, why_not: get(h, 'why_not')});
    }
    return {options, pending_transfer: get(opts, 'pending_transfer'), fallback_after: get(opts, 'fallback_after'),
      how: "valun_review_delivery decision='accept' with pay_with set to an available option (own_note issues your "
        + 'own credit note; a handle passes on a note you hold). Accepting is final: if a transfer does not '
        + 'complete, the deal stays accepted and you pay later.'};
  }

  async propose(a) {
    const c = this.client();
    const other = await this.#resolve(c, item(a, 'counterparty'));
    // A seller of exactly checkable work publishes that it needs the text in the description; check before signing.
    if (get(a, 'role') === 'payer' && str(or(get(other, 'services'), '')).includes('``` block')
        && extractText(or(get(a, 'description'), '')) === null) {
      throw new ValunError('missing_text',
        `Not signed. ${str(item(other, 'handle'))} needs the text to process inside the description, and yours has none. Put the `
        + 'exact text in a ``` fenced block in the description (or as the only "quoted" string, or after TEXT: at the '
        + 'end), then make the offer again.');
    }
    const counterpartyId = item(other, 'id'), role = item(a, 'role'), title = item(a, 'title'), description = item(a, 'description');
    const deliverable = item(a, 'deliverable'), price = int(item(a, 'price'));
    const deliverByHours = int(or(get(a, 'deliver_within_hours'), 48)), offerTtlHours = int(or(get(a, 'offer_valid_hours'), 24));
    const r = await c.propose({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours});
    const waiting = item(r, 'status') === 'proposed_awaiting_owner';
    const idle = recentlyActive(get(other, 'agent_last_seen'), 24, get(other, 'joined_at'), this.#now()) ? null
      : `${str(item(other, 'handle'))}'s agent has not been seen in the last 24 hours; it may never answer. Consider an active seller too.`;
    const handle = str(item(other, 'handle')), shownPrice = str(item(a, 'price'));
    return {deal_id: item(r, 'id'), status: item(r, 'status'),
      terms_hash: truthy(get(r, 'current')) ? item(item(r, 'current'), 'terms_hash') : null,
      what_happened: waiting ? `Your signed offer is waiting for your owner's approval before ${handle} can see it.`
        : `${handle} can now accept, decline or counter your signed offer.`,
      if_agreed: item(a, 'role') === 'payer'
        ? `After you accept their delivery you issue them a credit note of ${shownPrice} PC (you will owe them; not settled).`
        : `After they accept your delivery they issue you a credit note of ${shownPrice} PC (they will owe you; not settled).`,
      ...(idle ? {warning: idle} : {})};
  }

  async respond(a) {
    const c = this.client();
    const act = item(a, 'action'), did = item(a, 'deal_id');
    let r;
    if (act === 'accept') {
      r = await c.accept(did, {expectedTermsHash: get(a, 'expected_terms_hash')});
    } else if (act === 'decline') {
      if (!truthy(strip(or(get(a, 'reason'), '')))) {
        throw new ValunError('reason_required', 'a decline needs a short reason: the other side reads it and may make a better offer');
      }
      r = await c.decline(did, strip(item(a, 'reason')));
    } else if (act === 'withdraw') {
      r = await c.withdraw(did);
    } else if (act === 'counter') {
      r = await c.counter(did, {price: get(a, 'price'), title: get(a, 'title'), description: get(a, 'description'),
        deliverable: get(a, 'deliverable'), deliverByHours: get(a, 'deliver_within_hours'), expectedTermsHash: get(a, 'expected_terms_hash')});
    } else {
      throw new ValunError('bad_action', 'action must be accept, decline, counter or withdraw');
    }
    const held = act === 'counter' && truthy(get(r, 'pending_counter'));
    const explain = {agreed: 'Agreement formed: both sides have signed the same terms.',
      accepted_awaiting_owner: 'You signed the acceptance; it becomes binding when the owner holding it approves '
        + "(yours, or the proposer's if their limits require it; valun_deal shows which).",
      open: held ? "Your signed counter-offer waits for your owner's approval; the other side cannot see it yet."
        : act === 'counter' ? 'Your counter-offer is open for the other side.' : 'The offer is open.',
      declined: 'You declined; nothing is owed.', withdrawn: 'Your offer is withdrawn.'};
    const status = item(r, 'status');
    return {deal_id: did, status, what_happened: typeof status === 'string' && Object.hasOwn(explain, status) ? explain[status] : status,
      next_actions: get(r, 'next_actions')};
  }

  async deliver(a) {
    const c = this.client();
    const exact = get(a, 'exact_result');
    if (exact !== null && typeof exact !== 'boolean') throw new ValunError('bad_arguments', 'exact_result is true or false');
    if (exact) {
      if (get(a, 'content') !== null) {
        throw new ValunError('bad_arguments', 'with exact_result your Valun client computes the content: omit content');
      }
      return ValunAgent.#deliverExact(c, a);
    }
    if (typeof get(a, 'content') !== 'string' || !a.content) {
      throw new ValunError('bad_arguments', 'give content (the complete deliverable), or exact_result=true for a text-stats '
        + 'or notary job');
    }
    const d = await c.deal(item(a, 'deal_id'));
    const m = await measure(item(a, 'content'), termsText(d), this.#measureOptions(this.checkLinkHosts));
    const problems = m.checks_against_agreed_terms.filter(x => !x.met).map(x => `${x.requirement}: measured ${x.measured}`);
    if (truthy(m.warning ?? null)) problems.push(m.warning);
    if (problems.length && !truthy(get(a, 'send_anyway'))) {
      throw new ValunError('draft_does_not_meet_terms', 'Not sent. Your draft does not meet the agreed terms as measured: '
        + problems.join(' | ') + ' Fix it and deliver again (send_anyway=true only if you are sure; '
        + 'the payer sees the same measurements).', undefined, {measured: m});
    }
    const r = await c.deliver(item(a, 'deal_id'), item(a, 'content'), {title: or(get(a, 'title'), '')});
    return {deal_id: item(r, 'id'), status: item(r, 'status'), sha256: item(item(r, 'delivery'), 'sha256'),
      what_happened: 'Delivered and signed. The payer will accept it (issuing you a credit note) or dispute it.'};
  }

  /**
   * valun_deliver exact_result: the exact text-stats or notary result of the agreed text (the agreement's terms, checked
   * by hash and both signatures), rendered as sandbox.render() does and delivered. not_exact_service for any other job,
   * or when the agreed description carries no text to process.
   */
  static async #deliverExact(c, a) {
    const d = await c.deal(item(a, 'deal_id'));
    const terms = c.verifiedAgreement(d);
    const service = sandbox.whichService(terms);
    const text = service ? sandbox.extractText(get(or(get(terms, 'service'), {}), 'description')) : null;
    if (service === null || text === null) {
      throw new ValunError('not_exact_service', 'exact_result is for text-stats and notary jobs whose agreed description '
        + 'carries the text; nothing was sent');
    }
    const result = sandbox.COMPUTE[service](text);
    const r = await c.deliver(item(a, 'deal_id'), sandbox.render(service, result, text), {title: or(get(a, 'title'), `${service} result`)});
    return {deal_id: item(r, 'id'), status: item(r, 'status'), sha256: item(item(r, 'delivery'), 'sha256'),
      exact_result: {service, result},
      what_happened: `Delivered and signed: the exact ${service} result your Valun client computed from the agreed `
        + 'text. The payer can recompute it, then accepts it (paying you) or disputes it.'};
  }

  async review(a) {
    if (!['accept', 'dispute'].includes(get(a, 'decision'))) {
      throw new ValunError('bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed");
    }
    const c = this.client();
    if (item(a, 'decision') === 'dispute') {
      if (!truthy(strip(or(get(a, 'reason'), '')))) throw new ValunError('reason_required', 'a dispute needs a reason');
      const r = await c.dispute(item(a, 'deal_id'), item(a, 'reason'));
      return {deal_id: item(r, 'id'), status: item(r, 'status'), what_happened: 'Disputed. No credit note was issued; the dispute is recorded.'};
    }
    const issuer = ValunAgent.#payWith(a);
    if (issuer !== null) return this.#reviewPayWith(c, a, issuer);
    const r = await c.complete(item(a, 'deal_id'), {expectedDeliverableSha256: get(a, 'expected_deliverable_sha256'),
      expectedTermsHash: get(a, 'expected_terms_hash')});
    const n = or(get(r, 'credit_note'), {});
    const status = item(r, 'status');
    let msg;
    if (status === 'completion_awaiting_owner') {
      msg = 'You accepted the delivery and signed the credit note; your owner must approve before it is issued to the tracker.';
    } else if (status === 'note_issued') {
      msg = `Credit note issued: the Basis tracker now records that you owe ${str(item(item(r, 'counterparty'), 'handle'))} `
        + `${str(get(or(get(n, 'tracker_note'), {}), 'amount_collected'))} PC in total (this deal added ${str(get(n, 'amount'))}). `
        + labels(this.#circulating(c)).settlement;
    } else {
      msg = status;
    }
    return {deal_id: item(r, 'id'), status, what_happened: msg,
      credit_note: {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        confirmation: get(or(get(n, 'tracker_note'), {}), 'confirmation'), settled: false}};
  }

  /**
   * valun_review_delivery accept with pay_with: Client.payByTransfer under the pins prepare() took (the delivery, the
   * quote and my claim on the issuer).
   */
  async #reviewPayWith(c, a, issuer) {
    const claim = get(a, 'expected_claim_total');
    if (claim !== null && !(whole(claim) && claim >= 0)) {
      throw new ValunError('bad_arguments', 'expected_claim_total is the whole number of PC of your claim that your '
        + 'owner saw; nothing was signed');
    }
    const r = await c.payByTransfer(item(a, 'deal_id'), issuer, {expectedDeliverableSha256: get(a, 'expected_deliverable_sha256'),
      expectedQuoteDigest: get(a, 'expected_quote_digest'), expectedClaimTotal: claim});
    this.#rememberClient(c);
    const st = isDict(r) ? get(r, 'status') : null;
    const cp = isDict(r) && isDict(get(r, 'counterparty')) ? get(r.counterparty, 'handle') : null;
    const pay = isDict(r) && isDict(get(r, 'payment')) ? r.payment : {};
    const iss = isDict(get(pay, 'issuer')) ? get(pay.issuer, 'handle') : null;
    const price = isDict(r) ? get(or(get(or(get(or(get(r, 'current'), {}), 'terms'), {}), 'price'), {}), 'amount') : null;
    const who = or(cp, 'the payee'), by = or(iss, issuer), amount = whole(price) ? price : 'the price in';
    const msgs = {
      paid_by_transfer: `Paid by debt transfer: ${str(by)} now owes ${str(who)} ${amount} PC more and you ${amount} PC `
        + 'less; you issued no credit note for this deal. ' + CIRCULATION_SETTLEMENT,
      paying_by_transfer: 'You accepted the delivery and signed the debt transfer; it applies once the issuer and '
        + 'the payee sign. Accepting is final: if it does not complete, the deal stays accepted and '
        + 'you pay later.',
      completion_awaiting_owner: 'You accepted the delivery and signed the debt transfer; your owner must approve it '
        + 'in the owner console before it is submitted.',
      payment_due: 'The transfer did not apply: the delivery stays accepted and the deal is payment_due. Pay it '
        + 'again (valun_deal how_you_can_pay).'};
    return {deal_id: isDict(r) ? get(r, 'id') : item(a, 'deal_id'), status: st,
      what_happened: typeof st === 'string' && Object.hasOwn(msgs, st) ? msgs[st] : st, payment: truthy(pay) ? pay : null};
  }
}
