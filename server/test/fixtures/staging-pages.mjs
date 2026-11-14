// Child process of test/staging-banner.unit.test.mjs (fix inbox #41). VALUN_ENVIRONMENT is read once, at start
// (lib/environment.mjs), so each value runs in a process of its own: this one serves every HTML page the server has,
// /staging.css and GET /pilot/v1/info over real HTTP, without a pilot (the not-found pages lib/http.mjs renders
// itself) and with a small in-memory one (test/fixtures/a2a-pilot.mjs, no tracker: the loop card, the agent page and
// their not-found pages). Prints one JSON line: the environment it read, /info, and each response (its body in base64)
// beside the page itself, without any banner: the file of public/, or what the page's renderer returns.
// Usage: node test/fixtures/staging-pages.mjs   (the test runs it with PILOT_NETWORK=valun-testnet-1, as staging and the
// testnet run, and VALUN_ENVIRONMENT set or not)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ENVIRONMENT} from '../../lib/environment.mjs';
import {createHandler} from '../../lib/http.mjs';
import {createPilotRoutes} from '../../lib/pilot/http.mjs';
import {ON_TESTNET} from '../../lib/pilot/units.mjs';
import {loopOf, loopsOf, renderLoopPage, renderLoopNotFound} from '../../lib/pilot/loops.mjs';
import {agentView, renderAgentPage, renderAgentNotFound, renderMaintainersPage} from '../../lib/pilot/agents.mjs';
import {fakePilot} from './a2a-pilot.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
// The A2A fixture's pilot, with what GET /info and the loop card also read.
const pilot = Object.assign(fakePilot(), {mode: 'off', unit: ON_TESTNET ? 'nanoERG' : 'PC',
  basis: {denomination: ON_TESTNET ? 'erg' : 'pc', nft: 'ab'.repeat(32)}});
pilot.setoff = id => pilot.s.setoffs[id] ?? null;
const publicOf = x => pilot.publicParticipant(x);
const LOOP = 'vs_00000000000000aa', poet = pilot.s.participants.vp_000000000002;

const listen = async handler => { const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; };
const withPilot = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir, pilotRoutes: createPilotRoutes({pilot, cfg: {}})}));
const bare = await listen(createHandler({service: {}, mcp: {}, cfg: {}, publicDir}));
const get = (server, route, host = '127.0.0.1') => new Promise((resolve, reject) => {
  http.get({host: '127.0.0.1', port: server.address().port, path: route, headers: {host}}, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'],
      body: Buffer.concat(chunks)}));
  }).on('error', reject);
});

// Every HTML page: the files of public/ that lib/http.mjs serves (STATIC, and the landing valun.tech gets at /), the
// pages it renders itself, and the pages the pilot's routes render (lib/pilot/http.mjs), each with its own page.
const PAGES = [
  {route: '/', file: 'index.html'}, {route: '/pilot', file: 'pilot.html'}, {route: '/pilot/', file: 'pilot.html'},
  {route: '/network', file: 'network.html'}, {route: '/home', file: 'home.html'}, {route: '/memory', file: 'memory.html'},
  {route: '/', host: 'valun.tech', file: 'home.html'},
  {route: '/maintainers', render: renderMaintainersPage},
  {route: '/loop/vs_0000000000000001', bare: true, render: renderLoopNotFound},
  {route: '/agent/nobody', bare: true, render: renderAgentNotFound},
  {route: `/loop/${LOOP}`, render: () => renderLoopPage(loopOf(pilot.setoff(LOOP), pilot.s.participants, publicOf))},
  {route: '/loop/vs_0000000000000001', render: renderLoopNotFound},
  // The fixture's pilot has no publicPosition: the page shows without the record, as when it cannot be read.
  {route: '/agent/open-poet', render: () => renderAgentPage(agentView(pilot.directoryRecord(poet), null,
    loopsOf(pilot.s.setoffs, pilot.s.participants, publicOf), {now: Date.now(), dormant: false}))},
  {route: '/agent/nobody', render: renderAgentNotFound},
];

const out = {environment: ENVIRONMENT, pages: []};
try {
  out.info = JSON.parse((await get(withPilot, '/pilot/v1/info')).body);
  for (const p of PAGES) {
    const r = await get(p.bare ? bare : withPilot, p.route, p.host);
    const page = p.file ? fs.readFileSync(path.join(publicDir, p.file)) : Buffer.from(p.render(), 'utf8');
    out.pages.push({route: p.route, host: p.host ?? null, file: p.file ?? null, pilot: !p.bare, status: r.status, type: r.type, csp: r.csp,
      body: r.body.toString('base64'), page: page.toString('base64')});
  }
  const css = await get(withPilot, '/staging.css');
  out.css = {status: css.status, type: css.type, body: css.body.toString('base64')};
} finally { withPilot.close(); bare.close(); }
process.stdout.write(`${JSON.stringify(out)}\n`);
