// The A2A front door (lib/a2a.mjs) over real HTTP, on a small in-memory pilot: the Agent Card, SendMessage (A2A 1.0) and
// message/send (A2A 0.3) for the three skills, the errors of both generations, version negotiation, CORS, batches and
// notifications. No tracker is needed: the front door reads only public participant records and applied set-offs.
// scripts/a2a-sdk-check.py drives the same endpoint with the official a2a-sdk clients (1.x and 0.3).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createHandler} from '../lib/http.mjs';
import {createA2A, agentCard} from '../lib/a2a.mjs';
import {fakePilot} from './fixtures/a2a-pilot.mjs';

let server, base;
before(async () => {
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public', a2a: createA2A({pilot: fakePilot()})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const rpc = async (body, headers = {}) => {
  const r = await fetch(base + '/a2a', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});
  return {status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json()};
};
const v1 = (text, extra = {}) => ({jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {message: {messageId: 'm1', role: 'ROLE_USER', parts: [{text}], ...extra}}});
const v03 = text => ({jsonrpc: '2.0', id: 'a', method: 'message/send', params: {message: {kind: 'message', messageId: 'm1', role: 'user', parts: [{kind: 'text', text}]}}});

test('the Agent Card: A2A 1.0 fields, both interfaces, 0.3 top-level fields, CORS, cacheable; also at the old path', async () => {
  for (const p of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const r = await fetch(base + p), c = await r.json();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('cache-control'), /max-age=300/);
    for (const k of ['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(c[k] !== undefined, k);
    assert.deepEqual(c.supportedInterfaces.map(i => [i.protocolBinding, i.protocolVersion, i.url]), [['JSONRPC', '1.0', `${base}/a2a`], ['JSONRPC', '0.3', `${base}/a2a`]]);
    assert.deepEqual([c.protocolVersion, c.url, c.preferredTransport], ['0.3.0', `${base}/a2a`, 'JSONRPC']);
    assert.deepEqual(c.skills.map(s => s.id), ['find-agents', 'find-work', 'join-valun', 'recent-loops']);
    for (const s of c.skills) for (const k of ['id', 'name', 'description', 'tags']) assert.ok(s[k], `${s.id}.${k}`);
  }
  assert.equal(agentCard('https://valun.tech').supportedInterfaces[0].url, 'https://valun.tech/a2a');
});

test('SendMessage (1.0): finds agents by what they offer; a Message with a text part and a data part', async () => {
  const r = await rpc(v1('Who can write haiku?', {contextId: 'ctx-1'}));
  assert.equal(r.status, 200);
  const m = r.body.result.message;
  assert.equal(r.body.id, 1);
  assert.equal(m.role, 'ROLE_AGENT');
  assert.equal(m.contextId, 'ctx-1');
  assert.ok(m.messageId);
  assert.equal(m.parts[0].kind, undefined);
  assert.match(m.parts[0].text, /open-poet/);
  assert.doesNotMatch(m.parts[0].text, /gone-agent|not-enrolled/, 'dormant and unenrolled participants are not listed');
  assert.equal(m.parts[1].mediaType, 'application/json');
  assert.deepEqual(m.parts[1].data.agents.map(a => a.handle), ['open-poet']);
  assert.equal(m.parts[1].data.agents[0].kind, 'sandbox_participant');
  assert.equal(r.body.result.task, undefined);
});

test('message/send (0.3): the same answer in 0.3 shapes (kind, role "agent", the Message as the result)', async () => {
  const r = await rpc(v03('find agents that summarize research papers'));
  assert.equal(r.body.result.kind, 'message');
  assert.equal(r.body.result.role, 'agent');
  assert.equal(r.body.result.parts[0].kind, 'text');
  assert.equal(r.body.result.parts[1].kind, 'data');
  assert.equal(r.body.result.parts[1].data.agents[0].handle, 'brief-bot');
});

test('the other skills: how to join, recent loops; a data part can name the skill; no match lists everyone', async () => {
  const j = (await rpc(v1('How do I join?'))).body.result.message;
  assert.match(j.parts[0].text, /skill\.md/);
  assert.equal(j.parts[1].data.skill, 'join-valun');
  assert.equal(j.parts[1].data.one_line, `Read ${base}/skill.md and follow it to join Valun.`);
  // Commands an agent can run as they are: the pinned client, nothing left for join to prompt for (an agent with no
  // terminal stopped at the handle prompt with EOFError), and the owner token written to its human's file, not shown.
  const jd = j.parts[1].data;
  assert.equal(jd.client, 'valun==0.7.1');
  // The owner token file is named per handle (the redesign, round 2): valun 0.7.1 never overwrites a token file and prints
  // the token instead when it exists, as after the tour's join.
  for (const cmd of [jd.mcp[0], jd.shell[0], jd.hermes[2]]) {
    assert.match(cmd, /join --sandbox /, cmd);
    for (const flag of ['--handle YOUR-HANDLE', '--operator "YOUR HUMAN"', '--owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"']) assert.ok(cmd.includes(flag), `${flag}: ${cmd}`);
  }
  assert.doesNotMatch(JSON.stringify(j), /valun-owner-token\.txt/, 'never the file the tour writes');
  assert.ok(j.parts[0].text.includes('the owner token is theirs (join writes it to the file named, one file per handle; never paste it). If join says it can\'t write the owner token file, or prints a token, stop: don\'t repeat it, and tell your human to keep it only in their password manager.'));
  // A shell can't prompt its human: the command to copy holds each commitment for the owner console; --approvals none is
  // in the text, after it, only for a human who said the agent may act alone.
  const JOIN = 'uvx --from valun==0.7.1 valun join --sandbox --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';
  assert.equal(jd.shell[0], `${JOIN} --approvals console`);
  // An MCP app's join is skill.md's, with no --approvals flag (ask, the default), and the text says when to add console,
  // as skill.md does; the one real Claude Code run (headless, which cancels ask's prompt) added it, and says so.
  assert.equal(jd.mcp[0], JOIN);
  assert.ok(j.parts[0].text.includes(`- Claude Code: join in a terminal (${JOIN}), then claude mcp add valun -- uvx --from valun==0.7.1 valun mcp. That join uses the default approvals, ask, which works only in an app that shows approval prompts (verified in no app yet). If your human chose otherwise, add --approvals console or --approvals none to it (none only if they said you may act alone). If they want to approve each commitment and your app can't show approval prompts (run headless, such as claude -p), or you don't know whether it can, add --approvals console: each commitment then waits for your human at ${base}/pilot#owner. With --approvals console added to the join, these two lines have run end to end once (Claude Code 2.1.326, Nov 17, headless); Claude Code's own approval prompts are not yet tested.`));
  // The evidence for other apps, as it is: only scripted MCP clients, and no other app verified (the lead's live check).
  assert.ok(j.parts[0].text.includes('- Other MCP apps: the same join, then add the MCP server: uvx --from valun==0.7.1 valun mcp. It should work with any MCP app. Apart from the Claude Code run, only scripted MCP clients have run it; no other app (Codex, Cursor, Claude Desktop, VS Code) has been verified.'));
  assert.doesNotMatch(j.parts[0].text, /other apps have run it only through scripted MCP clients|every other app has run it/);
  assert.deepEqual([jd.shell[1], jd.mcp[1]], ['uvx --from valun==0.7.1 valun call valun_status', 'claude mcp add valun -- uvx --from valun==0.7.1 valun mcp']);
  for (const cmd of [...jd.mcp, ...jd.shell]) assert.match(cmd, /uvx --from valun==0\.7\.1 valun /, cmd);
  assert.ok(j.parts[0].text.includes(jd.shell[0]), 'the text gives the same command');
  assert.ok(j.parts[0].text.includes(`If your human wants to approve each commitment: ${JOIN} --approvals console (they approve at ${base}/pilot#owner). Only if your human said you may act alone: ${JOIN} --approvals none. Then uvx --from valun==0.7.1 valun call valun_status.`));
  assert.doesNotMatch(JSON.stringify(jd), /--approvals none/, 'the data never gives none to copy');
  assert.match(j.parts[0].text, /Ask your human first: the handle and the operator name are public and permanent, and the owner token is theirs/);
  assert.doesNotMatch(JSON.stringify(j), /pipx install valun(?!==)|"valun join --sandbox|valun join --sandbox --approvals none"/);
  // The limits in force (the server's self-serve limits), in the network's unit: credits on the pilot this test runs.
  assert.match(j.parts[0].text, /for 7 days, renewed while it is active, at most 5 credits per deal and 40 owed in total\. Credits have no monetary value\.$/);
  const l = (await rpc(v1('show recent loops'))).body.result.message;
  assert.deepEqual(l.parts[1].data.loops[0].members, ['sandbox-exact', 'open-poet', 'brief-bot']);
  assert.equal(l.parts[1].data.loops[0].card_url, `${base}/loop/vs_00000000000000aa`);
  const d = (await rpc({jsonrpc: '2.0', id: 2, method: 'SendMessage', params: {message: {messageId: 'm', role: 'ROLE_USER', parts: [{data: {skill: 'find-agents', query: 'notary'}}]}}})).body.result.message;
  assert.deepEqual(d.parts[1].data.agents.map(a => a.handle), ['sandbox-exact']);
  const none = (await rpc(v1('quantum chemistry simulations'))).body.result.message;
  assert.match(none.parts[0].text, /No agent on Valun matches/);
  assert.equal(none.parts[1].data.agents.length, 3);
});

// One MCP join everywhere (the lead's live check of 1b1f18f): the answer's two MCP commands are skill.md's two lines for an
// MCP app, word for word (test/start-page.test.mjs holds /start's to the same lines), so an agent that compares the
// surfaces gets one first command. None names --approvals: the text adds console where skill.md does.
test('join-valun: the MCP commands are skill.md\'s two lines for an MCP app, with no --approvals flag', async () => {
  const jd = (await rpc(v1('How do I join?'))).body.result.message.parts[1].data;
  const skill = fs.readFileSync(new URL('../public/skill-testnet.md', import.meta.url), 'utf8');
  const section = skill.slice(skill.indexOf('### Claude Code, Codex, Cursor, Claude Desktop, or any MCP app'), skill.indexOf('### Any agent with a shell'));
  const fence = /```\n([\s\S]*?)\n```/.exec(section)?.[1].split('\n');
  assert.equal(fence?.length, 2, 'skill.md gives an MCP app two lines: the join, then claude mcp add');
  assert.deepEqual(jd.mcp, fence);
  for (const l of jd.mcp) assert.doesNotMatch(l, /--approvals/, l);
});

test('find-work: the agents that pay for work, what they pay for, and how to take a job', async () => {
  const e = (await rpc(v1('How can my agent earn credits?'))).body.result.message;
  assert.equal(e.parts[1].data.skill, 'find-work');
  assert.deepEqual(e.parts[1].data.agents.map(a => a.handle), ['brief-bot'], 'only agents that list wants');
  assert.equal(e.parts[1].data.agents[0].wants, 'translations of research summaries into Spanish (3 PC)');
  // Who runs each agent, from its record: brief-bot's operator field names no one on the team.
  assert.match(e.parts[0].text, /^1 agent on Valun pays for work:\n- brief-bot \(other agent: its operator field names no one on the team\) pays for: translations of research summaries into Spanish \(3 PC\)/);
  assert.match(e.parts[1].data.how_to_earn, /"role": "payee"/);
  assert.match(e.parts[1].data.how_to_earn, /cancel in a loop/);
  const t = (await rpc(v1('who pays for translations?'))).body.result.message;
  assert.equal(t.parts[1].data.query, 'translations');
  assert.deepEqual(t.parts[1].data.agents.map(a => a.handle), ['brief-bot']);
  assert.match(t.parts[0].text, /matching "translations"/);
  const n = (await rpc(v1('find paid work for a haiku poet'))).body.result.message;
  assert.equal(n.parts[1].data.skill, 'find-work');
  assert.match(n.parts[0].text, /^No agent on Valun pays for "haiku poet" yet\. Paid work on the network now:\n- brief-bot/);
  const d = (await rpc({jsonrpc: '2.0', id: 3, method: 'SendMessage', params: {message: {messageId: 'm', role: 'ROLE_USER', parts: [{data: {skill: 'find-work'}}]}}})).body.result.message;
  assert.deepEqual(d.parts[1].data.agents.map(a => a.handle), ['brief-bot']);
  // find-agents shows what an agent pays for, after what it offers.
  const f = (await rpc(v1('research papers'))).body.result.message;
  assert.match(f.parts[0].text, /- brief-bot \([^)]*\): Summaries of research papers; pays for translations of research summaries into Spanish/);
  assert.equal(f.parts[1].data.agents[0].wants, 'translations of research summaries into Spanish (3 PC)');
});

// Who runs an agent, as the pages say it (lib/pilot/loops.mjs whoRuns), not how it joined: a house agent joined
// self-serve but the operator runs it. The card and the directory say that so far the agents are almost all the team's
// or the operator's.
test('find-agents says who runs each agent and that almost every agent so far is the team\'s or the operator\'s; recent loops say what each debt fell', async () => {
  const pilot = fakePilot(), at = (id, extra) => Object.assign(pilot.s.participants[id], extra);
  at('vp_000000000002', {operator: 'Basis QA'});                                                     // a team test agent, by its operator field
  at('vp_000000000003', {operator: 'Valun (house agents)', sandbox_only: true, sandbox_expires_at: new Date(Date.now() + 864e5).toISOString()});
  const dir = pilot.directoryRecord.bind(pilot);
  pilot.directoryRecord = p => ({...dir(p), ...(p.id === 'vp_000000000003' ? {house_agent: true} : {}), ...(p.handle === 'sandbox-exact' ? {operator_run: true} : {})});
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public', a2a: createA2A({pilot})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const ask = async text => (await (await fetch(`http://127.0.0.1:${srv.address().port}/a2a`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(v1(text))})).json()).result.message;
    const m = await ask('list agents'), text = m.parts[0].text;
    assert.match(text, /^- sandbox-exact \(practice agent, operator-run\): offers /m);
    assert.match(text, /^- brief-bot \(house agent, operator-run\): Summaries of research papers; pays for /m);
    assert.match(text, /^- open-poet \(team test agent, by its operator field\): offers haiku/m);
    assert.doesNotMatch(text, /sandbox participant|sandbox agent\)/, 'how it joined is not who runs it');
    assert.ok(text.includes('So far almost every agent on the network is the team\'s or the operator\'s. To hire one'));
    assert.deepEqual(m.parts[1].data.agents.map(a => a.kind).sort(), ['sandbox_agent', 'sandbox_participant', 'sandbox_participant'], 'the data keeps each kind');
    const l = (await ask('show recent loops')).parts[0].text;
    assert.ok(l.includes('- sandbox-exact -> open-poet -> brief-bot -> sandbox-exact: 2 credits off each debt, 6 credits in all ('), l);
  } finally { srv.close(); }
  assert.ok(agentCard('https://valun.tech').description.includes('So far almost every agent on the network is the team\'s or the operator\'s.'));
  assert.doesNotMatch(agentCard('https://valun.tech').description, /AI agents run by different people agree/);
});

test('errors in both generations: no tasks, no streaming or push, unknown method, bad requests, versions', async () => {
  const e1 = (await rpc({jsonrpc: '2.0', id: 3, method: 'GetTask', params: {id: 't'}})).body.error;
  assert.equal(e1.code, -32001);
  assert.equal(e1.data[0].reason, 'TASK_NOT_FOUND');
  assert.equal(e1.data[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  const e03 = (await rpc({jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {id: 't'}})).body.error;
  assert.equal(e03.code, -32001);
  assert.equal(e03.data, undefined);
  assert.equal((await rpc({jsonrpc: '2.0', id: 4, method: 'SendStreamingMessage', params: {}})).body.error.code, -32004);
  assert.equal((await rpc({jsonrpc: '2.0', id: 4, method: 'tasks/pushNotificationConfig/set', params: {}})).body.error.code, -32003);
  assert.equal((await rpc({jsonrpc: '2.0', id: 4, method: 'GetExtendedAgentCard', params: {}})).body.error.code, -32007);
  assert.equal((await rpc({jsonrpc: '2.0', id: 5, method: 'tasks/send', params: {}})).body.error.code, -32601);
  assert.equal((await rpc('{nope')).body.error.code, -32700);
  assert.equal((await rpc({id: 6, method: 'SendMessage'})).body.error.code, -32600);
  assert.equal((await rpc({jsonrpc: '2.0', id: 7, method: 'SendMessage', params: {message: {parts: []}}})).body.error.code, -32602);
  assert.equal((await rpc(v1('hi'), {'a2a-version': '9.9'})).body.error.code, -32009);
  assert.ok((await rpc(v1('hi'), {'a2a-version': '1.0'})).body.result);
  assert.ok((await rpc(v03('hi'), {'a2a-version': '0.3'})).body.result);
});

test('CORS preflight, batches, notifications, GET on the endpoint, body limit', async () => {
  const o = await fetch(base + '/a2a', {method: 'OPTIONS'});
  assert.equal(o.status, 204);
  assert.match(o.headers.get('access-control-allow-headers'), /a2a-version/);
  const b = (await rpc([v1('haiku'), {...v03('haiku'), id: 'b'}])).body;
  assert.equal(b.length, 2);
  assert.equal(b[0].result.message.parts[1].data.agents[0].handle, 'open-poet');
  assert.equal(b[1].result.kind, 'message');
  const {id, ...note} = v1('haiku');
  assert.equal((await rpc(note)).status, 204);
  const g = await fetch(base + '/a2a');
  assert.match((await g.json()).agent_card, /agent-card\.json$/);
  assert.equal((await rpc(JSON.stringify(v1('x'.repeat(70000))))).status, 413);
});

test('the agent pages: skill.md (also /agents.md) and llms.txt, as text', async () => {
  for (const [p, type, has] of [['/skill.md', 'text/markdown', 'name: valun'], ['/agents.md', 'text/markdown', 'name: valun'], ['/llms.txt', 'text/plain', '# Valun']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), new RegExp(type), p);
    assert.ok((await r.text()).includes(has), p);
  }
});
