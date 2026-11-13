// Guarantees (fix inbox #18; docs/BACKING-DESIGN.md, "Built: the guarantee"): a backer's signed promise to pay, up to a
// cap, what one issuer still owes one creditor on the tracker, if the creditor calls after the due time and before the
// expiry. Circulation modes sandbox and on, between participants circulating credit is on for (Pilot.circulationFor).
//
// The terms (protocol valun-guarantee/1) are signed by the backer (statement guarantee-offer) and accepted by the
// creditor (guarantee-accept). The issuer is named and sees the guarantee, but does not sign: a guarantee changes
// nothing the issuer owes.
//   {protocol, network, tracker_nft_id, denomination, guarantee_id, nonce, backer {id, pubkey}, issuer {id, pubkey},
//    creditor {id, pubkey}, cap {amount, unit}, covers 'issuer_debt_to_creditor', due_at, expires_at,
//    honor_within_hours, offer_expires_at, note}
// What it covers: what the issuer owes the creditor on the tracker when the creditor calls (every key either has had;
// outstanding = recorded minus redeemed), up to the cap in all. A call claims at most what is still owed less what
// earlier calls claimed, so a creditor that was repaid has nothing to call, and repayment after a call makes the call
// lapse (it would pay more than is owed); the creditor may then call again for what is left.
// The remedy is the backer's own IOU: a call (the creditor's signed claim of an amount) is honored by the backer's credit
// note to the creditor for exactly that amount, signed by the backer's key and recorded by the tracker like any note,
// within honor_within_hours. Past that it is overdue, and the record shows it. The issuer's IOU to the creditor stays as
// it is (Basis changes no note without its issuer's signature): what the creditor later recovers from the issuer beyond
// the part the backer did not pay belongs to the backer (recovered_for_backer: shown, not enforced by the tracker).
// On the testnet the backer's note is redeemable against the backer's own tERG reserve, like any of its notes.
//
// What a guarantee is not: a score, or a credit limit Valun grants. The backer's own limits apply to it (its open cap
// counts against max_issue_outstanding), and the creditor's (it counts as a claim the creditor may come to hold on the
// backer); a creditor's min_payer_coverage_pct counts the open cap of the guarantees backing a payer to it.
//
// State: s.guarantees[vg_...] = {id, terms, terms_hash, backer, issuer, creditor (participant ids), state, offer,
// acceptance, decline, withdrawal, release, calls [...], history, created_at, updated_at}. States:
//   awaiting_owner  the backer's owner approves the offer first (cap above approve_above); only the backer sees it
//   offered         the creditor may accept or decline it; the backer may withdraw it
//   active          accepted; callable from due_at until expires_at
//   expired         past expires_at: no new call (an open call stays to be honored)
//   released        the creditor ended it (open calls void with it)
//   declined, withdrawn, rejected_by_owner, offer_expired   ended before it was accepted
// A call: {id vgc_..., amount, signature, called_at, honor_by, state, owed_at_call, claimed_before, keys?, note?,
// tracker_note?, honored_at?, late?, error?, journal_seq?}, state open | issuing | failed | honored | lapsed | released.
import crypto from 'node:crypto';
import {PilotError, sha256, canonical, termsHash, residueTimestamp, signedText, cleanText} from './core.mjs';
import {ordinaryTimestamp} from '../basis.mjs';
import {BOUND_NOTE_MS, PRIOR_ACK} from './caps.mjs';
import {MAX_AGE_MS} from './novation.mjs';
import {appendEntries, edgeKey, edgeEntries} from './journal.mjs';
import {NETWORK, ON_TESTNET, amt} from './units.mjs';
import {statusClass} from './status.mjs';

export const GUARANTEE_PROTOCOL = 'valun-guarantee/1';
export const COVERS = 'issuer_debt_to_creditor';
// The deal mode (fix inbox #29): the guarantee names the deals it backs (terms.deals, 1 to MAX_DEALS deal ids between the
// issuer as payer and the creditor as payee) and covers only what is unpaid of them.
export const COVERS_DEALS = 'issuer_payment_for_deals';
export const COVERS_MODES = Object.freeze([COVERS, COVERS_DEALS]);
const MAX_DEALS = 10, DEAL_RE = /^vd_[0-9a-f]{16}$/;
const DEAD_DEAL = new Set(['declined', 'expired', 'withdrawn', 'cancelled', 'disputed', 'expired_undelivered', 'rejected_by_owner']);
export const GUARANTEE_FIELDS = Object.freeze(['protocol', 'network', 'tracker_nft_id', 'denomination', 'guarantee_id', 'nonce', 'backer', 'issuer', 'creditor',
  'cap', 'covers', 'due_at', 'expires_at', 'honor_within_hours', 'offer_expires_at', 'note']);
// Bounds: due_at at most 60 days ahead (or up to an hour past: callable as soon as it is accepted); between due_at and
// expires_at at least an hour and at most 60 days; an offer open at most 7 days; honored within 1 to 168 hours.
export const GUARANTEE_LIMITS = Object.freeze({max_due_days: 60, due_past_minutes: 60, min_call_window_hours: 1, max_call_window_days: 60, max_offer_days: 7,
  honor_within_hours: Object.freeze([1, 168]), note_max_chars: 500, max_open_offers_per_backer: 10});
const DAY = 864e5, HOUR = 3600e3;
const GID_RE = /^vg_[0-9a-f]{16}$/, CID_RE = /^vgc_[0-9a-f]{16}$/, PID_RE = /^vp_[0-9a-f]{12}$/;
// A guarantee's times: ISO 8601 in UTC, as the clients write them (review F10: Date.parse alone also takes free text and
// times without an offset, read in the server's local time).
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// What ended an offer that was never accepted (ENDED_UNACCEPTED): also void_key_revoked (review F11).
// Calls that claim part of the cap (a lapsed or released call claims nothing).
const CLAIMING = new Set(['open', 'issuing', 'failed', 'honored']);
const UNHONORED = new Set(['open', 'failed']);
const OPEN_OFFER = new Set(['awaiting_owner', 'offered']);
const ENDED_UNACCEPTED = new Set(['declined', 'withdrawn', 'rejected_by_owner', 'offer_expired', 'void_key_revoked']);
const NOTE_CLOCK_WAIT_MS = 3000;

// The statements each party signs (GET /info guarantee_statements). The call and the honor name the amount, so a
// signature covers exactly that amount of exactly that call.
export const guaranteeStatements = {
  offer: h => `valun-pilot/guarantee-offer/1\n${h}`,
  accept: h => `valun-pilot/guarantee-accept/1\n${h}`,
  decline: (h, reason) => `valun-pilot/guarantee-decline/1\n${h}\n${sha256(reason)}`,
  withdraw: h => `valun-pilot/guarantee-withdraw/1\n${h}`,
  release: h => `valun-pilot/guarantee-release/1\n${h}`,
  call: (h, callId, amount) => `valun-pilot/guarantee-call/1\n${h}\n${callId}\n${amount}`,
  honor: (h, callId, amount) => `valun-pilot/guarantee-honor/1\n${h}\n${callId}\n${amount}`,
};

export const COVERS_TEXT = 'What the issuer owes the creditor on the tracker when the creditor calls (recorded minus redeemed, on every key either has had), up to the cap in all, between due_at and expires_at. A call claims at most what is still owed less what earlier calls claimed. This includes debt created after the guarantee was accepted: the cap, not today\'s debt, is the backer\'s exposure.';
export const COVERS_DEALS_TEXT = 'What the issuer still owes the creditor for the deals the terms name, up to the cap in all, between due_at and expires_at: each deal\'s price once its credit note is issued, less what the issuer repaid since (repayments retire the oldest debt first), so debt created after a deal\'s note never counts toward it. A call claims at most that less what earlier calls claimed.';
const WHAT_IT_MEANS = `A guarantee is the backer's signed promise to pay the creditor, up to the cap, what the issuer still owes the creditor after due_at, if the creditor calls before expires_at. The backer pays a call with its own credit note to the creditor for that amount, within honor_within_hours: an IOU like any other${ON_TESTNET ? ', redeemable on Ergo testnet against the backer\'s tERG reserve if it posted one' : ''}. The issuer's IOU to the creditor stays as it is; what the creditor later recovers from the issuer beyond the part the backer did not pay belongs to the backer (recovered_for_backer). It is not a score and grants no credit limit.`;

// GET /info guarantees: the protocol, what it covers, the bounds and the statements' meaning.
export const GUARANTEE_INFO = Object.freeze({protocol: GUARANTEE_PROTOCOL, covers: COVERS, covers_means: COVERS_TEXT, limits: GUARANTEE_LIMITS, means: WHAT_IT_MEANS});

const iso = t => new Date(t).toISOString();
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const sum = xs => xs.reduce((a, c) => a + c.amount, 0);

export class GuaranteeBook {
  constructor(pilot) { this.pilot = pilot; }
  get P() { return this.pilot; }
  all() { return this.P.s.guarantees || {}; }
  list() { return Object.values(this.all()); }
  now() { return this.P.now(); }

  // ---------- reading ----------
  // Whether guarantees exist for p on this server (circulating credit on for p).
  available(p) { return this.P.circulating && !!p && this.P.circulationFor(p); }
  assertAvailable(p) {
    if (!this.available(p)) throw new PilotError('feature_unavailable', 'guarantees are not available on this server for this participant (they need circulating credit: GET /info features guarantees/1)', 409);
  }
  // The creditor and the issuer see a guarantee once it was offered; the backer always.
  visibleTo(g, p) { return g.backer === p.id || ((g.creditor === p.id || g.issuer === p.id) && !!g.offer?.offered_at); }
  guarantee(id) {
    const g = typeof id === 'string' && GID_RE.test(id) && Object.hasOwn(this.all(), id) ? this.all()[id] : null;
    if (!g) throw new PilotError('not_found', `unknown guarantee ${id}`, 404);
    return g;
  }
  party(id, p) { const g = this.guarantee(id); if (!this.visibleTo(g, p)) throw new PilotError('not_found', `unknown guarantee ${id}`, 404); return this.sweep(g); }
  callOf(g, callId) {
    const c = g.calls.find(x => x.id === callId);
    if (!c) throw new PilotError('not_found', `unknown call ${callId} of guarantee ${g.id}`, 404);
    return c;
  }
  claimed(g) { return sum(g.calls.filter(c => CLAIMING.has(c.state))); }
  honoredAmount(g) { return sum(g.calls.filter(c => c.state === 'honored')); }
  openCall(g) { return g.calls.find(c => c.state === 'open' || c.state === 'issuing' || c.state === 'failed') ?? null; }
  // One debt, every guarantee of it (fix inbox #19). Every guarantee naming the same issuer and creditor covers the same
  // debt, so a call on any of them claims part of that one debt: what is callable or honorable on one counts the calls on
  // all of them, ever (a creditor repaid after backers paid holds what they paid as cover for the issuer's next debt).
  // Without this, N guarantees of one debt each paid it in full (the creditor collected N + 1 times).
  ofDebt(g) { return this.list().filter(x => x.issuer === g.issuer && x.creditor === g.creditor); }
  debtClaimed(g) { return this.ofDebt(g).reduce((a, x) => a + this.claimed(x), 0); }
  debtHonored(g) { return this.ofDebt(g).reduce((a, x) => a + this.honoredAmount(x), 0); }
  // What the creditor recovered from the issuer beyond the part the backers did not pay (honored on the debt less what the
  // issuer still owes), shared among the backers in proportion to what each paid (largest remainder, earliest first).
  // Shown, not enforced: the tracker moves no note without its issuer's signature.
  recoveredShares(g, owed) {
    const gs = this.ofDebt(g).filter(x => this.honoredAmount(x) > 0).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const H = gs.reduce((a, x) => a + this.honoredAmount(x), 0), R = Math.max(0, H - owed), out = new Map();
    if (!R) return {total: 0, honored: H, of: () => 0};
    let left = R;
    const parts = gs.map(x => { const n = BigInt(R) * BigInt(this.honoredAmount(x)), q = Number(n / BigInt(H)); left -= q; return {id: x.id, q, r: n % BigInt(H)}; });
    for (const p of [...parts].sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : 0))) { if (left <= 0) break; p.q += 1; left -= 1; }
    for (const p of parts) out.set(p.id, p.q);
    return {total: R, honored: H, of: id => out.get(id) ?? 0};
  }
  // What the issuer owes the creditor on the tracker (every key either has registered).
  owedOnTracker(g, ledger) {
    const iq = this.P.s.participants[g.issuer], cq = this.P.s.participants[g.creditor];
    if (!iq || !cq) return 0;
    const ik = this.P.keysOf(iq), ck = this.P.keysOf(cq);
    return ledger.filter(l => ik.has(l.issuer_pubkey) && ck.has(l.recipient_pubkey)).reduce((a, l) => a + l.outstanding, 0);
  }
  // What the issuer owes the creditor because it paid the creditor as a backer: its honor notes on other guarantees to
  // that creditor (fix inbox #19, chains: Basis E8, T19-7).
  honorDebt(g) {
    return this.list().filter(x => x.backer === g.issuer && x.creditor === g.creditor).reduce((a, x) => a + this.honoredAmount(x), 0);
  }
  // The deal mode (fix inbox #29): what is still unpaid of the named deals, first in, first out. A deal counts once its
  // credit note is recorded: its price P, noted at timestamp t. Repayments (set-offs, transfers out, redemptions) retire
  // the oldest debt first, so what is outstanding now is the newest debt; of it, the debt added after t (notes and
  // transfers in on the pair, on every key) came after the deal. So unpaid = min(P, max(0, owed now - added after t)).
  // A made-up deal after the named one adds debt after t and can never raise what the named one covers.
  dealsUnpaid(g, ledger) {
    if (g.terms.covers !== COVERS_DEALS) return null;
    const owed = this.owedOnTracker(g, ledger), iq = this.P.s.participants[g.issuer], cq = this.P.s.participants[g.creditor];
    if (!iq || !cq) return 0;
    const edges = [];
    for (const i of this.P.keysOf(iq)) for (const r of this.P.keysOf(cq)) edges.push(edgeKey(i, r));
    const entries = edges.flatMap(k => edgeEntries(this.P, k));
    let total = 0;
    for (const id of g.terms.deals) {
      const d = this.P.s.deals[id], n = d?.credit_note;
      if (!d || d.status !== 'note_issued' || n?.state !== 'recorded' || !Number.isSafeInteger(n.note?.timestamp)) continue;
      const after = entries.filter(e => e.timestamp > n.note.timestamp && e.delta > 0).reduce((a, e) => a + e.delta, 0);
      total += Math.min(n.amount, Math.max(0, owed - after));
    }
    return total;
  }
  // The debt a guarantee covers: what the issuer owes the creditor on the tracker, less what it owes it as a backer.
  // A guarantee of a backer's debts therefore never pays the creditor again for a default another guarantee already
  // paid: in a chain (g2 backs the note b1 honored g1 with, g3 the note b2 honored g2 with...) only the first layer pays,
  // and all of them together recover at most the root debt. Conservative: honor notes that were set off or redeemed
  // since are still subtracted, so such a guarantee may cover less of the backer's other debt to the creditor.
  owed(g, ledger) { return Math.max(0, this.owedOnTracker(g, ledger) - this.honorDebt(g)); }
  due(g) { return this.now() >= Date.parse(g.terms.due_at); }
  // What the creditor can call now: nothing unless the guarantee is active, due, before its expiry and with no call
  // open; otherwise the cap left and the debt not yet claimed by the calls on every guarantee of it, whichever is smaller.
  // The deal mode also: no more than what is unpaid of its deals (`unpaid`, dealsUnpaid) less its own calls.
  callable(g, owed, unpaid = null) {
    if (g.state !== 'active' || !this.due(g) || this.now() >= Date.parse(g.terms.expires_at) || this.openCall(g) || owed === null) return 0;
    const deals = g.terms.covers === COVERS_DEALS ? (unpaid ?? 0) - this.claimed(g) : Infinity;
    return Math.max(0, Math.min(g.terms.cap.amount - this.claimed(g), owed - this.debtClaimed(g), deals));
  }
  // An unhonored call can still be honored while the issuer owes at least everything claimed on the debt so far (this
  // call and the calls on the debt's other guarantees included); otherwise paying it would pay more than the issuer owes.
  honorable(g, c, owed, unpaid = null) {
    return UNHONORED.has(c.state) && owed >= this.debtClaimed(g) && (g.terms.covers !== COVERS_DEALS || unpaid === null || unpaid >= this.claimed(g));
  }

  // Lazy expiry (as deals are swept): an offer past offer_expires_at, an active guarantee past expires_at. Saves when
  // something changed.
  sweep(g) {
    const now = this.now();
    let changed = false;
    if (OPEN_OFFER.has(g.state) && Date.parse(g.terms.offer_expires_at) <= now) {
      const was = g.state;
      g.state = 'offer_expired'; this.voidApproval(g, 'void_expired');
      this.event(g, 'valun', 'offer_expired', {}, was === 'awaiting_owner' ? g.backer : null);
      changed = true;
    }
    if (g.state === 'active' && Date.parse(g.terms.expires_at) <= now) {
      g.state = 'expired'; this.event(g, 'valun', 'expired', {open_call: this.openCall(g)?.id ?? null});
      changed = true;
    }
    if (changed) { this.P.save(); this.P.store.audit({type: `guarantee.${g.state}`, guarantee: g.id}); }
    return g;
  }
  event(g, by, event, detail = {}, only = null) {
    g.history.push({at: iso(this.now()), by, event, ...detail, ...(only ? {only} : {})}); g.updated_at = iso(this.now());
  }
  voidApproval(g, state) {
    for (const a of Object.values(this.P.s.approvals)) if (a.guarantee_id === g.id && a.state === 'pending') a.state = state;
  }

  // ---------- the terms ----------
  validateTerms(t, backer) {
    const P = this.P, bad = m => { throw new PilotError('invalid_terms', m); };
    if (!t || typeof t !== 'object' || Array.isArray(t)) bad('terms must be an object');
    for (const k of Object.keys(t)) if (!GUARANTEE_FIELDS.includes(k) && k !== 'deals') bad(`unknown terms field ${k}`);
    for (const k of GUARANTEE_FIELDS) if (!(k in t)) bad(`terms field ${k} is missing`);
    if (t.protocol !== GUARANTEE_PROTOCOL) bad(`protocol must be ${GUARANTEE_PROTOCOL}`);
    if (t.network !== NETWORK) bad(`network must be ${NETWORK}`);
    if (t.tracker_nft_id !== P.basis.nft) bad('tracker_nft_id does not match this server\'s tracker');
    if (t.denomination !== P.basis.denomination) bad(`denomination must be ${P.basis.denomination}`);
    if (typeof t.guarantee_id !== 'string' || !GID_RE.test(t.guarantee_id)) bad('guarantee_id must be vg_ + 16 hex');
    if (typeof t.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(t.nonce)) bad('nonce must be 32 hex');
    for (const r of ['backer', 'issuer', 'creditor']) {
      const x = t[r];
      if (!x || typeof x !== 'object' || Object.keys(x).sort().join() !== 'id,pubkey') bad(`${r} must be {id, pubkey}`);
      const q = typeof x.id === 'string' && PID_RE.test(x.id) && Object.hasOwn(P.s.participants, x.id) ? P.s.participants[x.id] : null;
      if (!q || q.status !== 'active' || !q.pubkey || q.pubkey !== x.pubkey) bad(`${r} must be an active participant with its registered key`);
    }
    if (t.backer.id !== backer.id) bad('backer must be the caller');
    if (new Set([t.backer.id, t.issuer.id, t.creditor.id]).size !== 3) bad('the backer, the issuer and the creditor must be three different participants');
    if (!t.cap || typeof t.cap !== 'object' || Object.keys(t.cap).sort().join() !== 'amount,unit' || t.cap.unit !== P.unit || !isInt(t.cap.amount, 1, Number.MAX_SAFE_INTEGER))
      bad(`cap must be {amount: a whole number of at least 1, unit: "${P.unit}"}`);
    if (!COVERS_MODES.includes(t.covers)) bad(`covers must be "${COVERS}" (what the issuer owes the creditor on the tracker, up to the cap) or "${COVERS_DEALS}" (only the deals in deals)`);
    if (t.covers === COVERS_DEALS) {
      if (!Array.isArray(t.deals) || t.deals.length < 1 || t.deals.length > MAX_DEALS || new Set(t.deals).size !== t.deals.length || !t.deals.every(id => typeof id === 'string' && DEAL_RE.test(id)))
        bad(`deals must be 1 to ${MAX_DEALS} different deal ids (vd_ + 16 hex)`);
      for (const id of t.deals) {
        const d = Object.hasOwn(P.s.deals, id) ? P.s.deals[id] : null;
        if (!d || d.payer !== t.issuer.id || d.payee !== t.creditor.id || DEAD_DEAL.has(d.status))
          bad(`each deal must be a deal, not ended, in which the issuer pays the creditor (${id} is not)`);
      }
    } else if (t.deals !== undefined) bad(`deals is only for covers "${COVERS_DEALS}"`);
    if (!isInt(t.honor_within_hours, ...GUARANTEE_LIMITS.honor_within_hours)) bad(`honor_within_hours must be a whole number from ${GUARANTEE_LIMITS.honor_within_hours[0]} to ${GUARANTEE_LIMITS.honor_within_hours[1]}`);
    if (typeof t.note !== 'string') bad('note must be text (it may be empty)');
    if (t.note !== '') signedText(t.note, GUARANTEE_LIMITS.note_max_chars, 'note');
    const now = this.now(), due = Date.parse(t.due_at), exp = Date.parse(t.expires_at), offer = Date.parse(t.offer_expires_at);
    for (const k of ['due_at', 'expires_at', 'offer_expires_at']) if (typeof t[k] !== 'string' || !ISO_UTC_RE.test(t[k]) || !Number.isFinite(Date.parse(t[k]))) bad(`${k} must be an ISO 8601 time in UTC, like 2026-11-13T18:00:00.000Z`);
    if (!(due >= now - GUARANTEE_LIMITS.due_past_minutes * 60e3 && due <= now + GUARANTEE_LIMITS.max_due_days * DAY)) bad(`due_at must be at most ${GUARANTEE_LIMITS.max_due_days} days ahead (or up to ${GUARANTEE_LIMITS.due_past_minutes} minutes past: callable as soon as it is accepted)`);
    if (!(exp >= due + GUARANTEE_LIMITS.min_call_window_hours * HOUR && exp <= due + GUARANTEE_LIMITS.max_call_window_days * DAY)) bad(`expires_at must be at least ${GUARANTEE_LIMITS.min_call_window_hours} hour and at most ${GUARANTEE_LIMITS.max_call_window_days} days after due_at`);
    if (!(offer > now && offer <= now + GUARANTEE_LIMITS.max_offer_days * DAY)) bad(`offer_expires_at must be in the future, at most ${GUARANTEE_LIMITS.max_offer_days} days ahead`);
    if (!(offer <= exp)) bad('offer_expires_at must not be after expires_at');
    return t;
  }
  // The three parties, as the terms name them, must still be active with exactly those keys (an acceptance, an owner's
  // approval).
  partiesCurrent(g) {
    for (const r of ['backer', 'issuer', 'creditor']) {
      const q = this.P.s.participants[g.terms[r].id];
      if (!q || q.status !== 'active' || q.pubkey !== g.terms[r].pubkey)
        throw new PilotError('key_changed', `${q?.handle ?? g.terms[r].id}'s registered agent key is no longer the one these terms name; this guarantee can no longer be agreed. The backer can offer a new one.`, 409, {party: g.terms[r].id});
    }
  }

  // ---------- the mandates ----------
  // The backer's owner's mandate, as for a deal the backer pays (Pilot.checkMandate as payer, toward the creditor):
  // may_issue_credit, the cap within max_issue_per_deal, everything it owes and has committed (the open caps of its other
  // guarantees included) plus this cap within max_issue_outstanding, its counterparty list and the self-serve box, which
  // must allow the issuer too. Returns the check, with needsOwner when the cap is above approve_above.
  async backerCheck(B, t, {excludeGuaranteeId = null} = {}) {
    return this.P.checkMandate(B, 'payer', t.creditor.id, t.cap.amount, {excludeGuaranteeId, also: [t.issuer.id]});
  }
  async backerStillAuthorized(g) {
    const B = this.P.s.participants[g.backer];
    try { await this.backerCheck(B, g.terms, {excludeGuaranteeId: g.id}); }
    catch (e) {
      if (e.code !== 'mandate_exceeded') throw e;
      this.P.store.audit({type: 'guarantee.accept_refused_backer_mandate', guarantee: g.id, rule: e.extra.rule});
      throw new PilotError('offer_not_authorized', `this guarantee is no longer within ${B.handle}'s mandate (its owner changed the limits, or other commitments used them up); it cannot be accepted now. Decline it, or ask for a new one.`, 409);
    }
  }

  // ---------- the backer: offer, withdraw ----------
  offer(p, {terms, terms_hash: claimed, signature} = {}) {
    return this.P.serial(async () => {
      const P = this.P;
      this.assertAvailable(p);
      const t = this.validateTerms(terms, p), h = termsHash(t);
      if (claimed && claimed !== h) throw new PilotError('hash_mismatch', `the server computes terms_hash ${h}; the client sent ${claimed} (canonical JSON differs)`, 400, {canonical: canonical(t)});
      // The signature is checked before the id is looked up, so an unsigned probe cannot learn which ids exist.
      await P.verifySig(p, guaranteeStatements.offer(h), signature, 'guarantee offer');
      if (Object.hasOwn(this.all(), t.guarantee_id)) throw new PilotError('duplicate', 'that guarantee id already exists', 409);
      for (const id of [t.issuer.id, t.creditor.id]) {
        const x = P.s.participants[id];
        if (!this.available(x)) throw new PilotError('feature_unavailable', `${x.handle} does not have circulating credit on this server, so it cannot take part in a guarantee`, 409);
      }
      const open = this.list().map(g => this.sweep(g)).filter(g => g.backer === p.id && OPEN_OFFER.has(g.state)).length;
      if (open >= GUARANTEE_LIMITS.max_open_offers_per_backer) throw new PilotError('too_many_open_offers', `a backer has at most ${GUARANTEE_LIMITS.max_open_offers_per_backer} guarantee offers open at once; withdraw one or wait for answers`, 429);
      const chk = await this.backerCheck(p, t);
      const now = iso(this.now()), needsOwner = t.cap.amount > (p.mandate.approve_above ?? 0);
      const g = {id: t.guarantee_id, terms: t, terms_hash: h, backer: p.id, issuer: t.issuer.id, creditor: t.creditor.id, state: needsOwner ? 'awaiting_owner' : 'offered',
        offer: {by: p.id, signature, at: now, mandate_check: {checks: chk.checks, mandate_version: chk.mandate_version}, offered_at: needsOwner ? null : now},
        acceptance: null, calls: [], history: [], created_at: now, updated_at: now};
      if (needsOwner) {
        const a = {id: 'va_' + crypto.randomBytes(6).toString('hex'), participant: p.id, deal_id: null, guarantee_id: g.id, kind: 'guarantee_offer', version: 1, terms_hash: h,
          created_at: now, state: 'pending'};
        P.s.approvals[a.id] = a; g.offer.approval_id = a.id;
      }
      (P.s.guarantees ??= {})[g.id] = g;
      this.event(g, p.id, 'offered', {terms_hash: h, awaiting_owner: needsOwner}, needsOwner ? p.id : null);
      P.save(); P.store.audit({type: 'guarantee.offered', guarantee: g.id, by: p.id, terms_hash: h, awaiting_owner: needsOwner});
      return this.view(g, p, await P.ledger());
    });
  }
  withdraw(p, id, {terms_hash, signature} = {}) {
    return this.P.serial(async () => {
      const g = this.party(id, p);
      if (g.backer !== p.id) throw new PilotError('not_backer', 'only the backer withdraws its offer', 403);
      if (!OPEN_OFFER.has(g.state)) throw new PilotError('not_open', `guarantee is ${g.state}; only an offer not yet accepted can be withdrawn`, 409);
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      await this.P.verifySig(p, guaranteeStatements.withdraw(g.terms_hash), signature, 'withdrawal');
      const was = g.state;
      g.state = 'withdrawn'; g.withdrawal = {by: p.id, signature, at: iso(this.now())}; this.voidApproval(g, 'void_withdrawn');
      this.event(g, p.id, 'withdrawn', {}, was === 'awaiting_owner' ? p.id : null);
      this.P.save(); this.P.store.audit({type: 'guarantee.withdrawn', guarantee: g.id});
      return this.view(g, p, await this.P.ledger());
    });
  }
  // The backer's owner decides an offer held for it (Pilot.decideApproval, with the lock held).
  async decideOffer(owner, a, decision, note) {
    const P = this.P, g = this.sweep(this.guarantee(a.guarantee_id));
    if (a.state !== 'pending') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
    if (g.state !== 'awaiting_owner' || g.offer.approval_id !== a.id) throw new PilotError('not_pending', 'this approval no longer matches the guarantee', 409);
    if (decision === 'approve') {
      this.partiesCurrent(g);
      await this.backerCheck(owner, g.terms, {excludeGuaranteeId: g.id});
      this.sweep(g);
      if (a.state !== 'pending' || g.state !== 'awaiting_owner') throw new PilotError('not_pending', `approval is ${a.state}`, 409);
    }
    const at = iso(this.now());
    a.state = decision === 'approve' ? 'approved' : 'rejected'; a.decided_at = at; a.note = note;
    if (decision === 'approve') { g.state = 'offered'; g.offer.offered_at = at; g.offer.owner_approval = {approval_id: a.id, at}; }
    else g.state = 'rejected_by_owner';
    this.event(g, `owner:${owner.id}`, `owner_${a.state}`, {kind: a.kind}, decision === 'approve' ? null : owner.id);
    P.save(); P.store.audit({type: `approval.${a.state}`, id: a.id, guarantee: g.id});
    return {approval: a, guarantee: this.view(g, owner, await P.ledger())};
  }

  // ---------- the creditor: accept, decline, release, call ----------
  accept(p, id, {terms_hash, signature} = {}) {
    return this.P.serial(async () => {
      const P = this.P, g = this.party(id, p);
      if (g.creditor !== p.id) throw new PilotError('not_creditor', 'only the creditor the guarantee names accepts it', 403);
      if (g.state !== 'offered') throw new PilotError('not_open', `guarantee is ${g.state}; nothing to accept`, 409);
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      this.partiesCurrent(g);
      await P.verifySig(p, guaranteeStatements.accept(g.terms_hash), signature, 'guarantee acceptance');
      // The creditor's own policy on the backer as the issuer of the note it may come to hold (as for a deal the backer
      // pays it; no owner approval: accepting a guarantee commits the creditor to nothing).
      const chk = await P.checkMandate(p, 'payee', g.backer, g.terms.cap.amount, {guarantee: true, excludeGuaranteeId: g.id});
      await this.backerStillAuthorized(g);
      // A read outside the lock may have swept the offer to offer_expired (or a revocation voided it) meanwhile (review F3).
      this.sweep(g);
      if (g.state !== 'offered') throw new PilotError('not_open', `guarantee is ${g.state}; nothing to accept`, 409);
      // What the issuer owed the creditor when it accepted (fix inbox #29): a call above it is flagged in the floating mode.
      const owedNow = this.owed(g, await P.ledger());
      this.sweep(g);
      if (g.state !== 'offered') throw new PilotError('not_open', `guarantee is ${g.state}; nothing to accept`, 409);
      g.acceptance = {by: p.id, signature, at: iso(this.now()), mandate_check: {checks: chk.checks, mandate_version: chk.mandate_version}, owed_at_acceptance: owedNow};
      g.state = 'active';
      this.event(g, p.id, 'accepted', {terms_hash: g.terms_hash});
      P.save(); P.store.audit({type: 'guarantee.accepted', guarantee: g.id, by: p.id});
      return this.view(g, p, await P.ledger());
    });
  }
  decline(p, id, {terms_hash, signature, reason = ''} = {}) {
    return this.P.serial(async () => {
      const g = this.party(id, p);
      if (g.creditor !== p.id) throw new PilotError('not_creditor', 'only the creditor the guarantee names declines it', 403);
      if (g.state !== 'offered') throw new PilotError('not_open', `guarantee is ${g.state}; nothing to decline`, 409);
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      const r = typeof reason === 'string' ? reason : '';
      if (r) cleanText(r, 300, 'reason');
      await this.P.verifySig(p, guaranteeStatements.decline(g.terms_hash, r), signature, 'decline');
      g.state = 'declined'; g.decline = {by: p.id, signature, at: iso(this.now()), reason: cleanText(r, 300, 'reason')};
      this.event(g, p.id, 'declined', {reason_sha256: sha256(r)});
      this.P.save(); this.P.store.audit({type: 'guarantee.declined', guarantee: g.id});
      return this.view(g, p, await this.P.ledger());
    });
  }
  release(p, id, {terms_hash, signature} = {}) {
    return this.P.serial(async () => {
      const g = this.party(id, p);
      if (g.creditor !== p.id) throw new PilotError('not_creditor', 'only the creditor releases a guarantee', 403);
      if (g.state !== 'active' && g.state !== 'expired') throw new PilotError('not_active', `guarantee is ${g.state}; only an accepted guarantee can be released`, 409);
      if (g.calls.some(c => c.state === 'issuing')) throw new PilotError('honor_in_progress', 'the backer\'s note for a call is being recorded; try again in a minute', 409, {retry_after_ms: 60000});
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      // A deal this creditor agreed because this guarantee covered it (its owner's min_payer_coverage_pct) holds it until
      // the deal is paid or ended: the agent's key alone cannot undo the cover its owner required (review F6).
      const relied = this.reliedOnBy(g);
      if (relied.length) throw new PilotError('guarantee_in_use', `${relied.join(', ')} ${relied.length === 1 ? 'was' : 'were'} agreed because this guarantee covered ${relied.length === 1 ? 'it' : 'them'} (your owner's coverage rule); it can be released once ${relied.length === 1 ? 'that deal is' : 'those deals are'} paid or ended`, 409, {deals: relied});
      await this.P.verifySig(p, guaranteeStatements.release(g.terms_hash), signature, 'release');
      const voided = g.calls.filter(c => UNHONORED.has(c.state));
      for (const c of voided) c.state = 'released';
      g.state = 'released'; g.release = {by: p.id, signature, at: iso(this.now())};
      this.event(g, p.id, 'released', voided.length ? {calls_released: voided.map(c => c.id)} : {});
      this.P.save(); this.P.store.audit({type: 'guarantee.released', guarantee: g.id});
      return this.view(g, p, await this.P.ledger());
    });
  }
  call(p, id, {call_id: callId, amount, terms_hash, signature} = {}) {
    return this.P.serial(async () => {
      const P = this.P, g = this.party(id, p);
      if (g.creditor !== p.id) throw new PilotError('not_creditor', 'only the creditor calls a guarantee', 403);
      if (g.state !== 'active') throw new PilotError('not_active', `guarantee is ${g.state}; it can be called only while it is active (accepted, before expires_at ${g.terms.expires_at})`, 409);
      if (!this.due(g)) throw new PilotError('not_due', `this guarantee can be called from ${g.terms.due_at}`, 409, {callable_from: g.terms.due_at, retry_after_ms: Date.parse(g.terms.due_at) - this.now()});
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      if (typeof callId !== 'string' || !CID_RE.test(callId)) throw new PilotError('invalid_field', 'call_id must be vgc_ + 16 hex');
      if (!isInt(amount, 1, Number.MAX_SAFE_INTEGER)) throw new PilotError('invalid_field', 'amount must be a whole number of at least 1');
      await P.verifySig(p, guaranteeStatements.call(g.terms_hash, callId, amount), signature, 'call');
      if (this.list().some(x => x.calls.some(c => c.id === callId))) throw new PilotError('duplicate', 'that call id already exists', 409);
      const ledger = await P.ledger();
      const owed = this.owed(g, ledger), unpaid = this.dealsUnpaid(g, ledger);
      // A call left open that the issuer's repayment made unpayable lapses now (it claimed more than is owed).
      const open = this.openCall(g);
      if (open && open.state !== 'issuing' && !this.honorable(g, open, owed, unpaid)) this.lapse(g, open, owed);
      if (this.openCall(g)) throw new PilotError('call_open', `call ${this.openCall(g).id} is still open; it must be honored (or lapse) before another call`, 409);
      const callable = this.callable(g, owed, unpaid);
      if (amount > callable) {
        const claimed = this.claimed(g), onDebt = this.debtClaimed(g);
        const others = this.ofDebt(g).filter(x => x.id !== g.id && this.claimed(x) > 0).map(x => ({guarantee_id: x.id, claimed: this.claimed(x)}));
        const via = others.length ? ` (${others.map(o => `${amt(o.claimed)} via ${o.guarantee_id}`).join(', ')}${claimed ? `, ${amt(claimed)} via this one` : ''})` : '';
        const honorDebt = this.honorDebt(g);
        throw new PilotError('exceeds_callable', `at most ${amt(callable)} can be called now: the cap left is ${amt(g.terms.cap.amount - claimed)}${unpaid !== null ? `, what is unpaid of the deals it backs is ${amt(unpaid)}` : ''}, and the issuer owes you ${amt(owed)} that this guarantee covers${honorDebt ? ` (on the tracker ${amt(owed + honorDebt)}, of which ${amt(honorDebt)} are its own payments to you as a backer, which a guarantee of its debts does not cover)` : ''}, of which earlier calls on this debt claimed ${amt(onDebt)}${via}`, 409,
          {callable, issuer_owes_creditor: owed, claimed, claimed_on_debt: onDebt, ...(others.length ? {claimed_by_other_guarantees: others} : {}), ...(honorDebt ? {issuer_honor_debt: honorDebt} : {}),
            ...(unpaid !== null ? {deals_unpaid: unpaid} : {}), cap: g.terms.cap.amount});
      }
      const now = this.now();
      const c = {id: callId, amount, signature, called_at: iso(now), honor_by: iso(now + g.terms.honor_within_hours * HOUR), state: 'open', owed_at_call: owed, claimed_before: this.claimed(g),
        claimed_on_debt_before: this.debtClaimed(g)};
      g.calls.push(c);
      this.event(g, p.id, 'called', {call_id: callId, amount, issuer_owes_creditor: owed});
      P.save(); P.store.audit({type: 'guarantee.called', guarantee: g.id, call: callId, amount});
      return this.view(g, p, ledger);
    });
  }
  // Calls the issuer's repayment made unpayable lapse as soon as anything reads the debt (review F2, F7): a view, a mandate
  // check. Before, only the creditor's next call or the backer's own honor made them lapse, so colluders could leave them
  // "against" an issuer that owes nothing, and the backer's limits and record held them. A call being issued stays.
  lapseStale(ledger, gs = this.list()) {
    let n = 0;
    for (const g of gs) {
      if (!g.calls.some(c => UNHONORED.has(c.state))) continue;
      const owed = this.owed(g, ledger), unpaid = this.dealsUnpaid(g, ledger);
      for (const c of g.calls) if (UNHONORED.has(c.state) && !this.honorable(g, c, owed, unpaid)) { this.lapse(g, c, owed); n++; }
    }
    if (n) this.P.save();
    return n;
  }
  // The committed deals (not yet paid or ended) between this guarantee's issuer and creditor whose acceptance counted it
  // as cover (the min_payer_coverage_pct entry of the acceptance's mandate check names it).
  reliedOnBy(g) {
    return Object.values(this.P.s.deals).filter(d => d.payer === g.issuer && d.payee === g.creditor && statusClass(d.status)?.committed
      && (d.acceptance?.mandate_check?.checks ?? []).some(c => c.rule === 'min_payer_coverage_pct' && Array.isArray(c.guarantees) && c.guarantees.includes(g.id))).map(d => d.id);
  }
  // Revoking an agent (Pilot.revokeAgent, lock held): every offer not yet accepted that names its key, as backer, issuer
  // or creditor, can never be accepted (key_changed); it ends now as void_key_revoked (review F11). Returns their ids.
  voidOffersOfKey(pubkey, participantId) {
    const out = [];
    for (const g of this.list()) {
      if (!OPEN_OFFER.has(g.state) || !['backer', 'issuer', 'creditor'].some(r => g.terms[r].pubkey === pubkey)) continue;
      const was = g.state;
      g.state = 'void_key_revoked'; this.voidApproval(g, 'void_key_revoked');
      this.event(g, 'valun', 'void_key_revoked', {participant: participantId}, was === 'awaiting_owner' ? g.backer : null);
      out.push(g.id);
    }
    return out;
  }
  lapse(g, c, owed) {
    c.state = 'lapsed'; c.lapsed_at = iso(this.now()); c.issuer_owed_at_lapse = owed;
    this.event(g, 'valun', 'call_lapsed', {call_id: c.id, amount: c.amount, issuer_owes_creditor: owed});
    this.P.store.audit({type: 'guarantee.call_lapsed', guarantee: g.id, call: c.id});
  }

  // ---------- the backer: honor a call with its own credit note ----------
  // The note's keys: the backer's current key, the creditor's current key (as a deal's note is between the parties'
  // current keys).
  noteParties(g) {
    const B = this.P.s.participants[g.backer], C = this.P.s.participants[g.creditor];
    if (B.status !== 'active' || !B.pubkey) throw new PilotError('no_key', 'the backer has no registered agent key', 409);
    if (C.status !== 'active' || !C.pubkey) throw new PilotError('creditor_no_key', `${C.handle} has no registered agent key right now; the note can be issued once a new key is enrolled`, 409);
    return {issuer: B.pubkey, recipient: C.pubkey};
  }
  // A call whose note is being recorded on this edge (issuing): no other note on the pair meanwhile (Pilot.assertPairFree,
  // Pilot.pairHoldsNote).
  issuingOn(k, exceptCallId = null) {
    for (const g of this.list()) for (const c of g.calls) if (c.state === 'issuing' && c.id !== exceptCallId && c.keys && edgeKey(c.keys.issuer, c.keys.recipient) === k) return true;
    return false;
  }
  assertPairFree(c, issuer, recipient) {
    this.P.assertPairFree({id: null}, issuer, recipient);
    if (this.issuingOn(edgeKey(issuer, recipient), c.id)) throw new PilotError('pair_busy', 'another credit note for this key pair is being issued and the tracker has not confirmed it yet; try again in 60 s.', 409, {retry_after_ms: 60000});
    this.P.assertNoteEdgeFree(issuer, recipient);
  }
  // The checks a template and an honor share: the caller is the backer, the call is unhonored, and still payable.
  async honorContext(p, id, callId) {
    const g = this.party(id, p);
    if (g.backer !== p.id) throw new PilotError('not_backer', 'only the backer honors a call', 403);
    const c = this.callOf(g, callId);
    if (c.state === 'honored') throw new PilotError('already_honored', `call ${c.id} is honored already`, 409);
    if (!UNHONORED.has(c.state)) throw new PilotError('wrong_state', `call ${c.id} is ${c.state}; nothing to honor`, 409);
    const ledger = await this.P.ledger(), owed = this.owed(g, ledger), unpaid = this.dealsUnpaid(g, ledger);
    return {g, c, ledger, owed, unpaid};
  }
  // GET .../calls/{vgc}/note-template: as a deal's credit-note template (Pilot.noteTemplate), for the call's amount.
  //   bound: true  a bound note (mode bound and above): the timestamp ends in 997 ms; adds prior_note, prior_timestamp and
  //                prior_message_hex (the backer's prior acknowledgment of the pair's note, for information).
  //   prior: true  adds prior_note (the pair's tracker note, signed by the backer itself), or null.
  async noteTemplate(p, id, callId, {wait = true, prior: withPrior = false, bound = false} = {}) {
    const P = this.P, {g, c, owed, unpaid} = await this.honorContext(p, id, callId);
    if (!this.honorable(g, c, owed, unpaid)) throw new PilotError('call_lapsed', `the issuer now owes the creditor ${amt(owed)}, less than the ${amt(this.debtClaimed(g))} claimed on this debt with this call: it can no longer be honored (it lapses at the next honor or call)`, 409, {issuer_owes_creditor: owed, claimed_on_debt: this.debtClaimed(g)});
    if (bound && P.mode === 'off') throw new PilotError('feature_unavailable', 'bound credit notes are not enabled on this server; fetch the template without bound=1', 409);
    const {issuer, recipient} = this.noteParties(g), k = edgeKey(issuer, recipient);
    this.assertPairFree(c, issuer, recipient);
    if (!bound && P.s.edges?.[k]?.novated) throw new PilotError('bound_note_required', 'a debt transfer or set-off changed this edge, so it takes bound credit notes only: fetch the template with bound=1', 409);
    const reserved = bound ? null : await P.reservedResidues();
    const cur = await P.basis.note(issuer, recipient);
    const prior = Number(cur?.amount_collected ?? 0), total = prior + c.amount, last = Number(cur?.timestamp ?? 0);
    let timestamp, ahead;
    if (bound) {
      const r = residueTimestamp(this.now(), BOUND_NOTE_MS, P.circulating ? Math.max(last, P.liveSetoffTimestamp(k)) : last);
      timestamp = r.timestamp; ahead = r.ahead_ms ?? 0;
    } else {
      timestamp = Math.max(this.now() - 1500, last + 1);
      if (reserved) timestamp = ordinaryTimestamp(timestamp);
      ahead = timestamp - this.now();
    }
    if (ahead > 0) {
      if (!wait || ahead > NOTE_CLOCK_WAIT_MS) throw new PilotError('note_timestamp_ahead', `a new note on this pair needs a timestamp ${bound ? `ending in ${BOUND_NOTE_MS} ms, ` : ''}after the pair's last note (timestamped ${last}); there is one in ${ahead} ms. Fetch the template again in ${Math.ceil(ahead / 1000)} s.`, 409, {retry_after_ms: ahead, last_note_timestamp: last});
      await new Promise(r => setTimeout(r, ahead + 5));
      return this.noteTemplate(p, id, callId, {wait: false, prior: withPrior, bound});
    }
    const {message_hex} = await P.noteMessage({issuer, recipient, total, timestamp});
    const B = P.s.participants[g.backer], C = P.s.participants[g.creditor];
    const out = {guarantee_id: g.id, call_id: c.id, terms_hash: g.terms_hash, amount: c.amount, issuer_pubkey: issuer, recipient_pubkey: recipient,
      keys_as_agreed: issuer === g.terms.backer.pubkey && recipient === g.terms.creditor.pubkey, backer: {id: B.id, handle: B.handle}, creditor: {id: C.id, handle: C.handle},
      prior_total: prior, total, timestamp, tracker_nft_id: P.basis.nft, denomination: P.basis.denomination, message_hex};
    if (withPrior || bound) out.prior_note = cur ? {total: prior, timestamp: cur.timestamp, signature: cur.signature} : null;
    if (bound) {
      out.prior_timestamp = cur ? cur.timestamp : 0;
      out.prior_message_hex = await P.messageHex({issuer, recipient, total: prior, prior_timestamp: out.prior_timestamp, timestamp});
    }
    return out;
  }
  // POST .../calls/{vgc}/honor {terms_hash, amount, signature (statement guarantee-honor), credit_note {total, timestamp,
  // signature[, prior_total, prior_timestamp, prior_signature]}}: checked as a deal's note is at completion
  // (Pilot.completeLocked), written ahead (issuing), sent to the tracker, read back: honored, or failed (the backer
  // signs a new note; the call stays to be honored).
  honor(p, id, callId, {terms_hash, amount, signature, credit_note: note} = {}) {
    return this.P.serial(async () => {
      const P = this.P;
      P.assertTrackerWritable();
      const {g, c, ledger, owed, unpaid} = await this.honorContext(p, id, callId);
      if (terms_hash !== g.terms_hash) throw new PilotError('stale_terms', `terms_hash does not match this guarantee (${g.terms_hash})`, 409);
      if (amount !== c.amount) throw new PilotError('stale_amount', `call ${c.id} is for ${c.amount}, not ${amount}`, 409);
      await P.verifySig(p, guaranteeStatements.honor(g.terms_hash, c.id, c.amount), signature, 'honor');
      if (!this.honorable(g, c, owed, unpaid)) {
        this.lapse(g, c, owed); P.save();
        throw new PilotError('call_lapsed', `the issuer now owes the creditor ${amt(owed)}, less than what this call and the earlier ones claim: the call lapsed and nothing was paid. The creditor may call again for what is still owed.`, 409, {issuer_owes_creditor: owed});
      }
      const {issuer, recipient} = this.noteParties(g), k = edgeKey(issuer, recipient);
      this.assertPairFree(c, issuer, recipient);
      const reserved = await P.reservedResidues();
      const bound = !!reserved?.includes(BOUND_NOTE_MS) && Number.isSafeInteger(note?.timestamp) && note.timestamp % 1000 === BOUND_NOTE_MS;
      const cur = await P.basis.note(issuer, recipient), prior = Number(cur?.amount_collected ?? 0), priorTs = cur ? cur.timestamp : 0;
      const stale = m => new PilotError('stale_note', `${m}; fetch a new note template${bound ? ' (bound=1)' : ''}`, 409);
      if (!note || typeof note !== 'object' || note.total !== prior + c.amount) throw stale(`the note total must be ${prior + c.amount} (tracker prior ${prior} + the call's ${c.amount})`);
      if (!isInt(note.timestamp, Number(cur?.timestamp ?? 0) + 1, this.now())) throw stale('the note timestamp must be after the pair\'s last note and not in the future');
      if (!bound && P.s.edges?.[k]?.novated) throw new PilotError('bound_note_required', 'a debt transfer or set-off changed this edge, so it takes bound credit notes only', 409);
      if (bound && note.timestamp < this.now() - MAX_AGE_MS) throw stale('a bound note more than one hour old can no longer be recorded by the tracker');
      if (reserved && !bound && reserved.includes(note.timestamp % 1000)) throw stale(`the note timestamp ends in ${note.timestamp % 1000} ms, which the tracker keeps for other operations`);
      if (bound && note.prior_total !== prior) throw stale(`a bound note's prior_total must be the pair's current total on the tracker, ${prior}`);
      if (bound && note.prior_timestamp != null && note.prior_timestamp !== priorTs) throw stale(`a bound note's prior_timestamp must be the timestamp of the pair's current note, ${priorTs} (0 for a pair with no note)`);
      const {message_hex} = await P.noteMessage({issuer, recipient, total: note.total, timestamp: note.timestamp});
      if (!(await P.safeVerify(issuer, message_hex, note.signature))) throw new PilotError('bad_signature', 'the Basis note signature does not verify for the backer\'s key', 403);
      if (bound) {
        const ack = await P.messageHex({issuer, recipient, total: prior, prior_timestamp: priorTs, timestamp: note.timestamp});
        if (!(await P.safeVerify(issuer, ack, note.prior_signature)))
          throw new PilotError('bad_signature', `the prior acknowledgment (credit_note.prior_signature) does not verify: it must be the backer's signature over the prior acknowledgment ${PRIOR_ACK} of the pair's current note (total ${prior}, timestamp ${priorTs}) at the note's timestamp`, 403);
      }
      // A read outside the lock may have lapsed the call meanwhile (the issuer repaid): nothing is paid then (review F3).
      if (!UNHONORED.has(c.state)) throw new PilotError('wrong_state', `call ${c.id} is ${c.state} now; nothing to honor`, 409);
      c.state = 'issuing'; c.honor_signature = signature; c.keys = {issuer, recipient}; c.prior_total = prior;
      c.note_prior = {total: prior, timestamp: cur?.timestamp ?? null, signature: cur?.signature ?? null};
      c.note = {total: note.total, timestamp: note.timestamp, signature: note.signature, message_hex, ...(bound ? {prior_signature: note.prior_signature} : {})};
      c.signed_at = iso(this.now()); delete c.error;
      this.event(g, p.id, 'honor_signed', {call_id: c.id, amount: c.amount});
      P.save();                                     // write-ahead: recover() finishes this after a crash
      await this.submitNote(g, c);
      return this.view(g, p, await P.ledger());
    });
  }
  // Sends a call's note to the tracker (or, recovering, reads first whether it holds it already) and records the outcome.
  // With the lock held. A recorded note is journaled (kind issue, ref the call id), like a deal's.
  async submitNote(g, c, {recovering = false} = {}) {
    const P = this.P, n = c.note, {issuer, recipient} = c.keys;
    const before = recovering ? await P.basis.note(issuer, recipient) : null;
    if (before?.signature !== n.signature && P.writeRefusal()) return c;
    let r = null;
    const priorTs = n.prior_signature ? {prior_timestamp: c.note_prior?.timestamp ?? 0} : {};
    if (before?.signature !== n.signature) r = await P.basis.api('POST', '/notes', {issuer_pubkey: issuer, recipient_pubkey: recipient, amount: n.total, timestamp: n.timestamp,
      signature: n.signature, tracker_nft_id: P.basis.nft, denomination: P.basis.denomination,
      ...(n.prior_signature ? {prior_signature: n.prior_signature, prior_total: c.prior_total, ...priorTs} : {})});
    const rb = await P.basis.note(issuer, recipient);
    const held = !!rb && rb.signature === n.signature && Number(rb.amount_collected) === n.total && rb.timestamp === n.timestamp;
    if (!held) {
      const code = typeof r?.json?.code === 'string' ? r.json.code : null;
      c.state = 'failed';
      c.error = r ? `the tracker did not record the note (HTTP ${r.status}${code ? `, ${code}` : ''})` : 'the tracker does not hold the note';
      this.event(g, 'basis-tracker', 'honor_failed', {call_id: c.id, error: c.error});
    } else {
      const now = this.now();
      c.state = 'honored'; c.honored_at = iso(now); c.late = now > Date.parse(c.honor_by); c.recovered = recovering || undefined;
      c.tracker_note = {amount_collected: Number(rb.amount_collected), amount_redeemed: Number(rb.amount_redeemed ?? 0), timestamp: rb.timestamp, signature: rb.signature, confirmation: rb.confirmation?.status};
      const [entry] = appendEntries(P, [{kind: 'issue', ref: c.id, issuer_pubkey: issuer, recipient_pubkey: recipient, delta: c.amount,
        total_after: Number(rb.amount_collected), timestamp: rb.timestamp, signature: rb.signature}]);
      c.journal_seq = entry.seq;
      this.event(g, 'basis-tracker', 'honored', {call_id: c.id, amount: c.amount, cumulative_total: n.total, late: c.late});
    }
    P.save(); P.store.audit({type: `guarantee.call_${c.state}`, guarantee: g.id, call: c.id});
    if (held) await P.clearingAfterIncrease([edgeKey(issuer, recipient)]);
    return c;
  }
  // Pilot.recover() (lock held): every call left issuing is decided by read-back, or sent again. '<vgc id>:<state>'.
  async recover({refused = false} = {}) {
    const out = [];
    for (const g of this.list()) for (const c of g.calls) if (c.state === 'issuing') {
      const st = (await this.submitNote(g, c, {recovering: true})).state;
      if (!refused || st !== 'issuing') out.push(`${c.id}:${st}`);
    }
    return out;
  }

  // ---------- what the limits count ----------
  // What the backer may still have to pay under its guarantees: the cap not yet honored while an offer is open or the
  // guarantee is active; afterwards (expired, released) its unhonored calls. `excludeGuaranteeId`: the one being checked.
  obligation(g) {
    if (OPEN_OFFER.has(g.state) || g.state === 'active') return Math.max(0, g.terms.cap.amount - this.honoredAmount(g));
    return sum(g.calls.filter(c => UNHONORED.has(c.state) || c.state === 'issuing'));
  }
  backerObligation(p, {excludeGuaranteeId = null} = {}) {
    return this.list().filter(g => g.backer === p.id && g.id !== excludeGuaranteeId).map(g => this.sweep(g)).reduce((a, g) => a + this.obligation(g), 0);
  }
  // What a creditor may come to hold on backers (one backer, or any): the same amounts, for guarantees it accepted.
  contingentClaims(C, {backerId = null, excludeGuaranteeId = null} = {}) {
    return this.list().filter(g => g.creditor === C.id && g.acceptance && g.id !== excludeGuaranteeId && (backerId === null || g.backer === backerId))
      .map(g => this.sweep(g)).reduce((a, g) => a + (OPEN_OFFER.has(g.state) ? 0 : this.obligation(g)), 0);
  }
  // What backs `issuerId`'s debt to creditor C once it is `debtAfter` (what the issuer would owe C with the deal being
  // agreed), for min_payer_coverage_pct (fix inbox #19):
  //   amount        what backers could still be called for on that debt: the open caps of the active guarantees, but no
  //                 more than the debt less what calls on its guarantees (any, ever) claimed;
  //   already_paid  what calls on the debt's guarantees claimed (honored, or open and still to be honored);
  //   cover         what the backers pay or paid of that debt in all: already_paid + amount, at most debtAfter.
  // ids: the active guarantees with an open cap.
  // ratio(backerId): what a backer's IOU is worth to C, from 0 to 1 (Pilot.groundedFor, fix inbox #20); each guarantee's
  // open cap and what its calls claimed count at it. Without it, at face value. What can still be called is limited by the
  // face amounts claimed (a call claims face value whatever the backer is worth).
  // debtFrom (ms): when the debt being covered can first arise (a deal's deliver_by); an active guarantee counts only if it
  // can still be called an hour after that (review F6b: one callable for an hour must not cover a deal delivered in days).
  // dealId: the deal being agreed; a guarantee in the deal mode (fix inbox #29) counts only for the deals it names.
  backingFor(C, issuerId, {debtAfter = null, ratio = () => 1, debtFrom = null, dealId = null} = {}) {
    const r = id => Math.max(0, Math.min(1, ratio(id)));
    const all = this.list().filter(g => g.creditor === C.id && g.issuer === issuerId && (g.terms.covers !== COVERS_DEALS || (dealId && g.terms.deals.includes(dealId)))).map(g => this.sweep(g));
    const lasts = g => debtFrom === null || Date.parse(g.terms.expires_at) >= debtFrom + GUARANTEE_LIMITS.min_call_window_hours * HOUR;
    const parts = all.filter(g => g.state === 'active' && lasts(g)).map(g => ({id: g.id, open: Math.max(0, g.terms.cap.amount - this.claimed(g)), r: r(g.backer)})).filter(x => x.open > 0);
    const openFace = parts.reduce((a, x) => a + x.open, 0), openValue = parts.reduce((a, x) => a + x.open * x.r, 0);
    const paidFace = all.reduce((a, g) => a + this.claimed(g), 0), paid = Math.floor(all.reduce((a, g) => a + this.claimed(g) * r(g.backer), 0) + 1e-9);
    if (debtAfter === null) return {amount: Math.floor(openValue + 1e-9), already_paid: paid, cover: Math.floor(openValue + 1e-9) + paid, ids: parts.map(x => x.id)};
    const callable = Math.min(openFace, Math.max(0, debtAfter - paidFace));
    const amount = openFace ? Math.floor(callable * openValue / openFace + 1e-9) : 0;
    return {amount, already_paid: paid, cover: Math.min(debtAfter, paid + amount), ids: parts.map(x => x.id)};
  }
  // The backers of `issuerId`'s debt to creditor C (accepted guarantees), by participant id.
  backersOf(C, issuerId) { return [...new Set(this.list().filter(g => g.creditor === C.id && g.issuer === issuerId && g.acceptance).map(g => g.backer))]; }

  // ---------- views ----------
  nextActions(g, p, callable) {
    const out = [];
    if (g.backer === p.id) {
      if (OPEN_OFFER.has(g.state)) out.push('withdraw');
      if (g.calls.some(c => UNHONORED.has(c.state))) out.push('honor');
    }
    if (g.creditor === p.id) {
      if (g.state === 'offered') out.push('accept', 'decline');
      if (g.state === 'active' && callable > 0) out.push('call');
      if ((g.state === 'active' || g.state === 'expired') && !g.calls.some(c => c.state === 'issuing')) out.push('release');
    }
    return out;
  }
  callView(g, c, owed, role = 'backer', unpaid = null) {
    const overdue = UNHONORED.has(c.state) && this.now() > Date.parse(c.honor_by);
    // The floating mode: a call for more than the issuer owed when the guarantee was accepted (fix inbox #29).
    const above = g.terms.covers !== COVERS_DEALS && Number.isSafeInteger(g.acceptance?.owed_at_acceptance) && (c.claimed_before ?? 0) + c.amount > g.acceptance.owed_at_acceptance;
    return {call_id: c.id, amount: c.amount, state: c.state, called_at: c.called_at, honor_by: c.honor_by, overdue, ...(above ? {above_debt_at_acceptance: true} : {}),
      ...(UNHONORED.has(c.state) && owed !== null ? {honorable_now: this.honorable(g, c, owed, unpaid)} : {}),
      issuer_owed_at_call: c.owed_at_call, signature: c.signature,
      ...(c.honored_at ? {honored_at: c.honored_at, late: !!c.late} : {}),
      // The backer's note and honor signatures: the backer's and the creditor's to see, not the issuer's (it is not on
      // that edge; review F8).
      ...(c.tracker_note ? {note: {issuer_pubkey: c.keys.issuer, recipient_pubkey: c.keys.recipient, total: c.tracker_note.amount_collected, timestamp: c.tracker_note.timestamp,
        ...(role !== 'issuer' ? {signature: c.tracker_note.signature} : {}), confirmation: c.tracker_note.confirmation}, ...(role !== 'issuer' ? {honor_signature: c.honor_signature} : {})} : {}),
      ...(c.state === 'failed' ? {error: c.error} : {}), ...(c.lapsed_at ? {lapsed_at: c.lapsed_at, issuer_owed_at_lapse: c.issuer_owed_at_lapse} : {})};
  }
  view(g, p, ledger = null) {
    this.sweep(g);
    if (ledger) this.lapseStale(ledger, [g]);
    const P = this.P, t = g.terms, who = id => { const q = P.s.participants[id]; return {id, handle: q?.handle ?? null}; };
    const owed = ledger ? this.owed(g, ledger) : null, unpaid = ledger ? this.dealsUnpaid(g, ledger) : null;
    const claimed = this.claimed(g), honored = this.honoredAmount(g), callable = this.callable(g, owed, unpaid);
    const shares = owed === null ? null : this.recoveredShares(g, owed);
    const role = g.backer === p.id ? 'backer' : g.creditor === p.id ? 'creditor' : 'issuer';
    return {guarantee_id: g.id, state: g.state, your_role: role, backer: who(g.backer), issuer: who(g.issuer), creditor: who(g.creditor), unit: P.unit,
      cap: t.cap.amount, due_at: t.due_at, expires_at: t.expires_at, honor_within_hours: t.honor_within_hours, offer_expires_at: t.offer_expires_at, note: t.note,
      covers: t.covers === COVERS_DEALS ? COVERS_DEALS_TEXT : COVERS_TEXT, ...(t.covers === COVERS_DEALS ? {deals: t.deals, deals_unpaid: unpaid} : {}),
      ...(g.acceptance && Number.isSafeInteger(g.acceptance.owed_at_acceptance) ? {owed_at_acceptance: g.acceptance.owed_at_acceptance} : {}),
      claimed, honored, remaining_cap: Math.max(0, t.cap.amount - claimed),
      issuer_owes_creditor: owed, ...(ledger && this.honorDebt(g) ? {issuer_owes_on_tracker: this.owedOnTracker(g, ledger), issuer_honor_debt: this.honorDebt(g)} : {}),
      callable_now: callable, callable_from: t.due_at,
      recovered_for_backer: shares === null ? null : shares.of(g.id),
      // The debt this guarantee covers, with every guarantee of it (fix inbox #19): amounts only, no other backer named.
      debt: {issuer_owes_creditor: owed, claimed_by_all_guarantees: this.debtClaimed(g), honored_by_all_backers: this.debtHonored(g),
        recovered_for_backers: shares === null ? null : shares.total, guarantees_of_it: this.ofDebt(g).filter(x => x.acceptance).length},
      calls: g.calls.map(c => this.callView(g, c, owed, role, unpaid)),
      next_actions: this.nextActions(g, p, callable),
      terms: t, terms_hash: g.terms_hash,
      offer: {by: g.offer.by, at: g.offer.at, signature: g.offer.signature, offered_at: g.offer.offered_at,
        ...(role === 'backer' ? {approval_id: g.offer.approval_id ?? null, owner_approval: g.offer.owner_approval ?? null, mandate_check: g.offer.mandate_check} : {})},
      acceptance: g.acceptance ? {by: g.acceptance.by, at: g.acceptance.at, signature: g.acceptance.signature, ...(role === 'creditor' ? {mandate_check: g.acceptance.mandate_check} : {})} : null,
      ...(g.decline ? {decline: {at: g.decline.at, reason: g.decline.reason, signature: g.decline.signature}} : {}),
      ...(g.withdrawal ? {withdrawal: {at: g.withdrawal.at, signature: g.withdrawal.signature}} : {}),
      ...(g.release ? {release: {at: g.release.at, signature: g.release.signature}} : {}),
      // Events about the backer's owner's decision stay on the backer's side (only: the backer).
      history: g.history.filter(h => !h.only || h.only === p.id).map(({only: _only, ...h}) => h),
      what_this_means: WHAT_IT_MEANS};
  }
  async viewsFor(p) {
    const ledger = await this.P.ledger();
    return this.list().filter(g => this.visibleTo(g, p)).map(g => this.view(g, p, ledger)).reverse();
  }
  async viewFor(p, id) { const g = this.party(id, p); return this.view(g, p, await this.P.ledger()); }
  // The owner's approval view (GET /owner, POST /owner/approvals answers): the held offer.
  approvalView(a, owner, ledger = null) {
    const g = this.all()[a.guarantee_id];
    const subject = g ? {terms: g.terms, terms_hash: g.terms_hash, mandate_check: g.offer.mandate_check, issuer: g.issuer, creditor: g.creditor} : null;
    return {...a, subject, mandate_check: subject?.mandate_check ?? null,
      effect: g ? `approving offers ${this.P.s.participants[g.creditor]?.handle ?? g.creditor} this guarantee: your agent promises to pay it up to ${amt(g.terms.cap.amount)} of what ${this.P.s.participants[g.issuer]?.handle ?? g.issuer} still owes it after ${g.terms.due_at}, if it calls before ${g.terms.expires_at}; until the guarantee ends its open cap counts against your agent's max_issue_outstanding. Rejecting offers nothing.` : null,
      deal: null, guarantee: g ? this.view(g, owner, ledger) : null};
  }
  // The inbox's guarantees section (Pilot.inbox): offers to answer, calls to honor, active guarantees. Sync (no tracker
  // read): amounts that need the tracker are in the guarantee's own view.
  inboxOf(p) {
    const mine = this.list().filter(g => this.visibleTo(g, p)).map(g => this.sweep(g));
    if (!mine.length) return null;
    const handle = id => this.P.s.participants[id]?.handle ?? null, now = this.now();
    const brief = g => ({guarantee_id: g.id, state: g.state, your_role: g.backer === p.id ? 'backer' : g.creditor === p.id ? 'creditor' : 'issuer',
      backer: handle(g.backer), issuer: handle(g.issuer), creditor: handle(g.creditor), cap: g.terms.cap.amount, due_at: g.terms.due_at, expires_at: g.terms.expires_at});
    return {
      to_answer: mine.filter(g => g.creditor === p.id && g.state === 'offered').map(brief),
      to_honor: mine.filter(g => g.backer === p.id).flatMap(g => g.calls.filter(c => UNHONORED.has(c.state))
        .map(c => ({...brief(g), call_id: c.id, amount: c.amount, honor_by: c.honor_by, overdue: now > Date.parse(c.honor_by)}))),
      active: mine.filter(g => g.state === 'active').map(g => ({...brief(g), due: now >= Date.parse(g.terms.due_at), call_open: !!this.openCall(g)})),
      waiting_for_your_owner: mine.filter(g => g.backer === p.id && g.state === 'awaiting_owner').map(brief),
    };
  }
}

// ---------- the record (lib/pilot/evidence.mjs reads these; aggregates only) ----------
// A participant's guarantees, by role: as backer (given), as the issuer backed, as the creditor holding them. Counts and
// amounts of calls, how many were honored (on time or late), and how many are overdue (unhonored past honor_by).
// With the ledger, an unhonored call the issuer's repayment made unpayable no longer stands (review F2, F7): it is not
// counted, called or overdue, whether or not anything has lapsed it yet.
const standing = (book, ledger) => (g, c) => CLAIMING.has(c.state) && (!ledger || !UNHONORED.has(c.state) || book.honorable(g, c, book.owed(g, ledger), book.dealsUnpaid(g, ledger)));
export function backingRecord(pilot, p, byKind, ledger = null) {
  const book = pilot.guarantees, now = pilot.now(), stands = book ? standing(book, ledger) : () => false;
  const gs = book ? book.list().map(g => book.sweep(g)).filter(g => g.acceptance) : [];
  const calls = xs => xs.flatMap(g => g.calls.filter(c => stands(g, c)));
  const tally = cs => ({count: cs.length, PC: sum(cs)});
  const given = gs.filter(g => g.backer === p.id), backed = gs.filter(g => g.issuer === p.id), held = gs.filter(g => g.creditor === p.id);
  const gc = calls(given), honored = gc.filter(c => c.state === 'honored'), overdue = gc.filter(c => UNHONORED.has(c.state) && now > Date.parse(c.honor_by));
  const backers = new Set(backed.map(g => g.backer));
  return {
    given: {accepted: given.length, active: given.filter(g => g.state === 'active').length,
      open_cap_PC: given.filter(g => g.state === 'active').reduce((a, g) => a + Math.max(0, g.terms.cap.amount - book.claimed(g)), 0),
      called: tally(gc), honored: tally(honored), honored_late: honored.filter(c => c.late).length, overdue: tally(overdue),
      ended_uncalled: given.filter(g => (g.state === 'expired' || g.state === 'released') && !g.calls.some(c => stands(g, c))).length},
    backed_as_issuer: {accepted: backed.length, backers: backers.size, backers_by_kind: byKind(pilot, backers), called_against: tally(calls(backed))},
    held_as_creditor: {accepted: held.length, called: tally(calls(held))},
  };
}
// The network's totals of the same.
export function backingTotals(pilot, ledger = null) {
  const book = pilot.guarantees, now = pilot.now(), stands = book ? standing(book, ledger) : () => false;
  const gs = book ? book.list().map(g => book.sweep(g)).filter(g => g.acceptance) : [];
  const cs = gs.flatMap(g => g.calls.filter(c => stands(g, c)));
  const honored = cs.filter(c => c.state === 'honored');
  return {accepted: gs.length, active: gs.filter(g => g.state === 'active').length, called: {count: cs.length, PC: sum(cs)}, honored: {count: honored.length, PC: sum(honored)},
    overdue: cs.filter(c => UNHONORED.has(c.state) && now > Date.parse(c.honor_by)).length};
}
