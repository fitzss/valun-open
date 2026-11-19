// Child process of test/local-limits.unit.test.mjs (R-7; fix inbox #145): lib/environment.mjs reads VALUN_ENVIRONMENT once,
// at start, so each setting runs in a process of its own. It builds what server.mjs builds from the same environment
// (lib/pilot/limits.mjs limitSettings: the Pilot's join caps and the routes' budgets), with a stub tracker (no notes),
// self-serve joins on and one sandbox agent, then runs the steps given and prints one JSON line with what each answered.
// Usage: node test/fixtures/local-limits.mjs '[STEP, ...]'   (with VALUN_ENVIRONMENT and the PILOT_ settings as the test sets them)
// A step: {do: 'joins', n} (n self-serve joins from loopback, each with a handle of its own: their statuses and the first
// refusal), {do: 'writes', n} (POSTs to an unknown route until the first 429, at most n), {do: 'info'} (GET /info),
// {do: 'admin', from, token, headers} (POST /admin/invites from the local address `from`, 127.0.0.1 or another of
// 127.0.0.0/8, which the server does not take as its loopback; with the admin token when `token`, and `headers`),
// {do: 'write', method, path, headers, body} (one request with exactly these headers, Host included, and `body` as it is),
// {do: 'count'} (how many participants the server holds).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {LOCAL} from '../../lib/environment.mjs';
import {Pilot, PilotStore, PILOT_DENOMINATION} from '../../lib/pilot/core.mjs';
import {createPilotRoutes} from '../../lib/pilot/http.mjs';
import {createHandler} from '../../lib/http.mjs';
import {limitSettings} from '../../lib/pilot/limits.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const steps = JSON.parse(process.argv[2] || '[]');
const settings = limitSettings(process.env, {local: LOCAL});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-limits-child-'));
const basis = {nft: 'c'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [], health: async () => true};
const pilot = new Pilot({store: new PilotStore(dir), basis, openSandbox: true, openNetwork: true, log: () => {}, joinLimits: settings.joinLimits});
const SANDBOX = {id: 'vp_5a5a5a5a5a5a', handle: 'sandbox-exact', operator: 'the operator', status: 'active', created_at: '2026-11-01T00:00:00.000Z'};
pilot.s.participants[SANDBOX.id] = {...SANDBOX};
pilot.sandboxIds = new Set([SANDBOX.id]);
const ADMIN_TOKEN = 'the-fixture-admin-token';
const routes = createPilotRoutes({pilot, cfg: LOCAL ? {...settings.routeCfg} : {}, adminTokenHash: crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex')});
const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir, pilotRoutes: routes}));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const send = async (method, p, body) => {
  const r = await fetch(base + p, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  return {status: r.status, body: await r.json().catch(() => null)};
};
// One request with exactly the headers given (node:http, which sends a Host of its own only when none is given).
const raw = (opts, body) => new Promise((resolve, reject) => {
  const rq = http.request({host: '127.0.0.1', port: server.address().port, setHost: !Object.keys(opts.headers || {}).some(k => k.toLowerCase() === 'host'), ...opts}, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } resolve({status: res.statusCode, body: j}); });
  });
  rq.on('error', reject);
  rq.end(body || undefined);
});

const out = {local: LOCAL, ignored: settings.ignored, errors: settings.errors, steps: []};
try {
  let n = 0;
  for (const step of steps) {
    if (step.do === 'joins') {
      const statuses = [];
      let refusal = null;
      for (let i = 0; i < step.n; i++) {
        const r = await send('POST', '/pilot/v1/join-sandbox', {handle: `limits-${++n}`, operator: 'the limits test'});
        statuses.push(r.status);
        if (r.status !== 201 && !refusal) refusal = r;
      }
      out.steps.push({statuses, refusal});
    } else if (step.do === 'writes') {
      let at = null, refusal = null;
      for (let i = 1; i <= step.n && !refusal; i++) {
        const r = await send('POST', '/pilot/v1/no-such-write', {});
        if (r.status === 429) { at = i; refusal = r; }
      }
      out.steps.push({at, refusal});
    } else if (step.do === 'info') out.steps.push(await send('GET', '/pilot/v1/info'));
    else if (step.do === 'admin') {
      const body = JSON.stringify({note: 'fixture', max_uses: 1});
      out.steps.push(await raw({method: 'POST', path: '/pilot/v1/admin/invites', localAddress: step.from,
        headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(step.token ? {'x-valun-admin': ADMIN_TOKEN} : {}), ...(step.headers || {})}}, body));
    } else if (step.do === 'write') {
      const body = step.body ?? '';
      out.steps.push(await raw({method: step.method || 'POST', path: step.path, headers: {...(body ? {'content-length': Buffer.byteLength(body)} : {}), ...step.headers}}, body));
    } else if (step.do === 'count') out.steps.push({participants: Object.keys(pilot.s.participants).length});
    else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
} finally {
  server.close();
  fs.rmSync(dir, {recursive: true, force: true});
}
process.stdout.write(`${JSON.stringify(out)}\n`);
