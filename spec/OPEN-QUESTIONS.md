# Open questions: `valun-deal/1` as implemented

Ambiguities, server/client inconsistencies, apparent bugs and security weaknesses found while writing `PROTOCOL.md`
and its vectors. Nothing here was changed in either implementation by this work.

**Revision 4 (2026-11-07), against server release v11 = valun-app commit `7880dcf`** (deployed; core.mjs sha256
`94b9fa35…f38514d5d`, http.mjs sha256 `7fcef5a3…4e1ba65f1`; `PROTOCOL.md` lists all five sources). Release v11
is valun-app's robustness pass on revision 3 (`docs/ROBUSTNESS-2026-11-07.md`); release v10 (`2ef0b16`) changed no
protocol rule. Resolved in v11, each with the residual issues this revision found stated in the item: OQ-6, OQ-7, OQ-12,
OQ-13, OQ-20, OQ-24, OQ-25, OQ-29 and OQ-35, the residuals of OQ-31 and OQ-32 named in revision 3, and most of OQ-33's;
OQ-8 is partly resolved. OQ-36 is new. `PROTOCOL.md` and the vectors describe v11.

Line numbers: items and paragraphs marked "revision 4" cite v11 (`7880dcf`); "revision 3" text and OQ-30 to OQ-35 cite
v9 (`ed1da4a`); the remaining text of OQ-1 to OQ-29 cites v8 (`e0b990a`). `PROTOCOL.md` cites v11 throughout.
`core.mjs` = `valun-app/lib/pilot/core.mjs`, `http.mjs` = `valun-app/lib/pilot/http.mjs`. Client references are to
`hermes-plugin-valun` at commit `f504d26` (0.2.0, the commit the Hermes plugin catalog pins; its `valun_client.py`,
`valun_basis.py` and `tools.py` are identical to those of `6040499`, checked in revision 3) and to the framework-neutral
`valun` package in this repository (`python/src/valun`), whose `client.py` and `basis.py` are the plugin's with a
package import (client-side items apply to both unless stated).

Revision history: revision 1 (2026-11-06, core.mjs `82212e52…6558`); revision 2 (2026-11-07, release v8 `e0b990a`,
core.mjs `cc779241…3d73`), which gave each item a status: **RESOLVED (commit)**, **CHANGED** (partly fixed, or the fix
changed the question), or **OPEN**, and added OQ-29 to OQ-34; revision 3 (2026-11-07, release v9 `ed1da4a`, core.mjs
`3a357106…cf1528008`), which added OQ-35.

How each item is known: **[vectors]** shown by `spec/vectors/check_python.py` or asserted by `generate.mjs` against the
real code; **[probe]** reproduced by running the real server code in memory; **[code]** from reading the code only.

Severity: **high** = a normal user action fails or a party can be misled; **medium** = wrong or surprising behaviour in
reachable cases; **low** = edge case, hardening or documentation.

## Summary

| # | Topic | Severity | Status |
|---|---|---|---|
| OQ-1 | Decline/dispute reason signatures | high | RESOLVED (e0b990a) |
| OQ-2 | Non-canonical numbers in terms | low | OPEN |
| OQ-3 | Lone surrogates accepted | low | OPEN (unchanged in v11) |
| OQ-4 | Canonical JSON outside the terms domain | low | OPEN (informative) |
| OQ-5 | `deliver_by` before offer expiry | medium | RESOLVED (e0b990a) |
| OQ-6 | Withdraw while an acceptance waits for its owner | medium | RESOLVED (7880dcf) |
| OQ-7 | Unswept expired offers count against mandates | medium | RESOLVED (7880dcf) |
| OQ-8 | Agreed/delivered deals never end | medium | CHANGED (7880dcf): agreed deals end (`expired_undelivered`); delivered deals still never end |
| OQ-9 | Non-object JSON body gives 502 | low | RESOLVED (e0b990a) |
| OQ-10 | Malformed keys/signatures give 502 | low | RESOLVED (e0b990a); its side effect OQ-31 RESOLVED (ed1da4a) |
| OQ-11 | Rate limiter | low→medium | CHANGED: bypass fixed (OQ-30); shared per-IP read budget covers authenticated reads too (unchanged in v11) |
| OQ-12 | Template timestamp can be in the future | low | RESOLVED (7880dcf) |
| OQ-13 | `mandate_version` bumps on empty PUT | low | RESOLVED (7880dcf) |
| OQ-14 | Invite parameters not validated | low | RESOLVED (e0b990a) |
| OQ-15 | Lenient time strings | medium | OPEN |
| OQ-16 | Service text hashed and shown raw | medium | CHANGED: mostly fixed; residual gaps in OQ-33 |
| OQ-17 | Token-denomination debt key not pinned | low | OPEN |
| OQ-18 | `/info` statements are JS source | low | OPEN |
| OQ-19 | Defaults that block silently | low | OPEN |
| OQ-20 | Owner-recorded "agent limits" | low | RESOLVED (7880dcf) |
| OQ-21 | Keys are trusted from the server | medium | OPEN |
| OQ-22 | Signed notes that were never issued stay on the server | medium | OPEN |
| OQ-23 | Python clients' issued-notes record gets ahead of the tracker | medium | OPEN (both clients) |
| OQ-24 | Owner tokens cannot be rotated | low | RESOLVED (7880dcf); residual: a holder of a stolen token can rotate it first |
| OQ-25 | Deal-id existence oracle | low | RESOLVED (7880dcf) |
| OQ-26 | Coverage can be manufactured | low | OPEN (adversarial F3, open by design) |
| OQ-27 | Public metadata | low | CHANGED: profile text filtered; metadata unchanged |
| OQ-28 | Python clients' checks they do not make | low | OPEN (both clients) |
| OQ-29 | Lowering `approve_above` does not hold open offers | low | RESOLVED (7880dcf; adversarial F4) |
| OQ-30 | Any bearer header skips the unauthenticated read budget | medium | RESOLVED (ed1da4a); residual: agents behind one address share the read budget (OQ-11) |
| OQ-31 | Signer failures look like bad signatures | medium | RESOLVED (ed1da4a; residual resolved 7880dcf); left: `verified_by_valun: true` when the re-check was skipped; split by message text |
| OQ-32 | Reasons: bidi/zero-width kept, raw controls shown, non-string accepted | low | RESOLVED (ed1da4a; residual resolved 7880dcf) |
| OQ-33 | Unsafe-character set: gaps and over-refusal | medium | RESOLVED (ed1da4a, 7880dcf) for the reported characters; residual: a 4-bit channel per emoji character, a few other invisible characters |
| OQ-34 | Display-name rule: gaps and status code | low | RESOLVED (ed1da4a); residual (unchanged in v11): reserved words only as whole names, no NFKC, names without letters or digits, confusables |
| OQ-35 | Every 502 says "internal error": `BasisError` has no `name` | low | RESOLVED (7880dcf) |
| OQ-36 | The plugin tells an acceptor its own owner holds an acceptance the proposer's owner holds | low | OPEN (new in revision 4; plugin only) |

Resolved: OQ-1, 5, 9, 10, 14 (v8), OQ-30 to 34 (v9, with residuals) and OQ-6, 7, 12, 13, 20, 24, 25, 29, 35 (v11).
Partly fixed: OQ-8, 11, 16, 27. Still open: OQ-2, 3, 4, 15, 17, 18, 19, 21, 22, 23, 26, 28, and the new OQ-36.

## A. Server and Python clients

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
Revision 3 (v9): still resolved, for both Python clients. `generate.mjs` asserts both forms for every reason v9 accepts
(20 decline and 23 dispute reasons of 46 each; v9 refuses the others before the signature check, OQ-32), and
`check_python.py` now runs each client's real `Client.decline` / `Client.dispute` for every reason (not a rebuild of
what it would sign) and replays flows B, C, C2, E, F, H and I, plus the `valun_respond` path (plugin tools.py, package
agent.py) for flows C and I.

### OQ-2 (low, interop) Non-canonical numbers in terms — OPEN [vectors]
The server accepts integer fields written as `2e1` or `1.0` and hashes the parsed integer (`canonical.json` tier
`wire`); the Python `canonical()` refuses floats (valun_client.py:45-47). A safe refusal that does not arise with
server-produced JSON. Should the server refuse non-integer number forms in terms?

### OQ-3 (low, interop/hardening) Lone surrogates are accepted — OPEN [vectors, probe]
Unpaired surrogates are still accepted in service text, reasons and content: neither the v8 set nor the v9 set
(v9 core.mjs:69, a `u`-flag regular expression, which matches code points, so a lone surrogate matches nothing)
includes U+D800–U+DFFF. Node escapes them in `canonical()` and hashes them as U+FFFD; both Python clients raise
`UnicodeEncodeError` (safe), strict UTF-8 libraries cannot represent them. v9 vectors: `decline/lone-surrogate`,
`dispute/lone-surrogate` (accepted), `deliver/lone-surrogate`, `generic/lone-surrogate`.
Revision 4 (v11): unchanged; the v11 test (`hasUnsafeText`, core.mjs:81-83) still matches code points, so a lone
surrogate is accepted (probe; `decline/lone-surrogate`, `dispute/lone-surrogate` still accepted).

### OQ-4 (low, informative) Canonical JSON outside the terms domain — OPEN [vectors]
Integers above 2^53, `1e21`, fractions and non-BMP key order differ between Python and the server (valun_client.py:42
vs core.mjs:24). Harmless while the terms key set is fixed and ASCII.

## B. Server behaviour

### OQ-5 (medium, bug) `deliver_by` earlier than `offer_expires_at` — RESOLVED (e0b990a) [vectors]
core.mjs:474-475 now refuses it with `invalid_terms` ("deliver_by must not be earlier than offer_expires_at");
`terms-validation.json` `bad/deliver-by-before-offer-expiry`, `ok/deliver-by-equals-offer-expiry`; transcript step
"deliver_by earlier than offer_expires_at".

### OQ-6 (medium) Withdraw while the acceptor's acceptance waits for its owner — RESOLVED (7880dcf) [vectors]
`withdraw` (core.mjs:627-635) still succeeds during `accepted_awaiting_owner`: the deal becomes `withdrawn` and the
approval `void_withdrawn`, but `acceptance.state` stays `awaiting_owner`, and the proposer's `next_actions` is
`["wait_for_owner_approval"]` (core.mjs:872). The adversarial report calls the behaviour consistent with "not agreed
until approved"; PROTOCOL.md now documents it as allowed. Remaining: mark the acceptance (e.g. `cancelled`) and list
`withdraw` in `next_actions`, or forbid it.
Revision 4 (v11): withdrawing is still allowed; the waiting acceptance becomes `void_withdrawn` (with `voided_at`), its
pending approvals `void_withdrawn`, the `withdrawn` event carries `acceptance_voided: true`, and the proposer's
`next_actions` is `["wait_for_owner_approval", "withdraw"]` (core.mjs:739-758, 1026). `transcript.json` flow K
(alice's acceptance above her `approve_above`, then bob withdraws; replayed through both clients).

### OQ-7 (medium, bug) Expired offers count against mandates until something reads them — RESOLVED (7880dcf) [code]
Expiry is lazy (`sweep`, core.mjs:422) but `exposure()` (core.mjs:358-368) counts `open`/`proposed_awaiting_owner` deals
without sweeping; a valid new offer can fail with `mandate_exceeded` because of an expired one nobody has looked at.
Positions and counts (core.mjs:340-352) also use unswept statuses.
Revision 4 (v11): `exposure()` sweeps each deal it counts and `position()` and `inbox()` sweep first (core.mjs:382-416,
1147), so offers, held counters and held acceptances past `offer_expires_at` no longer count. Not shown by the
vectors (valun-app `test/robustness.test.mjs` "OQ-7" covers it).

### OQ-8 (medium, spec gap) Agreed and delivered deals never end — CHANGED (7880dcf): agreed deals end; delivered deals do not [vectors]
No timeout or cancel for `agreed` (payee never delivers) or `delivered` (payer never reviews). They stay in
`committed` (core.mjs:362) forever. A payer still cannot dispute after `note_failed` (core.mjs:840).
Revision 4 (v11): an `agreed` deal not delivered 7 days after `deliver_by` becomes `expired_undelivered` (terminal,
event `expired_undelivered` by `valun`; core.mjs:18, 470-500), releases its exposure, and a later delivery is
`409 wrong_state`; views show `delivery_grace_ends_at`. `transcript.json` flow M (the clock moves past the grace
period; the refused delivery is replayed through both clients, which raise `wrong_state`).
Residual (by design in v11): a `delivered` deal the payer never reviews still never ends and holds both parties'
exposure, and a payer still cannot dispute after `note_failed` (dispute needs `delivered`, core.mjs:991).

### OQ-9 (low, bug) Non-object JSON body gives 502 — RESOLVED (e0b990a) [vectors]
http.mjs:21 refuses `null`, arrays, strings and numbers with `400 bad_json`; transcript step "a JSON body that is not an
object".

### OQ-10 (low, bug) Malformed keys and signatures give 502 — RESOLVED (e0b990a); see OQ-31 [vectors]
Keys and signatures must be hex strings (core.mjs:63, 186-193); every verification goes through `safeVerify`
(core.mjs:481-484), so malformed or unverifiable input is `403 bad_signature` / `400 invalid_field`, never 502.
Uppercase hex is now refused for the note signature too. Transcript steps "a signature that is not a hex string" and
"a public key that is not a hex string". Side effect: OQ-31, resolved in v9 (signer outages are `503`; since v9 a
signature must also start with `02` or `03`, v9 core.mjs:64).

### OQ-11 (medium, docs/hardening) Rate limiter — CHANGED [code, probe]
Fixed: separate per-token read and write budgets (http.mjs:74; reads default to 4 × the write budget,
`pilotReadLimitPerMinute`), a per-IP budget for unauthenticated GETs (http.mjs:32), pruning of idle keys (http.mjs:10).
Still open: refused requests are recorded too (http.mjs:9), so an immediate retry stays limited; the per-IP budgets are
shared behind NAT, and a self-hosted server behind a proxy without `VALUN_TRUST_FLY_CLIENT_IP=1` gives every client one
budget (lib/http.mjs:32). Revision 2's gap OQ-30 is resolved in v9 by applying the per-IP read budget to **every** GET
(v9 http.mjs:34), which makes the sharing wider: authenticated agents behind one address now share one read budget too
(`pilotIpReadLimitPerMinute`, default = the per-token read budget, 360 per minute). The `probes` vector
`rate-limit/two-agents-one-address` shows two agents, each well within its own token budget, getting `429` on the
fourth read from one address (budgets set to 3). For the hosted pilot that is 360 reads per minute per address for all
agents behind it; an operator with many agents behind one NAT must raise it.
Revision 4 (v11): unchanged (http.mjs:5-13, 31-34, 76; probes in `transcript.json` give the same statuses).

### OQ-12 (low, robustness) Template timestamp can be in the future — RESOLVED (7880dcf) [vectors]
core.mjs:763 (`max(now - 1500, last + 1)`) vs core.mjs:781 (`timestamp <= now`): if the pair's last note has a future
timestamp (only possible for a note submitted around Valun), completion fails until the clock passes it.
Revision 4 (v11): the template's timestamp is never after the server's clock (core.mjs:896-914): if the pair's last
note is ahead, the template waits up to 3 s, and further ahead it is `409 note_timestamp_ahead` with
`retry_after_ms` and `last_note_timestamp`; the template inside a `stale_note` error never waits. `transcript.json`
flow L: a note 60 s ahead of the clock on the stand-in tracker gives `409` with `retry_after_ms: 60001`; after the
clock passes it, completion succeeds. Residual (low, [code]): within 3 s the request is held open while the server
waits (not inside the deal lock); reachable only for a pair whose payer submitted a note around Valun.

### OQ-13 (low) `mandate_version` increments on every PUT, even an empty one — RESOLVED (7880dcf) [vectors]
core.mjs:265.
Revision 4 (v11): only a real change makes a new `mandate_version` (core.mjs:282-312); a no-op PUT returns
`changed: false`. `transcript.json`: alice's owner PUTs values it already has (`changed: false`, version unchanged),
then lowers `approve_above` (`changed: true`).

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
Remaining: up to 100 characters of padding are still part of the signed text. The character set was revised in v9
(OQ-33: C1 controls, word joiner, invisible operators, interlinear annotation and tag characters refused; ZWJ/ZWNJ and
LRM/RLM allowed) and still has residual gaps (OQ-33). Length limits still count UTF-16 code units.

### OQ-17 (low) Token-denomination debt key not pinned by an official vector — OPEN
Basis's official vectors are `erg` only; the pilot uses `token:<id>`. The replica, the Python client
(valun_basis.py:175-180) and a local copy of Basis `types.rs` agree, but `valun_signer note-message` (basis.mjs:66-68),
the server's real code path, was not run. Run it once for `basis-notes.json` `pilot/first-note` and pin the output.

### OQ-18 (low) `/info` `statements` is JavaScript source text — OPEN
http.mjs:58. Suggest publishing templates and a version.

### OQ-19 (low, docs) Defaults that block silently — OPEN
`approve_above: 0` and a mandate that expires 14 days after joining (core.mjs:51, 165); after that every commitment fails
with `mandate_exceeded`, `rule: expires_at`.

### OQ-20 (low) Owner-recorded "agent limits" — RESOLVED (7880dcf) [vectors]
`PUT /limits` accepts the owner token (http.mjs:78); such limits are reported as `source: agent_limits`, "limit recorded
from the owner's instructions" (core.mjs:377).
Revision 4 (v11): `agent_limits_recorded_by` keeps who recorded each field (core.mjs:314-334); a refusal on an
owner-recorded value has `recorded_by: "owner"` and says "limit recorded by the owner (PUT /limits)"; `source` stays
`agent_limits`. `transcript.json` flow N (bob's owner records `max_accept_per_deal 40`; bob's acceptance of 45 is
refused with `recorded_by: owner`, replayed through both clients). Either token can still clear such a limit.

## D. Security and trust

### OQ-21 (medium, security) Keys are trusted from the server — OPEN [code]
The directory comes from the same server; a dishonest server can substitute keys consistently, and the Python client
signs credit notes to the payee's current directory key (valun_client.py:316-320), so a claimed rotation can redirect a
note. Suggest key pinning and independent confirmation when the note recipient differs from the agreed payee key.

### OQ-22 (medium, security) Signed notes that were never issued stay on the server — OPEN [code]
Rejected, voided and stale payer-signed notes are kept with their signatures (core.mjs:235, 661, 674); any holder could
submit them to the tracker while the pair's state allows. Withholding relies on the server (`noteView`, core.mjs:899).

### OQ-23 (medium, client bug) Python clients' issued-notes record gets ahead of the tracker — OPEN [code]
valun_client.py:337-338 (package: client.py:334-335) records the total on `completion_awaiting_owner`; if the owner
rejects or the note goes stale, later completions to that payee key fail with `ledger_mismatch` (valun_client.py:324-326;
package client.py:321-323). A 502 during submission has the opposite effect. Same code in both clients.

### OQ-24 (low, security) Owner tokens cannot be rotated or revoked — RESOLVED (7880dcf) [vectors]
No route (core.mjs:158, 208).
Revision 4 (v11): `POST /owner/rotate-token` (owner token) returns a new owner token once; the old one is `401` at
once; the agent is not affected; `GET /owner` shows `owner_token_rotated_at` (core.mjs:272-281, http.mjs:121).
`transcript.json`: carol's owner rotates; the old token `401`, the new one `200`.
Residual (low, [code]): rotation needs the current token, so whoever holds a stolen owner token can rotate it first
and lock the real owner out; there is still no route for the operator to issue a new owner token (it can issue
enrollment codes and change mandates only), and no revocation without the token.

### OQ-25 (low, security) Deal-id existence oracle — RESOLVED (7880dcf) [vectors]
`duplicate` (core.mjs:530) is still checked before the signature (core.mjs:533).
Revision 4 (v11): `propose` verifies the signature before looking up the deal id (core.mjs:637-657). `transcript.json`:
a reused deal id with a bad signature is `403 bad_signature` with the same message as for an unused id (step
"signature by another key"); correctly signed, it is still `409 duplicate`.

### OQ-26 (low, honest label) Coverage can be manufactured — OPEN (adversarial F3)
core.mjs:399-405 counts every note a payer holds, including circular or colluding credit.

### OQ-27 (low) Public metadata — CHANGED
Public profile text is now filtered (OQ-16). Unchanged: the directory lists every participant with operator names,
`agent_last_seen` is public, position counts include deals waiting for the participant's own owner (core.mjs:344), and
`last_seen_agent` is persisted only at the next save (core.mjs:207).

### OQ-28 (low, client hardening) Python clients' checks they do not make — OPEN
`deliver` does not verify the agreement (valun_client.py:296-302; package client.py:293-299); `verify_offer` does not
check `deal_id`, `proposer`, the version chain, `price.unit` or `consideration` (valun_client.py:213-240; package
client.py:210-237); text from terms, reasons and deliveries is passed to the model unsanitised. New with v9 (both
clients): neither checks a reason against the refused-character set before signing (the server then refuses it with
`400 invalid_field`, a safe refusal, but the agent gets no earlier, clearer error), and neither treats
`503 signer_unavailable` as retryable (it surfaces as a `ValunError` with that code; transcript step "the signature
checker is unavailable" replays this for both).
Revision 4 (v11): unchanged in both clients (plugin `f504d26`, package `client.py`). Both surface the new v11 codes as
`ValunError` (`wrong_state`, `mandate_exceeded` with `recorded_by`, `signer_unavailable`; replayed). For the plugin's
text about held acceptances see OQ-36.

## E. New in revision 2 (OQ-30 to OQ-34 resolved in release v9, with residuals)

### OQ-29 (low, owner control) Lowering `approve_above` does not hold offers that are already open — RESOLVED (7880dcf) [vectors]
Adversarial finding F4, still open after e0b990a and ed1da4a (docs/ADVERSARIAL-FINDINGS.md). `proposerStillAuthorized`
(core.mjs:504) re-checks the proposer's hard limits at acceptance but ignores `needsOwner`, so an offer made under a
higher threshold is agreed without the owner even after the owner set `approve_above: 0`; owners cannot withdraw it
(owner tokens cannot sign).
Revision 4 (v11): at acceptance the proposer's mandate check now also decides `needs owner`: an offer its owner never
approved, priced above the owner's current `approve_above`, waits for that owner (approval kind `confirm_offer`,
event `held_for_proposer_owner`, `acceptance.held_for: ["proposer_owner"]`; core.mjs:577-624, 683-703, 761-856).
Approving forms the deal (after re-checking the acceptor's hard limits, `409 acceptance_not_authorized`); rejecting
withdraws the offer. `transcript.json` flow L: two offers within the old threshold, the owner lowers it, both
acceptances are held; one is confirmed (agreed), one rejected (withdrawn, acceptance `void_withdrawn`).
Residual (low, by design): an offer the owner approved when it was made is not held again, whatever the owner
changes later.

### OQ-30 (medium, hardening) Any bearer header skips the unauthenticated read budget — RESOLVED (ed1da4a) [vectors]
Was (v8): the per-IP read budget applied only to GETs **without** an `Authorization: Bearer` header, and the public
routes are served before authentication, so a public GET with any bearer value was not limited at all (six reads with
`Authorization: Bearer x` and budgets of 3 all gave `200`).
Now: every GET counts against the per-IP read budget, whatever header it carries (v9 http.mjs:6, 34;
`pilotIpReadLimitPerMinute`, default = the per-token read budget `pilotReadLimitPerMinute`, 360 per minute).
`transcript.json` `probes` (budgets set to 3): six public reads without a header and six with a made-up token both give
`200,200,200,429,429,429`.
Residual (low, see OQ-11): authenticated reads now count per address as well, so agents behind one address share one
read budget (probe `rate-limit/two-agents-one-address`: two agents, two reads each, the fourth is `429`). Adversarial
finding F2 (each public read reads the whole tracker) is now bounded by this budget, not removed.

### OQ-31 (medium, operability) Signer failures look like bad signatures — RESOLVED (ed1da4a; residual resolved 7880dcf) [vectors]
Was (v8): `safeVerify` turned every exception of the Basis helper (timeout, failure to start, crash) into "does not
verify", so a signer outage was `403 bad_signature`.
Now (v9 core.mjs:489-497): an error whose message starts with `signer: ` (the helper ran and printed an `error`, e.g.
"invalid public key", "invalid signature encoding") still means "does not verify"; any other failure is
`503 signer_unavailable`, "signature checking is temporarily unavailable; nothing was recorded; try again". Signatures
must also match `/^0[23][0-9a-f]{128}$/` (core.mjs:64), so an all-zero signature is refused before the helper runs.
`transcript.json`: "the signature checker is unavailable" (`503`, nothing recorded, replayed through both clients,
which raise `ValunError('signer_unavailable')`), "after the outage: the same signed offer sent again unchanged is
accepted", "the signer reports an error for the input" (`403`), "an all-zero signature is refused before the signer
runs" (`403`, no statement verified). The outage is emulated by a stand-in that throws the real `BasisError` class
with the runner's messages (lib/basis.mjs:22-30); the real runner and helper were not run.
Residual:
- (low) The credit-note message is built by the same helper outside `safeVerify` (`basis.noteMessage`, core.mjs:779,
  797), so during an outage `GET /deals/{id}/credit-note-template` and `POST /deals/{id}/complete` fail with
  `502 {"error": "internal error"}` instead of `503` (transcript step "during an outage the credit-note template is
  502"). The read-back `verified_by_valun` after a note is submitted (core.mjs:835) also calls the helper directly.
- (low) The split is by message text: every `error` the helper prints counts as "does not verify", including ones that
  are not about the client's input, such as its usage error (valun_signer.rs:85, printed if a helper without a
  `verify` command were deployed). Such a deployment fault would again look like bad signatures. [code]
- (cosmetic) A 65-byte hex signature with another prefix gets "… signature must be 65 bytes hex" (core.mjs:501).
Revision 4 (v11): the first residual is resolved: the note message goes through `Pilot.noteMessage`
(core.mjs:550-556), so the template and completion are `503 signer_unavailable` during an outage (`transcript.json`
step 92, now `503`), and a helper failure in the read-back re-check leaves the deal `note_issued` with
`reverify_skipped` (core.mjs:959-971). `BasisError` now has codes (OQ-35), and a `signer: …` refusal of a request
the server built is `502 signer_error` (`transcript.json` step "the signer refuses the note-message request").
Left:
- (low, [code]) With `reverify_skipped`, `verified_by_valun` is still `true`. Valun did verify that signature at
  completion, but a client that reads only `verified_by_valun` cannot tell that the read-back check did not run.
- (low, [code]) `safeVerify` (core.mjs:538-548) still decides by message text (`signer: …` = does not verify); the
  helper's usage error would still look like a bad signature. The new `code: signer_error` carries the same split.

### OQ-32 (low) Reasons: bidi/zero-width kept, raw controls shown, non-string accepted — RESOLVED (ed1da4a; residual resolved 7880dcf) [vectors]
Was (v8): reasons were only cleaned (bidi and zero-width characters kept; C0 controls kept in `reason_as_signed`), and
a non-string reason counted as `""`.
Now (v9 core.mjs:625-628, 857-860), before any signature is checked: a reason that is neither a string nor
`null`/absent is `400 invalid_field` "reason must be text"; a reason containing a refused character (the OQ-33 set) is
`400 invalid_field`. So `reason_as_signed` can no longer carry controls; it differs from `reason` only by leading and
trailing whitespace. `statements.json`: 26 decline and 23 dispute reasons are now tier `refused`, asserted to be
refused with the signer never asked (e.g. `decline/bidi-inside`, `decline/zero-width-inside`, `decline/escape-sequence`,
`decline/non-string`, `decline/non-string-array`, `decline/tag-characters`); `transcript.json` steps "a decline reason
with …"; flow I (a reason with an emoji ZWJ sequence, ZWNJ and LRM) is accepted and replayed through both clients.
Residual:
- (cosmetic) The message for a raw reason over 600 / 1100 characters still says "longer than 500 / 1000 characters"
  (core.mjs:627, 859).
- (low) Reasons may still contain the invisible characters the set allows (OQ-33 residual), e.g.
  `decline/soft-hyphen`, `decline/variation-selectors` are accepted.
Revision 4 (v11): the length messages state the limits enforced: "reason is longer than 600 characters, counting
leading and trailing whitespace (at most 500 without it)" (dispute 1100 / 1000; core.mjs:726, 995). Vectors
`decline/raw-over-600`, `dispute/raw-over-1100` record them. The invisible characters the v9 set allowed in reasons
(soft hyphen, ideographic variation selectors) are refused since v11 (`decline/soft-hyphen`,
`decline/variation-selectors` now tier `refused`).

### OQ-33 (medium, interop/UX) The unsafe-character set has gaps and refuses legitimate text — RESOLVED (ed1da4a, 7880dcf) for the reported characters [vectors, probe]
Was (v8): U+200C/U+200D (ZWNJ/ZWJ, needed by emoji sequences and Persian/Indic text) were refused; C1 controls,
U+2060–U+2064 and the tag characters were allowed.
Now (v9 core.mjs:69): refused = C0 controls other than TAB/LF/CR, U+007F–U+009F, U+200B, U+202A–U+202E,
U+2060–U+2064, U+2066–U+2069, U+FEFF, U+FFF9–U+FFFB, U+E0000–U+E007F; allowed on purpose: ZWNJ, ZWJ, LRM, RLM (and
ALM). The same set now applies to service text, profile fields and decline/dispute reasons. Vectors:
`canonical.json` `terms/emoji-zwj-sequence`, `terms/persian-zwnj`, `terms/unicode-allowed-invisible`,
`terms/emoji-modifiers-and-vs16`, `refused/c1-controls`, `refused/word-joiner-invisible-operators`,
`refused/interlinear-annotation`, `refused/tag-characters`; `terms-validation.json` `ok/zwj-emoji`, `ok/zwnj-persian`,
`ok/lrm-rlm`, `bad/c1-nel`, `bad/c1-csi`, `bad/word-joiner`, `bad/invisible-operators`, `bad/interlinear-annotation`,
`bad/tag-characters`.
Residual (the set is still a fixed list, not a Unicode property; the property-based rule suggested in revision 2 is
not adopted):
- (low) Invisible characters still accepted: U+00AD SOFT HYPHEN, U+3164 HANGUL FILLER (renders as blank space; also
  U+115F, U+1160, U+FFA0 [code]), U+180E, U+206A–U+206F, U+034F COMBINING GRAPHEME JOINER [code], and the variation
  selectors U+FE00–U+FE0F and U+E0100–U+E01EF. A run of variation selectors after any character is invisible and maps
  one-to-one onto bytes, so it can carry hidden data, as the tag characters could; decoding it needs a decoder rather
  than a model reading it directly. Vectors: `terms-validation.json` `ok/arabic-mark-soft-hyphen`,
  `ok/variation-selectors`, `ok/hangul-filler`.
- (low, over-refusal) Emoji subdivision flags (England, Scotland, Wales) are tag sequences (U+1F3F4, tag characters,
  U+E007F), so they are refused with the tag characters (`canonical.json` `refused/subdivision-flag`,
  `terms-validation.json` `bad/subdivision-flag`, `statements.json` `decline/subdivision-flag`). Allowing exactly the
  RGI flag tag sequences would fix it.
- (low) LRM/RLM/ALM are allowed. They cannot reorder strong text the way overrides can, but they can change the order in
  which neutral characters and numbers next to them are displayed.
- (cosmetic) The service-text message still says "control, bidi or zero-width characters" (core.mjs:73); the profile and
  reason messages say "invisible".
- Lone surrogates are still accepted (OQ-3).
Revision 4 (v11): also refused in signed text, profile fields and reasons: U+00AD, the Hangul fillers U+115F, U+1160,
U+3164, U+FFA0, U+E0100–U+E01EF, and a variation selector U+FE00–U+FE0F that does not directly follow a character
with the Unicode property `Emoji` (core.mjs:81-83). The three RGI subdivision flags are allowed; any other tag
sequence stays refused. Vectors: `canonical.json` `terms/subdivision-flags`, `terms/emoji-modifiers-and-vs16`,
`refused/soft-hyphen`, `refused/hangul-fillers`, `refused/ideographic-variation-selectors`,
`refused/stray-variation-selectors`, `refused/other-tag-flag`; `terms-validation.json` `ok/subdivision-flags`,
`ok/emoji-presentation`, `bad/soft-hyphen`, `bad/hangul-filler-*`, `bad/ideographic-variation-selectors`,
`bad/stray-variation-selector`, `bad/repeated-variation-selector`, `bad/other-tag-flag`.
Residual:
- (low) The `Emoji` property covers the digits 0–9, `#`, `*`, `©` and `®` as well as emoji, and the rule allows any
  of the 16 selectors after each, so text can still carry 4 invisible bits per digit or emoji (`1\uFE03 2\uFE0A` is
  accepted: `terms-validation.json` `ok/variation-selector-after-digit`, `canonical.json`
  `terms/variation-selector-after-digit`, `statements.json` `decline/variation-selector-after-digit`). Allowing only
  U+FE0F (and U+FE0E) after emoji characters, and none after digits outside a keycap sequence, would close it.
- (low, [probe]) Still accepted: U+180E, U+034F COMBINING GRAPHEME JOINER, U+206A–U+206F, the musical format
  characters U+1D173–U+1D17A. The list approach (rather than general category Cf / `Default_Ignorable_Code_Point`)
  remains.
- (cosmetic) The service-text message still says "control, bidi or zero-width characters" (core.mjs:87).
- LRM/RLM/ALM allowed (as in v9); lone surrogates accepted (OQ-3).

### OQ-34 (low) Display-name rule: gaps and status code — RESOLVED (ed1da4a) [vectors]
Was (v8): `409` with code `invalid_field`; reserved words not checked as display names; a handle could copy a display
name; exact lowercase comparison.
Now (v9 core.mjs:154-165): names are compared normalized, `norm(s)` = lower case with everything but `\p{L}` and `\p{N}`
removed; a handle that is or normalizes to a reserved word, or equals or normalizes to another participant's handle or
display name, is `409 handle_taken`; a display name that normalizes to a reserved word or to another participant's
handle or display name is `409 display_name_taken`. `transcript.json` release v9 join steps: `Valun`, `V.A.L.U.N`,
`BOB spec-test`, `Al-ice` refused as display names; `alice-spec-test` and `ad-min` refused as handles.
Residual (all accepted with `201` in `transcript.json`):
- (low) A reserved word counts only as the whole normalized name: `Valun Support` (and, by the same rule, `Valun
  Operator`) is accepted.
- (low) No Unicode normalization before `norm`: fullwidth `Ｖａｌｕｎ` is accepted, and because `norm` drops combining
  marks, `José Briefs` written with U+00E9 and with e + U+0301 (identical on screen) are both accepted, while the
  decomposed one collides with a plain `Jose Briefs`. Suggest NFKC (and case folding) before removing non-letters.
- (low) A display name with no letters or digits normalizes to `""` and is never compared: two participants can both be
  `🙂🙂`.
- (low) Confusables are not checked: `Bоb (spec test)` with CYRILLIC SMALL LETTER O is accepted next to bob's
  `Bob (spec test)` (UTS #39 skeletons would catch it).
Revision 4 (v11): the name rules are unchanged (core.mjs:166-179); the residuals above hold, and the `transcript.json`
steps that pin them (`Valun Support`, fullwidth `Ｖａｌｕｎ`, NFC/NFD `José Briefs`, `🙂🙂` twice, Cyrillic `о`)
are still accepted.

## F. New in revision 3

### OQ-35 (low, operability/docs) Every 502 says "internal error": `BasisError` has no `name` — RESOLVED (7880dcf) [vectors]
lib/http.mjs:100 answers an unexpected error with `502 {"error": e.name === 'BasisError' ? e.message : 'internal
error'}`, but `class BasisError extends Error` (lib/basis.mjs:7-9) never sets `name`, so `e.name` is `"Error"` and the
Basis error's text (e.g. "tracker unreachable: ECONNREFUSED", "signer timed out") is never shown: every tracker or
signer-runner failure is `502 {"error": "internal error"}`, indistinguishable from a server bug (the text is only
logged). Shown by instantiating the real class (`new BasisError('x').name === 'Error'`) and by `transcript.json` step
"during an outage the credit-note template is 502 internal error". Unchanged since v8 (lib/http.mjs and lib/basis.mjs
are the same in both releases); revision 2 and `PROTOCOL.md` for v8 described the intended `502 {"error": <text>}`,
which was wrong. Fix: `this.name = 'BasisError'` in the constructor (or an `instanceof` test), or map known tracker and
signer failures to explicit codes such as `502 tracker_unavailable` and `503 signer_unavailable`.
Revision 4 (v11): `BasisError` sets `name` and a `code` (`signer_unavailable`, `signer_error`,
`tracker_unavailable`) with a fixed `publicMessage` (lib/basis.mjs:11-21); lib/http.mjs:102-106 answers
`503 signer_unavailable`, `502 tracker_unavailable` or `502 signer_error` with `{error: code, message}` on pilot
routes; details stay in the log. `transcript.json`: the tracker unreachable (`502 tracker_unavailable`), a signer
outage at the template (`503`), the signer refusing a note-message request (`502 signer_error`).

## G. New in revision 4

### OQ-36 (low, client UX) The plugin tells an acceptor its own owner holds an acceptance the proposer's owner holds — OPEN [code]
Since v11 an acceptance can wait for the **proposer's** owner (`confirm_offer`, OQ-29), with the same status
`accepted_awaiting_owner`. The Hermes plugin at `f504d26` answers every `accepted_awaiting_owner` from `valun_respond`
with "You signed the acceptance; it becomes binding when your owner approves it." (tools.py:299), which is wrong for the
acceptor when only the proposer's owner holds it (`acceptance.held_for: ["proposer_owner"]`): the agent may wait for,
or tell its user about, an approval that its own owner was never asked for. The valun-app robustness notes name the
risk. The `valun` package's `agent.py:426` already says "when the owner holding it approves (yours, or the proposer's if
their limits require it; valun_deal shows which)", and its `valun_deal` passes the server's `acceptance` object, with
`held_for`, through (agent.py:327). Fix: say which owner holds it from `acceptance.held_for`. Not a protocol
disagreement (the signed bytes agree); `check_python.py` does not judge tool text.

## H. What was and was not verified (revision 4)

- Exported: valun-app commit `7880dcf` (release v11) with `git archive` into a scratch folder (the valun-app working
  tree was not read; the v9→v11 changes were read from `git diff ed1da4a 7880dcf` and the committed
  `docs/ROBUSTNESS-2026-11-07.md`). The generator checks the sha256 of core.mjs, pilot http.mjs, lib/basis.mjs and
  lib/http.mjs (whose error mapping it replicates) against v11's; every vector file says
  `server_release: "v11 (valun-app commit 7880dcf)"`.
- Run: `generate.mjs` against that export (the real `canonical`, `termsHash`, `statements`, `hasUnsafeText` through
  `validateTerms`/`decline`/`dispute`/`join`, `Pilot` class, HTTP route table and `BasisError` class, in memory, fixed
  clock, stand-in tracker and signer; every assertion about accepted and refused inputs holds; two runs give
  byte-identical files). The transcript's first 111 steps are the v9 run: compared with the v9 file they differ only by
  additive v11 fields (`changed`, `agent_limits_recorded_by`, `delivery_grace_ends_at`, `owner_token_rotated_at`,
  `recorded_by`) and by step 92 (the template during a signer outage, now `503`); steps 112 to 143 are new.
- `check_python.py` against both clients. Hermes plugin, fresh clone of github.com/fitzss/hermes-plugin-valun at
  `f504d2660727bf90ee1375e6b071acd5c6b63de5` (the commit CI pins): **747 checks: 607 agree, 0 disagreements in failing
  tiers, 17 informative differences, 123 not applicable** (exit status 0). `valun` package (`python/src` of the valun-open working tree,
  0.3.0.dev0; `client.py` and `basis.py` unchanged, `agent.py` at commit `93c7272` plus uncommitted changes by another
  engineer: fail-closed `is_commitment`, `bind()`, `review` refusing unknown decisions): the same, **747 checks: 607 agree, 0 disagreements in failing
  tiers, 17 informative differences, 123 not applicable** (exit status 0). The informative differences are the OQ-2,
  OQ-3 and OQ-4 inputs, as in revision 3. `check_python.py` reads `agent.py`/`tools.py` only to find the one
  `c.decline(` and `c.dispute(` call each (now agent.py:416 and 455); no change was needed for the new `agent.py`.
- Negative control: the scratch copy of the package with a `Client.decline` that signs `reason + " "` and a
  `valun_respond` that does not strip gives 29 disagreements against the v11 vectors (exit status 1).
- Also probed in memory against v11: the character test on U+180E, U+034F, U+206A–U+206F, U+1D173, a variation
  selector after a digit, `#` or `©`, lone surrogates (accepted), and a tag sequence without U+1F3F4 (refused).
- Not run: the Rust `valun_signer`/basis_core, the real signer runner, the real Basis tracker, the valun-app test suites
  (including `test/robustness.test.mjs`), the hosted server, any network except the one clone of the public plugin.
- Revision 3 (release v9, for comparison): 649 checks, 526 agree, 0 disagreements, 17 informative, 106 not applicable,
  for both clients.
