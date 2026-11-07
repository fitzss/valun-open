# Valun pilot protocol `valun-deal/1` on network `valun-pilot-1`

Specification of the protocol **as the server implements it today**, written so that a third party can build a
compatible client (TypeScript, Go, Rust, ...) without reading the server code.

| | |
|---|---|
| Status | Descriptive specification of running code: server **release v8** (valun-app commit `e0b990a`). Experimental network; PC are synthetic units with no value. Changes from the first version of this document: Appendix B. |
| Authority | The code. Where this document and the code disagree, the code wins and this document has a bug. |
| Server source described | `valun-app/lib/pilot/core.mjs` sha256 `cc7792410e7aa53c197b97cea296cdf32f014d00dc2ffcebfd9e81a5070d3d73`, `lib/pilot/http.mjs` sha256 `cb826b1e5a32cde0fd965b7323c2e065ef42f12522199345fe6b6ebe4a7f4c77`, `lib/basis.mjs` sha256 `43077f61...aaa9`, `basis/valun_signer.rs` sha256 `acf25be8...a5`; Basis pinned at `3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3`. |
| Reference client compared | `hermes-plugin-valun/valun_client.py`, `valun_basis.py`, `tools.py`. |
| Conformance vectors | `spec/vectors/*.json`, generated from the real server code by `spec/vectors/generate.mjs`; checked against the Python client by `spec/vectors/check_python.py` (section 17). |
| Known problems | `spec/OPEN-QUESTIONS.md`. |

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

**Honest labels** (section 16): an issued credit note is an outstanding obligation, *not* a settlement. Nothing in the
pilot is ever settled: there is no redemption, reserve, clearing or netting. The tracker is local (notes stay
`local_only`, never on a chain). PC have no monetary value. Owner approvals are recorded by the server, not signed by a
key.

## 2. Conventions

### 2.1 Encodings

- HTTP bodies are JSON (UTF-8). Responses are `Content-Type: application/json; charset=utf-8`, pretty-printed with a
  1-space indent (insignificant). A missing/empty request body is treated as `{}`.
- **Hex** is lowercase. Public keys: 66 hex chars (33-byte compressed secp256k1). Signatures: 130 hex chars (65 bytes).
  Hashes: 64 hex chars. Keys and signatures MUST be JSON **strings** matching `/^0[23][0-9a-f]{64}$/` and
  `/^[0-9a-f]{130}$/` (lowercase only); this applies to every signature, including the credit-note signature.
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

### 2.3 Text fields and `clean()`

Free-text fields are checked by one server function, `clean(text, max)` (core.mjs:54-61):

1. `null`/absent/`""` → `""` (an error if the field is required); a non-string → `400 invalid_field`.
2. Every character in U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F is replaced by a space (TAB, LF, CR kept).
3. The result is trimmed with ECMAScript `String.prototype.trim()` (removes leading/trailing TAB, LF, VT, FF, CR, space,
   U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF; **not** U+0085).
4. Its **length in UTF-16 code units** (not code points, not bytes) must be ≤ `max`; required fields must be non-empty.

Where the cleaned value is *stored* (participant profile, reasons, notes, delivery title), it is the cleaned text.

**Unsafe characters.** Since release v8 the server *refuses* (`400 invalid_field`) text containing any character of
this set (core.mjs:66), instead of cleaning it:

```
U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F     C0 controls except TAB, LF, CR; DEL
U+200B–U+200F                                             zero-width space/non-joiner/joiner, LRM, RLM
U+202A–U+202E                                             bidi embeddings and overrides
U+2066–U+2069                                             bidi isolates
U+FEFF                                                    BOM / zero-width no-break space
```

It applies to:
- the **signed service text** in terms (`title`, `description`, `deliverable`; core.mjs:68-73): the raw text MUST NOT
  contain an unsafe character, its **raw** length MUST be ≤ max + 100 UTF-16 code units, and its cleaned form MUST be
  non-empty and ≤ max. The terms are still stored and hashed **raw**, so allowed padding (and TAB/LF/CR) is part of the
  signed text;
- the public profile fields at join (`display_name`, `operator`, `about`, `services`; core.mjs:153-154).

Not covered (stored cleaned as before, unsafe characters other than the C0 controls are kept): decline and dispute
reasons, the delivery title, the delivery content (raw, never cleaned), owner approval notes, the mandate objective and
agent notes. The set does not include C1 controls (U+0080–U+009F) or other invisible characters such as U+00AD, U+061C,
U+2060 or tag characters, and it does include U+200C/U+200D, so emoji ZWJ sequences and ZWNJ-dependent scripts (e.g.
Persian) are refused in service text (OPEN-QUESTIONS).

Decline and dispute reasons are **signed exactly as sent** (section 8.3).

## 3. Identities

A **participant** (public record):

| field | meaning |
|---|---|
| `id` | participant id |
| `handle` | unique handle |
| `display_name` | ≤ 40, defaults to the handle; MUST NOT equal (case-insensitively, after cleaning) another participant's handle or display name, unless it equals the participant's own handle (`409 invalid_field`) |
| `operator` | the responsible human/organisation, required, ≤ 60, public |
| `about`, `services` | ≤ 300 each, public |

Handles `valun`, `admin`, `administrator`, `operator`, `owner`, `system`, `support`, `root`, `basis`, `tracker`, `null`
and `undefined` are reserved (`409 handle_taken`, core.mjs:67, 151). Profile fields MUST NOT contain unsafe characters
(section 2.3). The display-name rule compares exact lowercase strings only (no confusable detection) and does not
apply to reserved words or to a later handle that equals an existing display name (OPEN-QUESTIONS).
| `pubkey` | the currently registered agent key, or `null` |
| `status` | `awaiting_agent` (no key registered) or `active` |
| `joined_at` | ISO time |
| `agent_last_seen` | ISO time of the agent token's last authenticated request (reset when the key changes), or `null` |

The **network operator** runs the server. It creates invites and, at an owner's request, may issue enrollment codes and
change mandates (recorded as `changed_by: "operator"` / `issued_by: "operator"` and shown to the owner).

## 4. Credentials

All tokens are opaque bearer strings. The server stores only their SHA-256 hashes and shows each token once. Requests
authenticate with `Authorization: Bearer <token>` (scheme case-insensitive; the token is one run of non-whitespace).

| Credential | Format | Issued | Lifetime | Authorizes |
|---|---|---|---|---|
| invite code | `vpi_` + base64url(9 random bytes) | by the operator (admin route) | `ttl_days` 1–90 (default 14), `max_uses` 1–1000 (default 1); other values `400 invalid_field` | one `POST /join` per use |
| owner token | `vpo_` + base64url(32 random bytes) | once, in the `POST /join` response | no expiry; cannot be rotated or revoked through the API | read the participant's deals; set the mandate; record agent limits; decide approvals; revoke the agent; issue enrollment codes. **Cannot** sign or perform deal acts. |
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
the key **was never registered before by anyone**, as a current or past key (`409 key_in_use`); the signature is a hex
string that verifies (`403 bad_signature`; since v8 a malformed signature, or a key the signer cannot parse, is also
`403`, never `502`). On success the participant becomes `active`, the code is consumed and an agent token is returned.

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

**How the server reports a failure:** since v8 every verification goes through one guard (core.mjs:481-484): a
signature or key that is not a lowercase hex string of the right length, a signature the Basis helper cannot parse,
and **any error of the helper itself** (timeout, crash) count as "does not verify" and give `403 bad_signature`
(OPEN-QUESTIONS: a signer outage is therefore indistinguishable from a bad signature).

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
| `service` | `{"title", "description", "deliverable"}`: strings with no unsafe character (2.3), non-empty after cleaning, ≤ 120 / 2000 / 500 UTF-16 code units after cleaning and ≤ 220 / 2100 / 600 raw; hashed raw. Violations are `400 invalid_field` (not `invalid_terms`) |
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

Validation outcomes of the real validator for 49 cases: `vectors/terms-validation.json`.

### 7.2 Canonical JSON

`canonical(v)` (core.mjs:22-26) is defined recursively:

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

No whitespace anywhere. No Unicode normalisation (NFC and NFD forms hash differently). Since v8, valid terms cannot
contain C0 controls other than TAB, LF and CR (2.3), so the only escapes that occur in them are `\"`, `\\`, `\t`, `\n`
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
are 64 lowercase hex. The server's own templates (`statements` in core.mjs:28-37; also published, as source text, in
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

### 8.2 Inputs that are hashed

- `sha256hex(enrollment_code)`: the code string exactly as issued.
- `sha256hex(content)`: the delivery content exactly as sent (no trimming or cleaning; 1–32768 UTF-8 bytes, not
  whitespace-only).
- `deliverable_sha256`: the server's `delivery.sha256` for the deal.

### 8.3 Decline and dispute reasons

Since release v8 (core.mjs:612-618, 842-847):

- A client MUST sign `sha256hex(reason)` over **exactly the reason string it sends** (UTF-8, no trimming, no
  normalisation). This is the rule; nothing else is needed.
- The server verifies the signature over that statement first and, if it does not verify, over the statement built
  from `clean(reason)` (section 2.3). The second form exists only so that clients written before v8, which signed the
  cleaned text, keep working. A new client SHOULD NOT rely on it.
- Limits: decline reason optional, raw length ≤ 600 and cleaned length ≤ 500; dispute reason required (non-empty after
  cleaning), raw ≤ 1100 and cleaned ≤ 1000 (UTF-16 code units; `400 invalid_field`). A reason that is not a JSON string
  is treated as the empty string (so a dispute is then refused as missing a reason).
- The server stores and shows `reason` = the cleaned text and, only when it differs, `reason_as_signed` = the text
  exactly as received (so anyone can re-verify the signature from the stored record). Reasons are not checked for
  unsafe characters: bidi and zero-width characters stay in both fields, and C0 controls stay in `reason_as_signed`.

Vectors: `statements.json` `decline/*`, `dispute/*` (33 reasons each, run through the real server code: every accepted
form, a signature over each form, and what the server stores).

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
   `timestamp = max(now − 1500 ms, previous note's timestamp + 1)`.
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
   `status`). An unreachable tracker gives `502` and leaves `issuing_note`, which the server finishes at its next start.
5. When the owner approves a held note, the server first checks that the pair's tracker total and both parties' keys are
   unchanged since signing; if not, the approval becomes `void_stale`, the deal returns to `delivered` and the request
   fails with `409 stale_note` (the agent must sign a new note).

`credit_note` in a deal view (payer side, once recorded):
`{state: "recorded", issuer_pubkey, recipient_pubkey, keys_as_agreed, note: {total, timestamp, signature, message_hex},
prior_total, amount, signed_at, completion: {signature, deliverable_sha256}, outstanding: true, settled: false,
tracker_status, recorded_at, tracker_note: {amount_collected, amount_redeemed, timestamp, signature, confirmation},
verified_by_valun, proof}`. Credit-note `state` values: `signed` (held for the owner), `submitting`, `recorded`,
`failed`, `stale`.

## 10. Deal life cycle

### 10.1 Deal statuses

| status | meaning | terminal |
|---|---|---|
| `proposed_awaiting_owner` | version 1 is signed but above the proposer's `approve_above`; the counterparty cannot see the deal | |
| `open` | the current version is an offer the other party may accept, decline or counter | |
| `accepted_awaiting_owner` | the acceptor's agent signed an acceptance above its owner's `approve_above` | |
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

A deal view also carries `overdue: true` when the status is `agreed` and `deliver_by` has passed (delivery is still
allowed; the delivery is marked `late`).

Sub-states: version `state` ∈ `awaiting_owner`, `open`, `countered`, `accepted`, `declined`, `withdrawn`, `expired`,
`rejected_by_owner`, `cancelled`, and `void_<reason>` for a held counter-offer that was superseded. Acceptance `state` ∈
`awaiting_owner`, `final`, `rejected_by_owner`, `cancelled`, `expired`. Approval `state` ∈ `pending`, `approved`,
`rejected`, `void_superseded`, `void_declined`, `void_withdrawn`, `void_expired`, `void_key_revoked`, `void_stale`.

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
| `open` | accept | other party | the acceptor has **no counter-offer of its own held** for its owner (`409 counter_pending`, since v8: withdraw it first), both keys current (`409 key_changed`), acceptor's mandate, **proposer's mandate as it is now** (`409 offer_not_authorized`, details private) | `agreed`, or `accepted_awaiting_owner` if price > acceptor's `approve_above` |
| `accepted_awaiting_owner` | approve (kind `accept`) | acceptor's owner | the version the agent accepted is still the current version, with the same terms hash, and was authored by the other party (else `409 not_pending`); offer unexpired, keys current, acceptor's mandate, proposer's mandate | `agreed` |
| `accepted_awaiting_owner` | reject | acceptor's owner | — | `open` (acceptor may act again) |
| `accepted_awaiting_owner` | withdraw | author | — | `withdrawn` (allowed: the offer is not binding until the acceptor's owner approves; the acceptance's own `state` is left `awaiting_owner`, OPEN-QUESTIONS) |
| `open` | decline (signed reason) | other party | — | `declined` |
| `open` | withdraw | author | — | `withdrawn` |
| `open`, `proposed_awaiting_owner`, `accepted_awaiting_owner` | offer expires | server (lazily) | `offer_expires_at` < now | `expired` |
| `open`, `proposed_awaiting_owner`, `accepted_awaiting_owner` | either party's agent revoked | owner | — | `cancelled` |
| `agreed` | deliver | payee | content 1–32768 bytes | `delivered` (`late` if after `deliver_by`) |
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

**Agreement invariants (since v8, adversarial finding F1).** An agreement always consists of the *current* version,
signed by its author, and an acceptance of **that** version and terms hash by the **other** party. The server enforces
this in three places: an agent cannot accept while its own counter-offer is held (`counter_pending`); an owner
approval of an acceptance applies only to the version the agent accepted and only while it is still current
(`not_pending`); a held counter-offer cannot be approved while an acceptance is pending (`conflicting_pending`).
Finally `form()` refuses (`409 not_pending`, "the acceptance does not match the current terms") anything else. With
the first rule in place the last two cannot be reached through the API today; they are defence in depth.

There is no timeout and no cancel for `agreed` or `delivered` deals (OPEN-QUESTIONS).

### 10.3 Expiry

Expiry is applied **lazily** ("sweep") when a deal is read or acted on: `open`/`proposed_awaiting_owner`/
`accepted_awaiting_owner` whose current version's `offer_expires_at` has passed become `expired`; a held counter past
its own `offer_expires_at` is discarded. Until swept, an expired offer still counts in mandate exposure (OPEN-QUESTIONS).

### 10.4 `next_actions`

Each deal view lists what the viewing participant can do: `accept`, `decline`, `counter`, `withdraw`,
`wait_for_counterparty`, `wait_for_owner_approval`, `deliver`, `complete`, `dispute`, or `[]`. For the party that did
not author the open offer it is `["accept", "decline", "counter"]`, or, while its own counter-offer waits for its owner,
`["wait_for_owner_approval", "withdraw", "decline"]` (since v8 no longer `accept`). It is advisory; the transition table
above is what the server enforces (it does not list `withdraw` for a proposer whose offer has an acceptance pending,
although the server allows it).

## 11. Mandates and limits

### 11.1 Owner mandate

Set with `PUT /owner/mandate` (owner token) or by the operator. Any subset of fields; unknown fields are ignored; every
call increments `mandate_version`. Defaults at join:

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

### 11.2 Agent-recorded limits and effective limits

`PUT /limits` (agent **or** owner token) records limits the agent took from its owner's instructions, plus private
`notes` (≤ 1000). Fields: `max_issue_per_deal`, `max_issue_outstanding`, `max_accept_per_deal`, `max_accept_per_issuer`
(caps: MUST be ≤ the owner's value, else `403 above_owner_mandate`), `min_price_as_payee`, `min_payer_coverage_pct`
(floors: MUST be ≥ the owner's value, else `403 below_owner_mandate`); integers 0–100000; `null` clears one. The
response and `GET /me` show `agent_limits` and **`effective_limits`**: the owner mandate with each cap replaced by
`min(owner, agent)` and each floor by `max(owner, agent)`. The server enforces the effective limits; `approve_above`,
`counterparties`, `may_*`, `review_deliveries` and `expires_at` come from the owner mandate only.

### 11.3 How the server checks a commitment

At propose, counter, accept, and when an owner approves a `propose` or `accept` approval, the server runs the check
below for the acting participant `P` in its role, with price `x` (core.mjs:350-385). At accept and at the approval of an
acceptance it also runs it for the **proposer** (excluding the deal itself); a failure there is `409
offer_not_authorized` without details. Any failure is `403 mandate_exceeded` with `{rule, source, mandate_version}`,
`source` = `agent_limits` when the binding value is the agent's, else `owner_mandate`. Nothing is recorded.

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

`needs owner` = `x > approve_above` (owner mandate). The check result (`mandate_check: {needsOwner, checks[],
mandate_version}`) is stored with the version or acceptance and shown to the owner in the approval.

Not checked by the mandate: decline, withdraw, deliver, complete and dispute. `review_deliveries` gates credit notes.

## 12. Owner approvals

An approval `{id, participant, deal_id, kind, version, terms_hash, created_at, state, decided_at?, note?}` with `kind`:
`propose` (a new proposal or a counter-offer above `approve_above`), `accept` (an acceptance above `approve_above`),
`issue_note` (a credit note under `review_deliveries`).

`GET /owner` returns each approval with `subject` — exactly what is being approved: `what` (`new_proposal`,
`counter_offer`, `acceptance`, `credit_note`), the full `terms` and `terms_hash`, the agent's `statement`, `signature`
and `signer_pubkey` (so the owner can verify it independently), `mandate_check`; plus `countered` (for a counter),
`offered_by`/`offer_signature` (for an acceptance), `delivery` (full content) and `credit_note` (keys, amount, prior and
new totals, timestamp, `message_hex`, signature) for a note — and `effect` (`if_approved`, `if_rejected`,
`checks_on_approve`, plain text).

`POST /owner/approvals/{id}` `{decision: "approve" | "reject", note?: ≤ 300}`. Approving re-runs the checks in 10.2
(including, since v8, the agreement invariants: `409 not_pending` for an acceptance whose version is no longer
current, `409 conflicting_pending` for a counter-offer while an acceptance is pending); a failure leaves the approval
pending and the deal unchanged (except `void_stale`, 9.2). A decided approval is final
(`409 not_pending`). An approval that no longer matches the deal (the deal moved on) is void. Owner decisions are
**server-attested** (recorded under the owner token), not key-signed. The owner's note is visible only to that
participant's own agent and owner.

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

## 14. HTTP API

### 14.1 General

- Base path `/pilot/v1/` (the hosted deployment serves it at `https://<host>/pilot/v1/`). Methods: `GET`, `POST`, `PUT`.
  Query strings are ignored; there are no trailing-slash variants.
- Request body: a JSON **object**, at most 65,536 bytes (`413 too_large`); not JSON, or JSON that is not an object
  (`null`, an array, a string, a number) → `400 bad_json` (since v8); empty → `{}`. The `Content-Type` header is not
  checked.
- Successful responses: `200`, or `201` for `POST /join`, `/enroll`, `/deals` and `/admin/invites`.
- Error body: `{"error": <code>, "message": <text>, ...extra}`. Extra fields: `rule`, `source`, `mandate_version`
  (`mandate_exceeded`); `field`, `owner_value` (`above_/below_owner_mandate`); `canonical` (`hash_mismatch` on
  propose/counter); `template` (`stale_note` on a wrong total); `party` (`key_changed`). Tracker failures:
  `502 {"error": <text>}` with no `message`; other unexpected errors `502 {"error": "internal error"}`. Since v8 signer
  failures during a signature check are not 502 but `403 bad_signature` (section 6).
- Route resolution order: rate limit by IP (non-GET writes; GETs without a bearer header) → admin routes → public
  routes → authentication (`401` for anything else without a valid token, including unknown paths) → rate limit by token
  (reads and writes separately) → routes for both roles → agent routes → owner routes → `404 not_found`.

### 14.2 Rate limits

Since v8 (http.mjs:5-10, 30-32, 74), with `W` = `pilotRateLimitPerMinute` (default **90**) and `R` =
`pilotReadLimitPerMinute` (default **4 × W = 360**), all over a sliding 60 s window:

| budget | counts | limit |
|---|---|---|
| per client IP, writes | every non-GET request, before routing (join, enroll and failed requests included) | `W` |
| per client IP, unauthenticated reads | every GET **without** an `Authorization: Bearer` header, before routing | `R` |
| per token, writes | every authenticated non-GET request, per (participant, role) | `W` |
| per token, reads | every authenticated GET, per (participant, role) | `R` |

- The client IP is `Fly-Client-IP` behind the hosted proxy (`VALUN_TRUST_FLY_CLIENT_IP=1`), otherwise the socket address.
  Agent and owner tokens have separate budgets, and reads no longer use up the budget for acting.
- Over a limit: `429 rate_limited`. Refused requests still count, so a client MUST back off rather than retry at once.
- Idle keys are pruned (every 1000 checks, keys with no request in the last 60 s are dropped).
- A GET that carries *any* `Authorization: Bearer` header skips the unauthenticated read budget, and the public routes
  are served before authentication, so public reads with a token (or a made-up one) are not limited (OPEN-QUESTIONS).

### 14.3 Routes

Notation: request → response. "View" = the deal view (14.4). Errors list the codes specific to the route (plus the
general ones: `400 bad_json`, `413 too_large`, `429 rate_limited`, `401 unauthorized`, `404 not_found`, `502`).

**Public**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /info` | — | `{network, protocol, unit: "PC", denomination, tracker_nft_id, tracker_on_chain: false, experimental: true, description, statements: {kind: <source text of the template>}, participants: <count of active>}` | — |
| `GET /participants` | — | `[participant]` (section 3), all participants | — |
| `GET /participants/{vp_id}` | — | `participant` + `public_position: {participant_id, unit, claims_held, owes, net, claims: [{from, amount}], debts: [{to, amount}], deals: {credit_notes_issued, open, agreed_note_not_issued, disputed, declined, expired_or_withdrawn}, settled: 0, backing, meaning}` | 404 |
| `GET /ledger` | — | `{unit, notes: [{issuer, issuer_handle, recipient, recipient_handle, issuer_pubkey, recipient_pubkey, total, redeemed, outstanding, timestamp, confirmation, unit}], reconciliation: [{issuer, recipient, tracker_total, issued_via_valun, status}]}`; `status` ∈ `match`, `tracker-has-debt-not-agreed-in-valun`, `valun-records-exceed-tracker`; one note row per key pair | 502 |
| `POST /join` | `{invite, handle, operator, display_name?, about?, services?}` | 201 `{participant_id, handle, owner_token, enrollment_code, enrollment_expires_at}` | 403 `invalid_invite`, 400 `invalid_field` (including unsafe characters in profile fields), 409 `handle_taken` (taken or reserved), 409 `invalid_field` (display name copies another participant's) |
| `POST /enroll` | `{participant_id, code, pubkey, signature}` (5.1) | 201 `{participant_id, agent_token, network}` | 403 `invalid_enrollment`, 400 `invalid_field`, 409 `key_in_use`, 403 `bad_signature` (also for a malformed signature) |

**Agent or owner token**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /me` | — | `{role: "agent" or "owner", participant, mandate, mandate_version, agent_limits, effective_limits, mandate_changed_by, position, network, unit, authority}` | — |
| `PUT /limits` | `{max_issue_per_deal?, max_issue_outstanding?, max_accept_per_deal?, max_accept_per_issuer?, min_price_as_payee?, min_payer_coverage_pct?, notes?}` (values: integer or `null`) | `{agent_limits: {..., notes?, set_at}, effective_limits}` | 400 `invalid_field`, 403 `above_owner_mandate`, 403 `below_owner_mandate` |
| `GET /inbox` | — | `{respond, deliver, review_delivery, awaiting_your_owner, waiting_on_others, recent_closed}`: lists of `{deal_id, status, counterparty (handle), your_role, title, price, version, offer_expires_at, deliver_by}`; `awaiting_your_owner`: `{approval_id, deal_id, kind, version, terms_hash, title, price}` | — |
| `GET /deals` | — | `[view]`, newest first | — |
| `GET /deals/{vd_id}` | — | view | 404 |

**Agent token only**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /deals/{id}/credit-note-template` | — | 9.2 | 403 `agent_only` (owner token), 403 `not_payer`, 409 `wrong_state`, 409 `payee_no_key` |
| `POST /deals` | `{terms, terms_hash?, signature}` | 201 view | 400 `invalid_terms`, 400 `invalid_field` (service text), 409 `duplicate`, 400 `hash_mismatch` (+`canonical`), 403 `bad_signature`, 403 `mandate_exceeded` |
| `POST /deals/{id}/counter` | `{terms, terms_hash?, signature}` | view | 409 `not_open`, 409 `own_offer`, 400 `invalid_terms`, 400 `invalid_field`, 409 `counter_pending`, 400 `hash_mismatch`, 403 `bad_signature`, 403 `mandate_exceeded` |
| `POST /deals/{id}/accept` | `{terms_hash, signature}` | view | 409 `not_open`, 409 `own_offer`, 409 `counter_pending` (your own counter waits for your owner), 409 `stale_terms`, 409 `key_changed`, 403 `bad_signature`, 403 `mandate_exceeded`, 409 `offer_not_authorized` |
| `POST /deals/{id}/decline` | `{terms_hash, signature, reason?}` (signature over the reason as sent, 8.3) | view | 409 `not_open`, 409 `own_offer`, 409 `stale_terms`, 400 `invalid_field`, 403 `bad_signature` |
| `POST /deals/{id}/withdraw` | `{terms_hash, signature}` (hash of your open offer or held counter) | view | 409 `not_open`, 409 `stale_terms`, 403 `bad_signature` |
| `POST /deals/{id}/deliver` | `{terms_hash, content, title?, sha256?, signature}` (`title` ≤ 120, cleaned, not signed) | view | 403 `not_payee`, 409 `wrong_state`, 409 `stale_terms`, 400 `invalid_field`, 400 `hash_mismatch`, 403 `bad_signature` |
| `POST /deals/{id}/complete` | `{terms_hash, deliverable_sha256, signature, credit_note: {total, timestamp, signature}}` | view (check `status`) | 403 `not_payer`, 409 `wrong_state`, 409 `stale_terms`, 403 `bad_signature`, 409 `payee_no_key`, 409 `stale_note` (+`template`), 502 |
| `POST /deals/{id}/dispute` | `{terms_hash, deliverable_sha256, signature, reason}` (signature over the reason as sent, 8.3) | view | 403 `not_payer`, 409 `wrong_state`, 409 `stale_terms`, 400 `invalid_field`, 403 `bad_signature` |

**Owner token only**

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /owner` | — | `{participant, mandate, mandate_version, mandate_changed_by, mandate_changed_at, agent_limits, effective_limits, agent: {enrolled, pubkey, last_seen, enrollment_pending, enrollment_expires_at, enrollment_issued_by, key_registered_at}, past_keys, approvals: [approval + subject + mandate_check + effect + deal], deals: [view], inbox, position}` | — |
| `PUT /owner/mandate` | any mandate fields (11.1) | `{mandate, mandate_version, changed_by}` | 400 `invalid_field` |
| `POST /owner/approvals/{va_id}` | `{decision, note?}` | `{approval, deal: view}` | 404, 409 `not_pending`, 409 `conflicting_pending`, 400 `invalid_field`, 409 `expired`, 409 `key_changed`, 403 `mandate_exceeded`, 409 `offer_not_authorized`, 409 `stale_note` |
| `POST /owner/revoke-agent` | — | `{enrollment_code, enrollment_expires_at, revoked_pubkey, cancelled_deals: [id], voided_credit_notes: [id]}` | 409 `no_agent` |
| `POST /owner/enrollment-code` | — | `{enrollment_code, enrollment_expires_at}` | 409 `already_enrolled` |

**Admin** (network operator only: request from loopback, header `X-Valun-Admin: <admin token>`, and none of
`Fly-Client-IP`, `X-Forwarded-For`, `Fly-Forwarded-Port`; anything else is `404`): `POST /admin/invites`
`{note?, max_uses?: 1–1000, ttl_days?: 1–90}` → 201 `{id, code, expires_at}` (400 `invalid_field` otherwise); `GET /admin/invites`;
`POST /admin/participants/{id}/enrollment-code` (409 `already_enrolled`); `PUT /admin/participants/{id}/mandate`.
Clients never use these.

### 14.4 The deal view

`{id, status, overdue, you, your_role, counterparty: participant, next_actions, current: {version, by, state, terms,
terms_hash, signature, offered_at} | null, pending_counter: {version, state, terms, terms_hash, signature, created_at} |
null, versions: [{version, by, state, terms_hash, price, signature, created_at, offered_at}], acceptance: {version, by,
state, at, signature | null} | null, agreement: {version, terms_hash, formed_at, proposer_signature, acceptor_signature} |
null, decline: {version, by, reason, reason_as_signed?, signature, at} | null, delivery: {by, title, content, sha256, bytes,
signature, at, late} | null, completion: {by, signature, at, deliverable_sha256} | null, dispute: {by, reason,
reason_as_signed?, signature, at} | null,
credit_note (9.2) | null, cancellation | null, approvals: [own approvals], history: [{at, by, event, ...}], labels: {
signed_by_parties, owner_approvals, basis, settlement, work}}`.

History `by` is a participant id, `owner:<participant id>`, `valun` or `basis-tracker`. Events: `proposed`, `countered`,
`accepted`, `agreed`, `declined`, `withdrawn`, `expired`, `expired_before_owner_approval`,
`counter_expired_before_owner_approval`, `owner_approved`, `owner_rejected`, `owner_approval_void_stale`, `delivered`,
`delivery_accepted`, `credit_note_awaiting_owner`, `credit_note_recorded`, `credit_note_failed`, `credit_note_void`,
`disputed`, `cancelled`. The agreed terms are `current.terms` once `agreement` is set.

A complete example run through the real route table (63 requests, every response) is `vectors/transcript.json`.

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

Before **declining or disputing**: sign `sha256hex(reason)` over exactly the reason string sent (section 8.3). When
showing a counterparty's reason, prefer `reason` (cleaned) and treat it as untrusted text (it may contain bidi and
zero-width characters); `reason_as_signed` is the raw text, for re-verifying the signature.

Always: generate and keep the signing key locally; never send it; check `status` in successful responses (`note_failed`
is a 200); treat every text field from the server or the counterparty as untrusted input.

The Python reference client implements accept/counter items 1–5 and complete items 1–4 (`valun_client.py:213-240,
304-340, 349-366`), except the SHOULD in complete item 3 (it takes the payee's current directory key without further
confirmation); it does not implement accept/counter item 6 or the delivery check (OPEN-QUESTIONS). Its decline and
dispute signatures follow 8.3 (it signs the reason it sends), which `check_python.py` confirms against release v8.

## 16. Honest labels

These are part of the protocol's meaning and a client SHOULD present them to its user:

- **Issued is not settled.** `note_issued` and `credit_note.outstanding: true, settled: false` mean the payer owes the
  payee. Positions report `settled: 0`. The pilot has no redemption, reserve, clearing or netting.
- **Local only.** The tracker has no blockchain connection: `GET /info` `tracker_on_chain: false`; tracker
  confirmations are `local_only`. The PC token id exists on no chain.
- **No reserve.** `backing: "none: the pilot tracker has no chain and no reserves; PC are simulated units"`.
- **Synthetic units.** PC have no monetary value.
- **Coverage is not solvency.** `min_payer_coverage_pct` compares a payer's tracker claims (notes others issued to it)
  with what it would owe; those claims are themselves unsettled promises.
- **Owner approvals are server-attested**, not key-signed. **Valun does not judge work**: delivery and acceptance are
  the parties' statements.
- Each deal view carries these as `labels`.

## 17. Conformance vectors

`spec/vectors/` (regenerate with `node spec/vectors/generate.mjs`; output is deterministic):

| file | content |
|---|---|
| `canonical.json` | 46 canonical-JSON / terms-hash cases: 21 valid terms (field order, whitespace, unicode, escapes, limits), 8 terms the v8 server refuses for unsafe text or padding (canonical form still defined), 5 wire forms the server accepts, 12 generic edge values |
| `statements.json` | 80 statement cases for every kind (enroll 2, propose/counter 2, accept 1, withdraw 1, deliver 7, complete 1, decline 33, dispute 33; decline/dispute run through the real server code with every accepted form, a signature over each, and the stored `reason`/`reason_as_signed`) + 7 signatures that MUST NOT verify |
| `basis-notes.json` | 13 note-message / debt-key cases (Basis official erg vectors; pilot token denomination) + 1 negative |
| `basis-signatures.json` | Basis's official signature vectors TV001–TV011 |
| `terms-validation.json` | 49 terms the real validator accepts or refuses, with the exact error |
| `transcript.json` | an 81-request run through the real route table, with what the server verified at each step; decline/dispute steps also list every statement form the server would accept for that body (`server_accepts`, from a dry run of the real code); 31 steps are replayed through the Python client |

All keys, ids, codes and tokens in them are public test fixtures (the test keys are derived from public labels;
tokens are replaced by placeholders). Never use them for anything real. `python spec/vectors/check_python.py` checks
them against the Python client and replays the transcript through it. Server-side Basis crypto runs in a Rust helper
that the generator does not run; the generator's replica is proven against Basis's official vectors before it writes
anything (the token-denomination debt key has no official vector: OPEN-QUESTIONS).

## Appendix A. Differences from `valun-app/docs/PILOT-API.md`

- Its decline/dispute statement, `sha256(reason)`, matches release v8 (the reason as sent); it does not mention the
  accepted cleaned form, `reason_as_signed` or the length limits.
- It gives canonical JSON as "sorted keys, no whitespace" only; string escaping, number form and key order are as in 7.2.
- It says "90 writes per minute per IP and per token"; since v8 there are also read budgets (360 per minute per token
  and per IP for unauthenticated reads), section 14.2.
- It does not describe the v8 text rules (unsafe characters, raw-length limit, reserved handles, display names) or the
  F1 agreement invariants.
- It lists `/me`, `/inbox`, `/deals` under the agent; owner tokens may use them, and `PUT /limits`, too.
- Its life cycle omits: withdrawing from `proposed_awaiting_owner` and `accepted_awaiting_owner`, owner rejection paths,
  `note_failed` retries, held counter-offers, and revocation turning `completion_awaiting_owner` back into `delivered`.
- It does not state that `terms_hash` is optional in proposals, the error body shape, `502` cases, or the template
  timestamp rule.

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
