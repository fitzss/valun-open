// Child process of test/local-a2a.unit.test.mjs and test/local-mode.unit.test.mjs (fix inbox #151): lib/environment.mjs and
// lib/pilot/units.mjs read VALUN_ENVIRONMENT, PORT and VALUN_PUBLIC_ORIGIN once, at start, so each setting runs in a process
// of its own. Over real HTTP, with the A2A fixture's pilot (test/fixtures/a2a-pilot.mjs; no tracker), for each Host header in
// HOSTS (a request reaches a server with whatever Host its client sends: a published port, another container's name, a
// hosts-file entry): the Agent Card at both paths, GET /a2a, the join answer in A2A 1.0 (SendMessage) and 0.3
// (message/send), /skill.md, /llms.txt and /start (for its banner); then the other three skills' answers once, with the
// first Host. Prints one JSON line: {environment, origin, hosts: {HOST: {...}}, skills: {...}}, each answer as its status
// and parsed body (the docs and the page as text).
// Usage: node test/fixtures/local-a2a.mjs   (with VALUN_ENVIRONMENT, PORT and VALUN_PUBLIC_ORIGIN as the test sets them)
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ENVIRONMENT} from '../../lib/environment.mjs';
import {createHandler} from '../../lib/http.mjs';
import {createA2A} from '../../lib/a2a.mjs';
import {PUBLIC_ORIGIN} from '../../lib/pilot/units.mjs';
import {fakePilot} from './a2a-pilot.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const HOSTS = ['127.0.0.1:8080', '127.0.0.1:9000', 'localhost:8080', 'valun-local:8080', 'valun-desk.fly.dev', 'valun.tech'];
const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir, a2a: createA2A({pilot: fakePilot()})}));
await new Promise(r => server.listen(0, '127.0.0.1', r));

const request = (method, route, host, body = null) => new Promise((resolve, reject) => {
  const data = body == null ? null : Buffer.from(JSON.stringify(body));
  const rq = http.request({host: '127.0.0.1', port: server.address().port, path: route, method,
    headers: {host, ...(data ? {'content-type': 'application/json', 'content-length': data.length} : {})}}, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* a doc, not JSON */ }
      resolve({status: res.statusCode, type: res.headers['content-type'] ?? null, json, text: json === null ? text : null});
    });
  });
  rq.on('error', reject);
  rq.end(data);
});
// "How do I join?" (or `text`) in each generation, as the official SDKs send it.
const v1 = (text, data) => ({jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {message: {messageId: 'm1', role: 'ROLE_USER',
  parts: [{text}, ...(data ? [{data}] : [])]}}});
const v03 = (text, data) => ({jsonrpc: '2.0', id: 'a', method: 'message/send', params: {message: {kind: 'message', messageId: 'm1', role: 'user',
  parts: [{kind: 'text', text}, ...(data ? [{kind: 'data', data}] : [])]}}});

const out = {environment: ENVIRONMENT, origin: PUBLIC_ORIGIN, hosts: {}, skills: {}};
try {
  for (const host of HOSTS) {
    out.hosts[host] = {
      card: await request('GET', '/.well-known/agent-card.json', host), cardOld: await request('GET', '/.well-known/agent.json', host),
      a2aGet: await request('GET', '/a2a', host),
      v1: await request('POST', '/a2a', host, v1('How do I join?')), v03: await request('POST', '/a2a', host, v03('How do I join?')),
      skill: await request('GET', '/skill.md', host), llms: await request('GET', '/llms.txt', host), start: await request('GET', '/start', host),
    };
  }
  for (const [name, text] of [['find-agents', 'list agents'], ['find-work', 'find paid work'], ['recent-loops', 'show recent loops']]) {
    out.skills[name] = {v1: await request('POST', '/a2a', HOSTS[0], v1(text)), v03: await request('POST', '/a2a', HOSTS[0], v03(text))};
  }
} finally { server.close(); }
process.stdout.write(`${JSON.stringify(out)}\n`);
