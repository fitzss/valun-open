// Valun pilot client: the participant side. Holds the participant's signing key locally and talks to a Valun server.
//
// A port of the Python reference client (python/src/valun/client.py). Trust model: the server is not trusted to tell
// this client what to sign. Before signing, the client recomputes the terms hash itself, checks the counterparty's
// signature against the key in the public directory, and checks credit-note templates against the agreed price and its
// own records of the edges it is party to (records.js). The key and the agent token live in a store and are never
// returned by any method, logged, or put into an error.
//
// Records (as in the Python client): a credit note is recorded as pending before it is sent, and confirmed only when
// the server answers note_issued (or a later read shows it applied); a held note an owner rejects is simply dropped
// (OQ-23). Every change to the records goes through store.update(fn) when the store has it (FileStore: under the
// profile lock shared with the Python client), and one Client makes its changes one after another (a promise chain),
// so concurrent calls never lose each other's records.

import {sign, verifyHex, noteMessage, publicKey, generateSecret as defaultGenerateSecret} from './basis.js';
import {bytesToHex, hexToBytes, utf8} from './bytes.js';
import {SignatureError, ValunError} from './errors.js';
import {CONSIDERATION, NETWORK, PROTOCOL, UNIT, reasonProblem, sha256Hex, statement, statements, termsHash} from './protocol.js';
import {get as pyGet, isDict, or, pyEq, str, truthy, cpSlice} from './py.js';
import {randomBytes as defaultRandomBytes} from './random.js';
import * as records from './records.js';

const HOUR = 3600_000;
const NOTE_CLOCK_TOLERANCE_MS = 10 * 60_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Optional state keys a store keeps for this client (every store must keep them; all may be absent), as in the Python
 * client: issued {pair: confirmed total} of this client's outgoing edges (the 0.3 record, kept equal to the records'
 * confirmed total); records (records.js); pins {tracker_nft_id, denomination} (R13); the others belong to circulation.
 */
export const CORE_STATE_KEYS = Object.freeze(['issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments',
  'consent_policy', 'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq']);
/** Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them. */
export const RESERVED_MS_FROM = 995;

/** state.records (created when absent, unless create is false: then {}); a value that is not a record refuses everything (R9). */
function recordsIn(state, create = true) {
  const r = state.records;
  if (r === null || r === undefined) {
    if (!create) return {};
    state.records = {};
    return state.records;
  }
  if (!isDict(r)) throw new ValunError('records_unreadable', "this profile's records cannot be read; nothing was signed");
  return r;
}

function issuedIn(state, create = true) {
  const r = state.issued;
  if (r === null || r === undefined) {
    if (!create) return {};
    state.issued = {};
    return state.issued;
  }
  if (!isDict(r)) throw new ValunError('records_unreadable', "this profile's record of issued credit notes cannot be read; nothing was signed");
  return r;
}

function pinsOf(state) {
  const p = state.pins;
  return isDict(p) && truthy(p.tracker_nft_id) ? p : null;
}

function pinProblem(pins, trackerNftId, denomination) {
  if (pins && (pins.tracker_nft_id !== trackerNftId || pins.denomination !== denomination)) {
    return new ValunError('tracker_mismatch',
      `this Valun server names tracker ${cpSlice(str(trackerNftId), 16)}... and unit ${cpSlice(str(denomination), 22)}..., but this `
      + `profile is pinned to tracker ${cpSlice(str(pyGet(pins, 'tracker_nft_id')), 16)}... and unit ${cpSlice(str(pyGet(pins, 'denomination')), 22)}...; `
      + 'nothing was signed. Ask your owner.', undefined, {pinned: {...pins}});
  }
  return null;
}

/** Node's errors from the file system and other system calls (Python's OSError). */
function isSystemError(e) {
  return e instanceof Error && (typeof e.errno === 'number' || typeof e.syscall === 'string');
}

function isValunError(e) {
  return e instanceof ValunError || (e instanceof Error && e.name === 'ValunError' && typeof e.code === 'string');
}

/**
 * Is `signature` the issuer's Basis signature over the note (issuer, recipient, total, timestamp) on this tracker and
 * unit? Hex strings and whole numbers in; false for anything malformed (never throws).
 */
export function verifyNote(issuerPubkey, recipientPubkey, total, timestamp, signature, trackerNftId, denomination) {
  try {
    if (![issuerPubkey, recipientPubkey, signature, trackerNftId].every(x => typeof x === 'string')) return false;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(timestamp)) return false;
    const msg = noteMessage(issuerPubkey, recipientPubkey, total, timestamp, trackerNftId, denomination);
    return verifyHex(signature, msg, issuerPubkey);
  } catch {
    return false;
  }
}

const noteVerifier = (trackerNftId, denomination) =>
  (issuer, recipient, total, ts, sig) => verifyNote(issuer, recipient, total, ts, sig, trackerNftId, denomination);

/** Whole-second UTC time as the Python client writes it: YYYY-MM-DDTHH:MM:SS.000Z. */
function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const TERMS_FIELDS = ['protocol', 'network', 'tracker_nft_id', 'denomination', 'deal_id', 'version', 'prior_terms_hash',
  'nonce', 'proposer', 'payer', 'payee', 'service', 'price', 'consideration', 'deliver_by', 'offer_expires_at'];

function exactKeys(o, keys) {
  return isObject(o) && Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
}

function isRfc3339(s) {
  return typeof s === 'string' && RFC3339.test(s) && !Number.isNaN(Date.parse(s));
}

function seg(id) {
  if (typeof id !== 'string' || id === '') throw new ValunError('bad_id', 'ids must be non-empty strings');
  return encodeURIComponent(id);
}

function toPrice(price) {
  const n = typeof price === 'string' && /^[0-9]+$/.test(price) ? Number(price) : price;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) return n;
  throw new ValunError('bad_price', 'price must be a whole number of PC, at least 1');
}

function toHours(h, what) {
  if (typeof h !== 'number' || !Number.isFinite(h)) throw new ValunError('bad_terms', `${what} must be a number of hours`);
  return h;
}

/** Structural guard: the fields every check below reads, with the types it relies on. */
function checkTermsShape(t) {
  const party = p => isObject(p) && typeof p.id === 'string' && typeof p.pubkey === 'string';
  if (!isObject(t) || !party(t.payer) || !party(t.payee) || !isObject(t.service) || !isObject(t.price)
      || typeof t.tracker_nft_id !== 'string' || typeof t.denomination !== 'string') {
    throw new ValunError('bad_terms', 'the terms are not shaped as valun-deal/1 terms; refusing to sign');
  }
}

/** A reason the server would refuse is not sent (statements.json tier "refused": a client must not send them). */
function refuseReason(kind, reason) {
  const p = reasonProblem(kind, reason);
  if (p) throw new ValunError(p.error, p.message, undefined, {field: 'reason', local: true});
}

function timeoutSignal(ms) {
  if (typeof AbortController !== 'function' || !(ms > 0)) return {signal: undefined, cancel() {}};
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return {signal: c.signal, cancel: () => clearTimeout(t)};
}

/**
 * In-memory store: settings and the agent's record of notes issued in `state` (plain, non-secret), the signing key
 * and agent token in private fields that no enumeration, JSON.stringify or util.inspect can reach.
 */
export class MemoryStore {
  #secret;
  #token;

  constructor({state = {}, secret = null, token = null} = {}) {
    this.state = state;
    this.#secret = secret;
    this.#token = token;
  }

  secret() { return this.#secret; }
  token() { return this.#token; }
  saveCredentials(secretHex, token) { this.#secret = secretHex; this.#token = token; }
  save() {}
}

export class Client {
  #store;
  #fetch;
  #timeoutMs;
  #now;
  #randomBytes;
  #generateSecret;
  #pin;
  #signerRetries;
  #retryDelayMs;
  #server;
  #chain = Promise.resolve();

  /**
   * @param {object} options
   *   store          an object with .state (non-secret, plain object), .secret(), .token(), .save() and
   *                  .saveCredentials(secretHex, token) (save/saveCredentials may return a Promise). Default: MemoryStore.
   *   server         base URL of the Valun server, e.g. "https://host" (the API is under /pilot/v1). Kept in state.
   *   timeoutMs      per request (default 30000).
   *   fetch          a fetch implementation (default globalThis.fetch).
   *   pin            {trackerNftId, denomination}: values the network must have (spec 15.2: SHOULD pin).
   *   signerRetries  how many times to send the same signed request again after 503 signer_unavailable (default 0:
   *                  the error is thrown, as the Python client does); retryDelayMs (default 1000) doubles each time.
   *   now, randomBytes, generateSecret   clock (ms), id/nonce source and key generator: test hooks only.
   */
  constructor(options = {}) {
    const {store = new MemoryStore(), server, timeoutMs = 30_000, fetch, pin = {}, signerRetries = 0, retryDelayMs = 1000,
      now, randomBytes, generateSecret} = options;
    if (!Number.isInteger(signerRetries) || signerRetries < 0) throw new TypeError('signerRetries must be a whole number');
    this.#signerRetries = signerRetries;
    this.#retryDelayMs = retryDelayMs;
    for (const m of ['secret', 'token', 'save', 'saveCredentials']) {
      if (typeof store?.[m] !== 'function') throw new TypeError(`store must have a ${m}() method`);
    }
    if (!isObject(store.state)) throw new TypeError('store.state must be a plain object');
    this.#store = store;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#pin = {trackerNftId: pin.trackerNftId ?? null, denomination: pin.denomination ?? null};
    this.#now = now || (() => Date.now());
    this.#randomBytes = randomBytes || defaultRandomBytes;
    this.#generateSecret = generateSecret || (() => defaultGenerateSecret());
    // Kept apart (as in Python): a profile reloaded from disk never redirects this client's requests.
    this.#server = server ? String(server).replace(/\/+$/, '') : null;
    if (this.#server) this.state.server = this.#server;
  }

  /**
   * Non-secret state: server, participant_id, pubkey, network, enrolled_at, issued (confirmed totals of notes issued,
   * per key pair), records (confirmed and pending, per key pair: records.js), pins {tracker_nft_id, denomination}.
   */
  get state() { return this.#store.state; }

  /** True when the store holds both a signing key and an agent token. */
  get connected() { return Boolean(this.#store.token() && this.#store.secret()); }

  /** This agent's public key (66 hex), or null before enrollment. */
  get pubkey() {
    if (!this.state.pubkey && this.#store.secret()) this.state.pubkey = bytesToHex(publicKey(hexToBytes(this.#store.secret())));
    return this.state.pubkey ?? null;
  }

  get participantId() { return this.state.participant_id ?? null; }

  #secretBytes() {
    const s = this.#store.secret();
    if (!s) throw new ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it');
    return hexToBytes(s);
  }

  #signBytes(message) {
    const secret = this.#secretBytes();
    try {
      return bytesToHex(sign(message, secret, hexToBytes(this.pubkey)));
    } catch (e) {
      if (e instanceof SignatureError) throw new ValunError('bad_key', `the stored signing key is unusable: ${e.message}`);
      throw e;
    } finally {
      secret.fill(0);
    }
  }

  #sign(text) {
    return this.#signBytes(utf8(text));
  }

  async #save() {
    await this.#store.save();
  }

  // ---------- state changes: one after another, through store.update() where the store has it ----------
  /** Run `task` after every change this client started before it (whatever their outcome). */
  #serial(task) {
    const run = this.#chain.then(() => task());
    this.#chain = run.then(() => undefined, () => undefined);    // the chain itself never rejects
    return run;
  }

  /**
   * Change this client's records: fn(state) on the store's state, then save. With a store that has update()
   * (FileStore), under the profile lock and on the state reloaded from disk, so concurrent processes (Python ones too)
   * never lose each other's records; other stores apply fn to a copy of their state, which then replaces it, and save().
   * If fn throws, nothing changes. fn is synchronous. Resolves to fn's result.
   */
  #update(fn) {
    return this.#serial(async () => {
      const store = this.#store;
      let result;
      if (typeof store.update === 'function') {
        result = await store.update(fn);
      } else {
        const work = structuredClone(this.state);
        result = fn(work);
        for (const k of Object.keys(this.state)) delete this.state[k];
        Object.assign(this.state, work);
        await store.save();
      }
      if (this.#server) this.state.server = this.#server;
      return result;
    });
  }

  /** Read the records again where the store can (another process may have recorded notes since this one loaded). */
  async #reload() {
    if (typeof this.#store.reload !== 'function') return;
    await this.#serial(async () => {
      await this.#store.reload();
      if (this.#server) this.state.server = this.#server;
    });
  }

  /**
   * Record an outcome after the server answered. The attempt was written ahead, so if this fails (the profile is busy
   * or unreadable, or the disk refuses the write) the entry simply stays pending and is settled later; the server's
   * answer is what counts.
   */
  async #settle(fn) {
    try {
      await this.#update(fn);
    } catch (e) {
      if (!isValunError(e) && !isSystemError(e)) throw e;
    }
  }

  // ---------- HTTP ----------
  /** One API call. Returns the parsed JSON body; throws ValunError(code = the server's `error`) for HTTP errors. */
  async request(method, path, body = undefined, {auth = true, token = undefined} = {}) {
    const server = this.#server || this.state.server;
    if (!server) throw new ValunError('not_configured', 'no Valun server configured');
    const f = this.#fetch || globalThis.fetch;
    if (typeof f !== 'function') throw new ValunError('not_configured', 'no fetch implementation: pass options.fetch');
    const headers = {Accept: 'application/json'};
    let payload;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const tok = token || (auth ? this.#store.token() : null);
    if (tok) headers.Authorization = 'Bearer ' + tok;
    for (let attempt = 0; ; attempt++) {
      const {signal, cancel} = timeoutSignal(this.#timeoutMs);
      let res, text;
      try {
        // redirect: 'error' so the bearer token is never forwarded to wherever a redirect points.
        res = await f.call(globalThis, server + path, {method, headers, body: payload, signal, redirect: 'error'});
        text = await res.text();
      } catch (e) {
        const why = e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timed out' : (e?.message || String(e));
        throw new ValunError('unreachable', `cannot reach ${server}: ${why}`);
      } finally {
        cancel();
      }
      if (res.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new ValunError('bad_response', `the server sent a response that is not JSON (HTTP ${res.status})`, res.status);
        }
      }
      let j = {};
      try {
        const parsed = JSON.parse(text);
        if (isObject(parsed)) j = parsed;
      } catch { /* not JSON */ }
      const {error, message, ...extra} = j;
      const code = typeof error === 'string' && error ? error : 'http_error';
      // spec 15.2: on 503 signer_unavailable nothing was recorded; send the same signed request again, with back-off
      if (res.status === 503 && code === 'signer_unavailable' && attempt < this.#signerRetries) {
        await new Promise(resolve => setTimeout(resolve, this.#retryDelayMs * 2 ** attempt));
        continue;
      }
      const msg = (typeof message === 'string' && message) || (typeof error === 'string' && error) || `HTTP ${res.status}`;
      throw new ValunError(code, msg, res.status, extra);
    }
  }

  // ---------- joining ----------
  /**
   * Create a participant (owner side). The response holds the owner token and the enrollment code: both are for the
   * HUMAN operator, not for the agent.
   */
  async join({invite, handle, operator, displayName = '', about = '', services = ''}) {
    return this.request('POST', '/pilot/v1/join',
      {invite, handle, display_name: displayName, operator, about, services}, {auth: false});
  }

  /** Join without an invite as a sandbox-only participant (deals only with the sandbox agents, small limits, 7 days),
   *  where the server offers it (server release v14+, PILOT_OPEN_SANDBOX=1); otherwise ValunError('not_found'). */
  async joinSandbox({handle, operator, displayName = '', about = ''}) {
    return this.request('POST', '/pilot/v1/join-sandbox', {handle, display_name: displayName, operator, about}, {auth: false});
  }

  /** Generate this agent's key locally and register its public key with a proof-of-possession signature. */
  async enroll(participantId, code) {
    if (this.connected) throw new ValunError('already_connected', 'this client already holds an enrolled key');
    if (typeof participantId !== 'string' || typeof code !== 'string') {
      throw new ValunError('bad_enrollment', 'participant id and enrollment code must be strings');
    }
    const secret = this.#generateSecret();
    try {
      const pk = bytesToHex(publicKey(secret));
      const sig = bytesToHex(sign(utf8(statements.enroll(participantId, pk, code)), secret, hexToBytes(pk)));
      const r = await this.request('POST', '/pilot/v1/enroll',
        {participant_id: participantId, code, pubkey: pk, signature: sig}, {auth: false});
      if (!isObject(r) || typeof r.agent_token !== 'string' || !r.agent_token) {
        throw new ValunError('bad_response', 'the enroll response carries no agent token');
      }
      const secretHex = bytesToHex(secret);
      await this.#serial(async () => {
        Object.assign(this.state, {participant_id: participantId, pubkey: pk, network: r.network,
          enrolled_at: isoSeconds(this.#now()), issued: this.state.issued || {}});
        await this.#store.saveCredentials(secretHex, r.agent_token);
        await this.#save();
      });
      return {participant_id: participantId, pubkey: pk, network: r.network};
    } finally {
      secret.fill(0);
    }
  }

  // ---------- reads ----------
  /**
   * The network's public description. Its tracker and unit are pinned in an enrolled profile the first time they are
   * read (on the first call after enrolling or after an upgrade); a later answer naming others is refused
   * (tracker_mismatch, R13).
   */
  async info() {
    const r = await this.request('GET', '/pilot/v1/info', undefined, {auth: false});
    await this.#pinFrom(r);
    return r;
  }

  me() { return this.request('GET', '/pilot/v1/me'); }
  inbox() { return this.request('GET', '/pilot/v1/inbox'); }
  deals() { return this.request('GET', '/pilot/v1/deals'); }
  deal(dealId) { return this.request('GET', `/pilot/v1/deals/${seg(dealId)}`); }
  directory() { return this.request('GET', '/pilot/v1/participants', undefined, {auth: false}); }
  participant(pid) { return this.request('GET', `/pilot/v1/participants/${seg(pid)}`, undefined, {auth: false}); }
  ledger() { return this.request('GET', '/pilot/v1/ledger', undefined, {auth: false}); }

  /** Record limits and goals the owner gave this agent; the server keeps them within the owner's mandate. */
  setLimits(body) { return this.request('PUT', '/pilot/v1/limits', body); }

  // ---------- pins (R13) ----------
  #pinned() {
    return pinsOf(this.state) !== null;
  }

  #checkPins(trackerNftId, denomination) {
    const err = pinProblem(pinsOf(this.state), trackerNftId, denomination);
    if (err) throw err;
  }

  async #pinFrom(info) {
    if (!isObject(info)) return;
    const nft = info.tracker_nft_id, denom = info.denomination;
    if (!(typeof nft === 'string' && nft && typeof denom === 'string' && denom)) return;
    if (this.#pinned()) {
      this.#checkPins(nft, denom);
      return;
    }
    if (!truthy(this.state.participant_id ?? null)) return;     // only an enrolled profile is pinned
    await this.#update(state => {
      const err = pinProblem(pinsOf(state), nft, denom);
      if (err) throw err;
      if (!pinsOf(state)) state.pins = {tracker_nft_id: nft, denomination: denom};
    });
  }

  /**
   * The feature tags the server advertises in GET /info (which also checks the pins), for a pinned profile. A profile
   * not pinned yet is served exactly as by 0.3 (no extra request): it is pinned by its first call.
   */
  async #features() {
    if (!this.#pinned()) return [];
    const info = await this.info();
    if (!isObject(info)) throw new ValunError('bad_response', 'GET /info did not return an object');
    const raw = info.features;
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw) && raw.every(f => typeof f === 'string')) return [...raw];
    return ['?'];    // malformed: features count as advertised (the residue rule applies) and none is recognised
  }

  // ---------- independent checks ----------
  async #registeredKey(pid) {
    const p = await this.participant(pid);
    if (!isObject(p) || p.status !== 'active' || !p.pubkey) {
      throw new ValunError('counterparty_inactive', `${pid} has no active registered key`);
    }
    return p.pubkey;
  }

  /** GET /info, checked against the protocol constants and the pins given to the constructor. */
  async #networkInfo() {
    const info = await this.info();
    if (!isObject(info)) throw new ValunError('bad_response', 'GET /info did not return an object');
    if (info.network !== NETWORK) throw new ValunError('wrong_network', `the server is on network ${JSON.stringify(info.network)}, not ${NETWORK}`);
    if (this.#pin.trackerNftId && info.tracker_nft_id !== this.#pin.trackerNftId) {
      throw new ValunError('wrong_tracker', 'the server names a different tracker than the one pinned for this client');
    }
    if (this.#pin.denomination && info.denomination !== this.#pin.denomination) {
      throw new ValunError('wrong_tracker', 'the server names a different unit than the one pinned for this client');
    }
    return info;
  }

  /**
   * Check the current offer of a deal view before accepting or countering it (spec 15.2 items 1-5 as the Python
   * client does them, then item 6): recompute the terms hash, check network/tracker/unit, that this agent is a party
   * named with its own key, the proposer's key against the directory and its signature, and expiry.
   * Returns {terms_hash, proposer_signature_valid: true, terms}.
   */
  async verifyOffer(d) {
    const cur = isObject(d) ? d.current : null;
    if (!isObject(cur)) throw new ValunError('no_offer', 'this deal has no visible offer');
    const t = cur.terms;
    checkTermsShape(t);
    const h = termsHash(t);
    if (h !== cur.terms_hash) throw new ValunError('hash_mismatch', 'the terms do not hash to the stated terms_hash; refusing to sign');
    if (t.network !== NETWORK || t.protocol !== PROTOCOL) throw new ValunError('wrong_network', 'terms are for a different network or protocol');
    const info = await this.#networkInfo();
    if (t.tracker_nft_id !== info.tracker_nft_id || t.denomination !== info.denomination) {
      throw new ValunError('wrong_tracker', 'terms name a different tracker or unit than this network');
    }
    const me = this.participantId;
    if (me !== t.payer.id && me !== t.payee.id) throw new ValunError('not_a_party', 'you are not a party to these terms');
    for (const role of ['payer', 'payee']) {
      if (t[role].id === me && t[role].pubkey !== this.pubkey) throw new ValunError('wrong_key', `the terms name a different key for you as ${role}`);
    }
    if (cur.by !== t.payer.id && cur.by !== t.payee.id) throw new ValunError('not_a_party', 'the offer was not made by a party to its terms');
    const proposerKey = await this.#registeredKey(cur.by);
    if (proposerKey !== (t.payer.id === cur.by ? t.payer : t.payee).pubkey) {
      throw new ValunError('wrong_key', 'the proposer key in the terms is not the registered key');
    }
    if (!verifyHex(cur.signature, utf8(statements.propose(h)), proposerKey)) {
      throw new ValunError('bad_signature', "the proposer's signature does not verify");
    }
    if (!isRfc3339(t.offer_expires_at) || !isRfc3339(t.deliver_by)) {
      throw new ValunError('bad_terms', 'the offer times are not RFC 3339 date-times; refusing to sign');
    }
    if (Date.parse(t.offer_expires_at) < this.#now()) throw new ValunError('expired', 'the offer has expired');
    // spec 15.2 item 6 (SHOULD): the Python client does not make these checks.
    if (d.id !== undefined && t.deal_id !== d.id) throw new ValunError('wrong_deal', 'the terms are for a different deal id');
    if (t.proposer !== cur.by) throw new ValunError('wrong_proposer', 'the terms name a different proposer than the signer');
    if (!Number.isSafeInteger(t.version) || (cur.version !== undefined && t.version !== cur.version)) {
      throw new ValunError('bad_terms', 'the terms version is not the offer version');
    }
    if (t.price.unit !== UNIT || !Number.isSafeInteger(t.price.amount)) throw new ValunError('bad_terms', 'the price is not a whole number of PC');
    if (t.consideration !== CONSIDERATION) throw new ValunError('bad_terms', `the consideration is not ${CONSIDERATION}`);
    if (!exactKeys(t, TERMS_FIELDS) || !exactKeys(t.payer, ['id', 'pubkey']) || !exactKeys(t.payee, ['id', 'pubkey'])
        || !exactKeys(t.price, ['amount', 'unit']) || !exactKeys(t.service, ['title', 'description', 'deliverable'])
        || !['title', 'description', 'deliverable'].every(k => typeof t.service[k] === 'string')) {
      throw new ValunError('bad_terms', 'the terms have missing or unknown fields; refusing to sign what may not be shown');
    }
    if (t.version === 1 ? t.prior_terms_hash !== null : !/^[0-9a-f]{64}$/.test(String(t.prior_terms_hash))) {
      throw new ValunError('bad_terms', 'prior_terms_hash does not fit the version');
    }
    const prev = t.version > 1 && Array.isArray(d.versions) ? d.versions.find(x => x?.version === t.version - 1) : undefined;
    if (prev && prev.terms_hash !== t.prior_terms_hash) {
      throw new ValunError('bad_terms', 'the offer does not continue the version before it (prior_terms_hash)');
    }
    return {terms_hash: h, proposer_signature_valid: true, terms: t};
  }

  /** The agreed terms of a deal view, checked: hash, and both parties' signatures against the keys named in them. */
  verifiedAgreement(d) {
    const a = isObject(d) ? d.agreement : null;
    if (!isObject(a)) throw new ValunError('not_agreed', 'no agreement on this deal');
    const cur = d.current;
    if (!isObject(cur)) throw new ValunError('not_agreed', 'the agreement has no terms in this view');
    const t = cur.terms;
    checkTermsShape(t);
    const h = termsHash(t);
    if (h !== a.terms_hash) throw new ValunError('hash_mismatch', 'agreement hash does not match its terms');
    const keys = {[t.payer.id]: t.payer.pubkey, [t.payee.id]: t.payee.pubkey};
    const prop = cur.by;
    if (prop !== t.payer.id && prop !== t.payee.id) throw new ValunError('bad_signature', 'the agreement was not proposed by a party to its terms');
    const acc = prop === t.payer.id ? t.payee.id : t.payer.id;
    if (!verifyHex(a.proposer_signature, utf8(statements.propose(h)), keys[prop])) {
      throw new ValunError('bad_signature', 'proposer signature on the agreement does not verify');
    }
    if (!verifyHex(a.acceptor_signature, utf8(statements.accept(h)), keys[acc])) {
      throw new ValunError('bad_signature', 'acceptor signature on the agreement does not verify');
    }
    return t;
  }

  // ---------- acts (all signed locally) ----------
  /** valun-deal/1 terms for a new proposal (or, with dealId/version/prior, a counter-offer). Signs nothing. */
  async buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24,
    dealId = undefined, version = 1, prior = null}) {
    if (role !== 'payer' && role !== 'payee') {
      throw new ValunError('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)');
    }
    if (![title, description, deliverable].every(x => typeof x === 'string')) {
      throw new ValunError('bad_terms', 'title, description and deliverable must be strings');
    }
    const amount = toPrice(price);
    const dueH = toHours(deliverByHours, 'deliverByHours'), ttlH = toHours(offerTtlHours, 'offerTtlHours');
    this.#secretBytes().fill(0);   // fail early (not_connected) rather than after the reads
    const info = await this.#networkInfo();
    const other = {id: counterpartyId, pubkey: await this.#registeredKey(counterpartyId)};
    const me = {id: this.participantId, pubkey: this.pubkey};
    const now = this.#now();
    return {
      protocol: PROTOCOL, network: NETWORK, tracker_nft_id: info.tracker_nft_id, denomination: info.denomination,
      deal_id: dealId || ('vd_' + bytesToHex(this.#randomBytes(8))), version, prior_terms_hash: prior,
      nonce: bytesToHex(this.#randomBytes(16)), proposer: this.participantId,
      payer: role === 'payer' ? me : other, payee: role === 'payer' ? other : me,
      service: {title, description, deliverable},
      price: {amount, unit: UNIT}, consideration: CONSIDERATION,
      deliver_by: isoSeconds(now + dueH * HOUR), offer_expires_at: isoSeconds(now + ttlH * HOUR),
    };
  }

  /** Propose a new deal (version 1), signed by this agent. */
  async propose({counterpartyId, role, title, description, deliverable, price, deliverByHours = 48, offerTtlHours = 24}) {
    const t = await this.buildTerms({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours});
    const h = termsHash(t);
    return this.request('POST', '/pilot/v1/deals', {terms: t, terms_hash: h, signature: this.#sign(statements.propose(h))});
  }

  /**
   * Counter the current offer: verify it, then sign new terms (version + 1, prior = its hash). Unset fields carry over.
   * With expectedTermsHash (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current
   * offer is another.
   */
  async counter(dealId, {price = undefined, title = undefined, description = undefined, deliverable = undefined,
    deliverByHours = undefined, offerTtlHours = 24, expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    const chk = await this.verifyOffer(d);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== chk.terms_hash) {
      throw new ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before countering');
    }
    const t0 = chk.terms;
    const role = t0.payer.id === this.participantId ? 'payer' : 'payee';
    const other = role === 'payer' ? t0.payee.id : t0.payer.id;
    const dueH = deliverByHours ?? Math.max(1, Math.floor((Date.parse(t0.deliver_by) - this.#now()) / HOUR));
    const t = await this.buildTerms({
      counterpartyId: other, role,
      title: title || t0.service.title, description: description || t0.service.description,
      deliverable: deliverable || t0.service.deliverable, price: price ?? t0.price.amount,
      deliverByHours: dueH, offerTtlHours, dealId, version: t0.version + 1, prior: chk.terms_hash,
    });
    const h = termsHash(t);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/counter`,
      {terms: t, terms_hash: h, signature: this.#sign(statements.propose(h))});
  }

  /** Accept the current offer after verifyOffer(); refuses if it changed since `expectedTermsHash` was inspected. */
  async accept(dealId, {expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    const chk = await this.verifyOffer(d);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== chk.terms_hash) {
      throw new ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before accepting');
    }
    const h = chk.terms_hash;
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/accept`, {terms_hash: h, signature: this.#sign(statements.accept(h))});
  }

  /** Decline the current offer. The signature covers sha256(reason) of exactly the reason sent (spec 8.3). */
  async decline(dealId, reason = '') {
    reason ??= '';
    refuseReason('decline', reason);
    const d = await this.deal(dealId);
    const h = this.#offerHash(d?.current);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/decline`,
      {terms_hash: h, reason, signature: this.#sign(statements.decline(h, reason))});
  }

  /** Withdraw this agent's open offer, or its counter-offer held for its owner. */
  async withdraw(dealId) {
    const d = await this.deal(dealId);
    const h = this.#offerHash(d?.pending_counter || d?.current);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/withdraw`, {terms_hash: h, signature: this.#sign(statements.withdraw(h))});
  }

  /** The terms_hash of an offer in a view, recomputed from its terms when the view carries them. */
  #offerHash(offer) {
    if (!isObject(offer) || typeof offer.terms_hash !== 'string') throw new ValunError('no_offer', 'this deal has no visible offer');
    if (offer.terms !== undefined && termsHash(offer.terms) !== offer.terms_hash) {
      throw new ValunError('hash_mismatch', 'the terms do not hash to the stated terms_hash; refusing to sign');
    }
    return offer.terms_hash;
  }

  /** Deliver the work (payee): verifies the agreement first, then signs sha256(content) exactly as sent. */
  async deliver(dealId, content, {title = ''} = {}) {
    if (typeof content !== 'string') throw new ValunError('bad_content', 'content must be a string');
    const d = await this.deal(dealId);
    if (!isObject(d?.agreement)) throw new ValunError('not_agreed', 'there is no agreement to deliver against');
    const h = termsHash(this.verifiedAgreement(d));
    const dh = sha256Hex(content);
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/deliver`,
      {terms_hash: h, content, title, sha256: dh, signature: this.#sign(statements.deliver(h, content))});
  }

  /**
   * Accept the delivery and pay: sign the Basis note for prior + price, after checking the template independently.
   *
   * Checked before signing: the content matches its hash (and the one the caller reviewed); the agreement's hash (and the
   * one the caller reviewed) and both signatures; the payee's signature on the delivery; the template names this agent's
   * key and the payee's current key, adds exactly the agreed price, names the agreed (and pinned) tracker and unit, and is
   * current. The prior total must be one this client can stand behind: a prior note it signed itself and not older than
   * its own records (when the server offers bound_notes/1), otherwise its own record of the confirmed total
   * (ledger_mismatch). A pending note of its own that its deal or the prior note shows applied is confirmed on the way. A
   * note of its own for THIS deal is never paid again while its records still hold it as pending and it may have
   * applied: its deal or the prior note shows it applied, or the edge's total has reached that note's total
   * (already_paid). The note is recorded as pending before it is sent, and confirmed only when the server answers
   * note_issued: an owner can still reject a held note (OQ-23).
   */
  async complete(dealId, {expectedDeliverableSha256 = undefined, expectedTermsHash = undefined} = {}) {
    const d = await this.deal(dealId);
    if (!isObject(d?.delivery) || !isObject(d?.agreement)) throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const dh = d.delivery.sha256;
    if (typeof d.delivery.content !== 'string' || sha256Hex(d.delivery.content) !== dh) {
      throw new ValunError('hash_mismatch', 'the delivered content does not match its hash');
    }
    if (truthy(expectedDeliverableSha256 ?? null) && expectedDeliverableSha256 !== dh) {
      throw new ValunError('stale_delivery', 'the delivery changed since you reviewed it');
    }
    const terms = this.verifiedAgreement(d);
    const h = termsHash(terms);
    if (truthy(expectedTermsHash ?? null) && expectedTermsHash !== h) {
      throw new ValunError('stale_terms', 'the agreed terms are not the ones you reviewed; refusing to accept the delivery');
    }
    // A pinned (0.4) profile reads /info: a server offering bound_notes/1 shows the prior note (?prior=1), and with any
    // feature the tracker keeps the timestamp residues 995-999 for other operations. Otherwise exactly as 0.3.
    const features = await this.#features();
    const withPrior = features.includes('bound_notes/1');
    const tpl = await this.request('GET', `/pilot/v1/deals/${seg(dealId)}/credit-note-template` + (withPrior ? '?prior=1' : ''));
    if (!isObject(tpl) || !['total', 'prior_total', 'price', 'timestamp'].every(k => Number.isSafeInteger(tpl[k]))) {
      throw new ValunError('bad_template', 'credit-note template is malformed');
    }
    // The note is between the parties' CURRENT keys (an owner may have replaced an agent key after the deal was
    // agreed): it must be signed by this agent's key and credit the payee's key as the directory lists it now.
    const payee = await this.#registeredKey(terms.payee.id);
    if (tpl.issuer_pubkey !== this.pubkey || tpl.recipient_pubkey !== payee) {
      throw new ValunError('bad_template', 'credit-note template names the wrong parties');
    }
    const amount = terms.price.amount;
    if (tpl.price !== amount || tpl.total !== tpl.prior_total + amount) {
      throw new ValunError('bad_template', 'credit-note template does not add exactly the agreed price');
    }
    Client.checkDeliverySignature(d.delivery, h, terms.payee.pubkey, payee);
    const pair = `${this.pubkey}>${payee}`;
    const verify = noteVerifier(terms.tracker_nft_id, terms.denomination);
    await this.#reload();
    await this.#checkRecords(pair, tpl, withPrior ? (tpl.prior_note ?? null) : null, payee, verify, dealId, d);
    if (tpl.tracker_nft_id !== terms.tracker_nft_id || tpl.denomination !== terms.denomination) {
      throw new ValunError('bad_template', 'credit-note template names a different tracker or unit');
    }
    this.#checkPins(tpl.tracker_nft_id, tpl.denomination);
    if (Math.abs(tpl.timestamp - this.#now()) > NOTE_CLOCK_TOLERANCE_MS) {
      throw new ValunError('bad_template', 'credit-note template timestamp is not current');
    }
    if (features.length && tpl.timestamp % 1000 >= RESERVED_MS_FROM) {
      throw new ValunError('bad_template', `credit-note template timestamp ${tpl.timestamp} ends in ${tpl.timestamp % 1000}: `
        + 'the tracker keeps residues 995-999 for other operations; refusing to sign it as a credit note');
    }
    // Recompute the 80-byte message from the checked values; never sign the template's message_hex.
    let msg;
    try {
      msg = noteMessage(this.pubkey, payee, tpl.total, tpl.timestamp, tpl.tracker_nft_id, tpl.denomination);
    } catch (e) {
      throw new ValunError('bad_template', `credit-note template cannot form a Basis note: ${e.message}`);
    }
    const body = {terms_hash: h, deliverable_sha256: dh, signature: this.#sign(statements.complete(h, dh)),
      credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: this.#signBytes(msg)}};
    const note = {...body.credit_note};
    const signedAt = isoSeconds(this.#now());
    await this.#update(state => {               // written before the note is sent: its outcome is not known yet
      const err = pinProblem(pinsOf(state), tpl.tracker_nft_id, tpl.denomination);
      if (err) throw err;
      if (!pinsOf(state)) state.pins = {tracker_nft_id: tpl.tracker_nft_id, denomination: tpl.denomination};   // first call after an upgrade
      records.addPending(recordsIn(state), pair, note.total, note.timestamp, 'note', dealId, 'out', signedAt);
    });
    const forget = state => { records.removePending(recordsIn(state), pair, note.total, note.timestamp, dealId); };
    let r;
    try {
      r = await this.request('POST', `/pilot/v1/deals/${seg(dealId)}/complete`, body);
    } catch (e) {
      if (isValunError(e) && typeof e.status === 'number' && e.status >= 400 && e.status < 500) await this.#settle(forget);   // refused: it can never apply
      throw e;                                  // otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
    }
    const status = isObject(r) ? r.status : null;
    if (status === 'note_issued') {
      await this.#settle(state => this.#confirmIn(state, pair, note));
    } else if (status !== 'completion_awaiting_owner' && status !== 'issuing_note') {
      await this.#settle(forget);               // e.g. note_failed: the tracker does not hold it
    }
    return r;
  }

  // ---------- records of credit notes (records.js) ----------
  #confirmIn(state, pair, edge) {
    const e = records.confirm(recordsIn(state), pair, edge);
    if (truthy(e.confirmed) && pair.startsWith(`${this.pubkey}>`)) issuedIn(state)[pair] = e.confirmed.total;   // the 0.3 record stays the confirmed total
  }

  /** My own record of the confirmed total on an outgoing edge: the records' confirmed state, else the 0.3 record. */
  #knownTotal(pair) {
    const c = records.confirmedTotal(recordsIn(this.state, false), pair);
    if (c !== null && c !== undefined) return c;
    const issued = issuedIn(this.state, false);
    return Object.hasOwn(issued, pair) ? issued[pair] ?? null : null;
  }

  /**
   * The template's prior must be one I can stand behind, and this deal must not be one my records may show paid. With a
   * prior note (a server offering bound_notes/1) it must be the template's prior, signed by me and not older than my
   * records; without one, the prior total must equal my record of the confirmed total, when I have one. First, a held or
   * issuing note of mine that its deal now records as issued is confirmed (owner approvals happen after this client
   * signed): when the totals disagree, and whenever a note of mine for this deal is pending.
   */
  async #checkRecords(pair, tpl, prior, payee, verify, dealId, d) {
    if (prior !== null && (!isDict(prior) || !pyEq(pyGet(prior, 'total'), tpl.prior_total))) {
      throw new ValunError('bad_template', "the credit-note template's prior note does not match its prior total");
    }
    const known = this.#knownTotal(pair);
    if (this.#pendingNotes(pair, dealId).length || (prior === null && known !== null && !pyEq(known, tpl.prior_total))) {
      await this.#confirmIssued(pair, payee, verify, dealId, d);
    }
    if (prior !== null) {
      await this.#checkPrior(pair, prior, tpl, verify, dealId);
    } else {
      const now = this.#knownTotal(pair);
      if (now !== null && !pyEq(now, tpl.prior_total)) {
        throw new ValunError('ledger_mismatch', `the server says you have issued this payee ${tpl.prior_total} PC of credit notes so far; your own record says ${str(now)}. Ask your operator.`);
      }
    }
    for (const p of this.#pendingNotes(pair, dealId)) {
      // Still pending, so neither its deal nor the edge shows its outcome. If the edge has reached its total, it may have
      // applied (an owner approved it after this client signed): paying the deal again could pay it twice.
      const total = pyGet(p, 'total');
      if (typeof total === 'number' && Number.isSafeInteger(total) && tpl.prior_total >= total) {
        throw new ValunError('already_paid', `your earlier credit note for this deal (${total} PC in total to this payee) may `
          + `already be on the tracker: the edge's total is ${tpl.prior_total} PC now. Refusing `
          + 'to pay it again. Ask your operator.');
      }
    }
  }

  /** My pending credit notes for this deal on this edge. */
  #pendingNotes(pair, dealId) {
    return records.get(recordsIn(this.state, false), pair).pending
      .filter(p => isDict(p) && pyGet(p, 'kind') === 'note' && pyGet(p, 'ref') === dealId);
  }

  /** Confirm my pending notes on this edge that their deals record as issued (with the note's own signature). */
  async #confirmIssued(pair, payee, verify, dealId, current = null) {
    const found = [];
    for (const p of records.get(recordsIn(this.state, false), pair).pending) {
      if (!(isDict(p) && pyGet(p, 'kind') === 'note' && pyGet(p, 'direction') === 'out' && typeof pyGet(p, 'ref') === 'string')) continue;
      let d;
      try {
        d = current !== null && p.ref === dealId ? current : await this.deal(p.ref);
      } catch (e) {
        if (isValunError(e)) continue;
        throw e;
      }
      if (!isDict(d)) continue;
      const tn = pyGet(d, 'status') === 'note_issued' ? or(pyGet(or(pyGet(d, 'credit_note'), {}), 'tracker_note'), {}) : {};
      const st = {total: pyGet(tn, 'amount_collected'), timestamp: pyGet(tn, 'timestamp'), signature: pyGet(tn, 'signature')};
      if (pyEq(st.total, pyGet(p, 'total')) && pyEq(st.timestamp, pyGet(p, 'timestamp'))
          && verify(this.pubkey, payee, st.total, st.timestamp, st.signature)) {
        found.push([st, p]);
      }
    }
    if (found.length) {
      let latest = found[0][0];
      for (const [st] of found) if (st.timestamp > latest.timestamp) latest = st;
      await this.#update(state => this.#confirmIn(state, pair, latest));
      Client.#refusePaidAgain(dealId, found.map(([, p]) => p));
    }
  }

  /**
   * With a prior note (a 0.4 server): signed by me, and not older than my records. If it is one of my pending notes,
   * that note applied: it is confirmed, and its own deal is never paid again.
   */
  async #checkPrior(pair, prior, tpl, verify, dealId) {
    const mine = recordsIn(this.state, false);
    const problem = records.priorProblem(mine, pair, prior, this.pubkey, verify);
    if (problem === 'bad_prior_signature') {
      throw new ValunError('bad_prior_signature', "the server's prior credit note to this payee is not signed by your key; refusing to sign a new one");
    }
    if (problem) {
      const c = or(records.get(mine, pair).confirmed, {});
      throw new ValunError('ledger_mismatch', `the server shows an older prior credit note to this payee (${str(prior.total)} PC at `
        + `${str(prior.timestamp)}) than your own record (${str(pyGet(c, 'total'))} PC at ${str(pyGet(c, 'timestamp'))}). `
        + 'Ask your operator.');
    }
    const applied = records.get(mine, pair).pending
      .filter(p => isDict(p) && pyEq(pyGet(p, 'total'), prior.total) && pyEq(pyGet(p, 'timestamp'), prior.timestamp));
    if (applied.length) {
      const edge = records.edgeState(prior);
      await this.#update(state => this.#confirmIn(state, pair, edge));
      Client.#refusePaidAgain(dealId, applied);
    }
    if (tpl.timestamp <= prior.timestamp) {
      throw new ValunError('bad_template', 'the credit-note template timestamp is not after the prior note');
    }
  }

  /** A note of mine that applied paid its own deal: never sign a second payment for it, whatever the server says. */
  static #refusePaidAgain(dealId, applied) {
    for (const p of applied) {
      if (pyGet(p, 'kind') === 'note' && pyGet(p, 'ref') === dealId) {
        throw new ValunError('already_paid', `your credit note for this deal (${str(pyGet(p, 'total'))} PC) is already on the tracker, so `
          + 'the deal is paid; refusing to pay it again. Ask your operator.');
      }
    }
  }

  /**
   * The payee signed this delivery: statement('deliver', terms_hash, sha256) verifies under one of `payeeKeys` (the key
   * the terms name, or the payee's current directory key after an owner replaced it). Else bad_delivery_signature.
   */
  static checkDeliverySignature(delivery, termsHashHex, ...payeeKeys) {
    const sig = isObject(delivery) ? delivery.signature : undefined;
    const dh = isObject(delivery) ? delivery.sha256 ?? null : null;
    const text = utf8(statement('deliver', termsHashHex, str(dh)));
    for (const k of new Set(payeeKeys)) {
      if (typeof sig === 'string' && typeof k === 'string' && verifyHex(sig, text, k)) return;
    }
    throw new ValunError('bad_delivery_signature', "the delivery is not signed by the payee's key; refusing to accept it");
  }

  /** Dispute the delivery (payer). The signature covers sha256(reason) of exactly the reason sent (spec 8.3). */
  async dispute(dealId, reason) {
    reason ??= '';
    refuseReason('dispute', reason);
    const d = await this.deal(dealId);
    this.verifiedAgreement(d);   // throws unless d.agreement.terms_hash is the hash of the terms, signed by both parties
    if (!isObject(d.delivery) || typeof d.delivery.sha256 !== 'string') throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const dh = d.delivery.sha256;
    if (typeof d.delivery.content === 'string' && sha256Hex(d.delivery.content) !== dh) {
      throw new ValunError('hash_mismatch', 'the delivered content does not match its hash');
    }
    const h = d.agreement.terms_hash;
    return this.request('POST', `/pilot/v1/deals/${seg(dealId)}/dispute`,
      {terms_hash: h, deliverable_sha256: dh, reason, signature: this.#sign(statements.dispute(h, dh, reason))});
  }
}
