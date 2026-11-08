// The nine Valun agent tools, independent of any agent framework (port of python/src/valun/agent.py).
//
// An adapter supplies a Client (whose store holds the participant's key, token and non-secret state), a few settings and
// a sentence saying where approvals happen; this module does the protocol work: it builds and verifies what is signed
// (through the Client), measures deliveries against the agreed terms, and explains results in plain words. Results,
// error payloads and approval texts are the Python reference's, word for word (test/agent-parity.test.js replays
// scenarios recorded from the Python code). Every tool result is a plain JSON-compatible object.
//
// Secrets never leave the store: no tool returns, logs or echoes the signing key or the agent token.
// Approvals fail closed, as in the Python core. isCommitment() treats every tool name it does not know as a commitment,
// and prepare() returns the arguments to sign with and the owner's approval text from one snapshot of what would be
// signed. The text is built only from values checked against what is signed (recomputed hashes, which the arguments then
// pin); when the snapshot cannot be read or does not hold together it rejects with approval_unbound, and every adapter
// then refuses the call instead of asking with a generic text.

import {ValunError} from './errors.js';
import {measure} from './measure.js';
import {UNIT, sha256Hex, termsHash} from './protocol.js';
import {utf8} from './bytes.js';
import {checkDelivery, extractText} from './sandbox.js';
import * as schemas from './schemas.js';
import {
  PyError, cpLength, cpSlice, dictCopy, get, int, isDict, isoAwareMs, item, items, iterate, lower, or, pyEq, repr, str, strip, truthy,
  typeName,
} from './py.js';

export const SETTLEMENT_NOTE = 'Issuing a credit note creates an outstanding obligation (the payer owes the payee that many PC). '
  + 'Nothing is settled in the Valun pilot: there is no redemption, reserve or clearing yet.';
export const NOT_SETTLED = 'A credit note is an outstanding promise to pay, not a payment: nothing is settled in the pilot. '
  + 'PC are synthetic units with no monetary value.';
export const HONEST_LABELS = Object.freeze({
  what_basis_records: 'When a payer accepts a delivery, its agent signs a Basis note and the pilot Basis tracker '
    + 'records it: the payer key, the payee key, the running total that payer owes that payee '
    + '(one cumulative total per key pair) and a timestamp. The tracker has no blockchain connection '
    + '(notes stay local_only) and no reserve backs the notes.',
  outstanding_promise: 'An issued credit note is an outstanding promise by the payer to pay that many PC. Nothing in '
    + 'the pilot settles it: there is no redemption, reserve, clearing or netting. PC are synthetic '
    + 'pilot units with no monetary value.',
  third_party: 'Supported: paying a third party with your OWN credit note; the third party may require that your '
    + 'claims on the tracker cover it (min_payer_coverage_pct). Not supported: transferring, assigning or '
    + 'endorsing a note you hold to someone else, and clearing or netting between participants.',
});
export const REAL_VS_SIMULATED = Object.freeze({
  real: "signatures by each participant's own key; Valun's acceptance and approval records; credit notes held by a "
    + 'real Basis tracker (read back and reconciled by Valun)',
  simulated: 'PC (pilot credits) have no monetary value; the Basis tracker has no blockchain connection (notes are '
    + 'local_only, never on-chain); settlement does not exist in the pilot',
  not_proven: 'that delivered work is good (Valun records statements, it does not judge work); that any participant '
    + 'will ever honour a credit note',
});
/** valun_set_limits argument -> [server field, kind]. Caps can only be lowered below the owner's mandate, floors raised. */
export const LIMIT_FIELDS = Object.freeze({
  max_per_deal_as_payer: Object.freeze(['max_issue_per_deal', 'cap']), max_total_owed: Object.freeze(['max_issue_outstanding', 'cap']),
  max_per_deal_as_payee: Object.freeze(['max_accept_per_deal', 'cap']), max_claim_per_payer: Object.freeze(['max_accept_per_issuer', 'cap']),
  min_price_as_payee: Object.freeze(['min_price_as_payee', 'floor']), min_payer_coverage_pct: Object.freeze(['min_payer_coverage_pct', 'floor']),
});
export const TOOL_NAMES = Object.freeze(schemas.ALL.map(t => t.name));
export const READ_ONLY_TOOLS = Object.freeze(['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal']);
// The classification every adapter takes from here (fail closed by name): these tools never commit the owner...
export const NOT_COMMITMENT_TOOLS = Object.freeze([...READ_ONLY_TOOLS, 'valun_deliver']);
// ...this one does only when it loosens a limit recorded before...
export const LIMIT_TOOLS = Object.freeze(['valun_set_limits']);
// ...and every other tool signs a commitment for some arguments (a new tool counts until it is classified above).
export const SIGNING_TOOLS = Object.freeze(TOOL_NAMES.filter(n => !NOT_COMMITMENT_TOOLS.includes(n) && !LIMIT_TOOLS.includes(n)));
/** The refusal when what would be signed cannot be read or checked (approval_unbound). */
export const UNBOUND_MESSAGE = 'could not read what you would sign; nothing was signed';
/** The approval text for a tool this client does not know ({name} is the tool name, shown). */
export const GENERIC_TEXT = 'Valun: sign a commitment ({name}).';
/** Per quoted field of an approval text (the server's own limit for service.description). */
export const QUOTE_MAX_CHARS = 2000;
export const ROLE_WORDS = Object.freeze({payer: 'payer', payee: 'payee (you do the work)'});
export const DEFAULT_SETUP_HINT = 'run `valun join` (or `valun enroll`) in a terminal';
/** Where approvals happen, as the Python MCP server and CLI tell the model (python/src/valun/mcp_server.py). */
export const APPROVAL_TEXT = Object.freeze({
  ask: 'Before you sign an offer, counter-offer, acceptance or credit note, your owner is asked through this app and '
    + 'sees exactly what you would sign; if they decline, nothing is signed.',
  'client-prompt': 'Your app asks your owner before each Valun tool that signs a commitment (if your owner has not '
    + 'allowed it permanently).',
  console: 'Every commitment you sign waits for your owner in the Valun owner console before it takes effect: offers, '
    + 'counter-offers and acceptances, and accepting a delivery (its credit note is issued only after your owner '
    + 'approves it).',
  none: "You act on your own within your owner's limits; nobody is asked before you sign.",
});

const DEAL_FIELDS = ['id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement', 'decline',
  'completion', 'dispute', 'cancellation', 'approvals', 'labels'];
const LIMITS_SHOWN = Object.entries(LIMIT_FIELDS);
const PLAIN = /^[A-Za-z0-9_.:@+-]{1,120}$/;
const DEAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LONE_SURROGATE = /\p{Cs}/u;
const TEXT_FIELDS = ['title', 'description', 'deliverable'];

/** Python's isinstance(v, int) and not isinstance(v, bool), for JSON numbers (a safe integer). */
const whole = v => typeof v === 'number' && Number.isSafeInteger(v);

function jsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * Untrusted text (written by a counterparty, or by the agent from what it read) as ONE line of JSON, exactly as Python's
 * json.dumps(value, ensure_ascii=True, separators=(',', ':')) writes it. Newlines, control, bidi and all other non-ASCII
 * characters are escaped, so it can never add, fake or reorder a line of an approval text.
 */
export function quoted(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return repr(value);
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) return '[' + value.map(quoted).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => jsonString(k) + ':' + quoted(v)).join(',') + '}';
  return jsonString(String(value));
}

/**
 * A server-supplied value for a computed line of an approval text: as is when it cannot carry layout (a whole number,
 * or a short id, hash, handle or date), otherwise quoted as JSON.
 */
export function shown(value) {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (whole(value) || (typeof value === 'string' && PLAIN.test(value))) return String(value);
  return quoted(value);
}

/**
 * The last line of an approval text: `label`, then `fields` (text a counterparty or the agent wrote) quoted as ONE JSON
 * line. A text field longer than QUOTE_MAX_CHARS (code points, as Python counts them) is cut to that many, and the label
 * says so.
 */
export function quoteLine(label, fields) {
  const out = {};
  let cut = false;
  for (const [k, value] of Object.entries(fields)) {
    let v = value;
    if (typeof v === 'string' && cpLength(v) > QUOTE_MAX_CHARS) {
      v = cpSlice(v, QUOTE_MAX_CHARS);
      cut = true;
    }
    out[k] = v;
  }
  const note = cut ? `; fields over ${QUOTE_MAX_CHARS} characters are cut to their first ${QUOTE_MAX_CHARS}` : '';
  return `${label} (quoted exactly${note}): ` + quoted(out);
}

/** What a binding deal means for this participant, in the role the signed terms give it. */
export function owes(role, who, price) {
  return role === 'payer' ? `after you accept their delivery you will owe ${who} ${price} PC (your credit note).`
    : `you must deliver; ${who} would then owe you ${price} PC (their credit note).`;
}

/** Map valun_set_limits arguments to the server's /limits body. */
export function limitsBody(args) {
  const body = {};
  for (const [arg, [field]] of LIMITS_SHOWN) {
    if (get(args, arg) !== null) body[field] = int(item(args, arg));
  }
  for (const arg of iterate(or(get(args, 'clear'), []))) {
    if (Array.isArray(arg) || isDict(arg)) throw new PyError('TypeError', `cannot use '${typeName(arg)}' as a dict key (unhashable type: '${typeName(arg)}')`);
    if (typeof arg === 'string' && Object.hasOwn(LIMIT_FIELDS, arg)) body[LIMIT_FIELDS[arg][0]] = null;
  }
  if (get(args, 'goals') !== null) body.notes = str(item(args, 'goals'));
  return body;
}

/**
 * True when a /limits body would loosen a limit the agent recorded before (a higher cap, a lower floor, or removing
 * one). Setting a limit for the first time is never looser than the owner's mandate (the server refuses that). Fails
 * closed: a field this client does not know, a kind of limit it does not know, or a value that is not a whole number
 * counts as loosening. 'notes' (the owner's goals, as text) is not a limit.
 */
export function loosens(current, body) {
  const kinds = Object.fromEntries(Object.values(LIMIT_FIELDS));
  for (const [field, next] of items(body)) {
    if (field === 'notes') continue;
    const kind = Object.hasOwn(kinds, field) ? kinds[field] : null;
    if (kind !== 'cap' && kind !== 'floor') return true;
    const old = get(current, field) ?? null;
    if (old === null) continue;
    if (next === null || next === undefined || !(whole(next) && whole(old)) || (kind === 'cap' && next > old) || (kind === 'floor' && next < old)) {
      return true;
    }
  }
  return false;
}

/**
 * Has this participant's agent made a call to Valun within the last `hours`? A participant that joined within that
 * window counts as active even before its agent's first call (it is new, not idle). Times without a UTC offset, or
 * not ISO 8601, count as not recent (as in Python, where comparing them fails).
 */
export function recentlyActive(lastSeen, hours = 24, joinedAt = null, nowMs = Date.now()) {
  const within = iso => {
    const t = isoAwareMs(str(iso).replaceAll('Z', '+00:00'));
    return t !== null && nowMs - t < hours * 3_600_000;
  };
  return within(lastSeen) || within(joinedAt);
}

/** The agreed (or current) service text: where numeric requirements such as '300-500 words' are written. */
export function termsText(d) {
  const t = or(get(or(get(or(get(d, 'current'), {}), 'terms'), {}), 'service'), {});
  return TEXT_FIELDS.map(k => str(or(get(t, k), ''))).join(' ');
}

function isValunError(e) {
  return e instanceof ValunError || (e instanceof Error && e.name === 'ValunError' && typeof e.code === 'string');
}

/** Python's canonical() refuses what is not a whole number among the terms' numbers: ValunError bad_terms ('float'). */
function pyTermsHash(t) {
  const walk = v => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new ValunError('bad_terms', 'unsupported value in terms: float');
    if (Array.isArray(v)) v.forEach(walk);
    else if (isDict(v)) Object.values(v).forEach(walk);
  };
  walk(t);
  return termsHash(t);
}

/** sha256 of the UTF-8 text, refusing a lone surrogate as Python's str.encode('utf-8') does. */
function pySha256(s) {
  if (LONE_SURROGATE.test(s)) throw new PyError('UnicodeEncodeError', "'utf-8' codec can't encode a surrogate: surrogates not allowed");
  return sha256Hex(s);
}

/** A ValunError (or any exception) as a plain object an agent can act on. Never includes secrets. */
export function errorPayload(e, setupHint = DEFAULT_SETUP_HINT) {
  if (isValunError(e)) {
    const out = {error: e.code, message: e.message};
    const extra = isDict(e.extra) ? e.extra : {};
    for (const k of ['rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means']) {
      if (Object.hasOwn(extra, k)) out[k] = extra[k];
    }
    if (e.code === 'approval_unbound') {
      out.what_this_means = 'Nothing was signed and your owner was not asked: your Valun client could not read and check '
        + 'exactly what this call would sign (the deal, offer or delivery could not be read, does not '
        + 'match its hash, or changed after you read it). Read the deal again with valun_deal and retry; '
        + 'if it keeps failing, tell your owner.';
    }
    if (e.code === 'tracker_mismatch') {
      out.what_this_means = 'The Valun server now names a different Basis tracker or unit than the one this profile was '
        + 'set up with. Nothing was signed. Stop and tell your owner.';
    }
    if (e.code === 'bad_delivery_signature') {
      out.what_this_means = "The delivery is not signed by the payee's key, so it may not come from the payee. Nothing "
        + 'was signed. Do not accept it; tell your owner.';
    }
    if (e.code === 'records_unreadable') {
      out.what_this_means = 'Your Valun client cannot read its own records, so it signs nothing until they are fixed. '
        + 'Nothing was signed. Tell your owner.';
    }
    if (e.code === 'already_paid') {
      out.what_this_means = 'Your earlier credit note for this deal is (or may already be) on the tracker, so the deal '
        + 'counts as paid. Nothing was signed. Do not try to pay it again; tell your owner.';
    }
    if (e.code === 'mandate_exceeded') {
      out.what_this_means = "Your owner's mandate does not allow this. Nothing was recorded. Do not try to work around "
        + 'it; tell your owner if you think the limit should change.';
    }
    if (e.code === 'offer_not_authorized') {
      out.what_this_means = "The other side's owner no longer allows this offer (their mandate changed or is used up). "
        + 'Nothing was recorded. You may decline it or wait for a new offer.';
    }
    if (e.code === 'key_changed' || e.code === 'payee_no_key') {
      out.what_this_means = "A party's agent key was revoked or replaced by its owner. Offers that name the old key can "
        + 'no longer be agreed; agreed deals continue once the party has a new key.';
    }
    if (['unauthorized', 'not_connected', 'not_configured'].includes(e.code)) {
      out.what_this_means = `This agent is not connected to Valun. Its owner must ${setupHint}.`;
    }
    if (e.code === 'owner_declined') out.what_this_means = 'Your owner did not approve this commitment. Nothing was signed or sent.';
    return out;
  }
  if (e instanceof Error) return {error: 'internal_error', message: `${e.name}: ${e.message}`};
  return {error: 'internal_error', message: `Error: ${String(e)}`};
}
/**
 * The nine Valun tools over one participant's Client.
 *
 * options:
 *   approvals       one sentence telling the model where commitments are approved (adapter-specific; APPROVAL_TEXT has
 *                   the Python adapters' sentences). valunTools() fills it in when it is empty.
 *   checkLinkHosts  look up link host names when measuring deliveries (default true; no page is fetched). Needs
 *                   resolveHost; without one the measurement says the hosts were not checked.
 *   resolveHost     async host => 'public' | 'private' | 'not_found' (Node: resolveHost from "@fitzdoud/valun/dns").
 *   hostTimeoutMs   how long all host lookups of one measurement may take together (default 4000, as in Python).
 *   setupHint       what the owner must do to connect the agent (default: run `valun join` (or `valun enroll`) ...).
 *   now             clock in ms (test hook; the Client has its own).
 */
export class ValunAgent {
  #client;
  #now;

  constructor(client, options = {}) {
    if (!client || typeof client.deal !== 'function' || typeof client.complete !== 'function') {
      throw new TypeError('ValunAgent needs a valun Client');
    }
    const {approvals = '', checkLinkHosts = true, resolveHost = null, hostTimeoutMs = 4000, setupHint = null, now = null} = options;
    if (resolveHost !== null && typeof resolveHost !== 'function') throw new TypeError('resolveHost must be a function');
    this.#client = client;
    this.#now = now || (() => Date.now());
    this.approvals = approvals;
    this.checkLinkHosts = checkLinkHosts;
    this.resolveHost = resolveHost;
    this.hostTimeoutMs = hostTimeoutMs;
    this.setupHint = setupHint || DEFAULT_SETUP_HINT;
    this.handlers = Object.freeze({
      valun_status: a => this.status(a), valun_directory: a => this.directory(a), valun_inbox: a => this.inbox(a),
      valun_deal: a => this.deal(a), valun_propose: a => this.propose(a), valun_respond: a => this.respond(a),
      valun_deliver: a => this.deliver(a), valun_review_delivery: a => this.review(a), valun_set_limits: a => this.setLimits(a),
    });
  }

  // ---------- plumbing ----------
  /** The Client, after checking that it is enrolled (not_connected otherwise). */
  client(requireConnection = true) {
    const c = this.#client;
    if (requireConnection && (!c.connected || !c.participantId)) {
      throw new ValunError('not_connected', `not enrolled: the owner must ${this.setupHint}`);
    }
    return c;
  }

  /** Run one tool. Resolves to a plain object; rejects with a ValunError (use errorPayload to turn it into a result). */
  async call(name, args = null) {
    if (typeof name !== 'string' || !Object.hasOwn(this.handlers, name)) {
      throw new ValunError('unknown_tool', `no Valun tool called ${repr(name)}`);
    }
    return this.handlers[name](truthy(args) ? args : {});
  }

  /** Like call(), but never rejects: errors come back as {error: ...}. */
  async callSafe(name, args = null) {
    try {
      return await this.call(name, args);
    } catch (e) {
      return errorPayload(e, this.setupHint);
    }
  }

  #measureOptions(checkHosts) {
    return {checkHosts, resolveHost: this.resolveHost, timeoutMs: this.hostTimeoutMs};
  }

  async #resolve(c, who) {
    who = lower(strip(or(who, '')));
    for (const p of iterate(await c.directory())) {
      if (item(p, 'id') === who || item(p, 'handle') === who) return p;
    }
    throw new ValunError('unknown_participant', `no participant called ${repr(who)}; use valun_directory`);
  }

  // ---------- approvals ----------
  /**
   * Does this call sign something that commits the owner (or loosen a limit)? Adapters ask the owner first. Fails closed
   * by name and by value: only these are not commitments: the read-only tools, valun_deliver, valun_respond with action
   * exactly 'decline' or 'withdraw', valun_review_delivery with decision exactly 'dispute', and valun_set_limits calls
   * that do not loosen a recorded limit. Every other call, including any tool name this client does not know and a
   * misspelt "Accept", is a commitment.
   */
  async isCommitment(name, args = null) {
    const a = isDict(args) ? args : {};
    if (LIMIT_TOOLS.includes(name)) {
      try {
        const me = await this.client().me();
        return loosens(or(get(me, 'agent_limits'), {}), limitsBody(args));
      } catch {
        return true;    // when in doubt, ask the owner
      }
    }
    return ValunAgent.#mayCommit(name, a);
  }

  /** The classification without any read: false only for calls that can never commit the owner. */
  static #mayCommit(name, a) {
    if (NOT_COMMITMENT_TOOLS.includes(name)) return false;
    if (name === 'valun_respond') return !['decline', 'withdraw'].includes(get(a, 'action'));
    if (name === 'valun_review_delivery') return get(a, 'decision') !== 'dispute';
    return true;
  }

  /**
   * Bind and describe a commitment from ONE snapshot of what it would sign. Resolves to {args, text}: the arguments to
   * sign with and the owner's approval text. Adapters ask the owner with `text`, then call the tool with exactly `args`.
   * text is null for a call that commits nothing (also a valun_set_limits call that this snapshot shows loosens
   * nothing): it runs without asking.
   *
   * The text is built only from values checked against what is signed. An acceptance or counter-offer: the terms shown
   * hash to the stated terms hash, are this deal's, name this participant as exactly one party and were offered by the
   * other one, and the server's role and counterparty for the deal agree with them. A delivery acceptance: the same, and
   * the agreement has that terms hash and the delivered text hashes to its sha256. The recomputed hashes are pinned in
   * `args` (expected_terms_hash; for a delivery also expected_deliverable_sha256); the client reads the deal again when
   * it signs and refuses anything else (stale_terms, stale_delivery). A new offer is pinned to the participant id the
   * text shows. So the signature covers what the owner saw.
   *
   * Rejects with ValunError('approval_unbound') when what would be signed cannot be read or checked (any error, a missing
   * or wrong hash, or a pin the agent passed that is not the snapshot's): the adapter must then refuse the call. A tool
   * this client does not know gets a generic text; a known commitment never does.
   */
  async prepare(name, args = null) {
    const a = isDict(args) ? dictCopy(args) : {};
    if (Array.isArray(name) || isDict(name)) throw new PyError('TypeError', `unhashable type: '${typeName(name)}'`);
    if (typeof name !== 'string' || !Object.hasOwn(this.handlers, name)) {
      return {args: a, text: GENERIC_TEXT.replace('{name}', () => shown(name))};
    }
    if (!ValunAgent.#mayCommit(name, a)) return {args: a, text: null};
    let bound, text;
    try {
      if (args !== null && args !== undefined && !isDict(args)) throw new ValunError('bad_arguments', 'the arguments are not a JSON object');
      const render = this.#textFor(name, a);          // before any read: a misspelt action or decision has no text
      const snap = await this.#snapshot(name, a);
      if (LIMIT_TOOLS.includes(name) && !loosens(or(get(snap.me, 'agent_limits'), {}), limitsBody(a))) {
        return {args: a, text: null};                 // this read shows nothing loosened: nothing to approve
      }
      bound = ValunAgent.#bindFrom(name, a, snap, true);
      text = await render(bound, snap);
    } catch (e) {                                     // nothing may be approved that could not be read and checked
      throw ValunAgent.#unbound(e);
    }
    return {args: bound, text};
  }

  /**
   * For adapters: [prepared, null], or [null, refusal]. Ask the owner with prepared.text, then sign with prepared.args;
   * when prepared.text is null the call commits nothing and runs without asking. The refusal is the result to return
   * instead of asking when what would be signed cannot be read or checked: the owner is then never asked with a generic
   * text, and nothing is signed (approval_unbound).
   */
  async prepareOrRefusal(name, args = null) {
    let prepared;
    try {
      prepared = await this.prepare(name, args);
    } catch {
      prepared = null;                                // whatever went wrong, the answer is the same refusal
    }
    if (isDict(prepared) && isDict(prepared.args)
        && ((prepared.text ?? null) === null || (typeof prepared.text === 'string' && prepared.text))) {
      return [prepared, null];
    }
    return [null, errorPayload(new ValunError('approval_unbound', UNBOUND_MESSAGE), this.setupHint)];
  }

  /**
   * prepare()'s pins alone, for adapters that ask with their own text (kept for compatibility): an acceptance or
   * counter-offer is pinned to the recomputed hash of the terms shown, a delivery acceptance also to the recomputed hash
   * of the delivered text, each checked as prepare() checks it. Pins the agent passed are kept (the client refuses to
   * sign anything else). For a commitment it never resolves to the arguments unpinned: when the deal cannot be read or
   * checked it rejects with ValunError('approval_unbound').
   */
  async bind(name, args = null) {
    const a = isDict(args) ? dictCopy(args) : {};
    if (!ValunAgent.#needsPins(name, a)) return a;
    try {
      return ValunAgent.#bindFrom(name, a, await this.#snapshot(name, a), false);
    } catch (e) {
      throw ValunAgent.#unbound(e);
    }
  }

  /**
   * Text for an approval prompt: exactly what the agent is about to sign, and what it means (prepare() gives it together
   * with the arguments it binds). Rejects with ValunError('approval_unbound') for a known commitment it cannot read and
   * check: it never falls back to a generic text. null for a call that is not a commitment.
   */
  async describeCommitment(name, args = null) {
    return (await this.prepare(name, args)).text;
  }

  static #unbound(e) {
    const cause = isValunError(e) ? e.code : (e instanceof Error ? e.name : typeName(e));
    return new ValunError('approval_unbound', UNBOUND_MESSAGE, undefined, {cause});
  }

  static #needsPins(name, a) {
    if (name === 'valun_respond' && ['accept', 'counter'].includes(get(a, 'action'))) return !truthy(get(a, 'expected_terms_hash'));
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') {
      return !(truthy(get(a, 'expected_deliverable_sha256')) && truthy(get(a, 'expected_terms_hash')));
    }
    return false;
  }

  /** The one read an approval is bound to and described from (checked: see prepare). */
  async #snapshot(name, a) {
    const c = this.client();
    if (name === 'valun_propose') {
      const other = await this.#resolve(c, get(a, 'counterparty'));
      if (!(isDict(other) && typeof get(other, 'id') === 'string' && other.id)) {
        throw new ValunError('approval_unbound', 'the directory names no participant id');
      }
      return {counterparty: other};
    }
    if (name === 'valun_set_limits') {
      const me = await c.me();
      if (!isDict(me)) throw new ValunError('approval_unbound', 'the server sent no participant record');
      return {me};
    }
    const did = get(a, 'deal_id');
    if (!(typeof did === 'string' && DEAL_ID.test(did))) throw new ValunError('bad_arguments', 'deal_id is missing or malformed');
    const d = await c.deal(did);
    if (!isDict(d)) throw new ValunError('approval_unbound', 'the deal could not be read');
    return {deal: d, checked: ValunAgent.#checked(d, did, c.participantId, name === 'valun_review_delivery')};
  }

  /**
   * The values an approval text is built from, each checked against what the call signs (prepare). Throws ValunError
   * when the deal as shown does not hold together.
   */
  static #checked(d, did, me, delivery = false) {
    const cur = get(d, 'current');
    if (!isDict(cur) || !truthy(cur)) throw new ValunError('no_offer', 'this deal has no visible offer');
    const t = get(cur, 'terms');
    if (!isDict(t)) throw new ValunError('approval_unbound', 'the offer shows no terms');
    const h = pyTermsHash(t);
    if (get(cur, 'terms_hash') !== h) throw new ValunError('hash_mismatch', 'the terms shown do not hash to the stated terms hash');
    if (get(t, 'deal_id') !== did) throw new ValunError('deal_mismatch', 'the terms shown are for another deal');
    const ids = Object.fromEntries(['payer', 'payee'].map(r => [r, isDict(get(t, r)) ? get(t[r], 'id') : null]));
    const mine = Object.entries(ids).filter(([, pid]) => typeof me === 'string' && me && pid === me).map(([r]) => r);
    if (mine.length !== 1) throw new ValunError('not_a_party', 'the terms do not name you as exactly one of the two parties');
    const role = mine[0];
    const other = ids[role === 'payer' ? 'payee' : 'payer'];
    if (!(typeof other === 'string' && other)) throw new ValunError('not_a_party', 'the terms name no other party');
    const yourRole = get(d, 'your_role') ?? null;
    if (yourRole !== null && yourRole !== role) {
      throw new ValunError('role_mismatch', `the server says you are the ${shown(yourRole)}; the terms make you the ${role}`);
    }
    const cp = isDict(get(d, 'counterparty')) ? d.counterparty : {};
    const cpId = get(cp, 'id') ?? null;
    if (cpId !== null && cpId !== other) throw new ValunError('counterparty_mismatch', "the server's counterparty is not the other party in the terms");
    const price = get(t, 'price');
    if (!(isDict(price) && whole(get(price, 'amount')) && get(price, 'unit') === UNIT)) {
      throw new ValunError('bad_terms', 'the price is not a whole number of PC');
    }
    const out = {terms: t, terms_hash: h, role, other_id: other, handle: get(cp, 'handle'), price: price.amount,
      service: isDict(get(t, 'service')) ? t.service : {}};
    if (!delivery) {
      if (get(t, 'proposer') !== other) throw new ValunError('own_offer', "the current offer is not the other party's: only they can be answered");
      return out;
    }
    if (role !== 'payer') throw new ValunError('not_payer', 'only the payer accepts a delivery');
    const ag = get(d, 'agreement');
    if (!isDict(ag) || get(ag, 'terms_hash') !== h) throw new ValunError('hash_mismatch', "the agreement's terms hash is not the hash of the terms shown");
    const dl = get(d, 'delivery');
    if (!isDict(dl) || !truthy(dl)) throw new ValunError('not_delivered', 'nothing has been delivered on this deal');
    const content = get(dl, 'content');
    if (typeof content !== 'string') throw new ValunError('approval_unbound', 'the delivery shows no text');
    const sha = pySha256(content);
    if (get(dl, 'sha256') !== sha) throw new ValunError('hash_mismatch', 'the delivered content does not match its sha256');
    return {...out, delivery: dl, content, sha256: sha};
  }

  /**
   * The arguments to sign with: the agent's, plus the pins taken from the checked snapshot. With strict (prepare) a pin
   * the agent passed must be the snapshot's: the text describes the snapshot, so the call may sign nothing else.
   */
  static #bindFrom(name, a0, snap, strict) {
    const a = dictCopy(a0);
    const chk = or(snap.checked ?? null, {});
    const pin = (key, value, code, why) => {
      if (!truthy(get(a, key))) a[key] = value;
      else if (strict && !pyEq(a[key], value)) throw new ValunError(code, why);
    };
    if (name === 'valun_respond' && ['accept', 'counter'].includes(get(a, 'action'))) {
      pin('expected_terms_hash', item(chk, 'terms_hash'), 'stale_terms', 'the offer changed after your agent read it');
    } else if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') {
      pin('expected_deliverable_sha256', item(chk, 'sha256'), 'stale_delivery', 'the delivery changed after your agent read it');
      pin('expected_terms_hash', item(chk, 'terms_hash'), 'stale_terms', 'the agreed terms are not the ones your agent read');
    } else if (name === 'valun_propose' && Object.hasOwn(snap, 'counterparty')) {
      a.counterparty = snap.counterparty.id;          // the offer is signed for exactly the participant shown
    }
    return a;
  }

  /** The approval text builder for this call: (args, snapshot) => text. */
  #textFor(name, a) {
    if (name === 'valun_set_limits') return (b, s) => this.#textLimits(b, s);
    if (name === 'valun_propose') return (b, s) => this.#textPropose(b, s);
    if (name === 'valun_respond' && get(a, 'action') === 'accept') return (b, s) => this.#textAccept(b, s);
    if (name === 'valun_respond' && get(a, 'action') === 'counter') return (b, s) => this.#textCounter(b, s);
    if (name === 'valun_review_delivery' && get(a, 'decision') === 'accept') return (b, s) => this.#textReview(b, s);
    throw new ValunError('approval_unbound', `no approval text for ${name} with these arguments`);
  }

  // The texts: computed lines first (values the client computed or checked against what is signed, shown so that they
  // cannot carry layout), then text written by a counterparty or by the agent, quoted as one JSON line (quoteLine).
  #who(chk) {
    const h = chk.handle;
    return typeof h === 'string' && h ? shown(h) : shown(chk.other_id);
  }

  #textLimits(a, snap) {
    const me = snap.me;
    const mandate = get(me, 'mandate');
    if (!isDict(mandate)) throw new ValunError('approval_unbound', 'the server sent no owner mandate');
    const cur = or(get(me, 'agent_limits'), {}), body = limitsBody(a);
    const names = Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [field, arg]));
    const lines = ['Valun - LOOSEN limits recorded from your instructions (the Valun server enforces them):'];
    for (const [field, next] of Object.entries(body)) {
      if (Object.hasOwn(names, field)) {
        lines.push(`  ${names[field]}: ${shown(get(cur, field, get(mandate, field)))} -> `
          + `${next !== null ? shown(next) : 'removed'} (your owner mandate: ${shown(get(mandate, field))})`);
      }
    }
    lines.push('Approve only if you asked your agent for this.');
    if (Object.hasOwn(body, 'notes')) lines.push('Goals written by your agent (quoted exactly): ' + quoted(body.notes));
    return lines.join('\n');
  }

  #textPropose(a, snap) {
    const other = snap.counterparty;
    const role = get(a, 'role');
    if (role !== 'payer' && role !== 'payee') throw new ValunError('bad_role', 'role must be payer or payee');
    const price = int(item(a, 'price')), due = int(or(get(a, 'deliver_within_hours'), 48)), ttl = int(or(get(a, 'offer_valid_hours'), 24));
    const who = shown(get(other, 'handle'));
    return [
      `Valun - sign a NEW OFFER to ${who} (${shown(item(other, 'id'))}):`,
      `  you are the ${ROLE_WORDS[role]}; price: ${price} PC`,
      `  deliver within ${due} h; the offer stays open ${ttl} h`,
      `If ${who} accepts, the deal is binding without asking you again: ` + owes(role, who, price),
      NOT_SETTLED,
      quoteLine('Offer text written by your agent', Object.fromEntries(TEXT_FIELDS.map(k => [k, get(a, k)])))].join('\n');
  }

  #textAccept(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service;
    return [
      `Valun - ACCEPT ${who}'s offer (${shown(chk.other_id)}, deal ${shown(t.deal_id)}, version ${shown(get(t, 'version'))}):`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${price} PC; deliver by ${shown(get(t, 'deliver_by'))}`,
      `  terms hash ${chk.terms_hash.slice(0, 16)}... (recomputed from these terms; your Valun client checks it again before signing)`,
      'This makes the deal binding on both sides: ' + owes(chk.role, who, price),
      NOT_SETTLED,
      quoteLine(`Offer text written by ${who}`, Object.fromEntries(TEXT_FIELDS.map(k => [k, get(svc, k)])))].join('\n');
  }

  #textCounter(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), old = chk.price, svc = chk.service;
    // Exactly what Client.counter() signs: these arguments, and the rest copied from the terms pinned by hash.
    const price = get(a, 'price') !== null ? int(item(a, 'price')) : old;
    const hours = get(a, 'deliver_within_hours');
    if (hours !== null && !whole(hours)) throw new ValunError('bad_arguments', 'deliver_within_hours must be a whole number of hours');
    const texts = TEXT_FIELDS.filter(k => truthy(get(a, k)));
    const changes = [...(get(a, 'price') !== null ? [`price ${old} -> ${price} PC`] : []),
      ...(hours !== null ? [`deliver within ${hours} h`] : []), ...texts.map(k => `${k} (quoted below)`)];
    return [
      `Valun - sign a COUNTER-OFFER to ${who} (${shown(chk.other_id)}, deal ${shown(t.deal_id)}), `
        + `replacing their version ${shown(get(t, 'version'))}:`,
      `  you are the ${ROLE_WORDS[chk.role]}; price: ${price} PC`,
      '  deliver ' + (hours !== null ? `within ${hours} h of signing`
        : `by ${shown(get(t, 'deliver_by'))} as in their offer (rounded down to the hour, at least 1 h after signing)`),
      '  your agent changes: ' + (changes.join(', ') || 'nothing') + '; the counter-offer stays open 24 h',
      `If ${who} accepts it, the deal is binding without asking you again: ` + owes(chk.role, who, price),
      NOT_SETTLED,
      quoteLine(`Counter-offer text, with what your agent did not change copied from ${who}'s offer`,
        Object.fromEntries(TEXT_FIELDS.map(k => [k, truthy(get(a, k)) ? item(a, k) : get(svc, k)])))].join('\n');
  }

  async #textReview(a, snap) {
    const chk = snap.checked;
    const t = chk.terms, who = this.#who(chk), price = chk.price, svc = chk.service, dl = chk.delivery, content = chk.content;
    const m = await measure(content, TEXT_FIELDS.map(k => str(or(get(svc, k), ''))).join(' '), {checkHosts: false});
    const facts = m.checks_against_agreed_terms.map(x => `${x.requirement}: ${x.measured} (${x.met ? 'met' : 'NOT met'})`);
    let exact;
    try {
      exact = checkDelivery(t, content);
    } catch {                                         // a malformed result block is a fact to show, not a reason to hide the prompt
      exact = null;
      facts.push('exact result: could not be checked');
    }
    if (truthy(exact) && truthy(get(exact, 'checked'))) {
      facts.push('exact result: ' + (truthy(get(exact, 'exact_result_matches')) ? 'matches the agreed text'
        : 'DOES NOT MATCH (differs in ' + iterate(or(get(exact, 'differs_in'), [])).map(k => shown(k)).join(', ') + ')'));
    }
    return [
      `Valun - ACCEPT ${who}'s delivery (${shown(chk.other_id)}, deal ${shown(t.deal_id)}) and ISSUE A CREDIT NOTE `
        + `of ${price} PC to ${who}:`,
      `  delivered: ${utf8(content).length} bytes, sha256 ${chk.sha256.slice(0, 16)}... (recomputed from the text measured here)`,
      '  measured: ' + (facts.join('; ') || `${m.word_count} words, ${m.links.length} links`),
      `  agreed terms hash ${chk.terms_hash.slice(0, 16)}... (your Valun client checks both hashes again before signing)`,
      `Your agent signs a Basis note; the pilot tracker then records that you owe ${who} ${price} PC more.`,
      NOT_SETTLED,
      quoteLine('Delivery title and agreed service text', {delivery_title: or(get(dl, 'title'), ''), title: get(svc, 'title'),
        deliverable: get(svc, 'deliverable')})].join('\n');
  }

  // ---------- tools ----------
  async status() {
    const c = this.client();
    const me = await c.me(), info = await c.info();
    const recorded = or(get(me, 'agent_limits'), {});
    let approvals = or(this.approvals, 'Commitments are signed without asking your owner first.');
    approvals += ` The server also holds commitments priced above ${str(get(item(me, 'mandate'), 'approve_above'))} PC for the owner console.`;
    const inForce = or(get(me, 'effective_limits'), item(me, 'mandate'));
    return {
      connected: true, server: item(c.state, 'server'), network: item(info, 'network'),
      unit: item(info, 'unit') + ' (pilot credits, no monetary value)',
      you: item(me, 'participant'), objective_from_your_owner: or(get(item(me, 'mandate'), 'objective'), '(none set)'),
      goals_your_owner_told_you: or(get(recorded, 'notes'), '(none recorded yet: ask your owner, then use valun_set_limits)'),
      limits_you_recorded: Object.fromEntries(items(recorded).filter(([k]) => k !== 'notes' && k !== 'set_at')),
      limits_in_force: Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [arg, get(inForce, field)])),
      mandate: Object.fromEntries(items(item(me, 'mandate')).filter(([k]) => k !== 'objective')), mandate_version: item(me, 'mandate_version'),
      approvals, position: item(me, 'position'), authority: item(me, 'authority'), settlement: SETTLEMENT_NOTE,
      honest_labels: {...HONEST_LABELS}, real_vs_simulated: {...REAL_VS_SIMULATED},
    };
  }

  async setLimits(a) {
    const c = this.client();
    const body = limitsBody(a);
    if (!truthy(body)) throw new ValunError('nothing_to_record', "give at least one limit, a limit to clear, or your owner's goals");
    const r = await c.setLimits(body);
    const eff = or(get(r, 'effective_limits'), {});
    return {recorded: get(r, 'agent_limits'), limits_in_force: Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [arg, get(eff, field)])),
      what_this_means: "The Valun server now enforces these limits at every action, together with your owner's mandate "
        + '(the stricter of the two applies). Only your owner can raise the mandate.'};
  }

  async directory(a) {
    const c = this.client();
    const q = lower(or(get(a, 'query'), ''));
    const out = [];
    for (const p of iterate(await c.directory())) {
      if (item(p, 'id') === c.participantId || item(p, 'status') !== 'active') continue;
      const text = lower(['handle', 'display_name', 'about', 'services'].map(k => str(or(get(p, k), ''))).join(' '));
      if (q && !text.includes(q)) continue;
      const pos = get(await c.participant(item(p, 'id')), 'public_position', {});
      out.push({handle: item(p, 'handle'), id: item(p, 'id'), name: item(p, 'display_name'), operator: item(p, 'operator'), about: item(p, 'about'),
        services: item(p, 'services'), credit_notes_they_hold_PC: get(pos, 'claims_held'), credit_notes_they_owe_PC: get(pos, 'owes'),
        deals: get(pos, 'deals'), agent_last_seen: get(p, 'agent_last_seen'),
        agent_recently_active: recentlyActive(get(p, 'agent_last_seen'), 24, get(p, 'joined_at'), this.#now())});
    }
    out.sort((x, y) => Number(!x.agent_recently_active) - Number(!y.agent_recently_active));   // stable: active first
    return {participants: out, note: 'positions are outstanding credit notes recorded by the pilot Basis tracker; nothing is settled; '
      + 'PC have no value. A participant whose agent has not been seen in the last 24 hours may never answer an offer.'};
  }

  async inbox() {
    return this.client().inbox();
  }

  async deal(a) {
    const c = this.client();
    const d = await c.deal(item(a, 'deal_id'));
    const out = Object.fromEntries(DEAL_FIELDS.map(k => [k, get(d, k)]));
    if (truthy(get(d, 'pending_counter'))) {
      const pc = item(d, 'pending_counter');
      out.your_counter_offer_awaiting_owner = {version: item(pc, 'version'), state: item(pc, 'state'), terms: get(pc, 'terms'),
        terms_hash: item(pc, 'terms_hash'), note: 'the other side cannot see it until your owner approves it'};
    }
    const cur = or(get(d, 'current'), {}), st = get(d, 'status');
    if (st === 'open' && truthy(cur)) {
      out.whose_turn = get(cur, 'by') !== c.participantId ? 'yours: accept, counter or decline'
        : 'theirs: your offer is open; you cannot accept your own offer, only withdraw it or wait';
    } else if (st === 'agreed') {
      out.whose_turn = get(d, 'your_role') === 'payee' ? 'yours: deliver the work' : 'theirs: they deliver';
    } else if (st === 'delivered' || st === 'note_failed') {
      out.whose_turn = get(d, 'your_role') === 'payer' ? 'yours: accept the delivery or dispute it' : 'theirs: they review your delivery';
    } else {
      out.whose_turn = `nobody: the deal is ${str(st)}`;
    }
    const current = item(d, 'current');
    out.current_terms = truthy(current) ? {version: item(current, 'version'), by: item(current, 'by'), state: item(current, 'state'),
      terms: item(current, 'terms'), terms_hash: item(current, 'terms_hash')} : current;
    if (get(d, 'status') === 'open' && truthy(get(d, 'current'))) {
      try {
        const chk = await c.verifyOffer(d);
        out.checked_by_your_client = {terms_hash_recomputed: item(chk, 'terms_hash'), proposer_signature_valid: true};
      } catch (e) {
        if (!isValunError(e)) throw e;
        out.checked_by_your_client = {problem: e.code, message: e.message, advice: 'do not accept these terms'};
      }
    }
    if (truthy(get(d, 'delivery'))) {
      const dl = item(d, 'delivery');
      const content = item(dl, 'content');
      const body = cpLength(content) <= 16000 ? content
        : cpSlice(content, 16000) + '\n[... truncated for display; full text is on the server ...]';
      out.delivery = {title: get(dl, 'title'), sha256: item(dl, 'sha256'), bytes: item(dl, 'bytes'), late: get(dl, 'late'), content: body};
      const reviewing = get(d, 'your_role') === 'payer' && ['delivered', 'note_failed'].includes(get(d, 'status'));
      out.delivery.measured_by_your_client = await measure(content, termsText(d), this.#measureOptions(reviewing && this.checkLinkHosts));
      const exact = checkDelivery(or(get(or(get(d, 'current'), {}), 'terms'), {}), content);
      if (exact !== null) {
        out.delivery.checked_exactly_by_your_client = exact;
        if (reviewing && truthy(exact.checked) && !truthy(exact.exact_result_matches)) {
          out.delivery.advice = 'The delivered result does not match the exact result of the agreed text '
            + `(differs in: ${or(exact.differs_in, ['the result block']).join(', ')}). `
            + 'Dispute it with that reason instead of issuing a credit note.';
        }
      }
    }
    if (truthy(get(d, 'credit_note'))) {
      const n = item(d, 'credit_note');
      const tn = or(get(n, 'tracker_note'), {});
      out.credit_note = {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        tracker_cumulative_total_PC: get(tn, 'amount_collected'), confirmation: get(tn, 'confirmation'),
        verified_by_valun: get(n, 'verified_by_valun'), outstanding: get(n, 'outstanding'), settled: get(n, 'settled', false),
        issuer_pubkey: get(n, 'issuer_pubkey'), recipient_pubkey: get(n, 'recipient_pubkey')};
      if (truthy(get(n, 'signature_withheld'))) out.credit_note.signature = 'withheld until the Basis tracker records the note';
    }
    out.history = get(d, 'history', []).slice(-12);
    const them = get(or(get(d, 'counterparty'), {}), 'handle');
    const prices = iterate(or(get(d, 'versions'), [])).map(v => {
      const n = item(v, 'version'), who = item(v, 'by') === c.participantId ? 'you' : them;
      return [n, who, item(item(v, 'price'), 'amount')];
    });
    if (prices.length) {
      out.negotiation = {prices_by_version: prices.map(([n, who, p]) => `v${str(n)} ${str(who)}: ${str(p)} PC`)};
      const mine = prices.filter(([, who]) => who === 'you').map(([, , p]) => p).slice(-2);
      const theirs = prices.filter(([, who]) => who !== 'you').map(([, , p]) => p).slice(-2);
      if (mine.length === 2 && theirs.length === 2 && pyEq(mine[0], mine[1]) && pyEq(theirs[0], theirs[1]) && !pyEq(mine[0], theirs[0])) {
        out.negotiation.stalemate = `Both sides have repeated the same price (${str(mine[0])} vs ${str(theirs[0])} PC). If no price `
          + 'within your limits works for the other side, decline with a reason instead of countering again.';
      }
    }
    return out;
  }

  async propose(a) {
    const c = this.client();
    const other = await this.#resolve(c, item(a, 'counterparty'));
    // A seller of exactly checkable work publishes that it needs the text in the description; check before signing.
    if (get(a, 'role') === 'payer' && str(or(get(other, 'services'), '')).includes('``` block')
        && extractText(or(get(a, 'description'), '')) === null) {
      throw new ValunError('missing_text',
        `Not signed. ${str(item(other, 'handle'))} needs the text to process inside the description, and yours has none. Put the `
        + 'exact text in a ``` fenced block in the description (or as the only "quoted" string, or after TEXT: at the '
        + 'end), then make the offer again.');
    }
    const counterpartyId = item(other, 'id'), role = item(a, 'role'), title = item(a, 'title'), description = item(a, 'description');
    const deliverable = item(a, 'deliverable'), price = int(item(a, 'price'));
    const deliverByHours = int(or(get(a, 'deliver_within_hours'), 48)), offerTtlHours = int(or(get(a, 'offer_valid_hours'), 24));
    const r = await c.propose({counterpartyId, role, title, description, deliverable, price, deliverByHours, offerTtlHours});
    const waiting = item(r, 'status') === 'proposed_awaiting_owner';
    const idle = recentlyActive(get(other, 'agent_last_seen'), 24, get(other, 'joined_at'), this.#now()) ? null
      : `${str(item(other, 'handle'))}'s agent has not been seen in the last 24 hours; it may never answer. Consider an active seller too.`;
    const handle = str(item(other, 'handle')), shownPrice = str(item(a, 'price'));
    return {deal_id: item(r, 'id'), status: item(r, 'status'),
      terms_hash: truthy(get(r, 'current')) ? item(item(r, 'current'), 'terms_hash') : null,
      what_happened: waiting ? `Your signed offer is waiting for your owner's approval before ${handle} can see it.`
        : `${handle} can now accept, decline or counter your signed offer.`,
      if_agreed: item(a, 'role') === 'payer'
        ? `After you accept their delivery you issue them a credit note of ${shownPrice} PC (you will owe them; not settled).`
        : `After they accept your delivery they issue you a credit note of ${shownPrice} PC (they will owe you; not settled).`,
      ...(idle ? {warning: idle} : {})};
  }

  async respond(a) {
    const c = this.client();
    const act = item(a, 'action'), did = item(a, 'deal_id');
    let r;
    if (act === 'accept') {
      r = await c.accept(did, {expectedTermsHash: get(a, 'expected_terms_hash')});
    } else if (act === 'decline') {
      if (!truthy(strip(or(get(a, 'reason'), '')))) {
        throw new ValunError('reason_required', 'a decline needs a short reason: the other side reads it and may make a better offer');
      }
      r = await c.decline(did, strip(item(a, 'reason')));
    } else if (act === 'withdraw') {
      r = await c.withdraw(did);
    } else if (act === 'counter') {
      r = await c.counter(did, {price: get(a, 'price'), title: get(a, 'title'), description: get(a, 'description'),
        deliverable: get(a, 'deliverable'), deliverByHours: get(a, 'deliver_within_hours'), expectedTermsHash: get(a, 'expected_terms_hash')});
    } else {
      throw new ValunError('bad_action', 'action must be accept, decline, counter or withdraw');
    }
    const held = act === 'counter' && truthy(get(r, 'pending_counter'));
    const explain = {agreed: 'Agreement formed: both sides have signed the same terms.',
      accepted_awaiting_owner: 'You signed the acceptance; it becomes binding when the owner holding it approves '
        + "(yours, or the proposer's if their limits require it; valun_deal shows which).",
      open: held ? "Your signed counter-offer waits for your owner's approval; the other side cannot see it yet."
        : act === 'counter' ? 'Your counter-offer is open for the other side.' : 'The offer is open.',
      declined: 'You declined; nothing is owed.', withdrawn: 'Your offer is withdrawn.'};
    const status = item(r, 'status');
    return {deal_id: did, status, what_happened: typeof status === 'string' && Object.hasOwn(explain, status) ? explain[status] : status,
      next_actions: get(r, 'next_actions')};
  }

  async deliver(a) {
    const c = this.client();
    const d = await c.deal(item(a, 'deal_id'));
    const m = await measure(item(a, 'content'), termsText(d), this.#measureOptions(this.checkLinkHosts));
    const problems = m.checks_against_agreed_terms.filter(x => !x.met).map(x => `${x.requirement}: measured ${x.measured}`);
    if (truthy(m.warning ?? null)) problems.push(m.warning);
    if (problems.length && !truthy(get(a, 'send_anyway'))) {
      throw new ValunError('draft_does_not_meet_terms', 'Not sent. Your draft does not meet the agreed terms as measured: '
        + problems.join(' | ') + ' Fix it and deliver again (send_anyway=true only if you are sure; '
        + 'the payer sees the same measurements).', undefined, {measured: m});
    }
    const r = await c.deliver(item(a, 'deal_id'), item(a, 'content'), {title: or(get(a, 'title'), '')});
    return {deal_id: item(r, 'id'), status: item(r, 'status'), sha256: item(item(r, 'delivery'), 'sha256'),
      what_happened: 'Delivered and signed. The payer will accept it (issuing you a credit note) or dispute it.'};
  }

  async review(a) {
    if (!['accept', 'dispute'].includes(get(a, 'decision'))) {
      throw new ValunError('bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed");
    }
    const c = this.client();
    if (item(a, 'decision') === 'dispute') {
      if (!truthy(strip(or(get(a, 'reason'), '')))) throw new ValunError('reason_required', 'a dispute needs a reason');
      const r = await c.dispute(item(a, 'deal_id'), item(a, 'reason'));
      return {deal_id: item(r, 'id'), status: item(r, 'status'), what_happened: 'Disputed. No credit note was issued; the dispute is recorded.'};
    }
    const r = await c.complete(item(a, 'deal_id'), {expectedDeliverableSha256: get(a, 'expected_deliverable_sha256'),
      expectedTermsHash: get(a, 'expected_terms_hash')});
    const n = or(get(r, 'credit_note'), {});
    const status = item(r, 'status');
    let msg;
    if (status === 'completion_awaiting_owner') {
      msg = 'You accepted the delivery and signed the credit note; your owner must approve before it is issued to the tracker.';
    } else if (status === 'note_issued') {
      msg = `Credit note issued: the Basis tracker now records that you owe ${str(item(item(r, 'counterparty'), 'handle'))} `
        + `${str(get(or(get(n, 'tracker_note'), {}), 'amount_collected'))} PC in total (this deal added ${str(get(n, 'amount'))}). ` + SETTLEMENT_NOTE;
    } else {
      msg = status;
    }
    return {deal_id: item(r, 'id'), status, what_happened: msg,
      credit_note: {state: get(n, 'state'), amount_PC: get(n, 'amount'), tracker_status: get(n, 'tracker_status'),
        confirmation: get(or(get(n, 'tracker_note'), {}), 'confirmation'), settled: false}};
  }
}
