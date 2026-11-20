// Staging names itself in its agent docs and joins (staging's first-use round of 2026-11-18; lib/staging-docs.mjs; the
// review of PR #8). valun-staging runs the testnet's image, so it served the testnet's skill.md (also /agents.md), /start,
// /home and /network unchanged: they say https://valun.tech, and their joins name no server, so an agent or a person
// that followed them on staging joined the live network, the client's default server. On staging, skill.md names
// staging's origin and opens with how to stay on staging; every join written out on a page or in skill.md names
// staging's server, as the A2A answer's do; /start's and /home's one-line agent prompt read staging's skill.md, and
// /start's lost-join check looks the handle up in staging's directory; llms.txt already named staging. The testnet
// serves every file byte for byte as it is in public/. Each environment runs in a process of its own
// (test/fixtures/staging-pages.mjs), since lib/environment.mjs and lib/pilot/units.mjs read theirs once, at start, with
// the environment fly.staging.toml and fly.testnet.toml set. No tracker.
import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CLIENT_DEFAULTS, NETWORK_INTRO, NETWORK_JOIN, NETWORK_ORIGIN, START_PROMPT, stagingNote, stagingPage, withOrigin, joinsNamingServer} from '../lib/staging-docs.mjs';
import {STAGING_BANNER} from '../lib/environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_ORIGIN = 'https://valun-staging.fly.dev';
const bytes = b64 => Buffer.from(b64, 'base64'), text = b64 => bytes(b64).toString('utf8');
const file = f => fs.readFileSync(path.join(root, 'public', f));
const SKILL = file('skill-testnet.md').toString('utf8'), START = file('start.html').toString('utf8');
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The fixture in a process of its own, on the testnet's network, with `env` added (VALUN_ENVIRONMENT unset otherwise).
function serve(env) {
  const all = {...process.env, PILOT_NETWORK: 'valun-testnet-1'};
  delete all.VALUN_ENVIRONMENT; delete all.VALUN_PUBLIC_ORIGIN;
  Object.assign(all, env);
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'staging-pages.mjs')], {cwd: root, env: all});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`staging-pages.mjs exited ${code}: ${err}`))));
  });
}
let runs;
before(async () => {
  // As fly.staging.toml and fly.testnet.toml set them.
  const [staging, testnet] = await Promise.all([serve({VALUN_ENVIRONMENT: 'staging', VALUN_PUBLIC_ORIGIN: STAGING_ORIGIN}), serve({VALUN_PUBLIC_ORIGIN: NETWORK_ORIGIN})]);
  runs = {staging, testnet};
});
const fileOf = (run, route) => run.files.find(f => f.route === route);
const pageOf = (run, route) => run.pages.find(p => p.route === route && !p.host);
// A section of skill.md's text, from one heading to the next.
const sectionOf = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to));
// skill.md's MCP join line (section 1, the block for an MCP app), as the A2A answer gives it (test/a2a.test.mjs).
const mcpLines = s => /```\n([\s\S]*?)\n```/.exec(sectionOf(s, '### Claude Code, Codex, Cursor, Claude Desktop, or any MCP app', '### Any agent with a shell'))[1].split('\n');
// The Hermes join line (section 1, Hermes Agent's block).
const hermesJoin = s => sectionOf(s, '### Hermes Agent', '### Claude Code, Codex').split('\n').find(l => l.startsWith('hermes -p valun valun join '));
// What `join --sandbox` (and the Hermes join's `--direct-tools`) becomes on staging, written out here: the A2A answer's
// lines put --server right there (lib/a2a.mjs, serverFlag).
const named = s => s.replace(/join --sandbox( --direct-tools)?/g, m => `${m} --server ${STAGING_ORIGIN}`);
// Every join written out in a text: [the join and what follows it on its line].
const joinsIn = s => [...s.matchAll(/join --sandbox[^\n<]*/g)].map(m => m[0]);

test('the testnet serves skill.md and agents.md byte for byte as public/skill-testnet.md, and /start, /start/, /home and /network as their files; its A2A join lines name no server', () => {
  const t = runs.testnet;
  assert.deepEqual([t.environment, t.origin], [null, NETWORK_ORIGIN]);
  for (const route of ['/skill.md', '/agents.md']) {
    const f = fileOf(t, route);
    assert.deepEqual([f.status, f.type], [200, 'text/markdown; charset=utf-8'], route);
    assert.ok(bytes(f.body).equals(file('skill-testnet.md')), `${route}: the same bytes as public/skill-testnet.md`);
  }
  // Each route fetched itself (the review of PR #8, code F5: /start/ was never fetched).
  for (const [route, f] of [['/start', 'start.html'], ['/start/', 'start.html'], ['/home', 'home.html'], ['/network', 'network.html']]) {
    const p = pageOf(t, route);
    assert.ok(p, `${route}: fetched`);
    assert.ok(bytes(p.body).equals(file(f)), `${route}: the same bytes as public/${f}`);
  }
  assert.ok(START.includes(`<code id="cmd-skill">${START_PROMPT}</code>`), "/start's one-line prompt, as staging rewrites it");
  assert.ok(file('home.html').toString('utf8').includes(`<code id="cmd-agent">${START_PROMPT}</code>`), "/home's, the same");
  assert.equal(t.a2a.data.one_line, START_PROMPT, 'the A2A one line is /start\'s');
  assert.equal(t.a2a.data.mcp[0], mcpLines(SKILL)[0], 'the A2A MCP join is skill.md\'s');
  assert.doesNotMatch(JSON.stringify(t.a2a), /--server|valun-staging|This is staging/);
  // No join on the testnet's pages and files names a server.
  for (const p of t.pages) for (const j of joinsIn(text(p.body))) assert.doesNotMatch(j, /--server/, `${p.route}: ${j}`);
  for (const j of joinsIn(text(fileOf(t, '/skill.md').body))) assert.doesNotMatch(j, /--server/, j);
});

test('staging: skill.md and agents.md open with the staging note after the front matter, name staging everywhere but where they say what the client\'s default server is, and every join in them names staging\'s server', () => {
  const s = runs.staging;
  assert.deepEqual([s.environment, s.origin], ['staging', STAGING_ORIGIN]);
  // Each sentence about the client's own default server, and the first words about where this is, are in skill.md word
  // for word (else update lib/staging-docs.mjs).
  for (const x of [...CLIENT_DEFAULTS, NETWORK_INTRO]) assert.equal(SKILL.split(x).length, 2, `skill-testnet.md says, once: ${x}`);
  const front = /^---\n[\s\S]*?\n---\n/.exec(SKILL)[0];
  // What staging serves, built here without the module's code: the note, then every https://valun.tech as staging's
  // origin, but for the client's default, the first words saying it is a staging copy, and the joins naming staging.
  const rest = SKILL.slice(front.length).replace(NETWORK_INTRO, `This is a staging copy of the Valun network, at ${STAGING_ORIGIN}`).split(CLIENT_DEFAULTS[0])
    .map(a => a.split(CLIENT_DEFAULTS[1]).map(b => b.replaceAll(NETWORK_ORIGIN, STAGING_ORIGIN)).join(CLIENT_DEFAULTS[1])).join(CLIENT_DEFAULTS[0]);
  const want = `${front}\n${stagingNote(STAGING_ORIGIN)}${named(rest)}`;
  for (const route of ['/skill.md', '/agents.md']) {
    const f = fileOf(s, route), got = text(f.body);
    assert.deepEqual([f.status, f.type], [200, 'text/markdown; charset=utf-8'], route);
    assert.equal(got, want, route);
    assert.ok(got.startsWith(`${front}\n> **Staging, not the Valun network.**`), `${route}: the front matter first, then the note`);
    // valun.tech is left only where the note names the live network and where skill.md says what the client's default is.
    assert.equal(got.split(NETWORK_ORIGIN).length - 1, 1 + CLIENT_DEFAULTS.length, route);
    assert.ok(got.split(STAGING_ORIGIN).length > 40, `${route}: its links name staging`);
    // Its seven joins (the quickstart's, Hermes, the MCP app's, the shell's two, and the two of section 2's "Try both
    // sides": the newcomer run of Nov 18, findings 1 and 8) each name staging's server, and nothing else changes in them:
    // they are skill.md's lines with the flag.
    const joins = joinsIn(got);
    assert.equal(joins.length, 7, `${route}: ${joins}`);
    for (const j of joins) assert.match(j, new RegExp(`^join --sandbox( --direct-tools)? --server ${re(STAGING_ORIGIN)} `), `${route}: ${j}`);
    assert.deepEqual(joins, joinsIn(SKILL).map(named), route);
  }
  // The note, word for word: every join below names staging, a profile keeps the server it joined, and what a join
  // without it reaches (valun 0.7.1 cli.py: cmd_join stores the server; _server: --server, else the profile's server,
  // else VALUN_SERVER, else https://valun.tech; the Hermes plugin 0.7.1 stores server_url the same way). call and mcp
  // take no --server.
  assert.equal(stagingNote(STAGING_ORIGIN), `> **Staging, not the Valun network.** This file is served by ${STAGING_ORIGIN}, a test copy of Valun for checking changes before they go live: its participants, notes and tracker are its own, and the links below name it. Every join below names it (\`--server ${STAGING_ORIGIN}\`), and a profile keeps the server it joined, so the commands after the join need no \`--server\`. A join without it, in a profile that has joined nowhere yet, reaches the client's default server: the live network at https://valun.tech (the valun client takes \`VALUN_SERVER\` first, when it is set). \`valun call\` and \`valun mcp\` take no \`--server\`: they use the server their profile joined.\n`);
  // llms.txt names staging too, as before.
  assert.match(text(fileOf(s, '/llms.txt').body), new RegExp(`To join, an agent reads ${re(STAGING_ORIGIN)}/skill\\.md and follows it\\.`));
});

test('staging: every join written out on its pages names staging\'s server (/start\'s five, /network\'s, the maintainers page\'s Hermes join); /start\'s and /home\'s prompts read staging\'s skill.md; /start\'s lost-join check looks the handle up in staging\'s directory', () => {
  const s = runs.staging, at = ` --server ${STAGING_ORIGIN}`;
  // A page's words (its tags dropped, as a Copy button copies a code block's text), and the join commands in them: a
  // join with its arguments (the console's two mentions of `valun join --sandbox`, as the name of the self-serve join,
  // are no command to copy).
  const wordsOf = h => h.replace(/<[^>]+>/g, ''), commandsIn = s => joinsIn(s).filter(j => j.includes('--handle '));
  let total = 0;
  // The server's own pages: the files of public/ and the maintainers page (an agent page keeps what its participant
  // wrote: the next test).
  for (const p of s.pages.filter(q => q.file || q.route === '/maintainers')) {
    const body = text(p.body);
    for (const j of commandsIn(wordsOf(body))) { total++; assert.ok(j.startsWith('join --sandbox --server ') || j.startsWith('join --sandbox --direct-tools --server '), `${p.route}: ${j}`); assert.ok(j.includes(at), `${p.route}: ${j}`); }
  }
  const count = route => commandsIn(wordsOf(text(pageOf(s, route).body))).length;
  assert.deepEqual([count('/start'), count('/start/'), count('/network'), count('/maintainers')], [5, 5, 1, 1], 'the joins counted');
  assert.ok(total >= 12, `${total} joins`);
  // Each copyable join of /start, as its Copy button copies it (the text of its <code>).
  const start = text(pageOf(s, '/start').body), net = text(pageOf(s, '/network').body);
  for (const id of ['cmd-mcp', 'cmd-tour', 'cmd-guarantee', 'cmd-pilot']) {
    const code = new RegExp(`<code id="${id}">([\\s\\S]*?)</code>`).exec(start)[1];
    assert.match(wordsOf(code), new RegExp(`valun (--profile \\S+ )?join --sandbox${re(at)} --handle `), id);
  }
  assert.match(wordsOf(start), new RegExp(`hermes -p valun valun join --sandbox --direct-tools${re(at)} --handle `), 'the Hermes join');
  assert.match(wordsOf(/<code id="join-cmd">([\s\S]*?)<\/code>/.exec(net)[1]), new RegExp(`^uvx --from valun==0\\.7\\.3 valun join --sandbox${re(at)} --handle YOUR-HANDLE `), "/network's");
  // The prompts and the lost-join check.
  assert.ok(start.includes(`<code id="cmd-skill">Read ${STAGING_ORIGIN}/skill.md and follow it to join Valun.</code>`));
  assert.ok(text(pageOf(s, '/home').body).includes(`<code id="cmd-agent">Read ${STAGING_ORIGIN}/skill.md and follow it to join Valun.</code>`));
  assert.ok(start.includes(`<code>${STAGING_ORIGIN}/<wbr>pilot/<wbr>v1/<wbr>participants?q=YOUR-HANDLE</code>`), 'the lost-join check');
  assert.doesNotMatch(start, /https:\/\/valun\.tech\/<wbr>pilot\/<wbr>v1\/<wbr>participants/);
  // Otherwise each page is the testnet's file, with the banner (test/staging-banner.unit.test.mjs checks every page).
  const page = START.replace(START_PROMPT, `Read ${STAGING_ORIGIN}/skill.md and follow it to join Valun.`)
    .replace('https://valun.tech/<wbr>pilot/<wbr>v1/<wbr>participants?q=YOUR-HANDLE', `${STAGING_ORIGIN}/<wbr>pilot/<wbr>v1/<wbr>participants?q=YOUR-HANDLE`);
  const want = named(page), bodyAt = /<body\b[^>]*>/i.exec(want);
  for (const route of ['/start', '/start/']) assert.equal(text(pageOf(s, route).body), `${want.slice(0, bodyAt.index + bodyAt[0].length)}\n${STAGING_BANNER}${want.slice(bodyAt.index + bodyAt[0].length)}`, route);
});

// The review of PR #9, code 1: staging rewrote every HTML body, so an agent's own about, services or display name that
// quoted a join or /start's prompt was served with `--server <staging>` inserted, or with the prompt pointed at staging,
// in its page and in its description. Only the server's own pages change now (lib/http.mjs ownPage); what a participant
// wrote is served as written, as the testnet serves it.
test('staging: an agent page shows what its participant wrote as written, a join and /start\'s prompt in it included, in its text and its description', () => {
  const q = runs.staging.quoted, esc = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  assert.deepEqual(q, runs.testnet.quoted);
  assert.ok(q.about.includes(START_PROMPT) && q.about.includes('join --sandbox --handle') && q.services.includes('join --sandbox --direct-tools'), 'it quotes them');
  for (const [name, run] of Object.entries(runs)) {
    const page = text(pageOf(run, '/agent/quote-bot').body);
    assert.ok(page.includes(`<p class="more">${esc(q.display_name)}</p>`), `${name}: the display name as written`);
    assert.ok(page.includes(`<p class="lede">${esc(q.about)}</p>`), `${name}: the about as written`);
    assert.ok(page.includes(`<p class="offers">${esc(q.services)}</p>`), `${name}: the services as written`);
    assert.ok(page.includes(`<meta name="description" content="${esc(`quote-bot is an agent on Valun, where agents work for each other and pay with signed promises. ${q.services}`)}">`), `${name}: the description`);
    assert.doesNotMatch(page, /--server/, `${name}: no server named in what it wrote`);
  }
  // The server's own words on that page name staging's origin already (PUBLIC_ORIGIN), on staging only.
  assert.ok(text(pageOf(runs.staging, '/agent/quote-bot').body).includes(`Read ${STAGING_ORIGIN}/skill.md, join Valun, and offer quote-bot a job.`));
  assert.ok(text(pageOf(runs.testnet, '/agent/quote-bot').body).includes(`Read ${NETWORK_ORIGIN}/skill.md, join Valun, and offer quote-bot a job.`));
});

test('staging: the A2A join answer names staging\'s server in every command that takes --server, and its joins are staging\'s skill.md\'s', () => {
  const {text: said, data} = runs.staging.a2a, at = ` --server ${STAGING_ORIGIN}`, skill = text(fileOf(runs.staging, '/skill.md').body);
  assert.equal(data.instructions, `${STAGING_ORIGIN}/skill.md`);
  assert.equal(data.one_line, `Read ${STAGING_ORIGIN}/skill.md and follow it to join Valun.`, '/start\'s prompt, as staging serves it');
  // The very lines staging's skill.md gives (lib/staging-docs.mjs serverFlag puts the flag where lib/a2a.mjs does).
  assert.deepEqual(data.mcp, mcpLines(skill));
  assert.match(data.mcp[0], new RegExp(`^uvx --from valun==0\\.7\\.3 valun join --sandbox --server ${re(STAGING_ORIGIN)} --handle YOUR-HANDLE .* --approvals console$`));
  assert.equal(data.hermes[2], hermesJoin(skill), "staging's skill.md's Hermes join");
  assert.equal(data.shell[0], named(runs.testnet.a2a.data.shell[0]));
  assert.equal(data.hermes[2], named(runs.testnet.a2a.data.hermes[2]));
  assert.deepEqual(data.keep_signing, ['uvx --from valun==0.7.3 valun call valun_inbox', `uvx --from valun==0.7.3 valun clearing watch${at}`]);
  // valun call and valun mcp take no --server (valun 0.7.1 cli.py): those lines are the testnet's.
  assert.deepEqual([data.shell[1], data.mcp[1]], [runs.testnet.a2a.data.shell[1], runs.testnet.a2a.data.mcp[1]]);
  // What a join without --server reaches, as staging's skill.md note says it (valun 0.7.1 cli.py _server: --server, else
  // the profile's server, else VALUN_SERVER, else the default; the review of PR #8, code F2).
  assert.ok(said.startsWith(`This is staging, a test copy of Valun, not the network: every valun command below that takes --server names ${STAGING_ORIGIN}. Without it, a join in a profile that has joined nowhere yet reaches the client's default server, the live network at https://valun.tech (the valun client takes VALUN_SERVER first, when it is set). valun call and valun mcp take no --server: they use the server their profile joined.\nTo join Valun, an agent reads ${STAGING_ORIGIN}/skill.md and follows it`), said.slice(0, 600));
  assert.ok(stagingNote(STAGING_ORIGIN).includes("A join without it, in a profile that has joined nowhere yet, reaches the client's default server: the live network at https://valun.tech (the valun client takes `VALUN_SERVER` first, when it is set)."), 'the same as the note');
  // Every join in the text names staging's server.
  for (const m of said.matchAll(/valun join --sandbox[^\n]*?(?=--handle)/g)) assert.ok(m[0].includes(at), m[0]);
  assert.ok(said.includes(`${STAGING_ORIGIN}/pilot#owner`));
});

// The review of PR #8, code F5: a HEAD to each route staging serves its own way gets what its GET gets (status, type,
// CSP, cache and length) and no body; on the testnet too.
test('a HEAD to skill.md, agents.md, /start, /start/, /home and /network answers as its GET does, with no body, on staging and on the testnet', () => {
  for (const [name, run] of Object.entries(runs)) {
    assert.deepEqual(run.heads.map(h => h.route), ['/skill.md', '/agents.md', '/start', '/start/', '/home', '/network'], name);
    for (const {route, head, get} of run.heads) {
      assert.equal(get.status, 200, `${name} ${route}`);
      assert.deepEqual({...head, bytes: undefined}, {...get, bytes: undefined}, `${name} ${route}: the GET's status and headers`);
      assert.equal(head.bytes, 0, `${name} ${route}: no body`);
      assert.equal(Number(get.length), get.bytes, `${name} ${route}: the length of the GET's body`);
    }
  }
  // The staging routes' own bodies are the ones measured: staging's /start is longer than the testnet's by what it adds.
  const len = (run, route) => Number(run.heads.find(h => h.route === route).get.length);
  assert.ok(len(runs.staging, '/start') > len(runs.testnet, '/start'));
  assert.equal(len(runs.staging, '/start'), len(runs.staging, '/start/'));
});

// The review of PR #8, code F7: the origin is matched as a whole host, so a longer host is never rewritten; a join that
// names a server already is left as it is.
test('withOrigin matches https://valun.tech as a whole host only; joinsNamingServer adds the flag once, where the A2A answer has it', () => {
  const S = STAGING_ORIGIN;
  for (const [from, to] of [
    ['https://valun.tech/x', `${S}/x`], ['https://valun.tech', S], ['see https://valun.tech.', `see ${S}.`], ['(https://valun.tech)', `(${S})`],
    ['https://valun.tech:8443/a', `${S}:8443/a`], ['`https://valun.tech`', `\`${S}\``], ['https://valun.tech?q=1 and https://valun.tech#x', `${S}?q=1 and ${S}#x`],
    ['https://valun.technology/x', 'https://valun.technology/x'], ['https://valun.tech.example/x', 'https://valun.tech.example/x'],
    ['https://valun.tech-x.example/', 'https://valun.tech-x.example/'], ['https://valun.tech_x/', 'https://valun.tech_x/'],
    ['http://valun.tech/x https://www.valun.tech/x', 'http://valun.tech/x https://www.valun.tech/x']]) assert.equal(withOrigin(from, S), to, from);
  for (const [from, to] of [
    ['valun join --sandbox --handle h', `valun join --sandbox --server ${S} --handle h`],
    ['valun join --sandbox --direct-tools --handle h', `valun join --sandbox --direct-tools --server ${S} --handle h`],
    [`valun join --sandbox --server ${S} --handle h`, `valun join --sandbox --server ${S} --handle h`],
    [`valun join --sandbox --direct-tools --server ${S} --handle h`, `valun join --sandbox --direct-tools --server ${S} --handle h`],
    ['`valun join --sandbox`', `\`valun join --sandbox --server ${S}\``], ['rejoin --sandbox', 'rejoin --sandbox'],
    ['valun join --handle h', 'valun join --handle h'],
    // A flag ends where its word ends (the review of PR #9, code 2-5): a longer word is no join to name a server in.
    ['valun join --sandboxed', 'valun join --sandboxed'], ['join --sandbox-x', 'join --sandbox-x'], ['join --sandbox_x', 'join --sandbox_x'],
    ['join --sandbox --direct-tools-x', 'join --sandbox --direct-tools-x'], ['join --sandbox.', `join --sandbox --server ${S}.`],
    ['join --sandbox --direct-tools.', `join --sandbox --direct-tools --server ${S}.`]]) assert.equal(joinsNamingServer(from, S), to, from);
  assert.equal(joinsNamingServer(joinsNamingServer('valun join --sandbox x', S), S), `valun join --sandbox --server ${S} x`, 'once');
  // stagingPage too adds each flag once (code 2-5: a second pass gave /network's join a second --server span), on every
  // page it rewrites and on /network's join alone.
  assert.equal(stagingPage(stagingPage(NETWORK_JOIN, S), S), `${NETWORK_JOIN} <span>--server ${S}</span>`);
  for (const f of ['start.html', 'network.html', 'home.html']) {
    const once = stagingPage(file(f).toString('utf8'), S);
    assert.equal(stagingPage(once, S), once, f);
  }
});

// The review of PR #9, code 2-4: staging rewrites only the server's own HTML pages (lib/http.mjs ownPage runs on the
// HTML files of public/ alone), so every other file it serves is that file byte for byte, on staging as on the testnet:
// a rewrite would turn the preview image and the fonts into text and corrupt them.
test('staging and the testnet serve every other file of public/ byte for byte: the scripts, styles, the attacks report, the preview image, the mark and the fonts', () => {
  for (const [name, run] of Object.entries(runs)) {
    assert.equal(run.assets.length, 24, name);
    for (const a of run.assets) {
      assert.equal(a.status, 200, `${name} ${a.route}`);
      assert.ok(bytes(a.body).equals(file(a.file)), `${name} ${a.route}: the bytes of public/${a.file}`);
      assert.equal(Number(a.length), file(a.file).length, `${name} ${a.route}: its length`);
    }
    assert.deepEqual(run.assets.filter(a => /\.(png|woff2)$/.test(a.file)).map(a => [a.route, a.type]),
      [['/og.png', 'image/png'], ['/fonts/jost-latin.woff2', 'font/woff2'], ['/fonts/jetbrains-mono-latin-400.woff2', 'font/woff2']], name);
  }
});
