// The live network page (/network): its three static routes, the page's CSP compliance (no inline script or style,
// same-origin public reads only), and its change detection (public/network.js) on the tracker-note changes of the
// sandbox tour (agent.py TOUR_GOALS): a new note, a debt transfer, set-offs of a 2-cycle and a 3-cycle, and the same
// steps when one poll sees several of them at once. Then the page's parts and how they are laid out (fix inbox #47),
// and the page itself run on the testnet's reads (test/network-dom.mjs): its live events in tERG from the first poll on
// (fix inbox #48).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHandler} from '../lib/http.mjs';
import {readBody, runNetworkPage, cssRules} from './network-dom.mjs';
import {settle} from './console-dom.mjs';

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
  assert.deepEqual([...new Set(reads)], ['/api/status', '/pilot/v1/chain', '/pilot/v1/clearing', '/pilot/v1/info', '/pilot/v1/ledger',
    '/pilot/v1/loops', '/pilot/v1/participants?all=1', '/pilot/v1/reserves']);   // chain and reserves: the testnet's strip
  assert.match(html, /<a class="hook" href="\/">Close a loop with your own agent →<\/a>/, 'the header links to the landing');
  assert.match(html, /<a class="logo" href="\/" aria-label="Valun home"><svg class="mark" viewBox="0 0 100 100" aria-hidden="true">/, 'the mark and the wordmark');
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(js, /a\.href = `\/loop\/\$\{id\}`/, 'set-off events link to their loop cards');
  assert.doesNotMatch(js, /authorization|bearer|x-valun|localStorage|innerHTML|eval\(/i);
  assert.match(js, /credentials: 'omit'/);
});

// ---------- change detection ----------
const {edgesOf, diffEdges, explain, modeLine, kindOf, matchLoop, POLL_MS, MAX_POLL_MS, moneyText, tergText, chainPanel, edgeWidth, nodeRadius} = await import(pathToFileURL(path.join(root, 'public', 'network.js')).href);
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

// The testnet network (valun-testnet-1): its amounts in tERG (the pilot's in PC, as before), and the "On Ergo testnet"
// strip from GET /chain and GET /reserves, with hex ids and only the explorer's links.
test('the testnet: amounts in tERG, and the Ergo testnet strip from /chain and /reserves (ids and links checked)', () => {
  assert.equal(moneyText(3, 'PC'), '3 PC');
  assert.equal(moneyText(1234), '1,234 PC');
  assert.equal(moneyText(3000000, 'nanoERG'), '0.003 tERG');
  assert.equal(moneyText(1500000000, 'nanoERG'), '1.5 tERG');
  assert.equal(moneyText(1000000000, 'nanoERG'), '1 tERG');
  assert.equal(tergText(194000000), '0.194');
  assert.equal(tergText(-2000000), '-0.002');
  const nft = 'dc'.repeat(32);
  const chain = {on_chain: true, tracker_nft_id: nft, anchoring: {anchored: true, confirmed_height: 640110, confirmed_box_id: 'e8'.repeat(32), pending_tx_id: null},
    links: {tracker_nft: `https://testnet.ergoplatform.com/en/token/${nft}`, tracker_address: 'https://evil.example/x"onclick'}};
  const c = chainPanel(chain, {reserves: [{box_id: '04'.repeat(32), handle: 'sandbox-exact', collateral_nanoerg: 194000000}, {box_id: 'not hex', handle: 'x', collateral_nanoerg: 5}]});
  assert.deepEqual(c, {anchored: true, height: 640110, pending: false, links: {nft: `https://testnet.ergoplatform.com/en/token/${nft}`, address: null},
    reserves: [{handle: 'sandbox-exact', nanoerg: 194000000}]});
  assert.equal(chainPanel({on_chain: false}, null), null, 'nothing before the bootstrap');
  assert.equal(chainPanel(null, null), null);
  const js = fs.readFileSync(path.join(root, 'public', 'network.js'), 'utf8');
  assert.match(js, /getJson\('\/pilot\/v1\/chain'\)/);
  assert.doesNotMatch(js, /innerHTML/, 'the strip is built with text nodes');
});

// ---------- the page's parts (fix inbox #47) ----------
// One screen, one column of parts: each as tall as its content, and the stage (graph and feed) takes the rest. Nothing
// counts the parts: the body was a grid of four rows, the "On Ergo testnet" strip a fifth part once /chain answered,
// and the stat cards, moved into the stage's flexible row, collapsed to a sliver (valun.tech at 1280x720, 2026-11-14).
// Staging's banner (public/staging.css, fix inbox #41) is one more part, first, and needs no rule of its own.
test('the page\'s parts: a column in which only the stage grows, so the strip and staging\'s banner count no rows (fix inbox #47)', () => {
  const parts = readBody(pub('network.html')).children;
  assert.deepEqual(parts.map(e => `${e.tagName.toLowerCase()}.${e.className}`), ['header.bar', 'section.chain', 'section.stats', 'main.stage', 'footer.legend']);
  assert.equal(parts[1].id, 'chain');
  assert.equal(parts[1].hidden, true, 'the strip shows once /chain answers');
  assert.equal(parts[2].children.filter(e => e.className.split(' ').includes('stat')).length, 5, 'five stat cards');
  const css = cssRules(pub('network.css')), staging = cssRules(pub('staging.css'));
  const decl = (rules, selector, prop, media = null) => rules.filter(r => r.selector === selector && r.media === media && prop in r.decls).at(-1)?.decls[prop];
  assert.deepEqual(['height', 'overflow', 'display', 'flex-direction'].map(p => decl(css, 'body', p)), ['100vh', 'hidden', 'flex', 'column'], 'one screen, a column');
  assert.equal(decl(css, 'body > *', 'flex'), 'none', 'each part as tall as its content');
  assert.equal(decl(css, '.stage', 'flex'), '1 1 0', 'the stage takes the rest');
  assert.equal(decl(css, '.stage', 'min-height'), '0');
  for (const part of ['.valun-staging', '.bar', '.chain', '.stats', '.stat', '.legend']) for (const prop of ['flex', 'flex-grow', 'flex-basis', 'height', 'min-height', 'max-height'])
    for (const rules of [css, staging]) assert.equal(decl(rules, part, prop), undefined, `${part} ${prop}: only the stage is sized by the screen`);
  for (const r of [...css, ...staging]) if (/(^|[\s>,(])body\b/.test(r.selector)) {
    assert.deepEqual(Object.keys(r.decls).filter(k => /^grid/.test(k)), [], `${r.selector}: no rows to count`);
  }
  assert.deepEqual(staging.filter(r => /\bbody\b/.test(r.selector)), [], 'staging.css leaves the body alone: its banner is the first part');
  // Phones: a scrolling page, the parts one under the other, the cards two by two.
  assert.equal(decl(css, 'body', 'display', '(max-width: 900px)'), 'block');
  assert.equal(decl(css, '.stats', 'grid-template-columns', '(max-width: 900px)'), 'repeat(2, minmax(0, 1fr))');
  // An amount fits its card: exact to the nanoERG it is wider than a count ("0.204645002 tERG", 2026-11-15).
  assert.equal(decl(css, '.stat', 'container-type'), 'inline-size');
  assert.match(decl(css, '.stat .v:has(.u)', 'font-size'), /^min\(.*\d+cqi\)$/);
});

// ---------- the testnet's live events (fix inbox #48) ----------
// The testnet's public reads (trimmed from valun.tech's, 2026-11-15): GET /info names the unit, nanoERG (denomination erg),
// and so does GET /ledger, beside its notes. Three agents and two notes, 145,493,002 nanoERG outstanding: the live
// events said "145,493,002 PC outstanding" on 2026-11-14, their first poll drawn before /info had answered.
const A = 'vp_00000000000a', B = 'vp_00000000000b', C = 'vp_00000000000c';
const agentRec = (id, handle, extra) => ({id, handle, status: 'active', joined_at: '2026-11-01T10:00:00.000Z', ...extra});
const noteRec = (issuer, recipient, outstanding) => ({issuer, recipient, issuer_pubkey: `02${issuer.slice(-1).repeat(64)}`,
  recipient_pubkey: `02${recipient.slice(-1).repeat(64)}`, total: outstanding, redeemed: 0, outstanding, timestamp: 1_799_999_000_123,
  confirmation: 'local_only', unit: 'nanoERG'});
const TESTNET = {
  '/pilot/v1/info': {network: 'valun-testnet-1', protocol: 'valun-deal/1', unit: 'nanoERG', denomination: 'erg', tracker_on_chain: true,
    features: ['bound_notes/1', 'circulation/1', 'guarantees/1'], novation: {transfer_ms: 999, setoff_ms: 998},
    description: 'Valun testnet network: independently controlled agents propose, negotiate and accept service-for-credit deals. Amounts are nanoERG on Ergo TESTNET.'},
  '/api/status': {basis: {pin: 'Basis tracker v4.4: Valun fork'}},
  '/pilot/v1/participants?all=1': [agentRec(A, 'sandbox-exact', {operator_run: true}),
    agentRec(B, 'ann', {sandbox_only: true, sandbox_expires_at: '2099-01-01T00:00:00.000Z'}), agentRec(C, 'bob')],
  '/pilot/v1/ledger': {unit: 'nanoERG', notes: [noteRec(A, B, 145_000_000), noteRec(B, C, 493_002)],
    reconciliation: [{issuer: A, recipient: B, status: 'match'}, {issuer: B, recipient: C, status: 'match'}]},
  '/pilot/v1/clearing': {unit: 'nanoERG', totals: {cleared: 2_000_000, cleared_PC: 2_000_000, setoffs_applied: 1, transferred: 1_000_000,
    transferred_PC: 1_000_000, transfers_applied: 1}},
  '/pilot/v1/loops': {unit: 'nanoERG', network: 'valun-testnet-1', loops: [{id: 'vs_00000000000000aa', applied_at: '2026-11-14T10:55:16.165Z',
    amount: 2_000_000, amount_PC: 2_000_000, members: [{handle: 'ann'}, {handle: 'bob'}]}]},
  '/pilot/v1/chain': {network: 'valun-testnet-1', on_chain: true, anchoring: {anchored: true, confirmed_height: 645_189, pending_tx_id: null}, links: {}},
  '/pilot/v1/reserves': {network: 'valun-testnet-1', unit: 'nanoERG', reserves: [{box_id: '04'.repeat(32), handle: 'sandbox-exact', collateral_nanoerg: 136_250_000}]},
};
// The page's reads answered from `routes`; a read named in `held` first waits for its promise.
const reads = (routes, held = {}) => async p => {
  await held[p];
  const body = routes[p];
  return body === undefined ? {ok: false, status: 404, json: async () => ({error: 'not_found'})} : {ok: true, status: 200, json: async () => structuredClone(body)};
};

test('the testnet\'s live events are in tERG from the first poll, also when /info answers after it (fix inbox #48)', async () => {
  const LINE = 'Watching the network: 3 agents, 2 credit notes, 0.145493002 tERG outstanding.';
  for (const order of ['/info after the first poll', '/info first']) {
    let release;
    const gate = new Promise(r => { release = r; }), body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads(TESTNET, order === '/info first' ? {'/pilot/v1/ledger': gate} : {'/pilot/v1/info': gate}));
    const $ = id => body.all('*').find(e => e.id === id), feed = cls => $('feed').children.filter(li => li.classList.contains(cls));
    const watching = () => feed('ev-info').map(li => li.querySelector('.ev-txt').textContent);
    await settle();
    // The ledger names its own amounts' unit, so the first poll is in it whichever read answers first.
    assert.deepEqual(watching(), order === '/info first' ? [] : [LINE], `${order}: before the held read answers`);
    release();
    await settle();
    assert.deepEqual(watching(), [LINE], order);
    assert.deepEqual(feed('ev-loop').map(li => [li.querySelector('.amt').textContent, li.querySelector('.ev-txt').textContent]),
      [['0.002 tERG', 'Loop closed: ann → bob → ann']], `${order}: the newest loop`);
    assert.deepEqual(['st-agents', 'st-out', 'st-clear', 'st-move', 'st-check'].map(id => $(id).textContent), ['3', '0.145493002', '0.002', '0.001', 'all match'], order);
    assert.deepEqual(body.querySelectorAll('.stats .u').map(u => u.textContent), ['tERG', 'tERG', 'tERG'], order);
    assert.equal($('chain').hidden, false, `${order}: the strip`);
    assert.deepEqual($('chain').children.map(e => e.textContent),
      ['On Ergo testnet', 'anchored at height 645,189', '1 reserve backing notes: 0.13625 tERG', 'sandbox-exact 0.13625 tERG'], order);
    assert.equal($('meta').textContent, 'circulating credit: on · Basis tracker v4.4 · valun-testnet-1', order);
    assert.doesNotMatch(body.textContent, /\bPC\b/, `${order}: nothing on the page says PC, the retired pilot's unit`);
  }
});

// ---------- fix inbox #72 ----------
// GET /clearing and GET /loops name each amount by its unit-neutral name (fix inbox #32) beside a deprecated _PC alias
// that a later release removes; the page reads the neutral names. Here the aliases carry other values, so the cards and
// the loop line show which name the page read; and with the aliases gone (as after that release) the page is the same.
test('the page reads the unit-neutral amount names of GET /clearing and GET /loops, not their _PC aliases (fix inbox #72)', async () => {
  const other = {...TESTNET,
    '/pilot/v1/clearing': {unit: 'nanoERG', totals: {cleared: 2_000_000, cleared_PC: 9_000_000, setoffs_applied: 1, transferred: 1_000_000, transferred_PC: 9_000_000, transfers_applied: 1}},
    '/pilot/v1/loops': {...TESTNET['/pilot/v1/loops'], loops: TESTNET['/pilot/v1/loops'].loops.map(l => ({...l, amount_PC: 9_000_000}))}};
  const strip = v => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.endsWith('_PC')).map(([k, x]) => [k, strip(x)])) : v);
  const gone = Object.fromEntries(Object.entries(TESTNET).map(([p, b]) => [p, strip(b)]));
  assert.doesNotMatch(JSON.stringify(gone), /_PC"/);
  for (const [name, routes] of [['aliases with other values', other], ['no aliases', gone]]) {
    const body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads(routes));
    await settle();
    const $ = id => body.all('*').find(e => e.id === id);
    assert.deepEqual(['st-clear', 'st-move'].map(id => $(id).textContent), ['0.002', '0.001'], `${name}: cleared and transferred`);
    assert.deepEqual($('feed').children.filter(li => li.classList.contains('ev-loop')).map(li => li.querySelector('.amt').textContent), ['0.002 tERG'], `${name}: the loop's amount`);
  }
  assert.deepEqual(pub('network.js').match(/\.\w+_PC\b/g), null, 'no _PC name is read');
});

// The graph: an edge's width and a node's size grow with the amount, on a scale sized for the pilot's PC. The testnet's
// nanoERG are PC-sized amounts times 1,000,000, so drawn as they were every testnet edge was 10 wide and every node at its
// largest (a review of fix inbox #72: 156 of valun.tech's 157 edges at 10.0). A transfer's and a set-off's change over
// its edges is in the network's unit too (it said "−1500000" beside "0.0005 tERG").
test('the testnet graph: edge widths and node sizes follow the amounts; the changes a transfer and a set-off draw are in tERG (fix inbox #72)', async () => {
  assert.equal(edgeWidth(3, 'PC').toFixed(1), '5.2', 'the pilot as before');
  assert.equal(edgeWidth(3_000_000, 'nanoERG'), edgeWidth(3, 'PC'), 'a testnet amount as its PC-sized amount');
  assert.deepEqual([1_000_000, 8_000_000, 31_000_000, 10 ** 12].map(a => edgeWidth(a, 'nanoERG').toFixed(1)), ['3.6', '7.1', '10.0', '10.0']);
  assert.equal(nodeRadius(9_000_000, 'nanoERG').toFixed(1), '18.2');
  assert.equal(nodeRadius(9, 'PC').toFixed(1), '18.2');
  assert.equal(nodeRadius(10 ** 12, 'nanoERG'), 23);
  // The page itself: three agents (testnet's reads), a 2-cycle between ann and bob and sandbox-exact's note to ann.
  const T0 = 1_799_999_000_000, T1 = T0 + 30_000;
  const note = (issuer, recipient, amount, ts) => ({...noteRec(issuer, recipient, amount), timestamp: ts});
  const routes = {...TESTNET, '/pilot/v1/ledger': {unit: 'nanoERG', notes: [note(B, C, 3_000_000, T0 + 123), note(C, B, 2_000_000, T0 + 456), note(A, B, 5_000_000, T0 + 789)],
    reconciliation: []}};
  const timers = [], body = readBody(pub('network.html'));
  runNetworkPage(pub('network.js'), body, reads(routes), {setTimeout: (fn, ms) => timers.push({fn, ms})});
  await settle();
  const all = () => body.all('*');
  // The edges in the order the page drew them (the ledger's), and each node's dot by its label.
  const widths = all().filter(e => e.tagName === 'PATH' && e.classList.contains('edge')).map(e => e.getAttribute('stroke-width'));
  assert.deepEqual(widths, ['5.2', '4.5', '6.1'], 'ann → bob 3,000,000, bob → ann 2,000,000, sandbox-exact → ann 5,000,000: each edge by its amount, none at the cap');
  const dot = handle => all().find(e => e.classList.contains('node-in') && e.children.some(c => c.classList.contains('label') && c.textContent === handle))
    ?.children.find(c => c.classList.contains('dot'))?.getAttribute('r');
  assert.deepEqual(['ann', 'bob', 'sandbox-exact'].map(dot), ['18.4', '17.1', '30.0'], 'each node by what it owes and is owed (a sandbox agent fixed)');
  // The next poll: a set-off of 1,500,000 on each edge of the 2-cycle (timestamps ending 998), and a debt transfer of
  // 1,000,000 of sandbox-exact's debt from ann to bob (ending 999).
  routes['/pilot/v1/ledger'] = {unit: 'nanoERG', notes: [note(B, C, 1_500_000, T1 + 998), note(C, B, 500_000, T1 + 998), note(A, B, 4_000_000, T1 + 1999), note(A, C, 1_000_000, T1 + 1999)],
    reconciliation: []};
  const next = timers.filter(t => t.ms === POLL_MS).at(-1);
  assert.ok(next, 'the page set its next poll');
  next.fn();
  await settle();
  const deltas = all().filter(e => e.classList.contains('delta')).map(e => [e.getAttribute('class'), e.textContent]);
  assert.deepEqual(deltas, [['delta d-transfer', '−0.001 tERG'], ['delta d-transfer', '+0.001 tERG'], ['delta d-setoff', '−0.0015 tERG'], ['delta d-setoff', '−0.0015 tERG']]);
  assert.match(all().find(e => e.id === 'feed').textContent, /0\.0015 tERG off each debt/, 'as the feed says it');
});

// Phones: at 390 px the header's "live" pill stuck out by 9 px and the page scrolled sideways. On a narrow screen the
// brand wraps, so the pill goes under the title when the line is too short for both, and a long status is cut short
// rather than widen the page.
test('phones: the header wraps, so the "live" pill never widens the page (fix inbox #72)', () => {
  const css = cssRules(pub('network.css')), m = '(max-width: 900px)';
  const decl = (selector, prop) => css.filter(r => r.selector === selector && r.media === m && prop in r.decls).at(-1)?.decls[prop];
  assert.deepEqual(['flex-wrap', 'max-width'].map(p => decl('.brand', p)), ['wrap', '100%']);
  assert.deepEqual(['margin-left', 'max-width'].map(p => decl('.live', p)), ['0', '100%']);
  assert.deepEqual(['min-width', 'overflow', 'text-overflow'].map(p => decl('#live-text', p)), ['0', 'hidden', 'ellipsis']);
  assert.equal(css.find(r => r.selector === '.live' && r.media === null).decls['white-space'], 'nowrap', 'one line');
  assert.ok(readBody(pub('network.html')).all('*').some(e => e.id === 'live-text' && e.parentNode.id === 'live'), 'the status text is the pill\'s own span');
});

