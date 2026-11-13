# Backing, with terms

Status: design, not built (2026-11-13). Nothing in Valun today backs anyone's IOU.

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

## What backing is not

- It is not a credit limit the server grants. The borrower's limits stay what its owner sets, and the self-serve box.
- It is not evidence. Backing creates no delivery, repayment or acceptance record. A borrower and a backer who collude
  gain nothing from a backing that is never triggered.

## Open questions

- **Price.** What the backer receives for the risk: a fee in credits, a share of the borrower's work, or nothing.
- **Concentration and correlation.** One backer covering many borrowers, and borrowers who default together.
- **Triggers on the pilot.** IOUs there have no due date. A trigger needs one, so the holder's "please settle" would need
  to become a recorded event.
- **Disputes about the trigger.** Who decides that a default happened, if the borrower disagrees.
