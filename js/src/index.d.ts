// Types for the public API of "@fitzdoud/valun" (protocol valun-deal/1, network valun-pilot-1).
// Data objects use the protocol's snake_case field names, exactly as they travel on the wire.

// ---------------------------------------------------------------------------------------------------------------------
// Protocol data
// ---------------------------------------------------------------------------------------------------------------------
export interface Party {
  id: string;
  pubkey: string;
}

export interface Service {
  title: string;
  description: string;
  deliverable: string;
}

/** valun-deal/1 terms: exactly these 16 fields (spec 7.1). */
export interface Terms {
  protocol: 'valun-deal/1';
  network: 'valun-pilot-1';
  tracker_nft_id: string;
  denomination: string;
  deal_id: string;
  version: number;
  prior_terms_hash: string | null;
  nonce: string;
  proposer: string;
  payer: Party;
  payee: Party;
  service: Service;
  price: {amount: number; unit: 'PC'};
  consideration: 'credit_note_on_delivery_accepted';
  deliver_by: string;
  offer_expires_at: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

export interface Offer {
  version: number;
  by: string;
  state: string;
  terms: Terms;
  terms_hash: string;
  signature: string;
  offered_at?: string;
  created_at?: string;
}

export interface Agreement {
  version: number;
  terms_hash: string;
  formed_at: string;
  proposer_signature: string;
  acceptor_signature: string;
}

export interface Delivery {
  by: string;
  title: string;
  content: string;
  sha256: string;
  bytes: number;
  signature: string;
  at: string;
  late: boolean;
}

export type DealStatus =
  | 'proposed_awaiting_owner' | 'open' | 'accepted_awaiting_owner' | 'agreed' | 'delivered' | 'completion_awaiting_owner'
  | 'issuing_note' | 'note_issued' | 'note_failed' | 'disputed' | 'declined' | 'withdrawn' | 'expired' | 'rejected_by_owner'
  | 'cancelled';

/** The deal view (spec 14.4). Only the fields the client reads are typed precisely. */
export interface DealView {
  id: string;
  status: DealStatus | string;
  overdue?: boolean;
  you?: string;
  your_role?: 'payer' | 'payee';
  next_actions?: string[];
  current: Offer | null;
  pending_counter?: Offer | null;
  versions?: Array<{version: number; by: string; state: string; terms_hash: string; [k: string]: unknown}>;
  agreement?: Agreement | null;
  delivery?: Delivery | null;
  credit_note?: Record<string, unknown> | null;
  [field: string]: unknown;
}

/** GET /deals/{id}/credit-note-template (spec 9.2). */
export interface CreditNoteTemplate {
  deal_id: string;
  terms_hash: string;
  deliverable_sha256: string;
  issuer_pubkey: string;
  recipient_pubkey: string;
  keys_as_agreed: boolean;
  prior_total: number;
  price: number;
  total: number;
  timestamp: number;
  tracker_nft_id: string;
  denomination: string;
  message_hex: string;
  /** With ?prior=1 (a server offering bound_notes/1): the edge's current note, or null when the edge does not exist yet. */
  prior_note?: EdgeState | null;
}

/** A tracker edge's current note: its total, timestamp and the issuer's signature over them (spec v14, 4.4). */
export interface EdgeState {
  total: number;
  timestamp: number;
  signature: string;
}

/** Something this client signed for an edge whose outcome is not known yet (records.js). */
export interface PendingEntry {
  total: number;
  timestamp: number;
  /** 'note' (a credit note) or a novation kind ('transfer', 'setoff'). */
  kind: string;
  /** The deal, transfer or set-off id. */
  ref: string | null;
  /** 'out': this client is the edge's issuer; 'in': its creditor. */
  direction: 'out' | 'in';
  signed_at: string | null;
}

/** One edge's record: the state last confirmed applied on the tracker, and what is signed but not known yet. */
export interface EdgeRecord {
  confirmed: EdgeState | null;
  pending: PendingEntry[];
}

/** {"<issuer_pubkey>><recipient_pubkey>": EdgeRecord}: the same layout as the Python client's state['records']. */
export type Records = Record<string, EdgeRecord>;

export interface NetworkInfo {
  network: string;
  protocol: string;
  unit: string;
  denomination: string;
  tracker_nft_id: string;
  tracker_on_chain: boolean;
  [field: string]: unknown;
}

export interface VerifiedOffer {
  terms_hash: string;
  proposer_signature_valid: true;
  terms: Terms;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Every client refusal and every server error. `code` is the server's `error` for HTTP errors (e.g. "mandate_exceeded",
 * "stale_note", "signer_unavailable"), or one of the client's own codes: not_configured, not_connected,
 * already_connected, unreachable, bad_response, no_offer, hash_mismatch, wrong_network, wrong_tracker, not_a_party,
 * wrong_key, wrong_deal, wrong_proposer, bad_terms, bad_signature, expired, counterparty_inactive, stale_terms,
 * not_agreed, not_delivered, stale_delivery, bad_template, ledger_mismatch, bad_role, bad_price, bad_content, bad_id,
 * bad_enrollment, bad_key, invalid_field (a reason the server would refuse; extra.local = true), bad_store;
 * since 0.4: bad_delivery_signature (the payee did not sign the delivery), bad_prior_signature (the prior note shown is
 * not this agent's own signature), already_paid (a note of this agent for the deal is or may be on the tracker),
 * tracker_mismatch (the server names another tracker or unit than the profile's pins; extra.pinned),
 * records_unreadable (the profile or its records cannot be read: nothing is signed), profile_busy (another process held
 * the profile lock for 5 s), approval_unbound (an approval could not be bound to what would be signed; extra.cause).
 */
export class ValunError extends Error {
  constructor(code: string, message: string, status?: number, extra?: Record<string, unknown>);
  code: string;
  /** HTTP status for server errors; undefined for refusals made by the client itself. */
  status: number | undefined;
  /** The other fields of the server's error body (rule, source, mandate_version, template, canonical, ...). */
  extra: Record<string, unknown>;
}

export class SignatureError extends Error {
  constructor(message: string);
}

// ---------------------------------------------------------------------------------------------------------------------
// Stores and the client
// ---------------------------------------------------------------------------------------------------------------------
/** Non-secret state the client keeps (persisted by the store). */
export interface ClientState {
  server?: string;
  participant_id?: string;
  pubkey?: string;
  network?: string;
  enrolled_at?: string;
  /** Confirmed cumulative credit-note totals this agent issued, keyed "issuerPubkey>recipientPubkey" (the 0.3 record). */
  issued?: Record<string, number>;
  /** Per edge: the confirmed state and what is signed but not known yet (records.js). */
  records?: Records;
  /** The tracker and unit this profile is pinned to (set on its first /info read or completion; R13). */
  pins?: {tracker_nft_id: string; denomination: string};
  [field: string]: unknown;
}

/**
 * Where the client keeps its state and secrets. secret() and token() are synchronous; save() and saveCredentials() may
 * be async. The client never returns or logs what secret() and token() give it. A store with update(fn) (FileStore)
 * gets every change to the records through it: fn(state) applied to the state as stored now, saved as one step.
 */
export interface ValunStore {
  state: ClientState;
  /** The agent's 32-byte secret key as 64 hex, or null. */
  secret(): string | null;
  /** The agent token, or null. */
  token(): string | null;
  save(): void | Promise<void>;
  saveCredentials(secretHex: string, token: string): void | Promise<void>;
  /** Optional: reload the stored state, apply fn (synchronous) to it, save it, and update `state` in place. */
  update?<T>(fn: (state: ClientState) => T): T | Promise<T>;
  /** Optional: replace `state` (in place) with what is stored now. */
  reload?(): void | Promise<void>;
}

/** Keeps everything in memory; the key and token sit in private fields (not enumerable, not inspectable). */
export class MemoryStore implements ValunStore {
  constructor(init?: {state?: ClientState; secret?: string | null; token?: string | null});
  state: ClientState;
  secret(): string | null;
  token(): string | null;
  save(): void;
  saveCredentials(secretHex: string, token: string): void;
}

export interface ClientOptions {
  /** Default: a new MemoryStore. In Node, `new FileStore(path)` from "@fitzdoud/valun/file-store". */
  store?: ValunStore;
  /** Base URL of the server, e.g. "https://host" (the API is under /pilot/v1). Stored in state.server. */
  server?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** A fetch implementation (default globalThis.fetch). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Values the network must have (spec 15.2: a client SHOULD pin them). */
  pin?: {trackerNftId?: string; denomination?: string};
  /** Times to send the same signed request again after 503 signer_unavailable (default 0: throw, as the Python client). */
  signerRetries?: number;
  /** First back-off delay for signerRetries in ms (default 1000; doubles each time). */
  retryDelayMs?: number;
  /** Test hook: the clock in ms since the epoch. */
  now?: () => number;
  /** Test hook: the source of deal ids and nonces (never of signing nonces or keys). */
  randomBytes?: (n: number) => Uint8Array;
  /** Test hook: the key generator used by enroll(). */
  generateSecret?: () => Uint8Array;
}

export interface JoinRequest {
  invite: string;
  handle: string;
  operator: string;
  displayName?: string;
  about?: string;
  services?: string;
}

export interface JoinResponse {
  participant_id: string;
  handle: string;
  /** For the HUMAN owner: never give it to the agent. */
  owner_token: string;
  enrollment_code: string;
  enrollment_expires_at: string;
}

export interface BuildTermsRequest {
  counterpartyId: string;
  /** "payer": you pay with your credit; "payee": you do the work. */
  role: 'payer' | 'payee';
  title: string;
  description: string;
  deliverable: string;
  /** Whole PC, at least 1 (a number or a decimal string). */
  price: number | string;
  deliverByHours?: number;
  offerTtlHours?: number;
  dealId?: string;
  version?: number;
  prior?: string | null;
}

export type ProposeRequest = Omit<BuildTermsRequest, 'dealId' | 'version' | 'prior'>;

export interface CounterRequest {
  price?: number | string;
  title?: string;
  description?: string;
  deliverable?: string;
  deliverByHours?: number;
  offerTtlHours?: number;
  /** The hash of the offer that was inspected: anything else is refused (stale_terms) before signing. */
  expectedTermsHash?: string;
}

export interface CompleteOptions {
  /** The sha256 of the delivery that was reviewed: anything else is refused (stale_delivery). */
  expectedDeliverableSha256?: string;
  /** The hash of the agreed terms that were reviewed: anything else is refused (stale_terms) before the template is read. */
  expectedTermsHash?: string;
}

export class Client {
  constructor(options?: ClientOptions);
  /** Non-secret state (server, participant_id, pubkey, network, enrolled_at, issued). */
  readonly state: ClientState;
  /** True when the store holds both a signing key and an agent token. */
  readonly connected: boolean;
  /** This agent's public key (66 hex), or null before enrollment. */
  readonly pubkey: string | null;
  readonly participantId: string | null;

  /** One API call; parsed JSON body, or a ValunError for any HTTP error. */
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, options?: {auth?: boolean; token?: string}): Promise<T>;

  join(request: JoinRequest): Promise<JoinResponse>;
  /** Join without an invite as a sandbox-only participant, where the server offers it (otherwise rejects with not_found). */
  joinSandbox(request: Omit<JoinRequest, 'invite' | 'services'>): Promise<JoinResponse & {sandbox_only?: boolean; sandbox_expires_at?: string; note?: string}>;
  /** Generates the key locally and registers it; stores key and agent token; returns neither. */
  enroll(participantId: string, code: string): Promise<{participant_id: string; pubkey: string; network: string}>;

  /** GET /info. An enrolled profile is pinned to the tracker and unit it names the first time; another answer later is refused (tracker_mismatch). */
  info(): Promise<NetworkInfo>;
  me(): Promise<Record<string, unknown>>;
  inbox(): Promise<Record<string, unknown>>;
  deals(): Promise<DealView[]>;
  deal(dealId: string): Promise<DealView>;
  directory(): Promise<Array<Record<string, unknown>>>;
  participant(participantId: string): Promise<Record<string, unknown>>;
  ledger(): Promise<Record<string, unknown>>;
  setLimits(body: Record<string, number | string | null>): Promise<Record<string, unknown>>;

  /** The checks of spec 15.2 before accepting or countering; throws ValunError on any failure. */
  verifyOffer(deal: DealView): Promise<VerifiedOffer>;
  /** The agreed terms, after checking the hash and both signatures against the keys the terms name. */
  verifiedAgreement(deal: DealView): Terms;

  buildTerms(request: BuildTermsRequest): Promise<Terms>;
  propose(request: ProposeRequest): Promise<DealView>;
  counter(dealId: string, changes?: CounterRequest): Promise<DealView>;
  accept(dealId: string, options?: {expectedTermsHash?: string}): Promise<DealView>;
  /** A null or absent reason is sent as "". A reason the server would refuse is refused locally (invalid_field). */
  decline(dealId: string, reason?: string | null): Promise<DealView>;
  withdraw(dealId: string): Promise<DealView>;
  deliver(dealId: string, content: string, options?: {title?: string}): Promise<DealView>;
  /**
   * Accept the delivery and sign the Basis credit note (prior + price). Check `status` of the result. The payee's
   * delivery signature, the template and the prior (the agent's own prior note with bound_notes/1, else its own record)
   * are checked first; the note is recorded as pending before it is sent and confirmed only on note_issued.
   */
  complete(dealId: string, options?: CompleteOptions): Promise<DealView>;
  /** The reason is required; one the server would refuse is refused locally (invalid_field). */
  dispute(dealId: string, reason: string): Promise<DealView>;
  /** The payee signed the delivery under one of these keys (bad_delivery_signature otherwise). */
  static checkDeliverySignature(delivery: unknown, termsHash: string, ...payeeKeys: Array<string | null | undefined>): void;
}

/** The optional state keys every store must keep for the client (Python CORE_STATE_KEYS). */
export const CORE_STATE_KEYS: readonly string[];
/** Template timestamps whose ms residue (ts mod 1000) is at least this are kept by the v3 tracker for other operations. */
export const RESERVED_MS_FROM: 995;
/** Is `signature` the issuer's Basis note signature over (issuer, recipient, total, timestamp) on this tracker and unit? Never throws. */
export function verifyNote(issuerPubkey: string, recipientPubkey: string, total: number, timestamp: number, signature: string,
  trackerNftId: string, denomination: string): boolean;

/** A participant's own records of its credit edges (port of python/src/valun/records.py; pure). Malformed input throws a ValueError. */
export namespace records {
  const MAX_U64: number;
  function pairKey(issuerPubkey: string, recipientPubkey: string): string;
  /** A checked copy of an EdgeState. */
  function edgeState(state: unknown): EdgeState;
  /** One edge's record, without adding it. */
  function get(recs: Records | null | undefined, pair: string): EdgeRecord;
  function confirmedTotal(recs: Records | null | undefined, pair: string): number | null;
  function addPending(recs: Records, pair: string, total: number, timestamp: number, kind: string, ref?: string | null,
    direction?: 'out' | 'in', signedAt?: string | null): PendingEntry;
  function removePending(recs: Records, pair: string, total: number, timestamp: number, ref?: string | null): number;
  /** `state` applied on `pair`: confirmed, a matching pending entry promoted, entries at or before it dropped; never back in time. */
  function confirm(recs: Records, pair: string, state: EdgeState): EdgeRecord;
  /** One row of the edge's current state ({edge} or {issuer_pubkey, recipient_pubkey}, plus an EdgeState). */
  function syncEdge(recs: Records, edge: Record<string, unknown>): {pair: string; changed: boolean; promoted: PendingEntry | null;
    dropped: unknown[]; confirmed: EdgeState | null};
  type Verify = (issuerPubkey: string, recipientPubkey: string, total: number, timestamp: number, signature: string) => boolean;
  function priorProblem(recs: Records, pair: string, priorNote: unknown, myPubkey: string, verify: Verify): 'bad_prior_signature' | 'stale_prior' | null;
  function acceptPrior(recs: Records, pair: string, priorNote: unknown, myPubkey: string, verify: Verify): boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------------------------------------------------
export const NETWORK: 'valun-pilot-1';
export const PROTOCOL: 'valun-deal/1';
export const UNIT: 'PC';
export const CONSIDERATION: 'credit_note_on_delivery_accepted';
/** sha256hex("valun-pilot-credit/1"). */
export const PILOT_TOKEN_ID: string;
/** "token:" + PILOT_TOKEN_ID. */
export const PILOT_DENOMINATION: string;
/** The server the Python CLI uses by default. Never contacted unless passed as `server`. */
export const DEFAULT_SERVER: string;

/** The server's canonical JSON (spec 7.2). Throws ValunError('bad_terms') for values JSON cannot carry. */
export function canonical(value: unknown): string;
/** sha256hex(canonical(terms)). */
export function termsHash(terms: unknown): string;
/** Lowercase hex SHA-256 of a string's UTF-8 bytes, or of bytes. */
export function sha256Hex(input: string | Uint8Array): string;
/** "valun-pilot/<kind>/1" and the parts, joined by LF. */
export function statement(kind: string, ...parts: string[]): string;
/** The statement each act signs (spec 8.1); reasons, content and codes are hashed exactly as given. */
export const statements: {
  readonly enroll: (participantId: string, pubkey: string, enrollmentCode: string, network?: string) => string;
  readonly propose: (termsHash: string) => string;
  readonly accept: (termsHash: string) => string;
  readonly decline: (termsHash: string, reason: string) => string;
  readonly withdraw: (termsHash: string) => string;
  readonly deliver: (termsHash: string, content: string) => string;
  readonly complete: (termsHash: string, deliverableSha256: string) => string;
  readonly dispute: (termsHash: string, deliverableSha256: string, reason: string) => string;
};
/** The server's clean(): C0 controls except TAB/LF/CR and DEL to spaces, then trim(). */
export function cleanText(text: string): string;
/** Display-safe text: controls, format characters and lone surrogates as visible \u{XXXX} markers. Never sign it. */
export function neutralize(text: string): string;
/**
 * Cc, Cf and Default_Ignorable_Code_Point: the characters the release v13 text rule starts from. Stricter than the server
 * (TAB/LF/CR, single joiners and marks, emoji selectors, keycaps and the three flags are allowed there): test text with
 * hasUnsafeText().
 */
export const REASON_UNSAFE: RegExp;
/**
 * Does the server (release v13, spec 2.3) refuse this text (a reason, signed service text, a profile field)? The same
 * rule as the server's hasUnsafeText, code point by code point, with the engine's Unicode properties.
 */
export function hasUnsafeText(text: string): boolean;
/** The server's (release v13) refusal of a decline/dispute reason, in its order and wording, or null if it accepts it. */
export function reasonProblem(kind: 'decline' | 'dispute', reason: unknown): {error: 'invalid_field'; message: string} | null;

// ---------------------------------------------------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------------------------------------------------
type Bytes = Uint8Array;
type BytesOrHex = Uint8Array | string;
type U64 = number | bigint | string;

export namespace basis {
  const P: bigint;
  const N: bigint;
  const G: readonly [bigint, bigint];
  const HALF: bigint;
  /** BLAKE2b with digest length 32 over the concatenation of the parts. */
  function blake2b256(...parts: Bytes[]): Bytes;
  /** 32 random bytes, uniform in [1, n-1], from globalThis.crypto.getRandomValues (or the source given). */
  function generateSecret(randomBytes?: (n: number) => Bytes): Bytes;
  function publicKey(secret: BytesOrHex): Bytes;
  function validatePublicKey(pk: BytesOrHex): void;
  /** Basis Schnorr signature (65 bytes) over the exact message bytes. `options.randomBytes` is for tests only. */
  function sign(message: Bytes, secret: BytesOrHex, pk?: BytesOrHex | null, options?: {randomBytes?: (n: number) => Bytes}): Bytes;
  function verify(signature: BytesOrHex, message: Bytes, pk: BytesOrHex): boolean;
  /** verify() over lowercase hex signature and key; false for anything malformed. */
  function verifyHex(signatureHex: string, message: Bytes, pkHex: string): boolean;
  function debtKey(issuerPk: BytesOrHex, recipientPk: BytesOrHex, denomination?: string): Bytes;
  /** The 80-byte Basis note message. */
  function noteMessage(issuerPk: BytesOrHex, recipientPk: BytesOrHex, total: U64, timestamp: U64, trackerNftId: BytesOrHex, denomination?: string): Bytes;
  class SignatureError extends Error {}
}

export class Blake2b {
  constructor(outLen?: number, key?: Bytes);
  update(data: Bytes): this;
  digest(): Bytes;
}
export function blake2b(data: Bytes, outLen?: number, key?: Bytes): Bytes;
export function blake2b256(...parts: Bytes[]): Bytes;
export function sha256(data: Bytes): Bytes;
export function bytesToHex(bytes: Bytes): string;
export function hexToBytes(hex: string): Bytes;
export function utf8(text: string): Bytes;

// ---------------------------------------------------------------------------------------------------------------------
// Agent tools: the nine Valun tools of the Python reference (agent.py, schemas.py, measure.py, sandbox.py)
// ---------------------------------------------------------------------------------------------------------------------
export type ToolName =
  | 'valun_status' | 'valun_directory' | 'valun_inbox' | 'valun_deal' | 'valun_propose' | 'valun_respond' | 'valun_deliver'
  | 'valun_review_delivery' | 'valun_set_limits';

/** A JSON Schema (the subset the tools use: type, properties, required, enum, items, minimum, maximum, minLength, description). */
export type JsonSchema = {readonly [keyword: string]: JsonValue | JsonSchema | undefined};

/** What the model reads about a tool: its name, what it commits the agent to, and its arguments as a JSON Schema. */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: {readonly type: 'object'; readonly properties: {readonly [argument: string]: JsonSchema}; readonly required: readonly string[]};
}

/** Tool definitions equal to python/src/valun/schemas.py, frozen. */
export namespace schemas {
  const STATUS: ToolDefinition;
  const DIRECTORY: ToolDefinition;
  const INBOX: ToolDefinition;
  const DEAL: ToolDefinition;
  const PROPOSE: ToolDefinition;
  const RESPOND: ToolDefinition;
  const DELIVER: ToolDefinition;
  const REVIEW: ToolDefinition;
  const SET_LIMITS: ToolDefinition;
  /** The nine tools, in the order every adapter lists them. */
  const ALL: readonly ToolDefinition[];
}

/** Tool arguments as the model sends them (JSON). */
export type ToolArgs = {[argument: string]: JsonValue | undefined};
/** Every tool result is a plain JSON-compatible object; failures carry `error` (a stable code) and `message`. */
export type ToolResult = Record<string, unknown>;

/** A failure as a tool result. Never contains the signing key or the agent token. */
export interface ToolError {
  error: string;
  message: string;
  /**
   * For approval_unbound, tracker_mismatch, bad_delivery_signature, records_unreadable, already_paid, mandate_exceeded,
   * offer_not_authorized, key_changed/payee_no_key, unauthorized/not_connected/not_configured, owner_declined (or the
   * server's own, passed through).
   */
  what_this_means?: string;
  rule?: unknown;
  mandate_version?: unknown;
  /** draft_does_not_meet_terms: the measurements of the draft. */
  measured?: Measurement;
  /** Passed through from the server's error: when to try again, the template it refers to, when a fallback opens. */
  retry_after_ms?: unknown;
  template?: unknown;
  fallback_after?: unknown;
}

export type HostStatus = 'public' | 'private' | 'not_found' | 'unknown (lookup timed out)';
/** 'public' if any address of the host is globally reachable, 'private' if none is, 'not_found' if the name does not exist. */
export type ResolveHost = (host: string) => Promise<'public' | 'private' | 'not_found'> | 'public' | 'private' | 'not_found';

export interface RequirementCheck {
  requirement: string;
  measured: string;
  met: boolean;
}

/** Deterministic facts about a delivery (measure.measure in Python). */
export interface Measurement {
  word_count: number;
  links: string[];
  checks_against_agreed_terms: RequirementCheck[];
  how_measured: string;
  /** Host checks on, links present and a resolver given. */
  link_hosts?: Record<string, HostStatus>;
  /** Some link hosts do not exist in DNS. */
  warning?: string;
  /** JavaScript only: host checks on and links present, but no resolver (e.g. in a browser). */
  link_hosts_not_checked?: string;
}

export interface Requirements {
  min_words?: number;
  max_words?: number;
  min_links?: number;
}

/** Word, link and requirement measurements (python/src/valun/measure.py). No page is fetched; DNS only via resolveHost. */
export namespace measure {
  const MAX_LINKS_CHECKED: number;
  const HOW_MEASURED: string;
  const HOSTS_NOT_CHECKED: string;
  function wordCount(text: string | null | undefined): number;
  /** Distinct http(s) URLs, in order, without trailing punctuation or an unbalanced closing bracket. */
  function links(text: string | null | undefined): string[];
  function hostOf(url: string): string;
  /** Numeric requirements written in the agreed service text ("300-500 words", "at least 3 cited sources"). */
  function requirements(termsText: string | null | undefined): Requirements;
  /** Python's ipaddress.ip_address(address).is_global. Throws TypeError for a string that is no IP address. */
  function isGlobalAddress(address: string): boolean;
  function classifyAddresses(addresses: readonly string[]): 'public' | 'private';
  /** A ResolveHost from an address lookup (rejecting when the name does not exist). */
  function hostResolver(lookupAll: (host: string) => Promise<readonly string[]> | readonly string[]): (host: string) => Promise<'public' | 'private' | 'not_found'>;
  /** Looks up the distinct hosts of `urls` (at most MAX_LINKS_CHECKED) concurrently, at most timeoutMs (default 4000) in all. */
  function hostStatus(urls: readonly string[], resolveHost: ResolveHost, options?: {timeoutMs?: number}): Promise<Record<string, HostStatus>>;
  function measure(text: string | null | undefined, termsText: string | null | undefined,
    options?: {checkHosts?: boolean; resolveHost?: ResolveHost | null; timeoutMs?: number}): Promise<Measurement>;
}

export type SandboxService = 'text-stats' | 'notary';

export interface TextStats {
  words: number;
  characters: number;
  lines: number;
  unique_words: number;
  sha256: string;
  top_words: Array<[string, number]>;
}

export interface NotaryResult {
  sha256: string;
  bytes: number;
}

/** checked_exactly_by_your_client: the delivered result against the result recomputed from the agreed text. */
export interface ExactCheck {
  service: SandboxService;
  checked: boolean;
  why?: string;
  exact_result_matches?: boolean;
  differs_in?: string[];
  expected?: Record<string, unknown>;
  delivered?: Record<string, unknown>;
  how?: string;
}

/** The exactly checkable services of the sandbox agents (python/src/valun/sandbox.py, the service functions). */
export namespace sandbox {
  const SERVICES: {readonly [service in SandboxService]: {readonly price: number; readonly keywords: readonly string[]}};
  const SERVICES_TEXT: string;
  const HOW_TO_SEND: string;
  const COMPUTE: {readonly 'text-stats': (text: string) => TextStats; readonly notary: (text: string) => NotaryResult};
  /** The text to process: the first ``` fenced block, else everything after a final TEXT: label, else the only quoted string. */
  function extractText(description: string | null | undefined): string | null;
  function textStats(text: string): TextStats;
  function notary(text: string): NotaryResult;
  function render(service: SandboxService, result: TextStats | NotaryResult, text?: string | null): string;
  /** The parsed ```json block of a delivery, or null. Throws SyntaxError if the block is not JSON. */
  function parseResult(content: string | null | undefined): unknown;
  function whichService(terms: {[field: string]: unknown}): SandboxService | null;
  /** null when the terms name no exactly checkable service. */
  function checkDelivery(terms: {[field: string]: unknown}, content: string): ExactCheck | null;
}

export type LimitArgument =
  | 'max_per_deal_as_payer' | 'max_total_owed' | 'max_per_deal_as_payee' | 'max_claim_per_payer' | 'min_price_as_payee'
  | 'min_payer_coverage_pct';

export const SETTLEMENT_NOTE: string;
export const NOT_SETTLED: string;
export const HONEST_LABELS: Readonly<{what_basis_records: string; outstanding_promise: string; third_party: string}>;
export const REAL_VS_SIMULATED: Readonly<{real: string; simulated: string; not_proven: string}>;
/** valun_set_limits argument -> [server field, 'cap' | 'floor']. */
export const LIMIT_FIELDS: Readonly<Record<LimitArgument, readonly [string, 'cap' | 'floor']>>;
export const TOOL_NAMES: readonly ToolName[];
export const READ_ONLY_TOOLS: readonly ToolName[];
/** The classification (fail closed by name): these tools never commit the owner (the read-only tools and valun_deliver)... */
export const NOT_COMMITMENT_TOOLS: readonly ToolName[];
/** ...this one only when it loosens a recorded limit (valun_set_limits)... */
export const LIMIT_TOOLS: readonly ToolName[];
/** ...and these sign a commitment for some arguments. Any tool name not listed in the three is a commitment too. */
export const SIGNING_TOOLS: readonly ToolName[];
/** The approval_unbound message: 'could not read what you would sign; nothing was signed'. */
export const UNBOUND_MESSAGE: string;
/** The approval text for a tool this client does not know; '{name}' stands for the tool name. */
export const GENERIC_TEXT: string;
/** Text fields quoted in an approval text are cut to this many characters (code points). */
export const QUOTE_MAX_CHARS: number;
export const ROLE_WORDS: Readonly<{payer: string; payee: string}>;
export const DEFAULT_SETUP_HINT: string;
/** The Python adapters' sentences for where approvals happen (valun_status shows the one in use). */
export const APPROVAL_TEXT: Readonly<{ask: string; 'client-prompt': string; console: string; none: string}>;

/** A ValunError (or anything thrown) as a tool result. */
export function errorPayload(error: unknown, setupHint?: string): ToolError;
/** valun_set_limits arguments as the server's /limits body. */
export function limitsBody(args: ToolArgs): Record<string, number | string | null>;
/**
 * Would this /limits body loosen a limit recorded before (higher cap, lower floor, or removal)? Fails closed: an unknown
 * field, an unknown kind of limit or a value that is not a whole number counts as loosening.
 */
export function loosens(current: Record<string, unknown>, body: Record<string, unknown>): boolean;
/** Untrusted text as ONE line of JSON, as Python's json.dumps(value, ensure_ascii=True, separators=(',', ':')) writes it. */
export function quoted(value: unknown): string;
/** A value for a computed line of an approval text: as is when it cannot carry layout, otherwise quoted(). */
export function shown(value: unknown): string;
/** The last line of an approval text: `label` and `fields` quoted as one JSON line (long fields cut, and the label says so). */
export function quoteLine(label: string, fields: Record<string, unknown>): string;
/** What a binding deal means for this participant in `role` ('payer' or 'payee'). */
export function owes(role: string, who: string, price: number): string;
/** Seen (or joined) within the last `hours` (default 24)? Times without a UTC offset do not count. */
export function recentlyActive(lastSeen: unknown, hours?: number, joinedAt?: unknown, nowMs?: number): boolean;
/** The current terms' title, description and deliverable, joined by spaces. */
export function termsText(deal: unknown): string;

export interface ValunAgentOptions {
  /** One sentence telling the model where commitments are approved (see APPROVAL_TEXT). valunTools() fills it in if empty. */
  approvals?: string;
  /** Check link hosts when measuring deliveries (default true). Needs resolveHost; without one the result says so. */
  checkLinkHosts?: boolean;
  /** Node: resolveHost from "@fitzdoud/valun/dns". Browsers have none. */
  resolveHost?: ResolveHost | null;
  /** All host lookups of one measurement together (default 4000 ms). */
  hostTimeoutMs?: number;
  /** What the owner must do to connect the agent, in error explanations. */
  setupHint?: string | null;
  /** Test hook: the clock in ms (who counts as recently active). */
  now?: () => number;
}

/** The nine Valun tools over one participant's Client, with the Python reference's behaviour, wording and checks. */
export class ValunAgent {
  constructor(client: Client, options?: ValunAgentOptions);
  approvals: string;
  checkLinkHosts: boolean;
  resolveHost: ResolveHost | null;
  hostTimeoutMs: number;
  setupHint: string;
  readonly handlers: Readonly<Record<ToolName, (args: ToolArgs) => Promise<ToolResult>>>;
  /** The Client, after checking it is enrolled (ValunError not_connected otherwise). */
  client(requireConnection?: boolean): Client;
  /** Runs one tool; rejects with a ValunError (or another error) on failure. */
  call(name: ToolName | string, args?: ToolArgs | null): Promise<ToolResult>;
  /** Like call(), but never rejects: failures resolve to a ToolError. */
  callSafe(name: ToolName | string, args?: ToolArgs | null): Promise<ToolResult>;
  /**
   * Would this call sign a commitment or loosen a limit? Fails closed by name and by value: only the read-only tools,
   * valun_deliver, valun_respond with action exactly 'decline' or 'withdraw', valun_review_delivery with decision
   * exactly 'dispute' and valun_set_limits calls that loosen nothing are not; every other call, any tool name this
   * client does not know included, is.
   */
  isCommitment(name: ToolName | string, args?: ToolArgs | null): Promise<boolean>;
  /**
   * Bind and describe a commitment from ONE read of what it would sign: the arguments to sign with (pinned to the
   * recomputed hashes, an offer to the participant id shown) and the owner's approval text, built only from values
   * checked against what is signed. text is null when the call commits nothing (run it without asking). Rejects with
   * ValunError('approval_unbound') (extra.cause says why) when that cannot be read or checked: then refuse the call.
   */
  prepare(name: ToolName | string, args?: ToolArgs | null): Promise<{args: ToolArgs; text: string | null}>;
  /** For adapters: [prepared, null], or [null, refusal] where refusal is the approval_unbound tool result. Never rejects. */
  prepareOrRefusal(name: ToolName | string, args?: ToolArgs | null): Promise<[{args: ToolArgs; text: string | null}, null] | [null, ToolError]>;
  /**
   * prepare()'s pins alone (kept for compatibility): an acceptance or counter-offer pinned to the recomputed terms
   * hash, a delivery acceptance also to the recomputed deliverable hash, unless the agent passed them. Rejects with
   * approval_unbound for a commitment it cannot read and check (it never returns such arguments unpinned).
   */
  bind(name: ToolName | string, args?: ToolArgs | null): Promise<ToolArgs>;
  /** prepare()'s text: null for a call that commits nothing; rejects with approval_unbound, never a generic text for a known tool. */
  describeCommitment(name: ToolName | string, args?: ToolArgs | null): Promise<string | null>;
  status(args?: ToolArgs): Promise<ToolResult>;
  directory(args: ToolArgs): Promise<ToolResult>;
  inbox(args?: ToolArgs): Promise<ToolResult>;
  deal(args: ToolArgs): Promise<ToolResult>;
  propose(args: ToolArgs): Promise<ToolResult>;
  respond(args: ToolArgs): Promise<ToolResult>;
  deliver(args: ToolArgs): Promise<ToolResult>;
  review(args: ToolArgs): Promise<ToolResult>;
  setLimits(args: ToolArgs): Promise<ToolResult>;
}

/** A tool in the shape most JavaScript agent frameworks take: JSON Schema parameters and an execute function. */
export interface FrameworkTool {
  name: ToolName;
  description: string;
  /** A fresh copy for each tool list: a framework may change it. */
  parameters: {type: 'object'; properties: {[argument: string]: JsonSchema}; required: string[]};
  /** Arguments as an object or a JSON string. Always resolves (a ToolError on failure). */
  execute(args?: ToolArgs | string | null): Promise<ToolResult>;
}

/**
 * Asked before every commitment, with the text ValunAgent.prepare() built; only `true` approves. `args` is a frozen copy
 * of the prepared arguments that will be executed. Not called when prepare() refuses (approval_unbound).
 */
export type ApproveHook = (commitmentText: string, name: ToolName, args: Readonly<ToolArgs>) => boolean | Promise<boolean>;

export interface ValunToolsOptions {
  approve?: ApproveHook | null;
  /** 'none': sign commitments without asking anyone. Without a hook and without 'none', commitments are refused. */
  approvals?: 'ask' | 'none' | null;
}

/** What the model is told about approvals when no approve hook is given. */
export const NO_APPROVAL_STEP: string;

/**
 * The nine tools of `agent` as FrameworkTool objects. Commitments ask `approve` first with the prepared text and
 * arguments (owner_declined unless it returns true; approval_unavailable if it throws; approval_unbound, without asking,
 * when what would be signed cannot be read); without a hook they are refused (approval_unavailable) unless approvals is
 * 'none'.
 */
export function valunTools(agent: ValunAgent, options?: ValunToolsOptions): FrameworkTool[];
