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
  assert.match(r.text, /<p class="eyebrow">Loop cancelled<\/p>/);
  assert.match(r.text, /<h1 class="route"><span class="h">sandbox-mallory<\/span> <span class="arr">→<\/span> <span class="h">ana<\/span> <span class="arr">→<\/span> <span class="h">sandbox-exact<\/span> <span class="arr">→<\/span> <span class="h">sandbox-mallory<\/span><\/h1>/);
  assert.match(r.text, /<svg class="ring"/);
  assert.equal((r.text.match(/<g class="node /g) || []).length, 3);
  assert.equal((r.text.match(/<path class="arc"/g) || []).length, 3);
  assert.match(r.text, /<circle class="rainbow" [^>]*stroke="url\(#loop-rainbow-0\)"/);
  assert.match(r.text, /<dd>3 PC<\/dd>/);
  assert.match(r.text, /3 agents cancelled 3 credits of promises in one round of signatures\. The work stays done\. No money moved\./);
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
  assert.ok(r.text.includes('>&lt;script&gt;alert(&quot;…</text>'), 'the SVG label is escaped and cut');
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
function cspClean(html, {script = null, styles}) {
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], new RegExp(`\\ssrc="${script}"`), 'every script is the page\'s own file');
  if (!script) assert.doesNotMatch(html, /<script\b/i, 'no script at all');
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|javascript:/i, 'no inline style or event handler');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), styles);
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed)\b[^>]*\ssrc="https?:/i, 'no external resource');
}
test('the loop card, its 404 page and the landing keep the CSP', async () => {
  cspClean((await get(`/loop/${L3}`)).text, {styles: ['/loop.css']});
  cspClean((await get(`/loop/${LH}`)).text, {styles: ['/loop.css']});
  cspClean((await get('/loop/nope')).text, {styles: ['/loop.css']});
  const home = pub('home.html');
  cspClean(home, {script: '/home.js', styles: ['/home.css']});
  assert.deepEqual([...home.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]).sort(),
    ['https://github.com/fitzss/hermes-plugin-valun', 'https://github.com/fitzss/hermes-plugin-valun', 'https://github.com/fitzss/valun-open', 'https://github.com/fitzss/valun-open', 'https://github.com/fitzss/valun-open/tree/main/examples/ai-seller',
     'https://valun.tech/'],
    'external URLs are links (and the canonical URL) only');
  const js = pub('home.js');
  assert.deepEqual([...js.matchAll(/getJson\('([^']+)'\)/g)].map(m => m[1]).sort(), ['/pilot/v1/clearing', '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/participants?all=1']);
  assert.doesNotMatch(js, /authorization|bearer|x-valun|localStorage|innerHTML|eval\(/i);
  assert.match(js, /credentials: 'omit'/);
  for (const css of ['home.css', 'loop.css', 'network.css']) {
    assert.doesNotMatch(pub(css), /@import|url\(\s*['"]?https?:/i, `${css}: no external fonts or images`);
    assert.match(pub(css), /color-scheme: dark;/, `${css}: the one dark theme`);
    // the fonts are the page's own files
    assert.deepEqual([...pub(css).matchAll(/url\("([^"]+)"\) format\("woff2"\)/g)].map(m => m[1]), ['/fonts/jost-latin.woff2', '/fonts/jetbrains-mono-latin-400.woff2'], css);
  }
  for (const html of [home, pub('network.html'), (await get(`/loop/${L3}`)).text, (await get('/loop/nope')).text])
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, 'every page links the mark');
});

const SUB = 'AI agents work for each other and pay with signed promises instead of money. A promise can be passed on. When promises form a loop, everyone in it signs once and the loop is cancelled. The work stays done. The debt is gone.';
test('the landing: the headline, the meta tags, the solo and friends commands of the valun 0.4.1 CLI, and its pure parts', async () => {
  const home = pub('home.html');
  assert.match(home, /<h1><span class="h1a">Credit for machines\.<\/span> <span class="h1b">Debts that <span class="settle">cancel out\.<\/span><\/span><\/h1>/);
  assert.ok(home.includes(`<p class="lede">${SUB}</p>`), 'the sub');
  assert.match(home, /<title>Valun: credit for machines<\/title>/);
  assert.equal(meta(home, 'name', 'description'), SUB);
  assert.equal(meta(home, 'property', 'og:title'), 'Credit for machines. Debts that cancel out.');
  assert.equal(meta(home, 'property', 'og:description'), SUB);
  assert.equal(meta(home, 'name', 'twitter:description'), SUB);
  assert.match(home, /<a class="brand" href="\/" aria-label="Valun home">\s*<svg class="mark" viewBox="0 0 100 100" aria-hidden="true">.*?<\/svg>\s*<span class="wordmark">Valun<\/span>/s);
  assert.match(home, /<a class="btn primary" href="#agent">Bring your agent<\/a>/);
  assert.match(home, /<a class="btn" href="#solo">Try it in two minutes<\/a>/);
  // bring your agent: the one line any agent follows (public/skill.md), and the agent links
  assert.equal(/<code id="cmd-agent">([^<]*)<\/code>/.exec(home)[1], 'Read https://valun.tech/skill.md and follow it to join Valun.');
  assert.match(home, /<button type="button" class="copy" data-copy="cmd-agent">Copy<\/button>/);
  for (const href of ['/skill.md', '/llms.txt', '/.well-known/agent-card.json']) assert.ok(home.includes(`href="${href}"`), href);
  assert.match(home, /<canvas id="sky" role="img"/);
  assert.match(home, /Glows are loops that cancelled\./);
  assert.doesNotMatch(home.replace(/<circle\b/g, ''), /circle/i, 'no "circle" in the copy (it reads as the company Circle)');
  // the solo loop
  const cmd = /<code id="cmd-solo">([^<]*)<\/code>/.exec(home)[1].split('\n');
  assert.deepEqual(cmd, ['pipx install valun', 'valun join --sandbox --handle yourname --operator "YOUR NAME"', 'valun sandbox tour']);
  assert.match(home, /<section class="play" id="solo"/);
  assert.match(home, /add <code>--yes<\/code> to let it go on by itself/);
  assert.match(home, /<code>uvx valun join --sandbox …<\/code> then <code>uvx valun sandbox tour<\/code>/);
  // with friends: consent signing turned on, the watcher, the Hermes route
  assert.match(home, /<section class="play" id="friends"/);
  for (const c of ['valun join --sandbox', 'valun mcp', 'valun join', 'hermes -p valun valun join', 'valun config consent_loop on',
    'hermes -p valun config set plugins.entries.valun.settings.process_consents true', 'valun clearing watch --interval 15',
    'hermes -p valun valun consents --process', 'pipx ensurepath']) assert.ok(home.includes(`<code>${c}</code>`), c);
  assert.match(home, /Every member has to sign, and the set-off waits up to 30 minutes\./);
  assert.match(home, /href="\/network"/);
  const {loopPath, ago, stats, statsLine, openPromises, spherePoint, hash32, constellation, REFRESH_MS, TURN_MS} = await import(pathToFileURL(path.join(root, 'public', 'home.js')).href);
  assert.equal(REFRESH_MS, 30_000); assert.equal(TURN_MS, 90_000);
  assert.equal(loopPath({members: [{handle: 'ana'}, {handle: 'bo'}, {handle: 'cyd'}]}), 'ana → bo → cyd → ana');
  assert.equal(ago('2026-11-11T12:00:00Z', Date.parse('2026-11-11T12:05:30Z')), '5 min ago');
  // the constellation's data: points from a stable hash, the open promises, the latest loops
  assert.equal(hash32('ana'), hash32('ana')); assert.notEqual(hash32('ana'), hash32('bo'));
  assert.deepEqual(spherePoint('ana'), spherePoint('ana'));
  for (const h of ['ana', 'bo', 'sandbox-exact', 'x'.repeat(24)]) { const p = spherePoint(h); assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-9, h); }
  const ledger = {notes: [{issuer_handle: 'ana', recipient_handle: 'bo', outstanding: 3}, {issuer_handle: 'bo', recipient_handle: 'cyd', outstanding: 0},
    {issuer_handle: 'cyd', recipient_handle: 'ana', outstanding: 2}]};
  assert.deepEqual(openPromises(ledger), [{from: 'ana', to: 'bo', amount: 3}, {from: 'cyd', to: 'ana', amount: 2}]);
  const participants = [{handle: 'ana'}, {handle: 'bo', sandbox_only: true}, {handle: 'cyd'}, {handle: 'sandbox-exact', operator_run: true}];
  const loops = {loops: [{id: 'vs_0000000000000001', members: [{handle: 'ana'}, {handle: 'bo'}, {handle: 'cyd'}]}, {id: 'vs_0000000000000002', members: [{handle: 'gone'}]}]};
  const sky = constellation({participants, ledger, loops});
  assert.deepEqual(sky.nodes.map(n => [n.handle, n.sandbox]), [['ana', false], ['bo', false], ['cyd', false], ['sandbox-exact', true]]);
  assert.equal(sky.edges.length, 2);
  assert.deepEqual(sky.rings.map(r => [r.id, r.pts.length]), [['vs_0000000000000001', 3]], 'a loop whose members are not points is not drawn');
  assert.deepEqual(constellation({}), {nodes: [], edges: [], rings: []});
  assert.equal(statsLine(stats({participants, ledger, loops, clearing: {totals: {setoffs_applied: 6, cleared_PC: 17}}})),
    '4 agents · 2 open promises · 6 loops cancelled · 17 credits cancelled');
  assert.equal(statsLine(stats({})), '– agents · – open promises · – loops cancelled · – credits cancelled');
  assert.equal(stats({participants: {participants}}).agents, 4);
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
