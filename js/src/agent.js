// The nine Valun agent tools, independent of any agent framework (port of python/src/valun/agent.py).
//
// An adapter supplies a Client (whose store holds the participant's key, token and non-secret state), a few settings and
// a sentence saying where approvals happen; this module does the protocol work: it builds and verifies what is signed
// (through the Client), measures deliveries against the agreed terms, and explains results in plain words. Results,
// error payloads and approval texts are the Python reference's, word for word (test/agent-parity.test.js replays
// scenarios recorded from the Python code). Every tool result is a plain JSON-compatible object.
//
// Secrets never leave the store: no tool returns, logs or echoes the signing key or the agent token.
// Approvals fail closed: isCommitment() is true unless the action is exactly a harmless one, valun_review_delivery
// refuses any decision but exactly 'accept' or 'dispute' (bad_decision) before connecting, and bind() pins the terms
// hash or deliverable hash an approval is about, so what is signed is what the owner saw.

import {ValunError} from './errors.js';
import {measure} from './measure.js';
import {checkDelivery, extractText} from './sandbox.js';
import * as schemas from './schemas.js';
import {
  PyError, cpLength, cpSlice, dictCopy, get, int, isDict, isoAwareMs, item, items, iterate, lower, or, pyEq, repr, slice, str, strip, truthy,
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
export const DEFAULT_SETUP_HINT = 'run `valun join` (or `valun enroll`) in a terminal';
/** Where approvals happen, as the Python MCP server and CLI tell the model (python/src/valun/mcp_server.py). */
export const APPROVAL_TEXT = Object.freeze({
  ask: 'Before you sign an offer, counter-offer, acceptance or credit note, your owner is asked through this app and '
    + 'sees exactly what you would sign; if they decline, nothing is signed.',
  'client-prompt': 'Your app asks your owner before each Valun tool that signs a commitment (if your owner has not '
    + 'allowed it permanently).',
  console: 'Every commitment you sign waits for your owner in the Valun owner console before it takes effect.',
  none: "You act on your own within your owner's limits; nobody is asked before you sign.",
});

const DEAL_FIELDS = ['id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement', 'decline',
  'completion', 'dispute', 'cancellation', 'approvals', 'labels'];
const LIMITS_SHOWN = Object.entries(LIMIT_FIELDS);

function pyCompare(a, b, op) {
  const num = v => typeof v === 'number' || typeof v === 'boolean';
  if (!num(a) || !num(b)) throw new PyError('TypeError', `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
  return op === '>' ? Number(a) > Number(b) : Number(a) < Number(b);
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
 * one). Setting a limit for the first time is never looser than the owner's mandate (the server refuses that).
 */
export function loosens(current, body) {
  const kinds = Object.fromEntries(Object.values(LIMIT_FIELDS));
  for (const [field, next] of Object.entries(body)) {
    if (!Object.hasOwn(kinds, field) || get(current, field) === null) continue;
    const old = item(current, field);
    if (next === null || (kinds[field] === 'cap' && pyCompare(next, old, '>')) || (kinds[field] === 'floor' && pyCompare(next, old, '<'))) {
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
  return ['title', 'description', 'deliverable'].map(k => str(or(get(t, k), ''))).join(' ');
}

function isValunError(e) {
  return e instanceof ValunError || (e instanceof Error && e.name === 'ValunError' && typeof e.code === 'string');
}

/** A ValunError (or any exception) as a plain object an agent can act on. Never includes secrets. */
export function errorPayload(e, setupHint = DEFAULT_SETUP_HINT) {
  if (isValunError(e)) {
    const out = {error: e.code, message: e.message};
    const extra = isDict(e.extra) ? e.extra : {};
    for (const k of ['rule', 'mandate_version', 'measured']) if (Object.hasOwn(extra, k)) out[k] = extra[k];
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
  /** Does this call sign something that commits the owner (or loosen a limit)? Adapters ask the owner first. */
  async isCommitment(name, args = null) {
    args = or(args, {});
    if (name === 'valun_propose') return true;
    // Fail closed: only the explicitly harmless actions skip the owner (a misspelt "Accept" must never skip them).
    if (name === 'valun_respond') return !['decline', 'withdraw'].includes(get(args, 'action'));
    if (name === 'valun_review_delivery') return get(args, 'decision') !== 'dispute';
    if (name === 'valun_set_limits') {
      try {
        const me = await this.client().me();
        return loosens(or(get(me, 'agent_limits'), {}), limitsBody(args));
      } catch {
        return true;    // when in doubt, ask the owner
      }
    }
    return false;
  }

  /**
   * Pin what the owner is about to approve: an acceptance to the current terms hash, a delivery acceptance to the
   * current deliverable hash, unless the agent already passed them. Adapters call this BEFORE asking the owner and sign
   * with the returned arguments, so the signature covers exactly what the owner saw (the client refuses a changed offer
   * or delivery instead of silently signing it). Best effort: returns a copy of the arguments, pinned where it could.
   */
  async bind(name, args = null) {
    const out = dictCopy(or(args, {}));
    try {
      if (name === 'valun_respond' && get(out, 'action') === 'accept' && !truthy(get(out, 'expected_terms_hash'))) {
        const cur = or(get(await this.client().deal(item(out, 'deal_id')), 'current'), {});
        if (truthy(get(cur, 'terms_hash'))) out.expected_terms_hash = item(cur, 'terms_hash');
      }
      if (name === 'valun_review_delivery' && get(out, 'decision') === 'accept' && !truthy(get(out, 'expected_deliverable_sha256'))) {
        const dl = or(get(await this.client().deal(item(out, 'deal_id')), 'delivery'), {});
        if (truthy(get(dl, 'sha256'))) out.expected_deliverable_sha256 = item(dl, 'sha256');
      }
    } catch {
      // binding is best effort; the call itself reports real problems
    }
    return out;
  }

  /** Text for an approval prompt: exactly what the agent is about to sign, and what it means. */
  async describeCommitment(name, args = null) {
    args = or(args, {});
    try {
      const c = this.client();
      if (name === 'valun_set_limits') {
        const me = await c.me();
        const cur = or(get(me, 'agent_limits'), {}), mandate = item(me, 'mandate'), body = limitsBody(args);
        const names = Object.fromEntries(LIMITS_SHOWN.map(([arg, [field]]) => [field, arg]));
        const lines = ['Valun - LOOSEN limits recorded from your instructions (the Valun server enforces them):'];
        for (const [field, next] of Object.entries(body)) {
          if (Object.hasOwn(names, field)) {
            lines.push(`  ${names[field]}: ${str(get(cur, field, get(mandate, field)))} -> ${next !== null ? str(next) : 'removed'} (your owner mandate: ${str(get(mandate, field))})`);
          }
        }
        lines.push('Approve only if you asked your agent for this.');
        return lines.join('\n');
      }
      if (name === 'valun_propose') {
        const role = get(args, 'role'), price = get(args, 'price'), who = get(args, 'counterparty');
        return [
          `Valun - sign a NEW OFFER to ${str(who)}:`,
          `  service: ${str(get(args, 'title'))}`,
          `  deliverable: ${str(get(args, 'deliverable'))}`,
          `  price: ${str(price)} PC; you are the ` + (role === 'payer' ? 'payer' : 'payee (you do the work)'),
          `  deliver within ${str(or(get(args, 'deliver_within_hours'), 48))} h; the offer stays open ${str(or(get(args, 'offer_valid_hours'), 24))} h`,
          `If ${str(who)} accepts, the deal is binding without asking you again: `
            + (role === 'payer' ? `after you accept their delivery you will owe them ${str(price)} PC (your credit note).`
              : `you must deliver; they would then owe you ${str(price)} PC (their credit note).`),
          NOT_SETTLED].join('\n');
      }
      const d = await c.deal(get(args, 'deal_id'));
      const cur = or(get(d, 'current'), {});
      const t = or(get(cur, 'terms'), {}), who = get(or(get(d, 'counterparty'), {}), 'handle'), role = get(d, 'your_role');
      const price = get(or(get(t, 'price'), {}), 'amount'), svc = or(get(t, 'service'), {});
      if (name === 'valun_respond' && get(args, 'action') === 'accept') {
        return [
          `Valun - ACCEPT ${str(who)}'s offer (deal ${str(item(d, 'id'))}, version ${str(get(cur, 'version'))}):`,
          `  service: ${str(get(svc, 'title'))}`,
          `  deliverable: ${str(get(svc, 'deliverable'))}`,
          `  price: ${str(price)} PC; you are the ${str(role)}; deliver by ${str(get(t, 'deliver_by'))}`,
          `  terms hash ${str(slice(or(get(args, 'expected_terms_hash'), or(get(cur, 'terms_hash'), '')), 16))}... (rechecked by your Valun client before signing)`
            + (!truthy(get(args, 'expected_terms_hash')) || pyEq(item(args, 'expected_terms_hash'), get(cur, 'terms_hash')) ? ''
              : '\n  WARNING: the offer changed after your agent read it; signing these terms will be refused'),
          'This makes the deal binding on both sides: '
            + (role === 'payer' ? `after you accept the delivery you will owe ${str(who)} ${str(price)} PC.`
              : `you must deliver; ${str(who)} would then owe you ${str(price)} PC.`),
          NOT_SETTLED].join('\n');
      }
      if (name === 'valun_respond' && get(args, 'action') === 'counter') {
        const changes = ['price', 'title', 'description', 'deliverable', 'deliver_within_hours']
          .filter(k => { const v = get(args, k); return v !== null && v !== ''; })
          .map(k => `${k} ${str(item(args, k))}`);
        return [
          `Valun - sign a COUNTER-OFFER to ${str(who)} (deal ${str(item(d, 'id'))}), replacing their version ${str(get(cur, 'version'))} at ${str(price)} PC:`,
          '  changes: ' + (changes.join(', ') || 'none'),
          `If ${str(who)} accepts it, the deal is binding without asking you again. You are the ${str(role)}.`,
          NOT_SETTLED].join('\n');
      }
      if (name === 'valun_review_delivery') {
        const dl = or(get(d, 'delivery'), {});
        const m = await measure(or(get(dl, 'content'), ''), termsText(d), {checkHosts: false});
        const facts = m.checks_against_agreed_terms.map(x => `${x.requirement}: ${x.measured} (${x.met ? 'met' : 'NOT met'})`);
        const exact = checkDelivery(t, or(get(dl, 'content'), ''));
        if (truthy(exact) && truthy(exact.checked)) {
          facts.push('exact result: ' + (truthy(exact.exact_result_matches) ? 'matches the agreed text'
            : `DOES NOT MATCH (differs in ${or(exact.differs_in, []).join(', ')})`));
        }
        return [
          `Valun - ACCEPT ${str(who)}'s delivery (deal ${str(item(d, 'id'))}) and ISSUE A CREDIT NOTE of ${str(price)} PC to ${str(who)}:`,
          `  delivered: ${str(or(get(dl, 'title'), '(untitled)'))}, ${str(get(dl, 'bytes'))} bytes, sha256 ${str(slice(or(get(dl, 'sha256'), ''), 16))}...`,
          '  measured: ' + (facts.join('; ') || `${m.word_count} words, ${m.links.length} links`),
          `Your agent signs a Basis note; the pilot tracker then records that you owe ${str(who)} ${str(price)} PC more.`,
          NOT_SETTLED].join('\n');
      }
    } catch {
      // the prompt must still appear
    }
    return `Valun: sign a commitment (${str(name)}).`;
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
        deliverable: get(a, 'deliverable'), deliverByHours: get(a, 'deliver_within_hours')});
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
    const r = await c.complete(item(a, 'deal_id'), {expectedDeliverableSha256: get(a, 'expected_deliverable_sha256')});
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
