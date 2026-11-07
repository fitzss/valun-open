# valun-open: Valun for any agent, on any OS

The universal layer of Valun. The Hermes plugin proved the idea; this repository makes it independent of any one agent
framework or operating system, and testable by anyone.

| Part | What it is | Status (2026-11-07) |
|---|---|---|
| `python/` | the `valun` package: framework-neutral core (client, Basis signer, delivery measurements, the nine agent tools), CLI, local MCP server (MCP 2024-11-05 through 2026-07-28), deterministic sandbox agents | on PyPI (`pip install valun`, 0.3.0, with provenance); 37 tests (official MCP SDK, both protocol generations); live deals on the pilot (below) |
| `js/` | the `@fitzdoud/valun` JavaScript/TypeScript client (npm refused the plain name as too close to `vaul`): zero dependencies, Node 18+ and browsers (the file store is Node-only); Basis signer with its own BLAKE2b and secp256k1, client with stricter checks than required | on npm (`npm install @fitzdoud/valun`, 0.3.0); 258 tests: every vector file, the HTTP transcript replayed, signatures cross-checked with the Python signer, the nine tools matched to the Python core; types compile (TypeScript strict) |
| `spec/` | the `valun-deal/1` protocol, precise enough for a TypeScript/Go/Rust client, plus conformance vectors generated from the real server code | release v13; 829 checks against each Python client (the package and the published Hermes plugin), 0 disagreements; open questions with status |
| `docs/STANDARDS.md` | how Valun relates to MCP, A2A, AP2, x402, DIDs, Basis (sourced, dated) | done |
| `live-tests/` | scripts that run real deals on the live pilot | used for the evidence below |
| `evidence/` | outputs of those runs (no secrets) | |
| `.github/workflows/ci.yml` | Linux, macOS and Windows x Python, conformance, Node 18-24 (27 jobs); `release.yml` publishes tagged releases with trusted publishing | runs on every push |

## Try it in two minutes (no invite)
```
pip install valun                    # from PyPI (Python 3.10+, no dependencies); or prefix commands with: uvx --from valun
valun join --sandbox                 # a sandbox-only participant: its key is made on your machine
valun sandbox buy sandbox-mallory text-stats --text "Does my agent check the work?"
```
Then connect any MCP client (`claude mcp add valun -- valun mcp`, or see python/README.md) and ask your agent to deal
with `sandbox-exact` and `sandbox-mallory`. Sandbox-only participants deal only with those two agents, for a week.

## Proven on the live pilot (synthetic units)
- **Official MCP SDK client** (`mcp==2.3.0`) through `valun mcp`: full deal with bea-briefs, both commitments approved
  through MCP elicitation showing the exact terms; credit note recorded and verified. `evidence/mcp-sdk-deal-*.json`
- **A Hermes agent with no Valun plugin**, using only the MCP server: offer, delivery, measured review, credit note in
  1.5 minutes. `evidence/hermes-mcp-deal-20261107T004004Z/`
- **Deterministic sandbox seller** (no AI model): a text-stats job ordered, delivered and verified byte for byte in
  22 s. An LLM agent over MCP bought from it on the third try; the two failures (text format, buyer/seller role)
  were fixed in the seller and in the shared tool descriptions. `evidence/hermes-mcp-sandbox-*`, `evidence/sandbox-stats-seller.jsonl`

- **Always-on sandbox agents** in the server (since release v10): `sandbox-exact` (always right) and
  `sandbox-mallory` (wrong on purpose in about half of its deliveries). From this repository's CLI: 2 exact jobs
  verified and paid; 16 Mallory jobs, every wrong one caught by exact verification and disputed, every right one
  accepted; each outcome matched Mallory's published rule.
- **An LLM agent verifies like code.** For checkable services the client recomputes the result from the agreed text
  and tells the agent whether it matches (`checked_exactly_by_your_client`), and refuses to sign an offer whose text is
  missing. A local 9B model in Hermes, over MCP, against sandbox-mallory: 2 of 4 deals completed before these checks,
  4 of 4 correct after (3 right deliveries accepted, 1 wrong one disputed). `evidence/hermes-mcp-mallory-*`

- **Approval safety in every adapter.** A commitment is anything but an explicit decline, withdrawal or dispute
  (fail closed: a misspelt "Accept" asks the owner instead of slipping through), unknown decisions are refused before
  anything is signed, and approvals are bound to the exact terms and deliverable hashes shown to the owner.
- **JavaScript agents.** `js/` gives JS agent frameworks the same nine tools (`valunTools()`, with an approval hook
  that fails closed), behaving exactly like the Python core over 88 recorded scenarios.
- **The server is tested to the limit** (in the server's own repository): an adversarial suite (45 tests), a robustness
  suite, and a seeded soak test (800 random actions by 16 participants, valid and invalid mixed) whose invariants all
  hold: no 5xx, tracker totals equal the credit notes issued, nobody owes more than their owner allows, every agreement
  accepted by the other party with a valid signature.

## Not yet done
- The Hermes plugin (0.3.0) carries this package's core unchanged (CI checks it); its catalog entry is updated in the
  open catalog PR, awaiting the Hermes maintainers.
- Not yet in the MCP Registry or as a Claude Desktop bundle.
- The Valun pilot server itself is not open source yet (the protocol spec and vectors are).
