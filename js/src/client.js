// Valun pilot client: the participant side. Holds the participant's signing key locally and talks to a Valun server.
//
// A port of the Python reference client (python/src/valun/client.py). Trust model: the server is not trusted to tell
// this client what to sign. Before signing, the client recomputes the terms hash itself, checks the counterparty's
// signature against the key in the public directory, and checks credit-note templates against the agreed price and its
// own record of what it has already issued to that payee. The key and the agent token live in a store and are never
// returned by any method, logged, or put into an error.

import {sign, verifyHex, noteMessage, publicKey, generateSecret as defaultGenerateSecret} from './basis.js';
import {bytesToHex, hexToBytes, utf8} from './bytes.js';
import {SignatureError, ValunError} from './errors.js';
import {CONSIDERATION, NETWORK, PROTOCOL, UNIT, reasonProblem, sha256Hex, statements, termsHash} from './protocol.js';
import {randomBytes as defaultRandomBytes} from './random.js';

const HOUR = 3600_000;
const NOTE_CLOCK_TOLERANCE_MS = 10 * 60_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

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
    if (server) this.state.server = String(server).replace(/\/+$/, '');
  }

  /** Non-secret state: server, participant_id, pubkey, network, enrolled_at, issued (notes issued per key pair). */
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

  // ---------- HTTP ----------
  /** One API call. Returns the parsed JSON body; throws ValunError(code = the server's `error`) for HTTP errors. */
  async request(method, path, body = undefined, {auth = true, token = undefined} = {}) {
    const server = this.state.server;
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
      Object.assign(this.state, {participant_id: participantId, pubkey: pk, network: r.network,
        enrolled_at: isoSeconds(this.#now()), issued: this.state.issued || {}});
      await this.#store.saveCredentials(bytesToHex(secret), r.agent_token);
      await this.#save();
      return {participant_id: participantId, pubkey: pk, network: r.network};
    } finally {
      secret.fill(0);
    }
  }

  // ---------- reads ----------
  info() { return this.request('GET', '/pilot/v1/info', undefined, {auth: false}); }
  me() { return this.request('GET', '/pilot/v1/me'); }
  inbox() { return this.request('GET', '/pilot/v1/inbox'); }
  deals() { return this.request('GET', '/pilot/v1/deals'); }
  deal(dealId) { return this.request('GET', `/pilot/v1/deals/${seg(dealId)}`); }
  directory() { return this.request('GET', '/pilot/v1/participants', undefined, {auth: false}); }
  participant(pid) { return this.request('GET', `/pilot/v1/participants/${seg(pid)}`, undefined, {auth: false}); }
  ledger() { return this.request('GET', '/pilot/v1/ledger', undefined, {auth: false}); }

  /** Record limits and goals the owner gave this agent; the server keeps them within the owner's mandate. */
  setLimits(body) { return this.request('PUT', '/pilot/v1/limits', body); }

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

  /** Counter the current offer: verify it, then sign new terms (version + 1, prior = its hash). Unset fields carry over. */
  async counter(dealId, {price = undefined, title = undefined, description = undefined, deliverable = undefined,
    deliverByHours = undefined, offerTtlHours = 24} = {}) {
    const d = await this.deal(dealId);
    const chk = await this.verifyOffer(d);
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
    if (expectedTermsHash && expectedTermsHash !== chk.terms_hash) {
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

  /** Accept the delivery and pay: sign the Basis note for prior + price, after checking the template independently. */
  async complete(dealId, {expectedDeliverableSha256 = undefined} = {}) {
    const d = await this.deal(dealId);
    if (!isObject(d?.delivery) || !isObject(d?.agreement)) throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const dh = d.delivery.sha256;
    if (typeof d.delivery.content !== 'string' || sha256Hex(d.delivery.content) !== dh) {
      throw new ValunError('hash_mismatch', 'the delivered content does not match its hash');
    }
    if (expectedDeliverableSha256 && expectedDeliverableSha256 !== dh) {
      throw new ValunError('stale_delivery', 'the delivery changed since you reviewed it');
    }
    const terms = this.verifiedAgreement(d);
    const tpl = await this.request('GET', `/pilot/v1/deals/${seg(dealId)}/credit-note-template`);
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
    const pair = `${this.pubkey}>${payee}`;
    const known = this.state.issued?.[pair];
    if (known !== undefined && known !== null && known !== tpl.prior_total) {
      throw new ValunError('ledger_mismatch', `the server says you have issued this payee ${tpl.prior_total} PC of credit notes so far; your own record says ${known}. Ask your operator.`);
    }
    if (tpl.tracker_nft_id !== terms.tracker_nft_id || tpl.denomination !== terms.denomination) {
      throw new ValunError('bad_template', 'credit-note template names a different tracker or unit');
    }
    if (Math.abs(tpl.timestamp - this.#now()) > NOTE_CLOCK_TOLERANCE_MS) {
      throw new ValunError('bad_template', 'credit-note template timestamp is not current');
    }
    // Recompute the 80-byte message from the checked values; never sign the template's message_hex.
    let msg;
    try {
      msg = noteMessage(this.pubkey, payee, tpl.total, tpl.timestamp, tpl.tracker_nft_id, tpl.denomination);
    } catch (e) {
      throw new ValunError('bad_template', `credit-note template cannot form a Basis note: ${e.message}`);
    }
    const h = termsHash(terms);
    const body = {terms_hash: h, deliverable_sha256: dh, signature: this.#sign(statements.complete(h, dh)),
      credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: this.#signBytes(msg)}};
    const r = await this.request('POST', `/pilot/v1/deals/${seg(dealId)}/complete`, body);
    if (['note_issued', 'completion_awaiting_owner', 'issuing_note'].includes(r?.status)) {
      if (!isObject(this.state.issued)) this.state.issued = {};
      this.state.issued[pair] = tpl.total;
      await this.#save();
    }
    return r;
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
