// The evidence in a participant's record (GET /participants/{id} public_position.evidence) and its network totals
// (GET /evidence), circulation modes sandbox and on. Three kinds of evidence answer three different questions, so they are
// kept apart and never blended into one number:
//   delivery    did it deliver work that its buyers accepted? Evidence about it as a seller, as good as its buyers are
//               independent and careful: Valun does not judge the work.
//   repayment   what did it owe as an issuer, and how much of that was settled (by set-off, or by redemption on the
//               testnet)? And accepted work it has not paid for. Evidence about it as a debtor.
//   acceptance  who chose to hold its IOU, from it directly or as a payment from someone else? That is others' willingness
//               to take its risk, not repayment.
// Each kind lists its counterparties by kind (lib/pilot/loops.mjs kindOf: invited agents joined by an invitation the
// operator issued; operator-run agents, whose keys the operator holds; sandbox agents; sandbox participants, who joined
// on their own, with no invitation). The record alone cannot show that two participants are independent: one operator
// can run many self-serve identities and stage deals, deliveries and a set-off among them whose signatures are all valid.
// `circle` shows where the evidence comes from: the participants it completed deals or took transfers with, and whether
// any of them deals with anyone outside that group. A closed group is what a staged circle looks like; a genuinely new
// group looks the same, and one deal with an outsider opens it. docs/EVIDENCE-ATTACKS.md runs the attacks.
//
// Valun grants nothing from this evidence. Limits stay what each owner sets (and the self-serve box), and each holder
// decides whose IOU it takes (its credit policy). A signed IOU shows that a key authorized it; it does not show that
// the work was good, that the issuer can pay, or that the debt will ever be settled.
import {kindOf} from './loops.mjs';
import {ON_TESTNET} from './units.mjs';
import {backingRecord, backingTotals} from './guarantees.mjs';

// A delivery the payer accepted: paid (its IOU issued, or paid with someone else's), being paid, or accepted and unpaid.
export const ACCEPTED = Object.freeze(new Set(['note_issued', 'paid_by_transfer', 'paying_by_transfer', 'payment_due', 'note_failed',
  'completion_awaiting_owner', 'issuing_note']));
export const PAID = Object.freeze(new Set(['note_issued', 'paid_by_transfer']));
// Accepted and not paid: the transfer that was to pay it ended without effect, or its IOU could not be recorded.
export const UNPAID_ACCEPTED = Object.freeze(new Set(['payment_due', 'note_failed']));
export const KINDS = Object.freeze(['invited', 'operator_run', 'sandbox_agent', 'sandbox_participant']);

export const EVIDENCE_READS_AS = Object.freeze({
  delivery: 'Deliveries its buyers accepted. Evidence about it as a seller, as good as those buyers are independent and careful; Valun does not judge the work.',
  repayment: 'What it owed as an issuer, and how much of that was settled. A set-off among participants one operator runs can be staged: it shows settlement inside that group, not that it can pay anyone else.',
  acceptance: 'Participants who chose to hold its IOU. That is a willingness to take its risk, not repayment; some agents accept every IOU by policy.',
  circle: 'Everyone it completed a deal or took a transfer with, and whether that group deals with anyone outside it. A staged circle is a closed group; so is a real new one, and a single outside deal opens either.',
  backing: "Guarantees it gave, was backed by, or holds: a backer's signed promise to pay a creditor, up to a cap, what an issuer still owes it after a due time, if the creditor calls. Calls honored, late or overdue are evidence about it as a backer. Being backed shows that someone took responsibility for part of its debt, not that it repays.",
  overall: 'Evidence to weigh, not a score. Valun grants no credit from it: each owner sets its own limits, and each holder decides whose IOU it takes.',
});

const priceOf = (pilot, d) => (d.agreement?.terms ?? pilot.current(d).terms).price.amount;
const sumPrice = (pilot, ds) => ds.reduce((a, d) => a + priceOf(pilot, d), 0);

// A participant's kind as the loops show it (operator_run from the server's signer, as Pilot.publicParticipant says).
export const kindOfId = (pilot, id) => { const p = pilot.s.participants[id]; return kindOf(p && {...p, operator_run: pilot.serverRun(p)}); };
// {kind: count} of a set of participant ids, in KINDS order; kinds with no member are left out.
export function byKind(pilot, ids) {
  const out = {};
  for (const id of ids) { const k = kindOfId(pilot, id); out[k] = (out[k] ?? 0) + 1; }
  const order = [...KINDS, ...Object.keys(out).filter(k => !KINDS.includes(k))];
  return Object.fromEntries(order.filter(k => out[k]).map(k => [k, out[k]]));
}

// Who is linked to whom by completed exchanges: a deal whose delivery was accepted (payer and payee), and a promise taken
// by transfer (its issuer and the new holder, who took the issuer's IOU without a deal with it). id -> Set of ids.
export function exchangeGraph(pilot) {
  const g = new Map(), link = (a, b) => {
    if (!a || !b || a === b) return;
    (g.get(a) ?? g.set(a, new Set()).get(a)).add(b);
    (g.get(b) ?? g.set(b, new Set()).get(b)).add(a);
  };
  for (const d of Object.values(pilot.s.deals)) if (ACCEPTED.has(d.status)) link(d.payer, d.payee);
  const keys = pilot.pubkeyMap();
  for (const [k, e] of Object.entries(pilot.s.edges || {})) if ((e.transferred_in_PC ?? 0) > 0) {
    const [i, r] = k.split('>');
    link(keys.get(i)?.id, keys.get(r)?.id);
  }
  return g;
}

// The participant's circle: itself and everyone it is linked to; closed when none of them is linked to anyone else.
export function circleOf(pilot, id, graph = exchangeGraph(pilot)) {
  const members = new Set([id, ...(graph.get(id) ?? [])]);
  let outside = 0;
  for (const m of members) for (const n of graph.get(m) ?? []) if (!members.has(n)) outside += 1;
  return {size: members.size, members_by_kind: byKind(pilot, members), closed: members.size > 1 && outside === 0, links_outside: outside};
}

// The evidence of participant p. `ledger`: Pilot.ledger() rows; `deals`: p's deals, swept (Pilot.position reads them).
export function evidenceOf(pilot, p, {ledger, deals, graph = null} = {}) {
  const sold = deals.filter(d => d.payee === p.id), bought = deals.filter(d => d.payer === p.id);
  const accepted = sold.filter(d => ACCEPTED.has(d.status)), paid = sold.filter(d => PAID.has(d.status));
  const buyers = new Set(accepted.map(d => d.payer));
  const keys = pilot.keysOf(p), keyMap = pilot.pubkeyMap();
  let owedEver = 0, bySetoff = 0, taken = 0;
  const settledWith = new Set(), holders = new Set(), takers = new Set(), holdersNow = new Set();
  for (const [k, e] of Object.entries(pilot.s.edges || {})) {
    const [i, r] = k.split('>');
    if (!keys.has(i)) continue;
    const who = keyMap.get(r)?.id ?? null;
    owedEver += e.issued_PC ?? 0;
    bySetoff += e.setoff_PC ?? 0;
    if ((e.setoff_PC ?? 0) > 0 && who) settledWith.add(who);
    if (((e.issued_PC ?? 0) > 0 || (e.transferred_in_PC ?? 0) > 0) && who) holders.add(who);
    if ((e.transferred_in_PC ?? 0) > 0) { taken += e.transferred_in_PC; if (who) takers.add(who); }
  }
  let outstanding = 0, redeemed = 0;
  for (const l of ledger) if (l.issuer === p.id) {
    outstanding += l.outstanding;
    redeemed += Number(l.redeemed) || 0;
    if (l.outstanding > 0 && l.recipient) holdersNow.add(l.recipient);
    if ((Number(l.redeemed) || 0) > 0 && l.recipient) settledWith.add(l.recipient);
  }
  const unpaid = bought.filter(d => UNPAID_ACCEPTED.has(d.status));
  return {
    delivery: {
      accepted: {count: accepted.length, PC: sumPrice(pilot, accepted), buyers: buyers.size, buyers_by_kind: byKind(pilot, buyers)},
      paid: {count: paid.length, PC: sumPrice(pilot, paid)},
      disputed_by_buyer: sold.filter(d => d.status === 'disputed').length,
      not_delivered: sold.filter(d => d.status === 'expired_undelivered').length,
      reads_as: EVIDENCE_READS_AS.delivery,
    },
    repayment: {
      owed_ever_PC: owedEver,
      settled: {by_setoff_PC: bySetoff, ...(ON_TESTNET ? {by_redemption_PC: redeemed} : {}), creditors: settledWith.size, creditors_by_kind: byKind(pilot, settledWith)},
      outstanding_PC: outstanding,
      unpaid_accepted_work: {count: unpaid.length, PC: sumPrice(pilot, unpaid)},
      reads_as: EVIDENCE_READS_AS.repayment,
    },
    acceptance: {
      holders_ever: holders.size, holders_by_kind: byKind(pilot, holders), holders_now: holdersNow.size,
      taken_by_transfer: {PC: taken, holders: takers.size, holders_by_kind: byKind(pilot, takers)},
      reads_as: EVIDENCE_READS_AS.acceptance,
    },
    // Guarantees (fix inbox #18, lib/pilot/guarantees.mjs): as backer, as the issuer backed, as the creditor holding them.
    backing: {...backingRecord(pilot, p, byKind, ledger), reads_as: EVIDENCE_READS_AS.backing},
    circle: {...circleOf(pilot, p.id, graph ?? exchangeGraph(pilot)), reads_as: EVIDENCE_READS_AS.circle},
    reads_as: EVIDENCE_READS_AS.overall,
  };
}

// The connected groups of the exchange graph, largest first: each with its size, its members by kind, and whether any
// member joined with an invitation or is run by the operator (`anchored`). A group of self-serve participants only is
// what a staged circle looks like, and also what a new community looks like before it deals with anyone else.
export function groupsOf(pilot, graph = exchangeGraph(pilot)) {
  const seen = new Set(), out = [];
  for (const start of graph.keys()) {
    if (seen.has(start)) continue;
    const members = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop();
      members.push(x);
      for (const n of graph.get(x) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    const kinds = byKind(pilot, members);
    out.push({size: members.length, members_by_kind: kinds, anchored: !!(kinds.invited || kinds.operator_run || kinds.sandbox_agent)});
  }
  return out.sort((a, b) => b.size - a.size);
}

// The network's totals of the same three kinds (no participant id, handle or key). `ledger`: Pilot.ledger() rows.
export function evidenceTotals(pilot, ledger) {
  const deals = Object.values(pilot.s.deals).map(d => pilot.sweep(d));
  const accepted = deals.filter(d => ACCEPTED.has(d.status)), paid = deals.filter(d => PAID.has(d.status));
  const unpaid = deals.filter(d => UNPAID_ACCEPTED.has(d.status));
  let owedEver = 0, bySetoff = 0, taken = 0;
  for (const e of Object.values(pilot.s.edges || {})) { owedEver += e.issued_PC ?? 0; bySetoff += e.setoff_PC ?? 0; taken += e.transferred_in_PC ?? 0; }
  let outstanding = 0, redeemed = 0;
  for (const l of ledger) { outstanding += l.outstanding; redeemed += Number(l.redeemed) || 0; }
  const graph = exchangeGraph(pilot), groups = groupsOf(pilot, graph);
  const settled = bySetoff + (ON_TESTNET ? redeemed : 0);
  const transfers = Object.values(pilot.s.transfers || {}).filter(t => t.state === 'applied');
  return {
    unit: pilot.unit,
    participants_with_exchanges: graph.size, participants_by_kind: byKind(pilot, graph.keys()),
    delivery: {accepted: {count: accepted.length, PC: sumPrice(pilot, accepted)}, paid: {count: paid.length, PC: sumPrice(pilot, paid)},
      disputed: deals.filter(d => d.status === 'disputed').length, not_delivered: deals.filter(d => d.status === 'expired_undelivered').length},
    repayment: {owed_ever_PC: owedEver, settled: {by_setoff_PC: bySetoff, ...(ON_TESTNET ? {by_redemption_PC: redeemed} : {})},
      settled_pct: owedEver > 0 ? Math.round(settled * 1000 / owedEver) / 10 : null, outstanding_PC: outstanding,
      unpaid_accepted_work: {count: unpaid.length, PC: sumPrice(pilot, unpaid)}},
    acceptance: {taken_by_transfer: {count: transfers.length, PC: taken}},
    backing: backingTotals(pilot, ledger),
    groups: {count: groups.length, anchored: groups.filter(g => g.anchored).length, self_serve_only: groups.filter(g => !g.anchored).length,
      largest: groups[0]?.size ?? 0, self_serve_only_sizes: groups.filter(g => !g.anchored).map(g => g.size).slice(0, 50)},
    reads_as: {...EVIDENCE_READS_AS, groups: 'Connected groups of participants linked by completed exchanges. A group with no invited or operator-run member is what a staged circle looks like, and also what a new community looks like before it deals with anyone else.'},
  };
}
