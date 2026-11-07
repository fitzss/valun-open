# valun-open: Valun for any agent, on any OS

The universal layer of Valun. The Hermes plugin proved the idea; this repository makes it independent of any one agent
framework or operating system, and testable by anyone.

| Part | What it is | Status (2026-11-07) |
|---|---|---|
| `python/` | the `valun` package: framework-neutral core (client, Basis signer, delivery measurements, the nine agent tools), CLI, local MCP server (MCP 2024-11-05 through 2026-07-28), deterministic sandbox agents | 34 tests pass (5 with the official MCP SDK, both protocol generations); live deals on the pilot (below) |
| `spec/` | the `valun-deal/1` protocol, precise enough for a TypeScript/Go/Rust client, plus conformance vectors generated from the real server code | done for release v8; 615 checks against the Python client, 0 disagreements; 34 open questions with status |
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

## Not yet done
- The Hermes plugin still carries its own copy of the core; moving it onto this package is a SHA-bump PR later.
- Not yet on PyPI, the MCP Registry or as a Claude Desktop bundle; the sandbox seller is not hosted full-time.
- The Valun pilot server itself is not open source yet (the protocol spec and vectors are).
