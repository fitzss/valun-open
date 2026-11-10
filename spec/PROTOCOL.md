# Valun pilot protocol `valun-deal/1` on network `valun-pilot-1`

Specification of the protocol **as the server implements it**, written so that a third party can build a
compatible client (TypeScript, Go, Rust, ...) without reading the server code. This is revision **v14** of this
document.

| | |
|---|---|
| Status | Sections 1–17 and Appendices A–G: descriptive specification of running code up to server **release v15** (valun-app commit `495624c`, deployed). Section 18, section 15.3, sections 16.1–16.2, Appendix H and the paragraphs on release v16 in sections 1–17: the contract for server **release v16** ("circulating credit", valun-app branch `circulation-v16`; built locally, not released, not deployed), written before its code so that the server, the clients and the tracker are built against it, then corrected from the implementation (decisions D-1, D-2 and D-3; section 18.16) and from the vectors regenerated from it (valun-app `cfe698b`, section 17), and finally checked statement by statement against those vectors and the final code of the server and the 0.4.0 clients (it is no longer a draft). Circulating credit is **off by default**, and with it off v16 answers like v15 (18.1). Experimental network; PC are synthetic units with no value. Changes: Appendix B (release v8, from the first version of this document), Appendix C (release v9), Appendix D (releases v10 and v11), Appendix E (release v12), Appendix F (release v13), Appendix G (releases v14 and v15) and Appendix H (release v16). |
| Authority | Up to release v15: the code. Where this document and the code disagree, the code wins and this document has a bug. For release v16 this document is the contract, checked against the vectors regenerated from the v16 code (section 17): a disagreement between the two is a bug in one of them, settled by the regenerated vectors. |
| Server source described | Release v15 (`495624c`): `valun-app/lib/pilot/core.mjs` sha256 `ad47e6aee53be872e2d41c734b219243fff2d4502a86b72fe94c24a0a6d45043` (changed in v14 and v15), `lib/pilot/http.mjs` sha256 `3065809458c2538dc4b586247438ffec8a6db9102b9252cc8fc98939353fc213` (changed in v14), `lib/basis.mjs` sha256 `991e37a2319de3731c0ef84ea5847ba428e3575a3c8facd51be1c7cd52891617` and `lib/http.mjs` sha256 `2ef7d0f77a418da7633d5abd5591f2cec39e455e42b953efc401b8f6061c3baf` (both unchanged since v11), `basis/valun_signer.rs` sha256 `acf25be8a1e095faa4aac3aaa04568755896de85dbcc073e88f91f0b9a0c38a5` (unchanged since v8); Basis pinned at `3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3`. Line references (core.mjs:N, http.mjs:N) in sections 1–17 are to the release v13 files (core.mjs sha256 `7dc469e0547ae0a518c022b93cff6181fd116f4fcc3f8f3b7a3deb0e0f240b2e`, http.mjs sha256 `01a505623d64c0a2c00a221240d57b5631c91dec61f5caaeb37113e8497c0f0e`), to which v14 and v15 only added the sandbox-join code (so later v15 line numbers are shifted); Appendix G cites the v15 files. Release v16 is described by its contract (section 18), not by source hashes, and needs the tracker v3 (18.2). |
| Reference clients compared | the Hermes plugin `hermes-plugin-valun` 0.3.0 at commit `5d01fbd` (the commit the Hermes plugin catalog entry pins; its core `valun_core/` is the `valun` package 0.3.1, byte-identical) and the framework-neutral package `valun` 0.3.1 in this repository (`python/src/valun/client.py`, `basis.py`, `agent.py`; commit `c75cfb0`). The JavaScript package `@fitzdoud/valun` 0.3.1 (`js/src`) is held to the same vectors by its own tests (`node --test js/test/`). None of them implements release v16. For release v16: the package `valun` 0.4.0 (this repository, `python/src`, last changed in commit `4310103`) and the Hermes plugin 0.4.0 (`2b78a06`, local, not pushed; its `valun_core/` is the package 0.4.0, byte-identical) pass every v16 vector (section 17), and the JavaScript package `@fitzdoud/valun` 0.4.0 (`js/src`, commit `fc58e8d`) passes them in its own tests, including the replay of every transcript step that has a client call. None of the 0.4.0 clients is published yet. |
| Conformance vectors | `spec/vectors/*.json`, generated from the real server code by `spec/vectors/generate.mjs` from release v16 (valun-app `cfe698b`): transcript steps 1-147 as release v13's, with circulation off, steps 148-236 and `circulation.json` with circulation on (releases v14 and v15 have no vectors of their own); checked against either Python client by `spec/vectors/check_python.py` (section 17; CI commands in `spec/vectors/README-ci.md`). |
| Known problems | `spec/OPEN-QUESTIONS.md` (revision 9). |

Key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. In this document **"the server
enforces"** means the code refuses the request (nothing is recorded); **"a client MUST"** means the server cannot or
does not check it, so a client that skips it can be made to sign something its user did not intend.

---

## 1. Overview

Valun is an agent-to-agent credit network. Each **participant** has two principals:

- an **owner** (a human operator) who holds an *owner token*, sets a *mandate* and decides *approvals*;
- an **agent** (software) that holds an *agent token* and its own **secp256k1 signing key**, generated on the agent's
  machine. The server never sees the key; it stores only the public key.

Two participants negotiate a **deal**: one proposes signed **terms** (who pays, who performs, the service, the price in
PC, deadlines); the other may accept, decline or counter. Accepted terms form an **agreement** signed by both. The
**payee** delivers (signed); the **payer** either disputes (signed) or accepts the delivery (signed) and, in the same
request, **issues a credit note**: a Basis note signed by the payer's key that says "the payer owes the payee a
cumulative total of T PC". A **Basis tracker** (a real Basis server, run by the network with no blockchain connection)
records the note.

The server enforces the owner's mandate at every agent commitment and holds commitments above a threshold for owner
approval.

**Honest labels** (section 16): an issued credit note is an outstanding obligation, *not* a settlement. Up to release
v15, and in release v16 while circulating credit is off (the default), nothing in the pilot is ever settled: there is
no redemption, reserve, clearing or netting. The tracker is local (notes stay `local_only`, never on a chain). PC have
no monetary value. Owner approvals are recorded by the server, not signed by a key.

**Circulating credit** (section 18; release v16, off by default): with it on,
a payer may pay with a note it holds (a **debt transfer**: the issuer's debt to the payer falls by the price and its
debt to the payee rises by the same amount, signed by the issuer and by both creditors), and the server proposes the
cancellation of cycles of debts (a **multilateral set-off**, signed by every party; no participant's net position
changes). Nothing is redeemed even then, and there is no reserve.

## 2. Conventions

### 2.1 Encodings

- HTTP bodies are JSON (UTF-8). Responses are `Content-Type: application/json; charset=utf-8`, pretty-printed with a
  1-space indent (insignificant). A missing/empty request body is treated as `{}`.
- **Hex** is lowercase. Public keys: 66 hex chars (33-byte compressed secp256k1). Signatures: 130 hex chars (65 bytes).
  Hashes: 64 hex chars. Keys and signatures MUST be JSON **strings** matching `/^0[23][0-9a-f]{64}$/` and
  `/^0[23][0-9a-f]{128}$/` (lowercase only; since v9 a signature must start with `02` or `03`, the prefix of its
  compressed point, core.mjs:70); this applies to every signature, including the credit-note signature.
- `sha256hex(x)` = lowercase hex of SHA-256 over the UTF-8 bytes of the string `x`.
- **Times** in JSON are strings. The server writes them with ECMAScript `Date.prototype.toISOString()`:
  `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC). Times inside terms are hashed exactly as written (section 7.3); a client SHOULD
  write them in that form (see OPEN-QUESTIONS for what else the server accepts). Credit-note timestamps are integers:
  milliseconds since the Unix epoch.
- Numbers in terms are integers. The server's integer checks use `Number.isSafeInteger`.

### 2.2 Identifiers

| Thing | Format | Chosen by |
|---|---|---|
| participant id | `vp_` + 12 lowercase hex (`/^vp_[0-9a-f]{12}$/`) | server |
| handle | lowercase, `/^[a-z][a-z0-9_-]{2,23}$/`, unique | owner at join (lowercased by the server) |
| deal id | `vd_` + 16 lowercase hex (`/^vd_[0-9a-f]{16}$/`), unique on the network | **the proposing client** (random, 64 bits) |
| terms nonce | 32 lowercase hex (`/^[0-9a-f]{32}$/`) | the proposing client (random, 128 bits) |
| approval id | `va_` + 12 lowercase hex | server |
| invite id | `inv_` + 8 lowercase hex | server |

Release v16 with circulation on adds, chosen by the server: transfer ids
`vt_` + 16 lowercase hex and set-off proposal ids `vs_` + 16 lowercase hex. An **edge key** names a tracker edge as
`<issuer_pubkey>><recipient_pubkey>` (66 hex, `>`, 66 hex; section 18).

### 2.3 Text fields and `clean()`

Free-text fields are checked by one server function, `clean(text, max)` (core.mjs:60-67):

1. `null`/absent/`""` → `""` (an error if the field is required); a non-string → `400 invalid_field`.
2. Every character in U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F is replaced by a space (TAB, LF, CR kept).
3. The result is trimmed with ECMAScript `String.prototype.trim()` (removes leading/trailing TAB, LF, VT, FF, CR, space,
   U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF; **not** U+0085).
4. Its **length in UTF-16 code units** (not code points, not bytes) must be ≤ `max`; required fields must be non-empty.

Where the cleaned value is *stored* (participant profile, reasons, notes, delivery title), it is the cleaned text.

**Refused characters (normative since release v13).** The server *refuses* (`400 invalid_field`) a text for which
the following test says "refused", instead of cleaning it (core.mjs:84-113, `hasUnsafeText`). Refusing has been the
rule since release v8; this definition replaces the lists of v8 to v12 (Appendix F) and is part of the protocol. A
client that wants to know before signing whether the server will accept a text implements exactly this:

Read the text as a sequence of Unicode code points (a lone surrogate counts as one code point). For each code point
`c`, with `p` the code point before it and `n` the code point after it (either may be absent), in order:

1. `c` is U+0009 TAB, U+000A LF or U+000D CR: allowed.
2. `c` is one of the five **single marks** U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER, U+200E
   LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK, U+061C ARABIC LETTER MARK: allowed, unless `n` is also one of the
   five (two in a row are refused; a mark may stand anywhere else, also at the start or end).
3. `c` is U+FE0E or U+FE0F (variation selectors 15 and 16): allowed if `p` exists, `p` is not 0–9, `#` or `*`, and
   `p` has the Unicode property `Emoji` (ECMAScript `\p{Emoji}`); or if `p` is 0–9, `#` or `*`, `c` is U+FE0F and `n`
   is U+20E3 COMBINING ENCLOSING KEYCAP (a keycap, `1️⃣`). Otherwise refused. `p` is the code point actually before
   `c`, so a selector after another selector, after a single mark or after U+E007F is refused.
4. `c` is U+1F3F4 WAVING BLACK FLAG: allowed. If the code points after it are exactly the tag letters of `gbeng`,
   `gbsct` or `gbwls` (U+E0067 U+E0062 then U+E0065 U+E006E U+E0067, U+E0073 U+E0063 U+E0074, or U+E0077 U+E006C
   U+E0073) followed by U+E007F CANCEL TAG, those code points are allowed too and the scan continues after U+E007F
   (the RGI flags of England, Scotland and Wales). Any other tag character is tested by rule 5 and refused.
5. Any other `c` is refused if its General_Category is Cc (control) or Cf (format), or it has the property
   Default_Ignorable_Code_Point; otherwise allowed.

The text is refused if any code point is refused. Unicode properties are those of Unicode 17.0, the version of the
server's JavaScript engine (Node.js 24.21.0, ICU 78.3, on which the vectors were generated); a client using another
Unicode version can disagree only on code points whose properties differ between the versions. Escaped form of the
exceptions: rule 1 `\u0009 \u000a \u000d`; rule 2 `‌ ‍ ‎ ‏ ؜`; rule 3 `︎ ️`,
`⃣`; rule 4 `\u{1f3f4}`, tag letters `\u{e0061}`–`\u{e007a}`, `\u{e007f}`.

What it covers: every control except TAB/LF/CR (C0, DEL, C1), every format character (soft hyphen, bidi embeddings,
overrides and isolates, zero-width space, word joiner, invisible operators, BOM, interlinear annotation, tag
characters, the shorthand and Egyptian hieroglyph format controls, and the prepended concatenation marks), and every
default-ignorable code point, assigned or not (Hangul fillers, all variation selectors outside rule 3, the Mongolian
free variation selectors, combining grapheme joiner, Khmer inherent vowels, U+2065, U+FFF0–U+FFF8, U+E0000–U+E0FFF).
A sweep of every code point (each between two letters) found exactly U+0009, U+000A, U+000D, U+061C and U+200C–U+200F
accepted among Cc, Cf and default-ignorable code points, and 3777 code points refused that v12 accepted, none the
other way.

**A deliberate trade-off:** the prepended concatenation marks are visible format characters (category Cf) and are
refused with the others: U+0600–U+0605 (Arabic number signs, e.g. the sign that spans the digits of a page number),
U+06DD ARABIC END OF AYAH, U+070F SYRIAC ABBREVIATION MARK, U+0890–U+0891, U+08E2, U+110BD and U+110CD (Kaithi). Text
that needs them cannot be signed (vectors `refused/arabic-prepended-concatenation-mark`,
`bad/format-or-ignorable-600`).

Allowed on purpose: the five single marks (Persian and Indic scripts, emoji ZWJ sequences such as 👩‍💻, bidi marks),
emoji presentation and text presentation selectors after emoji, keycaps, the three RGI subdivision flags.

It applies to:
- the **signed service text** in terms (`title`, `description`, `deliverable`; core.mjs:115-120, 558): the raw text MUST
  NOT contain a refused character, its **raw** length MUST be ≤ max + 100 UTF-16 code units, and its cleaned form MUST
  be non-empty and ≤ max. The terms are still stored and hashed **raw**, so allowed padding (and TAB/LF/CR) is part of
  the signed text;
- the public profile fields at join (`display_name`, `operator`, `about`, `services`; core.mjs:205-206);
- since v9, **decline and dispute reasons**, raw, before anything else is done with them (core.mjs:759, 1028; section
  8.3).

Not covered (stored cleaned, refused characters other than the C0 controls are kept): the delivery title, the delivery
content (raw, never cleaned), owner approval notes, invite notes, the mandate objective and agent notes.

What the rule still lets through (OPEN-QUESTIONS OQ-33; no Cc, Cf or default-ignorable code point outside the
exceptions passes):
- the single marks are allowed between any two characters, also where they change nothing (between two Latin
  letters): an invisible choice of six (none or one of five) after every character, about 2.6 bits per character
  (vector `ok/single-marks-between-letters`); likewise U+FE0F, U+FE0E or nothing after each emoji;
- characters that are not Cc, Cf or default-ignorable but render as blank space: U+2800 BRAILLE PATTERN BLANK and
  U+1D159 MUSICAL SYMBOL NULL NOTEHEAD (category So; `ok/blank-looking-characters`), the space separators (U+00A0,
  U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and U+2028/U+2029;
- private-use characters (137,468 code points), unassigned code points that are not default-ignorable (810,961 in
  Unicode 17.0, the 66 noncharacters among them) and lone surrogates (OQ-3), whose rendering depends on the fonts.

Decline and dispute reasons are **signed exactly as sent** (section 8.3).

## 3. Identities

A **participant** (public record):

| field | meaning |
|---|---|
| `id` | participant id |
| `handle` | unique handle |
| `display_name` | ≤ 40, defaults to the handle; must not be a reserved word or another participant's handle or display name once normalized (below; `409 display_name_taken` since v9) |
| `operator` | the responsible human/organisation, required, ≤ 60, public |
| `about`, `services` | ≤ 300 each, public |
| `pubkey` | the currently registered agent key, or `null` |
| `status` | `awaiting_agent` (no key registered) or `active` |
| `joined_at` | ISO time |
| `agent_last_seen` | ISO time of the agent token's last authenticated request (reset when the key changes), or `null` |
| `sandbox_only`, `sandbox_expires_at` | since v14, only on a self-serve sandbox participant (Appendix G): `true`, and the ISO time at which its sandbox mandate ends; absent on every other participant |

Release v16 with circulation `sandbox` or `on`: the server's sandbox agents
(section 18.15) also carry `operator_run: true` (the operator holds their keys).

**Names** (core.mjs:196-209, since v9). Names are compared in a normalized form, `norm(s)` = `s` in lower case with
every character that is not a Unicode letter or digit (`\p{L}`, `\p{N}`) removed: `Bea-Briefs`, `bea briefs` and
`bea_briefs` are the same name. Reserved words: `valun`, `admin`, `administrator`, `operator`, `owner`, `system`,
`support`, `root`, `basis`, `tracker`, `null`, `undefined` (core.mjs:114). At join, in this order:

1. the handle (lowercased, `/^[a-z][a-z0-9_-]{2,23}$/`) is refused if it is, or normalizes to, a reserved word
   (`409 handle_taken`, "that handle is reserved"; e.g. `ad-min`), or if it equals or normalizes to another
   participant's handle **or display name** (`409 handle_taken`);
2. profile fields MUST NOT contain refused characters (section 2.3; `400 invalid_field`);
3. the display name, cleaned and normalized, if non-empty and not equal to the participant's own normalized handle, is
   refused if it normalizes to a reserved word (e.g. `Valun`, `V.A.L.U.N`) or to another participant's handle or
   display name (`409 display_name_taken`; in v8 `409 invalid_field`).

Not covered (OPEN-QUESTIONS OQ-34): a reserved word counts only as the whole normalized name (`Valun Support` and
`Valun Operator` are accepted); a display name with no letters or digits normalizes to `""` and is never compared (two
participants can both be `🙂🙂`); there is no Unicode normalization (NFC/NFKC) before `norm`, so fullwidth letters are
not folded (`Ｖａｌｕｎ` is accepted) and, because `norm` removes combining marks, a precomposed and a decomposed
accent compare differently (`José Briefs` with U+00E9 and with U+0301 are both accepted); confusables (Cyrillic `о`
for Latin `o`) are different names. Vectors: `transcript.json`, the release v9 join steps.

The **network operator** runs the server. It creates invites and, at an owner's request, may issue enrollment codes and
change mandates (recorded as `changed_by: "operator"` / `issued_by: "operator"` and shown to the owner).

## 4. Credentials

All tokens are opaque bearer strings. The server stores only their SHA-256 hashes and shows each token once. Requests
authenticate with `Authorization: Bearer <token>` (scheme case-insensitive; the token is one run of non-whitespace).

| Credential | Format | Issued | Lifetime | Authorizes |
|---|---|---|---|---|
| invite code | `vpi_` + base64url(9 random bytes) | by the operator (admin route); since v14 also by the server itself for each self-serve sandbox join, used in the same request and never shown (Appendix G) | `ttl_days` 1–90 (default 14), `max_uses` 1–1000 (default 1); other values `400 invalid_field`; a sandbox join's own invite: 1 use, 1 day | one `POST /join` per use |
| owner token | `vpo_` + base64url(32 random bytes) | once, in the `POST /join` response | no expiry; the owner can replace it with `POST /owner/rotate-token` (since v11: a new token shown once, the old one `401` at once); since v12 the operator can issue a new one too (`POST /admin/participants/{id}/owner-token`, after confirming the owner out of band), for a lost or stolen token | read the participant's deals; set the mandate; record agent limits; decide approvals; revoke the agent; issue enrollment codes; rotate itself (since v11). **Cannot** sign or perform deal acts. |
| enrollment code | `vpe_` + base64url(12 random bytes) | in the join response; by the owner (`POST /owner/enrollment-code`) or the operator while no key is registered; in the revoke response | 30 minutes; single use; a new code replaces any earlier one | one `POST /enroll` (registering one agent key) |
| agent token | `vpa_` + base64url(32 random bytes) | once, in the `POST /enroll` response | until the owner revokes the agent | read the participant's deals; record agent limits; perform deal acts (each also needs a key signature); fetch credit-note templates. **Cannot** use owner routes. |
| admin token | random, on the server's data volume | — | — | admin routes, only from loopback, never through the proxy |

A token presented with the wrong role for a route gets `404 not_found` (not 403), except the credit-note template
(`403 agent_only` for an owner token). An agent token stops working the
moment its key is revoked (`401 unauthorized`). The owner token keeps working while no agent is enrolled.

## 5. Keys

### 5.1 Registration (enrollment) and proof of possession

The agent generates a secp256k1 key pair locally and calls `POST /enroll` with the participant id, the enrollment code,
its compressed public key and a signature (section 6) over the **enroll statement** (section 8):

```
valun-pilot/enroll/1\n{network}\n{participant_id}\n{pubkey}\n{sha256hex(enrollment_code)}
```

The server enforces, in order: `participant_id` and `code` are strings naming an existing participant with a matching,
unexpired code (`403 invalid_enrollment`); `pubkey` is a string matching `/^0[23][0-9a-f]{64}$/` (`400 invalid_field`);
the key **was never registered before by anyone**, as a current or past key (`409 key_in_use`); the signature is a
string matching `/^0[23][0-9a-f]{128}$/` that verifies (`403 bad_signature`; a malformed signature, or a key the
signer cannot parse, is also `403`, never `502`). If the signature checker is unavailable the request is refused with
`503 signer_unavailable` and the code is not consumed (since v9; section 6). On success the participant becomes
`active`, the code is consumed and an agent token is returned.

### 5.2 One key at a time; revocation; rotation

- A participant has at most one registered key. To change it, the owner revokes the agent (`POST /owner/revoke-agent`)
  and enrolls a new key with the enrollment code returned by the revocation.
- Revocation, at once: the agent token and key stop working; `status` becomes `awaiting_agent`; `agent_last_seen` resets;
  the key is appended to `past_pubkeys` (`{pubkey, registered_at, revoked_at}`), visible to the owner as `past_keys`.
- Every key a participant ever registered stays linked to it: tracker notes under an earlier key still count as that
  participant's in the ledger, positions and mandate exposure. A key can never be registered again (by anyone).
- Effects on the revoked participant's deals, whichever side it is on and whoever made the offer:
  - deals in `open`, `proposed_awaiting_owner` or `accepted_awaiting_owner` → `cancelled`
    (`cancellation: {reason: "agent_key_revoked", participant, revoked_pubkey, at}`), pending approvals void;
  - deals in `completion_awaiting_owner` → back to `delivered`; the held, payer-signed note is voided (never submitted);
  - **agreed deals stand** (`agreed`, `delivered`, `note_failed`, ...): they bind the participant, not the key. After
    re-enrollment the participant's new key delivers, completes or disputes them.
- Terms name each party's key. An offer can be accepted (and an approval decided) only while both parties are `active`
  with exactly the keys the terms name (`409 key_changed`).
- A credit note is always between the **current** keys: signed by the payer's current key, crediting the payee's current
  key (`keys_as_agreed: false` when either differs from the keys in the agreed terms). A new key pair starts a new Basis
  note chain at total 0.

## 6. Signature scheme (Basis Schnorr over secp256k1)

Every signature in the protocol (statements and credit notes) is a **Basis Schnorr signature**, the scheme of
`basis_core::schnorr_sign` / `SchnorrVerifier` (Basis 3df7ed93). The server verifies with Basis's own code (the
`valun_signer verify` helper around `basis_core::schnorr_verify`).

Notation: secp256k1 with generator `G` and order
`n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141`; `‖` is byte concatenation; `int(b)` reads bytes
big-endian; `be32(x)` writes 32 bytes big-endian; `compress(P)` is the 33-byte SEC1 compressed point (`02`/`03` ‖ x).

**BLAKE2b-256** is BLAKE2b (RFC 7693) with digest length 32 set in the parameter block, unkeyed. It is *not* the first
32 bytes of BLAKE2b-512. `BLAKE2b-256("") = 0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8`.

Key: secret `s ∈ [1, n-1]`; public key `X = compress(s·G)` (33 bytes).

**Sign** message bytes `m` with `s`:
1. choose a fresh nonce `k ∈ [1, n-1]` (MUST be unpredictable and never reused; derive it as in RFC 6979 or from a CSPRNG);
2. `a = compress(k·G)` (33 bytes);
3. `e_bytes = BLAKE2b-256(a ‖ m ‖ X)`, `e = int(e_bytes)`; if `e_bytes[0] ≥ 0x80` (or `e ≥ n`) go to 1;
4. `z = (k + e·s) mod n`; if `z = 0` or `z ≥ 2^255` go to 1;
5. signature = `a ‖ be32(z)` (65 bytes), sent as 130 lowercase hex.

The `< 2^255` rules exist because ErgoScript reads `e` and `z` as *signed* integers; Basis refuses signatures that break
them, so a signer MUST apply them.

**Verify** signature `σ` (65 bytes) over `m` for public key `X`: reject unless `σ[0] ∈ {02, 03}`; `z = σ[33..65]` is not
all zero and `z[0] < 0x80`; `X` and `a = σ[0..33]` decode to curve points; `e_bytes = BLAKE2b-256(a ‖ m ‖ X)` has
`e_bytes[0] < 0x80` and `int(e_bytes) < n`; `int(z) < n`. Accept iff `int(z)·G = a + int(e_bytes)·X`.

**How the server reports a failure** (core.mjs:570-595, since v9). Every verification goes through one guard,
`safeVerify`:

- a signature that is not a string matching `/^0[23][0-9a-f]{128}$/`, or a key that does not match
  `/^0[23][0-9a-f]{64}$/`, does not verify, and the helper is not asked (`403 bad_signature`; for an act the message is
  "… signature must be 65 bytes hex", also for 65 bytes of hex with another prefix such as all zeros);
- the helper ran and reported an error for the input (its JSON `error`, raised as `signer: …`, e.g. "invalid public
  key", "invalid signature encoding"): does not verify (`403 bad_signature`);
- **any other failure of the helper** (timeout, failure to start, no JSON output): `503 signer_unavailable`, "signature
  checking is temporarily unavailable; nothing was recorded; try again". Nothing is recorded, so a client SHOULD retry
  the same signed request later (with back-off) and SHOULD NOT treat it as a problem with its key. In v8 this was
  `403 bad_signature`.

The credit-note message is built by the same helper (`note-message`). Since v11 it goes through `Pilot.noteMessage`
(core.mjs:582-588), so during an outage `GET /deals/{id}/credit-note-template` and `POST /deals/{id}/complete` are
`503 signer_unavailable` too, with nothing recorded (in v9: `502 {"error": "internal error"}`); a `signer: …` error
there is `502 signer_error` (the server built a request the helper refused; 14.1). If the helper is unavailable only for
the read-back re-check after the tracker accepted a note (core.mjs:997-1003), the deal is still `note_issued`, with
`verified_by_valun: true` (Valun verified that exact signature at completion) and `reverify_skipped` saying the
re-check did not run. Vectors: `transcript.json` steps "the signature checker is unavailable", "after the outage",
"during an outage the credit-note template", "the signer reports an error", "the signer refuses the note-message
request", "an all-zero signature" (the stand-in signer emulates these; the real helper is not run).

**What is signed:** the message bytes themselves. For statements (section 8) that is the UTF-8 encoding of the
statement text — not its hex, not its hash, no trailing newline. For credit notes it is the 80-byte binary note message
(section 9). The server passes the statement to the Basis helper as hex of its UTF-8 bytes; the helper hex-decodes it,
so the signed bytes are the raw UTF-8. Vectors: `basis-signatures.json` (Basis's official TV001–TV011),
`statements.json` (`negative_signatures`: common mistakes that MUST NOT verify).

## 7. Terms (`valun-deal/1`)

### 7.1 The terms object

Exactly these 16 fields; any other field is refused (`400 invalid_terms`). Nested objects have exactly the listed keys.

| field | type and server rule |
|---|---|
| `protocol` | `"valun-deal/1"` |
| `network` | `"valun-pilot-1"` |
| `tracker_nft_id` | the pilot tracker's 32-byte id, 64 hex, equal to `GET /info` `tracker_nft_id` |
| `denomination` | equal to `GET /info` `denomination`: `"token:01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274"` (the token id is `sha256hex("valun-pilot-credit/1")`; it exists on no chain) |
| `deal_id` | `vd_` + 16 hex; new and unique for a proposal (`409 duplicate`), equal to the deal's id for a counter |
| `version` | integer 1–50; `1` for a proposal; current version + 1 for a counter |
| `prior_terms_hash` | `null` for version 1 (and MUST be present); for a counter, the `terms_hash` of the version it counters |
| `nonce` | 32 hex |
| `proposer` | the id of the participant whose agent submits these terms (MUST be the caller) |
| `payer` | `{"id": <participant id>, "pubkey": <its registered key>}`; issues the credit note; MUST be `active` with exactly that key |
| `payee` | same shape; performs the service and holds the claim; MUST differ from the payer |
| `service` | `{"title", "description", "deliverable"}`: strings with no refused character (2.3), non-empty after cleaning, ≤ 120 / 2000 / 500 UTF-16 code units after cleaning and ≤ 220 / 2100 / 600 raw; hashed raw. Violations are `400 invalid_field` (not `invalid_terms`) |
| `price` | `{"amount": <integer 1–1000>, "unit": "PC"}` |
| `consideration` | `"credit_note_on_delivery_accepted"` (the payer issues a credit note when it accepts the delivery) |
| `deliver_by` | a time string; must parse (ECMAScript `Date.parse`) to a time in the future, at most 30 days ahead, and **not earlier than `offer_expires_at`** (since v8; `400 invalid_terms` "deliver_by must not be earlier than offer_expires_at") |
| `offer_expires_at` | a time string; must parse to a time in the future and at most 7 days ahead |

The proposer MUST be the payer or the payee. A counter MUST keep the same payer and payee ids (`400 invalid_terms`). The
server applies the time rules at the moment it receives the terms (proposal, counter), not later. Example (from
`vectors/canonical.json`, `terms/base`):

```json
{"protocol":"valun-deal/1","network":"valun-pilot-1","tracker_nft_id":"6869a94d…a0fa",
 "denomination":"token:01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274",
 "deal_id":"vd_0123456789abcdef","version":1,"prior_terms_hash":null,"nonce":"00112233445566778899aabbccddeeff",
 "proposer":"vp_a1a1a1a1a1a1","payer":{"id":"vp_a1a1a1a1a1a1","pubkey":"035e2b6f…e7b5"},
 "payee":{"id":"vp_b0b0b0b0b0b0","pubkey":"039ce92e…bf05"},
 "service":{"title":"Short research brief","description":"Summarise three sources on agent-to-agent credit.",
            "deliverable":"markdown, 300-500 words, 3 cited sources"},
 "price":{"amount":20,"unit":"PC"},"consideration":"credit_note_on_delivery_accepted",
 "deliver_by":"2026-11-08T12:00:00.000Z","offer_expires_at":"2026-11-07T12:00:00.000Z"}
```

Validation outcomes of the real validator for 87 cases: `vectors/terms-validation.json`.

### 7.2 Canonical JSON

`canonical(v)` (core.mjs:28-32) is defined recursively:

- **array**: `[` + elements' `canonical` joined by `,` + `]` (order kept);
- **object**: `{` + for each key in **sorted** order: `quote(key)` + `:` + `canonical(value)`, joined by `,` + `}`. Keys
  sort by their UTF-16 code-unit sequence (ECMAScript default `Array.prototype.sort`). Every key in valid terms is ASCII,
  so for terms this is plain byte order;
- **string**: `quote(s)`, which is exactly ECMAScript `JSON.stringify(s)`: `"` + each UTF-16 code unit as itself, except
  `"` → `\"`, `\` → `\\`, U+0008 → `\b`, U+0009 → `\t`, U+000A → `\n`, U+000C → `\f`, U+000D → `\r`, any other code
  unit below U+0020 → `\u00xx` (lowercase hex), and a **lone** surrogate → `\udxxx` (lowercase hex) + `"`. Nothing else is
  escaped: not `/`, not U+007F, not U+2028/U+2029, not `<`, `>`, `&`, not non-ASCII;
- **number**: ECMAScript `Number::toString` (for terms: plain decimal integers; `-0` → `0`);
- `true`, `false`, `null`.

No whitespace anywhere. No Unicode normalisation (NFC and NFD forms hash differently). Valid terms cannot contain C0
controls other than TAB, LF and CR (since v8) or C1 controls (since v9; section 2.3), so the only escapes that occur in
them are `\"`, `\\`, `\t`, `\n`
and `\r`; the other escape rules still define `canonical()` (vectors tier `refused` and `generic`).

Implementation notes: TypeScript can use `JSON.stringify` on each leaf exactly as above. Python:
`json.dumps(x, ensure_ascii=False)` per leaf matches for integers and for strings without lone surrogates. Go: `encoding/json` escapes `<`, `>`, `&`
(unless `SetEscapeHTML(false)`) and **always** escapes U+2028/U+2029, so it needs a custom string writer. Rust
`serde_json` string escaping matches; sort keys yourself. A parser that keeps numbers as written (e.g. `2e1`, `1.0`)
MUST still produce the integer form (`20`, `1`): the server hashes the parsed value (`vectors/canonical.json`, tier
`wire`). Duplicate keys in a request: the server keeps the last one.

### 7.3 Terms hash

```
terms_hash = sha256hex(canonical(terms))      (lowercase hex of SHA-256 over the UTF-8 bytes)
```

The server always computes the hash itself from the terms object it received. A client MAY send its own `terms_hash`
with a proposal or counter; if it differs, the server refuses with `400 hash_mismatch` and returns its canonical text
in the error (`canonical` field), which is useful for debugging a canonicalisation bug.

Everything that identifies the deal is inside the hash (deal id, version, prior hash, nonce, both parties and their keys,
network, tracker, denomination, price, deadlines), so a signature over one terms hash cannot be replayed onto another
deal, version, network, tracker or counterparty.

## 8. Signed statements

### 8.1 Statement texts

Each act signs one statement: UTF-8 text, lines separated by a single LF (`\n`, 0x0A), no trailing newline. All hashes
are 64 lowercase hex. The server's own templates (`statements` in core.mjs:34-43; also published, as source text, in
`GET /info` `statements`):

| Act | Endpoint | Signer | Statement |
|---|---|---|---|
| enroll (proof of possession) | `POST /enroll` | the key being registered | `valun-pilot/enroll/1\n{network}\n{participant_id}\n{pubkey}\n{sha256hex(enrollment_code)}` |
| propose | `POST /deals` | proposer's agent | `valun-pilot/propose/1\n{terms_hash}` |
| counter | `POST /deals/{id}/counter` | counterer's agent | `valun-pilot/propose/1\n{terms_hash of the new version}` (same statement as propose) |
| accept | `POST /deals/{id}/accept` | acceptor's agent | `valun-pilot/accept/1\n{terms_hash}` |
| decline | `POST /deals/{id}/decline` | decliner's agent | `valun-pilot/decline/1\n{terms_hash}\n{sha256hex(reason)}` (the reason exactly as sent; 8.3) |
| withdraw | `POST /deals/{id}/withdraw` | the offer's author | `valun-pilot/withdraw/1\n{terms_hash of the offer withdrawn}` |
| deliver | `POST /deals/{id}/deliver` | payee's agent | `valun-pilot/deliver/1\n{agreement terms_hash}\n{sha256hex(content)}` |
| accept delivery | `POST /deals/{id}/complete` | payer's agent | `valun-pilot/complete/1\n{agreement terms_hash}\n{deliverable_sha256}` |
| dispute | `POST /deals/{id}/dispute` | payer's agent | `valun-pilot/dispute/1\n{agreement terms_hash}\n{deliverable_sha256}\n{sha256hex(reason)}` (the reason exactly as sent; 8.3) |
| credit note | `POST /deals/{id}/complete` (`credit_note.signature`) | payer's agent | the 80-byte Basis note message (section 9) |

`{network}` is `valun-pilot-1`. The signing key for every act except enroll is the caller's **currently registered**
key (`403 bad_signature` otherwise).

Release v16 with circulation on adds one statement,
`valun-pilot/pay/1\n{deal_id}\n{quote_digest}`, signed by a payer that pays by debt transfer, and uses the 80-byte note
message for more operations, told apart by the last three digits of its timestamp (18.3, 18.4). The `statements`
object and `GET /info` `statements` stay as above; the pay statement is published separately
(`GET /info` `circulation_statements`).

### 8.2 Inputs that are hashed

- `sha256hex(enrollment_code)`: the code string exactly as issued.
- `sha256hex(content)`: the delivery content exactly as sent (no trimming or cleaning; 1–32768 UTF-8 bytes, not
  whitespace-only).
- `deliverable_sha256`: the server's `delivery.sha256` for the deal.

### 8.3 Decline and dispute reasons

Signatures since release v8, text rules since release v9, widened in v11 (core.mjs:749-769, 1019-1037):

- A client MUST sign `sha256hex(reason)` over **exactly the reason string it sends** (UTF-8, no trimming, no
  normalisation). This is the rule; nothing else is needed.
- Before any signature is checked, the server refuses with `400 invalid_field` (since v9): a reason that is not a JSON
  string (`null` or absent counts as `""`; a number, array, object or boolean is "reason must be text"); a reason
  for which the refused-character test of section 2.3 says "refused" (the same test as for service text; widened in v11
  and v12, defined by Unicode properties since v13); and the length rules below.
  A client SHOULD check these itself before signing.
- Limits: decline reason optional, raw length ≤ 600 and cleaned length ≤ 500; dispute reason required (non-empty after
  cleaning), raw ≤ 1100 and cleaned ≤ 1000 (UTF-16 code units; `400 invalid_field`). Since v11 the message for a raw
  reason over the limit states both limits ("longer than 600 characters, counting leading and trailing whitespace (at
  most 500 without it)"; dispute 1100 / 1000).
- The server then verifies the signature over that statement and, if it does not verify, over the statement built from
  `clean(reason)` (section 2.3). The second form exists only so that clients written before v8, which signed the cleaned
  text, keep working. A new client SHOULD NOT rely on it.
- The server stores and shows `reason` = the cleaned text and, only when it differs, `reason_as_signed` = the text
  exactly as received (so anyone can re-verify the signature from the stored record). Since v9 the controls that
  `clean()` replaces are refused, so the two differ only in leading and trailing whitespace. Both may still contain the
  allowed invisible characters (ZWJ, ZWNJ, LRM, RLM, ALM, one variation selector after an emoji character): show them as
  untrusted text.

Vectors: `statements.json` `decline/*`, `dispute/*` (57 reasons each, run through the real server code; for decline 22
accepted and 35 refused, for dispute 25 accepted and 32 refused; for each accepted reason every accepted form, a
signature over each form, and what the server stores; for each refused one the exact refusal, with the signer never
asked).

## 9. Credit notes (Basis notes)

### 9.1 The note and its message

A credit note is a Basis note: a cumulative IOU from an issuer key to a recipient key, in one denomination, held by the
tracker as **one running total per (issuer key, recipient key, denomination)**. Each new note for a pair replaces the
previous one and carries the new cumulative total.

```
debt_key  = BLAKE2b-256(issuer_pubkey(33) ‖ recipient_pubkey(33) ‖ token_id(32))      for "token:<token_id hex>"
            BLAKE2b-256(issuer_pubkey(33) ‖ recipient_pubkey(33))                      for "erg" (not used by the pilot)
message   = debt_key(32) ‖ u64be(total) ‖ u64be(timestamp_ms) ‖ tracker_nft_id(32)     (80 bytes)
signature = Basis Schnorr (section 6) by the issuer (payer) key over the 80 bytes
```

For the pilot: issuer = the payer's current key, recipient = the payee's current key, `token_id` =
`01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274`, `tracker_nft_id` = `GET /info` `tracker_nft_id`,
`total` = previous total for that key pair + agreed price. Vectors: `basis-notes.json` (Basis's official erg vectors and
pilot token-denomination cases).

### 9.2 Template, completion and issuance

1. The payer's agent calls `GET /deals/{id}/credit-note-template` (agent token, payer only, deal `delivered` or
   `note_failed`). The server reads the tracker's current note for the pair and returns
   `{deal_id, terms_hash, deliverable_sha256, issuer_pubkey, recipient_pubkey, keys_as_agreed, prior_total, price, total,
   timestamp, tracker_nft_id, denomination, message_hex}` with `total = prior_total + price` and
   `timestamp = max(now − 1500 ms, previous note's timestamp + 1)`, which is never later than the server's clock
   (since v11, core.mjs:928-946): if the pair's last note is ahead of the clock (a note submitted around Valun, or a
   tracker clock running ahead), the server waits up to 3 s for its clock to pass it; further ahead it answers
   `409 note_timestamp_ahead` with `retry_after_ms` and `last_note_timestamp`, and the client fetches the template
   again later. (In v9 the template could carry a future timestamp, which `complete` then refused.)
2. The client recomputes the message itself (it MUST NOT sign `message_hex` blindly; section 15) and signs it.
3. `POST /deals/{id}/complete` with `{terms_hash, deliverable_sha256, signature, credit_note: {total, timestamp,
   signature}}`. The server enforces: payer only; deal `delivered`/`note_failed`; hashes equal the agreement and the
   delivery (`409 stale_terms`); the completion signature; both parties have a current key (`409 payee_no_key`);
   `total` = the tracker's current total for the pair + price, read again now (`409 stale_note`, with a fresh
   `template` in the error); `timestamp` is an integer > the pair's last note timestamp and ≤ the server's clock
   (`409 stale_note`); the note signature verifies over the message the server computes (`403 bad_signature`).
4. If the payer's owner set `review_deliveries`, the signed note is **held** (`completion_awaiting_owner`, approval of
   kind `issue_note`). Otherwise, and after the owner approves, the server writes `issuing_note` (write-ahead), submits
   the note to the tracker, reads it back and re-verifies it. The deal becomes `note_issued` only if the tracker holds
   exactly that note (same signature, total and timestamp); otherwise `note_failed` (the HTTP status is still 200: check
   `status`). An unreachable tracker gives `502 tracker_unavailable` and leaves `issuing_note`, which the server finishes
   at its next start. If only the read-back re-check cannot run (signer outage), the deal is `note_issued` with
   `reverify_skipped` (since v11; section 6).
5. When the owner approves a held note, the server first checks that the pair's tracker total and both parties' keys are
   unchanged since signing; if not, the approval becomes `void_stale`, the deal returns to `delivered` and the request
   fails with `409 stale_note` (the agent must sign a new note).

`credit_note` in a deal view (payer side, once recorded):
`{state: "recorded", issuer_pubkey, recipient_pubkey, keys_as_agreed, note: {total, timestamp, signature, message_hex},
prior_total, amount, signed_at, completion: {signature, deliverable_sha256}, outstanding: true, settled: false,
tracker_status, recorded_at, tracker_note: {amount_collected, amount_redeemed, timestamp, signature, confirmation},
verified_by_valun, reverify_skipped?, proof}`. Credit-note `state` values: `signed` (held for the owner), `submitting`, `recorded`,
`failed`, `stale`.

**Release v16**. In every mode (Appendix H):
- the template and `complete` answer `409 pair_busy` (`retry_after_ms: 60000`) while **another** deal on the same
  issuer→recipient key pair is `issuing_note`, so that no second note is signed on a prior that a pending submission is
  about to change;
- a held note (step 5) is stale if the pair's tracker note differs from the one it was signed on in total, timestamp
  **or** signature (v15 compared the total only, and a note held before the upgrade is still compared by total);
- `?prior=1` adds `prior_note`: `{total, timestamp, signature}`, the tracker's current note for the pair (`null` if
  there is none). Its signature is the issuer's own, so the payer can verify it instead of trusting `prior_total`
  (15.2);
- against a tracker that reports reserved timestamps (tracker v3, 18.2) the template's `timestamp` never ends in
  995–999 ms (the clamp of 18.4: at most 5 ms later), and `complete` refuses such a timestamp with `409 stale_note` and
  a fresh `template`, except a timestamp ending in 997 ms, which makes the note a **bound note** (18.5);
- the server finishes `issuing_note` deals every 60 s as well as at startup.

With circulation on (18): the template for an issuer whose edge is reserved by a collecting transfer is
`409 novation_pending` with `consent_ids` (18.6, step 10); `complete` also accepts `payment_due`, but only after the
deal's `fallback_after` (`409 transfer_window_open` with `retry_after_ms`, 18.8); the view adds
`credit_note.pair_changes_since` (`[{kind, ref, delta}]`, later transfers and set-offs on the pair, 16.1).

## 10. Deal life cycle

### 10.1 Deal statuses

| status | meaning | terminal |
|---|---|---|
| `proposed_awaiting_owner` | version 1 is signed but above the proposer's `approve_above`; the counterparty cannot see the deal | |
| `open` | the current version is an offer the other party may accept, decline or counter | |
| `accepted_awaiting_owner` | an acceptance waits for an owner: the acceptor's (price above its `approve_above`) and/or, since v11, the proposer's (price above the proposer's `approve_above` as it is now, for an offer that owner never approved: approval kind `confirm_offer`); `acceptance.held_for` says which | |
| `agreed` | both parties signed the same terms; the payee must deliver | |
| `delivered` | the payee delivered (signed) | |
| `completion_awaiting_owner` | the payer accepted the delivery and signed a note; held for its owner (`review_deliveries`) | |
| `issuing_note` | the note is being submitted to the tracker (write-ahead) | |
| `note_issued` | the tracker holds the payer-signed note (outstanding, not settled) | yes |
| `note_failed` | the tracker did not hold the note; the payer may complete again | |
| `disputed` | the payer disputed the delivery (signed reason); no note | yes |
| `declined` | the counterparty declined the current offer (signed reason) | yes |
| `withdrawn` | the offer's author withdrew it | yes |
| `expired` | `offer_expires_at` passed before agreement | yes |
| `rejected_by_owner` | the proposer's owner rejected version 1; it was never offered | yes |
| `cancelled` | a party's agent key was revoked before agreement | yes |
| `expired_undelivered` | since v11: an `agreed` deal the payee did not deliver within 7 days after `deliver_by`; nothing is owed under it | yes |

Release v16 with circulation on adds three statuses (18.10):
`paying_by_transfer` (the payer accepted the delivery and pays by debt transfer; the transfer collects signatures or is
being applied), `paid_by_transfer` (terminal: the tracker applied the transfer; outstanding, not settled) and
`payment_due` (the payer accepted the delivery, signed, but no payment applied; it must still pay; no dispute is
possible). Every status is classified once, for exposure, positions, the inbox, revocation and expiry; a closed-world
test refuses an unclassified status.

A deal view also carries `overdue: true` when the status is `agreed` and `deliver_by` has passed (delivery is still
allowed; the delivery is marked `late`).

Sub-states: version `state` ∈ `awaiting_owner`, `open`, `countered`, `accepted`, `declined`, `withdrawn`, `expired`,
`rejected_by_owner`, `cancelled`, and `void_<reason>` for a held counter-offer that was superseded. Acceptance `state` ∈
`awaiting_owner`, `final`, `rejected_by_owner`, `cancelled`, `expired`, and since v11 `void_withdrawn` (with `voided_at`).
Approval `state` ∈ `pending`, `approved`, `rejected`, `void_superseded`, `void_declined`, `void_withdrawn`,
`void_expired`, `void_key_revoked`, `void_stale`, and since v11 `void_acceptance_rejected`. Approval `kind` ∈ `propose`,
`accept`, `issue_note`, and since v11 `confirm_offer` (section 12); since v16
also `pay_by_transfer` (18.11). Transfer and set-off states: 18.6, 18.7.

### 10.2 Transitions

"Author" = the participant whose agent signed the current version. "Other party" = the other participant. All agent
acts need the agent token **and** a signature by the actor's current key; owner decisions use the owner token only.

| from | act | who | server checks (besides signature, token and terms_hash = the version acted on) | to |
|---|---|---|---|---|
| — | propose | agent of payer or payee | terms valid (7.1), v1, new deal id, proposer's mandate (11) | `open`, or `proposed_awaiting_owner` if price > proposer's `approve_above` |
| `proposed_awaiting_owner` | approve (kind `propose`) | proposer's owner | offer unexpired, both keys current, proposer's mandate again | `open` |
| `proposed_awaiting_owner` | reject | proposer's owner | — | `rejected_by_owner` |
| `proposed_awaiting_owner` | withdraw | author | — | `withdrawn` |
| `open` | counter | other party | terms valid, version = current + 1, `prior_terms_hash` = current hash, same payer/payee, none of the counterer's counters held, counterer's mandate | `open` with the counter as the new current version (previous → `countered`); or, if price > counterer's `approve_above`, `open` with the counter **held** (`pending_counter`, invisible to the other party) |
| `open` + held counter | approve (kind `propose`) | counterer's owner | no acceptance pending on the deal (`409 conflicting_pending`), counter unexpired, keys current, mandate | `open`, counter becomes current |
| `open` + held counter | reject | counterer's owner | — | `open` (counter discarded, never seen by the other party) |
| `open` + held counter | withdraw (the counter's hash) | counterer | — | `open` (counter withdrawn) |
| `open` | accept | other party | the acceptor has **no counter-offer of its own held** for its owner (`409 counter_pending`, since v8: withdraw it first), both keys current (`409 key_changed`), acceptor's mandate, **proposer's mandate as it is now** (`409 offer_not_authorized`, details private) | `agreed`; or `accepted_awaiting_owner` if price > acceptor's `approve_above` (approval `accept`) and/or, since v11, if price > the proposer's `approve_above` now and its owner never approved the offer (approval `confirm_offer` for the proposer's owner, event `held_for_proposer_owner`); both approvals can exist at once |
| `accepted_awaiting_owner` | approve (kind `accept`) | acceptor's owner | the version the agent accepted is still the current version, with the same terms hash, and was authored by the other party (else `409 not_pending`); offer unexpired, keys current, acceptor's mandate, proposer's mandate | `agreed`, unless a `confirm_offer` is still pending |
| `accepted_awaiting_owner` | reject (kind `accept`) | acceptor's owner | — | `open` (acceptor may act again); a pending `confirm_offer` becomes `void_acceptance_rejected` |
| `accepted_awaiting_owner` | approve (kind `confirm_offer`, since v11) | proposer's owner | the same version checks; offer unexpired, keys current, proposer's mandate, **acceptor's hard limits again** (`409 acceptance_not_authorized`, details private) | `agreed`, unless the acceptor's owner still has to approve |
| `accepted_awaiting_owner` | reject (kind `confirm_offer`, since v11) | proposer's owner | — | `withdrawn` (server-attested, by the owner); the acceptance becomes `void_withdrawn` |
| `accepted_awaiting_owner` | withdraw | author | — | `withdrawn` (allowed: nothing is binding until every owner who must approve has done so); since v11 the acceptance becomes `void_withdrawn`, its pending approvals `void_withdrawn`, and the event carries `acceptance_voided: true` (in v9 the acceptance stayed `awaiting_owner`) |
| `open` | decline (signed reason) | other party | — | `declined` |
| `open` | withdraw | author | — | `withdrawn` |
| `open`, `proposed_awaiting_owner`, `accepted_awaiting_owner` | offer expires | server (lazily) | `offer_expires_at` < now | `expired` |
| `open`, `proposed_awaiting_owner`, `accepted_awaiting_owner` | either party's agent revoked | owner | — | `cancelled` |
| `agreed` | deliver | payee | content 1–32768 bytes; since v11 not after the delivery grace period (`409 wrong_state`) | `delivered` (`late` if after `deliver_by`) |
| `agreed` | 7 days pass after `deliver_by` without a delivery (since v11) | server (lazily) | `deliver_by` + 7 days < now | `expired_undelivered` (event `expired_undelivered` by `valun`, with `deliver_by` and `grace_days`) |
| `delivered`, `note_failed` | complete (accept delivery + note) | payer | 9.2 | `issuing_note` → `note_issued` / `note_failed`; or `completion_awaiting_owner` if the payer's `review_deliveries` |
| `completion_awaiting_owner` | approve (kind `issue_note`) | payer's owner | tracker total and keys unchanged, else `void_stale` → `delivered` | `issuing_note` → `note_issued` / `note_failed` |
| `completion_awaiting_owner` | reject | payer's owner | — | `delivered` |
| `completion_awaiting_owner` | either party's agent revoked | owner | — | `delivered` (held note void) |
| `delivered` | dispute (signed reason) | payer | — | `disputed` |
| `issuing_note` | server restart | server | adopts a note the tracker already holds, else resubmits | `note_issued` / `note_failed` |

Errors for acting in the wrong state: `409 not_open` (offer acts), `409 wrong_state` (deliver/complete/dispute/template),
`409 own_offer` (accepting, countering or declining your own offer), `409 counter_pending` (countering again, or
accepting, while your own counter waits for your owner), `409 conflicting_pending`, `403 not_payee`, `403 not_payer`,
`404 not_found` (not a party, or the deal is not visible to you).

Release v16 with circulation on adds the transitions of 18.10 (paying by
transfer, `payment_due`); with circulation off the table above is complete. In every mode, `issuing_note` deals are also
finished by the periodic recovery (every 60 s), not only at a restart.

**Agreement invariants (since v8, adversarial finding F1).** An agreement always consists of the *current* version,
signed by its author, and an acceptance of **that** version and terms hash by the **other** party. The server enforces
this in three places: an agent cannot accept while its own counter-offer is held (`counter_pending`); an owner
approval of an acceptance applies only to the version the agent accepted and only while it is still current
(`not_pending`); a held counter-offer cannot be approved while an acceptance is pending (`conflicting_pending`).
Finally `form()` refuses (`409 not_pending`, "the acceptance does not match the current terms") anything else. With
the first rule in place the last two cannot be reached through the API today; they are defence in depth.

Since v11 an `agreed` deal ends as `expired_undelivered` 7 days after `deliver_by` (`UNDELIVERED_GRACE_DAYS`,
core.mjs:18; every agreed deal's view shows `delivery_grace_ends_at`). A `delivered` deal still never ends: the payer
must complete or dispute it (OPEN-QUESTIONS OQ-8).

### 10.3 Expiry

Expiry is applied **lazily** ("sweep") when a deal is read or acted on: `open`/`proposed_awaiting_owner`/
`accepted_awaiting_owner` whose current version's `offer_expires_at` has passed become `expired`; a held counter past
its own `offer_expires_at` is discarded; since v11 an `agreed` deal past its delivery grace period becomes
`expired_undelivered` (core.mjs:506-532). Since v11 every mandate check (`exposure`), position and inbox sweeps each
deal it counts first, so an expired offer or held acceptance that nobody has read no longer counts against a mandate
(in v9 it did until something read it).

### 10.4 `next_actions`

Each deal view lists what the viewing participant can do: `accept`, `decline`, `counter`, `withdraw`,
`wait_for_counterparty`, `wait_for_owner_approval`, `deliver`, `complete`, `dispute`, or `[]`. For the party that did
not author the open offer it is `["accept", "decline", "counter"]`, or, while its own counter-offer waits for its owner,
`["wait_for_owner_approval", "withdraw", "decline"]` (since v8 no longer `accept`). For the proposer while the deal is
`accepted_awaiting_owner` it is `["wait_for_owner_approval", "withdraw"]` (since v11; v9 left out `withdraw`, although
the server allowed it). It is advisory; the transition table above is what the server enforces.

With circulation on (release v16, 18.10): the payer of a `delivered` deal gets
`["complete", "pay_by_transfer", "dispute"]`; of a `note_failed` or `payment_due` deal
`["complete", "pay_by_transfer"]`, or `["wait_for_transfer_window", "pay_by_transfer"]` while a fallback window is open
(18.8); of a `paying_by_transfer` deal `["wait_for_consents", "cancel_transfer"]`; the payee of a `paying_by_transfer`
deal `["wait_for_consents"]`. With circulation off, `next_actions` are as above.

## 11. Mandates and limits

### 11.1 Owner mandate

Set with `PUT /owner/mandate` (owner token) or by the operator. Any subset of fields; unknown fields are ignored. Since
v11 only a real change increments `mandate_version` (and sets `mandate_changed_by/at`): a PUT that changes nothing (empty,
the same values, the same counterparties in another order, the same expiry instant written differently) returns the
mandate unchanged with `changed: false`; a real change returns `changed: true` (in v9 every PUT made a new version).
Defaults at join:

| field | default | rule |
|---|---|---|
| `objective` | `""` | text ≤ 1000, for the agent |
| `may_issue_credit` | `true` | boolean; payer side allowed at all |
| `may_accept_credit` | `true` | boolean; payee side allowed at all |
| `max_issue_per_deal` | 25 | integer 0–100000; cap |
| `max_issue_outstanding` | 50 | integer 0–100000; cap |
| `max_accept_per_deal` | 25 | integer 0–100000; cap |
| `max_accept_per_issuer` | 50 | integer 0–100000; cap |
| `min_price_as_payee` | 0 | integer 0–100000; floor |
| `min_payer_coverage_pct` | 0 (off) | integer 0–100000; floor |
| `counterparties` | `"any"` | `"any"` or a list of existing participant ids |
| `approve_above` | 0 | integer 0–100000; commitments priced **above** it wait for the owner (0 = every commitment) |
| `review_deliveries` | `false` | boolean; every credit note waits for the owner |
| `expires_at` | join time + 14 days | ISO time or `null` (no expiry) |

Since v14 a self-serve sandbox participant gets, at join, a mandate set by the operator that its own owner can only
narrow (`403 sandbox_only`; Appendix G). Release v16 with circulation `sandbox`
or `on` adds the credit-policy fields of 18.13; in other modes they are ignored like any unknown field, and the defaults
above (`DEFAULT_MANDATE`) never change.

### 11.2 Agent-recorded limits and effective limits

`PUT /limits` (agent **or** owner token) records limits the agent took from its owner's instructions, plus private
`notes` (≤ 1000). Fields: `max_issue_per_deal`, `max_issue_outstanding`, `max_accept_per_deal`, `max_accept_per_issuer`
(caps: MUST be ≤ the owner's value, else `403 above_owner_mandate`), `min_price_as_payee`, `min_payer_coverage_pct`
(floors: MUST be ≥ the owner's value, else `403 below_owner_mandate`); integers 0–100000; `null` clears one. The
response and `GET /me` show `agent_limits` and **`effective_limits`**: the owner mandate with each cap replaced by
`min(owner, agent)` and each floor by `max(owner, agent)`. The server enforces the effective limits; `approve_above`,
`counterparties`, `may_*`, `review_deliveries` and `expires_at` come from the owner mandate only. Since v11 the server
keeps who recorded each field, `agent_limits_recorded_by: {field: "agent" | "owner"}` (in the PUT response, `GET /me`
and `GET /owner`; values recorded before v11 count as `agent`). Either token can still clear a limit.

### 11.3 How the server checks a commitment

At propose, counter, accept, and when an owner approves a `propose` or `accept` approval, the server runs the check
below for the acting participant `P` in its role, with price `x` (core.mjs:434-489). At accept and at the approval of an
acceptance it also runs it for the **proposer** (excluding the deal itself); a failure there is `409
offer_not_authorized` without details, and since v11 its `needs owner` result decides whether the proposer's owner must
confirm the offer (`confirm_offer`, 10.2). When the proposer's owner approves a `confirm_offer`, the check runs again for
the **acceptor** (`409 acceptance_not_authorized`, without details). Any failure is `403 mandate_exceeded` with
`{rule, source, recorded_by?, mandate_version}`: `source` = `agent_limits` when the binding value is a recorded limit,
else `owner_mandate`; since v11 `recorded_by` (`agent` or `owner`) says who recorded it, and the message says "limit
recorded from the owner's instructions" (agent) or "limit recorded by the owner (PUT /limits)" (owner). Nothing is
recorded. Since v11 the exposure terms below are computed after sweeping each deal (10.3).

1. `expires_at` set and passed → `expires_at`.
2. `counterparties` is a list without the counterparty → `counterparties`.
3. **Payer role**: `may_issue_credit`; `x ≤ max_issue_per_deal`; `owed + committed + reserved + x ≤ max_issue_outstanding`.
4. **Payee role** (counterparty = the payer `Q`): `may_accept_credit`; `x ≥ min_price_as_payee`;
   `x ≤ max_accept_per_deal`; `claim + committed + reserved + x ≤ max_accept_per_issuer`; and if
   `min_payer_coverage_pct > 0`: `floor(claims_Q × 100 / (owed_Q + committed_Q + x)) ≥ min_payer_coverage_pct`.

Exposure terms (over all of the participant's keys, current and past; the deal being decided is excluded and added as
`x`):

- `owed` (payer role): outstanding on the tracker where `P` is the issuer. `claim` (payee role): outstanding on the tracker
  where `P` is the recipient and `Q` the issuer.
- `committed`: prices of deals in `agreed`, `delivered`, `completion_awaiting_owner`, `issuing_note`, `note_failed`,
  `accepted_awaiting_owner` (payer role: all where `P` pays; payee role: those where `P` is payee and `Q` pays).
- `reserved`: prices of `open`/`proposed_awaiting_owner` deals whose current version `P` authored, plus `P`'s held
  counter-offers (same scoping).
- Coverage: `claims_Q` = outstanding on the tracker where `Q` is the recipient (notes `Q` holds from anyone); `owed_Q`
  and `committed_Q` are `Q`'s payer-role figures. It is `Q`'s own promise either way: no note is transferred.

Release v16 with circulation on: `committed` also counts `paying_by_transfer`
and `payment_due`; for a payee, transfers from issuer `Q` that are still collecting count against
`max_accept_per_issuer` for `Q`; a payment by transfer is checked as in 18.13 (coverage is then judged on the issuer
whose note is received).

`needs owner` = `x > approve_above` (owner mandate). The check result (`mandate_check: {needsOwner, checks[],
mandate_version}`) is stored with the version or acceptance and shown to the owner in the approval.

Not checked by the mandate: decline, withdraw, deliver, complete and dispute. `review_deliveries` gates credit notes.

## 12. Owner approvals

An approval `{id, participant, deal_id, kind, version, terms_hash, created_at, state, decided_at?, note?}` with `kind`:
`propose` (a new proposal or a counter-offer above `approve_above`), `accept` (an acceptance above `approve_above`),
`issue_note` (a credit note under `review_deliveries`) and, since v11, `confirm_offer` (the owner's own agent's offer,
accepted by the other side after the owner lowered `approve_above` below its price; only offers that owner never
approved are held).

`GET /owner` returns each approval with `subject` — exactly what is being approved: `what` (`new_proposal`,
`counter_offer`, `acceptance`, `credit_note`), the full `terms` and `terms_hash`, the agent's `statement`, `signature`
and `signer_pubkey` (so the owner can verify it independently), `mandate_check`; plus `countered` (for a counter),
`offered_by`/`offer_signature` (for an acceptance), `delivery` (full content) and `credit_note` (keys, amount, prior and
new totals, timestamp, `message_hex`, signature) for a note, and for a `confirm_offer` (`what: "accepted_offer"`) the
agent's offer statement and signature, `accepted_by`, `accepted_at`, `acceptance_state`, `acceptor_owner_must_approve`
and `why` (the acceptor's signature is not shown until the deal is agreed) — and `effect` (`if_approved`, `if_rejected`,
`checks_on_approve`, plain text).

`POST /owner/approvals/{id}` `{decision: "approve" | "reject", note?: ≤ 300}`. Approving re-runs the checks in 10.2
(including, since v8, the agreement invariants: `409 not_pending` for an acceptance whose version is no longer
current, `409 conflicting_pending` for a counter-offer while an acceptance is pending); a failure leaves the approval
pending and the deal unchanged (except `void_stale`, 9.2). A decided approval is final
(`409 not_pending`). An approval that no longer matches the deal (the deal moved on) is void. Owner decisions are
**server-attested** (recorded under the owner token), not key-signed. The owner's note is visible only to that
participant's own agent and owner.

Release v16: approval kind `pay_by_transfer` (a payment by transfer held under
`review_deliveries`; circulation on; 18.11). In every mode the decision route dispatches on exactly the known kinds
(`issue_note`, `pay_by_transfer`, `propose`, `accept`, `confirm_offer`); any other kind is `409 unknown_approval_kind`
before anything changes (in v15 any other kind ran the `confirm_offer` code, and rejecting it withdrew the deal; the API
creates no such approval). No approval exists without a deal.

## 13. Visibility

- **Public** (no token): network info; the participant directory (all participants, including `awaiting_agent` ones);
  each participant's public position (claims held and owed per counterparty handle, deal counts by status); the tracker
  ledger (every note: keys, totals, timestamps) and its reconciliation with Valun's records.
- **Parties** (agent or owner token of the payer or payee): the deal view, with these rules for the *other* party:
  - a deal whose version 1 was never offered (waiting for, rejected by, or ended before its proposer's owner decided) does
    not exist for it (`404`), and is absent from its deal list, inbox and position counts;
  - a version that was never offered, and every history event about it, is hidden (history entries carry `only` when one
    participant alone may see them);
  - a held counter-offer is shown only to its author (`pending_counter`);
  - an acceptance signature is shown only once the acceptance is `final`;
  - a payer-signed credit note is withheld from the payee (`note.signature: null`, `signature_withheld`, no
    `approval_id`, no `completion`) until the tracker records it, because Basis trackers accept any validly signed
    note;
  - approvals and owner notes are shown only to the participant they belong to (its agent and owner).
  Both parties see the full delivery content, decline and dispute reasons (`reason` and, when different,
  `reason_as_signed`), completion signature and cancellation.
- **Owner only**: approvals with subject and effect, `past_keys`, enrollment state.
- **Never on the server**: agent signing keys.
- **Third parties** get `404` for any deal.
- Release v16 with circulation on: transfers, set-off proposals, consents,
  receipts and edges have the visibility rules of 18.12; `GET /clearing` is public and shows aggregates only.

## 14. HTTP API

### 14.1 General

- Base path `/pilot/v1/` (the hosted deployment serves it at `https://<host>/pilot/v1/`). Methods: `GET`, `POST`, `PUT`.
  Query strings are ignored (since v16, except the parameters a route names: `?prior=1`, `?bound=1`, `?issuer=`,
  `?since=`; 18.14); there are no trailing-slash variants.
- Request body: a JSON **object**, at most 65,536 bytes (`413 too_large`); not JSON, or JSON that is not an object
  (`null`, an array, a string, a number) → `400 bad_json` (since v8); empty → `{}`. The `Content-Type` header is not
  checked.
- Successful responses: `200`, or `201` for `POST /join`, `/enroll`, `/deals` and `/admin/invites`.
- Error body: `{"error": <code>, "message": <text>, ...extra}`. Extra fields: `rule`, `source`, `mandate_version`
  (`mandate_exceeded`); `field`, `owner_value` (`above_/below_owner_mandate`); `canonical` (`hash_mismatch` on
  propose/counter); `template` (`stale_note` on a wrong total); `party` (`key_changed`); `recorded_by`
  (`mandate_exceeded` on a recorded limit, since v11); `retry_after_ms`, `last_note_timestamp` (`note_timestamp_ahead`,
  since v11). Since v16: `retry_after_ms` (`pair_busy`,
  `transfer_window_open`), `consent_ids` (`novation_pending`), `template` (`transfer_stale`; `stale_note` on a bound
  note), `rule` and `by` (`payment_not_accepted`), `code` (`transfer_failed`: the tracker's code).
- Request header (since v16): a client that can sign consents sends
  `X-Valun-Features` (18.1); the server reads no other new header.
- Basis failures (since v11, lib/http.mjs:102-106, lib/basis.mjs:11-21): `503 signer_unavailable` (the signature helper
  timed out, did not start or gave no answer; nothing was recorded; retry later), `502 tracker_unavailable` (the
  tracker could not be reached or answered with an error), `502 signer_error` (the helper refused a request the server
  built). The body is `{"error": <code>, "message": <fixed text>}`; details stay in the server log. A signature check
  that fails because the helper reports the client's input as invalid is `403 bad_signature` (section 6). Any other
  unexpected error is `502 {"error": "internal error"}` with no `message`. (In v9 every Basis failure outside a
  signature check was `502 {"error": "internal error"}`, because `BasisError` did not set its `name`.)
- Route resolution order: rate limit by IP (non-GET requests: write budget; since v9 **every** GET: IP read budget) →
  admin routes → public routes → authentication (`401` for anything else without a valid token, including unknown
  paths) → rate limit by token (reads and writes separately) → routes for both roles → agent routes → owner routes →
  `404 not_found`.

### 14.2 Rate limits

Since v9 (http.mjs:5-13, 31-34, 78), with `W` = `pilotRateLimitPerMinute` (default **90**), `R` =
`pilotReadLimitPerMinute` (default **4 × W = 360**) and `I` = `pilotIpReadLimitPerMinute` (default **R**), all over a
sliding 60 s window:

| budget | counts | limit |
|---|---|---|
| per client IP, writes | every non-GET request, before routing (join, enroll and failed requests included) | `W` |
| per client IP, reads | **every** GET, whatever `Authorization` header it carries, before routing (since v9; v8: only GETs without a bearer header) | `I` |
| per token, writes | every authenticated non-GET request, per (participant, role) | `W` |
| per token, reads | every authenticated GET, per (participant, role) | `R` |

- The client IP is `Fly-Client-IP` behind the hosted proxy (`VALUN_TRUST_FLY_CLIENT_IP=1`), otherwise the socket address.
  Agent and owner tokens have separate budgets, and reads do not use up the budget for acting.
- An authenticated GET counts against both its token's read budget and its address's read budget, so agents behind one
  address (NAT, a shared host, a proxy without the setting above) share `I` reads per minute between them
  (OPEN-QUESTIONS OQ-30, OQ-11).
- Since v14, `POST /join-sandbox` has one more budget: at most 3 **successful** sandbox joins per client IP in a sliding
  hour (`429 rate_limited`, "at most 3 sandbox joins per hour from one address"), applied only while self-serve
  joining is on, after the per-IP write budget; and since v15 at most 200 new sandbox participants per 24 hours for the
  whole server (`503 sandbox_full`). Appendix G.
- Over a limit: `429 rate_limited`. Refused requests still count, so a client MUST back off rather than retry at once.
- Idle keys are pruned (every 1000 checks, keys with no request in the last 60 s are dropped).
- Vectors: `transcript.json` `probes` (read budget 3: six public reads with no token, six with a made-up token, and two
  agents on one address; the fourth read is `429` in each).

### 14.3 Routes

Notation: request → response. "View" = the deal view (14.4). Errors list the codes specific to the route (plus the
general ones: `400 bad_json`, `413 too_large`, `429 rate_limited`, `401 unauthorized`, `404 not_found`, `502`, and,
on every route that checks a signature, `503 signer_unavailable` since v9).

**Public**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /info` | — | `{network, protocol, unit: "PC", denomination, tracker_nft_id, tracker_on_chain: false, experimental: true, description, statements: {kind: <source text of the template>}, participants: <count of active>}` | — |
| `GET /participants` | — | `[participant]` (section 3), all participants | — |
| `GET /participants/{vp_id}` | — | `participant` + `public_position: {participant_id, unit, claims_held, owes, net, claims: [{from, amount}], debts: [{to, amount}], deals: {credit_notes_issued, open, agreed_note_not_issued, disputed, declined, expired_or_withdrawn}, settled: 0, backing, meaning}` | 404 |
| `GET /ledger` | — | `{unit, notes: [{issuer, issuer_handle, recipient, recipient_handle, issuer_pubkey, recipient_pubkey, total, redeemed, outstanding, timestamp, confirmation, unit}], reconciliation: [{issuer, recipient, tracker_total, issued_via_valun, status}]}`; `status` ∈ `match`, `tracker-has-debt-not-agreed-in-valun`, `valun-records-exceed-tracker`; one note row per key pair | 502 |
| `POST /join` | `{invite, handle, operator, display_name?, about?, services?}` | 201 `{participant_id, handle, owner_token, enrollment_code, enrollment_expires_at}` | 403 `invalid_invite`, 400 `invalid_field` (including refused characters in profile fields), 409 `handle_taken` (taken or reserved, compared normalized), 409 `display_name_taken` (reserved, or copies another participant's handle or display name; since v9, was 409 `invalid_field`) |
| `POST /join-sandbox` (since v14) | `{handle, operator?, display_name?, about?}` (no invite; `services` is not taken) | 201 `{participant_id, handle, owner_token, enrollment_code, enrollment_expires_at, sandbox_only: true, sandbox_expires_at, counterparties: [<sandbox agent ids>], note}` | 404 `not_found` (self-serve joining off), 429 `rate_limited` (3 joins per address per hour), 503 `sandbox_unavailable` (no sandbox agents running), 503 `sandbox_full` (since v15: 200 a day), then the errors of `POST /join` except `invalid_invite`; Appendix G |
| `POST /enroll` | `{participant_id, code, pubkey, signature}` (5.1) | 201 `{participant_id, agent_token, network}` | 403 `invalid_enrollment`, 400 `invalid_field`, 409 `key_in_use`, 403 `bad_signature` (also for a malformed signature), 503 `signer_unavailable` |

**Agent or owner token**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /me` | — | `{role: "agent" or "owner", participant, mandate, mandate_version, agent_limits, agent_limits_recorded_by (since v11), effective_limits, mandate_changed_by, position, network, unit, authority}` | — |
| `PUT /limits` | `{max_issue_per_deal?, max_issue_outstanding?, max_accept_per_deal?, max_accept_per_issuer?, min_price_as_payee?, min_payer_coverage_pct?, notes?}` (values: integer or `null`) | `{agent_limits: {..., notes?, set_at}, agent_limits_recorded_by (since v11), effective_limits}` | 400 `invalid_field`, 403 `above_owner_mandate`, 403 `below_owner_mandate` |
| `GET /inbox` | — | `{respond, deliver, review_delivery, awaiting_your_owner, waiting_on_others, recent_closed}`: lists of `{deal_id, status, counterparty (handle), your_role, title, price, version, offer_expires_at, deliver_by}`; `awaiting_your_owner`: `{approval_id, deal_id, kind, version, terms_hash, title, price}` | — |
| `GET /deals` | — | `[view]`, newest first | — |
| `GET /deals/{vd_id}` | — | view | 404 |

**Agent token only**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /deals/{id}/credit-note-template` | — | 9.2 | 403 `agent_only` (owner token), 403 `not_payer`, 409 `wrong_state`, 409 `payee_no_key`, 409 `note_timestamp_ahead` (+`retry_after_ms`, `last_note_timestamp`; since v11), 503 `signer_unavailable`, 502 `tracker_unavailable`, 502 `signer_error` |
| `POST /deals` | `{terms, terms_hash?, signature}` | 201 view | 400 `invalid_terms`, 400 `invalid_field` (service text), 400 `hash_mismatch` (+`canonical`), 403 `bad_signature`, 409 `duplicate` (since v11 checked after the signature, so an unsigned probe cannot learn whether a deal id exists), 403 `mandate_exceeded` |
| `POST /deals/{id}/counter` | `{terms, terms_hash?, signature}` | view | 409 `not_open`, 409 `own_offer`, 400 `invalid_terms`, 400 `invalid_field`, 409 `counter_pending`, 400 `hash_mismatch`, 403 `bad_signature`, 403 `mandate_exceeded` |
| `POST /deals/{id}/accept` | `{terms_hash, signature}` | view | 409 `not_open`, 409 `own_offer`, 409 `counter_pending` (your own counter waits for your owner), 409 `stale_terms`, 409 `key_changed`, 403 `bad_signature`, 403 `mandate_exceeded`, 409 `offer_not_authorized` |
| `POST /deals/{id}/decline` | `{terms_hash, signature, reason?}` (signature over the reason as sent, 8.3) | view | 409 `not_open`, 409 `own_offer`, 409 `stale_terms`, 400 `invalid_field` (reason not text, refused character or too long), 403 `bad_signature` |
| `POST /deals/{id}/withdraw` | `{terms_hash, signature}` (hash of your open offer or held counter) | view | 409 `not_open`, 409 `stale_terms`, 403 `bad_signature` |
| `POST /deals/{id}/deliver` | `{terms_hash, content, title?, sha256?, signature}` (`title` ≤ 120, cleaned, not signed) | view | 403 `not_payee`, 409 `wrong_state` (also after the delivery grace period, since v11), 409 `stale_terms`, 400 `invalid_field`, 400 `hash_mismatch`, 403 `bad_signature` |
| `POST /deals/{id}/complete` | `{terms_hash, deliverable_sha256, signature, credit_note: {total, timestamp, signature}}` | view (check `status`) | 403 `not_payer`, 409 `wrong_state`, 409 `stale_terms`, 403 `bad_signature`, 409 `payee_no_key`, 409 `stale_note` (+`template`), 503 `signer_unavailable`, 502 `tracker_unavailable`, 502 `signer_error` |
| `POST /deals/{id}/dispute` | `{terms_hash, deliverable_sha256, signature, reason}` (signature over the reason as sent, 8.3) | view | 403 `not_payer`, 409 `wrong_state`, 409 `stale_terms`, 400 `invalid_field` (reason missing, not text, refused character or too long), 403 `bad_signature` |

**Owner token only**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /owner` | — | `{participant, mandate, mandate_version, mandate_changed_by, mandate_changed_at, agent_limits, agent_limits_recorded_by, effective_limits, owner_token_rotated_at (since v11), owner_token_rotated_by (`owner` or `operator`, since v12), agent: {enrolled, pubkey, last_seen, enrollment_pending, enrollment_expires_at, enrollment_issued_by, key_registered_at}, past_keys, approvals: [approval + subject + mandate_check + effect + deal], deals: [view], inbox, position}` | — |
| `PUT /owner/mandate` | any mandate fields (11.1) | `{mandate, mandate_version, changed_by, changed}` (`changed` since v11) | 400 `invalid_field`, 403 `sandbox_only` (since v14: a self-serve sandbox participant's owner widening its box; Appendix G) |
| `POST /owner/approvals/{va_id}` | `{decision, note?}` | `{approval, deal: view}` | 404, 409 `not_pending`, 409 `conflicting_pending`, 400 `invalid_field`, 409 `expired`, 409 `key_changed`, 403 `mandate_exceeded`, 409 `offer_not_authorized`, 409 `acceptance_not_authorized` (`confirm_offer`, since v11), 409 `stale_note` |
| `POST /owner/rotate-token` (since v11) | — | `{participant_id, owner_token, rotated_at, note}`: the new owner token, shown once; the old one is `401` at once; the agent is not affected | — |
| `POST /owner/revoke-agent` | — | `{enrollment_code, enrollment_expires_at, revoked_pubkey, cancelled_deals: [id], voided_credit_notes: [id]}` | 409 `no_agent` |
| `POST /owner/enrollment-code` | — | `{enrollment_code, enrollment_expires_at}` | 409 `already_enrolled` |

**Admin** (network operator only: request from loopback, header `X-Valun-Admin: <admin token>`, and none of
`Fly-Client-IP`, `X-Forwarded-For`, `Fly-Forwarded-Port`; anything else is `404`): `POST /admin/invites`
`{note?, max_uses?: 1–1000, ttl_days?: 1–90}` → 201 `{id, code, expires_at}` (400 `invalid_field` otherwise); `GET /admin/invites`;
`POST /admin/participants/{id}/enrollment-code` (409 `already_enrolled`); `PUT /admin/participants/{id}/mandate`;
since v12 `POST /admin/participants/{id}/owner-token` (a new owner token for that participant, returned once as
`{participant_id, owner_token, rotated_at, note}`; the previous one is `401` at once; the agent is not affected; the
owner then sees `owner_token_rotated_by: "operator"`; audit `owner_token.reset_by_operator`).
Clients never use these.

**Release v16 additions to the routes above**:
- `GET /info`, when the effective mode is not `off`: `features`, `novation` and `circulation_statements` (18.1).
- `GET /deals/{id}/credit-note-template`: `?prior=1` in every mode; `?bound=1` from mode `bound` up (else
  `409 feature_unavailable`); `409 pair_busy` in every mode; `409 novation_pending` with circulation on (9.2, 18.5).
- `POST /deals/{id}/complete`: `credit_note.prior_total` and `credit_note.prior_signature` for a bound note (18.5);
  also from `payment_due` (`409 transfer_window_open`); `409 pair_busy`; against a v3 tracker a reserved residue other
  than 997 is `409 stale_note`.
- `POST /owner/approvals/{va_id}`: `409 unknown_approval_kind` (every mode); `409 stale_payment` for a stale
  `pay_by_transfer` approval (18.11).
- `GET /me`, `GET /owner` (circulation `sandbox` or `on`): `credit_policy` (the fields of 18.13) and `features`; the
  positions and the inbox gain the fields of 18.14; `GET /ledger` keeps only notes in the pilot denomination (every
  mode), and its `reconciliation` rows keep v15's shape and fields in every mode: the journal columns are not public
  (18.12, 18.14).
- New routes: 18.14.

### 14.4 The deal view

`{id, status, overdue, you, your_role, counterparty: participant, next_actions, current: {version, by, state, terms,
terms_hash, signature, offered_at} | null, pending_counter: {version, state, terms, terms_hash, signature, created_at} |
null, versions: [{version, by, state, terms_hash, price, signature, created_at, offered_at}], acceptance: {version, by,
state, at, signature | null, held_for?: ["acceptor_owner" | "proposer_owner"] (since v11, while awaiting_owner)} | null,
agreement: {version, terms_hash, formed_at, proposer_signature, acceptor_signature} | null, delivery_grace_ends_at:
<ISO time> | null (since v11, for agreed and expired_undelivered deals), decline: {version, by, reason, reason_as_signed?, signature, at} | null, delivery: {by, title, content, sha256, bytes,
signature, at, late} | null, completion: {by, signature, at, deliverable_sha256} | null, dispute: {by, reason,
reason_as_signed?, signature, at} | null,
credit_note (9.2) | null, cancellation | null, approvals: [own approvals], history: [{at, by, event, ...}], labels: {
signed_by_parties, owner_approvals, basis, settlement, work}}`.

History `by` is a participant id, `owner:<participant id>`, `valun` or `basis-tracker`. Events: `proposed`, `countered`,
`accepted`, `agreed`, `declined`, `withdrawn`, `expired`, `expired_before_owner_approval`,
`counter_expired_before_owner_approval`, `owner_approved`, `owner_rejected`, `owner_approval_void_stale`, `delivered`,
`delivery_accepted`, `credit_note_awaiting_owner`, `credit_note_recorded`, `credit_note_failed`, `credit_note_void`,
`disputed`, `cancelled`, and since v11 `held_for_proposer_owner` and `expired_undelivered`; a `withdrawn` event carries
`acceptance_voided: true` when it voided a waiting acceptance, and `by_owner: true` when the proposer's owner rejected a
`confirm_offer`. The agreed terms are `current.terms` once `agreement` is set.

Release v16 with circulation `sandbox` or `on` (modes `off` and `bound` leave
the view byte-identical to v15): `payment: {method, state, transfer_id, issuer: {id, handle}, amount, expires_at,
fallback_after, signatures_withheld}` once a payment by transfer was attempted; `credit_note.pair_changes_since`; the
`next_actions` of 10.4; the labels of 16.1; history events `transfer_created`, `transfer_applied`, `transfer_failed`,
`transfer_expired` and `setoff_applied`.

A complete example run through the real route table (236 requests, every response; steps 1–147 with circulation off,
as release v13 answered them, and steps 148–236 with circulation on) is `vectors/transcript.json`.

## 15. What the server verifies and what a client MUST verify

### 15.1 The server verifies (and a client may rely on it only as far as it trusts the server)

- tokens and roles; the signature on every agent act against the caller's currently registered key over the exact
  statement; proof of possession at enrollment; global key uniqueness;
- terms validity; it recomputes every terms hash itself; counter chaining; that both parties' keys are current at
  acceptance and approval;
- the mandate of the acting participant and, at acceptance, of the proposer; owner approval gates;
- credit notes: total = tracker prior + price, timestamp window, payer signature over the message it builds, tracker
  read-back of exactly that note, re-verification;
- visibility (section 13).
- release v16, circulation on: every novation signature against the signer's
  current key over the message the server rebuilds; the edges re-read before every tracker call; every outcome decided
  by reading the edges back (18.6, 18.8); the credit-policy checks (18.13). None of this is what keeps a client's value
  safe: that rests on the client's own checks (15.3) and on the tracker v3 rules over the client's own signatures
  (18.2).

### 15.2 A client MUST verify, because the server is not trusted to tell it what to sign

Before **accepting or countering** an offer:
1. recompute `terms_hash` from `current.terms` (section 7) and use only the recomputed value;
2. `protocol` and `network` are as expected; `tracker_nft_id` and `denomination` equal the network's (`GET /info`, and
   SHOULD equal a value the client pinned);
3. it is the payer or payee and the terms name **its own current key** for that role;
4. the proposer's key in the terms equals the proposer's registered key, and the proposer's signature verifies over
   `valun-pilot/propose/1\n{terms_hash}`;
5. the offer has not expired;
6. SHOULD: `terms.deal_id` is the deal it asked for; `proposer` = `current.by`; for version > 1, `prior_terms_hash` is
   the hash of the version it saw before; `price.unit` is `PC`; `consideration` is as expected; time strings are
   RFC 3339 UTC; service text is shown to its user with control and bidi characters neutralised.

Before **delivering**: SHOULD verify the agreement (both signatures over the agreed hash, keys as in the terms).

Before **signing a credit note** (complete):
1. the delivered content hashes to `delivery.sha256` and that is the delivery its user reviewed;
2. the agreement: recompute the hash; verify the proposer's `propose` and the acceptor's `accept` signatures against the
   keys named in the terms;
3. the template: `issuer_pubkey` is its own key; `recipient_pubkey` is the payee's key (if it differs from the agreed
   payee key, that is a key rotation the client SHOULD confirm independently of the server); `price` is the agreed
   price; `total = prior_total + price`; `prior_total` matches its own record of notes it issued to that payee key;
   `tracker_nft_id`/`denomination` equal the agreed terms; `timestamp` is close to its own clock;
4. **recompute the 80-byte message itself** from those values and sign that; never sign `message_hex` as given.

Before **declining or disputing**: send a string reason without refused characters (section 2.3) and sign
`sha256hex(reason)` over exactly the reason string sent (section 8.3). When showing a counterparty's reason, prefer
`reason` (cleaned) and treat it as untrusted text (since v9 it has no controls, bidi controls or tag characters, but it
may contain ZWJ, ZWNJ, LRM/RLM/ALM and one variation selector after each emoji character); `reason_as_signed` is the raw text, for
re-verifying the signature.

On **`503 signer_unavailable`**: nothing was recorded; retry the same signed request later with back-off. Do not
generate a new key or re-enroll because of it.

Always: generate and keep the signing key locally; never send it; check `status` in successful responses (`note_failed`
is a 200); treat every text field from the server or the counterparty as untrusted input.

The two Python reference clients, the Hermes plugin 0.3.0 (`hermes-plugin-valun/valun_core/client.py` at `5d01fbd`)
and the `valun` package 0.3.1 (`python/src/valun/client.py` at `c75cfb0`, the same file byte for byte), implement
accept/counter items 1–5 and complete items 1–4 (in both: `client.py:217-244` `verify_offer`, `308-344` `complete`,
`353-370` `verified_agreement`), except the SHOULD in complete item 3 (they take the payee's current directory key
without further confirmation); they do not implement accept/counter item 6 or the delivery check (OPEN-QUESTIONS
OQ-28). Their decline and dispute signatures follow 8.3 (they sign the reason they send; the `valun_respond` tool
strips a decline reason first and signs the stripped text, `agent.py:416`), which `check_python.py` confirms against
release v13 for both clients (plugin at `5d01fbd`). Neither checks a reason for refused characters before signing (the
server refuses it with `400 invalid_field`, a safe refusal), and neither treats `503 signer_unavailable` specially (it
surfaces as a `ValunError` with that code). Both surface the v11 refusals as `ValunError` codes (`wrong_state` for a
delivery after the grace period, `mandate_exceeded` for an owner-recorded limit; replayed in `transcript.json`). Since
0.3.0 the plugin's tools are the package's `agent.py` (`valun_core/agent.py`), which tells an agent whose acceptance is
`accepted_awaiting_owner` which owner holds it; the plugin 0.2.x said "becomes binding when your owner approves it",
which is wrong when only the proposer's owner holds it (`confirm_offer`; OPEN-QUESTIONS OQ-36, resolved in 0.3.0).

For a release v16 server, a 0.4 client changes three of the checks above:
1. complete item 3: when the template carries `prior_note` (`?prior=1`, 9.2), the client verifies it as **its own**
   signature over the note message `M(I,R,prior_total,prior_note.timestamp)` (9.1; notation of section 18) and
   accepts it if it is not older than its own confirmed record, instead of requiring `prior_total` to equal that
   record (the record's errors, OQ-23, no longer block it). If `prior_note` is one of its own pending notes, that note
   applied: the client records it and MUST NOT pay that note's deal again (15.3, notes);
2. when `/info` lists `bound_notes/1` it signs bound notes only (18.5; R12), and when `/info` lists any feature it
   refuses an ordinary template whose timestamp ends in 995–999 ms (`bad_template`);
3. before accepting a delivery (completing, or paying by transfer) it verifies the payee's delivery signature over
   `valun-pilot/deliver/1\n{terms_hash}\n{sha256}` against the agreed payee key or the payee's current key
   (`bad_delivery_signature`).

### 15.3 A client MUST pass every circulation signature through a signing firewall

With circulating credit (release v16, section 18) a client signs 80-byte messages that move value on its own edges and
other parties', some of them without asking anyone (consents, 18.9). Before it signs anything for a bound note, a
payment by transfer or a consent, it MUST apply the rules below. They are deterministic: their inputs are the item (a
template or a consent item), the client's own records, its pins, its local consent policy, the owner's mandate as
`GET /me` shows it, the clock and a signature verifier, and they make no request of their own. The rules and their
refusal codes are **normative**: the conformance vectors (`circulation.json`, tier `consent`) record the expected
decision for each case, `sign` or a refusal code, and a client that declares `circulation/1` MUST reproduce them.

| rule | the client MUST | refusal code |
|---|---|---|
| R1 Recompute | rebuild every 80-byte message, statement and digest it signs from values it has checked; never sign hex the server supplied (`message_hex`, `prior_message_hex`, `messages`) | — |
| R2 Verify priors | verify every EdgeState it is shown (`before`, `prior_note`, `GET /edges` rows) as the edge issuer's signature over `M(I,R,total,timestamp)` | `bad_prior_signature` |
| R3 Residues | bound notes end in 997 ms, transfers in 999, set-offs in 998 (18.4); an ordinary template ending in 995–999 is refused by `complete` as `bad_template` (15.2) | `timestamp_domain` |
| R4 One operation per (edge, timestamp) | keep a persistent `signed` record and never sign two different operations at the same (edge, timestamp). The signatures of one operation (a note and its prior acknowledgment; the payer's three transfer slots) are one operation | `timestamp_reused` |
| R5 Freshness | for an operation it starts (a bound note, a payment by transfer) T ∈ [now − 10 min, now + 5 s]; for a consent T ∈ [now − 55 min, now + 5 s]; in both, T later than every prior timestamp shown | `timestamp_stale` |
| R6 Neutrality | as a set-off member: over its own edges in the item, the sum of decreases where it is creditor equals the sum where it is issuer, every change is a decrease, no edge appears twice and none is a self-edge. As the issuer in a transfer: both edges are its own as issuer, and the from-decrease equals the to-increase equals the amount | `not_net_neutral`, `increase_in_setoff`, `duplicate_edge`, `self_edge`; `not_my_edge`, `total_owed_changes` |
| R7 Parties | as payer: the issuer is not the payee (`pay_with_is_payee`) and not itself (`self_edge`); the destination is the payee's current directory key (`wrong_destination`); the amount equals the agreed price (`amount_mismatch`). As payee: the deal names it as payee with its current key, it has delivered on it, the deal is being paid by this transfer, and the amount equals the agreed price (`deal_mismatch`) | `pay_with_is_payee`, `self_edge`, `wrong_destination`, `amount_mismatch`; `deal_mismatch` |
| R8 Policy | apply the stricter of its local consent policy (which roles it signs by itself, a cap in PC per consent, issuers it accepts or refuses) and the owner's mandate (18.13): a role that is off, an amount over a cap, an issuer not accepted | `policy_off`, `policy_cap`, `issuer_refused` |
| R9 Write-ahead | persist what it is about to sign (the `signed` record, the attempt, pending entries for every edge it changes) before sending it; if its records cannot be read, refuse everything | `records_unreadable` |
| R10 Destination | send signatures only to the Valun server it pinned at enrollment | — |
| R11 One live payment attempt per deal (decision D-1) | an attempt is any payment it signed for the deal: a transfer, a bound note or an ordinary note (recorded in `transfer_attempts`, with the full EdgeState it acknowledged). Classify each earlier attempt from its edge's current state: applied (its new state, or the records say so) → `already_paid`; another state at or past its timestamp, or an ordinary note that may still apply (ordinary notes never expire) → `attempt_outcome_unknown`, which only the owner resolves (18.8); may still apply, or its window has passed but its edge was not read back → `transfer_window_open` (the evaluation names the edges to read back, `needs_read_back`; the client reads `GET /edges` once and decides again); dead (read back at its prior state after T + 3 600 000 + 120 000 ms by its own clock) → no constraint. Two retries are excluded by the earlier attempt at the tracker and may be signed at once, while the edge is exactly the prior state it acknowledged: a bound note of its own that acknowledges the same prior on the same edge (only its own signature lowers its own edge, and R12 keeps it from bringing the edge back to a live bound note's prior), and a transfer signed again at the same T (the identical operation: an edge's operations apply at strictly increasing timestamps). A transfer at another T, even through the same issuer on the same priors, is not excluded: the creditors' prior acknowledgments M(A,B,X,T) and M(A,C,Y,T) carry no prior timestamp, so both transfers apply when A→B and A→C come back to X and Y between them, which the issuer and the payee can arrange without the payer (audit VS-1); it waits like any other payment. A payer consent (a regenerated transfer) is signed only under the quote of an attempt of its own whose window (T + 3 600 000 + 120 000 ms) is still open, never under an approval given for an older attempt (`stale_quote`, audit AI-1) | `transfer_window_open`, `attempt_outcome_unknown`, `already_paid` |
| R12 Bound stickiness | once the server has advertised `bound_notes/1`, use bound templates; on an edge in its `novated_edges` record never sign an unbound note; never sign a novation on an edge where it holds an unapplied unbound note (`pending_unbound_note`); never sign a novation, or a bound note, that brings an edge of its own (as issuer) back to the acknowledged prior of a bound note of its own that is later than it and may still apply (`payment_attempt`: the note could then apply after it, the client side of decision D-2 c; the bound-note case since audit VS-1) | `bound_note_required`; `pending_unbound_note`; `payment_attempt` |
| R13 Pins | `tracker_nft_id` and `denomination` equal the values it pinned at enrollment (or on its first run as a 0.4 client) | `tracker_mismatch` |

The normative refusal codes, all of them: `bad_prior_signature`, `timestamp_domain`, `timestamp_reused`,
`timestamp_stale`, `not_net_neutral`, `increase_in_setoff`, `duplicate_edge`, `self_edge`, `not_my_edge`,
`total_owed_changes`, `pay_with_is_payee`, `wrong_destination`, `amount_mismatch`, `deal_mismatch`, `policy_off`,
`policy_cap`, `issuer_refused`, `records_unreadable`, `transfer_window_open`, `bound_note_required`,
`pending_unbound_note`, `tracker_mismatch`; since decision D-1, `attempt_outcome_unknown` and `already_paid`; since
D-2 c, `payment_attempt`; and three for items that cannot be signed as they are: `stale_quote` (a payment that is not
the quote the owner approved), `bad_template` and `bad_consent` (a template or consent item that is not well formed).
Each case in the vectors breaks one rule, and the vectors give the code of that rule. The checks run in this order,
and the first that fails gives the code: R9 (records), well-formedness (`bad_template`, `bad_consent`),
`already_paid` (records), R13, the party checks of R6/R7, R3, the amounts of R6/R7, R2, R5, R11 (D-1), `stale_quote`,
R8, R12, R4. The evaluator's other inputs: `me_id` is required for the payer roles and bound notes (without it,
`deal_mismatch`); a missing mandate turns every role off (`policy_off`), the payer's too; the issuer lists of R8 are
checked against the participant id the client resolved for the issuer's key itself from the directory, never an id
the item names (`issuer_refused`). R4's record is `signed {edge: {timestamp: {op, slots {slot: total}}}}`, with the
operations `note:<deal>`, `pay:<deal>`, `transfer:<vt>` and `setoff:<vs>`. R8's fields: local `setoff`, `as_issuer`,
`as_new_creditor`, `max_PC` (per consent), `accept_issuers` (`any`, ids or public keys) and `refuse_issuers`; the
mandate's `auto_clear`, `novate_own_debt`, `accept_transfers`, `may_accept_credit`, `accept_notes_from` (`any` or ids;
absent or `[]`: nobody), `refuse_notes_from`, `max_accept_per_issuer` (checked against Y + a) and
`pay_with_held_notes` (`never` refuses).

Notes:
- A difference between an item and the client's own records is reported, not refused: the tracker enforces prior
  acknowledgments and bound notes, so the records no longer decide value (OQ-23). The one exception is the payer's own
  bound note: `complete` refuses a prior that is older than, or conflicts with, its own confirmed state of that edge
  (`ledger_mismatch`, nothing signed). One case is not a difference: a
  pending entry of the client's own that appears as a prior, or as an edge's current state, has applied. The client
  MUST then record it as confirmed and MUST NOT pay that entry's deal again, whatever the server says about the deal
  (16.2, item 7).
- A consent the firewall refuses is refused at the server with the code as its reason (18.9), so the proposal ends
  instead of waiting for its expiry.
- When it runs: a client processes consents at most once per 60 s, before its own non-read-only actions, on an
  explicit command, or in a background loop its profile enables; never on a read-only call, with one exception
  (decision D-3 a): an adapter without a background loop (the Hermes plugin; CLI runs that are not loops) may, before
  the read-only `valun_status` and `valun_inbox`, at most once per 60 s, sign the value-safe consents its owner's
  standing policy allows: set-offs (net-neutral by construction) and new-creditor consents. It never signs or refuses
  an issuer consent, and makes no payer action, from a read-only tool; the tool's result lists what it signed
  (`consents_signed_now`). Default local policies
  (OPEN-QUESTIONS OQ-40): a sandbox profile signs set-offs, issuer consents and new-creditor consents; an invited
  profile signs set-offs and issuer consents only.
- A payment by transfer is a commitment and follows the owner's approval rules like any acceptance; set-off, issuer
  and new-creditor consents never ask the owner (18.13). An approval prompt puts the computed lines first and quotes
  counterparty-written text as one JSON line after them.
- These rules are written for the roles of 18.6 and 18.7. The tracker rules (18.2) protect a client that applies them
  even against a server that lies about totals; what they cannot protect against is in 16.2.

## 16. Honest labels

These are part of the protocol's meaning and a client SHOULD present them to its user:

- **Issued is not settled.** `note_issued` and `credit_note.outstanding: true, settled: false` mean the payer owes the
  payee. Positions report `settled: 0`. Up to v15, and in v16 with circulation off, the pilot has no redemption,
  reserve, clearing or netting (with circulation on: 16.1).
- **Local only.** The tracker has no blockchain connection: `GET /info` `tracker_on_chain: false`; tracker
  confirmations are `local_only`. The PC token id exists on no chain.
- **No reserve.** `backing: "none: the pilot tracker has no chain and no reserves; PC are simulated units"`.
- **Synthetic units.** PC have no monetary value.
- **Coverage is not solvency.** `min_payer_coverage_pct` compares a payer's tracker claims (notes others issued to it)
  with what it would owe; those claims are themselves unsettled promises.
- **Owner approvals are server-attested**, not key-signed. **Valun does not judge work**: delivery and acceptance are
  the parties' statements.
- Each deal view carries these as `labels`.

### 16.1 Labels with circulating credit on

With the effective mode `off` or `bound` every label stays word for word as in v15; in particular the deal's
`labels.settlement` is "not settled: issuing a credit note creates an outstanding obligation; the pilot has no
redemption, reserve or clearing, so nothing is ever settled here" and the position's `meaning` is "claims and debts are
outstanding credit notes (cumulative per pair, as the tracker records them). None has been settled: the pilot has no
redemption, reserve or clearing.". With circulation `sandbox` or `on` the texts below replace them, identical in the
server and in the 0.4 Python and JavaScript clients:

- deal `labels.settlement`: "not settled: a credit note is an outstanding obligation. With circulating credit it can
  move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal
  opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, there is no
  reserve, and PC have no value."
- deal `labels.basis` for `paid_by_transfer`: "`<issuer>` now owes `<payee>` `<price>` PC that it owed `<payer>` before;
  `<payer>` issued no credit note for this deal" (handles and the price filled in).
- position: `settled` = `cleared_by_setoff` (PC cancelled by set-off), with `settled_how`: "by set-off only; nothing is
  redeemed"; `backing` unchanged ("none: the pilot tracker has no chain and no reserves; PC are simulated units");
  `meaning`: "claims and debts are outstanding obligations recorded by the pilot Basis tracker (cumulative per pair).
  Some may have moved between creditors (transfer) or been cancelled in cycles (set-off); settled counts only set-off.
  Nothing is redeemed; there is no reserve."
- claims on a sandbox agent (`operator_run: true`) are labelled "issued with keys the operator holds".
- A credit note's `outstanding: true, settled: false` describe the note as it was recorded; later transfers and
  set-offs on its pair are in `credit_note.pair_changes_since`, and the pair's current total in `GET /edges` and the
  ledger.
- Owner approval texts for a payment by transfer: 18.11.
- `GET /info` `description`: modes off and bound keep v15's text word for word. Modes sandbox and on keep its first
  three sentences, then say "An issued note is not settled: a credit note is an outstanding obligation. With
  circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be
  cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is
  redeemed, there is no reserve, and PC have no value."; mode sandbox adds " On this server circulating credit is on
  for sandbox participants only: the sandbox agents and those who joined with join-sandbox." (OPEN-QUESTIONS OQ-49,
  resolved).
- The texts a client shows with circulating credit (its own labels, `valun_status` and `valun_deal` fields, the words
  for consent speeds) are the client's own, not protocol; only the server texts in this section are fixed.
- **Coverage is not solvency** still holds; for a payment by transfer coverage is judged on the issuer whose note is
  received, and cycles cleared by set-off no longer add to anyone's coverage (OPEN-QUESTIONS OQ-26).

### 16.2 Residual risks

What circulating credit does not protect against, stated so that no party relies on more:

1. **The credit-note path: a payer and the server colluding against the payee.** As in v15, a payer working with the
   server can underpay a payee through an ordinary credit note: the deal shows as paid while the pair's total rose by
   less than the price. A bound note's receipt (the note and the issuer's prior acknowledgment, both by the payer's
   key) lets the payee check afterwards that the total rose by exactly the price. A payment by transfer protects the
   payee fully, because it signs its own prior acknowledgment and its own new total.
2. **Operator-held sandbox keys.** The operator holds the sandbox agents' keys (18.15) and can mint their notes at
   will; they are labelled `operator_run`. A stranger's claims on anyone else never depend on those keys.
3. **A modified tracker** is outside the trust model: a binary that does not apply its rules can record anything. The
   sha256 pin (18.1) keeps Valun from using one knowingly; afterwards only evidence helps: receipts carry every party's
   signatures; a stored state at residue 999 must have its counterpart edge at the same timestamp, and one at residue
   998 must belong to a set-off whose edges balance, every edge signed by both its parties.
4. **Clock skew.** R11 waits 2 minutes beyond the tracker's maximum age by the client's own clock. A client whose
   clock runs more than 2 minutes ahead of the tracker's can sign a fallback payment while an earlier attempt is still
   usable at the tracker.
5. **What each party learns.** The payer learns the payee's current claim on the issuer (it signs the destination's
   new total). The issuer learns that the payer paid the payee that amount, not the service or the delivery. Set-off
   members see only their own edges. The server sees everything.
6. **The public ledger** (14.3) already shows every edge total, so anyone can see edges rise and fall and infer
   transfers and set-offs from simultaneous changes; receipts and the edge journal stay with the parties, and
   `GET /clearing` shows aggregates only.
7. **Outcome reports.** Whether a novation or a note applied is decided by the server's read-back. A client can check
   it only through states it signed itself. On its outgoing edges every change carries its own signature, so a later
   prior shows whether its note applied (15.3, notes). On a claim it holds (A→B) the issuer's notes change the edge
   without it: once that edge has moved past an attempt's timestamp, the holder cannot tell from the edge alone whether
   the attempt applied. A server that hides an applied transfer and offers a regenerated one could obtain a second
   payment of the same deal, each signed for exactly the price (OPEN-QUESTIONS OQ-48). Since decision D-1 a client
   keeps one live payment attempt per deal (15.3 R11), and since decision D-2 a it compares full edge states: past T
   only the attempt's exact new state (its new total at its own timestamp T) counts as applied, and any other state at
   or past T, its prior total and its new total at a later timestamp included (an edge can come back to a total), is
   `attempt_outcome_unknown`, which only the owner resolves (18.8). An attempt counts as not applied only when it is
   dead: read back at a state older than T, after T + 3 600 000 + 120 000 ms. A regenerated transfer is signed only as
   the identical operation, never at a new T while the earlier attempt may apply (audit VS-1). Read-backs still come
   from the server, so a stale but validly signed state is caught only through the attempt's acknowledged
   `prior_timestamp` and the client's own records.
8. **A failed credit note that is still valid.** Ordinary notes have no maximum age; bound notes do (one hour, tracker
   v3.1). Since decision D-1 a payment of another kind waits: after a failed bound note the server refuses a transfer
   until the note's timestamp + 1 h + 60 s; a failed ordinary note that can still apply makes it refuse with
   `409 attempt_outcome_unknown`, and one shown applied with `409 already_paid` (OPEN-QUESTIONS OQ-22). What remains:
   the server keeps a failed ordinary note's signature, so a server that submits it later while the pair's state is
   still older than it could still make it apply; a client never pays such a deal again while that note may apply.
9. **Old backups.** Restoring an old client profile loses its R4 and R12 records; the tracker's bound-only edges
   still protect issuers.
10. **0.3 clients** never sign a novation, so their edges never fall and never become bound-only; they keep paying and
    being paid by credit notes only, as in v15.
11. **Held notes and set-offs** (D-2 c). A set-off whose timestamp on a pair precedes a held note's still applies; the
    held note then becomes `void_stale` at its owner's decision, and the payer waits about an hour before a new note
    with the new prior. A deal left unpaid keeps the edges its attempts would change out of clearing indefinitely.
12. **Same-issuer transfers: what audit VS-1 left open.** The 0.4.0 payer clients never sign a second same-issuer
    transfer at a new T while an earlier attempt may apply (18.6, "The same-issuer retry rule"), but two parts of the
    hole remain. (a) **The tracker's prior acknowledgment binds totals only.** Tracker v3.1 checks the creditors'
    prior acknowledgments M(A,B,X,T) and M(A,C,Y,T) against the stored totals, with no prior timestamp, so two
    transfers through the same issuer on the same priors at different T both apply when A→B and A→C come back to X
    and Y between them, which the issuer and the payee can arrange without the payer. Only the payer's client stops
    the second one: a modified client, or one restored from an old backup without its attempt records (item 9), can
    still sign it, and nothing at the tracker refuses it (0.3 clients sign no transfer at all, item 10). A tracker
    v3.2 would bind the creditors' prior acknowledgments to the prior state's timestamp (`prior_ts`), so the second
    transfer fails at the tracker. (b)
    **There is no issuer-side transfer twin.** An issuer that co-signs a transfer signs only the new slots, and its
    records (`signed`, pending) keep the new totals, not the prior totals or the amount, so its client cannot refuse a
    later note or novation that brings an edge back to a live transfer's prior, as R12 does for its own bound notes.
    Adding it needs a new record type in the clients' records, the spec and both clients. Until both parts are
    closed, what keeps a payer from paying a deal twice this way is its own client's records and R11 alone.

## 17. Conformance vectors

`spec/vectors/` (regenerate with `node spec/vectors/generate.mjs`, which exports valun-app commit `cfe698b` with
`git archive` itself, or with `VALUN_APP_DIR=<export>`; output is deterministic, and labelled "UNRECOGNISED server
source" if the sources are not a known release's; an export of release v13 `6a6a34b` still gives exactly the v13
files). The vectors were regenerated from release v16 (valun-app `cfe698b`); the audit's server commit `55510a9`
gives the same vectors but for two non-normative `engine.limits` keys (Appendix H), so they were not regenerated:

| file | content |
|---|---|
| `canonical.json` | 70 canonical-JSON / terms-hash cases: 28 valid terms (field order, whitespace, unicode including ZWJ/ZWNJ text, emoji presentation, keycaps and RGI subdivision flags, escapes, limits, and two that pin the OQ-33 residual), 25 terms the v13 server refuses for refused characters or padding (canonical form still defined), 5 wire forms the server accepts, 12 generic edge values |
| `statements.json` | 128 statement cases for every kind (enroll 2, propose/counter 2, accept 1, withdraw 1, deliver 7, complete 1, decline 57, dispute 57; decline/dispute run through the real server code: for an accepted reason (22 decline, 25 dispute) every accepted form, a signature over each, and the stored `reason`/`reason_as_signed`; for a refused one (35, 32), tier `refused`, the exact refusal) + 7 signatures that MUST NOT verify |
| `basis-notes.json` | 13 note-message / debt-key cases (Basis official erg vectors; pilot token denomination) + 1 negative |
| `basis-signatures.json` | Basis's official signature vectors TV001–TV011 |
| `terms-validation.json` | 87 terms the real validator accepts (19) or refuses (68), with the exact error |
| `transcript.json` | a 236-request run through the real route table, with what the server verified at each step; decline/dispute steps also list every statement form the server would accept for that body (`server_accepts`, from a dry run of the real code). Steps 1-147 run with circulation off and are byte-identical to release v13's. Steps 148-236 run with circulation on (the stand-in tracker enforces the v3.1 rules of 18.2, its binary pinned for the in-memory Pilot only): two new participants (nina, a client agent; sam, an agent the server runs); owners opting in; a policy refusal (`payment_not_accepted`, payee); a payment by transfer with client parties and its consents; a bound note after the novation, with no `ledger_mismatch`; a set-off proposed by the clearing engine, superseded by a held note (`held_note`, D-2 c) and proposed again; a payment refused when posted, kept as an attempt (D-2 b), and the cross-kind window it opens (D-1); a held bound note refused by the tracker after its maximum age (`novation_expired`, D-1 item 4) and signed again; a server-run payee whose slots are signed at once, attacks the server refuses (a puppet destination, an amplified slot), an outcome the read-back cannot decide (`outcome_unknown`, D-1 item 3) and the owner's resolution (D-2 d); and the empty roles header (D-3 b). Each `server_verified` entry names the body field that held the signature (`field`, a JSON pointer) and the edge of a note message; replayed calls carry `client_state`, `signature_fields` and `client_state_after` |
| `circulation.json` | circulating credit: 17 timestamp cases (residue classes, the ordinary clamp, the server's choice of T, limits beyond the safe integers), 14 messages (a bound note and its prior acknowledgment, all seven transfer slots, both set-off slots), 3 quote digests (with the 18.3 worked example), 2 pay statements, 13 transfer and 9 set-off tracker requests with the stand-in tracker's outcome (the valid ones, and a standalone raised edge, a missing residue, a puppet destination, the four- and five-signature bodies, amplification, a colluding payer, set-off signatures used as a transfer, too old, an unknown field, ...), and 58 decisions of the signing firewall (27 consents, 20 payer templates, 11 bound templates, the three audit VS-1 cases included) that cover every refusal code of 15.3 (all 28), `needs_read_back`, `policy_off` without a mandate and `deal_mismatch` without `me_id` |

All keys, ids, codes and tokens in them are public test fixtures (the test keys are derived from public labels; tokens
are replaced by placeholders). Never use them for anything real. `python spec/vectors/check_python.py` checks them
against the Hermes plugin, and `python spec/vectors/check_python.py --client package` against the `valun` package;
each replays the transcript through that client's real `Client` methods (commands for CI:
`spec/vectors/README-ci.md`): a replay must send the step's request exactly once, with the recorded `X-Valun-Features`
header (none where none is recorded, as in steps 1-147, which ran with circulation off) and exactly the signatures the
recorded body carries (no fewer and none extra), each verifying over what the server verified. Server-side Basis
crypto runs in a Rust helper that the generator does not run; the generator's replica is proven against Basis's
official vectors before it writes anything (the token-denomination debt key has no official vector: OPEN-QUESTIONS).
The circulation checks (tiers `circulation` and `consent`) count for a client that declares `circulation/1` in
`PROTOCOL_FEATURES`, or for a run given `--require circulation/1`; otherwise they are not applicable. A run given
`--require circulation/1` with vectors that have no `circulation.json` or no transcript steps 148+ stops with exit
status 2 instead of passing vacuously. Against release v16: the package 0.4.0 with `--require circulation/1` gives
**1386 checks, 1188 agree, 0 disagreements in failing tiers, 17 informative differences (OQ-2, OQ-3, OQ-4 inputs), 181
not applicable**, and so does the Hermes plugin 0.4.0 (`2b78a06`, the commit CI pins; `e2c7640` gave the same) with
`--require circulation/1`; without it, the plugin 0.3.0 (`5d01fbd`, the commit the Hermes catalog still pins, also
checked in CI), the plugin 0.4.0 and the package give **1384 checks, 1104 agree, 0
disagreements, 17 informative differences, 263 not applicable** (exit status 0 for each, with Python 3.14.7 and
3.11.18 on Windows; also with 3.12.3 on Linux for the plugin at `e2c7640` and the package at `1509cbe`, whose
vector-relevant code is unchanged since). Against release v13's vectors both 0.3 clients gave 829 checks, 658 agree, 0
disagreements, 17 informative differences, 154 not applicable, and the same files are still what an export of v13
produces. `scripts/check_plugin_core.py PLUGIN_DIR` checks that the plugin's `valun_core/` modules (six in 0.3.0,
eight since 0.4.0) are the package's, unchanged. The JavaScript package replays the same transcript, every step
that has a client call (`node --test js/test/`); CI also regenerates its Python fixtures with CPython 3.14
(`js/test/fixtures/generate_python_fixtures.py`) and requires them to equal the committed ones (job `fixtures` of
`.github/workflows/ci.yml`).

## 18. Circulating credit (server release v16)

Release v16 lets credit circulate. A payer may pay with a note it holds (**debt transfer**); the server proposes
**multilateral set-offs** of cycles of debts; a credit note can be **bound** to the current total of its edge; and
clients sign some of these **consents** by themselves, inside their owner's policy and a deterministic signing firewall
(15.3). The terms (`valun-deal/1`, 16 fields, `consideration` unchanged), the eight statements of 8.1 and every v15
behaviour with circulation off stay as they are (18.1). This section is the contract that the v16 server, the 0.4.0
clients and the tracker v3 are built against; it was checked against the vectors regenerated from that code (section
17) and against the final code, and where the two disagree the vectors decide and this text has a bug.

**Notation.**
- A = issuer; B = old creditor (in a payment, the deal's payer); C = new creditor (the deal's payee); a = amount;
  T = a transfer's timestamp; X = the tracker total of A→B; Y = the tracker total of A→C, or 0 if that edge does not
  exist.
- An **edge** I→R is the tracker's running total from issuer key I to recipient key R in the pilot denomination
  (9.1); its **edge key** is `<I>><R>` (the two public keys in hex, joined by `>`).
- `M(I,R,t,ts)` is the 80-byte note message of 9.1 (debt key, total, timestamp, tracker id) for issuer I, recipient R,
  total t and timestamp ts. No other message format is added.
- An **EdgeState** is `{total, timestamp, signature}`: the tracker's current note on an edge. Its signature is always
  the **issuer's** signature over `M(I,R,total,timestamp)`, because notes, transfers and set-offs all store the issuer's
  new signature; so a client can verify every EdgeState it is shown (a *self-authenticating* prior). Whether a state is
  the latest is not for the client to decide: the tracker enforces that, through prior acknowledgments and bound notes.
- The **residue** of a timestamp is `ts mod 1000`, its milliseconds.

**Trust model.** A participant's client is trusted by its owner and holds the key. The Valun server is trusted for
liveness, for privacy (it sees the whole graph) and for enforcing mandates (which clients repeat), **not** for what to
sign. The tracker is trusted within the Basis model: it applies its rules, cannot forge signatures, and may censor or
delay; in pure-credit mode its own key is a NUMS point, so every value binding lives in participants' signatures. The
operator holds the sandbox agents' keys (18.15).

**Invariants** (each tested by the implementations):
- **I-VALUE.** For a participant P with a 0.4 client, V(P) = claims − debts falls only (a) through a credit note P
  signed (for a bound note by exactly new − prior, both values P signed) or (b) as old creditor in a transfer P signed
  (by exactly prior − new, both signed). A set-off never changes V(P). P's claim on an issuer grows only through notes
  that issuer signed, or as new creditor in a transfer P signed, by exactly the amount P signed.
- **I-ONCE.** At most one attempt to pay a deal applies: a client signs a new attempt only after every earlier one is
  dead (18.8), except a bound-note retry on the same prior and the identical transfer signed again at the same T, which
  the tracker excludes (15.3 R11). Two transfers through the same issuer at different T do not exclude each other at
  the tracker v3.1 (audit VS-1, 18.6). (What this rests on when the server misreports an outcome: 16.2, item 7.)
- **I-ATOMIC.** A novation changes all its edges in one tracker write, or none.
- **I-WITHHOLD.** Nobody but the signer sees a collected signature until the tracker records it; signatures of
  novations that end without applying are purged (their sha256 kept); signatures are never logged.
- **I-SCOPE.** Novations touch only pure-credit edges, only current keys, and only active participants that can sign
  the consents they need.
- **I-DECIDE.** The server decides every tracker outcome by reading the edges back, never by status code; write-ahead
  state is saved before every tracker write; recovery runs at startup and every 60 s.
- **I-RECON.** On every edge Valun touched, the tracker's total equals the expected total in Valun's edge journal;
  differences are flagged, never corrected.
- **I-DARK.** With circulation effectively off, v16 behaves on the wire like v15 (18.1).
- **I-03SAFE.** A 0.3 client never signs a novation; its edges never fall and never become bound-only.
- **I-KEYS.** Participant keys never reach the server.

### 18.1 Modes, features and dark deploy

**Modes.** The operator sets `PILOT_CIRCULATION` to `off` (the default), `bound`, `sandbox` or `on`:

| mode | `GET /info` `features` | what it enables |
|---|---|---|
| `off` | (absent) | nothing: v15 behaviour |
| `bound` | `["bound_notes/1"]` | bound credit notes (18.5) |
| `sandbox` | `["bound_notes/1", "circulation/1"]` | bound notes; transfers, set-offs and consents only when every party is a sandbox agent or a `sandbox_only` participant |
| `on` | `["bound_notes/1", "circulation/1"]` | the same for every participant whose mandate allows it (18.13) |

**Effective mode (fail closed).** The mode takes effect only if both hold; otherwise the server runs as `off` and logs
why:
1. the tracker's `GET /capabilities` has exactly the v3 values (18.2);
2. the sha256 of the running tracker binary, computed by the launcher (`PILOT_TRACKER_SHA256`), is in the server's
   pinned list.
Probing routes (an `OPTIONS` request, a test call) is never used for this: it cannot tell which rules a tracker
enforces.

**`GET /info` additions**, only when the effective mode is not `off`:
- `features`, as in the table;
- `novation`: `{transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999],
  max_age_ms: 3600000, transfer_ttl_ms: 1200000, setoff_ttl_ms: 1800000, fallback_margin_ms: 60000}`;
- `circulation_statements`: `{pay: <source text of the pay statement template>}` (published like `statements`,
  OPEN-QUESTIONS OQ-18).
A client MUST treat a feature as present only when `features` lists it; a server without `features` (v15, or mode
`off`) has none.

**Capability header.** A client that can sign consents sends `X-Valun-Features: consents/1;roles=<roles>` on its
requests, `<roles>` being a comma-separated subset of `setoff`, `issuer` and `creditor` that lists only the roles its
local policy will sign (the local policy's `setoff`, `as_issuer` and `as_new_creditor`, not intersected with the
mandate), in that order: the server reads the roles in any order and ignores names it does not know, but the
conformance replay compares the header exactly as recorded (section 17), so a conforming client keeps the order.
It sends the header on every request once the last `GET /info` it read listed `circulation/1`. The server
takes the header from an agent request it authenticates; each header replaces the roles the one before declared, and
each role counts for 7 days from that header (server-run sandbox agents always can sign), and the server never
proposes to it a novation that needs another role. A request without the header, or with one the server cannot read,
changes nothing. **An empty list** (decision D-3 b): a client whose consent roles are all off (or whose adapter signs
no consent by itself: the Hermes plugin while `process_consents` is off) sends `X-Valun-Features: consents/1;roles=`
once, on its next request, if it declared roles before; the server forgets the recorded roles at once (no 7-day
carry-over), and `/me` then shows `features.consent_roles` `[]`, `consents_declared_at` the time of that request and
`consents_count_until` `null`. Such a participant takes part in no new consent: it is left out of set-offs, payments to
it by transfer are refused, and so are payments with its notes (`issuer_consent`). A participant is **present** when
its agent was seen in the last 10 minutes (server-run agents always are).

**What stays identical with the effective mode `off`** (I-DARK): `DEFAULT_MANDATE` (the new mandate fields exist only
once circulation has been enabled); the `statements` object and `/info` `statements`; `/info`, `/me`, `/owner`, deal
and approval views, the inbox, the ledger, positions and `next_actions`; the credit-note template requested without the
new query parameters; and transcript steps 1–147. The new routes answer `404 not_found`. Against a v3 tracker, in every
mode, ordinary template timestamps also skip residues 995–999 (at most 5 ms later, 18.4), because that tracker refuses
them. The always-on fixes of Appendix H change behaviour only in cases that do not arise in normal operation (failures,
races, a tracker that holds notes in another denomination).

**Mode changes.** The planned order is `off` → `bound` → `sandbox` → `on`. To roll back, the operator turns circulation
off first, which cancels collecting novations and purges their signatures (an operator procedure, outside the
protocol). The v15 rollback check then purges every unapplied note signature too, and runs from the image's entrypoint
with `VALUN_MAINTENANCE=downgrade-check` (Appendix H; audit MIG-1, MIG-3).

### 18.2 The tracker v3 contract

Circulating credit needs a pure-credit Basis tracker with the Valun rules, "tracker v3": Basis master `6a6ebfe` plus
`caa2e86`, `a00233d` and the Valun v3 commits (branch `circulating-credit-v3`), with `basis_core` unchanged from
`3df7ed93`, so the note message and the signature scheme are those of sections 6 and 9. Clients never call the tracker;
the server builds every tracker request. The rules are stated here because a client's value safety rests on them, not
on the server:

- **pure credit** (`[server] pure_credit = true`): no chain scanner and no box updater; the tracker refuses to start if
  any confirmation has a confirmed or pending on-chain total, or if notes or confirmations fail to load or decode;
- **POST /notes**: residues 995, 996, 998 and 999 refused; residue 997 only as a bound note, at most 1 hour old
  (tracker v3.1, decision D-1 item 1); any other residue refused on a bound-only edge (18.5);
- **POST /notes/transfer**, version 3: seven signatures, both creditors' prior acknowledgments, residue 999, at most
  1 hour old (18.6);
- **POST /notes/setoff**, version 3: residue 998, per-edge timestamps, per-key balance, at most 1 hour old (18.7);
- **bound-only edges**: every edge a transfer or set-off changes is marked bound-only, in the same write, for good;
- **maximum age** `NOVATION_MAX_AGE_MS = 3600000`, compiled in, not configurable (18.8): for transfers, every set-off
  edge and, since tracker v3.1 (D-1 item 1), bound notes; ordinary notes still have none;
- **strict requests**: transfer and set-off bodies refuse unknown fields (so an older binary that silently dropped a
  signature cannot pass for this one), and a body with an unknown or a missing field is answered `422` without a
  `code` (the JSON decoder's refusal: `circulation.json` `transfer/unknown-field`, `transfer/four-signature-body`); both
  routes need the tracker's Write role; signatures never appear in its logs
  (8-hex fingerprints only);
- **error codes**, in the `code` field of the tracker's JSON answers, for diagnostics only (Valun decides every outcome
  by reading the edges back): `reserved_timestamp`, `bound_note_required`, `invalid_prior_signature`,
  `not_an_increase`, `invalid_request`, `invalid_transfer`, `invalid_setoff`, `invalid_signature`, `past_timestamp`,
  `future_timestamp`, `novation_expired` (the novation routes and, since v3.1, POST /notes for a bound note),
  `stale_prior` (409), `staged_exchange` (409), `onchain_scope` (409),
  `tracker_id_mismatch` (409), `not_found` (404), `storage_error` (500) and `novations_disabled` (503: a tracker outside
  pure-credit mode whose confirmations failed to load).

**`GET /capabilities`** (tracker, Read role) answers:

```json
{"success": true, "data": {
  "tracker": "basis", "build": "valun-circulating-credit/3", "commit": "<git sha>",
  "pure_credit": true, "reserved_ms": [995, 996, 997, 998, 999],
  "bound_notes": {"ms": 997, "version": 2, "max_age_ms": 3600000}, "bound_only_edges": true,
  "novation": {"max_age_ms": 3600000,
    "transfer": {"ms": 999, "version": 3, "signatures": ["issuer_from", "issuer_to",
      "from_recipient_prior", "from_recipient", "from_recipient_to", "to_recipient_prior", "to_recipient"]},
    "setoff": {"ms": 998, "version": 3, "max_edges": 64, "per_edge_timestamps": true,
      "signatures_per_edge": ["issuer", "recipient"]}},
  "onchain_edges": 0, "novations_disabled_reason": null}}
```

This is tracker v3.1 (Valun fork commit `24675ec`, binary sha256 `cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8`, the one hash `lib/pilot/pins.mjs`
pins). TR-6's v3 build reported `"bound_notes": {"ms": 997, "version": 1}`; the server no longer accepts it. The server
requires exactly these values of `build`, `pure_credit`, `reserved_ms`, `bound_notes` (`ms` 997, `version` 2,
`max_age_ms` 3600000), `bound_only_edges`,
`novation.max_age_ms`, `novation.transfer`, `novation.setoff` (`ms`, `version`, `signatures_per_edge`), `onchain_edges`
and `novations_disabled_reason`; `commit` is informative and `per_edge_timestamps` may be `false` (18.7). The trackers
`3df7ed93`, `caa2e86` and `a00233d` answer this route with `404`, so with them the effective mode is `off`.

**POST /notes at residue 997, in this order** (after the checks every note has: range, future, past, decrease, note
signature, so an expired bound note older than the edge's own note is still `past_timestamp`): `prior_signature`
required (else 400 `reserved_timestamp`); a timestamp older than now − 3 600 000 → 400 `novation_expired`; then
`stale_prior` (409), `invalid_prior_signature` (400) and `not_an_increase` (400) as 18.5 says. `prior_total` without
`prior_signature` is 400 `reserved_timestamp` at residues 995-999 and 400 `invalid_request` at ordinary residues.

**Tracker requests** (the server builds them; for reference): a bound note is `POST /notes` with `prior_signature`
(65-byte hex) and `prior_total`; a transfer is `{issuer_pubkey, from_recipient_pubkey, to_recipient_pubkey,
denomination, amount, timestamp, issuer_from_signature, issuer_to_signature, from_recipient_prior_signature,
from_recipient_signature, from_recipient_to_signature, to_recipient_prior_signature, to_recipient_signature,
from_prior_total?, to_prior_total?}`; a set-off is `{denomination, timestamp, edges: [{issuer_pubkey, recipient_pubkey,
decrease, timestamp?, issuer_signature, recipient_signature}]}`.

### 18.3 Everything that is signed

Every signature is a Basis Schnorr signature (section 6) by the signer's currently registered key.

1. **`M(I,R,t,ts)`**, the 80-byte note message, for these operations, told apart by the residue of ts (18.4):

| residue | operation | who signs what |
|---|---|---|
| 000–994 | ordinary credit note (9) | the issuer: `M(I,R,P+price,ts)`, P = the pair's current total |
| 997 | bound credit note (18.5) | the issuer: the note `M(I,R,P+price,ts)` and its prior acknowledgment `M(I,R,P,ts)` |
| 998 | set-off edge (18.7) | the edge's issuer and its creditor, each: `M(I,R,P−d,ts_e)` |
| 999 | transfer (18.6) | the seven slots of the table in 18.6 |
| 995, 996 | reserved (exchange; triad compress) | nobody in v16 |

2. **The eight statements** of 8.1, unchanged. A payment by transfer carries the existing `complete` statement as its
   `completion_signature`.
3. **The pay statement** (new, circulation only), signed by the payer of a payment by transfer; it means "I pay this
   deal by exactly the transfer this quote describes":

```
valun-pilot/pay/1\n{deal_id}\n{quote_digest}
```

   It is 102 bytes long. No statement is 80 bytes long (the shortest, `accept`, has 85), so none can be taken for a
   note message.
4. **`quote_digest`** = `sha256hex(canonical(Q))` (2.1, 7.2), where

```
Q = {"kind": "valun-transfer-quote/1", "network": …, "tracker_nft_id": …, "denomination": …, "deal_id": …,
     "terms_hash": …, "deliverable_sha256": …, "issuer_pubkey": …, "payer_pubkey": …, "payee_pubkey": …, "amount": …}
```

   with `network`, `tracker_nft_id`, `denomination`, `deal_id` and `terms_hash` of the agreed terms,
   `deliverable_sha256` of the delivery, the current keys of A, B and C, and `amount` the price (an integer). Q has no
   timestamp and no total, so a regenerated transfer (new T, new priors) keeps the digest the owner approved; its keys
   are ASCII and its values strings and safe integers, so every implementation of `canonical()` agrees.

   Worked example (`circulation.json` `quote_digests` `worked-example-18.3`; first computed for this document with
   the `valun` package's `canonical()` and checked with a `JSON.stringify` one): the terms of `vectors/canonical.json` `terms/base` (payer alice, payee bob,
   price 20, `terms_hash` `5f7bccd0e836183a82fbab738a617faa25673c4ead77eeb3da94c7ef4c9e6003`), issuer carol (the test
   key `0265ad72…a2e124`) and `deliverable_sha256` = `sha256hex("example delivery")` =
   `d6823e3f1b084c3135394414d58c8da1bec863f96cdec489f123426d4085c9fc`. `canonical(Q)` (696 bytes) lists the keys in the
   order `amount`, `deal_id`, `deliverable_sha256`, `denomination`, `issuer_pubkey`, `kind`, `network`, `payee_pubkey`,
   `payer_pubkey`, `terms_hash`, `tracker_nft_id`, and `quote_digest` =
   `377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e`; the pay statement is then
   `valun-pilot/pay/1\nvd_0123456789abcdef\n377beb8f…782ad1e`, 102 bytes.

Refusing (declining a consent, cancelling a transfer) is authenticated by the agent token and never signed: a refusal
cannot move value.

### 18.4 Timestamps: residues and the ordinary clamp

Residues are allocated once for the whole roadmap, one per operation, so a signature made for one route is useless on
another:

| residue | operation | tracker `POST /notes` |
|---|---|---|
| 999 | transfer (`POST /notes/transfer`) | refused (`reserved_timestamp`) |
| 998 | set-off (`POST /notes/setoff`) | refused |
| 997 | bound note | accepted only with a valid issuer prior acknowledgment (18.5) |
| 996 | triad compress (later; not in v16) | refused |
| 995 | exchange (reserved) | refused |
| 000–994 | ordinary note | accepted, unless the edge is bound-only |

**The ordinary clamp**: `clamp(ts) = ts + (1000 − ts mod 1000)` when `ts mod 1000 ≥ 995`, else `ts` (the next whole
second, at most 5 ms later). Every source of ordinary note timestamps applies it when the tracker reports reserved
timestamps.

**How timestamps are chosen.** The server chooses them, clients check them (15.3 R3, R5), the tracker enforces them.
With `last` = the edge's last timestamp:
- ordinary template: `clamp(max(now − 1500, last + 1))`, then the wait-or-409 rule of 9.2;
- bound template: the largest ts with residue 997, ts ≤ now − 1500 and ts > last;
- transfer T: the largest ts with residue 999, ts ≤ now − 1500 and ts later than both edges' timestamps, than every
  live set-off's on either edge (D-2 b) and than the T of every transfer already recorded for the deal (audit R-1,
  valun-app `55510a9`), for a template and a regeneration alike (18.6 step 4);
- set-off ts_e: the largest ts with residue 998, ts ≤ now − 1500 and ts later than that edge's timestamp; edges between
  server-run parties get theirs when the set-off is applied.
When no such value exists yet, the server waits up to 3 s, else answers `409 note_timestamp_ahead` with
`retry_after_ms` (as in 9.2).

### 18.5 Bound notes

A 0.4 client signs every credit note together with an **issuer prior acknowledgment** of its edge's current total, and
the tracker applies the note only if that total is still the current one. Every edge a transfer or set-off changed is
**bound-only**: no other kind of note is accepted on it.

**Template.** `GET /deals/{id}/credit-note-template?prior=1&bound=1` (mode `bound` or above, else
`409 feature_unavailable`) returns the fields of 9.2 with `timestamp` chosen as in 18.4 (residue 997), plus
`prior_note` (the pair's EdgeState, or `null` when the edge does not exist; `prior_total` is then 0) and
`prior_message_hex` (`M(I,R,prior_total,timestamp)`, for information only).

**Signing.** At the template's timestamp ts the payer signs the note `M(I,R,prior_total+price,ts)` and the prior
acknowledgment `M(I,R,prior_total,ts)`, both rebuilt by itself (R1), after the checks of 15.2 and 15.3.

**Completion.** `POST /deals/{id}/complete` with `credit_note: {total, timestamp, signature, prior_total,
prior_signature}`. A timestamp with residue 997 makes it a bound note: `prior_total` and `prior_signature` are required;
`prior_total` MUST equal the tracker's current total for the pair (`409 stale_note`, with a fresh bound `template`);
`prior_signature` MUST verify over `M(I,R,prior_total,timestamp)` (`403 bad_signature`); the rest is as in 9.2. The
prior acknowledgment stays with the note (also while it is held for the owner) and goes to the tracker with it. Against
a v3 tracker this holds in every mode, while the other reserved residues are `409 stale_note` with a fresh ordinary
template (9.2); in mode `off` the server offers no bound template, and a client sends bound notes only to a server
that lists `bound_notes/1` (R12). Against an older tracker, mode `off` is exactly v15. A bound note older than the
maximum age (tracker v3.1) is `409 stale_note` with a fresh bound `template`; a held one released after it fails at the
tracker (`novation_expired`): the deal is `note_failed` with `credit_note.error_code` `novation_expired`, and the payer
signs a new bound note on the same prior at once (decision D-1 item 4, 18.8). The template also chooses a timestamp
later than every live set-off's on the pair (D-2 b).

**The tracker's rule** (POST /notes, after all its existing checks, so their precedence is kept):
- residue 995, 996, 998 or 999 → `400 reserved_timestamp`;
- residue 997: `prior_signature` is required (else `400 reserved_timestamp`); P = the stored total, or 0 when the edge
  is absent; a `prior_total` that is sent and differs from P → `409 stale_prior`; the **issuer's** signature over
  `M(I,R,P,ts)` must verify (`400 invalid_prior_signature`); the new total must be strictly greater than P
  (`400 not_an_increase`);
- any other residue on a bound-only edge → `400 bound_note_required`;
- `prior_signature` with a residue other than 997 → `400 invalid_request`.

**What it closes.** Finding F-B: an overcharge through a stale, higher prior after a decrease. If a set-off or a
transfer lowered A→C from 10 to 7 and a server still shows 10, an issuer that signs 10 + 3 believes it adds 3 but would
add 6; its acknowledgment of 10 fails at the tracker, which holds 7. Because novated edges are bound-only, this does
not depend on the server or on the client asking for a bound template: on such an edge an unbound note is refused, so
even with a lying server or a downgraded client an issuer cannot be made to pay twice. An acknowledgment can never
serve as a note, because a note must strictly increase the total and the acknowledgment's total is the stored one.
Bound notes also make a client's own record of what it issued non-critical for value (OPEN-QUESTIONS OQ-23).

### 18.6 Payment by debt transfer

B pays C for deal D with part of A's debt to B: A→B falls by the price and A→C rises by it. The payer chooses this
when it accepts the delivery; the terms do not change. It is not what the terms promise (a credit note from the
payer), so it happens only if the payee signs it: a payee that refuses, or cannot sign, gets the agreed credit note
later (the deal becomes `payment_due`, 18.10). Partial payment is refused in v16: the held claim must cover the whole
price (`409 insufficient_claim`).

**The seven slots** (tracker `POST /notes/transfer`, version 3). A slot key is `<edge key>:<slot>`, `<slot>` being
`prior` or `new`; below, `A`, `B` and `C` in a slot key stand for the three public keys:

| slot key | message | signer | tracker field |
|---|---|---|---|
| `A>B:new` | `M(A,B,X−a,T)` | A | `issuer_from_signature` |
| `A>C:new` | `M(A,C,Y+a,T)` | A | `issuer_to_signature` |
| `A>B:prior` | `M(A,B,X,T)` | B | `from_recipient_prior_signature` |
| `A>B:new` | `M(A,B,X−a,T)` | B | `from_recipient_signature` |
| `A>C:new` | `M(A,C,Y+a,T)` | B | `from_recipient_to_signature` |
| `A>C:prior` | `M(A,C,Y,T)` | C | `to_recipient_prior_signature` |
| `A>C:new` | `M(A,C,Y+a,T)` | C (always required) | `to_recipient_signature` |

**The tracker's checks**, all before any write, in this order: B ≠ C and A is neither; a > 0; residue 999; T ≤ now;
T ≥ now − 3 600 000 (`novation_expired`); no staged exchange on either pair (409); the from-edge exists (404); it has no
committed or pending on-chain total (`409 onchain_scope`); `from_prior_total` / `to_prior_total`, if sent, equal X / Y
(`409 stale_prior`); X ≥ a, X − a ≥ the redeemed amount, Y + a does not overflow, both totals ≤ i64::MAX; T later than
both edges' timestamps; both edges have the same tracker id; all seven signatures verify (`400 invalid_signature`); the
tracker's acceptance predicate (403). Effect, in one write: both notes (A→B stores A's `issuer_from` signature, A→C
its `issuer_to`), both confirmations, the index entries of a new edge, and both bound-only marks.

**Why the amount is exact.** The tracker computes from_new = sX − amt and to_new = sY + amt from its stored totals sX,
sY and the request's amt. B's prior acknowledgment verifies only if sX = X, and B's signature over the new from-total
then forces amt = a; C's prior acknowledgment verifies only if sY = Y. So B loses exactly a, C gains exactly a, and A's
total does not change (−a + a). B's signature over the to-edge binds its consent to this destination: without it, A and
the server could pair B's consent with a transfer to a key A controls. C's prior acknowledgment protects C from a payer
working with the server: if a note C does not know of had raised A→C to Y + d, B could sign a decrease of only a − d and
C's signature over Y + a would still match; C's acknowledgment of Y then fails. (Finding F-A, on `a00233d`: there the
five signatures cover only the new totals, so if the edges moved between signing and submission, whoever held the
signatures could move more of B's claim than B agreed to.)

**Same-issuer attempts do not exclude each other (audit VS-1).** Attempts to pay D with A's note that were built on
the same A→B state carry B's acknowledgment of the same total X, and C's of the same Y. The first to apply moves A→B to
X − a at its own T1, and a later one fails at the tracker as long as the edges stay moved. But the acknowledgments are
M(A,B,X,T) and M(A,C,Y,T), with no prior timestamp, and the tracker compares only the stored totals with them: if A
raises A→B back to X (a note to B) and C moves a out of A→C (a transfer or a set-off) between T1 and T2, an attempt at
T2 applies too, and B pays D twice. None of this needs B's signature. So a 0.4.0 client signs a retry through the same
issuer at once only as the identical operation (the same T; 15.3 R11), and any other attempt, a same-issuer retry at a
new T included, only once every earlier attempt is dead (18.8). The server still accepts a same-issuer retry at once
(step 8); binding the prior acknowledgments to the prior state's timestamp is a tracker change (v3.2; 16.2, item 12).
Whether an earlier attempt applied is decided by the server's read-back; what a client can check for itself is in
16.2, item 7.

**Flow.**
1. **Payment options.** `GET /deals/{id}/payment-options` (the payer's agent; deal `delivered`, `note_failed` or
   `payment_due`) → `{deal_id, price, payee, own_note: {available, why_not}, held_notes: [{issuer: {id, handle,
   pubkey, operator_run}, held, reserved, spendable, enough, payee_accepts, issuer_consents, payee_consents,
   why_not}], pending_transfer, fallback_after}`. `payee_accepts` is a boolean only (the payee's policy stays private).
   Consent speeds: `immediate` (server-run), `auto` (can sign that role and was seen in the last 10 minutes),
   `when_online`, `unavailable`. `spendable` is what B holds on A's current key → B's current key, minus reservations;
   it is 0 unless that edge reconciles exactly (18.14) and A can sign as issuer.
2. **Template.** `GET /deals/{id}/transfer-template?issuer=<vp id>` → `{deal_id, terms_hash, deliverable_sha256,
   issuer, payer, payee (each {id, handle, pubkey}), amount, timestamp, from_edge: {edge, before, new_total},
   to_edge: {edge, before, new_total}, tracker_nft_id, denomination, quote_digest, collect_until, messages}`: `amount` is the price;
   `timestamp` is T (18.4); `from_edge.before` is the EdgeState of A→B, `to_edge.before` that of A→C or `null`;
   `messages` maps each of the four distinct slot keys (`<A>><B>:prior`, `<A>><B>:new`, `<A>><C>:new`,
   `<A>><C>:prior`) to the hex of the message signed in it, for information only.
3. **The payer posts.** B's client checks the template (15.3), records the attempt before posting (R9) and calls
   `POST /deals/{id}/pay-by-transfer` with `{issuer_id, terms_hash, deliverable_sha256, quote_digest, timestamp,
   from_prior_total, to_prior_total, completion_signature, pay_signature, signatures: {"<A>><B>:prior": …,
   "<A>><B>:new": …, "<A>><C>:new": …}}`. `completion_signature` is over the `complete` statement (8.1): an
   unconditional acceptance of the delivery. `pay_signature` is over the pay statement (18.3).
4. **The server creates the transfer** `vt_…`: payer only; deal `delivered`, `note_failed` or `payment_due`. A post
   whose T is at or before the T of a transfer already recorded for the deal is `409 transfer_stale` with a fresh
   `template` (audit R-1: a retry never gets the (edge, T) of an earlier transfer that has its own id; posts refused
   before a transfer was recorded, D-2 b, do not count, since their T may be any the client signed). It re-reads
   both edges, whose totals must equal the posted priors (else `409 transfer_stale` with a fresh `template`); runs every
   check of 18.13 (`403 payment_not_accepted`, `409 insufficient_claim`); verifies all five of B's signatures against
   B's current key (`403 bad_signature`; `503 signer_unavailable`, nothing recorded); reserves both edges
   (`409 edge_busy` when another collecting novation, an `issuing_note` deal or a `completion_awaiting_owner` deal
   touches them); records the completion and `payment: {method: "transfer", transfer_id}`; and sets the deal
   `paying_by_transfer`, or `completion_awaiting_owner` with a `pay_by_transfer` approval when the payer's owner has
   `review_deliveries` on (18.11). Server-run A or C sign their slots at once; when every slot is filled the transfer is
   applied in the same request.
5. **Consents.** A signs `A>B:new` and `A>C:new`; C signs `A>C:prior` and `A>C:new` (18.9).
6. **Apply**, inside the server's lock: save the state `applying` (write-ahead); re-read both edges, whose total,
   timestamp and signature must equal `before` (else it fails with `edge_changed`); call `POST /notes/transfer`; read
   both edges back. The transfer **applied** if and only if A→B = (X − a, T, A's `A>B:new` signature) and A→C =
   (Y + a, T, A's `A>C:new` signature), whatever the tracker answered. Then: journal entries `transfer_out` (−a on A>B)
   and `transfer_in` (+a on A>C), the deal `paid_by_transfer`, receipts for all three parties (18.12).
7. **Not applied.** The deal becomes `payment_due` when the transfer expires (collection window 20 minutes), is refused
   by A or C, is cancelled by B (`POST /deals/{id}/cancel-transfer`, while collecting), finds an edge changed, is
   refused by the tracker (once a read-back shows the prior state), or is voided because a party's key was revoked
   (`void_key_revoked`). The acceptance stands, so no dispute is possible. The signatures are purged (their sha256
   kept), and `fallback_after` = T + 3 600 000 + 60 000.
8. **From `payment_due`.** A transfer with the same issuer may be retried at once only on the same acknowledged prior
   (the Retries paragraph below; decision D-1 item 2). Paying with another issuer, or with an own note, is refused until
   `fallback_after` (`409 transfer_window_open` with `retry_after_ms`; R11 waits a little longer). A stale same-issuer
   transfer is regenerated (new T, new priors) only while every check of 18.13 still passes, so a deal has at most 3
   transfer attempts in 24 hours, regenerations included (`max_attempts_per_deal`); the payer's slots then come back
   to it as a consent item with role `payer`. B's client (15.3 R11) re-signs by itself only the identical operation
   (the T of an attempt it recorded, within that attempt's window and under its quote): a regeneration at a new T is
   `transfer_window_open` while the earlier attempt may still apply and `stale_quote` after its window (audit VS-1,
   AI-1), so a payment made again after the window is a new `pay-by-transfer` (or another route); A and C re-sign under
   their own rules.
9. **Unknown outcome.** On a network error, a tracker 5xx or a timeout, the server reads both edges back at once; if
   that read fails too, the transfer stays `applying` (the deal `paying_by_transfer`) until recovery decides by
   read-back (18.8). A read-back that cannot decide ends it `outcome_unknown` (18.8).
10. **Edge reservation.** While a transfer collects signatures, both its edges are reserved for it alone: A's own
    credit-note template on either edge answers `409 novation_pending` with `consent_ids`, so A's client first signs or
    refuses the consent (server-run issuers defer such a payment to their next round).

Transfer states: `awaiting_owner`, `collecting`, `applying`, `applied`, and the ends without effect `failed`, `expired`,
`cancelled`, `refused`, `void_key_revoked`, `void_stale`, `void_rejected` and `void_expired` (18.11); the unresolved
ends `outcome_unknown` (the read-back cannot decide whether it applied) and `inconsistent` (one edge applied and the
other not: an alarm), which only the payer's owner resolves (18.8), to `applied` or `resolved_not_applied`. Tracker
refusals reach a client as `409 transfer_failed` (with the tracker's `code`) or `409 transfer_stale`, never as `502`;
`502 tracker_unavailable` means only that the tracker could not be reached. pay-by-transfer and cancel-transfer answer
with the deal view plus `transfer`. After an apply in the same request fails, pay-by-transfer answers
`409 transfer_failed {code, transfer_id, regenerated_as, deal}` or `409 transfer_stale` (with `template` when the post
itself was stale, and then nothing is recorded but the refused attempt, D-2 b); the state is saved either way. The
payer's body sends `to_prior_total` 0 for an absent A->C. Refusals before anything is recorded add `400 self_edge`
(issuer = payer), `400 pay_with_is_payee` (issuer = payee), `404 not_found` (unknown issuer), `400 invalid_field`
(malformed issuer or signatures), `403 bad_signature` (a slot, the completion or the pay statement does not verify for
the payer's registered key: a puppet destination or an amplified slot is refused so) and `403 payment_not_accepted`
(18.13).

**Retries (decision D-1 item 2).** The server accepts a transfer with the same issuer at once only while the held edge
is exactly the prior state the earlier attempt acknowledged. The tracker does not make the two exclusive (see "Same-issuer
attempts do not exclude each other" above), so a 0.4.0 client signs it at once only as the identical operation, at the
earlier attempt's T; at a new T it is `transfer_window_open` until the earlier attempt is dead (15.3 R11). Otherwise, and
for a regenerated transfer, the server answers `409 transfer_window_open` until the earlier attempt's `fallback_after`;
a client re-signs a regenerated transfer by itself only as the identical operation (step 8); a move of the held edge
past T to any state other than the attempt's new state is `attempt_outcome_unknown` (18.8).

**The same-issuer retry rule of the 0.4.0 clients** (Python and JavaScript; the Hermes plugin 0.4.0 once it re-vendors
this core; audit VS-1, AI-1). Inside an earlier attempt's window (until it is dead: T + 3 600 000 + 120 000 ms by the
client's clock, then read back at its prior state) a client makes no automatic same-issuer retry and signs no
regeneration at a new T: `pay_by_transfer` refuses a template at a new T (also the fresh one a `409 transfer_stale`
carries), and a payer consent for a regenerated transfer at a new T, with `transfer_window_open`. The only thing it
signs again by itself is the identical operation (the same T, edge and prior, under the same quote), which gives a
server nothing it does not already hold. After the window a regenerated payer consent is `stale_quote`: an approval
given for the earlier attempt never covers it (`approved_payments` and an approved quote digest can only refuse a
consent, never license one). The deal is then paid again only by a new `pay_by_transfer` (or another route), a new
commitment that goes through the profile's approval mode again, so under `ask`, `console` or `client-prompt` the owner
approves it afresh. With R-1 (step 4) a retry of an attempt the server recorded always gets a new T, so the identical
operation is posted again only for an attempt the server never recorded (D-2 b). The server (valun-app `55510a9`) still
accepts a same-issuer retry on the same acknowledged prior at once (step 8) and still regenerates stale transfers:
against 0.4.0 clients those regenerations end in refused consents and `payment_due`, which costs liveness, never value,
until the server applies `fallback_after` to them too.

### 18.7 Multilateral set-off

- Only the server's clearing engine proposes set-offs (`vs_…`), from cycles of debts (18.14). A proposal lowers each of
  its edges I→R by an integer d ≥ 1 such that, for every participant, the decreases where it is creditor add up to the
  decreases where it is issuer: no net position changes.
- For every edge it is party to, each member signs the slot `<I>><R>:new` = `M(I,R,P−d,ts_e)` (P = the edge's current
  total, ts_e with residue 998). Both the issuer and the creditor of each edge sign it. There are no prior
  acknowledgments.
- **The tracker** (`POST /notes/setoff`, version 3): 2–64 edges; distinct pairs; no self-edges; d > 0; per-key balance
  (in u128); the staged-exchange guard; no on-chain totals; the redeemed floor; one tracker id; per edge, residue 998,
  ts_e ≤ now, ts_e ≥ now − 3 600 000 (`novation_expired`) and ts_e later than the edge's stored timestamp; both
  signatures of every edge verified before any write; one write; a bound-only mark on every edge; unknown fields
  refused; each edge's timestamp echoed in the answer. An edge may carry its own `timestamp` (default: the request's),
  so that a moved edge can be re-signed alone and server-run parties can sign at apply time (capability
  `per_edge_timestamps`; a tracker that reports `false` takes one timestamp for every edge, and a whole proposal is then
  regenerated instead).
- **Why no prior acknowledgments.** The tracker refuses any set of edges that does not balance for every key, so every
  set-off it accepts, including one assembled from part of a proposal's signatures, leaves every key's net position
  unchanged; and each signature fixes its edge's final total.
- **A member signs only if** its own edges balance, every change is a decrease, the priors verify, the residue and
  freshness rules hold and its policy allows it (15.3).
- **Apply** works like a transfer's (write-ahead, re-read, tracker call, read-back): applied if and only if every edge
  equals (P − d, ts_e, the issuer's signature); journal entries `setoff` (−d each). A moved edge is regenerated on its
  own (new `before`, ts_e and `revision`; only its two parties re-sign, server-run roles at once); if an edge no longer
  has the amount, the proposal is `superseded`. Any refusal or expiry (collection window 30 minutes) ends the proposal:
  nothing applies without every signature.
- Set-off states: `collecting`, `applying`, `applied`, `failed`, `expired`, `refused`, `superseded`,
  `void_key_revoked`.
- A set-off never blocks a payment: a credit note on one of its edges makes that edge stale, and it is regenerated.

### 18.8 Maximum age, collection windows and the fallback rule

- The tracker refuses any transfer, any set-off edge and (tracker v3.1, decision D-1 item 1) any bound note whose
  timestamp is more than `NOVATION_MAX_AGE_MS` = 3 600 000 ms (1 hour) old. The value is compiled in. It bounds how
  long unapplied novation and bound-note signatures stay usable, whoever holds them. Ordinary notes have no maximum age.
  A held bound note released after the maximum age is refused (`novation_expired`): the deal is `note_failed` with
  `credit_note.error_code` `novation_expired`, and the payer signs a new bound note on the same prior (D-1 item 4);
  `complete` itself refuses a bound note older than the maximum age with `409 stale_note` and a fresh bound template.
- The server collects a transfer's signatures for at most 20 minutes (`transfer_ttl_ms`) and a set-off's for at most 30
  minutes (`setoff_ttl_ms`), both shorter than the maximum age, and applies expiry lazily on every read.
- **The fallback rule, across kinds (decision D-1).** A payment attempt is any payment the payer signed for deal D: a
  transfer, a bound note or an ordinary note. After one ends without effect (failed, expired, refused, cancelled,
  voided; a bound note failed, stale, rejected by the owner, voided by a revocation or replaced), its signatures could
  still be applied by whoever holds them until T + 1 hour. So no other kind of payment for D may be signed before then:
  the server refuses an own note or a transfer (template and post) until `fallback_after` = T + 3 600 000 + 60 000
  (`409 transfer_window_open` with `retry_after_ms`; next_actions offer `wait_for_transfer_window`), and a client MUST
  NOT sign one before T + 3 600 000 + 120 000 by its own clock (R11). An own ordinary note that could still be recorded
  (it never expires) blocks a transfer with `409 pending_unbound_note`, and next_actions never offer what the route
  refuses. A same-kind retry on the same prior is allowed at once (18.6). `void_rejected` and `void_stale` keep
  `fallback_after` while the same note on the same prior can be used at once.
- **Refused attempts are attempts (D-2 b).** A payment the payer posted and the server refused is recorded on the
  server, never shown: its kind, T, edges, prior and new totals and the sha256 of its signatures, at most 32 per deal
  (during a signature-checker outage, flagged `unverified`; audit `payment.refused_attempt`). It counts for the windows
  above and holds the payer's own edge against set-offs. A refused ordinary note at a residue tracker v3 reserves (995,
  996, 998, 999) is not an attempt: the tracker can never record it. Transfer and bound templates choose T later than
  every live set-off's `ts_e` on their edges.
- **Proven dead (D-2 e).** An attempt that Valun's own edge journal proves dead never blocks a payment: the first
  journal entry on its edge after its T changed the edge from exactly that attempt's prior total. The journal proves
  nothing unless the entries the server read cover every seq from 1 to `counters.edge_seq` (decision D-3 d): a gap (the
  log file lost or cut after the in-memory tail rolled over) marks it partial until the next start, and is logged and
  audited once (`journal.incomplete {where, missing_from, missing_to}`).
- **Unknown outcomes (D-1 item 3) and the owner's resolution (D-2 d).** A read-back that cannot decide (an edge moved
  past T to a total that is neither its prior nor its new total, or another state at T) ends the transfer
  `outcome_unknown` (an alarm in the log); mixed edges end it `inconsistent`. The deal is `payment_due` and every
  payment of it is refused with `409 attempt_outcome_unknown` until the payer's owner resolves it, after confirming with
  the payee: `POST /owner/deals/{vd}/attempts/{vt}/resolve {outcome: "not_applied" | "applied", note?}` (owner token of
  the payer; `note` at most 300 characters after trimming, no control, bidi or invisible characters). The route exists
  in modes sandbox and on, and, for an attempt that is `outcome_unknown` or `inconsistent`, in every other mode but
  `off` too: mode bound, and mode sandbox for a participant outside the sandbox (audit MIG-4, valun-app `55510a9`), so
  an attempt left over when the operator stepped back from `on` can still be resolved; in mode `off` it is the same
  `404` as any unknown route (v15). The v15 rollback check still refuses while any attempt is unresolved (Appendix H).
  `not_applied` ends it `resolved_not_applied` (signatures purged, sha256 kept; `fallback_after` = T + 3 600 000 +
  60 000). `applied` is accepted only while the payee's edge shows the transfer (audit SV-AUTH-1): its class at the
  read-back that left the attempt unresolved, else its state read again now, is the transfer's new state (`new`, or
  `applied_moved`: past T at the new total); otherwise the answer is `409 payee_edge_not_applied {payee_edge}`, the
  class the server read (`prior`, `changed`, `moved_past`, `unknown`), and nothing changes. Then it journals the
  transfer and the deal becomes `paid_by_transfer`. Both outcomes add the deal event `payment_attempt_resolved` and the
  audit line `transfer.resolved_by_owner`. The answer is `{resolution {attempt_id, outcome, previous_state, at, note},
  attempt {id, kind: "transfer", timestamp}, deal, transfer}`; errors `403 not_payer`, `404 not_found` (an unknown
  attempt, one of another deal, or an agent token), `409 wrong_state` (any state but `outcome_unknown` or
  `inconsistent`), `409 payee_edge_not_applied`, `400 invalid_field`. A 0.4.0 client (`Client.resolve_attempt`,
  `resolveAttempt`, `valun attempts resolve`) raises a `payee_edge_not_applied` answer with its reason in words and what
  the owner can do instead: resolve it as `not_applied` once the payee confirms that the payment did not arrive, or, if
  the payee says it arrived, ask the operator to look into it with the payee; extra `{payee_edge, next_steps:
  ["not_applied", "ask_operator"], local_possible: false, server}`. It offers no resolution in its own records only for
  this answer: recording the attempt as applied there would stop the client paying a deal that the payee may not have
  been paid for. Only payments by transfer (`vt_`) are resolved at the server: the server decides its own notes by its
  own read-back and never answers `attempt_outcome_unknown` for one, so a client resolves an own note's attempt in its
  own records only (needing the owner token, checked through `GET /owner`'s `participant.id`).
- **Recovery** runs at startup and every 60 s for every novation in `applying` (and applies one left `collecting` with
  every signature): every edge at its new state, or moved past T at its new total → applied; every edge at its prior
  state, with T within the maximum age → resubmitted; prior state with T expired, or an edge moved past T back at its
  prior total → failed; an edge moved past T at another total, or another state at T → `outcome_unknown`; a mix →
  `inconsistent`, with an audit alarm (one-write tracker batches make this impossible). A set-off held by a payment
  attempt (D-2 c, 18.16) is never resubmitted: it fails with `held_note` or `payment_attempt`. Reservations are
  released, and fallback payments allowed, only after a read-back shows that nothing applied. The same read-back runs
  in the request that applied when the tracker's answer is lost.

### 18.9 Consents

Clients sign their part of a transfer or a set-off through three agent routes; owners may read `GET /consents` but
never sign.

**`GET /consents`** records the poll (presence, 18.1) and may let the engine propose set-offs through the caller (at
most once per 30 s). Response (transcript step 171: nina, the payee of transfer T1, reads her consents; keys and
hashes shortened):

```json
{"consents": [{"kind": "transfer", "id": "vt_283b3ca1c2582819", "state": "collecting",
   "your_roles": ["payee"], "created_at": "2026-11-15T14:47:00.000Z", "expires_at": "2026-11-15T15:07:00.000Z",
   "network": "valun-pilot-1", "tracker_nft_id": "6869a94d…a0fa", "denomination": "token:01cb4b85…3274",
   "edges": [{"edge": "035e2b6f…e7b5>024f5a7b…15d6", "issuer": {"id": "vp_461ce015dd98", "handle": "alice"},
     "recipient": {"id": "vp_136ec9667207", "handle": "nina"}, "your_role": "creditor",
     "before": null, "change": 10, "new_total": 10,
     "timestamp": 1794754017999, "revision": 1, "slots": ["prior", "new"], "signed_by_you": []}],
   "context": {"amount": 10, "issuer": {"id": "vp_461ce015dd98", "handle": "alice"},
     "payer": {"id": "vp_9850bb41e214", "handle": "bob"}, "payee": {"id": "vp_136ec9667207", "handle": "nina"},
     "deal": {"deal_id": "vd_579a5ae4799dcf2e", "terms_hash": "b8929fd0…c779", "price": 10,
              "quote_digest": "bd243296…c93c"}},
   "summary": {"your_net_change_PC": 10, "your_total_owed_change_PC": 0}}],
 "recently_resolved": []}
```

In step 169 (alice, the issuer of the same transfer) `before` is an EdgeState `{total, timestamp, signature}` and
`context` has no `deal`; step 184 shows a `recently_resolved` entry, `{"kind": "transfer", "id":
"vt_283b3ca1c2582819", "state": "applied", "at": "2026-11-15T14:51:00.000Z"}`.

- `kind` is `transfer` or `setoff`; `your_roles` ⊆ {`payer`, `issuer`, `payee`, `member`} (`payer` only for a
  regenerated transfer, 18.6 step 8).
- Per edge: `your_role` is `issuer` or `creditor`, or `payer` for the payer's destination slot on the to-edge;
  `before` is the EdgeState, or `null` for an edge that does not exist yet (prior total 0); `change` =
  `new_total − before.total` (negative for a decrease); `timestamp` is T or ts_e; `revision` counts regenerations of
  that edge; `slots` are the caller's slots on it, `signed_by_you` those it has already signed.
- `summary` is advisory (the client recomputes it): `your_net_change_PC` = the changes where the caller is creditor
  minus those where it is issuer; `your_total_owed_change_PC` = the changes where it is issuer.
- **What each party sees: only its own edges.** The payee sees A→C and the deal; the issuer sees its two edges, the
  amount and both creditors, never the deal (no `context.deal`); the payer, on regeneration, sees both edges and the
  deal. No message hex and no other party's signature is ever included.

**`POST /consents/{id}`** `{signatures: {"<edge>:<slot>": <signature>, …}, revisions: {"<edge>": <n>, …}}`:
- it takes all of the caller's unsigned slots on the item, or none (`400 invalid_field`);
- each signature is checked (`safeVerify`, section 6) against the caller's current key, over the message the server
  rebuilds for the edge's current revision: one that does not verify is `403 bad_signature` and nothing is recorded
  (`503 signer_unavailable`: nothing recorded either);
- a slot signed for an older revision is not an error: it is listed in `rejected` (`[{slot, code: "stale_revision",
  revision}]`, with the current revision) and the caller signs again;
- the caller's checks (18.13) run again (`403 payment_not_accepted`);
- the last missing signature makes the server apply the novation within the request;
- the response is the item as `GET /consents` would now show it (its `state` may already be `applied` or `failed`),
  plus `rejected`.
Errors: `404 not_found` for an unknown id and for a non-party alike; `409 wrong_state` when the item is no longer
collecting.

**`POST /consents/{id}/refuse`** `{reason?}`: the reason must pass the refused-character test (2.3; `400 invalid_field`)
and be at most 300 UTF-16 code units. Not signed. A refused transfer ends (`refused`) and its deal becomes
`payment_due`; a refused set-off ends and starts a 24-hour cooldown for that member and edge set.

### 18.10 Deal statuses and transitions

| status | meaning | committed | terminal |
|---|---|---|---|
| `paying_by_transfer` | a transfer for this deal collects signatures or is being applied | yes | |
| `paid_by_transfer` | the tracker applied it: A owes C the price that A owed B; B issued no credit note for this deal (an outstanding obligation, not settled) | | yes |
| `payment_due` | the payer accepted the delivery (signed) but no payment applied; the payer must still pay; no dispute is possible | yes | |

In the inbox, the payer finds `payment_due` deals under `review_delivery` and both parties find `paying_by_transfer`
deals under `waiting_on_others` (the payee also `payment_due` ones); `paid_by_transfer` deals go to `recent_closed`.

Transitions, in addition to 10.2 (circulation on):

| from | act | who | server checks | to |
|---|---|---|---|---|
| `delivered`, `note_failed`, `payment_due` | pay by transfer | payer | 18.6 step 4; from `payment_due` with another issuer only after `fallback_after` | `paying_by_transfer` (`paid_by_transfer` in the same request when every other slot is server-signed); or `completion_awaiting_owner` with a `pay_by_transfer` approval if the payer's `review_deliveries` |
| `completion_awaiting_owner` (`pay_by_transfer`) | approve | payer's owner | 18.11 | `paying_by_transfer` or `paid_by_transfer`; if stale, `delivered`, or `payment_due` when it came from there (`409 stale_payment`) |
| `completion_awaiting_owner` (`pay_by_transfer`) | reject | payer's owner | — | `delivered` (the completion is cleared), or `payment_due` when it came from there (the acceptance stands) |
| `completion_awaiting_owner` (`pay_by_transfer`) | any party's key revoked | owner | — | `delivered`, or `payment_due` when it came from there (transfer `void_key_revoked`) |
| `paying_by_transfer` | the last signature, and the read-back shows the transfer | server | 18.6 step 6 | `paid_by_transfer` |
| `paying_by_transfer` | expiry, refusal, `cancel-transfer`, a changed edge, a tracker refusal, any party's key revoked | server, A, C, B, an owner | — | `payment_due` |
| `payment_due` | complete (own note) | payer | 9.2, and now ≥ `fallback_after` (`409 transfer_window_open`) | `issuing_note` → `note_issued` / `note_failed`; or `completion_awaiting_owner` (`issue_note`) if the payer's `review_deliveries` |
| `completion_awaiting_owner` (`issue_note`, reached from `payment_due`) | reject | payer's owner | — | `payment_due` (the acceptance stands) |

A dispute stays possible only from `delivered`. Expiry is lazy (on every read), so it survives the server being
stopped.

### 18.11 The `pay_by_transfer` approval

- Created when the payer posts a payment by transfer while its owner has `review_deliveries` on: the deal is
  `completion_awaiting_owner`, the transfer `awaiting_owner`, and the approval is bound to the deal like `issue_note`.
  `approve_above` does not apply to payments (as for notes).
- `subject`: `{what: "payment_by_transfer", terms, terms_hash, delivery, transfer: {issuer, payer, payee, amount,
  from_edge, to_edge, timestamp, quote_digest}, statement, signature}`.
- `effect.if_approved`: "The transfer is submitted once `<issuer>` and `<payee>` sign: `<issuer>` then owes `<payee>`
  `<a>` PC more and you `<a>` PC less; you issue no credit note."; `effect.if_rejected`: "Nothing moves. The deal
  returns to delivered: your agent may accept again (paying another way: with its own credit note or another issuer's
  note only after <fallback_after>, since the tracker could still apply this payment until one hour after its
  timestamp; with the same note at once) or dispute." (for a deal that came from `payment_due`: "Nothing moves. The
  deal returns to payment_due: the delivery stays accepted, and your agent must still pay it (with its own credit note
  or another issuer's note only after <fallback_after>, …; by transfer with the same note at once).", 18.16);
  `effect.checks_on_approve`
  names the re-validations below.
- **Approve** re-validates both edges (total, timestamp and signature equal `before`), the current keys and every check
  of 18.13. If anything is stale, the approval becomes `void_stale`, the transfer `void_stale` (purged), the deal
  returns to `delivered` (or to `payment_due` if it came from there), and the request fails with `409 stale_payment`. Otherwise the transfer starts collecting
  (server-run roles sign) or is applied at once.
- **Reject** voids the transfer (`void_rejected`, purged) and returns the deal to `delivered` with the completion
  cleared, or to `payment_due`, the completion kept, if it came from there.

### 18.12 Visibility, withholding and receipts

- A transfer is visible to A, B and C and their owners: `GET /transfers/{vt}`, the consents (18.9) and, for B and C,
  the deal view. A sees the amount and both creditors, never the service or the delivery; C sees its own edge and the
  deal.
- A set-off proposal (`GET /setoffs/{vs}`) is visible only to its members, and each sees only its own edges.
- Anyone else gets the same `404 not_found` as for an unknown id.
- **Withholding** (I-WITHHOLD): until the tracker records a novation, no response contains a signature collected from
  another party; the signatures of a novation that ends without applying are purged (their sha256 kept); signatures
  are never logged (audit lines carry ids, edge keys, totals and signature sha256 only). The deal view's
  `payment.signatures_withheld` says so.
- **Receipts**: once a novation applied, each party sees, in `GET /transfers/{vt}` or `GET /setoffs/{vs}`, every
  signature on the edges it is party to, so it can check the new totals itself.
- **Public**: `GET /clearing` shows aggregates only (18.14). The public ledger (14.3) keeps v15's rows in every mode,
  circulation `sandbox` and `on` included (owner decision 9; audit SV-PRIV-1, valun-app `55510a9`): it already shows
  every edge total (16.2), and its `reconciliation` rows add none of the journal columns (`expected_total`, `set_off`,
  `transferred_in`, `transferred_out`, `exact`), so no public row shows an edge's transfer or set-off history.
  `issued_via_valun` is the journal's expected total. Whether an edge reconciles exactly is shown only to its parties,
  per edge, in `GET /edges` (`exact`, 18.14).

### 18.13 Credit policy and the server's checks

Owner mandate fields, validated and stored only in mode `sandbox` or `on` (in other modes they are ignored like any
unknown field, and `DEFAULT_MANDATE` never changes). Defaults:

| field | type | invited joiner | existing participant | sandbox joiner | sandbox agents |
|---|---|---|---|---|---|
| `auto_clear` | boolean | `true` | `false` | `true` | `true` |
| `novate_own_debt` | boolean | `true` | `false` | `true` | `true` |
| `accept_transfers` | boolean | `false` | `false` | `true` | `true` |
| `accept_notes_from` | `"any"` or a list of participant ids (`[]` = nobody; never derived from `counterparties`) | `[]` | `[]` | the sandbox agents | `"any"` |
| `refuse_notes_from` | a list of participant ids | `[]` | `[]` | `[]` | `[]` |
| `pay_with_held_notes` | `"never"`, `"when_asked"` or `"prefer"` | `"when_asked"` | `"never"` | `"when_asked"` | `"never"` (sandbox-exact), `"prefer"` (sandbox-mallory) |

"Existing participant" = one that joined before circulation was enabled. A `sandbox_only` owner can only narrow these
fields, and `accept_notes_from` must stay a list of sandbox agents (`403 sandbox_only`). Phase 2, the first part to cut
if time runs short (OPEN-QUESTIONS OQ-47): `max_claims_total` (null or 0–100000; 40 for sandbox joiners),
`max_issuer_net_debt` (null or 0–100000; a one-level haircut over reconciled edges only), `accept_operator_issuers`
(boolean, default `true`). `max_accept_per_issuer` and `min_payer_coverage_pct` are judged on the issuer of the note
received; `review_deliveries` holds a payment by transfer (18.11).

**Checks**, run when a novation is created, at every consent and again right before it is applied (a mandate that
changed in between fails it with `mandate_changed`); a refusal records nothing:
- **paying** (B): `pay_with_held_notes` is not `never`; the mandate has not expired; at most 2 collecting transfers as
  payer; at most 3 attempts per deal per 24 hours;
- **receiving** (C, from issuer A, amount a): `may_accept_credit` and `accept_transfers`; A is in `accept_notes_from`
  (or it is `"any"`) and not in `refuse_notes_from`; `counterparties` allows A; the mandate has not expired; C's
  tracker claim on A + committed deals with payer A and payee C + collecting transfers from A to C + a ≤ the effective
  `max_accept_per_issuer`; if `min_payer_coverage_pct` > 0, A's coverage (11.3, computed without adding a, since A's
  total does not change) is at least that; C can sign as `creditor`;
- **novating issuer** (A, toward C): active with its current key; the mandate has not expired; `novate_own_debt`;
  `counterparties` allows C; A can sign as `issuer` or is server-run;
- **clearing member** (P): active with `auto_clear`; the mandate has not expired; can sign `setoff` or is server-run;
  not in a cooldown.

Refusals: `403 payment_not_accepted` with `rule` and `by` (`payer`, `payee` or `issuer`, and in a consent also `member`;
rule names only, the policy itself stays
private), `409 insufficient_claim`, `409 edge_busy`. Edges under past keys are frozen: they still count in positions
but cannot be spent or cleared (OPEN-QUESTIONS OQ-46).

**Who asks the owner.** A payment by transfer: yes, it is a commitment. A set-off consent: never, it is net-neutral.
An issuer consent: never, the issuer's total does not change and `novate_own_debt` governs it. Being paid by transfer:
never, `accept_transfers` and `accept_notes_from` are the owner's standing rule and the client's creditor role is
opt-in. Refusing: never. Changing the policy: the owner only. Sandbox agents never wait for an owner.

### 18.14 Routes, edges, reconciliation, positions and clearing

All under `/pilot/v1`. The existing per-IP and per-token budgets apply (14.2), and each route answers `404 not_found`
when the effective mode does not allow it.

| route | who | what |
|---|---|---|
| `GET /deals/{id}/payment-options` | agent (payer) | 18.6 step 1 |
| `GET /deals/{id}/transfer-template?issuer=<vp id>` | agent (payer) | 18.6 step 2 |
| `POST /deals/{id}/pay-by-transfer` | agent (payer) | 18.6 steps 3–4; → view |
| `POST /deals/{id}/cancel-transfer` | agent (payer) | while collecting; → view (`payment_due`) |
| `GET /deals/{id}/credit-note-template?prior=1&bound=1` | agent (payer; existing route) | 9.2, 18.5 |
| `GET /consents`, `POST /consents/{id}`, `POST /consents/{id}/refuse` | agent (owners: `GET` only, read-only) | 18.9 |
| `GET /transfers/{vt}`, `GET /setoffs/{vs}` | the parties, agent and owner | 18.12 |
| `GET /edges?since=<seq>` | agent and owner (mode `bound` or above) | the caller's edges and journal, below |
| `GET /clearing` | public (cached 10 s) | aggregates, below |
| `POST /admin/clearing/run`, `GET /admin/clearing` | loopback admin (14.3) | engine diagnostics |

**`GET /edges`** → `{incoming, outgoing, journal, next_seq}`. An edge row is `{edge, issuer: {id, handle}, recipient:
{id, handle}, issuer_pubkey, recipient_pubkey, total, timestamp, signature, exact, bound_only, reserved, frozen}`
(`frozen`: either key is a past key). `journal` lists the entries on the caller's edges after `since`, at most 200:
`{seq, at, kind, ref, edge, issuer_pubkey, recipient_pubkey, delta, total_after, timestamp, signature}` with `kind` ∈
`issue`, `transfer_out`, `transfer_in`, `setoff`, `backfill`. A client verifies every row's signature (R2) and uses the
rows to resolve its pending records.

**Edge journal and reconciliation** (I-RECON). The server keeps, for every edge it touched, the total expected from its
own events (notes, transfers, set-offs; backfilled once from `note_issued` deals). The public `GET /ledger`
`reconciliation` keeps v15's rows in every mode: their shape, fields and three statuses, with `issued_via_valun` = the
journal's expected total, which equals v15's sum of issued prices while nothing has been novated (audit SV-PRIV-1). The
journal columns are not public: with circulation `sandbox` or `on` the server's own reconciliation adds, per edge,
`expected_total`, `set_off`, `transferred_in`, `transferred_out` and `exact` (the tracker's total, timestamp and
signature equal Valun's last event on that edge), and gives Valun-only edges the same shape as tracker edges, for its
own reads only. `exact` reaches a party per edge, for its own edges, in `GET /edges`. The engine and `spendable` use
only edges that are `match` and `exact`. (Before the audit, release v16 at `cfe698b` served those columns on the public
ledger in modes `sandbox` and `on`.)

**Positions and the inbox** (circulation `sandbox` or `on`). Positions add `gross`, `cleared_by_setoff`,
`transferred_in`, `transferred_out`, `novated_as_issuer`, `spendable_notes` (`[{issuer_id, issuer_handle,
issuer_pubkey, outstanding, reserved, spendable, issuer_consents}]`), `frozen_claims`, `pending`
(`{paying_by_transfer, consents_waiting_for_you, consents_waiting_for_others}`), the deal buckets `paid_by_transfer`
and `payment_due`, ids and public keys on the claims and debts rows, and `settled` = `cleared_by_setoff` (16.1). The
inbox adds `consents_waiting_for_your_client` (a count) and `payments_in_progress`; non-deal items never go into the
deal lists.

**The clearing engine** (server-side; its choices are not normative: a client checks each proposal, 15.3, never how it
was chosen). It looks for cycles of 2–6 edges among eligible edges (both keys current, both parties pass the member
check, the reconciliation row `match` and `exact`, at least 1 PC available after reservations, no deal on the pair
`issuing_note` or `completion_awaiting_owner`), after every increase and in a bounded batch every 10 minutes. It
proposes only cycles whose client members are present; at most 3 collecting proposals per client participant and 50 in
all; at most 16 edges and 8 parties per proposal; cooldowns of 6 hours after an expiry or a failure and 24 hours after a
refusal; three expiries in a row exclude a participant for 24 hours. A client member that has not signed a set-off
since its last expiry it left unsigned (one that never signed included) is in at most 1 collecting proposal
(`max_collecting_per_unproven`), and proposals with such a member are at most 40 of the 50
(`max_collecting_unproven`, 4/5 of `max_collecting_total`), so members that never sign cannot hold the whole cap; a
cycle with a member already at its cap is dropped before selection (audit SV-DOS-1, valun-app `55510a9`). Cycles among
server-run parties only are applied at once.

**`GET /clearing`** (public, no identities): `{as_of, unit, tier: "pure_credit", engine: {enabled, interval_ms, limits,
last_run: {at, reason, eligible_edges, excluded}}, graph_now: {participants_with_positions, edges, gross_PC,
net_floor_PC, clearable_mtcs_PC, clearable_within_limits_PC, bound_gap}, totals: {setoffs_applied, cleared_PC,
edges_closed, transfers_applied, transferred_PC}, last_7_days: {issued_PC, cleared_PC, liquidity_saving_pct,
capacity_restored_PC}, proposals: {collecting, applied, stale, expired, refused, failed, completion_rate_pct,
median_ms_to_apply}, cycles_by_length, sandbox: {dormant_PC}}`. `net_floor_PC` = Σ max(0, owes − claims) over
participants; `clearable_mtcs_PC` = the maximum circulation of the graph (a min-cost flow; `null` above 5000 edges);
`liquidity_saving_pct` = cleared / issued; `capacity_restored_PC` = the sum of the reductions in what participants owe.
`engine.limits` lists the limits the engine works within (engine choices, not normative; a client never relies on
them): among them `max_collecting_per_participant` (3), `max_collecting_total` (50) and, since the audit (valun-app
`55510a9`; the vectors of `cfe698b` do not have them), `max_collecting_per_unproven` (1) and `max_collecting_unproven`
(40).

### 18.15 Sandbox circulation

In mode `sandbox` or `on` the server's sandbox agents (sandbox-exact X and sandbox-mallory M; the operator holds their
keys) also buy, pay with notes, accept transfers and sign set-offs. The server signs for them at apply time, keeping
its own one-operation-per-(edge, timestamp) record, so their consents are `immediate`. They:
- send every new `sandbox_only` participant one welcome job (X buys text-stats of a fixed welcome text for 3 PC; offer
  open 24 hours, delivery within 48 hours);
- buy strangers' text-stats and notary offers at no more than list price: at most 3 purchases per stranger per 24
  hours, text at most 4000 bytes, and none once the stranger's claims on the sandbox agents plus the price would exceed
  20 PC;
- check every delivery exactly (the first fenced `json` block must equal the computed result) and otherwise dispute,
  naming the first field that differs;
- pay with a bound note, or (M) with sandbox-issued notes it holds when they cover the price and the payee accepts them
  and is present;
- issue at most 1000 PC outstanding each, not counting debt to sandbox participants whose sandbox time has ended
  (reported as `sandbox.dormant_PC`);
- carry `operator_run: true` on their participant record and credit history.
There is no synthetic float and no trading between the sandbox agents. With the mode `off` or `bound` they behave as in
v15, apart from the always-on fixes of Appendix H.

**The stranger's tour** (S = a sandbox joiner with a 0.4 client; tracker totals; asserted by valun-app
`test/sandbox-circulation.test.mjs`):

| step | action | edges after | S holds / owes |
|---|---|---|---|
| 1 | the welcome job: X buys text-stats from S (3); S delivers the exact result; X pays with a bound note | X→S 3 | 3 / 0 |
| 2 | S buys notary from M (2), disputing a wrong delivery and trying again; it pays with `pay_with=sandbox-exact`; X and M sign at once | X→S 1, X→M 2 | 1 / 0 |
| 3 | S buys notary from X (2) with its own bound note; the 2-cycle S→X→S (1) is proposed at S's next consent call and S's client signs | X→S 0, S→X 1, X→M 2 | 0 / 1 |
| 4 | S sells text-stats to M (3); M holds only 2 of X's notes, so it pays with its own note; the 3-cycle M→S→X→M (1) clears at S's next poll | M→S 2, S→X 0, X→M 1 | 2 / 0 |
| 5 | S buys notary from X (2) with `pay_with=sandbox-mallory`; then the server-only 2-cycle X↔M (1) clears | M→S 0, M→X 1, X→M 0 | 0 / 0 |

Over the tour S earns 6 PC and spends 6 PC: 4 by transfer and 2 with its own note; 2 PC of its claims and 2 PC of its
debts are cancelled by set-off, and no set-off changes its net position.

### 18.16 Details of the release v16 implementation

Sections 18.1-18.15 state the contract; this section records what the release v16 implementation (valun-app
`cfe698b`; the `valun` package 0.4.0 at valun-open `4310103`, `@fitzdoud/valun` 0.4.0 at `fc58e8d` and the Hermes
plugin 0.4.0 at `2b78a06`) does where they are silent or less precise. Where it says MUST, it is
part of the contract; the rest describes the server so clients know what to expect.

**Set-offs and payment attempts (18.7, decision D-2 c).**
- An edge is not eligible for clearing while an earlier payment attempt of a deal that is neither paid nor ended would
  change it: every transfer of the deal that is neither live nor applied (both its edges, at T), and every credit note
  the payer signed for it that the tracker has not recorded (held, issuing, failed, stale, rejected by the owner, voided
  by a revocation or replaced; on payer>payee at the note's timestamp). The hold lasts until the deal is paid or ends.
- A collecting set-off that has an edge with a held note or a payment attempt ends `superseded` at once, with code
  `held_note` or `payment_attempt` (no cooldown); recording a refused attempt supersedes one too. A set-off made before
  such an attempt applies only if its `ts_e` on that edge is earlier than every such attempt's timestamp. A held note
  whose timestamp precedes a set-off's on its pair (a template fetched less than about 1 s after the set-off was made)
  supersedes that set-off (`payment_attempt`); a set-off whose timestamp precedes a held note's still applies, and the
  held note becomes `void_stale` at its owner's decision, so the payer waits about an hour (`transfer_window_open`)
  before a new note with the new prior.
- Set-off states add `inconsistent` (an alarm; counted under `proposals.failed` in `GET /clearing`). Supersession
  codes: `insufficient`, `not_reconciled`, `edge_changed` (without per-edge timestamps), `timestamp_ahead`,
  `held_note`, `payment_attempt`. Failure codes: `mandate_changed` (with `rule`), `circulation_off`, `not_balanced`,
  `edge_changed` (the read-back shows the edge moved without it), the tracker's code after a 4xx with nothing changed,
  `novation_expired`, `key_revoked`, `held_note` and `payment_attempt`.
- While a set-off is being applied its edges are busy: credit notes, templates and transfers get `409 edge_busy`, a
  complete set-off sharing one of the edges waits, still collecting, no new one is proposed on them, and payment options
  show `why_not` `edge_busy`. A server-only set-off edge made again never reuses its own earlier timestamp.
- Without per-edge timestamps every edge takes one timestamp when the proposal is made, and a moved edge supersedes the
  proposal (`edge_changed`); the engine proposes the cycle again on a later trigger.
- A refusal starts a 24-hour cooldown keyed by the member and the edge set (and by the edge set of each cycle packaged
  in it); who refused and why are kept for the operator only.

**Consents (18.9).**
- The item shapes. Transfer: `your_roles` names one role; the issuer sees both edges and the amount, never the deal;
  the payee sees A->C and the deal; the payer (a regenerated transfer) both edges and the deal. Set-off: `your_roles`
  `["member"]`, slots `["new"]` on each of the caller's edges, `context {amount}` (what it clears of the caller's
  claims; no issuer, payer, payee or deal), `summary {your_net_change_PC: 0, your_total_owed_change_PC}`. A transfer
  item is listed only while the caller has an unsigned slot on it.
- `POST /consents/:id` answers 200 with the item and `result` (even when the apply in that request failed or was left
  applying) and `rejected`; `POST /consents/:id/refuse` answers the item and `result {code, at, tracker_status?}`. New
  errors: `409 already_signed` (no unsigned slot left) and `409 key_changed`. A consent whose caller's own check fails
  ends the novation (`failed`, `mandate_changed`, `result.rule`) and answers `403 payment_not_accepted {rule, by}`, where
  `by` may also be `member` or `payer`; for a member, the consent and the check before apply look only at what its owner
  controls (active, `auto_clear`, `expires_at`), not at the consent-role declaration or a cooldown.
- The payee's `deal_mismatch` (R7) also requires that the deal view's `payment.transfer_id` is the item's id and that
  the terms name the payee's current key.
- A client posts only its unsigned slots, with the revision of each edge it signs on; the refuse body is
  `{reason: <refusal code>}` (`{}` without one), the cancel-transfer body `{}`. Items with nothing left to sign, not
  collecting, whose deal cannot be read now, whose post fails, or answered with stale revisions wait for a later run;
  they are not refused. What a client reports or logs of a server answer it copies only in a checked form: ids as
  `^v[dts]_[0-9a-f]{16}$`, kinds and roles from their lists, codes and states as `^[a-z_]{1,40}$`, else null.

**Statuses, approvals and next_actions (18.10, 18.11, 10.4).**
- Any held approval reached from `payment_due` (an `issue_note` or a `pay_by_transfer` approval) returns the deal to
  `payment_due` on reject, `void_stale` and key revocation, and keeps the completion; `if_rejected` has a
  `payment_due` text, and names the D-1 wait.
- A transfer awaiting its owner expires 20 minutes after it was created (when the agent posted it): the approval
  becomes `void_expired` and the deal returns to `delivered` (or `payment_due`). An approved one collects for at most
  20 more minutes and never past T + 50 minutes; `503 signer_unavailable` leaves the approval pending. If the window
  passes during the decision, the decision answers `409 not_pending` ("approval is void_expired") and changes nothing;
  the same answer comes when a deal or offer expired during the decision's mandate checks (every mode, every kind).
- Approve answers `200 {approval, deal, transfer}`, even when the transfer applied in that request fails at the tracker
  (`transfer.state` `failed`, `transfer.result {code, at, tracker_status}`, the deal `payment_due` with its completion
  standing; after an edge change the transfer is made again, `regenerated_from` naming the approved one). A stale one
  answers `409 stale_payment {reason, rule?, by?, transfer_id, deal_status}`, reason one of `circulation_off`,
  `key_changed`, `edge_changed` (total, timestamp or signature), `quote_changed`, `payment_not_accepted` (with `rule`
  and `by`: payer, payee or issuer; `sandbox_only` included), `edge_busy`, `insufficient_claim`,
  `transfer_window_open`, `attempt_outcome_unknown`, `already_paid`, `pending_unbound_note`; the deal returns to
  `delivered`, or to `payment_due` if it was there. With circulation off (or in mode bound) a pending `pay_by_transfer`
  approval is still listed; approving answers `stale_payment` with reason `circulation_off`, rejecting voids it.
- The `pay_by_transfer` subject adds `version`, `signer`, `signer_pubkey`, `signed_at`, `mandate_check`, `completion
  {statement, signature}` and `transfer {id, state, expires_at}`; parties are `{id, handle, pubkey}`, edges `{edge,
  issuer, recipient, before, new_total, change}`. A bound note's `issue_note` subject adds `bound`, `prior_signature`
  and `expires_at` (T + 1 h), and `if_approved` a bound sentence (also in mode bound).
- next_actions: `[]` while an earlier attempt's outcome is unknown or one applied (`already_paid`); `delivered` with a
  window open gives `[wait_for_transfer_window, pay_by_transfer, dispute]`; `pay_by_transfer` appears only when the mode
  allows it for both parties and `pay_with_held_notes` is not `never`, and never while an own note could still apply;
  `cancel_transfer` only while collecting; `note_failed` with the payer's bound note still in its window gives
  `[complete, wait_for_transfer_window]`.
- The deal history events are `payment_by_transfer`, `payment_awaiting_owner`, `paid_by_transfer`, `payment_due`,
  `payment_void`, `payment_outcome_unknown`, `payment_by_transfer_regenerated` and `payment_attempt_resolved`, and the
  owner events with kind `pay_by_transfer`; set-offs add none (the names `transfer_created`, `transfer_applied`,
  `transfer_failed`, `transfer_expired` and `setoff_applied` are not used).
- A failed bound note's `credit_note.error` is, in modes bound, sandbox and on, the server's own sentence "the tracker
  did not record the note (HTTP <status>[, <code>])", with `credit_note.tracker_status` and `error_code` (decision D-2
  f); mode off keeps v15's text.

**Views and receipts (18.12).**
- `GET /transfers/:vt`: `id, kind, state, your_roles, attempt, regenerated_from, regenerated_as, created_at, expires_at,
  updated_at, timestamp, amount, issuer, payer, payee`; `edges` (issuer and payer both, payee only A->C); `deal` (payer
  and payee only); `result`, `fallback_after`; `signatures` null until applied, then per party (A all seven; B the A->B
  slots and its own A->C slot; C the A->C slots); `signatures_withheld`, or `tracker_after` once applied; and
  `signature_sha256` of each purged signature. `tracker_after`, `signature_sha256` and the read-back classes of an
  edge go only to that edge's parties.
- `GET /setoffs/:vs`: `id, kind, state, your_roles, created_at, expires_at, updated_at, applied_at, edges` (the
  caller's own), `summary, result, signatures` (applied: own edges only; else null), `tracker_after` or
  `signatures_withheld`, `signature_sha256` (own edges, once purged). Other members see only `result.code` and `at`.
- The deal view's payment block is present in every view in modes sandbox and on (null when no transfer was
  attempted); `signatures_withheld` is null once applied. `credit_note.pair_changes_since` lists `[{kind, ref, delta}]`
  over transfer_out, transfer_in and set-off entries (`[]` for a note not recorded).
- Novation records are pruned (design 11): ended ones 7 days after ending (a transfer of a deal not yet paid stays,
  without its signatures); applied ones drop their signatures after 30 days; unresolved ones stay.

**Credit policy (18.13).**
- `payment_not_accepted` also has `by: "payer"` (rules `pay_with_held_notes`, `expires_at`,
  `max_collecting_transfers`, `max_attempts_per_deal`); the receiving check also counts the payee's own open offers to
  the issuer (exposure `reserved`).
- Phase-2 fields (modes sandbox and on; ignored in other modes): `max_claims_total` and `max_issuer_net_debt` (null or
  0..100000), `accept_operator_issuers` (boolean); absent means null, null, true, and `max_claims_total` 40 for a
  `sandbox_only` participant. A sandbox owner may lower `max_claims_total` but not raise it above 40 or set null
  (`403 sandbox_only`); the operator may. For a `sandbox_only` participant whose mandate predates the field,
  `credit_policy` and `effective_limits` (`/me`, `/owner`) show the enforced 40, and an agent limit below it shows in
  `effective_limits`; the stored mandate is unchanged.
- The rules, in order: `refuse_notes_from` (also at an agreement: `403 mandate_exceeded`, rule `refuse_notes_from`),
  `accept_notes_from` (transfers only), `accept_operator_issuers` ("operator-run": the server signs for the
  participant), `max_accept_per_issuer`, `max_claims_total`, `max_issuer_net_debt`.
- `max_claims_total` counts each payment once: the claims on the tracker; committed deals as payee, leaving out the deal
  being agreed or paid and any deal with a live transfer to the payee (awaiting_owner, collecting or applying); live
  transfers to the payee, leaving out the one being checked and any transfer for the deal being agreed or paid; and the
  amount. An `outcome_unknown` or `inconsistent` transfer is not live, so its deal counts as committed. Its own open
  offers are not counted.
- `max_issuer_net_debt`: q(I) = 1 if owes(I) = 0, else min(1, claims(I)/owes(I)); claims count reconciled edges only,
  debts every tracker edge; net = max(0, owes(X) + committed_as_payer(X) + delta − adjusted claims(X)), delta the amount
  at an agreement and 0 for a transfer; it refuses when net exceeds the limit, computed exactly.
- `mandate_check` entries (only for a rule that is set, after the existing ones): `refuse_notes_from {rule,
  issuer_listed: false}`, `accept_operator_issuers {rule, issuer_operator_run: false, limit: false}`, `max_claims_total
  {rule, claims_on_tracker, committed, pending_in, this_deal, limit}`, `max_issuer_net_debt {rule,
  issuer_owes_on_tracker, issuer_committed, this_deal, issuer_adjusted_claims (to the cent, rounded down),
  issuer_net_debt (to the cent, rounded up), limit}`; `max_accept_per_issuer` gains `pending_in` when it is above 0. A
  refusal at an agreement names `source: "agent_limits"` (with `recorded_by`) when the agent's recorded value refused.
- `PUT /limits` (modes sandbox and on) takes the new fields with the kinds `ncap` (`max_claims_total`,
  `max_issuer_net_debt`), `off_only` (`accept_operator_issuers`, `auto_clear`, `novate_own_debt`, `accept_transfers`,
  `pay_with_held_notes`), `allow` (`accept_notes_from`) and `deny` (`refuse_notes_from`); they only ever tighten.
- `GET /participants/{id}` (modes sandbox and on) adds `public_position.credit_policy {accept_transfers,
  accept_notes_from, refuse_notes_from, accept_operator_issuers, max_issuer_net_debt}` (effective values, never a cap)
  and `credit_history {notes_issued {count, PC}, paid_by_transfer {count, PC}, received_by_transfer {count, PC},
  cleared_by_setoff {count, PC}, payment_due, disputes {raised, received}, expired_undelivered_as_payee,
  first_activity_at, operator_run}`; neither is in `/me` or `/owner` positions. `/me` and `/owner` add `credit_policy`
  and `features {server, consent_roles, server_run, consents_declared_at, consents_count_until}`.
- The mandate's circulation fields exist only in modes sandbox and on (where `/info` lists `circulation/1`), so a client
  sends `auto_clear` at join only then; in mode bound `--clearing` has no effect.

**Routes, edges and clearing (18.14).**
- `GET /edges` pages hold at most 200 journal entries; `next_seq` is the last entry's seq when more remain, else the
  newest seq, so a client reads pages while a page is full (at most 50). A page that needs `pilot-edge-log.jsonl` while
  it cannot be read is `503 journal_unavailable`; one whose entries the server no longer has in full (D-3 d) is
  `503 journal_unavailable {missing_from, missing_to}` ("the edge journal is missing entries a..b
  (pilot-edge-log.jsonl was lost or cut): this page cannot be answered in full until the operator restores the
  file"); a page whose `since` is after the missing seqs is answered. A file that does not exist is an empty journal.
- Clients use verified journal entries as evidence too: to promote pending entries, and to mark paid deals and novated
  edges (kinds `transfer_out`, `transfer_in`, `setoff`); an exact (total, T) state of a payment attempt's edge means
  that attempt applied. Only expiring kinds (residues 997-999) can be shown dead; an ordinary note is kept until a newer
  confirmed state drops it. In a full read-back an attempt edge that is not listed counts as absent, unless it is
  listed as doubtful.
- Positions: `spendable_notes` (`issuer_handle`, `issuer_pubkey`, ...) and `pending` only in the participant's own
  position; `consents_waiting_for_your_client` counts only items with an unsigned slot; `payments_in_progress` lists
  transfers `awaiting_owner`, `collecting`, `applying`, `outcome_unknown` or `inconsistent`.
- `GET /clearing`: `engine.last_run.excluded` counts edges by reason (`not_current_key`, `not_member`, `sandbox_only`,
  `not_reconciled`, `busy`, `reserved`; edges held by payment attempts count as busy); `totals.cleared_PC` is gross (the
  sum of the decreases over every edge of the applied set-offs), while a participant's `cleared_by_setoff` and a
  client's `cleared_so_far_PC` count one side only; it carries `sandbox.dormant_PC`.
- `POST /admin/clearing/run` returns the run record `{id, at, reason, eligible_edges, excluded, cycles_found,
  expansions, truncated, proposed, applied_now, skipped, setoffs}`, or `409 clearing_not_running`; `GET /admin/clearing`
  returns diagnostics with ids, members, edges and which slots are signed, never a signature.
- Making a transfer again (regeneration) may hold the server's lock for up to 3 s while it waits for a timestamp
  ending in 999 ms.
- `429 rate_limited` carries no `retry_after_ms`; self-serve sandbox joins are limited to 3 per address per hour, held
  in the server process's memory.
- Payment options: `pending_transfer` is the latest ended attempt still inside its fallback window, `{id, state, issuer,
  timestamp, fallback_after}` (an ISO time); a held note's `why_not` is a code such as `payment_not_accepted:payee`,
  `not_reconciled`, `edge_busy` or `attempt_outcome_unknown`.
- `/api/status` `basis.pin` for a tracker v3, in every mode, is the tracker's own report: "Basis tracker v3.1: Valun
  fork commit <commit> (branch circulating-credit-v3 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports
  itself", followed by " (binary not pinned)" unless `PILOT_TRACKER_SHA256` is pinned; a tracker without capabilities
  keeps v15's text; `BASIS_PIN` overrides both. The launchers compute `PILOT_TRACKER_SHA256` from the `basis_server` they
  run, never from the environment (an unknown hash leaves circulation off).

**Sandbox circulation (18.15).**
- Each agent buys at most 3 jobs from one stranger in 24 hours, the welcome job included, counted from when the
  agreement formed (or from the agent's own acceptance while it waits for an owner); at most 3 welcome jobs a tick, and
  none while sandbox-exact's room under its own `max_issue_outstanding` is below the welcome price.
- The earn cap counts the stranger's claims on the agents: tracker claims, purchases agreed and not yet paid, and live
  incoming transfers of the agents' notes for deals no agent pays (the deal being decided left out).
- The agents buy, in mode on, from anyone but themselves; in mode sandbox only from sandbox participants, and decline
  anyone else with a signed reason ("Circulating credit is on for sandbox participants only, so I buy only from them
  (participants who joined with join-sandbox), not from you; you can still buy from me. " followed by the services text
  cut at 300 characters); in mode off the reason stays v15's.
- sandbox-mallory pays with held notes of the other sandbox agent only, only when the payee's consent speed is `auto`
  or `immediate`, and never by transfer again on a deal whose payee refused one (its own note then waits for the window).
- The server signer: `signFor(pid, msgHex, {op})` (`signHex` an alias); it signs only 80-byte note messages for the
  pilot's tracker at residues 997-999, at most 1 h old and 5 s ahead, one operation per (agent, edge, timestamp), and
  rebuilds every message itself (R1). Its write-ahead record is `sandbox-records.json` (mode 0600; attempts kept by the
  sha256 of the signature and of the prior state's signature, never a signature). The agents' own notes use the
  client's margin (120 s); the server's transfers use the server's (60 s).
- `operator_run` also appears on position claim rows and the agents' own debt rows, with the 16.1 label "issued with
  keys the operator holds"; `dormant_PC` is reported per agent in the `max_issue_outstanding` check entry.
- The exact check names the first differing field in the key order of the computed result, then any extra delivered
  keys; a delivery with no json block is disputed without naming a field.
- An agreed but undelivered purchase stays committed until `deliver_by` + 7 days; an open welcome offer reserves 3 PC
  for 24 h, and an accepted, undelivered welcome job holds 3 PC for about 9 days (bounding `deliver_by` on sandbox
  purchases is an owner decision, OPEN-QUESTIONS OQ-50).
- In ask mode the tour prompts the owner for each proposal and each acceptance: 9 times with one wrong delivery from
  sandbox-mallory (the welcome acceptance, 3 in step 2, 2 in step 3, 1 in step 4, 2 in step 5).
- The client tour (`valun sandbox tour`) stops with `tour_stuck` after 12 tool calls in a step that do not finish it;
  each disputed wrong delivery allows two more calls, up to 20 disputes in one step. The X->M and M->X edges are
  server-only and appear in the public ledger, not in the stranger's `GET /edges`.

**Clients and adapters.**
- Records (design 6.1): `records {pair: {confirmed, pending}}` with `records.paid_deals {deal_id: {route, edge, total,
  timestamp}}` (deals never paid again); `transfer_attempts {deal_id: [attempt]}` with the acknowledged EdgeState
  (attempts written before D-2 have `prior_timestamp` without `prior_signature` and are compared on total and
  timestamp); `approved_payments {deal_id: quote_digest}`; `novated_edges {edge: true}`; `consent_log` (the last 100
  decisions); `consent_roles_declared` (what the last header the server took declared; `''` after the empty list);
  `consents_last_run_ms` and, for D-3 a, `consents_last_safe_run_ms`.
- Owner tokens are never lost (decision D-3 c): every client and the plugin hand the token to the owner (a file or the
  screen) right after the server's join answer and before any local write that can fail; a failure after that still
  ends with the token shown. A join answer without a non-empty owner token is `bad_response`, and nothing is written.
- The Hermes plugin: its clients declare consent roles only while `process_consents` is on (off: the empty list, D-3
  b), and run the value-safe consents of D-3 a before `valun_status` and `valun_inbox`; `consents.max_PC` takes `none`
  (no cap) and a bad value means 0; its records live in `plugin-data/valun/valun-records.json` (0.3's
  `issued-notes.json` is their starting point); a commitment that reached its handler without the approval hook's
  binding is refused with the adapter code `approval_missing`. These are adapter behaviour, not protocol.
- A client's resolution of an attempt (`valun attempts resolve`): a credit-note attempt (bound or ordinary), or a
  transfer on a server without `circulation/1`, is resolved in the client's records only; so is a transfer the server
  does not show as this attempt, or holds as ended, and only by the owner's explicit second choice; a live transfer
  (awaiting_owner, collecting or applying) is not resolved (`attempt_in_progress`); `not_applied` is refused for an
  attempt the records show applied (`already_paid`). Every resolution needs the owner token (checked by the server, or
  by `GET /owner` for a local one: `not_owner`); before asking the owner, the client reads `GET /transfers/{vt}` and
  matches its own attempt by timestamp, held edge and new total. `valun attempts list` classifies attempts exactly as
  the payer evaluators do.
- The Python core exposes these as options of its agent layer: `ValunAgent(process_consents=...)` (decision D-2 g:
  whether the agent runs the consent firewall before its own non-read-only tools) and `consents_on_reads` (D-3 a), with
  `declare_roles` following `process_consents` unless set.
- The JavaScript package has the same options (`ValunAgent` `processConsents`, `consentsOnReads`, `declareRoles`) and
  runs one consent run at a time with a lock of its own, since it has no MCP server to hold one:
  `ValunAgent.exclusive(fn)` (not reentrant: a function passed to it must not call the agent's locked methods),
  `consentRound(enabled)` for a consent loop's round, and `Client.fresh()`, a client of its own for every use, as the
  Python agent makes a new `Client` for each. These are client API, not protocol.
- The owner console (not protocol): its clearing panel is read-only; the resolve action is offered only to the payer's
  owner and needs the payee's confirmation ticked; only changed credit-policy fields are sent; the card of a payment by
  transfer that ended without effect says, for a deal back at `payment_due`, that the delivery stays accepted so the
  payment is due again, for one back at `delivered`, that the delivery is not accepted yet and may still be accepted
  or disputed, and otherwise only that it ended without effect and nothing moved.
- Client texts (non-normative): the agent layer's circulation labels (`HONEST_LABELS_CIRCULATION`,
  `REAL_VS_SIMULATED_CIRCULATION`), `valun_status` (`money_view`, `notes_you_can_spend`, `clearing`,
  `consent_policy_in_force`, `sandbox_next_steps`), `valun_deal.how_you_can_pay` and the consent-speed words are worded
  by each client; only the server's texts of 16.1 are fixed.
- Conformance: a client declares the protocol features it implements in `PROTOCOL_FEATURES` (for example
  `("bound_notes/1", "circulation/1")`); the checker holds a client that declares `circulation/1`, or a run given
  `--require circulation/1`, to the circulation vectors (17). Neither 0.4.0 client declares it yet (OQ-52).

## Appendix A. Differences from `valun-app/docs/PILOT-API.md`

- Its decline/dispute statement, `sha256(reason)`, matches release v8 (the reason as sent); it does not mention the
  accepted cleaned form, `reason_as_signed` or the length limits.
- It gives canonical JSON as "sorted keys, no whitespace" only; string escaping, number form and key order are as in 7.2.
- It says "90 writes per minute per IP and per token"; since v8 there are also read budgets (360 per minute per token,
  and per IP: for unauthenticated reads in v8, for every read since v9), section 14.2.
- Since v11 it describes the text rules (the refused-character set, RGI flags, reason lengths), `expired_undelivered`,
  `confirm_offer`, withdrawing while an acceptance waits, owner-token rotation, the `changed` and `recorded_by` fields,
  the template timestamp rule and the named Basis error codes. It still does not describe: the raw-length limit of
  service text, reserved handles and the normalized name rules (`display_name_taken`), the 02/03 signature prefix,
  the read budgets, or the F1 agreement invariants.
- It lists `/me`, `/inbox`, `/deals` under the agent; owner tokens may use them, and `PUT /limits`, too.
- Its life cycle omits: withdrawing from `proposed_awaiting_owner` and `accepted_awaiting_owner`, owner rejection paths,
  `note_failed` retries, held counter-offers, and revocation turning `completion_awaiting_owner` back into `delivered`.
- It does not state that `terms_hash` is optional in proposals or the error body shape.
- In its release v15 text it does not mention the always-on sandbox agents (release v10) or self-serve sandbox joining
  (`POST /join-sandbox`, `sandbox_only`; releases v14 and v15, Appendix G).

## Appendix B. Changes in release v8 (valun-app commit `e0b990a`)

| Change | Sections | Was (first version of this document) |
|---|---|---|
| Decline/dispute signatures are verified over the reason **as sent**; the cleaned form is still accepted; `reason_as_signed` stored when different; raw-length limits 600/1100; a non-string reason counts as `""` | 8.1, 8.3, 14.4 | signature over `sha256(clean(reason))` only |
| `deliver_by` must not be earlier than `offer_expires_at` | 7.1 | not checked (the condition was vacuous) |
| Unsafe characters refused in service text and public profile fields; raw service text ≤ max + 100 | 2.3, 3, 7.1 | `clean()` only checked; text stored raw |
| Reserved handles; a display name may not copy another participant's | 3 | not checked |
| Request body must be a JSON object (`400 bad_json`) | 14.1 | `null` gave 502 |
| Keys and signatures must be hex strings; unverifiable signatures and signer errors are `403 bad_signature` | 2.1, 5.1, 6 | malformed input could give 502 |
| Separate per-token read (360) and write (90) budgets; per-IP budget for unauthenticated GETs; idle keys pruned | 14.2 | one per-token budget for all requests; public GETs unlimited; no pruning |
| Invite `max_uses` 1–1000, `ttl_days` 1–90 | 4, 14.3 | not validated |
| Agreement invariants (F1): `counter_pending` on accept, acceptance approvals bound to the accepted current version, `conflicting_pending`, `form()` assertion; `next_actions` without `accept` while your counter waits | 10.2, 10.4, 12 | an acceptance approval used whatever version was current |
| Own-property participant lookups (ids such as `__proto__` are unknown participants) | — | prototype names passed the counterparty allowlist |

Rows above describe v8; where release v9 changed a rule, Appendix C wins.

## Appendix C. Changes in release v9 (valun-app commit `ed1da4a`)

From the cross-check of this specification against v8 (OPEN-QUESTIONS OQ-30 to OQ-34). Regression tests in valun-app:
`test/adversarial.test.mjs`, "OQ-30" to "OQ-34".

| Change | Sections | Was (release v8) |
|---|---|---|
| Every GET counts against a per-IP read budget (`pilotIpReadLimitPerMinute`, default = the per-token read budget), whatever `Authorization` header it carries (OQ-30) | 14.1, 14.2 | only GETs without a bearer header; a made-up token skipped the budget on public routes |
| A signer outage during a signature check is `503 signer_unavailable` ("nothing was recorded; try again"); a signer that reports the input as invalid (`signer: …`) still means "does not verify" (OQ-31) | 5.1, 6, 14.1, 14.3 | every signer error was `403 bad_signature` |
| Signatures must match `/^0[23][0-9a-f]{128}$/`; anything else is refused before the signer runs (OQ-31) | 2.1, 6 | `/^[0-9a-f]{130}$/` (an all-zero signature reached the signer) |
| Decline and dispute reasons must be strings (`null`/absent = `""`) and must not contain refused characters; both refused with `400 invalid_field` before the signature is checked (OQ-32) | 2.3, 8.3 | a non-string reason counted as `""`; reasons were only cleaned (bidi and zero-width characters kept, C0 controls kept in `reason_as_signed`) |
| New refused-character set: C1 controls, U+2060–U+2064, U+FFF9–U+FFFB and tag characters U+E0000–U+E007F added; ZWNJ, ZWJ, LRM and RLM (U+200C–U+200F) allowed (OQ-33) | 2.3, 7.1, 7.2 | U+200B–U+200F refused; C1, word joiner, tag characters allowed |
| Names compared normalized (letters and digits, lower case); reserved words checked for display names too; a handle may not copy a display name; display-name refusals use `409 display_name_taken` (OQ-34) | 3, 14.3 | exact lowercase comparison of display names only; `409 invalid_field` |

Residual issues of these changes are listed with each item in OPEN-QUESTIONS (OQ-30 to OQ-35).

## Appendix D. Changes in releases v10 (valun-app commit `2ef0b16`) and v11 (commit `7880dcf`)

Release v10 changed no protocol rule: it rewrote the refused-character expression with escapes (the same set) and added
two always-on sandbox participants run inside the server (`sandbox-exact`, `sandbox-mallory`, operator "Valun operator
(sandbox agent run by the server, no AI)"). They are ordinary participants with their own keys and mandates, signing
the same statements; `sandbox-mallory` delivers wrong results on purpose in about half of its deals, so that a client
can test that it verifies work before issuing a credit note.

Release v11 is valun-app's robustness pass on OPEN-QUESTIONS revision 3 (`docs/ROBUSTNESS-2026-11-07.md`; tests
`test/robustness.test.mjs` and the adversarial F4 test).

| Change | Sections | Was (release v9) |
|---|---|---|
| Withdrawing an offer whose acceptance waits for an owner voids the acceptance (`void_withdrawn`, `voided_at`) and its approvals; the proposer's `next_actions` lists `withdraw` (OQ-6) | 10.1, 10.2, 10.4 | the acceptance stayed `awaiting_owner`; `next_actions` without `withdraw` |
| Mandate checks, positions and the inbox sweep each deal first; expired offers and held acceptances no longer count (OQ-7) | 10.3, 11.3 | counted until something read the deal |
| New terminal status `expired_undelivered`: an `agreed` deal not delivered 7 days after `deliver_by`; `delivery_grace_ends_at` in views; a later delivery is `409 wrong_state` (OQ-8) | 10.1, 10.2, 14.4 | agreed deals never ended |
| An offer accepted after its owner lowered `approve_above` below its price waits for that owner: approval kind `confirm_offer`, `acceptance.held_for`, `409 acceptance_not_authorized`, `void_acceptance_rejected` (F4, OQ-29) | 10.1, 10.2, 11.3, 12 | agreed without that owner |
| The credit-note template's timestamp never exceeds the server's clock; `409 note_timestamp_ahead` (OQ-12) | 9.2, 14.3 | a future timestamp, which `complete` refused |
| A mandate PUT that changes nothing keeps `mandate_version`; response field `changed` (OQ-13) | 11.1, 14.3 | every PUT made a new version |
| Who recorded each agent limit (`agent_limits_recorded_by`); refusals carry `recorded_by` and name the owner when it recorded the value (OQ-20) | 11.2, 11.3, 14.1 | owner-recorded limits were labelled as from the owner's instructions |
| `POST /owner/rotate-token` (OQ-24) | 4, 14.3 | owner tokens could not be replaced |
| A proposal's signature is checked before its deal id is looked up (OQ-25) | 14.3 | `409 duplicate` before the signature revealed whether an id exists |
| Signer outages during the template and completion are `503 signer_unavailable`; a skipped read-back re-check is recorded as `reverify_skipped` (OQ-31 residual) | 6, 9.2 | `502 internal error`; the deal stayed `issuing_note` |
| Basis failures have codes and fixed messages: `503 signer_unavailable`, `502 tracker_unavailable`, `502 signer_error` (OQ-35) | 14.1 | always `502 {"error": "internal error"}` |
| Reason length messages state the limits enforced (OQ-32 residual) | 8.3 | "longer than 500 / 1000 characters" for the 600 / 1100 raw limits |
| Also refused: U+00AD, Hangul fillers, U+E0100–U+E01EF, a variation selector not directly after an emoji character; allowed: the three RGI subdivision flags (OQ-33 residual) | 2.3 | accepted; flags refused |

Residual issues are listed with each item in OPEN-QUESTIONS (revision 4).

## Appendix E. Changes in release v12 (valun-app commit `a61c32e`)

| Change | Sections | Was (release v11) |
|---|---|---|
| Variation selectors: U+FE00–U+FE0D refused everywhere; after an emoji only U+FE0E or U+FE0F; after 0–9, `#` or `*` only inside a keycap (followed by U+20E3) (OQ-33) | 2.3 | any of U+FE00–U+FE0F after any `Emoji`-property character, digits included (vector `ok/variation-selector-after-digit`, now `bad/…`) |
| Also refused: U+180E, U+034F, U+206A–U+206F, U+1D173–U+1D17A (OQ-33) | 2.3 | accepted |
| Operator owner-token recovery: `POST /admin/participants/{id}/owner-token` (loopback and admin token); `GET /owner` shows `owner_token_rotated_by` (`owner` or `operator`) (OQ-24) | 4, 14.3 | only the token holder could rotate it |

Residual issues are listed with each item in OPEN-QUESTIONS (revision 5).

## Appendix F. Changes in release v13 (valun-app commit `6a6a34b`)

| Change | Sections | Was (release v12) |
|---|---|---|
| The refused-character test is defined by Unicode properties: every Cc (except TAB, LF, CR), Cf and Default_Ignorable_Code_Point code point is refused, with exactly the exceptions of rules 1–4 (five single marks, never two in a row; U+FE0E/U+FE0F after an emoji other than 0–9 `#` `*`; keycaps with U+FE0F; the three RGI flags) (OQ-33) | 2.3, 8.3 | a fixed list of ranges plus variation-selector context rules; runs of the single marks and keycaps with U+FE0E were allowed |

In every code point between two letters, v13 refuses 3777 code points that v12 accepted (among them the Mongolian free
variation selectors, Khmer inherent vowels, shorthand and Egyptian hieroglyph format controls, unassigned
default-ignorable code points and the prepended concatenation marks) and accepts none that v12 refused.

## Appendix G. Changes in releases v14 (valun-app commit `0317239`) and v15 (commit `495624c`)

Release v14 adds self-serve sandbox joining, off by default (`PILOT_OPEN_SANDBOX=1` turns it on). Release v15 turns it
on in the hosted deployment (`fly.toml`: `PILOT_OPEN_SANDBOX = "1"`) and adds a server-wide daily cap. Both are
deployed. This appendix was written from the two commits (`git show`); line numbers are those of the v15 files
(core.mjs sha256 `ad47e6ae…a6d45043`, pilot http.mjs `30658094…353fc213`). valun-app test: `test/open-sandbox.test.mjs`
(joining off is `404`; a stranger deals with sandbox-exact and cannot reach other participants or widen its box; the
per-address limit; since v15 the server-wide cap). No vector covers these releases.

| Change | Sections | Was (release v13) |
|---|---|---|
| `POST /join-sandbox`: join without an invite, as a sandbox-only participant; `404 not_found` unless the server runs with `PILOT_OPEN_SANDBOX=1`; `429 rate_limited` after 3 successful joins per address per hour; `503 sandbox_unavailable` when the sandbox agents are not running (v14) | 4, 14.2, 14.3 | no such route (`401 unauthorized` without a token, like any unknown path) |
| A sandbox-only participant: `sandbox_only: true` and `sandbox_expires_at` in its public record; a mandate the operator sets at join (the sandbox agents only; caps 5 / 40 / 5 / 40; `approve_above` 1000; 7 days) that its own owner can only narrow (`403 sandbox_only`) (v14) | 3, 11.1, 14.3 | — |
| Self-serve joining on in the hosted deployment; at most 200 new sandbox participants per 24 hours for the whole server (`503 sandbox_full`) (v15) | 14.2, 14.3 | off; no server-wide cap |

**The route** (public, no token; http.mjs:73-79, core.mjs:396-416). Request `{handle, operator?, display_name?,
about?}`; `services` is not taken (it is stored as `""`) and `operator` defaults to "self-serve sandbox tester". After
the per-IP write budget of 14.2, in this order:
1. while joining is on, an address that had 3 successful sandbox joins in the last 3600 s gets `429 rate_limited` ("at
   most 3 sandbox joins per hour from one address"). Failed joins do not count. The address is the client IP of 14.2;
   the count is kept in memory, so it starts again when the server restarts;
2. joining is off: `404 not_found` ("self-serve sandbox joining is not enabled on this server");
3. no sandbox agent is running: `503 sandbox_unavailable` ("the sandbox agents are not running on this server");
4. since v15, 200 sandbox-only participants were created in the last 24 hours: `503 sandbox_full` ("the sandbox takes
   at most 200 new participants a day; try again later");
5. the server creates itself a one-use, one-day invite (note "self-serve sandbox join"; its code is never shown) and
   joins with it as `POST /join` does: the same handle, name and text rules, and the same errors (`400 invalid_field`,
   `409 handle_taken`, `409 display_name_taken`). The invite is created before the join, so a join that fails at this
   step leaves an unused invite in `GET /admin/invites`;
6. the participant gets `sandbox_only: true`, `sandbox_expires_at` = the join time + 7 days and the mandate below,
   set by the operator (`mandate_version` 2, `mandate_changed_by: "operator"`); audit `participant.sandbox_joined`.

The response is `201 {participant_id, handle, owner_token, enrollment_code, enrollment_expires_at, sandbox_only: true,
sandbox_expires_at, counterparties: [<the sandbox agents' ids>], note}` with `note` = "Sandbox only: you can deal with
the sandbox agents (sandbox-exact, sandbox-mallory) until `<sandbox_expires_at>`. Synthetic units." The owner token and
the enrollment code are those of `POST /join`; enrollment is as in 5.1.

**The mandate** (core.mjs:411-412): `max_issue_per_deal` 5, `max_issue_outstanding` 40, `max_accept_per_deal` 5,
`max_accept_per_issuer` 40, `counterparties` = the sandbox agents' ids, `approve_above` 1000, `min_payer_coverage_pct`
0, `expires_at` = `sandbox_expires_at`, `objective` "Self-serve sandbox: deal with sandbox-exact and sandbox-mallory to
try Valun."; every other field as in 11.1 (so `review_deliveries: false`).

**The box** (core.mjs:337-345). A change to a sandbox-only participant's mandate that the operator does not make
(`PUT /owner/mandate`) is refused with `403 sandbox_only`, and nothing changes, if the mandate after the change would
have `counterparties` `"any"` or an id that is not a sandbox agent ("a self-serve sandbox participant can only deal with
the sandbox agents"), any of the four caps above its sandbox value ("a self-serve sandbox participant's `<field>` is at
most `<cap>`"), or `expires_at` `null` or later than `sandbox_expires_at` ("a self-serve sandbox participant's mandate
ends `<sandbox_expires_at>` at the latest"). The test applies to the mandate as it would be after the change, so
lowering a cap or changing another field is accepted. The operator (`PUT /admin/participants/{id}/mandate`) is not
bound by the box. After `sandbox_expires_at` every commitment is refused (`mandate_exceeded`, rule `expires_at`) and
only the operator can extend the mandate; deals already agreed go on.

**The public record** (core.mjs:390-394): `sandbox_only: true` and `sandbox_expires_at` appear in the participant record
(`GET /participants`, `GET /participants/{id}`, and `participant` in `GET /me` and `GET /owner`) of sandbox-only
participants only; every other participant's record is unchanged.

**Clients.** `valun join --sandbox` calls the route since package 0.3.0, `Client.join_sandbox()` exists since 0.3.1;
the JavaScript `Client.joinSandbox()` since 0.3.0; the Hermes plugin's `hermes valun join --sandbox` since 0.3.0.

## Appendix H. Changes in release v16 (valun-app branch `circulation-v16`, not released)

Release v16 is built locally and is neither released nor deployed. Its rows are the contract it is built against,
checked against the vectors regenerated from valun-app commit `cfe698b` (branch `circulation-v16`; `generate.mjs`
`RELEASES` pins the sha256 of every server source it imports) and against the final code (the branch's last commit,
`b88c1b3`, adds a test only). If the release commit's server sources differ from `cfe698b`'s, the vectors are
regenerated from it and these rows are checked again. The audit's server fixes (valun-app `55510a9`, local, not
released) change those sources; an export of `55510a9` run through `generate.mjs` (`VALUN_APP_DIR`) gives the
committed vectors exactly, apart from their meta (the release label and the source hashes) and the two new
`engine.limits` keys in the `GET /clearing` answer of transcript step 199 (engine choices, not normative). So the
vectors stay pinned to `cfe698b` until the release commit is cut; the rows marked "audit" below describe `55510a9`.

**In every mode** (no visible change in normal operation):

| Change | Sections | Was (release v15) |
|---|---|---|
| Approval kinds are dispatched explicitly; any other kind is `409 unknown_approval_kind` before anything changes | 12 | any other kind ran the `confirm_offer` code, and rejecting it withdrew the deal |
| A held credit note is stale if the pair's tracker note changed at all (total, timestamp or signature; a note held before the upgrade: the total) | 9.2 | the total only |
| `409 pair_busy` (`retry_after_ms: 60000`) on the credit-note template and on completion while another deal on the same key pair is `issuing_note` | 9.2, 14.3 | a second note could be signed on a prior that a pending submission was about to change |
| Recovery every 60 s as well as at startup | 9.2, 10.2 | at startup only |
| `GET /ledger` keeps only notes in the pilot denomination | 14.3 | notes in every denomination the tracker returned |
| `?prior=1` on the credit-note template adds `prior_note` | 9.2 | query strings ignored |
| Against a tracker that reports reserved timestamps (v3): ordinary template timestamps skip 995–999 ms (at most 5 ms later); a completion at a reserved residue other than 997 (a bound note, 18.5) is `409 stale_note` with a fresh template | 9.2, 18.4 | — (older trackers accept every residue) |
| Handles shaped like participant ids (`vp_` + 12 hex) are refused at join and join-sandbox (`400 invalid_field`) | 3, G | accepted |
| `GET /api/status` `basis.pin` for a tracker v3 is the tracker's own report ("…, as the tracker reports itself", plus " (binary not pinned)" unless its sha256 is pinned), in every mode; `BASIS_PIN` overrides | 18.16 | v15's text for every tracker |
| `POST /owner/approvals/{va}`: `409 not_pending` when the deal or offer expired during the decision's mandate checks; nothing is decided | 12 | the expired approval could be decided |
| The sandbox agents count only successful actions against their per-round budget (at most 32 attempts a round, with a growing back-off per item) and decline, with a signed reason, offers their own mandate cannot accept | D | failed items used up the round; such offers stayed open |

**With circulation on** (bound notes from mode `bound` up, everything else in modes `sandbox` and `on`; 18):

| Change | Sections | Was (release v15) |
|---|---|---|
| Modes `off`/`bound`/`sandbox`/`on`, effective only with a validated tracker v3 and a pinned binary sha256; `/info` `features`, `novation`, `circulation_statements`; the `X-Valun-Features` header | 18.1, 18.2, 14.1, 14.3 | — |
| Bound notes: `?bound=1`, `credit_note.prior_total` and `prior_signature`, bound-only edges | 18.5, 9.2 | — |
| Payment by debt transfer: payment options, transfer template, `pay-by-transfer`, `cancel-transfer`; the pay statement and `quote_digest`; seven tracker signatures | 18.3, 18.6 | — |
| Multilateral set-off proposed by the clearing engine; `GET /clearing` | 18.7, 18.14 | — |
| Maximum age 1 hour, collection windows 20 and 30 minutes, the fallback rule (`409 transfer_window_open`) | 18.8 | — |
| Consents API: `GET /consents`, `POST /consents/{id}`, `POST /consents/{id}/refuse` | 18.9 | — |
| Statuses `paying_by_transfer`, `paid_by_transfer`, `payment_due`; approval kind `pay_by_transfer` | 10.1, 10.4, 12, 18.10, 18.11 | — |
| Credit-policy mandate fields and their checks | 11.1, 11.3, 18.13 | — |
| `GET /edges`, `GET /transfers/{vt}`, `GET /setoffs/{vs}`, loopback clearing admin routes; positions and inbox additions; the public `GET /ledger` keeps v15's reconciliation rows in every mode, and `exact` is per party in `GET /edges` (audit SV-PRIV-1; `cfe698b` added the journal columns to the public rows) | 14.3, 18.12, 18.14 | — |
| Labels with circulation on | 16.1 | 16 |
| Client rules R1–R13 and their refusal codes | 15.3 | — |
| The 0.4.0 clients: value-safe consents before `valun_status` and `valun_inbox` in an adapter without a consent loop (D-3 a), the empty roles header once every role is off (D-3 b), the owner token handed over at join before any local write (D-3 c) | 18.1, 18.16, H | — |
| Tracker v3.1: bound notes expire after one hour (`novation_expired`); `bound_notes` version 2 with `max_age_ms` (decision D-1 item 1) | 18.2, 18.8 | — |
| One live payment attempt per deal, across kinds (D-1): `409 transfer_window_open`, `409 attempt_outcome_unknown`, `409 already_paid`, `409 pending_unbound_note`; transfer states `outcome_unknown`, `inconsistent`, `resolved_not_applied`, `void_expired` | 15.3, 18.6, 18.8 | — |
| Refused payments recorded as attempts (D-2 b); held notes and attempts keep their edges out of set-offs (D-2 c, `held_note`, `payment_attempt`); the journal proves attempts dead (D-2 e); a failed bound note's error is the server's own sentence (D-2 f) | 18.7, 18.8, 18.16 | — |
| The owner's resolution of an attempt whose outcome is unknown: `POST /owner/deals/{vd}/attempts/{vt}/resolve` (D-2 d; transfers only); `applied` only while the payee's edge shows the transfer, else `409 payee_edge_not_applied {payee_edge}` (audit SV-AUTH-1); for an unresolved attempt the route exists in every mode but `off` (audit MIG-4) | 18.8 | — |
| A transfer's T is later than every earlier recorded transfer of the deal; a post at or before one is `409 transfer_stale` with a fresh template (audit R-1) | 18.4, 18.6 | — |
| Clearing engine: a member that has not signed since its last unsigned expiry is in at most 1 collecting set-off, and set-offs with such members are at most 40 (`engine.limits` `max_collecting_per_unproven`, `max_collecting_unproven`; audit SV-DOS-1) | 18.14 | — |
| The v15 rollback check purges every unapplied note signature (the backup keeps them) and runs from the image's entrypoint with `VALUN_MAINTENANCE=downgrade-check[-dry-run]` (audit MIG-1, MIG-3) | 18.1, Appendix H | — |
| `X-Valun-Features: consents/1;roles=` (empty) forgets the recorded roles at once (D-3 b); the journal is partial unless it covers every seq (D-3 d: `503 journal_unavailable {missing_from, missing_to}`, audit `journal.incomplete`) | 18.1, 18.8, 18.14 | — |
| Phase-2 credit policies (`max_claims_total`, `max_issuer_net_debt`, `accept_operator_issuers`), public `credit_policy` and `credit_history`; `max_claims_total` counts each payment once, and a `sandbox_only` participant shows its enforced 40 | 18.13, 18.16 | — |
| `GET /info` `description` with circulation on names transfers and set-offs (modes off and bound keep v15's text) | 16.1 | "no redemption, reserve or clearing" |

**Clients with circulation off** (decision D-2 h). The 0.4 clients make exactly the 0.3.1 requests against a server
that lists no `circulation/1`, except these reads of `GET /info` (no other change; no `X-Valun-Features` header, no
`GET /consents` and no `GET /edges` with features off):
1. the `valun_propose` approval snapshot reads `GET /info` once per agent process while the features are unknown;
2. the consent hook reads `GET /info` once per agent process, before the first tool that is not read-only, and only
   for profiles that take part in consents (a `consent_policy`, written at join since 0.4, or recorded transfer
   attempts or approved payments); with `consents_on_reads` and `process_consents` on (decision D-3 a: the Hermes
   plugin 0.4.0), that one read can come instead before the first `valun_status` or `valun_inbox`, for a profile whose
   `consent_policy` has a value-safe role on (`setoff` or `as_new_creditor`); after that no more reads (by either path:
   once the features are known, neither asks again), and 0.3 profiles make none;
3. `complete()` on a pinned profile reads `GET /info` once per accepted delivery (`bound_notes/1` detection and the
   reserved residues); `valun_deal` no longer pins profiles, as in 0.3.1;
4. the sandbox Seller reads `GET /info` once, at its first step (it must be restarted to see circulation turned on
   later; the agent re-reads `/info` through `valun_status`);
5. the new owner CLI commands read `GET /info`: `valun attempts`, `clearing`, `policy show`, and join's pin read;
   `attempts` reads `GET /edges` only when features are on, and `resolve` also reads `GET /transfers` (circulation
   only) and `GET /owner` (for local resolutions);
6. with features off there is no `X-Valun-Features` header, no `GET /consents` and no `GET /edges`.
`valun_deal` makes exactly the 0.3.1 requests, and so do `valun_status` and `valun_inbox`, except for the one read of
item 2 that an adapter with `consents_on_reads` (D-3 a) can make before the first of them.

**The server with circulation off** stays byte-identical to v15 (the 100-step flow and the sandbox flows give v15's
snapshots on the old tracker and on v3.1; transcript steps 1-147 are unchanged): `sandbox-keys.json` is written as v15
writes it; `sandbox-records.json` is written only in modes sandbox and on; `payment.refused_attempt` occurs only in
modes sandbox and on; the resolve route is 404 in mode off, and in mode bound it exists only for an attempt left
`outcome_unknown` or `inconsistent` from an earlier mode (audit MIG-4), so `transfer.resolved_by_owner` occurs outside
modes sandbox and on only for such an attempt. A v15 rollback (`scripts/pilot-downgrade-check.mjs`) is refused while
any transfer is awaiting_owner, collecting, applying, outcome_unknown or inconsistent, any set-off is collecting or
applying, a deal is paying_by_transfer, a `pay_by_transfer` approval is pending or a bound note is held or being
issued; otherwise it backs up the state (`pilot-state.json.v16-backup-<UTC>`), maps payment_due to note_failed and,
since the audit (MIG-1, valun-app `55510a9`), always purges every unapplied note signature: each payer-signed note the
tracker did not record and that v15 will not send (a deal's credit note unless the deal is `issuing_note` or
`completion_awaiting_owner`, and its rejected, voided and replaced notes) has its `signature` and `prior_signature`
moved into their sha256 fields; it prints the counts and adds `signatures_purged` to its audit line
(`downgrade.v15_prepared`). The backup keeps those signatures, so it is as private as the state. A v16 server whose
pilot tracker reports no capabilities logs one ALARM and audits `pilot.revivable_signatures` when the state still
holds unapplied bound or novated-edge note signatures or unapplied transfer or set-off slot signatures (an alarm
only; a v15 state raises nothing). The container image carries the check (MIG-3): with `VALUN_MAINTENANCE` set to
`downgrade-check` (or `downgrade-check-dry-run`) the entrypoint runs it on `$DATA/pilot/pilot-state.json` before any
tracker or the app starts and exits with its exit code (an unknown mode exits 2), so the state checked is the live
state and nothing writes it meanwhile (an operator procedure, valun-app `docs/PILOT-API.md`). v15's `migrate()` turns a
v16 deal's payment-by-transfer record into a credit-note record with no note (display-only in v15; a re-upgrade loses
that deal's payment block; OPEN-QUESTIONS OQ-51). v15 code on tracker v3.1 gets an occasional note_failed (ordinary
templates may end in 995-999 ms) and cannot pay novated edges with its unbound notes: run v15 with the `3df7ed93`
tracker instead.
