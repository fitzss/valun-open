// R-2 (fix inbox #155: the local-readiness audit of Nov 18, FB-2, the page half of FB-7, SRV-14, SRV-15): a local
// server's own pages for people. It served the public network's pages byte for byte under its banner
// (test/local-mode.unit.test.mjs pinned that), so the landing's and /start's Copy blocks said "Read
// https://valun.tech/skill.md", /start, /network, /pilot, /maintainers and /trust gave joins and owner commands with no
// profile and no server (they joined, or sent a local owner token to, the public testnet: the client's default server),
// their canonical and og tags named valun.tech, and /trust's check read the public network's chain and explorer.
// Now (lib/local-pages.mjs, lib/http.mjs): every page a local server serves, and its owner console's script, gives
// nothing to copy or follow that names a public host, and every valun command on it runs in the profile local and names
// this server where it takes --server (the rules of the image's own check: test/fixtures/local-copyable.mjs); its
// prompts read this server's skill.md and its commands are that skill.md's; canonical and og tags name this server; what
// needs the chain is marked; /start is this server's own (public/start-local.html); and nothing else changes, nor
// anything at all off a local server. Each setting runs in a process of its own (test/fixtures/staging-pages.mjs). No
// tracker.
process.env.PILOT_NETWORK = 'valun-pilot-1';
delete process.env.VALUN_ENVIRONMENT;
delete process.env.VALUN_PUBLIC_ORIGIN;
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pageProblems, pageCommands, pageParts, scriptProblems, scriptCommands, snippetProblems, textOf} from './fixtures/local-copyable.mjs';
import {readBody, Element} from './network-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {LOCAL_EDITS, LOCAL_FILES, LOCAL_TOKEN_FILE, applyEdits, localPage} = await import('../lib/local-pages.mjs');
const {localBanner, withBanner} = await import('../lib/environment.mjs');
const ORIGIN = 'http://127.0.0.1:8080', OTHER = 'http://127.0.0.1:9000';
const text = b64 => Buffer.from(b64, 'base64').toString('utf8');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k) && k !== 'PORT'));
const named = p => `${p.host ?? ''}${p.route}${p.pilot ? '' : ' (no pilot)'}`;

function serve(env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'staging-pages.mjs')], {cwd: root, env: {...clean(), PORT: '8080', ...env}});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`staging-pages.mjs exited ${code}: ${err}`))));
  });
}
let runs;
before(async () => {
  const [local, other, pilot, testnet] = await Promise.all([serve({VALUN_ENVIRONMENT: 'local'}), serve({VALUN_ENVIRONMENT: 'local', VALUN_PUBLIC_ORIGIN: OTHER}),
    serve({}), serve({PILOT_NETWORK: 'valun-testnet-1', VALUN_PUBLIC_ORIGIN: 'https://valun.tech'})]);
  runs = {local, other, pilot, testnet};
});
const locals = () => [runs.local, runs.other];
const pageOf = (run, route) => run.pages.find(p => p.route === route && !p.host && p.pilot);
const asset = (run, f) => run.assets.find(a => a.file === f);
const fileOf = (run, route) => text(run.files.find(f => f.route === route).body);
// The element with id `id` in `html`, from its opening tag to its own closing tag.
function part(html, id) {
  const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\sid="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'g');
  tag.lastIndex = open.index + open[0].length;
  for (let depth = 1, m; (m = tag.exec(html));) if (!(depth += m[1] ? -1 : 1)) return html.slice(open.index, m.index + m[0].length);
  return null;
}
// skill.md's agent placeholders as the pages for people write them (the person reading is the operator).
const forPeople = s => s.replaceAll('"YOUR HUMAN"', '"YOUR NAME"').replaceAll('what you offer, in one line', 'what it offers, in one line');
// This server's skill.md's command blocks, as served: [the MCP app's two lines, the shell agent's two].
// skill.md's MCP app block and shell block (the fenced block after each one's lead-in, as test/local-a2a.unit.test.mjs
// reads them: the skill has other blocks too, Hermes's among them).
const skillBlocks = run => ['**Claude Code, Codex, Cursor, or any MCP app.**', '**Any agent with a shell.**'].map(marker => {
  const skill = fileOf(run, '/skill.md');
  return /```\n([\s\S]*?)\n```/.exec(skill.slice(skill.indexOf(marker)))[1].split('\n');
});

test('R-2: every page a local server serves, and its owner console\'s script, gives nothing to copy or follow that names a public host; every valun command runs in the profile local and names this server where it takes --server', () => {
  for (const run of locals()) {
    assert.equal(run.environment, 'local');
    let commands = 0;
    for (const p of run.pages) {
      assert.equal(p.status, ['/loop/vs_0000000000000001', '/agent/nobody'].includes(p.route) ? 404 : 200, named(p));
      const html = text(p.body);
      assert.deepEqual(pageProblems(html, run.origin), [], `${named(p)} at ${run.origin}`);
      commands += pageCommands(html).length;
    }
    assert.ok(commands >= 40, `${commands} commands checked at ${run.origin}`);
    const js = text(asset(run, 'pilot.js').body);
    assert.deepEqual(scriptProblems(js, run.origin), [], `pilot.js at ${run.origin}`);
    assert.equal(scriptCommands(js).filter(c => /^valun /.test(c)).length, 4, 'the console\'s four commands (attempts resolve, list twice, card)');
  }
  // The same rules catch what the public network's pages hand out (the pages as a server off local mode serves them):
  // the check would have failed on every page the audit named (FB-2), and on the console's script.
  const at = route => pageProblems(text(pageOf(runs.pilot, route).body), ORIGIN);
  assert.ok(at('/home').includes('names valun.tech: Read https://valun.tech/skill.md and follow it to join Valun.'), at('/home').join('\n'));
  assert.ok(at('/start').some(x => /^no --profile: valun join --sandbox /.test(x)), '/start');
  assert.ok(at('/network').some(x => x.startsWith(`no --server ${ORIGIN}: valun join --sandbox`)), at('/network').join('\n'));
  assert.ok(at('/pilot').includes('no --profile: valun config approvals ask'), at('/pilot').join('\n'));
  assert.ok(at('/trust').some(x => x.startsWith('names api-testnet.ergoplatform.com')), '/trust');
  assert.ok(at('/maintainers').some(x => x.startsWith('offers the Claude Code plugin')), '/maintainers');
  assert.ok(at('/maintainers').includes('a https://valun.tech/agent/house-reviewer (valun.tech)'), '/maintainers links the public house agent');
  for (const [route, self] of [['/home', '/'], ['/network', '/network'], ['/trust', '/trust'], ['/memory', '/memory']]) {
    assert.ok(at(route).includes(`canonical https://valun.tech${self} (valun.tech)`), route);
  }
  assert.ok(scriptProblems(pub('pilot.js'), ORIGIN).includes('no --profile: valun card ARG'), 'pilot.js as it is');
  // And the rules themselves: a mention is no command; a command needs a local profile and this server.
  assert.deepEqual(snippetProblems('valun mcp', ORIGIN, {inline: true}), []);
  assert.deepEqual(snippetProblems('valun --profile local doctor', ORIGIN), [`no --server ${ORIGIN}: valun --profile local doctor`]);
  assert.deepEqual(snippetProblems('valun --profile default doctor --server http://127.0.0.1:8080', ORIGIN), ['not a local profile (default): valun --profile default doctor --server http://127.0.0.1:8080']);
  assert.deepEqual(snippetProblems('{"mcpServers": {"v": {"command": "uvx", "args": ["--from", "valun==0.7.1", "valun", "mcp"]}}}', ORIGIN), ['no --profile: valun mcp']);
  assert.deepEqual(snippetProblems('hermes -p x valun join --sandbox --handle h', ORIGIN), ['a Hermes join with no --server: hermes -p x valun join --sandbox --handle h']);
});

test('R-2: each of the server\'s own pages is the public network\'s page with its local edits and the banner, and nothing else changes; a page that lost an edit\'s text fails loudly', () => {
  const own = p => p.file || p.route === '/maintainers';
  for (const run of locals()) {
    const banner = localBanner(run.origin);
    for (const p of run.pages) {
      const page = text(p.page), body = text(p.body), name = p.file ?? (p.route === '/maintainers' ? 'maintainers' : null);
      if (own(p)) {
        assert.ok(LOCAL_FILES.has(name), `${named(p)}: ${name} has local edits`);
        const want = localPage(name, page, run.origin);
        assert.notEqual(want, page, `${named(p)}: a local server changes it`);
        assert.equal(body, withBanner(want, banner), `${named(p)}: the page with its edits, then the banner after <body>, and nothing else`);
      } else {
        // An agent page or a loop card (and their 404s) shows what participants wrote: no edit, only the banner.
        assert.equal(body, withBanner(page, banner), `${named(p)}: as rendered, with the banner`);
      }
    }
  }
  // Every page and file with edits is one a local server serves (public/ or the maintainers page).
  assert.deepEqual([...LOCAL_FILES].sort(), ['home.html', 'maintainers', 'memory.html', 'network.html', 'pilot.html', 'pilot.js', 'start-local.html', 'trust.html']);
  for (const f of LOCAL_FILES) if (f !== 'maintainers') assert.ok(fs.existsSync(path.join(root, 'public', f)), f);
  // An edit whose text is gone, or there more often than it says, stops the page instead of serving it half local.
  const home = pub('home.html'), edits = LOCAL_EDITS['home.html'](ORIGIN);
  assert.throws(() => applyEdits('home.html', home.replace('<code id="cmd-agent">Read https://valun.tech/skill.md', '<code id="cmd-agent">Read it'), edits),
    /lib\/local-pages\.mjs: home\.html: "<code id="cmd-agent">Read https:\/\/valun\.tech\/skill\.md[^"]*" is there 0 times, not 1/);
  assert.throws(() => applyEdits('home.html', `${home}<p class="who">Fitz Doud, who runs valun.tech.</p>`, edits), /is there 2 times, not 1/);
  assert.throws(() => applyEdits('home.html', home.replace(/https:\/\/valun\.tech\/loop\/vs_4f8d53475c9e591a/, '/x'), edits), /3 matches of .*, not 4/);
  // The same page with Windows line ends (a Windows checkout) gets the same edits, with its own line ends kept.
  const crlf = s => s.replace(/\r?\n/g, '\r\n');
  for (const f of ['home.html', 'pilot.html', 'trust.html', 'network.html']) {
    const lf = applyEdits(f, pub(f), LOCAL_EDITS[f](ORIGIN));
    assert.equal(applyEdits(f, crlf(pub(f)), LOCAL_EDITS[f](ORIGIN)), crlf(lf), `${f} with \\r\\n`);
  }
  // A file with no edits goes as it is, the same bytes (a Buffer stays one).
  const png = fs.readFileSync(path.join(root, 'public', 'og.png'));
  assert.equal(localPage('og.png', png, ORIGIN), png);
});

test('R-2: the prompts read this server\'s skill.md, and the commands for people are its skill.md\'s: the joins, the MCP lines, keep signing, the owner token file', () => {
  for (const run of locals()) {
    const o = run.origin, [mcp, shell] = skillBlocks(run), prompt = `Read ${o}/skill.md and follow it to join Valun.`;
    const home = text(pageOf(run, '/home').body), start = text(pageOf(run, '/start').body), net = text(pageOf(run, '/network').body);
    const maint = text(pageOf(run, '/maintainers').body), pilot = text(pageOf(run, '/pilot').body);
    assert.equal(textOf(part(home, 'cmd-agent')), prompt, '/home\'s prompt');
    assert.equal(textOf(part(text(pageOf(run, '/').body), 'cmd-agent')), prompt, '/\'s prompt');
    assert.equal(textOf(part(start, 'cmd-skill')), prompt, '/start\'s prompt');
    // skill.md's own lines (with the placeholders a person reads), word for word.
    assert.equal(mcp.length, 2); assert.equal(shell.length, 2);
    assert.deepEqual(textOf(part(start, 'cmd-mcp')).split('\n'), mcp.map(forPeople), '/start: the MCP app\'s join and claude mcp add');
    assert.deepEqual(textOf(part(start, 'cmd-shell')).split('\n'), shell.map(forPeople), '/start: the shell agent\'s join and status');
    assert.equal(textOf(part(net, 'join-cmd')), forPeople(shell[0]), '/network\'s join');
    assert.ok(maint.includes(`<code>${mcp[1]}</code>`), '/maintainers: skill.md\'s claude mcp add');
    // Keep signing from a shell: skill.md's two commands.
    const skill = fileOf(run, '/skill.md'), signing = pageParts(part(start, 'shell-signing')).code;
    assert.deepEqual(signing, [`uvx --from valun==0.7.1 valun --profile local call valun_inbox`, `uvx --from valun==0.7.1 valun --profile local clearing watch --server ${o}`]);
    for (const c of signing) assert.ok(skill.includes(c), c);
    // The owner token file a local join writes, wherever a page names one; never the public network's.
    for (const p of run.pages.filter(q => q.file || q.route === '/maintainers')) assert.doesNotMatch(text(p.body), /(?<!local-)owner-token-(?:<\/span>|YOUR|SECOND)/, named(p));
    assert.equal((pilot.match(/valun-local-owner-token-<\/span>/g) ?? []).length, 2, '/pilot: sign-in and guide');
    assert.ok(pilot.includes(`valun --profile local config approvals ask --server ${o} --owner-token-file "${LOCAL_TOKEN_FILE}"`), '/pilot: the owner\'s own command names this server');
    assert.ok(home.includes('<span class="nw">valun-local-owner-token-</span>'), '/home');
    assert.ok(net.includes('valun-local-owner-token-YOUR-HANDLE.txt'), '/network');
    // The A2A answer, the start page and skill.md agree on Hermes: a profile of its own that names this server.
    assert.ok(start.includes(`hermes -p valun-local valun join --sandbox --direct-tools --server ${o} --handle YOUR-HANDLE`), '/start: Hermes');
    assert.ok(maint.includes(`<code>hermes -p valun-local valun join --sandbox --direct-tools --server ${o} --handle YOUR-HANDLE`), '/maintainers: Hermes');
  }
});

test('R-2: canonical, og:url and og:image name this server on every page that has them; the banner sends people to /start and agents to skill.md, with no join of its own', () => {
  for (const run of locals()) {
    let n = 0;
    for (const p of run.pages) {
      const html = text(p.body);
      for (const m of html.matchAll(/<link rel="canonical" href="([^"]*)">|<meta property="og:(?:url|image)" content="([^"]*)">/g)) {
        n++;
        assert.ok((m[1] ?? m[2]).startsWith(`${run.origin}/`), `${named(p)}: ${m[0]}`);
      }
    }
    assert.ok(n >= 25, `${n} tags at ${run.origin}`);
    const banner = localBanner(run.origin);
    assert.ok(banner.includes('<a href="/start">its Start page</a>') && banner.includes('<a href="/skill.md">this server\'s skill.md</a>'), banner);
    assert.ok(banner.includes(`<code>--server ${run.origin}</code>`) && banner.includes('<code>--profile local</code>'), banner);
    assert.doesNotMatch(banner, /join --sandbox|config server/, 'no join of its own (SRV-14), never config server');
    assert.ok(banner.includes('not the public network at <a href="https://valun.tech">https://valun.tech</a>'), 'its one link to the public network says it is not this');
  }
});

test('R-2: what needs the chain, or the public network\'s house agents, is marked as not on this server, with this server\'s own facts; nothing reads the chain', () => {
  const r = runs.local, page = route => text(pageOf(r, route).body), notes = h => (h.match(/<p class="valun-local-note">/g) ?? []).length;
  const home = page('/home'), trust = page('/trust'), net = page('/network'), start = page('/start'), maint = page('/maintainers');
  assert.equal(notes(home), 4, '/home: the house agents, the audit, who runs this server, Ergo testnet');
  assert.ok(home.includes('<h3>Can Cy redeem Ana\'s IOU?</h3>\n<p>Not on this local server: it has no chain, so there are no reserves and nothing is redeemed.'));
  assert.ok(home.includes('Real run on the public network, Nov 16, 2026: not on this server'));
  assert.ok(home.includes('at most 5 PC per deal and 40 PC owed in all, 10 open offers, for 7 days'), 'this server\'s limits, in PC');
  assert.equal((home.match(/up to 40 PC per issuer/g) ?? []).length, 2);
  assert.doesNotMatch(home, /0\.04 tERG per issuer|First thing to try:<\/span> hire house-scribe/);
  // /trust: its own trust model first, each part that needs the chain marked, and no live read of the chain (trust.js
  // reads it only where the page has #now).
  assert.equal(notes(trust), 7, '/trust: its own model first, the life of an IOU, the checks, and the four parts that need the chain');
  for (const id of ['chain', 'netting', 'backing', 'redemption']) {
    const at = trust.slice(trust.indexOf(`<h2 id="${id}">`));
    assert.match(at.slice(0, at.indexOf('</section>')), /<p class="valun-local-note">/, `#${id} is marked`);
  }
  assert.doesNotMatch(trust, /\sid="now"|valun audit --explorer|curl -fsS https:/);
  assert.ok(trust.includes('No chain on this local server'));
  assert.ok(net.includes('This local server has no chain: there are no reserves, and nothing is redeemed.'));
  assert.doesNotMatch(net, /redeemed for tERG|run <code>valun audit<\/code>/);
  assert.doesNotMatch(start, /anchoring-now|\/pilot\/v1\/chain'|tERG|nanoERG|Ergo testnet/, 'the local /start reads no chain and names no testnet unit');
  assert.ok(part(start, 'audit').includes('404 no_chain'), '/start#audit says why there is no audit here');
  assert.ok(maint.includes('The public network\'s house agents don\'t run on a local server'));
  // No page names the explorer or the faucet at all, and none names valun.tech but in the banner's one sentence (and
  // what a participant wrote, on its own page).
  for (const p of r.pages) {
    const html = text(p.body).replace(localBanner(r.origin), '');
    assert.doesNotMatch(html, /ergoplatform|ergofaucet/, named(p));
    if (p.route !== '/agent/quote-bot') assert.doesNotMatch(html, /valun\.tech|fly\.dev/, named(p));
  }
});

// The page as start.js finds it (as test/start-page.test.mjs runs the public network's): the body read into
// test/network-dom.mjs's elements, the script in a context of its own, and every fetch recorded.
function runStart(html, hash = '') {
  const page = readBody(html), fetched = [], listeners = {};
  for (const d of page.querySelectorAll('details')) if (d.hasAttribute('open')) d.open = true;
  for (const e of page.all('*')) e.scrollIntoView = () => {};
  const document = {body: page, activeElement: null, getElementById: id => page.all('*').find(e => e.id === id) ?? null, createElement: t => new Element(t),
    querySelectorAll: s => page.querySelectorAll(s), querySelector: s => page.querySelector(s)};
  const window = {location: {hash}, innerHeight: 844, history: {replaceState: () => {}}, addEventListener: (t, f) => { (listeners[t] ??= []).push(f); }, matchMedia: () => ({matches: false})};
  vm.runInContext(pub('start.js').replace(/^export /gm, ''), vm.createContext({document, window, setTimeout: () => 0, navigator: {clipboard: {writeText: async () => {}}},
    fetch: async u => { fetched.push(u); return {ok: false, text: async () => ''}; }}), {filename: 'public/start.js'});
  return {document, fetched, shown: () => ['agent', 'tour', 'inspect', 'build'].filter(id => !document.getElementById(id).hidden)};
}

test('R-2: the local /start, this server\'s own: its paths, every anchor the server\'s pages link to, and start.js makes its chooser tabs without reading the chain', () => {
  const start = text(pageOf(runs.local, '/start').body);
  assert.equal(start, withBanner(pub('start-local.html').replaceAll('{origin}', ORIGIN), localBanner(ORIGIN)));
  assert.equal(text(pageOf(runs.local, '/start/').body), start);
  const ids = [...start.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const m of start.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `#${m[1]} links to nothing`);
  // Every /start#anchor a local page links to (the landing, the console, the agent pages and loop cards, the maintainers
  // page, the console's script) is on it.
  const linked = new Set();
  for (const p of runs.local.pages) for (const m of text(p.body).matchAll(/href="(?:http:\/\/127\.0\.0\.1:8080)?\/start#([^"]+)"/g)) linked.add(m[1]);
  for (const m of text(asset(runs.local, 'pilot.js').body).matchAll(/'\/start#([a-z-]+)'/g)) linked.add(m[1]);
  assert.ok(linked.size >= 8, [...linked].join(' '));
  for (const id of linked) assert.ok(ids.includes(id), `/start#${id} is linked and missing`);
  for (const id of ['agent', 'tour', 'inspect', 'build', 'approve', 'credentials', 'backing', 'known-issues', 'known-join', 'known-cut', 'known-hints',
    'known-reset', 'lost-answer', 'reference', 'install', 'limits', 'public', 'report', 'no-prompt', 'friends-loop', 'audit']) assert.ok(ids.includes(id), `#${id}`);
  // start.js: four tabs, the first shown; a link to a path, or into one, opens it; nothing is fetched (no live line).
  let s = runStart(start);
  assert.deepEqual(s.shown(), ['agent']);
  assert.equal(s.document.getElementById('paths').getAttribute('role'), 'tablist');
  for (const [hash, want] of [['#tour', 'tour'], ['#inspect', 'inspect'], ['#audit', 'inspect'], ['#build', 'build'], ['#no-prompt', 'agent'], ['#friends-loop', 'agent']]) {
    s = runStart(start, hash);
    assert.deepEqual(s.shown(), [want], hash);
  }
  assert.equal(runStart(start, '#no-prompt').document.getElementById('no-prompt').open, true);
  assert.equal(runStart(start, '#known-join').document.getElementById('known-join').open, true);
  assert.deepEqual(s.fetched, [], 'no read of the chain');
  // Its numbers are the server's (scripts/build-local-docs.mjs fills them in from its constants).
  for (const fact of ['at most 5 PC</td>', 'at most 40 PC</td>', '12 an hour from one address', 'text-stats (3 PC)', 'up to 40 PC per issuer', 'each up to 50 PC',
    'for 3 PC. Check the result']) assert.ok(start.includes(fact), fact);
});

test('R-2: the owner console names its commands in the profile local, with this server and the local token file, and so do the approval cards it shows', () => {
  const js = text(asset(runs.local, 'pilot.js').body);
  assert.ok(js.includes(`el('code', {}, \`valun --profile local attempts resolve \${dealId} '#n' --not-applied --server ${ORIGIN}\`)`));
  assert.equal(js.split(`el('code', {}, 'valun --profile local attempts list --server ${ORIGIN}')`).length - 1, 2);
  assert.ok(js.includes(`el('code', {}, \`valun --profile local card \${word} --server ${ORIGIN} --owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt"\`)`));
  assert.ok(text(asset(runs.other, 'pilot.js').body).includes(`--server ${OTHER}`), 'the origin it was given');
  // The script still parses as a module.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-local-pilot-js-')), f = path.join(dir, 'pilot.mjs');
  try {
    fs.writeFileSync(f, js);
    const r = spawnSync(process.execPath, ['--check', f], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // The approval cards' words (lib/pilot/core.mjs OWNER_ATTEMPTS), as a local server and as any other gives them.
  const attempts = env => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const {OWNER_ATTEMPTS: a} = await import('./lib/pilot/core.mjs'); console.log(JSON.stringify([a.resolve('vd_x'), a.list, a.hermes]));"],
      {cwd: root, env: {...clean(), PORT: '8080', ...env}, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const here = attempts({VALUN_ENVIRONMENT: 'local'});
  assert.deepEqual(here, [`valun --profile local attempts resolve vd_x '#n' --not-applied --server ${ORIGIN}`, `valun --profile local attempts list --server ${ORIGIN}`,
    'hermes -p valun-local valun attempts ...']);
  for (const c of here) assert.deepEqual(snippetProblems(c, ORIGIN), [], c);
  assert.ok(js.includes(here[0].replace('vd_x', '${dealId}')) && js.includes(here[1]), 'the console\'s script and its cards agree');
  assert.deepEqual(attempts({}), ["valun attempts resolve vd_x '#n' --not-applied", 'valun attempts list', 'hermes -p valun valun attempts ...']);
  assert.deepEqual(attempts({PILOT_NETWORK: 'valun-testnet-1'}), ["valun attempts resolve vd_x '#n' --not-applied", 'valun attempts list', 'hermes -p valun valun attempts ...']);
});

test('R-2: off a local server (the testnet, the pilot) every page and the console\'s script are their files, byte for byte, and /start is the public network\'s', () => {
  for (const run of [runs.pilot, runs.testnet]) {
    assert.equal(run.environment, null);
    for (const p of run.pages) assert.equal(text(p.body), text(p.page), named(p));
    assert.equal(text(pageOf(run, '/start').body), pub('start.html'));
    assert.equal(text(asset(run, 'pilot.js').body), pub('pilot.js'));
  }
});
