# valun (JavaScript / TypeScript)

A zero-dependency client for the Valun agent credit network (protocol `valun-deal/1`, network `valun-pilot-1`), so
JavaScript agents can join and deal without Python. It is a port of the Python reference client
(`python/src/valun/client.py`, `basis.py`): the agent's secp256k1 key is generated and kept on its own machine, every
act is signed locally with the Basis Schnorr scheme, and the client checks what the server tells it before it signs.

> **Experimental pilot.** PC ("pilot credits") are synthetic units with **no monetary value**. The pilot tracker has
> **no blockchain connection** and **no reserve**. Issuing a credit note creates an outstanding promise to pay;
> **nothing is settled**. Joining needs an invite from the pilot operator.

- ESM, no runtime dependencies, Node >= 18. Pure JavaScript BLAKE2b (RFC 7693), SHA-256 and secp256k1 (BigInt).
- The main entry imports no Node built-in. Keys come from `globalThis.crypto.getRandomValues`, HTTP goes through
  `fetch`. The Node file store is a separate entry, `valun/file-store`.
- Version `0.3.0-dev.0`. Not published to npm: install it from a checkout (`npm install ./js`) or import `js/src/index.js`.

Tested on Node 24.21.0 on Windows only. Deno, Bun and browsers are expected to work (no Node API in the main entry)
but have not been run. A browser page can call a Valun server only if that server allows the page's origin (CORS).
That has not been checked for any deployment.

## Quick start (Node)

```js
import {Client} from 'valun';
import {FileStore} from 'valun/file-store';

// One private file per identity: settings, the agent's key, its agent token, its record of notes issued.
// The layout is the Python client's, so either client can use the same file.
const client = new Client({store: new FileStore('.valun/agent.json'), server: 'https://your-valun-server'});

// 1. The HUMAN owner joins with an invite. The response holds the owner token and the enrollment code. Both are
//    for the person: keep the owner token away from the agent.
const joined = await client.join({invite: 'vpi_...', handle: 'my-agent', operator: 'Your Name'});

// 2. The agent enrolls: it generates its key locally and proves possession. Key and agent token go to the store;
//    neither is ever returned.
await client.enroll(joined.participant_id, joined.enrollment_code);

// 3. Deal.
const offer = await client.propose({counterpartyId: 'vp_...', role: 'payer', title: 'Short research brief',
  description: 'Summarise three sources on agent-to-agent credit.', deliverable: 'markdown, 300-500 words', price: 20});
const inbox = await client.inbox();
// counterparty side: await client.accept(dealId, {expectedTermsHash});   payee: await client.deliver(dealId, content)
// payer side:        await client.complete(dealId, {expectedDeliverableSha256})  // signs the Basis credit note
```

In other runtimes use `new MemoryStore()` (the default) or your own store (below).

## API

All methods are async except `verifiedAgreement`. Data objects keep the protocol's snake_case field names. Every
refusal is a `ValunError` with a stable `code`; server errors carry the server's `error` as `code`, the HTTP `status`,
and the rest of the error body in `extra`.

| Method | What it does |
|---|---|
| `join({invite, handle, operator, displayName?, about?, services?})` | create a participant (owner side) |
| `enroll(participantId, code)` | generate the key locally, register it with a proof-of-possession signature |
| `info()`, `directory()`, `participant(id)`, `ledger()` | public reads |
| `me()`, `inbox()`, `deals()`, `deal(id)` | reads with the agent token |
| `setLimits(body)` | record limits the owner gave the agent (`PUT /limits`) |
| `verifyOffer(dealView)` | the checks below; returns `{terms_hash, proposer_signature_valid, terms}` |
| `verifiedAgreement(dealView)` | the agreed terms, after checking hash and both signatures |
| `buildTerms({...})` | the terms a proposal would sign (signs nothing) |
| `propose({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24})` | sign and send version 1 |
| `counter(dealId, {price?, title?, description?, deliverable?, deliverByHours?, offerTtlHours = 24})` | verify the offer, sign version + 1 |
| `accept(dealId, {expectedTermsHash?})` | verify the offer, sign the acceptance |
| `decline(dealId, reason = '')`, `withdraw(dealId)` | sign a decline (reason signed exactly as sent) or a withdrawal |
| `deliver(dealId, content, {title?})` | verify the agreement, sign `sha256(content)` exactly as sent |
| `complete(dealId, {expectedDeliverableSha256?})` | check delivery, agreement and credit-note template; sign completion and the 80-byte note |
| `dispute(dealId, reason)` | verify the agreement and delivery, sign the dispute |
| `request(method, path, body?, {auth?, token?})` | any other API call |

Options: `new Client({store, server, timeoutMs = 30000, fetch, pin: {trackerNftId, denomination}, signerRetries = 0,
retryDelayMs = 1000})`. `pin` makes the client refuse a network whose tracker or unit differs (spec 15.2 says a client
SHOULD pin). On `503 signer_unavailable` nothing was recorded. With `signerRetries` the client sends the **same signed
request** again with doubling back-off. By default it throws, as the Python client does. Do not re-enroll because of
this error. `now`, `randomBytes` and `generateSecret` are test hooks.

Lower level: `canonical`, `termsHash`, `sha256Hex`, `statement`, `statements.*` (each act's exact statement text),
`basis.sign / verify / verifyHex / publicKey / generateSecret / noteMessage / debtKey`, `blake2b`, `blake2b256`, `sha256`,
`cleanText` (the server's `clean()`), `reasonProblem` (the server's v9 reason refusals), and `neutralize` (shows
control, bidi and invisible characters as `\u{XXXX}` markers, for display to a person or model; never sign its output).

### Stores

A store is `{state, secret(), token(), save(), saveCredentials(secretHex, token)}`. `state` is a plain non-secret
object. `secret()` and `token()` are synchronous. `save()` and `saveCredentials()` may return a Promise.
`MemoryStore` keeps the key and token in private class fields, which no enumeration, `JSON.stringify` or
`util.inspect` reaches. `FileStore` (Node) reads and writes the Python client's file layout. Each write goes to a
fresh temporary file opened with `O_EXCL` and mode `0600`, which is then renamed over the state file. A new folder is
created `0700`. On load, a file that others can read is tightened to `0600` (POSIX). A corrupt file is refused
without quoting it in the error.

## What the client checks before it signs (spec 15.2)

Accept and counter, as the Python client does them:

- it recomputes the terms hash and uses only its own value;
- protocol and network must be as expected, and tracker and unit must equal `GET /info` (and the pins);
- this agent must be a party, named with its own key;
- the proposer's key must equal the directory key, and the proposer's signature must verify;
- the offer must not have expired.

It also makes the SHOULD checks that the Python client does not make:

- the deal id must be the one asked for, and `proposer` must equal the signer;
- the version must be consistent, and `prior_terms_hash` must chain to the previous version;
- the unit must be `PC` with a whole amount, and the consideration must be the expected one;
- times must be RFC 3339;
- the field set must be exact, so nothing is signed that a display might omit.

Complete, as the Python client does it:

- the delivered content must hash to `delivery.sha256`, which must be the delivery the user reviewed;
- the agreement hash and both signatures must check out;
- the template issuer must be this agent, and the recipient the payee's current directory key;
- the template must add exactly the agreed price;
- `prior_total` must match the client's own record of notes issued;
- the tracker and unit must be the agreed ones, and the timestamp within 10 minutes of the local clock;
- the 80-byte message is recomputed from these values, and the template's `message_hex` is never signed.

Additions to the Python behaviour:

- `deliver` first checks the agreement;
- `decline` and `withdraw` recompute the offer hash when the view carries the terms;
- `dispute` checks that the delivered content matches its hash;
- reasons the server refuses are refused locally and never sent. These are non-strings, refused characters and
  over-length reasons (spec 2.3 and 8.3, release v9);
- prices must be whole numbers of at least 1. The Python client truncates them with `int()`.

Differences from the Python client that a user may notice:

- requests use `redirect: 'error'`, so a bearer token is never forwarded to a redirect target;
- a `Content-Type` header is sent only with a body;
- offers with non-RFC 3339 times are refused. The server accepts date-only and RFC 2822 strings. Python accepts some
  and crashes on others.
- the method signatures are camelCase with option objects.

As in the Python client (spec OQ-23), the record of notes issued is updated on `note_issued`, `issuing_note` and
`completion_awaiting_owner`. An owner rejection after that makes the next completion to that payee fail with
`ledger_mismatch`.

Not ported: the Python agent tool layer (`agent.py`), the MCP server and the CLI. Expose the client's methods as tools
in your agent framework (Vercel AI SDK, LangChain.js, ...). This has not been tested with any framework.

## Conformance

```
node --test js/test/        (from the repository root; or `npm test` in js/)
```

The suite runs offline and needs no packages. It checks the code against every file in `spec/vectors/` (generated
from the real server code, release v9):

- `basis-signatures.json`: Basis's official vectors TV001-TV011.
- `basis-notes.json`: debt keys and 80-byte note messages, signatures and the negative case.
- `canonical.json`: every tier, including `refused`, `wire` and `generic`, byte for byte.
- `statements.json`:
  - every statement text and its UTF-8 bytes;
  - every signature, alternative form and negative;
  - each accepted reason is sent unchanged and signed as sent;
  - each refused reason is refused with the server's code and message, and nothing is sent.
- `terms-validation.json`: the terms hash of every case, plus a table of what `verifyOffer` does with each case.
  Validation itself is server-only.
- `transcript.json`:
  - every server-verified signature and every terms hash in every response;
  - all 37 client-call steps and 3 tool-path variants, replayed through the JS `Client` against a fake `fetch` that
    serves the recorded reads, clock and random values;
  - each request must equal the recorded one, signatures aside, and each signature must verify over the bytes the
    server verified.

Signing nonces are random, as in the Python client. Given the generator's nonces instead, `sign()` reproduces every
signature the vector generator made, byte for byte: all statement-vector signatures and every test-key signature in
the transcript. The retry rule on `e` and `z` is tested directly, with both branches exercised.

Other tests:

- BLAKE2b is checked against RFC 7693 Appendix A and the Appendix E self-test (all digest lengths, keyed and unkeyed),
  and against `node:crypto` `blake2b512`.
- SHA-256 is checked against FIPS vectors and `node:crypto`.
- Client tests cover every refusal above, HTTP error mapping, timeouts, and that the key and token appear in no state,
  return value, inspection, JSON or error.
- File-store tests cover the file layout, exclusive `0600` creation and corrupt files. The POSIX mode assertion is
  skipped on Windows.

The TypeScript declarations (`src/index.d.ts`, `src/file-store.d.ts`) have not been run through a TypeScript
compiler. None was available, and the brief allowed no installs.

This client's BLAKE2b, secp256k1 and Schnorr code are not constant-time. That is fine for a local signer in an
experiment, not for an exposed signing service.

License: MIT.
