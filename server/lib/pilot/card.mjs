// The budget card: what an agent may commit for its owner, the room left, who backs it and its record, so anyone can
// check a payer before taking its IOU. Its owner publishes it (mandate public_card, Pilot.setMandate); until then both
// routes answer 404 card_not_public. Public, no token, under the per-address read budget like every GET:
//   GET /pilot/v1/participants/{vp}/card                               budgetCard
//   GET /pilot/v1/participants/{vp}/check?amount=N&payee=<id|handle>   checkPayer: Pilot.checkMandate as the payer, a dry run
// The card shows what the server enforces: the mandate as Pilot.effectiveLimits gives it (the owner's mandate, tightened
// by limits the agent recorded), and the room as checkMandate counts it for max_issue_outstanding (Pilot.issueExposure).
// The check gives the answer the server would give the payer's agent now.
// Read-only: nothing changes beyond what any read does (deals and guarantees swept, calls a repayment made unpayable
// lapsed), and no signed format changes. Amounts are whole numbers in the network's unit (`unit`), under unit-neutral
// names (fix inbox #32): no `_PC` key anywhere.
// The cover a payee holds on the payer's IOUs is the payee's own business: the check shows it only when it is sent with
// the payee's token (agent or owner); otherwise `cover.covered` is null, and the check is cached as any public read.
import {PilotError, PRICE_CAP, canonical, sha256} from './core.mjs';
import {NETWORK, PUBLIC_ORIGIN, amt} from './units.mjs';
import {AGENT_HANDLE_RE, agentPageShown, recordOf} from './agents.mjs';
import {COVERS_DEALS, PUBLIC_VOUCHES_SHOWN} from './guarantees.mjs';

export const CARD_VERSION = 1;
export const OBJECTIVE_MAX = 300;
const PID_RE = /^vp_[0-9a-f]{12}$/, AMOUNT_RE = /^[1-9][0-9]*$/;
const iso = t => new Date(t).toISOString();
const listed = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const cardPublic = p => p?.mandate?.public_card === true;
export function assertCardPublic(p) {
  if (!cardPublic(p)) throw new PilotError('card_not_public', "this agent's owner has not published its budget card", 404);
}

// The card's mandate: the values the server enforces (Pilot.effectiveLimits). approve_above 0 means its owner approves
// every commitment (checkMandate holds any price above approve_above for the owner). The objective is cut to
// OBJECTIVE_MAX characters (code points, so no character is split).
export function cardMandate(pilot, p) {
  const m = pilot.effectiveLimits(p);
  return {version: p.mandate_version, expires_at: m.expires_at ?? null, may_issue_credit: !!m.may_issue_credit,
    per_deal: m.max_issue_per_deal, outstanding_cap: m.max_issue_outstanding, approve_above: m.approve_above ?? 0,
    counterparties: m.counterparties === 'any' ? 'any' : {listed: Array.isArray(m.counterparties) ? m.counterparties.length : 0},
    objective: Array.from(String(m.objective ?? '')).slice(0, OBJECTIVE_MAX).join('')};
}

// The room under max_issue_outstanding, counted as checkMandate counts it (Pilot.issueExposure: notes on the tracker,
// agreed deals not paid yet, its own open offers, its open guarantee caps), after what a mandate check reads first (calls
// a repayment made unpayable lapse). Also GET /me `room` (fix inbox #54 item 7).
export function roomOf(pilot, p, ledger) {
  pilot.guarantees?.lapseStale(ledger);
  const cap = pilot.effectiveLimits(p).max_issue_outstanding, outstanding = pilot.issueExposure(p, ledger).total;
  return {outstanding, room_left: Math.max(0, cap - outstanding)};
}

// Guarantees backing p's IOUs (p the issuer; one creditor, or any), active after the sweep every read does. remaining:
// the cap less what calls claimed, as the guarantee views give it (remaining_cap).
function activeBacking(pilot, p, creditorId = null) {
  const book = pilot.guarantees;
  if (!book) return [];
  return book.list().filter(g => g.issuer === p.id && (creditorId === null || g.creditor === creditorId)).map(g => book.sweep(g)).filter(g => g.state === 'active');
}
const remainingOf = (pilot, g) => Math.max(0, g.terms.cap.amount - pilot.guarantees.claimed(g));
// Fix inbox #31: a guarantee is public when both its issuer and its backer chose public vouches (setProfile).
const vouchPublic = (pilot, g) => !!pilot.s.participants[g.issuer]?.public_vouches && !!pilot.s.participants[g.backer]?.public_vouches;
const who = (pilot, id) => ({id, handle: pilot.s.participants[id]?.handle ?? null});
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

// The card's backing: counts and sums over every active guarantee of p's IOUs; `public` lists only those public under
// fix inbox #31 (the newest PUBLIC_VOUCHES_SHOWN), the rest count in the totals only. The creditor is not named: #31
// never names it (who holds the IOUs stays private), so `creditor` is null; a creditor sees its own cover with the check.
export function backingOf(pilot, p) {
  const gs = activeBacking(pilot, p);
  const shown = gs.filter(g => vouchPublic(pilot, g)).sort((a, b) => Date.parse(b.acceptance?.at ?? 0) - Date.parse(a.acceptance?.at ?? 0)).slice(0, PUBLIC_VOUCHES_SHOWN);
  return {active: gs.length, creditors: new Set(gs.map(g => g.creditor)).size, total_cap: sum(gs, g => g.terms.cap.amount), remaining: sum(gs, g => remainingOf(pilot, g)),
    public: shown.map(g => ({guarantee_id: g.id, backer: who(pilot, g.backer), creditor: null, cap: g.terms.cap.amount, remaining: remainingOf(pilot, g), expires_at: g.terms.expires_at}))};
}

// card_hash: what a reader can keep to tell later whether the mandate it relied on changed (its version is in it).
export const cardHash = (p, mandate) => sha256(canonical({card: CARD_VERSION, network: NETWORK, agent: p.id, mandate}));
export const checkTemplate = p => `${PUBLIC_ORIGIN}/pilot/v1/participants/${p.id}/check?amount={amount}&payee={payee}`;

// GET /participants/{vp}/card. `ledger`: the tracker's notes when the caller has read them already.
export async function budgetCard(pilot, p, {ledger = null} = {}) {
  assertCardPublic(p);
  ledger ??= await pilot.ledger();
  const mandate = cardMandate(pilot, p), room = roomOf(pilot, p, ledger);
  return {card: CARD_VERSION, network: NETWORK, unit: pilot.unit,
    agent: {id: p.id, handle: p.handle, display_name: p.display_name, operator: p.operator},
    mandate, room: {...room, as_of: iso(pilot.now())}, backing: backingOf(pilot, p),
    record: recordOf(await pilot.position(p, ledger)),
    card_hash: cardHash(p, mandate), check: checkTemplate(p), page: agentPageShown(p) ? `${PUBLIC_ORIGIN}/agent/${p.handle}` : null};
}

// The check's query: `amount` a positive safe integer (written as digits only), `payee` a participant id or handle.
export function parseAmount(raw, unit) {
  const n = typeof raw === 'string' && AMOUNT_RE.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw new PilotError('invalid_field', `amount must be a whole number of at least 1 (${unit}), written as digits`);
  return n;
}
export function findPayee(pilot, raw, payer) {
  if (typeof raw !== 'string' || !raw.trim()) throw new PilotError('invalid_field', 'payee is required: the participant id or handle of the agent that would take the IOU');
  const s = raw.trim().toLowerCase(), all = pilot.s.participants;
  const q = PID_RE.test(s) ? (Object.hasOwn(all, s) ? all[s] : null) : AGENT_HANDLE_RE.test(s) ? Object.values(all).find(x => x.handle === s) ?? null : null;
  if (!q) throw new PilotError('not_found', 'unknown payee: give the participant id or handle of the agent that would take the IOU', 404);
  if (payer && q.id === payer.id) throw new PilotError('invalid_field', 'payee must be another participant than the payer');
  return q;
}

// The check's cover: the active guarantees of the payer's IOUs to this payee; covered is the sum of their remaining caps.
// A backer is named only when the guarantee is public under fix inbox #31; otherwise backer is null. A guarantee in the
// deal mode (fix inbox #29) is counted too, but backs only the deals it names, and the reason says how much of the cover
// that is.
export function coverFor(pilot, p, payee) {
  const gs = activeBacking(pilot, p, payee.id);
  const guarantees = gs.map(g => ({guarantee_id: g.id, backer: vouchPublic(pilot, g) ? who(pilot, g.backer) : null, remaining: remainingOf(pilot, g)}));
  const forDeals = sum(gs.filter(g => g.terms.covers === COVERS_DEALS), g => remainingOf(pilot, g));
  const hidden = new Set(gs.filter(g => !vouchPublic(pilot, g) && remainingOf(pilot, g) > 0).map(g => g.backer)).size;
  const named = [...new Set(guarantees.filter(g => g.backer?.handle && g.remaining > 0).map(g => `@${g.backer.handle}`))];
  return {cover: {covered: sum(guarantees, g => g.remaining), guarantees}, forDeals, by: [...named, ...(hidden ? [hidden === 1 ? 'a backer not named here' : `${hidden} backers not named here`] : [])]};
}

// The refusal in plain words, for the rule checkMandate named (its message otherwise, without the limit-set label).
function declineReason(pilot, e, {p, payee, amount, mandate, room}) {
  const list = pilot.effectiveLimits(p).counterparties;
  switch (e.extra?.rule) {
    case 'no_agent': return 'It has no active agent key: it cannot commit to anything until its owner connects an agent.';
    case 'network_limit': return `Over the network's limit: a deal is at most ${amt(PRICE_CAP)}, less than ${amt(amount)}.`;
    case 'expires_at': return `Its owner's mandate ended at ${mandate.expires_at}: it cannot commit to anything until its owner renews it.`;
    case 'counterparties': return list !== 'any' && !(list || []).includes(payee.id)
      ? `Its owner has not listed ${payee.handle} among the agents it may deal with.`
      : `It is a self-serve sandbox agent: on this server it may deal only with the sandbox agents, not ${payee.handle}.`;
    case 'may_issue_credit': return 'Its owner has not allowed it to pay with IOUs.';
    case 'max_issue_per_deal': return `Over its limit per deal: ${amt(amount)} is more than the ${amt(mandate.per_deal)} a deal its owner allows.`;
    case 'max_issue_outstanding': return `Over its budget: it has ${amt(room.room_left)} of ${amt(mandate.outstanding_cap)} left, less than ${amt(amount)}.`;
    default: {
      const t = String(e.message).replace(/^[^:]*: /, '');
      return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
    }
  }
}

// GET /participants/{vp}/check: would the payer's agent be allowed to commit `amount` to `payee` now? Pilot.checkMandate
// as the payer, a dry run over the same tracker read as the card's numbers:
//   decline    checkMandate refuses (mandate_exceeded); `rule` is its rule;
//   ask_owner  it passes, and the commitment would wait for the payer's owner (checkMandate's needsOwner: the amount is
//              above approve_above; with approve_above 0 that is every commitment); `rule` is approve_above;
//   accept     it passes and nothing waits; `rule` is null.
// Two refusals come before the mandate, as the server gives them to a proposal: a payer with no active agent key cannot
// sign anything (rule no_agent), and no deal is above the network's PRICE_CAP (rule network_limit).
// `amount` and `payee` as parseAmount and findPayee return them; `showCover` only when the payee itself asks.
export async function checkPayer(pilot, p, {amount, payee, showCover = false}) {
  const started = performance.now();
  assertCardPublic(p);
  const ledger = await pilot.ledger();
  const card = await budgetCard(pilot, p, {ledger}), {mandate, room} = card;
  let refusal = null, needsOwner = false;
  const refuse = rule => new PilotError('mandate_exceeded', rule, 403, {rule});
  if (p.status !== 'active' || !p.pubkey) refusal = refuse('no_agent');
  else if (amount > PRICE_CAP) refusal = refuse('network_limit');
  else {
    try { ({needsOwner} = await pilot.checkMandate(p, 'payer', payee.id, amount, {ledger})); }
    catch (e) { if (e?.code !== 'mandate_exceeded') throw e; refusal = e; }
  }
  const verdict = refusal ? 'decline' : needsOwner ? 'ask_owner' : 'accept';
  const {cover, forDeals, by} = showCover ? coverFor(pilot, p, payee) : {cover: {covered: null, guarantees: []}, forDeals: 0, by: []};
  const reasons = refusal ? [declineReason(pilot, refusal, {p, payee, amount, mandate, room})] : [
    `Within its budget: up to ${amt(mandate.per_deal)} a deal, ${amt(room.room_left)} of ${amt(mandate.outstanding_cap)} left.`,
    ...(needsOwner ? [mandate.approve_above > 0
      ? `Its owner approves each commitment above ${amt(mandate.approve_above)}: this one waits for the owner before it binds.`
      : 'Its owner approves every commitment itself: this one waits for the owner before it binds.'] : []),
    ...(cover.covered > 0 ? [`Backed for you up to ${amt(cover.covered)} by ${listed(by)}${forDeals ? ` (${amt(forDeals)} of it backs only particular deals)` : ''}.`] : [])];
  return {verdict, reasons, rule: refusal ? refusal.extra?.rule ?? null : needsOwner ? 'approve_above' : null,
    payer: {id: p.id, handle: p.handle}, payee: {id: payee.id, handle: payee.handle}, amount,
    mandate: {version: mandate.version, expires_at: mandate.expires_at}, room_left: room.room_left, approval_needed: verdict === 'ask_owner',
    cover, record: card.record, card_hash: card.card_hash, checked_at: iso(pilot.now()), took_ms: Math.round(performance.now() - started)};
}
