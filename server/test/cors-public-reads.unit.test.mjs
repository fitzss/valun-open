// Fix inbox #106: the network's public reads (GET /pilot/v1/... with no token) carry Access-Control-Allow-Origin: *, so
// a page or a badge on another origin can read them, their error answers too (a 404, a 429, a 503 with retry_after_ms,
// the tracker's 502); a request with a token, and any write, carries no such header, whatever it is answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandler} from '../lib/http.mjs';
import {PilotError} from '../lib/pilot/core.mjs';
import {BasisError} from '../lib/basis.mjs';
import {UserError} from '../lib/valun.mjs';

// A stand-in for the pilot's routes: /pilot/v1/fail/<kind> throws what the real routes throw, anything else answers 200.
const THROWS = {
  'not-found': () => new PilotError('not_found', 'no such participant', 404),
  'invalid': () => new PilotError('invalid_field', 'GET /ledger/committed takes no parameters'),
  'rate-limited': () => new PilotError('rate_limited', 'too many reads from this address', 429, {retry_after_ms: 1000}),
  'retry': () => new PilotError('no_confirmed_box', 'the tracker names no confirmed box yet', 503, {retry_after_ms: 60000}),
  'user': () => new UserError('body must be JSON'),
  'tracker': () => new BasisError('connect ECONNREFUSED', {code: 'tracker_unavailable'}),
  'internal': () => new Error('something broke'),
};
async function withServer(fn) {
  const pilotRoutes = (req, res, url, send) => {
    const m = /^\/pilot\/v1\/fail\/([a-z-]+)$/.exec(url.pathname);
    if (m) throw THROWS[m[1]]();
    return send(res, 200, {ok: true, path: url.pathname});
  };
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
const quiet = (t) => t.mock.method(console, 'error', () => {});

test('fix inbox #106: a public read of /pilot/v1 carries Access-Control-Allow-Origin: *', async () => {
  await withServer(async base => {
    for (const p of ['/pilot/v1/info', '/pilot/v1/participants', '/pilot/v1/ledger', '/pilot/v1/loops']) {
      const r = await fetch(base + p, {headers: {Origin: 'https://badge.example'}});
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('access-control-allow-origin'), '*', p);
    }
  });
});

test('fix inbox #106: the error answers of a public read carry it too, with their status and body intact', async t => {
  quiet(t);
  await withServer(async base => {
    for (const [kind, status, error] of [['not-found', 404, 'not_found'], ['invalid', 400, 'invalid_field'], ['rate-limited', 429, 'rate_limited'],
      ['retry', 503, 'no_confirmed_box'], ['user', 400, 'body must be JSON'], ['tracker', 502, 'tracker_unavailable'], ['internal', 502, 'internal error']]) {
      const r = await fetch(`${base}/pilot/v1/fail/${kind}`, {headers: {Origin: 'https://badge.example'}});
      const body = await r.json();
      assert.equal(r.status, status, kind);
      assert.equal(body.error, error, kind);
      assert.equal(r.headers.get('access-control-allow-origin'), '*', kind);
      if (kind === 'retry') assert.equal(body.retry_after_ms, 60000);
    }
  });
});

test('fix inbox #106: a request with a token, and a write, carry no CORS header, answered or refused', async t => {
  quiet(t);
  await withServer(async base => {
    for (const p of ['/pilot/v1/me', '/pilot/v1/fail/not-found', '/pilot/v1/fail/tracker']) {
      const withToken = await fetch(base + p, {headers: {Authorization: 'Bearer vpa_x', Origin: 'https://badge.example'}});
      assert.equal(withToken.headers.get('access-control-allow-origin'), null, p);
    }
    for (const p of ['/pilot/v1/deals', '/pilot/v1/fail/not-found']) {
      const write = await fetch(base + p, {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json', Origin: 'https://badge.example'}});
      assert.equal(write.headers.get('access-control-allow-origin'), null, p);
    }
    // Outside /pilot/v1 nothing changes.
    const other = await fetch(base + '/api/nothing', {headers: {Origin: 'https://badge.example'}});
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});
