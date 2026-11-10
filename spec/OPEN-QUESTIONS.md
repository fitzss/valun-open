# Open questions: `valun-deal/1` as implemented

Ambiguities, server/client inconsistencies, apparent bugs and security weaknesses found while writing `PROTOCOL.md`
and its vectors, and, since revision 7, the owner decisions that release v16 (circulating credit) still needs. Nothing
here was changed in any implementation by this work.

**Revision 7 (2026-11-08), against server release v15 = valun-app commit `495624c`** (deployed; core.mjs sha256
`ad47e6ae…a6d45043`, pilot http.mjs `30658094…353fc213`; release v14 = `0317239` added self-serve sandbox joining, off
by default, and v15 turned it on with a server-wide daily cap: `PROTOCOL.md` Appendix G), **and the draft contract for
release v16** (circulating credit, valun-app branch `circulation-v16`, built locally, not released: `PROTOCOL.md`
section 18, 15.3, 16.1–16.2 and Appendix H, marked *draft until vectors are regenerated*). Revision 7 updates OQ-21,
OQ-22, OQ-23, OQ-26, OQ-28 and OQ-36, adds the owner decisions for release v16 (OQ-37 to OQ-47) and two items found
while writing its contract (OQ-48, OQ-49). The vectors still describe v13.

**Revision 8 (2026-11-09), against the release v16 implementation** (valun-app `cfe698b` on `circulation-v16`, built
locally, not released; the `valun` package 0.4.0 at valun-open `1509cbe`; the Hermes plugin 0.4.0 at `e2c7640`, local;
tracker v3.1, Valun fork `24675ec`) **and vectors regenerated from it** (`spec/vectors`, *draft until vectors are
regenerated* for the release commit). It folds what the implementation found into `PROTOCOL.md` (15.3, 16.1, 16.2,
17, 18.1-18.8, the new 18.16 and Appendix H), records the decisions D-1, D-2 and D-3 taken while building it, updates
OQ-22, OQ-23, OQ-40, OQ-48 and OQ-49, and adds OQ-50 to OQ-57 (section J).

**Revision 9 (2026-11-09), the final sync of the release v16 text.** Every statement of `PROTOCOL.md` on release v16
(section 18, 15.3, 16.1-16.2, Appendix H and the release v16 paragraphs of sections 1-17) was checked against the
regenerated vectors and against the final code: valun-app `cfe698b` (its successor `b88c1b3` adds a test only), the
`valun` package 0.4.0 (python/src last changed in valun-open `4310103`), `@fitzdoud/valun` 0.4.0 (`fc58e8d`) and the
Hermes plugin 0.4.0 (`2b78a06`, local, not pushed). The *draft until vectors are regenerated* marks are removed. The
corrections: the GET /consents example is now transcript step 171 (it was illustrative); the 18.3 worked example is a
vector (`circulation.json` `worked-example-18.3`); the transfer template's `from_edge` and `to_edge` carry `edge`, and
its `messages` map slot keys to message hexes; a stale transfer is regenerated only while the deal has had fewer than 3
transfer attempts in 24 hours, regenerations included (it said "regenerated at most 3 times"); a held `pay_by_transfer`
approval that is rejected, stale or voided by a revocation returns a deal that came from `payment_due` there (18.10,
18.11, as 18.16 already said), and `if_rejected` is quoted as the server words it; the tracker's `422` without a `code`
for an unknown or a missing field; `by: "payer"` and `"member"` in 18.13; the order of the roles in the capability
header is now part of the contract (18.1), because the conformance replay compares the header exactly; and 14.4 gives
the transcript's 236 requests (it still said 147). No vector changed.
Revision 9 adds OQ-58 (section J) and changes no other item's status: the headings and table cells that still said
"draft" now give the status revision 8 recorded, and OQ-23's row also names the JavaScript 0.4.0 client; paragraphs
headed "Revision 7" keep their "(draft)", which was the contract's status when they were written. CI now holds both
0.4.0 clients to the circulation vectors (OQ-52).

Line numbers: paragraphs marked "revision 7" cite v15 (`495624c`) and the clients named below; "revision 6"
paragraphs cite v13 (`6a6a34b`); "revision 5" paragraphs cite v12 (`a61c32e`); "revision 4" paragraphs cite v11
(`7880dcf`); "revision 3" text and OQ-30 to OQ-35 cite v9 (`ed1da4a`); the remaining text of OQ-1 to OQ-29 cites v8
(`e0b990a`).
`PROTOCOL.md` cites v13 in sections 1–17 and v15 in Appendix G. `core.mjs` = `valun-app/lib/pilot/core.mjs`,
`http.mjs` = `valun-app/lib/pilot/http.mjs`. Client references before revision 7 are to `hermes-plugin-valun` at commit
`f504d26` (0.2.0; its `valun_client.py`, `valun_basis.py` and `tools.py` are identical to those of `6040499`, checked
in revision 3) and to the framework-neutral `valun` package in this repository (`python/src/valun`), whose `client.py`
and `basis.py` are the plugin's with a package import (client-side items apply to both unless stated). Revision 7
paragraphs cite the `valun` package 0.3.1 (commit `c75cfb0`), the plugin 0.3.0 (`5d01fbd`, the commit the Hermes
plugin catalog entry pins, whose `valun_core/` is that package's code, byte-identical, so the same line numbers apply)
and the JavaScript package `@fitzdoud/valun` 0.3.1 (`js/src`).

Revision history: revision 1 (2026-11-06, core.mjs `82212e52…6558`); revision 2 (2026-11-07, release v8 `e0b990a`,
core.mjs `cc779241…3d73`), which gave each item a status: **RESOLVED (commit)**, **CHANGED** (partly fixed, or the fix
changed the question), or **OPEN**, and added OQ-29 to OQ-34; revision 3 (2026-11-07, release v9 `ed1da4a`, core.mjs
`3a357106…cf1528008`), which added OQ-35; revision 4 (2026-11-07, release v11 `7880dcf`, core.mjs `94b9fa35…f38514d5d`),
which resolved OQ-6, 7, 12, 13, 20, 24, 25, 29 and 35 and added OQ-36; revision 5 (2026-11-07, release v12 `a61c32e`,
core.mjs `0cf1bb6a…6778ef3ab27`), which resolved the OQ-24 residual and the OQ-33 residual of revision 4; revision 6
(2026-11-07, release v13 `6a6a34b`, core.mjs `7dc469e0…e0f240b2e`), which made OQ-33 a rule by Unicode property.

How each item is known: **[vectors]** shown by `spec/vectors/check_python.py` or asserted by `generate.mjs` against the
real code; **[probe]** reproduced by running the real server code in memory; **[code]** from reading the code only;
**[design]** (since revision 7) from the release v16 contract, before its code exists; **[impl]** (since revision 8)
from the release v16 implementation (its tests, or a run of its code in memory by `generate.mjs`).

Severity: **high** = a normal user action fails or a party can be misled; **medium** = wrong or surprising behaviour in
reachable cases; **low** = edge case, hardening or documentation; **decision** (since revision 7) = a choice the owner
has to make for release v16, not a defect.

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
| OQ-21 | Keys are trusted from the server | medium | OPEN; with v16 it covers transfer destinations too |
| OQ-22 | Signed notes that were never issued stay on the server | medium | CHANGED (decision D-1: another kind of payment waits; bound notes expire after 1 h); residual: a failed ordinary note never expires |
| OQ-23 | Python clients' issued-notes record gets ahead of the tracker | medium | OPEN in 0.3.1 (Python and JS clients); RESOLVED in the 0.4.0 clients (Python records checked by the v16 vectors; the JS `records.js` mirror by its own tests) |
| OQ-24 | Owner tokens cannot be rotated | low | RESOLVED (7880dcf; operator recovery a61c32e); left: recovery rests on the operator's out-of-band check |
| OQ-25 | Deal-id existence oracle | low | RESOLVED (7880dcf) |
| OQ-26 | Coverage can be manufactured | low | OPEN (adversarial F3, open by design); CHANGED with circulation on (v16): set-off removes circular coverage among clearing members |
| OQ-27 | Public metadata | low | CHANGED: profile text filtered; metadata unchanged |
| OQ-28 | Python clients' checks they do not make | low | OPEN (both clients, 0.3.1); partly addressed in 0.4.0 (v16) |
| OQ-29 | Lowering `approve_above` does not hold open offers | low | RESOLVED (7880dcf; adversarial F4) |
| OQ-30 | Any bearer header skips the unauthenticated read budget | medium | RESOLVED (ed1da4a); residual: agents behind one address share the read budget (OQ-11) |
| OQ-31 | Signer failures look like bad signatures | medium | RESOLVED (ed1da4a; residual resolved 7880dcf); left: `verified_by_valun: true` when the re-check was skipped; split by message text |
| OQ-32 | Reasons: bidi/zero-width kept, raw controls shown, non-string accepted | low | RESOLVED (ed1da4a; residual resolved 7880dcf) |
| OQ-33 | Unsafe-character set: gaps and over-refusal | medium→low | RESOLVED (6a6a34b): a rule by Unicode property, no Cc/Cf/default-ignorable code point passes outside its exceptions; left (low): the single marks between any two characters, blank-looking non-ignorable characters; trade-off: prepended concatenation marks refused |
| OQ-34 | Display-name rule: gaps and status code | low | RESOLVED (ed1da4a); residual (unchanged in v11): reserved words only as whole names, no NFKC, names without letters or digits, confusables |
| OQ-35 | Every 502 says "internal error": `BasisError` has no `name` | low | RESOLVED (7880dcf) |
| OQ-36 | The plugin tells an acceptor its own owner holds an acceptance the proposer's owner holds | low | RESOLVED (plugin 0.3.0, `5d01fbd`); the 0.2.x plugin unchanged |
| OQ-37 | Tracker v3: a Valun fork of the Basis tracker | decision | OPEN (owner decision) |
| OQ-38 | Release naming: server v16, spec v14, Appendix G | decision | OPEN (owner decision) |
| OQ-39 | Mandate defaults for the circulation fields | decision | OPEN (owner decision) |
| OQ-40 | Client consent defaults | decision | OPEN (owner decision) |
| OQ-41 | Console approval mode also turns on `review_deliveries` | decision | OPEN (owner decision) |
| OQ-42 | Payment timing constants | decision | OPEN (owner decision; needed before the tracker build) |
| OQ-43 | Partial payment by transfer refused | decision | OPEN (owner decision) |
| OQ-44 | Sandbox economy numbers | decision | OPEN (owner decision) |
| OQ-45 | Privacy of circulation data | decision | OPEN (owner decision) |
| OQ-46 | Edges under revoked keys stay frozen | decision | OPEN (owner decision) |
| OQ-47 | Phase-2 credit policies in 0.4 or 0.4.1 | decision | OPEN (owner decision) |
| OQ-48 | Outcome reports: a server that hides an applied payment can obtain a second one | medium | CHANGED (decisions D-1, D-2: one live attempt per deal, the owner's resolution); residual: read-backs come from the server |
| OQ-49 | `/info` `description` still says "no clearing" with circulation on | low | RESOLVED (v16 `cfe698b`) |
| OQ-50 | Bounding `deliver_by` on sandbox purchases | decision | OPEN (owner decision, new in revision 8) |
| OQ-51 | A v15 rollback turns a payment by transfer into a credit-note record | decision | OPEN (owner decision, new in revision 8) |
| OQ-52 | The 0.4.0 clients declare no `PROTOCOL_FEATURES` | low | OPEN (new in revision 8) |
| OQ-53 | An adapter's own how-to-change hint | low | OPEN (new in revision 8) |
| OQ-54 | `valun config consents.max_PC` accepts non-ASCII digits | low | OPEN (new in revision 8) |
| OQ-55 | `GET /clearing` `cleared_PC` is gross | low | OPEN (new in revision 8) |
| OQ-56 | Two things a client cannot read: `retry_after_ms` on 429, clearing holds of an unpaid deal | low | OPEN (new in revision 8) |
| OQ-57 | The vectors show no request after the empty roles header was taken | low | OPEN (new in revision 8) |
| OQ-58 | The replay checks the capability header of the step's own request only | low | OPEN (new in revision 9) |

Resolved: OQ-1, 5, 9, 10, 14 (v8), OQ-30 to 34 (v9, with residuals), OQ-6, 7, 12, 13, 20, 24, 25, 29, 35 (v11), the
OQ-24 and OQ-33 residuals named in revision 4 (v12), OQ-33's list approach (v13: a rule by property), and OQ-36 in the
plugin 0.3.0. Partly fixed: OQ-8, 11, 16, 27. Still open: OQ-2, 3, 4, 15, 17, 18, 19, 21, 22, 23, 26, 28 (for the v16
contract, OQ-23 had a specified fix and OQ-26, OQ-28 are partly addressed), the owner decisions OQ-37 to 47 and the new
OQ-48 and OQ-49. Revision 8: OQ-22 and OQ-48 CHANGED by decisions D-1 and D-2, OQ-23 resolved in the 0.4.0 clients,
OQ-49 resolved in v16; new: the owner decisions OQ-50 and OQ-51, and OQ-52 to OQ-57. Revision 9: new OQ-58.

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

### OQ-21 (medium, security) Keys are trusted from the server — OPEN [code, design]
The directory comes from the same server; a dishonest server can substitute keys consistently, and the Python client
signs credit notes to the payee's current directory key (valun_client.py:316-320), so a claimed rotation can redirect a
note. Suggest key pinning and independent confirmation when the note recipient differs from the agreed payee key.
Revision 7: unchanged in the 0.3.1 clients (package `client.py:322-324`, the plugin 0.3.0 the same file; JavaScript
`js/src/client.js:512-513`). With release v16 (draft) the same trust extends to payments by transfer: the payer's client
binds the destination to the payee's current directory key (`PROTOCOL.md` 15.3 R7, `wrong_destination`), so a server
that substitutes the payee's key consistently can redirect a transfer as it can a note. The 0.4.0 clients add a check
of the payee's delivery signature (`PROTOCOL.md` 15.2), which does not close this (a substituted key can sign a
delivery too), and they pin only `tracker_nft_id` and `denomination` (R13). The suggestion stands, for transfer
destinations as for note recipients.

### OQ-22 (medium, security) Signed notes that were never issued stay on the server — OPEN [code, design]
Rejected, voided and stale payer-signed notes are kept with their signatures (core.mjs:235, 661, 674); any holder could
submit them to the tracker while the pair's state allows. Withholding relies on the server (`noteView`, core.mjs:899).
Revision 7: unchanged in v14 and v15. Release v16 (draft) purges the signatures of novations that end without
applying, and the tracker refuses novation signatures older than one hour (`PROTOCOL.md` 18.8, 18.12), but held,
voided and failed credit notes keep their signatures as before, and notes have no maximum age. This matters more in v16
because a payer whose own note failed may then pay the same deal by transfer (`PROTOCOL.md` 18.10). The failed note
(on B→C) and the transfer (on A→B and A→C) change different edges, so if the failed note can still apply (B→C's
tracker timestamp is still earlier than the note's), whoever holds it could submit it after the transfer applied, and
the payer would pay twice. A retry with an own note is safe, because two notes for one deal built on the same prior
carry the same cumulative total. Suggest: the server refuses, and a client does not sign, a payment by transfer for a
`note_failed` deal while its failed note could still apply; and purge failed notes' signatures as v16 purges
unapplied novations'.

**Revision 8: CHANGED (decision D-1) [vectors, impl].** One live payment attempt per deal, across kinds: after a
failed bound note the server refuses a transfer until the note's timestamp + 1 h + 60 s; a failed ordinary note that can
still apply makes it refuse with `409 attempt_outcome_unknown`, and one shown applied with `409 already_paid`; the client
applies the same rule itself (`PROTOCOL.md` 15.3 R11, 16.2 item 8). Bound notes now expire after one hour at the
tracker (v3.1). What remains open: the server still holds a failed ordinary note's signature (it never expires), so a
server that submits it later, while the pair's state is older than it, can make it apply; the client never pays such a
deal again while that note may apply. Transcript flow W shows the cross-kind window; flow X the expiry.

### OQ-23 (medium, client bug) Python clients' issued-notes record gets ahead of the tracker — OPEN in 0.3.1; RESOLVED in the 0.4.0 clients [code, design]
valun_client.py:337-338 (package: client.py:334-335) records the total on `completion_awaiting_owner`; if the owner
rejects or the note goes stale, later completions to that payee key fail with `ledger_mismatch` (valun_client.py:324-326;
package client.py:321-323). A 502 during submission has the opposite effect. Same code in both clients.
Revision 7: still present in the package 0.3.1 (`client.py:341-343` records the total on `completion_awaiting_owner` and
`issuing_note`; `328-330` refuses with `ledger_mismatch`), in the plugin 0.3.0 (the same file) and in the JavaScript
package 0.3.1 (`js/src/client.js:542-544`, `521-523`). The v16 contract specifies the fix for the 0.4.0 clients
(draft): a per-pair record `{confirmed, pending[]}` in which a pending entry is promoted only when a recorded outcome
or `GET /edges` shows it applied, so an owner's rejection or a `void_stale` no longer corrupts it; a self-authenticating
`prior_note` (`?prior=1`, `PROTOCOL.md` 9.2 and 15.2), accepted when it is the client's own signature and not older than
its confirmed record, on any tracker; and bound notes (18.5), with which the tracker enforces the prior, so the record
no longer decides value. One protection of the old record must be kept: today a hidden applied note makes the next
completion fail with `ledger_mismatch`; a 0.4 client must treat its own pending note appearing as a prior as applied
and not pay that deal again (`PROTOCOL.md` 15.3, notes; OQ-48). A 0.3 client never signs a novation, so no transfer or
set-off ever touches its edges (I-03SAFE) and the record's meaning does not change for it.

**Revision 8: RESOLVED in 0.4.0 [vectors, impl].** The 0.4 clients keep `records {pair: {confirmed, pending}}` and
promote a pending entry only on a recorded outcome or a read-back (`PROTOCOL.md` 18.16, Clients); the transcript's
replays check the records each v16 client call leaves (`client_state_after`), including a bound note after a novation
lowered the edge (flow U: no `ledger_mismatch`). The 0.3 clients are unchanged.

### OQ-24 (low, security) Owner tokens cannot be rotated or revoked — RESOLVED (7880dcf; operator recovery a61c32e) [vectors]
No route (core.mjs:158, 208).
Revision 4 (v11): `POST /owner/rotate-token` (owner token) returns a new owner token once; the old one is `401` at
once; the agent is not affected; `GET /owner` shows `owner_token_rotated_at` (core.mjs:272-281, http.mjs:121).
`transcript.json`: carol's owner rotates; the old token `401`, the new one `200`.
Residual (low, [code]): rotation needs the current token, so whoever holds a stolen owner token can rotate it first
and lock the real owner out; there is still no route for the operator to issue a new owner token (it can issue
enrollment codes and change mandates only), and no revocation without the token.
Revision 5 (v12): the residual is resolved. The operator can issue a new owner token for a participant whose
token was lost or stolen: `POST /admin/participants/{id}/owner-token` (loopback and admin token only, like every
admin route; http.mjs:46-47), which runs the same rotation with `by: operator` (core.mjs:275-285): the new token is
returned once, the previous one (also one a thief rotated to) is `401` at once, the agent is not affected,
`GET /owner` shows `owner_token_rotated_by: "operator"` (http.mjs:112), audit `owner_token.reset_by_operator`.
`transcript.json` release v12 steps: the operator resets carol's token; the token carol's owner rotated to earlier
is `401`; the new one shows `owner_token_rotated_by: operator`; the route without loopback and admin token is `404`.
Left (low, process): the recovery is only as good as the operator's out-of-band check that the request comes from
the owner; the protocol has no identity of its own for owners. Nothing tells the holder of the replaced token why it
stopped working (`401` only).

### OQ-25 (low, security) Deal-id existence oracle — RESOLVED (7880dcf) [vectors]
`duplicate` (core.mjs:530) is still checked before the signature (core.mjs:533).
Revision 4 (v11): `propose` verifies the signature before looking up the deal id (core.mjs:637-657). `transcript.json`:
a reused deal id with a bad signature is `403 bad_signature` with the same message as for an unused id (step
"signature by another key"); correctly signed, it is still `409 duplicate`.

### OQ-26 (low, honest label) Coverage can be manufactured — OPEN (adversarial F3); CHANGED with circulation on (v16) [code, design]
core.mjs:399-405 counts every note a payer holds, including circular or colluding credit.
Revision 7: unchanged in v15. With circulation on (`PROTOCOL.md` 18, draft) the clearing engine cancels cycles of debts
by set-off among members that have `auto_clear` on and can sign: circular credit between such members, which raised
each one's coverage, disappears once the cycle is cleared, and `GET /clearing` publishes the gross total and the net
floor. It does not close the item: members that keep `auto_clear` off, refuse a set-off, or are not present keep their
circular claims, and a chain through a colluding party that does not close into a cycle is never cleared. For a payment
by transfer coverage is judged on the issuer whose note is received (18.13). The phase-2 `max_issuer_net_debt`
predicate counts claims on an issuer at no more than that issuer's own coverage (a one-level haircut, over reconciled
edges only), which limits manufactured coverage further; it may be cut from v16 (OQ-47).

### OQ-27 (low) Public metadata — CHANGED
Public profile text is now filtered (OQ-16). Unchanged: the directory lists every participant with operator names,
`agent_last_seen` is public, position counts include deals waiting for the participant's own owner (core.mjs:344), and
`last_seen_agent` is persisted only at the next save (core.mjs:207).

### OQ-28 (low, client hardening) Python clients' checks they do not make — OPEN (0.3.1); partly addressed in 0.4.0 [code, design]
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
Revision 7: unchanged in the package 0.3.1 and the plugin 0.3.0: `deliver` does not verify the agreement
(`client.py:300-306`); `verify_offer` (`217-244`) does not check `deal_id`, `proposer`, the version chain,
`price.unit` or `consideration`; neither checks a reason for refused characters before signing; neither retries
`503 signer_unavailable`. The JavaScript package 0.3.1 already makes the `verify_offer` checks
(`js/src/client.js:345-364`: deal id, proposer, version chain, unit, consideration, exact field sets) and verifies the
agreement before delivering (`484-488`). For the 0.4.0 clients the v16 contract (draft) adds: verification of the
payee's delivery signature before paying (`PROTOCOL.md` 15.2), the signing firewall for every circulation signature
(15.3), and approval prompts with the computed lines first and counterparty-written text quoted as one JSON line. The
0.3.1 Python gaps above remain as listed.

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

### OQ-33 (medium, interop/UX) The unsafe-character set has gaps and refuses legitimate text — RESOLVED (6a6a34b): rule by Unicode property; low residual OPEN [vectors, probe]
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
Revision 5 (v12): the revision 4 residual is resolved (core.mjs:81-86): U+FE00–U+FE0D are refused everywhere; after an
emoji only U+FE0E or U+FE0F may follow; after 0–9, `#` or `*` a selector is allowed only inside a keycap (followed by
U+20E3); U+180E, U+034F, U+206A–U+206F and U+1D173–U+1D17A are refused. Vectors: `bad/variation-selector-after-digit`
(was `ok/…` in v11), `bad/variation-selector-fe05-after-emoji`, `bad/digit-vs16-without-keycap`,
`bad/invisible-format-*`, `ok/keycaps-and-text-presentation`; `canonical.json` `refused/variation-selector-after-digit`,
`refused/variation-selector-fe00-fe0d-after-emoji`, `refused/digit-vs16-without-keycap`,
`refused/invisible-format-characters`, `terms/text-presentation-and-keycaps`; `statements.json`
`decline/variation-selector-after-digit` now refused, `decline/keycap` accepted.
Residual (medium: the same hidden-data channel the tag-character rule closed; [vectors, probe]):
- Default-ignorable characters outside the list are still accepted, also in runs after ordinary text: the Mongolian
  free variation selectors U+180B–U+180D and U+180F (four values per character), the Khmer inherent vowels U+17B4
  and U+17B5, the shorthand format controls U+1BCA0–U+1BCA3, and unassigned default-ignorable code points (U+2065,
  U+FFF0–U+FFF8, U+E0080–U+E00FF next to the tag block, U+E01F0–U+E0FFF), which render as nothing; a run of
  U+E0080–U+E00FF carries 7 bits per character. Also the Egyptian hieroglyph format controls from U+13430 (general
  category Cf). Vectors: `terms-validation.json` `ok/mongolian-free-variation-selectors`,
  `ok/unassigned-default-ignorables`; `canonical.json` `terms/mongolian-free-variation-selectors`,
  `terms/unassigned-default-ignorables`; `statements.json` `decline/mongolian-free-variation-selectors`.
- Suggest replacing the list by properties, as revision 2 did: refuse `\p{Default_Ignorable_Code_Point}` and
  `\p{Cf}` (both supported by ECMAScript regular expressions), except U+200C, U+200D, U+200E, U+200F, U+061C and
  U+FE0E/U+FE0F in the positions v12 allows (and, for `\p{Cf}`, the visible prepended concatenation marks such as
  U+0600–U+0605). Probed: every residual character above has one of the two properties.
- (low) Choosing U+FE0F, U+FE0E or nothing after an emoji is invisible for most emoji: a choice of three per emoji.
- (cosmetic) The service-text message still says "control, bidi or zero-width characters" (core.mjs:90).
- LRM/RLM/ALM allowed on purpose; lone surrogates accepted (OQ-3).
Revision 6 (v13): the list is replaced by the rule revision 5 suggested (core.mjs:84-113, `hasUnsafeText`; stated as
the normative definition in `PROTOCOL.md` 2.3): per code point, refuse every Cc (except TAB, LF, CR), Cf and
Default_Ignorable_Code_Point code point, except ZWNJ, ZWJ, LRM, RLM and ALM singly (never two in a row), U+FE0E/U+FE0F
directly after an emoji other than 0–9 `#` `*`, keycaps (0–9 `#` `*`, U+FE0F, U+20E3) and the three RGI subdivision
flags. A sweep of every code point between two letters (probe, Unicode 17.0) accepts exactly U+0009, U+000A, U+000D,
U+061C and U+200C–U+200F among Cc, Cf and default-ignorable code points, and refuses 3777 code points that v12
accepted and none that v12 refused. Vectors: everything revision 5 pinned as accepted is now refused
(`bad/mongolian-free-variation-selectors`, `bad/unassigned-default-ignorables`, `bad/format-or-ignorable-*`,
`refused/other-default-ignorables-and-format`; `decline/mongolian-free-variation-selectors` refused), plus
`bad/run-of-joiners`, `bad/run-of-direction-marks`, `bad/keycap-with-fe0e` (a keycap with U+FE0E, accepted in v12).
Trade-off (by design): the prepended concatenation marks are visible format characters (Cf) and are refused with the
rest: U+0600–U+0605 (Arabic number signs, which span the digits after them, e.g. in page or year numbers), U+06DD
ARABIC END OF AYAH, U+070F SYRIAC ABBREVIATION MARK, U+0890–U+0891, U+08E2, U+110BD and U+110CD (all probed refused).
Text that needs them cannot be signed (`refused/arabic-prepended-concatenation-mark`, `bad/format-or-ignorable-600`,
`decline/arabic-number-sign`); rare in deal text, and refusing them keeps the rule a plain property test.
Left (low; nothing Cc, Cf or default-ignorable passes outside the stated exceptions):
- The single marks are allowed between any two characters, not only where a script needs them: after every
  character of Latin text one of five invisible marks or none may follow, about 2.6 bits per character. A sentence
  with 10 such marks is accepted and looks the same (probe; `ok/single-marks-between-letters`,
  `terms/single-marks-between-letters`, `decline/single-marks-between-letters`). Likewise U+FE0F, U+FE0E or nothing
  after each emoji. Restricting ZWNJ/ZWJ to the contexts of UAX #31 (after a virama, between joining letters, inside
  emoji ZWJ sequences) and the direction marks to text with right-to-left characters would close most of it.
- Characters outside the three properties that render as blank space: U+2800 BRAILLE PATTERN BLANK and U+1D159
  MUSICAL SYMBOL NULL NOTEHEAD (category So; `ok/blank-looking-characters`), the space separators (U+00A0, U+1680,
  U+2000–U+200A, U+202F, U+205F, U+3000) and U+2028/U+2029. They take up width (they look like spaces, not like
  nothing), but a display name of U+2800 alone looks empty: two participants were both accepted as `⠀⠀` (probe; see
  OQ-34, whose `norm` removes them, so such names are never compared).
- Private-use code points (137,468; `ok/private-use`) and unassigned code points that are not default-ignorable
  (810,961 in Unicode 17.0, the 66 noncharacters among them) are accepted; whether they show depends on the fonts.
  Lone surrogates: OQ-3.
- Property membership depends on the Unicode version; a client with another version can disagree on code points whose
  properties changed between versions (`PROTOCOL.md` 2.3 names the server's: Unicode 17.0, Node.js 24.21.0).

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

### OQ-36 (low, client UX) The plugin tells an acceptor its own owner holds an acceptance the proposer's owner holds — RESOLVED (plugin 0.3.0, `5d01fbd`) [code]
Since v11 an acceptance can wait for the **proposer's** owner (`confirm_offer`, OQ-29), with the same status
`accepted_awaiting_owner`. The Hermes plugin at `f504d26` answers every `accepted_awaiting_owner` from `valun_respond`
with "You signed the acceptance; it becomes binding when your owner approves it." (tools.py:299), which is wrong for the
acceptor when only the proposer's owner holds it (`acceptance.held_for: ["proposer_owner"]`): the agent may wait for,
or tell its user about, an approval that its own owner was never asked for. The valun-app robustness notes name the
risk. The `valun` package's `agent.py:426` already says "when the owner holding it approves (yours, or the proposer's if
their limits require it; valun_deal shows which)", and its `valun_deal` passes the server's `acceptance` object, with
`held_for`, through (agent.py:327). Fix: say which owner holds it from `acceptance.held_for`. Not a protocol
disagreement (the signed bytes agree); `check_python.py` does not judge tool text.
Revision 7: resolved in the plugin 0.3.0. Since `48c71ff` the plugin is a thin adapter over the package's code: its
tools run `valun_core/agent.py` (`tools.py` calls `agent_for(ctx)`), whose `valun_respond` says "You signed the
acceptance; it becomes binding when the owner holding it approves (yours, or the proposer's if their limits require it;
valun_deal shows which)." (`valun_core/agent.py:426-427` at `5d01fbd`, the commit the catalog entry pins). The 0.2.x
line keeps the old text (`tools.py:299` at `f504d26` and at `94483e4`, 0.2.1).

## H. New in revision 7: owner decisions for release v16

Release v16 (circulating credit, `PROTOCOL.md` section 18) is built locally and not deployed. These are the choices it
leaves to the owner; each is OPEN until the owner decides. Deployment, publishing and workspace steps are owner
decisions too, but they are operations, not protocol questions, and are not listed here.

### OQ-37 (decision, trust) Tracker v3: a Valun fork of the Basis tracker — OPEN [design]
Circulating credit rests on tracker rules that upstream Basis does not have (`PROTOCOL.md` 18.2): seven-signature
transfers in which both creditors acknowledge the current totals; timestamp endings 995–999 ms reserved, one per
operation; bound notes and bound-only edges; a fixed one-hour limit on how long novation signatures stay valid;
`GET /capabilities`; a `pure_credit` mode. The design builds them as a fork ("v3", on Basis `a00233d`, branch
`circulating-credit-v3`), which Valun uses only when its capabilities match and its binary's sha256 is pinned. To
decide: whether to maintain that fork, and whether and when to offer the changes upstream
(BetterMoneyLabs/basis-tracker). Without it the effective mode stays `off`.

### OQ-38 (decision) Release naming: server v16, spec v14, Appendix G — OPEN [design]
Circulating credit ships as server release v16 with spec revision v14; Appendix G documents releases v14 and v15
(self-serve sandbox joining), which were deployed before the spec described them (`js/src/client.js:244` already calls
the join-sandbox release "v14+"). To confirm.

### OQ-39 (decision) Mandate defaults for the circulation fields — OPEN [design]
`PROTOCOL.md` 18.13: new invited participants get `auto_clear` and `novate_own_debt` on, `accept_transfers` off and an
empty `accept_notes_from`; participants who joined before get every new permission off until their owner opts in;
sandbox joiners get everything on, inside the sandbox limits. `accept_notes_from` is never derived from
`counterparties`. To confirm or change.

### OQ-40 (decision) Client consent defaults — OPEN [design]
(a) The background consent loop is on for sandbox profiles and opt-in for invited ones. (b) Automatic consent to being
paid by transfer (the new-creditor role) is opt-in for invited profiles. (c) The Hermes plugin's `process_consents`
defaults to false and becomes true after `hermes valun join --sandbox`. To confirm, keeping the Hermes catalog's
disclosure rules (12 and 13) in mind: automatic signing must be disclosed where the plugin is listed.

**Revision 8 (decision D-3 a).** An adapter without a background consent loop (the Hermes plugin; CLI runs that are not
loops) processes value-safe consents before the read-only `valun_status` and `valun_inbox` when its process_consents
setting is on, at most once per 60 s: set-offs and the new-creditor consents the owner's standing policy allows, never
an issuer consent or a payer action; the tool result lists them (`consents_signed_now`). With processing off, the
client declares no consent role and withdraws earlier ones (D-3 b: `X-Valun-Features: consents/1;roles=`), so the
participant takes part in no new consent. The catalog disclosure (rule 12) must say that these read-only tools can sign
value-safe consents within the standing policy in unattended runs.

### OQ-41 (decision) Console approval mode also turns on `review_deliveries` — OPEN [design]
So that credit notes and payments by transfer wait for the owner in console approval mode. This changes behaviour for
existing console-mode users. To confirm.

### OQ-42 (decision) Payment timing constants — OPEN [design]
After a transfer attempt fails or expires, the payer may pay another way (its own note or another issuer's note) only
after the attempt's timestamp + 1 hour + a margin (60 s at the server, 120 s at the client); a retry with the same
issuer is allowed at once (`PROTOCOL.md` 18.8). Signatures are collected for at most 20 minutes for a transfer and 30
minutes for a set-off. These are protocol constants (the one-hour limit is compiled into the tracker), so they must be
chosen before the tracker is built. A consequence to weigh: a payee that refuses a transfer waits up to about 62
minutes for its credit note.

### OQ-43 (decision) Partial payment by transfer — OPEN [design]
Refused in v16: a payment by transfer must cover the whole price (`409 insufficient_claim`). To confirm, or schedule
split payments (several issuers, or a note plus a transfer) for a later release; a split payment needs its own
exclusion argument (`PROTOCOL.md` 18.6, 18.8).

### OQ-44 (decision) Sandbox economy numbers — OPEN [design]
The operator-run sandbox agents would buy from strangers: one welcome job per sandbox participant (3 PC), at most 3
purchases per stranger per day, and a stranger holds at most 20 PC of their notes. They issue operator-signed notes up
to 1000 PC outstanding each, not counting debt to sandbox participants whose time has ended. There is no synthetic
float and no trading between the agents (`PROTOCOL.md` 18.15). To confirm these numbers.

### OQ-45 (decision) Privacy of circulation data — OPEN [design]
Keep the public `GET /ledger` as it is (it already shows every edge total), keep transfer and set-off receipts visible
only to their parties, publish only aggregates on `GET /clearing`, and publish no per-edge journal (`PROTOCOL.md` 18.12,
16.2). Or schedule a party-scoped ledger.

### OQ-46 (decision) Edges under revoked keys stay frozen — OPEN [design]
In v16 an edge under a revoked (past) key cannot be spent or cleared, though it still counts in positions
(`PROTOCOL.md` 18.13). To confirm, or plan a key-rotation novation that moves such edges to the current key.

### OQ-47 (decision) Phase-2 credit policies in 0.4 or 0.4.1 — OPEN [design]
`max_claims_total`, the `max_issuer_net_debt` predicate with a one-level haircut, `accept_operator_issuers` and the
aggregate credit history: include them in v16 and the 0.4 clients, or defer them to 0.4.1 if time runs short (they are
the first part to cut, `PROTOCOL.md` 18.13).

## I. New in revision 7: found while writing the release v16 contract

### OQ-48 (medium, security) Outcome reports: a server that hides an applied payment can obtain a second one — OPEN [design]
Whether a note or a novation applied is decided by the server's read-back (I-DECIDE). A client can check it only
through states it signed itself.
- Credit notes. Every change on a payer's outgoing edge carries its own signature, so a later prior shows whether its
  note applied. The 0.3 clients' issued record turns a hidden applied note into `ledger_mismatch` at the next
  completion (OQ-23); a 0.4 client, which accepts a self-signed `prior_note` instead, keeps that protection only if it
  treats its own pending note appearing as a prior as applied and refuses to pay that deal again (`PROTOCOL.md` 15.3,
  notes). Without that rule it would sign a second note on top of the first.
- Transfers. On a claim B holds (A→B) the issuer's notes change the edge without B. Once A→B has moved past an
  attempt's timestamp, B cannot tell from the edge alone whether that attempt applied. A server that applies a
  transfer, reports it as failed, waits for one of A's notes on A→B and then offers a regenerated same-issuer attempt
  (which B's client re-signs by itself while the quote digest is unchanged, `PROTOCOL.md` 18.6 step 8) obtains a second
  payment of the same deal. Each payment is signed by B for exactly the price, so I-VALUE holds; I-ONCE then rests on
  the server's honesty.
Suggest: before B's client re-signs a regenerated attempt after A→B moved through an operation B did not sign, it needs
evidence that the earlier attempt did not apply (with bound notes every note A issues on A→B carries A's acknowledgment
of the state before it, so the server can show the chain of states from the attempt's prior to the current one), or the
owner's approval; and every party of an applied transfer gets its receipt, so the payee's view can contradict a false
failure report.

**Revision 8: CHANGED (decisions D-1 and D-2) [vectors, impl].** A client keeps one live payment attempt per deal and
classifies earlier ones from the edge's full state (D-2 a): an ambiguous read-back is `attempt_outcome_unknown`, which
only the payer's owner resolves, after confirming with the payee, through `POST /owner/deals/{vd}/attempts/{vt}/resolve`
(D-2 d; `PROTOCOL.md` 18.8); the server proves attempts dead only from a journal that covers every seq (D-2 e, D-3 d).
The transcript's flow Y runs the case end to end (a lost tracker answer, a note submitted around Valun, the owner's
resolution). What remains: read-backs still come from the server, so a stale but validly signed state is caught only
through the attempt's acknowledged prior state and the client's own records (16.2 item 7).

### OQ-49 (low, honest label) `/info` `description` still says "no clearing" with circulation on — OPEN [design]
The v16 design keeps `GET /info` `description` unchanged in every mode (it must stay unchanged with circulation off,
I-DARK). In v15 it ends "An issued note is an outstanding obligation; nothing in the pilot is settled (no redemption,
reserve or clearing)." (http.mjs:62 at `495624c`). With circulation on, set-offs do clear obligations, and the deal and
position labels say so (`PROTOCOL.md` 16.1), so the description contradicts them. Suggest: while `circulation/1` is
advertised, end the description with the wording of the circulation settlement label, and pin it in the vectors.

**Revision 8: RESOLVED [vectors, impl].** In modes sandbox and on the description now says what circulating credit
does ("An issued note is not settled: ... Nothing is redeemed, there is no reserve, and PC have no value."), and mode
sandbox adds that it is on for sandbox participants only; modes off and bound keep v15's text (`PROTOCOL.md` 16.1).
Transcript step 148 pins the mode-on text.

## J. New in revisions 8 and 9: found while implementing release v16

### OQ-50 (decision) Bounding `deliver_by` on sandbox purchases — OPEN [impl]

The sandbox agents do not bound `deliver_by` on what they buy, so an agreed purchase that is never delivered stays
committed (counted against `max_issue_outstanding` and the earn caps) until `deliver_by` + 7 days. An open welcome offer
reserves 3 PC for 24 h, and an accepted, undelivered welcome job holds 3 PC for about 9 days. A bound such as the
welcome job's 48 hours would shorten that (`PROTOCOL.md` 18.16, Sandbox).

### OQ-51 (decision) A v15 rollback turns a payment by transfer into a credit-note record — OPEN [impl]

v15's `migrate()` reads a v16 deal's `d.payment` (a payment-by-transfer record on a deal without a credit note) as the
first pilot version's note record and turns it into a credit-note record with no note. It is display-only in v15, but
a re-upgrade to v16 loses that deal's payment block. `scripts/pilot-downgrade-check.mjs` lists these deals and its
backup keeps the original records; whether the check should set `d.payment` aside, and v16 restore it, is open
(`PROTOCOL.md` Appendix H).

### OQ-52 (low, conformance) The 0.4.0 clients declare no `PROTOCOL_FEATURES` — OPEN [vectors]

`check_python.py` holds a client to the circulation vectors when its client or novation module declares
`PROTOCOL_FEATURES` containing `circulation/1`, or when the run is given `--require circulation/1`. Neither the package
0.4.0 nor the plugin 0.4.0 declares it, so their circulation checks run only with `--require` (the package's CI step
passes it). Declaring `PROTOCOL_FEATURES = ('bound_notes/1', 'circulation/1')` in `valun/client.py` (and re-vendoring
it into the plugin) would make the plugin's CI step hold it too once the pin moves to 0.4.0.

Revision 9: `.github/workflows/ci.yml` now pins the plugin 0.4.0 (`2b78a06`, to be replaced by the pushed commit) and
runs it, and the package, with `--require circulation/1` (the package also without it, and the plugin 0.3.0 without
it while the catalog pins it), so CI holds both 0.4.0 clients to the circulation vectors. A run made without the flag
still marks those checks not applicable.

### OQ-53 (low, client API) An adapter's own how-to-change hint — OPEN [impl]

The core's `consent_policy_in_force()['how_to_change']` names the core CLI (`valun config ...`), so the Hermes plugin
replaces it whole with its own commands. A core option for an adapter's hint, like `setup_hint`, would make the
replacement unnecessary.

### OQ-54 (low, client bug) `valun config consents.max_PC` accepts non-ASCII digits — OPEN [code]

`python/src/valun/cli.py` checks the value with `str.isdigit()`, which is true for digits such as `²`, and `int('²')`
then raises an unhandled `ValueError`. The plugin checks with an ASCII `[0-9]` pattern instead (a bad value means cap 0).

### OQ-55 (low, honest label) `GET /clearing` `cleared_PC` is gross — OPEN [impl]

`totals.cleared_PC` sums the decreases over every edge of the applied set-offs (7 for the sandbox tour: 2 + 3 + 2),
while a participant's `cleared_by_setoff` and a client's `cleared_so_far_PC` count one side only (2 for the stranger
after the tour). Both are right; neither says which it is (`PROTOCOL.md` 18.16).

### OQ-56 (low, operability) Two things a client cannot read — OPEN [impl]

`429 rate_limited` carries no `retry_after_ms` (self-serve sandbox joins are limited to 3 per address per hour, held in
the server process's memory); and a deal left unpaid keeps the edges its payment attempts would change out of clearing
for as long as it stays unpaid (D-2 c; `PROTOCOL.md` 16.2 item 11).

### OQ-57 (low, conformance) The vectors show no request after the empty roles header was taken — OPEN [vectors]

Transcript step 231 shows a client withdrawing its consent roles: its request carries `X-Valun-Features:
consents/1;roles=` and it then records `consent_roles_declared: ''`; `check_python.py` compares that header exactly, as
it does on every replayed request (none where none is recorded). No later step replays the same profile, so a client
that keeps sending the empty list on every request (harmless: the server has nothing more to forget) is not told apart
from one that sends it once, as `PROTOCOL.md` 18.1 says. A step after 231 (a second request from that profile, recorded
without the header) would show it; it changes the transcript, so the JavaScript replay (JS-2) has to map that step too.

### OQ-58 (low, conformance) The replay checks the capability header of the step's own request only — OPEN [vectors]

`check_python.py` compares a replayed request's `X-Valun-Features` header with the recorded one (none where none is
recorded, as in steps 1-147), but the reads it serves from a step's recorded `client_reads` are answered without
looking at their headers. A client that sent the header on its GET reads to a server without `circulation/1` would
therefore pass, although `PROTOCOL.md` Appendix H (item 6 of the D-2 h list) says it must not. The Python client's
own tests show that it sends none there (`test_client_circulation.py`, `test_never_without_circulation`), and the
JavaScript client is compared with it request by request, headers included (`js/test/agent-parity.test.js`). Fix: record the read headers in `client_reads` at
the next regeneration and compare them, or refuse a header on a read in steps whose request carries none. The
JavaScript replay mirrors the Python checks and has the same gap.

## K. What was and was not verified

### Revision 9

- Checked, statement by statement: the release v16 text of `PROTOCOL.md` against `spec/vectors` (unchanged since
  revision 8: generated from valun-app `cfe698b`) and the final code (valun-app `cfe698b`/`b88c1b3` `lib/`, valun-open
  `fc58e8d`, plugin `2b78a06`), by reading the sections and by scripts: every JSON example that names a vector record
  equals it (the terms of `canonical.json` `terms/base`, the GET /consents answer of transcript step 171, the
  `recently_resolved` entry of step 184, the GET /info `novation` of step 148, the 18.3 worked example), the
  GET /capabilities example has exactly the values `lib/pilot/caps.mjs` requires, the 28 firewall codes of 15.3 are
  exactly those of `circulation.json`, every route named in section 18 is in the route table, and the counts of the
  section 17 table match the files. The corrections are listed under revision 9 above.
- Run (Windows, Python 3.14.7 unless stated): `check_python.py` from the working tree: the package with
  `--require circulation/1` **1386 checks: 1188 agree, 0 disagreements, 17 informative differences, 181 not
  applicable**, also with Python 3.11.18; without it **1384 checks: 1104 agree, 0 disagreements, 17 informative, 263
  not applicable**; the plugin 0.4.0 (`git archive` of `2b78a06`) the same two lines (with `--require` also on 3.11.18);
  the plugin 0.3.0 (`5d01fbd`) the second line; exit status 0 each time. `scripts/check_plugin_core.py` on `2b78a06`:
  unchanged (8 files). `python -m unittest discover -s python/tests`: 385 tests OK (5 skipped without the MCP SDK, none
  with it; also on 3.11.18). `node --test js/test/` (Node 24): 486 tests, 485 pass, 1 skipped (POSIX file modes);
  `tsc --strict` (TypeScript 6.0.3) on the three `.d.ts` files: no error. The JS fixture generator, run in a clone,
  reproduces the committed fixtures exactly (3.14.7); run with 3.12.3 in WSL it changes 10 lines of
  `python-parity.json` besides the version (error texts and results), which is why CI regenerates them with 3.14.
  The plugin's unit tests: 140 OK (1 skipped without Hermes; none skipped in the Hermes venv). `generate.mjs`, run in
  a clone (it exports valun-app `cfe698b` with `git archive` itself), writes exactly the committed vectors.
- Not run: the valun-app test suites, the real tracker, CI itself (the workflow was parsed with ruamel.yaml and
  PyYAML, and each of its steps except the registry validator was run locally, not on GitHub), any network service.

### Revision 8

- Run: `generate.mjs` from valun-app `cfe698b` (exported with `git archive` by the generator itself; Node 24.21.0),
  twice: both runs write identical files (`git diff --exit-code -- spec/vectors` empty after the second), transcript
  steps 1-147 are byte-identical to release v13's, and an export of `6a6a34b` still gives exactly the v13 files.
  `check_python.py`: the package 0.4.0 with `--require circulation/1`, and the plugin 0.4.0 (`e2c7640`) with it,
  **1386 checks: 1188 agree, 0 disagreements, 17 informative differences, 181 not applicable**; without it the
  package, the plugin 0.4.0 and the plugin 0.3.0 (`5d01fbd`, the CI pin) **1384 checks: 1104 agree, 0 disagreements,
  17 informative differences, 263 not applicable** (Python 3.14.7 and 3.11.18 on Windows, 3.12.3 in WSL). Eight
  mutants of the package's circulation code (a firewall rule removed, R4 and freshness loosened, the empty roles
  header never sent, a paid deal not recorded, a wrong pay statement, a wrong quote, a wrong residue) each make the
  check fail; the unmutated control passes. Every replay also compares the request's `X-Valun-Features` header with
  the recorded one (none where none is recorded), the exact set of signatures in its body (none missing, none extra)
  and that it is sent once: each of fifteen package mutants (the header never sent, old roles sent after the
  withdrawal, a header without `circulation/1`, the empty header never sent, a signature added to a v16 body, a
  signature missing from or added to a v13 body, a request sent twice in a v16 and in a v13 step, and six firewall
  mutants) makes the check fail, with the unmutated control passing; eight of them passed the checker before these
  comparisons were added (OQ-57 names what the vectors still do not show). `scripts/check_plugin_core.py` passes on
  the plugin 0.4.0 (eight files) and on the plugin 0.3.0 (six files, against a locally built valun 0.3.1 wheel served
  offline), and flags a changed file and a module the package lacks.
- `node --test js/test/` with the new vectors: 361 tests, 347 pass, 13 fail, 1 skipped. Twelve failures are the new
  replays of transcript steps 148+ (the JavaScript client has no 0.4 methods yet: JS-2 extends the replay); the
  thirteenth (`fixtures were generated from the Python sources as they are now`) fails on valun-open `1509cbe` with the
  old vectors too (347 tests, 345 pass, 1 fail).
- Folded into `PROTOCOL.md` from the implementation round (each item's source task in brackets): the tracker v3.1
  contract and bound-note maximum age [TR-7] (18.2, 18.5, 18.8); the firewall's codes, order, D-1 attempts, R4 and R8
  fields [PY-2, PY-3] (15.3, 16.2); server behaviour of payments, consents, set-offs, approvals, views, policies,
  edges, clearing and the sandbox [SV-4, SV-5, SV-6, SV-7, SV-8, SV-9] (18.6, 18.8, 18.16); decisions D-1 and D-2 and
  the owner's resolution [FX-SV, FX-PY] (15.3, 18.6, 18.8, Appendix H); the D-2 h list of circulation-off client
  reads, with D-3 a's read before `valun_status` or `valun_inbox` [FX-PY, FX2-PY, FX3-PY, PL-2] (Appendix H); the
  client and adapter notes [PY-4, FX2-PY, PL-1, PL-2, INT-1] (16.1, 18.16); and the last round's server fixes and
  decisions D-3 b and d [FX3-SV] (18.1, 18.8, 18.13, 18.16, Appendix H).
- Not run: the hosted server, any network service, the real tracker binaries (the transcript's tracker is the in-memory
  stand-in of v3.1's rules), the valun-app test suites (FX3-SV ran them for `cfe698b`).

### Revision 7

- Read, not run: valun-app commits `0317239` (release v14) and `495624c` (release v15) with `git show` (the diffs of
  `lib/pilot/core.mjs`, `lib/pilot/http.mjs`, `lib/pilot/sandbox.mjs`, `server.mjs`, `fly.toml` and
  `test/open-sandbox.test.mjs`) and the files at `495624c` with `git show <commit>:<path>` (the line numbers and sha256
  values of `PROTOCOL.md` Appendix G); `docs/PILOT-API.md` at `495624c` (it never mentions the sandbox). The valun-app
  working tree was not read. The tracker request field names of `PROTOCOL.md` 18.2 come from
  `crates/basis_server/src/models.rs` at Basis `a00233d` (read only).
- The v16 sections are written from the release v16 design, before its code: nothing in them was run, and they are
  marked *draft until vectors are regenerated* in `PROTOCOL.md`.
- Run: `check_python.py` against both clients, from clean exports (`git archive`) of valun-open `c75cfb0` (package
  0.3.1) and hermes-plugin-valun `5d01fbd` (plugin 0.3.0), with Python 3.14.7: each **829 checks: 658 agree, 0
  disagreements in failing tiers, 17 informative differences, 154 not applicable** (exit status 0), the same counts as
  in revision 6. `node --test js/test/` on the same valun-open export (Node.js 24.21.0): 258 tests, 257 pass, 0 fail,
  1 skipped.
- Not run: `generate.mjs` (no file under `spec/vectors` changed in revision 7; the vectors still describe v13), the v16
  server, the tracker v3, the valun-app test suites, the hosted server, any network.

### Revision 6 (release v13: how the current vectors were made)

- Exported: valun-app commit `6a6a34b` (release v13) with `git archive` into a scratch folder (the valun-app working
  tree was not read; the v12→v13 change was read from `git diff a61c32e 6a6a34b`: `hasUnsafeText` in
  `lib/pilot/core.mjs` and a test). The generator checks the sha256 of core.mjs, pilot http.mjs, lib/basis.mjs and
  lib/http.mjs against v13's; every vector file says `server_release: "v13 (valun-app commit 6a6a34b)"`.
- Run: `generate.mjs` against that export (the real code in memory, as in revision 5; every assertion about accepted
  and refused inputs holds; two runs give byte-identical files). `transcript.json` is the v12 run unchanged (v13
  changed no step); `canonical.json`, `statements.json` and `terms-validation.json` gained the v13 cases, and the six
  vectors that pinned the revision 5 residual as accepted (two canonical, two terms-validation, the decline and dispute
  reasons) are now refused.
- `check_python.py` against both clients: Hermes plugin (the clone at `f504d2660727bf90ee1375e6b071acd5c6b63de5`):
  **829 checks: 658 agree, 0 disagreements in failing tiers, 17 informative differences, 154 not applicable** (exit
  status 0); `valun` package (`python/src` of the valun-open working tree, 0.3.0.dev0): the same, **829 checks: 658
  agree, 0 disagreements in failing tiers, 17 informative differences, 154 not applicable** (exit status 0). The
  negative-control copy of the package gives 30 disagreements (exit status 1).
- Probed in memory with the real v12 and v13 `hasUnsafeText`: every code point U+0000–U+10FFFF between two letters
  (3777 more refused by v13, none fewer; the only Cc/Cf/default-ignorable code points accepted are U+0009, U+000A,
  U+000D, U+061C, U+200C–U+200F; counts of accepted private-use, unassigned, surrogate and noncharacter code points);
  runs and contexts of the single marks and variation selectors, keycaps, flag tag sequences (including extra cancel
  tags); a sentence carrying 10 single marks (accepted, visible text unchanged); the prepended concatenation marks
  (all refused); two joins with the display name U+2800 U+2800 (both accepted). Unicode 17.0 (Node.js 24.21.0, ICU 78.3).
- Not run: the Rust `valun_signer`/basis_core, the real signer runner, the real Basis tracker, the valun-app test suites,
  the hosted server, any network. Rendering of the blank-looking, private-use and unassigned characters was not checked.
- Earlier results, for comparison: revision 5 (release v12) 791 checks, 636 agree; revision 4 (v11) 747, 607; revision
  3 (v9) 649, 526; each time 0 disagreements and 17 informative differences, both clients alike.
