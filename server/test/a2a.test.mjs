// The A2A front door (lib/a2a.mjs) over real HTTP, on a small in-memory pilot: the Agent Card, SendMessage (A2A 1.0) and
// message/send (A2A 0.3) for the three skills, the errors of both generations, version negotiation, CORS, batches and
// notifications. No tracker is needed: the front door reads only public participant records and applied set-offs.
// scripts/a2a-sdk-check.py drives the same endpoint with the official a2a-sdk clients (1.x and 0.3).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createHandler} from '../lib/http.mjs';
import {createA2A, agentCard, LOST_JOIN, LOST_JOIN_071} from '../lib/a2a.mjs';
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
  assert.equal(jd.client, 'valun==0.7.2');
  // The owner token file is named per handle (the redesign, round 2): valun 0.7.1 never overwrites a token file and prints
  // the token instead when it exists, as after the tour's join.
  for (const cmd of [jd.mcp[0], jd.shell[0], jd.hermes[2]]) {
    assert.match(cmd, /join --sandbox /, cmd);
    for (const flag of ['--handle YOUR-HANDLE', '--operator "YOUR HUMAN"', '--owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"']) assert.ok(cmd.includes(flag), `${flag}: ${cmd}`);
  }
  assert.doesNotMatch(JSON.stringify(j), /valun-owner-token\.txt/, 'never the file the tour writes');
  // valun 0.7.2 refuses a token file that exists, or a folder that can't take one, before anything is sent, and never
  // prints the token on stdout; the Hermes plugin's own join still prints it when its file exists already.
  assert.ok(j.parts[0].text.includes('the owner token is theirs (join writes it to the file named, one file per handle; never paste it). If join says "Nothing was sent" (the token file exists already, or its folder can\'t take a new file), join again with a new token file name. If it shows a token (valun only at a terminal, when no file could be written; the Hermes plugin\'s join whenever its file exists already), stop: don\'t repeat it, and tell your human to keep it only in their password manager.'));
  // A shell can't prompt its human: the command to copy holds each commitment for the owner console; --approvals none is
  // in the text, after it, only for a human who said the agent may act alone.
  const JOIN = 'uvx --from valun==0.7.2 valun join --sandbox --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';
  assert.equal(jd.shell[0], `${JOIN} --approvals console`);
  // Claude Code joins with console, as the one real run did, end to end (headless Claude Code cancels ask's prompt, and ask
  // has been verified in no app); the text says what leaving the flag out (ask) relies on, and when none is for.
  assert.equal(jd.mcp[0], `${JOIN} --approvals console`);
  assert.ok(j.parts[0].text.includes(`- Claude Code: join in a terminal (${JOIN} --approvals console: your offers, acceptances, guarantee offers and notes then wait for your human at ${base}/pilot#owner; honoring a guarantee call and the consents never do), then claude mcp add valun -- uvx --from valun==0.7.2 valun mcp. These two lines have run end to end once (Claude Code 2.1.326, Nov 17, headless); Claude Code's own approval prompts are not yet tested. claude mcp add adds the server only for the folder it runs in (Claude Code's default scope, local); claude mcp add --scope user valun -- uvx --from valun==0.7.2 valun mcp adds it for every folder. Console is also what a --sandbox join of valun 0.7.2 uses without --approvals. Write --approvals ask in its place only if your human chose to approve in your app\'s own prompts, which works only in an app that shows them (verified in no app yet); write --approvals none instead only if they said you may act alone. There is also a plugin (/plugin marketplace add fitzss/valun-open, then /plugin install valun@valun): an install check only, not yet run end to end.`));
  assert.doesNotMatch(j.parts[0].text, /That join uses the default approvals/, 'the line to copy is not the default');
  // The evidence for other apps, as it is: only scripted MCP clients, and no other app verified (the lead's live check).
  assert.ok(j.parts[0].text.includes('- Other MCP apps: the same join, then add the MCP server: uvx --from valun==0.7.2 valun mcp. It should work with any MCP app. Apart from the Claude Code run, only scripted MCP clients have run it; no other app (Codex, Cursor, Claude Desktop, VS Code) has been verified.'));
  assert.doesNotMatch(j.parts[0].text, /other apps have run it only through scripted MCP clients|every other app has run it/);
  assert.deepEqual([jd.shell[1], jd.mcp[1]], ['uvx --from valun==0.7.2 valun call valun_status', 'claude mcp add valun -- uvx --from valun==0.7.2 valun mcp']);
  for (const cmd of [...jd.mcp, ...jd.shell]) assert.match(cmd, /uvx --from valun==0\.7\.2 valun /, cmd);
  assert.ok(j.parts[0].text.includes(jd.shell[0]), 'the text gives the same command');
  assert.ok(j.parts[0].text.includes(`If your human wants to approve what you sign (console approvals, the first tester's default): ${JOIN} --approvals console (they approve at ${base}/pilot#owner). Only if your human said you may act alone: ${JOIN} --approvals none. Then uvx --from valun==0.7.2 valun call valun_status.`));
  assert.doesNotMatch(JSON.stringify(jd), /--approvals none/, 'the data never gives none to copy');
  assert.match(j.parts[0].text, /Ask your human first: the handle and the operator name are public and permanent, and the owner token is theirs/);
  assert.doesNotMatch(JSON.stringify(j), /pipx install valun(?!==)|"valun join --sandbox|valun join --sandbox --approvals none"/);
  // A join that stops halfway: valun 0.7.2 keeps the agent's key and prints the command that finishes it (cli.py
  // _join_unanswered, _enroll_and_settle), which is run as printed; the Hermes plugin's own join stops as 0.7.1's did
  // (the readiness assessment of Nov 18): never revoke or run the enroll it suggests; another handle and a new token
  // file name, and the same handle only after a handle_taken that gives a time: after "could not be stored" the key is
  // usually registered and the handle taken for good (the review of gap/first-use). skill.md says each under its join
  // commands (test/trust-page.test.mjs holds them to the same words), /start#known-join in detail.
  assert.equal(jd.if_join_stops, `${LOST_JOIN} In Hermes, whose plugin joins with its own code, as valun 0.7.1 did: ${LOST_JOIN_071} Details: ${base}/start#known-join`);
  assert.ok(LOST_JOIN.startsWith('If join stops before it finishes (a cut connection, a timeout, an answer lost on the way), it says so, keeps your key in your profile, says what the server may hold now, and prints the command to run next'));
  assert.ok(LOST_JOIN.includes('Run that command as printed, and nothing else. If it answers handle_taken with a time (held_until), run it again after that time'));
  assert.ok(LOST_JOIN.endsWith('Never revoke anything yourself: where join says to revoke your agent, that is your human\'s step, in the owner console.'));
  assert.ok(LOST_JOIN_071.startsWith('If join stops with a Python traceback or a timeout, or says the key could not be stored or registered: don\'t revoke anything, and don\'t run the enroll it suggests.'));
  assert.ok(LOST_JOIN_071.includes('Ask your human for another handle, and join again with it and a new token file name. Only if the same join, run again, answers handle_taken with a time (held_until) may your human choose that handle again'));
  assert.ok(LOST_JOIN_071.endsWith('After "could not be stored", the server has usually registered your key, which valun didn\'t save here, so that handle stays taken.'));
  assert.ok(j.parts[0].text.includes(`\n${jd.if_join_stops}\n`), 'in the text, on a line of its own');
  // A shell agent runs no valun mcp: the two commands that keep its client signing, as skill.md gives them under its
  // shell join (the readiness assessment of Nov 18).
  assert.deepEqual(jd.keep_signing, ['uvx --from valun==0.7.2 valun call valun_inbox', 'uvx --from valun==0.7.2 valun clearing watch']);
  const skillText = fs.readFileSync(new URL('../public/skill-testnet.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const cmd of jd.keep_signing) assert.ok(skillText.includes(`\`${cmd}\``), cmd);
  assert.ok(j.parts[0].text.includes(`From a shell, nothing signs in the background (that is valun mcp, in an MCP app): run ${jd.keep_signing[0]} regularly (it signs set-offs and payments to you), or keep ${jd.keep_signing[1]} running (it also signs transfers of notes you issued).\n`));
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

// The answer's two MCP commands are skill.md's two lines for an MCP app (test/start-page.test.mjs holds /start's to the same
// lines), the join with --approvals console: the setup of the one run that went end to end. The live build (1b1f18f)
// has it; PR #5 had dropped it. skill.md's block has it too since fix inbox #138 (console is the first tester's default
// until an interactive app's approval forms are verified), so the two are the same command.
test('join-valun: the MCP commands are skill.md\'s two lines for an MCP app, the join with --approvals console', async () => {
  const jd = (await rpc(v1('How do I join?'))).body.result.message.parts[1].data;
  const skill = fs.readFileSync(new URL('../public/skill-testnet.md', import.meta.url), 'utf8');
  const section = skill.slice(skill.indexOf('### Claude Code, Codex, Cursor, Claude Desktop, or any MCP app'), skill.indexOf('### Any agent with a shell'));
  const fence = /```\n([\s\S]*?)\n```/.exec(section)?.[1].split('\n');
  assert.equal(fence?.length, 2, 'skill.md gives an MCP app two lines: the join, then claude mcp add');
  assert.equal(jd.mcp[0], fence[0]);
  assert.match(jd.mcp[0], / --approvals console$/);
  assert.equal(jd.mcp[1], fence[1]);
  assert.doesNotMatch(jd.mcp[1], /--approvals/);
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
test('find-agents says who runs each agent, sandbox-exact first as the job to try first, and that almost every agent so far is the team\'s or the operator\'s; recent loops say what each note fell', async () => {
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
    // Fix inbox #173: the practice agent that always answers is named the one to try first, and listed first; a house
    // agent says it may be out of its shared AI budget.
    assert.match(text, /^Agents on Valun \(3 active; sandbox-exact first, then the operator's other agents, then the most recently seen\):\n- sandbox-exact \(practice agent, operator-run; always exact, the one to try first\): offers /);
    assert.match(text, /^- brief-bot \(house agent, operator-run; Claude on a shared daily and monthly budget, so it may decline\): Summaries of research papers; pays for /m);
    assert.match(text, /^- open-poet \(team test agent, by its operator field\): offers haiku/m);
    assert.doesNotMatch(text, /sandbox participant|sandbox agent\)/, 'how it joined is not who runs it');
    assert.ok(text.includes('So far almost every agent on the network is the team\'s or the operator\'s. To hire one'));
    assert.deepEqual(m.parts[1].data.agents.map(a => a.kind).sort(), ['sandbox_agent', 'sandbox_participant', 'sandbox_participant'], 'the data keeps each kind');
    const l = (await ask('show recent loops')).parts[0].text;
    assert.ok(l.includes('- sandbox-exact -> open-poet -> brief-bot -> sandbox-exact: 2 credits off each note, 6 credits in all ('), l);
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
