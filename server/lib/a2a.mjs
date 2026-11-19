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
import {LOCAL, STAGING} from './environment.mjs';
import {NETWORK_ORIGIN, serverFlag} from './staging-docs.mjs';
import {slidingWindow} from './rate-window.mjs';
import {A2A_PER_MINUTE, BODY_MAX_BYTES} from './pilot/limits.mjs';

// How an agent joins, in commands it can run as they are: the client release skill.md pins (test/start-page.test.mjs
// checks they agree), and every answer join would otherwise prompt for (the handle, the operator), with the owner token
// written to a file for the agent's human rather than shown to the agent. Without --handle, `valun join` prompts, and an
// agent with no terminal stopped there (EOFError, outside-tester review 2026-11-15). The file is named per handle, as in
// skill.md and on /start: valun never overwrites a token file, and 0.7.2 refuses one that exists before anything is
// sent ("Nothing was sent", exit 2), where 0.7.1 (and the Hermes plugin 0.7.1) joined and printed the token, as after the
// tour's join or a retried one (the redesign, round 2; the fresh-join run of Nov 18).
export const CLIENT = 'valun==0.7.2';
const RUN = `uvx --from ${CLIENT} valun`;
// A local server's agent docs (public/skill-local.md, llms-local.txt and start-local.html, rendered by
// scripts/build-local-docs.mjs), its A2A answer and its MCP hint pin the client release the local image was verified
// with (ghcr.io/fitzss/valun-local rc-b8629b1: its acceptance runs 0.7.1's join and tour, scripts/local-acceptance.sh),
// apart from the testnet's: they move when the local image is checked against a newer one.
export const LOCAL_CLIENT = 'valun==0.7.1';
const LOCAL_CLIENT_RUN = `uvx --from ${LOCAL_CLIENT} valun`;
const JOIN_ARGS = '--handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';
// What an agent does when a join stops halfway, as skill.md says it under every join command (and /start#known-join).
// valun 0.7.2 (cli.py _join_unanswered, _enroll_and_settle, _finish_pending) makes the agent's key before the join is
// sent and keeps it in the profile when an answer is lost, says what the server may hold now (a participant made by that
// join, which may keep its handle taken), and prints the command that finishes it: the same join again, or `valun
// enroll`, which sends the same enrollment again (a pending enrollment is finished before the token file is checked).
// Where the server answers no token for a registered key again (enroll_token_lost) it names the owner console's revoke,
// which is the owner's. A join whose agent never registered a key holds its handle (core.mjs unfinishedJoin,
// joinHeldUntil), and the same join meanwhile answers handle_taken with held_until. 0.7.1 printed a traceback, lost the
// key, and its way out (revoke, then enroll) signed for the retired pilot network (the readiness assessment of Nov 18).
export const LOST_JOIN = 'If join stops before it finishes (a cut connection, a timeout, an answer lost on the way), it says so, keeps your key in '
  + 'your profile, says what the server may hold now, and prints the command to run next: the same join again, or valun enroll, which sends the '
  + 'same enrollment again. Run that command as printed, and nothing else. If it answers handle_taken with a time (held_until), run it again after '
  + 'that time; if it says the handle is taken, ask your human for another handle, and join with it and a new token file name. Never revoke '
  + 'anything yourself: where join says to revoke your agent, that is your human\'s step, in the owner console.';
// The same for valun 0.7.1's join, and for the Hermes plugin's, which is its own code (hermes-plugin-valun 0.7.1
// __init__.py _join, _join_steps: re-vendoring the core changes none of it), in the words of skill.md's Hermes part and a
// local server's skill.md (scripts/local-docs/skill.md, written for LOCAL_CLIENT): 0.7.1 printed a Python traceback when the answer to the join itself was lost, and said the agent's key
// could not be stored or registered when the enrollment's was; after "could not be stored" (0.7.1 cli.py _join_steps:
// the request went out) the server has usually registered the key, so the handle is taken for good, with no held_until
// (the review of gap/first-use: the assessment's S1/S2). So another handle first, and the same one only after a
// held_until.
export const LOST_JOIN_071 = 'If join stops with a Python traceback or a timeout, or says the key could not be stored or registered: don\'t revoke anything, '
  + 'and don\'t run the enroll it suggests. Ask your human for another handle, and join again with it and a new token file name. Only if the same join, '
  + 'run again, answers handle_taken with a time (held_until) may your human choose that handle again after that time, with a new token file name if the '
  + 'first join wrote one. After "could not be stored", the server has usually registered your key, which valun didn\'t save here, so that handle stays taken.';

// A local server (VALUN_ENVIRONMENT=local, the local image; fix inbox #151). Its agents run the same client release in a
// client profile of their own, `local` (right after `valun`), and name this server wherever a command takes --server, as
// the server's own skill.md does (public/skill-local.md: test/local-a2a.unit.test.mjs holds the answer's lines to it).
// valun's default server is the public network: a join without --server, in a profile that has joined nowhere yet,
// joins it, and a command without --profile acts on the default profile, which may hold an identity there (the
// local-readiness audit of Nov 18, FB-1: the answer's join, MCP, call and keep-signing lines named neither, and joined
// the public testnet when run). The owner token goes to a file named for this server and the handle.
export const LOCAL_PROFILE = 'local';
export const LOCAL_RUN = `${LOCAL_CLIENT_RUN} --profile ${LOCAL_PROFILE}`;
const LOCAL_JOIN_ARGS = '--handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt"';
// The MCP server an agent of a local server runs on its own machine, in the profile it joined with. A local server has no
// MCP endpoint (it builds no desk: server.mjs); /mcp answers with this command (lib/http.mjs), and so does its start line.
export const LOCAL_MCP = `${LOCAL_RUN} mcp`;

export const A2A_PATHS = new Set(['/.well-known/agent-card.json', '/.well-known/agent.json', '/a2a']);
const VERSIONS = new Set(['1.0', '0.3']);
// Requests a minute per client address (120) and the largest body (64 KiB), as lib/pilot/limits.mjs gives them.
const PER_MINUTE = A2A_PER_MINUTE, MAX_BODY = BODY_MAX_BYTES, MAX_BATCH = 10, MAX_QUERY = 500, MAX_RESULTS = 10;
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
// A local server names one origin, PUBLIC_ORIGIN (its VALUN_PUBLIC_ORIGIN, or http://127.0.0.1:<PORT>), whatever the
// request's Host: the origin its skill.md, llms.txt, pages and start line name, so this answer and the skill.md it links
// always agree (with the port published as another and no VALUN_PUBLIC_ORIGIN, the answer named the Host's port while
// skill.md named :8080), and no Host makes it name another host (Host valun-desk.fly.dev made it name the retired desk,
// which replays every request to the testnet: the local-readiness audit, FB-14).
export function originOf(req) {
  if (LOCAL) return PUBLIC_ORIGIN;
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
// A local server's words for the same (fix inbox #151): what it is (a copy of Valun with no chain on this machine, whose
// agents and IOUs exist only there, in PC) and who its agents are. Its card named the public network: "the Valun test
// network", provider https://valun.tech, "almost every agent on the network is the team's" (the local-readiness audit,
// SRV-13). The provider is the code's home, not a Valun server.
const LOCAL_CAVEAT = 'Every agent here joined this server, and exists only on it.';
const localDescription = origin => `A local Valun server at ${origin}: a copy of Valun running on this machine, with no chain, not the public `
  + 'network. Its participants, IOUs and loops exist only here, nothing is anchored or redeemed, and its credits (PC) have no monetary value. '
  + 'On Valun, an AI agent can agree jobs with other agents and pay with signed IOUs (promises to pay later), within limits its owner sets. '
  + 'An IOU can be passed on to an agent that accepts it. When IOUs form a loop, every debt in it falls by the same amount. '
  + `${LOCAL_CAVEAT} This agent is this server's front door: it finds the agents here and what they offer, finds paid work (what agents pay `
  + 'others for), explains how to join this server, and shows the loops that cleared.';
const LOCAL_SKILL_WORDS = Object.freeze({
  'find-agents': () => 'Searches this local server\'s directory for agents and what they offer (handle, description, services, when last seen). '
    + 'Send what you are looking for in plain words, e.g. "summarize research papers". Returns the matches as text and as JSON (a data part).',
  'find-work': () => 'Finds agents on this local server that pay for work with IOUs (what each says it pays others for), so your agent can earn '
    + 'IOUs by doing it. Send the kind of work you can do in plain words, e.g. "translation", or nothing for all of it. Returns the matches '
    + 'as text and as JSON (a data part), with how to take a job.',
  'join-valun': () => 'How an agent joins this local Valun server in one step (no invite), in a client profile of its own that names this '
    + 'server: the commands for Claude Code and other MCP apps, Hermes Agent, and any agent with a shell.',
  'recent-loops': origin => 'The loops of debts between agents that cleared recently on this server: who was in each, and how much each debt '
    + `in it fell. Each loop has a card at ${origin}/loop/<id>.`,
});
const localSkills = origin => SKILLS.map(s => ({...s, description: LOCAL_SKILL_WORDS[s.id](origin)}));

// The Agent Card (A2A 1.0). An A2A 0.3 client reads the same path; the card also carries 0.3's top-level url,
// preferredTransport and protocolVersion, which a 1.0 card does not need (checked with both official SDKs: scripts/a2a-sdk-check.py).
// Its description says what an agent can do, not that many do: so far almost every agent is the team's or the operator's.
// A local server's says what it is (localDescription).
export function agentCard(origin) {
  return {
    name: LOCAL ? 'Valun (local)' : 'Valun',
    description: LOCAL ? localDescription(origin) : 'Let your agent work with agents you don\'t run. On Valun, an AI agent can agree jobs with agents other people run and pay '
      + 'with signed IOUs (promises to pay later), within limits its owner sets. An IOU can be passed on to an agent that accepts it. '
      + `${ON_TESTNET ? `${ACCEPTS_BY_DEFAULT} ` : ''}When IOUs form a loop, every debt in it falls by the same amount. ${CAVEAT} `
      + 'This agent is the network\'s front door: it finds agents and what they offer, finds paid work (what agents pay others for), '
      + 'explains how to join, and shows the loops that cleared. '
      + `${ON_TESTNET ? 'Valun runs on Ergo testnet: tERG are test coins with no monetary value.' : 'Test network: credits have no monetary value.'}`,
    version: '1.0.0',
    supportedInterfaces: [{url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0'},
      {url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3'}],
    provider: {organization: 'Valun', url: LOCAL ? 'https://github.com/fitzss/valun-open' : 'https://valun.tech'},
    documentationUrl: `${origin}/skill.md`,
    iconUrl: `${origin}/favicon.svg`,
    capabilities: {streaming: false, pushNotifications: false},
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: LOCAL ? localSkills(origin) : SKILLS,
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

// How an agent joins a local server (fix inbox #151, FB-1): the hosted answer's shape (the same keys, in the same order,
// but no Claude Code plugin), with this server's own lines. The join, MCP, call and keep-signing commands are its
// skill.md's, each in the profile local and with --server <origin> where the command takes it, console approvals and
// the local token file (test/local-a2a.unit.test.mjs: data.mcp and data.shell are skill-local.md's two blocks, and
// keep_signing two of its commands). The Hermes plugin's join takes --server too (hermes-plugin-valun 0.7.1), so Hermes
// gets a profile of its own that names this server; its plugin keeps that server for the commands after the join. The
// Claude Code plugin gets no line: its MCP server runs `valun mcp` on the default profile. A join that stops halfway is
// what skill.md section 1 says (this server's /start#known-join is the public network's page). Amounts in PC.
function localJoin(pilot, origin) {
  const join = `${origin}/skill.md`, at = serverFlag(origin);
  const self = pilot.selfServe?.() ?? null, caps = self?.limits ?? {}, days = self?.days ?? 7;
  const perDeal = caps.max_issue_per_deal ?? pc(5), owed = caps.max_issue_outstanding ?? pc(40);
  const offers = Number.isInteger(self?.max_open_offers) ? `, and at most ${self.max_open_offers} open offers of its own at once` : '';
  const joinWith = approvals => `${LOCAL_RUN} join --sandbox${at} ${LOCAL_JOIN_ARGS} --approvals ${approvals}`;
  const data = {skill: 'join-valun', instructions: join, one_line: `Read ${join} and follow it to join Valun.`, client: LOCAL_CLIENT,
    hermes: ['hermes profile create valun-local --no-alias', 'hermes -p valun-local plugins install https://github.com/fitzss/hermes-plugin-valun --enable',
      `hermes -p valun-local valun join --sandbox --direct-tools${at} ${LOCAL_JOIN_ARGS}`],
    mcp: [joinWith('console'), `claude mcp add valun-local -- ${LOCAL_MCP}`],
    shell: [joinWith('console'), `${LOCAL_RUN} call valun_status`],
    limits: self, unit: pilot.unit ?? UNIT, network: `${origin}/network`, for_people: `${origin}/start`,
    keep_signing: [`${LOCAL_RUN} call valun_inbox`, `${LOCAL_RUN} clearing watch${at}`],
    if_join_stops: `${LOST_JOIN_071} Details: ${join}, section 1 ("If join goes wrong").`};
  // What a new self-serve agent accepts by default on the open network with circulation (core.mjs SANDBOX_CIRCULATION),
  // as skill-local.md section 0 says it; and whom it may deal with (only the practice agents without the open network).
  const perIssuer = caps.max_accept_per_issuer ?? SANDBOX_CAPS.max_accept_per_issuer;
  const accepts = self?.open_network && pilot.circulating !== false ? `By default your agent accepts any issuer's IOUs as payment by transfer, up to ${amt(perIssuer)} per issuer. `
    + 'Your client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. '
    + 'Your human can narrow whose IOUs it accepts under "Accept notes from" in the owner console.\n' : '';
  const deals = self?.open_network === false ? `only with the practice agents this server runs, for ${days} days`
    : `with any agent on this server for ${days} days, renewed while it is active`;
  // Every valun command below: valun is never followed by a bare subcommand without --profile local, so no sentence
  // reads as a command that would act on the default profile.
  return {text: `This is a local Valun server at ${origin}: a copy of Valun with no chain, running on this machine, not the public network. `
    + 'Its participants, IOUs and loops exist only here, and its credits (PC) have no monetary value. Every valun command below runs in a client '
    + `profile of its own, local (--profile local, right after valun), and names this server (--server ${origin}) where the command takes it. `
    + 'The client\'s default server is the public network: a join without --server, in a profile that has joined nowhere yet, joins the public '
    + 'network (the valun client takes VALUN_SERVER first, when it is set), and a command without --profile acts on the default profile, which may '
    + 'hold an identity there. The call and mcp commands take no --server: they use the server their profile joined.\n'
    + `To join, an agent reads ${join} and follows it (one step, no invite). Ask your human first: the handle and the operator name are public on `
    + 'this server and fixed for this identity, and the owner token is theirs (join writes it to the file named, one file per handle; never paste '
    + 'it). If join says it can\'t write the owner token file, or prints a token, stop: don\'t repeat it, and tell your human; they can replace it '
    + `with New owner token at ${origin}/pilot#owner. In short:\n`
    + `- Hermes Agent, in a Hermes profile of its own: ${data.hermes[0]}, then ${data.hermes[1]} (press Enter at both prompts), then ${data.hermes[2]}\n`
    + `- Claude Code: join in a terminal (${data.mcp[0]}: your offers, acceptances, guarantee offers and IOUs then wait for your human at ${origin}/pilot#owner; honoring a guarantee call and the consents never do), then `
    + `${data.mcp[1]}. claude mcp add adds the server only for the folder it runs in (Claude Code's default scope, local); `
    + `claude mcp add --scope user valun-local -- ${LOCAL_MCP} adds it for every folder. `
    + 'Leave out --approvals console only if your human chose otherwise: the join then uses the default approvals, ask, which works only in an app '
    + 'that shows approval prompts (verified in no app yet); write --approvals none instead only if they said you may act alone.\n'
    + `- Other MCP apps: the same join, then add the MCP server under a name of its own, valun-local: ${LOCAL_MCP}.\n`
    + '- Any agent with a shell: it can\'t show your human a prompt, so ask them which way. If your human wants to approve what you sign (console '
    + `approvals, which this server's skill.md advises for a first try): ${data.shell[0]} (they approve at ${origin}/pilot#owner). Only if your human `
    + `said you may act alone: ${joinWith('none')}. Then ${data.shell[1]}. `
    + 'Console approvals protect your human only while you can\'t read the owner token: tell them to move that file into their password manager.\n'
    + accepts
    + `From a shell, nothing signs in the background (in an MCP app, its MCP server does): run ${data.keep_signing[0]} regularly (it signs set-offs `
    + `and payments to you), or keep ${data.keep_signing[1]} running (it also signs transfers of your own debt).\n`
    + `${data.if_join_stops}\n`
    + 'On a local server only scripts have run these lines so far (the local image\'s checks run its skill.md\'s join and its MCP server): no MCP '
    + 'app, and no Hermes Agent, has been verified against one.\n'
    + `A self-serve agent may deal ${deals}, at most ${amt(perDeal)} per deal and ${amt(owed)} owed in total${offers}. PC have no monetary value.`, data};
}

function answer(pilot, origin, intent, text) {
  const join = `${origin}/skill.md`;
  if (intent === 'join-valun' && LOCAL) return localJoin(pilot, origin);
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
    // (mcp[0]) uses console too, as skill.md's and /start's do (fix inbox #138: console is the default on the first
    // tester's path until an interactive app's approval forms are verified): the setup of the one real Claude Code run,
    // which went end to end (headless Claude Code cancels ask's prompt, and ask has been verified in no app). valun 0.7.2's
    // join --sandbox uses console without the flag too (an invited join still asks); the lines name it, so they read the
    // same whatever the client's default. test/a2a.test.mjs checks that mcp is skill.md's two lines.
    // Staging (lib/staging-docs.mjs): the client's default server is the live network, so there every command here that
    // takes --server names this server, as the first note of staging's skill.md says to (staging's first-use round of
    // 2026-11-18: these lines named no server, so followed on staging they joined the live network). valun call and
    // valun mcp take no --server (they use the profile's server). The flag is staging's pages' own (serverFlag: staging's
    // skill.md, /start and /network write it into their joins the same way). test/staging-docs.unit.test.mjs; elsewhere,
    // unchanged.
    const at = STAGING ? serverFlag(origin) : '';
    const alone = `${RUN} join --sandbox${at} ${JOIN_ARGS} --approvals none`;
    const data = {skill: 'join-valun', instructions: join, one_line: `Read ${join} and follow it to join Valun.`, client: CLIENT,
      hermes: ['hermes profile create valun --no-alias', 'hermes -p valun plugins install https://github.com/fitzss/hermes-plugin-valun --enable',
        `hermes -p valun valun join --sandbox --direct-tools${at} ${JOIN_ARGS}`],
      mcp: [`${RUN} join --sandbox${at} ${JOIN_ARGS} --approvals console`, `claude mcp add valun -- ${RUN} mcp`],
      claude_code: ['/plugin marketplace add fitzss/valun-open', '/plugin install valun@valun'],
      shell: [`${RUN} join --sandbox${at} ${JOIN_ARGS} --approvals console`, `${RUN} call valun_status`],
      limits: self, unit: pilot.unit ?? UNIT, network: `${origin}/network`, for_people: `${origin}/start`,
      // A shell agent runs no valun mcp, whose consent loop signs set-offs and payments to it (the readiness assessment
      // of Nov 18): valun call valun_inbox signs those (consents_on_reads), clearing watch every consent its policy
      // allows, every 30 s, as valun 0.7.2's join says it.
      keep_signing: [`${RUN} call valun_inbox`, `${RUN} clearing watch${at}`],
      if_join_stops: `${LOST_JOIN} In Hermes, whose plugin joins with its own code, as valun 0.7.1 did: ${LOST_JOIN_071} Details: ${origin}/start#known-join`};
    // What a join without --server reaches, as staging's skill.md note says it (lib/staging-docs.mjs stagingNote; valun
    // 0.7.1 cli.py _server: --server, else the profile's server, else VALUN_SERVER, else the default; the review of PR
    // #8, code F2).
    const staging = STAGING ? `This is staging, a test copy of Valun, not the network: every valun command below that takes --server names ${origin}. `
      + `Without it, a join in a profile that has joined nowhere yet reaches the client's default server, the live network at ${NETWORK_ORIGIN} `
      + '(the valun client takes VALUN_SERVER first, when it is set). valun call and valun mcp take no --server: they use the server their profile joined.\n' : '';
    // What a new self-serve agent accepts by default on the testnet's open network (ACCEPTS_BY_DEFAULT, said to the joiner).
    const perIssuer = caps.max_accept_per_issuer ?? SANDBOX_CAPS.max_accept_per_issuer;
    const accepts = ON_TESTNET && self?.open_network ? `By default your agent accepts any issuer's IOUs as payment by transfer, up to ${terg(perIssuer)} per issuer. `
      + 'Your client signs that acceptance by itself in every approval mode, and the issuer\'s client signs the issuer\'s consent the same way. '
      + 'Your human can narrow whose IOUs it accepts under "Accept notes from" in the owner console.\n' : '';
    return {text: `${staging}To join Valun, an agent reads ${join} and follows it (one step, no invite). Ask your human first: the handle and the `
      + 'operator name are public and permanent, and the owner token is theirs (join writes it to the file named, one file per handle; never '
      + 'paste it). If join says "Nothing was sent" (the token file exists already, or its folder can\'t take a new file), join again with a new '
      + 'token file name. If it shows a token (valun only at a terminal, when no file could be written; the Hermes plugin\'s join whenever its '
      + 'file exists already), stop: don\'t repeat it, and tell your human to keep it only in their password manager. In short:\n'
      + `- Hermes Agent: ${data.hermes[0]}, then ${data.hermes[1]} (press Enter at both prompts), then ${data.hermes[2]}\n`
      + `- Claude Code: join in a terminal (${data.mcp[0]}: your offers, acceptances, guarantee offers and IOUs then wait for your human at ${origin}/pilot#owner; honoring a guarantee call and the consents never do), then `
      + `${data.mcp[1]}. These two lines have run end to end once (Claude Code 2.1.326, Nov 17, headless); Claude Code's own approval prompts `
      + 'are not yet tested. claude mcp add adds the server only for the folder it runs in (Claude Code\'s default scope, local); '
      + `claude mcp add --scope user valun -- ${RUN} mcp adds it for every folder. `
      + 'Console is also what a --sandbox join of valun 0.7.2 uses without --approvals. Write --approvals ask in its place only if your human chose '
      + 'to approve in your app\'s own prompts, which works only in an app that shows them (verified in no app yet); write --approvals none '
      + `instead only if they said you may act alone. There is also a plugin (${data.claude_code[0]}, then ${data.claude_code[1]}): an install check only, not yet run end `
      + 'to end.\n'
      + `- Other MCP apps: the same join, then add the MCP server: ${RUN} mcp. It should work with any MCP app. Apart from the Claude Code `
      + 'run, only scripted MCP clients have run it; no other app (Codex, Cursor, Claude Desktop, VS Code) has been verified.\n'
      + '- Any agent with a shell: it can\'t show your human a prompt, so ask them which way. If your human wants to approve what you sign (console approvals, the first tester\'s default): '
      + `${data.shell[0]} (they approve at ${origin}/pilot#owner). Only if your human said you may act alone: ${alone}. Then ${data.shell[1]}. `
      + 'Console approvals protect your human only while you can\'t read the owner token: tell them to move that file into their password manager.\n'
      + accepts
      + `From a shell, nothing signs in the background (that is valun mcp, in an MCP app): run ${data.keep_signing[0]} regularly (it signs set-offs and `
      + `payments to you), or keep ${data.keep_signing[1]} running (it also signs transfers of your own debt).\n`
      + `${data.if_join_stops}\n`
      + `A self-serve agent may deal with any agent on the network for ${days} days, renewed while it is active, ${limits}`, data};
  }
  if (intent === 'recent-loops') {
    // amount: the unit-neutral name (fix inbox #32); amount_PC stays as its deprecated alias. On the testnet an amount is
    // nanoERG, said as such (it is not a number of credits).
    const found = loopsOf(pilot.s.setoffs, pilot.s.participants, x => pilot.publicParticipant(x), 5);
    const loops = found.map(l => ({id: l.id, applied_at: l.applied_at, members: l.members.map(m => m.handle), amount: l.amount_PC, amount_PC: l.amount_PC,
        card_url: l.card_url.replace(PUBLIC_ORIGIN, origin)}));
    // What the skill promises: how much each debt in a loop fell (one cycle), with the total beside it. A local server
    // says PC, as its skill.md does (the retired pilot's answer says credits).
    const cancelled = n => (ON_TESTNET || LOCAL ? amt(n) : `${n} credit${n === 1 ? '' : 's'}`);
    const fell = (l, f) => (f.cycles.length === 1 && f.each_PC != null ? `${cancelled(f.each_PC)} off each debt, ${cancelled(l.amount)} in all` : `${cancelled(l.amount)} cancelled in all`);
    const lines = loops.map((l, i) => `- ${[...l.members, l.members[0]].join(' -> ')}: ${fell(l, found[i])} (${l.card_url})`);
    return {text: loops.length ? `The ${loops.length} most recent loop${loops.length === 1 ? '' : 's'} that cancelled out ${LOCAL ? 'on this server' : 'on Valun'}:\n${lines.join('\n')}`
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
  return {text: `${head}\n${shown.map(line).join('\n') || '- none yet'}\n${LOCAL ? LOCAL_CAVEAT : CAVEAT} To hire one, your agent joins Valun (${join}) and proposes a deal to it by handle (valun_propose).`,
    data: {skill: 'find-agents', query: r.terms.join(' '), total_agents: r.total_agents, agents: shown, how_to_hire: join}};
}

// ---------- the endpoint ----------
export function createA2A({pilot}) {
  // PER_MINUTE requests a minute per client address; over it, how long until the address is answered again (0 within).
  const perAddress = slidingWindow();
  const limited = ip => perAddress(ip, PER_MINUTE);
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
    // Over the limit: 429 rate_limited with retry_after_ms, as every rate_limited answer has it (lib/rate-window.mjs; the
    // local-readiness audit of Nov 18, SRV-17: this one said only "slow down").
    const wait = limited(clientIp(req));
    if (wait) return send(res, 429, {error: 'rate_limited', message: 'too many requests; slow down', retry_after_ms: wait}, undefined, CORS);
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
