// The Valun tools in the shape most JavaScript agent frameworks accept: {name, description, parameters (JSON
// Schema), execute(args)}, with the owner's approval asked before every commitment (ValunAgent.isCommitment: an offer,
// an acceptance, a counter-offer, accepting a delivery, loosening a limit, and any call it cannot classify).
//
// Approvals fail closed: without an approve hook every commitment is refused (approval_unavailable) unless the caller
// passes approvals: 'none' explicitly. With a hook, the approval text and the arguments that are signed come from ONE
// read of what would be signed (ValunAgent.prepare); when that read fails or does not hold together, the call is
// refused (approval_unbound) and the owner is never asked with a generic text. The Valun server enforces the owner's
// mandate in every mode.

import {APPROVAL_TEXT, errorPayload, UNBOUND_MESSAGE} from './agent.js';
import {ValunError} from './errors.js';
import {forNetwork} from './schemas.js';

/** What the model is told about approvals when no approve hook is given (valun_status shows it). */
export const NO_APPROVAL_STEP = 'Commitments cannot be signed here: this app has no way to ask your owner, so every offer, '
  + 'counter-offer, acceptance, credit note and loosening of a limit is refused and nothing is signed. Reading, declining, '
  + 'withdrawing, delivering and tightening limits still work.';

function approvalUnavailable(message) {
  return {error: 'approval_unavailable', message,
    what_this_means: 'Nothing was signed. Tell your owner that this app cannot ask them to approve Valun commitments; '
      + 'it needs an approval step, or an explicit choice to act without asking within the owner\'s mandate.'};
}

const NO_HOOK = 'Not signed. This app asks the owner before every commitment, but it has no approval step (no approve hook was given).';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Tool arguments as plain JSON data: an object, a JSON string of one (raw tool-call arguments), or nothing. */
function plainArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  const v = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('not a JSON object');
  return v;
}

/** prepareOrRefusal(), with anything unexpected (a thrown error, a malformed answer) turned into the same refusal. */
async function prepared(agent, name, args) {
  try {
    const [p, refusal] = await agent.prepareOrRefusal(name, args);
    if (refusal) return [null, refusal];
    return [{args: plainArgs(p.args), text: p.text ?? null}, null];
  } catch {
    return [null, errorPayload(new ValunError('approval_unbound', UNBOUND_MESSAGE), agent.setupHint)];
  }
}

async function run(agent, name, raw, mode, approve) {
  let args;
  try {
    args = plainArgs(raw);
  } catch (e) {
    return {error: 'bad_arguments', message: `arguments must be a JSON object: ${e?.message || e}`};
  }
  if (mode !== 'none') {
    let commits;
    try {
      commits = await agent.isCommitment(name, args);
    } catch {
      commits = true;                           // when in doubt, it is a commitment
    }
    if (commits) {
      if (mode !== 'ask') return approvalUnavailable(NO_HOOK);
      // One read binds and describes: the approval and the signature cover the same exact terms. If that read fails,
      // nothing is signed and the owner is not asked (approval_unbound).
      const [p, refusal] = await prepared(agent, name, args);
      if (refusal) return refusal;
      args = p.args;
      if (p.text !== null) {                    // null: the read prepare() made shows this call commits nothing
        let answer;
        try {
          answer = await approve(p.text, name, deepFreeze(plainArgs(args)));
        } catch (e) {
          return approvalUnavailable(`Not signed: the approval step failed (${e?.message || String(e)}).`);
        }
        if (answer !== true) {
          return errorPayload(new ValunError('owner_declined', 'your owner did not approve this commitment; nothing was signed'), agent.setupHint);
        }
      }
    }
  }
  return agent.callSafe(name, args);
}

/**
 * The tools of `agent` (a ValunAgent) as [{name, description, parameters, execute(args)}]. execute() takes the
 * arguments as an object or as a JSON string, and always resolves to a plain object (an error payload on failure).
 *
 * options:
 *   approve    async (commitmentText, name, args) => boolean, called before every commitment. The text and the arguments
 *              come from one read of what would be signed (ValunAgent.prepare: an acceptance pinned to the recomputed
 *              terms hash or deliverable hash, an offer to the participant id shown); the hook gets that text and a
 *              frozen copy of those arguments, and exactly they are executed. Only `true` approves. Otherwise the call
 *              is refused with owner_declined; if the hook throws, with approval_unavailable. When what would be signed
 *              cannot be read or checked, the call is refused with approval_unbound and the hook is not called.
 *   approvals  'none' to sign commitments without asking anyone (the server still enforces the owner's mandate). Without
 *              an approve hook and without 'none', every commitment is refused with approval_unavailable (fail closed).
 * If agent.approvals (the sentence valun_status shows the model) is empty, it is set to match the mode chosen here.
 */
export function valunTools(agent, options = {}) {
  for (const m of ['callSafe', 'isCommitment', 'prepareOrRefusal', 'describeCommitment', 'bind']) {
    if (typeof agent?.[m] !== 'function') throw new TypeError('valunTools needs a ValunAgent');
  }
  const {approve = null, approvals = null} = options;
  if (approve !== null && typeof approve !== 'function') throw new TypeError('approve must be a function');
  if (approvals !== null && approvals !== 'ask' && approvals !== 'none') throw new TypeError("approvals must be 'ask' or 'none'");
  if (approvals === 'none' && approve) throw new TypeError("approvals: 'none' and an approve hook contradict each other");
  const mode = approvals === 'none' ? 'none' : approve ? 'ask' : 'unavailable';
  if (!agent.approvals) agent.approvals = mode === 'none' ? APPROVAL_TEXT.none : mode === 'ask' ? APPROVAL_TEXT.ask : NO_APPROVAL_STEP;
  // In the words of the profile's network (forNetwork): the pilot's for an agent that has not joined yet.
  let network = options.network ?? null;
  if (network === null) {
    try { network = agent.client(false).state?.network ?? null; } catch { network = null; }
  }
  return forNetwork(network).map(def => ({
    name: def.name,
    description: def.description,
    parameters: JSON.parse(JSON.stringify(def.parameters)),
    execute: args => run(agent, def.name, args, mode, approve),
  }));
}

/** The consent loop's period (ms), plus up to CONSENT_LOOP_JITTER_MS (as the Python MCP server's loop). */
export const CONSENT_LOOP_MS = 60_000;
export const CONSENT_LOOP_JITTER_MS = 10_000;

/**
 * The optional consent loop for long-running hosts (design 6.6; the Python MCP server's ConsentLoop). Nothing runs until
 * a host calls this: then every `intervalMs` plus up to `jitterMs`, while the profile's consent_loop is 'on' (read again
 * from the store each time: the owner may change it while the host runs), it lets the agent sign the consents its owner's
 * policy allows (agent.consentsIfDue(): GET /info first, nothing more unless the server lists circulation/1, at most once
 * a minute whoever triggers it). Runs never overlap and never throw; the timer does not keep a Node process alive.
 * Each round of a ValunAgent holds the agent's lock (agent.consentRound(): the profile read and the run together), as
 * each Python round holds STORE_LOCK, so it never interleaves with a tool call of this agent.
 * Returns {stop(), runOnce(), runs}: stop() ends it, runOnce() runs one round now (resolves when it is done), runs counts
 * the rounds that found the loop on.
 */
export function startConsentLoop(agent, {intervalMs = CONSENT_LOOP_MS, jitterMs = CONSENT_LOOP_JITTER_MS, random = Math.random} = {}) {
  if (typeof agent?.consentsIfDue !== 'function' || typeof agent?.client !== 'function') {
    throw new TypeError('startConsentLoop needs a ValunAgent');
  }
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) throw new TypeError('intervalMs must be a positive number of milliseconds');
  if (!(Number.isFinite(jitterMs) && jitterMs >= 0)) throw new TypeError('jitterMs must be a number of milliseconds, at least 0');
  let stopped = false, timer = null, running = null, runs = 0;
  const enabled = async () => {
    try {
      const c = agent.client(false);
      if (typeof c.reload === 'function') await c.reload();
      const st = c.state;
      return st !== null && typeof st === 'object' && st.consent_loop === 'on';
    } catch {                                         // an unreadable profile: do nothing (the tools say why)
      return false;
    }
  };
  const runOnce = () => {
    running ??= (async () => {
      try {
        if (typeof agent.consentRound === 'function') {       // a ValunAgent: the whole round holds its lock
          await agent.consentRound(async () => {
            const on = await enabled();
            if (on) runs++;
            return on;
          });
        } else if (await enabled()) {
          runs++;
          await agent.consentsIfDue();
        }
      } catch { /* a background run never takes the host down */ } finally {
        running = null;
      }
    })();
    return running;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, intervalMs + random() * jitterMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    runOnce,
    get runs() { return runs; },
  };
}
