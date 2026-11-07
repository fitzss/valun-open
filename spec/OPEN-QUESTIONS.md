# Open questions: `valun-deal/1` as implemented

> **Update 2026-11-07, release v9 = valun-app commit `ed1da4a`** (after this revision was written): OQ-30, OQ-31,
> OQ-32 and OQ-34 are **RESOLVED (ed1da4a)**, and OQ-33 is **RESOLVED (ed1da4a)** for the character set (ZWNJ/ZWJ and
> LRM/RLM allowed; C1 controls, ZWSP, word joiner and invisible operators, bidi overrides/isolates, BOM, annotation and
> tag characters refused; names compared normalized). Regression tests: `test/adversarial.test.mjs`, "OQ-30" to
> "OQ-34". The vectors and `PROTOCOL.md` below still describe v8 for these five items; regenerate before relying on
> them for v9.

Ambiguities, server/client inconsistencies, apparent bugs and security weaknesses found while writing `PROTOCOL.md`
and its vectors. Nothing here was changed in either implementation by this work.

**Revision 2 (2026-11-07), against server release v8 = valun-app commit `e0b990a`** (core.mjs sha256 `cc779241…3d73`,
http.mjs sha256 `cb826b1e…7c4f`). Each item from the first revision (2026-11-06, core.mjs `82212e52…6558`) now has a
status: **RESOLVED (e0b990a)**, **CHANGED** (partly fixed, or the fix changed the question), or **OPEN**. Items OQ-29
to OQ-34 are new in this revision; OQ-30 to OQ-34 are side effects or gaps of the v8 fixes. References are to v8 line
numbers: `core.mjs` = `valun-app/lib/pilot/core.mjs`, `http.mjs` = `valun-app/lib/pilot/http.mjs`; client references
are to `hermes-plugin-valun`, which is unchanged.

How each item is known: **[vectors]** shown by `spec/vectors/check_python.py` or asserted by `generate.mjs` against the
real code; **[probe]** reproduced by running the real server code in memory; **[code]** from reading the code only.

Severity: **high** = a normal user action fails or a party can be misled; **medium** = wrong or surprising behaviour in
reachable cases; **low** = edge case, hardening or documentation.

## Summary

| # | Topic | Severity | Status |
|---|---|---|---|
| OQ-1 | Decline/dispute reason signatures | high | RESOLVED (e0b990a) |
| OQ-2 | Non-canonical numbers in terms | low | OPEN |
| OQ-3 | Lone surrogates accepted | low | OPEN |
| OQ-4 | Canonical JSON outside the terms domain | low | OPEN (informative) |
| OQ-5 | `deliver_by` before offer expiry | medium | RESOLVED (e0b990a) |
| OQ-6 | Withdraw while an acceptance waits for its owner | medium | OPEN (allowed; state and `next_actions` inconsistent) |
| OQ-7 | Unswept expired offers count against mandates | medium | OPEN |
| OQ-8 | Agreed/delivered deals never end | medium | OPEN |
| OQ-9 | Non-object JSON body gives 502 | low | RESOLVED (e0b990a) |
| OQ-10 | Malformed keys/signatures give 502 | low | RESOLVED (e0b990a); side effect OQ-31 |
| OQ-11 | Rate limiter | low→medium | CHANGED: mostly fixed; bypass OQ-30 |
| OQ-12 | Template timestamp can be in the future | low | OPEN |
| OQ-13 | `mandate_version` bumps on empty PUT | low | OPEN |
| OQ-14 | Invite parameters not validated | low | RESOLVED (e0b990a) |
| OQ-15 | Lenient time strings | medium | OPEN |
| OQ-16 | Service text hashed and shown raw | medium | CHANGED: mostly fixed; gaps OQ-33 |
| OQ-17 | Token-denomination debt key not pinned | low | OPEN |
| OQ-18 | `/info` statements are JS source | low | OPEN |
| OQ-19 | Defaults that block silently | low | OPEN |
| OQ-20 | Owner-recorded "agent limits" | low | OPEN |
| OQ-21 | Keys are trusted from the server | medium | OPEN |
| OQ-22 | Signed notes that were never issued stay on the server | medium | OPEN |
| OQ-23 | Python client's issued-notes record gets ahead of the tracker | medium | OPEN (client) |
| OQ-24 | Owner tokens cannot be rotated | low | OPEN |
| OQ-25 | Deal-id existence oracle | low | OPEN |
| OQ-26 | Coverage can be manufactured | low | OPEN (adversarial F3, open by design) |
| OQ-27 | Public metadata | low | CHANGED: profile text filtered; metadata unchanged |
| OQ-28 | Python client checks it does not make | low | OPEN (client) |
| OQ-29 | Lowering `approve_above` does not hold open offers | low | OPEN (new; adversarial F4) |
| OQ-30 | Any bearer header skips the unauthenticated read budget | medium | OPEN (new) |
| OQ-31 | Signer failures look like bad signatures | medium | OPEN (new) |
| OQ-32 | Reasons: bidi/zero-width kept, raw controls shown, non-string accepted | low | OPEN (new) |
| OQ-33 | Unsafe-character set: gaps and over-refusal | medium | OPEN (new) |
| OQ-34 | Display-name rule: gaps and status code | low | OPEN (new) |

Resolved: OQ-1, 5, 9, 10, 14. Partly fixed: OQ-11, 16, 27. Still open: OQ-2, 3, 4, 6, 7, 8, 12, 13, 15, 17–26, 28,
and the new OQ-29 to OQ-34.

## A. Server and Python client

### OQ-1 (high, interop) Decline and dispute reasons — RESOLVED (e0b990a) [vectors]
Was: the server verified the signature only over `sha256(clean(reason))`, while the Python client signs the reason as
sent (valun_client.py:289, 347), so a reason with padding, a trailing newline or a control character failed with
`403 bad_signature` (49 disagreements in the first cross-check).
Now: the server verifies over the reason exactly as received and still accepts the cleaned form (core.mjs:612-618,
842-847, `verifySig` alternatives at 486-490). `generate.mjs` asserts, through the real `decline()`/`dispute()`, that
both forms are accepted for each of 33 reasons; `check_python.py` finds the Python statement among the accepted forms
for every reason, and the transcript replays of flow C (padding and a newline), flow C2 (a pre-v8 client signing the
cleaned text) and flow F (a dispute ending in a newline) agree, including the `tools.py` respond path that strips the
reason before sending it. Follow-ups: OQ-32.

### OQ-2 (low, interop) Non-canonical numbers in terms — OPEN [vectors]
The server accepts integer fields written as `2e1` or `1.0` and hashes the parsed integer (`canonical.json` tier
`wire`); the Python `canonical()` refuses floats (valun_client.py:45-47). A safe refusal that does not arise with
server-produced JSON. Should the server refuse non-integer number forms in terms?

### OQ-3 (low, interop/hardening) Lone surrogates are accepted — OPEN [vectors]
Unpaired surrogates are still accepted in service text, reasons and content: the v8 unsafe set (core.mjs:66) does not
include U+D800–U+DFFF. Node escapes them in `canonical()` and hashes them as U+FFFD; Python raises
`UnicodeEncodeError` (safe), strict UTF-8 libraries cannot represent them.

### OQ-4 (low, informative) Canonical JSON outside the terms domain — OPEN [vectors]
Integers above 2^53, `1e21`, fractions and non-BMP key order differ between Python and the server (valun_client.py:42
vs core.mjs:24). Harmless while the terms key set is fixed and ASCII.

## B. Server behaviour

### OQ-5 (medium, bug) `deliver_by` earlier than `offer_expires_at` — RESOLVED (e0b990a) [vectors]
core.mjs:474-475 now refuses it with `invalid_terms` ("deliver_by must not be earlier than offer_expires_at");
`terms-validation.json` `bad/deliver-by-before-offer-expiry`, `ok/deliver-by-equals-offer-expiry`; transcript step
"deliver_by earlier than offer_expires_at".

### OQ-6 (medium) Withdraw while the acceptor's acceptance waits for its owner — OPEN [probe, first revision; code unchanged]
`withdraw` (core.mjs:627-635) still succeeds during `accepted_awaiting_owner`: the deal becomes `withdrawn` and the
approval `void_withdrawn`, but `acceptance.state` stays `awaiting_owner`, and the proposer's `next_actions` is
`["wait_for_owner_approval"]` (core.mjs:872). The adversarial report calls the behaviour consistent with "not agreed
until approved"; PROTOCOL.md now documents it as allowed. Remaining: mark the acceptance (e.g. `cancelled`) and list
`withdraw` in `next_actions`, or forbid it.

### OQ-7 (medium, bug) Expired offers count against mandates until something reads them — OPEN [probe, first revision; code unchanged]
Expiry is lazy (`sweep`, core.mjs:422) but `exposure()` (core.mjs:358-368) counts `open`/`proposed_awaiting_owner` deals
without sweeping; a valid new offer can fail with `mandate_exceeded` because of an expired one nobody has looked at.
Positions and counts (core.mjs:340-352) also use unswept statuses.

### OQ-8 (medium, spec gap) Agreed and delivered deals never end — OPEN [code]
No timeout or cancel for `agreed` (payee never delivers) or `delivered` (payer never reviews). They stay in
`committed` (core.mjs:362) forever. A payer still cannot dispute after `note_failed` (core.mjs:840).

### OQ-9 (low, bug) Non-object JSON body gives 502 — RESOLVED (e0b990a) [vectors]
http.mjs:21 refuses `null`, arrays, strings and numbers with `400 bad_json`; transcript step "a JSON body that is not an
object".

### OQ-10 (low, bug) Malformed keys and signatures give 502 — RESOLVED (e0b990a); see OQ-31 [vectors]
Keys and signatures must be hex strings (core.mjs:63, 186-193); every verification goes through `safeVerify`
(core.mjs:481-484), so malformed or unverifiable input is `403 bad_signature` / `400 invalid_field`, never 502.
Uppercase hex is now refused for the note signature too. Transcript steps "a signature that is not a hex string" and
"a public key that is not a hex string". Side effect: OQ-31.

### OQ-11 (medium, docs/hardening) Rate limiter — CHANGED [code, probe]
Fixed: separate per-token read and write budgets (http.mjs:74; reads default to 4 × the write budget,
`pilotReadLimitPerMinute`), a per-IP budget for unauthenticated GETs (http.mjs:32), pruning of idle keys (http.mjs:10).
Still open: refused requests are recorded too (http.mjs:9), so an immediate retry stays limited; the per-IP budgets are
shared behind NAT, and a self-hosted server behind a proxy without `VALUN_TRUST_FLY_CLIENT_IP=1` gives every client one
budget (lib/http.mjs:32). New gap: OQ-30.

### OQ-12 (low, robustness) Template timestamp can be in the future — OPEN [code]
core.mjs:763 (`max(now - 1500, last + 1)`) vs core.mjs:781 (`timestamp <= now`): if the pair's last note has a future
timestamp (only possible for a note submitted around Valun), completion fails until the clock passes it.

### OQ-13 (low) `mandate_version` increments on every PUT, even an empty one — OPEN [probe, first revision; code unchanged]
core.mjs:265.

### OQ-14 (low, admin) Invite parameters — RESOLVED (e0b990a) [vectors]
core.mjs:136: `max_uses` 1–1000, `ttl_days` 1–90, else `400 invalid_field`; transcript step "admin invite outside
1..1000 uses".

## C. Under-specified or ambiguous

### OQ-15 (medium, interop) Lenient time strings, hashed as written — OPEN [vectors]
`Date.parse` (core.mjs:472) still accepts date-only strings, RFC 2822 dates, offsets and local-time strings without a
zone; the raw string is hashed. The Python client refuses some of them (valun_client.py:238; safe), other languages may
disagree silently. Suggest requiring `YYYY-MM-DDTHH:mm:ss(.sss)Z`.

### OQ-16 (medium, security/UX) Service text hashed and shown raw — CHANGED [vectors]
Fixed: C0 controls (except TAB/LF/CR), DEL, bidi overrides and isolates, zero-width characters and BOM are refused in
signed service text and public profile fields; raw service text is limited to max + 100 (core.mjs:66-73, 153-154).
Remaining: up to 100 characters of padding are still part of the signed text, and the character set has gaps and refuses
legitimate text (OQ-33). Length limits still count UTF-16 code units.

### OQ-17 (low) Token-denomination debt key not pinned by an official vector — OPEN
Basis's official vectors are `erg` only; the pilot uses `token:<id>`. The replica, the Python client
(valun_basis.py:175-180) and a local copy of Basis `types.rs` agree, but `valun_signer note-message` (basis.mjs:66-68),
the server's real code path, was not run. Run it once for `basis-notes.json` `pilot/first-note` and pin the output.

### OQ-18 (low) `/info` `statements` is JavaScript source text — OPEN
http.mjs:58. Suggest publishing templates and a version.

### OQ-19 (low, docs) Defaults that block silently — OPEN
`approve_above: 0` and a mandate that expires 14 days after joining (core.mjs:51, 165); after that every commitment fails
with `mandate_exceeded`, `rule: expires_at`.

### OQ-20 (low) Owner-recorded "agent limits" — OPEN
`PUT /limits` accepts the owner token (http.mjs:78); such limits are reported as `source: agent_limits`, "limit recorded
from the owner's instructions" (core.mjs:377).

## D. Security and trust

### OQ-21 (medium, security) Keys are trusted from the server — OPEN [code]
The directory comes from the same server; a dishonest server can substitute keys consistently, and the Python client
signs credit notes to the payee's current directory key (valun_client.py:316-320), so a claimed rotation can redirect a
note. Suggest key pinning and independent confirmation when the note recipient differs from the agreed payee key.

### OQ-22 (medium, security) Signed notes that were never issued stay on the server — OPEN [code]
Rejected, voided and stale payer-signed notes are kept with their signatures (core.mjs:235, 661, 674); any holder could
submit them to the tracker while the pair's state allows. Withholding relies on the server (`noteView`, core.mjs:899).

### OQ-23 (medium, client bug) Python client's issued-notes record gets ahead of the tracker — OPEN [code]
valun_client.py:337-338 records the total on `completion_awaiting_owner`; if the owner rejects or the note goes stale,
later completions to that payee key fail with `ledger_mismatch` (valun_client.py:324-326). A 502 during submission has
the opposite effect.

### OQ-24 (low, security) Owner tokens cannot be rotated or revoked — OPEN
No route (core.mjs:158, 208).

### OQ-25 (low, security) Deal-id existence oracle — OPEN [probe, first revision; code unchanged]
`duplicate` (core.mjs:530) is still checked before the signature (core.mjs:533).

### OQ-26 (low, honest label) Coverage can be manufactured — OPEN (adversarial F3)
core.mjs:399-405 counts every note a payer holds, including circular or colluding credit.

### OQ-27 (low) Public metadata — CHANGED
Public profile text is now filtered (OQ-16). Unchanged: the directory lists every participant with operator names,
`agent_last_seen` is public, position counts include deals waiting for the participant's own owner (core.mjs:344), and
`last_seen_agent` is persisted only at the next save (core.mjs:207).

### OQ-28 (low, client hardening) Python client checks it does not make — OPEN
`deliver` does not verify the agreement (valun_client.py:296-302); `verify_offer` does not check `deal_id`, `proposer`,
the version chain, `price.unit` or `consideration` (valun_client.py:213-240); text from terms, reasons and deliveries is
passed to the model unsanitised.

## E. New in revision 2

### OQ-29 (low, owner control) Lowering `approve_above` does not hold offers that are already open — OPEN [code]
Adversarial finding F4, still open after e0b990a (docs/ADVERSARIAL-FINDINGS.md). `proposerStillAuthorized`
(core.mjs:504) re-checks the proposer's hard limits at acceptance but ignores `needsOwner`, so an offer made under a
higher threshold is agreed without the owner even after the owner set `approve_above: 0`; owners cannot withdraw it
(owner tokens cannot sign).

### OQ-30 (medium, hardening) Any bearer header skips the unauthenticated read budget — OPEN [probe]
The per-IP read budget applies only to GETs **without** an `Authorization: Bearer` header (http.mjs:32), and the public
routes (`/info`, `/participants`, `/participants/{id}`, `/ledger`, http.mjs:54-66; join/enroll at 67-68) are served before authentication
(http.mjs:71), so neither the IP read budget nor a token budget applies to a public GET that carries any bearer value.
Reproduced with budgets set to 3: six public GETs without a header gave `200,200,200,429,429,429`; the same six with
`Authorization: Bearer x` all gave `200`. This leaves adversarial finding F2 (each public read reads the whole tracker)
open in practice. Suggest applying the IP read budget to every request that reaches a public route.

### OQ-31 (medium, operability) Signer failures look like bad signatures — OPEN [probe]
`safeVerify` (core.mjs:481-484) turns every exception of the Basis helper (timeout, failure to start, crash) into "does not
verify". Reproduced: a verifier that throws makes `propose` fail with `403 bad_signature: proposal signature does not
verify for a's registered key`. During a signer outage every act and every enrollment is refused as if the client's key
or signer were broken, which invites clients to regenerate keys or retry, and hides the outage from monitoring. Suggest
`safeVerify` return "does not verify" only for input the helper rejects as malformed, and a `503` for helper errors.

### OQ-32 (low) Reasons: bidi/zero-width kept, raw controls shown, non-string accepted — OPEN [vectors, probe]
- Reasons are not checked against the unsafe set; `clean()` replaces C0 controls but keeps bidi overrides and zero-width
  characters, so they reach the other party in `reason` (vectors `decline/bidi-inside`, `decline/zero-width-inside`).
- `reason_as_signed` (core.mjs:618, 847) stores and shows the raw text, including the C0 controls `clean()` removed from
  `reason` (an ANSI escape sequence, for example). Needed for re-verification, but a client that displays it shows raw
  control characters.
- A reason that is not a string is treated as `""` (core.mjs:612, 842): a decline signed over `sha256("")` with
  `"reason": 42` is accepted (vector `decline/non-string`) rather than refused as `invalid_field`.
- The message for a raw reason over 600 / 1100 characters says "longer than 500 / 1000 characters" (core.mjs:613, 843).

### OQ-33 (medium, interop/UX) The unsafe-character set has gaps and refuses legitimate text — OPEN [vectors]
core.mjs:66 is a fixed list of ranges.
- It refuses U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER, which ordinary text needs: every emoji ZWJ
  sequence (e.g. 👩‍💻) and Persian, Urdu and several Indic scripts written with ZWNJ are refused in service text and
  profile fields (`canonical.json` `refused/emoji-zwj-sequence`, `refused/persian-zwnj`; `terms-validation.json`
  `bad/zwj-emoji`, `bad/zwnj-persian`).
- It lets through other invisible or control characters: C1 controls U+0080–U+009F (e.g. U+0085), U+00AD SOFT HYPHEN,
  U+061C ARABIC LETTER MARK (a bidi mark), U+2060–U+2064 (word joiner, invisible operators), U+180E, variation
  selectors, and the tag characters U+E0000–U+E007F, which can carry hidden ASCII text to an LLM agent
  (`terms-validation.json` `ok/c1-nel`, `ok/word-joiner-arabic-mark-soft-hyphen`, `ok/tag-characters`).
- Suggest basing the rule on Unicode properties (general categories Cc and Cf, `Default_Ignorable_Code_Point`, with
  ZWJ/ZWNJ allowed between letters or emoji, as in UTS #39 / UAX #31), and documenting it as part of the protocol.

### OQ-34 (low) Display-name rule: gaps and status code — OPEN [probe]
core.mjs:155-157.
- It is refused with code `invalid_field` but HTTP status 409; every other `invalid_field` is 400.
- Reserved words are not checked as display names: `Valun` and `Valun Operator` are accepted.
- A new **handle** equal to an existing participant's display name is accepted (only display names are checked).
- Exact lowercase comparison only: confusables (e.g. Cyrillic `а` for Latin `a`) and spacing or punctuation variants
  pass.

## F. What was and was not verified (revision 2)

- Run: `generate.mjs` against release v8 (the real `canonical`, `termsHash`, `statements`, `Pilot` class and HTTP
  route table, in memory, fixed clock; all its assertions about accepted and refused inputs hold), and
  `check_python.py`: **615 checks: 536 agree, 0 disagreements in failing tiers, 19 informative differences, 60 not
  applicable** (exit status 0). The informative differences are OQ-2, OQ-3 and OQ-4 inputs, plus the non-string reason
  (OQ-32). A negative control (replaying the transcript with the pre-v8 rule, cleaned form only) makes the three
  reason replays fail again, so the replay check is not vacuous.
- Not run: the Rust `valun_signer`/basis_core, the real Basis tracker, the valun-app test suite, the hosted server.
