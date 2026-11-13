// Grounded value of IOUs (fix inbox #20, docs/ADVERSARIAL-FINDINGS.md F3). Pure: no I/O, no clock.
//
// A credit note is worth what its issuer can pay, and an issuer can pay out of two things: what it holds outside the
// credit graph, and what its own claims are worth. Inside the graph anyone can mint IOUs for free (self-serve joins),
// so value may ENTER only where an attacker cannot mint it:
//   - a reserve: tERG the issuer locked in a Basis reserve on Ergo testnet (redeemable by its creditors);
//   - trust: an issuer the owner of the participant deciding has named itself (accept_notes_from, as a list), and that
//     participant itself (its own IOU, held by a payer, it can always set off against the payer's debt to it).
// Every other issuer I is worth its ratio
//   r(I) = min(1, (reserve(I) + sum over J of held(I on J) * r(J)) / owes(I))
// taken as the LEAST fixed point, reached by iterating from r = 0 for everyone not trusted. A chain or a ring of IOUs
// with no reserve or trust anywhere behind it therefore stays at 0 however its members trade among themselves; a
// greatest fixed point would let a ring of colluders "pay" each other in full (the Eisenberg-Noe clearing model of a
// payment network, here with the minimal vector). Each round only raises ratios, they stay within [0, 1], and an
// acyclic graph is exact after as many rounds as its depth; cycles converge from below, so stopping early only ever
// undervalues.
//
// This values what a payer HOLDS. It measures whether the payer could pay, not the creditor's security: a creditor
// cannot seize a payer's claims, and redeems on Ergo testnet only against the payer's own reserve.
//
// rows: [{issuer, recipient, outstanding, claim?}] (participant ids; rows without both ids are skipped; claim: false counts
// the debt for its issuer but as nobody's claim, as for an edge whose tracker total Valun's journal does not expect).
// reserves: Map id -> what that participant holds in reserves (in the network's unit).
// trusted: Set of ids worth their full face (r = 1).
// extraOwes: Map id -> contingent debts to add to owes (a backer's open guarantee caps).
export const MAX_ROUNDS = 200;
export const EPSILON = 1e-12;

export function grounded({rows = [], reserves = new Map(), trusted = new Set(), extraOwes = new Map(), maxRounds = MAX_ROUNDS} = {}) {
  const owes = new Map(), held = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  for (const l of rows) {
    if (!l || !l.issuer || !l.recipient || l.issuer === l.recipient || !(l.outstanding > 0)) continue;
    add(owes, l.issuer, l.outstanding);
    if (l.claim === false) continue;                 // a debt that counts as no one's claim (an edge that does not reconcile)
    if (!held.has(l.recipient)) held.set(l.recipient, new Map());
    add(held.get(l.recipient), l.issuer, l.outstanding);
  }
  for (const [k, v] of extraOwes) if (v > 0) add(owes, k, v);
  const ids = new Set([...owes.keys(), ...held.keys(), ...reserves.keys(), ...trusted]);
  const r = new Map([...ids].map(id => [id, trusted.has(id) ? 1 : 0]));
  const assets = id => (reserves.get(id) ?? 0) + [...(held.get(id) ?? [])].reduce((a, [j, h]) => a + h * (r.get(j) ?? 0), 0);
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    let moved = 0;
    for (const id of ids) {
      if (trusted.has(id)) continue;
      const o = owes.get(id) ?? 0, next = o > 0 ? Math.min(1, assets(id) / o) : 0;
      if (next > (r.get(id) ?? 0) + EPSILON) { moved = Math.max(moved, next - r.get(id)); r.set(id, next); }
    }
    if (!moved) break;
  }
  const ratio = id => (trusted.has(id) ? 1 : r.get(id) ?? 0);
  return {
    ratio,
    owes: id => owes.get(id) ?? 0,
    reserve: id => reserves.get(id) ?? 0,
    // What id's claims are worth (rounded down to the unit), and the claims face value.
    claimsValue: id => Math.floor([...(held.get(id) ?? [])].reduce((a, [j, h]) => a + h * ratio(j), 0) + EPSILON),
    claimsFace: id => [...(held.get(id) ?? [])].reduce((a, [, h]) => a + h, 0),
    // id's claims, issuer by issuer: [{issuer, held, ratio}].
    claimsOf: id => [...(held.get(id) ?? [])].map(([issuer, h]) => ({issuer, held: h, ratio: ratio(issuer)})),
    rounds,
  };
}
