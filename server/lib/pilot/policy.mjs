// Phase-2 credit policies and the aggregate credit history (design §8, spec 18.13, OPEN-QUESTIONS OQ-26 and OQ-47):
// circulation modes sandbox and on only. With circulation off (and in mode bound) nothing here runs, so the server
// answers as v15 does.
//
// Owner mandate fields (Pilot.setMandate stores them only in modes sandbox and on; a mandate that does not hold one has
// its default, so an owner who sets none of them sees every output as before):
//   max_claims_total         null (no cap) or 0..100000: what the participant may hold and be owed on all issuers
//                            together (tracker claims + committed deals as payee + transfers to it still collecting or
//                            being applied + the amount). Sandbox joiners: 40 (SANDBOX_MAX_CLAIMS_TOTAL, the box).
//   max_issuer_net_debt      null (off) or 0..100000: the most net debt, after a one-level haircut of its claims, the
//                            issuer of a note the participant would hold may have (haircutNetDebt).
//   accept_operator_issuers  true (default) or false: false refuses notes of participants whose keys the operator holds
//                            (the sandbox agents, Pilot.serverRun).
//
// creditCheck runs the rules in their order wherever a participant would come to hold a claim on an issuer: at an
// agreement as payee (from Pilot.checkMandate, after its own checks) and when it is paid by transfer (from
// Pilot.receivingTransferCheck). creditHistory and publicCreditPolicy are what GET /participants/{id} publishes
// (public_position.credit_history, public_position.credit_policy). The agent limit kinds (Pilot.setAgentLimits,
// Pilot.effectiveLimits) are here too: an agent can only tighten a field, never widen it.
import {edgeKey} from './journal.mjs';
import {pc, amt} from './units.mjs';

export const SANDBOX_MAX_CLAIMS_TOTAL = pc(40);
export const PHASE2_FIELDS = Object.freeze(['max_claims_total', 'max_issuer_net_debt', 'accept_operator_issuers']);
const PHASE2_DEFAULTS = Object.freeze({max_claims_total: null, max_issuer_net_debt: null, accept_operator_issuers: true});
// The rules creditCheck runs, in their order (the first that fails refuses).
export const CREDIT_RULES = Object.freeze(['refuse_notes_from', 'accept_notes_from', 'accept_operator_issuers', 'max_accept_per_issuer', 'max_claims_total', 'max_issuer_net_debt']);
// What public_position.credit_policy shows: the predicates on the issuer of a note the participant would accept (so a payer
// can choose a note its payee takes without asking first). The caps on its own exposure (max_accept_per_issuer,
// max_claims_total, min_payer_coverage_pct) and its counterparties stay private.
export const PUBLIC_POLICY_FIELDS = Object.freeze(['accept_transfers', 'accept_notes_from', 'refuse_notes_from', 'accept_operator_issuers', 'max_issuer_net_debt']);

// The value a phase-2 field has when the mandate does not hold it: null, null and true; a self-serve sandbox
// participant's max_claims_total is the box's 40 (one who joined before the field existed included).
export function phase2Default(p, k) { return k === 'max_claims_total' && p?.sandbox_only ? SANDBOX_MAX_CLAIMS_TOTAL : PHASE2_DEFAULTS[k]; }
// Field k of `limits` (a mandate, or Pilot.effectiveLimits) for participant p; a phase-2 field it does not hold has its
// default.
export function policyValue(p, limits, k) {
  if (limits?.[k] !== undefined) return limits[k];
  return PHASE2_FIELDS.includes(k) ? phase2Default(p, k) : undefined;
}
// The phase-2 fields `mandate` does not hold whose default for p is not the plain one, with that value: a self-serve
// sandbox participant's max_claims_total, the box's 40, when its mandate predates the field. It is enforced (creditCheck),
// so /me and /owner show it in credit_policy and effective_limits (circulation modes sandbox and on) before a refusal
// names it. Every other participant: {} (an owner who sets none of the fields sees every output as before).
export function impliedPhase2(p, mandate) {
  const out = {};
  for (const k of PHASE2_FIELDS) if (mandate?.[k] === undefined && phase2Default(p, k) !== PHASE2_DEFAULTS[k]) out[k] = phase2Default(p, k);
  return out;
}

// ---------- agent limits: the kinds of field, and what "only tighter" means for each ----------
//   cap       a whole number at most the owner's; the lower applies
//   floor     a whole number at least the owner's; the higher applies
//   ncap      a whole number (an owner's null is no cap); at most the owner's when the owner has one; the lower applies
//   allow     a list of participant ids, a subset of the owner's ('any': everyone); the intersection applies
//   deny      a list of participant ids, a superset of the owner's; the union applies
//   off_only  the field's off value (false; 'never' for pay_with_held_notes), or the owner's own value; off applies
export const offValue = k => (k === 'pay_with_held_notes' ? 'never' : false);
// The value that applies: the stricter of the owner's (`owner`, its default when absent) and the agent's.
export function strictestLimit(kind, k, owner, agent) {
  switch (kind) {
    case 'cap': return Math.min(owner, agent);
    case 'floor': return Math.max(owner || 0, agent);
    case 'ncap': return owner === null || owner === undefined ? agent : Math.min(owner, agent);
    case 'allow': return owner === 'any' ? agent : agent === 'any' ? owner : (Array.isArray(owner) ? agent.filter(id => owner.includes(id)) : []);
    case 'deny': return [...new Set([...(Array.isArray(owner) ? owner : []), ...agent])];
    case 'off_only': return agent === offValue(k) ? agent : owner;
    default: throw new TypeError(`policy: unknown agent limit kind ${JSON.stringify(kind)}`);
  }
}
// Whether an agent's value (already of the right type) would be wider than the owner's: null when it is not, else
// {code: 'above_owner_mandate' (more than a ceiling allows) | 'below_owner_mandate' (less than a floor requires), message}.
// A cap or floor keeps its own check in Pilot.setAgentLimits (as v15 words it).
export function agentLimitWidens(kind, k, owner, agent) {
  const above = message => ({code: 'above_owner_mandate', message}), below = message => ({code: 'below_owner_mandate', message});
  if (kind === 'ncap') return owner !== null && owner !== undefined && agent > owner ? above(`${k} ${agent} is above the owner's ceiling of ${owner}; only the owner can raise that`) : null;
  if (kind === 'allow') {
    if (owner === 'any') return null;
    const outside = agent.filter(id => !(Array.isArray(owner) && owner.includes(id)));
    return outside.length ? above(`${k} may only narrow the owner's list: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not on it; only the owner can add to it`) : null;
  }
  if (kind === 'deny') {
    const missing = (Array.isArray(owner) ? owner : []).filter(id => !agent.includes(id));
    return missing.length ? below(`${k} may only add to the owner's list: it must keep ${missing.join(', ')}; only the owner can remove from it`) : null;
  }
  if (kind === 'off_only') return agent === offValue(k) || agent === owner ? null : above(`${k} can only be turned off (${JSON.stringify(offValue(k))}) by an agent limit; only the owner can turn it on`);
  return null;
}

// ---------- the one-level haircut (spec 18.13; OPEN-QUESTIONS OQ-26) ----------
// X's net debt, counting each of its claims at no more than its issuer's own coverage: for issuer I,
// q(I) = 1 if owes(I) = 0, else min(1, claims(I) / owes(I)); adj_claims(X) = sum over I of held(X on I) * q(I);
// net_debt(X) = max(0, owes(X) + committed + delta - adj_claims(X)). `issuers`: [{held, claims, owes}], X's claims on I
// and I's own claims and debts. Exact (BigInt fractions {num, den}), so a limit is never passed or missed by rounding.
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
export function haircutNetDebt({owes, committed = 0, delta = 0, issuers = []}) {
  let num = 0n, den = 1n;
  for (const {held, claims, owes: o} of issuers) {
    if (!(held > 0)) continue;
    const full = !(o > 0) || claims >= o;
    const qn = BigInt(full ? 1 : Math.max(0, claims)), qd = BigInt(full ? 1 : o);
    num = num * qd + BigInt(held) * qn * den; den *= qd;
    const g = gcd(num, den);
    if (g > 1n) { num /= g; den /= g; }
  }
  const net = BigInt(owes + committed + delta) * den - num;
  return {adjusted: {num, den}, net: {num: net > 0n ? net : 0n, den}};
}
// Whether the exact value x ({num, den}) is above the whole number `limit`.
export const exceeds = (x, limit) => x.num > BigInt(limit) * x.den;
// x in PC, to the cent: rounded down ('down') or up ('up'). Shown only; the rules use the exact value.
export function cents(x, dir) {
  const n = x.num * 100n, q = n / x.den;
  return Number(dir === 'up' && n % x.den !== 0n ? q + 1n : q) / 100;
}

// The haircut's figures for issuer X from the ledger (Pilot.ledger rows): every tracker edge counts for what a participant
// owes, but only edges that reconcile (the tracker's total is the one Valun's edge journal expects: the reconciliation
// status `match`) count for claims, so a note issued around Valun can never raise a coverage. committed: X's committed
// deals as payer (excluding `excludeDealId`, whose amount comes in as delta).
export function issuerNetDebt(pilot, X, ledger, {excludeDealId = null, delta = 0} = {}) {
  const edges = pilot.s.edges || {}, owes = new Map(), claims = new Map(), held = new Map();
  const add = (m, id, v) => m.set(id, (m.get(id) ?? 0) + v);
  for (const l of ledger) {
    if (l.issuer) add(owes, l.issuer, l.outstanding);
    if (!l.recipient || l.total !== (edges[edgeKey(l.issuer_pubkey, l.recipient_pubkey)]?.expected_total ?? 0)) continue;
    add(claims, l.recipient, l.outstanding);
    if (l.recipient === X.id && l.issuer && l.issuer !== X.id) add(held, l.issuer, l.outstanding);
  }
  const committed = pilot.exposure(X, ledger, {asRole: 'payer', excludeDealId}).committed, own = owes.get(X.id) ?? 0;
  const r = haircutNetDebt({owes: own, committed, delta, issuers: [...held].map(([I, h]) => ({held: h, claims: claims.get(I) ?? 0, owes: owes.get(I) ?? 0}))});
  return {owes: own, committed, delta, ...r};
}

// ---------- the credit rules ----------
// C (the participant who would hold the claim) and X (the issuer: the payer of the deal at an agreement, the note's issuer
// in a payment by transfer), `amount` PC. `via`: 'agreement' or 'transfer'. Rules, in order (the first failure refuses):
//   (a) refuse_notes_from: X is not on it;
//   (b) accept_notes_from (transfers only; at an agreement `counterparties` says whom C deals with): 'any', or X is on it;
//   (c) accept_operator_issuers: when false, X is not a participant whose keys the operator holds;
//   (d) max_accept_per_issuer (transfers): C's claim on X on the tracker + committed deals with payer X + transfers from X
//       to C still collecting or being applied + amount. At an agreement this is Pilot.checkMandate's own
//       max_accept_per_issuer check, with the same figures, which has run already: it is not repeated here;
//   (e) max_claims_total (null: no cap): C's claims on the tracker on every issuer + its committed deals as payee (the deal
//       being paid or agreed excluded) + transfers to it still collecting or being applied + amount;
//   (f) max_issuer_net_debt (null: off): X's net debt after the haircut, with delta = amount at an agreement and 0 for a
//       transfer (X's total debt does not change).
// A rule adds an entry to `checks` only when it is set (a value other than its default), so the mandate_check of an owner
// who sets none of them is as before. Returns {ok: true, checks} or {ok: false, rule, detail, source, checks}; `source`
// is who set the value that refused (owner_mandate or agent_limits, Pilot.limitSource).
export async function creditCheck(pilot, C, X, amount, {via, ledger = null, excludeDealId = null, excludeTransferId = null} = {}) {
  if (via !== 'agreement' && via !== 'transfer') throw new TypeError(`policy: via must be 'agreement' or 'transfer', not ${JSON.stringify(via)}`);
  const m = pilot.effectiveLimits(C), v = k => policyValue(C, m, k), checks = [];
  const fail = (rule, detail) => ({ok: false, rule, detail, source: pilot.limitSource(C, rule, {issuer: X.id}), checks});
  // (a)
  const refused = v('refuse_notes_from');
  if (Array.isArray(refused) && refused.length) {
    if (refused.includes(X.id)) return fail('refuse_notes_from', `${X.handle} is on refuse_notes_from: this agent takes no claim on it`);
    checks.push({rule: 'refuse_notes_from', issuer_listed: false});
  }
  // (b)
  if (via === 'transfer') {
    const accepted = v('accept_notes_from');
    if (!(accepted === 'any' || (Array.isArray(accepted) && accepted.includes(X.id)))) return fail('accept_notes_from', `${X.handle} is not on accept_notes_from`);
    checks.push({rule: 'accept_notes_from', issuer_listed: accepted !== 'any', any: accepted === 'any'});
  }
  // (c)
  if (v('accept_operator_issuers') === false) {
    if (pilot.serverRun(X)) return fail('accept_operator_issuers', `${X.handle} is run by the Valun operator, which holds its keys, and accept_operator_issuers is off: this agent takes no claim on a participant the operator runs`);
    checks.push({rule: 'accept_operator_issuers', issuer_operator_run: false, limit: false});
  }
  ledger ??= await pilot.ledger();
  // (d)
  if (via === 'transfer') {
    const e = pilot.exposure(C, ledger, {asRole: 'payee', counterpartyId: X.id, excludeTransferId}), limit = m.max_accept_per_issuer;
    if (e.total + amount > limit) return fail('max_accept_per_issuer', `${amount} more from ${X.handle} would bring this agent's claims on it to ${e.total + amount}, above max_accept_per_issuer ${limit}`);
    checks.push({rule: 'max_accept_per_issuer', claim_on_tracker: e.tracker, committed: e.committed, reserved: e.reserved, ...(e.pending_in ? {pending_in: e.pending_in} : {}), this_deal: amount, limit});
  }
  // (e)
  const cap = v('max_claims_total');
  if (cap !== null && cap !== undefined) {
    const h = pilot.claimsHeld(C, ledger, {excludeDealId, excludeTransferId}), total = h.total + amount;
    // Guarantees it accepted count as `guaranteed` (fix inbox #18: what it may come to hold on their backers).
    if (total > cap) return fail('max_claims_total', `${amount} more would bring this agent's claims on all issuers to ${total} (on the tracker ${h.tracker}, agreed and not paid ${h.committed}, being transferred to it ${h.pending_in}${h.guaranteed ? `, guarantees it accepted ${h.guaranteed}` : ''}), above max_claims_total ${cap}`);
    checks.push({rule: 'max_claims_total', claims_on_tracker: h.tracker, committed: h.committed, pending_in: h.pending_in, ...(h.guaranteed ? {guaranteed: h.guaranteed} : {}), this_deal: amount, limit: cap});
  }
  // (f)
  const netLimit = v('max_issuer_net_debt');
  if (netLimit !== null && netLimit !== undefined) {
    const f = issuerNetDebt(pilot, X, ledger, {excludeDealId, delta: via === 'agreement' ? amount : 0});
    const entry = {rule: 'max_issuer_net_debt', issuer_owes_on_tracker: f.owes, issuer_committed: f.committed, this_deal: f.delta,
      issuer_adjusted_claims: cents(f.adjusted, 'down'), issuer_net_debt: cents(f.net, 'up'), limit: netLimit};
    if (exceeds(f.net, netLimit)) return fail('max_issuer_net_debt', `${X.handle}'s net debt would be ${amt(entry.issuer_net_debt)} (it owes ${f.owes} on the tracker and ${f.committed} agreed${f.delta ? `, ${f.delta} more with this deal` : ''}; its claims count for ${amt(entry.issuer_adjusted_claims)} after the one-level haircut), above max_issuer_net_debt ${netLimit}`);
    checks.push(entry);
  }
  return {ok: true, checks};
}

// ---------- what GET /participants/{id} publishes (circulation modes sandbox and on) ----------
// The credit history: aggregates only (no deal, counterparty or amount of a single deal), from Valun's own records.
// `deals`: the participant's deals, swept (Pilot.position). Counts and PC: notes it issued as payer (note_issued), deals it
// paid by transfer as payer and was paid by transfer as payee, set-offs applied with it as a member and the PC they
// cleared on its edges (one side: its claims fell by as much as its debts), deals it accepted and has not paid
// (payment_due), disputes it raised as payer and received as payee, deals it did not deliver as payee
// (expired_undelivered), when a deal of its was first offered, and whether the operator runs it (holds its keys).
export function creditHistory(pilot, p, deals) {
  const price = d => d.agreement?.terms?.price?.amount ?? pilot.current(d).terms.price.amount;
  const of = (role, status) => deals.filter(d => d[role] === p.id && d.status === status);
  const sum = xs => ({count: xs.length, PC: xs.reduce((a, d) => a + price(d), 0)});
  const keys = pilot.keysOf(p);
  let cleared = 0;
  for (const [k, e] of Object.entries(pilot.s.edges || {})) if (keys.has(k.split('>')[0])) cleared += e.setoff_PC ?? 0;
  let first = null;
  for (const d of deals) { const at = d.versions?.[0]?.offered_at; if (typeof at === 'string' && (first === null || at < first)) first = at; }
  return {
    notes_issued: sum(of('payer', 'note_issued')),
    paid_by_transfer: sum(of('payer', 'paid_by_transfer')),
    received_by_transfer: sum(of('payee', 'paid_by_transfer')),
    cleared_by_setoff: {count: Object.values(pilot.s.setoffs || {}).filter(o => o.state === 'applied' && o.members?.includes(p.id)).length, PC: cleared},
    payment_due: of('payer', 'payment_due').length,
    disputes: {raised: of('payer', 'disputed').length, received: of('payee', 'disputed').length},
    expired_undelivered_as_payee: of('payee', 'expired_undelivered').length,
    first_activity_at: first,
    operator_run: pilot.serverRun(p),
  };
}
// The predicate fields of the participant's credit policy as the server applies them (the owner's mandate, tightened by
// any limits its agent recorded; a phase-2 field it does not hold at its default).
export function publicCreditPolicy(pilot, p) {
  const m = pilot.effectiveLimits(p);
  return Object.fromEntries(PUBLIC_POLICY_FIELDS.map(k => { const x = policyValue(p, m, k); return [k, Array.isArray(x) ? [...x] : x ?? null]; }));
}
