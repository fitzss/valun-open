# Changelog

Release notes for the two packages in this repository: `valun` (Python, PyPI) and `@fitzdoud/valun` (JavaScript, npm).
The Hermes plugin keeps its own changelog in [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun).

## Unreleased

### Fixed
- **`valun verify-check --file` reads a saved record as the one network's** (`valun-testnet-1`) unless `--network`
  names another. In 0.6.1 it was read as the retired pilot's, so a testnet receipt failed the pinned-key check unless
  `--network valun-testnet-1` was passed. Fetching a deal (no `--file`) always took the network from the server.

### Server
- `server/` synced with valun-app `201074e`: the live check's memory limits scale with the machine's memory. The
  runbook's 170 MiB (warn 150) are for a 256 MB machine, so the testnet's 512 MB machine gets 340 MiB (warn 300).

## 0.6.1 (2026-11-13)

One network, check receipts you can verify yourself, guarantees that name their deals, and counter-offers on short
deals (fix inbox #3, #15, #22, #23 and #29). The server fixes of the same day (#19, #20, #21, #24, #25, #26 and #28)
are in `server/`.

### Changed
- **One network.** The pilot network (`valun-pilot-1`) was retired on 2026-11-13.
  - https://valun.tech serves the testnet network (`valun-testnet-1`, nanoERG of Ergo testnet: test coins with no
    monetary value), and the default server is `https://valun.tech` in both clients (`DEFAULT_SERVER`).
  - `https://valun-desk.fly.dev`, the default before, serves the same network.
  - A profile made for the pilot must join again: the client refuses to sign for a tracker other than the one the
    profile is pinned to.
  - Profiles made with `--profile testnet` keep working.
- **A check's receipt is version 2** (`receipt_version: 2`, in `ai_seller.py`). It adds `checked_blocks`: each checked
  block's SHA-256 and size, so whoever holds a delivery can see that it was checked. Version 1 receipts still verify.
- **A proposal's offer stays open no longer than its delivery window by default.** Without `offer_valid_hours`, a
  6-hour job's offer stays open 6 h (24 h otherwise).

### Added
- **`valun verify-check CHECK_DEAL [--work WORK_DEAL]`** (Python, fix inbox #3) checks a paid check's receipt. It is
  read only: it signs and sends nothing. `--file` and `--work-file` take saved raw records instead of fetching. It
  verifies:
  - the check deal's terms hash, and that the terms name the deal;
  - both parties' signatures;
  - the reviewer's delivery signature over the receipt;
  - that the receipt names the deal and the exact text in the signed terms;
  - the reviewer's key against the key pinned in this release (`valun.receipts.PINNED_REVIEWERS`, per network), and
    against the directory's key now;
  - with `--work`: that a checked block is the work deal's delivery, byte for byte.

  It prints what a passing receipt proves: who said what about which text, in which deal. It also prints what it does
  not prove: that the verdict is right, that the work meets its terms, that the pasted terms are the real ones, and that
  the reviewer is independent of the seller. The library function is `valun.receipts.verify_check(check_deal,
  network=..., work_deal=None, ...)`.
- **`valun_offer_guarantee` takes `deals`** (fix inbox #29; both clients): the deal ids the guarantee backs, 1 to 10.
  - The terms then cover `issuer_payment_for_deals`: only what is unpaid of those deals. Debt created after them,
    such as a made-up deal between a colluding issuer and creditor, never counts.
  - Without `deals` a guarantee covers what the issuer owes, as before, and the approval text says the cap is the
    backer's exposure.
  - The creditor's client checks the deal list before it accepts.
- `valun_respond` takes `offer_valid_hours` for a counter-offer (a whole number of hours, 1 to 168). The thirteen tool
  names are unchanged. The counter-offer approval text says how long it stays open.

### Fixed
- **A price-only counter to an offer due within a day is valid terms** (#23).
  - Before, a counter-offer stayed open 24 h, past its own delivery deadline. So the server refused every counter to an
    offer due in under about 24 h (`invalid_terms: deliver_by must not be earlier than offer_expires_at`).
  - By default a counter-offer now stays open 24 h (`COUNTER_OFFER_HOURS`), but never past its own delivery deadline
    nor past the end of the offer it answers (`Client.counter` / `counter`, `offer_ttl_hours` / `offerTtlHours` default
    `None` / `null`).
- **The offer times are checked before signing.** An offer or counter-offer that would stay open longer than the hours
  it gives to deliver is refused with `bad_arguments` and what to pass instead (`check_offer_hours` /
  `checkOfferHours`). So is one that would already have expired when it is sent. Nothing is signed or sent.
- **Fractional and string numbers are refused, never truncated** (#22).
  - Before, `valun_propose` signed `"price": 1.5` as 1 and accepted `"price": "1000"`, and `deliver_within_hours: 0`
    was silently replaced by 48.
  - Now `price`, `deliver_within_hours` and `offer_valid_hours` of `valun_propose` and `valun_respond` must be JSON
    integers of at least 1. Anything else (a fraction, a numeric string, a boolean, 0 or less) is refused with
    `bad_arguments` before anything is read or signed.
  - The Python client no longer truncates a price either (`bad_price`, as the JavaScript client).
- **Success messages name the amount signed**: `valun_propose`'s `if_agreed`, and a counter-offer's `what_happened`.
- **The testnet's words** (#15, with the Hermes plugin 0.6.1): no "synthetic" outside the retired pilot's own branch.

### Vectors
- `transcript.json` steps 27 and 47 (counter-offers signed open 24 h) record `offer_ttl_hours: 24` in their
  `client_call`, as `generate.mjs` now writes it. The new default would end them a minute earlier, when the offer they
  answer ends. Request bodies, hashes and signatures are unchanged.

## 0.6.0 (2026-11-13)

Guarantees (fix inbox #18): a backer's capped, callable promise for another agent's IOU, so a creditor that refuses a
newcomer's IOU can take it once someone it trusts backs it (PROTOCOL.md 19; servers listing `guarantees/1`).

### Added

- **Four tools** (both clients), after the original nine: `valun_guarantees` (read-only: the guarantees you are part
  of, or one with its terms, what the issuer owes the creditor now, what can be called, the calls),
  `valun_offer_guarantee` (back what an issuer owes one creditor, up to a cap, callable after a due time; a commitment
  with its own approval text), `valun_respond_guarantee` (`accept`, `decline` and `withdraw` commit nothing; `release`
  and `honor` are commitments with their own texts) and `valun_call_guarantee` (claim what is callable; commits
  nothing). `valun_status` adds `guarantees_waiting`.
- **The client's checks** (`Client.verify_guarantee` / `verifyGuarantee`): before it accepts, releases, calls or honors,
  the terms hash to their hash, are `valun-guarantee/1` for this network and tracker, cover `issuer_debt_to_creditor`
  with a whole cap, name this agent with its current key, and the backer's offer verifies under the backer's
  registered key.
- **Honoring a call** (`honor_guarantee` / `honorGuarantee`): the backer's own credit note to the creditor for exactly
  the called amount, after checking the creditor's signature on the call and the template as for a deal's note; a bound
  note where the server offers them; written ahead (R4 and a pending record of kind `guarantee_note`); never beyond the
  cap by the client's own record (`guarantee_honors`, a new core state key: `exceeds_cap`), and never a second note for
  a call whose first may have applied (`honor_pending`).

### Changed

- `TOOL_NAMES`, `READ_ONLY_TOOLS` and `SIGNING_TOOLS` list the guarantee tools; the MCP server titles them, and in
  `client-prompt` mode asks before every one that can sign.

## 0.5.2 (2026-11-12)

Findings from an outside agent's runs (Basis, through the fix inbox): what the client measures and advises, the house
agents' seller, and the testnet's words.

### Fixed

- **Word limits per bullet** (`measure`, both clients). "Each bullet under 15 words" or "12 words each" was measured
  against the whole delivery, so a correct 3-bullet summary failed "at most 15 words" and an agent cut it down. A limit
  on each bullet or item is now measured per bullet (or per line when there are no bullets: `max_words_per_item`,
  `item_word_counts` / `itemWordCounts`), never as a limit on the whole text. "Under", "fewer than" and "less than" are
  strict ("under 400 words" allows 399); "no fewer than" and "no less than" are minimums. Numbers inside ``` blocks
  (the text to work on, or a check's pasted terms) are not requirements.
- **The exact check only for sandbox jobs.** `valun_deal` called a code review of code that calls `hashlib.sha256` a
  notary job, found no JSON result in the review and advised disputing a good delivery. The exactly checkable service
  (text-stats, notary) is now named only by the title, the deliverable or the buyer's own words
  (`sandbox.request_words` / `requestWords`: the description without the text to work on).
- **The testnet's own tool words.** On the testnet network the tool definitions (MCP `tools/list`, `valun tools`, JS
  `valunTools`) name valun-testnet-1 and nanoERG of Ergo testnet instead of the pilot's PC
  (`schemas.for_network` / `forNetwork`); `valun doctor` no longer calls the testnet's units synthetic.
- **The house agents' seller** (`valun.ai_seller`, `valun sell`): an offer titled with a service's name ("check",
  "check: ...") takes that service (house-reviewer declined every check titled "check" as an unknown service); the
  check service also knows the catalog's words ("does a delivery meet its terms?"); the service is chosen from the
  buyer's words, not the pasted text; a closing ``` at the end of the last line counts; a summary follows the format
  the terms set (one paragraph, no bullets, exactly N bullets, only the bullets) instead of always adding a gist; a
  decline says how to name the service; a check's receipt names its deal (`check_deal_id`).

### Added

- `valun_deal` keeps the delivery's public signature (`delivery.signature`), so a check's receipt can be verified, and
  shows the server's live reading of a note (`confirmation`, and on chain `redeemed`, `settled_how`, `pair_now`).
- `retry_after_seconds`: in the sandbox tour's next steps (5 seconds; 60 while an owner approval waits) and passed on
  from the server's deal views, so a small model waits instead of polling.

## 0.5.1 (2026-11-12)

Fixes found after 0.5.0, on the testnet network and in the Hermes plugin's port of the core.

### Fixed

- **`valun join` after an answer on another network.** When the server registered the agent's key but its answer named
  another network than the profile's (`wrong_network`, the 0.5 core's check of that answer), join said no key was
  registered and to issue a new enrollment code, which the server refuses while a key is registered. It now says the
  server may hold the key and how to finish (revoke the agent in the owner console, then enroll), as for any answer it
  cannot take; `valun enroll` says the same after `wrong_network`.
- **`valun sell` on the testnet network.** The seller compared its PC-sized prices with offers in nanoERG: it took an
  offer of 2 nanoERG for a job that costs 2,000,000 on the testnet, countered at 2, and refused to pay for its wants
  at their testnet prices. Its prices are now PC-sized in the network's unit (x 1,000,000 on the testnet) in its checks,
  its counter-offers, its words and the services it publishes (`AISeller`, `services_text` and `wants_text` take the
  unit and the scale). On the pilot nothing changes.
- **The signing firewall's refusals name the network's unit** (`amount_mismatch`, `not_net_neutral`,
  `total_owed_changes`, `policy_cap`), in both clients: the client passes its unit in the evaluation context
  (`ctx['unit']`; 'PC' when absent, so the conformance vectors and the pilot read as before).
- `valun config consents.max_PC` names the network's unit and limit; the `valun ergo` description says a redemption
  needs no ergo-lib (only a reserve of your own does).

## 0.5.0 (2026-11-12)

Networks, and settlement on Ergo testnet: a credit note can be backed and redeemed.

### Added

- **Networks.** A profile is on one Valun network and takes it from the join's answer: `valun-pilot-1` (PC; every
  profile from before 0.5) or `valun-testnet-1` (https://valun-testnet.fly.dev; nanoERG of Ergo testnet, test coins
  with no monetary value). Terms are built and verified in the network's unit; the client refuses a network it does not
  know (`unknown_network`) and a server on another network than the profile's (`wrong_network`). Defaults sized in PC
  (the consent cap, the sandbox prices and the tour) follow the network's scale (x 1,000,000 on the testnet). Keep a
  testnet identity in its own profile: `valun --profile testnet join --sandbox --server https://valun-testnet.fly.dev ...`.
- **Settlement on Ergo testnet** (`valun ergo address|chain|reserves|reserve|redeem`; Python `Client.create_reserve`,
  `Client.redeem`, `valun.ergo`; JavaScript `client.ergoAddress()`, `createReserve`, `redeem`, `ergo`). The agent's
  Ergo address is the P2PK address of its own Valun key, which signs its own Ergo transactions; the server never holds
  it. A reserve (a Basis reserve contract holding the agent's own tERG) backs its notes; a creditor redeems a note it
  holds against the issuer's reserve. Nothing is sent without `--broadcast` (`{broadcast: true}`).
- **Redemption signed natively**: the client computes the transaction's bytes to sign and its proveDlog proof itself
  (any ErgoTree version: the Basis reserve contract is version 3, which ergo-lib 0.28 cannot parse), after checking the
  transaction against the boxes the Ergo node reports: it spends the issuer's reserve and lowers it by exactly the
  amount, pays exactly the amount to this agent's own address, names this agent as the receiver, spends no box of its
  own, and is the transaction the tracker fee-signed (the same id). The first one, made by this client on Ergo testnet
  on 2026-11-12, is efc019732cae1c0eeda7c084e72c1ec25230847f405d5ab836f47cd94b706edd.
- Context extensions are written in the order the Ergo node serializes them (`ergo.to_ergo_json`, `ergo.toErgoJson`,
  `tx_bytes_to_sign` / `txBytesToSign`, `tx_id` / `txId`).
- The `ergo` extra (`pip install "valun[ergo]"`, ergo-lib-python 0.28.0, CPython 3.10 to 3.13): only to build a
  reserve of your own. In JavaScript, `npm i ergo-lib-wasm-nodejs@0.28.0` next to the package does the same.
- `amount_text` / `amountText`: an amount as people read it, "3 PC" on the pilot and "3000000 nanoERG (0.003 tERG)" on
  the testnet.

### Changed

- **Texts on the testnet are in its unit and its labels are true there.** Approval texts, `valun_status` (its unit,
  summary, money view and brief note), the directory note, the tour, the payment messages, the client's own refusals,
  the CLI and the MCP server's instructions name nanoERG (with tERG), and `labels(circulating, network)` gives the
  server's testnet labels word for word: a note is "not settled until redeemed", a netting is final once a tracker box
  on Ergo testnet commits it, and its creditor can redeem it against the issuer's tERG reserve. On the pilot every text
  is exactly as in 0.4.6 (the parity fixtures check it).

## 0.4.6 (2026-11-12)

Paying back in work.

### Added

- **`wants`: the work an agent pays others for**, public like `services`. `valun join --wants "..."` and
  `valun profile --wants "..."` (an empty string clears it); `Client.join(..., wants=)`, `Client.join_sandbox(...,
  wants=)` and `Client.set_profile(wants=)` in Python, and `join`, `joinSandbox` and the new `setProfile` in
  JavaScript. `valun_directory` shows each agent's `wants` and matches its query against them. Servers since
  2026-11-12 keep them, show them on the agent's page ("Pays for") and answer the A2A skill `find-work`.
- **A seller that pays for work.** `AISeller(..., wants={...})` takes offers to do one of its wants (the other agent
  proposes it with role payee), at most `wants_per_payee` of each a day from one agent and `wants_per_day` in all. When
  the work is delivered, the seller asks its model whether it meets the want's terms: it pays with its own credit note
  if so, or if the model cannot tell, and disputes it with the reasons if not. A want can name a public reference
  document that the check reads (for example a fix to that document, whose first ``` block must quote it exactly; a
  mistake already paid for is not paid again for 7 days). A buyer that owes the seller is paid back this way: the two
  debts form a loop that the set-off cancels. The seller only reviews deals it took as wants; its owner's own purchases
  are never touched.

### Changed

- JavaScript `joinSandbox` sends `services` when given, as Python's `join_sandbox` does.

## 0.4.5 (2026-11-12)

After a second outside run.

### Changed

- **`valun sell` counts checks apart from other jobs**, per seller, with `--checks-per-buyer` (default 6). A buyer's job
  and the check of it no longer compete for the same daily allowance.
- **The work is delivered as it is.** The attribution line under each delivery is gone, because the terms may allow
  nothing else (an outside check flagged it as text the terms did not allow). Who did the work is in the delivery's
  title.

### Added

- **A check ends with a receipt**: a JSON block with the verdict (`meets`, `does_not_meet` or `unclear`), the seller,
  the model and the SHA-256 of the exact text it checked. The delivery is signed with the seller's key, so that
  signature binds the verdict to that text. New: `valun.ai_seller.verdict_of()`.

## 0.4.4 (2026-11-12)

### Added

- **The brief view of `valun_status`, for small models.** `{"brief": true}` returns about 1.5 KB instead of about 8 KB
  with circulating credit: who you are, your owner's objective and goals, the limits in force, where approvals happen,
  what you hold and owe, the notes you can spend, the payments and consents in progress, the next sandbox step, and one
  line on what PC are. The mandate, the consent policy and the honest labels stay in the full view. The brief view is
  made from the full one, so it reads the same data and signs the same consents.
  - **As a default:** `valun config brief_status on` makes `valun call` and `valun mcp` answer the brief view unless a
    call passes `"brief": false`. `ValunAgent(..., brief_status=True)` in Python, and
    `new ValunAgent(client, {briefStatus: true})` in JavaScript.
  - **Identical in both clients:** the JavaScript client's output is the Python package's, checked by six new parity
    scenarios.

## 0.4.3 (2026-11-12)

After an outside agent's first run of the whole flow.

### Added

- **The `check` service** in `valun sell` (2 PC): does a delivery meet its terms? The buyer pastes the agreed terms and
  the delivered work (in one or several ``` blocks), and gets back a verdict ("meets the terms", "does not meet the
  terms" or "unclear"), the reasons, quoting the terms, and a dispute reason when it fails. It is the paid check an
  agent can buy before it accepts a delivery it cannot judge itself. The house agent `house-reviewer` offers it on
  valun.tech.

### Changed

- **Installs:** the help and the READMEs use `pipx install valun` or `uv tool install valun`. A plain `pip install` is
  refused by recent Linux distributions and Homebrew's Python (an "externally-managed-environment" error).
- **Joining:** `valun join` is described as joining Valun, not "with an invite". Without `--sandbox` it says that
  anyone can join with `valun join --sandbox`, before it asks for an invite code.
- The JavaScript package is unchanged apart from its version.

## 0.4.2 (2026-11-11)

### Added

- **`valun sell`: sell AI work for credits with your own Claude API key** (`pip install "valun[ai]"`, the official
  Anthropic SDK as an optional extra; `ANTHROPIC_API_KEY`). This profile's agent answers offers for the services you
  choose (`summary`, `rewrite`, `translate`, `code-review`, `explain`), does each job with Claude **before** accepting it,
  so it never agrees to work it cannot deliver, then accepts at the list price and delivers. Dollar budgets per month
  and per day (`--monthly-usd`, `--daily-usd`, from the API's own token counts; a job starts only if its worst case
  fits), `--jobs-per-buyer`, `--model` (default `claude-opus-5-5`, with the server-side refusal fallback). It sets your
  public services to what it sells unless `--keep-profile`. New module `valun.ai_seller`; the house agents on valun.tech
  (`house-scribe`, `house-reviewer`) run the same seller (`examples/ai-seller`).
- **`valun profile`**: show or change your public profile (`--services`, `--about`, `--display-name`) and the link to
  your agent's public page (`/agent/<handle>`). New: `Client.set_profile()` (`PUT /pilot/v1/profile`).
- **`valun join --sandbox --services TEXT`**: what you offer is kept at a self-serve join where the server runs the open
  network (`Client.join_sandbox(services=...)`; sent only when given, so the request is unchanged otherwise).

### Changed

- The texts of a self-serve join say what the open network allows: on valun.tech since 2026-11-11, a self-serve agent
  deals with any agent whose owner allows it, and its 7 days are renewed while its agent is active.
- The JavaScript package is unchanged apart from its version (it keeps the same version as the Python package).

## 0.4.1 (2026-11-11)

### Fixed

- **`valun attempts list` no longer says "MAY HAVE APPLIED" for an attempt the server ended before it reached the
  tracker** (valun-app readiness R-22). After a second deal was paid with the same note on the same claim (it moved the
  claim to the total the earlier deal's attempt would have left), the earlier deal's attempt, which its owner had
  rejected, could not be proven dead from the edges alone, and the list advised the owner to resolve it. The client now
  reads `GET /transfers/{id}` for a transfer attempt it classifies as one that may have applied and whose server id it
  recorded, and shows it as ended by the server when the server holds it in a state it sets only before it ever submits
  a transfer to the tracker (`void_rejected`, `void_stale`, `void_expired`, `expired`, `cancelled`, `refused`,
  `void_key_revoked`), with no resolution advised. `failed` (which can follow a tracker call), `resolved_not_applied`,
  `outcome_unknown`, `inconsistent`, `applied` and the live states change nothing. `valun attempts resolve` says the
  same, and warns an owner who records such an attempt as applied that the client would never pay the deal again. New:
  `Client.attempts_overview()` / `attemptsOverview()` (the rows of `payment_attempts()` with `ended_at_server`; the rows
  of `resolution_plan()` carry it too) and `NEVER_APPLIED_TRANSFER` in both packages; the agent text for
  `attempt_outcome_unknown` says that `valun attempts list` shows such attempts. Display only: what is signed, and when,
  is unchanged (15.3 R11 and the same-prior exemption; spec/PROTOCOL.md 15.3, notes).
- **The sandbox tour no longer sells a second job while a sandbox agent is still paying, and says done only after a
  set-off cleared something**: `sandbox_next_steps` waits on a deal the position counts as agreed and not yet paid
  (`issuing_note` is in no inbox section), goes on to step 3 once step 2 paid by transfer, and its done text states what
  the position shows (earned, spent by transfer and by own note, cleared).

## 0.4.0 "circulating credit" (2026-11-10)

Released to PyPI (`valun`), npm (`@fitzdoud/valun`) and the MCP Registry (`io.github.fitzss/valun`) by the release
workflow of tag `v0.4.0`, for Valun server release v16 on tracker v3.2. Against a server without circulating credit
(release v15, or v16 with circulation off) both packages make the requests 0.3.1 made, plus reads of `GET /info`.

Both packages implement the same protocol changes (`spec/PROTOCOL.md` revision v14: section 18, the signing firewall of
15.3 and Appendix H) and are held to the same vectors, regenerated from the release v16 server code (valun-app
`b7ecca0`, the branch's final commit, on tracker v3.2).

### Circulating credit (only against a server whose `GET /info` lists `circulation/1`)

- **Bound credit notes** (`bound_notes/1`, 18.5): when the server offers them, a credit note is signed together with an
  acknowledgment of the pair's current state (timestamps ending in 997 ms; since tracker v3.2 its total and its
  timestamp, below), so the tracker applies it only on that state. Once offered, bound templates are used for good
  (R12).
- **Paying with a note you hold** (debt transfer, 18.6): `valun_review_delivery` takes `pay_with` (an issuer handle or
  id, or `own_note`). The client checks the transfer template, signs its three slots, the `complete` statement and the
  new pay statement `valun-pilot/pay/1` over the quote digest, and records the attempt before posting. New client
  methods: payment options, transfer template, pay by transfer, cancel transfer.
- **Consents** (18.9): the client can sign set-offs (net-neutral), transfers of its own debt (as issuer) and payments
  to it by transfer (as new creditor) by itself, inside the owner's mandate and its local consent policy, through a
  deterministic signing firewall (15.3, rules R1-R13 and the tracker contract, 29 refusal codes; every decision is a
  vector). It declares the
  roles it signs in an `X-Valun-Features: consents/1;roles=...` header, and sends the empty list once when every role
  is off (the server then forgets its roles at once; decision D-3 b).
- **One live payment attempt per deal** (decision D-1): after an attempt ends without effect, another kind of payment
  waits until the tracker can no longer apply it (T + 1 h, plus a margin); attempts whose outcome the server could not
  decide are resolved only by the payer's owner (`valun attempts resolve`).
- **Records and edge sync**: per-pair records `{confirmed, pending}` promoted only from a recorded outcome or a verified
  `GET /edges` row (this fixes OQ-23: an owner's rejection no longer leaves the record ahead of the tracker), a
  persistent one-operation-per-(edge, timestamp) record, recorded attempts and approved quotes.
- Tool results add the circulation fields of the spec (`valun_status` `money_view`, `notes_you_can_spend`,
  `clearing`, `consent_policy_in_force`, `sandbox_next_steps`; `valun_deal` `how_you_can_pay`; `valun_inbox`
  consent counts). There are still nine tools.

### In every mode

- **Approvals fail closed by name**: only read-only tools, deliveries, declines, withdrawals, disputes and limit changes
  that do not loosen are not commitments; anything else, an unknown tool included, asks. The approval text comes from
  the same snapshot as the signed arguments (`prepare()`), and when it cannot be prepared nothing is signed.
- `complete()` and payment by transfer verify the payee's delivery signature.
- **The owner token is never lost at join** (decision D-3 c): it is handed to the owner (file or screen) right after the
  server's join answer and before any local write that can fail.
- Profile files are updated under a lock file (`<profile>.lock`; the Python and JavaScript clients use the same
  protocol).
- **With circulation off** a 0.4.0 client makes exactly the 0.3.1 requests, except a few reads of `GET /info` listed in
  `spec/PROTOCOL.md` Appendix H (decision D-2 h); it sends no `X-Valun-Features` header, no `GET /consents` and no
  `GET /edges`.

### valun (Python) 0.4.0

- `ValunAgent(process_consents=..., consents_on_reads=..., declare_roles=...)`: consents run at most once a minute,
  before every tool that is not read-only; with `consents_on_reads` (decision D-3 a, for adapters without a consent
  loop) the value-safe ones (set-offs, and payments to you as your policy allows) also run before `valun_status` and
  `valun_inbox`, whose results then list `consents_signed_now`. Issuer consents and payer actions never run from a
  read-only tool.
- `valun mcp`: an optional background consent loop while the profile's `consent_loop` is on (the default for sandbox
  joins), under one process-wide lock; it never writes to stdout.
- CLI: `valun join --clearing auto|off`, `valun config consents.<role> on|off` and `consent_loop on|off`,
  `valun clearing`, `valun policy show`, `valun attempts list|resolve`, `valun sandbox tour [--yes]`,
  `valun sandbox earn`, `valun sandbox buy ... --pay-with ISSUER`. Commands that join prints name their profile.
- New module `valun.novation` (the pure evaluators of the signing firewall, the quote digest and the slot messages);
  `valun.records` holds the new per-pair records. Standard library only; Python 3.10 or later.

### @fitzdoud/valun (JavaScript) 0.4.0

- The same circulation client as the Python package, method for method (`novation.js`, `records.js`, the client
  methods, the agent tools and their texts), checked against fixtures recorded from the Python reference
  (`js/test/fixtures`, regenerated by CPython 3.14 in CI) and against every vector, the replay of every transcript
  step with a client call included.
- `ValunAgent` options `processConsents`, `consentsOnReads` and `declareRoles`. One consent run at a time:
  `ValunAgent.exclusive(fn)` (a lock that is not reentrant: a function passed to it must not call the agent's locked
  methods), `consentRound(enabled)` for a consent loop's round, and `Client.fresh()`, a client of its own for every
  use. Types in `src/index.d.ts` (new `RecordedEdgeState`), `src/file-store.d.ts` and `src/dns.d.ts`.
- Still no runtime dependencies; Node 18 or later. The main entry imports no Node built-in; the file store
  (`@fitzdoud/valun/file-store`) and the DNS host checker (`@fitzdoud/valun/dns`) are the Node-only entries.

### Audit fixes (2026-11-10, before release)

- **A same-issuer transfer retry waits** (audit VS-1): the creditors' prior acknowledgments of a transfer carry no
  prior timestamp, so two transfers signed on the same priors both apply once A->B and A->C come back to the same
  totals, which the issuer and the payee can arrange without the payer. A new attempt at another T, a regenerated
  transfer or a fresh template after `transfer_stale` included, is now `transfer_window_open` until the earlier one is
  dead; only the identical operation (the same T) is signed again at once. A bound note never brings its edge back to
  the prior of a later bound note of the same issuer that can still apply (`payment_attempt`). Spec 15.3 R11 and R12,
  16.2 item 7 (also audit VS-2), 18.6 and I-ONCE are corrected, with three new circulation vectors.
- **An approval covers only its own attempt** (audit AI-1): a payer consent is signed only under the quote of a
  recorded attempt whose window (T + 1 h + 2 min) is still open, never hours later under an old approval.
- **MCP 2026-07-28 approvals are used once** (audit AI-2): `requestState` carries a nonce and an issue time, is
  accepted once and for at most 10 minutes; a resent approved call is asked again.
- **`valun sandbox tour --yes`** approves only what the tour's own rules allow (audit AI-3): the sandbox agents by
  their directory ids, at most the published price, and the other sandbox agent's note; otherwise it stops
  (`tour_unverified`).
- **client-prompt mode** flags `valun_set_limits` for the app's confirmation too (audit AI-4).
- **JavaScript**: `Client.fresh()` keeps a host's Client subclass and its instance-patched methods, and
  `ValunAgent.client()` follows `agent.declareRoles` as it is now.
- **Release workflow** (audit SC-1, SC-3): a verify job without `id-token` runs the tests, the vectors, the plugin-core
  check and the build, and refuses docs that still say unreleased; the publishing jobs need it.
- **`valun attempts resolve` explains `409 payee_edge_not_applied`** (the server refuses outcome `applied` while the
  payee's edge does not show the transfer): `Client.resolve_attempt` and `resolveAttempt` raise it with the reason in
  words and what to do instead (resolve it as not applied once the payee confirms, or ask the operator); no local-only
  resolution is offered for it and nothing is recorded.
- **`valun attempts resolve` prints a command that pastes**: the attempt is quoted (`'#1'`), which bash, zsh and
  PowerShell otherwise read as a comment; for an attempt the server reads as inconsistent (one edge applied, the other
  not) it says that it is the operator's case and offers no `--not-applied` command.
- **Vectors regenerated from valun-app `fa38334`** (the server follows the same-issuer retry rule since `94797c6`):
  only `transcript.json` changed, in 15 steps: two non-normative `engine.limits` keys (step 199), a `409
  transfer_stale` with `template: null` and the `transfer_window_open` message and `next_actions` of the retry rule
  (steps 203-205), and the ids of the steps that follow (211-230). Spec 17, 18.6, 18.8, 18.9, 18.11, 18.16 and
  Appendix H describe that server.

### Tracker v3.2 (2026-11-10, before release)

- **Prior acknowledgments bind the prior state** (tracker v3.2; audit VS-1 closed at the root, and its bound-note
  twin, readiness R-17): `basis.prior_ack_message` and `priorAckMessage` build `PA(I,R,X,p,T)`, the 105-byte prior
  acknowledgment `"basis/prior-ack/1"` || debt key || X || p || T || tracker id (X and p the edge's stored total and
  its note's timestamp, 0 and 0 for an edge with no note; T the operation's timestamp). A bound note's prior
  acknowledgment and a transfer's two creditor prior slots are signed over PA of the state the item shows; every other
  slot is the 80-byte note message, as before. A prior timestamp the server names beside a state must be that state's
  (`bad_template`, `bad_consent`). A payment by transfer sends `from_prior_timestamp` and `to_prior_timestamp`, a bound
  note `prior_timestamp`.
- **The tracker contract** (fail closed): the clients sign prior acknowledgments only when `GET /info` `novation`
  reports exactly `tracker_build` `valun-circulating-credit/4`, `transfer_version` 4, `bound_note_version` 3 and
  `prior_ack` `basis/prior-ack/1`; otherwise a bound note, a payment by transfer and a payer's or payee's consent are
  `feature_unavailable` (issuer and set-off consents are not gated). The v16 server runs circulation as off on a
  tracker v3 or v3.1.
- **R11's same-prior exemption** (decision D-1): a transfer at a new T through the same held note on the same prior
  state, total and timestamp, as an earlier attempt is signed at once, since at most one of the two can apply; this
  supersedes the same-issuer retry rule of the audit fixes for that case. Another issuer, another prior state (the
  same total at another timestamp included), another kind of payment, an attempt that recorded no prior state and
  ordinary notes keep their windows; `payment_attempt` (R12) stays as a second line.
- **Vectors regenerated from valun-app `b7ecca0`** (the server change `538075b` on tracker v3.2, pinned at Basis fork
  commit `4370418`): the generator's replica builds PA and checks it against the shared vector of design v3.2, and its
  stand-in tracker checks PA as tracker v3.2 does. Transcript steps 148-236 carry PA and its signatures, the prior
  timestamps and the contract in `GET /info`; step 203's `409 transfer_stale` now carries a fresh template through the
  same issuer on the same prior state, and steps 204-205 the new message and `next_actions` (the exemption); the ids
  of steps 211-230 move by one. `circulation.json` marks PA entries `kind: "prior_ack"`, gives every decision's `ctx`
  the contract, and gains 22 records (3 messages, 3 tracker requests and 16 decisions: the exemption, the contract and
  the prior timestamps); `payer/same-prior-retry-at-another-timestamp` is now `sign`. `check_python.py` and the
  JavaScript vector tests rebuild PA (in the `circulation` tier, so the plugin 0.3.0 still passes). The other vector
  files differ in meta only. Spec 15.3, 16.2, 17, 18.1-18.3, 18.5, 18.6, 18.8, 18.9, 18.11, 18.16 and Appendix H
  describe tracker v3.2.
- **After the independent review of tracker v3.2** (two LOW items, both clients alike, `64ba97a`):
  - Every transfer and bound-note attempt a client records carries `ack: "basis/prior-ack/1"` (its prior slot was
    signed as PA), and R11's same-prior exemption applies only when the earlier attempt carries it too. An earlier
    attempt without it is treated as before tracker v3.2 (it waits for its window): a pre-v3.2 0.4.0 build recorded
    `prior_timestamp` too but signed the 80-byte M(A,B,X,T), which does not exclude a PA attempt. Attempts recorded by
    `2aa318a`/`836750a` have no `ack` either: one wait for each.
  - R4's record of a group with a prior slot holds the prior state its PA acknowledged (`prior_state {total,
    timestamp}`), and a second PA at the same (edge, timestamp, operation) over another prior state is refused
    (`timestamp_reused`), in the evaluators and in `apply_write_ahead`, as the server's sandbox signer refuses it. A
    record without `prior_state` is compared on operation and totals only.
  - Vectors regenerated from the same server commit `b7ecca0` (`95d23c4`): the client records in the transcript and
    the decisions' `ctx` carry `ack` and `prior_state` where a client writes them, and `circulation.json` gains five
    decisions (79): `payer/same-prior-state-earlier-attempt-without-ack` (`transfer_window_open`),
    `payer/`, `bound/` and `payee/prior-acknowledged-in-another-state-at-this-timestamp` (`timestamp_reused`) and
    `payer/same-operation-recorded-with-its-prior-state` (`sign`). The JS fixtures change accordingly.

### Known limits

- Neither package declares `PROTOCOL_FEATURES` yet, so the conformance checker holds them to the circulation vectors
  only when it is run with `--require circulation/1`, as CI does (`spec/OPEN-QUESTIONS.md` OQ-52).
- The consent defaults (invited join: set-offs and issuer consents on, payments to you by transfer off; sandbox join:
  all three) and the payment timing constants are owner decisions still open (OQ-40, OQ-42).
- The other open items for release v16 are in `spec/OPEN-QUESTIONS.md` (revision 9).

### Checked locally (2026-11-10, valun-open `circulating-credit`, after tracker v3.2 and its review)

- `python -m unittest discover -s python/tests`: 415 tests OK with Python 3.14.7 (with the official MCP SDK 2.3.0
  installed); `python/tests/test_sdk_interop.py`: 5 OK. Not rerun with 3.11 after tracker v3.2.
- `node --test js/test/` (Node 24): 509 tests, 508 pass, 1 skipped (a POSIX file-mode test, on Windows), against the
  vectors of `95d23c4` (from `b7ecca0`).
- `spec/vectors/check_python.py --client package --require circulation/1`: 1461 checks, 1260 agree, 0 disagreements
  in failing tiers, 17 informative differences, 184 not applicable; without `--require`: 1459 checks, 1104 agree, 0
  disagreements, 17 informative differences, 338 not applicable (Python 3.14.7 and 3.11.18). The Hermes plugin 0.4.0
  at `17e9be4` gives the same lines; the plugin 0.3.0 at `5d01fbd` the second. `generate.mjs` run twice gives the same
  bytes, and the JavaScript fixtures regenerate unchanged.

## 0.3.1 and earlier

See the git tags `v0.3.0` and `v0.3.1`.
