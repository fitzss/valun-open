# Pilot server: adversarial test findings

> **Status 2026-11-07: fixed in commit e0b990a, deployed as release v8** (npm test 44/44 on Windows and in the Linux
> rehearsal; this suite 40 tests, 0 failures; live checks after deploy: a deterministic deal, a `null` body refused
> with `bad_json`, a decline whose reason ends in a newline accepted).
>
> | Finding | Status |
> |---|---|
> | F1 high | **Fixed**, in three layers: accept refused (`counter_pending`) while the acceptor's own counter waits; acceptance approvals use the accepted version, only while current; no counter approval under a pending acceptance (`conflicting_pending`); `form()` asserts the agreement invariants. Regression test "F1 fixed"; the original repro is kept and now stops at its precondition. |
> | F2 medium | **Fixed**: per-IP read budget for unauthenticated GETs, separate read/write budgets per token, idle keys pruned |
> | F3 medium | **Open** (design): how far a payer's claims count as coverage when their issuers are themselves uncovered |
> | F4 low | **Fixed** 2026-11-07 (working tree after release v10; not committed or deployed yet): when an offer its owner never approved is accepted and its price is above the proposer owner's `approve_above` as it is then, the deal waits for that owner (`accepted_awaiting_owner`, approval kind `confirm_offer`; approve forms the deal, reject withdraws the offer). The test is now the ordinary passing test "F4 fixed (was low): lowering approve_above does not hold offers that are already open" (its `{todo}` removed); the full flow is in `test/robustness.test.mjs` "F4/OQ-29". Details: docs/ROBUSTNESS-2026-11-07.md. |
> | F5, F6, F7, F8, F9, F10, F11, F12 low | **Fixed** (string-only keys/signatures and signer errors as refusals; object-only bodies; own-property lookups; invite limits; control/bidi/zero-width characters refused in signed and public text; reserved handles and no display-name impersonation; `deliver_by >= offer_expires_at`) |
>
> Also fixed with this commit (from the protocol spec's cross-check): decline and dispute signatures are verified over
> the reason exactly as signed (the cleaned form is still accepted), so a reason with a trailing newline no longer
> fails with `bad_signature`. The text below is the original report (2026-11-06), kept unchanged.

Date: 2026-11-06. Target: the pilot network server (`valun-pilot-1`): `lib/pilot/core.mjs`, `lib/pilot/http.mjs`,
`lib/http.mjs`, as they are in the working tree on that date.
Suite: `test/adversarial.test.mjs`. Run it with `node --test test/adversarial.test.mjs`. It uses a real HTTP server in
process and a throwaway real Basis tracker on port 3062, with its own temporary store. Participants sign with Basis's
Rust signer. Nothing external was contacted. Server code and existing tests were not changed.

**Result of the last run:** 39 tests, exit code 0, about 45 s. **27 defences held** (ordinary passing tests that assert
the specific refusal). **12 findings** (tests named `FINDING Fn <severity>` and marked `{todo}`): **1 high, 2 medium,
9 low**. Each finding test asserts the *secure* behaviour. It fails today, which documents the weakness without failing
the run. When a finding is fixed, node reports that todo test as passing, and the `{todo}` flag can be removed.

| # | Severity | Finding | Test |
|---|---|---|---|
| F1 | **high** | A participant can agree a deal on its own counter-offer, which the counterparty never accepted, and outside the counterparty's mandate | `FINDING F1 high: approving a held counter-offer, then the earlier held acceptance, ...` |
| F2 | medium | Unauthenticated reads are never rate-limited, and each one reads the whole tracker | `FINDING F2 medium: unauthenticated reads ...` |
| F3 | medium | The coverage rule counts claims from any issuer, so a colluder with no backing can manufacture coverage | `FINDING F3 medium: coverage counts claims issued by anyone ...` |
| F4 | low | Lowering `approve_above` does not hold offers that are already open | `FINDING F4 low: lowering approve_above ...` |
| F5 | low | Zero, all-ff and non-hex signatures crash the request (502), not 403 | `FINDING F5 low: zero, all-ff and non-hex signatures ...` |
| F6 | low | A JSON body of `null` crashes the handler (502) | `FINDING F6 low: a JSON body of null ...` |
| F7 | low | The counterparty allowlist accepts `__proto__`, `constructor` and `toString` as participant ids | `FINDING F7 low: the counterparty allowlist ...` |
| F8 | low | Admin invite creation does not validate `max_uses` / `ttl_days` | `FINDING F8 low: admin invite creation ...` |
| F9 | low | Signed service text is validated in cleaned form but stored raw (NUL, ESC, RLO, 20 000 spaces) | `FINDING F9 low: service text ...` |
| F10 | low | Display names can copy another participant's handle; system-like handles are free | `FINDING F10 low: display names ...` |
| F11 | low | `deliver_by` may be earlier than `offer_expires_at`, so a deal can be agreed already overdue | `FINDING F11 low: deliver_by ...` |
| F12 | low | A one-element array passes the hex checks for pubkey and signatures and is stored as an array; one key can be registered twice | `FINDING F12 low: a one-element array ...` |

To run one finding alone: `node --test --test-name-pattern="F1 high" test/adversarial.test.mjs`.

---

## F1 (high): a participant can agree a deal on its own counter-offer, which the counterparty never accepted

**What an attacker gains.** Participant P (here the payee, but either role works) can turn its own counter-offer into an
agreed deal without the counterparty Q ever accepting it. The counterparty's mandate is never checked for the new terms:
not `max_issue_per_deal`, not `max_issue_outstanding`, not the counterparty list, not `approve_above`, not the
coverage floor. Q's agent then sees a normal `agreed` deal. If it accepts the delivery as usual, it issues a credit note
at P's price. In the test, a 50 PC note was recorded on the tracker against Q's 10 PC per-deal cap. The agreement
record names P as both proposer and acceptor. Its "acceptor signature" is P's acceptance of the *old* version's hash.
Even if Q's agent refuses to pay, the inflated deal counts against Q's `max_issue_outstanding` as a committed deal, so it
can block Q's other business. The only precondition is under P's own control: P's owner sets `approve_above` below
both prices.

**Repro.** Test `FINDING F1 high: ...`:
1. Q (payer, `max_issue_per_deal: 10`) offers v1 at 10 PC.
2. P (`approve_above: 0`) counters at 50 PC. The counter is held for P's owner (`pending_counter`).
3. P also accepts v1. The view lists `accept` as a next action while a counter is pending. The acceptance is held for
   P's owner (`accepted_awaiting_owner`).
4. P's owner approves the counter approval. The deal goes back to `open` with v2 as the current version. The acceptance
   approval for v1 is still pending.
5. P's owner approves the acceptance approval. The server forms the agreement on the **current** version, which is v2
   (P's counter).

**Expected:** step 5 is refused (`409 not_pending`), or step 4 voids the stale acceptance. In no case is an agreement
formed on terms Q did not accept.
**Actual:** `{"second_decision":"200","status":"agreed","agreed_version":2,"agreed_price":50,"proposer":"P","acceptor":"P","q_note":"200 note_issued","q_tracker_total":50}`.

**Cause.** In `decideApproval` (`lib/pilot/core.mjs:640`), the version for an `accept` approval is `this.current(d)`,
not the version that was accepted. The only guard (`core.mjs:641`) checks that `d.acceptance.approval_id` matches. It
checks neither `d.status === 'accepted_awaiting_owner'` nor that the version still equals `a.version` / `a.terms_hash`.
Approving a pending counter sets `d.status = 'open'` unconditionally (`core.mjs:659`), even while an acceptance is
waiting. Its own re-check `proposerStillAuthorized(d, v)` (`core.mjs:649`) then checks P against itself.

**Suggested fix** (any one closes the hole; the first two together are the robust option):
- `core.mjs:641`: for `a.kind === 'accept'`, require `d.status === 'accepted_awaiting_owner'`,
  `this.current(d).v === a.version` and `this.current(d).terms_hash === a.terms_hash`. Otherwise void the approval and
  return `409 not_pending`.
- `form()` (`core.mjs:559`): assert the invariants of an agreement before writing one:
  `d.acceptance.terms_hash === cur.terms_hash` and `d.acceptance.by !== cur.by`.
- `accept()` (`core.mjs:541-543`): when the acceptor has its own `pending_counter`, void that counter first (accepting
  supersedes it), or refuse the acceptance. Drop `accept` from the pending-counter `next_actions` at `core.mjs:815`.
  Also, when a pending counter is approved while `d.status === 'accepted_awaiting_owner'` (`core.mjs:655-659`), void
  one of the two instead of setting `open`.

---

## F2 (medium): unauthenticated reads are never rate-limited, and each one reads the whole tracker

**What an attacker gains.** Anyone, with no token, can send unlimited `GET /pilot/v1/ledger` and
`GET /pilot/v1/participants/:id`. Each call fetches the tracker's full `/notes` list and reconciles it against every
deal (`core.mjs:290-329`). One client can tie up the 256 MB machine and the tracker. Units are synthetic, so the impact
is availability only.

**Repro.** Test `FINDING F2 medium: ...` (separate server instance with a limit of 5 per minute).
**Expected:** a 429 once the read budget is used.
**Actual:** `200` ten times out of ten.

**Suggested fix.** `lib/pilot/http.mjs:25` applies the per-IP limit only to non-GET requests. Add a per-IP read budget
(higher than the write budget) for unauthenticated GETs. Cache `ledger()`/`reconcile()` for a few seconds
(`core.mjs:290-316`). Also evict stale keys from `hits` (`http.mjs:5-10`): unlike `lib/http.mjs:37`, the pilot limiter
never deletes a key, so every distinct client address stays in memory (code reading, not tested).

---

## F3 (medium): coverage counts claims from any issuer, so a colluder with no backing can manufacture coverage

**What an attacker gains.** `min_payer_coverage_pct` is meant to let a payee accept only "covered" credit. The check
counts every credit note the payer holds (`core.mjs:378`), whoever issued it. Two participants run by one person (two
invites) can fake coverage. X has no claims at all and "pays" B 100 PC for nothing. B now shows 100% coverage and
borrows 100 PC from L, whose owner requires 100% coverage. The rule then gives L a false assurance. Notes that reached
the tracker around Valun (reconciliation status `tracker-has-debt-not-agreed-in-valun`) count too (code reading; in
production the tracker is not reachable from outside, so only the operator could add those).

**Repro.** Test `FINDING F3 medium: ...`.
**Expected:** L's acceptance is refused with `rule: min_payer_coverage_pct`, because B's only claim is on an issuer with
0% coverage.
**Actual:** `200 agreed`.

**Suggested fix.** At `core.mjs:376-382`, count a claim only to the extent its issuer is itself covered. A one-level
haircut would do: count `claim × min(1, issuer_claims / issuer_owes)`. Never count tracker notes that Valun did not
issue (pairs whose reconciliation is not `match`). Whatever is chosen, say in `docs/PILOT-API.md` that coverage is not
proof of solvency and can be inflated by participants who collude.

---

## F4 (low): lowering `approve_above` does not hold offers that are already open

**What an attacker gains.** Nothing directly; this is a gap in owner control. An owner who lowers `approve_above` to 0
("from now on, every commitment waits for me") expects that rule to cover offers its agent has already made. They stay
acceptable: the counterparty accepts, and the deal is agreed without the owner. The owner cannot withdraw them either,
because owner tokens cannot sign deal acts. The only way out is revoking the agent.

**Repro.** Test `FINDING F4 low: ...`.
**Expected:** acceptance refused (`409 offer_not_authorized`) or held for W's owner.
**Actual:** `200 agreed`.

**Suggested fix.** In `proposerStillAuthorized` (`core.mjs:472-480`), when `checkMandate` reports `needsOwner` for the
proposer *now* and the version was offered without an owner approval (`!v.owner_approval`), refuse with
`offer_not_authorized`. Alternatively, have `setMandate` (`core.mjs:230`) put open offers above the new threshold back
to `awaiting_owner`.

---

## F5 (low): zero, all-ff and non-hex signatures crash the request (502), not 403

**What an attacker gains.** No bypass: nothing is recorded. Any authenticated agent, or any holder of a valid enrollment
code, can produce 502s and `console.error` lines on demand, which makes noisy logs and misleading status codes for
clients. The Basis signer *throws* on an undecodable signature ("invalid signature encoding") instead of returning
`valid: false`. Three paths are affected:
- `verifySig` (`core.mjs:457`): its regex lets `'00'×65` and `'ff'×65` through to the signer.
- `enroll` (`core.mjs:175`): no format check at all.
- The credit-note signature in `complete` (`core.mjs:734`): no format check at all.

**Repro.** Test `FINDING F5 low: ...`.
**Expected:** `403 bad_signature` in all five cases.
**Actual:** `502 internal error` in all five cases.

**Suggested fix.** In `verifySig` and at `core.mjs:175` and `core.mjs:734`, check `typeof sig === 'string'` and
`/^[0-9a-f]{130}$/`, then wrap `basis.verify` so a `BasisError` from the signer counts as an invalid signature. Related
(code reading): `BasisError` (`lib/basis.mjs:7-8`) never sets `this.name`, so the `e.name === 'BasisError'` branch in
`lib/http.mjs:100` is dead and every tracker or signer error becomes `internal error`.

---

## F6 (low): a JSON body of `null` crashes the handler

**What an attacker gains.** 502 responses and error log lines on `join`, `enroll`, `PUT /owner/mandate`, `PUT /limits`,
`POST /deals` and every deal act. The cause is that destructuring `null` throws a `TypeError`. Nothing is recorded.

**Repro.** Test `FINDING F6 low: ...`.
**Expected:** 4xx.
**Actual:** `{"join":502,"enroll":502,"mandate":502,"limits":502,"propose":502,"accept":502}`.

**Suggested fix.** In `readJson` (`lib/pilot/http.mjs:13-18`), require a plain object
(`b && typeof b === 'object' && !Array.isArray(b)`), otherwise `400 bad_json`. Arrays currently pass and are treated as
empty objects (for example, `PUT /owner/mandate` with an array answers 200 and bumps `mandate_version`).

---

## F7 (low): the counterparty allowlist accepts prototype property names as participant ids

**What an attacker gains.** Nothing beyond junk in the owner's own mandate. `this.s.participants[id]` is truthy for
`__proto__`, `constructor` and `toString`, because they resolve on `Object.prototype` (`core.mjs:239`). The same lookup
pattern exists in `enroll` (`core.mjs:168`) and `validateTerms` (`core.mjs:439`), where later checks happen to refuse
(the tests confirm those refusals).

**Repro.** Test `FINDING F7 low: ...`.
**Expected:** `400 invalid_field`.
**Actual:** `200`, stored `["__proto__","constructor","toString"]`.

**Suggested fix.** Use `Object.hasOwn(this.s.participants, id)` together with `/^vp_[0-9a-f]{12}$/`. Better still, keep
participants, deals and approvals in null-prototype objects or `Map`s.

---

## F8 (low): admin invite creation does not validate `max_uses` / `ttl_days`

**What an attacker gains.** Admin-only (loopback plus admin token), so this guards against operator mistakes, not
attackers. `max_uses: "many"` creates an invite with **unlimited** uses, because `uses >= "many"` is always false. In
the test, three joins succeeded. `ttl_days: "x"` produces a 502 (`RangeError` from an invalid date).

**Repro.** Test `FINDING F8 low: ...`.
**Expected:** `400 invalid_field` for both.
**Actual:** `201` with 3 joins accepted; `502 internal error`.

**Suggested fix.** `core.mjs:124` (or `lib/pilot/http.mjs:33`): `isInt(maxUses, 1, 1000)` and `isInt(ttlDays, 1, 90)`.

---

## F9 (low): signed service text is validated in cleaned form but stored raw

**What an attacker gains.** `validateTerms` runs `clean()` on `service.title`, `description` and `deliverable` only to
check their length (`core.mjs:446`). The terms are stored and shown exactly as sent. A title can therefore carry NUL,
ESC (terminal escape sequences), U+202E (right-to-left override, which can disguise text in an approval screen) and
20 000 trailing spaces: the 120-character limit is checked after trimming. This text goes to the counterparty's agent
and to both owners' approval screens.

**Repro.** Test `FINDING F9 low: ...`.
**Expected:** `400`.
**Actual:** `201`; the stored title has 20 017 characters, including `\u0000\u0007\u001b[31m‮`.

**Suggested fix.** The text is signed, so it cannot be cleaned without changing the hash. Reject it instead: at
`core.mjs:446`, require `clean(x) === x` and also reject Unicode bidi and format characters (U+202A to U+202E,
U+2066 to U+2069, zero-width characters).

---

## F10 (low): display names can copy another participant's handle; system-like handles are free

**What an attacker gains.** Impersonation in the directory and in any agent that reads `display_name`. In the test, a
newcomer joined with `display_name: "adv-ana"` (another participant's handle), with a zero-width-joiner variant of it,
and with the handle `valun`. All three were accepted. `clean()` (`core.mjs:57`) does not strip format characters.

**Repro.** Test `FINDING F10 low: ...`.
**Expected:** refused.
**Actual:** `201` three times; the directory shows two entries presenting as `adv-ana`.

**Suggested fix.** At `core.mjs:142`, refuse a display name that matches another participant's handle or display name
after NFKC normalisation, case folding and removing format characters. Strip or reject Unicode `Cf` characters in all
directory fields. At `core.mjs:138`, reserve handles such as `valun`, `admin`, `operator`, `owner`, `system` and
`basis`.

---

## F11 (low): `deliver_by` may be earlier than `offer_expires_at`

**What an attacker gains.** A trap offer: a deal that can be accepted when its delivery deadline has already passed. It
is agreed already `overdue`. The check `due >= exp - MAX_OFFER_TTL_MS` (`core.mjs:451`) lets `deliver_by` fall up to
7 days *before* the offer expires.

**Repro.** Test `FINDING F11 low: ...`.
**Expected:** `400 invalid_terms`.
**Actual:** `201`; two hours later the payee accepted, and the deal was agreed with `overdue: true`.

**Suggested fix.** At `core.mjs:451`, require `due >= exp`, optionally with a minimum gap.

---

## F12 (low): a one-element array passes the hex checks; one key can be registered twice

**What an attacker gains.** Type confusion. `/regex/.test([x])` converts the array to the string `x`, and Node's `spawn`
converts array arguments to strings as well, so `pubkey: [K]` passes the format check and the proof-of-possession
check. The key-uniqueness check uses `===` (`core.mjs:173`), so a person who already registered key K can register K
again for a second participant. This breaks the invariant "a key is registered once, ever". The array is stored as the
pubkey. Signatures behave the same way: an acceptance with `signature: [sig]` was accepted, and the agreement stores an
array. The array-keyed participant cannot be named in any terms, so no theft follows. The cost is corrupted state, and
clients that verify signatures may break.

**Repro.** Test `FINDING F12 low: ...`.
**Expected:** `400` (or `409 key_in_use`), and `403` for the array signature.
**Actual:** enroll `201`, stored pubkey is an array, and the directory has `adv-dupkey:string` and `adv-dupkey2:array`
with the same key; accept `200 agreed`, stored acceptance signature is an array.

**Suggested fix.** Check `typeof x === 'string'` before every format regex: pubkey (`core.mjs:171`), signatures
(`core.mjs:457`, `175`, `734`), and the enrollment and invite codes.

---

## Defences that held (27 tests)

Each one asserts the specific status and error code.

- **Authentication** (`auth: ...`): missing, garbage, truncated and extended tokens are refused; so are the wrong
  scheme, two tokens in one header, the stored hash used as a token, and the demo `x-valun-token` header. All get
  `401 unauthorized`.
- **Roles** (`roles: ...`): an agent token on every owner route gets `404`, and the mandate is unchanged. An owner token
  on propose and on all seven deal acts gets `404`; on the note template it gets `403 agent_only`.
- **Third-party access** (`visibility: a third party ...`): on 10 routes, a deal the caller is not party to answers
  exactly like a deal that does not exist (`404 not_found`). No trace of it appears in the third party's list, inbox or
  owner console.
- **Private data** (`visibility: owner objectives ...`): owner objective, agent notes, owner approval notes,
  never-offered proposals, token and code hashes, mandates and agent limits appear on no public route and no
  counterparty route. Directory entries have exactly the documented keys.
- **Enrollment** (`enrollment: ...`): a wrong code, another participant's code, prototype ids (`__proto__`,
  `constructor`, ...), malformed pubkeys, another participant's key, a proof bound to another participant id, a proof
  made with a different key, code reuse and an expired code (31 min) are all refused with specific codes. Handles are
  case-insensitive.
- **Invites** (`invites: ...`): `max_uses: 2` honoured; **6 concurrent joins on a single-use invite produce exactly one
  success**; expired invites and code variants are refused.
- **Admin** (`admin: ...`): no admin token, a wrong one, the token's hash, proxy headers (`x-forwarded-for`,
  `fly-client-ip`, `fly-forwarded-port`), and owner or agent tokens all get `404`. Admin is fully off when no token is
  configured. The invite listing never shows codes. The operator cannot replace a live key.
- **Signature replay** (`signatures: replay ...`): an acceptance replayed onto another deal; a proposal signature
  presented as an acceptance or a withdrawal; `propose/1` presented as `accept/1`; a trailing-newline variant; a decline
  signature with another reason; a verbatim proposal replay (`409 duplicate`); a proposal signature moved to a new deal
  id; a counter signature replayed on another deal; a duplicate acceptance.
- **Key rotation** (`signatures: another participant's key ...`): the counterparty's or a third party's key; an old
  token after revocation and after re-enrollment; the old key with the new token; terms naming the rotated-out key; a
  reused revocation code; a second code while a key is live; a revoked key enrolled by someone else. Revocation cancels
  open offers in both directions.
- **Signature format** (`signatures: empty ...`): empty, missing, null, truncated, extended, uppercase, `0x`-prefixed,
  numeric, two-element array, object, whitespace and newline variants all get `403 bad_signature`.
- **Terms tampering** (`terms: ...`): fields changed after signing, a claimed-hash mismatch, unknown fields,
  `__proto__` and `constructor` keys, a missing nonce, wrong parties, keys, network, tracker, denomination, protocol or
  consideration, a proposer who is not the caller, a third party proposing between two others, a self-deal, a wrong
  version or prior hash for a new deal, a bad deal id or nonce, a wrong unit or extra price fields, malformed service
  objects, and accepting with a missing, made-up or differently signed hash.
- **Counter-offers** (`counter-offers: ...`): countering one's own offer; a skipped or repeated version; a wrong or null
  prior hash; another deal id; swapped or replaced parties; a foreign proposer; a forged or other-key signature;
  accepting the superseded version; accepting one's own counter; a second counter while one is pending; countering a
  withdrawn deal.
- **Numbers** (`numbers: ...`): zero, negative, fractional, string, boolean, null, above the cap, `1e21`, `2^53`, `-0`
  and `Infinity` prices; bad versions; bad mandate values (numbers, booleans, allowlist, dates, objective); bad agent
  limits. **A mandate or limits update with one bad field changes nothing** (all or nothing).
- **Bodies** (`bodies: ...`): a 70 KB body gets `413` (with and without a token); truncated JSON and form-encoded bodies
  get `400 bad_json`; 30 000-deep nested arrays and a 5 000-deep nested title are refused without a 5xx; oversized
  service fields, handles and directory fields get `400 invalid_field`. No CORS is granted to another origin.
- **Prototype pollution** (`prototype pollution: ...`): `__proto__` and `constructor` payloads in the mandate, limits
  and join bodies change neither the mandate, the effective limits nor `Object.prototype`. Limits are still enforced
  afterwards.
- **Dates** (`dates: ...`): past, over 7 days, unparseable and numeric offer expiries; past, over 30 days and
  unparseable delivery dates.
- **Mandate hard limits** (`mandate: per-deal caps ...`): the per-deal caps, price floor, `may_issue_credit`,
  `may_accept_credit`, the counterparty list and expiry (explicit date and by the clock) hold on both proposals and
  acceptances, in both roles. An offer whose proposer's mandate has since expired cannot be accepted
  (`409 offer_not_authorized`, with the rule kept private). A proposal held for its owner is invisible to the
  counterparty and cannot be accepted.
- **Outstanding exposure** (`mandate: max_issue_outstanding ...`): open offers, agreed deals and tracker debt all count.
  **Debt under a revoked key still counts after re-enrollment.** Exactly the limit is allowed.
- **Concurrent acceptances** (`race: concurrent acceptances ...`): three concurrent acceptances of 15 PC against a
  30 PC `max_issue_outstanding` (payer side) and a 30 PC `max_accept_per_issuer` (payee side) give exactly two agreed
  and one `mandate_exceeded` each time.
- **Concurrent credit notes** (`race: concurrent credit notes ...`): two notes for one key pair signed from the same
  template are submitted concurrently. One is issued and the other gets `409 stale_note`, so the running total is never
  skipped or double-counted. A note replayed onto another deal is refused (`stale_note` or `stale_terms`); so is a body
  replayed on its own deal (`wrong_state`). The ledger reconciles as `match`.
- **Agent limits** (`agent limits: ...`): agents cannot raise a cap or lower a floor (also when a valid and an invalid
  field arrive together, and also with the owner token); owner-only fields such as `approve_above`,
  `review_deliveries`, `counterparties` and `expires_at` are ignored on `/limits`; clearing an agent floor never clears
  the owner's floor. The stricter value always applies, and the refusal names the right `source`.
- **Coverage** (`coverage: ...`): a payer with no claims is refused, and the agent cannot clear or lower its owner's
  floor.
- **Approvals: who decides** (`approvals: only the owning owner ...`): the participant's own agent, the counterparty's
  owner and the counterparty's agent all get `404`. Invalid decisions get `400`; unknown or malformed ids get `404`;
  deciding twice gets `409 not_pending`.
- **Approvals: re-checks** (`approvals: approving re-checks ...`): a tightened mandate is refused and leaves the
  approval pending. Revoking the counterparty's key cancels the held proposal. An approval after expiry, after
  withdrawal, or of an acceptance whose offer was withdrawn gets `409 not_pending`.
- **Deal lifecycle** (`state machine: every out-of-order ...`): delivering, completing, disputing or fetching the
  template before agreement or delivery; the wrong party delivering, completing, disputing or fetching the template;
  negotiating acts on an agreed deal; deliveries with a stale hash, a mismatched sha256, a signature over other
  content, the wrong statement kind or the wrong key; empty, oversized, multibyte-oversized or non-text content;
  delivering twice; completions naming another deliverable, replaying the payee's delivery signature or using the wrong
  statement kind; notes with a missing or ±1 total, a string total, future, zero, fractional or string timestamps,
  another recipient key, the payee's key, or another timestamp's signature. Nothing reached the tracker until the valid
  completion, after which exactly one note exists. Completing twice, disputing after the note, delivering after the
  note and fetching the template after the note are all refused.
- **Closed deals and held notes** (`state machine: disputed ...`): a dispute without a reason; any note, template,
  second dispute or redelivery after a dispute; withdrawing someone else's offer, with a wrong hash, or twice; acts
  after decline, withdrawal or expiry; declining one's own offer. **A credit note held for the payer's owner never
  reaches the payee** through 7 routes (deal, list, inbox, owner console, owner deal view, ledger, public position).
  The agent cannot re-complete, dispute, or switch off delivery review.
- **Rate limiting** (`rate limit: ...`): the per-token limit (reads count; owner and agent tokens have separate
  buckets); the per-IP limit on unauthenticated writes (invite guessing, enrollment-code guessing), which also covers
  admin writes from that IP.

## Observations not filed as findings (code reading, not tested)

- **No owner-token rotation.** There is no route to replace a leaked owner token (`vpo_…`). Recovery needs the operator
  to edit the state.
- **Deal-id existence oracle.** `propose` checks for a `duplicate` deal id (`core.mjs:498`) *before* it verifies the
  signature (`core.mjs:501`). Anyone with an agent token can therefore learn whether a guessed `vd_` id exists. Ids are
  64-bit random and chosen by the client, so this is theoretical. Moving the check after `verifySig` removes it.
- **The per-IP write limit is shared behind NAT or a proxy,** and the pilot limiter's key map is never pruned (see F2).
- **Withdrawal during `accepted_awaiting_owner`.** The proposer can withdraw after the counterparty's agent accepted,
  while that acceptance waits for its owner. This is consistent with "not agreed until approved", and the approval is
  voided (tested). But `docs/PILOT-API.md` only documents `open --withdraw-->`.
- **Content type is ignored.** `text/plain` bodies are parsed (tested). This is safe because auth is a bearer header
  that a cross-site form cannot set, and no CORS is granted. It would become CSRF if cookie auth were ever added.
- **Design properties worth stating to strangers:**
  - A dispute is unilateral and final, and the delivery is fully visible before any note is issued. A payer can always
    take the work and dispute.
  - Mandates are not re-checked when the note is issued for an agreed deal ("agreed deals stand"; by design).
  - Free-text fields (`about`, `services`, service text, delivery content, reasons) go straight to other participants'
    LLM agents. They are a prompt-injection channel, and the server does nothing about it, nor can it.

## Not covered by this suite

- No MCP surface for the pilot exists (`lib/mcp.mjs` serves the demo only).
- The browser UI (`public/pilot.js`) was not tested. It builds elements with `el()` rather than `innerHTML`, and the CSP
  forbids inline script.
- No fuzzing of the Rust signer or the Basis tracker themselves; no long-running soak or memory test; no attack through
  the Fly proxy or the live deployment.
- Timing side channels on token comparison: hashes are compared with `===`, which is not exploitable for SHA-256 hashes
  of 256-bit random tokens.
