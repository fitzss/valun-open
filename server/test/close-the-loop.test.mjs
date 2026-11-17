// Close the Loop: the public loops API (GET /pilot/v1/loops, /pilot/v1/loops/<id>), the server-rendered loop card
// (/loop/<id>: Open Graph tags, escaping of hostile handles, 404, CSP compliance), the valun.tech landing (Host
// routing, CSP compliance) and the public read cache (burst protection). Pilot state is built directly here (no
// tracker: a stub that counts its reads); test/sandbox-circulation.test.mjs checks the same routes on the set-offs of a
// real tour on a real tracker.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Pilot, PilotStore, PILOT_DENOMINATION} from '../lib/pilot/core.mjs';
import {createPilotRoutes, PUBLIC_CACHE_MS} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {loopOf, loopsOf, kindOf, esc, LOOPS_MAX} from '../lib/pilot/loops.mjs';
import {readBody, runNetworkPage} from './network-dom.mjs';
import {settle} from './console-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const HOSTILE = '<script>alert("x")</script>&\'"';
let dir, pilot, routes, server, base, trackerReads = 0;

// Participants: two sandbox agents, a sandbox joiner, an invited one, and one with a hostile handle (join refuses such
// handles; the card must escape whatever it is given).
const P = {
  X: {id: 'vp_00000000000a', handle: 'sandbox-exact', pubkey: '02' + 'a'.repeat(64)},
  M: {id: 'vp_00000000000b', handle: 'sandbox-mallory', pubkey: '02' + 'b'.repeat(64)},
  S: {id: 'vp_00000000000c', handle: 'ana', pubkey: '02' + 'c'.repeat(64), sandbox_only: true, sandbox_expires_at: '2026-11-18T00:00:00.000Z'},
  I: {id: 'vp_00000000000d', handle: 'bo', pubkey: '02' + 'd'.repeat(64)},
  H: {id: 'vp_00000000000e', handle: HOSTILE, pubkey: '02' + 'e'.repeat(64), sandbox_only: true},
};
const SECRET = {owner_token_hash: 'f'.repeat(64), agent_token_hash: '9'.repeat(64), mandate: {approve_above: 5}};
const ek = (a, b) => `${a.pubkey}>${b.pubkey}`;
const SIG = '02' + '1'.repeat(128);
// An applied set-off record as Pilot.createSetoff / applySetoff leave it (the fields a loop may not show included).
function setoff(id, cycle, each, appliedAt, {state = 'applied', withCycles = true} = {}) {
  const edges = cycle.map((a, i) => {
    const b = cycle[(i + 1) % cycle.length];
    return {edge: ek(a, b), issuer: {id: a.id, pubkey: a.pubkey}, recipient: {id: b.id, pubkey: b.pubkey}, decrease: each,
      before: {total: 5, timestamp: 1_800_000_000_123, signature: SIG}, new_total: 5 - each, timestamp: 1_800_000_001_998, revision: 1, server_only: false,
      slots: {issuer: {signature: SIG, by: 'agent', at: appliedAt}, recipient: {signature: SIG, by: 'agent', at: appliedAt}}};
  });
  return {id, kind: 'setoff', state, created_at: appliedAt, updated_at: appliedAt, applied_at: state === 'applied' ? appliedAt : undefined,
    expires_at: appliedAt, network: 'valun-pilot-1', tracker_nft_id: '0'.repeat(64), denomination: PILOT_DENOMINATION,
    amount: each * cycle.length, members: cycle.map(p => p.id), edges,
    cycles: withCycles ? [{edges: edges.map(e => e.edge), length: cycle.length, amount: each}] : [], edge_set: 'e'.repeat(32), per_edge_timestamps: true,
    source: 'presence', run_id: 'rn_0000000000000000', messages: {[edges[0].edge]: 'ab'.repeat(40)}, result: {code: 'applied', at: appliedAt},
    history: [{at: appliedAt, event: 'applied'}], tracker_after: {}, signature_sha256: {}};
}
const L3 = 'vs_00000000000000a3', L2 = 'vs_00000000000000a2', LH = 'vs_00000000000000ff', LX = 'vs_00000000000000e0', LC = 'vs_00000000000000c0';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-loops-'));
  const basis = {denomination: PILOT_DENOMINATION, nft: '0'.repeat(64), url: 'stub', allNotes: async () => { trackerReads += 1; return []; }};
  pilot = new Pilot({store: new PilotStore(dir), basis, log: () => {}});
  for (const p of Object.values(P)) pilot.s.participants[p.id] = {...p, ...SECRET, status: 'active', created_at: '2026-11-11T10:00:00.000Z', operator: 'op-name-xyz', services: ''};
  pilot.s.edges ??= {};
  pilot.s.setoffs = {
    [L2]: setoff(L2, [P.X, P.M], 1, '2026-11-11T12:00:00.000Z'),
    [L3]: setoff(L3, [P.M, P.S, P.X], 1, '2026-11-11T13:00:00.000Z'),
    [LH]: setoff(LH, [P.H, P.I, P.S], 2, '2026-11-11T14:00:00.000Z', {withCycles: false}),
    [LX]: setoff(LX, [P.S, P.I], 1, '2026-11-11T15:00:00.000Z', {state: 'expired'}),
    [LC]: setoff(LC, [P.S, P.X], 1, '2026-11-11T15:30:00.000Z', {state: 'collecting'}),
  };
  routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000, publicCacheMs: PUBLIC_CACHE_MS}});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); if (dir) fs.rmSync(dir, {recursive: true, force: true}); });

const get = async (p, headers = {}) => { const r = await fetch(base + p, {headers}); return {status: r.status, headers: r.headers, text: await r.text()}; };
const getJson = async p => { const r = await get(p); return {...r, body: JSON.parse(r.text)}; };
const rawGet = (p, host, method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request(base + p, {method, headers: {host}}, res => { let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: b})); });
  r.on('error', reject); r.end();
});

// ---------- the loops API ----------
// amount and each: the unit-neutral names (fix inbox #32), next to the deprecated amount_PC and each_PC.
const LOOP_KEYS = ['amount', 'amount_PC', 'applied_at', 'card_url', 'cycle_length', 'cycles', 'each', 'each_PC', 'id', 'members', 'participants'].sort();
test('GET /pilot/v1/loops: applied set-offs only, newest first, members as public handles in cycle order with their kinds', async () => {
  const r = await getJson('/pilot/v1/loops');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.body).sort(), ['loops', 'network', 'unit']);
  assert.deepEqual(r.body.loops.map(l => l.id), [LH, L3, L2], 'the expired and the collecting proposals are not loops');
  const l3 = r.body.loops[1];
  assert.deepEqual(Object.keys(l3).sort(), LOOP_KEYS);
  assert.deepEqual(l3, {id: L3, applied_at: '2026-11-11T13:00:00.000Z', cycle_length: 3, amount: 3, amount_PC: 3, each: 1, each_PC: 1, participants: 3,
    members: [{handle: 'sandbox-mallory', kind: 'sandbox_agent'}, {handle: 'ana', kind: 'sandbox_participant'}, {handle: 'sandbox-exact', kind: 'sandbox_agent'}],
    cycles: [{length: 3, each: 1, each_PC: 1, members: [{handle: 'sandbox-mallory', kind: 'sandbox_agent'}, {handle: 'ana', kind: 'sandbox_participant'}, {handle: 'sandbox-exact', kind: 'sandbox_agent'}]}],
    card_url: `https://valun.tech/loop/${L3}`});
  // A record without the engine's cycle list: the order is read by following its edges.
  assert.deepEqual(r.body.loops[0].members.map(m => m.handle), [HOSTILE, 'bo', 'ana']);
  assert.deepEqual(r.body.loops[0].members.map(m => m.kind), ['sandbox_participant', 'invited', 'sandbox_participant']);
  assert.equal(r.body.loops[0].each_PC, 2);
  const one = await getJson(`/pilot/v1/loops/${L3}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, l3);
  for (const bad of [LX, LC, 'vs_0000000000000000', 'vs_zz', '..%2f..%2finfo', 'vp_00000000000a']) {
    const x = await getJson(`/pilot/v1/loops/${bad}`);
    assert.equal(x.status, 404, bad);
    assert.equal(x.body.error, 'not_found', bad);
  }
});

test('a loop exposes nothing beyond the public fields: no participant ids, keys, signatures, tokens, owner data or messages', async () => {
  const text = (await get('/pilot/v1/loops')).text + (await get(`/pilot/v1/loops/${L3}`)).text + (await get(`/loop/${L3}`)).text + (await get(`/loop/${LH}`)).text;
  for (const p of Object.values(P)) {
    assert.ok(!text.includes(p.id), `participant id ${p.id}`);
    assert.ok(!text.includes(p.pubkey), 'public key');
  }
  for (const secret of [SIG, SECRET.owner_token_hash, SECRET.agent_token_hash, 'ab'.repeat(40), 'rn_0000000000000000', 'e'.repeat(32), 'approve_above', 'op-name-xyz', 'owner_token', 'agent_token']) 
    assert.ok(!text.includes(secret), secret.slice(0, 20));
  // Everything a loop shows of a member is in the public directory.
  const dir = (await getJson('/pilot/v1/participants')).body;
  for (const l of (await getJson('/pilot/v1/loops')).body.loops) for (const m of l.cycles.flatMap(c => c.members)) {
    const x = dir.find(d => d.handle === m.handle);
    assert.ok(x, m.handle);
    assert.equal(m.kind, kindOf(x), m.handle);
  }
});

test('loopOf and loopsOf: the pure parts', () => {
  const pub = x => pilot.publicParticipant(x);
  assert.equal(loopOf(pilot.s.setoffs[LX], pilot.s.participants, pub), null, 'expired');
  assert.equal(loopOf({...pilot.s.setoffs[L3], id: 'vs_bad'}, pilot.s.participants, pub), null, 'an id of another shape');
  const many = {};
  for (let i = 0; i < LOOPS_MAX + 7; i++) { const id = `vs_${String(i).padStart(16, '0')}`; many[id] = setoff(id, [P.X, P.M], 1, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()); }
  const list = loopsOf(many, pilot.s.participants, pub);
  assert.equal(list.length, LOOPS_MAX);
  assert.equal(list[0].id, `vs_${String(LOOPS_MAX + 6).padStart(16, '0')}`, 'newest first');
  // A member whose record is gone shows as unknown, never as an id.
  const gone = loopOf(setoff('vs_00000000000000b0', [P.X, {id: 'vp_ffffffffffff', pubkey: '03' + 'f'.repeat(64)}], 1, '2026-11-11T00:00:00Z'), pilot.s.participants, pub);
  assert.deepEqual(gone.members, [{handle: 'sandbox-exact', kind: 'sandbox_agent'}, {handle: null, kind: 'unknown'}]);
  assert.equal(esc(HOSTILE), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&quot;');
});

// ---------- the loop card ----------
const meta = (html, attr, name) => { const m = new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`).exec(html); return m ? m[1] : null; };
test('/loop/<id>: a server-rendered card with Open Graph and Twitter tags', async () => {
  const r = await get(`/loop/${L3}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*style-src 'self'; script-src 'self'/);
  assert.equal(meta(r.text, 'property', 'og:title'), 'Loop closed: sandbox-mallory → ana → sandbox-exact → sandbox-mallory');
  assert.equal(meta(r.text, 'property', 'og:description'), '3 agents cancelled 3 credits of IOUs in one set-off. No money moved. Recorded on a Basis tracker (pilot network; credits have no value).');
  assert.equal(meta(r.text, 'property', 'og:url'), `https://valun.tech/loop/${L3}`);
  assert.equal(meta(r.text, 'property', 'og:type'), 'website');
  assert.equal(meta(r.text, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta(r.text, 'property', 'og:image'), 'https://valun.tech/og.png');
  assert.equal(meta(r.text, 'name', 'twitter:title'), meta(r.text, 'property', 'og:title'));
  assert.match(r.text, /<link rel="canonical" href="https:\/\/valun\.tech\/loop\/vs_00000000000000a3">/);
  assert.match(r.text, /<title>Loop closed: sandbox-mallory → ana → sandbox-exact → sandbox-mallory · Valun<\/title>/);
  // the body: the mark, the route, the ring, the facts, the honest note and the two calls to action
  assert.match(r.text, /<a class="brand" href="\/" aria-label="Valun home"><svg class="mark" viewBox="0 0 100 100"/);
  assert.match(r.text, /<p class="eyebrow">Loop cleared<\/p>/);
  assert.match(r.text, /<h1 class="route"><span class="h">sandbox-mallory<\/span> <span class="arr">→<\/span> <span class="h">ana<\/span> <span class="arr">→<\/span> <span class="h">sandbox-exact<\/span> <span class="arr">→<\/span> <span class="h">sandbox-mallory<\/span><\/h1>/);
  assert.match(r.text, /<svg class="ring"/);
  assert.equal((r.text.match(/<g class="node /g) || []).length, 3);
  assert.equal((r.text.match(/<path class="arc"/g) || []).length, 3);
  assert.match(r.text, /<circle class="rainbow" [^>]*stroke="url\(#loop-rainbow-0\)"/);
  assert.match(r.text, /<dd>3 PC<\/dd>/);
  assert.match(r.text, /3 agents' IOUs formed a loop\. Each agent signed once, and every debt in the loop fell by 1 PC: 3 credits of debt cancelled in all\. The work stays done\. No money moved\./);
  assert.match(r.text, /<code>vs_00000000000000a3<\/code>/);
  assert.match(r.text, /<dd>2026-11-11 13:00 UTC<\/dd>/);
  assert.match(r.text, /no monetary value/);
  assert.match(r.text, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(r.text, /<a class="btn" href="\/network">Watch the network live<\/a>/);
  assert.match(r.text, /<a class="btn primary" href="https:\/\/valun\.tech\/">Close your own loop<\/a>/);
  const two = await get(`/loop/${L2}`);
  assert.equal(meta(two.text, 'property', 'og:title'), 'Loop closed: sandbox-exact → sandbox-mallory → sandbox-exact');
  assert.equal(meta(two.text, 'property', 'og:description'), '2 agents cancelled 2 credits of IOUs in one set-off. No money moved. Recorded on a Basis tracker (pilot network; credits have no value).');
  assert.equal((await rawGet(`/loop/${L3}`, 'valun.tech', 'HEAD')).status, 200);
});

test('/loop/<id> escapes hostile handles everywhere (title, meta tags, SVG, facts)', async () => {
  const r = await get(`/loop/${LH}`);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('<script'), 'no script element');
  assert.ok(!r.text.includes('alert("x")'), 'no raw quote from the handle');
  assert.ok(!/content="[^"]*<[^"]*"/.test(r.text), 'no < inside an attribute');
  const t = meta(r.text, 'property', 'og:title');
  assert.equal(t, 'Loop closed: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&quot; → bo → ana → &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&quot;');
  assert.ok(r.text.includes('>&lt;script&gt;alert(&quot;x&quot;)&lt;…</text>'), 'the SVG label is escaped and cut to the room it has');
  assert.ok(r.text.includes('<span class="h">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&quot;</span>'), 'the route');
  assert.match(r.text, /<dd>6 PC<\/dd>/);
});

test('/loop/<id>: an unknown, unapplied or malformed id is a 404 page', async () => {
  for (const id of ['vs_0000000000000000', LX, LC, 'nope', '%3Cscript%3E']) {
    const r = await get(`/loop/${id}`);
    assert.equal(r.status, 404, id);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', id);
    assert.match(r.text, /Loop not found/, id);
    assert.match(r.text, /<meta name="robots" content="noindex">/, id);
    assert.ok(!r.text.includes('og:title'), id);
    assert.ok(!r.text.includes('<script'), id);
  }
  assert.equal((await get('/loop/')).status, 404);
  // Without a pilot the card route still answers with the 404 page.
  const bare = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public')}));
  await new Promise(r => bare.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${bare.address().port}/loop/${L3}`);
  assert.equal(r.status, 404); assert.match(await r.text(), /Loop not found/);
  bare.close();
});

// The pages keep the CSP (script-src 'self', style-src 'self'): no inline script, style or handler, only their own files.
function cspClean(html, {scripts = [], styles}) {
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(m => /\ssrc="([^"]+)"/.exec(m[0])?.[1] ?? null), scripts, 'every script is one of the page\'s own files');
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|javascript:/i, 'no inline style or event handler');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), styles);
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed)\b[^>]*\ssrc="https?:/i, 'no external resource');
}
test('the loop card, its 404 page and the landing keep the CSP', async () => {
  // The rendered pages load the shared base first, then their own (lib/pilot/loops.mjs page).
  cspClean((await get(`/loop/${L3}`)).text, {styles: ['/site.css', '/loop.css']});
  cspClean((await get(`/loop/${LH}`)).text, {styles: ['/site.css', '/loop.css']});
  cspClean((await get('/loop/nope')).text, {styles: ['/site.css', '/loop.css']});
  const home = pub('home.html');
  // The shared base first (public/site.css), then the home's own layout, then the worked example's (public/story.css).
  cspClean(home, {scripts: ['/home.js', '/story.js'], styles: ['/site.css', '/home.css', '/story.css']});
  assert.match(home, /<script type="module" src="\/home\.js"><\/script>\n<script type="module" src="\/story\.js"><\/script>/);
  assert.deepEqual([...home.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]).sort(),
    ['https://github.com/fitzss/hermes-plugin-valun', 'https://github.com/fitzss/valun-open', 'https://github.com/fitzss/valun-open',
      // the worked example's live records: the tracker-box tx that committed claude-live-1's two loops, on the explorer
      'https://testnet.ergoplatform.com/en/transactions/f2a146cf387f7c95a9d95b6c772e04069ae34c6a5cd994d29d6feaf5981fe455', 'https://valun.tech/',
      // and the records themselves, on valun.tech's testnet (staging and a preview run their own tracker)
      'https://valun.tech/agent/claude-live-1', 'https://valun.tech/loop/vs_4f8d53475c9e591a', 'https://valun.tech/loop/vs_f8254530b0cf5e5d'],
    'external URLs are links (and the canonical URL) only');
  const js = pub('home.js');
  assert.deepEqual([...js.matchAll(/getJson\('([^']+)'\)/g)].map(m => m[1]).sort(), ['/pilot/v1/clearing', '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/participants?all=1']);
  assert.doesNotMatch(js, /authorization|bearer|x-valun|localStorage|sessionStorage|innerHTML|eval\(/i);
  assert.match(js, /credentials: 'omit'/);
  for (const css of ['home.css', 'loop.css', 'network.css', 'site.css']) assert.doesNotMatch(pub(css), /@import|url\(\s*['"]?https?:/i, `${css}: no external fonts or images`);
  // The one dark theme and the self-hosted fonts are site.css's: the home, the loop cards, agent pages and /network load
  // it first and redefine neither.
  for (const css of ['site.css']) {
    assert.match(pub(css), /color-scheme: dark;/, `${css}: the one dark theme`);
    assert.deepEqual([...pub(css).matchAll(/url\("([^"]+)"\) format\("woff2"\)/g)].map(m => m[1]), ['/fonts/jost-latin.woff2', '/fonts/jetbrains-mono-latin-400.woff2'], css);
  }
  // The home's own stylesheet builds on site.css (the fonts, the dark theme and the tokens are there): no files of its own.
  assert.doesNotMatch(pub('home.css'), /@import|@font-face|url\(|:root\b/i, 'home.css: no fonts, tokens or outside files of its own');
  for (const css of ['loop.css', 'network.css']) assert.doesNotMatch(pub(css), /@font-face|:root\s*\{/, `${css}: builds on site.css`);
  assert.deepEqual([...pub('network.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site.css', '/network.css']);
  for (const html of [home, pub('network.html'), (await get(`/loop/${L3}`)).text, (await get('/loop/nope')).text])
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, 'every page links the mark');
});

// The landing (public/home.html), rebuilt around the visitor's agent (site brief, 2026-11-17): the promise in plain
// words, the live view, the worked example's place, what you can try today, three ways to connect with how far each was
// tested, the open questions, who runs what and what isn't true yet, and the invitation. homeWords: the page's words as
// a reader sees them (no tags or comments, character references decoded, whitespace collapsed; a <wbr> in inline code,
// lib/code-words.mjs, is no character).
const homeWords = h => (/<body>([\s\S]*)<\/body>/.exec(h)?.[1] ?? h).replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/?(?:code|a|b|strong|em|span|wbr)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
// The headline, the lede and the link preview's words: the lead's decision D1 of fix round 1 (all four newcomer readers
// ranked "Hire an agent. Pay with a promise. Pass it on." first for wanting to try).
const LEDE = 'Your agent can hire another agent now and pay with a signed IOU, a promise to pay later, so it needs no balance up front. It earns IOUs back with its own work, and can pass them on to agents that accept them. It works inside limits you set, on a public record anyone can check. On Ergo testnet, with test coins only.';
const DESCRIPTION = "Let your agent work with agents you don't run. It can hire another agent now and pay with a signed IOU, a promise to pay later, so it needs no balance up front. It earns IOUs back with its own work, and can pass them on to agents that accept them, inside limits you set, on a public record anyone can check. Ergo testnet, test coins only.";
const SHARE = 'Your agent can hire another agent now and pay with a signed IOU, a promise to pay later, so it needs no balance up front. It works inside limits you set, on a public record anyone can check. Ergo testnet, test coins only.';
test('the landing: the headline and lede, the meta tags, the shared header and footer, the calls to action and the anchors others link', () => {
  const home = pub('home.html');
  // Two lines: what Valun lets your agent do, then how (home.css .h1b: the second in the secondary ink).
  assert.match(home, /<h1 id="hero-title"><span class="h1a">Let your agent work with agents you don't run\.<\/span> <span class="h1b">Hire one\. Pay with a promise\. Pass it on\.<\/span><\/h1>/);
  assert.equal((home.match(/<h1\b/g) || []).length, 1, 'one h1');
  assert.match(home, /<p class="kicker">Valun: credit for machines<\/p>/);
  assert.ok(home.includes(`<p class="lede">${LEDE}</p>`), 'the lede');
  assert.doesNotMatch(LEDE, /tracker box|netting/i, 'the lede in plain words');
  assert.match(home, /<title>Valun: let your agent work with agents you don't run<\/title>/);
  assert.equal(meta(home, 'name', 'description'), DESCRIPTION);
  for (const [attr, name] of [['property', 'og:title'], ['name', 'twitter:title']]) assert.equal(meta(home, attr, name), "Let your agent work with agents you don't run.", name);
  for (const [attr, name] of [['property', 'og:description'], ['name', 'twitter:description']]) assert.equal(meta(home, attr, name), SHARE, name);
  assert.equal(meta(home, 'property', 'og:image:alt'), "Valun: let your agent work with agents you don't run. Three agents in a loop of IOUs, on Ergo testnet.", 'the image says what it shows');
  // The shared header: a skip link, the mark (the home's own link), the five links; and the shared footer.
  assert.match(home, /<body>\n<a class="skip" href="#main">Skip to content<\/a>\n<header class="top"><a class="brand" href="\/" aria-label="Valun home" aria-current="page"><svg class="mark" viewBox="0 0 100 100" aria-hidden="true">.*?<\/svg><span class="wordmark">Valun<\/span><\/a>\n<nav aria-label="Main"><ul><li><a href="\/start">Start<\/a><\/li><li><a href="\/network">Network<\/a><\/li><li><a href="\/trust">Trust<\/a><\/li><li><a href="\/memory">Memory<\/a><\/li><li><a href="https:\/\/github\.com\/fitzss\/valun-open">GitHub<\/a><\/li><\/ul><\/nav><\/header>\n<main id="main">/);
  const foot = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(home)[1];
  assert.match(foot, /<p>Ergo testnet · test coins only, with no monetary value<\/p>/);
  assert.deepEqual([...foot.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]),
    [['/trust', 'Trust'], ['/start#report', 'Report a problem'], ['/skill.md', 'skill.md'], ['/llms.txt', 'llms.txt'], ['https://github.com/fitzss/valun-open', 'GitHub']]);
  // The calls to action: connect your agent, or try it without one; under them the first job to try, then the live
  // network (not "Inspect the network", which is the name of a path on /start) beside what backs an IOU. Two newcomer
  // readers of build 992999e still asked "what job could I do first?" and "what backs an IOU?" on the first screen (the
  // lead's D1b). house-scribe's summary is 2,000,000 nanoERG (its services on GET /pilot/v1/participants, Nov 17).
  assert.match(home, /<a class="btn primary" href="\/start#agent">Connect your agent<\/a>\s*<a class="btn" href="\/start#tour">Explore without an agent<\/a>\s*<\/div>\s*<p class="first-try"><span class="k">First thing to try:<\/span> hire house-scribe, an operator-run agent, for a summary \(0\.002 tERG\), paid with your agent's IOU\.<\/p>/);
  assert.match(home, /<p class="inspect"><a href="\/network">Watch the live network<\/a> <a href="\/trust#backing">What backs an IOU\?<\/a><\/p>/);
  // The anchors other pages, docs and tests link (/#agent, /#solo, /#friends), and the worked example's place.
  for (const id of ['agent', 'solo', 'friends', 'how', 'try', 'why', 'evidence', 'live']) assert.equal((home.match(new RegExp(`\\sid="${id}"`, 'g')) || []).length, 1, id);
  // The worked example (public/story-fragment.html, pasted between the markers) brings the section's own h2.
  assert.match(home, /<section id="how" class="section" aria-labelledby="how-title">\n  <!-- STORY:BEGIN -->\n<h2 id="how-title">[^<]+<\/h2>[\s\S]*<!-- STORY:END -->\n<\/section>/);
  // Every section is named by its heading: the hero by the h1, each other section by an h2.
  const sections = [...home.matchAll(/<section\b[^>]*>/g)].map(m => m[0]);
  assert.equal(sections.length, 7);
  for (const s of sections) {
    const id = /aria-labelledby="([^"]+)"/.exec(s)?.[1];
    assert.ok(id, `${s} is labelled`);
    assert.match(home, new RegExp(`<h[12] id="${id}">`), id);
  }
  // The one command on the page: the line any agent follows (public/skill.md), with its Copy. The rest are on /start.
  assert.equal(/<code id="cmd-agent">([^<]*)<\/code>/.exec(home)[1], 'Read https://valun.tech/skill.md and follow it to join Valun.');
  assert.match(home, /<button type="button" class="copy" data-copy="cmd-agent" aria-describedby="cmd-agent">Copy<\/button>/);
  assert.match(home, /<p class="vh" id="copy-said" role="status"><\/p>/, 'Copy says what happened in a status line too');
  assert.equal((home.match(/<pre>/g) || []).length, 1, 'one command block');
  assert.doesNotMatch(homeWords(home), /uvx |pipx |pip install|--owner-token-file|--handle /, 'no install notes or commands: they live on /start');
  for (const href of ['/skill.md', '/llms.txt', '/.well-known/agent-card.json', '/start#report', '/network', '/trust']) assert.ok(home.includes(`href="${href}"`), href);
  assert.match(home, /<canvas id="sky" role="img" aria-label="Live: [^"]+">/);
  assert.doesNotMatch(home.replace(/<circle\b/g, ''), /circle/i, 'no "circle" in the copy (it reads as the company Circle)');
});

test('the landing claims no more than the evidence: test agents, how far each way was tested, committed not irreversible, the trust model', () => {
  const home = pub('home.html'), text = homeWords(home);
  // The live view says it is live, what it reads, and that its agents are almost all ours (0 outside agents on Nov 17).
  // (the Live label is shown by the script: without it nothing there is live)
  assert.match(home, /<span class="tag live" id="sky-tag" hidden>Live<\/span> <span id="sky-read">Testnet records<\/span>/);
  assert.ok(text.includes('So far almost all of these are our own test and practice agents: they show the mechanics working, not adoption.'));
  assert.ok(text.includes('Basis is our QA bot, not the Basis protocol team.'));
  assert.equal((text.match(/adoption/g) || []).length, 1, '"adoption" only to say these are not it');
  // The worked example's place holds an example, labelled as one.
  assert.match(home, /<span class="tag example">Example: made-up agents, not live data<\/span>/);
  // What you can try today: four things, each with its path on /start.
  const tries = [...home.matchAll(/<li(?: id="([a-z]+)")?>\s*<div class="do">\s*<h3>([^<]+)<\/h3>[\s\S]*?<p class="go"><a href="([^"]+)">/g)].map(m => [m[1] ?? null, m[2], m[3]]);
  // (the audit's link lands on the audit command itself, inside /start's "Inspect the network" path: start.js opens the
  // path that holds an address's target)
  assert.deepEqual(tries, [[null, 'Hire house-scribe for a summary, a rewrite or a translation', '/start#agent'], ['solo', 'Take the guided tour, without an AI agent', '/start#tour'],
    ['backing', 'Back an agent, or check a payer before you accept', '/start#backing'], ['audit', "Check the operator's ledger against the chain", '/start#audit']]);
  assert.match(pub('start.html'), /<code id="cmd-audit">[^<]*valun audit/);
  assert.match(pub('start.html'), /\sid="audit"/, 'the home links /start#audit');
  assert.match(pub('start.html'), /\sid="friends-loop"/, 'the home links /start#friends-loop');
  for (const s of ["house-scribe is operator-run: the operator holds its key and sends your text to the Claude API under the operator's own key.",
    'a promise, not locked collateral', "A budget card is the server's statement: its owner doesn't sign it, and it isn't tied to the tracker box on chain.",
    // a guarantee names one creditor (lib/pilot/guarantees.mjs); a payer with no public card checks as unknown
    // (lib/pilot/card.mjs combined()), and on Nov 17 none of the operator's agents, nor 15 sampled others, published one
    "Backing is a signed promise to pay one creditor, up to a cap, what another agent still owes it, if that agent doesn't",
    "One answer for the deal, with the reasons, before your agent commits: accept, ask the owner, decline, or unknown when the payer's owner hasn't published a card, as most haven't yet.",
    "MATCH, MISMATCH, or UNKNOWN: the box hasn't caught up yet, which is not a mismatch.",
    // the six things valun 0.7.1 says a MATCH doesn't prove (audit.py DOES_NOT_PROVE)
    "A MATCH proves the box commits the published IOUs. It doesn't prove what is outstanding, that an issuer can pay, that any deal was real or any work good, that the agents are independent of each other, that a key belongs to a handle, or that a mandate was kept.",
    'An IOU can be redeemed for tERG only from its issuer\'s reserve: only if the issuer posted one, and only up to what it holds.', 'tERG have no monetary value.',
    '2 to 3 minutes in a terminal.'])
    assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /about (?:3|three) minutes/i, 'the tour takes 2 to 3 minutes on every page (fix inbox #124)');
  // With friends: no invite. The old page offered an invite-code route right after "no invite is needed".
  assert.match(homeWords(/<div class="friends" id="friends">[\s\S]*?<\/div>/.exec(home)[0]), /Three or more people, each with an agent, and no invite needed\. [^.]+\. That last IOU closes the loop: each agent signs once and the loop clears\./);
  assert.ok(text.includes('The loop waits up to 30 minutes for every signature.'));
  // a shell agent signs a set-off only while valun clearing watch runs, or when it reads its inbox or status (valun 0.7.1
  // cli.py: valun call signs the value-safe consents before valun_status and valun_inbox, consents_on_reads)
  assert.ok(text.includes("Each person's client has to be running when the loop closes, so it can sign: valun mcp or the Hermes plugin does this, and a shell agent keeps valun clearing watch running, or checks its inbox, until the loop clears."));
  assert.doesNotMatch(text, /invite code|with an invite|an organizer/i);
  // Bring your agent: one released client, no invite, and how far each way was tested (the compatibility evidence).
  assert.ok(text.includes('Three ways in, all on the same released client, valun==0.7.1. No invite is needed.'));
  // The Claude Code run as its evidence has it (the team's record of the Nov 17 run): the join in a terminal,
  // the owner's side scripted, ask cancelled and client-prompt refused by headless Claude Code, its own prompts untested.
  for (const s of ["Tested so far One complete exchange in Claude Code 2.1.326, on Nov 17 (build 09875a4): the join in a terminal (CLI), claude mcp add, then a summary bought from house-scribe and paid with the agent's IOU. It ran headless (claude -p) with console approvals, and the owner's side was scripted: approvals through the owner console's API, and Claude Code's permission prompts answered by a script.",
    "In that run Claude Code cancelled ask's form and refused client-prompt; other headless setups haven't been tested, so choose console or none on purpose. Claude Code's own approval prompts, in the interactive app, are not tested yet. Scripted MCP clients too (Nov 16). Other MCP apps: not tested yet, so tell us how it goes.",
    'The Claude Code plugin has had an install check only (plugin 0.4.1, Nov 11).',
    // ask is a form the app may or may not show a person (valun 0.7.1 mcp_server.py: elicitation; approval_unavailable)
    "In the default mode, ask, valun mcp sends an approval form through your app before each commitment (MCP elicitation); if the form is cancelled or can't be shown, nothing is signed. Whether a person sees it depends on the app: no interactive app has been verified yet.",
    // Hermes asks through its own approval gate (hermes-plugin-valun 0.7.1: never run with --yolo)
    'By default Hermes asks you in the conversation before each commitment, through its own approval gate, so never run it with --yolo.',
    'Tested so far End to end in a real Hermes (v0.23.1) with plugin 0.6.0, on Nov 13, by our QA bot. The current plugin, 0.7.1, is not yet verified in a real Hermes.',
    // a shell agent: console or none, its human's choice (the lead's D10); the scripted runs with their dates and builds
    // (d11e6b4 for the newcomer run, 17:24-17:43 UTC; 09875a4 on the testnet from 20:00 UTC)
    'A shell agent can\'t show you a prompt: it joins with console (you approve each commitment in the owner console) or none (it acts alone within the limits), and it asks you which.',
    "Tested so far The valun command (0.7.1) is run by scripts: our QA bot daily (build 09875a4 since Nov 16, 20:00 UTC), and a Claude session acting as a newcomer on a clean profile (Nov 16, build d11e6b4). No AI agent has yet been recorded following this line from start to finish. An AI agent of the team's (muse) used the valun command and the JS library end to end on Nov 16-17, a redemption included, after join and connection failures (known issues)."])
    assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /the current build/, 'every label names its build');
  // Before you paste the one line: what following skill.md does (the lead's D9), skill.md first and live; approving in
  // the app's own prompt or in the owner console; a token file named for the handle (the lead's D12b: valun 0.7.1's join
  // refuses to replace a token file that exists, such as the tour's, and prints the token instead, cli.py _hand_over);
  // and OpenClaw's saved copy of skill.md (skill.md section 1).
  const before = homeWords(/<div class="note before-paste">[\s\S]*?<\/div>/.exec(home)[0]);
  for (const s of ['Before you paste it', 'Read /skill.md first. It is served live, so it can change.',
    'Your agent will ask you for a handle and your name (both public and permanent), one line about what it offers, and whether you approve each commitment (in your app or in the owner console) or let it act alone.',
    'It runs valun 0.7.1 from PyPI with uvx, and may offer to install uv.',
    'It makes its key, stored unencrypted in your Valun profile folder, and writes your owner token to a new file named for its handle, ~/valun-owner-token-YOUR-HANDLE.txt: move that file into your password manager.',
    "If join can't write it, join prints the token instead; your agent should stop, not repeat it, and tell you to keep it only in your password manager.",
    "In an MCP app it adds the valun server to the app's config and asks you to restart.",
    "In OpenClaw it also saves skill.md as a skill, ~/.openclaw/skills/valun/SKILL.md (a copy that won't follow later changes to skill.md), and restarts the gateway.",
    "It may set itself a schedule to check its inbox (skill.md section 4). Say no if you don't want that."]) assert.ok(before.includes(s), s);
  assert.doesNotMatch(home, /valun-owner-token\.txt/, 'no token file every join would share');
  assert.doesNotMatch(text, /limits you choose/, 'the join asks for an approval mode; the limits are the server\'s caps');
  assert.doesNotMatch(text, /\bsupported\b|\bworks with\b|\btested (?:with|in) (?:Claude|Codex|Cursor|Hermes|OpenClaw)/i);
  // Approvals and limits as the client and the server have them: four modes, limits the server enforces in every mode.
  // Never "your owner is always asked": some steps are signed without asking in every mode (/start lists them).
  assert.ok(text.includes('You choose the mode: ask (the default), client-prompt, console or none. Some steps are signed without asking in every mode, such as deliveries, disputes and loop sign-offs within local caps (the full list).'));
  assert.ok(home.includes('<a href="/start#credentials">the full list</a>'));
  // the testnet's default acceptance (test/home-page.test.mjs checks its number against the server's; each client signs
  // only for its own key: the lead's D3b), and that a console hold is the operator's server's (lib/pilot/core.mjs: the
  // signed note is held, not submitted)
  assert.ok(text.includes("Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way. Its owner can narrow whose IOUs it accepts under 'Accept notes from' in the owner console. With console, your agent has already signed what waits: the operator's server holds it until you approve, so that hold is the operator's word, not the chain's."));
  assert.ok(text.includes('The server enforces them in every mode: at most 0.005 tERG per deal and 0.04 tERG owed in all, 10 open offers, for 7 days, renewed while your agent is active.'));
  assert.ok(text.includes("Made on your machine, and it stays there, unencrypted in the client's profile file. Only its public key reaches the server, so the operator can't sign for your agent."));
  assert.doesNotMatch(text, /always asked|owner is always/i);
  // Why this is interesting: open questions, not features.
  assert.match(home, /<p class="tag">Open questions, not features<\/p>/);
  assert.ok(text.includes('None is shown at scale yet, and some may not work.'));
  assert.equal((home.match(/<dt>Open question<\/dt>/g) || []).length, 5);
  assert.equal((home.match(/<dt>Today<\/dt>/g) || []).length, 5, 'each possibility says what exists today');
  assert.ok(text.includes('No chain across independent operators has happened yet.'));
  // Who runs what: the operator's server, tracker key and four agents; what it can and cannot do.
  for (const who of ['You', 'The operator', 'Ergo testnet', 'Anyone']) assert.ok(home.includes(`<h3>${who}</h3>`), who);
  for (const s of ['Fitz Doud, who runs valun.tech.', 'Runs the server, which sees every deal.',
    'Runs the tracker and holds its key, which signs every tracker box and every redemption, so it can refuse one.',
    'Runs four agents: the practice agents sandbox-exact and sandbox-mallory (no AI) and the house agents house-scribe and house-reviewer (Claude).',
    // it writes what agents follow, and only the PyPI release is fixed
    "Writes skill.md, which agents follow as instructions, and publishes the clients and plugins. valun==0.7.1 on PyPI can't change; skill.md and the plugins' latest versions can.",
    // the admin mandate route sets any field, past the self-serve box (lib/pilot/core.mjs setMandate, by 'operator'), and
    // renewSandbox records each renewal as the operator's; only the last change is kept
    "Can change any part of an agent's mandate, including what waits for the owner (approve_above) and whose IOUs it accepts, beyond the self-serve limits. The owner console shows the last change as by: operator; routine renewals of the expiry are shown the same way, and no history is kept.",
    // the owner-token route (the lead's D5): a takeover power, said as one, and what it still can't do; and who could
    // notice a swap (the lead's D5b: the public record carries only the current pubkey, lib/pilot/core.mjs
    // publicParticipant; GET /pilot/v1/owner lists past_keys)
    "It can also issue a new owner token for any agent (recorded as by: operator; the old token stops working), and an owner token can revoke the agent's key and enroll another. So the operator could put a key of its own on your handle and record. It can't use your key: IOUs your key signed and your reserve stay bound to it. The public record shows only an agent's current key, so a swap shows only to someone who noted the old one; your owner view lists past keys.",
    'Holds the reserve contract (upstream Basis, unchanged).']) assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /give an owner a new owner token|change an agent's limits, recorded|a new key shows as a different public key/i);
  // What isn't true yet, each linked to its part of the trust model (/trust: people's links; agents keep skill.md's).
  for (const a of ['chain', 'netting', 'backing', 'redemption', 'who-runs-what', 'not-proven', 'check']) assert.ok(home.includes(`href="/trust#${a}"`), a);
  assert.ok(text.includes('A cleared loop is committed, not irreversible. It holds only as long as the tracker key never commits an earlier total again. The operator holds that key, and nothing on chain stops it.'));
  // what is held once a backer pays (the lead's D14; lib/pilot/core.mjs heldForBackers): the same amount of the issuer's
  // IOU, never "held from the creditor" or "for the backer"
  assert.ok(text.includes("Backing is a promise, not collateral. A backer that honors a call pays with its own IOU. Once a backer pays, the same amount of the issuer's IOU is held, so the creditor isn't paid twice. The backer doesn't take over the claim."));
  assert.doesNotMatch(text, /held from the creditor|held for the backer/i);
  assert.ok(text.includes('A backer that honors a call pays with its own IOU; nothing is locked up.'));
  assert.ok(text.includes('The documented 0.7.1 client stays within the server\'s checks; a hand-built client with an earlier redemption build (a dry run is enough) can go around them.'));
  assert.ok(text.includes('holds the debt until it is cleared in a loop, passed on, or redeemed if the agent posted a reserve.'));
  assert.ok(text.includes('Now a stranger that trusts the backer, or sees a reserve behind it, can say yes.'));
  assert.ok(text.includes('Almost every agent so far is ours.'));
  // Words the site never uses (the copy rules); "irreversible" only as "not irreversible"; no unit but tERG in prose.
  assert.doesNotMatch(text, /trustless|fully decentrali[sz]ed|revolutioni[sz]e|limitless|the agent economy|guaranteed|risk-free|seamless|final settlement|\bpartners?\b|\busers\b|\bcommunity\b|\bsettled\b|\bfinal\b|\bmoney\b/i);
  assert.doesNotMatch(home, /debt is gone|\bis final\b|credits have no monetary value/i);
  assert.equal((text.match(/irreversible/g) || []).length, 1); assert.match(text, /not irreversible/);
  assert.doesNotMatch(text, /\bcredits\b|\d\s*credit\b|nanoERG|\bPC\b/, 'amounts in tERG');
  // The invitation.
  assert.match(home, /<a class="btn primary" href="\/start#report">Tell us what you learned<\/a>/);
  assert.ok(text.includes('Never paste a token, a key or a profile file.'));
});

// The landing's amounts on the testnet: its reads name the unit (nanoERG) beside each amount, and the page says them in
// tERG, as /network and the loop cards do, rounded as people read them. It said "104,475,000 credits cancelled" for
// 0.104475 tERG (1 credit is 1,000,000 nanoERG), and "3,000,000 credits cancelled" for a loop whose card says 0.003 tERG
// (outside-tester review, 2026-11-15). It reads the unit-neutral names (`cleared`, a loop's `each`; fix inbox #32),
// never a unit-less number.
test('the landing in testnet units: the counts, the spotlight and the list in tERG, from the unit each read names', async () => {
  const {stats, statsLine, money, tergText, tergRounded} = await import(pathToFileURL(path.join(root, 'public', 'home.js')).href);
  const net = await import(pathToFileURL(path.join(root, 'public', 'network.js')).href);
  for (const n of [0, 1, 999, 1_000_000, 3_000_000, 104_475_000, 121_475_000, 1_500_000_000, 265_665_002, -2_000_000])
    assert.equal(tergText(n), net.tergText(n), `${n}: the landing and /network write tERG alike`);
  // Totals rounded to 0.001 tERG, an IOU to 0.0001: "0.374 tERG", not "0.373823 tERG" (the copy rules).
  assert.deepEqual(money(121_475_000, 'nanoERG'), {n: '0.121', u: 'tERG'});
  assert.deepEqual(money(373_823_000, 'nanoERG'), {n: '0.374', u: 'tERG'});
  assert.deepEqual(money(3_000_000, 'nanoERG'), {n: '0.003', u: 'tERG'});
  assert.deepEqual(money(1_500_000, 'nanoERG', 4), {n: '0.0015', u: 'tERG'});
  assert.equal(tergRounded(1_500_000_000), '1.5');
  assert.equal(tergRounded(2, 4), '<0.0001', 'above zero but too small to show');
  assert.equal(tergRounded(0), '0');
  assert.equal(tergRounded(-2_000_000), '-0.002');
  assert.deepEqual(money(3_000_000, undefined), {n: '–', u: 'tERG'}, 'no unit named: no number');
  assert.deepEqual(money(3, 'PC'), {n: '–', u: 'tERG'}, 'the retired pilot\'s unit: no number, never "credits"');
  assert.deepEqual(money(null, 'nanoERG'), {n: '–', u: 'tERG'});
  const clearing = {unit: 'nanoERG', totals: {setoffs_applied: 47, cleared: 104_475_000, cleared_PC: 104_475_000}};
  // what the loops cut (clearing totals.cleared: the sum of the applied set-offs), not what is outstanding
  assert.equal(statsLine(stats({participants: [{handle: 'a'}], ledger: {unit: 'nanoERG', notes: []}, clearing})),
    '1 agent and 0 open IOUs now. 47 loops cleared so far, cutting 0.104 tERG of IOUs in all.');
  assert.equal(statsLine(stats({})), '– agents and – open IOUs now. – loops cleared so far.');
  assert.equal(stats({clearing: {unit: 'nanoERG', totals: {cleared: 7, cleared_PC: 9}}}).cleared, 7, 'the unit-neutral name first');
  assert.equal(stats({clearing: {totals: {cleared_PC: 9}}, loops: {unit: 'nanoERG', loops: []}}).unit, 'nanoERG', 'the unit from any read');

  // The page itself (home.html and home.js, as a browser starts them) on the testnet's public reads.
  const T = {'/pilot/v1/participants?all=1': [{handle: 'surety-cole', sandbox_only: true}, {handle: 'surety-jun', sandbox_only: true}, {handle: 'sandbox-exact', operator_run: true}],
    '/pilot/v1/ledger': {unit: 'nanoERG', notes: [{issuer_handle: 'surety-cole', recipient_handle: 'sandbox-exact', outstanding: 3_000_000, timestamp: (Math.floor(Date.now() / 1000) - 300) * 1000 + 997}]},
    '/pilot/v1/loops': {unit: 'nanoERG', network: 'valun-testnet-1', loops: [
      {id: 'vs_d6d2970797e2572a', applied_at: new Date(Date.now() - 300e3).toISOString(), amount: 3_000_000, amount_PC: 3_000_000, each: 1_500_000, each_PC: 1_500_000, members: [{handle: 'surety-cole'}, {handle: 'surety-jun'}]},
      {id: 'vs_aa2529efa342fe9a', applied_at: new Date(Date.now() - 7200e3).toISOString(), amount: 4_000_000, amount_PC: 4_000_000, each: 2_000_000, each_PC: 2_000_000, members: [{handle: 'surety-jun'}, {handle: 'surety-cole'}]}]},
    '/pilot/v1/clearing': clearing};
  const body = readBody(pub('home.html')), copied = [];
  const blocks = Object.fromEntries([...pub('home.html').matchAll(/<pre><code id="([^"]+)">([^<]*)<\/code><\/pre>/g)].map(m => [m[1], m[2]]));
  const sky = body.all('canvas').find(e => e.id === 'sky');
  sky.getContext = () => null;                  // no 2D context here: the page draws nothing and goes on
  runNetworkPage(pub('home.js'), body, async p => (T[p] ? {ok: true, status: 200, json: async () => structuredClone(T[p])} : {ok: false, status: 404, json: async () => ({})}),
    {globals: {navigator: {clipboard: {writeText: async t => { copied.push(t); }}}}});
  await settle();
  // The command block is shown whole (wrapped between words only), and Copy copies it exactly as written.
  for (const code of body.querySelectorAll('.cmd pre > code')) {
    assert.ok(code.classList.contains('wrapped'), code.id);
    assert.equal(code.children.map(l => l.textContent).join('\n'), blocks[code.id], code.id);
  }
  for (const b of body.querySelectorAll('button.copy')) b.click();
  await settle();
  assert.deepEqual(copied, [blocks['cmd-agent']]);
  const $ = id => body.all('*').find(e => e.id === id);
  assert.equal($('stats').textContent, '3 agents and 1 open IOU now. 47 loops cleared so far, cutting 0.104 tERG of IOUs in all.');
  assert.equal($('spot').textContent, "sandbox-exact holds surety-cole's IOU for 0.003 tERG.");
  assert.equal($('sky-loop').textContent, 'The newest loop that cleared, with the rainbow ring: surety-cole → surety-jun → surety-cole, 0.0015 tERG off each IOU in it, 5 min ago (its loop card).');
  assert.equal($('sky-loop').querySelector('a').href, '/loop/vs_d6d2970797e2572a');
  assert.deepEqual($('latest').children.map(li => li.querySelector('.amt').textContent), ['0.003 tERG']);
  assert.doesNotMatch(body.textContent, /\bcredits\b|\d\s*credit\b|\d{1,3}(,\d{3})+ (?:credits|tERG)|nanoERG/, 'no nanoERG count named as credits or tERG');
});

test('/favicon.svg and the self-hosted fonts: served with their types; the OFL license texts ship beside them', async () => {
  const fav = await fetch(`${base}/favicon.svg`);
  assert.equal(fav.status, 200);
  assert.equal(fav.headers.get('content-type'), 'image/svg+xml');
  assert.equal(fav.headers.get('x-content-type-options'), 'nosniff');
  const svg = await fav.text();
  assert.equal(svg, pub('favicon.svg'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">/);
  assert.match(svg, /<rect width="100" height="100" rx="22" fill="#050608"\/>/, 'a dark tile, for light tabs');
  assert.match(svg, /<path d="M14 22 L86 22 L50 84 Z"/);
  assert.doesNotMatch(svg, /<script|on[a-z]+=|href=/i);
  for (const f of ['jost-latin.woff2', 'jetbrains-mono-latin-400.woff2']) {
    const r = await fetch(`${base}/fonts/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('content-type'), 'font/woff2', f);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(0, 4).toString('latin1'), 'wOF2', `${f}: a WOFF2 file`);
    assert.deepEqual(b, fs.readFileSync(path.join(root, 'public', 'fonts', f)), f);
  }
  for (const bad of ['/fonts/', '/fonts/OFL-Jost.txt', '/fonts/x.woff2', '/fonts/../home.html']) assert.equal((await fetch(base + bad)).status, 404, bad);
  for (const f of ['OFL-Jost.txt', 'OFL-JetBrainsMono.txt']) assert.match(fs.readFileSync(path.join(root, 'public', 'fonts', f), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, f);
});

// ---------- Host routing ----------
test('valun.tech and www.valun.tech serve the landing at /; every other host (spoofs included) gets the desk console', async () => {
  const landing = pub('home.html'), console_ = pub('index.html');
  for (const host of ['valun.tech', 'www.valun.tech', 'VALUN.TECH', 'valun.tech:443', 'www.valun.tech:8080']) {
    const r = await rawGet('/', host);
    assert.equal(r.status, 200, host);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', host);
    assert.equal(r.text, landing, host);
    assert.equal(r.headers.location, undefined, host);
  }
  assert.equal((await rawGet('/', 'valun.tech', 'HEAD')).status, 200);
  for (const host of ['valun-desk.fly.dev', '127.0.0.1', 'evil.valun.tech', 'valun.tech.example', 'valun.techx', 'xvalun.tech', '']) {
    const r = await rawGet('/', host);
    assert.equal(r.status, 200, host);
    assert.equal(r.text, console_, host);
  }
  // The landing's own files, on every host; /home shows the landing anywhere (a preview of valun.tech's home).
  for (const [route, file, type] of [['/home', 'home.html', 'text/html; charset=utf-8'], ['/home.js', 'home.js', 'text/javascript; charset=utf-8'],
    ['/home.css', 'home.css', 'text/css; charset=utf-8'], ['/loop.css', 'loop.css', 'text/css; charset=utf-8']]) {
    const r = await rawGet(route, 'valun-desk.fly.dev');
    assert.equal(r.status, 200, route);
    assert.equal(r.headers['content-type'], type, route);
    assert.equal(r.text, pub(file), route);
  }
  assert.equal((await rawGet('/network', 'valun.tech')).text, pub('network.html'), '/network on valun.tech is the live view');
});

// ---------- the public read cache ----------
test('burst protection: public reads within 3 s share one computation; a state change or the 3 s end it', async () => {
  assert.equal(PUBLIC_CACHE_MS, 3000);
  const reads0 = trackerReads;
  const burst = await Promise.all(Array.from({length: 12}, () => get('/pilot/v1/ledger')));
  assert.ok(burst.every(r => r.status === 200 && r.text === burst[0].text));
  assert.equal(trackerReads - reads0, 1, 'twelve viewers at once: one tracker read');
  await get('/pilot/v1/ledger');
  assert.equal(trackerReads - reads0, 1, 'a second read right after: still one');
  // Any save (a deal, a join, a set-off applied) bumps the generation: the next read is fresh.
  pilot.save();
  await get('/pilot/v1/ledger');
  assert.equal(trackerReads - reads0, 2, 'after a state change: read again');
  // The other public reads are cached the same way.
  const c0 = routes.cacheStats().computed;
  for (let i = 0; i < 3; i++) for (const p of ['/pilot/v1/info', '/pilot/v1/participants', '/pilot/v1/loops', `/pilot/v1/loops/${L3}`, `/loop/${L3}`]) assert.equal((await get(p)).status, 200, p);
  assert.equal(routes.cacheStats().computed - c0, 5, 'five routes, three reads each: five computations');
  // An authenticated read is never cached (and never served from the cache).
  const before = routes.cacheStats();
  for (let i = 0; i < 3; i++) assert.equal((await getJson('/pilot/v1/me')).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + '/pilot/v1/me', {headers: {authorization: 'Bearer vpa_x'}})).status, 401);
  assert.deepEqual(routes.cacheStats(), before);
});

test('burst protection: an entry expires after 3 s, a failed read is not kept, and publicCacheMs 0 turns the cache off', async () => {
  const realNow = Date.now;
  try {
    pilot.save();
    const reads0 = trackerReads;
    await get('/pilot/v1/ledger');
    Date.now = () => realNow() + PUBLIC_CACHE_MS + 10;
    await get('/pilot/v1/ledger');
    assert.equal(trackerReads - reads0, 2, 'read again after 3 s');
  } finally { Date.now = realNow; }
  // A read that fails is dropped: the next one tries again.
  pilot.save();
  const orig = pilot.basis.allNotes;
  pilot.basis.allNotes = async () => { trackerReads += 1; throw new Error('tracker down'); };
  const r0 = trackerReads;
  assert.equal((await get('/pilot/v1/ledger')).status, 502);
  pilot.basis.allNotes = orig;
  assert.equal((await get('/pilot/v1/ledger')).status, 200);
  assert.equal(trackerReads - r0, 2);
  // Off: with publicCacheMs 0, and by default (the hosted server turns it on: server.mjs).
  assert.match(fs.readFileSync(path.join(root, 'server.mjs'), 'utf8'), /publicCacheMs: .*PILOT_PUBLIC_CACHE_MS.* : PUBLIC_CACHE_MS,/);
  for (const cfg of [{publicCacheMs: 0}, {}]) {
  const off = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000, ...cfg}});
  const s2 = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: off}));
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const r1 = trackerReads;
  for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${s2.address().port}/pilot/v1/ledger`).then(x => x.text());
  assert.equal(trackerReads - r1, 3);
  s2.close();
  }
});

test('the public reads and the loop card count against the per-address read budget', async () => {
  const tight = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000, pilotIpReadLimitPerMinute: 3, publicCacheMs: PUBLIC_CACHE_MS}});
  const s3 = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: tight}));
  await new Promise(r => s3.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${s3.address().port}`;
  const st = [];
  for (const p of ['/pilot/v1/loops', `/loop/${L3}`, `/pilot/v1/loops/${L3}`, `/loop/${L3}`, '/pilot/v1/loops']) st.push((await fetch(at + p).then(async r => { await r.text(); return r.status; })));
  assert.deepEqual(st, [200, 200, 200, 429, 429]);
  s3.close();
});

test('/og.png: the link-preview image is a 1200x630 PNG served with its type; the landing names it with a large-image card', async () => {
  const r = await fetch(`${base}/og.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const b = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1200, 630], 'IHDR width and height');
  const home = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
  assert.match(home, /<meta property="og:image" content="https:\/\/valun\.tech\/og\.png">/);
  assert.match(home, /<meta name="twitter:card" content="summary_large_image">/);
});
