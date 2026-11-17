// Every answer says its length (lib/http.mjs send(): Content-Length, none on a 204 or 304). Before, writeHead ran before
// end() and Node framed every body as chunked: a client could read the whole body and still fail on the missing last
// chunk when a connection between it and the server ended early (http.client: IncompleteRead with every byte read; a
// tester's agent saw this on Nov 16, evidence/muse-report-2026-11-17 in the fix inbox). With the length, a client knows
// the answer is complete once it has read that many bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHandler} from '../lib/http.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function serve(pilotRoutes) {
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir, pilotRoutes}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {srv, base: `http://127.0.0.1:${srv.address().port}`};
}

// A raw HTTP/1.1 request, so the test sees the framing itself (fetch would hide it).
function raw(base, method, p) {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const req = http.request({host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: {connection: 'close'}}, res => {
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
