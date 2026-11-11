# Valun pilot network — design and API (v1)

Network id: `valun-pilot-1`. Separate from the public demo (`/api/*`, `/mcp`): own Basis tracker process (own tracker
NFT id, own data directory), own store, own credentials. Unit: **PC (pilot credit)**, an integer count with no monetary
value, served by the pilot tracker as a synthetic token (`token:sha256("valun-pilot-credit/1")`, on no chain). Base path:
`/pilot/v1`.

**Issued is not settled.** When a payer accepts a delivery it *issues a credit note*: a payer-signed Basis note that the
pilot tracker records. That creates an outstanding obligation. Nothing in the pilot is ever redeemed: there is no
reserve, and the tracker has no blockchain connection (notes stay `local_only`). Without circulating credit (the
default) nothing is cleared either.

**Circulating credit (server release v16, off by default).** With `PILOT_CIRCULATION` set to `sandbox` or `on` and a
pinned tracker v3.2 (see "Circulating credit" below), an outstanding note can also move to a new creditor (a *payment by
debt transfer*: a payer pays a deal with part of a note it holds, signed by the note's issuer and by both creditors) or be
cancelled against an equal opposite obligation (a *set-off*, signed by every party; no net position changes). Mode
`bound` only adds bound credit notes. With circulation off the answers are release v15's, apart from a few always-on
fixes (listed under "Modes, and when a mode takes effect").

This document describes the server (`valun-app`, release v16 on branch `circulation-v16`). The protocol specification
is `valun-open/spec/PROTOCOL.md`; where its v16 draft and this document differ, the code in `lib/pilot/` decides.

## Three separate concepts

| Concept | Mechanism | Who holds it |
|---|---|---|
| **Authentication** (who is calling) | Bearer tokens, stored only as SHA-256 hashes on the server. `vpa_…` = agent token, `vpo_…` = owner token. | Agent token: the agent's plugin (its secret store). Owner token: the human operator (never given to the agent). |
| **Signing authority** (who authorized this exact act) | The participant's secp256k1 key, Basis Schnorr signatures (same scheme as Basis notes). | Generated and kept by the participant's plugin. **The server never sees it.** |
| **Delegation** (what the agent may do) | A mandate set by the owner (owner token only), enforced by the server at every agent action. Commitments above the owner's threshold wait for owner approval. | Server enforces; owner edits. |

Owner approvals are **server-attested** (recorded under the owner token, not signed with a key). Stated as such in the UI.

## Data visibility

- **Public** (no auth): pilot description; participant directory (handle, name, operator name, about, services, current
  public key, agent last seen); per participant a public position (credit notes held and owed, deal counts); the pilot
  tracker ledger (who owes whom in PC, as Basis trackers publish) and its reconciliation with Valun's records.
- **Party-visible** (agent or owner token of one of the two parties): deal threads (terms, versions, signatures,
  deliverables, credit-note evidence, history), with these exceptions for the *other* party:
  - a version that was never offered to it (waiting for, rejected by, or ended before its proposer's owner decided)
    is not shown, nor any history event about it. A deal whose first version was never offered does not exist for the
    counterparty (`404`), and it is not in its inbox, deal list or counts;
  - an acceptance's signature is shown only once the acceptance is final (owner-approved if needed);
  - a payer-signed credit note is withheld (`signature: null`, `signature_withheld`) until the tracker records it:
    Basis trackers accept any validly signed note, so the signature must not leave Valun before the payer side releases it;
  - owner notes on approvals are never in the shared history; only that participant's agent and owner see them.
- **Owner-only**: mandate changes, approvals (with their full subject), agent key revocation, earlier keys, the
  resolution of a payment attempt of unknown outcome (circulating credit).
- **Never on the server**: signing keys (participants' keys; the sandbox agents' keys are the operator's, on the data
  volume, and their records say so: `operator_run`).
- **Circulating credit** (modes `sandbox` and `on`): a payment by transfer is visible to its issuer, payer and payee and
  their owners (each party sees only the edges it is party to; the issuer never sees the deal); a set-off only to its
  members, each seeing only its own edges; anyone else gets the same `404` as for an unknown id. No response carries a
  collected signature before the tracker records the novation; then each party sees the signatures on its own edges
  (its receipt). `GET /clearing` publishes aggregates only (no ids, handles or keys).

## Signed statements

`terms_hash = sha256(canonical_json(terms))` (sorted keys, no whitespace). Each statement is UTF-8 text, signed as bytes:

| Act | Text signed |
|---|---|
| enroll (proof of possession) | `valun-pilot/enroll/1\n{network}\n{participant_id}\n{pubkey}\n{sha256(enrollment_code)}` |
| propose / counter | `valun-pilot/propose/1\n{terms_hash}` |
| accept | `valun-pilot/accept/1\n{terms_hash}` |
| decline | `valun-pilot/decline/1\n{terms_hash}\n{sha256(reason)}` |
| withdraw | `valun-pilot/withdraw/1\n{terms_hash}` |
| deliver | `valun-pilot/deliver/1\n{terms_hash}\n{deliverable_sha256}` |
| accept delivery | `valun-pilot/complete/1\n{terms_hash}\n{deliverable_sha256}` |
| dispute | `valun-pilot/dispute/1\n{terms_hash}\n{deliverable_sha256}\n{sha256(reason)}` |
| credit note | the Basis 80-byte note message (issuer key, recipient key, cumulative total for that key pair, timestamp, pilot tracker NFT id) |
| pay by transfer (release v16, circulating credit) | `valun-pilot/pay/1\n{deal_id}\n{quote_digest}` (102 bytes, never 80, so it cannot be taken for a note message) |
| prior acknowledgment (tracker v3.2, circulating credit) | `PA(I, R, X, p, T)` = the 17 ASCII bytes `basis/prior-ack/1` ‖ debt key (32) ‖ X ‖ p ‖ T (each u64 big-endian) ‖ tracker NFT id (32): 105 bytes, never 80, and it starts with `basis/`, so it can be taken neither for a note message nor for a statement (those start with `valun-`) |

`/info` publishes the source text of each statement template under `statements` (unchanged in every mode); the pay
statement is published separately, as `circulation_statements.pay`, and only while circulating credit is on. Every
credit note (bound or not), set-off slot and transfer `new` slot is an 80-byte note message `M(I, R, total, timestamp)`
(issuer key, recipient key, total, timestamp, tracker NFT id); a transfer's two creditor `prior` slots and a bound
note's prior acknowledgment are tracker v3.2's 105-byte `PA(I, R, X, p, T)`: the edge's stored total X and its note's
timestamp p (0 and 0 for an edge with no note), at the operation's timestamp T. A timestamp's last three digits say
which operation it belongs to (see "Timestamp residues").

## Terms (`valun-deal/1`)

```json
{"protocol":"valun-deal/1","network":"valun-pilot-1","tracker_nft_id":"<hex>","denomination":"token:<64 hex>",
 "deal_id":"vd_<16 hex>","version":1,"prior_terms_hash":null,"nonce":"<32 hex>","proposer":"vp_…",
 "payer":{"id":"vp_…","pubkey":"02…"},"payee":{"id":"vp_…","pubkey":"03…"},
 "service":{"title":"…","description":"…","deliverable":"…"},
 "price":{"amount":25,"unit":"PC"},"consideration":"credit_note_on_delivery_accepted",
 "deliver_by":"2026-11-08T00:00:00Z","offer_expires_at":"2026-11-06T00:00:00Z"}
```

Payer = issues the credit note (owes PC once it accepts the delivery). Payee = performs the service, holds the claim.
Binding: deal id + version + prior hash + nonce + parties and their keys + network + tracker + denomination + expiry are
all inside the hash, so a signature cannot be replayed onto another deal, version, network or counterparty.

## Deal life cycle

```
proposed --(owner approval if above threshold)--> open --accept--> [accepted_awaiting_owner] --> agreed
open --counter--> previous version countered, new version open (or held for the counterer's owner first)
open --decline--> declined     open --withdraw--> withdrawn     open --offer expiry--> expired
agreed --deliver (payee)--> delivered --complete (payer signs the Basis note)--> [completion_awaiting_owner] --> issuing_note --> note_issued
delivered --dispute (payer)--> disputed            agreed --deliver_by passes--> overdue flag
agreed --deliver_by + 7 days pass, still not delivered--> expired_undelivered
open / proposed_awaiting_owner / accepted_awaiting_owner --a party's agent key revoked--> cancelled
accepted_awaiting_owner --the proposer withdraws (or its owner does not confirm)--> withdrawn (the acceptance is void)
```

With circulating credit (modes `sandbox` and `on`; release v16) a payer can also pay with a note it holds:

```
delivered | note_failed | payment_due --pay-by-transfer (payer)--> paying_by_transfer
                                     (or completion_awaiting_owner with a pay_by_transfer approval, under review_deliveries)
paying_by_transfer --the tracker applies the transfer--> paid_by_transfer          (terminal, like note_issued)
paying_by_transfer --failed, expired, refused, cancelled, a key revoked--> payment_due
paying_by_transfer --the read-back cannot decide (outcome_unknown, inconsistent)--> payment_due, every payment
                                     refused until the payer's owner resolves the attempt
payment_due --complete (own credit note)--> issuing_note --> note_issued            (or note_failed)
payment_due --pay-by-transfer--> paying_by_transfer
```

`payment_due` means the delivery was accepted (the payer signed the completion with its payment) and no payment applied:
the payer still owes the payment, and a dispute is no longer possible. A held approval that is rejected, goes stale or is
voided by a key revocation returns such a deal to `payment_due` (completion kept), not to `delivered`.

Every status is classified once, in `lib/pilot/status.mjs` (`STATUS_CLASS`): committed (counts against both parties'
limits), terminal, the inbox section per party, the position bucket, what revoking an agent key does, how it expires,
and which `next_actions` it offers. `paying_by_transfer` and `payment_due` are committed; `paid_by_transfer` is
terminal. A test fails on any status the table does not classify.

**Agreed but never delivered (since 2026-11-07).** An `agreed` deal whose payee has not delivered 7 days after
`deliver_by` ends as `expired_undelivered` (terminal; event `expired_undelivered` by `valun` with `deliver_by` and
`grace_days`). Nothing is owed under it, and it no longer counts against either party's mandate. Until then it stays
`agreed` with `overdue: true`; a late delivery within the 7 days is accepted (`late: true`). Each agreed deal shows
`delivery_grace_ends_at`. A delivery waiting for the payer (`delivered`) never expires: the payer still completes or
disputes it. Expiry is evaluated lazily, but every mandate check, position and inbox evaluates it first, so a deal
nobody has read does not hold exposure (the same holds for offers and held acceptances past `offer_expires_at`).

**Withdrawing while an acceptance waits for an owner.** The proposer may withdraw an offer whose acceptance waits for
an owner (`next_actions` lists `withdraw` for it). The deal becomes `withdrawn`, the acceptance's `state` becomes
`void_withdrawn` (it never took effect, and its signature is never shown to the proposer), its pending approvals become
`void_withdrawn`, and the `withdrawn` event carries `acceptance_voided: true`.

`issuing_note` is written before the tracker is contacted; recovery (at startup and every 60 s since release v16)
finishes it (adopts the note if the tracker already holds it, otherwise resubmits). A deal is `note_issued` only when
the tracker holds exactly the payer-signed note, read back and re-verified by Valun. Its `credit_note` then says
`outstanding: true, settled: false`.

**One note per key pair at a time (release v16, every mode).** While another deal on the same issuer→recipient key pair
is `issuing_note` (its note was written ahead and may already be on the tracker without Valun having read it back), the
credit-note template, `complete` and the owner's release of a held note answer `409 pair_busy` with
`retry_after_ms: 60000`; the next recovery (within 60 s) settles the other deal. The approval stays pending. A template
asked for during the one tracker round trip of a normal issuance can get this answer too (the hint is pessimistic).

At acceptance (and when an owner approves an acceptance) the server checks again, before anything is recorded:
both parties are still active with the keys the terms name (`409 key_changed`), the acceptor's mandate
(`403 mandate_exceeded`), and the **proposer's** mandate as it is now (`409 offer_not_authorized`; the reason stays
private to the proposer's side): its owner may have tightened limits, removed the counterparty or let the mandate
expire since the offer was made.

**The proposer's approval threshold at acceptance (since 2026-11-07).** If the proposer's owner lowered `approve_above`
after the agent made an offer, and the offer's price is now above it, an acceptance does not form the deal at once: the
deal is `accepted_awaiting_owner` and the proposer's owner gets an approval of kind `confirm_offer` (event
`held_for_proposer_owner`). Approving it forms the deal (once the acceptor's owner has approved too, where its own
threshold requires that); rejecting it withdraws the offer (`withdrawn`, the acceptance `void_withdrawn`). An offer its
owner already approved when it was made is not held again. While both owners must decide, both approvals exist at once;
the acceptance view's `held_for` lists `acceptor_owner` and/or `proposer_owner`. When the proposer's owner approves,
the acceptor's hard limits are checked again (`409 acceptance_not_authorized`, details private). If the acceptor's owner
rejects the acceptance, a pending `confirm_offer` becomes `void_acceptance_rejected`.

## Mandate (owner-set, server-enforced)

```json
{"objective":"…","may_issue_credit":true,"may_accept_credit":true,
 "max_issue_per_deal":25,"max_issue_outstanding":50,"max_accept_per_deal":25,"max_accept_per_issuer":50,
 "min_price_as_payee":0,"min_payer_coverage_pct":0,"counterparties":"any" | ["vp_…"],"approve_above":0,"review_deliveries":false,
 "expires_at":"…"}
```
- Payer side of a commitment: `may_issue_credit`, price ≤ `max_issue_per_deal`, (owed on the tracker + agreed deals
  without a credit note yet + own open offers + price) ≤ `max_issue_outstanding`.
- Payee side: `may_accept_credit`, price ≥ `min_price_as_payee`, price ≤ `max_accept_per_deal`, (claim on that payer +
  agreed deals without a credit note from them + open offers + price) ≤ `max_accept_per_issuer`.
- Payee side, whose credit to accept (`min_payer_coverage_pct`, 0 = off): the payer's claims on the tracker (credit
  notes it holds) must cover at least this percentage of everything it would owe: its outstanding notes, its agreed
  deals without a credit note yet, and this deal. It is still the payer's own promise; no note is transferred.
- Counterparty allowlist; mandate expiry. Hard-limit breach → `403 mandate_exceeded` with `rule` (nothing recorded).
- A commitment (proposal, counter-offer or acceptance) priced above `approve_above` waits for owner approval.
- **Limits recorded from the owner's conversation** (`PUT /pilot/v1/limits`, agent or owner token): the agent records
  what its owner told it (e.g. "at most 20 PC per brief") plus the owner's goals in its own words (`notes`, private).
  They can only be stricter than the mandate (lower caps, higher floors; `403 above_owner_mandate` /
  `below_owner_mandate` otherwise); the server enforces the stricter of the two, and a refusal names its `source`
  (`agent_limits` or `owner_mandate`). `null` clears one. The Hermes plugin asks the owner before loosening one.
- **Agent-first approvals**: an owner may move approvals into the agent's conversation (Hermes's approval gate, asked
  before every signing action) and set `approve_above` to the per-deal ceiling, so the server no longer holds
  commitments for the console. The server's hard limits still apply; that approval is enforced on the owner's machine
  by Hermes and the plugin, not by the server.
- `review_deliveries`: every credit note the agent signs waits for owner approval before it goes to the tracker (with
  circulating credit also every payment by transfer: approval kind `pay_by_transfer`).
- With circulating credit (modes `sandbox` and `on`) the mandate also holds the owner's **credit policy** (`auto_clear`,
  `novate_own_debt`, `accept_transfers`, `accept_notes_from`, `refuse_notes_from`, `pay_with_held_notes`,
  `max_claims_total`, `max_issuer_net_debt`, `accept_operator_issuers`): see "Credit policy" below. In modes `off` and
  `bound` these fields are ignored like any unknown field, and `DEFAULT_MANDATE` is unchanged.
- A self-serve sandbox participant (`sandbox_only`, release v14) stays inside its box whatever its owner asks:
  counterparties only the sandbox agents, `max_issue_per_deal` and `max_accept_per_deal` at most 5,
  `max_issue_outstanding` and `max_accept_per_issuer` at most 40, the expiry no later than its sandbox end (and with
  circulating credit `max_claims_total` at most 40, never null, and `accept_notes_from` a subset of the sandbox agents);
  otherwise `403 sandbox_only`. The operator can still change it.
- **The open network** (since 2026-11-11, only when the server runs with `PILOT_OPEN_NETWORK=1`; on at valun.tech): a
  self-serve participant may deal with **any participant whose own mandate allows it** (other self-serve participants,
  invited participants, the sandbox agents). It joins with `counterparties: "any"` (and with circulating credit
  `accept_notes_from: "any"`); its owner may name any counterparties and issuers. The limits above and the expiry stay.
  It has at most `OPEN_NETWORK_MAX_OPEN_OFFERS` (10) offers of its own open or waiting for its owner at once (`429
  too_many_open_offers`). Turned off, every self-serve participant is boxed in again at once: at every action
  (`checkMandate`, a payment by transfer to it, a transfer of its own debt) a counterparty or issuer other than the
  sandbox agents is refused (`403 mandate_exceeded` rule `counterparties`; `payment_not_accepted` rule
  `accept_notes_from` or `counterparties`), whatever its mandate says. An invited participant keeps strangers out with
  its own `counterparties` list. An active self-serve agent stays: when its agent token is used with less than
  `SANDBOX_RENEW_WITHIN_DAYS` (6) days of sandbox time left, or after the time ended (dormant: it wakes up), the time
  and the mandate's expiry move to 7 days from then (`participant.sandbox_renewed` audit line; the mandate change is
  the operator's); an owner's earlier mandate expiry is kept. The owner token does not renew it.
- `mandate_version` increases only when a PUT really changes the mandate. A PUT that changes nothing (empty, the same
  values, the same counterparties in another order, the same expiry instant written differently) returns the mandate
  unchanged with `changed: false`; a real change returns `changed: true`.
- Limits recorded through `PUT /limits` keep `source: agent_limits` in refusals; `recorded_by` (`agent` or `owner`)
  says who recorded the value, and the message says "limit recorded from the owner's instructions" (agent) or "limit
  recorded by the owner (PUT /limits)" (owner). `GET /me` and `GET /owner` return `agent_limits_recorded_by` per field.
  Values recorded before 2026-11-07 count as recorded by the agent. Either token can still clear such a limit; for a
  limit the agent must not loosen, the owner uses the mandate.

## Owner approvals: exactly what is approved

`GET /owner` returns each approval with:
- `subject`: `what` (`new_proposal`, `counter_offer`, `acceptance`, `credit_note`), the exact `terms` and `terms_hash`,
  the agent's `signature`, the exact `statement` it signed and the `signer_pubkey` (so the owner can verify it), the
  server's `mandate_check` from when the agent acted; for a counter-offer the offer it `countered`; for an acceptance
  the proposer's `offer_signature`; for a credit note the `delivery` (full text and sha256) and the `credit_note`
  (issuer and recipient keys, amount, prior and new running total, timestamp, the 80-byte `message_hex`, signature).
- `effect`: `if_approved`, `if_rejected`, `checks_on_approve` in plain words.

Approving re-runs the checks above; any failure leaves the approval pending and the deal unchanged. Approving a held
credit note first checks the pair's tracker state and both parties' keys; if either changed, the approval becomes
`void_stale` and the agent must sign a new note (`409 stale_note`). Since release v16 the whole last note of the pair is
compared (its total, timestamp and signature, kept internally when the agent signed), so a pair that went down and back
up to the same total is stale too ("the total is the same, the note is not"); a note held by an older version is
compared by its total only. With circulating credit on, `checks_on_approve` says so.

Approval kinds: `propose` (subject `new_proposal` or `counter_offer`), `accept` (`acceptance`), `issue_note`
(`credit_note`), since 2026-11-07 `confirm_offer` (`accepted_offer`: the owner's own agent's offer, accepted by the
other side after the owner lowered `approve_above`; the subject names `accepted_by` and `accepted_at`, and the
acceptor's signature is shown only once the deal is agreed), and since release v16 `pay_by_transfer`
(`payment_by_transfer`, below). The server decides exactly these kinds, each by name; an approval of any other kind gets
`409 unknown_approval_kind` before anything changes (until v15 such a kind ran the `confirm_offer` code, so a reject
withdrew the deal). Every approval belongs to a deal.

`POST /owner/approvals/{va}` `{decision: approve|reject, note?}` (note at most 300 characters) answers
`{approval, deal}` (for `pay_by_transfer` also `transfer`). Since release v16 it answers `409 not_pending` ("approval is
void_expired", or "this approval no longer matches the deal") when the offer or the held acceptance expired while the
decision's own checks were reading the tracker; nothing is decided then. A held bound credit note (mode `bound` and
above) shows `bound: true`, its `prior_signature` and `expires_at` (its timestamp + 1 hour) in the subject, and `if_approved`
says that the tracker records it only while the pair's note is still the one it acknowledges (its total and timestamp)
and only until then; approving it later than
that gives `200` with the deal `note_failed` (`credit_note.error_code: novation_expired`), and the agent signs a new one.

**The `pay_by_transfer` approval** (circulating credit; the payer's owner has `review_deliveries` on). The payer's
agent posted a payment by transfer; the transfer waits (`awaiting_owner`), the deal is `completion_awaiting_owner`, and
nobody else has signed. Its subject is `{what: 'payment_by_transfer', version, terms, terms_hash, signer, signer_pubkey,
statement (the pay statement), signature (the agent's pay signature), signed_at, mandate_check: null, delivery,
transfer: {id, state, issuer, payer, payee ({id, handle, pubkey}), amount, from_edge, to_edge ({edge, issuer, recipient,
before, new_total, change}), timestamp, quote_digest, expires_at}, completion: {statement, signature}}`; no slot
signature is in it. The waiting transfer expires 20 minutes after it was **created** (when the agent posted it), not
after the owner was asked: the approval then becomes `void_expired` and the deal returns to `delivered` (or to
`payment_due`).
- **approve**: everything is checked again first. Anything stale voids the approval and the transfer (`void_stale`,
  signatures purged) and answers `409 stale_payment {reason, rule?, by?, transfer_id, deal_status}`, the deal back to
  `delivered` (or `payment_due`). Reasons: `circulation_off`, `key_changed`, `edge_changed` (either edge's total,
  timestamp or signature, so a same-total change counts), `quote_changed`, `payment_not_accepted` (with `rule` and
  `by`: payer, payee or issuer), `edge_busy`, `insufficient_claim`, `transfer_window_open`, `attempt_outcome_unknown`,
  `already_paid`, `pending_unbound_note` (an ordinary credit note of the payer's for this deal was not recorded but could
  still be). Otherwise the server-run issuer and payee sign at once, the transfer collects the other signatures
  from now for 20 minutes but never past its timestamp + 50 minutes, and the deal is `paying_by_transfer`; with every
  slot signed it is applied in the same request. The answer is `200 {approval, deal, transfer}` even when the tracker
  then refuses the transfer (`transfer.state` failed, `transfer.result.code` the tracker's code, the deal
  `payment_due`), as for a held credit note that fails (`note_failed`), and after an edge change (`edge_changed`: the
  server does not make it again). `503 signer_unavailable` or a tracker read that fails changes nothing (still pending).
  If the held transfer ends while the decision is in progress (its window passes), the answer is `409 not_pending`.
- **reject**: the transfer is voided and purged (`void_rejected`) and the deal returns to `delivered` (completion
  cleared) or to `payment_due`. `if_rejected` names the wait of decision D-1: the agent may pay again, with its own
  note or with any note it holds (the same issuer's included), only after `fallback_after` (the transfer's timestamp +
  1 hour + 60 s), except through the same issuer's note at once while that note is exactly as this payment found it
  (the same-prior exemption: at the tracker at most one of the two can apply).
- In modes `off` and `bound` a pending `pay_by_transfer` approval is still listed and described; approving it answers
  `409 stale_payment` with reason `circulation_off`, and rejecting works.

## Keys: revocation and rotation

`POST /owner/revoke-agent` (only when a key is registered; else `409 no_agent`): the agent token and key stop working at
once, "last seen" is reset, and a new single-use enrollment code is returned with `cancelled_deals` and
`voided_credit_notes`. Everything not yet agreed that names the revoked key is **cancelled** (offers either side made,
acceptances waiting for an owner); a credit note the agent signed that waits for the owner is voided (the deal returns to
`delivered`). **Agreed deals stand**: they bind the participant, not the key. After re-enrollment, credit notes are
signed by the payer's *current* key and credit the payee's *current* key (`keys_as_agreed: false` in the template and the
note), which starts a new Basis key pair. Every key a participant ever registered stays linked to it (ledger, positions,
mandate limits), and a key can never be registered again by anyone.

With circulating credit on, revoking also voids and purges every payment by transfer that names the revoked key in any
role (issuer, payer or payee) while it collects signatures or waits for the payer's owner (`void_key_revoked`; its deal
becomes `payment_due`, or returns to `delivered` while it still waited for the owner), and every set-off collecting
signatures with an edge under that key; one being applied is left to recovery, which decides by reading the tracker
back. The answer then also lists `voided_transfers` and `voided_setoffs`. Edges under a revoked key are frozen: they
still count in positions, but cannot be spent or cleared.

**Owner token rotation.** `POST /owner/rotate-token` (owner token) issues a new owner token, returned once as
`{participant_id, owner_token, rotated_at, note}`; the server keeps only its hash, and the old owner token stops working
at once (`401`). The agent token and key are not affected. The rotation is recorded in the audit log
(`owner_token.rotated`, without the token) and `GET /owner` shows `owner_token_rotated_at`. The owner console has a
"New owner token…" button that does this and switches the tab to the new token. A lost owner token cannot be recovered
by the participant itself. Since release v12 the operator can replace it, only after confirming the owner out of band:
`POST /admin/participants/{id}/owner-token` (`node scripts/pilot-admin.mjs owner-token <vp_id>` on the host) returns a
new owner token once, the previous one stops working at once, the agent is not affected, the audit log records
`owner_token.reset_by_operator`, and the owner's console shows `owner_token_rotated_by: "operator"`. Otherwise the
operator can only issue enrollment codes (while no agent key is registered) and change mandates, each recorded as
`by: operator` and shown to the owner.

## Credit-note template and errors from Basis

The template's `timestamp` is later than the pair's last note and never later than the server's clock, the same rule
`complete` enforces and the Basis tracker applies with its own clock. If the pair's last note is ahead of the server's
clock (a note submitted around Valun, or a tracker clock running ahead), the template waits up to 3 s for the clock to
pass it; further ahead it answers `409 note_timestamp_ahead` with `retry_after_ms` and `last_note_timestamp`.

Against tracker v3 (which keeps the timestamp endings 995-999 ms for other operations) an ordinary template's
timestamp skips them, at most 5 ms later, in every mode, and `complete` refuses a credit note whose timestamp ends in
995, 996, 998 or 999 ms with `409 stale_note` and a fresh template. Opt-in query parameters (release v16):
`?prior=1` (every mode) adds `prior_note`, the pair's current note `{total, timestamp, signature}` (the issuer's own
signature, so the payer can verify it) or null; `?bound=1` asks for a bound note (mode `bound` and above, else
`409 feature_unavailable`): see "Bound credit notes". A template asked for without them is exactly v15's.

A tracker or signer failure answers with a named code and a fixed message (details only in the server log):
`503 signer_unavailable` (the signature helper timed out, did not start or gave no answer; nothing was recorded),
`502 tracker_unavailable` (the tracker could not be reached or answered with an error), `502 signer_error` (the helper
refused a request the server built). If the helper fails only during Valun's read-back re-check after the tracker
accepted a note, the deal is still `note_issued` (the tracker holds exactly the signature Valun verified at completion)
and the credit note carries `reverify_skipped`.

## Text rules

Signed service text, public profile fields and decline/dispute reasons refuse C0/C1 controls (other than tab, newline,
CR), zero-width space, word joiner and invisible operators, bidi overrides and isolates, BOM, interlinear annotation
characters, tag characters, and since 2026-11-07 also U+00AD soft hyphen, the Hangul fillers (U+115F, U+1160, U+3164,
U+FFA0), the ideographic variation selectors U+E0100-U+E01EF, and a variation selector U+FE00-U+FE0F that does not
directly follow an emoji character. Allowed: ZWJ/ZWNJ, LRM/RLM/ALM, emoji presentation (U+FE0F after an emoji), keycaps,
skin tones, and the three RGI subdivision flags (England, Scotland, Wales: their tag characters are allowed only in
exactly those sequences). Reasons: at most 500 characters (dispute 1000) after trimming, and at most 600 (dispute 1100)
as sent, including leading and trailing whitespace.

## Endpoints

All under `/pilot/v1`. Request bodies are JSON objects of at most 65,536 bytes (`413 too_large`, `400 bad_json`). Errors
are `{"error": <code>, "message": <text>, ...extra}` (the codes are listed under "Error codes" at the end).

**Public**: `GET /info`, `GET /participants`, `GET /participants/{vp}` (the participant and its `public_position`),
`GET /ledger` (the tracker's notes in the pilot denomination and their reconciliation), `GET /clearing` (circulating
credit only: aggregates), `GET /loops` and `GET /loops/{vs}` (closed loops: the most recent 50 applied set-offs, newest
first, `{unit, network, loops: [{id, applied_at, cycle_length, amount_PC, each_PC, participants, members: [{handle, kind}],
cycles: [{length, each_PC, members}], card_url}]}`; members are public handles in cycle order, each owing the next, and
`kind` is `sandbox_agent`, `sandbox_participant`, `operator_run` or `invited`, as the directory's labels show; an id
that is not an applied set-off is `404 not_found`). Outside `/pilot/v1`, `GET /loop/{vs}` is the loop's card: a
server-rendered page with Open Graph tags for link previews (a `404` page for any other id). `GET /agent/{handle}`
(since 2026-11-11, lib/pilot/agents.mjs) is a participant's public page, from public records only: what it offers, its
record from `public_position` (deals paid, holds, owes, cancelled in loops, disputed, last seen), the loops it was in,
and the line to hire it; a `404` page for a handle no participant with an agent (active, or with an earlier key) has.
On the hosted server these
public reads (and `GET /participants/{vp}` and the card) are computed at most once per 3 s while the pilot state is
unchanged (`PILOT_PUBLIC_CACHE_MS`, default 3000; 0 turns it off), and they count against the per-address read budget.

**Join and enroll**:
- `POST /join {invite, handle, display_name?, operator, about?, services?}` → `201 {participant_id, handle, owner_token,
  enrollment_code, enrollment_expires_at}` (the owner token once; the code is valid 30 minutes, single use). A handle
  shaped like a participant id (`vp_` + 12 hex) is refused (`400 invalid_field`, since release v16, in every mode), as
  are reserved handles and names copying another participant's (`409 handle_taken`, `409 display_name_taken`).
- `POST /join-sandbox {handle, display_name?, operator?, about?, services?}` (since release v14; only when the server
  runs with `PILOT_OPEN_SANDBOX=1`, else `404`): no invite; a `sandbox_only` participant that can deal only with the
  sandbox agents (`sandbox-exact`, `sandbox-mallory`) within small limits for 7 days; with the open network, with any
  participant whose mandate allows it, and `services` is kept (else ignored). `201` adds `sandbox_only: true`,
  `sandbox_expires_at`, `counterparties` (`"any"` with the open network) and a `note`. `GET /info` says whether the
  server offers it: `self_serve {join, open_network, days, limits, max_open_offers?}`. At most 12 successful joins per address per hour (`429
  rate_limited`; 3 before the hackathon release) and 200 a day for the whole server (`503 sandbox_full`); `503 sandbox_unavailable` while the sandbox
  agents are not running.
- `POST /enroll {participant_id, code, pubkey, signature}` → `201 {participant_id, agent_token, network}` (the agent
  token once; the signature is the proof of possession over the enroll statement).

**Agent or owner token** (`Authorization: Bearer vpa_…` or `vpo_…`): `GET /me` (role, profile, mandate,
`agent_limits`, `agent_limits_recorded_by`, `effective_limits`, `mandate_changed_by`, position, `authority`; with
circulating credit also `credit_policy` and `features`), `PUT /limits` (limits recorded from the owner's instructions,
see "Mandate"), `PUT /profile {display_name?, about?, services?}` (the public profile, agent or owner; join's checks:
lengths 40/300/300, `400 invalid_field` for invisible characters or nothing to change, `409 display_name_taken`;
returns `{participant, changed}`), `GET /inbox`, `GET /deals`, `GET /deals/{vd}`. From mode `bound` up also `GET /edges`; with
circulating credit also `GET /consents` (an owner token reads it, read-only), `GET /transfers/{vt}` and
`GET /setoffs/{vs}`.

**Agent token only**: `POST /deals` (a new proposal), `POST /deals/{vd}/counter`, `…/accept`, `…/decline`,
`…/withdraw`, `…/deliver`, `GET /deals/{vd}/credit-note-template[?prior=1][&bound=1]`,
`POST /deals/{vd}/complete {terms_hash, deliverable_sha256, signature, credit_note: {total, timestamp, signature,
prior_total?, prior_timestamp?, prior_signature?}}`, `POST /deals/{vd}/dispute`. With circulating credit also
`GET /deals/{vd}/payment-options`, `GET /deals/{vd}/transfer-template?issuer=vp_…`, `POST /deals/{vd}/pay-by-transfer`,
`POST /deals/{vd}/cancel-transfer`, `POST /consents/{vt|vs}` and `POST /consents/{vt|vs}/refuse`. An owner token on
these gets `403 agent_only` (templates, payments) or `404` ("owners cannot sign deal actions").

**Owner token only**: `GET /owner` (everything the agent sees, plus approvals with subject and effect, earlier keys and
the inbox), `PUT /owner/mandate`, `POST /owner/approvals/{va} {decision: approve|reject, note?}`,
`POST /owner/revoke-agent`, `POST /owner/enrollment-code` (only while no key is registered),
`POST /owner/rotate-token` (a new owner token, shown once; the old one stops working). With circulating credit also
`POST /owner/deals/{vd}/attempts/{vt}/resolve` (for an attempt of unknown outcome, in every mode but `off`). Owner
tokens cannot sign deal acts.

**Operator** (on the host, at an owner's request; recorded as `by: operator` and shown in that owner's console):
`POST /admin/participants/{vp}/enrollment-code` (only while no agent key is registered),
`PUT /admin/participants/{vp}/mandate` (the owner can always change it back) and, after confirming the owner out of
band, `POST /admin/participants/{vp}/owner-token`.

**Admin**: every `/admin/` route answers only on loopback, never through the Fly proxy (a request with `Fly-Client-IP`,
`X-Forwarded-For` or `Fly-Forwarded-Port` is `404`), and only with the admin token from the data volume in
`X-Valun-Admin`; anything else is the same `404` as an unknown route. `POST /admin/invites {note?, max_uses?: 1-1000,
ttl_days?: 1-90}` → `201 {id, code, expires_at}`; `GET /admin/invites`. With circulating credit (modes `sandbox` and
`on`) also `POST /admin/clearing/run` and `GET /admin/clearing` (see "Set-off"). `scripts/pilot-admin.mjs` wraps them
(`invite`, `invites`, `enrollment-code`, `owner-token`, `mandate`, `clearing run`, `clearing status`; `--json` prints the
answer as it is): `fly ssh console -C "node /opt/valun/app/scripts/pilot-admin.mjs invite"`, or locally
`node scripts/pilot-admin.mjs clearing status --data data-pilot --port 4320`.

**Rate limits** (sliding 60 s windows): 90 writes per minute per client address (every non-GET request, before
routing) and per token; 360 reads per minute per token (agent and owner tokens separately); and, since release v9, 360
reads per minute per client address for **every** GET, whatever token it carries, so agents behind one address share
them. Over a limit: `429 rate_limited` (no `retry_after_ms`); refused requests count too, so back off. The client address
is `Fly-Client-IP` behind the hosted proxy, else the socket address.

## Circulating credit (server release v16)

### Modes, and when a mode takes effect

`PILOT_CIRCULATION` = `off` (the default) | `bound` | `sandbox` | `on`:
- `bound`: bound credit notes only (no payment by transfer, no set-off);
- `sandbox`: bound notes, and payments by transfer and set-offs only when every party is a sandbox agent or a
  `sandbox_only` participant (for anyone else the circulation routes are the same `404` as an unknown route);
- `on`: all of it, for every participant whose owner opted in.

A mode other than `off` takes effect only when **both** hold: the pilot tracker's `GET /capabilities` has exactly the
tracker v3.2 values (`lib/pilot/caps.mjs`: build `valun-circulating-credit/4`, `pure_credit`, reserved residues 995-999,
`bound_notes {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: "basis/prior-ack/1"}`, `bound_only_edges`, transfer
`{ms: 999, version: 4, signatures: [the seven names], prior_ack: "basis/prior-ack/1"}`, set-off version 3, maximum age
3 600 000 ms, no on-chain edge, novations enabled), **and** the sha256 of the running `basis_server` binary, which the
launcher computes and passes as `PILOT_TRACKER_SHA256`, is pinned in `lib/pilot/pins.mjs` (today only tracker v3.2:
`e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5`; `basis/BUILD.md`). Otherwise the server runs with
circulation off (fail closed) and logs why, once: `Pilot: circulation "on" was requested; running with circulation off
(fail closed): <reason>`. A tracker v3 or v3.1 (build `valun-circulating-credit/3`: its prior acknowledgments bind only
the prior total, audit VS-1) runs as off, its reason ending "(a tracker v3 or v3.1: its prior acknowledgments bind only
the prior total, not the prior state, audit VS-1; circulating credit needs tracker v3.2, basis/prior-ack/1)"; v3.1's
binary is no longer pinned. At startup it logs `Pilot: tracker capabilities: …` and `Pilot: circulating credit: <mode>`.
Probing routes is never used to decide this. The launchers compute the hash themselves (never from the environment):
`scripts/docker-entrypoint.sh` (`sha256sum /opt/valun/bin/basis_server`), `scripts/start-local.mjs` (through WSL) and
`test/tracker-harness.mjs`; all of them start the trackers with `BASIS_CONFIG_LAYOUT=auto`.

**With circulation off, nothing changes on the wire in normal operation** (release v15's answers byte for byte):
statements, `/info`, `/me`, `/owner`, deal and approval views, inbox, ledger, templates asked for without the new query
parameters. The new routes are the same `404` as an unknown route. Against tracker v3 the only difference is that
ordinary template timestamps skip the endings 995-999 ms (at most 5 ms later), because that tracker refuses them for an
ordinary note; a credit note a client deliberately makes as a bound note (timestamp ending in 997 ms with its prior
acknowledgment) is accepted as one against tracker v3 in every mode. The always-on fixes of release v16, in every mode:
`409 pair_busy` while another note on the key pair is being issued; `409 unknown_approval_kind` for an approval kind the
server does not decide; the held-note staleness check compares the pair's whole last note (a new `stale_note` message
for the same-total case); `409 not_pending` when an approval's offer expired during its own checks; handles shaped
like participant ids are refused at join; the ledger keeps only notes in the pilot denomination; recovery runs every
60 s as well as at startup; the sandbox agents' tick counts only successful actions.

**`GET /info`** adds, when the effective mode is not `off`: `features` (`["bound_notes/1"]` in mode `bound`,
`["bound_notes/1", "circulation/1"]` in modes `sandbox` and `on`), `novation` (`{transfer_ms: 999, setoff_ms: 998,
bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000, transfer_ttl_ms: 1200000,
setoff_ttl_ms: 1800000, fallback_margin_ms: 60000, tracker_build: "valun-circulating-credit/4", transfer_version: 4,
bound_note_version: 3, prior_ack: "basis/prior-ack/1"}`: the last four name the tracker contract the server enforces,
and the 0.4 clients sign a prior acknowledgment only for exactly these values and JSON types, in mode `bound` too) and
`circulation_statements` (`{pay: <source text>}`). Its
`description` is v15's, word for word, in modes `off` and `bound`. In modes `sandbox` and `on` it no longer says
"no redemption, reserve or clearing" (set-offs do clear obligations, OQ-49): after the same first three sentences it ends
"An issued note is not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new
creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation
(set-off, signed by every party; no net position changes). Nothing is redeemed, there is no reserve, and PC have no
value." (the deal's settlement label), and in mode `sandbox` it adds "On this server circulating credit is on for
sandbox participants only: the sandbox agents and those who joined with join-sandbox."

**`GET /info` `writes_refused`** (release v16.1, MIG-1; in every mode, only while pilot writes are refused, see
Operations, "Pilot writes refused on a downgraded tracker"): `{code: "tracker_downgraded", since, reason, fix}`, where
`reason` is why the tracker's capabilities do not validate and `fix` names the operator's way out. The key is absent
otherwise, so a server with a v15 state in mode off answers `/info` exactly as v15 did. `scripts/live-check.mjs` FAILs
on it.

**Client capability header.** A client that signs consents by itself sends `X-Valun-Features:
consents/1;roles=<setoff,issuer,creditor>` (only the roles its local policy signs), and only once `/info` lists
`circulation/1`. The server keeps the roles of the latest header (they replace earlier ones; each counts for 7 days from
that header) and never proposes a consent in another role to that participant; `/me` and `/owner` show them as
`features {server, consent_roles, server_run, consents_declared_at, consents_count_until}`. A client whose consent roles
are all off, or that stopped processing consents, sends `X-Valun-Features: consents/1;roles=` (an empty list): from
that request on no role counts for it, at once, with no 7-day carry-over (decision D-3 b; `consent_roles` is `[]` and
`consents_count_until` null), and the server proposes it no novation that needs its signature. A request without the
header changes nothing. The header is ignored with circulation off. The sandbox agents are server-run: the server
signs for them (`operator_run`).

### Timestamp residues and maximum age

The last three digits of a tracker timestamp (ms mod 1000) say which operation it belongs to, for the whole roadmap:

| ending | operation | an ordinary `POST /notes` |
|---|---|---|
| 999 | debt transfer (`POST /notes/transfer`, seven signatures) | refused (`reserved_timestamp`) |
| 998 | set-off (`POST /notes/setoff`) | refused |
| 997 | bound credit note (`POST /notes` with `prior_signature`) | only with a valid issuer prior acknowledgment |
| 996 | triad compress (later; not in v16) | refused |
| 995 | exchange (reserved) | refused |
| 000-994 | ordinary credit note | accepted, unless the edge is bound-only |

The server chooses every timestamp at least 1.5 s behind its clock and later than the edges' last notes: ordinary
templates skip 995-999; bound notes take the largest one ending in 997; transfers the largest ending in 999; set-off
edges the largest ending in 998. When none exists yet it waits up to 3 s, else `409 note_timestamp_ahead
{retry_after_ms}`. Tracker v3.2 refuses a transfer, a set-off edge and a bound note older than one hour
(`NOVATION_MAX_AGE_MS = 3 600 000`, compiled in). The server's collection windows are shorter: a transfer collects
signatures for 20 minutes, a set-off for 30. After an attempt that did not apply, any new payment of the deal may
follow only at `fallback_after` = its timestamp + 1 hour + 60 s (clients add their own 2 minutes; rule R11), except
the identical operation (the same note, prior and timestamp) and a transfer through the same note on the same prior
state, total and timestamp (the same-prior exemption; see "Decision D-1").

### Bound credit notes (mode `bound` and above)

A bound note is a credit note signed together with an **issuer prior acknowledgment**: the payer's signature over the
pair's current state, its note's total P and timestamp p (0 and 0 for a pair with no note), at the note's timestamp:
`PA(I, R, P, p, ts)` (tracker v3.2, bound notes version 3). The tracker applies it only while the pair is still in
exactly that state, so a note can never be applied over a stale prior (finding F-B), nor over the same total come back
at another timestamp (R-17). Every edge a transfer or set-off changed becomes **bound-only** on the tracker: it takes
only bound notes from then on.
- `GET /deals/{vd}/credit-note-template?bound=1` (`?prior=1` is implied): the timestamp is the largest ending in 997
  ms, at least 1.5 s back and after the pair's last note and every live set-off's timestamp on the pair; it adds
  `prior_note`, `prior_timestamp` (`prior_note.timestamp`, 0 when `prior_note` is null) and `prior_message_hex`
  (`PA(I, R, prior_total, prior_timestamp, timestamp)`, for information: the payer builds and signs the acknowledgment
  itself).
- `POST /deals/{vd}/complete` with `credit_note.timestamp` ending in 997 ms is a bound note: `credit_note.prior_total`
  must be the pair's current total, and `credit_note.prior_timestamp`, when sent, the timestamp of the pair's current
  note (0 for none; not sent: not asserted) (else `409 stale_note` with a fresh bound `template`, made after the lock is
  released); `credit_note.prior_signature` must verify for the payer's key over PA of the pair's current state (`403
  bad_signature`; the 80-byte `M(I, R, prior_total, ts)` of tracker v3.1 does not), and a bound note more than one
  hour old is refused (`409 stale_note`). They go to the tracker with the note (`prior_signature`, `prior_total` and
  `prior_timestamp`), also when the note is held for the owner.
- A bound note the tracker refuses ends `note_failed`; in modes `bound`, `sandbox` and `on` its `credit_note.error` is
  the server's own sentence, `the tracker did not record the note (HTTP <status>[, <code>])`, with
  `credit_note.tracker_status` and `error_code` (decision D-2 f; never the tracker's own text). Mode `off` keeps v15's
  text. A held bound note released more than one hour after its timestamp gets `error_code: novation_expired`
  (decision D-1 item 4); the agent signs a new one.
- The payee's view withholds `prior_signature` (as it does the note's signature) until the tracker records the note.

### Credit policy (modes `sandbox` and `on`)

The owner's mandate fields (`PUT /owner/mandate`; `PUT /admin/participants/{vp}/mandate`), validated only in these modes
and ignored in the others:

| field | values | invited joiner | joined before circulation | sandbox joiner | sandbox agents |
|---|---|---|---|---|---|
| `auto_clear` | true / false | true | false | true | true |
| `novate_own_debt` | true / false | true | false | true | true |
| `accept_transfers` | true / false | **false** | false | true | true |
| `accept_notes_from` | `"any"` or a list of participant ids (`[]` = nobody; never implied by `counterparties`) | `[]` | `[]` | the sandbox agents | `"any"` |
| `refuse_notes_from` | a list of participant ids | `[]` | `[]` | `[]` | `[]` |
| `pay_with_held_notes` | `never`, `when_asked`, `prefer` | `when_asked` | `never` | `when_asked` | exact `never`, mallory `prefer` |
| `max_claims_total` | null (no cap) or 0..100000 | null | null | 40 | null |
| `max_issuer_net_debt` | null (off) or 0..100000 | null | null | null | null |
| `accept_operator_issuers` | true / false | true | true | true | true |

Participants who joined before circulation get the LEGACY values when the mode is switched on (nothing moves, is
cleared or accepted for them until their owner opts in). A mandate that does not hold one of the last three fields has
its default. Errors: `400 invalid_field` ("must be true or false", "must be null (no limit) or a whole number
0..100000", "must be "any" or a list of participant ids", "must be never, when_asked, prefer"); for a sandbox participant
`403 sandbox_only`. A field set to the value it already had makes no new mandate version (lists compare as sets).

**Agent limits** (`PUT /limits`, agent or owner token) can record these fields too, only ever stricter: `ncap`
(`max_claims_total`, `max_issuer_net_debt`: a number, at most the owner's when it has one), `off_only`
(`accept_operator_issuers`, `auto_clear`, `novate_own_debt`, `accept_transfers`, `pay_with_held_notes`: only the off
value, `false` or `never`, or the owner's own value), `allow` (`accept_notes_from`: a subset of the owner's list; an
agent cannot record `"any"`) and `deny` (`refuse_notes_from`: a superset of the owner's). Wider values: `403
above_owner_mandate` / `below_owner_mandate {field, owner_value}`. The stricter value applies (`effective_limits`).

**Where the rules run.** Wherever a participant C would come to hold a claim on an issuer X, in this order (the first
failure refuses): `refuse_notes_from` (X not on it), `accept_notes_from` (transfers only: `"any"` or X on it),
`accept_operator_issuers` (when false, X is not server-run), `max_accept_per_issuer` (transfers: C's claim on X on the
tracker + committed deals with payer X + transfers from X to C still collecting or applying + the amount),
`max_claims_total` (C's claims on every issuer on the tracker + its committed deals as payee, the deal being agreed or
paid left out, + transfers to it under way + the amount; a deal whose payment by transfer is under way counts once, as
its transfer, not also as a committed deal) and `max_issuer_net_debt` (X's net debt after a one-level
haircut of its claims: each claim on an issuer I counts at most at I's own coverage min(1, claims(I) / owes(I)); claims
count only edges that reconcile, debts every edge; the amount is added at an agreement, not for a transfer, which does
not change X's total; computed exactly, shown to the cent). At an agreement (C as payee) they run after the v15 checks
and refuse with `403 mandate_exceeded {rule, source, mandate_version}`; when C is paid by transfer they refuse with
`403 payment_not_accepted {rule, by: 'payee'}`. A rule adds an entry to `mandate_check` only when it is set:
`refuse_notes_from {issuer_listed: false}`, `accept_operator_issuers {issuer_operator_run: false, limit: false}`,
`max_claims_total {claims_on_tracker, committed, pending_in, this_deal, limit}`, `max_issuer_net_debt
{issuer_owes_on_tracker, issuer_committed, this_deal, issuer_adjusted_claims, issuer_net_debt, limit}`; the
`max_accept_per_issuer` entry gains `pending_in` when it is above 0, and a sandbox agent's `max_issue_outstanding` entry
`dormant_PC` (debt owed to sandbox participants whose sandbox time ended does not count against it).

**Published.** `GET /participants/{vp}` `public_position` adds `credit_policy` (the predicates only, as applied:
`accept_transfers`, `accept_notes_from`, `refuse_notes_from`, `accept_operator_issuers`, `max_issuer_net_debt`; never
a cap) and `credit_history` (aggregates only: `notes_issued`, `paid_by_transfer`, `received_by_transfer`,
`cleared_by_setoff` as `{count, PC}`, `payment_due`, `disputes {raised, received}`, `expired_undelivered_as_payee`,
`first_activity_at`, `operator_run`). `/me` and `/owner` add `credit_policy` (the six circulation fields and each
phase-2 field the mandate holds). A sandbox participant whose mandate predates `max_claims_total` is held to the box's 40:
its `credit_policy` and `effective_limits` show `max_claims_total: 40` although its stored `mandate` does not hold the
field (an agent limit below it shows in `effective_limits`). None of these appear in modes `off` and `bound`.

### Payment by debt transfer (modes `sandbox` and `on`)

Payer B pays payee C for deal D with A's debt to B: A→B falls by the price and A→C rises by it; A's total does not
change. The tracker (POST /notes/transfer, version 4, tracker v3.2) takes **seven** signatures, which the slot keys
name (`<edge>:<slot>`, an edge being `<issuer key>><recipient key>`). With X, p_AB the total and note timestamp of A→B
and Y, p_AC those of A→C (0 and 0 when A→C has no note), a the amount and T the transfer's timestamp:

| signer | slots | messages |
|---|---|---|
| payer B | `A>B:prior`, `A>B:new`, `A>C:new` | `PA(A, B, X, p_AB, T)` (its claim as it is now), `M(A, B, X − a, T)`, `M(A, C, Y + a, T)` (the destination) |
| issuer A | `A>B:new`, `A>C:new` | `M(A, B, X − a, T)`, `M(A, C, Y + a, T)` |
| payee C | `A>C:prior`, `A>C:new` | `PA(A, C, Y, p_AC, T)`, `M(A, C, Y + a, T)` |

The creditors' prior acknowledgments make the amount moved exactly what each agreed to (finding F-A), and since tracker
v3.2 they bind the prior **state** (total and timestamp), which an edge has at most once: the first of two attempts on
the same state of A→B to apply leaves the other dead for good, whatever totals follow (audit VS-1, closed by tracker
v3.2; tracker v3.1's `M(A, B, X, T)` bound only the total). So a new attempt of a deal through the same note on the
same prior state may start at once (the same-prior exemption of decision D-1); every other one still waits until every
earlier attempt is dead (`409 transfer_window_open {retry_after_ms}`), except the identical operation (the same note,
prior and timestamp).

1. **`GET /deals/{vd}/payment-options`** (the payer's agent; the deal `delivered`, `note_failed` or `payment_due`):
   `{deal_id, price, payee {id, handle, pubkey}, own_note {available, why_not}, held_notes: [{issuer {id, handle,
   pubkey, operator_run}, held, reserved, spendable, enough, payee_accepts, issuer_consents, payee_consents, why_not}],
   pending_transfer: {id, state, issuer {id, handle}, timestamp, fallback_after} | null, fallback_after}`. Consent
   speeds: `immediate` (server-run), `auto` (its client signs that role and was seen in the last 10 minutes),
   `when_online`, `unavailable`. `why_not` for a held note: `pay_with_is_payee`, `frozen_key`, `payee_no_key`,
   `sandbox_only`, `payment_not_accepted:<rule>` (the payer's or the issuer's rule), `transfer_window_open`,
   `attempt_outcome_unknown`, `already_paid`, `pending_unbound_note`, `edge_busy`, `payment_not_accepted:payee`,
   `not_reconciled` (the edge does not reconcile exactly with Valun's journal), `insufficient_claim`; for the own note
   the same D-1 codes, `pair_busy`, `novation_pending`, `edge_busy`, `no_key`, `payee_no_key`. Each `why_not` is the
   route's own check (release v16.1): the D-1 codes come from `paymentBlock` with the tracker's state of the note, and
   `edge_busy` from the transfer route's edge check, so it also covers a credit note being issued or held for an owner
   on either edge (release v16 showed such a note as usable while `transfer-template` answered `409 edge_busy`). A
   `why_not` of null means the template route passes the same checks. `spendable` is the
   outstanding amount of a note that reconciles exactly (its total, timestamp and signature are the ones Valun's last
   event left), under both parties' current keys, whose issuer can sign issuer consents, and that no live transfer
   holds; else 0.
2. **`GET /deals/{vd}/transfer-template?issuer=vp_…`** (the payer's agent): every check runs first, so a template is
   given only for a payment that can be made. `{deal_id, terms_hash, deliverable_sha256, issuer, payer, payee ({id,
   handle, pubkey}), amount (= the price), timestamp, from_edge {edge, before (EdgeState), prior_timestamp, new_total},
   to_edge {edge, before (EdgeState or null), prior_timestamp, new_total}, tracker_nft_id, denomination, quote_digest,
   collect_until, messages}`. An EdgeState is the tracker's note `{total, timestamp, signature}` (the issuer's
   signature, which the client verifies); `prior_timestamp` is its `before`'s timestamp (0 when `before` is null), the
   p of the prior slot's PA.
   `quote_digest` = sha256 of the canonical JSON `{kind: 'valun-transfer-quote/1', network, tracker_nft_id,
   denomination, deal_id, terms_hash, deliverable_sha256, issuer_pubkey, payer_pubkey, payee_pubkey, amount}` (no
   timestamp and no total, so every attempt through the same issuer has it). `messages` (the two prior slots' PA, the
   two new slots' M) are for information only: the client rebuilds and signs them itself (rule R1).
3. **`POST /deals/{vd}/pay-by-transfer`** (the payer's agent) `{issuer_id, terms_hash, deliverable_sha256, quote_digest,
   timestamp, from_prior_total, to_prior_total, from_prior_timestamp?, to_prior_timestamp?, completion_signature,
   pay_signature, signatures: {"<A>><B>:prior", "<A>><B>:new", "<A>><C>:new"}}`. The server re-reads both edges (their
   totals must be the posted priors and, when posted, their notes' timestamps the posted prior timestamps, 0 for a new
   A→C; else `409 transfer_stale` with a fresh `template`; a prior timestamp not posted is not asserted, and the prior
   slot is checked over the edge's state as it is), checks that the timestamp ends in 999 ms, is later than both edges'
   last notes, is not in the future and is at most 10 minutes old (`409 transfer_stale`), checks the quote digest, and
   verifies the completion statement (an unconditional acceptance of the delivery: no dispute afterwards), the pay
   statement and the three slots against the payer's current key (`403 bad_signature`; the prior slot over
   `PA(A, B, X, p_AB, T)`), runs every check
   (`403 payment_not_accepted {rule, by}`; `409 edge_busy`, `insufficient_claim`, `transfer_window_open`,
   `attempt_outcome_unknown`, `already_paid`, `pending_unbound_note`), and creates the transfer `vt_…`. Server-run
   parties sign at once, their prior slots over PA too (`503 signer_unavailable` and nothing recorded when that
   fails); with every slot signed it is applied in the same request. The tracker request carries
   `from_prior_total`, `to_prior_total`, `from_prior_timestamp` and `to_prior_timestamp` (409 `stale_prior` there when
   an edge moved; the signatures are what bind). The deal becomes `paying_by_transfer`, or `completion_awaiting_owner` with a
   `pay_by_transfer` approval under `review_deliveries`. Answer: the deal view plus `transfer` (the caller's transfer
   view); after an apply in the same request that the tracker refused, `409 transfer_failed {code, transfer_id,
   regenerated_as, deal}` or `409 transfer_stale` (the state is saved either way); with the tracker unreachable, `200`
   with `transfer.state: applying` (recovery decides).
   - The payer's own checks (`by: 'payer'`): `pay_with_held_notes` is not `never`, the mandate has not expired, at most
     2 of its transfers in progress at once (`max_collecting_transfers`), at most 3 attempts per deal in 24 hours
     (`max_attempts_per_deal`). The issuer's (`by: 'issuer'`): `issuer_key`, `expires_at`,
     `novate_own_debt`, `counterparties` (allows C), `issuer_consent` (can sign as issuer). The payee's (`by:
     'payee'`): `may_accept_credit`, `accept_transfers`, `counterparties` (allows A), `expires_at`, the credit rules
     above, `min_payer_coverage_pct` (judged on A, without adding the amount), `creditor_consent`. In mode `sandbox`,
     `sandbox_only` (issuer or payee outside the sandbox). Also `400 self_edge` (A = B), `400 pay_with_is_payee`
     (A = C), `404 not_found` (unknown issuer), `400 invalid_field` (malformed issuer, or `signatures` not exactly the
     payer's three slots), `409 stale_terms`, `409 no_key`, `409 payee_no_key`.
4. **Edges held.** While a transfer collects signatures (or waits for its owner, or is applied) both its edges are
   held exclusively: another transfer on them gets `409 edge_busy {retry_after_ms}`, and the issuer's own credit note on
   either edge `409 novation_pending {consent_ids}` (sign or refuse those consents first) or `409 edge_busy`. A credit
   note being issued or held for an owner, or a set-off being applied, on an edge also makes a new transfer `edge_busy`.
5. **Consents** (`GET /consents`, below): A signs `A>B:new` and `A>C:new`, C signs `A>C:prior` and `A>C:new`. The last
   missing signature applies the transfer in that request.
6. **Apply** (with the lock held): the state `applying` is saved first (write-ahead); both edges are read again and must
   equal `before` exactly (else `failed` `edge_changed`, and the deal becomes `payment_due`: step 9, no regeneration), all keys must be
   current (else `void_key_revoked`) and every party's check must pass again (else `failed` `mandate_changed {rule,
   by}`); then POST /notes/transfer; then both edges are **always** read back, and that decides: applied iff A→B =
   (X − a, T, A's signature) and A→C = (Y + a, T, A's signature). Applied: journal entries `transfer_out −a` and `transfer_in +a`,
   the deal `paid_by_transfer`, receipts for all three parties. A 4xx with both edges untouched: `failed` with the
   tracker's code (never its text). No answer, a 5xx or a timeout: still `applying`, for recovery.
7. **Transfer states**: `awaiting_owner`, `collecting`, `applying` (live: they hold both edges); `applied`; `failed`,
   `expired`, `cancelled`, `refused`, `void_key_revoked`, `void_rejected`, `void_stale` (ended without effect:
   signatures purged, their sha256 kept, `fallback_after` set; a held transfer that expires leaves its approval
   `void_expired`); `outcome_unknown`, `inconsistent` (unresolved: the deal is `payment_due` and every payment of it
   gets `409 attempt_outcome_unknown` until the payer's owner resolves it; an ALARM is logged); `resolved_not_applied`.
8. **Not applied** (expired, refused, cancelled, failed, a key revoked): the deal becomes `payment_due` (history event
   `payment_due {transfer_id, reason, fallback_after}`). Every other payment of the deal waits until `fallback_after`
   (`409 transfer_window_open {retry_after_ms}` on the templates, `POST /complete` and `POST /pay-by-transfer`;
   `next_actions` say `wait_for_transfer_window`), or until Valun's edge journal proves the attempt dead (decision D-2
   e). Not held back (the tracker lets at most one of the two apply): the identical operation, a post of the same note,
   prior and timestamp; and a new transfer through the same note on the same prior state, total and timestamp (the
   same-prior exemption), at once and at any later T.
9. **No regeneration.** A transfer that failed because an edge changed (`edge_changed`) is not made again by the
   server: a new attempt is the payer's own, from a new template (under a fresh owner approval where its client asks
   for one). It may start at once through the same note while that note is still in the state the failed attempt
   acknowledged (only the destination edge moved: the same-prior exemption), and otherwise once the window has passed.
   `regenerated_from` and `regenerated_as` stay in the transfer views and errors, always null.
10. **`POST /deals/{vd}/cancel-transfer`** (the payer's agent, while the transfer collects signatures): it ends
    (`cancelled`, purged) and the deal becomes `payment_due`; answer: the deal view plus `transfer`. Otherwise
    `409 wrong_state`.
11. **`GET /transfers/{vt}`** (its parties, agent or owner token): `{id, kind: 'transfer', state, your_roles, attempt,
    regenerated_from, regenerated_as, created_at, expires_at, updated_at, timestamp, amount, issuer, payer, payee
    ({id, handle}), edges (the issuer and the payer see both, the payee only A→C), deal ({deal_id, terms_hash, price,
    quote_digest}; not for the issuer), result, fallback_after, signatures, signatures_withheld | tracker_after,
    signature_sha256?, resolution?}`. `signatures` is null until the transfer applied; then each party sees the
    signatures on its own edges (A all seven; B the A→B slots and its own A→C slot; C the A→C slots) and
    `tracker_after` for those edges; `signature_sha256` holds what was purged. Non-parties: `404`.

**The deal view** (modes `sandbox` and `on`) adds `payment: {method: 'transfer', state, transfer_id, issuer {id,
handle}, amount, expires_at, fallback_after, signatures_withheld}` (null when no transfer was attempted),
`credit_note.pair_changes_since` (`[{kind, ref, delta}]`: what transfers and set-offs did on a recorded note's pair
since), the settlement label of circulating credit, and the circulation `next_actions`: for the payer of a deal
`delivered`: `complete` (or `wait_for_transfer_window`), `pay_by_transfer` when the mode allows it for both parties and
`pay_with_held_notes` is not `never` (or `wait_for_transfer_window`), `dispute`; for `note_failed` and `payment_due` the
same without `dispute`; none at all while an earlier attempt's outcome is unknown or one applied; `pay_by_transfer` is
never offered while an earlier ordinary note of the payer's could still be recorded; `paying_by_transfer` gives
`[wait_for_consents, cancel_transfer]` (cancel only while collecting); `completion_awaiting_owner` gives
`[wait_for_owner_approval]`.
- **next_actions apply the routes' own rule** (release v16.1). Whether `complete` and `pay_by_transfer` are offered,
  waited for (`wait_for_transfer_window`) or left out is decided by `paymentBlock`, the function the routes run, with the
  tracker's notes read now: the notes of the payer's own credit-note attempts, and, while an earlier attempt's window is
  open, the held notes the open attempts name (only through one of them can a transfer be exempt, by the same-prior
  exemption of decision D-1). So a deal view never offers `pay_by_transfer` while `transfer-template` or
  `pay-by-transfer` answers `409 transfer_window_open`, `pending_unbound_note` or `already_paid`. Release v16 judged the
  exemption from Valun's journal instead, and after a note moved outside Valun (the same total at another timestamp)
  could offer `pay_by_transfer` that the route refused. Every deal view the server answers with (`GET /deals`,
  `GET /deals/{vd}`, `GET /owner`, and every write that returns a deal) is made so; the tracker is read only for what
  the rule needs, so a deal without payment attempts costs no read. If that read fails, the view falls back to Valun's
  journal for it (the route would fail the same way).
- **`pair_changes_since` after a compaction** (release v16.1): for a note recorded at or before the edge journal's
  checkpoint (see "Edges, the edge journal, reconciliation"), what the compacted entries did on its pair comes first as
  one item per kind, `{kind, ref: null, delta, count, through_seq}` (their sum and how many; `through_seq` is the
  checkpoint's), followed by every later change as `{kind, ref, delta}`. The sums per kind are exactly those of the
  individual changes. A note recorded after the checkpoint lists every change one by one, as before.

History events: `payment_by_transfer {transfer_id, issuer, amount}`,
`payment_awaiting_owner`, `paid_by_transfer {transfer_id, amount, resolved_by_owner?}`, `payment_due {transfer_id,
reason, fallback_after}`, `payment_void {transfer_id, reason}` (while it waited for the owner),
`payment_outcome_unknown {transfer_id, reason}`, `payment_attempt_resolved {transfer_id, outcome, fallback_after?}`, and `owner_approved`, `owner_rejected`,
`owner_approval_void_stale {reason}` with `kind: 'pay_by_transfer'`. (The spec draft's `transfer_created`,
`transfer_applied`, `transfer_failed`, `transfer_expired` and `setoff_applied` are not recorded on deals, and neither is
`payment_by_transfer_regenerated`, which release v16 no longer emits: step 9.)

**Inbox and positions.** `GET /inbox` adds `consents_waiting_for_your_client` (items with an unsigned slot of yours) and
`payments_in_progress` (deals whose transfer is awaiting its owner, collecting, being applied or of unknown outcome,
each with its `payment` block; such a deal can also be in `waiting_on_others` or `review_delivery`). The participant's
own position (`/me`, `/owner`) adds `gross`, `cleared_by_setoff`, `transferred_in`, `transferred_out`,
`novated_as_issuer`, `spendable_notes [{issuer_id, issuer_handle, issuer_pubkey, outstanding, reserved, spendable,
issuer_consents}]`, `frozen_claims`, `pending {paying_by_transfer, consents_waiting_for_you,
consents_waiting_for_others}`, ids and keys on the claim and debt rows (with `operator_run` and the label "issued with
keys the operator holds" for notes of server-run participants), the deal buckets `paid_by_transfer` and `payment_due`,
`settled` = `cleared_by_setoff` with `settled_how: "by set-off only; nothing is redeemed"`, and a new `meaning`. The
public position has the same without `spendable_notes` and `pending`.

### Decision D-1: one live payment attempt per deal, across kinds

At most one attempt to pay a deal can ever apply. An attempt the payer signed stays usable at the tracker until its
timestamp + 1 hour (transfers and bound notes; an ordinary note has no maximum age), so:
- the **identical** operation, a post of the same note, prior and timestamp, is not held back (the tracker lets at
  most one of the two apply);
- **the same-prior exemption** (tracker v3.2, design v3.2 section 4): an earlier transfer attempt does not hold back a
  new transfer whose from-edge is the earlier attempt's (the same held note A→B) and that acknowledges the same prior
  state of it, total AND timestamp, as the earlier attempt did; at any later T, at once. Both acknowledge
  `PA(A, B, X, p, ·)` of a state A→B has at most once, so the first to apply leaves the other dead for good. It applies
  on the templates, `POST /pay-by-transfer`, the held transfer's approval re-check, the payment options and
  `next_actions` (since release v16.1 all with the tracker's state of the note, as the routes read it; release v16's
  `next_actions` read Valun's own journal for it). An earlier
  attempt that recorded no prior timestamp, or that was recorded `unverified` (D-2 b), is never exempt. (For a bound
  note the same holds for a bound note on the same pair and prior state, but the server never holds an own note back
  for another own note, so on the server only transfers use it.);
- **any other new payment** (an own note, another issuer's note, the same note on another prior state: the same total
  at another timestamp included) waits until the earlier attempt is dead:
  `409 transfer_window_open {retry_after_ms}` until `fallback_after`. This works in both directions: an own bound note
  that the tracker did not record (failed, stale, rejected by the owner, voided by a revocation, replaced by a newer
  note, or refused when posted) blocks a transfer until its timestamp + 1 hour + 60 s;
- an ordinary own note that was not recorded but could still be (it never expires; its edge has not moved past it and
  is not bound-only) blocks a transfer: `409 pending_unbound_note` (pay with a new credit note instead);
- an earlier attempt that the edge shows applied: `409 already_paid`;
- an attempt whose outcome the read-back could not decide: every payment gets `409 attempt_outcome_unknown` until the
  payer's owner resolves it (decision D-2 d).
Attempts the server's own edge journal proves dead never block (decision D-2 e: the first journal entry on the edge
after the attempt's timestamp changed the edge from exactly that attempt's prior total). Retries from one own note to
another own note are not restricted by the server; clients enforce that (rule R11: a note retry on the same pair and
prior total at once, and on tracker v3.2 the same-prior exemption for a transfer, mirrored exactly).

### Decision D-2: refused attempts, set-offs and attempts, owner resolution

- **(b) Refused attempts are recorded.** A payment the payer posted and the server refused before recording it
  (`complete` with a credit note, or `pay-by-transfer`) is still an attempt its client keeps until it is dead, so the
  server records it when it is one the tracker could take (the deal is the caller's to pay and not ended, and the
  payer's signatures verify over the messages rebuilt from the posted values; not for the sandbox agents, whose
  signatures the server makes and records itself): only its kind, timestamp, edges, prior states (totals and, since
  tracker v3.2, the prior timestamps its acknowledgments were checked over: the posted `from_prior_timestamp` or bound
  `prior_timestamp`, else the edge's note as it is; the posted `to_prior_timestamp` or null) and new totals, the
  sha256 of its signatures, the refusal's code and when; at most 32 per deal; never shown in any view.
  A note at a residue the tracker keeps for other operations (995, 996, 998, 999) is no attempt and is not recorded,
  and neither is an attempt whose acknowledged prior timestamp is not before its own timestamp (the tracker can never
  take it).
  During a signature-checker outage (`503 signer_unavailable`) the attempt is recorded `unverified: true`: it counts like
  any other. It counts for the D-1 windows and holds the payer's own edge against set-offs. Audit:
  `payment.refused_attempt` (flagged `unverified` when so). Transfer and bound templates choose a timestamp later than
  every live set-off's timestamp on their edges.
- **(c) No set-off on edges with a held note or a payment attempt.** A set-off never applies, whatever its
  timestamps, while a deal on one of its pairs holds a credit note for its owner (superseded `held_note`) or while a
  payment attempt would change one of its edges: a live transfer, a note being issued, or an earlier attempt of a deal
  that is not yet paid and has not ended (transfers that did not apply, own notes not recorded, refused attempts; both
  edges of a transfer) (superseded `payment_attempt`, no cooldown). A collecting one is superseded when the attempt or
  the held note appears, again at apply and in housekeeping; recovery never resubmits one left applying (failed with the
  same code). The engine proposes none there. **These holds have no time limit** on the payer's own edges: a deal left
  `payment_due` or `note_failed` keeps them out of clearing for as long as it stays unpaid and has not ended. A
  transfer that ended without applying holds its other edge (the issuer's note to the payee, which the payer is not
  on) only until its `fallback_after` (T + 1 hour + 60 s), when it can no longer apply (SV-LIVE-1); one of unknown
  outcome holds both until its owner resolves it.
- **(d) The payer's owner resolves an attempt of unknown outcome.** `POST /owner/deals/{vd}/attempts/{vt}/resolve
  {outcome: 'not_applied' | 'applied', note?}` (the payer's owner token; modes `sandbox` and `on`, and, for an attempt
  that is `outcome_unknown` or `inconsistent`, every other mode but `off` too: mode `bound`, and mode `sandbox` for a
  participant outside the sandbox (MIG-4), so an attempt left over when the operator stepped back from `on` can still be
  resolved; elsewhere the same `404` as any unknown route), after confirming with the payee whether it was paid.
  `not_applied`: the transfer becomes `resolved_not_applied`, its signatures are purged (sha256 kept), `fallback_after`
  = its timestamp + 1 hour + 60 s; it no longer blocks the deal nor holds its edges. `applied`: only while the payee's
  edge shows the transfer (SV-AUTH-1): its class at the read-back that left the attempt unresolved, else its state read
  again now, is the transfer's new state (`new`, or past T at the new total); otherwise `409 payee_edge_not_applied
  {payee_edge}` and nothing changes. Then its journal entries are written, the deal is `paid_by_transfer`, and the
  receipts show its signatures. Both add the history event `payment_attempt_resolved` and the audit line
  `transfer.resolved_by_owner`. Answer: `{resolution {attempt_id, outcome, previous_state, at, note}, attempt {id, kind:
  'transfer', timestamp}, deal, transfer}`. Errors: `403 not_payer`, `404 not_found` (an unknown attempt, or an agent
  token), `409 wrong_state` (any state other than `outcome_unknown` or `inconsistent`), `409 payee_edge_not_applied`,
  `400 invalid_field` (outcome; a note longer than 300 characters or with control, bidi or invisible characters). Only
  payments by transfer (`vt_`) are resolved here: the server decides the payer's own notes by its own read-back and never
  answers `attempt_outcome_unknown` for one, so a client's resolution of its own note's attempt changes only that
  client's records. The owner console offers this action on the deal.
- **(f)** Bound notes and novations keep the tracker's status and code only (see "Bound credit notes").

### Consents

`GET /consents` (agent; an owner token gets the same, read-only): `{consents: [item], recently_resolved: [{kind, id,
state, at}]}` (transfers and set-offs that ended in the last 24 hours). An agent's poll also lets the clearing engine
propose set-offs through the caller (at most once per 30 s). An item is `{kind: 'transfer' | 'setoff', id, state,
your_roles, created_at, expires_at, network, tracker_nft_id, denomination, edges: [{edge, issuer, recipient ({id,
handle}), your_role (issuer, creditor or payer), before (EdgeState), prior_timestamp (`before`'s timestamp, 0 when it
is null: a `prior` slot is `PA(I, R, before.total, prior_timestamp, timestamp)`), change, new_total, timestamp,
revision, slots, signed_by_you}], context, summary {your_net_change_PC, your_total_owed_change_PC}}`: only the caller's own edges, never a
message hex or another party's signature. For a transfer, `context` is `{amount, issuer, payer, payee}` and, for the
payer and the payee, `deal {deal_id, terms_hash, price, quote_digest}` (the issuer never sees the deal); the payee sees
only A→C; the payer never appears (it signed its slots when it posted the payment). For a set-off, `your_roles: ['member']`, one `new` slot on
each of the caller's edges, `context {amount}` (what it clears of the caller's claims, as much as of its debts) and
`your_net_change_PC: 0`.

`POST /consents/{id}` (agent) `{signatures: {"<edge>:<slot>": signature}, revisions: {"<edge>": n}}`: all of the
caller's unsigned slots or none (`400 invalid_field`), each verified against its current key over the message the server
rebuilds for the edge's current revision (`403 bad_signature`); a stale revision goes into `rejected [{slot, code:
'stale_revision', revision}]` and nothing is recorded. The caller's own check runs again; one that fails now ends the
novation (`failed`, `mandate_changed`) and answers `403 payment_not_accepted {rule, by}` (`by`: issuer, payee, payer or
`member`). Otherwise `200` with the item and `result` (also when the apply failed or was left applying), and `rejected:
[]`. `409 already_signed` (nothing of yours left), `409 key_changed`, `409 wrong_state` (no longer collecting; a server-run
member's part is the server's).

`POST /consents/{id}/refuse {reason?}` (agent; at most 300 characters, no control, bidi or invisible characters; not
signed: a refusal moves nothing): a transfer ends `refused` and its deal becomes `payment_due`; a set-off ends `refused`
and a 24-hour cooldown starts for this member and its edge set (and each cycle packaged in it). The other members see
only that it was refused. `409 wrong_state` when there is nothing to refuse (the payer cancels its transfer instead).

### Set-off (modes `sandbox` and `on`)

Only the clearing engine proposes set-offs (`vs_…`): cycles of debt of 2 to 6 edges (at most 16 edges and 8 members per
proposal), cancelled at once by the same amount on every edge. Each member signs, for every edge it is party to (as
issuer or creditor), the slot `<I>><R>:new` = `M(I, R, P − d, ts_e)` at a timestamp ending in 998 ms. There are no
prior acknowledgments: the tracker refuses any set of edges that does not balance for every key, so every set-off it
accepts leaves every net position unchanged, and each signature fixes its edge's final total. An edge between two
server-run members gets its state, timestamp and signatures at apply time. A member's client signs only if its own edges
balance, every change is a decrease and its policy allows it (`auto_clear`).
- **Eligible edges**: both keys current; both parties pass the member check (active with a key, `auto_clear` on, the
  mandate not expired, signs set-off consents or is server-run, not excluded); the reconciliation row is `match` and
  exact; at least 1 PC available after reservations; no live transfer, no client set-off already on it, nothing busy
  (a note being issued or held for an owner on the pair, a set-off being applied, a payment attempt: decision D-2 c).
  In mode `sandbox`, only sandbox participants.
- **When**: after every increase (a credit note recorded, an incoming transfer applied; at most 2 proposals, of cycles
  whose members are server-run or present), on an agent's consent poll (cycles through it), and a batch search every 10
  minutes while the server runs, at startup and on `POST /admin/clearing/run`. Cycles whose members are all server-run
  apply at once.
- **Limits**: at most 3 collecting proposals per client participant and 50 overall; a client member that has not
  signed a set-off since its last expiry left unsigned (one that never signed included) is in at most 1, and proposals
  with such a member are at most 40 of the 50, so members that never sign cannot hold the whole cap (SV-DOS-1;
  `max_collecting_per_unproven`, `max_collecting_unproven` in `GET /clearing` `engine.limits`); a cycle with a member at
  its cap is left out before the selection; 30 minutes to collect; cooldowns of
  6 hours for an edge set after an expiry or a failure and 24 hours after a refusal; three expiries in a row exclude a
  participant for 24 hours.
- **Apply**: every edge is read again (a moved client edge is made again on its own, its revision + 1, and its parties
  sign again; an edge that no longer has its decrease supersedes the proposal); server-run roles sign; the members'
  mandates and the balance are checked again; write-ahead `applying`; the edges are read once more; POST
  /notes/setoff; every edge is read back, and that decides. Applied: journal entries `setoff −d` on every edge. While a
  set-off is being applied its edges are busy: credit notes, templates and transfers get `409 edge_busy`, and another
  complete set-off sharing an edge waits.
- **States**: `collecting`, `applying`, `applied`, `failed`, `expired`, `refused`, `superseded`, `void_key_revoked`,
  `inconsistent` (an alarm for the operator; counted as failed in `GET /clearing`). Supersession codes:
  `insufficient`, `not_reconciled`, `edge_changed` (a tracker without per-edge timestamps), `timestamp_ahead`,
  `held_note`, `payment_attempt`. Failure codes: `mandate_changed {rule}`, `circulation_off`, `not_balanced`,
  `edge_changed` (the read-back shows the edge moved without it), the tracker's code after a 4xx with nothing changed,
  `novation_expired`, `key_revoked`, `held_note`, `payment_attempt`.
- **`GET /setoffs/{vs}`** (its members, agent or owner token): `{id, kind: 'setoff', state, your_roles, created_at,
  expires_at, updated_at, applied_at, edges (the member's own only), summary, result {code, at, tracker_status?},
  signatures | signatures_withheld, tracker_after?, signature_sha256?}`; signatures only once applied, on the member's
  own edges (its receipt). Other members never see who refused or whose rule failed.
- **`GET /clearing`** (public, computed at most once per 10 s; aggregates only): `{as_of, unit, tier: 'pure_credit',
  engine {enabled, interval_ms, limits, last_run}, graph_now {participants_with_positions, edges, gross_PC,
  net_floor_PC, clearable_mtcs_PC, clearable_within_limits_PC, bound_gap}, totals {setoffs_applied, cleared_PC (summed
  over every edge the set-offs decreased: both sides of each cancelled debt), edges_closed, transfers_applied,
  transferred_PC}, last_7_days {issued_PC, cleared_PC, liquidity_saving_pct, capacity_restored_PC}, proposals
  {collecting, applied, stale, expired, refused, failed, completion_rate_pct, median_ms_to_apply}, cycles_by_length,
  sandbox {dormant_PC}}`. A participant's `cleared_by_setoff` counts one side only.
- **Admin** (loopback, admin token): `POST /admin/clearing/run` → the run record `{id, at, reason, eligible_edges,
  excluded {not_current_key, not_member, sandbox_only, not_reconciled, busy, reserved}, cycles_found, expansions,
  truncated, proposed, applied_now, skipped, setoffs}`, or `409 clearing_not_running`; `GET /admin/clearing` →
  `{mode, engine, runs, live, recent, cooldowns, expiry_streaks, refusals}` with ids, members, edges and which slots
  are signed, never a signature. `node scripts/pilot-admin.mjs clearing run|status [--json]`.

### Edges, the edge journal, reconciliation

- **`GET /edges?since=<seq>`** (agent or owner; mode `bound` and above, else the same `404` as an unknown route):
  `{incoming, outgoing, journal, next_seq}`. Each edge row: `{edge, issuer, recipient ({id, handle}), issuer_pubkey,
  recipient_pubkey, total, timestamp, signature, exact, bound_only, reserved, frozen}` over every key the participant
  has had. `journal`: its edge-journal entries with `seq > since`, oldest first, at most 200 a page; `next_seq` is the
  `since` for the next call (the server-wide journal counter when no more remain). `503 journal_unavailable` while the
  older part of the journal (`pilot-edge-log.jsonl`) cannot be read; nothing is lost, try again. Also `503
  journal_unavailable {missing_from, missing_to}` when the entries the server can read do not cover every seq the page
  needs (`since` + 1 up to the counter: the file was lost or cut after the in-memory tail rolled over; decision D-3 d):
  such a page is never answered with entries missing; it stays refused until the operator restores the file and
  restarts the server (a page after the missing seqs is answered). `400 invalid_field` for a malformed `since`.
- **The journal** (`s.edges` and a 500-entry tail in `pilot-state.json`, plus the append-only `pilot-edge-log.jsonl`
  next to it): entries `{seq, at, kind (issue, transfer_out, transfer_in, setoff, backfill), ref, edge, delta,
  total_after, timestamp, signature}`, each written in the same save as the state change that caused it (a crash
  between the two is repaired at startup). It is backfilled once from `note_issued` deals. Decision D-3 d: the
  journal proves nothing (no attempt is dead by it, D-2 e) unless the entries the server read cover every seq from 1
  to the counter. A lost or cut `pilot-edge-log.jsonl` after the 500-entry tail rolled over is found at startup (one
  log line and one `journal.incomplete {where, missing_from, missing_to}` audit line); the tail's entries are still
  written to the file, so they are kept, but the journal stays incomplete, and proves nothing, until the whole file is
  restored and the server restarted. Restore `pilot-state.json` together with its `pilot-edge-log.jsonl`.
- **The journal's checkpoint** (release v16.1; readiness R-19, audit SV-ROB-1). `pilot-edge-log.jsonl` is compacted:
  the entries up to a seq K are replaced by a checkpoint, and the entries after K stay as they were. The file then
  holds, in order:
  - a header line `{"checkpoint":1,"through_seq":K,"at","horizon_days","dropped","edges","deals"}`;
  - per edge some of whose entries were dropped, `{"cp_edge":<edge>,"dropped","dropped_max_ts"}`;
  - per recorded deal whose note's entry is at or before K, `{"cp_deal":<vd>,"edge","changes":[{kind, count,
    delta}]}`: what transfers and set-offs did on its pair after its note, up to K;
  - the kept entries up to K, unchanged: on every edge its last entry by seq and its last by timestamp, that is the
    edge's state as of K;
  - every entry after K, unchanged.

  It is written atomically: a new file, `pilot-edge-log.jsonl.compact`, flushed to disk, then renamed over the old one,
  as `pilot-state.json` is saved. A crash before the rename leaves the old journal, and the next start removes the
  `.compact` file; a crash after it leaves the new one. The state (`pilot-state.json`) is not touched.
  - **Completeness (D-3 d)** becomes "the checkpoint plus every seq from K+1 to the counter". An incomplete journal is
    never compacted: the cut stops before the first missing seq, so a checkpoint never stands for entries the journal
    did not have. A checkpoint past `counters.edge_seq` (a state restored without its journal) is ignored, so the seqs it
    covered count as missing.
  - **What may go.** Only entries written (their `at`) more than 31 days ago, as a prefix of the file. The cut also stops
    before the first entry on an edge with a timestamp after the earliest attempt on that edge of a deal that is not
    paid and has not ended, or of a transfer of unknown outcome: its transfers that did not apply (live ones included),
    its own notes the tracker did not record, its refused attempts. The D-2 e proof of those attempts stays exact,
    whatever their age; an ordinary note has no maximum age. Why 31 days: D-2 e proves an attempt dead only while it
    could still apply (a transfer or a bound note until its timestamp + 1 hour). Records that did not apply are dropped
    after 7 days, and applied ones keep their signatures for 30 days (readiness R-6). The 0.4.0 clients keep their
    records 7 days and their confirmed signatures 30 days. So 31 days is past all of them, with a day's margin.
  - **D-2 e after a compaction.** The proof is partial (it proves nothing) when an entry the checkpoint dropped on the
    edge has a timestamp after the attempt's (`dropped_max_ts`); otherwise the kept and later entries answer it exactly.
  - **When.** At startup and on the 60 s timer (`Pilot.maybeCompactJournal`), at most once a day (also across restarts:
    the header says when), and only while the file is over 16 MiB. It runs under the pilot lock and synchronously, so no
    entry is appended meanwhile. One log line and the audit line `journal.compacted {through_seq, previous, dropped,
    dropped_total, kept, edges, deals, bytes_before, bytes_after}`; a failure is logged, and the old journal stands.
  - **Memory.** The in-memory index starts after K: it holds the kept entries and those after K only, never the
    compacted ones. Measured with a 150 000-entry journal (86.8 MiB), all 40 days old, under `--max-old-space-size=128`:
    the restart and the index build took 260 ms, with 6.7 MiB of index arrays, before; after compaction the file was
    0.3 MiB, and the restart took 3 ms with 0.2 MiB (test/release-v16-1.test.mjs).
- **`GET /edges` with a `since` before the checkpoint** (since release v16.1). The answer is `200`, as for any older
  page: the caller's kept entries up to K (each edge's state as of the checkpoint: real journal entries, with their own
  seqs and their issuers' signatures), then every later entry, paged by seq as before. `checkpoint: {through_seq, at}`
  is added to such an answer only, and says that the entries in between were compacted. The 0.4.0 clients
  (`sync_edges` / `syncEdges`) read it as an ordinary page. They verify each entry's signature, take each state as a
  confirmed state of its edge, and ignore the new key. They resynchronize from these entries and the current rows
  (`incoming`, `outgoing`), and `next_seq` moves them past the checkpoint. A page from a `since` at or after K is
  answered exactly as before compaction.
- **Reconciliation** (`GET /ledger`, public): what Valun expects on an edge is its journal total, which is v15's sum of
  issued prices while nothing was novated; the row shape, its fields and the three statuses are v15's in every mode
  (owner decision 9, design §4.9; SV-PRIV-1): `issued_via_valun` is the journal's expected total, so a public row shows
  no per-edge history of transfers or set-offs. The server's own rows (`Pilot.reconcile()`; with circulation on) also
  have `expected_total`, `set_off`, `transferred_in`, `transferred_out` and `exact` (the tracker's note is exactly the
  one Valun's last event on the edge left), with `issued_via_valun` the gross issued amount; they are not served. A
  party sees `exact` for its own edges in `GET /edges`. Differences are flagged, never corrected. The engine and
  `spendable` use only edges that reconcile and are exact.

### Sandbox circulation (modes `sandbox` and `on`)

The always-on sandbox agents (`sandbox-exact`, always exact; `sandbox-mallory`, wrong on purpose in about half of its
deliveries) also buy and pay, and the server signs for them (its signer signs only 80-byte note messages for this
tracker, at residues 997-999, at most 1 hour old and 5 s ahead, one operation per agent, edge and timestamp; its
write-ahead record `sandbox-records.json` keeps sha256 values only, mode 0600 on POSIX):
- `sandbox-exact` sends every active `sandbox_only` participant one **welcome job** (text-stats of a fixed text, 3 PC,
  the offer open 24 hours, delivery within 48 hours): at most 3 a tick, and none while its room under its own
  `max_issue_outstanding` (1000 PC, debt owed to dormant sandbox participants not counted) is below the price;
- both buy a stranger's text-stats and notary offers at no more than list price: each agent at most 3 jobs from one
  stranger in 24 hours (the welcome job included), text at most 4000 bytes, and none once the stranger's claims on the
  agents (tracker claims + purchases agreed and not paid + live incoming transfers of the agents' notes) plus the price
  would exceed 20 PC; in mode `sandbox` only from sandbox participants (others get a signed decline saying so);
- both check every delivery they bought exactly and dispute a wrong one, naming the first field that differs;
- `sandbox-exact` pays with its own bound note; `sandbox-mallory` pays with the other agent's note it holds when one
  covers the price and the payee accepts that issuer and is present, else with its own bound note, and never pays by
  transfer again on a deal whose payee refused one;
- a tick does at most 8 successful actions and 32 attempts; a failing item backs off (10 s doubling, at most 1 hour);
  `poke()` reacts about 200 ms after a change to one of their deals.

**Capacity limits** (liveness only; nothing of value moves): `sandbox-exact`'s `max_issue_outstanding` (1000 PC) also
counts its committed and reserved deals. A purchase that is agreed but never delivered stays committed until its
`deliver_by` (the agents do not bound it) **+ 7 days**; an open welcome offer reserves 3 PC for 24 hours; an accepted
welcome job that is never delivered holds 3 PC for about 9 days (48 hours + 7 days). About 50 strangers each holding 20
PC of agreed, undelivered purchases, or about 333 accepted, undelivered welcome jobs (under two days of the 200-a-day
self-serve join cap), would stop `sandbox-exact` buying and sending welcome jobs until those deals end. The bounds in
force are the 3 welcome jobs a tick, the room check above, the 20 PC earn cap, 3 purchases per stranger a day, and the
join caps; bounding `deliver_by` on purchases is an open owner decision (Operations, "Open owner decisions").

### Records kept and pruned

Transfers and set-offs that ended without applying are dropped 7 days after they ended; applied ones keep their totals
and drop their signatures (sha256 kept) 30 days after they applied. An attempt whose outcome is unknown is kept until
its owner resolves it, with its signatures withheld from every response. A transfer of a deal not yet paid is kept,
without its signatures, while the deal is unpaid (decision D-1 needs its timestamp and edges). Refused attempts of a
deal that has ended go 7 days after they were refused. The clearing engine keeps its last 20 runs and 200 refusals.
Edge-journal entries older than 31 days give way to the journal's checkpoint once `pilot-edge-log.jsonl` is over 16
MiB (release v16.1; see "The journal's checkpoint").

### Timing facts and residual limits

- A transfer waiting for the payer's owner (`awaiting_owner`) expires **20 minutes after it was created**, not after the
  owner was asked; an approved one then collects for at most 20 minutes more, and never past its timestamp + 50
  minutes (clients sign a consent only while the timestamp is at most 55 minutes old).
- Recovery runs at startup and every 60 s (`issuing_note` deals, transfers and set-offs left applying, complete
  proposals whose apply never started).
- Residual risks of release v16 (accepted by decisions D-1 and D-2; also in the spec):
  - the journal proof of D-2 e can be fooled by an edge that goes A→B→A around Valun (a note signed outside Valun);
  - an owner's `applied` resolution marks the deal paid without the payee's own confirmation (it is refused while the
    payee's edge does not show the transfer, SV-AUTH-1): confirm with the payee first;
  - set-off holds (D-2 c) have no time limit;
  - retries from one own note to another own note are not enforced by the server (clients enforce them);
  - an `unverified` refused-attempt record may describe a post whose signatures would not verify; it holds only that
    payer's own deal windows and its own claim edge, the same power a valid refused post has;
  - the resolve route does not exist in mode `off`: a transfer left `outcome_unknown` or `inconsistent` must be
    resolved **before** the mode is switched to `off`, else its deal stays blocked (and a v15 rollback could pay it
    twice; `scripts/pilot-downgrade-check.mjs` refuses then); in modes `bound` and `sandbox` it can still be resolved
    (MIG-4);
  - a set-off applied between a payer's template and its post makes the post `409` (stale); the payer's client keeps its
    written-ahead attempt and waits about an hour (`transfer_window_open`), or, for a template fetched within about a
    second of the set-off's creation, reads it as unknown and needs its owner (templates now take a timestamp after live
    set-offs, which removes most of this);
  - a set-off whose timestamp on a pair precedes a held note's still applies; the held note then becomes `void_stale`
    at the owner's decision and the payer waits about an hour before a note with the new prior;
  - the server's same-prior exception compares totals only; a D-2 a client may refuse such a retry by its own records;
  - an `applied` resolution does not run the engine's incremental search; the raised edge waits for the next batch;
  - `GET /edges` `next_seq` is the server-wide journal counter, so it shows roughly how many journal events happened;
  - `pilot-edge-log.jsonl` is streamed at startup and once per process into an index of about 50 bytes an entry
    (offsets and the numbers the proofs need, no signatures), and a page reads only its own lines (SV-ROB-1). Since
    release v16.1 it is compacted (see "The journal's checkpoint"): entries older than 31 days that no unpaid deal's
    attempt needs are replaced by a checkpoint, so the index and the startup scan grow with the last 31 days' entries
    and the number of edges, not with the whole history. What a compaction gives up:
    - `pair_changes_since` sums the compacted changes per kind (no longer each one with its `ref`);
    - a client whose `since` is before the checkpoint sees each edge's state as of it, not the states in between;
    - an old attempt is no longer proven dead by the journal (fail closed), but D-2 e only matters for one that could
      still apply;
    - the spec (18.14) does not name the `checkpoint` key yet (a valun-open follow-up);
  - `sandbox-records.json`'s 0600 mode is checked on POSIX only.

## Operations

- **Launch.** `scripts/docker-entrypoint.sh` (the image) and `scripts/start-local.mjs` (the Windows dev machine: trackers in WSL
  `valun-ic1`, the app on Windows) start both trackers with `BASIS_CONFIG_LAYOUT=auto` and pass the app
  `PILOT_TRACKER_SHA256`, the sha256 of the `basis_server` they run. Circulating credit also needs
  `PILOT_CIRCULATION`. Locally, for example: `VALUN_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release
  PILOT_CIRCULATION=on node scripts/start-local.mjs` (from Git Bash add `MSYS2_ENV_CONV_EXCL=VALUN_`;
  `VALUN_LOCAL_SUFFIX=<name>` keeps its own data folders). `dist/bin/` (what the image ships) still holds the Basis
  3df7ed93 binaries, on which circulation stays off; `basis/BUILD.md` has the v3.2 recipe and hashes.
- **`/api/status` `basis.pin`** names the tracker source. A tracker without `GET /capabilities` (Basis 3df7ed93) keeps
  v15's text. A tracker v3 is named, in every pilot mode (`off` included), by the build and Valun fork commit it
  reports about itself, and the text says so: `Basis tracker v3.2: Valun fork commit 4370418… (branch …), as the
  tracker reports itself` (the branch circulating-credit-v3.2; a v3.1 or v3 tracker is named the same way, on its
  branch circulating-credit-v3), followed by ` (binary not pinned)` when the launcher's `PILOT_TRACKER_SHA256` is not one of
  `lib/pilot/pins.mjs` (a binary can report any commit; circulating credit stays off on it). `BASIS_PIN` overrides it.
- **Tests.** `npm test` runs every `test/*.test.mjs` except the opt-in ones (`scripts/run-tests.mjs`), against throwaway
  trackers in WSL; `VALUN_BINS=<bins>` picks the binaries (the tests that need tracker v3.2 skip, with a reason, on
  others). `npm test` is **not available inside the Docker image**: the Dockerfile does not copy
  `scripts/run-tests.mjs`. `node scripts/rehearse-container.mjs [--tests-only] [--keep]` stages in WSL the image's
  binaries and entrypoint (at the image's places, outside the app folder) and every app file the Dockerfile copies
  (`package.json`, `server.mjs`, `lib/`, `public/`, `test/`, `basis/run-tracker.sh` and the scripts
  `check-persistence.mjs`, `check-exposure.mjs`, `valun-mcp-stdio.mjs`, `pilot-admin.mjs`) plus `scripts/run-tests.mjs`,
  and runs the same test list there; with `--tests-only` its exit code is that run's. At the end it removes its staging
  folder (`/home/valun/valun-app-ctest-<UTC>`) unless `--keep`. Without `--tests-only` the entrypoint then runs on port
  8090 and also gets `PILOT_CIRCULATION`, `PILOT_OPEN_SANDBOX` and `NODE_OPTIONS` when they are set (none by default;
  fly.toml sets the last two), so the sandbox tour can run against it under the image's heap limit; measured figures
  are in `docs/RELEASE-0.4-READINESS.md`. The image and the rehearsal set `VALUN_APP_COPY=image`:
  only there is a test that needs another file of the repository (`docs/PILOT-API.md`, `basis/BUILD.md`, the Dockerfile,
  `scripts/pilot-downgrade-check.mjs`, the launchers) skipped, with the reason; anywhere else a missing file fails it
  (`missing <file>`).
- **Persistence check across a restart.** `node scripts/check-persistence.mjs snapshot|compare BASE_URL FILE --pilot
  [--pilot-tracker URL]` compares the pilot ledger (every note), the reconciliation rows (v15's, as GET /ledger serves them),
  the participants and the pilot tracker's `local_digest` (read from the tracker itself, loopback only); without
  `--pilot` it checks the demo as before. Exit 1 on any difference. Take the snapshot after a restart (a tracker's live
  digest can differ from its startup digest after in-place updates).
- **Rollback to release v15.** In this order: resolve every `outcome_unknown` or `inconsistent` attempt (the payer's
  owner, while circulation is on) and decide every held bound note; set `PILOT_CIRCULATION=off` and let the server run
  for at least 31 minutes (collecting transfers end after 20, set-offs after 30; recovery decides those being applied);
  stop it; then run `node scripts/pilot-downgrade-check.mjs <data>/pilot-state.json` (`--dry-run` only reports); in the
  image, set `VALUN_MAINTENANCE=downgrade-check` (or `downgrade-check-dry-run`) and restart the machine: the entrypoint
  runs the check on `/data/pilot/pilot-state.json` before any tracker or the app starts and exits with its exit code
  (the log says `REFUSED` with the reasons, or that the state is prepared), so the live state is the one prepared and
  nothing writes it meanwhile (MIG-3; on Fly: `fly secrets set VALUN_MAINTENANCE=downgrade-check`, read `fly logs`,
  then deploy v15 and `fly secrets unset VALUN_MAINTENANCE`; a refusal leaves the state as it was: unset it, let v16 run
  to drain, and repeat). It
  refuses (exit 1, nothing written) while any transfer is `awaiting_owner`, `collecting`, `applying`,
  `outcome_unknown` or `inconsistent`, any set-off is `collecting` or `applying`, any deal is `paying_by_transfer`, any
  `pay_by_transfer` approval is pending, or a bound note is held or being issued. Otherwise it writes a backup
  (`pilot-state.json.v16-backup-<UTC>`), maps `payment_due` to `note_failed` (which v15 knows: the payer pays with its own
  note), purges every unapplied note signature (MIG-1, design §12.5: each payer-signed note the tracker did not record
  that v15 will not send, i.e. a deal's credit note unless it is `issuing_note` or `completion_awaiting_owner`, and its
  rejected, voided and replaced notes; their sha256 kept; **the backup keeps them**, so keep it as private as the
  state), appends `downgrade.v15_prepared` to the audit log and lists what v15 then shows differently (deals paid by
  transfer keep a status v15 does not know; v15's `migrate()` turns their `payment` record into a credit-note record
  without a note; v15's reconciliation does not match the edges a transfer or set-off changed; v15 does not enforce the
  D-1 waiting times, which 0.4 clients still enforce themselves). Going back to the 3df7ed93 tracker binary as well
  needs more (design §12): no novation signature left unapplied (that binary accepts unbound notes on bound-only edges
  and notes at reserved residues: the check's refusals and its purge see to it) and the node config layout. A v16
  server whose pilot tracker reports no capabilities logs one `ALARM` and audits `pilot.revivable_signatures {notes,
  deals, novations}` when the state still holds such signatures (MIG-1), and since release v16.1 it refuses every pilot
  write while the state holds any circulating-credit history (next item). **v15 code on tracker v3.2**
  (only the app goes back): liveness only, nothing moves, but v15's ordinary credit-note templates can end in 995-999
  ms, which tracker v3.2 keeps for its own operations and refuses (an occasional `note_failed`; the payer signs a new
  note), and tracker v3.2 refuses every unbound note on a bound-only edge, which is every edge a transfer or set-off
  changed: those pairs can no longer be paid with v15's credit notes. Run v15 with the 3df7ed93 binary (after the drain
  above), or expect those pairs to stay stuck; the downgrade check says so in its notes. The v15 image cannot start
  this combination by itself: its basis/run-tracker.sh (`729a4c1`) always writes the `[ergo.node]` config layout, which
  tracker v3.2 refuses (basis/BUILD.md), so v15 code on tracker v3.2 needs v16's launcher. The deploy runbook
  (docs/DEPLOY-0.4-RUNBOOK.md) never uses it: its rollback R4 is the v15 image with its own 3df7ed93 pair.
- **Pilot writes refused on a downgraded tracker** (release v16.1; audit MIG-1, readiness R-18).
  - **When.** Two things must both hold:
    - the pilot tracker's capabilities have been read and are not tracker v3.2's (`validateCaps`): none at all, as on
      the Basis 3df7ed93 build, a read that failed, a tracker v3.1, or anything else that does not validate;
    - the state holds circulating-credit history: an edge a transfer or set-off changed (`s.edges[k].novated`,
      bound-only on tracker v3.2), a transfer or set-off record, a recorded bound note, or anything the MIG-1 alarm
      counts (unapplied bound-note or novated-edge note signatures, unapplied novation signatures).

    Such a tracker enforces neither bound-only edges nor the maximum age of bound notes and novations.
  - **What is refused.** Every pilot operation that would write to the tracker, before anything is checked, sent or
    recorded, with `503 tracker_downgraded {retry_after_ms: 60000}`; its message names the fix. That covers
    `POST /deals/{vd}/complete` (also an ordinary note, which could land on a bound-only edge, and a note held for the
    owner), an owner's approval of a held credit note or of a held payment by transfer (a rejection sends nothing and is
    allowed), `POST /deals/{vd}/pay-by-transfer`, `POST /consents/{vt|vs}`, the clearing engine's proposals, and the
    sandbox agents, whose payments go through the same calls.
  - **What still runs.** Reads keep working, and so does the demo world. Recovery sends nothing: it still reads, and
    records what a read-back decides (a note the tracker holds; a novation that applied or can no longer apply), but
    leaves what would need a submission (`issuing_note`, `applying`) as it is, unreported. `GET /info` shows
    `writes_refused {code, since, reason, fix}`.
  - **Logs and audit.** When the refusal starts: one `ALARM` line, with what the tracker would revive, and the audit
    lines `pilot.writes_refused {code, reason, history}` and, when there are such signatures,
    `pilot.revivable_signatures`. When it ends: one line, `Pilot: pilot writes resumed: …`, and
    `pilot.writes_resumed {refused_since, why}`.
  - **The way out.** The fix is the tracker v3.2 pair back in `dist/bin` (docs/DEPLOY-0.4-RUNBOOK.md step 4). Before
    going to release v15 instead, run the downgrade check in maintenance mode (runbook R3). A failed read does not
    block writes for ever: while refusing, the 60 s timer reads the capabilities again (`Basis.refresh`). One that
    validates lifts the refusal, and the requested mode applies as at startup (the clearing engine starts when that
    mode is sandbox or on).
  - **A v15 state is never refused.** A state without circulating-credit history (v15's, or one that never left mode
    off) works on the 3df7ed93 tracker exactly as before, which `npm test` with the default binaries exercises.
- **Open owner decisions** (documented, not decided in v16):
  - *Bounding `deliver_by` on sandbox purchases.* The sandbox agents do not bound it, so an agreed purchase that is
    never delivered keeps its committed PC until `deliver_by` + 7 days (see "Capacity limits"). A bound (for example
    `deliver_by` at most 48 hours after the agreement, as for the welcome job) would shorten that; it changes what the
    sandbox agents accept and is the owner's choice.
  - *v15's `migrate()` and a v16 deal's `payment` record.* After a rollback, v15's `migrate()` turns the
    payment-by-transfer record (`d.payment`) of a deal without a credit note into a credit-note record with no note: shown
    in v15, never used, but a later re-upgrade to v16 no longer has that deal's payment block. The downgrade check lists
    these deals in its notes. Whether the check should set `d.payment` aside (and v16 restore it) is the owner's choice;
    until then keep the downgrade check's backup (`pilot-state.json.v16-backup-<UTC>`), which holds the records as they
    were.

## Error codes

Every error body is `{"error": <code>, "message": <text>, ...extra}`. By status:

- **400**: `bad_json`; `invalid_field` (a field's value; with circulation also the policy fields, a malformed issuer
  id, `signatures` not exactly the caller's slots, a resolve note or outcome, `since`); `invalid_terms`;
  `hash_mismatch` (+`canonical`); `self_edge` (pay with a note you issued); `pay_with_is_payee` (pay the payee with its
  own note).
- **401**: `unauthorized`.
- **403**: `bad_signature`; `mandate_exceeded {rule, source, recorded_by?, mandate_version}`; `above_owner_mandate`,
  `below_owner_mandate {field, owner_value}`; `invalid_invite`; `invalid_enrollment`; `no_key`; `not_payer`;
  `not_payee`; `agent_only`; `sandbox_only`; `payment_not_accepted {rule, by}` (`by`: payer, payee, issuer or member;
  rules: `pay_with_held_notes`, `expires_at`, `max_collecting_transfers`, `max_attempts_per_deal`,
  `may_accept_credit`, `accept_transfers`, `counterparties`, the credit rules, `min_payer_coverage_pct`,
  `creditor_consent`, `issuer_key`, `novate_own_debt`, `issuer_consent`, `sandbox_only`, and for members `inactive`,
  `auto_clear`, `expires_at`).
- **404**: `not_found` (also every route the current mode does not have, and non-parties of a deal, transfer or
  set-off).
- **409**: `handle_taken`, `display_name_taken`, `key_in_use`, `already_enrolled`, `no_agent`, `duplicate`, `not_open`,
  `own_offer`, `counter_pending`, `conflicting_pending`, `stale_terms`, `key_changed {party?}`, `offer_not_authorized`,
  `acceptance_not_authorized`, `expired`, `not_pending`, `unknown_approval_kind`, `wrong_state`, `payee_no_key`,
  `no_key`, `stale_note {template?}`, `note_timestamp_ahead {retry_after_ms, last_note_timestamp?}`, `pair_busy
  {retry_after_ms: 60000}`, `feature_unavailable` (`?bound=1` with circulation off); circulating credit:
  `transfer_window_open {retry_after_ms}`, `attempt_outcome_unknown`, `already_paid`, `pending_unbound_note`,
  `payee_edge_not_applied {payee_edge}`, `transfer_stale {template?, transfer_id?, code?, regenerated_as?, deal?}`, `transfer_failed {code, transfer_id,
  regenerated_as, deal}`, `stale_payment {reason, rule?, by?, transfer_id, deal_status}`, `novation_pending
  {consent_ids}`, `edge_busy {retry_after_ms}`, `insufficient_claim`, `already_signed`, `clearing_not_running`.
- **413**: `too_large`. **429**: `rate_limited`; `too_many_open_offers` (the open network).
- **502**: `tracker_unavailable`, `signer_error`, or `{"error": "internal error"}` for anything unexpected.
- **503**: `tracker_downgraded {retry_after_ms}` (release v16.1: every pilot write while the tracker reports no valid
  tracker v3.2 capabilities and the state holds circulating-credit history; nothing was sent or recorded; Operations),
  `signer_unavailable` (nothing was recorded; try again), `sandbox_unavailable`, `sandbox_full`,
  `journal_unavailable`.
