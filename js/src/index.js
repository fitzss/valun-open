// valun: zero-dependency client for the Valun agent credit network (protocol valun-deal/1, network valun-pilot-1).
// Browser-safe entry: nothing here imports a Node built-in. Node only: the file store "@fitzdoud/valun/file-store" and the DNS
// host checker "@fitzdoud/valun/dns".

export {
  Client, MemoryStore, CORE_STATE_KEYS, RESERVED_MS_FROM, verifyNote, consentRoles, attemptKey, FEATURES_HEADER, CONSENT_ROLES,
  VALUE_SAFE_ROLES, VALUE_SAFE_HEADER_ROLES, CONSENT_LOG_MAX, RECORDS_KEEP_MS, SIGNATURES_KEEP_MS, ATTEMPT_OUTCOMES, UNRESOLVED_TRANSFER,
  LIVE_TRANSFER, LOCAL_CHOICES, NEVER_APPLIED_TRANSFER, RESOLVE_NOTE_MAX, PAYEE_EDGE_WHY, PAYEE_EDGE_NEXT, EDGES_PAGE, EDGES_MAX_PAGES,
} from './client.js';
export {ValunError, SignatureError} from './errors.js';
export {
  NETWORK, PROTOCOL, UNIT, CONSIDERATION, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_SERVER,
  canonical, termsHash, sha256Hex, statement, statements, cleanText, neutralize, reasonProblem, REASON_UNSAFE, hasUnsafeText,
} from './protocol.js';
export * as basis from './basis.js';
// A participant's own records of its credit edges (port of the Python records.py).
export * as records from './records.js';
// Circulating credit, client side: the signing firewall (port of the Python novation.py; PROTOCOL.md 15.3).
export * as novation from './novation.js';
// Settlement on Ergo testnet (the testnet network): addresses, context-extension order, checks; signing loads ergo-lib
// only when a settlement call needs it and it is installed (npm i ergo-lib-wasm-nodejs@0.28.0).
export * as ergo from './ergo.js';
export {blake2b, blake2b256, Blake2b} from './blake2b.js';
export {sha256} from './sha256.js';
export {bytesToHex, hexToBytes, utf8} from './bytes.js';

// The nine agent tools (port of the Python agent.py, schemas.py, measure.py and sandbox.py) and a framework adapter.
export {
  ValunAgent, errorPayload, limitsBody, loosens, recentlyActive, termsText, quoted, shown, quoteLine, owes, APPROVAL_TEXT,
  DEFAULT_SETUP_HINT, GENERIC_TEXT, HONEST_LABELS, LIMIT_FIELDS, LIMIT_TOOLS, NOT_COMMITMENT_TOOLS, NOT_SETTLED, QUOTE_MAX_CHARS,
  READ_ONLY_TOOLS, REAL_VS_SIMULATED, ROLE_WORDS, SETTLEMENT_NOTE, SIGNING_TOOLS, TOOL_NAMES, UNBOUND_MESSAGE,
  // circulating credit (0.4)
  CIRCULATION, CIRCULATION_SETTLEMENT, SETTLEMENT_NOTE_CIRCULATION, NOT_SETTLED_CIRCULATION, HONEST_LABELS_CIRCULATION,
  REAL_VS_SIMULATED_CIRCULATION, CONSENTS_EVERY_MS, INVITE_CONSENT_POLICY, SANDBOX_CONSENT_POLICY, CONSENT_POLICY_KEYS, PAYABLE,
  CONSENT_SPEED_WORDS, UNBOUND_PASS_THROUGH, SANDBOX_EXACT, SANDBOX_MALLORY, SANDBOX_AGENTS, TOUR_GOALS, TOUR_TEXTS, TOUR_AFTER,
  CONSENTS_ON_READ_TOOLS, SIGNED_NOW_KEYS, labels, featuresOf, consentPolicyInForce, clientSigns, wantsConsents, consentsDue,
} from './agent.js';
export {valunTools, NO_APPROVAL_STEP, startConsentLoop, CONSENT_LOOP_MS, CONSENT_LOOP_JITTER_MS} from './tools.js';
export * as schemas from './schemas.js';
export * as measure from './measure.js';
export * as sandbox from './sandbox.js';
