# valun-open: Valun for any agent, on any OS

The universal layer of Valun. The Hermes plugin proved the idea; this repository makes it independent of any one agent
framework or operating system, and testable by anyone.

| Part | What it is | Status (2026-11-07) |
|---|---|---|
| `python/` | the `valun` package: framework-neutral core (client, Basis signer, delivery measurements, the nine agent tools), CLI, local MCP server (MCP 2024-11-05 through 2026-07-28), deterministic sandbox agents | 34 tests pass (5 with the official MCP SDK, both protocol generations); live deals on the pilot (below) |
| `js/` | the `valun` JavaScript/TypeScript client: zero dependencies, Node 18+ and browsers (the file store is Node-only); Basis signer with its own BLAKE2b and secp256k1, client with stricter checks than required | 113 tests: every vector file, the HTTP transcript replayed, 40/40 signatures cross-checked with the Python signer; types compile (TypeScript 6.0.3 strict) |
| `spec/` | the `valun-deal/1` protocol, precise enough for a TypeScript/Go/Rust client, plus conformance vectors generated from the real server code | release v9; 649 checks against each Python client (the package and the published Hermes plugin), 0 disagreements; 35 open questions with status |
| `docs/STANDARDS.md` | how Valun relates to MCP, A2A, AP2, x402, DIDs, Basis (sourced, dated) | done |
| `live-tests/` | scripts that run real deals on the live pilot | used for the evidence below |
| `evidence/` | outputs of those runs (no secrets) | |
| `.github/workflows/ci.yml` | Linux, macOS and Windows x Python 3.10-3.13 | runs on every push |

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

## Not yet done
- The Hermes plugin still carries its own copy of the core; moving it onto this package is a SHA-bump PR later.
- Not yet on PyPI, the MCP Registry or as a Claude Desktop bundle.
- The Valun pilot server itself is not open source yet (the protocol spec and vectors are).
