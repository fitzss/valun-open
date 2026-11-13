// HTTP surface: static UI, the JSON API (/api/*) and the MCP endpoint (/mcp). The Basis tracker is never proxied.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {UserError} from './valun.mjs';
import {PROTOCOL_VERSIONS} from './mcp.mjs';
import {renderLoopNotFound} from './pilot/loops.mjs';
import {renderAgentNotFound, renderMaintainersPage} from './pilot/agents.mjs';
import {A2A_PATHS} from './a2a.mjs';
import {ON_TESTNET} from './pilot/units.mjs';

const SKILL_FILE = ON_TESTNET ? 'skill-testnet.md' : 'skill.md';
const LLMS_FILE = ON_TESTNET ? 'llms-testnet.txt' : 'llms.txt';
const STATIC = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css'],
  ['/pilot', 'pilot.html'], ['/pilot/', 'pilot.html'], ['/pilot.js', 'pilot.js'],      // pilot network UI (separate page)
  ['/network', 'network.html'], ['/network.js', 'network.js'], ['/network.css', 'network.css'],   // live network view (public, read-only)
  ['/home', 'home.html'], ['/home.js', 'home.js'], ['/home.css', 'home.css'], ['/loop.css', 'loop.css'],   // landing and loop cards
  // The record's evidence and the attacks run on it (public, read-only); the report is written by scripts/evidence-attacks.mjs.
  ['/memory', 'memory.html'], ['/memory.js', 'memory.js'], ['/memory.css', 'memory.css'], ['/evidence-attacks.json', 'evidence-attacks.json'],
  ['/og.png', 'og.png'],   // the link-preview image (Open Graph) of the landing and the loop cards
  ['/favicon.svg', 'favicon.svg'],   // the mark (every public page links it)
  // For agents: the one-file onboarding any agent can follow ("Read valun.tech/skill.md and follow it"), the same file
  // at /agents.md, and the llms.txt index of what is here.
  // The testnet network (valun-testnet-1) serves its own (public/skill-testnet.md: nanoERG, settlement on Ergo testnet;
  // public/llms-testnet.txt: the testnet's own links).
  ['/skill.md', SKILL_FILE], ['/agents.md', SKILL_FILE], ['/llms.txt', LLMS_FILE],
  // Self-hosted fonts (the CSP allows no external font); their OFL license texts are in public/fonts.
  ['/fonts/jost-latin.woff2', 'fonts/jost-latin.woff2'], ['/fonts/jetbrains-mono-latin-400.woff2', 'fonts/jetbrains-mono-latin-400.woff2']]);
// The public domain's home page is the Close the Loop landing (public/home.html, also at /home on every host); the desk
// console stays at / on valun-desk.fly.dev and every other host.
const HOME_HOSTS = new Set(['valun.tech', 'www.valun.tech']);
const HTML = 'text/html; charset=utf-8';
const TYPES = {'.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8'};
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};

export function createHandler({service, mcp, cfg, publicDir, pilotRoutes = null, a2a = null}) {
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, {'Content-Type': type, ...SEC_HEADERS, ...extra});
    res.end(body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1));
  };
  async function readBody(req, limit) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw new UserError('request body too large', 413); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function readJson(req) {
    const t = await readBody(req, 16_384);
    if (!t) return {};
    try { return JSON.parse(t); } catch { throw new UserError('body must be JSON'); }
  }
  // Behind Fly's proxy every request comes from the proxy; the client address is in Fly-Client-IP.
  const clientIp = req => (cfg.trustFlyClientIp && req.headers['fly-client-ip']) || req.socket.remoteAddress || '?';
  const hits = new Map();
  const rateLimited = ip => {
    const now = Date.now(), w = (hits.get(ip) || []).filter(t => now - t < 600_000);
    w.push(now); hits.set(ip, w);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 600_000)) hits.delete(k);
    return w.length > 120;
  };
  const tokenOk = got => {
    if (!cfg.writeToken) return true;
    const a = Buffer.from(String(got || '')), b = Buffer.from(cfg.writeToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const requestToken = req => req.headers['x-valun-token'] || (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1];

  async function mcpEndpoint(req, res) {
    if (req.method !== 'POST') return send(res, 405, {error: 'POST JSON-RPC messages to this endpoint (stateless Streamable HTTP; no SSE stream)'}, undefined, {Allow: 'POST'});
    // DNS-rebinding guard: a browser page from another site must not drive this endpoint.
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try { sameOrigin ||= new URL(origin).host === req.headers.host; } catch { /* "null" or malformed origin */ }
    if (!sameOrigin) return send(res, 403, {error: 'cross-origin requests are not allowed'});
    const pv = req.headers['mcp-protocol-version'];
    if (pv && !PROTOCOL_VERSIONS.includes(pv)) return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: -32600, message: `unsupported MCP-Protocol-Version ${pv}`}});
    let body;
    try { body = JSON.parse(await readBody(req, 65_536)); } catch (e) {
      return send(res, e instanceof UserError ? 413 : 400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: e instanceof UserError ? e.message : 'parse error'}});
    }
    const ip = clientIp(req);
    const ctx = {writeAllowed: tokenOk(requestToken(req)), rateLimited: () => rateLimited(ip)};
    const msgs = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(msgs.map(m => mcp.handle(m, ctx)))).filter(Boolean);
    if (!out.length) return send(res, 202, null);
    return send(res, 200, Array.isArray(body) ? out : out[0]);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const GH = req.method === 'GET' || req.method === 'HEAD';
    if (p === '/' && GH && HOME_HOSTS.has(String(req.headers.host || '').toLowerCase().replace(/:\d+$/, ''))) {
      return send(res, 200, fs.readFileSync(path.join(publicDir, 'home.html')), HTML);
    }
    // A loop card (lib/pilot/loops.mjs): server-rendered with its Open Graph tags, for link previews.
    let lm;
    if (GH && (lm = /^\/loop\/([^/]{1,64})$/.exec(p))) {
      if (pilotRoutes?.loopPage) return pilotRoutes.loopPage(req, res, lm[1], send, clientIp);
      return send(res, 404, renderLoopNotFound(), HTML);
    }
    // The open-source maintainers page (lib/pilot/agents.mjs), static text in the shell of the loop cards.
    if (GH && p === '/maintainers') return send(res, 200, renderMaintainersPage(), HTML);
    // An agent's public page (lib/pilot/agents.mjs), server-rendered with its Open Graph tags, for sharing.
    if (GH && (lm = /^\/agent\/([^/]{1,64})$/.exec(p))) {
      if (pilotRoutes?.agentPage) return pilotRoutes.agentPage(req, res, lm[1], send, clientIp);
      return send(res, 404, renderAgentNotFound(), HTML);
    }
    // The A2A front door (lib/a2a.mjs): the Agent Card and the JSON-RPC endpoint, with their own CORS and rate limit.
    if (a2a && A2A_PATHS.has(p)) return a2a(req, res, p, send, clientIp);
    if (req.method === 'GET' && STATIC.has(p)) { const f = STATIC.get(p); return send(res, 200, fs.readFileSync(path.join(publicDir, f)), TYPES[path.extname(f)]); }
    if (p === '/mcp') return mcpEndpoint(req, res);
    if (pilotRoutes && p.startsWith('/pilot/v1/')) return pilotRoutes(req, res, url, send, clientIp);
    if (!p.startsWith('/api/')) return send(res, 404, {error: 'not found'});
    if (req.method === 'POST') {
      if (!tokenOk(requestToken(req))) return send(res, 401, {error: 'this deployment requires the demo write token (x-valun-token)'});
      if (rateLimited(clientIp(req))) return send(res, 429, {error: 'too many changes from this address; try again in a few minutes'});
    }
    let m;
    const G = req.method === 'GET', P = req.method === 'POST';
    if (G && p === '/api/status') return send(res, 200, await service.status());
    if (G && p === '/api/participants') return send(res, 200, await service.participants());
    if (P && p === '/api/participants') return send(res, 201, await service.createParticipant(await readJson(req)));
    if (P && (m = /^\/api\/participants\/(p-\d{4})\/policy$/.exec(p))) return send(res, 200, await service.setPolicy(m[1], await readJson(req)));
    if (G && p === '/api/offers') return send(res, 200, service.offers());
    if (P && p === '/api/offers') return send(res, 201, await service.createOffer(await readJson(req)));
    if (G && (m = /^\/api\/offers\/(o-\d{4})$/.exec(p))) return send(res, 200, await service.inspectOffer(m[1]));
    if (P && (m = /^\/api\/offers\/(o-\d{4})\/decision$/.exec(p))) return send(res, 200, await service.decide(m[1], await readJson(req)));
    if (P && (m = /^\/api\/offers\/(o-\d{4})\/withdraw$/.exec(p))) return send(res, 200, await service.withdraw(m[1], await readJson(req)));
    if (G && p === '/api/ledger') return send(res, 200, await service.ledger());
    if (G && p === '/api/testnet') return send(res, 200, await service.testnet(url.searchParams.get('live') === '1'));
    if (G && p === '/api/audit') return send(res, 200, service.audit());
    return send(res, 404, {error: 'not found'});
  }

  return async (req, res) => {
    try { await route(req, res); } catch (e) {
      if (e instanceof UserError) return send(res, e.code, {error: e.message});
      if (e.name === 'PilotError') return send(res, e.status, {error: e.code, message: e.message, ...(e.extra || {})});
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}: ${e.message}`);
      // Tracker and signer failures get their own code and a fixed, non-secret message (OQ-35); a signer outage is a 503
      // (OQ-31). The details stay in the log line above.
      if (e.name === 'BasisError') {
        const status = e.code === 'signer_unavailable' ? 503 : 502;
        return send(res, status, String(req.url).startsWith('/pilot/') ? {error: e.code, message: e.publicMessage} : {error: e.publicMessage, code: e.code});
      }
      send(res, 502, {error: 'internal error'});
    }
  };
}
