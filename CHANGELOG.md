# Changelog

Release notes for the two packages in this repository: `valun` (Python, PyPI) and `@fitzdoud/valun` (JavaScript, npm).
The Hermes plugin keeps its own changelog in [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun).

## 0.4.0 "circulating credit" (unreleased draft)

**Not released.** Built and tested locally only: nothing in this section is on PyPI, npm or the MCP Registry, and the
server release it targets (valun-app release v16) is not deployed. Version numbers already read 0.4.0 in
`python/pyproject.toml`, `python/src/valun/__init__.py`, `js/package.json` and `server.json`.

Both packages implement the same protocol changes (`spec/PROTOCOL.md` revision v14: section 18, the signing firewall of
15.3 and Appendix H) and are held to the same vectors, regenerated from the release v16 server code (valun-app
`fa38334`, the branch's final commit).

### Circulating credit (only against a server whose `GET /info` lists `circulation/1`)

- **Bound credit notes** (`bound_notes/1`, 18.5): when the server offers them, a credit note is signed together with an
  acknowledgment of the pair's current total (timestamps ending in 997 ms), so the tracker applies it only on that
  total. Once offered, bound templates are used for good (R12).
- **Paying with a note you hold** (debt transfer, 18.6): `valun_review_delivery` takes `pay_with` (an issuer handle or
  id, or `own_note`). The client checks the transfer template, signs its three slots, the `complete` statement and the
  new pay statement `valun-pilot/pay/1` over the quote digest, and records the attempt before posting. New client
  methods: payment options, transfer template, pay by transfer, cancel transfer.
- **Consents** (18.9): the client can sign set-offs (net-neutral), transfers of its own debt (as issuer) and payments
  to it by transfer (as new creditor) by itself, inside the owner's mandate and its local consent policy, through a
  deterministic signing firewall (15.3, rules R1-R13, 28 refusal codes; every decision is a vector). It declares the
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

### Known limits

- Neither package declares `PROTOCOL_FEATURES` yet, so the conformance checker holds them to the circulation vectors
  only when it is run with `--require circulation/1`, as CI does (`spec/OPEN-QUESTIONS.md` OQ-52).
- The consent defaults (invited join: set-offs and issuer consents on, payments to you by transfer off; sandbox join:
  all three) and the payment timing constants are owner decisions still open (OQ-40, OQ-42).
- The other open items for release v16 are in `spec/OPEN-QUESTIONS.md` (revision 9).

### Checked locally (2026-11-10, valun-open `circulating-credit`, after the audit fixes)

- `python -m unittest discover -s python/tests`: 399 tests OK with Python 3.14.7 (with the official MCP SDK 2.3.0
  installed), after the vectors were regenerated from `fa38334`. Not rerun with 3.11 after the audit fixes.
- `node --test js/test/` (Node 24): 492 tests, 491 pass, 1 skipped (a POSIX file-mode test, on Windows). The type
  definitions were not compiled after the audit fixes (TypeScript is fetched from the network).
- `spec/vectors/check_python.py --client package --require circulation/1`: 1389 checks, 1191 agree, 0 disagreements
  in failing tiers, 17 informative differences, 181 not applicable (Python 3.14.7 and 3.11.18, vectors from
  `fa38334`).

## 0.3.1 and earlier

See the git tags `v0.3.0` and `v0.3.1`.
