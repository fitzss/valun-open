// The budget card: what an agent may commit for its owner, the room left, who backs it and its record, so anyone can
// check a payer before taking its IOU. Its owner publishes it (mandate public_card, Pilot.setMandate); until then both
// routes answer 404 card_not_public, but for the payee's own check (fix inbox #87: its own side of the step only).
// Public, no token, under the per-address read budget like every GET:
//   GET /pilot/v1/participants/{vp}/card                               budgetCard
//   GET /pilot/v1/participants/{vp}/check?amount=N&payee=<id|handle>   checkPayer: Pilot.checkMandate as the payer, a dry run
//                                                                      (and as the payee, for the payee's own check)
// The card shows what the server enforces: the mandate as Pilot.effectiveLimits gives it (the owner's mandate, tightened
// by limits the agent recorded), and the room as checkMandate counts it for max_issue_outstanding (Pilot.issueExposure).
// Its backing totals are the face value of the open guarantee caps; a payee's own check counts each backer at its
// grounded worth instead (min_payer_coverage_pct, payee_side).
// The check gives the answer the server enforces at the step it answers for (C8, check equals enforcement): a new deal
// the payer proposes (the default) or the payee proposes (path=), or the offer a payee is deciding on (deal=); the same
// rules, in the same order, as the action that decides it (test/check-oracle.unit.test.mjs runs both on twin worlds).
// Each side is checked as the step finds it: a request of a side's own agent renews a self-serve participant on the
// open network before anything else (Pilot.authenticate, Pilot.renewSandbox), so where that agent acts at the step the
// side is checked renewed (Pilot.renewedView), and what a sandbox agent payer owes a dormant payee counts as it does once
// the payee's agent acts (Pilot.issueExposure views). Where only an owner decides, the side is checked as it is.
// The deal under review's figures are built from what the payee may see (the card's outstanding and the deal itself),
// never from a count that leaves out the payer's counter-offer that only the payer sees: next to room_left such a figure
// would give that counter's price away.
// Read-only: nothing changes beyond what any read does (deals and guarantees swept, calls a repayment made unpayable
// lapsed), and no signed format changes. Amounts are whole numbers in the network's unit (`unit`), under unit-neutral
// names (fix inbox #32): no `_PC` key anywhere.
// The cover a payee holds on the payer's IOUs, and its own limits on the step (payee_side), are the payee's own business:
// the check shows them only when it is sent with the payee's token (agent or owner); otherwise `cover.covered` and
// `cover.for_other_deals` are null, there is no payee_side, and the check is cached as any public read.
// Fix inbox #87: the server goes ahead with the step only when both sides do, so the payee's own check gives one verdict
// for the step, from both sides (`verdict`; each side's own in payer_side and payee_side). Every other answer has the
// payer's side only, and says the payee's own limits were not checked.
import {PilotError, PRICE_CAP, MAX_DELIVERY_MS, OPEN_NETWORK_MAX_OPEN_OFFERS, canonical, sha256} from './core.mjs';
import {NETWORK, PUBLIC_ORIGIN, amt} from './units.mjs';
import {AGENT_HANDLE_RE, agentPageShown, recordOf} from './agents.mjs';
import {PUBLIC_VOUCHES_SHOWN} from './guarantees.mjs';
import {statusClass} from './status.mjs';

export const CARD_VERSION = 1;
export const OBJECTIVE_MAX = 300;
// Who would propose the new deal a check is for (path=): its payer (the default) or its payee; the other side accepts it.
export const CHECK_PATHS = Object.freeze(['payer_proposes', 'payee_proposes']);
const PID_RE = /^vp_[0-9a-f]{12}$/, AMOUNT_RE = /^[1-9][0-9]*$/, DEAL_RE = /^vd_[0-9a-f]{16}$/;
// A time as deal terms and guarantees write it: ISO 8601 in UTC (Date.parse alone also takes free text).
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HOUR = 3600e3;
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
  if (typeof raw !== 'string' || !raw.trim()) throw new PilotError('invalid_field', 'payee is required: the participant id or handle of the agent that would take the note');
  const s = raw.trim().toLowerCase(), all = pilot.s.participants;
  const q = PID_RE.test(s) ? (Object.hasOwn(all, s) ? all[s] : null) : AGENT_HANDLE_RE.test(s) ? Object.values(all).find(x => x.handle === s) ?? null : null;
  if (!q) throw new PilotError('not_found', 'unknown payee: give the participant id or handle of the agent that would take the note', 404);
  if (payer && q.id === payer.id) throw new PilotError('invalid_field', 'payee must be another participant than the payer');
  return q;
}
// `path` (path=): one of CHECK_PATHS, or null when the query does not name one (a new deal is then the payer's proposal).
export function parsePath(raw) {
  if (raw === null || raw === undefined) return null;
  if (!CHECK_PATHS.includes(raw)) throw new PilotError('invalid_field', `path must be ${CHECK_PATHS.join(' or ')}: who would propose the new deal (the other side accepts it)`);
  return raw;
}
// `deliver_by` (deliver_by=): a new deal's deliver_by for the payee's own side, in ms, within the bounds deal terms have
// (Pilot.validateTerms: in the future, at most MAX_DELIVERY_MS ahead); null when the query does not name one.
export function parseDeliverBy(pilot, raw) {
  if (raw === null || raw === undefined) return null;
  const t = typeof raw === 'string' && ISO_UTC_RE.test(raw) ? Date.parse(raw) : NaN, now = pilot.now();
  if (!(Number.isFinite(t) && t > now && t <= now + MAX_DELIVERY_MS))
    throw new PilotError('invalid_field', `deliver_by must be an ISO 8601 time in UTC, like 2026-11-20T18:00:00.000Z, in the future and at most ${MAX_DELIVERY_MS / 864e5} days ahead: the deliver_by the deal would name`);
  return t;
}

// The check's cover (fix inbox #75): the active guarantees of the payer's IOUs to this payee, each with its remaining cap
// and what it could pay for the step the check answers (for_this_deal, GuaranteeBook.stepCover, at face value), and the
// reasons that say so. The guarantees that count are the ones the payee's coverage rule counts for the same step
// (backingFor), by the same predicates: they back the deal (GuaranteeBook.backsDeal: one in the deal mode, fix inbox #29,
// only a deal it names, so only the deal under review, `deal`; a new deal has no id to name), and, when the check knows
// the deal's deliver_by (the deal's own, or the payee's deliverBy for a new deal), they can still be called an hour
// after it (GuaranteeBook.lasts; one that cannot is marked ends_too_soon and counts nothing). One in the floating mode
// counts its remaining cap; the deal-mode guarantees of the deal under review share what it can still claim, oldest
// first (GuaranteeBook.dealRoom: its price less what calls on its deal-mode guarantees claimed). covered sums
// for_this_deal; for_other_deals sums the remaining caps of the deal-mode guarantees that do not name the deal (every
// one, for a new deal). The coverage rule counts each guarantee's for_this_deal too (backingFor runs stepCover, fix
// inbox #79), at its backer's grounded worth and no more than the debt with the deal (payee_side); covered is face
// value. A backer is named only when the guarantee is public under fix inbox #31;
// otherwise backer is null. Its reasons are the payee's: checkPayer gives them in payee_side (fix inbox #87), and the
// cover itself, only with the payer's card.
export function coverFor(pilot, p, payee, {deal = null, deliverBy = null} = {}) {
  const book = pilot.guarantees, id = deal?.id ?? null, price = deal ? pilot.current(deal).terms.price.amount : 0;
  const at = deal ? Date.parse(pilot.current(deal).terms.deliver_by) : deliverBy, debtFrom = Number.isFinite(at) ? at : null;
  const gs = activeBacking(pilot, p, payee.id), shares = gs.length ? book.stepCover(gs, {dealId: id, price, debtFrom}) : new Map();
  const tooSoon = gs.filter(g => book.backsDeal(g, id) && !book.lasts(g, debtFrom)), soon = new Set(tooSoon.map(g => g.id));
  const others = gs.filter(g => !book.backsDeal(g, id));
  const guarantees = gs.map(g => ({guarantee_id: g.id, backer: vouchPublic(pilot, g) ? who(pilot, g.backer) : null, remaining: remainingOf(pilot, g), for_this_deal: shares.get(g.id),
    ...(soon.has(g.id) ? {ends_too_soon: true} : {})}));
  const hidden = new Set(gs.filter((g, i) => !vouchPublic(pilot, g) && guarantees[i].for_this_deal > 0).map(g => g.backer)).size;
  const named = [...new Set(guarantees.filter(g => g.backer?.handle && g.for_this_deal > 0).map(g => `@${g.backer.handle}`))];
  const cover = {covered: sum(guarantees, g => g.for_this_deal), for_other_deals: sum(others, g => remainingOf(pilot, g)), guarantees};
  const left = g => remainingOf(pilot, g) > 0;                       // the reasons speak of guarantees with something left
  return {cover, reasons: coverWords(cover, {deal, by: [...named, ...(hidden ? [hidden === 1 ? 'a backer not named here' : `${hidden} backers not named here`] : [])],
    others: others.filter(left).length, soon: {count: tooSoon.filter(left).length, amount: sum(tooSoon, g => remainingOf(pilot, g)), until: debtFrom}})};
}
// The cover in plain words, for the payee (fix inbox #75): what backs the step for it and by whom (covered), what backs
// only other deals (for_other_deals: a guarantee that names deals never backs a new one), and what ends too soon to count.
// Fix inbox #87: they are among the reasons of the payee's own side (payee_side), not the step's. valun 0.7.0 and 0.7.1
// add "backed for you up to <covered>" to an accept or ask_owner themselves, after the step's reasons; with this text
// there too, their summary said it twice.
function coverWords({covered, for_other_deals: other}, {deal, by, others, soon}) {
  const what = deal ? 'this deal' : 'a new deal', one = (n, a, b) => (n === 1 ? a : b);
  const head = covered > 0 ? `Guaranteed for you up to ${amt(covered)} by ${listed(by)}${other ? `; another ${amt(other)} covers only ${deal ? 'other deals' : 'particular deals, not a new one'}` : ''}.`
    : other > 0 ? `No guarantee covers ${what} for you: ${one(others, 'a guarantee', 'guarantees')} with ${amt(other)} left ${one(others, 'covers', 'cover')} only ${deal ? 'other' : 'particular'} deals.`
      : soon.count ? `No guarantee covers ${what} for you.` : null;
  return [...(head ? [head] : []), ...(soon.count ? [`${one(soon.count, 'A guarantee', 'Guarantees')} with ${amt(soon.amount)} left ${one(soon.count, 'ends', 'end')} too soon to count: one counts for a deal only if it can still be called an hour after the deal's deliver_by (${iso(soon.until)}).`] : [])];
}

// Fix inbox #60: the deal a payee is deciding on. `deal` (deal=vd_...) names a deal the payee can see, between this payer
// and this payee, still in its offer phase (STATUS_CLASS offer_phase: open, waiting for its proposer's owner, or accepted
// and waiting for an owner), at exactly `amount` (its current version's price): the check then leaves that deal out of
// the payer's outstanding and adds `amount`, as accepting it does (Pilot.proposerStillAuthorized, excludeDealId), so an
// offer already counted is not counted twice. A deal that ended, or that is agreed already (it binds: there is nothing
// left to accept), is 409 wrong_state. Answered only to the payee itself (the route checks its token): the deal is the
// payee's business, like its cover.
export function dealUnderReview(pilot, raw, {payer, payee, amount}) {
  if (typeof raw !== 'string' || !DEAL_RE.test(raw)) throw new PilotError('invalid_field', 'deal must be a deal id (vd_ and 16 hex digits): the offer you are deciding on');
  const d = pilot.partyDeal(raw, payee);
  if (d.payer !== payer.id || d.payee !== payee.id) throw new PilotError('invalid_field', `deal ${d.id} is not one where ${payer.handle} pays ${payee.handle}`);
  pilot.sweep(d);
  const cls = statusClass(d.status);
  if (cls?.terminal) throw new PilotError('wrong_state', `deal ${d.id} is ${d.status}: it has ended, so there is nothing to check`, 409);
  if (!cls?.offer_phase) throw new PilotError('wrong_state', `deal ${d.id} is ${d.status}: it is agreed already and binds both of you, so there is no offer left to check`, 409);
  const price = pilot.current(d).terms.price.amount;
  if (price !== amount) throw new PilotError('invalid_field', `amount must be the price of deal ${d.id} as it stands, ${price} (${pilot.unit})`);
  return d;
}

// Fix inbox #60: for the payee's own check without `deal`, the payer's open offers to it that are already counted in the
// payer's outstanding (reserved: the current version is the payer's), so a payee checking an offer it received knows to
// name it with deal=. Newest first.
export function countedOffers(pilot, p, payee) {
  return Object.values(pilot.s.deals).filter(d => d.payer === p.id && d.payee === payee.id && pilot.visibleTo(d, payee)).map(d => pilot.sweep(d))
    .filter(d => statusClass(d.status)?.reserved && pilot.current(d).by === p.id)
    .sort((a, b) => Date.parse(pilot.current(b).created_at ?? 0) - Date.parse(pilot.current(a).created_at ?? 0))
    .map(d => ({deal_id: d.id, amount: pilot.current(d).terms.price.amount}));
}

// A refusal's message without its limit-set label ("mandate: ", "limit recorded by the owner (PUT /limits): "), ending in
// a full stop.
const unlabelled = m => { const t = String(m).replace(/^[^:]*: /, ''); return `${t}${/[.!?]$/.test(t) ? '' : '.'}`; };

// Whether X's own agent acts at the step the check answers: a new deal is proposed by one side's agent and accepted by the
// other's; the offer under review (deal=) is accepted by the side whose version is not the current one (once its
// proposer's owner approves it, when it waits for that owner); an acceptance waiting for an owner moves only by owners'
// decisions, and an owner's request renews nothing (Pilot.authenticate).
const actsAtStep = (pilot, deal, X) => !deal || (deal.status !== 'accepted_awaiting_owner' && pilot.current(deal).by !== X.id);
// X as the step finds it (Pilot.renewedView when its own agent acts there; X itself otherwise).
const atStep = (pilot, deal, X) => (actsAtStep(pilot, deal, X) ? pilot.renewedView(X) : X);
// Whether X's mandate, as the server enforces it (Pilot.effectiveLimits), has ended: its expires_at is past.
const mandateEnded = (pilot, X) => { const t = pilot.effectiveLimits(X).expires_at; return !!t && Date.parse(t) < pilot.now(); };
// Whether the next request of X's own agent renews X's ended mandate (Pilot.renewedView: a self-serve participant on the
// open network whose owner did not set the mandate's expiry earlier than the sandbox end). Its owner cannot renew it: a
// self-serve mandate ends at the sandbox end at the latest.
const renewsOnRequest = (pilot, X) => { const v = pilot.renewedView(X); return v !== X && !mandateEnded(pilot, v); };

// The payer's room under max_issue_outstanding at the step, in figures the payee may see. `outstanding`:
// Pilot.issueExposure with the payee as the step finds it (`views`: what a sandbox agent owes a dormant payee counts once
// the payee's own agent acts, as the server then counts it) and nothing left out, so it counts all the card counts, a
// counter-offer of the payer's own that only the payer sees included; `woken`: what the payee's renewal adds to the card's
// outstanding. For the deal under review (fix inbox #60): `without_deal`, the room with the deal left out, leaves out
// only what the card counts of it for the payer (its price, when the deal is committed or is the payer's own offer), and
// `left_with_deal` is the room once the deal counts, once. Neither comes from excludeDealId, which leaves out the payer's
// private counter-offer on the deal too: next to room_left, that would give the counter's price away.
function stepRoom(pilot, p, ledger, {card, deal, amount, views}) {
  const cap = card.mandate.outstanding_cap, outstanding = pilot.issueExposure(p, ledger, {views}).total;
  const room = {outstanding, room_left: Math.max(0, cap - outstanding), woken: outstanding - card.room.outstanding};
  if (!deal) return room;
  const cls = statusClass(deal.status), counted = !!cls?.committed || (!!cls?.reserved && pilot.current(deal).by === p.id);
  const without = outstanding - (counted ? amount : 0);
  return {...room, without_deal: Math.max(0, cap - without), left_with_deal: Math.max(0, cap - without - amount)};
}

// The refusal in plain words, for the rule checkMandate named (its message otherwise, without the limit-set label).
// `room`: stepRoom's.
function declineReason(pilot, e, {p, payee, amount, mandate, room}) {
  const list = pilot.effectiveLimits(p).counterparties;
  switch (e.extra?.rule) {
    case 'no_agent': return 'It has no active agent key: it cannot commit to anything until its owner connects an agent.';
    case 'payee_no_key': return `${payee.handle} has no active agent key: no deal can name it until its owner connects an agent.`;
    case 'network_limit': return `Over the network's limit: a deal is at most ${amt(PRICE_CAP)}, less than ${amt(amount)}.`;
    case 'too_many_open_offers': return `It is a self-serve agent with as many offers of its own open as it may have at once (${OPEN_NETWORK_MAX_OPEN_OFFERS}): it cannot propose a new deal until one of them is answered, withdrawn or expires. It may still accept an offer you make it (path=payee_proposes).`;
    // Checked as it is only where its agent does not act at the step (atStep); a self-serve mandate its agent's next
    // request renews is not one its owner can renew.
    case 'expires_at': return renewsOnRequest(pilot, p)
      ? `Its mandate ended at ${mandate.expires_at} with its sandbox time: it is a self-serve agent, and the next request its agent sends renews both; until then it cannot commit to anything.`
      : `Its owner's mandate ended at ${mandate.expires_at}: it cannot commit to anything until its owner renews it.`;
    case 'counterparties': return list !== 'any' && !(list || []).includes(payee.id)
      ? `Its owner has not listed ${payee.handle} among the agents it may deal with.`
      : `It is a self-serve sandbox agent: on this server it may deal only with the sandbox agents, not ${payee.handle}.`;
    case 'may_issue_credit': return 'Its owner has not allowed it to pay with notes.';
    case 'max_issue_per_deal': return `Over its limit per deal: ${amt(amount)} is more than the ${amt(mandate.per_deal)} a deal its owner allows.`;
    case 'max_issue_outstanding': return room.without_deal != null
      ? `Over its budget: leaving this deal out it has ${amt(room.without_deal)} of ${amt(mandate.outstanding_cap)} left, less than ${amt(amount)}.`
      : `Over its budget: it has ${amt(room.room_left)} of ${amt(mandate.outstanding_cap)} left, less than ${amt(amount)}.`;
    default: {
      const t = unlabelled(e.message);
      return `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
    }
  }
}

// Whether X's owner (X the payer or the payee of deal d, which is in its offer phase) must still decide before d binds, as
// Pilot.accept, settleAcceptance and decideApproval hold it; `chk` is X's mandate check now (its needsOwner: the price is
// above X's approve_above):
//   open                     X would accept it: needsOwner (the acceptance waits for X's owner). X made the offer:
//                            Pilot.proposerMustConfirm (an offer X's owner approved is not held again);
//   proposed_awaiting_owner  X made it: its owner approves the offer first. X would accept it once offered: needsOwner;
//   accepted_awaiting_owner  X accepted it: its owner's approval of the acceptance is pending. X made the offer: the
//                            confirmation its owner was asked for is pending, or (none asked yet) proposerMustConfirm, as
//                            settleAcceptance asks for it once the acceptor's owner approves.
function ownerDecides(pilot, d, X, chk) {
  const v = pilot.current(d), acc = d.acceptance, own = v.by === X.id;
  if (d.status === 'proposed_awaiting_owner') return own || !!chk.needsOwner;
  if (d.status === 'accepted_awaiting_owner') {
    if (acc?.by === X.id) return !!acc.approval_id && !acc.owner_approval;
    return acc?.proposer_approval_id ? !v.owner_approval : pilot.proposerMustConfirm(v, chk);
  }
  return own ? pilot.proposerMustConfirm(v, chk) : !!chk.needsOwner;
}

// What the step waits for from X's owner, or why it does not wait though X's approve_above would hold it, in plain words
// ([] when there is nothing to say). X is the payer (`you` false: "its owner") or the payee asking (`you`: "your owner");
// `waits` is what ownerDecides (a deal under review) or needsOwner (a new deal) says; `proposing`: a new deal X proposes.
function ownerWords(pilot, X, {deal, chk, waits, you = false, proposing = false}) {
  const a = X.mandate.approve_above ?? 0, Owner = you ? 'Your owner' : 'Its owner', owner = you ? 'your owner' : 'the owner';
  const rule = a > 0 ? `${Owner} approves each commitment above ${amt(a)}` : `${Owner} approves every commitment itself`;
  const binds = `${you ? `your ${proposing ? 'offer' : 'acceptance'}` : 'this one'} waits for ${owner} before it ${you && proposing ? 'is made' : 'binds'}`;
  if (!deal) return waits ? [`${rule}: ${binds}.`] : [];
  const v = pilot.current(deal), acc = deal.acceptance, own = v.by === X.id, offer = you ? 'your offer' : 'this offer';
  const accepted = deal.status === 'accepted_awaiting_owner' && acc?.by === X.id, acceptance = you ? 'your acceptance' : 'its acceptance';
  if (!waits) return !chk?.needsOwner ? [] : own && v.owner_approval ? [`${Owner} approved ${offer} already: nothing waits for ${owner}.`]
    : accepted && acc.owner_approval ? [`${Owner} approved ${acceptance} already: nothing waits for ${owner}.`] : [];
  if (accepted) return [`${acceptance.charAt(0).toUpperCase()}${acceptance.slice(1)} waits for ${owner}'s approval: the deal binds once ${owner} approves.`];
  if (!own) return [`${rule}: ${binds}.`];
  if (deal.status === 'proposed_awaiting_owner') return [`${you ? 'Your' : 'Its'} offer waits for ${owner}'s approval before it is made.`];
  if (acc?.proposer_approval_id) return [`${Owner} is still to confirm ${offer}: the deal binds once ${owner} approves.`];
  return [`${rule}, and has not approved ${offer}: it waits for ${owner} before it binds.`];
}

// For the payee's own check of a new deal without deliver_by: the earliest end among the guarantees its coverage rule
// counts that a deal's deliver_by could leave out (a guarantee counts only if it can still be called an hour after the
// deal's deliver_by, guarantees.mjs backingFor), or null when the answer cannot depend on deliver_by.
function deliverByMatters(pilot, p, payee) {
  if (!(pilot.effectiveLimits(payee).min_payer_coverage_pct > 0)) return null;
  const ends = activeBacking(pilot, p, payee.id).filter(g => pilot.guarantees.backsDeal(g, null) && remainingOf(pilot, g) > 0)
    .map(g => Date.parse(g.terms.expires_at)).filter(t => t < pilot.now() + MAX_DELIVERY_MS + HOUR);
  return ends.length ? Math.min(...ends) : null;
}

// The payee's own limits on the step the check answers (payee_side), for the payee itself only (its token): never
// cached, never shown to anyone else. Pilot.checkMandate as the payee, as the server runs it at that step:
//   - a new deal: for a deal delivered by `deliverBy` (debtFrom: a guarantee counts only if it can still be called an hour
//     after it; without deliverBy every active guarantee counts, as `cover` shows them, and a reason says when that could
//     differ); with path payee_proposes the open-offer limit on the payee's own offers comes first (too_many_open_offers),
//     as when it proposes. ask_owner: its needsOwner holds the payee's offer or acceptance for its owner;
//   - the deal under review: with the deal left out (excludeDealId) and its id and deliver_by (dealId, debtFrom), as
//     accepting it and every owner's decision re-check it; a counter-offer of the payee's own still waiting for its owner
//     refuses its acceptance first (counter_pending, Pilot.accept: until the payee withdraws it or its owner rejects it;
//     approved, it replaces the offer, which can then never be accepted). ask_owner: ownerDecides.
// The payee as the step finds it (atStep): renewed where its own agent acts (it accepts or proposes), as it is where only
// owners decide or the payer's agent acts on the payee's own offer.
// The payee's coverage rule (min_payer_coverage_pct) counts the payer's reserve, its claims at what they are grounded on
// and each backer at its grounded worth (Pilot.groundedFor, fix inbox #20), never the face value the card and `cover`
// show. A payee with no active agent key: decline, rule no_agent. {verdict, rule, reasons}, as for the payer.
// `cover`: the cover's reasons (coverFor), the payee's own, given after its side's verdict and before what its owner does
// and the deliver_by hint (fix inbox #87). Its verdict and rule need nothing of the payer's card; its words show the
// payer's figures, so for a payer whose card is not published checkPayer gives only the verdict and rule
// (unpublishedSide).
async function payeeSideOf(pilot, p, payee, amount, {ledger, deal, step, deliverBy, cover = []}) {
  const side = (verdict, rule, reasons) => ({verdict, rule, reasons});
  if (payee.status !== 'active' || !payee.pubkey) return side('decline', 'no_agent', ['You have no active agent key: you cannot accept or offer anything until your owner connects an agent.', ...cover]);
  if (deal?.status === 'open' && pilot.current(deal).by === p.id && deal.pending_counter?.by === payee.id)
    return side('decline', 'counter_pending', ['Your own counter-offer on this deal waits for your owner: you cannot accept this offer while it does. Withdraw it, or wait for your owner to reject it; if your owner approves it, your counter-offer replaces this offer.', ...cover]);
  if (step === 'payee_proposes' && pilot.atOpenOfferLimit(payee))
    return side('decline', 'too_many_open_offers', [`You are a self-serve agent with as many offers of your own open as you may have at once (${OPEN_NETWORK_MAX_OPEN_OFFERS}): you cannot propose a new deal until one of them is answered, withdrawn or expires.`, ...cover]);
  const ends = !deal && deliverBy === null ? deliverByMatters(pilot, p, payee) : null;
  const hint = ends === null ? [] : [`A guarantee counts here only if it can still be called an hour after the deal's deliver_by, and one this counts ends ${iso(ends)}: give deliver_by= (the deal's) for the exact answer, or check the offer with deal= once you have it.`];
  const Q = atStep(pilot, deal, payee), until = pilot.effectiveLimits(payee).expires_at;
  let chk;
  try {
    chk = await pilot.checkMandate(Q, 'payee', p.id, amount, {ledger,
      ...(deal ? {excludeDealId: deal.id, dealId: deal.id, debtFrom: Date.parse(pilot.current(deal).terms.deliver_by)} : deliverBy !== null ? {debtFrom: deliverBy} : {})});
  } catch (e) {
    if (e?.code !== 'mandate_exceeded') throw e;
    // An ended self-serve mandate where the payee's agent does not act at the step: its next request renews it.
    if (e.extra?.rule === 'expires_at' && renewsOnRequest(pilot, payee))
      return side('decline', 'expires_at', [`Your own limits refuse it (expires_at): your mandate ended at ${until} with your sandbox time, and your agent does not act at this step. You are a self-serve agent: any request your agent sends renews both (a check sent with your agent's token does too).`, ...cover, ...hint]);
    return side('decline', e.extra?.rule ?? null, [`Your own limits refuse it (${e.extra?.rule}): ${unlabelled(e.message)}`, ...cover, ...hint]);
  }
  const waits = deal ? ownerDecides(pilot, deal, payee, chk) : !!chk.needsOwner;
  const cov = chk.checks.find(c => c.rule === 'min_payer_coverage_pct');
  return side(waits ? 'ask_owner' : 'accept', waits ? 'approve_above' : null, ['Your own limits allow it.',
    ...(Q !== payee && mandateEnded(pilot, payee) ? [`Your mandate ended at ${until} with your sandbox time, and your agent's own request at this step renews both.`] : []),
    ...(cov ? [`${p.handle}'s notes to you would be covered ${cov.coverage_pct}%, and your owner requires ${cov.limit}%${pilot.circulating ? ' (its claims and each backer counted at their grounded worth)' : ''}.`] : []),
    ...cover, ...ownerWords(pilot, payee, {deal, chk, waits, you: true, proposing: step === 'payee_proposes'}), ...hint]);
}

// The refusals of the deal's terms (Pilot.validateTerms: no terms name a party without an active agent key, nor a price
// above the network's limit). They come before either side's mandate: no deal can be made at all.
const TERMS_RULES = new Set(['no_agent', 'payee_no_key', 'network_limit']);
// Fix inbox #87: what an answer without the payee's own side says of it (the public answer, and one for another payee).
export const PAYEE_NOT_CHECKED = "The payee's own limits were not checked: the server enforces them too, and only a check sent with the payee's own token (agent or owner) answers for them (payee_side).";
// Fix inbox #87: why the payer's side is not checked, for the payee's own check of a payer whose owner has not published
// its card.
export const PAYER_NOT_PUBLISHED = 'Its owner has not published its budget card, so its own limits cannot be checked here (the server still enforces them): decide from its public record, or ask your owner.';
// The answer's cover when it is not shown: null is "not shown", never 0.
const coverNotShown = () => ({covered: null, for_other_deals: null, guarantees: []});
// Fix inbox #87 (review): the payee's own side of the step for a payer whose owner has not published its card: its
// verdict and rule, in words that give no figure. The payer chose not to publish its room, and what the payee's own limits
// count of it (its committed deals, the coverage they leave it, payer_committed and the like) would show it; so would
// the cover and the record beside them, which the answer leaves out too. The refusals that read nothing of the payer (no
// active agent key, the payee's own counter-offer, its open-offer limit) keep their words; the coverage bar named is the
// payee's own owner's. A payee still learns, as by proposing, whether the payer's figures pass its bar at this amount.
const READS_NO_PAYER = new Set(['no_agent', 'counter_pending', 'too_many_open_offers']);
function unpublishedSide(pilot, payee, {verdict, rule, reasons}) {
  const words = verdict === 'accept' ? 'Your own limits allow it.'
    : verdict === 'ask_owner' ? 'Your own limits allow it once your owner approves.'
      : READS_NO_PAYER.has(rule) ? reasons[0]
        : rule === 'min_payer_coverage_pct' ? `Your owner's coverage bar (min_payer_coverage_pct, ${pilot.effectiveLimits(payee).min_payer_coverage_pct}%) refuses this payer's note for this amount; it has published no budget card, so its own figures are not shown.`
          : `Your own limits refuse it (${rule}); this payer has published no budget card, so the check shows no figures.`;
  return {verdict, rule, reasons: [words]};
}

// The payer's side of the step (payer_side): would the payer's agent be allowed to commit `amount` to `payee` now?
// Pilot.checkMandate as the payer, a dry run over the same tracker read as the card's numbers (`card`), at the step the
// server would decide it:
//   decline    the step is refused: `rule` is checkMandate's rule (mandate_exceeded), or one of the refusals that come
//              before the mandate, in the order the server gives them: the payer has no active agent key (no_agent: it
//              cannot sign anything), the payee has none (payee_no_key: no terms can name it, Pilot.validateTerms), the
//              amount is above the network's PRICE_CAP (network_limit), and, when the payer proposes, a self-serve payer
//              on the open network already has as many offers of its own open as it may (too_many_open_offers,
//              Pilot.atOpenOfferLimit);
//   ask_owner  it passes, and the commitment waits for the payer's owner before it binds; `rule` is approve_above;
//   accept     it passes and nothing waits for the payer's owner; `rule` is null.
// The step (`step`: payer_proposes, payee_proposes, or deal):
//   - a new deal (no `deal`), as `path` says: payer_proposes (the default: Pilot.propose by the payer, ask_owner when its
//     needsOwner holds the offer for its owner) or payee_proposes (the payee proposes and the payer accepts, Pilot.accept:
//     the open-offer limit does not apply, ask_owner when its needsOwner holds the acceptance);
//   - fix inbox #60: the deal under review (`deal`, as dealUnderReview returns it, only when the payee itself asks):
//     accepting it, or the owners' decisions its acceptance waits for, as Pilot.accept and Pilot.decideApproval re-check
//     it: checkMandate with the deal left out of the payer's outstanding (excludeDealId) and `amount` added, and
//     ask_owner only when the payer's owner still has to decide (ownerDecides: an offer its owner approved is not held
//     again). The answer names it (deal_id); room_left stays the card's. A counter-offer of the payer's own on the deal,
//     waiting for its owner, is the payer's alone (Pilot.view): the verdict is for the deal once it is withdrawn or
//     rejected, as it must be before the payer can accept, and the figures in the reasons count it as the card does
//     (stepRoom), so they show nothing the card does not. One bit is left: an accept whose figures say the deal does not
//     fit tells the payee that such a counter-offer stands.
// Each side as the step finds it (atStep): the payer renewed where its own agent acts (it proposes, or accepts), the
// payee likewise, and the payer's outstanding counts what it owes the payee as the payee's renewal leaves it (views).
// Returns the side ({verdict, rule, reasons}), the payer as the step finds it (P) and the room (stepRoom), for stepOrder.
async function payerSideOf(pilot, p, payee, amount, {ledger, card, deal, step}) {
  const {mandate} = card;
  const P = atStep(pilot, deal, p), views = new Map([[payee.id, atStep(pilot, deal, payee)]]);
  const room = stepRoom(pilot, p, ledger, {card, deal, amount, views});
  let refusal = null, chk = null;
  const refuse = rule => new PilotError('mandate_exceeded', rule, 403, {rule});
  if (p.status !== 'active' || !p.pubkey) refusal = refuse('no_agent');
  else if (payee.status !== 'active' || !payee.pubkey) refusal = refuse('payee_no_key');
  else if (amount > PRICE_CAP) refusal = refuse('network_limit');
  else if (step === 'payer_proposes' && pilot.atOpenOfferLimit(p)) refusal = refuse('too_many_open_offers');
  else {
    try { chk = await pilot.checkMandate(P, 'payer', payee.id, amount, {ledger, views, ...(deal ? {excludeDealId: deal.id} : {})}); }
    catch (e) { if (e?.code !== 'mandate_exceeded') throw e; refusal = e; }
  }
  const needsOwner = !refusal && (deal ? ownerDecides(pilot, deal, p, chk) : !!chk.needsOwner);
  // What the payee's renewal at the step adds to the card's outstanding, when the room is what decides.
  const woken = room.woken > 0 && (!refusal || refusal.extra?.rule === 'max_issue_outstanding')
    ? [`What it owes ${payee.handle} on the tracker (${amt(room.woken)}) counts here, though its card leaves it out: ${payee.handle}'s sandbox time has ended (what a sandbox agent owes a participant whose time has ended does not count against its limit), and ${payee.handle}'s own agent acts at this step, which renews it.`] : [];
  const reasons = refusal ? [declineReason(pilot, refusal, {p, payee, amount, mandate, room}), ...woken] : [
    deal ? `Within its budget: up to ${amt(mandate.per_deal)} a deal; deal ${deal.id} is counted once, and ${amt(room.left_with_deal)} of ${amt(mandate.outstanding_cap)} is left with it.`
      : `Within its budget: up to ${amt(mandate.per_deal)} a deal, ${amt(room.room_left)} of ${amt(mandate.outstanding_cap)} left.`,
    ...woken,
    ...(P !== p && mandateEnded(pilot, p) ? [`Its mandate ended at ${mandate.expires_at} with its sandbox time: it is a self-serve agent, and its agent's own request at this step renews both.`] : []),
    ...ownerWords(pilot, p, {deal, chk, waits: needsOwner})];
  const verdict = refusal ? 'decline' : needsOwner ? 'ask_owner' : 'accept';
  return {side: {verdict, rule: refusal ? refusal.extra?.rule ?? null : needsOwner ? 'approve_above' : null, reasons}, P, room};
}

// Fix inbox #87: the order in which the step checks the two sides, so the step's refusal is the first one it meets:
//   - a new deal the payer proposes: the payer at its proposal (Pilot.propose), then the payee at its acceptance, then
//     the payer again (Pilot.accept re-checks the proposer, proposerStillAuthorized). `late`: the payer's refusal comes
//     only at that re-check (what it owes a dormant payee counts once the payee's agent acts), so the payee's comes first;
//   - a new deal the payee proposes: the payee, then the payer;
//   - the offer under review: an open offer is accepted by the side whose version is not the current one, which is
//     checked first, then the proposer is re-checked; an offer waiting for its proposer's owner (only the payee sees one:
//     its own) is the proposer's first, then the other side accepts it; an acceptance waiting for owners is decided by
//     the acceptor's owner first while its approval is pending, else by the proposer's (its confirmation), and
//     Pilot.decideApproval checks its own side before the other.
function stepOrder(pilot, deal, p, step, {late = false} = {}) {
  if (!deal) return step === 'payee_proposes' || late ? ['payee', 'payer'] : ['payer', 'payee'];
  const v = pilot.current(deal), acc = deal.acceptance, sideOf = id => (id === p.id ? 'payer' : 'payee');
  const first = deal.status === 'open' ? (v.by === p.id ? 'payee' : 'payer')
    : deal.status === 'accepted_awaiting_owner' && acc?.approval_id && !acc.owner_approval ? sideOf(acc.by) : sideOf(v.by);
  return first === 'payer' ? ['payer', 'payee'] : ['payee', 'payer'];
}

// Fix inbox #87: the step's one verdict from its two sides (P the payer's, Q the payee's), as the server enforces it: it
// goes ahead only when both do. decline when either side declines (`rule`: the first refusal in the step's `order`; a
// refusal of the terms before either side's); else unknown when the payer's side was not checked (its card is not
// published); else ask_owner when an owner on either side decides before it binds (rule approve_above); else accept.
function combined(P, Q, order) {
  if (P.verdict === 'decline' || Q.verdict === 'decline') {
    const first = P.verdict === 'decline' && TERMS_RULES.has(P.rule) ? P : order.map(s => (s === 'payer' ? P : Q)).find(x => x.verdict === 'decline');
    return {verdict: 'decline', rule: first.rule};
  }
  if (P.verdict === 'unknown') return {verdict: 'unknown', rule: null};
  return P.verdict === 'ask_owner' || Q.verdict === 'ask_owner' ? {verdict: 'ask_owner', rule: 'approve_above'} : {verdict: 'accept', rule: null};
}

// Fix inbox #87: the step's verdict in a few words, the first of its reasons: each side's verdict (its side, the payer's;
// your side, the payee's), the one whose verdict is the step's first. Each side's own reasons stay with that side
// (payer_side, payee_side), so a client that shows them too repeats nothing, but for one case: valun 0.7.0 and 0.7.1 add
// the payee side's reasons to a summary when that side is decline or ask_owner, and their own "backed for you up to
// <covered>" to an accept or ask_owner, so when the payee's own owner decides they name the cover twice (0.7.2 drops its
// own).
function bothSides(P, Q, verdict) {
  if (P.verdict === 'decline' && TERMS_RULES.has(P.rule)) return `No deal can be made (${P.rule}): the server refuses its terms before it checks either side's limits.`;
  if (P.verdict === Q.verdict) {
    if (P.verdict === 'accept') return 'Both sides allow it.';
    if (P.verdict === 'ask_owner') return 'Both sides allow it once their owners approve.';
    if (P.verdict === 'decline') return `Both sides refuse it: its side (${P.rule}) and yours (${Q.rule}).`;
  }
  const said = (x, whose) => (x.verdict === 'decline' ? `refuses it (${x.rule})` : x.verdict === 'ask_owner' ? `allows it once ${whose} owner approves`
    : x.verdict === 'unknown' ? 'was not checked' : 'allows it');
  const its = `its side ${said(P, 'its')}`, yours = `your side ${said(Q, 'your')}`, [a, b] = P.verdict === verdict ? [its, yours] : [yours, its];
  return `${a.charAt(0).toUpperCase()}${a.slice(1)}; ${b}.`;
}

// For the payee's own check of a new deal: the payer's open offers to it that its outstanding counts (countedOffers).
const countedWords = counted => (counted.length ? [`Its open ${counted.length === 1 ? 'offer' : 'offers'} to you (${counted.map(o => `${o.deal_id}: ${amt(o.amount)}`).join(', ')}) ${counted.length === 1 ? 'is' : 'are'} already counted in its outstanding: this answer is for a new deal on top. To check an offer you received, ask again with deal=<its id>.`] : []);

// GET /participants/{vp}/check. `amount` and `payee` as parseAmount and findPayee return them; `path` and `deliverBy` as
// parsePath and parseDeliverBy return them (null: not given; `path` is echoed only when given).
// Every answer has the payer's side (payer_side: payerSideOf's {verdict, rule, reasons}). `showCover` only when the
// payee itself asks (its token): the answer then also has its cover, its own side of the step (payee_side: payeeSideOf,
// the cover's reasons among its own), and, without `deal`, the payer's open offers to it that its outstanding already
// counts (counted_offers), so a payee checking one of them can name it. Its verdict is the step's (fix inbox #87), from
// both sides, as the server enforces them (combined, in the step's order, stepOrder):
//   decline    either side declines; `rule` is the first refusal the step meets;
//   ask_owner  neither declines, and an owner on either side decides before it binds (rule approve_above);
//   accept     both sides go ahead (rule null);
//   unknown    the payer's side was not checked (its owner has not published its card), and the payee's side does not
//              decline (rule null).
// Its reasons: both sides in a few words (bothSides), the payer's side's reasons, the counted offers'. A payer whose card
// is not published is answered only to the payee itself (404 card_not_public otherwise), with no figure of the payer's:
// its side is unknown (payer_side null, a reason saying why), mandate, room_left, card_hash and record are null, the
// cover is not shown, there are no counted offers, and payee_side is its verdict and rule in figure-free words
// (unpublishedSide).
// Without `showCover` the answer is the payer's side, the same for everyone: its verdict, rule and reasons, and a reason
// saying the payee's own limits were not checked (PAYEE_NOT_CHECKED). approval_needed: the verdict is ask_owner.
export async function checkPayer(pilot, p, {amount, payee, showCover = false, deal = null, path = null, deliverBy = null}) {
  const started = performance.now();
  if (!showCover) assertCardPublic(p);
  if (deal && (path !== null || deliverBy !== null)) throw new PilotError('invalid_field', 'path and deliver_by are for a new deal: the deal named with deal= has its own proposer and deliver_by');
  const ledger = await pilot.ledger();
  const step = deal ? 'deal' : path ?? 'payer_proposes';
  const card = cardPublic(p) ? await budgetCard(pilot, p, {ledger}) : null;
  const payer = card ? await payerSideOf(pilot, p, payee, amount, {ledger, card, deal, step}) : null;
  const P = payer?.side ?? {verdict: 'unknown', rule: null, reasons: [PAYER_NOT_PUBLISHED]};
  // The payee's own figures are shown with the payer's card only (fix inbox #87 review: without it they would show the
  // payer's private room).
  const figures = showCover && !!card;
  const {cover, reasons: coverReasons} = figures ? coverFor(pilot, p, payee, {deal, deliverBy}) : {cover: coverNotShown(), reasons: []};
  const counted = figures && !deal ? countedOffers(pilot, p, payee) : [];
  const own = showCover ? await payeeSideOf(pilot, p, payee, amount, {ledger, deal, step, deliverBy, cover: coverReasons}) : null;
  const Q = own && (card ? own : unpublishedSide(pilot, payee, own));
  let top = {verdict: P.verdict, rule: P.rule, reasons: [...P.reasons, PAYEE_NOT_CHECKED]};
  if (Q) {
    // Both sides refuse a new deal the payer proposes: the payer's refusal may come only at its re-check, once the
    // payee's agent accepts, when what it owes a dormant payee counts (room.woken). Its proposal, checked as the payee is
    // before its agent acts (no views), says which comes first.
    const late = step === 'payer_proposes' && P.verdict === 'decline' && Q.verdict === 'decline' && P.rule === 'max_issue_outstanding' && payer.room.woken > 0
      && await pilot.checkMandate(payer.P, 'payer', payee.id, amount, {ledger}).then(() => true, e => { if (e?.code !== 'mandate_exceeded') throw e; return false; });
    const both = combined(P, Q, stepOrder(pilot, deal, p, step, {late}));
    top = {...both, reasons: [bothSides(P, Q, both.verdict), ...P.reasons, ...countedWords(counted)]};
  }
  return {verdict: top.verdict, reasons: top.reasons, rule: top.rule,
    payer: {id: p.id, handle: p.handle}, payee: {id: payee.id, handle: payee.handle}, amount,
    mandate: card ? {version: card.mandate.version, expires_at: card.mandate.expires_at} : null, room_left: card ? card.room.room_left : null,
    approval_needed: top.verdict === 'ask_owner', cover, record: card ? card.record : null,
    card_hash: card ? card.card_hash : null, checked_at: iso(pilot.now()), took_ms: Math.round(performance.now() - started),
    ...(deal ? {deal_id: deal.id} : {}), ...(counted.length ? {counted_offers: counted} : {}), ...(path !== null ? {path} : {}),
    payer_side: card ? P : null, ...(Q ? {payee_side: Q} : {})};
}
