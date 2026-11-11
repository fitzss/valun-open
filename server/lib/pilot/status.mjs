// Every deal status, and how each part of the pilot server treats it (design §5.2, invariant I-MANDATE). This table is
// the single source for the status lists in Pilot.exposure(), position(), inbox(), revokeAgent(), sweep() and the deal
// view's next_actions (lib/pilot/core.mjs); test/status-classification.test.mjs fails on any status it does not
// classify (closed world).
//
// paying_by_transfer, paid_by_transfer and payment_due belong to circulating credit (debt transfer, design §4.8); they
// are reached only with circulation on (modes sandbox and on).
//
// Fields of each entry:
//   committed    the price is promised: it counts against both parties' mandate limits (exposure "committed").
//   reserved     an offer the other side could still accept: it counts as "reserved" exposure, but only for the
//                participant whose own offer (current version) it is.
//   terminal     the deal has ended; nothing further happens to it.
//   offer_phase  nothing is agreed yet: the offer, or an acceptance waiting for an owner, is still open.
//   bucket       the deal-count bucket in position() (POSITION_BUCKETS are the buckets it reports today).
//   payer_inbox, payee_inbox
//                the inbox() section the deal is listed in for that party: a section name, null (listed in none), or
//                'respond_or_waiting'     respond while the counterparty's version is current, waiting_on_others while
//                                         the participant's own version is;
//                'waiting_on_counterparty_owner'
//                                         waiting_on_others while the counterparty's owner has a pending approval on it
//                                         (a pending approval of one's own owner is listed under awaiting_your_owner).
//   revoke       what revokeAgent() does when either party's agent key is revoked:
//                'cancel'          the deal ends as cancelled (nothing was agreed);
//                'void_held_note'  the credit note held for the payer's owner is voided; the deal returns to delivered;
//                'void_transfer'   the transfer being collected is voided (circulating credit);
//                'keep'            the deal stands (an agreement binds the participants, not their keys).
//   expiry       what the lazy sweep (Pilot.sweep) does with the deal once its time passes, or null (nothing expires):
//                'offer'           past the current version's offer_expires_at the deal is expired;
//                'held_acceptance' past offer_expires_at an acceptance still waiting for an owner expires with it;
//                'delivery'        past deliver_by + the grace period the deal is expired_undelivered (OQ-8).
//   actions      {payer, payee}: which next_actions each party's deal view lists (Pilot.nextActions), or null (none):
//                'offer'           accept, decline or counter the other party's offer; withdraw one's own;
//                'held_acceptance' wait for the owner (the proposer may still withdraw its offer);
//                'wait_for_owner'  wait for the owner's decision;
//                'deliver'         deliver;
//                'review'          complete or dispute the delivery (with circulating credit, or pay by transfer);
//                'pay'             pay an accepted delivery: complete (an own credit note), or pay by transfer;
//                'paying'          a payment by transfer collects its signatures: wait for them, or cancel it;
//                'wait_for_consents' wait for the signatures of the other parties of a payment by transfer.

export const INBOX_SECTIONS = Object.freeze(['respond', 'deliver', 'review_delivery', 'waiting_on_others', 'recent_closed']);
// The deal-count buckets position() reports, in this order (unchanged since v15). paid_by_transfer is classified but
// reported only with circulating credit on.
export const POSITION_BUCKETS = Object.freeze(['credit_notes_issued', 'open', 'agreed_note_not_issued', 'disputed', 'declined', 'expired_or_withdrawn']);
export const BUCKETS = Object.freeze([...POSITION_BUCKETS, 'paid_by_transfer']);
export const REVOKE_ACTIONS = Object.freeze(['cancel', 'void_held_note', 'void_transfer', 'keep']);
export const EXPIRY_KINDS = Object.freeze(['offer', 'held_acceptance', 'delivery']);
export const ACTION_SETS = Object.freeze(['offer', 'held_acceptance', 'wait_for_owner', 'deliver', 'review', 'pay', 'paying', 'wait_for_consents']);

const entry = (committed, reserved, terminal, offer_phase, bucket, payer_inbox, payee_inbox, revoke, {expiry = null, payer = null, payee = null} = {}) =>
  Object.freeze({committed, reserved, terminal, offer_phase, bucket, payer_inbox, payee_inbox, revoke, expiry, actions: Object.freeze({payer, payee})});
const offer = (reserved, inbox, committed, expiry, actions) => entry(committed, reserved, false, true, 'open', inbox, inbox, 'cancel', {expiry, payer: actions, payee: actions});
const unpaid = (payer, payee, revoke = 'keep', more = {}) => entry(true, false, false, false, 'agreed_note_not_issued', payer, payee, revoke, more);
const ended = bucket => entry(false, false, true, false, bucket, 'recent_closed', 'recent_closed', 'keep');

export const STATUS_CLASS = Object.freeze({
  open: offer(true, 'respond_or_waiting', false, 'offer', 'offer'),
  proposed_awaiting_owner: offer(true, null, false, 'offer', 'wait_for_owner'),   // seen only by the proposer, whose owner decides
  accepted_awaiting_owner: offer(false, 'waiting_on_counterparty_owner', true, 'held_acceptance', 'held_acceptance'),
  agreed: unpaid('waiting_on_others', 'deliver', 'keep', {expiry: 'delivery', payee: 'deliver'}),
  delivered: unpaid('review_delivery', 'waiting_on_others', 'keep', {payer: 'review'}),
  completion_awaiting_owner: unpaid(null, 'waiting_on_others', 'void_held_note', {payer: 'wait_for_owner', payee: 'wait_for_owner'}),
  issuing_note: unpaid(null, null),
  note_failed: unpaid('review_delivery', null, 'keep', {payer: 'pay'}),
  paying_by_transfer: unpaid('waiting_on_others', 'waiting_on_others', 'void_transfer', {payer: 'paying', payee: 'wait_for_consents'}),
  payment_due: unpaid('review_delivery', 'waiting_on_others', 'keep', {payer: 'pay'}),
  note_issued: ended('credit_notes_issued'),
  paid_by_transfer: ended('paid_by_transfer'),
  disputed: ended('disputed'),
  declined: ended('declined'),
  withdrawn: ended('expired_or_withdrawn'),
  expired: ended('expired_or_withdrawn'),
  rejected_by_owner: ended('expired_or_withdrawn'),
  cancelled: ended('expired_or_withdrawn'),
  expired_undelivered: ended('expired_or_withdrawn'),
});

// The classification of a status, or null for a status this server does not know (it is then in no list).
export const statusClass = status => (typeof status === 'string' && Object.hasOwn(STATUS_CLASS, status) ? STATUS_CLASS[status] : null);

// How many deals are in each bucket (every bucket in BUCKETS, zero included).
export function bucketCounts(deals) {
  const out = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  for (const d of deals) { const c = statusClass(d.status); if (c) out[c.bucket] += 1; }
  return out;
}

// The inbox() section of a deal for one party (role 'payer' or 'payee'), or null. `ownOffer` and
// `counterpartyOwnerPending` are functions, called only for the statuses that depend on them.
export function inboxSection(status, role, {ownOffer, counterpartyOwnerPending}) {
  const c = statusClass(status), s = c ? c[role === 'payer' ? 'payer_inbox' : 'payee_inbox'] : null;
  if (s === 'respond_or_waiting') return ownOffer() ? 'waiting_on_others' : 'respond';
  if (s === 'waiting_on_counterparty_owner') return counterpartyOwnerPending() ? 'waiting_on_others' : null;
  return s;
}
