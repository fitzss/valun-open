# Valun and the open agent standards: a map

Status: research note, written 2026-11-07 (UTC). All web sources were accessed 2026-11-07 unless stated otherwise.
Scope: the open standards and ecosystems an agent-to-agent credit network should plug into, so Valun fits them instead of reinventing them.
Method: read-only web research (spec sites, official repos, official blogs, package registry APIs). Nothing was installed, signed up for, or posted.

## Legend

Every claim carries one of these labels:

- **[P]** Verified from a primary source: a spec site, an official repo, an official blog, or a registry API response read today.
- **[S]** Secondary reporting: press, a third-party blog or a search summary. Not checked against a primary source.
- **[I]** My inference or recommendation. Not a fact about the standard.
- **[U]** Could not verify. Says so instead of guessing.

"Undated" means the page shows no publication or revision date. In that case the access date (2026-11-07) is the only date available.

---

## 0. Summary table

| Standard / ecosystem | Maintainer | Current version and status | Valun action |
|---|---|---|---|
| Model Context Protocol (MCP) | MCP project (core maintainers; AAIF-hosted per the A2A blog) | Spec revision **2026-07-28**, stable [P] | **Adopt** as the main integration surface |
| MCP Registry | MCP Registry WG | **Preview**; server v1.8.8 (2026-11-06) [P] | **Adopt**: list the local server |
| MCPB bundles | modelcontextprotocol/mcpb | No tagged releases on GitHub; npm `@anthropic-ai/mcpb` 2.1.2 (2025-12-04) [P] | **Adopt** for one-click Claude Desktop install |
| A2A (Agent2Agent) | a2aproject; AAIF Growth Stage project since 2026-08-27 [P] | **v1.0.1** (release 2026-05-28; v1.0.0 2026-03-12) [P] | **Interoperate**: publish Agent Cards; defer a full A2A binding |
| AP2 (Agent Payments Protocol) | Google repo; standardization moved to the FIDO Alliance (2026-04-28) [P] | **v0.2** (2026-04-28), pre-1.0 [P] | **Align vocabulary** only; no wire conformance yet |
| x402 | x402 Foundation (repo moved from Coinbase) [P]; Linux Foundation launch 2026-04-02 [S] | Protocol **v2**; PyPI `x402` 2.27.0 (2026-11-04) [P] | **Interoperate later** through the `batch-settlement` credit-backed model; ignore for now |
| Machine Payments Protocol (MPP) | Tempo and Stripe [P] | IETF individual drafts at -01 (Sept 2026) [P] | **Ignore** until settlement exists |
| Agentic Commerce Protocol (ACP) | OpenAI and Stripe [P] | **2026-04-17**, beta [P] | **Ignore** (merchant checkout) |
| Universal Commerce Protocol (UCP) | Google plus co-developers [P] | Version not stated on site [U] | **Ignore** (merchant checkout) |
| Visa Trusted Agent Protocol, Mastercard Verifiable Intent | Visa; Mastercard (donated to FIDO) | TAP repo last push 2025-10-28 [P]; VI draft (March 2026) [S] | **Ignore** (card rails) |
| W3C DIDs / VCs | W3C | DID 1.0 Rec (2022-07-19); DID 1.1 CR (2026-03-05); VC DM 2.0 Rec (2025-05-15) [P] | **Optional**: `did:key` as an identifier format only |
| ERC-8004 Trustless Agents | Ethereum ERC authors | **Draft** (created 2025-08-13) [P] | **Watch** (Ethereum-specific) |
| Basis (BetterMoneyLabs) | BetterMoneyLabs | Active; no tagged releases; last commit 2026-11-05 [P] | Already used. **Coordinate with `basis-mcp`** |

---

## 1. Model Context Protocol (MCP)

### 1.1 What it is, who maintains it, current revision

- MCP is a JSON-RPC 2.0 protocol between hosts/clients and servers that expose tools, resources and prompts. Clients may offer elicitation. [P] https://modelcontextprotocol.io/specification/latest (revision 2026-07-28)
- **The latest revision is `2026-07-28`.** GitHub marks it "Latest" and calls it "the stable release", published 2026-07-28. [P] https://github.com/modelcontextprotocol/specification/releases/tag/2026-07-28
- The previous revision was `2025-11-25`. [P] https://modelcontextprotocol.io/specification/2026-07-28/changelog
- The A2A project describes MCP as an Agentic AI Foundation (AAIF) project alongside goose and AGENTS.md. [P, A2A blog dated 2026-08-27] https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/

**Changes in 2026-07-28 that matter to Valun** [P, changelog, revision dated 2026-07-28]:

1. Protocol-level sessions, the `Mcp-Session-Id` header and the `initialize` handshake are gone. Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and the client capabilities.
2. Servers MUST implement `server/discover`. On stdio, clients may use it as a backward-compatibility probe.
3. Servers that need state across calls should use "explicit, server-minted handles passed as ordinary tool arguments." The tools page gives a non-normative stateful-tools pattern for this.
4. Server-to-client requests (`elicitation/create`, `sampling/createMessage`, `roots/list`) are replaced by **Multi Round-Trip Requests (MRTR)**. The server returns `resultType: "input_required"` with `inputRequests`, and the client retries the original call with `inputResponses` (and `requestState`).
5. Tasks moved out of core into the extension `io.modelcontextprotocol/tasks`.
6. Roots, Sampling and Logging are **Deprecated** (minimum 12-month window). Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents.
7. `inputSchema`/`outputSchema` accept any JSON Schema 2020-12 keyword. Servers SHOULD return tools in a deterministic order. List results carry `ttlMs` and `cacheScope`.

Implications for Valun [I]:
- Deal, offer and delivery IDs are already explicit handles, so the stateless model fits.
- Do not depend on sampling or roots.
- Build on an official SDK that serves both `2025-11-25` (initialize) and `2026-07-28` (`server/discover`) clients. Many clients still connect on the earlier revision; Claude Code's documentation, for example, describes behavior for both.

### 1.2 Tool annotations

The `ToolAnnotations` interface (2026-07-28 schema) [P] https://modelcontextprotocol.io/specification/2026-07-28/schema (section `ToolAnnotations`):

| Field | Meaning (quoted or close paraphrase) | Default |
|---|---|---|
| `title` | Human-readable title | — |
| `readOnlyHint` | "If true, the tool does not modify its environment." | `false` |
| `destructiveHint` | "If true, the tool may perform destructive updates… If false, the tool performs only additive updates." Meaningful only when `readOnlyHint == false`. | **`true`** |
| `idempotentHint` | Repeated calls with the same arguments have no additional effect. Meaningful only when not read-only. | `false` |
| `openWorldHint` | The tool may interact with an "open world" of external entities. | **`true`** |

- All annotations are hints. "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers." Tools page: clients "MUST consider tool annotations to be untrusted unless they come from trusted servers." [P] https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Annotation work in progress: the Tool Annotations Interest Group (chartered 2026-04-20) lists SEP-1913 "Trust and Sensitivity Annotations" (Draft), SEP-1984 "Comprehensive Tool Annotations" (Draft), SEP-1862 and SEP-2417 (Draft). [P] https://modelcontextprotocol.io/community/interest-groups/tool-annotations

**How clients act on annotations** (each documented by the vendor):

| Client | Documented behavior | Source |
|---|---|---|
| Claude Code | `readOnlyHint: true` tools run in parallel with other read-only calls. `idempotentHint`/`readOnlyHint` mark tools safe to repeat once after a dropped HTTP connection. Separately, `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even in bypass modes. In `dontAsk` mode the call is denied. With `--permission-prompt-tool` an allow is converted to a deny. | [P, undated; mentions v2.1.304] https://code.claude.com/docs/en/mcp |
| VS Code (Copilot) | "VS Code doesn't ask for confirmation to run read-only tools" (`readOnlyHint`). | [P, page shows 11/4/2026] https://code.visualstudio.com/api/extension-guides/ai/mcp |
| OpenAI Codex | `default_tools_approval_mode` values include `writes`, which "prompts for tools that aren't marked read-only". There is a per-tool `approval_mode` override. | [P, undated] https://learn.chatgpt.com/docs/extend/mcp?surface=cli |
| ChatGPT / Responses API | "ChatGPT currently requires manual confirmation in any conversation before write actions can be taken." It warns that write actions can occur "even if the MCP server has tagged the action as read only." | [P, undated] https://developers.openai.com/api/docs/mcp/ |
| Hermes Agent | Servers with `trust: untrusted` prompt before write-capable calls. Optional `tool_costs` and `spend_limit` set a per-chat budget. | [P, undated] https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp |
| Cursor, Gemini CLI | Annotation behavior not documented on the pages read. Gemini CLI uses a per-server `trust` flag instead. | [U] / [P] https://geminicli.com/docs/tools/mcp-server/ |

**Proposed annotation policy for Valun tools** [I]:
- Read and list tools (directory, offers, deal status, notes, mandate view): set `readOnlyHint: true` and `openWorldHint: false` when they only read Valun's own store.
- Signing tools (make or accept an offer, deliver, record a stricter limit): set `readOnlyHint: false` and `openWorldHint: true`, since they reach other agents and the tracker. Set `idempotentHint: true` only when the call carries a caller-supplied idempotency key.
- Accept-delivery / issue-credit-note: set **`destructiveHint: true`**, even though the ledger write is additive. Clients use this flag to decide whether to confirm, and issuing an IOU is an irreversible obligation. Also set `_meta["anthropic/requiresUserInteraction"]: true` so Claude Code always shows a prompt.
- Always set `destructiveHint` explicitly. The default is `true`, so omitting it makes every write tool look destructive.

### 1.3 Elicitation (the server asking the user)

Spec rules [P] https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation (revision 2026-07-28):

- There are two modes. **Form** collects structured data that the client sees, restricted to a flat object of primitive types. **URL** sends the user to an out-of-band URL; the client does not see the data. URL mode was introduced in 2025-11-25.
- In 2026-07-28, elicitation is delivered inside an `InputRequiredResult` (MRTR) and answered on a retry. Responses are `accept`, `decline` or `cancel`. Clients declare `elicitation: {form:{}, url:{}}` per request. An empty object means form only.
- "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials". Those must use URL mode.
- Servers "MUST NOT rely on client-provided user identification without server verification."

**Client support** (only what was found in vendor docs today):

| Client | Elicitation | Source |
|---|---|---|
| Claude Code | **Yes, form and URL.** It declares `elicitation: {form: {}, url: {}}` on 2026-07-28 connections, and on earlier-revision connections to configured stdio/http servers (v2.1.287+). Elicitation is served only in interactive terminal sessions. An `Elicitation` hook can auto-respond. | [P] https://code.claude.com/docs/en/mcp |
| Cursor | **Yes** ("Supported" in its protocol table) | [P, undated] https://cursor.com/docs/context/mcp |
| VS Code (Copilot) | **Yes** (listed: "Elicitation: request input from the user") | [P, 11/4/2026] https://code.visualstudio.com/api/extension-guides/ai/mcp |
| Hermes Agent | **Form only.** Requests go through Hermes's approval surface (Allow Once / Deny). YOLO mode and `approvals.mode: off` do not answer them. **URL-mode requests are declined.** On by default, 300 s timeout. | [P] https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp |
| OpenAI Codex | Not mentioned on the MCP page | [U] |
| OpenAI Agents SDK | Not mentioned on the MCP page | [U] https://openai.github.io/openai-agents-python/mcp/ |
| ChatGPT | Not mentioned on the MCP page | [U] |
| Gemini CLI | Not mentioned on the MCP server page | [U] |
| Claude Desktop | Not checked against a primary source | [U] |

Secondary reports claim wider support (for example "13 clients"). Those were not verified. [S] https://www.devmoment.dev/journal/mcp-elicitation-field-log-2026

Implications for Valun [I]:
- **Elicitation is a convenience, not proof of owner consent.** Claude Code hooks can answer it automatically, and any client can misrepresent it. Owner mandates must stay enforced on the server, as they are today.
- Use **form mode** with a single boolean or enum confirmation, for example "Accept delivery D-123 and issue a note for 40 units to X?". It works in Claude Code, Cursor, VS Code and Hermes. Hermes declines URL mode.
- Never put passphrases or keys in form mode. Owner sign-in belongs in URL mode or in MCP authorization (1.4).
- Fall back cleanly when `elicitation` is not declared. The spec requires servers to handle decline, cancel and absence.

### 1.4 Authorization for remote servers

[P] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (revision 2026-07-28)

- Authorization is **OPTIONAL**. Implementations "using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment."
- For HTTP: the server is an OAuth 2.1 resource server.
  - Servers MUST implement Protected Resource Metadata (RFC 9728).
  - Clients MUST send `resource` (RFC 8707) and use PKCE.
  - Servers MUST validate the token audience. Token passthrough is forbidden.
  - Client registration options: Client ID Metadata Documents (SHOULD), pre-registration, or DCR (deprecated).
  - Clients must validate `iss` (RFC 9207).
- Official auth extensions (both Stable): OAuth Client Credentials (machine-to-machine) and Enterprise-Managed Authorization. [P] https://modelcontextprotocol.io/extensions/overview
- ChatGPT supports CIMD (with `none` or `private_key_jwt`), and DCR "remains supported when configured." [P, undated] https://developers.openai.com/api/docs/mcp/
- Codex supports OAuth with CIMD and DCR, or a pre-registered client ID. [P] https://learn.chatgpt.com/docs/extend/mcp?surface=cli

Implications for Valun [I]:
- The local stdio server should read the agent key path and tracker URL from the environment or config. No OAuth is needed there.
- The hosted `/mcp` endpoint uses a passphrase (per project notes), which is outside the MCP authorization spec. Remote-only clients such as ChatGPT expect OAuth with PRM.
- OAuth Client Credentials is the natural fit for headless agents acting under an owner mandate.

### 1.5 The official MCP Registry

[P, all undated pages] https://modelcontextprotocol.io/registry/about · https://modelcontextprotocol.io/registry/package-types · https://modelcontextprotocol.io/registry/authentication

- **Status: "currently in preview. Breaking changes or data resets may occur before general availability."** The latest registry server release is v1.8.8 (2026-11-06). [P] https://github.com/modelcontextprotocol/registry/releases
- It stores metadata only, in `server.json` (schema URL `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`), and points at packages on npm, PyPI, NuGet, crates.io, OCI registries or MCPB release assets. It also lists remote servers. Private servers are not supported.
- It is meant for downstream aggregators and marketplaces, which pull from it. Host apps are not meant to query it directly.
- **Namespaces and authentication:**
  - GitHub login (`mcp-publisher login github`, device flow) grants `io.github.<user-or-org>/*`.
  - DNS TXT or HTTP `/.well-known/mcp-registry-auth` (Ed25519 or ECDSA P-384 keys) grants reverse-DNS `com.example.*/*`.
- **Package ownership checks:**
  - npm: `"mcpName"` in `package.json` must equal the server name.
  - PyPI and NuGet: the README must contain `mcp-name: <server name>`; an HTML comment is allowed.
  - Cargo: the marker must be visible text, because crates.io strips comments.
  - OCI: the label `io.modelcontextprotocol.server.name`.
  - MCPB: the URL must contain "mcp", plus a `fileSha256`.
- Runners named on the page: `npx` (npm), `uvx` (PyPI), `dnx` (NuGet).
- **Search works.** `GET https://registry.modelcontextprotocol.io/v0/servers?search=filesystem&limit=3` returned entries, and `search=valun` returned `{"servers":[],"metadata":{"count":0}}`. [P, queried 2026-11-07 00:29 UTC]
- Implication [I]: the GitHub account `valun` belongs to an unrelated user (see §6), so `io.github.valun/*` is not available. Use `io.github.<owner-account>/valun`, or a domain you control with DNS or HTTP proof.

### 1.6 Packaging conventions

- Clients launch local servers as `command` plus `args`, usually `npx -y <pkg>` or `uvx <pkg>`. Example (Claude Desktop config): `{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem", "..."]}}}`. Config paths: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. [P] https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers
- **MCPB (MCP Bundles, formerly DXT):**
  - A zip (`.mcpb`) holding the server and a `manifest.json`, for one-click install.
  - The README says Claude for macOS and Windows uses this code.
  - Server types: node, python, binary, and `uv` (v0.4+).
  - No tagged releases on GitHub. npm `@anthropic-ai/mcpb` is at 2.1.2 (2025-12-04).
  - [P] https://github.com/modelcontextprotocol/mcpb
- **SDKs:** Tier 1 SDKs are TypeScript, Python, C#, Go, Rust and Ruby. "SDKs adopt new protocol revisions on their own schedules." [P] https://modelcontextprotocol.io/docs/2026-07-28/sdk. Current packages [P, registry APIs]:
  - PyPI `mcp` 2.3.0 (2026-10-02) and `fastmcp` 4.1.6 (2026-11-03).
  - npm `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0 (2026-10-23); legacy `@modelcontextprotocol/sdk` 1.32.2 (2026-10-23).
  - The OpenAI Agents SDK docs say the MCP Python SDK v2 client sends a `server/discover` probe and falls back to `initialize` for older servers. [P] https://openai.github.io/openai-agents-python/mcp/

### 1.7 Which clients run local stdio servers

| Client | Local stdio | Remote HTTP | How to add | Source |
|---|---|---|---|---|
| Claude Desktop | Yes (JSON config; also MCPB) | Yes (remote connectors) | `claude_desktop_config.json` → `mcpServers` | [P] connect-local-servers page (above) |
| Claude Code | Yes | Yes, OAuth; SSE deprecated | `claude mcp add <name> -- <command> [args]` | [P] https://code.claude.com/docs/en/mcp |
| Cursor | Yes | Yes (SSE, Streamable HTTP, OAuth) | `mcp.json` (`command`, `args`) | [P] https://cursor.com/docs/context/mcp |
| VS Code (Copilot) | Yes ("Command (stdio)") | Yes | MCP config; marketplace (Preview) | [P] https://code.visualstudio.com/docs/copilot/chat/mcp-servers |
| OpenAI Codex | Yes | Yes, OAuth (CIMD, DCR) | `config.toml` `[mcp_servers.<name>] command=… args=[…]` | [P] https://learn.chatgpt.com/docs/extend/mcp?surface=cli |
| OpenAI Agents SDK | Yes (`MCPServerStdio`) | Yes (`MCPServerStreamableHttp`, `HostedMCPTool`) | code | [P] https://openai.github.io/openai-agents-python/mcp/ |
| ChatGPT | **No local stdio documented**; remote only | Yes | developer mode / apps | [P] https://developers.openai.com/api/docs/mcp/ |
| Gemini CLI | Yes | Yes (`httpUrl`; SSE via `url`), OAuth | `settings.json` `mcpServers` (`command`, `args`, `trust`) | [P] https://geminicli.com/docs/tools/mcp-server/ (npm 0.67.0, 2026-11-04) |
| Hermes Agent | Yes | Yes (`auth: oauth`) | `~/.hermes/config.yaml` `mcp_servers` (`command`, `args`, `env`); `/reload-mcp` | [P] https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp (release v0.23.0, 2026-11-05) |
| Goose, Microsoft 365 Copilot, Postman, MCPJam, others | Listed as MCP clients; stdio not re-verified today | — | — | [P list / U details] https://modelcontextprotocol.io/extensions/client-matrix |

Hermes detail [P]: stdio servers get only the variables listed under `env` plus a safe baseline, not the full shell environment. Valun's Hermes setup must pass the key path or tracker URL explicitly.

### 1.8 Extensions and groups worth tracking

- **MCP Apps** (Stable): interactive UI inline in chat. Cursor lists it as Supported; VS Code calls it Experimental. [P] extensions overview; Cursor and VS Code pages above. A possible later home for a deal or mandate confirmation view. [I]
- **MCP Tasks** (Beta, heading to Core): long-running operations with polling. In public beta in the Claude Code CLI from v2.1.304 (not in the VS Code extension or the desktop app). [P] extensions overview; https://code.claude.com/docs/en/mcp. Could model "waiting on counterparty delivery", but handle-plus-poll tools work in every client today. [I]
- **Server Cards** (SEP-2127 Final, created 2026-01-21; extension at Beta): pre-connection discovery for *remote* servers. The recommended location is `<streamable-http-url>/server-card`. Domain-level discovery goes through an **AI Catalog** at `/.well-known/ai-catalog.json`. [P] https://modelcontextprotocol.io/seps/2127-mcp-server-cards
- **AI Catalog**: a cross-protocol discovery document (MCP, A2A and others). Repo created 2025-10-29, active 2026-11-06. [P] https://github.com/Agent-Card/ai-catalog
- **Financial Services Interest Group** (chartered 2026-06-25): scope covers "tamper-evident, portable records of what a tool call did, under what authority, and against which policy", attestations, and policy enforcement. It is the most relevant MCP venue for Valun's mandate and receipt model. [P] https://modelcontextprotocol.io/community/interest-groups/financial-services
- **No official MCP payments extension or SEP was found.** [U] Search of the MCP docs index on 2026-11-07 found none.

### 1.9 Overlap with Basis's own MCP server

BetterMoneyLabs already ships **`basis-mcp`**, a stdio MCP server built on rmcp 0.17. [P, spec last changed 2026-08-21] https://github.com/BetterMoneyLabs/basis-tracker/blob/master/specs/agent_integration.md

- Read-only tools, annotated `readOnlyHint: true`: `server_status`, `account_list`, `note_list`, `note_get`, `reserve_status`, `policy_get`.
- Write tools: `account_create`, `account_import`, `note_create`, `note_redeem` (`destructiveHint`), `reserve_create`, `policy_set` (`destructiveHint`).
- Amounts are in nanoERG. Public keys are 33-byte compressed secp256k1 hex.
- Accounts are shared with the CLI and TUI through `~/.basis/cli.toml`.

Implication [I]: Valun's MCP server should own the deal, mandate and acceptance layer and not duplicate Basis wallet tools. Document how a user runs both servers side by side. Note that a raw `note_create` through `basis-mcp` would bypass Valun's mandate checks. The Valun spec should say whether that is allowed for Valun-bound keys.

---

## 2. Agent2Agent (A2A)

### 2.1 Version, governance, maintainers

- **Current: v1.0.1**, release dated 28 May (changelog 2026-05-26); it "corrects TaskStatus values" and prefers the `application/a2a+json` media type. **v1.0.0** is dated 2026-03-12 (breaking changes). v0.3.0 is dated 2025-07-30. [P] https://github.com/a2aproject/A2A/releases
- Governance: "officially been accepted as a Growth Stage project at the Agentic AI Foundation (AAIF)", which is "Linux Foundation-directed", alongside MCP, goose and AGENTS.md. Dated 2026-08-27. [P] https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/. Axios reported the move on 2026-08-17; earlier history (created by Google April 2025, Linux Foundation June 2025) comes from secondary sources. [S] https://axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards
- SDKs: Python, Go, Java, JavaScript, .NET and Rust. PyPI `a2a-sdk` 1.3.0 (2026-10-27); npm `@a2a-js/sdk` 1.3.0 (2026-09-29). [P] https://a2a-protocol.org/latest/ and the registry APIs.

### 2.2 Agent Cards and discovery

[P] https://a2a-protocol.org/latest/specification/ (v1.0 spec, undated page)

- **Well-known location:** `https://{server_domain}/.well-known/agent-card.json` (renamed from `agent.json` in v0.3.0). (Spec §8.2.)
- **AgentCard fields (§4.4.1):**
  - Required: `name`, `description`, `supportedInterfaces[]`, `version`, `capabilities`, `defaultInputModes[]`, `defaultOutputModes[]`, `skills[]`.
  - Optional: `provider`, `documentationUrl`, `securitySchemes`, `securityRequirements`, `signatures[]`, `iconUrl`.
- `AgentInterface` (§4.4.6): `url`, `protocolBinding`, `protocolVersion` (all required); `tenant` optional.
- `AgentSkill` (§4.4.5): `id`, `name`, `description`, `tags` (all required); `examples`, `inputModes`, `outputModes`, `securityRequirements` optional.
- **Card signing (§8.4):**
  - JWS (RFC 7515) over the card, canonicalized with JCS (RFC 8785), with `signatures` excluded.
  - The protected header MUST include `alg`, `typ` and `kid`, and MAY include `jku`.
- **Registries:** "The current A2A specification does not prescribe a standard API for curated registries." There are three discovery strategies: the well-known URI, curated registries, and direct configuration. [P] https://a2a-protocol.org/latest/topics/agent-discovery/

### 2.3 Task model

[P] v1.0 specification (above):

- **Task states:**
  - Non-terminal: `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`.
  - Interrupted: `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`.
  - Terminal: `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`.
- `Message` has `messageId`, `contextId`, `taskId`, `role` (`ROLE_USER` or `ROLE_AGENT`), `parts`, `metadata`, `extensions` and `referenceTaskIds`.
- Results "should go in Artifacts rather than Messages."
- Bindings: JSON-RPC, gRPC and HTTP+JSON/REST, which must be functionally equivalent. v1.0.0 added `tasks/list`.
- Extensions are declared on the card. The `A2A-Extensions` service parameter and `ExtensionSupportRequiredError` cover required extensions.

### 2.4 Mapping a Valun participant directory to Agent Cards [I]

One card per participant agent. The directory serves the cards, and optionally one AI Catalog lists them. Illustrative card (check exact `protocolBinding` enum values and `AgentExtension` field names in spec §4.4 before use):

```json
{
  "name": "owner-A / csv-cleaner",
  "description": "Valun participant. Sells CSV cleaning (csv-clean/1) for Valun credit notes. Synthetic units; no settlement.",
  "version": "0.2.0",
  "provider": { "organization": "Owner A", "url": "https://example.invalid" },
  "supportedInterfaces": [
    { "url": "https://valun-desk.fly.dev/a2a/agents/owner-a-csv", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [
      { "uri": "https://<valun-domain>/ext/credit/v0", "required": false,
        "params": { "basisPubkey": "02…(33-byte hex)", "tracker": "https://…", "unit": "synthetic", "mandateDigest": "…" } }
    ]
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json", "text/csv"],
  "skills": [
    { "id": "csv-clean-1", "name": "CSV cleaning (csv-clean/1)", "description": "Cleans a CSV to the csv-clean/1 spec; delivery is machine-checked before acceptance.",
      "tags": ["data", "csv", "valun-credit"] }
  ]
}
```

| Valun concept | A2A equivalent | Fit |
|---|---|---|
| Participant listing | AgentCard (well-known path, or served by the Valun directory) | Good |
| Service offered | `AgentSkill` | Good |
| Participant secp256k1 key, tracker, mandate summary | Custom extension under `capabilities.extensions` | Good, but it is Valun-defined |
| Signed offer / acceptance | `Message` with a data part carrying the Basis-signed object | Workable |
| Clarification / counter-offer | `TASK_STATE_INPUT_REQUIRED` | Good |
| Delivery | `Artifact` | Good |
| Buyer runs the acceptance check, then issues a credit note | **No A2A equivalent.** A2A task states describe the *remote* agent's processing, not the buyer's acceptance. Carry it as a follow-up message or artifact that references the task (`referenceTaskIds`). | Partial |
| Card signature | JWS. **Basis Schnorr signatures are not a JOSE algorithm** (see §5.1), so signing cards needs a separate standard key or an unregistered `alg`. | Gap |

Recommendation [I]: **interoperate, don't adopt as the core transport yet.**
- Publishing cards makes Valun participants discoverable by A2A tooling at low cost.
- A full A2A binding for the deal flow is a larger job. Defer it until a real A2A counterparty wants to trade.

---

## 3. AP2 (Agent Payments Protocol)

### 3.1 Status

- **v0.2 released on GitHub and donated to the FIDO Alliance**, per a Google blog post by Stavan Parikh dated **2026-04-28**. The headline feature is "Human Not Present" payments under pre-authorized instructions. Mastercard co-developed **Verifiable Intent**, which is also being donated to FIDO. [P] https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/
- FIDO (2026-04-28) set up an Agentic Authentication Technical Working Group, chaired by CVS Health, Google and OpenAI, with Amazon, Google and Okta as vice-chairs. Agent commerce goes to the Payments TWG, chaired by Mastercard and Visa. "Work has already started." No milestones were published. [P] https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/
- The repo `google-agentic-commerce/AP2` (Apache-2.0) shows no tagged releases and was last pushed 2026-06-17. The README says a PyPI package is "planned". [P] https://github.com/google-agentic-commerce/AP2
- The site describes AP2 as an extension of A2A and UCP in one place and of A2A and MCP in another; the site is inconsistent. [P] https://ap2-protocol.org/ (undated, "Copyright 2025 Google"). AP2 was first announced 2025-09-16. [P, linked from the site; not fetched] https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol

### 3.2 Mandates and credentials (current site)

- **Naming has changed.** The current site defines a **Checkout Mandate** and a **Payment Mandate**, each **Open** (constraints before a final cart or amount) or **Closed** (bound to one finalized transaction). The "Intent / Cart / Payment" names in the Valun brief come from the 2025 launch material. I did not re-verify them today. [P for current names; U for the old names]
- **Open Payment Mandate** (`vct` = `mandate.payment.open.1`). Constraint types [P] https://ap2-protocol.org/ap2/payment_mandate/:
  - `payment.amount_range` {`currency`, `max`, `min?`}
  - `payment.allowed_payees` {`allowed`[]}
  - `payment.allowed_payment_instruments`
  - `payment.allowed_pisps`
  - `payment.budget` {`max`, `currency`}
  - `payment.agent_recurrence` {`frequency`, `max_occurrences?`}
  - `payment.execution_date` {`not_before`, `not_after`}
  - `payment.reference` {`conditional_transaction_id`}
  - Plus `iat` and `exp`.
- **Closed Payment Mandate** (`mandate.payment.1`): `transaction_id`, `payee`, `payment_amount`, `payment_instrument`.
- **Open Checkout Mandate** (`mandate.checkout.open.1`): constraints `checkout.allowed_merchants` and `checkout.line_items`. The closed form carries a merchant-signed `checkout_jwt` and a `checkout_hash`. The merchant returns a Checkout Receipt. [P] https://ap2-protocol.org/ap2/checkout_mandate/
- **Credential format in the examples:** SD-JWT with `alg` ES256, `_sd_alg` sha-256, and holder key binding through `cnf.jwk` (EC P-256). An open mandate is "closed" when the agent creates a Key Binding JWT with the `cnf` key. "They MUST support cryptographic Key Binding" for open mandates. [P] https://ap2-protocol.org/ap2/agent_authorization/
- **Who signs:**
  - User Credential model: a Trusted Surface acting as Holder builds mandates after user consent.
  - Trusted Agent Provider model: the provider signs with a key the agent "is not able to access".
  - The Verifier signs a Mandate Receipt.
  - A Verifier must treat an unknown constraint as failing. [P, same page]
- The site itself has inconsistencies: a `vct` value differs between a table and the prose, and an example uses decimal amounts while the spec says integer minor units. [P, observed on the payment_mandate page]

### 3.3 How closely Valun's owner mandate maps [I]

| Valun owner mandate | AP2 v0.2 open Payment Mandate | Notes |
|---|---|---|
| Per-deal limit | `payment.amount_range.max` | Direct |
| Total owed limit | `payment.budget.max` | **Semantic gap.** AP2's budget caps spending; Valun's cap is on *outstanding* debt, which falls when notes are redeemed. Name it differently, e.g. `credit.max_outstanding`. |
| Allowed counterparties | `payment.allowed_payees` | Direct. The Valun buyer is the debtor, so the payees are the sellers. |
| Expiry | `exp`, or `payment.execution_date.not_after` | Direct |
| Agent records a stricter limit | No equivalent. AP2 agents cannot change a mandate. | Could be modeled as a second, narrower mandate chained to the first |
| Agreed terms + delivery check | Nearest is `checkout.line_items` plus the merchant-signed checkout | AP2 has **no delivery-verification step**. Valun's acceptance check is new. |
| Credit note (signed IOU) | None. Nearest are AP2 receipts and x402 signed receipts (§4.1). | AP2 is payment-instrument-centric |
| Mandate signer | AP2: a Trusted Surface or Agent Provider signs an SD-JWT that any third party can verify | Valun: the owner sets the mandate on the server, which enforces it, so **counterparties cannot verify it themselves**. AP2's main idea worth borrowing is a mandate that is a signed credential. |

**Is aligning worthwhile?** [I]
- **Vocabulary: yes.** Use AP2's constraint names and the open/closed idea in the Valun spec, so a later AP2 or FIDO bridge is a mapping, not a redesign. Effort: hours.
- **Wire conformance: not now.**
  - AP2 is pre-1.0 and moving into FIDO working groups with no published timeline.
  - It assumes ES256 or P-256 SD-JWTs, while Basis uses secp256k1 Schnorr.
  - It models credential providers and payment networks that Valun does not have.
  - It has no concept of credit or delivery acceptance.
- Revisit when FIDO publishes a draft.

---

## 4. x402 and other agent payment protocols; credit versus payment

### 4.1 x402

- **Maintainer:** the repo moved, as stated: "We've moved the x402 repo under the x402 Foundation repo." `coinbase/x402` is now a development fork. [P] https://github.com/coinbase/x402. Canonical repo: [P] https://github.com/x402-foundation/x402 (Apache-2.0; `TSC.md`; specs last changed 2026-11-06).
- The x402 Foundation launched under the Linux Foundation on 2026-04-02. Named backers include Google, Microsoft, AWS, Visa, Mastercard, Stripe and Cloudflare; member counts vary by outlet. [S] https://genfinity.io/2026/04/02/x402-protocol-linux-foundation-ai-payment-protocol
- **Protocol version 2.** `specs/x402-specification-v2.md` reads "Protocol Version: 2". The flow is: a request without payment gets a "payment required" response; the client retries with a signed payment authorization; the server verifies, then settles through a facilitator.
  - HTTP headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`.
  - The spec puts "Client-side budget management" out of scope.
  - [P] https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- **Schemes** (`specs/schemes/`): `exact`, `upto`, `batch-settlement`, `auth-capture`. **Transports** (`specs/transports-v2/`): `http`, `mcp`, `a2a`. [P, GitHub API listing]
- **Over MCP:**
  - The server returns a tool result with `isError: true`, carrying `PaymentRequired` in both `structuredContent` and `content[0].text`.
  - The client retries with `_meta["x402/payment"]`.
  - Settlement comes back in `_meta["x402/payment-response"]`.
  - [P] https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
- **`batch-settlement` is the part closest to Valun.** "The client provides a cryptographic payment commitment at request time, but the transfer of value is not executed synchronously." Network bindings choose one of two models:
  - **Capital-backed:** escrow, channels, delegated authorization.
  - **Credit-backed:** "backed by a verified identity associated with a billing account managed by a trusted network intermediary".
  - Every binding MUST specify: commitment format, verification, storage, double-spend prevention, expiry, redemption, and trust model.
  - Cloudflare's `cloudflare:402` binding is credit-backed and uses RFC 9421 HTTP Message Signatures.
  - [P] https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md and `scheme_batch_settlement_cloudflare.md`
- **Offer-and-Receipt extension:** server-signed offers and receipts "for dispute evidence… and reputation systems". The wire shape is "not considered stable". [P] https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md
- **Packages:** PyPI `x402` 2.27.0 (2026-11-04); npm `@x402/core` 2.30.0 (2026-11-04). [P, registry APIs]
- **Valun integration point** [I]:
  - A Basis note fits the `batch-settlement` credit-backed shape. The commitment would be a signed cumulative-debt note, the identifier a note or tracker reference, and redemption a Basis reserve redemption. The trust anchor would be the debtor's reserve, or none for unbacked credit.
  - That would let any x402 client "pay" a Valun seller with an IOU.
  - Limits: x402 is per-request and settles at request time. Valun's negotiate, deliver, check and accept flow does not fit inside one HTTP exchange. Write the mapping into the spec as informative text now; build it only if x402 clients ask.

### 4.2 Machine Payments Protocol (MPP)

- An open standard co-authored by Tempo and Stripe, announced **2026-03-18** by Jeff Weinstein and Steve Kaliski. Stablecoins settle on Tempo; cards and BNPL go through Shared Payment Tokens. "Stripe supports both MPP and x402." [P] https://stripe.com/blog/machine-payments-protocol
- Flow: `402` with `WWW-Authenticate: Payment`, then a retry with `Authorization: Payment`. Intents: charge, session, subscription. Methods: Tempo, Stripe, Lightning, Solana and others. Specs are CC0. [P] https://github.com/tempoxyz/mpp-specs
- Core governance goes through the IETF standards track; each payment method is maintained by its rail. [P] https://mpp.dev/governance
- IETF: `draft-ryan-httpauth-payment-01` (2026-09-18) and `draft-httpauth-payment-01` (2026-09-09), "The 'Payment' HTTP Authentication Scheme". Both are drafts, not RFCs. [P] https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/

### 4.3 Agentic Commerce Protocol (ACP)

- Founding maintainers OpenAI and Stripe; consensus governance; a "future move to neutral foundation stewardship" is planned. Spec status: **beta**.
- Date-versioned releases: 2025-09-29, 2025-12-12, 2026-01-16, 2026-01-30, and **2026-04-17** (cart, feed, orders, authentication and an **MCP binding**). Components: Checkout API and Delegate Payment (OpenAPI).
- [P] https://github.com/agentic-commerce-protocol/agentic-commerce-protocol · https://www.agenticcommerce.dev/ (undated)

### 4.4 Universal Commerce Protocol (UCP)

- Catalog, cart, checkout, identity linking (OAuth 2.0) and orders. Transports: REST and JSON-RPC, with MCP and A2A support "built in". Payments go through AP2.
- Co-developers include Google, Shopify, Walmart, Target, Microsoft, Meta, Stripe and others.
- No version is stated on the site [U]. The repo was created 2025-12-31 and is active (2026-11-06).
- [P] https://ucp.dev/ · https://github.com/Universal-Commerce-Protocol/ucp

### 4.5 Card networks

- **Visa Trusted Agent Protocol:** agents sign requests with RFC 9421 signatures bound to the merchant domain and operation; there is an agent public-key registry. The repo has 6 commits and **was last pushed 2025-10-28**. [P] https://github.com/visa/trusted-agent-protocol. Launched October 2025 with Cloudflare. [S] https://www.visa.com/en-ua/newsroom/visa-trusted-agent-protocol (not fetched)
- **Mastercard Verifiable Intent:** announced 2026-03-05 as an open spec co-developed with Google that links cardholder, agent instructions and outcome. Reported as Draft v0.1, for Mastercard Agent Pay. [S] https://www.pymnts.com/mastercard/2026/mastercard-unveils-open-standard-to-verify-ai-agent-transactions/. Being donated to FIDO. [P, Google and FIDO posts of 2026-04-28 above]

### 4.6 Lightning / L402

- Lightning Labs released "Lightning Agent Tools" (L402 client `lnget`, Aperture, scoped macaroons), dated 2026-02-11 in the post URL. Described as early alpha. [S; post not fetched] https://lightning.engineering/posts/2026-02-11-ln-agent-tools/

### 4.7 What each solves, and how credit differs [I, grounded in the sources above]

| Protocol | Problem it solves | When value moves |
|---|---|---|
| x402 `exact` / `upto` | Pay per HTTP request or tool call, mainly in stablecoins | At or right after the request |
| x402 `batch-settlement` | Make micropayments cheap: commit now, redeem in batches | Later, through a pre-defined redemption rail; capital- or credit-backed |
| MPP | HTTP 402 payments across rails; sessions and subscriptions | At charge time, or metered within a session |
| ACP / UCP | Agent-driven checkout with a merchant of record | At checkout, on existing card or wallet rails |
| AP2 | Verifiable proof that a user authorized an agent's purchase, within limits | At checkout. AP2 is the authorization layer, not the rail. |
| Visa TAP / Mastercard VI | Agent identity and intent for card networks | Card rails |
| **Valun** | **Service-for-credit between independent agents.** An IOU is issued *only after* delivered work passes the agreed check, within an owner mandate. | **Possibly never.** A note is a recorded obligation, optionally backed by an on-chain reserve. Units are synthetic today. |

Key differences for the spec:
1. **Counterparty risk is the product.** Payment protocols try to remove it. Credit has to bound it with mandate limits, acceptance checks, collateral and reputation.
2. **Order of events.** Payment protocols authorize before or at delivery. Valun creates value only on acceptance after delivery.
3. **Limits are stock, not flow.** "Total owed" is an outstanding balance, unlike AP2's `budget` or an x402 cap.
4. **The trust anchor differs.** Under Basis, a tracker that omits a note can block its redemption. See §5.4.

---

## 5. Other directly relevant work

### 5.1 Agent identity and key standards

- **W3C status** [P, W3C TR pages]:
  - DID Core 1.0: Recommendation, 2022-07-19. https://www.w3.org/TR/did-core/
  - DID 1.1: Candidate Recommendation Snapshot, 2026-03-05. https://www.w3.org/TR/did-1.1/
  - VC Data Model 2.0: Recommendation, 2025-05-15. https://www.w3.org/TR/vc-data-model-2.0/
  - Controlled Identifiers 1.0: Recommendation, 2025-05-15. https://www.w3.org/TR/cid-1.0/
  - VC JOSE/COSE: Recommendation; the TR page is dated 2026-10-13. https://www.w3.org/TR/vc-jose-cose/
- **`did:key`** (W3C CCG draft) lists the `secp256k1-pub` (compressed) key type, so a Basis public key can be written as a `did:key` identifier. [P] https://w3c-ccg.github.io/did-key-spec/
- **JOSE algorithms:** the IANA registry has `ES256K` ("ECDSA using secp256k1 curve and SHA-256") and EdDSA/Ed25519. **There is no Schnorr-over-secp256k1 entry.** [P] https://www.iana.org/assignments/jose/jose.xhtml
- **Basis signature format:** "65-byte Schnorr signatures following chaincash-rs format" (prefix plus 33-byte `a` plus 32-byte `z`), "compatible with Ergo". [P] https://github.com/BetterMoneyLabs/basis-tracker/blob/master/specs/SCHNORR_SIGNATURE_SPEC.md
  - Inference [I]: this is not BIP-340 (BIP-340 signatures are 64 bytes) and not a JOSE algorithm.
  - Consequence: JWS-based standards (A2A card signatures, VC-JOSE, AP2 SD-JWTs) cannot carry Basis signatures natively.
  - Options: (a) keep Basis keys for notes only, and give each participant a second standard key (ES256 or Ed25519) for cards and credentials, linked by a signed statement; or (b) define a private `alg`. Option (a) is safer. Reusing one secp256k1 key across Schnorr and ECDSA is legal math but needs a careful cross-protocol review.
- **Agent Commerce Kit (Catena Labs, MIT):** ACK-ID (DIDs and VCs linking agents to owners) and ACK-Pay (payment requests, receipts as VCs, human oversight). There is an "ACK-ID A2A Demo". Repo active 2026-11-06. Exact DID methods and algorithms were not confirmed from the pages read. [P index / U details] https://www.agentcommercekit.com/llms.txt
- **IETF individual drafts** (not standards; dates are of the latest revision) [P] https://datatracker.ietf.org/:
  - `draft-meunier-web-bot-auth-architecture-05` (2026-03-02)
  - `draft-meunier-http-message-signatures-directory-05` (2026-03-02)
  - `draft-hardt-aauth-protocol-02` (2026-04-29)
  - `draft-oauth-ai-agents-on-behalf-of-user-02` (2026-02-27)
  - `draft-narajala-ans-00`, Agent Name Service (2025-11-18)
  - `draft-munoz-wimse-authorization-evidence-01` (2026-07-19)

### 5.2 Reputation and attestation

- **ERC-8004 "Trustless Agents":** status **Draft**, created 2025-08-13.
  - Three per-chain registries: Identity (ERC-721; registration file with `services` pointing to A2A cards, MCP endpoints and DIDs, plus `x402Support`), Reputation (`giveFeedback` with `value`, `tag1`, `tag2`, `feedbackURI`, `feedbackHash`), and Validation (`validationRequest`/`validationResponse`, 0-100).
  - Summaries "must be filtered by client addresses" to resist Sybil attacks.
  - [P] https://eips.ethereum.org/EIPS/eip-8004
  - Reported live on Ethereum mainnet 2026-01-29, with about 24k registrations in week one. [S] https://rnwy.com/learn/erc-8004-trustless-agents
- **x402 offer-and-receipt** (§4.1) targets verifiable "I paid and received service" attestations. [P]
- **Valun position** [I]: Valun's signed offers, deliveries, check results and accepted notes are already *stronger* evidence than star ratings. Each accepted note is a signed, checkable record of delivered work. Do not adopt ERC-8004, which is Ethereum-bound while Valun is on Ergo. Do shape Valun's public deal record so it could be exported as ERC-8004-style feedback (`value`, tags, URI, hash) later.

### 5.3 Other agent credit / IOU systems

- **Basis** (below) and its sibling **ChainCash** (elastic peer-to-peer money backed collectively by assets and trust; repo active 2026-07-16). [P] https://github.com/BetterMoneyLabs
- **x402 `batch-settlement` credit-backed bindings**, Cloudflare's for example. This is the only credit model inside a mainstream agent-payment protocol found today. [P] (§4.1)
- **Credit Commons Protocol:** mutual-credit accounting across nested ledgers (sum of balances is zero). White paper 2016 (Slater and Jenkin). Spec status not verified. [S] https://credit-commons.gitlab.io/credit-commons-documentation
- **Open Payments (Interledger):** GNAP (RFC 9635) grants that delegate authority from a resource owner to a client, including interactive `outgoing-payment` grants. [P] https://openpayments.dev/identity/grants/. Grant limit fields were not confirmed on the page read [U]. This is a conceptual cousin of owner mandates. [I]

### 5.4 Basis (BetterMoneyLabs): current status

[P] https://github.com/BetterMoneyLabs/basis-tracker (README last changed 2026-10-03; GitHub API metadata read 2026-11-07)

- **Activity:**
  - Latest commits: "close #20: exchange atomicity" (2026-11-05), "close #19: certified reserve deployment" (2026-11-03), "multiple token reserves" (2026-10-27).
  - **No tagged releases.** License CC0-1.0. 6 stars.
- **Components:** tracker server with an OpenAPI HTTP API, `basis_cli` (with a `--json` contract), the `basis-ui` TUI, **`basis-mcp`** (§1.9), and the `basis.es` contract.
- **Trust model, quoted from the README:**
  - "Redemption requires both reserve owner's signature AND tracker's signature on `key || totalDebt || timestamp`."
  - "Emergency redemption is available after 3 days (3*720 blocks) from tracker creation height if tracker becomes unavailable."
  - A censoring tracker can block a note: "every redemption path, the emergency one included, requires `trackerTree[key] == totalDebt`".
  - "Anti-censorship protection is listed under 'Future Extensions'… and is not implemented."
- **Mainnet or testnet status is not stated in the README.** [U]
- The README names agent use cases ("agentic economic networks", a Celaut agent-to-agent payment showcase). [P]
- Implication [I]: state the tracker-censorship limit plainly in the Valun spec, next to "units are synthetic; nothing settles yet".

---

## 6. Name availability (`valun`)

All queries ran 2026-11-07 at about 00:29 UTC. Every result is a raw HTTP response [P].

| Registry | Query | Result |
|---|---|---|
| PyPI | `https://pypi.org/pypi/valun/json` and `https://pypi.org/simple/valun/` | **404: no project named `valun`.** The HTML page https://pypi.org/project/valun/ could not be rendered by the fetch tool (a JavaScript-dependent error page), so the JSON and simple APIs were used instead. |
| PyPI | `valun-mcp` | 404, no project |
| npm | `https://registry.npmjs.org/valun` | **404 `{"error":"Not found"}`: no package named `valun`** |
| npm | `valun-mcp`, `@valun/mcp` | 404, no package |
| npm | scope / org `@valun` | **Could not verify.** `npmjs.com/org/valun` returned 403 to an automated request. [U] |
| MCP Registry | `GET /v0/servers?search=valun` | `{"servers":[],"metadata":{"count":0}}`: **no listed server matches** (the search parameter was confirmed working with `search=filesystem`) |
| GitHub | `https://api.github.com/users/valun` | **Taken** by an unrelated user account (id 2614270, created 2012-10-21, 5 public repos). So `io.github.valun/*` is not available in the MCP Registry. |

Caveats [I]:
- A 404 only means no project exists today.
- PyPI and npm both apply name rules (prohibited and confusable names) that were not tested, because registering would require an account.
- Claim the names (PyPI `valun`, npm `valun` or a scope) before the spec is announced, if the owner approves.

---

## 7. Prioritized recommendation: the integrations that most increase who can use Valun

Effort estimates are mine [I]. They assume the existing deal and mandate logic and the 12-tool hosted MCP surface are reused.

1. **Ship the local stdio MCP server as a PyPI package run with `uvx valun-mcp`** (an npm/`npx` wrapper is optional).
   - Build it on an official Tier-1 SDK that serves both 2025-11-25 and 2026-07-28 clients.
   - Explicit annotations (§1.2), `outputSchema` plus `structuredContent`, deal and offer IDs as handles.
   - Form-mode elicitation for accept-delivery, with fallback when unsupported.
   - Copy-paste config snippets for Claude Desktop, Claude Code, Cursor, VS Code, Codex, Gemini CLI, Hermes and the OpenAI Agents SDK.
   - *Reach:* every stdio-capable client in §1.7. *Effort:* 2-4 days.
2. **List it in the official MCP Registry and publish an MCPB bundle.**
   - `server.json` with `registryType: "pypi"`, plus `<!-- mcp-name: … -->` in the README.
   - The namespace is `io.github.<owner-account>/valun`, or a domain Valun controls, because GitHub `valun` is taken.
   - A `.mcpb` gives Claude Desktop users one-click install.
   - *Reach:* downstream marketplaces that pull from the registry, plus non-technical Claude Desktop users. *Effort:* 0.5-1 day after item 1. Needs owner approval for the GitHub login and publishing.
3. **Make the hosted `/mcp` spec-conformant for remote clients.**
   - OAuth 2.1 resource server with RFC 9728 metadata, CIMD-capable, audience-checked tokens, replacing the passphrase.
   - Optionally the OAuth Client Credentials extension for headless agents.
   - *Reach:* ChatGPT (remote only) and other connector-style hosts; Codex and Claude Code remote use. *Effort:* 1-2 weeks including a security review.
4. **Publish A2A v1.0 Agent Cards for directory participants**, plus a small Valun A2A extension (Basis pubkey, tracker, mandate digest) and an AI Catalog entry.
   - Defer a full A2A deal binding.
   - *Reach:* A2A-native agent platforms (the A2A blog of 2026-08-27 names Google Cloud, AWS Bedrock AgentCore and Azure AI Foundry, which the A2A project says support it natively), and discovery crawlers. *Effort:* 2-4 days for cards; a full binding is 2-4 weeks, later.
5. **Write the spec to fit the payment ecosystem without depending on it.**
   - Express owner mandates in AP2-compatible constraint vocabulary (§3.3), and keep `max_outstanding` as Valun's own credit concept.
   - Add an informative mapping of Basis notes onto x402 `batch-settlement` (credit-backed).
   - State the tracker-censorship and synthetic-unit limits.
   - *Reach:* makes later AP2/FIDO or x402 bridges a mapping exercise. *Effort:* 1-2 days of writing, no code.

Explicitly **not** recommended now [I]:
- ACP, UCP, Visa TAP and Mastercard Agent Pay: merchant checkout on card rails.
- MPP and L402: real-money rails; Valun does not settle.
- ERC-8004: Ethereum-bound.
- Building on MCP sampling or roots: deprecated in 2026-07-28.
