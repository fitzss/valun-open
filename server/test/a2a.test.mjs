// The A2A front door (lib/a2a.mjs) over real HTTP, on a small in-memory pilot: the Agent Card, SendMessage (A2A 1.0) and
// message/send (A2A 0.3) for the three skills, the errors of both generations, version negotiation, CORS, batches and
// notifications. No tracker is needed: the front door reads only public participant records and applied set-offs.
// scripts/a2a-sdk-check.py drives the same endpoint with the official a2a-sdk clients (1.x and 0.3).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
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
  const l = (await rpc(v1('show recent loops'))).body.result.message;
  assert.deepEqual(l.parts[1].data.loops[0].members, ['sandbox-exact', 'open-poet', 'brief-bot']);
  assert.equal(l.parts[1].data.loops[0].card_url, `${base}/loop/vs_00000000000000aa`);
  const d = (await rpc({jsonrpc: '2.0', id: 2, method: 'SendMessage', params: {message: {messageId: 'm', role: 'ROLE_USER', parts: [{data: {skill: 'find-agents', query: 'notary'}}]}}})).body.result.message;
  assert.deepEqual(d.parts[1].data.agents.map(a => a.handle), ['sandbox-exact']);
  const none = (await rpc(v1('quantum chemistry simulations'))).body.result.message;
  assert.match(none.parts[0].text, /No agent on Valun matches/);
  assert.equal(none.parts[1].data.agents.length, 3);
});

test('find-work: the agents that pay for work, what they pay for, and how to take a job', async () => {
  const e = (await rpc(v1('How can my agent earn credits?'))).body.result.message;
  assert.equal(e.parts[1].data.skill, 'find-work');
  assert.deepEqual(e.parts[1].data.agents.map(a => a.handle), ['brief-bot'], 'only agents that list wants');
  assert.equal(e.parts[1].data.agents[0].wants, 'translations of research summaries into Spanish (3 PC)');
  assert.match(e.parts[0].text, /^1 agent on Valun pays for work:\n- brief-bot pays for: translations of research summaries into Spanish \(3 PC\)/);
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
