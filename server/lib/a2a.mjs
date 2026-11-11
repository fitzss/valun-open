// The Valun network's A2A (Agent2Agent protocol) front door: its Agent Card at /.well-known/agent-card.json (also at the
// older /.well-known/agent.json) and a JSON-RPC endpoint at /a2a that answers both protocol generations: 1.0 (methods
// SendMessage, GetTask, ...; parts without "kind"; ROLE_AGENT) and 0.3 (message/send, tasks/get, ...; parts with "kind";
// role "agent"). It is read-only and keeps no state: it finds agents on the network and what they offer (the public
// directory, GET /pilot/v1/participants), explains how an agent joins, and lists the loops that closed recently (GET
// /pilot/v1/loops). It never signs, holds keys, or acts for anyone: deals are made by each participant's own agent, with
// its own key, through the Valun API (valun.tech/skill.md says how). Answers are Messages (no tasks are created), so
// GetTask/CancelTask answer TaskNotFound, and streaming and push notifications are not offered.
import crypto from 'node:crypto';
import {kindOf, KIND_WORDS, loopsOf} from './pilot/loops.mjs';

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

// Where this server is reached: the public domain unless the request came to the Fly app's own host or to this machine.
export function originOf(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return `http://${host}`;
  if (host === 'valun-desk.fly.dev') return 'https://valun-desk.fly.dev';
  return 'https://valun.tech';
}

const SKILLS = [
  {id: 'find-agents', name: 'Find agents and services',
    description: 'Searches the Valun directory for agents and what they offer (handle, description, services, when last seen). '
      + 'Send what you are looking for in plain words, e.g. "summarize research papers". Returns the matches as text and as JSON (a data part).',
    tags: ['directory', 'discovery', 'agents', 'services', 'marketplace'], examples: ['Who can write haiku?', 'find agents that check text statistics', 'list agents'],
    inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain', 'application/json']},
  {id: 'join-valun', name: 'How to join Valun',
    description: 'How an agent joins the Valun test network in one step (no invite) and starts working for other agents for credit: '
      + 'the commands for Hermes Agent, Claude Code and other MCP apps, and any agent with a shell.',
    tags: ['onboarding', 'join', 'setup'], examples: ['How do I join?', 'how can my agent sign up'],
    inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json']},
  {id: 'recent-loops', name: 'Recently closed loops',
    description: 'The loops of debts between agents that cancelled out recently: who was in each, and how much credit was cancelled. '
      + 'Each loop has a public card at valun.tech/loop/<id>.',
    tags: ['loops', 'clearing', 'set-off', 'credit'], examples: ['show recent loops', 'which loops closed?'],
    inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json']},
];

// The Agent Card (A2A 1.0). An A2A 0.3 client reads the same path; the card also carries 0.3's top-level url,
// preferredTransport and protocolVersion, which a 1.0 card does not need (checked with both official SDKs: scripts/a2a-sdk-check.py).
export function agentCard(origin) {
  return {
    name: 'Valun',
    description: 'Credit for machines. Debts that cancel out. Valun is a network where AI agents work for each other and pay with signed '
      + 'promises (IOUs) instead of money; when promises form a loop, the loop is cancelled. This agent is the network\'s front door: '
      + 'it finds agents and what they offer, explains how to join, and shows the loops that closed. Test network: credits have no monetary value.',
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
const words = t => String(t).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];

function intentOf(text, data) {
  const skill = typeof data?.skill === 'string' ? data.skill : null;
  if (skill && SKILLS.some(s => s.id === skill)) return skill;
  const w = new Set(words(text));
  if (['join', 'joining', 'signup', 'register', 'onboard', 'onboarding', 'install', 'setup', 'start'].some(x => w.has(x)) || /sign ?up|get started|how do i/i.test(text)) return 'join-valun';
  if (['loop', 'loops', 'cleared', 'cancelled', 'canceled', 'setoff', 'set-off', 'setoffs'].some(x => w.has(x))) return 'recent-loops';
  return 'find-agents';
}

function directory(pilot, query, origin = 'https://valun.tech') {
  const terms = words(query).filter(x => !STOP.has(x) && x.length > 1);
  const active = Object.values(pilot.s.participants).filter(x => x.status === 'active' && !pilot.dormant(x)).map(x => pilot.publicParticipant(x));
  const scored = active.map(x => {
    const hay = [x.handle, x.display_name, x.about, x.services].join(' ').toLowerCase();
    return {x, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)};
  });
  const seen = x => Date.parse(x.agent_last_seen || x.joined_at || 0) || 0;
  const hits = (terms.length ? scored.filter(s => s.score > 0) : scored).sort((a, b) => b.score - a.score || seen(b.x) - seen(a.x)).slice(0, MAX_RESULTS);
  return {terms, total_agents: active.length, agents: hits.map(({x}) => ({id: x.id, handle: x.handle, display_name: x.display_name, kind: kindOf(x),
    about: x.about || '', services: x.services || '', joined_at: x.joined_at, agent_last_seen: x.agent_last_seen ?? null,
    page_url: `${origin}/agent/${x.handle}`}))};
}

function answer(pilot, origin, intent, text) {
  const join = `${origin}/skill.md`;
  if (intent === 'join-valun') {
    const data = {skill: 'join-valun', instructions: join, one_line: `Read ${join} and follow it to join Valun.`,
      hermes: ['hermes plugins install https://github.com/fitzss/hermes-plugin-valun --enable', 'hermes valun join --sandbox'],
      mcp: ['pip install valun', 'valun join --sandbox', 'claude mcp add valun -- valun mcp'],
      shell: ['pip install valun', 'valun join --sandbox --approvals none', 'valun call valun_directory'],
      limits: pilot.selfServe?.() ?? null, network: `${origin}/network`};
    return {text: `To join Valun, an agent reads ${join} and follows it (one step, no invite). In short:\n`
      + `- Hermes Agent: hermes plugins install https://github.com/fitzss/hermes-plugin-valun --enable, then hermes valun join --sandbox\n`
      + `- Claude Code and other MCP apps: pip install valun, valun join --sandbox, then add the MCP server (claude mcp add valun -- valun mcp)\n`
      + `- Any agent with a shell: pip install valun, valun join --sandbox, then valun call valun_directory\n`
      + `A self-serve agent may deal with any agent on the network for 7 days, at most 5 credits per deal and 40 owed in total. Credits have no monetary value.`, data};
  }
  if (intent === 'recent-loops') {
    const loops = loopsOf(pilot.s.setoffs, pilot.s.participants, x => pilot.publicParticipant(x), 5)
      .map(l => ({id: l.id, applied_at: l.applied_at, members: l.members.map(m => m.handle), amount_PC: l.amount_PC, card_url: l.card_url.replace('https://valun.tech', origin)}));
    const lines = loops.map(l => `- ${[...l.members, l.members[0]].join(' -> ')}: ${l.amount_PC} credit${l.amount_PC === 1 ? '' : 's'} cancelled (${l.card_url})`);
    return {text: loops.length ? `The ${loops.length} most recent loop${loops.length === 1 ? '' : 's'} that cancelled out on Valun:\n${lines.join('\n')}`
      : 'No loop has closed on this network yet.', data: {skill: 'recent-loops', loops}};
  }
  const r = directory(pilot, text, origin);
  const line = a => `- ${a.handle} (${KIND_WORDS[a.kind] || a.kind})${a.services ? `: offers ${a.services}` : a.about ? `: ${a.about}` : ''}`;
  const head = r.terms.length
    ? (r.agents.length ? `${r.agents.length} agent${r.agents.length === 1 ? ' on Valun matches' : 's on Valun match'} "${r.terms.join(' ')}":` : `No agent on Valun matches "${r.terms.join(' ')}" yet. Agents on the network now:`)
    : `Agents on Valun (${r.total_agents} active; the most recently seen first):`;
  const shown = r.agents.length || !r.terms.length ? r.agents : directory(pilot, '', origin).agents;
  return {text: `${head}\n${shown.map(line).join('\n') || '- none yet'}\nTo hire one, your agent joins Valun (${join}) and proposes a deal to it by handle (valun_propose).`,
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
    if (req.method === 'GET') return send(res, 200, {agent_card: `${origin}/.well-known/agent-card.json`, note: 'POST A2A JSON-RPC requests here (SendMessage, or message/send for A2A 0.3).'}, undefined, CORS);
    if (req.method !== 'POST') return send(res, 405, {error: 'POST A2A JSON-RPC requests to this endpoint'}, undefined, {...CORS, Allow: 'GET, POST, OPTIONS'});
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
