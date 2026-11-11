// Always-on sandbox participants, run inside the Valun server: deterministic, no AI model, exactly checkable work.
//
// sandbox-exact    sells text-stats (3 PC) and notary (2 PC) jobs; its results are always exact.
// sandbox-mallory  sells the same jobs but is WRONG ON PURPOSE in about half of its deliveries (chosen by the deal id),
//                  so anyone can test whether their agent or client really verifies work before issuing a credit note.
//
// They are ordinary participants: own keys (kept on the server's data volume), own mandates, signed statements, the
// same Pilot methods an HTTP client goes through. Labelled as run by the Valun operator. The loop runs in-process, so
// it adds no network traffic and the machine can still stop when idle; when a request wakes it, pending work is done
// within a few seconds. Results and their definitions match the Python `valun sandbox` (valun-open), byte for byte in
// the JSON values.
//
// Circulating credit (modes sandbox and on; design §5.8, spec 18.15). The agents also buy and pay, and the server signs
// for them at apply time:
//   - sandbox-exact sends every new sandbox_only participant one welcome job (it buys text-stats of a fixed text, 3 PC);
//   - both buy a stranger's text-stats and notary offers at no more than list price: at most 3 purchases per stranger
//     per 24 hours, text at most 4000 bytes, and none once the stranger's claims on the sandbox agents plus the price
//     would exceed 20 PC (STRANGER_EARN_CAP); selling is unchanged;
//   - both check every delivery they bought exactly (checkDelivery) and dispute a wrong one, naming the first field that
//     differs;
//   - sandbox-exact pays with its own bound credit note; sandbox-mallory pays with a sandbox-issued note it holds when
//     one covers the price, the payee accepts that issuer and is present (a payment by transfer), otherwise with its own
//     bound note;
//   - pilot.serverSigner (this.signer) signs their transfer slots, set-off slots, bound notes and prior
//     acknowledgments: 80-byte note messages for this pilot's tracker at residues 997, 998 and 999 only, never two
//     operations at one (edge, timestamp) (its own record, sandbox-records.json, like a client's rule R4);
//   - their mandates are the circulation ones below (mandateFor), re-applied by the drift check;
//   - the tick also signs consents still waiting for them (normally the core has signed them already; an item with
//     nothing left to sign is not work and never uses up the tick), reviews deliveries and sends welcome jobs, and
//     poke() runs a tick about 200 ms after a change to one of their deals;
//   - in mode sandbox they buy only from sandbox participants, and tell any other seller so.
// With circulating credit off (modes off and bound) they behave exactly as before: payee only, the v15 mandate, and the
// server signer signs nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {statements, circulationStatements, termsHash, NETWORK, PROTOCOL} from './core.mjs';
import {statusClass} from './status.mjs';
import {BOUND_NOTE_MS, SETOFF_MS, TRANSFER_MS, PRIOR_ACK} from './caps.mjs';
import {classifyEdge, quoteDigest, MAX_AGE_MS} from './novation.mjs';

export const SERVICES = {
  'text-stats': {price: 3, keywords: ['text-stats', 'text stats', 'text statistics', 'word count']},
  notary: {price: 2, keywords: ['notary', 'notar', 'sha-256', 'sha256']},
};
const SERVICES_TEXT = 'text-stats (3 PC): exact word/character/line counts, unique words, SHA-256 and the 10 most frequent words of your text. '
  + 'notary (2 PC): SHA-256 and byte length of your text. Put the text in a ``` block, after TEXT: at the end, or as the only '
  + 'quoted string in the description. Deterministic: you can check every number yourself; the delivery echoes the exact text '
  + 'processed. I only do the work (payee).';
// payWithHeldNotes: the agent's pay_with_held_notes with circulating credit on.
export const AGENTS = {
  'sandbox-exact': {display_name: 'Sandbox: exact results, always on', wrongOnPurpose: false, payWithHeldNotes: 'never',
    about: 'A deterministic test agent run inside the Valun server: no AI model, always on. Its results are exact, so you can verify every delivery yourself.'},
  'sandbox-mallory': {display_name: 'Sandbox Mallory: wrong on purpose', wrongOnPurpose: true, payWithHeldNotes: 'prefer',
    about: 'A deterministic test agent that is WRONG ON PURPOSE in about half of its deliveries. Use it to test that your agent verifies work and disputes wrong deliveries before issuing a credit note.'},
};
const OPERATOR = 'Valun operator (sandbox agent run by the server, no AI)';
const MANDATE = {objective: 'Sell exactly checkable text jobs to anyone testing Valun.', may_issue_credit: false, may_accept_credit: true,
  max_issue_per_deal: 0, max_issue_outstanding: 0, max_accept_per_deal: 25, max_accept_per_issuer: 200, min_price_as_payee: 0,
  min_payer_coverage_pct: 0, counterparties: 'any', approve_above: 1000, review_deliveries: false};
// With circulating credit on (design §5.8, §8): the agents also buy (a credit note per deal of at most 5 PC, at most 1000
// PC outstanding each, not counting debt to dormant sandbox participants), accept transfers of anyone's notes, move
// their own debt and clear automatically; sandbox-exact never pays with notes it holds, sandbox-mallory prefers to.
const CIRCULATION_MANDATE = Object.freeze({...MANDATE, objective: 'Sell and buy exactly checkable text jobs with anyone testing Valun.',
  may_issue_credit: true, max_issue_per_deal: 5, max_issue_outstanding: 1000, max_accept_per_deal: 25, max_accept_per_issuer: 1000,
  counterparties: 'any', approve_above: 1000, review_deliveries: false,
  accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: Object.freeze([]), novate_own_debt: true, auto_clear: true});
// The mandate the drift check keeps an agent at: the v15 one with circulating credit off, the circulation one with it on.
export const mandateFor = (handle, circulating) => (circulating ? {...CIRCULATION_MANDATE, pay_with_held_notes: AGENTS[handle].payWithHeldNotes} : {...MANDATE});
const PER_COUNTERPARTY_PER_DAY = 40, MANDATE_DAYS = 30;
// Each tick does at most PER_TICK actions that succeed and makes at most MAX_ATTEMPTS_PER_TICK attempts. An item that
// fails is skipped for BACKOFF_BASE_MS * 2^(failures - 1), at most BACKOFF_MAX_MS, so failing items never starve the
// others (they used to count against PER_TICK on every tick). A failure that says when to try again (retry_after_ms:
// a timestamp ahead, a payment window still open) is skipped until then instead.
const PER_TICK = 8, MAX_ATTEMPTS_PER_TICK = 32, BACKOFF_BASE_MS = 10e3, BACKOFF_MAX_MS = 3600e3;
// What an action returns when it found nothing to do (a consent item the agent has already signed, a deal that no
// longer waits for it): the tick counts it neither as a success nor as an attempt, so such items never use up PER_TICK
// (circulating credit only; with it off every action does something or fails).
const NOTHING = Symbol('nothing to do');
// Refusals from Pilot.accept that trying again does not change: the agent declines the offer, with a signed reason.
const PERMANENT_REFUSALS = new Set(['mandate_exceeded', 'offer_not_authorized', 'acceptance_not_authorized']);
const refusalReason = e => e.code === 'offer_not_authorized'
  ? 'I cannot accept this offer: the server says it is no longer within your mandate (your owner changed your limits, or other commitments used them up). Make a new offer once it is.'
  : `I cannot accept this offer: accepting it would exceed my own mandate${typeof e.extra?.rule === 'string' ? ` (${e.extra.rule})` : ''}. Offer less, or try again later.`;
// The decline of a seller the agents do not buy from: with circulating credit off, the v15 text; in mode sandbox, a
// participant who is not in the sandbox (the agents buy only from sandbox participants there).
const NOT_BUYING = 'I only sell (I do the work); I do not buy. ';
const SANDBOX_BUYING = 'Circulating credit is on for sandbox participants only, so I buy only from them (participants who joined with join-sandbox), not from you; you can still buy from me. ';
// ---------- circulating credit ----------
// What a stranger (any participant but the sandbox agents) may earn from the agents: its claims on the sandbox agents
// (on the tracker, plus purchases they agreed and have not paid, plus transfers of their notes to it being collected)
// plus the price must stay at most STRANGER_EARN_CAP; and each agent buys at most PURCHASES_PER_STRANGER_PER_DAY jobs
// from one stranger in 24 hours (the welcome job included), on at most BUY_TEXT_MAX_BYTES of text.
export const STRANGER_EARN_CAP = 20;
const PURCHASES_PER_STRANGER_PER_DAY = 3, BUY_TEXT_MAX_BYTES = 4000;
// The welcome job sandbox-exact sends every new sandbox_only participant once (design §5.8): text-stats of this text.
const WELCOME_FROM = 'sandbox-exact';
// At most this many welcome jobs are attempted in one tick (the tick's other work is never held up by a burst of joiners).
export const WELCOME_PER_TICK = 3;
export const WELCOME = Object.freeze({title: 'Welcome job: text-stats', price: 3, offer_hours: 24, deliver_hours: 48,
  deliverable: 'the exact text-stats result as JSON (your Valun client can compute it: valun_deliver exact_result=true)',
  text: handle => `Welcome to the Valun sandbox, ${handle}. This text is your first paid job.`});
const welcomeDescription = handle => `Your first paid job in the Valun sandbox: compute the exact text-stats of the text in the block below and deliver the result as JSON. sandbox-exact checks it exactly and pays you 3 PC with a credit note.\n\`\`\`\n${WELCOME.text(handle)}\n\`\`\``;
// poke(): a tick this long after a change to an agent's deal (or an enrollment), so the agents react within about 200 ms.
const POKE_MS = 200;
// The server signer signs only these: bound notes and their prior acknowledgments (997), set-off slots (998) and
// transfer slots (999), for a timestamp at most the tracker's maximum age old and at most SIGN_AHEAD_MS ahead. A prior
// acknowledgment is tracker v3.2's PA (parsePriorAckMessage), every other one an 80-byte note message.
const SIGNED_RESIDUES = Object.freeze([BOUND_NOTE_MS, SETOFF_MS, TRANSFER_MS]), SIGN_AHEAD_MS = 5000;
// Decision D-1 between two of an agent's own credit notes for one deal (the payer's rule; the core keeps it across
// transfers): another prior than an earlier attempt's waits until that attempt's timestamp + 1 h + this margin.
const CLIENT_MARGIN_MS = 120e3, OWN_NOTE_ATTEMPTS = 3;
const RECORDS_FILE = 'sandbox-records.json';
const LIVE_TRANSFER = new Set(['awaiting_owner', 'collecting', 'applying']);
// An error of the sandbox's own (not the core's): `code`, and extra.retry_after_ms when it says when to try again.
const sandboxError = (code, message, retryAfterMs = null) => Object.assign(new Error(message), {code, extra: retryAfterMs ? {retry_after_ms: retryAfterMs} : {}});
const edgeState = n => (n ? {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature} : null);
// The records keep no signature: an attempt's own note signature (withheld until the tracker records it, I-WITHHOLD)
// and the edge state it followed are kept as sha256 of the signature's 65 bytes (as the core's audit lines do), and
// compared as such (comparable: an EdgeState whose signature is that hash; records written with the signature itself
// are read too).
const sigSha256 = sig => (typeof sig === 'string' && sig ? crypto.createHash('sha256').update(Buffer.from(sig, 'hex')).digest('hex') : null);
const keptState = s => (s ? {total: s.total, timestamp: s.timestamp, signature_sha256: sigSha256(s.signature)} : null);
const comparable = k => (k ? {total: k.total, timestamp: k.timestamp, signature: k.signature_sha256 ?? sigSha256(k.signature)} : null);
const attemptSha256 = a => a?.signature_sha256 ?? sigSha256(a?.signature);

// ---------- the services (identical definitions to valun-open/python/src/valun/sandbox.py) ----------
const FENCE = /^```[^\n]*\n([\s\S]*?)\n```/m, LABEL = /(?:^|\n)\s*TEXT\s*:\s*([\s\S]+)$/i;
const QUOTED = /"([^"\n]{1,16000})"|\u201c([^\u201d\n]{1,16000})\u201d/g;
// Python str.split() whitespace and str.splitlines() boundaries, so both implementations count the same way.
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const PY_LINE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;

export function extractText(description = '') {
  const f = FENCE.exec(description);
  if (f) return f[1];
  const l = LABEL.exec(description);
  if (l) return l[1].trim();
  const q = [...description.matchAll(QUOTED)].map(m => m[1] ?? m[2]);
  return q.length === 1 ? q[0] : null;
}
const cmpCodePoints = (a, b) => { const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
  return x.length - y.length; };
export function textStats(text) {
  const words = text.split(PY_SPACE).filter(Boolean), freq = new Map();
  for (const w of words) { const k = w.toLowerCase(); freq.set(k, (freq.get(k) || 0) + 1); }
  const lines = text ? text.split(PY_LINE) : [];
  if (lines.length && lines.at(-1) === '') lines.pop();
  return {words: words.length, characters: [...text].length, lines: lines.length, unique_words: freq.size,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    top_words: [...freq].sort((a, b) => b[1] - a[1] || cmpCodePoints(a[0], b[0])).slice(0, 10).map(([w, n]) => [w, n])};
}
export const notary = text => ({sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8')});
export const COMPUTE = {'text-stats': textStats, notary};
const HOW = {'text-stats': 'Words are runs of non-whitespace characters (Python str.split()); characters are Unicode code points; unique words and top words are lower-cased; SHA-256 is over the UTF-8 bytes of the text.',
  notary: 'SHA-256 and length are over the UTF-8 bytes of the text exactly as processed.'};
export const render = (service, result, text) => `# ${service} result\n\n${HOW[service]}\n\nText processed (exactly, as a JSON string): ${JSON.stringify(text)}\n\n`
  + `The result below is deterministic: anyone can recompute it from that text.\n\n\`\`\`json\n${JSON.stringify(result, null, 1)}\n\`\`\`\n`;
export function whichService(terms) {
  const s = terms?.service || {}, hay = ['title', 'description', 'deliverable'].map(k => String(s[k] || '')).join(' ').toLowerCase();
  return Object.entries(SERVICES).find(([, v]) => v.keywords.some(k => hay.includes(k)))?.[0] ?? null;
}
// Mallory is wrong in about half of its deals, chosen deterministically by the deal id, and always in a checkable way.
export const malloryIsWrong = dealId => crypto.createHash('sha256').update('mallory:' + dealId).digest()[0] % 2 === 0;
export function corrupt(service, result) {
  const r = structuredClone(result);
  if (service === 'text-stats') r.words += 1; else r.bytes += 1;
  return r;
}
// The exact check of a delivery the agents bought (the rule of the Python client's check_delivery): the first ```json
// block of the content must deep-equal COMPUTE[service] of the agreed description's text. Null when it does; else
// {service, field, ...}: the first field that differs, in the order of the computed result and then the delivered
// block's extra fields (extra: true), with the exact value (expected); or field null when the job has no exactly
// checkable result (why: no_exact_job) or the delivery no readable block (why: no_result_block).
export function checkDelivery(terms, content) {
  const service = whichService(terms), text = extractText(String(terms?.service?.description ?? ''));
  if (!service || text == null) return {service, field: null, why: 'no_exact_job'};
  const expected = COMPUTE[service](text), m = /```json\n([\s\S]*?)\n```/.exec(typeof content === 'string' ? content : '');
  let got = null;
  if (m) { try { got = JSON.parse(m[1]); } catch { got = null; } }
  if (!got || typeof got !== 'object' || Array.isArray(got)) return {service, field: null, why: 'no_result_block'};
  for (const k of Object.keys(expected)) if (!Object.hasOwn(got, k) || !isDeepStrictEqual(got[k], expected[k])) return {service, field: k, expected: expected[k]};
  for (const k of Object.keys(got)) if (!Object.hasOwn(expected, k)) return {service, field: k, extra: true};
  return null;
}
// The signed reason of the dispute (never quotes the delivered values: they are the payee's text).
function disputeReason(c) {
  if (c.field === null) return c.why === 'no_result_block'
    ? `The delivery has no \`\`\`json block with the exact ${c.service} result of the agreed text, so it cannot be checked; I do not accept it.`
    : 'This job has no exactly checkable result (a text-stats or notary job with its text in the description); I do not accept the delivery.';
  const name = /^[A-Za-z0-9_]{1,40}$/.test(c.field) ? `"${c.field}"` : 'a field';
  return `The delivered ${c.service} result does not match the exact result of the agreed text: the first field that differs is ${name}`
    + `${c.extra ? ', which the exact result does not have' : typeof c.expected === 'number' ? ` (exactly ${c.expected})` : ''}.`;
}
// An 80-byte Basis note message M(I,R,t,ts) (lib/basis.mjs noteMessage): debt key (32 bytes: the edge) || total (8 bytes,
// big-endian) || timestamp (8) || tracker NFT id (32). {edge, total, timestamp, nft}, or null for anything else.
export function parseNoteMessage(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{160}$/.test(hex)) return null;
  const b = Buffer.from(hex, 'hex'), total = b.readBigUInt64BE(32), ts = b.readBigUInt64BE(40), max = BigInt(Number.MAX_SAFE_INTEGER);
  if (total > max || ts > max) return null;
  return {edge: hex.slice(0, 64), total: Number(total), timestamp: Number(ts), nft: hex.slice(96)};
}
// Tracker v3.2's 105-byte prior acknowledgment PA(I,R,X,p,T) (lib/basis.mjs priorAckMessage): the 17 ASCII bytes
// "basis/prior-ack/1" || debt key (32: the edge) || X, the acknowledged total (8, big-endian) || p, the acknowledged
// note's timestamp (8) || T, the operation's timestamp (8) || tracker NFT id (32). {edge, total: X, prior_timestamp: p,
// timestamp: T, nft}, or null for anything else.
const PRIOR_ACK_TAG_HEX = Buffer.from(PRIOR_ACK, 'ascii').toString('hex');
export function parsePriorAckMessage(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{210}$/.test(hex) || !hex.startsWith(PRIOR_ACK_TAG_HEX)) return null;
  const b = Buffer.from(hex, 'hex'), x = b.readBigUInt64BE(49), p = b.readBigUInt64BE(57), ts = b.readBigUInt64BE(65), max = BigInt(Number.MAX_SAFE_INTEGER);
  if (x > max || p > max || ts > max) return null;
  return {edge: hex.slice(34, 98), total: Number(x), prior_timestamp: Number(p), timestamp: Number(ts), nft: hex.slice(146)};
}
// Writes `text` to `file` atomically (a .tmp file, then a rename), readable by the server's user only. A .tmp left by a
// crash is removed first: writeFileSync applies its mode only to a file it creates, so a stale one would keep wider
// permissions through the rename (or, read-only, make the write fail).
function writePrivate(file, text) {
  const tmp = file + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(tmp, text, {mode: 0o600});
  fs.renameSync(tmp, file);
}
// The server signer's records (sandbox-records.json): null when the file exists but cannot be read (the signer then
// refuses everything, as a client does with records_unreadable).
function loadRecords(file) {
  if (!fs.existsSync(file)) return {version: 1, signed: {}, attempts: {}};
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r?.version !== 1 || !r.signed || typeof r.signed !== 'object' || !r.attempts || typeof r.attempts !== 'object') return null;
    return r;
  } catch { return null; }
}

// ---------- the agents ----------
export class Sandbox {
  constructor(pilot, {dataDir, intervalMs = 4000, log = () => {}, now = () => Date.now()} = {}) {
    this.pilot = pilot; this.file = path.join(dataDir, 'sandbox-keys.json'); this.intervalMs = intervalMs; this.log = log;
    this.keys = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.busy = false; this.timer = null;
    this.now = now;                       // the clock for the per-item backoff and the 24-hour purchase limit (tests may replace it)
    this.backoff = new Map();             // handle -> Map(item key -> {failures, until}): items that failed recently
    // Circulating credit: the server signer's records (signed: '<participant>|<edge debt key>|<timestamp>' -> {op,
    // totals, timestamp, at}, one operation per edge and timestamp; attempts: '<participant>|<deal>' -> the agent's own
    // credit notes signed for the deal, for decision D-1), the poke timer, and the signer the core calls.
    this.recordsFile = path.join(dataDir, RECORDS_FILE);
    this.records = loadRecords(this.recordsFile);
    this.running = false; this.pokeTimer = null; this.again = false; this.mandateMode = null;
    this.onChange = c => this.changed(c);
    this.signer = Object.freeze({has: id => this.signs(id), signFor: (id, hex, o) => this.signFor(id, hex, o), signHex: (id, hex, o) => this.signFor(id, hex, o)});
  }
  // sandbox-keys.json. With circulation off it is written exactly as v15 writes it (a .tmp in the way is written over,
  // not removed first), so that mode off stays v15's; in the circulation modes by writePrivate, as the signer's records.
  save() {
    const text = JSON.stringify(this.keys, null, 1);
    if (this.pilot.mode === 'off') { fs.writeFileSync(this.file + '.tmp', text, {mode: 0o600}); fs.renameSync(this.file + '.tmp', this.file); }
    else writePrivate(this.file, text);
  }
  sign(handle, stmt) { const k = this.keys[handle]; return this.pilot.basis.signHex(k.pubkey, Buffer.from(stmt, 'utf8').toString('hex'), k.secret); }
  participant(handle) { const k = this.keys[handle]; return k && this.pilot.s.participants[k.id]; }
  agentIds() { return new Set(Object.keys(AGENTS).map(h => this.keys[h]?.id).filter(Boolean)); }
  handleOf(id) { return Object.keys(AGENTS).find(h => this.keys[h]?.id === id) ?? null; }

  // Create the participants on first start (invite -> join -> enroll, the same path as anyone), renew their mandates.
  async ensure() {
    const p = this.pilot, circulating = !!p.circulating;
    for (const [handle, a] of Object.entries(AGENTS)) {
      if (!this.participant(handle)) {
        if (Object.values(p.s.participants).some(x => x.handle === handle)) { this.log(`sandbox: handle ${handle} is taken; skipped`); continue; }
        const inv = p.createInvite({note: `sandbox agent ${handle}`, maxUses: 1, ttlDays: 1});
        const j = await p.join({invite: inv.code, handle, operator: OPERATOR, display_name: a.display_name, about: a.about, services: SERVICES_TEXT.slice(0, 300)});
        const key = await p.basis.keygen();
        const codeHash = crypto.createHash('sha256').update(j.enrollment_code).digest('hex');
        const pop = await p.basis.signHex(key.pubkey_hex, Buffer.from(statements.enroll(j.participant_id, key.pubkey_hex, codeHash), 'utf8').toString('hex'), key.secret_hex);
        await p.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop});
        this.keys[handle] = {id: j.participant_id, pubkey: key.pubkey_hex, secret: key.secret_hex, created_at: new Date().toISOString()};
        this.save();
        this.log(`sandbox: created ${handle} (${j.participant_id})`);
      }
      // Apply the sandbox mandate when it is missing, drifted (a new participant starts with every commitment held for
      // its owner, which nobody would ever approve here) or within a week of expiring. With circulating credit on it is
      // the circulation mandate (mandateFor).
      const x = this.participant(handle), m = x?.mandate, target = mandateFor(handle, circulating);
      const drifted = m && Object.entries(target).some(([k, v]) => JSON.stringify(m[k]) !== JSON.stringify(v));
      if (x && (!m?.expires_at || drifted || Date.parse(m.expires_at) - Date.now() < 7 * 864e5))
        p.setMandate(x, {...target, expires_at: new Date(Date.now() + MANDATE_DAYS * 864e5).toISOString()}, {by: 'operator'});
    }
    this.mandateMode = circulating;
  }

  // ---------- the server signer (pilot.serverSigner; circulating credit only) ----------
  // Whether the server signs for participant `id` now: one of these agents, with circulating credit on.
  signs(id) { return !!this.pilot.circulating && this.handleOf(id) !== null; }
  // Signs messageHex with agent `pid`'s key, or throws (the core then answers 503 signer_unavailable; nothing is
  // recorded). Only an 80-byte note message or a 105-byte prior acknowledgment (PA, tracker v3.2) for this pilot's
  // tracker, at residue 997, 998 or 999, with a timestamp no older than the tracker's maximum age and at most 5 s ahead.
  // `op` names the operation (a transfer's or set-off's id, 'note:<deal>' for a bound note and its prior
  // acknowledgment, 'pay:<deal>:...' for a payer's own transfer slots): like a client (rule R4), the agent never signs
  // two operations at the same (edge, timestamp), nor more than two totals there (a prior and a new one), nor prior
  // acknowledgments of two different prior states there. The record is written before the signature is made
  // (write-ahead).
  async signFor(pid, msgHex, {op = null} = {}) {
    const handle = this.handleOf(pid), k = handle && this.keys[handle];
    const no = (code, why) => { throw sandboxError(code, `sandbox signer: ${why}`); };
    if (!k || !this.pilot.circulating) no('not_server_run', 'it signs only for the sandbox agents, and only with circulating credit on');
    if (!this.records) no('records_unreadable', `its records (${RECORDS_FILE}) cannot be read; it signs nothing until they can`);
    const m = parseNoteMessage(msgHex) ?? parsePriorAckMessage(msgHex);
    if (!m) no('not_a_note_message', `it signs only 80-byte Basis note messages and ${PRIOR_ACK} prior acknowledgments`);
    if (m.nft !== this.pilot.basis.nft) no('tracker_mismatch', "the message is not for this pilot's tracker");
    if (!SIGNED_RESIDUES.includes(m.timestamp % 1000)) no('timestamp_domain', `it signs only timestamps ending in ${SIGNED_RESIDUES.join(', ')} ms`);
    const now = this.pilot.now();
    if (m.timestamp > now + SIGN_AHEAD_MS || m.timestamp < now - MAX_AGE_MS) no('timestamp_stale', 'the timestamp is older than the tracker accepts, or ahead of this clock');
    const key = `${pid}|${m.edge}|${m.timestamp}`, label = typeof op === 'string' && op ? op : `msg:${crypto.createHash('sha256').update(msgHex).digest('hex').slice(0, 32)}`;
    const r = this.records.signed[key], ack = m.prior_timestamp === undefined ? null : `${m.total}@${m.prior_timestamp}`;
    if (r && (r.op !== label || (!r.totals.includes(m.total) && r.totals.length >= 2))) no('timestamp_reused', 'another operation was already signed at this edge and timestamp');
    if (r && ack && r.prior_ack && r.prior_ack !== ack) no('timestamp_reused', 'another prior state was already acknowledged at this edge and timestamp');
    this.records.signed[key] = {op: label, totals: r ? [...new Set([...r.totals, m.total])] : [m.total], timestamp: m.timestamp, at: now,
      ...(ack || r?.prior_ack ? {prior_ack: ack ?? r.prior_ack} : {})};
    this.saveRecords();
    return this.pilot.basis.signHex(k.pubkey, msgHex, k.secret);
  }
  // Written atomically after every change, readable by the server's user only (as sandbox-keys.json); signatures that
  // the tracker would refuse by age, and attempts of deals that have ended, are dropped.
  saveRecords() {
    const r = this.records, now = this.pilot.now();
    for (const [k, v] of Object.entries(r.signed)) if (!(v?.timestamp >= now - MAX_AGE_MS - 60e3)) delete r.signed[k];
    for (const [k, list] of Object.entries(r.attempts)) {
      const d = this.pilot.s.deals[k.split('|')[1]];
      if (!d || statusClass(d.status)?.terminal || !Array.isArray(list) || !list.length) delete r.attempts[k];
    }
    writePrivate(this.recordsFile, JSON.stringify(r));
  }

  dealsToday(x, otherId) {
    const since = Date.now() - 864e5;
    return Object.values(this.pilot.s.deals).filter(d => (d.payee === x.id || d.payer === x.id) && (d.payer === otherId || d.payee === otherId)
      && Date.parse(d.created_at || d.versions?.[0]?.created_at || 0) > since).length;
  }
  // Jobs agent x bought from `otherId` in the last 24 hours: deals it pays agreed since then (the welcome job included),
  // and acceptances of its own still waiting for an owner.
  purchasesToday(x, otherId) {
    const since = this.now() - 864e5;
    return Object.values(this.pilot.s.deals).filter(d => d.payer === x.id && d.payee === otherId).filter(d => {
      const at = d.agreement?.formed_at ?? (d.acceptance?.by === x.id && d.acceptance.state === 'awaiting_owner' ? d.acceptance.at : null);
      return !!at && Date.parse(at) > since;
    }).length;
  }
  // A stranger's claims on the sandbox agents: on the tracker, plus deals an agent pays it that are agreed and not paid
  // (excluding deal `excludeDealId`), plus transfers of an agent's notes to it being collected for a deal no agent pays.
  async strangerClaims(sid, excludeDealId = null) {
    const p = this.pilot, ids = this.agentIds(), ledger = await p.ledger();
    const tracker = ledger.filter(l => l.recipient === sid && ids.has(l.issuer)).reduce((a, l) => a + l.outstanding, 0);
    const committed = Object.values(p.s.deals).filter(d => d.payee === sid && ids.has(d.payer) && d.id !== excludeDealId)
      .map(d => p.sweep(d)).filter(d => statusClass(d.status)?.committed).reduce((a, d) => a + p.current(d).terms.price.amount, 0);
    const incoming = Object.values(p.s.transfers || {}).filter(t => t.payee.id === sid && ids.has(t.issuer.id) && !ids.has(t.payer.id) && LIVE_TRANSFER.has(t.state))
      .reduce((a, t) => a + t.amount, 0);
    return tracker + committed + incoming;
  }

  async answer(handle, x, item) {
    const p = this.pilot, d = p.deal(item.deal_id), cur = p.current(d), t = cur.terms, other = d.payer === x.id ? d.payee : d.payer;
    const decline = reason => this.sign(handle, statements.decline(cur.terms_hash, reason))
      .then(signature => p.decline(x, d.id, {terms_hash: cur.terms_hash, reason, signature}));
    if (d.payee !== x.id) {
      // Circulating credit: a stranger selling (mode on: anyone but the sandbox agents; mode sandbox: a sandbox
      // participant). Otherwise, and always with circulating credit off, the agent only sells.
      const seller = p.s.participants[other], circulating = !!p.circulating;
      if (circulating && !this.agentIds().has(other) && p.circulationFor(seller)) return this.buy(handle, x, d, cur, decline);
      return decline((circulating && p.mode === 'sandbox' ? SANDBOX_BUYING : NOT_BUYING) + SERVICES_TEXT.slice(0, 300));
    }
    if (this.dealsToday(x, other) > PER_COUNTERPARTY_PER_DAY) return decline(`Limit reached: at most ${PER_COUNTERPARTY_PER_DAY} deals per counterparty per day. Try again tomorrow.`);
    const service = whichService(t);
    if (!service) return decline('I do not offer that service. ' + SERVICES_TEXT.slice(0, 300));
    const text = extractText(t.service.description);
    if (text == null) return decline('I could not find the text to process. Put it in a ``` fenced block, after a "TEXT:" label at the end, or as the only quoted string in the description.');
    if (Buffer.byteLength(text, 'utf8') > 16000) return decline('The text is longer than 16,000 bytes; send a shorter one.');
    if (t.price.amount < SERVICES[service].price) return decline(`My price for ${service} is ${SERVICES[service].price} PC; offer again at that price.`);
    // The agent's own limit first: an offer above it could never be accepted, so it is declined, not retried.
    const cap = p.effectiveLimits(x).max_accept_per_deal;
    if (t.price.amount > cap) return decline(`Above my limit: I accept at most ${cap} PC per deal. My price for ${service} is ${SERVICES[service].price} PC; offer again at that price.`);
    const signature = await this.sign(handle, statements.accept(cur.terms_hash));
    try { await p.accept(x, d.id, {terms_hash: cur.terms_hash, signature}); }
    catch (e) {
      if (!PERMANENT_REFUSALS.has(e?.code)) throw e;
      this.log(`sandbox: ${handle} declines ${d.id}: acceptance refused (${e.code})`);
      return decline(refusalReason(e));
    }
    this.log(`sandbox: ${handle} accepted ${d.id} (${service}, ${t.price.amount} PC)`);
  }

  // A stranger's offer to sell to agent x (circulating credit): a text-stats or notary job at no more than the list price,
  // with its text (at most 4000 bytes), within the per-stranger limits and the earn cap; otherwise declined with a
  // signed reason.
  async buy(handle, x, d, cur, decline) {
    const p = this.pilot, t = cur.terms, price = t.price.amount, other = d.payee;
    if (this.dealsToday(x, other) > PER_COUNTERPARTY_PER_DAY) return decline(`Limit reached: at most ${PER_COUNTERPARTY_PER_DAY} deals per counterparty per day. Try again tomorrow.`);
    const service = whichService(t);
    if (!service) return decline('I buy only text-stats and notary jobs, whose results I can check exactly (text-stats at most 3 PC, notary at most 2 PC; the text in a ``` block in the description).');
    const list = SERVICES[service].price;
    if (price > list) return decline(`I pay at most ${list} PC for ${service}; offer again at that price.`);
    const text = extractText(t.service.description);
    if (text == null) return decline('I could not find the text to process. Put it in a ``` fenced block, after a "TEXT:" label at the end, or as the only quoted string in the description.');
    if (Buffer.byteLength(text, 'utf8') > BUY_TEXT_MAX_BYTES) return decline(`I buy jobs on at most ${BUY_TEXT_MAX_BYTES} bytes of text; offer again with a shorter one.`);
    const cap = p.effectiveLimits(x).max_issue_per_deal;
    if (price > cap) return decline(`Above my limit: I pay at most ${cap} PC per deal.`);
    if (this.purchasesToday(x, other) >= PURCHASES_PER_STRANGER_PER_DAY) return decline(`Limit reached: I buy at most ${PURCHASES_PER_STRANGER_PER_DAY} jobs from you in 24 hours. Try again tomorrow.`);
    const held = await this.strangerClaims(other, d.id);
    if (held + price > STRANGER_EARN_CAP)
      return decline(`I cannot buy this now: your claims on the sandbox agents (${held} PC, counting purchases agreed and not yet paid) plus ${price} PC would be above the sandbox limit of ${STRANGER_EARN_CAP} PC. Spend some of them first (pay with them), then offer again.`);
    const signature = await this.sign(handle, statements.accept(cur.terms_hash));
    try { await p.accept(x, d.id, {terms_hash: cur.terms_hash, signature}); }
    catch (e) {
      if (!PERMANENT_REFUSALS.has(e?.code)) throw e;
      this.log(`sandbox: ${handle} declines ${d.id}: acceptance refused (${e.code})`);
      return decline(refusalReason(e));
    }
    this.log(`sandbox: ${handle} bought ${d.id} (${service}, ${price} PC)`);
  }

  async deliver(handle, x, item) {
    const p = this.pilot, d = p.deal(item.deal_id), t = d.agreement.terms, service = whichService(t), text = extractText(t.service.description) ?? '';
    let result = COMPUTE[service](text);
    const wrong = AGENTS[handle].wrongOnPurpose && malloryIsWrong(d.id);
    if (wrong) result = corrupt(service, result);
    const content = render(service, result, text), sha = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const signature = await this.sign(handle, statements.deliver(d.agreement.terms_hash, sha));
    await p.deliver(x, d.id, {terms_hash: d.agreement.terms_hash, content, title: `${service} result`, sha256: sha, signature});
    this.log(`sandbox: ${handle} delivered ${d.id}${wrong ? ' (wrong on purpose)' : ''}`);
  }

  // ---------- circulating credit: paying for what the agents bought ----------
  // A deal agent x pays that waits for it (inbox review_delivery): a delivery is checked exactly and paid, or disputed
  // with a signed reason naming the first field that differs; a deal whose delivery stands (note_failed, payment_due) is
  // paid again.
  async review(handle, x, item) {
    const p = this.pilot, d = p.deal(item.deal_id);
    if (d.payer !== x.id || !p.circulating) return NOTHING;
    if (d.status === 'delivered') {
      const wrong = checkDelivery(d.agreement.terms, d.delivery?.content);
      if (wrong) {
        const reason = disputeReason(wrong), h = d.agreement.terms_hash, dh = d.delivery.sha256;
        const signature = await this.sign(handle, statements.dispute(h, dh, reason));
        await p.dispute(x, d.id, {terms_hash: h, deliverable_sha256: dh, signature, reason});
        this.log(`sandbox: ${handle} disputed ${d.id} (${wrong.field ?? wrong.why})`);
        return;
      }
    } else if (d.status !== 'note_failed' && d.status !== 'payment_due') return NOTHING;    // no longer waits for it
    await this.pay(handle, x, d);
  }
  // sandbox-mallory pays with a sandbox-issued note it holds when one qualifies (payByHeldNote); otherwise, always for
  // sandbox-exact, and when the payee is a self-serve sandbox participant that owes another sandbox agent
  // (payeeOwesAnotherAgent), the agent pays with its own bound note (payOwnNote). When a payment by transfer was made and did
  // not apply, decision D-1 decides when another payment may start: the server refuses an own note, and a new transfer
  // through any issuer (the same one included, unless the note is still in the state the attempt acknowledged: the
  // same-prior exemption of tracker v3.2), until then (409 transfer_window_open with retry_after_ms, which the tick
  // waits for; payment options name it as why_not).
  async pay(handle, x, d) {
    const made = this.pilot.transfersOf(d).length;
    try {
      const r = await this.payeeOwesAnotherAgent(d) ? null : await this.payByHeldNote(handle, x, d);
      if (r) { this.log(`sandbox: ${handle} pays ${d.id} with ${r.transfer?.issuer?.handle}'s note (transfer ${r.transfer?.id}: ${r.transfer?.state})`); return; }
    } catch (e) {
      if (this.pilot.transfersOf(d).length !== made) throw e;
      this.log(`sandbox: ${handle} pays ${d.id} with its own note: paying with a held note was refused (${e.code || e.message})`);
    }
    const v = await this.payOwnNote(handle, x, d);
    this.log(`sandbox: ${handle} paid ${d.id} with its own bound note (${v.status})`);
  }
  // The tour's step 4 (design 9.2): the stranger S owes sandbox-exact (S>X, from step 3) and sells sandbox-mallory a
  // job. M's own note makes the cycle M>S>X>M that a set-off clears; a held note of X would only move X's debt to S. So
  // a self-serve sandbox participant that owes a sandbox agent other than the payer is paid with the payer's own note,
  // whatever notes the payer holds (on valun-desk, 2026-11-11, M held 5 PC of X's notes from earlier visitors and every
  // tour's step 4 was paid by transfer). Read from the public ledger (the tracker's notes).
  async payeeOwesAnotherAgent(d) {
    const p = this.pilot;
    if (!p.s.participants[d.payee]?.sandbox_only) return false;
    const ids = this.agentIds();
    return (await p.ledger()).some(l => l.issuer === d.payee && ids.has(l.recipient) && l.recipient !== d.payer && l.outstanding > 0);
  }
  // sandbox-mallory (pay_with_held_notes prefer): a note of another sandbox agent it holds, when payment options say it
  // covers the price, can be spent now (no reason against it), the payee accepts that issuer and is present (its client
  // signs as creditor at once, or the server does). Never again for a deal whose payee refused such a payment. The payer
  // slots are signed by the server signer (op 'pay:<deal>:<T>:<X>:<Y>'). Returns the pay-by-transfer answer, or null.
  // Rule R1 for the server signer: every message it signs is rebuilt here (p.messageHex: its prior slot PA(A,B,X,p_AB,T)
  // of tracker v3.2, its new slots M) from values checked against the deal and the participants (the issuer it picked,
  // its own key, the payee's key, the price, T and the prior states), never taken from the template; the template's
  // messages (for information) must be exactly those.
  async payByHeldNote(handle, x, d) {
    const p = this.pilot;
    if (p.effectiveLimits(x).pay_with_held_notes !== 'prefer' || !p.circulationFor(x)) return null;
    if (p.transfersOf(d).some(t => t.state === 'refused')) return null;
    const opts = await p.paymentOptions(x, d.id), ids = this.agentIds();
    const pick = opts.held_notes.find(h => ids.has(h.issuer.id) && h.issuer.id !== x.id && h.enough && h.payee_accepts && h.why_not === null
      && (h.payee_consents === 'auto' || h.payee_consents === 'immediate'));
    if (!pick) return null;
    const tpl = await p.transferTemplate(x, d.id, pick.issuer.id), terms = d.agreement.terms, issuer = p.s.participants[pick.issuer.id], payee = p.s.participants[d.payee];
    const A = issuer?.pubkey, B = x.pubkey, C = payee?.pubkey, T = tpl.timestamp, a = terms.price.amount;
    const X = tpl.from_edge?.before?.total, Y = tpl.to_edge?.before?.total ?? 0;
    const pX = tpl.from_edge?.before?.timestamp, pY = tpl.to_edge?.before == null ? 0 : tpl.to_edge.before.timestamp;
    const q = A && C ? quoteDigest({network: terms.network, tracker_nft_id: terms.tracker_nft_id, denomination: terms.denomination, deal_id: d.id, terms_hash: d.agreement.terms_hash,
      deliverable_sha256: d.delivery.sha256, issuer_pubkey: A, payer_pubkey: B, payee_pubkey: C, amount: a}) : null;
    const ok = !!q && tpl.issuer?.id === issuer.id && tpl.issuer.pubkey === A && tpl.payer?.pubkey === B && tpl.payee?.id === d.payee && tpl.payee.pubkey === C && tpl.amount === a
      && Number.isSafeInteger(T) && T % 1000 === TRANSFER_MS && Number.isSafeInteger(X) && X >= a && Number.isSafeInteger(Y) && Y >= 0
      && Number.isSafeInteger(pX) && pX > 0 && pX < T && Number.isSafeInteger(pY) && pY >= 0 && pY < T
      && (tpl.from_edge.prior_timestamp == null || tpl.from_edge.prior_timestamp === pX) && (tpl.to_edge.prior_timestamp == null || tpl.to_edge.prior_timestamp === pY)
      && tpl.quote_digest === q && tpl.from_edge.new_total === X - a && tpl.to_edge.new_total === Y + a;
    if (!ok) throw sandboxError('bad_template', 'the transfer template does not describe this payment');
    const AB = `${A}>${B}`, AC = `${A}>${C}`, messages = {};
    const want = {[`${AB}:prior`]: {recipient: B, total: X, prior_timestamp: pX}, [`${AB}:new`]: {recipient: B, total: X - a}, [`${AC}:new`]: {recipient: C, total: Y + a}};
    for (const [k, w] of Object.entries(want)) messages[k] = await p.messageHex({issuer: A, ...w, timestamp: T});
    if (Object.keys(want).some(k => tpl.messages?.[k] !== messages[k])) throw sandboxError('bad_template', 'the transfer template\'s messages are not the ones this payment needs');
    const op = `pay:${d.id}:${T}:${X}:${Y}`, signatures = {};
    for (const k of Object.keys(want)) signatures[k] = await this.signFor(x.id, messages[k], {op});
    return p.payByTransfer(x, d.id, {issuer_id: tpl.issuer.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, quote_digest: q, timestamp: T,
      from_prior_total: X, to_prior_total: Y, from_prior_timestamp: pX, to_prior_timestamp: pY, signatures,
      completion_signature: await this.sign(handle, statements.complete(d.agreement.terms_hash, d.delivery.sha256)),
      pay_signature: await this.sign(handle, circulationStatements.pay(d.id, q))});
  }
  // The agent's own bound credit note (GET credit-note-template?bound=1: the note and the issuer's prior acknowledgment,
  // both signed by the server signer, op 'note:<deal>'), then the completion. Tried again at once (at most three times
  // in all) when the note fails or goes stale, with a new template; a template whose timestamp is ahead (409
  // note_timestamp_ahead) is tried again by the tick after retry_after_ms. Each note is recorded as an attempt before
  // it is posted (write-ahead; its signature's sha256 only) and kept while the deal is unpaid (ownNoteBlock).
  async payOwnNote(handle, x, d) {
    const p = this.pilot;
    for (let attempt = 1; ; attempt++) {
      const tpl = await p.noteTemplate(x, d.id, {bound: true});
      const problem = this.noteTemplateProblem(x, d, tpl);
      if (problem) throw sandboxError('bad_template', `the bound credit-note template does not describe this payment (${problem})`);
      const block = await this.ownNoteBlock(x, d, tpl);
      if (block) {
        if (block.code !== 'transfer_window_open') this.log(`sandbox: ALARM: ${handle} does not pay ${d.id} again: ${block.code} (an earlier credit note of its own may have applied; the operator resolves it)`);
        throw sandboxError(block.code, `an earlier credit note of this agent for ${d.id} ${block.code === 'transfer_window_open' ? 'can still apply' : 'may have applied'}`, block.retry_after_ms ?? BACKOFF_MAX_MS);
      }
      // Rule R1: both messages are rebuilt here from the checked values (the agent's key, the payee's key, the totals, the
      // prior note's timestamp and the timestamp), never taken from the template, whose messages must be exactly these:
      // the note M(I,R,total,ts) and its prior acknowledgment PA(I,R,prior_total,prior_timestamp,ts) (tracker v3.2).
      const payee = p.s.participants[d.payee].pubkey, priorTs = tpl.prior_note ? tpl.prior_note.timestamp : 0;
      const rebuilt = (total, prior_timestamp) => p.messageHex({issuer: x.pubkey, recipient: payee, total, timestamp: tpl.timestamp, prior_timestamp});
      const noteHex = await rebuilt(tpl.total), priorHex = await rebuilt(tpl.prior_total, priorTs);
      if (tpl.message_hex !== noteHex || tpl.prior_message_hex !== priorHex) throw sandboxError('bad_template', 'the bound credit-note template does not describe this payment (message)');
      const op = `note:${d.id}`;
      const note = await this.signFor(x.id, noteHex, {op}), prior = await this.signFor(x.id, priorHex, {op});
      this.recordAttempt(x, d, {edge: `${tpl.issuer_pubkey}>${tpl.recipient_pubkey}`, before: keptState(tpl.prior_note), prior_total: tpl.prior_total, total: tpl.total,
        timestamp: tpl.timestamp, signature_sha256: sigSha256(note)});
      const completion = await this.sign(handle, statements.complete(tpl.terms_hash, tpl.deliverable_sha256));
      let v;
      try {
        v = await p.complete(x, d.id, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: completion,
          credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: note, prior_total: tpl.prior_total, prior_timestamp: priorTs, prior_signature: prior}});
      } catch (e) {
        if (d.credit_note?.note?.signature !== note) this.dropAttempt(x, d, note);        // never recorded: not an attempt
        if (e?.code === 'stale_note' && attempt < OWN_NOTE_ATTEMPTS) continue;
        throw e;
      }
      if (v.status === 'note_issued' || v.status !== 'note_failed') return v;
      if (attempt >= OWN_NOTE_ATTEMPTS) throw sandboxError('note_failed', `the tracker did not record the credit note for ${d.id} (${d.credit_note?.error_code ?? 'refused'})`);
    }
  }
  noteTemplateProblem(x, d, tpl) {
    const p = this.pilot, price = d.agreement.terms.price.amount, note = parseNoteMessage(tpl.message_hex), prior = parsePriorAckMessage(tpl.prior_message_hex);
    const priorTs = tpl.prior_note ? tpl.prior_note.timestamp : 0;
    if (tpl.issuer_pubkey !== x.pubkey || tpl.recipient_pubkey !== p.s.participants[d.payee]?.pubkey) return 'keys';
    if (tpl.price !== price || tpl.total !== tpl.prior_total + price) return 'total';
    if (tpl.timestamp % 1000 !== BOUND_NOTE_MS) return 'timestamp';
    if ((tpl.prior_note?.total ?? 0) !== tpl.prior_total || (tpl.prior_timestamp != null && tpl.prior_timestamp !== priorTs)) return 'prior';
    if (!note || !prior || note.edge !== prior.edge || note.nft !== p.basis.nft || prior.nft !== p.basis.nft || note.total !== tpl.total || prior.total !== tpl.prior_total
      || prior.prior_timestamp !== priorTs || note.timestamp !== tpl.timestamp || prior.timestamp !== tpl.timestamp) return 'message';
    return null;
  }
  // Decision D-1 between two of the agent's own credit notes for deal d (the server keeps it across transfers): every
  // earlier note it signed for the deal is read back on its edge (classifyEdge). One that applied, or may have, stops
  // every automatic payment ({code: already_paid | attempt_outcome_unknown}); one that can still apply allows a new note
  // at once only with the same prior acknowledgment (the same prior total on the same edge: at most one of the two can
  // apply; only this agent's signature lowers its own edge, and on tracker v3.2 PA binds the prior note's timestamp
  // too, so an earlier note on another state of the edge is dead), else only after its timestamp + 1 h + 2 min ({code:
  // transfer_window_open, retry_after_ms}). The clients' rule for a note retry (R11), unchanged. Null: allowed.
  // An earlier note that Valun's own edge journal proves dead (decision D-2 e: the first entry on its edge after its
  // timestamp changed the edge from that note's own prior, for example the agent's next note on the pair for another
  // deal) never stops a payment: it never applied and never can.
  async ownNoteBlock(x, d, tpl) {
    const list = this.records?.attempts?.[`${x.id}|${d.id}`] ?? [], edge = `${tpl.issuer_pubkey}>${tpl.recipient_pubkey}`, now = this.pilot.now(), states = new Map();
    let wait = 0;
    for (const a of list) {
      if (this.pilot.attemptDeadByJournal(a.edge, a.prior_total, a.timestamp)) continue;
      if (!states.has(a.edge)) { const [i, r] = a.edge.split('>'); states.set(a.edge, comparable(edgeState(await this.pilot.basis.note(i, r)))); }
      const c = classifyEdge(states.get(a.edge), comparable(a.before ?? null), {total: a.total, timestamp: a.timestamp, signature: attemptSha256(a)});
      if (c === 'new' || c === 'applied_moved') return {code: 'already_paid'};
      if (c === 'unknown') return {code: 'attempt_outcome_unknown'};
      if (c === 'moved_past' || (a.edge === edge && a.prior_total === tpl.prior_total)) continue;
      const until = a.timestamp + MAX_AGE_MS + CLIENT_MARGIN_MS;
      if (now <= until) wait = Math.max(wait, until - now + 1);
    }
    return wait > 0 ? {code: 'transfer_window_open', retry_after_ms: wait} : null;
  }
  // a: {edge, before (keptState), prior_total, total, timestamp, signature_sha256}.
  recordAttempt(x, d, a) {
    const k = `${x.id}|${d.id}`, list = this.records.attempts[k] ?? [];
    if (!list.some(e => attemptSha256(e) === a.signature_sha256)) list.push({...a, at: new Date(this.pilot.now()).toISOString()});
    this.records.attempts[k] = list; this.saveRecords();
  }
  dropAttempt(x, d, signature) {
    const k = `${x.id}|${d.id}`, sha = sigSha256(signature);
    this.records.attempts[k] = (this.records.attempts[k] ?? []).filter(e => attemptSha256(e) !== sha);
    this.saveRecords();
  }

  // A transfer consent still waiting for agent x (normally the core signed it when the transfer was made, and then the
  // item is not listed: hasUnsigned): every unsigned slot on its edges, each message rebuilt from the item (as a client
  // does: a prior slot is PA(I,R,before.total,before.timestamp,timestamp), (0, 0) for a new edge; a new slot M) and
  // signed by the server signer with the transfer's id as the operation; the core checks the agent's policy again
  // (POST /consents). An item with nothing left to sign is NOTHING (it does not count toward PER_TICK).
  async consent(handle, x, item) {
    const p = this.pilot, signatures = {}, revisions = {};
    for (const e of item.edges) {
      const [I, R] = e.edge.split('>');
      revisions[e.edge] = e.revision;
      for (const slot of e.slots) {
        if (e.signed_by_you.includes(slot)) continue;
        const message_hex = await p.messageHex(slot === 'prior'
          ? {issuer: I, recipient: R, total: e.before?.total ?? 0, prior_timestamp: e.before?.timestamp ?? 0, timestamp: e.timestamp}
          : {issuer: I, recipient: R, total: e.new_total, timestamp: e.timestamp});
        signatures[`${e.edge}:${slot}`] = await this.signFor(x.id, message_hex, {op: item.id});
      }
    }
    if (!Object.keys(signatures).length) return NOTHING;
    const r = await p.submitConsent(x, item.id, {signatures, revisions});
    this.log(`sandbox: ${handle} signed its consent to ${item.id} (${r.state})`);
  }
  // Whether a consent item (as consentsFor lists it for one participant) still has a slot that participant has not
  // signed.
  static hasUnsigned(item) { return Array.isArray(item?.edges) && item.edges.some(e => (e.slots ?? []).some(s => !(e.signed_by_you ?? []).includes(s))); }

  // ---------- circulating credit: the welcome job ----------
  // How much more sandbox-exact (agent x) may still issue under its own max_issue_outstanding, as Pilot.checkMandate
  // counts it: the limit less what it owes on the tracker (debt to dormant participants left out), its agreed purchases
  // not yet paid and its own open offers. 0 when the tracker cannot be read just now.
  async welcomeRoom(x) {
    const p = this.pilot;
    try {
      const ledger = await p.ledger(), e = p.exposure(x, ledger, {asRole: 'payer'});
      const dormant = ledger.filter(l => l.issuer === x.id && p.dormant(p.s.participants[l.recipient])).reduce((s, l) => s + l.outstanding, 0);
      return p.effectiveLimits(x).max_issue_outstanding - (e.total - dormant);
    } catch { return 0; }
  }
  // Active sandbox_only participants whose sandbox time has not ended and who have no welcome job yet.
  welcomeTargets() {
    const p = this.pilot, now = p.now();
    return Object.values(p.s.participants).filter(q => q.sandbox_only && q.status === 'active' && q.pubkey && !q.sandbox_welcome && !(Date.parse(q.sandbox_expires_at) <= now));
  }
  // sandbox-exact offers participant q its welcome job once: X pays 3 PC for the exact text-stats of the welcome text
  // (open 24 h, delivery within 48 h); then q.sandbox_welcome = {deal_id, at}. An offer already made (a crash before the
  // marker was saved) is found again instead of being made twice.
  async welcome(handle, x, q) {
    const p = this.pilot;
    if (q.sandbox_welcome || q.status !== 'active' || !q.pubkey) return NOTHING;
    let id = Object.values(p.s.deals).find(o => o.payer === x.id && o.payee === q.id && o.versions[0]?.by === x.id && o.versions[0]?.terms?.service?.title === WELCOME.title)?.id;
    if (!id) {
      const now = p.now();
      const terms = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: p.basis.nft, denomination: p.basis.denomination, deal_id: 'vd_' + crypto.randomBytes(8).toString('hex'),
        version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'), proposer: x.id, payer: {id: x.id, pubkey: x.pubkey}, payee: {id: q.id, pubkey: q.pubkey},
        service: {title: WELCOME.title, description: welcomeDescription(q.handle), deliverable: WELCOME.deliverable}, price: {amount: WELCOME.price, unit: p.unit},
        consideration: 'credit_note_on_delivery_accepted', deliver_by: new Date(now + WELCOME.deliver_hours * 3600e3).toISOString(),
        offer_expires_at: new Date(now + WELCOME.offer_hours * 3600e3).toISOString()};
      const h = termsHash(terms);
      id = (await p.propose(x, {terms, terms_hash: h, signature: await this.sign(handle, statements.propose(h))})).id;
    }
    await p.serial(async () => { if (!q.sandbox_welcome) { q.sandbox_welcome = {deal_id: id, at: new Date(p.now()).toISOString()}; p.save(); } });
    this.log(`sandbox: ${handle} sent the welcome job ${id} to ${q.handle}`);
  }

  // ---------- the loop ----------
  // What agent x has to do, in tick order, as [method, item, key] (key: what the backoff is kept by). With circulating
  // credit on: consents it still has to sign (normally the core has signed them already, and they are not listed),
  // deliveries to review (as payer), then offers to answer, deliveries to make, and (sandbox-exact) welcome jobs to
  // send. Otherwise only the offers and the deliveries, as before.
  itemsFor(handle, x) {
    const p = this.pilot, box = p.inbox(x), circulating = p.circulating, out = [];
    if (circulating) {
      for (const c of p.consentsFor(x).consents) if (c.kind === 'transfer' && Sandbox.hasUnsigned(c)) out.push(['consent', c, c.id]);
      for (const i of box.review_delivery ?? []) if (i.your_role === 'payer') out.push(['review', i, i.deal_id]);
    }
    for (const i of box.respond ?? []) out.push(['answer', i, i.deal_id]);
    for (const i of box.deliver ?? []) out.push(['deliver', i, i.deal_id]);
    if (circulating && handle === WELCOME_FROM) for (const q of this.welcomeTargets()) out.push(['welcome', q, `welcome:${q.id}`]);
    return out;
  }

  // One pass over the agents' work (itemsFor). Only actions that succeed count toward PER_TICK, and at most
  // MAX_ATTEMPTS_PER_TICK attempts are made; an action that found nothing to do (NOTHING) counts as neither. An item
  // that fails is skipped until its backoff ends (10 s, doubling with each further failure, at most 1 h; or the
  // retry_after_ms its error gives); success clears it, and entries for items no longer listed are dropped. A tick
  // asked for while one runs (poke) runs right after it.
  async tick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      if (this.mandateMode !== !!this.pilot.circulating) await this.ensure();       // the mode changed since the mandates were applied
      let done = 0, attempts = 0;
      for (const handle of Object.keys(AGENTS)) {
        const x = this.participant(handle);
        if (!x || x.status !== 'active') continue;
        const items = this.itemsFor(handle, x);
        const failed = this.backoff.get(handle) ?? new Map(), live = new Set(items.map(([, , key]) => key));
        for (const id of failed.keys()) if (!live.has(id)) failed.delete(id);
        this.backoff.set(handle, failed);
        // Welcome jobs: at most WELCOME_PER_TICK a tick, and none while the room under sandbox-exact's own
        // max_issue_outstanding (welcomeRoom) is below the welcome price: such an offer would only be refused
        // (mandate_exceeded), and many of them would use up the tick. Skipped items wait, without a backoff.
        let room = null, welcomes = 0;
        for (const [kind, item, key] of items) {
          const b = failed.get(key);
          if (b && b.until > this.now()) continue;
          if (done >= PER_TICK || attempts >= MAX_ATTEMPTS_PER_TICK) return;
          if (kind === 'welcome') {
            if (welcomes >= WELCOME_PER_TICK) continue;
            room ??= await this.welcomeRoom(x);
            if (room < WELCOME.price) continue;
            welcomes++;                                   // an attempt, whether it succeeds or fails
          }
          attempts++;
          try {
            const r = await this[kind](handle, x, item);
            failed.delete(key);
            if (r === NOTHING) attempts--; else done++;
            if (kind === 'welcome') { if (r === NOTHING) welcomes--; else room -= WELCOME.price; }
          }
          catch (e) {
            const failures = (b?.failures ?? 0) + 1, wait = e?.extra?.retry_after_ms;
            failed.set(key, {failures, until: this.now() + (Number.isSafeInteger(wait) && wait > 0 ? Math.min(wait, BACKOFF_MAX_MS) : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS))});
            this.log(`sandbox: ${handle} ${kind} ${key}: ${e.code || e.message}`);
          }
        }
      }
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.poke(); }
    }
  }
  // Circulating credit: a change to a deal of one of the agents, or an enrollment of a sandbox participant (its welcome
  // job), asks for a tick (poke).
  changed(c) {
    if (!this.running || !this.pilot.circulating) return;
    const ids = this.agentIds();
    if (c?.deal ? ids.has(c.deal.payer) || ids.has(c.deal.payee) : !!c?.participant?.sandbox_only) this.poke();
  }
  // A tick POKE_MS from now (one per burst of changes); nothing while the loop is stopped or circulating credit is off.
  poke() {
    if (!this.running || !this.pilot.circulating || this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => { this.pokeTimer = null; this.tick().catch(e => this.log(`sandbox: tick failed: ${e.message}`)); }, POKE_MS);
    this.pokeTimer.unref?.();
  }

  async start() {
    await this.ensure();
    // Self-serve sandbox participants (Pilot.joinSandbox) may deal only with these.
    this.pilot.sandboxIds = new Set(Object.keys(AGENTS).map(h => this.keys[h]?.id).filter(Boolean));
    // The server signer for these agents (signs only with circulating credit on), and the changes that poke the loop.
    this.pilot.serverSigner = this.signer;
    this.pilot.changeListeners?.add(this.onChange);
    if (!this.records) this.log(`sandbox: ${RECORDS_FILE} cannot be read; the server signs nothing for the sandbox agents until it can`);
    this.running = true;
    this.timer = setInterval(() => this.tick().catch(e => this.log(`sandbox: tick failed: ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
    this.renew = setInterval(() => this.ensure().catch(e => this.log(`sandbox: ensure failed: ${e.message}`)), 6 * 3600e3);
    this.renew.unref?.();
    return this;
  }
  // Stops the loop (the server signer stays: the core still signs for the agents at apply time).
  stop() {
    this.running = false;
    clearInterval(this.timer); clearInterval(this.renew);
    if (this.pokeTimer) { clearTimeout(this.pokeTimer); this.pokeTimer = null; }
    this.pilot.changeListeners?.delete(this.onChange);
  }
}
