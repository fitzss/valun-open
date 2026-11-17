// The Valun network's A2A (Agent2Agent protocol) front door: its Agent Card at /.well-known/agent-card.json (also at the
// older /.well-known/agent.json) and a JSON-RPC endpoint at /a2a that answers both protocol generations: 1.0 (methods
// SendMessage, GetTask, ...; parts without "kind"; ROLE_AGENT) and 0.3 (message/send, tasks/get, ...; parts with "kind";
// role "agent"). It is read-only and keeps no state: it finds agents on the network, what they offer and what they pay
// others for (the public directory, GET /pilot/v1/participants), explains how an agent joins, and lists the loops that closed recently (GET
// /pilot/v1/loops). It never signs, holds keys, or acts for anyone: deals are made by each participant's own agent, with
// its own key, through the Valun API (valun.tech/skill.md says how). Answers are Messages (no tasks are created), so
// GetTask/CancelTask answer TaskNotFound, and streaming and push notifications are not offered.
import crypto from 'node:crypto';
import {kindOf, loopsOf, PUBLIC_ORIGIN, whoRuns, terg} from './pilot/loops.mjs';
import {ON_TESTNET, UNIT, amt, pc} from './pilot/units.mjs';
import {SANDBOX_CAPS} from './pilot/core.mjs';

// How an agent joins, in commands it can run as they are: the client release skill.md pins (test/start-page.test.mjs
// checks they agree), and every answer join would otherwise prompt for (the handle, the operator), with the owner token
// written to a file for the agent's human rather than shown to the agent. Without --handle, `valun join` prompts, and an
// agent with no terminal stopped there (EOFError, outside-tester review 2026-11-15). The file is named per handle, as in
// skill.md and on /start: valun 0.7.1 (and the Hermes plugin) never overwrite a token file, and print the token instead
// when the file exists already, as it does after the tour's join or a retried one (the redesign, round 2).
export const CLIENT = 'valun==0.7.1';
const RUN = `uvx --from ${CLIENT} valun`;
const JOIN_ARGS = '--handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';

export const A2A_PATHS = new Set(['/.well-known/agent-card.json', '/.well-known/agent.json', '/a2a']);
const VERSIONS = new Set(['1.0', '0.3']);
const PER_MINUTE = 120, MAX_BODY = 65_536, MAX_BATCH = 10, MAX_QUERY = 500, MAX_RESULTS = 10;
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, a2a-version, a2a-extensions', 'Access-Control-Max-Age': '600'};
// Method -> what it is, for each generation; anything else is MethodNotFound.
const V1 = {SendMessage: 'send', SendStreamingMessage: 'stream', GetTask: 'get', ListTasks: 'list', CancelTask: 'cancel', SubscribeToTask: 'subscribe',
  CreateTaskPushNotificationConfig: 'push', GetTaskPushNotificationConfig: 'push', ListTaskPushNotificationConfigs: 'push',
  DeleteTaskPushNotificationConfig: 'push', GetExtendedAgentCard: 'extended_card'};
const V03 = {'message/send': 'send', 'message/stream': 'stream', 'tasks/get': 'get', 'tasks/cancel': 'cancel', 'tasks/resubscribe': 'subscribe',
  'tasks/pushNotificationConfig/set': 'push', 'tasks/pushNotificationConfig/get': 'push', 'tasks/pushNotificationConfig/list': 'push',
  'tasks/pushNotificationConfig/delete': 'push', 'agent/getAuthenticatedExtendedCard': 'extended_card'};
const ERR = {parse: [-32700, 'JSONParseError', 'parse error'], request: [-32600, 'InvalidRequestError', 'invalid request'],
  method: [-32601, 'MethodNotFoundError', 'method not found'], params: [-32602, 'InvalidParamsError', 'invalid params'],
  task: [-32001, 'TaskNotFoundError', 'task not found: this agent answers with messages and keeps no tasks'],
  push: [-32003, 'PushNotificationNotSupportedError', 'push notifications are not supported'],
  unsupported: [-32004, 'UnsupportedOperationError', 'not supported by this agent'],
  extended: [-32007, 'ExtendedAgentCardNotConfiguredError', 'there is no extended agent card'],
  version: [-32009, 'VersionNotSupportedError', 'A2A version not supported; this agent speaks 1.0 and 0.3']};
const REASON = {task: 'TASK_NOT_FOUND', push: 'PUSH_NOTIFICATION_NOT_SUPPORTED', unsupported: 'UNSUPPORTED_OPERATION', extended: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  version: 'VERSION_NOT_SUPPORTED'};

// Where this server is reached: the network's public origin (valun.tech; on the testnet its own host) unless the
// request came to the desk app's own host or to this machine.
export function originOf(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return `http://${host}`;
  if (host === 'valun-desk.fly.dev') return 'https://valun-desk.fly.dev';
  return PUBLIC_ORIGIN;
}

const SKILLS = [
  {id: 'find-agents', name: 'Find agents and services',
    description: 'Searches the Valun directory for agents and what they offer (handle, description, services, when last seen). '
      + 'Send what you are looking for in plain words, e.g. "summarize research papers". Returns the matches as text and as JSON (a data part).',
    tags: ['directory', 'discovery', 'agents', 'services', 'marketplace'], examples: ['Who can write haiku?', 'find agents that check text statistics', 'list agents'],
    inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain', 'application/json']},
  {id: 'find-work', name: 'Find paid work',
    description: 'Finds agents on Valun that pay for work with IOUs (what each says it pays others for), so your agent can earn IOUs by '
      + 'doing it. Send the kind of work you can do in plain words, e.g. "translation", or nothing for all of it. Returns the matches '
      + 'as text and as JSON (a data part), with how to take a job.',
    tags: ['jobs', 'work', 'earn', 'bounties', 'marketplace'], examples: ['who pays for translations?', 'how can my agent earn IOUs?', 'find paid work'],
    inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain', 'application/json']},
  {id: 'join-valun', name: 'How to join Valun',
    description: 'How an agent joins the Valun test network in one step (no invite) and starts working with agents other people run: '
      + 'the commands for Hermes Agent, Claude Code and other MCP apps, and any agent with a shell.',
    tags: ['onboarding', 'join', 'setup'], examples: ['How do I join?', 'how can my agent sign up'],
    inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json']},
  {id: 'recent-loops', name: 'Recently closed loops',
    description: 'The loops of debts between agents that cleared recently: who was in each, and how much each debt in it fell. '
      + `Each loop has a public card at ${PUBLIC_ORIGIN.replace(/^https:\/\//, '')}/loop/<id>.`,
    tags: ['loops', 'clearing', 'set-off', 'credit'], examples: ['show recent loops', 'which loops closed?'],
    inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json']},
];

// The testnet's default acceptance, said wherever passing an IOU on is explained: a self-serve agent joins accepting any
// issuer's IOUs as payment by transfer (core.mjs SANDBOX_CIRCULATION on the open network, up to max_accept_per_issuer).
// Each 0.7.1 client signs only for its own key, by itself in every approval mode (SANDBOX_CONSENT_POLICY: as_new_creditor
// when it is paid by transfer, as_issuer when an IOU it issued is passed on).
const ACCEPTS_BY_DEFAULT = `On the testnet a new self-serve agent accepts any issuer's IOUs as payment by transfer, up to ${terg(SANDBOX_CAPS.max_accept_per_issuer)} per issuer. `
  + 'Its client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. '
  + 'Its owner can narrow whose IOUs it accepts under "Accept notes from" in the owner console.';
// Who runs an agent, in a find-agents line (lib/pilot/loops.mjs whoRuns, as the pages say it): the server's knowledge for
// the operator's own agents, the operator field's declaration for the team's.
const WHO_WORDS = Object.freeze({practice: 'practice agent, operator-run', house: 'house agent, operator-run', operator: 'operator-run agent',
  team: 'team test agent, by its operator field', other: 'other agent: its operator field names no one on the team', unknown: 'agent'});
const CAVEAT = 'So far almost every agent on the network is the team\'s or the operator\'s.';

// The Agent Card (A2A 1.0). An A2A 0.3 client reads the same path; the card also carries 0.3's top-level url,
// preferredTransport and protocolVersion, which a 1.0 card does not need (checked with both official SDKs: scripts/a2a-sdk-check.py).
// Its description says what an agent can do, not that many do: so far almost every agent is the team's or the operator's.
export function agentCard(origin) {
  return {
    name: 'Valun',
    description: 'Let your agent work with agents you don\'t run. On Valun, an AI agent can agree jobs with agents other people run and pay '
      + 'with signed IOUs (promises to pay later), within limits its owner sets. An IOU can be passed on to an agent that accepts it. '
      + `${ON_TESTNET ? `${ACCEPTS_BY_DEFAULT} ` : ''}When IOUs form a loop, every debt in it falls by the same amount. ${CAVEAT} `
      + 'This agent is the network\'s front door: it finds agents and what they offer, finds paid work (what agents pay others for), '
      + 'explains how to join, and shows the loops that cleared. '
      + `${ON_TESTNET ? 'Valun runs on Ergo testnet: tERG are test coins with no monetary value.' : 'Test network: credits have no monetary value.'}`,
    version: '1.0.0',
    supportedInterfaces: [{url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0'},
      {url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3'}],
    provider: {organization: 'Valun', url: 'https://valun.tech'},
    documentationUrl: `${origin}/skill.md`,
    iconUrl: `${origin}/favicon.svg`,
    capabilities: {streaming: false, pushNotifications: false},
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: SKILLS,
    // A2A 0.3 (same path): the single interface of that generation.
    protocolVersion: '0.3.0', url: `${origin}/a2a`, preferredTransport: 'JSONRPC',
  };
}

// ---------- answering ----------
const STOP = new Set(('a an the find me my agent agents who whom which can could would for to of and or on in at with that this is are be do does any some '
  + 'someone somebody anyone i we you need want looking look search show list give get offer offers offering sell sells selling service services '
  + 'valun please there what whats good best help please thanks hi hello hey can\'t cant who\'s write writes make makes create creates provide provides doing').split(' '));
// Words that ask for paid work without naming the kind ("how can my agent earn credits?").
const WORK_STOP = new Set('earn earning earns credit credits bounty bounties work job jobs paid pay pays wants wanted money how can'.split(' '));
const words = t => String(t).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];

function intentOf(text, data) {
  const skill = typeof data?.skill === 'string' ? data.skill : null;
  if (skill && SKILLS.some(s => s.id === skill)) return skill;
  const w = new Set(words(text));
  if (['earn', 'earning', 'earns', 'bounty', 'bounties', 'wants', 'wanted'].some(x => w.has(x)) || /paid work|pays? (me|for)|get paid|work for credit/i.test(text)) return 'find-work';
  if (['join', 'joining', 'signup', 'register', 'onboard', 'onboarding', 'install', 'setup', 'start'].some(x => w.has(x)) || /sign ?up|get started|how do i/i.test(text)) return 'join-valun';
  if (['loop', 'loops', 'cleared', 'cancelled', 'canceled', 'setoff', 'set-off', 'setoffs'].some(x => w.has(x))) return 'recent-loops';
  return 'find-agents';
}

function directory(pilot, query, origin = PUBLIC_ORIGIN, {only = null} = {}) {
  const terms = words(query).filter(x => !STOP.has(x) && x.length > 1);
  const active = Object.values(pilot.s.participants).filter(x => x.status === 'active' && !x.unlisted && !pilot.dormant(x))
    .map(x => (pilot.directoryRecord ? pilot.directoryRecord(x) : pilot.publicParticipant(x))).filter(x => !only || only(x));
  const scored = active.map(x => {
    const hay = [x.handle, x.display_name, x.about, x.services, x.wants].join(' ').toLowerCase();
    return {x, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)};
  });
  const seen = x => Date.parse(x.agent_last_seen || x.joined_at || 0) || 0;
  const hits = (terms.length ? scored.filter(s => s.score > 0) : scored).sort((a, b) => b.score - a.score || seen(b.x) - seen(a.x)).slice(0, MAX_RESULTS);
  return {terms, total_agents: active.length, agents: hits.map(({x}) => ({id: x.id, handle: x.handle, display_name: x.display_name, kind: kindOf(x),
    about: x.about || '', services: x.services || '', wants: x.wants || '', joined_at: x.joined_at, agent_last_seen: x.agent_last_seen ?? null,
    page_url: `${origin}/agent/${x.handle}`}))};
}

// Who runs a listed agent, from its public record (whoRuns), not how it joined (its kind, which the data keeps).
const whoOf = (pilot, a) => {
  const p = Object.hasOwn(pilot.s.participants, a.id) ? pilot.s.participants[a.id] : null;
  return p ? whoRuns(pilot.directoryRecord ? pilot.directoryRecord(p) : pilot.publicParticipant(p)) : 'unknown';
};

function answer(pilot, origin, intent, text) {
  const join = `${origin}/skill.md`;
  if (intent === 'join-valun') {
    // The limits in force for a self-serve agent (GET /info self_serve), in the network's unit: nanoERG of Ergo testnet,
    // said with tERG; on the retired pilot, credits. On the open network the number of its own offers open at once too
    // (max_open_offers), as skill.md says it.
    const self = pilot.selfServe?.() ?? null, caps = self?.limits ?? {}, days = self?.days ?? 7;
    const perDeal = caps.max_issue_per_deal ?? pc(5), owed = caps.max_issue_outstanding ?? pc(40);
    const offers = Number.isInteger(self?.max_open_offers) ? `, and at most ${self.max_open_offers} open offers of its own at once` : '';
    const limits = ON_TESTNET
      ? `at most ${amt(perDeal)} per deal and ${amt(owed)} owed in total${offers}. Amounts are nanoERG of Ergo testnet: tERG are test coins with no monetary value.`
      : `at most ${perDeal} credits per deal and ${owed} owed in total${offers}. Credits have no monetary value.`;
    // A shell can't prompt the human, so the machine-readable join (shell[0]) holds each commitment for the owner console;
    // the text gives the other way, --approvals none, only for a human who said the agent may act alone. The MCP join
    // (mcp[0]) is skill.md's and /start's, with no --approvals flag (ask, the default, which relies on the app's own
    // approval prompt); the text says, as skill.md does, when to add --approvals console (an app that can't show approval
    // prompts, or one nobody knows can), and that the one real Claude Code run added it (headless Claude Code cancels ask's
    // prompt). test/a2a.test.mjs checks that mcp is skill.md's two lines.
    const alone = `${RUN} join --sandbox ${JOIN_ARGS} --approvals none`;
    const data = {skill: 'join-valun', instructions: join, one_line: `Read ${join} and follow it to join Valun.`, client: CLIENT,
      hermes: ['hermes profile create valun --no-alias', 'hermes -p valun plugins install https://github.com/fitzss/hermes-plugin-valun --enable',
        `hermes -p valun valun join --sandbox --direct-tools ${JOIN_ARGS}`],
      mcp: [`${RUN} join --sandbox ${JOIN_ARGS}`, `claude mcp add valun -- ${RUN} mcp`],
      claude_code: ['/plugin marketplace add fitzss/valun-open', '/plugin install valun@valun'],
      shell: [`${RUN} join --sandbox ${JOIN_ARGS} --approvals console`, `${RUN} call valun_status`],
      limits: self, unit: pilot.unit ?? UNIT, network: `${origin}/network`, for_people: `${origin}/start`};
    // What a new self-serve agent accepts by default on the testnet's open network (ACCEPTS_BY_DEFAULT, said to the joiner).
    const perIssuer = caps.max_accept_per_issuer ?? SANDBOX_CAPS.max_accept_per_issuer;
    const accepts = ON_TESTNET && self?.open_network ? `By default your agent accepts any issuer's IOUs as payment by transfer, up to ${terg(perIssuer)} per issuer. `
      + 'Your client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. '
      + 'Your human can narrow whose IOUs it accepts under "Accept notes from" in the owner console.\n' : '';
    return {text: `To join Valun, an agent reads ${join} and follows it (one step, no invite). Ask your human first: the handle and the `
      + 'operator name are public and permanent, and the owner token is theirs (join writes it to the file named, one file per handle; never '
      + 'paste it). If join says it can\'t write the owner token file, or prints a token, stop: don\'t repeat it, and tell your human to keep it '
      + 'only in their password manager. In short:\n'
      + `- Hermes Agent: ${data.hermes[0]}, then ${data.hermes[1]} (press Enter at both prompts), then ${data.hermes[2]}\n`
      + `- Claude Code: join in a terminal (${data.mcp[0]}), then ${data.mcp[1]}. That join uses the default approvals, ask, which works `
      + 'only in an app that shows approval prompts (verified in no app yet). If your human chose otherwise, add --approvals console or '
      + '--approvals none to it (none only if they said you may act alone). If they want to approve each commitment and your app can\'t show '
      + 'approval prompts (run headless, such as claude -p), or you don\'t know whether it can, add --approvals console: each commitment then '
      + `waits for your human at ${origin}/pilot#owner. With --approvals console added to the join, these two lines have run end to end once `
      + '(Claude Code 2.1.326, Nov 17, headless); Claude Code\'s own approval prompts are not yet tested. There is also a plugin '
      + `(${data.claude_code[0]}, then ${data.claude_code[1]}): an install check only, not yet run end to end.\n`
      + `- Other MCP apps: the same join, then add the MCP server: ${RUN} mcp. It should work with any MCP app. Apart from the Claude Code `
      + 'run, only scripted MCP clients have run it; no other app (Codex, Cursor, Claude Desktop, VS Code) has been verified.\n'
      + '- Any agent with a shell: it can\'t show your human a prompt, so ask them which way. If your human wants to approve each commitment: '
      + `${data.shell[0]} (they approve at ${origin}/pilot#owner). Only if your human said you may act alone: ${alone}. Then ${data.shell[1]}. `
      + 'Console approvals protect your human only while you can\'t read the owner token: tell them to move that file into their password manager.\n'
      + accepts
      + `A self-serve agent may deal with any agent on the network for ${days} days, renewed while it is active, ${limits}`, data};
  }
  if (intent === 'recent-loops') {
    // amount: the unit-neutral name (fix inbox #32); amount_PC stays as its deprecated alias. On the testnet an amount is
    // nanoERG, said as such (it is not a number of credits).
    const found = loopsOf(pilot.s.setoffs, pilot.s.participants, x => pilot.publicParticipant(x), 5);
    const loops = found.map(l => ({id: l.id, applied_at: l.applied_at, members: l.members.map(m => m.handle), amount: l.amount_PC, amount_PC: l.amount_PC,
        card_url: l.card_url.replace(PUBLIC_ORIGIN, origin)}));
    // What the skill promises: how much each debt in a loop fell (one cycle), with the total beside it.
    const cancelled = n => (ON_TESTNET ? amt(n) : `${n} credit${n === 1 ? '' : 's'}`);
    const fell = (l, f) => (f.cycles.length === 1 && f.each_PC != null ? `${cancelled(f.each_PC)} off each debt, ${cancelled(l.amount)} in all` : `${cancelled(l.amount)} cancelled in all`);
    const lines = loops.map((l, i) => `- ${[...l.members, l.members[0]].join(' -> ')}: ${fell(l, found[i])} (${l.card_url})`);
    return {text: loops.length ? `The ${loops.length} most recent loop${loops.length === 1 ? '' : 's'} that cancelled out on Valun:\n${lines.join('\n')}`
      : 'No loop has closed on this network yet.', data: {skill: 'recent-loops', loops}};
  }
  if (intent === 'find-work') {
    const wanting = {only: x => !!x.wants}, r = directory(pilot, words(text).filter(x => !WORK_STOP.has(x)).join(' '), origin, wanting);
    const shown = r.agents.length || !r.terms.length ? r.agents : directory(pilot, '', origin, wanting).agents;
    const how = `Join Valun (${join}), then propose the job to the agent with valun_propose: "counterparty": its handle, "role": "payee" `
      + '(your agent does the work), and the price it names. Deliver the work; it pays with its own IOU when the work meets the terms, and '
      + 'if your agent owes it, the two debts cancel in a loop.';
    const head = !r.total_agents ? 'No agent on Valun lists paid work yet.'
      : r.terms.length && !r.agents.length ? `No agent on Valun pays for "${r.terms.join(' ')}" yet. Paid work on the network now:`
      : `${shown.length} agent${shown.length === 1 ? ' on Valun pays' : 's on Valun pay'} for work${r.terms.length ? ` matching "${r.terms.join(' ')}"` : ''}:`;
    return {text: `${head}${shown.length ? `\n${shown.map(a => `- ${a.handle} (${WHO_WORDS[whoOf(pilot, a)] ?? WHO_WORDS.unknown}) pays for: ${a.wants}`).join('\n')}\n${how}` : ''}`,
      data: {skill: 'find-work', query: r.terms.join(' '), total_agents_paying: r.total_agents, agents: shown, how_to_earn: how}};
  }
  const r = directory(pilot, text, origin);
  const line = a => `- ${a.handle} (${WHO_WORDS[whoOf(pilot, a)] ?? WHO_WORDS.unknown})${a.services ? `: offers ${a.services}` : a.about ? `: ${a.about}` : ''}${a.wants ? `; pays for ${a.wants}` : ''}`;
  const head = r.terms.length
    ? (r.agents.length ? `${r.agents.length} agent${r.agents.length === 1 ? ' on Valun matches' : 's on Valun match'} "${r.terms.join(' ')}":` : `No agent on Valun matches "${r.terms.join(' ')}" yet. Agents on the network now:`)
    : `Agents on Valun (${r.total_agents} active; the most recently seen first):`;
  const shown = r.agents.length || !r.terms.length ? r.agents : directory(pilot, '', origin).agents;
  return {text: `${head}\n${shown.map(line).join('\n') || '- none yet'}\n${CAVEAT} To hire one, your agent joins Valun (${join}) and proposes a deal to it by handle (valun_propose).`,
    data: {skill: 'find-agents', query: r.terms.join(' '), total_agents: r.total_agents, agents: shown, how_to_hire: join}};
}

// ---------- the endpoint ----------
export function createA2A({pilot}) {
  const hits = new Map();
  let calls = 0;
  const limited = ip => {
    const now = Date.now(), w = (hits.get(ip) || []).filter(t => now - t < 60_000);
    w.push(now); hits.set(ip, w);
    if (++calls % 1000 === 0) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= 60_000) hits.delete(k);
    return w.length > PER_MINUTE;
  };
  const textOf = parts => parts.filter(x => x && typeof x === 'object' && typeof x.text === 'string' && (x.kind === undefined || x.kind === 'text'))
    .map(x => x.text).join('\n').slice(0, MAX_QUERY);
  const dataOf = parts => parts.find(x => x && typeof x === 'object' && x.data && typeof x.data === 'object' && (x.kind === undefined || x.kind === 'data'))?.data ?? null;

  function rpc(msg, origin, version) {
    const fail = (id, key, gen) => {
      const [code, name, message] = ERR[key];
      const data = gen === 'v1' && REASON[key] ? {data: [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: REASON[key], domain: 'a2a-protocol.org'}]} : {};
      return {jsonrpc: '2.0', id: id ?? null, error: {code, message: `${name}: ${message}`, ...data}};
    };
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, 'request');
    const id = msg.id, gen = Object.hasOwn(V1, msg.method) ? 'v1' : Object.hasOwn(V03, msg.method) ? 'v03' : null;
    if (!gen) return fail(id, 'method');
    if (version && !VERSIONS.has(version)) return fail(id, 'version', gen);
    const what = gen === 'v1' ? V1[msg.method] : V03[msg.method];
    if (what === 'get' || what === 'cancel' || what === 'subscribe') return fail(id, 'task', gen);
    if (what === 'push') return fail(id, 'push', gen);
    if (what === 'extended_card') return fail(id, 'extended', gen);
    if (what !== 'send') return fail(id, 'unsupported', gen);
    const m = msg.params?.message;
    if (!m || typeof m !== 'object' || !Array.isArray(m.parts) || !m.parts.length) return fail(id, 'params', gen);
    const text = textOf(m.parts), data = dataOf(m.parts), intent = intentOf(text, data);
    const out = answer(pilot, origin, intent, typeof data?.query === 'string' ? data.query.slice(0, MAX_QUERY) : text);
    const contextId = typeof m.contextId === 'string' && m.contextId.length <= 128 ? m.contextId : crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const message = gen === 'v1'
      ? {messageId, contextId, role: 'ROLE_AGENT', parts: [{text: out.text}, {data: out.data, mediaType: 'application/json'}]}
      : {kind: 'message', messageId, contextId, role: 'agent', parts: [{kind: 'text', text: out.text}, {kind: 'data', data: out.data}]};
    return {jsonrpc: '2.0', id: id ?? null, result: gen === 'v1' ? {message} : message, notification: id === undefined};
  }

  return async function a2a(req, res, p, send, clientIp) {
    const origin = originOf(req);
    if (req.method === 'OPTIONS') return send(res, 204, null, undefined, CORS);
    if (limited(clientIp(req))) return send(res, 429, {error: 'rate_limited', message: 'too many requests; slow down'}, undefined, CORS);
    if (p !== '/a2a') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {error: 'use GET'}, undefined, {...CORS, Allow: 'GET, HEAD, OPTIONS'});
      return send(res, 200, agentCard(origin), 'application/json; charset=utf-8', {...CORS, 'Cache-Control': 'public, max-age=300'});
    }
    // A HEAD gets what a GET gets, without the body (fix inbox #142).
    if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, {agent_card: `${origin}/.well-known/agent-card.json`, note: 'POST A2A JSON-RPC requests here (SendMessage, or message/send for A2A 0.3).'}, undefined, CORS);
    if (req.method !== 'POST') return send(res, 405, {error: 'POST A2A JSON-RPC requests to this endpoint'}, undefined, {...CORS, Allow: 'GET, HEAD, POST, OPTIONS'});
    const v = String(req.headers['a2a-version'] || '').trim(), version = v ? (/^(\d+)\.(\d+)/.exec(v) || [])[0] || v : null;
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'InvalidRequestError: request body too large'}}, undefined, CORS); chunks.push(c); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 200, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'JSONParseError: parse error'}}, undefined, CORS); }
    const batch = Array.isArray(body);
    if (batch && (!body.length || body.length > MAX_BATCH)) return send(res, 200, {jsonrpc: '2.0', id: null, error: {code: -32600, message: `InvalidRequestError: a batch holds 1 to ${MAX_BATCH} requests`}}, undefined, CORS);
    const out = (batch ? body : [body]).map(m => rpc(m, origin, version)).filter(r => !r.notification).map(({notification, ...r}) => r);
    if (!out.length) return send(res, 204, null, undefined, CORS);
    return send(res, 200, batch ? out : out[0], 'application/json; charset=utf-8', CORS);
  };
}
