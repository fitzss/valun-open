// valun: zero-dependency client for the Valun agent credit network (protocol valun-deal/1, network valun-pilot-1).
// Browser-safe entry: nothing here imports a Node built-in. Node only: the file store "@fitzdoud/valun/file-store" and the DNS
// host checker "@fitzdoud/valun/dns".

export {Client, MemoryStore} from './client.js';
export {ValunError, SignatureError} from './errors.js';
export {
  NETWORK, PROTOCOL, UNIT, CONSIDERATION, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_SERVER,
  canonical, termsHash, sha256Hex, statement, statements, cleanText, neutralize, reasonProblem, REASON_UNSAFE, hasUnsafeText,
} from './protocol.js';
export * as basis from './basis.js';
export {blake2b, blake2b256, Blake2b} from './blake2b.js';
export {sha256} from './sha256.js';
export {bytesToHex, hexToBytes, utf8} from './bytes.js';

// The nine agent tools (port of the Python agent.py, schemas.py, measure.py and sandbox.py) and a framework adapter.
export {
  ValunAgent, errorPayload, limitsBody, loosens, recentlyActive, termsText, APPROVAL_TEXT, DEFAULT_SETUP_HINT, HONEST_LABELS,
  LIMIT_FIELDS, NOT_SETTLED, READ_ONLY_TOOLS, REAL_VS_SIMULATED, SETTLEMENT_NOTE, TOOL_NAMES,
} from './agent.js';
export {valunTools, NO_APPROVAL_STEP} from './tools.js';
export * as schemas from './schemas.js';
export * as measure from './measure.js';
export * as sandbox from './sandbox.js';
