// valun: zero-dependency client for the Valun agent credit network (protocol valun-deal/1, network valun-testnet-1).
// Browser-safe entry: nothing here imports a Node built-in. Node only: the file store "@fitzdoud/valun/file-store" and the DNS
// host checker "@fitzdoud/valun/dns".

export {
  Client, MemoryStore, CORE_STATE_KEYS, RESERVED_MS_FROM, verifyNote, consentRoles, attemptKey, FEATURES_HEADER, CONSENT_ROLES,
  VALUE_SAFE_ROLES, VALUE_SAFE_HEADER_ROLES, CONSENT_LOG_MAX, RECORDS_KEEP_MS, SIGNATURES_KEEP_MS, ATTEMPT_OUTCOMES, UNRESOLVED_TRANSFER,
  LIVE_TRANSFER, LOCAL_CHOICES, NEVER_APPLIED_TRANSFER, RESOLVE_NOTE_MAX, PAYEE_EDGE_WHY, PAYEE_EDGE_NEXT, EDGES_PAGE, EDGES_MAX_PAGES,
  COUNTER_OFFER_HOURS, checkOfferHours, OWNER_HELD_KINDS, HELD_MATCH_MS, holdEnded, isoToMs,
} from './client.js';
export {ValunError, SignatureError} from './errors.js';
export {
  NETWORK, PROTOCOL, UNIT, amountText, CONSIDERATION, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_SERVER,
  canonical, termsHash, sha256Hex, statement, statements, cleanText, neutralize, reasonProblem, REASON_UNSAFE, hasUnsafeText,
  // the one network (fix inbox #15, #30): the network a profile is on, and a profile of the retired pilot network
  profileNetwork, retiredPilot, PILOT_RETIRED_ON,
} from './protocol.js';
export * as basis from './basis.js';
// A participant's own records of its credit edges (port of the Python records.py).
export * as records from './records.js';
// Circulating credit, client side: the signing firewall (port of the Python novation.py; PROTOCOL.md 15.3).
export * as novation from './novation.js';
// Settlement on Ergo testnet (the testnet network): addresses, context-extension order, checks; signing loads ergo-lib
// only when a settlement call needs it and it is installed (npm i ergo-lib-wasm-nodejs@0.28.0).
export * as ergo from './ergo.js';
// The AVL+ digest a Basis tracker anchors on Ergo, from its notes (port of the Python avl.py; fix inbox #62, #66): check a
// tracker box's R5 against the published ledger.
export * as avl from './avl.js';
export {blake2b, blake2b256, Blake2b} from './blake2b.js';
export {sha256} from './sha256.js';
export {bytesToHex, hexToBytes, utf8} from './bytes.js';

// The nine agent tools (port of the Python agent.py, schemas.py, measure.py and sandbox.py) and a framework adapter.
export {
  ValunAgent, errorPayload, limitsBody, loosens, recentlyActive, termsText, quoted, shown, quoteLine, owes, APPROVAL_TEXT,
  DEFAULT_SETUP_HINT, GENERIC_TEXT, HONEST_LABELS, LIMIT_FIELDS, LIMIT_TOOLS, NOT_COMMITMENT_TOOLS, NOT_SETTLED, QUOTE_MAX_CHARS,
  READ_ONLY_TOOLS, REAL_VS_SIMULATED, ROLE_WORDS, SETTLEMENT_NOTE, SIGNING_TOOLS, TOOL_NAMES, UNBOUND_MESSAGE,
  UNKNOWN_PARTICIPANT_TEXT,
  // circulating credit (0.4)
  CIRCULATION, CIRCULATION_SETTLEMENT, SETTLEMENT_NOTE_CIRCULATION, NOT_SETTLED_CIRCULATION, HONEST_LABELS_CIRCULATION,
  REAL_VS_SIMULATED_CIRCULATION, CONSENTS_EVERY_MS, INVITE_CONSENT_POLICY, SANDBOX_CONSENT_POLICY, CONSENT_POLICY_KEYS, PAYABLE,
  CONSENT_SPEED_WORDS, UNBOUND_PASS_THROUGH, SANDBOX_EXACT, SANDBOX_MALLORY, SANDBOX_AGENTS, TOUR_GOALS, TOUR_TEXTS, TOUR_AFTER, SANDBOX_RETRY_S, OWNER_RETRY_S,
  TOUR_DONE_KEY, TOUR_COMPLETED,
  CONSENTS_ON_READ_TOOLS, SIGNED_NOW_KEYS, labels, featuresOf, consentPolicyInForce, clientSigns, wantsConsents, consentsDue,
  // the testnet network (0.5): its labels, and texts in the network's unit
  TESTNET, SETTLEMENT_TESTNET, CIRCULATION_SETTLEMENT_TESTNET, HONEST_LABELS_TESTNET, HONEST_LABELS_CIRCULATION_TESTNET,
  REAL_VS_SIMULATED_TESTNET, REAL_VS_SIMULATED_CIRCULATION_TESTNET, tourGoal, trackerWords,
  // budget cards: valun_check_payer's summary sentence (0.7.2, fix inbox #87: the step's verdict from both sides)
  checkSummary, CHECK_LEAD, CHECK_FALLBACK, CHECK_PAYEE_SIDE, CHECK_ASK_LEAD, CHECK_ASK_FALLBACK, checkOwners, offersCountedAt,
  // fix inbox #58: the arguments every call of a tool is checked for, where it comes in (0.7.2: their types too)
  toolArguments, ARGUMENT_WORDS, ARGUMENT_WORDS_OF, REQUIRED_ARGUMENTS, argumentRefusal, PROPERTIES, ID_SHAPES, ENUM_REFUSALS, PAGE_WORDS,
  HOURS_MAX,
  // fix inbox #35: the unit-neutral names of every amount in a tool's answer
  withUnitNeutralNames,
  // fix inbox #30: a profile of the retired pilot network gets network_retired, with how to join again
  RETIRED_CODES, DEFAULT_REJOIN_HINT, retiredText,
  // 0.7.2: what an owner approves, verified (the approval semantics of 2026-11-17), and where
  NEVER_HELD, CONSOLE_APPROVALS, OWNER_WAITS, heldForOwner, ownerTurn, ownerDecisions, noteExpiresAt, isoMs, ownerWait,
  acceptanceWait,
  // 0.7.2, the RC's accuracy review: the times this client allows, a held IOU's hour, the other side's owner's decisions
  UNPAID, COUNTERPARTY_OWNER_KINDS, counterpartyOwnerDecisions, freeAfter, heldNoteHour, heldNoteOf, honorMarks,
  // 0.7.2, the RC's staging test: a held IOU's deadline is the owner console's, a minute before the tracker's; the words
  // beside this client's own times (the RC's review: Python had MARGIN_WORDS, this package did not export it)
  noteDecideBy, HELD_NOTE_SEND_MARGIN_MS, MARGIN_WORDS,
} from './agent.js';
export {valunTools, NO_APPROVAL_STEP, startConsentLoop, CONSENT_LOOP_MS, CONSENT_LOOP_JITTER_MS} from './tools.js';
export * as schemas from './schemas.js';
export * as measure from './measure.js';
export * as sandbox from './sandbox.js';
