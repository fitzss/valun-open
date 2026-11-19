// The live network page (/network): its three static routes, the page's CSP compliance (no inline script or style,
// same-origin public reads only), and its change detection (public/network.js) on the tracker-note changes of the
// sandbox tour (agent.py TOUR_GOALS): a new note, a debt transfer, set-offs of a 2-cycle and a 3-cycle, and the same
// steps when one poll sees several of them at once. Then the page as people read it (the site's redesign, 2026-11-17):
// who runs each agent, an honest header counted from the data, a picture of recent activity whose labels never overlap
// and never leave the frame at any width, the same facts as tables, amounts in tERG from the first poll on (fix inbox
// #48), the reads it makes and how often, and what it does for a screen reader, a keyboard and reduced motion
// (test/network-dom.mjs runs the page itself).
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
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site.css', '/network.css'], 'the shared base, then its own');
  assert.deepEqual([...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]), ['https://valun.tech/network', 'https://github.com/fitzss/valun-open', 'https://github.com/fitzss/valun-open'],
    'no external URL but its own canonical URL and the shared navigation\'s and footer\'s GitHub links');
  const reads = [...js.matchAll(/getJson\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(reads)], ['/pilot/v1/chain', '/pilot/v1/clearing', '/pilot/v1/info', '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/participants?all=1', '/pilot/v1/reserves']);
  assert.match(html, /<a class="brand" href="\/" aria-label="Valun home"><svg class="mark" viewBox="0 0 100 100" aria-hidden="true">/, 'the mark and the wordmark');
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(js, /a\.href = `\/loop\/\$\{l\.id\}`/, 'loops link to their loop cards');
  assert.match(js, /a\.href = `\/agent\/\$\{h\}`/, 'agents link to their pages');
  assert.doesNotMatch(js, /authorization|bearer|x-valun|localStorage|innerHTML|eval\(|\.style\b|setAttribute\('style'/i, 'no token, no markup from text, no inline style');
  assert.match(js, /credentials: 'omit'/);
});

// The redesign's live check (2026-11-17): a shared link to /network previewed no card. Its head carries the Open Graph and
// Twitter tags and the canonical link the other public pages carry (as memory.html's), with its own title and description.
test('the head: a canonical link, and Open Graph and Twitter tags with the page\'s own title and description and the site\'s card', () => {
  const html = pub('network.html'), head = html.slice(0, html.indexOf('</head>'));
  const meta = (attr, name) => (new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`).exec(head) || [])[1] ?? null;
  const title = /<title>([^<]+)<\/title>/.exec(head)[1], description = meta('name', 'description');
  assert.equal(title, 'Valun live network');
  assert.match(head, /<link rel="canonical" href="https:\/\/valun\.tech\/network">/);
  assert.deepEqual([meta('property', 'og:type'), meta('property', 'og:site_name'), meta('property', 'og:url')], ['website', 'Valun', 'https://valun.tech/network']);
  for (const [attr, name] of [['property', 'og:title'], ['name', 'twitter:title']]) assert.equal(meta(attr, name), title, name);
  for (const [attr, name] of [['property', 'og:description'], ['name', 'twitter:description']]) assert.equal(meta(attr, name), description, name);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  // The site's card, as every other public page names it (memory.html's tags, word for word).
  const memory = pub('memory.html');
  for (const name of ['og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
    assert.ok(meta('property', name), name);
    assert.ok(memory.includes(`<meta property="${name}" content="${meta('property', name)}">`), `${name}: as on /memory`);
  }
  assert.equal(meta('property', 'og:image'), 'https://valun.tech/og.png');
});

// ---------- change detection ----------
const net = await import(pathToFileURL(path.join(root, 'public', 'network.js')).href);
const {edgesOf, diffEdges, explain, kindOf, matchLoop, POLL_MS, MAX_POLL_MS, moneyText, tergText, chainPanel, edgeWidth} = net;
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

// ---------- who runs each agent ----------
// The page says who runs an agent as the server's pages do (lib/pilot/loops.mjs whoRuns): the operator's practice agents
// (the server's sandbox agents) and house agents (named by this server's configuration: house_agent), never by a handle
// alone; a team test agent is what its operator field declares; everyone else is an "other".
const OPERATORS = ['Basis (Fitz) experimental test agent', 'Basis QA', 'Basis (Fitz) - test agent', 'Fitz (Basis test agent)', 'Fitz (via Basis, surety lab)',
  'Claude onboarding test', 'Fitz', 'Basis lab (MCP SDK client test)', 'Valun operator (testnet end-to-end test)', 'Basis (Fitz\'s QA agent)', 'Robin Owner', 'Pat Friendly',
  'Basis lab (Hermes + gpt-4.1-mini)', 'Valun operator (sandbox agent run by the server, no AI)', 'Valun release check', 'Valun (house agents)', 'Basis (fix check)',
  'Ada Lovelace', 'Claude live check', 'Claude host test (Valun team)', 'Basis verify #87', 'anonymous (frontier lab)', 'Fitz Tester', 'Lab probe', 'Valun lab (first-mile desk, test network)',
  // what an outside agent's owner might type: none names the team
  'Basis protocol team', 'Basis core dev', 'BetterMoneyLabs (Basis)', 'kushti', 'Claude Code user', 'Acme Lab', 'my test agent', 'Valunteer', 'Fitzgerald Labs', '', null];
test('who runs each agent: the server\'s knowledge for the operator\'s own, the operator field\'s declaration for the team, the same rule as the server\'s pages', async () => {
  const loops = await import('../lib/pilot/loops.mjs');
  const team = OPERATORS.filter(op => net.declaresTeam(op));
  for (const op of OPERATORS) assert.equal(net.declaresTeam(op), loops.declaresTeam(op), String(op));
  assert.deepEqual(OPERATORS.filter(op => !net.declaresTeam(op)), ['Robin Owner', 'Pat Friendly', 'Ada Lovelace', 'anonymous (frontier lab)', 'Lab probe',
    'Basis protocol team', 'Basis core dev', 'BetterMoneyLabs (Basis)', 'kushti', 'Claude Code user', 'Acme Lab', 'my test agent', 'Valunteer', 'Fitzgerald Labs', '', null]);
  assert.equal(team.length, 20);
  const records = [[{handle: 'sandbox-exact', operator_run: true}, 'practice'], [{handle: 'sandbox-mallory'}, 'practice'],
    [{handle: 'house-scribe', operator: 'Valun (house agents)', sandbox_only: true, house_agent: true}, 'house'],
    [{handle: 'house-scribe', operator: 'Mallet', sandbox_only: true}, 'other'],      // the handle alone, on another network: nothing
    [{handle: 'stats', operator_run: true, operator: 'x'}, 'operator'], [{handle: 'basis-x-1', operator: 'Basis QA'}, 'team'], [{handle: 'kushti', operator: 'kushti'}, 'other']];
  for (const [p, who] of records) {
    assert.equal(net.whoRuns(p), who, p.handle);
    assert.equal(loops.whoRuns(p), who, `${p.handle}: the server's pages say the same`);
  }
  assert.deepEqual(net.classCounts([...records.map(([p], i) => ({...p, id: `vp_${i}`})), {id: 'key:02', placeholder: true}, null]), {all: 7, operator: 4, team: 1, other: 2});
  // How a participant joined is kept (kindOf), but the page no longer shows it as who runs it.
  assert.equal(kindOf({handle: 'sandbox-exact', operator_run: true}), 'agent');
  assert.equal(kindOf({handle: 'demo1', sandbox_only: true}), 'sandbox');
  assert.equal(kindOf({handle: 'bea'}), 'invited');
  // Polling: every 30 s, never faster; up to 5 minutes after errors.
  assert.equal(POLL_MS, 30_000); assert.equal(MAX_POLL_MS, 300_000);
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

// The testnet network (valun-testnet-1): its amounts as people read them, in tERG (a total rounded to 3 decimals; the
// exact figure is in the JSON), and the "On Ergo testnet" facts from GET /chain and GET /reserves, with hex ids, only
// the explorer's links, today's tracker boxes, and what each reserve backs now (its own issuer's debt, at most).
test('the testnet: amounts in tERG, and the Ergo testnet facts from /chain and /reserves (ids and links checked, what reserves back)', () => {
  assert.equal(moneyText(3, 'PC'), '3 PC');
  assert.equal(moneyText(3000000, 'nanoERG'), '0.003 tERG');
  assert.equal(moneyText(1500000000, 'nanoERG'), '1.5 tERG');
  assert.equal(tergText(194000000), '0.194');
  assert.equal(tergText(-2000000), '-0.002');
  assert.deepEqual([3_000_000, 250_000, 443_616_002, -1_000_000, 0].map(n => net.terg(n)), ['0.003 tERG', '0.00025 tERG', '0.443616 tERG', '−0.001 tERG', '0 tERG']);
  assert.deepEqual([373_823_000, 443_616_002, 1_000_000_000].map(n => net.terg(n, {total: true})), ['0.374 tERG', '0.444 tERG', '1 tERG']);
  assert.equal(net.terg(3, {unit: 'PC'}), '3 PC');
  const nft = 'dc'.repeat(32);
  const chain = {on_chain: true, tracker_nft_id: nft, anchoring: {anchored: true, confirmed_height: 640110, confirmed_box_id: 'e8'.repeat(32), pending_tx_id: null,
    daily_cap: {limit: 50, signed_today: 50, resets_at: '2026-11-18T00:00:00.000Z'}},
    links: {tracker_nft: `https://testnet.ergoplatform.com/en/token/${nft}`, tracker_address: 'https://evil.example/x"onclick'}};
  const c = chainPanel(chain, {reserves: [{box_id: '04'.repeat(32), handle: 'sandbox-exact', collateral_nanoerg: 132_250_000, total_debt_nanoerg: 112_250_000},
    {box_id: '05'.repeat(32), handle: 'house-scribe', collateral_nanoerg: 50_000_000, total_debt_nanoerg: 0}, {box_id: 'not hex', handle: 'x', collateral_nanoerg: 5}]});
  assert.deepEqual(c, {anchored: true, height: 640110, pending: false, cap: {limit: 50, today: 50, used_up: true},
    links: {nft: `https://testnet.ergoplatform.com/en/token/${nft}`, address: null},
    reserves: [{handle: 'sandbox-exact', nanoerg: 132_250_000, backs: 112_250_000}, {handle: 'house-scribe', nanoerg: 50_000_000, backs: 0}]});
  assert.equal(chainPanel({on_chain: false}, null), null, 'nothing before the bootstrap');
  assert.equal(chainPanel(null, null), null);
});

// ---------- the page itself ----------
// The testnet's public reads (trimmed from valun.tech's): GET /info names the unit, nanoERG, and so does GET /ledger,
// beside its notes. Four agents: a practice agent the server runs, a house agent the operator runs (house_agent), a team
// test agent (its operator field says so) and one whose operator field names no one on the team.
const A = 'vp_00000000000a', B = 'vp_00000000000b', C = 'vp_00000000000c', D = 'vp_00000000000d';
const agentRec = (id, handle, extra) => ({id, handle, status: 'active', joined_at: '2026-11-01T10:00:00.000Z', ...extra});
const noteRec = (issuer, recipient, outstanding, timestamp = 1_799_999_000_123) => ({issuer, recipient, issuer_handle: null, recipient_handle: null,
  issuer_pubkey: `02${issuer.slice(-1).repeat(64)}`, recipient_pubkey: `02${recipient.slice(-1).repeat(64)}`, total: outstanding, redeemed: 0, outstanding, timestamp,
  confirmation: 'local_only', unit: 'nanoERG'});
const TESTNET = {
  '/pilot/v1/info': {network: 'valun-testnet-1', protocol: 'valun-deal/1', unit: 'nanoERG', denomination: 'erg', tracker_on_chain: true,
    features: ['bound_notes/1', 'circulation/1', 'guarantees/1'], novation: {transfer_ms: 999, setoff_ms: 998}},
  '/pilot/v1/participants?all=1': [agentRec(A, 'sandbox-exact', {operator_run: true, operator: 'Valun operator (sandbox agent run by the server, no AI)'}),
    agentRec(B, 'ann', {sandbox_only: true, sandbox_expires_at: '2099-01-01T00:00:00.000Z', operator: 'Basis QA'}), agentRec(C, 'bob', {operator: 'Bob'}),
    agentRec(D, 'house-scribe', {sandbox_only: true, operator: 'Valun (house agents)', house_agent: true})],
  '/pilot/v1/ledger': {unit: 'nanoERG', notes: [noteRec(A, B, 145_000_000, 1_799_999_000_997), noteRec(B, C, 493_002, 1_799_999_100_998), noteRec(C, D, 2_000_000, 1_799_999_200_997)],
    reconciliation: [{issuer: A, recipient: B, status: 'match'}, {issuer: B, recipient: C, status: 'match'}, {issuer: C, recipient: D, status: 'match'}]},
  '/pilot/v1/clearing': {unit: 'nanoERG', totals: {cleared: 2_000_000, cleared_PC: 2_000_000, setoffs_applied: 1, transferred: 1_000_000,
    transferred_PC: 1_000_000, transfers_applied: 1}},
  '/pilot/v1/loops': {unit: 'nanoERG', network: 'valun-testnet-1', loops: [{id: 'vs_00000000000000aa', applied_at: '2026-11-14T10:55:16.165Z',
    amount: 2_000_000, amount_PC: 2_000_000, each: 1_000_000, each_PC: 1_000_000, members: [{handle: 'ann'}, {handle: 'bob'}],
    on_chain: {anchored: true, tx_id: '11'.repeat(32)}}]},
  '/pilot/v1/chain': {network: 'valun-testnet-1', on_chain: true, anchoring: {anchored: true, confirmed_height: 645_189, pending_tx_id: null,
    daily_cap: {limit: 50, signed_today: 4, resets_at: '2026-11-18T00:00:00.000Z'}}, links: {}},
  '/pilot/v1/reserves': {network: 'valun-testnet-1', unit: 'nanoERG', reserves: [{box_id: '04'.repeat(32), handle: 'sandbox-exact', collateral_nanoerg: 136_250_000, total_debt_nanoerg: 145_000_000}]},
};
// The page's reads answered from `routes`; a read named in `held` first waits for its promise. `log` records each path.
const reads = (routes, held = {}, log = []) => async p => {
  log.push(p);
  await held[p];
  const body = routes[p];
  return body === undefined ? {ok: false, status: 404, json: async () => ({error: 'not_found'})} : {ok: true, status: 200, json: async () => structuredClone(body)};
};
const byId = body => id => body.all('*').find(e => e.id === id);

test('the page on the testnet\'s reads: who is here by who runs them, the totals and the chain in tERG, the latest changes and the loops, from the first poll (fix inbox #48)', async () => {
  for (const order of ['/info after the first poll', '/info first']) {
    let release;
    const gate = new Promise(r => { release = r; }), body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads(TESTNET, order === '/info first' ? {'/pilot/v1/ledger': gate} : {'/pilot/v1/info': gate}));
    const $ = byId(body);
    await settle();
    release();
    await settle();
    // The honest header: counted from GET /participants?all=1.
    assert.deepEqual(['n-all', 'n-operator', 'n-team', 'n-other'].map(id => $(id).textContent), ['4', '2', '1', '1'], order);
    // The whole network: amounts as people read them, in tERG (rounded totals), whichever read answered first.
    assert.deepEqual(['t-out', 't-out-sub', 't-clear', 't-clear-sub', 't-move', 't-move-sub', 't-check', 't-check-sub'].map(id => $(id).textContent),
      ['0.147 tERG', '3 notes between 4 agents', '0.002 tERG', 'in 1 loop', '0.001 tERG', 'in 1 transfer', '3 of 3 match', 'pairs: the server\'s records agree with its tracker'], order);
    // On Ergo testnet: anchored, today's boxes, what the reserves hold and back (its issuer owes 0.145; it holds 0.136).
    assert.equal($('chain').hidden, false, order);
    assert.deepEqual($('chain-list').children.map(li => li.textContent), ['Anchored: the tracker box on chain commits the ledger as of block 645,189.',
      'Today: 4 of 50 tracker boxes. The cap resets at 00:00 UTC.',
      '1 reserve holds 0.136 tERG. One backs notes owed now: 0.136 tERG of the 0.147 tERG owed. A note can be redeemed only against a reserve locked under the key that signed it.'], order);
    // The latest changes, newest first: who owes whom, what changed (by the timestamp's code), what is owed now.
    const rows = $('changes-body').children.map(tr => [...tr.querySelectorAll('.h').map(h => h.textContent), tr.querySelector('.arr').textContent.trim(),
      tr.querySelector('td.what').textContent, tr.querySelector('td.num').textContent]);
    assert.deepEqual(rows, [['bob', 'house-scribe', 'owes', 'new note for a job', '0.002 tERG'], ['ann', 'bob', 'owes', 'cut by a loop', '0.000493 tERG'],
      ['sandbox-exact', 'ann', 'owes', 'new note for a job', '0.145 tERG']], order);
    // The loops cleared: the route with who runs each member, what each debt fell by, committed, the card.
    const loop = $('loops').children[0];
    assert.equal(loop.querySelector('.loop-route').textContent, 'ann → bob → ann', order);
    assert.match(loop.querySelector('.loop-meta').textContent, /^−0\.001 tERG each · \d+ days ago · committed$/, order);
    assert.equal(loop.querySelector('.loop-who').textContent, '1 team test agent, 1 other agentLoop card', order);
    assert.equal(loop.querySelector('a').href, '/loop/vs_00000000000000aa');
    assert.doesNotMatch(body.textContent, /\bPC\b|\d{1,3}(,\d{3})+ (?:credits|tERG)/, `${order}: no PC, the retired pilot's unit, and no nanoERG count named tERG`);
  }
});

// Not anchored yet: how long a box takes, in the words every live panel uses (the redesign, round 2), never "a few
// minutes".
test('not anchored yet: the wait in the site\'s one wording, usually 5 to 15 minutes, up to about 30 while Ergo testnet blocks are slow', async () => {
  const waiting = {...TESTNET, '/pilot/v1/chain': {...TESTNET['/pilot/v1/chain'], anchoring: {anchored: false, confirmed_height: 645_189, pending_tx_id: null,
    daily_cap: {limit: 50, signed_today: 4, resets_at: '2026-11-18T00:00:00.000Z'}}}};
  const body = readBody(pub('network.html'));
  runNetworkPage(pub('network.js'), body, reads(waiting));
  await settle();
  assert.equal(byId(body)('chain-list').children[0].textContent,
    'Not anchored yet: the next tracker box commits the latest changes, usually within 5 to 15 minutes; up to about 30 when Ergo testnet blocks are slow (as since Nov 16).');
  assert.doesNotMatch(pub('network.js'), /few minutes|two minutes/);
});

test('the latest changes say what each change was, by its timestamp\'s code, newest first; who owes whom with a shape for who runs each', async () => {
  const edges = net.edgesOf(TESTNET['/pilot/v1/ledger'].notes);
  assert.deepEqual(net.latestChanges(edges).map(c => [c.from, c.to, c.kind, c.owed]), [[C, D, 'note', 2_000_000], [B, C, 'setoff', 493_002], [A, B, 'note', 145_000_000]]);
  assert.deepEqual(net.latestChanges(edges, undefined, 1).length, 1);
  const body = readBody(pub('network.html'));
  runNetworkPage(pub('network.js'), body, reads(TESTNET));
  await settle();
  const first = byId(body)('changes-body').children[0];
  assert.deepEqual(first.querySelectorAll('.shape').map(s => s.className), ['shape w-other', 'shape w-operator'], 'bob (other) owes house-scribe (operator-run)');
  assert.deepEqual(first.querySelectorAll('a').map(a => a.href), ['/agent/bob', '/agent/house-scribe']);
  assert.equal(first.querySelector('time').getAttribute('datetime'), new Date(1_799_999_200_997).toISOString());
});

// GET /clearing and GET /loops name each amount by its unit-neutral name (fix inbox #32) beside a deprecated _PC alias
// that a later release removes; the page reads the neutral names. Here the aliases carry other values, so the totals and
// the loops show which name the page read; and with the aliases gone (as after that release) the page is the same.
test('the page reads the unit-neutral amount names of GET /clearing and GET /loops, not their _PC aliases (fix inbox #72)', async () => {
  const other = {...TESTNET,
    '/pilot/v1/clearing': {unit: 'nanoERG', totals: {cleared: 2_000_000, cleared_PC: 9_000_000, setoffs_applied: 1, transferred: 1_000_000, transferred_PC: 9_000_000, transfers_applied: 1}},
    '/pilot/v1/loops': {...TESTNET['/pilot/v1/loops'], loops: TESTNET['/pilot/v1/loops'].loops.map(l => ({...l, amount_PC: 9_000_000, each_PC: 9_000_000}))}};
  const strip = v => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.endsWith('_PC')).map(([k, x]) => [k, strip(x)])) : v);
  const gone = Object.fromEntries(Object.entries(TESTNET).map(([p, b]) => [p, strip(b)]));
  assert.doesNotMatch(JSON.stringify(gone), /_PC"/);
  for (const [name, routes] of [['aliases with other values', other], ['no aliases', gone]]) {
    const body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads(routes));
    await settle();
    const $ = byId(body);
    assert.deepEqual(['t-clear', 't-move'].map(id => $(id).textContent), ['0.002 tERG', '0.001 tERG'], `${name}: cleared and transferred`);
    assert.match($('loops').children[0].querySelector('.loop-meta').textContent, /^−0\.001 tERG each/, `${name}: the loop's each`);
  }
  assert.deepEqual(pub('network.js').match(/\.\w+_PC\b/g), null, 'no _PC name is read');
});

// ---------- the picture ----------
// 376 agents as on the testnet (Nov 17): the operator's four, 346 team test agents, 26 others; 240 IOUs, the latest
// changes among a few dozen of them. At every width from a phone to a projector the picture names the operator's agents
// and those in the latest changes, every label stays inside the frame and overlaps no other, and the rest are counted.
function world() {
  const people = new Map(), notes = [];
  const add = (id, handle, who) => people.set(id, {id, handle, who});
  add('vp_ex', 'sandbox-exact', 'practice'); add('vp_ma', 'sandbox-mallory', 'practice'); add('vp_hs', 'house-scribe', 'house'); add('vp_hr', 'house-reviewer', 'house');
  for (let i = 0; i < 346; i++) add(`vp_t${i}`, i % 3 ? `basis-lab-mc-line-${1000 + i}` : `basis-x-v${i}c`, 'team');
  for (let i = 0; i < 26; i++) add(`vp_o${i}`, `persona-${i}-${'x'.repeat(i % 12)}`, 'other');
  let t = 1_800_000_000_000;
  for (let i = 0; i < 240; i++) {
    const a = `vp_t${(i * 7) % 346}`, b = i % 4 ? `vp_t${(i * 13 + 5) % 346}` : ['vp_ex', 'vp_ma', 'vp_hs', 'vp_hr'][i % 4 === 0 ? (i / 4) % 4 : 0];
    if (a !== b) notes.push({issuer: a, recipient: b, issuer_pubkey: a, recipient_pubkey: b, outstanding: (1 + (i % 9)) * 250_000, timestamp: (t += 7000) - (t % 1000) + [997, 998, 999][i % 3]});
  }
  return {people, edges: net.edgesOf(notes)};
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
test('the picture at every width: the operator\'s agents and the latest changes named, no label overlapping another or leaving the frame, the rest counted', () => {
  const {people, edges} = world();
  const changes = net.latestChanges(edges, undefined, 400);
  for (const [W, H] of [[288, 380], [358, 437], [600, 420], [734, 589], [896, 600], [1400, 600]]) {
    const font = W < 520 ? 11 : 12, max = Math.min(W < 520 ? 12 : W < 760 ? 18 : 24, net.ringCapacity(H, font));
    const view = net.pickView(people, changes, [], max);
    assert.deepEqual(view.core.map(id => people.get(id).handle), ['house-reviewer', 'house-scribe', 'sandbox-exact', 'sandbox-mallory'], `${W}: the operator's four, always`);
    assert.equal(view.ring.length, max, `${W}: as many as the frame names`);
    assert.equal(view.ring.length + view.core.length + view.hidden.team + view.hidden.other + view.hidden.operator, 376, `${W}: everyone drawn or counted`);
    const L = net.layoutView(view, people, edges, {W, H, font});
    for (const n of L.nodes) {
      assert.ok(n.x >= 0 && n.x <= W && n.y >= 0 && n.y <= H, `${W}: ${n.id} inside the frame`);
      assert.ok(n.box.x0 >= 0 && n.box.x1 <= W && n.box.y0 >= 0 && n.box.y1 <= H, `${W}: ${n.id}'s label inside the frame (${JSON.stringify(n.box)})`);
      for (const m of L.nodes) if (m !== n) {
        assert.ok(!overlap(n.box, m.box), `${W}: ${n.id}'s label and ${m.id}'s overlap`);
        assert.ok(!(m.x > n.box.x0 && m.x < n.box.x1 && m.y > n.box.y0 && m.y < n.box.y1), `${W}: ${n.id}'s label covers ${m.id}`);
      }
      const shown = n.lines.map(l => l.text).join('');
      assert.ok(shown === people.get(n.id).handle || shown.endsWith('…') || n.core, `${W}: a label is the handle, or cut with an ellipsis`);
    }
  }
  // The selection: the newest loop's members first, then the latest changes, newest first.
  const loops = [{members: [{handle: 'persona-3-xxx'}, {handle: 'basis-x-v0c'}]}];
  const v = net.pickView(people, changes, loops, 4);
  assert.deepEqual(v.ring.slice(0, 2).map(id => people.get(id).handle), ['persona-3-xxx', 'basis-x-v0c']);
  assert.equal(v.since, changes.find(c => [c.from, c.to].includes(v.ring.at(-1))).ts);
  assert.deepEqual([1_000_000, 3_000_000, 15_000_000, 10 ** 12].map(a => edgeWidth(a).toFixed(2)), ['1.40', '1.80', '2.60', '2.60'], 'thin lines, a little wider for more');
});

// The picture's window, as the subtitle says it. At 14:54 UTC on Nov 17 the live page said "since 20:10 UTC", which read
// as later that day: it was the day before's (the redesign's live check). On another UTC day it names the date.
test('the picture\'s "since": the time alone on the reader\'s UTC day, with the date on any other; the subtitle under the picture says it', async () => {
  const at = Date.parse('2026-11-16T20:10:30.998Z');
  assert.equal(net.sinceText(at, Date.parse('2026-11-16T23:59:59Z')), '20:10 UTC', 'the same UTC day');
  assert.equal(net.sinceText(at, Date.parse('2026-11-17T14:54:00Z')), 'Nov 16, 20:10 UTC', 'an earlier UTC day');
  assert.equal(net.sinceText(Date.parse('2026-11-01T09:05:00Z'), Date.parse('2026-11-17T14:54:00Z')), 'Nov 1, 09:05 UTC');
  assert.equal(net.sinceText(Date.parse('2025-12-31T23:50:00Z'), Date.parse('2026-01-01T00:05:00Z')), 'Dec 31, 2025, 23:50 UTC', 'another year');
  assert.equal(net.sinceText(NaN, Date.now()), '');
  // On the page, at a fixed clock (the testnet's reads without the loops: the latest changes put bob and ann in the
  // picture, the older from 07:45 UTC on Jan 15, 2027).
  const at0745 = '2027-01-15T07:45:00.998Z';
  assert.equal(new Date(1_799_999_100_998).toISOString(), at0745);
  const sub = async clock => {
    const fixed = class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
    const body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads({...TESTNET, '/pilot/v1/loops': {...TESTNET['/pilot/v1/loops'], loops: []}}), {globals: {Date: fixed}});
    await settle();
    return byId(body)('map-sub').textContent;
  };
  assert.equal(await sub(Date.parse('2027-01-15T12:00:00Z')), 'The 2 agents in the latest changes to the ledger (since 07:45 UTC), and the 2 the operator runs. Read from GET /pilot/v1/ledger.');
  assert.equal(await sub(Date.parse('2027-01-16T09:00:00Z')), 'The 2 agents in the latest changes to the ledger (since Jan 15, 07:45 UTC), and the 2 the operator runs. Read from GET /pilot/v1/ledger.');
});

test('the picture on the page: links to each agent\'s page with who runs it and what it owes; one tab stop and the arrow keys; the newest loop in the rainbow', async () => {
  const body = readBody(pub('network.html'));
  const doc = runNetworkPage(pub('network.js'), body, reads(TESTNET));
  await settle();
  const svg = byId(body)('graph'), nodes = svg.querySelectorAll('a.node');
  assert.deepEqual(nodes.map(n => n.getAttribute('href')).sort(), ['/agent/ann', '/agent/bob', '/agent/house-scribe', '/agent/sandbox-exact']);
  assert.deepEqual(nodes.filter(n => n.getAttribute('tabindex') === '0').length, 1, 'one tab stop for the picture');
  const label = h => nodes.find(n => n.getAttribute('href') === `/agent/${h}`).getAttribute('aria-label');
  assert.equal(label('house-scribe'), 'house-scribe, operator-run house agent: owes nothing; is owed 0.002 tERG by 1 agent');
  assert.equal(label('ann'), 'ann, team test agent, by its operator field: owes 0.000493 tERG to 1 agent; is owed 0.145 tERG by 1 agent');
  assert.equal(svg.querySelectorAll('path.edge').length, 3, 'every note between the agents drawn');
  assert.equal(svg.querySelectorAll('g.loop.newest path.loop-arc').length, 2, 'the newest loop (ann and bob): an arc for each of its two notes');
  assert.equal(svg.querySelectorAll('g.loop').length, 1, 'only the newest loop is drawn: the others are in "Loops cleared"');
  // The picture is one tab stop through its first agent, never the <svg> itself (Chrome gave it a stop of its own).
  assert.equal(svg.getAttribute('tabindex'), '-1');
  for (const t of svg.querySelectorAll('text')) assert.equal(t.getAttribute('aria-hidden'), 'true', 'the labels are the links\' names, not read twice');
  // The arrow keys move the one tab stop from agent to agent.
  globalThis.document = doc;
  try {
    const first = nodes.find(n => n.getAttribute('tabindex') === '0');
    first.focus();
    svg.dispatch('keydown', {key: 'ArrowDown'});
    const now = svg.querySelectorAll('a.node');
    const focused = now.find(n => n === doc.activeElement);
    assert.ok(focused && focused !== first, 'the next agent has the focus');
    assert.equal(focused.getAttribute('tabindex'), '0');
    assert.equal(now.filter(n => n.getAttribute('tabindex') === '0').length, 1);
  } finally { delete globalThis.document; }
});

// A change between two polls is marked on its edge for a minute: drawn brighter, and flashed once unless the visitor
// asked for reduced motion (then nothing moves).
test('a change between polls marks its edge; reduced motion: marked, never animated', async () => {
  for (const reduce of [false, true]) {
    const routes = structuredClone(TESTNET), timers = [], body = readBody(pub('network.html'));
    runNetworkPage(pub('network.js'), body, reads(routes), {setTimeout: (fn, ms) => timers.push({fn, ms}),
      globals: {matchMedia: q => ({matches: reduce && /prefers-reduced-motion: reduce/.test(q)})}});
    await settle();
    routes['/pilot/v1/ledger'].notes[2] = noteRec(C, D, 3_000_000, 1_799_999_300_997);   // bob pays house-scribe again
    const next = timers.filter(t => t.ms === POLL_MS).at(-1);
    assert.ok(next, 'the page set its next poll, 30 s on');
    next.fn();
    await settle();
    const hot = byId(body)('graph').querySelectorAll('path.edge').filter(p => p.classList.contains('hot'));
    assert.equal(hot.length, 1, `reduce ${reduce}: the edge that changed`);
    assert.equal(hot[0].classList.contains('flash'), !reduce, `reduce ${reduce}: flashed only when motion is welcome`);
  }
  // The stylesheet moves nothing forever, and site.css (loaded first) stops every animation under reduced motion.
  assert.doesNotMatch(pub('network.css'), /infinite/);
  const reduced = cssRules(pub('site.css')).find(r => r.media === '(prefers-reduced-motion: reduce)' && r.selector === '*');
  assert.deepEqual([reduced?.decls.animation, reduced?.decls.transition], ['none !important', 'none !important']);
});

// ---------- what a screen reader hears, and the controls ----------
test('the status line is not a live region; only a new loop is announced, at most once a minute; Pause stops the reads, Resume starts them', async () => {
  const html = pub('network.html'), body = readBody(html);
  assert.deepEqual([...html.matchAll(/aria-live="(\w+)"/g)].map(m => m[1]), ['polite'], 'one live region');
  assert.match(html, /<p class="sr-only" id="announce" role="status" aria-live="polite"><\/p>/);
  // The home's pattern: the label says what the button does next, and no aria-pressed (with a changing label it would be
  // announced as a double state).
  assert.match(html, /<button type="button" class="btn pause" id="pause" hidden>Pause updates<\/button>/, 'shown by the script that it controls');
  assert.doesNotMatch(html + pub('network.js') + pub('network.css'), /aria-pressed["'=]/);
  const routes = structuredClone(TESTNET), timers = [], log = [];
  runNetworkPage(pub('network.js'), body, reads(routes, {}, log), {setTimeout: (fn, ms) => timers.push({fn, ms})});
  await settle();
  const $ = byId(body);
  assert.equal($('announce').textContent, '', 'nothing said on load');
  assert.match($('state-text').textContent, /^Live · valun-testnet-1 · read \d\d:\d\d UTC · every 30 s$/);
  assert.equal($('pause').hidden, false);
  // A loop clears: said once; another within the minute: not said.
  const loop = (id, members) => ({id, applied_at: new Date().toISOString(), amount: 4_000_000, each: 2_000_000, members: members.map(handle => ({handle}))});
  routes['/pilot/v1/loops'].loops.unshift(loop('vs_00000000000000bb', ['sandbox-exact', 'ann']));
  routes['/pilot/v1/clearing'].totals.setoffs_applied = 2;
  timers.filter(t => t.ms === POLL_MS).at(-1).fn();
  await settle();
  assert.equal($('announce').textContent, 'A loop cleared: sandbox-exact to ann to sandbox-exact, 0.002 tERG off each note.');
  routes['/pilot/v1/loops'].loops.unshift(loop('vs_00000000000000cc', ['bob', 'ann']));
  routes['/pilot/v1/clearing'].totals.setoffs_applied = 3;
  timers.filter(t => t.ms === POLL_MS).at(-1).fn();
  await settle();
  assert.match($('announce').textContent, /sandbox-exact to ann/, 'the second loop within a minute is not announced');
  // Pause: no read until Resume.
  const pause = $('pause');
  assert.equal($('graph-live').hidden, false, 'the picture says Live while the reads are live');
  pause.click();
  assert.equal(pause.getAttribute('aria-pressed'), null);
  assert.equal(pause.textContent, 'Resume updates');
  assert.match($('state-text').textContent, /^Paused · valun-testnet-1 · last read \d\d:\d\d UTC$/);
  assert.equal($('graph-live').hidden, true, 'paused: not Live');
  const n = log.length;
  timers.filter(t => t.ms === POLL_MS).at(-1).fn();
  await settle();
  assert.equal(log.length, n, 'paused: nothing read');
  pause.click();
  await settle();
  assert.equal(pause.textContent, 'Pause updates');
  assert.ok(log.length > n, 'resumed: read again');
  assert.equal($('graph-live').hidden, false);
});

// Before any read succeeds the page claims nothing: no Live tag, and once a read fails the tables say so instead of
// "Reading the ledger…" for ever.
test('while nothing can be read: no Live tag, and the tables and the loops say the ledger can\'t be read and when the page tries again', async () => {
  const html = pub('network.html'), body = readBody(html), $ = byId(body);
  assert.match(html, /<span class="tag live" id="graph-live" hidden>Live<\/span>/, 'hidden until a read succeeds');
  assert.equal($('graph-live').hidden, true);
  runNetworkPage(pub('network.js'), body, reads({}), {setTimeout: () => {}});
  await settle();
  assert.equal($('graph-live').hidden, true);
  assert.match($('state-text').textContent, /^Can't reach the server · trying again in 60 s$/);
  assert.equal($('changes-body').textContent, 'The ledger can\'t be read right now; this page tries again in 60 s.');
  assert.equal($('loops').textContent, 'The ledger can\'t be read right now; this page tries again in 60 s.');
});

// ---------- the page's structure ----------
// The page scrolls, with the shared navigation and footer (it was one screen for a projector, whose parts fix inbox #47
// had to keep from collapsing; nothing is sized by the screen now).
test('the page: the shared navigation (Network current), one h1, a heading for each section, the shared footer; it scrolls', () => {
  const body = readBody(pub('network.html'));
  assert.deepEqual(body.children.map(e => `${e.tagName.toLowerCase()}${e.className ? `.${e.className}` : ''}`), ['a.skip', 'header.top', 'main', 'footer.foot']);
  assert.equal(body.children[0].getAttribute('href'), '#main');
  const nav = body.querySelector('nav');
  assert.equal(nav.getAttribute('aria-label'), 'Main');
  assert.deepEqual(nav.querySelectorAll('a').map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    [['Start', '/start', null], ['Network', '/network', 'page'], ['Trust', '/trust', null], ['Memory', '/memory', null], ['GitHub', 'https://github.com/fitzss/valun-open', null]]);
  assert.deepEqual(body.querySelector('footer').querySelectorAll('a').map(a => a.getAttribute('href')), ['/trust', '/start#report', '/skill.md', '/llms.txt', 'https://github.com/fitzss/valun-open']);
  assert.match(body.querySelector('footer p').textContent, /^Ergo testnet · test coins only, with no monetary value$/);
  assert.equal(body.querySelectorAll('h1').length, 1);
  for (const s of body.querySelector('main').all('section')) {
    const h = s.children.find(c => /^H[1-3]$/.test(c.tagName)) ?? s.children[0]?.children.find(c => /^H[1-3]$/.test(c.tagName));
    assert.ok(h, `section.${s.className} has its own heading`);
    assert.equal(s.getAttribute('aria-labelledby'), h.id, `section.${s.className} is labelled by its heading`);
  }
  const css = cssRules(pub('network.css'));
  assert.deepEqual(css.filter(r => /(^|\s)(html|body)$/.test(r.selector)), [], 'the page leaves the body to site.css: no one-screen frame');
  // The honest header: test and practice agents, not adoption; Basis is the QA bot; an operator field is a declaration.
  const caption = body.querySelector('.who .caption').textContent;
  for (const s of ['So far almost all of these are our own test and practice agents: they show the mechanics working, not adoption.',
    'Basis is our QA bot, not the Basis protocol team.', 'An operator field is whatever an agent\'s owner typed when it joined; only the operator-run agents are known to the server.'])
    assert.ok(caption.includes(s), s);
  // Both tables have a name; the picture's caption and hint say what is drawn and what a tap does.
  const html = pub('network.html');
  assert.match(html, /<table class="plain" id="changes" aria-labelledby="changes-h">/);
  assert.match(html, /<table class="plain" aria-label="Every open note">/);
  assert.ok(body.querySelector('#graph-cap').textContent.includes('The newest loop that cleared is drawn as a rainbow arc.'));
  const hint = 'Hover over an agent, or tab to the picture and use the arrow keys, to see what it owes and is owed; tap one to open its page.';
  assert.equal(body.querySelector('#detail').textContent, hint);
  assert.ok(pub('network.js').includes(`const HINT = '${hint}'`), 'the script says the same');
  // An IOU is a debt: a new one means the buyer now owes the seller, not that the job is paid.
  assert.ok(body.querySelector('.changes .small').textContent.includes('A new note: the buyer now owes the seller for a job;'));
  assert.doesNotMatch(html, /pays for a job/);
});

// Accessibility of the page's own styles: labels at 12 px at least (site.css's floor), and the picture under forced
// colours (Windows High Contrast recolours HTML but not SVG fill and stroke): labels and strokes in the system colours,
// a filled circle that stays filled, the rainbow swatch and the Live dot kept.
test('the page\'s styles: no label under 12 px; forced colours draw the picture in the system colours', () => {
  const css = cssRules(pub('network.css'));
  for (const r of css) for (const [k, v] of Object.entries(r.decls)) {
    const rem = k === 'font' || k === 'font-size' ? /(?:^|\s)(\d*\.?\d+)rem\b/.exec(v) : null;
    if (rem) assert.ok(Number(rem[1]) >= 0.75, `${r.selector} ${k}: ${v}`);
  }
  const forced = sel => css.find(r => r.media === '(forced-colors: active)' && r.selector.split(/,\s*/).includes(sel))?.decls ?? {};
  assert.deepEqual([forced('#graph .label').fill, forced('#graph .label').stroke], ['CanvasText', 'Canvas']);
  assert.deepEqual([forced('.shape.w-other')['forced-color-adjust'], forced('.shape.w-other').background], ['none', 'CanvasText']);
  for (const sel of ['.key-loop', '.tag.live::before']) assert.equal(forced(sel)['forced-color-adjust'], 'none', sel);
  assert.equal(forced('#graph .edge').stroke, 'CanvasText');
});

// Phones: the census stacks, the latest changes keep two columns (the time and the change go under the pair), fewer rows
// and loops are shown, and nothing is wider than the page.
test('phones: the census stacks; the latest changes keep two columns; fewer rows and loops', () => {
  const css = cssRules(pub('network.css'));
  const decl = (selector, prop, media) => css.filter(r => r.selector === selector && r.media === media && prop in r.decls).at(-1)?.decls[prop];
  assert.equal(decl('.classes', 'grid-template-columns', '(max-width: 760px)'), 'minmax(0, 1fr)');
  assert.equal(decl('#changes .when', 'display', '(max-width: 640px)'), 'none');
  assert.equal(decl('#changes .what', 'display', '(max-width: 640px)'), 'none');
  assert.equal(decl('#changes .meta-sm', 'display', '(max-width: 640px)'), 'block');
  assert.equal(decl('.meta-sm', 'display', null), 'none');
  assert.equal(decl('#changes-body tr:nth-child(n + 11)', 'display', '(max-width: 640px)'), 'none');
  assert.equal(decl('.loops li:nth-child(n + 4)', 'display', '(max-width: 999px)'), 'none');
  for (const r of css) for (const [k, v] of Object.entries(r.decls)) if (/^(min-)?width$/.test(k)) assert.ok(!/^\d{3,}px$/.test(v) || parseInt(v, 10) <= 320, `${r.selector} ${k}: ${v}`);
});

// The join line (outside-tester review, 2026-11-15): the whole command, pinned and runnable as it is (the handle, the
// operator and the owner token file given, so nothing prompts and no token is shown), and redemption only against the
// issuer's reserve.
// The owner token file is named per handle (the redesign, round 2): valun 0.7.1 prints the token instead when the file
// already exists, as after the tour's join.
test('the join line is the whole command, pinned and runnable as it is; the page says redemption needs the issuer\'s reserve', async () => {
  const JOIN = 'uvx --from valun==0.7.2 valun join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"';
  const body = readBody(pub('network.html'));
  const code = () => body.querySelector('.join code');
  assert.equal(code().textContent, JOIN, 'as served, before any read');
  assert.ok(code().children.every(s => s.tagName === 'SPAN'), 'its parts, each kept whole when the line wraps');
  // One break point inside a part: the token file's path after "$HOME/", used only on phones narrower than 380 px, where
  // the whole path is wider than the line (a 320 px phone).
  const path_ = code().querySelector('.path');
  assert.deepEqual(path_.children.map(s => [s.tagName, s.textContent]), [['SPAN', '"$HOME/'], ['SPAN', 'valun-owner-token-YOUR-HANDLE.txt"']]);
  assert.equal(code().all('wbr').length, 0, 'Chrome would break at a <wbr> even inside nowrap');
  const rules = cssRules(pub('network.css'));
  assert.equal(rules.find(r => r.selector === '#join-cmd .path > span')?.decls.display, 'inline-block');
  assert.deepEqual(rules.filter(r => r.selector === '#join-cmd .path').map(r => [r.media, r.decls['white-space']]), [['(max-width: 380px)', 'normal']]);
  assert.equal(body.querySelector('.join a').getAttribute('href'), '/start');
  let copied = null;
  runNetworkPage(pub('network.js'), body, reads(TESTNET), {globals: {navigator: {clipboard: {writeText: async t => { copied = t; }}}}});
  await settle();
  assert.equal(code().textContent, JOIN, 'on the testnet too: the page leaves it as it is');
  // Copy, as on /start and the home: the command as written, said in the page's status line.
  const copy = body.querySelector('.join button.copy');
  assert.equal(copy.getAttribute('type'), 'button');
  assert.equal(copy.getAttribute('aria-describedby'), 'join-cmd');
  copy.click();
  await settle();
  assert.equal(copied, JOIN);
  assert.equal(body.all('*').find(e => e.id === 'announce').textContent, 'Copied.');
  assert.ok(body.querySelector('.join .small').textContent.includes('tERG are test coins on Ergo testnet with no monetary value. A note can be redeemed for tERG only against a reserve locked under the key that signed it, if one was posted.'));
  const css = cssRules(pub('network.css'));
  assert.equal(css.find(r => r.selector === '#join-cmd span').decls['white-space'], 'nowrap');
  assert.equal(css.find(r => r.selector === '#join-cmd').decls['white-space'], 'normal');
  assert.equal(css.find(r => r.selector === '.join .cmd pre'), undefined, 'site.css keeps the room for the Copy button');
  assert.equal(css.find(r => r.selector === '.loop-card').decls['margin-left'], 'auto', 'the loop card link stays at the right');
});
