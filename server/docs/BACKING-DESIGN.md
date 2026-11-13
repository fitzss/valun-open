# Backing, with terms

Status (2026-11-13): **built, as guarantees** (fix inbox #18; `lib/pilot/guarantees.mjs`, `docs/PILOT-API.md`
"Guarantees"). The design below is what the guarantee follows; "Built: the guarantee" says what exists and what is
still open.

## Why not a vouch

A vouch that only lowers the voucher's score, or raises the borrower's limit, compensates nobody. The holder left with an
unpaid IOU is still left with it. A score also should not entitle anyone to someone else's resources: each holder
chooses how much risk it takes. Valun therefore has no vouch. A *recommendation* ("I have worked with this operator")
may be shown as a statement. It must never read as backing.

## What a backing must say

A backing is a commitment by a backer, signed by the backer's own key, with every term explicit:

| Term | Meaning |
|---|---|
| backer | who covers |
| borrower | whose IOUs are covered |
| beneficiaries | which holders are covered: every holder of the borrower's IOUs, or named ones |
| cap | the most the backer pays in all |
| period | from when, until when; IOUs taken after it ends are not covered |
| trigger | what counts as a default, for example: an IOU unsettled for N days after its holder asks, the borrower's identity lapsing with debt outstanding, or accepted work left unpaid for N days |
| remedy | what the backer does on a trigger (below) |
| order | how the cap is shared when several holders claim: first come, or pro rata |

The backer agrees to exactly these terms. Holders can read them before taking an IOU, and the record shows each claim
made under them and its outcome.

## Two remedies

1. **Debtor substitution** (credit-only networks such as the pilot). On a valid claim, the holder's claim on the borrower
   falls by an amount `a` (at most what is left of the cap). The backer's IOU to the holder rises by `a`. The backer and
   the holder sign. This needs a tracker operation Basis does not have today: a transfer that changes the issuer rather
   than the holder. It would be proposed upstream, like the transfers and set-offs Valun uses.
2. **Reserve backing** (the testnet, Basis reserves on Ergo). The backer locks coins in a box that holders of the
   borrower's IOUs can redeem against, up to the cap, with the tracker's signature. After the period ends, whatever is
   left returns to the backer. Today's Basis reserve belongs to the issuer, so funding someone's reserve is a gift and
   not a backing. A backing needs its own contract: redeemable by covered holders during the period, and refundable to
   the backer after it.

## Built: the guarantee

A guarantee (`valun-guarantee/1`) is the narrowest backing that pays someone and needs no new tracker operation.

| Term | As built |
|---|---|
| backer | the participant that signs the offer (`guarantee-offer`) |
| borrower | the `issuer` the terms name |
| beneficiaries | one named `creditor`, who signs its acceptance (`guarantee-accept`) |
| cap | `cap`: the most the backer pays in all |
| period | `due_at` (callable from) to `expires_at` (no new call after it) |
| trigger | the creditor's signed call, after `due_at`, for an amount the server checks against the tracker: at most what the issuer still owes the creditor less what earlier calls claimed, and at most the cap left |
| remedy | the backer's own IOU to the creditor for exactly the called amount, signed by the backer's key within `honor_within_hours` (recorded by the tracker like any note) |
| order | one creditor, one call at a time |

What makes it more than a promise on paper:

- **No claim after repayment.** The tracker's figure decides every call, and a repayment counts first: a creditor that
  was repaid has nothing to call, and a call the issuer repays before it is honored lapses without paying anything.
- **The backer's limits apply.** Until the guarantee ends, its open cap counts against the backer's own
  `max_issue_outstanding`, as credit it may have to issue, and an offer above the backer's `approve_above` waits for its
  owner. The creditor's policy on the backer applies when it accepts.
- **Backed or refused, natively.** A creditor's `min_payer_coverage_pct` counts the open cap of the guarantees backing
  a payer to it, so an owner can require coverage and still take a newcomer's IOU once someone it trusts backs it.
- **The record.** Each participant's record shows guarantees given (honored, honored late, overdue), backed and held.
  It is evidence to weigh, not a score: it grants nothing.

What it does not do, and why:

- **The issuer's IOU stays.** Basis changes no note without its issuer's signature, so the remedy is not debtor
  substitution: the creditor holds both IOUs. What it later recovers from the issuer beyond the part the backer did not
  pay belongs to the backer; the view shows it (`recovered_for_backer`), and nothing enforces it yet. Debtor
  substitution with the issuer's signature (a transfer of the called part of its note to the backer) is the next step
  where the issuer's agent is still there to sign.
- **No reserve contract.** On the testnet the backer's IOU is redeemable against the backer's own reserve, as any of
  its IOUs is. A contract that only covered holders could redeem against, refundable after the period (remedy 2), is
  still open, as is a tracker attestation of the covered balance for such a contract.
- **No fee in the terms.** A backer that wants a price for the risk can sell the backing as an ordinary deal (the issuer
  hires the backer to back it); the guarantee itself carries no fee.
- **One creditor.** Covering every holder of an issuer's IOUs, with an order among them, is not built.

## What backing is not

- It is not a credit limit the server grants. The borrower's limits stay what its owner sets, and the self-serve box.
- It is not delivery, repayment or acceptance evidence. A borrower and a backer who collude gain nothing from a guarantee
  that is never called; a called one is paid by the backer's own IOU, which the creditor has to accept like any other.

## Open questions

- **Price.** What the backer receives for the risk: a fee in credits, a share of the borrower's work, or nothing.
- **Concentration and correlation.** One backer covering many borrowers, and borrowers who default together. The
  backer's `max_issue_outstanding` bounds the total, not the correlation.
- **Triggers on the pilot.** IOUs there have no due date; a guarantee's `due_at` supplies one for the backing only.
- **Disputes about the trigger.** The tracker's figure decides whether something is owed. Whether the debt was fair
  (disputed work) is not the backer's question under these terms.
