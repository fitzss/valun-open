// Basis driver: the only module that talks to Basis.
// - Tracker: the real basis_server (pinned Basis 3df7ed9, or tracker v3.2 = Valun fork commit 4370418), reached over loopback HTTP.
// - Signer: valun_signer, a thin wrapper around Basis's own basis_core crypto (see basis/valun_signer.rs).
// Secrets are passed to the signer on stdin only and never logged or returned.
// The same driver works with tracker v3 (circulating credit), which adds GET /capabilities, POST /notes/transfer and
// POST /notes/setoff, and refuses ordinary notes whose timestamp ends in 995-999 ms (see ordinaryTimestamp). Tracker v3.2
// adds the 105-byte prior acknowledgment PA(I,R,X,p,T) (priorAckMessage), over which it checks a transfer's two creditor
// prior slots and a bound note's prior_signature.
import {spawn} from 'node:child_process';

// Tracker v3 reserves the timestamp residues (ms mod 1000) 995-999 for operations other than ordinary notes: 999
// transfer, 998 set-off, 997 bound note, 996 and 995 reserved for later. Its POST /notes refuses them for an ordinary
// note (400 reserved_timestamp); older trackers accept any residue.
const RESERVED_FROM_MS = 995;

// The timestamp an ordinary note uses for a chosen time t (ms): t itself, unless t ends in 995-999 ms, in which case
// the next whole second (at most 5 ms later). Correct on every tracker, old and v3.
export function ordinaryTimestamp(t) {
  if (!Number.isSafeInteger(t) || t < 0) throw new TypeError(`a note timestamp is a whole, non-negative number of ms, not ${t}`);
  const residue = t % 1000;
  return residue >= RESERVED_FROM_MS ? t + (1000 - residue) : t;
}

// GET /capabilities data, or null for anything but a 200 answer with success and a data object (trackers before v3
// answer 404). Shared by Basis.capabilities() and the test harness, so both read an answer the same way.
export function capabilitiesFrom(status, json) {
  const data = status === 200 && json?.success === true ? json.data : null;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

// The source pin /api/status reports (`basis.pin`) for the tracker that is running: `fallback` (the 3df7ed93 text, or
// BASIS_PIN) for a tracker without GET /capabilities, and for tracker v3 the Valun fork commit its capabilities name
// (basis/BUILD.md), in every pilot mode (off included). A commit this file does not know (or one that reports another
// build than the one listed for it) is shown as an unlisted build of the build its capabilities name. That text is the
// tracker's own report about itself, and says so; `pinned` says whether the launcher's sha256 of the running
// basis_server (PILOT_TRACKER_SHA256) is one lib/pilot/pins.mjs lists: when it is not, the text ends in '(binary not
// pinned)' (a binary can report any commit; circulating credit stays off on it). Tracker v3 and v3.1 are still named
// here (what such a tracker says about itself), although circulating credit no longer runs on them (lib/pilot/caps.mjs).
const BUILD_LINES = Object.freeze({
  'valun-circulating-credit/4': Object.freeze({unlisted: 'tracker v3.2 (an unlisted build)', branch: 'circulating-credit-v3.2'}),
  'valun-circulating-credit/3': Object.freeze({unlisted: 'tracker v3 (an unlisted build)', branch: 'circulating-credit-v3'}),
});
export const TRACKER_BUILDS = Object.freeze({
  '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a': Object.freeze({name: 'tracker v3.2', build: 'valun-circulating-credit/4'}),
  '24675ec1c0f374f29101812caf2fc87ab48468c9': Object.freeze({name: 'tracker v3.1', build: 'valun-circulating-credit/3'}),
  '08f889931906beff6c2b69346965f400d740aa4a': Object.freeze({name: 'tracker v3', build: 'valun-circulating-credit/3'}),
});
export function trackerPin(caps, fallback, {pinned = false} = {}) {
  const commit = typeof caps?.commit === 'string' && /^[0-9a-f]{40}$/.test(caps.commit) ? caps.commit : null;
  const line = caps && typeof caps.build === 'string' && Object.hasOwn(BUILD_LINES, caps.build) ? BUILD_LINES[caps.build] : null;
  if (!line || !commit) return fallback;
  const known = Object.hasOwn(TRACKER_BUILDS, commit) && TRACKER_BUILDS[commit].build === caps.build ? TRACKER_BUILDS[commit] : null;
  return `Basis ${known ? known.name : line.unlisted}: Valun fork commit ${commit} (branch ${line.branch} on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself${pinned ? '' : ' (binary not pinned)'}`;
}

// One line for the server log describing what a tracker's capabilities say (null: no capabilities, or none read).
// Every value is printed with its control characters replaced, so the description stays one line.
export function describeCapabilities(caps) {
  if (!caps) return 'none (GET /capabilities gave no 200 answer: a tracker before v3)';
  const s = v => String(v ?? '?').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80);
  const n = caps.novation ?? {}, t = n.transfer ?? {}, o = n.setoff ?? {};
  return `${s(caps.tracker)} ${s(caps.build)}, commit ${s(caps.commit).slice(0, 12)}, pure_credit ${s(caps.pure_credit)}, ` +
    `reserved_ms ${Array.isArray(caps.reserved_ms) ? s(caps.reserved_ms.join(',')) : '?'}, bound notes at ${s(caps.bound_notes?.ms)} ms v${s(caps.bound_notes?.version)}, ` +
    `transfer at ${s(t.ms)} ms v${s(t.version)}, set-off at ${s(o.ms)} ms v${s(o.version)}, max age ${s(n.max_age_ms)} ms, ` +
    `on-chain edges ${s(caps.onchain_edges)}, novations ${caps.novations_disabled_reason ? `disabled (${s(caps.novations_disabled_reason)})` : 'enabled'}`;
}

// `code` says what failed, for the HTTP layer and clients (OQ-35): signer_unavailable (the helper timed out, failed to
// start or gave no answer: an outage), signer_error (the helper ran and refused its input), tracker_unavailable (the
// tracker could not be reached or answered with an error). `message` keeps the details for the server log only;
// `publicMessage` is a fixed text without paths, helper output or other details.
const PUBLIC_MESSAGES = {
  signer_unavailable: 'the Basis signature helper is temporarily unavailable; try again',
  signer_error: 'the Basis signature helper refused a request the server built',
  tracker_unavailable: 'the Basis tracker is unavailable or answered with an error; try again',
};
export class BasisError extends Error {
  constructor(message, {status = null, body = null, code = 'tracker_unavailable'} = {}) {
    super(message); this.name = 'BasisError'; this.status = status; this.body = body; this.code = code;
  }
  get publicMessage() { return PUBLIC_MESSAGES[this.code] ?? PUBLIC_MESSAGES.tracker_unavailable; }
}

export function makeSignerRunner({mode = 'direct', signerPath, wslExe = 'C:/Windows/System32/wsl.exe', distro = 'valun-ic1', user = 'valun', timeoutMs = 15000}) {
  if (!signerPath) throw Error('signerPath required');
  return (args, stdin = '') => new Promise((resolve, reject) => {
    const [cmd, argv] = mode === 'wsl'
      ? [wslExe, ['-d', distro, '-u', user, '--exec', signerPath, ...args]]
      : [signerPath, args];
    // stdin is opened only when there is something to send (a secret). The signer may exit before reading it,
    // so a broken pipe on stdin must never become an unhandled 'error' event (it crashed the hosted app).
    const p = spawn(cmd, argv, {windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']});
    if (p.stdin) p.stdin.on('error', () => {});
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new BasisError('signer timed out', {code: 'signer_unavailable'})); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(new BasisError(`signer failed to start: ${e.code || e.message}`, {code: 'signer_unavailable'})); });
    p.on('close', () => {
      clearTimeout(t);
      let o;
      try { o = JSON.parse(out.trim()); } catch { return reject(new BasisError(`signer returned no JSON (${err.trim().slice(0, 200)})`, {code: 'signer_unavailable'})); }
      if (o.error) return reject(new BasisError(`signer: ${o.error}`, {code: 'signer_error'}));
      resolve(o);
    });
    if (p.stdin) p.stdin.end(stdin);
  });
}

export class Basis {
  constructor({trackerUrl, trackerNftId, runSigner, fetchImpl = fetch, denomination = 'erg'}) {
    if (!/^[0-9a-f]{64}$/.test(trackerNftId || '')) throw Error('trackerNftId must be 32-byte hex');
    if (!/^(erg|token:[0-9a-f]{64})$/.test(denomination)) throw Error('denomination must be erg or token:<64 hex>');
    this.url = trackerUrl.replace(/\/$/, '');
    this.nft = trackerNftId;
    this.sign_ = runSigner;
    this.fetch = fetchImpl;
    this.denomination = denomination;
    this.capsRead = null;   // the capabilities() read, kept per instance
  }

  async api(method, path, body) {
    let r;
    try {
      r = await this.fetch(this.url + path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000)});
    } catch (e) { throw new BasisError(`tracker unreachable: ${e.cause?.code || e.name}`); }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* plain text root endpoint */ }
    return {status: r.status, json: j, text};
  }

  async health() {
    const r = await this.api('GET', '/');
    return r.status === 200 && /Basis Tracker/.test(r.text);
  }

  // What the tracker says it enforces (tracker v3, GET /capabilities): the data object, or null when the tracker does
  // not answer 200 (404 on trackers before v3). Read once per instance and kept; refresh() reads it again. Throws
  // BasisError only when the tracker is unreachable (as api() does), and a failed read is not kept.
  capabilities() {
    if (!this.capsRead) {
      const read = this.api('GET', '/capabilities').then(r => capabilitiesFrom(r.status, r.json));
      this.capsRead = read;
      read.catch(() => { if (this.capsRead === read) this.capsRead = null; });
    }
    return this.capsRead;
  }
  refresh() { this.capsRead = null; return this.capabilities(); }

  // --- keys & signatures (basis_core via valun_signer) ---
  keygen() { return this.sign_(['keygen']); }
  async noteMessage({issuer, recipient, total, timestamp, denomination = this.denomination}) {
    return this.sign_(['note-message', issuer, recipient, String(total), String(timestamp), this.nft, denomination]);
  }
  // Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) = "basis/prior-ack/1" || debtKey(I,R,denomination) || X || p || T ||
  // trackerNftId (105 bytes; u64 big-endian): issuer I, recipient R, the edge's stored total X and its note's timestamp p
  // (0 and 0 for an edge with no note), at the operation's timestamp T. {message_hex, debt_key_hex}, as noteMessage.
  async priorAckMessage({issuer, recipient, priorTotal, priorTimestamp, timestamp, denomination = this.denomination}) {
    return this.sign_(['prior-ack-message', issuer, recipient, String(priorTotal), String(priorTimestamp), String(timestamp), this.nft, denomination]);
  }
  async signHex(pubkey, messageHex, secretHex) { return (await this.sign_(['sign', pubkey, messageHex], secretHex)).signature_hex; }
  async verify(pubkey, messageHex, signatureHex) { return (await this.sign_(['verify', pubkey, messageHex, signatureHex])).valid === true; }

  // --- tracker reads ---
  async note(issuer, recipient) {
    const r = await this.api('GET', `/notes/issuer/${issuer}/recipient/${recipient}?denomination=${encodeURIComponent(this.denomination)}`);
    if (r.status === 200 && r.json?.success) return r.json.data;
    if (r.status === 404 || /not found/i.test(r.json?.error || '')) return null;
    throw new BasisError(`note read failed: ${r.json?.error || r.status}`, {status: r.status});
  }
  async allNotes() {
    const r = await this.api('GET', '/notes');
    if (r.status !== 200 || !r.json?.success) throw new BasisError(`notes read failed: ${r.json?.error || r.status}`);
    return r.json.data || [];
  }
  async trackerState() {
    const r = await this.api('GET', '/tracker/state');
    if (r.status !== 200 || !r.json?.success) throw new BasisError(`tracker state failed: ${r.json?.error || r.status}`);
    return r.json.data;
  }
  async proof(issuer, recipient) {
    const r = await this.api('GET', `/tracker/proof?issuer_pubkey=${issuer}&recipient_pubkey=${recipient}&denomination=${encodeURIComponent(this.denomination)}`);
    if (r.status !== 200 || !r.json?.success) return null;
    return r.json.data;
  }
  async acceptanceCheck({issuer, recipient, totalDebt}) {
    const r = await this.api('POST', '/acceptance/check', {issuer_pubkey: issuer, recipient_pubkey: recipient, total_debt: totalDebt, denomination: this.denomination});
    if (r.status !== 200 || !r.json?.success) throw new BasisError(`acceptance check failed: ${r.json?.error || r.status}`);
    return r.json.data; // {acceptable, reason}
  }
  async policy(recipient) {
    const r = await this.api('GET', `/acceptance/policy/${recipient}`);
    if (r.status === 200 && r.json?.success) return r.json.data;
    return null;
  }
  async keyStatus(pubkey) {
    const r = await this.api('GET', `/key-status/${pubkey}`);
    return r.status === 200 && r.json?.success ? r.json.data : null;
  }

  // --- tracker writes (signed by the participant's key) ---
  // An ordinary note's timestamp (default: now) goes through ordinaryTimestamp, so it never ends in 995-999 ms.
  // A bound note (tracker v3: timestamp ending in 997 ms) passes priorSignature, the issuer's prior acknowledgment, and
  // optionally priorTotal and priorTimestamp (tracker v3.2); they are sent as prior_signature, prior_total and
  // prior_timestamp, and its explicit timestamp is sent as given (the acknowledgment was signed over it). Without them
  // the request has exactly the fields it always had.
  async issueNote({issuer, recipient, total, secretHex, timestamp, priorSignature = null, priorTotal = null, priorTimestamp = null}) {
    const bound = priorSignature != null;
    if (bound && timestamp === undefined) throw new TypeError('a bound note (priorSignature) needs the timestamp its prior acknowledgment was signed over');
    if (!bound) timestamp = ordinaryTimestamp(timestamp ?? Date.now());
    const {message_hex, debt_key_hex} = await this.noteMessage({issuer, recipient, total, timestamp});
    const signature = await this.signHex(issuer, message_hex, secretHex);
    const request = {issuer_pubkey: issuer, recipient_pubkey: recipient, amount: total, timestamp, signature, tracker_nft_id: this.nft, denomination: this.denomination,
      ...(bound ? {prior_signature: priorSignature} : {}), ...(priorTotal != null ? {prior_total: priorTotal} : {}),
      ...(priorTimestamp != null ? {prior_timestamp: priorTimestamp} : {})};
    const r = await this.api('POST', '/notes', request);
    return {request, message_hex, debt_key_hex, response: {status: r.status, success: !!r.json?.success, error: r.json?.error ?? null}};
  }

  // --- novations (tracker v3; older trackers answer 404) ---
  // POST /notes/transfer (seven signatures, timestamp ending in 999 ms) and POST /notes/setoff (998 ms). The body is
  // sent as given. The answer comes back as {status, success, code, error, data}; a plain-text answer (for example 422
  // for a body the tracker cannot parse) is in `error`. Valun decides outcomes by reading the edges back, never from
  // this answer. Throws BasisError only when the tracker is unreachable, as api() does.
  transfer(body) { return this.novation('/notes/transfer', body); }
  setoff(body) { return this.novation('/notes/setoff', body); }
  async novation(path, body) {
    const r = await this.api('POST', path, body);
    const j = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json : null;
    return {status: r.status, success: j?.success === true, code: typeof j?.code === 'string' ? j.code : null,
      error: j ? (j.error ?? null) : (r.text ? r.text.slice(0, 300) : null), data: j?.data ?? null};
  }
  async uploadPolicy({recipient, policyJson, secretHex}) {
    const signature = await this.signHex(recipient, Buffer.from(policyJson, 'utf8').toString('hex'), secretHex);
    const r = await this.api('POST', '/acceptance/policy', {recipient_pubkey: recipient, policy_json: policyJson, signature});
    return {status: r.status, success: !!r.json?.success, error: r.json?.error ?? null, data: r.json?.data ?? null, signature};
  }
}
