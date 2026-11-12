// The live network page (/network): its three static routes, the page's CSP compliance (no inline script or style,
// same-origin public reads only), and its change detection (public/network.js) on the tracker-note changes of the
// sandbox tour (agent.py TOUR_GOALS): a new note, a debt transfer, set-offs of a 2-cycle and a 3-cycle, and the same
// steps when one poll sees several of them at once.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHandler} from '../lib/http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
let server, base;

before(async () => {
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('/network, /network.js and /network.css serve the page files with their content types and the security headers', async () => {
  for (const [route, file, type] of [['/network', 'network.html', 'text/html; charset=utf-8'], ['/network.js', 'network.js', 'text/javascript; charset=utf-8'],
    ['/network.css', 'network.css', 'text/css; charset=utf-8']]) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    assert.equal(r.headers.get('content-type'), type, route);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'; connect-src 'self'/, route);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', route);
    assert.equal(await r.text(), pub(file), route);
  }
  for (const route of ['/network.html', '/network/x', '/network.mjs']) assert.equal((await fetch(base + route)).status, 404, route);
});

test('the page keeps the CSP: no inline script, style or handler; only its own files; public same-origin reads without tokens', () => {
  const html = pub('network.html'), js = pub('network.js');
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /\ssrc="\/network\.js"/, 'every script is the page\'s own file');
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i, 'no inline style or event handler');
  assert.match(html, /<link rel="stylesheet" href="\/network\.css">/);
  assert.deepEqual([...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]), ['https://github.com/fitzss/valun-open#readme'], 'the only external URL is a link');
  const reads = [...js.matchAll(/getJson\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(reads)], ['/api/status', '/pilot/v1/clearing', '/pilot/v1/info', '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/participants?all=1']);
  assert.match(html, /<a class="hook" href="\/">Close a loop with your own agent →<\/a>/, 'the header links to the landing');
  assert.match(html, /<a class="logo" href="\/" aria-label="Valun home"><svg class="mark" viewBox="0 0 100 100" aria-hidden="true">/, 'the mark and the wordmark');
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(js, /a\.href = `\/loop\/\$\{id\}`/, 'set-off events link to their loop cards');
  assert.doesNotMatch(js, /authorization|bearer|x-valun|localStorage|innerHTML|eval\(/i);
  assert.match(js, /credentials: 'omit'/);
});

// ---------- change detection ----------
const {edgesOf, diffEdges, explain, modeLine, kindOf, matchLoop, POLL_MS, MAX_POLL_MS} = await import(pathToFileURL(path.join(root, 'public', 'network.js')).href);
const KEY = {you: '02aa', exact: '02bb', mallory: '02cc', other: '02dd'};
let clock = 1_800_000_000_000;
// One tracker note per pair; `ts` residue says how it was last updated (999 transfer, 998 set-off, else a note).
const ts = residue => { clock += 5000; return clock - (clock % 1000) + residue; };
function ledger(rows) {
  return rows.map(([i, r, total, t]) => ({issuer: i, issuer_handle: i, recipient: r, recipient_handle: r, issuer_pubkey: KEY[i], recipient_pubkey: KEY[r],
    total, redeemed: 0, outstanding: total, timestamp: t, confirmation: 'local_only', unit: 'PC'}));
}
const events = (a, b) => explain(diffEdges(edgesOf(ledger(a)), edgesOf(ledger(b))))
  .map(({edges, ...e}) => e);

test('change detection: each step of the sandbox tour, one poll per step', () => {
  const t1 = ts(123), s0 = [], s1 = [['exact', 'you', 3, t1]];
  assert.deepEqual(events(s0, s1), [{type: 'note', from: 'exact', to: 'you', amount: 3, first: true}]);
  // step 2: you pay mallory with 2 PC of exact's debt to you (both edges carry the transfer's timestamp)
  const T = ts(999), s2 = [['exact', 'you', 1, T], ['exact', 'mallory', 2, T]];
  assert.deepEqual(events(s1, s2), [{type: 'transfer', issuer: 'exact', from: 'you', to: 'mallory', amount: 2}]);
  // step 3: you buy from exact with your own note (2 PC), then the 2-cycle you -> exact -> you clears 1 PC
  const n3 = ts(456), s3a = [...s2, ['you', 'exact', 2, n3]];
  assert.deepEqual(events(s2, s3a), [{type: 'note', from: 'you', to: 'exact', amount: 2, first: true}]);
  const S3 = ts(998), s3 = [['exact', 'you', 0, S3], ['exact', 'mallory', 2, T], ['you', 'exact', 1, S3]];
  assert.deepEqual(events(s3a, s3), [{type: 'setoff', cycle: ['exact', 'you'], amount: 2, each: 1}]);
  // step 4: mallory pays you 3 PC with its own note, then the 3-cycle mallory -> you -> exact -> mallory clears 1 PC
  const n4 = ts(789), s4a = [...s3, ['mallory', 'you', 3, n4]];
  assert.deepEqual(events(s3, s4a), [{type: 'note', from: 'mallory', to: 'you', amount: 3, first: true}]);
  const S4 = ts(998), s4 = [['exact', 'you', 0, S3], ['exact', 'mallory', 1, S4], ['you', 'exact', 0, S4], ['mallory', 'you', 2, S4]];
  const e4 = events(s4a, s4);
  assert.equal(e4.length, 1);
  assert.equal(e4[0].type, 'setoff'); assert.equal(e4[0].amount, 3); assert.equal(e4[0].each, 1);
  assert.deepEqual([...e4[0].cycle].sort(), ['exact', 'mallory', 'you']);
});

test('change detection: several tour steps seen in one poll', () => {
  // step 3 in one poll: a new 2 PC note you -> exact and the 1 PC set-off (you -> exact is up 1, exact -> you down 1)
  const T = ts(999), before3 = [['exact', 'you', 1, T], ['exact', 'mallory', 2, T]];
  const S3 = ts(998), after3 = [['exact', 'you', 0, S3], ['exact', 'mallory', 2, T], ['you', 'exact', 1, S3]];
  assert.deepEqual(events(before3, after3), [{type: 'note', from: 'you', to: 'exact', amount: 2, first: true},
    {type: 'setoff', cycle: ['exact', 'you'], amount: 2, each: 1}]);
  // step 5 in one poll: you pay exact with 2 PC of mallory's debt (transfer mallory -> you to mallory -> exact), then the
  // server-only 2-cycle exact <-> mallory clears 1 PC (so mallory -> exact's last update is the set-off)
  const S4 = ts(998), before5 = [['exact', 'mallory', 1, S4], ['mallory', 'you', 2, S4]];
  const T5 = ts(999), S5 = ts(998), after5 = [['exact', 'mallory', 0, S5], ['mallory', 'you', 0, T5], ['mallory', 'exact', 1, S5]];
  assert.deepEqual(events(before5, after5), [{type: 'transfer', issuer: 'mallory', from: 'you', to: 'exact', amount: 2},
    {type: 'setoff', cycle: ['exact', 'mallory'], amount: 2, each: 1}]);
  // seen on a local run: two transfers in one poll (exact's note demo -> mallory, mallory's note you -> exact) make the
  // 2-cycle exact <-> mallory that a set-off then clears by 2: both partner edges end where they started (net 0)
  const Ta = ts(999), Tb = ts(999), Sx = ts(998), demo = 'other';
  const before6 = [['exact', demo, 3, ts(1)], ['mallory', 'you', 2, ts(2)], ['exact', 'mallory', 1, ts(3)], ['mallory', 'exact', 0, ts(4)]];
  const after6 = [['exact', demo, 1, Ta], ['mallory', 'you', 0, Tb], ['exact', 'mallory', 1, Sx], ['mallory', 'exact', 0, Sx]];
  assert.deepEqual(events(before6, after6), [{type: 'transfer', issuer: 'exact', from: demo, to: 'mallory', amount: 2},
    {type: 'transfer', issuer: 'mallory', from: 'you', to: 'exact', amount: 2}, {type: 'setoff', cycle: ['exact', 'mallory'], amount: 4, each: 2}]);
  // nothing changed: no events; a timestamp change alone (a note re-signed at the same total) is not a payment
  assert.deepEqual(events(after5, after5), []);
  // a note whose total went down with no transfer or cycle to explain it
  assert.deepEqual(events([['other', 'you', 5, ts(1)]], [['other', 'you', 4, ts(2)]]), [{type: 'reduced', from: 'other', to: 'you', amount: 1}]);
});

test('participant kinds, the mode line and the polling bounds', () => {
  assert.equal(kindOf({handle: 'sandbox-exact', operator_run: true}), 'agent');
  assert.equal(kindOf({handle: 'sandbox-mallory'}), 'agent');
  assert.equal(kindOf({handle: 'demo1', sandbox_only: true}), 'sandbox');
  assert.equal(kindOf({handle: 'stats', operator_run: true}), 'operator');
  assert.equal(kindOf({handle: 'bea'}), 'invited');
  const status = {basis: {pin: 'Basis tracker v3.2: Valun fork commit 43704183 (branch circulating-credit-v3.2), as the tracker reports itself'}};
  assert.equal(modeLine({features: ['bound_notes/1', 'circulation/1'], description: '... PC have no value.', network: 'valun-pilot-1'}, status),
    'circulating credit: on · Basis tracker v3.2 · valun-pilot-1');
  assert.equal(modeLine({features: ['bound_notes/1', 'circulation/1'], description: 'circulating credit is on for sandbox participants only'}, null), 'circulating credit: sandbox only');
  assert.equal(modeLine({network: 'valun-pilot-1'}, {basis: {pin: 'Basis 3df7ed93ee83 + sigma-rust 8120eddd'}}), 'circulating credit: off · Basis 3df7ed93 · valun-pilot-1');
  assert.equal(POLL_MS, 10_000); assert.equal(MAX_POLL_MS, 60_000);
});

test('a set-off event is matched to its loop card by its members (any order), newest first, each loop once', () => {
  const loops = [{id: 'vs_000000000000000c', members: [{handle: 'you'}, {handle: 'exact'}]},
    {id: 'vs_000000000000000b', members: [{handle: 'mallory'}, {handle: 'you'}, {handle: 'exact'}]},
    {id: 'vs_000000000000000a', members: [{handle: 'exact'}, {handle: 'you'}]}];
  assert.equal(matchLoop(new Set(['exact', 'mallory', 'you']), loops)?.id, 'vs_000000000000000b');
  assert.equal(matchLoop(new Set(['exact', 'you']), loops)?.id, 'vs_000000000000000c');
  assert.equal(matchLoop(new Set(['exact', 'you']), loops, new Set(['vs_000000000000000c']))?.id, 'vs_000000000000000a');
  assert.equal(matchLoop(new Set(['exact', 'other']), loops), null);
  assert.equal(matchLoop(new Set(['exact', 'you']), null), null);
});

test('on valun.tech (and www) / is the Close the Loop landing; on any other host / is still the desk console', async () => {
  const get = (host, method = 'GET') => new Promise((resolve, reject) => {
    const r = http.request(base + '/', {method, headers: {host}}, res => { res.resume(); res.on('end', () => resolve(res)); });
    r.on('error', reject); r.end();
  });
  for (const host of ['valun.tech', 'www.valun.tech', 'VALUN.TECH', 'valun.tech:443']) {
    const r = await get(host);
    assert.equal(r.statusCode, 200, host);
    assert.equal(r.headers.location, undefined, host);
  }
  assert.equal((await get('valun.tech', 'HEAD')).statusCode, 200);
  for (const host of ['valun-desk.fly.dev', '127.0.0.1', 'evil.valun.tech', 'valun.tech.example']) {
    const r = await get(host);
    assert.equal(r.statusCode, 200, host);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', host);
  }
});
