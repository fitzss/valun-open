// The Valun agent tools, independent of any agent framework (port of python/src/valun/agent.py).
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
import {
  COUNTER_OFFER_HOURS, GUARANTEE_HONORS_KEY, GUARANTEE_MAX_DEALS, VALUE_SAFE_HEADER_ROLES, checkOfferHours, consentRoles,
  holdEnded,
} from './client.js';
import {ValunError} from './errors.js';
import {without} from './fences.js';
import {measure} from './measure.js';
import * as nv from './novation.js';
import {
  NETWORK, NETWORKS, PILOT_RETIRED_ON, UNIT, amountText, profileNetwork, retiredPilot, sha256Hex, termsHash,
} from './protocol.js';
import {utf8} from './bytes.js';
import * as sandbox from './sandbox.js';
import {extractText} from './sandbox.js';
import * as schemas from './schemas.js';
import {
  PyError, cmpCodePoints, cpLength, cpSlice, dictCopy, get, int, isDict, isoAwareMs, isoAwareUs, item, items, iterate, lower, or, pyEq,
  repr, rstripChars, splitWords, str, strip, truthy, typeName,
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
export const PAY_THIRD_PARTY_CIRCULATION = "Supported: paying a third party with your OWN credit note, or with a note you hold "
  + "(pay_with: the issuer's debt to you moves to the payee; the issuer, you and the payee "
  + "each sign, and the issuer's total debt does not change), and set-offs that cancel "
  + 'equal debts around a cycle (every party signs; no net position changes). A payee may '
  + 'require that the claims of whoever issued the note it receives cover it '
  + '(min_payer_coverage_pct). ';
export const HONEST_LABELS_CIRCULATION = Object.freeze({
  what_basis_records: 'The pilot Basis tracker keeps one running total per key pair: what the issuer key owes the '
    + 'recipient key, with a timestamp, signed by the issuer. A credit note raises it; with circulating '
    + 'credit a debt transfer moves part of it to a new creditor and a set-off lowers the totals around '
    + 'a cycle, each signed by every party whose total changes. The tracker has no blockchain '
    + 'connection (notes stay local_only) and no reserve backs the notes.',
  outstanding_promise: CIRCULATION_SETTLEMENT,
  third_party: PAY_THIRD_PARTY_CIRCULATION + 'Not supported: redeeming a note for anything outside the pilot.',
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
// The same labels on the Valun testnet network (valun-testnet-1): word for word the server's testnet deal labels
// (lib/pilot/core.mjs SETTLEMENT_TESTNET, CIRCULATION_SETTLEMENT_TESTNET, TESTNET_REDEMPTION; "note" since valun-app
// 37693d5, fix inbox #173, and in the client since 0.7.3, #177). There a holder can redeem a note on Ergo testnet only
// against a tERG reserve locked under the key that signed it, the tracker commits its totals on Ergo testnet, and tERG
// have no monetary value. A netting is committed by the next tracker box, not final: it stays committed only as long as
// the tracker key never commits an earlier total again (valun-app e18eb73, the server's label since Nov 16; fix inbox
// #85, #100, #136 item 7; skill.md, Trust model). The pilot's labels above keep their words: the server's own pilot labels
// still say them, and a local server runs the pilot network.
export const TESTNET = 'valun-testnet-1';
export const TESTNET_REDEMPTION = 'Its holder can redeem it on Ergo testnet against a tERG reserve locked under the key that signed it, '
  + 'if one was posted; tERG are test coins with no monetary value.';
export const SETTLEMENT_TESTNET = 'not settled until redeemed: issuing a note creates a promise to pay that stays outstanding. ' + TESTNET_REDEMPTION;
export const CIRCULATION_SETTLEMENT_TESTNET = 'not settled until redeemed: a note is a promise to pay that stays outstanding. With '
  + 'circulating credit it can move to a new holder (a transfer, signed by its issuer and both '
  + 'holders) or be cleared in a loop of notes (set-off, signed by every party; no net position '
  + 'changes); a netting is committed once a tracker box on Ergo testnet commits it, and stays '
  + 'committed only as long as the tracker key never commits an earlier total again. '
  + TESTNET_REDEMPTION;
const TESTNET_TRACKER = 'The Valun testnet Basis tracker keeps one running total per key pair: what the issuer key owes the '
  + 'recipient key, with a timestamp, signed by the issuer, and anchors them on Ergo testnet (a tracker box '
  + 'commits the digest of every total). ';
const TESTNET_BACKING = 'A note is backed only by a tERG reserve locked on Ergo testnet under the key that signed it, if one was '
  + 'posted, and only up to what that reserve holds; most notes have none.';
export const THIRD_PARTY_TESTNET = 'Supported: paying a third party with your OWN note; the third party may require that your claims on '
  + 'the tracker cover it (min_payer_coverage_pct). Not supported: transferring, assigning or endorsing '
  + 'a note you hold to someone else, and clearing or netting between participants.';
export const PAY_THIRD_PARTY_TESTNET = 'Supported: paying a third party with your OWN note, or with a note you hold (pay_with: that much '
  + 'of what its issuer owes you moves to the payee; the issuer, you and the payee each sign, and what '
  + 'the issuer owes in all does not change), and set-offs that clear a loop of notes (every party '
  + 'signs; no net position changes). A payee may require that the claims of whoever issued the note '
  + 'it receives cover it (min_payer_coverage_pct). ';
export const HONEST_LABELS_TESTNET = Object.freeze({
  what_basis_records: TESTNET_TRACKER + 'A note raises a total. ' + TESTNET_BACKING,
  outstanding_promise: SETTLEMENT_TESTNET,
  third_party: THIRD_PARTY_TESTNET,
});
export const HONEST_LABELS_CIRCULATION_TESTNET = Object.freeze({
  what_basis_records: TESTNET_TRACKER + 'A note raises a total; with circulating credit a transfer moves part of it to '
    + 'a new holder and a set-off lowers the totals around a loop of notes, each signed by every party '
    + 'whose total changes. ' + TESTNET_BACKING,
  outstanding_promise: CIRCULATION_SETTLEMENT_TESTNET,
  third_party: PAY_THIRD_PARTY_TESTNET + 'A holder redeems a note only against a tERG reserve locked on Ergo testnet '
    + 'under the key that signed it.',
});
export const REAL_VS_SIMULATED_TESTNET = Object.freeze({
  real: "signatures by each participant's own key; Valun's acceptance and approval records; notes held by a real "
    + 'Basis tracker (read back and reconciled by Valun) and committed on Ergo testnet by its tracker boxes '
    + '(committed, not final); reserves and redemptions are Ergo testnet transactions',
  simulated: 'the value: tERG are Ergo testnet coins with no monetary value',
  not_proven: 'that delivered work is good (Valun records statements, it does not judge work); that any participant '
    + 'will pay a note beyond the reserve locked under the key that signed it',
});
export const REAL_VS_SIMULATED_CIRCULATION_TESTNET = Object.freeze({
  real: "signatures by each participant's own key; Valun's acceptance and approval records; notes, transfers and "
    + 'set-offs held by a real Basis tracker (read back and reconciled by Valun, and checked by your client against '
    + 'the signatures) and committed on Ergo testnet by its tracker boxes (committed, not final); reserves and '
    + 'redemptions are Ergo testnet transactions',
  simulated: REAL_VS_SIMULATED_TESTNET.simulated,
  not_proven: REAL_VS_SIMULATED_TESTNET.not_proven,
});
/** What a unit is, after its name (valun_status unit), and the last words of how to read the money view. */
export const UNIT_WORDS = Object.freeze({PC: ' (pilot credits, no monetary value)', nanoERG: ' (of tERG: Ergo testnet coins with no monetary value)'});
export const VALUE_WORDS = Object.freeze({PC: 'Nothing is redeemed and PC have no value.',
  nanoERG: 'A note is settled only when its holder redeems it on Ergo testnet against a tERG reserve '
    + 'locked under the key that signed it, if one was posted (GET /reserves); tERG have no monetary '
    + 'value.'});
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
/** prepare() failures that keep their own code and setup hint instead of approval_unbound (still nothing is signed): a
 *  redirect, a plain-http server and another server than the profile's too (the RC's review; only the Python client
 *  raises wrong_server), which no read again changes and only the owner can. */
export const UNBOUND_PASS_THROUGH = Object.freeze(['not_connected', 'not_configured', 'tracker_mismatch', 'redirected', 'plain_http',
  'wrong_server', 'tls_unverified']);
// A profile of the pilot network, retired on 2026-11-13 (fix inbox #30), on a server that now serves another network:
// that server knows neither its participant nor its key, nor the tracker it pinned, so its calls meet these refusals
// (wrong_tracker: a pin the Client was given). ValunAgent.retired() answers network_retired instead, with how to join
// again: in a new profile (rejoinHint), since this one holds an identity of the old network. As the Python agent's.
export const RETIRED_CODES = Object.freeze(['unauthorized', 'not_connected', 'tracker_mismatch', 'wrong_network',
  'wrong_tracker']);
export const DEFAULT_REJOIN_HINT = 'join in a new profile, in a terminal: `valun --profile NAME join --sandbox '
  + '--handle HANDLE --operator "YOUR NAME" --owner-token-file FILE` (NAME: a profile name not used yet; HANDLE: '
  + 'public and permanent; FILE: a new file for its owner token)';
/** network_retired's what_this_means: the profile's pilot network was retired, and the server serves `network`. */
export function retiredText(network, rejoinHint = DEFAULT_REJOIN_HINT) {
  return `This agent's profile joined the pilot network (${NETWORK}), which was retired on ${PILOT_RETIRED_ON}: `
    + `the Valun server now serves ${network}, which knows neither this participant nor its key. Nothing was signed. `
    + `Its owner must use a profile on ${network}: ${rejoinHint}.`;
}
// The server's sandbox agents (PROTOCOL.md 18.15) and the five-step tour a sandbox_only participant can take with them.
export const SANDBOX_EXACT = 'sandbox-exact';
export const SANDBOX_MALLORY = 'sandbox-mallory';
export const SANDBOX_AGENTS = Object.freeze([SANDBOX_EXACT, SANDBOX_MALLORY]);
export const TOUR_GOALS = Object.freeze({
  1: 'Earn: sandbox-exact buys text-stats from you (the welcome job, 3 PC). Deliver the exact result; it pays with its '
    + 'own note.',
  2: 'Spend a note you hold: buy notary from sandbox-mallory (2 PC) and pay with pay_with="sandbox-exact" (2 PC of '
    + 'what sandbox-exact owes you moves to sandbox-mallory). Dispute a wrong delivery and buy again.',
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
/** A step that is neither 1 to 5 nor 'done' (fix inbox #175: 0.7.2 called every other step complete, a held one included). */
export const TOUR_NO_STEP = 'No tour step to take now: then says what waits.';
/**
 * TOUR_GOALS[step] in a network's unit: its prices and cycle amounts are PC-sized (times the scale). Only 'done' is
 * complete; any other step that is not 1 to 5 has TOUR_NO_STEP (fix inbox #175).
 */
export function tourGoal(step, unit = UNIT, scale = 1) {
  const goal = step === 'done' ? 'The tour is complete.'
    : whole(step) && Object.hasOwn(TOUR_GOALS, step) ? TOUR_GOALS[step] : TOUR_NO_STEP;
  return unit === 'PC' ? goal : goal.replace(/\b(\d+) PC\b/g, (_m, n) => amountText(Number(n) * scale, unit));
}
/**
 * The tour step what a participant holds (hx from sandbox-exact, hm from sandbox-mallory) and owes (ox to sandbox-exact)
 * gives, with how many deals it paid by transfer and what set-offs cleared: the holdings' rules of sandboxNextSteps,
 * without their reads and side effects. 'done' once a payment by transfer and a set-off happened and nothing is left to
 * do (fix inbox #175: the step a commitment held for the owner keeps). As the Python agent's tour_step_from.
 */
export function tourStepFrom(hx, hm, ox, paidByTransfer, cleared, notary) {
  if ((hx > 0 || hm > 0) && ox > 0) return hx > 0 ? 3 : 4;
  if (hm >= notary) return 5;
  if (hx >= notary && paidByTransfer === 0) return 2;
  if (hx > 0) return 3;
  if (ox > 0) return 4;
  return paidByTransfer > 0 && cleared > 0 ? 'done' : 1;
}
/** What you hold / owe (PC-sized, times the scale) once each step is done, as tracker totals (design 9.2). */
export const TOUR_AFTER = Object.freeze({1: Object.freeze([3, 0]), 2: Object.freeze([1, 0]), 3: Object.freeze([0, 1]),
  4: Object.freeze([2, 0]), 5: Object.freeze([0, 0])});
// How long a tour step asks the agent to wait before calling valun_status again (fix-inbox #8): the sandbox agents act
// within a few seconds; an owner approval takes a person; a 3-cycle whose third leg is missing (blocked:
// cycle_leg_missing) waits for another participant's payment; a set-off that is due is signed at the client's next
// consent run, at most once a minute (0.7.2: 15 s, not the sandbox agents' 5 s).
export const SANDBOX_RETRY_S = 5, OWNER_RETRY_S = 60, CYCLE_LEG_RETRY_S = 30, SETOFF_DUE_RETRY_S = 15;
// The tour's end, kept in the profile: state[TOUR_DONE_KEY] is the participant id whose tour valun_status saw done.
// sandboxNextSteps reads the step from what the participant holds and owes with the sandbox agents, so a deal with them
// after the tour (`valun sandbox earn`) made it step 3 again (the 0.7.2 clean-user test). Once the end is kept, the
// next steps stay done, with TOUR_COMPLETED. As the Python agent's.
export const TOUR_DONE_KEY = 'sandbox_tour_done';
export const TOUR_COMPLETED = 'The tour is complete. Deals with the sandbox agents from now on are not tour steps: valun_inbox shows '
  + 'what waits for you, as with any agent. You can keep trading with the sandbox agents.';

/** The honest labels for a server with circulating credit (true) or without it: {settlement, not_settled, honest_labels, real_vs_simulated}. */
export const BRIEF_NOTE = 'PC are pilot credits with no monetary value: a credit note is an outstanding promise, and nothing is redeemed. '
  + 'This is the brief view; call valun_status with brief=false for your mandate, consent policy and honest labels.';
export const BRIEF_NOTE_TESTNET = 'Amounts are nanoERG of tERG, Ergo testnet coins with no monetary value: a note is a promise to pay '
  + 'that stays outstanding, which its holder can redeem on Ergo testnet only against a tERG reserve '
  + 'locked under the key that signed it, if one was posted. This is the brief view; call valun_status '
  + 'with brief=false for your mandate, consent policy and honest labels.';

/**
 * valun_status: the guarantees waiting for this agent, from the inbox's guarantees section (fix inbox #18): offers to
 * answer as creditor, calls to honor as backer, and the guarantees it holds that are due (callable only while the issuer
 * still owes it: valun_guarantees shows callable_now). null when nothing waits. The Python core's guarantees_waiting.
 */
export function guaranteesWaiting(g) {
  if (!isDict(g)) return null;
  const rows = k => (Array.isArray(get(g, k)) ? g[k] : []).filter(isDict);
  const pick = (x, keys) => Object.fromEntries(keys.map(k => [k, get(x, k)]));
  const out = {
    to_answer: rows('to_answer').map(x => pick(x, ['guarantee_id', 'backer', 'issuer', 'cap', 'due_at', 'expires_at'])),
    to_honor: rows('to_honor').map(x => pick(x, ['guarantee_id', 'call_id', 'amount', 'creditor', 'honor_by', 'overdue'])),
    due: rows('active').filter(x => get(x, 'your_role') === 'creditor' && get(x, 'due') === true && get(x, 'call_open') !== true)
      .map(x => pick(x, ['guarantee_id', 'backer', 'issuer', 'cap', 'expires_at'])),
  };
  if (!Object.values(out).some(v => v.length)) return null;
  out.how = "valun_guarantees shows each one. valun_respond_guarantee action='accept' or 'decline' answers an offer; "
    + "action='honor' pays a call with your own note. valun_call_guarantee calls a due one, only if the "
    + 'issuer still owes you (callable_now).';
  return out;
}

/** What the guarantee tools show of one guarantee view: its state and parties, the amounts, the calls. */
export function guaranteeBrief(g) {
  if (!isDict(g)) return g;
  const out = Object.fromEntries(['guarantee_id', 'state', 'your_role'].filter(k => Object.hasOwn(g, k)).map(k => [k, g[k]]));
  for (const r of ['backer', 'issuer', 'creditor']) if (isDict(get(g, r))) out[r] = or(get(g[r], 'handle'), get(g[r], 'id'));
  for (const k of ['unit', 'cap', 'claimed', 'honored', 'remaining_cap', 'issuer_owes_creditor', 'callable_now', 'recovered_for_backer', 'due_at',
    'expires_at', 'honor_within_hours', 'offer_expires_at', 'note', 'next_actions', 'terms_hash']) if (Object.hasOwn(g, k)) out[k] = g[k];
  out.calls = iterate(or(get(g, 'calls'), [])).filter(isDict).map(c => Object.fromEntries(
    ['call_id', 'amount', 'state', 'called_at', 'honor_by', 'overdue', 'honored_at', 'late', 'error'].filter(k => get(c, k) !== null).map(k => [k, c[k]])));
  return out;
}

/**
 * valun_status's brief view (brief=true, for small models), made from the full view, so it reads and signs exactly the
 * same: who you are, your owner's objective and goals, the limits in force, where approvals happen, what you hold and
 * owe (and the room your mandate leaves, where GET /me shows it), the notes you can spend, the payments and consents in
 * progress, the next sandbox step, and one line on what PC are (the honest labels stay in the full view). The same as
 * the Python core's brief_status.
 */
export function briefStatus(out) {
  const d = v => (isDict(v) ? v : {});
  const you = d(get(out, 'you')), pos = d(get(out, 'position'));
  const b = {brief: true, connected: get(out, 'connected'),
    you: Object.fromEntries(['id', 'handle', 'sandbox_expires_at'].filter(k => get(you, k) !== null).map(k => [k, you[k]])),
    ...(typeof get(out, 'you_are') === 'string' ? {you_are: out.you_are} : {}),
    objective_from_your_owner: get(out, 'objective_from_your_owner'), goals_your_owner_told_you: get(out, 'goals_your_owner_told_you'),
    limits_in_force: get(out, 'limits_in_force'), approvals: get(out, 'approvals'),
    you_hold_PC: get(pos, 'claims_held'), you_owe_PC: get(pos, 'owes'), net_PC: get(pos, 'net')};
  if (isDict(get(out, 'room'))) b.room = out.room;
  if ('notes_you_can_spend' in out) {
    b.notes_you_can_spend = (get(out, 'notes_you_can_spend') || []).filter(isDict)
      .map(n => Object.fromEntries(['issuer', 'amount_PC', 'checked_by_your_client'].map(k => [k, get(n, k)])));
    b.payments_in_progress = (get(out, 'payments_in_progress') || []).length;
    b.consents_pending = get(d(get(out, 'clearing')), 'consents_pending');
  }
  if (truthy(get(out, 'guarantees_waiting'))) b.guarantees_waiting = out.guarantees_waiting;
  const step = get(out, 'sandbox_next_steps');
  if (isDict(step)) {
    b.sandbox_next_steps = Object.fromEntries(['tour_step', 'next_calls', 'then', 'blocked', 'retry_after_seconds', 'waiting_for_your_owner']
      .filter(k => k in step).map(k => [k, step[k]]));
  }
  b.note = get(out, 'network') === TESTNET ? BRIEF_NOTE_TESTNET : BRIEF_NOTE;
  return b;
}

export function labels(circulating, network = null) {
  if (network === TESTNET) {
    if (circulating) {
      return {settlement: CIRCULATION_SETTLEMENT_TESTNET, not_settled: CIRCULATION_SETTLEMENT_TESTNET,
        honest_labels: HONEST_LABELS_CIRCULATION_TESTNET, real_vs_simulated: REAL_VS_SIMULATED_CIRCULATION_TESTNET};
    }
    return {settlement: SETTLEMENT_TESTNET, not_settled: SETTLEMENT_TESTNET, honest_labels: HONEST_LABELS_TESTNET,
      real_vs_simulated: REAL_VS_SIMULATED_TESTNET};
  }
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
export function clientSigns(policy, unit = UNIT) {
  const cap = get(policy, 'max_PC');
  const upto = whole(cap) ? `, up to ${amountText(cap, unit)} each` : '';
  const out = [];
  if (truthy(get(policy, 'setoff'))) {
    out.push(`set-offs that clear loops of notes you hold and issued (your net position does not change)${upto}`);
  }
  if (truthy(get(policy, 'as_issuer'))) out.push(`transfers that move notes you issued to a new holder (what you owe in all does not change)${upto}`);
  if (truthy(get(policy, 'as_new_creditor'))) out.push(`payments to you by transfer, of notes from issuers your owner accepts${upto}`);
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
export const READ_ONLY_TOOLS = Object.freeze(['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_guarantees',
  'valun_check_payer']);
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
/**
 * approval_unbound's what_this_means when its cause is unknown_participant: the handle (or id) a commitment names is in
 * no entry of the network's directory, so reading the deal again cannot help (the 0.7.2 clean-user test: house-scribe,
 * on a server that has none). As the Python agent's.
 */
export const UNKNOWN_PARTICIPANT_TEXT = 'Nothing was signed and your owner was not asked: no participant with that handle '
  + 'exists on this network. Find the one you mean with valun_directory, and use the handle it lists.';
/**
 * What the Valun server never holds for an owner, in any approval mode (as the Python agent's NEVER_HELD; the approval
 * semantics of 2026-11-17): it holds only what the owner's mandate holds (approve_above, review_deliveries).
 */
export const NEVER_HELD = 'honoring a guarantee call (your note, recorded at once); accepting, calling and releasing guarantees; '
  + 'deliveries, declines, withdrawals and disputes; loosening or clearing a limit you recorded with '
  + "valun_set_limits (never past your owner's mandate); and the consents your client signs by itself";
/**
 * valun_status's approvals sentence for console approvals (as the Python agent's CONSOLE_APPROVALS): what a rejection
 * leaves, as the server does it. A rejected offer, acceptance or IOU stays on the server, still signed; a rejected
 * payment by transfer is purged (only its signatures' sha256), and a payment through the same IOU at the same prior
 * state is allowed at once; any other payment of the deal waits until T + MAX_AGE_MS + FALLBACK_MARGIN_MS.
 */
export const CONSOLE_APPROVALS = 'Console approvals: you sign every commitment yourself, and the Valun server holds these for your '
  + 'owner in the owner console until they approve: your offers and counter-offers, your acceptances '
  + '(taking a job included), your guarantee offers, and the note or payment by transfer you sign when '
  + 'you accept a delivery (console sets your owner mandate to approve_above 0 and review_deliveries '
  + 'on). Each takes effect only when your owner approves it. Rejecting does not unsign it: the server '
  + 'keeps your signed offer, acceptance or note on record, and a rejected note could still be recorded by '
  + 'the tracker until an hour after you signed it, so paying that deal by transfer waits until 1 hour '
  + "and 2 minutes after you signed it (your Valun client's time, a minute after the server's, which the "
  + 'owner console shows, as a margin for clocks that differ). A rejected payment by transfer is the '
  + 'exception: it is deleted, '
  + 'its signatures included (the server keeps only their hashes), and you may pay again through the same '
  + 'note at once while it is unchanged; any other payment of that deal waits until 1 hour and 2 minutes '
  + 'after you signed it. When an answer says something waits for your owner, tell them at once: nothing '
  + 'else tells them. These are not held, so they take effect when you sign: ' + NEVER_HELD + '.';
/**
 * Where approvals happen, as the Python MCP server and CLI tell the model (python/src/valun/mcp_server.py): valun_status
 * follows it with what the server holds by the owner mandate (heldForOwner).
 */
export const APPROVAL_TEXT = Object.freeze({
  ask: 'Before you sign a commitment, your owner is asked through this app and sees exactly what you would sign: an '
    + 'offer, counter-offer or acceptance; accepting a delivery (with your own note, or paying with a note you '
    + 'hold); a guarantee offer; honoring or releasing a guarantee; or loosening a limit you recorded. If they '
    + 'decline, nothing is signed.',
  'client-prompt': "Your app's own confirmation of each Valun tool that signs is the only approval here: whatever it "
    + 'lets run is signed at once, and an app that runs tools without asking (or a tool your owner '
    + 'allowed permanently) asks nobody.',
  console: CONSOLE_APPROVALS,
  none: "You act on your own within your owner's limits; nobody is asked before you sign.",
});

const DEAL_FIELDS = ['id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement', 'decline',
  'completion', 'dispute', 'cancellation', 'approvals', 'labels'];
const LIMITS_SHOWN = Object.entries(LIMIT_FIELDS);
const PLAIN = /^[A-Za-z0-9_.:@+-]{1,120}$/;
const DEAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GUARANTEE_ID = /^vg_[0-9a-f]{16}$/, CALL_ID = /^vgc_[0-9a-f]{16}$/;
const LONE_SURROGATE = /\p{Cs}/u;
const TEXT_FIELDS = ['title', 'description', 'deliverable'];

/** Python's isinstance(v, int) and not isinstance(v, bool), for JSON numbers (a safe integer). */
const whole = v => typeof v === 'number' && Number.isSafeInteger(v);

/** A whole-number argument of a guarantee tool, or its default (null: required). The Python core's _guarantee_int. */
function guaranteeInt(a, k, dflt) {
  const given = isDict(a) ? get(a, k) : null;
  const v = given === null || given === undefined ? dflt : given;      // absent or null: the default
  if (v === null) throw new ValunError('bad_arguments', `${k} is required`);
  if (!whole(v)) throw new ValunError('bad_arguments', `${k} must be a whole number`);
  return v;
}

/**
 * v, the value of argument k of valun_propose or valun_respond (price, deliver_within_hours, offer_valid_hours), when it
 * is a JSON integer of at least 1. Anything else is refused (bad_arguments, fix inbox #22), never truncated, rounded or
 * replaced by a default: a float (1.5), a numeric string ("1000"), a boolean, 0 or a negative number. The Python core's
 * _count (JavaScript cannot tell 2.0 from 2: both are 2 here).
 */
function count(k, v, units) {
  if (whole(v) && v >= 1) return v;
  throw new ValunError('bad_arguments', countMessage(k, v, units));
}

/** A value an agent passed, as a refusal quotes it: one line of JSON, at most 40 characters. The Python core's _got. */
function shownValue(v) {
  const got = quoted(v);
  return got.length <= 40 ? got : got.slice(0, 37) + '...';
}

function countMessage(k, v, units) {
  return `${k} must be a whole number of ${units}, at least 1 (a JSON integer), not ${shownValue(v)}; nothing was signed`;
}

/** Argument k checked by count(), or `dflt` when it is absent or null. The Python core's _count_or. */
function countOr(a, k, units, dflt = null) {
  return get(a, k) === null ? dflt : count(k, a[k], units);
}

/**
 * The most hours an offer may give to deliver, and stay open (the schemas' maximum): the server refuses terms whose
 * deliver_by is more than 30 days ahead, or whose offer_expires_at is more than 7 days ahead. The Python core's.
 */
export const HOURS_MAX = Object.freeze({deliver_within_hours: 720, offer_valid_hours: 168});

/**
 * Argument k of valun_propose or valun_respond counter (deliver_within_hours, offer_valid_hours): countOr, and at most
 * HOURS_MAX[k], else bad_arguments before anything is read or signed (fix inbox #58 review: 0.7.1 signed terms the
 * server then refused, or failed with internal_error on hours too many for a date). The Python core's _hours_or.
 */
function hoursOr(a, k, dflt = null) {
  const h = countOr(a, k, 'hours', dflt);
  if (h !== null && h > HOURS_MAX[k]) {
    throw new ValunError('bad_arguments', `${k} must be at most ${HOURS_MAX[k]} hours (${HOURS_MAX[k] / 24} days, the most the server `
      + `takes), not ${shownValue(h)}; nothing was signed`);
  }
  return h;
}

/**
 * What each required argument of a tool is, for the refusal when it is missing (fix inbox #58): every argument a tool's
 * schema requires (REQUIRED_ARGUMENTS) has its words here, and ARGUMENT_WORDS_OF has a tool's own words for an argument
 * that means something else there. The Python core's.
 */
export const ARGUMENT_WORDS = Object.freeze({
  deal_id: 'the deal id, vd_ + 16 hex, as valun_inbox lists it',
  action: 'accept, decline, counter or withdraw',
  counterparty: 'their handle or participant id',
  role: 'payer to buy, payee to sell',
  title: 'a short name of the service',
  description: 'what exactly is to be done',
  deliverable: 'what will be delivered and in what form',
  payer: 'the handle or participant id of the agent that would owe you',
  price: 'the price: a whole number, at least 1',
  decision: 'accept or dispute',
  amount: "what it would owe you, the deal's price: a whole number, at least 1",
  issuer: 'the handle or participant id of the agent whose notes you guarantee',
  creditor: 'the handle or participant id of the agent you would pay',
  cap: 'the most you pay in all: a whole number, at least 1',
  due_in_hours: 'hours from now until the creditor can call: 0 for as soon as it accepts',
  guarantee_id: 'the guarantee id, vg_ + 16 hex, as valun_guarantees lists it',
});
export const ARGUMENT_WORDS_OF = Object.freeze({valun_respond_guarantee: Object.freeze({action: 'accept, decline, release, withdraw or honor'})});
/** The arguments each tool requires: its schema's `required`, what the model reads (toolArguments refuses a call without one). */
export const REQUIRED_ARGUMENTS = Object.freeze(Object.fromEntries(schemas.ALL.map(t => [t.name, Object.freeze([...(t.parameters.required ?? [])])])));

/** The arguments valun_propose needs besides its numbers (the price is checked as a number: count()). */
const PROPOSE_TEXTS = Object.freeze(['counterparty', 'role', 'title', 'description', 'deliverable']);

/**
 * The values of the required arguments `keys` of a tool call, in that order. Fix inbox #58: a call without one (or with
 * it null) is refused with bad_arguments naming each one missing and what it is (ARGUMENT_WORDS, or `words` for a tool's
 * own), before anything is read, instead of failing on a KeyError (internal_error); arguments that are not a JSON object
 * are refused the same way. The Python core's _required.
 */
function required(a, keys, signs = true, words = null) {
  const tail = signs ? '; nothing was signed' : '';
  if (!isDict(a)) throw new ValunError('bad_arguments', 'the arguments are not a JSON object' + tail);
  const missing = keys.filter(k => get(a, k) === null || get(a, k) === undefined);
  if (missing.length) {
    const w = {...ARGUMENT_WORDS, ...(words ?? {})};
    throw new ValunError('bad_arguments', (missing.length === 1 ? 'missing argument: ' : 'missing arguments: ')
      + missing.map(k => `${k} (${w[k]})`).join(', ') + tail);
  }
  return keys.map(k => a[k]);
}

/**
 * The arguments of a call of the tool `name` (one of TOOL_NAMES), as its handler takes them: {} when there are none
 * (null or undefined), else the JSON object given, itself. Fix inbox #58: arguments that are not a JSON object, or that
 * lack one of the tool's required arguments (REQUIRED_ARGUMENTS, its schema's `required`; null counts as missing), are
 * refused with bad_arguments naming each one missing and what it is, before anything is read or signed, so no tool can
 * fail on them later (an internal_error). The refusal ends in '; nothing was signed' for the tools that are not
 * read-only. ValunAgent checks it where every call comes in: call(), and prepareOrRefusal() for the adapters that ask the
 * owner before a commitment, which answers the same refusal instead of asking (prepare() refuses such a call too,
 * approval_unbound with the cause bad_arguments). isCommitment() does not look at it: its classification stays fail
 * closed, by name and by value. The Python core's tool_arguments.
 */
export function toolArguments(name, args, unit = UNIT) {
  const signs = !READ_ONLY_TOOLS.includes(name);
  const a = args === null || args === undefined ? {} : args;
  if (!isDict(a)) throw new ValunError('bad_arguments', 'the arguments are not a JSON object' + (signs ? '; nothing was signed' : ''));
  required(a, Object.hasOwn(REQUIRED_ARGUMENTS, name) ? REQUIRED_ARGUMENTS[name] : [], signs,
    Object.hasOwn(ARGUMENT_WORDS_OF, name) ? ARGUMENT_WORDS_OF[name] : null);
  for (const k of Object.keys(Object.hasOwn(PROPERTIES, name) ? PROPERTIES[name] : {})) {
    const e = argumentRefusal(name, k, get(a, k), unit);
    if (e !== null) throw e;
  }
  return a;
}

// Fix inbox #58 (0.7.2): each argument a tool's schema gives is checked against its type there (argumentRefusal). The
// schema's properties of each tool, in the order the check goes through them. The Python core's PROPERTIES.
export const PROPERTIES = Object.freeze(Object.fromEntries(schemas.ALL.map(t => [t.name, t.parameters.properties ?? {}])));
/**
 * The id shapes the server's routes take (valun-app lib/pilot/http.mjs: /deals/(vd_[0-9a-f]{16}), /guarantees/(vg_[0-9a-f]
 * {16}) and .../calls/(vgc_[0-9a-f]{16}); lib/pilot/core.mjs and guarantees.mjs check them the same way): an id of another
 * shape names nothing there, and a value that is not one never reaches a request. The Python core's ID_SHAPES.
 */
export const ID_SHAPES = Object.freeze({deal_id: /^vd_[0-9a-f]{16}$/, guarantee_id: /^vg_[0-9a-f]{16}$/, call_id: /^vgc_[0-9a-f]{16}$/});
/**
 * A value that is not one of an argument's values (its schema's enum) gets the refusal its tool gave it before the core
 * check did, code and words (a misspelt decision is still bad_decision): {tool: {argument: [code, message]}}. The Python
 * core's.
 */
export const ENUM_REFUSALS = Object.freeze({
  valun_propose: Object.freeze({role: Object.freeze(['bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)'])}),
  valun_respond: Object.freeze({action: Object.freeze(['bad_action', 'action must be accept, decline, counter or withdraw'])}),
  valun_review_delivery: Object.freeze({decision: Object.freeze(['bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed"])}),
  valun_respond_guarantee: Object.freeze({action: Object.freeze(['bad_arguments', 'action must be accept, decline, release, withdraw or honor'])}),
});
const GUARANTEE_ID_WORDS = 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees lists them)';
/**
 * The refusals a tool gave an argument of the wrong type before the core check did, kept word for word (each names the
 * argument and what it must be): {tool: {argument: message, or a function of (the value, the unit)}}. The Python core's
 * _SAID.
 */
const SAID = {
  valun_status: {brief: 'brief must be true or false'},
  valun_directory: Object.fromEntries(['limit', 'offset'].map(k => [k, v => pageMessage(k, v, PAGE_WORDS[k])])),
  valun_propose: Object.fromEntries(['price', 'deliver_within_hours', 'offer_valid_hours'].map(k => [k, (v, unit) => countMessage(k, v, k === 'price' ? unit : 'hours')])),
  valun_respond: Object.fromEntries(['price', 'deliver_within_hours', 'offer_valid_hours'].map(k => [k, (v, unit) => countMessage(k, v, k === 'price' ? unit : 'hours')])),
  valun_deliver: {exact_result: 'exact_result is true or false'},
  valun_review_delivery: {pay_with: "pay_with is 'own_note' or the handle or id of an issuer whose note you hold"},
  valun_guarantees: {guarantee_id: GUARANTEE_ID_WORDS},
  valun_offer_guarantee: {note: 'note must be text', ...Object.fromEntries(['cap', 'due_in_hours', 'callable_for_hours', 'honor_within_hours',
    'offer_valid_hours'].map(k => [k, `${k} must be a whole number`]))},
  valun_respond_guarantee: {guarantee_id: GUARANTEE_ID_WORDS, reason: 'reason must be text', call_id: 'call_id is malformed (vgc_ + 16 hex)'},
  valun_call_guarantee: {guarantee_id: GUARANTEE_ID_WORDS, amount: 'amount must be a whole number of at least 1'},
  valun_check_payer: {payer: 'payer must be the handle or participant id (text) of the agent that would owe you',
    amount: (v, unit) => countMessage('amount', v, unit),
    deal_id: v => `deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox lists it, not ${shownValue(v)}`},
};

/** valun_offer_guarantee deals: 1 to GUARANTEE_MAX_DEALS different deal ids (the client's own check, items first). */
function dealsOk(v) {
  return Array.isArray(v) && v.length >= 1 && v.length <= GUARANTEE_MAX_DEALS
    && v.every(d => typeof d === 'string' && ID_SHAPES.deal_id.test(d)) && new Set(v).size === v.length;
}

/**
 * Why the value v (not null) of argument k does not fit tool `name`'s schema (PROPERTIES), as the ValunError its call
 * answers, or null when it fits (fix inbox #58, 0.7.2). A string is a string, an integer an integer (a safe integer: a
 * boolean or "7" is not one), a boolean true or false, and a value with an enum one of its values (a list of them for
 * valun_set_limits clear); deal_id, guarantee_id and call_id have the shape of the ids the server's routes take
 * (ID_SHAPES), and valun_offer_guarantee deals is its list of deal ids. The refusal names the argument and what it must
 * be: where its tool refused it already, with the same code and words (ENUM_REFUSALS, and the tools' own words; `unit` is
 * the network's, for the words of an amount), else bad_arguments '<k> must be a string (<what it is, for an argument the
 * tool requires>), not <v>' (or a whole number, or true or false), ending in '; nothing was signed' for a tool that is
 * not read-only. Only the type, values and shape: how many, how long or how large is the tool's own check, as before. The
 * Python core's argument_refusal (JavaScript cannot tell 2.0 from 2).
 */
export function argumentRefusal(name, k, v, unit = UNIT) {
  const spec = Object.hasOwn(PROPERTIES, name) && Object.hasOwn(PROPERTIES[name], k) ? PROPERTIES[name][k] : null;
  if (!isDict(spec) || v === null || v === undefined) return null;
  const tail = READ_ONLY_TOOLS.includes(name) ? '' : '; nothing was signed';
  const t = spec.type, en = spec.enum;
  let fits, need;
  if (Array.isArray(en)) {
    if (typeof v === 'string' && en.includes(v)) return null;
    const [code, message] = ENUM_REFUSALS[name][k];
    return new ValunError(code, message);
  }
  if (t === 'string') {
    const shape = Object.hasOwn(ID_SHAPES, k) ? ID_SHAPES[k] : null;
    fits = typeof v === 'string' && (shape === null || shape.test(v));
    const req = Object.hasOwn(REQUIRED_ARGUMENTS, name) && REQUIRED_ARGUMENTS[name].includes(k);
    const words = req ? ({...ARGUMENT_WORDS, ...(Object.hasOwn(ARGUMENT_WORDS_OF, name) ? ARGUMENT_WORDS_OF[name] : {})})[k] : undefined;
    need = k === 'deal_id' ? 'the deal id, vd_ + 16 hex, as valun_inbox lists it' : 'a string' + (words ? ` (${words})` : '');
  } else if (t === 'integer') {
    fits = whole(v);
    need = 'a whole number (a JSON integer)';
  } else if (t === 'boolean') {
    fits = typeof v === 'boolean';
    need = 'true or false';
  } else if (name === 'valun_set_limits' && k === 'clear') {
    const names = spec.items.enum;
    fits = Array.isArray(v) && v.every(x => typeof x === 'string' && names.includes(x));
    need = `a list of the limits to remove (${names.join(', ')})`;
  } else if (name === 'valun_offer_guarantee' && k === 'deals') {
    return dealsOk(v) ? null : new ValunError('bad_arguments', `deals must be 1 to ${GUARANTEE_MAX_DEALS} different deal ids (vd_ + 16 hex)`);
  } else {
    return null;
  }
  if (fits) return null;
  const own = Object.hasOwn(SAID, name) && Object.hasOwn(SAID[name], k) ? SAID[name][k] : null;
  const said = typeof own === 'function' ? own(v, unit) : own;
  return new ValunError('bad_arguments', said !== null ? said : `${k} must be ${need}, not ${shownValue(v)}${tail}`);
}

// valun_check_payer (budget cards): the summary's first word for each verdict the server gives, and its words when the
// server gives no reasons; and the words for the payee's own side of the step (payee_side) when it would not simply go
// ahead and the server gives no reasons for it. The Python core's.
export const CHECK_LEAD = Object.freeze({accept: 'Accept', ask_owner: "Ask the payer's owner", decline: 'Decline'});
export const CHECK_FALLBACK = Object.freeze({accept: "its owner's budget card allows this note",
  ask_owner: "the payer's owner approves a note this size before it binds",
  decline: "its owner's budget card does not allow this note"});
export const CHECK_PAYEE_SIDE = Object.freeze({decline: 'your own limits refuse it', ask_owner: 'your owner approves it before it binds'});
// Fix inbox #87: an ask_owner from a server that gives the step's verdict from both sides (payer_side): the summary's
// first words, and its words without reasons, by whose owner decides first (checkOwners). The Python core's.
export const CHECK_ASK_LEAD = Object.freeze({payee: 'Ask your owner', payer: "Ask the payer's owner", both: "Ask your owner and the payer's owner"});
export const CHECK_ASK_FALLBACK = Object.freeze({payee: 'your owner approves it before it binds',
  payer: "the payer's owner approves a note this size before it binds",
  both: "your owner and the payer's owner approve it before it binds"});
/** A deal id as the server writes one (the offer under review, deal=; counted_offers). */
const OFFER_ID = /^vd_[0-9a-f]{16}$/;

/** The server's reasons for a summary: each a text put on one line without its final stop; the others left out. */
function summaryParts(reasons) {
  return (Array.isArray(reasons) ? reasons : []).filter(r => typeof r === 'string')
    .map(r => rstripChars(splitWords(r).join(' '), ' .;,')).filter(Boolean);
}

/**
 * The summary's parts as one text, without a final stop: a part that starts with a capital letter (A to Z: a sentence, as
 * the server writes its reasons) follows the one before after a stop, any other after a comma. 0.7.1 put every part
 * after a comma, so a sentence of the server's ran on mid-line. The Python core's _summary_text.
 */
function summaryText(parts) {
  return parts.map((p, i) => (i === 0 ? p : (/^[A-Z]/.test(p) ? '. ' : ', ') + p)).join('');
}

/**
 * Fix inbox #87: whose owner decides first in a check's ask_owner, from the step's two sides (payer_side and payee_side,
 * each {verdict, rule, reasons}): 'payee' (this agent's own owner) when only the payee's side says ask_owner, 'payer' when
 * only the payer's side does, else 'both'. An answer whose sides do not say whose names both, so this agent's own owner
 * is never left out. The Python core's check_owners.
 */
export function checkOwners(v) {
  const asks = key => {
    const side = isDict(v) ? get(v, key) : null;
    return isDict(side) && get(side, 'verdict') === 'ask_owner';
  };
  const payer = asks('payer_side'), payee = asks('payee_side');
  return payee && !payer ? 'payee' : payer && !payee ? 'payer' : 'both';
}

/**
 * For a check of a new deal (an answer that names no deal_id): the deal ids of the payer's open offers to this agent that
 * the answer says its outstanding already counts (counted_offers [{deal_id, amount}], fix inbox #60), at exactly the
 * amount checked, as listed. An entry that is not {deal_id: a deal id, amount: a whole number} is left out. The Python
 * core's offers_counted_at.
 */
export function offersCountedAt(v) {
  const d = isDict(v) ? v : {};
  const amount = get(d, 'amount'), rows = get(d, 'counted_offers');
  if (Object.hasOwn(d, 'deal_id') || !whole(amount) || !Array.isArray(rows)) return [];
  return rows.filter(o => isDict(o) && typeof get(o, 'deal_id') === 'string' && OFFER_ID.test(o.deal_id) && whole(get(o, 'amount'))
    && o.amount === amount).map(o => o.deal_id);
}

/**
 * valun_check_payer's summary: the verdict, its reasons and the cover as plain sentences, e.g. 'Accept: Both sides allow
 * it. Within its budget: ... Your own side: Your own limits allow it. Backed for you up to 3 by @erin.' The reasons are
 * the server's, each put on one line without its final stop, a sentence after a stop and a fragment after a comma
 * (summaryText); without any, the words of CHECK_FALLBACK. A verdict this client does not know reads Unknown.
 *
 * Fix inbox #87: a server that gives the step's verdict from both sides (its answer has payer_side: the payer's own
 * {verdict, rule, reasons}, null for a payer whose owner has not published its card) gives the payee its own check's
 * verdict for the step as the server enforces it: decline if either side declines, ask_owner if an owner on either side
 * decides first, accept only if both go ahead, unknown when the payer's side was not checked (no card) and the payee's
 * does not decline. The summary leads with that verdict; for ask_owner it names whose owner decides (checkOwners): 'Ask
 * your owner' when only the payee's side (payee_side) asks, "Ask the payer's owner" when only the payer's does, "Ask your
 * owner and the payer's owner" otherwise. The cover is the server's to say: its sentence is among the payee's own
 * reasons, which end the summary after 'Your own side: ' whatever that side's verdict (the words of CHECK_PAYEE_SIDE for a
 * decline or ask_owner without reasons).
 *
 * A server from before #87 (no payer_side) gives the payer's verdict, and its summary is 0.7.1's: the lead of
 * CHECK_LEAD, the cover named by this client ('backed for you up to N') only when cover.covered is a whole number above 0
 * (the server shows it only to the payee itself, and null means not shown, never 0) and only for accept and ask_owner (a
 * declined IOU would not be issued at all), and 'Your own side: ' with the payee's own reasons only when that side is
 * decline or ask_owner.
 *
 * Fix inbox #60: a check of a new deal (no deal_id) at the price of an offer the payer made this agent is not a check of
 * that offer, which the payer's outstanding already counts: the answer is for a new deal on top of it. So when the
 * answer's counted_offers has offers at exactly the amount checked (offersCountedAt), the summary says so after the
 * verdict and gives the call that answers for the offer. Several such offers are listed, and the call is with one of
 * their deal_ids. The Python core's check_summary.
 */
export function checkSummary(v) {
  const d = isDict(v) ? v : {};
  const verdict = typeof get(d, 'verdict') === 'string' ? d.verdict : null;
  const both = Object.hasOwn(d, 'payer_side');                 // fix inbox #87: the step's verdict, from both sides
  const owners = both && verdict === 'ask_owner' ? checkOwners(d) : null;
  let parts = summaryParts(get(d, 'reasons'));
  if (!parts.length) {
    parts = [owners !== null ? CHECK_ASK_FALLBACK[owners]
      : verdict !== null && Object.hasOwn(CHECK_FALLBACK, verdict) ? CHECK_FALLBACK[verdict] : 'the server gave no verdict this client knows'];
  }
  const covered = isDict(get(d, 'cover')) ? get(d.cover, 'covered') : null;
  if (!both && (verdict === 'accept' || verdict === 'ask_owner') && whole(covered) && covered > 0) parts.push(`backed for you up to ${covered}`);
  const lead = owners !== null ? CHECK_ASK_LEAD[owners] : verdict !== null && Object.hasOwn(CHECK_LEAD, verdict) ? CHECK_LEAD[verdict] : 'Unknown';
  const text = summaryText(parts), offers = offersCountedAt(d);
  let out;
  if (offers.length === 1) {
    out = `${lead}, for a new deal on top of the offer you received at this price (${offers[0]}, already counted): `
      + `${text}. To check that offer itself, call valun_check_payer again with deal_id ${offers[0]}.`;
  } else if (offers.length) {
    out = `${lead}, for a new deal on top of the ${offers.length} offers you received at this price (${offers.join(', ')}, `
      + `already counted): ${text}. To check one of them, call valun_check_payer again with its deal_id.`;
  } else {
    out = `${lead}: ${text}.`;
  }
  const side = isDict(get(d, 'payee_side')) ? d.payee_side : {};
  const sv = typeof get(side, 'verdict') === 'string' ? side.verdict : null;
  const known = sv !== null && Object.hasOwn(CHECK_PAYEE_SIDE, sv);
  if (known || (both && sv === 'accept')) {
    const sp = summaryParts(get(side, 'reasons'));
    const own = sp.length ? sp : known ? [CHECK_PAYEE_SIDE[sv]] : [];
    if (own.length) out += ` Your own side: ${summaryText(own)}.`;
  }
  return out;
}

/**
 * valun_check_payer's answer when the payer's owner has not published a budget card and the server says only that (404
 * card_not_public, as a server from before fix inbox #87 answers every check of such a payer; one with #87 answers the
 * payee's own check for the payee's own side, which checkSummary reads): an answer, not an error, with verdict 'unknown'
 * (and the offer under review, deal_id, when the check named one). The Python core's unchecked_payer.
 */
function uncheckedPayer(payer, amount, dealId = null) {
  const who = shown(or(get(payer, 'handle'), get(payer, 'id')));
  return {summary: `Unknown: ${who}'s owner has not published a budget card, so its budget cannot be checked; decide `
      + 'from its record (valun_directory) or ask your owner.',
    verdict: 'unknown', reasons: ["the payer's owner has not published a budget card"], rule: null, payer, amount,
    ...(dealId === null ? {} : {deal_id: dealId})};
}

/** A guarantee party's handle as the view names it, else its id from the checked terms. */
function guaranteeParty(g, role, terms) {
  const x = isDict(g) ? get(g, role) : null;
  return isDict(x) && typeof get(x, 'handle') === 'string' && x.handle ? x.handle : terms[role].id;
}

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

const APPROVAL_ID_RE = /^va_[0-9a-f]{12}$/;

/**
 * Where and what this participant's owner approves, for an answer that waits for them (as the Python agent's
 * owner_wait; the newcomer tests, 2026-11-17): [words, fields]. words: ' in the owner console, <server>/pilot#owner (deal
 * vd_..., approval va_...)', and with `command` (the terminal command that opens that console for this profile, `valun
 * console`: the agent's consoleCommand) '; in a terminal, `<command>` opens it'. fields: owner_console; approval_id when
 * the server's answer names one pending approval of this participant for this deal (approval_ids when it names several);
 * and console_command. kind: what dealId names ('deal', or 'guarantee' for a guarantee offer).
 */
export function ownerWait(c, r, dealId, command = null, kind = 'deal') {
  const state = c?.state;
  let server = isDict(state) ? get(state, 'server') : null;
  server = typeof server === 'string' ? server.replace(/\/+$/, '') : '';
  const rows = isDict(r) && Array.isArray(get(r, 'approvals')) ? r.approvals : [];
  const ids = [...new Set(rows.filter(a => isDict(a) && get(a, 'state') === 'pending' && typeof get(a, 'id') === 'string'
    && APPROVAL_ID_RE.test(a.id)).map(a => a.id))].sort();
  const fields = {};
  if (server) fields.owner_console = `${server}/pilot#owner`;
  if (ids.length === 1) fields.approval_id = ids[0];
  else if (ids.length) fields.approval_ids = ids;
  let opens = '';
  if (typeof command === 'string' && command) {
    fields.console_command = command;
    opens = `; in a terminal, \`${command}\` opens it`;
  }
  const which = [`${kind} ${shown(dealId)}`, ...ids.map(i => `approval ${i}`)].join(', ');
  const where = server ? ` in the owner console, ${server}/pilot#owner` : ' in the owner console';
  return [`${where} (${which}${opens})`, fields];
}

/** The current terms a deal view shows ({} when it shows none). */
function termsOf(r) {
  const cur = isDict(r) && isDict(get(r, 'current')) ? r.current : {};
  return isDict(get(cur, 'terms')) ? cur.terms : {};
}

/** The counterparty's handle a deal view names, as a computed line shows it (dflt when it names none). */
function handleOf(r, dflt = 'the other side') {
  const cp = isDict(r) && isDict(get(r, 'counterparty')) ? r.counterparty : {};
  return typeof get(cp, 'handle') === 'string' && cp.handle ? shown(cp.handle) : dflt;
}

/** ms since the epoch as the server writes a time (ISO 8601, UTC, milliseconds), as the Python agent's iso_ms. */
export function isoMs(ms) {
  if (!(whole(ms) && ms >= 0 && ms < 32_503_680_000_000)) return null;
  return new Date(ms).toISOString();
}

/**
 * A held IOU's approval ends this long before the tracker's hour (the server's HELD_NOTE_SEND_MARGIN_MS): the owner
 * console's "Decide by" for it, as the Python agent's HELD_NOTE_SEND_MARGIN_MS.
 */
export const HELD_NOTE_SEND_MARGIN_MS = 60_000;

/** The timestamp of a bound note as a deal view shows it, else null, as the Python agent's _bound_ts. */
function boundTs(note) {
  const n = isDict(note) ? note : {};
  const ts = get(n, 'timestamp');
  if (!whole(ts) || !(truthy(get(n, 'prior_signature')) || get(n, 'bound') === true || ts % 1000 === nv.BOUND_MS)) return null;
  return ts;
}

/** When the tracker stops taking a bound note (its timestamp + 1 h), as the Python agent's note_expires_at. */
export function noteExpiresAt(note) {
  const ts = boundTs(note);
  return ts === null ? null : isoMs(ts + nv.MAX_AGE_MS);
}

/**
 * Until when the owner can approve or reject a bound note held for them: the owner console's deadline, a minute before
 * the tracker's (its timestamp + 1 h - HELD_NOTE_SEND_MARGIN_MS), as the Python agent's note_decide_by.
 */
export function noteDecideBy(note) {
  const ts = boundTs(note);
  return ts === null ? null : isoMs(ts + nv.MAX_AGE_MS - HELD_NOTE_SEND_MARGIN_MS);
}

/** A held IOU's deadline for the owner, in words, as the Python agent's _deadline_words. */
function deadlineWords(by, exp) {
  return `${by}, the owner console's deadline, a minute before the tracker's limit (${exp})`;
}

/** ' before <at>' (or another word) for a time the server's answer names (an ISO 8601 string), else ''. */
function until(at, word = 'before') {
  return typeof at === 'string' && at ? ` ${word} ${shown(at)}` : '';
}

/**
 * Until when this client counts a payment attempt signed for `ts` against another payment of its deal (its timestamp +
 * 1 h + 2 min), as the Python agent's free_after; null for a timestamp that is not a whole number.
 */
export function freeAfter(ts) {
  return whole(ts) ? isoMs(ts + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS) : null;
}

/** What freeAfter's time is, said beside it, as the Python agent's MARGIN_WORDS. */
export const MARGIN_WORDS = "your Valun client's time, a minute after the server's, which the owner console shows, as a margin for "
  + 'clocks that differ';

/**
 * The payer's IOU the Valun server holds for its owner, in a deal view: [decideBy, noteExpiresAt, passed], as the Python
 * agent's held_note_hour ([null, null, false] for any other view).
 */
export function heldNoteHour(d, nowMs) {
  if (!(isDict(d) && get(d, 'status') === 'completion_awaiting_owner' && get(d, 'your_role') === 'payer')) return [null, null, false];
  const cn = isDict(get(d, 'credit_note')) ? d.credit_note : {};
  const note = isDict(get(cn, 'note')) ? cn.note : null;
  const exp = noteExpiresAt(note);
  if (exp === null) return [null, null, false];
  return [noteDecideBy(note), exp, whole(nowMs) && nowMs >= note.timestamp + nv.MAX_AGE_MS];
}

/**
 * The deadlines of the IOU this client signed for a pending issue_note approval an inbox row names, from this client's
 * own record of it: [decideBy, noteExpiresAt, passed], as the Python agent's held_note_of.
 */
export function heldNoteOf(c, row, nowMs) {
  if (!(isDict(row) && get(row, 'kind') === 'issue_note' && typeof get(row, 'approval_id') === 'string'
    && typeof get(row, 'deal_id') === 'string')) return [null, null, false];
  const state = c?.state;
  const att = isDict(state) ? get(state, 'transfer_attempts') : null;
  const lst = isDict(att) ? get(att, row.deal_id) : null;
  const rec = (Array.isArray(lst) ? lst : []).find(a => isDict(a) && get(a, 'route') === 'note'
    && get(a, 'approval_id') === row.approval_id) ?? null;
  const ts = rec !== null ? get(rec, 'timestamp') : null;
  const exp = whole(ts) ? noteExpiresAt({timestamp: ts}) : null;
  if (exp === null) return [null, null, false];
  return [noteDecideBy({timestamp: ts}), exp, whole(nowMs) && nowMs >= ts + nv.MAX_AGE_MS];
}

/**
 * {call_id: timestamp of the note} of this client's own record of the calls of a guarantee it honored or is honoring
 * (GUARANTEE_HONORS_KEY, written ahead before a note is signed), as the Python agent's honor_marks.
 */
export function honorMarks(c, guaranteeId) {
  const state = c?.state;
  const honors = isDict(state) ? get(state, GUARANTEE_HONORS_KEY) : null;
  const rec = isDict(honors) ? get(honors, guaranteeId) : null;
  const calls = isDict(rec) ? get(rec, 'calls') : null;
  if (!isDict(calls)) return {};
  return Object.fromEntries(Object.entries(calls).filter(([, v]) => isDict(v)).map(([k, v]) => [k, get(v, 'timestamp')]));
}

/**
 * valun_status's sentence on what the Valun server holds for the owner, from the owner mandate GET /me shows
 * (approve_above, review_deliveries) and where the owner decides, as the Python agent's held_for_owner. console: the
 * approvals sentence before it is CONSOLE_APPROVALS.
 */
export function heldForOwner(mandate, server, unit = UNIT, console = false) {
  const m = isDict(mandate) ? mandate : {};
  const above = get(m, 'approve_above'), review = get(m, 'review_deliveries') === true;
  const url = typeof server === 'string' && server ? `${server.replace(/\/+$/, '')}/pilot#owner` : null;
  const where = url ? `in the owner console (${url})` : 'in the owner console';
  if (console && whole(above) && above === 0 && review) {
    return `Your owner approves or rejects what waits for them in the owner console: ${url || '/pilot#owner'}.`;
  }
  const held = [];
  if (whole(above) && above === 0) held.push('every offer, counter-offer, acceptance and guarantee offer you sign (approve_above 0)');
  else if (whole(above)) {
    held.push(`your offers, counter-offers and acceptances priced above ${amountText(above, unit)}, and your `
      + 'guarantee offers capped above it (approve_above)');
  }
  if (review) held.push('the note or payment by transfer you sign when you accept a delivery (review_deliveries is on)');
  const lead = console ? 'Your owner has changed your owner mandate since console set it: the Valun server holds '
    : 'The Valun server also holds ';
  if (!held.length) return lead + `nothing for your owner ${where} now.`;
  return lead + `these for your owner ${where} until they approve: ${held.join('; and ')}. It never holds an honor of `
    + 'a guarantee call.';
}

/**
 * What an acceptance held for an owner (accepted_awaiting_owner) waits for, as the server's answer names it (as the
 * Python agent's acceptance_wait): acceptance.held_for ('acceptor_owner' and/or 'proposer_owner') and the pending
 * approvals of this participant. [text, fields]. Only when this participant's owner holds it does it name the owner
 * console, with ownerWait's fields; when only the proposer's owner does, it says so and names no console (the 0.7.2
 * review). An answer that names neither says both may, and where this owner would approve it, with no fields.
 */
export function acceptanceWait(c, r, dealId, command = null) {
  const acc = isDict(r) && isDict(get(r, 'acceptance')) ? r.acceptance : {};
  const heldFor = Array.isArray(get(acc, 'held_for')) ? acc.held_for : [];
  const [where, fields] = ownerWait(c, r, dealId, command);
  const mine = heldFor.includes('acceptor_owner') || Object.hasOwn(fields, 'approval_id')
    || Object.hasOwn(fields, 'approval_ids');
  const theirs = heldFor.includes('proposer_owner');
  const cp = handleOf(r), before = until(get(termsOf(r), 'offer_expires_at'));
  const seen = ` ${cp} already sees that you accepted and that it waits (not your signature), and may still withdraw its `
    + 'offer.';
  if (mine && theirs) {
    return [`You signed your acceptance of ${cp}'s offer. It binds only once your owner approves it${where} and `
      + `${cp}'s owner confirms its offer (their limits require it)${before}.${seen} Tell your owner. If your `
      + 'owner rejects it, the offer is open again. valun_deal shows when both are decided.', fields];
  }
  if (mine) {
    return [`You signed your acceptance of ${cp}'s offer. It binds only once your owner approves it${where}${before}.`
      + `${seen} Tell your owner: nothing else tells them. If your owner rejects it, the offer is open again.`, fields];
  }
  if (theirs) {
    return [`You signed your acceptance. It binds once ${cp}'s owner confirms its offer (their limits require it). `
      + `Nothing waits for your owner. If ${cp}'s owner does not confirm, the offer is withdrawn and your `
      + 'acceptance is void; nothing is owed. valun_deal shows when it is decided.', {}];
  }
  return ['You signed the acceptance; it becomes binding when the owner holding it approves (yours, or the '
    + `proposer's if their limits require it; valun_deal shows which). If it is yours, your owner approves it${where}.`, {}];
}

/** The deal statuses in which an owner decides (valun_deal's whose_turn: ownerTurn), as the Python agent's OWNER_WAITS. */
export const OWNER_WAITS = Object.freeze(['proposed_awaiting_owner', 'accepted_awaiting_owner', 'completion_awaiting_owner',
  'rejected_by_owner']);

/**
 * valun_deal's whose_turn while an owner decides, for the viewer meId, as the Python agent's owner_turn: the payer's held
 * payment says until when (a payment by transfer its hold's end; an IOU its hour, and once that has passed, that the
 * owner must reject it).
 */
export function ownerTurn(d, meId, nowMs = null) {
  const st = get(d, 'status'), role = get(d, 'your_role');
  if (st === 'proposed_awaiting_owner') {
    return "your owner's: your signed offer waits for them in the owner console; the other side cannot see it yet";
  }
  if (st === 'rejected_by_owner') return 'nobody: your owner rejected this offer; it was never shown to the other side, and binds nobody';
  if (st === 'completion_awaiting_owner') {
    if (role !== 'payer') return "the payer's owner's: the payment its agent signed when it accepted your delivery waits for them";
    const pay = isDict(get(d, 'payment')) ? d.payment : {};
    const hold = get(pay, 'state') === 'awaiting_owner' ? get(pay, 'expires_at') : null;
    if (typeof hold === 'string' && hold) {
      return "your owner's: the payment by transfer you signed when you accepted the delivery waits for them in the "
        + `owner console until ${shown(hold)} (20 minutes after you signed it); then it ends and nothing moves`;
    }
    const [by, exp, passed] = heldNoteHour(d, nowMs);
    if (passed) {
      return "your owner's: the note you signed when you accepted the delivery still waits for them, but the tracker "
        + `records it only until ${exp}, which has passed: tell your owner to reject it in the owner console `
        + '(approved now, it would fail at the tracker and leave the delivery accepted, unpaid and no longer '
        + 'disputable), then accept the delivery again to sign a new note';
    }
    if (exp) {
      return "your owner's: the note you signed when you accepted the delivery waits for them in the owner console: "
        + `they approve or reject it by ${deadlineWords(by, exp)}`;
    }
    return "your owner's: the note or payment by transfer you signed when you accepted the delivery waits for them in "
      + 'the owner console';
  }
  const acc = isDict(get(d, 'acceptance')) ? d.acceptance : {};
  const heldFor = Array.isArray(get(acc, 'held_for')) ? acc.held_for : [];
  const acceptor = get(acc, 'by') === meId;
  const owners = [heldFor.includes('acceptor_owner') ? (acceptor ? 'your owner' : "the acceptor's owner") : null,
    heldFor.includes('proposer_owner') ? (acceptor ? "the proposer's owner" : 'your owner') : null].filter(Boolean);
  return "an owner's: the acceptance waits for " + (owners.length ? owners.join(' and ')
    : "an owner (valun_deal approvals lists your own owner's)") + ' in the owner console';
}

/**
 * The statuses of a deal that still waits for its payment, as the Python agent's UNPAID: what a rejected or void IOU or
 * payment by transfer leaves to do applies only then.
 */
export const UNPAID = Object.freeze(['delivered', 'payment_due', 'note_failed']);

/** The past-tense frame of a decision the deal has moved on from, as the Python agent's _earlier. */
function earlierFrame(at, st) {
  return [typeof at === 'string' && at ? `Earlier (${shown(at)}), ` : 'Earlier, ',
    ` The deal has since moved on (${shown(st)}).`];
}

/** What is left to do once a held payment of this deal ended without being sent on, as the Python agent's _pay_steps. */
function paySteps(st, how) {
  if (st === 'delivered') return ` The deal is back to delivered: ${how}, or dispute the delivery.`;
  return ` The delivery stays accepted, and you must still pay it: ${how}.`;
}

/** Python's ts % 1000 (never negative), for a whole number. */
const residue = ts => ((ts % 1000) + 1000) % 1000;

/**
 * valun_deal's owner_decisions, as the Python agent's owner_decisions: what this participant's owner (or the server, for
 * them) decided about something its agent signed that the server held for the owner, and that ended without taking
 * effect, with what it leaves as the server does it (a rejected offer, acceptance or IOU stays on the server, still
 * signed; a payment by transfer that ends is purged). attempts: this client's payment attempt records of the deal, for
 * the times this client actually allows (freeAfter) and whether it counts the attempt as not applied. Next steps only for
 * the last ended approval of each kind, while the deal's status still fits them; otherwise a past-tense line.
 */
export function ownerDecisions(d, attempts = null) {
  d = isDict(d) ? d : {};
  const rows = Array.isArray(get(d, 'approvals')) ? d.approvals : [];
  const cp = handleOf(d), st = get(d, 'status');
  const lead = cp === 'the other side' ? 'The other side' : cp;     // at the start of a sentence
  const open = until(get(termsOf(d), 'offer_expires_at'), 'until');
  const cur = isDict(get(d, 'current')) ? d.current : {};
  const openBy = st === 'open' ? get(cur, 'by') : null;
  const you = get(d, 'you');
  const theirsOpen = openBy !== null && !pyEq(openBy, you);
  const mineOpen = openBy !== null && you !== null && pyEq(openBy, you);
  const pay = isDict(get(d, 'payment')) ? d.payment : {};
  const recs = (Array.isArray(attempts) ? attempts : []).filter(isDict);
  const ended = rows.filter(a => isDict(a) && typeof get(a, 'id') === 'string' && APPROVAL_ID_RE.test(a.id)
    && holdEnded(get(a, 'state')));
  const kindOf = a => (typeof get(a, 'kind') === 'string' ? a.kind : null);
  const last = new Map();                                            // the last ended approval of each kind
  for (const a of ended) last.set(kindOf(a), a.id);
  const out = [];
  for (const a of ended) {
    const kind = get(a, 'kind'), state = a.state;
    const latest = last.get(kindOf(a)) === a.id;
    const [earlier, moved] = earlierFrame(get(a, 'decided_at'), st);
    const mine = recs.find(r => get(r, 'approval_id') === a.id
      || (isDict(get(r, 'server_ended')) && get(r.server_ended, 'approval_id') === a.id)) ?? null;
    const ts = mine !== null && whole(get(mine, 'timestamp')) ? mine.timestamp : null;
    const counted = mine !== null && get(mine, 'outcome') === 'not_applied';
    let text;
    if (kind === 'propose') {
      if (state === 'rejected' && st === 'rejected_by_owner') {
        text = `Your owner rejected your offer: ${cp} never saw it, and the deal has ended. What you signed stays on `
          + 'record at the Valun server and binds nobody. Make a new offer only if your owner wants one.';
      } else if (state === 'rejected') {
        text = latest && theirsOpen
          ? `Your owner rejected your counter-offer, and ${cp} never saw it. Its offer stays as it was${open}: `
            + 'you may accept it, counter again or decline it.'
          : `${earlier}your owner rejected your counter-offer, and ${cp} never saw it.${moved}`;
      } else {
        text = `Your offer (or counter-offer) ended before your owner approved it (${shown(state)}): it was never `
          + `shown to ${cp} and binds nobody.`;
      }
    } else if (kind === 'accept') {
      if (state === 'rejected') {
        text = latest && theirsOpen
          ? `Your owner did not approve your acceptance of ${cp}'s offer. Nothing was agreed; the offer is open `
            + `again${open}, and ${cp} sees that the acceptance was not approved. Accept it again only if your `
            + 'owner wants to: it would wait for them again.'
          : `${earlier}your owner did not approve your acceptance of ${cp}'s offer: nothing was agreed by it.${moved}`;
      } else {
        text = `Your acceptance ended before your owner approved it (${shown(state)}): nothing was agreed, and `
          + 'nothing is owed.';
      }
    } else if (kind === 'confirm_offer') {
      // Rejected: the offer is withdrawn on the owner's behalf. void_acceptance_rejected: the acceptor's owner rejected
      // the acceptance first, and the offer is open again (core.mjs decideApproval). Other void states: it ended.
      if (state === 'rejected') {
        text = `Your owner did not confirm your offer, which ${cp} had accepted: the offer is withdrawn on your `
          + "owner's behalf and the acceptance is void. Nothing is agreed and nothing is owed.";
      } else if (state === 'void_acceptance_rejected') {
        text = latest && mineOpen
          ? `${lead}'s owner did not approve its acceptance of your offer, so your owner had nothing to `
            + `confirm. Nothing was agreed, and your offer is open again${open}.`
          : `${earlier}${cp}'s owner did not approve its acceptance of your offer, so your owner had nothing to `
            + `confirm: nothing was agreed by it.${moved}`;
      } else {
        text = `${lead}'s acceptance of your offer ended before your owner confirmed it (${shown(state)}): nothing `
          + 'was agreed, and nothing is owed.';
      }
    } else if (kind === 'issue_note') {
      const bound = ts !== null && residue(ts) === nv.BOUND_MS && freeAfter(ts) !== null;
      if (!(latest && UNPAID.includes(st))) {
        text = (state === 'rejected' ? `${earlier}your owner rejected the note you signed for this deal`
          : `${earlier}the note you signed for this deal went void (${shown(state)})`) + `: it was never sent to the tracker.${moved}`;
      } else {
        const heads = {
          rejected: 'Your owner rejected the note you signed for this deal. The Valun server did not send it '
            + 'to the tracker, and you owe nothing for it.',
          void_stale: "The note you signed for this deal went void when your owner approved it (void_stale): "
            + "the pair's note or a party's key had changed since you signed it. The Valun server "
            + 'did not send it, and you owe nothing for it.',
          void_key_revoked: 'The note you signed for this deal went void before your owner decided '
            + "(void_key_revoked): a party's key was revoked. The Valun server did not send "
            + 'it, and you owe nothing for it.',
        };
        const head = Object.hasOwn(heads, state) ? heads[state]
          : `The note you signed for this deal went void (${shown(state)}). The Valun server did not send it, `
            + 'and you owe nothing for it.';
        const steps = paySteps(st, st === 'delivered'
          ? 'accept the delivery again to sign a new note (it waits for your owner again)'
          : 'accept it again to sign a new note (it waits for your owner again)');
        const kept = state === 'rejected'
          ? ' The rejection did not unsign it: the server keeps it on record, and the tracker could still '
            + 'record it ' + (bound ? `until ${noteExpiresAt({timestamp: ts})}.`
            : mine === null ? 'until an hour after you signed it.' : 'at any time (an ordinary note has no maximum age).')
          : ' The server keeps it on record, still signed, and never sends it.';
        // This client's own waits where it holds a record of the IOU, else the server's (as the Python agent).
        const wait = bound ? `paying this deal by transfer waits until after ${freeAfter(ts)} (${MARGIN_WORDS})`
          : mine === null ? 'paying this deal by transfer waits until a little over an hour after you signed it, unless this '
            + "pair's note moves past it first"
            : "paying this deal by transfer waits until your client sees this pair's note move past it";
        let count;
        if (counted) {
          count = ' Your Valun client counts it as not applied: a new note of this deal may be signed now, and '
            + wait + (bound ? ", or until your client sees this pair's note move past it." : '.');
        } else if (mine !== null) {
          count = (bound ? ` ${wait[0].toUpperCase()}${wait.slice(1)}.` : '') + (bound
            ? " Your Valun client still counts it as a payment that may apply: once this pair's note moves past "
              + 'it, your client pays this deal no more until your owner resolves it (`valun attempts resolve`).'
            : ' Your Valun client still counts it as a payment that may apply (an ordinary note '
              + 'has no maximum age): it pays this deal by transfer no more until your owner resolves it '
              + '(`valun attempts resolve`).');
        } else {
          count = ` ${wait[0].toUpperCase()}${wait.slice(1)}.`;
        }
        text = head + steps + kept + count;
      }
    } else if (kind === 'pay_by_transfer') {
      if (!(latest && UNPAID.includes(st))) {
        text = (state === 'rejected' ? `${earlier}your owner rejected your payment by transfer`
          : `${earlier}your payment by transfer went void (${shown(state)})`) + `: nothing moved.${moved}`;
      } else {
        const heads = {
          rejected: 'Your owner rejected your payment by transfer.',
          void_expired: 'Your payment by transfer expired before your owner decided (its hold ends 20 '
            + 'minutes after you sign it).',
          void_stale: 'Your payment by transfer went void when your owner approved it (void_stale): it was '
            + "out of date (a note it moves, a party's key or a rule had changed since you signed "
            + 'it).',
          void_key_revoked: 'Your payment by transfer went void before your owner decided '
            + "(void_key_revoked): a party's key was revoked.",
        };
        const head = Object.hasOwn(heads, state) ? heads[state] : `Your payment by transfer went void (${shown(state)}).`;
        const fallback = typeof get(pay, 'fallback_after') === 'string' ? pay.fallback_after : null;
        const free = ts !== null ? freeAfter(ts) : null;
        const other = free ? `after ${free} (${MARGIN_WORDS})` : fallback ? `after ${shown(fallback)}` : 'about an hour after you signed it';
        const sooner = counted ? ', or once your client sees that note move past it'
          : mine === null ? ' (or once that note moves past it)' : '';
        text = head + ' Nothing moved, and the Valun server deleted your signatures of it (it keeps only their '
          + 'hashes).' + paySteps(st, 'pay again through the same note at once while it is unchanged (it '
            + 'waits for your owner again), or with your own note or another note '
            + `${other}${sooner}`)
          + (counted ? ' Your Valun client counts it as not applied.'
            : mine !== null ? ' Your Valun client still counts it as a payment that may apply: once that note moves past it, '
              + 'your client pays this deal no more until your owner resolves it (`valun attempts resolve`).' : '');
      }
    } else if (kind === 'guarantee_offer') {
      text = state === 'rejected'
        ? 'Your owner rejected your guarantee offer: it was never shown, and its cap no longer counts against '
          + 'your limits. Nothing reached the tracker.'
        : `Your guarantee offer ended before your owner approved it (${shown(state)}).`;
    } else {
      text = `Approval ${a.id} (${shown(kind)}) ended as ${shown(state)} without taking effect.`;
    }
    out.push({approval_id: a.id, kind, state, decided_at: get(a, 'decided_at'), what_this_means: text});
  }
  return out;
}

/** The approval kinds whose decision by the other side's owner valun_deal reports, as the Python agent's. */
export const COUNTERPARTY_OWNER_KINDS = Object.freeze(['accept', 'confirm_offer', 'issue_note', 'pay_by_transfer']);

/**
 * valun_deal's counterparty_owner_decisions, as the Python agent's counterparty_owner_decisions: what the other side's
 * owner decided in the owner console about what its agent signed for this deal (the shared history's owner_rejected and
 * owner_approval_void_stale by owner:<the other participant>), and a held payment by transfer of the other side's that
 * ended before its owner decided (payment_void, its reason expired or key_revoked; the payee's view). meId: this
 * participant's id ([] without it).
 */
export function counterpartyOwnerDecisions(d, meId) {
  if (!(isDict(d) && typeof meId === 'string' && meId)) return [];
  const hist = Array.isArray(get(d, 'history')) ? d.history : [];
  const rows = [];
  for (const h of hist) {
    if (!isDict(h)) continue;
    const by = get(h, 'by'), event = get(h, 'event'), kind = get(h, 'kind');
    if (typeof by === 'string' && by.startsWith('owner:') && by !== `owner:${meId}`
      && ['owner_rejected', 'owner_approval_void_stale'].includes(event) && COUNTERPARTY_OWNER_KINDS.includes(kind)) {
      rows.push([h, kind, event]);
    } else if (by === 'valun' && event === 'payment_void' && ['expired', 'key_revoked'].includes(get(h, 'reason'))
      && get(d, 'your_role') === 'payee') {
      rows.push([h, 'pay_by_transfer', event]);
    }
  }
  const cp = handleOf(d), st = get(d, 'status');
  const lead = cp === 'the other side' ? 'The other side' : cp;
  const open = until(get(termsOf(d), 'offer_expires_at'), 'until');
  const last = new Map();
  rows.forEach(([, kind], i) => last.set(kind, i));
  const out = [];
  rows.forEach(([h, kind, event], i) => {
    const latest = last.get(kind) === i;
    const at = typeof get(h, 'at') === 'string' && h.at ? h.at : null;
    const [earlier, moved] = earlierFrame(at, st);
    const isVoid = event === 'owner_approval_void_stale';
    let text;
    if (kind === 'accept') {
      text = latest && st === 'open'
        ? `${lead}'s owner did not approve its acceptance of your offer. Nothing was agreed, and your offer is `
          + `open again${open}.`
        : `${earlier}${cp}'s owner did not approve its acceptance of your offer: nothing was agreed by it.${moved}`;
    } else if (kind === 'confirm_offer') {
      text = `${lead}'s owner withdrew its offer before the deal was agreed. Your acceptance is void, and nothing is `
        + 'owed.';
    } else if (kind === 'issue_note') {
      if (latest && ['delivered', 'payment_due'].includes(st)) {
        text = (isVoid ? `The note ${cp}'s agent signed for your delivery went void when its owner approved it (it was out `
          + 'of date).' : `${lead}'s owner rejected the note its agent signed for your delivery.`)
          + ` Nothing reached the tracker, and ${cp} owes you nothing for this deal yet. `
          + (st === 'delivered' ? `The deal is back to delivered: ${cp}'s agent may accept it again or dispute it.`
            : `The delivery stays accepted: ${cp} must still pay it.`);
      } else {
        text = (isVoid ? `${earlier}the note ${cp}'s agent signed for your delivery went void when its owner approved it`
          : `${earlier}${cp}'s owner rejected the note its agent signed for your delivery`) + `; nothing reached the tracker.${moved}`;
      }
    } else {                                     // pay_by_transfer
      const what = isVoid ? 'went void when its owner approved it (it was out of date)'
        : event === 'payment_void' && get(h, 'reason') === 'expired'
          ? 'expired before its owner decided (20 minutes after its agent signed it)'
          : event === 'payment_void' ? "went void before its owner decided (a party's key was revoked)" : null;
      if (latest && ['delivered', 'payment_due'].includes(st)) {
        text = (what ? `${lead}'s payment by transfer ${what}.` : `${lead}'s owner rejected its payment by transfer.`)
          + (st === 'delivered' ? ' Nothing moved, and the deal is back to delivered.'
            : ` Nothing moved; the delivery stays accepted, and ${cp} must still pay it.`);
      } else {
        text = (what ? `${earlier}${cp}'s payment by transfer ${what}` : `${earlier}${cp}'s owner rejected its payment by transfer`)
          + `; nothing moved.${moved}`;
      }
    }
    out.push({at, kind, event, what_this_means: text});
  });
  return out;
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

/**
 * What a binding deal means for this participant, in the role the signed terms give it. With circulating credit
 * (circulating true: the server offers it) a payer may pay with notes it holds instead of its own (pay_with), as only the
 * acceptance of the delivery decides, so the payer's words promise no credit note (the 0.7.2 clean-user test: tour step
 * 2's offer said "(your credit note)" for a deal the tour paid by transfer). As the Python agent's.
 */
export function owes(role, who, price, unit = UNIT, circulating = false) {
  const p = amountText(price, unit);
  if (role === 'payer' && circulating === true) {
    return `after you accept their delivery you will pay ${who} ${p}: with your own note, or with notes you hold if you choose to.`;
  }
  return role === 'payer' ? `after you accept their delivery you will owe ${who} ${p} (your note).`
    : `you must deliver; ${who} would then owe you ${p} (their note).`;
}

/** The tracker a credit note goes to, in an approval text. */
export function trackerWords(network) {
  return network === TESTNET ? 'the Valun testnet tracker (anchored on Ergo testnet)' : 'the pilot tracker';
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

// valun_directory answers one page (fix inbox #36: small models stalled on the whole directory, about 72 KB for 137
// participants): DIRECTORY_PAGE participants unless the agent asks for up to DIRECTORY_PAGE_MAX, with each about, services
// and wants cut to DIRECTORY_TEXT_MAX code points. The Python core's constants of the same names.
const DIRECTORY_PAGE = 10, DIRECTORY_PAGE_MAX = 50, DIRECTORY_TEXT_MAX = 160;

/**
 * An about, services or wants text as valun_directory shows it: its first DIRECTORY_TEXT_MAX code points, and '…' when
 * it is longer. Any other value is returned as it is. The Python core's directory_text.
 */
function directoryText(v) {
  return typeof v === 'string' && cpLength(v) > DIRECTORY_TEXT_MAX ? cpSlice(v, DIRECTORY_TEXT_MAX) + '…' : v;
}

// valun_directory's label of an agent the server runs, in the server's own A2A words (lib/a2a.mjs PRACTICE_WORDS,
// HOUSE_WORDS): which practice agent it is, and that a house agent runs on a shared AI budget and may decline (fix inbox
// #177 item 6). As the Python agent's.
export const DIRECTORY_LABELS = Object.freeze({[SANDBOX_EXACT]: 'practice agent, operator-run; always exact, the one to try first',
  [SANDBOX_MALLORY]: 'practice agent, operator-run; wrong on purpose about half the time, for trying a dispute'});
export const HOUSE_LABEL = 'house agent, operator-run; Claude on a shared daily and monthly budget, so it may decline';
/** The label valun_directory gives a directory entry: a practice agent's (operator_run) or a house agent's (house_agent), else null. */
export function directoryLabel(p) {
  const h = get(p, 'handle');
  if (get(p, 'operator_run') === true && typeof h === 'string' && Object.hasOwn(DIRECTORY_LABELS, h)) return DIRECTORY_LABELS[h];
  return get(p, 'house_agent') === true ? HOUSE_LABEL : null;
}

/**
 * The approval card's line on the exact check of a built-in job (sandbox.checkBuiltIn; counterparty: the payee's
 * handle), as a list of facts: [] when nothing was checked exactly (not a built-in job: the Nov 18 fresh-join run,
 * finding 10; or no text to recompute from). A delivery with no ```json result block is not in the built-in format,
 * which 0.7.1 and the RC showed as "DOES NOT MATCH (differs in )", with an empty list. The Python core's exact_facts.
 */
export function exactFacts(terms, content, counterparty) {
  let exact;
  try {
    exact = sandbox.checkBuiltIn(terms, content, counterparty);
  } catch {                                           // a malformed result block is a fact to show, not a reason to hide the prompt
    return ['exact result: could not be checked'];
  }
  if (!(truthy(exact) && truthy(get(exact, 'checked')))) return [];
  if (truthy(get(exact, 'exact_result_matches'))) return ['exact result: matches the agreed text'];
  if (get(exact, 'built_in_format') === false) return ['exact result: not in the built-in format (no ```json result block)'];
  return ['exact result: DOES NOT MATCH (differs in ' + iterate(or(get(exact, 'differs_in'), [])).map(k => shown(k)).join(', ') + ')'];
}

// Where an IOU stands, by the confirmation its deal's credit note and its ledger row show (skill.md section 5, "Where your
// IOU stands"): on the testnet the tracker anchors its totals on Ergo testnet; the pilot's tracker has no chain at all.
// How soon the next box commits it is the server's own summary (valun-app d269b1e, Pilot.issuedSummary): one box at a
// time, at most 50 a UTC day, "usually within 15 minutes of a change, as measured on this network", and after 00:00 UTC
// once the day's boxes are used up.
// The Python core's CONFIRMATION_WORDS and CONFIRMATION_WORDS_PILOT.
export const CONFIRMATION_WORDS = Object.freeze({
  local_only: 'recorded by the tracker; no tracker box on Ergo testnet commits it yet. The tracker posts one tracker '
    + 'box at a time, at most 50 a UTC day: the next one commits it, usually within 15 minutes of a change, '
    + "as measured on the testnet, and once the day's 50 are used up, only after 00:00 UTC. The "
    + 'confirmation then reads pending, then confirmed',
  pending: 'a tracker box carries it and waits for an Ergo testnet block; the confirmation then reads confirmed',
  confirmed: 'a confirmed tracker box on Ergo testnet commits it',
});
export const CONFIRMATION_WORDS_PILOT = Object.freeze({
  local_only: 'recorded by the pilot tracker, which has no blockchain connection: its notes stay local_only'});

/** What a credit note's confirmation (local_only, pending, confirmed) means on this network, or null for another. */
export function confirmationMeans(confirmation, network = NETWORK) {
  const words = network === TESTNET ? CONFIRMATION_WORDS : CONFIRMATION_WORDS_PILOT;
  return typeof confirmation === 'string' && Object.hasOwn(words, confirmation) ? words[confirmation] : null;
}

/**
 * The plain summary a server adds to a deal view at note_issued (valun-app, the Nov 18 fresh-join run's fix 5: its
 * `summary`, or labels.summary), as text a tool can show (a string of at most 2000 code points), or null. The Python
 * core's server_summary.
 */
export function serverSummary(d) {
  if (!isDict(d)) return null;
  const labs = isDict(get(d, 'labels')) ? d.labels : {};
  for (const s of [get(d, 'summary'), get(labs, 'summary')]) {
    if (typeof s === 'string' && strip(s) && cpLength(s) <= 2000) return strip(s);
  }
  return null;
}

/**
 * The plain ending of a deal whose IOU was issued (note_issued), for either side (the Nov 18 fresh-join run, finding
 * 12): the server's own summary when it sends one (serverSummary), else one built here from the deal view: who owes
 * whom and how much more, the tracker's running total for that pair, where the IOU stands (confirmationMeans), how to
 * check it, and how it is paid back, as this network and circulating credit allow. role: this side's ('payer' or
 * 'payee'), else the view's your_role. null for any other deal. The Python core's note_summary.
 */
export function noteSummary(d, network = NETWORK, unit = UNIT, circulating = false, server = null, role = null) {
  if (!(isDict(d) && get(d, 'status') === 'note_issued')) return null;
  const own = serverSummary(d);
  if (own) return own;
  const n = isDict(get(d, 'credit_note')) ? d.credit_note : {};
  const tn = isDict(get(n, 'tracker_note')) ? n.tracker_note : {};
  const cur = isDict(get(d, 'current')) ? d.current : {};
  const terms = isDict(get(cur, 'terms')) ? cur.terms : {};
  const price = isDict(get(terms, 'price')) ? get(terms.price, 'amount') : null;
  const amount = whole(get(n, 'amount')) ? n.amount : price;
  const cp = isDict(get(d, 'counterparty')) ? d.counterparty : {};
  const who = typeof get(cp, 'handle') === 'string' && cp.handle ? shown(cp.handle) : 'the other party';
  const payer = (role || get(d, 'your_role')) === 'payer';
  const amt = whole(amount) ? amountText(amount, unit) : 'the price';
  let out = payer ? `You owe ${who} ${amt} more by this deal's note` : `${who} owes you ${amt} more by this deal's note`;
  const total = get(tn, 'amount_collected');
  out += whole(total) ? ` (the tracker's running total for that pair: ${amountText(total, unit)}).` : '.';
  const conf = or(get(n, 'confirmation'), get(tn, 'confirmation'));
  const means = confirmationMeans(conf, network);
  const row = `the row from ${payer ? 'you' : who} to ${payer ? who : 'you'} in GET ${server || 'the server'}/pilot/v1/ledger`;
  if (network === TESTNET) {
    out += means ? ` Where it stands: ${conf}, ${means}.`
      : ' Where it stands: the tracker recorded it, and a tracker box on Ergo testnet commits it.';
    out += ` Check it: ${row} (its total and confirmation), and \`valun audit --mine\`, which checks your records `
      + 'against the box once the next box commits them.';
    const redeem = payer ? `${who} can redeem it for tERG on Ergo testnet only against a reserve you lock under the key that `
        + 'signed it, once a tracker box commits it'
      : `you can redeem it for tERG on Ergo testnet only against a reserve ${who} locks under the key that `
        + 'signed it, once a tracker box commits it';
    if (circulating) {
      const passes = payer ? `${who} passes it on (pays another agent with it, which changes only whom you owe)`
        : `you pass it on (pay_with when you accept a delivery, which changes only whom ${who} owes)`;
      out += ' It stays outstanding until a loop clears it (a set-off around a loop of notes: it clears, and settles '
        + `nothing), ${passes}, or ${redeem}.`;
    } else {
      out += ` It stays outstanding until ${redeem}.`;
    }
    return out;
  }
  out += means ? ` Where it stands: ${means}.` : ' Where it stands: the pilot tracker recorded it.';
  out += ` Check it: ${row}.`;
  if (circulating) {
    return out + ' It stays outstanding until a loop clears it (a set-off around a cycle of debts) or '
      + (payer ? `${who} passes it on` : 'you pass it on') + '; nothing in the pilot redeems it, and PC have no value.';
  }
  return out + ' Nothing in the pilot settles it: there is no redemption, reserve or clearing, and PC have no value.';
}

/** The server this client's profile names, or null. */
function serverOf(c) {
  const state = c?.state;
  const s = isDict(state) ? get(state, 'server') : null;
  return typeof s === 'string' && s ? rstripChars(s, '/') : null;
}

/**
 * valun_inbox's one line for a recently closed deal whose IOU was issued (note_issued), from its inbox brief (its
 * counterparty, your_role and price), or null for any other. The Python core's closed_summary.
 */
export function closedSummary(x) {
  if (!(isDict(x) && get(x, 'status') === 'note_issued')) return null;
  const price = isDict(get(x, 'price')) ? x.price : {};
  const amount = get(price, 'amount'), unit = get(price, 'unit');
  const amt = whole(amount) && typeof unit === 'string' && unit ? amountText(amount, unit) : 'its price';
  const cp = get(x, 'counterparty');
  const who = typeof cp === 'string' && cp ? shown(cp) : 'the other party';
  const lead = get(x, 'your_role') === 'payer' ? `Paid with your note: this deal added ${amt} to what you owe ${who}.`
    : `${who} paid with its note: this deal added ${amt} to what ${who} owes you.`;
  return lead + ' valun_deal shows where it stands on the tracker and how it can be cleared, passed on or redeemed.';
}

/**
 * valun_deal's advice to the payer of a built-in job whose delivery its client checked and found wrong
 * (sandbox.checkBuiltIn): dispute it, saying why. Not in the built-in format (no ```json result block) is said so,
 * never "does not match". The Python core's exact_advice.
 */
export function exactAdvice(exact) {
  if (get(exact, 'built_in_format') === false) {
    return 'The delivery is not in the built-in format: it has no ```json result block to compare with the exact '
      + 'result of the agreed text. Dispute it with that reason instead of issuing a note.';
  }
  return 'The delivered result does not match the exact result of the agreed text '
    + `(differs in: ${iterate(or(get(exact, 'differs_in'), ['the result block'])).map(k => str(k)).join(', ')}). `
    + 'Dispute it with that reason instead of issuing a note.';
}

/**
 * valun_status's words for a self-serve participant (sandbox_only: true), from the server's GET /info self_serve
 * (open_network, renews_while_active) and the participant's sandbox_expires_at, or null for another participant (the
 * Nov 18 fresh-join run, finding 5). The Python core's self_serve_words.
 */
export function selfServeWords(participant, info) {
  const p = isDict(participant) ? participant : {};
  if (get(p, 'sandbox_only') !== true) return null;
  const ss = isDict(info) && isDict(get(info, 'self_serve')) ? info.self_serve : {};
  const until = get(p, 'sandbox_expires_at');
  const when = typeof until === 'string' && until
    ? ` until ${shown(until)}` + (get(ss, 'renews_while_active') === true ? ', renewed while your agent is active' : '') : '';
  if (get(ss, 'open_network') === true) {
    return 'A self-serve participant on the open network: you can deal with any agent whose owner allows it, within '
      + `small limits (limits_in_force)${when}. sandbox_only: true says you joined without an invite; on this `
      + 'network it does not limit whom you deal with.';
  }
  if (get(ss, 'open_network') === false) {
    return 'A self-serve sandbox participant: you can deal only with the sandbox agents (sandbox-exact and '
      + `sandbox-mallory), within small limits (limits_in_force)${when}.`;
  }
  return `A self-serve participant (sandbox_only: true: you joined without an invite), within small limits (limits_in_force)${when}.`;
}

/**
 * A time as recentlyActive reads it in whole microseconds since the epoch (a BigInt), or null when it is missing, naive
 * or unreadable (never seen). The Python core's seen_us.
 */
const seenUs = iso => isoAwareUs(str(iso).replaceAll('Z', '+00:00'));

/**
 * valun_directory's limit or offset: `dflt` when it is absent or null, else a JSON integer (a safe integer; a boolean is
 * not one). Anything else is refused (bad_arguments). The Python core's _page_arg (JavaScript cannot tell 2.0 from 2).
 */
function pageArg(a, k, dflt, what) {
  const v = get(a, k);
  if (v === null || v === undefined) return dflt;
  if (whole(v)) return v;
  throw new ValunError('bad_arguments', pageMessage(k, v, what));
}

/** What valun_directory's limit and offset are, for the refusal of one that is not a whole number. The Python core's. */
export const PAGE_WORDS = Object.freeze({limit: `how many participants to show: 1 to ${DIRECTORY_PAGE_MAX}, ${DIRECTORY_PAGE} by default`,
  offset: 'how many participants to skip: next_offset from the last answer, 0 by default'});

function pageMessage(k, v, what) {
  return `${k} must be a whole number (${what}), not ${shownValue(v)}`;
}

/**
 * A service's title, description and deliverable as the client reads their numeric requirements (measure's
 * requirements): each without its fenced blocks (fences.js), then joined by spaces. Read one by one, a field's fences
 * never share a line with another field's text (fix inbox #70). Joined first, a description that ends at its closing
 * fence would put the deliverable on that fence's line, so the block would not close and the deliverable would be read
 * as quoted; one that starts with a fence would have the title on its opening line. The ``` ... ``` quotes left are
 * taken out of the joined text, so for plain ``` blocks the requirements are those valun 0.7.0 read. (Python
 * agent.service_text.)
 */
function serviceText(svc) {
  return TEXT_FIELDS.map(k => without(str(or(get(svc, k), '')))).join(' ');
}

/** The agreed (or current) service text: where numeric requirements such as '300-500 words' are written (serviceText). */
export function termsText(d) {
  const t = or(get(or(get(or(get(d, 'current'), {}), 'terms'), {}), 'service'), {});
  return serviceText(t);
}

// Fix inbox #35 (the clients' half of #32): every tool's answer gives each amount a unit-neutral name, by the rule the
// server's public answers follow (valun-app lib/pilot/amount-names.mjs). The network names its unit once (valun_status
// `unit`: nanoERG on the testnet), so an amount's name need not carry it, and an agent reading `you_hold_PC: 2500000` on
// the testnet should not report "2,500,000 PC". The `_PC` and `PC` names stay, as deprecated aliases with the same
// values, until a later release removes them, announced in the fix inbox and the changelog first.
const PC_SUFFIX = '_PC';
const neutralName = k => (k === 'PC' ? 'amount' : k.length > PC_SUFFIX.length && k.endsWith(PC_SUFFIX) ? k.slice(0, -PC_SUFFIX.length) : null);
const setOwn = (o, k, v) => Object.defineProperty(o, k, {value: v, enumerable: true, writable: true, configurable: true});
const plainObject = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * A tool's answer with each amount under its unit-neutral name too, at any depth: every key `<name>_PC` gets `<name>`
 * just before it, and the `PC` of a {count, PC} tally gets `amount`, with the same value. A name already present is never
 * overwritten, and a value that is not a plain object or an array (a Uint8Array, a Date) passes through unchanged, as on
 * the server. The answer given is not changed: its objects and arrays are copied (each key an own property, '__proto__'
 * included). The Python core's with_unit_neutral_names.
 */
export function withUnitNeutralNames(v) {
  if (Array.isArray(v)) return v.map(withUnitNeutralNames);
  if (!plainObject(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const y = withUnitNeutralNames(x), n = neutralName(k);
    if (n !== null && !Object.hasOwn(v, n) && !Object.hasOwn(out, n)) setOwn(out, n, y);
    setOwn(out, k, y);
  }
  return out;
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

// What a transport failure means for the agent (fix inbox #132), by the client's cause and outcome, as the Python
// agent's TRANSPORT_WORDS: a read whose answer was cut after its tries, a request whose answer did not come in time
// (asked once), a write whose answer was cut or did not come (the server may have done it), an answer that is not JSON,
// the server not reached; '|' a failure that names no cause. The owner's check is named without a command line (the
// 0.7.2 review: a bare `valun` is not on the PATH of a uvx user, and this package has no CLI). A write whose outcome is
// unknown names what to read before sending it again (fix inbox #148: the natural retry of a lost offer made a second
// one): valun_inbox, valun_deal for its deal, or valun_guarantees for a guarantee's offer, answer or call.
const READ_AGAIN = 'Try again in a minute; if it keeps failing, tell your owner, who can check the connection with the '
  + "doctor command of their Valun CLI, for this agent's profile.";
const READ_FIRST = 'valun_inbox, valun_deal for its deal, or valun_guarantees for a guarantee';
const WRITE_UNKNOWN = 'the server may have done it. Do not send it again before you read what the server holds now '
  + `(${READ_FIRST}), so that nothing is done twice.`;
export const TRANSPORT_WORDS = Object.freeze({
  'connection_cut|': 'The connection to the Valun server was cut before its whole answer arrived, also when your '
    + 'Valun client asked again: that is the network between this machine and the server (or a '
    + 'proxy, VPN or antivirus on it), not a refusal. ' + READ_AGAIN,
  'connection_cut|unknown': 'Your request reached the Valun server, but the connection was cut before its answer '
    + 'arrived, so ' + WRITE_UNKNOWN,
  'timed_out|': 'The Valun server did not answer in time (your Valun client asked once, so as not to add to its '
    + 'load): it may be busy, or something between this machine and the server held the answer; not a '
    + 'refusal. ' + READ_AGAIN,
  'timed_out|unknown': 'Your request was sent to the Valun server, but no answer came in time, so ' + WRITE_UNKNOWN,
  'not_json|': "The Valun server's answer was not JSON, also when your Valun client asked again: it was cut "
    + 'short, or something between this machine and the server (a captive portal, proxy or antivirus) '
    + 'answered instead. ' + READ_AGAIN,
  'not_json|unknown': "Your request reached the Valun server, but its answer was not JSON (cut short, or not the "
    + "server's), so " + WRITE_UNKNOWN,
  'too_large|unknown': "Your request reached the Valun server, but its answer was too large to read (not the "
    + "server's), so " + WRITE_UNKNOWN,
  'not_connected|': 'The Valun server could not be reached, so nothing was sent to it. ' + READ_AGAIN,
  '|': 'The Valun server could not be reached, or its answer did not arrive. If this call was a commitment, read what '
    + `the server holds now (${READ_FIRST}) before you send it again. ` + READ_AGAIN,
});

// A redirect (client.js: the Python agent's redirected_text): the client follows none, so nothing was done, and only the
// owner can change the server's address.
const ORIGIN_RE = /^(https?:\/\/[a-z0-9.-]{1,253}(:[0-9]{1,5})?|https?:\/\/\[[0-9a-f:.]{2,45}\](:[0-9]{1,5})?)$/;
/** what_this_means of a redirect: where it pointed (an origin, as the client names it) when it is known. */
export function redirectedText(location) {
  const where = typeof location === 'string' && ORIGIN_RE.test(location) ? ` to ${location}` : '';
  return `The address set as this agent's Valun server answered with a redirect${where}, which your Valun client `
    + 'never follows, so nothing was done and nothing refused this agent. Tell your owner: if that is their Valun '
    + "server's address now, they set it as this agent's server (the config server command of their Valun CLI).";
}

// A plain-http server (client.js plainHttpRefusal; the Python agent's PLAIN_HTTP_TEXT): no token is sent there. Only
// this client refuses a server on this machine that Node's fetch would send through a proxy (via: 'proxy').
export const PLAIN_HTTP_TEXT = "Your Valun client sends no token to this agent's Valun server: its address is plain http:// on "
  + 'another machine, where a token would cross the network in clear text. Nothing was sent. Tell your '
  + "owner: they set the server's https:// address (the config server command of their Valun CLI), or, "
  + 'only on a network they trust, VALUN_ALLOW_PLAIN_HTTP=1 sends tokens over plain http anyway.';
// Another server than the one the agent's profile joined (the Python client's wrong_server; the Python agent's words).
export const WRONG_SERVER_TEXT = "This call was meant for another Valun server than the one this agent's profile joined, so your "
  + 'Valun client sent its token nowhere. Nothing was sent. Tell your owner: a profile moves to another server only with '
  + 'the config server command of their Valun CLI.';
export const PLAIN_HTTP_PROXY_TEXT = "Your Valun client sends no token to this agent's Valun server: its address is plain "
  + "http:// on this machine, but Node's fetch would send it through a proxy, which would read the token in clear text. "
  + 'Nothing was sent. Tell your owner: they name the server in NO_PROXY, or, only if they trust that proxy, set '
  + 'VALUN_ALLOW_PLAIN_HTTP=1.';
// The same through a fetch dispatcher the application set (setGlobalDispatcher), which may proxy everything (via:
// 'dispatcher'; the RC's review, round 3).
export const PLAIN_HTTP_DISPATCHER_TEXT = "Your Valun client sends no token to this agent's Valun server: its address is "
  + "plain http:// on this machine, but the fetch dispatcher the application that runs it set may send it through a "
  + 'proxy, which would read the token in clear text. Nothing was sent. Tell your owner: the application gives the client '
  + "a fetch that reaches the server directly, or uses the server's https:// address, or, only if they trust that "
  + 'dispatcher, sets VALUN_ALLOW_PLAIN_HTTP=1.';
// The same through a globalThis.fetch that is not Node's own, which an application or a library put in its place and
// which may send anywhere (via: 'fetch'; the RC's review, round 4).
export const PLAIN_HTTP_FETCH_TEXT = "Your Valun client sends no token to this agent's Valun server: its address is plain "
  + "http:// on this machine, but the fetch that the application running it put in place of Node's own may send it "
  + 'through a proxy, which would read the token in clear text. Nothing was sent. Tell your owner: the application gives '
  + "the client the fetch to use, or uses the server's https:// address, or, only if they trust that fetch, sets "
  + 'VALUN_ALLOW_PLAIN_HTTP=1.';
// Certificate checks off in this process (client.js tlsRefusal: NODE_TLS_REJECT_UNAUTHORIZED=0, or a dispatcher made so;
// the RC's review, round 3): no token goes over https then. Only this client: the Python one always checks.
export const TLS_UNVERIFIED_TEXT = "Your Valun client sends no token to this agent's Valun server while this process does "
  + "not check servers' certificates (NODE_TLS_REJECT_UNAUTHORIZED=0, or the fetch dispatcher its application set): "
  + 'whoever answered in its place could read and use it. Nothing was sent. Tell your owner: they turn the checks back on '
  + '(a certificate authority this machine does not trust goes in NODE_EXTRA_CA_CERTS).';

/** TRANSPORT_WORDS for an error with no HTTP status: undefined when none applies (a bad_response that names no cause). */
function transportWords(code, cause, outcome) {
  const known = v => v === undefined || v === null || typeof v === 'string';
  const fallback = code === 'unreachable' ? TRANSPORT_WORDS['|'] : undefined;
  if (!(known(cause) && known(outcome))) return fallback;
  if ((cause === undefined || cause === null) && code !== 'unreachable') return undefined;
  const key = `${cause || ''}|${outcome || ''}`;
  return Object.hasOwn(TRANSPORT_WORDS, key) ? TRANSPORT_WORDS[key] : fallback;
}

/** `text` without a URL's user and password, a bearer token or a Valun agent or owner token (each replaced with ***):
 *  what an exception's own words may carry that must never reach the model (errorPayload's internal_error; the RC's
 *  review, round 3: urllib's error for a proxy URL it cannot read quoted the whole URL). The Python agent's redacted(). */
function redacted(text) {
  return String(text).replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/{0,2})[^\s/@'"<>]+@/g, '$1***@')
    .replace(/\b(bearer)\s+[^\s'"]+/gi, '$1 ***').replace(/\b(vp[a-z])_[A-Za-z0-9_-]+/g, '$1_***');
}

/** A ValunError (or any exception) as a plain object an agent can act on. Never includes secrets: any other
 *  exception's words are redacted (a URL's user and password, a token). */
export function errorPayload(e, setupHint = DEFAULT_SETUP_HINT) {
  if (isValunError(e)) {
    const out = {error: e.code, message: e.message};
    const extra = isDict(e.extra) ? e.extra : {};
    for (const k of ['rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means', 'cause',
      'transport_error', 'outcome']) {
      if (Object.hasOwn(extra, k)) out[k] = extra[k];
    }
    if ((e.code === 'unreachable' || e.code === 'bad_response') && !Object.hasOwn(out, 'what_this_means')
        && (e.status === undefined || e.status === null)) {
      const words = transportWords(e.code, out.cause, out.outcome);
      if (words !== undefined) out.what_this_means = words;
    }
    if (e.code === 'redirected' && !Object.hasOwn(out, 'what_this_means')) out.what_this_means = redirectedText(extra.location);
    if (e.code === 'plain_http' && !Object.hasOwn(out, 'what_this_means')) {
      out.what_this_means = extra.via === 'proxy' ? PLAIN_HTTP_PROXY_TEXT
        : extra.via === 'dispatcher' ? PLAIN_HTTP_DISPATCHER_TEXT : extra.via === 'fetch' ? PLAIN_HTTP_FETCH_TEXT
          : PLAIN_HTTP_TEXT;
    }
    if (e.code === 'tls_unverified' && !Object.hasOwn(out, 'what_this_means')) out.what_this_means = TLS_UNVERIFIED_TEXT;
    if (e.code === 'wrong_server' && !Object.hasOwn(out, 'what_this_means')) out.what_this_means = WRONG_SERVER_TEXT;
    if (e.code === 'approval_unbound' && out.cause === 'unknown_participant') {
      // the counterparty (or issuer, or creditor) named is in no directory entry: reading a deal again cannot help
      out.what_this_means = UNKNOWN_PARTICIPANT_TEXT;
    } else if (e.code === 'approval_unbound') {
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
      out.what_this_means = 'Your earlier note for this deal is (or may already be) on the tracker, so the deal '
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
    if (e.code === 'network_retired' && !Object.hasOwn(out, 'what_this_means')) {   // retired() gives its own
      out.what_this_means = retiredText('another network');
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
        + 'Nothing was signed. Pay with your own note (leave pay_with out); if that fails '
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
  if (e instanceof Error) return {error: 'internal_error', message: redacted(`${e.name}: ${e.message}`)};
  return {error: 'internal_error', message: redacted(`Error: ${String(e)}`)};
}
/**
 * The Valun tools over one participant's Client.
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
 *   rejoinHint      what the owner of a profile of the retired pilot network must do to join the network its server now
 *                   serves, in a new profile (network_retired; retired()). Default DEFAULT_REJOIN_HINT.
 *   consoleCommand  the command the owner runs in a terminal to open the owner console for this profile (`valun
 *                   --profile NAME console`); an answer that waits for the owner names it (ownerWait). null: none.
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
      processConsents = true, consentsOnReads = false, declareRoles = null, briefStatus = false,
      rejoinHint = null, consoleCommand = null} = options;
    if (resolveHost !== null && typeof resolveHost !== 'function') throw new TypeError('resolveHost must be a function');
    this.#client = client;
    this.#now = now || (() => Date.now());
    this.approvals = approvals;
    this.checkLinkHosts = checkLinkHosts;
    this.resolveHost = resolveHost;
    this.hostTimeoutMs = hostTimeoutMs;
    this.setupHint = setupHint || DEFAULT_SETUP_HINT;
    this.rejoinHint = rejoinHint || DEFAULT_REJOIN_HINT;
    this.consoleCommand = typeof consoleCommand === 'string' && consoleCommand ? consoleCommand : null;
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
      valun_guarantees: a => this.guarantees(a), valun_offer_guarantee: a => this.offerGuarantee(a),
      valun_respond_guarantee: a => this.respondGuarantee(a), valun_call_guarantee: a => this.callGuarantee(a),
      valun_check_payer: a => this.checkPayer(a),
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
   * Run one tool. Resolves to a plain object; rejects with a ValunError (use errorPayload to turn it into a result). Its
   * arguments are checked first (toolArguments, fix inbox #58: bad_arguments for arguments that are not a JSON object,
   * lack a required one or, since 0.7.2, have one of another type than its schema's, before anything is read or signed; a
   * value an enum does not list keeps its tool's code, bad_decision say). Before a tool that is not read-only, the client signs the
   * consents its owner's policy allows (consentsIfDue). With consentsOnReads, before valun_status and valun_inbox it signs
   * the value-safe ones (consentsOnRead), and when that run took place the result adds consents_signed_now: one entry
   * (SIGNED_NOW_KEYS) for each consent it signed ([]: none). Every amount of the result has its unit-neutral name too
   * (withUnitNeutralNames, fix inbox #35). A profile of the retired pilot network gets network_retired instead of the
   * refusal its server gives it (retired(); fix inbox #30).
   */
  async call(name, args = null) {
    if (typeof name !== 'string' || !Object.hasOwn(this.handlers, name)) {
      throw new ValunError('unknown_tool', `no Valun tool called ${repr(name)}`);
    }
    const a = this.toolArguments(name, args);
    try {
      return await this.exclusive(() => this.#call(name, a));
    } catch (e) {
      throw (await this.retired(e)) ?? e;
    }
  }

  /**
   * network_retired, for a profile of the pilot network (valun-pilot-1, retired on 2026-11-13; fix inbox #30), in
   * place of a refusal it meets on a server that now serves another network: one of RETIRED_CODES, or approval_unbound
   * with one of them as its cause. One GET /info, read only then, names the server's network (retiredPilot); its
   * what_this_means says how to join again (rejoinHint). Resolves to null for any other error or profile, and when that
   * read fails: the refusal then stands as it is. Never rejects.
   */
  async retired(e) {
    if (!isValunError(e)) return null;
    const extra = isDict(e.extra) ? e.extra : {};
    const code = e.code === 'approval_unbound' ? get(extra, 'cause') : e.code;
    if (!RETIRED_CODES.includes(code)) return null;
    let c, info;
    try {
      c = this.client(false);
      if (profileNetwork(c.state) !== NETWORK) return null;
      info = await c.request('GET', '/pilot/v1/info', undefined, {auth: false});
    } catch {                                         // the server's network is not known: the refusal stands
      return null;
    }
    const net = isDict(info) ? info.network : null;
    if (!retiredPilot(c.state, net)) return null;
    const shownNet = Object.hasOwn(NETWORKS, net) ? net : 'another network';   // the server's word: a known name
    return new ValunError('network_retired', `this profile is on the pilot network (${NETWORK}), retired on `
      + `${PILOT_RETIRED_ON}; the server now serves ${shownNet}; nothing was signed`, undefined,
      {what_this_means: retiredText(shownNet, this.rejoinHint)});
  }

  async #call(name, a) {
    if (!READ_ONLY_TOOLS.includes(name)) {
      await this.#consentsIfDue();
      return withUnitNeutralNames(await this.handlers[name](a));
    }
    const report = CONSENTS_ON_READ_TOOLS.includes(name) ? await this.#consentsOnRead() : null;
    const out = await this.handlers[name](a);
    if (report !== null && isDict(out)) {
      out.consents_signed_now = iterate(or(get(report, 'signed'), [])).filter(isDict)
        .map(e => Object.fromEntries(SIGNED_NOW_KEYS.map(k => [k, get(e, k)])));
    }
    return withUnitNeutralNames(out);
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
   * counts as no circulation, except a tracker the profile is not pinned to (tracker_mismatch) or another network than
   * the profile's (wrong_network), which stops the call: its owner is then not asked to approve what cannot be signed
   * (a profile of the retired pilot gets network_retired).
   */
  async #knownCirculation(c, deal = null) {
    if (this.features !== null) return this.features.includes(CIRCULATION);
    if (deal !== null && !(isDict(deal) && Object.hasOwn(deal, 'payment'))) return false;
    try {
      return this.#remember(await c.info()).includes(CIRCULATION);
    } catch (e) {
      if (isValunError(e) && (e.code === 'tracker_mismatch' || e.code === 'wrong_network')) throw e;
      return false;                                   // a client that cannot read /info: as without circulation
    }
  }

  /**
   * The module's toolArguments() (fix inbox #58), with this profile's unit for the words of an amount, read from its own
   * records: nothing is read from the server (the pilot's PC when the client cannot tell). The Python agent's
   * tool_arguments method.
   */
  toolArguments(name, args) {
    let unit;
    try {
      const st = this.#client.state;
      // A profile that has not joined yet: the words of the one network it would join (profileNetwork; fix inbox #15).
      unit = isDict(st) && !(st.network || st.participant_id) ? NETWORKS[profileNetwork(st)].unit : this.#client.unit;
    } catch {
      unit = UNIT;                                    // a profile that cannot be read now: the call refuses it later, with its own code
    }
    return toolArguments(name, args, typeof unit === 'string' ? unit : UNIT);
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
   * exactly 'decline' or 'withdraw', valun_review_delivery with decision exactly 'dispute', valun_respond_guarantee with
   * action exactly 'accept', 'decline' or 'withdraw' (taking or refusing a backing, or taking back an offer, commits the
   * owner to nothing), valun_call_guarantee (a claim the owner gains by), and valun_set_limits calls that do not loosen a
   * recorded limit. Every other call, including any tool name this client does not know and a misspelt "Accept", is a
   * commitment.
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
    if (name === 'valun_respond_guarantee') return !['accept', 'decline', 'withdraw'].includes(get(a, 'action'));
    if (name === 'valun_call_guarantee') return false;
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
   * or wrong hash, or a pin the agent passed that is not the snapshot's; with the cause bad_arguments, before any read,
   * for arguments the tool refuses: toolArguments): the adapter must then refuse the call. A tool this client does not
   * know gets a generic text; a known commitment never does. Holds the agent's lock (exclusive()).
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
      this.toolArguments(name, args);                 // fix inbox #58: not a JSON object, a required argument missing, or one of the wrong type
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
   * text, and nothing is signed (approval_unbound). A profile that is not connected or configured, or whose pinned
   * tracker the server no longer names, gets that refusal itself (not_connected, not_configured, tracker_mismatch), with
   * its own advice, and so do arguments the tool refuses before anything is read (toolArguments: bad_arguments, or a
   * misspelt value's own code such as bad_decision, as the call itself answers; fix inbox #58).
   */
  async prepareOrRefusal(name, args = null) {
    if (TOOL_NAMES.includes(name)) {
      try {
        this.toolArguments(name, args);
      } catch (e) {
        if (!isValunError(e)) throw e;
        return [null, errorPayload(e, this.setupHint)];
      }
    }
    let prepared, extra = {};
    try {
      prepared = await this.prepare(name, args);
    } catch (e) {                                     // whatever went wrong, nothing is asked and nothing is signed
      prepared = null;
      const retired = await this.retired(e);
      if (retired !== null) return [null, errorPayload(retired, this.setupHint)];
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
    if (name === 'valun_respond_guarantee' && ['release', 'honor'].includes(get(a, 'action'))) {
      return !truthy(get(a, 'expected_terms_hash')) || (get(a, 'action') === 'honor' && !truthy(get(a, 'call_id')));
    }
    if (name === 'valun_offer_guarantee') return true;
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
    const unit = c.unit ?? UNIT, net = c.network ?? NETWORK;
    if (name === 'valun_propose') {
      const other = await this.#resolve(c, get(a, 'counterparty'));
      if (!(isDict(other) && typeof get(other, 'id') === 'string' && other.id)) {
        throw new ValunError('approval_unbound', 'the directory names no participant id');
      }
      const circulating = await this.#knownCirculation(c);
      return {counterparty: other, circulating, not_settled: labels(circulating, net).not_settled, unit, network: net};
    }
    if (name === 'valun_set_limits') {
      const me = await c.me();
      if (!isDict(me)) throw new ValunError('approval_unbound', 'the server sent no participant record');
      return {me};
    }
    if (name === 'valun_offer_guarantee') {
      const people = {issuer: await this.#resolve(c, get(a, 'issuer')), creditor: await this.#resolve(c, get(a, 'creditor'))};
      if (!Object.values(people).every(p => isDict(p) && typeof get(p, 'id') === 'string' && p.id)) {
        throw new ValunError('approval_unbound', 'the directory names no participant id');
      }
      return {...people, not_settled: labels(await this.#knownCirculation(c), net).not_settled, unit, network: net};
    }
    if (name === 'valun_respond_guarantee') {
      const gid = ValunAgent.#gid(get(a, 'guarantee_id'));
      const g = await c.guarantee(gid);
      const role = get(a, 'action') === 'honor' ? 'backer' : 'creditor';
      const chk = await c.verifyGuarantee(g, role);
      const snap = {guarantee: g, checked: chk, not_settled: labels(true, net).not_settled, unit, network: net};
      if (get(a, 'action') === 'honor') {
        const calls = iterate(or(get(g, 'calls'), [])).filter(isDict);
        const cid = get(a, 'call_id');
        const call = truthy(cid) ? calls.find(x => get(x, 'call_id') === cid) ?? null : calls.find(x => ['open', 'failed'].includes(get(x, 'state'))) ?? null;
        if (call === null || !['open', 'failed'].includes(get(call, 'state')) || !whole(get(call, 'amount'))
            || !(typeof get(call, 'call_id') === 'string' && CALL_ID.test(call.call_id))) {
          throw new ValunError('nothing_to_honor', 'no call of this guarantee is waiting to be honored');
        }
        snap.call = call;
      }
      return snap;
    }
    const did = get(a, 'deal_id');
    if (!(typeof did === 'string' && DEAL_ID.test(did))) throw new ValunError('bad_arguments', 'deal_id is missing or malformed');
    const d = await c.deal(did);
    if (!isDict(d)) throw new ValunError('approval_unbound', 'the deal could not be read');
    const snap = {deal: d, checked: ValunAgent.#checked(d, did, c.participantId, name === 'valun_review_delivery', c.unit)};
    snap.circulating = await this.#knownCirculation(c, d);   // read after the check, as before: what owes() says
    snap.not_settled = labels(snap.circulating, net).not_settled;
    snap.unit = unit;
    snap.network = net;
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept' && ValunAgent.#payWith(a) !== null) {
      snap.transfer = await this.#transferSnapshot(c, did, snap.checked, ValunAgent.#payWith(a));
      snap.not_settled = labels(true, net).not_settled;
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
    const ctx = {me_pk: c.pubkey, me_id: c.participantId, now_ms: c.nowMs(), verify: verifyHexFor, unit: c.unit ?? UNIT, pins,
      records: get(state, 'records'),
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
  static #checked(d, did, me, delivery = false, unit = UNIT) {
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
    if (!(isDict(price) && whole(get(price, 'amount')) && get(price, 'unit') === unit)) {
      throw new ValunError('bad_terms', `the price is not a whole number of ${unit}`);
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
    } else if (name === 'valun_offer_guarantee' && Object.hasOwn(snap, 'issuer')) {
      a.issuer = snap.issuer.id;                      // exactly the participants shown
      a.creditor = snap.creditor.id;
    } else if (name === 'valun_respond_guarantee' && ['release', 'honor'].includes(get(a, 'action'))) {
      pin('expected_terms_hash', item(chk, 'terms_hash'), 'stale_terms', 'the guarantee changed after your agent read it');
      if (get(a, 'action') === 'honor') pin('call_id', snap.call.call_id, 'stale_call', 'the call is not the one your agent read');
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
    if (name === 'valun_offer_guarantee') return (b, s) => ValunAgent.#textOfferGuarantee(b, s);
    if (name === 'valun_respond_guarantee' && get(a, 'action') === 'release') return (b, s) => ValunAgent.#textReleaseGuarantee(b, s);
    if (name === 'valun_respond_guarantee' && get(a, 'action') === 'honor') return (b, s) => ValunAgent.#textHonorGuarantee(b, s);
    throw new ValunError('approval_unbound', `no approval text for ${name} with these arguments`);
  }

  static #textOfferGuarantee(a, snap) {
    const u = get(snap, 'unit', UNIT);
    const issuer = shown(get(snap.issuer, 'handle')), creditor = shown(get(snap.creditor, 'handle'));
    const [cap, due, window, honor, ttl] = [['cap', null], ['due_in_hours', null], ['callable_for_hours', 168], ['honor_within_hours', 24],
      ['offer_valid_hours', 24]].map(([k, d]) => guaranteeInt(a, k, d));
    return [
      `Valun - sign a GUARANTEE of what ${issuer} (${shown(item(snap.issuer, 'id'))}) owes ${creditor} (${shown(item(snap.creditor, 'id'))}):`,
      (Array.isArray(get(a, 'deals')) && get(a, 'deals').length
        ? `  you pay ${creditor} up to ${amountText(cap, u)} in all, for what ${issuer} still owes it for the deals `
          + `${get(a, 'deals').map(d => shown(d)).join(', ')} after ${due} h from now (what it owes for any other deal is not covered),`
        : `  you pay ${creditor} up to ${amountText(cap, u)} in all, for what ${issuer} still owes it after ${due} h from now `
          + '(anything it owes it, also what it comes to owe later: the cap is your exposure),'),
      `  if ${creditor} calls in the ${window} h after that; you pay a call within ${honor} h, with your own note`,
      `  the offer stays open ${ttl} h; until the guarantee ends its cap counts against your limits as credit you may have to issue`,
      `If ${creditor} accepts and calls, you will owe ${creditor} what it called (your note); ${issuer} still owes it too.`,
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine('Note written by your agent', {note: or(get(a, 'note'), '')})].join('\n');
  }

  static #textReleaseGuarantee(a, snap) {
    const chk = snap.checked, g = snap.guarantee, u = get(snap, 'unit', UNIT);
    const t = chk.terms;
    const backer = shown(guaranteeParty(g, 'backer', t)), issuer = shown(guaranteeParty(g, 'issuer', t));
    const open = iterate(or(get(g, 'calls'), [])).filter(x => isDict(x) && ['open', 'failed'].includes(get(x, 'state')));
    return [
      `Valun - RELEASE guarantee ${shown(get(g, 'guarantee_id'))} from ${backer}: it guarantees what ${issuer} owes you, up to `
        + `${amountText(t.cap.amount, u)}.`,
      '  after this you can no longer call it' + (open.length ? `; its ${open.length} unhonored call(s) end too` : ''),
      `  terms hash ${chk.terms_hash.slice(0, 16)}... (recomputed from these terms; your Valun client checks it again before signing)`,
      `Releasing gives up the protection; ${issuer} still owes you what it owes.`].join('\n');
  }

  static #textHonorGuarantee(a, snap) {
    const chk = snap.checked, g = snap.guarantee, call = snap.call, u = get(snap, 'unit', UNIT);
    const t = chk.terms;
    const creditor = shown(guaranteeParty(g, 'creditor', t)), issuer = shown(guaranteeParty(g, 'issuer', t));
    const amount = call.amount;
    return [
      `Valun - HONOR call ${shown(get(call, 'call_id'))} of your guarantee ${shown(get(g, 'guarantee_id'))}: ISSUE A NOTE `
        + `of ${amountText(amount, u)} to ${creditor}:`,
      `  you guaranteed what ${issuer} owes ${creditor}, up to ${amountText(t.cap.amount, u)}; honored so far: `
        + `${amountText(whole(get(g, 'honored')) ? g.honored : 0, u)}`,
      `  ${issuer} owes ${creditor} ${shown(get(g, 'issuer_owes_creditor'))} ${u} on the tracker now (as the server shows it); `
        + `the call is due by ${shown(get(call, 'honor_by'))}`,
      `  terms hash ${chk.terms_hash.slice(0, 16)}... (your Valun client checks the guarantee, the creditor's signature on the call `
        + 'and your own record of the cap again before signing)',
      `Your agent signs a note in the tracker's format; ${trackerWords(get(snap, 'network'))} then records that you owe `
        + `${creditor} `
        + `${amountText(amount, u)} more.`,
      get(snap, 'not_settled', NOT_SETTLED)].join('\n');
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
    const other = snap.counterparty, u = get(snap, 'unit', UNIT);
    required(a, PROPOSE_TEXTS.slice(1));            // what propose() refuses (fix inbox #58) is never put to the owner; the
    // counterparty is the snapshot's (bound by #bindFrom)
    const role = get(a, 'role');
    if (role !== 'payer' && role !== 'payee') throw new ValunError('bad_role', 'role must be payer or payee');
    const [price, due, ttl] = ValunAgent.#offerNumbers(a, u);     // exactly what propose() signs, or its refusal
    const who = shown(get(other, 'handle'));
    return [
      `Valun - sign a NEW OFFER to ${who} (${shown(item(other, 'id'))}):`,
      `  you are the ${ROLE_WORDS[role]}; price: ${amountText(price, u)}`,
      `  deliver within ${due} h; the offer stays open ${ttl} h`,
      `If ${who} accepts, the deal is binding without asking you again: ` + owes(role, who, price, u, get(snap, 'circulating')),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine('Offer text written by your agent', Object.fromEntries(TEXT_FIELDS.map(k => [k, get(a, k)])))].join('\n');
  }

  /**
   * valun_propose's price, deliver_within_hours (default 48) and offer_valid_hours (default 24): each a JSON integer of
   * at least 1 (count), and the offer open no longer than the hours it gives to deliver (checkOfferHours). Exactly what
   * propose() signs, or bad_arguments before anything is read or signed (also for a missing price: fix inbox #58).
   */
  static #offerNumbers(a, unit) {
    const price = count('price', get(a, 'price'), unit);
    // The offer's default validity is never longer than the hours it gives to deliver: a 6 h job's offer is open 6 h.
    const due = hoursOr(a, 'deliver_within_hours', 48), ttl = hoursOr(a, 'offer_valid_hours', Math.min(24, due));
    checkOfferHours(ttl, due);
    return [price, due, ttl];
  }

  /**
   * valun_respond counter's price, deliver_within_hours and offer_valid_hours: each null when absent or null (the price
   * and deadline of their offer; Client.counter's default validity), else a JSON integer of at least 1 (count); with
   * both hours given, the counter-offer open no longer than the hours it gives to deliver.
   */
  static #counterNumbers(a, unit) {
    const price = countOr(a, 'price', unit), hours = hoursOr(a, 'deliver_within_hours'), ttl = hoursOr(a, 'offer_valid_hours');
    if (hours !== null && ttl !== null) checkOfferHours(ttl, hours);
    return [price, hours, ttl];
  }

  /**
   * The hours Client.counter() gives a counter-offer to deliver when it keeps the deadline of the offer it answers: the
   * whole hours left until `deadline`, at least 1. null when the deadline cannot be read (the Python core's
   * _hours_to_deliver).
   */
  #hoursToDeliver(deadline) {
    const t = isoAwareMs(str(deadline).replaceAll('Z', '+00:00'));
    return t === null ? null : Math.max(1, Math.floor((t - this.#now()) / 3_600_000));
  }

  #textAccept(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service, u = get(snap, 'unit', UNIT);
    return [
      `Valun - ACCEPT ${who}'s offer (${shown(chk.other_id)}, deal ${shown(t.deal_id)}, version ${shown(get(t, 'version'))}):`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${amountText(price, u)}; deliver by ${shown(get(t, 'deliver_by'))}`,
      `  terms hash ${chk.terms_hash.slice(0, 16)}... (recomputed from these terms; your Valun client checks it again before signing)`,
      'This makes the deal binding on both sides: ' + owes(chk.role, who, price, u, get(snap, 'circulating')),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine(`Offer text written by ${who}`, Object.fromEntries(TEXT_FIELDS.map(k => [k, get(svc, k)])))].join('\n');
  }

  #textCounter(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), old = chk.price, svc = chk.service, u = get(snap, 'unit', UNIT);
    // Exactly what Client.counter() signs: these arguments, and the rest copied from the terms pinned by hash.
    const [nw, hours, ttl] = ValunAgent.#counterNumbers(a, u);
    if (ttl !== null && hours === null) {     // their deadline, in the whole hours Client.counter() will give to deliver
      const due = this.#hoursToDeliver(get(t, 'deliver_by'));
      if (due !== null) checkOfferHours(ttl, due);
    }
    const price = nw === null ? old : nw;
    const texts = TEXT_FIELDS.filter(k => truthy(get(a, k)));
    const changes = [...(nw !== null ? [`price ${old} -> ${price} ${u}`] : []),
      ...(hours !== null ? [`deliver within ${hours} h`] : []), ...texts.map(k => `${k} (quoted below)`)];
    const stays = ttl !== null ? `the counter-offer stays open ${ttl} h`
      : `the counter-offer stays open ${COUNTER_OFFER_HOURS} h, or less: never past its delivery deadline, nor past `
        + `${shown(get(t, 'offer_expires_at'))}, when their offer ends`;
    return [
      `Valun - sign a COUNTER-OFFER to ${who} (${shown(chk.other_id)}, deal ${shown(t.deal_id)}), `
        + `replacing their version ${shown(get(t, 'version'))}:`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${amountText(price, u)}`,
      '  deliver ' + (hours !== null ? `within ${hours} h of signing`
        : `by ${shown(get(t, 'deliver_by'))} as in their offer (rounded down to the hour, at least 1 h after signing)`),
      '  your agent changes: ' + (changes.join(', ') || 'nothing') + '; ' + stays,
      `If ${who} accepts it, the deal is binding without asking you again: ` + owes(chk.role, who, price, u, get(snap, 'circulating')),
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine(`Counter-offer text, with what your agent did not change copied from ${who}'s offer`,
        Object.fromEntries(TEXT_FIELDS.map(k => [k, truthy(get(a, k)) ? item(a, k) : get(svc, k)])))].join('\n');
  }

  async #textReview(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service, dl = chk.delivery, content = chk.content;
    const u = get(snap, 'unit', UNIT);
    const m = await measure(content, serviceText(svc), {checkHosts: false});
    const facts = m.checks_against_agreed_terms.map(x => `${x.requirement}: ${x.measured} (${x.met ? 'met' : 'NOT met'})`);
    facts.push(...exactFacts(t, content, chk.handle));
    return [
      `Valun - ACCEPT ${who}'s delivery (${shown(chk.other_id)}, deal ${shown(t.deal_id)}) and ISSUE A NOTE `
        + `of ${amountText(price, u)} to ${who}:`,
      `  delivered: ${utf8(content).length} bytes, sha256 ${chk.sha256.slice(0, 16)}... (recomputed from the text measured here)`,
      '  measured: ' + (facts.join('; ') || `${m.word_count} words, ${m.links.length} links`),
      `  agreed terms hash ${chk.terms_hash.slice(0, 16)}... (your Valun client checks both hashes again before signing)`,
      `Your agent signs a note in the tracker's format; ${trackerWords(get(snap, 'network'))} then records that you owe `
        + `${who} `
        + `${amountText(price, u)} more.`,
      get(snap, 'not_settled', NOT_SETTLED),
      quoteLine('Delivery title and agreed service text', {delivery_title: or(get(dl, 'title'), ''), title: get(svc, 'title'),
        deliverable: get(svc, 'deliverable')})].join('\n');
  }

  /** A delivery acceptance paid with a held note (pay_with): what moves, from the checked transfer template. */
  async #textPay(a, snap) {
    const chk = snap.checked, tr = snap.transfer;
    const t = chk.terms, svc = chk.service, dl = chk.delivery, content = chk.content, price = chk.price;
    const u = get(snap, 'unit', UNIT);
    const payee = this.#who(chk);
    const iss = tr.issuer;
    const issuer = typeof get(iss, 'handle') === 'string' && iss.handle ? shown(iss.handle) : shown(iss.id);
    const x = tr.claim, y = tr.to_prior;
    const speed = get(tr.option, 'issuer_consents');
    const m = await measure(content, serviceText(svc), {checkHosts: false});
    const facts = m.checks_against_agreed_terms.map(f => `${f.requirement}: ${f.measured} (${f.met ? 'met' : 'NOT met'})`);
    facts.push(...exactFacts(t, content, chk.handle));
    const speedWords = typeof speed === 'string' && Object.hasOwn(CONSENT_SPEED_WORDS, speed) ? CONSENT_SPEED_WORDS[speed] : shown(speed);
    return [
      `Valun - PAY ${payee} ${amountText(price, u)} for deal ${shown(t.deal_id)} by moving ${amountText(price, u)} `
        + `of what ${issuer} owes you to ${payee}:`,
      `  the total of ${issuer}'s note to you: ${x} -> ${x - price} ${u} (issuer signature checked by your client)`,
      `  the total of ${issuer}'s note to ${payee}: ${y} -> ${y + price} ${u}; what ${issuer} owes in all does not change`,
      '  you issue no note for this deal',
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
    const given = isDict(a) ? get(a, 'brief') : null;
    const brief = given === null || given === undefined ? this.briefStatus : given;   // null is not given (fix inbox #58 review)
    if (typeof brief !== 'boolean') throw new ValunError('bad_arguments', 'brief must be true or false');
    const out = await this.#fullStatus();
    return brief ? briefStatus(out) : out;
  }

  async #fullStatus() {
    const c = this.client();
    const me = await c.me(), info = await c.info();
    const circulating = this.#remember(info).includes(CIRCULATION);
    const u = c.unit ?? UNIT;
    const lab = labels(circulating, c.network ?? NETWORK);
    const recorded = or(get(me, 'agent_limits'), {});
    let approvals = or(this.approvals, 'Commitments are signed without asking your owner first.');
    // The approvals sentence of this host's mode, then what the server holds for the owner by the mandate in force
    // (approve_above and review_deliveries: the approval semantics of 2026-11-17), and where the owner decides.
    approvals += ' ' + heldForOwner(item(me, 'mandate'), get(c.state, 'server'), u, this.approvals === CONSOLE_APPROVALS);
    const inForce = or(get(me, 'effective_limits'), item(me, 'mandate'));
    const words = selfServeWords(item(me, 'participant'), info);
    const out = {
      connected: true, server: item(c.state, 'server'), network: item(info, 'network'),
      unit: item(info, 'unit') + (Object.hasOwn(UNIT_WORDS, item(info, 'unit')) ? UNIT_WORDS[item(info, 'unit')] : ''),
      you: item(me, 'participant'), ...(words ? {you_are: words} : {}),
      objective_from_your_owner: or(get(item(me, 'mandate'), 'objective'), '(none set)'),
      goals_your_owner_told_you: or(get(recorded, 'notes'), '(none recorded yet: ask your owner, then use valun_set_limits)'),
      limits_you_recorded: Object.fromEntries(items(recorded).filter(([k]) => k !== 'notes' && k !== 'set_at')),
      limits_in_force: Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [arg, get(inForce, field)])),
      mandate: Object.fromEntries(items(item(me, 'mandate')).filter(([k]) => k !== 'objective')), mandate_version: item(me, 'mandate_version'),
      approvals, position: item(me, 'position'),
    };
    if (isDict(get(me, 'room'))) out.room = me.room;         // budget cards: what this agent owes now and may still owe
    Object.assign(out, {authority: item(me, 'authority'), settlement: lab.settlement, honest_labels: {...lab.honest_labels},
      real_vs_simulated: {...lab.real_vs_simulated}});
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
    const u = c.unit ?? UNIT;
    const signs = clientSigns(policy, u);
    const hold = get(pos, 'claims_held'), owe = get(pos, 'owes'), net = get(pos, 'net');
    const cleared = get(pos, 'cleared_by_setoff', get(pos, 'settled', 0));
    let pending = get(box, 'consents_waiting_for_your_client');
    if (pending === null && isDict(get(pos, 'pending'))) pending = get(pos.pending, 'consents_waiting_for_you');
    const log = Array.isArray(get(c.state, 'consent_log')) ? c.state.consent_log : [];
    const spend = notes.reduce((t, n) => t + n.amount_PC, 0);
    const summary = `You hold ${shown(hold)} ${u} of notes others issued to you and owe ${shown(owe)} ${u} of your own `
      + `(net ${shown(net)} ${u}); `
      + `set-offs have cleared ${shown(cleared)} ${u} so far. `
      + (notes.length ? `You can spend ${amountText(spend, u)} of notes you hold (${notes.map(n => shown(n.issuer)).join(', ')}) with pay_with `
        + 'when you accept a delivery. ' : 'You hold no notes you can spend now. ')
      + (signs.length ? 'Your Valun client signs by itself: ' + signs.join('; ') + '.' : 'Your Valun client signs no consents by itself.')
      + (whole(pending) && pending > 0 ? ` ${pending} consent(s) wait for your client.` : '');
    const out = {summary,
      money_view: {you_hold_PC: hold, you_owe_PC: owe, net_PC: net, cleared_so_far_PC: cleared,
        how_to_read: 'hold: the notes others issued to you that are still outstanding (what '
          + 'they owe you); owe: your own outstanding notes (what you owe); net = hold - '
          + 'owe. Paying with a note you hold moves that much of it to the payee (hold '
          + 'falls by the price); a set-off clears a loop of notes (hold and owe fall '
          + 'together, net does not change): it clears, and settles nothing; '
          + 'cleared_so_far counts what set-offs cleared. '
          + (Object.hasOwn(VALUE_WORDS, u) ? VALUE_WORDS[u] : VALUE_WORDS.PC)},
      notes_you_can_spend: notes,
      payments_in_progress: Array.isArray(get(box, 'payments_in_progress')) ? box.payments_in_progress : [],
      clearing: {your_client_signs: signs, consents_pending: pending,
        recent: log.slice(-5).filter(isDict).map(e => Object.fromEntries(['at', 'kind', 'decision', 'code', 'amount', 'your_net_change_PC']
          .map(k => [k, get(e, k)])))},
      consent_policy_in_force: policy};
    const waiting = guaranteesWaiting(get(box, 'guarantees'));
    if (truthy(waiting)) out.guarantees_waiting = waiting;
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
          + 'much of what they owe you onto the payee'});
    }
    return out;
  }

  /**
   * The exact next tool calls of the five-step sandbox tour (design 9.2), from the inbox and the position: answer what
   * waits for you first (an offer, a delivery to make, a delivery to review), then the next deal of the tour from what
   * you hold and owe. Wait (no calls) while the sandbox agents or a set-off are working. Once the end has been seen, the
   * profile keeps it (TOUR_DONE_KEY) and the tour stays done, whatever is dealt with them later. A done plan asks for
   * no retry.
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
    const network = c.network ?? undefined, unitWord = c.unit ?? UNIT;
    const notary = sandbox.priceOf('notary', network);
    const stepOf = (cp, role) => (cp === SANDBOX_EXACT ? (role === 'payee' ? 1 : (hm >= notary ? 5 : 3)) : (role === 'payer' ? 2 : 4));
    const plan = (step, calls, then, retryAfter = SANDBOX_RETRY_S) => {
      const done = whole(step) && Object.hasOwn(TOUR_AFTER, step) ? TOUR_AFTER[step] : null;
      const scale = c.scale ?? 1;
      return {tour_step: step, of: 5, goal: tourGoal(step, unitWord, scale),
        next_calls: calls, then, with_the_sandbox_agents: held,
        ...(done ? {when_done: {you_hold_PC: done[0] * scale, you_owe_PC: done[1] * scale}} : {}),
        // fix-inbox #8: how long to wait before calling valun_status again, so a small model does not poll
        ...(retryAfter ? {retry_after_seconds: retryAfter} : {})};
    };
    const call = (tool, args, why) => ({tool, arguments: args, why});
    if (c.participantId && get(c.state, TOUR_DONE_KEY) === c.participantId) {
      return plan('done', [], TOUR_COMPLETED, null);    // done once: what it holds and owes now is not a tour step
    }
    const offer = (step, cp, role, service) => {
      const price = sandbox.priceOf(service, network);
      const args = {counterparty: cp, role, title: `${service} job`,
        description: `${service} for this text:\n\`\`\`\n${TOUR_TEXTS[step]}\n\`\`\``,
        deliverable: `The exact ${service} result as JSON.`, price, deliver_within_hours: 24, offer_valid_hours: 1};
      const why = role === 'payer' ? `buy ${service} from ${cp} for ${price} ${unitWord}` : `offer to sell ${service} to ${cp} for ${price} ${unitWord}`;
      return plan(step, [call('valun_propose', args, why)], `${cp} answers within a few seconds; call valun_status again for the next step.`);
    };
    const wait = 'The sandbox agents act within a few seconds: call valun_status again.';
    const deals = isDict(get(pos, 'deals')) ? pos.deals : {};
    const count = bucket => (whole(get(deals, bucket)) && deals[bucket] > 0 ? deals[bucket] : 0);
    const paidByTransfer = count('paid_by_transfer');
    let cleared = get(pos, 'cleared_by_setoff', get(pos, 'settled', 0));
    cleared = whole(cleared) && cleared > 0 ? cleared : 0;
    if (listed.awaiting_your_owner.length) {
      const x = listed.awaiting_your_owner[0];
      const [where] = ownerWait(c, {approvals: [{id: get(x, 'approval_id'), state: 'pending'}]}, get(x, 'deal_id'),
        this.consoleCommand);
      // A held note names the console's deadline for it, and once the tracker's hour has passed, that the owner must
      // reject it (the 0.7.2 review).
      const [by, exp, passed] = heldNoteOf(c, x, typeof c.nowMs === 'function' ? c.nowMs() : this.#now());
      const then = passed
        ? `The note you signed for deal ${shown(get(x, 'deal_id'))} still waits for your `
          + `owner${where}, but the tracker records it only until ${exp}, which has passed: tell `
          + 'your owner to reject it there (approved now, it would fail at the tracker and leave '
          + 'the delivery accepted, unpaid and no longer disputable), then call valun_status '
          + 'again: the next step pays the deal again.'
        : `Your owner must first approve a commitment${where}`
          + (exp ? ` (a note: by ${deadlineWords(by, exp)})` : '')
          + '; tell them, then call valun_status again.';
      // Fix inbox #175: the step in hand, from the holdings, and that it waits; never "complete" (0.7.2 said so for a
      // participant whose first two steps were held, holding and owing nothing).
      const step = tourStepFrom(hx, hm, ox, paidByTransfer, cleared, notary);
      const p = plan(step === 'done' ? 5 : step, [], then, OWNER_RETRY_S);
      const what = truthy(get(x, 'approval_id'))
        ? `approval ${shown(x.approval_id)}` + (truthy(get(x, 'deal_id')) ? ` (deal ${shown(x.deal_id)})` : '')
        : 'a commitment of yours';
      p.goal = `Waiting for your owner: ${what} is held for them in the owner console. Then: ` + p.goal;
      p.waiting_for_your_owner = Object.fromEntries(['approval_id', 'deal_id', 'kind'].filter(k => get(x, k) !== null).map(k => [k, x[k]]));
      return p;
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
        exact = sandbox.checkBuiltIn(terms, get(dl, 'content'), cp);
      } catch {                                       // an unreadable result block is a wrong one
        exact = {checked: true, exact_result_matches: false, differs_in: ['the result block'], service: sandbox.whichService(terms)};
      }
      if ((isDict(d) && get(d, 'status') === 'payment_due') || (truthy(exact) && truthy(get(exact, 'exact_result_matches')))) {
        const other = cp === SANDBOX_EXACT ? SANDBOX_MALLORY : SANDBOX_EXACT;
        const pay = whole(price) && (spendable.get(other) ?? 0) >= price ? other : 'own_note';
        const args = {deal_id: did, decision: 'accept', expected_deliverable_sha256: get(dl, 'sha256'), pay_with: pay};
        const why = 'the delivery matches the exact result of the agreed text: accept it and pay '
          + (pay === 'own_note' ? 'with your own note' : `with the note ${pay} issued to you`);
        return plan(step, [call('valun_review_delivery', args, why)],
          'Payment by transfer applies at once with the sandbox agents; call valun_status again.');
      }
      const fields = iterate(or(get(or(exact, {}), 'differs_in'), ['the result'])).map(k => str(k)).join(', ');
      const service = str(or(get(or(exact, {}), 'service'), 'result'));
      const reason = get(or(exact, {}), 'built_in_format') === false
        ? `The delivery is not in the built-in format: it has no \`\`\`json result block to compare with the exact ${service} of `
          + 'the agreed text.'
        : `The delivered result does not match the exact ${service} of the agreed text (differs in: ${fields}).`;
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
      const ok = role === 'payee' || (whole(price) && price <= Math.max(...Object.keys(sandbox.SERVICES).map(s => sandbox.priceOf(s, network))));
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
    // A deal agreed and not yet paid (position bucket agreed_note_not_issued) that no inbox list above shows: its credit
    // note is being recorded (the inbox lists issuing_note in no section, nor note_failed for the payee), or it was paid
    // between the GET /me these holdings come from and the GET /inbox read after it. Either way its note is not in the
    // holdings yet: wait, never start another deal on them (that sold a second job to sandbox-exact).
    if (count('agreed_note_not_issued')) {
      return plan(ox > 0 ? 4 : 1, [], 'A deal of yours with a sandbox agent is being paid (its note is being '
        + 'recorded on the tracker); wait for it: call valun_status again in a few seconds.');
    }
    if ((hx > 0 || hm > 0) && ox > 0) {
      // Step 4's 3-cycle sandbox-mallory -> you -> sandbox-exact -> sandbox-mallory has a third leg that is not yours:
      // sandbox-exact's debt to sandbox-mallory (your step 2 moved part of it there). Without it no set-off can be
      // proposed, and waiting for one only ran into the tour's deadline (onboarding review, 2026-11-16).
      if (hx === 0 && await ValunAgent.#sandboxLeg(c, pos) === 0) {
        const u = c.unit ?? UNIT;
        const then = 'The 3-cycle sandbox-mallory -> you -> sandbox-exact -> sandbox-mallory cannot clear now: '
          + 'it needs sandbox-exact to owe sandbox-mallory, and on the tracker sandbox-exact owes '
          + 'sandbox-mallory nothing, so no set-off can be proposed. Nothing is lost: you hold '
          + `${amountText(hm, u)} of sandbox-mallory's notes and owe ${amountText(ox, u)} to `
          + 'sandbox-exact. It can clear once sandbox-exact owes sandbox-mallory again; call '
          + 'valun_status again in a minute, and if nothing has changed in a few minutes, stop and take '
          + 'the tour again later: it goes on from here.';
        const p = plan(4, [], then, CYCLE_LEG_RETRY_S);
        p.blocked = 'cycle_leg_missing';
        return p;
      }
      return plan(hx > 0 ? 3 : 4, [], 'A set-off of the cycle is due: your Valun client signs it by itself at its '
        + 'next consent run (within about a minute). Call valun_status again.', SETOFF_DUE_RETRY_S);
    }
    // The holdings' rules (tourStepFrom says the same, without these reads and side effects)
    if (hm >= notary) return offer(5, SANDBOX_EXACT, 'payer', 'notary');
    if (hx >= notary && paidByTransfer === 0) return offer(2, SANDBOX_MALLORY, 'payer', 'notary');
    if (hx > 0) return offer(3, SANDBOX_EXACT, 'payer', 'notary');   // once step 2 paid by transfer: pay sandbox-exact with your own note
    if (ox > 0) return offer(4, SANDBOX_MALLORY, 'payee', 'text-stats');
    if (paidByTransfer > 0 && cleared > 0) {
      await c.markSandboxTourDone();                  // kept: later deals with them are not tour steps
      return plan('done', [], ValunAgent.#tourDoneText(pos, cleared, c.unit ?? UNIT), null);
    }
    const anyExact = Object.values(listed).some(xs => xs.some(x => get(x, 'counterparty') === SANDBOX_EXACT));
    if (!anyExact && recentlyActive(null, 10 / 60, get(participant, 'joined_at'), this.#now())) {
      return plan(1, [], 'The welcome job from sandbox-exact usually arrives within a minute of joining; call '
        + 'valun_status again.');
    }
    const p = offer(1, SANDBOX_EXACT, 'payee', 'text-stats');
    if (paidByTransfer > 0) {                         // spent by transfer, but no set-off has cleared anything: not done yet
      p.then = 'The tour is not complete: no set-off has cleared any of the notes you hold or issued yet, and you hold no '
        + "note to spend now. Earn sandbox-exact's note again; then pay sandbox-exact with your own note, and "
        + 'the 2-cycle that forms is cleared by a set-off. sandbox-exact answers within a few seconds; call '
        + 'valun_status again for the next step.';
    }
    return p;
  }

  /**
   * What sandbox-exact owes sandbox-mallory on the tracker: the leg of step 4's 3-cycle that is not the participant's
   * own, from sandbox-exact's public record (GET /participants/{id}: its public_position debts), the narrowest read the
   * server offers. 0.7.2's candidate read the whole public ledger here (about 270 KB) on every valun_status of step 4
   * (the 0.7.2 review; fix inbox #128, #132). sandbox-exact's id is the one the participant's own debt to it names
   * (position debts, recipient_id). null when that id is not known, or the record cannot be read now or shows no debts
   * (then nothing is concluded from it).
   */
  static async #sandboxLeg(c, pos) {
    const debts = isDict(pos) && Array.isArray(get(pos, 'debts')) ? pos.debts : [];
    const ids = [...new Set(debts.filter(d => isDict(d) && get(d, 'to') === SANDBOX_EXACT && typeof get(d, 'recipient_id') === 'string'
      && /^vp_[0-9a-f]{12}$/.test(d.recipient_id)).map(d => d.recipient_id))].sort();
    if (ids.length !== 1) return null;
    let rec;
    try {
      rec = await c.participant(ids[0]);
    } catch (e) {
      if (!isValunError(e) && !(e instanceof PyError && e.name === 'AttributeError')) throw e;
      return null;
    }
    const pp = isDict(rec) && get(rec, 'handle') === SANDBOX_EXACT ? get(rec, 'public_position') : null;
    const owes = isDict(pp) ? get(pp, 'debts') : null;
    if (!Array.isArray(owes)) return null;
    return owes.filter(d => isDict(d) && get(d, 'to') === SANDBOX_MALLORY && whole(get(d, 'amount'))).reduce((t, d) => t + d.amount, 0);
  }

  /**
   * What the tour did, from the participant's own position: earned (hold + spent by transfer + cleared), spent by
   * transfer (transferred_out) and with its own notes (owes + cleared), and what set-offs cleared. Only a set-off that
   * cleared something (cleared > 0) ends the tour, so this never claims one that did not happen.
   */
  static #tourDoneText(pos, cleared, unit = UNIT) {
    const hold = get(pos, 'claims_held'), owe = get(pos, 'owes'), out = get(pos, 'transferred_out');
    let text = 'The tour is complete: ';
    if (whole(hold) && whole(owe) && whole(out)) {
      text += `you earned ${hold + out + cleared} ${unit} and spent ${out + owe + cleared} ${unit} (${out} by transfer, `
        + `${owe + cleared} with your own note), and `;
    }
    text += `set-offs cleared ${cleared} ${unit} of the notes you hold and ${cleared} ${unit} of the notes you issued, `
      + 'without changing your net position.';
    if ((whole(hold) && hold > 0) || (whole(owe) && owe > 0)) text += ` You still hold ${shown(hold)} ${unit} and owe ${shown(owe)} ${unit}.`;
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

  /**
   * One page of the active participants other than this one (fix inbox #36), from the list's own fields: those matching
   * `query` (case-insensitive) in their handle or display name first, then in services or wants, then only in about
   * (then the rest the text filter matches, across two fields); then sandbox-exact, the server's other always-on agents,
   * its house agents and the rest (the server's directory order; fix inbox #177); then those whose agent was active in
   * the last 24 hours (recentlyActive); then the most recently seen (agent_last_seen, never seen last); then by handle
   * (code points). Only the page's participants are looked up (GET /participants/{id}, for their public position). An
   * agent the server runs has a label (directoryLabel).
   */
  async directory(a) {
    const c = this.client();
    const q = lower(or(get(a, 'query'), ''));
    const limit = Math.min(Math.max(pageArg(a, 'limit', DIRECTORY_PAGE, PAGE_WORDS.limit), 1), DIRECTORY_PAGE_MAX);
    const offset = Math.max(pageArg(a, 'offset', 0, PAGE_WORDS.offset), 0);
    const ranked = [];
    for (const p of iterate(await c.directory())) {
      if (item(p, 'id') === c.participantId || item(p, 'status') !== 'active') continue;
      const [handle, name, about, services, wants] = ['handle', 'display_name', 'about', 'services', 'wants'].map(k => lower(str(or(get(p, k), ''))));
      let tier;
      if (!q || handle.includes(q) || name.includes(q)) tier = 0;
      else if (services.includes(q) || wants.includes(q)) tier = 1;
      else if (about.includes(q)) tier = 2;
      else if ([handle, name, about, services, wants].join(' ').includes(q)) tier = 3;
      else continue;
      const active = recentlyActive(get(p, 'agent_last_seen'), 24, get(p, 'joined_at'), this.#now());
      // sandbox-exact first, then the operator's other always-on agents (operator_run), then its house agents, then the
      // rest (the Nov 18 run, #6; the server's directoryOrder; fix inbox #177)
      const kind = get(p, 'operator_run') === true && get(p, 'handle') === SANDBOX_EXACT ? 0 : get(p, 'operator_run') === true ? 1
        : get(p, 'house_agent') === true ? 2 : 3;
      ranked.push({tier, kind, active, seen: seenUs(get(p, 'agent_last_seen')), handle: str(or(get(p, 'handle'), '')), p});
    }
    // as Python sorts its key (tier, kind, not active, never seen, -seen, handle); stable, as Python's sort
    ranked.sort((x, y) => x.tier - y.tier || x.kind - y.kind || Number(!x.active) - Number(!y.active)
      || Number(x.seen === null) - Number(y.seen === null)
      || (x.seen === y.seen ? 0 : x.seen > y.seen ? -1 : 1) || cmpCodePoints(x.handle, y.handle));
    const out = [];
    for (const {p, active} of ranked.slice(offset, offset + limit)) {
      const pos = get(await c.participant(item(p, 'id')), 'public_position', {});
      const label = directoryLabel(p);
      out.push({handle: item(p, 'handle'), id: item(p, 'id'), name: item(p, 'display_name'), operator: item(p, 'operator'),
        ...(label ? {label} : {}), about: directoryText(item(p, 'about')), services: directoryText(item(p, 'services')),
        wants: directoryText(or(get(p, 'wants'), '')), credit_notes_they_hold_PC: get(pos, 'claims_held'),
        credit_notes_they_owe_PC: get(pos, 'owes'), deals: get(pos, 'deals'),
        agent_last_seen: get(p, 'agent_last_seen'), agent_recently_active: active});
    }
    const where = (c.network ?? NETWORK) === TESTNET
      ? 'positions are the notes each agent holds (credit_notes_they_hold_PC) and issued (credit_notes_they_owe_PC), '
        + 'outstanding, as the Valun testnet Basis tracker records them; a tracker box on Ergo testnet commits each '
        + "pair's total. A note is settled only when its holder redeems it against a tERG reserve locked under the key "
        + 'that signed it (GET /reserves); tERG have no monetary value.'
      : 'positions are outstanding credit notes recorded by the pilot Basis tracker; nothing is settled; PC have no value.';
    const total = ranked.length, end = offset + out.length;
    const r = {participants: out, total_matching: total, offset};
    if (end < total) r.next_offset = end;
    r.note = where + ' A participant whose agent has not been seen in the last 24 hours may never answer an offer.';
    if (end < total) {
      r.how_to_see_more = q
        ? `Showing ${offset + 1}-${end} of ${total} matching the query (best matches first). For more, call valun_directory `
          + `again with the same query and offset ${end}, or narrow the query.`
        : `Showing ${offset + 1}-${end} of ${total} (sandbox-exact first, then the operator's other agents, then its house `
          + 'agents, then the most recently active). '
          + `For more, call valun_directory again with offset ${end}, or narrow it with query.`;
    }
    return r;
  }

  /**
   * The server's inbox, with a one-line summary first in each recently closed deal whose IOU was issued (closedSummary;
   * the Nov 18 fresh-join run, finding 12: recent_closed showed only status note_issued).
   */
  async inbox() {
    const box = await this.client().inbox();
    if (!(isDict(box) && Array.isArray(get(box, 'recent_closed')))) return box;
    return {...box, recent_closed: box.recent_closed.map(x => (closedSummary(x) ? {summary: closedSummary(x), ...x} : x))};
  }

  // ---------- guarantees (fix inbox #18) ----------
  static #gid(v) {
    if (!(typeof v === 'string' && GUARANTEE_ID.test(v))) {
      throw new ValunError('bad_arguments', 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees lists them)');
    }
    return v;
  }

  async guarantees(a) {
    const c = this.client();
    if (get(a, 'guarantee_id') !== null) {
      const g = await c.guarantee(ValunAgent.#gid(get(a, 'guarantee_id')));
      const out = guaranteeBrief(g);
      if (isDict(g)) {
        out.terms = get(g, 'terms');
        out.covers = get(g, 'covers');
        out.what_this_means = get(g, 'what_this_means');
        try {
          const chk = await c.verifyGuarantee(g);
          out.checked_by_your_client = {terms_hash_recomputed: chk.terms_hash, backer_signature_valid: true};
        } catch (e) {
          if (!isValunError(e)) throw e;
          out.checked_by_your_client = {problem: e.code, message: e.message};
        }
      }
      return out;
    }
    const gs = await c.guarantees();
    return {guarantees: (Array.isArray(gs) ? gs : []).map(guaranteeBrief),
      how: "A guarantee is a backer's signed promise to pay one creditor, up to a cap, what one issuer still owes it "
        + 'after the due time, if the creditor calls before it expires. valun_guarantees with guarantee_id shows one '
        + 'with its terms.'};
  }

  async offerGuarantee(a) {
    const c = this.client();
    const issuer = await this.#resolve(c, get(a, 'issuer')), creditor = await this.#resolve(c, get(a, 'creditor'));
    const vals = Object.fromEntries([['cap', null], ['due_in_hours', null], ['callable_for_hours', 168], ['honor_within_hours', 24],
      ['offer_valid_hours', 24]].map(([k, d]) => [k, guaranteeInt(a, k, d)]));
    const note = or(get(a, 'note'), '');
    if (typeof note !== 'string') throw new ValunError('bad_arguments', 'note must be text');
    const deals = get(a, 'deals');
    const g = await c.offerGuarantee({issuerId: item(issuer, 'id'), creditorId: item(creditor, 'id'), cap: vals.cap, dueInHours: vals.due_in_hours,
      callableForHours: vals.callable_for_hours, honorWithinHours: vals.honor_within_hours, offerValidHours: vals.offer_valid_hours, note,
      deals: deals === undefined ? null : deals});
    const out = {guarantee: guaranteeBrief(g)};
    const who = shown(get(creditor, 'handle')), of = shown(get(issuer, 'handle'));
    const calls = `If ${who} calls it, you pay each call with your own note to ${who}, which is recorded at once and never `
      + 'held for your owner, even with console approvals.';
    if (isDict(g) && get(g, 'state') === 'awaiting_owner') {
      // Held for the owner (its cap above approve_above), as the Python agent says it.
      const offer = isDict(get(g, 'offer')) ? g.offer : {};
      const aid = get(offer, 'approval_id');
      const [where, wait] = ownerWait(c, typeof aid === 'string' ? {approvals: [{id: aid, state: 'pending'}]} : {},
        get(g, 'guarantee_id'), this.consoleCommand, 'guarantee');
      const cap = whole(get(g, 'cap')) ? amountText(g.cap, c.unit ?? UNIT) : 'its cap';
      out.what_happens_next = `Your signed guarantee offer waits for your owner before ${who} can see it. Your `
        + `owner approves or rejects it${where}${until(get(g, 'offer_expires_at'))}. Its cap `
        + `of ${cap} counts against your total-owed limit while it waits. Tell your owner `
        + `that approving is their last step: ${calls}`;
      Object.assign(out, wait);
    } else {
      out.what_happens_next = `${who} can accept or decline it. Once it is due, it can call what ${of} still owes `
        + `it, up to the cap. ${calls}`;
    }
    return out;
  }

  async respondGuarantee(a) {
    const c = this.client();
    const gid = ValunAgent.#gid(get(a, 'guarantee_id')), action = get(a, 'action');
    const exp = get(a, 'expected_terms_hash');
    let g, cid = null;
    if (action === 'accept') {
      g = await c.acceptGuarantee(gid, {expectedTermsHash: exp});
    } else if (action === 'decline') {
      const reason = or(get(a, 'reason'), '');
      if (typeof reason !== 'string') throw new ValunError('bad_arguments', 'reason must be text');
      g = await c.declineGuarantee(gid, reason);
    } else if (action === 'withdraw') {
      g = await c.withdrawGuarantee(gid);
    } else if (action === 'release') {
      g = await c.releaseGuarantee(gid, {expectedTermsHash: exp});
    } else if (action === 'honor') {
      cid = get(a, 'call_id');
      if (cid !== null && !(typeof cid === 'string' && CALL_ID.test(cid))) throw new ValunError('bad_arguments', 'call_id is malformed (vgc_ + 16 hex)');
      const before = honorMarks(c, gid);
      g = await c.honorGuarantee(gid, {callId: cid, expectedTermsHash: exp});
      if (cid === null) {
        // The call the client chose (its first open or failed one): the one its own honor record now holds a new note
        // for (as the Python agent; the 0.7.2 review: the reply named the last honored call, whichever it was).
        const after = honorMarks(c, gid);
        cid = Object.keys(after).sort(cmpCodePoints).find(k => !pyEq(after[k], Object.hasOwn(before, k) ? before[k] : null)) ?? null;
      }
    } else {
      throw new ValunError('bad_arguments', 'action must be accept, decline, release, withdraw or honor');
    }
    const out = {guarantee: guaranteeBrief(g)};
    if (action === 'honor' && isDict(g)) {
      // An honor is never held for the owner, whatever the mandate says (the approval semantics of 2026-11-17). What is
      // said is the state the server answered for the call this client honored (a note the tracker did not record
      // leaves the call failed, with nothing more owed).
      const call = (Array.isArray(get(g, 'calls')) ? g.calls : []).find(x => isDict(x) && cid !== null
        && get(x, 'call_id') === cid) ?? null;
      const cr = isDict(get(g, 'creditor')) ? g.creditor : {};
      const who = shown(or(get(cr, 'handle'), or(get(cr, 'id'), 'the creditor')));
      const state = call !== null ? get(call, 'state') : null;
      if (state === 'honored' && whole(get(call, 'amount'))) {
        const amount = amountText(call.amount, c.unit ?? UNIT);
        out.what_happened = `You honored call ${shown(cid)}: your note to ${who} for ${amount} `
          + `went to ${trackerWords(c.network ?? NETWORK)} at once. It was not `
          + 'held for your owner: honoring a guarantee call never is, even with console '
          + `approvals. You owe ${who} ${amount} more, and nothing is settled. Tell your owner.`;
      } else if (state === 'failed') {
        out.what_happened = `The tracker did not record your note for call ${shown(cid)}, so it adds nothing to `
          + `what you owe ${who}. The call still waits to be honored: honor it again (your `
          + 'client signs a new note), and tell your owner.';
      } else if (call !== null) {
        out.what_happened = `Your note for call ${shown(cid)} was sent; the server shows the call as `
          + `${shown(state)}: valun_guarantees shows when the tracker has recorded it. It was `
          + 'not held for your owner: honoring a guarantee call never is.';
      }
    } else if (action === 'release') {
      out.what_happened = 'You released the guarantee: it ends, and its calls not yet honored are void. A release '
        + 'is never held for your owner in the owner console.';
    }
    return out;
  }

  async callGuarantee(a) {
    const c = this.client();
    const gid = ValunAgent.#gid(get(a, 'guarantee_id')), amount = get(a, 'amount');
    if (amount !== null && !(whole(amount) && amount > 0)) throw new ValunError('bad_arguments', 'amount must be a whole number of at least 1');
    const g = await c.callGuarantee(gid, {amount, expectedTermsHash: get(a, 'expected_terms_hash')});
    const hours = isDict(g) ? get(g, 'honor_within_hours') : null;
    return {guarantee: guaranteeBrief(g), what_happens_next: `The backer has ${shown(hours)} hours to honor the call with its own note to you.`};
  }

  // ---------- budget cards ----------
  /**
   * valun_check_payer (read only): may `payer` owe this agent `amount` more, by the budget card its owner published? The
   * server's verdict object (Client.checkPayer, with this agent's token: it shows the cover only to the payee itself)
   * with `summary` first (checkSummary). The amount is checked as valun_propose checks its price (count), before anything
   * is read, and so is deal_id (fix inbox #60: the offer under review, which the server then counts once; vd_ + 16 hex).
   * Without deal_id the answer is for a new deal on top of what the payer committed, and the summary says when an offer
   * the payer made this agent at that price is among it (checkSummary). Since fix inbox #87 the server's verdict is the
   * step's, from both sides (payer_side, payee_side), and a payer whose owner has not published a card is checked on this
   * agent's own side only (payer_side null: verdict decline when that side declines, else unknown). A server from before
   * #87 answers card_not_public for such a payer: verdict 'unknown' (uncheckedPayer), an answer, not an error.
   */
  async checkPayer(a) {
    const c = this.client();
    const [payer] = required(a, ['payer'], false);
    if (typeof payer !== 'string' || !strip(payer)) {
      throw new ValunError('bad_arguments', 'payer must be the handle or participant id (text) of the agent that would owe you');
    }
    const amount = count('amount', get(a, 'amount'), c.unit ?? UNIT);
    const dealId = get(a, 'deal_id') ?? null;
    if (dealId !== null && !(typeof dealId === 'string' && OFFER_ID.test(dealId))) {
      const got = quoted(dealId);
      throw new ValunError('bad_arguments', 'deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox '
        + `lists it, not ${got.length <= 40 ? got : got.slice(0, 37) + '...'}`);
    }
    const ref = await c.resolveParticipant(payer);
    let v;
    try {
      v = await c.checkPayer(ref.id, amount, {dealId});
    } catch (e) {
      if (isValunError(e) && e.code === 'card_not_public') return uncheckedPayer(ref, amount, dealId);
      throw e;
    }
    if (!isDict(v)) throw new ValunError('bad_response', 'the server answered the check with no verdict');
    const out = {summary: checkSummary(v)};
    for (const [k, x] of Object.entries(v)) if (k !== 'summary') out[k] = x;
    return out;
  }

  async deal(a) {
    const c = this.client();
    const [did] = required(a, ['deal_id'], false);
    const d = await c.deal(did);
    // A payment of this deal that the server held for the owner and that ended unreleased (rejected in the owner
    // console, or void) is recorded as not applied, so that paying the deal again is not blocked by it (as the Python
    // agent does; the approval probe's D2).
    if (isDict(d) && get(d, 'your_role') === 'payer') await c.learnOwnerDecisions(did, d);
    const out = Object.fromEntries(DEAL_FIELDS.map(k => [k, get(d, k)]));
    const att = isDict(c.state) ? get(c.state, 'transfer_attempts') : null;
    const decided = ownerDecisions(d, isDict(att) ? get(att, did) : null);
    if (decided.length) out.owner_decisions = decided;
    const theirs = counterpartyOwnerDecisions(d, c.participantId);
    if (theirs.length) out.counterparty_owner_decisions = theirs;    // the other side's owner's decisions (the 0.7.2 review)
    const now = typeof c.nowMs === 'function' ? c.nowMs() : this.#now();
    const retryAfter = get(d, 'retry_after_seconds');
    if (Number.isInteger(retryAfter)) out.retry_after_seconds = retryAfter;   // the server's hint while it waits on the other side (#8)
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
    } else if (st === 'delivered') {
      out.whose_turn = get(d, 'your_role') === 'payer' ? 'yours: accept the delivery or dispute it' : 'theirs: they review your delivery';
    } else if (st === 'note_failed') {
      // The IOU failed at the tracker after the delivery was accepted: the acceptance stands, so a dispute is refused.
      out.whose_turn = get(d, 'your_role') === 'payer'
        ? 'yours: the delivery stays accepted and is unpaid; pay it again (a new note, or by transfer when the window allows)'
        : 'theirs: the payer accepted your delivery and must pay it again (its note failed at the tracker)';
    } else if (OWNER_WAITS.includes(st)) {
      out.whose_turn = ownerTurn(d, c.participantId, now);
      const [by, exp] = heldNoteHour(d, now);
      if (exp) {                              // the held IOU's deadlines, which whose_turn names (the 0.7.2 review)
        out.decide_by = by;
        out.note_expires_at = exp;
      }
    } else if (st === 'paying_by_transfer') {
      out.whose_turn = get(d, 'your_role') === 'payer'
        ? 'theirs: the issuer and the payee sign the transfer that pays this deal (your Valun client signed your part)'
        : 'theirs: the transfer that pays you collects its signatures (your Valun client signs yours by itself if your owner allows it)';
    } else if (st === 'payment_due') {
      out.whose_turn = get(d, 'your_role') === 'payer'
        ? "yours: you accepted the delivery but it is not paid yet; pay it with valun_review_delivery decision='accept' (see how_you_can_pay)"
        : 'theirs: the payer accepted your delivery and must still pay it';
    } else if (st === 'paid_by_transfer') {
      out.whose_turn = 'nobody: the deal is paid by transfer';
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
      // the payee's public signature over (deliver, terms_hash, content sha256): a receipt can be verified (#3)
      out.delivery = {title: get(dl, 'title'), sha256: item(dl, 'sha256'), bytes: item(dl, 'bytes'), late: get(dl, 'late'), content: body,
        signature: get(dl, 'signature')};
      const reviewing = get(d, 'your_role') === 'payer' && ['delivered', 'note_failed'].includes(get(d, 'status'));
      out.delivery.measured_by_your_client = await measure(content, termsText(d), this.#measureOptions(reviewing && this.checkLinkHosts));
      // A built-in job only (the Nov 18 fresh-join run, finding 10: "word count" in a free-form job's terms made a
      // correct plain-text answer "not match" text-stats, with the advice to dispute it).
      const cp = isDict(get(d, 'counterparty')) ? d.counterparty : {};
      const exact = sandbox.checkBuiltIn(or(get(or(get(d, 'current'), {}), 'terms'), {}), content, get(cp, 'handle'));
      if (exact !== null) {
        out.delivery.checked_exactly_by_your_client = exact;
        if (reviewing && truthy(exact.checked) && !truthy(exact.exact_result_matches)) out.delivery.advice = exactAdvice(exact);
      }
    }
    if (truthy(get(d, 'credit_note'))) {
      const n = item(d, 'credit_note');
      const tn = or(get(n, 'tracker_note'), {});
      // confirmation: the server's live reading of the tracker when it sends one (#13), else the recorded one
      out.credit_note = {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        tracker_cumulative_total_PC: get(tn, 'amount_collected'), confirmation: or(get(n, 'confirmation'), get(tn, 'confirmation')),
        verified_by_valun: get(n, 'verified_by_valun'), outstanding: get(n, 'outstanding'), settled: get(n, 'settled', false),
        issuer_pubkey: get(n, 'issuer_pubkey'), recipient_pubkey: get(n, 'recipient_pubkey')};
      const means = confirmationMeans(out.credit_note.confirmation, c.network ?? NETWORK);
      if (means) out.credit_note.confirmation_means = means;   // what local_only, pending or confirmed means (the Nov 18 run, #12)
      for (const k of ['redeemed', 'settled_how', 'pair_now']) {    // on chain: what redemption did to this note (#13)
        const v = get(n, k);
        if (v !== null && v !== undefined) out.credit_note[k] = v;
      }
      if (truthy(get(n, 'signature_withheld'))) out.credit_note.signature = 'withheld until the Basis tracker records the note';
    }
    if ((get(d, 'payment') ?? null) !== null) out.payment = d.payment;   // circulating credit: the payment by transfer, as shown
    if (get(d, 'your_role') === 'payer' && PAYABLE.includes(st) && await this.#offersCirculation(c, d)) {
      try {
        out.how_you_can_pay = await ValunAgent.#howYouCanPay(c, did);
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
      const u = c.unit ?? UNIT;
      out.negotiation = {prices_by_version: prices.map(([n, who, p]) => `v${str(n)} ${str(who)}: ${str(p)} ${u}`)};
      const mine = prices.filter(([, who]) => who === 'you').map(([, , p]) => p).slice(-2);
      const theirs = prices.filter(([, who]) => who !== 'you').map(([, , p]) => p).slice(-2);
      if (mine.length === 2 && theirs.length === 2 && pyEq(mine[0], mine[1]) && pyEq(theirs[0], theirs[1]) && !pyEq(mine[0], theirs[0])) {
        out.negotiation.stalemate = `Both sides have repeated the same price (${str(mine[0])} vs ${str(theirs[0])} ${u}). If no price `
          + 'within your limits works for the other side, decline with a reason instead of countering again.';
      }
    }
    if (st === 'note_issued') {                        // the plain ending first, for either side (the Nov 18 run, #12)
      return {summary: noteSummary(d, c.network ?? NETWORK, c.unit ?? UNIT, await this.#offersCirculation(c, d), serverOf(c)), ...out};
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
        + 'own note; a handle passes on a note you hold). Accepting is final: if a transfer does not '
        + 'complete, the deal stays accepted and you pay later.'};
  }

  async propose(a) {
    const c = this.client();
    const unit = c.unit ?? UNIT;
    const [counterparty, role, title, description, deliverable] = required(a, PROPOSE_TEXTS);   // fix inbox #58
    const [price, deliverByHours, offerTtlHours] = ValunAgent.#offerNumbers(a, unit);   // refused before any read (fix inbox #22)
    const other = await this.#resolve(c, counterparty);
    // A seller of exactly checkable work publishes that it needs the text in the description; check before signing.
    if (role === 'payer' && str(or(get(other, 'services'), '')).includes('``` block')
        && extractText(or(description, '')) === null) {
      throw new ValunError('missing_text',
        `Not signed. ${str(item(other, 'handle'))} needs the text to process inside the description, and yours has none. Put the `
        + 'exact text in a ``` fenced block in the description (or as the only "quoted" string, or after TEXT: at the '
        + 'end), then make the offer again.');
    }
    const counterpartyId = item(other, 'id');
    const r = await c.propose({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours});
    const waiting = item(r, 'status') === 'proposed_awaiting_owner';
    const idle = recentlyActive(get(other, 'agent_last_seen'), 24, get(other, 'joined_at'), this.#now()) ? null
      : `${str(item(other, 'handle'))}'s agent has not been seen in the last 24 hours; it may never answer. Consider an active seller too.`;
    const handle = str(item(other, 'handle')), shownPrice = amountText(price, unit);   // the amount signed, never the argument as given
    const [where, wait] = waiting ? ownerWait(c, r, item(r, 'id'), this.consoleCommand) : ['', {}];
    // Held for the owner (approve_above), as the Python agent says it.
    const heldText = `Your signed offer waits for your owner before ${handle} can see it. Your owner approves or rejects `
      + `it${where}${until(get(termsOf(r), 'offer_expires_at'))}. Tell your owner now: nothing else tells them. `
      + 'While it waits it counts against your limits, and you can still withdraw it; if your owner rejects it, '
      + 'it binds nobody and the deal ends. valun_deal shows when it is decided.';
    return {deal_id: item(r, 'id'), status: item(r, 'status'),
      terms_hash: truthy(get(r, 'current')) ? item(item(r, 'current'), 'terms_hash') : null,
      what_happened: waiting ? heldText
        : `${handle} can now accept, decline or counter your signed offer.`,
      if_agreed: role === 'payer'
        ? `After you accept their delivery you issue them a note of ${shownPrice} (you will owe them; not settled).`
        : `After they accept your delivery they issue you a note of ${shownPrice} (they will owe you; not settled).`,
      ...(idle ? {warning: idle} : {}), ...wait};
  }

  async respond(a) {
    const c = this.client();
    const [did, act] = required(a, ['deal_id', 'action']);   // fix inbox #58: a missing one was a KeyError (internal_error)
    let r, at = '';                                     // at: a counter-offer's price, as signed
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
      const unit = c.unit ?? UNIT;
      const [price, hours, ttl] = ValunAgent.#counterNumbers(a, unit);   // refused before any read (fix inbox #22)
      r = await c.counter(did, {price, title: get(a, 'title'), description: get(a, 'description'),
        deliverable: get(a, 'deliverable'), deliverByHours: hours, offerTtlHours: ttl, expectedTermsHash: get(a, 'expected_terms_hash')});
      at = price !== null ? ` at ${amountText(price, unit)}` : ' at the price of their offer';
    } else {
      throw new ValunError('bad_action', 'action must be accept, decline, counter or withdraw');
    }
    const held = act === 'counter' && truthy(get(r, 'pending_counter'));
    const status = item(r, 'status');
    let accepted = '', where = '', wait = {};
    if (status === 'accepted_awaiting_owner') [accepted, wait] = acceptanceWait(c, r, did, this.consoleCommand);   // whose owner holds it
    if (held && status === 'open') [where, wait] = ownerWait(c, r, did, this.consoleCommand);
    const cp = handleOf(r), open = until(get(termsOf(r), 'offer_expires_at'), 'until');
    const explain = {agreed: 'Agreement formed: both sides have signed the same terms.',
      accepted_awaiting_owner: accepted,
      open: held ? `Your signed counter-offer${at} waits for your owner. ${cp} cannot see it yet, and its own offer `
        + `stays open${open}. While it waits, you can neither accept that `
        + `offer nor counter again. Your owner approves or rejects it${where}. Tell your owner.`
        : act === 'counter' ? `Your counter-offer${at} is open for the other side.` : 'The offer is open.',
      declined: 'You declined; nothing is owed.', withdrawn: 'Your offer is withdrawn.'};
    return {deal_id: did, status, what_happened: typeof status === 'string' && Object.hasOwn(explain, status) ? explain[status] : status,
      next_actions: get(r, 'next_actions'), ...wait};
  }

  async deliver(a) {
    const c = this.client();
    const [did] = required(a, ['deal_id']);            // fix inbox #58
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
    const d = await c.deal(did);
    const m = await measure(item(a, 'content'), termsText(d), this.#measureOptions(this.checkLinkHosts));
    const problems = m.checks_against_agreed_terms.filter(x => !x.met).map(x => `${x.requirement}: measured ${x.measured}`);
    if (truthy(m.warning ?? null)) problems.push(m.warning);
    if (problems.length && !truthy(get(a, 'send_anyway'))) {
      throw new ValunError('draft_does_not_meet_terms', 'Not sent. Your draft does not meet the agreed terms as measured: '
        + problems.join(' | ') + ' Fix it and deliver again (send_anyway=true only if you are sure; '
        + 'the payer sees the same measurements).', undefined, {measured: m});
    }
    const r = await c.deliver(did, item(a, 'content'), {title: or(get(a, 'title'), '')});
    return {deal_id: item(r, 'id'), status: item(r, 'status'), sha256: item(item(r, 'delivery'), 'sha256'),
      what_happened: 'Delivered and signed. The payer will accept it (issuing you a note) or dispute it.'};
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
    const [did] = required(a, ['deal_id']);            // fix inbox #58
    if (item(a, 'decision') === 'dispute') {
      if (!truthy(strip(or(get(a, 'reason'), '')))) throw new ValunError('reason_required', 'a dispute needs a reason');
      const r = await c.dispute(did, item(a, 'reason'));
      return {deal_id: item(r, 'id'), status: item(r, 'status'), what_happened: 'Disputed. No note was issued; the dispute is recorded.'};
    }
    const issuer = ValunAgent.#payWith(a);
    if (issuer !== null) return this.#reviewPayWith(c, a, issuer);
    const r = await c.complete(did, {expectedDeliverableSha256: get(a, 'expected_deliverable_sha256'),
      expectedTermsHash: get(a, 'expected_terms_hash')});
    const n = or(get(r, 'credit_note'), {});
    const status = item(r, 'status');
    let msg, wait = {};
    if (status === 'completion_awaiting_owner') {
      // The IOU is held for the owner (review_deliveries): until when the owner can decide (the owner console's
      // deadline, a minute before the tracker's), what the payee already sees, and what approving or rejecting it
      // leaves (as the Python agent says it).
      let where;
      [where, wait] = ownerWait(c, r, item(r, 'id'), this.consoleCommand);
      const payee = handleOf(r, 'the payee'), unit = c.unit ?? UNIT;
      const price = whole(get(n, 'amount')) ? amountText(n.amount, unit) : 'the price';
      const exp = noteExpiresAt(get(n, 'note')), by = noteDecideBy(get(n, 'note'));
      if (exp) {
        wait.decide_by = by;
        wait.note_expires_at = exp;
      }
      msg = `You accepted the delivery and signed your note to ${payee} for ${price}. The Valun server holds it for `
        + `your owner: it is not on the tracker yet, and ${payee} sees that you accepted the delivery but not the `
        + `note's signature. Tell your owner to approve or reject it${where}`
        + (exp ? ` by ${deadlineWords(by, exp)}: a note still held at ${exp} is never recorded and pays nothing, and `
          + 'valun_deal then says what to do' : '')
        + `. If approved, you owe ${payee} ${price} more: a promise to pay that `
        + `${trackerWords(c.network ?? NETWORK)} records, not a settlement. If rejected, it is never `
        + 'sent (the server keeps it, still signed) and the deal comes back to you: valun_deal says what you may '
        + 'do (accept the delivery again with a new note, which waits for your owner again, or dispute it).';
    } else if (status === 'note_issued') {
      msg = `Note issued: the Basis tracker now records that you owe ${str(item(item(r, 'counterparty'), 'handle'))} `
        + `${str(get(or(get(n, 'tracker_note'), {}), 'amount_collected'))} ${c.unit ?? UNIT} in total (this deal added ${str(get(n, 'amount'))}). `
        + labels(this.#circulating(c), c.network ?? NETWORK).settlement;
    } else {
      msg = status;
    }
    const conf = get(or(get(n, 'tracker_note'), {}), 'confirmation');
    const out = {deal_id: item(r, 'id'), status, what_happened: msg,
      credit_note: {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        confirmation: conf, settled: false}, ...wait};
    if (status !== 'note_issued') return out;
    // The plain ending first, then the long fields (the Nov 18 fresh-join run, finding 12).
    const means = confirmationMeans(conf, c.network ?? NETWORK);
    if (means) out.credit_note.confirmation_means = means;
    return {summary: noteSummary(r, c.network ?? NETWORK, c.unit ?? UNIT, this.#circulating(c), serverOf(c), 'payer'), ...out};
  }

  /**
   * valun_review_delivery accept with pay_with: Client.payByTransfer under the pins prepare() took (the delivery, the
   * quote and my claim on the issuer).
   */
  async #reviewPayWith(c, a, issuer) {
    const claim = get(a, 'expected_claim_total');
    if (claim !== null && !(whole(claim) && claim >= 0)) {
      throw new ValunError('bad_arguments', `expected_claim_total is the whole number of ${c.unit ?? UNIT} of your claim that your `
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
    const did = isDict(r) ? get(r, 'id') : item(a, 'deal_id');
    const [where, wait] = st === 'completion_awaiting_owner' ? ownerWait(c, r, did, this.consoleCommand) : ['', {}];
    // A payment by transfer held for the owner (review_deliveries), as the Python agent says it.
    const hold = typeof get(pay, 'expires_at') === 'string' && pay.expires_at ? pay.expires_at : null;
    if (hold && st === 'completion_awaiting_owner') wait.hold_expires_at = hold;
    const priced = whole(price) ? amountText(price, c.unit ?? UNIT) : 'the price';
    const heldText = `You accepted the delivery and signed a payment by transfer: ${priced} of ${shown(by)}'s note to you moves `
      + `to ${str(who)}. Nobody else has signed it. It waits for your owner${where}`
      + (hold ? ` until ${shown(hold)}, 20 minutes after you signed it` : '')
      + `: tell your owner now. Once approved, ${shown(by)} and ${str(who)} sign it (their Valun clients do so by `
      + 'themselves where their owners allow it), and the delivery stays accepted even if the transfer then '
      + 'fails. If your owner rejects it, or that time passes, nothing moves and the deal comes back to you: you '
      + `may pay again through ${shown(by)}'s note at once while it is unchanged, or any other way about an hour `
      + 'after you signed.';
    const msgs = {
      paid_by_transfer: `Paid by transfer: ${str(by)} now owes ${str(who)} ${amount} ${c.unit ?? UNIT} more and you ${amount} ${c.unit ?? UNIT} `
        + 'less; you issued no note for this deal. ' + labels(true, c.network ?? NETWORK).settlement,
      paying_by_transfer: 'You accepted the delivery and signed the transfer; it applies once the issuer and '
        + 'the payee sign. Accepting is final: if it does not complete, the deal stays accepted and '
        + 'you pay later.',
      completion_awaiting_owner: heldText,
      payment_due: 'The transfer did not apply: the delivery stays accepted and the deal is payment_due. Pay it '
        + 'again (valun_deal how_you_can_pay).'};
    return {deal_id: did, status: st,
      what_happened: typeof st === 'string' && Object.hasOwn(msgs, st) ? msgs[st] : st, payment: truthy(pay) ? pay : null, ...wait};
  }
}
