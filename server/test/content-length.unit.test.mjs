// Every answer says its length (lib/http.mjs send(): Content-Length, none on a 204 or 304). Before, writeHead ran before
// end() and Node framed every body as chunked: a client could read the whole body and still fail on the missing last
// chunk when a connection between it and the server ended early (http.client: IncompleteRead with every byte read; a
// tester's agent saw this on Nov 16, evidence/muse-report-2026-11-17 in the fix inbox). With the length, a client knows
// the answer is complete once it has read that many bytes.
//
// And a HEAD gets what a GET gets (fix inbox #142): the same status and headers, Content-Length included, with no body,
// on the pages, the agent files and the network's public reads. It used to answer 404 for /skill.md and /start and 401
// for /pilot/v1/info, so `curl -I`, uptime monitors and link checkers saw a missing file or a route that needs a token. A
// HEAD never reaches a write: it is never authenticated, and one sent with a token where the token would be read is 405.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHandler} from '../lib/http.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {PilotError} from '../lib/pilot/core.mjs';
import {createA2A} from '../lib/a2a.mjs';
import {fakePilot} from './fixtures/a2a-pilot.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function serve(pilotRoutes, a2a = null) {
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir, pilotRoutes, a2a}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {srv, base: `http://127.0.0.1:${srv.address().port}`};
}

// A raw HTTP/1.1 request, so the test sees the framing itself (fetch would hide it).
function raw(base, method, p, headers = {}) {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const req = http.request({host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: {connection: 'close', ...headers}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject); req.end();
  });
}

test('a JSON answer, a static page and an error each carry Content-Length, equal to the bytes sent, and no chunked framing', async () => {
  // The pilot's routes as lib/http.mjs calls them: (req, res, url, send).
  const pilotRoutes = (req, res, url, send) => {
    if (url.pathname === '/pilot/v1/info') return send(res, 200, {network: 'valun-testnet-1', note: 'é – ✓'});
    return send(res, 404, {error: 'not found'});
  };
  const {srv, base} = await serve(pilotRoutes);
  try {
    for (const p of ['/pilot/v1/info', '/start', '/skill.md', '/site.css', '/nope-not-here']) {
      const r = await raw(base, 'GET', p);
      assert.notEqual(r.headers['transfer-encoding'], 'chunked', `${p}: not chunked`);
      assert.ok(r.headers['content-length'] !== undefined, `${p}: has Content-Length (${r.status})`);
      assert.equal(Number(r.headers['content-length']), r.body.length, `${p}: the length is the bytes sent`);
    }
    // multi-byte characters: the length counts bytes, not characters
    const info = await raw(base, 'GET', '/pilot/v1/info');
    assert.equal(Number(info.headers['content-length']), Buffer.byteLength(info.body.toString('utf8')));
  } finally { srv.close(); }
});

// The A2A fixture's small pilot (test/fixtures/a2a-pilot.mjs), with what the public reads also read, and spies on what a
// HEAD must never reach: authenticate (it records the agent as seen and renews a self-serve agent) and the writes.
function headPilot() {
  const pilot = Object.assign(fakePilot(), {mode: 'off', unit: 'PC', basis: {denomination: 'pc', nft: 'ab'.repeat(32), health: async () => true}});
  const reached = [];
  pilot.participant = id => {
    if (!Object.hasOwn(pilot.s.participants, id)) throw new PilotError('not_found', 'no such participant', 404);
    return pilot.s.participants[id];
  };
  pilot.setoff = id => pilot.s.setoffs[id] ?? null;
  pilot.ledger = async () => [];
  pilot.reconcile = async () => [];
  pilot.publicPosition = async () => ({claims_held: 0, owes: 0, claims: [], debts: [{to: 'sandbox-exact', amount: 2}], deals: {credit_notes_issued: 1}});
  pilot.inbox = () => [];
  // Pilot.authenticate changes nothing without a token (it returns null at once); with one it writes, so only that counts.
  pilot.authenticate = bearer => {
    if (bearer) reached.push(['authenticate', bearer]);
    return bearer === 'vpa_poet' ? {role: 'agent', p: pilot.s.participants.vp_000000000002} : null;
  };
  for (const w of ['join', 'joinSandbox', 'enroll', 'propose', 'setProfile']) pilot[w] = async () => { reached.push([w]); return {}; };
  return {pilot, reached};
}
// What a HEAD and its GET must agree on: every header but the date.
const headersOf = r => Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'date'));

test('fix inbox #142: HEAD answers as GET, with the same status and headers (Content-Length included) and no body', async () => {
  const {pilot, reached} = headPilot();
  const {srv, base} = await serve(createPilotRoutes({pilot, cfg: {}}), createA2A({pilot}));
  try {
    const paths = [
      // the pages and the files agents read (the ones #142 names first), and the rest of the site
      '/', '/start', '/skill.md', '/llms.txt', '/agents.md', '/trust', '/network', '/memory', '/pilot', '/home', '/og.png', '/site.css', '/network.js', '/favicon.svg',
      // the server's rendered pages
      '/maintainers', '/agent/open-poet', '/loop/vs_00000000000000aa',
      // the network's public reads
      '/pilot/v1/info', '/pilot/v1/health', '/pilot/v1/participants', '/pilot/v1/participants?all=1', '/pilot/v1/participants/vp_000000000002',
      '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/loops/vs_00000000000000aa',
      // the A2A front door's reads
      '/.well-known/agent-card.json', '/a2a',
      // and their refusals: a 404 page, a 404 read, an unpublished card, a route this mode lacks, no token, GET-less /mcp
      '/agent/nobody-here', '/loop/vs_0000000000000000', '/nope-not-here', '/pilot/v1/loops/vs_0000000000000000', '/pilot/v1/participants/vp_000000000002/card',
      '/pilot/v1/evidence', '/pilot/v1/me', '/mcp'];
    for (const p of paths) {
      const get = await raw(base, 'GET', p), head = await raw(base, 'HEAD', p);
      assert.equal(head.status, get.status, `${p}: the status of its GET (${get.status})`);
      assert.deepEqual(headersOf(head), headersOf(get), `${p}: the headers of its GET`);
      assert.equal(Number(head.headers['content-length']), get.body.length, `${p}: Content-Length is the length of the GET's body`);
      assert.equal(head.body.length, 0, `${p}: no body`);
    }
    // valun.tech's home, by its Host.
    const get = await raw(base, 'GET', '/', {host: 'valun.tech'}), head = await raw(base, 'HEAD', '/', {host: 'valun.tech'});
    assert.deepEqual([head.status, head.headers['content-length'], head.body.length], [200, String(get.body.length), 0]);
    // What #142 saw: 200, not 404 or 401; a public read keeps its CORS header (fix inbox #106), as its GET does.
    for (const p of ['/skill.md', '/start', '/llms.txt', '/pilot/v1/info', '/pilot/v1/loops', '/pilot/v1/participants']) assert.equal((await raw(base, 'HEAD', p)).status, 200, p);
    assert.equal((await raw(base, 'HEAD', '/pilot/v1/info')).headers['access-control-allow-origin'], '*');
    assert.deepEqual(reached, [], 'no HEAD was authenticated or reached a write');
  } finally { srv.close(); }
});

test('fix inbox #142: a HEAD never reaches a write: never authenticated, refused (405) with a token, counted as a read', async () => {
  const {pilot, reached} = headPilot();
  // Writes: 3 a minute from one address; reads: plenty.
  const {srv, base} = await serve(createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 3, pilotIpReadLimitPerMinute: 1000}}));
  try {
    const bearer = {authorization: 'Bearer vpa_poet'};
    // With a token, where the token would be read: the authenticated routes, and a budget card's check (the payee's own
    // check renews the payee's agent first). 405, with the methods that take the token there.
    for (const [p, allow] of [['/pilot/v1/me', 'GET, POST, PUT'], ['/pilot/v1/consents', 'GET, POST, PUT'], ['/pilot/v1/deals', 'GET, POST, PUT'],
      ['/pilot/v1/participants/vp_000000000003/check?amount=1&payee=open-poet', 'GET']]) {
      const r = await raw(base, 'HEAD', p, bearer);
      assert.deepEqual([r.status, r.headers.allow, r.body.length], [405, allow, 0], p);
      assert.ok(Number(r.headers['content-length']) > 0, `${p}: it says the length of its body, which a HEAD does not get`);
    }
    // The routes that write: with no token a HEAD gets the 401 a GET gets, and nothing is joined or proposed.
    for (const p of ['/pilot/v1/join', '/pilot/v1/join-sandbox', '/pilot/v1/enroll', '/pilot/v1/deals', '/pilot/v1/profile'])
      assert.equal((await raw(base, 'HEAD', p)).status, 401, p);
    assert.deepEqual(reached, [], 'no HEAD was authenticated or reached a write');
    // A public read answers HEAD with a token too, as its GET does (the token is not read there).
    assert.equal((await raw(base, 'HEAD', '/pilot/v1/info', bearer)).status, 200);
    // A HEAD counts against the read budget, as the GET it is answered as (it used to count as a write: 3 a minute here).
    for (let i = 0; i < 6; i++) assert.equal((await raw(base, 'HEAD', '/pilot/v1/info')).status, 200, `HEAD ${i + 1}`);
    // The GET with the token is authenticated, as before.
    assert.equal((await raw(base, 'GET', '/pilot/v1/inbox', bearer)).status, 200);
    assert.deepEqual(reached, [['authenticate', 'vpa_poet']]);
  } finally { srv.close(); }
});
