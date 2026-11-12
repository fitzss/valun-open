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
  `fetch`. Node-only parts are separate entries: the file store `@fitzdoud/valun/file-store` and the DNS host checker
  `@fitzdoud/valun/dns`.
- Version `0.4.6`: `npm install @fitzdoud/valun` (or from a checkout:
  `npm install ./js`) or import `js/src/index.js`. 0.4.0 adds circulating credit (server release v16, spec revision
  v14: bound notes, paying with a note you hold, consents and set-offs, edge sync), mirroring the Python package
  `valun` 0.4.1. 0.4.1 fixes the sandbox tour (it waits while a sandbox agent pays and says done only after a
  set-off) and shows an attempt the server ended before the tracker as ended. 0.4.2 and 0.4.3 change only the version,
  to match the Python package (which adds `valun sell`, `valun profile` and the `check` service). 0.4.4 adds the brief
  view of `valun_status` for small models: `brief: true` on the call, or `new ValunAgent(client, {briefStatus: true})`
  as the default (the same output as the Python package).

Tested on Node 24.21.0 on Windows only. Deno, Bun and browsers are expected to work (no Node API in the main entry)
but have not been run. A browser page can call a Valun server only if that server allows the page's origin (CORS).
That has not been checked for any deployment.

## Quick start (Node)

```js
import {Client} from '@fitzdoud/valun';
import {FileStore} from '@fitzdoud/valun/file-store';

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
`cleanText` (the server's `clean()`), `reasonProblem` (the server's v13 reason refusals), `hasUnsafeText` (the v13
text rule of spec 2.3, the same as the server's function), and `neutralize` (shows control, bidi and invisible
characters as `\u{XXXX}` markers, for display to a person or model; never sign its output).

### Stores

A store is `{state, secret(), token(), save(), saveCredentials(secretHex, token)}`. `state` is a plain non-secret
object. `secret()` and `token()` are synchronous. `save()` and `saveCredentials()` may return a Promise.
`MemoryStore` keeps the key and token in private class fields, which no enumeration, `JSON.stringify` or
`util.inspect` reaches. `FileStore` (Node) reads and writes the Python client's file layout. Each write goes to a
fresh temporary file opened with `O_EXCL` and mode `0600`, which is then renamed over the state file. A new folder is
created `0700`. On load, a file that others can read is tightened to `0600` (POSIX). A corrupt file is refused
without quoting it in the error.

A store may also have `update(fn)` (and `reload()`); the client then makes every change to its records through it.
`FileStore.update(fn)` uses the Python FileStore's lock protocol on the same files: an `O_EXCL` lock file
`<path>.lock` holding `<pid> <time> <random>`, removed by its holder only while it still holds exactly that; a wait of
up to 5 s (then `profile_busy`); a lock older than 30 s is replaced as stale, by one waiter at a time
(`<path>.lock.break`). Under the lock it reloads the file, applies `fn` and writes atomically, so a Python and a
JavaScript client can share one profile without losing each other's records. One `Client` also makes its own changes
one after another.

## Settlement on Ergo testnet (the testnet network)

On the Valun **testnet** network (`valun-testnet-1`, amounts in nanoERG of Ergo testnet: test coins with no monetary
value) an agent can back its notes with a Basis reserve and redeem the notes it holds. Its Ergo address is the P2PK
address of its Valun key, so its own key signs its own Ergo transactions; the server never holds it. Signing uses
ergo-lib, which this client loads only when you install it next to it: `npm i ergo-lib-wasm-nodejs@0.28.0` (without
it these calls fail with `ergo_lib_missing`; nothing else needs it).

```js
client.ergoAddress();                                   // send tERG here (a testnet faucet, or another agent)
await client.createReserve(50_000_000);                 // 0.05 tERG: checked and signed, NOT sent; returns it
await client.createReserve(50_000_000, {broadcast: true});
await client.redeem('sandbox-exact', 3_000_000, {broadcast: true});   // a note sandbox-exact issued to you
```

Before its key signs anything, the client checks it: a reserve request must lock exactly the amount, at the network's
reserve contract, with this agent's key in R4 and the network's tracker NFT in R6, minting one token whose id is the
first input; a redemption must spend the issuer's reserve (its contract, owner key and tracker NFT), lower it by exactly
the amount, pay exactly the amount to this agent's own address, name this agent as the receiver, and spend no box of
this agent's own. Context extensions are written in the order the Ergo node serializes them (`ergo.toErgoJson`).

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

- the delivered content must hash to `delivery.sha256`, which must be the delivery the user reviewed, and the agreed
  terms must be the ones the user reviewed (`expectedTermsHash`, checked before the template is even read);
- the agreement hash and both signatures must check out, and the payee must have signed the delivery (under the key the
  terms name or the payee's current directory key: `bad_delivery_signature`);
- the template issuer must be this agent, and the recipient the payee's current directory key;
- the template must add exactly the agreed price;
- the prior must be one the client can stand behind: when the server offers `bound_notes/1`, the prior note it shows
  (`?prior=1`) must be this agent's own signature and not older than its records (`bad_prior_signature`,
  `ledger_mismatch`); otherwise `prior_total` must match the client's own record of notes issued;
- a deal is never paid twice while a note of this agent for it may have applied (`already_paid`);
- the tracker and unit must be the agreed and pinned ones (`tracker_mismatch`), and the timestamp within 10 minutes of
  the local clock; when the server advertises any feature, a timestamp ending in 995-999 ms is refused;
- the 80-byte message is recomputed from these values, and the template's `message_hex` is never signed.

A profile that is not pinned yet (none is, before its first `GET /info`) is served exactly as 0.3 was: no extra
request, no `?prior=1`.

Additions to the Python behaviour:

- `deliver` first checks the agreement;
- `decline` and `withdraw` recompute the offer hash when the view carries the terms;
- `dispute` checks that the delivered content matches its hash;
- reasons the server refuses are refused locally and never sent. These are non-strings, refused characters and
  over-length reasons (spec 2.3 and 8.3, release v13);
- prices must be whole numbers of at least 1. The Python client truncates them with `int()`.

Differences from the Python client that a user may notice:

- requests use `redirect: 'error'`, so a bearer token is never forwarded to a redirect target;
- a `Content-Type` header is sent only with a body;
- offers with non-RFC 3339 times are refused. The server accepts date-only and RFC 2822 strings. Python accepts some
  and crashes on others.
- the method signatures are camelCase with option objects.

As in the Python client, a credit note is recorded as pending (`state.records`) before it is sent, and confirmed (and
`state.issued` updated) only when the server answers `note_issued`, or when a later read shows it applied. A held note
that its owner rejects is simply dropped, so the next completion to that payee succeeds (this fixes OQ-23).

Not ported: the MCP server and the CLI. The agent tool layer is ported (next section).

## Agent tools

`ValunAgent` is a port of the Python tool layer (`agent.py`, `schemas.py`, `measure.py`, and the service functions of
`sandbox.py`). It has the same nine tools (`valun_status`, `valun_directory`, `valun_inbox`, `valun_deal`,
`valun_propose`, `valun_respond`, `valun_deliver`, `valun_review_delivery`, `valun_set_limits`), the same results and
wording, and the same checks before signing: the missing-text guard, the deliver gate on measured terms, and the
exact recomputation of text-stats and notary results. `call(name, args)` resolves to a plain object. `callSafe` never
rejects; failures come back as `{error, message, what_this_means?}`.

`valunTools(agent, {approve})` returns the tools as `{name, description, parameters (JSON Schema), execute(args)}`.
Before every commitment (an offer, an acceptance, a counter-offer, accepting a delivery, loosening a limit) it calls
`agent.prepare()`, as the Python MCP server and CLI do: one read of what would be signed gives both the arguments to
sign with and the approval text. The text is built only from values checked against what is signed: the terms must
hash to the stated hash, name this agent as one party and be offered by the other, the server's role and counterparty
must agree with them, and a delivery must hash to its sha256. Those recomputed hashes are pinned in the arguments (an
offer is pinned to the participant id shown), the computed lines come first, and text a counterparty or the agent wrote
is quoted after them as one line of JSON. It then calls `approve(text, name, args)` and executes exactly those
arguments. Only `true` signs. If the offer or delivery changes after the owner saw it, the client refuses to sign
(`stale_terms`, `stale_delivery`). When what would be signed cannot be read or does not hold together, the call is
refused with `approval_unbound` and the owner is not asked. Without a hook, commitments are refused with
`approval_unavailable`, unless you pass `approvals: 'none'`, which also skips preparing. The server enforces the
owner's mandate in every mode.

Approvals fail closed, as in the Python core. Only the read-only tools, `valun_deliver`, `valun_respond` with the action
exactly `decline` or `withdraw`, `valun_review_delivery` with the decision exactly `dispute`, and `valun_set_limits`
calls that loosen nothing are not commitments; every other call, a tool name the client does not know included, is. A
review decision other than exactly `accept` or `dispute` is refused with `bad_decision` before anything is read or
signed.

A plain loop against an OpenAI-compatible Chat Completions endpoint, with no framework:

<!-- agent-loop-example -->
```js
import {Client, ValunAgent, valunTools} from '@fitzdoud/valun';
import {FileStore} from '@fitzdoud/valun/file-store';
import {resolveHost} from '@fitzdoud/valun/dns';

const agent = new ValunAgent(new Client({store: new FileStore('.valun/agent.json')}), {resolveHost});
const tools = valunTools(agent, {approve: askOwner});   // askOwner(text): show it to a person, resolve true or false
const spec = tools.map(({name, description, parameters}) => ({type: 'function', function: {name, description, parameters}}));
const messages = [{role: 'user', content: 'Check Valun and act on my inbox within my limits.'}];
for (let turn = 0; turn < 10; turn++) {
  const res = await fetch(process.env.LLM_URL, {method: 'POST', headers: {'content-type': 'application/json',
    authorization: `Bearer ${process.env.LLM_KEY}`}, body: JSON.stringify({model: process.env.LLM_MODEL, messages, tools: spec})});
  const msg = (await res.json()).choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(msg.content); break; }
  for (const c of msg.tool_calls) {
    const t = tools.find(x => x.name === c.function.name);
    const result = t ? await t.execute(c.function.arguments) : {error: 'unknown_tool'};
    messages.push({role: 'tool', tool_call_id: c.id, content: JSON.stringify(result)});
  }
}
```

`execute` accepts the arguments as an object or as the raw JSON string of a tool call. Frameworks that take JSON
Schema tools (Vercel AI SDK, LangChain.js, OpenAI Agents SDK, Mastra) can use these objects directly or after renaming
a field. Check your framework's docs, for example whether it needs a non-strict schema mode, since many arguments are
optional. The tools have not been run inside any framework; the test suite runs this loop against a fake model.

- Link hosts: in Node, pass `resolveHost` from `@fitzdoud/valun/dns` (DNS only; no page is fetched). Without it, for
  example in a browser, measurements say `link_hosts_not_checked`, and the deliver gate checks only word and link counts.
- `measure`, `sandbox` and `schemas` are exported as namespaces (`measure.measure`, `sandbox.checkDelivery`,
  `schemas.ALL`).

## Conformance

```
node --test js/test/        (from the repository root; or `npm test` in js/)
```

The suite runs offline and needs no packages. It checks the code against every file in `spec/vectors/` (generated
from the real server code, release v16, valun-app `b7ecca0`, on tracker v3.2; spec revision v14):

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
- `circulation.json` (release v16): timestamps, messages (80-byte note messages and, `kind: "prior_ack"`, the 105-byte
  prior acknowledgments of tracker v3.2), quote digests, pay statements, tracker requests, and the 79 decisions of the
  signing firewall (consents, payer templates, bound templates), each with its exact slots or refusal code.
- `transcript.json`:
  - every server-verified signature and every terms hash in every response;
  - all 65 client-call steps (of 236), replayed through the JS `Client` against a fake `fetch` that serves the
    recorded reads, clock and random values;
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
  skipped on Windows. `records.test.js` covers the records, `complete()` over them against a fake server and tracker
  (OQ-23, prior notes, reserved residues, the payee's delivery signature, pins), and the profile lock: two stores, and a
  Python and a JavaScript process, updating one profile at once lose nothing (skipped without `python/src` and
  Python 3.10+). `approvals.test.js` covers fail-closed classification and `prepare()`.
- Agent tools are tested against the Python reference itself. `test/fixtures/generate_python_fixtures.py` runs the
  Python `ValunAgent` (CPython 3.14) over recorded server responses, a fixed clock, fixed ids and a fixed DNS table.
  `agent-parity.test.js` replays every recorded scenario through the JS agent. Results must be equal, key order
  included, and so must the requests (signatures aside), every signature sent (it must verify over exactly the bytes
  Python signed for that request), the stored state, `isCommitment`, `prepare()` (the bound arguments and the approval
  text, or the refusal and its cause), `bind()` and the approval texts for the raw and the bound arguments.
  Helper-level outputs (measurements, sandbox results, records, approval-text quoting, `int()`, `repr()`, IP
  classification) and the shared constants (approval sentences, labels, tool classes) are compared the same way, and
  `sandbox-python.json` is the server's fixture. A test fails when any `valun.*` module the generator imports has
  changed since the fixtures were generated.

The TypeScript declarations (`src/index.d.ts`, `src/file-store.d.ts`, `src/dns.d.ts`) pass
`tsc --noEmit --strict --lib es2022,dom` with TypeScript 6.0.3, run through `npx`. It is not a dependency.

This client's BLAKE2b, secp256k1 and Schnorr code are not constant-time. That is fine for a local signer in an
experiment, not for an exposed signing service.

License: MIT.
